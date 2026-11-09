import { createHash } from 'node:crypto';
import {
  canonicalPropertyPredatorAiInventoryJson,
  parsePropertyPredatorAiInventory,
  PROPERTY_PREDATOR_EXTERNAL_GPT_PLACEHOLDERS,
  type PropertyPredatorAiInventory,
  type PropertyPredatorAiInventorySource,
} from '../company-content-adapter/property-predator-ai-inventory.js';
import {
  BrandBrainConflictError,
  BrandBrainValidationError,
  type BrandBrainReviewDimension,
  type BrandBrainSnapshot,
} from './types.js';

const SAFE_PLAN_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DELIVERABLE_PROFILE = Object.freeze({
  post: 'propertypredator.owned.social/v1',
  thread: 'propertypredator.owned.social/v1',
  article: 'propertypredator.owned.content/v1',
  image: 'propertypredator.owned.image/v1',
  email: 'propertypredator.owned.email/v1',
  script: 'propertypredator.owned.video/v1',
  ad: 'propertypredator.owned.ad/v1',
} as const);
const REQUIRED_REVIEWS: readonly BrandBrainReviewDimension[] = Object.freeze([
  'ownership_licence', 'privacy_security', 'brand_readiness',
]);

export type BrandBrainDeliverableKind = keyof typeof DELIVERABLE_PROFILE;
export type BrandBrainRuntimeReferenceKind = 'role' | 'policy' | 'instruction' | 'knowledge';

export interface PlanBrandBrainCommand {
  readonly planKey: string;
  readonly deliverableKind: BrandBrainDeliverableKind;
}

export interface BrandBrainRuntimeSourceReference {
  readonly kind: BrandBrainRuntimeReferenceKind;
  readonly sourceId: string;
  readonly contentSha256: string;
  readonly assetRole: string;
  readonly authorityStatus: 'authoritative-runtime';
  readonly consumerUse: 'runtime-authority-reference';
}

export interface EffectsOffBrandBrainPlan {
  readonly schemaVersion: 1;
  readonly planKey: string;
  readonly deliverableKind: BrandBrainDeliverableKind;
  readonly sourceReleaseId: string;
  readonly manifestSha256: string;
  readonly runtimeBrandSha256: string;
  readonly specialistProfileId: string;
  readonly sourceReferences: readonly BrandBrainRuntimeSourceReference[];
  readonly planSha256: string;
  readonly sourceReviewRequired: true;
  readonly callable: false;
  readonly providerEffects: false;
  readonly externalSpecialists: typeof PROPERTY_PREDATOR_EXTERNAL_GPT_PLACEHOLDERS;
}

function runtimeReference(
  source: PropertyPredatorAiInventorySource,
  kind: BrandBrainRuntimeReferenceKind,
): BrandBrainRuntimeSourceReference {
  if (source.authorityStatus !== 'authoritative-runtime'
      || source.consumerUse !== 'runtime-authority-reference') {
    throw new BrandBrainConflictError('Brand Brain runtime selection contained held-out or quarantined material');
  }
  return Object.freeze({
    kind,
    sourceId: source.sourceId,
    contentSha256: source.contentSha256,
    assetRole: source.assetRole,
    authorityStatus: 'authoritative-runtime' as const,
    consumerUse: 'runtime-authority-reference' as const,
  });
}

function assertApprovedSnapshot(snapshot: BrandBrainSnapshot): void {
  if (snapshot.providerEffects !== false) {
    throw new BrandBrainConflictError('Brand Brain snapshot violates the effects-off boundary');
  }
  if (!snapshot.activated || !snapshot.sourceFresh || !snapshot.evaluationPassed) {
    throw new BrandBrainConflictError('Brand Brain release is not activated, fresh and evaluation-passed');
  }
  const decisions = new Map(snapshot.reviews.map((review) => [review.dimension, review.decision]));
  if (REQUIRED_REVIEWS.some((dimension) => decisions.get(dimension) !== 'approved')) {
    throw new BrandBrainConflictError('Brand Brain release is missing an independent approval dimension');
  }
}

