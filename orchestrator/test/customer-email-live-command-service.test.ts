import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { PgCustomerEmailLiveCommandService } from '../src/customer-email-live-pg/command-service.js';
import type { AuthorizeCustomerEmailLiveCommand } from '../src/customer-email-live-pg/types.js';

const id = (value: number): string =>
  `${value.toString(16).padStart(8, '0')}-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const WORKSPACE = id(1);
const CONNECTION = id(2);
const USER = id(3);
const JOB = id(4);

function command(): AuthorizeCustomerEmailLiveCommand {
  return Object.freeze({
    campaignTemplateVersionId: id(5),
    campaignTemplateStepId: id(6),
    campaignStepContentSha256: 'a'.repeat(64),
    campaignApprovalRequestId: id(7),
    campaignApprovalDecisionId: id(8),
    messageVersionId: id(9),
    messageApprovalRequestId: id(10),
    messageApprovalDecisionId: id(11),
    channelEndpointId: id(12),
    messageDeliveryId: id(13),
    consentEventId: id(14),
    complianceSubjectId: id(15),
    policyPublicationEventId: id(16),
    pecrSenderDecisionEventId: id(17),
    pecrInstigatorDecisionEventId: id(18),
    permissionUseReceiptId: id(19),
    authorityValidUntil: '2026-08-29T10:10:00.000Z',
    providerOperationId: id(20),
    correlationId: id(21),
    idempotencyKeySha256: 'b'.repeat(64),
    requestSha256: 'c'.repeat(64),
  });
}

type Call = Readonly<{ sql: string; values: readonly unknown[] }>;

function pool(disposition: 'queued' | 'replayed') {
  const calls: Call[] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (/^(?:BEGIN|COMMIT|ROLLBACK)/u.test(sql)
          || sql.includes("set_config('app.user_id'")) return { rows: [] };
      if (sql.includes('lock_active_portal_session')) return { rows: [{ active: true }] };
      return { rows: [{ jobId: JOB, disposition }] };
    },
    release() {},
  } as unknown as PoolClient;
  return { calls, commandPool: { connect: async () => client } };
}

test('command atomically consumes exact evidence and reports no provider effect', async () => {
  const mocked = pool('queued');
  const service = new PgCustomerEmailLiveCommandService({
    commandPool: mocked.commandPool as never,
    workspaceId: WORKSPACE,
    providerConnectionId: CONNECTION,
  });
  const result = await service.authorizeAndEnqueue({
    actorKind: 'user', workspaceId: WORKSPACE, userId: USER,
    requestId: 'customer-email-command-1', portalSessionTokenHash: Buffer.alloc(32, 1),
  }, command());
  assert.deepEqual(result, {
    jobId: JOB,
    disposition: 'queued',
    providerEffects: 'none',
    caps: { daily: 10, monthly: 50, recipientsPerJob: 1 },
  });
  assert.match(mocked.calls[0]?.sql ?? '', /SERIALIZABLE READ WRITE/u);
  assert.ok(mocked.calls.some((call) => call.sql.includes('lock_active_portal_session')));
  const context = mocked.calls.find((call) => call.sql.includes("set_config('app.user_id'"));
  assert.deepEqual(context?.values.slice(0, 3), [USER, WORKSPACE, 'user']);
  const enqueue = mocked.calls.find((call) =>
    call.sql.includes('authorize_and_enqueue_customer_email_live_job'));
  assert.ok(enqueue);
  assert.equal(enqueue.values.length, 23);
  assert.deepEqual(enqueue.values.slice(0, 5), [
    WORKSPACE, CONNECTION, id(5), id(6), Buffer.from('a'.repeat(64), 'hex'),
  ]);
  assert.equal(enqueue.values[18], id(20));
  assert.equal(enqueue.values[19], id(13));
  assert.equal(enqueue.values[20], id(21));
  assert.deepEqual(enqueue.values[21], Buffer.from('b'.repeat(64), 'hex'));
  assert.deepEqual(enqueue.values[22], Buffer.from('c'.repeat(64), 'hex'));
  assert.equal(mocked.calls.at(-1)?.sql, 'COMMIT');
});

test('command exposes an exact replay without claiming a second provider effect', async () => {
  const mocked = pool('replayed');
  const service = new PgCustomerEmailLiveCommandService({
    commandPool: mocked.commandPool as never,
    workspaceId: WORKSPACE,
    providerConnectionId: CONNECTION,
  });
  const result = await service.authorizeAndEnqueue({
    actorKind: 'user', workspaceId: WORKSPACE, userId: USER,
    requestId: 'customer-email-command-replay',
    portalSessionTokenHash: Buffer.alloc(32, 2),
  }, command());
  assert.equal(result.disposition, 'replayed');
  assert.equal(result.providerEffects, 'none');
});

test('cross-workspace or malformed evidence fails before database acquisition', async () => {
  let connected = false;
  const service = new PgCustomerEmailLiveCommandService({
    commandPool: { async connect() { connected = true; throw new Error('must not connect'); } } as never,
    workspaceId: WORKSPACE,
    providerConnectionId: CONNECTION,
  });
  await assert.rejects(() => service.authorizeAndEnqueue({
    actorKind: 'user', workspaceId: id(99), userId: USER, requestId: 'wrong-workspace',
    portalSessionTokenHash: Buffer.alloc(32, 3),
  }, command()));
  await assert.rejects(() => service.authorizeAndEnqueue({
    actorKind: 'user', workspaceId: WORKSPACE, userId: USER, requestId: 'bad-hash',
    portalSessionTokenHash: Buffer.alloc(32, 4),
  }, { ...command(), requestSha256: 'not-a-digest' }));
  await assert.rejects(() => service.authorizeAndEnqueue({
    actorKind: 'user', workspaceId: WORKSPACE, userId: USER,
    requestId: 'missing-session', portalSessionTokenHash: undefined,
  } as never, command()), /active portal session/u);
  assert.equal(connected, false);
});
