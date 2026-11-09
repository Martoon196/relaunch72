import type { Pool } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { createPgCrmReadTransactionRunner } from '../crm-pg/read-model.js';
import type { CrmTransactionRunner, SqlExecutor } from '../crm-pg/types.js';
import { validateDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS } from './property-predator-blueprints.js';
import { journeySettingsDocument, scoreModelDocument } from './commands.js';
import type {
  ConversionJourneyTriggerDefinition,
  ConversionMilestoneDefinition,
  ConversionScoreBandDefinition,
  ConversionScoreComponentDefinition,
  ConversionScoreRuleDefinition,
} from './types.js';

const JOURNEY_SLUGS = [
  'property-predator-self-serve',
  'property-predator-agency-laps',
] as const;

export type PropertyPredatorJourneySlug = (typeof JOURNEY_SLUGS)[number];
export type JourneyManagerPublicationState =
  | 'published'
  | 'missing'
  | 'draft'
  | 'outdated'
  | 'conflict';
export type JourneyManagerFoundationState = 'ready' | 'action_required' | 'not_installed';

export interface JourneyManagerRouteRead {
  readonly slug: PropertyPredatorJourneySlug;
  readonly name: string;
  readonly description: string;
  readonly version: number;
  readonly definitionHash: string;
  readonly publication: JourneyManagerPublicationState;
  readonly activeVersion: number | null;
  readonly publishedAt: string | null;
  readonly runtimeReady: boolean;
  readonly milestones: readonly ConversionMilestoneDefinition[];
  readonly triggers: readonly ConversionJourneyTriggerDefinition[];
}

export interface JourneyManagerScoreModelRead {
  readonly slug: string;
  readonly name: string;
  readonly version: number;
  readonly definitionHash: string;
  readonly publication: JourneyManagerPublicationState;
  readonly activeVersion: number | null;
  readonly publishedAt: string | null;
  readonly maxScore: number;
  readonly components: readonly ConversionScoreComponentDefinition[];
  readonly bands: readonly ConversionScoreBandDefinition[];
  readonly rules: readonly ConversionScoreRuleDefinition[];
}

export interface JourneyManagerSafetyRead {
  readonly definitionsOnly: true;
  readonly sendsMessages: false;
  readonly publishesSocialPosts: false;
  readonly triggersProviders: false;
}

export interface JourneyManagerReadSnapshot {
  readonly snapshotAt: string;
  readonly canManage: boolean;
  readonly foundationState: JourneyManagerFoundationState;
  readonly runtimeReady: boolean;
  readonly routes: readonly JourneyManagerRouteRead[];
  readonly scoreModel: JourneyManagerScoreModelRead;
  readonly safety: JourneyManagerSafetyRead;
}

export interface JourneyManagerReadDependencies {
  readonly transactionRunner: CrmTransactionRunner;
}

export class JourneyManagerReadDataError extends Error {
  readonly code = 'invalid_journey_manager_read_data';

  constructor(message: string) {
    super(message);
    this.name = 'JourneyManagerReadDataError';
  }
}

interface MembershipStorage {
  readonly snapshotAt: string;
  readonly canManage: boolean;
}

interface ScoreStorage {
  readonly status: 'draft' | 'active' | 'archived';
  readonly activeVersionId: string | null;
  readonly activeVersion: number | null;
  readonly definitionHash: string | null;
  readonly definition: Readonly<Record<string, unknown>> | null;
  readonly publishedAt: string | null;
}

interface RouteStorage {
  readonly slug: PropertyPredatorJourneySlug;
  readonly status: 'draft' | 'active' | 'archived';
  readonly activeVersionId: string | null;
  readonly activeVersion: number | null;
  readonly scoreModelVersionId: string | null;
  readonly definitionHash: string | null;
  readonly settings: Readonly<Record<string, unknown>> | null;
  readonly publishedAt: string | null;
}

