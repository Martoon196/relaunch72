import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import {
  handlePortal,
  type LegacyPortalDeps,
  type PortalDeps,
  type PostgresPortalDeps,
} from '../src/portal/router.js';
import {
  signTenant,
  PORTAL_COOKIE,
  PORTAL_LOGIN_CSRF_COOKIE,
  PORTAL_SETUP_COOKIE,
  PORTAL_SETUP_CLOCK_SKEW_MS,
  PORTAL_SETUP_TTL_SECONDS,
  InMemoryLoginThrottle,
  InMemorySetupThrottle,
  portalCsrfToken,
  portalLoginCsrfToken,
} from '../src/portal/session.js';
import type { DashboardData } from '../src/portal/data.js';
import type { BillingView } from '../src/portal/billing.js';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import type { PortalJourneyManagerService } from '../src/portal/journey-manager-service.js';
import type { JourneyManagerReadSnapshot } from '../src/conversion-pg/journey-manager.js';
import { PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS } from '../src/conversion-pg/property-predator-blueprints.js';
import { JOURNEY_MANAGER_CONFIRMATION } from '../src/portal/journey-manager-presenter.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';

function billingView(over: Partial<BillingView> = {}): BillingView {
  return {
    status: 'none', active: false, planKey: null, planName: null, currentPeriodEnd: null,
    customerId: null, email: 'owner@frayne.co',
    options: [{ key: 'platform_growth', name: 'Growth', description: 'more reach', priceLabel: '$299/mo' }],
    ...over,
  };
}

const SECRET = 'test-secret';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

const demoData: DashboardData = {
  tenant: { id: 't1', name: 'Frayne Electrical', createdAt: '2026-07-26T00:00:00Z' },
  contacts: [{ id: 'c-1', tenantId: 't1', name: 'Priya Nair', stage: 'contacted', createdAt: '2026-07-26T00:00:00Z' }],
  pipeline: { lead: 0, contacted: 1, qualified: 0, won: 0, lost: 0 },
  activity: [{ id: 'act-1', tenantId: 't1', at: '2026-08-03T09:00:00Z', kind: 'rail_run', channel: 'system', summary: 'Generated a content cluster' }],
  artifacts: {},
};

function deps(over: Partial<LegacyPortalDeps> = {}): LegacyPortalDeps {
  return {
    sessionSecret: SECRET,
    secure: false,
    now: () => 1_000_000,
    login: async (email, pw) => (email === 'owner@frayne.co' && pw === 'good' ? 't1' : null),
    dashboard: async (tid) => (tid === 't1' ? demoData : null),
    runTick: async () => 4,
    ...over,
    kind: 'legacy',
  };
}

const crm: PortalCrmService = {
  snapshot: async () => ({
    workspace: {
      id: WORKSPACE_ID, name: 'Frayne Electrical', timezone: 'Europe/London',
      snapshotAt: '2026-08-25T12:00:00.000Z', canWrite: true,
    },
    contacts: [], stages: [], opportunities: [], tasks: [], timeline: [],
  }),
  createLead: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  moveOpportunity: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  completeTask: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
};

function journeySnapshot(runtimeReady = false): JourneyManagerReadSnapshot {
  const [selfServe, agency] = PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS;
  const score = selfServe!.scoreModel;
  return Object.freeze({
    snapshotAt: '2026-08-25T12:00:00.000Z', canManage: true,
    foundationState: runtimeReady ? 'ready' : 'not_installed', runtimeReady,
    routes: Object.freeze([selfServe!, agency!].map((route) => Object.freeze({
      slug: route.slug as 'property-predator-self-serve' | 'property-predator-agency-laps',
      name: route.name, description: route.description, version: route.version,
      definitionHash: route.definitionHash,
      publication: runtimeReady ? 'published' as const : 'missing' as const,
      activeVersion: runtimeReady ? route.version : null,
      publishedAt: runtimeReady ? '2026-08-25T11:55:00.000Z' : null,
      runtimeReady, milestones: route.milestones, triggers: route.triggers,
    }))),
    scoreModel: Object.freeze({
      slug: score.slug, name: score.name, version: score.version,
      definitionHash: score.definitionHash,
      publication: runtimeReady ? 'published' : 'missing',
      activeVersion: runtimeReady ? score.version : null,
      publishedAt: runtimeReady ? '2026-08-25T11:55:00.000Z' : null,
      maxScore: 100, components: score.components, bands: score.bands, rules: score.rules,
    }),
    safety: Object.freeze({ definitionsOnly: true, sendsMessages: false, publishesSocialPosts: false, triggersProviders: false }),
  });
}

function postgresDeps(auth: PortalAuthService, over: Partial<PostgresPortalDeps> = {}): PostgresPortalDeps {
  return {
    sessionSecret: SECRET,
    secure: false,
    now: () => 1_000_000,
    auth,
    crm,
    ...over,
    kind: 'postgres',
  };
}

// Minimal req/res doubles for the node http handler.
interface RequestOptions {
  cookie?: string;
  body?: string;
  remoteAddress?: string;
  forwardedFor?: string;
}

