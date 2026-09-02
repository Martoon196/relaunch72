import assert from 'node:assert/strict';
import test from 'node:test';
import { DATABASE_ROLES, loadDatabaseConfig } from '../../src/db/config.js';
import {
  createDailyOutreachCommandDatabasePool,
  createDailyOutreachReadDatabasePool,
} from '../../src/db/pool.js';

test('Daily Outreach command and cockpit reads use separate exact identities', async () => {
  const cases = [
    {
      role: 'dailyOutreachCommand' as const,
      envName: 'DATABASE_DAILY_OUTREACH_COMMAND_URL',
      poolName: 'DATABASE_DAILY_OUTREACH_COMMAND_POOL_MAX',
      user: 'r72_daily_outreach_command',
      applicationName: 'property-predator-daily-outreach-command',
      create: createDailyOutreachCommandDatabasePool,
    },
    {
      role: 'dailyOutreachRead' as const,
      envName: 'DATABASE_DAILY_OUTREACH_READ_URL',
      poolName: 'DATABASE_DAILY_OUTREACH_READ_POOL_MAX',
      user: 'r72_daily_outreach_read',
      applicationName: 'property-predator-daily-outreach-read',
      create: createDailyOutreachReadDatabasePool,
    },
  ];

  for (const item of cases) {
    assert.ok(DATABASE_ROLES.includes(item.role));
    assert.throws(() => loadDatabaseConfig(item.role, {
      NODE_ENV: 'production',
      [item.envName]: 'postgresql://r72_web:secret@db.example/relaunch72?sslmode=require',
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
      [item.poolName]: '2',
    }, { onBackgroundError: () => undefined });
    assert.equal(pool.options.application_name, item.applicationName);
    assert.equal(pool.options.max, 2);
    assert.equal(typeof pool.options.verify, 'function');
    await pool.end();
  }
});

test('Daily Outreach production roles never accept the generic database URL', () => {
  for (const role of ['dailyOutreachCommand', 'dailyOutreachRead'] as const) {
    assert.throws(() => loadDatabaseConfig(role, {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://owner:secret@db.example/relaunch72?sslmode=require',
    }), /production does not accept the generic DATABASE_URL fallback/u);
  }
});
