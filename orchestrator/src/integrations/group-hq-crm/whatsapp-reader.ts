import type { Pool } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import type { DatabaseRequestContext } from '../../db/rls.js';

// The 0062 provenance function is the web role's approved read boundary for signed webhook receipts.
const projected = `
  FROM app.messages m
  JOIN app.conversations t ON t.workspace_id=m.workspace_id AND t.id=m.conversation_id AND t.contact_id=m.contact_id
  JOIN app.contacts c ON c.workspace_id=m.workspace_id AND c.id=m.contact_id AND c.deleted_at IS NULL
  JOIN app.message_versions v ON v.workspace_id=m.workspace_id AND v.conversation_id=m.conversation_id
    AND v.message_id=m.id AND v.version_number=1 AND v.created_by_actor_kind='webhook'
  JOIN LATERAL app_private.operational_inbox_live_message_provenance(m.workspace_id,m.conversation_id,m.id) proof
    ON proof.provider_family='meta_whatsapp_live' AND proof.network='whatsapp'
  WHERE m.workspace_id=app_private.current_workspace_id() AND t.inbox_id=$1::uuid
    AND m.channel='whatsapp' AND m.environment='live' AND m.direction='inbound'
    AND m.lifecycle='received' AND m.source_kind='verified_webhook'`;

export async function readOwnerWhatsapp(pool: Pick<Pool, 'connect'>, context: DatabaseRequestContext,
  actorEmail: string, inboxId: string, threadId?: string, beforeId?: string) {
  return withTransaction(pool, context, async tx => {
    const access = await tx.query(`/* group-hq.whatsapp.owner */ SELECT EXISTS (
      SELECT 1 FROM app.users u JOIN app.workspace_memberships wm ON wm.user_id=u.id
        JOIN app.workspaces w ON w.id=wm.workspace_id AND w.organization_id=wm.organization_id
        JOIN app.organization_memberships om ON om.organization_id=w.organization_id AND om.user_id=u.id
        JOIN app.organizations o ON o.id=om.organization_id
      WHERE u.id=$1::uuid AND lower(u.email::text)=$3 AND u.status='active' AND u.email_verified_at IS NOT NULL
        AND w.id=$2::uuid AND w.status='active' AND o.status='active'
        AND wm.role='owner' AND wm.status='active' AND wm.revoked_at IS NULL
        AND om.role='owner' AND om.status='active' AND om.revoked_at IS NULL
        AND EXISTS(SELECT 1 FROM app.inboxes i WHERE i.workspace_id=w.id AND i.id=$4::uuid
          AND i.channel='whatsapp' AND i.environment='live' AND i.status='active')) AS allowed`,
      [context.userId, context.workspaceId, actorEmail, inboxId]);
    if (access.rows[0]?.allowed !== true) return null;
    if (!threadId) {
      const result = await tx.query(`
        SELECT * FROM (
          SELECT DISTINCT ON (m.conversation_id) m.conversation_id AS id, m.contact_id AS "participantId",
            c.display_name AS name, left(v.body_text,180) AS preview, m.occurred_at AS "updatedAt"
          ${projected}
          ORDER BY m.conversation_id,m.occurred_at DESC,m.id DESC
        ) threads ORDER BY "updatedAt" DESC,id DESC LIMIT 101`, [inboxId]);
      return {brand:'mhp', accountId:inboxId, threads:result.rows.slice(0,100), hasMore:result.rows.length>100};
    }
    const result = await tx.query(`
      SELECT m.id, m.contact_id AS "participantId", v.body_text AS body,
        c.display_name AS name, m.occurred_at AS "occurredAt"
      ${projected} AND m.conversation_id=$2::uuid
        AND ($3::uuid IS NULL OR (m.occurred_at,m.id) < (
          SELECT anchor.occurred_at,anchor.id FROM app.messages anchor
          JOIN LATERAL app_private.operational_inbox_live_message_provenance(anchor.workspace_id,anchor.conversation_id,anchor.id) a
            ON a.provider_family='meta_whatsapp_live' AND a.network='whatsapp'
          WHERE anchor.workspace_id=m.workspace_id AND anchor.conversation_id=m.conversation_id AND anchor.id=$3::uuid))
      ORDER BY m.occurred_at DESC,m.id DESC LIMIT 33`, [inboxId,threadId,beforeId??null]);
    // An unknown/foreign conversation or cursor discloses no existence information.
    if (!result.rows.length) return null;
    const rows=result.rows.slice(0,32);
    return {brand:'mhp', accountId:inboxId, threadId, messages:rows,
      nextCursor:result.rows.length>32 ? rows[rows.length-1]!.id : null};
  }, {readOnly:true});
}
