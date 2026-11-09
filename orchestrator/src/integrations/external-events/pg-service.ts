import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { parsePropertyPredatorExternalEventBody } from './contracts.js';
import type { VerifiedPropertyPredatorExternalEventSignature } from './signature.js';

export const PROPERTY_PREDATOR_EXTERNAL_EVENT_SOURCE = 'property_predator' as const;

export interface PropertyPredatorExternalEventShadowRecordInput {
  /** Exact signature-verified request bytes. They are hashed, never retained. */
  readonly rawBody: Uint8Array;
  /** Proof returned by verifyPropertyPredatorExternalEventSignature. */
  readonly verifiedSignature: VerifiedPropertyPredatorExternalEventSignature;
}

export interface PropertyPredatorExternalEventShadowRecordResult {
  readonly disposition: 'shadow';
  readonly replayed: boolean;
}

export interface PgPropertyPredatorExternalEventShadowServiceDependencies {
  readonly commandPool: Pick<Pool, 'connect'>;
  /** Trusted server-side source mapping. It must never come from an event body. */
  readonly workspaceId: string;
}

interface ShadowReceiptRow {
  disposition: string;
  replayed: boolean;
}

interface PgErrorLike {
  code?: unknown;
  message?: unknown;
}

interface ShadowStoreReadinessRow {
  database_user: string;
  recorder_exists: boolean;
  recorder_executable: boolean;
  recorder_owned_by_definer: boolean;
  recorder_security_definer: boolean;
  recorder_fixed_search_path: boolean;
  app_private_usage_only: boolean;
  no_table_privileges: boolean;
  no_unexpected_private_function_execute: boolean;
}

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERIFIED_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONFLICT_MESSAGE = 'external event id was replayed with different payload bytes';

export class PropertyPredatorExternalEventReceiptConflictError extends Error {
  constructor() {
    super('Property Predator event ID was already received with different bytes');
    this.name = 'PropertyPredatorExternalEventReceiptConflictError';
  }
}

/** Force role verification and prove the narrow recorder capability exists. */
export async function assertPgPropertyPredatorExternalEventShadowStoreReady(
  pool: Pick<Pool, 'query'>,
): Promise<void> {
  const result = await pool.query<ShadowStoreReadinessRow>(
    `/* external-events.shadow-store-readiness */
     WITH recorder AS (
       SELECT procedure.oid,
              owner_role.rolname AS owner_name,
              procedure.prosecdef,
              procedure.proconfig
       FROM (
         SELECT pg_catalog.to_regprocedure(
           'app_private.record_external_event_shadow_receipt(uuid,text,uuid,text,smallint,timestamptz,uuid,text,uuid,bytea,jsonb,text,timestamptz)'
         ) AS oid
       ) AS target
       LEFT JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = target.oid
       LEFT JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
     )
     SELECT current_user::text AS database_user,
            recorder.oid IS NOT NULL AS recorder_exists,
            COALESCE(
              pg_catalog.has_function_privilege(current_user, recorder.oid, 'EXECUTE'),
              false
            ) AS recorder_executable,
            recorder.owner_name = 'r72_external_event_definer'
              AS recorder_owned_by_definer,
            recorder.prosecdef IS TRUE AS recorder_security_definer,
            recorder.proconfig = ARRAY['search_path=pg_catalog']::text[]
              AS recorder_fixed_search_path,
            pg_catalog.has_schema_privilege(current_user, 'app_private', 'USAGE')
              AND NOT pg_catalog.has_schema_privilege(current_user, 'app_private', 'CREATE')
              AND NOT pg_catalog.has_schema_privilege(current_user, 'app', 'USAGE')
              AND NOT pg_catalog.has_schema_privilege(current_user, 'app', 'CREATE')
              AS app_private_usage_only,
            NOT EXISTS (
              SELECT 1
              FROM pg_catalog.pg_class AS relation
              JOIN pg_catalog.pg_namespace AS namespace
                ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname IN ('app', 'app_private')
                AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
                AND (
                  pg_catalog.has_table_privilege(current_user, relation.oid, 'SELECT')
                  OR pg_catalog.has_table_privilege(current_user, relation.oid, 'INSERT')
                  OR pg_catalog.has_table_privilege(current_user, relation.oid, 'UPDATE')
                  OR pg_catalog.has_table_privilege(current_user, relation.oid, 'DELETE')
                  OR pg_catalog.has_table_privilege(current_user, relation.oid, 'TRUNCATE')
                  OR pg_catalog.has_table_privilege(current_user, relation.oid, 'REFERENCES')
                  OR pg_catalog.has_table_privilege(current_user, relation.oid, 'TRIGGER')
                )
            ) AS no_table_privileges,
            NOT EXISTS (
              SELECT 1
              FROM pg_catalog.pg_proc AS candidate
              JOIN pg_catalog.pg_namespace AS namespace
                ON namespace.oid = candidate.pronamespace
              WHERE namespace.nspname = 'app_private'
                AND pg_catalog.has_function_privilege(current_user, candidate.oid, 'EXECUTE')
                AND candidate.oid NOT IN (
                  recorder.oid,
                  pg_catalog.to_regprocedure('app_private.current_workspace_id()'),
                  pg_catalog.to_regprocedure('app_private.current_actor_kind()'),
                  pg_catalog.to_regprocedure('app_private.current_request_id()')
                )
            ) AS no_unexpected_private_function_execute
     FROM recorder`,
  );
  const row = result.rows[0];
  if (result.rows.length !== 1
      || row?.database_user !== 'r72_external_event_command'
      || row.recorder_exists !== true
      || row.recorder_executable !== true
      || row.recorder_owned_by_definer !== true
      || row.recorder_security_definer !== true
      || row.recorder_fixed_search_path !== true
      || row.app_private_usage_only !== true
      || row.no_table_privileges !== true
      || row.no_unexpected_private_function_execute !== true) {
    throw new Error('Property Predator external-event receipt store is not ready');
  }
}

function isReceiptConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as PgErrorLike;
  return candidate.code === '22000' && candidate.message === CONFLICT_MESSAGE;
}

function validateVerifiedSignature(
  signature: VerifiedPropertyPredatorExternalEventSignature,
): void {
  if (!signature
      || signature.signatureVersion !== 'v1'
      || typeof signature.keyId !== 'string'
      || !VERIFIED_KEY_ID_PATTERN.test(signature.keyId)
      || !Number.isSafeInteger(signature.timestampSeconds)
      || signature.timestampSeconds < 0) {
    throw new TypeError('verifiedSignature is invalid');
  }
}

/**
 * Receipt-only PostgreSQL bridge for Property Predator.
 *
 * Workspace authority is constructor-injected server configuration. The event
 * is parsed again from the same verified raw bytes and can never select its own
 * workspace. The SQL capability only journals a shadow receipt.
 */
export class PgPropertyPredatorExternalEventShadowService {
  readonly #commandPool: Pick<Pool, 'connect'>;
  readonly #workspaceId: string;

  constructor(dependencies: PgPropertyPredatorExternalEventShadowServiceDependencies) {
    if (!CANONICAL_UUID_PATTERN.test(dependencies.workspaceId)) {
      throw new TypeError('workspaceId must be a canonical lowercase UUID');
    }
    this.#commandPool = dependencies.commandPool;
    this.#workspaceId = dependencies.workspaceId;
  }

  async record(
    input: PropertyPredatorExternalEventShadowRecordInput,
  ): Promise<PropertyPredatorExternalEventShadowRecordResult> {
    validateVerifiedSignature(input.verifiedSignature);
    const event = parsePropertyPredatorExternalEventBody(input.rawBody);
    const payloadSha256 = createHash('sha256').update(input.rawBody).digest();
    const signatureTimestamp = new Date(
      input.verifiedSignature.timestampSeconds * 1_000,
    );
    if (!Number.isFinite(signatureTimestamp.getTime())) {
      throw new TypeError('verifiedSignature timestamp is outside the supported date range');
    }

    try {
      return await withTransaction(
        this.#commandPool,
        {
          actorKind: 'webhook',
          workspaceId: this.#workspaceId,
          requestId: `property-predator:${event.id}`,
        },
        async (transaction) => {
          const result = await transaction.query<ShadowReceiptRow>(
            `/* external-events.record-property-predator-shadow */
             SELECT disposition, replayed
             FROM app_private.record_external_event_shadow_receipt(
               $1, $2, $3, $4, $5, $6, $7,
               $8, $9, $10, $11::jsonb, $12, $13
             )`,
            [
              this.#workspaceId,
              PROPERTY_PREDATOR_EXTERNAL_EVENT_SOURCE,
              event.id,
              event.type,
              event.version,
              event.occurredAt,
              event.correlationId,
              event.subject.kind,
              event.subject.id,
              payloadSha256,
              JSON.stringify(event),
              input.verifiedSignature.keyId,
              signatureTimestamp.toISOString(),
            ],
          );
          const row = result.rows[0];
          if (result.rows.length !== 1
              || row?.disposition !== 'shadow'
              || typeof row.replayed !== 'boolean') {
            throw new Error('External event shadow receipt returned invalid canonical data');
          }
          return Object.freeze({ disposition: 'shadow', replayed: row.replayed });
        },
      );
    } catch (error) {
      if (isReceiptConflict(error)) {
        throw new PropertyPredatorExternalEventReceiptConflictError();
      }
      throw error;
    }
  }
}
