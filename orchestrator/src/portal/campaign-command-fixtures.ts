import type {
  CampaignApprovalSnapshot,
  CampaignChannelPlanSnapshot,
  CampaignCommandSnapshot,
  CampaignContentVersionSnapshot,
  CampaignOperatorActionSnapshot,
  CampaignTruthMetricSnapshot,
} from './campaign-command-presenter.js';

export const PROPERTY_PREDATOR_CAMPAIGN_COMMAND_AS_OF = '2026-08-26T10:00:00.000Z';

const REVISION_ID = 'campaign-revision-opportunity-autopsy-4';
const REVISION_SHA256 = 'a'.repeat(64);
const COHORT_SNAPSHOT_ID = 'cohort-snapshot-evidence-curious-20260826';
const COHORT_SHA256 = 'b'.repeat(64);
const OFFER_REVISION_ID = 'offer-revision-opportunity-autopsy-3';
const OFFER_SHA256 = 'c'.repeat(64);
const CONTENT_PACK_ID = 'content-pack-opportunity-autopsy-7';
const CONTENT_PACK_SHA256 = 'd'.repeat(64);
const WEBINAR_REVISION_ID = 'webinar-revision-opportunity-autopsy-live-2';
const WEBINAR_SHA256 = 'e'.repeat(64);

const VERSION_SOCIAL = 'content-version-evidence-post-3';
const VERSION_ARTWORK = 'content-version-evidence-artwork-4';
const VERSION_EMAIL = 'content-version-autopsy-email-2';
const VERSION_WEBINAR = 'content-version-autopsy-webinar-5';

function content(input: Readonly<{
  itemId: string;
  versionId: string;
  hashCharacter: string;
  versionNumber: number;
  title: string;
  kind: CampaignContentVersionSnapshot['kind'];
}>): CampaignContentVersionSnapshot {
  const contentSha256 = input.hashCharacter.repeat(64);
  return Object.freeze({
    contentItemId: input.itemId,
    contentVersionId: input.versionId,
    contentSha256,
    versionNumber: input.versionNumber,
    title: input.title,
    kind: input.kind,
    sourceSystem: 'propertypredator.company-content',
    approvalStatus: 'approved',
    approvalDecisionId: `approval-${input.versionId}`,
    approvedContentVersionId: input.versionId,
    approvedContentSha256: contentSha256,
    sourceProofExpiresAt: '2026-09-02T10:00:00.000Z',
  });
}

function channel(input: Omit<CampaignChannelPlanSnapshot, 'executionMode' | 'state'>): CampaignChannelPlanSnapshot {
  return Object.freeze({ ...input, executionMode: 'simulated', state: 'rehearsal_ready' });
}

function approval(input: Readonly<{
  scope: CampaignApprovalSnapshot['scope'];
  subjectId: string;
  subjectSha256: string;
}>): CampaignApprovalSnapshot {
  return Object.freeze({
    approvalId: `decision-${input.scope}-fixture`,
    scope: input.scope,
    subjectId: input.subjectId,
    subjectSha256: input.subjectSha256,
    status: 'approved',
    decidedAt: '2026-08-26T09:35:00.000Z',
    decidedByLabel: 'Growth HQ TEST approver',
  });
}

function metric(input: CampaignTruthMetricSnapshot): CampaignTruthMetricSnapshot {
  return Object.freeze(input);
}

function action(input: CampaignOperatorActionSnapshot): CampaignOperatorActionSnapshot {
  return Object.freeze(input);
}

/**
 * Entirely fictional TEST campaign planning data. Counts, budgets and targets
 * are simulated planning assumptions, never observed performance. Provider
 * performance fields deliberately stay unavailable until a real evidence feed
 * is separately authorised and connected.
 */
