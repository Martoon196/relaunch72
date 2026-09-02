/**
 * Pure Daily Outreach presentation model.
 *
 * The cockpit is deliberately fixture-only and has no command, provider or
 * persistence dependency. It can explain the next permitted operator action;
 * it cannot perform that action.
 */

export const DAILY_OUTREACH_ROUTE = '/portal/outreach/daily' as const;
export const DAILY_OUTREACH_MAX_TEXT = 360;
export const DAILY_OUTREACH_MAX_PROSPECTS = 16;
export const DAILY_OUTREACH_MAX_OUTCOMES = 12;
export const DAILY_OUTREACH_MAX_WATCH_ITEMS = 8;
export const DAILY_OUTREACH_MAX_BREAKDOWNS = 12;

export type DailyOutreachChannel = 'linkedin' | 'instagram' | 'creator_watch';
export type DailyOutreachActionMode = 'manual_first_touch' | 'zernio_reply_eligible' | 'blocked';
export type DailyOutreachApprovalState = 'draft_locked' | 'approved_exact_version' | 'blocked';
export type DailyOutreachCooldownState = 'clear' | 'cooling' | 'stopped';
export type DailyOutreachOutcome =
  | 'pending'
  | 'attempted'
  | 'replied'
  | 'positive'
  | 'referred'
  | 'booked'
  | 'declined'
  | 'no_response'
  | 'invalid_target'
  | 'suppressed';
export type AuthorityCommentDecision = 'comment' | 'no_comment';
export type AuthorityCommentPurpose =
  | 'add_evidence'
  | 'extend_idea'
  | 'ask_question'
  | 'counterpoint'
  | 'open_conversation'
  | 'none';

export interface DailyOutreachProgressSnapshot {
  readonly progressId: string;
  readonly channel: DailyOutreachChannel;
  readonly segmentLabel: string;
  readonly target: number;
  readonly completed: number;
}

export interface DailyOutreachDraftSnapshot {
  readonly versionId: string;
  readonly contentSha256: string;
  readonly status: DailyOutreachApprovalState;
  readonly body: string;
  readonly approvedAt: string | null;
  readonly approvedByLabel: string | null;
  readonly providerEffects: false;
}

export interface DailyOutreachCooldownSnapshot {
  readonly state: DailyOutreachCooldownState;
  readonly until: string | null;
  readonly stopReason: string | null;
}

export interface DailyOutreachOutcomeSnapshot {
  readonly outcome: DailyOutreachOutcome;
  readonly occurredAt: string | null;
  readonly detail: string;
}

export interface DailyOutreachNextActionSnapshot {
  readonly label: string;
  readonly dueAt: string | null;
  readonly ownerLabel: string;
  readonly journeyConsequence: string;
}

export interface DailyOutreachProspectSnapshot {
  readonly prospectId: string;
  readonly personLabel: string;
  readonly organisationLabel: string;
  readonly roleLabel: string;
  readonly channel: DailyOutreachChannel;
  readonly segmentLabel: string;
  readonly campaignLabel: string;
  readonly sourceLabel: string;
  /** Opaque fixture evidence reference, never a profile URL or credential. */
  readonly sourceEvidenceRef: string;
  readonly selectionReason: string;
  readonly priorityScore: number;
  readonly actionMode: DailyOutreachActionMode;
  readonly actionModeReason: string;
  readonly eligibilityExpiresAt: string | null;
  readonly draft: DailyOutreachDraftSnapshot;
  readonly cooldown: DailyOutreachCooldownSnapshot;
  readonly outcome: DailyOutreachOutcomeSnapshot;
  readonly nextAction: DailyOutreachNextActionSnapshot;
}

export interface DailyOutreachRecentOutcomeSnapshot {
  readonly receiptId: string;
  readonly personLabel: string;
  readonly channel: DailyOutreachChannel;
  readonly outcome: DailyOutreachOutcome;
  readonly occurredAt: string;
  readonly detail: string;
  readonly nextActionLabel: string;
}

