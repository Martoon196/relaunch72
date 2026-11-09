/**
 * Milestone 4: approved creative reaches existing integrations only. Real JPEG preparation through the existing
 * article media path, tracked links with campaign and artwork identities, honest state ladders and outcome reads.
 * Synthetic fixtures only: no provider, socket, CRM write or public post.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import jpeg from 'jpeg-js';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { ArticleMediaReviewService, canonicalImageQualityApproval } from '../src/seo-blog/media-review.js';
import { GithubStaticPublisher } from '../src/seo-blog/publishers/github-static.js';
import { CreativeStudioService, postUses, type DistributionReadPort } from '../src/creative-studio/service.js';
import type { ArticleCampaign } from '../src/seo-blog/campaign.js';
import { MemoryCreativeLibraryStore } from '../src/creative-studio/store.js';
import type { ArtworkInput, ArtworkRenderer, RenderedArtwork } from '../src/creative-studio/renderer.js';
import { ATTRIBUTION_LIMITS, creativeTrackedLink, creativeUtmContent, handoffRoute, parseCreativeUtmContent, PAID_CHANNELS, postLadder, trackedLinkLadder,
  type DeliveryRecord, type OutcomeRead } from '../src/creative-studio/distribution.js';
import type { CreativeHandoff } from '../src/creative-studio/types.js';
import type { CreatorRecord, AcquisitionProposal } from '../src/seo-blog/campaign-creator.js';
import { websiteFixture } from './seo-blog-website-fixtures.js';
import { nativeMediaPorts } from './seo-blog-native-media-fixture.js';
import { OWNER, STRANGER } from './seo-blog-fixtures.js';

/** Real full-size JPEGs whose pixels depend on the copy (so each version has distinct bytes). Labelled stub, not Chromium. */
class SizedStubRenderer implements ArtworkRenderer {
  readonly version = 'test-sized-stub';
  available() { return true; }
  async renderBatch(inputs: readonly ArtworkInput[]): Promise<RenderedArtwork[]> {
    return inputs.map((input) => {
      const seed = createHash('sha256').update(JSON.stringify({ h: input.headline, p: input.placement.id })).digest();
      const { width, height } = input.placement, data = Buffer.alloc(width * height * 4);
      for (let i = 0; i < data.length; i += 4) { data[i] = seed[0]!; data[i + 1] = seed[1]!; data[i + 2] = (i / 4) % 251; data[i + 3] = 255; }
      const bytes = Buffer.from(jpeg.encode({ data, width, height }, 80).data);
      const out = { mime: 'image/jpeg' as const, sha256: createHash('sha256').update(bytes).digest('hex'), width, height, contrast: { headline: 8 }, scrimAlpha: 0.4, headlineSize: 80, issues: [] };
      Object.defineProperty(out, 'bytes', { enumerable: false, get: () => Buffer.from(bytes) });
      return out as unknown as RenderedArtwork;
    });
  }
  async renderContactSheet(): Promise<never> { throw new Error('unused'); }
  async renderStoryboard(): Promise<never> { throw new Error('unused'); }
  async renderSceneVideo(): Promise<never> { throw new Error('unused'); }
}

const proposal: AcquisitionProposal = {
  title: 'Synthetic proposal', summary: 'Synthetic acquisition plan for tests.', objective: { goal: 'Book demonstrations', primaryMetric: 'Booked demos' },
  insights: [], channels: [{ channel: 'instagram', role: 'Reach', rationale: 'Synthetic rationale text.' }],
  concepts: [{ name: 'Calm', angle: 'Calm angle', hook: 'Hook', headline: 'Headline', primaryText: 'Synthetic primary text for the concept.', cta: { label: 'Book', url: 'https://harbour.example/plan' }, channels: ['instagram', 'email'], addresses: [0], creativeDirection: 'Synthetic direction.' }],
  measurement: { primaryMetric: 'Booked demos', secondaryMetrics: [], reviewAfterDays: 14, learningRule: 'Synthetic rule.', limitations: ['Synthetic limit.'] }, hypotheses: [],
};

