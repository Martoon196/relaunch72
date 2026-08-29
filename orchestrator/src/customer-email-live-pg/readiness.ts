import type { Pool, QueryResultRow } from 'pg';

export const CUSTOMER_EMAIL_COMMAND_DATABASE_ROLE =
  'r72_customer_email_command' as const;
export const CUSTOMER_EMAIL_WORKER_DATABASE_ROLE =
  'r72_customer_email_worker_command' as const;
export const CUSTOMER_EMAIL_WEBHOOK_DATABASE_ROLE =
  'r72_customer_email_webhook_command' as const;

type CustomerEmailRuntimeRole =
  | typeof CUSTOMER_EMAIL_COMMAND_DATABASE_ROLE
  | typeof CUSTOMER_EMAIL_WORKER_DATABASE_ROLE
  | typeof CUSTOMER_EMAIL_WEBHOOK_DATABASE_ROLE;

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
  'app_private.authorize_and_enqueue_customer_email_live_job(uuid,uuid,uuid,uuid,bytea,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,timestamp with time zone,uuid,uuid,uuid,bytea,bytea)';
const CLAIM =
  'app_private.claim_customer_email_live_job(uuid,uuid,bytea,integer)';
const LOAD =
  'app_private.load_customer_email_live_job(uuid,uuid,bigint,bytea)';
const BEGIN =
  'app_private.begin_customer_email_live_call(uuid,uuid,bigint,bytea,boolean,boolean,boolean)';
const SETTLE =
  'app_private.settle_customer_email_live_call(uuid,uuid,bigint,bytea,text,text,timestamp with time zone,boolean,text,text,bytea)';
const RECEIPT =
  'app_private.record_customer_email_signed_receipt(uuid,uuid,text)';
const SESSION_LOCK =
  'app_private.lock_active_portal_session(bytea,uuid,uuid)';
const SESSION_READ =
  'app_private.active_portal_session(bytea,uuid,uuid)';

interface RoleContract {
  readonly role: CustomerEmailRuntimeRole;
  readonly required: readonly string[];
  readonly forbidden: readonly string[];
}

const CONTRACTS: Readonly<Record<CustomerEmailRuntimeRole, RoleContract>> = Object.freeze({
  [CUSTOMER_EMAIL_COMMAND_DATABASE_ROLE]: Object.freeze({
    role: CUSTOMER_EMAIL_COMMAND_DATABASE_ROLE,
    required: Object.freeze([AUTHORIZE, SESSION_LOCK]),
    forbidden: Object.freeze([CLAIM, LOAD, BEGIN, SETTLE, RECEIPT, SESSION_READ]),
  }),
  [CUSTOMER_EMAIL_WORKER_DATABASE_ROLE]: Object.freeze({
    role: CUSTOMER_EMAIL_WORKER_DATABASE_ROLE,
    required: Object.freeze([CLAIM, LOAD, BEGIN, SETTLE]),
    forbidden: Object.freeze([AUTHORIZE, SESSION_LOCK, SESSION_READ, RECEIPT]),
  }),
  [CUSTOMER_EMAIL_WEBHOOK_DATABASE_ROLE]: Object.freeze({
    role: CUSTOMER_EMAIL_WEBHOOK_DATABASE_ROLE,
    required: Object.freeze([RECEIPT]),
    forbidden: Object.freeze([AUTHORIZE, SESSION_LOCK, SESSION_READ, CLAIM, LOAD, BEGIN, SETTLE]),
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
      `/* customer-email-live.${contract.role}.runtime-boundary */
       SELECT
         current_user = '${contract.role}' AS "exactRole",
         pg_catalog.has_schema_privilege(current_user, 'app_private', 'USAGE')
           AS "schemaUsage",
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
           JOIN pg_catalog.pg_namespace AS namespace
             ON namespace.oid = relation.relnamespace
           WHERE namespace.nspname IN ('app', 'app_private')
             AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND (
               pg_catalog.has_table_privilege(current_user, relation.oid, 'SELECT')
               OR pg_catalog.has_table_privilege(current_user, relation.oid, 'INSERT')
               OR pg_catalog.has_table_privilege(current_user, relation.oid, 'UPDATE')
               OR pg_catalog.has_table_privilege(current_user, relation.oid, 'DELETE')
               OR pg_catalog.has_table_privilege(current_user, relation.oid, 'TRUNCATE')
             )
         ) AS "tableBlind",
         NOT pg_catalog.pg_has_role(current_user, 'r72_owner', 'MEMBER')
           AND NOT pg_catalog.pg_has_role(current_user, 'r72_security_definer', 'MEMBER')
           AND NOT pg_catalog.pg_has_role(
             current_user, 'r72_customer_email_definer', 'MEMBER'
           ) AS "elevatedRolesDenied"`,
    );
    rows = result.rows;
  } catch {
    throw new Error(`Customer email ${contract.role} database boundary could not be verified`);
  }
  const row = rows[0];
  if (rows.length !== 1 || !row || Object.values(row).some((value) => value !== true)) {
    throw new Error(`Customer email ${contract.role} database boundary is not exact`);
  }
}

export function assertCustomerEmailCommandBoundaryReady(
  pool: Pick<Pool, 'query'>,
): Promise<void> {
  return assertBoundary(pool, CONTRACTS[CUSTOMER_EMAIL_COMMAND_DATABASE_ROLE]);
}

export function assertCustomerEmailWorkerBoundaryReady(
  pool: Pick<Pool, 'query'>,
): Promise<void> {
  return assertBoundary(pool, CONTRACTS[CUSTOMER_EMAIL_WORKER_DATABASE_ROLE]);
}

export function assertCustomerEmailWebhookBoundaryReady(
  pool: Pick<Pool, 'query'>,
): Promise<void> {
  return assertBoundary(pool, CONTRACTS[CUSTOMER_EMAIL_WEBHOOK_DATABASE_ROLE]);
}
