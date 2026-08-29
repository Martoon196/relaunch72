import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  scopedQuery,
  testDatabaseSkipReason,
} from './database-helper.js';

const skip = testDatabaseSkipReason();
const roles = [
  'r72_customer_email_command',
  'r72_customer_email_worker_command',
  'r72_customer_email_webhook_command',
] as const;

async function openRoleLoginPool(ownerPool: Pool, role: typeof roles[number]): Promise<Pool> {
  const rawUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!rawUrl) throw new Error('TEST_DATABASE_URL is required');
  const password = `customer-email-${randomUUID()}`;
  const ownerClient = await ownerPool.connect();
  try {
    const statement = await ownerClient.query<{ sql: string }>(
      `SELECT pg_catalog.format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql`,
      [role, password],
    );
    await ownerClient.query(statement.rows[0]!.sql);
  } finally {
    ownerClient.release();
  }
  const roleUrl = new URL(rawUrl);
  roleUrl.username = role;
  roleUrl.password = password;
  return new Pool({
    connectionString: roleUrl.toString(),
    max: 1,
    application_name: `relaunch72-disposable-${role}-test`,
  });
}

async function clearRoleLoginPasswords(ownerPool: Pool): Promise<void> {
  const ownerClient = await ownerPool.connect();
  try {
    for (const role of roles) await ownerClient.query(`ALTER ROLE ${role} PASSWORD NULL`);
  } finally {
    ownerClient.release();
  }
}

