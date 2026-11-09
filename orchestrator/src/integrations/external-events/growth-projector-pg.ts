import type { Pool } from 'pg';
import { withTransaction } from '../../db/transaction.js';

export interface PropertyPredatorGrowthProjectionResult {
  readonly disposition: 'projected';
  readonly replayed: boolean;
}

export interface PgPropertyPredatorGrowthEventProjectorDependencies {
  /** Authenticates as r72_webhook and owns no direct Growth evidence-table capability. */
  readonly webhookPool: Pick<Pool, 'connect'>;
  /** Trusted server-side source mapping. It must never come from an event body. */
  readonly workspaceId: string;
}

interface GrowthProjectionRow {
  disposition: string;
  replayed: boolean;
}

interface GrowthProjectorReadinessRow {
  database_user: string;
  projector_exists: boolean;
  projector_executable: boolean;
  projector_owned_by_definer: boolean;
  projector_security_definer: boolean;
  projector_fixed_search_path: boolean;
  growth_tables_exist: boolean;
  no_growth_table_privileges: boolean;
  shadow_recorder_exists: boolean;
  shadow_recorder_not_executable: boolean;
}

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Prove the webhook role has only the narrow Growth projection capability.
 *
 * This deliberately checks the complete table-privilege vocabulary rather
 * than relying on RLS to compensate for an accidentally broad grant.
 */
export async function assertPgPropertyPredatorGrowthEventProjectorReady(
  pool: Pick<Pool, 'query'>,
): Promise<void> {
  const result = await pool.query<GrowthProjectorReadinessRow>(
    `/* external-events.growth-projector-readiness */
     WITH projector AS (
       SELECT procedure.oid,
              owner_role.rolname AS owner_name,
              procedure.prosecdef,
              procedure.proconfig
       FROM (
         SELECT pg_catalog.to_regprocedure(
           'app_private.project_property_predator_growth_event(uuid)'
         ) AS oid
       ) AS target
       LEFT JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = target.oid
       LEFT JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
     ),
     shadow_recorder AS (
       SELECT pg_catalog.to_regprocedure(
         'app_private.record_external_event_shadow_receipt(uuid,text,uuid,text,smallint,timestamptz,uuid,text,uuid,bytea,jsonb,text,timestamptz)'
       ) AS oid
     ),
     growth_relations AS (
       SELECT qualified_name,
              pg_catalog.to_regclass(qualified_name) AS oid
       FROM unnest(ARRAY[
         'app.contact_source_identities',
         'app.content_consumption_facts',
         'app.offer_presentation_facts',
         'app.offer_response_facts',
         'app.contact_attribution_facts',
         'app_private.external_event_projection_receipts'
       ]::text[]) AS names(qualified_name)
     )
     SELECT current_user::text AS database_user,
            projector.oid IS NOT NULL AS projector_exists,
            COALESCE(
              pg_catalog.has_function_privilege(current_user, projector.oid, 'EXECUTE'),
              false
            ) AS projector_executable,
            projector.owner_name = 'r72_growth_projector_definer'
              AS projector_owned_by_definer,
            projector.prosecdef IS TRUE AS projector_security_definer,
            projector.proconfig = ARRAY['search_path=pg_catalog']::text[]
              AS projector_fixed_search_path,
            (SELECT count(*) = 6
             FROM growth_relations
             WHERE oid IS NOT NULL) AS growth_tables_exist,
            NOT EXISTS (
              SELECT 1
              FROM growth_relations AS relation
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
            ) AS no_growth_table_privileges,
            shadow_recorder.oid IS NOT NULL AS shadow_recorder_exists,
            shadow_recorder.oid IS NOT NULL
              AND NOT COALESCE(
                pg_catalog.has_function_privilege(
                  current_user,
                  shadow_recorder.oid,
                  'EXECUTE'
                ),
                false
              ) AS shadow_recorder_not_executable
     FROM projector
     CROSS JOIN shadow_recorder`,
  );
  const row = result.rows[0];
  if (result.rows.length !== 1
      || row?.database_user !== 'r72_webhook'
      || row.projector_exists !== true
      || row.projector_executable !== true
      || row.projector_owned_by_definer !== true
      || row.projector_security_definer !== true
      || row.projector_fixed_search_path !== true
      || row.growth_tables_exist !== true
      || row.no_growth_table_privileges !== true
      || row.shadow_recorder_exists !== true
      || row.shadow_recorder_not_executable !== true) {
    throw new Error('Property Predator Growth event projector is not ready');
  }
}

/**
 * PostgreSQL bridge for projecting an accepted Property Predator shadow event.
 *
 * The caller supplies only the immutable event ID. The SECURITY DEFINER
 * function resolves the canonical private receipt and derives every evidence
 * value from its stored payload; this service never forwards evidence fields.
 */
export class PgPropertyPredatorGrowthEventProjector {
  readonly #webhookPool: Pick<Pool, 'connect'>;
  readonly #workspaceId: string;

  constructor(dependencies: PgPropertyPredatorGrowthEventProjectorDependencies) {
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

  async project(eventId: string): Promise<PropertyPredatorGrowthProjectionResult> {
    if (typeof eventId !== 'string' || !CANONICAL_UUID_PATTERN.test(eventId)) {
      throw new TypeError('eventId must be a canonical lowercase UUID');
    }

    return withTransaction(
      this.#webhookPool,
      {
        actorKind: 'webhook',
        workspaceId: this.#workspaceId,
        requestId: `property-predator-projector:${eventId}`,
      },
      async (transaction) => {
        const result = await transaction.query<GrowthProjectionRow>(
          `/* external-events.project-property-predator-growth */
           SELECT disposition, replayed
           FROM app_private.project_property_predator_growth_event($1::uuid)`,
          [eventId],
        );
        const row = result.rows[0];
        if (result.rows.length !== 1
            || row?.disposition !== 'projected'
            || typeof row.replayed !== 'boolean'
            || Object.keys(row).length !== 2) {
          throw new Error('Growth event projector returned invalid canonical data');
        }
        return Object.freeze({ disposition: 'projected', replayed: row.replayed });
      },
    );
  }
}
