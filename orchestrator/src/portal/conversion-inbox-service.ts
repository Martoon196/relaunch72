import type {
  InboxApprovalDecision,
  InboxMessageLifecycle,
} from '../inbox-pg/types.js';

/**
 * Opaque, server-owned portal identity. A browser form never supplies a
 * workspace id or user id; the PostgreSQL boundary resolves both from this
 * session token before applying RLS.
 */
export interface PortalConversionInboxRequestIdentity {
  readonly sessionToken: string;
  readonly requestId: string;
}

export interface PortalConversionInboxWorkspaceAccess {
  readonly workspaceId: string;
  readonly canWrite: boolean;
  readonly canManage: boolean;
}

export interface PortalInboxSourceContentInput {
  readonly versionRef: string;
  readonly sha256: string;
  readonly approvalRef: string;
}

/**
 * Form-ready mutation input. `_csrf` is deliberately absent: the router must
 * validate its session-bound token before it calls this service. commandKey is
 * retained for durable idempotency and all ownership is resolved server-side.
 */
export interface PortalCreateInboxDraftInput {
  readonly commandKey: string;
  readonly conversationId: string;
  readonly contactPointId: string;
  readonly body: string;
  readonly sourceContent?: PortalInboxSourceContentInput | null;
}

export interface PortalReviseInboxDraftInput {
  readonly commandKey: string;
  readonly messageId: string;
  /** Browser form value; parsed strictly before the command boundary. */
  readonly expectedRowVersion: string;
  readonly body: string;
  readonly sourceContent?: PortalInboxSourceContentInput | null;
}

export interface PortalRequestInboxApprovalInput {
  readonly commandKey: string;
  readonly messageId: string;
  /** Browser form value; parsed strictly before the command boundary. */
  readonly expectedRowVersion: string;
  readonly reviewNote?: string | null;
}

export interface PortalDecideInboxApprovalInput {
  readonly commandKey: string;
  readonly approvalRequestId: string;
  readonly decision: InboxApprovalDecision;
  readonly decisionNote?: string | null;
}

export interface PortalQueueApprovedInboxMessageInput {
  readonly commandKey: string;
  readonly messageId: string;
  /** Browser form value; parsed strictly before the command boundary. */
  readonly expectedRowVersion: string;
  readonly purpose: string;
}

export type PortalConversionInboxFailureKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'validation'
  | 'not_found'
  | 'idempotency_conflict'
  | 'command_in_progress'
  | 'version_conflict'
  | 'consent_blocked'
  | 'unavailable';

export interface PortalConversionInboxFailure {
  readonly ok: false;
  readonly kind: PortalConversionInboxFailureKind;
  /** Safe copy only. Database/provider details never cross this boundary. */
  readonly message: string;
}

export interface PortalInboxMessageMutationSuccess {
  readonly ok: true;
  readonly disposition: 'applied' | 'replayed';
  readonly conversationId: string;
  readonly messageId: string;
  /** The exact immutable version affected by this command. */
  readonly messageVersionId: string;
  readonly versionNumber: number;
  /** SHA-256 of the exact UTF-8 body stored in that immutable version. */
  readonly bodySha256: string;
  readonly lifecycle: InboxMessageLifecycle;
  readonly rowVersion: number;
}

export type PortalInboxMessageMutationOutcome =
  | PortalInboxMessageMutationSuccess
  | PortalConversionInboxFailure;

export type PortalRequestInboxApprovalOutcome =
  | (PortalInboxMessageMutationSuccess & {
      readonly approvalRequestId: string;
      readonly requestNumber: number;
    })
  | PortalConversionInboxFailure;

export type PortalDecideInboxApprovalOutcome =
  | (PortalInboxMessageMutationSuccess & {
      readonly approvalRequestId: string;
      readonly approvalDecisionId: string;
      readonly decision: InboxApprovalDecision;
    })
  | PortalConversionInboxFailure;

export type PortalQueueApprovedInboxMessageOutcome =
  | (PortalInboxMessageMutationSuccess & {
      readonly providerOperationId: string;
      readonly messageDeliveryId: string;
      readonly consentEventId: string;
      /** This foundation can only create a queued TEST operation. */
      readonly environment: 'test';
      readonly provider: 'test_conversation';
    })
  | PortalConversionInboxFailure;

/**
 * Router-facing operational inbox boundary. It creates durable TEST records;
 * it exposes no dispatcher, webhook, provider credential or network method.
 */
export interface PortalConversionInboxCommandService {
  createDraft(
    identity: PortalConversionInboxRequestIdentity,
    input: PortalCreateInboxDraftInput,
  ): Promise<PortalInboxMessageMutationOutcome>;

  reviseDraft(
    identity: PortalConversionInboxRequestIdentity,
    input: PortalReviseInboxDraftInput,
  ): Promise<PortalInboxMessageMutationOutcome>;

  requestApproval(
    identity: PortalConversionInboxRequestIdentity,
    input: PortalRequestInboxApprovalInput,
  ): Promise<PortalRequestInboxApprovalOutcome>;

  decideApproval(
    identity: PortalConversionInboxRequestIdentity,
    input: PortalDecideInboxApprovalInput,
  ): Promise<PortalDecideInboxApprovalOutcome>;

  queueApprovedMessage(
    identity: PortalConversionInboxRequestIdentity,
    input: PortalQueueApprovedInboxMessageInput,
  ): Promise<PortalQueueApprovedInboxMessageOutcome>;
}