function mkReq(method: string, url: string, opts: RequestOptions = {}) {
  const req = new EventEmitter() as EventEmitter & {
    method: string;
    url: string;
    headers: Record<string, string>;
    socket: { remoteAddress?: string };
  };
  req.method = method;
  req.url = url;
  req.headers = {};
  req.socket = { remoteAddress: opts.remoteAddress };
  if (opts.cookie) req.headers.cookie = opts.cookie;
  if (opts.forwardedFor) req.headers['x-forwarded-for'] = opts.forwardedFor;
  // A real IncomingMessage buffers until the handler subscribes. setImmediate
  // lets async PostgreSQL session resolution finish before this stream emits.
  setImmediate(() => { if (opts.body) req.emit('data', Buffer.from(opts.body)); req.emit('end'); });
  return req;
}
function mkRes() {
  const res = { statusCode: 0, headers: {} as Record<string, string>, body: '',
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; },
    writeHead(code: number, headers?: Record<string, string | string[]>) {
      this.statusCode = code;
      if (headers) for (const k in headers) {
        const value = headers[k]!;
        this.headers[k.toLowerCase()] = Array.isArray(value) ? value.join('\n') : value;
      }
      return this;
    },
    end(b?: string) { if (b) this.body = b; } };
  return res;
}
async function call(method: string, url: string, d: PortalDeps, opts: RequestOptions = {}) {
  const res = mkRes();
  await handlePortal(mkReq(method, url, opts) as never, res as never, d);
  return res;
}
const sessionFor = (tid: string) => signTenant(SECRET, tid, 1_000_000);
const cookieFor = (tid: string) => `${PORTAL_COOKIE}=${sessionFor(tid)}`;
const csrfBody = (tid = 't1', values: Record<string, string> = {}) => new URLSearchParams({
  _csrf: portalCsrfToken(SECRET, sessionFor(tid)),
  ...values,
}).toString();
const loginPost = (
  values: Record<string, string>,
  existingCookie?: string,
): { cookie: string; body: string } => {
  const token = portalLoginCsrfToken(SECRET);
  return {
    cookie: [existingCookie, `${PORTAL_LOGIN_CSRF_COOKIE}=${token}`].filter(Boolean).join('; '),
    body: new URLSearchParams({ _login_csrf: token, ...values }).toString(),
  };
};

const SETUP_TOKEN = Buffer.alloc(32, 23).toString('base64url');

function responseCookie(headers: Record<string, string>, name: string): string {
  const match = new RegExp(`(?:^|\\n)${name}=([^;]*)`).exec(headers['set-cookie'] ?? '');
  assert.ok(match?.[1], `response did not set ${name}`);
  return `${name}=${match[1]}`;
}

async function beginSetup(d: PortalDeps, token = SETUP_TOKEN, opts: RequestOptions = {}): Promise<{ cookie: string; csrf: string }> {
  const exchange = await call('GET', `/portal/setup?token=${encodeURIComponent(token)}`, d, opts);
  assert.equal(exchange.statusCode, 303);
  assert.equal(exchange.headers.location, '/portal/setup');
  assert.equal(exchange.headers['cache-control'], 'no-store');
  assert.equal(exchange.headers['referrer-policy'], 'no-referrer');
  assert.equal(exchange.body, '');
  const cookie = responseCookie(exchange.headers, PORTAL_SETUP_COOKIE);
  const page = await call('GET', '/portal/setup', d, { ...opts, cookie });
  assert.equal(page.statusCode, 200);
  assert.doesNotMatch(page.body, new RegExp(token));
  assert.doesNotMatch(page.body, /name="token"/);
  const csrf = /name="_setup_csrf" value="([A-Za-z0-9_-]{43})"/.exec(page.body)?.[1];
  assert.ok(csrf, 'setup page did not contain its cookie-bound CSRF value');
  return { cookie, csrf };
}

function setupPost(flow: { cookie: string; csrf: string }, values: Record<string, string>, opts: RequestOptions = {}): RequestOptions {
  return {
    ...opts,
    cookie: flow.cookie,
    body: new URLSearchParams({ _setup_csrf: flow.csrf, ...values }).toString(),
  };
}

test('GET /portal without a session redirects to login', async () => {
  const res = await call('GET', '/portal', deps());
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/portal/login');
});

test('POST /portal/login with good credentials sets a cookie and redirects', async () => {
  const res = await call('POST', '/portal/login', deps(), loginPost({ email: 'owner@frayne.co', password: 'good' }));
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/portal');
  assert.match(res.headers['set-cookie'] ?? '', new RegExp(PORTAL_COOKIE + '='));
});

test('POST /portal/login with bad credentials 401s and re-shows the form', async () => {
  const res = await call('POST', '/portal/login', deps(), loginPost({ email: 'owner@frayne.co', password: 'wrong' }));
  assert.equal(res.statusCode, 401);
  assert.match(res.body, /Wrong email or password/);
});

test('database auth issues opaque cookies and never accepts a legacy signed tenant token', async () => {
  const opaque = Buffer.alloc(32, 5).toString('base64url');
  const auth: PortalAuthService = {
    resolve: async (token) => token === opaque
      ? { sessionToken: token, userId: USER_ID, userEmail: 'owner@frayne.co', workspaceId: WORKSPACE_ID }
      : null,
    login: async (email, password) => email === 'owner@frayne.co' && password === 'good'
      ? { sessionToken: opaque, userId: USER_ID, userEmail: 'owner@frayne.co', workspaceId: WORKSPACE_ID }
      : null,
    revoke: async () => undefined,
  };
  const d = postgresDeps(auth);
  const login = await call('POST', '/portal/login', d, loginPost({ email: 'owner@frayne.co', password: 'good' }));
  assert.equal(login.statusCode, 302);
  assert.equal(login.headers.location, '/portal');
  assert.match(login.headers['set-cookie'] ?? '', new RegExp(`${PORTAL_COOKIE}=${opaque}(?:;|$)`));
  assert.doesNotMatch(login.headers['set-cookie'] ?? '', /\./, 'opaque database cookie is not a signed tenant payload');

  const legacy = await call('GET', '/portal', d, { cookie: cookieFor('t1') });
  assert.equal(legacy.statusCode, 302);
  assert.equal(legacy.headers.location, '/portal/login?reason=session-ended');
  const accepted = await call('GET', '/portal', d, { cookie: `${PORTAL_COOKIE}=${opaque}` });
  assert.equal(accepted.statusCode, 200);
  assert.match(accepted.body, /Turn attention into revenue/);
});

