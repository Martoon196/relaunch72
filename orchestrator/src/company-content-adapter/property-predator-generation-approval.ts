import { createHash } from 'node:crypto';
import type { DatabaseRequestContext } from '../db/rls.js';
import type {
  CompanyContentApprovalDecision,
  CompanyContentVersionApprovalState,
  CreateCompanyContentVersionCommand,
  CreateCompanyContentVersionResult,
  DecideCompanyContentApprovalResult,
  RequestCompanyContentApprovalResult,
  RefreshCompanyContentSourceAttestationCommand,
  RefreshCompanyContentSourceAttestationResult,
} from '../company-content-pg/types.js';
import { canonicalCompanyContentJson } from '../company-content-pg/validation.js';
import {
  planPropertyPredatorMarketingDraft,
  type PlanPropertyPredatorMarketingDraftInput,
  type PropertyPredatorMarketingDraftPlan,
} from './property-predator-marketing-draft-plan.js';
import type {
  PropertyPredatorGenerateDraftCommand,
  PropertyPredatorGeneratedDraft,
  PropertyPredatorGenerationTransport,
} from './property-predator-generation.js';
import type { PropertyPredatorGeneratedSourceRevalidator } from './property-predator-generated-source.js';

const SOURCE_SYSTEM = 'property_predator_generation';
const CONTENT_MIME_TYPE = 'application/vnd.propertypredator.company-content+json';
const ATTESTATION_FRESHNESS_MS = 10 * 60 * 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMAND_KEY = /^[\x21-\x7e]{1,200}$/u;

export type PropertyPredatorGeneratedDraftLifecycleErrorCode =
  | 'invalid_input'
  | 'draft_plan_blocked'
  | 'integrity_mismatch'
  | 'revision_conflict'
  | 'approval_conflict';

const ERROR_MESSAGES: Readonly<Record<PropertyPredatorGeneratedDraftLifecycleErrorCode, string>> =
  Object.freeze({
    invalid_input: 'Property Predator generated-draft lifecycle input is invalid',
    draft_plan_blocked: 'Property Predator marketing draft plan is blocked',
    integrity_mismatch: 'Property Predator generated-draft integrity check failed',
    revision_conflict: 'Property Predator generated-draft revision is no longer current',
    approval_conflict: 'Property Predator generated-draft approval target does not match',
  });

export class PropertyPredatorGeneratedDraftLifecycleError extends Error {
  constructor(readonly code: PropertyPredatorGeneratedDraftLifecycleErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'PropertyPredatorGeneratedDraftLifecycleError';
  }
}

function fail(code: PropertyPredatorGeneratedDraftLifecycleErrorCode): never {
  throw new PropertyPredatorGeneratedDraftLifecycleError(code);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('invalid_input');
  return value.toLowerCase();
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail('invalid_input');
  return value;
}

function commandKey(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim() || !COMMAND_KEY.test(value)) {
    fail('invalid_input');
  }
  return value;
}

function instant(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('invalid_input');
  return new Date(value.getTime());
}

export interface PropertyPredatorGeneratedDraftRevisionTarget {
  /** Stable source identity returned by the first staged version. */
  readonly sourceItemId: string;
  readonly contentItemId: string;
  readonly previousVersionId: string;
  readonly previousVersionNumber: number;
  readonly previousContentSha256: string;
}

export interface StagePropertyPredatorGeneratedDraftInput {
  readonly persistenceCommandKey: string;
  /** The lifecycle, not the caller, owns the canonical strategy-context digest. */
  readonly generation: Omit<PropertyPredatorGenerateDraftCommand, 'contextSha256'>;
  readonly draftPlan: PlanPropertyPredatorMarketingDraftInput;
  /** Exact approved source versions selected by the server-side wizard evidence read. */
  readonly approvedEvidence?: Readonly<{
    readonly facts: readonly Readonly<{ contentItemId: string; versionId: string; contentSha256: string; brandSha256: string; approvalRequestId: string; approvalDecisionId: string }>[];
    readonly assets: readonly Readonly<{ contentItemId: string; versionId: string; contentSha256: string; brandSha256: string; approvalRequestId: string; approvalDecisionId: string }>[];
  }>;
  /** Historical server read time for the exact approval tuples above. */
  readonly approvedEvidenceCheckedAt?: string;
  /** Omit for the first immutable version; supply the exact latest tuple for a revision. */
  readonly revision?: PropertyPredatorGeneratedDraftRevisionTarget | null;
}

