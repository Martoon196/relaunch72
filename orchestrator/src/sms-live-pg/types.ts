import type { Pool } from 'pg';
import type { DatabaseRequestContext } from '../db/rls.js';

export const SMS_DAILY_SEGMENT_CAP = 10 as const;
export const SMS_MONTHLY_SEGMENT_CAP = 50 as const;
export const SMS_RECIPIENTS_PER_JOB = 1 as const;

export type TwilioSmsLiveUserContext = DatabaseRequestContext & Readonly<{
  actorKind: 'user';
  userId: string;
  portalSessionTokenHash: Buffer;
}>;

/**
 * Identifiers and digests only. The browser never supplies a phone number;
 * the database resolves the exact verified endpoint behind the delivery.
 */
export interface AuthorizeTwilioSmsLiveCommand {
  readonly messageVersionId: string;
  readonly messageApprovalRequestId: string;
  readonly messageApprovalDecisionId: string;
  readonly channelEndpointId: string;
  readonly consentEventId: string;
  readonly complianceSubjectId: string;
  readonly policyPublicationEventId: string;
  readonly pecrSenderDecisionEventId: string;
  readonly pecrInstigatorDecisionEventId: string;
  readonly permissionUseReceiptId: string;
  readonly authorityValidUntil: string;
  readonly providerOperationId: string;
  readonly messageDeliveryId: string;
  readonly correlationId: string;
  readonly idempotencyKeySha256: string;
  readonly requestSha256: string;
  readonly expectedSegmentCount: number;
}

export interface AuthorizeTwilioSmsLiveResult {
  readonly jobId: string;
  readonly disposition: 'queued' | 'replayed';
  /** Enqueueing is evidence-only and cannot invoke Twilio. */
  readonly providerEffects: 'none';
  readonly caps: Readonly<{
    dailySegments: typeof SMS_DAILY_SEGMENT_CAP;
    monthlySegments: typeof SMS_MONTHLY_SEGMENT_CAP;
    recipientsPerJob: typeof SMS_RECIPIENTS_PER_JOB;
  }>;
}

export type TwilioSmsWebhookDisposition = 'applied' | 'replayed' | 'conflict' | 'not_applicable';

export interface TwilioSmsLiveCommandServiceDependencies {
  readonly commandPool: Pick<Pool, 'connect'>;
  readonly workspaceId: string;
  readonly providerConnectionId: string;
}

export interface TwilioSmsWebhookRepositoryDependencies {
  readonly commandPool: Pick<Pool, 'connect'>;
  readonly workspaceId: string;
  readonly providerConnectionId: string;
}

export class TwilioSmsLivePgContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TwilioSmsLivePgContractError';
  }
}
