import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  createPropertyPredatorApprovedResourceTransport,
  type PropertyPredatorApprovedResourceTransport,
} from '../../company-content-adapter/property-predator-resources.js';
import { assertExpectedDatabaseInstallation } from '../../db/installation-identity.js';
import {
  createPublicSocialRevalidatorCommandDatabasePool,
} from '../../db/pool.js';
import { assertRuntimeSchemaCurrent } from '../../db/runtime-readiness.js';
import {
  PublicSocialJitRevalidator,
  type PublicSocialRevalidationCycleResult,
} from './dispatcher.js';
import {
  PgPublicSocialRevalidationQueue,
  type PublicSocialRevalidationLease,
} from './queue.js';
import { PgPropertyPredatorJitSourceAttestor } from './source-attestor.js';

export const PUBLIC_SOCIAL_REVALIDATOR_SERVICE =
  'property-predator-public-social-revalidator';
export const PUBLIC_SOCIAL_REVALIDATOR_DATABASE_ROLE =
  'r72_public_social_revalidator_command';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MINIMUM_POLL_INTERVAL_MS = 100;
const MAXIMUM_POLL_INTERVAL_MS = 60_000;
const DEFAULT_SOURCE_TIMEOUT_MS = 8_000;
// One plan can contain its main copy plus ten approved media resources. Each
// resource read is bounded independently, so this covers the full sequential
// verification pass rather than only one HTTP deadline.
const LEASE_SECONDS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_ERROR_CLASSES = new Set([
  'Error', 'AggregateError', 'TypeError', 'RangeError',
  'DatabaseError', 'ConnectionError', 'PropertyPredatorContentContractError',
]);
const FORBIDDEN_CREDENTIAL_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|BEARER_?TOKEN|OAUTH_?TOKEN|REFRESH_?TOKEN|CLIENT_?SECRET|APP_?SECRET|SIGNING_?KEY|WEBHOOK_?SECRET|PRIVATE_?KEY|SERVER_?TOKEN|BOT_?TOKEN|PASSWORD|CREDENTIALS?|SECRET|TOKEN|KEY)(?:_|$)/u;
const ALLOWED_SECRET_NAMES = new Set([
  'PROPERTY_PREDATOR_COMPANY_CONTENT_READ_TOKEN',
]);
const ALLOWED_DATABASE_URLS = new Set([
  'DATABASE_PUBLIC_SOCIAL_REVALIDATOR_URL',
]);
const FORBIDDEN_HUMAN_ACTOR_NAME =
  /^PROPERTY_PREDATOR_PUBLIC_SOCIAL_REVALIDATOR_(?:USER|ACTOR)_ID$/u;

type RuntimePool = Pick<Pool, 'query' | 'connect' | 'end'>;
type Revalidator = Pick<PublicSocialJitRevalidator, 'runOnce'>;

export interface PublicSocialRevalidatorConfig {
  readonly installationId: string;
  readonly sourceOrigin: string;
  readonly sourceClientId: string;
  readonly sourceReadToken: string;
  readonly sourceTimeoutMs: number;
  readonly allowLocalHttp: boolean;
  readonly pollIntervalMs: number;
}

export interface PublicSocialRevalidatorReadiness {
  readonly schemaVersion: 1;
  readonly event: 'ready';
  readonly service: typeof PUBLIC_SOCIAL_REVALIDATOR_SERVICE;
  readonly environment: 'test';
  readonly databaseRoles: readonly [typeof PUBLIC_SOCIAL_REVALIDATOR_DATABASE_ROLE];
  readonly polling: Readonly<{
    intervalMs: number;
    maximumJobsPerCycle: 1;
    leaseSeconds: typeof LEASE_SECONDS;
    overlappingCycles: false;
  }>;
  readonly safety: Readonly<{
    providerEffectsEnabled: false;
    emergencyPaused: true;
    sourceTransportReadOnly: true;
    systemProofsLeaseBound: true;
    liveProviderAdapterLoaded: false;
    externalPublishAttempted: false;
  }>;
}

