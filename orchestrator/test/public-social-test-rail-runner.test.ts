import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { PublicSocialTestDispatchCycleResult } from '../src/social-campaign-pg/index.js';
import {
  loadPublicSocialTestRailConfig,
  redactedPublicSocialTestRailErrorClass,
  startPublicSocialTestRailRunner,
} from '../src/workers/public-social-test-rail/runner.js';

const INSTALLATION = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';
const OPERATION = '33333333-3333-4333-8333-333333333333';

function railEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_PUBLIC_SOCIAL_WORKER_URL:
      'postgresql://r72_public_social_worker_command:secret@database.example/relaunch72?sslmode=require',
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: INSTALLATION,
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_RAIL_ENVIRONMENT: 'test',
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_RAIL_PROVIDER_ID: 'public_social_dark_simulator',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'false',
    PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED: 'true',
    ...overrides,
  };
}

function fakePool(): {
  readonly pool: Pick<Pool, 'query' | 'connect' | 'end'>;
  readonly endCalls: () => number;
} {
  let ends = 0;
  return {
    pool: {
      async query() { throw new Error('unexpected direct query'); },
      async connect() { throw new Error('unexpected connect'); },
      async end() { ends += 1; },
    } as unknown as Pick<Pool, 'query' | 'connect' | 'end'>,
    endCalls: () => ends,
  };
}

const idle: PublicSocialTestDispatchCycleResult = Object.freeze({
  disposition: 'idle', operationId: null, state: null,
});
const settled: PublicSocialTestDispatchCycleResult = Object.freeze({
  disposition: 'settled', operationId: OPERATION, state: 'simulated_succeeded',
});

