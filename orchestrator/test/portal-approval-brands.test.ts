/**
 * One queue for every business: the brand a page or a decision is for is always resolved against the brand
 * workspaces the signed-in user manages, and is part of every signed item reference.
 * Real SEO engine with the in-memory store (real membership checks); no model, network or database call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApprovalQueueError, ApprovalQueueService, BRAND_ACCOUNT, BRAND_ALL, selectApprovalBrand, signApprovalRef, verifyApprovalRef,
  type ApprovalItem, type ApprovalQueueDependencies, type ApprovalRef, type BrandSelection } from '../src/portal/approval-queue-service.js';
import { ApprovalRouteError, assertStrictOrigin } from '../src/portal/approval-queue-router.js';
import { renderApprovalOverviewBody, renderApprovalQueueBody, renderBrandPicker, renderCampaignJourneyBody } from '../src/portal/approval-queue-view.js';
import { CampaignJourneyService } from '../src/portal/campaign-journey-service.js';
import { CENTRAL_CONTENT_COOKIE, CENTRAL_CONTENT_ORIGIN, createCentralContentMount } from '../src/portal/central-content-mount.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE, portalCsrfToken } from '../src/portal/session.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import type { PortalSeoBlogService } from '../src/portal/seo-blog-service.js';
import type { PortalSessionIdentity } from '../src/portal/auth-service.js';
import type { PortalCompanyContentService } from '../src/portal/company-content-service.js';
import type { CompanyContentCatalogItem, CompanyContentExactReview } from '../src/company-content-pg/types.js';
import type { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { SeoBlogError } from '../src/seo-blog/types.js';
import { OWNER, STRANGER } from './seo-blog-fixtures.js';
import { websiteFixture } from './seo-blog-website-fixtures.js';

const SECRET = 'b'.repeat(48), TOKEN = 'synthetic-all-brands-session';
const PP_ORIGIN = 'https://hq.propertypredator.com';
const who = (workspaceId: string, userId = OWNER.userId): PortalSessionIdentity => ({ sessionToken: TOKEN, userId, workspaceId, userEmail: 'owner@example.invalid' });
const seoService = (engine: SeoBlogEngine): PortalSeoBlogService => ({ generation: 'live', research: 'live', social: 'unavailable', engineFor: () => engine, socialCallback: async () => null, creativeFor: () => null });
const queue = (deps: Partial<ApprovalQueueDependencies>) => new ApprovalQueueService({ sessionSecret: SECRET, ...deps });
const refOf = (item: ApprovalItem): ApprovalRef => verifyApprovalRef(SECRET, TOKEN, item.ref, Date.now())!;
const NOT_FOUND = (error: unknown) => error instanceof ApprovalQueueError && error.status === 404 && /That business was not found/.test(error.message);

/** Two businesses for one owner: "Harbour" has an article waiting; the second has a proposed topic plan. Returned in name order. */
async function twoBrands(secondName = 'Zephyr <b>Lets</b> & Co') {
  const f = await websiteFixture();
  const { brand: second } = await f.h.engine.createBrand(OWNER, { commandId: randomUUID(), name: secondName, website: null });
  const [source] = await f.h.engine.listPlans(OWNER, f.brand.id);
  // An owner-led plan (no programme provenance), so accepting it depends on nothing in the first business.
  const planId = randomUUID(), briefs = source!.briefs.map(({ programme: _p, ...b }) => ({ ...b, id: randomUUID(), planId, brandId: second.id, slug: `${b.slug}-${planId.slice(0, 6)}`, status: 'planned' as const, articleId: null }));
  for (const brief of briefs) await f.h.store.saveBrief(brief);
  const { programme: _programme, ...plan } = source!.plan;
  await f.h.store.savePlan({ ...plan, id: planId, brandId: second.id, topic: 'Zephyr topics', status: 'proposed', acceptedAt: null, briefIds: briefs.map((b) => b.id) });
  return { f, engine: f.h.engine, a: f.brand, b: second, planId, articleId: f.articleId };
}

test('brand resolution: a member gets their brand; a non-member, an unknown id and a malformed id are all refused the same way', async () => {
  const { engine, a, b } = await twoBrands();
  const seo = seoService(engine), owner = who(a.id);
  const chosen = await selectApprovalBrand(seo, owner, 'req', b.id);
  assert.equal(chosen.view, 'brand'); assert.deepEqual(chosen.selected, { id: b.id, name: b.name });
  assert.deepEqual(chosen.brands.map((x) => x.id), [a.id, b.id], 'the list is the engine’s managed-brand list');
  assert.equal((await selectApprovalBrand(seo, owner, 'req', b.id.toUpperCase())).selected!.id, b.id, 'case does not matter; the id returned is the stored one');
  // Non-member: the brand exists, but this user does not manage it.
  await assert.rejects(selectApprovalBrand(seo, who(a.id, STRANGER.userId), 'req', a.id), NOT_FOUND);
  // Unknown id, and ids that are not ids at all.
  await assert.rejects(selectApprovalBrand(seo, owner, 'req', randomUUID()), NOT_FOUND);
  for (const bad of ['not-a-uuid', `${a.id}x`, ` ${a.id}'--`, '../etc', `${a.id},${b.id}`, '<script>', 'ALL', '0']) await assert.rejects(selectApprovalBrand(seo, owner, 'req', bad), NOT_FOUND, bad);
  // Membership is read each time, not remembered.
  f_revoke: {
    const { f, a: mine, b: other } = await twoBrands();
    const service = seoService(f.h.engine);
    assert.equal((await selectApprovalBrand(service, who(mine.id), 'req', other.id)).selected!.id, other.id);
    f.h.store.revoke(OWNER.userId, other.id);
    await assert.rejects(selectApprovalBrand(service, who(mine.id), 'req', other.id), NOT_FOUND);
    break f_revoke;
  }
});