test('database sessions use canonical workspace identity without a legacy bridge', async () => {
  const opaque = Buffer.alloc(32, 11).toString('base64url');
  const auth: PortalAuthService = {
    resolve: async (token) => token === opaque ? {
      sessionToken: token,
      userId: USER_ID,
      userEmail: 'owner@frayne.co',
      workspaceId: WORKSPACE_ID,
    } : null,
    login: async () => null,
    revoke: async () => undefined,
  };
  const res = await call('GET', '/portal', postgresDeps(auth), {
    cookie: `${PORTAL_COOKIE}=${opaque}`,
  });

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Frayne Electrical/);
});

test('authenticated Journey Manager renders the visual topology and setup boundary', async () => {
  const opaque = Buffer.alloc(32, 17).toString('base64url');
  const auth: PortalAuthService = {
    resolve: async (token) => token === opaque ? {
      sessionToken: token, userId: USER_ID, userEmail: 'owner@frayne.co', workspaceId: WORKSPACE_ID,
    } : null,
    login: async () => null,
    revoke: async () => undefined,
  };
  const journeys: PortalJourneyManagerService = {
    snapshot: async () => journeySnapshot(false),
    installFoundation: async () => assert.fail('GET must never install definitions'),
  };

  const res = await call('GET', '/portal/journeys', postgresDeps(auth, {
    journeys,
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
  }), {
    cookie: `${PORTAL_COOKIE}=${opaque}`,
  });

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Visual journey map/);
  assert.match(res.body, /property-predator-self-serve/);
  assert.match(res.body, /property-predator-agency-laps/);
  assert.match(res.body, /name="_csrf"/);
  assert.match(res.body, /name="command_key" value="[0-9a-f-]{36}"/);
  assert.match(res.body, new RegExp(JOURNEY_MANAGER_CONFIRMATION));
  assert.match(res.body, /href="\/portal\/journeys" aria-current="page"/);
});

test('Journey Manager install requires CSRF and typed confirmation, then returns a signed status', async () => {
  const opaque = Buffer.alloc(32, 18).toString('base64url');
  const auth: PortalAuthService = {
    resolve: async (token) => token === opaque ? {
      sessionToken: token, userId: USER_ID, userEmail: 'owner@frayne.co', workspaceId: WORKSPACE_ID,
    } : null,
    login: async () => null,
    revoke: async () => undefined,
  };
  let installs = 0;
  const journeys: PortalJourneyManagerService = {
    snapshot: async () => journeySnapshot(false),
    installFoundation: async (identity) => {
      installs += 1;
      assert.equal(identity.requestId, '11111111-1111-4111-8111-111111111111');
      return { ok: true, disposition: 'applied', routes: { selfServe: 'applied', agencyLaps: 'applied' } };
    },
  };
  const d = postgresDeps(auth, { journeys });
  const cookie = `${PORTAL_COOKIE}=${opaque}`;
  const invalidCsrf = await call('POST', '/portal/journeys/foundation', d, {
    cookie,
    body: new URLSearchParams({
      command_key: '11111111-1111-4111-8111-111111111111',
      confirmation: JOURNEY_MANAGER_CONFIRMATION,
    }).toString(),
  });
  assert.equal(invalidCsrf.statusCode, 403);
  assert.equal(installs, 0);

  const invalidConfirmation = await call('POST', '/portal/journeys/foundation', d, {
    cookie,
    body: new URLSearchParams({
      _csrf: portalCsrfToken(SECRET, opaque),
      command_key: '11111111-1111-4111-8111-111111111111',
      confirmation: 'install whatever',
    }).toString(),
  });
  assert.equal(invalidConfirmation.statusCode, 303);
  assert.equal(installs, 0);

  const installed = await call('POST', '/portal/journeys/foundation', d, {
    cookie,
    body: new URLSearchParams({
      _csrf: portalCsrfToken(SECRET, opaque),
      command_key: '11111111-1111-4111-8111-111111111111',
      confirmation: JOURNEY_MANAGER_CONFIRMATION,
    }).toString(),
  });
  assert.equal(installed.statusCode, 303);
  assert.match(installed.headers.location ?? '', /^\/portal\/journeys\?notice=installed\./);
  assert.equal(installs, 1);

  const status = await call('GET', installed.headers.location!, d, { cookie });
  assert.equal(status.statusCode, 200);
  assert.match(status.body, /Journey foundation installed/);
  assert.doesNotMatch(status.body, /private database detail/);
});

test('database auth failure never downgrades to legacy login', async () => {
  const auth: PortalAuthService = {
    resolve: async () => null,
    login: async () => { throw new Error('database unavailable'); },
    revoke: async () => undefined,
  };
  const res = await call('POST', '/portal/login', postgresDeps(auth), loginPost({ email: 'owner@frayne.co', password: 'good' }));
  assert.equal(res.statusCode, 503);
  assert.match(res.body, /temporarily unavailable/);
});

test('a stale cookie cannot block a fresh database login or account setup page', async () => {
  const opaque = Buffer.alloc(32, 9).toString('base64url');
  let resolveCalls = 0;
  const auth: PortalAuthService = {
    resolve: async () => { resolveCalls += 1; throw new Error('identity store unavailable'); },
    login: async () => ({ sessionToken: opaque, userId: USER_ID, userEmail: 'owner@frayne.co', workspaceId: WORKSPACE_ID }),
    revoke: async () => undefined,
  };
  const d = postgresDeps(auth);
  const staleCookie = `${PORTAL_COOKIE}=${Buffer.alloc(32, 8).toString('base64url')}`;

  const login = await call('POST', '/portal/login', d, {
    ...loginPost({ email: 'owner@frayne.co', password: 'good' }, staleCookie),
  });
  assert.equal(login.statusCode, 302);
  assert.match(login.headers['set-cookie'] ?? '', new RegExp(`${PORTAL_COOKIE}=${opaque}(?:;|$)`));

  const exchange = await call('GET', `/portal/setup?token=${SETUP_TOKEN}`, d, { cookie: staleCookie });
  assert.equal(exchange.statusCode, 303, 'the sensitive query is cleaned even while setup is paused');
  const setupCookie = responseCookie(exchange.headers, PORTAL_SETUP_COOKIE);
  const setup = await call('GET', '/portal/setup', d, { cookie: `${staleCookie}; ${setupCookie}` });
  assert.equal(setup.statusCode, 503);
  assert.match(setup.body, /Setup is currently paused/);
  assert.doesNotMatch(setup.body, /name="password"/);
  assert.equal(resolveCalls, 0);
});

