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
  createPgPortalConversionInboxOperationsService,
  type PgPortalConversionInboxOperationsService,
} from './conversion-inbox-operations-pg-service.js';
import {
  createPgPortalLiveChannelTruthService,
  type PgPortalLiveChannelTruthService,
} from './live-channel-truth-pg-service.js';
import {
  createPgPortalLiveChannelPauseService,
  type PgPortalLiveChannelPauseService,
} from './live-channel-pause-pg-service.js';
import {
  createPgPortalCampaignMachineService,
  type PgPortalCampaignMachineService,
} from './campaign-machine-pg-service.js';
import {
  createPgPortalOperatorActionCentreService,
  type PgPortalOperatorActionCentreService,
} from './operator-action-centre-pg-service.js';
import {
  createPgPortalCompanyAssetsService,
  type PgPortalCompanyAssetsService,
} from './company-assets-pg-service.js';
import { PgPortalAbuseGuard } from './abuse-pg-service.js';
import {
  createPgPortalPublicSocialService,
  type PgPortalPublicSocialService,
} from './public-social-pg-service.js';
import {
  createPgPortalCompanyContentSyncService,
  loadPropertyPredatorContentSyncSourceConfig,
  type PropertyPredatorContentSyncSourceConfig,
  type PgPortalCompanyContentSyncService,
} from './company-content-sync-pg-service.js';
import {
  createPgPortalCompanyContentReviewService,
  type PgPortalCompanyContentReviewService,
} from './company-content-review-pg-service.js';
import {
  createPgPortalBrandBrainService,
  type PgPortalBrandBrainService,
} from './brand-brain-pg-service.js';
import {
  composePropertyPredatorCampaignDraftRuntime,
} from './property-predator-campaign-draft-composition.js';
import type {
  PropertyPredatorCampaignDraftRuntime,
} from '../company-content-adapter/property-predator-campaign-draft-runtime.js';
import {
  createPropertyPredatorOwnedSeedCampaignService,
  type PropertyPredatorOwnedSeedCampaignService,
} from '../property-predator-owned-seed-campaign-pg/index.js';
import {
  createPgPortalOwnedSeedCampaignService,
  type PgPortalOwnedSeedCampaignService,
} from './owned-seed-campaign-pg-service.js';
import {
  createPropertyPredatorOwnedSeedMessageService,
  type PropertyPredatorOwnedSeedMessageService,
} from '../property-predator-owned-seed-message-pg/index.js';
import {
  createPgPortalOwnedSeedMessageService,
  type PgPortalOwnedSeedMessageService,
} from './owned-seed-message-pg-service.js';

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
  /** Effects-off, operator-triggered source verification and immutable import. */
  companyContentSync?: PgPortalCompanyContentSyncService;
  /** Manager-only exact source review; read-only and provider-incapable. */
  companyContentReview?: PgPortalCompanyContentReviewService;
  /** Product-scoped, metadata-only Brand Brain read boundary. */
  brandBrain?: PgPortalBrandBrainService;
  /** Exact-evidence, review-only source generation; no send/publish surface. */
  campaignDrafts?: Pick<PropertyPredatorCampaignDraftRuntime, 'generateReviewDraft'>;
  /** Durable TEST-only public-social campaign planner and safe calendar projection. */
  publicSocial?: PgPortalPublicSocialService;
  /** Canonical TEST-only queue read model; it has no send or provider operation. */
  inbox: PortalInboxReadBoundary;
  /** Durable TEST-only draft/approval queue commands; it cannot dispatch. */
  inboxCommands: PgPortalConversionInboxCommandService;
  /** Provider-incapable assignment, internal-note and admin-call workflow commands. */
  inboxOperations: PgPortalConversionInboxOperationsService;
  /** Sanitised evidence-only channel state, caps, blockers and latest receipts. */
  liveChannelTruth: PgPortalLiveChannelTruthService;
  /** Durable engage-only emergency pause command. */
  liveChannelPause: PgPortalLiveChannelPauseService;
  /** RLS-scoped immutable Campaign Machine read model. */
  campaignMachine: PgPortalCampaignMachineService;
  /** Optional table-blind staging command for the fixed owned office seed only. */
  ownedSeedCampaign?: PgPortalOwnedSeedCampaignService;
  /** Fixed office-seed LIVE draft plus deliberate message approval; cannot send. */
  ownedSeedMessages?: PgPortalOwnedSeedMessageService;
  /** Bounded caller-owned runtime probe; throws without exposing connection details. */
  assertReady(): Promise<void>;
  close(): Promise<void>;
}

