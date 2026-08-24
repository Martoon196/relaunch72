import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  SetupEmailDispatcher,
  type SetupDeliveryQueue,
  type SetupEmailAcceptanceRecord,
  type SetupEmailDispatchEvent,
} from '../src/portal/setup-email-dispatcher.js';
import {
  InMemorySetupEmailProvider,
  type SetupEmailProvider,
} from '../src/portal/setup-email-provider.js';
import {
  PgSetupDeliveryService,
  SetupDeliveryKeyring,
  UnreadableSetupDeliveryError,
  setupDeliveryAad,
  type ClaimedSetupDelivery,
  type EncryptedSetupDelivery,
} from '../src/portal/setup-delivery-pg-service.js';

const IDS = {
  delivery: '11111111-1111-4111-8111-111111111111',
  user: '22222222-2222-4222-8222-222222222222',
  workspace: '33333333-3333-4333-8333-333333333333',
  action: '44444444-4444-4444-8444-444444444444',
};
const NOW = Date.parse('2030-01-01T00:00:00.000Z');
const SETUP_TOKEN = 'S'.repeat(43);
const LEASE_TOKEN = 'L'.repeat(43);
const RECIPIENT = 'owner@example.test';
const SETUP_URL = `https://portal.example.test/portal/setup?token=${SETUP_TOKEN}`;
const KEY = Buffer.alloc(32, 7);
const IV = Buffer.alloc(12, 9);

function claimedJob(overrides: Partial<ClaimedSetupDelivery> = {}): ClaimedSetupDelivery {
  return Object.freeze({
    deliveryId: IDS.delivery,
    userId: IDS.user,
    workspaceId: IDS.workspace,
    actionTokenId: IDS.action,
    providerIdempotencyKey: IDS.delivery,
    recipientEmail: RECIPIENT,
    setupUrl: SETUP_URL,
    attemptCount: 1,
    leaseExpiresAt: new Date(NOW + 15_000).toISOString(),
    leaseToken: LEASE_TOKEN,
    ...overrides,
  });
}

class FakeQueue implements SetupDeliveryQueue {
  readonly claimCalls: Array<{ batchSize: number | undefined; leaseSeconds: number | undefined }> = [];
  readonly renewCalls: Array<{ deliveryId: string; leaseToken: string; leaseSeconds: number | undefined }> = [];
  readonly acknowledgements: Array<{
    deliveryId: string;
    leaseToken: string;
    acceptance: SetupEmailAcceptanceRecord;
  }> = [];
  readonly failures: Array<{
    deliveryId: string;
    leaseToken: string;
    errorCode: string;
    retryAt: string;
  }> = [];
  readonly terminalFailures: Array<{
    deliveryId: string;
    leaseToken: string;
    errorCode: string;
  }> = [];

  constructor(private readonly jobs: ClaimedSetupDelivery[]) {}

  async claim(batchSize?: number, leaseSeconds?: number): Promise<ClaimedSetupDelivery[]> {
    this.claimCalls.push({ batchSize, leaseSeconds });
    const next = this.jobs.shift();
    return next ? [next] : [];
  }

  async renew(deliveryId: string, leaseToken: string, leaseSeconds?: number): Promise<string> {
    this.renewCalls.push({ deliveryId, leaseToken, leaseSeconds });
    return new Date(NOW + (leaseSeconds ?? 60) * 1_000).toISOString();
  }

  async acknowledgeAcceptance(
    deliveryId: string,
    leaseToken: string,
    acceptance: SetupEmailAcceptanceRecord,
  ): Promise<{
    deliveredAt: string;
    providerId: string;
    providerReferenceId: string;
  }> {
    this.acknowledgements.push({ deliveryId, leaseToken, acceptance });
    return {
      deliveredAt: new Date(NOW).toISOString(),
      providerId: acceptance.providerId,
      providerReferenceId: acceptance.providerReferenceId,
    };
  }

