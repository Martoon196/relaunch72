/** Native campaign controls. Canonical commands still own review/queue authority. */
import { randomUUID } from 'node:crypto';
import type { CompanyContentSocialImage } from '../company-content-pg/social-image.js';
import { appendCampaignRevision, createCampaignRevision, currentCampaignRevision, campaignParentHold,
  type ArticleCampaign, type CampaignMedia, type CampaignObservation, type CampaignVariant } from './campaign.js';
import type { CampaignPromotionApproval } from './campaign-promotions.js';
import { localToUtc } from './schedule.js';
import type { SeoBlogStore } from './store.js';
import { SeoBlogError, type Article, type ArticleVersion, type Brand } from './types.js';

export interface CampaignReviewPorts {
  readonly approval: CampaignPromotionApproval;
  /** Authenticated private asset lookup; verifies stored bytes, not a caller URL. */
  loadImage(brandId: string, media: CampaignMedia): Promise<CompanyContentSocialImage>;
  authorizeImage(brandId: string, input: import('./media-types.js').SeoMediaSocialUseInput): Promise<import('./media-types.js').SeoMediaSocialAuthorization>;
}
export interface CampaignSelection { readonly variantId: string; readonly revisionId: string }
export class SeoBlogCampaignService {
  constructor(private readonly store: SeoBlogStore, private readonly now: () => string, private readonly review?: CampaignReviewPorts) {}

