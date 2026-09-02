import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE, portalCsrfToken } from '../src/portal/session.js';
import type { PortalZernioSocialConnectionService } from '../src/portal/zernio-social-connection-service.js';
import { zernioSocialNoticeToken } from '../src/portal/zernio-social-actions.js';

const SECRET = 'zernio-social-router-secret';
const SESSION = Buffer.alloc(32, 71).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';
const INTENT = '44444444-4444-4444-8444-444444444444';
const PROFILE = '6a95a6ae41c1829b085cbe28';

const auth: PortalAuthService = {
  resolve: async (token) => token === SESSION ? {
    sessionToken: token, userId: USER, userEmail: 'founder@example.test', workspaceId: WORKSPACE,
  } : null,
  login: async () => null,
  revoke: async () => undefined,
};

const crm: PortalCrmService = {
  snapshot: async () => ({
    workspace: { id: WORKSPACE, name: 'PropertyPredator Growth HQ', timezone: 'Europe/London', snapshotAt: '2026-08-31T12:00:00.000Z', canWrite: true },
    contacts: [], stages: [], opportunities: [], tasks: [], timeline: [],
  }),
  workspaceShell: async () => ({
    workspace: { id: WORKSPACE, name: 'PropertyPredator Growth HQ', timezone: 'Europe/London', snapshotAt: '2026-08-31T12:00:00.000Z', canWrite: true },
  }),
  createLead: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  moveOpportunity: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  completeTask: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
};

function service(overrides: Partial<PortalZernioSocialConnectionService> = {}) {
  const base: PortalZernioSocialConnectionService = {
    providerConnectionId: CONNECTION,
    providerProfileId: PROFILE,
    snapshot: async () => ({ ok: true, accounts: [] }),
    begin: async (_identity, input) => ({
      ok: true,
      intentId: input.intentId,
      authUrl: 'https://zernio.com/connect/continue',
      providerEffects: 'oauth_not_started',
    }),
    callback: async () => ({
      ok: true,
      accountId: '55555555-5555-4555-8555-555555555555',
      disposition: 'recorded',
      providerEffects: 'account_already_connected_by_user',
    }),
    recordWebhook: async () => ({ ok: true, disposition: 'recorded', providerEffects: 'none' }),
  };
  return { ...base, ...overrides } as PortalZernioSocialConnectionService;
}

function deps(zernioSocial = service()): PostgresPortalDeps {
  return {
    kind: 'postgres', sessionSecret: SECRET, secure: false,
    requestId: () => 'zernio-router-request',
    now: () => Date.parse('2026-08-31T12:00:00.000Z'),
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    auth, crm, zernioSocial,
  };
}

function request(url: string, method = 'GET', body?: string) {
  const req = new EventEmitter() as EventEmitter & {
    method: string; url: string; headers: Record<string, string>;
  };
  req.method = method;
  req.url = url;
  req.headers = {
    cookie: COOKIE,
    ...(body === undefined ? {} : {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(body)),
    }),
  };
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

function response() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(code: number, headers?: Record<string, string | string[]>) {
      this.statusCode = code;
      for (const [key, value] of Object.entries(headers ?? {})) {
        this.headers[key.toLowerCase()] = Array.isArray(value) ? value.join('\n') : value;
      }
      return this;
    },
    end(body?: string) { if (body) this.body = body; },
  };
}

async function call(url: string, dependencies: PostgresPortalDeps, method = 'GET', body?: string) {
  const res = response();
  await handlePortal(request(url, method, body) as never, res as never, dependencies);
  return res;
}

test('founder social screen shows private-provider connection controls and no publishing form', async () => {
  const result = await call('/portal/social/accounts', deps());
  assert.equal(result.statusCode, 200);
  assert.match(result.body, /data-provider-effects="connection-only"/);
  assert.match(result.body, /Connect Facebook/);
  assert.match(result.body, /Connect or add another/);
  assert.match(result.body, /Facebook personal profiles are not available through the official API/);
  assert.match(result.body, /Connect Instagram/);
  assert.match(result.body, /Connect Linkedin/);
  assert.match(result.body, /Connect every account you own/);
  assert.match(result.body, /add another Facebook Page, Instagram professional account or LinkedIn organisation/);
  assert.doesNotMatch(result.body, /target="_blank"/);
  assert.match(result.body, /No post can be drafted, scheduled, queued or published from this screen/);
  assert.doesNotMatch(result.body, /action="[^"]*(?:publish|schedule|queue)/i);
  assert.doesNotMatch(result.body, /zernio/i);
});

