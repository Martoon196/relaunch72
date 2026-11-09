import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import {
  PgPropertyPredatorJourneyRuntime,
  assertPgPropertyPredatorJourneyRuntimeReady,
} from '../src/integrations/external-events/index.js';

const WORKSPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EVENT_ID = '0198e9dd-a56f-7000-8000-000000000001';

const READY_ROW = Object.freeze({
  database_user: 'r72_webhook',
  projector_exists: true,
  projector_executable: true,
  projector_owned_by_definer: true,
  projector_security_definer: true,
  projector_fixed_search_path: true,
  readiness_exists: true,
  readiness_executable: true,
  readiness_owned_by_definer: true,
  readiness_security_definer: true,
  readiness_fixed_search_path: true,
  workspace_blueprints_ready: true,
  runtime_tables_exist: true,
  no_runtime_table_privileges: true,
});

const PROJECTED_ROW = Object.freeze({
  disposition: 'projected',
  replayed: false,
  enrollments_started: 1,
  milestones_achieved: 1,
  score_snapshots_written: 1,
  consent_facts_written: 0,
  commerce_facts_written: 0,
});

function mockPool(rows: unknown[]) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const releases: boolean[] = [];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] });
      if (text.startsWith('BEGIN') || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes("set_config('app.user_id'")) return { rows: [{}] };
      return { rows };
    },
    release: (destroy?: boolean) => releases.push(destroy === true),
  } as unknown as PoolClient;
  return {
    pool: { connect: async () => client } as Pick<Pool, 'connect'>,
    calls,
    releases,
  };
}

test('journey readiness proves the exact definer and table-blind webhook role', async () => {
  const mocked = mockPool([READY_ROW]);

  await assert.doesNotReject(
    assertPgPropertyPredatorJourneyRuntimeReady(mocked.pool, WORKSPACE_ID),
  );
  const readiness = mocked.calls.find((call) => call.text.includes('journey-runtime-readiness'))!;
  const sql = readiness.text;
  assert.match(sql, /project_property_predator_journey_event\(uuid\)/);
  assert.match(sql, /property_predator_journey_runtime_ready\(\)/);
  assert.match(sql, /owner_name = 'r72_journey_projector_definer'/);
  assert.match(sql, /projector\.prosecdef IS TRUE/);
  assert.match(sql, /readiness\.prosecdef IS TRUE/);
  assert.match(sql, /search_path=pg_catalog/);
  for (const relation of [
    'app_private.external_event_shadow_receipts',
    'app_private.external_event_journey_projection_receipts',
    'app.contacts',
    'app.contact_points',
    'app.contact_source_identities',
    'app.lead_score_models',
    'app.lead_score_model_versions',
    'app.conversion_journeys',
    'app.conversion_journey_versions',
    'app.conversion_journey_milestones',
    'app.conversion_journey_triggers',
    'app.conversion_enrollments',
    'app.communication_consent_events',
    'app.communication_suppression_events',
    'app.conversion_commerce_facts',
    'app.conversion_milestone_facts',
    'app.lead_score_snapshots',
    'app.outbox_events',
  ]) assert.ok(sql.includes(`'${relation}'`));
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
    assert.ok(sql.includes(`relation.oid, '${privilege}'`));
  }
  assert.match(mocked.calls[0]!.text, /READ ONLY$/);
  assert.deepEqual(mocked.calls[1]!.values, [
    '', WORKSPACE_ID, 'webhook', 'property-predator-journey-readiness',
  ]);
  assert.equal(mocked.calls.at(-1)!.text, 'COMMIT');
});

test('journey readiness fails closed on every unsafe proof', async () => {
  for (const key of Object.keys(READY_ROW)) {
    const row = { ...READY_ROW, [key]: key === 'database_user' ? 'r72_owner' : false };
    const mocked = mockPool([row]);
    await assert.rejects(
      assertPgPropertyPredatorJourneyRuntimeReady(mocked.pool, WORKSPACE_ID),
      /journey runtime is not ready/,
    );
    assert.equal(mocked.calls.at(-1)!.text, 'ROLLBACK');
  }
  const mocked = mockPool([READY_ROW, READY_ROW]);
  await assert.rejects(
    assertPgPropertyPredatorJourneyRuntimeReady(mocked.pool, WORKSPACE_ID),
    /not ready/,
  );
});

