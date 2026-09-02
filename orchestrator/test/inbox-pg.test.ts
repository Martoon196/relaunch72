import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import type { SqlExecutor, SqlResult } from '../src/crm-pg/types.js';
import type { DatabaseRequestContext } from '../src/db/rls.js';
import {
  InboxCommandService,
  INBOX_APPROVAL_REVIEW_MAX_BODY_BYTES,
  InboxIdempotencyConflictError,
  InboxValidationError,
  InboxProviderDispatcher,
  InboxPgRepository,
  PgInboxReadService,
  TestConversationProvider,
  inboxCommandHash,
  normalizeConfigureTestInbox,
  normalizeCreateDraft,
  normalizeReviseDraft,
  type InboxDispatchReader,
  type InboxTransactionRunner,
} from '../src/inbox-pg/index.js';
import {
  PgProviderOperationQueue,
  ProviderOperationConsentChangedError,
  ProviderOperationLeaseLostError,
  type ProviderOperationClaim,
  type ProviderOperationLeaseIdentity,
  type ProviderOperationQueue,
} from '../src/provider-operations-pg/index.js';
import type { ProviderOperationResult } from '../src/providers/contracts.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';
const ENDPOINT = '44444444-4444-4444-8444-444444444444';
const INBOX = '55555555-5555-4555-8555-555555555555';
const CONVERSATION = '66666666-6666-4666-8666-666666666666';
const MESSAGE = '77777777-7777-4777-8777-777777777777';
const VERSION = '88888888-8888-4888-8888-888888888888';
const OPERATION = '99999999-9999-4999-8999-999999999999';
const DELIVERY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONSENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WORKER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const userContext: DatabaseRequestContext = {
  actorKind: 'user', workspaceId: WORKSPACE, userId: USER, requestId: 'inbox-test-request',
};

const claim: ProviderOperationClaim = Object.freeze({
  operationId: OPERATION, workspaceId: WORKSPACE,
  providerConnectionId: CONNECTION, messageDeliveryId: DELIVERY,
  environment: 'test', idempotencyKey: `conversation.send:${MESSAGE}:${VERSION}`,
  correlationId: OPERATION, attemptNumber: 1, leaseVersion: 1,
  leaseExpiresAt: '2026-08-26T12:01:00.000Z', attemptKind: 'dispatch',
  providerReference: null,
});
const lease: ProviderOperationLeaseIdentity = {
  workerId: WORKER, leaseToken: Buffer.alloc(32, 7),
};

function queryResult<TRow extends QueryResultRow>(rows: TRow[]): QueryResult<TRow> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

test('inbox normalization is actor-bound, canonical and test destinations fail closed', () => {
  const command = normalizeConfigureTestInbox({
    commandKey: 'setup-email', channel: 'email', name: 'Test email',
    endpointAddress: 'team@propertypredator.invalid', endpointDisplayName: 'Property Predator Test',
  });
  assert.deepEqual(
    inboxCommandHash(userContext, 'inbox.configureTest', command),
    inboxCommandHash(userContext, 'inbox.configureTest', { ...command }),
  );
  assert.notDeepEqual(
    inboxCommandHash(userContext, 'inbox.configureTest', command),
    inboxCommandHash({ ...userContext, userId: WORKER }, 'inbox.configureTest', command),
  );
  assert.throws(() => normalizeConfigureTestInbox({
    commandKey: 'unsafe', channel: 'email', name: 'Unsafe',
    endpointAddress: 'real@example.com', endpointDisplayName: 'Unsafe',
  }), /reserved non-routable/);
  assert.throws(() => normalizeConfigureTestInbox({
    commandKey: 'linkedin-not-sendable', channel: 'linkedin', name: 'LinkedIn',
    endpointAddress: 'test:linkedin', endpointDisplayName: 'LinkedIn',
  } as never), /channel is invalid/);
  assert.throws(() => normalizeCreateDraft({
    commandKey: 'draft', conversationId: CONVERSATION, contactPointId: ENDPOINT,
    body: 'Safe body', sourceContent: {
      versionRef: 'content-v1', sha256: 'AA'.repeat(32), approvalRef: 'approval-1',
    },
  }), /lowercase SHA-256/);
});

