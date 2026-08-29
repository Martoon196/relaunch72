/**
 * Least-privilege runtime boundary probes for the three 0056 SMS database
 * identities. Each probe proves the exact login role, its allowed and
 * forbidden SECURITY DEFINER functions, complete table-blindness and the
 * absence of elevated role memberships — in one read-only statement.
 */

import type { Pool, QueryResultRow } from 'pg';

export const SMS_COMMAND_DATABASE_ROLE = 'r72_sms_command' as const;
export const SMS_WORKER_DATABASE_ROLE = 'r72_sms_worker_command' as const;
export const SMS_WEBHOOK_DATABASE_ROLE = 'r72_sms_webhook_command' as const;

type SmsRuntimeRole =
  | typeof SMS_COMMAND_DATABASE_ROLE
  | typeof SMS_WORKER_DATABASE_ROLE
  | typeof SMS_WEBHOOK_DATABASE_ROLE;

interface BoundaryRow extends QueryResultRow {
  exactRole: unknown;
  schemaUsage: unknown;
  runtimeLedger: unknown;
  installationIdentity: unknown;
  requiredFunctions: unknown;
  forbiddenFunctions: unknown;
  tableBlind: unknown;
  elevatedRolesDenied: unknown;
}

const AUTHORIZE =
  'app_private.authorize_and_enqueue_sms_live_job(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,timestamp with time zone,uuid,uuid,uuid,bytea,bytea,integer)';
const CLAIM =
  'app_private.claim_sms_live_job(uuid,uuid,bytea,integer)';
const LOAD =
  'app_private.load_sms_live_job(uuid,uuid,bigint,bytea)';
const BEGIN =
  'app_private.begin_sms_live_call(uuid,uuid,bigint,bytea,boolean,boolean,boolean)';
const SETTLE =
  'app_private.settle_sms_live_call(uuid,uuid,bigint,bytea,text,text,timestamp with time zone,boolean,text,text,bytea)';
const STATUS_RECEIPT =
  'app_private.record_sms_live_status_receipt(uuid,uuid,text,text,text,text,bytea,timestamp with time zone)';
const INBOUND_PROJECTION =
  'app_private.record_sms_live_inbound_projection(uuid,uuid,text,text,text,text,text,bytea,bytea,bytea,bytea,bytea,timestamp with time zone)';
const SESSION_LOCK =
  'app_private.lock_active_portal_session(bytea,uuid,uuid)';
const SESSION_READ =
  'app_private.active_portal_session(bytea,uuid,uuid)';

interface RoleContract {
  readonly role: SmsRuntimeRole;
  readonly required: readonly string[];
  readonly forbidden: readonly string[];
}

const CONTRACTS: Readonly<Record<SmsRuntimeRole, RoleContract>> = Object.freeze({
  [SMS_COMMAND_DATABASE_ROLE]: Object.freeze({
    role: SMS_COMMAND_DATABASE_ROLE,
    required: Object.freeze([AUTHORIZE, SESSION_LOCK]),
    forbidden: Object.freeze([
      CLAIM, LOAD, BEGIN, SETTLE, STATUS_RECEIPT, INBOUND_PROJECTION, SESSION_READ,
    ]),
  }),
  [SMS_WORKER_DATABASE_ROLE]: Object.freeze({
    role: SMS_WORKER_DATABASE_ROLE,
    required: Object.freeze([CLAIM, LOAD, BEGIN, SETTLE]),
    forbidden: Object.freeze([
      AUTHORIZE, SESSION_LOCK, SESSION_READ, STATUS_RECEIPT, INBOUND_PROJECTION,
    ]),
  }),
  [SMS_WEBHOOK_DATABASE_ROLE]: Object.freeze({
    role: SMS_WEBHOOK_DATABASE_ROLE,
    required: Object.freeze([STATUS_RECEIPT, INBOUND_PROJECTION]),
    forbidden: Object.freeze([
      AUTHORIZE, SESSION_LOCK, SESSION_READ, CLAIM, LOAD, BEGIN, SETTLE,
    ]),
  }),
});

function privilegeAnd(functions: readonly string[], expected: boolean): string {
  if (functions.length === 0) return expected ? 'TRUE' : 'FALSE';
  return functions.map((signature) => `${expected ? '' : 'NOT '}
    pg_catalog.has_function_privilege(current_user, '${signature}', 'EXECUTE')`).join('\n    AND ');
}

async function assertBoundary(
  pool: Pick<Pool, 'query'>,
  contract: RoleContract,
): Promise<void> {
  let rows: readonly BoundaryRow[];
  try {
    const result = await pool.query<BoundaryRow>(
      `/* twilio-sms-live.${contract.role}.runtime-boundary */
       SELECT
         current_user = '${contract.role}' AS "exactRole",
         pg_catalog.has_schema_privilege(current_user, 'app_private', 'USAGE') AS "schemaUsage",
         pg_catalog.has_function_privilege(
           current_user, 'app_private.runtime_schema_migrations()', 'EXECUTE'
         ) AS "runtimeLedger",
         pg_catalog.has_function_privilege(
           current_user, 'app_private.runtime_database_installation_id()', 'EXECUTE'
         ) AS "installationIdentity",
         (${privilegeAnd(contract.required, true)}) AS "requiredFunctions",
         (${privilegeAnd(contract.forbidden, false)}) AS "forbiddenFunctions",
         NOT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_class AS relation
           JOIN pg_catalog.pg_namespace AS schema_name
             ON schema_name.oid = relation.relnamespace
           WHERE schema_name.nspname IN ('app', 'app_private')
             AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND (
               pg_catalog.has_table_privilege(current_user, relation.oid, 'SELECT')
               OR pg_catalog.has_table_privilege(current_user, relation.oid, 'INSERT')
               OR pg_catalog.has_table_privilege(current_user, relation.oid, 'UPDATE')
               OR pg_catalog.has_table_privilege(current_user, relation.oid, 'DELETE')
               OR pg_catalog.has_table_privilege(current_user, relation.oid, 'TRUNCATE')
             )
         ) AS "tableBlind",
         NOT (
           pg_catalog.pg_has_role(current_user, 'r72_owner', 'MEMBER')
           OR pg_catalog.pg_has_role(current_user, 'r72_security_definer', 'MEMBER')
           OR pg_catalog.pg_has_role(current_user, 'r72_sms_definer', 'MEMBER')
         ) AS "elevatedRolesDenied"`,
    );
    rows = result.rows;
  } catch {
    throw new Error(`Twilio SMS ${contract.role} database boundary could not be verified`);
  }
  const row = rows[0];
  if (rows.length !== 1 || !row
      || row.exactRole !== true || row.schemaUsage !== true
      || row.runtimeLedger !== true || row.installationIdentity !== true
      || row.requiredFunctions !== true || row.forbiddenFunctions !== true
      || row.tableBlind !== true || row.elevatedRolesDenied !== true) {
    throw new Error(`Twilio SMS ${contract.role} database boundary is not exact`);
  }
}

export function assertSmsCommandBoundaryReady(pool: Pick<Pool, 'query'>): Promise<void> {
  return assertBoundary(pool, CONTRACTS[SMS_COMMAND_DATABASE_ROLE]);
}

export function assertSmsWorkerBoundaryReady(pool: Pick<Pool, 'query'>): Promise<void> {
  return assertBoundary(pool, CONTRACTS[SMS_WORKER_DATABASE_ROLE]);
}

export function assertSmsWebhookBoundaryReady(pool: Pick<Pool, 'query'>): Promise<void> {
  return assertBoundary(pool, CONTRACTS[SMS_WEBHOOK_DATABASE_ROLE]);
}
