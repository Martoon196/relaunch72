/**
 * Local, test-only Property Predator product preview.
 *
 * It serves process-local preview fixtures only: protected controls mutate
 * ephemeral TEST state, while no database, provider, message, social post,
 * payment or production service is touched.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appShell } from '../src/portal/ui.js';
import { createPropertyPredatorContentCatalogFixture } from '../src/portal/content-control-room-fixtures.js';
import {
  canonicalCompanyContentEmailDraft,
  COMPANY_CONTENT_EMAIL_DRAFT_MIME_TYPE,
  COMPANY_CONTENT_EMAIL_DRAFT_SCHEMA,
  type CompanyContentCatalogItem,
  type CompanyContentCatalogPage,
  type CompanyContentExactReview,
} from '../src/company-content-pg/index.js';
import {
  CONTENT_CONTROL_ROOM_ROUTE,
  presentContentControlRoom,
} from '../src/portal/content-control-room-presenter.js';
import { renderContentControlRoomBody } from '../src/portal/content-control-room-view.js';
import { BRAND_BRAIN_ROUTE } from '../src/portal/brand-brain-actions.js';
import { createPropertyPredatorBrandBrainFixture } from '../src/portal/brand-brain-fixtures.js';
import { presentBrandBrain } from '../src/portal/brand-brain-presenter.js';
import { renderBrandBrainBody } from '../src/portal/brand-brain-view.js';
import { planPropertyPredatorMarketingDraft } from '../src/company-content-adapter/property-predator-marketing-draft-plan.js';
import {
  CONTENT_APPROVAL_DECISION_ROUTE,
  CONTENT_APPROVAL_REQUEST_ROUTE,
  contentControlNoticeFromQuery,
  contentControlNoticeToken,
  type ContentControlNoticeCode,
} from '../src/portal/content-control-room-actions.js';
import { COMPANY_ASSETS_ROUTE } from '../src/portal/company-assets-actions.js';
import { presentCompanyAssets } from '../src/portal/company-assets-presenter.js';
import { renderCompanyAssetsBody } from '../src/portal/company-assets-view.js';
import {
  createPropertyPredatorCompanyAssetsReviewPreviewFixture,
  createPropertyPredatorCompanyContentReviewFixture,
  createPropertyPredatorCompanyContentReviewHrefs,
  PROPERTY_PREDATOR_REVIEW_FIXTURE_RELEASE_ITEM_ID,
} from '../src/portal/company-content-review-fixtures.js';
import { presentCompanyContentReview } from '../src/portal/company-content-review-presenter.js';
import {
  renderCompanyContentReviewBody,
  renderPortalCompanyContentReviewBody,
} from '../src/portal/company-content-review-view.js';
import type { PortalCompanyContentReviewSnapshot } from '../src/portal/company-content-service.js';
import {
  OWNED_SEED_CAMPAIGN_STAGE_ROUTE,
  OWNED_SEED_MESSAGE_APPROVAL_DECISION_ROUTE,
  OWNED_SEED_MESSAGE_APPROVAL_REQUEST_ROUTE,
  OWNED_SEED_MESSAGE_CREATE_ROUTE,
  type OwnedSeedWorkflowState,
} from '../src/portal/owned-seed-actions.js';
import {
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_BODY,
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM,
  PROPERTY_PREDATOR_OWNED_SEED_PROOF_SUBJECT,
} from '../src/portal/owned-seed-proof-email.js';
import {
  FOUNDER_PILOT_INSTIGATOR,
  FOUNDER_PILOT_POLICY_ASSET_VERSION,
  FOUNDER_PILOT_POLICY_CLAUSES,
  FOUNDER_PILOT_REVIEW_AUTHORITY,
  FOUNDER_PILOT_ROUTE_CLASSIFICATION,
  FOUNDER_PILOT_SENDER,
} from '../src/founder-email-pilot/policy-asset.js';
import { createPropertyPredatorTestInboxSnapshot } from '../src/portal/conversion-inbox-fixtures.js';
import {
  CONVERSION_INBOX_ROUTE,
  presentConversionInbox,
} from '../src/portal/conversion-inbox-presenter.js';
import { renderConversionInboxBody } from '../src/portal/conversion-inbox-view.js';
import {
  CONVERSION_INBOX_CREATE_DRAFT_ROUTE,
  conversionInboxNoticeFromQuery,
  conversionInboxNoticeToken,
  type ConversionInboxNoticeCode,
} from '../src/portal/conversion-inbox-actions.js';
import {
  CONTENT_CALENDAR_ROUTE,
  presentContentCalendar,
  type ContentCalendarSlotSnapshot,
  type ContentCalendarSnapshot,
} from '../src/portal/content-calendar-presenter.js';
import {
  createPropertyPredatorContentCalendarFixture,
  PROPERTY_PREDATOR_CONTENT_CALENDAR_AS_OF,
} from '../src/portal/content-calendar-fixtures.js';
import {
  renderContentCalendarBody,
  type ContentCalendarMutationView,
} from '../src/portal/content-calendar-view.js';
import {
  CAMPAIGN_WIZARD_CREATE_TEST_ROUTE,
  CAMPAIGN_WIZARD_ROUTE,
  campaignWizardNoticeFromQuery,
  campaignWizardNoticeToken,
  type CampaignWizardNoticeCode,
} from '../src/portal/campaign-wizard-actions.js';
import {
  presentCampaignWizard,
  type CampaignWizardSnapshot,
  type CampaignWizardTargetSnapshot,
} from '../src/portal/campaign-wizard-presenter.js';
import { renderCampaignWizardBody } from '../src/portal/campaign-wizard-view.js';
import {
  CAMPAIGN_MACHINE_ROUTE,
  presentCampaignMachine,
} from '../src/portal/campaign-machine-presenter.js';
import { createPropertyPredatorCampaignMachineFixture } from '../src/portal/campaign-machine-fixtures.js';
import { renderCampaignMachineBody } from '../src/portal/campaign-machine-view.js';
import { workspaceLocalDateTime } from '../src/portal/crm-pg-service.js';
import {
  SOCIAL_COMPOSER_ROUTE,
  presentSocialComposer,
} from '../src/portal/social-composer-presenter.js';
import {
  createPropertyPredatorSocialComposerFixture,
  PROPERTY_PREDATOR_SOCIAL_COMPOSER_AS_OF,
} from '../src/portal/social-composer-fixtures.js';
import { renderSocialComposerBody } from '../src/portal/social-composer-view.js';
import {
  IMAGE_STUDIO_ROUTE,
  presentImageStudio,
} from '../src/portal/image-studio-presenter.js';
import { createPropertyPredatorImageStudioFixture } from '../src/portal/image-studio-fixtures.js';
import { renderImageStudioBody } from '../src/portal/image-studio-view.js';
import {
  PROVIDER_CONNECTIONS_ROUTE,
  presentProviderConnections,
} from '../src/portal/provider-connections-presenter.js';
import { createPropertyPredatorProviderConnectionsFixture } from '../src/portal/provider-connections-fixtures.js';
import { renderProviderConnectionsBody } from '../src/portal/provider-connections-view.js';
import {
  PROVIDER_READINESS_COCKPIT_ROUTE,
  presentProviderReadinessCockpit,
} from '../src/portal/provider-readiness-cockpit-presenter.js';
import {
  LIVE_CHANNELS_PAUSE_ROUTE,
  LIVE_CHANNELS_ROUTE,
  presentLiveChannels,
} from '../src/portal/live-channels-presenter.js';
import { createPropertyPredatorLiveChannelsFixture } from '../src/portal/live-channels-fixtures.js';
import { renderLiveChannelsBody } from '../src/portal/live-channels-view.js';
import {
  liveChannelsNoticeFromQuery,
  liveChannelsNoticeToken,
} from '../src/portal/live-channels-actions.js';
import type { LiveChannelsSourceSnapshot } from '../src/portal/live-channels-presenter.js';
import { createPropertyPredatorProviderReadinessFixture } from '../src/portal/provider-readiness-cockpit-fixtures.js';
import { renderProviderReadinessCockpitBody } from '../src/portal/provider-readiness-cockpit-view.js';
import { createPropertyPredatorSocialAccountControlFixture } from '../src/portal/social-account-control-fixtures.js';
import {
  SOCIAL_ACCOUNT_CONTROL_ROUTE,
  presentSocialAccountControl,
} from '../src/portal/social-account-control-presenter.js';
import { renderSocialAccountControlBody } from '../src/portal/social-account-control-view.js';
import {
  PUBLIC_SOCIAL_CAMPAIGNS_ROUTE,
  presentPublicSocialCampaigns,
} from '../src/portal/public-social-campaigns-presenter.js';
import {
  createPropertyPredatorPublicSocialCampaignsFixture,
  PROPERTY_PREDATOR_PUBLIC_SOCIAL_CAMPAIGN_ID,
  PROPERTY_PREDATOR_PUBLIC_SOCIAL_CAMPAIGNS_AS_OF,
} from '../src/portal/public-social-campaigns-fixtures.js';
import { renderPublicSocialCampaignsBody } from '../src/portal/public-social-campaigns-view.js';
import {
  AUTOMATION_STUDIO_ROUTE,
  presentAutomationStudio,
} from '../src/portal/automation-studio-presenter.js';
import {
  createPropertyPredatorAutomationStudioFixture,
} from '../src/portal/automation-studio-fixtures.js';
import { renderAutomationStudioBody } from '../src/portal/automation-studio-view.js';
import {
  WEBINAR_STUDIO_ROUTE,
  presentWebinarStudio,
} from '../src/portal/webinar-studio-presenter.js';
import { createPropertyPredatorWebinarStudioFixture } from '../src/portal/webinar-studio-fixtures.js';
import { renderWebinarStudioBody } from '../src/portal/webinar-studio-view.js';
import {
  GROWTH_ANALYTICS_ROUTE,
  presentGrowthAnalytics,
} from '../src/portal/growth-analytics-presenter.js';
import { createPropertyPredatorGrowthAnalyticsFixture } from '../src/portal/growth-analytics-fixtures.js';
import { renderGrowthAnalyticsBody } from '../src/portal/growth-analytics-view.js';
import {
  OPERATOR_ACTION_CENTRE_ROUTE,
  presentOperatorActionCentre,
} from '../src/portal/operator-action-centre-presenter.js';
import { createPropertyPredatorOperatorActionCentreFixture } from '../src/portal/operator-action-centre-fixtures.js';
import { renderOperatorActionCentreBody } from '../src/portal/operator-action-centre-view.js';
import { createPropertyPredatorDailyOutreachFixture } from '../src/portal/daily-outreach-fixtures.js';
import {
  DAILY_OUTREACH_ROUTE,
  presentDailyOutreach,
} from '../src/portal/daily-outreach-presenter.js';
import { renderDailyOutreachBody } from '../src/portal/daily-outreach-view.js';
import { createPropertyPredatorAffiliateComplianceFixture } from '../src/portal/affiliate-compliance-fixtures.js';
import {
  AFFILIATE_COMPLIANCE_ROUTE,
  presentAffiliateCompliance,
} from '../src/portal/affiliate-compliance-presenter.js';
import { renderAffiliateComplianceBody } from '../src/portal/affiliate-compliance-view.js';
import { renderGrowthHomeBody } from '../src/portal/growth-home.js';
import { renderLead360Body, type Lead360View } from '../src/portal/lead-360-view.js';
import { JOURNEY_BOARD_CLIENT_SOURCE } from '../src/portal/journey-board-client.js';
import {
  CONTENT_CALENDAR_CLIENT_ROUTE,
  CONTENT_CALENDAR_CLIENT_SOURCE,
} from '../src/portal/content-calendar-client.js';
import {
  JOURNEY_BOARD_CLIENT_ROUTE,
  JOURNEY_BOARD_ROUTE,
  renderJourneyBoardBody,
  type JourneyBoardCardView,
  type JourneyBoardNoticeView,
  type JourneyBoardView,
} from '../src/portal/journey-board-view.js';
import {
  renderJourneyManagerBody,
  type JourneyManagerView,
} from '../src/portal/journey-manager-view.js';
import {
  renderCrmContactsBody,
  renderCrmPipelineBody,
  renderCrmTasksBody,
  type CrmWorkspaceSnapshot,
} from '../src/portal/crm-views.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import type { GrowthIntelligenceView } from '../src/portal/growth-intelligence.js';

const PORT = Number.parseInt(process.env.PROPERTY_PREDATOR_PREVIEW_PORT ?? '43172', 10);
const CONTACT_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_CONTACT_ID = '55555555-5555-4555-8555-555555555555';
const SNAPSHOT_AT = '2026-08-25T15:30:00.000Z';

const snapshot: CrmWorkspaceSnapshot = {
  workspace: {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Property Predator Launch',
    timezone: 'Europe/London',
    snapshotAt: SNAPSHOT_AT,
    canWrite: true,
  },
  contacts: [
    {
      id: CONTACT_ID, displayName: 'Amelia Hart', companyName: 'Hart Property Group',
      primaryEmail: 'amelia@example.test', primaryPhone: '+44 7700 900001', lifecycle: 'lead',
      openOpportunityCount: 1, nextTaskAt: '2026-08-25T16:30:00.000Z',
      lastActivityAt: '2026-08-25T15:18:00.000Z', createdAt: '2026-08-14T09:20:00.000Z',
    },
    {
      id: SECOND_CONTACT_ID, displayName: 'Marcus Reed', companyName: 'Reed Acquisitions',
      primaryEmail: 'marcus@example.test', primaryPhone: null, lifecycle: 'prospect',
      openOpportunityCount: 1, nextTaskAt: null, lastActivityAt: '2026-08-25T13:06:00.000Z',
      createdAt: '2026-08-19T11:42:00.000Z',
    },
    {
      id: '66666666-6666-4666-8666-666666666666', displayName: 'Priya Shah', companyName: null,
      primaryEmail: 'priya@example.test', primaryPhone: null, lifecycle: 'lead',
      openOpportunityCount: 0, nextTaskAt: null, lastActivityAt: '2026-08-24T10:00:00.000Z',
      createdAt: '2026-08-22T08:10:00.000Z',
    },
  ],
  stages: [
    { id: '77777777-7777-4777-8777-777777777777', name: 'New signal', position: 1, isClosed: false },
    { id: '88888888-8888-4888-8888-888888888888', name: 'Qualified', position: 2, isClosed: false },
    { id: '99999999-9999-4999-8999-999999999999', name: 'Proposal', position: 3, isClosed: false },
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Won', position: 4, isClosed: true },
  ],
  opportunities: [
    {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', contactId: CONTACT_ID, contactName: 'Amelia Hart',
      companyName: 'Hart Property Group', title: 'Apex annual membership',
      stageId: '99999999-9999-4999-8999-999999999999', valueMinor: 9900, currency: 'GBP',
      ownerName: 'Martin', expectedCloseDate: '2026-08-29', nextTaskAt: '2026-08-25T16:30:00.000Z',
      updatedAt: '2026-08-25T15:18:00.000Z', rowVersion: 4, moveCommandKey: 'preview-move-amelia',
    },
    {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', contactId: SECOND_CONTACT_ID, contactName: 'Marcus Reed',
      companyName: 'Reed Acquisitions', title: 'Agency pilot',
      stageId: '88888888-8888-4888-8888-888888888888', valueMinor: 250000, currency: 'GBP',
      ownerName: 'Martin', expectedCloseDate: '2026-09-08', nextTaskAt: null,
      updatedAt: '2026-08-25T13:06:00.000Z', rowVersion: 2, moveCommandKey: 'preview-move-marcus',
    },
  ],
  tasks: [
    {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', title: 'Review Amelia’s requested contact',
      status: 'open', contactName: 'Amelia Hart', opportunityTitle: 'Apex annual membership',
      assigneeName: 'Martin', dueAt: '2026-08-25T16:30:00.000Z', rowVersion: 2,
      completeCommandKey: 'preview-task-amelia',
    },
    {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', title: 'Prepare agency pilot discovery',
      status: 'open', contactName: 'Marcus Reed', opportunityTitle: 'Agency pilot', assigneeName: 'Martin',
      dueAt: '2026-08-26T09:00:00.000Z', rowVersion: 1, completeCommandKey: 'preview-task-marcus',
    },
  ],
  timeline: [
    { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', kind: 'stage_moved', summary: 'Apex annual moved to Proposal', actorName: 'Martin', occurredAt: '2026-08-25T15:18:00.000Z' },
    { id: '12121212-1212-4212-8212-121212121212', kind: 'lead_created', summary: 'Marcus Reed entered the CRM', actorName: null, occurredAt: '2026-08-25T13:06:00.000Z' },
  ],
};

const growth: GrowthIntelligenceView = {
  dataState: 'preview',
  asOf: SNAPSHOT_AT,
  windowLabel: 'Last 30 days · preview evidence',
  funnels: [
    {
      track: 'self_serve', label: 'Self-serve conversion',
      description: 'Captured identity to meaningful product use, priced intent and paid sale.',
      stages: [
        { key: 'lead', label: 'Lead', count: 184, stepConversionPercent: null, movedInWindow: 47 },
        { key: 'activated', label: 'Activated', count: 93, stepConversionPercent: 50.5, movedInWindow: 28 },
        { key: 'priced', label: 'Priced', count: 41, stepConversionPercent: 44.1, movedInWindow: 13 },
        { key: 'sale', label: 'Sale', count: 17, stepConversionPercent: 41.5, movedInWindow: 6 },
      ],
    },
    {
      track: 'agency', label: 'Agency LAPS',
      description: 'Named agency lead to appointment, presentation and collected sale.',
      stages: [
        { key: 'lead', label: 'Lead', count: 52, stepConversionPercent: null, movedInWindow: 11 },
        { key: 'appointment', label: 'Appointment', count: 24, stepConversionPercent: 46.2, movedInWindow: 7 },
        { key: 'presentation', label: 'Presentation', count: 13, stepConversionPercent: 54.2, movedInWindow: 4 },
        { key: 'sale', label: 'Sale', count: 5, stepConversionPercent: 38.5, movedInWindow: 2 },
      ],
    },
  ],
  hotLeads: [
    {
      contactId: CONTACT_ID, displayName: 'Amelia Hart', companyName: 'Hart Property Group',
      track: 'self_serve', stage: 'Priced', score: 55, band: 'hot',
      lastEvidence: { kind: 'reply', label: 'Requested a call', detail: 'Apex Annual offer', occurredAt: '2026-08-25T15:18:00.000Z' },
      contentSummary: 'Predator Briefing · 94%', offerSummary: 'Apex Annual · requested contact',
      nextMove: 'Review the requested contact and current permission before any outreach.',
    },
    {
      contactId: SECOND_CONTACT_ID, displayName: 'Marcus Reed', companyName: 'Reed Acquisitions',
      track: 'agency', stage: 'Appointment', score: 25, band: 'warm',
      lastEvidence: { kind: 'watched', label: 'Agency Partner Briefing', detail: '78% complete', occurredAt: '2026-08-25T13:06:00.000Z' },
      contentSummary: 'Agency Partner Briefing · 78%', offerSummary: null,
      nextMove: 'Prepare the discovery around the exact briefing sections Marcus completed.',
    },
  ],
  evidenceTotals: { contentStarted: 126, contentCompleted: 71, offersShown: 39, replies: 18, appointments: 11 },
};

const lead360: Lead360View = {
  identity: {
    contactId: CONTACT_ID, displayName: 'Amelia Hart', companyName: 'Hart Property Group',
    primaryEmail: 'amelia@example.test', primaryPhone: '+44 7700 900001', ownerName: 'Martin',
  },
  score: 55,
  scoreExplanation: 'Created an account · Completed analysis and the Predator Briefing · Reached pricing · Booked an appointment · Engagement 35 · Intent 20',
  primaryJourneyLabel: 'Self-serve conversion',
  journeys: [{
    label: 'Self-serve conversion', isPrimary: true, status: 'active',
    enrolledAt: '2026-08-14T09:20:00.000Z', lastEventAt: '2026-08-25T15:18:00.000Z', endedAt: null,
    score: {
      total: 55,
      explanation: 'Created an account · Completed analysis and the Predator Briefing · Reached pricing · Booked an appointment · Engagement 35 · Intent 20',
      sourceOccurredAt: '2026-08-25T15:18:00.000Z', evaluatedAt: '2026-08-25T15:18:02.000Z',
    },
    stages: [
      { key: 'lead', label: 'Lead', state: 'complete', reachedAt: '2026-08-14T09:20:00.000Z' },
      { key: 'activated', label: 'Activated', state: 'complete', reachedAt: '2026-08-19T14:02:00.000Z' },
      { key: 'priced', label: 'Priced', state: 'current', reachedAt: '2026-08-25T15:10:00.000Z' },
      { key: 'sale', label: 'Sale', state: 'upcoming', reachedAt: null },
    ],
  }, {
    label: 'Agency LAPS', status: 'active',
    enrolledAt: '2026-08-22T11:00:00.000Z', lastEventAt: '2026-08-25T15:24:00.000Z', endedAt: null,
    score: {
      total: 25,
      explanation: 'Booked a strategy appointment · Engagement 15 · Intent 10',
      sourceOccurredAt: '2026-08-25T15:24:00.000Z', evaluatedAt: '2026-08-25T15:24:01.000Z',
    },
    stages: [
      { key: 'lead', label: 'Lead', state: 'complete', reachedAt: '2026-08-22T11:00:00.000Z' },
      { key: 'appointment', label: 'Appointment', state: 'current', reachedAt: '2026-08-25T15:24:00.000Z' },
      { key: 'presentation', label: 'Presentation', state: 'upcoming', reachedAt: null },
      { key: 'sale', label: 'Sale', state: 'upcoming', reachedAt: null },
    ],
  }],
  journey: {
    label: 'Self-serve conversion',
    stages: [
      { key: 'lead', label: 'Lead', state: 'complete', reachedAt: '2026-08-14T09:20:00.000Z' },
      { key: 'activated', label: 'Activated', state: 'complete', reachedAt: '2026-08-19T14:02:00.000Z' },
      { key: 'priced', label: 'Priced', state: 'current', reachedAt: '2026-08-25T15:10:00.000Z' },
      { key: 'sale', label: 'Sale', state: 'upcoming', reachedAt: null },
    ],
  },
  evidence: [
    { id: '1', kind: 'reply', title: 'Requested a personal call', detail: 'Response to Apex Annual offer', percentage: null, occurredAt: '2026-08-25T15:18:00.000Z', sourceLabel: 'Offer response' },
    { id: '2', kind: 'offer', title: 'Apex Annual presented', detail: '£99.00 · pricing result', percentage: null, occurredAt: '2026-08-25T15:10:00.000Z', sourceLabel: 'Property Predator' },
    { id: '3', kind: 'watched', title: 'Predator Briefing replay', detail: '47 minutes consumed', percentage: 94, occurredAt: '2026-08-25T14:54:00.000Z', sourceLabel: 'Video' },
    { id: '4', kind: 'listened', title: 'Deal Stack audio lesson', detail: '18 minutes consumed', percentage: 100, occurredAt: '2026-08-24T18:21:00.000Z', sourceLabel: 'Audio' },
    { id: '5', kind: 'read', title: 'Funding the first acquisition', detail: 'Article completed', percentage: 100, occurredAt: '2026-08-23T11:43:00.000Z', sourceLabel: 'Academy' },
  ],
  nextMove: {
    label: 'Review the requested contact personally',
    reason: 'Amelia completed the core briefing, revisited pricing and explicitly requested contact. Check the saved channel permission before acting.',
    dueAt: '2026-08-25T16:30:00.000Z',
  },
  offers: [{
    id: 'offer-1', title: 'Apex Annual', valueLabel: '£99.00', state: 'requested_contact',
    presentedAt: '2026-08-25T15:10:00.000Z', responseAt: '2026-08-25T15:18:00.000Z',
    responseDetail: 'Requested contact',
  }],
  consent: [
    { channelLabel: 'Email · amelia@example.test', state: 'permitted', basis: 'Property Predator marketing · Consent · Verified endpoint', updatedAt: '2026-08-14T09:20:00.000Z', endpoint: 'amelia@example.test', contactPointId: '61616161-6161-4161-8161-616161616161', channel: 'email', purpose: 'property_predator_marketing', evidenceSource: 'founder.written_confirmation', policyVersion: 'pp-privacy-2026-08', policyTextSha256: 'b'.repeat(64), effectiveAt: '2026-08-14T09:20:00.000Z', recordedAt: '2026-08-14T09:20:04.000Z', recordedBy: '71717171-7171-4171-8171-717171717171', suppressionState: null, suppressionReason: null },
    { channelLabel: 'SMS · +44 7700 900001', state: 'unknown', basis: 'No verified permission evidence', updatedAt: null, endpoint: '+447700900001', contactPointId: '62626262-6262-4262-8262-626262626262', channel: 'sms', purpose: null, evidenceSource: null, policyVersion: null, policyTextSha256: null, effectiveAt: null, recordedAt: null, recordedBy: null, suppressionState: null, suppressionReason: null },
  ],
  suppressionReason: null,
  crm: {
    opportunities: [{ id: 'opp-1', title: 'Apex annual membership', stageLabel: 'Proposal', state: 'open', valueLabel: '£99.00' }],
    tasks: [{ id: 'task-1', title: 'Review Amelia’s requested contact', state: 'open', dueAt: '2026-08-25T16:30:00.000Z' }],
  },
  asOf: SNAPSHOT_AT,
};

const journeyManager: JourneyManagerView = {
  workspaceName: snapshot.workspace.name,
  asOf: SNAPSHOT_AT,
  state: 'ready',
  readinessTitle: 'Routes and scoring are active',
  readinessSummary: 'Both immutable v2 routes and the shared score model match the reviewed Property Predator foundation.',
  routes: [
    {
      slug: 'property-predator-self-serve', label: 'Property Predator self-serve conversion',
      description: 'Product-led conversion from an identified account through meaningful activation and offer exposure to an authoritative paid sale.',
      version: 2, state: 'active', enrollmentLabel: 'Account-led enrolment',
      milestones: [
        { key: 'lead', label: 'Lead', semantic: 'lead', isCompletion: false },
        { key: 'activated', label: 'Activated', semantic: 'activation', isCompletion: false },
        { key: 'priced', label: 'Priced', semantic: 'offer', isCompletion: false },
        { key: 'sale', label: 'Sale', semantic: 'sale', isCompletion: true },
      ],
      triggers: [
        { kind: 'event', sourceKey: 'identity.account.created', milestoneKey: 'lead', evidenceLabel: 'Account created' },
        { kind: 'event', sourceKey: 'product.analysis.completed', milestoneKey: 'activated', evidenceLabel: 'Analysis completed' },
        { kind: 'event', sourceKey: 'offer.presented', milestoneKey: 'priced', evidenceLabel: 'Offer presented' },
        { kind: 'commerce', sourceKey: 'payment_collected', milestoneKey: 'sale', evidenceLabel: 'Collected payment' },
      ],
    },
    {
      slug: 'property-predator-agency-laps', label: 'Property Predator agency LAPS',
      description: 'Sales-assisted Lead, Appointment, Presentation and Sale journey for agency and organisation opportunities.',
      version: 2, state: 'active', enrollmentLabel: 'Appointment-led enrolment',
      milestones: [
        { key: 'lead', label: 'Lead', semantic: 'lead', isCompletion: false },
        { key: 'appointment', label: 'Appointment', semantic: 'appointment', isCompletion: false },
        { key: 'presentation', label: 'Presentation', semantic: 'presentation', isCompletion: false },
        { key: 'sale', label: 'Sale', semantic: 'sale', isCompletion: true },
      ],
      triggers: [
        { kind: 'event', sourceKey: 'sales.appointment.booked', milestoneKey: 'appointment', evidenceLabel: 'Appointment booked' },
        { kind: 'event', sourceKey: 'sales.presentation.completed', milestoneKey: 'presentation', evidenceLabel: 'Presentation completed' },
        { kind: 'commerce', sourceKey: 'payment_collected', milestoneKey: 'sale', evidenceLabel: 'Collected payment' },
      ],
    },
  ],
  scoring: {
    label: 'Property Predator lead score', version: 2, state: 'active', ruleCount: 7,
    components: [
      { key: 'fit', label: 'Fit', maxPoints: 30, allocatedPoints: 0 },
      { key: 'engagement', label: 'Engagement', maxPoints: 35, allocatedPoints: 35 },
      { key: 'intent', label: 'Intent', maxPoints: 35, allocatedPoints: 35 },
    ],
    bands: [
      { key: 'quiet', label: 'Quiet', minScore: 0, maxScore: 21 },
      { key: 'warm', label: 'Warm', minScore: 22, maxScore: 44 },
      { key: 'hot', label: 'Hot', minScore: 45, maxScore: 69 },
      { key: 'burning', label: 'Burning', minScore: 70, maxScore: 100 },
    ],
    excludedSignals: ['Consent status', 'CRM stage', 'Task completion', 'Email opens'],
  },
  setup: { state: 'ready', canManage: true, postAction: '/portal/journeys/foundation' },
};

const PREVIEW_CSRF = 'preview-only-csrf-token-0000000000000000';
const PREVIEW_CONTENT_NOTICE_SECRET = 'preview-content-notice-secret';
const PREVIEW_CONTENT_NOTICE_SESSION = 'preview-content-session';
const PREVIEW_INBOX_NOTICE_SECRET = 'preview-inbox-notice-secret';
const PREVIEW_INBOX_NOTICE_SESSION = 'preview-inbox-session';
const PREVIEW_CAMPAIGN_NOTICE_SECRET = 'preview-campaign-notice-secret';
const PREVIEW_CAMPAIGN_NOTICE_SESSION = 'preview-campaign-session';
const PREVIEW_LIVE_CHANNELS_NOTICE_SECRET = 'preview-live-channels-notice-secret';
const PREVIEW_LIVE_CHANNELS_NOTICE_SESSION = 'preview-live-channels-session';

/**
 * Process-local, engage-only emergency-pause rehearsal. Engaging a pause
 * appends the EMERGENCY_PAUSED blocker code to the fictional rail and can
 * never be released from here; the mutated rails stay non-deliverable, so
 * the illustrative snapshot can never depict a live channel. No environment
 * switch, database or provider exists behind it.
 */
