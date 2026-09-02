import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseRequestContext } from '../db/rls.js';
import { withTransaction } from '../db/transaction.js';
import type { SqlExecutor } from '../crm-pg/types.js';
import { evaluateEndpointInTransaction } from '../consent-pg/eligibility.js';
import { INBOX_COMPLETE_REVIEW_MAX_BODY_BYTES } from './limits.js';
import { InboxPgRepository, type LockedMessageRow } from './repository.js';
import {
  InboxCommandInProgressError,
  InboxConsentBlockedError,
  InboxIdempotencyConflictError,
  InboxNotFoundError,
  InboxValidationError,
  InboxVersionConflictError,
  type ConfigureTestInboxCommand,
  type ConfigureTestInboxResult,
  type CreateInboxDraftCommand,
  type DecideInboxApprovalCommand,
  type DecideInboxApprovalResult,
  type InboxCommandServiceDependencies,
  type InboxMessageMutationResult,
  type InboxTransactionRunner,
  type QueueApprovedInboxMessageCommand,
  type QueueApprovedInboxMessageResult,
  type RecordTestDeliveryReceiptCommand,
  type RecordTestDeliveryReceiptResult,
  type RecordTestInboundCommand,
  type RequestInboxApprovalCommand,
  type RequestInboxApprovalResult,
  type ReviseInboxDraftCommand,
} from './types.js';
import {
  inboxCommandHash,
  normalizeConfigureTestInbox,
  normalizeCreateDraft,
  normalizeDecideApproval,
  normalizeQueueMessage,
  normalizeRecordTestInbound,
  normalizeRequestApproval,
  normalizeReviseDraft,
  normalizeTestReceipt,
  validateInboxUserContext,
} from './validation.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LIFECYCLES = new Set(['received', 'draft', 'approval_pending', 'approved', 'committed']);

const CONFIGURE = 'inbox.configureTest';
const RECORD_INBOUND = 'inbox.recordTestInbound';
const CREATE_DRAFT = 'inbox.createDraft';
const REVISE_DRAFT = 'inbox.reviseDraft';
const REQUEST_APPROVAL = 'inbox.requestApproval';
const DECIDE_APPROVAL = 'inbox.decideApproval';
const QUEUE_APPROVED = 'inbox.queueApproved';
const RECORD_RECEIPT = 'inbox.recordTestReceipt';

/** Maximum body that the current human-review surface can render in full. */
export const INBOX_APPROVAL_REVIEW_MAX_BODY_BYTES = INBOX_COMPLETE_REVIEW_MAX_BODY_BYTES;

function hashesEqual(left: Uint8Array, right: Uint8Array): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error(`Inbox result ${field} is invalid`);
  }
  return value.toLowerCase();
}

