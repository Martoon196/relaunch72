export const CAMPAIGN_COMMAND_ROUTE = '/portal/campaigns' as const;
export const CAMPAIGN_COMMAND_MAX_CONTENT = 16;
export const CAMPAIGN_COMMAND_MAX_CHANNELS = 12;
export const CAMPAIGN_COMMAND_MAX_MILESTONES = 12;
export const CAMPAIGN_COMMAND_MAX_TARGETS = 12;
export const CAMPAIGN_COMMAND_MAX_METRICS = 20;
export const CAMPAIGN_COMMAND_MAX_ACTIONS = 12;

export type CampaignChannel = 'linkedin' | 'instagram' | 'facebook' | 'email' | 'whatsapp';
export type CampaignContentKind = 'social_post' | 'email' | 'image' | 'video' | 'webinar' | 'document';
export type CampaignApprovalScope = 'campaign_revision' | 'audience' | 'offer' | 'content_pack' | 'webinar';
export type CampaignMetricTruth = 'simulated' | 'measured' | 'unavailable';
export type CampaignMetricFormat = 'currency' | 'integer' | 'percent';

export interface CampaignRevisionSnapshot {
  readonly campaignId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly revisionSha256: string;
  readonly title: string;
  readonly objective: string;
  readonly ownerLabel: string;
  readonly createdAt: string;
  readonly state: 'immutable';
  readonly environment: 'test';
}

export interface CampaignCohortSnapshot {
  readonly cohortId: string;
  readonly snapshotId: string;
  readonly snapshotSha256: string;
  readonly label: string;
  readonly definition: string;
  readonly eligiblePeople: number;
  readonly capturedAt: string;
  readonly dataTruth: 'simulated';
  readonly entryMilestoneId: string;
}

export interface CampaignJourneyMilestoneSnapshot {
  readonly milestoneId: string;
  readonly label: string;
  readonly operatorMeaning: string;
  readonly order: number;
  readonly role: 'entry' | 'education' | 'intent' | 'conversion';
}

export interface CampaignJourneySnapshot {
  readonly journeyId: string;
  readonly label: string;
  readonly milestones: readonly CampaignJourneyMilestoneSnapshot[];
}

export interface CampaignContentVersionSnapshot {
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly versionNumber: number;
  readonly title: string;
  readonly kind: CampaignContentKind;
  readonly sourceSystem: string;
  readonly approvalStatus: 'approved' | 'pending' | 'rejected';
  readonly approvalDecisionId: string | null;
  readonly approvedContentVersionId: string | null;
  readonly approvedContentSha256: string | null;
  readonly sourceProofExpiresAt: string | null;
}

export interface CampaignContentPackSnapshot {
  readonly contentPackId: string;
  readonly contentPackSha256: string;
}

export interface CampaignOfferSnapshot {
  readonly offerId: string;
  readonly offerRevisionId: string;
  readonly offerSha256: string;
  readonly label: string;
  readonly promise: string;
  readonly callToAction: string;
  readonly destinationLabel: string;
  readonly destinationUrl: string;
}

export interface CampaignChannelPlanSnapshot {
  readonly planId: string;
  readonly channel: CampaignChannel;
  readonly contentVersionId: string;
  readonly milestoneId: string;
  readonly objective: string;
  readonly scheduledFor: string;
  readonly cadenceLabel: string;
  readonly state: 'rehearsal_ready' | 'draft' | 'blocked';
  readonly executionMode: 'simulated';
}

export interface CampaignWebinarSnapshot {
  readonly webinarId: string;
  readonly webinarRevisionId: string;
  readonly webinarSha256: string;
  readonly title: string;
  readonly sessionAt: string;
  readonly durationMinutes: number;
  readonly contentVersionId: string;
  readonly registrationMilestoneId: string;
  readonly attendanceMilestoneId: string;
  readonly replayMilestoneId: string;
  readonly providerMode: 'simulated';
  readonly state: 'rehearsal_ready' | 'draft' | 'blocked';
}

