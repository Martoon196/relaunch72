import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { PgCustomerEmailSignedReceiptProjector } from '../src/customer-email-live-pg/receipt-repository.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';

type Call = Readonly<{ sql: string; values: readonly unknown[] }>;

function pool(disposition: unknown) {
  const calls: Call[] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (/^(?:BEGIN|COMMIT|ROLLBACK)/u.test(sql)
          || sql.includes("set_config('app.user_id'")) return { rows: [] };
      return { rows: [{ disposition }] };
    },
    release() {},
  } as unknown as PoolClient;
  return {
    calls,
    commandPool: { connect: async () => client },
  };
}

test('signed receipt projector accepts every bounded database disposition', async () => {
  for (const disposition of ['applied', 'replayed', 'not_applicable'] as const) {
    const mocked = pool(disposition);
    const projector = new PgCustomerEmailSignedReceiptProjector({
      commandPool: mocked.commandPool as never,
      workspaceId: WORKSPACE,
      providerConnectionId: CONNECTION,
    });
    assert.equal(await projector.recordSignedReceipt('evt_customer_1'), disposition);
    const context = mocked.calls.find((call) => call.sql.includes("set_config('app.user_id'"));
    assert.deepEqual(context?.values.slice(0, 3), ['', WORKSPACE, 'webhook']);
    assert.match(String(context?.values[3]), /^customer-email-receipt:[0-9a-f]{48}$/u);
    const call = mocked.calls.find((candidate) =>
      candidate.sql.includes('record_customer_email_signed_receipt'));
    assert.deepEqual(call?.values, [WORKSPACE, CONNECTION, 'evt_customer_1']);
    assert.match(mocked.calls[0]?.sql ?? '', /SERIALIZABLE READ WRITE/u);
    assert.equal(mocked.calls.at(-1)?.sql, 'COMMIT');
  }
});

test('invalid event ids fail before acquiring a database connection', async () => {
  let connected = false;
  const projector = new PgCustomerEmailSignedReceiptProjector({
    commandPool: { async connect() { connected = true; throw new Error('must not connect'); } } as never,
    workspaceId: WORKSPACE,
    providerConnectionId: CONNECTION,
  });
  await assert.rejects(() => projector.recordSignedReceipt('contains spaces'));
  assert.equal(connected, false);
});

test('an unknown database disposition rolls back and is never exposed as success', async () => {
  const mocked = pool('ignored');
  const projector = new PgCustomerEmailSignedReceiptProjector({
    commandPool: mocked.commandPool as never,
    workspaceId: WORKSPACE,
    providerConnectionId: CONNECTION,
  });
  await assert.rejects(() => projector.recordSignedReceipt('evt_customer_2'),
    /invalid disposition/u);
  assert.equal(mocked.calls.at(-1)?.sql, 'ROLLBACK');
});
