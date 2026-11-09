import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import {
  PgPropertyPredatorGrowthEventProjector,
  assertPgPropertyPredatorGrowthEventProjectorReady,
} from '../src/integrations/external-events/index.js';

const WORKSPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EVENT_ID = '0198e9dd-a56f-7000-8000-000000000001';

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

const READY_ROW = Object.freeze({
  database_user: 'r72_webhook',
  projector_exists: true,
  projector_executable: true,
  projector_owned_by_definer: true,
  projector_security_definer: true,
  projector_fixed_search_path: true,
  growth_tables_exist: true,
  no_growth_table_privileges: true,
  shadow_recorder_exists: true,
  shadow_recorder_not_executable: true,
});

test('readiness proves the exact hardened function and table-blind webhook role', async () => {
  let readinessSql = '';
  const pool = {
    query: async (sql: string) => {
      readinessSql = sql;
      return { rows: [READY_ROW] };
    },
  } as unknown as Pick<Pool, 'query'>;

  await assert.doesNotReject(
    assertPgPropertyPredatorGrowthEventProjectorReady(pool),
  );

  assert.match(
    readinessSql,
    /to_regprocedure\(\s*'app_private\.project_property_predator_growth_event\(uuid\)'\s*\)/,
  );
  assert.match(readinessSql, /owner_name = 'r72_growth_projector_definer'/);
  assert.match(readinessSql, /projector\.prosecdef IS TRUE/);
  assert.match(
    readinessSql,
    /projector\.proconfig = ARRAY\['search_path=pg_catalog'\]::text\[\]/,
  );
  assert.match(readinessSql, /has_function_privilege\(current_user, projector\.oid, 'EXECUTE'\)/);

  for (const relation of [
    'app.contact_source_identities',
    'app.content_consumption_facts',
    'app.offer_presentation_facts',
    'app.offer_response_facts',
    'app.contact_attribution_facts',
    'app_private.external_event_projection_receipts',
  ]) {
    assert.ok(readinessSql.includes(`'${relation}'`), `missing readiness check for ${relation}`);
  }
  for (const privilege of [
    'SELECT',
    'INSERT',
    'UPDATE',
    'DELETE',
    'TRUNCATE',
    'REFERENCES',
    'TRIGGER',
  ]) {
    assert.ok(
      readinessSql.includes(`relation.oid, '${privilege}'`),
      `missing readiness check for ${privilege}`,
    );
  }
  for (const columnPrivilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
    assert.ok(
      readinessSql.includes(`has_any_column_privilege(current_user, relation.oid, '${columnPrivilege}')`),
      `missing column-level readiness check for ${columnPrivilege}`,
    );
  }
  assert.match(
    readinessSql,
    /record_external_event_shadow_receipt\(uuid,text,uuid,text,smallint,timestamptz,uuid,text,uuid,bytea,jsonb,text,timestamptz\)/,
  );
  assert.match(readinessSql, /shadow_recorder_not_executable/);
});

test('readiness fails closed for the wrong role, broad table access, or shadow-recorder execution', async () => {
  for (const row of [
    { ...READY_ROW, database_user: 'r72_owner' },
    { ...READY_ROW, projector_exists: false },
    { ...READY_ROW, projector_executable: false },
    { ...READY_ROW, projector_owned_by_definer: false },
    { ...READY_ROW, projector_security_definer: false },
    { ...READY_ROW, projector_fixed_search_path: false },
    { ...READY_ROW, growth_tables_exist: false },
    { ...READY_ROW, no_growth_table_privileges: false },
    { ...READY_ROW, shadow_recorder_exists: false },
    { ...READY_ROW, shadow_recorder_not_executable: false },
  ]) {
    const pool = {
      query: async () => ({ rows: [row] }),
    } as unknown as Pick<Pool, 'query'>;
    await assert.rejects(
      assertPgPropertyPredatorGrowthEventProjectorReady(pool),
      /Growth event projector is not ready/,
    );
  }

  const duplicateRowPool = {
    query: async () => ({ rows: [READY_ROW, READY_ROW] }),
  } as unknown as Pick<Pool, 'query'>;
  await assert.rejects(
    assertPgPropertyPredatorGrowthEventProjectorReady(duplicateRowPool),
    /Growth event projector is not ready/,
  );
});