const PREVIEW_LIVE_COMPOSED_RAILS = Object.freeze(['customer_email', 'owned_social', 'whatsapp'] as const);
// WhatsApp carries the pre-engaged pause so customer email can illustrate the
// gated state, which is what the founder will actually see while an approval,
// permission, receipt or enqueue blocker remains. Both rails stay
// non-deliverable, so the invariant above still holds.
const previewLivePauseEngaged = new Set<string>(['whatsapp']);

function previewLiveChannelsSnapshot(): LiveChannelsSourceSnapshot {
  const data = structuredClone(createPropertyPredatorLiveChannelsFixture()) as any;
  for (const rail of data.rails) {
    if (previewLivePauseEngaged.has(rail.rail)
        && !rail.blockerCodes.includes('EMERGENCY_PAUSED')) {
      rail.blockerCodes = [...rail.blockerCodes, 'EMERGENCY_PAUSED'];
    }
    // Customer email illustrates the gated state: connected and healthy, held
    // only by the operator's permission-use receipt. That is exactly what a
    // founder meets until the compliance receipt rail is bound, and it is what
    // the truth correction exists to say out loud. The rail stays
    // non-deliverable, so the invariant above still holds.
    if (rail.rail === 'customer_email' && !previewLivePauseEngaged.has(rail.rail)) {
      rail.blockerCodes = [
        ...rail.blockerCodes.filter((code: string) => code !== 'EMERGENCY_PAUSED'),
        'OPERATOR_AUTHORITY_REQUIRED',
      ];
    }
  }
  return data as LiveChannelsSourceSnapshot;
}

