import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { withTransaction } from '../../src/db/transaction.js';
import {
  assertPgTestInboxWebhookIngressReady,
  PgTestInboxWebhookRepository,
  TestInboxWebhookEventConflictError,
  TestInboxWebhookSignatureReplayError,
  type VerifiedTestInboxWebhookRecordInput,
} from '../../src/test-inbox-webhook-pg/index.js';
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

function commandPool(pool: Pool): Pick<Pool, 'connect'> {
  return {
    connect: (async () => {
      const client = await pool.connect();
      const wrapped = {
        query: async (sql: string, values?: readonly unknown[]) => {
          const result = await client.query(sql, values ? [...values] : undefined);
          if (/^BEGIN\b/.test(sql)) {
            await client.query('SET LOCAL ROLE r72_test_inbox_webhook_command');
          }
          return result;
        },
        release: (destroy?: boolean) => client.release(destroy),
      };
      return wrapped as unknown as PoolClient;
    }) as Pool['connect'],
  };
}

function runtimeCommandPool(pool: Pool): Pick<Pool, 'query' | 'connect'> {
  const connected = commandPool(pool);
  const query = async <TRow extends QueryResultRow>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<TRow>> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE r72_test_inbox_webhook_command');
      const result = await client.query<TRow>(sql, [...values]);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
  return { connect: connected.connect, query: query as Pool['query'] };
}

function webPool(pool: Pool): Pick<Pool, 'connect'> {
  return {
    connect: (async () => {
      const client = await pool.connect();
      const wrapped = {
        query: async (sql: string, values?: readonly unknown[]) => {
          const result = await client.query(sql, values ? [...values] : undefined);
          if (/^BEGIN\b/.test(sql)) await client.query('SET LOCAL ROLE r72_web');
          return result;
        },
        release: (destroy?: boolean) => client.release(destroy),
      };
      return wrapped as unknown as PoolClient;
    }) as Pool['connect'],
  };
}

