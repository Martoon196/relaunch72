import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';

export const WHEREBY_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
export const WHEREBY_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
export const WHEREBY_WEBHOOK_API_VERSION = '1.0' as const;

export const WHEREBY_ROOM_EVENT_TYPES = [
  'room.client.joined',
  'room.client.left',
  'room.session.started',
  'room.session.ended',
] as const;

export type WherebyRoomEventType = (typeof WHEREBY_ROOM_EVENT_TYPES)[number];

export type WherebyParticipantRole =
  | 'owner'
  | 'member'
  | 'host'
  | 'visitor'
  | 'granted_visitor'
  | 'viewer'
  | 'granted_viewer'
  | 'recorder'
  | 'streamer'
  | 'captioner'
  | 'assistant';

export interface WherebyRoomEventData {
  readonly meetingId: string;
  readonly roomName: string;
  readonly roomSessionId: string | null;
  readonly subdomain: string;
  readonly displayName?: string;
  readonly participantId?: string;
  readonly metadata?: string | null;
  readonly externalId?: string | null;
  readonly roleName?: WherebyParticipantRole;
  readonly numClients?: number;
  readonly numClientsByRoleName?: Readonly<Partial<Record<WherebyParticipantRole, number>>>;
  readonly isDialIn?: boolean;
}

export interface VerifiedWherebyRoomEvent {
  readonly id: string;
  readonly apiVersion: typeof WHEREBY_WEBHOOK_API_VERSION;
  readonly createdAt: string;
  readonly type: WherebyRoomEventType;
  readonly data: Readonly<WherebyRoomEventData>;
  readonly rawBodySha256: string;
  readonly signatureTimestampSeconds: number;
}

export interface VerifyWherebyWebhookInput {
  /** Exact request bytes before JSON parsing or re-encoding. */
  readonly rawBody: Uint8Array;
  /** Exact `Whereby-Signature` header (`t=...,v1=...`). */
  readonly signatureHeader: string;
  /** Dedicated webhook secret copied from Whereby; never an API bearer key. */
  readonly webhookSecret: Uint8Array;
  /** Trusted organization subdomain configured server-side. */
  readonly expectedSubdomain: string;
  readonly nowSeconds?: number;
}

export class WherebyWebhookContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WherebyWebhookContractError';
  }
}

export class WherebyWebhookAuthenticationError extends Error {
  constructor() {
    super('Whereby webhook authentication failed');
    this.name = 'WherebyWebhookAuthenticationError';
  }
}

type DataRecord = Record<string, unknown>;

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const VERIFIED_EVENTS = new WeakSet<object>();
const SIGNATURE_HEADER = /^t=(0|[1-9][0-9]{0,15}),v1=([a-f0-9]{64})$/u;
const SAFE_PROVIDER_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const SAFE_SUBDOMAIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/u;
const SAFE_ROOM_NAME = /^\/?[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
const SAFE_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SAFE_DISPLAY_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const PARTICIPANT_ROLES = new Set<WherebyParticipantRole>([
  'owner', 'member', 'host', 'visitor', 'granted_visitor', 'viewer',
  'granted_viewer', 'recorder', 'streamer', 'captioner', 'assistant',
]);
const ROOM_EVENT_TYPES = new Set<WherebyRoomEventType>(WHEREBY_ROOM_EVENT_TYPES);

function contractFailure(message: string): never {
  throw new WherebyWebhookContractError(message);
}

function authenticationFailure(): never {
  throw new WherebyWebhookAuthenticationError();
}

function dataRecord(value: unknown, path: string): DataRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return contractFailure(`${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return contractFailure(`${path} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') contractFailure(`${path} must not contain symbol keys`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      contractFailure(`${path}.${key} must be an enumerable data property`);
    }
  }
  return value as DataRecord;
}

