import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMhpMount } from '../src/mhp/mount.js';
import { portalCsrfToken } from '../src/portal/session.js';
import type { PostgresPortalDeps } from '../src/portal/router.js';
import { MARTIN_HOWARD_PROPERTY_PROFILE } from '../src/portal/product-profile.js';
import type { MhpOwnedSmsService } from '../src/mhp/owned-sms-service.js';
import { MHP_OWNED_SMS_DEFAULT_BODY } from '../src/mhp/owned-sms-service.js';
import { ids, identity, token, now, review } from './helpers/mhp-owner-email-fixture.js';
const HOST = 'app.martinhowardproperty.co.uk', ORIGIN = `https://${HOST}`, SECRET = 'synthetic-mhp-owned-sms-router-secret-at-least-32';
const BASE = '/hq/marketing/phone-test';
export function ownedSmsRouterFixture() {
  const state = { authenticated: true, connected: false, verified: false, suppressed: false, calls: [] as string[], code: '', input: null as unknown };
  const database = () => ({ bindingId: state.connected ? ids.approval : null, senderNumber: state.connected ? '+447861935832' : null,
    contactId: ids.prospect, contactPointId: ids.proof, verified: state.verified, suppressed: state.suppressed, lastResult: null });
  const detail = { review: { ...review, kind: 'other' as const, contentSha256: 'a'.repeat(64) }, channel: 'sms' as const,
    payload: { schema: 'growthhq.sms-draft/v1' as const, bodyText: MHP_OWNED_SMS_DEFAULT_BODY }, valid: true, local: null, manifestSha256: 'b'.repeat(64) };
  const sms: Pick<MhpOwnedSmsService, 'snapshot' | 'review' | 'save' | 'bind' | 'requestCode' | 'confirmCode' | 'send'> = {
    snapshot: async () => ({ database: database(), config: { phone: '+447510243096', senderNumber: '+447861935832' }, blockers: [], choices: [] }),
    review: async (_identity, _request, itemId, versionId) => { assert.equal(itemId, ids.item); assert.equal(versionId, ids.version); return detail; },
    save: async (_identity, _request, input) => { state.calls.push('save'); state.input = input; return { contentItemId: ids.item, contentVersionId: ids.version, contentSha256: 'a'.repeat(64), replayed: false }; },
    bind: async () => { state.calls.push('bind'); state.connected = true; },
    requestCode: async () => { state.calls.push('request-code'); return ids.request; },
    confirmCode: async (_identity, _request, _challenge, code) => { state.calls.push('confirm-code'); state.code = code; state.verified = true; return true; },
    send: async (_identity, _request, input) => { state.calls.push('send'); state.input = input; return { jobId: ids.send, messageVersionId: ids.lease,
      contentVersionId: ids.version, commandId: ids.command, authorityExpiresAt: '2026-11-01T12:04:00.000Z', state: 'queued', replayed: false }; },
  };
  const portal = { kind: 'postgres', secure: true, sessionSecret: SECRET, sessionCookieName: '__Host-mhp_session', productProfile: MARTIN_HOWARD_PROPERTY_PROFILE,
    portalBaseUrl: ORIGIN, now: () => now, crm: {} as PostgresPortalDeps['crm'],
    auth: { resolve: async (given: string) => state.authenticated && given === token ? identity : null, login: async () => null, revoke: async () => {} }, abuseHashSecret: SECRET,
    requestContext: () => ({ requestId: ids.request, requestHash: Buffer.alloc(32, 1), sourceHash: Buffer.alloc(32, 2) }),
    abuse: { admit: async () => ({ allowed: true, leaseHash: Buffer.alloc(32, 1), retryAfterSeconds: 0 }), complete: async () => {}, assertReady: async () => {}, close: async () => {} } } as PostgresPortalDeps;
  const mount = createMhpMount({ portal, ownedSms: sms, authMount: { handle: async () => false }, readiness: async () => [],
    hq: { isOwner: async () => true, snapshot: async () => ({ people: [], products: [], grants: [] }), grant: async () => ids.command },
    commerce: { billingEnabled: false, snapshot: async () => { throw Error('excluded'); }, refund: async () => {}, billingPortal: async () => '', webhook: async () => {} } });
  const form = (fields: Record<string, string>) => new URLSearchParams({ csrf: portalCsrfToken(SECRET, token), commandId: ids.command, ...fields }).toString();
  async function request(method: string, path: string, body = '', headers: Record<string, string> = {}) {
    const result = { status: 0, headers: {} as Record<string, string>, body: '' };
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method, url: path, headers: { host: HOST, cookie: `__Host-mhp_session=${token}`,
      'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, ...headers } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number, head: Record<string, string> = {}) { result.status = status; Object.assign(result.headers, head); },
      setHeader(key: string, value: string) { result.headers[key.toLowerCase()] = value; }, end(body = '') { result.body = body; } } as unknown as ServerResponse;
    await mount.handle(req, res); return result;
  }
  return { state, sms, mount, portal, form, request };
}
test('real MHP host mount forwards owned test and offers connection, private verification and one Send action', async () => {
  const f = ownedSmsRouterFixture(); let page = await f.request('GET', BASE);
  assert.equal(page.status, 200); assert.match(page.body, /Connect MHP sender/u); assert.match(page.body, /17px/u); assert.doesNotMatch(page.body, /name="code"/u);
  await f.request('POST', `${BASE}/connect`, f.form({ ownershipEvidence: 'actual-purchase', regulatoryEvidence: 'actual-registration', confirmed: 'yes' }));
  page = await f.request('POST', `${BASE}/request-code`, f.form({})); assert.equal(page.status, 200); assert.match(page.body, /Six-digit code/u);
  page = await f.request('POST', `${BASE}/confirm-code`, f.form({ challengeId: ids.request, code: '123456' }));
  assert.equal(page.status, 200); assert.equal(f.state.code, '123456'); assert.doesNotMatch(page.body, /123456/u);
  page = await f.request('POST', `${BASE}/save`, f.form({ bodyText: MHP_OWNED_SMS_DEFAULT_BODY, itemId: '', previousVersionId: '' }));
  assert.equal(page.status, 200); assert.equal((page.body.match(/Send my one test text/gu) ?? []).length, 1); assert.match(page.body, /does not subscribe me/u);
  page = await f.request('POST', `${BASE}/send`, f.form({ itemId: ids.item, versionId: ids.version, pointId: ids.proof, sha256: 'a'.repeat(64), agreed: 'yes' }));
  assert.equal(page.status, 200); assert.match(page.body, /Queued is not delivered/u);
  assert.deepEqual(f.state.calls, ['bind', 'request-code', 'confirm-code', 'save', 'send']);
});
test('bad Origin, CSRF, hidden workspace injection and another host cannot reach commands', async () => {
  const f = ownedSmsRouterFixture();
  assert.equal((await f.request('POST', `${BASE}/request-code`, f.form({}), { origin: 'https://hq.propertypredator.com' })).status, 403);
  assert.equal((await f.request('POST', `${BASE}/request-code`, f.form({ csrf: 'wrong' }))).status, 403);
  assert.equal((await f.request('POST', `${BASE}/request-code`, f.form({ workspaceId: ids.prospect }))).status, 400);
  assert.equal((await f.request('GET', BASE, '', { host: 'hq.propertypredator.com' })).status, 421); assert.deepEqual(f.state.calls, []);
});
test('the native pilot redirects an unauthenticated MHP visitor to the existing login', async () => {
  const f = ownedSmsRouterFixture(); f.state.authenticated = false; const result = await f.request('GET', BASE);
  assert.equal(result.status, 303); assert.equal(result.headers.location, '/portal/login'); assert.deepEqual(f.state.calls, []);
});