test('TestConversationProvider performs no network work and retains only digests', async () => {
  const provider = new TestConversationProvider({
    now: () => new Date('2026-08-26T12:00:00.000Z'),
  });
  const context = {
    workspaceId: WORKSPACE, connectionId: CONNECTION, providerId: 'test_conversation',
    operationId: OPERATION, idempotencyKey: 'send-1', correlationId: OPERATION,
  };
  const result = await provider.sendMessage(context, {
    channel: 'email', recipient: 'lead@propertypredator.invalid',
    text: 'A private draft body', templateId: null, consentRecordId: CONSENT,
  });
  assert.equal(result.status, 'succeeded');
  assert.match(result.externalId!, /^testmsg_[a-f0-9]{24}$/);
  assert.equal(provider.audit.length, 1);
  assert.equal(provider.audit[0]!.recipientSha256,
    createHash('sha256').update('lead@propertypredator.invalid').digest('hex'));
  assert.equal(JSON.stringify(provider.audit).includes('A private draft body'), false);
  assert.equal(JSON.stringify(provider.audit).includes('lead@propertypredator.invalid'), false);
  await assert.rejects(provider.sendMessage({ ...context, operationId: DELIVERY }, {
    channel: 'email', recipient: 'real@example.com', text: 'No', templateId: null,
    consentRecordId: CONSENT,
  }), /reserved non-routable/);
  const reconciled = await provider.reconcile(context, result.externalId!);
  assert.equal(reconciled.status, 'succeeded');
});

test('provider queue hashes leases, validates claims and converts lost fences', async () => {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const pool = {
    async query<TRow extends QueryResultRow>(sql: string, values: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes('provider-operations.claim')) return queryResult([{
        operationId: OPERATION, workspaceId: WORKSPACE,
        providerConnectionId: CONNECTION, messageDeliveryId: DELIVERY,
        environment: 'test', idempotencyKey: 'send-1', correlationId: OPERATION,
        attemptNumber: '1', leaseVersion: '3',
        leaseExpiresAt: new Date('2026-08-26T12:01:00.000Z'),
        attemptKind: 'dispatch', providerReference: null,
      }] as unknown as TRow[]);
      const error = Object.assign(new Error('lost'), { code: '40001' });
      throw error;
    },
  } as unknown as Pick<Pool, 'query'>;
  const queue = new PgProviderOperationQueue(pool);
  const claims = await queue.claim(lease);
  assert.equal(claims.length, 1);
  assert.equal(claims[0]!.attemptNumber, 1);
  assert.equal(claims[0]!.leaseVersion, 3);
  assert.equal(typeof claims[0]!.leaseVersion, 'number');
  assert.deepEqual(calls[0]!.values[1], createHash('sha256').update(lease.leaseToken).digest());
  await assert.rejects(queue.markCalling(claims[0]!, lease), ProviderOperationLeaseLostError);

  const invalidPool = {
    async query<TRow extends QueryResultRow>() {
      return queryResult([{ ...claims[0], environment: 'live' }] as unknown as TRow[]);
    },
  } as unknown as Pick<Pool, 'query'>;
  await assert.rejects(new PgProviderOperationQueue(invalidPool).claim(lease), /invalid canonical data/);

  const unsafeBigintPool = {
    async query<TRow extends QueryResultRow>() {
      return queryResult([{
        ...claims[0],
        leaseVersion: '9007199254740992',
      }] as unknown as TRow[]);
    },
  } as unknown as Pick<Pool, 'query'>;
  await assert.rejects(
    new PgProviderOperationQueue(unsafeBigintPool).claim(lease),
    /leaseVersion returned an invalid integer/,
  );
});

class FakeQueue implements ProviderOperationQueue {
  readonly events: string[] = [];
  settledResult: ProviderOperationResult | null = null;
  cancelled = false;
  consentChangesAtFence = false;
  nextClaim: ProviderOperationClaim = claim;

  async claim(): Promise<readonly ProviderOperationClaim[]> {
    this.events.push('claim');
    return [this.nextClaim];
  }
  async markCalling(): Promise<void> {
    this.events.push('calling');
    if (this.consentChangesAtFence) throw new ProviderOperationConsentChangedError();
  }
  async renew(): Promise<string> { return claim.leaseExpiresAt; }
  async cancelBeforeCall(): Promise<void> { this.events.push('cancel'); this.cancelled = true; }
  async settle(_claim: ProviderOperationClaim, _lease: ProviderOperationLeaseIdentity,
    result: ProviderOperationResult) {
    this.events.push('settle');
    this.settledResult = result;
    return { operationState: result.status === 'succeeded' ? 'succeeded' as const
      : 'reconciliation_required' as const,
    deliveryStatus: result.status === 'succeeded' ? 'accepted' as const
      : 'reconciliation_required' as const,
    completedAt: result.status === 'succeeded' ? result.occurredAt : null };
  }
}