test('default brand: the signed-in workspace when it is a brand, otherwise the first brand managed, otherwise none', async () => {
  const { engine, a, b } = await twoBrands();
  const seo = seoService(engine);
  assert.equal((await selectApprovalBrand(seo, who(b.id), 'req', null)).selected!.id, b.id, 'session workspace is a brand');
  assert.equal((await selectApprovalBrand(seo, who(a.id), 'req', '')).selected!.id, a.id);
  const elsewhere = await selectApprovalBrand(seo, who(randomUUID()), 'req', undefined);
  assert.equal(elsewhere.selected!.id, a.id, 'first managed brand, in the engine’s (name) order'); assert.equal(elsewhere.view, 'brand');
  const stranger = await selectApprovalBrand(seo, who(a.id, STRANGER.userId), 'req', null);
  assert.equal(stranger.selected, null); assert.equal(stranger.view, 'account'); assert.deepEqual(stranger.brands, []);
  const noSeo = await selectApprovalBrand(undefined, who(a.id), 'req', null);
  assert.equal(noSeo.selected, null); assert.equal(noSeo.canAdd, false);
  assert.equal((await selectApprovalBrand(seo, who(a.id), 'req', BRAND_ALL)).view, 'all');
  assert.equal((await selectApprovalBrand(seo, who(a.id, STRANGER.userId), 'req', BRAND_ALL)).view, 'account', 'no businesses, so nothing to list');
  assert.equal((await selectApprovalBrand(seo, who(a.id), 'req', BRAND_ACCOUNT)).selected, null);
  // A failing membership read is an error, never "no brands" and never a default.
  const broken = { listBrands: async () => { throw new Error('database unavailable'); } } as unknown as SeoBlogEngine;
  await assert.rejects(selectApprovalBrand(seoService(broken), who(a.id), 'req', null), /database unavailable/);
});

test('each business has its own queue; every item is signed for its business', async () => {
  const { engine, a, b, planId, articleId } = await twoBrands();
  const q = queue({ seoBlog: seoService(engine) }), owner = who(a.id);
  const first = await q.list(owner, 'req'), second = await q.list(owner, 'req', b.id);
  assert.equal(first.selection.selected!.id, a.id); assert.equal(first.brandKey, a.id);
  const article = first.sections.flatMap((s) => s.items).find((i) => i.kind === 'article')!;
  assert.equal(refOf(article).b, a.id); assert.equal(refOf(article).ids.articleId, articleId);
  assert.match(article.editHref, new RegExp(`/portal/seo-blog/b/${a.id}/articles/`));
  assert.equal(second.brandKey, b.id);
  const items = second.sections.flatMap((s) => s.items);
  assert.deepEqual(items.map((i) => i.kind), ['plan'], 'the other business shows only its own items');
  assert.equal(refOf(items[0]!).b, b.id); assert.equal(refOf(items[0]!).ids.planId, planId);
  assert.match(items[0]!.editHref, new RegExp(`/portal/seo-blog/b/${b.id}/topics$`));
  await assert.rejects(q.list(owner, 'req', randomUUID()), NOT_FOUND);
  await assert.rejects(q.list(who(a.id, STRANGER.userId), 'req', a.id), NOT_FOUND);
  await assert.rejects(q.list(owner, 'req', BRAND_ALL), /Choose one business/);
});

test('the business is part of what is signed: it cannot be changed, and an item is never approved under another business', async () => {
  const { engine, a, b, articleId } = await twoBrands();
  const q = queue({ seoBlog: seoService(engine) }), owner = who(a.id);
  const article = (await q.list(owner, 'req')).sections.flatMap((s) => s.items).find((i) => i.kind === 'article')!;
  const ref = refOf(article);
  // Changing the business in the browser breaks the signature.
  const [, signature] = article.ref.split('.');
  const moved = Buffer.from(JSON.stringify({ ...ref, b: b.id })).toString('base64url');
  assert.equal(verifyApprovalRef(SECRET, TOKEN, `${moved}.${signature}`, Date.now()), null);
  // A reference with no business, or one that is not an id, is never accepted (pages from before this change must be refreshed).
  const { b: _dropped, ...withoutBrand } = ref;
  for (const bad of [withoutBrand, { ...ref, b: '' }, { ...ref, b: 'all' }, { ...ref, b: 7 }]) {
    assert.equal(verifyApprovalRef(SECRET, TOKEN, signApprovalRef(SECRET, TOKEN, bad as unknown as ApprovalRef), Date.now()), null);
  }
  // Even a correctly signed reference naming the other business cannot reach this business's article.
  const unapproved = async () => (await engine.getArticle(OWNER, a.id, articleId)).article.approval;
  await assert.rejects(q.decide(owner, 'req', { ...ref, b: b.id }, 'approve', false), /not found|changed since you looked/);
  assert.equal(await unapproved(), null);
  // Nor can a business the user does not manage, or one that does not exist.
  await assert.rejects(q.decide(who(a.id, STRANGER.userId), 'req', ref, 'approve', false), NOT_FOUND);
  await assert.rejects(q.decide(owner, 'req', { ...ref, b: randomUUID() }, 'approve', false), NOT_FOUND);
  await assert.rejects(q.decide(owner, 'req', { ...ref, b: 'not-a-uuid' }, 'approve', false), /changed since you looked/);
  assert.equal(await unapproved(), null);
  // The owner can approve it for its own business from a session signed in to a different business.
  assert.match(await q.decide(who(b.id), 'req', ref, 'approve', false), /^Approved/);
  assert.equal((await unapproved())!.versionId, ref.ids.versionId);
  assert.equal((await engine.activity(OWNER, b.id)).some((x) => x.kind === 'article.approved'), false, 'nothing was recorded against the other business');
  // Membership is re-checked at the decision, not only when the page was made.
  const fresh = await twoBrands();
  const stale = refOf((await queue({ seoBlog: seoService(fresh.engine) }).list(who(fresh.a.id), 'req', fresh.b.id)).sections[0]!.items[0]!);
  fresh.f.h.store.revoke(OWNER.userId, fresh.b.id);
  await assert.rejects(queue({ seoBlog: seoService(fresh.engine) }).decide(who(fresh.a.id), 'req', stale, 'approve', false), NOT_FOUND);
  assert.equal((await fresh.f.h.store.getPlan(fresh.b.id, fresh.planId))!.status, 'proposed');
});

