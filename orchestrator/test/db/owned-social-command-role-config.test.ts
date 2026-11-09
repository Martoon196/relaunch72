import assert from 'node:assert/strict';
import test from 'node:test';
import { DATABASE_ROLES, loadDatabaseConfig } from '../../src/db/config.js';
import { createOwnedSocialCommandDatabasePool } from '../../src/db/pool.js';

const URL_ENV = 'DATABASE_OWNED_SOCIAL_COMMAND_URL';
const POOL_ENV = 'DATABASE_OWNED_SOCIAL_COMMAND_POOL_MAX';
const ROLE = 'r72_owned_social_command';
const APPLICATION = 'property-predator-owned-social-command';

test('0052 founder command has one exact function-only database identity', async () => {
  assert.ok(DATABASE_ROLES.includes('ownedSocialCommand'));
  assert.throws(() => loadDatabaseConfig('ownedSocialCommand', {
    NODE_ENV: 'production',
    [URL_ENV]:
      'postgresql://r72_owned_social_worker_command:secret@db.example/relaunch72?sslmode=require',
  }), new RegExp(`least-privilege ${ROLE}`));

  const config = loadDatabaseConfig('ownedSocialCommand', {
    NODE_ENV: 'production',
    [URL_ENV]: `postgresql://${ROLE}:secret@db.example/relaunch72?sslmode=require`,
    [POOL_ENV]: '2',
  });
  assert.equal(config.sourceEnv, URL_ENV);
  assert.equal(config.expectedDatabaseUser, ROLE);
  assert.equal(config.applicationName, APPLICATION);
  assert.equal(config.maxConnections, 2);

  const pool = createOwnedSocialCommandDatabasePool({
    [URL_ENV]: `postgresql://${ROLE}:secret@localhost/relaunch72_test?sslmode=disable`,
    [POOL_ENV]: '2',
  }, { onBackgroundError: () => undefined });
  assert.equal(pool.options.application_name, APPLICATION);
  assert.equal(pool.options.max, 2);
  assert.equal(typeof pool.options.verify, 'function');
  await pool.end();
});

test('0052 founder command never falls back to a generic production identity', () => {
  assert.throws(() => loadDatabaseConfig('ownedSocialCommand', {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://owner:secret@db.example/relaunch72?sslmode=require',
  }), /production does not accept the generic DATABASE_URL fallback/u);
});
