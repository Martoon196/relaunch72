import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type {
  ControlledEmailPilotBoundary,
  ControlledEmailPilotBoundaryDecision,
  ControlledEmailPilotBoundaryInput,
  ControlledEmailPilotCurrentEvidence,
} from '../providers/controlled-property-predator-email-pilot.js';
import type { ProviderOperationResult } from '../providers/contracts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_REASON = /^[a-z][a-z0-9_.:-]{0,99}$/;
const DISPOSITIONS = new Set(['blocked', 'replay', 'authorized']);
const RESULT_STATUSES = new Set(['accepted', 'pending', 'succeeded', 'failed', 'needs_attention']);

interface AuthorizationRow extends QueryResultRow {
  disposition: string;
  reason: string | null;
  reservationId: string | null;
  requestSha256: Buffer | string | null;
  evidence: unknown;
  providerResult: unknown;
}

interface PgErrorLike {
  code?: unknown;
}

export interface PropertyPredatorEmailPilotRuntimeEvidence {
  readonly providerEffectsEnabled: boolean;
  readonly emailDeliveryEnabled: boolean;
  readonly emergencyPaused: boolean;
}

export interface PgControlledEmailPilotBoundaryDependencies {
  readonly commandPool: Pick<Pool, 'connect'>;
  /** Trusted workspace from the same validated pilot policy as the coordinator. */
  readonly workspaceId: string;
  /** Exact values read from the fail-closed runtime policy. */
  readonly runtimeEvidence: PropertyPredatorEmailPilotRuntimeEvidence;
}

export class PropertyPredatorEmailPilotReservationConflictError extends Error {
  constructor() {
    super('The controlled email reservation changed concurrently');
    this.name = 'PropertyPredatorEmailPilotReservationConflictError';
  }
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error(`${label} returned an invalid UUID`);
  }
  return value;
}

