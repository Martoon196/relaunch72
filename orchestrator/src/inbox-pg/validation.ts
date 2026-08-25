import { createHash } from 'node:crypto';
import type { DatabaseRequestContext } from '../db/rls.js';
import { validateDatabaseContext } from '../db/rls.js';
import type { ConversationChannel } from '../providers/contracts.js';
import {
  InboxValidationError,
  type ConfigureTestInboxCommand,
  type CreateInboxDraftCommand,
  type DecideInboxApprovalCommand,
  type InboxApprovalDecision,
  type QueueApprovedInboxMessageCommand,
  type RecordTestDeliveryReceiptCommand,
  type RecordTestInboundCommand,
  type RequestInboxApprovalCommand,
  type ReviseInboxDraftCommand,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMAND_KEY = /^[\x21-\x7e]{1,200}$/;
const PURPOSE = /^[a-z][a-z0-9_.-]{0,99}$/;
const ERROR_CODE = /^[a-z][a-z0-9_.:-]{0,99}$/;
const CHANNELS = new Set<ConversationChannel>([
  'email', 'sms', 'whatsapp', 'instagram', 'facebook',
]);
const DECISIONS = new Set<InboxApprovalDecision>([
  'approved', 'rejected', 'changes_requested',
]);
const TEST_EMAIL = /^[^\s@]+@[^\s@]+[.]invalid$/i;
const TEST_PHONE = /^[+]447700900[0-9]{3}$/;
const TEST_SOCIAL = /^test:[a-z0-9_.-]{1,100}$/;

export interface NormalizedSourceContent {
  readonly versionRef: string;
  readonly sha256: string;
  readonly approvalRef: string;
}

export interface NormalizedConfigureTestInboxCommand {
  readonly commandKey: string;
  readonly channel: ConversationChannel;
  readonly name: string;
  readonly endpointAddress: string;
  readonly endpointDisplayName: string;
}

export interface NormalizedRecordTestInboundCommand {
  readonly commandKey: string;
  readonly inboxId: string;
  readonly contactId: string;
  readonly contactPointId: string;
  readonly body: string;
  readonly bodySha256: string;
  readonly occurredAt: string;
}

export interface NormalizedCreateDraftCommand {
  readonly commandKey: string;
  readonly conversationId: string;
  readonly contactPointId: string;
  readonly body: string;
  readonly bodySha256: string;
  readonly sourceContent: NormalizedSourceContent | null;
}

export interface NormalizedReviseDraftCommand {
  readonly commandKey: string;
  readonly messageId: string;
  readonly expectedRowVersion: number;
  readonly body: string;
  readonly bodySha256: string;
  readonly sourceContent: NormalizedSourceContent | null;
}

export interface NormalizedRequestApprovalCommand {
  readonly commandKey: string;
  readonly messageId: string;
  readonly expectedRowVersion: number;
  readonly reviewNote: string | null;
}

export interface NormalizedDecideApprovalCommand {
  readonly commandKey: string;
  readonly approvalRequestId: string;
  readonly decision: InboxApprovalDecision;
  readonly decisionNote: string | null;
}

export interface NormalizedQueueMessageCommand {
  readonly commandKey: string;
  readonly messageId: string;
  readonly expectedRowVersion: number;
  readonly purpose: string;
}

export interface NormalizedTestReceiptCommand {
  readonly commandKey: string;
  readonly providerOperationId: string;
  readonly messageDeliveryId: string;
  readonly externalEventId: string;
  readonly payloadSha256: string;
  readonly deliveryStatus: RecordTestDeliveryReceiptCommand['deliveryStatus'];
  readonly errorCode: string | null;
  readonly occurredAt: string;
}

function exactText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value !== value.trim()
      || value.length < 1 || value.length > maximum) {
    throw new InboxValidationError(`${field} must be trimmed and contain 1-${maximum} characters`);
  }
  return value;
}

