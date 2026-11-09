import assert from 'node:assert/strict';
import test from 'node:test';
import { assertZernioCalendarWorkerBoundaryReady } from '../src/owned-public-social-pg/readiness.js';
import {
  loadZernioCalendarWorkerConfig,
  startZernioCalendarLiveWorker,
} from '../src/workers/zernio-calendar-live/runner.js';

const INSTALLATION = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';
const DATABASE_URL =
  'postgresql://r72_owned_social_worker_command:secret@db.example/relaunch72?sslmode=require';
const INSTAGRAM = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const LINKEDIN = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const MEDIA_SIGNING_KEY = Buffer.alloc(32, 7).toString('base64url');

function darkEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DATABASE_OWNED_SOCIAL_WORKER_URL: DATABASE_URL,
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: INSTALLATION,
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_MODE: 'disabled',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'false',
    PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED: 'true',
  };
}

function activeEnv(): NodeJS.ProcessEnv {
  return {
    ...darkEnv(),
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_MODE: 'zernio_live',
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_PROVIDER_ID: 'zernio',
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_NETWORK: 'instagram_linkedin',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true',
    PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED: 'false',
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_WORKSPACE_ID: WORKSPACE,
    PROPERTY_PREDATOR_ZERNIO_LIVE_CONNECTION_ID: CONNECTION,
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_ORIGIN: 'https://hq.propertypredator.com',
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_SIGNING_KEY_BASE64URL: MEDIA_SIGNING_KEY,
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_URL_TTL_SECONDS: '900',
    PROPERTY_PREDATOR_ZERNIO_INSTAGRAM_ACCOUNT_ID: INSTAGRAM,
    PROPERTY_PREDATOR_ZERNIO_LINKEDIN_ACCOUNT_ID: LINKEDIN,
    ZERNIO_API_KEY: 'zernio-owned-test-key',
  };
}

