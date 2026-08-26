/**
 * Pure, bounded Webinar Studio presentation model.
 *
 * This slice is deliberately read-only. It can prove that an immutable TEST
 * webinar is structurally ready for rehearsal, but it cannot create a provider
 * event, register a person, broadcast, send follow-up or touch a live account.
 */

export const WEBINAR_STUDIO_ROUTE = '/portal/webinars' as const;
export const WEBINAR_STUDIO_MAX_PROOFS = 16;
export const WEBINAR_STUDIO_MAX_REGISTRATION_STAGES = 10;
export const WEBINAR_STUDIO_MAX_SPEAKERS = 8;
export const WEBINAR_STUDIO_MAX_SEGMENTS = 20;
export const WEBINAR_STUDIO_MAX_SIGNALS = 20;
export const WEBINAR_STUDIO_MAX_REPLAY_STEPS = 12;
export const WEBINAR_STUDIO_MAX_TEXT = 360;

export type WebinarProofState = 'verified' | 'pending' | 'missing' | 'expired';
export type WebinarTruth = 'simulated' | 'measured' | 'unavailable';
export type WebinarSignalKind = 'arrival' | 'poll' | 'question' | 'resource' | 'offer' | 'departure';
export type WebinarSegmentKind = 'welcome' | 'teaching' | 'proof' | 'interaction' | 'offer' | 'qa' | 'close';
export type WebinarReplayChannel = 'email' | 'whatsapp' | 'sms';
export type WebinarAdapterState = 'test_ready' | 'setup_required' | 'unreachable';

export interface WebinarEventSnapshot {
  readonly eventId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly revisionSha256: string;
  readonly title: string;
  readonly promise: string;
  readonly scheduledAt: string;
  readonly durationMinutes: number;
  readonly timezoneLabel: string;
  readonly hostLabel: string;
  readonly lifecycle: 'blueprint' | 'rehearsal_ready';
  readonly environment: 'test';
  readonly providerEventId: null;
}

export interface WebinarReadinessProofSnapshot {
  readonly proofId: string;
  readonly label: string;
  readonly detail: string;
  readonly required: boolean;
  readonly state: WebinarProofState;
  readonly evidenceRef: string | null;
  readonly verifiedAt: string | null;
  readonly expiresAt: string | null;
}

export interface WebinarRegistrationStageSnapshot {
  readonly stageId: string;
  readonly label: string;
  readonly detail: string;
  readonly count: number | null;
  readonly truth: WebinarTruth;
}

export interface WebinarSpeakerSnapshot {
  readonly speakerId: string;
  readonly name: string;
  readonly role: string;
  readonly promise: string;
  readonly readiness: 'ready' | 'waiting';
}

export interface WebinarRunSegmentSnapshot {
  readonly segmentId: string;
  readonly kind: WebinarSegmentKind;
  readonly title: string;
  readonly operatorCue: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly speakerId: string;
  readonly assetVersionId: string | null;
  readonly expectedAudience: number | null;
  readonly attendanceTruth: WebinarTruth;
}

export interface WebinarEngagementSignalSnapshot {
  readonly signalId: string;
  readonly kind: WebinarSignalKind;
  readonly label: string;
  readonly detail: string;
  readonly minute: number;
  readonly people: number | null;
  readonly truth: WebinarTruth;
  readonly leadScoreDelta: number;
}

export interface WebinarReplayStepSnapshot {
  readonly stepId: string;
  readonly afterHours: number;
  readonly channel: WebinarReplayChannel;
  readonly audienceLabel: string;
  readonly templateVersionId: string;
  readonly templateSha256: string;
  readonly approvedVersionId: string | null;
  readonly approvedSha256: string | null;
  readonly executionMode: 'simulated';
  readonly consentGate: 'required';
}

export interface WebinarProviderAdapterSnapshot {
  readonly adapterId: string;
  readonly providerLabel: string;
  readonly state: WebinarAdapterState;
  readonly environment: 'test';
  readonly healthCheckedAt: string | null;
  readonly webhookContractVersion: string;
  readonly capabilities: readonly string[];
  readonly providerEffects: false;
}

