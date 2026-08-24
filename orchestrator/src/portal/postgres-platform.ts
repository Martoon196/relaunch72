import type { Pool } from 'pg';
import { createDatabasePool } from '../db/pool.js';
import { loadDatabaseConfig, type DatabaseConfig } from '../db/config.js';
import { assertRuntimeSchemaCurrent } from '../db/runtime-readiness.js';
import { PgPortalAuthService } from './auth-pg-service.js';
import { createPgPortalCrmService, type PgPortalCrmService } from './crm-pg-service.js';

export interface PgPortalPlatform {
  auth: PgPortalAuthService;
  crm: PgPortalCrmService;
  close(): Promise<void>;
}

function requireCutoverIdentity(
  config: DatabaseConfig,
  sourceEnv: string,
  expectedUser: string,
): DatabaseConfig {
  if (config.sourceEnv !== sourceEnv || config.expectedDatabaseUser !== expectedUser) {
    throw new Error(`PostgreSQL portal cutover requires ${sourceEnv} authenticated as ${expectedUser}`);
  }
  return config;
}

export function postgresPortalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PORTAL_POSTGRES_ENABLED?.trim().toLowerCase() ?? '';
  if (!raw || raw === '0' || raw === 'false' || raw === 'no') return false;
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  throw new Error('PORTAL_POSTGRES_ENABLED must be true or false');
}

/**
 * Compose the portal only after its three least-privilege identities connect
 * and the web identity proves the exact bundled migration ledger. Any partial
 * construction is closed before the error escapes. Sensitive provisioning and
 * setup delivery are composed separately by buildPgOnboardingPlatform.
 */
export async function buildPgPortalPlatform(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PgPortalPlatform> {
  const pools: Pool[] = [];
  try {
    // Even in local development, an enabled cutover must never collapse the
    // three runtime paths onto a generic owner/migrator DATABASE_URL.
    const webConfig = requireCutoverIdentity(
      loadDatabaseConfig('web', env),
      'DATABASE_WEB_URL',
      'r72_web',
    );
    const identityConfig = requireCutoverIdentity(
      loadDatabaseConfig('identityCommand', env),
      'DATABASE_IDENTITY_COMMAND_URL',
      'r72_identity_command',
    );
    const commandConfig = requireCutoverIdentity(
      loadDatabaseConfig('crmCommand', env),
      'DATABASE_CRM_COMMAND_URL',
      'r72_crm_command',
    );

    const webPool = createDatabasePool(webConfig);
    pools.push(webPool);
    const identityPool = createDatabasePool(identityConfig);
    pools.push(identityPool);
    const commandPool = createDatabasePool(commandConfig);
    pools.push(commandPool);

    await assertRuntimeSchemaCurrent(webPool);
    // Force role verification now instead of on the first customer's request.
    await Promise.all([
      identityPool.query('/* portal.identity-role-readiness */ SELECT 1'),
      commandPool.query('/* portal.crm-command-role-readiness */ SELECT 1'),
    ]);

    let closed = false;
    return {
      auth: new PgPortalAuthService({ readPool: webPool, commandPool: identityPool }),
      crm: createPgPortalCrmService({ webPool, commandPool }),
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await Promise.all(pools.map((pool) => pool.end()));
      },
    };
  } catch (error) {
    await Promise.allSettled(pools.map((pool) => pool.end()));
    throw error;
  }
}
