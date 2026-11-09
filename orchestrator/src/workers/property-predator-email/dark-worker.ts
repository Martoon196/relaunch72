import type { Pool } from 'pg';
import { createMailgunWorkerCommandDatabasePool } from '../../db/pool.js';
import { assertRuntimeSchemaCurrent } from '../../db/runtime-readiness.js';
import { assertExpectedDatabaseInstallation } from '../../db/installation-identity.js';
import { assertPropertyPredatorEmailPilotBoundaryReady } from '../../property-predator-email-pilot-pg/index.js';
import {
  loadPropertyPredatorEmailPilotPolicy,
  type PropertyPredatorEmailPilotPolicy,
} from '../../providers/property-predator-email-pilot-config.js';

export const PROPERTY_PREDATOR_DARK_EMAIL_WORKER_SERVICE =
  'property-predator-email-worker';
export const PROPERTY_PREDATOR_MAILGUN_WORKER_DATABASE_ROLE =
  'r72_mailgun_worker_command';

const SAFE_ERROR_CLASSES = new Set([
  'Error',
  'AggregateError',
  'TypeError',
  'RangeError',
  'DatabaseError',
  'ConnectionError',
]);

const FORBIDDEN_PROCESS_SECRET_NAMES = Object.freeze([
  'MAILGUN_SIGNING_KEY',
  'SESSION_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'POSTMARK_SERVER_TOKEN',
  'BREVO_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
]);

type DarkWorkerPool = Pick<Pool, 'query' | 'end'>;

export interface PropertyPredatorDarkEmailWorkerReadiness {
  readonly schemaVersion: 1;
  readonly event: 'ready';
  readonly service: typeof PROPERTY_PREDATOR_DARK_EMAIL_WORKER_SERVICE;
  readonly mode: 'dark-production';
  readonly database: Readonly<{
    role: typeof PROPERTY_PREDATOR_MAILGUN_WORKER_DATABASE_ROLE;
    boundaryReady: true;
  }>;
  readonly safety: Readonly<{
    providerEffectsEnabled: false;
    emailDeliveryEnabled: false;
    emergencyPaused: true;
    dispatchLoopStarted: false;
    providerAdapterInstantiated: false;
    providerNetworkCallsMade: false;
  }>;
  readonly pilot: Readonly<{
    stage: PropertyPredatorEmailPilotPolicy['stage'];
    recipientScope: PropertyPredatorEmailPilotPolicy['recipientScope'];
    maximumRecipients: number;
    configuredRecipientCount: number;
    maximumMessagesPerRun: number;
    maximumMessagesPerUtcMonth: number;
    maximumSpendUsdMicrosPerRun: number;
    maximumSpendUsdMicrosPerUtcMonth: number;
  }>;
}

export interface PropertyPredatorDarkEmailWorkerRuntime {
  readonly readiness: PropertyPredatorDarkEmailWorkerReadiness;
  /** Settles only after shutdown has been requested and the database pool closed. */
  readonly stopped: Promise<void>;
  /** Idempotent, graceful shutdown. The reason is deliberately never logged. */
  shutdown(): Promise<void>;
}

export interface PropertyPredatorDarkEmailWorkerDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly createPool?: (
    env: NodeJS.ProcessEnv,
    hooks: Readonly<{ onBackgroundError: (error: Error) => void }>,
  ) => DarkWorkerPool;
  readonly assertBoundaryReady?: (pool: Pick<Pool, 'query'>) => Promise<void>;
  readonly assertSchemaCurrent?: (pool: Pick<Pool, 'query'>) => Promise<void>;
  readonly assertInstallationReady?: (
    pool: Pick<Pool, 'query'>,
    expectedInstallationId: string | undefined,
  ) => Promise<void>;
  readonly writeReadiness?: (line: string) => void;
  readonly onBackgroundDatabaseError?: (errorName: string) => void;
  readonly keepAliveIntervalMs?: number;
}

function requireExplicitDarkSwitches(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'production') {
    throw new Error('Dark email worker requires NODE_ENV=production');
  }
  if (env.PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED !== 'false') {
    throw new Error('Dark email worker requires provider effects to be explicitly disabled');
  }
  if (env.PROPERTY_PREDATOR_EMAIL_DELIVERY_ENABLED !== 'false') {
    throw new Error('Dark email worker requires email delivery to be explicitly disabled');
  }
  if (env.PROPERTY_PREDATOR_EMAIL_EMERGENCY_PAUSED !== 'true') {
    throw new Error('Dark email worker requires the emergency pause to be explicitly enabled');
  }
  if (!env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID?.trim()) {
    throw new Error('Dark email worker requires the database installation identity');
  }
}

function assertIsolatedDatabaseEnvironment(env: NodeJS.ProcessEnv): void {
  if (!env.DATABASE_MAILGUN_WORKER_URL?.trim()) {
    throw new Error('DATABASE_MAILGUN_WORKER_URL is required for the dark email worker');
  }
  const databaseUrls = Object.keys(env).filter((name) =>
    Boolean(env[name]?.trim())
      && (name === 'DATABASE_URL'
        || name === 'TEST_DATABASE_URL'
        || /^DATABASE_[A-Z0-9_]+_URL$/.test(name)));
  const forbidden = databaseUrls.filter((name) => name !== 'DATABASE_MAILGUN_WORKER_URL');
  if (forbidden.length > 0) {
    throw new Error('Dark email worker received a database identity outside its isolated role');
  }
}

function assertIsolatedProcessSecrets(env: NodeJS.ProcessEnv): void {
  // DATABASE_SSL_CA is deliberately allowed: a private CA bundle can be
  // required for verify-full TLS and does not grant another application role.
  if (FORBIDDEN_PROCESS_SECRET_NAMES.some((name) => Boolean(env[name]?.trim()))) {
    throw new Error('Dark email worker received a secret owned by another process');
  }
}

