/**
 * Isolated Twilio SMS dispatch worker. It deploys dark, proves its exact
 * database boundary at startup without constructing the Twilio adapter or
 * making any provider call, and processes at most one non-overlapping job
 * per cycle through the durable calling fence.
 */

import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import {
  loadTwilioSmsLiveRuntimeConfig,
  runTwilioSmsLiveOnce,
  TWILIO_SMS_PROVIDER_ID,
  TwilioSmsLiveError,
  type TwilioMessagingSmsTransport,
  type TwilioSmsLiveRepository,
  type TwilioSmsLiveRuntimeConfig,
} from '../../sms-live/foundation.js';
import {
  PgTwilioSmsLiveRepository,
} from '../../sms-live-pg/repository.js';
import {
  assertSmsWorkerBoundaryReady,
  SMS_WORKER_DATABASE_ROLE,
} from '../../sms-live-pg/readiness.js';
import { createTwilioMessagingHttpAdapterFromRestrictedKeyEnvironment } from '../../providers/twilio-messaging-http-adapter.js';
import { assertRuntimeSchemaCurrent } from '../../db/runtime-readiness.js';
import { assertExpectedDatabaseInstallation } from '../../db/installation-identity.js';

export const TWILIO_SMS_LIVE_WORKER_SERVICE =
  'property-predator-twilio-sms-live' as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DATABASE_URL_ENV = 'DATABASE_SMS_WORKER_URL';
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const SAFE_ERROR_CLASSES = new Set([
  'Error', 'AggregateError', 'TypeError', 'RangeError', 'DatabaseError',
  'ConnectionError', 'TwilioSmsLiveError',
]);
const APPROVED_SECRET_OR_KEY_NAMES = new Set([
  DATABASE_URL_ENV,
  'DATABASE_SSL_CA',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
  'TWILIO_MESSAGING_SERVICE_SID',
  'TWILIO_KEY_SCOPE',
]);
const SECRET_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|BEARER_?TOKEN|OAUTH_?TOKEN|REFRESH_?TOKEN|CLIENT_?SECRET|APP_?SECRET|SIGNING_?KEY|WEBHOOK_?SECRET|PRIVATE_?KEY|SERVER_?TOKEN|PASSWORD|CREDENTIALS?|SECRET|TOKEN|KEY)(?:_|$)/u;

export interface TwilioSmsLiveWorkerReadiness {
  readonly schemaVersion: 1;
  readonly event: 'ready';
  readonly service: typeof TWILIO_SMS_LIVE_WORKER_SERVICE;
  readonly mode: 'disabled' | 'owned_number_live';
  readonly provider: Readonly<{
    id: typeof TWILIO_SMS_PROVIDER_ID;
    credentialScope: 'restricted-api-key';
    credentialsLoaded: boolean;
    adapterInstantiated: boolean;
    networkCallsMadeAtReadiness: false;
  }>;
  readonly database: Readonly<{
    role: typeof SMS_WORKER_DATABASE_ROLE;
    schemaCurrent: true;
    installationMatched: true;
    functionBoundaryReady: true;
  }>;
  readonly polling: Readonly<{
    intervalMs: number;
    maximumOperationsPerCycle: 1;
    overlappingCycles: false;
  }>;
  readonly receipts: Readonly<{
    /** Local operator attestation only; readiness performs no remote probe. */
    operatorConfirmed: boolean;
    remoteHealthCheckedAtReadiness: false;
  }>;
  readonly safety: Readonly<{
    providerEffectsEnabled: boolean;
    smsDeliveryEnabled: boolean;
    emergencyPaused: boolean;
    dispatchLoopStarted: boolean;
    recipientsPerJob: 1;
    dailySegmentCap: 10;
    monthlySegmentCap: 50;
  }>;
}

interface WorkerConfigBase {
  readonly installationId: string;
  readonly pollIntervalMs: number;
  readonly runtime: TwilioSmsLiveRuntimeConfig;
}

export interface DisabledTwilioSmsWorkerConfig extends WorkerConfigBase {
  readonly mode: 'disabled';
}

