import { createHash } from 'node:crypto';
import type { ConversionJourneyDefinition } from '../conversion-pg/types.js';
import {
  PROPERTY_PREDATOR_AGENCY_LAPS_JOURNEY,
  PROPERTY_PREDATOR_SELF_SERVE_JOURNEY,
} from '../conversion-pg/property-predator-blueprints.js';
import {
  canonicalFounderSpecialistPackJson,
  parseFounderSpecialistPack,
  type FounderSpecialistPack,
} from './founder-specialist-pack.js';
import {
  PROPERTY_PREDATOR_MARKETING_PACK,
  PROPERTY_PREDATOR_MARKETING_SOURCE_BYTE_LENGTH,
  PROPERTY_PREDATOR_MARKETING_SOURCE_FILE_COUNT,
  PROPERTY_PREDATOR_MARKETING_SOURCE_INVENTORY_SHA256,
} from './property-predator-marketing-pack-registry.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DEFAULT_SELECTION_KEY = 'property-predator-self-serve:activated';
const SOCIAL_SPECIALIST_ID = 'propertypredator.owned.social/v1';
const REQUIRED_REVIEWS = Object.freeze([
  'ownership_licence',
  'privacy_security',
  'brand_readiness',
] as const);
const REQUIRED_PACK_REFERENCES = Object.freeze([
  Object.freeze({
    fileId: 'reference.laps',
    methodId: 'propertypredator.laps/v1',
    label: 'Property Predator LAPS conversion spine',
    contentSha256: 'd3ee32ee663ad13605af79d656c63ac8fb11b1c9b13abcd6caad7a5775d0ee74',
  }),
  Object.freeze({
    fileId: 'reference.licensed-methods',
    methodId: 'propertypredator.licensed-content-system/v1',
    label: 'Licensed content-system method',
    contentSha256: '80ae7a3141b86178d88a34591ade6424be51662876e9a1695bf798b889c7371d',
  }),
  Object.freeze({
    fileId: 'reference.routing',
    methodId: 'propertypredator.specialist-routing/v1',
    label: 'Property Predator specialist routing',
    contentSha256: '427f001b5cadf8b673e2ddbbc2d89c422885381be556eb1e7828954e185f6ce0',
  }),
  Object.freeze({
    fileId: 'reference.specialists',
    methodId: 'propertypredator.specialist-responsibilities/v1',
    label: 'Owned specialist responsibilities',
    contentSha256: 'cf855c15b32a57ada2ec8502ad69d2e23bc2945abd208b87c42487a7cbb48604',
  }),
] as const);

const JOBS: Readonly<Record<string, string>> = Object.freeze({
  'property-predator-self-serve:lead': 'Create useful awareness and earn an identified Property Predator lead.',
  'property-predator-self-serve:activated': 'Move an identified lead towards meaningful Property Predator product activation.',
  'property-predator-self-serve:priced': 'Help an activated lead understand the relevant Property Predator offer.',
  'property-predator-self-serve:sale': 'Help an offer-aware lead make a clear, evidence-led buying decision.',
  'property-predator-agency-laps:lead': 'Create useful awareness and earn an identified agency or organisation lead.',
  'property-predator-agency-laps:appointment': 'Move an agency lead towards a booked, permissioned appointment.',
  'property-predator-agency-laps:presentation': 'Prepare an appointed lead for a useful Property Predator presentation.',
  'property-predator-agency-laps:sale': 'Help a presented opportunity make a clear, evidence-led buying decision.',
});

export interface PropertyPredatorMarketingLapsOption {
  readonly key: string;
  readonly journeySlug: string;
  readonly journeyName: string;
  readonly journeyVersion: number;
  readonly journeyDefinitionSha256: string;
  readonly targetMilestoneKey: string;
  readonly targetMilestoneName: string;
  readonly targetMilestonePosition: number;
  readonly previousMilestoneKey: string | null;
  readonly previousMilestoneName: string | null;
  readonly label: string;
  readonly marketingJob: string;
}

export type PropertyPredatorMarketingDraftBlockerCode =
  | 'selection_invalid'
  | 'marketing_pack_invalid'
  | 'marketing_pack_identity_mismatch'
  | 'marketing_pack_reference_mismatch'
  | 'brand_brain_missing'
  | 'brand_brain_metadata_invalid'
  | 'brand_brain_scope_mismatch'
  | 'brand_brain_not_ready'
  | 'brand_brain_reviews_incomplete'
  | 'brand_brain_social_specialist_not_ready'
  | 'marketing_pack_registration_missing'
  | 'marketing_pack_registration_mismatch';

