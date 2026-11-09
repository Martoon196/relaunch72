import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveFounderEmailPilotIdentifiers,
  deriveFounderPilotCommandKey,
} from '../src/founder-email-pilot/foundation.js';
import {
  PgPortalPermissionUseReceiptService,
} from '../src/portal/permission-use-receipt-pg-service.js';
import type {
  ConsumePermissionUseInput,
} from '../src/portal/permission-use-receipt-service.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const CONTACT = '725fb294-41a3-4806-a020-fd97cbf9c715';
const POINT = '33333333-3333-4333-8333-333333333333';
const CONNECTION = '44444444-4444-4444-8444-444444444444';
const COMMAND_KEY = '55555555-5555-4555-8555-555555555555';
const USER = '66666666-6666-4666-8666-666666666666';
const SUBJECT = '88888888-8888-4888-8888-888888888888';
const RECEIPT = '99999999-9999-4999-8999-999999999999';
const ACTION_SCOPE = 'a'.repeat(64);
const SNAPSHOT = 'b'.repeat(64);
const IDENTITY = { sessionToken: 'session-token', requestId: 'req-1' } as never;

function input(overrides: Partial<ConsumePermissionUseInput> = {}): ConsumePermissionUseInput {
  return {
    contactId: CONTACT,
    contactPointId: POINT,
    purpose: 'property_predator_marketing',
    commandKey: COMMAND_KEY,
    authorityValidUntil: new Date(Date.parse('2026-08-30T12:04:00.000Z')).toISOString(),
    ...overrides,
  };
}

class FakeClient {
  readonly calls: { sql: string; values: readonly unknown[] }[] = [];
  /** No row is how the resolver reports a scope it cannot bind a receipt to. */
  scopeRows: unknown[] = [{
    compliance_subject_id: SUBJECT,
    action_scope_sha256: ACTION_SCOPE,
    evidence_snapshot_sha256: SNAPSHOT,
  }];
  /** A receipt already stored under this command key's nonce, if any. */
  existingRows: unknown[] = [];
  insertError: unknown = null;

  async query(sql: string, values: readonly unknown[] = []): Promise<{ rows: unknown[] }> {
    this.calls.push({ sql, values });
    if (sql.includes('resolve_customer_email_permission_use_scope')) {
      return { rows: this.scopeRows };
    }
    if (sql.includes('permission-use.existing')) return { rows: this.existingRows };
    if (sql.includes('permission-use.consume')) {
      if (this.insertError) throw this.insertError;
      return { rows: [{
        id: RECEIPT, subject_id: SUBJECT, action_scope_sha256: ACTION_SCOPE,
        evidence_snapshot_sha256: SNAPSHOT, provider_effects: false,
      }] };
    }
    return { rows: [{ active: true }] };
  }

  release(): void { /* pooled */ }
}

function service(client: FakeClient, workspaceId = WORKSPACE) {
  return new PgPortalPermissionUseReceiptService({
    principalResolver: {
      async resolve() { return { userId: USER, workspaceId } as never; },
    },
    receiptPool: { async connect() { return client as never; } },
    providerConnectionId: CONNECTION,
    workspaceId: WORKSPACE,
  });
}

test('consuming a permission records exactly what the enqueue will re-resolve', async () => {
  const client = new FakeClient();
  const outcome = await service(client).consume(IDENTITY, input());
  assert.ok(outcome.ok);
  assert.equal(outcome.disposition, 'consumed');
  assert.equal(outcome.permissionUseReceiptId, RECEIPT);
  assert.equal(outcome.complianceSubjectId, SUBJECT);
  assert.equal(outcome.actionScopeSha256, ACTION_SCOPE);
  assert.equal(outcome.providerEffects, false);

  const insert = client.calls.find((entry) => entry.sql.includes('permission-use.consume'));
  assert.ok(insert);
  // The subject, scope and snapshot come from the resolver, never the caller.
  assert.equal(insert.values[1], SUBJECT);
  assert.equal(insert.values[2], ACTION_SCOPE);
  assert.equal(insert.values[3], SNAPSHOT);
  // The nonce is the workspace-scoped digest of the command key alone.
  assert.deepEqual(insert.values[4], Buffer.from(
    deriveFounderPilotCommandKey('email-permission-use', WORKSPACE, COMMAND_KEY), 'hex',
  ));
  // The request id is the derived one the enqueue folds into its own digest.
  assert.equal(
    insert.values[7], deriveFounderEmailPilotIdentifiers(WORKSPACE, COMMAND_KEY).requestId,
  );
  assert.equal(insert.values[6], USER);
});

