import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import * as databasePools from '../../db/pool.js';
import { assertExpectedDatabaseInstallation } from '../../db/installation-identity.js';
import { assertRuntimeSchemaCurrent } from '../../db/runtime-readiness.js';
import {
  assertCustomerEmailWorkerBoundaryReady,
  CUSTOMER_EMAIL_WORKER_DATABASE_ROLE,
  PgCustomerEmailLiveRepository,
} from '../../customer-email-live-pg/index.js';
import {
  loadCustomerEmailLiveRuntimeConfig,
  runCustomerEmailLiveOnce,
  type CustomerEmailLiveRepository,
  type CustomerEmailLiveRuntimeConfig,
} from '../../customer-email-live/foundation.js';
import {
  createMailgunEuHttpAdapterFromDomainSendingKeyEnvironment,
  type MailgunEuEmailTransport,
} from '../../providers/mailgun-eu-http-adapter.js';
import { normalizeOwnedInternalSeedEmail } from '../../providers/property-predator-email-pilot-config.js';

export const CUSTOMER_EMAIL_LIVE_WORKER_SERVICE =
  'property-predator-customer-email-live' as const;
export const CUSTOMER_EMAIL_LIVE_SENDING_DOMAIN =
  'mg.propertypredator.com' as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DATABASE_URL_ENV = 'DATABASE_CUSTOMER_EMAIL_WORKER_URL';
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const SAFE_ERROR_CLASSES = new Set([
  'Error', 'AggregateError', 'TypeError', 'RangeError', 'DatabaseError',
  'ConnectionError', 'CustomerEmailLiveError',
]);
const APPROVED_SECRET_OR_KEY_NAMES = new Set([
  DATABASE_URL_ENV,
  'DATABASE_SSL_CA',
  'MAILGUN_DOMAIN_SENDING_KEY',
  'MAILGUN_KEY_SCOPE',
]);
const SECRET_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|BEARER_?TOKEN|OAUTH_?TOKEN|REFRESH_?TOKEN|CLIENT_?SECRET|APP_?SECRET|SIGNING_?KEY|WEBHOOK_?SECRET|PRIVATE_?KEY|SERVER_?TOKEN|PASSWORD|CREDENTIALS?|SECRET|TOKEN|KEY)(?:_|$)/u;

type RuntimePool = Pick<Pool, 'query' | 'connect' | 'end'>;
type CycleResult = 'idle' | 'settled' | 'failed_or_attention';
type PoolFactory = (
  env: NodeJS.ProcessEnv,
  hooks: Readonly<{ onBackgroundError: (error: Error) => void }>,
) => RuntimePool;

interface WorkerConfigBase {
  readonly installationId: string;
  readonly pollIntervalMs: number;
  readonly runtime: CustomerEmailLiveRuntimeConfig;
}

export interface DisabledCustomerEmailLiveWorkerConfig extends WorkerConfigBase {
  readonly mode: 'disabled';
}

export interface ActiveCustomerEmailLiveWorkerConfig extends WorkerConfigBase {
  readonly mode: 'customer_live';
  readonly workspaceId: string;
  readonly connectionId: string;
}

export type CustomerEmailLiveWorkerConfig =
  | DisabledCustomerEmailLiveWorkerConfig
  | ActiveCustomerEmailLiveWorkerConfig;

export type CustomerEmailLiveWorkerCycleResult = 'disabled' | CycleResult;

export interface CustomerEmailLiveWorkerReadiness {
  readonly schemaVersion: 1;
  readonly event: 'ready';
  readonly service: typeof CUSTOMER_EMAIL_LIVE_WORKER_SERVICE;
  readonly mode: 'disabled' | 'customer_live';
  readonly provider: Readonly<{
    id: 'mailgun_eu';
    region: 'eu';
    sendingDomain: typeof CUSTOMER_EMAIL_LIVE_SENDING_DOMAIN;
    credentialScope: 'domain-sending';
    credentialsLoaded: boolean;
    adapterInstantiated: boolean;
    networkCallsMadeAtReadiness: false;
  }>;
  readonly database: Readonly<{
    role: typeof CUSTOMER_EMAIL_WORKER_DATABASE_ROLE;
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
    emailDeliveryEnabled: boolean;
    emergencyPaused: boolean;
    dispatchLoopStarted: boolean;
    recipientsPerJob: 1;
    dailySendCap: 10;
    monthlySendCap: 50;
  }>;
}

