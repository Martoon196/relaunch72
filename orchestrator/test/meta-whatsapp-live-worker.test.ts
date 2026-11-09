import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertMetaWhatsAppLiveCommandBoundaryReady,
  assertMetaWhatsAppLiveWebhookBoundaryReady,
  assertMetaWhatsAppLiveWorkerBoundaryReady,
} from '../src/whatsapp-live-pg/readiness.js';
import {
  loadMetaWhatsAppLiveWorkerConfig,
  startMetaWhatsAppLiveWorker,
} from '../src/workers/meta-whatsapp-live/runner.js';

const INSTALLATION = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';
const DATABASE_URL =
  'postgresql://r72_whatsapp_live_worker_command:secret@db.example/relaunch72?sslmode=require';
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

function darkEnv(): NodeJS.ProcessEnv {
  return { NODE_ENV: 'production', DATABASE_WHATSAPP_LIVE_WORKER_URL: DATABASE_URL,
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: INSTALLATION,
    PROPERTY_PREDATOR_WHATSAPP_LIVE_MODE: 'disabled',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'false',
    PROPERTY_PREDATOR_WHATSAPP_EMERGENCY_PAUSED: 'true' };
}

function activeEnv(): NodeJS.ProcessEnv {
  return { ...darkEnv(), PROPERTY_PREDATOR_WHATSAPP_LIVE_MODE: 'owned_template_live',
    PROPERTY_PREDATOR_WHATSAPP_LIVE_PROVIDER_ID: 'meta_whatsapp_cloud',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true',
    PROPERTY_PREDATOR_WHATSAPP_EMERGENCY_PAUSED: 'false',
    PROPERTY_PREDATOR_WHATSAPP_LIVE_WORKSPACE_ID: WORKSPACE,
    PROPERTY_PREDATOR_WHATSAPP_LIVE_CONNECTION_ID: CONNECTION,
    PROPERTY_PREDATOR_WHATSAPP_CREDENTIAL_ENCRYPTION_KEY_BASE64: ENCRYPTION_KEY,
    PROPERTY_PREDATOR_WHATSAPP_CREDENTIAL_ENCRYPTION_KEY_VERSION: 'render-kms-v1' };
}

test('worker defaults dark and rejects partial activation, extra identities and unrelated secrets', () => {
  const dark = loadMetaWhatsAppLiveWorkerConfig(darkEnv());
  assert.equal(dark.mode, 'disabled');
  assert.equal(dark.runtime.providerEffectsEnabled, false);
  assert.equal(dark.runtime.emergencyPaused, true);
  for (const patch of [
    { PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true' },
    { PROPERTY_PREDATOR_WHATSAPP_EMERGENCY_PAUSED: 'false' },
    { PROPERTY_PREDATOR_WHATSAPP_LIVE_MODE: 'owned_template_live' },
  ]) assert.throws(() => loadMetaWhatsAppLiveWorkerConfig({ ...darkEnv(), ...patch }));
  assert.throws(() => loadMetaWhatsAppLiveWorkerConfig({
    ...darkEnv(), DATABASE_WEB_URL: DATABASE_URL,
  }), /another database identity/u);
  for (const secret of ['META_ACCESS_TOKEN', 'PROPERTY_PREDATOR_META_WHATSAPP_APP_SECRET']) {
    assert.throws(() => loadMetaWhatsAppLiveWorkerConfig({
      ...darkEnv(), [secret]: 'must-never-enter-this-process',
    }), /unrelated secret/u);
  }
  assert.equal(loadMetaWhatsAppLiveWorkerConfig(activeEnv()).mode, 'owned_template_live');
});

test('dark startup proves DB truth without repository, adapter or provider call', async () => {
  const order: string[] = [];
  const readiness: string[] = [];
  const errors: string[] = [];
  let backgroundError: ((error: Error) => void) | undefined;
  let ended = 0;
  let repositoryCreations = 0;
  let transportCreations = 0;
  const runtime = await startMetaWhatsAppLiveWorker({
    env: darkEnv(), autoStart: false,
    createPool: (_env, hooks) => {
      backgroundError = hooks.onBackgroundError;
      return { query: async () => ({ rows: [] }), connect: async () => ({}),
        end: async () => { ended += 1; } } as never;
    },
    assertSchemaCurrent: async () => { order.push('schema'); },
    assertInstallationReady: async (_pool, expected) => {
      assert.equal(expected, INSTALLATION); order.push('installation');
    },
    assertBoundaryReady: async () => { order.push('boundary'); },
    createRepository: () => { repositoryCreations += 1; return {} as never; },
    createTransport: () => { transportCreations += 1; return {} as never; },
    writeReadiness: (line) => readiness.push(line),
    writeErrorTelemetry: (line) => errors.push(line),
  });
  assert.deepEqual(order, ['schema', 'installation', 'boundary']);
  assert.equal(repositoryCreations, 0);
  assert.equal(transportCreations, 0);
  assert.equal(runtime.readiness.provider.adapterInstantiatedAtReadiness, false);
  assert.equal(runtime.readiness.provider.networkCallsMadeAtReadiness, false);
  assert.equal(runtime.readiness.safety.dispatchLoopStarted, false);
  assert.equal(await runtime.runOnce(), 'disabled');
  assert.doesNotMatch(readiness[0] ?? '', /postgresql:|secret|token|render-kms/iu);
  backgroundError?.(new Error('postgresql://worker:credential@private.example/db'));
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0] ?? '', /credential|private[.]example|postgresql:/iu);
  await runtime.shutdown();
  assert.equal(ended, 1);
});

