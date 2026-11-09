import type { DatabaseRequestContext } from '../db/rls.js';
import type { SqlExecutor } from '../crm-pg/types.js';
import type { ConversationChannel, ConversationMessageRequest, ConversationSendChannel,
  WorkspaceOwnedProviderConnectionRecord } from '../providers/contracts.js';

export type InboxEnvironment = 'test';
export type InboxConversationReadEnvironment = 'test' | 'live';
export type InboxConversationState = 'open' | 'snoozed' | 'closed' | 'quarantined';
export type InboxMessageLifecycle =
  | 'received'
  | 'draft'
  | 'approval_pending'
  | 'approved'
  | 'committed';
export type InboxApprovalDecision = 'approved' | 'rejected' | 'changes_requested';
export type InboxConsentChannel = 'email' | 'sms' | 'whatsapp' | 'social';

export interface InboxTransactionRunner {
  run<T>(
    context: DatabaseRequestContext,
    operation: (transaction: SqlExecutor) => Promise<T>,
    options: Readonly<{ readOnly: boolean; serializable?: boolean; repeatableRead?: boolean }>,
  ): Promise<T>;
}

export interface ConfigureTestInboxCommand {
  readonly commandKey: string;
  readonly channel: ConversationSendChannel;
  readonly name: string;
  readonly endpointAddress: string;
  readonly endpointDisplayName: string;
}

export interface ConfigureTestInboxResult {
  readonly disposition: 'applied' | 'replayed';
  readonly providerConnectionId: string;
  readonly channelEndpointId: string;
  readonly inboxId: string;
  readonly channel: ConversationSendChannel;
  readonly environment: InboxEnvironment;
}

export interface RecordTestInboundCommand {
  readonly commandKey: string;
  readonly inboxId: string;
  readonly contactId: string;
  readonly contactPointId: string;
  readonly body: string;
  readonly occurredAt: string;
}

export interface CreateInboxDraftCommand {
  readonly commandKey: string;
  readonly conversationId: string;
  readonly contactPointId: string;
  readonly body: string;
  readonly sourceContent?: Readonly<{
    versionRef: string;
    sha256: string;
    approvalRef: string;
  }> | null;
}

export interface ReviseInboxDraftCommand {
  readonly commandKey: string;
  readonly messageId: string;
  readonly expectedRowVersion: number;
  readonly body: string;
  readonly sourceContent?: CreateInboxDraftCommand['sourceContent'];
}

export interface InboxMessageMutationResult {
  readonly disposition: 'applied' | 'replayed';
  readonly conversationId: string;
  readonly messageId: string;
  readonly messageVersionId: string;
  readonly versionNumber: number;
  readonly bodySha256: string;
  readonly lifecycle: InboxMessageLifecycle;
  readonly rowVersion: number;
}

export interface RequestInboxApprovalCommand {
  readonly commandKey: string;
  readonly messageId: string;
  readonly expectedRowVersion: number;
  readonly reviewNote?: string | null;
}

export interface RequestInboxApprovalResult extends InboxMessageMutationResult {
  readonly approvalRequestId: string;
  readonly requestNumber: number;
}

export interface DecideInboxApprovalCommand {
  readonly commandKey: string;
  readonly approvalRequestId: string;
  readonly decision: InboxApprovalDecision;
  readonly decisionNote?: string | null;
}

export interface DecideInboxApprovalResult extends InboxMessageMutationResult {
  readonly approvalRequestId: string;
  readonly approvalDecisionId: string;
  readonly decision: InboxApprovalDecision;
}

export interface QueueApprovedInboxMessageCommand {
  readonly commandKey: string;
  readonly messageId: string;
  readonly expectedRowVersion: number;
  readonly purpose: string;
}

export interface QueueApprovedInboxMessageResult extends InboxMessageMutationResult {
  readonly providerOperationId: string;
  readonly messageDeliveryId: string;
  readonly consentEventId: string;
}

export interface RecordTestDeliveryReceiptCommand {
  readonly commandKey: string;
  readonly providerOperationId: string;
  readonly messageDeliveryId: string;
  readonly externalEventId: string;
  /** SHA-256 of the exact normalized test receipt bytes; raw payload is never persisted here. */
  readonly payloadSha256: string;
  readonly deliveryStatus: 'accepted' | 'delivered' | 'read' | 'failed';
  readonly errorCode?: string | null;
  readonly occurredAt: string;
}

export interface RecordTestDeliveryReceiptResult {
  readonly disposition: 'applied' | 'replayed';
  readonly receiptId: string;
  readonly effectiveStatus: 'accepted' | 'delivered' | 'read' | 'failed';
  readonly providerReplay: boolean;
}

export interface InboxCommandServiceDependencies {
  readonly transactionRunner: InboxTransactionRunner;
  readonly nextId?: () => string;
  readonly now?: () => Date;
}

export interface InboxDispatchPayload {
  readonly connection: WorkspaceOwnedProviderConnectionRecord;
  readonly environment: InboxEnvironment;
  readonly conversationId: string;
  readonly messageId: string;
  readonly messageVersionId: string;
  readonly contactPointId: string;
  readonly consentChannel: InboxConsentChannel;
  readonly purpose: string;
  readonly consentEventId: string;
  readonly request: ConversationMessageRequest;
}

export interface InboxConversationSummary {
  readonly conversationId: string;
  readonly inboxId: string;
  readonly channel: ConversationChannel;
  /** LIVE is admitted only through an exact channel-specific signed evidence projection. */
  readonly environment?: InboxConversationReadEnvironment;
  readonly state: InboxConversationState;
  readonly contactId: string | null;
  readonly contactName: string | null;
  /** Canonical conversation ownership; never inferred from Action Centre overlays. */
  readonly assignedUserId: string | null;
  readonly assignedUserName: string | null;
  readonly subject: string | null;
  readonly unreadCount: number;
  /** True when the exact current outbound version awaits a decision or returned rework. */
  readonly requiresApproval: boolean;
  readonly lastMessageAt: string | null;
  readonly latestMessage: Readonly<{
    messageId: string;
    direction: 'inbound' | 'outbound' | 'internal_note';
    lifecycle: InboxMessageLifecycle;
    body: string;
    occurredAt: string;
  }> | null;
  readonly rowVersion: number;
}

export interface InboxConversationCursor {
  readonly beforeLastMessageAt: string;
  readonly beforeConversationId: string;
}

export interface InboxConversationPage {
  readonly workspaceId: string;
  readonly canWrite: boolean;
  readonly canManage: boolean;
  readonly timezone: string;
  readonly asOf: string;
  readonly conversations: readonly InboxConversationSummary[];
  readonly nextCursor: InboxConversationCursor | null;
}

export class InboxValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboxValidationError';
  }
}
export class InboxIdempotencyConflictError extends Error {
  constructor() {
    super('Inbox command key was reused with different input');
    this.name = 'InboxIdempotencyConflictError';
  }
}

export class InboxCommandInProgressError extends Error {
  constructor() {
    super('Inbox command is already in progress');
    this.name = 'InboxCommandInProgressError';
  }
}

export class InboxNotFoundError extends Error {
  constructor(entity: string) {
    super(`${entity} was not found in this workspace`);
    this.name = 'InboxNotFoundError';
  }
}

export class InboxVersionConflictError extends Error {
  constructor(message = 'Inbox row version is no longer current') {
    super(message);
    this.name = 'InboxVersionConflictError';
  }
}

export class InboxConsentBlockedError extends Error {
  constructor(readonly reason: string) {
    super(`Message delivery is not permitted: ${reason}`);
    this.name = 'InboxConsentBlockedError';
  }
}
