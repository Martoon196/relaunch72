/** Exact campaign revisions. Dates/selection are controls, never edits to reviewed bytes. */
import { createHash, randomUUID } from 'node:crypto';
import { canonicalCompanyContentJson } from '../company-content-pg/validation.js';
import { SeoBlogError, type Article, type ArticleBody, type ArticleVersion, type PromotionNetwork } from './types.js';
import { addDays, utcToLocal, zoneOffsetMs } from './schedule.js';

export const SEO_CAMPAIGN_SCHEMA = 'relaunch72.seo-campaign/v1' as const;
export const SEO_CAMPAIGN_RECIPE = 'r72-social-three-angle-v1' as const;
export const CAMPAIGN_ANGLES = ['launch', 'takeaway', 'follow_up'] as const;
export const CAMPAIGN_NETWORKS = ['instagram', 'linkedin'] as const;
export type CampaignAngle = typeof CAMPAIGN_ANGLES[number];
export const CAMPAIGN_RELATIVE_DAYS: Readonly<Record<CampaignAngle, number>> = Object.freeze({ launch: 0, takeaway: 3, follow_up: 7 });

export interface CampaignImageApproval {
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly approvalRequestId: string;
  readonly approvalDecisionId: string;
}
export interface CampaignMedia {
  /** Prospective identity; only its genuine owner-use receipt grants use. */
  readonly useId: string;
  readonly assetId: string;
  readonly assetSha256: string;
  readonly profile: PromotionNetwork;
  readonly alt: string;
  readonly canonical: CampaignImageApproval;
}
export interface CampaignRevision {
  readonly id: string;
  readonly variantId: string;
  readonly articleVersionId: string;
  readonly articleContentSha: string;
  readonly canonicalUrl: string | null;
  readonly network: PromotionNetwork;
  readonly angle: CampaignAngle;
  readonly recipe: typeof SEO_CAMPAIGN_RECIPE;
  readonly title: string;
  readonly copy: string;
  readonly artworkInstructions: string;
  readonly relativeDays: number;
  readonly media: CampaignMedia | null;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly sha256: string;
}
export interface CampaignPinnedSchedule {
  readonly scheduledFor: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly timezone: string;
  readonly setBy: string;
  readonly setAt: string;
}
export interface CampaignPostApproval {
  readonly revisionId: string;
  readonly revisionSha256: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly approvalRequestId: string;
  readonly approvalDecisionId: string;
}
export interface CampaignObservation {
  readonly id: string;
  readonly purpose: 'approve' | 'schedule';
  readonly variantId: string;
  readonly revisionId: string;
  readonly revisionSha256: string;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly observedBy: string;
  readonly contentItemId: string | null;
  readonly contentVersionId: string | null;
}
export interface CampaignVariant {
  /** Display receipt only; SQL derives actual authority from the immutable owner-use ledger. */
  readonly mediaAuthorization?: { readonly revisionId: string; readonly revisionSha256: string; readonly mediaUseId: string; readonly authorizationId: string };
  readonly id: string;
  readonly network: PromotionNetwork;
  readonly angle: CampaignAngle;
  readonly currentRevisionId: string;
  readonly revisions: readonly CampaignRevision[];
  readonly omitted: boolean;
  readonly pinnedSchedule: CampaignPinnedSchedule | null;
  readonly approval: CampaignPostApproval | null;
  readonly approvalHistory?: readonly CampaignPostApproval[];
  readonly observations?: readonly CampaignObservation[];
}
export interface ArticleCampaign {
  readonly queueInstructions?: readonly import('./campaign-queue.js').CampaignQueuePointer[];
  readonly schema: typeof SEO_CAMPAIGN_SCHEMA;
  readonly articleVersionId: string;
  readonly articleContentSha: string;
  readonly variants: readonly CampaignVariant[];
  readonly mode?: 'model' | 'excerpt_fallback';
  readonly generation?: import('./types.js').GenerationRecord | null;
}
export interface CampaignDraft {
  readonly network: PromotionNetwork;
  readonly angle: CampaignAngle;
  readonly title: string;
  readonly copy: string;
  readonly artworkInstructions: string;
}