test('project sends only the event ID through the webhook transaction boundary', async () => {
  const mocked = mockPool(async (text, values) => {
    assert.match(
      text,
      /FROM app_private\.project_property_predator_growth_event\(\$1::uuid\)/,
    );
    assert.deepEqual(values, [EVENT_ID]);
    assert.equal(text.includes('record_external_event_shadow_receipt'), false);
    return { rows: [{ disposition: 'projected', replayed: false }] };
  });
  const projector = new PgPropertyPredatorGrowthEventProjector({
    webhookPool: mocked.pool,
    workspaceId: WORKSPACE_ID,
  });

  const result = await projector.project(EVENT_ID);

  assert.deepEqual(result, { disposition: 'projected', replayed: false });
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(Object.keys(result), ['disposition', 'replayed']);
  assert.match(mocked.calls[0]!.text, /^BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE$/);
  assert.deepEqual(mocked.calls[1]!.values, [
    '',
    WORKSPACE_ID,
    'webhook',
    `property-predator-projector:${EVENT_ID}`,
  ]);
  assert.equal(mocked.calls.at(-1)!.text, 'COMMIT');
  assert.deepEqual(mocked.releases, [false]);
});

test('an idempotent replay returns the same minimal result shape', async () => {
  const mocked = mockPool(async () => ({
    rows: [{ disposition: 'projected', replayed: true }],
  }));
  const projector = new PgPropertyPredatorGrowthEventProjector({
    webhookPool: mocked.pool,
    workspaceId: WORKSPACE_ID,
  });

  const result = await projector.project(EVENT_ID);

  assert.deepEqual(result, { disposition: 'projected', replayed: true });
  assert.equal('contactId' in result, false);
  assert.equal('payload' in result, false);
  assert.equal(mocked.calls.at(-1)!.text, 'COMMIT');
});

test('invalid projector results fail the transaction without leaking a partial success', async () => {
  const invalidRows: unknown[][] = [
    [],
    [
      { disposition: 'projected', replayed: false },
      { disposition: 'projected', replayed: false },
    ],
    [{ disposition: 'ignored', replayed: false }],
    [{ disposition: 'projected', replayed: 'false' }],
    [{ disposition: 'projected', replayed: false, contact_id: ACCOUNT_SENTINEL }],
  ];

  for (const rows of invalidRows) {
    const mocked = mockPool(async () => ({ rows }));
    const projector = new PgPropertyPredatorGrowthEventProjector({
      webhookPool: mocked.pool,
      workspaceId: WORKSPACE_ID,
    });
    await assert.rejects(
      projector.project(EVENT_ID),
      /invalid canonical data/,
    );
    assert.equal(mocked.calls.at(-1)!.text, 'ROLLBACK');
    assert.deepEqual(mocked.releases, [false]);
  }
});

const ACCOUNT_SENTINEL = '22222222-2222-4222-8222-222222222222';

test('database failures propagate and roll back', async () => {
  const failure = new Error('projector unavailable');
  const mocked = mockPool(async () => { throw failure; });
  const projector = new PgPropertyPredatorGrowthEventProjector({
    webhookPool: mocked.pool,
    workspaceId: WORKSPACE_ID,
  });

  await assert.rejects(projector.project(EVENT_ID), failure);
  assert.equal(mocked.calls.at(-1)!.text, 'ROLLBACK');
  assert.deepEqual(mocked.releases, [false]);
});

test('malformed trusted IDs fail before a database connection is acquired', async () => {
  let connections = 0;
  const pool = {
    connect: async () => {
      connections += 1;
      throw new Error('must not connect');
    },
  } as unknown as Pick<Pool, 'connect'>;

  assert.throws(
    () => new PgPropertyPredatorGrowthEventProjector({
      webhookPool: pool,
      workspaceId: WORKSPACE_ID.toUpperCase(),
    }),
    /workspaceId must be a canonical lowercase UUID/,
  );
  assert.throws(
    () => new PgPropertyPredatorGrowthEventProjector({
      webhookPool: {} as Pick<Pool, 'connect'>,
      workspaceId: WORKSPACE_ID,
    }),
    /webhookPool must provide connect/,
  );

  const projector = new PgPropertyPredatorGrowthEventProjector({
    webhookPool: pool,
    workspaceId: WORKSPACE_ID,
  });
  for (const eventId of [
    'not-a-uuid',
    EVENT_ID.toUpperCase(),
    '0198e9dd-a56f-0000-8000-000000000001',
  ]) {
    await assert.rejects(
      projector.project(eventId),
      /eventId must be a canonical lowercase UUID/,
    );
  }
  assert.equal(connections, 0);
});
