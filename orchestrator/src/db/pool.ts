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
