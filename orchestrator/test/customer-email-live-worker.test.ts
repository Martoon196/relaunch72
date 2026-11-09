import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadCustomerEmailLiveWorkerConfig,
  startCustomerEmailLiveWorker,
} from '../src/workers/customer-email-live/runner.js';

const INSTALLATION = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';
const DATABASE_URL =
  'postgresql://r72_customer_email_worker_command:secret@db.example/relaunch72?sslmode=require';

function darkEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DATABASE_CUSTOMER_EMAIL_WORKER_URL: DATABASE_URL,
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: INSTALLATION,
    PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_MODE: 'disabled',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'false',
    PROPERTY_PREDATOR_CUSTOMER_EMAIL_DELIVERY_ENABLED: 'false',
    PROPERTY_PREDATOR_CUSTOMER_EMAIL_EMERGENCY_PAUSED: 'true',
    PROPERTY_PREDATOR_CUSTOMER_EMAIL_RECEIPTS_CONFIRMED: 'false',
  };
}

function activeEnv(): NodeJS.ProcessEnv {
  return {
    ...darkEnv(),
    PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_MODE: 'customer_live',
    PROPERTY_PREDATOR_CUSTOMER_EMAIL_PROVIDER_ID: 'mailgun_eu',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true',
    PROPERTY_PREDATOR_CUSTOMER_EMAIL_DELIVERY_ENABLED: 'true',
    PROPERTY_PREDATOR_CUSTOMER_EMAIL_EMERGENCY_PAUSED: 'false',
    PROPERTY_PREDATOR_CUSTOMER_EMAIL_RECEIPTS_CONFIRMED: 'true',
    PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_WORKSPACE_ID: WORKSPACE,
    PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_CONNECTION_ID: CONNECTION,
    MAILGUN_REGION: 'eu',
    MAILGUN_SENDING_DOMAIN: 'mg.propertypredator.com',
    MAILGUN_KEY_SCOPE: 'domain-sending',
    MAILGUN_DOMAIN_SENDING_KEY: 'domain-sending-key-customer-001',
    MAILGUN_FROM_EMAIL: 'updates@mg.propertypredator.com',
  };
}

