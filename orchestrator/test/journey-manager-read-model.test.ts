import assert from 'node:assert/strict';
import test from 'node:test';
import type { CrmTransactionRunner, SqlExecutor } from '../src/crm-pg/types.js';
import {
  JourneyManagerReadDataError,
  JourneyManagerReadService,
} from '../src/conversion-pg/journey-manager.js';
import { journeySettingsDocument, scoreModelDocument } from '../src/conversion-pg/commands.js';
import { PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS } from '../src/conversion-pg/property-predator-blueprints.js';
import type { DatabaseRequestContext } from '../src/db/rls.js';

const context: DatabaseRequestContext = Object.freeze({
  actorKind: 'user',
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  requestId: 'journey-manager-read',
});

const SCORE_VERSION_ID = '11111111-1111-4111-8111-111111111111';
const SELF_VERSION_ID = '22222222-2222-4222-8222-222222222222';
const AGENCY_VERSION_ID = '33333333-3333-4333-8333-333333333333';
const SNAPSHOT_AT = '2026-08-25T12:34:56.000Z';

interface Fixtures {
  membership?: readonly Record<string, unknown>[];
  score?: readonly Record<string, unknown>[];
  routes?: readonly Record<string, unknown>[];
  milestones?: readonly Record<string, unknown>[];
  triggers?: readonly Record<string, unknown>[];
}

function runner(fixtures: Fixtures): CrmTransactionRunner {
  return {
    async run<T>(received: DatabaseRequestContext, operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
      assert.equal(received, context);
      const transaction: SqlExecutor = {
        async query<TRow extends Record<string, unknown>>(sql: string) {
          const selected = sql.includes('journey-manager.membership') ? (fixtures.membership ?? [])
            : sql.includes('journey-manager.score-model') ? (fixtures.score ?? [])
              : sql.includes('journey-manager.routes') ? (fixtures.routes ?? [])
                : sql.includes('journey-manager.milestones') ? (fixtures.milestones ?? [])
                  : sql.includes('journey-manager.triggers') ? (fixtures.triggers ?? [])
                    : assert.fail(`unexpected SQL: ${sql}`);
          return { rows: [...selected] as TRow[], rowCount: selected.length };
        },
      };
      return operation(transaction);
    },
  };
}

function membership(canManage = true): readonly Record<string, unknown>[] {
  return [{ snapshot_at: SNAPSHOT_AT, can_manage: canManage }];
}

function readyFixtures(): Fixtures {
  const [selfServe, agency] = PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS;
  const score = selfServe!.scoreModel;
  const routeRows = [
    { expected: agency!, versionId: AGENCY_VERSION_ID },
    { expected: selfServe!, versionId: SELF_VERSION_ID },
  ].map(({ expected, versionId }) => ({
    journey_slug: expected.slug,
    status: 'active',
    active_version_id: versionId,
    active_version: expected.version,
    score_model_version_id: SCORE_VERSION_ID,
    settings: journeySettingsDocument(expected),
    definition_hash: expected.definitionHash,
    published_at: '2026-08-24T10:00:00.000Z',
  }));
  const milestoneRows = PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS.flatMap((route) => route.milestones.map((milestone) => ({
    journey_slug: route.slug,
    milestone_key: milestone.key,
    name: milestone.name,
    position: milestone.position,
    semantic: milestone.semantic,
    is_completion: milestone.isCompletion,
  })));
  const triggerRows = PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS.flatMap((route) => route.triggers.map((trigger) => ({
    journey_slug: route.slug,
    trigger_kind: trigger.kind,
    source_key: trigger.sourceKey,
    milestone_key: trigger.milestoneKey,
  })));
  return {
    membership: membership(),
    score: [{
      status: 'active',
      active_version_id: SCORE_VERSION_ID,
      active_version: score.version,
      definition: scoreModelDocument(selfServe!),
      definition_hash: score.definitionHash,
      published_at: '2026-08-24T10:00:00.000Z',
    }],
    routes: routeRows,
    milestones: milestoneRows,
    triggers: triggerRows,
  };
}

