import type { Pool } from 'pg';
import type { DatabaseRequestContext } from '../db/rls.js';
import { withTransaction } from '../db/transaction.js';
import type {
  ConversionJourneyTriggerDefinition,
  ConversionMilestoneSemantic,
  ConversionTriggerKind,
} from './types.js';

export interface ConversionSqlResult<TRow> {
  readonly rows: TRow[];
  readonly rowCount: number | null;
}

/** Tiny transaction-bound surface implemented by pg or a unit-test fake. */
export interface ConversionSqlExecutor {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<ConversionSqlResult<TRow>>;
}

export interface ConversionTransactionRunner {
  run<T>(
    context: DatabaseRequestContext,
    operation: (transaction: ConversionSqlExecutor) => Promise<T>,
  ): Promise<T>;
}

export interface ConversionContainerRecord {
  readonly id: string;
  readonly latestPublishedVersionNumber: number | null;
}

export interface ConversionDefinitionVersionRecord {
  readonly id: string;
  readonly definition: unknown;
  readonly definitionHash: Uint8Array;
}

export interface ConversionJourneyVersionRecord {
  readonly id: string;
  readonly definitionHash: Uint8Array;
  readonly scoreModelVersionId: string | null;
  readonly settings: unknown;
}

export interface StoredConversionMilestone {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly position: number;
  readonly semantic: ConversionMilestoneSemantic;
  readonly isCompletion: boolean;
}

export interface StoredConversionTrigger {
  readonly id: string;
  readonly kind: ConversionTriggerKind;
  readonly sourceKey: string;
  readonly milestoneId: string;
  readonly milestoneKey: string;
}

export interface ConversionBlueprintRepository {
  insertScoreModelIfMissing(input: {
    id: string;
    slug: string;
    name: string;
    createdByUserId: string;
  }): Promise<void>;
  lockScoreModelBySlug(slug: string): Promise<ConversionContainerRecord | null>;
  findScoreModelVersion(modelId: string, version: number): Promise<ConversionDefinitionVersionRecord | null>;
  insertScoreModelVersion(input: {
    id: string;
    modelId: string;
    version: number;
    definition: Readonly<Record<string, unknown>>;
    definitionHash: Uint8Array;
    createdByUserId: string;
  }): Promise<void>;
  insertJourneyIfMissing(input: {
    id: string;
    slug: string;
    name: string;
    description: string;
    createdByUserId: string;
  }): Promise<void>;
  lockJourneyBySlug(slug: string): Promise<ConversionContainerRecord | null>;
  findJourneyVersion(journeyId: string, version: number): Promise<ConversionJourneyVersionRecord | null>;
  insertJourneyVersion(input: {
    id: string;
    journeyId: string;
    version: number;
    scoreModelVersionId: string;
    settings: Readonly<Record<string, unknown>>;
    definitionHash: Uint8Array;
    createdByUserId: string;
  }): Promise<void>;
  insertMilestone(input: {
    id: string;
    journeyVersionId: string;
    key: string;
    name: string;
    position: number;
    semantic: ConversionMilestoneSemantic;
    isCompletion: boolean;
  }): Promise<void>;
  insertTrigger(input: {
    id: string;
    journeyVersionId: string;
    milestoneId: string;
    kind: ConversionJourneyTriggerDefinition['kind'];
    sourceKey: string;
  }): Promise<void>;
  listMilestones(journeyVersionId: string): Promise<readonly StoredConversionMilestone[]>;
  listTriggers(journeyVersionId: string): Promise<readonly StoredConversionTrigger[]>;
  activateScoreModel(input: { modelId: string; name: string; versionId: string }): Promise<void>;
  activateJourney(input: {
    journeyId: string;
    name: string;
    description: string;
    versionId: string;
  }): Promise<void>;
}

interface DefinitionVersionRow extends Record<string, unknown>, ConversionDefinitionVersionRecord {}

interface JourneyVersionRow extends Record<string, unknown>, ConversionJourneyVersionRecord {
  scoreModelVersionId: string | null;
}

interface MilestoneRow extends Record<string, unknown>, StoredConversionMilestone {}
interface TriggerRow extends Record<string, unknown>, StoredConversionTrigger {}

function requireInserted(result: ConversionSqlResult<Record<string, unknown>>, entity: string): void {
  if (result.rows.length !== 1) throw new Error(`${entity} insert returned no row`);
}

/**
 * SQL-only publisher repository. No method accepts a workspace ID: transaction
 * settings plus forced RLS are the sole tenant authority.
 */
export class ConversionPgRepository implements ConversionBlueprintRepository {
  constructor(private readonly transaction: ConversionSqlExecutor) {}

  async insertScoreModelIfMissing(input: {
    id: string;
    slug: string;
    name: string;
    createdByUserId: string;
  }): Promise<void> {
    await this.transaction.query(
      `/* conversion.insert-score-model-if-missing */
       INSERT INTO app.lead_score_models (
         id, workspace_id, slug, name, status, created_by_user_id
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, 'draft', $4
       )
       ON CONFLICT (workspace_id, slug) DO NOTHING`,
      [input.id, input.slug, input.name, input.createdByUserId],
    );
  }

