import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { assertExpectedDatabaseInstallation } from '../../db/installation-identity.js';
import { createOwnedSocialWorkerCommandDatabasePool } from '../../db/pool.js';
import { assertRuntimeSchemaCurrent } from '../../db/runtime-readiness.js';
import {
  assertOwnedPublicSocialWorkerBoundaryReady,
  OWNED_PUBLIC_SOCIAL_WORKER_DATABASE_ROLE,
  PgOwnedPublicSocialLiveRepository,
} from '../../owned-public-social-pg/index.js';
import {
  createAyrshareOwnedLiveTransport,
  loadOwnedPublicSocialLiveRuntimeConfig,
  runOwnedPublicSocialLiveOnce,
  type AyrshareOwnedLiveSecrets,
  type AyrshareOwnedLiveTransport,
  type OwnedPublicSocialLiveRepository,
  type OwnedPublicSocialLiveRuntimeConfig,
} from '../../public-social-outbound/owned-live-foundation.js';

export const OWNED_PUBLIC_SOCIAL_LIVE_WORKER_SERVICE =
  'property-predator-owned-public-social-live';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SECRET = /^[\x21-\x7e]{8,500}$/u;
const DATABASE_URL_ENV = 'DATABASE_OWNED_SOCIAL_WORKER_URL';
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const SAFE_ERROR_CLASSES = new Set([
  'Error', 'AggregateError', 'TypeError', 'RangeError', 'DatabaseError', 'ConnectionError',
  'OwnedPublicSocialLiveError',
]);
const APPROVED_SECRET_NAMES = new Set([
  'AYRSHARE_API_KEY',
  'AYRSHARE_X_OAUTH1_API_KEY',
  'AYRSHARE_X_OAUTH1_API_SECRET',
  'PROPERTY_PREDATOR_PUBLIC_SOCIAL_PROFILE_ENCRYPTION_KEY_BASE64',
  'PROPERTY_PREDATOR_PUBLIC_SOCIAL_PROFILE_ENCRYPTION_KEY_VERSION',
]);
const SECRET_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|BEARER_?TOKEN|OAUTH_?TOKEN|REFRESH_?TOKEN|CLIENT_?SECRET|APP_?SECRET|SIGNING_?KEY|WEBHOOK_?SECRET|PRIVATE_?KEY|SERVER_?TOKEN|PASSWORD|CREDENTIALS?|SECRET|TOKEN|KEY)(?:_|$)/u;

type RuntimePool = Pick<Pool, 'query' | 'connect' | 'end'>;
type CycleResult = 'idle' | 'published_or_pending' | 'failed_or_attention';

interface WorkerConfigBase {
  readonly installationId: string;
  readonly pollIntervalMs: number;
  readonly runtime: OwnedPublicSocialLiveRuntimeConfig;
}

export interface DisabledOwnedPublicSocialWorkerConfig extends WorkerConfigBase {
  readonly mode: 'disabled';
}

export interface ActiveOwnedPublicSocialWorkerConfig extends WorkerConfigBase {
  readonly mode: 'owned_profile_live';
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly encryptionKey: Buffer;
  readonly encryptionKeyVersion: string;
  readonly secrets: AyrshareOwnedLiveSecrets;
}

export type OwnedPublicSocialWorkerConfig =
  | DisabledOwnedPublicSocialWorkerConfig
  | ActiveOwnedPublicSocialWorkerConfig;

export type OwnedPublicSocialWorkerCycleResult = 'disabled' | CycleResult;

