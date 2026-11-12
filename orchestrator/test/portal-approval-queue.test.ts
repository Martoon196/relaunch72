/** Shared approval queue: each item is listed from, and decided through, its own existing function. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import jpeg from 'jpeg-js';
import { ApprovalQueueError, ApprovalQueueService, ownedElsewhere, signApprovalRef, verifyApprovalRef, type ApprovalItem, type ApprovalQueueDependencies, type ApprovalRef } from '../src/portal/approval-queue-service.js';
import type { PortalSeoBlogService } from '../src/portal/seo-blog-service.js';
import type { PortalSessionIdentity } from '../src/portal/auth-service.js';
import type { PortalCompanyContentService } from '../src/portal/company-content-service.js';
import type { PortalFollowupFlowService } from '../src/portal/followup-flow-service.js';
import { exactReviewApprovalToken } from '../src/portal/content-control-room-actions.js';
import { CreativeStudioService, type SavedImagePort } from '../src/creative-studio/service.js';
import { MemoryCreativeLibraryStore } from '../src/creative-studio/store.js';
import type { ArtworkInput, ArtworkRenderer, RenderedArtwork } from '../src/creative-studio/renderer.js';
import type { SeoBlogEngine } from '../src/seo-blog/engine.js';
import type { CompanyContentCatalogItem, CompanyContentExactReview } from '../src/company-content-pg/types.js';
import { OWNER } from './seo-blog-fixtures.js';
import { websiteFixture } from './seo-blog-website-fixtures.js';
import { campaignFixture } from './seo-blog-campaign-fixtures.js';
import { creativeBrand, HEARTH } from './creative-studio-fixtures.js';
import { harness } from './seo-blog-fixtures.js';

const SECRET = 'q'.repeat(48);
const who = (workspaceId: string, userId = OWNER.userId): PortalSessionIdentity => ({ sessionToken: 'synthetic-approval-queue-session', userId, workspaceId, userEmail: 'owner@example.invalid' });
const seoService = (engine: SeoBlogEngine, studio: CreativeStudioService | null = null): PortalSeoBlogService => ({
  generation: 'live', research: 'live', social: 'unavailable', engineFor: () => engine, socialCallback: async () => null, creativeFor: () => studio });
const queue = (deps: Partial<ApprovalQueueDependencies>) => new ApprovalQueueService({ sessionSecret: SECRET, ...deps });
const refOf = (identity: PortalSessionIdentity, item: ApprovalItem): ApprovalRef => verifyApprovalRef(SECRET, identity.sessionToken, item.ref, Date.now())!;
const items = async (q: ApprovalQueueService, identity: PortalSessionIdentity) => (await q.list(identity, 'req')).sections.flatMap((s) => s.items);

test('signed refs are bound to the session, unforgeable and expire', () => {
  const ref: ApprovalRef = { k: 'article', ids: { articleId: randomUUID(), versionId: randomUUID() }, x: { rowVersion: '1' }, c: randomUUID(), d: randomUUID(), t: Date.now(), n: 'A title' };
  const token = signApprovalRef(SECRET, 'session-a', ref);
  assert.deepEqual(verifyApprovalRef(SECRET, 'session-a', token, Date.now()), ref);
  assert.equal(verifyApprovalRef(SECRET, 'session-b', token, Date.now()), null, 'another session cannot replay it');
  assert.equal(verifyApprovalRef('x'.repeat(48), 'session-a', token, Date.now()), null);
  const [payload, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...ref, ids: { articleId: randomUUID(), versionId: randomUUID() } })).toString('base64url');
  assert.equal(verifyApprovalRef(SECRET, 'session-a', `${forged}.${sig}`, Date.now()), null, 'ids cannot be swapped');
  assert.equal(verifyApprovalRef(SECRET, 'session-a', `${payload}.${sig}.x`, Date.now()), null);
  assert.equal(verifyApprovalRef(SECRET, 'session-a', token, Date.now() + 13 * 3_600_000), null, 'an old page must be refreshed');
});

test('general content excludes every source system owned by another approval path', () => {
  for (const system of ['relaunch72.seo-blog', 'pp.followup-sequence', 'mhp.followup-sequence', 'pp.owner-email', 'pp.owner-sms', 'pp.owner-whatsapp', 'mhp.owner-email', 'mhp.owner-sms', 'mhp.owner-whatsapp']) {
    assert.equal(ownedElsewhere({ system, itemId: 'x' }), true, system);
  }
  assert.equal(ownedElsewhere({ system: 'propertypredator.company-content', itemId: 'growth-hq-owned-seed-delivery-proof' }), true, 'owned-seed proof belongs to its send rail');
  assert.equal(ownedElsewhere({ system: 'propertypredator.company-content', itemId: 'campaign-post-1' }), false, 'ordinary PP content stays');
});

test('SEO article: listed when it needs approval, approved through engine.approve once, stale and refuse paths use the existing functions', async () => {
  const f = await websiteFixture(), identity = who(f.brand.id), q = queue({ seoBlog: seoService(f.h.engine) });
  const listed = (await items(q, identity)).filter((i) => i.kind === 'article');
  assert.equal(listed.length, 1); const item = listed[0]!;
  assert.equal(item.state, 'ready'); assert.equal(item.batchable, true); assert.match(item.editHref, new RegExp(`/portal/seo-blog/b/${f.brand.id}/articles/${f.articleId}$`));
  const before = (await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId)).version!;
  assert.match(await q.decide(identity, 'req', refOf(identity, item), 'approve', false), /Approved/);
  const after = await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId);
  assert.equal(after.article.approval?.versionId, before.id); assert.equal(after.article.approval?.approvedBy, OWNER.userId);
  const audits = async () => (await f.h.engine.activity(OWNER, f.brand.id)).filter((a) => a.kind === 'article.approved').length;
  assert.equal(await audits(), 1, 'same audit event as the article page');
  assert.match(await q.decide(identity, 'req', refOf(identity, item), 'approve', false), /Already approved/);
  assert.equal(await audits(), 1, 'a repeat never re-approves or re-audits');
  assert.equal((await items(q, identity)).filter((i) => i.kind === 'article').length, 0);

  // A new version makes the old ref stale; refusing a fresh one holds it through engine.hold.
  const edited = await f.h.engine.editArticle(OWNER, f.brand.id, f.articleId, before.id, { title: `${before.body.title} — edited` });
  await assert.rejects(q.decide(identity, 'req', refOf(identity, item), 'approve', false), (e: unknown) => e instanceof ApprovalQueueError && /changed since you looked/.test(e.message));
  const fresh = (await items(q, identity)).find((i) => i.kind === 'article')!;
  assert.equal(refOf(identity, fresh).ids.versionId, edited.id);
  assert.match(await q.decide(identity, 'req', refOf(identity, fresh), 'refuse', false), /Held/);
  assert.equal((await f.h.store.getArticle(f.brand.id, f.articleId))!.hold?.reason, 'owner');
  assert.equal((await f.h.engine.activity(OWNER, f.brand.id)).some((a) => a.kind === 'article.held'), true);
});

test('another workspace sees nothing and cannot use refs minted for the owner', async () => {
  const f = await websiteFixture(), owner = who(f.brand.id), q = queue({ seoBlog: seoService(f.h.engine) });
  const item = (await items(q, owner)).find((i) => i.kind === 'article')!;
  const stranger = who(f.brand.id, '22222222-2222-4222-8222-222222222222');
  assert.equal((await items(q, stranger)).length, 0, 'a non-member gets no SEO sections');
  assert.equal(verifyApprovalRef(SECRET, 'another-session', item.ref, Date.now()), null);
  await assert.rejects(q.decide(stranger, 'req', refOf(owner, item), 'approve', false), /not found/);
  assert.equal((await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId)).article.approval, null);
});

async function proposedPlan(f: Awaited<ReturnType<typeof websiteFixture>>) {
  // Clone the fixture's researched plan as a fresh proposal with planned briefs (no model or search call).
  const [source] = await f.h.engine.listPlans(OWNER, f.brand.id);
  const planId = randomUUID(), briefs = source!.briefs.map((b) => ({ ...b, id: randomUUID(), planId, slug: `${b.slug}-${planId.slice(0, 6)}`, status: 'planned' as const, articleId: null }));
  for (const brief of briefs) await f.h.store.saveBrief(brief);
  await f.h.store.savePlan({ ...source!.plan, id: planId, status: 'proposed', acceptedAt: null, briefIds: briefs.map((b) => b.id) });
  return planId;
}

test('topic plan: accept and refuse go through acceptPlan and setBriefStatus', async () => {
  const f = await websiteFixture(), identity = who(f.brand.id), q = queue({ seoBlog: seoService(f.h.engine) });
  const refusedId = await proposedPlan(f);
  const plans = (await items(q, identity)).filter((i) => i.kind === 'plan');
  assert.equal(plans.length, 1); assert.equal(plans[0]!.refuseLabel, 'Not now — drop these ideas'); assert.equal(refOf(identity, plans[0]!).ids.planId, refusedId);
  assert.match(await q.decide(identity, 'req', refOf(identity, plans[0]!), 'refuse', false), /dropped/);
  const refused = (await f.h.engine.listPlans(OWNER, f.brand.id)).find((p) => p.plan.id === refusedId)!;
  assert.ok(refused.briefs.every((b) => b.status === 'omitted')); assert.equal(refused.plan.status, 'proposed');
  assert.equal((await items(q, identity)).filter((i) => i.kind === 'plan').length, 0);
  await assert.rejects(q.decide(identity, 'req', refOf(identity, plans[0]!), 'approve', false), /changed since you looked/);

  const acceptedId = await proposedPlan(f);
  const next = (await items(q, identity)).find((i) => i.kind === 'plan')!;
  assert.match(await q.decide(identity, 'req', refOf(identity, next), 'approve', false), /accepted/);
  assert.equal((await f.h.engine.listPlans(OWNER, f.brand.id)).find((p) => p.plan.id === acceptedId)!.plan.status, 'accepted');
  assert.match(await q.decide(identity, 'req', refOf(identity, next), 'approve', false), /Already accepted/);
});

test('campaign posts and promotions are listed from the article; batch reports each item separately with no cross-item rollback', async () => {
  const f = await campaignFixture(), identity = who(f.brand.id), q = queue({ seoBlog: seoService(f.h.engine) });
  const all = await items(q, identity);
  const posts = all.filter((i) => i.kind === 'campaign_post'), promotions = all.filter((i) => i.kind === 'promotion');
  assert.ok(posts.length >= 1); assert.ok(promotions.length >= 1);
  assert.equal(posts[0]!.refuseLabel, 'Leave this post out'); assert.equal(promotions[0]!.refuseLabel, undefined, 'no refuse path exists for promotions');
  await assert.rejects(q.decide(identity, 'req', refOf(identity, promotions[0]!), 'refuse', false), /not available/);
  // The harness has no canonical review port, so the engine refuses the post exactly as the campaign page would.
  const results = await q.batch(identity, 'req', [refOf(identity, posts[0]!), refOf(identity, promotions[0]!)]);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.ok, false); assert.match(results[0]!.message, /Canonical campaign review is not configured/);
  assert.equal(results[1]!.ok, false); assert.doesNotMatch(results[1]!.message, /not confirmed/, 'the engine’s own refusal is shown, not a generic error');
  // Refusing a post omits it through controlCampaignPost.
  assert.match(await q.decide(identity, 'req', refOf(identity, posts[0]!), 'refuse', false), /Left out/);
  const variant = (await f.h.store.getArticle(f.brand.id, f.article.id))!.campaign!.variants.find((v) => v.id === refOf(identity, posts[0]!).ids.variantId)!;
  assert.equal(variant.omitted, true);
  assert.equal((await items(q, identity)).some((i) => i.kind === 'campaign_post' && refOf(identity, i).ids.variantId === variant.id), false);
});

class StubRenderer implements ArtworkRenderer {
  readonly version = 'test-stub-renderer';
  available() { return true; }
  async renderBatch(inputs: readonly ArtworkInput[]): Promise<RenderedArtwork[]> {
    return inputs.map((input) => {
      const seed = createHash('sha256').update(JSON.stringify({ ...input, logo: input.logo?.sha256, background: input.background?.sha256, placement: input.placement.id })).digest();
      const data = Buffer.alloc(8 * 8 * 4); for (let i = 0; i < 64; i++) data.set([seed[i % 32]!, seed[(i + 3) % 32]!, seed[(i + 9) % 32]!, 255], i * 4);
      const bytes = Buffer.from(jpeg.encode({ data, width: 8, height: 8 }, 90).data);
      const out = { mime: 'image/jpeg' as const, sha256: createHash('sha256').update(bytes).digest('hex'), width: input.placement.width, height: input.placement.height, contrast: { headline: 8 }, scrimAlpha: 0.42, headlineSize: 80, issues: [] };
      Object.defineProperty(out, 'bytes', { enumerable: false, get: () => Buffer.from(bytes) });
      return out as unknown as RenderedArtwork;
    });
  }
}

test('Creative Studio: images approve through studio.approve with a server-minted command id; flagged figures stay one-at-a-time', async () => {
  const h = harness(), hearth = await creativeBrand(h, HEARTH);
  const saved: SavedImagePort = { list: async () => [], load: async () => { throw new Error('unused'); } };
  const library = new MemoryCreativeLibraryStore();
  const studio = new CreativeStudioService({ library, brands: h.store, renderer: new StubRenderer(), savedImages: saved, renderJobs: h.store });
  const brandId = hearth.brand.id, identity = who(brandId), q = queue({ seoBlog: seoService(h.engine, studio) });
  const form = { purpose: 'advert', source_kind: 'offer', offer: 'Annual boiler service', audience: '', destination: HEARTH.pages[0]!.url, placements: ['square'], concepts: '1' };
  await studio.draft(OWNER.userId, brandId, randomUUID(), form, { kind: 'neutral' });
  await studio.draft(OWNER.userId, brandId, randomUUID(), { ...form, offer: '', purpose: 'organic_social', source_kind: 'brief', brief: 'Book before Friday and save 25% on your first service. Friendly engineers.' }, { kind: 'neutral' });
  const creative = (await items(q, identity)).filter((i) => i.kind === 'creative');
  const figures = creative.find((i) => i.confirmation)!, plain = creative.find((i) => !i.confirmation)!;
  assert.ok(figures && plain); assert.equal(figures.batchable, false); assert.equal(plain.batchable, true);
  assert.match(plain.imageHref!, new RegExp(`/portal/seo-blog/b/${brandId}/creative/art/`));
  const [plainResult, figuresResult] = await q.batch(identity, 'req', [refOf(identity, plain), refOf(identity, figures)]);
  assert.equal(plainResult!.ok, true); assert.match(plainResult!.message, /Approved this exact asset/);
  assert.equal(figuresResult!.ok, false, 'a batch never confirms flagged figures'); assert.match(figuresResult!.message, /Confirm the figures/);
  const ref = refOf(identity, plain);
  assert.equal((await library.getVersion(brandId, ref.ids.versionId!))!.approval!.versionId, ref.ids.versionId);
  assert.match(await q.decide(identity, 'req', ref, 'approve', false), /Already/, 'retry never approves twice');
  assert.match(await q.decide(identity, 'req', refOf(identity, figures), 'approve', true), /Approved this exact asset/, 'the explicit confirmation is passed through');
  await assert.rejects(q.decide(identity, 'req', refOf(identity, plain), 'refuse', false), /not available/);
});

const catalogItem = (system: string, itemId: string, extra: Partial<CompanyContentCatalogItem> = {}): CompanyContentCatalogItem => ({
  contentItemId: randomUUID(), contentVersionId: randomUUID(), versionNumber: 1, origin: 'generated' as never, kind: 'social_post' as never, title: `Item from ${system}`,
  contentMimeType: 'application/vnd.propertypredator.company-content+json', source: { system, itemId, version: 'v1' }, contentSha256: 'a'.repeat(64), blobSha256: 'b'.repeat(64), brandSha256: 'c'.repeat(64),
  approvalRequestId: randomUUID(), approvalDecisionId: null, approvalStatus: 'pending', approvalStale: false, sourceAttestationId: null, sourceCheckedAt: null, sourceExpiresAt: null, sourceFresh: true,
  publishable: false, createdAt: new Date().toISOString(), ...extra });

function contentFake(catalog: CompanyContentCatalogItem[]) {
  const calls: { method: string; input: unknown }[] = [];
  const service: PortalCompanyContentService = {
    snapshot: async () => ({ ok: true, snapshot: { workspace: { workspaceId: 'w', workspaceName: 'W', snapshotAt: new Date().toISOString(), canWrite: true, canManage: true }, catalog: { items: catalog, nextCursor: null } } }),
    review: async (_who, input) => {
      const item = catalog.find((i) => i.contentVersionId === input.contentVersionId)!;
      const review = { ...item, isLatest: true, canonicalContent: '{}', canonicalByteLength: 2, email: null,
        social: { schema: 'propertypredator.company-content/v1', type: 'post', kind: 'post', platform: 'LinkedIn', title: item.title, publicationCopy: 'Exact copy for review.', artworkInstructions: null, ctaUrl: null, contextSha256: null, legacyCombined: false, publicationCopySha256: 'd'.repeat(64), artworkInstructionsSha256: null } } as unknown as CompanyContentExactReview;
      return { ok: true, snapshot: { workspace: { workspaceId: 'w', workspaceName: 'W', snapshotAt: '', canWrite: true, canManage: true }, review } };
    },
    requestApproval: async () => { throw new Error('never requested from the queue'); },
    decideApproval: async (_who, input) => { calls.push({ method: 'decideApproval', input }); return { ok: true, disposition: 'applied', approvalDecisionId: randomUUID(), approvalRequestId: input.approvalRequestId, decision: input.decision } as never; },
    decideExactReviewedApproval: async (_who, input) => { calls.push({ method: 'decideExactReviewedApproval', input }); return { ok: true, disposition: 'applied', approvalDecisionId: randomUUID(), approvalRequestId: input.approvalRequestId, decision: 'approved' } as never; },
  };
  return { service, calls };
}

test('Your content: only its own items are listed; approve uses the exact-review path, refuse uses decideApproval(rejected)', async () => {
  const mine = catalogItem('propertypredator.company-content', 'campaign-post-1');
  const catalog = [mine, catalogItem('relaunch72.seo-blog', 'b:a:linkedin'), catalogItem('pp.followup-sequence', 'flow'), catalogItem('pp.owner-email', 'm'),
    catalogItem('propertypredator.company-content', 'growth-hq-owned-seed-delivery-proof'), catalogItem('propertypredator.company-content', 'approved', { approvalStatus: 'approved' })];
  const { service, calls } = contentFake(catalog);
  const identity = who(randomUUID()), q = queue({ companyContent: service });
  const listed = await items(q, identity);
  assert.deepEqual(listed.map((i) => i.title), [mine.title]);
  const item = listed[0]!; assert.equal(item.batchable, false); assert.equal(item.preview, 'Exact copy for review.');
  const ref = refOf(identity, item);
  assert.deepEqual((await q.batch(identity, 'req', [ref]))[0], { ok: false, title: mine.title, message: 'Approve this one on its own, with its confirmation.' });
  await q.decide(identity, 'req', ref, 'approve', false);
  assert.deepEqual(calls[0], { method: 'decideExactReviewedApproval', input: { commandKey: ref.c, approvalRequestId: mine.approvalRequestId, decision: 'approved', decisionNote: null,
    contentItemId: mine.contentItemId, contentVersionId: mine.contentVersionId, contentSha256: mine.contentSha256 } });
  await q.decide(identity, 'req', ref, 'refuse', false);
  assert.deepEqual(calls[1], { method: 'decideApproval', input: { commandKey: ref.d, approvalRequestId: mine.approvalRequestId, decision: 'rejected', decisionNote: null } });
  // An expired exact-review check is refused before any decision is attempted.
  const expired: ApprovalRef = { ...ref, x: { ...ref.x, exact: exactReviewApprovalToken(SECRET, identity.sessionToken, { contentItemId: mine.contentItemId, contentVersionId: mine.contentVersionId, approvalRequestId: mine.approvalRequestId!, contentSha256: mine.contentSha256 }, Date.now() - 20 * 60_000) } };
  await assert.rejects(q.decide(identity, 'req', expired, 'approve', false), /expired/);
  assert.equal(calls.length, 2);
});

test('PP follow-up flows: listed only where available; approval is flows.publish with the server command id and nothing else', async () => {
  const item = catalogItem('pp.followup-sequence', 'flow-1', { approvalStatus: 'unrequested', approvalRequestId: null }), calls: unknown[][] = [];
  const flows = { snapshot: async () => ({ catalog: { items: [item], nextCursor: null } }) as unknown as Awaited<ReturnType<PortalFollowupFlowService['snapshot']>>,
    publish: async (...args: unknown[]) => { calls.push(args); } } as Pick<PortalFollowupFlowService, 'snapshot' | 'publish'>;
  const identity = who(randomUUID());
  assert.equal((await items(queue({ flows, flowsAvailable: false }), identity)).length, 0);
  const q = queue({ flows, flowsAvailable: true, now: () => 1_800_000_000_000 });
  const listed = await items(q, identity); assert.equal(listed.length, 1); assert.equal(listed[0]!.kind, 'flow');
  const ref = verifyApprovalRef(SECRET, identity.sessionToken, listed[0]!.ref, 1_800_000_000_000)!;
  await assert.rejects(q.decide(identity, 'req', ref, 'refuse', false), /not available/);
  assert.match(await q.decide(identity, 'req', ref, 'approve', false), /Nothing was started/);
  assert.deepEqual(calls, [[identity, 'req', item.contentItemId, item.contentVersionId, ref.c, 1_800_000_000_000]]);
  await assert.rejects(q.decide(identity, 'req', { ...ref, x: { contentSha: 'f'.repeat(64) } }, 'approve', false), /changed since you looked/);
  assert.equal(calls.length, 1);
});

test('campaign drafts: approve passes the owner’s explicit review confirmation to creator.approve and is never batched', async () => {
  const id = randomUUID(), calls: unknown[][] = [];
  const record = { id, state: 'draft', rowVersion: 4, createdAt: new Date().toISOString(), approval: null,
    brief: { kind: 'email', name: 'Welcome series', goal: 'Welcome new landlords' }, version: { contentSha: 'd'.repeat(64), createdAt: new Date().toISOString(), content: { title: 'Welcome', summary: 'Three emails.' } } };
  const creator = { list: async () => [record], get: async () => record, approve: async (...args: unknown[]) => { calls.push(args); return record; } };
  const engine = { campaignCreatorsReady: true, creators: () => creator, listArticles: async () => [], listPlans: async () => [] } as unknown as SeoBlogEngine;
  const brandId = randomUUID(), identity = who(brandId), q = queue({ seoBlog: seoService(engine) });
  const item = (await items(q, identity)).find((i) => i.kind === 'creator')!;
  assert.equal(item.batchable, false); assert.match(item.confirmation!, /I reviewed the wording, facts and permission process/);
  assert.equal((await q.batch(identity, 'req', [refOf(identity, item)]))[0]!.ok, false);
  await q.decide(identity, 'req', refOf(identity, item), 'approve', true);
  assert.deepEqual(calls, [[OWNER.userId, brandId, id, 4, 'd'.repeat(64), true]]);
  await assert.rejects(q.decide(identity, 'req', refOf(identity, item), 'refuse', false), /not available/);
});
