import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { RecordTestInboundCommand } from '../inbox-pg/types.js';
import {
  SOCIAL_DM_DARK_PROVIDER_ID,
  SocialDmDarkContractError,
  socialDmDarkNetwork,
  socialDmDarkTestAddress,
  socialDmDarkUuid,
  type SocialDmNetwork,
} from './contracts.js';

const MAX_BYTES = 256 * 1024;
const SIGNATURE = /^sha256=([a-f0-9]{64})$/u;
const EVENT_ID = /^social_dm_evt_[a-f0-9]{32}$/u;
const MESSAGE_REF = /^test-dm-message_[a-f0-9]{32}$/u;
const THREAD_REF = /^test-dm-thread_[a-f0-9]{32}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE_BODY = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u;
const VERIFIED = new WeakSet<object>();

export interface VerifiedSocialDmDarkInbound {
  readonly schemaVersion: 1;
  readonly environment: 'test';
  readonly providerId: typeof SOCIAL_DM_DARK_PROVIDER_ID;
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly event: Readonly<{
    type: 'message.inbound';
    network: SocialDmNetwork;
    threadRef: string;
    messageRef: string;
    from: string;
    to: string;
    body: string;
  }>;
}

export interface SocialDmOwnInboxBinding {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly inboxId: string;
  readonly contactId: string;
  readonly contactPointId: string;
  readonly network: SocialDmNetwork;
  readonly ownedTestAddress: string;
  readonly sourceTestAddress: string;
}

function fail(message: string): never {
  throw new SocialDmDarkContractError(message);
}

function secret(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 32
      || Buffer.byteLength(value, 'utf8') > 256 || /[^\x21-\x7e]/u.test(value)) fail('test secret is invalid');
  return value;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is invalid`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} shape is invalid`);
  }
  return value as Record<string, unknown>;
}

function normalize(value: unknown): VerifiedSocialDmDarkInbound {
  const root = exactRecord(value, [
    'schemaVersion', 'environment', 'providerId', 'workspaceId', 'connectionId',
    'eventId', 'occurredAt', 'event',
  ], 'webhook envelope');
  if (root.schemaVersion !== 1 || root.environment !== 'test' || root.providerId !== SOCIAL_DM_DARK_PROVIDER_ID
      || typeof root.eventId !== 'string' || !EVENT_ID.test(root.eventId)
      || typeof root.occurredAt !== 'string' || !RFC3339.test(root.occurredAt)
      || Number.isNaN(Date.parse(root.occurredAt)) || new Date(root.occurredAt).toISOString() !== root.occurredAt) {
    fail('webhook envelope binding is invalid');
  }
  const event = exactRecord(root.event, [
    'type', 'network', 'threadRef', 'messageRef', 'from', 'to', 'body',
  ], 'webhook event');
  const network = socialDmDarkNetwork(event.network, 'webhook.network');
  if (event.type !== 'message.inbound' || typeof event.threadRef !== 'string' || !THREAD_REF.test(event.threadRef)
      || typeof event.messageRef !== 'string' || !MESSAGE_REF.test(event.messageRef)
      || typeof event.body !== 'string' || event.body.length < 1 || !SAFE_BODY.test(event.body)
      || Buffer.byteLength(event.body, 'utf8') > 16_384) fail('webhook event binding is invalid');
  return Object.freeze({
    schemaVersion: 1,
    environment: 'test',
    providerId: SOCIAL_DM_DARK_PROVIDER_ID,
    workspaceId: socialDmDarkUuid(root.workspaceId, 'webhook.workspaceId'),
    connectionId: socialDmDarkUuid(root.connectionId, 'webhook.connectionId'),
    eventId: root.eventId,
    occurredAt: root.occurredAt,
    event: Object.freeze({
      type: 'message.inbound', network,
      threadRef: event.threadRef, messageRef: event.messageRef,
      from: socialDmDarkTestAddress(event.from, network, 'webhook.from'),
      to: socialDmDarkTestAddress(event.to, network, 'webhook.to'),
      body: event.body,
    }),
  });
}

