import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMhpMount } from '../src/mhp/mount.js';
import { portalCookie, clearPortalCookie, portalCsrfToken } from '../src/portal/session.js';
import type { PostgresPortalDeps } from '../src/portal/router.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import type { PortalSessionIdentity } from '../src/portal/auth-service.js';
import { MhpCommerceError } from '../src/mhp/commerce-service.js';

const HOST = 'app.martinhowardproperty.co.uk';
const ORIGIN = `https://${HOST}`;
const SECRET = 'mhp-isolated-mount-test-secret-at-least-32-characters';
const TOKEN = Buffer.alloc(32, 7).toString('base64url');
const ID = '11300000-0000-4000-8000-000000000001';
const identity: PortalSessionIdentity = { sessionToken: TOKEN, userId: ID, workspaceId: ID, userEmail: 'fixture@example.invalid' };
function response() {
  const captured = { status: 0, body: '', headers: {} as Record<string, string> };
  const res = {
    writeHead(status: number, headers = {}) { captured.status = status; Object.assign(captured.headers, headers); },
    setHeader(key: string, value: string) { captured.headers[key.toLowerCase()] = value; },
    end(body = '') { captured.body = body; },
  } as unknown as ServerResponse;
  return { captured, res };
}
function fixture(owner = true) {
  const calls: string[] = [];
  const portal: PostgresPortalDeps = {
    kind: 'postgres', secure: true, sessionSecret: SECRET, sessionCookieName: '__Host-mhp_session',
    auth: { resolve: async token => token === TOKEN ? identity : null, login: async () => null, revoke: async () => {} },
    crm: {} as PortalCrmService,
    abuseHashSecret: 'different-mhp-mount-abuse-secret-with-32-characters',
    requestContext: () => ({ requestId: ID, requestHash: Buffer.alloc(32, 1), sourceHash: Buffer.alloc(32, 2) }),
    abuse: { admit: async () => ({ allowed: true, leaseHash: Buffer.alloc(32, 1), retryAfterSeconds: 0 }),
      complete: async () => {}, assertReady: async () => {}, close: async () => {} },
  };
  const mount = createMhpMount({ portal, authMount: { handle: async () => false }, readiness: async () => [],
    hq: {
      isOwner: async () => owner,
      snapshot: async () => { if (!owner) throw new MhpCommerceError(403, 'Owner access is required for HQ.'); calls.push('hq'); return { people: [], products: [], grants: [] }; },
      grant: async (_token, form) => { if (!owner) throw new MhpCommerceError(403, 'Owner access is required for HQ.'); assert.equal(form.note, 'Test account'); calls.push('grant'); return ID; },
    },
    commerce: {
      billingEnabled: true,
      snapshot: async token => { assert.equal(token, TOKEN); calls.push('snapshot'); return {
        access: { crm: false, enquirySite: false, emailWorkflow: false, emailWritable: false, leadrelay: false, readOnly: false, endsAt: null }, purchases: [],
      }; },
      refund: async (token, purchase) => { assert.equal(token, TOKEN); assert.equal(purchase, ID); calls.push('refund'); },
      billingPortal: async () => { calls.push('billing'); return 'https://billing.stripe.com/p/session/fixture'; },
      webhook: async () => { calls.push('webhook'); },
    },
  });
  const request = async (method: string, url: string, body = '', headers: Record<string, string> = {}) => {
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method, url, headers: {
      host: HOST, cookie: `__Host-mhp_session=${TOKEN}`, 'content-type': 'application/x-www-form-urlencoded', ...headers,
    } }) as unknown as IncomingMessage;
    const { captured, res } = response(); await mount.handle(req, res); return captured;
  };
  return { calls, request };
}

test('MHP cookie is distinct, host-only and requires Secure even when rotated or cleared', () => {
  const cookie = portalCookie(TOKEN, true, undefined, '__Host-mhp_session');
  assert.match(cookie, /^__Host-mhp_session=/); assert.match(cookie, /; Secure/); assert.doesNotMatch(cookie, /Domain=/i);
  assert.match(clearPortalCookie(true, '__Host-mhp_session'), /^__Host-mhp_session=;/);
  assert.throws(() => portalCookie(TOKEN, false, undefined, '__Host-mhp_session'));
  assert.match(portalCookie(TOKEN, false), /^r72_portal=/);
});

