import { createHash } from 'node:crypto';
import type { RecordTestInboundCommand } from '../inbox-pg/types.js';
import type { ProviderOperationContext } from '../providers/contracts.js';
import {
  META_SOCIAL_DM_PROVIDER_ID,
  MetaCommunicationsContractError,
  MetaIdempotencyConflictError,
  MetaProviderEffectsDisabledError,
  assertMetaOutboundPreconditions,
  executeMetaAuthorizedContractHttpRequest,
  isAuthenticMetaContractHttpTransport,
  metaBoundContext,
  metaCanonicalSha256,
  metaPlatformId,
  metaSha256,
  metaTimestamp,
  metaUuid,
  parseBoundedJson,
  verifyMetaSignedJson,
  type MetaContractDispatchResult,
  type MetaContractHttpTransport,
  type MetaHttpRequest,
  type MetaOutboundControlEvidence,
  type MetaOutboundEvidence,
  type MetaSocialDmCredentialBundle,
  type MetaSocialDmNetwork,
} from '../meta-communications/contracts.js';

const SAFE_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u;
const MESSAGE_ID = /^[\x21-\x7e]{1,200}$/u;
const MAX_EVENTS = 100;
const VERIFIED = new WeakSet<object>();

export interface MetaConversationWindowEvidenceInput {
  readonly inboundMessageId: string;
  readonly openedAt: string;
  readonly validUntil: string;
}

export interface MetaConversationWindowEvidence extends MetaConversationWindowEvidenceInput {
  readonly evidenceSha256: string;
}

export interface MetaSocialDmReplyRequest {
  readonly network: MetaSocialDmNetwork;
  readonly recipientId: string;
  readonly text: string;
  readonly replyToMessageId: string;
  readonly conversationWindow: MetaConversationWindowEvidence;
  readonly evidence: MetaOutboundEvidence;
  readonly controls: MetaOutboundControlEvidence;
}

export interface VerifiedMetaSocialDmInbound {
  readonly provider: typeof META_SOCIAL_DM_PROVIDER_ID;
  readonly network: MetaSocialDmNetwork;
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly resourceId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly senderIdSha256: string;
  readonly body: string;
  readonly occurredAt: string;
}

export interface MetaSocialDmInboxBinding {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly inboxId: string;
  readonly contactId: string;
  readonly contactPointId: string;
  readonly network: MetaSocialDmNetwork;
  readonly senderIdSha256: string;
}

export interface MetaSocialDmAdapterOptions {
  /** Defaults to disabled. This strike deliberately has no live execution mode. */
  readonly executionMode?: 'disabled' | 'contract_test';
  readonly credentials?: MetaSocialDmCredentialBundle;
  readonly http?: MetaContractHttpTransport;
  readonly observedAt?: string;
  readonly timeoutMs?: number;
}

function fail(message: string): never {
  throw new MetaCommunicationsContractError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function allowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(`${label} has unexpected fields`);
}