export interface DailyOutreachManagerSnapshot {
  readonly prospectsReviewed: number;
  readonly validAttempts: number;
  readonly responses: number;
  readonly positiveResponses: number;
  readonly conversationsCreated: number;
  readonly lapsLeadsCreated: number;
  readonly lapsAppointmentsCreated: number;
  readonly callsAndTasksCompleted: number;
  readonly medianFirstResponseMinutes: number | null;
  readonly medianHumanHandoffMinutes: number | null;
  readonly duplicatesPrevented: number;
  readonly blockedAttempts: number;
  readonly suppressions: number;
  readonly providerFailures: number;
}

export interface DailyOutreachBreakdownSnapshot {
  readonly breakdownId: string;
  readonly dimension: 'operator' | 'audience' | 'campaign' | 'source' | 'angle' | 'channel';
  readonly label: string;
  readonly attempts: number;
  readonly responses: number;
  readonly positiveResponses: number;
  readonly leads: number;
  readonly appointments: number;
}

export interface AuthorityCommentWatchSnapshot {
  readonly watchId: string;
  readonly creatorLabel: string;
  readonly platform: 'linkedin' | 'instagram';
  readonly postReference: string;
  readonly postObservedAt: string;
  readonly sourceEvidenceRef: string;
  readonly concretePoint: string;
  readonly decision: AuthorityCommentDecision;
  readonly decisionReason: string;
  readonly purpose: AuthorityCommentPurpose;
  readonly decisionVersionId: string;
  readonly decisionSha256: string;
  readonly draft: DailyOutreachDraftSnapshot | null;
  readonly cooldown: DailyOutreachCooldownSnapshot;
  readonly reviewMode: 'review_only' | 'blocked';
}

export interface DailyOutreachSnapshot {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly operatorLabel: string;
  readonly snapshotAt: string;
  readonly timezone: string;
  readonly dataset: 'fictional_test';
  readonly externalEffects: false;
  readonly dailyTarget: number;
  readonly completed: number;
  readonly progress: readonly DailyOutreachProgressSnapshot[];
  readonly nextProspectId: string;
  readonly prospects: readonly DailyOutreachProspectSnapshot[];
  readonly recentOutcomes: readonly DailyOutreachRecentOutcomeSnapshot[];
  readonly manager: DailyOutreachManagerSnapshot;
  readonly breakdowns: readonly DailyOutreachBreakdownSnapshot[];
  readonly creatorWatch: readonly AuthorityCommentWatchSnapshot[];
}

export type DailyOutreachTone = 'cyan' | 'manual' | 'supported' | 'blocked' | 'positive' | 'warning' | 'muted';

export interface DailyOutreachProgressView {
  readonly progressId: string;
  readonly channel: DailyOutreachChannel;
  readonly channelLabel: string;
  readonly segmentLabel: string;
  readonly target: number;
  readonly completed: number;
  readonly progressPercent: number;
  readonly progressLabel: string;
}

export interface DailyOutreachProspectView {
  readonly prospectId: string;
  readonly anchorId: string;
  readonly personLabel: string;
  readonly organisationLabel: string;
  readonly roleLabel: string;
  readonly channel: DailyOutreachChannel;
  readonly channelLabel: string;
  readonly segmentLabel: string;
  readonly campaignLabel: string;
  readonly sourceLabel: string;
  readonly sourceEvidenceRef: string;
  readonly selectionReason: string;
  readonly priorityScore: number;
  readonly priorityLabel: string;
  readonly actionMode: DailyOutreachActionMode;
  readonly actionModeLabel: string;
  readonly actionModeReason: string;
  readonly actionTone: DailyOutreachTone;
  readonly eligibilityExpiresAt: string | null;
  readonly eligibilityLabel: string;
  readonly draft: Readonly<{
    versionId: string;
    contentSha256: string;
    hashLabel: string;
    status: DailyOutreachApprovalState;
    statusLabel: string;
    body: string;
    approvedAt: string | null;
    approvedByLabel: string | null;
    immutable: true;
    providerEffects: false;
  }>;
  readonly cooldown: Readonly<{
    state: DailyOutreachCooldownState;
    stateLabel: string;
    until: string | null;
    stopReason: string | null;
    tone: DailyOutreachTone;
  }>;
  readonly outcome: Readonly<{
    outcome: DailyOutreachOutcome;
    label: string;
    occurredAt: string | null;
    detail: string;
    tone: DailyOutreachTone;
  }>;
  readonly nextAction: Readonly<{
    label: string;
    dueAt: string | null;
    dueLabel: string;
    ownerLabel: string;
    journeyConsequence: string;
  }>;
  readonly failClosed: boolean;
  readonly failClosedReason: string | null;
}

