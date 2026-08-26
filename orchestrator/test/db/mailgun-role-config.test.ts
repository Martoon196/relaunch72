import assert from 'node:assert/strict';
import test from 'node:test';
import { DATABASE_ROLES, loadDatabaseConfig } from '../../src/db/config.js';
import {
  createMailgunWebhookCommandDatabasePool,
  createMailgunWorkerCommandDatabasePool,
} from '../../src/db/pool.js';

test('Mailgun ingress and outbound use separate exact production identities', async () => {
  const cases = [
    {
      role: 'mailgunWorkerCommand' as const,
      envName: 'DATABASE_MAILGUN_WORKER_URL',
      poolName: 'DATABASE_MAILGUN_WORKER_POOL_MAX',
      user: 'r72_mailgun_worker_command',
      applicationName: 'property-predator-mailgun-worker-command',
      create: createMailgunWorkerCommandDatabasePool,
    },
    {
      role: 'mailgunWebhookCommand' as const,
      envName: 'DATABASE_MAILGUN_WEBHOOK_URL',
      poolName: 'DATABASE_MAILGUN_WEBHOOK_POOL_MAX',
      user: 'r72_mailgun_webhook_command',
      applicationName: 'property-predator-mailgun-webhook-command',
      create: createMailgunWebhookCommandDatabasePool,
    },
  ];
  for (const item of cases) {
    assert.ok(DATABASE_ROLES.includes(item.role));
    assert.throws(() => loadDatabaseConfig(item.role, {
      NODE_ENV: 'production',
      [item.envName]: 'postgresql://r72_worker:secret@db.example/relaunch72?sslmode=require',
    }), new RegExp(`least-privilege ${item.user}`));
    const config = loadDatabaseConfig(item.role, {
      NODE_ENV: 'production',
      [item.envName]: `postgresql://${item.user}:secret@db.example/relaunch72?sslmode=require`,
      [item.poolName]: '2',
    });
    assert.equal(config.sourceEnv, item.envName);
    assert.equal(config.expectedDatabaseUser, item.user);
    assert.equal(config.applicationName, item.applicationName);
    assert.equal(config.maxConnections, 2);
    const pool = item.create({
      [item.envName]: `postgresql://${item.user}:secret@localhost/relaunch72_test?sslmode=disable`,
    }, { onBackgroundError: () => undefined });
    assert.equal(pool.options.application_name, item.applicationName);
    assert.equal(typeof pool.options.verify, 'function');
    await pool.end();
  }
});