async function setup() {
  const f = await websiteFixture('github_static'), h = f.h, ports = nativeMediaPorts(h.store, f.brand.id, OWNER.userId, h.clock.now);
  const engine = new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map([['github_static', new GithubStaticPublisher(h.github.fetch, 1000)]]),
    vault: h.vault, now: h.clock.now, batchLimit: 20,
    mediaReview: new ArticleMediaReviewService(h.store, ports.media, canonicalImageQualityApproval({ context: ports.context, drafts: ports.drafts, approvals: ports.approvals, find: (source, sha) => ports.find(source, sha) }), h.clock.now) });
  const campaignId = randomUUID();
  const record = { id: campaignId, brandId: f.brand.id, brief: { kind: 'acquisition', name: 'Spring plan', cta: { label: 'Book', url: 'https://harbour.example/plan' } }, version: { content: proposal } } as unknown as CreatorRecord;
  const reads: { delivery: string[][]; outcomes: string[] } = { delivery: [], outcomes: [] };
  let deliveryRows: DeliveryRecord[] = [];
  const outcomes: OutcomeRead = { utmCampaign: '', readAt: '2026-11-09T10:00:00.000Z', buckets: [] };
  const distribution: DistributionReadPort = {
    async delivery(_b, ids) { reads.delivery.push([...ids]); return deliveryRows.filter((r) => ids.includes(r.queueIntentId)); },
    async outcomes(_b, utm) { reads.outcomes.push(utm); return { ...outcomes, utmCampaign: utm }; },
  };
  const studio = new CreativeStudioService({ library: new MemoryCreativeLibraryStore(), brands: h.store, renderer: new SizedStubRenderer(),
    articleMedia: { importApproved: (actor, brand, article, command, bytes, profile, origin) => engine.importCreativeImage({ userId: actor }, brand, article, command, bytes, profile, origin) },
    creators: { get: async (_b, id) => (id === campaignId ? record : null), list: async () => [record] }, distribution, now: h.clock.now });
  const draft = await studio.draft(OWNER.userId, f.brand.id, randomUUID(), { purpose: 'organic_social', source_kind: 'brief', brief: 'Harbour Compliance Plan costs £49 per month.', audience: '', destination: '',
    placements: ['portrait', 'square', 'landscape'], concepts: '1' }, { kind: 'neutral' });
  const set = await studio.getSet(OWNER.userId, f.brand.id, draft.setId);
  const byPlacement = (p: string) => set.view.concepts[0]!.variants.find((v) => v.version.placement === p)!.version;
  for (const p of ['portrait', 'square', 'landscape']) { const v = byPlacement(p); await studio.approve(OWNER.userId, f.brand.id, v.id, randomUUID(), v.render.sha256, true); }
  return { f, h, engine, studio, set, byPlacement, campaignId, reads, setDelivery: (rows: DeliveryRecord[]) => { deliveryRows = rows; }, outcomes };
}