export interface CustomerEmailLiveWorkerRuntime {
  readonly readiness: CustomerEmailLiveWorkerReadiness;
  readonly stopped: Promise<void>;
  runOnce(): Promise<CustomerEmailLiveWorkerCycleResult>;
  shutdown(): Promise<void>;
}

export interface CustomerEmailLiveWorkerDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly autoStart?: boolean;
  readonly createPool?: PoolFactory;
  readonly assertSchemaCurrent?: (pool: Pick<Pool, 'query'>) => Promise<void>;
  readonly assertInstallationReady?: (
    pool: Pick<Pool, 'query'>,
    expectedInstallationId: string | undefined,
  ) => Promise<void>;
  readonly assertBoundaryReady?: (pool: Pick<Pool, 'query'>) => Promise<void>;
  readonly createRepository?: (
    pool: Pick<Pool, 'connect'>,
    binding: Readonly<{ workspaceId: string; connectionId: string }>,
  ) => CustomerEmailLiveRepository;
  readonly createTransport?: (env: NodeJS.ProcessEnv) => MailgunEuEmailTransport;
  readonly runCycle?: typeof runCustomerEmailLiveOnce;
  readonly randomToken?: () => Uint8Array;
  readonly writeReadiness?: (line: string) => void;
  readonly writeErrorTelemetry?: (line: string) => void;
  readonly onCycle?: (result: CustomerEmailLiveWorkerCycleResult) => void;
}

function uuid(raw: string | undefined, label: string): string {
  const value = raw?.trim().toLowerCase() ?? '';
  if (!UUID.test(value)) throw new Error(`${label} must be a UUID`);
  return value;
}

function pollInterval(raw: string | undefined): number {
  if (!raw?.trim()) return DEFAULT_POLL_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 250 || value > 60_000) {
    throw new Error('Customer email worker poll interval is invalid');
  }
  return value;
}

function assertExactDatabaseEnvironment(env: NodeJS.ProcessEnv): void {
  if (!env[DATABASE_URL_ENV]?.trim()) throw new Error(`${DATABASE_URL_ENV} is required`);
  const configured = Object.keys(env).filter((name) => Boolean(env[name]?.trim())
    && (name.toUpperCase() === 'DATABASE_URL'
      || name.toUpperCase() === 'TEST_DATABASE_URL'
      || /^DATABASE_[A-Z0-9_]+_URL$/u.test(name.toUpperCase())));
  if (configured.some((name) => name.toUpperCase() !== DATABASE_URL_ENV)) {
    throw new Error('Customer email worker received another database identity');
  }
}

function assertNoUnrelatedSecrets(env: NodeJS.ProcessEnv): void {
  if (Object.keys(env).some((name) => {
    const normalized = name.toUpperCase();
    return Boolean(env[name]?.trim())
      && !APPROVED_SECRET_OR_KEY_NAMES.has(normalized)
      && SECRET_NAME.test(normalized);
  })) throw new Error('Customer email worker received an unrelated secret');
}

function assertActiveMailgunBinding(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV?.trim().toLowerCase() !== 'production') {
    throw new Error('Customer email live mode requires NODE_ENV=production');
  }
  if (env.MAILGUN_REGION?.trim() !== 'eu'
      || env.MAILGUN_SENDING_DOMAIN?.trim().toLowerCase()
        !== CUSTOMER_EMAIL_LIVE_SENDING_DOMAIN
      || env.MAILGUN_KEY_SCOPE?.trim() !== 'domain-sending'
      || !env.MAILGUN_DOMAIN_SENDING_KEY?.trim()
      || env.MAILGUN_API_KEY?.trim()
      || env.MAILGUN_SIGNING_KEY?.trim()) {
    throw new Error('Customer email worker requires the exact Mailgun EU domain-sending boundary');
  }
  const from = normalizeOwnedInternalSeedEmail(env.MAILGUN_FROM_EMAIL ?? '');
  if (from.split('@')[1] !== CUSTOMER_EMAIL_LIVE_SENDING_DOMAIN) {
    throw new Error('Customer email From identity must use mg.propertypredator.com');
  }
}

