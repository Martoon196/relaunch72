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

async function webhookQuery<T extends QueryResultRow>(
  pool: Pool,
  workspaceId: string,
  requestId: string,
  sql: string,
  values: readonly unknown[] = [],
): Promise<readonly T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.workspace_id', $1, true),
              set_config('app.user_id', '', true),
              set_config('app.actor_kind', 'webhook', true),
              set_config('app.request_id', $2, true)`,
      [workspaceId, requestId],
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

const loginRoles = [
  'r72_whatsapp_live_webhook_command', 'r72_crm_command', 'r72_web',
] as const;

async function openRoleLoginPool(ownerPool: Pool, role: typeof loginRoles[number]): Promise<Pool> {
  const rawUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!rawUrl) throw new Error('TEST_DATABASE_URL is required');
  const password = `operational-inbox-${randomUUID()}`;
  const client = await ownerPool.connect();
  try {
    const statement = await client.query<{ sql: string }>(
      `SELECT pg_catalog.format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql`,
      [role, password],
    );
    await client.query(statement.rows[0]!.sql);
  } finally {
    client.release();
  }
  const roleUrl = new URL(rawUrl);
  roleUrl.username = role;
  roleUrl.password = password;
  return new Pool({ connectionString: roleUrl.toString(), max: 1 });
}

async function clearRoleLoginPasswords(ownerPool: Pool): Promise<void> {
  const client = await ownerPool.connect();
  try {
    for (const role of loginRoles) await client.query(`ALTER ROLE ${role} PASSWORD NULL`);
  } finally {
    client.release();
  }
}

async function loginScopedQuery<T extends QueryResultRow>(
  pool: Pool,
  actorKind: 'user' | 'webhook',
  context: { workspaceId: string; userId?: string; requestId: string },
  sql: string,
  values: readonly unknown[] = [],
): Promise<readonly T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.workspace_id', $2, true),
              set_config('app.actor_kind', $3, true),
              set_config('app.request_id', $4, true)`,
      [context.userId ?? '', context.workspaceId, actorKind, context.requestId],
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