test('worker config is dark by default and accepts only the explicit Zernio activation', () => {
  const config = loadZernioCalendarWorkerConfig(darkEnv());
  assert.equal(config.mode, 'disabled');
  assert.equal(config.runtime.providerEffectsEnabled, false);
  assert.equal(config.runtime.emergencyPaused, true);

  for (const patch of [
    { PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true' },
    { PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED: 'false' },
    { PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_MODE: 'zernio_live' },
  ]) {
    assert.throws(() => loadZernioCalendarWorkerConfig({ ...darkEnv(), ...patch }));
  }
  assert.throws(() => loadZernioCalendarWorkerConfig({
    ...activeEnv(), ZERNIO_API_KEY: undefined,
  }), /ZERNIO_API_KEY is unavailable/u);
  assert.throws(() => loadZernioCalendarWorkerConfig({
    ...activeEnv(), PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_SIGNING_KEY_BASE64URL: undefined,
  }), /invalid_configuration/u);
  assert.throws(() => loadZernioCalendarWorkerConfig({
    ...activeEnv(), PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_PROVIDER_ID: 'ayrshare',
  }));
  assert.throws(() => loadZernioCalendarWorkerConfig({
    ...activeEnv(), DATABASE_WEB_URL: DATABASE_URL,
  }), /another database identity/u);
  assert.throws(() => loadZernioCalendarWorkerConfig({
    ...activeEnv(), META_APP_SECRET: 'must-not-enter-this-process',
  }), /unrelated secret/u);
});

test('dark worker proves the new database boundary without loading a provider adapter', async () => {
  const order: string[] = [];
  const readinessLines: string[] = [];
  const errorLines: string[] = [];
  let backgroundError: ((error: Error) => void) | undefined;
  let ended = 0;
  const runtime = await startZernioCalendarLiveWorker({
    env: darkEnv(),
    autoStart: false,
    createPool: (_env, hooks) => {
      backgroundError = hooks.onBackgroundError;
      return {
        query: async () => ({ rows: [] }),
        end: async () => { ended += 1; },
      } as never;
    },
    assertSchemaCurrent: async () => { order.push('schema'); },
    assertInstallationReady: async (_pool, expected) => {
      assert.equal(expected, INSTALLATION);
      order.push('installation');
    },
    assertBoundaryReady: async () => { order.push('boundary'); },
    createPosting: () => { throw new Error('adapter must stay unloaded'); },
    writeReadiness: (line) => readinessLines.push(line),
    writeErrorTelemetry: (line) => errorLines.push(line),
  });
  assert.deepEqual(order, ['schema', 'installation', 'boundary']);
  assert.equal(runtime.readiness.mode, 'disabled');
  assert.equal(runtime.readiness.provider.adapterInstantiated, false);
  assert.equal(runtime.readiness.provider.networkCallsMadeAtReadiness, false);
  assert.equal(runtime.readiness.safety.dispatchLoopStarted, false);
  assert.equal(await runtime.runOnce(), 'disabled');
  assert.equal(readinessLines.length, 1);
  assert.doesNotMatch(readinessLines[0] ?? '', /postgresql:|secret|sk_[a-f0-9]/u);
  backgroundError?.(new Error('postgresql://worker:credential@private.example/database'));
  assert.equal(errorLines.length, 1);
  assert.doesNotMatch(errorLines[0] ?? '', /credential|private[.]example|postgresql:/u);
  await runtime.shutdown();
  assert.equal(ended, 1);
});

test('active worker composes both owned accounts without a startup provider call', async () => {
  let cycleCalls = 0;
  let createPostingCalls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runtime = await startZernioCalendarLiveWorker({
    env: activeEnv(),
    autoStart: false,
    createPool: () => ({
      query: async () => ({ rows: [] }),
      end: async () => undefined,
    }) as never,
    assertSchemaCurrent: async () => undefined,
    assertInstallationReady: async () => undefined,
    assertBoundaryReady: async () => undefined,
    createRepository: () => ({}) as never,
    createPosting: (input) => {
      createPostingCalls += 1;
      assert.deepEqual(input.accountBindings, [
        { network: 'instagram', providerAccountId: INSTAGRAM },
        { network: 'linkedin', providerAccountId: LINKEDIN },
      ]);
      return {} as never;
    },
    randomToken: () => Buffer.alloc(32, 9),
    runCycle: async () => {
      cycleCalls += 1;
      await gate;
      return 'idle';
    },
    writeReadiness: () => undefined,
  });
  assert.equal(createPostingCalls, 1);
  assert.equal(cycleCalls, 0, 'startup/readiness must make no provider call');
  assert.equal(runtime.readiness.provider.id, 'zernio');
  assert.equal(runtime.readiness.provider.accountsBound, 2);
  const first = runtime.runOnce();
  const second = runtime.runOnce();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(cycleCalls, 1);
  release?.();
  assert.deepEqual(await Promise.all([first, second]), ['idle', 'idle']);
  await runtime.shutdown();
});

test('default media resolver mints a short-lived signed URL without exposing the source path', async () => {
  let resolved: readonly string[] | undefined;
  const runtime = await startZernioCalendarLiveWorker({
    env: activeEnv(),
    autoStart: false,
    createPool: () => ({ query: async () => ({ rows: [] }), end: async () => undefined }) as never,
    assertSchemaCurrent: async () => undefined,
    assertInstallationReady: async () => undefined,
    assertBoundaryReady: async () => undefined,
    createRepository: () => ({}) as never,
    createPosting: () => ({}) as never,
    randomToken: () => Buffer.alloc(32, 9),
    runCycle: async (input) => {
      resolved = await input.mediaResolver.resolve({
        workspaceId: WORKSPACE,
        jobId: '44444444-4444-4444-8444-444444444444',
        media: Object.freeze([Object.freeze({
          storageKey: '/api/internal/company-content/assets/77777777-7777-4777-8777-777777777777/file',
          blobSha256: 'a'.repeat(64),
          mimeType: 'image/png',
        })]),
      });
      return 'idle';
    },
    writeReadiness: () => undefined,
  });
  await runtime.runOnce();
  assert.equal(resolved?.length, 1);
  const url = new URL(resolved?.[0] ?? '');
  assert.equal(url.origin, 'https://hq.propertypredator.com');
  assert.match(url.pathname, /^\/api\/public\/property-predator\/approved-media\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  assert.doesNotMatch(url.href, /api\/internal\/company-content|77777777-7777/u);
  await runtime.shutdown();
});

test('database boundary probe accepts only the 0085 Zernio worker functions', async () => {
  let sql = '';
  const exact = {
    exactRole: true,
    schemaUsage: true,
    claimExecute: true,
    beginExecute: true,
    loadExecute: true,
    settleExecute: true,
    ayrshareWorkerFunctionsDenied: true,
    zernioCommandFunctionsDenied: true,
    ayrshareCommandFunctionsDenied: true,
    ledgerExecute: true,
    installationExecute: true,
    tableBlind: true,
    elevatedRolesDenied: true,
  };
  await assertZernioCalendarWorkerBoundaryReady({
    async query(statement: string) {
      sql = statement;
      return { rows: [exact] } as never;
    },
  } as never);
  assert.match(sql, /claim_zernio_calendar_job/u);
  assert.match(sql, /settle_zernio_calendar_call/u);
  assert.match(sql, /NOT has_function_privilege[\s\S]*claim_owned_social_job_v2/u);
  assert.match(sql, /NOT has_function_privilege[\s\S]*record_zernio_calendar_publish_binding/u);
  for (const field of Object.keys(exact)) {
    await assert.rejects(assertZernioCalendarWorkerBoundaryReady({
      async query() { return { rows: [{ ...exact, [field]: false }] } as never; },
    } as never), /database boundary is not exact/u, `expected ${field}: false to be refused`);
  }
});