export interface DailyOutreachRecentOutcomeView {
  readonly receiptId: string;
  readonly personLabel: string;
  readonly channel: DailyOutreachChannel;
  readonly channelLabel: string;
  readonly outcome: DailyOutreachOutcome;
  readonly outcomeLabel: string;
  readonly tone: DailyOutreachTone;
  readonly occurredAt: string;
  readonly occurredLabel: string;
  readonly detail: string;
  readonly nextActionLabel: string;
}

export interface DailyOutreachBreakdownView extends DailyOutreachBreakdownSnapshot {
  readonly dimensionLabel: string;
  readonly responseRateLabel: string;
  readonly positiveRateLabel: string;
}

export interface AuthorityCommentWatchView {
  readonly watchId: string;
  readonly anchorId: string;
  readonly creatorLabel: string;
  readonly platform: 'linkedin' | 'instagram';
  readonly platformLabel: string;
  readonly postReference: string;
  readonly postObservedAt: string;
  readonly postObservedLabel: string;
  readonly sourceEvidenceRef: string;
  readonly concretePoint: string;
  readonly decision: AuthorityCommentDecision;
  readonly decisionLabel: 'COMMENT' | 'no_comment';
  readonly decisionReason: string;
  readonly purpose: AuthorityCommentPurpose;
  readonly purposeLabel: string;
  readonly decisionVersionId: string;
  readonly decisionSha256: string;
  readonly decisionHashLabel: string;
  readonly draft: DailyOutreachProspectView['draft'] | null;
  readonly cooldown: DailyOutreachProspectView['cooldown'];
  readonly reviewMode: 'review_only' | 'blocked';
  readonly reviewModeLabel: string;
  readonly failClosed: boolean;
}

export interface DailyOutreachView {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly operatorLabel: string;
  readonly snapshotAt: string;
  readonly snapshotLabel: string;
  readonly timezone: string;
  readonly dataset: 'fictional_test';
  readonly datasetLabel: 'FICTIONAL TEST DATA';
  readonly externalEffects: false;
  readonly providerEffects: 'none';
  readonly progress: Readonly<{
    dailyTarget: number;
    completed: number;
    remaining: number;
    progressPercent: number;
    progressLabel: string;
    channels: readonly DailyOutreachProgressView[];
  }>;
  readonly nextProspect: DailyOutreachProspectView;
  readonly prospects: readonly DailyOutreachProspectView[];
  readonly recentOutcomes: readonly DailyOutreachRecentOutcomeView[];
  readonly manager: DailyOutreachManagerSnapshot & Readonly<{
    responseRateLabel: string;
    positiveResponseRateLabel: string;
    medianFirstResponseLabel: string;
    medianHumanHandoffLabel: string;
  }>;
  readonly breakdowns: readonly DailyOutreachBreakdownView[];
  readonly creatorWatch: readonly AuthorityCommentWatchView[];
  readonly integrity: Readonly<{
    coherent: boolean;
    label: 'COHERENT TEST FIXTURE' | 'CHECK REQUIRED';
    issues: readonly string[];
  }>;
  readonly inputTruncated: boolean;
  readonly safety: Readonly<{
    liveAuthorised: false;
    providerOperationsCreated: 0;
    contactEffects: false;
    commandBoundaryAvailable: false;
  }>;
}

