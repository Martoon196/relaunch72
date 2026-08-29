import assert from 'node:assert/strict';
import test from 'node:test';
import { DATABASE_ROLES, loadDatabaseConfig } from '../../src/db/config.js';
import {
  createSmsCommandDatabasePool,
  createSmsWebhookCommandDatabasePool,
  createSmsWorkerCommandDatabasePool,
} from '../../src/db/pool.js';

const CASES = [
  { role: 'smsCommand' as const, env: 'DATABASE_SMS_COMMAND_URL',
    pool: 'DATABASE_SMS_COMMAND_POOL_MAX', user: 'r72_sms_command',
    application: 'property-predator-sms-command', max: 2,
    create: createSmsCommandDatabasePool },
  { role: 'smsWorkerCommand' as const,
    env: 'DATABASE_SMS_WORKER_URL',
    pool: 'DATABASE_SMS_WORKER_POOL_MAX',
    user: 'r72_sms_worker_command',
    application: 'property-predator-sms-worker-command', max: 1,
    create: createSmsWorkerCommandDatabasePool },
  { role: 'smsWebhookCommand' as const,
    env: 'DATABASE_SMS_WEBHOOK_URL',
    pool: 'DATABASE_SMS_WEBHOOK_POOL_MAX',
    user: 'r72_sms_webhook_command',
    application: 'property-predator-sms-webhook-command', max: 2,
    create: createSmsWebhookCommandDatabasePool },
] as const;

test('0056 has three exact, disjoint runtime database identities', async () => {
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

test('0056 identities reject generic production fallback and worker pool expansion', () => {
  for (const item of CASES) assert.throws(() => loadDatabaseConfig(item.role, {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://owner:secret@db.example/relaunch72?sslmode=require',
  }), /production does not accept the generic DATABASE_URL fallback/u);
  assert.throws(() => loadDatabaseConfig('smsWorkerCommand', {
    NODE_ENV: 'production',
    DATABASE_SMS_WORKER_URL:
      'postgresql://r72_sms_worker_command:secret@db.example/relaunch72?sslmode=require',
    DATABASE_SMS_WORKER_POOL_MAX: '2',
  }), /must be an integer from 1 to 1/u);
});
