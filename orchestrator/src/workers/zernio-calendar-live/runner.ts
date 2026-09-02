import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { assertExpectedDatabaseInstallation } from '../../db/installation-identity.js';
import { createOwnedSocialWorkerCommandDatabasePool } from '../../db/pool.js';
import { assertRuntimeSchemaCurrent } from '../../db/runtime-readiness.js';
import {
  assertZernioCalendarWorkerBoundaryReady,
  OWNED_PUBLIC_SOCIAL_WORKER_DATABASE_ROLE,
  PgZernioCalendarRepository,
} from '../../owned-public-social-pg/index.js';
import {
  createZernioPostingClient,
  createApprovedSocialMediaUrlResolver,
  loadApprovedSocialMediaSigningConfig,
  loadZernioCalendarRuntimeConfig,
  runZernioCalendarLiveOnce,
  type ZernioCalendarAccountBinding,
  type ZernioCalendarMediaResolver,
  type ZernioCalendarRepository,
  type ZernioCalendarRuntimeConfig,
  type ZernioPostingClient,
  type ZernioPostingNetwork,
} from '../../public-social-outbound/index.js';

export const ZERNIO_CALENDAR_LIVE_WORKER_SERVICE =
  'property-predator-owned-public-social-live' as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const API_KEY = /^[\x21-\x7e]{8,500}$/u;
const ACCOUNT_ID = /^[a-f0-9]{24}$/u;
const DATABASE_URL_ENV = 'DATABASE_OWNED_SOCIAL_WORKER_URL';
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const APPROVED_SECRET_NAMES = new Set([
  'ZERNIO_API_KEY',
  'PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_SIGNING_KEY_BASE64URL',
]);
const SECRET_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|BEARER_?TOKEN|OAUTH_?TOKEN|REFRESH_?TOKEN|CLIENT_?SECRET|APP_?SECRET|SIGNING_?KEY|WEBHOOK_?SECRET|PRIVATE_?KEY|SERVER_?TOKEN|PASSWORD|CREDENTIALS?|SECRET|TOKEN|KEY)(?:_|$)/u;
const SAFE_ERROR_CLASSES = new Set([
  'Error', 'AggregateError', 'TypeError', 'RangeError', 'DatabaseError',
  'ConnectionError', 'ZernioPostingError', 'ZernioCalendarLiveError',
]);

type RuntimePool = Pick<Pool, 'query' | 'connect' | 'end'>;
type CycleResult = 'idle' | 'published_or_pending' | 'failed_or_attention';

interface WorkerConfigBase {
  readonly installationId: string;
  readonly pollIntervalMs: number;
  readonly runtime: ZernioCalendarRuntimeConfig;
}

export interface DisabledZernioCalendarWorkerConfig extends WorkerConfigBase {
  readonly mode: 'disabled';
}

export interface ActiveZernioCalendarWorkerConfig extends WorkerConfigBase {
  readonly mode: 'zernio_live';
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly apiKey: string;
  readonly accountBindings: readonly ZernioCalendarAccountBinding[];
}

export type ZernioCalendarWorkerConfig =
  | DisabledZernioCalendarWorkerConfig
  | ActiveZernioCalendarWorkerConfig;

export type ZernioCalendarWorkerCycleResult = 'disabled' | CycleResult;

export interface ZernioCalendarWorkerReadiness {
  readonly schemaVersion: 1;
  readonly event: 'ready';
  readonly service: typeof ZERNIO_CALENDAR_LIVE_WORKER_SERVICE;
  readonly mode: 'disabled' | 'zernio_live';
  readonly provider: Readonly<{
    id: 'zernio';
    network: 'instagram' | 'linkedin' | 'instagram_linkedin';
    credentialScope: 'property-predator-owned-accounts';
    credentialsLoaded: boolean;
    accountsBound: number;
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

export interface ZernioCalendarWorkerRuntime {
  readonly readiness: ZernioCalendarWorkerReadiness;
  readonly stopped: Promise<void>;
  runOnce(): Promise<ZernioCalendarWorkerCycleResult>;
  shutdown(): Promise<void>;
}

export interface ZernioCalendarWorkerDependencies {
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
  ) => ZernioCalendarRepository;
  readonly createPosting?: (input: Readonly<{
    apiKey: string;
    accountBindings: readonly ZernioCalendarAccountBinding[];
  }>) => Pick<ZernioPostingClient, 'publishDue' | 'reconcile'>;
  readonly createMediaResolver?: (env: NodeJS.ProcessEnv) => ZernioCalendarMediaResolver;
  readonly runCycle?: typeof runZernioCalendarLiveOnce;
  readonly randomToken?: () => Uint8Array;
  readonly writeReadiness?: (line: string) => void;
  readonly writeErrorTelemetry?: (line: string) => void;
  readonly onCycle?: (result: ZernioCalendarWorkerCycleResult) => void;
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
    throw new Error('Zernio calendar worker poll interval is invalid');
  }
  return value;
}