export interface CampaignConversionTargetSnapshot {
  readonly targetId: string;
  readonly milestoneId: string;
  readonly label: string;
  readonly targetCount: number;
  readonly source: 'simulated_plan';
}

export interface CampaignApprovalSnapshot {
  readonly approvalId: string;
  readonly scope: CampaignApprovalScope;
  readonly subjectId: string;
  readonly subjectSha256: string;
  readonly status: 'approved' | 'pending' | 'rejected';
  readonly decidedAt: string | null;
  readonly decidedByLabel: string | null;
}

export interface CampaignTruthMetricSnapshot {
  readonly metricId: string;
  readonly label: string;
  readonly value: number | null;
  readonly format: CampaignMetricFormat;
  readonly truth: CampaignMetricTruth;
  readonly periodLabel: string;
  readonly detail: string;
}

export interface CampaignOperatorActionSnapshot {
  readonly actionId: string;
  readonly label: string;
  readonly detail: string;
  readonly ownerLabel: string;
  readonly dueAt: string | null;
  readonly priority: 'now' | 'next' | 'later';
  readonly state: 'ready' | 'waiting';
}

export interface CampaignCommandSnapshot {
  readonly revision: CampaignRevisionSnapshot;
  readonly cohort: CampaignCohortSnapshot;
  readonly journey: CampaignJourneySnapshot;
  readonly contentPack: CampaignContentPackSnapshot;
  readonly contentVersions: readonly CampaignContentVersionSnapshot[];
  /** Deliberately singular: a campaign revision may carry exactly one offer. */
  readonly offer: CampaignOfferSnapshot;
  readonly channels: readonly CampaignChannelPlanSnapshot[];
  readonly webinar: CampaignWebinarSnapshot;
  readonly targets: readonly CampaignConversionTargetSnapshot[];
  readonly approvals: readonly CampaignApprovalSnapshot[];
  readonly metrics: readonly CampaignTruthMetricSnapshot[];
  readonly nextActions: readonly CampaignOperatorActionSnapshot[];
}

export interface CampaignGateCheckView {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly passed: boolean;
}

export interface CampaignMilestoneView extends CampaignJourneyMilestoneSnapshot {
  readonly indexLabel: string;
  readonly targetCount: number | null;
  readonly targetLabel: string;
  readonly widthPercent: number;
}

export interface CampaignContentVersionView extends CampaignContentVersionSnapshot {
  readonly shortHash: string;
  readonly kindLabel: string;
  readonly exactApproval: boolean;
  readonly proofFresh: boolean;
  readonly gatePasses: boolean;
  readonly channelLabels: readonly string[];
}

export interface CampaignChannelPlanView extends CampaignChannelPlanSnapshot {
  readonly channelLabel: string;
  readonly channelCode: string;
  readonly contentTitle: string;
  readonly milestoneLabel: string;
  readonly scheduledLabel: string;
  readonly gatePasses: boolean;
  readonly gateDetail: string;
}

export interface CampaignApprovalView extends CampaignApprovalSnapshot {
  readonly scopeLabel: string;
  readonly exactSubject: boolean;
  readonly gatePasses: boolean;
  readonly statusLabel: string;
}

export interface CampaignMetricView extends CampaignTruthMetricSnapshot {
  readonly displayValue: string;
  readonly truthLabel: 'SIMULATED' | 'MEASURED' | 'UNAVAILABLE';
  readonly truthful: boolean;
}

export interface CampaignOperatorActionView extends CampaignOperatorActionSnapshot {
  readonly priorityLabel: string;
  readonly dueLabel: string;
  readonly indexLabel: string;
}

