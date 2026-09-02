import assert from 'node:assert/strict';
import test from 'node:test';
import { PgZernioMessagingReplyStore } from '../src/portal/zernio-messaging-pg-store.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const DRAFT = '44444444-4444-4444-8444-444444444444';
const DELIVERY = '55555555-5555-4555-8555-555555555555';
const LEASE = '66666666-6666-4666-8666-666666666666';
const identity = Object.freeze({ sessionToken: 'session-token', requestId: 'request-1' });

function store(operation: (sql: string, values: readonly unknown[]) => { rows: unknown[] }) {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const client = {
    async query(sql: string, values: readonly unknown[] = []) {
      if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK'
          || sql.includes("set_config('app.user_id'")) return { rows: [] };
      if (sql.includes('database.lock-portal-session')) return { rows: [{ active: true }] };
      calls.push({ sql, values });
      return operation(sql, values);
    },
    release() {},
  };
  return {
    calls,
    value: new PgZernioMessagingReplyStore({
      principalResolver: { async resolve() { return { workspaceId: WORKSPACE, userId: USER }; } },
      commandPool: { async connect() { return client; } } as never,
      workspaceId: WORKSPACE, providerConnectionId: CONNECTION,
      providerProfileId: 'property-predator-profile',
    }),
  };
}

test('PG reply draft command sends the exact LinkedIn network to the 0086 overload', async () => {
  const fixture = store(() => ({ rows: [{ disposition: 'created' }] }));
  const result = await fixture.value.create(identity, {
    draftId: DRAFT, network: 'linkedin', accountId: 'linkedin-account-1',
    providerConversationId: 'zernio-comment-v1:exact-target', body: 'Exact reply',
  });
  assert.deepEqual(result, { ok: true, value: 'created' });
  assert.equal(fixture.calls.length, 1);
  assert.match(fixture.calls[0]?.sql ?? '', /create_zernio_reply_draft\([\s\S]*\$4::text,[\s\S]*\$9::bytea/u);
  assert.equal(fixture.calls[0]?.values[3], 'linkedin');
  assert.equal(fixture.calls[0]?.values.length, 9);
});

test('PG reply claim sends the same exact network to the 0086 one-shot claim overload', async () => {
  const fixture = store(() => ({ rows: [{
    disposition: 'claimed', body_text: 'Approved reply', body_sha256: Buffer.alloc(32, 7),
  }] }));
  const result = await fixture.value.claim(identity, {
    draftId: DRAFT, deliveryId: DELIVERY, leaseToken: LEASE, network: 'linkedin',
    accountId: 'linkedin-account-1', providerConversationId: 'zernio-comment-v1:exact-target',
    idempotencyKey: `reply:${DELIVERY}`,
  });
  assert.equal(result.ok, true);
  assert.equal(fixture.calls.length, 1);
  assert.match(fixture.calls[0]?.sql ?? '', /claim_zernio_reply_send\([\s\S]*\$5::text,[\s\S]*\$10::bytea/u);
  assert.equal(fixture.calls[0]?.values[4], 'linkedin');
  assert.equal(fixture.calls[0]?.values.length, 10);
});

test('PG reply commands reject an unrecognised network before opening a transaction', async () => {
  const fixture = store(() => { throw new Error('must not query'); });
  const result = await fixture.value.create(identity, {
    draftId: DRAFT, network: 'facebook' as never, accountId: 'facebook-account-1',
    providerConversationId: 'conversation-1', body: 'Blocked reply',
  });
  assert.deepEqual(result, { ok: false, kind: 'validation' });
  assert.equal(fixture.calls.length, 0);
});