test('the receipt is written with provider effects false and consumed state', async () => {
  const client = new FakeClient();
  await service(client).consume(IDENTITY, input());
  const insert = client.calls.find((entry) => entry.sql.includes('permission-use.consume'));
  assert.match(insert?.sql ?? '', /'email\.send'/);
  assert.match(insert?.sql ?? '', /'allow', 'consumed'/);
  // Literal false in the statement, not a parameter a caller could flip.
  assert.match(insert?.sql ?? '', /false, \$7::uuid/);
  assert.doesNotMatch(insert?.sql ?? '', /provider_effects\s*=\s*true/);
});

test('an identical retry reuses the one receipt rather than consuming again', async () => {
  const client = new FakeClient();
  client.existingRows = [{
    id: RECEIPT, subject_id: SUBJECT, action_scope_sha256: ACTION_SCOPE,
    evidence_snapshot_sha256: SNAPSHOT, provider_effects: false,
  }];
  const outcome = await service(client).consume(IDENTITY, input());
  assert.ok(outcome.ok);
  assert.equal(outcome.disposition, 'replayed');
  assert.equal(outcome.permissionUseReceiptId, RECEIPT);
  assert.equal(
    client.calls.filter((entry) => entry.sql.includes('permission-use.consume')).length, 0,
    'a replay must not write a second receipt',
  );
});

test('the same command key over changed evidence conflicts instead of consuming', async () => {
  for (const changed of [
    { evidence_snapshot_sha256: 'c'.repeat(64) },
    { action_scope_sha256: 'd'.repeat(64) },
    { subject_id: '77777777-7777-4777-8777-777777777777' },
  ]) {
    const client = new FakeClient();
    client.existingRows = [{
      id: RECEIPT, subject_id: SUBJECT, action_scope_sha256: ACTION_SCOPE,
      evidence_snapshot_sha256: SNAPSHOT, provider_effects: false, ...changed,
    }];
    assert.deepEqual(
      await service(client).consume(IDENTITY, input()),
      { ok: false, kind: 'conflict' }, JSON.stringify(changed),
    );
    assert.equal(
      client.calls.filter((entry) => entry.sql.includes('permission-use.consume')).length, 0,
    );
  }
});

test('an unresolvable scope records nothing at all', async () => {
  const client = new FakeClient();
  client.scopeRows = [];
  assert.deepEqual(
    await service(client).consume(IDENTITY, input()),
    { ok: false, kind: 'blocked' },
  );
  assert.equal(
    client.calls.filter((entry) => entry.sql.includes('permission-use.consume')).length, 0,
    'no scope means no permission was consumed',
  );
});

test('a session from another workspace records nothing', async () => {
  const client = new FakeClient();
  const other = '11111111-1111-4111-8111-1111111111ff';
  assert.deepEqual(
    await service(client, other).consume(IDENTITY, input()),
    { ok: false, kind: 'forbidden' },
  );
  assert.deepEqual(client.calls, []);
});

test('an unresolved session never opens a transaction', async () => {
  const client = new FakeClient();
  const unresolved = new PgPortalPermissionUseReceiptService({
    principalResolver: { async resolve() { return null; } },
    receiptPool: { async connect() { return client as never; } },
    providerConnectionId: CONNECTION,
    workspaceId: WORKSPACE,
  });
  assert.deepEqual(
    await unresolved.consume(IDENTITY, input()),
    { ok: false, kind: 'unauthenticated' },
  );
  assert.deepEqual(client.calls, []);
});

