import assert from 'node:assert/strict';
import test from 'node:test';
import { DATABASE_ROLES, loadDatabaseConfig } from '../../src/db/config.js';
import { createOwnedSeedMessageCommandDatabasePool } from '../../src/db/pool.js';

test('the owned-seed message portal uses its dedicated table-blind identity', async () => {
  assert.ok(DATABASE_ROLES.includes('ownedSeedMessageCommand'));
  assert.throws(() => loadDatabaseConfig('ownedSeedMessageCommand', {
    NODE_ENV: 'production',
    DATABASE_OWNED_SEED_MESSAGE_URL:
      'postgresql://r72_crm_command:secret@db.example/relaunch72?sslmode=require',
  }), /least-privilege r72_owned_seed_message_command/);

  const config = loadDatabaseConfig('ownedSeedMessageCommand', {
    NODE_ENV: 'production',
    DATABASE_OWNED_SEED_MESSAGE_URL:
      'postgresql://r72_owned_seed_message_command:secret@db.example/relaunch72?sslmode=require',
    DATABASE_OWNED_SEED_MESSAGE_POOL_MAX: '2',
  });
  assert.equal(config.sourceEnv, 'DATABASE_OWNED_SEED_MESSAGE_URL');
  assert.equal(config.expectedDatabaseUser, 'r72_owned_seed_message_command');
  assert.equal(config.applicationName, 'property-predator-owned-seed-message-command');
  assert.equal(config.maxConnections, 2);

  const pool = createOwnedSeedMessageCommandDatabasePool({
    DATABASE_OWNED_SEED_MESSAGE_URL:
      'postgresql://r72_owned_seed_message_command:secret@localhost/relaunch72_test?sslmode=disable',
  }, { onBackgroundError: () => undefined });
  assert.equal(pool.options.application_name, 'property-predator-owned-seed-message-command');
  assert.equal(typeof pool.options.verify, 'function');
  await pool.end();
});

test('owned-seed message production never falls back to a generic database URL', () => {
  assert.throws(() => loadDatabaseConfig('ownedSeedMessageCommand', {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://owner:secret@db.example/relaunch72?sslmode=require',
  }), /production does not accept the generic DATABASE_URL fallback/);
});
