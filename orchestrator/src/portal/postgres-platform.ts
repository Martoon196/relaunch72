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
  createPgPortalContactPermissionService,
  type PgPortalContactPermissionService,
} from './contact-permission-pg-service.js';
import {
  createPgPortalFounderEmailPilotService,
  type PgPortalFounderEmailPilotService,
} from './founder-email-pilot-pg-service.js';
import {
  createPgPortalPermissionUseReceiptService,
  type PgPortalPermissionUseReceiptService,
} from './permission-use-receipt-pg-service.js';
import { createPgCustomerEmailLiveCommandService } from '../customer-email-live-pg/command-service.js';
import { assertCustomerEmailCommandBoundaryReady } from '../customer-email-live-pg/readiness.js';
import type { CustomerEmailLiveCommandService } from '../customer-email-live-pg/types.js';
import {
  createPgPortalOwnedSocialBindingService,
  type PgPortalOwnedSocialBindingService,
} from './owned-social-binding-pg-service.js';
import {
  createPgPortalSmsBindingService,
  type PgPortalSmsBindingService,
} from './sms-binding-pg-service.js';
import { createPgTwilioSmsLiveCommandService } from '../sms-live-pg/command-service.js';
import { assertSmsCommandBoundaryReady } from '../sms-live-pg/readiness.js';
import { createPgOwnedPublicSocialLiveCommandService } from '../owned-public-social-pg/command-service.js';
import { assertOwnedPublicSocialCommandBoundaryReady } from '../owned-public-social-pg/readiness.js';
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
  assertZernioSocialCommandBoundaryReady,
  createPgPortalZernioSocialConnectionService,
  type PgPortalZernioSocialConnectionService,
} from './zernio-social-connection-pg-service.js';
import { createZernioLiveConnectionClient } from '../public-social-outbound/index.js';
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
  /** One-use Zernio account connection and signed account-event evidence only. */
  zernioSocial?: PgPortalZernioSocialConnectionService;
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
  /**
   * Founder-only owned Ayrshare/X binding and approved-publication staging.
   * Composed only from DATABASE_OWNED_SOCIAL_COMMAND_URL authenticated as
   * r72_owned_social_command, and only after that boundary proves table-blind.
   */
  ownedSocialBinding?: PgPortalOwnedSocialBindingService;
  /**
   * Founder-only Twilio SMS binding and owned-test staging. Composed only from
   * DATABASE_SMS_COMMAND_URL authenticated as r72_sms_command.
   */
  smsBinding?: PgPortalSmsBindingService;
  /** Founder-only contact permission decisions for the Lead 360 case file. */
  contactPermission: PgPortalContactPermissionService;
  /** Founder Lead 360 endpoint attach and customer-email pilot readiness. */
  founderEmailPilot?: PgPortalFounderEmailPilotService;
  /** The permission-bound capped enqueue, on its own least-privilege identity. */
  customerEmailCommand?: CustomerEmailLiveCommandService;
  /**
   * The 0065 evidence identity, composed only when its own URL is bound. It is
   * exposed so readiness can report the boundary honestly rather than implying
   * the compliance workflow exists when its credential is absent.
   */
  founderPilotEvidenceBound: boolean;
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

const PORTAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * The owned-social profile-key encryption contract, if this process has been
 * deliberately given it. It is absent by default, so the founder binding form
 * renders as an honest disabled control rather than accepting a Profile Key
 * the portal could not seal. Returns undefined rather than throwing so a
 * missing or malformed key never takes the whole portal down.
 */
