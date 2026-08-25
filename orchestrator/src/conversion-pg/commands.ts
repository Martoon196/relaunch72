import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { defineConversionJourney } from './definition.js';
import {
  ConversionPgRepository,
  type ConversionBlueprintRepository,
  type ConversionSqlExecutor,
  type ConversionTransactionRunner,
  type StoredConversionMilestone,
  type StoredConversionTrigger,
} from './repository.js';
import {
  CONVERSION_JOURNEY_SCHEMA_VERSION,
  type ConversionJourneyDefinition,
  type ConversionJourneyDefinitionInput,
} from './types.js';

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export class InvalidConversionCommandContextError extends Error {
  readonly code = 'invalid_conversion_command_context';

  constructor() {
    super('Publishing a conversion blueprint requires an authenticated user context');
    this.name = 'InvalidConversionCommandContextError';
  }
}

export class InvalidPublishedConversionBlueprintError extends Error {
  readonly code = 'invalid_published_conversion_blueprint';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidPublishedConversionBlueprintError';
  }
}

export class ConversionBlueprintVersionConflictError extends Error {
  readonly code = 'conversion_blueprint_version_conflict';

  constructor(entity: 'score model' | 'journey', slug: string, version: number) {
    super(`Published ${entity} ${slug} version ${version} has a different immutable definition digest`);
    this.name = 'ConversionBlueprintVersionConflictError';
  }
}

export class ConversionBlueprintActivationConflictError extends Error {
  readonly code = 'conversion_blueprint_activation_conflict';

  constructor(
    entity: 'score model' | 'journey',
    slug: string,
    requestedVersion: number,
    activeVersion: number,
  ) {
    super(
      `Cannot activate ${entity} ${slug} version ${requestedVersion}; version ${activeVersion} has already been published`,
    );
    this.name = 'ConversionBlueprintActivationConflictError';
  }
}

export class ConversionBlueprintIntegrityError extends Error {
  readonly code = 'conversion_blueprint_integrity_error';

  constructor(message: string) {
    super(message);
    this.name = 'ConversionBlueprintIntegrityError';
  }
}

export interface PublishConversionBlueprintResult {
  readonly disposition: 'applied' | 'replayed';
  readonly scoreModelId: string;
  readonly scoreModelVersionId: string;
  readonly journeyId: string;
  readonly journeyVersionId: string;
  /** Existing database IDs keyed by the immutable milestone key. */
  readonly milestoneIds: Readonly<Record<string, string>>;
  /** Existing database IDs keyed by `event|commerce:sourceKey`. */
  readonly triggerIds: Readonly<Record<string, string>>;
}

export interface ConversionCommandDependencies {
  readonly transactionRunner: ConversionTransactionRunner;
  readonly repositoryFactory?: (transaction: ConversionSqlExecutor) => ConversionBlueprintRepository;
  readonly nextId?: () => string;
}

function assertAuthenticatedUserContext(context: DatabaseRequestContext): asserts context is DatabaseRequestContext & {
  actorKind: 'user';
  userId: string;
} {
  if (context.actorKind !== 'user' || !context.userId) {
    throw new InvalidConversionCommandContextError();
  }
  validateDatabaseContext(context);
}

function assertFrozen(value: unknown, path: string, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw new InvalidPublishedConversionBlueprintError(`${path} must not contain cycles`);
  seen.add(value);
  if (!Object.isFrozen(value)) {
    throw new InvalidPublishedConversionBlueprintError(`${path} must be frozen by defineConversionJourney`);
  }
  for (const [key, child] of Object.entries(value)) assertFrozen(child, `${path}.${key}`, seen);
}

