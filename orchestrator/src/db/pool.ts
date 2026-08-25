import { Pool, type PoolConfig } from 'pg';
import { loadDatabaseConfig, type DatabaseConfig } from './config.js';

export interface DatabasePoolHooks {
  onBackgroundError?: (error: Error) => void;
}

function tlsConfig(config: DatabaseConfig): PoolConfig['ssl'] {
  if (config.sslMode === 'disable') return false;
  return {
    rejectUnauthorized: config.sslMode === 'verify-full',
    ...(config.sslCa ? { ca: config.sslCa } : {}),
  };
}

/** Create a process pool for exactly one configured database role. */
export function createDatabasePool(
  config: DatabaseConfig,
  hooks: DatabasePoolHooks = {},
): Pool {
  const pool = new Pool({
    connectionString: config.connectionString,
    application_name: config.applicationName,
    max: config.maxConnections,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    ssl: tlsConfig(config),
    enableChannelBinding: config.enableChannelBinding,
    allowExitOnIdle: !config.production,
    verify: config.expectedDatabaseUser
      ? (client, done) => {
        client.query<{ database_user: string }>('SELECT current_user AS database_user')
          .then((result) => {
            const actual = result.rows[0]?.database_user;
            done(actual === config.expectedDatabaseUser
              ? undefined
              : new Error(`Database connection did not assume the required ${config.expectedDatabaseUser} role`));
          })
          .catch((error: unknown) => done(error instanceof Error ? error : new Error('Database role verification failed')));
      }
      : undefined,
  });

  pool.on('error', hooks.onBackgroundError ?? ((error) => {
    // Deliberately omit the provider message and connection configuration: an
    // adapter error may echo a credential-bearing URL.
    console.error(`[database:${config.role}] idle client error (${error.name})`);
  }));
  return pool;
}

/**
 * Create the isolated pool used by CRM command handlers. Keeping this factory
 * separate prevents the portal read pool from being accidentally reused for a
 * mutation path; production also verifies `current_user = r72_crm_command`.
 */
export function createCrmCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('crmCommand', env), hooks);
}

/**
 * Create the isolated operator pool for rehearsing, staging, and committing
 * legacy lead imports. It must never be shared with the ordinary CRM command
 * or portal read paths.
 */
export function createImportCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('importCommand', env), hooks);
}

/** Receipt-only pool for authenticated external-event ingress. */
export function createExternalEventCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('externalEventCommand', env), hooks);
}

/** Function-only pool for authenticated evidence and conversion projection. */
export function createWebhookDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('webhook', env), hooks);
}

/** Isolated pre-context identity pool; it can execute audited auth functions only. */
export function createIdentityCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('identityCommand', env), hooks);
}

/** Isolated pre-context customer-provisioning pool; it has function execution only. */
export function createProvisioningCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('provisioningCommand', env), hooks);
}

/** Function-only queue-claim pool for encrypted account-setup deliveries. */
export function createSetupDeliveryCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('setupDeliveryCommand', env), hooks);
}

/** Function-only trusted/operator pool for issuing replacement setup links. */
export function createSetupReissueCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('setupReissueCommand', env), hooks);
}