function allowedReader(): InboxDispatchReader {
  return { async loadAndEvaluate() {
    return { status: 'allowed', reason: 'granted', payload: {
      connection: { id: CONNECTION, workspaceId: WORKSPACE, providerId: 'test_conversation' },
      environment: 'test', conversationId: CONVERSATION, messageId: MESSAGE,
      messageVersionId: VERSION, contactPointId: ENDPOINT,
      consentChannel: 'email', purpose: 'marketing', consentEventId: CONSENT,
      request: { channel: 'email', recipient: 'lead@propertypredator.invalid',
        text: 'Approved test copy', templateId: null, consentRecordId: CONSENT },
    } };
  } };
}

test('dispatcher checks current consent before marking calling and settles a reserved test send', async () => {
  const queue = new FakeQueue();
  const provider = new TestConversationProvider({
    now: () => new Date('2026-08-26T12:00:00.000Z'),
  });
  const dispatcher = new InboxProviderDispatcher({ queue, reader: allowedReader(), provider });
  const result = await dispatcher.runOnce(lease);
  assert.deepEqual(queue.events, ['claim', 'calling', 'settle']);
  assert.equal(result.disposition, 'settled');
  assert.equal(provider.audit.length, 1);
  assert.equal(queue.settledResult?.status, 'succeeded');
});

test('dispatcher cancels before provider call when current consent is unavailable', async () => {
  const queue = new FakeQueue();
  const provider = new TestConversationProvider();
  const reader: InboxDispatchReader = { async loadAndEvaluate() {
    return { status: 'blocked', reason: 'withdrawn', payload: null };
  } };
  const result = await new InboxProviderDispatcher({ queue, reader, provider }).runOnce(lease);
  assert.equal(result.disposition, 'cancelled');
  assert.deepEqual(queue.events, ['claim', 'cancel']);
  assert.equal(provider.audit.length, 0);
});

test('dispatcher makes no provider call when consent changes at the calling fence', async () => {
  const queue = new FakeQueue();
  queue.consentChangesAtFence = true;
  const provider = new TestConversationProvider();
  const result = await new InboxProviderDispatcher({
    queue, reader: allowedReader(), provider,
  }).runOnce(lease);
  assert.equal(result.disposition, 'cancelled');
  assert.deepEqual(queue.events, ['claim', 'calling', 'cancel']);
  assert.equal(provider.audit.length, 0);
  assert.equal(queue.settledResult, null);
});

test('dispatcher reconciles an ambiguous call without re-gating status lookup on consent', async () => {
  const queue = new FakeQueue();
  queue.nextClaim = Object.freeze({
    ...claim,
    attemptNumber: 2,
    leaseVersion: 2,
    attemptKind: 'reconcile',
    providerReference: `testmsg_${createHash('sha256').update(OPERATION).digest('hex').slice(0, 24)}`,
  });
  let eligibilityReads = 0;
  const withdrawnReader: InboxDispatchReader = { async loadAndEvaluate() {
    eligibilityReads += 1;
    return { status: 'blocked', reason: 'withdrawn', payload: null };
  } };
  const provider = new TestConversationProvider({
    now: () => new Date('2026-08-26T12:00:00.000Z'),
  });

  const result = await new InboxProviderDispatcher({
    queue,
    reader: withdrawnReader,
    provider,
  }).runOnce(lease);

  assert.equal(eligibilityReads, 0);
  assert.equal(queue.cancelled, false);
  assert.deepEqual(queue.events, ['claim', 'calling', 'settle']);
  assert.equal(result.disposition, 'settled');
  assert.equal(queue.settledResult?.status, 'succeeded');
  assert.deepEqual(provider.audit.map((entry) => entry.mode), ['reconcile']);
});

interface StoredReceipt {
  id: string;
  payloadHash: Uint8Array;
  status: 'started' | 'succeeded';
  result: unknown;
}

class ConfigureSql implements SqlExecutor {
  readonly receipts = new Map<string, StoredReceipt>();
  configurationWrites = 0;

