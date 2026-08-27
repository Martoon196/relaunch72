import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { assertExpectedDatabaseInstallation } from '../../db/installation-identity.js';
import { createPublicSocialWorkerCommandDatabasePool } from '../../db/pool.js';
import { assertRuntimeSchemaCurrent } from '../../db/runtime-readiness.js';
import {
  DeterministicPublicSocialTestProvider,
  PgPublicSocialTestQueue,
  PublicSocialTestDispatcher,
  PUBLIC_SOCIAL_TEST_PROVIDER_ID,
  type PublicSocialTestDispatchCycleResult,
  type PublicSocialTestLeaseIdentity,
} from '../../social-campaign-pg/index.js';

export const PUBLIC_SOCIAL_TEST_RAIL_SERVICE = 'property-predator-public-social-test-rail';
export const PUBLIC_SOCIAL_TEST_RAIL_DATABASE_ROLE = 'r72_public_social_worker_command';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MINIMUM_POLL_INTERVAL_MS = 100;
const MAXIMUM_POLL_INTERVAL_MS = 60_000;
const LEASE_SECONDS = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_ERROR_CLASSES = new Set([
  'Error', 'AggregateError', 'TypeError', 'RangeError', 'DatabaseError', 'ConnectionError',
]);
const FORBIDDEN_CREDENTIAL_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|BEARER_?TOKEN|OAUTH_?TOKEN|REFRESH_?TOKEN|CLIENT_?SECRET|APP_?SECRET|SIGNING_?KEY|WEBHOOK_?SECRET|PRIVATE_?KEY|SERVER_?TOKEN|BOT_?TOKEN|PASSWORD|CREDENTIALS?|SECRET|TOKEN|KEY)$/u;

type WorkerPool = Pick<Pool, 'query' | 'connect' | 'end'>;
type Dispatcher = Pick<PublicSocialTestDispatcher, 'runOnce'>;

export interface PublicSocialTestRailConfig {
  readonly pollIntervalMs: number;
  readonly installationId: string;
}

export interface PublicSocialTestRailReadiness {
  readonly schemaVersion: 1;
  readonly event: 'ready';
  readonly service: typeof PUBLIC_SOCIAL_TEST_RAIL_SERVICE;
  readonly environment: 'test';
  readonly providerId: typeof PUBLIC_SOCIAL_TEST_PROVIDER_ID;
  readonly databaseRole: typeof PUBLIC_SOCIAL_TEST_RAIL_DATABASE_ROLE;
  readonly polling: Readonly<{
    intervalMs: number;
    maximumOperationsPerCycle: 1;
    leaseSeconds: typeof LEASE_SECONDS;
    overlappingCycles: false;
  }>;
  readonly safety: Readonly<{
    providerEffectsEnabled: false;
    emergencyPaused: true;
    reservedAccountsOnly: true;
    liveProviderAdapterLoaded: false;
    externalPublishAttempted: false;
  }>;
}

export interface PublicSocialTestRailRuntime {
  readonly readiness: PublicSocialTestRailReadiness;
  readonly stopped: Promise<void>;
  runOnce(): Promise<PublicSocialTestDispatchCycleResult>;
  shutdown(): Promise<void>;
}

