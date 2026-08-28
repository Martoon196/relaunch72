import type { ProviderOperationResult } from '../providers/contracts.js';

export interface PropertyPredatorMailgunJobLease {
  readonly jobId: string;
  readonly leaseVersion: number;
}

export type PropertyPredatorMailgunBeginDecision =
  | Readonly<{ disposition: 'blocked'; reason: string }>
  | Readonly<{ disposition: 'replay' }>
  | Readonly<{
    disposition: 'authorized';
    jobId: string;
    operationId: string;
    correlationId: string;
    providerConnectionId: string;
    reservationId: string;
    requestSha256: string;
    expectedMessageId: string;
    recipient: string;
    subject: string;
    text: string;
  }>;

export interface PropertyPredatorMailgunWorkerRepository {
  claimOne(leaseToken: Uint8Array, leaseSeconds: number): Promise<PropertyPredatorMailgunJobLease | null>;
  renew(
    lease: PropertyPredatorMailgunJobLease,
    leaseToken: Uint8Array,
    leaseSeconds: number,
  ): Promise<boolean>;
  beginCall(
    lease: PropertyPredatorMailgunJobLease,
    leaseToken: Uint8Array,
    limits: Readonly<{
      runSpendCapUsdMicros: number;
      monthSpendCapUsdMicros: number;
    }>,
  ): Promise<PropertyPredatorMailgunBeginDecision>;
  settle(
    lease: PropertyPredatorMailgunJobLease,
    leaseToken: Uint8Array,
    result: ProviderOperationResult,
  ): Promise<boolean>;
  recoverOne(): Promise<Readonly<{
    jobId: string;
    disposition:
      | 'requeued_before_call'
      | 'claim_attempts_exhausted'
      | 'reconciliation_required'
      | 'signed_webhook_reconciled';
  }> | null>;
}