export interface CampaignCommandView {
  readonly workspaceName: string;
  readonly asOf: string;
  readonly revision: CampaignRevisionSnapshot & Readonly<{ shortHash: string; immutableProofValid: boolean }>;
  readonly cohort: CampaignCohortSnapshot & Readonly<{ countLabel: string; snapshotShortHash: string }>;
  readonly journey: Readonly<{
    journeyId: string;
    label: string;
    milestones: readonly CampaignMilestoneView[];
  }>;
  readonly contentPack: CampaignContentPackSnapshot & Readonly<{ shortHash: string }>;
  readonly contentVersions: readonly CampaignContentVersionView[];
  readonly offer: CampaignOfferSnapshot & Readonly<{ shortHash: string; destinationValid: boolean }>;
  readonly channels: readonly CampaignChannelPlanView[];
  readonly webinar: CampaignWebinarSnapshot & Readonly<{
    shortHash: string;
    sessionLabel: string;
    contentTitle: string;
    gatePasses: boolean;
    gateDetail: string;
  }>;
  readonly approvals: readonly CampaignApprovalView[];
  readonly targets: readonly CampaignConversionTargetSnapshot[];
  readonly metrics: readonly CampaignMetricView[];
  readonly metricTruth: Readonly<{
    simulated: number;
    measured: number;
    unavailable: number;
  }>;
  readonly nextActions: readonly CampaignOperatorActionView[];
  readonly activationGate: Readonly<{
    open: boolean;
    label: 'REHEARSAL READY' | 'LOCKED';
    headline: string;
    detail: string;
    passed: number;
    total: number;
    checks: readonly CampaignGateCheckView[];
    blockers: readonly CampaignGateCheckView[];
  }>;
  readonly inputTruncated: boolean;
  readonly commandBoundaryAvailable: false;
  readonly providerEffects: 'none';
}

export interface PresentCampaignCommandOptions {
  readonly workspaceName: string;
  /** Request/snapshot time supplied by the caller; never invented by the presenter. */
  readonly asOf: string;
}

const CHANNEL_META: Readonly<Record<CampaignChannel, Readonly<{ label: string; code: string }>>> = Object.freeze({
  linkedin: { label: 'LinkedIn', code: 'in' },
  instagram: { label: 'Instagram', code: 'ig' },
  facebook: { label: 'Facebook', code: 'fb' },
  email: { label: 'Email', code: 'em' },
  whatsapp: { label: 'WhatsApp', code: 'wa' },
});

const KIND_LABELS: Readonly<Record<CampaignContentKind, string>> = Object.freeze({
  social_post: 'Social post',
  email: 'Email',
  image: 'Artwork',
  video: 'Video',
  webinar: 'Webinar',
  document: 'Document',
});

const APPROVAL_SCOPE_LABELS: Readonly<Record<CampaignApprovalScope, string>> = Object.freeze({
  campaign_revision: 'Campaign revision',
  audience: 'CRM audience',
  offer: 'Single offer',
  content_pack: 'Owned content pack',
  webinar: 'Webinar runbook',
});

const REQUIRED_APPROVAL_SCOPES: readonly CampaignApprovalScope[] = Object.freeze([
  'campaign_revision', 'audience', 'offer', 'content_pack', 'webinar',
]);

function validSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function validInstant(value: string | null): number | null {
  if (value === null) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function validHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function boundedText(value: string, max = 360): string {
  return [...String(value)].slice(0, max).join('');
}

function safeCount(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), 1_000_000_000) : 0;
}

function formatInstant(value: string): string {
  const parsed = validInstant(value);
  if (parsed === null) return 'Invalid schedule';
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'UTC',
  }).format(new Date(parsed));
}

function expectedApprovalSubject(
  scope: CampaignApprovalScope,
  snapshot: CampaignCommandSnapshot,
): Readonly<{ id: string; sha256: string }> {
  switch (scope) {
    case 'campaign_revision':
      return { id: snapshot.revision.revisionId, sha256: snapshot.revision.revisionSha256 };
    case 'audience':
      return { id: snapshot.cohort.snapshotId, sha256: snapshot.cohort.snapshotSha256 };
    case 'offer':
      return { id: snapshot.offer.offerRevisionId, sha256: snapshot.offer.offerSha256 };
    case 'content_pack':
      return { id: snapshot.contentPack.contentPackId, sha256: snapshot.contentPack.contentPackSha256 };
    case 'webinar':
      return { id: snapshot.webinar.webinarRevisionId, sha256: snapshot.webinar.webinarSha256 };
  }
}

