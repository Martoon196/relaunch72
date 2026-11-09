import type { DatabaseRequestContext } from '../db/rls.js';

export const COMMUNICATION_CHANNELS = [
  'email', 'sms', 'whatsapp', 'phone', 'social', 'webinar', 'web',
] as const;

export type CommunicationChannel = (typeof COMMUNICATION_CHANNELS)[number];
export type CommunicationEligibilityStatus = 'allowed' | 'blocked' | 'unknown';
export type CommunicationEligibilityReason =
  | 'granted'
  | 'denied'
  | 'withdrawn'
  | 'suppressed'
  | 'endpoint_unavailable'
  | 'no_evidence';

export interface CommunicationEligibilityQuery {
  readonly contactPointId: string;
  readonly channel: CommunicationChannel;
  readonly purpose: string;
}

export interface CommunicationEligibilityResult {
  readonly status: CommunicationEligibilityStatus;
  readonly reason: CommunicationEligibilityReason;
  readonly consentEventId: string | null;
  readonly suppressionEventId: string | null;
}

export interface CommunicationEligibilitySqlResult<TRow extends Record<string, unknown>> {
  readonly rows: readonly TRow[];
}

export interface CommunicationEligibilitySqlExecutor {
  query<TRow extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<CommunicationEligibilitySqlResult<TRow>>;
}

export interface CommunicationEligibilityTransactionRunner {
  run<T>(
    context: DatabaseRequestContext,
    operation: (transaction: CommunicationEligibilitySqlExecutor) => Promise<T>,
  ): Promise<T>;
}