export interface PropertyPredatorGeneratedDraftReviewTarget {
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly versionNumber: number;
  readonly contentSha256: string;
}

export interface StagedPropertyPredatorGeneratedDraft {
  readonly status: 'draft';
  readonly approvalStatus: 'unrequested';
  readonly reviewRequired: true;
  readonly publishable: false;
  readonly providerEffects: false;
  readonly disposition: 'applied' | 'replayed';
  readonly sourceItemId: string;
  readonly sourceDraftId: string;
  readonly sourceVersionId: string;
  readonly sourceItemVersion: number;
  readonly planSha256: string;
  readonly brandSha256: string;
  readonly usageSha256: string;
  readonly generationContextSha256: string;
  /** Canonical generated bytes returned for the immediate review response. */
  readonly draft: PropertyPredatorGeneratedDraft;
  readonly reviewTarget: PropertyPredatorGeneratedDraftReviewTarget;
}

export interface PropertyPredatorMarketingGenerationContext {
  readonly schema: 'propertypredator.marketing-generation-context/v1';
  readonly planSha256: string;
  readonly selection: Readonly<{
    key: string;
    journeySlug: string;
    journeyVersion: number;
    journeyDefinitionSha256: string;
    targetMilestoneKey: string;
    targetMilestonePosition: number;
    marketingJob: string;
  }>;
  readonly methods: readonly Readonly<{
    methodId: string;
    contentSha256: string;
  }>[];
  readonly specialists: readonly Readonly<{
    sequence: number;
    specialistId: string;
    status: 'draft-metadata-only' | 'optional-visual-blocked';
  }>[];
  readonly approvedEvidence?: StagePropertyPredatorGeneratedDraftInput['approvedEvidence'];
  readonly approvedEvidenceStatus?: 'approved_at_preflight';
  readonly approvedEvidenceCheckedAt?: string;
}

export interface PropertyPredatorGeneratedDraftApprovalRequest {
  readonly status: 'pending_review';
  readonly reviewRequired: true;
  readonly publishable: false;
  readonly providerEffects: false;
  readonly disposition: 'applied' | 'replayed';
  readonly approvalRequestId: string;
  readonly requestNumber: number;
  readonly reviewTarget: PropertyPredatorGeneratedDraftReviewTarget;
}

export interface PropertyPredatorGeneratedDraftRestrictiveDecision {
  readonly status: 'rejected' | 'changes_requested';
  readonly publishable: false;
  readonly providerEffects: false;
  readonly disposition: 'applied' | 'replayed';
  readonly approvalDecisionId: string;
  readonly approvalRequestId: string;
  readonly reviewTarget: PropertyPredatorGeneratedDraftReviewTarget;
}

export interface RequestPropertyPredatorGeneratedDraftApprovalInput {
  readonly commandKey: string;
  readonly reviewTarget: PropertyPredatorGeneratedDraftReviewTarget;
  readonly reviewNote?: string | null;
}

export interface DecidePropertyPredatorGeneratedDraftRestrictionInput {
  readonly commandKey: string;
  readonly approvalRequestId: string;
  readonly reviewTarget: PropertyPredatorGeneratedDraftReviewTarget;
  /** Approval is deliberately absent: this boundary does not render the exact bytes for a human. */
  readonly decision: 'rejected' | 'changes_requested';
  readonly decisionNote: string;
}

export interface PropertyPredatorGeneratedDraftContentService {
  createVersion(
    context: DatabaseRequestContext,
    command: CreateCompanyContentVersionCommand,
  ): Promise<CreateCompanyContentVersionResult>;
  listVersionApprovalStates(
    context: DatabaseRequestContext,
    contentItemId: string,
  ): Promise<CompanyContentVersionApprovalState[]>;
  requestApproval(
    context: DatabaseRequestContext,
    command: Readonly<{
      commandKey: string;
      contentItemId: string;
      contentVersionId: string;
      reviewNote?: string | null;
    }>,
  ): Promise<RequestCompanyContentApprovalResult>;
  decideApproval(
    context: DatabaseRequestContext,
    command: Readonly<{
      commandKey: string;
      approvalRequestId: string;
      decision: CompanyContentApprovalDecision;
      decisionNote?: string | null;
    }>,
  ): Promise<DecideCompanyContentApprovalResult>;
  refreshSourceAttestation?(
    context: DatabaseRequestContext,
    command: RefreshCompanyContentSourceAttestationCommand,
  ): Promise<RefreshCompanyContentSourceAttestationResult>;
}