const catalogItem = (extra: Partial<CompanyContentCatalogItem> = {}): CompanyContentCatalogItem => ({
  contentItemId: randomUUID(), contentVersionId: randomUUID(), versionNumber: 1, origin: 'generated' as never, kind: 'social_post' as never, title: 'A post in Your content',
  contentMimeType: 'application/json', source: { system: 'propertypredator.company-content', itemId: 'campaign-post', version: 'v1' }, contentSha256: 'a'.repeat(64), blobSha256: 'b'.repeat(64), brandSha256: 'c'.repeat(64),
  approvalRequestId: randomUUID(), approvalDecisionId: null, approvalStatus: 'pending', approvalStale: false, sourceAttestationId: null, sourceCheckedAt: null, sourceExpiresAt: null, sourceFresh: true,
  publishable: false, createdAt: new Date().toISOString(), ...extra });
function contentFake() {
  const calls: string[] = [], content = catalogItem();
  const workspace = { workspaceId: 'w', workspaceName: 'W', snapshotAt: new Date().toISOString(), canWrite: true, canManage: true };
  const service: PortalCompanyContentService = {
    snapshot: async () => ({ ok: true, snapshot: { workspace, catalog: { items: [content], nextCursor: null } } }),
    review: async () => ({ ok: true, snapshot: { workspace, review: { ...content, isLatest: true, canonicalContent: '{}', canonicalByteLength: 2, email: null,
      social: { publicationCopy: 'Exact copy', platform: 'LinkedIn', artworkInstructions: null, ctaUrl: null } } as unknown as CompanyContentExactReview } }),
    requestApproval: async () => { throw new Error('never from the queue'); },
    decideApproval: async (_w, input) => { calls.push(`decideApproval:${input.decision}`); return { ok: true, disposition: 'applied', approvalDecisionId: randomUUID(), approvalRequestId: input.approvalRequestId, decision: input.decision } as never; },
    decideExactReviewedApproval: async (_w, input) => { calls.push('decideExactReviewedApproval'); return { ok: true, disposition: 'applied', approvalDecisionId: randomUUID(), approvalRequestId: input.approvalRequestId, decision: 'approved' } as never; },
  };
  return { service, calls, content };
}

test('follow-up flows and Your content stay with the signed-in workspace: never listed, counted or decided under another business', async () => {
  const { engine, a, b } = await twoBrands();
  const content = contentFake();
  const flow = catalogItem({ title: 'Welcome flow', approvalStatus: 'unrequested', approvalRequestId: null, source: { system: 'pp.followup-sequence', itemId: 'flow', version: 'v1' } });
  const published: unknown[] = [];
  const flows = { snapshot: async () => ({ catalog: { items: [flow], nextCursor: null } }), publish: async (...args: unknown[]) => { published.push(args); } } as unknown as NonNullable<ApprovalQueueDependencies['flows']>;
  const q = queue({ seoBlog: seoService(engine), companyContent: content.service, flows, flowsAvailable: true }), owner = who(a.id);
  const kinds = async (requested?: string) => (await q.list(owner, 'req', requested)).sections.map((s) => s.kind);
  const seoOnly = (await queue({ seoBlog: seoService(engine) }).list(owner, 'req')).sections.map((s) => s.kind);
  assert.ok(seoOnly.includes('article')); assert.ok(!seoOnly.includes('content') && !seoOnly.includes('flow'));
  assert.deepEqual((await kinds()).sort(), [...seoOnly, 'content', 'flow'].sort(), 'the signed-in business shows everything it owns');
  assert.deepEqual(await kinds(b.id), ['plan'], 'another business shows SEO items only');
  const mine = await q.list(owner, 'req'), other = await q.list(owner, 'req', b.id);
  assert.equal(mine.sessionSections, true); assert.equal(other.sessionSections, false);
  const contentRef = refOf(mine.sections.find((s) => s.kind === 'content')!.items[0]!), flowRef = refOf(mine.sections.find((s) => s.kind === 'flow')!.items[0]!);
  assert.equal(contentRef.b, a.id); assert.equal(flowRef.b, a.id, 'signed for the workspace the session is in');
  // Renaming the business on a flow or content reference is refused before the area is touched.
  await assert.rejects(q.decide(owner, 'req', { ...contentRef, b: b.id }, 'approve', false), /changed since you looked/);
  await assert.rejects(q.decide(owner, 'req', { ...flowRef, b: b.id }, 'approve', false), /changed since you looked/);
  // The same reference used from a session signed in to another workspace is refused too.
  await assert.rejects(q.decide(who(b.id), 'req', flowRef, 'approve', false), /changed since you looked/);
  assert.deepEqual(content.calls, []); assert.deepEqual(published, []);
  assert.match(await q.decide(owner, 'req', flowRef, 'approve', false), /Nothing was started/);
  assert.equal(published.length, 1);
  // A session whose workspace is not a brand keeps its own view, and it is not mixed into a business's queue.
  const outside = who(randomUUID());
  assert.deepEqual((await q.list(outside, 'req')).sections.map((s) => s.kind), seoOnly, 'default is the first business, SEO items only');
  const account = await q.list(outside, 'req', BRAND_ACCOUNT);
  assert.deepEqual(account.sections.map((s) => s.kind), ['content', 'flow']); assert.equal(account.brandKey, outside.workspaceId);
});