test('one-time setup chooses a password, signs in and rejects an already-used token', async () => {
  const seen: Array<{ token: string; password: string; now: number }> = [];
  let available = true;
  const d = deps({
    setupThrottle: new InMemorySetupThrottle(),
    completeSetup: async (token, password, now) => {
      seen.push({ token, password, now });
      if (!available || token !== SETUP_TOKEN) return null;
      available = false;
      return 't1';
    },
  });
  const flow = await beginSetup(d);

  const first = await call('POST', '/portal/setup', d, setupPost(flow, {
    password: 'a-secure-password', confirm: 'a-secure-password',
  }));
  assert.equal(first.statusCode, 303);
  assert.equal(first.headers.location, '/portal');
  assert.match(first.headers['set-cookie'] ?? '', new RegExp(PORTAL_COOKIE + '='));
  assert.match(first.headers['set-cookie'] ?? '', new RegExp(`${PORTAL_SETUP_COOKIE}=.*Max-Age=0`));
  assert.deepEqual(seen[0], { token: SETUP_TOKEN, password: 'a-secure-password', now: 1_000_000 });

  const reused = await call('POST', '/portal/setup', d, setupPost(flow, {
    password: 'a-secure-password', confirm: 'a-secure-password',
  }));
  assert.equal(reused.statusCode, 400);
  assert.match(reused.body, /invalid, expired or has already been used/i);
  assert.doesNotMatch(reused.body, new RegExp(SETUP_TOKEN));
});

test('database account setup issues its canonical session and enters the CRM', async () => {
  const opaque = Buffer.alloc(32, 12).toString('base64url');
  const seen: Array<{ token: string; password: string; now: number }> = [];
  const auth: PortalAuthService = {
    resolve: async () => null,
    login: async () => null,
    completeSetup: async (token, password, context) => {
      seen.push({ token, password, now: context.now });
      return token === SETUP_TOKEN
        ? { sessionToken: opaque, userId: USER_ID, userEmail: 'owner@frayne.co', workspaceId: WORKSPACE_ID }
        : null;
    },
    revoke: async () => undefined,
  };
  const d = postgresDeps(auth, { setupThrottle: new InMemorySetupThrottle() });

  const flow = await beginSetup(d);
  const completed = await call('POST', '/portal/setup', d, setupPost(flow, {
    password: 'a-secure-password', confirm: 'a-secure-password',
  }));

  assert.equal(completed.statusCode, 303);
  assert.equal(completed.headers.location, '/portal');
  assert.match(completed.headers['set-cookie'] ?? '', new RegExp(`${PORTAL_COOKIE}=${opaque}(?:;|$)`));
  assert.deepEqual(seen, [{ token: SETUP_TOKEN, password: 'a-secure-password', now: 1_000_000 }]);
});

test('setup query cleanup removes the capability from later HTML and binds POST to an encrypted HttpOnly cookie', async () => {
  let setupCalls = 0;
  const d = deps({
    secure: true,
    setupThrottle: new InMemorySetupThrottle(),
    completeSetup: async () => { setupCalls += 1; return null; },
  });
  const exchange = await call('GET', `/portal/setup?token=${SETUP_TOKEN}`, d);
  assert.equal(exchange.statusCode, 303);
  assert.match(exchange.headers['set-cookie'] ?? '', new RegExp(`^${PORTAL_SETUP_COOKIE}=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+;`));
  assert.doesNotMatch(exchange.headers['set-cookie'] ?? '', new RegExp(SETUP_TOKEN));
  assert.match(exchange.headers['set-cookie'] ?? '', /HttpOnly/);
  assert.match(exchange.headers['set-cookie'] ?? '', /SameSite=Lax/, 'email-origin top-level GETs must survive the clean 303');
  assert.match(exchange.headers['set-cookie'] ?? '', /Path=\/portal\/setup/);
  assert.match(exchange.headers['set-cookie'] ?? '', /Max-Age=600/);
  assert.match(exchange.headers['set-cookie'] ?? '', /Secure/);

  const issuedCookie = responseCookie(exchange.headers, PORTAL_SETUP_COOKIE);
  const encryptedParts = issuedCookie.slice(PORTAL_SETUP_COOKIE.length + 1).split('.');
  encryptedParts[1] = `${encryptedParts[1]![0] === 'A' ? 'B' : 'A'}${encryptedParts[1]!.slice(1)}`;
  const tampered = await call('GET', '/portal/setup', d, {
    cookie: `${PORTAL_SETUP_COOKIE}=${encryptedParts.join('.')}`,
  });
  assert.equal(tampered.statusCode, 400, 'AEAD rejects ciphertext tampering');
  assert.doesNotMatch(tampered.body, new RegExp(SETUP_TOKEN));

  const flow = await beginSetup(d);
  const withoutCsrf = await call('POST', '/portal/setup', d, {
    cookie: flow.cookie,
    body: new URLSearchParams({ password: 'a-secure-password', confirm: 'a-secure-password' }).toString(),
  });
  assert.equal(withoutCsrf.statusCode, 403);
  assert.equal(setupCalls, 0);
  assert.match(withoutCsrf.body, /invalid, expired or has already been used/i);
  assert.doesNotMatch(withoutCsrf.body, new RegExp(SETUP_TOKEN));
  assert.equal(withoutCsrf.headers['set-cookie'], undefined, 'a cross-site POST cannot clear the Strict setup cookie');
});

