import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { createDatabasePool } from '../db/pool.js';
import { loadDatabaseConfig, type DatabaseConfig } from '../db/config.js';
import { assertRuntimeSchemaCurrent } from '../db/runtime-readiness.js';
import { assertExpectedDatabaseInstallation } from '../db/installation-identity.js';
import { requestDatabaseContext } from '../db/rls.js';
import {
  createPgInboxReadService,
  type InboxConversationQuery,
} from '../inbox-pg/index.js';
import { PgPortalAuthService } from './auth-pg-service.js';
import {
  createPgPortalCrmPrincipalResolver,
  createPgPortalCrmService,
  type PgPortalCrmService,
} from './crm-pg-service.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';
import {
  createPgPortalCompanyContentService,
  type PgPortalCompanyContentService,
} from './company-content-pg-service.js';
import {
  createPgPortalJourneyManagerService,
  type PgPortalJourneyManagerService,
} from './journey-manager-service.js';
import type { PortalInboxReadBoundary } from './router.js';
import {
  createPgPortalConversionInboxCommandService,
  type PgPortalConversionInboxCommandService,
} from './conversion-inbox-pg-service.js';
import { createPgConversionInboxThreadReadService } from './conversion-inbox-thread-pg-service.js';
import {
  createPgPortalOperatorActionCentreService,
  type PgPortalOperatorActionCentreService,
} from './operator-action-centre-pg-service.js';
import {
  createPgPortalCompanyAssetsService,
  type PgPortalCompanyAssetsService,
} from './company-assets-pg-service.js';
import { PgPortalAbuseGuard } from './abuse-pg-service.js';

export interface PgPortalPlatform {
  auth: PgPortalAuthService;
  /** Distributed, function-only admission guard shared by every web instance. */
  abuse: PgPortalAbuseGuard;
  crm: PgPortalCrmService;
  journeys: PgPortalJourneyManagerService;
  /** RLS-scoped authoritative operator queue with assignment/snooze overlays only. */
  operatorActions: PgPortalOperatorActionCentreService;
  /** Omitted unless the dedicated r72_content_command identity passes readiness. */
  companyContent?: PgPortalCompanyContentService;
  /** Omitted unless adapter reads and founder command writes both pass readiness. */
  companyAssets?: PgPortalCompanyAssetsService;
  /** Canonical TEST-only queue read model; it has no send or provider operation. */
  inbox: PortalInboxReadBoundary;
  /** Durable TEST-only draft/approval queue commands; it cannot dispatch. */
  inboxCommands: PgPortalConversionInboxCommandService;
  /** Bounded caller-owned runtime probe; throws without exposing connection details. */
  assertReady(): Promise<void>;
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

async function assertCompanyAssetRoleCapabilities(
  adapterPool: Pool,
  commandPool: Pool,
): Promise<void> {
  const [adapter, command] = await Promise.all([
    adapterPool.query<{ ready: boolean }>(
      `/* portal.company-assets-adapter-role-readiness */
       SELECT current_user = 'r72_content_adapter'
          AND (SELECT bool_and(pg_catalog.has_table_privilege(
                  current_user, 'app_private.' || required.table_name, 'SELECT'
                ))
               FROM (VALUES
                 ('company_asset_releases'), ('company_asset_release_items'),
                 ('company_asset_source_attestations'), ('company_asset_eval_reports'),
                 ('company_asset_eval_cases'), ('company_asset_founder_approvals'),
                 ('company_asset_quarantine_decisions'), ('company_asset_reconciliations')
               ) AS required(table_name))
          AND pg_catalog.has_function_privilege(
                current_user,
                'app_private.active_portal_session(bytea,uuid,uuid)',
                'EXECUTE'
              )
          AND NOT pg_catalog.has_function_privilege(
                current_user,
                'app_private.lock_active_portal_session(bytea,uuid,uuid)',
                'EXECUTE'
              )
          AND NOT pg_catalog.has_table_privilege(
                current_user,
                'app_private.company_asset_quarantine_decisions',
                'INSERT'
              )
          AND NOT pg_catalog.has_table_privilege(
                current_user, 'app.provider_operations', 'INSERT'
              ) AS ready`,
    ),
    commandPool.query<{ ready: boolean }>(
      `/* portal.company-assets-command-role-readiness */
       SELECT current_user = 'r72_content_command'
          AND pg_catalog.has_table_privilege(
                current_user, 'app_private.company_asset_release_items', 'SELECT'
              )
          AND pg_catalog.has_table_privilege(
                current_user, 'app_private.company_asset_quarantine_decisions', 'SELECT'
              )
          AND pg_catalog.has_table_privilege(
                current_user, 'app_private.company_asset_quarantine_decisions', 'INSERT'
              )
          AND pg_catalog.has_function_privilege(
                current_user,
                'app_private.lock_active_portal_session(bytea,uuid,uuid)',
                'EXECUTE'
              )
          AND NOT pg_catalog.has_function_privilege(
                current_user,
                'app_private.active_portal_session(bytea,uuid,uuid)',
                'EXECUTE'
              )
          AND NOT pg_catalog.has_table_privilege(
                current_user, 'app_private.company_asset_releases', 'INSERT'
              )
          AND NOT pg_catalog.has_table_privilege(
                current_user, 'app_private.company_asset_reconciliations', 'INSERT'
              )
          AND NOT pg_catalog.has_table_privilege(
                current_user, 'app.provider_operations', 'INSERT'
              ) AS ready`,
    ),
  ]);
  if (adapter.rows.length !== 1 || adapter.rows[0]?.ready !== true
      || command.rows.length !== 1 || command.rows[0]?.ready !== true) {
    throw new Error('Company asset portal role capabilities are incomplete');
  }
}

export function postgresPortalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PORTAL_POSTGRES_ENABLED?.trim().toLowerCase() ?? '';
  if (!raw || raw === '0' || raw === 'false' || raw === 'no') return false;
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  throw new Error('PORTAL_POSTGRES_ENABLED must be true or false');
}