export interface OwnedPublicSocialWorkerReadiness {
  readonly schemaVersion: 1;
  readonly event: 'ready';
  readonly service: typeof OWNED_PUBLIC_SOCIAL_LIVE_WORKER_SERVICE;
  readonly mode: 'disabled' | 'owned_profile_live';
  readonly provider: Readonly<{
    id: 'ayrshare';
    network: 'x';
    credentialScope: 'single-owned-profile';
    credentialsLoaded: boolean;
    adapterInstantiated: boolean;
    networkCallsMadeAtReadiness: false;
  }>;
  readonly database: Readonly<{
    role: typeof OWNED_PUBLIC_SOCIAL_WORKER_DATABASE_ROLE;
    schemaCurrent: true;
    installationMatched: true;
    functionBoundaryReady: true;
  }>;
  readonly polling: Readonly<{
    intervalMs: number;
    maximumOperationsPerCycle: 1;
    overlappingCycles: false;
  }>;
  readonly safety: Readonly<{
    providerEffectsEnabled: boolean;
    emergencyPaused: boolean;
    dispatchLoopStarted: boolean;
    dailyPublishCap: 1;
    monthlyPublishCap: 3;
  }>;
}

export interface OwnedPublicSocialWorkerRuntime {
  readonly readiness: OwnedPublicSocialWorkerReadiness;
  readonly stopped: Promise<void>;
  runOnce(): Promise<OwnedPublicSocialWorkerCycleResult>;
  shutdown(): Promise<void>;
}

export interface OwnedPublicSocialWorkerDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly autoStart?: boolean;
  readonly createPool?: (
    env: NodeJS.ProcessEnv,
    hooks: Readonly<{ onBackgroundError: (error: Error) => void }>,
  ) => RuntimePool;
  readonly assertSchemaCurrent?: (pool: Pick<Pool, 'query'>) => Promise<void>;
  readonly assertInstallationReady?: (
    pool: Pick<Pool, 'query'>,
    expectedInstallationId: string | undefined,
  ) => Promise<void>;
  readonly assertBoundaryReady?: (pool: Pick<Pool, 'query'>) => Promise<void>;
  readonly createRepository?: (
    pool: Pick<Pool, 'connect'>,
    binding: Readonly<{ workspaceId: string; connectionId: string }>,
  ) => OwnedPublicSocialLiveRepository;
  readonly createTransport?: (
    secrets: AyrshareOwnedLiveSecrets,
  ) => AyrshareOwnedLiveTransport;
  readonly runCycle?: typeof runOwnedPublicSocialLiveOnce;
  readonly randomToken?: () => Uint8Array;
  readonly writeReadiness?: (line: string) => void;
  readonly writeErrorTelemetry?: (line: string) => void;
  readonly onCycle?: (result: OwnedPublicSocialWorkerCycleResult) => void;
}

function requiredUuid(raw: string | undefined, label: string): string {
  const value = raw?.trim().toLowerCase() ?? '';
  if (!UUID.test(value)) throw new Error(`${label} must be a UUID`);
  return value;
}

function boundedPollInterval(raw: string | undefined): number {
  if (!raw?.trim()) return DEFAULT_POLL_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 250 || value > 60_000) {
    throw new Error('Owned public-social worker poll interval is invalid');
  }
  return value;
}

function exactSecret(raw: string | undefined, label: string): string {
  const value = raw?.trim() ?? '';
  if (!SECRET.test(value)) throw new Error(`${label} is unavailable`);
  return value;
}

function exactEncryptionKey(raw: string | undefined): Buffer {
  const value = raw?.trim() ?? '';
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error('Owned public-social profile encryption key is unavailable');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    throw new Error('Owned public-social profile encryption key is invalid');
  }
  return decoded;
}

function assertExactDatabaseIdentity(env: NodeJS.ProcessEnv): void {
  if (!env[DATABASE_URL_ENV]?.trim()) {
    throw new Error(`${DATABASE_URL_ENV} is required`);
  }
  const configured = Object.keys(env).filter((name) => {
    const normalized = name.toUpperCase();
    return Boolean(env[name]?.trim())
      && (normalized === 'DATABASE_URL' || normalized === 'TEST_DATABASE_URL'
        || /^DATABASE_[A-Z0-9_]+_URL$/u.test(normalized));
  });
  if (configured.some((name) => name.toUpperCase() !== DATABASE_URL_ENV)) {
    throw new Error('Owned public-social worker received another database identity');
  }
}