export interface PropertyPredatorMarketingDraftBlocker {
  readonly code: PropertyPredatorMarketingDraftBlockerCode;
  readonly message: string;
}

export interface PropertyPredatorMarketingDraftPlan {
  readonly schemaVersion: 1;
  readonly scope: 'property-predator';
  readonly deliverableKind: 'social_post';
  readonly selection: PropertyPredatorMarketingLapsOption;
  readonly pack: Readonly<{
    packId: string;
    packageSha256: string;
    reviewStatus: 'review-required';
  }> | null;
  readonly brandBrain: Readonly<{
    sourceReleaseId: string;
    manifestSha256: string;
    runtimeBrandSha256: string;
    specialistProfileId: typeof SOCIAL_SPECIALIST_ID;
  }> | null;
  readonly methods: readonly Readonly<{
    methodId: string;
    label: string;
    contentSha256: string;
  }>[];
  readonly handoffs: readonly Readonly<{
    sequence: number;
    specialistId: string;
    specialistLabel: string;
    responsibility: string;
    status: 'draft-metadata-only' | 'optional-visual-blocked';
  }>[];
  readonly blockers: readonly PropertyPredatorMarketingDraftBlocker[];
  readonly readiness: 'draft_recipe_ready' | 'blocked';
  readonly planSha256: string;
  readonly callable: false;
  readonly persisted: false;
  readonly providerEffects: false;
}

export interface PlanPropertyPredatorMarketingDraftInput {
  readonly selection?: string | null;
  /** Candidate may be injected in contract tests; production uses the settled inert registry. */
  readonly marketingPack?: unknown;
  /** Read-only Portal Brand Brain projection. Raw sources and prompt bodies are neither needed nor accepted. */
  readonly brandBrainSnapshot?: unknown;
}

function option(journey: ConversionJourneyDefinition, milestoneIndex: number): PropertyPredatorMarketingLapsOption {
  const milestone = journey.milestones[milestoneIndex]!;
  const previous = journey.milestones[milestoneIndex - 1] ?? null;
  const key = `${journey.slug}:${milestone.key}`;
  return Object.freeze({
    key,
    journeySlug: journey.slug,
    journeyName: journey.name,
    journeyVersion: journey.version,
    journeyDefinitionSha256: journey.definitionHash,
    targetMilestoneKey: milestone.key,
    targetMilestoneName: milestone.name,
    targetMilestonePosition: milestone.position,
    previousMilestoneKey: previous?.key ?? null,
    previousMilestoneName: previous?.name ?? null,
    label: `${journey.name} · ${milestone.name}`,
    marketingJob: JOBS[key] ?? 'Create a useful, evidence-led step towards the selected milestone.',
  });
}

export const PROPERTY_PREDATOR_MARKETING_LAPS_OPTIONS: readonly PropertyPredatorMarketingLapsOption[] =
  Object.freeze([
    ...PROPERTY_PREDATOR_SELF_SERVE_JOURNEY.milestones.map((_milestone, index) =>
      option(PROPERTY_PREDATOR_SELF_SERVE_JOURNEY, index)),
    ...PROPERTY_PREDATOR_AGENCY_LAPS_JOURNEY.milestones.map((_milestone, index) =>
      option(PROPERTY_PREDATOR_AGENCY_LAPS_JOURNEY, index)),
  ]);

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return value as Record<string, unknown>;
}

function addBlocker(
  blockers: PropertyPredatorMarketingDraftBlocker[],
  code: PropertyPredatorMarketingDraftBlockerCode,
  message: string,
): void {
  if (!blockers.some((blocker) => blocker.code === code)) {
    blockers.push(Object.freeze({ code, message }));
  }
}

function resolveSelection(
  candidate: string | null | undefined,
  blockers: PropertyPredatorMarketingDraftBlocker[],
): PropertyPredatorMarketingLapsOption {
  const selected = candidate === undefined || candidate === null || candidate === ''
    ? DEFAULT_SELECTION_KEY
    : candidate;
  const exact = PROPERTY_PREDATOR_MARKETING_LAPS_OPTIONS.find((entry) => entry.key === selected);
  if (exact) return exact;
  addBlocker(
    blockers,
    'selection_invalid',
    'Choose one canonical Property Predator LAPS milestone before drafting.',
  );
  return PROPERTY_PREDATOR_MARKETING_LAPS_OPTIONS.find((entry) => entry.key === DEFAULT_SELECTION_KEY)!;
}