  private result<T extends Record<string, unknown>>(rows: Record<string, unknown>[], rowCount = rows.length): SqlResult<T> {
    return { rows: rows as T[], rowCount };
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<SqlResult<T>> {
    if (sql.includes('inbox.claim-command')) {
      const [id, name, key, , payloadHash] = values as [string, string, string, string, Uint8Array];
      const receiptKey = `${name}:${key}`;
      if (this.receipts.has(receiptKey)) return this.result<T>([]);
      this.receipts.set(receiptKey, { id, payloadHash, status: 'started', result: null });
      return this.result<T>([{ id, payloadHash, status: 'started', result: null }]);
    }
    if (sql.includes('inbox.read-command-receipt')) {
      const existing = this.receipts.get(`${values[0]}:${values[1]}`);
      return this.result<T>(existing ? [existing as unknown as Record<string, unknown>] : []);
    }
    if (sql.includes('inbox.complete-command')) {
      const receipt = [...this.receipts.values()].find((candidate) => candidate.id === values[0])!;
      receipt.status = 'succeeded';
      receipt.result = JSON.parse(String(values[2])) as unknown;
      return this.result<T>([], 1);
    }
    if (sql.includes('inbox.ensure-test-connection')) {
      this.configurationWrites += 1;
      return this.result<T>([{ id: CONNECTION }]);
    }
    if (sql.includes('inbox.ensure-test-channel-endpoint')) return this.result<T>([{ id: ENDPOINT }]);
    if (sql.includes('inbox.ensure-test-inbox')) return this.result<T>([{ id: INBOX }]);
    throw new Error(`Unexpected inbox SQL: ${sql}`);
  }
}

function transactionRunner(sql: SqlExecutor): InboxTransactionRunner {
  return { run: async (_context, operation) => operation(sql) };
}

function ids(): () => string {
  let next = 10;
  return () => `${String(next++).padStart(8, '0')}-dddd-4ddd-8ddd-${String(next).padStart(12, '0')}`;
}

test('inbox commands replay exact results and conflict on changed input', async () => {
  const sql = new ConfigureSql();
  const service = new InboxCommandService({ transactionRunner: transactionRunner(sql),
    nextId: ids(), now: () => new Date('2026-08-26T12:00:00.000Z') });
  const command = { commandKey: 'configure-email', channel: 'email' as const,
    name: 'Test email', endpointAddress: 'team@propertypredator.invalid',
    endpointDisplayName: 'Property Predator Test' };
  const first = await service.configureTestInbox(userContext, command);
  assert.equal(first.disposition, 'applied');
  assert.deepEqual(await service.configureTestInbox(userContext, command), {
    ...first, disposition: 'replayed',
  });
  await assert.rejects(service.configureTestInbox(userContext, {
    ...command, name: 'Changed under same key',
  }), InboxIdempotencyConflictError);
  assert.equal(sql.configurationWrites, 1);
});

class ApprovalBoundarySql implements SqlExecutor {
  readonly writes: string[] = [];

  constructor(
    private readonly bodyBytes: number,
    private readonly lifecycle: 'approval_pending' | 'approved' = 'approval_pending',
    private readonly channel: 'email' | 'linkedin' = 'email',
  ) {}

