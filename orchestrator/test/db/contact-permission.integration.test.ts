import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool, type QueryResultRow } from 'pg';
import '../../src/config.js';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  testDatabaseSkipReason,
} from './database-helper.js';

const skip = testDatabaseSkipReason();

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

async function openCrmLoginPool(ownerPool: Pool): Promise<Pool> {
  const rawUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!rawUrl) throw new Error('TEST_DATABASE_URL is required');
  const password = `contact-permission-${randomUUID()}`;
  const client = await ownerPool.connect();
  try {
    const statement = await client.query<{ sql: string }>(
      `SELECT pg_catalog.format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql`,
      ['r72_crm_command', password],
    );
    await client.query(statement.rows[0]!.sql);
  } finally {
    client.release();
  }
  const roleUrl = new URL(rawUrl);
  roleUrl.username = 'r72_crm_command';
  roleUrl.password = password;
  return new Pool({ connectionString: roleUrl.toString(), max: 1 });
}

async function clearCrmPassword(ownerPool: Pool): Promise<void> {
  const client = await ownerPool.connect();
  try {
    await client.query('ALTER ROLE r72_crm_command PASSWORD NULL');
  } finally {
    client.release();
  }
}

async function crmQuery<T extends QueryResultRow>(
  pool: Pool,
  context: { workspaceId: string; userId: string; requestId: string },
  sql: string,
  values: readonly unknown[] = [],
): Promise<readonly T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.workspace_id', $2, true),
              set_config('app.actor_kind', 'user', true),
              set_config('app.request_id', $3, true)`,
      [context.userId, context.workspaceId, context.requestId],
    );
    const result = await client.query<T>(sql, [...values]);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('0063 records founder permission idempotently while preserving suppression', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const ownerId = randomUUID();
  const adminId = randomUUID();
  const marketerId = randomUUID();
  const contactId = randomUUID();
  const pointId = randomUUID();
  const address = `founder-${contactId.slice(0, 8)}@example.test`;
  const commandKey = digest(`0063-command-${randomUUID()}`);
  const policySha = digest('0063 policy text');
  const occurredAt = new Date().toISOString();
  let crmPool: Pool | undefined;

  const callSql = `
    SELECT disposition, consent_event_id::text, receipt_id::text
    FROM app_private.record_contact_permission_decision(
      $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text,
      $7::text, $8::text, $9::text, $10::bytea, $11::text, $12::bytea,
      $13::timestamptz
    )`;
  const values = [
    workspaceId, contactId, pointId, 'email', 'marketing', 'granted',
    'consent', 'founder_witnessed', 'founder-pilot-v1', policySha,
    `founder:${contactId}`, commandKey, occurredAt,
  ] as const;

  try {
    await resetIdentityTables(pool);
    await ownerQuery(pool,
      `INSERT INTO app.organizations (id, name, slug, kind, status)
       VALUES ($1, '0063 disposable proof', $2, 'direct_customer', 'active')`,
      [organizationId, `permission-0063-${organizationId.slice(0, 8)}`]);
    for (const [userId, role] of [
      [ownerId, 'owner'], [adminId, 'admin'], [marketerId, 'marketer'],
    ] as const) {
      await ownerQuery(pool,
        `INSERT INTO app.users (id, email, status, email_verified_at)
         VALUES ($1, $2, 'active', statement_timestamp())`,
        [userId, `permission-${role}-${userId.slice(0, 8)}@example.test`]);
      const organizationRole = role === 'owner' ? 'owner' : 'admin';
      await ownerQuery(pool,
        `INSERT INTO app.organization_memberships (organization_id, user_id, role, status)
         VALUES ($1, $2, $3, 'active')`, [organizationId, userId, organizationRole]);
    }
    for (const [id, name] of [
      [workspaceId, 'primary'], [otherWorkspaceId, 'other'],
    ] as const) {
      await ownerQuery(pool,
        `INSERT INTO app.workspaces (id, organization_id, name, slug, status)
         VALUES ($1, $2, $3, $4, 'active')`,
        [id, organizationId, `0063 ${name}`, `permission-${id.slice(0, 8)}`]);
    }
    for (const [userId, role] of [
      [ownerId, 'owner'], [adminId, 'admin'], [marketerId, 'marketer'],
    ] as const) {
      await ownerQuery(pool,
        `INSERT INTO app.workspace_memberships
           (workspace_id, organization_id, user_id, role, status)
         VALUES ($1, $2, $3, $4, 'active')`,
        [workspaceId, organizationId, userId, role]);
    }
    await ownerQuery(pool,
      `INSERT INTO app.workspace_memberships
         (workspace_id, organization_id, user_id, role, status)
       VALUES ($1, $2, $3, 'owner', 'active')`,
      [otherWorkspaceId, organizationId, ownerId]);
    await ownerQuery(pool,
      `INSERT INTO app.contacts
         (id, workspace_id, display_name, lifecycle_status, source, owner_user_id)
       VALUES ($1, $2, '0063 founder lead', 'lead', 'founder_pilot', $3)`,
      [contactId, workspaceId, ownerId]);
    await ownerQuery(pool,
      `INSERT INTO app.contact_points
         (id, workspace_id, contact_id, kind, label, value, normalized_value,
          is_primary, is_verified, dedupe_state)
       VALUES ($1, $2, $3, 'email', 'Founder witnessed email', $4, $4,
               true, true, 'normal')`,
      [pointId, workspaceId, contactId, address]);
    await ownerQuery(pool,
      `INSERT INTO app.communication_suppression_events
         (workspace_id, contact_id, contact_point_id, channel, purpose, state,
          reason, source, source_event_id, actor_kind, endpoint_identity_sha256,
          occurred_at)
       VALUES ($1, $2, $3, 'email', 'marketing', 'suppressed', 'manual',
               'founder-pilot', $4, 'system', $5, statement_timestamp())`,
      [workspaceId, contactId, pointId, `suppression:${contactId}`,
        digest(['email', address, address].join(String.fromCharCode(31)))]);

    crmPool = await openCrmLoginPool(pool);
    const ownerContext = {
      workspaceId, userId: ownerId, requestId: `0063-owner-${randomUUID()}`,
    };
    const first = await crmQuery<{
      disposition: string; consent_event_id: string; receipt_id: string;
    }>(crmPool, ownerContext, callSql, values);
    assert.equal(first[0]?.disposition, 'applied');

    const replay = await crmQuery<{
      disposition: string; consent_event_id: string; receipt_id: string;
    }>(crmPool, { ...ownerContext, requestId: `0063-replay-${randomUUID()}` }, callSql, values);
    assert.deepEqual(replay[0], {
      disposition: 'replayed',
      consent_event_id: first[0]!.consent_event_id,
      receipt_id: first[0]!.receipt_id,
    });

    await expectPostgresError(
      crmQuery(crmPool, { ...ownerContext, requestId: `0063-conflict-${randomUUID()}` },
        callSql, [...values.slice(0, 5), 'denied', null, ...values.slice(7)]),
      '23505',
    );
    await expectPostgresError(
      crmQuery(crmPool, {
        workspaceId, userId: marketerId, requestId: `0063-marketer-${randomUUID()}`,
      }, callSql, [...values.slice(0, 11), digest(`marketer-${randomUUID()}`), occurredAt]),
      '42501',
    );
    await expectPostgresError(
      crmQuery(crmPool, {
        workspaceId: otherWorkspaceId, userId: ownerId,
        requestId: `0063-cross-workspace-${randomUUID()}`,
      }, callSql, [otherWorkspaceId, ...values.slice(1, 11),
        digest(`cross-${randomUUID()}`), occurredAt]),
      '42501',
    );
    await expectPostgresError(
      crmQuery(crmPool, { ...ownerContext, requestId: `0063-channel-${randomUUID()}` },
        callSql, [...values.slice(0, 3), 'sms', ...values.slice(4, 11),
          digest(`channel-${randomUUID()}`), occurredAt]),
      '22023',
    );
    await expectPostgresError(
      crmQuery(crmPool, ownerContext,
        'SELECT count(*)::int AS count FROM app.contact_permission_command_receipts'),
      '42501',
    );

    const evidence = await ownerQuery<{
      state: string; endpoint_hex: string; suppression_count: number;
      consent_count: number;
    }>(pool,
      `SELECT consent.state,
              pg_catalog.encode(consent.endpoint_identity_sha256, 'hex') AS endpoint_hex,
              (SELECT count(*)::int FROM app.communication_suppression_events
               WHERE workspace_id = $1 AND contact_point_id = $2
                 AND state = 'suppressed') AS suppression_count,
              (SELECT count(*)::int FROM app.communication_consent_events
               WHERE workspace_id = $1 AND contact_point_id = $2) AS consent_count
       FROM app.communication_consent_events AS consent
       WHERE consent.workspace_id = $1 AND consent.contact_point_id = $2`,
      [workspaceId, pointId]);
    assert.deepEqual(evidence, [{
      state: 'granted',
      endpoint_hex: digest(['email', address, address]
        .join(String.fromCharCode(31))).toString('hex'),
      suppression_count: 1,
      consent_count: 1,
    }]);

    const privileges = await ownerQuery<{
      can_mutate_suppression: boolean; can_rewrite_consent: boolean;
      command_can_read_receipts: boolean;
    }>(pool,
      `SELECT
         has_table_privilege('r72_contact_permission_definer',
           'app.communication_suppression_events', 'INSERT,UPDATE,DELETE,TRUNCATE')
           AS can_mutate_suppression,
         has_table_privilege('r72_contact_permission_definer',
           'app.communication_consent_events', 'UPDATE,DELETE,TRUNCATE')
           AS can_rewrite_consent,
         has_table_privilege('r72_crm_command',
           'app.contact_permission_command_receipts', 'SELECT')
           AS command_can_read_receipts`);
    assert.deepEqual(privileges, [{
      can_mutate_suppression: false,
      can_rewrite_consent: false,
      command_can_read_receipts: false,
    }]);
  } finally {
    await crmPool?.end();
    await clearCrmPassword(pool).catch(() => undefined);
    await pool.end();
  }
});
