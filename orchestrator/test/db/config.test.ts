import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../../src/db/config.js';
import { createDatabasePool } from '../../src/db/pool.js';

test('database config uses generic DATABASE_URL only for local development', () => {
  const config = loadDatabaseConfig('web', {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://r72_web:secret@localhost:5432/relaunch72_dev?sslmode=disable',
  });
  assert.equal(config.sourceEnv, 'DATABASE_URL');
  assert.equal(config.sslMode, 'disable');
  assert.equal(config.role, 'web');
  assert.equal(config.maxConnections, 5);
  assert.doesNotMatch(config.connectionString, /sslmode=/);
});

test('production requires the exact role URL and encrypted transport', () => {
  assert.throws(
    () => loadDatabaseConfig('worker', {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://admin:secret@database.example/relaunch72',
    }),
    /DATABASE_WORKER_URL is required; production does not accept the generic DATABASE_URL fallback/,
  );
  assert.throws(
    () => loadDatabaseConfig('worker', {
      NODE_ENV: 'production',
      DATABASE_WORKER_URL: 'postgresql://r72_worker:secret@database.example/relaunch72',
      DATABASE_SSL_MODE: 'disable',
    }),
    /forbidden in production/,
  );

  const config = loadDatabaseConfig('worker', {
    NODE_ENV: 'production',
    DATABASE_WORKER_URL: 'postgresql://r72_worker:secret@database.example/relaunch72?sslmode=require',
  });
  assert.equal(config.sourceEnv, 'DATABASE_WORKER_URL');
  assert.equal(config.sslMode, 'require');
  assert.equal(config.maxConnections, 10);
  assert.equal(config.expectedDatabaseUser, 'r72_worker');
  assert.throws(
    () => loadDatabaseConfig('web', {
      NODE_ENV: 'production',
      DATABASE_WEB_URL: 'postgresql://database_owner:secret@database.example/relaunch72',
    }),
    /must authenticate as the least-privilege r72_web role/,
  );
});

test('database config rejects malformed URLs and dangerous numeric settings without leaking secrets', () => {
  const secret = 'never-print-this-password';
  for (const env of [
    { DATABASE_URL: `https://r72_web:${secret}@localhost/relaunch72` },
    { DATABASE_URL: `postgresql://r72_web:${secret}@localhost/` },
    { DATABASE_URL: `postgresql://r72_web:${secret}@localhost/relaunch72`, DATABASE_WEB_POOL_MAX: '0' },
    { DATABASE_URL: `postgresql://r72_web:${secret}@localhost/relaunch72?sslrootcert=/tmp/ca.pem` },
    { DATABASE_URL: `postgresql://r72_web:${secret}@localhost/relaunch72?ssl=0` },
    { DATABASE_URL: `postgresql://r72_web:${secret}@localhost/relaunch72?host=attacker.example` },
  ]) {
    assert.throws(
      () => loadDatabaseConfig('web', env),
      (error: unknown) => error instanceof Error && !error.message.includes(secret),
    );
  }
});

test('pool factory carries bounded connection and TLS settings without connecting', async () => {
  const config = loadDatabaseConfig('readonly', {
    DATABASE_READONLY_URL: 'postgresql://r72_readonly:secret@db.example/relaunch72',
    DATABASE_SSL_MODE: 'verify-full',
    DATABASE_READONLY_POOL_MAX: '3',
    DATABASE_STATEMENT_TIMEOUT_MS: '4200',
  });
  const pool = createDatabasePool(config, { onBackgroundError: () => undefined });
  const options = pool.options;
  assert.equal(options.max, 3);
  assert.equal(options.statement_timeout, 4200);
  assert.equal(options.application_name, 'relaunch72-readonly');
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
  assert.equal(typeof options.verify, 'function');
  await pool.end();
});
