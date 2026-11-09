import assert from 'node:assert/strict';
import test from 'node:test';
import { DATABASE_ROLES, loadDatabaseConfig } from '../../src/db/config.js';
import { createZernioInboundWebhookCommandDatabasePool } from '../../src/db/pool.js';

const ROLE = 'zernioInboundWebhookCommand' as const;
const URL_ENV = 'DATABASE_ZERNIO_INBOUND_WEBHOOK_URL';
const POOL_ENV = 'DATABASE_ZERNIO_INBOUND_WEBHOOK_POOL_MAX';
const DATABASE_USER = 'r72_zernio_inbound_webhook_command';
const APPLICATION_NAME = 'property-predator-zernio-inbound-webhook-command';

test('Zernio inbound receipts use one exact function-only command identity', async () => {
  assert.ok(DATABASE_ROLES.includes(ROLE));
  assert.throws(() => loadDatabaseConfig(ROLE, {
    NODE_ENV: 'production',
    [URL_ENV]: 'postgresql://r72_web:secret@db.example/relaunch72?sslmode=require',
  }), new RegExp(`least-privilege ${DATABASE_USER}`));

  const config = loadDatabaseConfig(ROLE, {
    NODE_ENV: 'production',
    [URL_ENV]: `postgresql://${DATABASE_USER}:secret@db.example/relaunch72?sslmode=require`,
    [POOL_ENV]: '2',
  });
  assert.equal(config.sourceEnv, URL_ENV);
  assert.equal(config.expectedDatabaseUser, DATABASE_USER);
  assert.equal(config.applicationName, APPLICATION_NAME);
  assert.equal(config.maxConnections, 2);

  const pool = createZernioInboundWebhookCommandDatabasePool({
    [URL_ENV]: `postgresql://${DATABASE_USER}:secret@localhost/relaunch72_test?sslmode=disable`,
    [POOL_ENV]: '2',
  }, { onBackgroundError: () => undefined });
  assert.equal(pool.options.application_name, APPLICATION_NAME);
  assert.equal(pool.options.max, 2);
  assert.equal(typeof pool.options.verify, 'function');
  await pool.end();
});

test('Zernio inbound production role never accepts the generic database URL', () => {
  assert.throws(() => loadDatabaseConfig(ROLE, {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://owner:secret@db.example/relaunch72?sslmode=require',
  }), /production does not accept the generic DATABASE_URL fallback/u);
});