test('0055 atomically projects verified WhatsApp inbound and fences Inbox operations', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const ownerId = randomUUID();
  const contactId = randomUUID();
  const contactPointId = randomUUID();
  const connectionId = randomUUID();
  const endpointId = randomUUID();
  const inboxId = randomUUID();
  const bindingId = randomUUID();
  const sessionHash = digest('0055-disposable-session');
  const sender = '447700900111';
  const body = 'Signed WhatsApp reply for disposable 0055 proof.';
  const externalEventId = `evt-${randomUUID()}`;
  const providerMessageId = `wamid.${'A'.repeat(32)}`;
  const payloadSha = digest('0055-disposable-payload');
  const signatureSha = digest('0055-disposable-signature');
  const senderSha = digest(sender);
  const bodySha = digest(body);
  const eventIdentitySha = digest([
    externalEventId, providerMessageId, senderSha.toString('hex'),
    bodySha.toString('hex'), payloadSha.toString('hex'), signatureSha.toString('hex'),
  ].join(String.fromCharCode(31)));
  const occurredAt = new Date().toISOString();
  let webhookPool: Pool | undefined;
  let crmPool: Pool | undefined;
  let webPool: Pool | undefined;
  try {
    await resetIdentityTables(pool);
    await ownerQuery(pool,
      `INSERT INTO app.organizations (id, name, slug, kind, status)
       VALUES ($1, '0055 disposable proof', $2, 'direct_customer', 'active')`,
      [organizationId, `inbox-0055-${organizationId.slice(0, 8)}`]);
    await ownerQuery(pool,
      `INSERT INTO app.users (id, email, status, email_verified_at)
       VALUES ($1, $2, 'active', statement_timestamp())`,
      [ownerId, `inbox-0055-${ownerId.slice(0, 8)}@example.test`]);
    await ownerQuery(pool,
      `INSERT INTO app.organization_memberships (organization_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active')`, [organizationId, ownerId]);
    await ownerQuery(pool,
      `INSERT INTO app.workspaces (id, organization_id, name, slug, status)
       VALUES ($1, $2, '0055 proof', $3, 'active')`,
      [workspaceId, organizationId, `inbox-0055-${workspaceId.slice(0, 8)}`]);
    await ownerQuery(pool,
      `INSERT INTO app.workspace_memberships (
         workspace_id, organization_id, user_id, role, status
       ) VALUES ($1, $2, $3, 'owner', 'active')`,
      [workspaceId, organizationId, ownerId]);
    await ownerQuery(pool,
      `INSERT INTO app.user_sessions (
         token_hash, csrf_secret_hash, user_id, selected_workspace_id, expires_at
       ) VALUES ($1, $2, $3, $4, statement_timestamp() + interval '1 hour')`,
      [sessionHash, digest('0055-csrf'), ownerId, workspaceId]);
    await ownerQuery(pool,
      `INSERT INTO app.contacts (
         id, workspace_id, display_name, lifecycle_status, source, owner_user_id
       ) VALUES ($1, $2, '0055 verified lead', 'lead', 'meta_whatsapp', $3)`,
      [contactId, workspaceId, ownerId]);
    await ownerQuery(pool,
      `INSERT INTO app.contact_points (
         id, workspace_id, contact_id, kind, label, value, normalized_value,
         is_primary, is_verified, dedupe_state
       ) VALUES ($1, $2, $3, 'whatsapp', 'Verified WhatsApp', $4, $4,
                 true, true, 'normal')`,
      [contactPointId, workspaceId, contactId, sender]);
    await ownerQuery(pool,
      `INSERT INTO app.provider_connections (
         id, workspace_id, provider_id, provider_kind, environment,
         status, display_name, capabilities, created_by_user_id
       ) VALUES ($1, $2, 'meta_whatsapp_cloud', 'messaging', 'live',
                 'active', 'Meta WhatsApp disposable proof', '["whatsapp"]', $3)`,
      [connectionId, workspaceId, ownerId]);
    await ownerQuery(pool,
      `INSERT INTO app.channel_endpoints (
         id, workspace_id, provider_connection_id, channel, environment,
         direction, address, normalized_address, display_name, status
       ) VALUES ($1, $2, $3, 'whatsapp', 'live', 'bidirectional',
                 '447700900999', '447700900999', 'Owned WhatsApp proof', 'active')`,
      [endpointId, workspaceId, connectionId]);
    await ownerQuery(pool,
      `INSERT INTO app.inboxes (
         id, workspace_id, channel_endpoint_id, provider_connection_id,
         channel, environment, name, status
       ) VALUES ($1, $2, $3, $4, 'whatsapp', 'live', 'Owned WhatsApp inbox', 'active')`,
      [inboxId, workspaceId, endpointId, connectionId]);
    await ownerQuery(pool,
      `INSERT INTO app.property_predator_whatsapp_live_bindings (
         id, workspace_id, provider_connection_id, environment, provider_id,
         app_id, waba_id, phone_number_id, owned_phone_sha256,
         graph_api_version, secret_algorithm, secret_key_version,
         secret_iv, secret_ciphertext, secret_auth_tag,
         secret_aad_sha256, secret_payload_sha256,
         ownership_evidence_sha256, ownership_observed_at, created_by_user_id
       ) VALUES ($1, $2, $3, 'live', 'meta_whatsapp_cloud',
         '12345', '23456', '34567', $4, 'v24.0', 'aes-256-gcm-v1', 'test-v1',
         $5, $6, $7, $8, $9, $10, statement_timestamp(), $11)`,
      [bindingId, workspaceId, connectionId, digest('owned-phone'),
        Buffer.alloc(12, 1), Buffer.alloc(38, 2), Buffer.alloc(16, 3),
        digest('aad'), digest('secret-payload'), digest('ownership'), ownerId]);

    webhookPool = await openRoleLoginPool(pool, 'r72_whatsapp_live_webhook_command');
    crmPool = await openRoleLoginPool(pool, 'r72_crm_command');
    webPool = await openRoleLoginPool(pool, 'r72_web');

    const projectionSql = `
      SELECT disposition, receipt_id::text, conversation_id::text,
             message_id::text, admin_call_task_id::text
      FROM app_private.record_whatsapp_live_inbound_projection(
        $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text,
        $7::bytea, $8::bytea, $9::bytea, $10::bytea, $11::bytea, $12::timestamptz
      )`;
    const values = [workspaceId, bindingId, externalEventId, providerMessageId,
      sender, body, senderSha, bodySha, payloadSha, signatureSha,
      eventIdentitySha, occurredAt];
    const first = await webhookQuery<{
      disposition: string; receipt_id: string; conversation_id: string;
      message_id: string; admin_call_task_id: string;
    }>(webhookPool, workspaceId, '0055-whatsapp-first', projectionSql, values);
    assert.equal(first[0]?.disposition, 'applied');
    const replay = await webhookQuery<{ disposition: string }>(
      webhookPool, workspaceId, '0055-whatsapp-replay', projectionSql, values,
    );
    assert.equal(replay[0]?.disposition, 'replayed');

    const conversationId = first[0]!.conversation_id;
    const taskId = first[0]!.admin_call_task_id;
    const context = { workspaceId, userId: ownerId, requestId: '0055-operator' };
    const conversation = await ownerQuery<{ row_version: string }>(pool,
      `SELECT row_version::text FROM app.conversations
       WHERE workspace_id = $1 AND id = $2`, [workspaceId, conversationId]);
    const assignment = await loginScopedQuery<{ disposition: string }>(
      crmPool, 'user', context,
      `SELECT disposition FROM app_private.assign_operational_inbox_conversation(
         $1, $2, $3, NULL, $4, '0055-unassign-command'
       )`, [workspaceId, sessionHash, conversationId, conversation[0]!.row_version],
    );
    assert.equal(assignment[0]?.disposition, 'applied');
    const note = await loginScopedQuery<{ disposition: string }>(
      crmPool, 'user', { ...context, requestId: '0055-note' },
      `SELECT disposition FROM app_private.append_operational_inbox_internal_note(
         $1, $2, $3, 'Founder-only disposable proof note', '0055-note-command'
       )`, [workspaceId, sessionHash, conversationId],
    );
    assert.equal(note[0]?.disposition, 'applied');
    const outcome = await loginScopedQuery<{ disposition: string; next_task_id: string }>(
      crmPool, 'user', { ...context, requestId: '0055-outcome' },
      `SELECT disposition, next_task_id::text
       FROM app_private.record_operational_inbox_admin_call_outcome(
         $1, $2, $3, $4, 1, 'qualified', 'Qualified in disposable proof',
         statement_timestamp(), 'internal_follow_up', 'Review exact next step',
         statement_timestamp() + interval '1 day', 'high', '0055-outcome-command'
       )`, [workspaceId, sessionHash, conversationId, taskId],
    );
    assert.equal(outcome[0]?.disposition, 'applied');
    assert.match(outcome[0]!.next_task_id, /^[0-9a-f-]{36}$/u);

    const truth = await loginScopedQuery<{ rail: string; blocker_codes: string[] }>(
      webPool, 'user', { ...context, requestId: '0055-truth' },
      `SELECT rail, blocker_codes
       FROM app_private.property_predator_live_channel_truth()
       ORDER BY rail`,
    );
    assert.deepEqual(truth.map((row) => row.rail), [
      'customer_email', 'owned_social', 'social_dm', 'whatsapp',
    ]);
    assert.deepEqual(
      truth.find((row) => row.rail === 'social_dm')?.blocker_codes,
      ['LIVE_ADAPTER_NOT_COMPOSED'],
    );

    const capabilities = await ownerQuery<{
      old_receipt: boolean; projection: boolean; direct_table: boolean;
    }>(pool, `SELECT
      has_function_privilege('r72_whatsapp_live_webhook_command',
        'app_private.record_whatsapp_live_inbound_receipt(uuid,uuid,text,text,bytea,bytea,bytea,timestamptz)', 'EXECUTE') AS old_receipt,
      has_function_privilege('r72_whatsapp_live_webhook_command',
        'app_private.record_whatsapp_live_inbound_projection(uuid,uuid,text,text,text,text,bytea,bytea,bytea,bytea,bytea,timestamptz)', 'EXECUTE') AS projection,
      has_table_privilege('r72_crm_command',
        'app.property_predator_admin_call_outcomes', 'INSERT') AS direct_table`);
    assert.deepEqual(capabilities, [{
      old_receipt: false, projection: true, direct_table: false,
    }]);
    await expectPostgresError(
      webhookQuery(webhookPool, workspaceId, '0055-webhook-table-attack',
        `UPDATE app.conversations SET subject = 'forged' WHERE id = $1`,
        [conversationId]),
      '42501',
    );
  } finally {
    await Promise.all([
      webhookPool?.end(), crmPool?.end(), webPool?.end(),
    ]);
    await clearRoleLoginPasswords(pool).catch(() => undefined);
    await pool.end();
  }
});