test('All businesses: exact counts per business, unknown is never shown as zero, and nothing can be approved from the list', async () => {
  const { engine, a, b } = await twoBrands('Zephyr <b>Lets</b>');
  const q = queue({ seoBlog: seoService(engine) }), owner = who(a.id);
  const overview = await q.overview(owner, 'req');
  assert.equal(overview.selection.view, 'all');
  const own = await q.list(owner, 'req', a.id), n = own.total;
  assert.ok(n >= 1);
  assert.deepEqual(overview.rows.map((r) => [r.brand.id, r.total, r.ready, r.counted]), [[a.id, n, own.ready, true], [b.id, 1, 1, true]], 'the same numbers each business’s own page shows');
  const html = renderApprovalOverviewBody(overview, { actionCentre: true });
  assert.match(html, /<h1>All businesses<\/h1>/); assert.ok(html.includes(`${n + 1} items waiting across 2 businesses.`));
  assert.ok(html.includes(`<strong>${n} waiting</strong> · ${own.ready} ready to approve now`)); assert.match(html, /<strong>1 waiting<\/strong> · 1 ready to approve now/);
  assert.ok(html.includes(`href="/portal/approvals?brand=${a.id}">Open Harbour</a>`)); assert.ok(html.includes(`href="/portal/approvals?brand=${b.id}">Open Zephyr &lt;b&gt;Lets&lt;/b&gt;</a>`));
  assert.doesNotMatch(html, /<form|name="ref"|Approve selected/, 'no cross-business approval');
  assert.doesNotMatch(html, /<b>Lets<\/b>/);
  // A business whose queue cannot be read is "unknown".
  const flaky = { ...seoService(engine), engineFor: () => new Proxy(engine, { get(target, key, receiver) {
    if (key === 'listArticles') return async (actor: { userId: string }, brandId: string) => { if (brandId === b.id) throw new Error('timeout'); return target.listArticles(actor, brandId); };
    const value = Reflect.get(target, key, receiver); return typeof value === 'function' ? value.bind(target) : value;
  } }) } as PortalSeoBlogService;
  const partial = await queue({ seoBlog: flaky }).overview(owner, 'req');
  assert.deepEqual(partial.rows.map((r) => r.total), [n, null]);
  const partialHtml = renderApprovalOverviewBody(partial, { actionCentre: false });
  assert.match(partialHtml, /could not be counted just now\. That is unknown, not zero/); assert.ok(partialHtml.includes(`${n} item${n === 1 ? '' : 's'} waiting across 1 business that could be counted`));
  // Beyond the cap a business is listed but not counted.
  const many: BrandSelection = { ...overview.selection };
  const capped = renderApprovalOverviewBody({ selection: many, rows: Array.from({ length: 9 }, (_, i) => ({ brand: { id: randomUUID(), name: `Business ${i + 1}` }, total: i < 8 ? 0 : null, ready: i < 8 ? 0 : null, counted: i < 8 })) }, { actionCentre: false });
  assert.match(capped, /Only the first 8 businesses are counted here/); assert.match(capped, /Open it to see what is waiting\./); assert.match(capped, /Nothing is waiting\./);
});