async function directRoleQuery(pool: Pool, role: string, sql: string): Promise<unknown> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    const result = await client.query(sql);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('signed TEST inbox webhook receipt atomically appends and replay-protects inbound messages', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const ownerId = randomUUID();
  const outsiderId = randomUUID();
  const contactId = randomUUID();
  const contactPointId = randomUUID();
  const connectionId = randomUUID();
  const endpointId = randomUUID();
  const inboxId = randomUUID();
  const source = '+447700900002';
  const destination = '+447700900001';
  const occurredAt = new Date().toISOString();
  const base: VerifiedTestInboxWebhookRecordInput = {
    workspaceId,
    providerConnectionId: connectionId,
    providerId: 'whatsapp_dark_simulator',
    inboxId,
    contactId,
    contactPointId,
    externalEventId: `waevt_${'a'.repeat(32)}`,
    occurredAt,
    payloadSha256: digest('payload-a'),
    eventIdentitySha256: digest('event-a'),
    signatureSha256: digest('signature-a'),
    sourceIdentitySha256: digest(source),
    destinationIdentitySha256: digest(destination),
    body: 'First signed fictional WhatsApp inbound.',
  };

  try {
    await resetIdentityTables(pool);
    const suffix = workspaceId.replaceAll('-', '').slice(0, 10);
    await ownerQuery(pool,
      `INSERT INTO app.organizations (id, name, slug, kind, status)
       VALUES ($1, 'Test inbox webhook', $2, 'direct_customer', 'active')`,
      [organizationId, `test-hook-${suffix}`]);
    await ownerQuery(pool,
      `INSERT INTO app.users (id, email, status, email_verified_at)
       VALUES ($1, $2, 'active', statement_timestamp())`,
      [ownerId, `test-hook-${ownerId.slice(0, 8)}@example.test`]);
    await ownerQuery(pool,
      `INSERT INTO app.users (id, email, status, email_verified_at)
       VALUES ($1, $2, 'active', statement_timestamp())`,
      [outsiderId, `test-hook-${outsiderId.slice(0, 8)}@example.test`]);
    await ownerQuery(pool,
      `INSERT INTO app.workspaces (id, organization_id, name, slug, status)
       VALUES ($1, $2, 'Test inbox webhook', $3, 'active')`,
      [workspaceId, organizationId, `test-hook-${suffix}`]);
    await ownerQuery(pool,
      `INSERT INTO app.workspace_memberships (
         workspace_id, organization_id, user_id, role, status
       ) VALUES ($1, $2, $3, 'owner', 'active')`,
      [workspaceId, organizationId, ownerId]);
    await ownerQuery(pool,
      `INSERT INTO app.contacts (
         id, workspace_id, display_name, lifecycle_status, source
       ) VALUES ($1, $2, 'Reserved webhook lead', 'lead', 'integration')`,
      [contactId, workspaceId]);
    await ownerQuery(pool,
      `INSERT INTO app.contact_points (
         id, workspace_id, contact_id, kind, label, value,
         normalized_value, is_primary, is_verified, dedupe_state
       ) VALUES (
         $1, $2, $3, 'whatsapp', 'Reserved test WhatsApp',
         $4, $4, true, true, 'normal'
       )`,
      [contactPointId, workspaceId, contactId, source]);
    await ownerQuery(pool,
      `INSERT INTO app.provider_connections (
         id, workspace_id, provider_id, provider_kind, environment,
         status, display_name, capabilities, created_by_user_id
       ) VALUES (
         $1, $2, 'whatsapp_dark_simulator', 'messaging', 'test',
         'active', 'WhatsApp dark simulator', '["whatsapp"]'::jsonb, $3
       )`,
      [connectionId, workspaceId, ownerId]);
    await ownerQuery(pool,
      `INSERT INTO app.channel_endpoints (
         id, workspace_id, provider_connection_id, channel, environment,
         direction, address, normalized_address, display_name, status
       ) VALUES (
         $1, $2, $3, 'whatsapp', 'test', 'bidirectional',
         $4, $4, 'Owned reserved WhatsApp', 'active'
       )`,
      [endpointId, workspaceId, connectionId, destination]);
    await ownerQuery(pool,
      `INSERT INTO app.inboxes (
         id, workspace_id, channel_endpoint_id, provider_connection_id,
         channel, environment, name, status
       ) VALUES (
         $1, $2, $3, $4, 'whatsapp', 'test',
         'Reserved WhatsApp inbox', 'active'
       )`,
      [inboxId, workspaceId, endpointId, connectionId]);

    const repository = new PgTestInboxWebhookRepository({
      commandPool: commandPool(pool),
      binding: {
        workspaceId, providerConnectionId: connectionId,
        providerId: 'whatsapp_dark_simulator', inboxId,
        contactId, contactPointId,
      },
    });
    const installation = await ownerQuery<{ installation_id: string }>(pool,
      `SELECT app_private.runtime_database_installation_id()::text AS installation_id`);
    await assert.doesNotReject(assertPgTestInboxWebhookIngressReady(
      runtimeCommandPool(pool),
      {
        workspaceId, providerConnectionId: connectionId,
        providerId: 'whatsapp_dark_simulator', inboxId,
        contactId, contactPointId,
      },
      installation[0]!.installation_id,
    ));
    const first = await repository.record(base);
    assert.equal(first.replayed, false);
    const replay = await repository.record(base);
    assert.deepEqual(replay, { ...first, replayed: true });

    await assert.rejects(repository.record({
      ...base, body: 'Conflicting body under the same signed event.',
    }), TestInboxWebhookEventConflictError);
    await assert.rejects(repository.record({
      ...base,
      externalEventId: `waevt_${'b'.repeat(32)}`,
      payloadSha256: digest('payload-b'),
      eventIdentitySha256: digest('event-b'),
      body: 'Different event reusing a signature.',
    }), TestInboxWebhookSignatureReplayError);

    const second = await repository.record({
      ...base,
      externalEventId: `waevt_${'c'.repeat(32)}`,
      payloadSha256: digest('payload-c'),
      eventIdentitySha256: digest('event-c'),
      signatureSha256: digest('signature-c'),
      body: 'Second signed fictional WhatsApp inbound.',
    });
    assert.equal(second.replayed, false);
    assert.equal(second.conversationId, first.conversationId);
    assert.notEqual(second.messageId, first.messageId);

    const durable = await ownerQuery<{
      conversations: number;
      messages: number;
      versions: number;
      receipts: number;
      unread: number;
    }>(pool,
      `SELECT
         (SELECT count(*)::integer FROM app.conversations
           WHERE workspace_id = $1) AS conversations,
         (SELECT count(*)::integer FROM app.messages
           WHERE workspace_id = $1) AS messages,
         (SELECT count(*)::integer FROM app.message_versions
           WHERE workspace_id = $1) AS versions,
         (SELECT count(*)::integer FROM app.test_inbox_webhook_receipts
           WHERE workspace_id = $1) AS receipts,
         (SELECT unread_count FROM app.conversations
           WHERE workspace_id = $1 AND id = $2) AS unread`,
      [workspaceId, first.conversationId]);
    assert.deepEqual(durable, [{
      conversations: 1, messages: 2, versions: 2, receipts: 2, unread: 2,
    }]);

    const evidence = await ownerQuery<{ evidence: Record<string, unknown> }>(pool,
      `SELECT to_jsonb(receipt) AS evidence
       FROM app.test_inbox_webhook_receipts AS receipt
       WHERE receipt.workspace_id = $1
       ORDER BY receipt.occurred_at, receipt.id`,
      [workspaceId]);
    const encodedEvidence = JSON.stringify(evidence);
    assert.equal(encodedEvidence.includes(base.body), false);
    assert.equal(encodedEvidence.includes(source), false);
    assert.equal(encodedEvidence.includes(destination), false);
    assert.equal(encodedEvidence.includes('signature-a'), false);

    const provenance = await withTransaction(
      webPool(pool),
      {
        actorKind: 'user', userId: ownerId, workspaceId,
        requestId: `test-provenance-${randomUUID()}`,
      },
      async (transaction) => transaction.query<{
        receiptId: string;
        providerFamily: string;
        network: string;
        receivedAt: Date;
      } & QueryResultRow>(
        `SELECT receipt_id AS "receiptId",
                provider_family AS "providerFamily",
                network,
                received_at AS "receivedAt"
         FROM app_private.test_inbox_webhook_message_provenance($1, $2, $3)`,
        [workspaceId, first.conversationId, first.messageId],
      ),
      { readOnly: true, isolation: 'repeatable read' },
    );
    assert.equal(provenance.rows.length, 1);
    assert.match(provenance.rows[0]!.receiptId, /^[0-9a-f-]{36}$/);
    assert.equal(provenance.rows[0]!.providerFamily, 'whatsapp');
    assert.equal(provenance.rows[0]!.network, 'whatsapp');
    assert.ok(provenance.rows[0]!.receivedAt instanceof Date);
    assert.deepEqual(Object.keys(provenance.rows[0]!).sort(), [
      'network', 'providerFamily', 'receiptId', 'receivedAt',
    ]);

    const mismatchedProvenance = await withTransaction(
      webPool(pool),
      {
        actorKind: 'user', userId: ownerId, workspaceId,
        requestId: `test-provenance-mismatch-${randomUUID()}`,
      },
      async (transaction) => transaction.query(
        `SELECT * FROM app_private.test_inbox_webhook_message_provenance($1, $2, $3)`,
        [workspaceId, randomUUID(), first.messageId],
      ),
      { readOnly: true },
    );
    assert.equal(mismatchedProvenance.rows.length, 0);

    const nonMemberProvenance = await withTransaction(
      webPool(pool),
      {
        actorKind: 'user', userId: outsiderId, workspaceId,
        requestId: `test-provenance-outsider-${randomUUID()}`,
      },
      async (transaction) => transaction.query(
        `SELECT * FROM app_private.test_inbox_webhook_message_provenance($1, $2, $3)`,
        [workspaceId, first.conversationId, first.messageId],
      ),
      { readOnly: true },
    );
    assert.equal(nonMemberProvenance.rows.length, 0);

    await expectPostgresError(
      directRoleQuery(pool, 'r72_test_inbox_webhook_command', 'SELECT * FROM app.messages LIMIT 1'),
      '42501',
    );
    await expectPostgresError(
      directRoleQuery(pool, 'r72_web', 'SELECT * FROM app.test_inbox_webhook_receipts LIMIT 1'),
      '42501',
    );
    await expectPostgresError(ownerQuery(pool,
      `UPDATE app.test_inbox_webhook_receipts
       SET occurred_at = occurred_at + interval '1 second'
       WHERE workspace_id = $1`,
      [workspaceId]), '55000');
    await expectPostgresError(ownerQuery(pool,
      `INSERT INTO app.provider_connections (
         id, workspace_id, provider_id, provider_kind, environment,
         status, display_name, capabilities, created_by_user_id
       ) VALUES (
         $1, $2, 'social_dm_dark_simulator', 'social', 'live',
         'active', 'Forbidden live simulator', '[]'::jsonb, $3
       )`,
      [randomUUID(), workspaceId, ownerId]), '23514');
  } finally {
    await pool.end();
  }
});
