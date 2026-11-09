import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { InboxDispatchCycleResult } from '../src/inbox-pg/index.js';
import {
  loadOmnichannelTestRailConfig,
  redactedOmnichannelTestRailErrorClass,
  startOmnichannelTestRailRunner,
} from '../src/workers/omnichannel-test-rail/runner.js';

const INSTALLATION = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';
const OPERATION = '33333333-3333-4333-8333-333333333333';

function railEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_WORKER_URL: 'postgresql://r72_worker:secret@database.example/relaunch72?sslmode=require',
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: INSTALLATION,
    PROPERTY_PREDATOR_OMNICHANNEL_RAIL_ENVIRONMENT: 'test',
    PROPERTY_PREDATOR_OMNICHANNEL_RAIL_PROVIDER_ID: 'test_conversation',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'false',
    PROPERTY_PREDATOR_EMAIL_EMERGENCY_PAUSED: 'true',
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

const idle: InboxDispatchCycleResult = Object.freeze({
  disposition: 'idle', operationId: null, operationState: null, deliveryStatus: null,
});
const settled: InboxDispatchCycleResult = Object.freeze({
  disposition: 'settled', operationId: OPERATION,
  operationState: 'succeeded', deliveryStatus: 'accepted',
});

test('test rail policy is explicit, bounded and worker-database-only', () => {
  assert.deepEqual(loadOmnichannelTestRailConfig(railEnvironment()), {
    installationId: INSTALLATION,
    pollIntervalMs: 1_000,
  });
  assert.equal(loadOmnichannelTestRailConfig(railEnvironment({
    PROPERTY_PREDATOR_OMNICHANNEL_RAIL_POLL_MS: '250',
  })).pollIntervalMs, 250);

  const refused: ReadonlyArray<readonly [string, NodeJS.ProcessEnv, RegExp]> = [
    ['live environment', { PROPERTY_PREDATOR_OMNICHANNEL_RAIL_ENVIRONMENT: 'live' }, /environment=test/],
    ['wrong provider', { PROPERTY_PREDATOR_OMNICHANNEL_RAIL_PROVIDER_ID: 'mailgun' }, /provider_id=test_conversation/],
    ['provider effects', { PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true' }, /exactly false/],
    ['implicit provider effects', { PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: undefined }, /exactly false/],
    ['non-canonical provider effects', { PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'FALSE' }, /exactly false/],
    ['released pause', { PROPERTY_PREDATOR_EMAIL_EMERGENCY_PAUSED: 'false' }, /pause.*engaged/],
    ['implicit pause', { PROPERTY_PREDATOR_EMAIL_EMERGENCY_PAUSED: undefined }, /pause.*engaged/],
    ['missing worker URL', { DATABASE_WORKER_URL: undefined }, /DATABASE_WORKER_URL is required/],
    ['generic database', { DATABASE_URL: 'postgresql://owner:secret@database.example/relaunch72' }, /outside r72_worker/],
    ['test owner database', { TEST_DATABASE_URL: 'postgresql://owner:secret@database.example/test' }, /outside r72_worker/],
    ['unrelated role', { DATABASE_WEB_URL: 'postgresql://r72_web:secret@database.example/relaunch72' }, /outside r72_worker/],
    ['bad installation', { PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: 'not-a-uuid' }, /installation identity/],
    ['fast spin', { PROPERTY_PREDATOR_OMNICHANNEL_RAIL_POLL_MS: '99' }, /100 to 60000/],
    ['slow spin', { PROPERTY_PREDATOR_OMNICHANNEL_RAIL_POLL_MS: '60001' }, /100 to 60000/],
    ['Mailgun credential', { MAILGUN_API_KEY: 'key-secret' }, /credential outside/],
    ['Twilio credential', { TWILIO_AUTH_TOKEN: 'token-secret' }, /credential outside/],
    ['Meta credential', { META_ACCESS_TOKEN: 'token-secret' }, /credential outside/],
    ['Ayrshare credential', { AYRSHARE_API_KEY: 'key-secret' }, /credential outside/],
    ['Zernio credential', { ZERNIO_API_KEY: 'key-secret' }, /credential outside/],
    ['social OAuth credential', { SOCIAL_OAUTH_TOKEN: 'token-secret' }, /credential outside/],
    ['Postmark credential', { POSTMARK_SERVER_TOKEN: 'token-secret' }, /credential outside/],
    ['Brevo credential', { BREVO_API_KEY: 'key-secret' }, /credential outside/],
    ['ambient GitHub credential', { GITHUB_TOKEN: 'token-secret' }, /credential outside/],
    ['web session credential', { SESSION_SECRET: 'session-secret' }, /credential outside/],
    ['AWS access credential', { AWS_SECRET_ACCESS_KEY: 'access-secret' }, /credential outside/],
    ['SendGrid credential', { SENDGRID_KEY: 'sendgrid-secret' }, /credential outside/],
    ['Google credential file', { GOOGLE_APPLICATION_CREDENTIALS: 'credential-path' }, /credential outside/],
  ];
  for (const [name, override, message] of refused) {
    assert.throws(() => loadOmnichannelTestRailConfig(railEnvironment(override)), message, name);
  }
});

test('runner composes one bounded serial rail and closes the worker pool once', async () => {
  const database = fakePool();
  const output: string[] = [];
  const leases: Array<{ workerId: string; token: Buffer }> = [];
  let schemaChecks = 0;
  let installationChecks = 0;
  let calls = 0;
  const runtime = await startOmnichannelTestRailRunner({
    env: railEnvironment(),
    autoStart: false,
    createPool: () => database.pool,
    assertSchemaCurrent: async (pool) => {
      assert.equal(pool, database.pool);
      schemaChecks += 1;
    },
    assertInstallationReady: async (pool, installationId) => {
      assert.equal(pool, database.pool);
      assert.equal(installationId, INSTALLATION);
      installationChecks += 1;
    },
    createLease: () => ({ workerId: WORKER, leaseToken: Buffer.alloc(32, 7) }),
    createDispatcher: (pool) => {
      assert.equal(pool, database.pool);
      return { async runOnce(lease) {
        leases.push({ workerId: lease.workerId, token: Buffer.from(lease.leaseToken) });
        calls += 1;
        return calls === 1 ? settled : idle;
      } };
    },
    writeReadiness: (line) => { output.push(line); },
  });

  assert.equal(schemaChecks, 1);
  assert.equal(installationChecks, 1);
  assert.deepEqual(runtime.readiness.polling, {
    intervalMs: 1_000, maximumOperationsPerCycle: 1,
    leaseSeconds: 60, overlappingCycles: false,
  });
  assert.deepEqual(runtime.readiness.safety, {
    providerEffectsEnabled: false, emergencyPaused: true,
    reservedDestinationsOnly: true, liveProviderAdapterLoaded: false,
  });
  assert.deepEqual(JSON.parse(output[0]!), runtime.readiness);
  assert.equal((await runtime.runOnce()).deliveryStatus, 'accepted');
  assert.equal((await runtime.runOnce()).disposition, 'idle');
  assert.equal(leases.length, 2);
  assert.equal(leases[0]!.workerId, WORKER);
  assert.deepEqual(leases[0]!.token, leases[1]!.token);

  const firstShutdown = runtime.shutdown();
  const secondShutdown = runtime.shutdown();
  assert.equal(firstShutdown, secondShutdown);
  await firstShutdown;
  await runtime.stopped;
  assert.equal(database.endCalls(), 1);
  await assert.rejects(runtime.runOnce(), /is stopping/);
});

test('default composition instantiates the existing PostgreSQL queue, reader and test provider', async () => {
  const database = fakePool();
  const runtime = await startOmnichannelTestRailRunner({
    env: railEnvironment(), autoStart: false,
    createPool: () => database.pool,
    assertSchemaCurrent: async () => undefined,
    assertInstallationReady: async () => undefined,
    createLease: () => ({ workerId: WORKER, leaseToken: Buffer.alloc(32, 5) }),
    writeReadiness: () => undefined,
  });
  assert.equal(runtime.readiness.providerId, 'test_conversation');
  await runtime.shutdown();
  assert.equal(database.endCalls(), 1);
});

test('concurrent triggers share one in-flight claim and shutdown drains it', async () => {
  const database = fakePool();
  let release: ((result: InboxDispatchCycleResult) => void) | undefined;
  let calls = 0;
  const gate = new Promise<InboxDispatchCycleResult>((resolve) => { release = resolve; });
  const runtime = await startOmnichannelTestRailRunner({
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
  assert.equal((await first).deliveryStatus, 'accepted');
  await shutdown;
  assert.equal(database.endCalls(), 1);
});

test('auto-start continues after a redacted cycle error and shutdown cancels future ticks', async () => {
  const database = fakePool();
  let calls = 0;
  let cycleErrors = 0;
  let resolveSecond: (() => void) | undefined;
  const secondCycle = new Promise<void>((resolve) => { resolveSecond = resolve; });
  const runtime = await startOmnichannelTestRailRunner({
    env: railEnvironment({ PROPERTY_PREDATOR_OMNICHANNEL_RAIL_POLL_MS: '100' }),
    createPool: () => database.pool,
    assertSchemaCurrent: async () => undefined,
    assertInstallationReady: async () => undefined,
    createLease: () => ({ workerId: WORKER, leaseToken: Buffer.alloc(32, 8) }),
    createDispatcher: () => ({ runOnce: async () => {
      calls += 1;
      if (calls === 1) throw new Error('simulated cycle failure');
      resolveSecond?.();
      return idle;
    } }),
    writeReadiness: () => undefined,
    onCycleError: () => { cycleErrors += 1; },
  });
  await secondCycle;
  await runtime.shutdown();
  const callsAtShutdown = calls;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(cycleErrors, 1);
  assert.equal(calls, callsAtShutdown);
  assert.equal(database.endCalls(), 1);
});

test('shutdown before the initial auto-start tick prevents a claim', async () => {
  const database = fakePool();
  let calls = 0;
  const runtime = await startOmnichannelTestRailRunner({
    env: railEnvironment(),
    createPool: () => database.pool,
    assertSchemaCurrent: async () => undefined,
    assertInstallationReady: async () => undefined,
    createLease: () => ({ workerId: WORKER, leaseToken: Buffer.alloc(32, 6) }),
    createDispatcher: () => ({ runOnce: async () => { calls += 1; return idle; } }),
    writeReadiness: () => undefined,
  });
  await runtime.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0);
  assert.equal(database.endCalls(), 1);
});

test('readiness failures close the pool before dispatcher composition', async () => {
  const database = fakePool();
  let composed = false;
  await assert.rejects(startOmnichannelTestRailRunner({
    env: railEnvironment(),
    createPool: () => database.pool,
    assertSchemaCurrent: async () => { throw new Error('stale schema'); },
    createDispatcher: () => { composed = true; return { runOnce: async () => idle }; },
    writeReadiness: () => { throw new Error('must not emit'); },
  }), /stale schema/);
  assert.equal(composed, false);
  assert.equal(database.endCalls(), 1);
});

test('post-readiness composition failures close the worker pool', async () => {
  for (const [name, composition] of [
    ['dispatcher factory', {
      createDispatcher: () => { throw new Error('dispatcher refused'); },
    }],
    ['lease factory', {
      createDispatcher: () => ({ runOnce: async () => idle }),
      createLease: () => ({ workerId: 'invalid', leaseToken: Buffer.alloc(3) }),
    }],
  ] as const) {
    const database = fakePool();
    await assert.rejects(startOmnichannelTestRailRunner({
      env: railEnvironment(), autoStart: false,
      createPool: () => database.pool,
      assertSchemaCurrent: async () => undefined,
      assertInstallationReady: async () => undefined,
      writeReadiness: () => { throw new Error('must not emit'); },
      ...composition,
    }), name === 'dispatcher factory' ? /dispatcher refused/ : /lease identity is invalid/);
    assert.equal(database.endCalls(), 1, name);
  }
});

test('shutdown closes PostgreSQL even when the in-flight cycle rejects', async () => {
  const database = fakePool();
  let rejectCycle: ((error: Error) => void) | undefined;
  const gate = new Promise<InboxDispatchCycleResult>((_resolve, reject) => {
    rejectCycle = reject;
  });
  const runtime = await startOmnichannelTestRailRunner({
    env: railEnvironment(), autoStart: false,
    createPool: () => database.pool,
    assertSchemaCurrent: async () => undefined,
    assertInstallationReady: async () => undefined,
    createLease: () => ({ workerId: WORKER, leaseToken: Buffer.alloc(32, 4) }),
    createDispatcher: () => ({ runOnce: async () => gate }),
    writeReadiness: () => undefined,
  });
  const cycle = runtime.runOnce();
  const shutdown = runtime.shutdown();
  rejectCycle?.(new Error('simulated cycle rejection'));
  await assert.rejects(cycle, /simulated cycle rejection/);
  await assert.rejects(shutdown, /simulated cycle rejection/);
  await runtime.stopped;
  assert.equal(database.endCalls(), 1);
});

test('runner imports only the database queue, existing dispatcher and in-process test provider', () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url));
  const workerDirectory = path.join(testDirectory, '../src/workers/omnichannel-test-rail');
  const source = fs.readdirSync(workerDirectory)
    .filter((filename) => filename.endsWith('.ts'))
    .map((filename) => fs.readFileSync(path.join(workerDirectory, filename), 'utf8'))
    .join('\n');
  assert.match(source, /PgProviderOperationQueue/);
  assert.match(source, /PgInboxDispatchReader/);
  assert.match(source, /TestConversationProvider/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /from ['"]node:(?:http|https|net|tls|dgram)['"]/);
  assert.doesNotMatch(source, /from ['"][^'"]*(?:mailgun|twilio|stripe|whatsapp|social-registry|provider-registry)[^'"]*['"]/i);
  for (const dependency of [
    '../src/inbox-pg/dispatcher.ts',
    '../src/inbox-pg/test-provider.ts',
    '../src/provider-operations-pg/queue.ts',
  ]) {
    const dependencySource = fs.readFileSync(path.join(testDirectory, dependency), 'utf8');
    assert.doesNotMatch(dependencySource, /\bfetch\s*\(/, dependency);
    assert.doesNotMatch(
      dependencySource,
      /from ['"]node:(?:http|https|net|tls|dgram)['"]/,
      dependency,
    );
  }
  const databaseConfig = fs.readFileSync(
    path.join(testDirectory, '../src/db/config.ts'),
    'utf8',
  );
  assert.doesNotMatch(databaseConfig, /^import ['"]\.\.\/config\.js['"];?$/m);
  const migrationCli = fs.readFileSync(
    path.join(testDirectory, '../src/db/migrate.ts'),
    'utf8',
  );
  assert.match(migrationCli, /await import\(['"]\.\.\/config\.js['"]\)/);
});

test('root and workspace expose only the isolated test-rail entrypoint', () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = path.resolve(testDirectory, '../..');
  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  const workspacePackage = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'orchestrator/package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  assert.equal(
    rootPackage.scripts['serve:omnichannel-test-rail'],
    'npm run --workspace orchestrator serve:omnichannel-test-rail',
  );
  assert.equal(
    workspacePackage.scripts['serve:omnichannel-test-rail'],
    'tsx src/workers/omnichannel-test-rail/cli.ts',
  );
});

test('error telemetry is reduced to fixed classes', () => {
  const attacker = new Error('postgresql://r72_worker:password@database.example/private');
  attacker.name = 'SecretBearingProviderFailure';
  assert.equal(redactedOmnichannelTestRailErrorClass(attacker), 'Error');
  const database = new Error('hidden');
  database.name = 'DatabaseError';
  assert.equal(redactedOmnichannelTestRailErrorClass(database), 'DatabaseError');
});
