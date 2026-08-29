import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadTwilioSmsWorkerConfig,
  startTwilioSmsLiveWorker,
} from '../src/workers/twilio-sms-live/runner.js';

const INSTALLATION = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';
const DATABASE_URL =
  'postgresql://r72_sms_worker_command:secret@db.example/relaunch72?sslmode=require';

function darkEnv(): NodeJS.ProcessEnv {
  return { NODE_ENV: 'production', DATABASE_SMS_WORKER_URL: DATABASE_URL,
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: INSTALLATION,
    PROPERTY_PREDATOR_SMS_LIVE_MODE: 'disabled',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'false',
    PROPERTY_PREDATOR_SMS_DELIVERY_ENABLED: 'false',
    PROPERTY_PREDATOR_SMS_EMERGENCY_PAUSED: 'true' };
}

function activeEnv(): NodeJS.ProcessEnv {
  return { ...darkEnv(), PROPERTY_PREDATOR_SMS_LIVE_MODE: 'owned_number_live',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true',
    PROPERTY_PREDATOR_SMS_DELIVERY_ENABLED: 'true',
    PROPERTY_PREDATOR_SMS_EMERGENCY_PAUSED: 'false',
    PROPERTY_PREDATOR_SMS_RECEIPTS_CONFIRMED: 'true',
    PROPERTY_PREDATOR_SMS_PROVIDER_ID: 'twilio_messaging',
    PROPERTY_PREDATOR_SMS_SENDER_NUMBER: '+447700900999',
    PROPERTY_PREDATOR_SMS_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
    PROPERTY_PREDATOR_SMS_LIVE_WORKSPACE_ID: WORKSPACE,
    PROPERTY_PREDATOR_SMS_LIVE_CONNECTION_ID: CONNECTION,
    TWILIO_KEY_SCOPE: 'restricted-api-key', TWILIO_API_KEY_SID: `SK${'2'.repeat(32)}`,
    TWILIO_API_KEY_SECRET: 'restricted-test-secret-123456',
    TWILIO_MESSAGING_SERVICE_SID: `MG${'3'.repeat(32)}` };
}

test('worker defaults disabled and rejects secret or database identity crossover', () => {
  assert.equal(loadTwilioSmsWorkerConfig(darkEnv()).mode, 'disabled');
  for (const patch of [
    { DATABASE_WEB_URL: DATABASE_URL },
    { TWILIO_AUTH_TOKEN: 'webhook-token-must-not-enter-worker' },
    { SESSION_SECRET: 'unrelated-secret-must-not-enter-worker' },
  ]) assert.throws(() => loadTwilioSmsWorkerConfig({ ...darkEnv(), ...patch }),
    /another database identity|unrelated secret/u);
  assert.equal(loadTwilioSmsWorkerConfig(activeEnv()).mode, 'owned_number_live');
});

test('dark startup proves DB truth without repository, adapter or provider call', async () => {
  const order: string[] = []; let repositories = 0; let transports = 0; let ended = 0;
  const readiness: string[] = [];
  const runtime = await startTwilioSmsLiveWorker({ env: darkEnv(),
    createPool: () => ({ query: async () => ({ rows: [] }), connect: async () => ({}),
      end: async () => { ended += 1; } }) as never,
    assertSchemaCurrent: async () => { order.push('schema'); },
    assertInstallationReady: async (_pool, expected) => {
      assert.equal(expected, INSTALLATION); order.push('installation');
    },
    assertBoundaryReady: async () => { order.push('boundary'); },
    createRepository: () => { repositories += 1; return {} as never; },
    createTransport: () => { transports += 1; return {} as never; },
    writeReadiness: (line) => readiness.push(line),
  });
  assert.deepEqual(order, ['schema', 'installation', 'boundary']);
  assert.equal(repositories, 0); assert.equal(transports, 0);
  assert.equal(runtime.readiness.provider.networkCallsMadeAtReadiness, false);
  assert.equal(runtime.readiness.safety.dispatchLoopStarted, false);
  assert.equal(await runtime.runOnce(), 'disabled');
  assert.doesNotMatch(readiness[0] ?? '', /postgresql:|secret|token/iu);
  await runtime.shutdown(); assert.equal(ended, 1);
});

test('active worker creates no startup call and serializes overlapping cycles', async () => {
  let claims = 0; let sends = 0; let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runtime = await startTwilioSmsLiveWorker({ env: activeEnv(),
    createPool: () => ({ query: async () => ({ rows: [] }), connect: async () => ({}),
      end: async () => undefined }) as never,
    assertSchemaCurrent: async () => undefined,
    assertInstallationReady: async () => undefined,
    assertBoundaryReady: async () => undefined,
    createRepository: () => ({
      async claimOne() { claims += 1; await gate; return null; },
    }) as never,
    createTransport: () => ({ contract: 'propertypredator.twilio-sms-live/v1',
      providerId: 'twilio_messaging', async send() { sends += 1; throw new Error('not called'); } }),
    writeReadiness: () => undefined,
  });
  assert.equal(claims, 0); assert.equal(sends, 0);
  assert.equal(runtime.readiness.provider.networkCallsMadeAtReadiness, false);
  const first = runtime.runOnce(); const second = runtime.runOnce();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(claims, 1);
  release?.();
  assert.deepEqual(await Promise.all([first, second]), ['idle', 'idle']);
  assert.equal(sends, 0);
  await runtime.shutdown();
});