export interface WebinarStudioSnapshot {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly asOf: string;
  readonly event: WebinarEventSnapshot;
  readonly proofs: readonly WebinarReadinessProofSnapshot[];
  readonly registration: readonly WebinarRegistrationStageSnapshot[];
  readonly speakers: readonly WebinarSpeakerSnapshot[];
  readonly runOfShow: readonly WebinarRunSegmentSnapshot[];
  readonly engagementSignals: readonly WebinarEngagementSignalSnapshot[];
  readonly replay: readonly WebinarReplayStepSnapshot[];
  readonly adapter: WebinarProviderAdapterSnapshot;
}

export interface WebinarGateCheckView {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly passed: boolean;
  readonly category: 'event' | 'experience' | 'safety' | 'evidence';
}

export interface WebinarProofView extends WebinarReadinessProofSnapshot {
  readonly stateLabel: string;
  readonly passes: boolean;
}

export interface WebinarRegistrationStageView extends WebinarRegistrationStageSnapshot {
  readonly indexLabel: string;
  readonly countLabel: string;
  readonly truthLabel: 'SIMULATED' | 'MEASURED' | 'UNAVAILABLE';
  readonly widthPercent: number;
  readonly truthful: boolean;
}

export interface WebinarSpeakerView extends WebinarSpeakerSnapshot {
  readonly initials: string;
  readonly segmentCount: number;
}

export interface WebinarRunSegmentView extends WebinarRunSegmentSnapshot {
  readonly indexLabel: string;
  readonly kindLabel: string;
  readonly speakerName: string;
  readonly durationMinutes: number;
  readonly timeLabel: string;
  readonly audienceLabel: string;
  readonly truthful: boolean;
}

export interface WebinarEngagementSignalView extends WebinarEngagementSignalSnapshot {
  readonly kindLabel: string;
  readonly timeLabel: string;
  readonly peopleLabel: string;
  readonly truthLabel: 'SIMULATED' | 'MEASURED' | 'UNAVAILABLE';
  readonly truthful: boolean;
}

export interface WebinarReplayStepView extends WebinarReplayStepSnapshot {
  readonly indexLabel: string;
  readonly channelLabel: string;
  readonly scheduleLabel: string;
  readonly exactApproval: boolean;
  readonly gatePasses: boolean;
}

export interface WebinarStudioView {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly asOf: string;
  readonly event: WebinarEventSnapshot & Readonly<{
    shortHash: string;
    scheduledLabel: string;
    timingValid: boolean;
    immutableProofValid: boolean;
  }>;
  readonly proofs: readonly WebinarProofView[];
  readonly registration: readonly WebinarRegistrationStageView[];
  readonly speakers: readonly WebinarSpeakerView[];
  readonly runOfShow: readonly WebinarRunSegmentView[];
  readonly engagementSignals: readonly WebinarEngagementSignalView[];
  readonly replay: readonly WebinarReplayStepView[];
  readonly adapter: WebinarProviderAdapterSnapshot & Readonly<{
    stateLabel: string;
    safeForTest: boolean;
    checkedLabel: string;
  }>;
  readonly truthSummary: Readonly<{ simulated: number; measured: number; unavailable: number }>;
  readonly registrationSummary: Readonly<{
    largestCount: number;
    registeredCount: number | null;
    showUpRate: number | null;
    truthLabel: string;
  }>;
  readonly rehearsalGate: Readonly<{
    open: boolean;
    label: 'TEST REHEARSAL READY' | 'LOCKED';
    headline: string;
    detail: string;
    passed: number;
    total: number;
    checks: readonly WebinarGateCheckView[];
    blockers: readonly WebinarGateCheckView[];
  }>;
  readonly inputTruncated: boolean;
  readonly commandBoundaryAvailable: false;
  readonly liveBroadcastAvailable: false;
  readonly providerEffects: 'none';
}