test('journey projection forwards only the event ID and maps bounded counts', async () => {
  const mocked = mockPool([PROJECTED_ROW]);
  const runtime = new PgPropertyPredatorJourneyRuntime({
    webhookPool: mocked.pool,
    workspaceId: WORKSPACE_ID,
  });

  const result = await runtime.project(EVENT_ID);

  assert.deepEqual(result, {
    disposition: 'projected',
    replayed: false,
    enrollmentsStarted: 1,
    milestonesAchieved: 1,
    scoreSnapshotsWritten: 1,
    consentFactsWritten: 0,
    commerceFactsWritten: 0,
  });
  assert.ok(Object.isFrozen(result));
  const domain = mocked.calls.find((call) => call.text.includes('project_property_predator_journey_event'))!;
  assert.deepEqual(domain.values, [EVENT_ID]);
  assert.match(mocked.calls[0]!.text, /^BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE$/);
  assert.deepEqual(mocked.calls[1]!.values, [
    '', WORKSPACE_ID, 'webhook', `property-predator-journey:${EVENT_ID}`,
  ]);
  assert.equal(mocked.calls.at(-1)!.text, 'COMMIT');
  assert.deepEqual(mocked.releases, [false]);
});

test('journey projection accepts canonical string counts on replay', async () => {
  const mocked = mockPool([{
    ...PROJECTED_ROW,
    replayed: true,
    enrollments_started: '0',
    milestones_achieved: '0',
    score_snapshots_written: '0',
  }]);
  const runtime = new PgPropertyPredatorJourneyRuntime({
    webhookPool: mocked.pool,
    workspaceId: WORKSPACE_ID,
  });
  const result = await runtime.project(EVENT_ID);
  assert.equal(result.replayed, true);
  assert.equal(result.enrollmentsStarted, 0);
});

test('malformed journey rows roll back instead of exposing partial success', async () => {
  for (const rows of [
    [],
    [PROJECTED_ROW, PROJECTED_ROW],
    [{ ...PROJECTED_ROW, disposition: 'ignored' }],
    [{ ...PROJECTED_ROW, replayed: 'false' }],
    [{ ...PROJECTED_ROW, enrollments_started: -1 }],
    [{ ...PROJECTED_ROW, commerce_facts_written: '01' }],
    [{ ...PROJECTED_ROW, contact_id: WORKSPACE_ID }],
  ]) {
    const mocked = mockPool(rows);
    const runtime = new PgPropertyPredatorJourneyRuntime({
      webhookPool: mocked.pool,
      workspaceId: WORKSPACE_ID,
    });
    await assert.rejects(runtime.project(EVENT_ID), /Journey projector returned invalid/);
    assert.equal(mocked.calls.at(-1)!.text, 'ROLLBACK');
  }
});

test('malformed trusted IDs fail before acquiring a connection', async () => {
  let connections = 0;
  const pool = {
    connect: async () => {
      connections += 1;
      throw new Error('must not connect');
    },
  } as unknown as Pick<Pool, 'connect'>;
  assert.throws(() => new PgPropertyPredatorJourneyRuntime({
    webhookPool: pool,
    workspaceId: WORKSPACE_ID.toUpperCase(),
  }), /canonical lowercase UUID/);
  const runtime = new PgPropertyPredatorJourneyRuntime({ webhookPool: pool, workspaceId: WORKSPACE_ID });
  await assert.rejects(runtime.project(EVENT_ID.toUpperCase()), /canonical lowercase UUID/);
  await assert.rejects(
    assertPgPropertyPredatorJourneyRuntimeReady(pool, WORKSPACE_ID.toUpperCase()),
    /canonical lowercase UUID/,
  );
  assert.equal(connections, 0);
});