/** Truthfully labelled article-text fallback; it never claims to be model-written. */
export function fallbackCampaignDrafts(body: ArticleBody): readonly CampaignDraft[] {
  const plain = (text: string, limit: number) => [...text.replace(/\[src:[^\]]+\]/gu, '').replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/gu, '$1')
    .replace(/https?:\/\/[^\s]+|www\.[^\s]+/giu, '').replace(/<[^>]*>/gu, '').replace(/[*_#`]/gu, '').replace(/\s+/gu, ' ').trim()].slice(0, limit).join('');
  const excerpts: Readonly<Record<CampaignAngle, string>> = {
    launch: `${plain(body.title, 140)}. ${plain(body.excerpt || body.intro, 380)}`,
    takeaway: `${plain(body.sections[0]?.heading || body.title, 120)}: ${plain(body.sections[0]?.body || body.intro, 380)}`,
    follow_up: body.faqs[0] ? `${plain(body.faqs[0].q, 130)} ${plain(body.faqs[0].a, 350)}` : plain(body.conclusion || body.excerpt, 480),
  };
  return CAMPAIGN_NETWORKS.flatMap(network => CAMPAIGN_ANGLES.map(angle => ({ network, angle, title: plain(body.title, 160),
    copy: `${network === 'instagram' ? 'For your next read' : 'A point from our guide'} — ${angle === 'launch' ? 'the overview' : angle === 'takeaway' ? 'a practical takeaway' : 'a question to revisit'}:\n\n${excerpts[angle]}\n\n${network === 'instagram' ? 'Save this question for your next decision.' : 'Read the guide for the wider context.'}`,
    artworkInstructions: `Review an editorial illustration for the ${angle.replace('_', ' ')} perspective, using the brand’s visual guidance. No fabricated documentary evidence.`,
  })));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{64}$/u;
function requireUuid(value: string): void { if (!UUID.test(value)) throw new SeoBlogError(400, 'Invalid campaign identity.'); }
function requireSha(value: string): void { if (!SHA.test(value)) throw new SeoBlogError(400, 'Invalid campaign digest.'); }
function safeText(value: string, label: string, max: number): void {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new SeoBlogError(400, `Check the campaign ${label}.`);
}
function validateRevision(revision: Omit<CampaignRevision, 'sha256'>): void {
  for (const id of [revision.id, revision.variantId, revision.articleVersionId]) requireUuid(id);
  if (revision.createdBy !== 'system') requireUuid(revision.createdBy);
  const keys = ['id', 'variantId', 'articleVersionId', 'articleContentSha', 'canonicalUrl', 'network', 'angle', 'recipe', 'title', 'copy', 'artworkInstructions', 'relativeDays', 'media', 'createdAt', 'createdBy'];
  if (Object.keys(revision).length !== keys.length || keys.some(key => !(key in revision)) || revision.media === undefined) throw new SeoBlogError(400, 'Invalid campaign revision shape.');
  requireSha(revision.articleContentSha);
  if (!['instagram', 'linkedin'].includes(revision.network) || !(CAMPAIGN_ANGLES as readonly string[]).includes(revision.angle)
    || revision.recipe !== SEO_CAMPAIGN_RECIPE || revision.relativeDays !== CAMPAIGN_RELATIVE_DAYS[revision.angle]) throw new SeoBlogError(400, 'Invalid campaign recipe.');
  safeText(revision.title, 'title', 200); safeText(revision.copy, 'copy', revision.network === 'instagram' ? 1800 : 2600);
  safeText(revision.artworkInstructions, 'image brief', 800);
  if (/https?:\/\/|www\.|<\/?[a-z]/iu.test(revision.copy)) throw new SeoBlogError(400, 'Keep links and HTML out of the post copy; the reviewed blog URL is attached separately.');
  if (revision.canonicalUrl !== null) {
    let url: URL; try { url = new URL(revision.canonicalUrl); } catch { throw new SeoBlogError(400, 'A reviewed blog URL is required.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || /\s/u.test(revision.canonicalUrl)) throw new SeoBlogError(400, 'A reviewed public HTTPS blog URL is required.');
  }
  if (!Number.isFinite(Date.parse(revision.createdAt)) || new Date(revision.createdAt).toISOString() !== revision.createdAt) throw new SeoBlogError(400, 'Invalid campaign creation time.');
  if (revision.media) {
    const media = revision.media;
    for (const id of [media.useId, media.assetId, media.canonical.contentItemId, media.canonical.contentVersionId, media.canonical.approvalRequestId, media.canonical.approvalDecisionId]) requireUuid(id);
    requireSha(media.assetSha256); requireSha(media.canonical.contentSha256);
    if (media.profile !== revision.network) throw new SeoBlogError(400, 'Choose the image crop for this channel.');
    safeText(media.alt, 'image description', 200);
  }
}

/** Same bounded canonical JSON recipe as canonical content; no locale-sensitive sorting. */
export function campaignRevisionSha(input: Omit<CampaignRevision, 'sha256'>): string {
  validateRevision(input);
  return createHash('sha256').update(canonicalCompanyContentJson(input), 'utf8').digest('hex');
}
export function createCampaignRevision(input: Omit<CampaignRevision, 'id' | 'sha256' | 'recipe' | 'relativeDays'> & { readonly id?: string }): CampaignRevision {
  // Copy before hashing; caller mutations cannot change the stored immutable proposal.
  const value = JSON.parse(JSON.stringify({ id: input.id ?? randomUUID(), variantId: input.variantId, articleVersionId: input.articleVersionId,
    articleContentSha: input.articleContentSha, canonicalUrl: input.canonicalUrl, network: input.network, angle: input.angle,
    title: input.title, copy: input.copy, artworkInstructions: input.artworkInstructions, media: input.media,
    createdAt: input.createdAt, createdBy: input.createdBy, recipe: SEO_CAMPAIGN_RECIPE, relativeDays: CAMPAIGN_RELATIVE_DAYS[input.angle] })) as Omit<CampaignRevision, 'sha256'>;
  return Object.freeze({ ...value, ...(value.media ? { media: Object.freeze({ ...value.media, canonical: Object.freeze({ ...value.media.canonical }) }) } : {}), sha256: campaignRevisionSha(value) });
}
export function currentCampaignRevision(variant: CampaignVariant): CampaignRevision {
  const revision = variant.revisions.find(r => r.id === variant.currentRevisionId);
  if (!revision || revision.variantId !== variant.id || revision.network !== variant.network || revision.angle !== variant.angle) throw new SeoBlogError(409, 'This campaign draft changed. Refresh before continuing.');
  const { sha256, ...value } = revision;
  if (campaignRevisionSha(value) !== sha256) throw new SeoBlogError(409, 'The campaign draft does not match its saved review.');
  return revision;
}

/** A social-only edit preserves all other variants, owner pins and history. */
export function appendCampaignRevision(campaign: ArticleCampaign, variantId: string, expectedRevisionId: string, revision: CampaignRevision): ArticleCampaign {
  const variant = campaign.variants.find(v => v.id === variantId);
  if (!variant || variant.currentRevisionId !== expectedRevisionId) throw new SeoBlogError(409, 'This campaign draft changed. Refresh before editing.');
  const previous = currentCampaignRevision(variant);
  if (variant.revisions.length >= 64) throw new SeoBlogError(409, 'This post has reached its retained revision limit. No history has been discarded.');
  if (revision.id === previous.id || variant.revisions.some(r => r.id === revision.id) || revision.variantId !== variantId
    || revision.network !== variant.network || revision.angle !== variant.angle || revision.articleVersionId !== campaign.articleVersionId
    || revision.articleContentSha !== campaign.articleContentSha) throw new SeoBlogError(409, 'Save this edit as a new exact campaign revision.');
  currentCampaignRevision({ ...variant, currentRevisionId: revision.id, revisions: [revision] });
  if (revision.media && revision.media.useId === previous.media?.useId) throw new SeoBlogError(409, 'Review a new image use for this edited post.');
  return { ...campaign, variants: campaign.variants.map(v => v.id === variantId ? { ...v, currentRevisionId: revision.id, revisions: [...v.revisions, revision], approval: null,
    ...(v.approval ? { approvalHistory: [...(v.approvalHistory ?? []), v.approval] } : {}) } : v) };
}
export function campaignSource(brandId: string, articleId: string, revision: CampaignRevision): { readonly system: 'relaunch72.seo-blog'; readonly itemId: string; readonly version: string } {
  requireUuid(brandId); requireUuid(articleId);
  currentCampaignRevision({ id: revision.variantId, network: revision.network, angle: revision.angle, currentRevisionId: revision.id, revisions: [revision], omitted: false, pinnedSchedule: null, approval: null });
  return { system: 'relaunch72.seo-blog', itemId: `${brandId}:${articleId}:${revision.network}:${revision.variantId}`, version: `campaign:v1:${revision.articleVersionId}:${revision.id}:${revision.sha256}` };
}
export function campaignParentHold(article: Pick<Article, 'currentVersionId' | 'delivery' | 'publishedVersionId' | 'publishedUrl'>, version: Pick<ArticleVersion, 'id' | 'contentSha'>, campaign: ArticleCampaign, variant: CampaignVariant, requirePublished: boolean): string | null {
  const revision = currentCampaignRevision(variant);
  if (campaign.schema !== SEO_CAMPAIGN_SCHEMA || campaign.articleVersionId !== version.id || campaign.articleContentSha !== version.contentSha
    || article.currentVersionId !== version.id || revision.articleVersionId !== version.id || revision.articleContentSha !== version.contentSha) return 'The blog changed. Review a new campaign revision; earlier edits and approvals are retained in history.';
  if (variant.omitted) return 'This post is omitted from the campaign.';
  if (!revision.canonicalUrl) return 'The blog URL is not bound yet. Connect the website, then review a new campaign revision with its exact URL.';
  if (requirePublished && (article.delivery !== 'published' || article.publishedVersionId !== version.id || article.publishedUrl !== revision.canonicalUrl)) return 'Waiting for this exact approved blog version and URL to be verified live.';
  if (requirePublished && variant.network === 'instagram' && !revision.media) return 'Instagram needs a real reviewed image crop.';
  return null;
}

/** One initial immutable proposal per angle/channel, with no owner approval or queue side effect. */
export function createArticleCampaign(input: {
  readonly articleVersionId: string; readonly articleContentSha: string; readonly canonicalUrl: string | null;
  readonly drafts: readonly CampaignDraft[]; readonly createdAt: string; readonly createdBy: string;
  readonly generation: import('./types.js').GenerationRecord | null;
}): ArticleCampaign {
  if (input.drafts.length !== 6 || new Set(input.drafts.map(d => `${d.network}:${d.angle}`)).size !== 6
    || CAMPAIGN_NETWORKS.some(network => CAMPAIGN_ANGLES.some(angle => !input.drafts.some(d => d.network === network && d.angle === angle)))) throw new SeoBlogError(422, 'The campaign must contain one distinct draft for each of the six channel/angle choices.');
  if (new Set(input.drafts.map(d => d.copy.trim().toLowerCase().replace(/\s+/gu, ' '))).size !== 6) throw new SeoBlogError(422, 'Campaign perspectives must be distinct, not copies of the same post.');
  const variants = CAMPAIGN_NETWORKS.flatMap(network => CAMPAIGN_ANGLES.map(angle => {
    const draft = input.drafts.find(d => d.network === network && d.angle === angle)!;
    const id = randomUUID();
    const revision = createCampaignRevision({ id: randomUUID(), variantId: id, articleVersionId: input.articleVersionId, articleContentSha: input.articleContentSha,
      canonicalUrl: input.canonicalUrl, network, angle, title: draft.title, copy: draft.copy, artworkInstructions: draft.artworkInstructions, media: null,
      createdAt: input.createdAt, createdBy: input.createdBy });
    return { id, network, angle, currentRevisionId: revision.id, revisions: [revision], omitted: false, pinnedSchedule: null, approval: null };
  }));
  return { schema: SEO_CAMPAIGN_SCHEMA, articleVersionId: input.articleVersionId, articleContentSha: input.articleContentSha, variants,
    mode: input.generation ? 'model' : 'excerpt_fallback', generation: input.generation };
}

/** Proposed dates are not queue admissions. A late/past pin is never silently sent or moved. */
export function campaignDateProposal(variant: CampaignVariant, blogAt: string | null, now: string, timezone = 'UTC'): { readonly state: 'proposed'; readonly at: string; readonly pinned: boolean } | { readonly state: 'held'; readonly reason: string; readonly suggestedAt: string | null } {
  const revision = currentCampaignRevision(variant);
  const current = Date.parse(now); if (!Number.isFinite(current)) throw new SeoBlogError(400, 'Invalid campaign time.');
  if (variant.pinnedSchedule) {
    const at = Date.parse(variant.pinnedSchedule.scheduledFor);
    return Number.isFinite(at) && at > current ? { state: 'proposed', at: variant.pinnedSchedule.scheduledFor, pinned: true } : { state: 'held', reason: 'The owner-pinned slot has passed. Choose a new slot; it has not been moved or sent.', suggestedAt: null };
  }
  if (!blogAt || !Number.isFinite(Date.parse(blogAt))) return { state: 'held', reason: 'Choose a proposed blog date, or wait for its verified publication.', suggestedAt: null };
  // Calendar days preserve brand-local wall time across DST; the final hour is real elapsed time.
  const anchor = Date.parse(blogAt), local = utcToLocal(blogAt, timezone);
  const subMinute = ((anchor % 60_000) + 60_000) % 60_000;
  const date = addDays(local.date, revision.relativeDays);
  const wall = Date.parse(`${date}T${local.time}:00.000Z`);
  const offsets = [...new Set([-86_400_000, 0, 86_400_000].map(delta => zoneOffsetMs(wall + delta, timezone)))];
  const candidates = offsets.map(offset => wall - offset).filter(utc => {
    const candidate = utcToLocal(new Date(utc).toISOString(), timezone);
    return candidate.date === date && candidate.time === local.time;
  });
  if (revision.relativeDays !== 0 && candidates.length !== 1) return { state: 'held', reason: 'This local time is missing or repeated because the clocks change. Choose and review an exact slot.', suggestedAt: null };
  const at = (revision.relativeDays === 0 ? anchor : candidates[0]! + subMinute) + 3_600_000;
  if (at <= current) return { state: 'held', reason: 'This proposed slot has passed. Choose and review a new slot; it has not been moved or sent.', suggestedAt: null };
  return { state: 'proposed', at: new Date(at).toISOString(), pinned: false };
}