export interface PublicSocialTestRailDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly autoStart?: boolean;
  readonly createPool?: (
    env: NodeJS.ProcessEnv,
    hooks: Readonly<{ onBackgroundError: (error: Error) => void }>,
  ) => WorkerPool;
  readonly assertSchemaCurrent?: (pool: Pick<Pool, 'query'>) => Promise<void>;
  readonly assertInstallationReady?: (
    pool: Pick<Pool, 'query'>,
    expectedInstallationId: string | undefined,
  ) => Promise<void>;
  readonly createDispatcher?: (pool: WorkerPool) => Dispatcher;
  readonly createLease?: () => PublicSocialTestLeaseIdentity;
  readonly writeReadiness?: (line: string) => void;
  readonly onCycle?: (result: PublicSocialTestDispatchCycleResult) => void;
  readonly onCycleError?: (errorClass: string) => void;
  readonly onBackgroundDatabaseError?: (errorClass: string) => void;
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function assertOnlySocialWorkerDatabaseIdentity(env: NodeJS.ProcessEnv): void {
  if (!env.DATABASE_PUBLIC_SOCIAL_WORKER_URL?.trim()) {
    throw new Error('DATABASE_PUBLIC_SOCIAL_WORKER_URL is required for the public-social TEST rail');
  }
  const configuredDatabaseUrls = Object.keys(env).filter((name) => {
    const normalizedName = name.toUpperCase();
    return Boolean(env[name]?.trim())
      && (normalizedName === 'DATABASE_URL'
        || normalizedName === 'TEST_DATABASE_URL'
        || /^DATABASE_[A-Z0-9_]+_URL$/u.test(normalizedName));
  });
  if (configuredDatabaseUrls.some(
    (name) => name.toUpperCase() !== 'DATABASE_PUBLIC_SOCIAL_WORKER_URL',
  )) {
    throw new Error('Public-social TEST rail received a database identity outside its exact worker role');
  }
}

function assertNoProviderCredentials(env: NodeJS.ProcessEnv): void {
  if (Object.keys(env).some((name) => {
    const normalizedName = name.toUpperCase();
    return normalizedName !== 'DATABASE_PUBLIC_SOCIAL_WORKER_URL'
      && normalizedName !== 'PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID'
      && Boolean(env[name]?.trim())
      && FORBIDDEN_CREDENTIAL_NAME.test(normalizedName);
  })) {
    throw new Error('Public-social TEST rail received a provider or unrelated credential');
  }
}

export function loadPublicSocialTestRailConfig(
  env: NodeJS.ProcessEnv,
): PublicSocialTestRailConfig {
  if (env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_RAIL_ENVIRONMENT !== 'test') {
    throw new Error('Public-social rail requires environment=test');
  }
  if (env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_RAIL_PROVIDER_ID !== PUBLIC_SOCIAL_TEST_PROVIDER_ID) {
    throw new Error(`Public-social rail requires provider_id=${PUBLIC_SOCIAL_TEST_PROVIDER_ID}`);
  }
  if (env.PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED !== 'false') {
    throw new Error('Public-social rail requires provider effects to be exactly false');
  }
  if (env.PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED !== 'true') {
    throw new Error('Public-social rail requires the external-effects emergency pause to be engaged');
  }
  assertOnlySocialWorkerDatabaseIdentity(env);
  assertNoProviderCredentials(env);
  const installationId = env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID?.trim() ?? '';
  if (!UUID.test(installationId)) {
    throw new Error('Public-social rail requires the database installation identity');
  }
  return Object.freeze({
    installationId,
    pollIntervalMs: boundedInteger(
      env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_RAIL_POLL_MS,
      DEFAULT_POLL_INTERVAL_MS,
      MINIMUM_POLL_INTERVAL_MS,
      MAXIMUM_POLL_INTERVAL_MS,
      'PROPERTY_PREDATOR_PUBLIC_SOCIAL_RAIL_POLL_MS',
    ),
  });
}

export function redactedPublicSocialTestRailErrorClass(error: unknown): string {
  return error instanceof Error && SAFE_ERROR_CLASSES.has(error.name) ? error.name : 'Error';
}

function readinessFor(config: PublicSocialTestRailConfig): PublicSocialTestRailReadiness {
  return Object.freeze({
    schemaVersion: 1,
    event: 'ready',
    service: PUBLIC_SOCIAL_TEST_RAIL_SERVICE,
    environment: 'test',
    providerId: PUBLIC_SOCIAL_TEST_PROVIDER_ID,
    databaseRole: PUBLIC_SOCIAL_TEST_RAIL_DATABASE_ROLE,
    polling: Object.freeze({
      intervalMs: config.pollIntervalMs,
      maximumOperationsPerCycle: 1,
      leaseSeconds: LEASE_SECONDS,
      overlappingCycles: false,
    }),
    safety: Object.freeze({
      providerEffectsEnabled: false,
      emergencyPaused: true,
      reservedAccountsOnly: true,
      liveProviderAdapterLoaded: false,
      externalPublishAttempted: false,
    }),
  });
}

