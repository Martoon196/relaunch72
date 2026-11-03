/** Canonical image quality commands under the real selected native portal session. */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { CompanyContentService, type CompanyContentTransactionRunner } from '../company-content-pg/index.js';
import { InactivePortalSessionError, withTransaction } from '../db/transaction.js';
import { canonicalImageQualityApproval, type ImageQualityApproval } from '../seo-blog/media-review.js';
import { SeoBlogError } from '../seo-blog/types.js';
import type { PortalSessionIdentity } from './auth-service.js';

function runner(pool: Pick<Pool, 'connect'>, identity: PortalSessionIdentity): CompanyContentTransactionRunner {
  return { run: (context, operation, options) => withTransaction(pool, context, async t => {
    if (context.actorKind !== 'user' || context.userId !== identity.userId || !context.workspaceId) throw new InactivePortalSessionError();
    const session = await t.query<{ ok: boolean }>('SELECT app_private.lock_active_portal_session($1,$2,$3) AS ok',
      [createHash('sha256').update(identity.sessionToken).digest(), identity.userId, identity.workspaceId]);
    const member = await t.query<{ ok: boolean }>('SELECT app_private.can_manage_workspace($1,$2) AS ok', [identity.userId, context.workspaceId]);
    if (session.rows[0]?.ok !== true || member.rows[0]?.ok !== true) throw new InactivePortalSessionError();
    return operation(t);
  }, { isolation: options.serializable ? 'serializable' : 'read committed', readOnly: false }) };
}
export function createCentralImageQualityApproval(input: { adapterPool: Pick<Pool, 'connect'>; commandPool: Pick<Pool, 'connect'>; identity: PortalSessionIdentity; requestId: string }): ImageQualityApproval {
  const adapter = runner(input.adapterPool, input.identity), command = runner(input.commandPool, input.identity);
  const context = (brandId: string) => ({ actorKind: 'user' as const, userId: input.identity.userId, workspaceId: brandId, requestId: input.requestId });
  return canonicalImageQualityApproval({ context, drafts: new CompanyContentService({ transactionRunner: adapter }), approvals: new CompanyContentService({ transactionRunner: command }),
    async find(source, contentSha, brandId) {
      return adapter.run(context(brandId), async t => {
        const row = (await t.query<{ id: string; content_item_id: string; sha: string }>(
          `SELECT id,content_item_id,encode(content_sha256,'hex') AS sha FROM app.company_content_versions
           WHERE workspace_id=$1 AND source_system='relaunch72.seo-media' AND source_item_id=$2 AND source_version=$3 AND content_kind='image'`,
          [brandId, source.itemId, source.version])).rows[0];
        if (!row) return null;
        if (row.sha !== contentSha) throw new SeoBlogError(409, 'This immutable image source already has different canonical bytes. No existing review was replaced.');
        return { contentItemId: row.content_item_id, contentVersionId: row.id };
      }, { readOnly: true });
    } });
}
