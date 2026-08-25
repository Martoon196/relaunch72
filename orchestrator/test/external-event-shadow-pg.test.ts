import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import {
  PgPropertyPredatorExternalEventShadowService,
  PropertyPredatorExternalEventReceiptConflictError,
  assertPgPropertyPredatorExternalEventShadowStoreReady,
  type VerifiedPropertyPredatorExternalEventSignature,
} from '../src/integrations/external-events/index.js';

const WORKSPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EVENT_ID = '0198e9dd-a56f-7000-8000-000000000001';
const CORRELATION_ID = '0198e9dd-a56f-7000-8000-000000000002';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const SIGNATURE_TIMESTAMP = 1_787_652_000;
const VERIFIED_SIGNATURE: VerifiedPropertyPredatorExternalEventSignature = Object.freeze({
  keyId: 'pp-growth-2026-01',
  timestampSeconds: SIGNATURE_TIMESTAMP,
  signatureVersion: 'v1',
});

function rawEvent(extraData: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    id: EVENT_ID,
    type: 'identity.account.created',
    version: 1,
    occurredAt: '2026-08-25T12:00:00.000Z',
    correlationId: CORRELATION_ID,
    subject: { kind: 'account', id: ACCOUNT_ID },
    data: { email: 'hunter@example.com', signupMethod: 'password', ...extraData },
  }));
}

type QueryCall = Readonly<{ text: string; values: readonly unknown[] }>;

function mockPool(
  domainQuery: (text: string, values: readonly unknown[]) => Promise<{ rows: unknown[] }>,
): { pool: Pick<Pool, 'connect'>; calls: QueryCall[]; releases: boolean[] } {
  const calls: QueryCall[] = [];
  const releases: boolean[] = [];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      const call = { text, values: values ?? [] };
      calls.push(call);
      if (text.startsWith('BEGIN') || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [] };
      }
      if (text.includes("set_config('app.user_id'")) return { rows: [{}] };
      return domainQuery(text, values ?? []);
    },
    release: (destroy?: boolean) => releases.push(destroy === true),
  } as unknown as PoolClient;
  return {
    pool: { connect: async () => client } as Pick<Pool, 'connect'>,
    calls,
    releases,
  };
}

test('the protected migration exposes only a dedicated receipt-only command capability', async () => {
  const sql = await readFile(new URL(
    '../src/db/migrations/0015_external_event_shadow_bridge.sql',
    import.meta.url,
  ), 'utf8');

  assert.match(sql, /CREATE TABLE app_private\.external_event_shadow_receipts/);
  assert.match(sql, /PRIMARY KEY \(workspace_id, source, event_id\)/);
  assert.match(sql, /payload_sha256 bytea NOT NULL CHECK \(octet_length\(payload_sha256\) = 32\)/);
  assert.match(sql, /disposition text NOT NULL DEFAULT 'shadow' CHECK \(disposition = 'shadow'\)/);
  assert.match(sql, /GRANT SELECT, INSERT ON app_private\.external_event_shadow_receipts\s+TO r72_external_event_definer/);
  assert.doesNotMatch(sql, /GRANT (?:UPDATE|DELETE)[^;]*external_event_shadow_receipts/);
  assert.doesNotMatch(sql, /GRANT [^;]*external_event_shadow_receipts[^;]*TO r72_(?:web|webhook|worker|crm_command)/);
  assert.match(sql, /CREATE ROLE %I %s NOINHERIT/);
  assert.match(sql, /'r72_external_event_command', true/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA app FROM r72_external_event_command/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM r72_external_event_command/);

  const functionBody = /CREATE FUNCTION app_private\.record_external_event_shadow_receipt\([\s\S]+?\n\$function\$;/.exec(sql)?.[0];
  assert.ok(functionBody);
  assert.match(functionBody, /SECURITY DEFINER\s+SET search_path = pg_catalog/);
  assert.match(functionBody, /trusted_actor_kind IS DISTINCT FROM 'webhook'/);
  assert.match(functionBody, /p_workspace_id IS DISTINCT FROM trusted_workspace_id/);
  assert.match(functionBody, /ON CONFLICT \(workspace_id, source, event_id\) DO NOTHING/);
  assert.match(functionBody, /existing_payload_sha256 IS DISTINCT FROM p_payload_sha256/);
  assert.match(functionBody, /RETURN QUERY SELECT 'shadow'::text, true/);
  assert.doesNotMatch(functionBody, /INSERT INTO app\./);
  assert.doesNotMatch(functionBody, /outbox_events|conversion_|command_receipts|contacts|opportunities/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.record_external_event_shadow_receipt\([\s\S]+?\) TO r72_external_event_command/);
  assert.doesNotMatch(sql, /\) TO r72_webhook/);
  assert.match(sql, /owner_role\.rolname = 'r72_external_event_definer'/);
  assert.match(sql, /procedure\.prosecdef/);
  assert.match(sql, /procedure\.proconfig = ARRAY\['search_path=pg_catalog'\]::text\[\]/);
});

