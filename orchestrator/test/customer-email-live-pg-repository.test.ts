import assert from 'node:assert/strict';
import test from 'node:test';
import { PgCustomerEmailLiveRepository } from '../src/customer-email-live-pg/repository.js';

const IDS = Object.freeze({
  workspace: '11111111-1111-4111-8111-111111111111',
  connection: '22222222-2222-4222-8222-222222222222',
  job: '33333333-3333-4333-8333-333333333333',
  operation: '44444444-4444-4444-8444-444444444444',
  correlation: '55555555-5555-4555-8555-555555555555',
});
const sha = 'a'.repeat(64);

test('repository claim is constructor-bound to one workspace and Mailgun connection', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const repository = new PgCustomerEmailLiveRepository({ async query(sql: string, values: unknown[]) {
    calls.push({ sql, values }); return { rows: [{ jobId: IDS.job, leaseVersion: '1' }] };
  } } as never, { workspaceId: IDS.workspace, connectionId: IDS.connection });
  assert.deepEqual(await repository.claimOne({ leaseToken: Buffer.alloc(32, 1), leaseSeconds: 60 }),
    { workspaceId: IDS.workspace, connectionId: IDS.connection, jobId: IDS.job, leaseVersion: 1 });
  assert.deepEqual(calls[0]?.values.slice(0, 2), [IDS.workspace, IDS.connection]);
  assert.match(calls[0]?.sql ?? '', /claim_customer_email_live_job/u);
});

test('repository loads one exact recipient and no secret column', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const repository = new PgCustomerEmailLiveRepository({ async query(sql: string, values: unknown[]) {
    calls.push({ sql, values }); return { rows: [{ providerConnectionId: IDS.connection,
      operationId: IDS.operation, correlationId: IDS.correlation, requestSha256: sha,
      expectedMessageId: `<pp-${sha}@mg.propertypredator.com>`,
      recipient: 'customer@example.com', subject: 'Subject', body: 'Approved body' }] };
  } } as never, { workspaceId: IDS.workspace, connectionId: IDS.connection });
  const material = await repository.loadClaimed({ workspaceId: IDS.workspace,
    connectionId: IDS.connection, jobId: IDS.job, leaseVersion: 1,
    leaseToken: Buffer.alloc(32, 2) });
  assert.equal(material.recipient, 'customer@example.com');
  assert.doesNotMatch(calls[0]?.sql ?? '', /api_key|sending_key|secret/iu);
  assert.deepEqual(calls[0]?.values.slice(0, 2), [IDS.workspace, IDS.job]);
});

test('repository rejects a cross-workspace calling fence before SQL', async () => {
  let called = false;
  const repository = new PgCustomerEmailLiveRepository({ async query() {
    called = true; return { rows: [] };
  } } as never, { workspaceId: IDS.workspace, connectionId: IDS.connection });
  await assert.rejects(repository.markCalling({
    workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', connectionId: IDS.connection,
    jobId: IDS.job, leaseVersion: 1, leaseToken: Buffer.alloc(32, 3),
    providerEffectsEnabled: true, emailDeliveryEnabled: true, emergencyPaused: false,
  }));
  assert.equal(called, false);
});

test('settlement sends only bounded provider evidence to the database function', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const repository = new PgCustomerEmailLiveRepository({ async query(sql: string, values: unknown[]) {
    calls.push({ sql, values }); return { rows: [] };
  } } as never, { workspaceId: IDS.workspace, connectionId: IDS.connection });
  await repository.settle({ workspaceId: IDS.workspace, connectionId: IDS.connection,
    jobId: IDS.job, leaseVersion: 1, leaseToken: Buffer.alloc(32, 4),
    result: { status: 'needs_attention', externalId: null,
      occurredAt: '2026-08-29T10:00:00Z', retryable: false,
      errorCode: 'mailgun_customer_outcome_unknown', summary: 'Signed receipt required' },
    receiptSha256: 'b'.repeat(64) });
  assert.match(calls[0]?.sql ?? '', /settle_customer_email_live_call/u);
  assert.equal(calls[0]?.values[4], 'needs_attention');
  assert.equal(calls[0]?.values[5], null);
});
