import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseRequestContext } from '../src/db/rls.js';
import {
  ConversionBlueprintActivationConflictError,
  ConversionBlueprintVersionConflictError,
  ConversionBlueprintIntegrityError,
  ConversionCommandService,
  ConversionPgRepository,
  InvalidConversionCommandContextError,
  InvalidPublishedConversionBlueprintError,
  PROPERTY_PREDATOR_SELF_SERVE_JOURNEY,
  type ConversionBlueprintRepository,
  type ConversionDefinitionVersionRecord,
  type ConversionJourneyVersionRecord,
  type ConversionSqlExecutor,
  type ConversionSqlResult,
  type ConversionTransactionRunner,
  type StoredConversionMilestone,
  type StoredConversionTrigger,
} from '../src/conversion-pg/index.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SCORE_MODEL_ID = '33333333-3333-4333-8333-333333333333';
const JOURNEY_ID = '44444444-4444-4444-8444-444444444444';
const SCORE_VERSION_ID = '55555555-5555-4555-8555-555555555555';
const JOURNEY_VERSION_ID = '66666666-6666-4666-8666-666666666666';

function context(): DatabaseRequestContext {
  return {
    actorKind: 'user',
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    requestId: 'publish-property-predator-v1',
  };
}

function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-${String(next).padStart(12, '0')}`;
  };
}

function canonicalScoreDocument(): Readonly<Record<string, unknown>> {
  const blueprint = PROPERTY_PREDATOR_SELF_SERVE_JOURNEY;
  return {
    schemaVersion: blueprint.schemaVersion,
    slug: blueprint.scoreModel.slug,
    name: blueprint.scoreModel.name,
    version: blueprint.scoreModel.version,
    components: blueprint.scoreModel.components,
    bands: blueprint.scoreModel.bands,
    rules: blueprint.scoreModel.rules,
  };
}

function canonicalJourneySettings(): Readonly<Record<string, unknown>> {
  const blueprint = PROPERTY_PREDATOR_SELF_SERVE_JOURNEY;
  return {
    schemaVersion: blueprint.schemaVersion,
    mappingMode: 'direct',
    mappingFrequency: 'once_per_enrollment',
    scoreModelDefinitionHash: blueprint.scoreModel.definitionHash,
  };
}

class RecordingRunner implements ConversionTransactionRunner {
  runs = 0;
  readonly contexts: DatabaseRequestContext[] = [];
  readonly transaction: ConversionSqlExecutor = {
    async query<TRow extends Record<string, unknown>>(): Promise<ConversionSqlResult<TRow>> {
      throw new Error('Mock repository service test must not issue SQL directly');
    },
  };

  async run<T>(
    requestContext: DatabaseRequestContext,
    operation: (transaction: ConversionSqlExecutor) => Promise<T>,
  ): Promise<T> {
    this.runs += 1;
    this.contexts.push(requestContext);
    return operation(this.transaction);
  }
}

function recordingRepository(input: {
  scoreLatestPublishedVersionNumber?: number | null;
  journeyLatestPublishedVersionNumber?: number | null;
  scoreVersion?: ConversionDefinitionVersionRecord | null;
  journeyVersion?: ConversionJourneyVersionRecord | null;
  milestones?: readonly StoredConversionMilestone[];
  triggers?: readonly StoredConversionTrigger[];
} = {}): { repository: ConversionBlueprintRepository; calls: Array<{ name: string; input?: unknown }> } {
  const calls: Array<{ name: string; input?: unknown }> = [];
  const record = (name: string, value?: unknown) => calls.push({ name, input: value });
  return {
    calls,
    repository: {
      async insertScoreModelIfMissing(value) { record('insertScoreModelIfMissing', value); },
      async lockScoreModelBySlug(value) {
        record('lockScoreModelBySlug', value);
        return {
          id: SCORE_MODEL_ID,
          latestPublishedVersionNumber: input.scoreLatestPublishedVersionNumber ?? null,
        };
      },
      async findScoreModelVersion(modelId, version) {
        record('findScoreModelVersion', { modelId, version });
        return input.scoreVersion ?? null;
      },
      async insertScoreModelVersion(value) { record('insertScoreModelVersion', value); },
      async insertJourneyIfMissing(value) { record('insertJourneyIfMissing', value); },
      async lockJourneyBySlug(value) {
        record('lockJourneyBySlug', value);
        return {
          id: JOURNEY_ID,
          latestPublishedVersionNumber: input.journeyLatestPublishedVersionNumber ?? null,
        };
      },
      async findJourneyVersion(journeyId, version) {
        record('findJourneyVersion', { journeyId, version });
        return input.journeyVersion ?? null;
      },
      async insertJourneyVersion(value) { record('insertJourneyVersion', value); },
      async insertMilestone(value) { record('insertMilestone', value); },
      async insertTrigger(value) { record('insertTrigger', value); },
      async listMilestones(journeyVersionId) {
        record('listMilestones', journeyVersionId);
        return input.milestones ?? [];
      },
      async listTriggers(journeyVersionId) {
        record('listTriggers', journeyVersionId);
        return input.triggers ?? [];
      },
      async activateScoreModel(value) { record('activateScoreModel', value); },
      async activateJourney(value) { record('activateJourney', value); },
    },
  };
}

test('publishBlueprint uses one transaction and maps immutable child IDs before manager-gated activation', async () => {
  const runner = new RecordingRunner();
  const { repository, calls } = recordingRepository();
  const service = new ConversionCommandService({
    transactionRunner: runner,
    repositoryFactory: () => repository,
    nextId: ids(),
  });

  const result = await service.publishBlueprint(context(), PROPERTY_PREDATOR_SELF_SERVE_JOURNEY);

  assert.equal(runner.runs, 1);
  assert.equal(result.disposition, 'applied');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.milestoneIds), true);
  assert.equal(Object.isFrozen(result.triggerIds), true);
  assert.deepEqual(calls.map((call) => call.name), [
    'insertScoreModelIfMissing',
    'lockScoreModelBySlug',
    'findScoreModelVersion',
    'insertScoreModelVersion',
    'insertJourneyIfMissing',
    'lockJourneyBySlug',
    'findJourneyVersion',
    'insertJourneyVersion',
    ...PROPERTY_PREDATOR_SELF_SERVE_JOURNEY.milestones.map(() => 'insertMilestone'),
    ...PROPERTY_PREDATOR_SELF_SERVE_JOURNEY.triggers.map(() => 'insertTrigger'),
    'activateScoreModel',
    'activateJourney',
  ]);

  const milestoneCalls = calls.filter((call) => call.name === 'insertMilestone');
  const triggerCalls = calls.filter((call) => call.name === 'insertTrigger');
  for (const [index, trigger] of PROPERTY_PREDATOR_SELF_SERVE_JOURNEY.triggers.entries()) {
    const insertedTrigger = triggerCalls[index]!.input as { milestoneId: string };
    assert.equal(insertedTrigger.milestoneId, result.milestoneIds[trigger.milestoneKey]);
  }
  assert.equal(milestoneCalls.length, Object.keys(result.milestoneIds).length);
  assert.equal(calls.some((call) => /outbox|provider/i.test(call.name)), false);
});

test('same score-model version with a different digest fails before journey writes or activation', async () => {
  const runner = new RecordingRunner();
  const { repository, calls } = recordingRepository({
    scoreVersion: { id: SCORE_VERSION_ID, definition: {}, definitionHash: Buffer.alloc(32, 9) },
  });
  const service = new ConversionCommandService({
    transactionRunner: runner,
    repositoryFactory: () => repository,
  });

  await assert.rejects(
    service.publishBlueprint(context(), PROPERTY_PREDATOR_SELF_SERVE_JOURNEY),
    (error: unknown) => error instanceof ConversionBlueprintVersionConflictError
      && error.code === 'conversion_blueprint_version_conflict',
  );
  assert.deepEqual(calls.map((call) => call.name), [
    'insertScoreModelIfMissing', 'lockScoreModelBySlug', 'findScoreModelVersion',
  ]);
});

test('publisher returns a typed conflict instead of reactivating an older score-model version', async () => {
  const runner = new RecordingRunner();
  const { repository, calls } = recordingRepository({ scoreLatestPublishedVersionNumber: 2 });
  const service = new ConversionCommandService({
    transactionRunner: runner,
    repositoryFactory: () => repository,
  });

  await assert.rejects(
    service.publishBlueprint(context(), PROPERTY_PREDATOR_SELF_SERVE_JOURNEY),
    (error: unknown) => error instanceof ConversionBlueprintActivationConflictError
      && error.code === 'conversion_blueprint_activation_conflict'
      && /version 1; version 2 has already been published/.test(error.message),
  );
  assert.deepEqual(calls.map((call) => call.name), [
    'insertScoreModelIfMissing', 'lockScoreModelBySlug',
  ]);
});

test('publisher returns a typed conflict instead of reactivating an older journey version', async () => {
  const runner = new RecordingRunner();
  const blueprint = PROPERTY_PREDATOR_SELF_SERVE_JOURNEY;
  const { repository, calls } = recordingRepository({
    scoreVersion: {
      id: SCORE_VERSION_ID,
      definition: canonicalScoreDocument(),
      definitionHash: Buffer.from(blueprint.scoreModel.definitionHash, 'hex'),
    },
    journeyLatestPublishedVersionNumber: 2,
  });
  const service = new ConversionCommandService({
    transactionRunner: runner,
    repositoryFactory: () => repository,
  });

  await assert.rejects(
    service.publishBlueprint(context(), blueprint),
    (error: unknown) => error instanceof ConversionBlueprintActivationConflictError
      && error.code === 'conversion_blueprint_activation_conflict'
      && /version 1; version 2 has already been published/.test(error.message),
  );
  assert.deepEqual(calls.map((call) => call.name), [
    'insertScoreModelIfMissing', 'lockScoreModelBySlug', 'findScoreModelVersion',
    'insertJourneyIfMissing', 'lockJourneyBySlug',
  ]);
});

test('replay rejects a stored score document that does not match its claimed canonical digest', async () => {
  const runner = new RecordingRunner();
  const blueprint = PROPERTY_PREDATOR_SELF_SERVE_JOURNEY;
  const { repository, calls } = recordingRepository({
    scoreVersion: {
      id: SCORE_VERSION_ID,
      definition: { tampered: true },
      definitionHash: Buffer.from(blueprint.scoreModel.definitionHash, 'hex'),
    },
  });
  const service = new ConversionCommandService({
    transactionRunner: runner,
    repositoryFactory: () => repository,
  });

  await assert.rejects(
    service.publishBlueprint(context(), blueprint),
    (error: unknown) => error instanceof ConversionBlueprintIntegrityError
      && /score model definition/.test(error.message),
  );
  assert.equal(calls.some((call) => call.name.startsWith('insertJourney')), false);
  assert.equal(calls.some((call) => call.name.startsWith('activate')), false);
});

test('same journey version with a different digest fails before child reads or activation', async () => {
  const runner = new RecordingRunner();
  const blueprint = PROPERTY_PREDATOR_SELF_SERVE_JOURNEY;
  const { repository, calls } = recordingRepository({
    scoreVersion: {
      id: SCORE_VERSION_ID,
      definition: canonicalScoreDocument(),
      definitionHash: Buffer.from(blueprint.scoreModel.definitionHash, 'hex'),
    },
    journeyVersion: {
      id: JOURNEY_VERSION_ID,
      scoreModelVersionId: SCORE_VERSION_ID,
      settings: canonicalJourneySettings(),
      definitionHash: Buffer.alloc(32, 7),
    },
  });
  const service = new ConversionCommandService({
    transactionRunner: runner,
    repositoryFactory: () => repository,
  });

  await assert.rejects(
    service.publishBlueprint(context(), blueprint),
    ConversionBlueprintVersionConflictError,
  );
  assert.equal(calls.some((call) => call.name === 'listMilestones'), false);
  assert.equal(calls.some((call) => call.name.startsWith('activate')), false);
});

test('replay rejects stored journey settings that do not match their claimed digest', async () => {
  const runner = new RecordingRunner();
  const blueprint = PROPERTY_PREDATOR_SELF_SERVE_JOURNEY;
  const { repository, calls } = recordingRepository({
    scoreVersion: {
      id: SCORE_VERSION_ID,
      definition: canonicalScoreDocument(),
      definitionHash: Buffer.from(blueprint.scoreModel.definitionHash, 'hex'),
    },
    journeyVersion: {
      id: JOURNEY_VERSION_ID,
      scoreModelVersionId: SCORE_VERSION_ID,
      settings: { ...canonicalJourneySettings(), mappingMode: 'indirect' },
      definitionHash: Buffer.from(blueprint.definitionHash, 'hex'),
    },
  });
  const service = new ConversionCommandService({
    transactionRunner: runner,
    repositoryFactory: () => repository,
  });

  await assert.rejects(
    service.publishBlueprint(context(), blueprint),
    (error: unknown) => error instanceof ConversionBlueprintIntegrityError
      && /journey settings/.test(error.message),
  );
  assert.equal(calls.some((call) => call.name === 'listMilestones'), false);
  assert.equal(calls.some((call) => call.name.startsWith('activate')), false);
});

test('only an already-defined frozen blueprint and authenticated user can open publishing transaction', async () => {
  const runner = new RecordingRunner();
  const { repository } = recordingRepository();
  const service = new ConversionCommandService({
    transactionRunner: runner,
    repositoryFactory: () => repository,
  });

  await assert.rejects(
    service.publishBlueprint(
      { actorKind: 'worker', workspaceId: WORKSPACE_ID, requestId: 'worker-publish' },
      PROPERTY_PREDATOR_SELF_SERVE_JOURNEY,
    ),
    InvalidConversionCommandContextError,
  );
  await assert.rejects(
    service.publishBlueprint(
      context(),
      { ...PROPERTY_PREDATOR_SELF_SERVE_JOURNEY } as typeof PROPERTY_PREDATOR_SELF_SERVE_JOURNEY,
    ),
    InvalidPublishedConversionBlueprintError,
  );
  assert.equal(runner.runs, 0);
});

interface SqlCall {
  readonly marker: string;
  readonly sql: string;
  readonly values: readonly unknown[];
}

function marker(sql: string): string {
  return /\/\*\s*([^*]+?)\s*\*\//.exec(sql)?.[1] ?? '';
}

class StatefulPublisherSql implements ConversionSqlExecutor {
  readonly calls: SqlCall[] = [];
  scoreModelId: string | null = null;
  journeyId: string | null = null;
  scoreVersion: ConversionDefinitionVersionRecord | null = null;
  journeyVersion: ConversionJourneyVersionRecord | null = null;
  readonly milestones: StoredConversionMilestone[] = [];
  readonly triggers: StoredConversionTrigger[] = [];

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<ConversionSqlResult<TRow>> {
    const queryMarker = marker(sql);
    this.calls.push({ marker: queryMarker, sql, values });
    let rows: Record<string, unknown>[] = [];
    switch (queryMarker) {
      case 'conversion.insert-score-model-if-missing':
        this.scoreModelId ??= String(values[0]);
        break;
      case 'conversion.lock-score-model':
        rows = this.scoreModelId ? [{ id: this.scoreModelId, latestPublishedVersionNumber: null }] : [];
        break;
      case 'conversion.find-score-model-version':
        rows = this.scoreVersion ? [{ ...this.scoreVersion }] : [];
        break;
      case 'conversion.insert-score-model-version':
        this.scoreVersion = {
          id: String(values[0]),
          definition: JSON.parse(String(values[3])) as unknown,
          definitionHash: values[4] as Uint8Array,
        };
        rows = [{ id: this.scoreVersion.id }];
        break;
      case 'conversion.insert-journey-if-missing':
        this.journeyId ??= String(values[0]);
        break;
      case 'conversion.lock-journey':
        rows = this.journeyId ? [{ id: this.journeyId, latestPublishedVersionNumber: null }] : [];
        break;
      case 'conversion.find-journey-version':
        rows = this.journeyVersion ? [{ ...this.journeyVersion }] : [];
        break;
      case 'conversion.insert-journey-version':
        this.journeyVersion = {
          id: String(values[0]),
          scoreModelVersionId: String(values[3]),
          settings: JSON.parse(String(values[4])) as unknown,
          definitionHash: values[5] as Uint8Array,
        };
        rows = [{ id: this.journeyVersion.id }];
        break;
      case 'conversion.insert-milestone': {
        const stored: StoredConversionMilestone = {
          id: String(values[0]),
          key: String(values[2]),
          name: String(values[3]),
          position: Number(values[4]),
          semantic: values[5] as StoredConversionMilestone['semantic'],
          isCompletion: Boolean(values[6]),
        };
        this.milestones.push(stored);
        rows = [{ id: stored.id }];
        break;
      }
      case 'conversion.insert-trigger': {
        const milestone = this.milestones.find((candidate) => candidate.id === values[2]);
        assert.ok(milestone);
        const stored: StoredConversionTrigger = {
          id: String(values[0]),
          milestoneId: String(values[2]),
          kind: values[3] as StoredConversionTrigger['kind'],
          sourceKey: String(values[4]),
          milestoneKey: milestone.key,
        };
        this.triggers.push(stored);
        rows = [{ id: stored.id }];
        break;
      }
      case 'conversion.list-milestones':
        rows = this.milestones.map((stored) => ({ ...stored }));
        break;
      case 'conversion.list-triggers':
        rows = this.triggers.map((stored) => ({ ...stored }));
        break;
      case 'conversion.activate-score-model':
        rows = this.scoreModelId ? [{ id: this.scoreModelId }] : [];
        break;
      case 'conversion.activate-journey':
        rows = this.journeyId ? [{ id: this.journeyId }] : [];
        break;
      default:
        throw new Error(`Unexpected SQL marker ${queryMarker}`);
    }
    return { rows: rows as TRow[], rowCount: rows.length };
  }
}

test('real repository SQL publishes once, then exact replay returns every existing ID without child reinserts', async () => {
  const sql = new StatefulPublisherSql();
  let transactions = 0;
  const transactionRunner: ConversionTransactionRunner = {
    async run<T>(
      _context: DatabaseRequestContext,
      operation: (transaction: ConversionSqlExecutor) => Promise<T>,
    ): Promise<T> {
      transactions += 1;
      return operation(sql);
    },
  };
  const service = new ConversionCommandService({ transactionRunner, nextId: ids() });

  const first = await service.publishBlueprint(context(), PROPERTY_PREDATOR_SELF_SERVE_JOURNEY);
  const replayStart = sql.calls.length;
  const replay = await service.publishBlueprint(context(), PROPERTY_PREDATOR_SELF_SERVE_JOURNEY);
  const replayCalls = sql.calls.slice(replayStart);

  assert.equal(transactions, 2);
  assert.equal(first.disposition, 'applied');
  assert.deepEqual(replay, { ...first, disposition: 'replayed' });
  assert.equal(replayCalls.some((call) => /insert-(?:score-model-version|journey-version|milestone|trigger)/.test(call.marker)), false);
  assert.deepEqual(replayCalls.map((call) => call.marker), [
    'conversion.insert-score-model-if-missing',
    'conversion.lock-score-model',
    'conversion.find-score-model-version',
    'conversion.insert-journey-if-missing',
    'conversion.lock-journey',
    'conversion.find-journey-version',
    'conversion.list-milestones',
    'conversion.list-triggers',
    'conversion.activate-score-model',
    'conversion.activate-journey',
  ]);

  for (const call of sql.calls) {
    assert.equal(call.values.includes(WORKSPACE_ID), false, `${call.marker} must not accept workspace as SQL input`);
  }
  for (const call of sql.calls.filter((candidate) => /insert-/.test(candidate.marker))) {
    assert.match(call.sql, /app_private\.current_workspace_id\(\)/);
  }
  assert.match(sql.calls.find((call) => call.marker === 'conversion.lock-score-model')!.sql, /FOR UPDATE/);
  assert.match(sql.calls.find((call) => call.marker === 'conversion.lock-journey')!.sql, /FOR UPDATE/);
  assert.doesNotMatch(sql.calls.find((call) => call.marker === 'conversion.find-score-model-version')!.sql, /FOR UPDATE/);
  assert.match(
    sql.calls.find((call) => call.marker === 'conversion.find-journey-version')!.sql,
    /app_private\.lock_conversion_journey_version\(\$1, \$2\)/,
  );
  assert.equal(sql.calls.some((call) => /outbox|provider/i.test(call.sql)), false);

  const scoreVersionInsert = sql.calls.find((call) => call.marker === 'conversion.insert-score-model-version');
  const storedScoreDefinition = JSON.parse(String(scoreVersionInsert!.values[3])) as {
    rules: Array<{ kind?: string; sourceKey: string }>;
  };
  assert.deepEqual(
    storedScoreDefinition.rules.map((rule) => [rule.kind, rule.sourceKey]),
    PROPERTY_PREDATOR_SELF_SERVE_JOURNEY.scoreModel.rules.map((rule) => [rule.kind, rule.sourceKey]),
    'immutable score definition preserves event|commerce namespace for every rule',
  );

  const mutableStatements = sql.calls.filter((call) => /^\s*UPDATE/im.test(call.sql));
  assert.ok(mutableStatements.every((call) => /app\.(?:lead_score_models|conversion_journeys)/.test(call.sql)));
  assert.equal(sql.calls.some((call) => /^\s*DELETE/im.test(call.sql)), false);
});

test('repository activation always executes an RLS-gated UPDATE even for exact replay', async () => {
  const sql = new StatefulPublisherSql();
  sql.scoreModelId = SCORE_MODEL_ID;
  sql.journeyId = JOURNEY_ID;
  const repository = new ConversionPgRepository(sql);

  await repository.activateScoreModel({
    modelId: SCORE_MODEL_ID,
    name: 'Property Predator Lead Score',
    versionId: SCORE_VERSION_ID,
  });
  await repository.activateJourney({
    journeyId: JOURNEY_ID,
    name: 'Property Predator Self-Serve Journey',
    description: 'Active journey',
    versionId: JOURNEY_VERSION_ID,
  });

  assert.deepEqual(sql.calls.map((call) => call.marker), [
    'conversion.activate-score-model', 'conversion.activate-journey',
  ]);
  assert.ok(sql.calls.every((call) => /^\s*\/\*[^]*?\*\/\s*UPDATE/im.test(call.sql)));
});
