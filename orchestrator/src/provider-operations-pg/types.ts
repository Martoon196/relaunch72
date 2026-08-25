import type { ProviderOperationResult } from '../providers/contracts.js';

export type ProviderOperationAttemptKind = 'dispatch' | 'reconcile';

export interface ProviderOperationLeaseIdentity {
  readonly workerId: string;
  /** Opaque 32-byte secret retained only by the worker; PostgreSQL stores its hash. */
  readonly leaseToken: Uint8Array;
}

export interface ProviderOperationClaim {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly providerConnectionId: string;
  readonly messageDeliveryId: string;
  readonly environment: 'test';
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly attemptNumber: number;
  readonly leaseVersion: number;
  readonly leaseExpiresAt: string;
  readonly attemptKind: ProviderOperationAttemptKind;
  readonly providerReference: string | null;
}

export interface ProviderOperationSettlement {
  readonly operationState:
    | 'accepted'
    | 'succeeded'
    | 'retry_wait'
    | 'failed'
    | 'reconciliation_required'
    | 'dead_letter';
  readonly deliveryStatus:
    | 'queued'
    | 'accepted'
    | 'failed'
    | 'reconciliation_required';
  readonly completedAt: string | null;
}

export interface ProviderOperationQueue {
  claim(
    lease: ProviderOperationLeaseIdentity,
    options?: Readonly<{ batchSize?: number; leaseSeconds?: number }>,
  ): Promise<readonly ProviderOperationClaim[]>;
  markCalling(
    claim: ProviderOperationClaim,
    lease: ProviderOperationLeaseIdentity,
  ): Promise<void>;
  renew(
    claim: ProviderOperationClaim,
    lease: ProviderOperationLeaseIdentity,
    leaseSeconds?: number,
  ): Promise<string>;
  cancelBeforeCall(
    claim: ProviderOperationClaim,
    lease: ProviderOperationLeaseIdentity,
    input: Readonly<{ errorCode: string; safeSummary: string }>,
  ): Promise<void>;
  settle(
    claim: ProviderOperationClaim,
    lease: ProviderOperationLeaseIdentity,
    result: ProviderOperationResult,
  ): Promise<ProviderOperationSettlement>;
}

export class ProviderOperationLeaseLostError extends Error {
  constructor() {
    super('Provider operation lease was lost');
    this.name = 'ProviderOperationLeaseLostError';
  }
}

export class ProviderOperationConsentChangedError extends Error {
  constructor() {
    super('Provider operation consent changed before the provider call');
    this.name = 'ProviderOperationConsentChangedError';
  }
}