/** Reduce a potentially provider-authored error object to a fixed safe token. */
export function redactedDarkEmailWorkerErrorClass(error: unknown): string {
  return error instanceof Error && SAFE_ERROR_CLASSES.has(error.name)
    ? error.name
    : 'Error';
}

function darkPolicy(env: NodeJS.ProcessEnv): PropertyPredatorEmailPilotPolicy {
  requireExplicitDarkSwitches(env);
  assertIsolatedDatabaseEnvironment(env);
  assertIsolatedProcessSecrets(env);
  const policy = loadPropertyPredatorEmailPilotPolicy(env);
  if (policy.providerEffectsEnabled !== false
      || policy.emailDeliveryEnabled !== false
      || policy.emergencyPaused !== true) {
    throw new Error('Dark email worker policy is not fail-closed');
  }
  return policy;
}

function readinessFor(
  policy: PropertyPredatorEmailPilotPolicy,
): PropertyPredatorDarkEmailWorkerReadiness {
  return Object.freeze({
    schemaVersion: 1,
    event: 'ready',
    service: PROPERTY_PREDATOR_DARK_EMAIL_WORKER_SERVICE,
    mode: 'dark-production',
    database: Object.freeze({
      role: PROPERTY_PREDATOR_MAILGUN_WORKER_DATABASE_ROLE,
      boundaryReady: true,
    }),
    safety: Object.freeze({
      providerEffectsEnabled: false,
      emailDeliveryEnabled: false,
      emergencyPaused: true,
      dispatchLoopStarted: false,
      providerAdapterInstantiated: false,
      providerNetworkCallsMade: false,
    }),
    pilot: Object.freeze({
      stage: policy.stage,
      recipientScope: policy.recipientScope,
      maximumRecipients: policy.maxRecipients,
      configuredRecipientCount: policy.internalSeedAllowlist.length,
      maximumMessagesPerRun: policy.maxMessagesPerRun,
      maximumMessagesPerUtcMonth: policy.maxMessagesPerUtcMonth,
      maximumSpendUsdMicrosPerRun: policy.maxSpendUsdMicrosPerRun,
      maximumSpendUsdMicrosPerUtcMonth: policy.maxSpendUsdMicrosPerUtcMonth,
    }),
  });
}

/**
 * Start the first-deploy worker in deliberately dark mode.
 *
 * This composition owns no dispatch loop and imports no provider transport.
 * Its only external connection is the function-only worker PostgreSQL role,
 * used once to prove the exact installed pilot boundary. The separately
 * composed live worker is loaded only when the CLI receives its exact
 * action-time mode and that worker independently proves every live switch,
 * recipient cap, credential scope and database boundary before polling.
 */
export async function startPropertyPredatorDarkEmailWorker(
  dependencies: PropertyPredatorDarkEmailWorkerDependencies = {},
): Promise<PropertyPredatorDarkEmailWorkerRuntime> {
  const env = dependencies.env ?? process.env;
  const policy = darkPolicy(env);
  const createPool = dependencies.createPool ?? createMailgunWorkerCommandDatabasePool;
  const assertBoundaryReady = dependencies.assertBoundaryReady
    ?? assertPropertyPredatorEmailPilotBoundaryReady;
  const assertSchemaCurrent = dependencies.assertSchemaCurrent
    ?? assertRuntimeSchemaCurrent;
  const assertInstallationReady = dependencies.assertInstallationReady
    ?? assertExpectedDatabaseInstallation;
  const writeReadiness = dependencies.writeReadiness
    ?? ((line: string) => { process.stdout.write(line); });
  const onBackgroundDatabaseError = dependencies.onBackgroundDatabaseError
    ?? ((errorName: string) => {
      process.stderr.write(`Dark email worker database connection error (${errorName})\n`);
    });
  const keepAliveIntervalMs = dependencies.keepAliveIntervalMs ?? 60_000;
  if (!Number.isSafeInteger(keepAliveIntervalMs)
      || keepAliveIntervalMs < 1 || keepAliveIntervalMs > 600_000) {
    throw new Error('Dark email worker keep-alive interval is invalid');
  }

  const pool = createPool(env, {
    onBackgroundError: (error) => {
      // Provider/connection messages can echo credentials. Only the class name
      // crosses this boundary.
      onBackgroundDatabaseError(redactedDarkEmailWorkerErrorClass(error));
    },
  });
  try {
    await assertSchemaCurrent(pool);
    await assertInstallationReady(
      pool,
      env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID?.trim(),
    );
    await assertBoundaryReady(pool);
  } catch (error) {
    try {
      await pool.end();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'Dark email worker readiness and pool shutdown both failed',
      );
    }
    throw error;
  }

  const readiness = readinessFor(policy);
  try {
    writeReadiness(`${JSON.stringify(readiness)}\n`);
  } catch (error) {
    try {
      await pool.end();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'Dark email worker readiness output and pool shutdown both failed',
      );
    }
    throw error;
  }

  // A dark worker does no polling. The inert timer makes that deliberate idle
  // state long-running without touching a provider or repeatedly querying the
  // database. Shutdown always clears it before closing the pool.
  const keepAlive = setInterval(() => undefined, keepAliveIntervalMs);
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    clearInterval(keepAlive);
    shutdownPromise = Promise.resolve()
      .then(() => pool.end())
      .finally(() => { resolveStopped?.(); });
    return shutdownPromise;
  };

  return Object.freeze({ readiness, stopped, shutdown });
}
