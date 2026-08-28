import {
  PROVIDER_ACTIVATION_GATES,
  PROVIDER_ACTIVATION_RAILS,
  PROVIDER_ACTIVATION_READINESS_STAGES,
  type ProviderActivationGate,
  type ProviderActivationRail,
  type ProviderActivationReadiness,
  type ProviderActivationReadinessStage,
  type ProviderEvidenceStatus,
  type ProviderReadinessReason,
} from '../provider-activation-readiness/domain.js';
import type { PortalProviderReadinessSnapshot } from './provider-readiness-cockpit-service.js';

export const PROVIDER_READINESS_COCKPIT_ROUTE = '/portal/providers/readiness' as const;

export type ProviderCockpitTone = 'ready' | 'working' | 'blocked' | 'muted';
export type ProviderEvidenceFreshness = 'current' | 'stale' | 'missing' | 'failed' | 'not_applicable';

export interface ProviderReadinessStageView {
  readonly stage: ProviderActivationReadinessStage;
  readonly label: string;
  readonly index: string;
  readonly ready: boolean;
  readonly active: boolean;
  readonly tone: ProviderCockpitTone;
  readonly blockers: readonly ProviderReadinessReason[];
}

export interface ProviderEvidenceView {
  readonly gate: ProviderActivationGate;
  readonly label: string;
  readonly status: ProviderEvidenceStatus;
  readonly freshness: ProviderEvidenceFreshness;
  readonly freshnessLabel: string;
  readonly tone: ProviderCockpitTone;
  readonly verifiedAt: string | null;
  readonly expiresAt: string | null;
}

export interface ProviderReadinessRailView {
  readonly rail: ProviderActivationRail;
  readonly anchorId: string;
  readonly eyebrow: string;
  readonly label: string;
  readonly providerLabel: string;
  readonly candidateOnly: boolean;
  readonly readiness: ProviderActivationReadiness;
  readonly readinessLabel: string;
  readonly readinessTone: ProviderCockpitTone;
  readonly nextStageLabel: string;
  readonly stages: readonly ProviderReadinessStageView[];
  readonly blockers: readonly ProviderReadinessReason[];
  readonly evidence: readonly ProviderEvidenceView[];
  readonly evidenceCurrent: number;
  readonly evidenceAttention: number;
  readonly caps: Readonly<{
    currency: string;
    spendOperation: string;
    spendDay: string;
    spendMonth: string;
    volumeOperation: string;
    volumeDay: string;
    volumeMonth: string;
  }>;
  readonly switches: readonly Readonly<{ label: string; value: 'OFF' | 'PAUSED' }>[];
}

export interface ProviderReadinessCockpitView {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly snapshotAt: string;
  readonly dataset: PortalProviderReadinessSnapshot['dataset'];
  readonly illustrative: boolean;
  readonly externalEffects: false;
  readonly rails: readonly ProviderReadinessRailView[];
  readonly readyRailCount: number;
  readonly blockedRailCount: number;
  readonly totalEvidenceCurrent: number;
  readonly totalEvidenceAttention: number;
  readonly safety: Readonly<{
    liveAuthorised: false;
    providerEffectsAllowed: false;
    providerOperationsCreated: 0;
    emergencyPaused: true;
  }>;
}

const RAIL_LABELS: Readonly<Record<ProviderActivationRail, Readonly<{ eyebrow: string; label: string }>>> = Object.freeze({
  mailgun_email: Object.freeze({ eyebrow: 'Owned audience', label: 'Mailgun email' }),
  whatsapp: Object.freeze({ eyebrow: 'Private messaging', label: 'WhatsApp' }),
  public_social: Object.freeze({ eyebrow: 'Audience growth', label: 'Public social' }),
  social_dm: Object.freeze({ eyebrow: 'Conversation rail', label: 'Social DMs' }),
  webinar: Object.freeze({ eyebrow: 'Event conversion', label: 'Webinars' }),
  social_listening: Object.freeze({ eyebrow: 'Market signals', label: 'Social listening' }),
});

const STAGE_LABELS: Readonly<Record<ProviderActivationReadinessStage, string>> = Object.freeze({
  adapter_contract_verified: 'Adapter contract',
  provider_test_verified: 'Provider test',
  internal_seed_ready: 'Internal seed',
});

const READINESS_LABELS: Readonly<Record<ProviderActivationReadiness, string>> = Object.freeze({
  not_ready: 'Not ready',
  adapter_contract_verified: 'Contract verified',
  provider_test_verified: 'Provider test verified',
  internal_seed_ready: 'Internal seed ready',
});

function boundedText(value: unknown, fallback: string, max = 160): string {
  if (typeof value !== 'string') return fallback;
  const clean = value.trim();
  return clean ? [...clean].slice(0, max).join('') : fallback;
}

function instant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function gateLabel(gate: ProviderActivationGate): string {
  return gate
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (first) => first.toUpperCase());
}

function money(minorUnits: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(minorUnits / 100);
}

function safeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('provider readiness cap must be a non-negative safe integer');
  }
  return value;
}

function evidenceFreshness(
  status: ProviderEvidenceStatus,
  expiresAt: string | null,
  asOfMs: number,
): Readonly<{ freshness: ProviderEvidenceFreshness; label: string; tone: ProviderCockpitTone }> {
  if (status === 'missing') return Object.freeze({ freshness: 'missing', label: 'Missing', tone: 'blocked' });
  if (status === 'failed') return Object.freeze({ freshness: 'failed', label: 'Failed', tone: 'blocked' });
  if (status === 'not_applicable') return Object.freeze({ freshness: 'not_applicable', label: 'Not applicable', tone: 'muted' });
  if (!expiresAt || Date.parse(expiresAt) <= asOfMs) {
    return Object.freeze({ freshness: 'stale', label: 'Stale', tone: 'working' });
  }
  return Object.freeze({ freshness: 'current', label: 'Current', tone: 'ready' });
}

function assertRailSet(snapshot: PortalProviderReadinessSnapshot): void {
  if (!Array.isArray(snapshot.rails) || snapshot.rails.length !== PROVIDER_ACTIVATION_RAILS.length) {
    throw new Error('provider readiness snapshot must contain the exact dark rail set');
  }
  const rails = new Set(snapshot.rails.map((item) => item.rail));
  if (rails.size !== PROVIDER_ACTIVATION_RAILS.length
      || PROVIDER_ACTIVATION_RAILS.some((rail) => !rails.has(rail))) {
    throw new Error('provider readiness snapshot rail set is incomplete or duplicated');
  }
}

function presentRail(
  source: PortalProviderReadinessSnapshot['rails'][number],
  workspaceId: string,
  asOfMs: number,
  illustrative: boolean,
): ProviderReadinessRailView {
  const report = source.report;
  if (report.rail !== source.rail || report.workspaceId !== workspaceId || !report.inputAccepted) {
    throw new Error('provider readiness report is not bound to its workspace rail');
  }
  if (report.safety.liveAuthorised !== false
      || report.safety.providerEffectsAllowed !== false
      || report.safety.providerOperationsCreated !== 0
      || report.safety.separateActivationRequired !== true) {
    throw new Error('provider readiness report crossed the dark-only safety boundary');
  }
  if (illustrative
      && report.readiness !== 'not_ready'
      && report.readiness !== 'adapter_contract_verified') {
    throw new Error('illustrative readiness cannot claim provider-test or seed readiness');
  }
  if (illustrative && !source.candidateOnly) {
    throw new Error('illustrative providers must be labelled as candidates');
  }
  const switches = source.switches;
  if (!switches.emergencyPaused
      || switches.runtimeEffects !== 'off'
      || switches.databaseEffects !== 'off'
      || switches.workspaceEffects !== 'off'
      || switches.railEffects !== 'off') {
    throw new Error('provider readiness cockpit requires every effect switch off and the pause engaged');
  }
  if (!Array.isArray(source.evidence) || source.evidence.length !== PROVIDER_ACTIVATION_GATES.length) {
    throw new Error('provider readiness evidence catalogue is incomplete');
  }
  const evidenceGates = new Set(source.evidence.map((item) => item.gate));
  if (evidenceGates.size !== PROVIDER_ACTIVATION_GATES.length
      || PROVIDER_ACTIVATION_GATES.some((gate) => !evidenceGates.has(gate))) {
    throw new Error('provider readiness evidence gates are duplicated or missing');
  }
  const evidence = Object.freeze(source.evidence.map((item) => {
    const verifiedAt = instant(item.verifiedAt);
    const expiresAt = instant(item.expiresAt);
    const freshness = evidenceFreshness(item.status, expiresAt, asOfMs);
    return Object.freeze({
      gate: item.gate,
      label: gateLabel(item.gate),
      status: item.status,
      freshness: freshness.freshness,
      freshnessLabel: freshness.label,
      tone: freshness.tone,
      verifiedAt,
      expiresAt,
    });
  }));
  const stageByName = new Map(report.stages.map((stage) => [stage.stage, stage]));
  if (stageByName.size !== PROVIDER_ACTIVATION_READINESS_STAGES.length) {
    throw new Error('provider readiness report stage set is incomplete');
  }
  const stages = Object.freeze(PROVIDER_ACTIVATION_READINESS_STAGES.map((stage, index) => {
    const sourceStage = stageByName.get(stage);
    if (!sourceStage) throw new Error(`provider readiness stage ${stage} is missing`);
    const active = report.nextStage === stage;
    return Object.freeze({
      stage,
      label: STAGE_LABELS[stage],
      index: String(index + 1).padStart(2, '0'),
      ready: sourceStage.ready,
      active,
      tone: sourceStage.ready ? 'ready' : active ? 'working' : 'blocked',
      blockers: Object.freeze(sourceStage.blockers.map((blocker) => Object.freeze({ ...blocker }))),
    });
  }));
  const caps = source.caps;
  const operationSpend = safeCount(caps.maxSpendPerOperationMinorUnits);
  const daySpend = safeCount(caps.maxSpendPerDayMinorUnits);
  const monthSpend = safeCount(caps.maxSpendPerMonthMinorUnits);
  const operationVolume = safeCount(caps.maxVolumePerOperation);
  const dayVolume = safeCount(caps.maxVolumePerDay);
  const monthVolume = safeCount(caps.maxVolumePerMonth);
  if (operationSpend > daySpend || daySpend > monthSpend
      || operationVolume > dayVolume || dayVolume > monthVolume) {
    throw new Error('provider readiness caps are not monotonic');
  }
  const evidenceCurrent = evidence.filter((item) => item.freshness === 'current' || item.freshness === 'not_applicable').length;
  const evidenceAttention = evidence.length - evidenceCurrent;
  const label = RAIL_LABELS[source.rail];
  return Object.freeze({
    rail: source.rail,
    anchorId: `readiness-${source.rail.replaceAll('_', '-')}`,
    eyebrow: label.eyebrow,
    label: label.label,
    providerLabel: boundedText(source.providerLabel, 'Unregistered provider candidate'),
    candidateOnly: source.candidateOnly,
    readiness: report.readiness,
    readinessLabel: READINESS_LABELS[report.readiness],
    readinessTone: report.readiness === 'internal_seed_ready' || report.readiness === 'provider_test_verified'
      ? 'ready'
      : report.readiness === 'adapter_contract_verified'
        ? 'working'
        : 'blocked',
    nextStageLabel: report.nextStage ? STAGE_LABELS[report.nextStage] : 'Separate live activation',
    stages,
    blockers: Object.freeze(report.blockingReasons.map((blocker) => Object.freeze({ ...blocker }))),
    evidence,
    evidenceCurrent,
    evidenceAttention,
    caps: Object.freeze({
      currency: caps.currency,
      spendOperation: money(operationSpend, caps.currency),
      spendDay: money(daySpend, caps.currency),
      spendMonth: money(monthSpend, caps.currency),
      volumeOperation: operationVolume.toLocaleString('en-GB'),
      volumeDay: dayVolume.toLocaleString('en-GB'),
      volumeMonth: monthVolume.toLocaleString('en-GB'),
    }),
    switches: Object.freeze([
      Object.freeze({ label: 'Emergency pause', value: 'PAUSED' as const }),
      Object.freeze({ label: 'Runtime effects', value: 'OFF' as const }),
      Object.freeze({ label: 'Database effects', value: 'OFF' as const }),
      Object.freeze({ label: 'Workspace effects', value: 'OFF' as const }),
      Object.freeze({ label: 'Rail effects', value: 'OFF' as const }),
    ]),
  });
}

