import type {
  AuthorityCommentWatchSnapshot,
  DailyOutreachBreakdownSnapshot,
  DailyOutreachDraftSnapshot,
  DailyOutreachProgressSnapshot,
  DailyOutreachProspectSnapshot,
  DailyOutreachRecentOutcomeSnapshot,
  DailyOutreachSnapshot,
} from './daily-outreach-presenter.js';

export const PROPERTY_PREDATOR_DAILY_OUTREACH_AS_OF = '2026-09-02T08:15:00.000Z';

const HASH_A = '1f7a9b2c4d6e8f00112233445566778899aabbccddeeff001122334455667788';
const HASH_B = '2a8b0c3d5e7f90112233445566778899aabbccddeeff00112233445566778899';
const HASH_C = '3b9c1d4e6f80112233445566778899aabbccddeeff00112233445566778899aa';
const HASH_D = '4cad2e5f709112233445566778899aabbccddeeff00112233445566778899aab';

function draft(input: DailyOutreachDraftSnapshot): DailyOutreachDraftSnapshot {
  return Object.freeze({ ...input });
}

function progress(input: DailyOutreachProgressSnapshot): DailyOutreachProgressSnapshot {
  return Object.freeze({ ...input });
}

function prospect(input: DailyOutreachProspectSnapshot): DailyOutreachProspectSnapshot {
  return Object.freeze({
    ...input,
    draft: draft(input.draft),
    cooldown: Object.freeze({ ...input.cooldown }),
    outcome: Object.freeze({ ...input.outcome }),
    nextAction: Object.freeze({ ...input.nextAction }),
  });
}

function outcome(input: DailyOutreachRecentOutcomeSnapshot): DailyOutreachRecentOutcomeSnapshot {
  return Object.freeze({ ...input });
}

function breakdown(input: DailyOutreachBreakdownSnapshot): DailyOutreachBreakdownSnapshot {
  return Object.freeze({ ...input });
}

function watch(input: AuthorityCommentWatchSnapshot): AuthorityCommentWatchSnapshot {
  return Object.freeze({
    ...input,
    draft: input.draft ? draft(input.draft) : null,
    cooldown: Object.freeze({ ...input.cooldown }),
  });
}

/**
 * Fictional TEST-only operating snapshot. Every person, business, creator,
 * message and outcome below is invented and labelled. There are no profile
 * URLs, provider identifiers, live controls or production contact effects.
 */
