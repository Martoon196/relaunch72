import type { DatabaseRequestContext } from '../db/rls.js';
import { CompanyContentApprovalConflictError, type CompanyContentService, type CreateCompanyContentVersionCommand } from '../company-content-pg/index.js';
import { sha256 } from './engine.js';
import { SeoBlogError, type Article, type ArticleVersion, type Brand, type LinkedPromotionRecord, type PromotionNetwork, type PromotionObservation } from './types.js';

export type { PromotionNetwork } from './types.js';
export type LinkedPromotion = LinkedPromotionRecord;

export const SEO_BLOG_SOURCE_SYSTEM = 'relaunch72.seo-blog' as const;
/** The social copy is stored as the exact plain text the calendar worker posts verbatim. */
export const SEO_BLOG_PROMOTION_MIME_TYPE = 'text/plain' as const;
/** Company-content attestations may be at most 15 minutes old and must be created within 5 minutes of observation. */
export const OBSERVATION_TTL_MS = 15 * 60_000;
export const OBSERVATION_CREATE_WINDOW_MS = 4 * 60_000;

export interface ArticlePromotionApproval {
  approve(input: {
    brand: Brand; article: Article; version: ArticleVersion; network: PromotionNetwork; observation: PromotionObservation;
    /** Persists the draft identity as soon as it exists so a crash before approval resumes instead of duplicating. */
    recordDraft(contentItemId: string, contentVersionId: string): Promise<void>;
  }): Promise<LinkedPromotion>;
}

export function promotionCopy(version: ArticleVersion, network: PromotionNetwork): string {
  const pack = version.promotionPack;
  if (!pack?.canonicalUrl) throw new SeoBlogError(409, 'Connect the blog website, then create a new promotion version with its final URL before review.');
  const post = pack.posts.find(p => p.network === network);
  if (!post) throw new SeoBlogError(400, 'Choose an accompanying post.');
  return `${post.copy.trim()}\n\n${pack.canonicalUrl}`;
}

export function promotionCommandKey(version: ArticleVersion, network: PromotionNetwork, observation: Pick<PromotionObservation, 'observedAt'>): string {
  return `seo-promotion:${version.id}:${network}:${sha256(version.promotionPack).slice(0, 16)}:${Date.parse(observation.observedAt)}`;
}

/** Deterministic canonical command for one exact (article version, network, owner observation). */
export function promotionCommand(brand: Brand, version: ArticleVersion, network: PromotionNetwork, observation: PromotionObservation): CreateCompanyContentVersionCommand {
  const pack = version.promotionPack;
  if (!pack || pack.brandId !== brand.id || pack.articleId !== version.articleId || pack.versionId !== version.id || pack.contentSha !== version.contentSha || !pack.canonicalUrl) {
    throw new SeoBlogError(409, 'Connect the blog website, then create a new promotion version with its final URL before review.');
  }
  const post = pack.posts.find(p => p.network === network);
  if (!post) throw new SeoBlogError(400, 'Choose an accompanying post.');
  const packSha = sha256(pack);
  if (observation.articleVersionId !== version.id || observation.network !== network || observation.packSha !== packSha) {
    throw new SeoBlogError(409, 'The accompanying drafts changed. Refresh before approving.');
  }
  const content = promotionCopy(version, network);
  return {
    commandKey: promotionCommandKey(version, network, observation),
    origin: 'generated', kind: 'social_post', title: post.title.slice(0, 300), contentMimeType: SEO_BLOG_PROMOTION_MIME_TYPE, content,
    source: { system: SEO_BLOG_SOURCE_SYSTEM, itemId: `${brand.id}:${version.articleId}:${network}`, version: `${version.id}:${packSha}` },
    blob: { storageKey: `seo-blog/${brand.id}/${version.id}/${network}`, sha256: sha256(content) },
    brand: { snapshotRef: `seo-blog/${brand.id}/profile/${version.profileVersion}`, sha256: sha256({ brandId: brand.id, profileVersion: version.profileVersion, factsSha: version.factsSha, knowledge: version.knowledge }) },
    attestation: { catalogSha256: packSha, checkedAt: observation.observedAt, expiresAt: observation.expiresAt },
    metadata: { source: SEO_BLOG_SOURCE_SYSTEM, brandId: brand.id, articleId: version.articleId, articleVersionId: version.id,
      articleContentSha: version.contentSha, canonicalUrl: pack.canonicalUrl, packSha, network, observationId: observation.id },
  };
}