function applyPreviewLivePause(form: URLSearchParams | null): 'pause_engaged' | 'pause_already' | 'invalid' {
  const scope = form?.get('scope') ?? '';
  const scopeAllowed = scope === 'all'
    || scope === 'customer_email'
    || scope === 'owned_social'
    || scope === 'whatsapp'
    || scope === 'sms'
    || scope === 'social_dm';
  if (!form || form.get('_csrf') !== PREVIEW_CSRF
      || form.get('confirm_pause') !== 'ENGAGE' || !scopeAllowed) {
    return 'invalid';
  }
  const targets = scope === 'all' ? [...PREVIEW_LIVE_COMPOSED_RAILS] : [scope];
  const engaged = targets.filter((target) => {
    if (previewLivePauseEngaged.has(target)) return false;
    previewLivePauseEngaged.add(target);
    return true;
  });
  return engaged.length > 0 ? 'pause_engaged' : 'pause_already';
}
const PREVIEW_CALENDAR_RESCHEDULE_ROUTE = '/portal/content/calendar/test-planning-targets/reschedule';
const PREVIEW_CALENDAR_CANCEL_ROUTE = '/portal/content/calendar/test-planning-targets/cancel';
const PREVIEW_CALENDAR_CAMPAIGN_REVISION_KEY = 'property-predator-signal-sprint:r3';
const PREVIEW_OWNED_SEED_MESSAGE_ID = '86000000-0000-4000-8000-000000000002';
const PREVIEW_OWNED_SEED_MESSAGE_VERSION_ID = '87000000-0000-4000-8000-000000000002';
const PREVIEW_OWNED_SEED_APPROVAL_REQUEST_ID = '88000000-0000-4000-8000-000000000002';
const PREVIEW_OWNED_SEED_WORKFLOW_TOKEN = `${'a'.repeat(48)}.${'b'.repeat(43)}`;
let previewOwnedSeedWorkflow: OwnedSeedWorkflowState | undefined;

function previewExactPayload(item: CompanyContentCatalogItem): Readonly<{
  canonicalContent: string;
  contentMimeType: string;
  email: CompanyContentExactReview['email'];
  contentSha256: string;
  blobSha256: string;
}> {
  const ownedSeed = item.source.itemId === PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM;
  const subject = ownedSeed
    ? PROPERTY_PREDATOR_OWNED_SEED_PROOF_SUBJECT
    : `${item.title} — preview`;
  const bodyText = ownedSeed
    ? PROPERTY_PREDATOR_OWNED_SEED_PROOF_BODY
    : `Fictional local-preview copy for ${item.title}.\n\nNo customer, affiliate or provider data is present.`;
  const canonicalContent = item.kind === 'email'
    ? canonicalCompanyContentEmailDraft(subject, bodyText)
    : JSON.stringify({
        body: bodyText,
        schema: 'propertypredator.local-preview-content/v1',
        title: item.title,
      });
  return Object.freeze({
    canonicalContent,
    contentMimeType: item.kind === 'email'
      ? COMPANY_CONTENT_EMAIL_DRAFT_MIME_TYPE
      : 'application/json',
    email: item.kind === 'email' ? Object.freeze({
      schema: COMPANY_CONTENT_EMAIL_DRAFT_SCHEMA,
      subject,
      bodyText,
      subjectSha256: createHash('sha256').update(subject, 'utf8').digest('hex'),
      bodySha256: createHash('sha256').update(bodyText, 'utf8').digest('hex'),
    }) : null,
    contentSha256: createHash('sha256').update(canonicalContent, 'utf8').digest('hex'),
    blobSha256: createHash('sha256').update(`preview-blob:${canonicalContent}`, 'utf8').digest('hex'),
  });
}

function createPreviewContentCatalog(): CompanyContentCatalogPage {
  const source = createPropertyPredatorContentCatalogFixture();
  return Object.freeze({
    ...source,
    items: Object.freeze(source.items.map((sourceItem, index) => {
      const item = index === 1 ? Object.freeze({
        ...sourceItem,
        source: Object.freeze({
          ...sourceItem.source,
          itemId: PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM,
        }),
      }) : sourceItem;
      const payload = previewExactPayload(item);
      return Object.freeze({
        ...item,
        contentMimeType: payload.contentMimeType,
        contentSha256: payload.contentSha256,
        blobSha256: payload.blobSha256,
      });
    })),
  });
}

let previewContentCatalog = createPreviewContentCatalog();
let previewInboxSnapshot = createPropertyPredatorTestInboxSnapshot();

const PREVIEW_CAMPAIGN_TARGETS = Object.freeze([
  Object.freeze({
    targetId: 'a7000000-0000-4000-8000-000000000001',
    network: 'linkedin',
    targetLabel: 'LinkedIn TEST rail',
    planningEnabled: true,
    environment: 'test',
    providerEffects: 'none',
  }),
  Object.freeze({
    targetId: 'a7000000-0000-4000-8000-000000000002',
    network: 'instagram',
    targetLabel: 'Instagram TEST rail',
    planningEnabled: true,
    environment: 'test',
    providerEffects: 'none',
  }),
  Object.freeze({
    targetId: 'a7000000-0000-4000-8000-000000000003',
    network: 'facebook',
    targetLabel: 'Facebook TEST rail',
    planningEnabled: true,
    environment: 'test',
    providerEffects: 'none',
  }),
  Object.freeze({
    targetId: 'a7000000-0000-4000-8000-000000000004',
    network: 'x',
    targetLabel: 'X TEST rail',
    planningEnabled: true,
    environment: 'test',
    providerEffects: 'none',
  }),
] satisfies readonly CampaignWizardTargetSnapshot[]);

type PreviewPlanningState = NonNullable<ContentCalendarSlotSnapshot['planning']>['planningState'];
type PreviewRevalidationState = NonNullable<ContentCalendarSlotSnapshot['planning']>['revalidationState'];

interface PreviewCampaignTargetState {
  readonly slotId: string;
  readonly campaignId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly campaignTitle: string;
  readonly objective: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly intentId: string;
  readonly intentSha256: string;
  readonly targetId: string;
  readonly targetLabel: string;
  readonly channel: CampaignWizardTargetSnapshot['network'];
  readonly desiredFor: string;
  readonly planningState: PreviewPlanningState;
  readonly revalidationState: PreviewRevalidationState;
  readonly nextRevalidationAt: string | null;
  readonly updatedAt: string;
  readonly version: number;
}

export interface PreviewCampaignActionResult {
  readonly ok: boolean;
  readonly code: CampaignWizardNoticeCode;
  readonly message: string;
  readonly intentId?: string;
  readonly targetId?: string;
}

const previewCampaignTargets = new Map<string, PreviewCampaignTargetState>();
const previewCampaignHistory: PreviewCampaignTargetState[] = [];
const previewCampaignCommandResults = new Map<string, PreviewCampaignActionResult>();

function previewSha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function previewNextRevalidationAt(desiredFor: string): string | null {
  const time = new Date(desiredFor).getTime();
  return Number.isFinite(time) ? new Date(time - 30 * 60_000).toISOString() : null;
}

function cleanPreviewText(value: string | null, maximum: number): string | null {
  const clean = (value ?? '').trim();
  return clean && clean.length <= maximum
    && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(clean)
    ? clean
    : null;
}

function previewPlanningTarget(intentId: string, targetId: string): PreviewCampaignTargetState | undefined {
  return [...previewCampaignTargets.values()].find((state) => (
    state.intentId === intentId && state.targetId === targetId
  ));
}

function previewCreateCommandKey(): string {
  return `preview-campaign-create:${randomUUID()}`;
}

function previewRescheduleCommandKey(state: PreviewCampaignTargetState): string {
  return `preview-calendar-reschedule:${state.intentId}:${state.targetId}:v${state.version}`;
}

function previewCancelCommandKey(state: PreviewCampaignTargetState): string {
  return `preview-calendar-cancel:${state.intentId}:${state.targetId}:v${state.version}`;
}

/** Reset only the process-local showcase state. No database or provider exists behind it. */
export function resetPreviewCampaignState(): void {
  previewCampaignTargets.clear();
  previewCampaignHistory.length = 0;
  previewCampaignCommandResults.clear();
  const fixture = createPropertyPredatorContentCalendarFixture();
  const seededSlot = fixture.slots.find((slot) => slot.slotId === '91000000-0000-4000-8000-000000000002');
  const target = PREVIEW_CAMPAIGN_TARGETS[1];
  if (!seededSlot || !target) throw new Error('Property Predator preview planning seed is incomplete');
  const intentId = 'd1000000-0000-4000-8000-000000000001';
  previewCampaignTargets.set(seededSlot.slotId, Object.freeze({
    slotId: seededSlot.slotId,
    campaignId: PROPERTY_PREDATOR_PUBLIC_SOCIAL_CAMPAIGN_ID,
    revisionId: 'a2000000-0000-4000-8000-000000000003',
    revisionNumber: 3,
    campaignTitle: 'Property Predator Signal Sprint',
    objective: seededSlot.objectiveLabel,
    contentItemId: seededSlot.contentItemId,
    contentVersionId: seededSlot.contentVersionId,
    contentSha256: seededSlot.contentSha256,
    intentId,
    intentSha256: previewSha({ intentId, targetId: target.targetId, desiredFor: seededSlot.scheduledFor }),
    targetId: target.targetId,
    targetLabel: target.targetLabel,
    channel: target.network,
    desiredFor: seededSlot.scheduledFor,
    planningState: 'awaiting_revalidation',
    revalidationState: 'waiting_for_window',
    nextRevalidationAt: previewNextRevalidationAt(seededSlot.scheduledFor),
    updatedAt: '2026-08-27T08:42:00.000Z',
    version: 1,
  }));
}

/** Safe evidence projection used by the preview regression test. */
export function previewCampaignStateForTest(): Readonly<{
  active: readonly PreviewCampaignTargetState[];
  history: readonly PreviewCampaignTargetState[];
}> {
  return Object.freeze({
    active: Object.freeze([...previewCampaignTargets.values()].map((state) => Object.freeze({ ...state }))),
    history: Object.freeze(previewCampaignHistory.map((state) => Object.freeze({ ...state }))),
  });
}

function previewCampaignWizardSnapshot(): CampaignWizardSnapshot {
  const approval = (status: typeof previewContentCatalog.items[number]['approvalStatus']) => {
    if (status === 'approved' || status === 'pending' || status === 'rejected' || status === 'changes_requested') {
      return status;
    }
    return 'unavailable' as const;
  };
  const option = (item: typeof previewContentCatalog.items[number]) => Object.freeze({
    contentItemId: item.contentItemId,
    contentVersionId: item.contentVersionId,
    contentSha256: item.contentSha256,
    title: item.title,
    versionNumber: item.versionNumber,
    kindLabel: item.kind.replaceAll('_', ' '),
    approvalStatus: approval(item.approvalStatus),
    sourceFresh: item.sourceFresh,
    publishable: item.publishable,
  });
  return Object.freeze({
    content: Object.freeze(previewContentCatalog.items.filter((item) => item.kind === 'social_post').map(option)),
    media: Object.freeze(previewContentCatalog.items.filter((item) => item.kind === 'image' || item.kind === 'video').map(option)),
    targets: PREVIEW_CAMPAIGN_TARGETS,
    sourceTruncated: false,
  });
}

function previewCalendarSlot(
  state: PreviewCampaignTargetState,
  base: ContentCalendarSlotSnapshot | undefined,
): ContentCalendarSlotSnapshot | null {
  const item = previewContentCatalog.items.find((candidate) => candidate.contentVersionId === state.contentVersionId);
  if (!item) return null;
  return Object.freeze({
    slotId: state.slotId,
    contentItemId: state.contentItemId,
    contentVersionId: state.contentVersionId,
    contentSha256: state.contentSha256,
    scheduledFor: state.desiredFor,
    channel: state.channel,
    variantLabel: base?.variantLabel ?? `${state.campaignTitle} · ${state.targetLabel}`,
    objectiveLabel: state.objective,
    ownerLabel: base?.ownerLabel ?? 'Growth HQ preview desk',
    plannerState: base?.plannerState ?? 'draft',
    executionMode: 'simulated',
    publicSocial: base?.publicSocial,
    planning: Object.freeze({
      intentId: state.intentId,
      intentSha256: state.intentSha256,
      targetId: state.targetId,
      desiredFor: state.desiredFor,
      planningState: state.planningState,
      revalidationState: state.revalidationState,
      nextRevalidationAt: state.nextRevalidationAt,
      updatedAt: state.updatedAt,
      environment: 'test',
      providerEffects: 'none',
    }),
  });
}

/** Rebuild the page from process-local state so GET-after-POST and reload agree. */
export function createPersistentPreviewContentCalendar(): ContentCalendarSnapshot {
  const base = createPropertyPredatorContentCalendarFixture();
  const loaded = new Set<string>();
  const slots: ContentCalendarSlotSnapshot[] = [];
  for (const baseSlot of base.slots) {
    const state = previewCampaignTargets.get(baseSlot.slotId);
    if (!state) {
      slots.push(baseSlot);
      continue;
    }
    loaded.add(state.slotId);
    const projected = previewCalendarSlot(state, baseSlot);
    if (projected) slots.push(projected);
  }
  for (const state of previewCampaignTargets.values()) {
    if (loaded.has(state.slotId)) continue;
    const projected = previewCalendarSlot(state, undefined);
    if (projected) slots.push(projected);
  }
  return Object.freeze({
    catalog: previewContentCatalog,
    slots: Object.freeze(slots),
    sourceTruncated: false,
  });
}

function previewCalendarMutations(url: URL): ContentCalendarMutationView {
  const eligibleContent = previewContentCatalog.items.filter((item) => item.publishable);
  const slotActions: Record<string, NonNullable<ContentCalendarMutationView['slots']>[string]> = {};
  for (const state of previewCampaignTargets.values()) {
    const current = state.planningState !== 'cancelled' && state.planningState !== 'superseded';
    slotActions[state.slotId] = Object.freeze({
      intentId: state.intentId,
      targetId: state.targetId,
      intentSha256: state.intentSha256,
      expectedUpdatedAt: state.updatedAt,
      reschedule: current ? Object.freeze({
        actionUrl: PREVIEW_CALENDAR_RESCHEDULE_ROUTE,
        csrfToken: PREVIEW_CSRF,
        commandKey: previewRescheduleCommandKey(state),
      }) : undefined,
      cancel: current ? Object.freeze({
        actionUrl: PREVIEW_CALENDAR_CANCEL_ROUTE,
        csrfToken: PREVIEW_CSRF,
        commandKey: previewCancelCommandKey(state),
      }) : undefined,
      jitStatus: state.planningState === 'cancelled'
        ? Object.freeze({
          state: 'cancelled', label: 'TEST target cancelled',
          detail: 'This exact process-local target is stopped. No provider was called.',
          nextRevalidationAt: null,
        })
        : Object.freeze({
          state: 'current', label: 'JIT source check waiting',
          detail: 'The local showcase will re-check the exact source close to the desired TEST time.',
          nextRevalidationAt: state.nextRevalidationAt,
        }),
    });
  }
  const outcome = campaignWizardNoticeFromQuery(
    url.searchParams,
    PREVIEW_CAMPAIGN_NOTICE_SECRET,
    PREVIEW_CAMPAIGN_NOTICE_SESSION,
  );
  return Object.freeze({
    create: Object.freeze({
      actionUrl: CAMPAIGN_WIZARD_CREATE_TEST_ROUTE,
      csrfToken: PREVIEW_CSRF,
      commandKey: previewCreateCommandKey(),
      campaignRevisions: Object.freeze([Object.freeze({
        value: PREVIEW_CALENDAR_CAMPAIGN_REVISION_KEY,
        label: 'Property Predator Signal Sprint · revision 3',
        detail: 'TEST planning only',
      })]),
      contentVersions: Object.freeze(eligibleContent.map((item) => Object.freeze({
        value: item.contentVersionId,
        label: item.title,
        detail: `immutable v${item.versionNumber}`,
      }))),
      targets: Object.freeze(PREVIEW_CAMPAIGN_TARGETS.map((target) => Object.freeze({
        value: target.targetId,
        label: target.targetLabel,
        detail: `${target.network} · provider effects none`,
      }))),
    }),
    slots: Object.freeze(slotActions),
    outcome,
  });
}

function previewCommandReplay(commandKey: string | null): PreviewCampaignActionResult | null {
  if (!commandKey) return null;
  const prior = previewCampaignCommandResults.get(commandKey);
  return prior ? Object.freeze({
    ...prior,
    code: 'replayed',
    message: 'This exact local TEST command was already applied; no duplicate state was created.',
  }) : null;
}

function previewCampaignInvalid(message: string): PreviewCampaignActionResult {
  return Object.freeze({ ok: false, code: 'invalid', message });
}

