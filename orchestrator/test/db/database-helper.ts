import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { loadDatabaseConfig } from '../../src/db/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createDatabasePool } from '../../src/db/pool.js';

const TEST_NAME_PATTERN = /(?:^|[_-])test(?:$|[_-])/i;
const DISPOSABLE_DATABASE_LEASE_SQL = `
  pg_catalog.hashtext(pg_catalog.current_database()),
  pg_catalog.hashtext('relaunch72-disposable-integration')
`;
export const DISPOSABLE_BRANCH_CONFIRMATION = 'reset-disposable-branch';
export const DATABASE_INTEGRATION_CONFIRMATION = 'explicit-disposable-run';
type ScopedTestRole =
  | 'r72_web'
  | 'r72_crm_command'
  | 'r72_affiliate_draft_command'
  | 'r72_affiliate_lifecycle_command'
  | 'r72_affiliate_legal_command'
  | 'r72_affiliate_commercial_command'
  | 'r72_affiliate_acceptance_command'
  | 'r72_affiliate_capacity_command'
  | 'r72_affiliate_declaration_command'
  | 'r72_affiliate_training_authority_command'
  | 'r72_affiliate_training_evidence_command'
  | 'r72_affiliate_specialist_command'
  | 'r72_affiliate_channel_command'
  | 'r72_affiliate_effect_command'
  | 'r72_affiliate_case_command'
  | 'r72_affiliate_receipt_command'
  | 'r72_external_event_command'
  | 'r72_mailgun_webhook_command'
  | 'r72_test_inbox_webhook_command'
  | 'r72_public_social_command'
  | 'r72_public_social_worker_command'
  | 'r72_customer_email_command'
  | 'r72_customer_email_worker_command'
  | 'r72_customer_email_webhook_command'
  | 'r72_sms_command'
  | 'r72_sms_worker_command'
  | 'r72_sms_webhook_command'
  | 'r72_worker'
  | 'r72_webhook';
type UnscopedTestRole =
  | 'r72_web'
  | 'r72_identity_command'
  | 'r72_crm_command'
  | 'r72_abuse_command'
  | 'r72_worker';

const TEST_ROLES = new Set<ScopedTestRole>([
  'r72_web',
  'r72_crm_command',
  'r72_affiliate_draft_command',
  'r72_affiliate_lifecycle_command',
  'r72_affiliate_legal_command',
  'r72_affiliate_commercial_command',
  'r72_affiliate_acceptance_command',
  'r72_affiliate_capacity_command',
  'r72_affiliate_declaration_command',
  'r72_affiliate_training_authority_command',
  'r72_affiliate_training_evidence_command',
  'r72_affiliate_specialist_command',
  'r72_affiliate_channel_command',
  'r72_affiliate_effect_command',
  'r72_affiliate_case_command',
  'r72_affiliate_receipt_command',
  'r72_external_event_command',
  'r72_mailgun_webhook_command',
  'r72_test_inbox_webhook_command',
  'r72_public_social_command',
  'r72_public_social_worker_command',
  'r72_customer_email_command',
  'r72_customer_email_worker_command',
  'r72_customer_email_webhook_command',
  'r72_sms_command',
  'r72_sms_worker_command',
  'r72_sms_webhook_command',
  'r72_worker',
  'r72_webhook',
]);
const UNSCOPED_TEST_ROLES = new Set<UnscopedTestRole>([
  'r72_web',
  'r72_identity_command',
  'r72_crm_command',
  'r72_abuse_command',
  'r72_worker',
]);

export function testDatabaseSkipReason(): string | false {
  if (process.env.RELAUNCH72_DATABASE_INTEGRATION?.trim()
      !== DATABASE_INTEGRATION_CONFIRMATION) {
    return 'real PostgreSQL integration is available only through the explicit test:db:integration command';
  }
  return process.env.TEST_DATABASE_URL?.trim()
    ? false
    : 'TEST_DATABASE_URL is not set; PostgreSQL integration test is opt-in';
}

export function assertDisposableTestDatabase(
  rawUrl: string,
  branchConfirmation = process.env.TEST_DATABASE_RESET_CONFIRM?.trim(),
): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!TEST_NAME_PATTERN.test(database) || /^(?:postgres|template0|template1)$/i.test(database)) {
    throw new Error('TEST_DATABASE_URL database name must contain a standalone test segment');
  }
  if (branchConfirmation !== DISPOSABLE_BRANCH_CONFIRMATION) {
    throw new Error(
      `TEST_DATABASE_RESET_CONFIRM must equal ${DISPOSABLE_BRANCH_CONFIRMATION}; `
      + 'the test must run on an isolated disposable branch/project because PostgreSQL role changes are branch-wide',
    );
  }
}