function exactOutputKeys(value: object, expected: readonly string[], path: string): void {
  const actual = Object.keys(value);
  const expectedSet = new Set(expected);
  const unexpected = actual.find((key) => !expectedSet.has(key));
  const missing = expected.find((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (unexpected) throw new InvalidPublishedConversionBlueprintError(`${path} contains unknown field ${unexpected}`);
  if (missing) throw new InvalidPublishedConversionBlueprintError(`${path} is missing field ${missing}`);
}

function verifyDefinedBlueprint(blueprint: ConversionJourneyDefinition): ConversionJourneyDefinition {
  if (typeof blueprint !== 'object' || blueprint === null) {
    throw new InvalidPublishedConversionBlueprintError('blueprint must be a defined conversion journey');
  }
  assertFrozen(blueprint, 'blueprint');
  exactOutputKeys(
    blueprint,
    [
      'schemaVersion', 'slug', 'name', 'description', 'version',
      'milestones', 'triggers', 'scoreModel', 'definitionHash',
    ],
    'blueprint',
  );
  exactOutputKeys(
    blueprint.scoreModel,
    ['schemaVersion', 'slug', 'name', 'version', 'components', 'bands', 'rules', 'definitionHash'],
    'blueprint.scoreModel',
  );
  if (blueprint.schemaVersion !== CONVERSION_JOURNEY_SCHEMA_VERSION) {
    throw new InvalidPublishedConversionBlueprintError('blueprint schemaVersion is unsupported');
  }
  if (blueprint.scoreModel.schemaVersion !== CONVERSION_JOURNEY_SCHEMA_VERSION) {
    throw new InvalidPublishedConversionBlueprintError('blueprint score-model schemaVersion is unsupported');
  }
  if (!HASH_PATTERN.test(blueprint.definitionHash) || !HASH_PATTERN.test(blueprint.scoreModel.definitionHash)) {
    throw new InvalidPublishedConversionBlueprintError('blueprint definition hashes must be canonical SHA-256 hex');
  }

  const input: ConversionJourneyDefinitionInput = {
    slug: blueprint.slug,
    name: blueprint.name,
    description: blueprint.description,
    version: blueprint.version,
    milestones: blueprint.milestones,
    triggers: blueprint.triggers,
    scoreModel: {
      slug: blueprint.scoreModel.slug,
      name: blueprint.scoreModel.name,
      version: blueprint.scoreModel.version,
      components: blueprint.scoreModel.components,
      bands: blueprint.scoreModel.bands,
      rules: blueprint.scoreModel.rules,
    },
  };
  const verified = defineConversionJourney(input);
  if (verified.definitionHash !== blueprint.definitionHash
      || verified.scoreModel.definitionHash !== blueprint.scoreModel.definitionHash) {
    throw new InvalidPublishedConversionBlueprintError('blueprint definition hashes do not match its canonical content');
  }
  return verified;
}

function digest(hash: string): Uint8Array {
  return Buffer.from(hash, 'hex');
}

function digestMatches(stored: Uint8Array, expectedHex: string): boolean {
  const actual = Buffer.from(stored);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function scoreModelDocument(blueprint: ConversionJourneyDefinition): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: blueprint.schemaVersion,
    slug: blueprint.scoreModel.slug,
    name: blueprint.scoreModel.name,
    version: blueprint.scoreModel.version,
    components: blueprint.scoreModel.components,
    bands: blueprint.scoreModel.bands,
    rules: blueprint.scoreModel.rules,
  });
}

function journeySettingsDocument(blueprint: ConversionJourneyDefinition): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: blueprint.schemaVersion,
    mappingMode: 'direct',
    mappingFrequency: 'once_per_enrollment',
    scoreModelDefinitionHash: blueprint.scoreModel.definitionHash,
  });
}

function triggerIdentity(kind: string, sourceKey: string): string {
  return `${kind}:${sourceKey}`;
}

function freezeIdMap(entries: readonly (readonly [string, string])[]): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(entries));
}

function verifyStoredMilestones(
  blueprint: ConversionJourneyDefinition,
  stored: readonly StoredConversionMilestone[],
): Readonly<Record<string, string>> {
  if (stored.length !== blueprint.milestones.length) {
    throw new ConversionBlueprintIntegrityError('Stored journey milestone count does not match its immutable digest');
  }
  const byKey = new Map(stored.map((milestone) => [milestone.key, milestone]));
  if (byKey.size !== stored.length) {
    throw new ConversionBlueprintIntegrityError('Stored journey milestones contain duplicate keys');
  }
  const ids: Array<readonly [string, string]> = [];
  for (const expected of blueprint.milestones) {
    const actual = byKey.get(expected.key);
    if (!actual
      || actual.name !== expected.name
      || actual.position !== expected.position
      || actual.semantic !== expected.semantic
      || actual.isCompletion !== expected.isCompletion) {
      throw new ConversionBlueprintIntegrityError(`Stored milestone ${expected.key} does not match its immutable digest`);
    }
    ids.push([expected.key, actual.id]);
  }
  return freezeIdMap(ids);
}