/** Apply a TEST-only campaign create form to in-memory preview state. */
export function applyPreviewCampaignCreate(form: URLSearchParams | null): PreviewCampaignActionResult {
  if (!form || form.get('_csrf') !== PREVIEW_CSRF || form.get('environment') !== 'test') {
    return previewCampaignInvalid('The local TEST campaign form was incomplete. Nothing changed.');
  }
  const commandKey = form.get('command_key');
  const replay = previewCommandReplay(commandKey);
  if (replay) return replay;
  if (!commandKey?.startsWith('preview-campaign-create:') || commandKey.length > 200) {
    return previewCampaignInvalid('The local TEST campaign command key was invalid. Nothing changed.');
  }
  const contentVersionId = form.get('content_version_id') ?? '';
  const content = previewContentCatalog.items.find((item) => (
    item.contentVersionId === contentVersionId && item.kind === 'social_post' && item.publishable
  ));
  const targetIds = [...new Set(form.getAll('target_ids'))];
  const targets = targetIds.map((id) => PREVIEW_CAMPAIGN_TARGETS.find((target) => target.targetId === id));
  const mediaIds = [...new Set(form.getAll('media_version_ids'))];
  const mediaValid = mediaIds.length <= 10 && mediaIds.every((id) => previewContentCatalog.items.some((item) => (
    item.contentVersionId === id && (item.kind === 'image' || item.kind === 'video') && item.publishable
  )));
  const maxAttempts = Number(form.get('max_attempts') ?? '1');
  const fromCalendar = form.get('campaign_revision_key') === PREVIEW_CALENDAR_CAMPAIGN_REVISION_KEY;
  const title = fromCalendar
    ? 'Property Predator Signal Sprint'
    : cleanPreviewText(form.get('title'), 160);
  const objective = fromCalendar
    ? 'Rehearse the exact approved Property Predator signal across owned TEST rails.'
    : cleanPreviewText(form.get('objective'), 1_000);
  let desiredFor = '';
  try {
    if (form.get('timezone') !== snapshot.workspace.timezone) throw new Error('timezone mismatch');
    desiredFor = workspaceLocalDateTime(form.get('desired_for_local') ?? '', snapshot.workspace.timezone);
  } catch {
    return previewCampaignInvalid('Choose a real, unambiguous Property Predator workspace time. Nothing changed.');
  }
  if (!content || !title || !objective || targetIds.length === 0 || targetIds.length > 20
      || targets.some((target) => !target) || !mediaValid
      || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3
      || form.get('confirm_test_only') !== 'confirmed') {
    return previewCampaignInvalid('Choose eligible approved copy, owned TEST targets and confirm the TEST boundary.');
  }

  const campaignId = randomUUID();
  const revisionId = randomUUID();
  const intentId = randomUUID();
  const createdAt = new Date().toISOString();
  const intentSha256 = previewSha({
    campaignId, revisionId, contentVersionId, targetIds, mediaIds, desiredFor, maxAttempts,
  });
  for (const target of targets) {
    if (!target) continue;
    const slotId = randomUUID();
    previewCampaignTargets.set(slotId, Object.freeze({
      slotId,
      campaignId,
      revisionId,
      revisionNumber: 1,
      campaignTitle: title,
      objective,
      contentItemId: content.contentItemId,
      contentVersionId: content.contentVersionId,
      contentSha256: content.contentSha256,
      intentId,
      intentSha256,
      targetId: target.targetId,
      targetLabel: target.targetLabel,
      channel: target.network,
      desiredFor,
      planningState: 'awaiting_revalidation',
      revalidationState: 'waiting_for_window',
      nextRevalidationAt: previewNextRevalidationAt(desiredFor),
      updatedAt: createdAt,
      version: 1,
    }));
  }
  const result = Object.freeze({
    ok: true,
    code: 'planned' as const,
    message: 'Durable process-local TEST campaign created. Refresh the calendar to see it; no provider was called.',
    intentId,
  });
  previewCampaignCommandResults.set(commandKey, result);
  return result;
}

/** Append reschedule evidence and replace only the current preview projection. */
export function applyPreviewCampaignReschedule(form: URLSearchParams | null): PreviewCampaignActionResult {
  if (!form || form.get('_csrf') !== PREVIEW_CSRF || form.get('environment') !== 'test') {
    return previewCampaignInvalid('The local TEST reschedule form was incomplete. Nothing changed.');
  }
  const commandKey = form.get('command_key');
  const replay = previewCommandReplay(commandKey);
  if (replay) return replay;
  const state = previewPlanningTarget(form.get('intent_id') ?? '', form.get('target_id') ?? '');
  const reason = cleanPreviewText(form.get('reason'), 500);
  let desiredFor = '';
  try {
    desiredFor = workspaceLocalDateTime(form.get('desired_for_local') ?? '', snapshot.workspace.timezone);
  } catch {
    return previewCampaignInvalid('Choose a real, unambiguous Property Predator workspace time. Nothing changed.');
  }
  if (!state || !commandKey || commandKey !== previewRescheduleCommandKey(state)
      || form.get('intent_sha256') !== state.intentSha256
      || form.get('expected_updated_at') !== state.updatedAt
      || form.get('confirm_change') !== 'confirmed' || !reason
      || state.planningState === 'cancelled' || state.planningState === 'superseded') {
    return previewCampaignInvalid('The TEST target changed or the reschedule evidence was incomplete. Refresh first.');
  }
  previewCampaignHistory.push(Object.freeze({ ...state, planningState: 'superseded' }));
  const successorIntentId = randomUUID();
  const updatedAt = new Date().toISOString();
  const successor = Object.freeze({
    ...state,
    intentId: successorIntentId,
    intentSha256: previewSha({ predecessor: state.intentId, successorIntentId, targetId: state.targetId, desiredFor, reason }),
    desiredFor,
    planningState: 'awaiting_revalidation' as const,
    revalidationState: 'waiting_for_window' as const,
    nextRevalidationAt: previewNextRevalidationAt(desiredFor),
    updatedAt,
    version: state.version + 1,
  });
  previewCampaignTargets.set(state.slotId, successor);
  const result = Object.freeze({
    ok: true,
    code: 'rescheduled' as const,
    message: 'New process-local TEST time saved. Refresh confirms it; no provider was called.',
    intentId: successorIntentId,
    targetId: state.targetId,
  });
  previewCampaignCommandResults.set(commandKey, result);
  return result;
}

/** Cancel one exact process-local TEST target. External systems are unreachable. */
export function applyPreviewCampaignCancel(form: URLSearchParams | null): PreviewCampaignActionResult {
  if (!form || form.get('_csrf') !== PREVIEW_CSRF || form.get('environment') !== 'test') {
    return previewCampaignInvalid('The local TEST cancellation form was incomplete. Nothing changed.');
  }
  const commandKey = form.get('command_key');
  const replay = previewCommandReplay(commandKey);
  if (replay) return replay;
  const state = previewPlanningTarget(form.get('intent_id') ?? '', form.get('target_id') ?? '');
  const reason = cleanPreviewText(form.get('reason'), 500);
  if (!state || !commandKey || commandKey !== previewCancelCommandKey(state)
      || form.get('intent_sha256') !== state.intentSha256
      || form.get('expected_updated_at') !== state.updatedAt
      || form.get('confirm_cancel') !== 'confirmed' || !reason
      || state.planningState === 'cancelled' || state.planningState === 'superseded') {
    return previewCampaignInvalid('The TEST target changed or the cancellation evidence was incomplete. Refresh first.');
  }
  previewCampaignHistory.push(state);
  const cancelled = Object.freeze({
    ...state,
    planningState: 'cancelled' as const,
    nextRevalidationAt: null,
    updatedAt: new Date().toISOString(),
    version: state.version + 1,
  });
  previewCampaignTargets.set(state.slotId, cancelled);
  const result = Object.freeze({
    ok: true,
    code: 'cancelled' as const,
    message: 'Exact process-local TEST target cancelled. Refresh confirms it; no provider was called.',
    intentId: state.intentId,
    targetId: state.targetId,
  });
  previewCampaignCommandResults.set(commandKey, result);
  return result;
}

resetPreviewCampaignState();

function updatePreviewInboxDraft(
  predicate: (messageId: string | null, approvalRequestId: string | null) => boolean,
  update: (draft: typeof previewInboxSnapshot.threads[number]['draft']) => typeof previewInboxSnapshot.threads[number]['draft'],
): boolean {
  let applied = false;
  previewInboxSnapshot = {
    ...previewInboxSnapshot,
    threads: previewInboxSnapshot.threads.map((thread) => {
      if (!predicate(thread.draft.messageId, thread.draft.approvalRequestId)) return thread;
      const nextDraft = update(thread.draft);
      if (nextDraft === thread.draft) return thread;
      applied = true;
      return Object.freeze({ ...thread, draft: Object.freeze(nextDraft) });
    }),
  };
  return applied;
}

function revisePreviewInboxDraft(messageId: string, body: string, expectedRowVersion: string): boolean {
  const cleanBody = body.trim();
  if (!cleanBody || Buffer.byteLength(cleanBody, 'utf8') > 8_192) return false;
  return updatePreviewInboxDraft(
    (candidate) => candidate === messageId,
    (draft) => {
      if (draft.lifecycle !== 'draft' || String(draft.rowVersion) !== expectedRowVersion) return draft;
      return {
        ...draft,
        body: cleanBody,
        versionNumber: (draft.versionNumber ?? 0) + 1,
        rowVersion: (draft.rowVersion ?? 0) + 1,
        approvalState: 'not_requested' as const,
        approvalRequestId: null,
        approvalNote: null,
        updatedAt: new Date().toISOString(),
      };
    },
  );
}

