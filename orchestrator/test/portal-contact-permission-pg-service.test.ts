import assert from 'node:assert/strict';
import test from 'node:test';
import { PgPortalContactPermissionService } from '../src/portal/contact-permission-pg-service.js';
import { deriveContactPermissionCommandKey } from '../src/contact-permission/foundation.js';
import type { PortalContactPermissionInput } from '../src/portal/contact-permission-service.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE = '99999999-9999-4999-8999-999999999999';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const POINT = '33333333-3333-4333-8333-333333333333';
const COMMAND_KEY = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const CONSENT_EVENT = '66666666-6666-4666-8666-666666666666';
const RECEIPT = '77777777-7777-4777-8777-777777777777';

interface Call { readonly sql: string; readonly values: readonly unknown[] }

class FakeClient {
  readonly calls: Call[] = [];
  error: unknown = null;
  disposition = 'applied';

  async query(sql: string, values: readonly unknown[] = []): Promise<{ rows: unknown[] }> {
    this.calls.push({ sql, values });
    if (sql.includes('record_contact_permission_decision')) {
      if (this.error) throw this.error;
      return {
        rows: [{
          disposition: this.disposition,
          consent_event_id: CONSENT_EVENT,
          receipt_id: RECEIPT,
        }],
      };
    }
    return { rows: [{ active: true }] };
  }

  release(): void { /* pooled client */ }
}

function service(client: FakeClient, workspaceId = WORKSPACE): {
  service: PgPortalContactPermissionService;
} {
  return {
    service: new PgPortalContactPermissionService({
      principalResolver: {
        async resolve() {
          return { userId: USER, workspaceId } as never;
        },
      },
      commandPool: { async connect() { return client as never; } },
    }),
  };
}

function input(overrides: Partial<PortalContactPermissionInput> = {}): PortalContactPermissionInput {
  return {
    commandKey: COMMAND_KEY,
    contactId: CONTACT,
    contactPointId: POINT,
    channel: 'email',
    purpose: 'property_predator_marketing',
    decision: 'granted',
    lawfulBasis: 'consent',
    evidenceSource: 'founder.written_confirmation',
    policyVersion: 'pp-privacy-2026-08',
    policyTextSha256: 'a'.repeat(64),
    sourceEventId: 'signed-form-4821',
    occurredAt: '2026-08-30T09:00:00.000Z',
    operatorConfirmed: true,
    ...overrides,
  };
}

const IDENTITY = { sessionToken: 'session-token', requestId: 'req-1' } as never;

test('a witnessed decision is handed to the 0063 boundary as an exact tuple', async () => {
  const client = new FakeClient();
  const outcome = await service(client).service.recordDecision(IDENTITY, input());
  assert.deepEqual(outcome, {
    ok: true,
    disposition: 'applied',
    consentEventId: CONSENT_EVENT,
    receiptId: RECEIPT,
    messagesQueued: 'none',
  });
  const call = client.calls.find((entry) => entry.sql.includes('record_contact_permission_decision'));
  assert.ok(call, 'the decision must reach the boundary');
  assert.match(call.sql, /portal\.contact-permission\.record-decision/);
  // The workspace comes from the resolved session, never from the request.
  assert.equal(call.values[0], WORKSPACE);
  assert.equal(call.values[1], CONTACT);
  assert.equal(call.values[2], POINT);
  assert.equal(call.values[5], 'granted');
  // The command key crosses as its workspace-scoped digest only.
  assert.deepEqual(
    call.values[11],
    Buffer.from(deriveContactPermissionCommandKey(WORKSPACE, COMMAND_KEY), 'hex'),
  );
  assert.equal(String(call.values[11]).includes(COMMAND_KEY), false);
});

test('a session in another workspace cannot aim a decision at this contact', async () => {
  // The workspace is taken from the principal, so a decision recorded under a
  // different session simply lands in that session's own workspace and can
  // never be pointed at this one.
  const client = new FakeClient();
  await service(client, OTHER_WORKSPACE).service.recordDecision(IDENTITY, input());
  const call = client.calls.find((entry) => entry.sql.includes('record_contact_permission_decision'));
  assert.equal(call?.values[0], OTHER_WORKSPACE);
  assert.deepEqual(
    call?.values[11],
    Buffer.from(deriveContactPermissionCommandKey(OTHER_WORKSPACE, COMMAND_KEY), 'hex'),
  );
});

test('an unresolved session records nothing at all', async () => {
  const client = new FakeClient();
  const unresolved = new PgPortalContactPermissionService({
    principalResolver: { async resolve() { return null; } },
    commandPool: { async connect() { return client as never; } },
  });
  assert.deepEqual(
    await unresolved.recordDecision(IDENTITY, input()),
    { ok: false, kind: 'unauthenticated' },
  );
  assert.deepEqual(client.calls, []);
});

test('a replay reports the original decision rather than a second one', async () => {
  const client = new FakeClient();
  client.disposition = 'replayed';
  const outcome = await service(client).service.recordDecision(IDENTITY, input());
  assert.equal(outcome.ok && outcome.disposition, 'replayed');
  assert.equal(outcome.ok && outcome.consentEventId, CONSENT_EVENT);
});

test('database failures map to their exact founder-facing kind', async () => {
  for (const [code, kind] of [
    ['42501', 'forbidden'],
    ['23505', 'conflict'],
    ['40001', 'conflict'],
    ['22023', 'validation'],
    ['23514', 'validation'],
    ['23503', 'validation'],
    ['08006', 'unavailable'],
  ] as const) {
    const client = new FakeClient();
    client.error = Object.assign(new Error('database said no'), { code });
    const outcome = await service(client).service.recordDecision(IDENTITY, input());
    assert.deepEqual(outcome, { ok: false, kind }, `${code} must map to ${kind}`);
  }
});

test('a malformed or unconfirmed decision never opens a transaction', async () => {
  for (const override of [
    { operatorConfirmed: false },
    { decision: 'revoked' },
    { evidenceSource: 'previous_send' },
    { channel: 'social_dm' },
    { lawfulBasis: null },
    { commandKey: 'not-a-uuid' },
    { occurredAt: 'yesterday' },
  ] as Partial<PortalContactPermissionInput>[]) {
    const client = new FakeClient();
    const outcome = await service(client).service.recordDecision(IDENTITY, input(override));
    assert.deepEqual(
      outcome, { ok: false, kind: 'validation' },
      `${JSON.stringify(override)} must be refused`,
    );
    assert.deepEqual(client.calls, [], 'nothing may reach the database');
  }
});

test('the seam never queues, sends or releases anything', async () => {
  const client = new FakeClient();
  await service(client).service.recordDecision(IDENTITY, input());
  const sql = client.calls.map((entry) => entry.sql).join('\n');
  for (const forbidden of [
    'suppression', 'enqueue', 'dispatch', 'message_deliveries', 'provider_operations',
  ]) {
    assert.equal(sql.toLowerCase().includes(forbidden), false, `${forbidden} must not appear`);
  }
});