function assertNoUnrelatedSecrets(env: NodeJS.ProcessEnv): void {
  if (Object.keys(env).some((name) => {
    const normalized = name.toUpperCase();
    return Boolean(env[name]?.trim())
      && normalized !== DATABASE_URL_ENV
      && !APPROVED_SECRET_NAMES.has(normalized)
      && SECRET_NAME.test(normalized);
  })) {
    throw new Error('Owned public-social worker received an unrelated secret');
  }
}

export function loadOwnedPublicSocialWorkerConfig(
  env: NodeJS.ProcessEnv,
): OwnedPublicSocialWorkerConfig {
  assertExactDatabaseIdentity(env);
  assertNoUnrelatedSecrets(env);
  const installationId = requiredUuid(
    env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID,
    'PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID',
  );
  const pollIntervalMs = boundedPollInterval(
    env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_POLL_MS,
  );
  const runtime = loadOwnedPublicSocialLiveRuntimeConfig(env);
  if (runtime.executionMode === 'disabled') {
    return Object.freeze({ mode: 'disabled', installationId, pollIntervalMs, runtime });
  }
  if (env.NODE_ENV?.trim().toLowerCase() !== 'production') {
    throw new Error('Owned public-social live mode requires NODE_ENV=production');
  }
  const encryptionKeyVersion = env
    .PROPERTY_PREDATOR_PUBLIC_SOCIAL_PROFILE_ENCRYPTION_KEY_VERSION?.trim() ?? '';
  if (!KEY_VERSION.test(encryptionKeyVersion)) {
    throw new Error('Owned public-social profile encryption key version is unavailable');
  }
  return Object.freeze({
    mode: 'owned_profile_live',
    installationId,
    pollIntervalMs,
    runtime,
    workspaceId: requiredUuid(
      env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_WORKSPACE_ID,
      'PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_WORKSPACE_ID',
    ),
    connectionId: requiredUuid(
      env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_CONNECTION_ID,
      'PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_CONNECTION_ID',
    ),
    encryptionKey: exactEncryptionKey(
      env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_PROFILE_ENCRYPTION_KEY_BASE64,
    ),
    encryptionKeyVersion,
    secrets: Object.freeze({
      apiKey: exactSecret(env.AYRSHARE_API_KEY, 'AYRSHARE_API_KEY'),
      xOAuth1ApiKey: exactSecret(
        env.AYRSHARE_X_OAUTH1_API_KEY,
        'AYRSHARE_X_OAUTH1_API_KEY',
      ),
      xOAuth1ApiSecret: exactSecret(
        env.AYRSHARE_X_OAUTH1_API_SECRET,
        'AYRSHARE_X_OAUTH1_API_SECRET',
      ),
    }),
  });
}