const CHANNEL_LABELS: Readonly<Record<DailyOutreachChannel, string>> = Object.freeze({
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  creator_watch: 'Creator Watch',
});

const ACTION_MODE_LABELS: Readonly<Record<DailyOutreachActionMode, string>> = Object.freeze({
  manual_first_touch: 'MANUAL FIRST TOUCH',
  zernio_reply_eligible: 'ZERNIO-SUPPORTED',
  blocked: 'BLOCKED',
});

const APPROVAL_LABELS: Readonly<Record<DailyOutreachApprovalState, string>> = Object.freeze({
  draft_locked: 'DRAFT · LOCKED',
  approved_exact_version: 'APPROVED · EXACT VERSION',
  blocked: 'BLOCKED · NO APPROVAL',
});

const OUTCOME_LABELS: Readonly<Record<DailyOutreachOutcome, string>> = Object.freeze({
  pending: 'PENDING',
  attempted: 'ATTEMPTED',
  replied: 'REPLIED',
  positive: 'POSITIVE',
  referred: 'REFERRED',
  booked: 'BOOKED',
  declined: 'DECLINED',
  no_response: 'NO RESPONSE',
  invalid_target: 'INVALID TARGET',
  suppressed: 'SUPPRESSED',
});

const PURPOSE_LABELS: Readonly<Record<AuthorityCommentPurpose, string>> = Object.freeze({
  add_evidence: 'Add useful evidence',
  extend_idea: 'Extend the idea',
  ask_question: 'Ask a sharp question',
  counterpoint: 'Offer a relevant counterpoint',
  open_conversation: 'Open a genuine conversation',
  none: 'No comment purpose',
});

function boundedText(value: unknown, fallback = 'Unavailable'): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).slice(0, DAILY_OUTREACH_MAX_TEXT);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function percent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100)));
}

function rateLabel(numerator: number, denominator: number): string {
  if (denominator <= 0 || numerator < 0 || numerator > denominator) return 'Unavailable';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function instant(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatInstant(value: string | null, timezone: string): string {
  const parsed = instant(value);
  if (parsed === null) return 'Not scheduled';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timezone,
    }).format(new Date(parsed));
  } catch {
    return new Date(parsed).toISOString().slice(0, 16).replace('T', ' · ');
  }
}

