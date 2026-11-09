import assert from 'node:assert/strict';
import test from 'node:test';
import { DATABASE_ROLES, loadDatabaseConfig } from '../../src/db/config.js';
import { createAbuseCommandDatabasePool } from '../../src/db/pool.js';

test('portal abuse storage uses its exact isolated database identity and short pool', async () => {
  assert.ok(DATABASE_ROLES.includes('abuseCommand'));
  assert.throws(
    () => loadDatabaseConfig('abuseCommand', {
      NODE_ENV: 'production',
      DATABASE_ABUSE_COMMAND_URL:
        'postgresql://r72_identity_command:secret@database.example/relaunch72?sslmode=require',
    }),
    /must authenticate as the least-privilege r72_abuse_command role/,
  );

  const config = loadDatabaseConfig('abuseCommand', {
    NODE_ENV: 'production',
    DATABASE_ABUSE_COMMAND_URL:
      'postgresql://r72_abuse_command:secret@database.example/relaunch72?sslmode=require',
  });
  assert.equal(config.sourceEnv, 'DATABASE_ABUSE_COMMAND_URL');
  assert.equal(config.expectedDatabaseUser, 'r72_abuse_command');
  assert.equal(config.applicationName, 'relaunch72-abuse-command');
  assert.equal(config.maxConnections, 2);
  assert.equal(config.statementTimeoutMs, 1_000);

  const pool = createAbuseCommandDatabasePool({
    DATABASE_ABUSE_COMMAND_URL:
      'postgresql://r72_abuse_command:secret@localhost/relaunch72_test?sslmode=disable',
    DATABASE_ABUSE_COMMAND_POOL_MAX: '1',
    DATABASE_ABUSE_COMMAND_STATEMENT_TIMEOUT_MS: '750',
  }, { onBackgroundError: () => undefined });
  assert.equal(pool.options.application_name, 'relaunch72-abuse-command');
  assert.equal(pool.options.max, 1);
  assert.equal(pool.options.statement_timeout, 750);
  assert.equal(typeof pool.options.verify, 'function');
  await pool.end();
});

test('portal abuse production config never falls back to a generic database URL', () => {
  assert.throws(
    () => loadDatabaseConfig('abuseCommand', {
      NODE_ENV: 'production',
      DATABASE_URL:
        'postgresql://r72_abuse_command:secret@database.example/relaunch72?sslmode=require',
    }),
    /DATABASE_ABUSE_COMMAND_URL is required; production does not accept the generic DATABASE_URL fallback/,
  );

  assert.throws(
    () => loadDatabaseConfig('abuseCommand', {
      NODE_ENV: 'production',
      DATABASE_ABUSE_COMMAND_URL:
        'postgresql://r72_abuse_command:secret@database.example/relaunch72?sslmode=require',
      DATABASE_ABUSE_COMMAND_POOL_MAX: '101',
    }),
    /DATABASE_ABUSE_COMMAND_POOL_MAX must be an integer from 1 to 100/,
  );

  assert.throws(
    () => loadDatabaseConfig('abuseCommand', {
      DATABASE_ABUSE_COMMAND_URL:
        'postgresql://r72_abuse_command:secret@localhost/relaunch72_test?sslmode=disable',
      DATABASE_ABUSE_COMMAND_STATEMENT_TIMEOUT_MS: '1001',
    }),
    /DATABASE_ABUSE_COMMAND_STATEMENT_TIMEOUT_MS must be an integer from 500 to 1000/,
  );
});
