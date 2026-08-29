import type { PortalConversionInboxRequestIdentity } from './conversion-inbox-service.js';

export const CONVERSION_INBOX_OPERATION_COMMAND_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
export const CONVERSION_INBOX_INTERNAL_NOTE_MAX_BYTES = 8_192;
export const CONVERSION_INBOX_CALL_NOTE_MAX_BYTES = 2_000;
export const CONVERSION_INBOX_CALL_SUMMARY_MAX_BYTES = 4_000;
export const CONVERSION_INBOX_NEXT_ACTION_TITLE_MAX_BYTES = 300;

export const CONVERSION_INBOX_CALL_OUTCOMES = Object.freeze([
  'connected',
  'voicemail',
  'no_answer',
  'wrong_number',
  'follow_up_requested',
  'not_interested',
  'qualified',
  'converted',
] as const);
export type ConversionInboxCallOutcome = typeof CONVERSION_INBOX_CALL_OUTCOMES[number];

export const CONVERSION_INBOX_NEXT_ACTION_KINDS = Object.freeze([
  'call',
  'reply_draft',
  'consent_review',
  'internal_follow_up',
] as const);
export type ConversionInboxNextActionKind =
  typeof CONVERSION_INBOX_NEXT_ACTION_KINDS[number];

export const CONVERSION_INBOX_NEXT_ACTION_PRIORITIES = Object.freeze([
  'normal',
  'high',
  'urgent',
] as const);
export type ConversionInboxNextActionPriority =
  typeof CONVERSION_INBOX_NEXT_ACTION_PRIORITIES[number];
export type ConversionInboxAdminCallPriority = Extract<
  ConversionInboxNextActionPriority,
  'high' | 'urgent'
>;

export interface PortalAssignConversionInboxConversationInput {
  readonly commandKey: string;
  readonly conversationId: string;
  /** Browser form value; parsed strictly at the command boundary. */
  readonly expectedRowVersion: string;
  /** A browser cannot nominate another user id. */
  readonly assignment: 'self' | 'unassigned';
}

export interface PortalAppendConversionInboxInternalNoteInput {
  readonly commandKey: string;
  readonly conversationId: string;
  readonly body: string;
}

export interface PortalCreateConversionInboxAdminCallInput {
  readonly commandKey: string;
  readonly conversationId: string;
  readonly priority: ConversionInboxAdminCallPriority;
  /** Canonical ISO-8601 timestamp, including milliseconds and Z. */
  readonly dueAt: string;
  readonly note?: string | null;
}

export interface PortalConversionInboxNextActionInput {
  readonly kind: ConversionInboxNextActionKind;
  readonly title: string;
  /** Canonical ISO-8601 timestamp, including milliseconds and Z. */
  readonly dueAt: string;
  readonly priority: ConversionInboxNextActionPriority;
}

export interface PortalRecordConversionInboxCallOutcomeInput {
  readonly commandKey: string;
  readonly conversationId: string;
  readonly taskId: string;
  /** Browser form value; parsed strictly at the command boundary. */
  readonly expectedTaskRowVersion: string;
  readonly outcome: ConversionInboxCallOutcome;
  readonly summary: string;
  /** Canonical ISO-8601 timestamp, including milliseconds and Z. */
  readonly occurredAt: string;
  readonly nextAction?: PortalConversionInboxNextActionInput | null;
}

export type PortalConversionInboxOperationFailureKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'validation'
  | 'not_found'
  | 'idempotency_conflict'
  | 'command_in_progress'
  | 'version_conflict'
  | 'unavailable';

export interface PortalConversionInboxOperationFailure {
  readonly ok: false;
  readonly kind: PortalConversionInboxOperationFailureKind;
  /** Stable browser-safe copy. PostgreSQL and infrastructure details stay private. */
  readonly message: string;
}

interface PortalConversionInboxOperationSuccess {
  readonly ok: true;
  readonly disposition: 'applied' | 'replayed';
  readonly conversationId: string;
}

export interface PortalAssignConversionInboxConversationSuccess
extends PortalConversionInboxOperationSuccess {
  readonly assignedUserId: string | null;
  readonly rowVersion: number;
}

export interface PortalAppendConversionInboxInternalNoteSuccess
extends PortalConversionInboxOperationSuccess {
  readonly messageId: string;
  readonly messageVersionId: string;
  readonly versionNumber: number;
  readonly bodySha256: string;
  readonly conversationRowVersion: number;
}

export interface PortalCreateConversionInboxAdminCallSuccess
extends PortalConversionInboxOperationSuccess {
  readonly contactId: string;
  readonly taskId: string;
  readonly taskRowVersion: number;
}

export interface PortalRecordConversionInboxCallOutcomeSuccess
extends PortalConversionInboxOperationSuccess {
  readonly contactId: string;
  readonly outcomeId: string;
  readonly completedTaskId: string;
  readonly completedTaskRowVersion: number;
  readonly nextTaskId: string | null;
  readonly nextTaskRowVersion: number | null;
}

export type PortalAssignConversionInboxConversationOutcome =
  | PortalAssignConversionInboxConversationSuccess
  | PortalConversionInboxOperationFailure;
export type PortalAppendConversionInboxInternalNoteOutcome =
  | PortalAppendConversionInboxInternalNoteSuccess
  | PortalConversionInboxOperationFailure;
export type PortalCreateConversionInboxAdminCallOutcome =
  | PortalCreateConversionInboxAdminCallSuccess
  | PortalConversionInboxOperationFailure;
export type PortalRecordConversionInboxCallOutcomeOutcome =
  | PortalRecordConversionInboxCallOutcomeSuccess
  | PortalConversionInboxOperationFailure;

/**
 * Non-visual operational command seam for the one canonical Conversion Inbox.
 * It can mutate assignment, internal records and CRM call work only. It has no
 * delivery, enqueue, webhook, credential or network capability.
 */
export interface PortalConversionInboxOperationsService {
  assignConversation(
    identity: PortalConversionInboxRequestIdentity,
    input: PortalAssignConversionInboxConversationInput,
  ): Promise<PortalAssignConversionInboxConversationOutcome>;

  appendInternalNote(
    identity: PortalConversionInboxRequestIdentity,
    input: PortalAppendConversionInboxInternalNoteInput,
  ): Promise<PortalAppendConversionInboxInternalNoteOutcome>;

  createAdminCall(
    identity: PortalConversionInboxRequestIdentity,
    input: PortalCreateConversionInboxAdminCallInput,
  ): Promise<PortalCreateConversionInboxAdminCallOutcome>;

  recordCallOutcome(
    identity: PortalConversionInboxRequestIdentity,
    input: PortalRecordConversionInboxCallOutcomeInput,
  ): Promise<PortalRecordConversionInboxCallOutcomeOutcome>;
}