export function createPropertyPredatorCampaignCommandFixture(): CampaignCommandSnapshot {
  return Object.freeze({
    revision: Object.freeze({
      campaignId: 'campaign-opportunity-autopsy-launch',
      revisionId: REVISION_ID,
      revisionNumber: 4,
      revisionSha256: REVISION_SHA256,
      title: 'Opportunity Autopsy · Evidence Before Excitement',
      objective: 'Move a tightly defined Property Predator CRM cohort from evidence-led education, through a live diagnostic webinar, into a single Opportunity Autopsy booking offer.',
      ownerLabel: 'Property Predator Growth HQ · TEST desk',
      createdAt: '2026-08-26T09:15:00.000Z',
      state: 'immutable',
      environment: 'test',
    }),
    cohort: Object.freeze({
      cohortId: 'cohort-evidence-curious-developers',
      snapshotId: COHORT_SNAPSHOT_ID,
      snapshotSha256: COHORT_SHA256,
      label: 'Evidence-curious developers · no booked autopsy',
      definition: 'Fictional TEST contacts who engaged with planning, ownership or comparable-evidence education, have no active suppression and have not reached the booked-autopsy milestone.',
      eligiblePeople: 420,
      capturedAt: '2026-08-26T09:20:00.000Z',
      dataTruth: 'simulated',
      entryMilestoneId: 'milestone-evidence-curious',
    }),
    journey: Object.freeze({
      journeyId: 'journey-evidence-to-autopsy',
      label: 'Evidence curiosity → Opportunity Autopsy',
      milestones: Object.freeze([
        Object.freeze({
          milestoneId: 'milestone-evidence-curious',
          label: 'Evidence curious',
          operatorMeaning: 'Entered the exact CRM cohort snapshot for this campaign revision.',
          order: 1,
          role: 'entry',
        }),
        Object.freeze({
          milestoneId: 'milestone-proof-consumed',
          label: 'Proof consumed',
          operatorMeaning: 'Consumed approved planning, ownership or comparable-evidence content.',
          order: 2,
          role: 'education',
        }),
        Object.freeze({
          milestoneId: 'milestone-webinar-registered',
          label: 'Webinar registered',
          operatorMeaning: 'Completed the simulated registration step for the diagnostic session.',
          order: 3,
          role: 'intent',
        }),
        Object.freeze({
          milestoneId: 'milestone-webinar-attended',
          label: 'Attended live',
          operatorMeaning: 'Attendance would be evidenced by a future signed webinar event.',
          order: 4,
          role: 'intent',
        }),
        Object.freeze({
          milestoneId: 'milestone-replay-consumed',
          label: 'Replay consumed',
          operatorMeaning: 'Replay depth would be evidenced separately from live attendance.',
          order: 5,
          role: 'education',
        }),
        Object.freeze({
          milestoneId: 'milestone-autopsy-booked',
          label: 'Autopsy booked',
          operatorMeaning: 'Reached the one approved conversion offer and booked the diagnostic.',
          order: 6,
          role: 'conversion',
        }),
      ]),
    }),
    contentPack: Object.freeze({
      contentPackId: CONTENT_PACK_ID,
      contentPackSha256: CONTENT_PACK_SHA256,
    }),
    contentVersions: Object.freeze([
      content({
        itemId: 'content-evidence-post',
        versionId: VERSION_SOCIAL,
        hashCharacter: '1',
        versionNumber: 3,
        title: 'The postcode is not the opportunity. The evidence is.',
        kind: 'social_post',
      }),
      content({
        itemId: 'content-evidence-artwork',
        versionId: VERSION_ARTWORK,
        hashCharacter: '2',
        versionNumber: 4,
        title: 'Opportunity Autopsy · Evidence stack artwork',
        kind: 'image',
      }),
      content({
        itemId: 'content-autopsy-email',
        versionId: VERSION_EMAIL,
        hashCharacter: '3',
        versionNumber: 2,
        title: 'The evidence your postcode cannot give you',
        kind: 'email',
      }),
      content({
        itemId: 'content-autopsy-webinar',
        versionId: VERSION_WEBINAR,
        hashCharacter: '4',
        versionNumber: 5,
        title: 'Kill the deal before it kills your capital · webinar runbook',
        kind: 'webinar',
      }),
    ]),
    offer: Object.freeze({
      offerId: 'offer-opportunity-autopsy',
      offerRevisionId: OFFER_REVISION_ID,
      offerSha256: OFFER_SHA256,
      label: 'Property Predator Opportunity Autopsy',
      promise: 'A focused diagnostic that exposes the planning, ownership, comparable and development-risk evidence before excitement becomes expensive.',
      callToAction: 'Book the Opportunity Autopsy',
      destinationLabel: 'Opportunity Autopsy booking page · TEST destination',
      destinationUrl: 'https://propertypredator.co.uk/opportunity-autopsy',
    }),
    channels: Object.freeze([
      channel({
        planId: 'plan-linkedin-authority',
        channel: 'linkedin',
        contentVersionId: VERSION_SOCIAL,
        milestoneId: 'milestone-proof-consumed',
        objective: 'Make evidence-first deal analysis the category point of view.',
        scheduledFor: '2026-08-27T08:30:00.000Z',
        cadenceLabel: 'Authority opener · day 1',
      }),
      channel({
        planId: 'plan-instagram-evidence',
        channel: 'instagram',
        contentVersionId: VERSION_ARTWORK,
        milestoneId: 'milestone-proof-consumed',
        objective: 'Turn the four-part evidence stack into a saveable visual diagnostic.',
        scheduledFor: '2026-08-27T12:15:00.000Z',
        cadenceLabel: 'Carousel proof · day 1',
      }),
      channel({
        planId: 'plan-facebook-education',
        channel: 'facebook',
        contentVersionId: VERSION_SOCIAL,
        milestoneId: 'milestone-proof-consumed',
        objective: 'Open the risk conversation with property investor communities.',
        scheduledFor: '2026-08-28T10:00:00.000Z',
        cadenceLabel: 'Education cut · day 2',
      }),
      channel({
        planId: 'plan-email-registration',
        channel: 'email',
        contentVersionId: VERSION_EMAIL,
        milestoneId: 'milestone-webinar-registered',
        objective: 'Move evidence-aware leads toward the diagnostic webinar.',
        scheduledFor: '2026-08-28T13:30:00.000Z',
        cadenceLabel: 'Registration invite · day 2',
      }),
      channel({
        planId: 'plan-whatsapp-reminder',
        channel: 'whatsapp',
        contentVersionId: VERSION_EMAIL,
        milestoneId: 'milestone-webinar-attended',
        objective: 'Rehearse a consent-gated reminder for registered TEST contacts only.',
        scheduledFor: '2026-08-30T15:00:00.000Z',
        cadenceLabel: 'Consent-gated reminder · T−120',
      }),
    ]),
    webinar: Object.freeze({
      webinarId: 'webinar-opportunity-autopsy-live',
      webinarRevisionId: WEBINAR_REVISION_ID,
      webinarSha256: WEBINAR_SHA256,
      title: 'Kill the Deal Before It Kills Your Capital',
      sessionAt: '2026-08-30T17:00:00.000Z',
      durationMinutes: 55,
      contentVersionId: VERSION_WEBINAR,
      registrationMilestoneId: 'milestone-webinar-registered',
      attendanceMilestoneId: 'milestone-webinar-attended',
      replayMilestoneId: 'milestone-replay-consumed',
      providerMode: 'simulated',
      state: 'rehearsal_ready',
    }),
    targets: Object.freeze([
      Object.freeze({ targetId: 'target-entry', milestoneId: 'milestone-evidence-curious', label: 'Eligible cohort', targetCount: 420, source: 'simulated_plan' }),
      Object.freeze({ targetId: 'target-proof', milestoneId: 'milestone-proof-consumed', label: 'Proof consumers', targetCount: 260, source: 'simulated_plan' }),
      Object.freeze({ targetId: 'target-registered', milestoneId: 'milestone-webinar-registered', label: 'Registrations', targetCount: 96, source: 'simulated_plan' }),
      Object.freeze({ targetId: 'target-attended', milestoneId: 'milestone-webinar-attended', label: 'Live attendees', targetCount: 58, source: 'simulated_plan' }),
      Object.freeze({ targetId: 'target-replay', milestoneId: 'milestone-replay-consumed', label: 'Replay consumers', targetCount: 34, source: 'simulated_plan' }),
      Object.freeze({ targetId: 'target-booked', milestoneId: 'milestone-autopsy-booked', label: 'Autopsies booked', targetCount: 14, source: 'simulated_plan' }),
    ]),
    approvals: Object.freeze([
      approval({ scope: 'campaign_revision', subjectId: REVISION_ID, subjectSha256: REVISION_SHA256 }),
      approval({ scope: 'audience', subjectId: COHORT_SNAPSHOT_ID, subjectSha256: COHORT_SHA256 }),
      approval({ scope: 'offer', subjectId: OFFER_REVISION_ID, subjectSha256: OFFER_SHA256 }),
      approval({ scope: 'content_pack', subjectId: CONTENT_PACK_ID, subjectSha256: CONTENT_PACK_SHA256 }),
      approval({ scope: 'webinar', subjectId: WEBINAR_REVISION_ID, subjectSha256: WEBINAR_SHA256 }),
    ]),
    metrics: Object.freeze([
      metric({
        metricId: 'metric-planned-budget',
        label: 'Planned media budget',
        value: 4_800,
        format: 'currency',
        truth: 'simulated',
        periodLabel: 'Campaign plan · full run',
        detail: 'A fictional planning ceiling for rehearsal math; no money is reserved or spent.',
      }),
      metric({
        metricId: 'metric-target-cpa',
        label: 'Target booked-autopsy cost',
        value: 120,
        format: 'currency',
        truth: 'simulated',
        periodLabel: 'Planning assumption',
        detail: 'A target assumption, not observed acquisition performance.',
      }),
      metric({
        metricId: 'metric-target-show-rate',
        label: 'Target live show-up',
        value: 60.4,
        format: 'percent',
        truth: 'simulated',
        periodLabel: 'Planning assumption',
        detail: 'Derived from the fictional registration and attendance targets above.',
      }),
      metric({
        metricId: 'metric-actual-spend',
        label: 'Measured provider spend',
        value: null,
        format: 'currency',
        truth: 'unavailable',
        periodLabel: 'No provider period',
        detail: 'Unavailable because no advertising or delivery provider is connected.',
      }),
      metric({
        metricId: 'metric-delivered-reach',
        label: 'Measured delivered reach',
        value: null,
        format: 'integer',
        truth: 'unavailable',
        periodLabel: 'No provider period',
        detail: 'Unavailable until signed provider evidence exists.',
      }),
      metric({
        metricId: 'metric-registrations',
        label: 'Measured registrations',
        value: null,
        format: 'integer',
        truth: 'unavailable',
        periodLabel: 'No webinar period',
        detail: 'Unavailable; the 96 shown in the journey is a simulated target only.',
      }),
      metric({
        metricId: 'metric-attributed-revenue',
        label: 'Measured attributed revenue',
        value: null,
        format: 'currency',
        truth: 'unavailable',
        periodLabel: 'No attribution period',
        detail: 'Unavailable because no live conversion or payment evidence is connected.',
      }),
    ]),
    nextActions: Object.freeze([
      action({
        actionId: 'action-room-rehearsal',
        label: 'Run the 55-minute webinar room rehearsal',
        detail: 'Walk through entry, attendance and replay evidence with fictional TEST identities; record no provider claims.',
        ownerLabel: 'Events test desk',
        dueAt: '2026-08-27T15:00:00.000Z',
        priority: 'now',
        state: 'ready',
      }),
      action({
        actionId: 'action-offer-qa',
        label: 'QA the single-offer handoff',
        detail: 'Confirm every channel and webinar close resolves to the exact Opportunity Autopsy revision and no competing CTA appears.',
        ownerLabel: 'Conversion test desk',
        dueAt: '2026-08-27T17:00:00.000Z',
        priority: 'now',
        state: 'ready',
      }),
      action({
        actionId: 'action-consent-walkthrough',
        label: 'Walk the WhatsApp consent failure path',
        detail: 'Demonstrate that a withdrawn or absent purpose-specific consent closes the queue before any provider boundary.',
        ownerLabel: 'Lifecycle test desk',
        dueAt: '2026-08-28T10:00:00.000Z',
        priority: 'next',
        state: 'ready',
      }),
      action({
        actionId: 'action-live-evidence',
        label: 'Define the future live evidence pack',
        detail: 'List the separate authorisations, signed webhooks, domain proofs and cost feeds required before measured performance can exist.',
        ownerLabel: 'Platform owner',
        dueAt: null,
        priority: 'later',
        state: 'waiting',
      }),
    ]),
  });
}
