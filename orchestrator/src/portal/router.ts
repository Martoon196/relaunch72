/**
 * The client portal — routes + the auth gate. Everything under /portal requires
 * a valid session except account actions. A discriminated dependency boundary
 * keeps canonical PostgreSQL workspaces separate from the local JSON demo.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { PlatformCapability } from '../platform/capabilities.js';
import type { CompanyContentCatalogItem } from '../company-content-pg/types.js';
import { parseCookies } from '../server/admin/session.js';
import {
  PORTAL_COOKIE,
  PORTAL_LOGIN_CSRF_COOKIE,
  PORTAL_SETUP_COOKIE,
  signTenant,
  verifyTenant,
  portalCookie,
  clearPortalCookie,
  portalSetupCookie,
  clearPortalSetupCookie,
  portalSetupCsrfToken,
  verifyPortalSetupCookie,
  verifyPortalSetupCsrf,
  isPortalSetupToken,
  portalCsrfToken,
  verifyPortalCsrf,
  portalLoginCsrfToken,
  portalLoginCsrfCookie,
  verifyPortalLoginCsrf,
  InMemorySetupThrottle,
} from './session.js';
import type { InMemoryLoginThrottle } from './session.js';
import { accountSetupPage, accountSetupUnavailablePage, loginPage, dashboardPage, billingPage } from './views.js';
import { appShell, escapeHtml } from './ui.js';
import { renderGrowthHomeBody } from './growth-home.js';
import { renderLead360Body } from './lead-360-view.js';
import { JOURNEY_BOARD_CLIENT_SOURCE } from './journey-board-client.js';
import {
  CONTENT_CALENDAR_CLIENT_ROUTE,
  CONTENT_CALENDAR_CLIENT_SOURCE,
} from './content-calendar-client.js';
import {
  CONTENT_CALENDAR_ROUTE,
  normaliseContentCalendarFilters,
  presentContentCalendar,
} from './content-calendar-presenter.js';
import {
  renderContentCalendarBody,
  type ContentCalendarMutationView,
  type ContentCalendarSlotActionView,
} from './content-calendar-view.js';
import { adaptPublicSocialCalendar } from './public-social-calendar-adapter.js';
import {
  CAMPAIGN_WIZARD_CREATE_TEST_ROUTE,
  CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE,
  CAMPAIGN_WIZARD_ROUTE,
  campaignWizardNoticeFromQuery,
  campaignWizardNoticeToken,
  isSafeCampaignWizardPortalPath,
  type CampaignWizardNoticeCode,
} from './campaign-wizard-actions.js';
import {
  presentCampaignWizard,
  type CampaignWizardContentSnapshot,
} from './campaign-wizard-presenter.js';
import { renderCampaignWizardBody } from './campaign-wizard-view.js';
import { planPropertyPredatorMarketingDraft } from '../company-content-adapter/property-predator-marketing-draft-plan.js';
import {
  PropertyPredatorCampaignDraftRuntimeError,
  type PropertyPredatorCampaignDraftApprovedVersionEvidence,
  type PropertyPredatorCampaignDraftRuntime,
} from '../company-content-adapter/property-predator-campaign-draft-runtime.js';
import { renderCampaignDraftReviewBody } from './campaign-draft-review-view.js';
import {
  CAMPAIGN_MACHINE_ROUTE,
  presentCampaignMachine,
} from './campaign-machine-presenter.js';
import { renderCampaignMachineBody } from './campaign-machine-view.js';
import type { PortalCampaignMachineService } from './campaign-machine-service.js';
import {
  PUBLIC_SOCIAL_CAMPAIGNS_ROUTE,
  presentPublicSocialCampaigns,
} from './public-social-campaigns-presenter.js';
import { renderPublicSocialCampaignsBody } from './public-social-campaigns-view.js';
import {
  JOURNEY_BOARD_CLIENT_ROUTE,
  JOURNEY_BOARD_ROUTE,
  renderJourneyBoardBody,
} from './journey-board-view.js';
import { renderJourneyManagerBody } from './journey-manager-view.js';
import {
  JOURNEY_MANAGER_CONFIRMATION,
  JOURNEY_MANAGER_INSTALL_ROUTE,
  JOURNEY_MANAGER_ROUTE,
  journeyManagerNoticeFromQuery,
  journeyManagerNoticeToken,
  presentJourneyManager,
  type JourneyManagerNoticeCode,
} from './journey-manager-presenter.js';
import type { PortalJourneyManagerService } from './journey-manager-service.js';
import {
  CONTENT_CONTROL_ROOM_ROUTE,
  presentContentControlRoom,
} from './content-control-room-presenter.js';
import { renderContentControlRoomBody } from './content-control-room-view.js';
import {
  CONTENT_APPROVAL_DECISION_ROUTE,
  CONTENT_APPROVAL_REQUEST_ROUTE,
  contentControlNoticeFromQuery,
  contentControlNoticeToken,
  exactReviewApprovalToken,
  verifyExactReviewApprovalToken,
  type ContentControlNoticeCode,
} from './content-control-room-actions.js';
import {
  type PortalCompanyContentService,
} from './company-content-service.js';
import { renderPortalCompanyContentReviewBody } from './company-content-review-view.js';
import { BRAND_BRAIN_ROUTE } from './brand-brain-actions.js';
import { presentBrandBrain } from './brand-brain-presenter.js';
import type {
  PortalBrandBrainService,
  PortalBrandBrainSnapshot,
} from './brand-brain-service.js';
import { renderBrandBrainBody } from './brand-brain-view.js';
import { createAuthoritativeImageStudioSnapshot } from './image-studio-authoritative.js';
import { IMAGE_STUDIO_ROUTE, presentImageStudio } from './image-studio-presenter.js';
import { renderImageStudioBody } from './image-studio-view.js';
import {
  COMPANY_ASSETS_ROUTE,
  COMPANY_ASSET_QUARANTINE_ROUTE,
  companyAssetsNoticeFromQuery,
  companyAssetsNoticeToken,
  type CompanyAssetsNoticeCode,
} from './company-assets-actions.js';
import { presentCompanyAssets } from './company-assets-presenter.js';
import type {
  PortalCompanyAssetQuarantineReasonCode,
  PortalCompanyAssetsService,
} from './company-assets-service.js';
import { renderCompanyAssetsBody } from './company-assets-view.js';
import {
  COMPANY_CONTENT_SYNC_ROUTE,
  companyContentSyncCommandToken,
  companyContentSyncNoticeFromQuery,
  companyContentSyncNoticeToken,
  verifyCompanyContentSyncCommandToken,
  type CompanyContentSyncNoticeCode,
} from './company-content-sync-actions.js';
import type { PortalCompanyContentSyncService } from './company-content-sync-service.js';
import { renderCompanyContentSyncBody } from './company-content-sync-view.js';
import {
  COMPANY_CONTENT_REVIEW_ROUTE_PREFIX,
  type PortalCompanyContentReviewService,
} from './company-content-review-service.js';
import { presentCompanyContentReview } from './company-content-review-presenter.js';
import { renderCompanyContentReviewBody } from './company-content-review-view.js';
import {
  CONVERSION_INBOX_MAX_CONVERSATIONS,
  CONVERSION_INBOX_ROUTE,
  normaliseConversionInboxFilters,
  presentConversionInbox,
  type ConversionInboxThreadSnapshot,
} from './conversion-inbox-presenter.js';
import { renderConversionInboxBody } from './conversion-inbox-view.js';
import type { PortalConversionInboxCommandService } from './conversion-inbox-service.js';
import {
  CONVERSION_INBOX_CALL_OUTCOMES,
  CONVERSION_INBOX_NEXT_ACTION_KINDS,
  CONVERSION_INBOX_NEXT_ACTION_PRIORITIES,
  type PortalConversionInboxOperationsService,
} from './conversion-inbox-operations-service.js';
import type { PortalLiveChannelTruthService } from './live-channel-truth-service.js';
import type { PortalLiveChannelPauseService } from './live-channel-pause-service.js';
import type { PortalOwnedSocialBindingService } from './owned-social-binding-service.js';
import type { PortalSmsBindingService } from './sms-binding-service.js';
import type { PortalOwnedSeedCampaignService } from './owned-seed-campaign-service.js';
import type { PortalOwnedSeedMessageService } from './owned-seed-message-service.js';
import {
  OWNED_SEED_CAMPAIGN_STAGE_ROUTE,
  OWNED_SEED_MESSAGE_APPROVAL_DECISION_ROUTE,
  OWNED_SEED_MESSAGE_APPROVAL_REQUEST_ROUTE,
  OWNED_SEED_MESSAGE_CREATE_ROUTE,
  OWNED_SEED_PROOF_PREPARE_ROUTE,
  ownedSeedWorkflowToken,
  verifyOwnedSeedWorkflowToken,
  type OwnedSeedWorkflowState,
} from './owned-seed-actions.js';
import {
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM,
  propertyPredatorOwnedSeedProofEmailCommand,
} from './owned-seed-proof-email.js';
import {
  CONVERSION_INBOX_CREATE_DRAFT_ROUTE,
  conversionInboxNoticeFromQuery,
  conversionInboxNoticeToken,
  isConversionInboxTestQueuePurpose,
  type ConversionInboxNoticeCode,
} from './conversion-inbox-actions.js';
import type { InboxConversationQuery } from '../inbox-pg/read-model.js';
import type { InboxConversationPage } from '../inbox-pg/types.js';
import { RELAUNCH72_PRODUCT_PROFILE, type PortalProductProfile } from './product-profile.js';
import {
  CRM_PORTAL_ROUTES,
  renderCrmContactsBody,
  renderCrmPipelineBody,
  renderCrmTasksBody,
  type CreateLeadFormState,
  type CrmNotice,
  type CrmWorkspaceSnapshot,
} from './crm-views.js';
import {
  crmNoticeFromQuery,
  crmNoticeToken,
  PortalCrmPageCursorError,
  type PortalCrmMutationOutcome,
  type PortalCrmNoticeCode,
  type PortalCrmRequestIdentity,
  type PortalCrmSnapshotRequest,
  type PortalCrmService,
} from './crm-service.js';
import { workspaceLocalDateTime } from './crm-pg-service.js';
import { CRM_PAGE_QUERY_KEY } from './crm-pagination.js';
import type { DashboardData } from './data.js';
import type { BillingView } from './billing.js';
import type { PortalAuthRequestContext, PortalAuthService, PortalSessionIdentity } from './auth-service.js';
import {
  PROPERTY_PREDATOR_SSO_CALLBACK_ROUTE,
  PROPERTY_PREDATOR_SSO_COOKIE,
  PROPERTY_PREDATOR_SSO_START_ROUTE,
  PropertyPredatorSsoAuthenticationError,
  clearPropertyPredatorSsoCookie,
  type PropertyPredatorSsoClient,
  type PropertyPredatorSsoProviderHint,
} from './property-predator-sso.js';
import {
  OPERATOR_ACTION_CENTRE_MAX_ACTIONS,
  OPERATOR_ACTION_CENTRE_ROUTE,
  presentOperatorActionCentre,
} from './operator-action-centre-presenter.js';
import { renderOperatorActionCentreBody } from './operator-action-centre-view.js';
import type { PortalOperatorActionCentreService } from './operator-action-centre-pg-service.js';
import {
  operatorActionNoticeFromQuery,
  operatorActionNoticeToken,
  operatorActionSnoozeChoiceToken,
  operatorActionSnoozeInstantFromToken,
  type OperatorActionNoticeCode,
} from './operator-action-centre-actions.js';
import {
  AFFILIATE_COMPLIANCE_ROUTE,
  presentAffiliateCompliance,
} from './affiliate-compliance-presenter.js';
import { renderAffiliateComplianceBody } from './affiliate-compliance-view.js';
import type { PortalAffiliateComplianceService } from './affiliate-compliance-service.js';
import {
  PROVIDER_READINESS_COCKPIT_ROUTE,
  presentProviderReadinessCockpit,
} from './provider-readiness-cockpit-presenter.js';
import { renderProviderReadinessCockpitBody } from './provider-readiness-cockpit-view.js';
import type { PortalProviderReadinessService } from './provider-readiness-cockpit-service.js';
import {
  LIVE_CHANNELS_OWNED_SOCIAL_BIND_ROUTE,
  LIVE_CHANNELS_OWNED_SOCIAL_REVOKE_ROUTE,
  LIVE_CHANNELS_OWNED_SOCIAL_STAGE_ROUTE,
  LIVE_CHANNELS_PAUSE_ROUTE,
  LIVE_CHANNELS_SMS_BIND_ROUTE,
  LIVE_CHANNELS_SMS_REVOKE_ROUTE,
  LIVE_CHANNELS_SMS_STAGE_ROUTE,
  LIVE_CHANNELS_ROUTE,
  presentLiveChannels,
  type LiveChannelsNoticeCode,
} from './live-channels-presenter.js';
import { renderLiveChannelsBody } from './live-channels-view.js';
import {
  liveChannelsNoticeFromQuery,
  liveChannelsNoticeToken,
} from './live-channels-actions.js';
import { createPropertyPredatorSocialAccountControlFixture } from './social-account-control-fixtures.js';
import {
  SOCIAL_ACCOUNT_CONTROL_ROUTE,
  presentSocialAccountControl,
} from './social-account-control-presenter.js';
import {
  renderSocialAccountControlBody,
  renderZernioSocialAccountControlBody,
} from './social-account-control-view.js';
import {
  ZERNIO_SOCIAL_CALLBACK_ROUTE,
  type PortalZernioFailureKind,
  type PortalZernioSocialConnectionService,
} from './zernio-social-connection-service.js';
import {
  zernioSocialNoticeFromQuery,
  zernioSocialNoticeToken,
  type ZernioSocialNoticeCode,
} from './zernio-social-actions.js';
import type { ZernioPilotNetwork } from '../public-social-outbound/index.js';
import type {
  PortalPublicSocialService,
  PortalPublicSocialSnapshot,
  PortalPublicSocialSnapshotOutcome,
} from './public-social-service.js';
import {
  authSubjectAbuseAdmission,
  classifyPortalAbuseRoute,
  principalAbuseAdmission,
  sourceAbuseAdmission,
  type PortalAbuseAdmission,
  type PortalAbuseGuard,
  type PortalAbuseOutcome,
} from './abuse.js';
import type { PortalRequestContext } from './request-context.js';
import { MigrationCentreError, type MigrationCentreErrorCode } from '../legacy-import/migration-centre.js';
import {
  MIGRATION_CENTRE_CLIENT_ROUTE,
  MIGRATION_CENTRE_PREVIEW_ROUTE,
  MIGRATION_CENTRE_ROUTE,
  presentPortalMigrationPreview,
  type PortalMigrationCentreService,
} from './migration-centre-service.js';
import {
  parsePortalMigrationPreviewCommand,
  portalMigrationCsrfHeader,
  portalMigrationRequestIsSameOrigin,
} from './migration-centre-http.js';
import { MIGRATION_CENTRE_CLIENT_SOURCE } from './migration-centre-client.js';
import { renderMigrationCentreBody } from './migration-centre-view.js';
import type { SafeTelemetryLogger } from '../ops/safe-telemetry.js';
import type { PortalContactPermissionService } from './contact-permission-service.js';
import type { PortalFounderEmailPilotService } from './founder-email-pilot-service.js';
import {
  CONTACT_ENDPOINT_ATTACH_ROUTE,
  CONTACT_ENDPOINT_CONFIRM_VALUE,
  CONTACT_ENDPOINT_FORM_KEYS,
  EMAIL_PILOT_AUTHORISE_FORM_KEYS,
  EMAIL_PILOT_AUTHORISE_ROUTE,
  EMAIL_PILOT_CONFIRM_VALUE,
  EMAIL_PILOT_POLICY_CONFIRM_VALUE,
  EMAIL_PILOT_POLICY_FORM_KEYS,
  EMAIL_PILOT_POLICY_ROUTE,
  EMAIL_PILOT_PREPARE_CONFIRM_VALUE,
  EMAIL_PILOT_PREPARE_FORM_KEYS,
  EMAIL_PILOT_PREPARE_ROUTE,
  founderEmailPilotNoticeFromQuery,
  founderEmailPilotNoticeToken,
  founderEmailPilotPreviewClaims,
  founderEmailPilotPreviewToken,
  founderEmailPilotStepClaims,
  type FounderEmailPilotNoticeCode,
} from './founder-email-pilot-actions.js';
import {
  FOUNDER_EMAIL_PILOT_BLOCKER_MESSAGES,
  type FounderEmailPilotBlockerCode,
} from '../founder-email-pilot/foundation.js';
import {
  FOUNDER_PILOT_INSTIGATOR,
  FOUNDER_PILOT_POLICY_ASSET_VERSION,
  FOUNDER_PILOT_POLICY_CLAUSES,
  FOUNDER_PILOT_REVIEW_AUTHORITY,
  FOUNDER_PILOT_ROUTE_CLASSIFICATION,
  FOUNDER_PILOT_SENDER,
} from '../founder-email-pilot/policy-asset.js';
import {
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_BODY,
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_SUBJECT,
} from './owned-seed-proof-email.js';

/** The canonical Property Predator marketing purpose from the shared contract. */
const FOUNDER_PILOT_PURPOSE = 'property_predator_marketing';
import {
  CONTACT_PERMISSION_CONFIRM_VALUE,
  CONTACT_PERMISSION_FORM_KEYS,
  CONTACT_PERMISSION_ROUTE,
  contactCaseFileRoute,
  contactPermissionNoticeFromQuery,
  contactPermissionNoticeToken,
  type ContactPermissionNoticeCode,
} from './contact-permission-actions.js';

interface PortalCommonDeps {
  sessionSecret: string;
  secure: boolean;
  /** Deployment-owned presentation. It never grants permissions or provider readiness. */
  productProfile?: PortalProductProfile;
  /** Process-local login limiter; replace with a shared implementation at multi-instance scale. */
  loginThrottle?: Pick<InMemoryLoginThrottle, 'reserve' | 'release' | 'failure' | 'success'>;
  /** Process-local setup limiter; keys are hashed source and token fingerprints only. */
  setupThrottle?: Pick<InMemorySetupThrottle, 'reserve' | 'release' | 'failure' | 'success'>;
  /**
   * Optional deployment-owned client address policy. It may inspect proxy
   * headers only after the deployment has authenticated its trusted proxy.
   * Without it, no shared socket/proxy address is used for source blocking.
   */
  trustedClientAddress?: (req: IncomingMessage) => string | undefined;
  /** Deployment-owned, once-per-request trusted proxy and HMAC boundary. */
  requestContext?: (req: IncomingMessage) => PortalRequestContext | null;
  /** Required for every production PostgreSQL portal request. */
  abuse?: PortalAbuseGuard;
  /** Dedicated HMAC secret used only to derive low-entropy abuse subjects. */
  abuseHashSecret?: string;
  now?: () => number;
  requestId?: () => string;
  /**
   * Optional sanitised service telemetry. The Inbox previously swallowed every
   * read failure, so a privilege regression surfaced only as "temporarily
   * unavailable" with no trail to follow. Only the fixed event allowlist is
   * reachable through this, and the record carries a correlation id, an error
   * class and a PostgreSQL SQLSTATE — never SQL, credentials, message bodies
   * or driver detail.
   */
  telemetry?: Pick<SafeTelemetryLogger, 'emit' | 'nextCorrelationId'>;
}

/** Explicit local-demo mode. This is the only mode allowed to touch JSON stores. */
export interface LegacyPortalDeps extends PortalCommonDeps {
  kind: 'legacy';
  /** Email + password → tenant id, or null if the credentials don't match. */
  login(email: string, password: string): Promise<string | null>;
  /** Consume a new customer's one-time setup token and set their password. */
  completeSetup?(token: string, password: string, now: number): Promise<string | null>;
  /** Assemble the dashboard for a tenant (CRM + brand + artifacts), or null. */
  dashboard(tenantId: string): Promise<DashboardData | null>;
  /** Run this period's marketing for a tenant (mock); returns how many tasks ran. */
  runTick(tenantId: string): Promise<number>;
  /** Resolve a tenant's billing status + plan options; absent = billing UI off. */
  billing?(tenantId: string): Promise<BillingView | null>;
  /** Start a subscription checkout for a plan; returns the Stripe URL to redirect to. */
  subscribeUrl?(plan: string, email: string | null): Promise<string>;
  /** Open the Stripe billing portal for an existing customer; returns the URL. */
  manageUrl?(customerId: string): Promise<string>;
  /** When true, "Run this week" requires an active subscription. Default false (£0 demo runs). */
  billingEnforced?: boolean;
  /** Durable CRM application boundary. Absent means the CRM remains visibly locked. */
  crm?: PortalCrmService;
}

/** Canonical PostgreSQL mode. No legacy tenant id or JSON dependency exists here. */
export interface PostgresPortalDeps extends PortalCommonDeps {
  kind: 'postgres';
  auth: PortalAuthService;
  /** Exact Property Predator authorization-code bridge; absent means no SSO routes or UI. */
  propertyPredatorSso?: PropertyPredatorSsoClient;
  crm: PortalCrmService;
  /** Exact, read-mostly conversion definition manager. Omitted until composed and ready. */
  journeys?: PortalJourneyManagerService;
  /** Authoritative cross-module operator queue; only assignment and snooze mutate its overlay. */
  operatorActions?: PortalOperatorActionCentreService;
  /** Company-owned immutable content catalogue. It exposes no provider or publish operation. */
  companyContent?: PortalCompanyContentService;
  /** Read-only owned-intelligence metadata. It exposes no review, activation or model operation. */
  brandBrain?: PortalBrandBrainService;
  /** Migration 0033 metadata and founder quarantine-only commands. */
  companyAssets?: PortalCompanyAssetsService;
  /** Founder/admin effects-off source sync and immutable import evidence. */
  companyContentSync?: PortalCompanyContentSyncService;
  /** Founder/admin exact staged-resource review. Read-only and provider-incapable. */
  companyContentReview?: PortalCompanyContentReviewService;
  /** Fixture-only affiliate legal/readiness evidence. It exposes no acceptance, link or channel command. */
  affiliateCompliance?: PortalAffiliateComplianceService;
  /** Dark-only provider readiness metadata. It exposes no credential, switch or provider operation. */
  providerReadiness?: PortalProviderReadinessService;
  /** Durable TEST-only campaign planning and safe social calendar projection. */
  publicSocial?: PortalPublicSocialService;
  /** Founder-only one-use Zernio account connection; contains no publication operation. */
  zernioSocial?: PortalZernioSocialConnectionService;
  /** One real company-content generation effect; output is source-review-only and never outbound. */
  campaignDrafts?: Pick<PropertyPredatorCampaignDraftRuntime, 'generateReviewDraft'>;
  /** TEST-only conversion queue. Thread detail remains a separate optional projection. */
  inbox?: PortalInboxReadBoundary;
  /** Durable TEST-only draft/approval/queue commands. It has no provider dispatcher. */
  inboxCommands?: PortalConversionInboxCommandService;
  /** Provider-incapable assignment, note and admin-call commands for the same Inbox. */
  inboxOperations?: PortalConversionInboxOperationsService;
  /** Evidence-only state/caps/blockers/receipts boundary for Live Channels consumers. */
  liveChannelTruth?: PortalLiveChannelTruthService;
  /** Founder/admin engage-only emergency pause; deliberately has no release command. */
  liveChannelPause?: PortalLiveChannelPauseService;
  /**
   * Founder-only owned Ayrshare/X profile binding and approved-publication
   * staging. Database-only: it cannot claim a worker lease or call Ayrshare.
   */
  ownedSocialBinding?: PortalOwnedSocialBindingService;
  /**
   * Founder-only Twilio SMS binding and owned-test staging. Database-only: it
   * cannot claim a worker lease or call Twilio.
   */
  smsBinding?: PortalSmsBindingService;
  /** Founder-only contact permission decisions on the Lead 360 case file. */
  contactPermission?: PortalContactPermissionService;
  /** Founder-only endpoint attach and customer-email pilot readiness. */
  founderEmailPilot?: PortalFounderEmailPilotService;
  /** RLS-scoped immutable campaign templates, steps, approvals and reporting evidence. */
  campaignMachine?: PortalCampaignMachineService;
  /** Fixed-recipient Mailgun job staging only; the worker remains a separate process. */
  ownedSeedCampaign?: PortalOwnedSeedCampaignService;
  /** Fixed-recipient LIVE draft and human message approval; it cannot stage or send. */
  ownedSeedMessages?: PortalOwnedSeedMessageService;
  /** Founder/admin effects-free CSV preview. No live importer or customer-write executor. */
  migrations?: PortalMigrationCentreService;
}

/**
 * Portal-facing inbox read boundary. Implementations own session resolution and
 * RLS context; the router never accepts a browser-supplied workspace id.
 */
export interface PortalInboxReadBoundary {
  listConversations(
    identity: PortalCrmRequestIdentity,
    query?: InboxConversationQuery,
  ): Promise<InboxConversationPage | null>;
  /** A real workspace-scoped projection only. Absence keeps the detail pane empty. */
  thread?(
    identity: PortalCrmRequestIdentity,
    conversationId: string,
  ): Promise<ConversionInboxThreadSnapshot | null>;
}

export type PortalDeps = LegacyPortalDeps | PostgresPortalDeps;

const DEFAULT_SETUP_THROTTLE = new InMemorySetupThrottle();
const SETUP_FAILURE_MESSAGE = 'This setup link is invalid, expired or has already been used. Contact support.';

function sendHtml(res: ServerResponse, code: number, body: string, cookie?: string | string[], extra: Record<string, string> = {}): void {
  const headers: Record<string, string | string[]> = {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  };
  if (cookie) headers['set-cookie'] = cookie;
  Object.assign(headers, extra);
  res.writeHead(code, headers);
  res.end(body);
}

function sendVerifiedCompanyArtwork(
  res: ServerResponse,
  artwork: Readonly<{
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
    sha256: string;
    bytes: Uint8Array;
  }>,
): void {
  res.writeHead(200, {
    'content-type': artwork.mediaType,
    'content-length': String(artwork.bytes.byteLength),
    'cache-control': 'private, no-store, max-age=0, no-transform',
    etag: `"sha256-${artwork.sha256}"`,
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; sandbox",
  });
  res.end(Buffer.from(artwork.bytes));
}

function sendAbuseStatus(
  res: ServerResponse,
  code: 429 | 503,
  retryAfterSeconds: number,
): void {
  const title = code === 429 ? 'Please slow down' : 'Workspace temporarily unavailable';
  const message = code === 429
    ? 'Too many requests were received. Wait briefly and try again.'
    : 'The protected request boundary is temporarily unavailable. Try again shortly.';
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
  sendHtml(res, code, body, undefined, {
    'retry-after': String(Math.max(1, Math.ceil(retryAfterSeconds))),
  });
}

async function reserveAbuse(
  res: ServerResponse,
  guard: PortalAbuseGuard,
  admission: PortalAbuseAdmission,
): Promise<Buffer | null | false> {
  try {
    const decision = await guard.admit(admission);
    if (!decision.allowed) {
      sendAbuseStatus(res, 429, decision.retryAfterSeconds);
      return false;
    }
    return decision.leaseHash;
  } catch {
    sendAbuseStatus(res, 503, 5);
    return false;
  }
}

function sendJavaScript(
  res: ServerResponse,
  body: string,
  cacheControl = 'no-cache, max-age=0, must-revalidate',
): void {
  res.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    // The asset has a stable URL, so every navigation must revalidate it after
    // a deploy rather than running markup against an hour-old enhancement.
    'cache-control': cacheControl,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

function sendJson(
  res: ServerResponse,
  code: number,
  payload: unknown,
  extra: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'private, no-store, max-age=0',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    ...extra,
  });
  res.end(body);
}

function sendLoginPage(
  res: ServerResponse,
  code: number,
  deps: PortalDeps,
  error?: string,
  email = '',
  extra: Record<string, string> = {},
  additionalCookies: readonly string[] = [],
): void {
  const csrfToken = portalLoginCsrfToken(deps.sessionSecret);
  sendHtml(
    res,
    code,
    loginPage(
      error,
      email,
      csrfToken,
      deps.productProfile ?? RELAUNCH72_PRODUCT_PROFILE,
      { propertyPredatorSso: deps.kind === 'postgres' && Boolean(deps.propertyPredatorSso) },
    ),
    [portalLoginCsrfCookie(csrfToken, deps.secure), ...additionalCookies],
    extra,
  );
}

function resolvedTrustedClientAddress(req: IncomingMessage, deps: PortalDeps): string | undefined {
  if (!deps.trustedClientAddress) return undefined;
  try {
    const candidate = deps.trustedClientAddress(req)?.trim();
    return candidate ? candidate.slice(0, 256) : undefined;
  } catch {
    return undefined;
  }
}

function sourceFingerprint(source: string): string {
  return createHash('sha256')
    .update('relaunch72/setup-source/v1\u0000')
    .update(source)
    .digest('hex');
}

function loginKeys(req: IncomingMessage, email: string, deps: PortalDeps): string[] {
  const accountHash = createHash('sha256')
    .update('relaunch72/login-account/v1\u0000')
    .update(email || 'unknown')
    .digest('hex');
  const keys = [`account:${accountHash}`];
  const source = resolvedTrustedClientAddress(req, deps);
  if (source) keys.push(`source:${sourceFingerprint(source)}`);
  return keys;
}

function setupKeys(req: IncomingMessage, setupToken: string, deps: PortalDeps): string[] {
  const tokenHash = createHash('sha256').update(setupToken).digest('hex');
  const keys = [`setup-token:${tokenHash}`];
  const source = resolvedTrustedClientAddress(req, deps);
  if (source) keys.unshift(`setup-source:${sourceFingerprint(source)}`);
  return keys;
}

function authRequestContext(
  req: IncomingMessage,
  now: number,
  requestContext: PortalRequestContext | null,
): PortalAuthRequestContext {
  const userAgent = Array.isArray(req.headers['user-agent'])
    ? req.headers['user-agent'][0]
    : req.headers['user-agent'];
  return {
    now,
    ...(requestContext?.sourceHash ? { sourceHash: Buffer.from(requestContext.sourceHash) } : {}),
    userAgent: userAgent?.slice(0, 4_096),
  };
}
function redirect(
  res: ServerResponse,
  to: string,
  cookie?: string | string[],
  code = 302,
  extra: Record<string, string> = {},
): void {
  const headers: Record<string, string | string[]> = { location: to, ...extra };
  if (cookie) headers['set-cookie'] = cookie;
  res.writeHead(code, headers);
  res.end();
}
function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: Record<string, string>): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) { chunks.length = 0; finish({}); return; }
      if (!settled) chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      const out: Record<string, string> = {};
      new URLSearchParams(Buffer.concat(chunks).toString('utf8')).forEach((v, k) => { out[k] = v; });
      finish(out);
    });
    req.on('error', () => finish({}));
  });
}

/**
 * Bounded application/x-www-form-urlencoded reader for commands with repeated
 * target/media ids. It preserves cardinality so duplicate singleton fields
 * cannot be silently collapsed into attacker-chosen values.
 */
function readMultiValueForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: URLSearchParams | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        chunks.length = 0;
        finish(null);
        return;
      }
      if (!settled) chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        finish(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      } catch {
        finish(null);
      }
    });
    req.on('error', () => finish(null));
  });
}

function oneFormValue(form: URLSearchParams, key: string): string | null {
  const values = form.getAll(key);
  return values.length === 1 ? values[0]! : null;
}

function crmPage(
  shell: Pick<CrmWorkspaceSnapshot, 'workspace'>,
  body: string,
  deps: PortalDeps,
  csrfToken: string,
): string {
  return appShell({
    title: `${deps.productProfile?.productName ?? 'Relaunch72'} CRM — ${shell.workspace.name}`,
    tenantName: shell.workspace.name,
    active: 'crm',
    productProfile: deps.productProfile,
    capabilities: new Set([
      'workspace.overview.read', 'crm.contacts.read', 'crm.pipeline.read', 'crm.tasks.read',
      ...((deps.kind === 'postgres' && deps.journeys) ? ['journeys.read'] as const : []),
      ...optionalPortalCapabilities(deps),
    ]),
    billingAvailable: deps.kind === 'legacy' && !!deps.billing,
    crmAvailable: true,
    mode: 'crm',
    csrfToken,
    body,
  });
}