function assertSnapshotMatchesInventory(
  snapshot: BrandBrainSnapshot,
  inventory: PropertyPredatorAiInventory,
): void {
  if (snapshot.sourceSystem !== 'property-predator'
      || snapshot.manifestSha256 !== inventory.packageSha256
      || snapshot.runtimeBrandSha256 !== inventory.specialistProfiles[0]?.runtimeBrandSha256
      || snapshot.sources.length !== inventory.sources.length) {
    throw new BrandBrainConflictError('Brand Brain snapshot does not match the verified source manifest');
  }
  const storedSources = new Map(snapshot.sources.map((source) => [source.sourceId, source]));
  for (const source of inventory.sources) {
    const stored = storedSources.get(source.sourceId);
    if (!stored || stored.contentSha256 !== source.contentSha256
        || stored.assetRole !== source.assetRole || stored.authorityStatus !== source.authorityStatus
        || stored.consumerUse !== source.consumerUse || stored.ownershipStatus !== source.ownershipStatus
        || stored.licenceStatus !== source.licenceStatus || stored.privacyClass !== source.privacyClass) {
      throw new BrandBrainConflictError('Brand Brain stored source reference differs from the verified manifest');
    }
  }
}

export function planEffectsOffBrandBrainRuntime(
  snapshot: BrandBrainSnapshot,
  candidateInventory: PropertyPredatorAiInventory,
  command: PlanBrandBrainCommand,
): EffectsOffBrandBrainPlan {
  if (typeof command.planKey !== 'string' || !SAFE_PLAN_KEY.test(command.planKey)) {
    throw new BrandBrainValidationError('Brand Brain plan key is invalid');
  }
  if (!Object.hasOwn(DELIVERABLE_PROFILE, command.deliverableKind)) {
    throw new BrandBrainValidationError('Brand Brain deliverable kind is unsupported');
  }
  const inventory = parsePropertyPredatorAiInventory(candidateInventory);
  assertApprovedSnapshot(snapshot);
  assertSnapshotMatchesInventory(snapshot, inventory);

  const profileId = DELIVERABLE_PROFILE[command.deliverableKind];
  const profile = inventory.specialistProfiles.find((candidate) => candidate.profileId === profileId);
  const storedProfile = snapshot.specialists.find((candidate) => candidate.profileId === profileId);
  if (!profile || !storedProfile || storedProfile.runtimeBrandSha256 !== profile.runtimeBrandSha256
      || !storedProfile.capabilities.includes(command.deliverableKind) || !storedProfile.runtimeReady) {
    throw new BrandBrainConflictError('Brand Brain specialist is not runtime-ready for this deliverable');
  }
  if (command.deliverableKind === 'image'
      && (snapshot.visualPolicyConflict || storedProfile.blockedReason === 'visual_policy_conflict')) {
    throw new BrandBrainConflictError('Brand Brain image runtime is blocked by the panther visual-policy conflict');
  }

  const sourceById = new Map(inventory.sources.map((source) => [source.sourceId, source]));
  const selected: readonly (readonly [string, BrandBrainRuntimeReferenceKind])[] = [
    [profile.roleSourceId, 'role'],
    [profile.policySourceId, 'policy'],
    ...profile.instructionSourceIds.map((sourceId) => [sourceId, 'instruction'] as const),
    ...profile.knowledgeSourceIds.map((sourceId) => [sourceId, 'knowledge'] as const),
  ];
  const sourceReferences = Object.freeze(selected.map(([sourceId, kind]) => {
    const source = sourceById.get(sourceId);
    if (!source) throw new BrandBrainConflictError('Brand Brain specialist references a missing source');
    return runtimeReference(source, kind);
  }));
  const planWithoutHash = {
    schemaVersion: 1 as const,
    planKey: command.planKey,
    deliverableKind: command.deliverableKind,
    sourceReleaseId: snapshot.sourceReleaseId,
    manifestSha256: snapshot.manifestSha256,
    runtimeBrandSha256: snapshot.runtimeBrandSha256,
    specialistProfileId: profileId,
    sourceReferences,
    sourceReviewRequired: true as const,
    callable: false as const,
    providerEffects: false as const,
    externalSpecialists: PROPERTY_PREDATOR_EXTERNAL_GPT_PLACEHOLDERS,
  };
  const planSha256 = createHash('sha256')
    .update(canonicalPropertyPredatorAiInventoryJson(planWithoutHash), 'utf8')
    .digest('hex');
  return Object.freeze({ ...planWithoutHash, planSha256 });
}
