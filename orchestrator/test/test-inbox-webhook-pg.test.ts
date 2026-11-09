import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { loadDatabaseConfig } from '../src/db/config.js';
import {
  assertPgTestInboxWebhookIngressReady,
  PgTestInboxWebhookRepository,
  TestInboxWebhookBindingError,
  TestInboxWebhookEventConflictError,
  TestInboxWebhookSignatureReplayError,
  type VerifiedTestInboxWebhookRecordInput,
} from '../src/test-inbox-webhook-pg/index.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';
const INBOX = '33333333-3333-4333-8333-333333333333';
const CONTACT = '44444444-4444-4444-8444-444444444444';
const POINT = '55555555-5555-4555-8555-555555555555';
const CONVERSATION = '66666666-6666-4666-8666-666666666666';
const MESSAGE = '77777777-7777-4777-8777-777777777777';
const VERSION = '88888888-8888-4888-8888-888888888888';
const INSTALLATION = '99999999-9999-4999-8999-999999999999';
const EVENT = `waevt_${'a'.repeat(32)}`;
const NOW = '2026-08-27T12:00:00.000Z';

function digest(seed: string): Buffer {
  return createHash('sha256').update(seed, 'utf8').digest();
}

function input(overrides: Partial<VerifiedTestInboxWebhookRecordInput> = {}): VerifiedTestInboxWebhookRecordInput {
  return {
    workspaceId: WORKSPACE,
    providerConnectionId: CONNECTION,
    providerId: 'whatsapp_dark_simulator',
    inboxId: INBOX,
    contactId: CONTACT,
    contactPointId: POINT,
    externalEventId: EVENT,
    occurredAt: NOW,
    payloadSha256: digest('payload'),
    eventIdentitySha256: digest('identity'),
    signatureSha256: digest('signature'),
    sourceIdentitySha256: digest('+447700900002'),
    destinationIdentitySha256: digest('+447700900001'),
    body: 'Signed fictional WhatsApp inbound.',
    ...overrides,
  };
}

function queryResult<TRow extends QueryResultRow>(rows: TRow[]): QueryResult<TRow> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

function fakePool(options: Readonly<{
  row?: QueryResultRow;
  databaseError?: Error & { code?: string };
}> = {}): {
  readonly pool: Pick<Pool, 'connect'>;
  readonly statements: Array<{ sql: string; values: readonly unknown[] }>;
  readonly releases: () => number;
} {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  let releaseCount = 0;
  const client = {
    async query<TRow extends QueryResultRow>(sql: string, values: readonly unknown[] = []) {
      statements.push({ sql, values });
      if (sql.includes('record_test_inbox_webhook_inbound')) {
        if (options.databaseError) throw options.databaseError;
        return queryResult([options.row ?? {
          replayed: false,
          conversationId: CONVERSATION,
          messageId: MESSAGE,
          messageVersionId: VERSION,
          bodySha256: createHash('sha256')
            .update('Signed fictional WhatsApp inbound.', 'utf8').digest('hex'),
        }] as TRow[]);
      }
      return queryResult([] as TRow[]);
    },
    release() { releaseCount += 1; },
  } as unknown as PoolClient;
  return {
    pool: { connect: async () => client } as Pick<Pool, 'connect'>,
    statements,
    releases: () => releaseCount,
  };
}

function repository(database: ReturnType<typeof fakePool>): PgTestInboxWebhookRepository {
  const ids = [CONVERSATION, MESSAGE, VERSION];
  return new PgTestInboxWebhookRepository({
    commandPool: database.pool,
    binding: {
      workspaceId: WORKSPACE,
      providerConnectionId: CONNECTION,
      providerId: 'whatsapp_dark_simulator',
      inboxId: INBOX,
      contactId: CONTACT,
      contactPointId: POINT,
    },
    nextId: () => ids.shift()!,
  });
}