function optionalText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  return exactText(value, field, maximum);
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new InboxValidationError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new InboxValidationError(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function commandKey(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim() || !COMMAND_KEY.test(value)) {
    throw new InboxValidationError('commandKey must be 1-200 printable ASCII characters');
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new InboxValidationError(`${field} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new InboxValidationError(`${field} must be a canonical UTC ISO timestamp`);
  }
  return value;
}

function positiveVersion(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new InboxValidationError(`${field} must be a positive safe integer`);
  }
  return Number(value);
}

function body(value: unknown): Readonly<{ body: string; bodySha256: string }> {
  if (typeof value !== 'string'
      || Buffer.byteLength(value, 'utf8') < 1
      || Buffer.byteLength(value, 'utf8') > 65_536) {
    throw new InboxValidationError('body must contain 1-65536 UTF-8 bytes');
  }
  return Object.freeze({
    body: value,
    bodySha256: createHash('sha256').update(value, 'utf8').digest('hex'),
  });
}
function sourceContent(value: CreateInboxDraftCommand['sourceContent']): NormalizedSourceContent | null {
  if (value === undefined || value === null) return null;
  return Object.freeze({
    versionRef: exactText(value.versionRef, 'sourceContent.versionRef', 500),
    sha256: sha256(value.sha256, 'sourceContent.sha256'),
    approvalRef: exactText(value.approvalRef, 'sourceContent.approvalRef', 500),
  });
}

function json(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new InboxValidationError('Command payload is not finite JSON');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new InboxValidationError('Command payload contains a cycle');
    seen.add(value);
    const encoded = `[${value.map((entry) => json(entry, seen)).join(',')}]`;
    seen.delete(value);
    return encoded;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new InboxValidationError('Command payload contains a cycle');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new InboxValidationError('Command payload must contain plain JSON objects');
    }
    seen.add(value);
    const encoded = `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${json(entry, seen)}`).join(',')}}`;
    seen.delete(value);
    return encoded;
  }
  throw new InboxValidationError('Command payload contains a non-JSON value');
}

export function validateInboxUserContext(context: DatabaseRequestContext): void {
  validateDatabaseContext(context);
  if (context.actorKind !== 'user' || !context.userId) {
    throw new InboxValidationError('Inbox commands require an authenticated workspace member');
  }
}

export function inboxCommandHash(
  context: DatabaseRequestContext,
  commandName: string,
  payload: unknown,
): Buffer {
  validateInboxUserContext(context);
  return createHash('sha256').update(json({
    actorKind: context.actorKind,
    actorUserId: context.userId!.toLowerCase(),
    commandName,
    payload,
  }), 'utf8').digest();
}

export function normalizeConfigureTestInbox(
  command: ConfigureTestInboxCommand,
): NormalizedConfigureTestInboxCommand {
  if (!command || typeof command !== 'object' || !CHANNELS.has(command.channel)) {
    throw new InboxValidationError('Test inbox channel is invalid');
  }
  const endpointAddress = exactText(command.endpointAddress, 'endpointAddress', 500);
  const reserved = command.channel === 'email' ? TEST_EMAIL.test(endpointAddress)
    : command.channel === 'sms' || command.channel === 'whatsapp'
      ? TEST_PHONE.test(endpointAddress) : TEST_SOCIAL.test(endpointAddress);
  if (!reserved) {
    throw new InboxValidationError('Test inbox requires a reserved non-routable endpoint');
  }
  return Object.freeze({
    commandKey: commandKey(command.commandKey), channel: command.channel,
    name: exactText(command.name, 'name', 120), endpointAddress,
    endpointDisplayName: exactText(command.endpointDisplayName, 'endpointDisplayName', 120),
  });
}

export function normalizeRecordTestInbound(
  command: RecordTestInboundCommand,
): NormalizedRecordTestInboundCommand {
  const content = body(command.body);
  return Object.freeze({
    commandKey: commandKey(command.commandKey),
    inboxId: uuid(command.inboxId, 'inboxId'),
    contactId: uuid(command.contactId, 'contactId'),
    contactPointId: uuid(command.contactPointId, 'contactPointId'),
    ...content, occurredAt: timestamp(command.occurredAt, 'occurredAt'),
  });
}

export function normalizeCreateDraft(command: CreateInboxDraftCommand): NormalizedCreateDraftCommand {
  return Object.freeze({
    commandKey: commandKey(command.commandKey),
    conversationId: uuid(command.conversationId, 'conversationId'),
    contactPointId: uuid(command.contactPointId, 'contactPointId'),
    ...body(command.body), sourceContent: sourceContent(command.sourceContent),
  });
}

export function normalizeReviseDraft(command: ReviseInboxDraftCommand): NormalizedReviseDraftCommand {
  return Object.freeze({
    commandKey: commandKey(command.commandKey), messageId: uuid(command.messageId, 'messageId'),
    expectedRowVersion: positiveVersion(command.expectedRowVersion, 'expectedRowVersion'),
    ...body(command.body), sourceContent: sourceContent(command.sourceContent),
  });
}

export function normalizeRequestApproval(
  command: RequestInboxApprovalCommand,
): NormalizedRequestApprovalCommand {
  return Object.freeze({
    commandKey: commandKey(command.commandKey), messageId: uuid(command.messageId, 'messageId'),
    expectedRowVersion: positiveVersion(command.expectedRowVersion, 'expectedRowVersion'),
    reviewNote: optionalText(command.reviewNote, 'reviewNote', 2000),
  });
}

export function normalizeDecideApproval(
  command: DecideInboxApprovalCommand,
): NormalizedDecideApprovalCommand {
  if (!DECISIONS.has(command.decision)) throw new InboxValidationError('decision is invalid');
  const decisionNote = optionalText(command.decisionNote, 'decisionNote', 4000);
  if (command.decision !== 'approved' && decisionNote === null) {
    throw new InboxValidationError('Rejected and changes-requested decisions require a note');
  }
  return Object.freeze({
    commandKey: commandKey(command.commandKey),
    approvalRequestId: uuid(command.approvalRequestId, 'approvalRequestId'),
    decision: command.decision, decisionNote,
  });
}

export function normalizeQueueMessage(
  command: QueueApprovedInboxMessageCommand,
): NormalizedQueueMessageCommand {
  const purpose = exactText(command.purpose, 'purpose', 100);
  if (!PURPOSE.test(purpose)) throw new InboxValidationError('purpose is invalid');
  return Object.freeze({
    commandKey: commandKey(command.commandKey), messageId: uuid(command.messageId, 'messageId'),
    expectedRowVersion: positiveVersion(command.expectedRowVersion, 'expectedRowVersion'), purpose,
  });
}

export function normalizeTestReceipt(
  command: RecordTestDeliveryReceiptCommand,
): NormalizedTestReceiptCommand {
  if (!['accepted', 'delivered', 'read', 'failed'].includes(command.deliveryStatus)) {
    throw new InboxValidationError('deliveryStatus is invalid');
  }
  const errorCode = optionalText(command.errorCode, 'errorCode', 100);
  if (errorCode !== null && !ERROR_CODE.test(errorCode)) {
    throw new InboxValidationError('errorCode is invalid');
  }
  return Object.freeze({
    commandKey: commandKey(command.commandKey),
    providerOperationId: uuid(command.providerOperationId, 'providerOperationId'),
    messageDeliveryId: uuid(command.messageDeliveryId, 'messageDeliveryId'),
    externalEventId: exactText(command.externalEventId, 'externalEventId', 500),
    payloadSha256: sha256(command.payloadSha256, 'payloadSha256'),
    deliveryStatus: command.deliveryStatus, errorCode,
    occurredAt: timestamp(command.occurredAt, 'occurredAt'),
  });
}