export interface PublicSocialRevalidatorRuntime {
  readonly readiness: PublicSocialRevalidatorReadiness;
  readonly stopped: Promise<void>;
  runOnce(): Promise<PublicSocialRevalidationCycleResult>;
  shutdown(): Promise<void>;
}

export interface PublicSocialRevalidatorRunnerDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly autoStart?: boolean;
  readonly createRevalidatorPool?: (
    env: NodeJS.ProcessEnv,
    hooks: Readonly<{ onBackgroundError: (error: Error) => void }>,
  ) => RuntimePool;
  readonly createTransport?: (
    config: PublicSocialRevalidatorConfig,
  ) => PropertyPredatorApprovedResourceTransport;
  readonly createRevalidator?: (
    revalidatorPool: RuntimePool,
    transport: PropertyPredatorApprovedResourceTransport,
  ) => Revalidator;
  readonly createLease?: () => PublicSocialRevalidationLease;
  readonly assertSchemaCurrent?: (pool: Pick<Pool, 'query'>) => Promise<void>;
  readonly assertInstallationReady?: (
    pool: Pick<Pool, 'query'>,
    expectedInstallationId: string | undefined,
  ) => Promise<void>;
  readonly writeReadiness?: (line: string) => void;
  readonly onCycle?: (result: PublicSocialRevalidationCycleResult) => void;
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

function exactUuid(raw: string | undefined, label: string): string {
  const value = raw?.trim().toLowerCase() ?? '';
  if (!UUID.test(value)) throw new Error(`${label} must be a UUID`);
  return value;
}

