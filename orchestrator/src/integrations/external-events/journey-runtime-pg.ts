import type { Pool } from 'pg';
import { withTransaction } from '../../db/transaction.js';

export interface PropertyPredatorJourneyProjectionResult {
  readonly disposition: 'projected';
  readonly replayed: boolean;
  readonly enrollmentsStarted: number;
  readonly milestonesAchieved: number;
  readonly scoreSnapshotsWritten: number;
  readonly consentFactsWritten: number;
  readonly commerceFactsWritten: number;
}

export interface PgPropertyPredatorJourneyRuntimeDependencies {
  /** Authenticates as r72_webhook and owns no direct conversion-table capability. */
  readonly webhookPool: Pick<Pool, 'connect'>;
  /** Trusted server-side source mapping. It must never come from an event body. */
  readonly workspaceId: string;
}

interface JourneyProjectionRow {
  disposition: string;
  replayed: boolean;
  enrollments_started: unknown;
  milestones_achieved: unknown;
  score_snapshots_written: unknown;
  consent_facts_written: unknown;
  commerce_facts_written: unknown;
}

interface JourneyRuntimeReadinessRow {
  database_user: string;
  projector_exists: boolean;
  projector_executable: boolean;
  projector_owned_by_definer: boolean;
  projector_security_definer: boolean;
  projector_fixed_search_path: boolean;
  readiness_exists: boolean;
  readiness_executable: boolean;
  readiness_owned_by_definer: boolean;
  readiness_security_definer: boolean;
  readiness_fixed_search_path: boolean;
  workspace_blueprints_ready: boolean;
  runtime_tables_exist: boolean;
  no_runtime_table_privileges: boolean;
}

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COUNT_KEYS = [
  'enrollments_started',
  'milestones_achieved',
  'score_snapshots_written',
  'consent_facts_written',
  'commerce_facts_written',
] as const;

function boundedCount(value: unknown, label: string): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new Error(`Journey projector returned invalid ${label}`);
  }
  return parsed;
}

/** Prove the webhook identity can execute only the narrow journey projector. */
export async function assertPgPropertyPredatorJourneyRuntimeReady(
  pool: Pick<Pool, 'connect'>,
  workspaceId: string,
): Promise<void> {
  if (typeof workspaceId !== 'string' || !CANONICAL_UUID_PATTERN.test(workspaceId)) {
    throw new TypeError('workspaceId must be a canonical lowercase UUID');
  }
  return withTransaction(
    pool,
    {
      actorKind: 'webhook',
      workspaceId,
      requestId: 'property-predator-journey-readiness',
    },
    async (transaction) => {
      const result = await transaction.query<JourneyRuntimeReadinessRow>(
        `/* external-events.journey-runtime-readiness */
     WITH protected_functions AS (
       SELECT target.function_kind,
              procedure.oid,
              owner_role.rolname AS owner_name,
              procedure.prosecdef,
              procedure.proconfig
       FROM (VALUES
         ('projector', pg_catalog.to_regprocedure(
           'app_private.project_property_predator_journey_event(uuid)'
         )),
         ('readiness', pg_catalog.to_regprocedure(
           'app_private.property_predator_journey_runtime_ready()'
         ))
       ) AS target(function_kind, oid)
       LEFT JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = target.oid
       LEFT JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
     ), projector AS (
       SELECT procedure.oid,
              procedure.owner_name,
              procedure.prosecdef,
              procedure.proconfig
       FROM protected_functions AS procedure
       WHERE procedure.function_kind = 'projector'
     ), readiness AS (
       SELECT procedure.oid,
              procedure.owner_name,
              procedure.prosecdef,
              procedure.proconfig
       FROM protected_functions AS procedure
       WHERE procedure.function_kind = 'readiness'
     ), runtime_relations AS (
       SELECT qualified_name,
              pg_catalog.to_regclass(qualified_name) AS oid
       FROM unnest(ARRAY[
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
         'app.outbox_events'
       ]::text[]) AS names(qualified_name)
     )
     SELECT current_user::text AS database_user,
            projector.oid IS NOT NULL AS projector_exists,
            COALESCE(
              pg_catalog.has_function_privilege(current_user, projector.oid, 'EXECUTE'),
              false
            ) AS projector_executable,
            projector.owner_name = 'r72_journey_projector_definer'
              AS projector_owned_by_definer,
            projector.prosecdef IS TRUE AS projector_security_definer,
            projector.proconfig = ARRAY['search_path=pg_catalog']::text[]
              AS projector_fixed_search_path,
            readiness.oid IS NOT NULL AS readiness_exists,
            COALESCE(
              pg_catalog.has_function_privilege(current_user, readiness.oid, 'EXECUTE'),
              false
            ) AS readiness_executable,
            readiness.owner_name = 'r72_journey_projector_definer'
              AS readiness_owned_by_definer,
            readiness.prosecdef IS TRUE AS readiness_security_definer,
            readiness.proconfig = ARRAY['search_path=pg_catalog']::text[]
              AS readiness_fixed_search_path,
            app_private.property_predator_journey_runtime_ready()
              AS workspace_blueprints_ready,
            (SELECT count(*) = 18
             FROM runtime_relations
             WHERE oid IS NOT NULL) AS runtime_tables_exist,
            NOT EXISTS (
              SELECT 1
              FROM runtime_relations AS relation
              WHERE relation.oid IS NULL
                 OR pg_catalog.has_table_privilege(current_user, relation.oid, 'SELECT')
                 OR pg_catalog.has_table_privilege(current_user, relation.oid, 'INSERT')
                 OR pg_catalog.has_table_privilege(current_user, relation.oid, 'UPDATE')
                 OR pg_catalog.has_table_privilege(current_user, relation.oid, 'DELETE')
                 OR pg_catalog.has_table_privilege(current_user, relation.oid, 'TRUNCATE')
                 OR pg_catalog.has_table_privilege(current_user, relation.oid, 'REFERENCES')
                 OR pg_catalog.has_table_privilege(current_user, relation.oid, 'TRIGGER')
                 OR pg_catalog.has_any_column_privilege(current_user, relation.oid, 'SELECT')
                 OR pg_catalog.has_any_column_privilege(current_user, relation.oid, 'INSERT')
                 OR pg_catalog.has_any_column_privilege(current_user, relation.oid, 'UPDATE')
                 OR pg_catalog.has_any_column_privilege(current_user, relation.oid, 'REFERENCES')
            ) AS no_runtime_table_privileges
     FROM projector
     CROSS JOIN readiness`,
      );
      const row = result.rows[0];
      if (result.rows.length !== 1
          || row?.database_user !== 'r72_webhook'
          || row.projector_exists !== true
          || row.projector_executable !== true
          || row.projector_owned_by_definer !== true
          || row.projector_security_definer !== true
          || row.projector_fixed_search_path !== true
          || row.readiness_exists !== true
          || row.readiness_executable !== true
          || row.readiness_owned_by_definer !== true
          || row.readiness_security_definer !== true
          || row.readiness_fixed_search_path !== true
          || row.workspace_blueprints_ready !== true
          || row.runtime_tables_exist !== true
          || row.no_runtime_table_privileges !== true) {
        throw new Error('Property Predator journey runtime is not ready');
      }
    },
    { readOnly: true },
  );
}