test('setup cookie lifetime is authenticated, skew-tolerant and enforced server-side', async () => {
  let now = 1_000_000;
  const issuedAt = now;
  const d = deps({
    now: () => now,
    completeSetup: async () => null,
  });
  const exchange = await call('GET', `/portal/setup?token=${SETUP_TOKEN}`, d);
  const cookie = responseCookie(exchange.headers, PORTAL_SETUP_COOKIE);
  now = issuedAt - PORTAL_SETUP_CLOCK_SKEW_MS;
  assert.equal((await call('GET', '/portal/setup', d, { cookie })).statusCode, 200, 'one minute of issuer clock lead is tolerated');
  now = issuedAt - PORTAL_SETUP_CLOCK_SKEW_MS - 1;
  assert.equal((await call('GET', '/portal/setup', d, { cookie })).statusCode, 400, 'larger future issuance is rejected');
  now = issuedAt + PORTAL_SETUP_TTL_SECONDS * 1000 + 1;
  const expired = await call('GET', '/portal/setup', d, { cookie });
  assert.equal(expired.statusCode, 400);
  assert.match(expired.body, /invalid, expired or has already been used/i);
  assert.doesNotMatch(expired.body, new RegExp(SETUP_TOKEN));
  assert.match(expired.headers['set-cookie'] ?? '', /Max-Age=0/);
});

test('malformed and forged setup capabilities fail generically without entering the setup service', async () => {
  let setupCalls = 0;
  const d = deps({ completeSetup: async () => { setupCalls += 1; return null; } });
  const malformed = '<script>raw-capability</script>';
  const badLink = await call('GET', `/portal/setup?token=${encodeURIComponent(malformed)}`, d);
  assert.equal(badLink.statusCode, 400);
  assert.match(badLink.body, /invalid, expired or has already been used/i);
  assert.doesNotMatch(badLink.body, /raw-capability/);

  const forged = await call('GET', '/portal/setup', d, {
    cookie: `${PORTAL_SETUP_COOKIE}=${SETUP_TOKEN}.${Buffer.alloc(32, 9).toString('base64url')}`,
  });
  assert.equal(forged.statusCode, 400);
  assert.match(forged.body, /invalid, expired or has already been used/i);
  assert.doesNotMatch(forged.body, new RegExp(SETUP_TOKEN));
  assert.equal(setupCalls, 0);
});

test('setup throttle retains only direct-source and token hashes, ignoring spoofable proxy headers', async () => {
  const reserved: string[] = [];
  const failed: string[] = [];
  const throttle = {
    reserve(key: string) { reserved.push(key); return { allowed: true, retryAfterSeconds: 0 }; },
    release() {},
    failure(key: string) { failed.push(key); },
    success() {},
  };
  const d = deps({
    setupThrottle: throttle,
    trustedClientAddress: (req) => req.socket.remoteAddress,
    completeSetup: async () => null,
  });
  const flow = await beginSetup(d, SETUP_TOKEN, { remoteAddress: '10.0.0.7', forwardedFor: '203.0.113.99' });
  const response = await call('POST', '/portal/setup', d, setupPost(flow, {
    password: 'a-secure-password', confirm: 'a-secure-password',
  }, { remoteAddress: '10.0.0.7', forwardedFor: '198.51.100.4' }));
  assert.equal(response.statusCode, 400);
  const directSourceHash = createHash('sha256')
    .update('relaunch72/setup-source/v1\u0000')
    .update('10.0.0.7')
    .digest('hex');
  const tokenHash = createHash('sha256').update(SETUP_TOKEN).digest('hex');
  assert.deepEqual(reserved, [`setup-source:${directSourceHash}`, `setup-token:${tokenHash}`]);
  assert.deepEqual(failed, reserved);
  assert.equal(reserved.some((key) => key.includes(SETUP_TOKEN) || key.includes('203.0.113.99') || key.includes('198.51.100.4')), false);
});

test('setup throttles both token reuse across sources and source spraying across random tokens', async () => {
  const tokenA = Buffer.alloc(32, 31).toString('base64url');
  const tokenB = Buffer.alloc(32, 32).toString('base64url');
  const tokenC = Buffer.alloc(32, 33).toString('base64url');
  let tokenAttempts = 0;
  const tokenDeps = deps({
    setupThrottle: new InMemorySetupThrottle(1, 60_000, 60_000),
    completeSetup: async () => { tokenAttempts += 1; return null; },
  });
  const firstTokenFlow = await beginSetup(tokenDeps, tokenA, { remoteAddress: '10.0.0.1' });
  assert.equal((await call('POST', '/portal/setup', tokenDeps, setupPost(firstTokenFlow, {
    password: 'a-secure-password', confirm: 'a-secure-password',
  }, { remoteAddress: '10.0.0.1' }))).statusCode, 400);
  const secondTokenFlow = await beginSetup(tokenDeps, tokenA, { remoteAddress: '10.0.0.2' });
  const tokenBlocked = await call('POST', '/portal/setup', tokenDeps, setupPost(secondTokenFlow, {
    password: 'a-secure-password', confirm: 'a-secure-password',
  }, { remoteAddress: '10.0.0.2' }));
  assert.equal(tokenBlocked.statusCode, 429);
  assert.match(tokenBlocked.body, /invalid, expired or has already been used/i);
  assert.equal(tokenAttempts, 1);

  let sourceAttempts = 0;
  const sourceDeps = deps({
    setupThrottle: new InMemorySetupThrottle(1, 60_000, 60_000),
    trustedClientAddress: (req) => req.socket.remoteAddress,
    completeSetup: async () => { sourceAttempts += 1; return null; },
  });
  const firstSourceFlow = await beginSetup(sourceDeps, tokenB, { remoteAddress: '10.0.0.3' });
  assert.equal((await call('POST', '/portal/setup', sourceDeps, setupPost(firstSourceFlow, {
    password: 'a-secure-password', confirm: 'a-secure-password',
  }, { remoteAddress: '10.0.0.3' }))).statusCode, 400);
  const secondSourceFlow = await beginSetup(sourceDeps, tokenC, { remoteAddress: '10.0.0.3' });
  const sourceBlocked = await call('POST', '/portal/setup', sourceDeps, setupPost(secondSourceFlow, {
    password: 'a-secure-password', confirm: 'a-secure-password',
  }, { remoteAddress: '10.0.0.3' }));
  assert.equal(sourceBlocked.statusCode, 429);
  assert.equal(sourceAttempts, 1);
});

