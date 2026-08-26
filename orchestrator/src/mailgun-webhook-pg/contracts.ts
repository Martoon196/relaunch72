import { TextDecoder } from 'node:util';
import {
  MAILGUN_WEBHOOK_EVENT_TYPES,
  MailgunWebhookBodyTooLargeError,
  MailgunWebhookContractError,
  type MailgunFailureSeverity,
  type MailgunWebhookEventType,
  type MailgunWebhookSignatureFields,
  type ParsedMailgunWebhookEvent,
} from './types.js';

export const MAILGUN_WEBHOOK_MAX_BODY_BYTES = 128 * 1024;

export interface DecodedMailgunWebhookEnvelope {
  readonly signature: Readonly<MailgunWebhookSignatureFields>;
  readonly eventData: unknown;
}

function fail(message: string): never {
  throw new MailgunWebhookContractError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, label: string, keys: readonly string[]): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail(`${label} contains an unsupported field`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${label} is missing a required field`);
  }
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== 'string') return fail(`${label} must be a string`);
  return value;
}

/** Decode only the signed envelope. Event normalization deliberately follows authentication. */
export function decodeMailgunWebhookEnvelope(rawBody: Uint8Array): DecodedMailgunWebhookEnvelope {
  if (!(rawBody instanceof Uint8Array)) throw new TypeError('rawBody must be a Uint8Array');
  if (rawBody.byteLength > MAILGUN_WEBHOOK_MAX_BODY_BYTES) {
    throw new MailgunWebhookBodyTooLargeError();
  }
  if (rawBody.byteLength === 0) return fail('Mailgun webhook body must not be empty');

  let json: string;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
  } catch {
    return fail('Mailgun webhook body must be valid UTF-8 JSON');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(json) as unknown;
  } catch {
    return fail('Mailgun webhook body must be valid UTF-8 JSON');
  }

  const envelope = record(decoded, 'Mailgun webhook envelope');
  exactKeys(envelope, 'Mailgun webhook envelope', ['signature', 'event-data']);
  const signature = record(envelope.signature, 'Mailgun signature');
  exactKeys(signature, 'Mailgun signature', ['timestamp', 'token', 'signature']);
  return Object.freeze({
    signature: Object.freeze({
      timestamp: exactString(signature.timestamp, 'Mailgun signature timestamp'),
      token: exactString(signature.token, 'Mailgun signature token'),
      signature: exactString(signature.signature, 'Mailgun signature digest'),
    }),
    eventData: envelope['event-data'],
  });
}

function safeReference(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string'
      || value !== value.trim()
      || value.length < 1
      || value.length > maximum
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    return fail(`${label} is invalid`);
  }
  return value;
}

function eventId(value: unknown): string {
  const candidate = safeReference(value, 'Mailgun event id', 255);
  if (!/^[A-Za-z0-9._:+/=-]+$/u.test(candidate)) {
    return fail('Mailgun event id is invalid');
  }
  return candidate;
}

function eventType(value: unknown): MailgunWebhookEventType {
  if (typeof value !== 'string'
      || !(MAILGUN_WEBHOOK_EVENT_TYPES as readonly string[]).includes(value)) {
    return fail('Mailgun event type is unsupported');
  }
  return value as MailgunWebhookEventType;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 946_684_800 || value > 4_102_444_800) {
    return fail('Mailgun event timestamp is invalid');
  }
  const date = new Date(value * 1_000);
  if (!Number.isFinite(date.getTime())) return fail('Mailgun event timestamp is invalid');
  return date.toISOString();
}

function normalizedEmail(value: unknown): string {
  const email = safeReference(value, 'Mailgun recipient', 320);
  if (!/^[^\s@]+@[^\s@]+$/u.test(email)) return fail('Mailgun recipient is invalid');
  return email.toLowerCase();
}

function providerMessageId(value: Record<string, unknown>): string {
  const message = record(value.message, 'Mailgun event message');
  const headers = record(message.headers, 'Mailgun event message headers');
  const raw = safeReference(headers['message-id'], 'Mailgun provider message id', 500);
  const canonical = raw.startsWith('<') && raw.endsWith('>')
    ? raw.slice(1, -1)
    : raw;
  if (canonical.length < 1 || canonical.length > 498
      || canonical.includes('<') || canonical.includes('>')
      || !canonical.includes('@')) {
    return fail('Mailgun provider message id is invalid');
  }
  return canonical;
}

function failureSeverity(
  type: MailgunWebhookEventType,
  value: Record<string, unknown>,
): MailgunFailureSeverity | null {
  if (type !== 'failed') return null;
  if (value.severity !== 'temporary' && value.severity !== 'permanent') {
    return fail('Mailgun failed event severity is invalid');
  }
  return value.severity;
}

export function parseMailgunWebhookEventData(value: unknown): ParsedMailgunWebhookEvent {
  const event = record(value, 'Mailgun event-data');
  const type = eventType(event.event);
  return Object.freeze({
    externalEventId: eventId(event.id),
    eventType: type,
    occurredAt: timestamp(event.timestamp),
    providerMessageId: providerMessageId(event),
    normalizedRecipient: normalizedEmail(event.recipient),
    failureSeverity: failureSeverity(type, event),
  });
}
