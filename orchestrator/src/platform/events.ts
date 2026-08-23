export const PLATFORM_EVENT_TYPES = [
  'crm.contact.created',
  'crm.lead.created',
  'crm.opportunity.stage_changed',
  'crm.task.completed',
  'content.draft.created',
  'content.approval.requested',
  'social.publish.requested',
  'social.mention.received',
  'conversation.message.received',
  'conversation.message.sent',
  'webinar.registration.created',
  'webinar.attendance.recorded',
  'automation.execution.requested',
] as const;

export type PlatformEventType = (typeof PLATFORM_EVENT_TYPES)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type DeepReadonlyJson<T> =
  T extends JsonPrimitive ? T
    : T extends readonly (infer TItem)[] ? readonly DeepReadonlyJson<TItem>[]
      : T extends JsonObject ? { readonly [TKey in keyof T]: DeepReadonlyJson<T[TKey]> }
        : never;

export function isPlatformEventType(value: string): value is PlatformEventType {
  return (PLATFORM_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Durable wire contract: identity fields are canonical lowercase UUIDs and
 * occurredAt is UTC RFC3339 with millisecond precision (Date#toISOString()).
 */
export interface PlatformEvent<TPayload extends JsonObject = JsonObject> {
  readonly id: string;
  readonly type: PlatformEventType;
  readonly version: 1;
  readonly workspaceId: string;
  readonly occurredAt: string;
  readonly actorId: string | null;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly payload: DeepReadonlyJson<TPayload>;
}

export interface NewPlatformEvent<TPayload extends JsonObject> {
  id: string;
  type: PlatformEventType;
  workspaceId: string;
  occurredAt: string;
  actorId?: string | null;
  correlationId: string;
  causationId?: string | null;
  payload: TPayload;
}

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function uuid(value: string, label: string): string {
  const normalized = required(value, label).toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new Error(`${label} must be a UUID`);
  return normalized;
}

function nullableUuid(value: string | null | undefined, label: string): string | null {
  return value == null ? null : uuid(value, label);
}

function canonicalTimestamp(value: string): string {
  const occurredAt = required(value, 'occurredAt');
  if (!CANONICAL_TIMESTAMP_PATTERN.test(occurredAt)) {
    throw new Error('occurredAt must be a canonical RFC3339 UTC timestamp');
  }
  const parsed = new Date(occurredAt);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== occurredAt) {
    throw new Error('occurredAt must be a valid canonical RFC3339 UTC timestamp');
  }
  return occurredAt;
}

function detachedJson(value: JsonValue, path: string, ancestors: WeakSet<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite JSON numbers`);
    return value;
  }
  if (typeof value !== 'object') throw new Error(`${path} must contain only JSON-compatible values`);
  if (ancestors.has(value)) throw new Error(`${path} must not contain circular references`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const clone = value.map((item, index) => detachedJson(item, `${path}[${index}]`, ancestors));
      return Object.freeze(clone);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must contain only plain JSON objects`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(`${path} must not contain symbol properties`);
    }

    const clone: Record<string, JsonValue> = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !('value' in descriptor)) {
        throw new Error(`${path}.${key} must be an enumerable JSON data property`);
      }
      Object.defineProperty(clone, key, {
        value: detachedJson(descriptor.value as JsonValue, `${path}.${key}`, ancestors),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(clone);
  } finally {
    ancestors.delete(value);
  }
}

export function createPlatformEvent<TPayload extends JsonObject>(input: NewPlatformEvent<TPayload>): PlatformEvent<TPayload> {
  const occurredAt = canonicalTimestamp(input.occurredAt);
  if (!isPlatformEventType(input.type)) throw new Error(`unknown platform event type: ${String(input.type)}`);
  return Object.freeze({
    id: uuid(input.id, 'event id'),
    type: input.type,
    version: 1,
    workspaceId: uuid(input.workspaceId, 'workspaceId'),
    occurredAt,
    actorId: nullableUuid(input.actorId, 'actorId'),
    correlationId: uuid(input.correlationId, 'correlationId'),
    causationId: nullableUuid(input.causationId, 'causationId'),
    payload: detachedJson(input.payload, 'payload', new WeakSet()) as DeepReadonlyJson<TPayload>,
  });
}
