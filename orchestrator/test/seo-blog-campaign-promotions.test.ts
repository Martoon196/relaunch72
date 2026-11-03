import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import jpeg from 'jpeg-js';
import { campaignPromotionCommand } from '../src/seo-blog/campaign-promotions.js';
import { createCampaignRevision, SEO_CAMPAIGN_SCHEMA, type ArticleCampaign, type CampaignMedia, type CampaignObservation, type CampaignVariant } from '../src/seo-blog/campaign.js';
import { parseCompanyContentSocialDraft } from '../src/company-content-pg/validation.js';
import { socialImageFromDataUrl } from '../src/company-content-pg/social-image.js';
import type { ArticlePromotionPack, PromotionNetwork } from '../src/seo-blog/types.js';

const BRAND = randomUUID(), ARTICLE = randomUUID(), VERSION = randomUUID(), OWNER = randomUUID(), SHA = 'a'.repeat(64), AT = '2026-11-03T12:00:00.000Z';
const bytes = jpeg.encode({ width: 1080, height: 1350, data: Buffer.alloc(1080 * 1350 * 4, 255) }, 70).data;
const image = socialImageFromDataUrl(`data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`, 'Editorial illustration of a considered decision');
function fixture(network: PromotionNetwork = 'linkedin', withImage = false) {
  const id = randomUUID(), url = 'https://harbour.example/blog/decisions';
  const media: CampaignMedia | null = withImage ? { useId: randomUUID(), assetId: randomUUID(), assetSha256: image.sha256, profile: network, alt: image.alt,
    canonical: { contentItemId: randomUUID(), contentVersionId: randomUUID(), contentSha256: 'b'.repeat(64), approvalRequestId: randomUUID(), approvalDecisionId: randomUUID() } } : null;
  const revision = createCampaignRevision({ variantId: id, articleVersionId: VERSION, articleContentSha: SHA, canonicalUrl: url, network, angle: 'launch', title: 'Check before deciding',
    copy: 'One practical takeaway: ask which evidence supports the next decision.', artworkInstructions: 'Quiet editorial illustration; no invented case study.', media, createdAt: AT, createdBy: 'system' });
  const variant: CampaignVariant = { id, network, angle: 'launch', currentRevisionId: revision.id, revisions: [revision], omitted: false, pinnedSchedule: null, approval: null };
  const campaign: ArticleCampaign = { schema: SEO_CAMPAIGN_SCHEMA, articleVersionId: VERSION, articleContentSha: SHA, variants: [variant] };
  const observation: CampaignObservation = { id: randomUUID(), purpose: 'approve', variantId: id, revisionId: revision.id, revisionSha256: revision.sha256, observedAt: AT, expiresAt: '2026-11-03T12:15:00.000Z', observedBy: OWNER, contentItemId: null, contentVersionId: null };
  const promotionPack: ArticlePromotionPack = { source: 'relaunch72.seo-blog', brandId: BRAND, articleId: ARTICLE, versionId: VERSION, contentSha: SHA, profileVersion: 1, factsSha: SHA, canonicalUrl: url, generation: null, mode: 'excerpt_fallback', posts: [] };
  return { brand: { id: BRAND }, article: { id: ARTICLE, brandId: BRAND, currentVersionId: VERSION, delivery: 'none' as const, publishedVersionId: null, publishedUrl: null },
    version: { id: VERSION, brandId: BRAND, articleId: ARTICLE, contentSha: SHA, profileVersion: 1, factsSha: SHA, knowledge: [], promotionPack }, campaign, variant, observation, inlineImage: withImage ? image : null };
}

test('campaign command reuses the combined format with genuine SEO identity and exact plain publication body inside it', () => {
  const f = fixture(); const command = campaignPromotionCommand(f);
  assert.equal(command.source.system, 'relaunch72.seo-blog'); assert.match(command.source.itemId, new RegExp(f.variant.id));
  assert.match(command.source.version, new RegExp(`campaign:v1:${VERSION}:${f.variant.currentRevisionId}:`));
  assert.deepEqual(command, campaignPromotionCommand(f), 'same durable observation replays identical bytes/key');
  const review = parseCompanyContentSocialDraft(command.content);
  assert.equal(review.platform, 'linkedin'); assert.equal(review.type, 'seo_campaign'); assert.equal(review.kind, 'article_promotion');
  assert.equal(review.publicationCopy, `${f.variant.revisions[0]!.copy}\n\n${f.version.promotionPack.canonicalUrl}`);
  assert.equal(command.blob.sha256, createHash('sha256').update(command.content).digest('hex'));
  assert.equal((command.metadata as Record<string, unknown>).variantSha256, f.variant.revisions[0]!.sha256);
  assert.notEqual(createHash('sha256').update(review.publicationCopy).digest('hex'), command.blob.sha256, 'wire text and canonical envelope hashes remain distinct');
});

test('Instagram binds the actual approved crop bytes/alt and cannot inherit an image from another revision', () => {
  const f = fixture('instagram', true), command = campaignPromotionCommand(f);
  const review = parseCompanyContentSocialDraft(command.content);
  assert.deepEqual(review.image, image);
  assert.equal((command.metadata as Record<string, unknown>).mediaAssetId, f.variant.revisions[0]!.media!.assetId);
  assert.throws(() => campaignPromotionCommand({ ...f, inlineImage: null }), /exact prepared image/);
  assert.throws(() => campaignPromotionCommand({ ...f, inlineImage: { ...image, alt: 'Changed alt after review' } }), /alt text changed/);
  assert.throws(() => campaignPromotionCommand(fixture('instagram')), /real reviewed image/);
  assert.doesNotThrow(() => campaignPromotionCommand(fixture('linkedin')), 'missing IG media never blocks a separate text LinkedIn post');
});

test('changed parent URL/revision observation or omitted variant cannot create a review command', () => {
  const f = fixture();
  assert.throws(() => campaignPromotionCommand({ ...f, observation: { ...f.observation, revisionId: randomUUID() } }), /different reviewed bytes/);
  assert.throws(() => campaignPromotionCommand({ ...f, variant: { ...f.variant, omitted: true } }), /omitted/);
  assert.throws(() => campaignPromotionCommand({ ...f, version: { ...f.version, promotionPack: { ...f.version.promotionPack, canonicalUrl: 'https://harbour.example/blog/new-url' } } }), /URL does not match/);
});
