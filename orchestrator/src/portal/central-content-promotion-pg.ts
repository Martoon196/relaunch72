import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { CompanyContentService, type CompanyContentTransactionRunner } from '../company-content-pg/index.js';
import { InactivePortalSessionError, withTransaction } from '../db/transaction.js';
import { canonicalPromotionApproval, type ArticlePromotionApproval } from '../seo-blog/promotions.js';
import type { ArticleVersion } from '../seo-blog/types.js';
import type { PortalSessionIdentity } from './auth-service.js';

/** A URL brand selector is never a change to the global canonical session selection. */
export function centralPromotionRunner(pool: Pick<Pool, 'connect'>, identity: PortalSessionIdentity, version: ArticleVersion): CompanyContentTransactionRunner {
  return { run: (context, operation, options) => withTransaction(pool, context, async transaction => {
    if (context.actorKind !== 'user' || context.userId !== identity.userId || context.workspaceId !== version.brandId) throw new InactivePortalSessionError();
    const session = await transaction.query<{ ok: boolean }>(
      'SELECT app_private.lock_active_portal_session($1,$2,$3) AS ok',
      [createHash('sha256').update(identity.sessionToken).digest(), identity.userId, identity.workspaceId]);
    if (session.rows[0]?.ok !== true) throw new InactivePortalSessionError();
    const guard = await transaction.query<{ ok: boolean }>(
      'SELECT app_private.r72_content_assert_article_promotion($1,$2,$3,$4,$5,false) AS ok',
      [version.brandId, version.articleId, version.id, version.contentSha, version.promotionPack?.canonicalUrl ?? null]);
    if (guard.rows[0]?.ok !== true) throw new InactivePortalSessionError();
    return operation(transaction);
  }, { readOnly: false, isolation: options.serializable ? 'serializable' : 'read committed' }) };
}

export function createCentralPromotionApproval(input: {
  adapterPool: Pick<Pool, 'connect'>;
  commandPool: Pick<Pool, 'connect'>;
  identity: PortalSessionIdentity;
  requestId: string;
}): ArticlePromotionApproval {
  return { approve: (brand, article, version, network) => canonicalPromotionApproval({
    context: brandId => ({ actorKind: 'user', userId: input.identity.userId, workspaceId: brandId, requestId: input.requestId }),
    drafts: new CompanyContentService({ transactionRunner: centralPromotionRunner(input.adapterPool, input.identity, version) }),
    approvals: new CompanyContentService({ transactionRunner: centralPromotionRunner(input.commandPool, input.identity, version) }),
  }).approve(brand, article, version, network) };
}