function requestPreviewInboxApproval(messageId: string, expectedRowVersion: string): boolean {
  return updatePreviewInboxDraft(
    (candidate) => candidate === messageId,
    (draft) => {
      if (draft.lifecycle !== 'draft' || String(draft.rowVersion) !== expectedRowVersion) return draft;
      const suffix = messageId.slice(-12);
      return {
        ...draft,
        lifecycle: 'approval_pending' as const,
        approvalState: 'pending' as const,
        approvalRequestId: `80000000-0000-4000-8000-${suffix}`,
        approvalNote: 'Waiting for a preview workspace reviewer.',
        rowVersion: (draft.rowVersion ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };
    },
  );
}

function decidePreviewInboxApproval(
  approvalRequestId: string,
  decision: 'approved' | 'rejected' | 'changes_requested',
  decisionNote: string,
): boolean {
  if (decision !== 'approved' && decisionNote.trim().length === 0) return false;
  return updatePreviewInboxDraft(
    (_messageId, candidate) => candidate === approvalRequestId,
    (draft) => {
      if (draft.approvalState !== 'pending') return draft;
      return {
        ...draft,
        lifecycle: decision === 'approved' ? 'approved' as const : 'draft' as const,
        approvalState: decision,
        approvalNote: decisionNote.trim() || 'Approved for the preview TEST queue only.',
        rowVersion: (draft.rowVersion ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };
    },
  );
}

function queuePreviewInboxTestOperation(
  messageId: string,
  expectedRowVersion: string,
  purpose: string,
): boolean {
  if (!['property_predator_follow_up', 'appointment_follow_up'].includes(purpose)) return false;
  const thread = previewInboxSnapshot.threads.find((candidate) => candidate.draft.messageId === messageId);
  if (!thread) return false;
  const requiredConsentChannel = thread.conversationId
    ? ((previewInboxSnapshot.page.conversations.find((item) => item.conversationId === thread.conversationId)?.channel
      ?? 'email') as 'email' | 'sms' | 'whatsapp' | 'instagram' | 'facebook')
    : 'email';
  const consentChannel = requiredConsentChannel === 'instagram' || requiredConsentChannel === 'facebook'
    ? 'social' : requiredConsentChannel;
  if (!thread.consents.some((consent) => consent.channel === consentChannel && consent.state === 'permitted')) {
    return false;
  }
  return updatePreviewInboxDraft(
    (candidate) => candidate === messageId,
    (draft) => {
      if (draft.lifecycle !== 'approved' || draft.approvalState !== 'approved'
          || draft.deliveryState !== 'not_queued'
          || String(draft.rowVersion) !== expectedRowVersion
          || draft.purpose !== purpose) return draft;
      return {
        ...draft,
        deliveryState: 'queued' as const,
        rowVersion: (draft.rowVersion ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };
    },
  );
}

function requestPreviewContentApproval(contentItemId: string, contentVersionId: string): boolean {
  let applied = false;
  previewContentCatalog = {
    ...previewContentCatalog,
    items: previewContentCatalog.items.map((item) => {
      if (item.contentItemId !== contentItemId || item.contentVersionId !== contentVersionId
          || !['unrequested', 'rejected', 'changes_requested', 'stale'].includes(item.approvalStatus)) return item;
      applied = true;
      return Object.freeze({
        ...item,
        approvalRequestId: randomUUID(),
        approvalDecisionId: null,
        approvalStatus: 'pending' as const,
        approvalStale: false,
        publishable: false,
      });
    }),
  };
  return applied;
}

function decidePreviewContentApproval(
  approvalRequestId: string,
  decision: 'approved' | 'rejected' | 'changes_requested',
  decisionNote: string,
): boolean {
  if (decision !== 'approved' && decisionNote.trim().length === 0) return false;
  let applied = false;
  previewContentCatalog = {
    ...previewContentCatalog,
    items: previewContentCatalog.items.map((item) => {
      if (item.approvalRequestId !== approvalRequestId || item.approvalStatus !== 'pending') return item;
      applied = true;
      return Object.freeze({
        ...item,
        approvalDecisionId: randomUUID(),
        approvalStatus: decision,
        approvalStale: false,
        publishable: decision === 'approved' && item.sourceFresh,
      });
    }),
  };
  return applied;
}
const NEW_SIGNAL_STAGE = '77777777-7777-4777-8777-777777777777';
const QUALIFIED_STAGE = '88888888-8888-4888-8888-888888888888';
const PROPOSAL_STAGE = '99999999-9999-4999-8999-999999999999';
const WON_STAGE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const previewBoardBase: readonly JourneyBoardCardView[] = [
  {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', contactId: CONTACT_ID, laneId: PROPOSAL_STAGE,
    displayName: 'Amelia Hart', companyName: 'Hart Property Group', ownerName: 'Martin',
    score: 55, scoreBand: 'hot', sourceLabel: 'Property Predator analysis', affiliateLabel: 'Sarah M · PP-SM42',
    journey: {
      routeKey: 'property-predator-self-serve', routeLabel: 'Self-serve conversion',
      stageKey: 'priced', stageLabel: 'Priced', stageSemantic: 'offer',
      lastAdvancedAt: '2026-08-25T15:10:00.000Z', stageAutomatic: true,
      otherJourneyCount: 1, paymentVerifiedSale: false,
    },
    latestSignal: {
      kind: 'reply', label: 'Requested a personal call', detail: 'Apex Annual response',
      occurredAt: '2026-08-25T15:18:00.000Z', progressPercent: null, automatic: true,
    },
    offer: { label: 'Apex Annual', state: 'requested_contact', valueLabel: '£99.00' },
    nextMove: { label: 'Review Amelia’s requested contact', dueAt: '2026-08-25T16:30:00.000Z', dueState: 'due' },
    move: null,
  },
  {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', contactId: SECOND_CONTACT_ID, laneId: QUALIFIED_STAGE,
    displayName: 'Marcus Reed', companyName: 'Reed Acquisitions', ownerName: 'Martin',
    score: 25, scoreBand: 'warm', sourceLabel: 'LinkedIn', affiliateLabel: null,
    journey: {
      routeKey: 'property-predator-agency-laps', routeLabel: 'Agency LAPS',
      stageKey: 'appointment', stageLabel: 'Appointment', stageSemantic: 'appointment',
      lastAdvancedAt: '2026-08-25T13:06:00.000Z', stageAutomatic: true,
      otherJourneyCount: 0, paymentVerifiedSale: false,
    },
    latestSignal: {
      kind: 'watched', label: 'Agency Partner Briefing', detail: '78% complete',
      occurredAt: '2026-08-25T13:06:00.000Z', progressPercent: 78, automatic: true,
    },
    offer: null,
    nextMove: { label: 'Prepare agency pilot discovery', dueAt: '2026-08-26T09:00:00.000Z', dueState: 'due' },
    move: null,
  },
  {
    id: '18181818-1818-4818-8818-181818181818', contactId: '66666666-6666-4666-8666-666666666666', laneId: NEW_SIGNAL_STAGE,
    displayName: 'Priya Shah', companyName: 'Northfield Homes', ownerName: null,
    score: null, scoreBand: 'unscored', sourceLabel: 'Direct', affiliateLabel: null,
    journey: {
      routeKey: 'not-enrolled', routeLabel: 'Not enrolled', stageKey: 'awaiting-enrolment',
      stageLabel: 'Awaiting automatic enrolment', stageSemantic: 'lead', lastAdvancedAt: null, stageAutomatic: false,
      otherJourneyCount: 0, paymentVerifiedSale: false,
    },
    latestSignal: null, offer: null,
    nextMove: { label: 'Review the new identified lead', dueAt: null, dueState: 'none' }, move: null,
  },
  {
    id: '19191919-1919-4919-8919-191919191919', contactId: '14141414-1414-4414-8414-141414141414', laneId: NEW_SIGNAL_STAGE,
    displayName: 'Theo Bennett', companyName: 'Bennett Property Co', ownerName: 'Martin',
    score: 10, scoreBand: 'quiet', sourceLabel: 'Google · predator calculator', affiliateLabel: 'PP-TB19',
    journey: {
      routeKey: 'property-predator-self-serve', routeLabel: 'Self-serve conversion', stageKey: 'lead',
      stageLabel: 'Lead', stageSemantic: 'lead', lastAdvancedAt: '2026-08-25T11:02:00.000Z', stageAutomatic: true,
      otherJourneyCount: 0, paymentVerifiedSale: false,
    },
    latestSignal: {
      kind: 'product', label: 'Account created', detail: 'Identified calculator session',
      occurredAt: '2026-08-25T11:02:00.000Z', progressPercent: null, automatic: true,
    },
    offer: null, nextMove: null, move: null,
  },
  {
    id: '20202020-2020-4020-8020-202020202020', contactId: '15151515-1515-4515-8515-151515151515', laneId: QUALIFIED_STAGE,
    displayName: 'Laila Morgan', companyName: 'LM Developments', ownerName: 'Martin',
    score: 35, scoreBand: 'warm', sourceLabel: 'Predator Briefing webinar', affiliateLabel: null,
    journey: {
      routeKey: 'property-predator-self-serve', routeLabel: 'Self-serve conversion', stageKey: 'activated',
      stageLabel: 'Activated', stageSemantic: 'activation', lastAdvancedAt: '2026-08-25T12:40:00.000Z', stageAutomatic: true,
      otherJourneyCount: 0, paymentVerifiedSale: false,
    },
    latestSignal: {
      kind: 'watched', label: 'Predator Briefing replay', detail: 'Completed',
      occurredAt: '2026-08-25T12:40:00.000Z', progressPercent: 100, automatic: true,
    },
    offer: null,
    nextMove: { label: 'Review the completed briefing', dueAt: '2026-08-25T14:00:00.000Z', dueState: 'overdue' }, move: null,
  },
  {
    id: '21212121-2121-4121-8121-212121212121', contactId: '16161616-1616-4616-8616-161616161616', laneId: PROPOSAL_STAGE,
    displayName: 'Owen Clarke', companyName: 'Clarke Estate Agency', ownerName: 'Martin',
    score: 45, scoreBand: 'hot', sourceLabel: 'Agency referral', affiliateLabel: 'James Cole',
    journey: {
      routeKey: 'property-predator-agency-laps', routeLabel: 'Agency LAPS', stageKey: 'presentation',
      stageLabel: 'Presentation', stageSemantic: 'presentation', lastAdvancedAt: '2026-08-25T14:32:00.000Z', stageAutomatic: false,
      otherJourneyCount: 0, paymentVerifiedSale: false,
    },
    latestSignal: {
      kind: 'offer', label: 'Agency pilot presentation completed', detail: 'Human-recorded presentation event',
      occurredAt: '2026-08-25T14:32:00.000Z', progressPercent: null, automatic: true,
    },
    offer: { label: 'Agency pilot', state: 'presented', valueLabel: '£2,500.00' },
    nextMove: { label: 'Record the proposal response', dueAt: '2026-08-26T10:00:00.000Z', dueState: 'due' }, move: null,
  },
  {
    id: '22222222-2222-4222-8222-222222222222', contactId: '17171717-1717-4717-8717-171717171717', laneId: WON_STAGE,
    displayName: 'Nadia Brooks', companyName: 'Brooks Capital', ownerName: 'Martin',
    score: 70, scoreBand: 'burning', sourceLabel: 'Email campaign', affiliateLabel: null,
    journey: {
      routeKey: 'property-predator-self-serve', routeLabel: 'Self-serve conversion', stageKey: 'sale',
      stageLabel: 'Sale', stageSemantic: 'sale', lastAdvancedAt: '2026-08-25T10:44:00.000Z', stageAutomatic: true,
      otherJourneyCount: 0, paymentVerifiedSale: true,
    },
    latestSignal: {
      kind: 'commerce', label: 'Collected payment', detail: 'Apex Annual · test fixture',
      occurredAt: '2026-08-25T10:44:00.000Z', progressPercent: null, automatic: true,
    },
    offer: { label: 'Apex Annual', state: 'accepted', valueLabel: '£99.00' },
    nextMove: { label: 'Begin customer onboarding', dueAt: '2026-08-26T08:30:00.000Z', dueState: 'due' }, move: null,
  },
];

const previewLaneState = new Map(previewBoardBase.map((card) => [card.id, { laneId: card.laneId, version: 1 }]));
const previewJourneyOverrides = new Map<string, Partial<JourneyBoardCardView>>();

function previewScoreBand(score: number | null): JourneyBoardCardView['scoreBand'] {
  if (score === null) return 'unscored';
  if (score >= 70) return 'burning';
  if (score >= 45) return 'hot';
  if (score >= 22) return 'warm';
  return 'quiet';
}

function currentPreviewCards(): JourneyBoardCardView[] {
  const allowedLaneIds = snapshot.stages.map((stage) => stage.id);
  return previewBoardBase.map((base) => {
    const lane = previewLaneState.get(base.id)!;
    const override = previewJourneyOverrides.get(base.contactId);
    return {
      ...base,
      ...override,
      laneId: lane.laneId,
      move: {
        commandKey: `preview-move-${base.id}-${lane.version}`,
        expectedVersion: lane.version,
        allowedLaneIds,
      },
    };
  });
}

function previewBoard(url: URL): JourneyBoardView {
  const query = (url.searchParams.get('q') ?? '').trim().slice(0, 120);
  const route = (url.searchParams.get('route') ?? '').trim().slice(0, 100);
  const band = (url.searchParams.get('band') ?? '').trim().slice(0, 20);
  const allCards = currentPreviewCards();
  const search = query.toLocaleLowerCase('en-GB');
  const cards = allCards.filter((card) => (!route || card.journey.routeKey === route)
    && (!band || card.scoreBand === band)
    && (!search || [card.displayName, card.companyName, card.sourceLabel, card.affiliateLabel]
      .some((value) => value?.toLocaleLowerCase('en-GB').includes(search))));
  const descriptions = [
    'New identified signals awaiting human review.',
    'Qualified opportunities with a clear next move.',
    'Commercial conversations and proposals in play.',
    'Closed CRM outcome · automatic Sale still requires collected payment.',
  ];
  const noticeKey = url.searchParams.get('notice');
  const notice: JourneyBoardNoticeView | undefined = noticeKey === 'moved'
    ? { kind: 'success', title: 'Workflow lane moved', message: 'The test CRM lane changed. Automatic journey evidence did not.' }
    : noticeKey === 'signal'
      ? { kind: 'info', title: 'Test evidence recorded', message: 'The preview runtime automatically re-evaluated the selected test person.' }
      : noticeKey === 'conflict'
        ? { kind: 'conflict', title: 'Preview card changed', message: 'Refresh and try the workflow move again.' }
        : undefined;
  return {
    workspace: { name: snapshot.workspace.name, asOf: new Date().toISOString(), timezone: snapshot.workspace.timezone, canWrite: true },
    filters: {
      query, route, band,
      routes: [
        { value: 'property-predator-self-serve', label: 'Self-serve conversion' },
        { value: 'property-predator-agency-laps', label: 'Agency LAPS' },
        { value: 'not-enrolled', label: 'Not enrolled' },
      ],
      bands: ['burning', 'hot', 'warm', 'quiet', 'unscored'].map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })),
    },
    lanes: snapshot.stages.map((stage, index) => {
      const laneCards = cards.filter((card) => card.laneId === stage.id);
      return {
        id: stage.id, label: stage.name, description: descriptions[index]!, position: stage.position,
        cardCount: laneCards.length,
        totalCardCount: laneCards.length,
        attentionCount: laneCards.filter((card) => card.nextMove?.dueState === 'overdue' || card.scoreBand === 'burning').length,
        isClosed: stage.isClosed,
        isPartial: false,
      };
    }),
    cards,
    coverage: {
      loadedCardCount: cards.length,
      totalCardCount: cards.length,
      perLaneCardLimit: 75,
      partial: false,
    },
    csrfToken: PREVIEW_CSRF,
    notice,
    previewSignal: {
      enabled: true,
      commandKey: 'preview-signal-command-00000001',
      contacts: allCards.map((card) => ({ value: card.contactId, label: card.displayName })),
      signals: [
        { value: 'content_completed', label: 'Completed briefing' },
        { value: 'appointment_booked', label: 'Booked appointment' },
        { value: 'offer_presented', label: 'Offer / presentation recorded' },
        { value: 'payment_collected', label: 'Collected test payment' },
      ],
    },
  };
}

/** Pure fixture presenter exported so its evidence truth can be regression-tested. */
export function previewLead360(card: JourneyBoardCardView): Lead360View {
  const notEnrolled = card.journey.routeKey === 'not-enrolled';
  const agency = card.journey.routeKey === 'property-predator-agency-laps';
  const stages = (notEnrolled
    ? []
    : agency
    ? [['lead', 'Lead'], ['appointment', 'Appointment'], ['presentation', 'Presentation'], ['sale', 'Sale']]
    : [['lead', 'Lead'], ['activated', 'Activated'], ['priced', 'Priced'], ['sale', 'Sale']]) as Array<[string, string]>;
  const currentIndex = stages.findIndex(([key]) => key === card.journey.stageKey);
  const journeyStages = stages.map(([key, label], index) => ({
    key, label,
    state: index < currentIndex ? 'complete' as const : index === currentIndex ? 'current' as const : 'upcoming' as const,
    // Only the current milestone has a fixture-backed reach time. Earlier
    // milestones remain honestly unknown rather than borrowing that timestamp.
    reachedAt: index === currentIndex ? card.journey.lastAdvancedAt : null,
  }));
  const scoreSourceAt = card.latestSignal?.occurredAt ?? card.journey.lastAdvancedAt ?? SNAPSHOT_AT;
  const scoreEvaluatedAt = new Date().toISOString();
  return {
    identity: {
      contactId: card.contactId, displayName: card.displayName, companyName: card.companyName,
      primaryEmail: `${card.displayName.toLocaleLowerCase('en-GB').replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '')}@example.test`,
      primaryPhone: null, ownerName: card.ownerName,
    },
    score: card.score,
    scoreExplanation: card.score === null ? null : 'Preview score derived only from the displayed test evidence.',
    primaryJourneyLabel: notEnrolled ? null : card.journey.routeLabel,
    journeys: notEnrolled ? [] : [{
      label: card.journey.routeLabel, isPrimary: true,
      status: card.journey.paymentVerifiedSale ? 'completed' : 'active',
      enrolledAt: '2026-08-20T09:00:00.000Z', lastEventAt: card.journey.lastAdvancedAt, endedAt: card.journey.paymentVerifiedSale ? card.journey.lastAdvancedAt : null,
      score: card.score === null ? null : {
        total: card.score, explanation: 'Preview score derived only from the displayed test evidence.',
        sourceOccurredAt: scoreSourceAt,
        evaluatedAt: scoreEvaluatedAt,
      },
      stages: journeyStages,
    }],
    journey: { label: notEnrolled ? 'No conversion journey' : card.journey.routeLabel, stages: journeyStages },
    evidence: card.latestSignal ? [{
      id: `preview-${card.id}`, kind: card.latestSignal.kind as Lead360View['evidence'][number]['kind'],
      title: card.latestSignal.label, detail: card.latestSignal.detail, percentage: card.latestSignal.progressPercent,
      occurredAt: card.latestSignal.occurredAt, sourceLabel: 'Preview runtime',
    }] : [],
    nextMove: card.nextMove ? { label: card.nextMove.label, reason: 'Saved preview task or evidence-led recommendation.', dueAt: card.nextMove.dueAt } : null,
    offers: card.offer ? [{
      id: `offer-${card.id}`, title: card.offer.label, valueLabel: card.offer.valueLabel,
      state: card.offer.state, presentedAt: card.journey.lastAdvancedAt ?? SNAPSHOT_AT, responseAt: null, responseDetail: null,
    }] : [],
    consent: [{ channelLabel: 'Email · preview fixture', state: 'unknown', basis: 'No real permission asserted in preview', updatedAt: null, endpoint: 'preview@example.test', contactPointId: '63636363-6363-4363-8363-636363636363', channel: 'email', purpose: null, evidenceSource: null, policyVersion: null, policyTextSha256: null, effectiveAt: null, recordedAt: null, recordedBy: null, suppressionState: null, suppressionReason: null }],
    suppressionReason: null,
    crm: {
      opportunities: [{
        id: card.id, title: `${card.displayName} opportunity`,
        stageLabel: snapshot.stages.find((stage) => stage.id === card.laneId)?.name ?? 'Unknown lane',
        state: card.laneId === WON_STAGE ? 'won' : 'open', valueLabel: card.offer?.valueLabel ?? null,
      }],
      tasks: card.nextMove ? [{ id: `task-${card.id}`, title: card.nextMove.label, state: 'open', dueAt: card.nextMove.dueAt }] : [],
    },
    asOf: new Date().toISOString(),
  };
}

function applyPreviewSignal(contactId: string, signalKey: string): boolean {
  const base = currentPreviewCards().find((card) => card.contactId === contactId);
  if (!base) return false;
  const now = new Date().toISOString();
  const agency = signalKey === 'appointment_booked' || base.journey.routeKey === 'property-predator-agency-laps';
  const routeKey = agency ? 'property-predator-agency-laps' : 'property-predator-self-serve';
  const routeLabel = agency ? 'Agency LAPS' : 'Self-serve conversion';
  const signals = {
    content_completed: { score: Math.max(base.score ?? 0, 35), key: agency ? 'lead' : 'activated', label: agency ? 'Lead' : 'Activated', semantic: agency ? 'lead' : 'activation', kind: 'watched', title: 'Predator Briefing completed', detail: '100% complete', progress: 100 },
    appointment_booked: { score: Math.max(base.score ?? 0, 25), key: 'appointment', label: 'Appointment', semantic: 'appointment', kind: 'appointment', title: 'Strategy appointment booked', detail: 'Preview booking evidence', progress: null },
    offer_presented: { score: Math.max(base.score ?? 0, agency ? 45 : 55), key: agency ? 'presentation' : 'priced', label: agency ? 'Presentation' : 'Priced', semantic: agency ? 'presentation' : 'offer', kind: 'offer', title: agency ? 'Presentation completed' : 'Apex Annual presented', detail: 'Preview offer evidence', progress: null },
    payment_collected: { score: Math.max(base.score ?? 0, 70), key: 'sale', label: 'Sale', semantic: 'sale', kind: 'commerce', title: 'Collected test payment', detail: 'Payment-backed preview fact', progress: null },
  } as const;
  const signal = signals[signalKey as keyof typeof signals];
  if (!signal) return false;
  previewJourneyOverrides.set(contactId, {
    score: signal.score,
    scoreBand: previewScoreBand(signal.score),
    journey: {
      routeKey, routeLabel, stageKey: signal.key, stageLabel: signal.label, stageSemantic: signal.semantic,
      lastAdvancedAt: now, stageAutomatic: true,
      otherJourneyCount: base.journey.routeKey !== routeKey && base.journey.routeKey !== 'not-enrolled' ? 1 : base.journey.otherJourneyCount,
      paymentVerifiedSale: signal.key === 'sale',
    },
    latestSignal: {
      kind: signal.kind, label: signal.title, detail: signal.detail, occurredAt: now,
      progressPercent: signal.progress, automatic: true,
    },
    nextMove: {
      label: signalKey === 'payment_collected'
        ? 'Begin the test customer onboarding review'
        : signalKey === 'offer_presented'
          ? 'Review the offer response when evidence arrives'
          : signalKey === 'appointment_booked'
            ? 'Prepare for the booked strategy appointment'
            : 'Review the completed Predator Briefing',
      dueAt: null,
      dueState: 'none',
    },
    offer: signalKey === 'offer_presented' || signalKey === 'payment_collected'
      ? { label: agency ? 'Agency pilot' : 'Apex Annual', state: signalKey === 'payment_collected' ? 'accepted' : 'presented', valueLabel: agency ? '£2,500.00' : '£99.00' }
      : base.offer,
  });
  return true;
}

