import type { Pool } from 'pg';
import { loadDatabaseConfig, type DatabaseConfig } from '../db/config.js';
import { createDatabasePool } from '../db/pool.js';
import { assertRuntimeSchemaCurrent } from '../db/runtime-readiness.js';
import { PgPaidCheckoutService } from '../server/paid-checkout-pg-service.js';
import { loadSetupDeliveryRuntimeConfig } from './setup-delivery-config.js';
import { PgSetupDeliveryService } from './setup-delivery-pg-service.js';

export interface PgOnboardingPlatform {
  checkout: PgPaidCheckoutService;
  setupDelivery: PgSetupDeliveryService;
  close(): Promise<void>;
}

export interface PgOnboardingPlatformBuilderDependencies {
  createPool?: (config: DatabaseConfig) => Pool;
  assertSchemaCurrent?: typeof assertRuntimeSchemaCurrent;
}

function requireExactIdentity(
  config: DatabaseConfig,
  sourceEnv: string,
  expectedUser: string,
): DatabaseConfig {
  if (config.sourceEnv !== sourceEnv || config.expectedDatabaseUser !== expectedUser) {
    throw new Error(`PostgreSQL onboarding requires ${sourceEnv} authenticated as ${expectedUser}`);
  }
  return config;
}

/**
 * Compose the paid customer-activation boundary separately from the client
 * portal. Checkout intent, webhook, claim-bound provisioning, encrypted
 * delivery and trusted reissue each receive their exact database identity.
 * No provider is called and no worker starts.
 */
export async function buildPgOnboardingPlatform(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: PgOnboardingPlatformBuilderDependencies = {},
): Promise<PgOnboardingPlatform> {
  const createPool = dependencies.createPool ?? createDatabasePool;
  const assertSchemaCurrent = dependencies.assertSchemaCurrent ?? assertRuntimeSchemaCurrent;
  const runtimePools: Pool[] = [];
  let readinessPool: Pool | undefined;

  try {
    const setupConfig = loadSetupDeliveryRuntimeConfig(env);
    const webConfig = requireExactIdentity(
      loadDatabaseConfig('web', env),
      'DATABASE_WEB_URL',
      'r72_web',
    );
    const checkoutConfig = requireExactIdentity(
      loadDatabaseConfig('public', env),
      'DATABASE_PUBLIC_URL',
      'r72_public',
    );
    const webhookConfig = requireExactIdentity(
      loadDatabaseConfig('webhook', env),
      'DATABASE_WEBHOOK_URL',
      'r72_webhook',
    );
    const provisioningConfig = requireExactIdentity(
      loadDatabaseConfig('provisioningCommand', env),
      'DATABASE_PROVISIONING_COMMAND_URL',
      'r72_provisioning_command',
    );
    const deliveryConfig = requireExactIdentity(
      loadDatabaseConfig('setupDeliveryCommand', env),
      'DATABASE_SETUP_DELIVERY_COMMAND_URL',
      'r72_setup_delivery_command',
    );
    const reissueConfig = requireExactIdentity(
      loadDatabaseConfig('setupReissueCommand', env),
      'DATABASE_SETUP_REISSUE_COMMAND_URL',
      'r72_setup_reissue_command',
    );

    // The web identity can read the migration ledger but is not retained by the
    // worker/provisioning process after startup readiness succeeds.
    readinessPool = createPool(webConfig);
    await assertSchemaCurrent(readinessPool);
    await readinessPool.end();
    readinessPool = undefined;

    const checkoutPool = createPool(checkoutConfig);
    runtimePools.push(checkoutPool);
    const webhookPool = createPool(webhookConfig);
    runtimePools.push(webhookPool);
    const provisioningPool = createPool(provisioningConfig);
    runtimePools.push(provisioningPool);
    const deliveryPool = createPool(deliveryConfig);
    runtimePools.push(deliveryPool);
    const reissuePool = createPool(reissueConfig);
    runtimePools.push(reissuePool);

    const setupDelivery = new PgSetupDeliveryService({
      deliveryCommandPool: deliveryPool,
      reissueCommandPool: reissuePool,
      keyring: setupConfig.keyring,
      setupUrl: setupConfig.setupUrl,
    });

    // Force each pool's current_user verification now. Missing historical keys
    // fail readiness before any customer can be provisioned or delivery claimed.
    await Promise.all([
      checkoutPool.query('/* commerce.checkout-role-readiness */ SELECT 1'),
      webhookPool.query('/* commerce.webhook-role-readiness */ SELECT 1'),
      provisioningPool.query('/* portal.native-onboarding.provisioning-role-readiness */ SELECT 1'),
      deliveryPool.query('/* portal.native-onboarding.delivery-role-readiness */ SELECT 1'),
      reissuePool.query('/* portal.native-onboarding.reissue-role-readiness */ SELECT 1'),
    ]);
    await setupDelivery.assertReadyForPendingDeliveries();

    let closed = false;
    return {
      checkout: new PgPaidCheckoutService({
        checkoutCommandPool: checkoutPool,
        webhookCommandPool: webhookPool,
        provisioningCommandPool: provisioningPool,
        setupDelivery,
      }),
      setupDelivery,
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await Promise.all(runtimePools.map((pool) => pool.end()));
      },
    };
  } catch (error) {
    const pools = readinessPool ? [readinessPool, ...runtimePools] : runtimePools;
    await Promise.allSettled(pools.map((pool) => pool.end()));
    throw error;
  }
}