test('active startup makes no provider call and serializes one operation at a time', async () => {
  let cycles = 0;
  let transportCreations = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runtime = await startMetaWhatsAppLiveWorker({
    env: activeEnv(), autoStart: false,
    createPool: () => ({ query: async () => ({ rows: [] }), connect: async () => ({}),
      end: async () => undefined }) as never,
    assertSchemaCurrent: async () => undefined,
    assertInstallationReady: async () => undefined,
    assertBoundaryReady: async () => undefined,
    createRepository: () => ({}) as never,
    createTransport: () => { transportCreations += 1; return {} as never; },
    runCycle: async () => { cycles += 1; await gate; return 'idle'; },
    randomToken: () => Buffer.alloc(32, 9),
    writeReadiness: () => undefined,
  });
  assert.equal(transportCreations, 0, 'readiness must not instantiate Meta transport');
  assert.equal(runtime.readiness.provider.credentialEnvelopeLoadedAtReadiness, false);
  assert.equal(runtime.readiness.safety.dispatchLoopStarted, true);
  const first = runtime.runOnce();
  const second = runtime.runOnce();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(cycles, 1);
  release?.();
  assert.deepEqual(await Promise.all([first, second]), ['idle', 'idle']);
  await runtime.shutdown();
});

test('all three runtime probes require exact functions, table blindness and no elevated role', async () => {
  for (const [probe, role] of [
    [assertMetaWhatsAppLiveCommandBoundaryReady, 'r72_whatsapp_live_command'],
    [assertMetaWhatsAppLiveWorkerBoundaryReady, 'r72_whatsapp_live_worker_command'],
    [assertMetaWhatsAppLiveWebhookBoundaryReady, 'r72_whatsapp_live_webhook_command'],
  ] as const) {
    let sql = ''; let values: unknown[] = [];
    const exact = { exactRole: true, schemaUsage: true, allowedFunctionsReady: true,
      extraFunctionsDenied: true, tableBlind: true, elevatedRolesDenied: true };
    await probe({ async query(statement: string, supplied: unknown[]) {
      sql = statement; values = supplied; return { rows: [exact] } as never;
    } } as never);
    assert.match(sql, /has_function_privilege/u);
    assert.match(sql, /NOT EXISTS/u);
    assert.equal(values[0], role);
    assert.ok(values.includes('app_private.runtime_schema_migrations()'));
    await assert.rejects(probe({ async query() {
      return { rows: [{ ...exact, tableBlind: false }] } as never;
    } } as never), /database boundary is not exact/u);
  }
});
