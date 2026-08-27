import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { RecordTestInboundCommand } from '../inbox-pg/types.js';
import {
  WHATSAPP_DARK_PROVIDER_ID,
  WhatsAppDarkContractError,
  assertReservedWhatsAppTestNumber,
  assertWhatsAppDarkUuid,
} from './contracts.js';

const MAX_WEBHOOK_BYTES = 256 * 1024;
const SIGNATURE = /^sha256=([a-f0-9]{64})$/u;
const EVENT_ID = /^waevt_[a-f0-9]{32}$/u;
const MESSAGE_ID = /^wamsg_test_[a-f0-9]{32}$/u;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE_BODY = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u;
const VERIFIED_EVENTS = new WeakSet<object>();

export interface SimulatedWhatsAppInboundEvent {
  readonly schemaVersion: 1;
  readonly environment: 'test';
  readonly providerId: typeof WHATSAPP_DARK_PROVIDER_ID;
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly event: Readonly<{
    type: 'message.inbound';
    messageId: string;
    from: string;
    to: string;
    body: string;
  }>;
}

export interface SignedSimulatedWhatsAppWebhook {
  readonly rawBody: Uint8Array;
  readonly signature: string;
  readonly contentType: 'application/json';
  readonly environment: 'test';
}

export interface OwnInboxWhatsAppBinding {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly inboxId: string;
  readonly contactId: string;
  readonly contactPointId: string;
  readonly ownedTestNumber: string;
  readonly sourceTestNumber: string;
}

function fail(message: string): never {
  throw new WhatsAppDarkContractError(message);
}

function webhookSecret(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 32
      || Buffer.byteLength(value, 'utf8') > 256 || /[^\x21-\x7e]/u.test(value)) {
    fail('simulated webhook secret is invalid');
  }
  return value;
}

function exactKeys(value: unknown, expected: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is invalid`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has an invalid shape`);
  }
  return record;
}

function occurredAt(value: unknown): string {
  if (typeof value !== 'string' || !RFC3339_UTC.test(value)
      || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail('webhook occurredAt is invalid');
  }
  return value;
}

function inboundBody(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096
      || Buffer.byteLength(value, 'utf8') > 16_384 || !SAFE_BODY.test(value)) {
    fail('webhook body is invalid');
  }
  return value;
}

function normalizedEvent(value: unknown): SimulatedWhatsAppInboundEvent {
  const root = exactKeys(value, [
    'schemaVersion', 'environment', 'providerId', 'workspaceId', 'connectionId',
    'eventId', 'occurredAt', 'event',
  ], 'webhook envelope');
  if (root.schemaVersion !== 1 || root.environment !== 'test'
      || root.providerId !== WHATSAPP_DARK_PROVIDER_ID
      || typeof root.eventId !== 'string' || !EVENT_ID.test(root.eventId)) {
    fail('webhook envelope binding is invalid');
  }
  const event = exactKeys(root.event, ['type', 'messageId', 'from', 'to', 'body'], 'webhook event');
  if (event.type !== 'message.inbound'
      || typeof event.messageId !== 'string' || !MESSAGE_ID.test(event.messageId)) {
    fail('webhook event binding is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    environment: 'test',
    providerId: WHATSAPP_DARK_PROVIDER_ID,
    workspaceId: assertWhatsAppDarkUuid(root.workspaceId, 'webhook.workspaceId'),
    connectionId: assertWhatsAppDarkUuid(root.connectionId, 'webhook.connectionId'),
    eventId: root.eventId,
    occurredAt: occurredAt(root.occurredAt),
    event: Object.freeze({
      type: 'message.inbound',
      messageId: event.messageId,
      from: assertReservedWhatsAppTestNumber(event.from, 'webhook.from'),
      to: assertReservedWhatsAppTestNumber(event.to, 'webhook.to'),
      body: inboundBody(event.body),
    }),
  });
}