export interface PropertyPredatorGeneratedDraftLifecycleDependencies {
  readonly generation: Pick<PropertyPredatorGenerationTransport, 'generateDraft'>;
  readonly content: PropertyPredatorGeneratedDraftContentService;
  /** Re-reads selected approval/freshness evidence after generation and before persistence. */
  readonly revalidateEvidence?: (
    context: DatabaseRequestContext,
    evidence: NonNullable<StagePropertyPredatorGeneratedDraftInput['approvedEvidence']>,
  ) => Promise<Readonly<{ valid: boolean; checkedAt: string }>>;
  /** Exact, read-only source lookup used to renew approved generated drafts. */
  readonly generatedSource?: Pick<PropertyPredatorGeneratedSourceRevalidator, 'verify'>;
  readonly now?: () => Date;
}

export interface RefreshApprovedPropertyPredatorGeneratedSourceInput {
  readonly commandKey: string;
  readonly reviewTarget: PropertyPredatorGeneratedDraftReviewTarget;
}

export interface RefreshedApprovedPropertyPredatorGeneratedSource {
  readonly disposition: 'applied' | 'replayed';
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly sourceAttestationId: string;
  readonly sourceAttestationExpiresAt: string;
  readonly providerEffects: false;
}

function revisionTarget(
  value: PropertyPredatorGeneratedDraftRevisionTarget | null | undefined,
): Readonly<PropertyPredatorGeneratedDraftRevisionTarget> | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value.previousVersionNumber) || value.previousVersionNumber < 1) {
    fail('invalid_input');
  }
  return Object.freeze({
    sourceItemId: uuid(value.sourceItemId),
    contentItemId: uuid(value.contentItemId),
    previousVersionId: uuid(value.previousVersionId),
    previousVersionNumber: value.previousVersionNumber,
    previousContentSha256: digest(value.previousContentSha256),
  });
}

function reviewTarget(value: PropertyPredatorGeneratedDraftReviewTarget): PropertyPredatorGeneratedDraftReviewTarget {
  if (!Number.isSafeInteger(value?.versionNumber) || value.versionNumber < 1) fail('invalid_input');
  return Object.freeze({
    contentItemId: uuid(value.contentItemId),
    contentVersionId: uuid(value.contentVersionId),
    versionNumber: value.versionNumber,
    contentSha256: digest(value.contentSha256),
  });
}

function exactCurrentVersion(
  states: readonly CompanyContentVersionApprovalState[],
  target: PropertyPredatorGeneratedDraftReviewTarget,
): CompanyContentVersionApprovalState {
  if (!Array.isArray(states) || states.length < 1) fail('revision_conflict');
  const latest = states.reduce((candidate, state) => (
    state.versionNumber > candidate.versionNumber ? state : candidate
  ));
  if (latest.contentItemId.toLowerCase() !== target.contentItemId
      || latest.contentVersionId.toLowerCase() !== target.contentVersionId
      || latest.versionNumber !== target.versionNumber
      || latest.contentSha256 !== target.contentSha256) {
    fail('revision_conflict');
  }
  return latest;
}

export interface GeneratedSourceRenewalTarget {
  readonly sourceItemId: string;
  readonly sourceVersionId: string;
  readonly sourceItemVersion: number;
  readonly contentSha256: string;
  readonly brandSha256: string;
}

