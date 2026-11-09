import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import type { ProviderOperationResult } from '../providers/contracts.js';
import {
  ProviderOperationConsentChangedError,
  ProviderOperationLeaseLostError,
  type ProviderOperationClaim,
  type ProviderOperationLeaseIdentity,
  type ProviderOperationQueue,
  type ProviderOperationSettlement,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_KEY = /^[\x21-\x7e]{1,200}$/;
const SAFE_CODE = /^[a-z][a-z0-9_.:-]{0,99}$/;
const CLAIM_KINDS = new Set(['dispatch', 'reconcile']);
const SETTLEMENT_STATES = new Set([
  'accepted', 'succeeded', 'retry_wait', 'failed',
  'reconciliation_required', 'dead_letter',
]);
const DELIVERY_STATES = new Set(['queued', 'accepted', 'failed', 'reconciliation_required']);

interface ClaimRow extends QueryResultRow {
  operationId: string;
  workspaceId: string;
  providerConnectionId: string;
  messageDeliveryId: string;
  environment: string;
  idempotencyKey: string;
  correlationId: string;
  attemptNumber: number | string;
  leaseVersion: number | string;
  leaseExpiresAt: string | Date;
  attemptKind: string;
  providerReference: string | null;
}

interface SettlementRow extends QueryResultRow {
  operationState: string;
  deliveryStatus: string;
  completedAt: string | Date | null;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error(`${field} returned an invalid UUID`);
  }
  return value.toLowerCase();
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} returned an invalid integer`);
  }
  return parsed;
}

function timestamp(value: unknown, field: string): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    const kind = value === null ? 'null' : value === undefined ? 'undefined' : typeof value;
    throw new Error(`${field} returned an invalid timestamp (${kind})`);
  }
  return parsed.toISOString();
}

function validateLease(lease: ProviderOperationLeaseIdentity): Buffer {
  uuid(lease.workerId, 'workerId');
  const token = Buffer.from(lease.leaseToken);
  if (token.length !== 32) throw new Error('leaseToken must contain exactly 32 bytes');
  return createHash('sha256').update(token).digest();
}

function validateClaim(row: ClaimRow): ProviderOperationClaim {
  if (row.environment !== 'test'
      || typeof row.idempotencyKey !== 'string' || !SAFE_KEY.test(row.idempotencyKey)
      || !CLAIM_KINDS.has(row.attemptKind)
      || (row.providerReference !== null
        && (typeof row.providerReference !== 'string'
          || row.providerReference !== row.providerReference.trim()
          || row.providerReference.length < 1 || row.providerReference.length > 500))) {
    throw new Error('Provider operation claim returned invalid canonical data');
  }
  const attemptKind = row.attemptKind as ProviderOperationClaim['attemptKind'];
  if (attemptKind === 'reconcile' && row.providerReference === null) {
    throw new Error('Reconciliation claim is missing its provider reference');
  }
  return Object.freeze({
    operationId: uuid(row.operationId, 'operationId'),
    workspaceId: uuid(row.workspaceId, 'workspaceId'),
    providerConnectionId: uuid(row.providerConnectionId, 'providerConnectionId'),
    messageDeliveryId: uuid(row.messageDeliveryId, 'messageDeliveryId'),
    environment: 'test',
    idempotencyKey: row.idempotencyKey,
    correlationId: uuid(row.correlationId, 'correlationId'),
    attemptNumber: integer(row.attemptNumber, 'attemptNumber', 1, 8),
    leaseVersion: integer(row.leaseVersion, 'leaseVersion', 1, Number.MAX_SAFE_INTEGER),
    leaseExpiresAt: timestamp(row.leaseExpiresAt, 'leaseExpiresAt'),
    attemptKind,
    providerReference: row.providerReference,
  });
}

function validateResult(result: ProviderOperationResult): void {
  if (!['accepted', 'pending', 'succeeded', 'failed', 'needs_attention'].includes(result.status)
      || typeof result.retryable !== 'boolean'
      || typeof result.summary !== 'string' || result.summary !== result.summary.trim()
      || result.summary.length < 1 || result.summary.length > 500
      || !Number.isFinite(new Date(result.occurredAt).getTime())
      || (result.externalId !== null
        && (result.externalId !== result.externalId.trim()
          || result.externalId.length < 1 || result.externalId.length > 500))
      || (result.errorCode !== null && !SAFE_CODE.test(result.errorCode))
      || (result.status === 'failed' && result.errorCode === null)
      || (['accepted', 'succeeded'].includes(result.status) && result.externalId === null)) {
    throw new Error('Provider returned an invalid normalized operation result');
  }
}

function translateLeaseError(error: unknown): never {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (code === '40001') throw new ProviderOperationLeaseLostError();
  }
  throw error;
}

export class PgProviderOperationQueue implements ProviderOperationQueue {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async claim(
    lease: ProviderOperationLeaseIdentity,
    options: Readonly<{ batchSize?: number; leaseSeconds?: number }> = {},
  ): Promise<readonly ProviderOperationClaim[]> {
    const leaseHash = validateLease(lease);
    const batchSize = options.batchSize ?? 1;
    const leaseSeconds = options.leaseSeconds ?? 60;
    integer(batchSize, 'batchSize', 1, 25);
    integer(leaseSeconds, 'leaseSeconds', 15, 300);
    const result = await this.pool.query<ClaimRow>(
      `/* provider-operations.claim */
       SELECT operation_id AS "operationId", workspace_id AS "workspaceId",
              provider_connection_id AS "providerConnectionId",
              message_delivery_id AS "messageDeliveryId", environment,
              idempotency_key AS "idempotencyKey", correlation_id AS "correlationId",
              attempt_number AS "attemptNumber", lease_version AS "leaseVersion",
              lease_expires_at AS "leaseExpiresAt", attempt_kind AS "attemptKind",
              provider_reference AS "providerReference"
       FROM app_private.claim_provider_operations($1, $2, $3, $4)`,
      [lease.workerId, leaseHash, batchSize, leaseSeconds],
    );
    if (result.rows.length > batchSize) {
      throw new Error('Provider operation claim exceeded its requested bound');
    }
    return Object.freeze(result.rows.map(validateClaim));
  }

  async markCalling(
    claim: ProviderOperationClaim,
    lease: ProviderOperationLeaseIdentity,
  ): Promise<void> {
    const leaseHash = validateLease(lease);
    try {
      const result = await this.pool.query<{ marked: boolean } & QueryResultRow>(
        `/* provider-operations.mark-calling */
         SELECT app_private.mark_provider_operation_calling($1, $2, $3, $4, $5)
           AS marked`,
        [claim.workspaceId, claim.operationId, lease.workerId, leaseHash, claim.leaseVersion],
      );
      if (result.rows.length !== 1 || result.rows[0]?.marked !== true) {
        throw new ProviderOperationLeaseLostError();
      }
    } catch (error) {
      if (error instanceof ProviderOperationLeaseLostError) throw error;
      if (error && typeof error === 'object' && 'code' in error
          && (error as { code?: unknown }).code === '42501') {
        throw new ProviderOperationConsentChangedError();
      }
      translateLeaseError(error);
    }
  }

  async renew(
    claim: ProviderOperationClaim,
    lease: ProviderOperationLeaseIdentity,
    leaseSeconds = 60,
  ): Promise<string> {
    const leaseHash = validateLease(lease);
    integer(leaseSeconds, 'leaseSeconds', 15, 300);
    try {
      const result = await this.pool.query<{ expiresAt: string | Date } & QueryResultRow>(
        `/* provider-operations.renew */
         SELECT app_private.renew_provider_operation_lease($1, $2, $3, $4, $5, $6)
           AS "expiresAt"`,
        [claim.workspaceId, claim.operationId, lease.workerId,
          leaseHash, claim.leaseVersion, leaseSeconds],
      );
      if (result.rows.length !== 1 || !result.rows[0]) {
        throw new ProviderOperationLeaseLostError();
      }
      return timestamp(result.rows[0].expiresAt, 'expiresAt');
    } catch (error) {
      if (error instanceof ProviderOperationLeaseLostError) throw error;
      translateLeaseError(error);
    }
  }

  async cancelBeforeCall(
    claim: ProviderOperationClaim,
    lease: ProviderOperationLeaseIdentity,
    input: Readonly<{ errorCode: string; safeSummary: string }>,
  ): Promise<void> {
    const leaseHash = validateLease(lease);
    if (!SAFE_CODE.test(input.errorCode)
        || input.safeSummary !== input.safeSummary.trim()
        || input.safeSummary.length < 1 || input.safeSummary.length > 500) {
      throw new Error('Provider operation cancellation reason is invalid');
    }
    try {
      const result = await this.pool.query<{ cancelled: boolean } & QueryResultRow>(
        `/* provider-operations.cancel-before-call */
         SELECT app_private.cancel_provider_operation_before_call(
           $1, $2, $3, $4, $5, $6, $7
         ) AS cancelled`,
        [claim.workspaceId, claim.operationId, lease.workerId, leaseHash,
          claim.leaseVersion, input.errorCode, input.safeSummary],
      );
      if (result.rows.length !== 1 || result.rows[0]?.cancelled !== true) {
        throw new ProviderOperationLeaseLostError();
      }
    } catch (error) {
      if (error instanceof ProviderOperationLeaseLostError) throw error;
      translateLeaseError(error);
    }
  }

  async settle(
    claim: ProviderOperationClaim,
    lease: ProviderOperationLeaseIdentity,
    result: ProviderOperationResult,
  ): Promise<ProviderOperationSettlement> {
    validateResult(result);
    const leaseHash = validateLease(lease);
    try {
      const settled = await this.pool.query<SettlementRow>(
        `/* provider-operations.settle */
         SELECT operation_state AS "operationState",
                delivery_status AS "deliveryStatus", completed_at AS "completedAt"
         FROM app_private.settle_provider_operation(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz
         )`,
        [claim.workspaceId, claim.operationId, lease.workerId, leaseHash,
          claim.leaseVersion, result.status, result.externalId, result.retryable,
          result.errorCode, result.summary, result.occurredAt],
      );
      const row = settled.rows[0];
      if (settled.rows.length !== 1 || !row
          || !SETTLEMENT_STATES.has(row.operationState)
          || !DELIVERY_STATES.has(row.deliveryStatus)
          || (row.completedAt !== null && !Number.isFinite(new Date(row.completedAt).getTime()))) {
        throw new Error('Provider operation settlement returned invalid canonical data');
      }
      return Object.freeze({
        operationState: row.operationState as ProviderOperationSettlement['operationState'],
        deliveryStatus: row.deliveryStatus as ProviderOperationSettlement['deliveryStatus'],
        completedAt: row.completedAt === null ? null : timestamp(row.completedAt, 'completedAt'),
      });
    } catch (error) {
      translateLeaseError(error);
    }
  }
}

export function createPgProviderOperationQueue(
  pool: Pick<Pool, 'query'>,
): ProviderOperationQueue {
  return new PgProviderOperationQueue(pool);
}