function verifyStoredTriggers(
  blueprint: ConversionJourneyDefinition,
  stored: readonly StoredConversionTrigger[],
  milestoneIds: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (stored.length !== blueprint.triggers.length) {
    throw new ConversionBlueprintIntegrityError('Stored journey trigger count does not match its immutable digest');
  }
  const byIdentity = new Map(stored.map((trigger) => [triggerIdentity(trigger.kind, trigger.sourceKey), trigger]));
  if (byIdentity.size !== stored.length) {
    throw new ConversionBlueprintIntegrityError('Stored journey triggers contain duplicate source identities');
  }
  const ids: Array<readonly [string, string]> = [];
  for (const expected of blueprint.triggers) {
    const identity = triggerIdentity(expected.kind, expected.sourceKey);
    const actual = byIdentity.get(identity);
    if (!actual
      || actual.milestoneKey !== expected.milestoneKey
      || actual.milestoneId !== milestoneIds[expected.milestoneKey]) {
      throw new ConversionBlueprintIntegrityError(`Stored trigger ${identity} does not match its immutable digest`);
    }
    ids.push([identity, actual.id]);
  }
  return freezeIdMap(ids);
}

/** Publishes and activates one immutable journey/score blueprint atomically. */
export class ConversionCommandService {
  private readonly nextId: () => string;
  private readonly repositoryFactory: (transaction: ConversionSqlExecutor) => ConversionBlueprintRepository;

  constructor(private readonly dependencies: ConversionCommandDependencies) {
    this.nextId = dependencies.nextId ?? randomUUID;
    this.repositoryFactory = dependencies.repositoryFactory
      ?? ((transaction) => new ConversionPgRepository(transaction));
  }