export function generatedSourceRenewalTarget(
  states: readonly CompanyContentVersionApprovalState[],
  current: CompanyContentVersionApprovalState,
): GeneratedSourceRenewalTarget {
  if (states.length > 100) fail('integrity_mismatch');
  const byId = new Map<string, CompanyContentVersionApprovalState>();
  const versionNumbers = new Set<number>();
  for (const candidate of states) {
    const id = candidate.contentVersionId.toLowerCase();
    if (byId.has(id) || versionNumbers.has(candidate.versionNumber)) fail('integrity_mismatch');
    byId.set(id, candidate);
    versionNumbers.add(candidate.versionNumber);
  }
  const visited = new Set<string>();
  let candidate = current;
  while (true) {
    const candidateId = candidate.contentVersionId.toLowerCase();
    if (visited.has(candidateId)) fail('integrity_mismatch');
    visited.add(candidateId);
    if (candidate.origin === 'generated') {
      const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):v([1-9][0-9]*)$/u
        .exec(candidate.source.version);
      const source = candidate.sourceMetadata;
      if (!match || !source || typeof source !== 'object' || Array.isArray(source)) {
        fail('integrity_mismatch');
      }
      const evidence = source as Record<string, unknown>;
      if (evidence.schema !== 'propertypredator.generated-draft-source/v1'
          || evidence.sourceItemId !== candidate.source.itemId
          || evidence.sourceVersionId !== match[1]
          || evidence.sourceItemVersion !== Number(match[2])
          || evidence.contentSha256 !== candidate.contentSha256
          || evidence.brandSha256 !== candidate.brandSha256
          || typeof evidence.sourceDraftId !== 'string' || !UUID.test(evidence.sourceDraftId)) {
        fail('integrity_mismatch');
      }
      return Object.freeze({
        sourceItemId: evidence.sourceDraftId,
        sourceVersionId: match[1]!,
        sourceItemVersion: Number(match[2]),
        contentSha256: candidate.contentSha256,
        brandSha256: candidate.brandSha256,
      });
    }
    if (candidate.origin !== 'edited'
        || candidate.editor !== 'growth_hq_exact_review'
        || !candidate.previousVersionId || !UUID.test(candidate.previousVersionId)
        || !candidate.previousContentVersionId || !UUID.test(candidate.previousContentVersionId)
        || candidate.previousVersionId.toLowerCase() !== candidate.previousContentVersionId.toLowerCase()
        || !candidate.previousContentSha256 || !SHA256.test(candidate.previousContentSha256)) {
      fail('integrity_mismatch');
    }
    const predecessor = byId.get(candidate.previousVersionId.toLowerCase());
    if (!predecessor
        || predecessor.contentItemId.toLowerCase() !== candidate.contentItemId.toLowerCase()
        || predecessor.versionNumber + 1 !== candidate.versionNumber
        || predecessor.contentSha256 !== candidate.previousContentSha256
        || predecessor.source.system !== candidate.source.system
        || predecessor.source.itemId !== candidate.source.itemId
        || predecessor.brandSha256 !== candidate.brandSha256
        || candidate.source.version !== `${predecessor.source.version.slice(0, 430)}:edit:${candidate.contentSha256.slice(0, 16)}`) {
      fail('integrity_mismatch');
    }
    candidate = predecessor;
  }
}

function assertReadyPlan(
  plan: PropertyPredatorMarketingDraftPlan,
  generation: Omit<PropertyPredatorGenerateDraftCommand, 'contextSha256'>,
): asserts plan is PropertyPredatorMarketingDraftPlan & {
  readonly brandBrain: NonNullable<PropertyPredatorMarketingDraftPlan['brandBrain']>;
  readonly pack: NonNullable<PropertyPredatorMarketingDraftPlan['pack']>;
} {
  if (plan.readiness !== 'draft_recipe_ready' || plan.blockers.length !== 0
      || plan.callable !== false || plan.persisted !== false || plan.providerEffects !== false
      || !plan.brandBrain || !plan.pack) {
    fail('draft_plan_blocked');
  }
  if (generation.expectedBrandSha256 !== plan.brandBrain.runtimeBrandSha256
      || generation.brief.kind !== 'post'
      || plan.deliverableKind !== 'social_post') {
    fail('integrity_mismatch');
  }
}

