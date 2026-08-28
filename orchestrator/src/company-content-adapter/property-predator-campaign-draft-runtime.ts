import { createHash } from 'node:crypto';
import { canonicalCompanyContentJson } from '../company-content-pg/validation.js';
import {
  planPropertyPredatorMarketingDraft,
  type PlanPropertyPredatorMarketingDraftInput,
  type PropertyPredatorMarketingDraftPlan,
} from './property-predator-marketing-draft-plan.js';
import type {
  PropertyPredatorGeneratedDraft,
  PropertyPredatorGenerationTransport,
} from './property-predator-generation.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;
const SAFE_SOURCE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const SOCIAL_SPECIALIST_ID = 'propertypredator.owned.social/v1';
const SOURCE_SYSTEM = 'propertypredator.company-content';
const MAX_HARD_COST_MINOR = 25_000;
const MAX_FACTS = 24;
const MAX_ASSETS = 8;

export const PROPERTY_PREDATOR_CAMPAIGN_DRAFT_CONTEXT_SCHEMA =
  'propertypredator.campaign-draft-context/v1' as const;
export const PROPERTY_PREDATOR_CAMPAIGN_DRAFT_RESULT_SCHEMA =
  'propertypredator.review-campaign-draft/v1' as const;

export type PropertyPredatorCampaignDraftRuntimeErrorCode =
  | 'invalid_configuration'
  | 'invalid_command'
  | 'effects_disabled'
  | 'emergency_paused'
  | 'draft_plan_blocked'
  | 'stale_plan'
  | 'evidence_invalid'
  | 'cost_limit_exceeded'
  | 'integrity_mismatch';

const ERROR_MESSAGES: Readonly<Record<PropertyPredatorCampaignDraftRuntimeErrorCode, string>> =
  Object.freeze({
    invalid_configuration: 'campaign draft runtime configuration is invalid',
    invalid_command: 'campaign draft command is invalid',
    effects_disabled: 'campaign draft generation effects are disabled',
    emergency_paused: 'campaign draft generation is emergency-paused',
    draft_plan_blocked: 'campaign draft plan is blocked',
    stale_plan: 'campaign draft plan evidence is stale',
    evidence_invalid: 'campaign draft evidence is invalid',
    cost_limit_exceeded: 'campaign draft cost limit is unavailable',
    integrity_mismatch: 'campaign draft integrity check failed',
  });

export class PropertyPredatorCampaignDraftRuntimeError extends Error {
  constructor(readonly code: PropertyPredatorCampaignDraftRuntimeErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'PropertyPredatorCampaignDraftRuntimeError';
  }
}

function fail(code: PropertyPredatorCampaignDraftRuntimeErrorCode): never {
  throw new PropertyPredatorCampaignDraftRuntimeError(code);
}

export interface PropertyPredatorCampaignDraftBrandEvidence {
  readonly sourceSystem: 'property-predator';
  readonly sourceReleaseId: string;
  readonly manifestSha256: string;
  readonly runtimeBrandSha256: string;
  readonly specialistProfileId: typeof SOCIAL_SPECIALIST_ID;
}

export interface PropertyPredatorCampaignDraftApprovedVersionEvidence {
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly versionNumber: number;
  readonly contentSha256: string;
  readonly blobSha256: string;
  readonly brandSha256: string;
  readonly approvalRequestId: string;
  readonly approvalDecisionId: string;
  readonly approvalStatus: 'approved';
  readonly approvalStale: false;
  readonly sourceFresh: true;
  readonly publishable: true;
  readonly sourceSystem: typeof SOURCE_SYSTEM;
  readonly sourceItemId: string;
  readonly sourceVersion: string;
  readonly kind: 'article' | 'document' | 'email' | 'image' | 'social_post' | 'video' | 'webinar' | 'other';
}