test('store readiness requires the exact receipt-only role and hardened recorder', async () => {
  let readinessSql = '';
  const pool = {
    query: async (sql: string) => {
      readinessSql = sql;
      return { rows: [{
        database_user: 'r72_external_event_command',
        recorder_exists: true,
        recorder_executable: true,
        recorder_owned_by_definer: true,
        recorder_security_definer: true,
        recorder_fixed_search_path: true,
        app_private_usage_only: true,
        no_table_privileges: true,
        no_unexpected_private_function_execute: true,
      }] };
    },
  } as unknown as Pick<Pool, 'query'>;
  await assert.doesNotReject(
    assertPgPropertyPredatorExternalEventShadowStoreReady(pool),
  );
  assert.match(readinessSql, /to_regprocedure/);
  assert.match(readinessSql, /has_function_privilege/);

  const wrongRole = {
    query: async () => ({ rows: [{
      database_user: 'r72_owner',
      recorder_exists: true,
      recorder_executable: true,
      recorder_owned_by_definer: true,
      recorder_security_definer: true,
      recorder_fixed_search_path: true,
      app_private_usage_only: true,
      no_table_privileges: true,
      no_unexpected_private_function_execute: true,
    }] }),
  } as unknown as Pick<Pool, 'query'>;
  await assert.rejects(
    assertPgPropertyPredatorExternalEventShadowStoreReady(wrongRole),
    /receipt store is not ready/,
  );

  const broadRole = {
    query: async () => ({ rows: [{
      database_user: 'r72_external_event_command',
      recorder_exists: true,
      recorder_executable: true,
      recorder_owned_by_definer: true,
      recorder_security_definer: true,
      recorder_fixed_search_path: true,
      app_private_usage_only: true,
      no_table_privileges: false,
      no_unexpected_private_function_execute: true,
    }] }),
  } as unknown as Pick<Pool, 'query'>;
  await assert.rejects(
    assertPgPropertyPredatorExternalEventShadowStoreReady(broadRole),
    /receipt store is not ready/,
  );
});

test('server composition cannot borrow the broader webhook database pool', async () => {
  const serverSource = await readFile(new URL('../src/server/index.ts', import.meta.url), 'utf8');
  assert.match(serverSource, /createExternalEventCommandDatabasePool\(process\.env\)/);
  assert.match(serverSource, /DATABASE_EXTERNAL_EVENT_COMMAND_URL/);
  assert.doesNotMatch(serverSource, /loadDatabaseConfig\('webhook'[^)]*\)/);
  assert.doesNotMatch(serverSource, /externalEventWebhookPool|webhookPool: externalEvent/);
});