test('an approved portrait enters the existing article media path unchanged in size, with provenance, idempotently', { timeout: 120_000 }, async () => {
  const { f, h, engine, studio, set, byPlacement } = await setup();
  const portrait = byPlacement('portrait'), command = randomUUID(), target = { kind: 'article_campaign' as const, articleId: f.articleId };
  const before = (await h.store.getArticle(f.brand.id, f.articleId))!.localImageProposals?.length ?? 0;
  const first = await studio.handoff(OWNER.userId, f.brand.id, portrait.id, command, target);
  assert.equal(first.handoff?.route, 'article_media');
  const article = (await h.store.getArticle(f.brand.id, f.articleId))!;
  const imported = article.localImageProposals!.at(-1)!;
  assert.equal(article.localImageProposals!.length, before + 1);
  assert.deepEqual(imported.origin, { kind: 'creative_studio', creativeVersionId: portrait.id, creativeSha256: portrait.render.sha256, placement: 'portrait' });
  assert.equal(imported.candidateSha256, portrait.render.sha256, 'the exact approved bytes are the article candidate');
  assert.deepEqual(imported.variants.map((v) => [v.profile, v.width, v.height]), [['instagram', 1080, 1350]], 'one exact-size format; nothing else is cropped');
  assert.equal(first.handoff?.articleMedia?.variantAssetId, imported.variants[0]!.assetId);
  // Nothing beyond the private article image: no review, use, post approval or posting plan.
  assert.equal(article.mediaQualityReviews?.length ?? 0, 0);
  assert.equal(article.campaign?.queueInstructions?.length ?? 0, 0);
  // Replay: same command returns the receipt and adds no second image.
  const replay = await studio.handoff(OWNER.userId, f.brand.id, portrait.id, command, target);
  assert.equal(replay.replayed, true);
  assert.equal((await h.store.getArticle(f.brand.id, f.articleId))!.localImageProposals!.length, before + 1);
  // A retry from a freshly rendered page carries a new command id: the image already imported is reused, not duplicated.
  const retry = await studio.handoff(OWNER.userId, f.brand.id, portrait.id, randomUUID(), target);
  assert.equal(retry.replayed, false);
  assert.equal(retry.handoff?.articleMedia?.variantAssetId, imported.variants[0]!.assetId);
  assert.equal((await h.store.getArticle(f.brand.id, f.articleId))!.localImageProposals!.length, before + 1, 'no second private image for the same exact version');
  // Approved artwork is never re-cropped through the article's crop control.
  await assert.rejects(engine.cropCampaignImage({ userId: OWNER.userId }, f.brand.id, f.articleId, article.currentVersionId!, randomUUID(), imported.candidateAssetId, imported.candidateSha256, { x: 0.2, y: 0.8 }), /cannot be re-cropped/u);
  // Landscape 1200×628 becomes the LinkedIn 1200×627 format with half a pixel trimmed top and bottom, never upscaled or re-framed.
  const landscape = await studio.handoff(OWNER.userId, f.brand.id, byPlacement('landscape').id, randomUUID(), target);
  assert.equal(landscape.handoff?.route, 'article_media');
  const linkedin = (await h.store.getArticle(f.brand.id, f.articleId))!.localImageProposals!.at(-1)!;
  assert.equal(linkedin.candidateSha256, byPlacement('landscape').render.sha256);
  assert.deepEqual(linkedin.variants.map((v) => [v.profile, v.width, v.height]), [['linkedin', 1200, 627]]);
  // Square has no exact article format: recorded for download, never cropped.
  const square = await studio.handoff(OWNER.userId, f.brand.id, byPlacement('square').id, randomUUID(), target);
  assert.equal(square.handoff?.route, 'export_only');
  assert.equal((await h.store.getArticle(f.brand.id, f.articleId))!.localImageProposals!.length, before + 2, 'square adds nothing to the article');
  // A stranger cannot hand off this brand's artwork.
  await assert.rejects(studio.handoff(STRANGER.userId, f.brand.id, portrait.id, randomUUID(), target), /manage|not found|permission/i);
  const dist = await studio.distribution(OWNER.userId, f.brand.id, set.record.set.id);
  assert.equal(dist.filter((d) => d.route === 'article_media').length, 3, 'portrait, its retry (recorded, reusing the image) and landscape');
  const media = dist.find((d) => d.route === 'article_media')!;
  assert.equal(media.posts[0]!.label, 'Not yet chosen for a post');
  assert.deepEqual(media.posts[0]!.ladder.map((s) => s.status), ['reached', 'waiting', 'waiting', 'waiting', 'not_applicable', 'unknown', 'unknown']);
  assert.equal(dist.find((d) => d.route === 'export_only')!.posts[0]!.ladder.slice(1).every((s) => s.status === 'not_applicable'), true);
});

