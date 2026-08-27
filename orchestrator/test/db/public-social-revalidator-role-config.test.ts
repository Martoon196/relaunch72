import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DATABASE_ROLES, loadDatabaseConfig } from '../../src/db/config.js';
import { createPublicSocialRevalidatorCommandDatabasePool } from '../../src/db/pool.js';

const URL_ENV = 'DATABASE_PUBLIC_SOCIAL_REVALIDATOR_URL';
const POOL_ENV = 'DATABASE_PUBLIC_SOCIAL_REVALIDATOR_POOL_MAX';
const ROLE = 'r72_public_social_revalidator_command';
const APPLICATION = 'property-predator-public-social-revalidator-command';
const resetDisposableUrl = new URL('./reset-disposable.ts', import.meta.url);

test('JIT social revalidation has its own exact function-only database identity', async () => {
  assert.ok(DATABASE_ROLES.includes('publicSocialRevalidatorCommand'));
  assert.throws(() => loadDatabaseConfig('publicSocialRevalidatorCommand', {
    NODE_ENV: 'production',
    [URL_ENV]: 'postgresql://r72_public_social_worker_command:secret@db.example/relaunch72?sslmode=require',
  }), new RegExp(`least-privilege ${ROLE}`));

  const config = loadDatabaseConfig('publicSocialRevalidatorCommand', {
    NODE_ENV: 'production',
    [URL_ENV]: `postgresql://${ROLE}:secret@db.example/relaunch72?sslmode=require`,
    [POOL_ENV]: '2',
  });
  assert.equal(config.sourceEnv, URL_ENV);
  assert.equal(config.expectedDatabaseUser, ROLE);
  assert.equal(config.applicationName, APPLICATION);
  assert.equal(config.maxConnections, 2);

  const pool = createPublicSocialRevalidatorCommandDatabasePool({
    [URL_ENV]: `postgresql://${ROLE}:secret@localhost/relaunch72_test?sslmode=disable`,
  }, { onBackgroundError: () => undefined });
  assert.equal(pool.options.application_name, APPLICATION);
  assert.equal(typeof pool.options.verify, 'function');
  await pool.end();
});

test('JIT social revalidation never falls back to a generic production database URL', () => {
  assert.throws(() => loadDatabaseConfig('publicSocialRevalidatorCommand', {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://owner:secret@db.example/relaunch72?sslmode=require',
  }), /production does not accept the generic DATABASE_URL fallback/);
});

test('disposable reset removes the dedicated revalidator login role', async () => {
  const reset = await readFile(resetDisposableUrl, 'utf8');
  assert.match(reset, /'r72_public_social_revalidator_command'/);
});
