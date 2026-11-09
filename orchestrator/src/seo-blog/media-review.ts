/** Private quality review and fresh owner-use capabilities; no provider generation or publication. */
import { createHash } from 'node:crypto';
import type { SeoMediaAssetManifestInput, SeoMediaAuthorizationInput, SeoMediaCanonicalApproval, SeoMediaCanonicalManifest,
  SeoMediaAsset, SeoMediaCandidateInput, SeoMediaOwnerAuthorization, SeoMediaPreparation, SeoMediaPreparationInput, SeoMediaPrivateBytes, SeoMediaSocialUseInput, SeoMediaSocialAuthorization, SeoMediaUseInput, SeoMediaUseReservation, SeoMediaWithdrawal, SeoMediaWithdrawalInput } from './media-types.js';
import { prepareJpegVariants, JpegPreparationError, type JpegVariantProfile } from './jpeg-preparation.js';
import type { ArticleLocalImageProposal, LocalImageOrigin } from './image-campaign.js';
import { canonicalCompanyContentJson } from '../company-content-pg/validation.js';
import type { CompanyContentService } from '../company-content-pg/service.js';
import type { DatabaseRequestContext } from '../db/rls.js';
import type { SeoBlogStore } from './store.js';
import { SeoBlogError, type Article } from './types.js';

