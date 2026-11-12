/** Approval queue and campaign journey routes through the real portal router, with fake area services. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE, portalCsrfToken } from '../src/portal/session.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import { signApprovalRef, type ApprovalRef } from '../src/portal/approval-queue-service.js';
import type { PortalCompanyContentService } from '../src/portal/company-content-service.js';
import type { CompanyContentCatalogItem, CompanyContentExactReview } from '../src/company-content-pg/types.js';

const ORIGIN = 'https://hq.propertypredator.com', TOKEN = 'synthetic-approval-queue-router-session', SECRET = 'synthetic-approval-queue-router-secret-at-least-32';
const workspaceId = 'd975ff66-336a-46c2-b36b-d7095a11af97';
const identity = { sessionToken: TOKEN, userId: '11111111-1111-4111-8111-111111111111', workspaceId, userEmail: 'owner@example.invalid' };

function item(system: string, extra: Partial<CompanyContentCatalogItem> = {}): CompanyContentCatalogItem {
  return { contentItemId: randomUUID(), contentVersionId: randomUUID(), versionNumber: 1, origin: 'generated' as never, kind: 'social_post' as never, title: `Post from ${system}`,
    contentMimeType: 'application/json', source: { system, itemId: 'campaign-post', version: 'v1' }, contentSha256: 'a'.repeat(64), blobSha256: 'b'.repeat(64), brandSha256: 'c'.repeat(64),
    approvalRequestId: randomUUID(), approvalDecisionId: null, approvalStatus: 'pending', approvalStale: false, sourceAttestationId: null, sourceCheckedAt: null, sourceExpiresAt: null,
    sourceFresh: true, publishable: false, createdAt: new Date().toISOString(), ...extra };
}

function fixture() {
  const state = { authenticated: true, calls: [] as string[] };
  const content = item('propertypredator.company-content'), flow = item('pp.followup-sequence', { approvalStatus: 'unrequested', approvalRequestId: null, title: 'Welcome flow' });
  const workspace = { workspaceId, workspaceName: 'PP', snapshotAt: new Date().toISOString(), canWrite: true, canManage: true };
  const companyContent: PortalCompanyContentService = {
    snapshot: async () => ({ ok: true, snapshot: { workspace, catalog: { items: [content, item('relaunch72.seo-blog'), flow], nextCursor: null } } }),
    review: async () => ({ ok: true, snapshot: { workspace, review: { ...content, isLatest: true, canonicalContent: '{}', canonicalByteLength: 2, email: null,
      social: { publicationCopy: 'Exact <copy> for review', platform: 'LinkedIn', artworkInstructions: null, ctaUrl: null } } as unknown as CompanyContentExactReview } }),
    requestApproval: async () => { state.calls.push('requestApproval'); throw new Error('not from the queue'); },
    decideApproval: async (_w, input) => { state.calls.push(`decideApproval:${input.decision}`); return { ok: true, disposition: 'applied', approvalDecisionId: randomUUID(), approvalRequestId: input.approvalRequestId, decision: input.decision } as never; },
    decideExactReviewedApproval: async (_w, input) => { state.calls.push('decideExactReviewedApproval'); return { ok: true, disposition: 'applied', approvalDecisionId: randomUUID(), approvalRequestId: input.approvalRequestId, decision: 'approved' } as never; },
  };
  const refuse = (name: string) => async () => { state.calls.push(name); throw new Error(`${name} must never be called by the queue`); };
  const followupFlows = { snapshot: async () => ({ catalog: { items: [flow], nextCursor: null } }), publish: async () => { state.calls.push('publish'); },
    review: refuse('review'), save: refuse('save'), preview: refuse('preview'), simulate: refuse('simulate'), message: refuse('message') };
  // Journey: fake engine and studio exposing only the readers the journey page uses.
  const campaignId = randomUUID(), versionId = randomUUID(), setId = randomUUID();
  const utmCampaign = `spring-viewings-${campaignId.replace(/-/gu, '').slice(0, 8)}`, utmContent = `concept-1-cs${versionId.replace(/-/gu, '').slice(0, 8)}`;
  const engine = { listBrands: async () => [{ id: workspaceId, name: 'Property Predator' }], getBrand: async () => ({ id: workspaceId, name: 'Property Predator' }),
    campaignCreatorsReady: true, creators: () => ({ list: async () => [{ id: campaignId, brief: { kind: 'acquisition', name: 'Spring viewings' }, createdAt: new Date().toISOString(),
    version: { content: { title: 'Spring', summary: '', concepts: [{ name: 'Busy landlords' }] } } }] }) };
  const studio = {
    overview: async () => ({ sets: [{ set: { id: setId, createdAt: new Date().toISOString() }, versionCount: 1, approvedCount: 1 }] }),
    getSet: async () => ({ record: { set: { id: setId }, versions: [{ id: versionId, concept: { headline: 'Fill voids faster' }, render: { mime: 'image/jpeg', sha256: 'e'.repeat(64) } }],
      handoffs: [{ route: 'tracked_link', versionId, trackedLink: { utmCampaign, utmContent, channel: 'linkedin', concept: 0, url: 'https://example.invalid' } }] } }),
    campaignOutcomes: async () => ({ utmCampaign, limits: [], read: { utmCampaign, readAt: new Date().toISOString(), qualifiedMapped: false, buckets: [
      { utmContent, leads: 3, qualified: 1, booked: 1, sold: 0, customers: 0, subscriptionsCancelled: 0, firstAt: null, lastAt: null },
      { utmContent: '', leads: 2, qualified: 0, booked: 0, sold: 0, customers: 0, subscriptionsCancelled: 0, firstAt: null, lastAt: null }] } }),
    enquiries: async () => ({ touches: 5 }),
  };
  const seoBlog = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => engine, creativeFor: () => studio, socialCallback: async () => null };
  const deps = { kind: 'postgres', secure: true, sessionSecret: SECRET, sessionCookieName: PORTAL_COOKIE, portalBaseUrl: ORIGIN, productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    crm: {}, companyContent, followupFlows, seoBlog,
    auth: { resolve: async (token: string) => state.authenticated && token === TOKEN ? identity : null, login: async () => null, revoke: async () => {} },
    requestContext: () => ({ requestId: randomUUID(), requestHash: Buffer.alloc(32, 1), sourceHash: Buffer.alloc(32, 2) }), abuseHashSecret: SECRET,
    abuse: { admit: async () => ({ allowed: true, leaseHash: Buffer.alloc(32, 3), retryAfterSeconds: 0 }), complete: async () => {}, assertReady: async () => {}, close: async () => {} } } as unknown as PostgresPortalDeps;
  async function request(method: string, path: string, body = '', headers: Record<string, string> = {}) {
    const result = { status: 0, headers: {} as Record<string, string>, body: '' };
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method, url: path, headers: { host: 'hq.propertypredator.com', origin: ORIGIN, cookie: `${PORTAL_COOKIE}=${TOKEN}`,
      'content-type': 'application/x-www-form-urlencoded', ...headers } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number, values: Record<string, string> = {}) { result.status = status; Object.assign(result.headers, values); },
      setHeader(key: string, value: string) { result.headers[key.toLowerCase()] = value; }, end(text = '') { result.body = String(text); } } as unknown as ServerResponse;
    await handlePortal(req, res, deps); return result;
  }
  const refs = (html: string) => [...html.matchAll(/name="ref" value="([^"]+)"/gu)].map((m) => m[1]!.replace(/&#39;/gu, "'"));
  const form = (fields: Record<string, string | string[]>) => {
    const p = new URLSearchParams({ _csrf: portalCsrfToken(SECRET, TOKEN), ...('brand' in fields ? {} : { brand: workspaceId }) });
    for (const [k, v] of Object.entries(fields)) for (const value of [v].flat()) p.append(k, value);
    return p.toString();
  };
  return { state, request, refs, form, content, flow };
}

test('the queue page lists each area once, escapes content and sends a strict CSP; unauthenticated users are sent to sign in', async () => {
  const f = fixture(), page = await f.request('GET', '/portal/approvals');
  assert.equal(page.status, 200);
  assert.match(page.body, /Waiting for your approval/); assert.match(page.body, /does not give permission to contact anyone/);
  assert.match(page.body, /Exact &lt;copy&gt; for review/); assert.doesNotMatch(page.body, /Exact <copy>/);
  assert.match(page.body, /Welcome flow/); assert.doesNotMatch(page.body, /Post from relaunch72\.seo-blog/, 'SEO-owned content is never listed as general content');
  assert.equal((page.body.match(/Post from pp\.followup-sequence|Welcome flow/gu) ?? []).length, 1, 'the flow appears once, under follow-up flows');
  assert.match(page.headers['content-security-policy']!, /img-src 'self'/); assert.match(page.headers['content-security-policy']!, /frame-ancestors 'none'/);
  assert.ok(page.body.includes(`href="/portal/campaign-journey?brand=${workspaceId}"`), 'results open for the same business');
  f.state.authenticated = false;
  const anonymous = await f.request('GET', '/portal/approvals');
  assert.equal(anonymous.status, 303); assert.equal(anonymous.headers.location, '/portal/login');
  assert.deepEqual(f.state.calls, []);
});

test('POSTs need the exact origin, host, same-origin fetch, form encoding and CSRF before any decision is attempted', async () => {
  const f = fixture(), [contentRef] = f.refs((await f.request('GET', '/portal/approvals')).body);
  const good = f.form({ ref: contentRef!, action: 'approve' });
  assert.equal((await f.request('POST', '/portal/approvals/decide', good, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('POST', '/portal/approvals/decide', good, { origin: '' })).status, 403);
  assert.equal((await f.request('POST', '/portal/approvals/decide', good, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.request('POST', '/portal/approvals/decide', good, { host: 'other.example' })).status, 404);
  assert.equal((await f.request('POST', '/portal/approvals/decide?x=1', good)).status, 403);
  assert.equal((await f.request('POST', '/portal/approvals/decide', good, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await f.request('POST', '/portal/approvals/decide', good.replace(/_csrf=[^&]+/u, '_csrf=forged'))).status, 403);
  assert.equal((await f.request('GET', '/portal/approvals/decide')).status, 405);
  assert.deepEqual(f.state.calls, [], 'nothing reached a service');
});

test('a single decision goes through the item path and returns a signed notice; foreign refs are refused', async () => {
  const f = fixture(), page = (await f.request('GET', '/portal/approvals')).body;
  const contentRef = f.refs(page).find((r) => r.length > 0)!;
  const approved = await f.request('POST', '/portal/approvals/decide', f.form({ ref: contentRef, action: 'approve' }));
  assert.equal(approved.status, 303); assert.match(approved.headers.location!, new RegExp(`^/portal/approvals\\?brand=${workspaceId}&n=`, 'u'));
  const shown = await f.request('GET', approved.headers.location!); assert.match(shown.body, /Approved\. Posting is still a separate step/);
  const refused = await f.request('POST', '/portal/approvals/decide', f.form({ ref: contentRef, action: 'refuse' }));
  assert.equal(refused.status, 303);
  assert.deepEqual(f.state.calls, ['decideExactReviewedApproval', 'decideApproval:rejected']);
  const forged = signApprovalRef(SECRET, 'some-other-session', { k: 'content', b: workspaceId, ids: {}, x: {}, c: randomUUID(), d: randomUUID(), t: Date.now(), n: 'x' } satisfies ApprovalRef);
  assert.equal((await f.request('POST', '/portal/approvals/decide', f.form({ ref: forged, action: 'approve' }))).status, 409);
  assert.equal((await f.request('POST', '/portal/approvals/decide', f.form({ ref: [contentRef, contentRef], action: 'approve' }))).status, 400);
  assert.equal((await f.request('POST', '/portal/approvals/decide', f.form({ ref: contentRef, action: 'send' }))).status, 400);
  assert.equal((await f.request('GET', '/portal/approvals?n=forged.notice')).body.includes('forged'), false, 'an unsigned notice is ignored');
  assert.equal(f.state.calls.length, 2);
});

test('batch approves each selected item through its own path, reports per item, and refuses more than 20', async () => {
  const f = fixture(), page = (await f.request('GET', '/portal/approvals')).body;
  const flowRef = [...page.matchAll(/name="ref" value="([^"]+)" form="aq-batch"/gu)].map((m) => m[1]!);
  assert.equal(flowRef.length, 1, 'only the flow is batchable; general content stays one at a time');
  const contentRef = f.refs(page).find((r) => !flowRef.includes(r))!;
  const result = await f.request('POST', '/portal/approvals/batch', f.form({ ref: [flowRef[0]!, contentRef] }));
  assert.equal(result.status, 200); assert.match(result.body, /1 of 2 done/);
  assert.match(result.body, /Welcome flow<\/strong>: Flow and its messages published\. Nothing was started/);
  assert.match(result.body, /Approve this one on its own/);
  assert.deepEqual(f.state.calls, ['publish'], 'no enrol, start, send or other flow method was called');
  const tooMany = Array.from({ length: 21 }, () => signApprovalRef(SECRET, TOKEN, { k: 'flow', b: workspaceId, ids: {}, x: {}, c: randomUUID(), d: randomUUID(), t: Date.now(), n: 'x' }));
  assert.equal((await f.request('POST', '/portal/approvals/batch', f.form({ ref: tooMany }))).status, 400);
  assert.equal((await f.request('POST', '/portal/approvals/batch', f.form({}))).status, 400);
  assert.deepEqual(f.state.calls, ['publish']);
});

test('campaign journey shows campaign → asset counts with an unknown row and the not-proof labels', async () => {
  const f = fixture(), page = await f.request('GET', '/portal/campaign-journey');
  assert.equal(page.status, 200);
  assert.match(page.body, /Spring viewings/); assert.match(page.body, /Fill voids faster · linkedin/); assert.match(page.body, /Concept 1: Busy landlords/);
  assert.match(page.body, /data-label="Leads">3</); assert.match(page.body, /Unknown asset/); assert.match(page.body, /data-label="Leads">5</, 'campaign total includes the unknown asset row');
  assert.match(page.body, /observations, not proof/); assert.match(page.body, /only won opportunities count as qualified/);
  assert.match(page.body, /Unknown source/); assert.match(page.body, /5 enquiries have a campaign tag/); assert.match(page.body, /it is not proof the article brought them/);
  assert.equal((await f.request('POST', '/portal/campaign-journey', '')).status, 405);
  assert.deepEqual(f.state.calls, []);
});