function journeyManagerPage(
  shell: Pick<CrmWorkspaceSnapshot, 'workspace'>,
  body: string,
  deps: PostgresPortalDeps,
  csrfToken: string,
): string {
  return appShell({
    title: `${deps.productProfile?.productName ?? 'Relaunch72'} Journeys — ${shell.workspace.name}`,
    tenantName: shell.workspace.name,
    active: 'journeys',
    productProfile: deps.productProfile,
    capabilities: new Set([
      'workspace.overview.read', 'crm.contacts.read', 'crm.pipeline.read', 'crm.tasks.read', 'journeys.read',
      ...optionalPortalCapabilities(deps),
    ]),
    billingAvailable: false,
    crmAvailable: true,
    mode: 'crm',
    csrfToken,
    body,
  });
}

function journeyBoardPage(
  workspaceName: string,
  body: string,
  deps: PortalDeps,
  csrfToken: string,
): string {
  return appShell({
    title: `${deps.productProfile?.productName ?? 'Relaunch72'} Live Journeys — ${workspaceName}`,
    tenantName: workspaceName,
    active: 'journeys',
    productProfile: deps.productProfile,
    capabilities: new Set([
      'workspace.overview.read', 'crm.contacts.read', 'crm.pipeline.read', 'crm.tasks.read', 'journeys.read',
      ...optionalPortalCapabilities(deps),
    ]),
    billingAvailable: deps.kind === 'legacy' && !!deps.billing,
    crmAvailable: true,
    mode: 'crm',
    csrfToken,
    body,
  });
}

function journeySubnav(active: 'board' | 'rules'): string {
  return `<nav aria-label="Journey workspace" style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap"><a class="button ${active === 'board' ? '' : 'secondary'} compact" href="${JOURNEY_BOARD_ROUTE}"${active === 'board' ? ' aria-current="page"' : ''}>Live board</a><a class="button ${active === 'rules' ? '' : 'secondary'} compact" href="${JOURNEY_MANAGER_ROUTE}"${active === 'rules' ? ' aria-current="page"' : ''}>Journey rules</a></nav>`;
}

function optionalPortalCapabilities(deps: PortalDeps): readonly PlatformCapability[] {
  if (deps.kind !== 'postgres') return [];
  return [
    ...(deps.operatorActions ? ['actions.read'] as const : []),
    ...(deps.companyContent || deps.brandBrain || deps.companyAssets
        || deps.companyContentSync || deps.publicSocial
      ? ['content.drafts.read'] as const
      : []),
    ...(deps.affiliateCompliance ? ['affiliates.compliance.read'] as const : []),
    ...(deps.inbox ? ['conversations.read'] as const : []),
  ];
}

function operationalPage(
  workspaceName: string,
  body: string,
  deps: PostgresPortalDeps,
  active: 'overview' | 'content' | 'affiliates' | 'inbox',
  csrfToken: string,
  labelOverride?: string,
): string {
  const label = labelOverride ?? (active === 'overview'
    ? 'Provider Readiness'
    : active === 'content'
    ? 'Content Control'
    : active === 'affiliates'
      ? 'Affiliate Compliance'
      : 'Conversion Inbox');
  return appShell({
    title: `${deps.productProfile?.productName ?? 'Relaunch72'} ${label} — ${workspaceName}`,
    tenantName: workspaceName,
    active,
    productProfile: deps.productProfile,
    capabilities: new Set([
      'workspace.overview.read', 'crm.contacts.read', 'crm.pipeline.read', 'crm.tasks.read',
      ...(deps.journeys ? ['journeys.read'] as const : []),
      ...optionalPortalCapabilities(deps),
    ]),
    billingAvailable: false,
    crmAvailable: true,
    mode: 'crm',
    csrfToken,
    body,
  });
}

function migrationCentrePage(
  workspaceName: string,
  body: string,
  deps: PostgresPortalDeps,
  csrfToken: string,
): string {
  return appShell({
    title: `${deps.productProfile?.productName ?? 'Relaunch72'} Migration Centre — ${workspaceName}`,
    tenantName: workspaceName,
    active: 'crm',
    productProfile: deps.productProfile,
    capabilities: new Set([
      'workspace.overview.read', 'crm.contacts.read', 'crm.pipeline.read', 'crm.tasks.read',
      ...(deps.journeys ? ['journeys.read'] as const : []),
      ...optionalPortalCapabilities(deps),
    ]),
    billingAvailable: false,
    crmAvailable: true,
    mode: 'crm',
    csrfToken,
    body,
  });
}

function operatorActionPage(
  workspaceName: string,
  body: string,
  deps: PostgresPortalDeps,
  csrfToken: string,
  canWrite: boolean,
): string {
  return appShell({
    title: `${deps.productProfile?.productName ?? 'Relaunch72'} Actions — ${workspaceName}`,
    tenantName: workspaceName,
    active: 'actions',
    productProfile: deps.productProfile,
    capabilities: new Set([
      'workspace.overview.read', 'actions.read',
      ...(canWrite ? ['actions.manage'] as const : []),
      'crm.contacts.read', 'crm.pipeline.read', 'crm.tasks.read',
      ...(deps.journeys ? ['journeys.read'] as const : []),
      ...optionalPortalCapabilities(deps),
    ]),
    billingAvailable: false,
    crmAvailable: true,
    mode: 'crm',
    csrfToken,
    body,
  });
}

function portalStatusPage(
  deps: PortalDeps,
  sessionToken: string,
  options: {
    title: string;
    message: string;
    backHref?: string;
    backLabel?: string;
    active?: 'overview' | 'actions' | 'crm' | 'journeys' | 'content' | 'affiliates' | 'inbox' | 'billing';
    crmAvailable?: boolean;
  },
): string {
  const backHref = options.backHref ?? '/portal';
  const backLabel = options.backLabel ?? 'Return to workspace';
  const body = `<header class="page-heading"><div><div class="eyebrow">Workspace status</div><h1>${escapeHtml(options.title)}</h1><p>${escapeHtml(options.message)}</p></div></header>
    <section class="panel" aria-label="Recovery action"><div class="panel-body" style="padding-top:19px"><a class="button secondary" href="${escapeHtml(backHref)}">${escapeHtml(backLabel)}</a></div></section>`;
  return appShell({
    title: `${deps.productProfile?.productName ?? 'Relaunch72'} — ${options.title}`,
    tenantName: 'Your workspace',
    active: options.active ?? 'overview',
    productProfile: deps.productProfile,
    capabilities: new Set([
      'workspace.overview.read',
      ...((options.crmAvailable ?? !!deps.crm)
        ? ['crm.contacts.read', 'crm.pipeline.read', 'crm.tasks.read'] as const
        : []),
      ...((deps.kind === 'postgres' && deps.journeys) ? ['journeys.read'] as const : []),
      ...optionalPortalCapabilities(deps),
      ...((deps.kind === 'legacy' && !!deps.billing) ? ['billing.read'] as const : []),
    ]),
    billingAvailable: deps.kind === 'legacy' && !!deps.billing,
    crmAvailable: options.crmAvailable ?? !!deps.crm,
    mode: options.active === 'actions' || options.active === 'crm' || options.active === 'journeys'
      || options.active === 'content' || options.active === 'affiliates' || options.active === 'inbox' ? 'crm' : 'sandbox',
    csrfToken: portalCsrfToken(deps.sessionSecret, sessionToken),
    body,
  });
}

/**
 * One mapping for every owned-social failure, so no handler can soften a
 * denial into a generic rejection.
 */
function ownedSocialFailureNotice(
  kind: 'unauthenticated' | 'forbidden' | 'validation' | 'conflict' | 'blocked' | 'unavailable',
): LiveChannelsNoticeCode {
  // Deliberately distinct from the pause codes: an owned-social failure must
  // never be reported to a founder in pause language.
  if (kind === 'blocked') return 'staging_blocked';
  if (kind === 'forbidden' || kind === 'unauthenticated') return 'owned_social_forbidden';
  if (kind === 'validation' || kind === 'conflict') return 'owned_social_invalid';
  return 'owned_social_unavailable';
}

/**
 * One mapping for every Twilio SMS failure. Deliberately distinct from the
 * pause and owned-social codes so a founder is never told the wrong command
 * failed.
 */
function smsFailureNotice(
  kind: 'unauthenticated' | 'forbidden' | 'validation' | 'conflict' | 'blocked' | 'unavailable',
): LiveChannelsNoticeCode {
  if (kind === 'blocked') return 'sms_staging_blocked';
  if (kind === 'forbidden' || kind === 'unauthenticated') return 'sms_forbidden';
  if (kind === 'validation' || kind === 'conflict') return 'sms_invalid';
  return 'sms_unavailable';
}

function zernioFailureNotice(kind: PortalZernioFailureKind): ZernioSocialNoticeCode {
  if (kind === 'billing_required' || kind === 'rate_limited'
      || kind === 'provider_rejected') return kind;
  if (kind === 'forbidden' || kind === 'unauthenticated') return 'forbidden';
  if (kind === 'validation' || kind === 'conflict') return 'invalid';
  return 'unavailable';
}

function crmIdentity(sessionToken: string, deps: PortalDeps): PortalCrmRequestIdentity {
  return {
    sessionToken,
    requestId: deps.requestId ? deps.requestId() : randomUUID(),
  };
}

function companyContentSyncRedirect(
  res: ServerResponse,
  deps: PortalDeps,
  sessionToken: string,
  code: CompanyContentSyncNoticeCode,
): void {
  const notice = companyContentSyncNoticeToken(deps.sessionSecret, sessionToken, code);
  redirect(
    res,
    `${COMPANY_CONTENT_SYNC_ROUTE}?notice=${encodeURIComponent(notice)}`,
    undefined,
    303,
    { 'cache-control': 'no-store' },
  );
}

function contentCalendarReadRange(selectedDate: string): Readonly<{ from: string; to: string }> {
  const selected = Date.parse(`${selectedDate}T00:00:00.000Z`);
  const dayMs = 86_400_000;
  return Object.freeze({
    from: new Date(selected - (45 * dayMs)).toISOString(),
    to: new Date(selected + (46 * dayMs)).toISOString(),
  });
}

const CONTENT_CALENDAR_CREATE_TEST_ROUTE = '/portal/content/calendar/test-planning-intents';
const CONTENT_CALENDAR_RESCHEDULE_TEST_ROUTE = '/portal/content/calendar/test-reschedule';
const CONTENT_CALENDAR_CANCEL_TEST_ROUTE = '/portal/content/calendar/test-cancel';
const COMPANY_CONTENT_EXACT_REVIEW_ROUTE = /^\/portal\/content\/items\/([0-9a-f-]+)\/versions\/([0-9a-f-]+)\/review$/iu;
const CAMPAIGN_FORM_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]+$/u;
const CAMPAIGN_LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u;
const CAMPAIGN_RETURN_MODES = new Set(['week', 'month']);
const CAMPAIGN_RETURN_CHANNELS = new Set([
  'all', 'facebook', 'instagram', 'linkedin', 'tiktok', 'x', 'youtube',
  'google_business_profile', 'threads', 'pinterest', 'email', 'webinar',
]);
const CAMPAIGN_REVIEW_DRAFT_MAXIMUM_COST_MINOR = 250;
const CAMPAIGN_REVIEW_DRAFT_PLATFORMS = new Set(['linkedin', 'instagram', 'facebook', 'x']);
const CAMPAIGN_REVIEW_DRAFT_TONES = new Set([
  'direct and useful',
  'educational and evidence-led',
  'challenging but credible',
]);

function campaignFormText(value: string | null, maximumBytes: number): string | null {
  if (value === null || value !== value.trim() || !value || !CAMPAIGN_FORM_TEXT.test(value)
      || Buffer.byteLength(value, 'utf8') > maximumBytes) return null;
  return value;
}

function campaignUuidValues(
  form: URLSearchParams,
  key: string,
  minimum: number,
  maximum: number,
): readonly string[] | null {
  const supplied = form.getAll(key).map((value) => value.trim().toLowerCase());
  if (supplied.length < minimum || supplied.length > maximum
      || supplied.some((value) => !CRM_OBJECT_ID.test(value))
      || new Set(supplied).size !== supplied.length) return null;
  return Object.freeze(supplied);
}

function campaignDraftEvidence(
  item: CompanyContentCatalogItem,
): PropertyPredatorCampaignDraftApprovedVersionEvidence | null {
  if (item.approvalStatus !== 'approved' || item.approvalStale
      || !item.sourceFresh || !item.publishable
      || !item.approvalRequestId || !item.approvalDecisionId
      || item.source.system !== 'propertypredator.company-content') return null;
  return Object.freeze({
    contentItemId: item.contentItemId,
    contentVersionId: item.contentVersionId,
    versionNumber: item.versionNumber,
    contentSha256: item.contentSha256,
    blobSha256: item.blobSha256,
    brandSha256: item.brandSha256,
    approvalRequestId: item.approvalRequestId,
    approvalDecisionId: item.approvalDecisionId,
    approvalStatus: 'approved',
    approvalStale: false,
    sourceFresh: true,
    publishable: true,
    sourceSystem: 'propertypredator.company-content',
    sourceItemId: item.source.itemId,
    sourceVersion: item.source.version,
    kind: item.kind,
  });
}

function campaignFailureNotice(kind: string): CampaignWizardNoticeCode {
  if (kind === 'unauthenticated' || kind === 'forbidden') return 'forbidden';
  if (kind === 'validation') return 'invalid';
  if (kind === 'not_found') return 'missing';
  if (kind === 'conflict') return 'conflict';
  return 'unavailable';
}

function campaignCalendarReturnQuery(form: URLSearchParams): URLSearchParams {
  const query = new URLSearchParams();
  const mode = oneFormValue(form, 'return_mode');
  if (mode && CAMPAIGN_RETURN_MODES.has(mode)) query.set('mode', mode);
  const date = oneFormValue(form, 'return_date');
  if (date && /^\d{4}-\d{2}-\d{2}$/u.test(date)) query.set('date', date);
  const channel = oneFormValue(form, 'return_channel');
  if (channel && CAMPAIGN_RETURN_CHANNELS.has(channel)) query.set('channel', channel);
  return query;
}

function campaignNoticeLocation(
  deps: PostgresPortalDeps,
  sessionToken: string,
  code: CampaignWizardNoticeCode,
  destination: typeof CAMPAIGN_WIZARD_ROUTE | typeof CONTENT_CALENDAR_ROUTE,
  returnQuery?: URLSearchParams,
): string {
  const query = returnQuery ?? new URLSearchParams();
  query.set('notice', campaignWizardNoticeToken(deps.sessionSecret, sessionToken, code));
  return `${destination}?${query.toString()}`;
}

function campaignNoticeRedirect(
  res: ServerResponse,
  deps: PostgresPortalDeps,
  sessionToken: string,
  code: CampaignWizardNoticeCode,
  destination: typeof CAMPAIGN_WIZARD_ROUTE | typeof CONTENT_CALENDAR_ROUTE,
  returnQuery?: URLSearchParams,
): void {
  redirect(
    res,
    campaignNoticeLocation(deps, sessionToken, code, destination, returnQuery),
    undefined,
    303,
  );
}

function campaignContentSnapshot(
  item: CompanyContentCatalogItem,
): CampaignWizardContentSnapshot {
  const approvalStatus: CampaignWizardContentSnapshot['approvalStatus'] = item.approvalStale
    ? 'unavailable'
    : item.approvalStatus === 'approved'
      || item.approvalStatus === 'pending'
      || item.approvalStatus === 'rejected'
      || item.approvalStatus === 'changes_requested'
      ? item.approvalStatus
      : 'unavailable';
  const kindLabel = item.kind === 'social_post' ? 'Social post'
    : item.kind === 'image' ? 'Artwork'
      : item.kind === 'video' ? 'Video'
        : item.kind === 'email' ? 'Email'
          : item.kind === 'webinar' ? 'Webinar'
            : item.kind === 'article' ? 'Article'
              : item.kind === 'document' ? 'Document'
                : 'Company content';
  return Object.freeze({
    contentItemId: item.contentItemId,
    contentVersionId: item.contentVersionId,
    contentSha256: item.contentSha256,
    brandSha256: item.brandSha256,
    title: item.title,
    versionNumber: item.versionNumber,
    kindLabel,
    approvalStatus,
    sourceFresh: item.sourceFresh,
    publishable: item.publishable,
  });
}

function publicSocialPlanningMutations(
  deps: PostgresPortalDeps,
  sessionToken: string,
  snapshot: PortalPublicSocialSnapshot,
  view: ReturnType<typeof presentContentCalendar>,
  query: URLSearchParams,
): ContentCalendarMutationView | undefined {
  const planning = snapshot.planning;
  if (!planning) return undefined;
  const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
  const canManage = snapshot.workspace.canManage;
  const slotViews = new Map(view.days.flatMap((day) => day.slots).map((slot) => [slot.slotId, slot]));
  const slots: Record<string, ContentCalendarSlotActionView> = {};
  for (const row of planning.calendar.items) {
    const slotId = row.materializedOperationId ?? `${row.intentId}:${row.targetId}`;
    const presented = slotViews.get(slotId)?.planning;
    if (!presented) continue;
    const active = row.planningState !== 'cancelled'
      && row.planningState !== 'superseded'
      && row.planningState !== 'materialized';
    slots[slotId] = Object.freeze({
      intentId: row.intentId,
      targetId: row.targetId,
      intentSha256: row.intentSha256,
      expectedUpdatedAt: row.updatedAt,
      ...(active && canManage && deps.publicSocial?.reschedule ? {
        reschedule: Object.freeze({
          actionUrl: CONTENT_CALENDAR_RESCHEDULE_TEST_ROUTE,
          csrfToken,
          commandKey: randomUUID(),
        }),
      } : {}),
      ...(active && canManage && deps.publicSocial?.cancel ? {
        cancel: Object.freeze({
          actionUrl: CONTENT_CALENDAR_CANCEL_TEST_ROUTE,
          csrfToken,
          commandKey: randomUUID(),
        }),
      } : {}),
      jitStatus: Object.freeze({
        state: presented.statusTone,
        label: presented.statusLabel,
        detail: presented.statusDetail,
        nextRevalidationAt: presented.nextRevalidationAt,
      }),
    });
  }
  const revisions = new Map<string, { value: string; label: string; detail: string }>();
  for (const row of planning.calendar.items) {
    const value = `${row.campaignId}:${row.revisionId}`;
    if (!revisions.has(value)) revisions.set(value, {
      value,
      label: row.campaignTitle,
      detail: `Immutable revision ${row.revisionNumber}`,
    });
  }
  const eligibleContent = view.backlog.filter((item) => item.simulationEligible);
  const create = canManage && deps.publicSocial?.plan && revisions.size > 0
    && eligibleContent.length > 0 && planning.targets.items.length > 0
    ? Object.freeze({
        actionUrl: CONTENT_CALENDAR_CREATE_TEST_ROUTE,
        csrfToken,
        commandKey: randomUUID(),
        campaignRevisions: Object.freeze([...revisions.values()]),
        contentVersions: Object.freeze(eligibleContent.map((item) => Object.freeze({
          value: item.contentVersionId,
          label: item.title,
          detail: `Immutable v${item.versionNumber} · ${item.shortHash}…`,
        }))),
        targets: Object.freeze(planning.targets.items.map((target) => Object.freeze({
          value: target.targetId,
          label: target.targetLabel,
          detail: `${target.network} · TEST only`,
        }))),
      })
    : undefined;
  const notice = campaignWizardNoticeFromQuery(
    query,
    deps.sessionSecret,
    sessionToken,
  );
  return Object.freeze({
    ...(create ? { create } : {}),
    ...(Object.keys(slots).length > 0 ? { slots: Object.freeze(slots) } : {}),
    ...(notice ? { outcome: notice } : {}),
  });
}

function campaignFormKeysAllowed(form: URLSearchParams, allowed: ReadonlySet<string>): boolean {
  return [...form.keys()].every((key) => allowed.has(key));
}

async function campaignCommandSnapshot(
  service: PortalPublicSocialService,
  identity: PortalCrmRequestIdentity,
  now: number,
  selectedDate?: string | null,
): Promise<PortalPublicSocialSnapshotOutcome> {
  const asOf = new Date(now).toISOString();
  const filters = normaliseContentCalendarFilters({ date: selectedDate }, asOf);
  const range = contentCalendarReadRange(filters.date);
  return service.snapshot(identity, { from: range.from, to: range.to, limit: 120 });
}

function campaignDesiredInstant(
  form: URLSearchParams,
  workspaceTimezone: string,
  requireTimezoneEcho = true,
): string | null {
  const local = oneFormValue(form, 'desired_for_local');
  const suppliedTimezone = oneFormValue(form, 'timezone');
  if (!local || !CAMPAIGN_LOCAL_TIME.test(local)
      || (requireTimezoneEcho && suppliedTimezone !== workspaceTimezone)) return null;
  try {
    return workspaceLocalDateTime(local, workspaceTimezone);
  } catch {
    return null;
  }
}

function campaignCommandKey(form: URLSearchParams): string | null {
  const key = oneFormValue(form, 'command_key');
  return key && /^[\x21-\x7e]{8,200}$/u.test(key) ? key : null;
}

function campaignMaxAttempts(form: URLSearchParams): number | null {
  const value = oneFormValue(form, 'max_attempts');
  return value === '1' || value === '2' || value === '3' ? Number(value) : null;
}