export interface PropertyPredatorCampaignDraftCommand {
  /** Replay identity also enforced by the secured generation bridge. */
  readonly idempotencyKey: string;
  /** Exact plan digest shown to the operator; prevents a stale screen from generating. */
  readonly expectedPlanSha256: string;
  readonly maximumCostMinor: number;
  readonly providerEffects: 'generation_only';
  readonly brief: Readonly<{
    readonly platform: string;
    readonly topic: string;
    readonly tone: string;
  }>;
  readonly draftPlan: PlanPropertyPredatorMarketingDraftInput;
  readonly brandBrain: PropertyPredatorCampaignDraftBrandEvidence;
  readonly approvedFacts: readonly PropertyPredatorCampaignDraftApprovedVersionEvidence[];
  readonly approvedAssets: readonly PropertyPredatorCampaignDraftApprovedVersionEvidence[];
}

export interface PropertyPredatorCampaignDraftEvidenceContext {
  readonly schema: typeof PROPERTY_PREDATOR_CAMPAIGN_DRAFT_CONTEXT_SCHEMA;
  readonly plan: Readonly<{
    readonly planSha256: string;
    readonly packSha256: string;
    readonly selectionKey: string;
    readonly journeyDefinitionSha256: string;
    readonly targetMilestoneKey: string;
  }>;
  readonly brandBrain: PropertyPredatorCampaignDraftBrandEvidence;
  readonly approvedFacts: readonly PropertyPredatorCampaignDraftApprovedVersionEvidence[];
  readonly approvedAssets: readonly PropertyPredatorCampaignDraftApprovedVersionEvidence[];
  readonly generationLimit: Readonly<{
    readonly requestCount: 1;
    readonly maximumCostMinor: number;
    readonly quotaAuthority: 'generation_bridge_atomic_policy';
  }>;
}

export interface PropertyPredatorReviewCampaignDraft {
  readonly schema: typeof PROPERTY_PREDATOR_CAMPAIGN_DRAFT_RESULT_SCHEMA;
  readonly status: 'source_review_required';
  readonly approvalStatus: 'unrequested';
  readonly reviewRequired: true;
  readonly publishable: false;
  readonly sendable: false;
  readonly schedulable: false;
  readonly providerEffects: 'generation_only';
  readonly outboundEffects: false;
  readonly planSha256: string;
  readonly evidenceSha256: string;
  readonly contextSha256: string;
  readonly idempotencyKeySha256: string;
  readonly maximumCostMinor: number;
  readonly spendAccounting: 'maximum_reserved_provider_tokens_unpriced';
  readonly evidence: PropertyPredatorCampaignDraftEvidenceContext;
  readonly immutableSource: Readonly<{
    readonly draftId: string;
    readonly versionId: string;
    readonly itemVersion: number;
    readonly contentSha256: string;
    readonly brandSha256: string;
    readonly usageSha256: string;
  }>;
  readonly draft: PropertyPredatorGeneratedDraft;
  readonly resultSha256: string;
}

export interface PropertyPredatorCampaignDraftRuntimeOptions {
  readonly generation: Pick<PropertyPredatorGenerationTransport, 'generateDraft'>;
  /** Deliberately required: omission is dark, not implicit permission. */
  readonly providerEffectsEnabled: boolean;
  /** Deliberately required: only exact false permits a provider call. */
  readonly emergencyPaused: boolean;
  /** A second ceiling inside Growth HQ; the bridge policy still reserves atomically. */
  readonly hardMaximumCostMinor: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function digest(value: unknown, code: PropertyPredatorCampaignDraftRuntimeErrorCode): string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code);
  return value;
}

function uuid(value: unknown, code: PropertyPredatorCampaignDraftRuntimeErrorCode): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(code);
  return value.toLowerCase();
}

function safeSourceValue(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_SOURCE_VALUE.test(value)) fail('evidence_invalid');
  return value;
}