function marketingGenerationContext(
  plan: PropertyPredatorMarketingDraftPlan & {
    readonly brandBrain: NonNullable<PropertyPredatorMarketingDraftPlan['brandBrain']>;
    readonly pack: NonNullable<PropertyPredatorMarketingDraftPlan['pack']>;
  },
  approvedEvidence?: StagePropertyPredatorGeneratedDraftInput['approvedEvidence'],
): Readonly<{
  evidence: PropertyPredatorMarketingGenerationContext;
  sha256: string;
}> {
  const evidence: PropertyPredatorMarketingGenerationContext = Object.freeze({
    schema: 'propertypredator.marketing-generation-context/v1',
    planSha256: plan.planSha256,
    selection: Object.freeze({
      key: plan.selection.key,
      journeySlug: plan.selection.journeySlug,
      journeyVersion: plan.selection.journeyVersion,
      journeyDefinitionSha256: plan.selection.journeyDefinitionSha256,
      targetMilestoneKey: plan.selection.targetMilestoneKey,
      targetMilestonePosition: plan.selection.targetMilestonePosition,
      marketingJob: plan.selection.marketingJob,
    }),
    methods: Object.freeze(plan.methods.map((method) => Object.freeze({
      methodId: method.methodId,
      contentSha256: method.contentSha256,
    }))),
    specialists: Object.freeze(plan.handoffs.map((handoff) => Object.freeze({
      sequence: handoff.sequence,
      specialistId: handoff.specialistId,
      status: handoff.status,
    }))),
    ...(approvedEvidence ? { approvedEvidence: Object.freeze({
      facts: Object.freeze(approvedEvidence.facts.map((item) => Object.freeze({ ...item }))),
      assets: Object.freeze(approvedEvidence.assets.map((item) => Object.freeze({ ...item }))),
    }), approvedEvidenceStatus: 'approved_at_preflight' as const } : {}),
  });
  return Object.freeze({
    evidence,
    sha256: sha256(canonicalCompanyContentJson(evidence)),
  });
}

function canonicalDraft(
  draft: PropertyPredatorGeneratedDraft,
  plan: PropertyPredatorMarketingDraftPlan & {
    readonly brandBrain: NonNullable<PropertyPredatorMarketingDraftPlan['brandBrain']>;
    readonly pack: NonNullable<PropertyPredatorMarketingDraftPlan['pack']>;
  },
  generationContextSha256: string,
): string {
  if (draft.status !== 'source_review_required' || draft.payload.kind !== 'post'
      || draft.brandSha256 !== plan.brandBrain.runtimeBrandSha256
      || draft.contextSha256 !== generationContextSha256
      || draft.payload.contextSha256 !== generationContextSha256
      || !UUID.test(draft.draftId) || !UUID.test(draft.versionId)
      || !Number.isSafeInteger(draft.itemVersion) || draft.itemVersion !== 1
      || !SHA256.test(draft.contentSha256) || !SHA256.test(draft.usageSha256)) {
    fail('integrity_mismatch');
  }
  let content: string;
  try {
    content = canonicalCompanyContentJson(draft.payload);
  } catch {
    fail('integrity_mismatch');
  }
  if (sha256(content) !== draft.contentSha256) fail('integrity_mismatch');
  return content;
}

