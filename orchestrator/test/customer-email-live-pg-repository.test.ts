import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { PgCustomerEmailLiveRepository } from '../src/customer-email-live-pg/repository.js';

const IDS = Object.freeze({
  workspace: '11111111-1111-4111-8111-111111111111',
  connection: '22222222-2222-4222-8222-222222222222',
  job: '33333333-3333-4333-8333-333333333333',
  operation: '44444444-4444-4444-8444-444444444444',
  correlation: '55555555-5555-4555-8555-555555555555',
});
const sha = 'a'.repeat(64);

type Call = Readonly<{ sql: string; values: readonly unknown[] }>;

function pool(
  domain: (sql: string, values: readonly unknown[]) => Promise<{ rows: unknown[] }>,
): { commandPool: { connect(): Promise<PoolClient> }; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (/^(?:BEGIN|COMMIT|ROLLBACK)/u.test(sql)
          || sql.includes("set_config('app.user_id'")) return { rows: [] };
      return domain(sql, values);
    },
    release() {},
  } as unknown as PoolClient;
  return { commandPool: { connect: async () => client }, calls };
}

function domainCall(calls: readonly Call[]): Call {
  const call = calls.find((candidate) => candidate.sql.includes('app_private.'));
  assert.ok(call);
  return call;
}

test('repository claim installs worker context and is bound to one workspace/connection', async () => {
  const mocked = pool(async () => ({ rows: [{ jobId: IDS.job, leaseVersion: '1' }] }));
  const repository = new PgCustomerEmailLiveRepository(mocked.commandPool as never,
    { workspaceId: IDS.workspace, connectionId: IDS.connection });
  assert.deepEqual(await repository.claimOne({ leaseToken: Buffer.alloc(32, 1), leaseSeconds: 60 }),
    { workspaceId: IDS.workspace, connectionId: IDS.connection, jobId: IDS.job, leaseVersion: 1 });
  const context = mocked.calls.find((call) => call.sql.includes("set_config('app.user_id'"));
  assert.deepEqual(context?.values.slice(0, 3), ['', IDS.workspace, 'worker']);
  const call = domainCall(mocked.calls);
  assert.deepEqual(call.values.slice(0, 2), [IDS.workspace, IDS.connection]);
  assert.match(call.sql, /claim_customer_email_live_job/u);
  assert.match(mocked.calls[0]?.sql ?? '', /BEGIN ISOLATION LEVEL SERIALIZABLE/u);
  assert.equal(mocked.calls.at(-1)?.sql, 'COMMIT');
});

test('repository loads one exact recipient in a worker read transaction and no secret column', async () => {
  const mocked = pool(async () => ({ rows: [{ providerConnectionId: IDS.connection,
    sendingDomain: 'mg.propertypredator.com',
    operationId: IDS.operation, correlationId: IDS.correlation, requestSha256: sha,
    expectedMessageId: `<pp-${sha}@mg.propertypredator.com>`,
    recipient: 'customer@example.com', subject: 'Subject', body: 'Approved body' }] }));
  const repository = new PgCustomerEmailLiveRepository(mocked.commandPool as never,
    { workspaceId: IDS.workspace, connectionId: IDS.connection });
  const material = await repository.loadClaimed({ workspaceId: IDS.workspace,
    connectionId: IDS.connection, jobId: IDS.job, leaseVersion: 1,
    leaseToken: Buffer.alloc(32, 2) });
  assert.equal(material.recipient, 'customer@example.com');
  assert.equal(material.sendingDomain, 'mg.propertypredator.com');
  const call = domainCall(mocked.calls);
  assert.match(call.sql, /sending_domain AS "sendingDomain"/u);
  assert.doesNotMatch(call.sql, /api_key|sending_key|secret/iu);
  assert.deepEqual(call.values.slice(0, 2), [IDS.workspace, IDS.job]);
  assert.match(mocked.calls[0]?.sql ?? '', /REPEATABLE READ READ ONLY/u);
});

test('repository rejects any SQL sender-domain material outside the exact Mailgun binding', async () => {
  const mocked = pool(async () => ({ rows: [{ providerConnectionId: IDS.connection,
    sendingDomain: 'mail.example.com',
    operationId: IDS.operation, correlationId: IDS.correlation, requestSha256: sha,
    expectedMessageId: `<pp-${sha}@mg.propertypredator.com>`,
    recipient: 'customer@example.com', subject: 'Subject', body: 'Approved body' }] }));
  const repository = new PgCustomerEmailLiveRepository(mocked.commandPool as never,
    { workspaceId: IDS.workspace, connectionId: IDS.connection });
  await assert.rejects(repository.loadClaimed({ workspaceId: IDS.workspace,
    connectionId: IDS.connection, jobId: IDS.job, leaseVersion: 1,
    leaseToken: Buffer.alloc(32, 2) }), /sending domain binding/u);
  assert.equal(mocked.calls.at(-1)?.sql, 'ROLLBACK');
});

test('repository rejects a cross-workspace calling fence before acquiring SQL', async () => {
  let connected = false;
  const repository = new PgCustomerEmailLiveRepository({ async connect() {
    connected = true; throw new Error('must not connect');
  } } as never, { workspaceId: IDS.workspace, connectionId: IDS.connection });
  await assert.rejects(repository.markCalling({
    workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', connectionId: IDS.connection,
    jobId: IDS.job, leaseVersion: 1, leaseToken: Buffer.alloc(32, 3),
    providerEffectsEnabled: true, emailDeliveryEnabled: true, emergencyPaused: false,
  }));
  assert.equal(connected, false);
});

test('settlement sends only bounded provider evidence in a serializable worker transaction', async () => {
  const mocked = pool(async () => ({ rows: [] }));
  const repository = new PgCustomerEmailLiveRepository(mocked.commandPool as never,
    { workspaceId: IDS.workspace, connectionId: IDS.connection });
  await repository.settle({ workspaceId: IDS.workspace, connectionId: IDS.connection,
    jobId: IDS.job, leaseVersion: 1, leaseToken: Buffer.alloc(32, 4),
    result: { status: 'needs_attention', externalId: null,
      occurredAt: '2026-08-29T10:00:00Z', retryable: false,
      errorCode: 'mailgun_customer_outcome_unknown', summary: 'Signed receipt required' },
    receiptSha256: 'b'.repeat(64) });
  const call = domainCall(mocked.calls);
  assert.match(call.sql, /settle_customer_email_live_call/u);
  assert.equal(call.values[4], 'needs_attention');
  assert.equal(call.values[5], null);
  assert.match(mocked.calls[0]?.sql ?? '', /SERIALIZABLE READ WRITE/u);
});