function shell(
  body: string,
  active: 'overview' | 'actions' | 'crm' | 'journeys' | 'content' | 'inbox' | 'affiliates',
  title: string,
): string {
  const previewBoundary = '<aside role="status" aria-label="Local preview boundary" style="position:sticky;z-index:1000;top:0;display:flex;flex-wrap:wrap;justify-content:center;gap:4px 10px;align-items:center;min-height:42px;padding:8px 16px;border-bottom:1px solid #8a6a29;background:#201806;color:#f2c96d;font:800 12px/1.4 ui-monospace,monospace;letter-spacing:.035em;text-align:center"><strong style="flex:0 0 auto">LOCAL PREVIEW</strong><span style="flex:1 1 240px;min-width:0">Fictional / in-memory state · reload or process restart can lose changes · no live provider effects</span></aside>';
  return appShell({
    title, tenantName: snapshot.workspace.name, active, body: `${previewBoundary}${body}`,
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    capabilities: new Set([
      'workspace.overview.read', 'crm.contacts.read', 'crm.pipeline.read', 'crm.tasks.read',
      'actions.read', 'journeys.read', 'content.drafts.read', 'conversations.read',
      'affiliates.compliance.read',
    ]),
    crmAvailable: true, mode: 'crm', csrfToken: PREVIEW_CSRF,
  });
}

function previewJourneyNav(active: 'board' | 'rules'): string {
  return `<nav aria-label="Journey workspace" style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap"><a class="button ${active === 'board' ? '' : 'secondary'} compact" href="${JOURNEY_BOARD_ROUTE}"${active === 'board' ? ' aria-current="page"' : ''}>Live board</a><a class="button ${active === 'rules' ? '' : 'secondary'} compact" href="/portal/journeys"${active === 'rules' ? ' aria-current="page"' : ''}>Journey rules</a></nav>`;
}

type PreviewOperationsRoute = 'today' | 'actions' | 'outreach' | 'journeys' | 'campaigns' | 'content'
  | 'compose' | 'images' | 'calendar' | 'inbox' | 'automations' | 'webinars' | 'analytics' | 'social_accounts' | 'readiness' | 'live';

function previewOperationsNav(active: PreviewOperationsRoute): string {
  const links: readonly Readonly<{ key: PreviewOperationsRoute; href: string; label: string }>[] = [
    { key: 'today', href: '/portal', label: 'Today' },
    { key: 'actions', href: OPERATOR_ACTION_CENTRE_ROUTE, label: 'Action centre' },
    { key: 'outreach', href: DAILY_OUTREACH_ROUTE, label: 'Daily Outreach' },
    { key: 'journeys', href: JOURNEY_BOARD_ROUTE, label: 'Live journeys' },
    { key: 'campaigns', href: PUBLIC_SOCIAL_CAMPAIGNS_ROUTE, label: 'Campaigns' },
    { key: 'content', href: CONTENT_CONTROL_ROOM_ROUTE, label: 'Content' },
    { key: 'compose', href: SOCIAL_COMPOSER_ROUTE, label: 'Composer' },
    { key: 'images', href: IMAGE_STUDIO_ROUTE, label: 'Image Studio' },
    { key: 'calendar', href: CONTENT_CALENDAR_ROUTE, label: 'Calendar' },
    { key: 'inbox', href: CONVERSION_INBOX_ROUTE, label: 'Inbox' },
    { key: 'automations', href: AUTOMATION_STUDIO_ROUTE, label: 'Automations' },
    { key: 'webinars', href: WEBINAR_STUDIO_ROUTE, label: 'Webinars' },
    { key: 'analytics', href: GROWTH_ANALYTICS_ROUTE, label: 'Analytics' },
    { key: 'social_accounts', href: SOCIAL_ACCOUNT_CONTROL_ROUTE, label: 'Social accounts' },
    { key: 'readiness', href: PROVIDER_READINESS_COCKPIT_ROUTE, label: 'Provider readiness' },
    { key: 'live', href: LIVE_CHANNELS_ROUTE, label: 'Live Channels' },
  ];
  return `<nav aria-label="Growth operations" style="display:flex;gap:7px;margin:0 -2px 14px;padding:0 2px 8px;overflow-x:auto;overscroll-behavior-inline:contain;scroll-snap-type:inline proximity">${links.map((link) => `<a class="button ${link.key === active ? '' : 'secondary'} compact" style="flex:0 0 auto;scroll-snap-align:start" href="${link.href}"${link.key === active ? ' aria-current="page"' : ''}>${link.label}</a>`).join('')}</nav>`;
}

function previewContentControl(url: URL): string {
  const view = presentContentControlRoom(previewContentCatalog, {
    workspaceName: snapshot.workspace.name,
    asOf: '2026-08-26T08:42:00.000Z',
    canWrite: true,
    canManage: true,
    notice: contentControlNoticeFromQuery(
      url.searchParams,
      PREVIEW_CONTENT_NOTICE_SECRET,
      PREVIEW_CONTENT_NOTICE_SESSION,
    ),
    filters: {
      query: url.searchParams.get('q'),
      channel: url.searchParams.get('channel'),
      format: url.searchParams.get('format'),
    },
  });
  return renderContentControlRoomBody(view, {
    companyAssetsAvailable: true,
    companyAssetsLabel: PROPERTY_PREDATOR_GROWTH_PROFILE.contentWorkspace?.assetsLabel,
    security: {
      csrfToken: PREVIEW_CSRF,
      requestApprovalKeys: Object.fromEntries(view.items.map((item) => [
        item.contentVersionId,
        `preview-content-request:${item.contentVersionId}`,
      ])),
      decisionKeys: Object.fromEntries(view.items.flatMap((item) => (
        item.approvalRequestId ? [[
          item.approvalRequestId,
          `preview-content-decision:${item.approvalRequestId}`,
        ]] : []
      ))),
    },
  });
}

export function previewExactCompanyContentReview(
  contentItemId: string,
  contentVersionId: string,
): PortalCompanyContentReviewSnapshot | null {
  const item = previewContentCatalog.items.find((candidate) => (
    candidate.contentItemId === contentItemId
    && candidate.contentVersionId === contentVersionId
  ));
  if (!item) return null;
  const payload = previewExactPayload(item);
  const approvalStatus = item.approvalStatus === 'stale'
    ? 'approved' as const : item.approvalStatus;
  return Object.freeze({
    workspace: Object.freeze({
      workspaceId: snapshot.workspace.id,
      workspaceName: snapshot.workspace.name,
      snapshotAt: new Date().toISOString(),
      canWrite: true,
      canManage: true,
    }),
    review: Object.freeze({
      contentItemId: item.contentItemId,
      contentVersionId: item.contentVersionId,
      versionNumber: item.versionNumber,
      isLatest: true,
      origin: item.origin,
      kind: item.kind,
      title: item.title,
      contentMimeType: payload.contentMimeType,
      canonicalContent: payload.canonicalContent,
      canonicalByteLength: Buffer.byteLength(payload.canonicalContent, 'utf8'),
      contentSha256: payload.contentSha256,
      source: item.source,
      blobSha256: payload.blobSha256,
      brandSha256: item.brandSha256,
      approvalRequestId: item.approvalRequestId,
      approvalDecisionId: item.approvalDecisionId,
      approvalStatus,
      approvalStale: item.approvalStale || item.approvalStatus === 'stale',
      email: payload.email,
      createdAt: item.createdAt,
    }),
  });
}

export function previewPageForTest(path: string): ReturnType<typeof page> {
  return page(new URL(path, 'http://127.0.0.1'));
}

function previewConversionInbox(url: URL): string {
  const view = presentConversionInbox(previewInboxSnapshot, {
    workspaceName: snapshot.workspace.name,
    notice: conversionInboxNoticeFromQuery(
      url.searchParams,
      PREVIEW_INBOX_NOTICE_SECRET,
      PREVIEW_INBOX_NOTICE_SESSION,
    ),
    filters: {
      query: url.searchParams.get('q'),
      channel: url.searchParams.get('channel'),
      queue: url.searchParams.get('queue'),
      conversationId: url.searchParams.get('conversation'),
    },
  });
  const thread = view.selectedThread;
  const draft = thread?.draft;
  const messageId = draft?.messageId;
  const approvalRequestId = draft?.approvalRequestId;
  return renderConversionInboxBody(view, {
    security: {
      csrfToken: PREVIEW_CSRF,
      createDraftKeys: thread && draft?.messageId === null
        ? { [thread.summary.conversationId]: `preview-inbox-create:${thread.summary.conversationId}` }
        : {},
      reviseDraftKeys: messageId && draft?.lifecycle === 'draft'
        ? { [messageId]: `preview-inbox-revise:${messageId}` }
        : {},
      requestApprovalKeys: messageId && draft?.lifecycle === 'draft'
        ? { [messageId]: `preview-inbox-request:${messageId}` }
        : {},
      decisionKeys: approvalRequestId && draft?.approvalState === 'pending'
        ? { [approvalRequestId]: `preview-inbox-decision:${approvalRequestId}` }
        : {},
      queueKeys: messageId && draft?.mayQueueTestOperation
        ? { [messageId]: `preview-inbox-queue:${messageId}` }
        : {},
      assignmentKeys: thread
        ? { [thread.summary.conversationId]: `preview-inbox-assign:${thread.summary.conversationId}` }
        : {},
      internalNoteKeys: thread
        ? { [thread.summary.conversationId]: `preview-inbox-note:${thread.summary.conversationId}` }
        : {},
      adminCallKeys: thread
        ? { [thread.summary.conversationId]: `preview-inbox-call:${thread.summary.conversationId}` }
        : {},
      callOutcomeKeys: thread?.adminCall?.taskStatus === 'open'
        ? { [thread.adminCall.taskId]: `preview-inbox-outcome:${thread.adminCall.taskId}` }
        : {},
      adminCallDueAt: '2030-01-01T00:15:00.000Z',
      outcomeOccurredAt: '2030-01-01T00:00:00.000Z',
      nextActionDueAt: '2030-01-02T00:00:00.000Z',
    },
  });
}

