import assert from 'node:assert/strict';
import test from 'node:test';
import type { PropertyPredatorMailgunWorkerRepository } from '../src/property-predator-mailgun-worker-pg/index.js';
import type { MailgunEuEmailRequest, MailgunEuEmailTransport } from '../src/providers/mailgun-eu-http-adapter.js';
import type { ProviderOperationContext, ProviderOperationResult } from '../src/providers/contracts.js';
import type { PropertyPredatorEmailPilotPolicy } from '../src/providers/property-predator-email-pilot-config.js';
import {
  runOnePropertyPredatorLiveMailgunJob,
  startPropertyPredatorLiveMailgunWorker,
} from '../src/workers/property-predator-mailgun/live-worker.js';

const IDS = Object.freeze({
  workspace: '11111111-1111-4111-8111-111111111111',
  connection: '22222222-2222-4222-8222-222222222222',
  job: '33333333-3333-4333-8333-333333333333',
  operation: '44444444-4444-4444-8444-444444444444',
  correlation: '55555555-5555-4555-8555-555555555555',
  reservation: '66666666-6666-4666-8666-666666666666',
});
const REQUEST_SHA = 'b'.repeat(64);
const NOW = new Date('2026-08-28T12:00:00.000Z');

function policy(): PropertyPredatorEmailPilotPolicy {
  return Object.freeze({
    providerEffectsEnabled: true, emailDeliveryEnabled: true, emergencyPaused: false,
    workspaceId: IDS.workspace, providerConnectionId: IDS.connection,
    stage: 'internal-seed', recipientScope: 'owned-internal-seeds-only',
    maxRecipients: 1, internalSeedAllowlist: Object.freeze(['office@propertypredator.com']),
    maxMessagesPerRun: 1, maxMessagesPerUtcMonth: 3,
    estimatedCostUsdMicrosPerRecipient: 1_000,
    maxSpendUsdMicrosPerRun: 1_000, maxSpendUsdMicrosPerUtcMonth: 3_000,
  });
}

class Repository implements PropertyPredatorMailgunWorkerRepository {
  recover = false;
  recoveryError: Error | null = null;
  decisionConnectionId: string = IDS.connection;
  decisionRecipient = 'office@propertypredator.com';
  settlements: ProviderOperationResult[] = [];
  claims = 0;
  async recoverOne() {
    if (this.recoveryError) throw this.recoveryError;
    return this.recover
      ? { jobId: IDS.job, disposition: 'reconciliation_required' as const }
      : null;
  }
  async claimOne() {
    this.claims += 1;
    return { jobId: IDS.job, leaseVersion: 1 };
  }
  async renew() { return true; }
  async beginCall() {
    return {
      disposition: 'authorized' as const,
      jobId: IDS.job, operationId: IDS.operation,
      correlationId: IDS.correlation, providerConnectionId: this.decisionConnectionId,
      reservationId: IDS.reservation, requestSha256: REQUEST_SHA,
      expectedMessageId: `<pp-${REQUEST_SHA}@mg.propertypredator.com>`,
      recipient: this.decisionRecipient, subject: 'Owned seed', text: 'Controlled body',
    };
  }
  async settle(_lease: unknown, _token: unknown, result: ProviderOperationResult) {
    this.settlements.push(result); return true;
  }
}

class Transport implements MailgunEuEmailTransport {
  calls: Readonly<{ context: ProviderOperationContext; request: MailgunEuEmailRequest }>[] = [];
  error: Error | null = null;
  async send(context: ProviderOperationContext, request: MailgunEuEmailRequest) {
    this.calls.push({ context, request });
    if (this.error) throw this.error;
    return {
      status: 'accepted' as const,
      externalId: request.expectedMessageId ?? null,
      occurredAt: NOW.toISOString(), retryable: false, errorCode: null,
      summary: 'Mailgun accepted the owned internal seed',
    };
  }
}

test('one run sends exactly one owned seed with the durably expected Message-ID', async () => {
  const repository = new Repository();
  const transport = new Transport();
  const result = await runOnePropertyPredatorLiveMailgunJob({
    repository, transport, policy: policy(), now: () => NOW,
    randomToken: () => Buffer.alloc(32, 9), leaseSeconds: 60,
  });
  assert.equal(result.disposition, 'settled');
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(transport.calls[0]?.request.recipients, ['office@propertypredator.com']);
  assert.equal(
    transport.calls[0]?.request.expectedMessageId,
    `<pp-${REQUEST_SHA}@mg.propertypredator.com>`,
  );
  assert.equal(repository.settlements.length, 1);
});

