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

/** Function-only pool for the controlled Mailgun outbound pilot boundary. */
export function createMailgunWorkerCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('mailgunWorkerCommand', env), hooks);
}

/** Function-only pool for signed Mailgun event ingestion. */
export function createMailgunWebhookCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('mailgunWebhookCommand', env), hooks);
}

/** Function-only pool for authenticated simulated-inbound inbox events. */
export function createTestInboxWebhookCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('testInboxWebhookCommand', env), hooks);
}

/** Table-blind portal pool that may stage only the capped Property Predator owned seed. */
export function createOwnedSeedCampaignCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('ownedSeedCampaignCommand', env), hooks);
}

/** Table-blind portal pool for the fixed office-seed draft and approval bridge. */
export function createOwnedSeedMessageCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('ownedSeedMessageCommand', env), hooks);
}

/** Function-only portal command pool for TEST public-social campaign planning. */
export function createPublicSocialCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('publicSocialCommand', env), hooks);
}

/** Function-only worker pool for the no-network public-social TEST rail. */
export function createPublicSocialWorkerCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('publicSocialWorkerCommand', env), hooks);
}

/** Function-only pool for JIT owned-source revalidation; it cannot publish. */
export function createPublicSocialRevalidatorCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('publicSocialRevalidatorCommand', env), hooks);
}

/** Function-only founder command pool for exact owned X profile and enqueue evidence. */
export function createOwnedSocialCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('ownedSocialCommand', env), hooks);
}

/** Function-only pool for the capped owned-profile public-social live worker. */
export function createOwnedSocialWorkerCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('ownedSocialWorkerCommand', env), hooks);
}

/** Function-only command pool for binding, template and enqueue authority. */
export function createWhatsAppLiveCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('whatsAppLiveCommand', env), hooks);
}

/** One-connection, function-only pool for the isolated Meta dispatch worker. */
export function createWhatsAppLiveWorkerCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('whatsAppLiveWorkerCommand', env), hooks);
}

/** Function-only pool for verified Meta webhook receipt ingestion. */
export function createWhatsAppLiveWebhookCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('whatsAppLiveWebhookCommand', env), hooks);
}

/** Function-only pool for founder-authorized, evidence-bound customer-email enqueue. */
export function createCustomerEmailCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('customerEmailCommand', env), hooks);
}

/** One-connection pool for the isolated Mailgun EU customer-email worker. */
export function createCustomerEmailWorkerCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('customerEmailWorkerCommand', env), hooks);
}

/** Receipt-only pool for customer-email projection after Mailgun authentication. */
export function createCustomerEmailWebhookCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('customerEmailWebhookCommand', env), hooks);
}

/** Function-only pool for founder-authorized, evidence-bound SMS enqueue. */
export function createSmsCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('smsCommand', env), hooks);
}

/** One-connection pool for the isolated Twilio SMS dispatch worker. */
export function createSmsWorkerCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('smsWorkerCommand', env), hooks);
}

/** Receipt-only pool for signed Twilio SMS status and inbound projection. */
export function createSmsWebhookCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('smsWebhookCommand', env), hooks);
}

/** Function-only pool for the isolated provider-operation worker. */
export function createWorkerDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('worker', env), hooks);
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

/** Function-only pool for distributed portal abuse admission and lease release. */
export function createAbuseCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('abuseCommand', env), hooks);
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

/** Function-only command pool for Daily Outreach queue and outcome receipts. */
export function createDailyOutreachCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('dailyOutreachCommand', env), hooks);
}

/** Table-blind read pool for the bounded Daily Outreach cockpit projection. */
export function createDailyOutreachReadDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('dailyOutreachRead', env), hooks);
}

/** Function-only command pool for signed Zernio inbound receipts. */
export function createZernioInboundWebhookCommandDatabasePool(
  env: NodeJS.ProcessEnv = process.env,
  hooks: DatabasePoolHooks = {},
): Pool {
  return createDatabasePool(loadDatabaseConfig('zernioInboundWebhookCommand', env), hooks);
}
