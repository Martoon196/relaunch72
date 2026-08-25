/**
 * Local, read-only Property Predator product preview.
 *
 * It serves explicit preview fixtures only: no database, provider, message,
 * social post, payment or production service is touched.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { appShell } from '../src/portal/ui.js';
import { renderGrowthHomeBody } from '../src/portal/growth-home.js';
import { renderLead360Body, type Lead360View } from '../src/portal/lead-360-view.js';
import { JOURNEY_BOARD_CLIENT_SOURCE } from '../src/portal/journey-board-client.js';
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
    { channelLabel: 'Email · amelia@example.test', state: 'permitted', basis: 'Property Predator marketing · Consent · Verified endpoint', updatedAt: '2026-08-14T09:20:00.000Z' },
    { channelLabel: 'SMS · +44 7700 900001', state: 'unknown', basis: 'No verified permission evidence', updatedAt: null },
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
    consent: [{ channelLabel: 'Email · preview fixture', state: 'unknown', basis: 'No real permission asserted in preview', updatedAt: null }],
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

function shell(body: string, active: 'overview' | 'crm' | 'journeys', title: string): string {
  return appShell({
    title, tenantName: snapshot.workspace.name, active, body,
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    capabilities: new Set(['workspace.overview.read', 'crm.contacts.read', 'crm.pipeline.read', 'crm.tasks.read', 'journeys.read']),
    crmAvailable: true, mode: 'crm', csrfToken: PREVIEW_CSRF,
  });
}

function previewJourneyNav(active: 'board' | 'rules'): string {
  return `<nav aria-label="Journey workspace" style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap"><a class="button ${active === 'board' ? '' : 'secondary'} compact" href="${JOURNEY_BOARD_ROUTE}"${active === 'board' ? ' aria-current="page"' : ''}>Live board</a><a class="button ${active === 'rules' ? '' : 'secondary'} compact" href="/portal/journeys"${active === 'rules' ? ' aria-current="page"' : ''}>Journey rules</a></nav>`;
}

function page(url: URL): { status: number; html: string; board?: boolean } {
  const path = url.pathname.replace(/\/+$/, '') || '/portal';
  if (path === '/portal') return {
    status: 200,
    html: shell(renderGrowthHomeBody(snapshot, PROPERTY_PREDATOR_GROWTH_PROFILE, growth), 'overview', 'Property Predator — Growth HQ'),
  };
  const leadMatch = /^\/portal\/crm\/contacts\/([^/]+)$/.exec(path);
  if (leadMatch) {
    const card = currentPreviewCards().find((candidate) => candidate.contactId === leadMatch[1]);
    if (card) {
      const caseFile = card.contactId === CONTACT_ID && !previewJourneyOverrides.has(CONTACT_ID)
        ? lead360
        : previewLead360(card);
      return {
        status: 200,
        html: shell(`<nav aria-label="Lead 360 breadcrumb" style="margin-bottom:14px"><a class="button secondary compact" href="${JOURNEY_BOARD_ROUTE}">← Live journeys</a></nav>${renderLead360Body(caseFile)}`, 'crm', `${card.displayName} — Lead 360`),
      };
    }
  }
  if (path === JOURNEY_BOARD_ROUTE) return {
    status: 200,
    html: shell(`${previewJourneyNav('board')}${renderJourneyBoardBody(previewBoard(url))}`, 'journeys', 'Property Predator — Live Journeys'),
    board: true,
  };
  if (path === '/portal/journeys') return {
    status: 200,
    html: shell(`${previewJourneyNav('rules')}${renderJourneyManagerBody(journeyManager)}`, 'journeys', 'Property Predator — Journey Rules'),
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
      : "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(rendered.html);
});

if (process.env.PROPERTY_PREDATOR_PREVIEW_IMPORT_ONLY !== '1') {
  server.listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`Property Predator preview ready at http://127.0.0.1:${PORT}/portal\n`);
  });
}