async function loginScopedQuery<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  actorKind: 'user' | 'worker' | 'webhook',
  context: { workspaceId: string; userId?: string; requestId: string },
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.workspace_id', $2, true),
              set_config('app.actor_kind', $3, true),
              set_config('app.request_id', $4, true)`,
      [context.userId ?? '', context.workspaceId, actorKind, context.requestId],
    );
    const result = await client.query<T>(sql, values);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('0054 disposable attack proof keeps customer-email identities table-blind and exact', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  const loginPools: Pool[] = [];
  const workspaceId = randomUUID();
  const userId = randomUUID();
  try {
    const commandPool = await openRoleLoginPool(pool, 'r72_customer_email_command');
    const workerPool = await openRoleLoginPool(pool, 'r72_customer_email_worker_command');
    const webhookPool = await openRoleLoginPool(pool, 'r72_customer_email_webhook_command');
    loginPools.push(commandPool, workerPool, webhookPool);
    for (const role of roles) {
      const context = {
        workspaceId,
        userId: role === 'r72_customer_email_command' ? userId : undefined,
        requestId: `customer-email-readiness-${role}`,
      };
      const readiness = await scopedQuery<{
        migration_count: number;
        has_0054: boolean;
        installation_id: string;
      }>(pool, role, context,
        `SELECT count(*)::int AS migration_count,
                bool_or(filename = '0054_property_predator_customer_email_live_foundation.sql')
                  AS has_0054,
                app_private.runtime_database_installation_id()::text AS installation_id
         FROM app_private.runtime_schema_migrations()`,
      );
      assert.ok((readiness[0]?.migration_count ?? 0) >= 54);
      assert.equal(readiness[0]?.has_0054, true);
      assert.match(readiness[0]?.installation_id ?? '',
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      await expectPostgresError(scopedQuery(pool, role, context,
        'SELECT * FROM app.property_predator_customer_email_jobs LIMIT 1'), '42501');
    }

    const capabilityRows = await ownerQuery<{
      role_name: string;
      unsafe_table_privilege: boolean;
      unsafe_membership: boolean;
      bypass_rls: boolean;
      superuser: boolean;
    }>(pool,
      `SELECT role_name,
              EXISTS (
                SELECT 1
                FROM pg_catalog.pg_class AS relation
                JOIN pg_catalog.pg_namespace AS namespace
                  ON namespace.oid = relation.relnamespace
                WHERE namespace.nspname IN ('app', 'app_private')
                  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
                  AND (
                    pg_catalog.has_table_privilege(role_name, relation.oid, 'SELECT')
                    OR pg_catalog.has_table_privilege(role_name, relation.oid, 'INSERT')
                    OR pg_catalog.has_table_privilege(role_name, relation.oid, 'UPDATE')
                    OR pg_catalog.has_table_privilege(role_name, relation.oid, 'DELETE')
                    OR pg_catalog.has_table_privilege(role_name, relation.oid, 'TRUNCATE')
                    OR pg_catalog.has_table_privilege(role_name, relation.oid, 'REFERENCES')
                    OR pg_catalog.has_table_privilege(role_name, relation.oid, 'TRIGGER')
                  )
              ) AS unsafe_table_privilege,
              EXISTS (
                SELECT 1 FROM pg_catalog.pg_auth_members AS membership
                JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
                WHERE member.rolname = role_name
              ) AS unsafe_membership,
              role.rolbypassrls AS bypass_rls,
              role.rolsuper AS superuser
       FROM unnest($1::text[]) AS input(role_name)
       JOIN pg_catalog.pg_roles AS role ON role.rolname = input.role_name
       ORDER BY role_name`,
      [[...roles]],
    );
    assert.deepEqual(capabilityRows, [...roles].sort().map((roleName) => ({
      role_name: roleName,
      unsafe_table_privilege: false,
      unsafe_membership: false,
      bypass_rls: false,
      superuser: false,
    })));

    const signatures = await ownerQuery<{
      enqueue_signature: string | null;
      old_enqueue_signature: string | null;
      receipt_signature: string | null;
      old_receipt_signature: string | null;
      enqueue_definition: string;
      begin_definition: string;
      load_definition: string;
      delivery_guard_definition: string;
      load_result: string;
      authority_constraints: string;
      has_portal_session_lock: boolean;
      has_portal_session_token_oracle: boolean;
    }>(pool,
      `SELECT
         pg_catalog.to_regprocedure(
           'app_private.authorize_and_enqueue_customer_email_live_job(uuid,uuid,uuid,uuid,bytea,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,uuid,bytea,bytea)'
         )::text AS enqueue_signature,
         pg_catalog.to_regprocedure(
           'app_private.authorize_and_enqueue_customer_email_live_job(uuid,uuid,uuid,uuid,uuid,uuid,uuid,bytea,bytea,bytea,timestamptz,uuid,uuid,bytea,bytea)'
         )::text AS old_enqueue_signature,
         pg_catalog.to_regprocedure(
           'app_private.record_customer_email_signed_receipt(uuid,uuid,text)'
         )::text AS receipt_signature,
         pg_catalog.to_regprocedure(
           'app_private.record_customer_email_signed_receipt(uuid,uuid,uuid)'
         )::text AS old_receipt_signature,
         pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(
           'app_private.authorize_and_enqueue_customer_email_live_job(uuid,uuid,uuid,uuid,bytea,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,timestamptz,uuid,uuid,uuid,bytea,bytea)'
         )) AS enqueue_definition,
         pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(
           'app_private.begin_customer_email_live_call(uuid,uuid,bigint,bytea,boolean,boolean,boolean)'
         )) AS begin_definition,
         pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(
           'app_private.load_customer_email_live_job(uuid,uuid,bigint,bytea)'
         )) AS load_definition,
         pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(
           'app_private.guard_property_predator_email_live_delivery()'
         )) AS delivery_guard_definition,
         pg_catalog.pg_get_function_result(pg_catalog.to_regprocedure(
           'app_private.load_customer_email_live_job(uuid,uuid,bigint,bytea)'
         )) AS load_result,
         (
           SELECT string_agg(pg_catalog.pg_get_constraintdef(constraint_row.oid), ' ')
           FROM pg_catalog.pg_constraint AS constraint_row
           WHERE constraint_row.conrelid =
             'app.property_predator_customer_email_authorities'::regclass
             AND constraint_row.contype = 'c'
         ) AS authority_constraints,
         pg_catalog.has_function_privilege(
           'r72_customer_email_command',
           'app_private.lock_active_portal_session(bytea,uuid,uuid)', 'EXECUTE'
         ) AS has_portal_session_lock,
         pg_catalog.has_function_privilege(
           'r72_customer_email_command',
           'app_private.active_portal_session(bytea,uuid,uuid)', 'EXECUTE'
         ) AS has_portal_session_token_oracle`,
    );
    assert.match(signatures[0]?.enqueue_signature ?? '', /authorize_and_enqueue/u);
    assert.equal(signatures[0]?.old_enqueue_signature, null);
    assert.match(signatures[0]?.receipt_signature ?? '', /record_customer_email_signed_receipt/u);
    assert.equal(signatures[0]?.old_receipt_signature, null);
    assert.match(signatures[0]?.enqueue_definition ?? '',
      /p_authority_valid_until IS DISTINCT FROM\s+date_trunc\('milliseconds'(?:::text)?, p_authority_valid_until\)/u);
    assert.match(signatures[0]?.enqueue_definition ?? '',
      /YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"/u);
    assert.match(signatures[0]?.authority_constraints ?? '',
      /sender_endpoint_normalized_address[\s\S]*mg\.propertypredator\.com/u);
    assert.match(signatures[0]?.enqueue_definition ?? '',
      /endpoint\.address = 'mg\.propertypredator\.com'(?:::text)?[\s\S]*endpoint\.normalized_address = 'mg\.propertypredator\.com'(?:::text)?/u);
    for (const definition of [
      signatures[0]?.begin_definition ?? '', signatures[0]?.load_definition ?? '',
    ]) {
      assert.match(definition,
        /endpoint\.address = authority\.sender_endpoint_normalized_address[\s\S]*endpoint\.normalized_address = authority\.sender_endpoint_normalized_address/u);
      assert.match(definition,
        /authority\.sender_endpoint_normalized_address = 'mg\.propertypredator\.com'(?:::text)?/u);
      assert.match(definition,
        /authority\.action_scope_sha256 = public\.digest\(format\([\s\S]*authority\.sender_endpoint_normalized_address/u);
    }
    assert.match(signatures[0]?.delivery_guard_definition ?? '',
      /CURRENT_USER = 'r72_customer_email_definer'(?:::name)?[\s\S]*endpoint\.address = 'mg\.propertypredator\.com'(?:::text)?[\s\S]*endpoint\.normalized_address = 'mg\.propertypredator\.com'(?:::text)?/iu);
    assert.match(signatures[0]?.load_result ?? '',
      /TABLE\(provider_connection_id uuid, sending_domain text, operation_id uuid/u);
    assert.equal(signatures[0]?.has_portal_session_lock, true);
    assert.equal(signatures[0]?.has_portal_session_token_oracle, false);

    const notApplicable = await loginScopedQuery<{ result: string }>(
      webhookPool,
      'webhook',
      { workspaceId, requestId: 'customer-email-unrelated-signed-event' },
      `SELECT app_private.record_customer_email_signed_receipt($1, $2, $3) AS result`,
      [workspaceId, randomUUID(), 'unrelated.signed.event'],
    );
    assert.deepEqual(notApplicable, [{ result: 'not_applicable' }]);

    const noJob = await loginScopedQuery<{ began: boolean }>(
      workerPool,
      'worker',
      { workspaceId, requestId: 'customer-email-no-job-begin' },
      `SELECT app_private.begin_customer_email_live_call(
         $1, $2, 1, decode($3, 'hex'), true, true, false
       ) AS began`,
      [workspaceId, randomUUID(), '44'.repeat(32)],
    );
    assert.deepEqual(noJob, [{ began: false }]);

    await expectPostgresError(loginScopedQuery(
      commandPool,
      'user',
      { workspaceId, userId, requestId: 'customer-email-forged-evidence' },
      `SELECT * FROM app_private.authorize_and_enqueue_customer_email_live_job(
         $1, $2, $3, $4, decode($5, 'hex'), $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17,
         statement_timestamp() + interval '5 minutes', $18, $19, $20,
         decode($21, 'hex'), decode($22, 'hex')
       )`,
      [workspaceId, ...Array.from({ length: 3 }, () => randomUUID()),
        '11'.repeat(32), ...Array.from({ length: 15 }, () => randomUUID()),
        '22'.repeat(32), '33'.repeat(32)],
    ), '42501');
  } finally {
    await Promise.all(loginPools.map(async (rolePool) => rolePool.end()));
    await clearRoleLoginPasswords(pool);
    await pool.end();
  }
});
