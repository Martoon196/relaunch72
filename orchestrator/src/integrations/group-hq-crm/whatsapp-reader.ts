import type { Pool } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import type { DatabaseRequestContext } from '../../db/rls.js';

// Keep Postgres' six fractional digits: JS Date truncation can skip threads within the same millisecond.
function threadPosition(cursor: string, inboxId: string) {
  if (cursor.length > 180 || !/^[\w-]+$/u.test(cursor)) return null;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const [account, timestamp, id, extra] = raw.split('|');
  if (account !== inboxId || !timestamp || !id || extra !== undefined ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(timestamp) ||
      !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u.test(id)) return null;
  const milliseconds = timestamp.slice(0, 23) + 'Z';
  const instant = new Date(milliseconds);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== milliseconds) return null;
  return { timestamp, id };
}

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
    // Preserve the established signed transcript. 0143 adds unlinked first contacts and manual
    // replies; a mirrored legacy receipt is displayed once, under its private sender thread.
    const schema=await tx.query("SELECT to_regprocedure('app_private.mhp_wa_direct_history(uuid,uuid)') IS NOT NULL AS installed");
    const directInstalled=schema.rows[0]?.installed===true;
    const direct=directInstalled?'SELECT * FROM app_private.mhp_wa_direct_history($1::uuid,$2::uuid)':
      'SELECT NULL::uuid AS thread_id,NULL::uuid AS id,NULL::text AS label,NULL::text AS body,NULL::timestamptz AS occurred_at,NULL::text AS direction,NULL::text AS reply_state,NULL::uuid AS native_thread_id WHERE false';
    const history=`WITH direct AS MATERIALIZED (
      ${direct}
    ), transcript AS (
      SELECT d.thread_id,d.id,CASE WHEN d.thread_id=d.native_thread_id THEN coalesce(c.id,d.thread_id) ELSE d.thread_id END AS participant_id,c.id AS contact_id,
        coalesce(c.display_name,d.label) AS name,d.body,d.occurred_at,d.direction,d.reply_state
      FROM direct d LEFT JOIN app.conversations t ON t.id=d.native_thread_id AND t.inbox_id=$1 AND t.workspace_id=app_private.current_workspace_id()
      LEFT JOIN app.contacts c ON c.workspace_id=t.workspace_id AND c.id=t.contact_id AND c.deleted_at IS NULL
      UNION ALL
      SELECT coalesce((SELECT d.thread_id FROM direct d WHERE d.native_thread_id=m.conversation_id LIMIT 1),m.conversation_id),m.id,
        coalesce((SELECT d.thread_id FROM direct d WHERE d.native_thread_id=m.conversation_id AND d.thread_id<>m.conversation_id LIMIT 1),m.contact_id),
        m.contact_id,c.display_name,v.body_text,m.occurred_at,'incoming',NULL::text
      ${projected} AND ($2::uuid IS NULL OR m.conversation_id=$2 OR EXISTS(SELECT 1 FROM direct d WHERE d.native_thread_id=m.conversation_id))
      AND NOT EXISTS(SELECT 1 FROM direct d WHERE d.id=m.id)
    )`;
    if (!threadId) {
      const after = beforeId ? threadPosition(beforeId, inboxId) : null;
      if (beforeId && !after) return null;
      const result = await tx.query(`${history}
        SELECT threads.*,to_char("updatedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt" FROM (
          SELECT DISTINCT ON (thread_id) thread_id AS id,participant_id AS "participantId",
            contact_id AS "contactId",name,left(body,180) AS preview,occurred_at AS "updatedAt"
          FROM transcript ORDER BY thread_id,occurred_at DESC,id DESC
        ) threads WHERE $3::timestamptz IS NULL OR ("updatedAt",id)<($3::timestamptz,$4::uuid)
        ORDER BY "updatedAt" DESC,id DESC LIMIT 101`, [inboxId,null,after?.timestamp ?? null,after?.id ?? null]);
      const page = result.rows.slice(0,100);
      const hasMore = result.rows.length > 100;
      const last = page.at(-1);
      const nextCursor = hasMore && last
        ? Buffer.from([inboxId,last.cursorAt,last.id].join('|')).toString('base64url') : null;
      return {brand:'mhp', accountId:inboxId, threads:page.map(({cursorAt, ...thread}) => thread), hasMore, nextCursor};
    }
    const result = await tx.query(`${history}
      SELECT m.id,m.participant_id AS "participantId",m.contact_id AS "contactId",m.body,m.name,m.direction,
        m.reply_state AS "replyState",m.occurred_at AS "occurredAt" FROM transcript m
      WHERE $3::uuid IS NULL OR (m.occurred_at,m.id) < (
        SELECT a.occurred_at,a.id FROM transcript a WHERE a.thread_id=m.thread_id AND a.id=$3::uuid)
      ORDER BY m.occurred_at DESC,m.id DESC LIMIT 33`, [inboxId,threadId,beforeId??null]);
    // An unknown/foreign conversation or cursor discloses no existence information.
    if (!result.rows.length) return null;
    const rows=result.rows.slice(0,32);
    const canReply=directInstalled && (await tx.query('SELECT app_private.mhp_wa_direct_can_reply($1,$2) AS available',[inboxId,threadId])).rows[0]?.available===true;
    return {brand:'mhp', accountId:inboxId, threadId, messages:rows,canReply,
      nextCursor:result.rows.length>32 ? rows[rows.length-1]!.id : null};
  }, {readOnly:true});
}
