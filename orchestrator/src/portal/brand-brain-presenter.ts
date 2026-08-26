import type {
  BrandBrainReviewDecision,
  BrandBrainReviewDimension,
  BrandBrainSourceSummary,
  BrandBrainSpecialistSummary,
} from '../brand-brain-pg/types.js';
import {
  brandBrainReadOnlyActionHref,
  type BrandBrainReadOnlyAction,
} from './brand-brain-actions.js';
import type {
  PortalBrandBrainExternalProfile,
  PortalBrandBrainSnapshot,
} from './brand-brain-service.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_SOURCES = 100;
const MAX_SPECIALISTS = 20;
const MAX_EXTERNAL_PROFILES = 10;
const MAX_CAPABILITIES = 8;

export type BrandBrainGateTone = 'pass' | 'wait' | 'blocked';

export interface BrandBrainGateView {
  readonly gateId: 'source' | 'ownership' | 'privacy' | 'brand' | 'evaluation' | 'visual_policy';
  readonly label: string;
  readonly stateLabel: string;
  readonly detail: string;
  readonly tone: BrandBrainGateTone;
  readonly passes: boolean;
}

export interface BrandBrainSourceView {
  readonly sourceId: string;
  readonly assetRole: string;
  readonly assetRoleLabel: string;
  readonly authorityLabel: string;
  readonly ownershipLabel: string;
  readonly licenceLabel: string;
  readonly privacyLabel: string;
  readonly consumerUseLabel: string;
  readonly digestLabel: string;
  readonly quarantined: boolean;
}

export interface BrandBrainSpecialistView {
  readonly profileId: string;
  readonly name: string;
  readonly capabilities: readonly string[];
  readonly sourceStatusLabel: string;
  readonly hqStatusLabel: string;
  readonly runtimeReady: boolean;
  readonly runtimeLabel: string;
  readonly blockedReason: string | null;
  readonly brandDigestLabel: string;
}

export interface BrandBrainExternalProfileView {
  readonly profileId: string;
  readonly name: string;
  readonly purpose: string;
  readonly statusLabel: 'Awaiting founder export';
  readonly callableLabel: 'Not callable';
}

export interface BrandBrainConflictView {
  readonly title: 'Panther imagery vs no-animal visual rule';
  readonly statusLabel: 'Quarantined';
  readonly detail: string;
  readonly resolution: string;
}

export interface BrandBrainReadOnlyActionView {
  readonly action: BrandBrainReadOnlyAction;
  readonly label: string;
  readonly href: string;
}

export interface BrandBrainView {
  readonly workspaceName: string;
  readonly asOf: string;
  readonly datasetLabel: string;
  readonly illustrative: boolean;
  readonly release: Readonly<{
    sourceReleaseId: string;
    manifestDigestLabel: string;
    runtimeBrandDigestLabel: string;
    recordedAt: string;
    sourceFresh: boolean;
    sourceFreshLabel: string;
  }>;
  readonly sources: readonly BrandBrainSourceView[];
  readonly specialists: readonly BrandBrainSpecialistView[];
  readonly externalProfiles: readonly BrandBrainExternalProfileView[];
  readonly gates: readonly BrandBrainGateView[];
  readonly metrics: Readonly<{
    sourceCount: number;
    specialistCount: number;
    runtimeReadyCount: number;
    externalAwaitingCount: number;
    artworkCount: number;
    approvedReviewCount: number;
    requiredReviewCount: 3;
    quarantineCount: number;
  }>;
  readonly conflict: BrandBrainConflictView | null;
  readonly activated: boolean;
  readonly activationLabel: string;
  readonly readyToActivate: boolean;
  readonly canManage: boolean;
  readonly providerEffectsOff: true;
  readonly inputTruncated: boolean;
  readonly actions: readonly BrandBrainReadOnlyActionView[];
}

export class BrandBrainPresentationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrandBrainPresentationError';
  }
}

function boundedText(value: unknown, fallback: string, maximum = 240): string {
  if (typeof value !== 'string') return fallback;
  const text = value.trim().replace(/[\u0000-\u001f\u007f]/gu, ' ');
  return [...text].slice(0, maximum).join('') || fallback;
}

function tokenLabel(value: unknown, fallback: string): string {
  const text = boundedText(value, fallback, 100);
  return text
    .replace(/[._/-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/^./u, (character) => character.toLocaleUpperCase('en-GB'));
}

function safeInstant(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 1_000_000)
    : 0;
}

function digestLabel(value: unknown): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new BrandBrainPresentationError('Brand Brain metadata contains an invalid digest');
  }
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function reviewDecision(
  reviews: readonly Readonly<{ dimension: BrandBrainReviewDimension; decision: BrandBrainReviewDecision }>[],
  dimension: BrandBrainReviewDimension,
): BrandBrainReviewDecision | null {
  return reviews.find((review) => review.dimension === dimension)?.decision ?? null;
}

