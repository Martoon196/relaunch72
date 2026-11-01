import type { DatabaseRequestContext } from '../db/rls.js';
import { canonicalCompanyContentSocialDraft, COMPANY_CONTENT_SOCIAL_DRAFT_MIME_TYPE, type CompanyContentService, type CreateCompanyContentVersionCommand } from '../company-content-pg/index.js';
import { sha256 } from './engine.js';
import { SeoBlogError, type Article, type ArticleVersion, type Brand } from './types.js';

export type PromotionNetwork = 'instagram' | 'linkedin';
export type LinkedPromotion = NonNullable<Article['linkedPromotions']>[number];
export interface ArticlePromotionApproval {
  approve(brand: Brand, article: Article, version: ArticleVersion, network: PromotionNetwork): Promise<LinkedPromotion>;
}
export function promotionCommand(brand: Brand, version: ArticleVersion, network: PromotionNetwork): CreateCompanyContentVersionCommand {
  const pack = version.promotionPack;
  if (!pack || pack.brandId !== brand.id || pack.articleId !== version.articleId || pack.versionId !== version.id || pack.contentSha !== version.contentSha || !pack.canonicalUrl) {
    throw new SeoBlogError(409, 'Connect the blog website, then create a new promotion version with its final URL before review.');
  }
  const post = pack.posts.find(p => p.network === network);
  if (!post) throw new SeoBlogError(400, 'Choose an accompanying post.');
  const packSha = sha256(pack);
  const content = canonicalCompanyContentSocialDraft({ type: 'social_post', kind: 'blog_promotion', platform: network,
    title: post.title, publicationCopy: `${post.copy}\n\n${pack.canonicalUrl}`, artworkInstructions: post.artworkInstructions,
    ctaUrl: pack.canonicalUrl, contextSha256: packSha,
    // Art direction alone never becomes publishable media.
  });
  return {
    commandKey: `seo-promotion:${version.id}:${network}:${packSha.slice(0, 16)}`,
    origin: 'generated', kind: 'social_post', title: post.title, contentMimeType: COMPANY_CONTENT_SOCIAL_DRAFT_MIME_TYPE, content,
    source: { system: 'relaunch72.seo-blog', itemId: `${brand.id}:${version.articleId}:${network}`, version: `${version.id}:${packSha}` },
    blob: { storageKey: `seo-blog/${brand.id}/${version.id}/${network}`, sha256: sha256(content) },
    brand: { snapshotRef: `seo-blog/${brand.id}/profile/${version.profileVersion}`, sha256: sha256({ brandId: brand.id, profileVersion: version.profileVersion, factsSha: version.factsSha, knowledge: version.knowledge }) },
    attestation: { catalogSha256: packSha, checkedAt: version.createdAt, expiresAt: new Date(Date.parse(version.createdAt) + 15 * 60_000).toISOString() },
    metadata: { source: 'relaunch72.seo-blog', brandId: brand.id, articleId: version.articleId, articleVersionId: version.id,
      articleContentSha: version.contentSha, canonicalUrl: pack.canonicalUrl, packSha, network },
  };
}

/** Genuine owner commands only. Separate durable commands make a partial retry safe. */
export function canonicalPromotionApproval(input: {
  context: (brandId: string, version: ArticleVersion) => DatabaseRequestContext;
  drafts: Pick<CompanyContentService, 'createVersion' | 'refreshSourceAttestation'>;
  approvals: Pick<CompanyContentService, 'requestApproval' | 'decideApproval'>;
  now?: () => number;
}): ArticlePromotionApproval {
  return { async approve(brand, article, version, network) {
    if (article.currentVersionId !== version.id) throw new SeoBlogError(409, 'The article changed. Review its current accompanying posts.');
    const command = promotionCommand(brand, version, network);
    const context = input.context(brand.id, version);
    if (context.actorKind !== 'user' || !context.userId || context.workspaceId !== brand.id) throw new SeoBlogError(403, 'An active owner session is required.');
    const created = await input.drafts.createVersion(context, command);
    const minute = Math.floor((input.now?.() ?? Date.now()) / 60_000) * 60_000;
    await input.drafts.refreshSourceAttestation(context, {
      commandKey: `${command.commandKey}:proof:${minute}`, contentItemId: created.contentItemId, contentVersionId: created.contentVersionId,
      expected: { source: command.source, contentSha256: created.contentSha256, blobSha256: command.blob.sha256, brandSha256: command.brand.sha256 },
      attestation: { catalogSha256: command.attestation.catalogSha256, checkedAt: new Date(minute).toISOString(), expiresAt: new Date(minute + 15 * 60_000).toISOString() },
    });
    const request = await input.approvals.requestApproval(context, { commandKey: `${command.commandKey}:review`, contentItemId: created.contentItemId, contentVersionId: created.contentVersionId });
    const decision = await input.approvals.decideApproval(context, { commandKey: `${command.commandKey}:approve`, approvalRequestId: request.approvalRequestId, decision: 'approved', decisionNote: 'Owner reviewed the exact accompanying article promotion bytes and canonical URL.' });
    return { articleVersionId: version.id, network, packSha: sha256(version.promotionPack), contentItemId: created.contentItemId, contentVersionId: created.contentVersionId, approvalDecisionId: decision.approvalDecisionId };
  } };
}

export function promotionPublicationHold(article: Article, version: ArticleVersion, network: PromotionNetwork): string | null {
  const pack = version.promotionPack;
  if (!pack?.canonicalUrl) return 'Blog URL has not been bound for review.';
  if (article.currentVersionId !== version.id) return 'The article changed; review its new accompanying posts.';
  if (article.delivery !== 'published' || article.publishedVersionId !== version.id || article.publishedUrl !== pack.canonicalUrl) return 'Waiting for this exact article version and URL to be verified public.';
  if (!article.linkedPromotions?.some(p => p.articleVersionId === version.id && p.network === network && p.packSha === sha256(pack))) return 'Awaiting separate approval of this exact accompanying post.';
  if (network === 'instagram') return 'Instagram requires a real approved image before scheduling.';
  return null;
}