test('kit-only member can view their account while PP cookies cannot authenticate there', async () => {
  const f = fixture();
  const account = await f.request('GET', '/app/account');
  assert.equal(account.status, 200); assert.match(account.body, /Martin Howard Property/);
  assert.equal(account.headers['cache-control'], 'no-store');
  const copied = await f.request('GET', '/app/account', '', { cookie: `r72_portal=${TOKEN}` });
  assert.equal(copied.status, 303); assert.equal(copied.headers.location, '/portal/login');
  assert.deepEqual(f.calls, ['snapshot']);
});

test('refund requires exact origin, session CSRF, explicit confirmation and unique form fields', async () => {
  const f = fixture();
  const csrf = portalCsrfToken(SECRET, TOKEN);
  const form = new URLSearchParams({ csrf, purchaseId: ID, confirm: 'yes' }).toString();
  assert.equal((await f.request('POST', '/app/account/refund', form)).status, 403);
  assert.equal((await f.request('POST', '/app/account/refund', form, { origin: 'https://hq.propertypredator.com' })).status, 403);
  assert.equal((await f.request('POST', '/app/account/refund', form.replace('confirm=yes', 'confirm=no'), { origin: ORIGIN })).status, 400);
  assert.equal((await f.request('POST', '/app/account/refund', `${form}&purchaseId=${ID}`, { origin: ORIGIN })).status, 403);
  assert.equal((await f.request('POST', '/app/account/refund', form, { origin: ORIGIN })).status, 303);
  assert.deepEqual(f.calls, ['refund']);
});

test('MHP denies PP SSO, setup, marketing, admin and legacy checkout paths', async () => {
  const f = fixture();
  for (const route of ['/portal/auth/property-predator', '/portal/setup', '/portal/content', '/admin', '/api/checkout', '/api/subscribe']) {
    assert.equal((await f.request('GET', route)).status, 404);
  }
  assert.equal((await f.request('GET', '/app/account', '', { host: 'hq.propertypredator.com' })).status, 421);
  assert.deepEqual(f.calls, []);
});

test('HQ admits owners, rejects members and ignores PP session cookies', async () => {
  const owner = fixture();
  assert.equal((await owner.request('GET', '/hq')).status, 200);
  const account = await owner.request('GET', '/app/account');
  assert.match(account.body, /href="\/hq"/);
  const member = fixture(false);
  assert.equal((await member.request('GET', '/hq')).status, 403);
  assert.doesNotMatch((await member.request('GET', '/app/account')).body, /href="\/hq"/);
  assert.equal((await owner.request('GET', '/hq', '', { cookie: `r72_portal=${TOKEN}` })).headers.location, '/portal/login');
});

test('manual grant requires owner, exact origin, CSRF and unique form fields without invoking commerce', async () => {
  const f = fixture();
  const form = new URLSearchParams({ csrf: portalCsrfToken(SECRET, TOKEN), commandId: ID,
    targetEmail: 'test@example.invalid', targetName: 'Test', productId: ID, endsAt: '', note: 'Test account' }).toString();
  assert.equal((await f.request('POST', '/hq/grant', form)).status, 403);
  assert.equal((await f.request('POST', '/hq/grant', form, { origin: 'https://hq.propertypredator.com' })).status, 403);
  assert.equal((await f.request('POST', '/hq/grant', `${form}&productId=${ID}`, { origin: ORIGIN })).status, 403);
  assert.equal((await f.request('POST', '/hq/grant', form.replace(/csrf=[^&]+/, 'csrf=bad'), { origin: ORIGIN })).status, 403);
  assert.equal((await fixture(false).request('POST', '/hq/grant', form, { origin: ORIGIN })).status, 403);
  const result = await f.request('POST', '/hq/grant', form, { origin: ORIGIN });
  assert.equal(result.status, 303); assert.equal(result.headers.location, '/hq?result=granted');
  assert.deepEqual(f.calls, ['grant']);
});