function validatePack(
  candidate: unknown,
  blockers: PropertyPredatorMarketingDraftBlocker[],
): FounderSpecialistPack | null {
  let pack: FounderSpecialistPack;
  try {
    pack = parseFounderSpecialistPack(candidate);
  } catch {
    addBlocker(blockers, 'marketing_pack_invalid', 'The adapted marketing pack failed its inert metadata contract.');
    return null;
  }
  if (pack.packId !== PROPERTY_PREDATOR_MARKETING_PACK.packId
      || pack.packageSha256 !== PROPERTY_PREDATOR_MARKETING_PACK.packageSha256) {
    addBlocker(blockers, 'marketing_pack_identity_mismatch', 'The adapted marketing pack identity or package digest does not match the registered release.');
    return null;
  }
  const references = new Map(pack.files.map((file) => [file.fileId, file.contentSha256]));
  if (REQUIRED_PACK_REFERENCES.some((reference) =>
    references.get(reference.fileId) !== reference.contentSha256)) {
    addBlocker(blockers, 'marketing_pack_reference_mismatch', 'A required LAPS, method or routing digest does not match the registered release.');
    return null;
  }
  return pack;
}

function validateRegisteredPack(
  snapshot: Record<string, unknown>,
  blockers: PropertyPredatorMarketingDraftBlocker[],
): void {
  if (!Array.isArray(snapshot.adaptedMethodPacks)) {
    addBlocker(blockers, 'marketing_pack_registration_missing', 'Brand Brain has not registered the adapted marketing pack metadata.');
    return;
  }
  const registered = snapshot.adaptedMethodPacks.find((candidate) => {
    const entry = plainRecord(candidate);
    const pack = plainRecord(entry?.pack);
    return pack?.packId === PROPERTY_PREDATOR_MARKETING_PACK.packId;
  });
  const entry = plainRecord(registered);
  if (!entry) {
    addBlocker(blockers, 'marketing_pack_registration_missing', 'Brand Brain has not registered the adapted marketing pack metadata.');
    return;
  }
  const registeredPack = validatePack(entry.pack, blockers);
  if (!registeredPack
      || entry.sourceInventorySha256 !== PROPERTY_PREDATOR_MARKETING_SOURCE_INVENTORY_SHA256
      || entry.sourceFileCount !== PROPERTY_PREDATOR_MARKETING_SOURCE_FILE_COUNT
      || entry.sourceByteLength !== PROPERTY_PREDATOR_MARKETING_SOURCE_BYTE_LENGTH) {
    addBlocker(blockers, 'marketing_pack_registration_mismatch', 'Brand Brain adapted-pack inventory metadata does not match the registered release.');
  }
}

function validateBrandBrain(
  candidate: unknown,
  blockers: PropertyPredatorMarketingDraftBlocker[],
): { metadata: PropertyPredatorMarketingDraftPlan['brandBrain']; visualPolicyConflict: boolean } {
  const snapshot = plainRecord(candidate);
  if (!snapshot) {
    addBlocker(blockers, 'brand_brain_missing', 'Brand Brain metadata is unavailable; the draft recipe remains blocked.');
    return { metadata: null, visualPolicyConflict: false };
  }
  validateRegisteredPack(snapshot, blockers);
  const brain = plainRecord(snapshot.brain);
  if (!brain || !UUID.test(String(brain.sourceReleaseId ?? ''))
      || !SHA256.test(String(brain.manifestSha256 ?? ''))
      || !SHA256.test(String(brain.runtimeBrandSha256 ?? ''))
      || !Array.isArray(brain.reviews) || !Array.isArray(brain.specialists)) {
    addBlocker(blockers, 'brand_brain_metadata_invalid', 'Brand Brain release metadata or digest evidence is invalid.');
    return { metadata: null, visualPolicyConflict: false };
  }
  if (brain.sourceSystem !== 'property-predator' || brain.providerEffects !== false) {
    addBlocker(blockers, 'brand_brain_scope_mismatch', 'Brand Brain is not an effects-off Property Predator release.');
  }
  if (brain.activated !== true || brain.sourceFresh !== true || brain.evaluationPassed !== true) {
    addBlocker(blockers, 'brand_brain_not_ready', 'Brand Brain must be activated, source-fresh and evaluation-passed before drafting.');
  }
  const decisions = new Map<string, unknown>();
  for (const candidateReview of brain.reviews) {
    const review = plainRecord(candidateReview);
    if (review && typeof review.dimension === 'string') decisions.set(review.dimension, review.decision);
  }
  if (REQUIRED_REVIEWS.some((dimension) => decisions.get(dimension) !== 'approved')) {
    addBlocker(blockers, 'brand_brain_reviews_incomplete', 'Brand Brain is missing an approved ownership, privacy or brand-readiness review.');
  }
  const social = brain.specialists
    .map(plainRecord)
    .find((profile) => profile?.profileId === SOCIAL_SPECIALIST_ID);
  if (!social || social.runtimeReady !== true
      || social.runtimeBrandSha256 !== brain.runtimeBrandSha256
      || !Array.isArray(social.capabilities) || !social.capabilities.includes('post')) {
    addBlocker(blockers, 'brand_brain_social_specialist_not_ready', 'The owned social specialist is not runtime-ready for a social-post draft.');
  }
  const metadata = brain.sourceSystem === 'property-predator' && brain.providerEffects === false
    ? Object.freeze({
        sourceReleaseId: String(brain.sourceReleaseId),
        manifestSha256: String(brain.manifestSha256),
        runtimeBrandSha256: String(brain.runtimeBrandSha256),
        specialistProfileId: SOCIAL_SPECIALIST_ID,
      })
    : null;
  return { metadata, visualPolicyConflict: brain.visualPolicyConflict === true };
}