function fakeReadinessPool(options: Readonly<{
  readonly protectedReady?: boolean;
  readonly bindingReady?: boolean;
  readonly installationId?: string;
}> = {}): {
  readonly pool: Pick<Pool, 'query' | 'connect'>;
  readonly statements: Array<{ sql: string; values: readonly unknown[] }>;
  readonly releases: () => number;
} {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  let releaseCount = 0;
  const runQuery = async <TRow extends QueryResultRow>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<TRow>> => {
    statements.push({ sql, values });
    if (sql.includes('test-inbox-webhook.protected-readiness')) {
      const ready = options.protectedReady ?? true;
      return queryResult([{
        correctUser: ready,
        canRecord: ready,
        tableBlind: ready,
        cannotAssumeDefiner: ready,
        canCheckBinding: ready,
        canCheckInstallation: ready,
        cannotUseAppSchema: ready,
      }] as unknown as TRow[]);
    }
    if (sql.includes('runtime_database_installation_id')) {
      return queryResult([{
        installationId: options.installationId ?? INSTALLATION,
      }] as unknown as TRow[]);
    }
    if (sql.includes('test_inbox_webhook_binding_ready')) {
      return queryResult([{ ready: options.bindingReady ?? true }] as unknown as TRow[]);
    }
    return queryResult([] as TRow[]);
  };
  const client = {
    query: runQuery,
    release() { releaseCount += 1; },
  } as unknown as PoolClient;
  return {
    pool: {
      query: runQuery as Pool['query'],
      connect: (async () => client) as Pool['connect'],
    },
    statements,
    releases: () => releaseCount,
  };
}

test('verified simulated inbound records through one hash-only webhook command', async () => {
  const database = fakePool();
  const result = await repository(database).record(input());
  assert.deepEqual(result, {
    replayed: false,
    conversationId: CONVERSATION,
    messageId: MESSAGE,
    messageVersionId: VERSION,
    bodySha256: createHash('sha256')
      .update('Signed fictional WhatsApp inbound.', 'utf8').digest('hex'),
  });
  const context = database.statements.find((statement) => statement.sql.includes("set_config('app.user_id'"));
  assert.equal(context?.values[0], '');
  assert.equal(context?.values[1], WORKSPACE);
  assert.equal(context?.values[2], 'webhook');
  assert.match(String(context?.values[3]), /^test-inbox:[a-f0-9]{48}$/);

  const recorder = database.statements.find((statement) =>
    statement.sql.includes('record_test_inbox_webhook_inbound'))!;
  assert.equal(recorder.values.length, 18);
  assert.deepEqual(recorder.values.slice(0, 7), [
    WORKSPACE, CONNECTION, 'whatsapp_dark_simulator',
    INBOX, CONTACT, POINT, EVENT,
  ]);
  assert.equal(recorder.values[12], 'Signed fictional WhatsApp inbound.');
  assert.deepEqual(recorder.values[13], digest('Signed fictional WhatsApp inbound.'));
  assert.deepEqual(recorder.values.slice(15), [CONVERSATION, MESSAGE, VERSION]);
  assert.equal(JSON.stringify(recorder.values).includes('+447700900'), false);
  assert.equal(JSON.stringify(recorder.values).includes('signature-secret'), false);
  assert.equal(database.releases(), 1);
});

test('trusted workspace, connection, provider and command targets cannot drift', async () => {
  for (const changed of [
    input({ workspaceId: '99999999-9999-4999-8999-999999999999' }),
    input({ providerConnectionId: '99999999-9999-4999-8999-999999999999' }),
    input({ providerId: 'social_dm_dark_simulator', externalEventId: `social_dm_evt_${'b'.repeat(32)}` }),
    input({ inboxId: '99999999-9999-4999-8999-999999999999' }),
    input({ contactId: '99999999-9999-4999-8999-999999999999' }),
    input({ contactPointId: '99999999-9999-4999-8999-999999999999' }),
  ]) {
    const database = fakePool();
    await assert.rejects(repository(database).record(changed), TestInboxWebhookBindingError);
    assert.equal(database.statements.length, 0);
  }
});

test('input normalization rejects malformed digests, event IDs, bodies and timestamps before PostgreSQL', async () => {
  const invalid = [
    input({ payloadSha256: Buffer.alloc(31) }),
    input({ externalEventId: `social_dm_evt_${'a'.repeat(32)}` }),
    input({ occurredAt: '2026-08-27 12:00:00' }),
    input({ body: '' }),
    input({ body: 'bad\u0001body' }),
  ];
  for (const value of invalid) {
    const database = fakePool();
    await assert.rejects(repository(database).record(value), TypeError);
    assert.equal(database.statements.length, 0);
  }
});