export function createPgPortalInboxReadBoundary(
  webPool: Pick<Pool, 'query' | 'connect'>,
): PortalInboxReadBoundary {
  const principalResolver = createPgPortalCrmPrincipalResolver(webPool);
  const readService = createPgInboxReadService(webPool);
  const threadReadService = createPgConversionInboxThreadReadService(webPool);
  async function context(identity: PortalCrmRequestIdentity) {
    const principal = await principalResolver.resolve(identity.sessionToken);
    if (!principal) return null;
    return requestDatabaseContext({
      ...principal,
      requestId: identity.requestId,
      portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest(),
    });
  }
  return Object.freeze({
    async listConversations(
      identity: PortalCrmRequestIdentity,
      query?: InboxConversationQuery,
    ) {
      const databaseContext = await context(identity);
      if (!databaseContext) return null;
      return readService.listConversations(databaseContext, query);
    },
    async thread(identity: PortalCrmRequestIdentity, conversationId: string) {
      const databaseContext = await context(identity);
      if (!databaseContext) return null;
      return threadReadService.thread(databaseContext, conversationId);
    },
  });
}

/**
 * Compose the portal only after its four required least-privilege identities connect
 * and the web identity proves the exact bundled migration ledger. Any partial
 * construction is closed before the error escapes. Sensitive provisioning and
 * setup delivery are composed separately by buildPgOnboardingPlatform. Company
 * content is an optional module and is exposed only when its fourth, dedicated
 * command identity independently passes readiness.
 */