const PROPERTY_PREDATOR_CONTENT_SYNC_ENV = Object.freeze([
  'PROPERTY_PREDATOR_COMPANY_CONTENT_ORIGIN',
  'PROPERTY_PREDATOR_COMPANY_CONTENT_CLIENT_ID',
  'PROPERTY_PREDATOR_COMPANY_CONTENT_READ_TOKEN',
  'PROPERTY_PREDATOR_COMPANY_CONTENT_TIMEOUT_MS',
  'PROPERTY_PREDATOR_COMPANY_CONTENT_ALLOW_LOCAL_HTTP',
] as const);

/**
 * Company-content source composition belongs to one exact branded product.
 * A secret copied to a generic Relaunch72 service therefore fails startup
 * instead of quietly mounting a cross-product source boundary.
 */
export function propertyPredatorContentSyncSourceForProfile(
  env: NodeJS.ProcessEnv,
): PropertyPredatorContentSyncSourceConfig | undefined {
  const exactProfile = env.PORTAL_PRODUCT_PROFILE?.trim() === 'property_predator_growth';
  const configured = PROPERTY_PREDATOR_CONTENT_SYNC_ENV.some(
    (name) => Boolean(env[name]?.trim()),
  );
  if (configured && !exactProfile) {
    throw new Error(
      'Property Predator company-content source is forbidden outside property_predator_growth',
    );
  }
  return exactProfile ? loadPropertyPredatorContentSyncSourceConfig(env) : undefined;
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

async function assertBrandBrainRoleCapabilities(adapterPool: Pool): Promise<void> {
  const result = await adapterPool.query<{ ready: boolean }>(
    `/* portal.brand-brain-adapter-role-readiness */
     SELECT current_user = 'r72_content_adapter'
        AND (SELECT bool_and(pg_catalog.has_table_privilege(
                current_user, 'app_private.' || required.table_name, 'SELECT'
              ))
             FROM (VALUES
               ('brand_brain_source_releases'), ('brand_brain_source_version_refs'),
               ('brand_brain_specialist_profile_refs'), ('brand_brain_quarantines'),
               ('brand_brain_source_attestations'), ('brand_brain_eval_results'),
               ('brand_brain_review_decisions'), ('brand_brain_activations')
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
              current_user, 'app.provider_operations', 'INSERT'
            ) AS ready`,
  );
  if (result.rows.length !== 1 || result.rows[0]?.ready !== true) {
    throw new Error('Brand Brain portal read role capabilities are incomplete');
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
  const propertyPredatorGrowthProfile = env.PORTAL_PRODUCT_PROFILE?.trim()
    === 'property_predator_growth';
  const requireCompanyContent = env.NODE_ENV?.trim() === 'production'
    && propertyPredatorGrowthProfile;
  const expectedInstallationId = env.PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID?.trim();
  const companyContentSyncSource = propertyPredatorContentSyncSourceForProfile(env);
  const campaignDraftComposition = composePropertyPredatorCampaignDraftRuntime(env);
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
    let companyContentSync: PgPortalCompanyContentSyncService | undefined;
    let companyContentReview: PgPortalCompanyContentReviewService | undefined;
    let brandBrain: PgPortalBrandBrainService | undefined;
    let publicSocial: PgPortalPublicSocialService | undefined;
    let ownedSeedCampaign: PgPortalOwnedSeedCampaignService | undefined;
    let ownedSeedCampaignCore: PropertyPredatorOwnedSeedCampaignService | undefined;
    let ownedSeedMessages: PgPortalOwnedSeedMessageService | undefined;
    let ownedSeedMessageCore: PropertyPredatorOwnedSeedMessageService | undefined;
    let contentReadinessPool: Pool | undefined;
    let contentCommandPool: Pool | undefined;
    let assetReadinessPool: Pool | undefined;
    let contentAdapterPool: Pool | undefined;
    let publicSocialReadinessPool: Pool | undefined;
    let ownedSeedCampaignReadinessPool: Pool | undefined;
    let ownedSeedMessageReadinessPool: Pool | undefined;
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
        if (propertyPredatorGrowthProfile) {
          await assertBrandBrainRoleCapabilities(contentAdapterPool);
        }
        companyAssets = createPgPortalCompanyAssetsService({
          webPool,
          adapterPool: contentAdapterPool,
          commandPool: contentCommandPool,
        });
        if (companyContentSyncSource) {
          companyContentSync = createPgPortalCompanyContentSyncService({
            webPool,
            adapterPool: contentAdapterPool,
            source: companyContentSyncSource,
          });
          companyContentReview = createPgPortalCompanyContentReviewService({
            webPool,
            adapterPool: contentAdapterPool,
            source: companyContentSyncSource,
          });
        }
        if (propertyPredatorGrowthProfile) {
          companyContent = createPgPortalCompanyContentService({
            webPool,
            commandPool: contentCommandPool,
            adapterPool: contentAdapterPool,
          });
          brandBrain = createPgPortalBrandBrainService({
            webPool,
            adapterPool: contentAdapterPool,
          });
        }
        assetReadinessPool = contentAdapterPool;
        pools.push(contentAdapterPool);
      } catch {
        await contentAdapterPool?.end().catch(() => undefined);
        companyAssets = undefined;
        companyContentSync = undefined;
        companyContentReview = undefined;
        brandBrain = undefined;
        if (requireCompanyContent) {
          throw new Error('Property Predator production company-assets controls did not pass readiness');
        }
      }
    }

    if (env.DATABASE_PUBLIC_SOCIAL_COMMAND_URL?.trim()) {
      let publicSocialCommandPool: Pool | undefined;
      try {
        const publicSocialCommandConfig = requireCutoverIdentity(
          loadDatabaseConfig('publicSocialCommand', env),
          'DATABASE_PUBLIC_SOCIAL_COMMAND_URL',
          'r72_public_social_command',
        );
        publicSocialCommandPool = createDatabasePool(publicSocialCommandConfig);
        if (expectedInstallationId) {
          await assertExpectedDatabaseInstallation(publicSocialCommandPool, expectedInstallationId);
        }
        const ready = await publicSocialCommandPool.query<{ ready: boolean }>(
          `/* portal.public-social-command-role-readiness */
           SELECT app_private.public_social_campaign_boundary_ready() AS ready`,
        );
        if (ready.rows.length !== 1 || ready.rows[0]?.ready !== true) {
          throw new Error('Public-social TEST boundary is not ready');
        }
        publicSocial = createPgPortalPublicSocialService({
          webPool,
          publicSocialCommandPool,
        });
        publicSocialReadinessPool = publicSocialCommandPool;
        pools.push(publicSocialCommandPool);
      } catch {
        await publicSocialCommandPool?.end().catch(() => undefined);
        publicSocial = undefined;
        publicSocialReadinessPool = undefined;
      }
    }

    if (env.DATABASE_OWNED_SEED_CAMPAIGN_URL?.trim()) {
      let ownedSeedCommandPool: Pool | undefined;
      try {
        const workspaceId = env.PROPERTY_PREDATOR_PILOT_WORKSPACE_ID?.trim().toLowerCase() ?? '';
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(workspaceId)) {
          throw new Error('Owned-seed campaign requires the exact pilot workspace id');
        }
        const ownedSeedCommandConfig = requireCutoverIdentity(
          loadDatabaseConfig('ownedSeedCampaignCommand', env),
          'DATABASE_OWNED_SEED_CAMPAIGN_URL',
          'r72_owned_seed_campaign_command',
        );
        ownedSeedCommandPool = createDatabasePool(ownedSeedCommandConfig);
        if (expectedInstallationId) {
          await assertExpectedDatabaseInstallation(ownedSeedCommandPool, expectedInstallationId);
        }
        ownedSeedCampaignCore = createPropertyPredatorOwnedSeedCampaignService({
          commandPool: ownedSeedCommandPool,
          workspaceId,
        });
        await ownedSeedCampaignCore.assertReady();
        ownedSeedCampaign = createPgPortalOwnedSeedCampaignService({
          webPool,
          campaign: ownedSeedCampaignCore,
        });
        ownedSeedCampaignReadinessPool = ownedSeedCommandPool;
        pools.push(ownedSeedCommandPool);
      } catch {
        await ownedSeedCommandPool?.end().catch(() => undefined);
        ownedSeedCampaign = undefined;
        ownedSeedCampaignCore = undefined;
        ownedSeedCampaignReadinessPool = undefined;
      }
    }

    if (env.DATABASE_OWNED_SEED_MESSAGE_URL?.trim()) {
      let ownedSeedMessagePool: Pool | undefined;
      try {
        const workspaceId = env.PROPERTY_PREDATOR_PILOT_WORKSPACE_ID?.trim().toLowerCase() ?? '';
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(workspaceId)) {
          throw new Error('Owned-seed message bridge requires the exact pilot workspace id');
        }
        const ownedSeedMessageConfig = requireCutoverIdentity(
          loadDatabaseConfig('ownedSeedMessageCommand', env),
          'DATABASE_OWNED_SEED_MESSAGE_URL',
          'r72_owned_seed_message_command',
        );
        ownedSeedMessagePool = createDatabasePool(ownedSeedMessageConfig);
        if (expectedInstallationId) {
          await assertExpectedDatabaseInstallation(ownedSeedMessagePool, expectedInstallationId);
        }
        ownedSeedMessageCore = createPropertyPredatorOwnedSeedMessageService({
          commandPool: ownedSeedMessagePool,
          workspaceId,
        });
        await ownedSeedMessageCore.assertReady();
        ownedSeedMessages = createPgPortalOwnedSeedMessageService({
          webPool,
          messages: ownedSeedMessageCore,
        });
        ownedSeedMessageReadinessPool = ownedSeedMessagePool;
        pools.push(ownedSeedMessagePool);
      } catch {
        await ownedSeedMessagePool?.end().catch(() => undefined);
        ownedSeedMessages = undefined;
        ownedSeedMessageCore = undefined;
        ownedSeedMessageReadinessPool = undefined;
      }
    }

    let closed = false;
    return {
      auth: new PgPortalAuthService({ readPool: webPool, commandPool: identityPool }),
      abuse,
      crm: createPgPortalCrmService({
        webPool,
        commandPool,
        cursorSecret: env.SESSION_SECRET?.trim() ?? '',
      }),
      journeys: createPgPortalJourneyManagerService({ webPool, commandPool }),
      operatorActions: createPgPortalOperatorActionCentreService({
        webPool,
        commandPool,
        environment: env.NODE_ENV?.trim() === 'production' ? 'production' : 'test',
      }),
      companyContent,
      companyAssets,
      companyContentSync,
      companyContentReview,
      brandBrain,
      campaignDrafts: companyContent && brandBrain
        ? campaignDraftComposition.runtime
        : undefined,
      publicSocial,
      inbox: createPgPortalInboxReadBoundary(webPool),
      inboxCommands: createPgPortalConversionInboxCommandService({ webPool, commandPool }),
      inboxOperations: createPgPortalConversionInboxOperationsService({
        webPool,
        crmCommandPool: commandPool,
      }),
      liveChannelTruth: createPgPortalLiveChannelTruthService({ webPool }),
      liveChannelPause: createPgPortalLiveChannelPauseService({
        webPool,
        crmCommandPool: commandPool,
      }),
      campaignMachine: createPgPortalCampaignMachineService({ webPool }),
      ownedSeedCampaign,
      ownedSeedMessages,
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
                ...(publicSocialReadinessPool
                  ? [assertExpectedDatabaseInstallation(publicSocialReadinessPool, expectedInstallationId)]
                  : []),
                ...(ownedSeedCampaignReadinessPool
                  ? [assertExpectedDatabaseInstallation(ownedSeedCampaignReadinessPool, expectedInstallationId)]
                  : []),
                ...(ownedSeedMessageReadinessPool
                  ? [assertExpectedDatabaseInstallation(ownedSeedMessageReadinessPool, expectedInstallationId)]
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
            ? [
                assertCompanyAssetRoleCapabilities(assetReadinessPool, contentCommandPool),
                ...(brandBrain ? [assertBrandBrainRoleCapabilities(assetReadinessPool)] : []),
              ]
            : []),
          ...(publicSocialReadinessPool
            ? [publicSocialReadinessPool.query(
                `/* portal.public-social-runtime-readiness */
                 SELECT app_private.public_social_campaign_boundary_ready() AS ready`,
              ).then((result) => {
                if (result.rows.length !== 1 || result.rows[0]?.ready !== true) {
                  throw new Error('Public-social TEST boundary is not ready');
                }
              })]
            : []),
          ...(ownedSeedCampaignCore ? [ownedSeedCampaignCore.assertReady()] : []),
          ...(ownedSeedMessageCore ? [ownedSeedMessageCore.assertReady()] : []),
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