function readyPlan(input: PlanPropertyPredatorMarketingDraftInput): PropertyPredatorMarketingDraftPlan & {
  readonly pack: NonNullable<PropertyPredatorMarketingDraftPlan['pack']>;
  readonly brandBrain: NonNullable<PropertyPredatorMarketingDraftPlan['brandBrain']>;
} {
  let plan: PropertyPredatorMarketingDraftPlan;
  try {
    plan = planPropertyPredatorMarketingDraft(input);
  } catch {
    fail('draft_plan_blocked');
  }
  if (plan.readiness !== 'draft_recipe_ready' || plan.blockers.length !== 0
      || plan.callable !== false || plan.persisted !== false || plan.providerEffects !== false
      || plan.deliverableKind !== 'social_post' || !plan.pack || !plan.brandBrain) {
    fail('draft_plan_blocked');
  }
  return plan as PropertyPredatorMarketingDraftPlan & {
    readonly pack: NonNullable<PropertyPredatorMarketingDraftPlan['pack']>;
    readonly brandBrain: NonNullable<PropertyPredatorMarketingDraftPlan['brandBrain']>;
  };
}

function brandEvidence(
  input: PropertyPredatorCampaignDraftBrandEvidence,
  plan: ReturnType<typeof readyPlan>,
): PropertyPredatorCampaignDraftBrandEvidence {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || input.sourceSystem !== 'property-predator'
      || uuid(input.sourceReleaseId, 'evidence_invalid') !== plan.brandBrain.sourceReleaseId
      || digest(input.manifestSha256, 'evidence_invalid') !== plan.brandBrain.manifestSha256
      || digest(input.runtimeBrandSha256, 'evidence_invalid') !== plan.brandBrain.runtimeBrandSha256
      || input.specialistProfileId !== SOCIAL_SPECIALIST_ID
      || input.specialistProfileId !== plan.brandBrain.specialistProfileId) {
    fail('evidence_invalid');
  }
  return Object.freeze({
    sourceSystem: 'property-predator',
    sourceReleaseId: input.sourceReleaseId.toLowerCase(),
    manifestSha256: input.manifestSha256,
    runtimeBrandSha256: input.runtimeBrandSha256,
    specialistProfileId: SOCIAL_SPECIALIST_ID,
  });
}

const FACT_KINDS = new Set(['article', 'document', 'email', 'social_post', 'webinar', 'other']);
const ASSET_KINDS = new Set(['image', 'video']);

function approvedVersion(
  input: PropertyPredatorCampaignDraftApprovedVersionEvidence,
  expectedBrandSha256: string,
  expectedKind: 'fact' | 'asset',
): PropertyPredatorCampaignDraftApprovedVersionEvidence {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || !Number.isSafeInteger(input.versionNumber) || input.versionNumber < 1
      || input.approvalStatus !== 'approved' || input.approvalStale !== false
      || input.sourceFresh !== true || input.publishable !== true
      || input.sourceSystem !== SOURCE_SYSTEM
      || digest(input.brandSha256, 'evidence_invalid') !== expectedBrandSha256
      || (expectedKind === 'fact' ? !FACT_KINDS.has(input.kind) : !ASSET_KINDS.has(input.kind))) {
    fail('evidence_invalid');
  }
  return Object.freeze({
    contentItemId: uuid(input.contentItemId, 'evidence_invalid'),
    contentVersionId: uuid(input.contentVersionId, 'evidence_invalid'),
    versionNumber: input.versionNumber,
    contentSha256: digest(input.contentSha256, 'evidence_invalid'),
    blobSha256: digest(input.blobSha256, 'evidence_invalid'),
    brandSha256: input.brandSha256,
    approvalRequestId: uuid(input.approvalRequestId, 'evidence_invalid'),
    approvalDecisionId: uuid(input.approvalDecisionId, 'evidence_invalid'),
    approvalStatus: 'approved',
    approvalStale: false,
    sourceFresh: true,
    publishable: true,
    sourceSystem: SOURCE_SYSTEM,
    sourceItemId: safeSourceValue(input.sourceItemId),
    sourceVersion: safeSourceValue(input.sourceVersion),
    kind: input.kind,
  });
}

