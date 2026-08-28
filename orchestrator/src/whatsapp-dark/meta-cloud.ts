import { createHash } from 'node:crypto';
import type { RecordTestInboundCommand } from '../inbox-pg/types.js';
import type { ProviderOperationContext } from '../providers/contracts.js';
import {
  META_WHATSAPP_PROVIDER_ID,
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
  type MetaWhatsAppCredentialBundle,
} from '../meta-communications/contracts.js';

const E164_DIGITS = /^[1-9][0-9]{6,14}$/u;
const TEMPLATE_NAME = /^[a-z][a-z0-9_]{0,511}$/u;
const LANGUAGE = /^[a-z]{2,3}(?:_[A-Z]{2})?$/u;
const SAFE_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u;
const MESSAGE_ID = /^wamid\.[A-Za-z0-9_=-]{1,190}$/u;
const MAX_EVENTS = 100;
const VERIFIED = new WeakSet<object>();

export interface MetaWhatsAppTemplateRequest {
  readonly recipient: string;
  readonly templateName: string;
  readonly languageCode: string;
  readonly bodyParameters: readonly string[];
  readonly evidence: MetaOutboundEvidence;
  readonly controls: MetaOutboundControlEvidence;
}

export interface VerifiedMetaWhatsAppInbound {
  readonly provider: typeof META_WHATSAPP_PROVIDER_ID;
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly wabaId: string;
  readonly phoneNumberId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly senderIdSha256: string;
  readonly body: string;
  readonly occurredAt: string;
}

export interface MetaWhatsAppInboxBinding {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly inboxId: string;
  readonly contactId: string;
  readonly contactPointId: string;
  readonly senderIdSha256: string;
}

export interface MetaWhatsAppCloudAdapterOptions {
  /** Defaults to disabled. This strike deliberately has no live execution mode. */
  readonly executionMode?: 'disabled' | 'contract_test';
  readonly credentials?: MetaWhatsAppCredentialBundle;
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

function recipient(value: unknown): string {
  if (typeof value !== 'string' || !E164_DIGITS.test(value)) fail('WhatsApp recipient is invalid');
  return value;
}

function text(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== 'string' || value.length < 1 || !SAFE_TEXT.test(value)
      || Buffer.byteLength(value, 'utf8') > maximumBytes) fail(`${label} is invalid`);
  return value;
}

function unixSeconds(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{10,13}$/u.test(value)) fail('WhatsApp timestamp is invalid');
  const number = Number(value);
  const milliseconds = value.length <= 10 ? number * 1_000 : number;
  if (!Number.isSafeInteger(milliseconds)) fail('WhatsApp timestamp is invalid');
  return new Date(milliseconds).toISOString();
}

function templatePayload(request: MetaWhatsAppTemplateRequest): Readonly<{
  recipient: string; templateName: string; languageCode: string; bodyParameters: readonly string[];
  bodySha256: string; recipientSha256: string;
}> {
  const exactRecipient = recipient(request.recipient);
  if (typeof request.templateName !== 'string' || !TEMPLATE_NAME.test(request.templateName)) {
    fail('WhatsApp template name is invalid');
  }
  if (typeof request.languageCode !== 'string' || !LANGUAGE.test(request.languageCode)) {
    fail('WhatsApp template language is invalid');
  }
  if (!Array.isArray(request.bodyParameters) || request.bodyParameters.length > 20) {
    fail('WhatsApp template parameters are invalid');
  }
  const parameters = Object.freeze(request.bodyParameters.map((value, index) =>
    text(value, `WhatsApp template parameter ${index}`, 1_024)));
  const canonical = {
    templateName: request.templateName,
    languageCode: request.languageCode,
    bodyParameters: parameters,
  };
  return Object.freeze({
    recipient: exactRecipient,
    ...canonical,
    bodySha256: metaCanonicalSha256(canonical),
    recipientSha256: createHash('sha256').update(exactRecipient, 'utf8').digest('hex'),
  });
}

interface CachedResult {
  readonly operationId: string;
  readonly requestSha256: string;
  readonly result: MetaContractDispatchResult;
}

export class MetaWhatsAppCloudContractAdapter {
  readonly providerId = META_WHATSAPP_PROVIDER_ID;
  readonly executionMode: 'disabled' | 'contract_test';
  readonly providerEffectsEnabled = false as const;
  readonly #credentials: MetaWhatsAppCredentialBundle | null;
  readonly #http: MetaContractHttpTransport | null;
  readonly #observedAt: string | null;
  readonly #timeoutMs: number;
  readonly #byIdempotencyKey = new Map<string, CachedResult>();
  readonly #byOperationId = new Map<string, CachedResult>();

