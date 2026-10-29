import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { createMhpMount } from '../src/mhp/mount.js';
import { portalCsrfToken } from '../src/portal/session.js';
import type { PostgresPortalDeps } from '../src/portal/router.js';
import { MhpCommerceError } from '../src/mhp/commerce-service.js';
import { PgMhpDeskService, type MhpDeskSnapshot } from '../src/mhp/desk-service.js';
const TOKEN = Buffer.alloc(32, 14).toString('base64url');
const ID = '11900000-0000-4000-8000-000000000001';
const SECRET = 'mhp-desk-isolated-test-session-secret-32-characters';
const ORIGIN = 'https://app.martinhowardproperty.co.uk';
const snapshot = (): MhpDeskSnapshot => ({ access: { calculators: true, crm: true, readOnly: false, isAdmin: true, deskWriteEndsAt: null }, files: [], selected: null, lifetimeFileCount: 0, fileLimit: 3, verdict: null, canSubmitVerdict: true });
const hmo = { rooms: '6', room_rent_weekly: '125', bills_per_room_monthly: '75', management_pct: '10', voids_pct: '6', maintenance_pct: '8', compliance_annual: '800', insurance_annual: '450', yield_pct: '8', valuation_basis: 'net' };
const inputs = Object.fromEntries(Object.entries(hmo).map(([key, value]) => [`input_${key}`, value]));
const form = (values: Record<string, string> = {}) => new URLSearchParams({ csrf: portalCsrfToken(SECRET, TOKEN), commandId: ID, ...values }).toString();
function fixture(options: { owner?: boolean; access?: boolean; readOnly?: boolean; checkout?: string } = {}) {
  const calls: string[] = [], released: string[] = [];
  const portal = { kind: 'postgres', secure: true, sessionSecret: SECRET,
    auth: { resolve: async (token: string) => token === TOKEN ? { sessionToken: TOKEN, userId: ID, workspaceId: ID, userEmail: 'fixture@example.invalid' } : null },
    requestContext: () => ({ requestId: ID, requestHash: Buffer.alloc(32, 1), sourceHash: Buffer.alloc(32, 2) }),
    abuseHashSecret: 'mhp-desk-isolated-abuse-secret-32-characters',
    abuse: { admit: async () => ({ allowed: true, leaseHash: Buffer.alloc(32, 1) }), complete: async () => { released.push('release'); } },
  } as unknown as PostgresPortalDeps;
  const mount = createMhpMount({ portal, authMount: { handle: async () => false }, readiness: async () => [],
    hq: { isOwner: async () => options.owner !== false, snapshot: async () => ({ people: [], products: [], grants: [] }), grant: async () => ID },
    commerce: { billingEnabled: true, snapshot: async () => ({ access: { crm: true, enquirySite: true, emailWorkflow: false, emailWritable: false, leadrelay: false, readOnly: false, endsAt: null }, purchases: [] }),
      refund: async () => {}, billingPortal: async () => '', webhook: async () => {},
      creditSnapshot: async () => ({ availablePence: 4700, expiresAt: '2026-11-28T19:00:00Z', status: 'available', checkoutExpiresAt: null }),
      courseCheckout: async () => { calls.push('checkout'); return options.checkout ?? 'https://checkout.stripe.com/c/pay_fixture'; } },
    desk: { snapshot: async (_token, file) => { calls.push('snapshot'); const s = snapshot(); s.access.calculators = options.access !== false; s.access.readOnly = options.readOnly === true; if (file) throw new MhpCommerceError(404, 'No file'); return s; },
      save: async () => { if (options.readOnly) throw new MhpCommerceError(403, 'Read-only'); calls.push('save'); return ID; }, archive: async () => { calls.push('archive'); return ID; },
      submitVerdict: async () => { calls.push('submit'); return ID; }, queue: async () => { if (options.owner === false) throw new MhpCommerceError(403, 'Owner required'); calls.push('queue'); return { requests: [] }; },
      review: async () => { if (options.owner === false) throw new MhpCommerceError(403, 'Owner required'); calls.push('review'); return ID; } },
  });
  const request = async (method: string, url: string, body = '', headers: Record<string, string> = {}) => {
    const result = { status: 0, body: '', headers: {} as Record<string, string> };
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method, url, headers: { host: 'app.martinhowardproperty.co.uk', cookie: `__Host-mhp_session=${TOKEN}`, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...headers } }) as unknown as IncomingMessage;
    const res = { writeHead: (status: number, values: Record<string, string>) => { result.status = status; result.headers = values; }, end: (value = '') => { result.body = value; } } as unknown as ServerResponse;
    await mount.handle(req, res); return result;
  };
  return { request, calls, released };
}
test('MHP Deal Desk requires its own host and cookie and releases all admissions', async () => {
  const f = fixture();
  assert.equal((await f.request('GET', '/app/desk', '', { host: 'hq.propertypredator.com' })).status, 421);
  assert.equal((await f.request('GET', '/app/desk', '', { cookie: `r72_portal=${TOKEN}` })).headers.location, '/portal/login');
  const page = await f.request('GET', '/app/desk');
  assert.equal(page.status, 200); assert.equal(page.headers['cache-control'], 'no-store'); assert.match(page.body, /3 lifetime files/);
  assert.equal(page.headers['referrer-policy'], 'same-origin');
  assert.equal(f.released.length, 3);
});
test('all five calculators work only for a member with calculator access', async () => {
  for (const id of ['brrr', 'hmo', 'sa', 'auction', 'residual']) {
    assert.equal((await fixture().request('GET', `/app/calculators/${id}`)).status, 200);
    assert.equal((await fixture({ access: false }).request('GET', `/app/calculators/${id}`)).status, 403);
  }
  assert.equal((await fixture().request('GET', '/app/calculators/epc')).status, 404);
});
test('calculator recomputation works without saving and remains available during read-only access', async () => {
  const f = fixture({ readOnly: true });
  const page = await f.request('POST', '/app/calculators/hmo', form({ ...inputs, calculator: 'hmo', action: 'calculate' }));
  assert.equal(page.status, 200); assert.match(page.body, /£287,375/); assert.doesNotMatch(f.calls.join(','), /save/);
  assert.equal((await f.request('POST', '/app/calculators/hmo', form({ ...inputs, calculator: 'hmo', action: 'save', title: 'Test' }))).status, 403);
});
test('calculation errors preserve input and return an accessible form error', async () => {
  const f = fixture();
  const page = await f.request('POST', '/app/calculators/hmo', form({ ...inputs, input_yield_pct: '0', calculator: 'hmo', action: 'calculate', title: '<b>My file</b>' }));
  assert.equal(page.status, 400); assert.match(page.body, /role="alert"/); assert.match(page.body, /&lt;b&gt;My file&lt;\/b&gt;/); assert.match(page.body, /aria-invalid="true"/);
});
test('save rejects foreign origin, duplicate fields, posted totals, invalid CSRF and oversized bodies', async () => {
  const f = fixture(), payload = form({ ...inputs, calculator: 'hmo', action: 'save', title: 'Test' });
  assert.equal((await f.request('POST', '/app/calculators/hmo', payload, { origin: 'https://hq.propertypredator.com' })).status, 403);
  assert.equal((await f.request('POST', '/app/calculators/hmo', payload + '&input_rooms=7')).status, 403);
  assert.equal((await f.request('POST', '/app/calculators/hmo', payload + '&result=999999')).status, 403);
  assert.equal((await f.request('POST', '/app/calculators/hmo', payload.replace(/csrf=[^&]+/, 'csrf=wrong'))).status, 403);
  assert.equal((await f.request('POST', '/app/calculators/hmo', payload, { 'content-length': '32769' })).status, 413);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request('POST', '/app/calculators/hmo', payload)).headers.location, `/app/deals/${ID}?result=saved`);
});
test('verdict queue/review is owner-scoped and POST protected', async () => {
  const payload = form({ verdictId: ID, version: '1', response: 'Start with your local area.' });
  assert.equal((await fixture({ owner: false }).request('GET', '/hq/verdicts')).status, 403);
  assert.equal((await fixture({ owner: false }).request('POST', '/hq/verdicts/review', payload)).status, 403);
  assert.equal((await fixture().request('POST', '/hq/verdicts/review', payload, { origin: '' })).status, 403);
  assert.equal((await fixture().request('POST', '/hq/verdicts/review', payload)).headers.location, '/hq/verdicts?result=reviewed');
});
test('course checkout is authenticated POST, protected and redirects only to Stripe checkout', async () => {
  assert.equal((await fixture().request('GET', '/app/account/course-checkout')).status, 405);
  assert.equal((await fixture().request('POST', '/app/account/course-checkout', form(), { origin: '' })).status, 403);
  assert.equal((await fixture({ checkout: 'https://example.invalid/checkout' }).request('POST', '/app/account/course-checkout', form())).status, 503);
  assert.equal((await fixture().request('POST', '/app/account/course-checkout', form())).headers.location, 'https://checkout.stripe.com/c/pay_fixture');
});
test('save service recomputes result and records version while never passing posted result data', async () => {
  let args: unknown[] = [];
  const pool = { query: async (_sql: string, values: unknown[]) => { args = values; return { rows: [{ id: ID }] }; } } as unknown as Pick<Pool, 'query'>;
  const service = new PgMhpDeskService(pool, pool);
  await service.save(TOKEN, { ...inputs, commandId: ID, calculator: 'hmo', title: 'My HMO', result: 'FAKE TOTAL' });
  const result = args[8] as { results: Record<string, number>; version: string };
  assert.equal(result.results.income_value, 287375); assert.equal(args[9], result.version); assert.doesNotMatch(JSON.stringify(args), /FAKE TOTAL/);
  await assert.rejects(service.save(TOKEN, { ...inputs, commandId: ID, calculator: 'hmo', title: '' }), /file name/i);
});
test('verdict service validates intake and command identity before touching persistence', async () => {
  let count = 0;
  const pool = { query: async () => { count++; return { rows: [{ id: ID }] }; } } as unknown as Pick<Pool, 'query'>;
  const service = new PgMhpDeskService(pool, pool);
  await assert.rejects(service.submitVerdict(TOKEN, { commandId: ID }), /Confirm/);
  await assert.rejects(service.submitVerdict(TOKEN, { commandId: ID, confirm: 'yes' }), /experience/i);
  assert.equal(count, 0);
  await service.submitVerdict(TOKEN, { commandId: ID, confirm: 'yes', experience: 'New', budget: '£30,000', weeklyTime: '8 hours', areas: 'Stoke', goals: 'First rental', questions: '' });
  assert.equal(count, 1);
});
test('the lifetime file cap returns a useful conflict rather than a service outage', async () => {
  const pool = { query: async () => { throw { code: '54000' }; } } as unknown as Pick<Pool, 'query'>;
  const service = new PgMhpDeskService(pool, pool);
  await assert.rejects(service.save(TOKEN, { ...inputs, commandId: ID, calculator: 'hmo', title: 'Fourth file' }),
    error => error instanceof MhpCommerceError && error.status === 409 && /Archiving does not free a slot/.test(error.message));
});