function approvedVersions(
  input: readonly PropertyPredatorCampaignDraftApprovedVersionEvidence[],
  expectedBrandSha256: string,
  expectedKind: 'fact' | 'asset',
): readonly PropertyPredatorCampaignDraftApprovedVersionEvidence[] {
  const maximum = expectedKind === 'fact' ? MAX_FACTS : MAX_ASSETS;
  if (!Array.isArray(input) || input.length < 1 || input.length > maximum) fail('evidence_invalid');
  const versions = input.map((entry) => approvedVersion(entry, expectedBrandSha256, expectedKind));
  const identities = new Set(versions.map((entry) => entry.contentVersionId));
  if (identities.size !== versions.length) fail('evidence_invalid');
  return Object.freeze([...versions].sort((left, right) =>
    left.contentVersionId.localeCompare(right.contentVersionId)));
}

function safeBrief(input: PropertyPredatorCampaignDraftCommand['brief']): Readonly<{
  platform: string;
  topic: string;
  tone: string;
}> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.platform !== 'string' || input.platform !== input.platform.trim()
      || input.platform.length < 1 || input.platform.length > 40
      || typeof input.topic !== 'string' || input.topic !== input.topic.trim()
      || input.topic.length < 1 || input.topic.length > 400
      || typeof input.tone !== 'string' || input.tone !== input.tone.trim()
      || input.tone.length > 60) {
    fail('invalid_command');
  }
  return Object.freeze({ platform: input.platform, topic: input.topic, tone: input.tone });
}

function immutableDraft(
  input: PropertyPredatorGeneratedDraft,
  contextSha256: string,
  expectedBrandSha256: string,
  platform: string,
): PropertyPredatorGeneratedDraft {
  if (!input || typeof input !== 'object'
      || !input.payload || typeof input.payload !== 'object'
      || !input.usage || typeof input.usage !== 'object'
      || input.ok !== true || input.schemaVersion !== 1
      || input.status !== 'source_review_required' || input.payload.kind !== 'post'
      || input.payload.type !== 'generated' || input.payload.platform !== platform
      || input.contextSha256 !== contextSha256 || input.payload.contextSha256 !== contextSha256
      || input.brandSha256 !== expectedBrandSha256
      || uuid(input.draftId, 'integrity_mismatch') !== input.draftId
      || uuid(input.versionId, 'integrity_mismatch') !== input.versionId
      || input.itemVersion !== 1) {
    fail('integrity_mismatch');
  }
  let contentSha256: string;
  let usageSha256: string;
  try {
    contentSha256 = sha256(canonicalCompanyContentJson(input.payload));
    usageSha256 = sha256(canonicalCompanyContentJson(input.usage));
  } catch {
    fail('integrity_mismatch');
  }
  if (digest(input.contentSha256, 'integrity_mismatch') !== contentSha256
      || digest(input.usageSha256, 'integrity_mismatch') !== usageSha256) {
    fail('integrity_mismatch');
  }
  const payload = Object.freeze({ ...input.payload });
  const usage = Object.freeze({ ...input.usage });
  return Object.freeze({ ...input, payload, usage });
}

/**
 * Generates exactly one source-owned draft and nothing else. The only effect is
 * the fenced company-content model call. There is deliberately no send,
 * schedule, publish or approval operation on this runtime.
 */
export class PropertyPredatorCampaignDraftRuntime {
  readonly #generation: Pick<PropertyPredatorGenerationTransport, 'generateDraft'>;
  readonly #providerEffectsEnabled: boolean;
  readonly #emergencyPaused: boolean;
  readonly #hardMaximumCostMinor: number;

  constructor(options: PropertyPredatorCampaignDraftRuntimeOptions) {
    if (!options || typeof options !== 'object'
        || typeof options.generation?.generateDraft !== 'function'
        || typeof options.providerEffectsEnabled !== 'boolean'
        || typeof options.emergencyPaused !== 'boolean'
        || !Number.isSafeInteger(options.hardMaximumCostMinor)
        || options.hardMaximumCostMinor < 1
        || options.hardMaximumCostMinor > MAX_HARD_COST_MINOR) {
      fail('invalid_configuration');
    }
    this.#generation = options.generation;
    this.#providerEffectsEnabled = options.providerEffectsEnabled;
    this.#emergencyPaused = options.emergencyPaused;
    this.#hardMaximumCostMinor = options.hardMaximumCostMinor;
  }

