import type { Pool, QueryResultRow } from 'pg';

export const OWNED_PUBLIC_SOCIAL_WORKER_DATABASE_ROLE =
  'r72_owned_social_worker_command' as const;

interface CommandBoundaryRow extends QueryResultRow {
  exactRole: unknown;
  schemaUsage: unknown;
  recordProfileExecute: unknown;
  recordProfileV2Execute: unknown;
  revokeProfileExecute: unknown;
  enqueueExecute: unknown;
  enqueueV2Execute: unknown;
  activationReadinessExecute: unknown;
  sessionLockExecute: unknown;
  ledgerExecute: unknown;
  installationExecute: unknown;
  workerFunctionsDenied: unknown;
  workerV2FunctionsDenied: unknown;
  tableBlind: unknown;
  elevatedRolesDenied: unknown;
}

/**
 * Prove the founder command identity received only the 0052 command boundary
 * plus the 0059 read-only activation probe. 0052 shipped a worker probe but no
 * command probe, so nothing previously asserted that the identity used to
 * record an owned profile or enqueue a publication is table-blind and cannot
 * reach the worker's dispatch functions. Booleans only: no provider binding,
 * account reference or secret can enter readiness output.
 */
export async function assertOwnedPublicSocialCommandBoundaryReady(
  pool: Pick<Pool, 'query'>,
): Promise<void> {
  let rows: readonly CommandBoundaryRow[];
  try {
    const result = await pool.query<CommandBoundaryRow>(
      `/* owned-social.command-runtime-boundary */
       SELECT
         current_user = 'r72_owned_social_command' AS "exactRole",
         has_schema_privilege(current_user, 'app_private', 'USAGE') AS "schemaUsage",
         has_function_privilege(
           current_user,
           'app_private.record_owned_social_profile(uuid,uuid,uuid,text,bytea,bytea,text,bytea,bytea,bytea,bytea,bytea,bytea,timestamp with time zone,timestamp with time zone)',
           'EXECUTE'
         ) AS "recordProfileExecute",
         has_function_privilege(
           current_user,
           'app_private.record_owned_social_profile_v2(uuid,uuid,uuid,text,text,bytea,bytea,text,bytea,bytea,bytea,bytea,bytea,bytea,timestamp with time zone,timestamp with time zone)',
           'EXECUTE'
         ) AS "recordProfileV2Execute",
         has_function_privilege(
           current_user,
           'app_private.revoke_owned_social_profile(uuid,uuid,uuid,bytea,text)',
           'EXECUTE'
         ) AS "revokeProfileExecute",
         has_function_privilege(
           current_user,
           'app_private.enqueue_owned_social_job(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,bytea,bytea,timestamp with time zone)',
           'EXECUTE'
         ) AS "enqueueExecute",
         has_function_privilege(
           current_user,
           'app_private.enqueue_owned_social_job_v2(uuid,uuid,uuid,text,bytea,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,bytea,bytea,timestamp with time zone)',
           'EXECUTE'
         ) AS "enqueueV2Execute",
         has_function_privilege(
           current_user,
           'app_private.property_predator_owned_social_activation_readiness(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,bytea,timestamp with time zone)',
           'EXECUTE'
         ) AS "activationReadinessExecute",
         has_function_privilege(
           current_user,
           'app_private.lock_active_portal_session(bytea,uuid,uuid)',
           'EXECUTE'
         ) AS "sessionLockExecute",
         has_function_privilege(
           current_user, 'app_private.runtime_schema_migrations()', 'EXECUTE'
         ) AS "ledgerExecute",
         has_function_privilege(
           current_user, 'app_private.runtime_database_installation_id()', 'EXECUTE'
         ) AS "installationExecute",
         NOT has_function_privilege(
           current_user,
           'app_private.claim_owned_social_job(uuid,uuid,bytea,integer)',
           'EXECUTE'
         ) AND NOT has_function_privilege(
           current_user,
           'app_private.load_owned_social_job(uuid,uuid,bigint,bytea)',
           'EXECUTE'
         ) AND NOT has_function_privilege(
           current_user,
           'app_private.begin_owned_social_call(uuid,uuid,bigint,bytea,boolean,boolean)',
           'EXECUTE'
         ) AND NOT has_function_privilege(
           current_user,
           'app_private.settle_owned_social_call(uuid,uuid,bigint,bytea,text,text,bytea,timestamp with time zone,text)',
           'EXECUTE'
         ) AS "workerFunctionsDenied",
         NOT has_function_privilege(
           current_user,
           'app_private.claim_owned_social_job_v2(uuid,uuid,text[],bytea,integer)',
           'EXECUTE'
         ) AND NOT has_function_privilege(
           current_user,
           'app_private.load_owned_social_job_v2(uuid,uuid,bigint,bytea)',
           'EXECUTE'
         ) AND NOT has_function_privilege(
           current_user,
           'app_private.begin_owned_social_call_v2(uuid,uuid,bigint,bytea,boolean,boolean)',
           'EXECUTE'
         ) AS "workerV2FunctionsDenied",
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
           AND NOT pg_has_role(current_user, 'r72_owned_social_definer', 'MEMBER')
           AS "elevatedRolesDenied"`,
    );
    rows = result.rows;
  } catch {
    throw new Error('Owned public-social command database boundary could not be verified');
  }
  const row = rows[0];
  if (rows.length !== 1 || !row || Object.values(row).some((value) => value !== true)) {
    throw new Error('Owned public-social command database boundary is not exact');
  }
}