function exactApiKey(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  if (!API_KEY.test(value)) throw new Error('ZERNIO_API_KEY is unavailable');
  return value;
}

function exactAccountId(raw: string | undefined, network: ZernioPostingNetwork): string {
  const value = raw?.trim().toLowerCase() ?? '';
  if (!ACCOUNT_ID.test(value)) {
    throw new Error(`Zernio ${network} account binding is unavailable`);
  }
  return value;
}

function defaultMediaResolver(env: NodeJS.ProcessEnv): ZernioCalendarMediaResolver {
  const signing = loadApprovedSocialMediaSigningConfig(env, true)!;
  return createApprovedSocialMediaUrlResolver({
    publicOrigin: env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_ORIGIN?.trim() ?? '',
    signingKey: signing.key,
    ttlSeconds: signing.ttlSeconds,
  });
}

function assertExactDatabaseIdentity(env: NodeJS.ProcessEnv): void {
  if (!env[DATABASE_URL_ENV]?.trim()) throw new Error(`${DATABASE_URL_ENV} is required`);
  const configured = Object.keys(env).filter((name) => {
    const normalized = name.toUpperCase();
    return Boolean(env[name]?.trim())
      && (normalized === 'DATABASE_URL' || normalized === 'TEST_DATABASE_URL'
        || /^DATABASE_[A-Z0-9_]+_URL$/u.test(normalized));
  });
  if (configured.some((name) => name.toUpperCase() !== DATABASE_URL_ENV)) {
    throw new Error('Zernio calendar worker received another database identity');
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
    throw new Error('Zernio calendar worker received an unrelated secret');
  }
}

export function loadZernioCalendarWorkerConfig(
  env: NodeJS.ProcessEnv,
): ZernioCalendarWorkerConfig {
  assertExactDatabaseIdentity(env);
  assertNoUnrelatedSecrets(env);
  const installationId = requiredUuid(
    env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID,
    'PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID',
  );
  const pollIntervalMs = boundedPollInterval(
    env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_POLL_MS,
  );
  const runtime = loadZernioCalendarRuntimeConfig(env);
  if (runtime.executionMode === 'disabled') {
    return Object.freeze({ mode: 'disabled', installationId, pollIntervalMs, runtime });
  }
  if (env.NODE_ENV?.trim().toLowerCase() !== 'production') {
    throw new Error('Zernio calendar live mode requires NODE_ENV=production');
  }
  const mediaSigning = loadApprovedSocialMediaSigningConfig(env, true)!;
  // Construction validates a clean, public HTTPS origin and the bounded TTL
  // before any database lease or provider adapter can be created.
  createApprovedSocialMediaUrlResolver({
    publicOrigin: env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_ORIGIN?.trim() ?? '',
    signingKey: mediaSigning.key,
    ttlSeconds: mediaSigning.ttlSeconds,
  });
  const accountBindings = runtime.networks.map((network) => Object.freeze({
    network,
    providerAccountId: exactAccountId(
      network === 'instagram'
        ? env.PROPERTY_PREDATOR_ZERNIO_INSTAGRAM_ACCOUNT_ID
        : env.PROPERTY_PREDATOR_ZERNIO_LINKEDIN_ACCOUNT_ID,
      network,
    ),
  }));
  return Object.freeze({
    mode: 'zernio_live', installationId, pollIntervalMs, runtime,
    workspaceId: requiredUuid(
      env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_WORKSPACE_ID,
      'PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_WORKSPACE_ID',
    ),
    connectionId: requiredUuid(
      env.PROPERTY_PREDATOR_ZERNIO_LIVE_CONNECTION_ID,
      'PROPERTY_PREDATOR_ZERNIO_LIVE_CONNECTION_ID',
    ),
    apiKey: exactApiKey(env.ZERNIO_API_KEY),
    accountBindings: Object.freeze(accountBindings),
  });
}

function networkLabel(
  networks: readonly ZernioPostingNetwork[],
): ZernioCalendarWorkerReadiness['provider']['network'] {
  return networks.length === 2 ? 'instagram_linkedin' : networks[0] ?? 'instagram';
}

