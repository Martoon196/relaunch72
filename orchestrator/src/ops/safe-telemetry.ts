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
      });
      write(`${JSON.stringify(record)}\n`);
    },
  });
}