const KIND_LABELS: Readonly<Record<WebinarSegmentKind, string>> = Object.freeze({
  welcome: 'Welcome', teaching: 'Teaching', proof: 'Proof', interaction: 'Interaction',
  offer: 'Offer', qa: 'Q&A', close: 'Close',
});
const SIGNAL_LABELS: Readonly<Record<WebinarSignalKind, string>> = Object.freeze({
  arrival: 'Arrival', poll: 'Poll response', question: 'Question', resource: 'Resource click',
  offer: 'Offer intent', departure: 'Departure',
});
const CHANNEL_LABELS: Readonly<Record<WebinarReplayChannel, string>> = Object.freeze({
  email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS',
});

function validInstant(value: string | null): number | null {
  if (value === null) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function validSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function boundedText(value: string, max = WEBINAR_STUDIO_MAX_TEXT): string {
  return [...String(value)].slice(0, max).join('');
}

function safeCount(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.floor(value), 1_000_000_000);
}

function truthLabel(truth: WebinarTruth): 'SIMULATED' | 'MEASURED' | 'UNAVAILABLE' {
  return truth === 'simulated' ? 'SIMULATED' : truth === 'measured' ? 'MEASURED' : 'UNAVAILABLE';
}

function metricTruthful(truth: WebinarTruth, count: number | null): boolean {
  return truth === 'unavailable' ? count === null : safeCount(count) !== null;
}

function formatInstant(value: string): string {
  const parsed = validInstant(value);
  if (parsed === null) return 'Invalid schedule';
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
  }).format(new Date(parsed));
}

function proofView(proof: WebinarReadinessProofSnapshot, asOf: number | null): WebinarProofView {
  const verifiedAt = validInstant(proof.verifiedAt);
  const expiresAt = validInstant(proof.expiresAt);
  const evidencePresent = Boolean(proof.evidenceRef?.trim());
  const expired = expiresAt !== null && asOf !== null && expiresAt <= asOf;
  const passes = proof.state === 'verified' && verifiedAt !== null && evidencePresent && !expired;
  const stateLabel = expired ? 'Expired' : passes ? 'Verified' : proof.state === 'verified' ? 'Evidence mismatch'
    : proof.state === 'pending' ? 'Pending' : proof.state === 'missing' ? 'Missing' : 'Expired';
  return Object.freeze({
    ...proof,
    label: boundedText(proof.label, 120),
    detail: boundedText(proof.detail),
    evidenceRef: proof.evidenceRef ? boundedText(proof.evidenceRef, 120) : null,
    state: expired ? 'expired' : proof.state,
    stateLabel,
    passes,
  });
}

