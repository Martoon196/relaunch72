import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import {
  PROPERTY_PREDATOR_MAILGUN_WORKER_DATABASE_ROLE,
  redactedDarkEmailWorkerErrorClass,
  startPropertyPredatorDarkEmailWorker,
} from '../src/workers/property-predator-email/dark-worker.js';

const IDS = Object.freeze({
  workspace: '11111111-1111-4111-8111-111111111111',
  connection: '22222222-2222-4222-8222-222222222222',
  installation: '33333333-3333-4333-8333-333333333333',
});
const SECRET_DATABASE_URL =
  'postgresql://r72_mailgun_worker_command:dark-worker-secret@db.example.test/app?sslmode=require';
const schemaCurrent = async (): Promise<void> => undefined;

function darkEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DATABASE_MAILGUN_WORKER_URL: SECRET_DATABASE_URL,
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'false',
    PROPERTY_PREDATOR_EMAIL_DELIVERY_ENABLED: 'false',
    PROPERTY_PREDATOR_EMAIL_EMERGENCY_PAUSED: 'true',
    PROPERTY_PREDATOR_EMAIL_PROVIDER: 'mailgun',
    PROPERTY_PREDATOR_PILOT_WORKSPACE_ID: IDS.workspace,
    PROPERTY_PREDATOR_MAILGUN_CONNECTION_ID: IDS.connection,
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: IDS.installation,
    PROPERTY_PREDATOR_PILOT_STAGE: 'internal-seed',
    PROPERTY_PREDATOR_PILOT_RECIPIENT_SCOPE: 'owned-internal-seeds-only',
    PROPERTY_PREDATOR_PILOT_MAX_RECIPIENTS: '10',
    PROPERTY_PREDATOR_EMAIL_INTERNAL_SEEDS: 'owner@example.test,team@example.test',
    PROPERTY_PREDATOR_EMAIL_RUN_MESSAGE_CAP: '10',
    PROPERTY_PREDATOR_EMAIL_MONTHLY_MESSAGE_CAP: '100',
    PROPERTY_PREDATOR_EMAIL_ESTIMATED_RECIPIENT_COST_USD_MICROS: '10000',
    PROPERTY_PREDATOR_EMAIL_RUN_SPEND_CAP_USD_MICROS: '100000',
    PROPERTY_PREDATOR_EMAIL_MONTHLY_SPEND_CAP_USD_MICROS: '1000000',
    ...overrides,
  };
}

function fakePool(): Readonly<{
  pool: Pick<Pool, 'query' | 'end'>;
  endCalls: () => number;
}> {
  let ends = 0;
  const pool = {
    query: async (statement: string) => ({
      rows: statement.includes('runtime_database_installation_id')
        ? [{ installationId: IDS.installation }]
        : [{ ready: true }],
      rowCount: 1, command: 'SELECT', oid: 0, fields: [],
    }),
    end: async () => { ends += 1; },
  } as unknown as Pick<Pool, 'query' | 'end'>;
  return Object.freeze({ pool, endCalls: () => ends });
}

test('dark worker proves its exact boundary, emits redacted readiness, idles, and closes once', async () => {
  const database = fakePool();
  const output: string[] = [];
  let poolCreations = 0;
  const readinessOrder: string[] = [];
  let readinessProofs = 0;
  const runtime = await startPropertyPredatorDarkEmailWorker({
    env: darkEnvironment(),
    createPool: (env) => {
      poolCreations += 1;
      assert.equal(env.DATABASE_MAILGUN_WORKER_URL, SECRET_DATABASE_URL);
      return database.pool;
    },
    assertSchemaCurrent: async (pool) => {
      assert.equal(pool, database.pool);
      readinessOrder.push('schema');
    },
    assertInstallationReady: async (pool, expected) => {
      assert.equal(pool, database.pool);
      assert.equal(expected, IDS.installation);
      readinessOrder.push('installation');
    },
    assertBoundaryReady: async (pool) => {
      readinessProofs += 1;
      assert.equal(pool, database.pool);
      readinessOrder.push('boundary');
    },
    writeReadiness: (line) => { output.push(line); },
    keepAliveIntervalMs: 10,
  });

  assert.equal(poolCreations, 1);
  assert.equal(readinessProofs, 1);
  assert.deepEqual(readinessOrder, ['schema', 'installation', 'boundary']);
  assert.equal(output.length, 1);
  assert.equal(runtime.readiness.database.role, PROPERTY_PREDATOR_MAILGUN_WORKER_DATABASE_ROLE);
  assert.deepEqual(runtime.readiness.safety, {
    providerEffectsEnabled: false,
    emailDeliveryEnabled: false,
    emergencyPaused: true,
    dispatchLoopStarted: false,
    providerAdapterInstantiated: false,
    providerNetworkCallsMade: false,
  });
  assert.equal(runtime.readiness.pilot.configuredRecipientCount, 2);

  const rendered = output[0]!;
  for (const secret of [
    SECRET_DATABASE_URL,
    'dark-worker-secret',
    IDS.workspace,
    IDS.connection,
    IDS.installation,
    'owner@example.test',
    'team@example.test',
  ]) assert.equal(rendered.includes(secret), false);

  let stopped = false;
  void runtime.stopped.then(() => { stopped = true; });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(stopped, false, 'runtime must remain alive until shutdown');
  await Promise.all([runtime.shutdown(), runtime.shutdown()]);
  await runtime.stopped;
  assert.equal(stopped, true);
  assert.equal(database.endCalls(), 1);
});