export interface MediaQualityReview {
  readonly commandId: string; readonly requestedBy: string; readonly observedAt: string; readonly expiresAt: string;
  readonly manifest: SeoMediaCanonicalManifest;
  readonly contentItemId: string | null; readonly contentVersionId: string | null;
  readonly canonical: SeoMediaCanonicalApproval | null;
}
export interface HeroMediaSelection {
  readonly reservation: SeoMediaUseReservation;
  readonly quality: SeoMediaCanonicalApproval;
  /** Genuine owner links are exact-version capabilities, never inherited approval. */
  readonly authorizations: readonly SeoMediaOwnerAuthorization[];
}
export interface ArticleMediaPort {
  persistCandidateReceipt(workspaceId: string, input: SeoMediaCandidateInput): Promise<SeoMediaAsset>;
  loadPrivateAsset(workspaceId: string, assetId: string, sha: string): Promise<SeoMediaPrivateBytes>;
  getAssetCanonicalManifest(workspaceId: string, input: SeoMediaAssetManifestInput): Promise<SeoMediaCanonicalManifest>;
  reserveMediaUse(workspaceId: string, input: SeoMediaUseInput): Promise<SeoMediaUseReservation>;
  recordOwnerImageAuthorization(workspaceId: string, input: SeoMediaAuthorizationInput): Promise<SeoMediaOwnerAuthorization>;
  recordOwnerSocialImageAuthorization(workspaceId: string, input: SeoMediaSocialUseInput): Promise<SeoMediaSocialAuthorization>;
  commitPreparation(workspaceId: string, input: SeoMediaPreparationInput): Promise<SeoMediaPreparation>;
  withdrawAssetOrRelease(workspaceId: string, input: SeoMediaWithdrawalInput): Promise<SeoMediaWithdrawal>;
}
async function ownerMediaCall<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof SeoBlogError) throw error;
    const code = (error as {code?:string}).code;
    if ((error as Error).name === 'InactivePortalSessionError') throw new SeoBlogError(401, 'Sign in again before reviewing or changing image uses.');
    if (code === '42501') throw new SeoBlogError(403, 'Your current owner session or brand image authority could not be confirmed.');
    if (code === '22023' || code === '23514') throw new SeoBlogError(400, 'Check the exact image, description and use details, then submit the saved form again.');
    if (code === 'P0002') throw new SeoBlogError(404, 'That private image or exact use receipt was not found.');
    if (code === '55000') throw new SeoBlogError(409, 'This image use is held or changed. Review its exact crop, quality decision, current article and withdrawal state.');
    if (code === '40001' || code === '23505') throw new SeoBlogError(409, 'Another exact image command or version changed. Refresh and recover the saved review before creating a new one.');
    throw error;
  }
}
/** Only genuine owner DB commands are translated; worker admission/unknown receipts retain their distinct contract. */
export function ownerMediaCommands(port: ArticleMediaPort): ArticleMediaPort {
  return {
    persistCandidateReceipt: (w, i) => ownerMediaCall(() => port.persistCandidateReceipt(w, i)),
    loadPrivateAsset: (w, a, s) => ownerMediaCall(() => port.loadPrivateAsset(w, a, s)),
    getAssetCanonicalManifest: (w, i) => ownerMediaCall(() => port.getAssetCanonicalManifest(w, i)),
    reserveMediaUse: (w, i) => ownerMediaCall(() => port.reserveMediaUse(w, i)),
    recordOwnerImageAuthorization: (w, i) => ownerMediaCall(() => port.recordOwnerImageAuthorization(w, i)),
    recordOwnerSocialImageAuthorization: (w, i) => ownerMediaCall(() => port.recordOwnerSocialImageAuthorization(w, i)),
    commitPreparation: (w, i) => ownerMediaCall(() => port.commitPreparation(w, i)),
    withdrawAssetOrRelease: (w, i) => ownerMediaCall(() => port.withdrawAssetOrRelease(w, i)),
  };
}
export interface ImageQualityApproval {
  approve(brandId: string, review: MediaQualityReview, recordDraft: (item: string, version: string) => Promise<void>): Promise<SeoMediaCanonicalApproval>;
}
export function mediaQualitySource(manifest: SeoMediaCanonicalManifest): { system: 'relaunch72.seo-media'; itemId: string; version: string } {
  const alt = createHash('sha256').update(manifest.presentation.alt, 'utf8').digest('hex');
  return { system: 'relaunch72.seo-media', itemId: manifest.assetId, version: `media:v1:${manifest.byteSha256}:${manifest.presentation.profile}:${alt}` };
}
export function canonicalImageQualityApproval(input: {
  context(brandId: string): DatabaseRequestContext;
  drafts: Pick<CompanyContentService, 'createVersion'>; approvals: Pick<CompanyContentService, 'requestApproval' | 'decideApproval'>;
  find(source: ReturnType<typeof mediaQualitySource>, contentSha: string, brandId: string): Promise<{ contentItemId: string; contentVersionId: string } | null>;
}): ImageQualityApproval {
  return { async approve(brandId, review, recordDraft) {
    const context = input.context(brandId), manifest = review.manifest;
    if (context.actorKind !== 'user' || !context.userId || context.userId !== review.requestedBy || context.workspaceId !== brandId) throw new SeoBlogError(403, 'A genuine owner session is required for image review.');
    const content = canonicalCompanyContentJson(manifest), contentSha = createHash('sha256').update(content).digest('hex'), source = mediaQualitySource(manifest);
    let itemId = review.contentItemId, versionId = review.contentVersionId;
    if (!itemId || !versionId) {
      const found = await input.find(source, contentSha, brandId);
      if (found) { itemId = found.contentItemId; versionId = found.contentVersionId; }
      else {
        const created = await input.drafts.createVersion(context, { commandKey: `seo-media-quality:${review.commandId}`, kind: 'image', origin: manifest.provenance.kind === 'generated' ? 'generated' : 'imported',
          title: `Reviewed ${manifest.presentation.profile} image`, contentMimeType: 'application/json', content, source,
          blob: { storageKey: `seo-blog-media/${manifest.assetId}/${manifest.byteSha256}`, sha256: manifest.byteSha256 },
          brand: { snapshotRef: `seo-blog-media/${brandId}/${manifest.provenance.brandSha256}`, sha256: manifest.provenance.brandSha256 },
          attestation: { catalogSha256: contentSha, checkedAt: review.observedAt, expiresAt: review.expiresAt } });
        itemId = created.contentItemId; versionId = created.contentVersionId;
      }
    }
    await recordDraft(itemId, versionId);
    const request = await input.approvals.requestApproval(context, { commandKey: `seo-media-quality:${review.commandId}:review`, contentItemId: itemId, contentVersionId: versionId, reviewNote: 'Owner reviewed the real private crop, pixel identity and exact alt text.' });
    const decided = await input.approvals.decideApproval(context, { commandKey: `seo-media-quality:${review.commandId}:approve`, approvalRequestId: request.approvalRequestId, decision: 'approved', decisionNote: 'Exact crop and presentation approved. Hero/social use remains a separate genuine owner command.' });
    return { contentItemId: itemId, contentVersionId: versionId, contentSha256: contentSha, approvalRequestId: request.approvalRequestId, approvalDecisionId: decided.approvalDecisionId };
  } };
}