test('setup throttle bounds identifiers without letting random idle fingerprints lock every link', () => {
  const throttle = new InMemorySetupThrottle(1, 60_000, 60_000, 2);
  assert.equal(throttle.reserve('one', 1_000).allowed, true);
  throttle.failure('one', 1_000);
  assert.equal(throttle.reserve('two', 1_000).allowed, true);
  throttle.failure('two', 1_000);
  assert.equal(throttle.reserve('three', 1_000).allowed, true, 'oldest idle fingerprint is evicted');
  assert.equal(throttle.check('one', 1_000).allowed, true);
  assert.equal(throttle.check('two', 1_000).allowed, false);

  const pending = new InMemorySetupThrottle(3, 60_000, 60_000, 2);
  assert.equal(pending.reserve('one', 1_000).allowed, true);
  assert.equal(pending.reserve('two', 1_000).allowed, true);
  assert.equal(pending.reserve('three', 1_000).allowed, false, 'in-flight entries are never evicted');
});

test('default proxy peers cannot source-block unrelated setup tokens without an explicit resolver', async () => {
  const tokenA = Buffer.alloc(32, 41).toString('base64url');
  const tokenB = Buffer.alloc(32, 42).toString('base64url');
  let attempts = 0;
  const d = deps({
    setupThrottle: new InMemorySetupThrottle(1, 60_000, 60_000),
    completeSetup: async () => { attempts += 1; return null; },
  });
  for (const token of [tokenA, tokenB]) {
    const flow = await beginSetup(d, token, { remoteAddress: '10.0.0.99' });
    const response = await call('POST', '/portal/setup', d, setupPost(flow, {
      password: 'a-secure-password', confirm: 'a-secure-password',
    }, { remoteAddress: '10.0.0.99', forwardedFor: '203.0.113.7' }));
    assert.equal(response.statusCode, 400);
  }
  assert.equal(attempts, 2, 'the shared socket peer was deliberately omitted from throttle keys');
});

test('setup releases throttle reservations on service errors so capacity is never stranded', async () => {
  let attempts = 0;
  const d = deps({
    setupThrottle: new InMemorySetupThrottle(1, 60_000, 60_000),
    completeSetup: async () => { attempts += 1; throw new Error('identity store unavailable'); },
  });
  const flow = await beginSetup(d);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await call('POST', '/portal/setup', d, setupPost(flow, {
      password: 'a-secure-password', confirm: 'a-secure-password',
    }));
    assert.equal(response.statusCode, 503);
    assert.doesNotMatch(response.body, new RegExp(SETUP_TOKEN));
  }
  assert.equal(attempts, 2);
});

test('setup bounds concurrent expensive attempts before the setup service starts', async () => {
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => { openGate = resolve; });
  let attempts = 0;
  const d = deps({
    setupThrottle: new InMemorySetupThrottle(2, 60_000, 60_000),
    completeSetup: async () => { attempts += 1; await gate; return null; },
  });
  const flow = await beginSetup(d);
  const body = { password: 'a-secure-password', confirm: 'a-secure-password' };
  const first = call('POST', '/portal/setup', d, setupPost(flow, body));
  const second = call('POST', '/portal/setup', d, setupPost(flow, body));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const third = await call('POST', '/portal/setup', d, setupPost(flow, body));
  assert.equal(third.statusCode, 429);
  assert.equal(attempts, 2);
  openGate();
  assert.deepEqual((await Promise.all([first, second])).map((response) => response.statusCode), [400, 400]);
});

test('login throttles repeated failures without revealing whether an account exists', async () => {
  const d = deps({ loginThrottle: new InMemoryLoginThrottle(2, 60_000, 60_000) });
  assert.equal((await call('POST', '/portal/login', d, loginPost({ email: 'owner@frayne.co', password: 'bad' }))).statusCode, 401);
  assert.equal((await call('POST', '/portal/login', d, loginPost({ email: 'owner@frayne.co', password: 'bad' }))).statusCode, 401);
  const blocked = await call('POST', '/portal/login', d, loginPost({ email: 'owner@frayne.co', password: 'good' }));
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['retry-after'], '60');
  assert.match(blocked.body, /Too many login attempts/i);
});

