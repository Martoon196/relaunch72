import type { Pool } from 'pg';
import { validateDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { withTransaction } from '../db/transaction.js';
import {
  COMMUNICATION_CHANNELS,
  type CommunicationEligibilityQuery,
  type CommunicationEligibilityResult,
  type CommunicationEligibilitySqlExecutor,
  type CommunicationEligibilityTransactionRunner,
} from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PURPOSE_PATTERN = /^[a-z][a-z0-9_.-]{0,99}$/;

interface SuppressionRow extends Record<string, unknown> {
  id: string;
}

interface ConsentRow extends Record<string, unknown> {
  id: string;
  state: 'granted' | 'denied' | 'withdrawn';
}

interface EndpointRow extends Record<string, unknown> {
  identityHash: Uint8Array;
}

const CURRENT_ENDPOINT_SQL = `/* consent.eligibility.current-endpoint */
  SELECT public.digest(
           point.kind || pg_catalog.chr(31)
             || point.value || pg_catalog.chr(31)
             || point.normalized_value,
           'sha256'
         ) AS "identityHash"
  FROM app.contact_points AS point
  WHERE point.workspace_id = app_private.current_workspace_id()
    AND point.id = $1
    AND point.deleted_at IS NULL
    AND point.is_verified
    AND point.dedupe_state = 'normal'
    AND point.kind = CASE $2
      WHEN 'email' THEN 'email'
      WHEN 'sms' THEN 'phone'
      WHEN 'whatsapp' THEN 'whatsapp'
      WHEN 'phone' THEN 'phone'
      WHEN 'social' THEN 'social'
      WHEN 'webinar' THEN 'email'
      WHEN 'web' THEN 'other'
    END
  LIMIT 1`;

const ACTIVE_SUPPRESSION_SQL = `/* consent.eligibility.active-suppression */
  WITH latest_by_scope AS (
    SELECT DISTINCT ON (coalesce(event.purpose, ''))
           event.id,
           event.state,
           event.occurred_at,
           event.recorded_at
    FROM app.communication_suppression_events AS event
    WHERE event.workspace_id = app_private.current_workspace_id()
      AND event.contact_point_id = $1
      AND event.channel = $2
      AND (event.purpose IS NULL OR event.purpose = $3)
      AND event.endpoint_identity_sha256 = $4
      AND event.occurred_at <= statement_timestamp() + interval '5 minutes'
    ORDER BY coalesce(event.purpose, ''),
             event.occurred_at DESC,
             event.recorded_at DESC,
             event.id DESC
  )
  SELECT id
  FROM latest_by_scope
  WHERE state = 'suppressed'
  ORDER BY occurred_at DESC, recorded_at DESC, id DESC
  LIMIT 1`;

const LATEST_CONSENT_SQL = `/* consent.eligibility.latest-consent */
  SELECT event.id, event.state
  FROM app.communication_consent_events AS event
  WHERE event.workspace_id = app_private.current_workspace_id()
    AND event.contact_point_id = $1
    AND event.channel = $2
    AND event.purpose = $3
    AND event.endpoint_identity_sha256 = $4
    AND event.occurred_at <= statement_timestamp() + interval '5 minutes'
  ORDER BY event.occurred_at DESC, event.recorded_at DESC, event.id DESC
  LIMIT 1`;

function validateQuery(query: CommunicationEligibilityQuery): void {
  if (!UUID_PATTERN.test(query.contactPointId)) {
    throw new Error('contactPointId must be a UUID');
  }
  if (!(COMMUNICATION_CHANNELS as readonly string[]).includes(query.channel)) {
    throw new Error('channel is not supported');
  }
  if (!PURPOSE_PATTERN.test(query.purpose)) {
    throw new Error('purpose must be a safe lowercase key');
  }
}

function consentState(value: unknown): ConsentRow['state'] {
  if (value === 'granted' || value === 'denied' || value === 'withdrawn') return value;
  throw new Error('communication consent query returned an invalid state');
}

/**
 * Resolve permission from immutable evidence. The legacy mutable
 * contact_points.consent_status column is intentionally never consulted.
 */
export class CommunicationEligibilityService {
  constructor(private readonly transactionRunner: CommunicationEligibilityTransactionRunner) {}

  async evaluateEndpoint(
    context: DatabaseRequestContext,
    query: CommunicationEligibilityQuery,
  ): Promise<CommunicationEligibilityResult> {
    validateDatabaseContext(context);
    validateQuery(query);
    return this.transactionRunner.run(context, async (transaction) => {
      const endpointResult = await transaction.query<EndpointRow>(
        CURRENT_ENDPOINT_SQL,
        [query.contactPointId, query.channel],
      );
      const endpoint = endpointResult.rows[0] ?? null;
      if (!endpoint) {
        return Object.freeze({
          status: 'blocked',
          reason: 'endpoint_unavailable',
          consentEventId: null,
          suppressionEventId: null,
        });
      }
      const identityHash = Buffer.from(endpoint.identityHash);
      if (identityHash.length !== 32) {
        throw new Error('communication endpoint query returned an invalid identity digest');
      }
      const values = [query.contactPointId, query.channel, query.purpose, identityHash] as const;
      const [suppressionResult, consentResult] = await Promise.all([
        transaction.query<SuppressionRow>(ACTIVE_SUPPRESSION_SQL, values),
        transaction.query<ConsentRow>(LATEST_CONSENT_SQL, values),
      ]);
      const suppression = suppressionResult.rows[0] ?? null;
      const consent = consentResult.rows[0] ?? null;
      if (suppression) {
        return Object.freeze({
          status: 'blocked',
          reason: 'suppressed',
          consentEventId: consent?.id ?? null,
          suppressionEventId: suppression.id,
        });
      }
      if (!consent) {
        return Object.freeze({
          status: 'unknown',
          reason: 'no_evidence',
          consentEventId: null,
          suppressionEventId: null,
        });
      }
      const state = consentState(consent.state);
      return Object.freeze({
        status: state === 'granted' ? 'allowed' : 'blocked',
        reason: state,
        consentEventId: consent.id,
        suppressionEventId: null,
      });
    });
  }
}

export function createPgCommunicationEligibilityTransactionRunner(
  pool: Pick<Pool, 'connect'>,
): CommunicationEligibilityTransactionRunner {
  return {
    run<T>(
      context: DatabaseRequestContext,
      operation: (transaction: CommunicationEligibilitySqlExecutor) => Promise<T>,
    ): Promise<T> {
      return withTransaction(pool, context, async (client) => operation({
        async query<TRow extends Record<string, unknown>>(
          sql: string,
          values?: readonly unknown[],
        ) {
          const result = await client.query<TRow>(sql, values ? [...values] : undefined);
          return { rows: result.rows };
        },
      }), { isolation: 'repeatable read', readOnly: true });
    },
  };
}

export function createPgCommunicationEligibilityService(
  pool: Pick<Pool, 'connect'>,
): CommunicationEligibilityService {
  return new CommunicationEligibilityService(
    createPgCommunicationEligibilityTransactionRunner(pool),
  );
}