function handoffs(marketingJob: string, visualPolicyConflict: boolean): PropertyPredatorMarketingDraftPlan['handoffs'] {
  return Object.freeze([
    Object.freeze({
      sequence: 1,
      specialistId: 'propertypredator.method.offer-architect/v1',
      specialistLabel: 'Offer Architect',
      responsibility: `Frame the offer and call to action for this job: ${marketingJob}`,
      status: 'draft-metadata-only' as const,
    }),
    Object.freeze({
      sequence: 2,
      specialistId: 'propertypredator.method.direct-response-copywriter/v1',
      specialistLabel: 'Direct Response Copywriter',
      responsibility: 'Propose distinct evidence-led copy angles for founder review.',
      status: 'draft-metadata-only' as const,
    }),
    Object.freeze({
      sequence: 3,
      specialistId: SOCIAL_SPECIALIST_ID,
      specialistLabel: 'Social Media Manager',
      responsibility: 'Adapt the selected angle into channel-native social-post drafts.',
      status: 'draft-metadata-only' as const,
    }),
    Object.freeze({
      sequence: 4,
      specialistId: 'propertypredator.owned.image/v1',
      specialistLabel: 'Image and Diagram Maker',
      responsibility: visualPolicyConflict
        ? 'Hold the optional visual brief until the visual-policy conflict is resolved.'
        : 'Propose an optional on-brand visual brief after the copy direction is selected.',
      status: visualPolicyConflict ? 'optional-visual-blocked' as const : 'draft-metadata-only' as const,
    }),
  ]);
}

export function planPropertyPredatorMarketingDraft(
  input: PlanPropertyPredatorMarketingDraftInput = {},
): PropertyPredatorMarketingDraftPlan {
  const blockers: PropertyPredatorMarketingDraftBlocker[] = [];
  const selection = resolveSelection(input.selection, blockers);
  const pack = validatePack(
    input.marketingPack === undefined ? PROPERTY_PREDATOR_MARKETING_PACK : input.marketingPack,
    blockers,
  );
  let brain: ReturnType<typeof validateBrandBrain>;
  try {
    brain = validateBrandBrain(input.brandBrainSnapshot, blockers);
  } catch {
    addBlocker(blockers, 'brand_brain_metadata_invalid', 'Brand Brain release metadata or digest evidence is invalid.');
    brain = { metadata: null, visualPolicyConflict: false };
  }
  const methods = Object.freeze(REQUIRED_PACK_REFERENCES.map((reference) => Object.freeze({
    methodId: reference.methodId,
    label: reference.label,
    contentSha256: reference.contentSha256,
  })));
  const immutableBlockers = Object.freeze([...blockers]);
  const planWithoutHash = {
    schemaVersion: 1 as const,
    scope: 'property-predator' as const,
    deliverableKind: 'social_post' as const,
    selection,
    pack: pack ? Object.freeze({
      packId: pack.packId,
      packageSha256: pack.packageSha256,
      reviewStatus: pack.reviewStatus,
    }) : null,
    brandBrain: brain.metadata,
    methods,
    handoffs: handoffs(selection.marketingJob, brain.visualPolicyConflict),
    blockers: immutableBlockers,
    readiness: immutableBlockers.length === 0 ? 'draft_recipe_ready' as const : 'blocked' as const,
    callable: false as const,
    persisted: false as const,
    providerEffects: false as const,
  };
  const planSha256 = createHash('sha256')
    .update(canonicalFounderSpecialistPackJson(planWithoutHash), 'utf8')
    .digest('hex');
  return Object.freeze({ ...planWithoutHash, planSha256 });
}