function defaultDispatcher(pool: WorkerPool): Dispatcher {
  return new PublicSocialTestDispatcher({
    queue: new PgPublicSocialTestQueue(pool),
    provider: new DeterministicPublicSocialTestProvider({ auditCapacity: 0 }),
  });
}

export async function startPublicSocialTestRailRunner(
  dependencies: PublicSocialTestRailDependencies = {},
): Promise<PublicSocialTestRailRuntime> {
  const env = dependencies.env ?? process.env;
  const config = loadPublicSocialTestRailConfig(env);
  const createPool = dependencies.createPool ?? createPublicSocialWorkerCommandDatabasePool;
  const assertSchemaCurrent = dependencies.assertSchemaCurrent ?? assertRuntimeSchemaCurrent;
  const assertInstallationReady = dependencies.assertInstallationReady
    ?? assertExpectedDatabaseInstallation;
  const writeReadiness = dependencies.writeReadiness
    ?? ((line: string) => { process.stdout.write(line); });
  const onCycle = dependencies.onCycle ?? (() => undefined);
  const onCycleError = dependencies.onCycleError
    ?? ((errorClass: string) => { process.stderr.write(`Public-social TEST rail cycle failed (${errorClass})\n`); });
  const onBackgroundDatabaseError = dependencies.onBackgroundDatabaseError
    ?? ((errorClass: string) => { process.stderr.write(`Public-social TEST rail database error (${errorClass})\n`); });

  const pool = createPool(env, {
    onBackgroundError: (error) => {
      onBackgroundDatabaseError(redactedPublicSocialTestRailErrorClass(error));
    },
  });
  try {
    await assertSchemaCurrent(pool);
    await assertInstallationReady(pool, config.installationId);
  } catch (error) {
    try {
      await pool.end();
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Public-social readiness and shutdown both failed');
    }
    throw error;
  }

  let dispatcher: Dispatcher;
  let lease: PublicSocialTestLeaseIdentity;
  try {
    dispatcher = (dependencies.createDispatcher ?? defaultDispatcher)(pool);
    lease = (dependencies.createLease ?? (() => Object.freeze({
      workerId: randomUUID(),
      leaseToken: randomBytes(32),
    })))();
    if (!UUID.test(lease.workerId) || Buffer.from(lease.leaseToken).length !== 32) {
      throw new Error('Public-social TEST rail lease identity is invalid');
    }
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  const readiness = readinessFor(config);
  try {
    writeReadiness(`${JSON.stringify(readiness)}\n`);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<PublicSocialTestDispatchCycleResult> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });

  const executeCycle = (): Promise<PublicSocialTestDispatchCycleResult> => {
    if (stopping) return Promise.reject(new Error('Public-social TEST rail is stopping'));
    if (inFlight) return inFlight;
    inFlight = dispatcher.runOnce(lease).finally(() => { inFlight = undefined; });
    return inFlight;
  };

  const schedule = (delayMs: number): void => {
    if (stopping) return;
    timer = setTimeout(() => {
      timer = undefined;
      void executeCycle()
        .then(onCycle)
        .catch((error: unknown) => {
          onCycleError(redactedPublicSocialTestRailErrorClass(error));
        })
        .finally(() => { schedule(config.pollIntervalMs); });
    }, delayMs);
  };
  if (dependencies.autoStart !== false) schedule(0);

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    if (timer) clearTimeout(timer);
    shutdownPromise = (async () => {
      let cycleError: unknown;
      try {
        await inFlight;
      } catch (error) {
        cycleError = error;
      }
      try {
        await pool.end();
      } catch (closeError) {
        if (cycleError !== undefined) {
          throw new AggregateError([cycleError, closeError], 'Public-social cycle and shutdown both failed');
        }
        throw closeError;
      }
      if (cycleError !== undefined) throw cycleError;
    })().finally(() => { resolveStopped?.(); });
    return shutdownPromise;
  };

  return Object.freeze({ readiness, stopped, runOnce: executeCycle, shutdown });
}