interface MilestoneStorage {
  readonly slug: PropertyPredatorJourneySlug;
  readonly key: string;
  readonly name: string;
  readonly position: number;
  readonly semantic: ConversionMilestoneDefinition['semantic'];
  readonly isCompletion: boolean;
}

interface TriggerStorage {
  readonly slug: PropertyPredatorJourneySlug;
  readonly kind: ConversionJourneyTriggerDefinition['kind'];
  readonly sourceKey: string;
  readonly milestoneKey: string;
}

const MEMBERSHIP_SQL = `/* conversion.journey-manager.membership */
  SELECT transaction_timestamp() AS snapshot_at,
         membership.role IN ('owner', 'admin') AS can_manage
  FROM app.workspace_memberships AS membership
  WHERE membership.workspace_id = app_private.current_workspace_id()
    AND membership.user_id = app_private.current_user_id()
    AND membership.status = 'active'`;

const SCORE_MODEL_SQL = `/* conversion.journey-manager.score-model */
  SELECT model.status,
         version.id AS active_version_id,
         version.version_no AS active_version,
         version.definition,
         encode(version.definition_sha256, 'hex') AS definition_hash,
         version.published_at
  FROM app.lead_score_models AS model
  LEFT JOIN app.lead_score_model_versions AS version
    ON version.workspace_id = model.workspace_id
   AND version.model_id = model.id
   AND version.id = model.active_version_id
  WHERE model.workspace_id = app_private.current_workspace_id()
    AND model.slug = $1`;

const ROUTES_SQL = `/* conversion.journey-manager.routes */
  SELECT journey.slug::text AS journey_slug,
         journey.status,
         version.id AS active_version_id,
         version.version_no AS active_version,
         version.score_model_version_id,
         version.settings,
         encode(version.definition_sha256, 'hex') AS definition_hash,
         version.published_at
  FROM app.conversion_journeys AS journey
  LEFT JOIN app.conversion_journey_versions AS version
    ON version.workspace_id = journey.workspace_id
   AND version.journey_id = journey.id
   AND version.id = journey.active_version_id
  WHERE journey.workspace_id = app_private.current_workspace_id()
    AND journey.slug::text = ANY($1::text[])
  ORDER BY journey.slug::text`;

const MILESTONES_SQL = `/* conversion.journey-manager.milestones */
  SELECT journey.slug::text AS journey_slug,
         milestone.milestone_key::text AS milestone_key,
         milestone.name,
         milestone.position,
         milestone.semantic,
         milestone.is_completion
  FROM app.conversion_journeys AS journey
  JOIN app.conversion_journey_versions AS version
    ON version.workspace_id = journey.workspace_id
   AND version.journey_id = journey.id
   AND version.id = journey.active_version_id
  JOIN app.conversion_journey_milestones AS milestone
    ON milestone.workspace_id = version.workspace_id
   AND milestone.journey_version_id = version.id
  WHERE journey.workspace_id = app_private.current_workspace_id()
    AND journey.slug::text = ANY($1::text[])
  ORDER BY journey.slug::text, milestone.position, milestone.id`;

const TRIGGERS_SQL = `/* conversion.journey-manager.triggers */
  SELECT journey.slug::text AS journey_slug,
         trigger.trigger_kind,
         trigger.source_key,
         milestone.milestone_key::text AS milestone_key
  FROM app.conversion_journeys AS journey
  JOIN app.conversion_journey_versions AS version
    ON version.workspace_id = journey.workspace_id
   AND version.journey_id = journey.id
   AND version.id = journey.active_version_id
  JOIN app.conversion_journey_triggers AS trigger
    ON trigger.workspace_id = version.workspace_id
   AND trigger.journey_version_id = version.id
  JOIN app.conversion_journey_milestones AS milestone
    ON milestone.workspace_id = trigger.workspace_id
   AND milestone.journey_version_id = trigger.journey_version_id
   AND milestone.id = trigger.milestone_id
  WHERE journey.workspace_id = app_private.current_workspace_id()
    AND journey.slug::text = ANY($1::text[])
  ORDER BY journey.slug::text, trigger.trigger_kind, trigger.source_key`;

