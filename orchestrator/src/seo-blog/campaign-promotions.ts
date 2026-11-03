/** Genuine SEO source in the established combined-social format; never PP source identity. */
import { createHash } from 'node:crypto';
import { canonicalCompanyContentJson, canonicalCompanyContentSocialDraft } from '../company-content-pg/validation.js';
import { COMPANY_CONTENT_SOCIAL_DRAFT_MIME_TYPE, type CreateCompanyContentVersionCommand } from '../company-content-pg/types.js';
import type { CompanyContentService } from '../company-content-pg/service.js';
import type { DatabaseRequestContext } from '../db/rls.js';
import { parseCompanyContentSocialImage, type CompanyContentSocialImage } from '../company-content-pg/social-image.js';
import { campaignParentHold, campaignSource, currentCampaignRevision, SEO_CAMPAIGN_SCHEMA, type ArticleCampaign, type CampaignObservation, type CampaignPostApproval, type CampaignVariant } from './campaign.js';
import { JPEG_VARIANT_PROFILES } from './jpeg-preparation.js';
import { SeoBlogError, type Article, type ArticleVersion, type Brand } from './types.js';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
export function campaignPromotionCommand(input: {
  readonly brand: Pick<Brand, 'id'>;
  readonly article: Pick<Article, 'id' | 'brandId' | 'currentVersionId' | 'delivery' | 'publishedVersionId' | 'publishedUrl'>;
  readonly version: Pick<ArticleVersion, 'id' | 'brandId' | 'articleId' | 'contentSha' | 'profileVersion' | 'factsSha' | 'knowledge' | 'promotionPack'>;
  readonly campaign: ArticleCampaign;
  readonly variant: CampaignVariant;
  readonly observation: CampaignObservation;
  readonly inlineImage: CompanyContentSocialImage | null;
}): CreateCompanyContentVersionCommand {
  const { brand, article, version, campaign, variant, observation } = input;
  const hold = campaignParentHold(article, version, campaign, variant, false);
  if (hold) throw new SeoBlogError(409, hold);
  const revision = currentCampaignRevision(variant);
  if (!revision.canonicalUrl) throw new SeoBlogError(409, 'Bind the exact blog URL in a new campaign revision before approval.');
  if (brand.id !== version.brandId || article.brandId !== brand.id || version.articleId !== article.id
    || version.promotionPack?.canonicalUrl !== revision.canonicalUrl) throw new SeoBlogError(409, 'The campaign URL does not match the reviewed article.');
  if (observation.variantId !== variant.id || observation.revisionId !== revision.id || observation.revisionSha256 !== revision.sha256) throw new SeoBlogError(409, 'This campaign observation belongs to different reviewed bytes.');
  let image: CompanyContentSocialImage | null = null;
  if (revision.media) {
    if (!input.inlineImage) throw new SeoBlogError(409, 'Load the exact prepared image before reviewing this post.');
    image = parseCompanyContentSocialImage(input.inlineImage);
    const crop = JPEG_VARIANT_PROFILES[revision.network];
    if (image.sha256 !== revision.media.assetSha256 || image.alt !== revision.media.alt || image.width !== crop.width || image.height !== crop.height) throw new SeoBlogError(409, 'The image bytes, crop or alt text changed. Review a new campaign revision.');
  } else if (input.inlineImage) throw new SeoBlogError(409, 'This image was not part of the saved campaign revision.');
  if (revision.network === 'instagram' && !image) throw new SeoBlogError(409, 'Instagram needs a real reviewed image crop.');
  const publicationCopy = `${revision.copy}\n\n${revision.canonicalUrl}`;
  if (publicationCopy.length > (revision.network === 'instagram' ? 2200 : 3000)) throw new SeoBlogError(400, 'Shorten this post so its exact copy and blog link fit the channel limit.');
  const content = canonicalCompanyContentSocialDraft({ type: 'seo_campaign', kind: 'article_promotion', platform: revision.network,
    title: revision.title, publicationCopy, artworkInstructions: revision.artworkInstructions,
    ctaUrl: revision.canonicalUrl, contextSha256: revision.sha256, image });
  const source = campaignSource(brand.id, article.id, revision);
  return { commandKey: `seo-campaign:${revision.id}:${observation.id}`, origin: 'generated', kind: 'social_post', title: revision.title,
    contentMimeType: COMPANY_CONTENT_SOCIAL_DRAFT_MIME_TYPE, content, source,
    blob: { storageKey: `seo-blog-campaign/${brand.id}/${variant.id}/${revision.id}`, sha256: sha(content) },
    brand: { snapshotRef: `seo-blog/${brand.id}/profile/${version.profileVersion}`, sha256: sha(canonicalCompanyContentJson({ brandId: brand.id, profileVersion: version.profileVersion, factsSha: version.factsSha, knowledge: version.knowledge })) },
    attestation: { catalogSha256: revision.sha256, checkedAt: observation.observedAt, expiresAt: observation.expiresAt },
    metadata: { source: 'relaunch72.seo-blog', campaignSchema: SEO_CAMPAIGN_SCHEMA, brandId: brand.id, articleId: article.id,
      articleVersionId: version.id, articleContentSha: version.contentSha, canonicalUrl: revision.canonicalUrl, network: revision.network,
      variantId: variant.id, variantRevisionId: revision.id, variantSha256: revision.sha256, observationId: observation.id,
      ...(revision.media ? { mediaUseId: revision.media.useId, mediaAssetId: revision.media.assetId, mediaSha256: revision.media.assetSha256 } : {}) } };
}