export function presentWebinarStudio(snapshot: WebinarStudioSnapshot): WebinarStudioView {
  const asOf = validInstant(snapshot.asOf);
  const proofInputComplete = snapshot.proofs.length <= WEBINAR_STUDIO_MAX_PROOFS;
  const registrationInputComplete = snapshot.registration.length <= WEBINAR_STUDIO_MAX_REGISTRATION_STAGES;
  const speakerInputComplete = snapshot.speakers.length <= WEBINAR_STUDIO_MAX_SPEAKERS;
  const segmentInputComplete = snapshot.runOfShow.length <= WEBINAR_STUDIO_MAX_SEGMENTS;
  const signalInputComplete = snapshot.engagementSignals.length <= WEBINAR_STUDIO_MAX_SIGNALS;
  const replayInputComplete = snapshot.replay.length <= WEBINAR_STUDIO_MAX_REPLAY_STEPS;
  const inputTruncated = !proofInputComplete || !registrationInputComplete || !speakerInputComplete
    || !segmentInputComplete || !signalInputComplete || !replayInputComplete;

  const eventStart = validInstant(snapshot.event.scheduledAt);
  const timingValid = eventStart !== null
    && Number.isInteger(snapshot.event.durationMinutes)
    && snapshot.event.durationMinutes >= 15
    && snapshot.event.durationMinutes <= 240;
  const immutableProofValid = snapshot.event.revisionNumber > 0 && validSha256(snapshot.event.revisionSha256);

  const proofs = Object.freeze(snapshot.proofs.slice(0, WEBINAR_STUDIO_MAX_PROOFS).map((proof) => proofView(proof, asOf)));
  const speakers = snapshot.speakers.slice(0, WEBINAR_STUDIO_MAX_SPEAKERS);
  const speakerById = new Map(speakers.map((speaker) => [speaker.speakerId, speaker] as const));
  const segments = [...snapshot.runOfShow.slice(0, WEBINAR_STUDIO_MAX_SEGMENTS)]
    .sort((left, right) => left.startMinute - right.startMinute);

  const speakerViews: readonly WebinarSpeakerView[] = Object.freeze(speakers.map((speaker) => Object.freeze({
    ...speaker,
    name: boundedText(speaker.name, 100),
    role: boundedText(speaker.role, 100),
    promise: boundedText(speaker.promise, 240),
    initials: speaker.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || 'PP',
    segmentCount: segments.filter((segment) => segment.speakerId === speaker.speakerId).length,
  })));

  const runOfShow: readonly WebinarRunSegmentView[] = Object.freeze(segments.map((segment, index) => {
    const audience = safeCount(segment.expectedAudience);
    const truthful = metricTruthful(segment.attendanceTruth, audience);
    return Object.freeze({
      ...segment,
      title: boundedText(segment.title, 140),
      operatorCue: boundedText(segment.operatorCue),
      indexLabel: String(index + 1).padStart(2, '0'),
      kindLabel: KIND_LABELS[segment.kind],
      speakerName: speakerById.get(segment.speakerId)?.name ?? 'Speaker unavailable',
      durationMinutes: Math.max(0, segment.endMinute - segment.startMinute),
      timeLabel: `${Math.max(0, segment.startMinute)}–${Math.max(0, segment.endMinute)} min`,
      expectedAudience: audience,
      audienceLabel: audience === null ? 'Attendance unavailable' : `${audience.toLocaleString('en-GB')} planned in room`,
      truthful,
    });
  }));

  const registrationRaw = snapshot.registration.slice(0, WEBINAR_STUDIO_MAX_REGISTRATION_STAGES);
  const largestRegistration = Math.max(1, ...registrationRaw.map((stage) => safeCount(stage.count) ?? 0));
  const registration: readonly WebinarRegistrationStageView[] = Object.freeze(registrationRaw.map((stage, index) => {
    const count = safeCount(stage.count);
    const truthful = metricTruthful(stage.truth, count);
    return Object.freeze({
      ...stage,
      label: boundedText(stage.label, 100),
      detail: boundedText(stage.detail, 240),
      count,
      indexLabel: String(index + 1).padStart(2, '0'),
      countLabel: count === null ? 'Not connected' : count.toLocaleString('en-GB'),
      truthLabel: truthLabel(stage.truth),
      widthPercent: count === null ? 0 : Math.max(5, Math.round((count / largestRegistration) * 100)),
      truthful,
    });
  }));

  const engagementSignals: readonly WebinarEngagementSignalView[] = Object.freeze(
    snapshot.engagementSignals.slice(0, WEBINAR_STUDIO_MAX_SIGNALS).map((signal) => {
      const people = safeCount(signal.people);
      return Object.freeze({
        ...signal,
        label: boundedText(signal.label, 120),
        detail: boundedText(signal.detail, 240),
        people,
        kindLabel: SIGNAL_LABELS[signal.kind],
        timeLabel: `${Math.max(0, Math.floor(signal.minute))} min`,
        peopleLabel: people === null ? 'Not measured' : `${people.toLocaleString('en-GB')} people`,
        truthLabel: truthLabel(signal.truth),
        truthful: metricTruthful(signal.truth, people),
      });
    }),
  );

  const replay: readonly WebinarReplayStepView[] = Object.freeze(
    [...snapshot.replay.slice(0, WEBINAR_STUDIO_MAX_REPLAY_STEPS)]
      .sort((left, right) => left.afterHours - right.afterHours)
      .map((step, index) => {
        const exactApproval = validSha256(step.templateSha256)
          && step.approvedVersionId === step.templateVersionId
          && step.approvedSha256 === step.templateSha256;
        return Object.freeze({
          ...step,
          audienceLabel: boundedText(step.audienceLabel, 150),
          indexLabel: String(index + 1).padStart(2, '0'),
          channelLabel: CHANNEL_LABELS[step.channel],
          scheduleLabel: step.afterHours === 0 ? 'Immediately after' : `+${Math.max(0, step.afterHours)} hours`,
          exactApproval,
          gatePasses: exactApproval && step.executionMode === 'simulated' && step.consentGate === 'required',
        });
      }),
  );

  const adapterCheckedAt = validInstant(snapshot.adapter.healthCheckedAt);
  const adapter = Object.freeze({
    ...snapshot.adapter,
    providerLabel: boundedText(snapshot.adapter.providerLabel, 120),
    webhookContractVersion: boundedText(snapshot.adapter.webhookContractVersion, 80),
    capabilities: Object.freeze(snapshot.adapter.capabilities.slice(0, 12).map((capability) => boundedText(capability, 80))),
    stateLabel: snapshot.adapter.state === 'test_ready' ? 'TEST adapter ready'
      : snapshot.adapter.state === 'setup_required' ? 'Setup required' : 'Adapter unreachable',
    safeForTest: snapshot.adapter.environment === 'test'
      && snapshot.adapter.state === 'test_ready'
      && snapshot.adapter.providerEffects === false
      && adapterCheckedAt !== null
      && asOf !== null
      && adapterCheckedAt <= asOf,
    checkedLabel: adapterCheckedAt === null
      ? 'No health proof'
      : formatInstant(snapshot.adapter.healthCheckedAt ?? ''),
  });

  const segmentContinuity = segments.length > 0 && segments.every((segment, index) => {
    const previous = segments[index - 1];
    return Number.isInteger(segment.startMinute)
      && Number.isInteger(segment.endMinute)
      && segment.startMinute >= 0
      && segment.endMinute > segment.startMinute
      && segment.endMinute <= snapshot.event.durationMinutes
      && (previous === undefined || segment.startMinute === previous.endMinute);
  });
  const speakerCoverage = speakers.length > 0
    && speakers.every((speaker) => speaker.readiness === 'ready')
    && segments.every((segment) => speakerById.has(segment.speakerId));
  const proofCoverage = proofs.filter((proof) => proof.required).length > 0
    && proofs.filter((proof) => proof.required).every((proof) => proof.passes);
  const registrationTruthful = registration.length >= 3
    && registration.every((stage) => stage.truthful)
    && registration.every((stage, index) => {
      const previous = registration[index - 1];
      if (!previous || stage.count === null || previous.count === null) return true;
      return stage.count <= previous.count;
    });
  const engagementTruthful = engagementSignals.length > 0
    && engagementSignals.every((signal) => signal.truthful && signal.minute <= snapshot.event.durationMinutes);
  const replaySafe = replay.length > 0 && replay.every((step) => step.gatePasses);

  const rawChecks: WebinarGateCheckView[] = [
    { key: 'event', label: 'Immutable event blueprint', detail: 'Valid revision proof, TEST environment and deliberate schedule.', passed: immutableProofValid && timingValid && snapshot.event.environment === 'test' && snapshot.event.providerEventId === null, category: 'event' },
    { key: 'readiness', label: 'Required readiness evidence', detail: 'Every required event proof is current, verified and evidence-backed.', passed: proofCoverage, category: 'evidence' },
    { key: 'speakers', label: 'Speaker coverage', detail: 'Every run-of-show segment resolves to a rehearsal-ready speaker.', passed: speakerCoverage, category: 'experience' },
    { key: 'timeline', label: 'Run-of-show continuity', detail: 'Segments are contiguous, ordered and contained inside the event runtime.', passed: segmentContinuity, category: 'experience' },
    { key: 'registration', label: 'Registration funnel truth', detail: 'Counts are consistently labelled and decrease through the simulated funnel.', passed: registrationTruthful, category: 'evidence' },
    { key: 'engagement', label: 'Engagement signal contract', detail: 'Signals are truthful, bounded and mapped inside the session.', passed: engagementTruthful, category: 'evidence' },
    { key: 'replay', label: 'Replay approval + consent gates', detail: 'Every follow-up resolves to an exactly approved immutable template and remains simulated.', passed: replaySafe, category: 'safety' },
    { key: 'adapter', label: 'TEST provider adapter', detail: 'Sandbox adapter is healthy and incapable of provider effects.', passed: adapter.safeForTest, category: 'safety' },
    { key: 'bounds', label: 'Complete bounded snapshot', detail: 'No planning, evidence or audience input was truncated.', passed: !inputTruncated, category: 'safety' },
  ];
  const checks: readonly WebinarGateCheckView[] = Object.freeze(
    rawChecks.map((check) => Object.freeze(check)),
  );
  const blockers = Object.freeze(checks.filter((check) => !check.passed));
  const open = blockers.length === 0;

  const allTruth = [...registration.map((item) => item.truth), ...runOfShow.map((item) => item.attendanceTruth), ...engagementSignals.map((item) => item.truth)];
  const truthSummary = Object.freeze({
    simulated: allTruth.filter((truth) => truth === 'simulated').length,
    measured: allTruth.filter((truth) => truth === 'measured').length,
    unavailable: allTruth.filter((truth) => truth === 'unavailable').length,
  });
  const registered = registration.find((stage) => stage.stageId === 'registered')?.count ?? null;
  const attended = registration.find((stage) => stage.stageId === 'attended')?.count ?? null;
  const showUpRate = registered !== null && attended !== null && registered > 0
    ? Math.round((attended / registered) * 1000) / 10
    : null;

  return Object.freeze({
    workspaceId: boundedText(snapshot.workspaceId, 100),
    workspaceName: boundedText(snapshot.workspaceName, 140),
    asOf: snapshot.asOf,
    event: Object.freeze({
      ...snapshot.event,
      title: boundedText(snapshot.event.title, 160),
      promise: boundedText(snapshot.event.promise),
      hostLabel: boundedText(snapshot.event.hostLabel, 120),
      timezoneLabel: boundedText(snapshot.event.timezoneLabel, 80),
      shortHash: snapshot.event.revisionSha256.slice(0, 10),
      scheduledLabel: formatInstant(snapshot.event.scheduledAt),
      timingValid,
      immutableProofValid,
    }),
    proofs,
    registration,
    speakers: speakerViews,
    runOfShow,
    engagementSignals,
    replay,
    adapter,
    truthSummary,
    registrationSummary: Object.freeze({
      largestCount: largestRegistration,
      registeredCount: registered,
      showUpRate,
      truthLabel: truthSummary.measured > 0 ? 'mixed evidence' : 'SIMULATED plan',
    }),
    rehearsalGate: Object.freeze({
      open,
      label: open ? 'TEST REHEARSAL READY' : 'LOCKED',
      headline: open ? 'The room is ready for a safe dress rehearsal.' : 'The room stays locked until every proof passes.',
      detail: open
        ? 'The exact immutable blueprint passes all TEST checks. No provider event or live broadcast can be created from this screen.'
        : `${blockers.length} deterministic check${blockers.length === 1 ? '' : 's'} block TEST rehearsal. Live broadcasting remains unavailable regardless.`,
      passed: checks.length - blockers.length,
      total: checks.length,
      checks,
      blockers,
    }),
    inputTruncated,
    commandBoundaryAvailable: false,
    liveBroadcastAvailable: false,
    providerEffects: 'none',
  });
}