  async lockScoreModelBySlug(slug: string): Promise<ConversionContainerRecord | null> {
    const result = await this.transaction.query<ConversionContainerRecord & Record<string, unknown>>(
      `/* conversion.lock-score-model */
       SELECT model.id,
              (
                SELECT max(published_version.version_no)::integer
                FROM app.lead_score_model_versions AS published_version
                WHERE published_version.workspace_id = model.workspace_id
                  AND published_version.model_id = model.id
                  AND published_version.published_at IS NOT NULL
              ) AS "latestPublishedVersionNumber"
       FROM app.lead_score_models AS model
       WHERE model.slug = $1
       FOR UPDATE OF model`,
      [slug],
    );
    return result.rows[0] ?? null;
  }

  async findScoreModelVersion(
    modelId: string,
    version: number,
  ): Promise<ConversionDefinitionVersionRecord | null> {
    const result = await this.transaction.query<DefinitionVersionRow>(
      `/* conversion.find-score-model-version */
       SELECT id, definition, definition_sha256 AS "definitionHash"
       FROM app.lead_score_model_versions
       WHERE model_id = $1 AND version_no = $2`,
      [modelId, version],
    );
    return result.rows[0] ?? null;
  }

  async insertScoreModelVersion(input: {
    id: string;
    modelId: string;
    version: number;
    definition: Readonly<Record<string, unknown>>;
    definitionHash: Uint8Array;
    createdByUserId: string;
  }): Promise<void> {
    const result = await this.transaction.query(
      `/* conversion.insert-score-model-version */
       INSERT INTO app.lead_score_model_versions (
         id, workspace_id, model_id, version_no, definition,
         definition_sha256, created_by_user_id
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4::jsonb, $5, $6
       )
       RETURNING id`,
      [
        input.id,
        input.modelId,
        input.version,
        JSON.stringify(input.definition),
        input.definitionHash,
        input.createdByUserId,
      ],
    );
    requireInserted(result, 'Score model version');
  }

  async insertJourneyIfMissing(input: {
    id: string;
    slug: string;
    name: string;
    description: string;
    createdByUserId: string;
  }): Promise<void> {
    await this.transaction.query(
      `/* conversion.insert-journey-if-missing */
       INSERT INTO app.conversion_journeys (
         id, workspace_id, slug, name, description, status, created_by_user_id
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4, 'draft', $5
       )
       ON CONFLICT (workspace_id, slug) DO NOTHING`,
      [input.id, input.slug, input.name, input.description, input.createdByUserId],
    );
  }

  async lockJourneyBySlug(slug: string): Promise<ConversionContainerRecord | null> {
    const result = await this.transaction.query<ConversionContainerRecord & Record<string, unknown>>(
      `/* conversion.lock-journey */
       SELECT journey.id,
              (
                SELECT max(published_version.version_no)::integer
                FROM app.conversion_journey_versions AS published_version
                WHERE published_version.workspace_id = journey.workspace_id
                  AND published_version.journey_id = journey.id
                  AND published_version.published_at IS NOT NULL
              ) AS "latestPublishedVersionNumber"
       FROM app.conversion_journeys AS journey
       WHERE journey.slug = $1
       FOR UPDATE OF journey`,
      [slug],
    );
    return result.rows[0] ?? null;
  }

  async findJourneyVersion(journeyId: string, version: number): Promise<ConversionJourneyVersionRecord | null> {
    const result = await this.transaction.query<JourneyVersionRow>(
      `/* conversion.find-journey-version */
       SELECT id,
              score_model_version_id AS "scoreModelVersionId",
              settings,
              definition_sha256 AS "definitionHash"
       FROM app_private.lock_conversion_journey_version($1, $2)`,
      [journeyId, version],
    );
    return result.rows[0] ?? null;
  }

  async insertJourneyVersion(input: {
    id: string;
    journeyId: string;
    version: number;
    scoreModelVersionId: string;
    settings: Readonly<Record<string, unknown>>;
    definitionHash: Uint8Array;
    createdByUserId: string;
  }): Promise<void> {
    const result = await this.transaction.query(
      `/* conversion.insert-journey-version */
       INSERT INTO app.conversion_journey_versions (
         id, workspace_id, journey_id, version_no, score_model_version_id,
         settings, definition_sha256, created_by_user_id
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4,
         $5::jsonb, $6, $7
       )
       RETURNING id`,
      [
        input.id,
        input.journeyId,
        input.version,
        input.scoreModelVersionId,
        JSON.stringify(input.settings),
        input.definitionHash,
        input.createdByUserId,
      ],
    );
    requireInserted(result, 'Journey version');
  }

  async insertMilestone(input: {
    id: string;
    journeyVersionId: string;
    key: string;
    name: string;
    position: number;
    semantic: ConversionMilestoneSemantic;
    isCompletion: boolean;
  }): Promise<void> {
    const result = await this.transaction.query(
      `/* conversion.insert-milestone */
       INSERT INTO app.conversion_journey_milestones (
         id, workspace_id, journey_version_id, milestone_key, name,
         position, semantic, is_completion
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4,
         $5, $6, $7
       )
       RETURNING id`,
      [
        input.id,
        input.journeyVersionId,
        input.key,
        input.name,
        input.position,
        input.semantic,
        input.isCompletion,
      ],
    );
    requireInserted(result, 'Journey milestone');
  }