function page(url: URL): { status: number; html: string; board?: boolean; scripted?: boolean } {
  const path = url.pathname.replace(/\/+$/, '') || '/portal';
  if (path === '/portal') return {
    status: 200,
    html: shell(renderGrowthHomeBody(snapshot, PROPERTY_PREDATOR_GROWTH_PROFILE, growth, {
      actionCentreAvailable: true,
      dailyOutreachAvailable: true,
    }), 'overview', 'Property Predator — Growth HQ'),
  };
  if (path === OPERATOR_ACTION_CENTRE_ROUTE) return {
    status: 200,
    html: shell(`${previewOperationsNav('actions')}${renderOperatorActionCentreBody(presentOperatorActionCentre(
      createPropertyPredatorOperatorActionCentreFixture(),
    ))}`, 'actions', 'Property Predator — Action Centre'),
  };
  if (path === DAILY_OUTREACH_ROUTE) return {
    status: 200,
    html: shell(`${previewOperationsNav('outreach')}${renderDailyOutreachBody(presentDailyOutreach(
      createPropertyPredatorDailyOutreachFixture(),
    ))}`, 'actions', 'Property Predator — Daily Outreach'),
  };
  if (path === AFFILIATE_COMPLIANCE_ROUTE) return {
    status: 200,
    html: shell(
      renderAffiliateComplianceBody(presentAffiliateCompliance(
        createPropertyPredatorAffiliateComplianceFixture(),
      )),
      'affiliates',
      'Property Predator — Affiliate Compliance',
    ),
  };
  const exactContentMatch = /^\/portal\/content\/items\/([0-9a-f-]+)\/versions\/([0-9a-f-]+)\/review$/iu.exec(path);
  if (exactContentMatch) {
    const exact = previewExactCompanyContentReview(
      (exactContentMatch[1] ?? '').toLowerCase(),
      (exactContentMatch[2] ?? '').toLowerCase(),
    );
    if (exact) {
      const review = exact.review;
      const ownedSeed = review.source.itemId === PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM
        && review.approvalStatus === 'approved' && !review.approvalStale;
      return {
        status: 200,
        html: shell(`${previewOperationsNav('content')}${renderPortalCompanyContentReviewBody(exact, {
          notice: contentControlNoticeFromQuery(
            url.searchParams,
            PREVIEW_CONTENT_NOTICE_SECRET,
            PREVIEW_CONTENT_NOTICE_SESSION,
          ),
          security: {
            csrfToken: PREVIEW_CSRF,
            ...(review.approvalStatus === 'pending' && review.approvalRequestId
              ? {
                  decisionCommandKey: `preview-content-decision:${review.approvalRequestId}`,
                  exactApprovalToken: 'preview_exact_approval_capability_0000000001',
                }
              : { requestCommandKey: `preview-content-request:${review.contentVersionId}` }),
            ownedSeedAvailable: ownedSeed,
            ownedSeedStageAvailable: ownedSeed,
            ...(ownedSeed && previewOwnedSeedWorkflow
              ? {
                  ownedSeedWorkflow: previewOwnedSeedWorkflow,
                  ownedSeedWorkflowToken: PREVIEW_OWNED_SEED_WORKFLOW_TOKEN,
                }
              : {}),
            ownedSeedCommandKey: `preview-owned-seed:${review.contentVersionId}`,
            ownedSeedRunId: '89000000-0000-4000-8000-000000000002',
          },
        })}`, 'content', 'Property Predator — Exact Company Content Review'),
      };
    }
  }
  const leadMatch = /^\/portal\/crm\/contacts\/([^/]+)$/.exec(path);
  if (leadMatch) {
    const card = currentPreviewCards().find((candidate) => candidate.contactId === leadMatch[1]);
    if (card) {
      const caseFile = card.contactId === CONTACT_ID && !previewJourneyOverrides.has(CONTACT_ID)
        ? lead360
        : previewLead360(card);
      return {
        status: 200,
        html: shell(`<nav aria-label="Lead 360 breadcrumb" style="margin-bottom:14px"><a class="button secondary compact" href="${JOURNEY_BOARD_ROUTE}">← Live journeys</a></nav>${renderLead360Body(caseFile, {
          permissionCommandAvailable: true,
          permissionCommandKey: randomUUID(),
          endpointCommandAvailable: true,
          endpointCommandKey: randomUUID(),
          pilotReadiness: {
            ready: false,
            blockers: [{
              code: 'CONSENT_NOT_GRANTED',
              message: 'The latest recorded permission for this endpoint and purpose is not a grant.',
            }],
            preview: {
              recipientEmail: 'office@example.test',
              recipientVerified: true,
              purpose: 'property_predator_marketing',
              dailyUsed: 0, dailyCap: 10, monthlyUsed: 0, monthlyCap: 50,
            },
          },
          // The final authorisation, with the exact words that would be sent.
          // Fixture content only: no real address and no real message.
          // Neither step done, so both confirmation forms render here. The
          // recipient is the fixture endpoint; no address is written in source.
          pilotPreparation: {
            prepareToken: 'prepare-step-token-fixture',
            policyToken: 'policy-step-token-fixture',
            contactPointId: randomUUID(),
            purpose: 'property_predator_marketing',
            recipientEmail: 'office@example.test',
            subject: PROPERTY_PREDATOR_OWNED_SEED_PROOF_SUBJECT,
            bodyText: PROPERTY_PREDATOR_OWNED_SEED_PROOF_BODY,
            contentPrepared: false,
            policyRecorded: false,
            reviewAuthority: FOUNDER_PILOT_REVIEW_AUTHORITY,
            routeClassification: FOUNDER_PILOT_ROUTE_CLASSIFICATION,
            sender: FOUNDER_PILOT_SENDER,
            instigator: FOUNDER_PILOT_INSTIGATOR,
            policyVersion: FOUNDER_PILOT_POLICY_ASSET_VERSION,
            policyClauses: FOUNDER_PILOT_POLICY_CLAUSES,
          },
          pilotAuthorisation: {
            recipientEmail: 'office@example.test',
            subject: 'Your Property Predator briefing is ready',
            bodyText: 'Hi there,\n\nYour Predator Briefing is ready to read, and it '
              + 'covers the three fastest ways to lift instructions in your patch '
              + 'this quarter.\n\nOpen it whenever suits. If it is not useful, one '
              + 'reply and I will stop emailing.\n\nMartin\nProperty Predator',
            campaignVersionNo: 3,
            messageVersionNumber: 2,
            authorityValidUntil: new Date(Date.now() + 4 * 60 * 1000).toISOString(),
            previewToken: 'preview-token-fixture',
          },
          csrfToken: PREVIEW_CSRF,
        })}`, 'crm', `${card.displayName} — Lead 360`),
      };
    }
  }
  if (path === JOURNEY_BOARD_ROUTE) return {
    status: 200,
    html: shell(`${previewOperationsNav('journeys')}${previewJourneyNav('board')}${renderJourneyBoardBody(previewBoard(url))}`, 'journeys', 'Property Predator — Live Journeys'),
    board: true,
  };
  if (path === '/portal/journeys') return {
    status: 200,
    html: shell(`${previewOperationsNav('journeys')}${previewJourneyNav('rules')}${renderJourneyManagerBody(journeyManager)}`, 'journeys', 'Property Predator — Journey Rules'),
  };
  if (path === CONTENT_CONTROL_ROOM_ROUTE) return {
    status: 200,
    html: shell(`${previewOperationsNav('content')}${previewContentControl(url)}`, 'content', 'Property Predator — Content Control'),
  };
  if (path === BRAND_BRAIN_ROUTE) return {
    status: 200,
    html: shell(
      `${previewOperationsNav('content')}${renderBrandBrainBody(
        presentBrandBrain(createPropertyPredatorBrandBrainFixture()),
        {
          companyAssetsAvailable: true,
          companyAssetsLabel: PROPERTY_PREDATOR_GROWTH_PROFILE.contentWorkspace?.assetsLabel,
          brainLabel: PROPERTY_PREDATOR_GROWTH_PROFILE.contentWorkspace?.brainLabel,
        },
      )}`,
      'content',
      'Property Predator — Content Brain',
    ),
  };
  if (path === COMPANY_ASSETS_ROUTE) return {
    status: 200,
    html: shell(
      `${previewOperationsNav('content')}${renderCompanyAssetsBody(
        presentCompanyAssets(createPropertyPredatorCompanyAssetsReviewPreviewFixture()),
        {
          assetsLabel: PROPERTY_PREDATOR_GROWTH_PROFILE.contentWorkspace?.assetsLabel,
          exactReviewHrefsByReleaseItemId: createPropertyPredatorCompanyContentReviewHrefs(),
        },
      )}`,
      'content',
      'Property Predator — Company Assets',
    ),
  };
  if (path === `/portal/content/assets/review/${PROPERTY_PREDATOR_REVIEW_FIXTURE_RELEASE_ITEM_ID}`) {
    return {
      status: 200,
      html: shell(
        `${previewOperationsNav('content')}${renderCompanyContentReviewBody(
          presentCompanyContentReview(createPropertyPredatorCompanyContentReviewFixture()),
        )}`,
        'content',
        'Property Predator — Exact Content Review',
      ),
    };
  }
  if (path === CAMPAIGN_WIZARD_ROUTE) return {
    status: 200,
    html: shell(`${previewOperationsNav('campaigns')}${renderCampaignWizardBody(
      presentCampaignWizard(previewCampaignWizardSnapshot(), {
        workspaceName: snapshot.workspace.name,
        timezone: snapshot.workspace.timezone,
        asOf: new Date().toISOString(),
        draftPlan: planPropertyPredatorMarketingDraft({
          selection: url.searchParams.get('laps'),
          brandBrainSnapshot: createPropertyPredatorBrandBrainFixture(),
        }),
      }),
      {
        action: {
          actionUrl: CAMPAIGN_WIZARD_CREATE_TEST_ROUTE,
          csrfToken: PREVIEW_CSRF,
          commandKey: previewCreateCommandKey(),
          returnTo: CONTENT_CALENDAR_ROUTE,
        },
        outcome: campaignWizardNoticeFromQuery(
          url.searchParams,
          PREVIEW_CAMPAIGN_NOTICE_SECRET,
          PREVIEW_CAMPAIGN_NOTICE_SESSION,
        ),
        companyAssetsAvailable: true,
        assetsLabel: PROPERTY_PREDATOR_GROWTH_PROFILE.contentWorkspace?.assetsLabel,
        brandBrainAvailable: true,
        brainLabel: PROPERTY_PREDATOR_GROWTH_PROFILE.contentWorkspace?.brainLabel,
      },
    )}`, 'content', 'Property Predator — Build Campaign'),
  };
  if (path === CONTENT_CALENDAR_ROUTE) return {
    status: 200,
    html: shell(`${previewOperationsNav('calendar')}${renderContentCalendarBody(presentContentCalendar(
      createPersistentPreviewContentCalendar(),
      {
        workspaceName: snapshot.workspace.name,
        timezone: snapshot.workspace.timezone,
        asOf: PROPERTY_PREDATOR_CONTENT_CALENDAR_AS_OF,
        filters: {
          mode: url.searchParams.get('mode'),
          date: url.searchParams.get('date'),
          channel: url.searchParams.get('channel'),
        },
      },
    ), {
      mutations: previewCalendarMutations(url),
      liveScheduler: {
        actionUrl: '/portal/content/calendar/live-schedules',
        mediaUploadUrl: '/portal/content/calendar/media-uploads',
        csrfToken: PREVIEW_CSRF,
        commandKey: 'preview-live-calendar-command',
        mediaCommandKey: 'preview-live-media-command',
        items: [],
      },
    })}`, 'content', 'Property Predator — Content Calendar'),
    scripted: true,
  };
  if (path === CAMPAIGN_MACHINE_ROUTE) return {
    status: 200,
    html: shell(`${previewOperationsNav('campaigns')}${renderCampaignMachineBody(
      presentCampaignMachine(createPropertyPredatorCampaignMachineFixture()),
    )}`, 'content', 'Property Predator — Campaign Machine'),
  };
  if (path === SOCIAL_COMPOSER_ROUTE) return {
    status: 200,
    html: shell(`${previewOperationsNav('compose')}${renderSocialComposerBody(presentSocialComposer(
      createPropertyPredatorSocialComposerFixture(),
      {
        workspaceName: snapshot.workspace.name,
        asOf: PROPERTY_PREDATOR_SOCIAL_COMPOSER_AS_OF,
        filters: {
          channel: url.searchParams.get('channel'),
          preview: url.searchParams.get('preview'),
        },
      },
    ))}`, 'content', 'Property Predator — Social Composer'),
    scripted: true,
  };
  if (path === IMAGE_STUDIO_ROUTE) return {
    status: 200,
    html: shell(`${previewOperationsNav('images')}${renderImageStudioBody(presentImageStudio(
      createPropertyPredatorImageStudioFixture(),
    ))}`, 'content', 'Property Predator — Image Studio'),
    scripted: true,
  };
  if (path === PUBLIC_SOCIAL_CAMPAIGNS_ROUTE) return {
    status: 200,
    html: shell(`${previewOperationsNav('campaigns')}${renderPublicSocialCampaignsBody(presentPublicSocialCampaigns(
      createPropertyPredatorPublicSocialCampaignsFixture(),
      {
        workspaceName: snapshot.workspace.name,
        workspaceTimezone: snapshot.workspace.timezone,
        snapshotAt: PROPERTY_PREDATOR_PUBLIC_SOCIAL_CAMPAIGNS_AS_OF,
        requestedCampaignId: PROPERTY_PREDATOR_PUBLIC_SOCIAL_CAMPAIGN_ID,
         calendarFilters: {
          mode: url.searchParams.get('calendar_mode'),
          date: url.searchParams.get('calendar_date'),
           channel: url.searchParams.get('calendar_channel'),
         },
         inputTruncated: false,
       },
    ), { campaignMachineAvailable: true })}`, 'content', 'Property Predator — Campaign Command'),
  };
  if (path === CONVERSION_INBOX_ROUTE) return {
    status: 200,
    html: shell(`${previewOperationsNav('inbox')}${previewConversionInbox(url)}`, 'inbox', 'Property Predator — Conversion Inbox'),
  };
  if (path === AUTOMATION_STUDIO_ROUTE) return {
    status: 200,
    html: shell(`${previewOperationsNav('automations')}${renderAutomationStudioBody(presentAutomationStudio(
      createPropertyPredatorAutomationStudioFixture(),
      {
        node: url.searchParams.get('node'),
      },
    ))}`, 'journeys', 'Property Predator — Automation Studio'),
  };
  if (path === WEBINAR_STUDIO_ROUTE) return {
    status: 200,
    html: shell(`${previewOperationsNav('webinars')}${renderWebinarStudioBody(presentWebinarStudio(
      createPropertyPredatorWebinarStudioFixture(),
    ))}`, 'content', 'Property Predator — Webinar Studio'),
  };
  if (path === GROWTH_ANALYTICS_ROUTE) return {
    status: 200,
    html: shell(`${previewOperationsNav('analytics')}${renderGrowthAnalyticsBody(presentGrowthAnalytics(
      createPropertyPredatorGrowthAnalyticsFixture(),
    ))}`, 'overview', 'Property Predator — Growth Analytics'),
  };
  if (path === PROVIDER_CONNECTIONS_ROUTE) return {
    status: 200,
    html: shell(`${previewOperationsNav('readiness')}${renderProviderConnectionsBody(presentProviderConnections(
      createPropertyPredatorProviderConnectionsFixture(),
    ))}`, 'overview', 'Property Predator — Connections'),
  };
  if (path === SOCIAL_ACCOUNT_CONTROL_ROUTE) return {
    status: 200,
    html: shell(`${previewOperationsNav('social_accounts')}${renderSocialAccountControlBody(
      presentSocialAccountControl(createPropertyPredatorSocialAccountControlFixture()),
    )}`, 'content', 'Property Predator — Social Accounts'),
  };
  if (path === PROVIDER_READINESS_COCKPIT_ROUTE) return {
    status: 200,
    html: shell(`${previewOperationsNav('readiness')}${renderProviderReadinessCockpitBody(
      presentProviderReadinessCockpit(createPropertyPredatorProviderReadinessFixture()),
    )}`, 'overview', 'Property Predator — Provider Readiness'),
  };
  if (path === LIVE_CHANNELS_ROUTE) return {
    status: 200,
    html: shell(`${previewOperationsNav('live')}${renderLiveChannelsBody(
      presentLiveChannels(previewLiveChannelsSnapshot()),
      {
        workspaceName: snapshot.workspace.name,
        csrfToken: PREVIEW_CSRF,
        pauseCommandAvailable: true,
        pauseCommandKeys: {
          all: randomUUID(),
          customer_email: randomUUID(),
          owned_social: randomUUID(),
          whatsapp: randomUUID(),
          sms: randomUUID(),
          social_dm: randomUUID(),
        },
        ownedSocialCommandAvailable: true,
        ownedSocialProfileBindingComposed: true,
        ownedSocialCommandKeys: {
          bind: randomUUID(),
          revoke: randomUUID(),
          stage: randomUUID(),
        },
        smsCommandAvailable: true,
        smsCommandKeys: {
          bind: randomUUID(),
          revoke: randomUUID(),
          stage: randomUUID(),
        },
        railStatusAvailable: true,
        handoff: {
          conversionInboxComposed: true,
          inboxOperationsComposed: true,
          lead360Composed: true,
        },
        notice: liveChannelsNoticeFromQuery(
          url.searchParams,
          PREVIEW_LIVE_CHANNELS_NOTICE_SECRET,
          PREVIEW_LIVE_CHANNELS_NOTICE_SESSION,
        ),
      },
    )}`, 'overview', 'Property Predator — Live Channels'),
  };
  if (path === '/portal/crm/contacts') return {
    status: 200,
    html: shell(renderCrmContactsBody(snapshot, {
      csrfToken: PREVIEW_CSRF,
      createLeadCommandKey: 'preview-create-lead-command',
    }), 'crm', 'Property Predator — Leads'),
  };
  if (path === '/portal/crm/opportunities') return {
    status: 200,
    html: shell(renderCrmPipelineBody(snapshot, { csrfToken: PREVIEW_CSRF }), 'crm', 'Property Predator — Pipeline'),
  };
  if (path === '/portal/crm/tasks') return {
    status: 200,
    html: shell(renderCrmTasksBody(snapshot, {
      csrfToken: PREVIEW_CSRF, filter: 'open',
    }), 'crm', 'Property Predator — Tasks'),
  };
  return { status: 404, html: shell('<h1>Preview page not found</h1><p><a href="/portal">Return to Growth HQ</a></p>', 'overview', 'Not found') };
}

function readPreviewForm(request: IncomingMessage): Promise<URLSearchParams | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 16_384) chunks.push(chunk);
    });
    request.on('end', () => resolve(size <= 16_384
      ? new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
      : null));
    request.on('error', () => resolve(null));
  });
}

function previewBoardReturnLocation(form: URLSearchParams | null, notice: 'moved' | 'conflict'): string {
  const query = new URLSearchParams({ notice });
  const search = (form?.get('return_q') ?? '').trim();
  if (search && search.length <= 120 && !/[\u0000-\u001f\u007f]/u.test(search)) query.set('q', search);
  const route = (form?.get('return_route') ?? '').trim();
  if (/^[a-z0-9][a-z0-9._-]{0,99}$/u.test(route)) query.set('route', route);
  const band = (form?.get('return_band') ?? '').trim();
  if (['burning', 'hot', 'warm', 'quiet', 'unscored'].includes(band)) query.set('band', band);
  return `${JOURNEY_BOARD_ROUTE}?${query.toString()}`;
}

function previewContentReturnLocation(form: URLSearchParams | null, code: ContentControlNoticeCode): string {
  const query = new URLSearchParams({
    notice: contentControlNoticeToken(
      PREVIEW_CONTENT_NOTICE_SECRET,
      PREVIEW_CONTENT_NOTICE_SESSION,
      code,
    ),
  });
  const exactItemId = (form?.get('return_exact_item_id') ?? '').trim().toLowerCase();
  const exactVersionId = (form?.get('return_exact_version_id') ?? '').trim().toLowerCase();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  if (uuid.test(exactItemId) && uuid.test(exactVersionId)) {
    return `/portal/content/items/${encodeURIComponent(exactItemId)}`
      + `/versions/${encodeURIComponent(exactVersionId)}/review?${query.toString()}`;
  }
  const search = (form?.get('return_q') ?? '').trim();
  if (search && search.length <= 80 && !/[\u0000-\u001f\u007f]/u.test(search)) query.set('q', search);
  const channel = form?.get('return_channel') ?? '';
  if (['social', 'email', 'webinar', 'library'].includes(channel)) query.set('channel', channel);
  const format = form?.get('return_format') ?? '';
  if (['article', 'document', 'email', 'image', 'social_post', 'video', 'webinar', 'other'].includes(format)) query.set('format', format);
  const anchor = /^(?:ccr-content-)[1-9][0-9]{0,2}$/u.test(form?.get('return_anchor') ?? '')
    ? `#${form!.get('return_anchor')}`
    : '';
  return `${CONTENT_CONTROL_ROOM_ROUTE}?${query.toString()}${anchor}`;
}

function previewInboxReturnLocation(form: URLSearchParams | null, code: ConversionInboxNoticeCode): string {
  const query = new URLSearchParams({
    notice: conversionInboxNoticeToken(
      PREVIEW_INBOX_NOTICE_SECRET,
      PREVIEW_INBOX_NOTICE_SESSION,
      code,
    ),
  });
  const search = (form?.get('return_q') ?? '').trim();
  if (search && search.length <= 80 && !/[\u0000-\u001f\u007f]/u.test(search)) query.set('q', search);
  const channel = form?.get('return_channel') ?? '';
  if (['email', 'whatsapp', 'sms', 'instagram', 'facebook'].includes(channel)) query.set('channel', channel);
  const queue = form?.get('return_queue') ?? '';
  if (['unread', 'approval', 'open'].includes(queue)) query.set('queue', queue);
  const conversation = form?.get('return_conversation') ?? '';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(conversation)) {
    query.set('conversation', conversation.toLowerCase());
  }
  return `${CONVERSION_INBOX_ROUTE}?${query.toString()}`;
}