function metricView(metric: CampaignTruthMetricSnapshot): CampaignMetricView {
  const finiteValue = metric.value !== null && Number.isFinite(metric.value) && metric.value >= 0;
  const formatValid = !finiteValue
    || (metric.format === 'percent' ? (metric.value ?? 0) <= 100
      : metric.format === 'integer' ? Number.isInteger(metric.value)
        : true);
  const truthful = metric.truth === 'unavailable' ? metric.value === null : finiteValue && formatValid;
  let displayValue = 'Not connected';
  if (finiteValue) {
    if (metric.format === 'currency') {
      displayValue = new Intl.NumberFormat('en-GB', {
        style: 'currency', currency: 'GBP', maximumFractionDigits: 0,
      }).format(metric.value ?? 0);
    } else if (metric.format === 'percent') {
      displayValue = `${(metric.value ?? 0).toLocaleString('en-GB', { maximumFractionDigits: 1 })}%`;
    } else {
      displayValue = safeCount(metric.value ?? 0).toLocaleString('en-GB');
    }
  }
  return Object.freeze({
    ...metric,
    label: boundedText(metric.label, 100),
    detail: boundedText(metric.detail),
    periodLabel: boundedText(metric.periodLabel, 100),
    displayValue,
    truthLabel: metric.truth === 'simulated' ? 'SIMULATED' : metric.truth === 'measured' ? 'MEASURED' : 'UNAVAILABLE',
    truthful,
  });
}