function boundedArray(value: unknown, maximum: number, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} is invalid`);
  return value;
}

function messageId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !MESSAGE_ID.test(value)) fail(`${label} is invalid`);
  return value;
}

function bodyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || !SAFE_TEXT.test(value)
      || Buffer.byteLength(value, 'utf8') > 4_096) fail(`${label} is invalid`);
  return value;
}

function epochMilliseconds(value: unknown): string {
  if (!Number.isSafeInteger(value) || (value as number) < 1_000_000_000_000
      || (value as number) > 99_999_999_999_999) fail('social DM timestamp is invalid');
  return new Date(value as number).toISOString();
}

export function createMetaConversationWindowEvidence(
  input: MetaConversationWindowEvidenceInput,
): MetaConversationWindowEvidence {
  const inboundMessageId = messageId(input.inboundMessageId, 'conversation window inbound message id');
  const openedAt = metaTimestamp(input.openedAt, 'conversation window openedAt');
  const validUntil = metaTimestamp(input.validUntil, 'conversation window validUntil');
  const duration = Date.parse(validUntil) - Date.parse(openedAt);
  if (duration <= 0 || duration > 24 * 60 * 60 * 1_000) {
    fail('conversation window exceeds the supported 24-hour reply contract');
  }
  const exact = { inboundMessageId, openedAt, validUntil };
  return Object.freeze({ ...exact, evidenceSha256: metaCanonicalSha256(exact) });
}

function replyPayload(request: MetaSocialDmReplyRequest): Readonly<{
  network: MetaSocialDmNetwork; recipientId: string; text: string; replyToMessageId: string;
  recipientSha256: string; bodySha256: string; conversationWindow: MetaConversationWindowEvidence;
}> {
  if (request.network !== 'facebook' && request.network !== 'instagram') fail('social DM network is invalid');
  const recipientId = metaPlatformId(request.recipientId, 'social DM recipient id');
  const text = bodyText(request.text, 'social DM reply body');
  const replyToMessageId = messageId(request.replyToMessageId, 'social DM reply message id');
  const conversationWindow = createMetaConversationWindowEvidence({ ...request.conversationWindow });
  if (conversationWindow.evidenceSha256 !== request.conversationWindow.evidenceSha256
      || conversationWindow.inboundMessageId !== replyToMessageId) {
    fail('conversation window is not bound to the inbound reply message');
  }
  const canonical = { network: request.network, text, replyToMessageId };
  return Object.freeze({
    ...canonical, recipientId,
    recipientSha256: createHash('sha256').update(recipientId, 'utf8').digest('hex'),
    bodySha256: metaCanonicalSha256(canonical), conversationWindow,
  });
}

interface CachedResult {
  readonly operationId: string;
  readonly requestSha256: string;
  readonly result: MetaContractDispatchResult;
}

export class MetaSocialDmContractAdapter {
  readonly providerId = META_SOCIAL_DM_PROVIDER_ID;
  readonly executionMode: 'disabled' | 'contract_test';
  readonly providerEffectsEnabled = false as const;
  readonly #credentials: MetaSocialDmCredentialBundle | null;
  readonly #http: MetaContractHttpTransport | null;
  readonly #observedAt: string | null;
  readonly #timeoutMs: number;
  readonly #byIdempotencyKey = new Map<string, CachedResult>();
  readonly #byOperationId = new Map<string, CachedResult>();

  constructor(options: MetaSocialDmAdapterOptions = {}) {
    this.executionMode = options.executionMode ?? 'disabled';
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1_000 || this.#timeoutMs > 30_000) {
      fail('Meta social DM timeout is invalid');
    }
    if (this.executionMode === 'disabled') {
      this.#credentials = null;
      this.#http = null;
      this.#observedAt = null;
      return;
    }
    if (this.executionMode !== 'contract_test' || !options.credentials
        || !isAuthenticMetaContractHttpTransport(options.http)) {
      fail('Meta social DM contract-test mode requires opaque credentials and an authentic scripted transport');
    }
    this.#credentials = options.credentials;
    this.#http = options.http;
    this.#observedAt = metaTimestamp(options.observedAt, 'observedAt');
  }

  async reply(
    context: ProviderOperationContext,
    request: MetaSocialDmReplyRequest,
  ): Promise<MetaContractDispatchResult> {
    if (this.executionMode !== 'contract_test' || !this.#credentials || !this.#http || !this.#observedAt) {
      throw new MetaProviderEffectsDisabledError();
    }
    metaBoundContext(context, this.#credentials, META_SOCIAL_DM_PROVIDER_ID);
    const payload = replyPayload(request);
    if (payload.network !== this.#credentials.network) fail('social DM request is not bound to the credential network');
    if (Date.parse(payload.conversationWindow.openedAt) > Date.parse(this.#observedAt) + 300_000
        || Date.parse(payload.conversationWindow.validUntil) < Date.parse(this.#observedAt)) {
      fail('social DM conversation window is not current');
    }
    if (request.evidence.instigatorType !== 'customer_inbound') {
      fail('social DM reply requires customer-inbound instigator evidence');
    }
    assertMetaOutboundPreconditions({
      context, providerId: META_SOCIAL_DM_PROVIDER_ID, channel: payload.network,
      recipientSha256: payload.recipientSha256, bodySha256: payload.bodySha256,
      evidence: request.evidence, controls: request.controls, observedAt: this.#observedAt,
    });
    const resourceId = payload.network === 'facebook'
      ? this.#credentials.pageId : this.#credentials.instagramAccountId!;
    const origin = payload.network === 'facebook' ? 'https://graph.facebook.com' : 'https://graph.instagram.com';
    const url = `${origin}/${this.#credentials.graphApiVersion}/${resourceId}/messages`;
    const body = { recipient: { id: payload.recipientId }, message: { text: payload.text } };
    const bodyUtf8 = JSON.stringify(body);
    const requestSha256 = metaCanonicalSha256({
      context: {
        operationId: context.operationId, idempotencyKey: context.idempotencyKey,
        correlationId: context.correlationId,
      },
      url, body, replyToMessageId: payload.replyToMessageId,
      conversationWindow: payload.conversationWindow.evidenceSha256,
      evidence: request.evidence.evidenceSha256, controls: request.controls.controlSha256,
    });
    const cacheKey = `${context.workspaceId}:${context.connectionId}:${context.idempotencyKey}`;
    const existing = this.#byIdempotencyKey.get(cacheKey) ?? this.#byOperationId.get(context.operationId);
    if (existing) {
      if (existing.requestSha256 !== requestSha256 || existing.operationId !== context.operationId) {
        throw new MetaIdempotencyConflictError();
      }
      return Object.freeze({ ...existing.result, disposition: 'replayed' });
    }
    const httpRequest: MetaHttpRequest = Object.freeze({
      method: 'POST', url,
      headers: Object.freeze({ 'Content-Type': 'application/json' }),
      bodyUtf8, timeoutMs: this.#timeoutMs, redirectPolicy: 'error', maximumResponseBytes: 65_536,
    });
    let status: MetaContractDispatchResult['status'] = 'outcome_unknown';
    let providerMessageId: string | null = null;
    let summary = 'Meta social DM contract transport did not prove a response';
    try {
      const response = await executeMetaAuthorizedContractHttpRequest(
        this.#http, this.#credentials, httpRequest,
      );
      const parsed = parseBoundedJson(response.bodyUtf8);
      const candidate = parsed?.message_id;
      if (response.status >= 200 && response.status < 300
          && parsed?.recipient_id === payload.recipientId
          && typeof candidate === 'string' && MESSAGE_ID.test(candidate)) {
        status = 'contract_accepted';
        providerMessageId = candidate;
        summary = 'Scripted Meta social DM response accepted the exact reply contract';
      } else if (response.status < 500 && response.status !== 408 && response.status !== 409 && response.status !== 429) {
        status = 'contract_rejected';
        summary = 'Scripted Meta social DM response rejected the reply contract';
      }
    } catch {
      // No raw provider/token material crosses this result boundary.
    }
    const result = Object.freeze({
      status, providerMessageId, occurredAt: this.#observedAt, disposition: 'applied' as const,
      requestSha256, providerEffectAttempted: false as const, providerEffectsEnabled: false as const, summary,
    });
    const cached = Object.freeze({ operationId: context.operationId, requestSha256, result });
    this.#byIdempotencyKey.set(cacheKey, cached);
    this.#byOperationId.set(context.operationId, cached);
    return result;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({ providerId: this.providerId, executionMode: this.executionMode,
      providerEffectsEnabled: false, credentials: '[REDACTED]' });
  }
}