function anchorId(prefix: string, value: string): string {
  const safe = value.toLocaleLowerCase('en-GB').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${prefix}-${safe || 'item'}`;
}

function modeTone(mode: DailyOutreachActionMode): DailyOutreachTone {
  if (mode === 'manual_first_touch') return 'manual';
  if (mode === 'zernio_reply_eligible') return 'supported';
  return 'blocked';
}

function outcomeTone(outcome: DailyOutreachOutcome): DailyOutreachTone {
  if (outcome === 'positive' || outcome === 'booked' || outcome === 'replied' || outcome === 'referred') return 'positive';
  if (outcome === 'declined' || outcome === 'invalid_target' || outcome === 'suppressed') return 'blocked';
  if (outcome === 'no_response') return 'warning';
  return 'muted';
}

function presentDraft(
  draft: DailyOutreachDraftSnapshot,
  timezone: string,
): DailyOutreachProspectView['draft'] {
  const versionId = boundedText(draft.versionId);
  const contentSha256 = boundedText(draft.contentSha256);
  return Object.freeze({
    versionId,
    contentSha256,
    hashLabel: contentSha256.length >= 12 ? `${contentSha256.slice(0, 12)}…` : contentSha256,
    status: draft.status,
    statusLabel: APPROVAL_LABELS[draft.status],
    body: boundedText(draft.body, 'Draft intentionally withheld.'),
    approvedAt: draft.approvedAt,
    approvedByLabel: draft.approvedByLabel ? boundedText(draft.approvedByLabel) : null,
    immutable: true,
    providerEffects: false,
  });
}

function presentCooldown(
  cooldown: DailyOutreachCooldownSnapshot,
  timezone: string,
): DailyOutreachProspectView['cooldown'] {
  if (cooldown.state === 'stopped') {
    return Object.freeze({
      state: cooldown.state,
      stateLabel: 'STOPPED',
      until: null,
      stopReason: boundedText(cooldown.stopReason, 'A stopping rule is active.'),
      tone: 'blocked',
    });
  }
  if (cooldown.state === 'cooling') {
    return Object.freeze({
      state: cooldown.state,
      stateLabel: `COOLDOWN · ${formatInstant(cooldown.until, timezone)}`,
      until: cooldown.until,
      stopReason: cooldown.stopReason ? boundedText(cooldown.stopReason) : null,
      tone: 'warning',
    });
  }
  return Object.freeze({
    state: 'clear',
    stateLabel: 'CLEAR TO REVIEW',
    until: null,
    stopReason: null,
    tone: 'positive',
  });
}

function presentProspect(
  prospect: DailyOutreachProspectSnapshot,
  snapshotAtMs: number | null,
  timezone: string,
  issues: string[],
): DailyOutreachProspectView {
  const sourceEvidenceRef = boundedText(prospect.sourceEvidenceRef, '');
  const expiryMs = instant(prospect.eligibilityExpiresAt);
  const sourceMissing = sourceEvidenceRef.length === 0;
  const staleEligibility = prospect.actionMode !== 'blocked'
    && (expiryMs === null || snapshotAtMs === null || expiryMs <= snapshotAtMs);
  const invalidDraft = prospect.draft.providerEffects !== false
    || boundedText(prospect.draft.versionId, '').length === 0
    || boundedText(prospect.draft.contentSha256, '').length < 12;
  const stopped = prospect.cooldown.state === 'stopped';
  const cooling = prospect.cooldown.state === 'cooling';
  const evidenceFailure = sourceMissing || staleEligibility || invalidDraft;
  const failClosed = evidenceFailure || stopped || cooling;
  let failClosedReason: string | null = null;
  if (sourceMissing) failClosedReason = 'Source evidence is missing.';
  else if (staleEligibility) failClosedReason = 'Channel eligibility is missing or stale.';
  else if (invalidDraft) failClosedReason = 'Immutable draft evidence is incomplete.';
  else if (stopped) failClosedReason = boundedText(prospect.cooldown.stopReason, 'A stopping rule is active.');
  else if (cooling) failClosedReason = `Cooldown prevents another attempt until ${formatInstant(prospect.cooldown.until, timezone)}.`;
  if (evidenceFailure && prospect.actionMode !== 'blocked') {
    issues.push(`${boundedText(prospect.prospectId)} failed closed: ${failClosedReason}`);
  }
  const actionMode: DailyOutreachActionMode = failClosed ? 'blocked' : prospect.actionMode;
  const cooldown = presentCooldown(prospect.cooldown, timezone);
  const outcome = prospect.outcome;
  return Object.freeze({
    prospectId: boundedText(prospect.prospectId),
    anchorId: anchorId('pdo-prospect', prospect.prospectId),
    personLabel: boundedText(prospect.personLabel),
    organisationLabel: boundedText(prospect.organisationLabel),
    roleLabel: boundedText(prospect.roleLabel),
    channel: prospect.channel,
    channelLabel: CHANNEL_LABELS[prospect.channel],
    segmentLabel: boundedText(prospect.segmentLabel),
    campaignLabel: boundedText(prospect.campaignLabel),
    sourceLabel: boundedText(prospect.sourceLabel),
    sourceEvidenceRef: sourceEvidenceRef || 'Missing source evidence',
    selectionReason: boundedText(prospect.selectionReason),
    priorityScore: Math.min(100, count(prospect.priorityScore)),
    priorityLabel: `${Math.min(100, count(prospect.priorityScore))}/100 fit`,
    actionMode,
    actionModeLabel: ACTION_MODE_LABELS[actionMode],
    actionModeReason: failClosed
      ? boundedText(failClosedReason, 'Eligibility failed closed.')
      : boundedText(prospect.actionModeReason),
    actionTone: modeTone(actionMode),
    eligibilityExpiresAt: prospect.eligibilityExpiresAt,
    eligibilityLabel: actionMode === 'blocked'
      ? 'No executable route'
      : `Eligibility checked to ${formatInstant(prospect.eligibilityExpiresAt, timezone)}`,
    draft: presentDraft(prospect.draft, timezone),
    cooldown,
    outcome: Object.freeze({
      outcome: outcome.outcome,
      label: OUTCOME_LABELS[outcome.outcome],
      occurredAt: outcome.occurredAt,
      detail: boundedText(outcome.detail),
      tone: outcomeTone(outcome.outcome),
    }),
    nextAction: Object.freeze({
      label: evidenceFailure && actionMode === 'blocked'
        ? 'Resolve the blocker; do not contact this fixture prospect.'
        : boundedText(prospect.nextAction.label),
      dueAt: prospect.nextAction.dueAt,
      dueLabel: formatInstant(prospect.nextAction.dueAt, timezone),
      ownerLabel: boundedText(prospect.nextAction.ownerLabel),
      journeyConsequence: boundedText(prospect.nextAction.journeyConsequence),
    }),
    failClosed,
    failClosedReason,
  });
}

function presentWatchItem(
  item: AuthorityCommentWatchSnapshot,
  snapshotAtMs: number | null,
  timezone: string,
  issues: string[],
): AuthorityCommentWatchView {
  const sourceEvidenceRef = boundedText(item.sourceEvidenceRef, '');
  const decisionVersionId = boundedText(item.decisionVersionId, '');
  const decisionSha256 = boundedText(item.decisionSha256, '');
  const draftRequired = item.decision === 'comment';
  const malformedDecision = sourceEvidenceRef.length === 0
    || decisionVersionId.length === 0
    || decisionSha256.length < 12
    || (draftRequired && item.draft === null)
    || (!draftRequired && item.purpose !== 'none');
  const cooldown = presentCooldown(item.cooldown, timezone);
  const stopped = item.cooldown.state === 'stopped';
  const failClosed = malformedDecision || stopped;
  if (malformedDecision) issues.push(`${boundedText(item.watchId)} has incomplete commenter decision evidence.`);
  const draft = item.draft ? presentDraft(item.draft, timezone) : null;
  const reviewMode = failClosed ? 'blocked' : item.reviewMode;
  return Object.freeze({
    watchId: boundedText(item.watchId),
    anchorId: anchorId('pdo-watch', item.watchId),
    creatorLabel: boundedText(item.creatorLabel),
    platform: item.platform,
    platformLabel: CHANNEL_LABELS[item.platform],
    postReference: boundedText(item.postReference),
    postObservedAt: item.postObservedAt,
    postObservedLabel: formatInstant(item.postObservedAt, timezone),
    sourceEvidenceRef: sourceEvidenceRef || 'Missing source evidence',
    concretePoint: boundedText(item.concretePoint),
    decision: item.decision,
    decisionLabel: item.decision === 'comment' ? 'COMMENT' : 'no_comment',
    decisionReason: boundedText(item.decisionReason),
    purpose: item.purpose,
    purposeLabel: PURPOSE_LABELS[item.purpose],
    decisionVersionId: decisionVersionId || 'Missing decision version',
    decisionSha256: decisionSha256 || 'Missing decision hash',
    decisionHashLabel: decisionSha256.length >= 12 ? `${decisionSha256.slice(0, 12)}…` : decisionSha256,
    draft,
    cooldown,
    reviewMode,
    reviewModeLabel: reviewMode === 'review_only' ? 'REVIEW ONLY · NO POST CONTROL' : 'BLOCKED',
    failClosed,
  });
}

export function presentDailyOutreach(snapshot: DailyOutreachSnapshot): DailyOutreachView {
  if (snapshot.prospects.length === 0) {
    throw new Error('Daily Outreach requires at least one bounded fictional prospect');
  }
  const issues: string[] = [];
  if (snapshot.dataset !== 'fictional_test' || snapshot.externalEffects !== false) {
    issues.push('The Daily Outreach slice accepts fictional zero-effect snapshots only.');
  }
  const timezone = boundedText(snapshot.timezone, 'Europe/London');
  const snapshotAtMs = instant(snapshot.snapshotAt);
  if (snapshotAtMs === null) issues.push('Snapshot time is invalid.');

  const prospectInput = snapshot.prospects.slice(0, DAILY_OUTREACH_MAX_PROSPECTS);
  const outcomeInput = snapshot.recentOutcomes.slice(0, DAILY_OUTREACH_MAX_OUTCOMES);
  const watchInput = snapshot.creatorWatch.slice(0, DAILY_OUTREACH_MAX_WATCH_ITEMS);
  const breakdownInput = snapshot.breakdowns.slice(0, DAILY_OUTREACH_MAX_BREAKDOWNS);
  const inputTruncated = prospectInput.length < snapshot.prospects.length
    || outcomeInput.length < snapshot.recentOutcomes.length
    || watchInput.length < snapshot.creatorWatch.length
    || breakdownInput.length < snapshot.breakdowns.length;
  if (inputTruncated) issues.push('A bounded display limit was reached; the fixture is incomplete.');

  const prospects = Object.freeze(prospectInput.map((prospect) =>
    presentProspect(prospect, snapshotAtMs, timezone, issues)));
  const requestedNext = prospects.find((prospect) => prospect.prospectId === snapshot.nextProspectId);
  const nextProspect = requestedNext ?? prospects[0]!;
  if (!requestedNext) issues.push('The requested next prospect was unavailable; the queue failed to its first bounded item.');

  const dailyTarget = count(snapshot.dailyTarget);
  const completed = count(snapshot.completed);
  const channels = Object.freeze(snapshot.progress.slice(0, 12).map((row) => {
    const target = count(row.target);
    const rowCompleted = count(row.completed);
    return Object.freeze({
      progressId: boundedText(row.progressId),
      channel: row.channel,
      channelLabel: CHANNEL_LABELS[row.channel],
      segmentLabel: boundedText(row.segmentLabel),
      target,
      completed: rowCompleted,
      progressPercent: percent(rowCompleted, target),
      progressLabel: `${rowCompleted} / ${target}`,
    });
  }));
  const progressSum = channels.reduce((total, row) => total + row.completed, 0);
  const targetSum = channels.reduce((total, row) => total + row.target, 0);
  if (dailyTarget !== targetSum || completed !== progressSum) {
    issues.push('Channel and segment fuel totals do not reconcile to the daily target.');
  }

  const manager = snapshot.manager;
  const managerView = Object.freeze({
    prospectsReviewed: count(manager.prospectsReviewed),
    validAttempts: count(manager.validAttempts),
    responses: count(manager.responses),
    positiveResponses: count(manager.positiveResponses),
    conversationsCreated: count(manager.conversationsCreated),
    lapsLeadsCreated: count(manager.lapsLeadsCreated),
    lapsAppointmentsCreated: count(manager.lapsAppointmentsCreated),
    callsAndTasksCompleted: count(manager.callsAndTasksCompleted),
    medianFirstResponseMinutes: manager.medianFirstResponseMinutes === null
      ? null
      : count(manager.medianFirstResponseMinutes),
    medianHumanHandoffMinutes: manager.medianHumanHandoffMinutes === null
      ? null
      : count(manager.medianHumanHandoffMinutes),
    duplicatesPrevented: count(manager.duplicatesPrevented),
    blockedAttempts: count(manager.blockedAttempts),
    suppressions: count(manager.suppressions),
    providerFailures: count(manager.providerFailures),
    responseRateLabel: rateLabel(count(manager.responses), count(manager.validAttempts)),
    positiveResponseRateLabel: rateLabel(count(manager.positiveResponses), count(manager.validAttempts)),
    medianFirstResponseLabel: manager.medianFirstResponseMinutes === null
      ? 'Unavailable'
      : `${count(manager.medianFirstResponseMinutes)} min`,
    medianHumanHandoffLabel: manager.medianHumanHandoffMinutes === null
      ? 'Unavailable'
      : `${count(manager.medianHumanHandoffMinutes)} min`,
  });
  if (managerView.responses > managerView.validAttempts
    || managerView.positiveResponses > managerView.responses) {
    issues.push('Manager outcome counts are internally contradictory.');
  }

  const recentOutcomes = Object.freeze(outcomeInput.map((outcome) => Object.freeze({
    receiptId: boundedText(outcome.receiptId),
    personLabel: boundedText(outcome.personLabel),
    channel: outcome.channel,
    channelLabel: CHANNEL_LABELS[outcome.channel],
    outcome: outcome.outcome,
    outcomeLabel: OUTCOME_LABELS[outcome.outcome],
    tone: outcomeTone(outcome.outcome),
    occurredAt: outcome.occurredAt,
    occurredLabel: formatInstant(outcome.occurredAt, timezone),
    detail: boundedText(outcome.detail),
    nextActionLabel: boundedText(outcome.nextActionLabel),
  })));

  const breakdowns = Object.freeze(breakdownInput.map((row) => {
    const attempts = count(row.attempts);
    const responses = count(row.responses);
    const positiveResponses = count(row.positiveResponses);
    if (responses > attempts || positiveResponses > responses) {
      issues.push(`${boundedText(row.breakdownId)} has contradictory outcome counts.`);
    }
    return Object.freeze({
      breakdownId: boundedText(row.breakdownId),
      dimension: row.dimension,
      dimensionLabel: row.dimension.toLocaleUpperCase('en-GB'),
      label: boundedText(row.label),
      attempts,
      responses,
      positiveResponses,
      leads: count(row.leads),
      appointments: count(row.appointments),
      responseRateLabel: rateLabel(responses, attempts),
      positiveRateLabel: rateLabel(positiveResponses, attempts),
    });
  }));

  const creatorWatch = Object.freeze(watchInput.map((item) =>
    presentWatchItem(item, snapshotAtMs, timezone, issues)));
  if (!creatorWatch.some((item) => item.decision === 'no_comment')) {
    issues.push('Creator Watch has no explicit no_comment decision example.');
  }

  return Object.freeze({
    workspaceId: boundedText(snapshot.workspaceId),
    workspaceName: boundedText(snapshot.workspaceName),
    operatorLabel: boundedText(snapshot.operatorLabel),
    snapshotAt: snapshot.snapshotAt,
    snapshotLabel: formatInstant(snapshot.snapshotAt, timezone),
    timezone,
    dataset: 'fictional_test',
    datasetLabel: 'FICTIONAL TEST DATA',
    externalEffects: false,
    providerEffects: 'none',
    progress: Object.freeze({
      dailyTarget,
      completed,
      remaining: Math.max(0, dailyTarget - completed),
      progressPercent: percent(completed, dailyTarget),
      progressLabel: `${completed} / ${dailyTarget}`,
      channels,
    }),
    nextProspect,
    prospects,
    recentOutcomes,
    manager: managerView,
    breakdowns,
    creatorWatch,
    integrity: Object.freeze({
      coherent: issues.length === 0,
      label: issues.length === 0 ? 'COHERENT TEST FIXTURE' : 'CHECK REQUIRED',
      issues: Object.freeze(issues.slice(0, 24)),
    }),
    inputTruncated,
    safety: Object.freeze({
      liveAuthorised: false,
      providerOperationsCreated: 0,
      contactEffects: false,
      commandBoundaryAvailable: false,
    }),
  });
}