test('Journey Manager reports an untouched workspace without mutating it', async () => {
  const service = new JourneyManagerReadService({ transactionRunner: runner({
    membership: membership(false),
  }) });

  const snapshot = await service.load(context);

  assert.equal(snapshot.snapshotAt, SNAPSHOT_AT);
  assert.equal(snapshot.canManage, false);
  assert.equal(snapshot.foundationState, 'not_installed');
  assert.equal(snapshot.runtimeReady, false);
  assert.deepEqual(snapshot.routes.map((route) => route.publication), ['missing', 'missing']);
  assert.equal(snapshot.scoreModel.publication, 'missing');
  assert.equal(snapshot.scoreModel.maxScore, 100);
  assert.deepEqual(snapshot.safety, {
    definitionsOnly: true,
    sendsMessages: false,
    publishesSocialPosts: false,
    triggersProviders: false,
  });
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.routes));
});

test('Journey Manager proves the exact shared score and both published runtime routes', async () => {
  const service = new JourneyManagerReadService({ transactionRunner: runner(readyFixtures()) });

  const snapshot = await service.load(context);

  assert.equal(snapshot.foundationState, 'ready');
  assert.equal(snapshot.runtimeReady, true);
  assert.equal(snapshot.scoreModel.publication, 'published');
  assert.equal(snapshot.scoreModel.version, 2);
  assert.deepEqual(snapshot.routes.map((route) => [route.slug, route.publication, route.runtimeReady]), [
    ['property-predator-self-serve', 'published', true],
    ['property-predator-agency-laps', 'published', true],
  ]);
  assert.deepEqual(snapshot.routes[0]?.milestones.map((milestone) => milestone.name), [
    'Lead', 'Activated', 'Priced', 'Sale',
  ]);
  assert.deepEqual(snapshot.routes[1]?.triggers.map((trigger) => trigger.sourceKey), [
    'sales.appointment.booked', 'sales.presentation.completed', 'payment_collected',
  ]);
  assert.equal(snapshot.scoreModel.components.reduce((sum, component) => sum + component.maxPoints, 0), 100);
  assert.deepEqual(snapshot.scoreModel.bands.map((band) => band.name), ['Quiet', 'Warm', 'Hot', 'Burning']);
});

test('Journey Manager closes runtime readiness when stored topology drifts', async () => {
  const fixtures = readyFixtures();
  fixtures.triggers = fixtures.triggers?.filter((row) => row.source_key !== 'offer.presented');
  const service = new JourneyManagerReadService({ transactionRunner: runner(fixtures) });

  const snapshot = await service.load(context);

  assert.equal(snapshot.foundationState, 'action_required');
  assert.equal(snapshot.runtimeReady, false);
  assert.equal(snapshot.routes[0]?.publication, 'conflict');
  assert.equal(snapshot.routes[0]?.runtimeReady, false);
  assert.equal(snapshot.routes[1]?.runtimeReady, true);
});

test('Journey Manager distrusts stored score/settings bytes even when their digest column looks expected', async () => {
  const fixtures = readyFixtures();
  fixtures.score = fixtures.score?.map((row) => ({
    ...row,
    definition: { ...(row.definition as Record<string, unknown>), name: 'Tampered score bytes' },
  }));
  fixtures.routes = fixtures.routes?.map((row) => row.journey_slug === 'property-predator-agency-laps'
    ? { ...row, settings: { ...(row.settings as Record<string, unknown>), mappingMode: 'tampered' } }
    : row);
  const service = new JourneyManagerReadService({ transactionRunner: runner(fixtures) });

  const snapshot = await service.load(context);

  assert.equal(snapshot.runtimeReady, false);
  assert.equal(snapshot.scoreModel.publication, 'conflict');
  assert.equal(snapshot.routes[1]?.publication, 'conflict');
});

test('Journey Manager identifies an older active route as outdated', async () => {
  const fixtures = readyFixtures();
  fixtures.routes = fixtures.routes?.map((row) => row.journey_slug === 'property-predator-self-serve'
    ? { ...row, active_version: 1 }
    : row);
  const service = new JourneyManagerReadService({ transactionRunner: runner(fixtures) });

  const snapshot = await service.load(context);

  assert.equal(snapshot.routes[0]?.publication, 'outdated');
  assert.equal(snapshot.foundationState, 'action_required');
});

test('Journey Manager rejects missing membership and non-user contexts', async () => {
  const service = new JourneyManagerReadService({ transactionRunner: runner({}) });
  await assert.rejects(service.load(context), JourneyManagerReadDataError);
  await assert.rejects(service.load({
    actorKind: 'worker',
    workspaceId: context.workspaceId,
    requestId: 'worker-read',
  }), /authenticated user context/);
});