function number(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Inbox result ${field} is invalid`);
  return parsed;
}

function messageResult(
  message: LockedMessageRow,
  disposition: 'applied' | 'replayed',
): InboxMessageMutationResult {
  if (!LIFECYCLES.has(message.lifecycle) || !SHA256.test(message.bodySha256)) {
    throw new Error('Inbox message mutation returned invalid canonical data');
  }
  return Object.freeze({
    disposition,
    conversationId: uuid(message.conversationId, 'conversationId'),
    messageId: uuid(message.messageId, 'messageId'),
    messageVersionId: uuid(message.messageVersionId, 'messageVersionId'),
    versionNumber: number(message.versionNumber, 'versionNumber'),
    bodySha256: message.bodySha256,
    lifecycle: message.lifecycle,
    rowVersion: number(message.rowVersion, 'rowVersion'),
  });
}

function replayMessage(value: unknown): InboxMessageMutationResult {
  if (!isObject(value)) throw new Error('Stored inbox command result is invalid');
  return messageResult({
    conversationId: uuid(value.conversationId, 'conversationId'),
    messageId: uuid(value.messageId, 'messageId'),
    messageVersionId: uuid(value.messageVersionId, 'messageVersionId'),
    versionNumber: number(value.versionNumber, 'versionNumber'),
    bodySha256: String(value.bodySha256),
    lifecycle: String(value.lifecycle) as LockedMessageRow['lifecycle'],
    rowVersion: number(value.rowVersion, 'rowVersion'),
    providerConnectionId: '00000000-0000-4000-8000-000000000000',
    channelEndpointId: '00000000-0000-4000-8000-000000000000',
    channel: 'email', environment: 'test', contactId: '00000000-0000-4000-8000-000000000000',
    contactPointId: '00000000-0000-4000-8000-000000000000',
  }, 'replayed');
}

function configurationResult(value: unknown, disposition: 'applied' | 'replayed'): ConfigureTestInboxResult {
  if (!isObject(value)
      || !['email', 'sms', 'whatsapp', 'instagram', 'facebook'].includes(String(value.channel))
      || value.environment !== 'test') {
    throw new Error('Stored inbox configuration result is invalid');
  }
  return Object.freeze({
    disposition,
    providerConnectionId: uuid(value.providerConnectionId, 'providerConnectionId'),
    channelEndpointId: uuid(value.channelEndpointId, 'channelEndpointId'),
    inboxId: uuid(value.inboxId, 'inboxId'),
    channel: value.channel as ConfigureTestInboxResult['channel'], environment: 'test',
  });
}

function actorUserId(context: DatabaseRequestContext): string {
  if (!context.userId) throw new InboxValidationError('Inbox command requires userId');
  return context.userId.toLowerCase();
}

export class InboxCommandService {
  readonly #nextId: () => string;
  readonly #now: () => Date;

  constructor(private readonly dependencies: InboxCommandServiceDependencies) {
    this.#nextId = dependencies.nextId ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date());
  }

  private async execute<TResult>(
    context: DatabaseRequestContext,
    commandName: string,
    commandKey: string,
    normalized: unknown,
    apply: (repository: InboxPgRepository, at: string) => Promise<TResult>,
    replay: (value: unknown) => TResult,
  ): Promise<TResult> {
    validateInboxUserContext(context);
    const payloadHash = inboxCommandHash(context, commandName, normalized);
    return this.dependencies.transactionRunner.run(context, async (transaction) => {
      const repository = new InboxPgRepository(transaction);
      const at = this.#now().toISOString();
      const claim = await repository.claimCommand({
        id: this.#nextId(), commandName, commandKey,
        requestId: context.requestId, payloadHash, createdAt: at,
      });
      if (!hashesEqual(claim.payloadHash, payloadHash)) {
        throw new InboxIdempotencyConflictError();
      }
      if (!claim.inserted) {
        if (claim.status === 'succeeded') return replay(claim.result);
        throw new InboxCommandInProgressError();
      }
      const result = await apply(repository, at);
      if (!isObject(result)) throw new Error('Inbox command produced a non-object result');
      await repository.completeCommand({
        receiptId: claim.id, payloadHash,
        result: result as Readonly<Record<string, unknown>>, completedAt: at,
      });
      return result;
    }, { readOnly: false, serializable: true });
  }

  async configureTestInbox(
    context: DatabaseRequestContext,
    command: ConfigureTestInboxCommand,
  ): Promise<ConfigureTestInboxResult> {
    const input = normalizeConfigureTestInbox(command);
    return this.execute(context, CONFIGURE, input.commandKey, input,
      async (repository, at) => configurationResult(await repository.configureTestInbox({
        connectionId: this.#nextId(), endpointId: this.#nextId(), inboxId: this.#nextId(),
        actorUserId: actorUserId(context), command: input, at,
      }), 'applied'),
      (stored) => configurationResult(stored, 'replayed'));
  }

  async recordTestInbound(
    context: DatabaseRequestContext,
    command: RecordTestInboundCommand,
  ): Promise<InboxMessageMutationResult> {
    const input = normalizeRecordTestInbound(command);
    return this.execute(context, RECORD_INBOUND, input.commandKey, input,
      async (repository, at) => {
        if (new Date(input.occurredAt).getTime() > new Date(at).getTime() + 300_000) {
          throw new InboxValidationError('occurredAt is too far in the future');
        }
        const target = await repository.lockInboundTarget(input);
        if (!target) throw new InboxNotFoundError('Test inbox/contact endpoint');
        const conversationId = target.conversationId ?? this.#nextId();
        if (!target.conversationId) {
          await repository.insertConversation({ id: conversationId, inboxId: input.inboxId,
            channel: target.channel, contactId: target.contactId,
            firstMessageAt: input.occurredAt, at });
        }
        const message = await repository.insertMessageVersionPair({
          messageId: this.#nextId(), versionId: this.#nextId(),
          target: { ...target, conversationId }, direction: 'inbound',
          lifecycle: 'received', sourceKind: 'test_fixture', body: input.body,
          bodySha256: input.bodySha256, sourceContent: null,
          actorUserId: actorUserId(context), requestId: context.requestId,
          occurredAt: input.occurredAt, at,
        });
        await repository.advanceConversationForInbound(conversationId, input.occurredAt);
        return messageResult(message, 'applied');
      }, replayMessage);
  }

  async createDraft(
    context: DatabaseRequestContext,
    command: CreateInboxDraftCommand,
  ): Promise<InboxMessageMutationResult> {
    const input = normalizeCreateDraft(command);
    return this.execute(context, CREATE_DRAFT, input.commandKey, input,
      async (repository, at) => {
        const target = await repository.lockDraftTarget(input.conversationId, input.contactPointId);
        if (!target) throw new InboxNotFoundError('Conversation/contact endpoint');
        const message = await repository.insertMessageVersionPair({
          messageId: this.#nextId(), versionId: this.#nextId(), target,
          direction: 'outbound', lifecycle: 'draft', sourceKind: 'user',
          body: input.body, bodySha256: input.bodySha256,
          sourceContent: input.sourceContent, actorUserId: actorUserId(context),
          requestId: context.requestId, occurredAt: at, at,
        });
        return messageResult(message, 'applied');
      }, replayMessage);
  }

  async reviseDraft(
    context: DatabaseRequestContext,
    command: ReviseInboxDraftCommand,
  ): Promise<InboxMessageMutationResult> {
    const input = normalizeReviseDraft(command);
    return this.execute(context, REVISE_DRAFT, input.commandKey, input,
      async (repository, at) => {
        const message = await repository.lockMessage(input.messageId);
        if (!message) throw new InboxNotFoundError('Message');
        if (message.lifecycle !== 'draft' || message.rowVersion !== input.expectedRowVersion) {
          throw new InboxVersionConflictError();
        }
        const revised = await repository.insertRevision({ versionId: this.#nextId(),
          message, command: input, actorUserId: actorUserId(context),
          requestId: context.requestId, at });
        if (!revised) throw new InboxVersionConflictError();
        return messageResult(revised, 'applied');
      }, replayMessage);
  }

  async requestApproval(
    context: DatabaseRequestContext,
    command: RequestInboxApprovalCommand,
  ): Promise<RequestInboxApprovalResult> {
    const input = normalizeRequestApproval(command);
    return this.execute(context, REQUEST_APPROVAL, input.commandKey, input,
      async (repository, at) => {
        const message = await repository.lockMessage(input.messageId);
        if (!message) throw new InboxNotFoundError('Message');
        if (message.lifecycle !== 'draft' || message.rowVersion !== input.expectedRowVersion) {
          throw new InboxVersionConflictError();
        }
        const approvalRequestId = this.#nextId();
        const requestNumber = await repository.nextApprovalRequestNumber(
          message.messageId, message.messageVersionId,
        );
        if (!Number.isSafeInteger(requestNumber) || requestNumber < 1) {
          throw new Error('Message approval request number is invalid');
        }
        const pending = await repository.requestApproval({ approvalRequestId,
          message, requestNumber, command: input, actorUserId: actorUserId(context),
          requestId: context.requestId, at });
        if (!pending) throw new InboxVersionConflictError();
        return Object.freeze({ ...messageResult(pending, 'applied'),
          approvalRequestId, requestNumber });
      }, (stored) => {
        const base = replayMessage(stored);
        if (!isObject(stored)) throw new Error('Stored approval request result is invalid');
        return Object.freeze({ ...base,
          approvalRequestId: uuid(stored.approvalRequestId, 'approvalRequestId'),
          requestNumber: number(stored.requestNumber, 'requestNumber') });
      });
  }

  async decideApproval(
    context: DatabaseRequestContext,
    command: DecideInboxApprovalCommand,
  ): Promise<DecideInboxApprovalResult> {
    const input = normalizeDecideApproval(command);
    return this.execute(context, DECIDE_APPROVAL, input.commandKey, input,
      async (repository, at) => {
        const approval = await repository.lockApprovalRequest(input.approvalRequestId);
        if (!approval) throw new InboxNotFoundError('Approval request');
        if (approval.lifecycle !== 'approval_pending' || approval.approvalDecisionId !== null) {
          throw new InboxVersionConflictError('Approval request is no longer pending');
        }
        if (input.decision === 'approved'
            && approval.bodyBytes > INBOX_APPROVAL_REVIEW_MAX_BODY_BYTES) {
          throw new InboxValidationError(
            'The exact immutable draft exceeds the complete human-review boundary',
          );
        }
        const approvalDecisionId = this.#nextId();
        const message = await repository.decideApproval({ approvalDecisionId,
          approval, command: input, actorUserId: actorUserId(context),
          requestId: context.requestId, at });
        return Object.freeze({ ...messageResult(message, 'applied'),
          approvalRequestId: approval.approvalRequestId,
          approvalDecisionId, decision: input.decision });
      }, (stored) => {
        const base = replayMessage(stored);
        if (!isObject(stored)
            || !['approved', 'rejected', 'changes_requested'].includes(String(stored.decision))) {
          throw new Error('Stored approval decision result is invalid');
        }
        return Object.freeze({ ...base,
          approvalRequestId: uuid(stored.approvalRequestId, 'approvalRequestId'),
          approvalDecisionId: uuid(stored.approvalDecisionId, 'approvalDecisionId'),
          decision: stored.decision as DecideInboxApprovalResult['decision'] });
      });
  }

  async queueApprovedMessage(
    context: DatabaseRequestContext,
    command: QueueApprovedInboxMessageCommand,
  ): Promise<QueueApprovedInboxMessageResult> {
    const input = normalizeQueueMessage(command);
    return this.execute(context, QUEUE_APPROVED, input.commandKey, input,
      async (repository, at) => {
        const message = await repository.lockApprovedMessage(input.messageId);
        if (!message) throw new InboxNotFoundError('Approved message');
        if (message.rowVersion !== input.expectedRowVersion) throw new InboxVersionConflictError();
        if (message.bodyBytes > INBOX_APPROVAL_REVIEW_MAX_BODY_BYTES) {
          throw new InboxValidationError(
            'The exact immutable draft exceeds the complete human-review boundary',
          );
        }
        if (message.channel === 'linkedin') {
          throw new InboxValidationError('LinkedIn conversations are read-only');
        }
        const consentChannel = message.channel === 'instagram' || message.channel === 'facebook'
          ? 'social' : message.channel;
        const eligibility = await evaluateEndpointInTransaction(repository.executor, {
          contactPointId: message.contactPointId,
          channel: consentChannel,
          purpose: input.purpose,
        });
        if (eligibility.status !== 'allowed' || !eligibility.consentEventId) {
          throw new InboxConsentBlockedError(eligibility.reason);
        }
        const providerOperationId = this.#nextId();
        const messageDeliveryId = this.#nextId();
        const committed = await repository.queueApprovedMessage({ operationId: providerOperationId,
          deliveryId: messageDeliveryId, message, purpose: input.purpose,
          consentEventId: eligibility.consentEventId,
          actorUserId: actorUserId(context), at });
        if (!committed) throw new InboxVersionConflictError();
        return Object.freeze({ ...messageResult(committed, 'applied'),
          providerOperationId, messageDeliveryId,
          consentEventId: eligibility.consentEventId });
      }, (stored) => {
        const base = replayMessage(stored);
        if (!isObject(stored)) throw new Error('Stored queued-message result is invalid');
        return Object.freeze({ ...base,
          providerOperationId: uuid(stored.providerOperationId, 'providerOperationId'),
          messageDeliveryId: uuid(stored.messageDeliveryId, 'messageDeliveryId'),
          consentEventId: uuid(stored.consentEventId, 'consentEventId') });
      });
  }

  async recordTestDeliveryReceipt(
    context: DatabaseRequestContext,
    command: RecordTestDeliveryReceiptCommand,
  ): Promise<RecordTestDeliveryReceiptResult> {
    const input = normalizeTestReceipt(command);
    return this.execute<RecordTestDeliveryReceiptResult>(
      context, RECORD_RECEIPT, input.commandKey, input,
      async (repository) => {
        const recorded = await repository.recordTestReceipt(context.workspaceId, input);
        if (!UUID.test(recorded.receiptId)
            || !['accepted', 'delivered', 'read', 'failed'].includes(recorded.effectiveStatus)
            || typeof recorded.replayed !== 'boolean') {
          throw new Error('Test receipt returned invalid canonical data');
        }
        return Object.freeze({ disposition: 'applied' as const,
          receiptId: recorded.receiptId, effectiveStatus: recorded.effectiveStatus,
          providerReplay: recorded.replayed });
      }, (stored) => {
        if (!isObject(stored)
            || !['accepted', 'delivered', 'read', 'failed'].includes(String(stored.effectiveStatus))
            || typeof stored.providerReplay !== 'boolean') {
          throw new Error('Stored test receipt result is invalid');
        }
        return Object.freeze({ disposition: 'replayed' as const,
          receiptId: uuid(stored.receiptId, 'receiptId'),
          effectiveStatus: stored.effectiveStatus as RecordTestDeliveryReceiptResult['effectiveStatus'],
          providerReplay: stored.providerReplay });
      });
  }
}

export function createPgInboxTransactionRunner(
  pool: Pick<Pool, 'connect'>,
): InboxTransactionRunner {
  return {
    run<T>(
      context: DatabaseRequestContext,
      operation: (transaction: SqlExecutor) => Promise<T>,
      options: Readonly<{ readOnly: boolean; serializable?: boolean; repeatableRead?: boolean }>,
    ): Promise<T> {
      return withTransaction(pool, context, operation, {
        readOnly: options.readOnly,
        isolation: options.serializable ? 'serializable'
          : options.repeatableRead ? 'repeatable read' : 'read committed',
      });
    },
  };
}

export function createPgInboxCommandService(
  pool: Pick<Pool, 'connect'>,
): InboxCommandService {
  return new InboxCommandService({ transactionRunner: createPgInboxTransactionRunner(pool) });
}
