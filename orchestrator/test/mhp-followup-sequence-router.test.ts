import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMhpMount } from '../src/mhp/mount.js';
import { MhpCommerceError } from '../src/mhp/commerce-service.js';
import { portalCsrfToken } from '../src/portal/session.js';
import type { PostgresPortalDeps } from '../src/portal/router.js';
import { MARTIN_HOWARD_PROPERTY_PROFILE } from '../src/portal/product-profile.js';
import type { MhpSequenceService } from '../src/mhp/followup-sequence-service.js';
import { followupTimeline } from '../src/followup-sequences/definition.js';
import { ids, identity, token, now } from './helpers/mhp-owner-email-fixture.js';
import { sequenceIds, sequenceDefinition as definition, sequenceSnapshot as snapshot, sequenceDetail as detail } from './helpers/mhp-sequence-fixture.js';
const HOST = 'app.martinhowardproperty.co.uk', ORIGIN = `https://${HOST}`, SECRET = 'synthetic-followup-sequence-native-secret-at-least-32';
const BASE = '/hq/marketing/sequences';
function fixture() {
  const state = { authenticated: true, allowed: true, calls: [] as string[], input: null as unknown, published: false };
  const authorise = (given: { sessionToken: string; workspaceId: string }) => { assert.equal(given.sessionToken, token); assert.equal(given.workspaceId, identity.workspaceId); if (!state.allowed) throw new MhpCommerceError(403, 'Open the owner workspace.'); };
  const sequences: Pick<MhpSequenceService, 'snapshot' | 'review' | 'preview' | 'save' | 'publish' | 'command'> = {
    snapshot: async given => { authorise(given); return snapshot; },
    review: async (given, _request, item, version) => { authorise(given); assert.equal(item, sequenceIds.item); assert.equal(version, sequenceIds.version); return { ...detail, review: { ...detail.review, approvalStatus: state.published ? 'approved' : 'unrequested' } }; },
    preview: async (given, _request, value) => { authorise(given); state.calls.push('preview'); state.input = value; return { definition, timeline: followupTimeline(definition), blockers: [] }; },
    save: async (given, _request, value) => { authorise(given); state.calls.push('save'); state.input = value; return { contentItemId: sequenceIds.item, contentVersionId: sequenceIds.version, replayed: false }; },
    publish: async given => { authorise(given); state.calls.push('publish'); state.published = true; },
    command: async (given, _request, value) => { authorise(given); state.calls.push(value.action); state.input = value; return { action: value.action, contentItemId: sequenceIds.item, contentVersionId: sequenceIds.version, changed: 3, remaining: 2, blocked: 1, inFlight: 1, replayed: false }; },
  };
  const portal = { kind: 'postgres', secure: true, sessionSecret: SECRET, sessionCookieName: '__Host-mhp_session', productProfile: MARTIN_HOWARD_PROPERTY_PROFILE, portalBaseUrl: ORIGIN, now: () => now,
    crm: {} as PostgresPortalDeps['crm'], auth: { resolve: async (given: string) => state.authenticated && given === token ? identity : null, login: async () => null, revoke: async () => {} }, abuseHashSecret: SECRET,
    requestContext: () => ({ requestId: ids.request, requestHash: Buffer.alloc(32, 1), sourceHash: Buffer.alloc(32, 2) }),
    abuse: { admit: async () => ({ allowed: true, leaseHash: Buffer.alloc(32, 1), retryAfterSeconds: 0 }), complete: async () => {}, assertReady: async () => {}, close: async () => {} } } as PostgresPortalDeps;
  const mount = createMhpMount({ portal, sequences, authMount: { handle: async () => false }, readiness: async () => [],
    hq: { isOwner: async () => true, snapshot: async () => ({ people: [], products: [], grants: [] }), grant: async () => ids.command },
    commerce: { billingEnabled: false, snapshot: async () => { throw new Error('excluded'); }, refund: async () => {}, billingPortal: async () => '', webhook: async () => {} },
    marketingWorkspace: { snapshot: async given => { authorise(given); return { userId: identity.userId, selectedWorkspaceId: identity.workspaceId, personalWorkspaceId: ids.prospect, marketingWorkspaceId: identity.workspaceId, marketingSelected: true }; }, select: async () => { throw new Error('excluded'); } } });
  const saved = (extra: Record<string, string> = {}) => new URLSearchParams({ csrf: portalCsrfToken(SECRET, token), commandId: ids.command, itemId: sequenceIds.item, versionId: sequenceIds.version, ...extra }).toString();
  const control = (extra: Record<string, string> = {}) => saved({ runId: '', ackProofId: '', ...extra });
  const draft = (extra: Record<string, string> = {}) => new URLSearchParams({ csrf: portalCsrfToken(SECRET, token), commandId: ids.command, contentItemId: '', previousVersionId: '', definition: JSON.stringify(definition), ...extra }).toString();
  async function request(method: string, path: string, body = '', headers: Record<string, string> = {}) {
    const result = { status: 0, headers: {} as Record<string, string>, body: '' };
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method, url: path, headers: { host: HOST, cookie: `__Host-mhp_session=${token}`, 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, ...headers } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number, head: Record<string, string> = {}) { result.status = status; Object.assign(result.headers, head); }, setHeader(key: string, value: string) { result.headers[key.toLowerCase()] = value; }, end(body = '') { result.body = body; } } as unknown as ServerResponse;
    await mount.handle(req, res); return result;
  }
  return { state, request, saved, control, draft };
}
test('native marketing entry exposes sequence builder and exact owner page/script/CSP', async () => {
  const f = fixture(); assert.match((await f.request('GET', '/hq/marketing')).body, /Open sequence builder/u);
  for (const path of [BASE, `${BASE}?new=1`, `${BASE}?item=${sequenceIds.item}&version=${sequenceIds.version}`]) {
    const page = await f.request('GET', path); assert.equal(page.status, 200); assert.equal(page.headers['cache-control'], 'no-store'); assert.match(page.headers['content-security-policy']!, /script-src 'self'/u);
    assert.match(page.body, /Return to personal Desk/u);
  }
  const script = await f.request('GET', `${BASE}/editor.js`); assert.equal(script.status, 200); assert.match(script.headers['content-type']!, /javascript/u); assert.match(script.body, /dragstart/u); assert.match(script.body, /Move up/u);
});
test('save creates an immutable-version redirect, preview preserves draft and invokes no enrolment', async () => {
  const f = fixture(); const saved = await f.request('POST', `${BASE}/save`, f.draft()); assert.equal(saved.status, 303); assert.equal(saved.headers.location, `${BASE}?item=${sequenceIds.item}&version=${sequenceIds.version}`);
  const preview = await f.request('POST', `${BASE}/preview`, f.draft()); assert.equal(preview.status, 200); assert.match(preview.body, /Sequence timeline/u); assert.deepEqual(f.state.calls, ['save', 'preview']);
});
test('Publish never enrols; Start is explicit and controls preserve exact run/proof acknowledgement', async () => {
  const f = fixture(); const published = await f.request('POST', `${BASE}/publish`, f.saved()); assert.equal(published.status, 200); assert.match(published.body, /No one was enrolled/u); assert.deepEqual(f.state.calls, ['publish']);
  const started = await f.request('POST', `${BASE}/enrol`, f.control()); assert.equal(started.status, 200); assert.match(started.body, /3 runs started/u); assert.match(started.body, /1 already being processed/u);
  const resumed = await f.request('POST', `${BASE}/resume`, f.control({ runId: sequenceIds.run, ackProofId: sequenceIds.proof })); assert.equal(resumed.status, 200);
  assert.equal((f.state.input as { ackProofId: string }).ackProofId, sequenceIds.proof);
});
test('foreign/null origins, cross-site metadata and invalid CSRF reject every mutation before capability access', async () => {
  const f = fixture();
  for (const action of ['publish', 'enrol', 'pause', 'resume', 'stop', 'cancel']) for (const headers of [{ origin: 'null' }, { origin: 'https://foreign.invalid' }, { 'sec-fetch-site': 'cross-site' }] as Record<string, string>[]) {
    assert.equal((await f.request('POST', `${BASE}/${action}`, action === 'publish' ? f.saved() : f.control(), headers)).status, 403);
  }
  assert.equal((await f.request('POST', `${BASE}/save`, f.draft({ csrf: 'wrong' }))).status, 403); assert.deepEqual(f.state.calls, []);
});
test('forged actor/destination, duplicate fields, wrong methods, mixed selectors and oversized bodies are rejected', async () => {
  const f = fixture();
  for (const extra of ['&recipient=somebody%40example.invalid', '&actorId=' + ids.user, '&runId=' + sequenceIds.run]) assert.equal((await f.request('POST', `${BASE}/enrol`, f.control() + extra)).status, 400);
  assert.equal((await f.request('GET', `${BASE}/enrol`)).status, 405); assert.equal((await f.request('POST', BASE)).status, 405);
  assert.equal((await f.request('GET', `${BASE}?new=1&item=${sequenceIds.item}&version=${sequenceIds.version}`)).status, 400);
  assert.equal((await f.request('POST', `${BASE}/save`, f.draft(), { 'content-length': '140001' })).status, 413);
  assert.equal((await f.request('POST', `${BASE}/save`, f.draft({ definition: 'bad json' }))).status, 400); assert.deepEqual(f.state.calls, []);
});
test('foreign host, unauthenticated session and non-owner cannot read or mutate native sequence state', async () => {
  const f = fixture(); assert.equal((await f.request('GET', BASE, '', { host: 'hq.propertypredator.com' })).status, 421);
  f.state.authenticated = false; const redirect = await f.request('GET', BASE); assert.equal(redirect.status, 303); assert.equal(redirect.headers.location, '/portal/login');
  f.state.authenticated = true; f.state.allowed = false; assert.equal((await f.request('GET', BASE)).status, 403); assert.equal((await f.request('POST', `${BASE}/enrol`, f.control())).status, 403); assert.deepEqual(f.state.calls, []);
});