test('an uncertain provider response is settled once for signed-webhook reconciliation', async () => {
  const repository = new Repository();
  const transport = new Transport();
  transport.error = new Error('provider response lost');
  const result = await runOnePropertyPredatorLiveMailgunJob({
    repository, transport, policy: policy(), now: () => NOW,
    randomToken: () => Buffer.alloc(32, 5),
  });
  assert.equal(result.providerResult?.status, 'needs_attention');
  assert.equal(result.providerResult?.retryable, false);
  assert.equal(repository.settlements[0]?.errorCode, 'mailgun_unexpected_transport_exception');
  assert.equal(transport.calls.length, 1);
});

test('recovery consumes the run before any new claim or provider call', async () => {
  const repository = new Repository();
  repository.recover = true;
  const transport = new Transport();
  const result = await runOnePropertyPredatorLiveMailgunJob({
    repository, transport, policy: policy(),
  });
  assert.equal(result.disposition, 'recovered');
  assert.equal(repository.claims, 0);
  assert.equal(transport.calls.length, 0);
});

test('a job for another provider connection is settled without a provider call', async () => {
  const repository = new Repository();
  repository.decisionConnectionId = '77777777-7777-4777-8777-777777777777';
  const transport = new Transport();
  const result = await runOnePropertyPredatorLiveMailgunJob({
    repository, transport, policy: policy(), now: () => NOW,
    randomToken: () => Buffer.alloc(32, 4),
  });
  assert.equal(result.disposition, 'settled');
  assert.equal(result.providerResult?.status, 'failed');
  assert.equal(result.providerResult?.errorCode, 'mailgun_provider_connection_mismatch');
  assert.equal(transport.calls.length, 0);
  assert.equal(repository.settlements.length, 1);
});

test('a job for a recipient outside the owned seed allowlist is settled without a provider call', async () => {
  const repository = new Repository();
  repository.decisionRecipient = 'customer@example.com';
  const transport = new Transport();
  const result = await runOnePropertyPredatorLiveMailgunJob({
    repository, transport, policy: policy(), now: () => NOW,
    randomToken: () => Buffer.alloc(32, 4),
  });
  assert.equal(result.disposition, 'settled');
  assert.equal(
    result.providerResult?.errorCode,
    'mailgun_recipient_outside_internal_seed_allowlist',
  );
  assert.equal(transport.calls.length, 0);
  assert.equal(repository.settlements.length, 1);
});

test('active startup rejects broad/signing keys before pool or provider construction', async () => {
  let pools = 0;
  let transports = 0;
  await assert.rejects(startPropertyPredatorLiveMailgunWorker({
    env: {
      NODE_ENV: 'production', PROPERTY_PREDATOR_EMAIL_WORKER_MODE: 'internal-seed-live',
      PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true',
      PROPERTY_PREDATOR_EMAIL_DELIVERY_ENABLED: 'true',
      PROPERTY_PREDATOR_EMAIL_EMERGENCY_PAUSED: 'false',
      PROPERTY_PREDATOR_EMAIL_PROVIDER: 'mailgun',
      PROPERTY_PREDATOR_PILOT_WORKSPACE_ID: IDS.workspace,
      PROPERTY_PREDATOR_MAILGUN_CONNECTION_ID: IDS.connection,
      PROPERTY_PREDATOR_PILOT_STAGE: 'internal-seed',
      PROPERTY_PREDATOR_PILOT_RECIPIENT_SCOPE: 'owned-internal-seeds-only',
      PROPERTY_PREDATOR_PILOT_MAX_RECIPIENTS: '1',
      PROPERTY_PREDATOR_EMAIL_INTERNAL_SEEDS: 'office@propertypredator.com',
      PROPERTY_PREDATOR_EMAIL_RUN_MESSAGE_CAP: '1',
      PROPERTY_PREDATOR_EMAIL_MONTHLY_MESSAGE_CAP: '3',
      PROPERTY_PREDATOR_EMAIL_ESTIMATED_RECIPIENT_COST_USD_MICROS: '1000',
      PROPERTY_PREDATOR_EMAIL_RUN_SPEND_CAP_USD_MICROS: '1000',
      PROPERTY_PREDATOR_EMAIL_MONTHLY_SPEND_CAP_USD_MICROS: '3000',
      PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: IDS.reservation,
      DATABASE_MAILGUN_WORKER_URL: 'postgresql://r72_mailgun_worker_command:secret@db.example/app',
      MAILGUN_REGION: 'eu', MAILGUN_SENDING_DOMAIN: 'mg.propertypredator.com',
      MAILGUN_KEY_SCOPE: 'domain-sending', MAILGUN_DOMAIN_SENDING_KEY: 'domain-key-secret',
      MAILGUN_API_KEY: 'broad-account-key', MAILGUN_SIGNING_KEY: 'web-only-key',
    },
    createPool: () => { pools += 1; throw new Error('must not open'); },
    createTransport: () => { transports += 1; throw new Error('must not instantiate'); },
  }), /domain-scoped sending-key boundary/);
  assert.equal(pools, 0);
  assert.equal(transports, 0);
});