function readinessFor(config: ZernioCalendarWorkerConfig): ZernioCalendarWorkerReadiness {
  const active = config.mode === 'zernio_live';
  return Object.freeze({
    schemaVersion: 1,
    event: 'ready',
    service: ZERNIO_CALENDAR_LIVE_WORKER_SERVICE,
    mode: config.mode,
    provider: Object.freeze({
      id: 'zernio',
      network: networkLabel(config.runtime.networks),
      credentialScope: 'property-predator-owned-accounts',
      credentialsLoaded: active,
      accountsBound: active ? config.accountBindings.length : 0,
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

export function redactedZernioCalendarWorkerErrorClass(error: unknown): string {
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
    service: ZERNIO_CALENDAR_LIVE_WORKER_SERVICE,
    eventKind,
    count,
    errorClass,
  }))}\n`;
}

export async function startZernioCalendarLiveWorker(
  dependencies: ZernioCalendarWorkerDependencies = {},
): Promise<ZernioCalendarWorkerRuntime> {
  const env = dependencies.env ?? process.env;
  const config = loadZernioCalendarWorkerConfig(env);
  const writeErrorTelemetry = dependencies.writeErrorTelemetry
    ?? ((line: string) => { process.stderr.write(line); });
  let backgroundErrorCount = 0;
  let cycleErrorCount = 0;
  const pool = (dependencies.createPool ?? createOwnedSocialWorkerCommandDatabasePool)(env, {
    onBackgroundError: (error) => {
      backgroundErrorCount += 1;
      writeErrorTelemetry(errorLine(
        'background_database', backgroundErrorCount,
        redactedZernioCalendarWorkerErrorClass(error),
      ));
    },
  });
  try {
    await (dependencies.assertSchemaCurrent ?? assertRuntimeSchemaCurrent)(pool);
    await (dependencies.assertInstallationReady ?? assertExpectedDatabaseInstallation)(
      pool, config.installationId,
    );
    await (dependencies.assertBoundaryReady ?? assertZernioCalendarWorkerBoundaryReady)(pool);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  let repository: ZernioCalendarRepository | null = null;
  let posting: Pick<ZernioPostingClient, 'publishDue' | 'reconcile'> | null = null;
  let mediaResolver: ZernioCalendarMediaResolver | null = null;
  if (config.mode === 'zernio_live') {
    try {
      repository = (dependencies.createRepository
        ?? ((commandPool, binding) => new PgZernioCalendarRepository(commandPool, binding)))(
        pool, { workspaceId: config.workspaceId, connectionId: config.connectionId },
      );
      posting = (dependencies.createPosting ?? ((input) => createZernioPostingClient({
        apiKey: input.apiKey,
        allowedTargets: input.accountBindings.map((binding) => ({
          network: binding.network, accountId: binding.providerAccountId,
        })),
        fetch: globalThis.fetch,
      })))(config);
      mediaResolver = (dependencies.createMediaResolver ?? defaultMediaResolver)(env);
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
  let inFlight: Promise<ZernioCalendarWorkerCycleResult> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const runCycle = dependencies.runCycle ?? runZernioCalendarLiveOnce;

  const executeCycle = (): Promise<ZernioCalendarWorkerCycleResult> => {
    if (stopping) return Promise.reject(new Error('Zernio calendar worker is stopping'));
    if (inFlight) return inFlight;
    if (config.mode === 'disabled') return Promise.resolve('disabled');
    if (!repository || !posting || !mediaResolver) {
      return Promise.reject(new Error('Zernio calendar live composition is incomplete'));
    }
    const token = (dependencies.randomToken ?? (() => randomBytes(32)))();
    if (!(token instanceof Uint8Array) || token.byteLength !== 32) {
      return Promise.reject(new Error('Zernio calendar worker lease entropy is invalid'));
    }
    inFlight = runCycle({
      config: config.runtime,
      accountBindings: config.accountBindings,
      repository,
      posting,
      leaseToken: Buffer.from(token),
      mediaResolver,
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
          'cycle', cycleErrorCount, redactedZernioCalendarWorkerErrorClass(error),
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
            'Zernio calendar cycle and pool shutdown both failed',
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

export function writeZernioCalendarWorkerFailure(
  eventKind: 'startup' | 'shutdown',
  count: number,
  error: unknown,
): void {
  process.stderr.write(errorLine(
    eventKind, count, redactedZernioCalendarWorkerErrorClass(error),
  ));
}