/**
 * Projects one immutable source event into conversion facts. The application
 * forwards only its ID; the database reopens and revalidates the signed shadow
 * receipt before deriving any enrollment, milestone, score, consent or money.
 */
export class PgPropertyPredatorJourneyRuntime {
  readonly #webhookPool: Pick<Pool, 'connect'>;
  readonly #workspaceId: string;

  constructor(dependencies: PgPropertyPredatorJourneyRuntimeDependencies) {
    if (!dependencies
        || typeof dependencies.workspaceId !== 'string'
        || !CANONICAL_UUID_PATTERN.test(dependencies.workspaceId)) {
      throw new TypeError('workspaceId must be a canonical lowercase UUID');
    }
    if (!dependencies.webhookPool
        || typeof dependencies.webhookPool.connect !== 'function') {
      throw new TypeError('webhookPool must provide connect()');
    }
    this.#webhookPool = dependencies.webhookPool;
    this.#workspaceId = dependencies.workspaceId;
  }

  async project(eventId: string): Promise<PropertyPredatorJourneyProjectionResult> {
    if (typeof eventId !== 'string' || !CANONICAL_UUID_PATTERN.test(eventId)) {
      throw new TypeError('eventId must be a canonical lowercase UUID');
    }

    return withTransaction(
      this.#webhookPool,
      {
        actorKind: 'webhook',
        workspaceId: this.#workspaceId,
        requestId: `property-predator-journey:${eventId}`,
      },
      async (transaction) => {
        const result = await transaction.query<JourneyProjectionRow>(
          `/* external-events.project-property-predator-journey */
           SELECT disposition,
                  replayed,
                  enrollments_started,
                  milestones_achieved,
                  score_snapshots_written,
                  consent_facts_written,
                  commerce_facts_written
           FROM app_private.project_property_predator_journey_event($1::uuid)`,
          [eventId],
        );
        const row = result.rows[0];
        const expectedKeys = ['disposition', 'replayed', ...COUNT_KEYS];
        if (result.rows.length !== 1
            || row?.disposition !== 'projected'
            || typeof row.replayed !== 'boolean'
            || Object.keys(row).length !== expectedKeys.length
            || expectedKeys.some((key) => !Object.hasOwn(row, key))) {
          throw new Error('Journey projector returned invalid canonical data');
        }
        return Object.freeze({
          disposition: 'projected' as const,
          replayed: row.replayed,
          enrollmentsStarted: boundedCount(row.enrollments_started, 'enrollments_started'),
          milestonesAchieved: boundedCount(row.milestones_achieved, 'milestones_achieved'),
          scoreSnapshotsWritten: boundedCount(
            row.score_snapshots_written,
            'score_snapshots_written',
          ),
          consentFactsWritten: boundedCount(row.consent_facts_written, 'consent_facts_written'),
          commerceFactsWritten: boundedCount(row.commerce_facts_written, 'commerce_facts_written'),
        });
      },
    );
  }
}
