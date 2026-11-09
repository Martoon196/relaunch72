import { randomUUID } from 'node:crypto';

/**
 * Fixed, low-cardinality service events. Callers cannot attach arbitrary data:
 * emails, provider ids, paths, request bodies and exception messages therefore
 * have no route into the service log record.
 */
export const SAFE_TELEMETRY_EVENTS = Object.freeze([
  'pipeline.accepted',
  'pipeline.start_failed',
  'pipeline.exited',
  'stripe.catalog.provision_failed',
  'stripe.plan_catalog.provision_failed',
  'portal.setup_email.accepted',
  'portal.readiness_failed',
  'portal.mount_failed',
  'portal.inbox.read_failed',
  'portal.provision.accepted',
  'portal.provision.failed',
  'server.shutdown_failed',
  'server.fatal',
] as const);

export type SafeTelemetryEvent = typeof SAFE_TELEMETRY_EVENTS[number];
export type SafeTelemetryLevel = 'info' | 'warn' | 'error';

export interface SafeTelemetryRecord {
  readonly schemaVersion: 1;
  readonly occurredAt: string;
  readonly service: string;
  readonly level: SafeTelemetryLevel;
  readonly event: SafeTelemetryEvent;
  readonly correlationId: string;
  readonly errorClass?: 'AggregateError' | 'RangeError' | 'TypeError' | 'Error';
  /**
   * PostgreSQL SQLSTATE only, and only when it matches the five-character
   * class/subclass shape. A driver error also carries `message`, `detail`,
   * `hint`, `where`, `schema`, `table`, `column` and the failing `query`; none
   * of those may reach a log line, so nothing but the code is ever read.
   */
  readonly databaseCode?: string;
}

export interface SafeTelemetryLogger {
  readonly runtimeCorrelationId: string;
  nextCorrelationId(): string;
  emit(
    level: SafeTelemetryLevel,
    event: SafeTelemetryEvent,
    options?: Readonly<{ correlationId?: string; error?: unknown }>,
  ): void;
}

export interface SafeTelemetryLoggerOptions {
  readonly service: string;
  readonly write?: (line: string) => void;
  readonly now?: () => string;
  readonly nextCorrelationId?: () => string;
}

const SERVICE = /^[a-z][a-z0-9-]{0,63}$/u;
const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EVENTS = new Set<string>(SAFE_TELEMETRY_EVENTS);
const LEVELS = new Set<string>(['info', 'warn', 'error']);

function canonicalCorrelationId(value: string): string {
  const candidate = value.trim().toLowerCase();
  if (!CORRELATION_ID.test(candidate)) {
    throw new Error('Safe telemetry correlation id is invalid');
  }
  return candidate;
}

function canonicalInstant(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error('Safe telemetry instant is invalid');
  }
  return value;
}

/** Reduce an exception to a fixed token; never render its name/message/stack/cause. */
export function safeTelemetryErrorClass(
  error: unknown,
): SafeTelemetryRecord['errorClass'] {
  if (error instanceof AggregateError) return 'AggregateError';
  if (error instanceof RangeError) return 'RangeError';
  if (error instanceof TypeError) return 'TypeError';
  return 'Error';
}

const DATABASE_CODE = /^[0-9A-Z]{5}$/u;

/**
 * Extract a PostgreSQL SQLSTATE and nothing else. `42501` (insufficient
 * privilege) is the whole diagnosis for a boundary regression like the Inbox
 * one, and it carries no customer data. Anything that is not exactly a
 * five-character SQLSTATE is dropped rather than guessed at.
 */
export function safeDatabaseCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = (error as { code?: unknown }).code;
  if (typeof candidate !== 'string') return undefined;
  return DATABASE_CODE.test(candidate) ? candidate : undefined;
}

export function createSafeTelemetryLogger(
  options: SafeTelemetryLoggerOptions,
): SafeTelemetryLogger {
  const service = options.service.trim().toLowerCase();
  if (!SERVICE.test(service)) throw new Error('Safe telemetry service is invalid');
  const write = options.write ?? ((line: string) => { process.stdout.write(line); });
  const now = options.now ?? (() => new Date().toISOString());
  const nextId = options.nextCorrelationId ?? randomUUID;
  const runtimeCorrelationId = canonicalCorrelationId(nextId());

  return Object.freeze({
    runtimeCorrelationId,
    nextCorrelationId: (): string => canonicalCorrelationId(nextId()),
    emit: (
      level: SafeTelemetryLevel,
      event: SafeTelemetryEvent,
      emitOptions: Readonly<{ correlationId?: string; error?: unknown }> = {},
    ): void => {
      if (!LEVELS.has(level)) throw new Error('Safe telemetry level is invalid');
      if (!EVENTS.has(event)) throw new Error('Safe telemetry event is invalid');
      const record: SafeTelemetryRecord = Object.freeze({
        schemaVersion: 1,
        occurredAt: canonicalInstant(now()),
        service,
        level,
        event,
        correlationId: emitOptions.correlationId
          ? canonicalCorrelationId(emitOptions.correlationId)
          : runtimeCorrelationId,
        ...(Object.prototype.hasOwnProperty.call(emitOptions, 'error')
          ? { errorClass: safeTelemetryErrorClass(emitOptions.error) }
          : {}),
        // Derived from the error, never accepted as a caller-supplied string,
        // so there is still no route for arbitrary data into the record.
        ...(Object.prototype.hasOwnProperty.call(emitOptions, 'error')
          && safeDatabaseCode(emitOptions.error) !== undefined
          ? { databaseCode: safeDatabaseCode(emitOptions.error) }
          : {}),
      });
      write(`${JSON.stringify(record)}\n`);
    },
  });
}
