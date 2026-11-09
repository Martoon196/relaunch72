import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { PgTwilioSmsLiveCommandService } from '../src/sms-live-pg/command-service.js';
import type { AuthorizeTwilioSmsLiveCommand } from '../src/sms-live-pg/types.js';

const id = (value: number): string =>
  `${value.toString(16).padStart(8, '0')}-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const WORKSPACE = id(1); const CONNECTION = id(2); const USER = id(3); const JOB = id(4);

function command(): AuthorizeTwilioSmsLiveCommand {
  return Object.freeze({ messageVersionId: id(5), messageApprovalRequestId: id(6),
    messageApprovalDecisionId: id(7), channelEndpointId: id(8), consentEventId: id(9),
    complianceSubjectId: id(10), policyPublicationEventId: id(11),
    pecrSenderDecisionEventId: id(12), pecrInstigatorDecisionEventId: id(13),
    permissionUseReceiptId: id(14), authorityValidUntil: '2026-08-29T10:10:00.000Z',
    providerOperationId: id(15), messageDeliveryId: id(16), correlationId: id(17),
    idempotencyKeySha256: 'a'.repeat(64), requestSha256: 'b'.repeat(64),
    expectedSegmentCount: 2 });
}

type Call = Readonly<{ sql: string; values: readonly unknown[] }>;
function pool(disposition: 'queued' | 'replayed') {
  const calls: Call[] = [];
  const client = { async query(sql: string, values: unknown[] = []) {
    calls.push({ sql, values });
    if (/^(?:BEGIN|COMMIT|ROLLBACK)/u.test(sql)
        || sql.includes("set_config('app.user_id'")) return { rows: [] };
    if (sql.includes('lock_active_portal_session')) return { rows: [{ active: true }] };
    return { rows: [{ jobId: JOB, disposition }] };
  }, release() {} } as unknown as PoolClient;
  return { calls, commandPool: { connect: async () => client } };
}

test('SMS command consumes identifiers only and reports no provider effect', async () => {
  const mocked = pool('queued');
  const service = new PgTwilioSmsLiveCommandService({ commandPool: mocked.commandPool as never,
    workspaceId: WORKSPACE, providerConnectionId: CONNECTION });
  const result = await service.authorizeAndEnqueue({ actorKind: 'user', workspaceId: WORKSPACE,
    userId: USER, requestId: 'sms-command-1', portalSessionTokenHash: Buffer.alloc(32, 1) },
  command());
  assert.deepEqual(result, { jobId: JOB, disposition: 'queued', providerEffects: 'none',
    caps: { dailySegments: 10, monthlySegments: 50, recipientsPerJob: 1 } });
  const call = mocked.calls.find((candidate) =>
    candidate.sql.includes('authorize_and_enqueue_sms_live_job'));
  assert.ok(call); assert.equal(call.values.length, 19);
  assert.deepEqual(call.values.slice(0, 3), [WORKSPACE, CONNECTION, id(5)]);
  assert.deepEqual(call.values.slice(16, 18), [Buffer.from('a'.repeat(64), 'hex'),
    Buffer.from('b'.repeat(64), 'hex')]);
  assert.equal(call.values[18], 2);
  assert.doesNotMatch(call.sql, /phone|recipient|body_text/iu);
  assert.match(mocked.calls[0]?.sql ?? '', /SERIALIZABLE READ WRITE/u);
  assert.equal(mocked.calls.at(-1)?.sql, 'COMMIT');
});

test('SMS command exposes exact replay and rejects cross-workspace or cap drift pre-SQL', async () => {
  const mocked = pool('replayed');
  const service = new PgTwilioSmsLiveCommandService({ commandPool: mocked.commandPool as never,
    workspaceId: WORKSPACE, providerConnectionId: CONNECTION });
  assert.equal((await service.authorizeAndEnqueue({ actorKind: 'user', workspaceId: WORKSPACE,
    userId: USER, requestId: 'sms-replay', portalSessionTokenHash: Buffer.alloc(32, 2) },
  command())).disposition, 'replayed');
  let connected = false;
  const guarded = new PgTwilioSmsLiveCommandService({ commandPool: { async connect() {
    connected = true; throw new Error('must not connect');
  } } as never, workspaceId: WORKSPACE, providerConnectionId: CONNECTION });
  await assert.rejects(guarded.authorizeAndEnqueue({ actorKind: 'user', workspaceId: id(99),
    userId: USER, requestId: 'wrong-workspace', portalSessionTokenHash: Buffer.alloc(32, 3) },
  command()));
  await assert.rejects(guarded.authorizeAndEnqueue({ actorKind: 'user', workspaceId: WORKSPACE,
    userId: USER, requestId: 'cap-drift', portalSessionTokenHash: Buffer.alloc(32, 3) },
  { ...command(), expectedSegmentCount: 11 }));
  assert.equal(connected, false);
});