  async fail(
    deliveryId: string,
    leaseToken: string,
    errorCode: string,
    retryAt: string | Date,
  ): Promise<{ state: string; availableAt: string }> {
    const availableAt = (retryAt instanceof Date ? retryAt : new Date(retryAt)).toISOString();
    this.failures.push({ deliveryId, leaseToken, errorCode, retryAt: availableAt });
    return { state: 'retry', availableAt };
  }

  async rejectPermanently(
    deliveryId: string,
    leaseToken: string,
    errorCode: string,
  ): Promise<{ state: 'dead_letter'; settledAt: string }> {
    this.terminalFailures.push({ deliveryId, leaseToken, errorCode });
    return { state: 'dead_letter', settledAt: new Date(NOW).toISOString() };
  }
}

function dispatcherOptions(queue: SetupDeliveryQueue, provider: SetupEmailProvider) {
  return {
    queue,
    provider,
    leaseSeconds: 15,
    providerTimeoutMs: 1_000,
    leaseSafetyMs: 1_000,
    retryBaseMs: 1_000,
    retryMaxMs: 4_000,
    idlePollMs: 5,
    blockedPollMs: 5,
    now: () => NOW,
  } as const;
}

function claimRow(encrypted: EncryptedSetupDelivery, authenticationTag = encrypted.authenticationTag) {
  return {
    delivery_id: encrypted.deliveryId,
    user_id: IDS.user,
    workspace_id: IDS.workspace,
    action_token_id: IDS.action,
    payload_version: encrypted.payloadVersion,
    encryption_key_id: encrypted.encryptionKeyId,
    encryption_iv: encrypted.encryptionIv,
    encrypted_payload: encrypted.encryptedPayload,
    authentication_tag: authenticationTag,
    recipient_email_hash: encrypted.recipientEmailHash,
    aad_context: setupDeliveryAad(encrypted.deliveryId),
    attempt_count: 1,
    lease_expires_at: new Date(NOW + 60_000).toISOString(),
  };
}

function producer(keyId: string): { encrypted: EncryptedSetupDelivery; keyring: SetupDeliveryKeyring } {
  const keyring = new SetupDeliveryKeyring({ activeKeyId: keyId, keys: { [keyId]: KEY } });
  const service = new PgSetupDeliveryService({
    deliveryCommandPool: { query: async () => ({ rows: [] }) } as never,
    keyring,
    setupUrl: 'https://portal.example.test/portal/setup',
    createSetupToken: () => SETUP_TOKEN,
    createDeliveryId: () => IDS.delivery,
    createIv: () => IV,
  });
  return { encrypted: service.prepare(RECIPIENT), keyring };
}

function assertSecretSafe(surface: unknown): void {
  const serialized = JSON.stringify(surface);
  assert.equal(serialized.includes(SETUP_TOKEN), false);
  assert.equal(serialized.includes(SETUP_URL), false);
  assert.equal(serialized.includes(RECIPIENT), false);
  assert.equal(serialized.includes(LEASE_TOKEN), false);
}

test('one-job dispatch renews only when needed, passes a stable correlation key, and acknowledges acceptance', async () => {
  const queue = new FakeQueue([claimedJob({ leaseExpiresAt: new Date(NOW + 1_500).toISOString() })]);
  const provider = new InMemorySetupEmailProvider({ now: () => NOW });
  const worker = new SetupEmailDispatcher(dispatcherOptions(queue, provider));

  const result = await worker.runOnce();

  assert.equal(result.outcome, 'accepted');
  assert.equal(result.deliveryId, IDS.delivery);
  assert.equal(result.attemptCount, 1);
  assert.match(result.providerReferenceId, /^memory_[a-f0-9]{24}$/);
  assert.equal(result.deliveredAt, '2030-01-01T00:00:00.000Z');
  assert.deepEqual(queue.claimCalls, [{ batchSize: 1, leaseSeconds: 15 }]);
  assert.deepEqual(queue.renewCalls, [{
    deliveryId: IDS.delivery,
    leaseToken: LEASE_TOKEN,
    leaseSeconds: 15,
  }]);
  assert.deepEqual(queue.acknowledgements, [{
    deliveryId: IDS.delivery,
    leaseToken: LEASE_TOKEN,
    acceptance: {
      providerId: 'memory',
      providerReferenceId: result.providerReferenceId,
      providerAcceptedAt: '2030-01-01T00:00:00.000Z',
    },
  }]);
  assert.deepEqual(queue.failures, []);
  assert.equal(provider.hasAccepted(IDS.delivery), true);
  assert.equal(provider.snapshot().length, 1);
  assert.equal(provider.snapshot()[0]!.correlationKey, IDS.delivery);
  assert.equal(provider.snapshot()[0]!.providerReferenceId, result.providerReferenceId);
  assertSecretSafe({ result, provider: provider.snapshot() });
});

