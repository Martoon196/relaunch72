import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { createMailgunWorkerCommandDatabasePool } from '../../db/pool.js';
import { assertExpectedDatabaseInstallation } from '../../db/installation-identity.js';
import { assertRuntimeSchemaCurrent } from '../../db/runtime-readiness.js';
import { assertPropertyPredatorEmailPilotBoundaryReady } from '../../property-predator-email-pilot-pg/index.js';
import {
  createPgPropertyPredatorMailgunWorkerRepository,
  type PropertyPredatorMailgunWorkerRepository,
} from '../../property-predator-mailgun-worker-pg/index.js';
import {
  createMailgunEuHttpAdapterFromDomainSendingKeyEnvironment,
  MailgunOutcomeUnknownError,
  type MailgunEuEmailTransport,
} from '../../providers/mailgun-eu-http-adapter.js';
import {
  loadPropertyPredatorEmailPilotPolicy,
  normalizeOwnedInternalSeedEmail,
  type PropertyPredatorEmailPilotPolicy,
} from '../../providers/property-predator-email-pilot-config.js';
import {
  createProviderOperationContext,
  type ProviderOperationResult,
} from '../../providers/contracts.js';
import { redactedDarkEmailWorkerErrorClass } from '../property-predator-email/dark-worker.js';

export const PROPERTY_PREDATOR_LIVE_MAILGUN_WORKER_SERVICE =
  'property-predator-email-worker';
export const PROPERTY_PREDATOR_LIVE_MAILGUN_WORKER_MODE = 'internal-seed-live';
export const PROPERTY_PREDATOR_LIVE_MAILGUN_RECIPIENT = 'office@propertypredator.com';
export const PROPERTY_PREDATOR_LIVE_MAILGUN_DOMAIN = 'mg.propertypredator.com';
export const PROPERTY_PREDATOR_LIVE_MAILGUN_MONTHLY_HARD_CAP = 3;

const FORBIDDEN_LIVE_WORKER_SECRETS = Object.freeze([
  'MAILGUN_SIGNING_KEY',
  'SESSION_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'POSTMARK_SERVER_TOKEN',
  'BREVO_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
]);

type LiveWorkerPool = Pick<Pool, 'query' | 'connect' | 'end'>;

export interface PropertyPredatorLiveMailgunRunResult {
  readonly disposition:
    | 'idle'
    | 'recovered'
    | 'blocked'
    | 'replayed'
    | 'settled';
  readonly providerResult: ProviderOperationResult | null;
}

export interface PropertyPredatorLiveMailgunWorkerRuntime {
  readonly readiness: PropertyPredatorLiveMailgunWorkerReadiness;
  readonly stopped: Promise<void>;
  shutdown(): Promise<void>;
}

export interface PropertyPredatorLiveMailgunWorkerReadiness {
  readonly schemaVersion: 1;
  readonly event: 'ready';
  readonly service: typeof PROPERTY_PREDATOR_LIVE_MAILGUN_WORKER_SERVICE;
  readonly mode: typeof PROPERTY_PREDATOR_LIVE_MAILGUN_WORKER_MODE;
  readonly provider: Readonly<{
    id: 'mailgun';
    region: 'eu';
    sendingDomain: typeof PROPERTY_PREDATOR_LIVE_MAILGUN_DOMAIN;
    credentialScope: 'domain-sending';
    dedicatedCredentialConfigured: true;
    webhookSigningKeyPresent: false;
  }>;
  readonly database: Readonly<{
    role: 'r72_mailgun_worker_command';
    boundaryReady: true;
  }>;
  readonly safety: Readonly<{
    providerEffectsEnabled: true;
    emailDeliveryEnabled: true;
    emergencyPaused: false;
    dispatchLoopStarted: true;
    providerAdapterInstantiated: true;
    providerNetworkCallsMadeAtReadiness: false;
  }>;
  readonly pilot: Readonly<{
    recipientScope: 'owned-internal-seeds-only';
    recipientCountPerRun: 1;
    messageCountPerRun: 1;
    monthlyHardCap: typeof PROPERTY_PREDATOR_LIVE_MAILGUN_MONTHLY_HARD_CAP;
  }>;
}

