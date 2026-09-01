import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertOwnedPublicSocialWorkerBoundaryReady,
} from '../src/owned-public-social-pg/readiness.js';
import {
  loadOwnedPublicSocialWorkerConfig,
  startOwnedPublicSocialLiveWorker,
} from '../src/workers/owned-public-social-live/runner.js';

const INSTALLATION = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';
const DATABASE_URL =
  'postgresql://r72_owned_social_worker_command:secret@db.example/relaunch72?sslmode=require';
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

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
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_MODE: 'owned_profile_live',
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_PROVIDER_ID: 'ayrshare',
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_NETWORK: 'x',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true',
    PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED: 'false',
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_WORKSPACE_ID: WORKSPACE,
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_CONNECTION_ID: CONNECTION,
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_PROFILE_ENCRYPTION_KEY_BASE64: ENCRYPTION_KEY,
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_PROFILE_ENCRYPTION_KEY_VERSION: 'render-kms-v1',
    AYRSHARE_API_KEY: 'ayrshare-api-key-owned-001',
    AYRSHARE_X_OAUTH1_API_KEY: 'x-oauth-api-key-owned-001',
    AYRSHARE_X_OAUTH1_API_SECRET: 'x-oauth-api-secret-owned-001',
  };
}

test('worker config defaults to a dark paused runtime and rejects mixed activation', () => {
  const config = loadOwnedPublicSocialWorkerConfig(darkEnv());
  assert.equal(config.mode, 'disabled');
  assert.equal(config.runtime.providerEffectsEnabled, false);
  assert.equal(config.runtime.emergencyPaused, true);

  for (const patch of [
    { PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true' },
    { PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED: 'false' },
    { PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_MODE: 'owned_profile_live' },
  ]) {
    assert.throws(() => loadOwnedPublicSocialWorkerConfig({ ...darkEnv(), ...patch }));
  }
  assert.throws(() => loadOwnedPublicSocialWorkerConfig({
    ...activeEnv(), AYRSHARE_API_KEY: undefined,
  }), /AYRSHARE_API_KEY is unavailable/u);
  assert.throws(() => loadOwnedPublicSocialWorkerConfig({
    ...activeEnv(),
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_NETWORK: 'instagram_linkedin',
  }), /PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_ORIGIN is required/u);
  assert.throws(() => loadOwnedPublicSocialWorkerConfig({
    ...activeEnv(),
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_NETWORK: 'instagram_linkedin',
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_ORIGIN: 'http://not-provider-fetchable.example',
  }), /PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_ORIGIN is invalid/u);
  assert.throws(() => loadOwnedPublicSocialWorkerConfig({
    ...darkEnv(), DATABASE_WEB_URL: DATABASE_URL,
  }), /another database identity/u);
  assert.throws(() => loadOwnedPublicSocialWorkerConfig({
    ...darkEnv(), META_APP_SECRET: 'must-not-enter-this-process',
  }), /unrelated secret/u);
});

test('dark worker proves database boundaries without loading a provider adapter', async () => {
  const order: string[] = [];
  const readinessLines: string[] = [];
  const errorLines: string[] = [];
  let backgroundError: ((error: Error) => void) | undefined;
  let ended = 0;
  const runtime = await startOwnedPublicSocialLiveWorker({
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
    createTransport: () => { throw new Error('adapter must stay unloaded'); },
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
  assert.doesNotMatch(readinessLines[0] ?? '', /postgresql:|secret|AYRSHARE/u);
  backgroundError?.(new Error('postgresql://worker:credential@private.example/database'));
  assert.equal(errorLines.length, 1);
  assert.deepEqual(JSON.parse(errorLines[0] ?? '{}'), {
    schemaVersion: 1,
    event: 'worker_error',
    service: 'property-predator-owned-public-social-live',
    eventKind: 'background_database',
    count: 1,
    errorClass: 'Error',
  });
  assert.doesNotMatch(errorLines[0] ?? '', /credential|private[.]example|postgresql:/u);
  await runtime.shutdown();
  assert.equal(ended, 1);
});

test('active worker composes without a startup provider call and serializes cycles', async () => {
  let cycleCalls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runtime = await startOwnedPublicSocialLiveWorker({
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
    createTransport: () => ({}) as never,
    randomToken: () => Buffer.alloc(32, 9),
    runCycle: async () => {
      cycleCalls += 1;
      await gate;
      return 'idle';
    },
    writeReadiness: () => undefined,
  });
  assert.equal(cycleCalls, 0, 'startup/readiness must make no provider call');
  assert.equal(runtime.readiness.provider.credentialsLoaded, true);
  assert.equal(runtime.readiness.provider.adapterInstantiated, true);
  assert.equal(runtime.readiness.provider.networkCallsMadeAtReadiness, false);
  const first = runtime.runOnce();
  const second = runtime.runOnce();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(cycleCalls, 1);
  release?.();
  assert.deepEqual(await Promise.all([first, second]), ['idle', 'idle']);
  await runtime.shutdown();
});

test('default media resolver turns the approved Property Predator asset route into one HTTPS URL', async () => {
  let resolved: readonly string[] | undefined;
  const runtime = await startOwnedPublicSocialLiveWorker({
    env: {
      ...activeEnv(),
      PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_NETWORK: 'instagram_linkedin',
      PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_ORIGIN: 'https://propertypredator.com',
    },
    autoStart: false,
    createPool: () => ({
      query: async () => ({ rows: [] }),
      end: async () => undefined,
    }) as never,
    assertSchemaCurrent: async () => undefined,
    assertInstallationReady: async () => undefined,
    assertBoundaryReady: async () => undefined,
    createRepository: () => ({}) as never,
    createTransport: () => ({}) as never,
    randomToken: () => Buffer.alloc(32, 9),
    runCycle: async (input) => {
      resolved = await input.mediaResolver?.resolve({
        workspaceId: WORKSPACE,
        jobId: '44444444-4444-4444-8444-444444444444',
        scheduledFor: '2026-09-02T09:30:00.000Z',
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
  assert.deepEqual(resolved, [
    'https://propertypredator.com/api/internal/company-content/assets/77777777-7777-4777-8777-777777777777/file',
  ]);
  await runtime.shutdown();
});

test('database boundary probe requires the exact worker functions and table blindness', async () => {
  let sql = '';
  const exact = {
    exactRole: true,
    schemaUsage: true,
    legacyClaimDenied: true,
    claimV2Execute: true,
    legacyLoadDenied: true,
    loadV2Execute: true,
    legacyBeginDenied: true,
    beginV2Execute: true,
    settleExecute: true,
    ledgerExecute: true,
    installationExecute: true,
    commandFunctionsDenied: true,
    commandV2FunctionsDenied: true,
    tableBlind: true,
    elevatedRolesDenied: true,
  };
  await assertOwnedPublicSocialWorkerBoundaryReady({
    async query(statement: string) {
      sql = statement;
      return { rows: [exact] } as never;
    },
  } as never);
  assert.match(
    sql,
    /'app_private\.claim_owned_social_job_v2\(uuid,uuid,text\[\],bytea,integer\)'/u,
  );
  assert.match(
    sql,
    /'app_private\.load_owned_social_job_v2\(uuid,uuid,bigint,bytea\)'/u,
  );
  assert.match(
    sql,
    /'app_private\.begin_owned_social_call_v2\(uuid,uuid,bigint,bytea,boolean,boolean\)'/u,
  );
  assert.match(
    sql,
    /NOT has_function_privilege\(\s*current_user,\s*'app_private\.claim_owned_social_job\(uuid,uuid,bytea,integer\)'/u,
  );
  assert.match(
    sql,
    /NOT has_function_privilege\(\s*current_user,\s*'app_private\.load_owned_social_job\(uuid,uuid,bigint,bytea\)'/u,
  );
  assert.match(
    sql,
    /NOT has_function_privilege\(\s*current_user,\s*'app_private\.begin_owned_social_call\(uuid,uuid,bigint,bytea,boolean,boolean\)'/u,
  );
  assert.match(
    sql,
    /NOT has_function_privilege\(\s*current_user,\s*'app_private\.record_owned_social_profile_v2\(/u,
  );
  assert.match(
    sql,
    /NOT has_function_privilege\(\s*current_user,\s*'app_private\.enqueue_owned_social_job_v2\(/u,
  );
  assert.match(sql, /runtime_schema_migrations/u);
  assert.match(sql, /NOT EXISTS/u);
  for (const field of Object.keys(exact)) {
    await assert.rejects(assertOwnedPublicSocialWorkerBoundaryReady({
      async query() { return { rows: [{ ...exact, [field]: false }] } as never; },
    } as never), /database boundary is not exact/u, `expected ${field}: false to be refused`);
  }
});