test('provider errors release the lease to a deterministic bounded retry without leaking credentials', async () => {
  const queue = new FakeQueue([claimedJob({ attemptCount: 2 })]);
  const provider = new InMemorySetupEmailProvider({ now: () => NOW });
  provider.failNext('provider_unavailable');
  const worker = new SetupEmailDispatcher(dispatcherOptions(queue, provider));

  const result = await worker.runOnce();

  assert.deepEqual(result, {
    outcome: 'retry_scheduled',
    deliveryId: IDS.delivery,
    attemptCount: 2,
    errorCode: 'provider_unavailable',
    availableAt: '2030-01-01T00:00:02.000Z',
  });
  assert.deepEqual(queue.acknowledgements, []);
  assert.deepEqual(queue.failures, [{
    deliveryId: IDS.delivery,
    leaseToken: LEASE_TOKEN,
    errorCode: 'provider_unavailable',
    retryAt: '2030-01-01T00:00:02.000Z',
  }]);
  assertSecretSafe(result);
});

test('provider cannot wrap any delivery secret inside its reconciliation reference', async () => {
  const unsafeReferences = [
    `msg_${SETUP_TOKEN}_suffix`,
    `ref:${RECIPIENT}:suffix`,
    `ref:${SETUP_URL}:suffix`,
    `ref:${LEASE_TOKEN}:suffix`,
    `msg_${Buffer.from(RECIPIENT).toString('base64url')}`,
    `msg_${Buffer.from(SETUP_TOKEN).toString('hex')}`,
    RECIPIENT.toUpperCase(),
  ];
  for (const providerReferenceId of unsafeReferences) {
    const queue = new FakeQueue([claimedJob()]);
    const provider: SetupEmailProvider = {
      providerId: 'unsafe-fake',
      send: async () => ({
        status: 'accepted',
        providerReferenceId,
        acceptedAt: new Date(NOW).toISOString(),
      }),
    };
    const worker = new SetupEmailDispatcher(dispatcherOptions(queue, provider));

    const result = await worker.runOnce();

    assert.deepEqual(result, {
      outcome: 'dead_lettered',
      deliveryId: IDS.delivery,
      attemptCount: 1,
      errorCode: 'provider_invalid_response',
      availableAt: '2030-01-01T00:00:00.000Z',
    });
    assert.deepEqual(queue.acknowledgements, []);
    assertSecretSafe(result);
  }
});

test('permanent provider rejection uses terminal settlement and never enters the normal retry path', async () => {
  const queue = new FakeQueue([claimedJob()]);
  const provider = new InMemorySetupEmailProvider({ now: () => NOW });
  provider.failNext('provider_invalid_recipient', false);
  const worker = new SetupEmailDispatcher(dispatcherOptions(queue, provider));

  const result = await worker.runOnce();

  assert.deepEqual(result, {
    outcome: 'dead_lettered',
    deliveryId: IDS.delivery,
    attemptCount: 1,
    errorCode: 'provider_invalid_recipient',
    availableAt: '2030-01-01T00:00:00.000Z',
  });
  assert.deepEqual(queue.failures, []);
  assert.deepEqual(queue.terminalFailures, [{
    deliveryId: IDS.delivery,
    leaseToken: LEASE_TOKEN,
    errorCode: 'provider_invalid_recipient',
  }]);
  assertSecretSafe(result);
});