  constructor(options: MetaWhatsAppCloudAdapterOptions = {}) {
    this.executionMode = options.executionMode ?? 'disabled';
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1_000 || this.#timeoutMs > 30_000) {
      fail('Meta WhatsApp timeout is invalid');
    }
    if (this.executionMode === 'disabled') {
      this.#credentials = null;
      this.#http = null;
      this.#observedAt = null;
      return;
    }
    if (this.executionMode !== 'contract_test' || !options.credentials
        || !isAuthenticMetaContractHttpTransport(options.http)) {
      fail('Meta WhatsApp contract-test mode requires opaque credentials and an authentic scripted transport');
    }
    this.#credentials = options.credentials;
    this.#http = options.http;
    this.#observedAt = metaTimestamp(options.observedAt, 'observedAt');
  }

  async sendTemplate(
    context: ProviderOperationContext,
    request: MetaWhatsAppTemplateRequest,
  ): Promise<MetaContractDispatchResult> {
    if (this.executionMode !== 'contract_test' || !this.#credentials || !this.#http || !this.#observedAt) {
      throw new MetaProviderEffectsDisabledError();
    }
    metaBoundContext(context, this.#credentials, META_WHATSAPP_PROVIDER_ID);
    const payload = templatePayload(request);
    assertMetaOutboundPreconditions({
      context, providerId: META_WHATSAPP_PROVIDER_ID, channel: 'whatsapp',
      recipientSha256: payload.recipientSha256, bodySha256: payload.bodySha256,
      evidence: request.evidence, controls: request.controls, observedAt: this.#observedAt,
    });
    const body: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      to: payload.recipient,
      type: 'template',
      template: {
        name: payload.templateName,
        language: { code: payload.languageCode },
        ...(payload.bodyParameters.length === 0 ? {} : {
          components: [{
            type: 'body',
            parameters: payload.bodyParameters.map((parameter) => ({ type: 'text', text: parameter })),
          }],
        }),
      },
    };
    const url = `https://graph.facebook.com/${this.#credentials.graphApiVersion}/${this.#credentials.phoneNumberId}/messages`;
    const bodyUtf8 = JSON.stringify(body);
    const requestSha256 = metaCanonicalSha256({
      context: {
        operationId: context.operationId, idempotencyKey: context.idempotencyKey,
        correlationId: context.correlationId,
      },
      url, body, evidence: request.evidence.evidenceSha256,
      controls: request.controls.controlSha256,
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
    let summary = 'Meta WhatsApp contract transport did not prove a response';
    try {
      const response = await executeMetaAuthorizedContractHttpRequest(
        this.#http, this.#credentials, httpRequest,
      );
      const parsed = parseBoundedJson(response.bodyUtf8);
      const messages = parsed?.messages;
      const contacts = parsed?.contacts;
      const candidate = Array.isArray(messages) && messages.length === 1
        ? record(messages[0], 'Meta WhatsApp response message').id : null;
      const responseRecipient = Array.isArray(contacts) && contacts.length === 1
        ? record(contacts[0], 'Meta WhatsApp response contact').input : null;
      if (response.status >= 200 && response.status < 300
          && parsed?.messaging_product === 'whatsapp'
          && responseRecipient === payload.recipient
          && typeof candidate === 'string' && MESSAGE_ID.test(candidate)) {
        status = 'contract_accepted';
        providerMessageId = candidate;
        summary = 'Scripted Meta WhatsApp response accepted the exact contract request';
      } else if (response.status < 500 && response.status !== 408 && response.status !== 409 && response.status !== 429) {
        status = 'contract_rejected';
        summary = 'Scripted Meta WhatsApp response rejected the contract request';
      }
    } catch {
      // Safe, bounded result only. Provider/token details never enter evidence or error text.
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

/** Verifies exact raw bytes first, then parses the bounded official `messages` webhook shape. */
export function ingestMetaWhatsAppWebhook(input: Readonly<{
  credentials: MetaWhatsAppCredentialBundle;
  rawBody: Uint8Array;
  xHubSignature256: unknown;
  contentType: unknown;
}>): readonly VerifiedMetaWhatsAppInbound[] {
  const credentials = input.credentials;
  const parsed = verifyMetaSignedJson(credentials, input);
  const root = record(parsed, 'WhatsApp webhook');
  allowedKeys(root, ['object', 'entry'], 'WhatsApp webhook');
  if (root.object !== 'whatsapp_business_account') fail('WhatsApp webhook object is invalid');
  const events: VerifiedMetaWhatsAppInbound[] = [];
  const byMessageId = new Map<string, string>();
  for (const rawEntry of boundedArray(root.entry, 20, 'WhatsApp webhook entries')) {
    const entry = record(rawEntry, 'WhatsApp webhook entry');
    allowedKeys(entry, ['id', 'changes'], 'WhatsApp webhook entry');
    const wabaId = metaPlatformId(entry.id, 'WhatsApp webhook WABA id');
    if (wabaId !== credentials.wabaId) fail('WhatsApp webhook is not bound to this WABA');
    for (const rawChange of boundedArray(entry.changes, 20, 'WhatsApp webhook changes')) {
      const change = record(rawChange, 'WhatsApp webhook change');
      allowedKeys(change, ['field', 'value'], 'WhatsApp webhook change');
      if (change.field !== 'messages') continue;
      const value = record(change.value, 'WhatsApp webhook value');
      allowedKeys(value, ['messaging_product', 'metadata', 'contacts', 'messages', 'statuses', 'errors'],
        'WhatsApp webhook value');
      if (value.messaging_product !== 'whatsapp') fail('WhatsApp webhook product is invalid');
      for (const optionalArray of ['contacts', 'statuses', 'errors'] as const) {
        if (value[optionalArray] !== undefined) {
          boundedArray(value[optionalArray], MAX_EVENTS, `WhatsApp ${optionalArray}`);
        }
      }
      const metadata = record(value.metadata, 'WhatsApp webhook metadata');
      allowedKeys(metadata, ['display_phone_number', 'phone_number_id'], 'WhatsApp webhook metadata');
      const phoneNumberId = metaPlatformId(metadata.phone_number_id, 'WhatsApp webhook phone id');
      if (phoneNumberId !== credentials.phoneNumberId) fail('WhatsApp webhook is not bound to this phone number');
      const messages = value.messages === undefined ? [] : boundedArray(value.messages, MAX_EVENTS, 'WhatsApp messages');
      for (const rawMessage of messages) {
        const message = record(rawMessage, 'WhatsApp message');
        allowedKeys(message, ['from', 'id', 'timestamp', 'type', 'text', 'context'], 'WhatsApp message');
        if (message.type !== 'text') continue;
        const messageId = typeof message.id === 'string' && MESSAGE_ID.test(message.id)
          ? message.id : fail('WhatsApp message id is invalid');
        const senderId = recipient(message.from);
        const textObject = record(message.text, 'WhatsApp text message');
        allowedKeys(textObject, ['body'], 'WhatsApp text message');
        const body = text(textObject.body, 'WhatsApp inbound body', 16_384);
        const occurredAt = unixSeconds(message.timestamp);
        const fingerprint = metaCanonicalSha256({ senderId, body, occurredAt, phoneNumberId });
        const prior = byMessageId.get(messageId);
        if (prior && prior !== fingerprint) fail('WhatsApp webhook contains a replay conflict');
        if (prior) continue;
        if (events.length >= MAX_EVENTS) fail('WhatsApp webhook contains too many inbound messages');
        byMessageId.set(messageId, fingerprint);
        const event = Object.freeze({
          provider: META_WHATSAPP_PROVIDER_ID, workspaceId: credentials.workspaceId,
          connectionId: credentials.connectionId, wabaId, phoneNumberId, messageId, senderId,
          senderIdSha256: createHash('sha256').update(senderId, 'utf8').digest('hex'), body, occurredAt,
        });
        VERIFIED.add(event);
        events.push(event);
      }
    }
  }
  return Object.freeze(events);
}

export function toMetaWhatsAppInboxCommand(
  event: VerifiedMetaWhatsAppInbound,
  binding: MetaWhatsAppInboxBinding,
): RecordTestInboundCommand {
  if (!VERIFIED.has(event)) fail('WhatsApp webhook must be verified before inbox mapping');
  if (event.workspaceId !== metaUuid(binding.workspaceId, 'binding.workspaceId')
      || event.connectionId !== metaUuid(binding.connectionId, 'binding.connectionId')
      || event.senderIdSha256 !== metaSha256(binding.senderIdSha256, 'binding.senderIdSha256')) {
    fail('WhatsApp webhook does not match the workspace inbox binding');
  }
  return Object.freeze({
    commandKey: `meta-whatsapp-inbound:${createHash('sha256').update(event.messageId, 'utf8').digest('hex')}`,
    inboxId: metaUuid(binding.inboxId, 'binding.inboxId'),
    contactId: metaUuid(binding.contactId, 'binding.contactId'),
    contactPointId: metaUuid(binding.contactPointId, 'binding.contactPointId'),
    body: event.body,
    occurredAt: event.occurredAt,
  });
}