  async insertTrigger(input: {
    id: string;
    journeyVersionId: string;
    milestoneId: string;
    kind: ConversionTriggerKind;
    sourceKey: string;
  }): Promise<void> {
    const result = await this.transaction.query(
      `/* conversion.insert-trigger */
       INSERT INTO app.conversion_journey_triggers (
         id, workspace_id, journey_version_id, milestone_id,
         trigger_kind, source_key
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4, $5
       )
       RETURNING id`,
      [input.id, input.journeyVersionId, input.milestoneId, input.kind, input.sourceKey],
    );
    requireInserted(result, 'Journey trigger');
  }

  async listMilestones(journeyVersionId: string): Promise<readonly StoredConversionMilestone[]> {
    const result = await this.transaction.query<MilestoneRow>(
      `/* conversion.list-milestones */
       SELECT id,
              milestone_key::text AS key,
              name,
              position,
              semantic,
              is_completion AS "isCompletion"
       FROM app.conversion_journey_milestones
       WHERE journey_version_id = $1
       ORDER BY position, id`,
      [journeyVersionId],
    );
    return result.rows;
  }

  async listTriggers(journeyVersionId: string): Promise<readonly StoredConversionTrigger[]> {
    const result = await this.transaction.query<TriggerRow>(
      `/* conversion.list-triggers */
       SELECT trigger.id,
              trigger.trigger_kind AS kind,
              trigger.source_key AS "sourceKey",
              trigger.milestone_id AS "milestoneId",
              milestone.milestone_key::text AS "milestoneKey"
       FROM app.conversion_journey_triggers AS trigger
       INNER JOIN app.conversion_journey_milestones AS milestone
         ON milestone.workspace_id = trigger.workspace_id
        AND milestone.journey_version_id = trigger.journey_version_id
        AND milestone.id = trigger.milestone_id
       WHERE trigger.journey_version_id = $1
       ORDER BY trigger.trigger_kind, trigger.source_key, trigger.id`,
      [journeyVersionId],
    );
    return result.rows;
  }

  async activateScoreModel(input: { modelId: string; name: string; versionId: string }): Promise<void> {
    const result = await this.transaction.query(
      `/* conversion.activate-score-model */
       UPDATE app.lead_score_models
       SET name = $2,
           status = 'active',
           active_version_id = $3,
           row_version = CASE
             WHEN name IS DISTINCT FROM $2
               OR status IS DISTINCT FROM 'active'
               OR active_version_id IS DISTINCT FROM $3
             THEN row_version + 1 ELSE row_version END,
           updated_at = CASE
             WHEN name IS DISTINCT FROM $2
               OR status IS DISTINCT FROM 'active'
               OR active_version_id IS DISTINCT FROM $3
             THEN statement_timestamp() ELSE updated_at END
       WHERE id = $1
       RETURNING id`,
      [input.modelId, input.name, input.versionId],
    );
    if (result.rows.length !== 1) throw new Error('Score model activation was not authorised or its row disappeared');
  }

  async activateJourney(input: {
    journeyId: string;
    name: string;
    description: string;
    versionId: string;
  }): Promise<void> {
    const result = await this.transaction.query(
      `/* conversion.activate-journey */
       UPDATE app.conversion_journeys
       SET name = $2,
           description = $3,
           status = 'active',
           active_version_id = $4,
           row_version = CASE
             WHEN name IS DISTINCT FROM $2
               OR description IS DISTINCT FROM $3
               OR status IS DISTINCT FROM 'active'
               OR active_version_id IS DISTINCT FROM $4
             THEN row_version + 1 ELSE row_version END,
           updated_at = CASE
             WHEN name IS DISTINCT FROM $2
               OR description IS DISTINCT FROM $3
               OR status IS DISTINCT FROM 'active'
               OR active_version_id IS DISTINCT FROM $4
             THEN statement_timestamp() ELSE updated_at END
       WHERE id = $1
       RETURNING id`,
      [input.journeyId, input.name, input.description, input.versionId],
    );
    if (result.rows.length !== 1) throw new Error('Journey activation was not authorised or its row disappeared');
  }
}

/** Production adapter; the command service still owns exactly one transaction. */
export function createPgConversionTransactionRunner(pool: Pick<Pool, 'connect'>): ConversionTransactionRunner {
  return {
    run<T>(
      context: DatabaseRequestContext,
      operation: (transaction: ConversionSqlExecutor) => Promise<T>,
    ): Promise<T> {
      return withTransaction(pool, context, async (client) => operation({
        async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          values?: readonly unknown[],
        ) {
          const result = await client.query<TRow>(sql, values ? [...values] : undefined);
          return { rows: result.rows, rowCount: result.rowCount };
        },
      }));
    },
  };
}