export class ArticleMediaReviewService {
  constructor(private readonly store: SeoBlogStore, readonly media: ArticleMediaPort, private readonly quality: ImageQualityApproval, private readonly now: () => string) {}
  private async article(actorId: string, brandId: string, articleId: string): Promise<Article> {
    if (!await this.store.canManage(actorId, brandId)) throw new SeoBlogError(403, 'You cannot manage this brand.');
    const article = await this.store.getArticle(brandId, articleId); if (!article) throw new SeoBlogError(404, 'Article not found.'); return article;
  }
  async withdraw(actorId: string, brandId: string, articleId: string, input: SeoMediaWithdrawalInput): Promise<void> {
    const article = await this.article(actorId, brandId, articleId);
    const assetKnown = input.scope === 'asset' && ([...(article.imageProposals ?? []), ...(article.localImageProposals ?? [])].some(p => p.variants.some(v => v.assetId === input.assetId && v.sha256 === input.assetSha256))
      || (article.mediaQualityReviews ?? []).some(r => r.manifest.assetId === input.assetId && r.manifest.byteSha256 === input.assetSha256));
    const releaseKnown = input.scope === 'release' && article.heroMedia?.reservation.prospectiveReleaseId === input.releaseId && article.heroMedia.reservation.assetSha256 === input.assetSha256;
    if (!assetKnown && !releaseKnown) throw new SeoBlogError(404, 'That article media use was not found.');
    const result = await this.media.withdrawAssetOrRelease(brandId, input);
    const current = await this.article(actorId, brandId, articleId);
    if (!current.mediaWithdrawals?.some(w => w.id === result.id)) await this.store.updateArticle({ ...current, mediaWithdrawals: [...(current.mediaWithdrawals ?? []), result] });
  }
  /** `options` narrows preparation to exact-size formats for finished artwork (e.g. a Creative Studio hand-off); defaults are unchanged. */
  async upload(actorId: string, brandId: string, articleId: string, versionId: string, commandId: string, bytes: Buffer, filename: string,
    options: { readonly profiles?: readonly JpegVariantProfile[]; readonly origin?: LocalImageOrigin } = {}): Promise<ArticleLocalImageProposal> {
    await this.article(actorId, brandId, articleId);
    const version = await this.store.getVersion(brandId, versionId);
    if (!version || version.articleId !== articleId) throw new SeoBlogError(404, 'The source article version was not found.');
    if (!/\.jpe?g$/iu.test(filename) || bytes.byteLength < 1 || bytes.byteLength > 8 * 1024 * 1024) throw new SeoBlogError(400, 'Upload a JPEG original up to 8 MiB.');
    const brandSha256 = createHash('sha256').update(canonicalCompanyContentJson({ brandId, profileVersion: version.profileVersion, factsSha: version.factsSha, knowledge: version.knowledge })).digest('hex');
    const sourceName = filename.replace(/[^a-z0-9._ -]/giu, '').slice(-150) || 'Owner JPEG';
    const saved = await this.media.persistCandidateReceipt(brandId, { commandId, bytes, provenance: { kind: 'uploaded', brandSha256, sourceName }, receipt: { outcome: 'uploaded', code: 'uploaded', usage: null } });
    const sha = createHash('sha256').update(`seo-blog-upload-crops/v1:${commandId}`).digest('hex');
    const cropCommand = `${sha.slice(0, 8)}-${sha.slice(8, 12)}-5${sha.slice(13, 16)}-8${sha.slice(17, 20)}-${sha.slice(20, 32)}`;
    return this.crop(actorId, brandId, articleId, versionId, cropCommand, saved.id, saved.sha256, { x: .5, y: .5 }, options);
  }
  async crop(actorId: string, brandId: string, articleId: string, versionId: string, commandId: string, candidateAssetId: string, candidateSha256: string, focal: { x: number; y: number },
    options: { readonly profiles?: readonly JpegVariantProfile[]; readonly origin?: LocalImageOrigin } = {}): Promise<ArticleLocalImageProposal> {
    const article = await this.article(actorId, brandId, articleId);
    const previous = article.localImageProposals?.find(p => p.commandId === commandId);
    if (previous) {
      if (previous.candidateAssetId !== candidateAssetId || previous.candidateSha256 !== candidateSha256 || previous.articleVersionId !== versionId || previous.focal.x !== focal.x || previous.focal.y !== focal.y) throw new SeoBlogError(409, 'This crop command belongs to another exact image or focal point.');
      return previous;
    }
    if (article.currentVersionId !== versionId) throw new SeoBlogError(409, 'The blog changed. Refresh before preparing its crop.');
    if ((article.localImageProposals?.length ?? 0) >= 64) throw new SeoBlogError(409, 'The retained local crop limit was reached. Previous crops were not discarded.');
    const source = await this.media.loadPrivateAsset(brandId, candidateAssetId, candidateSha256);
    if (source.asset.kind !== 'candidate') throw new SeoBlogError(400, 'Choose the original saved candidate for a new crop.');
    // Pure bounded decoding occurs outside all database transactions and cannot call a provider.
    let prepared: ReturnType<typeof prepareJpegVariants>;
    try { prepared = prepareJpegVariants(source.bytes, { focal, ...(options.profiles ? { profiles: options.profiles } : {}) }); }
    catch (error) { if (error instanceof JpegPreparationError) throw new SeoBlogError(400, error.message); throw error; }
    const saved = await this.media.commitPreparation(brandId, { commandId, sourceAssetId: candidateAssetId, sourceSha256: candidateSha256,
      outcome: 'prepared', sourceDimensions: { width: prepared.original.width, height: prepared.original.height }, detail: null,
      variants: prepared.variants.map(v => ({ bytes: v.bytes, recipe: v.recipe! })) });
    const proposal: ArticleLocalImageProposal = { commandId, articleVersionId: versionId, candidateAssetId, candidateSha256, focal,
      variants: saved.variants.map(a => ({ assetId: a.id, sha256: a.sha256, profile: a.recipe!.profile, width: a.width!, height: a.height! })), preparedAt: this.now(),
      ...(options.origin ? { origin: options.origin } : {}) };
    const current = await this.article(actorId, brandId, articleId);
    if (current.currentVersionId !== versionId) throw new SeoBlogError(409, 'The blog changed while preparing its private crop. No review or public use was applied.');
    const retained = current.localImageProposals?.find(p => p.commandId === commandId);
    if (retained) return retained;
    await this.store.updateArticle({ ...current, localImageProposals: [...(current.localImageProposals ?? []), proposal] });
    return proposal;
  }
  async review(actorId: string, brandId: string, articleId: string, commandId: string, input: SeoMediaAssetManifestInput): Promise<MediaQualityReview> {
    let article = await this.article(actorId, brandId, articleId);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(commandId)) throw new SeoBlogError(400, 'Invalid review command.');
    let review = article.mediaQualityReviews?.find(r => r.commandId === commandId);
    if (review && (review.requestedBy !== actorId || review.manifest.assetId !== input.assetId || review.manifest.byteSha256 !== input.assetSha256 || review.manifest.presentation.profile !== input.profile || review.manifest.presentation.alt !== input.alt)) throw new SeoBlogError(409, 'This image review command belongs to different exact bytes or presentation.');
    if (review?.canonical) return review;
    if (!review) {
      if ((article.mediaQualityReviews?.length ?? 0) >= 128) throw new SeoBlogError(409, 'The retained image review limit was reached; earlier reviews were not discarded.');
      const manifest = await this.media.getAssetCanonicalManifest(brandId, input), now = this.now();
      review = { commandId, requestedBy: actorId, manifest, observedAt: now, expiresAt: new Date(Date.parse(now) + 15 * 60_000).toISOString(), contentItemId: null, contentVersionId: null, canonical: null };
      article = await this.store.updateArticle({ ...article, mediaQualityReviews: [...(article.mediaQualityReviews ?? []), review] });
    }
    const saved = review;
    const canonical = await this.quality.approve(brandId, saved, async (contentItemId, contentVersionId) => {
      const current = await this.article(actorId, brandId, articleId);
      await this.store.updateArticle({ ...current, mediaQualityReviews: (current.mediaQualityReviews ?? []).map(r => r.commandId === commandId ? { ...r, contentItemId, contentVersionId } : r) });
    });
    const current = await this.article(actorId, brandId, articleId);
    const completed = { ...saved, contentItemId: canonical.contentItemId, contentVersionId: canonical.contentVersionId, canonical };
    await this.store.updateArticle({ ...current, mediaQualityReviews: (current.mediaQualityReviews ?? []).map(r => r.commandId === commandId ? completed : r) });
    return completed;
  }
}