export interface ActiveTwilioSmsWorkerConfig extends WorkerConfigBase {
  readonly mode: 'owned_number_live';
  readonly workspaceId: string;
  readonly connectionId: string;
}

export type TwilioSmsWorkerConfig =
  | DisabledTwilioSmsWorkerConfig
  | ActiveTwilioSmsWorkerConfig;

export type TwilioSmsWorkerCycleResult =
  | 'disabled'
  | 'idle'
  | 'settled'
  | 'failed_or_attention';

export interface TwilioSmsWorkerRuntime {
  readonly readiness: TwilioSmsLiveWorkerReadiness;
  readonly stopped: Promise<void>;
  runOnce(): Promise<TwilioSmsWorkerCycleResult>;
  shutdown(): Promise<void>;
}

function assertExactDatabaseEnvironment(env: NodeJS.ProcessEnv): void {
  if (!env[DATABASE_URL_ENV]?.trim()) {
    throw new Error(`${DATABASE_URL_ENV} is required`);
  }
  const databaseUrls = Object.keys(env).filter((name) => {
    const normalized = name.toUpperCase();
    return Boolean(env[name]?.trim())
      && (normalized === 'DATABASE_URL' || normalized === 'TEST_DATABASE_URL'
        || /^DATABASE_[A-Z0-9_]+_URL$/u.test(normalized));
  });
  if (databaseUrls.some((name) => name.toUpperCase() !== DATABASE_URL_ENV)) {
    throw new Error('Twilio SMS worker received another database identity');
  }
}

function assertNoUnrelatedSecrets(env: NodeJS.ProcessEnv): void {
  const unrelated = Object.keys(env).some((name) => {
    const normalized = name.toUpperCase();
    return Boolean(env[name]?.trim())
      && !APPROVED_SECRET_OR_KEY_NAMES.has(normalized)
      && SECRET_NAME.test(normalized);
  });
  if (unrelated) throw new Error('Twilio SMS worker received an unrelated secret');
}

function assertActiveTwilioBinding(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV?.trim().toLowerCase() !== 'production') {
    throw new Error('Twilio SMS live mode requires NODE_ENV=production');
  }
  if (env.TWILIO_KEY_SCOPE?.trim() !== 'restricted-api-key'
      || !/^AC[0-9a-f]{32}$/u.test(env.PROPERTY_PREDATOR_SMS_ACCOUNT_SID?.trim() ?? '')
      || !/^SK[0-9a-f]{32}$/u.test(env.TWILIO_API_KEY_SID?.trim() ?? '')
      || !env.TWILIO_API_KEY_SECRET?.trim()
      || !/^MG[0-9a-f]{32}$/u.test(env.TWILIO_MESSAGING_SERVICE_SID?.trim() ?? '')
      || env.TWILIO_AUTH_TOKEN?.trim()) {
    throw new Error('Twilio SMS worker requires the exact restricted-key boundary');
  }
}

export function loadTwilioSmsWorkerConfig(
  env: NodeJS.ProcessEnv,
): TwilioSmsWorkerConfig {
  assertExactDatabaseEnvironment(env);
  assertNoUnrelatedSecrets(env);
  const installationId = env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID?.trim().toLowerCase() ?? '';
  if (!UUID.test(installationId)) {
    throw new Error('PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID must be a UUID');
  }
  const rawPoll = env.PROPERTY_PREDATOR_SMS_LIVE_POLL_MS?.trim();
  const pollIntervalMs = rawPoll === undefined || rawPoll === ''
    ? DEFAULT_POLL_INTERVAL_MS
    : Number(rawPoll);
  if (!Number.isSafeInteger(pollIntervalMs)
      || pollIntervalMs < 250 || pollIntervalMs > 60_000) {
    throw new Error('PROPERTY_PREDATOR_SMS_LIVE_POLL_MS must be 250-60000');
  }
  if ((env.PROPERTY_PREDATOR_SMS_LIVE_MODE ?? 'disabled') === 'owned_number_live') {
    assertActiveTwilioBinding(env);
  }
  const runtime = loadTwilioSmsLiveRuntimeConfig(env);
  if (runtime.mode === 'disabled') {
    return Object.freeze({ mode: 'disabled', installationId, pollIntervalMs, runtime });
  }
  const workspaceId = env.PROPERTY_PREDATOR_SMS_LIVE_WORKSPACE_ID?.trim().toLowerCase() ?? '';
  const connectionId = env.PROPERTY_PREDATOR_SMS_LIVE_CONNECTION_ID?.trim().toLowerCase() ?? '';
  if (!UUID.test(workspaceId) || !UUID.test(connectionId)) {
    throw new Error('Twilio SMS live mode requires exact workspace and connection bindings');
  }
  return Object.freeze({
    mode: 'owned_number_live',
    installationId,
    pollIntervalMs,
    runtime,
    workspaceId,
    connectionId,
  });
}