test('a malformed request never reaches the ledger', async () => {
  for (const override of [
    { commandKey: 'not-a-uuid' }, { contactPointId: 'not-a-uuid' },
    { contactId: 'not-a-uuid' }, { authorityValidUntil: 'not-a-time' },
    { purpose: 'Not A Purpose' },
  ] as Partial<ConsumePermissionUseInput>[]) {
    const client = new FakeClient();
    assert.deepEqual(
      await service(client).consume(IDENTITY, input(override)),
      { ok: false, kind: 'validation' }, JSON.stringify(override),
    );
    assert.deepEqual(client.calls, [], JSON.stringify(override));
  }
});

test('database refusals keep their exact founder-facing kind', async () => {
  for (const [code, kind] of [
    ['42501', 'forbidden'], ['23505', 'conflict'], ['40001', 'conflict'],
    ['23514', 'validation'], ['08006', 'unavailable'],
  ] as const) {
    const client = new FakeClient();
    client.insertError = Object.assign(new Error('refused'), { code });
    assert.deepEqual(
      await service(client).consume(IDENTITY, input()),
      { ok: false, kind }, `${code} must map to ${kind}`,
    );
  }
});

test('a malformed stored or resolved row is refused rather than reused', async () => {
  const bad = new FakeClient();
  bad.existingRows = [{
    id: RECEIPT, subject_id: SUBJECT, action_scope_sha256: 'short',
    evidence_snapshot_sha256: SNAPSHOT, provider_effects: false,
  }];
  assert.deepEqual(
    await service(bad).consume(IDENTITY, input()), { ok: false, kind: 'validation' },
  );
  // A stored receipt claiming a provider effect is never honoured.
  const lying = new FakeClient();
  lying.existingRows = [{
    id: RECEIPT, subject_id: SUBJECT, action_scope_sha256: ACTION_SCOPE,
    evidence_snapshot_sha256: SNAPSHOT, provider_effects: true,
  }];
  assert.deepEqual(
    await service(lying).consume(IDENTITY, input()), { ok: false, kind: 'validation' },
  );
  const ambiguous = new FakeClient();
  ambiguous.scopeRows = [
    { compliance_subject_id: SUBJECT, action_scope_sha256: ACTION_SCOPE,
      evidence_snapshot_sha256: SNAPSHOT },
    { compliance_subject_id: SUBJECT, action_scope_sha256: ACTION_SCOPE,
      evidence_snapshot_sha256: SNAPSHOT },
  ];
  assert.deepEqual(
    await service(ambiguous).consume(IDENTITY, input()), { ok: false, kind: 'validation' },
  );
});

test('this seam enqueues nothing and reaches no provider', async () => {
  const client = new FakeClient();
  await service(client).consume(IDENTITY, input());
  const sql = client.calls.map((entry) => entry.sql).join('\n').toLowerCase();
  for (const forbidden of [
    'authorize_and_enqueue', 'mailgun', 'http', 'provider_operations',
    'message_deliveries', 'communication_consent_events',
    'communication_suppression_events',
  ]) {
    assert.equal(sql.includes(forbidden), false, `${forbidden} must not appear`);
  }
  // The only table it writes is the compliance use-receipt ledger.
  const writes = client.calls.filter((entry) => /insert into/iu.test(entry.sql));
  assert.equal(writes.length, 1);
  assert.match(
    writes[0]?.sql ?? '',
    /INSERT INTO app_private\.affiliate_compliance_permission_use_receipts/,
  );
});

test('the seam requires the exact workspace and connection at construction', () => {
  for (const broken of [
    { providerConnectionId: 'not-a-uuid', workspaceId: WORKSPACE },
    { providerConnectionId: CONNECTION, workspaceId: 'not-a-uuid' },
  ]) {
    assert.throws(() => new PgPortalPermissionUseReceiptService({
      principalResolver: { async resolve() { return null; } },
      receiptPool: { async connect() { return new FakeClient() as never; } },
      ...broken,
    }), /exact workspace and connection/);
  }
});