test('a signed lifecycle receipt reconciles an incomplete Instagram browser return', async () => {
  const zernio = service({
    snapshot: async () => ({
      ok: true,
      accounts: [{
        accountId: '55555555-5555-4555-8555-555555555555',
        network: 'instagram',
        username: null,
        displayName: null,
        status: 'active',
        linkedAt: '2026-08-31T12:00:00.000Z',
        lastEventAt: '2026-08-31T12:00:01.000Z',
        webhookReceiptCount: 1,
      }],
    }),
  });
  const notice = zernioSocialNoticeToken(SECRET, SESSION, 'invalid');
  const result = await call(`/portal/social/accounts?notice=${encodeURIComponent(notice)}`, deps(zernio));
  assert.equal(result.statusCode, 200);
  assert.match(result.body, /Connection reconciled by signed receipt/);
  assert.match(result.body, /Identity verified by signed provider receipt/);
  assert.doesNotMatch(result.body, /Connection request rejected/);
  assert.match(result.body, /Publishing<\/span><strong class="blocked">OFF/);
  assert.doesNotMatch(result.body, /zernio/i);
});

test('one valid connect command prepares Zernio once and renders a no-store hosted-consent handoff', async () => {
  const calls: unknown[] = [];
  const zernio = service({
    begin: async (identity, input) => {
      calls.push({ identity, input });
      return { ok: true, intentId: input.intentId, authUrl: 'https://zernio.com/connect/continue', providerEffects: 'oauth_not_started' };
    },
  });
  const body = new URLSearchParams({
    _csrf: portalCsrfToken(SECRET, SESSION),
    confirm_connect: 'CONNECT',
  }).toString();
  const result = await call('/portal/social/accounts/connect/facebook', deps(zernio), 'POST', body);
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.match(result.body, /Facebook consent ready/);
  assert.match(result.body, /href="https:\/\/zernio\.com\/connect\/continue"/);
  assert.match(result.body, />Continue to Facebook</);
  assert.equal(calls.length, 1);
  const input = (calls[0] as { input: { intentId: string; network: string } }).input;
  assert.match(input.intentId, /^[0-9a-f-]{36}$/u);
  assert.equal(input.network, 'facebook');
});

test('documented callback shape records the expected account once', async () => {
  const calls: unknown[] = [];
  const zernio = service({
    callback: async (identity, input) => {
      calls.push({ identity, input });
      return { ok: true, accountId: '55555555-5555-4555-8555-555555555555', disposition: 'recorded', providerEffects: 'account_already_connected_by_user' };
    },
  });
  const query = new URLSearchParams({
    intent: INTENT,
    connected: 'facebook',
    profileId: PROFILE,
    accountId: '6a95b77741c1829b085cbe99',
    username: 'propertypredator',
  });
  const result = await call(`/portal/social/accounts/callback?${query}`, deps(zernio));
  assert.equal(result.statusCode, 303);
  assert.match(result.headers.location ?? '', /^\/portal\/social\/accounts\?notice=/u);
  assert.equal(calls.length, 1);
  const input = (calls[0] as { input: { network: string; providerProfileId: string } }).input;
  assert.equal(input.network, 'facebook');
  assert.equal(input.providerProfileId, PROFILE);
});

test('bad CSRF and malformed callbacks never reach the connection service', async () => {
  let calls = 0;
  const zernio = service({
    begin: async () => { calls += 1; return { ok: false, kind: 'unavailable' }; },
    callback: async () => { calls += 1; return { ok: false, kind: 'unavailable' }; },
  });
  await call('/portal/social/accounts/connect/linkedin', deps(zernio), 'POST',
    new URLSearchParams({ _csrf: 'bad', confirm_connect: 'CONNECT' }).toString());
  await call(`/portal/social/accounts/callback?intent=${INTENT}&connected=true`, deps(zernio));
  assert.equal(calls, 0);
});