test('dark worker refuses every live-switch or implicit-switch configuration before opening a pool', async (t) => {
  const unsafe: ReadonlyArray<readonly [string, NodeJS.ProcessEnv]> = [
    ['non-production mode', { NODE_ENV: 'development' }],
    ['enabled provider effects', { PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true' }],
    ['implicit provider effects', { PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: undefined }],
    ['enabled email delivery', { PROPERTY_PREDATOR_EMAIL_DELIVERY_ENABLED: 'true' }],
    ['implicit email delivery', { PROPERTY_PREDATOR_EMAIL_DELIVERY_ENABLED: undefined }],
    ['released emergency pause', { PROPERTY_PREDATOR_EMAIL_EMERGENCY_PAUSED: 'false' }],
    ['implicit emergency pause', { PROPERTY_PREDATOR_EMAIL_EMERGENCY_PAUSED: undefined }],
    ['missing database installation identity', { PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: undefined }],
  ];
  for (const [name, override] of unsafe) {
    await t.test(name, async () => {
      let poolCreations = 0;
      await assert.rejects(startPropertyPredatorDarkEmailWorker({
        env: darkEnvironment(override),
        createPool: () => {
          poolCreations += 1;
          return fakePool().pool;
        },
        writeReadiness: () => { throw new Error('must not emit readiness'); },
      }), /Dark email worker requires/);
      assert.equal(poolCreations, 0);
    });
  }
});

test('dark worker refuses generic, test, migrator, and unrelated role database URLs', async () => {
  for (const forbidden of [
    'DATABASE_URL',
    'TEST_DATABASE_URL',
    'DATABASE_MIGRATOR_URL',
    'DATABASE_WEB_URL',
    'DATABASE_MAILGUN_WEBHOOK_URL',
  ]) {
    let poolCreations = 0;
    await assert.rejects(startPropertyPredatorDarkEmailWorker({
      env: darkEnvironment({ [forbidden]: 'postgresql://wrong:secret@db.example.test/app' }),
      createPool: () => {
        poolCreations += 1;
        return fakePool().pool;
      },
    }), /database identity outside its isolated role/);
    assert.equal(poolCreations, 0, forbidden);
  }
});

test('dark worker refuses web, ingress, billing and legacy-provider secrets without echoing them', async () => {
  const forbidden = [
    'MAILGUN_SIGNING_KEY',
    'SESSION_SECRET',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'POSTMARK_SERVER_TOKEN',
    'BREVO_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
  ];
  for (const name of forbidden) {
    const secretValue = `unique-${name.toLowerCase()}-secret-value`;
    let poolCreations = 0;
    await assert.rejects(
      startPropertyPredatorDarkEmailWorker({
        env: darkEnvironment({ [name]: secretValue }),
        createPool: () => {
          poolCreations += 1;
          return fakePool().pool;
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /secret owned by another process/);
        assert.equal(error.message.includes(secretValue), false);
        return true;
      },
      name,
    );
    assert.equal(poolCreations, 0, name);
  }
});

test('a TLS CA bundle is allowed for verify-full database transport', async () => {
  const database = fakePool();
  const runtime = await startPropertyPredatorDarkEmailWorker({
    env: darkEnvironment({ DATABASE_SSL_CA: '-----BEGIN CERTIFICATE-----\nredacted\n-----END CERTIFICATE-----' }),
    createPool: () => database.pool,
    assertSchemaCurrent: schemaCurrent,
    assertBoundaryReady: async () => undefined,
    writeReadiness: () => undefined,
  });
  await runtime.shutdown();
  assert.equal(database.endCalls(), 1);
});

test('failed boundary readiness closes the isolated pool and emits no ready event', async () => {
  const database = fakePool();
  const output: string[] = [];
  await assert.rejects(startPropertyPredatorDarkEmailWorker({
    env: darkEnvironment(),
    createPool: () => database.pool,
    assertSchemaCurrent: schemaCurrent,
    assertBoundaryReady: async () => {
      throw new Error('database.internal.example.test leaked diagnostic');
    },
    writeReadiness: (line) => { output.push(line); },
  }), /leaked diagnostic/);
  assert.equal(database.endCalls(), 1);
  assert.deepEqual(output, []);
});

test('a stale migration ledger fails before boundary readiness and closes the pool', async () => {
  const database = fakePool();
  let boundaryChecks = 0;
  await assert.rejects(startPropertyPredatorDarkEmailWorker({
    env: darkEnvironment(),
    createPool: () => database.pool,
    assertSchemaCurrent: async () => {
      throw new Error('Database schema is not the reviewed release');
    },
    assertBoundaryReady: async () => { boundaryChecks += 1; },
    writeReadiness: () => { throw new Error('must not emit readiness'); },
  }), /not the reviewed release/);
  assert.equal(boundaryChecks, 0);
  assert.equal(database.endCalls(), 1);
});

test('background database diagnostics cross the worker boundary as an error class only', async () => {
  const database = fakePool();
  let backgroundHook: ((error: Error) => void) | undefined;
  const diagnostics: string[] = [];
  const runtime = await startPropertyPredatorDarkEmailWorker({
    env: darkEnvironment(),
    createPool: (_env, hooks) => {
      backgroundHook = hooks.onBackgroundError;
      return database.pool;
    },
    assertSchemaCurrent: schemaCurrent,
    assertBoundaryReady: async () => undefined,
    writeReadiness: () => undefined,
    onBackgroundDatabaseError: (errorName) => { diagnostics.push(errorName); },
  });
  backgroundHook?.(new Error(`${SECRET_DATABASE_URL} must never be rendered`));
  assert.deepEqual(diagnostics, ['Error']);
  assert.equal(diagnostics.join(' ').includes('secret'), false);
  await runtime.shutdown();
});

test('error-class redaction rejects attacker-controlled names', () => {
  const malicious = new Error('ordinary message');
  malicious.name = 'darkWorkerSecretFromProvider';
  assert.equal(redactedDarkEmailWorkerErrorClass(malicious), 'Error');
  const database = new Error('hidden');
  database.name = 'DatabaseError';
  assert.equal(redactedDarkEmailWorkerErrorClass(database), 'DatabaseError');
  assert.equal(redactedDarkEmailWorkerErrorClass('not an error'), 'Error');
});

test('a readiness-output failure closes the pool instead of leaving a dark worker alive', async () => {
  const database = fakePool();
  await assert.rejects(startPropertyPredatorDarkEmailWorker({
    env: darkEnvironment(),
    createPool: () => database.pool,
    assertSchemaCurrent: schemaCurrent,
    assertBoundaryReady: async () => undefined,
    writeReadiness: () => { throw new Error('output unavailable'); },
  }), /output unavailable/);
  assert.equal(database.endCalls(), 1);
});

test('worker composition cannot load a provider adapter or inspect the outbound key', () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url));
  const workerDirectory = path.join(
    testDirectory,
    '../src/workers/property-predator-email',
  );
  const source = fs.readdirSync(workerDirectory)
    .filter((filename) => filename.endsWith('.ts'))
    .map((filename) => fs.readFileSync(path.join(workerDirectory, filename), 'utf8'))
    .join('\n');
  assert.doesNotMatch(source, /MailgunEuHttpAdapter/);
  assert.doesNotMatch(source, /mailgun-eu-http-adapter/);
  assert.doesNotMatch(source, /MAILGUN_API_KEY/);
  assert.doesNotMatch(source, /\.dispatch\s*\(/);
  assert.doesNotMatch(source, /\.send\s*\(/);
});

test('root and workspace scripts name only the dedicated dark worker entrypoint', () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = path.resolve(testDirectory, '../..');
  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  const workspacePackage = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'orchestrator/package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  assert.equal(
    rootPackage.scripts['serve:property-predator-email-worker'],
    'npm run --workspace orchestrator serve:property-predator-email-worker',
  );
  assert.equal(
    workspacePackage.scripts['serve:property-predator-email-worker'],
    'tsx src/workers/property-predator-email/cli.ts',
  );
});
