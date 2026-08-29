import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { PgTwilioSmsLiveRepository } from '../src/sms-live-pg/repository.js';
import { PgTwilioSmsWebhookRepository } from '../src/sms-live-pg/webhook-repository.js';
import { assertSmsCommandBoundaryReady, assertSmsWebhookBoundaryReady,
  assertSmsWorkerBoundaryReady } from '../src/sms-live-pg/readiness.js';

const IDS = Object.freeze({ workspace: '11111111-1111-4111-8111-111111111111',
  connection: '22222222-2222-4222-8222-222222222222',
  job: '33333333-3333-4333-8333-333333333333',
  operation: '44444444-4444-4444-8444-444444444444',
  correlation: '55555555-5555-4555-8555-555555555555' });
const SHA = 'a'.repeat(64); const TOKEN = Buffer.alloc(32, 7);
type Call = Readonly<{ sql: string; values: readonly unknown[] }>;

function pool(domain: (sql: string, values: readonly unknown[]) => { rows: unknown[] }) {
  const calls: Call[] = [];
  const client = { async query(sql: string, values: unknown[] = []) {
    calls.push({ sql, values });
    if (/^(?:BEGIN|COMMIT|ROLLBACK)/u.test(sql)
        || sql.includes("set_config('app.user_id'")) return { rows: [] };
    return domain(sql, values);
  }, release() {} } as unknown as PoolClient;
  return { calls, commandPool: { connect: async () => client } };
}

test('worker repository claims and loads one exact UK recipient under worker context', async () => {
  const mocked = pool((sql) => sql.includes('claim_sms_live_job')
    ? { rows: [{ jobId: IDS.job, leaseVersion: '1' }] }
    : { rows: [{ providerConnectionId: IDS.connection, senderNumber: '+447700900999',
      operationId: IDS.operation, correlationId: IDS.correlation, requestSha256: SHA,
      recipient: '+447700900123', body: 'Exact approved SMS.', segmentCount: '1' }] });
  const repository = new PgTwilioSmsLiveRepository(mocked.commandPool as never,
    { workspaceId: IDS.workspace, connectionId: IDS.connection });
  const claim = await repository.claimOne({ leaseToken: TOKEN, leaseSeconds: 60 });
  assert.deepEqual(claim, { workspaceId: IDS.workspace, connectionId: IDS.connection,
    jobId: IDS.job, leaseVersion: 1 });
  const material = await repository.loadClaimed({ ...claim!, leaseToken: TOKEN });
  assert.equal(material.recipient, '+447700900123'); assert.equal(material.segmentCount, 1);
  assert.ok(mocked.calls.some((call) => call.sql.includes('actor_kind')));
  const load = mocked.calls.find((call) => call.sql.includes('load_sms_live_job'))!;
  assert.doesNotMatch(load.sql, /api_key|auth_token|secret/iu);
  assert.deepEqual(load.values.slice(0, 2), [IDS.workspace, IDS.job]);
});

test('worker repository fails closed on material drift and cross-workspace fences', async () => {
  const mocked = pool(() => ({ rows: [{ providerConnectionId: IDS.connection,
    senderNumber: '+447700900999', operationId: IDS.operation, correlationId: IDS.correlation,
    requestSha256: SHA, recipient: '+447700900123', body: 'A'.repeat(161), segmentCount: '1' }] }));
  const repository = new PgTwilioSmsLiveRepository(mocked.commandPool as never,
    { workspaceId: IDS.workspace, connectionId: IDS.connection });
  await assert.rejects(repository.loadClaimed({ workspaceId: IDS.workspace,
    connectionId: IDS.connection, jobId: IDS.job, leaseVersion: 1, leaseToken: TOKEN }),
  /trusted boundary/u);
  assert.equal(mocked.calls.at(-1)?.sql, 'COMMIT');
  await assert.rejects(repository.markCalling({ workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    connectionId: IDS.connection, jobId: IDS.job, leaseVersion: 1, leaseToken: TOKEN,
    providerEffectsEnabled: true, smsDeliveryEnabled: true, emergencyPaused: false }));
});