  async generateReviewDraft(
    input: PropertyPredatorCampaignDraftCommand,
  ): Promise<PropertyPredatorReviewCampaignDraft> {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || typeof input.idempotencyKey !== 'string' || !SAFE_KEY.test(input.idempotencyKey)
        || input.providerEffects !== 'generation_only'
        || !Number.isSafeInteger(input.maximumCostMinor) || input.maximumCostMinor < 1) {
      fail('invalid_command');
    }
    if (!this.#providerEffectsEnabled) fail('effects_disabled');
    if (this.#emergencyPaused) fail('emergency_paused');
    if (input.maximumCostMinor > this.#hardMaximumCostMinor) fail('cost_limit_exceeded');

    const plan = readyPlan(input.draftPlan);
    if (digest(input.expectedPlanSha256, 'invalid_command') !== plan.planSha256) fail('stale_plan');
    const brand = brandEvidence(input.brandBrain, plan);
    const approvedFacts = approvedVersions(input.approvedFacts, brand.runtimeBrandSha256, 'fact');
    const approvedAssets = approvedVersions(input.approvedAssets, brand.runtimeBrandSha256, 'asset');
    const brief = safeBrief(input.brief);
    const evidence: PropertyPredatorCampaignDraftEvidenceContext = Object.freeze({
      schema: PROPERTY_PREDATOR_CAMPAIGN_DRAFT_CONTEXT_SCHEMA,
      plan: Object.freeze({
        planSha256: plan.planSha256,
        packSha256: plan.pack.packageSha256,
        selectionKey: plan.selection.key,
        journeyDefinitionSha256: plan.selection.journeyDefinitionSha256,
        targetMilestoneKey: plan.selection.targetMilestoneKey,
      }),
      brandBrain: brand,
      approvedFacts,
      approvedAssets,
      generationLimit: Object.freeze({
        requestCount: 1,
        maximumCostMinor: input.maximumCostMinor,
        quotaAuthority: 'generation_bridge_atomic_policy',
      }),
    });
    const evidenceSha256 = sha256(canonicalCompanyContentJson(evidence));
    const generated = await this.#generation.generateDraft(Object.freeze({
      idempotencyKey: input.idempotencyKey,
      expectedBrandSha256: brand.runtimeBrandSha256,
      contextSha256: evidenceSha256,
      maximumCostMinor: input.maximumCostMinor,
      brief: Object.freeze({ kind: 'post', ...brief }),
    }));
    const draft = immutableDraft(generated, evidenceSha256, brand.runtimeBrandSha256, brief.platform);
    const immutableSource = Object.freeze({
      draftId: draft.draftId,
      versionId: draft.versionId,
      itemVersion: draft.itemVersion,
      contentSha256: draft.contentSha256,
      brandSha256: draft.brandSha256,
      usageSha256: draft.usageSha256,
    });
    const resultWithoutHash = Object.freeze({
      schema: PROPERTY_PREDATOR_CAMPAIGN_DRAFT_RESULT_SCHEMA,
      status: 'source_review_required' as const,
      approvalStatus: 'unrequested' as const,
      reviewRequired: true as const,
      publishable: false as const,
      sendable: false as const,
      schedulable: false as const,
      providerEffects: 'generation_only' as const,
      outboundEffects: false as const,
      planSha256: plan.planSha256,
      evidenceSha256,
      contextSha256: evidenceSha256,
      idempotencyKeySha256: sha256(input.idempotencyKey),
      maximumCostMinor: input.maximumCostMinor,
      spendAccounting: 'maximum_reserved_provider_tokens_unpriced' as const,
      evidence,
      immutableSource,
      draft,
    });
    return Object.freeze({
      ...resultWithoutHash,
      resultSha256: sha256(canonicalCompanyContentJson(resultWithoutHash)),
    });
  }
}