test('dispatcher refuses to construct without durable acceptance and permanent-settlement capabilities', () => {
  const backing = new FakeQueue([claimedJob()]);
  const incompleteQueue = {
    claim: backing.claim.bind(backing),
    renew: backing.renew.bind(backing),
    fail: backing.fail.bind(backing),
  } as unknown as SetupDeliveryQueue;

  assert.throws(
    () => new SetupEmailDispatcher(dispatcherOptions(
      incompleteQueue,
      new InMemorySetupEmailProvider({ now: () => NOW }),
    )),
    /lacks required terminal\/acceptance settlement capabilities/,
  );
  assert.equal(backing.claimCalls.length, 0);
});

test('unknown historical encryption key blocks provider work and exposes only a safe readiness code', async () => {
  const old = producer('retired-sensitive-key-id');
  const currentKeyring = new SetupDeliveryKeyring({
    activeKeyId: 'current-key',
    keys: { 'current-key': Buffer.alloc(32, 8) },
  });
  let queries = 0;
  const pool = {
    query: async () => {
      queries += 1;
      return { rows: [claimRow(old.encrypted)] } as never;
    },
  } as unknown as Pick<Pool, 'query'>;
  const pgQueue = new PgSetupDeliveryService({
    deliveryCommandPool: pool,
    keyring: currentKeyring,
    setupUrl: 'https://portal.example.test/portal/setup',
    createLeaseToken: () => LEASE_TOKEN,
  });
  const provider = new InMemorySetupEmailProvider({ now: () => NOW });
  const worker = new SetupEmailDispatcher(dispatcherOptions(pgQueue, provider));

  const result = await worker.runOnce();

  assert.deepEqual(result, { outcome: 'blocked', errorCode: 'missing_delivery_encryption_key' });
  assert.equal(queries, 1, 'missing-key work is left fenced until its bounded lease expires');
  assert.equal(provider.snapshot().length, 0);
  assert.equal(JSON.stringify(result).includes('retired-sensitive-key-id'), false);
  assertSecretSafe(result);
});

test('authenticated-payload failure blocks the worker without erasure or provider work', async () => {
  const prepared = producer('setup-key-v1');
  const tamperedTag = Buffer.from(prepared.encrypted.authenticationTag);
  tamperedTag[0] = tamperedTag[0]! ^ 1;
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] });
      if (text.includes('.claim_account_setup_deliveries')) {
        return { rows: [claimRow(prepared.encrypted, tamperedTag)] } as never;
      }
      throw new Error('no settlement query is allowed for unreadable ciphertext');
    },
  } as unknown as Pick<Pool, 'query'>;
  const pgQueue = new PgSetupDeliveryService({
    deliveryCommandPool: pool,
    keyring: prepared.keyring,
    setupUrl: 'https://portal.example.test/portal/setup',
    createLeaseToken: () => LEASE_TOKEN,
  });
  const provider = new InMemorySetupEmailProvider({ now: () => NOW });
  const events: SetupEmailDispatchEvent[] = [];
  const worker = new SetupEmailDispatcher({
    ...dispatcherOptions(pgQueue, provider),
    onEvent: (event) => events.push(event),
  });

  const result = await worker.runOnce();

  assert.deepEqual(result, { outcome: 'blocked', errorCode: 'delivery_payload_unreadable' });
  assert.equal(provider.snapshot().length, 0);
  assert.equal(calls.length, 1);
  assertSecretSafe({ result, events });
});

test('polling stops after an unreadable-payload readiness block instead of reclaiming it', async () => {
  let claims = 0;
  class UnreadableQueue extends FakeQueue {
    override async claim(): Promise<ClaimedSetupDelivery[]> {
      claims += 1;
      throw new UnreadableSetupDeliveryError();
    }
  }
  const queue = new UnreadableQueue([]);
  const provider = new InMemorySetupEmailProvider({ now: () => NOW });
  const events: SetupEmailDispatchEvent[] = [];
  let releaseStopped!: () => void;
  const stopped = new Promise<void>((resolve) => { releaseStopped = resolve; });
  const worker = new SetupEmailDispatcher({
    ...dispatcherOptions(queue, provider),
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'worker_stopped') releaseStopped();
    },
  });

  worker.start();
  await stopped;

  assert.equal(worker.state, 'idle');
  assert.equal(claims, 1);
  assert.equal(provider.snapshot().length, 0);
  assert.deepEqual(events.map((event) => event.type), [
    'worker_started',
    'dispatch_result',
    'worker_stopped',
  ]);
  const resultEvent = events[1];
  assert.equal(resultEvent?.type, 'dispatch_result');
  if (resultEvent?.type === 'dispatch_result') {
    assert.deepEqual(resultEvent.result, {
      outcome: 'blocked',
      errorCode: 'delivery_payload_unreadable',
    });
  }
  assertSecretSafe(events);
});