export function redactedTwilioSmsWorkerErrorClass(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  return SAFE_ERROR_CLASSES.has(name) ? name : 'Error';
}

function errorLine(
  eventKind: 'startup' | 'background_database' | 'cycle' | 'shutdown',
  count: number,
  errorClass: string,
): string {
  return `${JSON.stringify(Object.freeze({
    schemaVersion: 1,
    event: 'worker_error',
    service: TWILIO_SMS_LIVE_WORKER_SERVICE,
    eventKind,
    count,
    errorClass,
  }))}\n`;
}

export function writeTwilioSmsWorkerFailure(
  eventKind: 'startup' | 'shutdown',
  count: number,
  error: unknown,
): void {
  process.stderr.write(errorLine(eventKind, count, redactedTwilioSmsWorkerErrorClass(error)));
}

type PoolHooks = Readonly<{ onBackgroundError?: (error: Error) => void }>;

export interface TwilioSmsWorkerDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly createPool?: (env: NodeJS.ProcessEnv, hooks: PoolHooks) => Pool;
  readonly assertSchemaCurrent?: (pool: Pool) => Promise<void>;
  readonly assertInstallationReady?: (pool: Pool, installationId: string) => Promise<void>;
  readonly assertBoundaryReady?: (pool: Pool) => Promise<void>;
  readonly createRepository?: (
    pool: Pool,
    binding: Readonly<{ workspaceId: string; connectionId: string }>,
  ) => TwilioSmsLiveRepository;
  readonly createTransport?: (env: NodeJS.ProcessEnv) => TwilioMessagingSmsTransport;
  readonly writeReadiness?: (line: string) => void;
  readonly writeErrorTelemetry?: (line: string) => void;
}

async function centralizedPoolFactory(
  env: NodeJS.ProcessEnv,
  hooks: PoolHooks,
): Promise<Pool> {
  const module = await import('../../db/pool.js') as Record<string, unknown>;
  const factory = module.createSmsWorkerCommandDatabasePool;
  if (typeof factory !== 'function') {
    throw new Error('Twilio SMS worker centralized database factory is unavailable');
  }
  return (factory as (env: NodeJS.ProcessEnv, hooks: PoolHooks) => Pool)(env, hooks);
}

