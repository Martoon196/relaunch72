import assert from 'node:assert/strict';
import test from 'node:test';
import { DATABASE_ROLES, loadDatabaseConfig } from '../../src/db/config.js';
import {
  createWhatsAppLiveCommandDatabasePool,
  createWhatsAppLiveWebhookCommandDatabasePool,
  createWhatsAppLiveWorkerCommandDatabasePool,
} from '../../src/db/pool.js';

const CASES = [
  { role: 'whatsAppLiveCommand' as const, env: 'DATABASE_WHATSAPP_LIVE_COMMAND_URL',
    pool: 'DATABASE_WHATSAPP_LIVE_COMMAND_POOL_MAX', user: 'r72_whatsapp_live_command',
    application: 'property-predator-whatsapp-live-command', max: 2,
    create: createWhatsAppLiveCommandDatabasePool },
  { role: 'whatsAppLiveWorkerCommand' as const, env: 'DATABASE_WHATSAPP_LIVE_WORKER_URL',
    pool: 'DATABASE_WHATSAPP_LIVE_WORKER_POOL_MAX',
    user: 'r72_whatsapp_live_worker_command',
    application: 'property-predator-whatsapp-live-worker-command', max: 1,
    create: createWhatsAppLiveWorkerCommandDatabasePool },
  { role: 'whatsAppLiveWebhookCommand' as const, env: 'DATABASE_WHATSAPP_LIVE_WEBHOOK_URL',
    pool: 'DATABASE_WHATSAPP_LIVE_WEBHOOK_POOL_MAX',
    user: 'r72_whatsapp_live_webhook_command',
    application: 'property-predator-whatsapp-live-webhook-command', max: 2,
    create: createWhatsAppLiveWebhookCommandDatabasePool },
] as const;

test('0053 has three exact, disjoint runtime database identities', async () => {
  for (const item of CASES) {
    assert.ok(DATABASE_ROLES.includes(item.role));
    assert.throws(() => loadDatabaseConfig(item.role, {
      NODE_ENV: 'production',
      [item.env]: 'postgresql://r72_owner:secret@db.example/relaunch72?sslmode=require',
    }), new RegExp(`least-privilege ${item.user}`));
    const config = loadDatabaseConfig(item.role, {
      NODE_ENV: 'production',
      [item.env]: `postgresql://${item.user}:secret@db.example/relaunch72?sslmode=require`,
      [item.pool]: String(item.max),
    });
    assert.equal(config.sourceEnv, item.env);
    assert.equal(config.expectedDatabaseUser, item.user);
    assert.equal(config.applicationName, item.application);
    assert.equal(config.maxConnections, item.max);

    const pool = item.create({
      [item.env]: `postgresql://${item.user}:secret@localhost/relaunch72_test?sslmode=disable`,
      [item.pool]: String(item.max),
    }, { onBackgroundError: () => undefined });
    assert.equal(pool.options.application_name, item.application);
    assert.equal(pool.options.max, item.max);
    assert.equal(typeof pool.options.verify, 'function');
    await pool.end();
  }
});

test('0053 identities never use generic production fallback and worker is capped at one connection', () => {
  for (const item of CASES) assert.throws(() => loadDatabaseConfig(item.role, {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://owner:secret@db.example/relaunch72?sslmode=require',
  }), /production does not accept the generic DATABASE_URL fallback/u);
  assert.throws(() => loadDatabaseConfig('whatsAppLiveWorkerCommand', {
    NODE_ENV: 'production',
    DATABASE_WHATSAPP_LIVE_WORKER_URL:
      'postgresql://r72_whatsapp_live_worker_command:secret@db.example/relaunch72?sslmode=require',
    DATABASE_WHATSAPP_LIVE_WORKER_POOL_MAX: '2',
  }), /must be an integer from 1 to 1/u);
});