  private async source(actorId: string, brandId: string, articleId: string, versionId: string): Promise<{ brand: Brand; article: Article; version: ArticleVersion; campaign: ArticleCampaign }> {
    if (!await this.store.canManage(actorId, brandId)) throw new SeoBlogError(403, 'You cannot manage this brand.');
    const brand = await this.store.getBrand(brandId), article = await this.store.getArticle(brandId, articleId);
    const version = await this.store.getVersion(brandId, versionId);
    if (!brand || !article || !version || version.articleId !== articleId) throw new SeoBlogError(404, 'That campaign was not found.');
    if (article.currentVersionId !== versionId) throw new SeoBlogError(409, 'The blog changed. Refresh before editing its campaign.');
    if (!article.campaign) throw new SeoBlogError(409, 'This article has no saved campaign yet.');
    return { brand, article, version, campaign: article.campaign };
  }
  private selected(campaign: ArticleCampaign, selection: CampaignSelection): CampaignVariant {
    const variant = campaign.variants.find(v => v.id === selection.variantId);
    if (!variant || variant.currentRevisionId !== selection.revisionId) throw new SeoBlogError(409, 'This post changed. Refresh before continuing.');
    currentCampaignRevision(variant); return variant;
  }
  async edit(actorId: string, brandId: string, articleId: string, versionId: string, selection: CampaignSelection, edits: { title: string; copy: string; artworkInstructions: string }): Promise<Article> {
    const { article, version, campaign } = await this.source(actorId, brandId, articleId, versionId);
    const variant = this.selected(campaign, selection), old = currentCampaignRevision(variant);
    if (campaign.articleVersionId !== version.id || campaign.articleContentSha !== version.contentSha) throw new SeoBlogError(409, 'Rebase the campaign explicitly before editing an earlier blog version.');
    const next = createCampaignRevision({ ...old, ...edits, id: randomUUID(),
      media: old.media ? { ...old.media, useId: randomUUID() } : null, createdAt: this.now(), createdBy: actorId });
    return this.store.updateArticle({ ...article, campaign: appendCampaignRevision(campaign, variant.id, old.id, next) });
  }
  async control(actorId: string, brandId: string, articleId: string, versionId: string, selection: CampaignSelection, control:
    { kind: 'omit'; omitted: boolean } | { kind: 'pin'; localDate: string; localTime: string } | { kind: 'relative' }): Promise<Article> {
    const { brand, article, campaign } = await this.source(actorId, brandId, articleId, versionId);
    const variant = this.selected(campaign, selection);
    let next = variant;
    if (control.kind === 'omit') next = { ...variant, omitted: control.omitted };
    else if (control.kind === 'relative') next = { ...variant, pinnedSchedule: null };
    else {
      const resolved = localToUtc(control.localDate, control.localTime, brand.timezone);
      if (resolved.adjusted !== 'none') throw new SeoBlogError(400, 'That local time is missing or repeated because the clocks change. Choose an unambiguous time.');
      if (Date.parse(resolved.utc) <= Date.parse(this.now())) throw new SeoBlogError(400, 'Choose a future post time.');
      next = { ...variant, pinnedSchedule: { scheduledFor: resolved.utc, localDate: control.localDate, localTime: control.localTime, timezone: brand.timezone, setAt: this.now(), setBy: actorId } };
    }
    // Date/selection are controls, not reviewed content. Never mutate a revision or its approval.
    return this.store.updateArticle({ ...article, campaign: { ...campaign, variants: campaign.variants.map(v => v.id === variant.id ? next : v) } });
  }
  async rebase(actorId: string, brandId: string, articleId: string, versionId: string): Promise<Article> {
    const { article, version, campaign } = await this.source(actorId, brandId, articleId, versionId);
    const canonicalUrl = version.promotionPack?.canonicalUrl ?? null;
    if (campaign.articleVersionId === version.id && campaign.articleContentSha === version.contentSha
      && campaign.variants.every(v => currentCampaignRevision(v).canonicalUrl === canonicalUrl)) return article;
    const variants = campaign.variants.map(v => {
      if (v.revisions.length >= 64) throw new SeoBlogError(409, 'This campaign has reached its retained revision limit.');
      const old = currentCampaignRevision(v);
      const revision = createCampaignRevision({ ...old, id: randomUUID(), articleVersionId: version.id, articleContentSha: version.contentSha, canonicalUrl,
        media: old.media ? { ...old.media, useId: randomUUID() } : null, createdAt: this.now(), createdBy: actorId });
      return { ...v, currentRevisionId: revision.id, revisions: [...v.revisions, revision], approval: null,
        ...(v.approval ? { approvalHistory: [...(v.approvalHistory ?? []), v.approval] } : {}) };
    });
    // Explicit owner rebase keeps text, pins, omissions and all old revisions; use/post approvals must be renewed.
    return this.store.updateArticle({ ...article, campaign: { ...campaign, articleVersionId: version.id, articleContentSha: version.contentSha, variants } });
  }
  async selectImage(actorId: string, brandId: string, articleId: string, versionId: string, selection: CampaignSelection, commandId: string, qualityCommandId: string): Promise<Article> {
    if (!this.review) throw new SeoBlogError(503, 'Campaign image use is not configured.');
    let { article, version, campaign } = await this.source(actorId, brandId, articleId, versionId);
    const quality = article.mediaQualityReviews?.find(r => r.commandId === qualityCommandId);
    if (!quality?.canonical) throw new SeoBlogError(409, 'Review the exact real crop and alt text first.');
    let variant = campaign.variants.find(v => v.id === selection.variantId);
    if (!variant) throw new SeoBlogError(409, 'The selected post changed.');
    let revision = currentCampaignRevision(variant);
    const manifest = quality.manifest;
    if (manifest.presentation.profile !== variant.network) throw new SeoBlogError(400, 'Select the prepared crop for this channel.');
    if (campaign.articleVersionId !== version.id || campaign.articleContentSha !== version.contentSha) throw new SeoBlogError(409, 'Rebase the campaign to the current blog before selecting a new image.');
    if (revision.id !== commandId) {
      this.selected(campaign, selection);
      const media: CampaignMedia = { useId: randomUUID(), assetId: manifest.assetId, assetSha256: manifest.byteSha256,
        profile: variant.network, alt: manifest.presentation.alt, canonical: quality.canonical };
      revision = createCampaignRevision({ ...revision, id: commandId, media, createdAt: this.now(), createdBy: actorId });
      campaign = appendCampaignRevision(campaign, variant.id, variant.currentRevisionId, revision);
      article = await this.store.updateArticle({ ...article, campaign });
      variant = campaign.variants.find(v => v.id === selection.variantId)!;
    }
    const media = revision.media;
    if (!media || media.assetId !== manifest.assetId || media.assetSha256 !== manifest.byteSha256 || media.alt !== manifest.presentation.alt
      || media.canonical.contentVersionId !== quality.canonical.contentVersionId) throw new SeoBlogError(409, 'This image-use command belongs to a different exact crop or presentation.');
    const authorized = await this.review.authorizeImage(brandId, { commandId, useId: media.useId, articleId, articleVersionId: version.id, articleContentSha: version.contentSha,
      variantId: variant.id, variantRevisionId: revision.id, variantSha256: revision.sha256, network: variant.network,
      assetId: media.assetId, assetSha256: media.assetSha256, profile: media.profile, alt: media.alt, canonical: media.canonical });
    const current = await this.source(actorId, brandId, articleId, versionId);
    this.selected(current.campaign, { variantId: variant.id, revisionId: revision.id });
    return this.store.updateArticle({ ...current.article, campaign: { ...current.campaign, variants: current.campaign.variants.map(v => v.id === variant!.id
      ? { ...v, mediaAuthorization: { revisionId: revision.id, revisionSha256: revision.sha256, mediaUseId: media.useId, authorizationId: authorized.id } } : v) } });
  }
  async approve(actorId: string, brandId: string, articleId: string, versionId: string, selection: CampaignSelection): Promise<Article> {
    if (!this.review) throw new SeoBlogError(503, 'Canonical campaign review is not configured. No approval was recorded.');
    let { brand, article, version, campaign } = await this.source(actorId, brandId, articleId, versionId);
    let variant = this.selected(campaign, selection);
    const revision = currentCampaignRevision(variant), hold = campaignParentHold(article, version, campaign, variant, false);
    if (hold) throw new SeoBlogError(409, hold);
    if (revision.media && (variant.mediaAuthorization?.revisionId !== revision.id || variant.mediaAuthorization.revisionSha256 !== revision.sha256 || variant.mediaAuthorization.mediaUseId !== revision.media.useId)) throw new SeoBlogError(409, 'Authorize the exact reviewed image use for this post revision first.');
    if (variant.approval?.revisionId === revision.id && variant.approval.revisionSha256 === revision.sha256) return article;
    const now = this.now(), ms = Date.parse(now);
    let observation = (variant.observations ?? []).find(o => o.purpose === 'approve' && o.revisionId === revision.id && o.revisionSha256 === revision.sha256
      && o.observedBy === actorId && Date.parse(o.expiresAt) > ms && (o.contentVersionId || ms - Date.parse(o.observedAt) <= 120_000));
    if (!observation) {
      observation = { id: randomUUID(), purpose: 'approve', variantId: variant.id, revisionId: revision.id, revisionSha256: revision.sha256,
        observedAt: now, expiresAt: new Date(ms + 15 * 60_000).toISOString(), observedBy: actorId, contentItemId: null, contentVersionId: null };
      variant = { ...variant, observations: [...(variant.observations ?? []).slice(-31), observation] };
      campaign = { ...campaign, variants: campaign.variants.map(v => v.id === variant.id ? variant : v) };
      article = await this.store.updateArticle({ ...article, campaign });
    }
    const exactObservation: CampaignObservation = observation;
    const approval = await this.review.approval.approve({ brand, article, version, campaign, variant, observation: exactObservation,
      inlineImage: revision.media ? await this.review.loadImage(brandId, revision.media) : null,
      recordDraft: async (contentItemId, contentVersionId) => {
        const current = await this.source(actorId, brandId, articleId, versionId);
        const selected = this.selected(current.campaign, selection);
        const observations = (selected.observations ?? []).map(o => o.id === exactObservation.id ? { ...o, contentItemId, contentVersionId } : o);
        await this.store.updateArticle({ ...current.article, campaign: { ...current.campaign, variants: current.campaign.variants.map(v => v.id === selected.id ? { ...v, observations } : v) } });
      } });
    const current = await this.source(actorId, brandId, articleId, versionId);
    this.selected(current.campaign, selection);
    return this.store.updateArticle({ ...current.article, campaign: { ...current.campaign, variants: current.campaign.variants.map(v => v.id === selection.variantId ? { ...v, approval } : v) } });
  }
}