function fail(message: string): never {
  throw new JourneyManagerReadDataError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${label} must be a row`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) return fail(`${label} must be non-empty text`);
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') return fail(`${label} must be boolean`);
  return value;
}

function timestamp(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return fail(`${label} must be a timestamp`);
  return date.toISOString();
}

function positiveInteger(value: unknown, label: string, nullable = false): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return fail(`${label} must be a positive integer`);
  }
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, options: T, label: string): T[number] {
  if (typeof value !== 'string' || !options.includes(value)) return fail(`${label} is invalid`);
  return value as T[number];
}

function uuid(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  const candidate = text(value, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)) {
    return fail(`${label} must be a UUID`);
  }
  return candidate.toLowerCase();
}

function hash(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  const candidate = text(value, label);
  if (!/^[0-9a-f]{64}$/.test(candidate)) return fail(`${label} must be a SHA-256 digest`);
  return candidate;
}

function journeySlug(value: unknown, label: string): PropertyPredatorJourneySlug {
  return oneOf(value, JOURNEY_SLUGS, label);
}

function mapMembership(value: unknown): MembershipStorage {
  const row = record(value, 'membership');
  return Object.freeze({
    snapshotAt: timestamp(row.snapshot_at, 'membership.snapshotAt')!,
    canManage: boolean(row.can_manage, 'membership.canManage'),
  });
}

function mapScore(value: unknown): ScoreStorage {
  const row = record(value, 'scoreModel');
  return Object.freeze({
    status: oneOf(row.status, ['draft', 'active', 'archived'] as const, 'scoreModel.status'),
    activeVersionId: uuid(row.active_version_id, 'scoreModel.activeVersionId', true),
    activeVersion: positiveInteger(row.active_version, 'scoreModel.activeVersion', true),
    definitionHash: hash(row.definition_hash, 'scoreModel.definitionHash', true),
    definition: row.definition === null ? null : record(row.definition, 'scoreModel.definition'),
    publishedAt: timestamp(row.published_at, 'scoreModel.publishedAt', true),
  });
}

function mapRoute(value: unknown, index: number): RouteStorage {
  const row = record(value, `routes[${index}]`);
  return Object.freeze({
    slug: journeySlug(row.journey_slug, `routes[${index}].slug`),
    status: oneOf(row.status, ['draft', 'active', 'archived'] as const, `routes[${index}].status`),
    activeVersionId: uuid(row.active_version_id, `routes[${index}].activeVersionId`, true),
    activeVersion: positiveInteger(row.active_version, `routes[${index}].activeVersion`, true),
    scoreModelVersionId: uuid(row.score_model_version_id, `routes[${index}].scoreModelVersionId`, true),
    definitionHash: hash(row.definition_hash, `routes[${index}].definitionHash`, true),
    settings: row.settings === null ? null : record(row.settings, `routes[${index}].settings`),
    publishedAt: timestamp(row.published_at, `routes[${index}].publishedAt`, true),
  });
}

function mapMilestone(value: unknown, index: number): MilestoneStorage {
  const row = record(value, `milestones[${index}]`);
  return Object.freeze({
    slug: journeySlug(row.journey_slug, `milestones[${index}].slug`),
    key: text(row.milestone_key, `milestones[${index}].key`),
    name: text(row.name, `milestones[${index}].name`),
    position: positiveInteger(row.position, `milestones[${index}].position`)! as number,
    semantic: oneOf(
      row.semantic,
      ['lead', 'appointment', 'presentation', 'activation', 'offer', 'sale', 'retention', 'custom'] as const,
      `milestones[${index}].semantic`,
    ),
    isCompletion: boolean(row.is_completion, `milestones[${index}].isCompletion`),
  });
}

function mapTrigger(value: unknown, index: number): TriggerStorage {
  const row = record(value, `triggers[${index}]`);
  return Object.freeze({
    slug: journeySlug(row.journey_slug, `triggers[${index}].slug`),
    kind: oneOf(row.trigger_kind, ['event', 'commerce'] as const, `triggers[${index}].kind`),
    sourceKey: text(row.source_key, `triggers[${index}].sourceKey`),
    milestoneKey: text(row.milestone_key, `triggers[${index}].milestoneKey`),
  });
}

function scorePublication(stored: ScoreStorage | null): JourneyManagerPublicationState {
  const expected = PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS[0]!.scoreModel;
  if (!stored) return 'missing';
  if (stored.status === 'draft' || stored.activeVersion === null) return 'draft';
  if (stored.status !== 'active') return 'conflict';
  if (stored.activeVersion < expected.version) return 'outdated';
  if (stored.activeVersion !== expected.version
      || stored.definitionHash !== expected.definitionHash
      || !isDeepStrictEqual(stored.definition, scoreModelDocument(PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS[0]!))
      || stored.publishedAt === null
      || stored.activeVersionId === null) return 'conflict';
  return 'published';
}

function milestonesMatch(
  expected: readonly ConversionMilestoneDefinition[],
  stored: readonly MilestoneStorage[],
): boolean {
  if (expected.length !== stored.length) return false;
  return expected.every((milestone, index) => {
    const actual = stored[index];
    return actual?.key === milestone.key
      && actual.name === milestone.name
      && actual.position === milestone.position
      && actual.semantic === milestone.semantic
      && actual.isCompletion === milestone.isCompletion;
  });
}

function triggersMatch(
  expected: readonly ConversionJourneyTriggerDefinition[],
  stored: readonly TriggerStorage[],
): boolean {
  if (expected.length !== stored.length) return false;
  const actual = new Set(stored.map((trigger) => `${trigger.kind}\u0000${trigger.sourceKey}\u0000${trigger.milestoneKey}`));
  return expected.every((trigger) => actual.has(`${trigger.kind}\u0000${trigger.sourceKey}\u0000${trigger.milestoneKey}`));
}

function routePublication(
  expected: (typeof PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS)[number],
  stored: RouteStorage | null,
  milestones: readonly MilestoneStorage[],
  triggers: readonly TriggerStorage[],
): JourneyManagerPublicationState {
  if (!stored) return 'missing';
  if (stored.status === 'draft' || stored.activeVersion === null) return 'draft';
  if (stored.status !== 'active') return 'conflict';
  if (stored.activeVersion < expected.version) return 'outdated';
  if (stored.activeVersion !== expected.version
      || stored.definitionHash !== expected.definitionHash
      || !isDeepStrictEqual(stored.settings, journeySettingsDocument(expected))
      || stored.publishedAt === null
      || stored.activeVersionId === null
      || stored.scoreModelVersionId === null
      || !milestonesMatch(expected.milestones, milestones)
      || !triggersMatch(expected.triggers, triggers)) return 'conflict';
  return 'published';
}

async function rows(transaction: SqlExecutor, sql: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]> {
  const result = await transaction.query(sql, values);
  return result.rows;
}

const SAFETY: JourneyManagerSafetyRead = Object.freeze({
  definitionsOnly: true,
  sendsMessages: false,
  publishesSocialPosts: false,
  triggersProviders: false,
});

export class JourneyManagerReadService {
  constructor(private readonly dependencies: JourneyManagerReadDependencies) {}

  async load(context: DatabaseRequestContext): Promise<JourneyManagerReadSnapshot> {
    validateDatabaseContext(context);
    if (context.actorKind !== 'user' || !context.userId) {
      throw new JourneyManagerReadDataError('Journey Manager requires an authenticated user context');
    }

    return this.dependencies.transactionRunner.run(context, async (transaction) => {
      const membershipRows = await rows(transaction, MEMBERSHIP_SQL);
      if (membershipRows.length !== 1) {
        throw new JourneyManagerReadDataError('Journey Manager requires exactly one active workspace membership');
      }
      const membership = mapMembership(membershipRows[0]);
      const expectedScore = PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS[0]!.scoreModel;
      const secondScore = PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS[1]!.scoreModel;
      if (expectedScore.definitionHash !== secondScore.definitionHash) {
        throw new JourneyManagerReadDataError('Property Predator routes do not share one score model');
      }

      const [scoreRows, routeRows, milestoneRows, triggerRows] = await Promise.all([
        rows(transaction, SCORE_MODEL_SQL, [expectedScore.slug]),
        rows(transaction, ROUTES_SQL, [JOURNEY_SLUGS]),
        rows(transaction, MILESTONES_SQL, [JOURNEY_SLUGS]),
        rows(transaction, TRIGGERS_SQL, [JOURNEY_SLUGS]),
      ]);
      if (scoreRows.length > 1) throw new JourneyManagerReadDataError('Journey score model was returned more than once');

      const storedScore = scoreRows[0] ? mapScore(scoreRows[0]) : null;
      const scoreState = scorePublication(storedScore);
      const mappedRoutes = routeRows.map(mapRoute);
      if (new Set(mappedRoutes.map((route) => route.slug)).size !== mappedRoutes.length) {
        throw new JourneyManagerReadDataError('Journey Manager returned a duplicate route');
      }
      const mappedMilestones = milestoneRows.map(mapMilestone);
      const mappedTriggers = triggerRows.map(mapTrigger);

      const routes = Object.freeze(PROPERTY_PREDATOR_CONVERSION_BLUEPRINTS.map((expected) => {
        const slug = journeySlug(expected.slug, 'expected route slug');
        const stored = mappedRoutes.find((route) => route.slug === slug) ?? null;
        const routeMilestones = mappedMilestones.filter((milestone) => milestone.slug === slug);
        const routeTriggers = mappedTriggers.filter((trigger) => trigger.slug === slug);
        const publication = routePublication(expected, stored, routeMilestones, routeTriggers);
        const runtimeReady = publication === 'published'
          && scoreState === 'published'
          && stored?.scoreModelVersionId === storedScore?.activeVersionId;
        return Object.freeze({
          slug,
          name: expected.name,
          description: expected.description,
          version: expected.version,
          definitionHash: expected.definitionHash,
          publication,
          activeVersion: stored?.activeVersion ?? null,
          publishedAt: stored?.publishedAt ?? null,
          runtimeReady,
          milestones: expected.milestones,
          triggers: expected.triggers,
        });
      }));

      const scoreModel: JourneyManagerScoreModelRead = Object.freeze({
        slug: expectedScore.slug,
        name: expectedScore.name,
        version: expectedScore.version,
        definitionHash: expectedScore.definitionHash,
        publication: scoreState,
        activeVersion: storedScore?.activeVersion ?? null,
        publishedAt: storedScore?.publishedAt ?? null,
        maxScore: expectedScore.components.reduce((total, component) => total + component.maxPoints, 0),
        components: expectedScore.components,
        bands: expectedScore.bands,
        rules: expectedScore.rules,
      });
      const runtimeReady = routes.every((route) => route.runtimeReady);
      const nothingInstalled = scoreState === 'missing'
        && routes.every((route) => route.publication === 'missing');

      return Object.freeze({
        snapshotAt: membership.snapshotAt,
        canManage: membership.canManage,
        foundationState: runtimeReady ? 'ready' : nothingInstalled ? 'not_installed' : 'action_required',
        runtimeReady,
        routes,
        scoreModel,
        safety: SAFETY,
      });
    });
  }
}

export function createPgJourneyManagerReadService(pool: Pick<Pool, 'connect'>): JourneyManagerReadService {
  return new JourneyManagerReadService({ transactionRunner: createPgCrmReadTransactionRunner(pool) });
}
