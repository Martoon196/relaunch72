import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  loadDatabaseConfig,
} from '../src/db/config.js';
import {
  createPublicSocialCommandDatabasePool,
  createPublicSocialWorkerCommandDatabasePool,
} from '../src/db/pool.js';

const platformUrl = new URL('../src/portal/postgres-platform.ts', import.meta.url);
const provisionUrl = new URL('../src/portal/provision.ts', import.meta.url);
const serverUrl = new URL('../src/server/index.ts', import.meta.url);

function compact(source: string): string {
  return source.replace(/\s+/gu, ' ').trim();
}

test('public-social web composition is optional and fails closed around its exact command role', async () => {
  const source = compact(await readFile(platformUrl, 'utf8'));
  const start = source.indexOf("if (env.DATABASE_PUBLIC_SOCIAL_COMMAND_URL?.trim())");
  const end = source.indexOf('let closed = false;', start);
  assert.notEqual(start, -1, 'the optional public-social environment gate must exist');
  assert.notEqual(end, -1, 'the public-social composition block must remain bounded');
  const block = source.slice(start, end);

  assert.match(
    block,
    /requireCutoverIdentity\( loadDatabaseConfig\('publicSocialCommand', env\), 'DATABASE_PUBLIC_SOCIAL_COMMAND_URL', 'r72_public_social_command', \)/,
  );
  assert.match(block, /publicSocialCommandPool = createDatabasePool\(publicSocialCommandConfig\)/);
  assert.match(
    block,
    /assertExpectedDatabaseInstallation\(publicSocialCommandPool, expectedInstallationId\)/,
  );
  assert.match(
    block,
    /SELECT app_private\.public_social_campaign_boundary_ready\(\) AS ready/,
  );
  assert.match(block, /ready\.rows\.length !== 1 \|\| ready\.rows\[0\]\?\.ready !== true/);
  assert.match(
    block,
    /createPgPortalPublicSocialService\(\{ webPool, publicSocialCommandPool, \}\)/,
  );

  const installationCheck = block.indexOf(
    'assertExpectedDatabaseInstallation(publicSocialCommandPool, expectedInstallationId)',
  );
  const boundaryCheck = block.indexOf(
    'SELECT app_private.public_social_campaign_boundary_ready() AS ready',
  );
  const exposure = block.indexOf('publicSocial = createPgPortalPublicSocialService');
  const retainedPool = block.indexOf('pools.push(publicSocialCommandPool)');
  assert.ok(installationCheck < boundaryCheck, 'installation identity must be pinned before readiness');
  assert.ok(boundaryCheck < exposure, 'the service must not compose before boundary readiness');
  assert.ok(exposure < retainedPool, 'only a successfully composed pool may join platform lifecycle');

  assert.match(block, /catch \{ await publicSocialCommandPool\?\.end\(\)\.catch\(\(\) => undefined\)/);
  assert.match(block, /publicSocial = undefined/);
  assert.match(block, /publicSocialReadinessPool = undefined/);
  assert.doesNotMatch(block, /throw new Error\('Property Predator production public-social/);
});

test('public-social readiness remains installation-pinned and is rechecked at runtime', async () => {
  const source = compact(await readFile(platformUrl, 'utf8'));

  assert.match(source, /publicSocial\?: PgPortalPublicSocialService/);
  assert.match(source, /publicSocialReadinessPool = publicSocialCommandPool/);
  assert.match(
    source,
    /publicSocialReadinessPool \? \[assertExpectedDatabaseInstallation\(publicSocialReadinessPool, expectedInstallationId\)\] : \[\]/,
  );
  assert.match(
    source,
    /portal\.public-social-runtime-readiness \*\/ SELECT app_private\.public_social_campaign_boundary_ready\(\) AS ready/,
  );
  assert.match(
    source,
    /if \(result\.rows\.length !== 1 \|\| result\.rows\[0\]\?\.ready !== true\) \{ throw new Error\('Public-social TEST boundary is not ready'\)/,
  );

  // The web process owns planning only. Worker credentials must remain in the
  // separately launched dark worker and must never be loaded by portal/server composition.
  assert.doesNotMatch(source, /publicSocialWorkerCommand|DATABASE_PUBLIC_SOCIAL_WORKER_URL/);
  const server = await readFile(serverUrl, 'utf8');
  assert.doesNotMatch(server, /createPublicSocialWorkerCommandDatabasePool|DATABASE_PUBLIC_SOCIAL_WORKER_URL/);
});

test('public-social composition is propagated unchanged through provision and server wiring', async () => {
  const provision = compact(await readFile(provisionUrl, 'utf8'));
  const server = compact(await readFile(serverUrl, 'utf8'));

  assert.match(
    provision,
    /publicSocial\?: NonNullable<PostgresPortalDeps\['publicSocial'\]>/,
  );
  assert.match(provision, /publicSocial: cfg\.publicSocial/);
  assert.match(server, /publicSocial: postgresPortal\.publicSocial/);
});

test('portal planning and dark execution pools are physically separate verified identities', async () => {
  const commandEnv = {
    DATABASE_PUBLIC_SOCIAL_COMMAND_URL:
      'postgresql://r72_public_social_command:secret@localhost/growth_hq_test?sslmode=disable',
    DATABASE_PUBLIC_SOCIAL_COMMAND_POOL_MAX: '2',
  };
  const workerEnv = {
    DATABASE_PUBLIC_SOCIAL_WORKER_URL:
      'postgresql://r72_public_social_worker_command:secret@localhost/growth_hq_test?sslmode=disable',
    DATABASE_PUBLIC_SOCIAL_WORKER_POOL_MAX: '3',
  };
  const commandConfig = loadDatabaseConfig('publicSocialCommand', commandEnv);
  const workerConfig = loadDatabaseConfig('publicSocialWorkerCommand', workerEnv);

  assert.equal(commandConfig.sourceEnv, 'DATABASE_PUBLIC_SOCIAL_COMMAND_URL');
  assert.equal(commandConfig.expectedDatabaseUser, 'r72_public_social_command');
  assert.equal(commandConfig.applicationName, 'property-predator-public-social-command');
  assert.equal(workerConfig.sourceEnv, 'DATABASE_PUBLIC_SOCIAL_WORKER_URL');
  assert.equal(workerConfig.expectedDatabaseUser, 'r72_public_social_worker_command');
  assert.equal(workerConfig.applicationName, 'property-predator-public-social-worker-command');
  assert.notEqual(commandConfig.connectionString, workerConfig.connectionString);

  assert.throws(
    () => loadDatabaseConfig('publicSocialCommand', {
      DATABASE_PUBLIC_SOCIAL_COMMAND_URL:
        'postgresql://r72_public_social_worker_command:secret@localhost/growth_hq_test?sslmode=disable',
    }),
    /least-privilege r72_public_social_command role/,
  );

  const commandPool = createPublicSocialCommandDatabasePool(commandEnv, {
    onBackgroundError: () => undefined,
  });
  const workerPool = createPublicSocialWorkerCommandDatabasePool(workerEnv, {
    onBackgroundError: () => undefined,
  });
  try {
    assert.notEqual(commandPool, workerPool);
    assert.equal(commandPool.options.application_name, 'property-predator-public-social-command');
    assert.equal(commandPool.options.max, 2);
    assert.equal(workerPool.options.application_name, 'property-predator-public-social-worker-command');
    assert.equal(workerPool.options.max, 3);
    assert.notEqual(commandPool.options.connectionString, workerPool.options.connectionString);
    assert.equal(typeof commandPool.options.verify, 'function');
    assert.equal(typeof workerPool.options.verify, 'function');
  } finally {
    await Promise.all([commandPool.end(), workerPool.end()]);
  }
});
