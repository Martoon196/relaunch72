import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { assertExpectedDatabaseInstallation } from '../../db/installation-identity.js';
import { createWorkerDatabasePool } from '../../db/pool.js';
import { assertRuntimeSchemaCurrent } from '../../db/runtime-readiness.js';
import {
  InboxProviderDispatcher,
  PgInboxDispatchReader,
  type InboxDispatchCycleResult,
} from '../../inbox-pg/dispatcher.js';
import { TestConversationProvider } from '../../inbox-pg/test-provider.js';
import { PgProviderOperationQueue } from '../../provider-operations-pg/queue.js';
import type { ProviderOperationLeaseIdentity } from '../../provider-operations-pg/types.js';

export const OMNICHANNEL_TEST_RAIL_SERVICE = 'property-predator-omnichannel-test-rail';
export const OMNICHANNEL_TEST_RAIL_PROVIDER = 'test_conversation';
export const OMNICHANNEL_TEST_RAIL_DATABASE_ROLE = 'r72_worker';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MINIMUM_POLL_INTERVAL_MS = 100;
const MAXIMUM_POLL_INTERVAL_MS = 60_000;
const LEASE_SECONDS = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_ERROR_CLASSES = new Set([
  'Error', 'AggregateError', 'TypeError', 'RangeError', 'DatabaseError', 'ConnectionError',
]);
const FORBIDDEN_CREDENTIAL_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|BEARER_?TOKEN|OAUTH_?TOKEN|REFRESH_?TOKEN|CLIENT_?SECRET|APP_?SECRET|SIGNING_?KEY|WEBHOOK_?SECRET|PRIVATE_?KEY|SERVER_?TOKEN|BOT_?TOKEN|PASSWORD|CREDENTIALS?|SECRET|TOKEN|KEY)$/;

type WorkerPool = Pick<Pool, 'query' | 'connect' | 'end'>;
type Dispatcher = Pick<InboxProviderDispatcher, 'runOnce'>;

export interface OmnichannelTestRailConfig {
  readonly pollIntervalMs: number;
  readonly installationId: string;
}

export interface OmnichannelTestRailReadiness {
  readonly schemaVersion: 1;
  readonly event: 'ready';
  readonly service: typeof OMNICHANNEL_TEST_RAIL_SERVICE;
  readonly environment: 'test';
  readonly providerId: typeof OMNICHANNEL_TEST_RAIL_PROVIDER;
  readonly databaseRole: typeof OMNICHANNEL_TEST_RAIL_DATABASE_ROLE;
  readonly polling: Readonly<{
    intervalMs: number;
    maximumOperationsPerCycle: 1;
    leaseSeconds: typeof LEASE_SECONDS;
    overlappingCycles: false;
  }>;
  readonly safety: Readonly<{
    providerEffectsEnabled: false;
    emergencyPaused: true;
    reservedDestinationsOnly: true;
    liveProviderAdapterLoaded: false;
  }>;
}

export interface OmnichannelTestRailRuntime {
  readonly readiness: OmnichannelTestRailReadiness;
  readonly stopped: Promise<void>;
  /** Run one bounded cycle. Concurrent callers share the same in-flight cycle. */
  runOnce(): Promise<InboxDispatchCycleResult>;
  /** Idempotently stop polling, drain the in-flight cycle, then close PostgreSQL. */
  shutdown(): Promise<void>;
}