interface BoundaryRow extends QueryResultRow {
  exactRole: unknown;
  schemaUsage: unknown;
  legacyClaimDenied: unknown;
  claimV2Execute: unknown;
  legacyLoadDenied: unknown;
  loadV2Execute: unknown;
  legacyBeginDenied: unknown;
  beginV2Execute: unknown;
  settleExecute: unknown;
  ledgerExecute: unknown;
  installationExecute: unknown;
  commandFunctionsDenied: unknown;
  commandV2FunctionsDenied: unknown;
  tableBlind: unknown;
  elevatedRolesDenied: unknown;
}

/**
 * Prove the live worker received only the exact v2 claim/load/begin boundary
 * plus the shared settlement receipt boundary. The query returns booleans
 * only: no provider binding, account reference or secret can enter readiness.
 */
export async function assertOwnedPublicSocialWorkerBoundaryReady(
  pool: Pick<Pool, 'query'>,
): Promise<void> {
  let rows: readonly BoundaryRow[];
  try {
    const result = await pool.query<BoundaryRow>(
      `/* owned-social.worker-runtime-boundary */
       SELECT
         current_user = 'r72_owned_social_worker_command' AS "exactRole",
         has_schema_privilege(current_user, 'app_private', 'USAGE') AS "schemaUsage",
         NOT has_function_privilege(
           current_user,
           'app_private.claim_owned_social_job(uuid,uuid,bytea,integer)',
           'EXECUTE'
         ) AS "legacyClaimDenied",
         has_function_privilege(
           current_user,
           'app_private.claim_owned_social_job_v2(uuid,uuid,text[],bytea,integer)',
           'EXECUTE'
         ) AS "claimV2Execute",
         NOT has_function_privilege(
           current_user,
           'app_private.load_owned_social_job(uuid,uuid,bigint,bytea)',
           'EXECUTE'
         ) AS "legacyLoadDenied",
         has_function_privilege(
           current_user,
           'app_private.load_owned_social_job_v2(uuid,uuid,bigint,bytea)',
           'EXECUTE'
         ) AS "loadV2Execute",
         NOT has_function_privilege(
           current_user,
           'app_private.begin_owned_social_call(uuid,uuid,bigint,bytea,boolean,boolean)',
           'EXECUTE'
         ) AS "legacyBeginDenied",
         has_function_privilege(
           current_user,
           'app_private.begin_owned_social_call_v2(uuid,uuid,bigint,bytea,boolean,boolean)',
           'EXECUTE'
         ) AS "beginV2Execute",
         has_function_privilege(
           current_user,
           'app_private.settle_owned_social_call(uuid,uuid,bigint,bytea,text,text,bytea,timestamp with time zone,text)',
           'EXECUTE'
         ) AS "settleExecute",
         has_function_privilege(
           current_user, 'app_private.runtime_schema_migrations()', 'EXECUTE'
         ) AS "ledgerExecute",
         has_function_privilege(
           current_user, 'app_private.runtime_database_installation_id()', 'EXECUTE'
         ) AS "installationExecute",
         NOT has_function_privilege(
           current_user,
           'app_private.enqueue_owned_social_job(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,bytea,bytea,timestamp with time zone)',
           'EXECUTE'
         ) AND NOT has_function_privilege(
           current_user,
           'app_private.revoke_owned_social_profile(uuid,uuid,uuid,bytea,text)',
           'EXECUTE'
         ) AS "commandFunctionsDenied",
         NOT has_function_privilege(
           current_user,
           'app_private.record_owned_social_profile_v2(uuid,uuid,uuid,text,text,bytea,bytea,text,bytea,bytea,bytea,bytea,bytea,bytea,timestamp with time zone,timestamp with time zone)',
           'EXECUTE'
         ) AND NOT has_function_privilege(
           current_user,
           'app_private.enqueue_owned_social_job_v2(uuid,uuid,uuid,text,bytea,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,bytea,bytea,timestamp with time zone)',
           'EXECUTE'
         ) AS "commandV2FunctionsDenied",
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
           AND NOT pg_has_role(current_user, 'r72_owned_social_definer', 'MEMBER')
           AS "elevatedRolesDenied"`,
    );
    rows = result.rows;
  } catch {
    throw new Error('Owned public-social worker database boundary could not be verified');
  }
  const row = rows[0];
  if (rows.length !== 1 || !row || Object.values(row).some((value) => value !== true)) {
    throw new Error('Owned public-social worker database boundary is not exact');
  }
}
