import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { PgPropertyPredatorMailgunWorkerRepository } from '../src/property-predator-mailgun-worker-pg/index.js';

const IDS = Object.freeze({
  workspace: '11111111-1111-4111-8111-111111111111',
  job: '22222222-2222-4222-8222-222222222222',
  operation: '33333333-3333-4333-8333-333333333333',
  correlation: '44444444-4444-4444-8444-444444444444',
  connection: '55555555-5555-4555-8555-555555555555',
  reservation: '66666666-6666-4666-8666-666666666666',
});
const REQUEST_SHA = 'a'.repeat(64);
const TOKEN = Buffer.alloc(32, 7);

type Call = Readonly<{ sql: string; values: readonly unknown[] }>;

function database(respond: (sql: string) => unknown[]): Readonly<{
  pool: Pick<Pool, 'connect'>;
  calls: Call[];
}> {
  const calls: Call[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes("set_config('app.user_id'")) return { rows: [{}] };
    return { rows: respond(sql) };
  };
  const client = { query, release: () => undefined } as unknown as PoolClient;
  return Object.freeze({
    pool: { connect: async () => client } as Pick<Pool, 'connect'>,
    calls,
  });
}

test('repository claims exactly one opaque lease and begins only canonical office payload', async () => {
  const db = database((sql) => {
    if (sql.includes('claim_property_predator_mailgun_job')) {
      return [{ jobId: IDS.job, leaseVersion: '1' }];
    }
    if (sql.includes('begin_property_predator_mailgun_job_call')) {
      return [{
        disposition: 'authorized', reason: null,
        operationId: IDS.operation, correlationId: IDS.correlation,
        providerConnectionId: IDS.connection, reservationId: IDS.reservation,
        requestSha256: Buffer.from(REQUEST_SHA, 'hex'),
        expectedMessageId: `<pp-${REQUEST_SHA}@mg.propertypredator.com>`,
        recipient: 'office@propertypredator.com', subject: 'Owned seed', body: 'Safe body',
      }];
    }
    return [];
  });
  const repository = new PgPropertyPredatorMailgunWorkerRepository({
    commandPool: db.pool, workspaceId: IDS.workspace,
    providerConnectionId: IDS.connection,
  });
  const lease = await repository.claimOne(TOKEN, 60);
  assert.deepEqual(lease, { jobId: IDS.job, leaseVersion: 1 });
  const decision = await repository.beginCall(lease!, TOKEN, {
    runSpendCapUsdMicros: 1_000,
    monthSpendCapUsdMicros: 3_000,
  });
  assert.equal(decision.disposition, 'authorized');
  const begin = db.calls.find((call) => call.sql.includes('begin_property_predator_mailgun_job_call'))!;
  assert.deepEqual(begin.values.slice(0, 5), [
    IDS.workspace, IDS.connection, IDS.job, 1, TOKEN,
  ]);
  assert.deepEqual(begin.values.slice(5), [1_000, 3_000]);
  const claim = db.calls.find((call) => call.sql.includes('claim_property_predator_mailgun_job'))!;
  assert.deepEqual(claim.values.slice(0, 2), [IDS.workspace, IDS.connection]);
  assert.doesNotMatch(JSON.stringify(db.calls.find((call) => call.sql.includes('claim_property'))), /office@|Safe body/);
});

test('repository settlement is replay-safe and forces ambiguous results non-retryable', async () => {
  const db = database((sql) => sql.includes('settle_property_predator_mailgun_job')
    ? [{ settled: true }] : []);
  const repository = new PgPropertyPredatorMailgunWorkerRepository({
    commandPool: db.pool, workspaceId: IDS.workspace,
    providerConnectionId: IDS.connection,
  });
  const settled = await repository.settle(
    { jobId: IDS.job, leaseVersion: 2 },
    TOKEN,
    {
      status: 'needs_attention', externalId: null,
      occurredAt: '2026-08-28T12:00:00.000Z', retryable: false,
      errorCode: 'mailgun_outcome_unknown',
      summary: 'Signed webhook reconciliation required',
    },
  );
  assert.equal(settled, true);
  const call = db.calls.find((item) => item.sql.includes('settle_property_predator_mailgun_job'))!;
  assert.equal(call.values[4], 'needs_attention');
  assert.equal(call.values[7], false);
});

test('repository recovery returns at most one exact disposition', async () => {
  const db = database((sql) => sql.includes('recover_one_property_predator_mailgun_job')
    ? [{ jobId: IDS.job, disposition: 'signed_webhook_reconciled' }] : []);
  const repository = new PgPropertyPredatorMailgunWorkerRepository({
    commandPool: db.pool, workspaceId: IDS.workspace,
    providerConnectionId: IDS.connection,
  });
  assert.deepEqual(await repository.recoverOne(), {
    jobId: IDS.job, disposition: 'signed_webhook_reconciled',
  });
  const recover = db.calls.find((call) => call.sql.includes('recover_one_property_predator_mailgun_job'))!;
  assert.deepEqual(recover.values, [IDS.workspace, IDS.connection]);
});

test('repository rejects noncanonical payload and lease capabilities', async () => {
  const db = database((sql) => sql.includes('begin_property_predator_mailgun_job_call')
    ? [{
      disposition: 'authorized', reason: null,
      operationId: IDS.operation, correlationId: IDS.correlation,
      providerConnectionId: IDS.connection, reservationId: IDS.reservation,
      requestSha256: Buffer.from(REQUEST_SHA, 'hex'),
      expectedMessageId: `<pp-${REQUEST_SHA}@mg.propertypredator.com>`,
      recipient: 'customer@example.com', subject: 'Owned seed', body: 'Safe body',
    }] : []);
  const repository = new PgPropertyPredatorMailgunWorkerRepository({
    commandPool: db.pool, workspaceId: IDS.workspace,
    providerConnectionId: IDS.connection,
  });
  await assert.rejects(
    repository.beginCall({ jobId: IDS.job, leaseVersion: 1 }, TOKEN, {
      runSpendCapUsdMicros: 1_000, monthSpendCapUsdMicros: 3_000,
    }),
    /payload is not canonical/,
  );
  await assert.rejects(repository.claimOne(Buffer.alloc(31), 60), /exactly 32 bytes/);
});