  async query<T extends Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<SqlResult<T>> {
    if (sql.includes('inbox.claim-command')) {
      return {
        rows: [{
          id: values[0], payloadHash: values[4], status: 'started', result: null,
        }] as unknown as T[],
        rowCount: 1,
      };
    }
    if (sql.includes('inbox.lock-approval-request')
        || sql.includes('inbox.lock-approved-message')) {
      return {
        rows: [{
          conversationId: CONVERSATION,
          providerConnectionId: CONNECTION,
          channelEndpointId: ENDPOINT,
          channel: this.channel,
          environment: 'test',
          contactId: USER,
          contactPointId: ENDPOINT,
          messageId: MESSAGE,
          messageVersionId: VERSION,
          versionNumber: 1,
          bodySha256: createHash('sha256').update('immutable body').digest('hex'),
          bodyBytes: this.bodyBytes,
          lifecycle: this.lifecycle,
          rowVersion: this.lifecycle === 'approved' ? 2 : 1,
          approvalRequestId: DELIVERY,
          requestNumber: 1,
          approvalDecisionId: this.lifecycle === 'approved' ? OPERATION : null,
          decision: this.lifecycle === 'approved' ? 'approved' : null,
        }] as unknown as T[],
        rowCount: 1,
      };
    }
    if (sql.includes('inbox.insert-approval-decision')) {
      this.writes.push('decision');
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('inbox.apply-approval-decision')) {
      this.writes.push('message');
      return { rows: [{ rowVersion: 2 }] as unknown as T[], rowCount: 1 };
    }
    if (sql.includes('inbox.complete-command')) {
      this.writes.push('receipt');
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected approval-boundary SQL: ${sql}`);
  }
}

function approvalBoundaryService(sql: ApprovalBoundarySql): InboxCommandService {
  return new InboxCommandService({
    transactionRunner: transactionRunner(sql),
    nextId: ids(),
    now: () => new Date('2026-08-26T12:00:00.000Z'),
  });
}

test('approval and TEST queue commands fail closed on bodies outside the complete review boundary', async () => {
  const approvalSql = new ApprovalBoundarySql(INBOX_APPROVAL_REVIEW_MAX_BODY_BYTES + 1);
  const approvalService = approvalBoundaryService(approvalSql);
  await assert.rejects(approvalService.decideApproval(userContext, {
    commandKey: 'forged-oversized-approval',
    approvalRequestId: DELIVERY,
    decision: 'approved',
  }), InboxValidationError);
  assert.deepEqual(approvalSql.writes, []);

  const queueSql = new ApprovalBoundarySql(
    INBOX_APPROVAL_REVIEW_MAX_BODY_BYTES + 1,
    'approved',
  );
  const queueService = approvalBoundaryService(queueSql);
  await assert.rejects(queueService.queueApprovedMessage(userContext, {
    commandKey: 'forged-oversized-queue',
    messageId: MESSAGE,
    expectedRowVersion: 2,
    purpose: 'marketing',
  }), InboxValidationError);
  assert.deepEqual(queueSql.writes, []);
});

test('oversized approval targets still accept rejection and changes-requested decisions', async () => {
  for (const decision of ['rejected', 'changes_requested'] as const) {
    const sql = new ApprovalBoundarySql(INBOX_APPROVAL_REVIEW_MAX_BODY_BYTES + 1);
    const result = await approvalBoundaryService(sql).decideApproval(userContext, {
      commandKey: `oversized-${decision}`,
      approvalRequestId: DELIVERY,
      decision,
      decisionNote: `Return the oversized draft as ${decision}.`,
    });
    assert.equal(result.decision, decision);
    assert.equal(result.lifecycle, 'draft');
    assert.deepEqual(sql.writes, ['decision', 'message', 'receipt']);
  }
});

test('inbox repository serializes receipts as JSON and safely maps PostgreSQL bigint rows', async () => {
  const receiptCalls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const receiptExecutor: SqlExecutor = {
    async query<T extends Record<string, unknown>>(
      sql: string,
      values: readonly unknown[] = [],
    ): Promise<SqlResult<T>> {
      receiptCalls.push({ sql, values });
      return { rows: [], rowCount: 1 };
    },
  };
  await new InboxPgRepository(receiptExecutor).completeCommand({
    receiptId: OPERATION,
    payloadHash: Buffer.alloc(32, 3),
    result: Object.freeze({ disposition: 'applied', nested: { ok: true } }),
    completedAt: '2026-08-26T12:00:00.000Z',
  });
  assert.equal(receiptCalls.length, 1);
  assert.equal(receiptCalls[0]!.values[2], '{"disposition":"applied","nested":{"ok":true}}');

  const revision = normalizeReviseDraft({
    commandKey: 'revise-bigint',
    messageId: MESSAGE,
    expectedRowVersion: 1,
    body: 'Revised approved test copy',
  });
  let returnedRowVersion = '2';
  const revisionExecutor: SqlExecutor = {
    async query<T extends Record<string, unknown>>(
      sql: string,
    ): Promise<SqlResult<T>> {
      if (sql.includes('inbox.insert-revision')) {
        return {
          rows: [{ bodySha256: revision.bodySha256 }] as unknown as T[],
          rowCount: 1,
        };
      }
      if (sql.includes('inbox.activate-revision')) {
        return {
          rows: [{ rowVersion: returnedRowVersion }] as unknown as T[],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected revision SQL: ${sql}`);
    },
  };
  const revisionRepository = new InboxPgRepository(revisionExecutor);
  const message = {
    conversationId: CONVERSATION,
    providerConnectionId: CONNECTION,
    channelEndpointId: ENDPOINT,
    channel: 'email' as const,
    environment: 'test' as const,
    contactId: USER,
    contactPointId: ENDPOINT,
    messageId: MESSAGE,
    messageVersionId: VERSION,
    versionNumber: 1,
    bodySha256: createHash('sha256').update('Original copy').digest('hex'),
    lifecycle: 'draft' as const,
    rowVersion: 1,
  };
  const safe = await revisionRepository.insertRevision({
    versionId: DELIVERY,
    message,
    command: revision,
    actorUserId: USER,
    requestId: 'revise-bigint-test',
    at: '2026-08-26T12:00:00.000Z',
  });
  assert.equal(safe?.rowVersion, 2);
  assert.equal(typeof safe?.rowVersion, 'number');

