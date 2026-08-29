import type { Pool, QueryResultRow } from 'pg';

export const META_WHATSAPP_LIVE_COMMAND_DATABASE_ROLE =
  'r72_whatsapp_live_command' as const;
export const META_WHATSAPP_LIVE_WORKER_DATABASE_ROLE =
  'r72_whatsapp_live_worker_command' as const;
export const META_WHATSAPP_LIVE_WEBHOOK_DATABASE_ROLE =
  'r72_whatsapp_live_webhook_command' as const;

interface BoundaryRow extends QueryResultRow {
  exactRole: unknown;
  schemaUsage: unknown;
  allowedFunctionsReady: unknown;
  extraFunctionsDenied: unknown;
  tableBlind: unknown;
  elevatedRolesDenied: unknown;
}

type BoundaryKind = 'command' | 'worker' | 'webhook';

const ROLE: Record<BoundaryKind, string> = {
  command: META_WHATSAPP_LIVE_COMMAND_DATABASE_ROLE,
  worker: META_WHATSAPP_LIVE_WORKER_DATABASE_ROLE,
  webhook: META_WHATSAPP_LIVE_WEBHOOK_DATABASE_ROLE,
};

const ALLOWED: Record<BoundaryKind, readonly string[]> = {
  command: [
    'app_private.record_whatsapp_live_binding(uuid,uuid,uuid,text,text,text,bytea,text,bytea,bytea,bytea,bytea,bytea,bytea,timestamp with time zone,uuid)',
    'app_private.revoke_whatsapp_live_binding(uuid,uuid,bytea)',
    'app_private.record_whatsapp_live_template(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,bytea,text,text,bytea,timestamp with time zone)',
    'app_private.authorize_and_enqueue_whatsapp_live_job(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamp with time zone,uuid,bytea,bytea)',
    'app_private.runtime_schema_migrations()',
    'app_private.runtime_database_installation_id()',
    'app_private.lock_active_portal_session(bytea,uuid,uuid)',
  ],
  worker: [
    'app_private.claim_whatsapp_live_job(uuid,uuid,bytea,integer)',
    'app_private.load_whatsapp_live_job(uuid,uuid,bigint,bytea)',
    'app_private.begin_whatsapp_live_call(uuid,uuid,bigint,bytea,boolean,boolean)',
    'app_private.settle_whatsapp_live_call(uuid,uuid,bigint,bytea,text,text,bytea,text,timestamp with time zone)',
    'app_private.runtime_schema_migrations()',
    'app_private.runtime_database_installation_id()',
  ],
  webhook: [
    'app_private.record_whatsapp_live_status(uuid,uuid,text,text,bytea,text,bytea,timestamp with time zone)',
    'app_private.record_whatsapp_live_inbound_receipt(uuid,uuid,text,text,bytea,bytea,bytea,timestamp with time zone)',
    'app_private.runtime_schema_migrations()',
    'app_private.runtime_database_installation_id()',
  ],
};

async function assertBoundaryReady(
  pool: Pick<Pool, 'query'>,
  kind: BoundaryKind,
): Promise<void> {
  const allowed = ALLOWED[kind];
  const placeholders = allowed.map((_, index) => `$${index + 2}::regprocedure`);
  let rows: readonly BoundaryRow[];
  try {
    const result = await pool.query<BoundaryRow>(
      `/* meta-whatsapp-live.${kind}-runtime-boundary */
       SELECT
         current_user = $1::text AS "exactRole",
         has_schema_privilege(current_user, 'app_private', 'USAGE')
           AS "schemaUsage",
         bool_and(has_function_privilege(current_user, allowed.oid, 'EXECUTE'))
           AS "allowedFunctionsReady",
         NOT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_proc AS procedure
           JOIN pg_catalog.pg_namespace AS namespace
             ON namespace.oid = procedure.pronamespace
           WHERE namespace.nspname = 'app_private'
             AND has_function_privilege(current_user, procedure.oid, 'EXECUTE')
             AND procedure.oid NOT IN (${placeholders.join(', ')})
         ) AS "extraFunctionsDenied",
         NOT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_class AS relation
           JOIN pg_catalog.pg_namespace AS namespace
             ON namespace.oid = relation.relnamespace
           WHERE namespace.nspname IN ('app', 'app_private')
             AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND (
               has_table_privilege(current_user, relation.oid, 'SELECT')
               OR has_table_privilege(current_user, relation.oid, 'INSERT')
               OR has_table_privilege(current_user, relation.oid, 'UPDATE')
               OR has_table_privilege(current_user, relation.oid, 'DELETE')
               OR has_table_privilege(current_user, relation.oid, 'TRUNCATE')
             )
         ) AS "tableBlind",
         NOT pg_has_role(current_user, 'r72_owner', 'MEMBER')
           AND NOT pg_has_role(current_user, 'r72_security_definer', 'MEMBER')
           AND NOT pg_has_role(current_user, 'r72_whatsapp_live_definer', 'MEMBER')
           AS "elevatedRolesDenied"
       FROM unnest(ARRAY[${placeholders.join(', ')}]::oid[]) AS allowed(oid)`,
      [ROLE[kind], ...allowed],
    );
    rows = result.rows;
  } catch {
    throw new Error(`Meta WhatsApp live ${kind} database boundary could not be verified`);
  }
  const row = rows[0];
  if (rows.length !== 1 || !row || Object.values(row).some((value) => value !== true)) {
    throw new Error(`Meta WhatsApp live ${kind} database boundary is not exact`);
  }
}

export function assertMetaWhatsAppLiveCommandBoundaryReady(
  pool: Pick<Pool, 'query'>,
): Promise<void> {
  return assertBoundaryReady(pool, 'command');
}

export function assertMetaWhatsAppLiveWorkerBoundaryReady(
  pool: Pick<Pool, 'query'>,
): Promise<void> {
  return assertBoundaryReady(pool, 'worker');
}

export function assertMetaWhatsAppLiveWebhookBoundaryReady(
  pool: Pick<Pool, 'query'>,
): Promise<void> {
  return assertBoundaryReady(pool, 'webhook');
}