export async function buildPgPortalPlatform(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PgPortalPlatform> {
  const pools: Pool[] = [];
  const requireCompanyContent = env.NODE_ENV?.trim() === 'production'
    && env.PORTAL_PRODUCT_PROFILE?.trim() === 'property_predator_growth';
  const expectedInstallationId = env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID?.trim();
  if (requireCompanyContent && !expectedInstallationId) {
    throw new Error('Property Predator production requires its database installation identity');
  }
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
    const abuseConfig = requireCutoverIdentity(
      loadDatabaseConfig('abuseCommand', env),
      'DATABASE_ABUSE_COMMAND_URL',
      'r72_abuse_command',
    );
    if (requireCompanyContent && !env.DATABASE_CONTENT_COMMAND_URL?.trim()) {
      throw new Error('Property Predator production requires DATABASE_CONTENT_COMMAND_URL');
    }
    if (requireCompanyContent && !env.DATABASE_CONTENT_ADAPTER_URL?.trim()) {
      throw new Error('Property Predator production requires DATABASE_CONTENT_ADAPTER_URL');
    }

    const webPool = createDatabasePool(webConfig);
    pools.push(webPool);
    const identityPool = createDatabasePool(identityConfig);
    pools.push(identityPool);
    const commandPool = createDatabasePool(commandConfig);
    pools.push(commandPool);
    const abusePool = createDatabasePool(abuseConfig);
    pools.push(abusePool);
    const abuse = new PgPortalAbuseGuard(abusePool);

    await assertRuntimeSchemaCurrent(webPool);
    if (expectedInstallationId) {
      await Promise.all([
        assertExpectedDatabaseInstallation(webPool, expectedInstallationId),
        assertExpectedDatabaseInstallation(identityPool, expectedInstallationId),
        assertExpectedDatabaseInstallation(commandPool, expectedInstallationId),
        assertExpectedDatabaseInstallation(abusePool, expectedInstallationId),
      ]);
    }
    // Force role verification now instead of on the first customer's request.
    await Promise.all([
      identityPool.query('/* portal.identity-role-readiness */ SELECT 1'),
      commandPool.query('/* portal.crm-command-role-readiness */ SELECT 1'),
      abuse.assertReady(),
    ]);

    let companyContent: PgPortalCompanyContentService | undefined;
    let companyAssets: PgPortalCompanyAssetsService | undefined;
    let contentReadinessPool: Pool | undefined;
    let contentCommandPool: Pool | undefined;
    let assetReadinessPool: Pool | undefined;
    if (env.DATABASE_CONTENT_COMMAND_URL?.trim()) {
      try {
        const contentCommandConfig = requireCutoverIdentity(
          loadDatabaseConfig('contentCommand', env),
          'DATABASE_CONTENT_COMMAND_URL',
          'r72_content_command',
        );
        contentCommandPool = createDatabasePool(contentCommandConfig);
        if (expectedInstallationId) {
          await assertExpectedDatabaseInstallation(contentCommandPool, expectedInstallationId);
        }
        await contentCommandPool.query('/* portal.content-command-role-readiness */ SELECT 1');
        companyContent = createPgPortalCompanyContentService({
          webPool,
          commandPool: contentCommandPool,
        });
        contentReadinessPool = contentCommandPool;
        pools.push(contentCommandPool);
      } catch {
        await contentCommandPool?.end().catch(() => undefined);
        if (requireCompanyContent) {
          throw new Error('Property Predator production content controls did not pass readiness');
        }
        // Optional means optional, not permissive: a missing or invalid command
        // identity leaves every content mutation route uncomposed.
        companyContent = undefined;
        contentCommandPool = undefined;
      }
    }

    if (env.DATABASE_CONTENT_ADAPTER_URL?.trim() && contentCommandPool) {
      let contentAdapterPool: Pool | undefined;
      try {
        const contentAdapterConfig = requireCutoverIdentity(
          loadDatabaseConfig('contentAdapter', env),
          'DATABASE_CONTENT_ADAPTER_URL',
          'r72_content_adapter',
        );
        contentAdapterPool = createDatabasePool(contentAdapterConfig);
        if (expectedInstallationId) {
          await assertExpectedDatabaseInstallation(contentAdapterPool, expectedInstallationId);
        }
        await assertCompanyAssetRoleCapabilities(contentAdapterPool, contentCommandPool);
        companyAssets = createPgPortalCompanyAssetsService({
          webPool,
          adapterPool: contentAdapterPool,
          commandPool: contentCommandPool,
        });
        assetReadinessPool = contentAdapterPool;
        pools.push(contentAdapterPool);
      } catch {
        await contentAdapterPool?.end().catch(() => undefined);
        companyAssets = undefined;
        if (requireCompanyContent) {
          throw new Error('Property Predator production company-assets controls did not pass readiness');
        }
      }
    }

    let closed = false;
    return {
      auth: new PgPortalAuthService({ readPool: webPool, commandPool: identityPool }),
      abuse,
      crm: createPgPortalCrmService({ webPool, commandPool }),
      journeys: createPgPortalJourneyManagerService({ webPool, commandPool }),
      operatorActions: createPgPortalOperatorActionCentreService({
        webPool,
        commandPool,
        environment: env.NODE_ENV?.trim() === 'production' ? 'production' : 'test',
      }),
      companyContent,
      companyAssets,
      inbox: createPgPortalInboxReadBoundary(webPool),
      inboxCommands: createPgPortalConversionInboxCommandService({ webPool, commandPool }),
      async assertReady(): Promise<void> {
        await Promise.all([
          assertRuntimeSchemaCurrent(webPool),
          ...(expectedInstallationId
            ? [
                assertExpectedDatabaseInstallation(webPool, expectedInstallationId),
                assertExpectedDatabaseInstallation(identityPool, expectedInstallationId),
                assertExpectedDatabaseInstallation(commandPool, expectedInstallationId),
                assertExpectedDatabaseInstallation(abusePool, expectedInstallationId),
                ...(contentReadinessPool
                  ? [assertExpectedDatabaseInstallation(contentReadinessPool, expectedInstallationId)]
                  : []),
                ...(assetReadinessPool
                  ? [assertExpectedDatabaseInstallation(assetReadinessPool, expectedInstallationId)]
                  : []),
              ]
            : []),
          identityPool.query('/* portal.identity-runtime-readiness */ SELECT 1'),
          commandPool.query('/* portal.crm-runtime-readiness */ SELECT 1'),
          abuse.assertReady(),
          ...(contentReadinessPool
            ? [contentReadinessPool.query('/* portal.content-runtime-readiness */ SELECT 1')]
            : []),
          ...(assetReadinessPool && contentCommandPool
            ? [assertCompanyAssetRoleCapabilities(assetReadinessPool, contentCommandPool)]
            : []),
        ]);
      },
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