/** Genuine owner commands only. Separate durable commands make a partial retry safe. */
export function canonicalPromotionApproval(input: {
  context: (brandId: string, version: ArticleVersion) => DatabaseRequestContext;
  drafts: Pick<CompanyContentService, 'createVersion'>;
  approvals: Pick<CompanyContentService, 'requestApproval' | 'decideApproval'>;
}): ArticlePromotionApproval {
  return { async approve({ brand, article, version, network, observation, recordDraft }) {
    if (article.currentVersionId !== version.id) throw new SeoBlogError(409, 'The article changed. Review its current accompanying posts.');
    const command = promotionCommand(brand, version, network, observation);
    const context = input.context(brand.id, version);
    if (context.actorKind !== 'user' || !context.userId || context.workspaceId !== brand.id) throw new SeoBlogError(403, 'An active owner session is required.');
    let contentItemId = observation.contentItemId;
    let contentVersionId = observation.contentVersionId;
    if (!contentItemId || !contentVersionId) {
      try {
        const created = await input.drafts.createVersion(context, command);
        contentItemId = created.contentItemId; contentVersionId = created.contentVersionId;
      } catch (error) {
        if (error instanceof CompanyContentApprovalConflictError) {
          // The exact source version already exists from an earlier owner observation whose draft identity was lost.
          throw new SeoBlogError(409, 'This exact post was already recorded. Create a new promotion version to review it again.');
        }
        throw error;
      }
      await recordDraft(contentItemId, contentVersionId);
    }
    const request = await input.approvals.requestApproval(context, { commandKey: `${command.commandKey}:review`, contentItemId, contentVersionId });
    const decision = await input.approvals.decideApproval(context, { commandKey: `${command.commandKey}:approve`, approvalRequestId: request.approvalRequestId, decision: 'approved', decisionNote: 'Owner reviewed the exact accompanying article promotion text and canonical URL.' });
    return { articleVersionId: version.id, network, packSha: sha256(version.promotionPack), contentItemId, contentVersionId, approvalRequestId: request.approvalRequestId, approvalDecisionId: decision.approvalDecisionId };
  } };
}

export function linkedPromotionFor(article: Article, version: ArticleVersion, network: PromotionNetwork): LinkedPromotion | null {
  const pack = version.promotionPack;
  if (!pack) return null;
  const packSha = sha256(pack);
  return article.linkedPromotions?.find(p => p.articleVersionId === version.id && p.network === network && p.packSha === packSha) ?? null;
}

/** Why this exact post cannot be scheduled yet; null when the article side is ready. Account registration is checked separately. */
export function promotionPublicationHold(article: Article, version: ArticleVersion, network: PromotionNetwork): string | null {
  const pack = version.promotionPack;
  if (!pack?.canonicalUrl) return 'Blog URL has not been bound for review.';
  if (article.currentVersionId !== version.id) return 'The article changed; review its new accompanying posts.';
  if (article.delivery !== 'published' || article.publishedVersionId !== version.id || article.publishedUrl !== pack.canonicalUrl) return 'Waiting for this exact article version and URL to be verified public.';
  const link = linkedPromotionFor(article, version, network);
  if (!link) return 'Awaiting separate approval of this exact accompanying post.';
  if (!link.approvalRequestId) return 'Approve this exact accompanying post again; its approval predates scheduling support.';
  if (network === 'instagram') return 'Instagram requires a real approved image before scheduling.';
  return null;
}
