import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { SqlExecutor } from '../../src/crm-pg/types.js';
import type { DatabaseRequestContext } from '../../src/db/rls.js';
import {
  InboxCommandService,
  InboxProviderDispatcher,
  PgInboxDispatchReader,
  TestConversationProvider,
  type InboxTransactionRunner,
} from '../../src/inbox-pg/index.js';
import {
  PgProviderOperationQueue,
  ProviderOperationConsentChangedError,
} from '../../src/provider-operations-pg/index.js';
import { createPgConversionInboxThreadReadService } from '../../src/portal/conversion-inbox-thread-pg-service.js';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  scopedQuery,
  testDatabaseSkipReason,
} from './database-helper.js';

const skip = testDatabaseSkipReason();

function inboxRunner(pool: Pool): InboxTransactionRunner {
  return {
    async run<T>(
      context: DatabaseRequestContext,
      operation: (transaction: SqlExecutor) => Promise<T>,
      options: Readonly<{ readOnly: boolean; serializable?: boolean; repeatableRead?: boolean }>,
    ): Promise<T> {
      const client = await pool.connect();
      try {
        const isolation = options.serializable ? 'SERIALIZABLE'
          : options.repeatableRead ? 'REPEATABLE READ' : 'READ COMMITTED';
        await client.query(`BEGIN ISOLATION LEVEL ${isolation} ${options.readOnly ? 'READ ONLY' : 'READ WRITE'}`);
        await client.query('SET LOCAL ROLE r72_crm_command');
        await client.query(
          `SELECT set_config('app.user_id', $1, true),
                  set_config('app.workspace_id', $2, true),
                  set_config('app.actor_kind', 'user', true),
                  set_config('app.request_id', $3, true)`,
          [context.userId, context.workspaceId, context.requestId],
        );
        const result = await operation(client as SqlExecutor);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function workerFunctionPool(pool: Pool): Pick<Pool, 'query'> {
  return {
    query: (async (sql: string, values?: readonly unknown[]) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE r72_worker');
        const result = await client.query(sql, values ? [...values] : undefined);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }) as Pool['query'],
  };
}

function workerConnectPool(pool: Pool): Pick<Pool, 'connect'> {
  return {
    connect: (async () => {
      const client = await pool.connect();
      const wrapped = {
        query: async (sql: string, values?: readonly unknown[]) => {
          const result = await client.query(sql, values ? [...values] : undefined);
          if (/^BEGIN\b/.test(sql)) await client.query('SET LOCAL ROLE r72_worker');
          return result;
        },
        release: (destroy?: boolean) => client.release(destroy),
      };
      return wrapped as unknown as PoolClient;
    }) as Pool['connect'],
  };
}

function webConnectPool(pool: Pool): Pick<Pool, 'connect'> {
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

test('test inbox is approval/consent bound, dispatches without network and fences consent races', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  const organizationId = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const contactA = randomUUID();
  const contactPointA = randomUUID();
  const contextA: DatabaseRequestContext = {
    actorKind: 'user', workspaceId: workspaceA, userId: ownerA,
    requestId: 'inbox-provider-integration',
  };

  try {
    await resetIdentityTables(pool);
    const suffix = organizationId.replaceAll('-', '').slice(0, 10);
    await ownerQuery(pool,
      `INSERT INTO app.organizations (id, name, slug, kind, status)
       VALUES ($1, 'Inbox integration', $2, 'direct_customer', 'active')`,
      [organizationId, `inbox-${suffix}`]);
    await ownerQuery(pool,
      `INSERT INTO app.users (id, email, status, email_verified_at)
       VALUES ($1, $2, 'active', statement_timestamp()),
              ($3, $4, 'active', statement_timestamp())`,
      [ownerA, `inbox-a-${ownerA.slice(0, 8)}@example.test`,
        ownerB, `inbox-b-${ownerB.slice(0, 8)}@example.test`]);
    await ownerQuery(pool,
      `INSERT INTO app.workspaces (id, organization_id, name, slug, status)
       VALUES ($1, $2, 'Inbox A', $3, 'active'),
              ($4, $2, 'Inbox B', $5, 'active')`,
      [workspaceA, organizationId, `inbox-a-${workspaceA.slice(0, 8)}`,
        workspaceB, `inbox-b-${workspaceB.slice(0, 8)}`]);
    await ownerQuery(pool,
      `INSERT INTO app.workspace_memberships (
         workspace_id, organization_id, user_id, role, status
       ) VALUES ($1, $2, $3, 'owner', 'active'),
                ($4, $2, $5, 'owner', 'active')`,
      [workspaceA, organizationId, ownerA, workspaceB, ownerB]);
    await ownerQuery(pool,
      `INSERT INTO app.contacts (
         id, workspace_id, display_name, lifecycle_status, source
       ) VALUES ($1, $2, 'Reserved Test Lead', 'lead', 'integration')`,
      [contactA, workspaceA]);
    await ownerQuery(pool,
      `INSERT INTO app.contact_points (
         id, workspace_id, contact_id, kind, label, value,
         normalized_value, is_primary, is_verified, dedupe_state
       ) VALUES (
         $1, $2, $3, 'email', 'Test email', $4, $4, true, true, 'normal'
       )`,
      [contactPointA, workspaceA, contactA, 'lead@propertypredator.invalid']);
    const consentEventId = randomUUID();
    await ownerQuery(pool,
      `INSERT INTO app.communication_consent_events (
         id, workspace_id, contact_id, contact_point_id, channel, purpose,
         state, lawful_basis, source, policy_version, actor_kind,
         actor_user_id, evidence, endpoint_identity_sha256, occurred_at
       ) VALUES (
         $1, $2, $3, $4, 'email', 'marketing', 'granted', 'consent',
         'integration', 'test-v1', 'user', $5, '{}'::jsonb,
         decode(repeat('00', 32), 'hex'), statement_timestamp()
       )`,
      [consentEventId, workspaceA, contactA, contactPointA, ownerA]);

    const service = new InboxCommandService({ transactionRunner: inboxRunner(pool) });
    const configuration = await service.configureTestInbox(contextA, {
      commandKey: 'integration-configure-email', channel: 'email',
      name: 'Property Predator Test Inbox',
      endpointAddress: 'team@propertypredator.invalid',
      endpointDisplayName: 'Property Predator Test',
    });
    const inbound = await service.recordTestInbound(contextA, {
      commandKey: 'integration-inbound-1', inboxId: configuration.inboxId,
      contactId: contactA, contactPointId: contactPointA,
      body: 'Hello from a reserved integration lead.', occurredAt: new Date().toISOString(),
    });

    const approveAndQueue = async (key: string) => {
      const draft = await service.createDraft(contextA, {
        commandKey: `${key}-draft`, conversationId: inbound.conversationId,
        contactPointId: contactPointA, body: `Approved reserved copy ${key}`,
      });
      const requested = await service.requestApproval(contextA, {
        commandKey: `${key}-request`, messageId: draft.messageId,
        expectedRowVersion: draft.rowVersion,
      });
      const approved = await service.decideApproval(contextA, {
        commandKey: `${key}-approve`, approvalRequestId: requested.approvalRequestId,
        decision: 'approved',
      });
      return service.queueApprovedMessage(contextA, {
        commandKey: `${key}-queue`, messageId: approved.messageId,
        expectedRowVersion: approved.rowVersion, purpose: 'marketing',
      });
    };

    const firstDraft = await service.createDraft(contextA, {
      commandKey: 'first-draft', conversationId: inbound.conversationId,
      contactPointId: contactPointA, body: 'Approved reserved copy first',
    });
    const firstRequested = await service.requestApproval(contextA, {
      commandKey: 'first-request', messageId: firstDraft.messageId,
      expectedRowVersion: firstDraft.rowVersion,
    });
    const threadReader = createPgConversionInboxThreadReadService(webConnectPool(pool));
    const pendingThread = await threadReader.thread(contextA, inbound.conversationId);
    assert.equal(pendingThread?.contactPointId, contactPointA);
    assert.equal(pendingThread?.messages.at(-1)?.messageId, firstDraft.messageId);
    assert.equal(pendingThread?.draft.messageId, firstDraft.messageId);
    assert.equal(pendingThread?.draft.approvalState, 'pending');
    assert.equal(pendingThread?.draft.purpose, 'marketing');
    assert.equal(pendingThread?.consents[0]?.state, 'permitted');
    assert.equal(pendingThread?.lead.displayName, 'Reserved Test Lead');
    assert.equal(JSON.stringify(pendingThread).includes('lead@propertypredator.invalid'), false);
    assert.equal(await threadReader.thread({
      actorKind: 'user', workspaceId: workspaceB, userId: ownerB,
      requestId: 'inbox-thread-cross-workspace-denied',
    }, inbound.conversationId), null);

    const firstApproved = await service.decideApproval(contextA, {
      commandKey: 'first-approve', approvalRequestId: firstRequested.approvalRequestId,
      decision: 'approved',
    });
    const firstQueued = await service.queueApprovedMessage(contextA, {
      commandKey: 'first-queue', messageId: firstApproved.messageId,
      expectedRowVersion: firstApproved.rowVersion, purpose: 'marketing',
    });
    const queuedThread = await threadReader.thread(contextA, inbound.conversationId);
    assert.equal(queuedThread?.draft.messageId, null);
    assert.equal(queuedThread?.messages.at(-1)?.lifecycle, 'committed');
    assert.equal(queuedThread?.messages.at(-1)?.deliveryState, 'queued');
    assert.equal((await service.queueApprovedMessage(contextA, {
      commandKey: 'first-queue', messageId: firstQueued.messageId,
      expectedRowVersion: firstQueued.rowVersion - 1, purpose: 'marketing',
    })).disposition, 'replayed');

    const queue = new PgProviderOperationQueue(workerFunctionPool(pool));
    const provider = new TestConversationProvider();
    const dispatcher = new InboxProviderDispatcher({ queue,
      reader: new PgInboxDispatchReader(workerConnectPool(pool)), provider });
    const lease = { workerId: randomUUID(), leaseToken: randomBytes(32) };
    const sent = await dispatcher.runOnce(lease);
    assert.equal(sent.disposition, 'settled');
    assert.equal(provider.audit.length, 1);

    const durable = await ownerQuery<{
      operation_state: string;
      delivery_status: string;
      payload: Record<string, unknown>;
    }>(pool,
      `SELECT operation.state AS operation_state,
              delivery.status AS delivery_status, event.payload
       FROM app.provider_operations AS operation
       JOIN app.message_deliveries AS delivery
         ON delivery.workspace_id = operation.workspace_id
        AND delivery.provider_operation_id = operation.id
       JOIN app.outbox_events AS event
         ON event.workspace_id = delivery.workspace_id
        AND event.aggregate_id = delivery.message_id
        AND event.event_type = 'conversation.message.sent'
       WHERE operation.id = $1`,
      [firstQueued.providerOperationId]);
    assert.deepEqual(durable.map((row) => [row.operation_state, row.delivery_status]),
      [['succeeded', 'accepted']]);
    assert.equal(JSON.stringify(durable[0]!.payload).includes('Approved reserved copy'), false);
    assert.equal(JSON.stringify(durable[0]!.payload).includes('@'), false);

    const receipt = await service.recordTestDeliveryReceipt(contextA, {
      commandKey: 'first-delivered-receipt',
      providerOperationId: firstQueued.providerOperationId,
      messageDeliveryId: firstQueued.messageDeliveryId,
      externalEventId: 'test-receipt-first-delivered',
      payloadSha256: '12'.repeat(32), deliveryStatus: 'delivered',
      occurredAt: new Date().toISOString(),
    });
    assert.equal(receipt.effectiveStatus, 'delivered');

    const reconciliationQueued = await approveAndQueue('reconcile');
    const reconciliationLease = { workerId: randomUUID(), leaseToken: randomBytes(32) };
    const [initialReconciliationClaim] = await queue.claim(reconciliationLease);
    assert.equal(
      initialReconciliationClaim?.operationId,
      reconciliationQueued.providerOperationId,
    );
    await queue.markCalling(initialReconciliationClaim!, reconciliationLease);
    const reconciliationReference = `testmsg_${createHash('sha256')
      .update(reconciliationQueued.providerOperationId)
      .digest('hex')
      .slice(0, 24)}`;
    const ambiguous = await queue.settle(initialReconciliationClaim!, reconciliationLease, {
      status: 'pending', externalId: reconciliationReference,
      occurredAt: new Date().toISOString(), retryable: false,
      errorCode: null, summary: 'Provider outcome needs reconciliation',
    });
    assert.equal(ambiguous.operationState, 'reconciliation_required');
    await ownerQuery(pool,
      `UPDATE app.provider_operations
          SET next_attempt_at = statement_timestamp() + interval '1 hour'
        WHERE id = $1`,
      [reconciliationQueued.providerOperationId]);

    const secondQueued = await approveAndQueue('race');
    const raceLease = { workerId: randomUUID(), leaseToken: randomBytes(32) };
    const [raceClaim] = await queue.claim(raceLease);
    assert.equal(raceClaim?.operationId, secondQueued.providerOperationId);
    const raceReader = new PgInboxDispatchReader(workerConnectPool(pool));
    const beforeRevoke = await raceReader.loadAndEvaluate({
      actorKind: 'worker', workspaceId: workspaceA,
      requestId: 'race-preflight',
    }, raceClaim!, raceLease);
    assert.equal(beforeRevoke.status, 'allowed');

    await ownerQuery(pool,
      `INSERT INTO app.communication_suppression_events (
         id, workspace_id, contact_id, contact_point_id, channel, purpose,
         state, reason, source, actor_kind, actor_user_id, evidence,
         endpoint_identity_sha256, occurred_at
       ) VALUES (
         $1, $2, $3, $4, 'email', 'marketing', 'suppressed', 'user_opt_out',
         'integration', 'user', $5, '{}'::jsonb,
         decode(repeat('00', 32), 'hex'), statement_timestamp()
       )`,
      [randomUUID(), workspaceA, contactA, contactPointA, ownerA]);
    await assert.rejects(queue.markCalling(raceClaim!, raceLease),
      ProviderOperationConsentChangedError);
    await queue.cancelBeforeCall(raceClaim!, raceLease, {
      errorCode: 'consent_changed_before_call',
      safeSummary: 'Consent changed before the provider boundary was crossed',
    });
    assert.equal(provider.audit.length, 1);

    await ownerQuery(pool,
      `UPDATE app.provider_operations
          SET next_attempt_at = statement_timestamp()
        WHERE id = $1`,
      [reconciliationQueued.providerOperationId]);
    const reconciled = await dispatcher.runOnce({
      workerId: randomUUID(), leaseToken: randomBytes(32),
    });
    assert.equal(reconciled.disposition, 'settled');
    assert.equal(reconciled.operationState, 'succeeded');
    assert.deepEqual(provider.audit.map((entry) => entry.mode), ['send', 'reconcile']);
    assert.deepEqual(await ownerQuery<{ operation_state: string; delivery_status: string }>(
      pool,
      `SELECT operation.state AS operation_state, delivery.status AS delivery_status
         FROM app.provider_operations AS operation
         JOIN app.message_deliveries AS delivery
           ON delivery.workspace_id = operation.workspace_id
          AND delivery.provider_operation_id = operation.id
        WHERE operation.id = $1`,
      [reconciliationQueued.providerOperationId],
    ), [{ operation_state: 'succeeded', delivery_status: 'accepted' }]);

    assert.deepEqual(await scopedQuery<{ count: number }>(
      pool, 'r72_web', { workspaceId: workspaceB, userId: ownerB },
      'SELECT count(*)::integer AS count FROM app.conversations',
    ), [{ count: 0 }]);
    await expectPostgresError(scopedQuery(
      pool, 'r72_worker', { workspaceId: workspaceA },
      'UPDATE app.provider_operations SET state = state WHERE id = $1',
      [firstQueued.providerOperationId],
    ), '42501');
    await expectPostgresError(scopedQuery(
      pool, 'r72_worker', { workspaceId: workspaceA },
      'SELECT body_text FROM app.message_versions LIMIT 1',
    ), '42501');
    await expectPostgresError(scopedQuery(
      pool, 'r72_crm_command', { workspaceId: workspaceA, userId: ownerA },
      'INSERT INTO app.provider_operation_attempts DEFAULT VALUES',
    ), '42501');
  } finally {
    await resetIdentityTables(pool);
    await pool.end();
  }
});