  returnedRowVersion = '9007199254740992';
  await assert.rejects(revisionRepository.insertRevision({
    versionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    message,
    command: revision,
    actorUserId: USER,
    requestId: 'revise-unsafe-bigint-test',
    at: '2026-08-26T12:00:00.000Z',
  }), /Revised message row version is invalid/);
});

test('new inbound conversations clamp application time to the PostgreSQL update clock', async () => {
  let insertSql = '';
  let insertValues: readonly unknown[] = [];
  const executor: SqlExecutor = {
    async query<T extends Record<string, unknown>>(
      sql: string,
      values: readonly unknown[] = [],
    ): Promise<SqlResult<T>> {
      insertSql = sql;
      insertValues = values;
      return { rows: [], rowCount: 1 };
    },
  };
  await new InboxPgRepository(executor).insertConversation({
    id: CONVERSATION,
    inboxId: INBOX,
    channel: 'email',
    contactId: USER,
    firstMessageAt: '2026-08-26T12:00:00.250Z',
    at: '2026-08-26T12:00:00.500Z',
  });

  assert.match(
    insertSql,
    /least\(\$5::timestamptz, \$6::timestamptz, statement_timestamp\(\)\)/u,
  );
  assert.match(insertSql, /statement_timestamp\(\)\s*\n\s*\)/u);
  assert.deepEqual(insertValues.slice(-2), [
    '2026-08-26T12:00:00.250Z',
    '2026-08-26T12:00:00.500Z',
  ]);
});

test('approved LinkedIn evidence cannot enter the outbound queue', async () => {
  const sql = new ApprovalBoundarySql(128, 'approved', 'linkedin');
  await assert.rejects(approvalBoundaryService(sql).queueApprovedMessage(userContext, {
    commandKey: 'linkedin-read-only-queue',
    messageId: MESSAGE,
    expectedRowVersion: 2,
    purpose: 'marketing',
  }), /LinkedIn conversations are read-only/);
  assert.deepEqual(sql.writes, []);
});