export function loadCustomerEmailLiveWorkerConfig(
  env: NodeJS.ProcessEnv,
): CustomerEmailLiveWorkerConfig {
  assertExactDatabaseEnvironment(env);
  assertNoUnrelatedSecrets(env);
  const installationId = uuid(
    env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID,
    'PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID',
  );
  const configuredPollInterval = pollInterval(
    env.PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_POLL_MS,
  );
  if (env.PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_MODE === 'customer_live') {
    assertActiveMailgunBinding(env);
  }
  const runtime = loadCustomerEmailLiveRuntimeConfig(env);
  if (runtime.mode === 'disabled') {
    return Object.freeze({
      mode: 'disabled', installationId, pollIntervalMs: configuredPollInterval, runtime,
    });
  }
  return Object.freeze({
    mode: 'customer_live',
    installationId,
    pollIntervalMs: configuredPollInterval,
    runtime,
    workspaceId: uuid(
      env.PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_WORKSPACE_ID,
      'PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_WORKSPACE_ID',
    ),
    connectionId: uuid(
      env.PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_CONNECTION_ID,
      'PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_CONNECTION_ID',
    ),
  });
}

export function redactedCustomerEmailLiveWorkerErrorClass(error: unknown): string {
  return error instanceof Error && SAFE_ERROR_CLASSES.has(error.name)
    ? error.name : 'Error';
}

function errorLine(
  eventKind: 'startup' | 'background_database' | 'cycle' | 'shutdown',
  count: number,
  errorClass: string,
): string {
  return `${JSON.stringify(Object.freeze({
    schemaVersion: 1,
    event: 'worker_error',
    service: CUSTOMER_EMAIL_LIVE_WORKER_SERVICE,
    eventKind,
    count,
    errorClass,
  }))}\n`;
}

function readinessFor(config: CustomerEmailLiveWorkerConfig): CustomerEmailLiveWorkerReadiness {
  const active = config.mode === 'customer_live';
  return Object.freeze({
    schemaVersion: 1,
    event: 'ready',
    service: CUSTOMER_EMAIL_LIVE_WORKER_SERVICE,
    mode: config.mode,
    provider: Object.freeze({
      id: 'mailgun_eu', region: 'eu',
      sendingDomain: CUSTOMER_EMAIL_LIVE_SENDING_DOMAIN,
      credentialScope: 'domain-sending',
      credentialsLoaded: active,
      adapterInstantiated: active,
      networkCallsMadeAtReadiness: false,
    }),
    database: Object.freeze({
      role: CUSTOMER_EMAIL_WORKER_DATABASE_ROLE,
      schemaCurrent: true,
      installationMatched: true,
      functionBoundaryReady: true,
    }),
    polling: Object.freeze({
      intervalMs: config.pollIntervalMs,
      maximumOperationsPerCycle: 1,
      overlappingCycles: false,
    }),
    receipts: Object.freeze({
      operatorConfirmed: config.runtime.receiptsConfirmed,
      remoteHealthCheckedAtReadiness: false,
    }),
    safety: Object.freeze({
      providerEffectsEnabled: config.runtime.providerEffectsEnabled,
      emailDeliveryEnabled: config.runtime.emailDeliveryEnabled,
      emergencyPaused: config.runtime.emergencyPaused,
      dispatchLoopStarted: active,
      recipientsPerJob: 1,
      dailySendCap: 10,
      monthlySendCap: 50,
    }),
  });
}

function centralizedPoolFactory(env: NodeJS.ProcessEnv,
  hooks: Readonly<{ onBackgroundError: (error: Error) => void }>): RuntimePool {
  const candidate = (databasePools as unknown as Record<string, unknown>)
    .createCustomerEmailWorkerCommandDatabasePool;
  if (typeof candidate !== 'function') {
    throw new Error('Customer email worker centralized database factory is unavailable');
  }
  return (candidate as PoolFactory)(env, hooks);
}