function required(raw: string | undefined, label: string): string {
  const value = raw?.trim() ?? '';
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function exactPropertyPredatorSourceOrigin(
  raw: string | undefined,
  allowLocalHttp: boolean,
): string {
  const value = required(raw, 'PROPERTY_PREDATOR_COMPANY_CONTENT_ORIGIN');
  if (value === 'https://propertypredator.com') return value;
  if (allowLocalHttp && /^http:\/\/(?:127\.0\.0\.1|localhost)(?::[1-9][0-9]{0,4})?$/u.test(value)) {
    return value;
  }
  throw new Error('Company-content source must be the exact propertypredator.com origin');
}

function assertExactDatabaseIdentities(env: NodeJS.ProcessEnv): void {
  for (const requiredName of ALLOWED_DATABASE_URLS) {
    if (!env[requiredName]?.trim()) throw new Error(`${requiredName} is required`);
  }
  const configured = Object.keys(env).filter((name) => {
    const normalized = name.toUpperCase();
    return Boolean(env[name]?.trim())
      && (normalized === 'DATABASE_URL' || normalized === 'TEST_DATABASE_URL'
        || /^DATABASE_[A-Z0-9_]+_URL$/u.test(normalized));
  });
  if (configured.some((name) => !ALLOWED_DATABASE_URLS.has(name.toUpperCase()))) {
    throw new Error('Public-social revalidator received a database identity outside its exact role');
  }
}

function assertNoProviderCredentials(env: NodeJS.ProcessEnv): void {
  if (Object.keys(env).some((name) => {
    const normalized = name.toUpperCase();
    return Boolean(env[name]?.trim())
      && !ALLOWED_SECRET_NAMES.has(normalized)
      && !ALLOWED_DATABASE_URLS.has(normalized)
      && FORBIDDEN_CREDENTIAL_NAME.test(normalized);
  })) {
    throw new Error('Public-social revalidator received a provider or unrelated credential');
  }
}

export function loadPublicSocialRevalidatorConfig(
  env: NodeJS.ProcessEnv,
): PublicSocialRevalidatorConfig {
  if (env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_REVALIDATOR_ENVIRONMENT !== 'test') {
    throw new Error('Public-social revalidator requires environment=test');
  }
  if (env.PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED !== 'false') {
    throw new Error('Public-social revalidator requires provider effects to be exactly false');
  }
  if (env.PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED !== 'true') {
    throw new Error('Public-social revalidator requires the external-effects emergency pause');
  }
  if (Object.keys(env).some((name) => FORBIDDEN_HUMAN_ACTOR_NAME.test(name)
      && Boolean(env[name]?.trim()))) {
    throw new Error('Public-social revalidator forbids a configured human actor');
  }
  assertExactDatabaseIdentities(env);
  assertNoProviderCredentials(env);
  const allowLocalHttp = env.PROPERTY_PREDATOR_COMPANY_CONTENT_ALLOW_LOCAL_HTTP === 'true';
  if (allowLocalHttp && env.NODE_ENV?.trim().toLowerCase() === 'production') {
    throw new Error('Local HTTP source transport is forbidden in production');
  }
  return Object.freeze({
    installationId: exactUuid(
      env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID,
      'PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID',
    ),
    sourceOrigin: exactPropertyPredatorSourceOrigin(
      env.PROPERTY_PREDATOR_COMPANY_CONTENT_ORIGIN,
      allowLocalHttp,
    ),
    sourceClientId: required(
      env.PROPERTY_PREDATOR_COMPANY_CONTENT_CLIENT_ID,
      'PROPERTY_PREDATOR_COMPANY_CONTENT_CLIENT_ID',
    ),
    sourceReadToken: required(
      env.PROPERTY_PREDATOR_COMPANY_CONTENT_READ_TOKEN,
      'PROPERTY_PREDATOR_COMPANY_CONTENT_READ_TOKEN',
    ),
    sourceTimeoutMs: boundedInteger(
      env.PROPERTY_PREDATOR_COMPANY_CONTENT_TIMEOUT_MS,
      DEFAULT_SOURCE_TIMEOUT_MS,
      100,
      10_000,
      'PROPERTY_PREDATOR_COMPANY_CONTENT_TIMEOUT_MS',
    ),
    allowLocalHttp,
    pollIntervalMs: boundedInteger(
      env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_REVALIDATOR_POLL_MS,
      DEFAULT_POLL_INTERVAL_MS,
      MINIMUM_POLL_INTERVAL_MS,
      MAXIMUM_POLL_INTERVAL_MS,
      'PROPERTY_PREDATOR_PUBLIC_SOCIAL_REVALIDATOR_POLL_MS',
    ),
  });
}

export function redactedPublicSocialRevalidatorErrorClass(error: unknown): string {
  return error instanceof Error && SAFE_ERROR_CLASSES.has(error.name)
    ? error.name : 'Error';
}

function readinessFor(config: PublicSocialRevalidatorConfig): PublicSocialRevalidatorReadiness {
  return Object.freeze({
    schemaVersion: 1,
    event: 'ready',
    service: PUBLIC_SOCIAL_REVALIDATOR_SERVICE,
    environment: 'test',
    databaseRoles: Object.freeze([
      PUBLIC_SOCIAL_REVALIDATOR_DATABASE_ROLE,
    ] as const),
    polling: Object.freeze({
      intervalMs: config.pollIntervalMs,
      maximumJobsPerCycle: 1,
      leaseSeconds: LEASE_SECONDS,
      overlappingCycles: false,
    }),
    safety: Object.freeze({
      providerEffectsEnabled: false,
      emergencyPaused: true,
      sourceTransportReadOnly: true,
      systemProofsLeaseBound: true,
      liveProviderAdapterLoaded: false,
      externalPublishAttempted: false,
    }),
  });
}

function defaultTransport(
  config: PublicSocialRevalidatorConfig,
): PropertyPredatorApprovedResourceTransport {
  return createPropertyPredatorApprovedResourceTransport({
    baseUrl: config.sourceOrigin,
    clientId: config.sourceClientId,
    readToken: config.sourceReadToken,
    timeoutMs: config.sourceTimeoutMs,
    allowLocalHttp: config.allowLocalHttp,
  });
}

function defaultRevalidator(
  revalidatorPool: RuntimePool,
  transport: PropertyPredatorApprovedResourceTransport,
): Revalidator {
  return new PublicSocialJitRevalidator({
    queue: new PgPublicSocialRevalidationQueue(revalidatorPool),
    attestor: new PgPropertyPredatorJitSourceAttestor({
      pool: revalidatorPool,
      transport,
    }),
  });
}

async function closePools(pools: readonly RuntimePool[]): Promise<void> {
  const results = await Promise.allSettled(pools.map((pool) => pool.end()));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Revalidator pool shutdown failed');
}

export async function startPublicSocialRevalidatorRunner(
  dependencies: PublicSocialRevalidatorRunnerDependencies = {},
): Promise<PublicSocialRevalidatorRuntime> {
  const env = dependencies.env ?? process.env;
  const config = loadPublicSocialRevalidatorConfig(env);
  const onBackgroundDatabaseError = dependencies.onBackgroundDatabaseError
    ?? ((errorClass: string) => {
      process.stderr.write(`Public-social revalidator database error (${errorClass})\n`);
    });
  const hooks = {
    onBackgroundError: (error: Error) => {
      onBackgroundDatabaseError(redactedPublicSocialRevalidatorErrorClass(error));
    },
  };
  const createRevalidatorPool = dependencies.createRevalidatorPool
    ?? createPublicSocialRevalidatorCommandDatabasePool;
  const pools: RuntimePool[] = [];
  try {
    pools.push(createRevalidatorPool(env, hooks));
  } catch (error) {
    await closePools(pools).catch(() => undefined);
    throw error;
  }
  const [revalidatorPool] = pools as [RuntimePool];
  const assertSchemaCurrent = dependencies.assertSchemaCurrent ?? assertRuntimeSchemaCurrent;
  const assertInstallationReady = dependencies.assertInstallationReady
    ?? assertExpectedDatabaseInstallation;
  try {
    for (const pool of pools) {
      await assertSchemaCurrent(pool);
      await assertInstallationReady(pool, config.installationId);
    }
  } catch (error) {
    await closePools(pools).catch(() => undefined);
    throw error;
  }

  let revalidator: Revalidator;
  let lease: PublicSocialRevalidationLease;
  try {
    const transport = (dependencies.createTransport ?? defaultTransport)(config);
    revalidator = (dependencies.createRevalidator ?? defaultRevalidator)(
      revalidatorPool,
      transport,
    );
    lease = (dependencies.createLease ?? (() => Object.freeze({
      workerId: randomUUID(),
      token: randomBytes(32),
    })))();
    if (!UUID.test(lease.workerId) || Buffer.from(lease.token).byteLength !== 32) {
      throw new Error('Public-social revalidator lease identity is invalid');
    }
  } catch (error) {
    await closePools(pools).catch(() => undefined);
    throw error;
  }

  const readiness = readinessFor(config);
  const writeReadiness = dependencies.writeReadiness
    ?? ((line: string) => { process.stdout.write(line); });
  try {
    writeReadiness(`${JSON.stringify(readiness)}\n`);
  } catch (error) {
    await closePools(pools).catch(() => undefined);
    throw error;
  }
  const onCycle = dependencies.onCycle ?? (() => undefined);
  const onCycleError = dependencies.onCycleError
    ?? ((errorClass: string) => {
      process.stderr.write(`Public-social revalidation cycle failed (${errorClass})\n`);
    });
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<PublicSocialRevalidationCycleResult> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });

  const executeCycle = (): Promise<PublicSocialRevalidationCycleResult> => {
    if (stopping) return Promise.reject(new Error('Public-social revalidator is stopping'));
    if (inFlight) return inFlight;
    inFlight = revalidator.runOnce(lease).finally(() => { inFlight = undefined; });
    return inFlight;
  };
  const schedule = (delayMs: number): void => {
    if (stopping) return;
    timer = setTimeout(() => {
      timer = undefined;
      void executeCycle()
        .then(onCycle)
        .catch((error: unknown) => {
          onCycleError(redactedPublicSocialRevalidatorErrorClass(error));
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
      try { await inFlight; } catch (error) { cycleError = error; }
      try { await closePools(pools); }
      catch (closeError) {
        if (cycleError !== undefined) {
          throw new AggregateError(
            [cycleError, closeError],
            'Revalidation cycle and pool shutdown both failed',
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
