import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { handlePortal, type PortalDeps } from '../src/portal/router.js';
import { signTenant, PORTAL_COOKIE } from '../src/portal/session.js';
import type { DashboardData } from '../src/portal/data.js';
import type { BillingView } from '../src/portal/billing.js';

function billingView(over: Partial<BillingView> = {}): BillingView {
  return {
    status: 'none', active: false, planKey: null, planName: null, currentPeriodEnd: null,
    customerId: null, email: 'owner@frayne.co',
    options: [{ key: 'platform_growth', name: 'Growth', description: 'more reach', priceLabel: '$299/mo' }],
    ...over,
  };
}

const SECRET = 'test-secret';

const demoData: DashboardData = {
  tenant: { id: 't1', name: 'Frayne Electrical', createdAt: '2026-07-26T00:00:00Z' },
  contacts: [{ id: 'c-1', tenantId: 't1', name: 'Priya Nair', stage: 'contacted', createdAt: '2026-07-26T00:00:00Z' }],
  pipeline: { lead: 0, contacted: 1, qualified: 0, won: 0, lost: 0 },
  activity: [{ id: 'act-1', tenantId: 't1', at: '2026-08-03T09:00:00Z', kind: 'rail_run', channel: 'system', summary: 'Generated a content cluster' }],
  artifacts: {},
};

function deps(over: Partial<PortalDeps> = {}): PortalDeps {
  return {
    sessionSecret: SECRET,
    secure: false,
    now: () => 1_000_000,
    login: async (email, pw) => (email === 'owner@frayne.co' && pw === 'good' ? 't1' : null),
    dashboard: async (tid) => (tid === 't1' ? demoData : null),
    runTick: async () => 4,
    ...over,
  };
}

// Minimal req/res doubles for the node http handler.
function mkReq(method: string, url: string, opts: { cookie?: string; body?: string } = {}) {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string; headers: Record<string, string> };
  req.method = method;
  req.url = url;
  req.headers = {};
  if (opts.cookie) req.headers.cookie = opts.cookie;
  queueMicrotask(() => { if (opts.body) req.emit('data', Buffer.from(opts.body)); req.emit('end'); });
  return req;
}
function mkRes() {
  const res = { statusCode: 0, headers: {} as Record<string, string>, body: '',
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; },
    writeHead(code: number, headers?: Record<string, string>) { this.statusCode = code; if (headers) for (const k in headers) this.headers[k.toLowerCase()] = headers[k]!; return this; },
    end(b?: string) { if (b) this.body = b; } };
  return res;
}
async function call(method: string, url: string, d: PortalDeps, opts: { cookie?: string; body?: string } = {}) {
  const res = mkRes();
  await handlePortal(mkReq(method, url, opts) as never, res as never, d);
  return res;
}
const cookieFor = (tid: string) => `${PORTAL_COOKIE}=${signTenant(SECRET, tid, 1_000_000)}`;

test('GET /portal without a session redirects to login', async () => {
  const res = await call('GET', '/portal', deps());
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/portal/login');
});

test('POST /portal/login with good credentials sets a cookie and redirects', async () => {
  const res = await call('POST', '/portal/login', deps(), { body: 'email=owner@frayne.co&password=good' });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/portal');
  assert.match(res.headers['set-cookie'] ?? '', new RegExp(PORTAL_COOKIE + '='));
});

test('POST /portal/login with bad credentials 401s and re-shows the form', async () => {
  const res = await call('POST', '/portal/login', deps(), { body: 'email=owner@frayne.co&password=wrong' });
  assert.equal(res.statusCode, 401);
  assert.match(res.body, /Wrong email or password/);
});

test('GET /portal with a valid session renders that tenant’s dashboard', async () => {
  const res = await call('GET', '/portal', deps(), { cookie: cookieFor('t1') });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Frayne Electrical/);
  assert.match(res.body, /Priya Nair/);
});

test('POST /portal/run runs the manager and redirects back', async () => {
  let ran = 0;
  const res = await call('POST', '/portal/run', deps({ runTick: async () => { ran++; return 4; } }), { cookie: cookieFor('t1') });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/portal');
  assert.equal(ran, 1);
});

test('a forged/expired cookie is treated as logged out', async () => {
  const res = await call('GET', '/portal', deps(), { cookie: `${PORTAL_COOKIE}=not.a.valid.token` });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/portal/login');
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
  assert.match(res.body, /Choose a plan/);
  assert.match(res.body, /\$299\/mo/);
  assert.match(res.body, /action="\/portal\/subscribe"/);
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
  const res = await call('POST', '/portal/subscribe', d, { cookie: cookieFor('t1'), body: 'plan=platform_growth' });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, 'https://pay.stripe.test/sub_1');
  assert.deepEqual(seen, [{ plan: 'platform_growth', email: 'owner@frayne.co' }]);
});

test('POST /portal/subscribe redirects back with an error when checkout throws', async () => {
  const d = deps({ billing: async () => billingView(), subscribeUrl: async () => { throw new Error('bad plan'); } });
  const res = await call('POST', '/portal/subscribe', d, { cookie: cookieFor('t1'), body: 'plan=nope' });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/portal/billing?error=1');
});

test('POST /portal/manage opens the Stripe billing portal for the customer', async () => {
  const seen: string[] = [];
  const d = deps({
    billing: async () => billingView({ status: 'active', active: true, customerId: 'cus_9' }),
    manageUrl: async (cid) => { seen.push(cid); return 'https://billing.stripe.test/cus_9'; },
  });
  const res = await call('POST', '/portal/manage', d, { cookie: cookieFor('t1') });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, 'https://billing.stripe.test/cus_9');
  assert.deepEqual(seen, ['cus_9']);
});

test('POST /portal/run is soft by default — runs even without an active subscription', async () => {
  let ran = 0;
  const d = deps({ runTick: async () => { ran++; return 4; }, billing: async () => billingView({ status: 'none', active: false }) });
  const res = await call('POST', '/portal/run', d, { cookie: cookieFor('t1') });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/portal');
  assert.equal(ran, 1);
});

test('POST /portal/run is gated to /portal/billing when enforcement is on and the sub is inactive', async () => {
  let ran = 0;
  const d = deps({ runTick: async () => { ran++; return 4; }, billingEnforced: true, billing: async () => billingView({ status: 'past_due', active: false }) });
  const res = await call('POST', '/portal/run', d, { cookie: cookieFor('t1') });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/portal/billing?need=1');
  assert.equal(ran, 0, 'the run must not fire without an active subscription');
});

test('POST /portal/run under enforcement runs for an active subscriber', async () => {
  let ran = 0;
  const d = deps({ runTick: async () => { ran++; return 4; }, billingEnforced: true, billing: async () => billingView({ status: 'active', active: true }) });
  const res = await call('POST', '/portal/run', d, { cookie: cookieFor('t1') });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/portal');
  assert.equal(ran, 1);
});