export interface PropertyPredatorLiveMailgunRunDependencies {
  readonly repository: PropertyPredatorMailgunWorkerRepository;
  readonly transport: MailgunEuEmailTransport;
  readonly policy: PropertyPredatorEmailPilotPolicy;
  readonly now?: () => Date;
  readonly randomToken?: () => Uint8Array;
  readonly leaseSeconds?: number;
}

export interface PropertyPredatorLiveMailgunWorkerDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly createPool?: (
    env: NodeJS.ProcessEnv,
    hooks: Readonly<{ onBackgroundError: (error: Error) => void }>,
  ) => LiveWorkerPool;
  readonly assertSchemaCurrent?: (pool: Pick<Pool, 'query'>) => Promise<void>;
  readonly assertInstallationReady?: (
    pool: Pick<Pool, 'query'>,
    expectedInstallationId: string | undefined,
  ) => Promise<void>;
  readonly assertBoundaryReady?: (pool: Pick<Pool, 'query'>) => Promise<void>;
  readonly createRepository?: (
    pool: Pick<Pool, 'connect'>,
    workspaceId: string,
    providerConnectionId: string,
  ) => PropertyPredatorMailgunWorkerRepository;
  readonly createTransport?: (env: NodeJS.ProcessEnv) => MailgunEuEmailTransport;
  readonly writeReadiness?: (line: string) => void;
  readonly writeErrorTelemetry?: (line: string) => void;
  readonly onBackgroundDatabaseError?: (errorName: string) => void;
  readonly onRunError?: (errorName: string) => void;
  readonly pollIntervalMs?: number;
  readonly leaseSeconds?: number;
  readonly now?: () => Date;
  readonly randomToken?: () => Uint8Array;
}

function assertExactLivePolicy(
  env: NodeJS.ProcessEnv,
  policy: PropertyPredatorEmailPilotPolicy,
): void {
  if (env.NODE_ENV !== 'production') throw new Error('Live Mailgun worker requires NODE_ENV=production');
  if (env.PROPERTY_PREDATOR_EMAIL_WORKER_MODE !== PROPERTY_PREDATOR_LIVE_MAILGUN_WORKER_MODE) {
    throw new Error('Live Mailgun worker mode is not explicitly enabled');
  }
  if (!policy.providerEffectsEnabled || !policy.emailDeliveryEnabled || policy.emergencyPaused) {
    throw new Error('Live Mailgun worker safety switches are not explicitly active');
  }
  if (policy.maxRecipients !== 1
      || policy.maxMessagesPerRun !== 1
      || policy.maxMessagesPerUtcMonth !== PROPERTY_PREDATOR_LIVE_MAILGUN_MONTHLY_HARD_CAP
      || policy.internalSeedAllowlist.length !== 1
      || policy.internalSeedAllowlist[0] !== PROPERTY_PREDATOR_LIVE_MAILGUN_RECIPIENT) {
    throw new Error('Live Mailgun worker recipient scope exceeds the owned internal seed');
  }
  if (env.MAILGUN_REGION?.trim() !== 'eu'
      || env.MAILGUN_SENDING_DOMAIN?.trim().toLowerCase() !== PROPERTY_PREDATOR_LIVE_MAILGUN_DOMAIN
      || env.MAILGUN_KEY_SCOPE?.trim() !== 'domain-sending'
      || !env.MAILGUN_DOMAIN_SENDING_KEY?.trim()
      || env.MAILGUN_API_KEY?.trim()) {
    throw new Error('Live Mailgun worker requires the EU domain-scoped sending-key boundary');
  }
  if (!env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID?.trim()) {
    throw new Error('Live Mailgun worker requires the database installation identity');
  }
  if (!env.DATABASE_MAILGUN_WORKER_URL?.trim()) {
    throw new Error('Live Mailgun worker requires its isolated database identity');
  }
  const databaseUrls = Object.keys(env).filter((name) => Boolean(env[name]?.trim())
    && (name === 'DATABASE_URL' || name === 'TEST_DATABASE_URL'
      || /^DATABASE_[A-Z0-9_]+_URL$/.test(name)));
  if (databaseUrls.some((name) => name !== 'DATABASE_MAILGUN_WORKER_URL')) {
    throw new Error('Live Mailgun worker received another database identity');
  }
  if (FORBIDDEN_LIVE_WORKER_SECRETS.some((name) => Boolean(env[name]?.trim()))) {
    throw new Error('Live Mailgun worker received a secret owned by another process');
  }
}