test('database conflict classes are stable and never echo database diagnostics', async () => {
  const cases = [
    ['22000', 'test inbox webhook event identity conflict', TestInboxWebhookEventConflictError],
    ['22000', 'test inbox webhook signature replay conflict', TestInboxWebhookSignatureReplayError],
    ['42501', 'test inbox webhook binding is unavailable', TestInboxWebhookBindingError],
  ] as const;
  for (const [code, message, expected] of cases) {
    const database = fakePool({ databaseError: Object.assign(new Error(message), { code }) });
    await assert.rejects(repository(database).record(input()), expected);
    assert.equal(database.statements.at(-1)?.sql, 'ROLLBACK');
    assert.equal(database.releases(), 1);
  }
});

test('dedicated webhook database role requires its exact production identity', () => {
  assert.throws(() => loadDatabaseConfig('testInboxWebhookCommand', {
    NODE_ENV: 'production',
    DATABASE_TEST_INBOX_WEBHOOK_URL: 'postgresql://r72_web:secret@database.example/relaunch72?sslmode=require',
  }), /r72_test_inbox_webhook_command/);
  const config = loadDatabaseConfig('testInboxWebhookCommand', {
    NODE_ENV: 'production',
    DATABASE_TEST_INBOX_WEBHOOK_URL:
      'postgresql://r72_test_inbox_webhook_command:secret@database.example/relaunch72?sslmode=require',
    DATABASE_TEST_INBOX_WEBHOOK_POOL_MAX: '3',
  });
  assert.equal(config.role, 'testInboxWebhookCommand');
  assert.equal(config.sourceEnv, 'DATABASE_TEST_INBOX_WEBHOOK_URL');
  assert.equal(config.expectedDatabaseUser, 'r72_test_inbox_webhook_command');
  assert.equal(config.maxConnections, 3);
  assert.equal(config.applicationName, 'property-predator-test-inbox-webhook-command');
});

test('readiness proves installation, function-only identity and exact trusted binding', async () => {
  const database = fakeReadinessPool();
  await assert.doesNotReject(assertPgTestInboxWebhookIngressReady(
    database.pool,
    {
      workspaceId: WORKSPACE,
      providerConnectionId: CONNECTION,
      providerId: 'whatsapp_dark_simulator',
      inboxId: INBOX,
      contactId: CONTACT,
      contactPointId: POINT,
    },
    INSTALLATION,
  ));
  assert.equal(database.releases(), 1);
  assert.match(database.statements[0]!.sql, /runtime_database_installation_id/);
  assert.match(database.statements[1]!.sql, /test-inbox-webhook\.protected-readiness/);
  const binding = database.statements.find((statement) =>
    statement.sql.includes('test-inbox-webhook.binding-readiness'))!;
  assert.deepEqual(binding.values, [
    WORKSPACE, CONNECTION, 'whatsapp_dark_simulator', INBOX, CONTACT, POINT,
  ]);
  const context = database.statements.find((statement) => statement.sql.includes("set_config('app.user_id'"));
  assert.deepEqual(context?.values, [
    '', WORKSPACE, 'webhook', 'test-inbox:protected-readiness',
  ]);
});

test('readiness fails closed on invalid binding, broad identity or unavailable binding', async () => {
  const invalid = fakeReadinessPool();
  await assert.rejects(assertPgTestInboxWebhookIngressReady(
    invalid.pool,
    {
      workspaceId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      providerConnectionId: CONNECTION,
      providerId: 'whatsapp_dark_simulator',
      inboxId: INBOX,
      contactId: CONTACT,
      contactPointId: POINT,
    },
    INSTALLATION,
  ), /readiness binding is invalid/);
  assert.equal(invalid.statements.length, 0);

  const broad = fakeReadinessPool({ protectedReady: false });
  await assert.rejects(assertPgTestInboxWebhookIngressReady(
    broad.pool,
    {
      workspaceId: WORKSPACE,
      providerConnectionId: CONNECTION,
      providerId: 'whatsapp_dark_simulator',
      inboxId: INBOX,
      contactId: CONTACT,
      contactPointId: POINT,
    },
    INSTALLATION,
  ), /did not pass protected readiness/);

  const missing = fakeReadinessPool({ bindingReady: false });
  await assert.rejects(assertPgTestInboxWebhookIngressReady(
    missing.pool,
    {
      workspaceId: WORKSPACE,
      providerConnectionId: CONNECTION,
      providerId: 'whatsapp_dark_simulator',
      inboxId: INBOX,
      contactId: CONTACT,
      contactPointId: POINT,
    },
    INSTALLATION,
  ), /workspace binding did not pass readiness/);
  assert.equal(missing.releases(), 1);
});