function reviewGate(
  gateId: 'ownership' | 'privacy' | 'brand',
  label: string,
  decision: BrandBrainReviewDecision | null,
): BrandBrainGateView {
  if (decision === 'approved') return Object.freeze({
    gateId,
    label,
    stateLabel: 'Approved',
    detail: 'A hash-bound governance decision is recorded for this source release.',
    tone: 'pass',
    passes: true,
  });
  if (decision === 'rejected') return Object.freeze({
    gateId,
    label,
    stateLabel: 'Rejected',
    detail: 'This source release cannot advance until a corrected release is reviewed.',
    tone: 'blocked',
    passes: false,
  });
  return Object.freeze({
    gateId,
    label,
    stateLabel: 'Awaiting review',
    detail: 'No governance decision is recorded for this exact source release.',
    tone: 'wait',
    passes: false,
  });
}

function sourceView(source: BrandBrainSourceSummary): BrandBrainSourceView {
  const consumerUse = boundedText(source.consumerUse, 'unavailable', 100);
  return Object.freeze({
    sourceId: boundedText(source.sourceId, 'source-unavailable', 200),
    assetRole: boundedText(source.assetRole, 'unknown', 100),
    assetRoleLabel: tokenLabel(source.assetRole, 'Source metadata'),
    authorityLabel: tokenLabel(source.authorityStatus, 'Authority unavailable'),
    ownershipLabel: tokenLabel(source.ownershipStatus, 'Ownership unavailable'),
    licenceLabel: tokenLabel(source.licenceStatus, 'Licence unavailable'),
    privacyLabel: tokenLabel(source.privacyClass, 'Privacy unavailable'),
    consumerUseLabel: tokenLabel(consumerUse, 'Use unavailable'),
    digestLabel: digestLabel(source.contentSha256),
    quarantined: consumerUse === 'quarantine-only',
  });
}

function specialistView(profile: BrandBrainSpecialistSummary): BrandBrainSpecialistView {
  const capabilities = Array.isArray(profile.capabilities)
    ? profile.capabilities
      .slice(0, MAX_CAPABILITIES)
      .map((capability) => boundedText(capability, '', 100))
      .filter(Boolean)
    : [];
  const runtimeReady = profile.runtimeReady === true;
  return Object.freeze({
    profileId: boundedText(profile.profileId, 'profile-unavailable', 200),
    name: boundedText(profile.name, 'Unnamed specialist', 200),
    capabilities: Object.freeze(capabilities),
    sourceStatusLabel: tokenLabel(profile.sourceStatus, 'Source status unavailable'),
    hqStatusLabel: tokenLabel(profile.hqActivationStatus, 'HQ status unavailable'),
    runtimeReady,
    runtimeLabel: runtimeReady ? 'Runtime ready' : 'Runtime locked',
    blockedReason: runtimeReady || profile.blockedReason === null
      ? null
      : boundedText(profile.blockedReason, 'Governance work is incomplete.', 320),
    brandDigestLabel: digestLabel(profile.runtimeBrandSha256),
  });
}

function externalProfileView(profile: PortalBrandBrainExternalProfile): BrandBrainExternalProfileView {
  if (profile.status !== 'awaiting_founder_export' || profile.callable !== false) {
    throw new BrandBrainPresentationError('An external specialist crossed the safe founder-export boundary');
  }
  return Object.freeze({
    profileId: boundedText(profile.profileId, 'external-profile-unavailable', 200),
    name: boundedText(profile.name, 'Founder specialist', 200),
    purpose: boundedText(profile.purpose, 'Founder-owned specialist awaiting export.', 320),
    statusLabel: 'Awaiting founder export',
    callableLabel: 'Not callable',
  });
}

function action(action: BrandBrainReadOnlyAction, label: string): BrandBrainReadOnlyActionView {
  return Object.freeze({ action, label, href: brandBrainReadOnlyActionHref(action) });
}

/**
 * Allowlist presentation: raw prompt bodies, knowledge bytes, source paths,
 * storage locators and secrets cannot enter the returned view model.
 */
