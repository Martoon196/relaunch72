import assert from 'node:assert/strict';
import test from 'node:test';
import { DATABASE_ROLES, loadDatabaseConfig } from '../../src/db/config.js';
import {
  createCrmCommandDatabasePool,
  createDatabasePool,
  createExternalEventCommandDatabasePool,
  createIdentityCommandDatabasePool,
  createProvisioningCommandDatabasePool,
  createSetupDeliveryCommandDatabasePool,
  createSetupReissueCommandDatabasePool,
} from '../../src/db/pool.js';

test('external-event ingress uses its exact receipt-only database identity', async () => {
  assert.ok(DATABASE_ROLES.includes('externalEventCommand'));
  assert.throws(
    () => loadDatabaseConfig('externalEventCommand', {
      NODE_ENV: 'production',
      DATABASE_EXTERNAL_EVENT_COMMAND_URL:
        'postgresql://r72_webhook:secret@database.example/relaunch72?sslmode=require',
    }),
    /must authenticate as the least-privilege r72_external_event_command role/,
  );

  const config = loadDatabaseConfig('externalEventCommand', {
    NODE_ENV: 'production',
    DATABASE_EXTERNAL_EVENT_COMMAND_URL:
      'postgresql://r72_external_event_command:secret@database.example/relaunch72?sslmode=require',
    DATABASE_EXTERNAL_EVENT_COMMAND_POOL_MAX: '2',
  });
  assert.equal(config.sourceEnv, 'DATABASE_EXTERNAL_EVENT_COMMAND_URL');
  assert.equal(config.expectedDatabaseUser, 'r72_external_event_command');
  assert.equal(config.applicationName, 'relaunch72-external-event-command');
  assert.equal(config.maxConnections, 2);

  const pool = createExternalEventCommandDatabasePool({
    DATABASE_EXTERNAL_EVENT_COMMAND_URL:
      'postgresql://r72_external_event_command:secret@localhost/relaunch72_test?sslmode=disable',
  }, { onBackgroundError: () => undefined });
  assert.equal(pool.options.application_name, 'relaunch72-external-event-command');
  assert.equal(typeof pool.options.verify, 'function');
  await pool.end();
});

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

test('CRM commands have a dedicated verified role URL and pool identity', async () => {
  assert.ok(DATABASE_ROLES.includes('crmCommand'));
  assert.throws(
    () => loadDatabaseConfig('crmCommand', {
      NODE_ENV: 'production',
      DATABASE_CRM_COMMAND_URL: 'postgresql://r72_web:secret@database.example/relaunch72?sslmode=require',
    }),
    /must authenticate as the least-privilege r72_crm_command role/,
  );

  const config = loadDatabaseConfig('crmCommand', {
    NODE_ENV: 'production',
    DATABASE_CRM_COMMAND_URL: 'postgresql://r72_crm_command:secret@database.example/relaunch72?sslmode=require',
    DATABASE_CRM_COMMAND_POOL_MAX: '4',
  });
  assert.equal(config.sourceEnv, 'DATABASE_CRM_COMMAND_URL');
  assert.equal(config.expectedDatabaseUser, 'r72_crm_command');
  assert.equal(config.applicationName, 'relaunch72-crm-command');
  assert.equal(config.maxConnections, 4);

  const pool = createCrmCommandDatabasePool({
    NODE_ENV: 'development',
    DATABASE_CRM_COMMAND_URL: 'postgresql://r72_crm_command:secret@localhost/relaunch72_test?sslmode=disable',
    DATABASE_CRM_COMMAND_POOL_MAX: '2',
  }, { onBackgroundError: () => undefined });
  assert.equal(pool.options.application_name, 'relaunch72-crm-command');
  assert.equal(pool.options.max, 2);
  assert.equal(typeof pool.options.verify, 'function');
  await pool.end();
});

test('portal login and session commands use their own verified identity role', async () => {
  assert.ok(DATABASE_ROLES.includes('identityCommand'));
  assert.throws(
    () => loadDatabaseConfig('identityCommand', {
      NODE_ENV: 'production',
      DATABASE_IDENTITY_COMMAND_URL: 'postgresql://r72_web:secret@database.example/relaunch72?sslmode=require',
    }),
    /must authenticate as the least-privilege r72_identity_command role/,
  );
  const config = loadDatabaseConfig('identityCommand', {
    NODE_ENV: 'production',
    DATABASE_IDENTITY_COMMAND_URL: 'postgresql://r72_identity_command:secret@database.example/relaunch72?sslmode=require',
    DATABASE_IDENTITY_COMMAND_POOL_MAX: '3',
  });
  assert.equal(config.sourceEnv, 'DATABASE_IDENTITY_COMMAND_URL');
  assert.equal(config.applicationName, 'relaunch72-identity-command');
  assert.equal(config.expectedDatabaseUser, 'r72_identity_command');
  assert.equal(config.maxConnections, 3);

  const pool = createIdentityCommandDatabasePool({
    DATABASE_IDENTITY_COMMAND_URL: 'postgresql://r72_identity_command:secret@localhost/relaunch72_test?sslmode=disable',
  }, { onBackgroundError: () => undefined });
  assert.equal(pool.options.application_name, 'relaunch72-identity-command');
  assert.equal(typeof pool.options.verify, 'function');
  await pool.end();
});

