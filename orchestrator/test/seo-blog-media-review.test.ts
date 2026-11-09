import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import test from 'node:test';
import { ArticleMediaReviewService, canonicalImageQualityApproval, mediaQualitySource, type ArticleMediaPort, type MediaQualityReview } from '../src/seo-blog/media-review.js';
import type { SeoMediaCanonicalManifest } from '../src/seo-blog/media-types.js';
import { canonicalCompanyContentJson } from '../src/company-content-pg/validation.js';
import { publicationMediaPin } from '../src/seo-blog/media-publication.js';
import type { Publication } from '../src/seo-blog/types.js';
import { campaignFixture } from './seo-blog-campaign-fixtures.js';
import { OWNER, STRANGER } from './seo-blog-fixtures.js';

function manifest(): SeoMediaCanonicalManifest {
  return { schema: 'relaunch72.seo-media/v1', assetId: randomUUID(), byteSha256: 'd'.repeat(64), byteLength: 1000, mimeType: 'image/jpeg', width: 1600, height: 900,
    recipe: { version: 'r72-jpeg-focal-v1', sourceSha256: 'e'.repeat(64), profile: 'blog', focal: { x: .5, y: .5 }, crop: { x: 0, y: 0, width: 1600, height: 900 }, width: 1600, height: 900, quality: 85, metadataStripped: true },
    presentation: { profile: 'blog', alt: 'An illustrative considered decision' }, provenance: { kind: 'uploaded', brandSha256: 'f'.repeat(64), sourceName: 'Owner supplied JPEG' } };
}
test('canonical image quality binds actual stored manifest/alt and preserves draft identity after lost approval acknowledgement', async () => {
  const f = await campaignFixture(), stored = manifest();
  let fail = true, created = 0, requested = 0; const item = randomUUID(), version = randomUUID();
  const bodySha = createHash('sha256').update(canonicalCompanyContentJson(stored)).digest('hex'), approvalRequestId = randomUUID();
  const reviewPort = canonicalImageQualityApproval({ context: brandId => ({ actorKind: 'user', userId: OWNER.userId, workspaceId: brandId, requestId: 'quality-test' }),
    find: async () => null, drafts: { async createVersion(_context, command) {
      created++; assert.equal(command.source.system, 'relaunch72.seo-media'); assert.equal(command.kind, 'image');
      assert.equal(command.blob.sha256, stored.byteSha256); assert.deepEqual(JSON.parse(command.content), stored);
      return { disposition: 'applied', contentItemId: item, contentVersionId: version, versionNumber: 1, contentSha256: createHash('sha256').update(command.content).digest('hex'), sourceAttestationId: randomUUID(), sourceAttestationExpiresAt: '2026-11-02T10:15:00.000Z' };
    } }, approvals: { async requestApproval() { requested++; if (fail) { fail = false; throw new Error('Lost database acknowledgement after draft commit'); } return { disposition: 'applied', approvalRequestId, contentItemId: item, contentVersionId: version, requestNumber: 1, contentSha256: bodySha }; },
      async decideApproval() { return { disposition: 'applied', approvalDecisionId: randomUUID(), approvalRequestId, contentItemId: item, contentVersionId: version, decision: 'approved', contentSha256: bodySha }; } } });
  const media = { async getAssetCanonicalManifest() { return stored; } } as Pick<ArticleMediaPort, 'getAssetCanonicalManifest'>;
  // Other media effects are deliberately absent; this journey cannot generate, release or send.
  const port: ArticleMediaPort = { ...media, withdrawAssetOrRelease: async () => { throw Error('unused'); }, persistCandidateReceipt: async () => { throw Error('unused'); }, loadPrivateAsset: async () => { throw Error('unused'); }, reserveMediaUse: async () => { throw Error('unused'); }, recordOwnerImageAuthorization: async () => { throw Error('unused'); }, recordOwnerSocialImageAuthorization: async () => { throw Error('unused'); }, commitPreparation: async () => { throw Error('unused'); } };
  const service = new ArticleMediaReviewService(f.h.store, port, reviewPort, f.h.clock.now), command = randomUUID();
  const input = { assetId: stored.assetId, assetSha256: stored.byteSha256, ...stored.presentation };
  await assert.rejects(service.review(OWNER.userId, f.brand.id, f.article.id, command, input), /Lost database/);
  const saved = (await f.h.store.getArticle(f.brand.id, f.article.id))!.mediaQualityReviews![0]!;
  assert.equal(saved.contentItemId, item); assert.equal(saved.contentVersionId, version); assert.equal(saved.canonical, null);
  const approved = await service.review(OWNER.userId, f.brand.id, f.article.id, command, input);
  assert.equal(created, 1); assert.equal(requested, 2); assert.equal(approved.canonical!.contentVersionId, version);
  assert.equal(approved.canonical!.contentSha256, createHash('sha256').update(canonicalCompanyContentJson(stored)).digest('hex'));
  await assert.rejects(service.review(OWNER.userId, f.brand.id, f.article.id, command, { ...input, alt: 'Different alt text' }), /different exact/);
  await assert.rejects(service.review(STRANGER.userId, f.brand.id, f.article.id, randomUUID(), input), /cannot manage/);
  assert.equal(f.h.llm.calls.length, 0);
});
test('media quality source presentation identity is independent of hero or social use IDs', () => {
  const m = manifest(), source = mediaQualitySource(m);
  assert.equal(source.version, mediaQualitySource({ ...m, recipe: { ...m.recipe } }).version);
  assert.notEqual(source.version, mediaQualitySource({ ...m, presentation: { ...m.presentation, alt: 'A changed exact description' } }).version);
});