function campaignCanonicalInstant(value: string | null): value is string {
  if (!value) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function crmSnapshotRequest(path: string, query: URLSearchParams): PortalCrmSnapshotRequest {
  const cursorValues = query.getAll(CRM_PAGE_QUERY_KEY);
  if (cursorValues.length > 1) throw new PortalCrmPageCursorError();
  const cursor = cursorValues.length === 1 ? cursorValues[0]! : undefined;
  if (path === CRM_PORTAL_ROUTES.contacts) {
    return { section: 'contacts', ...(cursor !== undefined ? { cursor } : {}) };
  }
  if (path === CRM_PORTAL_ROUTES.pipeline) {
    return { section: 'pipeline', ...(cursor !== undefined ? { cursor } : {}) };
  }

  const statusValues = query.getAll('status');
  if (statusValues.length > 1) throw new PortalCrmPageCursorError();
  const filter = statusValues[0] ?? 'open';
  if (filter !== 'open' && filter !== 'completed' && filter !== 'all') {
    throw new PortalCrmPageCursorError();
  }
  return {
    section: 'tasks',
    filter,
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

function journeyRedirect(
  res: ServerResponse,
  deps: PostgresPortalDeps,
  sessionToken: string,
  code: JourneyManagerNoticeCode,
): void {
  const token = journeyManagerNoticeToken(deps.sessionSecret, sessionToken, code);
  redirect(res, `${JOURNEY_MANAGER_ROUTE}?notice=${encodeURIComponent(token)}`, undefined, 303);
}

function crmRedirect(
  res: ServerResponse,
  route: string,
  deps: PortalDeps,
  sessionToken: string,
  code: PortalCrmNoticeCode,
  status = 302,
  returnParams?: URLSearchParams,
): void {
  const token = crmNoticeToken(deps.sessionSecret, sessionToken, code);
  const query = new URLSearchParams({ notice: token });
  returnParams?.forEach((value, key) => query.set(key, value));
  redirect(res, `${route}?${query.toString()}`, undefined, status);
}

const CONTENT_RETURN_CHANNELS = new Set(['all', 'social', 'email', 'webinar', 'library']);
const CONTENT_RETURN_FORMATS = new Set([
  'all', 'article', 'document', 'email', 'image', 'social_post', 'video', 'webinar', 'other',
]);

function contentControlReturnLocation(
  form: Readonly<Record<string, string>>,
  noticeToken: string,
): string {
  const exactItemId = (form.return_exact_item_id ?? '').trim().toLowerCase();
  const exactVersionId = (form.return_exact_version_id ?? '').trim().toLowerCase();
  if (CRM_OBJECT_ID.test(exactItemId) && CRM_OBJECT_ID.test(exactVersionId)) {
    const query = new URLSearchParams({ notice: noticeToken });
    return `/portal/content/items/${encodeURIComponent(exactItemId)}`
      + `/versions/${encodeURIComponent(exactVersionId)}/review?${query.toString()}`;
  }
  const query = new URLSearchParams({ notice: noticeToken });
  const search = (form.return_q ?? '').trim();
  if (search && search.length <= 80 && !/[\u0000-\u001f\u007f]/u.test(search)) query.set('q', search);
  const channel = (form.return_channel ?? '').trim();
  if (CONTENT_RETURN_CHANNELS.has(channel) && channel !== 'all') query.set('channel', channel);
  const format = (form.return_format ?? '').trim();
  if (CONTENT_RETURN_FORMATS.has(format) && format !== 'all') query.set('format', format);
  const anchor = /^(?:ccr-content-)[1-9][0-9]{0,2}$/u.test(form.return_anchor ?? '')
    ? `#${form.return_anchor}`
    : '';
  return `${CONTENT_CONTROL_ROOM_ROUTE}?${query.toString()}${anchor}`;
}

function contentControlRedirect(
  res: ServerResponse,
  deps: PostgresPortalDeps,
  sessionToken: string,
  form: Readonly<Record<string, string>>,
  code: ContentControlNoticeCode,
): void {
  const noticeToken = contentControlNoticeToken(deps.sessionSecret, sessionToken, code);
  redirect(res, contentControlReturnLocation(form, noticeToken), undefined, 303);
}

function exactCompanyContentReviewLocation(
  contentItemId: string,
  contentVersionId: string,
  query?: Readonly<{ notice?: string; ownedSeed?: string }>,
): string {
  const params = new URLSearchParams();
  if (query?.notice) params.set('notice', query.notice);
  if (query?.ownedSeed) params.set('owned_seed', query.ownedSeed);
  const suffix = params.size ? `?${params.toString()}` : '';
  return `/portal/content/items/${encodeURIComponent(contentItemId)}`
    + `/versions/${encodeURIComponent(contentVersionId)}/review${suffix}`;
}

function ownedSeedWorkflowRedirect(
  res: ServerResponse,
  deps: PostgresPortalDeps,
  sessionToken: string,
  contentItemId: string,
  state: OwnedSeedWorkflowState | null,
  code?: ContentControlNoticeCode,
): void {
  const notice = code
    ? contentControlNoticeToken(deps.sessionSecret, sessionToken, code)
    : undefined;
  const token = state
    ? ownedSeedWorkflowToken(deps.sessionSecret, sessionToken, state, deps.now ? deps.now() : Date.now())
    : undefined;
  const contentVersionId = state?.companyContentVersionId ?? '';
  if (!CRM_OBJECT_ID.test(contentItemId) || !CRM_OBJECT_ID.test(contentVersionId) || (state && !token)) {
    const fallback = contentControlNoticeToken(deps.sessionSecret, sessionToken, code ?? 'invalid');
    redirect(res, `${CONTENT_CONTROL_ROOM_ROUTE}?notice=${encodeURIComponent(fallback)}`, undefined, 303);
    return;
  }
  redirect(res, exactCompanyContentReviewLocation(contentItemId, contentVersionId, {
    ...(notice ? { notice } : {}),
    ...(token ? { ownedSeed: token } : {}),
  }), undefined, 303, { 'cache-control': 'no-store' });
}

function ownedSeedWorkflowFailure(kind: string): ContentControlNoticeCode {
  if (kind === 'unauthenticated' || kind === 'forbidden') return 'forbidden';
  if (kind === 'validation') return 'invalid';
  if (kind === 'conflict') return 'conflict';
  return 'unavailable';
}

function contentFailureNotice(kind: string): ContentControlNoticeCode {
  if (kind === 'unauthenticated' || kind === 'forbidden') return 'forbidden';
  if (kind === 'validation') return 'invalid';
  if (kind === 'not_found') return 'missing';
  if (kind === 'review_unavailable') return 'review_unavailable';
  if (kind === 'idempotency_conflict' || kind === 'command_in_progress'
      || kind === 'version_conflict' || kind === 'approval_conflict') return 'conflict';
  return 'unavailable';
}

function companyAssetsReturnLocation(
  form: Readonly<Record<string, string>>,
  noticeToken: string,
): string {
  const anchor = /^(?:company-asset-)[1-9][0-9]{0,1}$/u.test(form.return_anchor ?? '')
    ? `#${form.return_anchor}`
    : '';
  return `${COMPANY_ASSETS_ROUTE}?notice=${encodeURIComponent(noticeToken)}${anchor}`;
}

function companyAssetsRedirect(
  res: ServerResponse,
  deps: PostgresPortalDeps,
  sessionToken: string,
  form: Readonly<Record<string, string>>,
  code: CompanyAssetsNoticeCode,
): void {
  redirect(
    res,
    companyAssetsReturnLocation(
      form,
      companyAssetsNoticeToken(deps.sessionSecret, sessionToken, code),
    ),
    undefined,
    303,
  );
}

function companyAssetsFailureNotice(kind: string): CompanyAssetsNoticeCode {
  if (kind === 'unauthenticated' || kind === 'forbidden') return 'forbidden';
  if (kind === 'validation') return 'invalid';
  if (kind === 'not_found') return 'missing';
  if (kind === 'review_unavailable') return 'review_unavailable';
  if (kind === 'idempotency_conflict' || kind === 'exact_item_conflict') return 'conflict';
  return 'unavailable';
}

const INBOX_RETURN_CHANNELS = new Set(['all', 'email', 'whatsapp', 'sms', 'instagram', 'facebook']);
const INBOX_RETURN_QUEUES = new Set(['all', 'unread', 'approval', 'open']);
const INBOX_MESSAGE_VERSION_ROUTE = /^\/portal\/inbox\/messages\/([0-9a-f-]+)\/versions$/iu;
const INBOX_APPROVAL_REQUEST_ROUTE = /^\/portal\/inbox\/messages\/([0-9a-f-]+)\/approval-requests$/iu;
const INBOX_APPROVAL_DECISION_ROUTE = /^\/portal\/inbox\/approval-requests\/([0-9a-f-]+)\/decisions$/iu;
const INBOX_ASSIGNMENT_ROUTE = /^\/portal\/inbox\/conversations\/([0-9a-f-]+)\/assignment$/iu;
const INBOX_INTERNAL_NOTE_ROUTE = /^\/portal\/inbox\/conversations\/([0-9a-f-]+)\/internal-notes$/iu;
const INBOX_ADMIN_CALL_ROUTE = /^\/portal\/inbox\/conversations\/([0-9a-f-]+)\/admin-calls$/iu;
const INBOX_CALL_OUTCOME_ROUTE = /^\/portal\/inbox\/admin-calls\/([0-9a-f-]+)\/outcomes$/iu;
const INBOX_CALL_OUTCOME_VALUES = new Set<string>(CONVERSION_INBOX_CALL_OUTCOMES);
const INBOX_NEXT_ACTION_KIND_VALUES = new Set<string>(CONVERSION_INBOX_NEXT_ACTION_KINDS);
const INBOX_NEXT_ACTION_PRIORITY_VALUES = new Set<string>(
  CONVERSION_INBOX_NEXT_ACTION_PRIORITIES,
);
const INBOX_TEST_QUEUE_ROUTE = /^\/portal\/inbox\/messages\/([0-9a-f-]+)\/test-queue$/iu;

function conversionInboxReturnLocation(
  form: Readonly<Record<string, string>>,
  noticeToken: string,
): string {
  const query = new URLSearchParams({ notice: noticeToken });
  const search = (form.return_q ?? '').trim();
  if (search && search.length <= 80 && !/[\u0000-\u001f\u007f]/u.test(search)) query.set('q', search);
  const channel = (form.return_channel ?? '').trim();
  if (INBOX_RETURN_CHANNELS.has(channel) && channel !== 'all') query.set('channel', channel);
  const queue = (form.return_queue ?? '').trim();
  if (INBOX_RETURN_QUEUES.has(queue) && queue !== 'all') query.set('queue', queue);
  const conversation = (form.return_conversation ?? '').trim().toLowerCase();
  if (CRM_OBJECT_ID.test(conversation)) query.set('conversation', conversation);
  return `${CONVERSION_INBOX_ROUTE}?${query.toString()}`;
}

function conversionInboxRedirect(
  res: ServerResponse,
  deps: PostgresPortalDeps,
  sessionToken: string,
  form: Readonly<Record<string, string>>,
  code: ConversionInboxNoticeCode,
): void {
  const token = conversionInboxNoticeToken(deps.sessionSecret, sessionToken, code);
  redirect(res, conversionInboxReturnLocation(form, token), undefined, 303);
}

function conversionInboxFailureNotice(kind: string): ConversionInboxNoticeCode {
  if (kind === 'unauthenticated' || kind === 'forbidden') return 'forbidden';
  if (kind === 'validation') return 'invalid';
  if (kind === 'not_found') return 'missing';
  if (kind === 'consent_blocked') return 'consent_blocked';
  if (kind === 'idempotency_conflict' || kind === 'command_in_progress'
      || kind === 'version_conflict') return 'conflict';
  return 'unavailable';
}

const JOURNEY_BOARD_RETURN_BANDS = new Set(['burning', 'hot', 'warm', 'quiet', 'unscored']);

function journeyBoardReturnParams(form: Readonly<Record<string, string>>): URLSearchParams {
  const query = new URLSearchParams();
  const search = (form.return_q ?? '').trim();
  if (search && search.length <= 120 && !/[\u0000-\u001f\u007f]/u.test(search)) query.set('q', search);
  const route = (form.return_route ?? '').trim();
  if (/^[a-z0-9][a-z0-9._-]{0,99}$/u.test(route)) query.set('route', route);
  const band = (form.return_band ?? '').trim();
  if (JOURNEY_BOARD_RETURN_BANDS.has(band)) query.set('band', band);
  return query;
}

function outcomeNotice(outcome: PortalCrmMutationOutcome): CrmNotice {
  if (outcome.ok) {
    return { kind: 'success', title: 'Saved', message: 'The CRM change was saved.' };
  }
  return {
    kind: outcome.kind === 'conflict' ? 'conflict' : outcome.kind === 'validation' ? 'error' : 'error',
    title: outcome.kind === 'forbidden' ? 'Read-only access'
      : outcome.kind === 'unavailable' ? 'CRM temporarily unavailable'
        : outcome.kind === 'not_found' ? 'Record not found'
          : outcome.kind === 'conflict' ? 'Record changed'
            : 'Check the lead details',
    message: outcome.message,
  };
}

const OPERATOR_ACTION_COMMAND_ROUTE = /^\/portal\/actions\/([^/]+)\/(snooze|assignment)$/u;
const OPERATOR_ACTION_ID = /^[a-z][a-z0-9._:-]{2,159}$/u;
const OPERATOR_ACTION_SNOOZE_CHOICES = Object.freeze([
  Object.freeze({ minutes: 60, label: '1 hour' }),
  Object.freeze({ minutes: 240, label: '4 hours' }),
  Object.freeze({ minutes: 1_440, label: '1 day' }),
]);

function operatorActionRedirect(
  res: ServerResponse,
  deps: PostgresPortalDeps,
  sessionToken: string,
  code: OperatorActionNoticeCode,
): void {
  const notice = operatorActionNoticeToken(deps.sessionSecret, sessionToken, code);
  redirect(res, `${OPERATOR_ACTION_CENTRE_ROUTE}?notice=${encodeURIComponent(notice)}`, undefined, 303);
}

function operatorActionFailureNotice(kind: string): OperatorActionNoticeCode {
  if (kind === 'forbidden') return 'forbidden';
  if (kind === 'conflict') return 'conflict';
  if (kind === 'not_found') return 'missing';
  if (kind === 'validation') return 'invalid';
  return 'unavailable';
}

function decodedOperatorActionId(encoded: string): string | null {
  try {
    const value = decodeURIComponent(encoded);
    return OPERATOR_ACTION_ID.test(value) ? value : null;
  } catch {
    return null;
  }
}

const CRM_OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function migrationErrorStatus(code: MigrationCentreErrorCode | 'forbidden'): number {
  if (code === 'forbidden' || code === 'principal_forbidden') return 403;
  if (code === 'rate_limited') return 429;
  if (code === 'idempotency_conflict') return 409;
  if (code === 'source_too_large') return 413;
  if (code === 'control_unavailable') return 503;
  return 400;
}

function sendMigrationError(
  res: ServerResponse,
  code: MigrationCentreErrorCode | 'forbidden',
  message: string,
  retryAfterSeconds: number | null = null,
): void {
  const status = migrationErrorStatus(code);
  sendJson(res, status, {
    ok: false,
    error: { code, message },
    ...(retryAfterSeconds === null ? {} : { retryAfterSeconds }),
  }, status === 429 && retryAfterSeconds !== null
    ? { 'retry-after': String(Math.max(1, Math.ceil(retryAfterSeconds))) }
    : {});
}

/** Handle a request under /portal. Always writes a response. */
export async function handlePortal(req: IncomingMessage, res: ServerResponse, deps: PortalDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/portal';
  const method = req.method ?? 'GET';
  const now = deps.now ? deps.now() : Date.now();
  const routeClass = classifyPortalAbuseRoute(p, method);
  const resolvedRequestContext = deps.requestContext?.(req) ?? null;
  if (deps.abuse && !resolvedRequestContext) {
    return sendAbuseStatus(res, 503, 30);
  }
  if (resolvedRequestContext) {
    // Freeze deployment-derived request evidence once. Existing process-local
    // throttles share the trusted address while persistence receives only the
    // keyed source evidence from this same once-per-request boundary.
    deps = {
      ...deps,
      requestId: () => resolvedRequestContext.requestId,
      trustedClientAddress: () => resolvedRequestContext.clientAddress,
    } as PortalDeps;
  }
  const abuseLeases: Array<{
    readonly leaseHash: Buffer;
    outcome: PortalAbuseOutcome;
  }> = [];
  const trackAbuseLease = (leaseHash: Buffer | null | false): void => {
    if (leaseHash) abuseLeases.push({ leaseHash, outcome: 'success' });
  };
  const completeAbuseLease = async (
    leaseHash: Buffer | null | false,
    outcome: PortalAbuseOutcome,
  ): Promise<void> => {
    if (!leaseHash || !deps.abuse) return;
    const index = abuseLeases.findIndex((candidate) => candidate.leaseHash.equals(leaseHash));
    if (index < 0) return;
    abuseLeases[index]!.outcome = outcome;
    try {
      await deps.abuse.complete(leaseHash, outcome);
      abuseLeases.splice(index, 1);
    } catch { /* final retry preserves the exact outcome; expiry remains the fail-safe */ }
  };
  if (deps.abuse && resolvedRequestContext) {
    const admission = sourceAbuseAdmission(resolvedRequestContext, routeClass, now);
    if (!admission) return sendAbuseStatus(res, 503, 30);
    const lease = await reserveAbuse(res, deps.abuse, admission);
    if (lease === false) return;
    trackAbuseLease(lease);
  }
  try {
  if (p === JOURNEY_BOARD_CLIENT_ROUTE && method === 'GET') {
    return sendJavaScript(res, JOURNEY_BOARD_CLIENT_SOURCE);
  }
  if (p === CONTENT_CALENDAR_CLIENT_ROUTE && method === 'GET') {
    return sendJavaScript(res, CONTENT_CALENDAR_CLIENT_SOURCE);
  }
  if (p === MIGRATION_CENTRE_CLIENT_ROUTE && method === 'GET') {
    return sendJavaScript(res, MIGRATION_CENTRE_CLIENT_SOURCE, 'private, no-store, max-age=0');
  }
  const productProfile = deps.productProfile ?? RELAUNCH72_PRODUCT_PROFILE;
  const requestCookies = parseCookies(req.headers.cookie);
  const sessionToken = requestCookies[PORTAL_COOKIE] ?? '';
  const portalHome = '/portal';
  let tenantId: string | null = null;
  let portalIdentity: PortalSessionIdentity | null = null;
  // Public account actions must remain usable when a stale cookie exists and
  // the identity store is unavailable. Login/setup establish a new session;
  // logout validates its cookie-bound CSRF token without resolving first.
  const skipSessionResolution = p === '/portal/setup'
    || (p === '/portal/login' && method === 'POST')
    || p === PROPERTY_PREDATOR_SSO_CALLBACK_ROUTE
    || (p === '/portal/logout' && method === 'POST');
  if (sessionToken && !skipSessionResolution) {
    try {
      if (deps.kind === 'postgres') {
        portalIdentity = await deps.auth.resolve(sessionToken, now);
      } else {
        tenantId = verifyTenant(deps.sessionSecret, sessionToken, now);
      }
    } catch {
      return sendLoginPage(res, 503, deps, 'Secure sign-in is temporarily unavailable. Try again shortly.');
    }
  }
  if (deps.abuse && resolvedRequestContext && portalIdentity
      && routeClass !== 'auth.login' && routeClass !== 'auth.setup' && routeClass !== 'auth.sso') {
    if (!deps.abuseHashSecret) return sendAbuseStatus(res, 503, 30);
    const lease = await reserveAbuse(
      res,
      deps.abuse,
      principalAbuseAdmission(
        resolvedRequestContext,
        routeClass,
        deps.abuseHashSecret,
        portalIdentity,
        now,
      ),
    );
    if (lease === false) return;
    trackAbuseLease(lease);
  }

  // ── one-time account setup / login / logout (no auth) ──
  if (p === PROPERTY_PREDATOR_SSO_START_ROUTE && method === 'GET') {
    if (tenantId || portalIdentity) return redirect(res, portalHome);
    if (deps.kind !== 'postgres' || !deps.propertyPredatorSso) {
      return sendLoginPage(res, 404, deps, 'Property Predator sign-in is not available yet. Use your Growth HQ password.');
    }
    const providerValues = url.searchParams.getAll('provider');
    const validQuery = [...url.searchParams.keys()].every((key) => key === 'provider')
      && providerValues.length <= 1;
    const provider = providerValues[0] as PropertyPredatorSsoProviderHint | undefined;
    if (!validQuery || (provider !== undefined && provider !== 'google')) {
      return sendLoginPage(res, 400, deps, 'That sign-in option was not recognised. Try again.');
    }
    try {
      const authorization = deps.propertyPredatorSso.begin(provider, now);
      return redirect(res, authorization.url, authorization.cookie, 302, {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
    } catch {
      return sendLoginPage(res, 503, deps, 'Property Predator sign-in is temporarily unavailable. Use your Growth HQ password.');
    }
  }
  if (p === PROPERTY_PREDATOR_SSO_CALLBACK_ROUTE) {
    const clearTransaction = clearPropertyPredatorSsoCookie(deps.secure);
    if (method !== 'GET') {
      return sendLoginPage(
        res,
        405,
        deps,
        'We could not complete that sign-in. Try again or use your Growth HQ password.',
        '',
        { allow: 'GET' },
        [clearTransaction],
      );
    }
    if (deps.kind !== 'postgres' || !deps.propertyPredatorSso || !deps.auth.loginExternal) {
      return sendLoginPage(
        res,
        404,
        deps,
        'Property Predator sign-in is not available yet. Use your Growth HQ password.',
        '',
        {},
        [clearTransaction],
      );
    }
    const sso = deps.propertyPredatorSso;
    const codeValues = url.searchParams.getAll('code');
    const stateValues = url.searchParams.getAll('state');
    const errorValues = url.searchParams.getAll('error');
    const callbackKeys = [...url.searchParams.keys()];
    const successfulShape = callbackKeys.every((key) => key === 'code' || key === 'state')
      && codeValues.length === 1
      && stateValues.length === 1
      && errorValues.length === 0;
    if (!successfulShape) {
      return sendLoginPage(
        res,
        400,
        deps,
        'We could not complete that sign-in. Try again or use your Growth HQ password.',
        '',
        {},
        [sso.clearCookie()],
      );
    }
    let ssoAbuseLease: Buffer | null | false = null;
    if (deps.abuse && resolvedRequestContext) {
      if (!deps.abuseHashSecret) return sendAbuseStatus(res, 503, 30);
      ssoAbuseLease = await reserveAbuse(
        res,
        deps.abuse,
        authSubjectAbuseAdmission(
          resolvedRequestContext,
          'auth.sso',
          deps.abuseHashSecret,
          stateValues[0]!,
          now,
        ),
      );
      if (ssoAbuseLease === false) return;
      trackAbuseLease(ssoAbuseLease);
    }
    try {
      const exchange = await sso.complete(
        codeValues[0]!,
        stateValues[0]!,
        requestCookies[PROPERTY_PREDATOR_SSO_COOKIE],
        now,
      );
      const authenticated = exchange
        ? await deps.auth.loginExternal(
            exchange.assertion,
            authRequestContext(req, now, resolvedRequestContext),
            exchange.bootstrapUserId,
          )
        : null;
      if (!authenticated) {
        await completeAbuseLease(ssoAbuseLease, 'auth_failure');
        return sendLoginPage(
          res,
          401,
          deps,
          'We could not complete that sign-in. Use your Growth HQ password or contact support.',
          '',
          {},
          [sso.clearCookie()],
        );
      }
      const authenticatedExpiry = authenticated.expiresAt
        ? Date.parse(authenticated.expiresAt)
        : Number.NaN;
      const ssoSessionMaxAge = Number.isFinite(authenticatedExpiry)
        ? Math.max(1, Math.min(24 * 60 * 60, Math.floor((authenticatedExpiry - now) / 1_000)))
        : 24 * 60 * 60;
      await completeAbuseLease(ssoAbuseLease, 'success');
      return redirect(res, portalHome, [
        portalCookie(authenticated.sessionToken, deps.secure, ssoSessionMaxAge),
        sso.clearCookie(),
      ], 303, {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
    } catch (error) {
      const authenticationFailure = error instanceof PropertyPredatorSsoAuthenticationError;
      await completeAbuseLease(ssoAbuseLease, authenticationFailure ? 'auth_failure' : 'service_error');
      return sendLoginPage(
        res,
        authenticationFailure ? 401 : 503,
        deps,
        authenticationFailure
          ? 'We could not complete that sign-in. Use your Growth HQ password or contact support.'
          : 'Property Predator sign-in is temporarily unavailable. Use your Growth HQ password.',
        '',
        {},
        [sso.clearCookie()],
      );
    }
  }
  if (p === '/portal/setup' && method === 'GET') {
    const linkedToken = url.searchParams.get('token');
    if (linkedToken !== null) {
      if (!isPortalSetupToken(linkedToken)) {
        return sendHtml(res, 400, accountSetupUnavailablePage(SETUP_FAILURE_MESSAGE, productProfile), clearPortalSetupCookie(deps.secure), {
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        });
      }
      // Move the capability out of subsequent URLs/HTML into an authenticated,
      // encrypted ten-minute HttpOnly cookie. The emailed URL remains usable
      // until database completion/reissue, and its first edge request still
      // requires query-string redaction in deployment logging.
      return redirect(res, '/portal/setup', portalSetupCookie(deps.sessionSecret, linkedToken, deps.secure, now), 303, {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
    }
    const setupEnabled = deps.kind === 'postgres'
      ? Boolean(deps.auth.completeSetup)
      : Boolean(deps.completeSetup);
    if (!setupEnabled) {
      return sendHtml(res, 503, accountSetupUnavailablePage(undefined, productProfile), undefined, {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
    }
    const setupCookieValue = requestCookies[PORTAL_SETUP_COOKIE];
    const setupToken = verifyPortalSetupCookie(deps.sessionSecret, setupCookieValue, now);
    if (!setupToken || !setupCookieValue) {
      return sendHtml(res, 400, accountSetupUnavailablePage(SETUP_FAILURE_MESSAGE, productProfile), clearPortalSetupCookie(deps.secure), {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
    }
    return sendHtml(res, 200, accountSetupPage(portalSetupCsrfToken(deps.sessionSecret, setupCookieValue, now), undefined, productProfile), undefined, {
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
  }
  if (p === '/portal/setup' && method === 'POST') {
    const setup = deps.kind === 'postgres' ? deps.auth.completeSetup : deps.completeSetup;
    if (!setup) {
      return sendHtml(res, 503, accountSetupUnavailablePage(undefined, productProfile));
    }
    const form = await readForm(req);
    const setupCookieValue = requestCookies[PORTAL_SETUP_COOKIE];
    const token = verifyPortalSetupCookie(deps.sessionSecret, setupCookieValue, now);
    if (!token || !setupCookieValue
        || !verifyPortalSetupCsrf(deps.sessionSecret, setupCookieValue, form._setup_csrf, now)) {
      // Do not clear a browser's setup cookie from a cross-site POST that did
      // not carry its Strict cookie/CSRF value. The underlying link can still
      // be revisited; terminal database invalidity is cleared below.
      return sendHtml(res, 403, accountSetupUnavailablePage(SETUP_FAILURE_MESSAGE, productProfile), undefined, {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
    }
    const setupCsrf = portalSetupCsrfToken(deps.sessionSecret, setupCookieValue, now);
    const password = form.password ?? '';
    if (password.length < 12 || password.length > 1_024) {
      return sendHtml(res, 400, accountSetupPage(setupCsrf, 'Use a password between 12 and 1,024 characters.', productProfile), undefined, { 'cache-control': 'no-store' });
    }
    if (password !== (form.confirm ?? '')) {
      return sendHtml(res, 400, accountSetupPage(setupCsrf, 'Those passwords do not match.', productProfile), undefined, { 'cache-control': 'no-store' });
    }
    let setupAbuseLease: Buffer | null | false = null;
    if (deps.abuse && resolvedRequestContext) {
      if (!deps.abuseHashSecret) return sendAbuseStatus(res, 503, 30);
      setupAbuseLease = await reserveAbuse(
        res,
        deps.abuse,
        authSubjectAbuseAdmission(
          resolvedRequestContext,
          'auth.setup',
          deps.abuseHashSecret,
          token,
          now,
        ),
      );
      if (setupAbuseLease === false) return;
      trackAbuseLease(setupAbuseLease);
    }
    const throttle = deps.setupThrottle ?? DEFAULT_SETUP_THROTTLE;
    const keys = setupKeys(req, token, deps);
    const reservations: string[] = [];
    for (const key of keys) {
      const status = throttle.reserve(key, now);
      if (!status.allowed) {
        for (const reserved of reservations) throttle.release(reserved);
        return sendHtml(res, 429, accountSetupUnavailablePage(SETUP_FAILURE_MESSAGE, productProfile), undefined, {
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'retry-after': String(status.retryAfterSeconds),
        });
      }
      reservations.push(key);
    }
    let completed;
    try {
      completed = deps.kind === 'postgres'
        ? await deps.auth.completeSetup!(token, password, authRequestContext(req, now, resolvedRequestContext))
        : await deps.completeSetup!(token, password, now);
    } catch {
      for (const key of reservations) throttle.release(key);
      await completeAbuseLease(setupAbuseLease, 'service_error');
      return sendHtml(res, 503, accountSetupPage(setupCsrf, 'Secure account setup is temporarily unavailable. Try again shortly.', productProfile), undefined, { 'cache-control': 'no-store' });
    }
    if (!completed) {
      for (const key of reservations) throttle.failure(key, now);
      await completeAbuseLease(setupAbuseLease, 'auth_failure');
      return sendHtml(res, 400, accountSetupUnavailablePage(SETUP_FAILURE_MESSAGE, productProfile), clearPortalSetupCookie(deps.secure), { 'cache-control': 'no-store' });
    }
    for (const key of reservations) throttle.success(key);
    await completeAbuseLease(setupAbuseLease, 'success');
    const completedToken = typeof completed === 'string'
      ? signTenant(deps.sessionSecret, completed, now)
      : completed.sessionToken;
    return redirect(res, portalHome, [
      portalCookie(completedToken, deps.secure),
      clearPortalSetupCookie(deps.secure),
    ], 303);
  }
  if (p === '/portal/login' && method === 'GET') {
    if (tenantId || portalIdentity) return redirect(res, portalHome);
    const reason = url.searchParams.get('reason');
    const message = reason === 'workspace-unavailable'
      ? 'Your sign-in is valid, but this workspace is not ready in the new portal yet. Contact support.'
      : reason === 'session-ended'
        ? 'Your secure session ended. Sign in again to continue.'
        : undefined;
    return sendLoginPage(res, 200, deps, message);
  }
  if (p === '/portal/login' && method === 'POST') {
    const form = await readForm(req);
    const email = (form.email ?? '').trim().toLowerCase();
    const loginCsrfCookieToken = parseCookies(req.headers.cookie)[PORTAL_LOGIN_CSRF_COOKIE];
    if (!verifyPortalLoginCsrf(deps.sessionSecret, loginCsrfCookieToken, form._login_csrf)) {
      return sendLoginPage(res, 403, deps, 'Refresh the sign-in page and try again.', email);
    }
    let loginAbuseLease: Buffer | null | false = null;
    if (deps.abuse && resolvedRequestContext) {
      if (!deps.abuseHashSecret) return sendAbuseStatus(res, 503, 30);
      loginAbuseLease = await reserveAbuse(
        res,
        deps.abuse,
        authSubjectAbuseAdmission(
          resolvedRequestContext,
          'auth.login',
          deps.abuseHashSecret,
          email || 'unknown',
          now,
        ),
      );
      if (loginAbuseLease === false) return;
      trackAbuseLease(loginAbuseLease);
    }
    const keys = loginKeys(req, email, deps);
    const reservations: string[] = [];
    for (const key of keys) {
      const throttle = deps.loginThrottle?.reserve(key, now);
      if (throttle && !throttle.allowed) {
        for (const reserved of reservations) deps.loginThrottle?.release(reserved);
        return sendLoginPage(res, 429, deps, 'Too many login attempts. Try again later.', email, {
          'retry-after': String(throttle.retryAfterSeconds),
        });
      }
      if (throttle) reservations.push(key);
    }
    let authenticated;
    try {
      authenticated = deps.kind === 'postgres'
        ? await deps.auth.login(email, form.password ?? '', authRequestContext(req, now, resolvedRequestContext))
        : await deps.login(email, form.password ?? '');
    } catch {
      for (const key of reservations) deps.loginThrottle?.release(key);
      await completeAbuseLease(loginAbuseLease, 'service_error');
      return sendLoginPage(res, 503, deps, 'Secure sign-in is temporarily unavailable. Try again shortly.', email);
    }
    if (!authenticated) {
      for (const key of keys) deps.loginThrottle?.failure(key, now);
      await completeAbuseLease(loginAbuseLease, 'auth_failure');
      return sendLoginPage(res, 401, deps, 'Wrong email or password.', email);
    }
    for (const key of keys) deps.loginThrottle?.success(key);
    await completeAbuseLease(loginAbuseLease, 'success');
    const authenticatedToken = typeof authenticated === 'string'
      ? signTenant(deps.sessionSecret, authenticated, now)
      : authenticated.sessionToken;
    return redirect(res, portalHome, portalCookie(authenticatedToken, deps.secure));
  }
  if (p === '/portal/logout' && method === 'POST') {
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Refresh needed', message: 'The secure form token was invalid. You are still signed in.',
      }));
    }
    if (deps.kind === 'postgres' && sessionToken) {
      try {
        await deps.auth.revoke(sessionToken);
      } catch {
        return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
          title: 'Sign-out did not finish',
          message: 'The secure session could not be revoked. You are still signed in; try again shortly.',
        }));
      }
    }
    return redirect(res, '/portal/login', clearPortalCookie(deps.secure));
  }

  // ── everything below requires a tenant session ──
  if (!tenantId && !portalIdentity) return redirect(
    res,
    sessionToken ? '/portal/login?reason=session-ended' : '/portal/login',
    sessionToken ? clearPortalCookie(deps.secure) : undefined,
  );

  if (deps.kind === 'postgres' && p === MIGRATION_CENTRE_ROUTE) {
    if (method !== 'GET') {
      return sendHtml(res, 405, portalStatusPage(deps, sessionToken, {
        title: 'Migration Centre page is read-only',
        message: 'Use the protected preview control on the Migration Centre page.',
        active: 'crm',
        backHref: MIGRATION_CENTRE_ROUTE,
        backLabel: 'Return to Migration Centre',
      }), undefined, { allow: 'GET' });
    }
    if (!deps.migrations) {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Migration Centre not connected',
        message: 'The effects-free CSV preview boundary is not composed for this workspace.',
        active: 'crm',
      }));
    }
    try {
      const access = await deps.migrations.access(crmIdentity(sessionToken, deps));
      if (!access.ok) {
        return sendHtml(res, access.kind === 'forbidden' ? 403 : 503, portalStatusPage(
          deps,
          sessionToken,
          {
            title: access.kind === 'forbidden'
              ? 'Migration Centre restricted'
              : 'Migration Centre temporarily unavailable',
            message: access.message,
            active: 'crm',
          },
        ));
      }
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      return sendHtml(res, 200, migrationCentrePage(
        access.workspaceName,
        renderMigrationCentreBody({
          workspaceName: access.workspaceName,
          role: access.role,
          csrfToken,
        }),
        deps,
        csrfToken,
      ), undefined, {
        'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Migration Centre temporarily unavailable',
        message: 'No CSV was read and no customer record was changed.',
        active: 'crm',
      }));
    }
  }

  if (deps.kind === 'postgres' && p === MIGRATION_CENTRE_PREVIEW_ROUTE) {
    if (method !== 'POST') {
      return sendJson(res, 405, {
        ok: false,
        error: { code: 'method_not_allowed', message: 'Use POST for a migration preview.' },
      }, { allow: 'POST' });
    }
    if (!deps.migrations) {
      return sendJson(res, 404, {
        ok: false,
        error: { code: 'not_composed', message: 'The Migration Centre is not connected.' },
      });
    }
    if (!portalMigrationRequestIsSameOrigin(req.headers)
        || !verifyPortalCsrf(
          deps.sessionSecret,
          sessionToken,
          portalMigrationCsrfHeader(req.headers),
        )) {
      return sendMigrationError(
        res,
        'principal_forbidden',
        'The secure migration request could not be verified.',
      );
    }
    try {
      const command = parsePortalMigrationPreviewCommand(
        req.headers,
        req as AsyncIterable<Uint8Array>,
      );
      const outcome = await deps.migrations.preview(crmIdentity(sessionToken, deps), command);
      if (!outcome.ok) {
        return sendMigrationError(
          res,
          outcome.code,
          outcome.message,
          outcome.retryAfterSeconds,
        );
      }
      return sendJson(res, 200, presentPortalMigrationPreview(outcome.result));
    } catch (error) {
      const safe = error instanceof MigrationCentreError
        ? error
        : new MigrationCentreError('control_unavailable');
      return sendMigrationError(res, safe.code, safe.message, safe.retryAfterSeconds);
    }
  }

  // Canonical PostgreSQL Growth HQ. Only the secure CRM snapshot contributes
  // numbers; this route never falls back to the legacy JSON demo dashboard.
  if (deps.kind === 'postgres' && p === '/portal' && method === 'GET') {
    try {
      const snapshot = await deps.crm.snapshot(crmIdentity(sessionToken, deps));
      if (!snapshot) return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Workspace not available',
        message: 'This session no longer has access to the selected workspace.',
        active: 'overview',
      }));
      const profile = deps.productProfile ?? RELAUNCH72_PRODUCT_PROFILE;
      const growth = deps.crm.growth ? await deps.crm.growth(crmIdentity(sessionToken, deps)) : undefined;
      if (deps.crm.growth && !growth) return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Workspace not available',
        message: 'This session no longer has access to the selected workspace.',
        active: 'overview',
      }));
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      return sendHtml(res, 200, appShell({
        title: `${profile.productName} — ${snapshot.workspace.name}`,
        tenantName: snapshot.workspace.name,
        active: 'overview',
        productProfile: profile,
        capabilities: new Set([
          'workspace.overview.read', 'crm.contacts.read', 'crm.pipeline.read', 'crm.tasks.read',
          ...(deps.journeys ? ['journeys.read'] as const : []),
          ...optionalPortalCapabilities(deps),
        ]),
        crmAvailable: true,
        mode: 'crm',
        csrfToken,
        body: renderGrowthHomeBody(snapshot, profile, growth ?? undefined, {
          actionCentreAvailable: Boolean(deps.operatorActions),
        }),
      }));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Growth HQ temporarily unavailable',
        message: 'No data was changed. Try again shortly.',
        active: 'overview',
      }));
    }
  }

  // ── authoritative cross-module operator queue: organise work, never fake completion ──
  if (deps.kind === 'postgres' && p === OPERATOR_ACTION_CENTRE_ROUTE && method === 'GET') {
    if (!deps.operatorActions) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Action Centre not connected',
      message: 'The protected workspace action queue is not enabled for this deployment.',
      active: 'actions',
    }));
    try {
      const snapshot = await deps.operatorActions.snapshot(crmIdentity(sessionToken, deps), {
        limit: OPERATOR_ACTION_CENTRE_MAX_ACTIONS,
      });
      if (!snapshot) return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Action workspace not available',
        message: 'This session no longer has access to the authoritative operator queue.',
        active: 'actions',
      }));
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      const view = presentOperatorActionCentre(snapshot);
      const security = view.mutatingControlsEnabled ? (() => {
        const snoozeCommandKeys = Object.fromEntries(view.actions
          .filter((action) => action.canSnooze)
          .map((action) => [action.actionId, randomUUID()]));
        return {
          csrfToken,
          snoozeCommandKeys,
          snoozeChoices: Object.fromEntries(view.actions
            .filter((action) => action.canSnooze)
            .map((action) => [action.actionId, OPERATOR_ACTION_SNOOZE_CHOICES.map((choice) => ({
              label: choice.label,
              token: operatorActionSnoozeChoiceToken(
                deps.sessionSecret,
                sessionToken,
                action.actionId,
                snoozeCommandKeys[action.actionId]!,
                new Date(now + choice.minutes * 60_000).toISOString(),
              ),
            }))])),
          assignmentCommandKeys: Object.fromEntries(view.actions
            .filter((action) => action.canAssign)
            .map((action) => [action.actionId, randomUUID()])),
        };
      })() : undefined;
      return sendHtml(res, 200, operatorActionPage(
        snapshot.workspaceName,
        renderOperatorActionCentreBody(view, {
          security,
          notice: operatorActionNoticeFromQuery(
            url.searchParams,
            deps.sessionSecret,
            sessionToken,
          ),
        }),
        deps,
        csrfToken,
        view.canWrite,
      ));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Action Centre temporarily unavailable',
        message: 'No source record, assignment, snooze or provider operation was changed. Try again shortly.',
        active: 'actions',
      }));
    }
  }

  const operatorActionCommandMatch = p.match(OPERATOR_ACTION_COMMAND_ROUTE);
  if (deps.kind === 'postgres' && operatorActionCommandMatch && method === 'POST') {
    if (!deps.operatorActions) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Action Centre not connected',
      message: 'The protected workspace action queue is not enabled for this deployment.',
      active: 'actions',
    }));
    const actionId = decodedOperatorActionId(operatorActionCommandMatch[1] ?? '');
    const command = operatorActionCommandMatch[2];
    const form = await readForm(req);
    const expectedText = form.expected_row_version ?? '';
    const expectedRowVersion = /^(?:0|[1-9][0-9]{0,9})$/u.test(expectedText)
      ? Number(expectedText) : null;
    if (!actionId || !CRM_OBJECT_ID.test(form.command_key ?? '')
        || expectedRowVersion === null
        || !verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return operatorActionRedirect(res, deps, sessionToken, 'invalid');
    }
    try {
      if (command === 'snooze') {
        const snoozedUntil = operatorActionSnoozeInstantFromToken(
          form.snooze_choice ?? '',
          deps.sessionSecret,
          sessionToken,
          actionId,
          form.command_key!,
        );
        if (!snoozedUntil) {
          return operatorActionRedirect(res, deps, sessionToken, 'invalid');
        }
        const outcome = await deps.operatorActions.snoozeAction(crmIdentity(sessionToken, deps), {
          actionId,
          commandKey: form.command_key!,
          expectedRowVersion,
          snoozedUntil,
        });
        return operatorActionRedirect(
          res,
          deps,
          sessionToken,
          outcome.ok
            ? outcome.disposition === 'replayed' ? 'replayed' : 'snoozed'
            : operatorActionFailureNotice(outcome.kind),
        );
      }
      const suppliedAssignee = (form.assigned_user_id ?? '').trim().toLowerCase();
      if (suppliedAssignee && !CRM_OBJECT_ID.test(suppliedAssignee)) {
        return operatorActionRedirect(res, deps, sessionToken, 'invalid');
      }
      const outcome = await deps.operatorActions.assignAction(crmIdentity(sessionToken, deps), {
        actionId,
        commandKey: form.command_key!,
        expectedRowVersion,
        assignedUserId: suppliedAssignee || null,
      });
      return operatorActionRedirect(
        res,
        deps,
        sessionToken,
        outcome.ok
          ? outcome.disposition === 'replayed' ? 'replayed' : suppliedAssignee ? 'assigned' : 'released'
          : operatorActionFailureNotice(outcome.kind),
      );
    } catch {
      return operatorActionRedirect(res, deps, sessionToken, 'unavailable');
    }
  }

  // ── affiliate compliance: fictional evidence and fail-closed readiness only ──
  if (deps.kind === 'postgres' && p === AFFILIATE_COMPLIANCE_ROUTE && method === 'GET') {
    if (!deps.affiliateCompliance || deps.productProfile?.id !== 'property_predator_growth') {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Affiliate Compliance not connected',
        message: 'The protected affiliate evidence preview is not enabled for this workspace.',
        active: 'affiliates',
      }));
    }
    try {
      const outcome = await deps.affiliateCompliance.snapshot(crmIdentity(sessionToken, deps));
      if (!outcome.ok) {
        const status = outcome.kind === 'unauthenticated' || outcome.kind === 'forbidden'
          ? 403
          : outcome.kind === 'not_found'
            ? 404
            : 503;
        return sendHtml(res, status, portalStatusPage(deps, sessionToken, {
          title: status === 503 ? 'Affiliate Compliance temporarily unavailable' : 'Affiliate Compliance not available',
          message: outcome.message,
          active: 'affiliates',
        }));
      }
      const view = presentAffiliateCompliance(outcome.snapshot);
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      return sendHtml(res, 200, operationalPage(
        outcome.snapshot.workspace.workspaceName,
        renderAffiliateComplianceBody(view),
        deps,
        'affiliates',
        csrfToken,
      ));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Affiliate Compliance temporarily unavailable',
        message: 'No legal, acceptance, training, declaration, channel, case or permission evidence was changed.',
        active: 'affiliates',
      }));
    }
  }

  // Founder-only connection preparation. The POST can obtain a Zernio-hosted
  // consent URL; it cannot schedule, queue or publish content.
  const zernioConnectMatch = p.match(/^\/portal\/social\/accounts\/connect\/(facebook|instagram|linkedin)$/u);
  if (deps.kind === 'postgres' && zernioConnectMatch && method === 'POST') {
    const zernioRedirect = (code: ZernioSocialNoticeCode): void => redirect(
      res,
      `${SOCIAL_ACCOUNT_CONTROL_ROUTE}?notice=${encodeURIComponent(
        zernioSocialNoticeToken(deps.sessionSecret, sessionToken, code),
      )}`,
      undefined,
      303,
      { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
    );
    if (deps.productProfile?.id !== 'property_predator_growth' || !deps.zernioSocial) {
      return zernioRedirect('unavailable');
    }
    const form = await readMultiValueForm(req);
    if (!form
        || !campaignFormKeysAllowed(form, new Set(['_csrf', 'confirm_connect']))
        || !verifyPortalCsrf(
          deps.sessionSecret, sessionToken, oneFormValue(form, '_csrf') ?? '',
        )
        || oneFormValue(form, 'confirm_connect') !== 'CONNECT') {
      return zernioRedirect('invalid');
    }
    const outcome = await deps.zernioSocial.begin(crmIdentity(sessionToken, deps), {
      intentId: randomUUID(),
      network: zernioConnectMatch[1] as ZernioPilotNetwork,
    });
    if (!outcome.ok) return zernioRedirect(zernioFailureNotice(outcome.kind));
    const networkLabel = zernioConnectMatch[1]![0]!.toUpperCase()
      + zernioConnectMatch[1]!.slice(1);
    return sendHtml(res, 200, portalStatusPage(deps, sessionToken, {
      title: `${networkLabel} consent ready`,
      message: 'Growth HQ prepared a one-use provider handoff. Continue to review and approve the native account permissions.',
      backHref: outcome.authUrl,
      backLabel: `Continue to ${networkLabel}`,
      active: 'content',
    }), undefined, {
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
  }

  // Zernio returns only the one-use intent plus bounded account identity. The
  // expected network is read from the server-side intent, never trusted from
  // the callback query.
  if (deps.kind === 'postgres' && p === ZERNIO_SOCIAL_CALLBACK_ROUTE && method === 'GET') {
    const callbackRedirect = (code: ZernioSocialNoticeCode): void => redirect(
      res,
      `${SOCIAL_ACCOUNT_CONTROL_ROUTE}?notice=${encodeURIComponent(
        zernioSocialNoticeToken(deps.sessionSecret, sessionToken, code),
      )}`,
      undefined,
      303,
      { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
    );
    if (deps.productProfile?.id !== 'property_predator_growth' || !deps.zernioSocial) {
      return callbackRedirect('unavailable');
    }
    const allowed = new Set(['intent', 'connected', 'profileId', 'accountId', 'username']);
    const singleton = (key: string): string | null => {
      const values = url.searchParams.getAll(key);
      return values.length === 1 ? values[0]! : null;
    };
    const intentId = singleton('intent');
    const connected = singleton('connected');
    const providerProfileId = singleton('profileId');
    const providerAccountId = singleton('accountId');
    const username = singleton('username');
    if ([...url.searchParams.keys()].some((key) => !allowed.has(key))
        || !intentId
        || (connected !== 'facebook' && connected !== 'instagram' && connected !== 'linkedin')
        || !providerProfileId
        || !providerAccountId || !username) {
      return callbackRedirect('invalid');
    }
    const canonicalCallback = JSON.stringify({
      accountId: providerAccountId,
      connected,
      intent: intentId,
      profileId: providerProfileId,
      username,
    });
    const outcome = await deps.zernioSocial.callback(crmIdentity(sessionToken, deps), {
      intentId,
      network: connected,
      providerProfileId,
      providerAccountId,
      username,
      linkedAt: new Date(now).toISOString(),
      canonicalCallback,
    });
    if (!outcome.ok) return callbackRedirect(zernioFailureNotice(outcome.kind));
    return callbackRedirect(outcome.disposition === 'recorded' ? 'connected' : 'replayed');
  }

  // ── provider readiness: bounded evidence only; publishing remains off ──
  if (deps.kind === 'postgres' && p === SOCIAL_ACCOUNT_CONTROL_ROUTE && method === 'GET') {
    if (deps.productProfile?.id !== 'property_predator_growth') {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Social accounts not connected',
        message: 'The Property Predator social-account rehearsal is not enabled for this workspace.',
        active: 'content',
      }));
    }
    try {
      if (deps.zernioSocial) {
        const outcome = await deps.zernioSocial.snapshot(crmIdentity(sessionToken, deps));
        if (!outcome.ok) {
          const status = outcome.kind === 'forbidden' || outcome.kind === 'unauthenticated'
            ? 403 : 503;
          return sendHtml(res, status, portalStatusPage(deps, sessionToken, {
            title: status === 403 ? 'Social accounts restricted' : 'Social accounts temporarily unavailable',
            message: 'No account, permission, provider connection or publication state was changed.',
            active: 'content',
          }));
        }
        const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
        const notice = zernioSocialNoticeFromQuery(
          url.searchParams, deps.sessionSecret, sessionToken,
        );
        return sendHtml(res, 200, operationalPage(
          'PropertyPredator Growth HQ',
          renderZernioSocialAccountControlBody({
            workspaceName: 'PropertyPredator Growth HQ',
            accounts: outcome.accounts,
            csrfToken,
            ...(notice ? { notice } : {}),
          }),
          deps,
          'content',
          csrfToken,
        ));
      }
      const view = presentSocialAccountControl(createPropertyPredatorSocialAccountControlFixture());
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      return sendHtml(res, 200, operationalPage(
        view.workspaceName,
        renderSocialAccountControlBody(view),
        deps,
        'content',
        csrfToken,
      ));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Social accounts temporarily unavailable',
        message: 'No account, permission, provider connection or external effect was changed.',
        active: 'content',
      }));
    }
  }

  // ── provider readiness: bounded evidence only; every external effect stays off ──
  if (deps.kind === 'postgres' && p === PROVIDER_READINESS_COCKPIT_ROUTE && method === 'GET') {
    const readinessLinked = deps.productProfile?.readinessRails.some(
      (rail) => rail.href === PROVIDER_READINESS_COCKPIT_ROUTE,
    ) ?? false;
    if (!deps.providerReadiness || !readinessLinked) {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Provider Readiness not connected',
        message: 'The dark provider evidence cockpit is not enabled for this workspace.',
        active: 'overview',
      }));
    }
    try {
      const outcome = await deps.providerReadiness.snapshot(crmIdentity(sessionToken, deps));
      if (!outcome.ok) {
        const status = outcome.kind === 'unauthenticated' || outcome.kind === 'forbidden'
          ? 403
          : outcome.kind === 'not_found'
            ? 404
            : 503;
        return sendHtml(res, status, portalStatusPage(deps, sessionToken, {
          title: status === 503 ? 'Provider Readiness temporarily unavailable' : 'Provider Readiness not available',
          message: outcome.message,
          active: 'overview',
        }));
      }
      const view = presentProviderReadinessCockpit(outcome.snapshot);
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      return sendHtml(res, 200, operationalPage(
        outcome.snapshot.workspace.workspaceName,
        renderProviderReadinessCockpitBody(view),
        deps,
        'overview',
        csrfToken,
      ));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Provider Readiness temporarily unavailable',
        message: 'No provider account, credential, switch, send, post or direct message was changed.',
        active: 'overview',
      }));
    }
  }

  // ── live channels: proven evidence or the labelled fixture; pause commands only move rails towards OFF ──
  if (deps.kind === 'postgres' && p === LIVE_CHANNELS_ROUTE && method === 'GET') {
    if (deps.productProfile?.id !== 'property_predator_growth') {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Live Channels not connected',
        message: 'The Property Predator live channel control room is not enabled for this workspace.',
        active: 'overview',
      }));
    }
    // Production fails closed: without the composed truth seam there is no
    // page. The illustrative fixture renders only in the labelled local
    // preview harness, never from this route.
    if (!deps.liveChannelTruth) {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Live Channels not connected',
        message: 'The shared live-channel truth seam is not composed for this workspace, so no channel state can be shown. Nothing was changed.',
        active: 'overview',
      }));
    }
    try {
      const identity = crmIdentity(sessionToken, deps);
      const outcome = await deps.liveChannelTruth.snapshot(identity);
      if (!outcome.ok) {
        const status = outcome.kind === 'unauthenticated' || outcome.kind === 'forbidden'
          ? 403
          : 503;
        return sendHtml(res, status, portalStatusPage(deps, sessionToken, {
          title: status === 503 ? 'Live Channels temporarily unavailable' : 'Live Channels not available',
          message: outcome.message,
          active: 'overview',
        }));
      }
      if (outcome.snapshot.dataset !== 'postgres_authoritative') {
        throw new Error('live channel truth snapshot dataset is not authoritative');
      }
      const view = presentLiveChannels(outcome.snapshot);
      const shell = deps.crm.workspaceShell
        ? await deps.crm.workspaceShell(identity)
        : await deps.crm.snapshot(identity);
      const workspaceName = shell?.workspace.name ?? 'Property Predator Growth HQ';
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      const notice = liveChannelsNoticeFromQuery(url.searchParams, deps.sessionSecret, sessionToken);
      const railStatusAvailable = Boolean(deps.providerReadiness)
        && (deps.productProfile?.readinessRails.some(
          (rail) => rail.href === PROVIDER_READINESS_COCKPIT_ROUTE,
        ) ?? false);
      return sendHtml(res, 200, operationalPage(
        workspaceName,
        renderLiveChannelsBody(view, {
          workspaceName,
          csrfToken,
          pauseCommandAvailable: Boolean(deps.liveChannelPause),
          ownedSocialCommandAvailable: Boolean(deps.ownedSocialBinding),
          ownedSocialProfileBindingComposed:
            deps.ownedSocialBinding?.profileBindingComposed === true,
          ownedSocialCommandKeys: {
            bind: randomUUID(),
            revoke: randomUUID(),
            stage: randomUUID(),
          },
          smsCommandAvailable: Boolean(deps.smsBinding),
          smsCommandKeys: {
            bind: randomUUID(),
            revoke: randomUUID(),
            stage: randomUUID(),
          },
          pauseCommandKeys: {
            all: randomUUID(),
            customer_email: randomUUID(),
            owned_social: randomUUID(),
            whatsapp: randomUUID(),
            sms: randomUUID(),
            social_dm: randomUUID(),
          },
          railStatusAvailable,
          handoff: {
            conversionInboxComposed: Boolean(deps.inbox),
            inboxOperationsComposed: Boolean(deps.inboxOperations),
            lead360Composed: Boolean(deps.crm.lead360),
          },
          notice,
        }),
        deps,
        'overview',
        csrfToken,
        'Live Channels',
      ));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Live Channels temporarily unavailable',
        message: 'No channel, switch, credential or provider operation was changed.',
        active: 'overview',
      }));
    }
  }

  if (deps.kind === 'postgres' && p === LIVE_CHANNELS_PAUSE_ROUTE && method === 'POST') {
    if (deps.productProfile?.id !== 'property_predator_growth') {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Live Channels not connected',
        message: 'The Property Predator live channel control room is not enabled for this workspace.',
        active: 'overview',
      }));
    }
    const liveChannelsNoticeRedirect = (code: LiveChannelsNoticeCode): void => redirect(
      res,
      `${LIVE_CHANNELS_ROUTE}?notice=${encodeURIComponent(liveChannelsNoticeToken(deps.sessionSecret, sessionToken, code))}`,
      undefined,
      303,
    );
    const form = await readMultiValueForm(req);
    const allowed = new Set(['_csrf', 'command_key', 'scope', 'confirm_pause']);
    const scope = form ? oneFormValue(form, 'scope') : null;
    const commandKey = form ? oneFormValue(form, 'command_key') : null;
    const scopeAllowed = scope === 'all'
      || scope === 'customer_email'
      || scope === 'owned_social'
      || scope === 'whatsapp'
      || scope === 'sms'
      || scope === 'social_dm';
    if (!form || !campaignFormKeysAllowed(form, allowed)
        || !verifyPortalCsrf(deps.sessionSecret, sessionToken, oneFormValue(form, '_csrf') ?? '')
        || oneFormValue(form, 'confirm_pause') !== 'ENGAGE'
        || !scopeAllowed
        || !commandKey || !CRM_OBJECT_ID.test(commandKey)) {
      return liveChannelsNoticeRedirect('invalid');
    }
    if (!deps.liveChannelPause) return liveChannelsNoticeRedirect('unavailable');
    const outcome = await deps.liveChannelPause.engage(crmIdentity(sessionToken, deps), {
      scope,
      commandKey,
    });
    if (outcome.ok) {
      return liveChannelsNoticeRedirect(
        outcome.disposition === 'engaged' ? 'pause_engaged' : 'pause_already',
      );
    }
    return liveChannelsNoticeRedirect(
      outcome.kind === 'forbidden' || outcome.kind === 'unauthenticated'
        ? 'forbidden'
        : outcome.kind === 'validation' ? 'invalid' : 'unavailable',
    );
  }

  // Founder-only owned Ayrshare/X commands. Each is database-only: none can
  // claim a worker lease or reach Ayrshare. The clear Profile Key is read from
  // the form, handed to the sealing seam and never echoed back in any notice.
  if (deps.kind === 'postgres'
      && (p === LIVE_CHANNELS_OWNED_SOCIAL_BIND_ROUTE
        || p === LIVE_CHANNELS_OWNED_SOCIAL_REVOKE_ROUTE
        || p === LIVE_CHANNELS_OWNED_SOCIAL_STAGE_ROUTE)
      && method === 'POST') {
    if (deps.productProfile?.id !== 'property_predator_growth') {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Live Channels not connected',
        message: 'The Property Predator live channel control room is not enabled for this workspace.',
        active: 'overview',
      }));
    }
    const ownedSocialNotice = (code: LiveChannelsNoticeCode): void => redirect(
      res,
      `${LIVE_CHANNELS_ROUTE}?notice=${encodeURIComponent(liveChannelsNoticeToken(deps.sessionSecret, sessionToken, code))}`,
      undefined,
      303,
    );
    const allowed = p === LIVE_CHANNELS_OWNED_SOCIAL_BIND_ROUTE
      ? new Set(['_csrf', 'command_key', 'profile_id', 'display_name', 'profile_reference',
        'owned_account', 'profile_credential', 'oauth_evidence', 'linked_at',
        'evidence_observed_at', 'confirm_owned'])
      : p === LIVE_CHANNELS_OWNED_SOCIAL_REVOKE_ROUTE
        ? new Set(['_csrf', 'command_key', 'profile_id', 'reason_code',
          'revocation_evidence', 'confirm_revoke'])
        : new Set(['_csrf', 'command_key', 'profile_id', 'content_item_id',
          'content_version_id', 'approval_request_id', 'approval_decision_id',
          'source_attestation_id', 'owned_account', 'operation_tag', 'confirm_stage']);
    const confirmField = p === LIVE_CHANNELS_OWNED_SOCIAL_BIND_ROUTE
      ? 'confirm_owned'
      : p === LIVE_CHANNELS_OWNED_SOCIAL_REVOKE_ROUTE ? 'confirm_revoke' : 'confirm_stage';
    const confirmValue = p === LIVE_CHANNELS_OWNED_SOCIAL_BIND_ROUTE
      ? 'OWNED'
      : p === LIVE_CHANNELS_OWNED_SOCIAL_REVOKE_ROUTE ? 'REVOKE' : 'STAGE';
    const form = await readMultiValueForm(req);
    const commandKey = form ? oneFormValue(form, 'command_key') : null;
    if (!form || !campaignFormKeysAllowed(form, allowed)
        || !verifyPortalCsrf(deps.sessionSecret, sessionToken, oneFormValue(form, '_csrf') ?? '')
        || oneFormValue(form, confirmField) !== confirmValue
        || !commandKey || !CRM_OBJECT_ID.test(commandKey)) {
      return ownedSocialNotice('owned_social_invalid');
    }
    if (!deps.ownedSocialBinding) return ownedSocialNotice('owned_social_unavailable');
    const identity = crmIdentity(sessionToken, deps);
    const profileId = oneFormValue(form, 'profile_id') ?? '';
    if (p === LIVE_CHANNELS_OWNED_SOCIAL_BIND_ROUTE) {
      const outcome = await deps.ownedSocialBinding.recordProfile(identity, {
        profileId,
        displayName: oneFormValue(form, 'display_name') ?? '',
        providerProfileReference: oneFormValue(form, 'profile_reference') ?? '',
        ownedAccountReference: oneFormValue(form, 'owned_account') ?? '',
        profileKey: oneFormValue(form, 'profile_credential') ?? '',
        ownershipAttested: true,
        oauthPermissions: 'read_write',
        oauthLinkEvidence: oneFormValue(form, 'oauth_evidence') ?? '',
        linkedAt: oneFormValue(form, 'linked_at') ?? '',
        evidenceObservedAt: oneFormValue(form, 'evidence_observed_at') ?? '',
      });
      return ownedSocialNotice(outcome.ok ? 'profile_bound' : ownedSocialFailureNotice(outcome.kind));
    }
    if (p === LIVE_CHANNELS_OWNED_SOCIAL_REVOKE_ROUTE) {
      const outcome = await deps.ownedSocialBinding.revokeProfile(identity, {
        profileId,
        reasonCode: oneFormValue(form, 'reason_code') ?? '',
        revocationEvidence: oneFormValue(form, 'revocation_evidence') ?? '',
      });
      return ownedSocialNotice(outcome.ok ? 'profile_revoked' : ownedSocialFailureNotice(outcome.kind));
    }
    const outcome = await deps.ownedSocialBinding.stagePublication(identity, {
      profileId,
      contentItemId: oneFormValue(form, 'content_item_id') ?? '',
      contentVersionId: oneFormValue(form, 'content_version_id') ?? '',
      approvalRequestId: oneFormValue(form, 'approval_request_id') ?? '',
      approvalDecisionId: oneFormValue(form, 'approval_decision_id') ?? '',
      sourceAttestationId: oneFormValue(form, 'source_attestation_id') ?? '',
      ownedAccountReference: oneFormValue(form, 'owned_account') ?? '',
      operationTag: oneFormValue(form, 'operation_tag') ?? '',
    });
    if (outcome.ok) return ownedSocialNotice('publication_staged');
    // 'blocked' means the database refused the evidence; 'forbidden' means the
    // founder lacked authority. They are reported differently on purpose.
    return ownedSocialNotice(ownedSocialFailureNotice(outcome.kind));
  }

  // Founder-only Twilio SMS commands. Each is database-only: none can claim a
  // worker lease or reach Twilio. No credential is accepted here — the account
  // and messaging-service identifiers are reduced to digests by the seam.
  if (deps.kind === 'postgres'
      && (p === LIVE_CHANNELS_SMS_BIND_ROUTE
        || p === LIVE_CHANNELS_SMS_REVOKE_ROUTE
        || p === LIVE_CHANNELS_SMS_STAGE_ROUTE)
      && method === 'POST') {
    if (deps.productProfile?.id !== 'property_predator_growth') {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Live Channels not connected',
        message: 'The Property Predator live channel control room is not enabled for this workspace.',
        active: 'overview',
      }));
    }
    const smsNotice = (code: LiveChannelsNoticeCode): void => redirect(
      res,
      `${LIVE_CHANNELS_ROUTE}?notice=${encodeURIComponent(liveChannelsNoticeToken(deps.sessionSecret, sessionToken, code))}`,
      undefined,
      303,
    );
    const allowed = p === LIVE_CHANNELS_SMS_BIND_ROUTE
      ? new Set(['_csrf', 'command_key', 'binding_id', 'connection_id', 'endpoint_id',
        'display_name', 'account_sid', 'messaging_service_sid', 'sender_number',
        'regulatory_evidence', 'ownership_evidence', 'evidence_observed_at',
        'confirm_sender'])
      : p === LIVE_CHANNELS_SMS_REVOKE_ROUTE
        ? new Set(['_csrf', 'command_key', 'binding_id', 'reason_code',
          'revocation_evidence', 'confirm_sender_revoke'])
        : new Set(['_csrf', 'command_key', 'binding_id', 'connection_id', 'endpoint_id',
          'message_version_id', 'approval_request_id', 'approval_decision_id',
          'person_id', 'phone_endpoint_id', 'consent_event_id', 'compliance_subject_id',
          'policy_publication_id', 'pecr_sender_id', 'pecr_instigator_id',
          'permission_use_id', 'operation_id', 'delivery_id', 'correlation_id',
          'authority_valid_until', 'segment_count', 'owned_recipient', 'purpose',
          'confirm_sms_stage']);
    const confirmField = p === LIVE_CHANNELS_SMS_BIND_ROUTE
      ? 'confirm_sender'
      : p === LIVE_CHANNELS_SMS_REVOKE_ROUTE ? 'confirm_sender_revoke' : 'confirm_sms_stage';
    const confirmValue = p === LIVE_CHANNELS_SMS_BIND_ROUTE
      ? 'BIND'
      : p === LIVE_CHANNELS_SMS_REVOKE_ROUTE ? 'REVOKE' : 'STAGE';
    const form = await readMultiValueForm(req);
    const commandKey = form ? oneFormValue(form, 'command_key') : null;
    if (!form || !campaignFormKeysAllowed(form, allowed)
        || !verifyPortalCsrf(deps.sessionSecret, sessionToken, oneFormValue(form, '_csrf') ?? '')
        || oneFormValue(form, confirmField) !== confirmValue
        || !commandKey || !CRM_OBJECT_ID.test(commandKey)) {
      return smsNotice('sms_invalid');
    }
    if (!deps.smsBinding) return smsNotice('sms_unavailable');
    const identity = crmIdentity(sessionToken, deps);
    const field = (name: string): string => oneFormValue(form, name) ?? '';
    if (p === LIVE_CHANNELS_SMS_BIND_ROUTE) {
      const outcome = await deps.smsBinding.bindSender(identity, {
        bindingId: field('binding_id'),
        providerConnectionId: field('connection_id'),
        channelEndpointId: field('endpoint_id'),
        displayName: field('display_name'),
        accountSid: field('account_sid'),
        messagingServiceSid: field('messaging_service_sid'),
        senderNumber: field('sender_number'),
        regulatoryEvidence: field('regulatory_evidence'),
        ownershipEvidence: field('ownership_evidence'),
        ownershipAttested: true,
        evidenceObservedAt: field('evidence_observed_at'),
      });
      return smsNotice(outcome.ok ? 'sms_sender_bound' : smsFailureNotice(outcome.kind));
    }
    if (p === LIVE_CHANNELS_SMS_REVOKE_ROUTE) {
      const outcome = await deps.smsBinding.revokeSender(identity, {
        bindingId: field('binding_id'),
        reasonCode: field('reason_code'),
        revocationEvidence: field('revocation_evidence'),
      });
      return smsNotice(outcome.ok ? 'sms_sender_revoked' : smsFailureNotice(outcome.kind));
    }
    const segments = Number.parseInt(field('segment_count'), 10);
    const outcome = await deps.smsBinding.stageOwnedTest(identity, {
      bindingId: field('binding_id'),
      providerConnectionId: field('connection_id'),
      channelEndpointId: field('endpoint_id'),
      messageVersionId: field('message_version_id'),
      messageApprovalRequestId: field('approval_request_id'),
      messageApprovalDecisionId: field('approval_decision_id'),
      contactId: field('person_id'),
      contactPointId: field('phone_endpoint_id'),
      consentEventId: field('consent_event_id'),
      complianceSubjectId: field('compliance_subject_id'),
      policyPublicationEventId: field('policy_publication_id'),
      pecrSenderDecisionEventId: field('pecr_sender_id'),
      pecrInstigatorDecisionEventId: field('pecr_instigator_id'),
      permissionUseReceiptId: field('permission_use_id'),
      providerOperationId: field('operation_id'),
      messageDeliveryId: field('delivery_id'),
      correlationId: field('correlation_id'),
      authorityValidUntil: field('authority_valid_until'),
      expectedSegmentCount: Number.isNaN(segments) ? 0 : segments,
      ownedRecipient: field('owned_recipient'),
      purpose: field('purpose'),
    });
    return smsNotice(outcome.ok ? 'sms_test_staged' : smsFailureNotice(outcome.kind));
  }

  // ── exact company-content review: manager-only, read-only and source verified ──
  const companyContentReviewMatch = new RegExp(
    `^${COMPANY_CONTENT_REVIEW_ROUTE_PREFIX}/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(/file)?$`,
    'u',
  ).exec(p);
  if (deps.kind === 'postgres' && companyContentReviewMatch) {
    if (method !== 'GET') {
      return sendHtml(res, 405, portalStatusPage(deps, sessionToken, {
        title: 'Exact review method not allowed',
        message: 'This boundary is read-only. Use Company Assets for protected review decisions.',
        active: 'content',
        backHref: COMPANY_ASSETS_ROUTE,
        backLabel: 'Return to Company Assets',
      }), undefined, { allow: 'GET' });
    }
    if (deps.productProfile?.id !== 'property_predator_growth'
        || !deps.companyContentReview) {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Exact content review not connected',
        message: 'The verified Property Predator review boundary is not enabled for this workspace.',
        active: 'content',
        backHref: COMPANY_ASSETS_ROUTE,
        backLabel: 'Return to Company Assets',
      }));
    }
    const releaseItemId = companyContentReviewMatch[1]!;
    try {
      if (companyContentReviewMatch[2]) {
        const outcome = await deps.companyContentReview.artwork(
          crmIdentity(sessionToken, deps),
          releaseItemId,
        );
        if (!outcome.ok) {
          const status = outcome.kind === 'unauthenticated' || outcome.kind === 'forbidden'
            ? 403
            : outcome.kind === 'not_found' || outcome.kind === 'validation'
              ? 404
              : 503;
          return sendHtml(res, status, portalStatusPage(deps, sessionToken, {
            title: status === 503
              ? 'Exact artwork verification unavailable'
              : 'Exact artwork not available',
            message: outcome.message,
            active: 'content',
            backHref: `${COMPANY_CONTENT_REVIEW_ROUTE_PREFIX}/${releaseItemId}`,
            backLabel: 'Return to exact review',
          }));
        }
        return sendVerifiedCompanyArtwork(res, outcome);
      }
      const outcome = await deps.companyContentReview.review(
        crmIdentity(sessionToken, deps),
        releaseItemId,
      );
      if (!outcome.ok) {
        const status = outcome.kind === 'unauthenticated' || outcome.kind === 'forbidden'
          ? 403
          : outcome.kind === 'not_found' || outcome.kind === 'validation'
            ? 404
            : 503;
        return sendHtml(res, status, portalStatusPage(deps, sessionToken, {
          title: status === 503
            ? 'Exact content review temporarily unavailable'
            : 'Exact content review not available',
          message: outcome.message,
          active: 'content',
          backHref: COMPANY_ASSETS_ROUTE,
          backLabel: 'Return to Company Assets',
        }));
      }
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      return sendHtml(res, 200, operationalPage(
        outcome.snapshot.workspace.workspaceName,
        renderCompanyContentReviewBody(presentCompanyContentReview(outcome.snapshot)),
        deps,
        'content',
        csrfToken,
      ), undefined, {
        'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Exact content review temporarily unavailable',
        message: 'No review decision, source record, provider or external effect was changed.',
        active: 'content',
        backHref: COMPANY_ASSETS_ROUTE,
        backLabel: 'Return to Company Assets',
      }));
    }
  }

  // ── Property Predator source sync: authenticated reads + adapter-only writes ──
  if (deps.kind === 'postgres' && p === COMPANY_CONTENT_SYNC_ROUTE) {
    if (deps.productProfile?.id !== 'property_predator_growth'
        || !deps.companyContentSync) {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Source Sync not connected',
        message: 'The scoped Property Predator company-content source is not configured for this service.',
        active: 'content',
        backHref: '/portal/content',
        backLabel: 'Return to Content Control',
      }));
    }
    if (method !== 'GET' && method !== 'POST') {
      return sendHtml(res, 405, portalStatusPage(deps, sessionToken, {
        title: 'Source Sync method not allowed',
        message: 'Use the protected Source Sync page and its effects-off operator command.',
        active: 'content',
        backHref: COMPANY_CONTENT_SYNC_ROUTE,
        backLabel: 'Return to Source Sync',
      }), undefined, { allow: 'GET, POST' });
    }
    if (method === 'POST') {
      const rawContentType = req.headers['content-type'];
      const contentType = Array.isArray(rawContentType) ? '' : rawContentType?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType !== 'application/x-www-form-urlencoded') {
        return companyContentSyncRedirect(res, deps, sessionToken, 'invalid');
      }
      const form = await readMultiValueForm(req);
      const keys = form ? [...new Set(form.keys())].sort() : [];
      const csrfToken = form ? oneFormValue(form, '_csrf') : null;
      const suppliedCommand = form ? oneFormValue(form, 'command_token') : null;
      const commandKey = suppliedCommand
        ? verifyCompanyContentSyncCommandToken(
            deps.sessionSecret,
            sessionToken,
            suppliedCommand,
            now,
          )
        : null;
      if (!form
          || keys.length !== 2
          || keys[0] !== '_csrf'
          || keys[1] !== 'command_token'
          || !csrfToken
          || !verifyPortalCsrf(deps.sessionSecret, sessionToken, csrfToken)
          || !commandKey) {
        return companyContentSyncRedirect(res, deps, sessionToken, 'invalid');
      }
      try {
        const outcome = await deps.companyContentSync.sync({
          sessionToken,
          requestId: commandKey,
        });
        if (!outcome.ok) {
          const code: CompanyContentSyncNoticeCode = outcome.kind === 'replayed'
            ? 'replayed'
            : outcome.kind === 'conflict'
            ? 'busy'
            : outcome.kind === 'unauthenticated' || outcome.kind === 'forbidden'
              ? 'forbidden'
              : 'unavailable';
          return companyContentSyncRedirect(res, deps, sessionToken, code);
        }
        const code: CompanyContentSyncNoticeCode = outcome.snapshot.sync.state === 'current'
          ? 'synced'
          : outcome.snapshot.sync.state === 'retry_wait'
            ? 'retry_wait'
            : 'attention';
        return companyContentSyncRedirect(res, deps, sessionToken, code);
      } catch {
        return companyContentSyncRedirect(res, deps, sessionToken, 'unavailable');
      }
    }
    try {
      const outcome = await deps.companyContentSync.snapshot(crmIdentity(sessionToken, deps));
      if (!outcome.ok) {
        const responseStatus = outcome.kind === 'unauthenticated' || outcome.kind === 'forbidden'
          ? 403 : 503;
        return sendHtml(res, responseStatus, portalStatusPage(deps, sessionToken, {
          title: responseStatus === 503
            ? 'Source Sync temporarily unavailable'
            : 'Source Sync not available',
          message: outcome.message,
          active: 'content',
          backHref: '/portal/content',
          backLabel: 'Return to Content Control',
        }));
      }
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      const commandToken = companyContentSyncCommandToken(
        deps.sessionSecret,
        sessionToken,
        randomUUID(),
        now,
      );
      return sendHtml(res, 200, operationalPage(
        outcome.snapshot.workspace.workspaceName,
        renderCompanyContentSyncBody(outcome.snapshot, {
          csrfToken,
          commandToken,
          notice: companyContentSyncNoticeFromQuery(
            url.searchParams,
            deps.sessionSecret,
            sessionToken,
          ),
          companyAssetsAvailable: Boolean(deps.companyAssets),
          assetsLabel: deps.productProfile?.contentWorkspace?.assetsLabel,
          brandBrainAvailable: Boolean(deps.brandBrain),
          brainLabel: deps.productProfile?.contentWorkspace?.brainLabel,
        }),
        deps,
        'content',
        csrfToken,
      ));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Source Sync temporarily unavailable',
        message: 'No content, quarantine, provider or external-delivery state was changed.',
        active: 'content',
        backHref: '/portal/content',
        backLabel: 'Return to Content Control',
      }));
    }
  }

  // ── Brand Brain: owned-intelligence metadata and readiness only ──
  if (deps.kind === 'postgres' && p === BRAND_BRAIN_ROUTE && method === 'GET') {
    const brainNavigation = deps.productProfile?.contentWorkspace;
    if (!deps.brandBrain || brainNavigation?.brainRoute !== BRAND_BRAIN_ROUTE) {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Brand Brain not connected',
        message: 'The read-only owned-intelligence inventory is not enabled for this workspace.',
        active: 'content',
        backHref: '/portal/content',
        backLabel: 'Return to Content Control',
      }));
    }
    try {
      const outcome = await deps.brandBrain.snapshot(crmIdentity(sessionToken, deps));
      if (!outcome.ok) {
        const status = outcome.kind === 'unauthenticated' || outcome.kind === 'forbidden'
          ? 403
          : outcome.kind === 'not_found'
            ? 404
            : 503;
        return sendHtml(res, status, portalStatusPage(deps, sessionToken, {
          title: status === 503 ? 'Brand Brain temporarily unavailable' : 'Brand Brain not available',
          message: outcome.message,
          active: 'content',
          backHref: '/portal/content',
          backLabel: 'Return to Content Control',
        }));
      }
      const view = presentBrandBrain(outcome.snapshot);
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      return sendHtml(res, 200, operationalPage(
        outcome.snapshot.workspace.workspaceName,
        renderBrandBrainBody(view, {
          brainLabel: brainNavigation.brainLabel,
          companyAssetsAvailable: Boolean(
            deps.companyAssets
            && brainNavigation.assetsRoute === COMPANY_ASSETS_ROUTE
          ),
          companyAssetsLabel: brainNavigation.assetsLabel,
        }),
        deps,
        'content',
        csrfToken,
      ));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Brand Brain temporarily unavailable',
        message: 'No source, review, evaluation, activation or provider state was changed. Try again shortly.',
        active: 'content',
        backHref: '/portal/content',
        backLabel: 'Return to Content Control',
      }));
    }
  }

  // ── Image Studio: authoritative brief workspace + existing founder rail ──
  if (deps.kind === 'postgres' && p === IMAGE_STUDIO_ROUTE && method === 'GET') {
    const contentNavigation = deps.productProfile?.contentWorkspace;
    if (deps.productProfile?.id !== 'property_predator_growth'
        || !deps.brandBrain || !deps.companyAssets
        || contentNavigation?.brainRoute !== BRAND_BRAIN_ROUTE
        || contentNavigation.assetsRoute !== COMPANY_ASSETS_ROUTE) {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Image Studio not connected',
        message: 'Authoritative Brand Brain and company-asset metadata are required for this workspace.',
        active: 'content',
        backHref: '/portal/content',
        backLabel: 'Return to Content Control',
      }));
    }
    try {
      const identity = crmIdentity(sessionToken, deps);
      const [brainOutcome, assetOutcome] = await Promise.all([
        deps.brandBrain.snapshot(identity),
        deps.companyAssets.snapshot(identity),
      ]);
      const failure = !brainOutcome.ok ? brainOutcome : !assetOutcome.ok ? assetOutcome : null;
      if (failure) {
        const status = failure.kind === 'unauthenticated' || failure.kind === 'forbidden'
          ? 403 : failure.kind === 'not_found' ? 404 : 503;
        return sendHtml(res, status, portalStatusPage(deps, sessionToken, {
          title: status === 503 ? 'Image Studio temporarily unavailable' : 'Image Studio not available',
          message: failure.message,
          active: 'content',
          backHref: '/portal/content',
          backLabel: 'Return to Content Control',
        }));
      }
      if (!brainOutcome.ok || !assetOutcome.ok) {
        throw new Error('Image Studio source outcome escaped its safe boundary');
      }
      const snapshot = createAuthoritativeImageStudioSnapshot({
        brandBrain: brainOutcome.snapshot,
        companyAssets: assetOutcome.snapshot,
        query: url.searchParams,
      });
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      return sendHtml(res, 200, operationalPage(
        snapshot.workspaceName,
        renderImageStudioBody(presentImageStudio(snapshot)),
        deps,
        'content',
        csrfToken,
      ));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Image Studio temporarily unavailable',
        message: 'No provider, artwork, approval, publishing or customer state was changed.',
        active: 'content',
        backHref: '/portal/content',
        backLabel: 'Return to Content Control',
      }));
    }
  }

  // ── Property Predator company assets: metadata + quarantine-only decisions ──
  if (deps.kind === 'postgres' && p === COMPANY_ASSETS_ROUTE && method === 'GET') {
    const assetsNavigation = deps.productProfile?.contentWorkspace;
    if (!deps.companyAssets || assetsNavigation?.assetsRoute !== COMPANY_ASSETS_ROUTE) {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Company Assets not connected',
        message: 'The migration 0033 metadata library is not enabled for this workspace.',
        active: 'content',
        backHref: '/portal/content',
        backLabel: 'Return to Content Control',
      }));
    }
    try {
      const outcome = await deps.companyAssets.snapshot(crmIdentity(sessionToken, deps));
      if (!outcome.ok) {
        const status = outcome.kind === 'unauthenticated' || outcome.kind === 'forbidden'
          ? 403
          : outcome.kind === 'validation'
            ? 400
            : outcome.kind === 'not_found'
              ? 404
              : 503;
        return sendHtml(res, status, portalStatusPage(deps, sessionToken, {
          title: status === 503
            ? 'Company Assets temporarily unavailable'
            : 'Company Assets not available',
          message: outcome.message,
          active: 'content',
          backHref: '/portal/content',
          backLabel: 'Return to Content Control',
        }));
      }
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      const view = presentCompanyAssets(outcome.snapshot, {
        notice: companyAssetsNoticeFromQuery(
          url.searchParams,
          deps.sessionSecret,
          sessionToken,
        ),
      });
      return sendHtml(res, 200, operationalPage(
        outcome.snapshot.workspace.workspaceName,
        renderCompanyAssetsBody(view, {
          assetsLabel: assetsNavigation.assetsLabel,
          brandBrainAvailable: Boolean(
            deps.brandBrain
            && assetsNavigation.brainRoute === BRAND_BRAIN_ROUTE
          ),
          brandBrainLabel: assetsNavigation.brainLabel,
          exactReviewHrefsByReleaseItemId: view.canManage && deps.companyContentReview
            ? Object.freeze(Object.fromEntries(view.items.map((item) => [
                item.releaseItemId,
                `${COMPANY_CONTENT_REVIEW_ROUTE_PREFIX}/${item.releaseItemId}`,
              ])))
            : undefined,
          security: view.canQuarantine ? {
            csrfToken,
            quarantineKeys: Object.fromEntries(view.items.flatMap((item) => (
              item.quarantineActions.map((action) => [
                `${item.releaseItemId}:${action.dimension}`,
                randomUUID(),
              ])
            ))),
          } : undefined,
        }),
        deps,
        'content',
        csrfToken,
      ));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Company Assets temporarily unavailable',
        message: 'No quarantine, approval, source, generation or provider state was changed.',
        active: 'content',
        backHref: '/portal/content',
        backLabel: 'Return to Content Control',
      }));
    }
  }

  if (deps.kind === 'postgres'
      && p === COMPANY_ASSET_QUARANTINE_ROUTE
      && method === 'POST') {
    const assetsNavigation = deps.productProfile?.contentWorkspace;
    if (!deps.companyAssets || assetsNavigation?.assetsRoute !== COMPANY_ASSETS_ROUTE) {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Company Assets not connected',
        message: 'The protected founder quarantine service is not enabled.',
        active: 'content',
      }));
    }
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return companyAssetsRedirect(res, deps, sessionToken, form, 'invalid');
    }
    if (form.outcome !== 'quarantined') {
      return companyAssetsRedirect(
        res,
        deps,
        sessionToken,
        form,
        form.outcome === 'clear' ? 'review_unavailable' : 'invalid',
      );
    }
    const itemType = form.item_type === 'asset'
      || form.item_type === 'generated'
      || form.item_type === 'media'
      ? form.item_type
      : null;
    const dimension = form.dimension === 'visual_policy'
      || form.dimension === 'claim'
      || form.dimension === 'asset'
      ? form.dimension
      : null;
    const expectedReason = dimension === 'visual_policy'
      ? 'visual_policy_conflict'
      : dimension === 'claim'
        ? 'claims_unsubstantiated'
        : dimension === 'asset'
          ? 'asset_integrity_failed'
          : null;
    if (!itemType || !dimension || !expectedReason
        || form.reason_code !== expectedReason
        || form.evidence_sha256 !== form.item_content_sha256
        || (dimension === 'asset' && itemType !== 'asset')) {
      return companyAssetsRedirect(res, deps, sessionToken, form, 'invalid');
    }
    try {
      const outcome = await deps.companyAssets.quarantine(crmIdentity(sessionToken, deps), {
        commandKey: form.command_key ?? '',
        sourceReleaseId: form.source_release_id ?? '',
        releaseItemId: form.release_item_id ?? '',
        itemType,
        itemId: form.item_id ?? '',
        itemContentSha256: form.item_content_sha256 ?? '',
        itemBrandSha256: form.item_brand_sha256 ?? '',
        dimension,
        outcome: 'quarantined',
        reasonCode: expectedReason as PortalCompanyAssetQuarantineReasonCode,
        evidenceSha256: form.evidence_sha256 ?? '',
      });
      return companyAssetsRedirect(
        res,
        deps,
        sessionToken,
        form,
        outcome.ok
          ? outcome.disposition === 'replayed' ? 'replayed' : 'quarantined'
          : companyAssetsFailureNotice(outcome.kind),
      );
    } catch {
      return companyAssetsRedirect(res, deps, sessionToken, form, 'unavailable');
    }
  }

  // ── public-social campaign wizard: approved ids -> one atomic durable TEST plan ──
  if (deps.kind === 'postgres' && p === CAMPAIGN_WIZARD_ROUTE && method === 'GET') {
    if (!deps.publicSocial || !deps.companyContent) {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Campaign Builder not connected',
        message: 'The protected TEST planner and company-content catalogue must both be enabled.',
        active: 'content',
        backHref: CONTENT_CALENDAR_ROUTE,
        backLabel: 'Return to Campaign Calendar',
      }));
    }
    const asOf = new Date(now).toISOString();
    const selected = normaliseContentCalendarFilters({}, asOf);
    const range = contentCalendarReadRange(selected.date);
    const identity = crmIdentity(sessionToken, deps);
    try {
      const [socialOutcome, contentOutcome] = await Promise.all([
        deps.publicSocial.snapshot(identity, { from: range.from, to: range.to, limit: 120 }),
        deps.companyContent.snapshot(identity, { limit: 100 }),
      ]);
      const failure = !socialOutcome.ok
        ? socialOutcome
        : !contentOutcome.ok
          ? contentOutcome
          : null;
      if (failure) {
        const status = failure.kind === 'unauthenticated' || failure.kind === 'forbidden'
          ? 403 : failure.kind === 'validation' ? 400 : failure.kind === 'not_found' ? 404 : 503;
        return sendHtml(res, status, portalStatusPage(deps, sessionToken, {
          title: status === 503 ? 'Campaign Builder temporarily unavailable' : 'Campaign Builder unavailable',
          message: failure.message,
          active: 'content',
          backHref: CONTENT_CALENDAR_ROUTE,
          backLabel: 'Return to Campaign Calendar',
        }));
      }
      if (!socialOutcome.ok || !contentOutcome.ok) {
        throw new Error('campaign wizard projection escaped its safe outcome boundary');
      }
      const social = socialOutcome.snapshot;
      const content = contentOutcome.snapshot;
      if (social.workspace.workspaceId !== content.workspace.workspaceId) {
        throw new Error('campaign wizard workspace mismatch');
      }
      let brandBrainSnapshot: PortalBrandBrainSnapshot | undefined;
      if (deps.brandBrain) {
        try {
          const brandOutcome = await deps.brandBrain.snapshot(identity);
          if (brandOutcome.ok
              && brandOutcome.snapshot.workspace.workspaceId === social.workspace.workspaceId) {
            brandBrainSnapshot = brandOutcome.snapshot;
          }
        } catch {
          // Brand Brain is additive here. Its absence becomes a visible draft
          // blocker and must not take down the existing protected TEST wizard.
        }
      }
      const draftPlan = planPropertyPredatorMarketingDraft({
        selection: url.searchParams.get('laps'),
        brandBrainSnapshot,
      });
      const allContent = content.catalog.items.map(campaignContentSnapshot);
      const view = presentCampaignWizard({
        content: allContent.filter((item, index) => content.catalog.items[index]?.kind === 'social_post'),
        media: allContent.filter((_item, index) => {
          const kind = content.catalog.items[index]?.kind;
          return kind === 'image' || kind === 'video';
        }),
        targets: (social.planning?.targets.items ?? []).map((target) => Object.freeze({
          ...target,
          planningEnabled: true,
        })),
        sourceTruncated: content.catalog.nextCursor !== null
          || (social.planning?.targets.hasMore ?? false),
      }, {
        workspaceName: social.workspace.workspaceName,
        timezone: social.workspace.timezone,
        asOf: social.workspace.snapshotAt,
        draftPlan,
      });
      const contentNavigation = deps.productProfile?.contentWorkspace;
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      return sendHtml(res, 200, operationalPage(
        social.workspace.workspaceName,
        renderCampaignWizardBody(view, {
          ...(social.workspace.canManage && deps.publicSocial.createCampaignPlan ? {
            action: {
              actionUrl: CAMPAIGN_WIZARD_CREATE_TEST_ROUTE,
              csrfToken,
              commandKey: randomUUID(),
              returnTo: CONTENT_CALENDAR_ROUTE,
            },
          } : {}),
          ...(deps.campaignDrafts
            && content.workspace.canManage
            && brandBrainSnapshot?.workspace.canManage
            && draftPlan.readiness === 'draft_recipe_ready'
            && draftPlan.brandBrain
            && content.catalog.items.some((item) => item.kind === 'social_post'
              && item.brandSha256 === draftPlan.brandBrain!.runtimeBrandSha256
              && campaignDraftEvidence(item) !== null)
            && content.catalog.items.some((item) => (item.kind === 'image' || item.kind === 'video')
              && item.brandSha256 === draftPlan.brandBrain!.runtimeBrandSha256
              && campaignDraftEvidence(item) !== null) ? {
              draftGenerationAction: {
                actionUrl: CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE,
                csrfToken,
                commandKey: randomUUID(),
                maximumCostMinor: CAMPAIGN_REVIEW_DRAFT_MAXIMUM_COST_MINOR,
              },
            } : {}),
          outcome: campaignWizardNoticeFromQuery(
            url.searchParams,
            deps.sessionSecret,
            sessionToken,
          ),
          companyAssetsAvailable: Boolean(
            deps.companyAssets && contentNavigation?.assetsRoute === COMPANY_ASSETS_ROUTE
          ),
          assetsLabel: contentNavigation?.assetsLabel,
          brandBrainAvailable: Boolean(
            deps.brandBrain && contentNavigation?.brainRoute === BRAND_BRAIN_ROUTE
          ),
          brainLabel: contentNavigation?.brainLabel,
        }),
        deps,
        'content',
        csrfToken,
      ));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Campaign Builder temporarily unavailable',
        message: 'No campaign, content, target, provider or schedule state was changed.',
        active: 'content',
        backHref: CONTENT_CALENDAR_ROUTE,
        backLabel: 'Return to Campaign Calendar',
      }));
    }
  }

  if (deps.kind === 'postgres'
      && p === CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE && method === 'POST') {
    if (!deps.campaignDrafts || !deps.companyContent || !deps.brandBrain) {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Campaign generation not connected',
        message: 'The review-only company-content generation command is not enabled.',
        active: 'content',
        backHref: CAMPAIGN_WIZARD_ROUTE,
        backLabel: 'Return to Campaign Builder',
      }));
    }
    const form = await readMultiValueForm(req);
    const allowed = new Set([
      '_csrf', 'command_key', 'expected_plan_sha256', 'laps', 'provider_effects',
      'platform', 'tone', 'topic', 'approved_fact_version_id',
      'approved_asset_version_id', 'confirm_generation_only',
    ]);
    if (!form || !campaignFormKeysAllowed(form, allowed)
        || !verifyPortalCsrf(deps.sessionSecret, sessionToken, oneFormValue(form, '_csrf') ?? '')
        || oneFormValue(form, 'provider_effects') !== 'generation_only'
        || oneFormValue(form, 'confirm_generation_only') !== 'confirmed') {
      return sendHtml(res, 400, portalStatusPage(deps, sessionToken, {
        title: 'Review draft command rejected',
        message: 'The protected generation form was incomplete or invalid. No outbound effect ran.',
        active: 'content',
        backHref: CAMPAIGN_WIZARD_ROUTE,
        backLabel: 'Return to Campaign Builder',
      }));
    }
    const commandKey = campaignCommandKey(form);
    const expectedPlanSha256 = oneFormValue(form, 'expected_plan_sha256');
    const selection = campaignFormText(oneFormValue(form, 'laps'), 200);
    const platform = oneFormValue(form, 'platform');
    const tone = oneFormValue(form, 'tone');
    const topic = campaignFormText(oneFormValue(form, 'topic'), 1_600);
    const factVersionIds = campaignUuidValues(form, 'approved_fact_version_id', 1, 1);
    const assetVersionIds = campaignUuidValues(form, 'approved_asset_version_id', 1, 1);
    if (!commandKey || !expectedPlanSha256 || !/^[0-9a-f]{64}$/u.test(expectedPlanSha256)
        || !selection || !platform || !CAMPAIGN_REVIEW_DRAFT_PLATFORMS.has(platform)
        || !tone || !CAMPAIGN_REVIEW_DRAFT_TONES.has(tone) || !topic
        || !factVersionIds || !assetVersionIds) {
      return sendHtml(res, 400, portalStatusPage(deps, sessionToken, {
        title: 'Review draft command rejected',
        message: 'Choose one exact fact, one exact asset and a valid bounded brief. Nothing was generated.',
        active: 'content',
        backHref: CAMPAIGN_WIZARD_ROUTE,
        backLabel: 'Return to Campaign Builder',
      }));
    }
    const identity = crmIdentity(sessionToken, deps);
    try {
      const [contentOutcome, brainOutcome] = await Promise.all([
        deps.companyContent.snapshot(identity, { limit: 100 }),
        deps.brandBrain.snapshot(identity),
      ]);
      const failure = !contentOutcome.ok ? contentOutcome : !brainOutcome.ok ? brainOutcome : null;
      if (failure) {
        const status = failure.kind === 'unauthenticated' || failure.kind === 'forbidden'
          ? 403 : failure.kind === 'not_found' ? 404 : 503;
        return sendHtml(res, status, portalStatusPage(deps, sessionToken, {
          title: 'Review draft unavailable',
          message: failure.message,
          active: 'content',
          backHref: CAMPAIGN_WIZARD_ROUTE,
          backLabel: 'Return to Campaign Builder',
        }));
      }
      if (!contentOutcome.ok || !brainOutcome.ok) {
        throw new Error('campaign draft evidence escaped its safe outcome boundary');
      }
      const content = contentOutcome.snapshot;
      const brandBrainSnapshot = brainOutcome.snapshot;
      if (content.workspace.workspaceId !== brandBrainSnapshot.workspace.workspaceId
          || !content.workspace.canManage || !brandBrainSnapshot.workspace.canManage) {
        return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
          title: 'Campaign generation access required',
          message: 'Workspace manager access is required for a generation-only provider effect.',
          active: 'content',
          backHref: CAMPAIGN_WIZARD_ROUTE,
          backLabel: 'Return to Campaign Builder',
        }));
      }
      const plan = planPropertyPredatorMarketingDraft({
        selection,
        brandBrainSnapshot,
      });
      if (!plan.brandBrain || plan.readiness !== 'draft_recipe_ready'
          || plan.planSha256 !== expectedPlanSha256) {
        return sendHtml(res, 409, portalStatusPage(deps, sessionToken, {
          title: 'Campaign evidence changed',
          message: 'The exact Brand Brain or campaign plan changed. Refresh before generating.',
          active: 'content',
          backHref: `${CAMPAIGN_WIZARD_ROUTE}?laps=${encodeURIComponent(selection)}`,
          backLabel: 'Refresh Campaign Builder',
        }));
      }
      const factItem = content.catalog.items.find((item) =>
        item.contentVersionId === factVersionIds[0] && item.kind === 'social_post');
      const assetItem = content.catalog.items.find((item) =>
        item.contentVersionId === assetVersionIds[0]
          && (item.kind === 'image' || item.kind === 'video'));
      const fact = factItem ? campaignDraftEvidence(factItem) : null;
      const asset = assetItem ? campaignDraftEvidence(assetItem) : null;
      if (!fact || !asset
          || fact.brandSha256 !== plan.brandBrain.runtimeBrandSha256
          || asset.brandSha256 !== plan.brandBrain.runtimeBrandSha256) {
        return sendHtml(res, 409, portalStatusPage(deps, sessionToken, {
          title: 'Approved campaign evidence changed',
          message: 'The exact fact or asset version is no longer approved, fresh and Brand Brain-aligned.',
          active: 'content',
          backHref: `${CAMPAIGN_WIZARD_ROUTE}?laps=${encodeURIComponent(selection)}`,
          backLabel: 'Refresh Campaign Builder',
        }));
      }
      const result = await deps.campaignDrafts.generateReviewDraft(Object.freeze({
        idempotencyKey: commandKey,
        expectedPlanSha256,
        maximumCostMinor: CAMPAIGN_REVIEW_DRAFT_MAXIMUM_COST_MINOR,
        providerEffects: 'generation_only',
        brief: Object.freeze({ platform, topic, tone }),
        draftPlan: Object.freeze({ selection, brandBrainSnapshot }),
        brandBrain: Object.freeze({
          sourceSystem: 'property-predator',
          sourceReleaseId: plan.brandBrain.sourceReleaseId,
          manifestSha256: plan.brandBrain.manifestSha256,
          runtimeBrandSha256: plan.brandBrain.runtimeBrandSha256,
          specialistProfileId: plan.brandBrain.specialistProfileId,
        }),
        approvedFacts: Object.freeze([fact]),
        approvedAssets: Object.freeze([asset]),
      }));
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      return sendHtml(res, 201, operationalPage(
        content.workspace.workspaceName,
        renderCampaignDraftReviewBody(result),
        deps,
        'content',
        csrfToken,
      ));
    } catch (error) {
      const status = error instanceof PropertyPredatorCampaignDraftRuntimeError
        && (error.code === 'invalid_command' || error.code === 'evidence_invalid') ? 400
        : error instanceof PropertyPredatorCampaignDraftRuntimeError
          && (error.code === 'stale_plan' || error.code === 'integrity_mismatch') ? 409
          : 503;
      return sendHtml(res, status, portalStatusPage(deps, sessionToken, {
        title: status === 503 ? 'Review draft temporarily unavailable' : 'Review draft rejected',
        message: status === 503
          ? 'The generation command did not return a confirmed draft. No message was sent and nothing was scheduled or published.'
          : 'The exact review-only generation evidence did not match. Refresh before trying again.',
        active: 'content',
        backHref: CAMPAIGN_WIZARD_ROUTE,
        backLabel: 'Return to Campaign Builder',
      }));
    }
  }

  if (deps.kind === 'postgres' && p === CAMPAIGN_WIZARD_CREATE_TEST_ROUTE && method === 'POST') {
    if (!deps.publicSocial?.createCampaignPlan) {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Campaign command not connected',
        message: 'The atomic TEST campaign command is not enabled.',
        active: 'content',
        backHref: CAMPAIGN_WIZARD_ROUTE,
        backLabel: 'Return to Campaign Builder',
      }));
    }
    const form = await readMultiValueForm(req);
    const allowed = new Set([
      '_csrf', 'command_key', 'environment', 'timezone', 'return_to', 'title', 'objective',
      'content_version_id', 'media_version_ids', 'target_ids', 'desired_for_local',
      'max_attempts', 'confirm_test_only',
    ]);
    if (!form || !campaignFormKeysAllowed(form, allowed)
        || !verifyPortalCsrf(deps.sessionSecret, sessionToken, oneFormValue(form, '_csrf') ?? '')
        || oneFormValue(form, 'environment') !== 'test'
        || oneFormValue(form, 'confirm_test_only') !== 'confirmed') {
      return campaignNoticeRedirect(res, deps, sessionToken, 'invalid', CAMPAIGN_WIZARD_ROUTE);
    }
    const commandKey = campaignCommandKey(form);
    const title = campaignFormText(oneFormValue(form, 'title'), 200);
    const objective = campaignFormText(oneFormValue(form, 'objective'), 2_000);
    const contentVersionId = campaignUuidValues(form, 'content_version_id', 1, 1)?.[0] ?? null;
    const targetIds = campaignUuidValues(form, 'target_ids', 1, 9);
    const mediaVersionIds = campaignUuidValues(form, 'media_version_ids', 0, 10);
    const maxAttempts = campaignMaxAttempts(form);
    if (!commandKey || !title || !objective || !contentVersionId
        || !targetIds || !mediaVersionIds || maxAttempts === null) {
      return campaignNoticeRedirect(res, deps, sessionToken, 'invalid', CAMPAIGN_WIZARD_ROUTE);
    }
    try {
      const workspaceOutcome = await campaignCommandSnapshot(
        deps.publicSocial,
        crmIdentity(sessionToken, deps),
        now,
      );
      if (!workspaceOutcome.ok) {
        return campaignNoticeRedirect(
          res, deps, sessionToken, campaignFailureNotice(workspaceOutcome.kind), CAMPAIGN_WIZARD_ROUTE,
        );
      }
      const desiredFor = campaignDesiredInstant(form, workspaceOutcome.snapshot.workspace.timezone);
      if (!desiredFor) {
        return campaignNoticeRedirect(res, deps, sessionToken, 'invalid', CAMPAIGN_WIZARD_ROUTE);
      }
      const outcome = await deps.publicSocial.createCampaignPlan(
        crmIdentity(sessionToken, deps),
        {
          commandKey,
          title,
          objective,
          contentVersionId,
          desiredFor,
          maxAttempts,
          targetIds,
          mediaVersionIds,
        },
      );
      if (!outcome.ok) {
        return campaignNoticeRedirect(
          res, deps, sessionToken, campaignFailureNotice(outcome.kind), CAMPAIGN_WIZARD_ROUTE,
        );
      }
      const requestedReturn = oneFormValue(form, 'return_to');
      const destination = requestedReturn === CONTENT_CALENDAR_ROUTE
        && isSafeCampaignWizardPortalPath(requestedReturn)
        ? CONTENT_CALENDAR_ROUTE
        : CAMPAIGN_WIZARD_ROUTE;
      return campaignNoticeRedirect(
        res,
        deps,
        sessionToken,
        outcome.result.disposition === 'replayed' ? 'replayed' : 'planned',
        destination,
      );
    } catch {
      return campaignNoticeRedirect(res, deps, sessionToken, 'unavailable', CAMPAIGN_WIZARD_ROUTE);
    }
  }

  if (deps.kind === 'postgres' && p === CONTENT_CALENDAR_CREATE_TEST_ROUTE && method === 'POST') {
    if (!deps.publicSocial?.plan) {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'TEST planning command not connected',
        message: 'No campaign, provider or schedule state was changed.',
        active: 'content',
        backHref: CONTENT_CALENDAR_ROUTE,
        backLabel: 'Return to Campaign Calendar',
      }));
    }
    const form = await readMultiValueForm(req);
    const allowed = new Set([
      '_csrf', 'command_key', 'environment', 'timezone', 'campaign_revision_key',
      'content_version_id', 'target_ids', 'desired_for_local', 'max_attempts',
      'confirm_test_only',
    ]);
    if (!form || !campaignFormKeysAllowed(form, allowed)
        || !verifyPortalCsrf(deps.sessionSecret, sessionToken, oneFormValue(form, '_csrf') ?? '')
        || oneFormValue(form, 'environment') !== 'test'
        || oneFormValue(form, 'confirm_test_only') !== 'confirmed') {
      return campaignNoticeRedirect(res, deps, sessionToken, 'invalid', CONTENT_CALENDAR_ROUTE);
    }
    const revisionKey = oneFormValue(form, 'campaign_revision_key')?.split(':') ?? [];
    const commandKey = campaignCommandKey(form);
    const contentVersionId = campaignUuidValues(form, 'content_version_id', 1, 1)?.[0] ?? null;
    const targetIds = campaignUuidValues(form, 'target_ids', 1, 9);
    const maxAttempts = campaignMaxAttempts(form);
    if (revisionKey.length !== 2 || !CRM_OBJECT_ID.test(revisionKey[0] ?? '')
        || !CRM_OBJECT_ID.test(revisionKey[1] ?? '') || !commandKey || !contentVersionId
        || !targetIds || maxAttempts === null) {
      return campaignNoticeRedirect(res, deps, sessionToken, 'invalid', CONTENT_CALENDAR_ROUTE);
    }
    try {
      const workspaceOutcome = await campaignCommandSnapshot(
        deps.publicSocial, crmIdentity(sessionToken, deps), now,
      );
      if (!workspaceOutcome.ok) {
        return campaignNoticeRedirect(
          res, deps, sessionToken, campaignFailureNotice(workspaceOutcome.kind), CONTENT_CALENDAR_ROUTE,
        );
      }
      const desiredFor = campaignDesiredInstant(form, workspaceOutcome.snapshot.workspace.timezone);
      if (!desiredFor) {
        return campaignNoticeRedirect(res, deps, sessionToken, 'invalid', CONTENT_CALENDAR_ROUTE);
      }
      const outcome = await deps.publicSocial.plan(crmIdentity(sessionToken, deps), {
        commandKey,
        campaignId: revisionKey[0]!.toLowerCase(),
        revisionId: revisionKey[1]!.toLowerCase(),
        contentVersionId,
        desiredFor,
        maxAttempts,
        targetIds,
        mediaVersionIds: [],
      });
      return campaignNoticeRedirect(
        res,
        deps,
        sessionToken,
        outcome.ok
          ? outcome.result.disposition === 'replayed' ? 'replayed' : 'planned'
          : campaignFailureNotice(outcome.kind),
        CONTENT_CALENDAR_ROUTE,
      );
    } catch {
      return campaignNoticeRedirect(res, deps, sessionToken, 'unavailable', CONTENT_CALENDAR_ROUTE);
    }
  }

  if (deps.kind === 'postgres'
      && (p === CONTENT_CALENDAR_RESCHEDULE_TEST_ROUTE || p === CONTENT_CALENDAR_CANCEL_TEST_ROUTE)
      && method === 'POST') {
    const rescheduling = p === CONTENT_CALENDAR_RESCHEDULE_TEST_ROUTE;
    if (!deps.publicSocial || (rescheduling ? !deps.publicSocial.reschedule : !deps.publicSocial.cancel)) {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'TEST planning command not connected',
        message: 'No campaign, provider or schedule state was changed.',
        active: 'content',
        backHref: CONTENT_CALENDAR_ROUTE,
        backLabel: 'Return to Campaign Calendar',
      }));
    }
    const form = await readMultiValueForm(req);
    const allowed = new Set([
      '_csrf', 'command_key', 'intent_id', 'target_id', 'intent_sha256',
      'expected_updated_at', 'desired_for_local', 'reason',
      'confirm_change', 'confirm_cancel', 'return_mode', 'return_date', 'return_channel',
    ]);
    const returnQuery = form ? campaignCalendarReturnQuery(form) : new URLSearchParams();
    if (!form || !campaignFormKeysAllowed(form, allowed)
        || !verifyPortalCsrf(deps.sessionSecret, sessionToken, oneFormValue(form, '_csrf') ?? '')
        || oneFormValue(form, rescheduling ? 'confirm_change' : 'confirm_cancel') !== 'confirmed') {
      return campaignNoticeRedirect(
        res, deps, sessionToken, 'invalid', CONTENT_CALENDAR_ROUTE, returnQuery,
      );
    }
    const commandKey = campaignCommandKey(form);
    const intentId = (oneFormValue(form, 'intent_id') ?? '').toLowerCase();
    const targetId = (oneFormValue(form, 'target_id') ?? '').toLowerCase();
    const expectedSha256 = oneFormValue(form, 'intent_sha256');
    const expectedUpdatedAt = oneFormValue(form, 'expected_updated_at');
    const reason = campaignFormText(oneFormValue(form, 'reason'), 500);
    if (!commandKey || !CRM_OBJECT_ID.test(intentId) || !CRM_OBJECT_ID.test(targetId)
        || !expectedSha256 || !/^[a-f0-9]{64}$/u.test(expectedSha256)
        || !campaignCanonicalInstant(expectedUpdatedAt)
        || !reason) {
      return campaignNoticeRedirect(
        res, deps, sessionToken, 'invalid', CONTENT_CALENDAR_ROUTE, returnQuery,
      );
    }
    try {
      const snapshotOutcome = await campaignCommandSnapshot(
        deps.publicSocial,
        crmIdentity(sessionToken, deps),
        now,
        oneFormValue(form, 'return_date'),
      );
      if (!snapshotOutcome.ok) {
        return campaignNoticeRedirect(
          res, deps, sessionToken, campaignFailureNotice(snapshotOutcome.kind),
          CONTENT_CALENDAR_ROUTE, returnQuery,
        );
      }
      const exact = snapshotOutcome.snapshot.planning?.calendar.items.find((row) => (
        row.intentId === intentId && row.targetId === targetId
      ));
      if (!exact) {
        return campaignNoticeRedirect(
          res, deps, sessionToken, 'missing', CONTENT_CALENDAR_ROUTE, returnQuery,
        );
      }
      if (exact.intentSha256 !== expectedSha256 || exact.updatedAt !== expectedUpdatedAt) {
        return campaignNoticeRedirect(
          res, deps, sessionToken, 'conflict', CONTENT_CALENDAR_ROUTE, returnQuery,
        );
      }
      if (rescheduling) {
        const desiredFor = campaignDesiredInstant(
          form,
          snapshotOutcome.snapshot.workspace.timezone,
          false,
        );
        if (!desiredFor) {
          return campaignNoticeRedirect(
            res, deps, sessionToken, 'invalid', CONTENT_CALENDAR_ROUTE, returnQuery,
          );
        }
        const outcome = await deps.publicSocial.reschedule!(crmIdentity(sessionToken, deps), {
          commandKey,
          predecessorIntentId: intentId,
          targetId,
          newDesiredFor: desiredFor,
          reason,
        });
        return campaignNoticeRedirect(
          res, deps, sessionToken,
          outcome.ok ? outcome.result.disposition === 'replayed' ? 'replayed' : 'rescheduled'
            : campaignFailureNotice(outcome.kind),
          CONTENT_CALENDAR_ROUTE,
          returnQuery,
        );
      }
      const outcome = await deps.publicSocial.cancel!(crmIdentity(sessionToken, deps), {
        intentId,
        targetId,
        reason,
      });
      return campaignNoticeRedirect(
        res, deps, sessionToken,
        outcome.ok ? outcome.result.disposition === 'replayed' ? 'replayed' : 'cancelled'
          : campaignFailureNotice(outcome.kind),
        CONTENT_CALENDAR_ROUTE,
        returnQuery,
      );
    } catch {
      return campaignNoticeRedirect(
        res, deps, sessionToken, 'unavailable', CONTENT_CALENDAR_ROUTE, returnQuery,
      );
    }
  }

  // ── Property Predator campaign templates: prepared copy/recipes, no effects ──
  if (deps.kind === 'postgres' && p === CAMPAIGN_MACHINE_ROUTE && method === 'GET') {
    if (deps.productProfile?.id !== 'property_predator_growth') {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Campaign Machine not available',
        message: 'This Property Predator sequence library is not enabled for the current product profile.',
        active: 'content',
        backHref: PUBLIC_SOCIAL_CAMPAIGNS_ROUTE,
        backLabel: 'Return to Campaigns',
      }));
    }
    if (!deps.campaignMachine) {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Campaign Machine not connected',
        message: 'The protected campaign evidence reader is not enabled for this workspace.',
        active: 'content',
        backHref: PUBLIC_SOCIAL_CAMPAIGNS_ROUTE,
        backLabel: 'Return to Campaigns',
      }));
    }
    try {
      const outcome = await deps.campaignMachine.snapshot(crmIdentity(sessionToken, deps));
      if (!outcome.ok) {
        const status = outcome.kind === 'forbidden' ? 403
          : outcome.kind === 'unauthenticated' ? 401 : 503;
        return sendHtml(res, status, portalStatusPage(deps, sessionToken, {
          title: 'Campaign Machine temporarily unavailable',
          message: outcome.message,
          active: 'content',
          backHref: PUBLIC_SOCIAL_CAMPAIGNS_ROUTE,
          backLabel: 'Return to Campaigns',
        }));
      }
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      return sendHtml(res, 200, operationalPage(
        outcome.snapshot.workspaceName,
        renderCampaignMachineBody(presentCampaignMachine(outcome.snapshot)),
        deps,
        'content',
        csrfToken,
      ));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Campaign Machine temporarily unavailable',
        message: 'No campaign, approval, audience or provider state was changed. Try again shortly.',
        active: 'content',
        backHref: PUBLIC_SOCIAL_CAMPAIGNS_ROUTE,
        backLabel: 'Return to Campaigns',
      }));
    }
  }

  // ── public-social campaigns: exact body-free command projection, read-only ──
  if (deps.kind === 'postgres' && p === PUBLIC_SOCIAL_CAMPAIGNS_ROUTE && method === 'GET') {
    if (!deps.publicSocial) {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Campaign Command not connected',
        message: 'The protected TEST campaign projection is not enabled for this workspace.',
        active: 'content',
        backHref: CONTENT_CALENDAR_ROUTE,
        backLabel: 'Return to Campaign Calendar',
      }));
    }
    const campaignValues = url.searchParams.getAll('campaign');
    const campaignValue = campaignValues.length === 1 ? campaignValues[0]!.trim() : '';
    if (campaignValues.length > 1 || (campaignValue && !CRM_OBJECT_ID.test(campaignValue))) {
      return sendHtml(res, 400, portalStatusPage(deps, sessionToken, {
        title: 'Campaign address not valid',
        message: 'Open one exact campaign from the authenticated Campaign Calendar.',
        active: 'content',
        backHref: CONTENT_CALENDAR_ROUTE,
        backLabel: 'Return to Campaign Calendar',
      }));
    }
    const requestedCampaignId = campaignValue ? campaignValue.toLowerCase() : null;
    const asOf = new Date(now).toISOString();
    const selected = normaliseContentCalendarFilters({}, asOf);
    const range = contentCalendarReadRange(selected.date);
    try {
      const outcome = await deps.publicSocial.snapshot(crmIdentity(sessionToken, deps), {
        campaignId: requestedCampaignId,
        from: range.from,
        to: range.to,
        limit: 1,
      });
      if (!outcome.ok) {
        const status = outcome.kind === 'unauthenticated' || outcome.kind === 'forbidden'
          ? 403
          : outcome.kind === 'validation'
            ? 400
            : outcome.kind === 'not_found'
              ? 404
              : 503;
        return sendHtml(res, status, portalStatusPage(deps, sessionToken, {
          title: status === 503
            ? 'Campaign Command temporarily unavailable'
            : 'Campaign Command not available',
          message: outcome.message,
          active: 'content',
          backHref: CONTENT_CALENDAR_ROUTE,
          backLabel: 'Return to Campaign Calendar',
        }));
      }
      const snapshot = outcome.snapshot;
      const view = presentPublicSocialCampaigns(snapshot.campaign.items, {
        workspaceName: snapshot.workspace.workspaceName,
        workspaceTimezone: snapshot.workspace.timezone,
        snapshotAt: snapshot.workspace.snapshotAt,
        requestedCampaignId,
        calendarFilters: {
          mode: url.searchParams.get('calendar_mode'),
          date: url.searchParams.get('calendar_date'),
          channel: url.searchParams.get('calendar_channel'),
        },
        inputTruncated: snapshot.campaign.hasMore,
      });
      const contentNavigation = deps.productProfile?.contentWorkspace;
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      return sendHtml(res, 200, operationalPage(
        snapshot.workspace.workspaceName,
        renderPublicSocialCampaignsBody(view, {
          companyAssetsAvailable: Boolean(
            deps.companyAssets
            && contentNavigation?.assetsRoute === COMPANY_ASSETS_ROUTE
          ),
          assetsLabel: contentNavigation?.assetsLabel,
          brandBrainAvailable: Boolean(
            deps.brandBrain
            && contentNavigation?.brainRoute === BRAND_BRAIN_ROUTE
          ),
          brainLabel: contentNavigation?.brainLabel,
          campaignMachineAvailable: Boolean(deps.campaignMachine),
        }),
        deps,
        'content',
        csrfToken,
      ));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Campaign Command temporarily unavailable',
        message: 'No campaign, provider, schedule or delivery state was changed. Try again shortly.',
        active: 'content',
        backHref: CONTENT_CALENDAR_ROUTE,
        backLabel: 'Return to Campaign Calendar',
      }));
    }
  }

  // ── public-social calendar: authenticated TEST projections + exact owned content proof ──
  if (deps.kind === 'postgres' && p === CONTENT_CALENDAR_ROUTE && method === 'GET') {
    if (!deps.publicSocial || !deps.companyContent) {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Campaign Calendar not connected',
        message: 'The protected TEST campaign projection and company-content catalogue must both be enabled.',
        active: 'content',
        backHref: CONTENT_CONTROL_ROOM_ROUTE,
        backLabel: 'Return to Content Control',
      }));
    }
    const asOf = new Date(now).toISOString();
    const filters = normaliseContentCalendarFilters({
      mode: url.searchParams.get('mode'),
      view: url.searchParams.get('view'),
      date: url.searchParams.get('date'),
      channel: url.searchParams.get('channel'),
    }, asOf);
    const range = contentCalendarReadRange(filters.date);
    const identity = crmIdentity(sessionToken, deps);
    try {
      const [socialOutcome, contentOutcome] = await Promise.all([
        deps.publicSocial.snapshot(identity, {
          from: range.from,
          to: range.to,
          limit: 120,
        }),
        deps.companyContent.snapshot(identity, { limit: 100 }),
      ]);
      const failure = !socialOutcome.ok
        ? { kind: socialOutcome.kind, message: socialOutcome.message }
        : !contentOutcome.ok
          ? { kind: contentOutcome.kind, message: contentOutcome.message }
          : null;
      if (failure) {
        const status = failure.kind === 'unauthenticated' || failure.kind === 'forbidden'
          ? 403
          : failure.kind === 'validation'
            ? 400
            : failure.kind === 'not_found'
              ? 404
              : 503;
        return sendHtml(res, status, portalStatusPage(deps, sessionToken, {
          title: status === 503
            ? 'Campaign Calendar temporarily unavailable'
            : 'Campaign Calendar not available',
          message: failure.message,
          active: 'content',
          backHref: CONTENT_CONTROL_ROOM_ROUTE,
          backLabel: 'Return to Content Control',
        }));
      }
      if (!socialOutcome.ok || !contentOutcome.ok) {
        throw new Error('calendar projection failure escaped its safe response boundary');
      }
      const social = socialOutcome.snapshot;
      const content = contentOutcome.snapshot;
      if (social.workspace.workspaceId !== content.workspace.workspaceId) {
        throw new Error('calendar workspace projection mismatch');
      }
      const snapshot = adaptPublicSocialCalendar(
        social.calendar.items,
        content.catalog,
        social.calendar.hasMore,
        social.planning?.calendar.items ?? [],
        social.planning?.calendar.hasMore ?? false,
      );
      const view = presentContentCalendar(snapshot, {
        workspaceName: social.workspace.workspaceName,
        timezone: social.workspace.timezone,
        asOf: social.workspace.snapshotAt,
        filters,
      });
      const contentNavigation = deps.productProfile?.contentWorkspace;
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      const mutations = publicSocialPlanningMutations(
        deps,
        sessionToken,
        social,
        view,
        url.searchParams,
      );
      return sendHtml(res, 200, operationalPage(
        social.workspace.workspaceName,
        renderContentCalendarBody(view, {
          companyAssetsAvailable: Boolean(
            deps.companyAssets
            && contentNavigation?.assetsRoute === COMPANY_ASSETS_ROUTE
          ),
          assetsLabel: contentNavigation?.assetsLabel,
          brandBrainAvailable: Boolean(
            deps.brandBrain
            && contentNavigation?.brainRoute === BRAND_BRAIN_ROUTE
          ),
          brainLabel: contentNavigation?.brainLabel,
          mutations,
        }),
        deps,
        'content',
        csrfToken,
      ), undefined, {
        'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Campaign Calendar temporarily unavailable',
        message: 'No campaign, content, provider, schedule or delivery state was changed. Try again shortly.',
        active: 'content',
        backHref: CONTENT_CONTROL_ROOM_ROUTE,
        backLabel: 'Return to Content Control',
      }));
    }
  }

  // ── owned-seed proof: exact company copy → separate LIVE message → capped job ──
  if (deps.kind === 'postgres' && p === OWNED_SEED_PROOF_PREPARE_ROUTE && method === 'POST') {
    const form = await readForm(req);
    if (!deps.companyContent?.createEmailDraftVersion
        || !deps.ownedSeedMessages || !deps.ownedSeedCampaign) {
      return contentControlRedirect(res, deps, sessionToken, form, 'unavailable');
    }
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return contentControlRedirect(res, deps, sessionToken, form, 'invalid');
    }
    try {
      const identity = crmIdentity(sessionToken, deps);
      const existing = await deps.companyContent.snapshot(identity, {
        limit: 100,
        sourceSystem: 'propertypredator.company-content',
      });
      if (!existing.ok) {
        return contentControlRedirect(res, deps, sessionToken, form, contentFailureNotice(existing.kind));
      }
      const prior = existing.snapshot.catalog.items.find((item) => (
        item.source.itemId === PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM
      ));
      if (prior?.sourceFresh) {
        const notice = contentControlNoticeToken(deps.sessionSecret, sessionToken, 'replayed');
        return redirect(res, exactCompanyContentReviewLocation(
          prior.contentItemId,
          prior.contentVersionId,
          { notice },
        ), undefined, 303, { 'cache-control': 'no-store' });
      }
      const revision = prior ? {
        contentItemId: prior.contentItemId,
        previousVersionId: prior.contentVersionId,
        sourceVersion: `operational-proof-${new Date(now).toISOString().replace(/[^0-9]/gu, '')}`
          + `-${createHash('sha256').update(form.command_key ?? '').digest('hex').slice(0, 16)}`,
      } : undefined;
      const outcome = await deps.companyContent.createEmailDraftVersion(
        identity,
        propertyPredatorOwnedSeedProofEmailCommand(form.command_key ?? '', now, revision),
      );
      if (!outcome.ok) {
        return contentControlRedirect(res, deps, sessionToken, form, contentFailureNotice(outcome.kind));
      }
      const notice = contentControlNoticeToken(deps.sessionSecret, sessionToken, 'draft_created');
      return redirect(res, exactCompanyContentReviewLocation(
        outcome.contentItemId,
        outcome.contentVersionId,
        { notice },
      ), undefined, 303, { 'cache-control': 'no-store' });
    } catch {
      return contentControlRedirect(res, deps, sessionToken, form, 'unavailable');
    }
  }

  if (deps.kind === 'postgres' && p === OWNED_SEED_MESSAGE_CREATE_ROUTE && method === 'POST') {
    const form = await readForm(req);
    const contentItemId = (form.return_exact_item_id ?? '').trim().toLowerCase();
    const contentVersionId = (form.return_exact_version_id ?? '').trim().toLowerCase();
    if (!deps.ownedSeedMessages || !CRM_OBJECT_ID.test(contentItemId)
        || !CRM_OBJECT_ID.test(contentVersionId)
        || !verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return contentControlRedirect(res, deps, sessionToken, form, 'invalid');
    }
    try {
      const outcome = await deps.ownedSeedMessages.createDraft(crmIdentity(sessionToken, deps), {
        commandKey: form.command_key ?? '',
        companyContentVersionId: contentVersionId,
      });
      if (!outcome.ok) {
        const notice = contentControlNoticeToken(
          deps.sessionSecret,
          sessionToken,
          ownedSeedWorkflowFailure(outcome.kind),
        );
        return redirect(res, exactCompanyContentReviewLocation(contentItemId, contentVersionId, { notice }), undefined, 303);
      }
      const result = outcome.result;
      const state: OwnedSeedWorkflowState = Object.freeze({
        phase: 'drafted',
        companyContentVersionId: result.companyContentVersionId,
        messageId: result.messageId,
        messageVersionId: result.messageVersionId,
        approvalRequestId: null,
        subjectSha256: result.subjectSha256,
        bodySha256: result.bodySha256,
        sourceContentSha256: result.sourceContentSha256,
      });
      return ownedSeedWorkflowRedirect(res, deps, sessionToken, contentItemId, state);
    } catch {
      const notice = contentControlNoticeToken(deps.sessionSecret, sessionToken, 'unavailable');
      return redirect(res, exactCompanyContentReviewLocation(contentItemId, contentVersionId, { notice }), undefined, 303);
    }
  }

  if (deps.kind === 'postgres' && p === OWNED_SEED_MESSAGE_APPROVAL_REQUEST_ROUTE && method === 'POST') {
    const form = await readForm(req);
    const contentItemId = (form.return_exact_item_id ?? '').trim().toLowerCase();
    const state = verifyOwnedSeedWorkflowToken(
      deps.sessionSecret,
      sessionToken,
      form.owned_seed_workflow_token,
      now,
    );
    if (!deps.ownedSeedMessages || !state || state.phase !== 'drafted'
        || !CRM_OBJECT_ID.test(contentItemId)
        || !verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return contentControlRedirect(res, deps, sessionToken, form, 'invalid');
    }
    try {
      const outcome = await deps.ownedSeedMessages.requestApproval(crmIdentity(sessionToken, deps), {
        commandKey: form.command_key ?? '',
        messageId: state.messageId,
        reviewNote: form.review_note ?? null,
      });
      if (!outcome.ok) {
        return ownedSeedWorkflowRedirect(
          res, deps, sessionToken, contentItemId, state, ownedSeedWorkflowFailure(outcome.kind),
        );
      }
      const result = outcome.result;
      if (result.messageId !== state.messageId || result.messageVersionId !== state.messageVersionId
          || result.subjectSha256 !== state.subjectSha256 || result.bodySha256 !== state.bodySha256
          || result.sourceContentSha256 !== state.sourceContentSha256) {
        return ownedSeedWorkflowRedirect(res, deps, sessionToken, contentItemId, state, 'conflict');
      }
      return ownedSeedWorkflowRedirect(res, deps, sessionToken, contentItemId, Object.freeze({
        ...state,
        phase: 'approval_pending',
        approvalRequestId: result.approvalRequestId,
      }));
    } catch {
      return ownedSeedWorkflowRedirect(res, deps, sessionToken, contentItemId, state, 'unavailable');
    }
  }

  if (deps.kind === 'postgres' && p === OWNED_SEED_MESSAGE_APPROVAL_DECISION_ROUTE && method === 'POST') {
    const form = await readForm(req);
    const contentItemId = (form.return_exact_item_id ?? '').trim().toLowerCase();
    const state = verifyOwnedSeedWorkflowToken(
      deps.sessionSecret,
      sessionToken,
      form.owned_seed_workflow_token,
      now,
    );
    const decision = form.decision;
    if (!deps.ownedSeedMessages || !state || state.phase !== 'approval_pending'
        || !state.approvalRequestId || !CRM_OBJECT_ID.test(contentItemId)
        || (decision !== 'approved' && decision !== 'rejected' && decision !== 'changes_requested')
        || !verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return contentControlRedirect(res, deps, sessionToken, form, 'invalid');
    }
    try {
      const outcome = await deps.ownedSeedMessages.decideApproval(crmIdentity(sessionToken, deps), {
        commandKey: form.command_key ?? '',
        approvalRequestId: state.approvalRequestId,
        decision,
        decisionNote: form.decision_note ?? null,
      });
      if (!outcome.ok) {
        return ownedSeedWorkflowRedirect(
          res, deps, sessionToken, contentItemId, state, ownedSeedWorkflowFailure(outcome.kind),
        );
      }
      const result = outcome.result;
      if (result.messageId !== state.messageId || result.messageVersionId !== state.messageVersionId
          || result.approvalRequestId !== state.approvalRequestId
          || result.subjectSha256 !== state.subjectSha256 || result.bodySha256 !== state.bodySha256
          || result.sourceContentSha256 !== state.sourceContentSha256) {
        return ownedSeedWorkflowRedirect(res, deps, sessionToken, contentItemId, state, 'conflict');
      }
      return ownedSeedWorkflowRedirect(res, deps, sessionToken, contentItemId, Object.freeze({
        ...state,
        phase: decision === 'approved' ? 'approved' : 'drafted',
        approvalRequestId: result.approvalRequestId,
      }));
    } catch {
      return ownedSeedWorkflowRedirect(res, deps, sessionToken, contentItemId, state, 'unavailable');
    }
  }

  if (deps.kind === 'postgres' && p === OWNED_SEED_CAMPAIGN_STAGE_ROUTE && method === 'POST') {
    const form = await readForm(req);
    const contentItemId = (form.return_exact_item_id ?? '').trim().toLowerCase();
    const state = verifyOwnedSeedWorkflowToken(
      deps.sessionSecret,
      sessionToken,
      form.owned_seed_workflow_token,
      now,
    );
    if (!deps.ownedSeedCampaign || !state || state.phase !== 'approved'
        || !CRM_OBJECT_ID.test(contentItemId)
        || !verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return contentControlRedirect(res, deps, sessionToken, form, 'invalid');
    }
    try {
      const outcome = await deps.ownedSeedCampaign.stage(crmIdentity(sessionToken, deps), {
        commandKey: form.command_key ?? '',
        messageVersionId: state.messageVersionId,
        runId: form.run_id ?? '',
      });
      if (!outcome.ok) {
        return ownedSeedWorkflowRedirect(
          res, deps, sessionToken, contentItemId, state, ownedSeedWorkflowFailure(outcome.kind),
        );
      }
      const result = outcome.result;
      if (result.messageVersionId !== state.messageVersionId) {
        return ownedSeedWorkflowRedirect(res, deps, sessionToken, contentItemId, state, 'conflict');
      }
      if (result.disposition === 'blocked') {
        // A DB block is recoverable after fresh controls/evidence. Keep the
        // separately approved message retryable rather than stranding it in a
        // terminal browser-only phase.
        return ownedSeedWorkflowRedirect(res, deps, sessionToken, contentItemId, state, 'conflict');
      }
      return ownedSeedWorkflowRedirect(res, deps, sessionToken, contentItemId, Object.freeze({
        ...state,
        phase: 'staged',
      }));
    } catch {
      return ownedSeedWorkflowRedirect(res, deps, sessionToken, contentItemId, state, 'unavailable');
    }
  }

  // ── exact company-content review: complete immutable bytes beside the decision ──
  const exactCompanyContentReview = p.match(COMPANY_CONTENT_EXACT_REVIEW_ROUTE);
  if (deps.kind === 'postgres' && exactCompanyContentReview && method === 'GET') {
    const contentItemId = (exactCompanyContentReview[1] ?? '').toLowerCase();
    const contentVersionId = (exactCompanyContentReview[2] ?? '').toLowerCase();
    if (!deps.companyContent?.review
        || !CRM_OBJECT_ID.test(contentItemId) || !CRM_OBJECT_ID.test(contentVersionId)) {
      return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Exact content review not connected',
        message: 'The complete immutable review representation is not available. Nothing changed.',
        active: 'content',
        backHref: CONTENT_CONTROL_ROOM_ROUTE,
        backLabel: 'Return to Content Control',
      }));
    }
    try {
      const outcome = await deps.companyContent.review(crmIdentity(sessionToken, deps), {
        contentItemId,
        contentVersionId,
      });
      if (!outcome.ok) {
        const status = outcome.kind === 'unauthenticated' || outcome.kind === 'forbidden'
          ? 403 : outcome.kind === 'validation' ? 400 : outcome.kind === 'not_found' ? 404 : 503;
        return sendHtml(res, status, portalStatusPage(deps, sessionToken, {
          title: status === 503 ? 'Exact content review temporarily unavailable' : 'Exact content review unavailable',
          message: outcome.message,
          active: 'content',
          backHref: CONTENT_CONTROL_ROOM_ROUTE,
          backLabel: 'Return to Content Control',
        }));
      }
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      const review = outcome.snapshot.review;
      const isOwnedSeedProof = review.source.system === 'propertypredator.company-content'
        && review.source.itemId === PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM;
      const ownedSeedEligible = Boolean(
        isOwnedSeedProof
        && outcome.snapshot.workspace.canManage
        && deps.ownedSeedMessages
        && review.isLatest
        && !review.approvalStale
        && review.approvalStatus === 'approved'
        && review.email
      );
      let ownedSeedAvailable = ownedSeedEligible;
      let ownedSeedWorkflow: OwnedSeedWorkflowState | undefined;
      let ownedSeedWorkflowTokenValue: string | undefined;
      if (ownedSeedEligible && deps.ownedSeedMessages && review.email) {
        const resumed = await deps.ownedSeedMessages.resume(crmIdentity(sessionToken, deps), {
          companyContentVersionId: review.contentVersionId,
        });
        if (!resumed.ok) {
          ownedSeedAvailable = false;
        } else if (resumed.result) {
          const result = resumed.result;
          const exactEvidenceMatches = result.companyContentVersionId === review.contentVersionId
            && result.sourceContentSha256 === review.contentSha256
            && result.subjectSha256 === review.email.subjectSha256
            && result.bodySha256 === review.email.bodySha256;
          if (!exactEvidenceMatches) {
            ownedSeedAvailable = false;
          } else {
            ownedSeedWorkflow = Object.freeze({
              phase: result.phase,
              companyContentVersionId: result.companyContentVersionId,
              messageId: result.messageId,
              messageVersionId: result.messageVersionId,
              approvalRequestId: result.approvalRequestId,
              subjectSha256: result.subjectSha256,
              bodySha256: result.bodySha256,
              sourceContentSha256: result.sourceContentSha256,
            });
            ownedSeedWorkflowTokenValue = ownedSeedWorkflowToken(
              deps.sessionSecret,
              sessionToken,
              ownedSeedWorkflow,
              now,
            );
            if (!ownedSeedWorkflowTokenValue) ownedSeedAvailable = false;
          }
        }
      }
      return sendHtml(res, 200, operationalPage(
        outcome.snapshot.workspace.workspaceName,
        renderPortalCompanyContentReviewBody(outcome.snapshot, {
          notice: contentControlNoticeFromQuery(
            url.searchParams,
            deps.sessionSecret,
            sessionToken,
          ),
          security: {
            csrfToken,
            ownedSeedAvailable,
            ownedSeedStageAvailable: Boolean(deps.ownedSeedCampaign),
            ...(ownedSeedWorkflow && ownedSeedWorkflowTokenValue
              ? {
                  ownedSeedWorkflow,
                  ownedSeedWorkflowToken: ownedSeedWorkflowTokenValue,
                }
              : {}),
            ownedSeedCommandKey: randomUUID(),
            ownedSeedRunId: randomUUID(),
            ...(review.approvalStatus === 'pending' && review.approvalRequestId
              ? {
                  decisionCommandKey: randomUUID(),
                  exactApprovalToken: exactReviewApprovalToken(
                    deps.sessionSecret,
                    sessionToken,
                    {
                      contentItemId: review.contentItemId,
                      contentVersionId: review.contentVersionId,
                      approvalRequestId: review.approvalRequestId,
                      contentSha256: review.contentSha256,
                    },
                    now,
                  ),
                }
              : { requestCommandKey: randomUUID() }),
          },
        }),
        deps,
        'content',
        csrfToken,
      ));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Exact content review temporarily unavailable',
        message: 'No approval, message, provider or schedule state was changed.',
        active: 'content',
        backHref: CONTENT_CONTROL_ROOM_ROUTE,
        backLabel: 'Return to Content Control',
      }));
    }
  }

  // ── company-owned content control: immutable catalogue evidence only ──
  if (deps.kind === 'postgres' && p === CONTENT_CONTROL_ROOM_ROUTE && method === 'GET') {
    if (!deps.companyContent) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Content Control not connected',
      message: 'The company-owned content catalogue is not enabled for this workspace.',
      active: 'content',
    }));
    try {
      const outcome = await deps.companyContent.snapshot(crmIdentity(sessionToken, deps), {
        limit: 100,
      });
      if (!outcome.ok) {
        const status = outcome.kind === 'unauthenticated' || outcome.kind === 'forbidden'
          ? 403
          : outcome.kind === 'validation'
            ? 400
            : outcome.kind === 'not_found'
              ? 404
              : 503;
        return sendHtml(res, status, portalStatusPage(deps, sessionToken, {
          title: status === 503 ? 'Content Control temporarily unavailable' : 'Content Control not available',
          message: outcome.message,
          active: 'content',
          backHref: '/portal',
          backLabel: 'Return to Growth HQ',
        }));
      }
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      const view = presentContentControlRoom(outcome.snapshot.catalog, {
        workspaceName: outcome.snapshot.workspace.workspaceName,
        asOf: outcome.snapshot.workspace.snapshotAt,
        canWrite: outcome.snapshot.workspace.canWrite,
        canManage: outcome.snapshot.workspace.canManage,
        notice: contentControlNoticeFromQuery(url.searchParams, deps.sessionSecret, sessionToken),
        filters: {
          query: url.searchParams.get('q') ?? '',
          channel: url.searchParams.get('channel') ?? '',
          format: url.searchParams.get('format') ?? '',
        },
      });
      return sendHtml(res, 200, operationalPage(
        outcome.snapshot.workspace.workspaceName,
        renderContentControlRoomBody(view, {
          companyAssetsAvailable: Boolean(
            deps.companyAssets
            && deps.productProfile?.contentWorkspace?.assetsRoute === COMPANY_ASSETS_ROUTE
          ),
          companyAssetsLabel: deps.productProfile?.contentWorkspace?.assetsLabel,
          brandBrainAvailable: Boolean(
            deps.brandBrain
            && deps.productProfile?.contentWorkspace?.brainRoute === BRAND_BRAIN_ROUTE
          ),
          brandBrainLabel: deps.productProfile?.contentWorkspace?.brainLabel,
          companyContentSyncAvailable: Boolean(
            deps.companyContentSync
            && deps.productProfile?.id === 'property_predator_growth'
          ),
          ownedSeedProofAvailable: Boolean(
            view.canManage
            && deps.companyContent.createEmailDraftVersion
            && deps.ownedSeedMessages
            && deps.ownedSeedCampaign
            && deps.productProfile?.id === 'property_predator_growth'
          ),
          ownedSeedPrepareCommandKey: randomUUID(),
          security: view.canWrite ? {
            csrfToken,
            requestApprovalKeys: Object.fromEntries(view.items.map((item) => [
              item.contentVersionId,
              randomUUID(),
            ])),
            decisionKeys: Object.fromEntries(view.items.flatMap((item) => (
              item.approvalRequestId ? [[item.approvalRequestId, randomUUID()]] : []
            ))),
          } : undefined,
        }),
        deps,
        'content',
        csrfToken,
      ));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Content Control temporarily unavailable',
        message: 'No approval, version or provider state was changed. Try again shortly.',
        active: 'content',
        backHref: '/portal',
        backLabel: 'Return to Growth HQ',
      }));
    }
  }

  if (deps.kind === 'postgres' && p === CONTENT_APPROVAL_REQUEST_ROUTE && method === 'POST') {
    if (!deps.companyContent) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Content Control not connected',
      message: 'The protected company-content approval service is not enabled.',
      active: 'content',
    }));
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return contentControlRedirect(res, deps, sessionToken, form, 'invalid');
    }
    try {
      const outcome = await deps.companyContent.requestApproval(crmIdentity(sessionToken, deps), {
        commandKey: form.command_key ?? '',
        contentItemId: form.content_item_id ?? '',
        contentVersionId: form.content_version_id ?? '',
        reviewNote: form.review_note ?? null,
      });
      return contentControlRedirect(
        res,
        deps,
        sessionToken,
        form,
        outcome.ok
          ? outcome.disposition === 'replayed' ? 'replayed' : 'requested'
          : contentFailureNotice(outcome.kind),
      );
    } catch {
      return contentControlRedirect(res, deps, sessionToken, form, 'unavailable');
    }
  }

  if (deps.kind === 'postgres' && p === CONTENT_APPROVAL_DECISION_ROUTE && method === 'POST') {
    if (!deps.companyContent) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Content Control not connected',
      message: 'The protected company-content approval service is not enabled.',
      active: 'content',
    }));
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return contentControlRedirect(res, deps, sessionToken, form, 'invalid');
    }
    const decision = form.decision;
    if (decision !== 'approved' && decision !== 'rejected' && decision !== 'changes_requested') {
      return contentControlRedirect(res, deps, sessionToken, form, 'invalid');
    }
    try {
      if (decision === 'approved') {
        const reviewItemId = (form.review_content_item_id ?? '').trim().toLowerCase();
        const reviewVersionId = (form.review_content_version_id ?? '').trim().toLowerCase();
        const reviewContentSha256 = (form.review_content_sha256 ?? '').trim().toLowerCase();
        const approvalRequestId = (form.approval_request_id ?? '').trim().toLowerCase();
        if (!deps.companyContent.decideExactReviewedApproval
            || !CRM_OBJECT_ID.test(reviewItemId)
            || !CRM_OBJECT_ID.test(reviewVersionId)
            || !CRM_OBJECT_ID.test(approvalRequestId)
            || !/^[0-9a-f]{64}$/u.test(reviewContentSha256)
            || !verifyExactReviewApprovalToken(
              deps.sessionSecret,
              sessionToken,
              form.exact_approval_token,
              {
                contentItemId: reviewItemId,
                contentVersionId: reviewVersionId,
                approvalRequestId,
                contentSha256: reviewContentSha256,
              },
              now,
            )) {
          return contentControlRedirect(res, deps, sessionToken, form, 'review_unavailable');
        }
        const outcome = await deps.companyContent.decideExactReviewedApproval(
          crmIdentity(sessionToken, deps),
          {
            commandKey: form.command_key ?? '',
            approvalRequestId,
            decision: 'approved',
            decisionNote: form.decision_note ?? null,
            contentItemId: reviewItemId,
            contentVersionId: reviewVersionId,
            contentSha256: reviewContentSha256,
          },
        );
        return contentControlRedirect(
          res,
          deps,
          sessionToken,
          form,
          outcome.ok
            ? outcome.disposition === 'replayed' ? 'replayed' : outcome.decision
            : contentFailureNotice(outcome.kind),
        );
      }
      const outcome = await deps.companyContent.decideApproval(crmIdentity(sessionToken, deps), {
        commandKey: form.command_key ?? '',
        approvalRequestId: form.approval_request_id ?? '',
        decision,
        decisionNote: form.decision_note ?? null,
      });
      return contentControlRedirect(
        res,
        deps,
        sessionToken,
        form,
        outcome.ok
          ? outcome.disposition === 'replayed' ? 'replayed' : outcome.decision
          : contentFailureNotice(outcome.kind),
      );
    } catch {
      return contentControlRedirect(res, deps, sessionToken, form, 'unavailable');
    }
  }

  // ── TEST conversion inbox: queue read plus an explicitly separate detail projection ──
  if (deps.kind === 'postgres' && p === CONVERSION_INBOX_ROUTE && method === 'GET') {
    if (!deps.inbox) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Conversion Inbox not connected',
      message: 'The TEST/SIMULATED conversation read service is not enabled for this workspace.',
      active: 'inbox',
    }));
    const filters = normaliseConversionInboxFilters({
      query: url.searchParams.get('q') ?? '',
      channel: url.searchParams.get('channel') ?? '',
      queue: url.searchParams.get('queue') ?? '',
    });
    const requestedConversation = (url.searchParams.get('conversation') ?? '').toLowerCase();
    const conversationId = CRM_OBJECT_ID.test(requestedConversation)
      ? requestedConversation
      : undefined;
    const identity = crmIdentity(sessionToken, deps);
    try {
      const [shell, page] = await Promise.all([
        deps.crm.workspaceShell ? deps.crm.workspaceShell(identity) : deps.crm.snapshot(identity),
        deps.inbox.listConversations(identity, {
          limit: CONVERSION_INBOX_MAX_CONVERSATIONS,
          channel: filters.channel === 'all' ? null : filters.channel,
          state: filters.queue === 'open' ? 'open' : null,
          search: filters.query || null,
        }),
      ]);
      if (!shell || !page || page.workspaceId !== shell.workspace.id) {
        return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
          title: 'Conversion Inbox workspace not available',
          message: 'This session cannot read a matching workspace-scoped TEST conversation queue.',
          active: 'inbox',
          backHref: '/portal',
          backLabel: 'Return to Growth HQ',
        }));
      }

      const options = {
        workspaceName: shell.workspace.name,
        notice: conversionInboxNoticeFromQuery(
          url.searchParams,
          deps.sessionSecret,
          sessionToken,
        ),
        filters: {
          query: filters.query,
          channel: filters.channel,
          queue: filters.queue,
          conversationId,
        },
      } as const;
      const queueOnly = presentConversionInbox({ page, threads: [] }, options);
      const selectedConversationId = queueOnly.conversations.find((item) => item.selected)?.conversationId;
      let threads: readonly ConversionInboxThreadSnapshot[] = [];
      if (selectedConversationId && deps.inbox.thread
          && page.conversations.some((item) => item.conversationId === selectedConversationId)) {
        const thread = await deps.inbox.thread(identity, selectedConversationId);
        // A mismatched or invisible projection never reaches the presenter.
        if (thread?.conversationId === selectedConversationId) threads = [thread];
      }
      const view = presentConversionInbox({ page, threads }, options);
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      const draft = view.selectedThread?.draft;
      const conversationIdForAction = view.selectedThread?.summary.conversationId;
      const messageIdForAction = draft?.messageId;
      const approvalRequestIdForAction = draft?.approvalRequestId;
      const adminCallTaskIdForAction = view.selectedThread?.adminCall?.taskStatus === 'open'
        ? view.selectedThread.adminCall.taskId : undefined;
      const actionNow = new Date(deps.now?.() ?? Date.now());
      const actionSecurity = (deps.inboxCommands || deps.inboxOperations) && view.canWrite ? {
        csrfToken,
        createDraftKeys: deps.inboxCommands && conversationIdForAction && draft?.messageId === null
          ? { [conversationIdForAction]: randomUUID() } : {},
        reviseDraftKeys: deps.inboxCommands && messageIdForAction && draft?.lifecycle === 'draft'
          ? { [messageIdForAction]: randomUUID() } : {},
        requestApprovalKeys: deps.inboxCommands && messageIdForAction && draft?.lifecycle === 'draft'
          ? { [messageIdForAction]: randomUUID() } : {},
        decisionKeys: deps.inboxCommands && view.canManage && approvalRequestIdForAction && draft?.approvalState === 'pending'
          ? { [approvalRequestIdForAction]: randomUUID() } : {},
        queueKeys: deps.inboxCommands && view.canManage && messageIdForAction && draft?.mayQueueTestOperation
          ? { [messageIdForAction]: randomUUID() } : {},
        assignmentKeys: deps.inboxOperations && conversationIdForAction
          ? { [conversationIdForAction]: randomUUID() } : {},
        internalNoteKeys: deps.inboxOperations && conversationIdForAction
          ? { [conversationIdForAction]: randomUUID() } : {},
        adminCallKeys: deps.inboxOperations && conversationIdForAction
          ? { [conversationIdForAction]: randomUUID() } : {},
        callOutcomeKeys: deps.inboxOperations && adminCallTaskIdForAction
          ? { [adminCallTaskIdForAction]: randomUUID() } : {},
        adminCallDueAt: new Date(actionNow.getTime() + 15 * 60_000).toISOString(),
        outcomeOccurredAt: actionNow.toISOString(),
        nextActionDueAt: new Date(actionNow.getTime() + 24 * 60 * 60_000).toISOString(),
      } : undefined;
      return sendHtml(res, 200, operationalPage(
        shell.workspace.name,
        renderConversionInboxBody(view, { security: actionSecurity }),
        deps,
        'inbox',
        csrfToken,
      ));
    } catch (error) {
      // A swallowed read failure is why a privilege regression reached a
      // founder walkthrough as an unexplained 503. The record carries the
      // error class and SQLSTATE only, so an operator can tell 42501 from a
      // connection fault without any customer data reaching a log line.
      deps.telemetry?.emit('error', 'portal.inbox.read_failed', { error });
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Conversion Inbox temporarily unavailable',
        message: 'No draft was queued and no message left Growth HQ. Try again shortly.',
        active: 'inbox',
        backHref: '/portal',
        backLabel: 'Return to Growth HQ',
      }));
    }
  }

  const inboxAssignmentMatch = p.match(INBOX_ASSIGNMENT_ROUTE);
  if (deps.kind === 'postgres' && inboxAssignmentMatch && method === 'POST') {
    const conversationId = (inboxAssignmentMatch[1] ?? '').toLowerCase();
    const form = await readForm(req);
    const assignment = form.assignment;
    if (!deps.inboxOperations || !CRM_OBJECT_ID.test(conversationId)
        || !verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)
        || (assignment !== 'self' && assignment !== 'unassigned')) {
      return conversionInboxRedirect(res, deps, sessionToken, form,
        deps.inboxOperations ? 'invalid' : 'unavailable');
    }
    try {
      const outcome = await deps.inboxOperations.assignConversation(
        crmIdentity(sessionToken, deps),
        {
          commandKey: form.command_key ?? '', conversationId,
          expectedRowVersion: form.expected_row_version ?? '', assignment,
        },
      );
      return conversionInboxRedirect(res, deps, sessionToken, form,
        outcome.ok
          ? outcome.disposition === 'replayed' ? 'replayed' : 'assignment_saved'
          : conversionInboxFailureNotice(outcome.kind));
    } catch {
      return conversionInboxRedirect(res, deps, sessionToken, form, 'unavailable');
    }
  }

  const inboxInternalNoteMatch = p.match(INBOX_INTERNAL_NOTE_ROUTE);
  if (deps.kind === 'postgres' && inboxInternalNoteMatch && method === 'POST') {
    const conversationId = (inboxInternalNoteMatch[1] ?? '').toLowerCase();
    const form = await readForm(req);
    if (!deps.inboxOperations || !CRM_OBJECT_ID.test(conversationId)
        || !verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return conversionInboxRedirect(res, deps, sessionToken, form,
        deps.inboxOperations ? 'invalid' : 'unavailable');
    }
    try {
      const outcome = await deps.inboxOperations.appendInternalNote(
        crmIdentity(sessionToken, deps),
        { commandKey: form.command_key ?? '', conversationId, body: form.body ?? '' },
      );
      return conversionInboxRedirect(res, deps, sessionToken, form,
        outcome.ok
          ? outcome.disposition === 'replayed' ? 'replayed' : 'note_saved'
          : conversionInboxFailureNotice(outcome.kind));
    } catch {
      return conversionInboxRedirect(res, deps, sessionToken, form, 'unavailable');
    }
  }

  const inboxAdminCallMatch = p.match(INBOX_ADMIN_CALL_ROUTE);
  if (deps.kind === 'postgres' && inboxAdminCallMatch && method === 'POST') {
    const conversationId = (inboxAdminCallMatch[1] ?? '').toLowerCase();
    const form = await readForm(req);
    const priority = form.priority;
    if (!deps.inboxOperations || !CRM_OBJECT_ID.test(conversationId)
        || !verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)
        || (priority !== 'high' && priority !== 'urgent')) {
      return conversionInboxRedirect(res, deps, sessionToken, form,
        deps.inboxOperations ? 'invalid' : 'unavailable');
    }
    try {
      const outcome = await deps.inboxOperations.createAdminCall(
        crmIdentity(sessionToken, deps),
        {
          commandKey: form.command_key ?? '', conversationId, priority,
          dueAt: form.due_at ?? '', note: form.note?.trim() ? form.note : null,
        },
      );
      return conversionInboxRedirect(res, deps, sessionToken, form,
        outcome.ok
          ? outcome.disposition === 'replayed' ? 'replayed' : 'admin_call_created'
          : conversionInboxFailureNotice(outcome.kind));
    } catch {
      return conversionInboxRedirect(res, deps, sessionToken, form, 'unavailable');
    }
  }

  const inboxCallOutcomeMatch = p.match(INBOX_CALL_OUTCOME_ROUTE);
  if (deps.kind === 'postgres' && inboxCallOutcomeMatch && method === 'POST') {
    const taskId = (inboxCallOutcomeMatch[1] ?? '').toLowerCase();
    const form = await readForm(req);
    const conversationId = (form.return_conversation ?? '').toLowerCase();
    const callOutcome = form.outcome ?? '';
    const nextTitle = form.next_action_title?.trim() ?? '';
    const nextKind = form.next_action_kind ?? '';
    const nextPriority = form.next_action_priority ?? '';
    const validNext = !nextTitle || (
      INBOX_NEXT_ACTION_KIND_VALUES.has(nextKind)
      && INBOX_NEXT_ACTION_PRIORITY_VALUES.has(nextPriority)
    );
    if (!deps.inboxOperations || !CRM_OBJECT_ID.test(taskId)
        || !CRM_OBJECT_ID.test(conversationId)
        || !verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)
        || !INBOX_CALL_OUTCOME_VALUES.has(callOutcome) || !validNext) {
      return conversionInboxRedirect(res, deps, sessionToken, form,
        deps.inboxOperations ? 'invalid' : 'unavailable');
    }
    try {
      const outcome = await deps.inboxOperations.recordCallOutcome(
        crmIdentity(sessionToken, deps),
        {
          commandKey: form.command_key ?? '', conversationId, taskId,
          expectedTaskRowVersion: form.expected_task_row_version ?? '',
          outcome: callOutcome as typeof CONVERSION_INBOX_CALL_OUTCOMES[number],
          summary: form.summary ?? '', occurredAt: form.occurred_at ?? '',
          nextAction: nextTitle ? {
            kind: nextKind as typeof CONVERSION_INBOX_NEXT_ACTION_KINDS[number],
            title: nextTitle, dueAt: form.next_action_due_at ?? '',
            priority: nextPriority as typeof CONVERSION_INBOX_NEXT_ACTION_PRIORITIES[number],
          } : null,
        },
      );
      return conversionInboxRedirect(res, deps, sessionToken, form,
        outcome.ok
          ? outcome.disposition === 'replayed' ? 'replayed' : 'call_outcome_saved'
          : conversionInboxFailureNotice(outcome.kind));
    } catch {
      return conversionInboxRedirect(res, deps, sessionToken, form, 'unavailable');
    }
  }

  if (deps.kind === 'postgres' && p === CONVERSION_INBOX_CREATE_DRAFT_ROUTE && method === 'POST') {
    if (!deps.inboxCommands) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Conversion Inbox controls not connected',
      message: 'The protected TEST draft command service is not enabled.',
      active: 'inbox',
    }));
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return conversionInboxRedirect(res, deps, sessionToken, form, 'invalid');
    }
    try {
      const outcome = await deps.inboxCommands.createDraft(crmIdentity(sessionToken, deps), {
        commandKey: form.command_key ?? '',
        conversationId: form.conversation_id ?? '',
        contactPointId: form.contact_point_id ?? '',
        body: form.body ?? '',
        sourceContent: null,
      });
      return conversionInboxRedirect(res, deps, sessionToken, form,
        outcome.ok
          ? outcome.disposition === 'replayed' ? 'replayed' : 'draft_created'
          : conversionInboxFailureNotice(outcome.kind));
    } catch {
      return conversionInboxRedirect(res, deps, sessionToken, form, 'unavailable');
    }
  }

  const inboxVersionMatch = p.match(INBOX_MESSAGE_VERSION_ROUTE);
  if (deps.kind === 'postgres' && inboxVersionMatch && method === 'POST') {
    const messageId = (inboxVersionMatch[1] ?? '').toLowerCase();
    const form = await readForm(req);
    if (!deps.inboxCommands || !CRM_OBJECT_ID.test(messageId)
        || !verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return conversionInboxRedirect(res, deps, sessionToken, form,
        deps.inboxCommands ? 'invalid' : 'unavailable');
    }
    try {
      const outcome = await deps.inboxCommands.reviseDraft(crmIdentity(sessionToken, deps), {
        commandKey: form.command_key ?? '',
        messageId,
        expectedRowVersion: form.expected_row_version ?? '',
        body: form.body ?? '',
        sourceContent: null,
      });
      return conversionInboxRedirect(res, deps, sessionToken, form,
        outcome.ok
          ? outcome.disposition === 'replayed' ? 'replayed' : 'draft_saved'
          : conversionInboxFailureNotice(outcome.kind));
    } catch {
      return conversionInboxRedirect(res, deps, sessionToken, form, 'unavailable');
    }
  }

  const inboxApprovalRequestMatch = p.match(INBOX_APPROVAL_REQUEST_ROUTE);
  if (deps.kind === 'postgres' && inboxApprovalRequestMatch && method === 'POST') {
    const messageId = (inboxApprovalRequestMatch[1] ?? '').toLowerCase();
    const form = await readForm(req);
    if (!deps.inboxCommands || !CRM_OBJECT_ID.test(messageId)
        || !verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return conversionInboxRedirect(res, deps, sessionToken, form,
        deps.inboxCommands ? 'invalid' : 'unavailable');
    }
    try {
      const outcome = await deps.inboxCommands.requestApproval(crmIdentity(sessionToken, deps), {
        commandKey: form.command_key ?? '',
        messageId,
        expectedRowVersion: form.expected_row_version ?? '',
        reviewNote: form.review_note ?? null,
      });
      return conversionInboxRedirect(res, deps, sessionToken, form,
        outcome.ok
          ? outcome.disposition === 'replayed' ? 'replayed' : 'approval_requested'
          : conversionInboxFailureNotice(outcome.kind));
    } catch {
      return conversionInboxRedirect(res, deps, sessionToken, form, 'unavailable');
    }
  }

  const inboxDecisionMatch = p.match(INBOX_APPROVAL_DECISION_ROUTE);
  if (deps.kind === 'postgres' && inboxDecisionMatch && method === 'POST') {
    const approvalRequestId = (inboxDecisionMatch[1] ?? '').toLowerCase();
    const form = await readForm(req);
    const decision = form.decision;
    if (!deps.inboxCommands || !CRM_OBJECT_ID.test(approvalRequestId)
        || !verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)
        || (decision !== 'approved' && decision !== 'rejected' && decision !== 'changes_requested')) {
      return conversionInboxRedirect(res, deps, sessionToken, form,
        deps.inboxCommands ? 'invalid' : 'unavailable');
    }
    try {
      const outcome = await deps.inboxCommands.decideApproval(crmIdentity(sessionToken, deps), {
        commandKey: form.command_key ?? '',
        approvalRequestId,
        decision,
        decisionNote: form.decision_note ?? null,
      });
      return conversionInboxRedirect(res, deps, sessionToken, form,
        outcome.ok
          ? outcome.disposition === 'replayed' ? 'replayed' : outcome.decision
          : conversionInboxFailureNotice(outcome.kind));
    } catch {
      return conversionInboxRedirect(res, deps, sessionToken, form, 'unavailable');
    }
  }

  const inboxTestQueueMatch = p.match(INBOX_TEST_QUEUE_ROUTE);
  if (deps.kind === 'postgres' && inboxTestQueueMatch && method === 'POST') {
    const messageId = (inboxTestQueueMatch[1] ?? '').toLowerCase();
    const form = await readForm(req);
    const purpose = form.purpose;
    if (!deps.inboxCommands || !CRM_OBJECT_ID.test(messageId)
        || !verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)
        || !isConversionInboxTestQueuePurpose(purpose)) {
      return conversionInboxRedirect(res, deps, sessionToken, form,
        deps.inboxCommands ? 'invalid' : 'unavailable');
    }
    try {
      const outcome = await deps.inboxCommands.queueApprovedMessage(crmIdentity(sessionToken, deps), {
        commandKey: form.command_key ?? '',
        messageId,
        expectedRowVersion: form.expected_row_version ?? '',
        purpose,
      });
      return conversionInboxRedirect(res, deps, sessionToken, form,
        outcome.ok
          ? outcome.disposition === 'replayed' ? 'replayed' : 'test_queued'
          : conversionInboxFailureNotice(outcome.kind));
    } catch {
      return conversionInboxRedirect(res, deps, sessionToken, form, 'unavailable');
    }
  }

  // ── live Journey Board: movable CRM workflow beside immutable evidence ──
  if (p === JOURNEY_BOARD_ROUTE && method === 'GET') {
    if (!deps.crm?.journeyBoard) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Live journeys not connected',
      message: 'The protected operational board is not enabled for this workspace.',
      active: 'journeys',
    }));
    try {
      const board = await deps.crm.journeyBoard(crmIdentity(sessionToken, deps), {
        query: url.searchParams.get('q') ?? '',
        route: url.searchParams.get('route') ?? '',
        band: url.searchParams.get('band') ?? '',
      });
      if (!board) return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Journey workspace not available',
        message: 'This session no longer has access to the selected workspace.',
        active: 'journeys',
      }));
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      const notice = crmNoticeFromQuery(url.searchParams, deps.sessionSecret, sessionToken);
      return sendHtml(
        res,
        200,
        journeyBoardPage(board.workspace.name, `${journeySubnav('board')}${renderJourneyBoardBody({
          ...board,
          csrfToken,
          notice,
        })}`, deps, csrfToken),
        undefined,
        {
          'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        },
      );
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Live journeys temporarily unavailable',
        message: 'No workflow, journey evidence or outbound action was changed. Try again shortly.',
        active: 'journeys',
      }));
    }
  }

  // ── conversion Journey Manager: read-only topology plus explicit manager setup ──
  if (deps.kind === 'postgres' && p === JOURNEY_MANAGER_ROUTE && method === 'GET') {
    if (!deps.journeys) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Journey Manager not connected',
      message: 'The protected journey definition service is not enabled for this workspace.',
      active: 'journeys',
    }));
    const identity = crmIdentity(sessionToken, deps);
    try {
      const [shell, snapshot] = await Promise.all([
        deps.crm.workspaceShell ? deps.crm.workspaceShell(identity) : deps.crm.snapshot(identity),
        deps.journeys.snapshot(identity),
      ]);
      if (!shell || !snapshot) return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Journey workspace not available',
        message: 'This session no longer has access to the selected workspace.',
        active: 'journeys',
      }));
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      const view = presentJourneyManager(
        snapshot,
        shell.workspace.name,
        { csrfToken, commandKey: randomUUID() },
        journeyManagerNoticeFromQuery(url.searchParams, deps.sessionSecret, sessionToken),
      );
      return sendHtml(
        res,
        200,
        journeyManagerPage(shell, `${journeySubnav('rules')}${renderJourneyManagerBody(view)}`, deps, csrfToken),
      );
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Journey Manager temporarily unavailable',
        message: 'No definition, lead or outbound action was changed. Try again shortly.',
        active: 'journeys',
      }));
    }
  }

  if (deps.kind === 'postgres' && p === JOURNEY_MANAGER_INSTALL_ROUTE && method === 'POST') {
    if (!deps.journeys) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Journey Manager not connected',
      message: 'The protected journey definition service is not enabled for this workspace.',
      active: 'journeys',
    }));
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Refresh needed',
        message: 'The secure form token was invalid. No journey definition was changed.',
        active: 'journeys',
        backHref: JOURNEY_MANAGER_ROUTE,
        backLabel: 'Return to journeys',
      }));
    }
    if (!CRM_OBJECT_ID.test(form.command_key ?? '') || form.confirmation !== JOURNEY_MANAGER_CONFIRMATION) {
      return journeyRedirect(res, deps, sessionToken, 'invalid');
    }
    try {
      const outcome = await deps.journeys.installFoundation({
        sessionToken,
        requestId: form.command_key!,
      });
      if (outcome.ok) {
        return journeyRedirect(res, deps, sessionToken, outcome.disposition === 'replayed' ? 'replayed' : 'installed');
      }
      const code: JourneyManagerNoticeCode = outcome.kind === 'forbidden'
        ? 'forbidden'
        : outcome.kind === 'conflict'
          ? 'conflict'
          : 'unavailable';
      return journeyRedirect(res, deps, sessionToken, code);
    } catch {
      return journeyRedirect(res, deps, sessionToken, 'unavailable');
    }
  }

  const journeyBoardMoveMatch = /^\/portal\/journeys\/board\/opportunities\/([^/]+)\/stage$/.exec(p);
  if (deps.crm && journeyBoardMoveMatch && method === 'POST') {
    const opportunityId = journeyBoardMoveMatch[1]!;
    if (!CRM_OBJECT_ID.test(opportunityId)) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Opportunity not found',
      message: 'That workflow card address is not valid for this workspace.',
      active: 'journeys', backHref: JOURNEY_BOARD_ROUTE, backLabel: 'Return to live journeys',
    }));
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Refresh needed',
        message: 'The secure form token was invalid. No workflow or journey evidence was changed.',
        active: 'journeys', backHref: JOURNEY_BOARD_ROUTE, backLabel: 'Return to live journeys',
      }));
    }
    const returnParams = journeyBoardReturnParams(form);
    try {
      const outcome = await deps.crm.moveOpportunity(crmIdentity(sessionToken, deps), {
        commandKey: form.command_key ?? '',
        opportunityId,
        targetStageId: form.target_lane_id ?? '',
        expectedRowVersion: form.expected_version ?? '',
      });
      if (outcome.ok) return crmRedirect(
        res,
        JOURNEY_BOARD_ROUTE,
        deps,
        sessionToken,
        outcome.disposition === 'replayed' ? 'replayed' : 'moved',
        303,
        returnParams,
      );
      if (outcome.kind === 'conflict') return crmRedirect(res, JOURNEY_BOARD_ROUTE, deps, sessionToken, 'conflict', 303, returnParams);
      if (outcome.kind === 'not_found') return crmRedirect(res, JOURNEY_BOARD_ROUTE, deps, sessionToken, 'missing', 303, returnParams);
      return sendHtml(res, outcome.kind === 'forbidden' ? 403 : outcome.kind === 'unavailable' ? 503 : 400,
        portalStatusPage(deps, sessionToken, {
          title: 'Workflow lane was not changed',
          message: outcome.kind === 'validation'
            ? 'Refresh the board and choose a valid team workflow lane.'
            : outcome.message,
          active: 'journeys', backHref: JOURNEY_BOARD_ROUTE, backLabel: 'Return to live journeys',
        }));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Live journeys temporarily unavailable',
        message: 'The workflow card was not moved. Journey evidence was not changed.',
        active: 'journeys', backHref: JOURNEY_BOARD_ROUTE, backLabel: 'Return to live journeys',
      }));
    }
  }

  // ── durable CRM: real service only; no fake fallback data ──
  if (p === '/portal/crm' && method === 'GET') {
    return deps.crm
      ? redirect(res, CRM_PORTAL_ROUTES.contacts)
      : sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'CRM not connected', message: 'The durable CRM is not enabled for this workspace.', crmAvailable: false,
      }));
  }

  const isCrmRoute = p.startsWith('/portal/crm/');
  if (isCrmRoute && !deps.crm) {
    return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'CRM not connected', message: 'The durable CRM is not enabled for this workspace.', crmAvailable: false,
    }));
  }


  // Founder-only contact permission decision. Database-only by construction:
  // it appends one consent event and never queues, sends or releases anything.
  if (deps.kind === 'postgres' && p === CONTACT_PERMISSION_ROUTE && method === 'POST') {
    const form = await readMultiValueForm(req);
    const contactId = (form ? oneFormValue(form, 'contact_id') ?? '' : '').toLowerCase();
    // A notice must land on the exact case file the founder came from, so an
    // unusable contact id goes back to the contact list rather than guessing.
    if (!CRM_OBJECT_ID.test(contactId)) {
      return redirect(res, CRM_PORTAL_ROUTES.contacts, undefined, 303);
    }
    const permissionNotice = (code: ContactPermissionNoticeCode): void => redirect(
      res,
      `${contactCaseFileRoute(contactId)}?notice=${encodeURIComponent(
        contactPermissionNoticeToken(deps.sessionSecret, sessionToken, code),
      )}`,
      undefined,
      303,
    );
    const commandKey = form ? oneFormValue(form, 'command_key') : null;
    if (!form || !campaignFormKeysAllowed(form, new Set(CONTACT_PERMISSION_FORM_KEYS))
        || !verifyPortalCsrf(deps.sessionSecret, sessionToken, oneFormValue(form, '_csrf') ?? '')
        || oneFormValue(form, 'confirm_permission') !== CONTACT_PERMISSION_CONFIRM_VALUE
        || !commandKey || !CRM_OBJECT_ID.test(commandKey)) {
      return permissionNotice('permission_invalid');
    }
    if (!deps.contactPermission) return permissionNotice('permission_unavailable');
    const field = (name: string): string => oneFormValue(form, name) ?? '';
    const optional = (name: string): string | null => {
      const value = oneFormValue(form, name);
      return value === null || value.trim() === '' ? null : value.trim();
    };
    const outcome = await deps.contactPermission.recordDecision(
      crmIdentity(sessionToken, deps),
      {
        commandKey,
        contactId,
        contactPointId: field('contact_point_id').toLowerCase(),
        channel: field('channel'),
        purpose: field('purpose'),
        decision: field('decision'),
        lawfulBasis: optional('lawful_basis'),
        evidenceSource: field('evidence_source'),
        policyVersion: optional('policy_version'),
        policyTextSha256: optional('policy_text_sha256'),
        sourceEventId: optional('source_event_id'),
        occurredAt: field('occurred_at'),
        operatorConfirmed: true,
      },
    );
    if (outcome.ok) {
      return permissionNotice(
        outcome.disposition === 'replayed' ? 'permission_replayed' : 'permission_recorded',
      );
    }
    return permissionNotice(
      outcome.kind === 'conflict' ? 'permission_conflict'
        : outcome.kind === 'forbidden' || outcome.kind === 'unauthenticated'
          ? 'permission_forbidden'
          : outcome.kind === 'validation' ? 'permission_invalid' : 'permission_unavailable',
    );
  }


  // Founder-only endpoint attach on an existing contact. It can create neither
  // a contact nor an opportunity, and records no permission.
  if (deps.kind === 'postgres' && p === CONTACT_ENDPOINT_ATTACH_ROUTE && method === 'POST') {
    const form = await readMultiValueForm(req);
    const contactId = (form ? oneFormValue(form, 'contact_id') ?? '' : '').toLowerCase();
    if (!CRM_OBJECT_ID.test(contactId)) {
      return redirect(res, CRM_PORTAL_ROUTES.contacts, undefined, 303);
    }
    const endpointNotice = (code: FounderEmailPilotNoticeCode): void => redirect(
      res,
      `${contactCaseFileRoute(contactId)}?notice=${encodeURIComponent(
        founderEmailPilotNoticeToken(deps.sessionSecret, sessionToken, code),
      )}`,
      undefined,
      303,
    );
    const commandKey = form ? oneFormValue(form, 'command_key') : null;
    if (!form || !campaignFormKeysAllowed(form, new Set(CONTACT_ENDPOINT_FORM_KEYS))
        || !verifyPortalCsrf(deps.sessionSecret, sessionToken, oneFormValue(form, '_csrf') ?? '')
        || oneFormValue(form, 'confirm_endpoint') !== CONTACT_ENDPOINT_CONFIRM_VALUE
        || !commandKey || !CRM_OBJECT_ID.test(commandKey)) {
      return endpointNotice('endpoint_invalid');
    }
    if (!deps.founderEmailPilot) return endpointNotice('endpoint_unavailable');
    const field = (name: string): string => oneFormValue(form, name) ?? '';
    const label = field('label').trim();
    const outcome = await deps.founderEmailPilot.attachEndpoint(
      crmIdentity(sessionToken, deps),
      {
        commandKey,
        contactId,
        email: field('email'),
        label: label === '' ? null : label,
        evidenceSource: field('evidence_source'),
        evidenceReference: field('evidence_reference'),
        verifiedAt: field('verified_at'),
        operatorConfirmed: true,
      },
    );
    if (outcome.ok) {
      return endpointNotice(
        outcome.disposition === 'replayed' ? 'endpoint_replayed' : 'endpoint_attached',
      );
    }
    return endpointNotice(
      outcome.kind === 'conflict' ? 'endpoint_conflict'
        : outcome.kind === 'forbidden' || outcome.kind === 'unauthenticated'
          ? 'endpoint_forbidden'
          : outcome.kind === 'validation' ? 'endpoint_invalid' : 'endpoint_unavailable',
    );
  }

  // The two preparation acts. Neither queues anything and neither reaches a
  // provider; both are owner/admin gated at the database boundary.
  if (deps.kind === 'postgres' && method === 'POST'
      && (p === EMAIL_PILOT_PREPARE_ROUTE || p === EMAIL_PILOT_POLICY_ROUTE
        || p.startsWith(`${EMAIL_PILOT_PREPARE_ROUTE}/`)
        || p.startsWith(`${EMAIL_PILOT_POLICY_ROUTE}/`))) {
    const preparing = p === EMAIL_PILOT_PREPARE_ROUTE
      || p.startsWith(`${EMAIL_PILOT_PREPARE_ROUTE}/`);
    const form = await readMultiValueForm(req);
    const pathStepToken = p.startsWith(`${preparing
      ? EMAIL_PILOT_PREPARE_ROUTE : EMAIL_PILOT_POLICY_ROUTE}/`)
      ? p.slice((preparing ? EMAIL_PILOT_PREPARE_ROUTE : EMAIL_PILOT_POLICY_ROUTE).length + 1)
      : null;
    // The current founder flow carries only the RLS-visible contact id and an
    // idempotency key in the route. The endpoint and purpose are reopened from
    // Lead 360 below. Older signed and form-based actions remain accepted for
    // a rolling deploy, but newly rendered buttons never depend on them.
    const directParts = pathStepToken?.split('/') ?? [];
    const directAction = directParts.length === 2
      && CRM_OBJECT_ID.test(directParts[0] ?? '')
      && CRM_OBJECT_ID.test(directParts[1] ?? '');
    const directContactId = directParts[0] ?? '';
    const directCommandKey = directParts[1] ?? '';
    const submittedStepToken = form ? oneFormValue(form, 'step_token') : null;
    const signedStep = form && !directAction ? founderEmailPilotStepClaims(
      pathStepToken ?? submittedStepToken ?? '', deps.sessionSecret, sessionToken, Date.now(),
    ) : null;
    const contactId = (directAction ? directContactId : signedStep?.contactId
      ?? (form ? oneFormValue(form, 'contact_id') ?? '' : '')).toLowerCase();
    if (!CRM_OBJECT_ID.test(contactId)) {
      return redirect(res, CRM_PORTAL_ROUTES.contacts, undefined, 303);
    }
    const stepNotice = (code: FounderEmailPilotNoticeCode): void => redirect(
      res,
      `${contactCaseFileRoute(contactId)}?notice=${encodeURIComponent(
        founderEmailPilotNoticeToken(deps.sessionSecret, sessionToken, code),
      )}`,
      undefined,
      303,
    );
    const commandKey = (directAction ? directCommandKey : signedStep?.commandKey
      ?? (form ? oneFormValue(form, 'command_key') ?? '' : '')).toLowerCase();
    let contactPointId = (signedStep?.contactPointId
      ?? (form ? oneFormValue(form, 'contact_point_id') ?? '' : '')).toLowerCase();
    const legacyConfirmed = preparing
      ? oneFormValue(form ?? new URLSearchParams(), 'confirm_prepare')
        === EMAIL_PILOT_PREPARE_CONFIRM_VALUE
      : oneFormValue(form ?? new URLSearchParams(), 'confirm_policy')
        === EMAIL_PILOT_POLICY_CONFIRM_VALUE;
    const signedAllowed = new Set(
      pathStepToken !== null || submittedStepToken === null ? [] : ['step_token'],
    );
    const legacyAllowed = new Set(
      preparing ? EMAIL_PILOT_PREPARE_FORM_KEYS : EMAIL_PILOT_POLICY_FORM_KEYS,
    );
    const signedFormValid = signedStep !== null
      && signedStep.step === (preparing ? 'prepare' : 'policy')
      && campaignFormKeysAllowed(form ?? new URLSearchParams(), signedAllowed);
    const legacyFormValid = signedStep === null
      && campaignFormKeysAllowed(form ?? new URLSearchParams(), legacyAllowed)
      && verifyPortalCsrf(
        deps.sessionSecret, sessionToken, oneFormValue(form ?? new URLSearchParams(), '_csrf') ?? '',
      ) && legacyConfirmed;
    const directFormValid = directAction
      && campaignFormKeysAllowed(form ?? new URLSearchParams(), new Set());
    if (!form || (!directFormValid && !signedFormValid && !legacyFormValid)
        || !CRM_OBJECT_ID.test(commandKey)
        || (!directAction && !CRM_OBJECT_ID.test(contactPointId))) {
      return stepNotice(preparing ? 'prepare_invalid' : 'policy_invalid');
    }
    if (!deps.founderEmailPilot) {
      return stepNotice(preparing ? 'prepare_unavailable' : 'policy_unavailable');
    }
    let purpose = signedStep?.purpose
      ?? oneFormValue(form, 'purpose') ?? FOUNDER_PILOT_PURPOSE;
    if (directAction) {
      const caseFile = await deps.crm.lead360?.(crmIdentity(sessionToken, deps), contactId);
      const pilotEndpoint = caseFile?.consent.find((entry) => entry.channel === 'email');
      if (!pilotEndpoint || !CRM_OBJECT_ID.test(pilotEndpoint.contactPointId)) {
        return stepNotice(preparing ? 'prepare_invalid' : 'policy_invalid');
      }
      contactPointId = pilotEndpoint.contactPointId.toLowerCase();
      purpose = pilotEndpoint.purpose ?? FOUNDER_PILOT_PURPOSE;
    }
    const input = {
      contactId,
      contactPointId,
      purpose,
      commandKey,
      operatorConfirmed: true,
    };
    const outcome = preparing
      ? await deps.founderEmailPilot.prepareContent(crmIdentity(sessionToken, deps), input)
      : await deps.founderEmailPilot.recordPolicyEvidence(
        crmIdentity(sessionToken, deps), input,
      );
    if (outcome.ok) {
      const replayed = outcome.disposition === 'replayed';
      return stepNotice(
        preparing
          ? (replayed ? 'prepare_replayed' : 'prepare_done')
          : (replayed ? 'policy_replayed' : 'policy_recorded'),
      );
    }
    const suffix = outcome.kind === 'conflict' ? 'conflict'
      : outcome.kind === 'blocked' ? 'blocked'
        : outcome.kind === 'forbidden' || outcome.kind === 'unauthenticated' ? 'forbidden'
          : outcome.kind === 'validation' ? 'invalid' : 'unavailable';
    return stepNotice(
      `${preparing ? 'prepare' : 'policy'}_${suffix}` as FounderEmailPilotNoticeCode,
    );
  }

  // The final founder act: authorise the capped enqueue for one already
  // approved message. It calls the existing 0054 command and never Mailgun.
  if (deps.kind === 'postgres'
      && (p === EMAIL_PILOT_AUTHORISE_ROUTE || p.startsWith(`${EMAIL_PILOT_AUTHORISE_ROUTE}/`))
      && method === 'POST') {
    const form = await readMultiValueForm(req);
    const pathPreviewToken = p.startsWith(`${EMAIL_PILOT_AUTHORISE_ROUTE}/`)
      ? p.slice(EMAIL_PILOT_AUTHORISE_ROUTE.length + 1)
      : null;
    const submittedPreviewToken = form ? oneFormValue(form, 'preview_token') : null;
    const claims = form ? founderEmailPilotPreviewClaims(
      pathPreviewToken ?? submittedPreviewToken ?? '',
      deps.sessionSecret,
      sessionToken,
      Date.now(),
    ) : null;
    const browserBound = claims?.contactId !== undefined
      && claims.contactPointId !== undefined
      && claims.purpose !== undefined;
    const contactId = (browserBound ? claims.contactId!
      : (form ? oneFormValue(form, 'contact_id') ?? '' : '')).toLowerCase();
    if (!CRM_OBJECT_ID.test(contactId)) {
      return redirect(res, CRM_PORTAL_ROUTES.contacts, undefined, 303);
    }
    const pilotNotice = (code: FounderEmailPilotNoticeCode): void => redirect(
      res,
      `${contactCaseFileRoute(contactId)}?notice=${encodeURIComponent(
        founderEmailPilotNoticeToken(deps.sessionSecret, sessionToken, code),
      )}`,
      undefined,
      303,
    );
    const commandKey = (browserBound ? claims.commandKey
      : (form ? oneFormValue(form, 'command_key') ?? '' : '')).toLowerCase();
    const contactPointId = (browserBound ? claims.contactPointId!
      : (form ? oneFormValue(form, 'contact_point_id') ?? '' : '')).toLowerCase();
    const signedFormValid = browserBound
      && campaignFormKeysAllowed(
        form ?? new URLSearchParams(),
        new Set(
          pathPreviewToken !== null || submittedPreviewToken === null ? [] : ['preview_token'],
        ),
      );
    const legacyFormValid = !browserBound
      && campaignFormKeysAllowed(
        form ?? new URLSearchParams(), new Set(EMAIL_PILOT_AUTHORISE_FORM_KEYS),
      )
      && verifyPortalCsrf(
        deps.sessionSecret, sessionToken, oneFormValue(form ?? new URLSearchParams(), '_csrf') ?? '',
      )
      && oneFormValue(form ?? new URLSearchParams(), 'confirm_send') === EMAIL_PILOT_CONFIRM_VALUE;
    // The signed button is the confirmation. Legacy typed forms remain valid
    // during a rolling deploy, but new pages never expose magic phrases.
    if (!form || (!signedFormValid && !legacyFormValid)
        || !CRM_OBJECT_ID.test(commandKey) || !CRM_OBJECT_ID.test(contactPointId)) {
      return pilotNotice('pilot_invalid');
    }
    // The preview token proves this session was shown this exact message under
    // this exact command key. A forged, borrowed or expired one authorises
    // nothing, and is refused before the enqueue identity is touched.
    if (!claims || claims.commandKey !== commandKey) return pilotNotice('pilot_stale_preview');
    if (!deps.founderEmailPilot) return pilotNotice('pilot_unavailable');
    const outcome = await deps.founderEmailPilot.authorise(
      crmIdentity(sessionToken, deps),
      {
        contactId,
        contactPointId,
        purpose: claims.purpose
          ?? oneFormValue(form, 'purpose') ?? FOUNDER_PILOT_PURPOSE,
        commandKey,
        evidenceDigest: claims.evidenceDigest,
        authorityValidUntil: claims.authorityValidUntil,
        operatorConfirmed: true,
      },
    );
    if (outcome.ok) {
      return pilotNotice(
        outcome.disposition === 'replayed' ? 'pilot_replayed' : 'pilot_queued',
      );
    }
    return pilotNotice(
      outcome.kind === 'stale_preview' ? 'pilot_stale_preview'
        : outcome.kind === 'conflict' ? 'pilot_conflict'
          : outcome.kind === 'blocked' ? 'pilot_blocked'
            : outcome.kind === 'forbidden' || outcome.kind === 'unauthenticated'
              ? 'pilot_forbidden'
              : outcome.kind === 'validation' ? 'pilot_invalid' : 'pilot_unavailable',
    );
  }

  const lead360Match = /^\/portal\/crm\/contacts\/([^/]+)$/.exec(p);
  if (deps.crm && lead360Match && method === 'GET') {
    const contactId = lead360Match[1]!;
    if (!CRM_OBJECT_ID.test(contactId)) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Lead not found',
      message: 'That Lead 360 address is not valid for this workspace.',
      active: 'crm', backHref: CRM_PORTAL_ROUTES.contacts, backLabel: 'Return to contacts',
    }));
    if (!deps.crm.lead360) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Lead 360 not connected',
      message: 'This CRM service does not expose the read-only evidence case file yet.',
      active: 'crm', backHref: CRM_PORTAL_ROUTES.contacts, backLabel: 'Return to contacts',
    }));
    const identity = crmIdentity(sessionToken, deps);
    try {
      const shell = deps.crm.workspaceShell
        ? await deps.crm.workspaceShell(identity)
        : await deps.crm.snapshot(identity);
      if (!shell) return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'CRM workspace not available',
        message: 'This session no longer has access to the durable CRM workspace.',
        active: 'crm', backHref: CRM_PORTAL_ROUTES.contacts, backLabel: 'Return to contacts',
      }));
      const caseFile = await deps.crm.lead360(identity, contactId);
      if (!caseFile) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
        title: 'Lead not found',
        message: 'No RLS-visible contact exists at that address in this workspace.',
        active: 'crm', backHref: CRM_PORTAL_ROUTES.contacts, backLabel: 'Return to contacts',
      }));
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      // Readiness is evaluated only for an endpoint this contact actually has.
      // Inventing one would show the founder a pilot for an address that does
      // not exist, which is the failure this whole strike came from.
      const pilotEndpoint = caseFile.consent.find((entry) => entry.channel === 'email');
      const pilotReadiness = deps.kind === 'postgres' && deps.founderEmailPilot
        && pilotEndpoint
        ? await (async () => {
          const outcome = await deps.founderEmailPilot!.readiness(
            crmIdentity(sessionToken, deps),
            {
              contactId,
              contactPointId: pilotEndpoint.contactPointId,
              purpose: pilotEndpoint.purpose ?? FOUNDER_PILOT_PURPOSE,
            },
          );
          if (!outcome.ok) return null;
          return {
            ready: outcome.report.result === 'ready-for-founder-authorisation',
            blockers: outcome.report.blockers.map((code) => ({
              code,
              message: FOUNDER_EMAIL_PILOT_BLOCKER_MESSAGES[
                code as FounderEmailPilotBlockerCode
              ],
            })),
            preview: outcome.preview,
          };
        })()
        : null;
      // The exact message that would be sent, resolved from the approved
      // records. The command key is minted here and bound into the preview
      // token, so the authorisation can only act on what was rendered.
      const pilotCommandKey = randomUUID();
      const pilotAuthorisation = deps.kind === 'postgres' && deps.founderEmailPilot
        && pilotEndpoint
        ? await (async () => {
          const outcome = await deps.founderEmailPilot!.resolveAuthorisation(
            crmIdentity(sessionToken, deps),
            {
              contactId,
              contactPointId: pilotEndpoint.contactPointId,
              purpose: pilotEndpoint.purpose ?? FOUNDER_PILOT_PURPOSE,
              commandKey: pilotCommandKey,
            },
          );
          if (!outcome.ok || !outcome.preview) return null;
          return {
            recipientEmail: outcome.preview.evidence.recipientEmail,
            subject: outcome.preview.evidence.subject,
            bodyText: outcome.preview.evidence.bodyText,
            campaignVersionNo: outcome.preview.evidence.campaignVersionNo,
            messageVersionNumber: outcome.preview.evidence.messageVersionNumber,
            authorityValidUntil: outcome.preview.authorityValidUntil,
            previewToken: founderEmailPilotPreviewToken(
              deps.sessionSecret, sessionToken,
              {
                commandKey: pilotCommandKey,
                authorityValidUntil: outcome.preview.authorityValidUntil,
                evidenceDigest: outcome.preview.evidenceDigest,
                contactId,
                contactPointId: pilotEndpoint.contactPointId,
                purpose: pilotEndpoint.purpose ?? FOUNDER_PILOT_PURPOSE,
              },
            ),
          };
        })()
        : null;
      // The two preparation steps. They are offered whenever a verified
      // endpoint exists, because the readiness blockers say what is missing and
      // these are how a founder clears the content and review ones.
      const pilotPreparation = deps.kind === 'postgres' && deps.founderEmailPilot
        && pilotEndpoint
        ? (() => {
          return {
            prepareToken: `${contactId}/${randomUUID()}`,
            policyToken: `${contactId}/${randomUUID()}`,
            contactPointId: pilotEndpoint.contactPointId,
            purpose: pilotEndpoint.purpose ?? FOUNDER_PILOT_PURPOSE,
            // Resolved from the verified endpoint on this contact, never typed.
            recipientEmail: pilotReadiness?.preview?.recipientEmail
              ?? pilotEndpoint.endpoint ?? '',
            subject: PROPERTY_PREDATOR_OWNED_SEED_PROOF_SUBJECT,
            bodyText: PROPERTY_PREDATOR_OWNED_SEED_PROOF_BODY,
            contentPrepared: pilotAuthorisation !== null,
            policyRecorded: (pilotReadiness?.blockers ?? []).every(
              (blocker) => blocker.code !== 'PECR_DECISIONS_MISSING'
                && blocker.code !== 'POLICY_AUTHORITY_MISSING',
            ) && pilotReadiness !== null,
            reviewAuthority: FOUNDER_PILOT_REVIEW_AUTHORITY,
            routeClassification: FOUNDER_PILOT_ROUTE_CLASSIFICATION,
            sender: FOUNDER_PILOT_SENDER,
            instigator: FOUNDER_PILOT_INSTIGATOR,
            policyVersion: FOUNDER_PILOT_POLICY_ASSET_VERSION,
            policyClauses: FOUNDER_PILOT_POLICY_CLAUSES,
          };
        })()
        : null;
      const body = `<nav aria-label="Lead 360 breadcrumb" style="margin-bottom:14px"><a class="button secondary compact" href="${CRM_PORTAL_ROUTES.contacts}">← All contacts</a></nav>${renderLead360Body(caseFile, {
        // The legacy JSON portal has no permission boundary, so the panel
        // renders its honest "not composed" state there rather than a form
        // that could not record anything.
        permissionCommandAvailable: deps.kind === 'postgres'
          && Boolean(deps.contactPermission),
        permissionCommandKey: randomUUID(),
        endpointCommandAvailable: deps.kind === 'postgres'
          && Boolean(deps.founderEmailPilot),
        endpointCommandKey: randomUUID(),
        pilotReadiness,
        pilotPreparation,
        pilotAuthorisation,
        csrfToken,
        // Either rail may have redirected here, so both notices are tried and
        // only a signature valid for this session renders.
        notice: contactPermissionNoticeFromQuery(
          url.searchParams, deps.sessionSecret, sessionToken,
        ) ?? founderEmailPilotNoticeFromQuery(
          url.searchParams, deps.sessionSecret, sessionToken,
        ),
      })}`;
      return sendHtml(res, 200, crmPage(shell, body, deps, csrfToken));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'Lead 360 temporarily unavailable',
        message: 'No data was changed. Return to contacts and try again shortly.',
        active: 'crm', backHref: CRM_PORTAL_ROUTES.contacts, backLabel: 'Return to contacts',
      }));
    }
  }

  if (deps.crm && method === 'GET' && [CRM_PORTAL_ROUTES.contacts, CRM_PORTAL_ROUTES.pipeline, CRM_PORTAL_ROUTES.tasks].includes(p as never)) {
    const identity = crmIdentity(sessionToken, deps);
    try {
      const readRequest = crmSnapshotRequest(p, url.searchParams);
      const snapshot = await deps.crm.snapshot(identity, readRequest);
      if (!snapshot) return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'CRM workspace not available', message: 'This session no longer has access to the durable CRM workspace.', active: 'crm',
      }));
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      const notice = crmNoticeFromQuery(url.searchParams, deps.sessionSecret, sessionToken);
      const body = p === CRM_PORTAL_ROUTES.contacts
        ? renderCrmContactsBody(snapshot, { csrfToken, createLeadCommandKey: randomUUID(), notice })
        : p === CRM_PORTAL_ROUTES.pipeline
          ? renderCrmPipelineBody(snapshot, { csrfToken, notice })
          : renderCrmTasksBody(snapshot, {
            csrfToken,
            notice,
            filter: readRequest.section === 'tasks' ? readRequest.filter : 'open',
          });
      return sendHtml(res, 200, crmPage(snapshot, body, deps, csrfToken));
    } catch (error) {
      if (error instanceof PortalCrmPageCursorError) {
        return sendHtml(res, 400, portalStatusPage(deps, sessionToken, {
          title: 'CRM page link expired',
          message: 'Return to the first page and use the latest saved-record controls.',
          active: 'crm',
          backHref: p,
          backLabel: 'Return to the first page',
        }));
      }
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'CRM temporarily unavailable', message: 'No change was made. Try again after returning to the workspace.', active: 'crm',
      }));
    }
  }

  if (deps.crm && p === CRM_PORTAL_ROUTES.createLead && method === 'POST') {
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Refresh needed', message: 'The secure form token was invalid. No change was made.', active: 'crm', backHref: CRM_PORTAL_ROUTES.contacts, backLabel: 'Return to contacts',
      }));
    }
    const identity = crmIdentity(sessionToken, deps);
    const input = {
      commandKey: form.command_key ?? '',
      displayName: form.display_name ?? '',
      companyName: form.company_name ?? '',
      email: form.email ?? '',
      phone: form.phone ?? '',
      opportunityTitle: form.opportunity_title ?? '',
      stageId: form.stage_id ?? '',
      taskTitle: form.task_title ?? '',
      taskDueAt: form.task_due_at ?? '',
    };
    try {
      const outcome = await deps.crm.createLead(identity, input);
      if (outcome.ok) {
        return crmRedirect(res, CRM_PORTAL_ROUTES.contacts, deps, sessionToken, outcome.disposition === 'replayed' ? 'replayed' : 'created');
      }
      if (outcome.kind === 'conflict') return crmRedirect(res, CRM_PORTAL_ROUTES.contacts, deps, sessionToken, 'conflict');
      if (outcome.kind === 'not_found') return crmRedirect(res, CRM_PORTAL_ROUTES.contacts, deps, sessionToken, 'missing');

      const snapshot = await deps.crm.snapshot(identity, { section: 'contacts' });
      if (!snapshot) return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'CRM workspace not available', message: 'This session no longer has access to the durable CRM workspace.', active: 'crm',
      }));
      const state: CreateLeadFormState = {
        values: {
          displayName: input.displayName,
          companyName: input.companyName,
          email: input.email,
          phone: input.phone,
          opportunityTitle: input.opportunityTitle,
          stageId: input.stageId,
          taskTitle: input.taskTitle,
          taskDueAt: input.taskDueAt,
        },
        fieldErrors: outcome.kind === 'validation' ? outcome.fieldErrors : undefined,
      };
      const commandKey = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.commandKey)
        ? input.commandKey : randomUUID();
      const body = renderCrmContactsBody(snapshot, {
        csrfToken: portalCsrfToken(deps.sessionSecret, sessionToken),
        createLeadCommandKey: commandKey,
        form: state,
        notice: outcomeNotice(outcome),
      });
      const status = outcome.kind === 'forbidden' ? 403 : outcome.kind === 'unavailable' ? 503 : 400;
      const csrfToken = portalCsrfToken(deps.sessionSecret, sessionToken);
      return sendHtml(res, status, crmPage(snapshot, body, deps, csrfToken));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'CRM temporarily unavailable', message: 'No lead was saved. Try again after returning to contacts.', active: 'crm', backHref: CRM_PORTAL_ROUTES.contacts, backLabel: 'Return to contacts',
      }));
    }
  }

  const moveMatch = /^\/portal\/crm\/opportunities\/([^/]+)\/stage$/.exec(p);
  if (deps.crm && moveMatch && method === 'POST') {
    if (!CRM_OBJECT_ID.test(moveMatch[1]!)) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Opportunity not found', message: 'That opportunity address is not valid for this workspace.', active: 'crm', backHref: CRM_PORTAL_ROUTES.pipeline, backLabel: 'Return to pipeline',
    }));
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Refresh needed', message: 'The secure form token was invalid. No change was made.', active: 'crm', backHref: CRM_PORTAL_ROUTES.pipeline, backLabel: 'Return to pipeline',
      }));
    }
    try {
      const outcome = await deps.crm.moveOpportunity(crmIdentity(sessionToken, deps), {
        commandKey: form.command_key ?? '',
        opportunityId: moveMatch[1]!,
        targetStageId: form.target_stage_id ?? '',
        expectedRowVersion: form.expected_version ?? '',
      });
      if (outcome.ok) return crmRedirect(res, CRM_PORTAL_ROUTES.pipeline, deps, sessionToken, outcome.disposition === 'replayed' ? 'replayed' : 'moved');
      if (outcome.kind === 'conflict') return crmRedirect(res, CRM_PORTAL_ROUTES.pipeline, deps, sessionToken, 'conflict');
      if (outcome.kind === 'not_found') return crmRedirect(res, CRM_PORTAL_ROUTES.pipeline, deps, sessionToken, 'missing');
      return sendHtml(res, outcome.kind === 'forbidden' ? 403 : outcome.kind === 'unavailable' ? 503 : 400,
        portalStatusPage(deps, sessionToken, {
          title: 'Stage was not changed',
          message: outcome.kind === 'validation' ? 'Check the submitted values and refresh the pipeline.' : outcome.message,
          active: 'crm', backHref: CRM_PORTAL_ROUTES.pipeline, backLabel: 'Return to pipeline',
        }));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'CRM temporarily unavailable', message: 'The stage was not changed.', active: 'crm', backHref: CRM_PORTAL_ROUTES.pipeline, backLabel: 'Return to pipeline',
      }));
    }
  }

  const completeMatch = /^\/portal\/crm\/tasks\/([^/]+)\/complete$/.exec(p);
  if (deps.crm && completeMatch && method === 'POST') {
    if (!CRM_OBJECT_ID.test(completeMatch[1]!)) return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Task not found', message: 'That task address is not valid for this workspace.', active: 'crm', backHref: CRM_PORTAL_ROUTES.tasks, backLabel: 'Return to tasks',
    }));
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Refresh needed', message: 'The secure form token was invalid. No change was made.', active: 'crm', backHref: CRM_PORTAL_ROUTES.tasks, backLabel: 'Return to tasks',
      }));
    }
    try {
      const outcome = await deps.crm.completeTask(crmIdentity(sessionToken, deps), {
        commandKey: form.command_key ?? '',
        taskId: completeMatch[1]!,
        expectedRowVersion: form.expected_version ?? '',
      });
      if (outcome.ok) return crmRedirect(res, CRM_PORTAL_ROUTES.tasks, deps, sessionToken, outcome.disposition === 'replayed' ? 'replayed' : 'completed');
      if (outcome.kind === 'conflict') return crmRedirect(res, CRM_PORTAL_ROUTES.tasks, deps, sessionToken, 'conflict');
      if (outcome.kind === 'not_found') return crmRedirect(res, CRM_PORTAL_ROUTES.tasks, deps, sessionToken, 'missing');
      return sendHtml(res, outcome.kind === 'forbidden' ? 403 : outcome.kind === 'unavailable' ? 503 : 400,
        portalStatusPage(deps, sessionToken, {
          title: 'Task was not completed',
          message: outcome.kind === 'validation' ? 'Check the submitted values and refresh the task list.' : outcome.message,
          active: 'crm', backHref: CRM_PORTAL_ROUTES.tasks, backLabel: 'Return to tasks',
        }));
    } catch {
      return sendHtml(res, 503, portalStatusPage(deps, sessionToken, {
        title: 'CRM temporarily unavailable', message: 'The task was not changed.', active: 'crm', backHref: CRM_PORTAL_ROUTES.tasks, backLabel: 'Return to tasks',
      }));
    }
  }

  if (deps.kind === 'postgres') {
    return sendHtml(res, 404, portalStatusPage(deps, sessionToken, {
      title: 'Not available',
      message: 'That legacy portal feature is not part of this PostgreSQL workspace.',
      active: 'crm',
      backHref: CRM_PORTAL_ROUTES.contacts,
      backLabel: 'Return to CRM',
    }));
  }

  // The PostgreSQL branch returned above, so only the explicit local-demo
  // composition can reach JSON dashboards, billing and mock campaign runs.
  if (!tenantId) return redirect(res, '/portal/login?reason=session-ended', clearPortalCookie(deps.secure));

  if (p === '/portal' && method === 'GET') {
    const data = await deps.dashboard(tenantId);
    if (!data) return redirect(res, '/portal/login?reason=workspace-unavailable', clearPortalCookie(deps.secure)); // stale bridge
    const billing = deps.billing ? await deps.billing(tenantId) : null;
    return sendHtml(res, 200, dashboardPage(data, billing ?? undefined, {
      crmAvailable: !!deps.crm,
      csrfToken: portalCsrfToken(deps.sessionSecret, sessionToken),
    }));
  }

  if (p === '/portal/billing' && method === 'GET') {
    if (!deps.billing) return sendHtml(res, 404, '<h1>Billing not enabled</h1><p><a href="/portal">← dashboard</a></p>');
    const data = await deps.dashboard(tenantId);
    const billing = await deps.billing(tenantId);
    if (!billing) return redirect(res, '/portal');
    const notice = url.searchParams.get('need') ? 'A subscription is needed to run your marketing.'
      : url.searchParams.get('active') ? 'Use Manage billing for an existing subscription; Relaunch72 will not create a second one.'
      : url.searchParams.get('error') ? 'Something went wrong starting checkout — try again.' : undefined;
    return sendHtml(res, 200, billingPage(data?.tenant.name ?? 'Your business', billing, {
      canManage: !!deps.manageUrl,
      canSubscribe: !!deps.subscribeUrl,
      crmAvailable: !!deps.crm,
      csrfToken: portalCsrfToken(deps.sessionSecret, sessionToken),
      notice,
    }));
  }

  if (p === '/portal/subscribe' && method === 'POST') {
    if (!deps.subscribeUrl || !deps.billing) return redirect(res, '/portal/billing');
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Refresh needed', message: 'The secure form token was invalid. Checkout was not started.', active: 'billing', backHref: '/portal/billing', backLabel: 'Return to billing',
      }));
    }
    const plan = (form.plan ?? '').trim();
    const billing = await deps.billing(tenantId);
    if (billing?.active) return redirect(res, '/portal/billing?active=1');
    try {
      const to = await deps.subscribeUrl(plan, billing?.email ?? null);
      return redirect(res, to);
    } catch {
      return redirect(res, '/portal/billing?error=1');
    }
  }

  if (p === '/portal/manage' && method === 'POST') {
    if (!deps.manageUrl || !deps.billing) return redirect(res, '/portal/billing');
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Refresh needed', message: 'The secure form token was invalid. Billing was not opened.', active: 'billing', backHref: '/portal/billing', backLabel: 'Return to billing',
      }));
    }
    const billing = await deps.billing(tenantId);
    if (!billing?.customerId) return redirect(res, '/portal/billing');
    try {
      const to = await deps.manageUrl(billing.customerId);
      return redirect(res, to);
    } catch {
      return redirect(res, '/portal/billing?error=1');
    }
  }

  if (p === '/portal/run' && method === 'POST') {
    const form = await readForm(req);
    if (!verifyPortalCsrf(deps.sessionSecret, sessionToken, form._csrf)) {
      return sendHtml(res, 403, portalStatusPage(deps, sessionToken, {
        title: 'Refresh needed', message: 'The secure form token was invalid. No draft generation was started.',
      }));
    }
    // Soft gate: only block when billing is enforced AND the tenant isn't active.
    if (deps.billingEnforced && deps.billing) {
      const billing = await deps.billing(tenantId);
      if (!billing?.active) return redirect(res, '/portal/billing?need=1');
    }
    await deps.runTick(tenantId);
    return redirect(res, '/portal');
  }

  return sendHtml(res, 404, '<h1>Not found</h1><p><a href="/portal">← dashboard</a></p>');
  } finally {
    if (deps.abuse && abuseLeases.length) {
      await Promise.allSettled(abuseLeases.map(({ leaseHash, outcome }) =>
        deps.abuse!.complete(leaseHash, outcome)));
    }
  }
}