test('acquisition hand-off issues a tracked link carrying campaign and artwork identities, and reads outcomes by that tag', { timeout: 120_000 }, async () => {
  const { f, studio, set, byPlacement, campaignId, reads, outcomes } = await setup();
  const portrait = byPlacement('portrait');
  const targets = await studio.acquisitionTargets(OWNER.userId, f.brand.id);
  assert.deepEqual(targets[0]!.concepts[0]!.channels, ['instagram', 'email']);
  await assert.rejects(studio.handoff(OWNER.userId, f.brand.id, portrait.id, randomUUID(), { kind: 'creator_campaign', campaignId, concept: 0, channel: 'linkedin' }), /concepts and one of its channels/);
  const result = await studio.handoff(OWNER.userId, f.brand.id, portrait.id, randomUUID(), { kind: 'creator_campaign', campaignId, concept: 0, channel: 'instagram' });
  const link = result.handoff!.trackedLink!;
  const utmCampaign = `spring-plan-${campaignId.replace(/-/gu, '').slice(0, 8)}`, utmContent = `concept-1-cs${portrait.id.replace(/-/gu, '').slice(0, 8)}`;
  assert.deepEqual({ ...link }, { url: `https://harbour.example/plan?utm_source=instagram&utm_medium=social&utm_campaign=${utmCampaign}&utm_content=${utmContent}`, utmCampaign, utmContent, channel: 'instagram', concept: 0 });
  // No outcome yet: honest waiting states; publication is not recorded for exported campaigns.
  let dist = await studio.distribution(OWNER.userId, f.brand.id, set.record.set.id);
  let ladder = dist.find((d) => d.route === 'tracked_link')!.posts[0]!.ladder;
  assert.deepEqual(ladder.map((s) => [s.stage, s.status]), [['handed_off', 'reached'], ['queued', 'not_applicable'], ['provider_accepted', 'not_applicable'], ['published', 'unknown'], ['delivered', 'not_applicable'], ['lead', 'waiting'], ['customer', 'waiting']]);
  // Real CRM rows (synthetic here) tagged with this exact utm_content are counted; others are not.
  (outcomes as { buckets: OutcomeRead['buckets'] }).buckets = [
    { utmContent, leads: 3, qualified: 2, booked: 1, sold: 1, customers: 1, subscriptionsCancelled: 0, firstAt: '2026-11-03T09:00:00.000Z', lastAt: '2026-11-08T09:00:00.000Z' },
    { utmContent: 'concept-1', leads: 5, qualified: 0, booked: 0, sold: 0, customers: 0, subscriptionsCancelled: 0, firstAt: null, lastAt: null },
  ];
  dist = await studio.distribution(OWNER.userId, f.brand.id, set.record.set.id);
  ladder = dist.find((d) => d.route === 'tracked_link')!.posts[0]!.ladder;
  assert.deepEqual(ladder.slice(5).map((s) => [s.stage, s.status, s.count]), [['lead', 'reached', 3], ['customer', 'reached', 1]]);
  assert.ok(reads.outcomes.every((u) => u === utmCampaign));
  const summary = await studio.campaignOutcomes(OWNER.userId, f.brand.id, campaignId);
  assert.equal(summary!.utmCampaign, utmCampaign);
  assert.equal(summary!.limits, ATTRIBUTION_LIMITS);
  assert.ok(summary!.limits.some((l) => /no live lead form records campaign tags/i.test(l)), 'the capture gap is stated');
  assert.ok(summary!.limits.some((l) => /No revenue, return on ad spend, cost per acquisition or “winner”/u.test(l)));
});