function previewCampaignReturnLocation(
  form: URLSearchParams | null,
  result: PreviewCampaignActionResult,
): string {
  const requestedReturn = form?.get('return_to') ?? '';
  const base = requestedReturn === CAMPAIGN_WIZARD_ROUTE || requestedReturn === CONTENT_CALENDAR_ROUTE
    ? requestedReturn
    : CONTENT_CALENDAR_ROUTE;
  const query = new URLSearchParams({
    notice: campaignWizardNoticeToken(
      PREVIEW_CAMPAIGN_NOTICE_SECRET,
      PREVIEW_CAMPAIGN_NOTICE_SESSION,
      result.code,
    ),
  });
  const mode = form?.get('return_mode') ?? '';
  if (mode === 'week' || mode === 'month') query.set('mode', mode);
  const date = form?.get('return_date') ?? '';
  if (/^\d{4}-\d{2}-\d{2}$/u.test(date)) query.set('date', date);
  const channel = form?.get('return_channel') ?? '';
  if (['all', ...PREVIEW_CAMPAIGN_TARGETS.map((target) => target.network)].includes(channel as never)) {
    query.set('channel', channel);
  }
  return `${base}?${query.toString()}`;
}

function previewCampaignResponse(
  request: IncomingMessage,
  response: ServerResponse,
  form: URLSearchParams | null,
  result: PreviewCampaignActionResult,
): void {
  const location = previewCampaignReturnLocation(form, result);
  const wantsJson = (request.headers.accept ?? '').includes('application/json')
    && request.headers['x-requested-with'] === 'ContentCalendar';
  if (wantsJson) {
    const body = JSON.stringify({
      ok: result.ok,
      message: result.message,
      intentId: result.intentId,
      targetId: result.targetId,
      redirect: location,
      environment: 'test',
      providerEffects: 'none',
    });
    response.writeHead(result.ok ? 200 : 409, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(body);
    return;
  }
  response.writeHead(303, { location, 'cache-control': 'no-store' });
  response.end();
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/portal', 'http://127.0.0.1');
  const path = url.pathname.replace(/\/+$/, '') || '/portal';
  if (request.method === 'GET' && path === JOURNEY_BOARD_CLIENT_ROUTE) {
    response.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': String(Buffer.byteLength(JOURNEY_BOARD_CLIENT_SOURCE)),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(JOURNEY_BOARD_CLIENT_SOURCE);
    return;
  }
  if (request.method === 'GET' && path === CONTENT_CALENDAR_CLIENT_ROUTE) {
    response.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': String(Buffer.byteLength(CONTENT_CALENDAR_CLIENT_SOURCE)),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(CONTENT_CALENDAR_CLIENT_SOURCE);
    return;
  }

  if (request.method === 'POST' && path === CAMPAIGN_WIZARD_CREATE_TEST_ROUTE) {
    const form = await readPreviewForm(request);
    previewCampaignResponse(request, response, form, applyPreviewCampaignCreate(form));
    return;
  }

  if (request.method === 'POST' && path === PREVIEW_CALENDAR_RESCHEDULE_ROUTE) {
    const form = await readPreviewForm(request);
    previewCampaignResponse(request, response, form, applyPreviewCampaignReschedule(form));
    return;
  }

  if (request.method === 'POST' && path === PREVIEW_CALENDAR_CANCEL_ROUTE) {
    const form = await readPreviewForm(request);
    previewCampaignResponse(request, response, form, applyPreviewCampaignCancel(form));
    return;
  }

  const moveMatch = /^\/portal\/journeys\/board\/opportunities\/([^/]+)\/stage$/.exec(path);
  if (request.method === 'POST' && moveMatch) {
    const form = await readPreviewForm(request);
    const opportunityId = moveMatch[1]!;
    const state = previewLaneState.get(opportunityId);
    const targetLane = form?.get('target_lane_id') ?? '';
    const expectedVersion = Number(form?.get('expected_version') ?? '');
    const valid = form?.get('_csrf') === PREVIEW_CSRF
      && (form.get('command_key') ?? '').startsWith('preview-move-')
      && state
      && Number.isSafeInteger(expectedVersion)
      && expectedVersion === state.version
      && snapshot.stages.some((stage) => stage.id === targetLane);
    if (valid && state) {
      state.laneId = targetLane;
      state.version += 1;
      response.writeHead(303, { location: previewBoardReturnLocation(form, 'moved'), 'cache-control': 'no-store' });
    } else {
      response.writeHead(303, { location: previewBoardReturnLocation(form, 'conflict'), 'cache-control': 'no-store' });
    }
    response.end();
    return;
  }

  if (request.method === 'POST' && path === '/portal/journeys/board/test-signal') {
    const form = await readPreviewForm(request);
    const valid = form?.get('_csrf') === PREVIEW_CSRF
      && form.get('command_key') === 'preview-signal-command-00000001'
      && form.get('preview_fixture_only') === 'true'
      && applyPreviewSignal(form.get('contact_id') ?? '', form.get('signal_key') ?? '');
    response.writeHead(303, {
      location: `${JOURNEY_BOARD_ROUTE}?notice=${valid ? 'signal' : 'conflict'}`,
      'cache-control': 'no-store',
    });
    response.end();
    return;
  }

  if (request.method === 'POST' && path === OWNED_SEED_MESSAGE_CREATE_ROUTE) {
    const form = await readPreviewForm(request);
    const contentItemId = form?.get('return_exact_item_id') ?? '';
    const contentVersionId = form?.get('return_exact_version_id') ?? '';
    const exact = previewExactCompanyContentReview(contentItemId, contentVersionId);
    const valid = form?.get('_csrf') === PREVIEW_CSRF
      && form.get('command_key') === `preview-owned-seed:${contentVersionId}`
      && exact?.review.source.itemId === PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM
      && exact.review.approvalStatus === 'approved'
      && !exact.review.approvalStale
      && exact.review.email;
    if (valid && exact?.review.email) {
      previewOwnedSeedWorkflow = Object.freeze({
        phase: 'drafted',
        companyContentVersionId: contentVersionId,
        messageId: PREVIEW_OWNED_SEED_MESSAGE_ID,
        messageVersionId: PREVIEW_OWNED_SEED_MESSAGE_VERSION_ID,
        approvalRequestId: null,
        subjectSha256: exact.review.email.subjectSha256,
        bodySha256: exact.review.email.bodySha256,
        sourceContentSha256: exact.review.contentSha256,
      });
    }
    response.writeHead(303, {
      location: previewContentReturnLocation(form, valid ? 'draft_created' : 'invalid'),
      'cache-control': 'no-store',
    });
    response.end();
    return;
  }

  if (request.method === 'POST' && path === OWNED_SEED_MESSAGE_APPROVAL_REQUEST_ROUTE) {
    const form = await readPreviewForm(request);
    const valid = form?.get('_csrf') === PREVIEW_CSRF
      && form.get('owned_seed_workflow_token') === PREVIEW_OWNED_SEED_WORKFLOW_TOKEN
      && form.get('message_id') === previewOwnedSeedWorkflow?.messageId
      && previewOwnedSeedWorkflow?.phase === 'drafted';
    if (valid && previewOwnedSeedWorkflow) {
      previewOwnedSeedWorkflow = Object.freeze({
        ...previewOwnedSeedWorkflow,
        phase: 'approval_pending',
        approvalRequestId: PREVIEW_OWNED_SEED_APPROVAL_REQUEST_ID,
      });
    }
    response.writeHead(303, {
      location: previewContentReturnLocation(form, valid ? 'requested' : 'invalid'),
      'cache-control': 'no-store',
    });
    response.end();
    return;
  }

  if (request.method === 'POST' && path === OWNED_SEED_MESSAGE_APPROVAL_DECISION_ROUTE) {
    const form = await readPreviewForm(request);
    const decision = form?.get('decision') ?? '';
    const valid = form?.get('_csrf') === PREVIEW_CSRF
      && form.get('owned_seed_workflow_token') === PREVIEW_OWNED_SEED_WORKFLOW_TOKEN
      && form.get('approval_request_id') === previewOwnedSeedWorkflow?.approvalRequestId
      && previewOwnedSeedWorkflow?.phase === 'approval_pending'
      && ['approved', 'rejected', 'changes_requested'].includes(decision);
    if (valid && previewOwnedSeedWorkflow) {
      previewOwnedSeedWorkflow = Object.freeze({
        ...previewOwnedSeedWorkflow,
        phase: decision === 'approved' ? 'approved' : 'drafted',
      });
    }
    response.writeHead(303, {
      location: previewContentReturnLocation(
        form,
        valid && decision === 'approved' ? 'approved'
          : valid && decision === 'rejected' ? 'rejected'
            : valid && decision === 'changes_requested' ? 'changes_requested' : 'invalid',
      ),
      'cache-control': 'no-store',
    });
    response.end();
    return;
  }

  if (request.method === 'POST' && path === OWNED_SEED_CAMPAIGN_STAGE_ROUTE) {
    const form = await readPreviewForm(request);
    const valid = form?.get('_csrf') === PREVIEW_CSRF
      && form.get('owned_seed_workflow_token') === PREVIEW_OWNED_SEED_WORKFLOW_TOKEN
      && form.get('message_version_id') === previewOwnedSeedWorkflow?.messageVersionId
      && previewOwnedSeedWorkflow?.phase === 'approved';
    if (valid && previewOwnedSeedWorkflow) {
      previewOwnedSeedWorkflow = Object.freeze({
        ...previewOwnedSeedWorkflow,
        phase: 'staged',
      });
    }
    response.writeHead(303, {
      location: previewContentReturnLocation(form, valid ? 'replayed' : 'invalid'),
      'cache-control': 'no-store',
    });
    response.end();
    return;
  }

  if (request.method === 'POST' && path === CONTENT_APPROVAL_REQUEST_ROUTE) {
    const form = await readPreviewForm(request);
    const contentItemId = form?.get('content_item_id') ?? '';
    const contentVersionId = form?.get('content_version_id') ?? '';
    const valid = form?.get('_csrf') === PREVIEW_CSRF
      && form.get('command_key') === `preview-content-request:${contentVersionId}`
      && requestPreviewContentApproval(contentItemId, contentVersionId);
    response.writeHead(303, {
      location: previewContentReturnLocation(form, valid ? 'requested' : 'invalid'),
      'cache-control': 'no-store',
    });
    response.end();
    return;
  }

  if (request.method === 'POST' && path === CONTENT_APPROVAL_DECISION_ROUTE) {
    const form = await readPreviewForm(request);
    const approvalRequestId = form?.get('approval_request_id') ?? '';
    const decision = form?.get('decision') ?? '';
    const validDecision = decision === 'approved' || decision === 'rejected' || decision === 'changes_requested';
    const valid = form?.get('_csrf') === PREVIEW_CSRF
      && form.get('command_key') === `preview-content-decision:${approvalRequestId}`
      && validDecision
      && decidePreviewContentApproval(
        approvalRequestId,
        decision as 'approved' | 'rejected' | 'changes_requested',
        form.get('decision_note') ?? '',
      );
    response.writeHead(303, {
      location: previewContentReturnLocation(
        form,
        valid ? decision as 'approved' | 'rejected' | 'changes_requested' : 'invalid',
      ),
      'cache-control': 'no-store',
    });
    response.end();
    return;
  }

  const inboxReviseMatch = /^\/portal\/inbox\/messages\/([^/]+)\/versions$/.exec(path);
  if (request.method === 'POST' && inboxReviseMatch) {
    const form = await readPreviewForm(request);
    const messageId = inboxReviseMatch[1]!;
    const valid = form?.get('_csrf') === PREVIEW_CSRF
      && form.get('command_key') === `preview-inbox-revise:${messageId}`
      && revisePreviewInboxDraft(
        messageId,
        form.get('body') ?? '',
        form.get('expected_row_version') ?? '',
      );
    response.writeHead(303, {
      location: previewInboxReturnLocation(form, valid ? 'draft_saved' : 'conflict'),
      'cache-control': 'no-store',
    });
    response.end();
    return;
  }

  const inboxRequestMatch = /^\/portal\/inbox\/messages\/([^/]+)\/approval-requests$/.exec(path);
  if (request.method === 'POST' && inboxRequestMatch) {
    const form = await readPreviewForm(request);
    const messageId = inboxRequestMatch[1]!;
    const valid = form?.get('_csrf') === PREVIEW_CSRF
      && form.get('command_key') === `preview-inbox-request:${messageId}`
      && requestPreviewInboxApproval(messageId, form.get('expected_row_version') ?? '');
    response.writeHead(303, {
      location: previewInboxReturnLocation(form, valid ? 'approval_requested' : 'conflict'),
      'cache-control': 'no-store',
    });
    response.end();
    return;
  }

  const inboxDecisionMatch = /^\/portal\/inbox\/approval-requests\/([^/]+)\/decisions$/.exec(path);
  if (request.method === 'POST' && inboxDecisionMatch) {
    const form = await readPreviewForm(request);
    const approvalRequestId = inboxDecisionMatch[1]!;
    const decision = form?.get('decision') ?? '';
    const validDecision = decision === 'approved' || decision === 'rejected' || decision === 'changes_requested';
    const valid = form?.get('_csrf') === PREVIEW_CSRF
      && form.get('command_key') === `preview-inbox-decision:${approvalRequestId}`
      && validDecision
      && decidePreviewInboxApproval(
        approvalRequestId,
        decision as 'approved' | 'rejected' | 'changes_requested',
        form.get('decision_note') ?? '',
      );
    response.writeHead(303, {
      location: previewInboxReturnLocation(
        form,
        valid ? decision as 'approved' | 'rejected' | 'changes_requested' : 'conflict',
      ),
      'cache-control': 'no-store',
    });
    response.end();
    return;
  }

  const inboxQueueMatch = /^\/portal\/inbox\/messages\/([^/]+)\/test-queue$/.exec(path);
  if (request.method === 'POST' && inboxQueueMatch) {
    const form = await readPreviewForm(request);
    const messageId = inboxQueueMatch[1]!;
    const valid = form?.get('_csrf') === PREVIEW_CSRF
      && form.get('command_key') === `preview-inbox-queue:${messageId}`
      && queuePreviewInboxTestOperation(
        messageId,
        form.get('expected_row_version') ?? '',
        form.get('purpose') ?? '',
      );
    response.writeHead(303, {
      location: previewInboxReturnLocation(form, valid ? 'test_queued' : 'consent_blocked'),
      'cache-control': 'no-store',
    });
    response.end();
    return;
  }

  if (request.method === 'POST' && path === LIVE_CHANNELS_PAUSE_ROUTE) {
    const form = await readPreviewForm(request);
    const code = applyPreviewLivePause(form);
    const token = liveChannelsNoticeToken(
      PREVIEW_LIVE_CHANNELS_NOTICE_SECRET,
      PREVIEW_LIVE_CHANNELS_NOTICE_SESSION,
      code,
    );
    response.writeHead(303, {
      location: `${LIVE_CHANNELS_ROUTE}?notice=${encodeURIComponent(token)}`,
      'cache-control': 'no-store',
    });
    response.end();
    return;
  }

  if (request.method === 'POST' && path === CONVERSION_INBOX_CREATE_DRAFT_ROUTE) {
    const form = await readPreviewForm(request);
    response.writeHead(303, {
      location: previewInboxReturnLocation(form, 'invalid'),
      'cache-control': 'no-store',
    });
    response.end();
    return;
  }

  if (request.method !== 'GET') {
    response.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' });
    response.end();
    return;
  }

  const rendered = page(url);
  response.writeHead(rendered.status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': rendered.board
      ? "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
      : rendered.scripted
        ? "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
        : "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(rendered.html);
});

if (process.env.PROPERTY_PREDATOR_PREVIEW_IMPORT_ONLY !== '1') {
  server.listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`Property Predator preview ready at http://127.0.0.1:${PORT}/portal\n`);
  });
}
