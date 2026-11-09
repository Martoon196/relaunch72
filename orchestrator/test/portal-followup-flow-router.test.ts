import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { buildPostgresPortalDeps } from '../src/portal/provision.js';
import { PORTAL_COOKIE, portalCsrfToken } from '../src/portal/session.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import { PortalFollowupFlowService, PP_FOLLOWUP_CAMPAIGN, PP_FOLLOWUP_ROUTE as BASE } from '../src/portal/followup-flow-service.js';
import { FlowWorkspaceError } from '../src/followup-sequences/workspace.js';
import { parseFlowComposition } from '../src/followup-sequences/composition.js';
import { followupActivationBlockers, followupTimeline } from '../src/followup-sequences/definition.js';
import { flowSimulationPreset, simulateFollowupFlow } from '../src/followup-sequences/simulation.js';
import { ids, identity as mhpIdentity, review as emailReview, now } from './helpers/mhp-owner-email-fixture.js';
import { sequenceDefinition, sequenceIds, sequenceDetail } from './helpers/mhp-sequence-fixture.js';
const ORIGIN = 'https://hq.propertypredator.com', TOKEN = 'synthetic-pp-native-flow-session', SECRET = 'synthetic-pp-flow-native-secret-at-least-32';
const identity = { ...mhpIdentity, sessionToken: TOKEN, workspaceId: 'd975ff66-336a-46c2-b36b-d7095a11af97', userEmail: 'synthetic@example.invalid' };
const definition = { ...sequenceDefinition, brand: 'pp' as const, campaign: PP_FOLLOWUP_CAMPAIGN };
const readiness = { email: false, sms: false, whatsapp: false, reply: false, booked: false, purchased: false };
export function flowRouterFixture() {
  const state = { authenticated: true, owner: true, calls: [] as string[], input: null as unknown, published: false, leases: 0, completed: 0 };
  const authorise = () => { if (!state.owner) throw new FlowWorkspaceError(403, 'Owner/admin required'); };
  const snapshot = { brand: { canonical: '{}', sha256: '0'.repeat(64), ref: 'synthetic-native-brand', productName: 'Property Predator', primaryColor: '#123b48', accentColor: '#e8a33d' },
    catalog: { items: [], nextCursor: null }, messageChoices: [], readiness, executable: false as const, workspaceId: identity.workspaceId, campaign: PP_FOLLOWUP_CAMPAIGN };
  const detail = { ...sequenceDetail, local: { ...sequenceDetail.local, authorAllowed: true,
    blobStorageKey: `inline:pp.followup-sequence:${sequenceDetail.review.contentSha256}`, brandSnapshotRef: snapshot.brand.ref }, definition, brand: snapshot.brand, valid: true, manifestSha256: '0'.repeat(64), blockers: ['email_not_connected'],
    messages: [], review: { ...sequenceDetail.review, source: { ...sequenceDetail.review.source, system: 'pp.followup-sequence' } } };
  const flows: Pick<PortalFollowupFlowService, 'snapshot' | 'review' | 'save' | 'publish' | 'preview' | 'simulate' | 'message'> = {
    snapshot: async () => { authorise(); return snapshot; }, review: async () => { authorise(); return { ...detail, review: { ...detail.review, approvalStatus: state.published ? 'approved' : 'unrequested' } }; },
    save: async (_identity, _request, value) => { authorise(); state.calls.push('save'); state.input = value; return { contentItemId: sequenceIds.item, contentVersionId: sequenceIds.version, replayed: false }; },
    publish: async () => { authorise(); state.calls.push('publish'); state.published = true; },
    preview: async (_identity, _request, value, inline = {}) => { authorise(); state.calls.push('preview'); const composition = parseFlowComposition(value, inline); return { definition: composition.definition,
      timeline: followupTimeline(composition.definition), blockers: followupActivationBlockers(composition.definition, readiness), messagePreviews: [] }; },
    simulate: async (_identity, _request, value, inline = {}, scenario = 'happy') => { authorise(); state.calls.push('simulate'); const composition = parseFlowComposition(value, inline); return { definition: composition.definition,
      timeline: followupTimeline(composition.definition), blockers: followupActivationBlockers(composition.definition, readiness), messagePreviews: [], simulation: simulateFollowupFlow(composition.definition, readiness, flowSimulationPreset(scenario, composition.definition)) }; },
    message: async (_identity, _request, channel, item, version) => { authorise(); state.calls.push('message'); return { channel, title: 'Sample owned message', contentItemId: item, contentVersionId: version, contentSha256: emailReview.contentSha256,
      payload: { schema: 'propertypredator.email-draft/v1', subject: 'Sample', bodyText: 'Hello {{FIRSTNAME}}' } }; },
  };
  const deps = { kind: 'postgres', secure: true, sessionSecret: SECRET, sessionCookieName: PORTAL_COOKIE, portalBaseUrl: ORIGIN, productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    now: () => now, crm: {}, followupFlows: flows, auth: { resolve: async (token: string) => state.authenticated && token === TOKEN ? identity : null, login: async () => null, revoke: async () => {} },
    requestContext: () => ({ requestId: ids.request, requestHash: Buffer.alloc(32, 1), sourceHash: Buffer.alloc(32, 2) }), abuseHashSecret: SECRET,
    abuse: { admit: async () => { state.leases++; return { allowed: true, leaseHash: Buffer.alloc(32, state.leases), retryAfterSeconds: 0 }; }, complete: async () => { state.completed++; }, assertReady: async () => {}, close: async () => {} } } as unknown as PostgresPortalDeps;
  const saved = (extra: Record<string, string> = {}) => new URLSearchParams({ csrf: portalCsrfToken(SECRET, TOKEN), commandId: ids.command, itemId: sequenceIds.item, versionId: sequenceIds.version, ...extra }).toString();
  const draft = (extra: Record<string, string> = {}) => new URLSearchParams({ csrf: portalCsrfToken(SECRET, TOKEN), commandId: ids.command, contentItemId: '', previousVersionId: '', definition: JSON.stringify(definition), inlineMessages: '{}', simulationCase: 'happy', ...extra }).toString();
  async function request(method: string, suffix = '', body = '', headers: Record<string, string> = {}) {
    const result = { status: 0, headers: {} as Record<string, string>, body: '' };
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method, url: BASE + suffix, headers: { host: 'hq.propertypredator.com', origin: ORIGIN, cookie: `${PORTAL_COOKIE}=${TOKEN}`, 'content-type': 'application/x-www-form-urlencoded', ...headers } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number, values: Record<string, string> = {}) { result.status = status; Object.assign(result.headers, values); }, setHeader(key: string, value: string) { result.headers[key.toLowerCase()] = value; }, end(body = '') { result.body = body; } } as unknown as ServerResponse;
    await handlePortal(req, res, deps); return result;
  }
  return { state, deps, snapshot, detail, request, saved, draft };
}
test('actual PP portal mounts the shared editor with honest disconnected state and private CSP', async () => {
  const f = flowRouterFixture(), page = await f.request('GET', '?new=1'); assert.equal(page.status, 200); assert.match(page.body, /data-sequence-editor/u); assert.match(page.body, /Build now; connect and test before starting/u);
  assert.match(page.body, /\/portal\/channels\/live/u); assert.match(page.headers['content-security-policy']!, /connect-src 'self'/u);
  const script = await f.request('GET', '/editor.js'); assert.equal(script.status, 200); assert.match(script.body, /inlineEditor/u); assert.equal(f.state.leases, f.state.completed);
});