test('worker config is dark by default and active only for exact Mailgun EU binding', () => {
  const dark = loadCustomerEmailLiveWorkerConfig(darkEnv());
  assert.equal(dark.mode, 'disabled');
  assert.equal(dark.runtime.providerEffectsEnabled, false);
  assert.equal(dark.runtime.emailDeliveryEnabled, false);
  assert.equal(dark.runtime.emergencyPaused, true);

  const active = loadCustomerEmailLiveWorkerConfig(activeEnv());
  assert.equal(active.mode, 'customer_live');
  assert.equal(active.runtime.dailySendCap, 10);
  assert.equal(active.runtime.monthlySendCap, 50);
  assert.equal(active.runtime.receiptsConfirmed, true);

  for (const patch of [
    { PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true' },
    { PROPERTY_PREDATOR_CUSTOMER_EMAIL_DELIVERY_ENABLED: 'true' },
    { PROPERTY_PREDATOR_CUSTOMER_EMAIL_EMERGENCY_PAUSED: 'false' },
    { PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_MODE: 'customer_live' },
  ]) assert.throws(() => loadCustomerEmailLiveWorkerConfig({ ...darkEnv(), ...patch }));
  assert.throws(() => loadCustomerEmailLiveWorkerConfig({
    ...activeEnv(), MAILGUN_SENDING_DOMAIN: 'mail.example.com',
  }), /exact Mailgun EU domain-sending boundary/u);
  assert.throws(() => loadCustomerEmailLiveWorkerConfig({
    ...activeEnv(), DATABASE_WEB_URL: DATABASE_URL,
  }), /another database identity/u);
  assert.throws(() => loadCustomerEmailLiveWorkerConfig({
    ...activeEnv(), MAILGUN_SIGNING_KEY: 'must-remain-in-web-process',
  }), /unrelated secret|exact Mailgun/u);

  const missingReceipts = activeEnv();
  delete missingReceipts.PROPERTY_PREDATOR_CUSTOMER_EMAIL_RECEIPTS_CONFIRMED;
  assert.throws(() => loadCustomerEmailLiveWorkerConfig(missingReceipts));
  for (const value of ['false', 'TRUE', ' true ', 'yes']) {
    assert.throws(() => loadCustomerEmailLiveWorkerConfig({
      ...activeEnv(), PROPERTY_PREDATOR_CUSTOMER_EMAIL_RECEIPTS_CONFIRMED: value,
    }));
  }
});

test('dark worker proves database boundaries without constructing a provider adapter', async () => {
  const order: string[] = [];
  const readinessLines: string[] = [];
  const errorLines: string[] = [];
  let backgroundError: ((error: Error) => void) | undefined;
  let ended = 0;
  const runtime = await startCustomerEmailLiveWorker({
    env: darkEnv(),
    autoStart: false,
    createPool: (_env, hooks) => {
      backgroundError = hooks.onBackgroundError;
      return {
        query: async () => ({ rows: [] }),
        connect: async () => { throw new Error('dark mode must not acquire a worker client'); },
        end: async () => { ended += 1; },
      } as never;
    },
    assertSchemaCurrent: async () => { order.push('schema'); },
    assertInstallationReady: async (_pool, expected) => {
      assert.equal(expected, INSTALLATION); order.push('installation');
    },
    assertBoundaryReady: async () => { order.push('boundary'); },
    createRepository: () => { throw new Error('repository must stay uncomposed'); },
    createTransport: () => { throw new Error('adapter must stay unloaded'); },
    writeReadiness: (line) => readinessLines.push(line),
    writeErrorTelemetry: (line) => errorLines.push(line),
  });
  assert.deepEqual(order, ['schema', 'installation', 'boundary']);
  assert.equal(runtime.readiness.mode, 'disabled');
  assert.equal(runtime.readiness.provider.credentialsLoaded, false);
  assert.equal(runtime.readiness.provider.adapterInstantiated, false);
  assert.equal(runtime.readiness.provider.networkCallsMadeAtReadiness, false);
  assert.equal(runtime.readiness.receipts.operatorConfirmed, false);
  assert.equal(runtime.readiness.receipts.remoteHealthCheckedAtReadiness, false);
  assert.equal(runtime.readiness.safety.dispatchLoopStarted, false);
  assert.equal(await runtime.runOnce(), 'disabled');
  assert.equal(readinessLines.length, 1);
  assert.doesNotMatch(readinessLines[0] ?? '', /postgresql:|secret|DOMAIN_SENDING/u);
  backgroundError?.(new Error('postgresql://worker:credential@private.example/database'));
  assert.deepEqual(JSON.parse(errorLines[0] ?? '{}'), {
    schemaVersion: 1,
    event: 'worker_error',
    service: 'property-predator-customer-email-live',
    eventKind: 'background_database',
    count: 1,
    errorClass: 'Error',
  });
  await runtime.shutdown();
  assert.equal(ended, 1);
});

test('active worker makes no startup call and serializes one-at-a-time cycles', async () => {
  let cycleCalls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runtime = await startCustomerEmailLiveWorker({
    env: activeEnv(),
    autoStart: false,
    createPool: () => ({
      query: async () => ({ rows: [] }),
      connect: async () => { throw new Error('mock repository owns no SQL'); },
      end: async () => undefined,
    }) as never,
    assertSchemaCurrent: async () => undefined,
    assertInstallationReady: async () => undefined,
    assertBoundaryReady: async () => undefined,
    createRepository: () => ({}) as never,
    createTransport: () => ({}) as never,
    randomToken: () => Buffer.alloc(32, 7),
    runCycle: async () => {
      cycleCalls += 1;
      await gate;
      return 'idle';
    },
    writeReadiness: () => undefined,
  });
  assert.equal(cycleCalls, 0);
  assert.equal(runtime.readiness.provider.credentialsLoaded, true);
  assert.equal(runtime.readiness.provider.adapterInstantiated, true);
  assert.equal(runtime.readiness.provider.networkCallsMadeAtReadiness, false);
  assert.equal(runtime.readiness.receipts.operatorConfirmed, true);
  assert.equal(runtime.readiness.receipts.remoteHealthCheckedAtReadiness, false);
  assert.equal(runtime.readiness.polling.maximumOperationsPerCycle, 1);
  const first = runtime.runOnce();
  const second = runtime.runOnce();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(cycleCalls, 1);
  release?.();
  assert.deepEqual(await Promise.all([first, second]), ['idle', 'idle']);
  await runtime.shutdown();
});