test('the Business picker: names are escaped, the current one is marked, the count is only for the business shown', () => {
  const a = { id: randomUUID(), name: 'Property Predator' }, b = { id: randomUUID(), name: 'Tom & "Jerry" <img src=x onerror=alert(1)>' };
  const selection: BrandSelection = { brands: [a, b], selected: a, view: 'brand', sessionWorkspaceId: a.id, canAdd: true };
  const html = renderBrandPicker(selection, { route: '/portal/approvals', waiting: 7, all: true, addHref: '/portal/seo-blog#add-business' });
  assert.match(html, /^<nav class="aq-brands" aria-label="Business"><span class="aq-brands-label">Business<\/span><div class="aq-brands-row">/);
  assert.ok(html.includes(`<a class="aq-brand" href="/portal/approvals?brand=${a.id}" aria-current="page">Property Predator<span class="aq-count" title="7 waiting">7<span class="aq-sr"> waiting</span></span></a>`));
  assert.ok(html.includes(`<a class="aq-brand" href="/portal/approvals?brand=${b.id}">Tom &amp; &quot;Jerry&quot; &lt;img src=x onerror=alert(1)&gt;</a>`), 'no count is guessed for a business that was not read');
  assert.doesNotMatch(html, /<img|onerror=alert\(1\)>/);
  assert.ok(html.includes('href="/portal/approvals?brand=all">All businesses</a>')); assert.ok(html.includes('href="/portal/seo-blog#add-business">Add a business</a>'));
  assert.doesNotMatch(html, /Signed-in account/, 'only offered when the signed-in workspace is not one of the businesses');
  assert.doesNotMatch(renderBrandPicker(selection, { route: '/portal/approvals', waiting: 0, all: true }), /aq-count|Add a business/, 'nothing waiting shows no badge');
  assert.match(renderBrandPicker({ ...selection, sessionWorkspaceId: randomUUID() }, { route: '/portal/approvals', all: true }), /brand=account">Signed-in account<\/a>/);
  // One business: no "All businesses". Campaign results: no "All businesses" and no count.
  assert.doesNotMatch(renderBrandPicker({ ...selection, brands: [a] }, { route: '/portal/approvals', all: true }), /All businesses/);
  const results = renderBrandPicker(selection, { route: '/portal/campaign-journey' });
  assert.ok(results.includes(`href="/portal/campaign-journey?brand=${b.id}"`)); assert.doesNotMatch(results, /All businesses|aq-count/);
  // Many businesses: one labelled select, still escaped, still a plain GET form.
  const lots = Array.from({ length: 7 }, (_, i) => ({ id: randomUUID(), name: i === 0 ? '<i>First</i>' : `Business ${i}` }));
  const select = renderBrandPicker({ ...selection, brands: lots, selected: lots[1]! }, { route: '/portal/approvals', waiting: 3, all: true });
  assert.match(select, /<form method="get" action="\/portal\/approvals"><label class="aq-brands-label" for="aq-business">Business<\/label><select id="aq-business" name="brand">/);
  assert.ok(select.includes(`<option value="${lots[1]!.id}" selected>Business 1 (3 waiting)</option>`)); assert.match(select, /&lt;i&gt;First&lt;\/i&gt;/); assert.match(select, /<option value="all">All businesses<\/option>/);
  // No businesses: an invitation to add one where that is possible, otherwise nothing.
  assert.match(renderBrandPicker({ ...selection, brands: [], selected: null, view: 'account' }, { route: '/portal/approvals', addHref: '/portal/seo-blog#add-business' }), /No business is set up for content yet/);
  assert.equal(renderBrandPicker({ ...selection, brands: [], selected: null, view: 'account', canAdd: false }, { route: '/portal/approvals', addHref: '/portal/seo-blog#add-business' }), '');
});

// ─── Through the real portal router ────────────────────────────────────────

async function portal(options: { central?: boolean } = {}) {
  const t = await twoBrands('Zephyr <b>Lets</b>');
  const state = { calls: [] as string[], authorised: true };
  const content = contentFake();
  const identity = who(t.a.id);
  const journeyEngine = new Proxy(t.engine, { get(target, key, receiver) {
    if (key === 'campaignCreatorsReady') return true;
    if (key === 'creators') return () => ({ list: async (_user: string, brandId: string) => { state.calls.push(`creators.list:${brandId}`); return []; } });
    const value = Reflect.get(target, key, receiver); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const studio = { overview: async (_user: string, brandId: string) => { state.calls.push(`studio.overview:${brandId}`); return { sets: [] }; }, enquiries: async () => ({ touches: 0 }) };
  const seoBlog = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => journeyEngine, creativeFor: () => studio, socialCallback: async () => null };
  const base = { kind: 'postgres', secure: true, sessionSecret: SECRET, sessionCookieName: PORTAL_COOKIE, portalBaseUrl: PP_ORIGIN, productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    crm: {}, companyContent: content.service, seoBlog, operatorActions: {},
    auth: { resolve: async (token: string) => token === TOKEN ? identity : null, login: async () => null, revoke: async () => {} },
    requestContext: () => ({ requestId: randomUUID(), requestHash: Buffer.alloc(32, 1), sourceHash: Buffer.alloc(32, 2) }) } as unknown as PostgresPortalDeps;
  const mount = options.central ? createCentralContentMount({ origin: CENTRAL_CONTENT_ORIGIN, portal: base, authorize: async () => state.authorised }) : null;
  const host = options.central ? 'app.relaunch72.com' : 'hq.propertypredator.com', origin = options.central ? CENTRAL_CONTENT_ORIGIN : PP_ORIGIN;
  const cookie = `${options.central ? CENTRAL_CONTENT_COOKIE : PORTAL_COOKIE}=${TOKEN}`;
  async function request(method: string, path: string, body = '', headers: Record<string, string> = {}) {
    const result = { status: 0, headers: {} as Record<string, string>, body: '' };
    const all = { host, origin, cookie, 'content-type': 'application/x-www-form-urlencoded', ...headers };
    for (const key of Object.keys(all)) if ((all as Record<string, string>)[key] === '') delete (all as Record<string, string>)[key];
    const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method, url: path, headers: all, socket: new EventEmitter() }) as unknown as IncomingMessage;
    const res = { writeHead(status: number, values: Record<string, string> = {}) { result.status = status; for (const [k, v] of Object.entries(values)) result.headers[k.toLowerCase()] = String(v); return res; },
      setHeader(key: string, value: string) { result.headers[key.toLowerCase()] = value; }, end(text = '') { result.body = String(text); } } as unknown as ServerResponse;
    if (mount) await mount.handle(req, res); else await handlePortal(req, res, base);
    return result;
  }
  const csrfOf = (html: string) => /name="_csrf" value="([^"]+)"/u.exec(html)?.[1] ?? '';
  const refs = (html: string) => [...html.matchAll(/name="ref" value="([^"]+)"/gu)].map((m) => m[1]!);
  const form = (csrf: string, fields: Record<string, string | string[]>) => {
    const p = new URLSearchParams({ _csrf: csrf });
    for (const [k, v] of Object.entries(fields)) for (const value of [v].flat()) p.append(k, value);
    return p.toString();
  };
  const approved = async () => (await t.engine.getArticle(OWNER, t.a.id, t.articleId)).article.approval;
  const planStatus = async () => (await t.f.h.store.getPlan(t.b.id, t.planId))!.status;
  return { ...t, state, content, request, csrfOf, refs, form, approved, planStatus };
}