test('queued provider work clamps application time to the PostgreSQL update clock', async () => {
  let operationSql = '';
  let deliverySql = '';
  const executor: SqlExecutor = {
    async query<T extends Record<string, unknown>>(
      sql: string,
    ): Promise<SqlResult<T>> {
      if (sql.includes('inbox.insert-provider-operation')) {
        operationSql = sql;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('inbox.insert-message-delivery')) {
        deliverySql = sql;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('inbox.commit-approved-message')) {
        return {
          rows: [{ rowVersion: 3 }] as unknown as T[],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected queue SQL: ${sql}`);
    },
  };

  await new InboxPgRepository(executor).queueApprovedMessage({
    operationId: OPERATION,
    deliveryId: DELIVERY,
    message: {
      conversationId: CONVERSATION,
      providerConnectionId: CONNECTION,
      channelEndpointId: ENDPOINT,
      channel: 'email',
      environment: 'test',
      contactId: USER,
      contactPointId: ENDPOINT,
      messageId: MESSAGE,
      messageVersionId: VERSION,
      versionNumber: 1,
      bodySha256: createHash('sha256').update('Approved copy').digest('hex'),
      bodyBytes: 13,
      lifecycle: 'approved',
      rowVersion: 2,
      approvalRequestId: CONSENT,
      requestNumber: 1,
      approvalDecisionId: WORKER,
      decision: 'approved',
    },
    purpose: 'marketing',
    consentEventId: CONSENT,
    actorUserId: USER,
    at: '2026-08-26T12:00:00.500Z',
  });

  assert.match(
    operationSql,
    /least\(\$7::timestamptz, statement_timestamp\(\)\),\s*statement_timestamp\(\)/u,
  );
  assert.match(
    deliverySql,
    /least\(\$20::timestamptz, statement_timestamp\(\)\),\s*statement_timestamp\(\)/u,
  );
});

class ReadClient {
  invalid = false;
  channel = 'email';
  conversationSql = '';
  async query<TRow extends QueryResultRow>(sql: string): Promise<QueryResult<TRow>> {
    if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK'
        || sql.includes("set_config('app.user_id'")) return queryResult([]);
    if (sql.includes('inbox.read-meta')) return queryResult([{
      workspaceId: WORKSPACE, timezone: 'Europe/London', canWrite: true,
      canManage: false, asOf: new Date('2026-08-26T12:00:00.000Z'),
    }] as unknown as TRow[]);
    if (sql.includes('inbox.list-conversations')) {
      this.conversationSql = sql;
      return queryResult([{
      conversationId: CONVERSATION, inboxId: INBOX, channel: this.channel, environment: 'test', state: 'open',
      contactId: USER, contactName: 'Demo Lead', subject: null, unreadCount: 1,
      assignedUserId: USER, assignedUserName: 'Demo Operator',
      requiresApproval: true,
      lastMessageAt: new Date('2026-08-26T11:59:00.000Z'),
      sortAt: new Date('2026-08-26T11:59:00.000Z'), rowVersion: 2,
      latestMessageId: MESSAGE, latestDirection: 'inbound',
      latestLifecycle: 'received', latestBody: this.invalid ? '' : 'Hello test inbox',
      latestOccurredAt: new Date('2026-08-26T11:59:00.000Z'),
      }] as unknown as TRow[]);
    }
    throw new Error(`Unexpected read SQL: ${sql}`);
  }
  release(): void {}
}

test('inbox read model is bounded, omits endpoint addresses and fails closed on bad rows', async () => {
  const client = new ReadClient();
  const pool = { connect: async () => client } as unknown as Pick<Pool, 'connect'>;
  const service = new PgInboxReadService(pool);
  const page = await service.listConversations(userContext, { limit: 10, search: 'Demo' });
  assert.equal(page.conversations.length, 1);
  assert.equal(page.conversations[0]!.latestMessage?.body, 'Hello test inbox');
  assert.equal(page.conversations[0]!.requiresApproval, true);
  assert.equal(page.conversations[0]!.assignedUserName, 'Demo Operator');
  assert.match(client.conversationSql, /approval_message\.lifecycle = 'approval_pending'/);
  assert.match(client.conversationSql, /approval_message\.lifecycle = 'draft'/);
  assert.match(client.conversationSql, /latest_approval\.decision = 'changes_requested'/);
  assert.match(client.conversationSql,
    /ORDER BY approval_request\.request_number DESC, approval_request\.id DESC\s+LIMIT 1/);
  assert.match(client.conversationSql,
    /latest_approval\.approval_decision_id IS NULL/);
  // Live rail evidence is still required, but r72_web now asks the bounded
  // definer function instead of naming tables it has no privilege on. Reading
  // them directly is what made the whole Inbox, empty state included, fail 42501.
  assert.match(
    client.conversationSql,
    /app_private\.operational_inbox_live_conversation_visible\(\s*conversation\.workspace_id, conversation\.id, conversation\.channel/,
  );
  assert.doesNotMatch(
    client.conversationSql,
    /property_predator_sms_inbox_projections|property_predator_sms_jobs|property_predator_customer_email_jobs|property_predator_whatsapp_live_inbox_projections/,
  );
  assert.equal(Object.hasOwn(page.conversations[0]!, 'recipient'), false);
  client.invalid = true;
  await assert.rejects(service.listConversations(userContext), /latest message is invalid/);
  await assert.rejects(service.listConversations(userContext, { limit: 51 }), /limit/);
});

test('inbox read model admits LinkedIn only as a canonical read channel', async () => {
  const client = new ReadClient();
  client.channel = 'linkedin';
  const pool = { connect: async () => client } as unknown as Pick<Pool, 'connect'>;
  const page = await new PgInboxReadService(pool).listConversations(userContext, {
    channel: 'linkedin', limit: 1,
  });
  assert.equal(page.conversations[0]?.channel, 'linkedin');
  assert.match(client.conversationSql, /operational_inbox_live_conversation_visible/);
});
