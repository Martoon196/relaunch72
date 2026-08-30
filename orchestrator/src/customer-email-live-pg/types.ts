import type { Pool } from 'pg';
import type { DatabaseRequestContext } from '../db/rls.js';

export const CUSTOMER_EMAIL_DAILY_CAP = 10 as const;
export const CUSTOMER_EMAIL_MONTHLY_CAP = 50 as const;
export const CUSTOMER_EMAIL_RECIPIENTS_PER_JOB = 1 as const;

export type CustomerEmailLiveUserContext = DatabaseRequestContext & Readonly<{
  actorKind: 'user';
  userId: string;
  portalSessionTokenHash: Buffer;
}>;

/**
 * Identifiers only: the database resolves and revalidates all campaign,
 * recipient, consent, suppression and operator evidence inside one command.
 */
export interface AuthorizeCustomerEmailLiveCommand {
  readonly campaignTemplateVersionId: string;
  readonly campaignTemplateStepId: string;
  readonly campaignStepContentSha256: string;
  readonly campaignApprovalRequestId: string;
  readonly campaignApprovalDecisionId: string;
  readonly messageVersionId: string;
  readonly messageApprovalRequestId: string;
  readonly messageApprovalDecisionId: string;
  readonly channelEndpointId: string;
  readonly messageDeliveryId: string;
  readonly consentEventId: string;
  readonly complianceSubjectId: string;
  readonly policyPublicationEventId: string;
  readonly pecrSenderDecisionEventId: string;
  readonly pecrInstigatorDecisionEventId: string;
  readonly permissionUseReceiptId: string;
  readonly authorityValidUntil: string;
  readonly providerOperationId: string;
  readonly correlationId: string;
  readonly idempotencyKeySha256: string;
  readonly requestSha256: string;
}

export interface AuthorizeCustomerEmailLiveResult {
  readonly jobId: string;
  readonly disposition: 'queued' | 'replayed';
  /** Enqueueing is evidence-only and cannot invoke Mailgun. */
  readonly providerEffects: 'none';
  readonly caps: Readonly<{
    daily: typeof CUSTOMER_EMAIL_DAILY_CAP;
    monthly: typeof CUSTOMER_EMAIL_MONTHLY_CAP;
    recipientsPerJob: typeof CUSTOMER_EMAIL_RECIPIENTS_PER_JOB;
  }>;
}

export interface CustomerEmailLiveCommandService {
  /**
   * The one workspace this enqueue is bound to at construction. Exposed so a
   * composing seam can refuse another workspace's session itself, rather than
   * letting the refusal surface as an opaque database denial.
   */
  readonly workspaceId: string;
  authorizeAndEnqueue(
    context: CustomerEmailLiveUserContext,
    command: AuthorizeCustomerEmailLiveCommand,
  ): Promise<AuthorizeCustomerEmailLiveResult>;
}

export type CustomerEmailSignedReceiptDisposition =
  | 'applied'
  | 'replayed'
  | 'not_applicable';

export interface CustomerEmailSignedReceiptProjector {
  recordSignedReceipt(
    externalEventId: string,
  ): Promise<CustomerEmailSignedReceiptDisposition>;
}

export interface CustomerEmailLiveCommandServiceDependencies {
  readonly commandPool: Pick<Pool, 'connect'>;
  readonly workspaceId: string;
  readonly providerConnectionId: string;
}

export interface CustomerEmailSignedReceiptProjectorDependencies {
  readonly commandPool: Pick<Pool, 'connect'>;
  readonly workspaceId: string;
  readonly providerConnectionId: string;
}

export class CustomerEmailLivePgContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomerEmailLivePgContractError';
  }
}