export async function openTestDatabase(): Promise<Pool> {
  const rawUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!rawUrl) throw new Error('TEST_DATABASE_URL is required');
  assertDisposableTestDatabase(rawUrl);
  const config = loadDatabaseConfig('migrator', {
    NODE_ENV: 'development',
    DATABASE_MIGRATOR_URL: rawUrl,
    DATABASE_SSL_MODE: process.env.TEST_DATABASE_SSL_MODE,
    DATABASE_POOL_MAX: '4',
  });
  const pool = createDatabasePool(config);
  const leaseClient = await pool.connect();
  let leaseHeld = false;
  try {
    // Every integration test resets shared schemas/tables. Node's in-process
    // concurrency flag cannot prevent another terminal or agent from running
    // the same disposable branch at the same time, so hold one database-scoped
    // session lease until this pool closes.
    await leaseClient.query(
      `SELECT pg_catalog.pg_advisory_lock(${DISPOSABLE_DATABASE_LEASE_SQL})`,
    );
    leaseHeld = true;
    const endPool = pool.end.bind(pool);
    let ending: Promise<void> | undefined;
    pool.end = (() => {
      ending ??= (async () => {
        let unlockError: unknown;
        try {
          const unlocked = await leaseClient.query<{ unlocked: boolean }>(
            `SELECT pg_catalog.pg_advisory_unlock(${DISPOSABLE_DATABASE_LEASE_SQL}) AS unlocked`,
          );
          if (unlocked.rows[0]?.unlocked !== true) {
            throw new Error('Disposable database integration lease was not held');
          }
        } catch (error) {
          unlockError = error;
        } finally {
          leaseClient.release(unlockError !== undefined);
        }

        try {
          await endPool();
        } catch (endError) {
          if (unlockError !== undefined) {
            throw new AggregateError(
              [unlockError, endError],
              'Disposable database lease release and pool shutdown both failed',
            );
          }
          throw endError;
        }
        if (unlockError !== undefined) throw unlockError;
      })();
      return ending;
    }) as Pool['end'];

    await runMigrations(pool);
    return pool;
  } catch (error) {
    if (!leaseHeld) leaseClient.release(true);
    await pool.end().catch(() => undefined);
    throw error;
  }
}

export async function ownerQuery<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE r72_owner');
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

export async function scopedQuery<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  role: ScopedTestRole,
  context: { workspaceId: string; userId?: string; requestId?: string },
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  if (!TEST_ROLES.has(role)) throw new Error('Unsupported integration-test role');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(
      `SELECT
         set_config('app.user_id', $1, true),
         set_config('app.workspace_id', $2, true),
         set_config('app.actor_kind', $3, true),
         set_config('app.request_id', $4, true)`,
      [
        context.userId ?? '',
        context.workspaceId,
        role === 'r72_worker'
          || role === 'r72_public_social_worker_command'
          || role === 'r72_customer_email_worker_command'
          || role === 'r72_sms_worker_command'
          ? 'worker'
          : role === 'r72_webhook'
            || role === 'r72_external_event_command'
            || role === 'r72_mailgun_webhook_command'
            || role === 'r72_test_inbox_webhook_command'
            || role === 'r72_customer_email_webhook_command'
            || role === 'r72_sms_webhook_command'
            ? 'webhook'
            : 'user',
        context.requestId ?? 'integration-test',
      ],
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

export async function roleQuery<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  role: UnscopedTestRole,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  if (!UNSCOPED_TEST_ROLES.has(role)) throw new Error('Unsupported integration-test role');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
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

export async function resetIdentityTables(pool: Pool): Promise<void> {
  await ownerQuery(
    pool,
    `TRUNCATE TABLE
       app.identity_action_tokens,
       app.user_sessions,
       app.membership_invitations,
       app.platform_memberships,
       app.workspace_memberships,
       app.organization_memberships,
       app.organization_domains,
       app.organization_branding,
       app.workspaces,
       app.users,
       app.organizations
     CASCADE`,
  );
}

export async function expectPostgresError(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation;
    throw new Error(`Expected PostgreSQL error ${code}`);
  } catch (error) {
    if (error instanceof Error && error.message === `Expected PostgreSQL error ${code}`) throw error;
    const actual = (error as { code?: string }).code;
    if (actual !== code) throw error;
  }
}

export async function withOwnerClient<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE r72_owner');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