function interval(value: number | undefined): number {
  const candidate = value ?? 5_000;
  if (!Number.isSafeInteger(candidate) || candidate < 250 || candidate > 60_000) {
    throw new Error('Live Mailgun poll interval is invalid');
  }
  return candidate;
}

function leaseDuration(value: number | undefined): number {
  const candidate = value ?? 60;
  if (!Number.isSafeInteger(candidate) || candidate < 30 || candidate > 300) {
    throw new Error('Live Mailgun lease duration is invalid');
  }
  return candidate;
}

function unknownResult(now: () => Date, error: unknown): ProviderOperationResult {
  return Object.freeze({
    status: 'needs_attention',
    externalId: null,
    occurredAt: now().toISOString(),
    retryable: false,
    errorCode: error instanceof MailgunOutcomeUnknownError
      ? error.code : 'mailgun_unexpected_transport_exception',
    summary: 'Mailgun call outcome requires signed-webhook reconciliation before any retry',
  });
}

function structuredErrorLine(
  eventKind: 'background_database' | 'run',
  count: number,
  errorClass: string,
): string {
  return `${JSON.stringify(Object.freeze({
    schemaVersion: 1,
    event: 'worker_error',
    service: PROPERTY_PREDATOR_LIVE_MAILGUN_WORKER_SERVICE,
    mode: PROPERTY_PREDATOR_LIVE_MAILGUN_WORKER_MODE,
    eventKind,
    count,
    errorClass,
  }))}\n`;
}

function liveReadiness(): PropertyPredatorLiveMailgunWorkerReadiness {
  return Object.freeze({
    schemaVersion: 1,
    event: 'ready',
    service: PROPERTY_PREDATOR_LIVE_MAILGUN_WORKER_SERVICE,
    mode: PROPERTY_PREDATOR_LIVE_MAILGUN_WORKER_MODE,
    provider: Object.freeze({
      id: 'mailgun',
      region: 'eu',
      sendingDomain: PROPERTY_PREDATOR_LIVE_MAILGUN_DOMAIN,
      credentialScope: 'domain-sending',
      dedicatedCredentialConfigured: true,
      webhookSigningKeyPresent: false,
    }),
    database: Object.freeze({
      role: 'r72_mailgun_worker_command',
      boundaryReady: true,
    }),
    safety: Object.freeze({
      providerEffectsEnabled: true,
      emailDeliveryEnabled: true,
      emergencyPaused: false,
      dispatchLoopStarted: true,
      providerAdapterInstantiated: true,
      providerNetworkCallsMadeAtReadiness: false,
    }),
    pilot: Object.freeze({
      recipientScope: 'owned-internal-seeds-only',
      recipientCountPerRun: 1,
      messageCountPerRun: 1,
      monthlyHardCap: PROPERTY_PREDATOR_LIVE_MAILGUN_MONTHLY_HARD_CAP,
    }),
  });
}