export async function startTwilioSmsLiveWorker(
  dependencies: TwilioSmsWorkerDependencies = {},
): Promise<TwilioSmsWorkerRuntime> {
  const env = dependencies.env ?? process.env;
  const config = loadTwilioSmsWorkerConfig(env);
  const writeErrorTelemetry = dependencies.writeErrorTelemetry
    ?? ((line: string) => process.stderr.write(line));
  let backgroundErrorCount = 0;
  const hooks: PoolHooks = Object.freeze({
    onBackgroundError: (error: Error) => {
      backgroundErrorCount += 1;
      writeErrorTelemetry(errorLine(
        'background_database', backgroundErrorCount, redactedTwilioSmsWorkerErrorClass(error),
      ));
    },
  });
  const pool = dependencies.createPool
    ? dependencies.createPool(env, hooks)
    : await centralizedPoolFactory(env, hooks);
  try {
    await (dependencies.assertSchemaCurrent ?? assertRuntimeSchemaCurrent)(pool);
    await (dependencies.assertInstallationReady ?? assertExpectedDatabaseInstallation)(
      pool, config.installationId,
    );
    await (dependencies.assertBoundaryReady ?? assertSmsWorkerBoundaryReady)(pool);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  let repository: TwilioSmsLiveRepository | null = null;
  let transport: TwilioMessagingSmsTransport | null = null;
  if (config.mode === 'owned_number_live') {
    repository = (dependencies.createRepository
      ?? ((boundPool, binding) => new PgTwilioSmsLiveRepository(boundPool, binding)))(
      pool, { workspaceId: config.workspaceId, connectionId: config.connectionId },
    );
    transport = (dependencies.createTransport
      ?? createTwilioMessagingHttpAdapterFromRestrictedKeyEnvironment)(env);
  }

  const readiness: TwilioSmsLiveWorkerReadiness = Object.freeze({
    schemaVersion: 1,
    event: 'ready',
    service: TWILIO_SMS_LIVE_WORKER_SERVICE,
    mode: config.runtime.mode,
    provider: Object.freeze({
      id: TWILIO_SMS_PROVIDER_ID,
      credentialScope: 'restricted-api-key' as const,
      credentialsLoaded: transport !== null,
      adapterInstantiated: transport !== null,
      networkCallsMadeAtReadiness: false as const,
    }),
    database: Object.freeze({
      role: SMS_WORKER_DATABASE_ROLE,
      schemaCurrent: true as const,
      installationMatched: true as const,
      functionBoundaryReady: true as const,
    }),
    polling: Object.freeze({
      intervalMs: config.pollIntervalMs,
      maximumOperationsPerCycle: 1 as const,
      overlappingCycles: false as const,
    }),
    receipts: Object.freeze({
      operatorConfirmed: config.runtime.receiptsConfirmed,
      remoteHealthCheckedAtReadiness: false as const,
    }),
    safety: Object.freeze({
      providerEffectsEnabled: config.runtime.providerEffectsEnabled,
      smsDeliveryEnabled: config.runtime.smsDeliveryEnabled,
      emergencyPaused: config.runtime.emergencyPaused,
      dispatchLoopStarted: config.mode === 'owned_number_live',
      recipientsPerJob: 1 as const,
      dailySegmentCap: 10 as const,
      monthlySegmentCap: 50 as const,
    }),
  });
  (dependencies.writeReadiness ?? ((line: string) => process.stdout.write(line)))(
    `${JSON.stringify(readiness)}\n`,
  );

  let stopping = false;
  let inFlight: Promise<TwilioSmsWorkerCycleResult> | null = null;
  let cycleErrorCount = 0;
  let timer: NodeJS.Timeout | null = null;
  let resolveStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });

  const executeCycle = (): Promise<TwilioSmsWorkerCycleResult> => {
    if (stopping) return Promise.reject(new Error('Twilio SMS worker is stopping'));
    if (inFlight) return inFlight;
    if (config.mode !== 'owned_number_live' || !repository || !transport) {
      return Promise.resolve('disabled');
    }
    const boundRepository = repository;
    const boundTransport = transport;
    inFlight = (async () => runTwilioSmsLiveOnce({
      config: config.runtime,
      repository: boundRepository,
      transport: boundTransport,
      leaseToken: randomBytes(32),
    }))().finally(() => { inFlight = null; });
    return inFlight;
  };

  const schedule = (): void => {
    if (stopping) return;
    timer = setTimeout(() => {
      void executeCycle().catch((error: unknown) => {
        cycleErrorCount += 1;
        writeErrorTelemetry(errorLine(
          'cycle', cycleErrorCount, redactedTwilioSmsWorkerErrorClass(error),
        ));
      }).finally(schedule);
    }, config.pollIntervalMs);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  };
  if (config.mode === 'owned_number_live') schedule();

  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    let cycleError: unknown = null;
    if (inFlight) {
      try { await inFlight; } catch (error) { cycleError = error; }
    }
    try {
      await pool.end();
    } catch (poolError) {
      resolveStopped();
      if (cycleError) {
        throw new AggregateError(
          [cycleError, poolError],
          'Twilio SMS cycle and pool shutdown both failed',
        );
      }
      throw poolError;
    }
    resolveStopped();
    if (cycleError) throw cycleError;
  };

  return Object.freeze({ readiness, stopped, runOnce: executeCycle, shutdown });
}