function exactKeys(
  record: DataRecord,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) contractFailure(`${path} contains unsupported field: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) contractFailure(`${path}.${key} is required`);
  }
}

function boundedString(value: unknown, path: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
      || value.trim() !== value || !SAFE_DISPLAY_TEXT.test(value)
      || Buffer.byteLength(value, 'utf8') > maximum * 4) {
    return contractFailure(`${path} is invalid`);
  }
  return value;
}

function optionalStringOrNull(value: unknown, path: string, maximum: number): string | null {
  if (value === null) return null;
  return boundedString(value, path, maximum);
}

function safeProviderReference(value: unknown, path: string): string {
  const candidate = boundedString(value, path, 256);
  if (!SAFE_PROVIDER_REFERENCE.test(candidate)) contractFailure(`${path} is invalid`);
  return candidate;
}

function canonicalTimestamp(value: unknown, path: string): string {
  const candidate = boundedString(value, path, 30);
  if (!CANONICAL_TIMESTAMP.test(candidate)) contractFailure(`${path} is invalid`);
  const parsed = new Date(candidate);
  if (!Number.isFinite(parsed.getTime())) contractFailure(`${path} is invalid`);
  return parsed.toISOString();
}

function boundedCount(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10_000) {
    return contractFailure(`${path} is invalid`);
  }
  return value as number;
}

function parseRoleCounts(value: unknown): Readonly<Partial<Record<WherebyParticipantRole, number>>> {
  const counts = dataRecord(value, 'data.numClientsByRoleName');
  const output: Partial<Record<WherebyParticipantRole, number>> = {};
  for (const [key, rawCount] of Object.entries(counts)) {
    if (!PARTICIPANT_ROLES.has(key as WherebyParticipantRole)) {
      contractFailure('data.numClientsByRoleName contains an unsupported role');
    }
    output[key as WherebyParticipantRole] = boundedCount(
      rawCount,
      `data.numClientsByRoleName.${key}`,
    );
  }
  return Object.freeze(output);
}

function parseEvent(rawBody: Uint8Array, signatureTimestampSeconds: number): VerifiedWherebyRoomEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8_DECODER.decode(rawBody));
  } catch {
    return contractFailure('Whereby webhook body must be valid UTF-8 JSON');
  }
  const root = dataRecord(parsed, 'event');
  exactKeys(root, 'event', ['id', 'apiVersion', 'createdAt', 'type', 'data']);
  const id = boundedString(root.id, 'event.id', 256);
  if (!SAFE_EVENT_ID.test(id)) contractFailure('event.id is invalid');
  if (root.apiVersion !== WHEREBY_WEBHOOK_API_VERSION) {
    contractFailure('event.apiVersion is unsupported');
  }
  if (typeof root.type !== 'string' || !ROOM_EVENT_TYPES.has(root.type as WherebyRoomEventType)) {
    contractFailure('event.type is unsupported');
  }
  const type = root.type as WherebyRoomEventType;
  const data = dataRecord(root.data, 'data');
  const commonRequired = ['meetingId', 'roomName', 'subdomain'] as const;
  const commonOptional = ['roomSessionId'] as const;
  const clientFields = [
    'displayName', 'participantId', 'metadata', 'externalId', 'roleName',
    'numClients', 'numClientsByRoleName', 'isDialIn',
  ] as const;
  const clientEvent = type === 'room.client.joined' || type === 'room.client.left';
  exactKeys(
    data,
    'data',
    clientEvent
      ? [...commonRequired, 'displayName', 'participantId', 'roleName', 'numClients', 'numClientsByRoleName']
      : commonRequired,
    clientEvent ? [...commonOptional, 'metadata', 'externalId', 'isDialIn'] : commonOptional,
  );
  const roomName = boundedString(data.roomName, 'data.roomName', 255);
  if (!SAFE_ROOM_NAME.test(roomName)) contractFailure('data.roomName is invalid');
  const subdomain = boundedString(data.subdomain, 'data.subdomain', 63);
  if (!SAFE_SUBDOMAIN.test(subdomain)) contractFailure('data.subdomain is invalid');
  const roomSessionId = Object.hasOwn(data, 'roomSessionId')
    ? optionalStringOrNull(data.roomSessionId, 'data.roomSessionId', 256)
    : null;
  const output: WherebyRoomEventData = {
    meetingId: safeProviderReference(data.meetingId, 'data.meetingId'),
    roomName,
    roomSessionId,
    subdomain,
  };
  if (clientEvent) {
    const roleName = data.roleName;
    if (typeof roleName !== 'string' || !PARTICIPANT_ROLES.has(roleName as WherebyParticipantRole)) {
      contractFailure('data.roleName is invalid');
    }
    Object.assign(output, {
      displayName: boundedString(data.displayName, 'data.displayName', 200),
      participantId: safeProviderReference(data.participantId, 'data.participantId'),
      metadata: Object.hasOwn(data, 'metadata')
        ? optionalStringOrNull(data.metadata, 'data.metadata', 1_024)
        : null,
      externalId: Object.hasOwn(data, 'externalId')
        ? optionalStringOrNull(data.externalId, 'data.externalId', 256)
        : null,
      roleName: roleName as WherebyParticipantRole,
      numClients: boundedCount(data.numClients, 'data.numClients'),
      numClientsByRoleName: parseRoleCounts(data.numClientsByRoleName),
      ...(Object.hasOwn(data, 'isDialIn')
        ? (typeof data.isDialIn === 'boolean'
          ? { isDialIn: data.isDialIn }
          : contractFailure('data.isDialIn is invalid'))
        : {}),
    });
  }
  return Object.freeze({
    id,
    apiVersion: WHEREBY_WEBHOOK_API_VERSION,
    createdAt: canonicalTimestamp(root.createdAt, 'event.createdAt'),
    type,
    data: Object.freeze(output),
    rawBodySha256: createHash('sha256').update(rawBody).digest('hex'),
    signatureTimestampSeconds,
  });
}

/** Verify Whereby's documented HMAC over `timestamp + "." + exactRawBody`. */
export function verifyWherebyWebhook(input: VerifyWherebyWebhookInput): VerifiedWherebyRoomEvent {
  const suppliedBody = input.rawBody;
  if (!(suppliedBody instanceof Uint8Array)) {
    throw new WherebyWebhookContractError('Whereby webhook body size is invalid');
  }
  const rawBody = Uint8Array.from(suppliedBody);
  if (rawBody.byteLength < 2
      || rawBody.byteLength > WHEREBY_WEBHOOK_MAX_BODY_BYTES) {
    throw new WherebyWebhookContractError('Whereby webhook body size is invalid');
  }
  const suppliedSecret = input.webhookSecret;
  if (!(suppliedSecret instanceof Uint8Array)) {
    throw new WherebyWebhookContractError('Whereby webhook secret configuration is invalid');
  }
  const webhookSecret = Uint8Array.from(suppliedSecret);
  if (webhookSecret.byteLength < 32 || webhookSecret.byteLength > 1_024) {
    throw new WherebyWebhookContractError('Whereby webhook secret configuration is invalid');
  }
  const expectedSubdomain = input.expectedSubdomain;
  if (typeof expectedSubdomain !== 'string'
      || !SAFE_SUBDOMAIN.test(expectedSubdomain)) {
    throw new WherebyWebhookContractError('Whereby subdomain configuration is invalid');
  }
  const signatureHeader = input.signatureHeader;
  const match = typeof signatureHeader === 'string'
    ? SIGNATURE_HEADER.exec(signatureHeader)
    : null;
  if (!match) authenticationFailure();
  const timestamp = match[1]!;
  const signature = match[2]!;
  const timestampSeconds = Number(timestamp);
  const suppliedNowSeconds = input.nowSeconds;
  const nowSeconds = suppliedNowSeconds ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(timestampSeconds)
      || !Number.isSafeInteger(nowSeconds)
      || nowSeconds < 0
      || Math.abs(nowSeconds - timestampSeconds) > WHEREBY_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS) {
    authenticationFailure();
  }
  const expected = createHmac('sha256', Buffer.from(webhookSecret))
    .update(timestamp, 'ascii')
    .update('.', 'ascii')
    .update(rawBody)
    .digest();
  const presented = Buffer.from(signature, 'hex');
  if (presented.byteLength !== expected.byteLength || !timingSafeEqual(presented, expected)) {
    authenticationFailure();
  }
  const event = parseEvent(rawBody, timestampSeconds);
  if (event.data.subdomain !== expectedSubdomain) authenticationFailure();
  VERIFIED_EVENTS.add(event);
  return event;
}

/** Runtime provenance check; TypeScript's structural type alone is not authentication. */
export function isVerifiedWherebyRoomEvent(value: unknown): value is VerifiedWherebyRoomEvent {
  return value !== null && typeof value === 'object' && VERIFIED_EVENTS.has(value);
}