test('post ladder: each state needs its own record; failures and unknowns are not upgraded; delivered never applies to social', () => {
  const h = { id: randomUUID(), versionId: randomUUID(), approvalId: randomUUID(), target: { kind: 'article_campaign', articleId: randomUUID() }, state: 'ready_for_review', route: 'article_media',
    createdBy: OWNER.userId, createdAt: '2026-11-09T09:00:00.000Z' } as CreativeHandoff;
  const plan = (over: Partial<DeliveryRecord>): DeliveryRecord => ({ queueIntentId: randomUUID(), cancelled: false, materialized: true, scheduledFor: '2026-11-10T09:00:00.000Z', jobState: 'queued', providerPostRecorded: false, events: [], ...over });
  const st = (l: ReturnType<typeof postLadder>) => l.map((s) => s.status).join(',');
  assert.equal(st(postLadder(h, null, true)), 'reached,waiting,waiting,waiting,not_applicable,unknown,unknown');
  assert.equal(st(postLadder(h, plan({ materialized: false, scheduledFor: null, jobState: null }), true)), 'reached,waiting,waiting,waiting,not_applicable,unknown,unknown');
  assert.equal(st(postLadder(h, plan({}), true)), 'reached,reached,waiting,waiting,not_applicable,unknown,unknown', 'queued does not imply accepted');
  assert.equal(st(postLadder(h, plan({ events: [{ kind: 'accepted', at: '2026-11-10T09:00:01.000Z', code: 'accepted' }] }), true)), 'reached,reached,reached,waiting,not_applicable,unknown,unknown', 'accepted does not imply published');
  assert.equal(st(postLadder(h, plan({ jobState: 'succeeded', events: [{ kind: 'accepted', at: '2026-11-10T09:00:01.000Z', code: 'a' }, { kind: 'published', at: '2026-11-10T09:05:00.000Z', code: 'p' }] }), true)), 'reached,reached,reached,reached,not_applicable,unknown,unknown');
  assert.equal(st(postLadder(h, plan({ jobState: 'failed', events: [{ kind: 'failed', at: '2026-11-10T09:00:01.000Z', code: 'provider.rejected' }] }), true)), 'reached,reached,failed,failed,not_applicable,unknown,unknown');
  assert.equal(st(postLadder(h, plan({ jobState: 'reconciliation_pending', events: [{ kind: 'outcome_unknown', at: '2026-11-10T09:00:01.000Z', code: 'timeout' }] }), true)), 'reached,reached,unknown,unknown,not_applicable,unknown,unknown');
  assert.equal(st(postLadder(h, plan({ cancelled: true, materialized: false }), true)), 'reached,stopped,stopped,stopped,not_applicable,unknown,unknown');
  // A plan replaced by a newer one, or whose calendar entry the existing worker retired, is stopped rather than "waiting".
  assert.equal(st(postLadder(h, plan({ superseded: true, materialized: false }), true)), 'reached,stopped,stopped,stopped,not_applicable,unknown,unknown');
  assert.equal(st(postLadder(h, plan({ jobState: 'cancelled' }), true)), 'reached,stopped,stopped,stopped,not_applicable,unknown,unknown');
  assert.match(postLadder(h, plan({ jobState: 'cancelled' }), true)[1]!.evidence, /withdrawn by the existing posting controls/u);
  assert.equal(st(postLadder(h, plan({ superseded: true, jobState: 'succeeded', events: [{ kind: 'published', at: '2026-11-10T09:05:00.000Z', code: 'p' }] }), true)), 'reached,reached,reached,reached,not_applicable,unknown,unknown', 'a plan that already published is not rewritten as stopped');
  assert.match(postLadder(h, null, false)[5]!.evidence, /no campaign parameters are added/);
  // One row per post: a superseded revision that carried the image is not repeated; a planned revision wins over the current one.
  const asset = randomUUID(), q = randomUUID();
  const rev = (id: string, withImage = true) => ({ id, media: withImage ? { assetId: asset } : null }) as unknown as ArticleCampaign['variants'][number]['revisions'][number];
  const campaign = { variants: [{ id: 'v1', network: 'instagram', angle: 'launch', currentRevisionId: 'r2', revisions: [rev('r1'), rev('r2')] }, { id: 'v2', network: 'linkedin', angle: 'takeaway', currentRevisionId: 'r4', revisions: [rev('r3'), rev('r4', false)] }, { id: 'v3', currentRevisionId: 'r5', revisions: [rev('r5', false)] }],
    queueInstructions: [{ instruction: { variantId: 'v1', variantRevisionId: 'r1', queueIntentId: q } }] } as unknown as ArticleCampaign;
  assert.deepEqual(postUses(campaign, asset).map((u) => [u.variant.id, u.revision.id, u.plan?.instruction.queueIntentId ?? null]), [['v1', 'r1', q], ['v2', 'r3', null]]);
  assert.deepEqual(postUses({ ...campaign, queueInstructions: [{ instruction: { variantId: 'v1', variantRevisionId: 'r1', queueIntentId: q }, cancelled: true }] } as unknown as ArticleCampaign, asset).map((u) => u.revision.id), ['r2', 'r3'], 'a cancelled plan falls back to the current revision');
  // Tracked-link ladder with no CRM read available stays unknown rather than zero.
  const t = { ...h, route: 'tracked_link', trackedLink: { url: 'https://x.example/?utm_content=concept-1-csabcdef12', utmCampaign: 'x-abcdef12', utmContent: 'concept-1-csabcdef12', channel: 'email', concept: 0 } } as CreativeHandoff;
  assert.deepEqual(trackedLinkLadder(t, null).slice(4).map((s) => s.status), ['unknown', 'unknown', 'unknown'], 'email delivery is not recorded here, and no CRM read is not zero');
});