function buildVersionCommand(input: Readonly<{
  persistenceCommandKey: string;
  plan: PropertyPredatorMarketingDraftPlan & {
    readonly brandBrain: NonNullable<PropertyPredatorMarketingDraftPlan['brandBrain']>;
    readonly pack: NonNullable<PropertyPredatorMarketingDraftPlan['pack']>;
  };
  draft: PropertyPredatorGeneratedDraft;
  content: string;
  revision: Readonly<PropertyPredatorGeneratedDraftRevisionTarget> | null;
  checkedAt: Date;
  generationContext: Readonly<{
    evidence: PropertyPredatorMarketingGenerationContext;
    sha256: string;
  }>;
  approvedEvidenceRecheck?: Readonly<{ checkedAt: string }>;
  approvedEvidenceCheckedAt?: string;
}>): Readonly<{ command: CreateCompanyContentVersionCommand; sourceItemId: string }> {
  const sourceItemId = input.revision?.sourceItemId ?? input.draft.draftId.toLowerCase();
  const checkedAt = input.checkedAt.toISOString();
  const expiresAt = new Date(input.checkedAt.getTime() + ATTESTATION_FRESHNESS_MS).toISOString();
  const sourceEvidence = Object.freeze({
    schema: 'propertypredator.generated-draft-source/v1',
    sourceItemId,
    sourceDraftId: input.draft.draftId,
    sourceVersionId: input.draft.versionId,
    sourceItemVersion: input.draft.itemVersion,
    contentSha256: input.draft.contentSha256,
    brandSha256: input.draft.brandSha256,
    usageSha256: input.draft.usageSha256,
    planSha256: input.plan.planSha256,
    generationContextSha256: input.generationContext.sha256,
  });
  const metadata = Object.freeze({
    schema: 'propertypredator.generated-marketing-version/v1',
    draftStatus: 'review_required',
    approvalStatus: 'unrequested',
    providerEffects: false,
    source: sourceEvidence,
    marketing: Object.freeze({
      scope: input.plan.scope,
      deliverableKind: input.plan.deliverableKind,
      planSha256: input.plan.planSha256,
      generationContextSha256: input.generationContext.sha256,
      generationContext: input.generationContext.evidence,
      ...(input.approvedEvidenceCheckedAt ? {
        approvedEvidenceCheckedAt: input.approvedEvidenceCheckedAt,
      } : {}),
      ...(input.approvedEvidenceRecheck ? {
        approvedEvidenceRecheck: Object.freeze({
          status: 'approved_at_post_generation_check',
          checkedAt: input.approvedEvidenceRecheck.checkedAt,
        }),
      } : {}),
      packId: input.plan.pack.packId,
      packSha256: input.plan.pack.packageSha256,
      brandBrainReleaseId: input.plan.brandBrain.sourceReleaseId,
      brandBrainManifestSha256: input.plan.brandBrain.manifestSha256,
      journeySlug: input.plan.selection.journeySlug,
      journeyVersion: input.plan.selection.journeyVersion,
      journeyDefinitionSha256: input.plan.selection.journeyDefinitionSha256,
      targetMilestoneKey: input.plan.selection.targetMilestoneKey,
      methods: input.plan.methods.map((method) => Object.freeze({
        methodId: method.methodId,
        contentSha256: method.contentSha256,
      })),
      specialists: input.plan.handoffs.map((handoff) => handoff.specialistId),
    }),
    revision: input.revision ? Object.freeze({
      previousVersionId: input.revision.previousVersionId,
      previousVersionNumber: input.revision.previousVersionNumber,
      previousContentSha256: input.revision.previousContentSha256,
    }) : null,
  });
  return Object.freeze({
    sourceItemId,
    command: Object.freeze({
      commandKey: commandKey(input.persistenceCommandKey),
      ...(input.revision ? {
        contentItemId: input.revision.contentItemId,
        previousVersionId: input.revision.previousVersionId,
      } : {}),
      origin: 'generated',
      kind: 'social_post',
      title: input.draft.payload.title,
      contentMimeType: CONTENT_MIME_TYPE,
      content: input.content,
      source: Object.freeze({
        system: SOURCE_SYSTEM,
        itemId: sourceItemId,
        version: `${input.draft.versionId}:v${input.draft.itemVersion}`,
      }),
      blob: Object.freeze({
        storageKey: `inline/property-predator/generated/${input.draft.versionId}.json`,
        sha256: input.draft.contentSha256,
      }),
      brand: Object.freeze({
        snapshotRef: `brand-brain:${input.plan.brandBrain.sourceReleaseId}:${input.plan.brandBrain.manifestSha256}`,
        sha256: input.plan.brandBrain.runtimeBrandSha256,
      }),
      attestation: Object.freeze({
        catalogSha256: sha256(canonicalCompanyContentJson(sourceEvidence)),
        checkedAt,
        expiresAt,
      }),
      metadata,
    }),
  });
}

/**
 * Joins the already fenced generation bridge to the existing append-only
 * company-content lifecycle. This class adds no provider, publish, send or
 * scheduling capability; every successful result is still an unrequested
 * human-review draft.
 */
export class PropertyPredatorGeneratedDraftLifecycle {
  readonly #now: () => Date;