/** Run at most one recovery action or one recipient delivery. */
export async function runOnePropertyPredatorLiveMailgunJob(
  dependencies: Readonly<PropertyPredatorLiveMailgunRunDependencies>,
): Promise<PropertyPredatorLiveMailgunRunResult> {
  const recovered = await dependencies.repository.recoverOne();
  if (recovered) return Object.freeze({ disposition: 'recovered', providerResult: null });

  const rawToken = (dependencies.randomToken ?? (() => randomBytes(32)))();
  if (!(rawToken instanceof Uint8Array) || rawToken.byteLength !== 32) {
    throw new Error('Mailgun lease token source returned invalid entropy');
  }
  const seconds = leaseDuration(dependencies.leaseSeconds);
  const lease = await dependencies.repository.claimOne(rawToken, seconds);
  if (!lease) return Object.freeze({ disposition: 'idle', providerResult: null });
  const decision = await dependencies.repository.beginCall(lease, rawToken, {
    runSpendCapUsdMicros: dependencies.policy.maxSpendUsdMicrosPerRun,
    monthSpendCapUsdMicros: dependencies.policy.maxSpendUsdMicrosPerUtcMonth,
  });
  if (decision.disposition === 'blocked') {
    return Object.freeze({ disposition: 'blocked', providerResult: null });
  }
  if (decision.disposition === 'replay') {
    return Object.freeze({ disposition: 'replayed', providerResult: null });
  }

  const now = dependencies.now ?? (() => new Date());
  if (decision.providerConnectionId !== dependencies.policy.providerConnectionId) {
    const providerResult = Object.freeze({
      status: 'failed' as const,
      externalId: null,
      occurredAt: now().toISOString(),
      retryable: false,
      errorCode: 'mailgun_provider_connection_mismatch',
      summary: 'Mailgun job did not match the configured provider connection',
    });
    const settled = await dependencies.repository.settle(lease, rawToken, providerResult);
    if (!settled) throw new Error('Mailgun job settlement fence was lost');
    return Object.freeze({ disposition: 'settled', providerResult });
  }

  let canonicalRecipient: string | null = null;
  try {
    const normalized = normalizeOwnedInternalSeedEmail(decision.recipient);
    if (dependencies.policy.internalSeedAllowlist.includes(normalized)) {
      canonicalRecipient = normalized;
    }
  } catch {
    canonicalRecipient = null;
  }
  if (!canonicalRecipient) {
    const providerResult = Object.freeze({
      status: 'failed' as const,
      externalId: null,
      occurredAt: now().toISOString(),
      retryable: false,
      errorCode: 'mailgun_recipient_outside_internal_seed_allowlist',
      summary: 'Mailgun job recipient was outside the owned internal-seed allowlist',
    });
    const settled = await dependencies.repository.settle(lease, rawToken, providerResult);
    if (!settled) throw new Error('Mailgun job settlement fence was lost');
    return Object.freeze({ disposition: 'settled', providerResult });
  }

  const context = createProviderOperationContext({
    connection: Object.freeze({
      id: decision.providerConnectionId,
      workspaceId: dependencies.policy.workspaceId,
      providerId: 'mailgun_eu',
    }),
    operationId: decision.operationId,
    correlationId: decision.correlationId,
    idempotencyKey: decision.requestSha256,
  });
  let providerResult: ProviderOperationResult;
  try {
    providerResult = await dependencies.transport.send(context, Object.freeze({
      recipients: Object.freeze([canonicalRecipient]),
      subject: decision.subject,
      text: decision.text,
      idempotencySha256: decision.requestSha256,
      expectedMessageId: decision.expectedMessageId,
    }));
  } catch (error) {
    providerResult = unknownResult(now, error);
  }
  const settled = await dependencies.repository.settle(lease, rawToken, providerResult);
  if (!settled) throw new Error('Mailgun job settlement fence was lost');
  return Object.freeze({ disposition: 'settled', providerResult });
}