export function presentProviderReadinessCockpit(
  snapshot: PortalProviderReadinessSnapshot,
): ProviderReadinessCockpitView {
  if (!snapshot || snapshot.externalEffects !== false
      || (snapshot.dataset !== 'evidence' && snapshot.dataset !== 'illustrative_fixture')) {
    throw new Error('provider readiness snapshot crossed its read-only boundary');
  }
  assertRailSet(snapshot);
  const workspaceId = boundedText(snapshot.workspace?.workspaceId, '', 64);
  const workspaceName = boundedText(snapshot.workspace?.workspaceName, 'Property Predator Growth HQ');
  const snapshotAt = instant(snapshot.workspace?.snapshotAt);
  if (!workspaceId || !snapshotAt) throw new Error('provider readiness workspace boundary is invalid');
  const asOfMs = Date.parse(snapshotAt);
  const illustrative = snapshot.dataset === 'illustrative_fixture';
  const byRail = new Map(snapshot.rails.map((rail) => [rail.rail, rail]));
  const rails = Object.freeze(PROVIDER_ACTIVATION_RAILS.map((rail) =>
    presentRail(byRail.get(rail)!, workspaceId, asOfMs, illustrative)));
  const allSwitchesPaused = rails.every((rail) => rail.switches.every((item) => item.value === 'OFF' || item.value === 'PAUSED'));
  if (!allSwitchesPaused) throw new Error('provider readiness cockpit switch boundary is invalid');
  return Object.freeze({
    workspaceId,
    workspaceName,
    snapshotAt,
    dataset: snapshot.dataset,
    illustrative,
    externalEffects: false,
    rails,
    readyRailCount: rails.filter((rail) => rail.readiness !== 'not_ready').length,
    blockedRailCount: rails.filter((rail) => rail.readiness === 'not_ready').length,
    totalEvidenceCurrent: rails.reduce((total, rail) => total + rail.evidenceCurrent, 0),
    totalEvidenceAttention: rails.reduce((total, rail) => total + rail.evidenceAttention, 0),
    safety: Object.freeze({
      liveAuthorised: false,
      providerEffectsAllowed: false,
      providerOperationsCreated: 0,
      emergencyPaused: true,
    }),
  });
}