export function redactedOwnedPublicSocialWorkerErrorClass(error: unknown): string {
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
    service: OWNED_PUBLIC_SOCIAL_LIVE_WORKER_SERVICE,
    eventKind,
    count,
    errorClass,
  }))}\n`;
}

function readinessFor(
  config: OwnedPublicSocialWorkerConfig,
): OwnedPublicSocialWorkerReadiness {
  const active = config.mode === 'owned_profile_live';
  return Object.freeze({
    schemaVersion: 1,
    event: 'ready',
    service: OWNED_PUBLIC_SOCIAL_LIVE_WORKER_SERVICE,
    mode: config.mode,
    provider: Object.freeze({
      id: 'ayrshare',
      network: 'x',
      credentialScope: 'single-owned-profile',
      credentialsLoaded: active,
      adapterInstantiated: active,
      networkCallsMadeAtReadiness: false,
    }),
    database: Object.freeze({
      role: OWNED_PUBLIC_SOCIAL_WORKER_DATABASE_ROLE,
      schemaCurrent: true,
      installationMatched: true,
      functionBoundaryReady: true,
    }),
    polling: Object.freeze({
      intervalMs: config.pollIntervalMs,
      maximumOperationsPerCycle: 1,
      overlappingCycles: false,
    }),
    safety: Object.freeze({
      providerEffectsEnabled: config.runtime.providerEffectsEnabled,
      emergencyPaused: config.runtime.emergencyPaused,
      dispatchLoopStarted: active,
      dailyPublishCap: 1,
      monthlyPublishCap: 3,
    }),
  });
}

export async function startOwnedPublicSocialLiveWorker(
  dependencies: OwnedPublicSocialWorkerDependencies = {},
): Promise<OwnedPublicSocialWorkerRuntime> {
  const env = dependencies.env ?? process.env;
  const config = loadOwnedPublicSocialWorkerConfig(env);
  const writeErrorTelemetry = dependencies.writeErrorTelemetry
    ?? ((line: string) => { process.stderr.write(line); });
  let backgroundErrorCount = 0;
  let cycleErrorCount = 0;
  const pool = (dependencies.createPool ?? createOwnedSocialWorkerCommandDatabasePool)(env, {
    onBackgroundError: (error) => {
      backgroundErrorCount += 1;
      writeErrorTelemetry(errorLine(
        'background_database',
        backgroundErrorCount,
        redactedOwnedPublicSocialWorkerErrorClass(error),
      ));
    },
  });
  try {
    await (dependencies.assertSchemaCurrent ?? assertRuntimeSchemaCurrent)(pool);
    await (dependencies.assertInstallationReady ?? assertExpectedDatabaseInstallation)(
      pool,
      config.installationId,
    );
    await (dependencies.assertBoundaryReady ?? assertOwnedPublicSocialWorkerBoundaryReady)(pool);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  let repository: OwnedPublicSocialLiveRepository | null = null;
  let transport: AyrshareOwnedLiveTransport | null = null;
  if (config.mode === 'owned_profile_live') {
    try {
      repository = (dependencies.createRepository
        ?? ((commandPool, binding) => new PgOwnedPublicSocialLiveRepository(
          commandPool,
          binding,
        )))(pool, { workspaceId: config.workspaceId, connectionId: config.connectionId });
      transport = (dependencies.createTransport
        ?? ((secrets) => createAyrshareOwnedLiveTransport({
          fetch: globalThis.fetch,
          secrets,
          providerEffectsEnabled: true,
          emergencyPaused: false,
        })))(config.secrets);
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
  let inFlight: Promise<OwnedPublicSocialWorkerCycleResult> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const runCycle = dependencies.runCycle ?? runOwnedPublicSocialLiveOnce;

  const executeCycle = (): Promise<OwnedPublicSocialWorkerCycleResult> => {
    if (stopping) return Promise.reject(new Error('Owned public-social worker is stopping'));
    if (inFlight) return inFlight;
    if (config.mode === 'disabled') return Promise.resolve('disabled');
    if (!repository || !transport) {
      return Promise.reject(new Error('Owned public-social live composition is incomplete'));
    }
    const token = (dependencies.randomToken ?? (() => randomBytes(32)))();
    if (!(token instanceof Uint8Array) || token.byteLength !== 32) {
      return Promise.reject(new Error('Owned public-social worker lease entropy is invalid'));
    }
    inFlight = runCycle({
      config: config.runtime,
      repository,
      transport,
      encryptionKey: config.encryptionKey,
      encryptionKeyVersion: config.encryptionKeyVersion,
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
          'cycle',
          cycleErrorCount,
          redactedOwnedPublicSocialWorkerErrorClass(error),
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
            'Owned public-social cycle and pool shutdown both failed',
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

export function writeOwnedPublicSocialWorkerFailure(
  eventKind: 'startup' | 'shutdown',
  count: number,
  error: unknown,
): void {
  process.stderr.write(errorLine(
    eventKind,
    count,
    redactedOwnedPublicSocialWorkerErrorClass(error),
  ));
}
