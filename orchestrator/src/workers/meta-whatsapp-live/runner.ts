import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { assertExpectedDatabaseInstallation } from '../../db/installation-identity.js';
import { createWhatsAppLiveWorkerCommandDatabasePool } from '../../db/pool.js';
import { assertRuntimeSchemaCurrent } from '../../db/runtime-readiness.js';
import {
  META_WHATSAPP_LIVE_WORKER_DATABASE_ROLE,
  PgMetaWhatsAppLiveRepository,
  assertMetaWhatsAppLiveWorkerBoundaryReady,
} from '../../whatsapp-live-pg/index.js';
import {
  createMetaWhatsAppLiveTransport,
  loadMetaWhatsAppLiveRuntimeConfig,
  runMetaWhatsAppLiveOnce,
  type MetaWhatsAppLiveRepository,
  type MetaWhatsAppLiveRuntimeConfig,
} from '../../whatsapp-live/index.js';

export const META_WHATSAPP_LIVE_WORKER_SERVICE =
  'property-predator-meta-whatsapp-live-worker' as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const DATABASE_URL_ENV = 'DATABASE_WHATSAPP_LIVE_WORKER_URL';
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const APPROVED_SECRET_NAMES = new Set([
  'PROPERTY_PREDATOR_WHATSAPP_CREDENTIAL_ENCRYPTION_KEY_BASE64',
  'PROPERTY_PREDATOR_WHATSAPP_CREDENTIAL_ENCRYPTION_KEY_VERSION',
]);
const SECRET_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|BEARER_?TOKEN|OAUTH_?TOKEN|REFRESH_?TOKEN|CLIENT_?SECRET|APP_?SECRET|SIGNING_?KEY|WEBHOOK_?SECRET|PRIVATE_?KEY|SERVER_?TOKEN|PASSWORD|CREDENTIALS?|SECRET|TOKEN|KEY)(?:_|$)/u;
const SAFE_ERROR_CLASSES = new Set([
  'Error', 'AggregateError', 'TypeError', 'RangeError', 'DatabaseError',
  'ConnectionError', 'MetaWhatsAppLiveError',
]);

type RuntimePool = Pick<Pool, 'query' | 'connect' | 'end'>;
type MetaWhatsAppLiveTransportFactory =
  Parameters<typeof runMetaWhatsAppLiveOnce>[0]['createTransport'];
type ActiveConfig = Readonly<{
  mode: 'owned_template_live';
  installationId: string;
  pollIntervalMs: number;
  workspaceId: string;
  connectionId: string;
  encryptionKey: Buffer;
  encryptionKeyVersion: string;
  runtime: MetaWhatsAppLiveRuntimeConfig;
}>;
type DisabledConfig = Readonly<{
  mode: 'disabled';
  installationId: string;
  pollIntervalMs: number;
  runtime: MetaWhatsAppLiveRuntimeConfig;
}>;
export type MetaWhatsAppLiveWorkerConfig = ActiveConfig | DisabledConfig;
export type MetaWhatsAppLiveWorkerCycleResult =
  | 'disabled' | 'idle' | 'accepted' | 'failed_or_attention';

export interface MetaWhatsAppLiveWorkerReadiness {
  readonly schemaVersion: 1;
  readonly event: 'ready';
  readonly service: typeof META_WHATSAPP_LIVE_WORKER_SERVICE;
  readonly mode: 'disabled' | 'owned_template_live';
  readonly database: Readonly<{
    role: typeof META_WHATSAPP_LIVE_WORKER_DATABASE_ROLE;
    schemaCurrent: true;
    installationMatched: true;
    functionBoundaryReady: true;
  }>;
  readonly provider: Readonly<{
    id: 'meta_whatsapp_cloud';
    graphApiVersion: 'v24.0';
    credentialSource: 'job-bound-encrypted-envelope';
    credentialEnvelopeLoadedAtReadiness: false;
    adapterInstantiatedAtReadiness: false;
    networkCallsMadeAtReadiness: false;
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
    maximumRecipientsPerJob: 1;
    maximumTemplatesPerJob: 1;
    dailySendCap: 1;
    monthlySendCap: 3;
  }>;
}

export interface MetaWhatsAppLiveWorkerRuntime {
  readonly readiness: MetaWhatsAppLiveWorkerReadiness;
  readonly stopped: Promise<void>;
  runOnce(): Promise<MetaWhatsAppLiveWorkerCycleResult>;
  shutdown(): Promise<void>;
}

export interface MetaWhatsAppLiveWorkerDependencies {
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
    pool: Pick<Pool, 'query'>,
    binding: Readonly<{ workspaceId: string; connectionId: string }>,
  ) => MetaWhatsAppLiveRepository;
  readonly createTransport?: MetaWhatsAppLiveTransportFactory;
  readonly runCycle?: typeof runMetaWhatsAppLiveOnce;
  readonly randomToken?: () => Uint8Array;
  readonly writeReadiness?: (line: string) => void;
  readonly writeErrorTelemetry?: (line: string) => void;
  readonly onCycle?: (result: MetaWhatsAppLiveWorkerCycleResult) => void;
}