  constructor(private readonly dependencies: PropertyPredatorGeneratedDraftLifecycleDependencies) {
    if (!dependencies || typeof dependencies !== 'object'
        || typeof dependencies.generation?.generateDraft !== 'function'
        || typeof dependencies.content?.createVersion !== 'function'
        || typeof dependencies.content?.listVersionApprovalStates !== 'function'
        || typeof dependencies.content?.requestApproval !== 'function'
        || typeof dependencies.content?.decideApproval !== 'function'
        || (dependencies.now !== undefined && typeof dependencies.now !== 'function')) {
      fail('invalid_input');
    }
    this.#now = dependencies.now ?? (() => new Date());
  }

  async generateAndStage(
    context: DatabaseRequestContext,
    input: StagePropertyPredatorGeneratedDraftInput,
  ): Promise<StagedPropertyPredatorGeneratedDraft> {
    if (!input || typeof input !== 'object'
        || !input.generation || typeof input.generation !== 'object'
        || Array.isArray(input.generation)) {
      fail('invalid_input');
    }
    const persistenceCommandKey = commandKey(input.persistenceCommandKey);
    const revision = revisionTarget(input.revision);
    const plan = planPropertyPredatorMarketingDraft(input.draftPlan);
    assertReadyPlan(plan, input.generation);
    const generationContext = marketingGenerationContext(
      plan,
      input.approvedEvidence,
    );

    if (revision) {
      const states = await this.dependencies.content.listVersionApprovalStates(
        context,
        revision.contentItemId,
      );
      exactCurrentVersion(states, {
        contentItemId: revision.contentItemId,
        contentVersionId: revision.previousVersionId,
        versionNumber: revision.previousVersionNumber,
        contentSha256: revision.previousContentSha256,
      });
    }

    const draft = await this.dependencies.generation.generateDraft(Object.freeze({
      ...input.generation,
      contextSha256: generationContext.sha256,
    }));
    let approvedEvidenceRecheck: Readonly<{ checkedAt: string }> | undefined;
    if (input.approvedEvidence
        && (input.approvedEvidence.facts.length > 0 || input.approvedEvidence.assets.length > 0)
        && this.dependencies.revalidateEvidence) {
      const recheck = await this.dependencies.revalidateEvidence(context, input.approvedEvidence);
      if (!recheck.valid) fail('approval_conflict');
      approvedEvidenceRecheck = Object.freeze({ checkedAt: instant(new Date(recheck.checkedAt)).toISOString() });
    }
    const content = canonicalDraft(draft, plan, generationContext.sha256);
    const built = buildVersionCommand({
      persistenceCommandKey,
      plan,
      draft,
      content,
      revision,
      checkedAt: instant(this.#now()),
      generationContext,
      approvedEvidenceRecheck,
      approvedEvidenceCheckedAt: input.approvedEvidenceCheckedAt,
    });
    const created = await this.dependencies.content.createVersion(context, built.command);
    const expectedVersionNumber = revision ? revision.previousVersionNumber + 1 : 1;
    if (created.contentSha256 !== draft.contentSha256
        || created.versionNumber !== expectedVersionNumber
        || !UUID.test(created.contentItemId) || !UUID.test(created.contentVersionId)) {
      fail('integrity_mismatch');
    }
    const target = Object.freeze({
      contentItemId: created.contentItemId.toLowerCase(),
      contentVersionId: created.contentVersionId.toLowerCase(),
      versionNumber: created.versionNumber,
      contentSha256: created.contentSha256,
    });
    return Object.freeze({
      status: 'draft',
      approvalStatus: 'unrequested',
      reviewRequired: true,
      publishable: false,
      providerEffects: false,
      disposition: created.disposition,
      sourceItemId: built.sourceItemId,
      sourceDraftId: draft.draftId,
      sourceVersionId: draft.versionId,
      sourceItemVersion: draft.itemVersion,
      planSha256: plan.planSha256,
      brandSha256: draft.brandSha256,
      usageSha256: draft.usageSha256,
      generationContextSha256: generationContext.sha256,
      draft,
      reviewTarget: target,
    });
  }

  async requestApproval(
    context: DatabaseRequestContext,
    input: RequestPropertyPredatorGeneratedDraftApprovalInput,
  ): Promise<PropertyPredatorGeneratedDraftApprovalRequest> {
    if (!input || typeof input !== 'object') fail('invalid_input');
    const target = reviewTarget(input.reviewTarget);
    exactCurrentVersion(
      await this.dependencies.content.listVersionApprovalStates(context, target.contentItemId),
      target,
    );
    const requested = await this.dependencies.content.requestApproval(context, {
      commandKey: commandKey(input.commandKey),
      contentItemId: target.contentItemId,
      contentVersionId: target.contentVersionId,
      reviewNote: input.reviewNote,
    });
    if (requested.contentItemId.toLowerCase() !== target.contentItemId
        || requested.contentVersionId.toLowerCase() !== target.contentVersionId
        || requested.contentSha256 !== target.contentSha256) {
      fail('approval_conflict');
    }
    return Object.freeze({
      status: 'pending_review',
      reviewRequired: true,
      publishable: false,
      providerEffects: false,
      disposition: requested.disposition,
      approvalRequestId: requested.approvalRequestId,
      requestNumber: requested.requestNumber,
      reviewTarget: target,
    });
  }

  async recordRestriction(
    context: DatabaseRequestContext,
    input: DecidePropertyPredatorGeneratedDraftRestrictionInput,
  ): Promise<PropertyPredatorGeneratedDraftRestrictiveDecision> {
    if (!input || typeof input !== 'object'
        || (input.decision !== 'rejected' && input.decision !== 'changes_requested')) {
      fail('invalid_input');
    }
    const target = reviewTarget(input.reviewTarget);
    const decided = await this.dependencies.content.decideApproval(context, {
      commandKey: commandKey(input.commandKey),
      approvalRequestId: uuid(input.approvalRequestId),
      decision: input.decision,
      decisionNote: input.decisionNote,
    });
    if (decided.approvalRequestId.toLowerCase() !== input.approvalRequestId.toLowerCase()
        || decided.contentItemId.toLowerCase() !== target.contentItemId
        || decided.contentVersionId.toLowerCase() !== target.contentVersionId
        || decided.contentSha256 !== target.contentSha256
        || decided.decision !== input.decision) {
      fail('approval_conflict');
    }
    return Object.freeze({
      status: input.decision,
      publishable: false,
      providerEffects: false,
      disposition: decided.disposition,
      approvalDecisionId: decided.approvalDecisionId,
      approvalRequestId: decided.approvalRequestId,
      reviewTarget: target,
    });
  }

  async refreshApprovedSource(
    context: DatabaseRequestContext,
    input: RefreshApprovedPropertyPredatorGeneratedSourceInput,
  ): Promise<RefreshedApprovedPropertyPredatorGeneratedSource> {
    if (!input || typeof input !== 'object'
        || !this.dependencies.generatedSource
        || !this.dependencies.content.refreshSourceAttestation) fail('invalid_input');
    const target = reviewTarget(input.reviewTarget);
    const states = await this.dependencies.content.listVersionApprovalStates(context, target.contentItemId);
    const state = exactCurrentVersion(states, target);
    if (state.approvalStatus !== 'approved' || state.approvalStale
        || !state.approvalRequestId || !state.approvalDecisionId
        || state.source.system !== SOURCE_SYSTEM) fail('approval_conflict');
    const proof = await this.dependencies.generatedSource.verify(
      generatedSourceRenewalTarget(states, state),
    );
    const checkedAt = instant(this.#now());
    const refreshed = await this.dependencies.content.refreshSourceAttestation(context, {
      commandKey: commandKey(input.commandKey),
      contentItemId: target.contentItemId,
      contentVersionId: target.contentVersionId,
      expected: Object.freeze({
        source: state.source,
        contentSha256: state.contentSha256,
        blobSha256: state.blobSha256,
        brandSha256: state.brandSha256,
      }),
      attestation: Object.freeze({
        catalogSha256: digest(proof.catalogSha256),
        checkedAt: checkedAt.toISOString(),
        expiresAt: new Date(checkedAt.getTime() + ATTESTATION_FRESHNESS_MS).toISOString(),
      }),
    });
    if (refreshed.contentItemId !== target.contentItemId
        || refreshed.contentVersionId !== target.contentVersionId
        || refreshed.providerEffects !== false) fail('integrity_mismatch');
    return Object.freeze({ ...refreshed, providerEffects: false });
  }
}
