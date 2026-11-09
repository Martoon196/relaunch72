import assert from 'node:assert/strict';
import test from 'node:test';
import { DATABASE_ROLES, loadDatabaseConfig } from '../../src/db/config.js';
import {
  createPublicSocialCommandDatabasePool,
  createPublicSocialWorkerCommandDatabasePool,
} from '../../src/db/pool.js';

test('public-social planning and the dark worker use separate function-only identities', async () => {
  const cases = [
    {
      role: 'publicSocialCommand' as const,
      envName: 'DATABASE_PUBLIC_SOCIAL_COMMAND_URL',
      poolName: 'DATABASE_PUBLIC_SOCIAL_COMMAND_POOL_MAX',
      user: 'r72_public_social_command',
      applicationName: 'property-predator-public-social-command',
      create: createPublicSocialCommandDatabasePool,
    },
    {
      role: 'publicSocialWorkerCommand' as const,
      envName: 'DATABASE_PUBLIC_SOCIAL_WORKER_URL',
      poolName: 'DATABASE_PUBLIC_SOCIAL_WORKER_POOL_MAX',
      user: 'r72_public_social_worker_command',
      applicationName: 'property-predator-public-social-worker-command',
      create: createPublicSocialWorkerCommandDatabasePool,
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

test('public-social production roles never fall back to a generic database URL', () => {
  for (const role of ['publicSocialCommand', 'publicSocialWorkerCommand'] as const) {
    assert.throws(() => loadDatabaseConfig(role, {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://owner:secret@db.example/relaunch72?sslmode=require',
    }), /production does not accept the generic DATABASE_URL fallback/);
  }
});