export function createPropertyPredatorDailyOutreachFixture(): DailyOutreachSnapshot {
  const progressRows = Object.freeze([
    progress({
      progressId: 'fuel-linkedin-developers',
      channel: 'linkedin',
      segmentLabel: 'Active developers · FICTIONAL TEST SEGMENT',
      target: 6,
      completed: 4,
    }),
    progress({
      progressId: 'fuel-instagram-sourcers',
      channel: 'instagram',
      segmentLabel: 'Property sourcers · FICTIONAL TEST SEGMENT',
      target: 4,
      completed: 2,
    }),
    progress({
      progressId: 'fuel-creator-authority',
      channel: 'creator_watch',
      segmentLabel: 'Authority conversations · FICTIONAL TEST SEGMENT',
      target: 2,
      completed: 1,
    }),
  ]);

  const prospects = Object.freeze([
    prospect({
      prospectId: 'test-prospect-mara-vane',
      personLabel: 'Mara Vane · FICTIONAL TEST PERSON',
      organisationLabel: 'Northbank Works Lab · FICTIONAL TEST BUSINESS',
      roleLabel: 'Development operator · FICTIONAL ROLE',
      channel: 'linkedin',
      segmentLabel: 'Active developers · TEST',
      campaignLabel: 'Evidence before estimate · TEST CAMPAIGN',
      sourceLabel: 'Founder-approved TEST CSV · row 014',
      sourceEvidenceRef: 'test-source:approved-csv:014:v2',
      selectionReason: 'Strong audience fit, a recent fictional post about appraisal assumptions and no prior first touch in the TEST cadence.',
      priorityScore: 92,
      actionMode: 'manual_first_touch',
      actionModeReason: 'Cold LinkedIn outreach stays manual. Growth HQ may prepare context and record the operator evidence only.',
      eligibilityExpiresAt: '2026-09-02T11:15:00.000Z',
      draft: {
        versionId: 'test-draft-linkedin-first-touch-v7',
        contentSha256: HASH_A,
        status: 'draft_locked',
        body: 'Your fictional case note separated the asking price from the decision number. We are testing an evidence-first workflow for active UK property operators. Would a short fictional decision trail be useful?',
        approvedAt: null,
        approvedByLabel: null,
        providerEffects: false,
      },
      cooldown: { state: 'clear', until: null, stopReason: null },
      outcome: {
        outcome: 'pending',
        occurredAt: null,
        detail: 'No attempt has been recorded for this fictional prospect.',
      },
      nextAction: {
        label: 'Review the locked draft, then perform any first touch manually in LinkedIn and record evidence.',
        dueAt: '2026-09-02T09:30:00.000Z',
        ownerLabel: 'Riley Mercer · FICTIONAL TEST OPERATOR',
        journeyConsequence: 'Activity only. A cold attempt does not create a LAPS Lead.',
      },
    }),
    prospect({
      prospectId: 'test-prospect-eli-rook',
      personLabel: 'Eli Rook · FICTIONAL TEST PERSON',
      organisationLabel: 'Brickline Sourcing Studio · FICTIONAL TEST BUSINESS',
      roleLabel: 'Sourcing director · FICTIONAL ROLE',
      channel: 'instagram',
      segmentLabel: 'Property sourcers · TEST',
      campaignLabel: 'Source the assumption · TEST CAMPAIGN',
      sourceLabel: 'Owned-account TEST comment event',
      sourceEvidenceRef: 'test-zernio:owned-comment:event-2201',
      selectionReason: 'A fictional person asked a specific question on an owned TEST post, creating a supported reply context.',
      priorityScore: 89,
      actionMode: 'zernio_reply_eligible',
      actionModeReason: 'The TEST event represents an official owned-account comment reply surface. This presenter still creates no provider operation.',
      eligibilityExpiresAt: '2026-09-02T10:45:00.000Z',
      draft: {
        versionId: 'test-draft-owned-comment-reply-v3',
        contentSha256: HASH_B,
        status: 'approved_exact_version',
        body: 'Good question. In this fictional example, the next move is to trace the weakest assumption to its source and name the stopping condition before choosing an action. Which assumption would you verify first?',
        approvedAt: '2026-09-02T08:05:00.000Z',
        approvedByLabel: 'Casey Holt · FICTIONAL TEST APPROVER',
        providerEffects: false,
      },
      cooldown: { state: 'clear', until: null, stopReason: null },
      outcome: {
        outcome: 'replied',
        occurredAt: '2026-09-02T08:02:00.000Z',
        detail: 'A fictional inbound comment is present; no outbound reply has been created.',
      },
      nextAction: {
        label: 'Human-review the exact approved reply version; provider action is outside this fixture.',
        dueAt: '2026-09-02T08:45:00.000Z',
        ownerLabel: 'Riley Mercer · FICTIONAL TEST OPERATOR',
        journeyConsequence: 'A genuine identified TEST reply may project a LAPS Lead after evidence review.',
      },
    }),
    prospect({
      prospectId: 'test-prospect-sora-pike',
      personLabel: 'Sora Pike · FICTIONAL TEST PERSON',
      organisationLabel: 'Foundry Lettings Lab · FICTIONAL TEST BUSINESS',
      roleLabel: 'Portfolio operator · FICTIONAL ROLE',
      channel: 'linkedin',
      segmentLabel: 'Portfolio operators · TEST',
      campaignLabel: 'Evidence before estimate · TEST CAMPAIGN',
      sourceLabel: 'Manual TEST target · research note 021',
      sourceEvidenceRef: 'test-source:manual-note:021:v1',
      selectionReason: 'Audience fit was recorded, but a fictional suppression decision has absolute priority.',
      priorityScore: 84,
      actionMode: 'blocked',
      actionModeReason: 'The fictional record is suppressed for this purpose and channel.',
      eligibilityExpiresAt: null,
      draft: {
        versionId: 'test-draft-withheld-suppressed-v1',
        contentSha256: HASH_C,
        status: 'blocked',
        body: 'Draft intentionally withheld because the fictional person is suppressed.',
        approvedAt: null,
        approvedByLabel: null,
        providerEffects: false,
      },
      cooldown: {
        state: 'stopped',
        until: null,
        stopReason: 'STOP · fictional suppression decision for LinkedIn outreach.',
      },
      outcome: {
        outcome: 'suppressed',
        occurredAt: '2026-09-02T07:50:00.000Z',
        detail: 'The queue retained the stopping receipt and prevented an attempt.',
      },
      nextAction: {
        label: 'Keep stopped; no outreach task may be created.',
        dueAt: null,
        ownerLabel: 'Growth HQ policy rail · TEST',
        journeyConsequence: 'No LAPS evidence. The suppression receipt remains authoritative.',
      },
    }),
    prospect({
      prospectId: 'test-prospect-nico-fenn',
      personLabel: 'Nico Fenn · FICTIONAL TEST PERSON',
      organisationLabel: 'Mortar Map Studio · FICTIONAL TEST BUSINESS',
      roleLabel: 'Auction buyer · FICTIONAL ROLE',
      channel: 'linkedin',
      segmentLabel: 'Auction operators · TEST',
      campaignLabel: 'Decision trail opener · TEST CAMPAIGN',
      sourceLabel: 'Permissioned TEST directory import · row 008',
      sourceEvidenceRef: 'test-source:directory-import:008:v1',
      selectionReason: 'Good audience fit, but a prior fictional first touch is still inside its cooling-off window.',
      priorityScore: 80,
      actionMode: 'manual_first_touch',
      actionModeReason: 'Any later LinkedIn follow-up remains a manual task after the cooling-off window.',
      eligibilityExpiresAt: '2026-09-02T16:00:00.000Z',
      draft: {
        versionId: 'test-draft-follow-up-v2',
        contentSha256: HASH_D,
        status: 'draft_locked',
        body: 'A short fictional follow-up is locked, but the cooldown prevents review until the due time.',
        approvedAt: null,
        approvedByLabel: null,
        providerEffects: false,
      },
      cooldown: {
        state: 'cooling',
        until: '2026-09-02T14:00:00.000Z',
        stopReason: 'Do not retry before the fictional 72-hour cooling-off rule ends.',
      },
      outcome: {
        outcome: 'no_response',
        occurredAt: '2026-08-30T13:55:00.000Z',
        detail: 'One fictional manual first-touch receipt exists with no response.',
      },
      nextAction: {
        label: 'Wait for cooldown, then re-check ownership, source and channel eligibility.',
        dueAt: '2026-09-02T14:00:00.000Z',
        ownerLabel: 'Riley Mercer · FICTIONAL TEST OPERATOR',
        journeyConsequence: 'Remain activity-only unless a genuine response arrives.',
      },
    }),
  ]);

  const recentOutcomes = Object.freeze([
    outcome({
      receiptId: 'test-receipt-301',
      personLabel: 'Ari Vale · FICTIONAL TEST PERSON',
      channel: 'linkedin',
      outcome: 'attempted',
      occurredAt: '2026-09-02T07:42:00.000Z',
      detail: 'A fictional manual-attempt receipt captured the exact draft version and operator.',
      nextActionLabel: 'Await a response; no follow-up before the 72-hour TEST cooldown.',
    }),
    outcome({
      receiptId: 'test-receipt-302',
      personLabel: 'Wren Moss · FICTIONAL TEST PERSON',
      channel: 'instagram',
      outcome: 'positive',
      occurredAt: '2026-09-02T07:18:00.000Z',
      detail: 'A fictional owned-account reply asked for a worked example.',
      nextActionLabel: 'Create a human reply-review task and a TEST LAPS Lead evidence candidate.',
    }),
    outcome({
      receiptId: 'test-receipt-303',
      personLabel: 'Jules Hart · FICTIONAL TEST PERSON',
      channel: 'instagram',
      outcome: 'declined',
      occurredAt: '2026-09-02T06:55:00.000Z',
      detail: 'The fictional person declined further contact.',
      nextActionLabel: 'Stop the cadence and preserve the fictional decline receipt.',
    }),
  ]);

  const breakdowns = Object.freeze([
    breakdown({ breakdownId: 'breakdown-operator', dimension: 'operator', label: 'Riley Mercer · FICTIONAL TEST OPERATOR', attempts: 7, responses: 3, positiveResponses: 2, leads: 2, appointments: 1 }),
    breakdown({ breakdownId: 'breakdown-audience', dimension: 'audience', label: 'Active developers · TEST', attempts: 4, responses: 2, positiveResponses: 1, leads: 1, appointments: 1 }),
    breakdown({ breakdownId: 'breakdown-campaign', dimension: 'campaign', label: 'Evidence before estimate · TEST', attempts: 5, responses: 2, positiveResponses: 2, leads: 2, appointments: 1 }),
    breakdown({ breakdownId: 'breakdown-source', dimension: 'source', label: 'Founder-approved TEST CSV', attempts: 3, responses: 1, positiveResponses: 1, leads: 1, appointments: 0 }),
    breakdown({ breakdownId: 'breakdown-angle', dimension: 'angle', label: 'Name the weak assumption · TEST', attempts: 4, responses: 2, positiveResponses: 1, leads: 1, appointments: 1 }),
    breakdown({ breakdownId: 'breakdown-channel', dimension: 'channel', label: 'LinkedIn · manual TEST evidence', attempts: 5, responses: 2, positiveResponses: 1, leads: 1, appointments: 1 }),
  ]);

  const creatorWatch = Object.freeze([
    watch({
      watchId: 'test-watch-auction-signal',
      creatorLabel: 'Auction Signal Lab · FICTIONAL TEST CREATOR',
      platform: 'linkedin',
      postReference: 'TEST-POST-LI-144',
      postObservedAt: '2026-09-02T07:58:00.000Z',
      sourceEvidenceRef: 'test-watch:operator-supplied-post:li-144',
      concretePoint: 'The fictional post argues that faster catalogue triage matters only when the rejection reason is preserved.',
      decision: 'comment',
      decisionReason: 'Property Predator can extend the idea with a concise evidence-first question instead of generic praise.',
      purpose: 'ask_question',
      decisionVersionId: 'test-comment-decision-v4',
      decisionSha256: HASH_B,
      draft: {
        versionId: 'test-authority-comment-draft-v4',
        contentSha256: HASH_C,
        status: 'draft_locked',
        body: 'Speed is useful only if the rejection survives review. In this fictional catalogue, which single assumption would you force every shortlisted lot to prove?',
        approvedAt: null,
        approvedByLabel: null,
        providerEffects: false,
      },
      cooldown: { state: 'clear', until: null, stopReason: null },
      reviewMode: 'review_only',
    }),
    watch({
      watchId: 'test-watch-brickwise-briefing',
      creatorLabel: 'Brickwise Briefing · FICTIONAL TEST CREATOR',
      platform: 'instagram',
      postReference: 'TEST-POST-IG-207',
      postObservedAt: '2026-09-02T07:34:00.000Z',
      sourceEvidenceRef: 'test-watch:operator-supplied-post:ig-207',
      concretePoint: 'The fictional post is a broad motivational statement with no checkable property claim or useful question to extend.',
      decision: 'no_comment',
      decisionReason: 'No specific evidence to add. Generic praise would create noise, so no_comment is the higher-quality decision.',
      purpose: 'none',
      decisionVersionId: 'test-no-comment-decision-v2',
      decisionSha256: HASH_D,
      draft: null,
      cooldown: {
        state: 'cooling',
        until: '2026-09-03T08:00:00.000Z',
        stopReason: 'Per-creator TEST frequency cap: one reviewed opportunity per 24 hours.',
      },
      reviewMode: 'review_only',
    }),
  ]);

  return Object.freeze({
    workspaceId: 'workspace-property-predator-daily-outreach-test',
    workspaceName: 'Property Predator Growth HQ · TEST',
    operatorLabel: 'Riley Mercer · FICTIONAL TEST OPERATOR',
    snapshotAt: PROPERTY_PREDATOR_DAILY_OUTREACH_AS_OF,
    timezone: 'Europe/London',
    dataset: 'fictional_test',
    externalEffects: false,
    dailyTarget: 12,
    completed: 7,
    progress: progressRows,
    nextProspectId: 'test-prospect-mara-vane',
    prospects,
    recentOutcomes,
    manager: Object.freeze({
      prospectsReviewed: 19,
      validAttempts: 7,
      responses: 3,
      positiveResponses: 2,
      conversationsCreated: 3,
      lapsLeadsCreated: 2,
      lapsAppointmentsCreated: 1,
      callsAndTasksCompleted: 4,
      medianFirstResponseMinutes: 42,
      medianHumanHandoffMinutes: 11,
      duplicatesPrevented: 1,
      blockedAttempts: 2,
      suppressions: 1,
      providerFailures: 0,
    }),
    breakdowns,
    creatorWatch,
  });
}