export async function startCustomerEmailLiveWorker(
  dependencies: CustomerEmailLiveWorkerDependencies = {},
): Promise<CustomerEmailLiveWorkerRuntime> {
  const env = dependencies.env ?? process.env;
  const config = loadCustomerEmailLiveWorkerConfig(env);
  const writeErrorTelemetry = dependencies.writeErrorTelemetry
    ?? ((line: string) => { process.stderr.write(line); });
  let backgroundErrorCount = 0;
  let cycleErrorCount = 0;
  const pool = (dependencies.createPool ?? centralizedPoolFactory)(env, {
    onBackgroundError: (error) => {
      backgroundErrorCount += 1;
      writeErrorTelemetry(errorLine(
        'background_database', backgroundErrorCount,
        redactedCustomerEmailLiveWorkerErrorClass(error),
      ));
    },
  });
  try {
    await (dependencies.assertSchemaCurrent ?? assertRuntimeSchemaCurrent)(pool);
    await (dependencies.assertInstallationReady ?? assertExpectedDatabaseInstallation)(
      pool,
      config.installationId,
    );
    await (dependencies.assertBoundaryReady ?? assertCustomerEmailWorkerBoundaryReady)(pool);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  let repository: CustomerEmailLiveRepository | null = null;
  let transport: MailgunEuEmailTransport | null = null;
  if (config.mode === 'customer_live') {
    try {
      repository = (dependencies.createRepository
        ?? ((commandPool, binding) => new PgCustomerEmailLiveRepository(
          commandPool,
          binding,
        )))(pool, { workspaceId: config.workspaceId, connectionId: config.connectionId });
      transport = (dependencies.createTransport
        ?? createMailgunEuHttpAdapterFromDomainSendingKeyEnvironment)(env);
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  const readiness = readinessFor(config);
  try {
    (dependencies.writeReadiness ?? ((line: string) => { process.stdout.write(line); }))(
      `${JSON.stringify(readiness)}\n`,
    );
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<CustomerEmailLiveWorkerCycleResult> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const runCycle = dependencies.runCycle ?? runCustomerEmailLiveOnce;

  const executeCycle = (): Promise<CustomerEmailLiveWorkerCycleResult> => {
    if (stopping) return Promise.reject(new Error('Customer email worker is stopping'));
    if (inFlight) return inFlight;
    if (config.mode === 'disabled') return Promise.resolve('disabled');
    if (!repository || !transport) {
      return Promise.reject(new Error('Customer email live composition is incomplete'));
    }
    const token = (dependencies.randomToken ?? (() => randomBytes(32)))();
    if (!(token instanceof Uint8Array) || token.byteLength !== 32) {
      return Promise.reject(new Error('Customer email worker lease entropy is invalid'));
    }
    inFlight = runCycle({
      config: config.runtime,
      repository,
      transport,
      leaseToken: Buffer.from(token),
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  };

  const onCycle = dependencies.onCycle ?? (() => undefined);
  const schedule = (): void => {
    if (stopping || config.mode === 'disabled') return;
    timer = setTimeout(() => {
      timer = undefined;
      void executeCycle().then(onCycle).catch((error: unknown) => {
        cycleErrorCount += 1;
        writeErrorTelemetry(errorLine(
          'cycle', cycleErrorCount, redactedCustomerEmailLiveWorkerErrorClass(error),
        ));
      }).finally(schedule);
    }, config.pollIntervalMs);
  };
  if (dependencies.autoStart !== false) schedule();

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    if (timer) clearTimeout(timer);
    shutdownPromise = (async () => {
      let cycleError: unknown;
      try { await inFlight; } catch (error) { cycleError = error; }
      try { await pool.end(); }
      catch (closeError) {
        if (cycleError !== undefined) {
          throw new AggregateError(
            [cycleError, closeError],
            'Customer email cycle and pool shutdown both failed',
          );
        }
        throw closeError;
      }
      if (cycleError !== undefined) throw cycleError;
    })().finally(() => { resolveStopped?.(); });
    return shutdownPromise;
  };

  return Object.freeze({ readiness, stopped, runOnce: executeCycle, shutdown });
}

export function writeCustomerEmailLiveWorkerFailure(
  eventKind: 'startup' | 'shutdown',
  count: number,
  error: unknown,
): void {
  process.stderr.write(errorLine(
    eventKind,
    count,
    redactedCustomerEmailLiveWorkerErrorClass(error),
  ));
}