test('login source blocking is enabled only by an explicit trusted-address policy', async () => {
  let defaultAttempts = 0;
  const defaultDeps = deps({
    loginThrottle: new InMemoryLoginThrottle(1, 60_000, 60_000),
    login: async () => { defaultAttempts += 1; return null; },
  });
  for (const email of ['first@example.test', 'second@example.test']) {
    const response = await call('POST', '/portal/login', defaultDeps, {
      ...loginPost({ email, password: 'wrong-password' }),
      remoteAddress: '10.0.0.99',
      forwardedFor: '203.0.113.8',
    });
    assert.equal(response.statusCode, 401);
  }
  assert.equal(defaultAttempts, 2, 'a shared proxy peer was omitted without a trusted resolver');

  let trustedAttempts = 0;
  const trustedDeps = deps({
    loginThrottle: new InMemoryLoginThrottle(1, 60_000, 60_000),
    trustedClientAddress: (req) => req.socket.remoteAddress,
    login: async () => { trustedAttempts += 1; return null; },
  });
  const first = await call('POST', '/portal/login', trustedDeps, {
    ...loginPost({ email: 'first@example.test', password: 'wrong-password' }),
    remoteAddress: '10.0.0.5',
    forwardedFor: '203.0.113.10',
  });
  const second = await call('POST', '/portal/login', trustedDeps, {
    ...loginPost({ email: 'second@example.test', password: 'wrong-password' }),
    remoteAddress: '10.0.0.5',
    forwardedFor: '198.51.100.11',
  });
  assert.equal(first.statusCode, 401);
  assert.equal(second.statusCode, 429);
  assert.equal(trustedAttempts, 1);
});

test('login rejects a cross-site form post without its signed pre-authentication token', async () => {
  const res = await call('POST', '/portal/login', deps(), {
    body: 'email=owner%40frayne.co&password=good',
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.body, /Refresh the sign-in page/);
  assert.match(res.headers['set-cookie'] ?? '', new RegExp(`${PORTAL_LOGIN_CSRF_COOKIE}=`));
});

test('database login does not preflight a JSON dashboard before issuing its session', async () => {
  const opaque = Buffer.alloc(32, 6).toString('base64url');
  const revoked: string[] = [];
  const auth: PortalAuthService = {
    resolve: async () => null,
    login: async () => ({ sessionToken: opaque, userId: USER_ID, userEmail: 'owner@frayne.co', workspaceId: WORKSPACE_ID }),
    revoke: async (token) => { revoked.push(token); },
  };
  const res = await call('POST', '/portal/login', postgresDeps(auth), loginPost({ email: 'owner@frayne.co', password: 'good' }));
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/portal');
  assert.deepEqual(revoked, []);
  assert.match(res.headers['set-cookie'] ?? '', new RegExp(`${PORTAL_COOKIE}=${opaque}`));
});

test('login throttle enforces a hard identifier cap under unique-key spraying', () => {
  const throttle = new InMemoryLoginThrottle(1, 60_000, 60_000, 2);
  throttle.failure('one', 1_000);
  throttle.failure('two', 1_000);
  throttle.failure('three', 1_000); // evicts insertion-order oldest to stay bounded
  assert.equal(throttle.check('one', 1_000).allowed, true);
  assert.equal(throttle.check('two', 1_000).allowed, false);
  assert.equal(throttle.check('three', 1_000).allowed, false);
});

test('login throttle bounds concurrent password checks before slow verification starts', async () => {
  let releaseVerification!: () => void;
  const verificationGate = new Promise<void>((resolve) => { releaseVerification = resolve; });
  let verificationCalls = 0;
  const d = deps({
    loginThrottle: new InMemoryLoginThrottle(2, 60_000, 60_000),
    login: async () => {
      verificationCalls += 1;
      await verificationGate;
      return null;
    },
  });
  const first = call('POST', '/portal/login', d, loginPost({ email: 'owner@frayne.co', password: 'bad-1' }));
  const second = call('POST', '/portal/login', d, loginPost({ email: 'owner@frayne.co', password: 'bad-2' }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const third = await call('POST', '/portal/login', d, loginPost({ email: 'owner@frayne.co', password: 'bad-3' }));
  assert.equal(third.statusCode, 429);
  assert.equal(verificationCalls, 2);
  releaseVerification();
  const completed = await Promise.all([first, second]);
  assert.deepEqual(completed.map((result) => result.statusCode), [401, 401]);
});

test('GET /portal with a valid session renders that tenant’s dashboard', async () => {
  const res = await call('GET', '/portal', deps(), { cookie: cookieFor('t1') });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(res.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/);
  assert.match(res.body, /Frayne Electrical/);
  assert.match(res.body, /Priya Nair/);
});

test('POST /portal/run runs the manager and redirects back', async () => {
  let ran = 0;
  const res = await call('POST', '/portal/run', deps({ runTick: async () => { ran++; return 4; } }), { cookie: cookieFor('t1'), body: csrfBody() });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/portal');
  assert.equal(ran, 1);
});

test('a forged/expired cookie is treated as logged out', async () => {
  const res = await call('GET', '/portal', deps(), { cookie: `${PORTAL_COOKIE}=not.a.valid.token` });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/portal/login?reason=session-ended');
});

// ─── billing screen ──────────────────────────────────────────────────────────
test('the dashboard shows a billing card when a billing resolver is wired', async () => {
  const res = await call('GET', '/portal', deps({ billing: async () => billingView({ status: 'active', active: true, planName: 'Growth' }) }), { cookie: cookieFor('t1') });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Your plan/);
  assert.match(res.body, /Growth/);
});

test('GET /portal/billing renders the plans screen', async () => {
  const res = await call('GET', '/portal/billing', deps({ billing: async () => billingView() }), { cookie: cookieFor('t1') });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Planned tiers/);
  assert.match(res.body, /\$299\/mo/);
  assert.doesNotMatch(res.body, /action="\/portal\/subscribe"/);
  assert.match(res.body, /Checkout paused/);
});

test('GET /portal/billing 404s when billing is not enabled', async () => {
  const res = await call('GET', '/portal/billing', deps(), { cookie: cookieFor('t1') });
  assert.equal(res.statusCode, 404);
  assert.match(res.body, /Billing not enabled/);
});

test('POST /portal/subscribe starts checkout and redirects to the Stripe URL', async () => {
  const seen: Array<{ plan: string; email: string | null }> = [];
  const d = deps({
    billing: async () => billingView({ email: 'owner@frayne.co' }),
    subscribeUrl: async (plan, email) => { seen.push({ plan, email }); return 'https://pay.stripe.test/sub_1'; },
  });
  const res = await call('POST', '/portal/subscribe', d, { cookie: cookieFor('t1'), body: csrfBody('t1', { plan: 'platform_growth' }) });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, 'https://pay.stripe.test/sub_1');
  assert.deepEqual(seen, [{ plan: 'platform_growth', email: 'owner@frayne.co' }]);
});