function requiredUuid(raw: string | undefined, label: string): string {
  const value = raw?.trim() ?? '';
  if (!UUID.test(value)) throw new Error(`${label} must be a canonical UUID`);
  return value;
}

function pollInterval(raw: string | undefined): number {
  if (!raw?.trim()) return DEFAULT_POLL_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 250 || value > 60_000) {
    throw new Error('Meta WhatsApp live poll interval is invalid');
  }
  return value;
}

function encryptionKey(raw: string | undefined): Buffer {
  const value = raw?.trim() ?? '';
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error('Meta WhatsApp credential encryption key is unavailable');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    throw new Error('Meta WhatsApp credential encryption key is invalid');
  }
  return decoded;
}

function assertExactDatabaseIdentity(env: NodeJS.ProcessEnv): void {
  if (!env[DATABASE_URL_ENV]?.trim()) throw new Error(`${DATABASE_URL_ENV} is required`);
  const databaseUrls = Object.keys(env).filter((name) => {
    const normalized = name.toUpperCase();
    return Boolean(env[name]?.trim())
      && (normalized === 'DATABASE_URL' || normalized === 'TEST_DATABASE_URL'
        || /^DATABASE_[A-Z0-9_]+_URL$/u.test(normalized));
  });
  if (databaseUrls.some((name) => name.toUpperCase() !== DATABASE_URL_ENV)) {
    throw new Error('Meta WhatsApp live worker received another database identity');
  }
}

function assertNoUnrelatedSecrets(env: NodeJS.ProcessEnv): void {
  const unrelated = Object.keys(env).some((name) => {
    const normalized = name.toUpperCase();
    return Boolean(env[name]?.trim()) && normalized !== DATABASE_URL_ENV
      && !APPROVED_SECRET_NAMES.has(normalized) && SECRET_NAME.test(normalized);
  });
  if (unrelated) throw new Error('Meta WhatsApp live worker received an unrelated secret');
}

export function loadMetaWhatsAppLiveWorkerConfig(
  env: NodeJS.ProcessEnv,
): MetaWhatsAppLiveWorkerConfig {
  assertExactDatabaseIdentity(env);
  assertNoUnrelatedSecrets(env);
  const installationId = requiredUuid(
    env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID,
    'PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID',
  );
  const interval = pollInterval(env.PROPERTY_PREDATOR_WHATSAPP_LIVE_POLL_MS);
  const runtime = loadMetaWhatsAppLiveRuntimeConfig(env);
  if (runtime.mode === 'disabled') {
    return Object.freeze({ mode: 'disabled', installationId,
      pollIntervalMs: interval, runtime });
  }
  if (env.NODE_ENV?.trim().toLowerCase() !== 'production') {
    throw new Error('Meta WhatsApp owned-template live mode requires NODE_ENV=production');
  }
  const encryptionKeyVersion =
    env.PROPERTY_PREDATOR_WHATSAPP_CREDENTIAL_ENCRYPTION_KEY_VERSION?.trim() ?? '';
  if (!KEY_VERSION.test(encryptionKeyVersion)) {
    throw new Error('Meta WhatsApp credential encryption key version is unavailable');
  }
  return Object.freeze({
    mode: 'owned_template_live',
    installationId,
    pollIntervalMs: interval,
    workspaceId: requiredUuid(
      env.PROPERTY_PREDATOR_WHATSAPP_LIVE_WORKSPACE_ID,
      'PROPERTY_PREDATOR_WHATSAPP_LIVE_WORKSPACE_ID',
    ),
    connectionId: requiredUuid(
      env.PROPERTY_PREDATOR_WHATSAPP_LIVE_CONNECTION_ID,
      'PROPERTY_PREDATOR_WHATSAPP_LIVE_CONNECTION_ID',
    ),
    encryptionKey: encryptionKey(
      env.PROPERTY_PREDATOR_WHATSAPP_CREDENTIAL_ENCRYPTION_KEY_BASE64,
    ),
    encryptionKeyVersion,
    runtime,
  });
}

function safeErrorClass(error: unknown): string {
  return error instanceof Error && SAFE_ERROR_CLASSES.has(error.name)
    ? error.name : 'Error';
}

function errorLine(
  eventKind: 'startup' | 'background_database' | 'cycle' | 'shutdown',
  count: number,
  error: unknown,
): string {
  return `${JSON.stringify(Object.freeze({ schemaVersion: 1, event: 'worker_error',
    service: META_WHATSAPP_LIVE_WORKER_SERVICE, eventKind, count,
    errorClass: safeErrorClass(error) }))}\n`;
}