function digest(value: string, label: string): Buffer {
  if (!SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return Buffer.from(value, 'hex');
}

function returnedDigest(value: Buffer | string | null, label: string): string {
  const candidate = Buffer.isBuffer(value)
    ? value.toString('hex')
    : typeof value === 'string' && value.startsWith('\\x') ? value.slice(2) : value;
  if (typeof candidate !== 'string' || !SHA256.test(candidate)) {
    throw new Error(`${label} returned an invalid SHA-256 digest`);
  }
  return candidate;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} returned invalid JSON evidence`);
  }
  return value as Record<string, unknown>;
}

function providerResult(value: unknown): ProviderOperationResult {
  const candidate = object(value, 'providerResult');
  if (typeof candidate.status !== 'string' || !RESULT_STATUSES.has(candidate.status)
      || (candidate.externalId !== null && typeof candidate.externalId !== 'string')
      || typeof candidate.occurredAt !== 'string'
      || !Number.isFinite(new Date(candidate.occurredAt).getTime())
      || typeof candidate.retryable !== 'boolean'
      || (candidate.errorCode !== null
        && (typeof candidate.errorCode !== 'string' || !SAFE_REASON.test(candidate.errorCode)))
      || typeof candidate.summary !== 'string'
      || candidate.summary.trim() !== candidate.summary
      || candidate.summary.length < 1 || candidate.summary.length > 500) {
    throw new Error('providerResult returned invalid canonical data');
  }
  return Object.freeze({
    status: candidate.status as ProviderOperationResult['status'],
    externalId: candidate.externalId as string | null,
    occurredAt: new Date(candidate.occurredAt).toISOString(),
    retryable: candidate.retryable,
    errorCode: candidate.errorCode as string | null,
    summary: candidate.summary,
  });
}

function currentEvidence(value: unknown): ControlledEmailPilotCurrentEvidence {
  // The coordinator performs the exact field-by-field comparison immediately
  // after this parser. We still reject non-object/array-shaped database output.
  const candidate = object(value, 'evidence');
  if (!Array.isArray(candidate.recipients)
      || !candidate.approval || typeof candidate.approval !== 'object'
      || !candidate.usageAfterReservation
      || typeof candidate.usageAfterReservation !== 'object') {
    throw new Error('evidence returned invalid canonical data');
  }
  return Object.freeze(candidate) as unknown as ControlledEmailPilotCurrentEvidence;
}

function translateConflict(error: unknown): never {
  if (error && typeof error === 'object'
      && (error as PgErrorLike).code === '40001') {
    throw new PropertyPredatorEmailPilotReservationConflictError();
  }
  throw error;
}

function validateRuntimeEvidence(
  evidence: PropertyPredatorEmailPilotRuntimeEvidence,
): PropertyPredatorEmailPilotRuntimeEvidence {
  if (typeof evidence.providerEffectsEnabled !== 'boolean'
      || typeof evidence.emailDeliveryEnabled !== 'boolean'
      || typeof evidence.emergencyPaused !== 'boolean') {
    throw new TypeError('Controlled email runtime evidence must contain exact booleans');
  }
  return Object.freeze({ ...evidence });
}

export class PgControlledEmailPilotBoundary implements ControlledEmailPilotBoundary {
  readonly #commandPool: Pick<Pool, 'connect'>;
  readonly #workspaceId: string;
  readonly #runtimeEvidence: PropertyPredatorEmailPilotRuntimeEvidence;

  constructor(dependencies: Readonly<PgControlledEmailPilotBoundaryDependencies>) {
    this.#commandPool = dependencies.commandPool;
    this.#workspaceId = uuid(dependencies.workspaceId, 'workspaceId');
    this.#runtimeEvidence = validateRuntimeEvidence(dependencies.runtimeEvidence);
  }

  async authorizeImmediatelyBeforeProviderCall(
    input: ControlledEmailPilotBoundaryInput,
  ): Promise<ControlledEmailPilotBoundaryDecision> {
    if (input.workspaceId !== this.#workspaceId) {
      return Object.freeze({ disposition: 'blocked', reason: 'wrong_workspace' });
    }
    const requestId = `mailgun-pilot:${createHash('sha256')
      .update(input.idempotencyKeySha256, 'utf8').digest('hex').slice(0, 48)}`;
    try {
      return await withTransaction(
        this.#commandPool,
        { actorKind: 'worker', workspaceId: input.workspaceId, requestId },
        async (transaction) => {
        const recipients = input.recipients.map((recipient) => ({
          contact_point_id: recipient.contactPointId,
          consent_event_id: recipient.consentEventId,
          email_sha256: recipient.emailSha256,
        }));
        const result = await transaction.query<AuthorizationRow>(
          `/* property-predator-email-pilot.authorize-immediately-before-call */
           SELECT disposition, reason, reservation_id AS "reservationId",
                  request_sha256 AS "requestSha256", evidence,
                  provider_result AS "providerResult"
           FROM app_private.authorize_property_predator_email_pilot(
             $1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10,
             $11, $12, $13, $14, $15::jsonb, $16, $17, $18, $19,
             $20, $21, $22, $23, $24
           )`,
          [
            input.workspaceId,
            input.providerConnectionId,
            input.operationId,
            input.correlationId,
            digest(input.idempotencyKeySha256, 'idempotencyKeySha256'),
            digest(input.requestSha256, 'requestSha256'),
            input.runId,
            `${input.utcMonth}-01`,
            input.stage,
            input.recipientScope,
            input.approval.messageVersionId,
            input.approval.approvalRequestId,
            input.approval.approvalDecisionId,
            digest(input.approval.approvedContentSha256, 'approvedContentSha256'),
            JSON.stringify(recipients),
            input.requestedMessages,
            input.estimatedSpendUsdMicros,
            input.limits.maxMessagesPerRun,
            input.limits.maxMessagesPerUtcMonth,
            input.limits.maxSpendUsdMicrosPerRun,
            input.limits.maxSpendUsdMicrosPerUtcMonth,
            this.#runtimeEvidence.providerEffectsEnabled,
            this.#runtimeEvidence.emailDeliveryEnabled,
            this.#runtimeEvidence.emergencyPaused,
          ],
        );
        const row = result.rows[0];
        if (result.rows.length !== 1 || !row || !DISPOSITIONS.has(row.disposition)) {
          throw new Error('Controlled email authorization returned invalid canonical data');
        }
        if (row.disposition === 'blocked') {
          if (typeof row.reason !== 'string' || !SAFE_REASON.test(row.reason)) {
            throw new Error('Controlled email authorization returned an invalid block reason');
          }
          return Object.freeze({ disposition: 'blocked', reason: row.reason });
        }
        const requestSha256 = returnedDigest(row.requestSha256, 'requestSha256');
        if (row.disposition === 'replay') {
          return Object.freeze({
            disposition: 'replay',
            requestSha256,
            result: providerResult(row.providerResult),
          });
        }
        return Object.freeze({
          disposition: 'authorized',
          reservationId: uuid(row.reservationId, 'reservationId'),
          requestSha256,
          evidence: currentEvidence(row.evidence),
        });
        },
        { isolation: 'serializable' },
      );
    } catch (error) {
      translateConflict(error);
    }
  }

  async cancelBeforeProviderCall(
    reservationId: string,
    requestSha256: string,
    reason: string,
  ): Promise<void> {
    uuid(reservationId, 'reservationId');
    if (!SAFE_REASON.test(reason)) throw new TypeError('Cancellation reason is invalid');
    try {
      await withTransaction(
        this.#commandPool,
        {
          actorKind: 'worker',
          workspaceId: this.#workspaceId,
          requestId: `mailgun-cancel:${reservationId}`,
        },
        async (transaction) => {
          const result = await transaction.query<{ cancelled: boolean } & QueryResultRow>(
            `/* property-predator-email-pilot.cancel-before-call */
             SELECT app_private.cancel_property_predator_email_pilot_before_call(
               $1, $2, $3, $4
             ) AS cancelled`,
            [this.#workspaceId, reservationId, digest(requestSha256, 'requestSha256'), reason],
          );
          if (result.rows.length !== 1 || result.rows[0]?.cancelled !== true) {
            throw new PropertyPredatorEmailPilotReservationConflictError();
          }
        },
        { isolation: 'serializable' },
      );
    } catch (error) {
      if (error instanceof PropertyPredatorEmailPilotReservationConflictError) throw error;
      translateConflict(error);
    }
  }

  async settleProviderCall(
    reservationId: string,
    requestSha256: string,
    result: ProviderOperationResult,
  ): Promise<void> {
    uuid(reservationId, 'reservationId');
    const normalized = providerResult(result);
    try {
      await withTransaction(
        this.#commandPool,
        {
          actorKind: 'worker',
          workspaceId: this.#workspaceId,
          requestId: `mailgun-settle:${reservationId}`,
        },
        async (transaction) => {
          const settled = await transaction.query<{ settled: boolean } & QueryResultRow>(
            `/* property-predator-email-pilot.settle-call */
             SELECT app_private.settle_property_predator_email_pilot_call(
               $1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9
             ) AS settled`,
            [this.#workspaceId, reservationId, digest(requestSha256, 'requestSha256'),
              normalized.status, normalized.externalId, normalized.occurredAt,
              normalized.retryable, normalized.errorCode, normalized.summary],
          );
          if (settled.rows.length !== 1 || settled.rows[0]?.settled !== true) {
            throw new PropertyPredatorEmailPilotReservationConflictError();
          }
        },
        { isolation: 'serializable' },
      );
    } catch (error) {
      if (error instanceof PropertyPredatorEmailPilotReservationConflictError) throw error;
      translateConflict(error);
    }
  }
}

/** Prove the dedicated LOGIN can reach only the installed worker capability. */
export async function assertPropertyPredatorEmailPilotBoundaryReady(
  pool: Pick<Pool, 'query'>,
): Promise<void> {
  const result = await pool.query<{ ready: boolean } & QueryResultRow>(
    `/* property-predator-email-pilot.boundary-ready */
     SELECT app_private.property_predator_email_pilot_boundary_ready() AS ready`,
  );
  if (result.rows.length !== 1 || result.rows[0]?.ready !== true) {
    throw new Error('Controlled email pilot PostgreSQL boundary is not ready');
  }
}

export function createPgControlledEmailPilotBoundary(
  dependencies: Readonly<PgControlledEmailPilotBoundaryDependencies>,
): ControlledEmailPilotBoundary {
  return new PgControlledEmailPilotBoundary(dependencies);
}