test('queue page: Business picker at the top, ?brand is validated, and a decision is refused under any other business', async () => {
  const p = await portal(), csrf = portalCsrfToken(SECRET, TOKEN);
  const home = await p.request('GET', '/portal/approvals');
  assert.equal(home.status, 200);
  const n = (await queue({ seoBlog: seoService(p.engine) }).list(who(p.a.id), 'req')).total + 1; // SEO items plus the one post in Your content
  assert.ok(home.body.includes(`href="/portal/approvals?brand=${p.a.id}" aria-current="page">Harbour<span class="aq-count" title="${n} waiting">${n}`), 'the signed-in business is the default and shows its count');
  assert.ok(home.body.includes(`href="/portal/approvals?brand=${p.b.id}">Zephyr &lt;b&gt;Lets&lt;/b&gt;</a>`)); assert.doesNotMatch(home.body, /<b>Lets<\/b>/);
  assert.ok(home.body.indexOf('<nav class="aq-brands"') > 0 && home.body.indexOf('<nav class="aq-brands"') < home.body.indexOf('<p class="aq-boundary"'), 'the picker is above the items');
  assert.ok(home.body.includes(`<strong>Harbour</strong> · ${n} items · `)); assert.match(home.body, /A post in Your content/);
  const other = await p.request('GET', `/portal/approvals?brand=${p.b.id}`);
  assert.equal(other.status, 200); assert.match(other.body, /Zephyr topics/); assert.doesNotMatch(other.body, /A post in Your content/);
  assert.match(other.body, /Follow-up flows and “Your content” are not listed for Zephyr &lt;b&gt;Lets&lt;\/b&gt;\. They stay with the business you signed in to\./);
  assert.ok(other.body.includes(`<input type="hidden" name="brand" value="${p.b.id}">`)); assert.ok(other.body.includes(`href="/portal/campaign-journey?brand=${p.b.id}"`));
  assert.ok(other.body.includes(`href="/portal/seo-blog/b/${p.b.id}/dna">Brand DNA</a>`));
  for (const bad of [randomUUID(), 'not-a-uuid', '%3Cscript%3E', `${p.a.id}&brand=${p.b.id}`]) {
    const refused = await p.request('GET', `/portal/approvals?brand=${bad}`);
    assert.ok([400, 404].includes(refused.status), bad); assert.doesNotMatch(refused.body, /name="ref"|<script>alert/); assert.match(refused.body, /That business was not found|Choose one business/);
  }
  // The article belongs to Harbour. Posting it "as" Zephyr is refused, whichever way the business is stated.
  const [articleRef] = p.refs(home.body).filter((r) => verifyApprovalRef(SECRET, TOKEN, r, Date.now())?.k === 'article');
  const planRef = p.refs(other.body)[0]!;
  const wrong = await p.request('POST', '/portal/approvals/decide', p.form(csrf, { brand: p.b.id, ref: articleRef!, action: 'approve' }));
  assert.equal(wrong.status, 409); assert.match(wrong.body, /belongs to a different business/);
  assert.equal((await p.request('POST', '/portal/approvals/decide', p.form(csrf, { ref: articleRef!, action: 'approve' }))).status, 400, 'the business must be stated');
  assert.equal((await p.request('POST', '/portal/approvals/decide', p.form(csrf, { brand: [p.a.id, p.b.id], ref: articleRef!, action: 'approve' }))).status, 400);
  assert.equal((await p.request('POST', `/portal/approvals/decide?brand=${p.b.id}`, p.form(csrf, { brand: p.a.id, ref: articleRef!, action: 'approve' }))).status, 403, 'no query string on a decision');
  assert.equal(await p.approved(), null);
  // One business at a time in a batch.
  const mixed = await p.request('POST', '/portal/approvals/batch', p.form(csrf, { brand: p.a.id, ref: [articleRef!, planRef] }));
  assert.equal(mixed.status, 409); assert.match(mixed.body, /Approve one business at a time\. Nothing was changed\./);
  assert.equal(await p.approved(), null); assert.equal(await p.planStatus(), 'proposed'); assert.deepEqual(p.content.calls, []);
  // The right business: approved, and the owner is returned to that business's queue.
  const done = await p.request('POST', '/portal/approvals/decide', p.form(csrf, { brand: p.a.id, ref: articleRef!, action: 'approve' }));
  assert.equal(done.status, 303); assert.ok(done.headers.location!.startsWith(`/portal/approvals?brand=${p.a.id}&n=`));
  assert.notEqual(await p.approved(), null);
  assert.match((await p.request('GET', done.headers.location!)).body, /role="status">[^<]*Approved\. Publishing still follows its own schedule and checks\./);
  const batch = await p.request('POST', '/portal/approvals/batch', p.form(csrf, { brand: p.b.id, ref: planRef }));
  assert.equal(batch.status, 200); assert.match(batch.body, /1 of 1 done/); assert.ok(batch.body.includes(`href="/portal/approvals?brand=${p.b.id}">Back to approvals</a>`));
  assert.equal(await p.planStatus(), 'accepted');
});

test('All businesses and campaign results pages take the same validated business', async () => {
  const p = await portal();
  const all = await p.request('GET', '/portal/approvals?brand=all');
  assert.equal(all.status, 200); assert.match(all.body, /<h1>All businesses<\/h1>/); assert.match(all.body, /\d+ items waiting across 2 businesses\./);
  assert.ok(all.body.includes('href="/portal/approvals?brand=all" aria-current="page">All businesses</a>')); assert.deepEqual(p.refs(all.body), []);
  p.state.calls.length = 0;
  const results = await p.request('GET', `/portal/campaign-journey?brand=${p.b.id}`);
  assert.equal(results.status, 200); assert.match(results.body, /<h1>Campaign results<\/h1>/);
  assert.ok(results.body.includes(`href="/portal/campaign-journey?brand=${p.b.id}" aria-current="page">Zephyr &lt;b&gt;Lets&lt;/b&gt;</a>`));
  assert.ok(results.body.includes(`href="/portal/approvals?brand=${p.b.id}">Approvals</a>`)); assert.doesNotMatch(results.body, /All businesses/);
  assert.doesNotMatch(results.body, /href="\/portal\/crm\/contacts">Contacts/, 'the contacts page belongs to the signed-in business, so it is not offered for another one');
  assert.deepEqual(p.state.calls, [`creators.list:${p.b.id}`, `studio.overview:${p.b.id}`], 'results were read for the chosen business only');
  p.state.calls.length = 0;
  const mine = (await p.request('GET', '/portal/campaign-journey')).body;
  assert.ok(mine.includes(`brand=${p.a.id}" aria-current="page">Harbour</a>`)); assert.match(mine, /href="\/portal\/crm\/contacts">Contacts/);
  assert.deepEqual(p.state.calls, [`creators.list:${p.a.id}`, `studio.overview:${p.a.id}`], 'default is the signed-in business');
  p.state.calls.length = 0;
  for (const bad of [randomUUID(), 'nope', 'all']) {
    const refused = await p.request('GET', `/portal/campaign-journey?brand=${bad}`);
    assert.ok([400, 404].includes(refused.status), bad);
  }
  assert.deepEqual(p.state.calls, [], 'nothing was read for a business that was refused');
  // Service level: a stranger gets no results, not somebody else's.
  await assert.rejects(new CampaignJourneyService({ seoBlog: seoService(p.engine) }).snapshot(who(p.a.id, STRANGER.userId), 'req', p.a.id), NOT_FOUND);
  const none = await new CampaignJourneyService({ seoBlog: seoService(p.engine) }).snapshot(who(p.a.id, STRANGER.userId), 'req');
  assert.equal(none.available, false); assert.match(renderCampaignJourneyBody(none), /No business is set up for content yet/);
});