export type CampaignPromotionApprovalInput = Parameters<typeof campaignPromotionCommand>[0] & {
  /** Save the durable canonical identity before proceeding to its approval. */
  recordDraft(contentItemId: string, contentVersionId: string): Promise<void>;
};
export interface CampaignPromotionApproval {
  approve(input: CampaignPromotionApprovalInput): Promise<CampaignPostApproval>;
}

/** User-only canonical commands; the injected runner guards the exact native source on each transaction. */
export function canonicalCampaignApproval(input: {
  context(brandId: string): DatabaseRequestContext;
  drafts: Pick<CompanyContentService, 'createVersion'>;
  approvals: Pick<CompanyContentService, 'requestApproval' | 'decideApproval'>;
  findDraft(command: CreateCompanyContentVersionCommand): Promise<{ contentItemId: string; contentVersionId: string } | null>;
}): CampaignPromotionApproval {
  return { async approve(request) {
    const context = input.context(request.brand.id);
    if (context.actorKind !== 'user' || !context.userId || context.workspaceId !== request.brand.id || request.observation.observedBy !== context.userId) throw new SeoBlogError(403, 'A genuine owner session is required to approve campaign posts.');
    const command = campaignPromotionCommand(request);
    let contentItemId = request.observation.contentItemId, contentVersionId = request.observation.contentVersionId;
    if (!contentItemId || !contentVersionId) {
      const existing = await input.findDraft(command);
      if (existing) { contentItemId = existing.contentItemId; contentVersionId = existing.contentVersionId; }
      else {
        const created = await input.drafts.createVersion(context, command);
        contentItemId = created.contentItemId; contentVersionId = created.contentVersionId;
      }
    }
    await request.recordDraft(contentItemId, contentVersionId);
    const review = await input.approvals.requestApproval(context, { commandKey: `${command.commandKey}:review`, contentItemId, contentVersionId,
      reviewNote: 'Owner reviewed this exact campaign variant text, link and image crop/alt where present.' });
    const decision = await input.approvals.decideApproval(context, { commandKey: `${command.commandKey}:approve`, approvalRequestId: review.approvalRequestId,
      decision: 'approved', decisionNote: 'Approved the exact displayed campaign variant. Scheduling and public delivery remain separately gated.' });
    const revision = currentCampaignRevision(request.variant);
    return { revisionId: revision.id, revisionSha256: revision.sha256, contentItemId, contentVersionId,
      contentSha256: command.blob.sha256, approvalRequestId: review.approvalRequestId, approvalDecisionId: decision.approvalDecisionId };
  } };
}