test('public-social TEST rail is exact, bounded and rejects every live-shaped input', () => {
  assert.deepEqual(loadPublicSocialTestRailConfig(railEnvironment()), {
    installationId: INSTALLATION,
    pollIntervalMs: 1_000,
  });
  assert.equal(loadPublicSocialTestRailConfig(railEnvironment({
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_RAIL_POLL_MS: '250',
  })).pollIntervalMs, 250);

  const refused: ReadonlyArray<readonly [string, NodeJS.ProcessEnv, RegExp]> = [
    ['live environment', { PROPERTY_PREDATOR_PUBLIC_SOCIAL_RAIL_ENVIRONMENT: 'live' }, /environment=test/],
    ['wrong provider', { PROPERTY_PREDATOR_PUBLIC_SOCIAL_RAIL_PROVIDER_ID: 'ayrshare' }, /public_social_dark_simulator/],
    ['provider effects', { PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true' }, /exactly false/],
    ['implicit provider effects', { PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: undefined }, /exactly false/],
    ['released pause', { PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED: 'false' }, /pause.*engaged/],
    ['missing worker URL', { DATABASE_PUBLIC_SOCIAL_WORKER_URL: undefined }, /DATABASE_PUBLIC_SOCIAL_WORKER_URL is required/],
    ['generic database', { DATABASE_URL: 'postgresql://owner:secret@database.example/relaunch72' }, /outside its exact worker role/],
    ['unrelated database', { DATABASE_WEB_URL: 'postgresql://r72_web:secret@database.example/relaunch72' }, /outside its exact worker role/],
    ['lowercase unrelated database', { database_web_url: 'postgresql://r72_web:secret@database.example/relaunch72' }, /outside its exact worker role/],
    ['bad installation', { PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: 'not-a-uuid' }, /installation identity/],
    ['fast spin', { PROPERTY_PREDATOR_PUBLIC_SOCIAL_RAIL_POLL_MS: '99' }, /100 to 60000/],
    ['slow spin', { PROPERTY_PREDATOR_PUBLIC_SOCIAL_RAIL_POLL_MS: '60001' }, /100 to 60000/],
    ['Ayrshare key', { AYRSHARE_API_KEY: 'secret' }, /provider or unrelated credential/],
    ['Meta token', { META_ACCESS_TOKEN: 'secret' }, /provider or unrelated credential/],
    ['lowercase Meta token', { meta_access_token: 'secret' }, /provider or unrelated credential/],
    ['mixed-case provider key', { AyrShare_Api_Key: 'secret' }, /provider or unrelated credential/],
    ['LinkedIn secret', { LINKEDIN_CLIENT_SECRET: 'secret' }, /provider or unrelated credential/],
    ['session secret', { SESSION_SECRET: 'secret' }, /provider or unrelated credential/],
  ];
  for (const [name, override, expected] of refused) {
    assert.throws(() => loadPublicSocialTestRailConfig(railEnvironment(override)), expected, name);
  }
});

test('runner is serial, reuses one lease, emits dark readiness and closes once', async () => {
  const database = fakePool();
  const output: string[] = [];
  const leases: Buffer[] = [];
  let calls = 0;
  const runtime = await startPublicSocialTestRailRunner({
    env: railEnvironment(),
    autoStart: false,
    createPool: () => database.pool,
    assertSchemaCurrent: async (pool) => { assert.equal(pool, database.pool); },
    assertInstallationReady: async (pool, installation) => {
      assert.equal(pool, database.pool);
      assert.equal(installation, INSTALLATION);
    },
    createLease: () => ({ workerId: WORKER, leaseToken: Buffer.alloc(32, 7) }),
    createDispatcher: () => ({ async runOnce(lease) {
      leases.push(Buffer.from(lease.leaseToken));
      calls += 1;
      return calls === 1 ? settled : idle;
    } }),
    writeReadiness: (line) => { output.push(line); },
  });

  assert.deepEqual(runtime.readiness.safety, {
    providerEffectsEnabled: false,
    emergencyPaused: true,
    reservedAccountsOnly: true,
    liveProviderAdapterLoaded: false,
    externalPublishAttempted: false,
  });
  assert.deepEqual(JSON.parse(output[0]!), runtime.readiness);
  assert.equal((await runtime.runOnce()).state, 'simulated_succeeded');
  assert.equal((await runtime.runOnce()).disposition, 'idle');
  assert.equal(leases.length, 2);
  assert.deepEqual(leases[0], leases[1]);

  const firstShutdown = runtime.shutdown();
  assert.equal(firstShutdown, runtime.shutdown());
  await firstShutdown;
  await runtime.stopped;
  assert.equal(database.endCalls(), 1);
  await assert.rejects(runtime.runOnce(), /is stopping/);
});

test('concurrent triggers share one in-flight cycle and shutdown drains it', async () => {
  const database = fakePool();
  let release: ((result: PublicSocialTestDispatchCycleResult) => void) | undefined;
  let calls = 0;
  const gate = new Promise<PublicSocialTestDispatchCycleResult>((resolve) => { release = resolve; });
  const runtime = await startPublicSocialTestRailRunner({
    env: railEnvironment(),
    autoStart: false,
    createPool: () => database.pool,
    assertSchemaCurrent: async () => undefined,
    assertInstallationReady: async () => undefined,
    createLease: () => ({ workerId: WORKER, leaseToken: Buffer.alloc(32, 9) }),
    createDispatcher: () => ({ runOnce: async () => { calls += 1; return gate; } }),
    writeReadiness: () => undefined,
  });
  const first = runtime.runOnce();
  const second = runtime.runOnce();
  assert.equal(first, second);
  assert.equal(calls, 1);
  const shutdown = runtime.shutdown();
  assert.equal(database.endCalls(), 0);
  release?.(settled);
  assert.equal((await first).state, 'simulated_succeeded');
  await shutdown;
  assert.equal(database.endCalls(), 1);
});

test('rail composition contains no transport, SDK, live registry or publishing language', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sources = [
    '../src/workers/public-social-test-rail/runner.ts',
    '../src/social-campaign-pg/test-provider.ts',
    '../src/social-campaign-pg/dispatcher.ts',
  ].map((relative) => fs.readFileSync(path.resolve(here, relative), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /from ['"](?:node:)?(?:http|https|net|tls|undici)['"]/u);
  assert.doesNotMatch(sources, /from ['"][^'"]*(?:ayrshare|hootsuite|buffer|facebook|linkedin|tiktok|twitter|instagram)[^'"]*['"]/iu);
  assert.doesNotMatch(sources, /providers\/registry/u);
  assert.doesNotMatch(sources, /\b(?:published|posted|delivered|sent)\b/iu);
  assert.match(sources, /externalPublishAttempted: false/u);
});

test('rail errors are reduced to fixed classes without leaking provider details', () => {
  assert.equal(redactedPublicSocialTestRailErrorClass(new TypeError('secret')), 'TypeError');
  assert.equal(redactedPublicSocialTestRailErrorClass(new Error('postgresql://user:secret@db/private')), 'Error');
  assert.equal(redactedPublicSocialTestRailErrorClass({ message: 'token=secret' }), 'Error');
});
