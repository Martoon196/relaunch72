import assert from 'node:assert/strict';
import test from 'node:test';
import { DATABASE_ROLES, loadDatabaseConfig } from '../../src/db/config.js';
import { createOwnedSocialWorkerCommandDatabasePool } from '../../src/db/pool.js';

const URL_ENV = 'DATABASE_OWNED_SOCIAL_WORKER_URL';
const POOL_ENV = 'DATABASE_OWNED_SOCIAL_WORKER_POOL_MAX';
const ROLE = 'r72_owned_social_worker_command';
const APPLICATION = 'property-predator-owned-social-worker-command';

test('0052 live worker has one exact function-only database identity', async () => {
  assert.ok(DATABASE_ROLES.includes('ownedSocialWorkerCommand'));
  assert.throws(() => loadDatabaseConfig('ownedSocialWorkerCommand', {
    NODE_ENV: 'production',
    [URL_ENV]: 'postgresql://r72_owned_social_command:secret@db.example/relaunch72?sslmode=require',
  }), new RegExp(`least-privilege ${ROLE}`));

  const config = loadDatabaseConfig('ownedSocialWorkerCommand', {
    NODE_ENV: 'production',
    [URL_ENV]: `postgresql://${ROLE}:secret@db.example/relaunch72?sslmode=require`,
    [POOL_ENV]: '1',
  });
  assert.equal(config.sourceEnv, URL_ENV);
  assert.equal(config.expectedDatabaseUser, ROLE);
  assert.equal(config.applicationName, APPLICATION);
  assert.equal(config.maxConnections, 1);

  const pool = createOwnedSocialWorkerCommandDatabasePool({
    [URL_ENV]: `postgresql://${ROLE}:secret@localhost/relaunch72_test?sslmode=disable`,
  }, { onBackgroundError: () => undefined });
  assert.equal(pool.options.application_name, APPLICATION);
  assert.equal(typeof pool.options.verify, 'function');
  await pool.end();
});

test('0052 live worker never falls back to a generic production database URL', () => {
  assert.throws(() => loadDatabaseConfig('ownedSocialWorkerCommand', {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://owner:secret@db.example/relaunch72?sslmode=require',
  }), /production does not accept the generic DATABASE_URL fallback/u);
});