test('routes and tags are deterministic; paid channels are listed individually and none can activate spend', () => {
  assert.deepEqual(handoffRoute({ placement: 'portrait' }, 'article_campaign').route, 'article_media');
  assert.deepEqual(handoffRoute({ placement: 'landscape' }, 'article_campaign').route, 'article_media');
  assert.deepEqual(handoffRoute({ placement: 'article' }, 'article_campaign').route, 'article_media');
  assert.deepEqual(handoffRoute({ placement: 'square' }, 'article_campaign').route, 'export_only');
  assert.deepEqual(handoffRoute({ placement: 'portrait', media: 'video' }, 'article_campaign').route, 'export_only');
  assert.deepEqual(handoffRoute({ placement: 'vertical', media: 'video' }, 'creator_campaign').route, 'tracked_link');
  const id = '1a2b3c4d-0000-4000-8000-000000000000';
  assert.equal(creativeUtmContent(1, id), 'concept-2-cs1a2b3c4d');
  assert.deepEqual(parseCreativeUtmContent('concept-2-cs1a2b3c4d'), { concept: 1, creative: '1a2b3c4d' });
  assert.deepEqual(parseCreativeUtmContent('concept-3'), { concept: 2, creative: null });
  assert.equal(parseCreativeUtmContent('spring'), null);
  const brief = { name: 'Spring plan', cta: { label: 'Book', url: 'https://harbour.example/plan?ref=keep' } } as CreatorRecord['brief'];
  assert.equal(creativeTrackedLink(brief, id, proposal, 0, 'email', id)!.url, 'https://harbour.example/plan?ref=keep&utm_source=email&utm_medium=email&utm_campaign=spring-plan-1a2b3c4d&utm_content=concept-1-cs1a2b3c4d');
  assert.equal(creativeTrackedLink(brief, id, proposal, 1, 'email', id), null, 'unknown concept');
  assert.deepEqual(PAID_CHANNELS.map((c) => c.platform), ['meta', 'google', 'linkedin', 'tiktok']);
  assert.ok(PAID_CHANNELS.every((c) => /^(Never|Not available)/u.test(c.activation)));
});