test('default live-worker failures emit counted structured telemetry without raw details', async () => {
  const repository = new Repository();
  repository.recoveryError = new Error('postgresql://worker:secret@private-db/customer@example.com');
  const lines: string[] = [];
  let backgroundError: ((error: Error) => void) | undefined;
  let ended = 0;
  const runtime = await startPropertyPredatorLiveMailgunWorker({
    env: {
      NODE_ENV: 'production', PROPERTY_PREDATOR_EMAIL_WORKER_MODE: 'internal-seed-live',
      PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true',
      PROPERTY_PREDATOR_EMAIL_DELIVERY_ENABLED: 'true',
      PROPERTY_PREDATOR_EMAIL_EMERGENCY_PAUSED: 'false',
      PROPERTY_PREDATOR_EMAIL_PROVIDER: 'mailgun',
      PROPERTY_PREDATOR_PILOT_WORKSPACE_ID: IDS.workspace,
      PROPERTY_PREDATOR_MAILGUN_CONNECTION_ID: IDS.connection,
      PROPERTY_PREDATOR_PILOT_STAGE: 'internal-seed',
      PROPERTY_PREDATOR_PILOT_RECIPIENT_SCOPE: 'owned-internal-seeds-only',
      PROPERTY_PREDATOR_PILOT_MAX_RECIPIENTS: '1',
      PROPERTY_PREDATOR_EMAIL_INTERNAL_SEEDS: 'office@propertypredator.com',
      PROPERTY_PREDATOR_EMAIL_RUN_MESSAGE_CAP: '1',
      PROPERTY_PREDATOR_EMAIL_MONTHLY_MESSAGE_CAP: '3',
      PROPERTY_PREDATOR_EMAIL_ESTIMATED_RECIPIENT_COST_USD_MICROS: '1000',
      PROPERTY_PREDATOR_EMAIL_RUN_SPEND_CAP_USD_MICROS: '1000',
      PROPERTY_PREDATOR_EMAIL_MONTHLY_SPEND_CAP_USD_MICROS: '3000',
      PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: IDS.reservation,
      DATABASE_MAILGUN_WORKER_URL: 'postgresql://r72_mailgun_worker_command:secret@db.example/app',
      MAILGUN_REGION: 'eu', MAILGUN_SENDING_DOMAIN: 'mg.propertypredator.com',
      MAILGUN_KEY_SCOPE: 'domain-sending', MAILGUN_DOMAIN_SENDING_KEY: 'domain-key-secret',
    },
    createPool: (_env, hooks) => {
      backgroundError = hooks.onBackgroundError;
      return {
        query: async () => ({ rows: [] }),
        connect: async () => { throw new Error('repository is injected'); },
        end: async () => { ended += 1; },
      } as never;
    },
    assertSchemaCurrent: async () => undefined,
    assertInstallationReady: async () => undefined,
    assertBoundaryReady: async () => undefined,
    createRepository: () => repository,
    createTransport: () => new Transport(),
    writeReadiness: () => undefined,
    writeErrorTelemetry: (line) => { lines.push(line); },
    pollIntervalMs: 250,
  });
  assert.deepEqual(runtime.readiness.safety, {
    providerEffectsEnabled: true,
    emailDeliveryEnabled: true,
    emergencyPaused: false,
    dispatchLoopStarted: true,
    providerAdapterInstantiated: true,
    providerNetworkCallsMadeAtReadiness: false,
  });
  assert.deepEqual(runtime.readiness.pilot, {
    recipientScope: 'owned-internal-seeds-only',
    recipientCountPerRun: 1,
    messageCountPerRun: 1,
    monthlyHardCap: 3,
  });
  const serializedReadiness = JSON.stringify(runtime.readiness);
  assert.doesNotMatch(serializedReadiness, /domain-key|office@|postgresql|secret/i);
  backgroundError?.(new Error('mailgun-domain-key-secret'));
  backgroundError?.(new TypeError('office@propertypredator.com'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  await runtime.shutdown();

  assert.equal(ended, 1);
  assert.equal(lines.length, 3);
  const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(events.map((event) => [event.eventKind, event.count, event.errorClass]), [
    ['background_database', 1, 'Error'],
    ['background_database', 2, 'TypeError'],
    ['run', 1, 'Error'],
  ]);
  for (const event of events) {
    assert.equal(event.event, 'worker_error');
    assert.equal(event.service, 'property-predator-email-worker');
    assert.equal(event.mode, 'internal-seed-live');
  }
  assert.doesNotMatch(lines.join(''), /secret|private-db|customer@|office@|postgresql/i);
});