test('construction is inert and stop aborts an in-flight fake provider before releasing the job to retry', async () => {
  const queue = new FakeQueue([claimedJob()]);
  let enterProvider!: () => void;
  const providerEntered = new Promise<void>((resolve) => { enterProvider = resolve; });
  let providerObservedAbort = false;
  const provider: SetupEmailProvider = {
    providerId: 'blocking-fake',
    send: (_request, signal) => {
      enterProvider();
      const abort = (): void => { providerObservedAbort = true; };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      // Deliberately ignore cancellation at the Promise level. The dispatcher
      // must still stop cleanly even if a third-party adapter is uncooperative.
      return new Promise(() => {});
    },
  };
  const events: SetupEmailDispatchEvent[] = [];
  const worker = new SetupEmailDispatcher({
    ...dispatcherOptions(queue, provider),
    onEvent: (event) => events.push(event),
  });

  await Promise.resolve();
  assert.equal(worker.state, 'idle');
  assert.equal(queue.claimCalls.length, 0, 'constructor never starts provider or database work');

  worker.start();
  await providerEntered;
  assert.equal(worker.state, 'running');
  await worker.stop();

  assert.equal(worker.state, 'idle');
  assert.equal(providerObservedAbort, true);
  assert.deepEqual(queue.acknowledgements, []);
  assert.equal(queue.failures.length, 1);
  assert.equal(queue.failures[0]!.errorCode, 'worker_stopped');
  assert.deepEqual(events.map((event) => event.type), [
    'worker_started',
    'dispatch_result',
    'worker_stopped',
  ]);
  assertSecretSafe(events);
});

test('stop during a pending claim never enters the provider after cancellation', async () => {
  const backing = new FakeQueue([]);
  let claimStarted!: () => void;
  let releaseClaim!: () => void;
  const started = new Promise<void>((resolve) => { claimStarted = resolve; });
  const queue: SetupDeliveryQueue = {
    claim: async () => {
      claimStarted();
      return new Promise<ClaimedSetupDelivery[]>((resolve) => {
        releaseClaim = () => resolve([claimedJob()]);
      });
    },
    renew: backing.renew.bind(backing),
    fail: backing.fail.bind(backing),
    acknowledgeAcceptance: backing.acknowledgeAcceptance.bind(backing),
    rejectPermanently: backing.rejectPermanently.bind(backing),
  };
  let providerCalls = 0;
  const provider: SetupEmailProvider = {
    providerId: 'never-called',
    send: async () => {
      providerCalls += 1;
      throw new Error('provider must not be entered after stop');
    },
  };
  const worker = new SetupEmailDispatcher(dispatcherOptions(queue, provider));

  worker.start();
  await started;
  const stopping = worker.stop();
  releaseClaim();
  await stopping;

  assert.equal(providerCalls, 0);
  assert.equal(backing.failures.length, 1);
  assert.equal(backing.failures[0]!.errorCode, 'worker_stopped');
  assert.equal(worker.state, 'idle');
});

test('in-memory development provider locally deduplicates a correlation key without retaining plaintext', async () => {
  const provider = new InMemorySetupEmailProvider({ now: () => NOW });
  const signal = new AbortController().signal;
  const request = { recipientEmail: RECIPIENT, setupUrl: SETUP_URL, correlationKey: IDS.delivery };

  const first = await provider.send(request, signal);
  const replay = await provider.send(request, signal);

  assert.deepEqual(replay, first);
  assert.equal(provider.snapshot().length, 1);
  assertSecretSafe(provider.snapshot());
});