export async function startPropertyPredatorLiveMailgunWorker(
  dependencies: PropertyPredatorLiveMailgunWorkerDependencies = {},
): Promise<PropertyPredatorLiveMailgunWorkerRuntime> {
  const env = dependencies.env ?? process.env;
  const policy = loadPropertyPredatorEmailPilotPolicy(env);
  assertExactLivePolicy(env, policy);
  const pollIntervalMs = interval(dependencies.pollIntervalMs);
  const leaseSeconds = leaseDuration(dependencies.leaseSeconds);
  const createPool = dependencies.createPool ?? createMailgunWorkerCommandDatabasePool;
  const writeErrorTelemetry = dependencies.writeErrorTelemetry
    ?? ((line: string) => { process.stderr.write(line); });
  let backgroundDatabaseErrorCount = 0;
  let runErrorCount = 0;
  const onBackgroundDatabaseError = dependencies.onBackgroundDatabaseError
    ?? ((errorClass: string) => {
      backgroundDatabaseErrorCount += 1;
      writeErrorTelemetry(structuredErrorLine(
        'background_database', backgroundDatabaseErrorCount, errorClass,
      ));
    });
  const onRunError = dependencies.onRunError
    ?? ((errorClass: string) => {
      runErrorCount += 1;
      writeErrorTelemetry(structuredErrorLine('run', runErrorCount, errorClass));
    });
  const pool = createPool(env, {
    onBackgroundError: (error) => onBackgroundDatabaseError(
      redactedDarkEmailWorkerErrorClass(error),
    ),
  });
  try {
    await (dependencies.assertSchemaCurrent ?? assertRuntimeSchemaCurrent)(pool);
    await (dependencies.assertInstallationReady ?? assertExpectedDatabaseInstallation)(
      pool,
      env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID?.trim(),
    );
    await (dependencies.assertBoundaryReady ?? assertPropertyPredatorEmailPilotBoundaryReady)(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }

  let repository: PropertyPredatorMailgunWorkerRepository;
  let transport: MailgunEuEmailTransport;
  const readiness = liveReadiness();
  try {
    repository = (dependencies.createRepository
       ?? ((commandPool, workspaceId, providerConnectionId) => createPgPropertyPredatorMailgunWorkerRepository({
         commandPool, workspaceId, providerConnectionId,
       })))(pool, policy.workspaceId, policy.providerConnectionId);
    transport = (dependencies.createTransport
      ?? createMailgunEuHttpAdapterFromDomainSendingKeyEnvironment)(env);
  } catch (error) {
    await pool.end();
    throw error;
  }

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight = Promise.resolve();
  let resolveStopped: (() => void) | undefined;
  const stoppedPromise = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = runOnePropertyPredatorLiveMailgunJob({
        repository, transport, policy,
        leaseSeconds, now: dependencies.now, randomToken: dependencies.randomToken,
      }).then(() => undefined).catch((error: unknown) => {
        onRunError(redactedDarkEmailWorkerErrorClass(error));
      }).finally(schedule);
    }, pollIntervalMs);
  };
  schedule();
  try {
    (dependencies.writeReadiness ?? ((line: string) => { process.stdout.write(line); }))(
      `${JSON.stringify(readiness)}\n`,
    );
  } catch (error) {
    stopped = true;
    if (timer) clearTimeout(timer);
    try {
      await pool.end();
    } catch (closeError) {
      resolveStopped?.();
      throw new AggregateError(
        [error, closeError],
        'Live Mailgun readiness emission and pool shutdown both failed',
      );
    }
    resolveStopped?.();
    throw error;
  }

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    stopped = true;
    if (timer) clearTimeout(timer);
    shutdownPromise = inFlight.then(() => pool.end()).finally(() => resolveStopped?.());
    return shutdownPromise;
  };
  return Object.freeze({ readiness, stopped: stoppedPromise, shutdown });
}