test('worker repository fences calling and sends only bounded settlement evidence', async () => {
  const mocked = pool((sql) => sql.includes('begin_sms_live_call')
    ? { rows: [{ marked: true }] } : { rows: [] });
  const repository = new PgTwilioSmsLiveRepository(mocked.commandPool as never,
    { workspaceId: IDS.workspace, connectionId: IDS.connection });
  const claim = { workspaceId: IDS.workspace, connectionId: IDS.connection,
    jobId: IDS.job, leaseVersion: 1, leaseToken: TOKEN } as const;
  assert.equal(await repository.markCalling({ ...claim, providerEffectsEnabled: true,
    smsDeliveryEnabled: true, emergencyPaused: false }), true);
  await repository.settle({ ...claim, result: { status: 'needs_attention', externalId: null,
    occurredAt: '2026-08-29T10:00:00.000Z', retryable: false,
    errorCode: 'twilio_sms_outcome_unknown', summary: 'Signed receipt required' },
  receiptSha256: 'b'.repeat(64) });
  const settle = mocked.calls.find((call) => call.sql.includes('settle_sms_live_call'))!;
  assert.equal(settle.values[4], 'needs_attention'); assert.equal(settle.values[5], null);
  assert.equal(settle.values.length, 11);
});

test('webhook repository re-derives inbound identity and keeps raw provider secrets out of SQL', async () => {
  const body = 'STOP'; const sender = '447700900123';
  const mocked = pool(() => ({ rows: [{ outcome: 'applied' }] }));
  const repository = new PgTwilioSmsWebhookRepository({ commandPool: mocked.commandPool as never,
    workspaceId: IDS.workspace, providerConnectionId: IDS.connection });
  const result = await repository.recordInbound({ event: { kind: 'inbound',
    externalEventId: `inbound:SM${'2'.repeat(32)}`, providerMessageId: `SM${'2'.repeat(32)}`,
    normalizedSender: sender, senderSha256: createHash('sha256').update(sender).digest('hex'),
    body, bodySha256: createHash('sha256').update(body).digest('hex'), optEvidence: 'stop' },
  payloadSha256: 'c'.repeat(64), signatureSha256: 'd'.repeat(64),
  occurredAt: '2026-08-29T10:00:00.000Z', projection: 'conversion_inbox_and_lead360' });
  assert.equal(result, 'applied');
  const call = mocked.calls.find((candidate) =>
    candidate.sql.includes('record_sms_live_inbound_projection'))!;
  assert.equal(call.values[5], 'stop'); assert.equal(Buffer.isBuffer(call.values[11]), true);
  assert.doesNotMatch(call.sql, /auth_token|api_key|secret/iu);
  await assert.rejects(repository.recordInbound({ event: { kind: 'inbound',
    externalEventId: 'drift', providerMessageId: `SM${'2'.repeat(32)}`, normalizedSender: sender,
    senderSha256: 'e'.repeat(64), body, bodySha256: createHash('sha256').update(body).digest('hex'),
    optEvidence: null }, payloadSha256: 'c'.repeat(64), signatureSha256: 'd'.repeat(64),
  occurredAt: '2026-08-29T10:00:00.000Z', projection: 'conversion_inbox_and_lead360' }),
  /evidence is invalid/u);
});

test('all SMS runtime probes demand exact functions, table blindness and no elevated role', async () => {
  for (const [probe, role] of [[assertSmsCommandBoundaryReady, 'r72_sms_command'],
    [assertSmsWorkerBoundaryReady, 'r72_sms_worker_command'],
    [assertSmsWebhookBoundaryReady, 'r72_sms_webhook_command']] as const) {
    let sql = '';
    const exact = { exactRole: true, schemaUsage: true, runtimeLedger: true,
      installationIdentity: true, requiredFunctions: true, forbiddenFunctions: true,
      tableBlind: true, elevatedRolesDenied: true };
    await probe({ async query(statement: string) { sql = statement;
      return { rows: [exact] } as never; } } as never);
    assert.match(sql, new RegExp(role, 'u')); assert.match(sql, /has_function_privilege/u);
    assert.match(sql, /has_table_privilege/u); assert.match(sql, /pg_has_role/u);
    await assert.rejects(probe({ async query() {
      return { rows: [{ ...exact, tableBlind: false }] } as never;
    } } as never), /database boundary is not exact/u);
  }
});