export function presentBrandBrain(snapshot: PortalBrandBrainSnapshot): BrandBrainView {
  if (snapshot.brain.providerEffects !== false) {
    throw new BrandBrainPresentationError('Provider effects must remain off');
  }
  const sourcesInput = Array.isArray(snapshot.brain.sources) ? snapshot.brain.sources : [];
  const specialistsInput = Array.isArray(snapshot.brain.specialists) ? snapshot.brain.specialists : [];
  const externalInput = Array.isArray(snapshot.externalProfiles) ? snapshot.externalProfiles : [];
  const sources = Object.freeze(sourcesInput.slice(0, MAX_SOURCES).map(sourceView));
  const specialists = Object.freeze(specialistsInput.slice(0, MAX_SPECIALISTS).map(specialistView));
  const externalProfiles = Object.freeze(externalInput
    .slice(0, MAX_EXTERNAL_PROFILES)
    .map(externalProfileView));
  const ownership = reviewDecision(snapshot.brain.reviews, 'ownership_licence');
  const privacy = reviewDecision(snapshot.brain.reviews, 'privacy_security');
  const brand = reviewDecision(snapshot.brain.reviews, 'brand_readiness');
  const gates: readonly BrandBrainGateView[] = Object.freeze([
    Object.freeze({
      gateId: 'source',
      label: 'Canonical source release',
      stateLabel: snapshot.brain.sourceFresh ? 'Source proof fresh' : 'Source proof stale',
      detail: snapshot.brain.sourceFresh
        ? 'The metadata manifest is inside its attested freshness window.'
        : 'Refresh the source attestation before any further review.',
      tone: snapshot.brain.sourceFresh ? 'pass' : 'blocked',
      passes: snapshot.brain.sourceFresh,
    }),
    reviewGate('ownership', 'Ownership and licence', ownership),
    reviewGate('privacy', 'Privacy and security', privacy),
    reviewGate('brand', 'Brand readiness', brand),
    Object.freeze({
      gateId: 'evaluation',
      label: 'Golden evaluation suite',
      stateLabel: snapshot.brain.evaluationPassed ? 'Passed' : 'Not passed',
      detail: snapshot.brain.evaluationPassed
        ? 'The positive and negative brand examples passed against this exact release.'
        : 'Run and record the reviewed golden examples before runtime use.',
      tone: snapshot.brain.evaluationPassed ? 'pass' : 'wait',
      passes: snapshot.brain.evaluationPassed,
    }),
    Object.freeze({
      gateId: 'visual_policy',
      label: 'Visual policy',
      stateLabel: snapshot.brain.visualPolicyConflict ? 'Conflict quarantined' : 'No open conflict',
      detail: snapshot.brain.visualPolicyConflict
        ? 'Conflicting visual rules are excluded from runtime profile inputs.'
        : 'No quarantined visual-policy conflict is recorded for this release.',
      tone: snapshot.brain.visualPolicyConflict ? 'blocked' : 'pass',
      passes: !snapshot.brain.visualPolicyConflict,
    }),
  ]);
  const approvedReviewCount = [ownership, privacy, brand]
    .filter((decision) => decision === 'approved').length;
  const runtimeReadyCount = specialists.filter((profile) => profile.runtimeReady).length;
  const readyToActivate = gates.every((gate) => gate.passes)
    && specialists.length > 0
    && runtimeReadyCount === specialists.length
    && externalProfiles.length === 0;
  return Object.freeze({
    workspaceName: boundedText(snapshot.workspace.workspaceName, 'Property Predator Growth HQ', 200),
    asOf: safeInstant(snapshot.workspace.snapshotAt, snapshot.brain.recordedAt),
    datasetLabel: snapshot.dataset === 'postgres_authoritative'
      ? 'Authoritative metadata'
      : 'Illustrative metadata fixture',
    illustrative: snapshot.dataset !== 'postgres_authoritative',
    release: Object.freeze({
      sourceReleaseId: boundedText(snapshot.brain.sourceReleaseId, 'release-unavailable', 200),
      manifestDigestLabel: digestLabel(snapshot.brain.manifestSha256),
      runtimeBrandDigestLabel: digestLabel(snapshot.brain.runtimeBrandSha256),
      recordedAt: safeInstant(snapshot.brain.recordedAt, snapshot.workspace.snapshotAt),
      sourceFresh: snapshot.brain.sourceFresh === true,
      sourceFreshLabel: snapshot.brain.sourceFresh ? 'Fresh source proof' : 'Source proof stale',
    }),
    sources,
    specialists,
    externalProfiles,
    gates,
    metrics: Object.freeze({
      sourceCount: sources.length,
      specialistCount: specialists.length,
      runtimeReadyCount,
      externalAwaitingCount: externalProfiles.length,
      artworkCount: safeCount(snapshot.brain.artworkCount),
      approvedReviewCount,
      requiredReviewCount: 3,
      quarantineCount: safeCount(snapshot.brain.quarantineCount),
    }),
    conflict: snapshot.brain.visualPolicyConflict ? Object.freeze({
      title: 'Panther imagery vs no-animal visual rule',
      statusLabel: 'Quarantined',
      detail: 'One source says panther imagery is part of the visual system while another prohibits animal imagery. Neither rule is allowed into a runtime profile while they disagree.',
      resolution: 'Founder chooses the canonical visual direction; the corrected source release must then be reviewed and re-evaluated.',
    }) : null,
    activated: snapshot.brain.activated === true,
    activationLabel: snapshot.brain.activated ? 'Recorded active' : 'Not activated',
    readyToActivate,
    canManage: snapshot.workspace.canManage === true,
    providerEffectsOff: true,
    inputTruncated: sourcesInput.length > MAX_SOURCES
      || specialistsInput.length > MAX_SPECIALISTS
      || externalInput.length > MAX_EXTERNAL_PROFILES,
    actions: Object.freeze([
      action('content_library', 'Open Content Control'),
      action('source_release', 'Inspect source proof'),
      action('founder_exports', 'See founder exports'),
      ...(snapshot.brain.visualPolicyConflict
        ? [action('quarantine', 'Review quarantine')]
        : []),
    ]),
  });
}