export interface OmnichannelTestRailDependencies {
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
  readonly createLease?: () => ProviderOperationLeaseIdentity;
  readonly writeReadiness?: (line: string) => void;
  readonly onCycle?: (result: InboxDispatchCycleResult) => void;
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

function assertOnlyWorkerDatabaseIdentity(env: NodeJS.ProcessEnv): void {
  if (!env.DATABASE_WORKER_URL?.trim()) {
    throw new Error('DATABASE_WORKER_URL is required for the omnichannel test rail');
  }
  const configuredDatabaseUrls = Object.keys(env).filter((name) =>
    Boolean(env[name]?.trim())
      && (name === 'DATABASE_URL'
        || name === 'TEST_DATABASE_URL'
        || /^DATABASE_[A-Z0-9_]+_URL$/.test(name)));
  if (configuredDatabaseUrls.some((name) => name !== 'DATABASE_WORKER_URL')) {
    throw new Error('Omnichannel test rail received a database identity outside r72_worker');
  }
}

function assertNoLiveProviderCredentials(env: NodeJS.ProcessEnv): void {
  if (Object.keys(env).some((name) =>
    name !== 'DATABASE_WORKER_URL'
      && Boolean(env[name]?.trim())
      && FORBIDDEN_CREDENTIAL_NAME.test(name))) {
    throw new Error('Omnichannel test rail received a credential outside its worker database identity');
  }
}

/** Parse the deliberately narrow process boundary before any pool is created. */
export function loadOmnichannelTestRailConfig(
  env: NodeJS.ProcessEnv,
): OmnichannelTestRailConfig {
  if (env.PROPERTY_PREDATOR_OMNICHANNEL_RAIL_ENVIRONMENT !== 'test') {
    throw new Error('Omnichannel test rail requires environment=test');
  }
  if (env.PROPERTY_PREDATOR_OMNICHANNEL_RAIL_PROVIDER_ID !== OMNICHANNEL_TEST_RAIL_PROVIDER) {
    throw new Error('Omnichannel test rail requires provider_id=test_conversation');
  }
  if (env.PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED !== 'false') {
    throw new Error('Omnichannel test rail requires provider effects to be exactly false');
  }
  if (env.PROPERTY_PREDATOR_EMAIL_EMERGENCY_PAUSED !== 'true') {
    throw new Error('Omnichannel test rail requires the emergency pause to be engaged');
  }
  assertOnlyWorkerDatabaseIdentity(env);
  assertNoLiveProviderCredentials(env);
  const installationId = env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID?.trim() ?? '';
  if (!UUID.test(installationId)) {
    throw new Error('Omnichannel test rail requires the database installation identity');
  }
  return Object.freeze({
    installationId,
    pollIntervalMs: boundedInteger(
      env.PROPERTY_PREDATOR_OMNICHANNEL_RAIL_POLL_MS,
      DEFAULT_POLL_INTERVAL_MS,
      MINIMUM_POLL_INTERVAL_MS,
      MAXIMUM_POLL_INTERVAL_MS,
      'PROPERTY_PREDATOR_OMNICHANNEL_RAIL_POLL_MS',
    ),
  });
}

/** Reduce database/provider-shaped failures to a fixed telemetry token. */
export function redactedOmnichannelTestRailErrorClass(error: unknown): string {
  return error instanceof Error && SAFE_ERROR_CLASSES.has(error.name) ? error.name : 'Error';
}

function readinessFor(config: OmnichannelTestRailConfig): OmnichannelTestRailReadiness {
  return Object.freeze({
    schemaVersion: 1,
    event: 'ready',
    service: OMNICHANNEL_TEST_RAIL_SERVICE,
    environment: 'test',
    providerId: OMNICHANNEL_TEST_RAIL_PROVIDER,
    databaseRole: OMNICHANNEL_TEST_RAIL_DATABASE_ROLE,
    polling: Object.freeze({
      intervalMs: config.pollIntervalMs,
      maximumOperationsPerCycle: 1,
      leaseSeconds: LEASE_SECONDS,
      overlappingCycles: false,
    }),
    safety: Object.freeze({
      providerEffectsEnabled: false,
      emergencyPaused: true,
      reservedDestinationsOnly: true,
      liveProviderAdapterLoaded: false,
    }),
  });
}

function defaultDispatcher(pool: WorkerPool): Dispatcher {
  return new InboxProviderDispatcher({
    queue: new PgProviderOperationQueue(pool),
    reader: new PgInboxDispatchReader(pool),
    provider: new TestConversationProvider(),
  });
}

/**
 * Start the isolated test-only rail.
 *
 * The only external connection is PostgreSQL through r72_worker. Each serial
 * cycle claims at most one durable operation; the existing dispatcher then
 * rechecks consent, crosses its fenced calling boundary and settles the
 * in-process TestConversationProvider result. That provider accepts only
 * reserved, non-routable destinations and performs no network work.
 */
export async function startOmnichannelTestRailRunner(
  dependencies: OmnichannelTestRailDependencies = {},
): Promise<OmnichannelTestRailRuntime> {
  const env = dependencies.env ?? process.env;
  const config = loadOmnichannelTestRailConfig(env);
  const createPool = dependencies.createPool ?? createWorkerDatabasePool;
  const assertSchemaCurrent = dependencies.assertSchemaCurrent ?? assertRuntimeSchemaCurrent;
  const assertInstallationReady = dependencies.assertInstallationReady
    ?? assertExpectedDatabaseInstallation;
  const writeReadiness = dependencies.writeReadiness
    ?? ((line: string) => { process.stdout.write(line); });
  const onCycle = dependencies.onCycle ?? (() => undefined);
  const onCycleError = dependencies.onCycleError
    ?? ((errorClass: string) => { process.stderr.write(`Test rail cycle failed (${errorClass})\n`); });
  const onBackgroundDatabaseError = dependencies.onBackgroundDatabaseError
    ?? ((errorClass: string) => {
      process.stderr.write(`Test rail database connection error (${errorClass})\n`);
    });
  const pool = createPool(env, {
    onBackgroundError: (error) => {
      onBackgroundDatabaseError(redactedOmnichannelTestRailErrorClass(error));
    },
  });

  try {
    await assertSchemaCurrent(pool);
    await assertInstallationReady(pool, config.installationId);
  } catch (error) {
    try {
      await pool.end();
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Test rail readiness and shutdown both failed');
    }
    throw error;
  }

  let dispatcher: Dispatcher;
  let lease: ProviderOperationLeaseIdentity;
  try {
    dispatcher = (dependencies.createDispatcher ?? defaultDispatcher)(pool);
    lease = (dependencies.createLease ?? (() => Object.freeze({
      workerId: randomUUID(),
      leaseToken: randomBytes(32),
    })))();
    if (!UUID.test(lease.workerId) || Buffer.from(lease.leaseToken).length !== 32) {
      throw new Error('Omnichannel test rail lease identity is invalid');
    }
  } catch (error) {
    try {
      await pool.end();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'Test rail composition and database shutdown both failed',
      );
    }
    throw error;
  }

  const readiness = readinessFor(config);
  try {
    writeReadiness(`${JSON.stringify(readiness)}\n`);
  } catch (error) {
    try {
      await pool.end();
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Test rail output and shutdown both failed');
    }
    throw error;
  }

  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<InboxDispatchCycleResult> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });

  const executeCycle = (): Promise<InboxDispatchCycleResult> => {
    if (stopping) return Promise.reject(new Error('Omnichannel test rail is stopping'));
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
          onCycleError(redactedOmnichannelTestRailErrorClass(error));
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
          throw new AggregateError(
            [cycleError, closeError],
            'Test rail cycle and database shutdown both failed',
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