  async publishBlueprint(
    context: DatabaseRequestContext,
    blueprint: ConversionJourneyDefinition,
  ): Promise<PublishConversionBlueprintResult> {
    assertAuthenticatedUserContext(context);
    const definition = verifyDefinedBlueprint(blueprint);

    return this.dependencies.transactionRunner.run(context, async (transaction) => {
      const repository = this.repositoryFactory(transaction);
      const userId = context.userId;
      let insertedVersion = false;

      await repository.insertScoreModelIfMissing({
        id: this.nextId(),
        slug: definition.scoreModel.slug,
        name: definition.scoreModel.name,
        createdByUserId: userId,
      });
      const scoreModel = await repository.lockScoreModelBySlug(definition.scoreModel.slug);
      if (!scoreModel) throw new ConversionBlueprintIntegrityError('Score model container disappeared after its claim');
      if (scoreModel.latestPublishedVersionNumber !== null
          && definition.scoreModel.version < scoreModel.latestPublishedVersionNumber) {
        throw new ConversionBlueprintActivationConflictError(
          'score model',
          definition.scoreModel.slug,
          definition.scoreModel.version,
          scoreModel.latestPublishedVersionNumber,
        );
      }

      const existingScoreVersion = await repository.findScoreModelVersion(
        scoreModel.id,
        definition.scoreModel.version,
      );
      const expectedScoreModelDocument = scoreModelDocument(definition);
      let scoreModelVersionId: string;
      if (existingScoreVersion) {
        if (!digestMatches(existingScoreVersion.definitionHash, definition.scoreModel.definitionHash)) {
          throw new ConversionBlueprintVersionConflictError(
            'score model',
            definition.scoreModel.slug,
            definition.scoreModel.version,
          );
        }
        if (!isDeepStrictEqual(existingScoreVersion.definition, expectedScoreModelDocument)) {
          throw new ConversionBlueprintIntegrityError(
            'Stored score model definition does not match its immutable digest',
          );
        }
        scoreModelVersionId = existingScoreVersion.id;
      } else {
        insertedVersion = true;
        scoreModelVersionId = this.nextId();
        await repository.insertScoreModelVersion({
          id: scoreModelVersionId,
          modelId: scoreModel.id,
          version: definition.scoreModel.version,
          definition: expectedScoreModelDocument,
          definitionHash: digest(definition.scoreModel.definitionHash),
          createdByUserId: userId,
        });
      }

      await repository.insertJourneyIfMissing({
        id: this.nextId(),
        slug: definition.slug,
        name: definition.name,
        description: definition.description,
        createdByUserId: userId,
      });
      const journey = await repository.lockJourneyBySlug(definition.slug);
      if (!journey) throw new ConversionBlueprintIntegrityError('Journey container disappeared after its claim');
      if (journey.latestPublishedVersionNumber !== null
          && definition.version < journey.latestPublishedVersionNumber) {
        throw new ConversionBlueprintActivationConflictError(
          'journey',
          definition.slug,
          definition.version,
          journey.latestPublishedVersionNumber,
        );
      }

      const existingJourneyVersion = await repository.findJourneyVersion(journey.id, definition.version);
      const expectedJourneySettings = journeySettingsDocument(definition);
      let journeyVersionId: string;
      let milestoneIds: Readonly<Record<string, string>>;
      let triggerIds: Readonly<Record<string, string>>;
      if (existingJourneyVersion) {
        if (!digestMatches(existingJourneyVersion.definitionHash, definition.definitionHash)) {
          throw new ConversionBlueprintVersionConflictError('journey', definition.slug, definition.version);
        }
        if (existingJourneyVersion.scoreModelVersionId !== scoreModelVersionId) {
          throw new ConversionBlueprintIntegrityError(
            'Stored journey version points at a different immutable score model version',
          );
        }
        if (!isDeepStrictEqual(existingJourneyVersion.settings, expectedJourneySettings)) {
          throw new ConversionBlueprintIntegrityError(
            'Stored journey settings do not match its immutable digest',
          );
        }
        journeyVersionId = existingJourneyVersion.id;
        milestoneIds = verifyStoredMilestones(
          definition,
          await repository.listMilestones(journeyVersionId),
        );
        triggerIds = verifyStoredTriggers(
          definition,
          await repository.listTriggers(journeyVersionId),
          milestoneIds,
        );
      } else {
        insertedVersion = true;
        journeyVersionId = this.nextId();
        await repository.insertJourneyVersion({
          id: journeyVersionId,
          journeyId: journey.id,
          version: definition.version,
          scoreModelVersionId,
          settings: expectedJourneySettings,
          definitionHash: digest(definition.definitionHash),
          createdByUserId: userId,
        });

        const milestoneEntries: Array<readonly [string, string]> = [];
        for (const milestone of definition.milestones) {
          const milestoneId = this.nextId();
          await repository.insertMilestone({
            id: milestoneId,
            journeyVersionId,
            key: milestone.key,
            name: milestone.name,
            position: milestone.position,
            semantic: milestone.semantic,
            isCompletion: milestone.isCompletion,
          });
          milestoneEntries.push([milestone.key, milestoneId]);
        }
        milestoneIds = freezeIdMap(milestoneEntries);

        const triggerEntries: Array<readonly [string, string]> = [];
        for (const trigger of definition.triggers) {
          const milestoneId = milestoneIds[trigger.milestoneKey];
          if (!milestoneId) {
            throw new ConversionBlueprintIntegrityError(`Trigger target ${trigger.milestoneKey} was not inserted`);
          }
          const triggerId = this.nextId();
          await repository.insertTrigger({
            id: triggerId,
            journeyVersionId,
            milestoneId,
            kind: trigger.kind,
            sourceKey: trigger.sourceKey,
          });
          triggerEntries.push([triggerIdentity(trigger.kind, trigger.sourceKey), triggerId]);
        }
        triggerIds = freezeIdMap(triggerEntries);
      }

      // Activation intentionally remains a normal table UPDATE. Migration 0014
      // RLS is the manager authority; this service does not duplicate or bypass it.
      await repository.activateScoreModel({
        modelId: scoreModel.id,
        name: definition.scoreModel.name,
        versionId: scoreModelVersionId,
      });
      await repository.activateJourney({
        journeyId: journey.id,
        name: definition.name,
        description: definition.description,
        versionId: journeyVersionId,
      });

      return Object.freeze({
        disposition: insertedVersion ? 'applied' : 'replayed',
        scoreModelId: scoreModel.id,
        scoreModelVersionId,
        journeyId: journey.id,
        journeyVersionId,
        milestoneIds,
        triggerIds,
      });
    });
  }
}