test('real Postgres portal composition forwards the exact optional flow facade to its native route', async () => {
  const f = flowRouterFixture(), facade = f.deps.followupFlows;
  const config = { secure: true, sessionSecret: SECRET, auth: f.deps.auth, crm: f.deps.crm,
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE, portalBaseUrl: ORIGIN, now: () => now,
    abuse: f.deps.abuse!, requestContext: f.deps.requestContext!, abuseHashSecret: 'separate-synthetic-flow-abuse-secret-at-least32' };
  const composed = buildPostgresPortalDeps({ ...config, followupFlows: facade });
  assert.equal(composed.followupFlows, facade);
  Object.assign(f.deps, composed);
  assert.equal((await f.request('GET', '?new=1')).status, 200);
  assert.equal((await f.request('POST', '/preview', f.draft())).status, 200); assert.deepEqual(f.state.calls, ['preview']);
  assert.equal(buildPostgresPortalDeps(config).followupFlows, undefined);
});
test('native save persists through the facade; preview/simulation and Publish invoke no activation', async () => {
  const f = flowRouterFixture(); assert.equal((await f.request('POST', '/preview', f.draft())).status, 200);
  const simulation = await f.request('POST', '/simulate', f.draft({ simulationCase: 'unknown' })); assert.equal(simulation.status, 200); assert.match(simulation.body, /Simulation only/u); assert.match(simulation.body, /Nothing was sent/u);
  const saved = await f.request('POST', '/save', f.draft()); assert.equal(saved.status, 303); assert.match(saved.headers.location!, /\/portal\/follow-ups\?item=/u);
  assert.equal((await f.request('POST', '/publish', f.saved())).status, 200); assert.deepEqual(f.state.calls, ['preview', 'simulate', 'save', 'publish']);
  for (const action of ['start', 'enrol', 'entry-activate', 'resume']) assert.equal((await f.request('POST', `/${action}`, f.saved())).status, 409);
  assert.deepEqual(f.state.calls, ['preview', 'simulate', 'save', 'publish']);
});
test('PP forms reject foreign/null Origin, CSRF, extra identity/destination fields and invalid methods before writes', async () => {
  const f = flowRouterFixture();
  for (const origin of ['null', 'https://app.martinhowardproperty.co.uk', 'https://example.invalid']) assert.equal((await f.request('POST', '/save', f.draft(), { origin })).status, 403);
  assert.equal((await f.request('POST', '/save', f.draft({ csrf: 'forged' }))).status, 403);
  const forged: Record<string, string>[] = [{ workspaceId: ids.prospect }, { recipient: 'forged@example.invalid' }, { brand: 'mhp' }];
  for (const extra of forged) assert.equal((await f.request('POST', '/save', f.draft(extra))).status, 400);
  assert.equal((await f.request('POST', '/save', f.draft() + '&commandId=' + ids.command)).status, 400);
  assert.equal((await f.request('GET', '/save')).status, 405); assert.equal((await f.request('POST', '/save', f.draft(), { 'content-length': '240001' })).status, 413); assert.deepEqual(f.state.calls, []);
});
test('host/profile/session and real owner facade fence PP data; absent service never falls back to mock state', async () => {
  const f = flowRouterFixture(); assert.equal((await f.request('GET', '', '', { host: 'app.martinhowardproperty.co.uk' })).status, 404);
  f.state.authenticated = false; assert.equal((await f.request('GET')).headers.location, '/portal/login'); f.state.authenticated = true;
  f.state.owner = false; assert.equal((await f.request('GET')).status, 403); f.state.owner = true;
  delete f.deps.followupFlows; assert.equal((await f.request('GET')).status, 404); assert.deepEqual(f.state.calls, []);
});
test('exact same-host message reads return safe JSON and reject forged selectors', async () => {
  const f = flowRouterFixture(), result = await f.request('GET', `/message?item=${sequenceIds.item}&version=${sequenceIds.version}&channel=email`);
  assert.equal(result.status, 200); assert.match(result.headers['content-type']!, /application\/json/u); assert.equal(JSON.parse(result.body).payload.subject, 'Sample');
  assert.equal((await f.request('GET', `/message?item=${sequenceIds.item}&version=${sequenceIds.version}&channel=email&workspaceId=${ids.prospect}`)).status, 400);
  assert.deepEqual(f.state.calls, ['message']);
});