export function presentCampaignCommand(
  snapshot: CampaignCommandSnapshot,
  options: PresentCampaignCommandOptions,
): CampaignCommandView {
  const asOf = validInstant(options.asOf);
  const contentInputComplete = snapshot.contentVersions.length <= CAMPAIGN_COMMAND_MAX_CONTENT;
  const channelInputComplete = snapshot.channels.length <= CAMPAIGN_COMMAND_MAX_CHANNELS;
  const milestoneInputComplete = snapshot.journey.milestones.length <= CAMPAIGN_COMMAND_MAX_MILESTONES;
  const targetInputComplete = snapshot.targets.length <= CAMPAIGN_COMMAND_MAX_TARGETS;
  const metricInputComplete = snapshot.metrics.length <= CAMPAIGN_COMMAND_MAX_METRICS;
  const actionInputComplete = snapshot.nextActions.length <= CAMPAIGN_COMMAND_MAX_ACTIONS;
  const inputTruncated = !contentInputComplete || !channelInputComplete || !milestoneInputComplete
    || !targetInputComplete || !metricInputComplete || !actionInputComplete;

  const milestones = [...snapshot.journey.milestones]
    .slice(0, CAMPAIGN_COMMAND_MAX_MILESTONES)
    .sort((left, right) => left.order - right.order);
  const milestoneById = new Map(milestones.map((milestone) => [milestone.milestoneId, milestone] as const));
  const targets = snapshot.targets.slice(0, CAMPAIGN_COMMAND_MAX_TARGETS);
  const targetByMilestone = new Map(targets.map((target) => [target.milestoneId, target] as const));
  const maxTarget = Math.max(1, ...targets.map((target) => safeCount(target.targetCount)));
  const milestoneViews: readonly CampaignMilestoneView[] = Object.freeze(milestones.map((milestone, index) => {
    const target = targetByMilestone.get(milestone.milestoneId);
    const count = target ? safeCount(target.targetCount) : null;
    return Object.freeze({
      ...milestone,
      label: boundedText(milestone.label, 90),
      operatorMeaning: boundedText(milestone.operatorMeaning, 240),
      indexLabel: String(index + 1).padStart(2, '0'),
      targetCount: count,
      targetLabel: count === null ? 'No planning target' : `${count.toLocaleString('en-GB')} target`,
      widthPercent: count === null ? 0 : Math.max(4, Math.round((count / maxTarget) * 100)),
    });
  }));

  const contentVersions: readonly CampaignContentVersionView[] = Object.freeze(
    snapshot.contentVersions.slice(0, CAMPAIGN_COMMAND_MAX_CONTENT).map((content) => {
      const exactApproval = content.approvalStatus === 'approved'
        && content.approvalDecisionId !== null
        && content.approvedContentVersionId === content.contentVersionId
        && content.approvedContentSha256 === content.contentSha256;
      const expiresAt = validInstant(content.sourceProofExpiresAt);
      const proofFresh = asOf !== null && expiresAt !== null && expiresAt > asOf;
      const channels = snapshot.channels
        .filter((plan) => plan.contentVersionId === content.contentVersionId)
        .map((plan) => CHANNEL_META[plan.channel].label);
      return Object.freeze({
        ...content,
        title: boundedText(content.title, 150),
        sourceSystem: boundedText(content.sourceSystem, 100),
        shortHash: content.contentSha256.slice(0, 10),
        kindLabel: KIND_LABELS[content.kind],
        exactApproval,
        proofFresh,
        gatePasses: validSha256(content.contentSha256) && exactApproval && proofFresh,
        channelLabels: Object.freeze([...new Set(channels)]),
      });
    }),
  );
  const contentByVersion = new Map(contentVersions.map((content) => [content.contentVersionId, content] as const));

  const channels: readonly CampaignChannelPlanView[] = Object.freeze(
    snapshot.channels.slice(0, CAMPAIGN_COMMAND_MAX_CHANNELS).map((plan) => {
      const content = contentByVersion.get(plan.contentVersionId);
      const milestone = milestoneById.get(plan.milestoneId);
      const schedule = validInstant(plan.scheduledFor);
      const gatePasses = plan.executionMode === 'simulated'
        && plan.state === 'rehearsal_ready'
        && Boolean(content?.gatePasses)
        && Boolean(milestone)
        && schedule !== null;
      const gateDetail = plan.executionMode !== 'simulated'
        ? 'Execution mode is not constrained to simulation.'
        : plan.state !== 'rehearsal_ready'
          ? 'This channel plan is not rehearsal-ready.'
          : !content?.gatePasses
            ? 'The linked owned content version is unavailable, stale or not exactly approved.'
            : !milestone
              ? 'The linked journey milestone is not in this immutable campaign revision.'
              : schedule === null
                ? 'The planned schedule is invalid.'
                : 'Exact owned content and journey milestone verified for TEST rehearsal.';
      return Object.freeze({
        ...plan,
        objective: boundedText(plan.objective, 220),
        cadenceLabel: boundedText(plan.cadenceLabel, 100),
        channelLabel: CHANNEL_META[plan.channel].label,
        channelCode: CHANNEL_META[plan.channel].code,
        contentTitle: content?.title ?? 'Content version unavailable',
        milestoneLabel: milestone?.label ?? 'Milestone unavailable',
        scheduledLabel: formatInstant(plan.scheduledFor),
        gatePasses,
        gateDetail,
      });
    }),
  );

  const approvals: readonly CampaignApprovalView[] = Object.freeze(
    snapshot.approvals.slice(0, REQUIRED_APPROVAL_SCOPES.length + 8).map((approval) => {
      const expected = expectedApprovalSubject(approval.scope, snapshot);
      const exactSubject = approval.subjectId === expected.id && approval.subjectSha256 === expected.sha256;
      const decidedAt = validInstant(approval.decidedAt);
      const gatePasses = exactSubject
        && validSha256(approval.subjectSha256)
        && approval.status === 'approved'
        && Boolean(approval.decidedByLabel?.trim())
        && decidedAt !== null
        && asOf !== null
        && decidedAt <= asOf;
      return Object.freeze({
        ...approval,
        scopeLabel: APPROVAL_SCOPE_LABELS[approval.scope],
        exactSubject,
        gatePasses,
        statusLabel: gatePasses ? 'Exact approval' : approval.status === 'approved' ? 'Approval mismatch' : approval.status,
      });
    }),
  );

  const webinarContent = contentByVersion.get(snapshot.webinar.contentVersionId);
  const webinarMilestones = [
    snapshot.webinar.registrationMilestoneId,
    snapshot.webinar.attendanceMilestoneId,
    snapshot.webinar.replayMilestoneId,
  ];
  const webinarSchedule = validInstant(snapshot.webinar.sessionAt);
  const webinarGate = snapshot.webinar.providerMode === 'simulated'
    && snapshot.webinar.state === 'rehearsal_ready'
    && validSha256(snapshot.webinar.webinarSha256)
    && Boolean(webinarContent?.gatePasses)
    && webinarMilestones.every((id) => milestoneById.has(id))
    && webinarSchedule !== null
    && snapshot.webinar.durationMinutes >= 15
    && snapshot.webinar.durationMinutes <= 240;
  const webinarDetail = snapshot.webinar.providerMode !== 'simulated'
    ? 'Webinar execution is not constrained to simulation.'
    : snapshot.webinar.state !== 'rehearsal_ready'
      ? 'The webinar runbook is not rehearsal-ready.'
      : !webinarContent?.gatePasses
        ? 'The linked webinar content version is not exactly approved and fresh.'
        : !webinarMilestones.every((id) => milestoneById.has(id))
          ? 'Registration, attendance or replay is not mapped to this journey.'
          : !webinarGate
            ? 'The webinar schedule, duration or immutable revision proof is invalid.'
            : 'TEST room, owned content and registration → attendance → replay milestones agree.';

  const metricViews = Object.freeze(snapshot.metrics.slice(0, CAMPAIGN_COMMAND_MAX_METRICS).map(metricView));
  const metricTruth = Object.freeze({
    simulated: metricViews.filter((metric) => metric.truth === 'simulated').length,
    measured: metricViews.filter((metric) => metric.truth === 'measured').length,
    unavailable: metricViews.filter((metric) => metric.truth === 'unavailable').length,
  });

  const targetMilestonesComplete = targetInputComplete
    && targets.length === milestones.length
    && targets.length >= 2
    && new Set(targets.map((target) => target.targetId)).size === targets.length
    && new Set(targets.map((target) => target.milestoneId)).size === targets.length
    && targets.every((target) => milestoneById.has(target.milestoneId)
      && target.source === 'simulated_plan'
      && Number.isInteger(target.targetCount)
      && target.targetCount >= 0);
  const targetCounts = milestones.map((milestone) => targetByMilestone.get(milestone.milestoneId)?.targetCount ?? -1);
  const targetsMonotonic = targetCounts.every((value, index) => index === 0 || value <= (targetCounts[index - 1] ?? value));

  const approvalByScope = new Map(approvals.map((approval) => [approval.scope, approval] as const));
  const approvalPackReady = REQUIRED_APPROVAL_SCOPES.every((scope) => approvalByScope.get(scope)?.gatePasses === true)
    && new Set(approvals.map((approval) => approval.scope)).size === approvals.length;
  const milestoneOrders = milestones.map((milestone) => milestone.order);
  const journeyReady = milestoneInputComplete
    && milestones.length >= 3
    && new Set(milestones.map((milestone) => milestone.milestoneId).filter(Boolean)).size === milestones.length
    && new Set(milestoneOrders).size === milestones.length
    && milestones.every((milestone, index) => milestone.order === index + 1)
    && milestones[0]?.role === 'entry'
    && milestones.some((milestone) => milestone.role === 'conversion')
    && milestoneById.has(snapshot.cohort.entryMilestoneId);
  const cohortCaptured = validInstant(snapshot.cohort.capturedAt);
  const cohortReady = validSha256(snapshot.cohort.snapshotSha256)
    && snapshot.cohort.dataTruth === 'simulated'
    && safeCount(snapshot.cohort.eligiblePeople) > 0
    && cohortCaptured !== null
    && asOf !== null
    && cohortCaptured <= asOf;
  const offerReady = validSha256(snapshot.offer.offerSha256)
    && validHttpsUrl(snapshot.offer.destinationUrl)
    && Boolean(snapshot.offer.offerId.trim())
    && Boolean(snapshot.offer.offerRevisionId.trim())
    && Boolean(snapshot.offer.callToAction.trim());
  const contentReady = contentInputComplete
    && contentVersions.length > 0
    && validSha256(snapshot.contentPack.contentPackSha256)
    && new Set(contentVersions.map((content) => content.contentVersionId)).size === contentVersions.length
    && contentVersions.every((content) => content.gatePasses);
  const channelsReady = channelInputComplete
    && channels.length > 0
    && new Set(channels.map((channel) => channel.planId)).size === channels.length
    && channels.every((channel) => channel.gatePasses);
  const revisionCreatedAt = validInstant(snapshot.revision.createdAt);
  const revisionReady = snapshot.revision.environment === 'test'
    && snapshot.revision.state === 'immutable'
    && snapshot.revision.revisionNumber > 0
    && validSha256(snapshot.revision.revisionSha256)
    && revisionCreatedAt !== null
    && asOf !== null
    && revisionCreatedAt <= asOf;
  const metricTruthReady = metricInputComplete && metricViews.length > 0 && metricViews.every((metric) => metric.truthful);

  const checks: readonly CampaignGateCheckView[] = Object.freeze([
    { key: 'revision', label: 'Immutable campaign revision', detail: revisionReady ? `Exact revision v${snapshot.revision.revisionNumber} · ${snapshot.revision.revisionSha256.slice(0, 10)}…` : 'Revision number, TEST boundary or SHA-256 proof is invalid.', passed: revisionReady },
    { key: 'cohort', label: 'CRM cohort snapshot', detail: cohortReady ? `${safeCount(snapshot.cohort.eligiblePeople).toLocaleString('en-GB')} fictional TEST people frozen to an exact snapshot.` : 'The cohort snapshot is empty, future-dated, non-simulated or lacks valid proof.', passed: cohortReady },
    { key: 'journey', label: 'Journey milestone map', detail: journeyReady ? `${milestones.length} ordered milestones from entry to conversion.` : 'Milestones are missing, duplicated or not connected from entry to conversion.', passed: journeyReady },
    { key: 'offer', label: 'One exact offer', detail: offerReady ? `${boundedText(snapshot.offer.label, 100)} is the sole offer in this revision.` : 'The singular offer revision, HTTPS destination or CTA is invalid.', passed: offerReady },
    { key: 'content', label: 'Owned content versions', detail: contentReady ? `${contentVersions.length} exact approved version${contentVersions.length === 1 ? '' : 's'} with fresh source proof.` : 'One or more content versions are missing, stale, duplicated or not exactly approved.', passed: contentReady },
    { key: 'channels', label: 'Channel rehearsal plan', detail: channelsReady ? `${channels.length} TEST channel rail${channels.length === 1 ? '' : 's'} mapped to content and milestones.` : 'A channel is not rehearsal-ready or references unavailable content/milestones.', passed: channelsReady },
    { key: 'webinar', label: 'Webinar runbook', detail: webinarDetail, passed: webinarGate },
    { key: 'approvals', label: 'Exact approval pack', detail: approvalPackReady ? 'Campaign, audience, offer, content pack and webinar decisions match exact hashes.' : 'A required decision is absent, stale, duplicated or points at another revision.', passed: approvalPackReady },
    { key: 'targets', label: 'Conversion target integrity', detail: targetMilestonesComplete && targetsMonotonic && targetCounts[0] === snapshot.cohort.eligiblePeople ? 'One simulated target per milestone, narrowing from the exact cohort to conversion.' : 'Targets are missing, duplicated, impossible, non-simulated or do not reconcile to the exact cohort.', passed: targetMilestonesComplete && targetsMonotonic && targetCounts[0] === snapshot.cohort.eligiblePeople },
    { key: 'truth', label: 'Spend & metric truth', detail: metricTruthReady ? 'Every value is explicitly SIMULATED, MEASURED or UNAVAILABLE; unavailable values carry no number.' : 'A metric has an invalid value or ambiguous evidence label.', passed: metricTruthReady },
  ].map((check) => Object.freeze(check)));
  const blockers = Object.freeze(checks.filter((check) => !check.passed));
  const open = !inputTruncated && checks.length > 0 && blockers.length === 0;

  const priorityOrder: Readonly<Record<CampaignOperatorActionSnapshot['priority'], number>> = Object.freeze({ now: 0, next: 1, later: 2 });
  const nextActions: readonly CampaignOperatorActionView[] = Object.freeze(
    snapshot.nextActions.slice(0, CAMPAIGN_COMMAND_MAX_ACTIONS)
      .map((action, index) => Object.freeze({
        ...action,
        label: boundedText(action.label, 120),
        detail: boundedText(action.detail, 320),
        ownerLabel: boundedText(action.ownerLabel, 100),
        priorityLabel: action.priority === 'now' ? 'Do now' : action.priority === 'next' ? 'Up next' : 'Later',
        dueLabel: action.dueAt === null ? 'No deadline' : formatInstant(action.dueAt),
        indexLabel: String(index + 1).padStart(2, '0'),
      }))
      .sort((left, right) => priorityOrder[left.priority] - priorityOrder[right.priority]),
  );

  return Object.freeze({
    workspaceName: boundedText(options.workspaceName, 120),
    asOf: options.asOf,
    revision: Object.freeze({
      ...snapshot.revision,
      title: boundedText(snapshot.revision.title, 180),
      objective: boundedText(snapshot.revision.objective, 480),
      ownerLabel: boundedText(snapshot.revision.ownerLabel, 100),
      shortHash: snapshot.revision.revisionSha256.slice(0, 10),
      immutableProofValid: revisionReady,
    }),
    cohort: Object.freeze({
      ...snapshot.cohort,
      label: boundedText(snapshot.cohort.label, 160),
      definition: boundedText(snapshot.cohort.definition, 420),
      countLabel: safeCount(snapshot.cohort.eligiblePeople).toLocaleString('en-GB'),
      snapshotShortHash: snapshot.cohort.snapshotSha256.slice(0, 10),
    }),
    journey: Object.freeze({
      journeyId: snapshot.journey.journeyId,
      label: boundedText(snapshot.journey.label, 160),
      milestones: milestoneViews,
    }),
    contentPack: Object.freeze({
      ...snapshot.contentPack,
      shortHash: snapshot.contentPack.contentPackSha256.slice(0, 10),
    }),
    contentVersions,
    offer: Object.freeze({
      ...snapshot.offer,
      label: boundedText(snapshot.offer.label, 160),
      promise: boundedText(snapshot.offer.promise, 420),
      callToAction: boundedText(snapshot.offer.callToAction, 120),
      destinationLabel: boundedText(snapshot.offer.destinationLabel, 120),
      shortHash: snapshot.offer.offerSha256.slice(0, 10),
      destinationValid: validHttpsUrl(snapshot.offer.destinationUrl),
    }),
    channels,
    webinar: Object.freeze({
      ...snapshot.webinar,
      title: boundedText(snapshot.webinar.title, 180),
      shortHash: snapshot.webinar.webinarSha256.slice(0, 10),
      sessionLabel: formatInstant(snapshot.webinar.sessionAt),
      contentTitle: webinarContent?.title ?? 'Content version unavailable',
      gatePasses: webinarGate,
      gateDetail: webinarDetail,
    }),
    approvals,
    targets: Object.freeze(targets.map((target) => Object.freeze({ ...target, label: boundedText(target.label, 100) }))),
    metrics: metricViews,
    metricTruth,
    nextActions,
    activationGate: Object.freeze({
      open,
      label: open ? 'REHEARSAL READY' : 'LOCKED',
      headline: open ? 'The exact TEST campaign can enter rehearsal.' : `${blockers.length || 1} exact check${blockers.length === 1 ? '' : 's'} block rehearsal.`,
      detail: open
        ? 'All deterministic checks pass for this immutable revision. Controls remain disabled: no command boundary or provider call exists.'
        : inputTruncated
          ? 'Input exceeded a safe evaluation bound, so the gate fails closed even if visible checks pass.'
          : 'Resolve every failed check against this exact revision before another TEST rehearsal is prepared.',
      passed: checks.filter((check) => check.passed).length,
      total: checks.length,
      checks,
      blockers,
    }),
    inputTruncated,
    commandBoundaryAvailable: false,
    providerEffects: 'none',
  });
}