/** Verifies exact raw bytes first, then parses Messenger/Instagram `messages` events. */
export function ingestMetaSocialDmWebhook(input: Readonly<{
  credentials: MetaSocialDmCredentialBundle;
  rawBody: Uint8Array;
  xHubSignature256: unknown;
  contentType: unknown;
}>): readonly VerifiedMetaSocialDmInbound[] {
  const credentials = input.credentials;
  const parsed = verifyMetaSignedJson(credentials, input);
  const root = record(parsed, 'social DM webhook');
  allowedKeys(root, ['object', 'entry'], 'social DM webhook');
  const expectedObject = credentials.network === 'facebook' ? 'page' : 'instagram';
  if (root.object !== expectedObject) fail('social DM webhook object is not bound to the credential network');
  const resourceId = credentials.network === 'facebook' ? credentials.pageId : credentials.instagramAccountId!;
  const events: VerifiedMetaSocialDmInbound[] = [];
  const byMessageId = new Map<string, string>();
  for (const rawEntry of boundedArray(root.entry, 20, 'social DM webhook entries')) {
    const entry = record(rawEntry, 'social DM webhook entry');
    allowedKeys(entry, ['id', 'time', 'messaging'], 'social DM webhook entry');
    if (metaPlatformId(entry.id, 'social DM webhook resource id') !== resourceId) {
      fail('social DM webhook is not bound to this page or professional account');
    }
    for (const rawMessaging of boundedArray(entry.messaging, MAX_EVENTS, 'social DM messaging events')) {
      const messaging = record(rawMessaging, 'social DM messaging event');
      allowedKeys(messaging, ['sender', 'recipient', 'timestamp', 'message', 'postback'],
        'social DM messaging event');
      if (messaging.message === undefined) continue;
      const sender = record(messaging.sender, 'social DM sender');
      const recipient = record(messaging.recipient, 'social DM recipient');
      allowedKeys(sender, ['id'], 'social DM sender');
      allowedKeys(recipient, ['id'], 'social DM recipient');
      const senderId = metaPlatformId(sender.id, 'social DM sender id');
      const eventRecipientId = metaPlatformId(recipient.id, 'social DM recipient id');
      const message = record(messaging.message, 'social DM message');
      allowedKeys(message, ['mid', 'text', 'is_echo', 'attachments', 'quick_reply', 'reply_to'],
        'social DM message');
      if (message.attachments !== undefined) {
        boundedArray(message.attachments, 10, 'social DM message attachments');
      }
      if (message.is_echo === true || message.text === undefined) continue;
      if (message.is_echo !== undefined && message.is_echo !== false) fail('social DM echo flag is invalid');
      if (eventRecipientId !== resourceId) {
        fail('social DM event recipient is not bound to this connection');
      }
      const id = messageId(message.mid, 'social DM message id');
      const body = bodyText(message.text, 'social DM inbound body');
      const occurredAt = epochMilliseconds(messaging.timestamp);
      const fingerprint = metaCanonicalSha256({ senderId, resourceId, body, occurredAt });
      const prior = byMessageId.get(id);
      if (prior && prior !== fingerprint) fail('social DM webhook contains a replay conflict');
      if (prior) continue;
      if (events.length >= MAX_EVENTS) fail('social DM webhook contains too many inbound messages');
      byMessageId.set(id, fingerprint);
      const event = Object.freeze({
        provider: META_SOCIAL_DM_PROVIDER_ID, network: credentials.network,
        workspaceId: credentials.workspaceId, connectionId: credentials.connectionId,
        resourceId, messageId: id, senderId,
        senderIdSha256: createHash('sha256').update(senderId, 'utf8').digest('hex'), body, occurredAt,
      });
      VERIFIED.add(event);
      events.push(event);
    }
  }
  return Object.freeze(events);
}

export function toMetaSocialDmInboxCommand(
  event: VerifiedMetaSocialDmInbound,
  binding: MetaSocialDmInboxBinding,
): RecordTestInboundCommand {
  if (!VERIFIED.has(event)) fail('social DM webhook must be verified before inbox mapping');
  if (event.workspaceId !== metaUuid(binding.workspaceId, 'binding.workspaceId')
      || event.connectionId !== metaUuid(binding.connectionId, 'binding.connectionId')
      || event.network !== binding.network
      || event.senderIdSha256 !== metaSha256(binding.senderIdSha256, 'binding.senderIdSha256')) {
    fail('social DM webhook does not match the workspace inbox binding');
  }
  return Object.freeze({
    commandKey: `meta-social-dm-inbound:${createHash('sha256').update(event.messageId, 'utf8').digest('hex')}`,
    inboxId: metaUuid(binding.inboxId, 'binding.inboxId'),
    contactId: metaUuid(binding.contactId, 'binding.contactId'),
    contactPointId: metaUuid(binding.contactPointId, 'binding.contactPointId'),
    body: event.body,
    occurredAt: event.occurredAt,
  });
}