// ─── Central content address ───────────────────────────────────────────────

test('central content address serves the queue and results with the same sign-in, membership and Origin gates; everything else is still 404', async () => {
  const p = await portal({ central: true });
  assert.equal((await p.request('GET', '/portal/approvals', '', { cookie: '' })).headers.location, '/portal/login');
  const page = await p.request('GET', '/portal/approvals');
  assert.equal(page.status, 200); assert.match(page.body, /Waiting for your approval/); assert.match(page.body, /<strong>Relaunch72 Content<\/strong>/);
  assert.ok(page.body.includes(`href="/portal/approvals?brand=${p.b.id}">Zephyr &lt;b&gt;Lets&lt;/b&gt;</a>`));
  assert.doesNotMatch(page.body, /A post in Your content|\/portal\/actions|\/portal\/crm|href="\/portal\/content|href="\/portal\/follow-ups|>Home<\/a>/, 'only pages served on this address are linked or listed');
  for (const link of new Set([...page.body.matchAll(/href="(\/[^"#?]*)/gu)].map((m) => m[1]!))) assert.match(link, /^\/portal(?:$|\/(?:seo-blog|approvals|campaign-journey|webinars)(?:\/|$))/u, `linked page is served here: ${link}`);
  assert.match(page.body, /<strong>Harbour<\/strong> · \d+ items? · \d+ ready to approve now/); assert.match(page.body, /href="\/portal\/seo-blog">Your businesses<\/a>/);
  assert.match(page.headers['content-security-policy']!, /frame-ancestors 'none'/);
  const results = await p.request('GET', `/portal/campaign-journey?brand=${p.b.id}`);
  assert.equal(results.status, 200); assert.doesNotMatch(results.body, /\/portal\/crm/);
  assert.equal((await p.request('GET', '/portal/approvals?brand=all')).status, 200);
  assert.equal((await p.request('GET', `/portal/approvals?brand=${randomUUID()}`)).status, 404);
  // Other portal pages, and anything else under these prefixes, never fall through.
  for (const path of ['/portal/crm', '/portal/crm/contacts', '/portal/content', '/portal/follow-ups', '/portal/actions', '/portal/investors', '/portal/approvals/other', '/portal/approvals/decide/x',
    '/portal/approvals-old', '/portal/campaign-journey/x', '/portal/campaign-journeys', '/portal/approvals/']) {
    const missing = await p.request('GET', path); assert.equal(missing.status, 404, path); assert.equal(missing.body, 'Page not found.', path);
  }
  // Wrong host is refused before anything else.
  assert.equal((await p.request('GET', '/portal/approvals', '', { host: 'hq.propertypredator.com' })).status, 421);
  assert.equal((await p.request('GET', '/portal/approvals', '', { host: 'app.relaunch72.com.evil.example' })).status, 421);
  // Membership: a session that manages nothing is stopped at the door, for pages and for decisions.
  p.state.authorised = false;
  assert.equal((await p.request('GET', '/portal/approvals')).status, 403); assert.equal((await p.request('GET', '/portal/campaign-journey')).status, 403);
  p.state.authorised = true;

  const csrf = p.csrfOf(page.body), [articleRef] = p.refs(page.body);
  assert.ok(csrf && articleRef); assert.notEqual(csrf, portalCsrfToken(SECRET, TOKEN), 'the central address has its own CSRF secret');
  const good = p.form(csrf, { brand: p.a.id, ref: articleRef!, action: 'approve' });
  for (const headers of [{ origin: 'https://evil.example' } as Record<string, string>, { origin: PP_ORIGIN }, { origin: 'null' }, { origin: '' }, { origin: 'http://app.relaunch72.com' }, { origin: `${CENTRAL_CONTENT_ORIGIN}.evil.example` }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
    assert.equal((await p.request('POST', '/portal/approvals/decide', good, headers)).status, 403, JSON.stringify(headers));
  }
  assert.equal((await p.request('POST', '/portal/approvals/decide', good, { host: 'hq.propertypredator.com', origin: PP_ORIGIN })).status, 421);
  assert.equal((await p.request('POST', '/portal/approvals/decide', good, { cookie: '' })).headers.location, '/portal/login');
  p.state.authorised = false;
  assert.equal((await p.request('POST', '/portal/approvals/decide', good)).status, 403);
  p.state.authorised = true;
  // A form or reference made on the Property Predator address is not accepted here.
  const ppCsrf = portalCsrfToken(SECRET, TOKEN);
  assert.equal((await p.request('POST', '/portal/approvals/decide', p.form(ppCsrf, { brand: p.a.id, ref: articleRef!, action: 'approve' }))).status, 403);
  const ppRef = signApprovalRef(SECRET, TOKEN, { ...verifyApprovalRef(SECRET, TOKEN, signApprovalRef(SECRET, TOKEN, { k: 'article', b: p.a.id, ids: { articleId: p.articleId, versionId: randomUUID() }, x: {}, c: randomUUID(), d: randomUUID(), t: Date.now(), n: 'x' }), Date.now())! });
  assert.equal((await p.request('POST', '/portal/approvals/decide', p.form(csrf, { brand: p.a.id, ref: ppRef, action: 'approve' }))).status, 409);
  assert.equal((await p.request('POST', '/portal/approvals/decide', p.form(csrf, { brand: p.b.id, ref: articleRef!, action: 'approve' }))).status, 409, 'another business is refused here too');
  assert.equal(await p.approved(), null); assert.deepEqual(p.content.calls, []);
  // The exact origin, with or without fetch metadata, is accepted.
  const done = await p.request('POST', '/portal/approvals/decide', good, { 'sec-fetch-site': 'same-origin' });
  assert.equal(done.status, 303); assert.ok(done.headers.location!.startsWith(`/portal/approvals?brand=${p.a.id}&n=`));
  assert.notEqual(await p.approved(), null);
  const planPage = await p.request('GET', `/portal/approvals?brand=${p.b.id}`);
  const batch = await p.request('POST', '/portal/approvals/batch', p.form(csrf, { brand: p.b.id, ref: p.refs(planPage.body)[0]! }));
  assert.equal(batch.status, 200); assert.match(batch.body, /1 of 1 done/, /<ul class="aq-results">.*?<\/ul>/su.exec(batch.body)?.[0]); assert.equal(await p.planStatus(), 'accepted');
});

test('strict origin check: the deployment’s own https address is accepted and nothing else is', () => {
  const check = (base: string | undefined, headers: Record<string, string | string[] | undefined>, path = '/portal/approvals/decide') => {
    try { assertStrictOrigin({ headers } as never, new URL(path, 'http://localhost'), base); return 200; }
    catch (error) { if (error instanceof ApprovalRouteError) return error.status; throw error; }
  };
  for (const [base, host] of [[CENTRAL_CONTENT_ORIGIN, 'app.relaunch72.com'], [PP_ORIGIN, 'hq.propertypredator.com'], [`${PP_ORIGIN}/`, 'hq.propertypredator.com'], ['https://HQ.PropertyPredator.com', 'HQ.propertypredator.COM']] as const) {
    const origin = new URL(base).origin;
    assert.equal(check(base, { host, origin }), 200, base);
    assert.equal(check(base, { host, origin, 'sec-fetch-site': 'same-origin' }), 200);
    assert.equal(check(base, { host, origin: 'https://evil.example' }), 403);
    assert.equal(check(base, { host, origin: `${origin}.evil.example` }), 403);
    assert.equal(check(base, { host, origin: origin.replace('https:', 'http:') }), 403, 'an http page for the same host is not the same origin');
    assert.equal(check(base, { host, origin: `${origin}:8443` }), 403);
    assert.equal(check(base, { host, origin: 'null' }), 403); assert.equal(check(base, { host }), 403, 'a missing Origin is refused');
    assert.equal(check(base, { host, origin: [origin, 'https://evil.example'] }), 403);
    assert.equal(check(base, { host, origin, 'sec-fetch-site': 'cross-site' }), 403); assert.equal(check(base, { host, origin, 'sec-fetch-site': 'none' }), 403);
    assert.equal(check(base, { host, origin }, '/portal/approvals/decide?brand=x'), 403);
    assert.equal(check(base, { host: 'evil.example', origin }), 404); assert.equal(check(base, { host: `${host}.evil.example`, origin }), 404);
    assert.equal(check(base, { host: `${host}:8443`, origin }), 404); assert.equal(check(base, { origin }), 404);
  }
  // The two addresses never accept each other's forms.
  assert.equal(check(CENTRAL_CONTENT_ORIGIN, { host: 'app.relaunch72.com', origin: PP_ORIGIN }), 403);
  assert.equal(check(PP_ORIGIN, { host: 'hq.propertypredator.com', origin: CENTRAL_CONTENT_ORIGIN }), 403);
  assert.equal(check(PP_ORIGIN, { host: 'app.relaunch72.com', origin: CENTRAL_CONTENT_ORIGIN }), 404);
  // No address, a bad address or a plain-http address means decisions are off, not open.
  assert.equal(check(undefined, { host: 'x', origin: 'https://x' }), 503); assert.equal(check('not a url', { host: 'x', origin: 'https://x' }), 503);
  assert.equal(check('http://hq.propertypredator.com', { host: 'hq.propertypredator.com', origin: 'http://hq.propertypredator.com' }), 404);
});

test('queue body states which business it is and keeps the business on every form', async () => {
  const { engine, a, b } = await twoBrands();
  const q = queue({ seoBlog: seoService(engine) });
  const html = renderApprovalQueueBody(await q.list(who(a.id), 'req', b.id), { csrf: 'csrf-token', now: Date.now(), actionCentre: true });
  assert.equal((html.match(new RegExp(`<input type="hidden" name="brand" value="${b.id}">`, 'gu')) ?? []).length, 2, 'the item form and the batch form');
  assert.match(html, /for Zephyr &lt;b&gt;Lets&lt;\/b&gt; &amp; Co only/); assert.match(html, /href="\/portal\/actions">Action Centre<\/a>/);
  const empty = renderApprovalQueueBody({ ...(await q.list(who(a.id), 'req', b.id)), sections: [], total: 0, ready: 0 }, { csrf: 'x', now: Date.now(), actionCentre: false, central: true });
  assert.match(empty, /Nothing is waiting for you in Zephyr &lt;b&gt;Lets&lt;\/b&gt; &amp; Co\./); assert.doesNotMatch(empty, /\/portal\/actions|href="\/portal"/);
  assert.throws(() => { throw new SeoBlogError(404, 'x'); }, SeoBlogError);
});