export function createSignedSimulatedWhatsAppInbound(input: Readonly<{
  workspaceId: string;
  connectionId: string;
  from: string;
  to: string;
  body: string;
  occurredAt: string;
  testSecret: string;
}>): SignedSimulatedWhatsAppWebhook {
  const snapshot = {
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    from: input.from,
    to: input.to,
    body: input.body,
    occurredAt: input.occurredAt,
    testSecret: input.testSecret,
  };
  const seed = [
    snapshot.workspaceId, snapshot.connectionId, snapshot.from,
    snapshot.to, snapshot.occurredAt, snapshot.body,
  ].join('\n');
  const digest = createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32);
  const event = normalizedEvent({
    schemaVersion: 1,
    environment: 'test',
    providerId: WHATSAPP_DARK_PROVIDER_ID,
    workspaceId: snapshot.workspaceId,
    connectionId: snapshot.connectionId,
    eventId: `waevt_${digest}`,
    occurredAt: snapshot.occurredAt,
    event: {
      type: 'message.inbound',
      messageId: `wamsg_test_${digest}`,
      from: snapshot.from,
      to: snapshot.to,
      body: snapshot.body,
    },
  });
  const rawBody = new TextEncoder().encode(JSON.stringify(event));
  const secret = webhookSecret(snapshot.testSecret);
  return Object.freeze({
    rawBody,
    signature: `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
    contentType: 'application/json',
    environment: 'test',
  });
}

export function verifySimulatedWhatsAppWebhook(input: Readonly<{
  rawBody: Uint8Array;
  signature: string;
  contentType: string;
  testSecret: string;
}>): SimulatedWhatsAppInboundEvent {
  const suppliedBody = input.rawBody;
  if (!(suppliedBody instanceof Uint8Array)) fail('webhook byte length is invalid');
  const rawBody = Uint8Array.from(suppliedBody);
  if (rawBody.byteLength < 2 || rawBody.byteLength > MAX_WEBHOOK_BYTES) {
    fail('webhook byte length is invalid');
  }
  const suppliedSignature = input.signature;
  const suppliedContentType = input.contentType;
  const suppliedSecret = input.testSecret;
  if (typeof suppliedContentType !== 'string'
      || suppliedContentType.toLowerCase().split(';', 1)[0]?.trim() !== 'application/json') {
    fail('webhook media type is invalid');
  }
  const signature = typeof suppliedSignature === 'string' ? SIGNATURE.exec(suppliedSignature) : null;
  if (!signature) fail('webhook signature is invalid');
  const expected = createHmac('sha256', webhookSecret(suppliedSecret)).update(rawBody).digest();
  const supplied = Buffer.from(signature[1]!, 'hex');
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    fail('webhook signature is invalid');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
  } catch {
    fail('webhook body is not valid UTF-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail('webhook body is not valid JSON');
  }
  const event = normalizedEvent(parsed);
  VERIFIED_EVENTS.add(event);
  return event;
}

/** Maps an authenticated test event into the existing inbox command surface. */
export function toOwnInboxTestInbound(
  event: SimulatedWhatsAppInboundEvent,
  binding: OwnInboxWhatsAppBinding,
): RecordTestInboundCommand {
  if (!VERIFIED_EVENTS.has(event)) fail('webhook must be authenticated before inbox mapping');
  const workspaceId = assertWhatsAppDarkUuid(binding.workspaceId, 'binding.workspaceId');
  const connectionId = assertWhatsAppDarkUuid(binding.connectionId, 'binding.connectionId');
  const inboxId = assertWhatsAppDarkUuid(binding.inboxId, 'binding.inboxId');
  const contactId = assertWhatsAppDarkUuid(binding.contactId, 'binding.contactId');
  const contactPointId = assertWhatsAppDarkUuid(binding.contactPointId, 'binding.contactPointId');
  const owned = assertReservedWhatsAppTestNumber(binding.ownedTestNumber, 'binding.ownedTestNumber');
  const source = assertReservedWhatsAppTestNumber(binding.sourceTestNumber, 'binding.sourceTestNumber');
  if (event.workspaceId !== workspaceId || event.connectionId !== connectionId
      || event.event.to !== owned || event.event.from !== source) {
    fail('webhook does not match the own-inbox test binding');
  }
  return Object.freeze({
    commandKey: `whatsapp-test-inbound:${event.eventId}`,
    inboxId,
    contactId,
    contactPointId,
    body: event.event.body,
    occurredAt: event.occurredAt,
  });
}
