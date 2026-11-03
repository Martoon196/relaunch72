/** Genuine selected-session canonical approval for one native SEO campaign revision. */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { CompanyContentService, type CompanyContentTransactionRunner } from '../company-content-pg/index.js';
import { InactivePortalSessionError, withTransaction } from '../db/transaction.js';
import { canonicalCampaignApproval, type CampaignPromotionApproval, type CampaignPromotionApprovalInput } from '../seo-blog/campaign-promotions.js';
import { currentCampaignRevision } from '../seo-blog/campaign.js';
import { SeoBlogError } from '../seo-blog/types.js';
import type { PortalSessionIdentity } from './auth-service.js';

function runner(pool: Pick<Pool, 'connect'>, identity: PortalSessionIdentity, request: CampaignPromotionApprovalInput, canonicalVersion: () => string | null): CompanyContentTransactionRunner {
  const revision = currentCampaignRevision(request.variant);
  return { run: (context, operation, options) => withTransaction(pool, context, async t => {
    if (context.actorKind !== 'user' || context.userId !== identity.userId || context.workspaceId !== request.brand.id) throw new InactivePortalSessionError();
    const session = await t.query<{ ok: boolean }>('SELECT app_private.lock_active_portal_session($1,$2,$3) AS ok',
      [createHash('sha256').update(identity.sessionToken).digest(), identity.userId, identity.workspaceId]);
    if (session.rows[0]?.ok !== true) throw new InactivePortalSessionError();
    // Before createVersion there is no canonical row. The native guard holds
    // brand/article/current revision through this genuine command transaction.
    const native = await t.query<{ ok: boolean }>('SELECT app_private.seo_blog_assert_campaign_revision($1,$2,$3,$4,$5,$6,false) AS ok',
      [request.brand.id, request.article.id, request.version.id, request.variant.id, revision.id, revision.sha256]);
    if (native.rows[0]?.ok !== true) throw new SeoBlogError(409, 'The campaign revision, its image use or parent changed. Review the current item.');
    const versionId = canonicalVersion();
    if (versionId) {
      const canonical = await t.query<{ ok: boolean }>('SELECT app_private.seo_blog_assert_campaign_content($1,$2,false) AS ok', [request.brand.id, versionId]);
      if (canonical.rows[0]?.ok !== true) throw new SeoBlogError(409, 'The canonical post does not match this current campaign revision.');
    }
    return operation(t);
  }, { readOnly: false, isolation: options.serializable ? 'serializable' : 'read committed' }) };
}

export function createCentralCampaignApproval(input: {
  readonly adapterPool: Pick<Pool, 'connect'>;
  readonly commandPool: Pick<Pool, 'connect'>;
  readonly identity: PortalSessionIdentity;
  readonly requestId: string;
}): CampaignPromotionApproval {
  return { async approve(request) {
    let canonicalVersionId: string | null = null;
    const context = { actorKind: 'user' as const, userId: input.identity.userId, workspaceId: request.brand.id, requestId: input.requestId };
    const adapter = runner(input.adapterPool, input.identity, request, () => canonicalVersionId);
    const commands = runner(input.commandPool, input.identity, request, () => canonicalVersionId);
    const service = canonicalCampaignApproval({ context: () => context,
      drafts: new CompanyContentService({ transactionRunner: adapter }),
      approvals: new CompanyContentService({ transactionRunner: commands }),
      async findDraft(command) {
        return adapter.run(context, async t => {
          const row = (await t.query<{ content_item_id: string; id: string; sha: string }>(
            `SELECT content_item_id,id,encode(content_sha256,'hex') AS sha FROM app.company_content_versions
             WHERE workspace_id=$1 AND source_system='relaunch72.seo-blog' AND source_item_id=$2 AND source_version=$3
               AND content_kind='social_post'`, [request.brand.id, command.source.itemId, command.source.version])).rows[0];
          if (!row) return null;
          if (row.sha !== command.blob.sha256) throw new SeoBlogError(409, 'A canonical campaign revision exists with different bytes. Nothing was overwritten.');
          return { contentItemId: row.content_item_id, contentVersionId: row.id };
        }, { readOnly: true });
      },
    });
    return service.approve({ ...request, async recordDraft(item, version) {
      canonicalVersionId = version;
      await request.recordDraft(item, version);
    } });
  } };
}