test('record derives workspace only from server mapping and hashes exact raw bytes', async () => {
  const rawBody = rawEvent();
  const mocked = mockPool(async (text, values) => {
    assert.match(text, /record_external_event_shadow_receipt/);
    assert.deepEqual(values.slice(0, 10), [
      WORKSPACE_ID,
      'property_predator',
      EVENT_ID,
      'identity.account.created',
      1,
      '2026-08-25T12:00:00.000Z',
      CORRELATION_ID,
      'account',
      ACCOUNT_ID,
      createHash('sha256').update(rawBody).digest(),
    ]);
    const storedPayload = JSON.parse(values[10] as string) as Record<string, unknown>;
    assert.equal(Object.hasOwn(storedPayload, 'workspaceId'), false);
    assert.equal(values[11], VERIFIED_SIGNATURE.keyId);
    assert.equal(values[12], new Date(SIGNATURE_TIMESTAMP * 1_000).toISOString());
    assert.equal(values.includes(rawBody), false);
    return { rows: [{ disposition: 'shadow', replayed: false }] };
  });
  const service = new PgPropertyPredatorExternalEventShadowService({
    commandPool: mocked.pool,
    workspaceId: WORKSPACE_ID,
  });

  const result = await service.record({ rawBody, verifiedSignature: VERIFIED_SIGNATURE });

  assert.deepEqual(result, { disposition: 'shadow', replayed: false });
  assert.ok(Object.isFrozen(result));
  assert.match(mocked.calls[0]!.text, /^BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE$/);
  assert.deepEqual(mocked.calls[1]!.values, [
    '', WORKSPACE_ID, 'webhook', `property-predator:${EVENT_ID}`,
  ]);
  assert.equal(mocked.calls.at(-1)!.text, 'COMMIT');
  assert.deepEqual(mocked.releases, [false]);
});

test('an exact database replay returns only the stable shadow disposition', async () => {
  const mocked = mockPool(async () => ({
    rows: [{ disposition: 'shadow', replayed: true }],
  }));
  const service = new PgPropertyPredatorExternalEventShadowService({
    commandPool: mocked.pool,
    workspaceId: WORKSPACE_ID,
  });

  const result = await service.record({
    rawBody: rawEvent(),
    verifiedSignature: VERIFIED_SIGNATURE,
  });

  assert.deepEqual(result, { disposition: 'shadow', replayed: true });
  assert.deepEqual(Object.keys(result), ['disposition', 'replayed']);
  assert.equal('payload' in result, false);
  assert.equal('payloadSha256' in result, false);
});

test('a changed-payload replay becomes a typed conflict and rolls back', async () => {
  const conflict = Object.assign(new Error(
    'external event id was replayed with different payload bytes',
  ), { code: '22000' });
  const mocked = mockPool(async () => { throw conflict; });
  const service = new PgPropertyPredatorExternalEventShadowService({
    commandPool: mocked.pool,
    workspaceId: WORKSPACE_ID,
  });

  await assert.rejects(
    () => service.record({ rawBody: rawEvent(), verifiedSignature: VERIFIED_SIGNATURE }),
    PropertyPredatorExternalEventReceiptConflictError,
  );
  assert.equal(mocked.calls.at(-1)!.text, 'ROLLBACK');
  assert.deepEqual(mocked.releases, [false]);
});

test('malformed inputs fail before a database connection is acquired', async () => {
  let connections = 0;
  const pool = {
    connect: async () => {
      connections += 1;
      throw new Error('must not connect');
    },
  } as unknown as Pick<Pool, 'connect'>;
  const service = new PgPropertyPredatorExternalEventShadowService({
    commandPool: pool,
    workspaceId: WORKSPACE_ID,
  });

  await assert.rejects(
    () => service.record({
      rawBody: rawEvent({ unexpected: true }),
      verifiedSignature: VERIFIED_SIGNATURE,
    }),
    /unsupported field: unexpected/,
  );
  await assert.rejects(
    () => service.record({
      rawBody: rawEvent(),
      verifiedSignature: { ...VERIFIED_SIGNATURE, signatureVersion: 'v2' as never },
    }),
    /verifiedSignature is invalid/,
  );
  assert.equal(connections, 0);
  assert.throws(
    () => new PgPropertyPredatorExternalEventShadowService({
      commandPool: pool,
      workspaceId: WORKSPACE_ID.toUpperCase(),
    }),
    /canonical lowercase UUID/,
  );
});