export function createSignedSocialDmDarkInbound(input: Readonly<{
  workspaceId: string;
  connectionId: string;
  network: SocialDmNetwork;
  from: string;
  to: string;
  body: string;
  occurredAt: string;
  testSecret: string;
}>): Readonly<{ rawBody: Uint8Array; signature: string; contentType: 'application/json' }> {
  const network = socialDmDarkNetwork(input.network, 'input.network');
  const seed = [input.workspaceId, input.connectionId, network, input.from, input.to, input.body, input.occurredAt]
    .join('\n');
  const digest = createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32);
  const event = normalize({
    schemaVersion: 1, environment: 'test', providerId: SOCIAL_DM_DARK_PROVIDER_ID,
    workspaceId: input.workspaceId, connectionId: input.connectionId,
    eventId: `social_dm_evt_${digest}`, occurredAt: input.occurredAt,
    event: {
      type: 'message.inbound', network,
      threadRef: `test-dm-thread_${digest}`, messageRef: `test-dm-message_${digest}`,
      from: input.from, to: input.to, body: input.body,
    },
  });
  const rawBody = new TextEncoder().encode(JSON.stringify(event));
  return Object.freeze({
    rawBody,
    signature: `sha256=${createHmac('sha256', secret(input.testSecret)).update(rawBody).digest('hex')}`,
    contentType: 'application/json',
  });
}

export function verifySocialDmDarkInbound(input: Readonly<{
  rawBody: Uint8Array;
  signature: string;
  contentType: string;
  testSecret: string;
}>): VerifiedSocialDmDarkInbound {
  const candidate = input.rawBody;
  if (!(candidate instanceof Uint8Array) || candidate.byteLength < 2 || candidate.byteLength > MAX_BYTES) {
    fail('webhook byte length is invalid');
  }
  const rawBody = Uint8Array.from(candidate);
  const signatureValue = input.signature;
  const contentType = input.contentType;
  const secretValue = input.testSecret;
  if (typeof contentType !== 'string' || contentType.toLowerCase().split(';', 1)[0]?.trim() !== 'application/json') {
    fail('webhook media type is invalid');
  }
  const signatureMatch = typeof signatureValue === 'string' ? SIGNATURE.exec(signatureValue) : null;
  if (!signatureMatch) fail('webhook signature is invalid');
  const expected = createHmac('sha256', secret(secretValue)).update(rawBody).digest();
  const supplied = Buffer.from(signatureMatch[1]!, 'hex');
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    fail('webhook signature is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)) as unknown;
  } catch {
    fail('webhook body is not strict UTF-8 JSON');
  }
  const event = normalize(parsed);
  VERIFIED.add(event);
  return event;
}

export function toSocialDmOwnInboxCommand(
  event: VerifiedSocialDmDarkInbound,
  binding: SocialDmOwnInboxBinding,
): RecordTestInboundCommand {
  if (!VERIFIED.has(event)) fail('webhook must be authenticated before inbox mapping');
  const network = socialDmDarkNetwork(binding.network, 'binding.network');
  const workspaceId = socialDmDarkUuid(binding.workspaceId, 'binding.workspaceId');
  const connectionId = socialDmDarkUuid(binding.connectionId, 'binding.connectionId');
  const inboxId = socialDmDarkUuid(binding.inboxId, 'binding.inboxId');
  const contactId = socialDmDarkUuid(binding.contactId, 'binding.contactId');
  const contactPointId = socialDmDarkUuid(binding.contactPointId, 'binding.contactPointId');
  const owned = socialDmDarkTestAddress(binding.ownedTestAddress, network, 'binding.ownedTestAddress');
  const source = socialDmDarkTestAddress(binding.sourceTestAddress, network, 'binding.sourceTestAddress');
  if (event.workspaceId !== workspaceId || event.connectionId !== connectionId
      || event.event.network !== network || event.event.to !== owned || event.event.from !== source) {
    fail('webhook does not match the unified-inbox test binding');
  }
  return Object.freeze({
    commandKey: `social-dm-test-inbound:${event.eventId}`,
    inboxId,
    contactId,
    contactPointId,
    body: event.event.body,
    occurredAt: event.occurredAt,
  });
}