function ownedSocialProfileEncryption(
  env: NodeJS.ProcessEnv,
): Readonly<{ key: Buffer; keyVersion: string }> | undefined {
  const encoded = env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_PROFILE_ENCRYPTION_KEY_BASE64?.trim() ?? '';
  const keyVersion =
    env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_PROFILE_ENCRYPTION_KEY_VERSION?.trim() ?? '';
  if (!encoded || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(keyVersion)) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return undefined;
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) return undefined;
  return Object.freeze({ key, keyVersion });
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

    // The founder command seam for the owned Ayrshare/X rail. It rides only
    // its own least-privilege identity and never the generic web pool, and it
    // stays undefined unless that identity proves its exact boundary.
    let ownedSocialBinding: PgPortalOwnedSocialBindingService | undefined;
    let ownedSocialReadinessPool: Pool | undefined;
    if (env.DATABASE_OWNED_SOCIAL_COMMAND_URL?.trim()) {
      let ownedSocialPool: Pool | undefined;
      try {
        const workspaceId = env.PROPERTY_PREDATOR_PILOT_WORKSPACE_ID?.trim().toLowerCase() ?? '';
        const connectionId = env.PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_CONNECTION_ID
          ?.trim().toLowerCase() ?? '';
        if (!PORTAL_UUID.test(workspaceId) || !PORTAL_UUID.test(connectionId)) {
          throw new Error(
            'Owned social command seam requires the exact pilot workspace and Ayrshare connection',
          );
        }
        const ownedSocialConfig = requireCutoverIdentity(
          loadDatabaseConfig('ownedSocialCommand', env),
          'DATABASE_OWNED_SOCIAL_COMMAND_URL',
          'r72_owned_social_command',
        );
        ownedSocialPool = createDatabasePool(ownedSocialConfig);
        if (expectedInstallationId) {
          await assertExpectedDatabaseInstallation(ownedSocialPool, expectedInstallationId);
        }
        await assertOwnedPublicSocialCommandBoundaryReady(ownedSocialPool);
        const profileEncryption = ownedSocialProfileEncryption(env);
        ownedSocialBinding = createPgPortalOwnedSocialBindingService({
          webPool,
          ownedSocialCommandPool: ownedSocialPool,
          commandService: createPgOwnedPublicSocialLiveCommandService({
            commandPool: ownedSocialPool,
            workspaceId,
            providerConnectionId: connectionId,
          }),
          providerConnectionId: connectionId,
          ...(profileEncryption ? { profileEncryption } : {}),
        });
        ownedSocialReadinessPool = ownedSocialPool;
        pools.push(ownedSocialPool);
      } catch {
        await ownedSocialPool?.end().catch(() => undefined);
        ownedSocialBinding = undefined;
        ownedSocialReadinessPool = undefined;
      }
    }

    // Connection-only Zernio seam. This client may request a hosted OAuth URL
    // and record its one-use callback, but exposes no post, queue or worker API.
    let zernioSocial: PgPortalZernioSocialConnectionService | undefined;
    let zernioSocialReadinessPool: Pool | undefined;
    const zernioConfigured = [
      env.DATABASE_ZERNIO_SOCIAL_COMMAND_URL,
      env.PROPERTY_PREDATOR_ZERNIO_LIVE_CONNECTION_ID,
      env.PROPERTY_PREDATOR_ZERNIO_PROVIDER_PROFILE_ID,
      env.ZERNIO_API_KEY,
    ].some((value) => Boolean(value?.trim()));
    if (zernioConfigured) {
      let zernioPool: Pool | undefined;
      try {
        const workspaceId = env.PROPERTY_PREDATOR_PILOT_WORKSPACE_ID?.trim().toLowerCase() ?? '';
        const connectionId = env.PROPERTY_PREDATOR_ZERNIO_LIVE_CONNECTION_ID
          ?.trim().toLowerCase() ?? '';
        const providerProfileId = env.PROPERTY_PREDATOR_ZERNIO_PROVIDER_PROFILE_ID?.trim() ?? '';
        const apiKey = env.ZERNIO_API_KEY?.trim() ?? '';
        if (!PORTAL_UUID.test(workspaceId) || !PORTAL_UUID.test(connectionId)
            || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(providerProfileId)
            || apiKey.length < 8) {
          throw new Error('Zernio social connection seam is incomplete');
        }
        const zernioConfig = requireCutoverIdentity(
          loadDatabaseConfig('zernioSocialCommand', env),
          'DATABASE_ZERNIO_SOCIAL_COMMAND_URL',
          'r72_zernio_social_command',
        );
        zernioPool = createDatabasePool(zernioConfig);
        if (expectedInstallationId) {
          await assertExpectedDatabaseInstallation(zernioPool, expectedInstallationId);
        }
        await assertZernioSocialCommandBoundaryReady(zernioPool);
        zernioSocial = createPgPortalZernioSocialConnectionService({
          webPool,
          commandPool: zernioPool,
          workspaceId,
          providerConnectionId: connectionId,
          providerProfileId,
          liveClient: createZernioLiveConnectionClient({
            apiKey,
            providerProfileId,
            fetch: globalThis.fetch,
          }),
        });
        zernioSocialReadinessPool = zernioPool;
        pools.push(zernioPool);
      } catch {
        await zernioPool?.end().catch(() => undefined);
        zernioSocial = undefined;
        zernioSocialReadinessPool = undefined;
      }
    }

    // The founder command seam for the Twilio SMS rail. It rides only its own
    // least-privilege identity and stays undefined unless that identity proves
    // its exact boundary. Both the workspace and the connection id must be
    // pinned: the connection id is chosen before binding and is what the
    // binding command mints.
    let smsBinding: PgPortalSmsBindingService | undefined;
    let smsReadinessPool: Pool | undefined;
    if (env.DATABASE_SMS_COMMAND_URL?.trim()) {
      let smsPool: Pool | undefined;
      try {
        const workspaceId = env.PROPERTY_PREDATOR_SMS_LIVE_WORKSPACE_ID
          ?.trim().toLowerCase() ?? '';
        const connectionId = env.PROPERTY_PREDATOR_SMS_LIVE_CONNECTION_ID
          ?.trim().toLowerCase() ?? '';
        if (!PORTAL_UUID.test(workspaceId) || !PORTAL_UUID.test(connectionId)) {
          throw new Error(
            'Twilio SMS command seam requires the exact live workspace and connection',
          );
        }
        const smsConfig = requireCutoverIdentity(
          loadDatabaseConfig('smsCommand', env),
          'DATABASE_SMS_COMMAND_URL',
          'r72_sms_command',
        );
        smsPool = createDatabasePool(smsConfig);
        if (expectedInstallationId) {
          await assertExpectedDatabaseInstallation(smsPool, expectedInstallationId);
        }
        await assertSmsCommandBoundaryReady(smsPool);
        smsBinding = createPgPortalSmsBindingService({
          webPool,
          smsCommandPool: smsPool,
          commandService: createPgTwilioSmsLiveCommandService({
            commandPool: smsPool,
            workspaceId,
            providerConnectionId: connectionId,
          }),
          workspaceId,
        });
        smsReadinessPool = smsPool;
        pools.push(smsPool);
      } catch {
        await smsPool?.end().catch(() => undefined);
        smsBinding = undefined;
        smsReadinessPool = undefined;
      }
    }

    // Founder customer-email pilot. The readiness and endpoint seams run on the
    // CRM command identity because they are Lead 360 actions; the capped
    // enqueue runs on its own r72_customer_email_command identity and is
    // composed only when that boundary proves ready.
    let founderEmailPilot: PgPortalFounderEmailPilotService | undefined;
    let customerEmailCommand: CustomerEmailLiveCommandService | undefined;
    const emailWorkspaceId = env.PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_WORKSPACE_ID
      ?.trim().toLowerCase() ?? '';
    const emailConnectionId = env.PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_CONNECTION_ID
      ?.trim().toLowerCase() ?? '';
    if (env.DATABASE_CUSTOMER_EMAIL_COMMAND_URL?.trim()
        && PORTAL_UUID.test(emailWorkspaceId) && PORTAL_UUID.test(emailConnectionId)) {
      let emailPool: Pool | undefined;
      try {
        const emailConfig = requireCutoverIdentity(
          loadDatabaseConfig('customerEmailCommand', env),
          'DATABASE_CUSTOMER_EMAIL_COMMAND_URL',
          'r72_customer_email_command',
        );
        emailPool = createDatabasePool(emailConfig);
        if (expectedInstallationId) {
          await assertExpectedDatabaseInstallation(emailPool, expectedInstallationId);
        }
        await assertCustomerEmailCommandBoundaryReady(emailPool);
        customerEmailCommand = createPgCustomerEmailLiveCommandService({
          commandPool: emailPool,
          workspaceId: emailWorkspaceId,
          providerConnectionId: emailConnectionId,
        });
        pools.push(emailPool);
      } catch {
        await emailPool?.end().catch(() => undefined);
        customerEmailCommand = undefined;
      }
    }
    // The operator's own permission-use receipt, on the dedicated 0032
    // append-only identity. Never the CRM, web or customer-email credentials:
    // this one may write into a compliance ledger and must be able to do
    // nothing else at all.
    let permissionUseReceipts: PgPortalPermissionUseReceiptService | undefined;
    if (env.DATABASE_AFFILIATE_RECEIPT_COMMAND_URL?.trim()
        && PORTAL_UUID.test(emailWorkspaceId) && PORTAL_UUID.test(emailConnectionId)) {
      let receiptPool: Pool | undefined;
      try {
        const receiptConfig = requireCutoverIdentity(
          loadDatabaseConfig('affiliateReceiptCommand', env),
          'DATABASE_AFFILIATE_RECEIPT_COMMAND_URL',
          'r72_affiliate_receipt_command',
        );
        receiptPool = createDatabasePool(receiptConfig);
        if (expectedInstallationId) {
          await assertExpectedDatabaseInstallation(receiptPool, expectedInstallationId);
        }
        permissionUseReceipts = createPgPortalPermissionUseReceiptService({
          webPool,
          receiptPool,
          providerConnectionId: emailConnectionId,
          workspaceId: emailWorkspaceId,
        });
        pools.push(receiptPool);
      } catch {
        await receiptPool?.end().catch(() => undefined);
        permissionUseReceipts = undefined;
      }
    }
    // The 0065 evidence identity records the policy publication and PECR route
    // decisions the founder attests. It is composed on its own URL because it
    // may write into the compliance ledgers and must be able to do nothing
    // else: no enqueue, no content preparation, no provider, no consent.
    let founderPilotEvidencePool: Pool | undefined;
    if (env.DATABASE_FOUNDER_PILOT_EVIDENCE_COMMAND_URL?.trim()
        && PORTAL_UUID.test(emailWorkspaceId) && PORTAL_UUID.test(emailConnectionId)) {
      try {
        const evidenceConfig = requireCutoverIdentity(
          loadDatabaseConfig('founderPilotEvidenceCommand', env),
          'DATABASE_FOUNDER_PILOT_EVIDENCE_COMMAND_URL',
          'r72_founder_pilot_evidence_command',
        );
        founderPilotEvidencePool = createDatabasePool(evidenceConfig);
        if (expectedInstallationId) {
          await assertExpectedDatabaseInstallation(
            founderPilotEvidencePool, expectedInstallationId,
          );
        }
        pools.push(founderPilotEvidencePool);
      } catch {
        await founderPilotEvidencePool?.end().catch(() => undefined);
        founderPilotEvidencePool = undefined;
      }
    }
    // Compose the founder-facing preparation seam as soon as the exact
    // connection is known. Endpoint attachment, readiness and preparation use
    // the existing CRM boundary and must not disappear merely because the
    // effectful enqueue/receipt identities are still being installed. The
    // final authorisation remains fail-closed inside the service until both
    // least-privilege send boundaries are present.
    if (PORTAL_UUID.test(emailConnectionId)) {
      founderEmailPilot = createPgPortalFounderEmailPilotService({
        webPool,
        crmCommandPool: commandPool,
        providerConnectionId: emailConnectionId,
        ...(customerEmailCommand ? { commandService: customerEmailCommand } : {}),
        ...(permissionUseReceipts ? { permissionUse: permissionUseReceipts } : {}),
        ...(founderPilotEvidencePool ? { evidencePool: founderPilotEvidencePool } : {}),
      });
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
      zernioSocial,
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
      // Session-scoped like the other CRM commands: the workspace comes
      // from the resolved principal, and 0063 narrows the act to an active
      // owner or admin of that workspace.
      contactPermission: createPgPortalContactPermissionService({
        webPool,
        crmCommandPool: commandPool,
      }),
      campaignMachine: createPgPortalCampaignMachineService({ webPool }),
      ownedSeedCampaign,
      ownedSeedMessages,
      ownedSocialBinding,
      smsBinding,
      founderEmailPilot,
      customerEmailCommand,
      founderPilotEvidenceBound: founderPilotEvidencePool !== undefined,
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
          ...(ownedSocialReadinessPool
            ? [assertOwnedPublicSocialCommandBoundaryReady(ownedSocialReadinessPool)]
            : []),
          ...(zernioSocialReadinessPool
            ? [assertZernioSocialCommandBoundaryReady(zernioSocialReadinessPool)]
            : []),
          ...(smsReadinessPool ? [assertSmsCommandBoundaryReady(smsReadinessPool)] : []),
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