function readinessFor(config: MetaWhatsAppLiveWorkerConfig): MetaWhatsAppLiveWorkerReadiness {
  const active = config.mode === 'owned_template_live';
  return Object.freeze({
    schemaVersion: 1,
    event: 'ready',
    service: META_WHATSAPP_LIVE_WORKER_SERVICE,
    mode: config.mode,
    database: Object.freeze({ role: META_WHATSAPP_LIVE_WORKER_DATABASE_ROLE,
      schemaCurrent: true, installationMatched: true, functionBoundaryReady: true }),
    provider: Object.freeze({ id: 'meta_whatsapp_cloud', graphApiVersion: 'v24.0',
      credentialSource: 'job-bound-encrypted-envelope',
      credentialEnvelopeLoadedAtReadiness: false,
      adapterInstantiatedAtReadiness: false, networkCallsMadeAtReadiness: false }),
    polling: Object.freeze({ intervalMs: config.pollIntervalMs,
      maximumOperationsPerCycle: 1, overlappingCycles: false }),
    safety: Object.freeze({ providerEffectsEnabled: config.runtime.providerEffectsEnabled,
      emergencyPaused: config.runtime.emergencyPaused, dispatchLoopStarted: active,
      maximumRecipientsPerJob: 1, maximumTemplatesPerJob: 1,
      dailySendCap: 1, monthlySendCap: 3 }),
  });
}

export async function startMetaWhatsAppLiveWorker(
  dependencies: MetaWhatsAppLiveWorkerDependencies = {},
): Promise<MetaWhatsAppLiveWorkerRuntime> {
  const env = dependencies.env ?? process.env;
  const config = loadMetaWhatsAppLiveWorkerConfig(env);
  const writeError = dependencies.writeErrorTelemetry
    ?? ((line: string) => { process.stderr.write(line); });
  let backgroundErrors = 0;
  let cycleErrors = 0;
  const pool = (dependencies.createPool ?? createWhatsAppLiveWorkerCommandDatabasePool)(env, {
    onBackgroundError: (error) => {
      backgroundErrors += 1;
      writeError(errorLine('background_database', backgroundErrors, error));
    },
  });
  try {
    await (dependencies.assertSchemaCurrent ?? assertRuntimeSchemaCurrent)(pool);
    await (dependencies.assertInstallationReady ?? assertExpectedDatabaseInstallation)(
      pool, config.installationId,
    );
    await (dependencies.assertBoundaryReady ?? assertMetaWhatsAppLiveWorkerBoundaryReady)(pool);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  let repository: MetaWhatsAppLiveRepository | null = null;
  if (config.mode === 'owned_template_live') {
    repository = (dependencies.createRepository
      ?? ((executor, binding) => new PgMetaWhatsAppLiveRepository(executor, binding)))(
      pool, { workspaceId: config.workspaceId, connectionId: config.connectionId },
    );
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
  let inFlight: Promise<MetaWhatsAppLiveWorkerCycleResult> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const runCycle = dependencies.runCycle ?? runMetaWhatsAppLiveOnce;
  const createTransport = dependencies.createTransport
    ?? ((options) => createMetaWhatsAppLiveTransport({ ...options, fetch: globalThis.fetch }));

  const executeCycle = (): Promise<MetaWhatsAppLiveWorkerCycleResult> => {
    if (stopping) return Promise.reject(new Error('Meta WhatsApp live worker is stopping'));
    if (inFlight) return inFlight;
    if (config.mode === 'disabled') return Promise.resolve('disabled');
    if (!repository) return Promise.reject(new Error('Meta WhatsApp worker composition is incomplete'));
    const token = (dependencies.randomToken ?? (() => randomBytes(32)))();
    if (!(token instanceof Uint8Array) || token.byteLength !== 32) {
      return Promise.reject(new Error('Meta WhatsApp worker lease entropy is invalid'));
    }
    inFlight = runCycle({ config: config.runtime, repository,
      encryptionKey: config.encryptionKey,
      encryptionKeyVersion: config.encryptionKeyVersion,
      leaseToken: Buffer.from(token), createTransport }).finally(() => { inFlight = undefined; });
    return inFlight;
  };

  const onCycle = dependencies.onCycle ?? (() => undefined);
  const schedule = (): void => {
    if (stopping || config.mode === 'disabled') return;
    timer = setTimeout(() => {
      timer = undefined;
      void executeCycle().then(onCycle).catch((error: unknown) => {
        cycleErrors += 1;
        writeError(errorLine('cycle', cycleErrors, error));
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
        if (cycleError !== undefined) throw new AggregateError(
          [cycleError, closeError], 'Meta WhatsApp cycle and pool shutdown both failed',
        );
        throw closeError;
      }
      if (cycleError !== undefined) throw cycleError;
    })().finally(() => { resolveStopped?.(); });
    return shutdownPromise;
  };
  return Object.freeze({ readiness, stopped, runOnce: executeCycle, shutdown });
}

export function writeMetaWhatsAppLiveWorkerFailure(
  eventKind: 'startup' | 'shutdown', count: number, error: unknown,
): void {
  process.stderr.write(errorLine(eventKind, count, error));
}