test('POST /portal/subscribe redirects back with an error when checkout throws', async () => {
  const d = deps({ billing: async () => billingView(), subscribeUrl: async () => { throw new Error('bad plan'); } });
  const res = await call('POST', '/portal/subscribe', d, { cookie: cookieFor('t1'), body: csrfBody('t1', { plan: 'nope' }) });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/portal/billing?error=1');
});

test('every authenticated effect, including logout, rejects a missing CSRF token', async () => {
  let ran = 0;
  const d = deps({ runTick: async () => { ran += 1; return 1; } });
  const run = await call('POST', '/portal/run', d, { cookie: cookieFor('t1') });
  assert.equal(run.statusCode, 403);
  assert.equal(ran, 0);
  assert.match(run.body, /Skip to main content/);

  const logout = await call('POST', '/portal/logout', d, { cookie: cookieFor('t1') });
  assert.equal(logout.statusCode, 403);
  assert.equal(logout.headers['set-cookie'], undefined);
});

test('database logout revokes the exact opaque session before clearing its cookie', async () => {
  const opaque = Buffer.alloc(32, 6).toString('base64url');
  const revoked: string[] = [];
  const auth: PortalAuthService = {
    resolve: async (token) => token === opaque ? {
      sessionToken: token,
      userId: USER_ID,
      userEmail: 'owner@frayne.co',
      workspaceId: WORKSPACE_ID,
    } : null,
    login: async () => null,
    revoke: async (token) => { revoked.push(token); },
  };
  const body = new URLSearchParams({ _csrf: portalCsrfToken(SECRET, opaque) }).toString();
  const res = await call('POST', '/portal/logout', postgresDeps(auth), {
    cookie: `${PORTAL_COOKIE}=${opaque}`,
    body,
  });
  assert.equal(res.statusCode, 302);
  assert.deepEqual(revoked, [opaque]);
  assert.match(res.headers['set-cookie'] ?? '', /Max-Age=0/);
});

test('database logout reports revocation failure and keeps the browser session', async () => {
  const opaque = Buffer.alloc(32, 7).toString('base64url');
  let resolveCalls = 0;
  let revokeCalls = 0;
  const auth: PortalAuthService = {
    resolve: async () => { resolveCalls += 1; throw new Error('identity store unavailable'); },
    login: async () => null,
    revoke: async () => { revokeCalls += 1; throw new Error('identity store unavailable'); },
  };
  const body = new URLSearchParams({ _csrf: portalCsrfToken(SECRET, opaque) }).toString();
  const res = await call('POST', '/portal/logout', postgresDeps(auth), {
    cookie: `${PORTAL_COOKIE}=${opaque}`,
    body,
  });

  assert.equal(res.statusCode, 503);
  assert.equal(res.headers.location, undefined);
  assert.equal(resolveCalls, 0);
  assert.equal(revokeCalls, 1);
  assert.equal(res.headers['set-cookie'], undefined);
  assert.match(res.body, /still signed in/i);
});

test('POST /portal/subscribe never creates a second subscription for an active customer', async () => {
  let checkouts = 0;
  const d = deps({
    billing: async () => billingView({ status: 'active', active: true, customerId: 'cus_existing' }),
    subscribeUrl: async () => { checkouts++; return 'https://pay.stripe.test/should-not-happen'; },
  });
  const res = await call('POST', '/portal/subscribe', d, { cookie: cookieFor('t1'), body: csrfBody('t1', { plan: 'platform_pro' }) });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/portal/billing?active=1');
  assert.equal(checkouts, 0);
});

test('POST /portal/manage opens the Stripe billing portal for the customer', async () => {
  const seen: string[] = [];
  const d = deps({
    billing: async () => billingView({ status: 'active', active: true, customerId: 'cus_9' }),
    manageUrl: async (cid) => { seen.push(cid); return 'https://billing.stripe.test/cus_9'; },
  });
  const res = await call('POST', '/portal/manage', d, { cookie: cookieFor('t1'), body: csrfBody() });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, 'https://billing.stripe.test/cus_9');
  assert.deepEqual(seen, ['cus_9']);
});

test('POST /portal/run is soft by default — runs even without an active subscription', async () => {
  let ran = 0;
  const d = deps({ runTick: async () => { ran++; return 4; }, billing: async () => billingView({ status: 'none', active: false }) });
  const res = await call('POST', '/portal/run', d, { cookie: cookieFor('t1'), body: csrfBody() });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/portal');
  assert.equal(ran, 1);
});

test('POST /portal/run is gated to /portal/billing when enforcement is on and the sub is inactive', async () => {
  let ran = 0;
  const d = deps({ runTick: async () => { ran++; return 4; }, billingEnforced: true, billing: async () => billingView({ status: 'past_due', active: false }) });
  const res = await call('POST', '/portal/run', d, { cookie: cookieFor('t1'), body: csrfBody() });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/portal/billing?need=1');
  assert.equal(ran, 0, 'the run must not fire without an active subscription');
});

test('POST /portal/run under enforcement runs for an active subscriber', async () => {
  let ran = 0;
  const d = deps({ runTick: async () => { ran++; return 4; }, billingEnforced: true, billing: async () => billingView({ status: 'active', active: true }) });
  const res = await call('POST', '/portal/run', d, { cookie: cookieFor('t1'), body: csrfBody() });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/portal');
  assert.equal(ran, 1);
});