test('native customer provisioning has a dedicated verified function-only role', async () => {
  assert.ok(DATABASE_ROLES.includes('provisioningCommand'));
  assert.throws(
    () => loadDatabaseConfig('provisioningCommand', {
      NODE_ENV: 'production',
      DATABASE_PROVISIONING_COMMAND_URL: 'postgresql://r72_web:secret@database.example/relaunch72?sslmode=require',
    }),
    /must authenticate as the least-privilege r72_provisioning_command role/,
  );
  const config = loadDatabaseConfig('provisioningCommand', {
    NODE_ENV: 'production',
    DATABASE_PROVISIONING_COMMAND_URL: 'postgresql://r72_provisioning_command:secret@database.example/relaunch72?sslmode=require',
    DATABASE_PROVISIONING_COMMAND_POOL_MAX: '2',
  });
  assert.equal(config.sourceEnv, 'DATABASE_PROVISIONING_COMMAND_URL');
  assert.equal(config.applicationName, 'relaunch72-provisioning-command');
  assert.equal(config.expectedDatabaseUser, 'r72_provisioning_command');
  assert.equal(config.maxConnections, 2);

  const pool = createProvisioningCommandDatabasePool({
    DATABASE_PROVISIONING_COMMAND_URL: 'postgresql://r72_provisioning_command:secret@localhost/relaunch72_test?sslmode=disable',
  }, { onBackgroundError: () => undefined });
  assert.equal(pool.options.application_name, 'relaunch72-provisioning-command');
  assert.equal(typeof pool.options.verify, 'function');
  await pool.end();
});

test('setup delivery and operator reissue use separate verified function-only identities', async () => {
  const cases = [
    {
      role: 'setupDeliveryCommand' as const,
      envName: 'DATABASE_SETUP_DELIVERY_COMMAND_URL',
      poolName: 'DATABASE_SETUP_DELIVERY_COMMAND_POOL_MAX',
      databaseUser: 'r72_setup_delivery_command',
      applicationName: 'relaunch72-setup-delivery-command',
      createPool: createSetupDeliveryCommandDatabasePool,
    },
    {
      role: 'setupReissueCommand' as const,
      envName: 'DATABASE_SETUP_REISSUE_COMMAND_URL',
      poolName: 'DATABASE_SETUP_REISSUE_COMMAND_POOL_MAX',
      databaseUser: 'r72_setup_reissue_command',
      applicationName: 'relaunch72-setup-reissue-command',
      createPool: createSetupReissueCommandDatabasePool,
    },
  ];

  for (const item of cases) {
    assert.ok(DATABASE_ROLES.includes(item.role));
    assert.throws(
      () => loadDatabaseConfig(item.role, {
        NODE_ENV: 'production',
        [item.envName]: 'postgresql://r72_worker:secret@database.example/relaunch72?sslmode=require',
      }),
      new RegExp(`must authenticate as the least-privilege ${item.databaseUser} role`),
    );

    const config = loadDatabaseConfig(item.role, {
      NODE_ENV: 'production',
      [item.envName]: `postgresql://${item.databaseUser}:secret@database.example/relaunch72?sslmode=require`,
      [item.poolName]: '2',
    });
    assert.equal(config.sourceEnv, item.envName);
    assert.equal(config.expectedDatabaseUser, item.databaseUser);
    assert.equal(config.applicationName, item.applicationName);
    assert.equal(config.maxConnections, 2);

    const pool = item.createPool({
      [item.envName]: `postgresql://${item.databaseUser}:secret@localhost/relaunch72_test?sslmode=disable`,
    }, { onBackgroundError: () => undefined });
    assert.equal(pool.options.application_name, item.applicationName);
    assert.equal(typeof pool.options.verify, 'function');
    await pool.end();
  }
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

test('Neon direct URLs retain verified TLS and enable channel binding safely', async () => {
  const config = loadDatabaseConfig('migrator', {
    DATABASE_MIGRATOR_URL: 'postgresql://owner:secret@ep-example.eu-central-1.aws.neon.tech/relaunch72_test?sslmode=verify-full&channel_binding=require',
  });
  assert.equal(config.sslMode, 'verify-full');
  assert.equal(config.enableChannelBinding, true);
  assert.doesNotMatch(config.connectionString, /channel_binding|sslmode/);

  const pool = createDatabasePool(config, { onBackgroundError: () => undefined });
  assert.equal(pool.options.enableChannelBinding, true);
  assert.deepEqual(pool.options.ssl, { rejectUnauthorized: true });
  await pool.end();

  assert.throws(
    () => loadDatabaseConfig('migrator', {
      DATABASE_MIGRATOR_URL: 'postgresql://owner:secret@localhost/relaunch72_test?sslmode=disable&channel_binding=require',
    }),
    /cannot require channel binding when TLS is disabled/,
  );
  assert.throws(
    () => loadDatabaseConfig('migrator', {
      DATABASE_MIGRATOR_URL: 'postgresql://owner:secret@ep-example-pooler.eu-central-1.aws.neon.tech/relaunch72_test?sslmode=verify-full&channel_binding=require',
    }),
    /direct, non-pooled connection/,
  );
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
