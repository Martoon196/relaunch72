import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  PropertyPredatorGeneratedDraftLifecycle,
  PropertyPredatorGeneratedDraftLifecycleError,
  type PropertyPredatorGeneratedDraftContentService,
} from '../src/company-content-adapter/property-predator-generation-approval.js';
import type {
  PropertyPredatorGenerateDraftCommand,
  PropertyPredatorGeneratedDraft,
  PropertyPredatorGeneratedPayload,
} from '../src/company-content-adapter/property-predator-generation.js';
import { canonicalCompanyContentJson } from '../src/company-content-pg/validation.js';
import type {
  CompanyContentApprovalDecision,
  CompanyContentVersionApprovalState,
  CreateCompanyContentVersionCommand,
} from '../src/company-content-pg/types.js';
import type { DatabaseRequestContext } from '../src/db/rls.js';
import { createPropertyPredatorBrandBrainFixture } from '../src/portal/brand-brain-fixtures.js';
import type { PortalBrandBrainSnapshot } from '../src/portal/brand-brain-service.js';

const CONTEXT: DatabaseRequestContext = Object.freeze({
  actorKind: 'user',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  requestId: 'generated-draft-lifecycle-test',
});
const NOW = new Date('2026-08-28T12:00:00.000Z');
const CONTENT_ITEM_ID = 'a1000000-0000-4000-8000-000000000001';
const VERSION_IDS = [
  'a2000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000002',
] as const;
const APPROVAL_REQUEST_IDS = [
  'a3000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000002',
] as const;
const APPROVAL_DECISION_IDS = [
  'a4000000-0000-4000-8000-000000000001',
  'a4000000-0000-4000-8000-000000000002',
] as const;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function mutable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readyBrandBrain(): PortalBrandBrainSnapshot {
  const fixture = mutable(createPropertyPredatorBrandBrainFixture());
  return {
    ...fixture,
    brain: {
      ...fixture.brain,
      evaluationPassed: true,
      activated: true,
      visualPolicyConflict: false,
      reviews: [
        ...fixture.brain.reviews,
        {
          dimension: 'brand_readiness',
          decision: 'approved',
          decisionId: 'b3000000-0000-4000-8000-000000000003',
        },
      ],
      specialists: fixture.brain.specialists.map((profile) => (
        profile.profileId === 'propertypredator.owned.social/v1'
          ? {
              ...profile,
              capabilities: ['post', 'thread'],
              runtimeReady: true,
              blockedReason: null,
            }
          : profile
      )),
    },
  };
}

function generatedPayload(title: string, contextSha256: string): PropertyPredatorGeneratedPayload {
  return Object.freeze({
    body: `${title}. Inspect the evidence and make a deliberate decision.`,
    contextSha256,
    cta_url: 'https://propertypredator.com/learn',
    kind: 'post',
    platform: 'linkedin',
    schema: 'propertypredator.company-content/v1',
    title,
    type: 'generated',
  });
}

function generatedDraft(
  index: 1 | 2,
  brandSha256: string,
  contextSha256: string,
): PropertyPredatorGeneratedDraft {
  const payload = generatedPayload(
    index === 1 ? 'Evaluate the deal' : 'Evaluate the evidence',
    contextSha256,
  );
  const usage = Object.freeze({
    accountingState: 'provider_tokens_unpriced' as const,
    inputTokens: 1_250,
    outputTokens: 480,
    model: 'test-model',
    providerRequestId: `test-provider-request-000${index}`,
  });
  return Object.freeze({
    ok: true,
    schemaVersion: 1,
    brandSha256,
    contentSha256: digest(canonicalCompanyContentJson(payload)),
    contextSha256,
    draftId: index === 1
      ? 'd1000000-0000-4000-8000-000000000001'
      : 'd1000000-0000-4000-8000-000000000002',
    itemVersion: 1,
    payload,
    status: 'source_review_required',
    usage,
    usageSha256: digest(canonicalCompanyContentJson(usage)),
    versionId: index === 1
      ? 'd2000000-0000-4000-8000-000000000001'
      : 'd2000000-0000-4000-8000-000000000002',
  });
}

interface StoredVersion {
  readonly command: CreateCompanyContentVersionCommand;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly versionNumber: number;
  readonly contentSha256: string;
  approvalRequestId: string | null;
  approvalDecisionId: string | null;
  approvalStatus: 'unrequested' | 'pending' | CompanyContentApprovalDecision;
}

class FakeContentLifecycle implements PropertyPredatorGeneratedDraftContentService {
  readonly versions: StoredVersion[] = [];
  readonly requests = new Map<string, StoredVersion>();

  async createVersion(_context: DatabaseRequestContext, command: CreateCompanyContentVersionCommand) {
    const versionNumber = this.versions.length + 1;
    const latest = this.versions.at(-1);
    if (versionNumber > 1 && (!latest
      || command.contentItemId !== latest.contentItemId
      || command.previousVersionId !== latest.contentVersionId
      || command.source.itemId !== latest.command.source.itemId)) {
      throw new Error('fake revision conflict');
    }
    const stored: StoredVersion = {
      command,
      contentItemId: CONTENT_ITEM_ID,
      contentVersionId: VERSION_IDS[versionNumber - 1]!,
      versionNumber,
      contentSha256: digest(command.content),
      approvalRequestId: null,
      approvalDecisionId: null,
      approvalStatus: 'unrequested',
    };
    this.versions.push(stored);
    return {
      disposition: 'applied' as const,
      contentItemId: stored.contentItemId,
      contentVersionId: stored.contentVersionId,
      versionNumber,
      contentSha256: stored.contentSha256,
      sourceAttestationId: `a5000000-0000-4000-8000-00000000000${versionNumber}`,
      sourceAttestationExpiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    };
  }

  async listVersionApprovalStates(
    _context: DatabaseRequestContext,
    contentItemId: string,
  ): Promise<CompanyContentVersionApprovalState[]> {
    return [...this.versions].reverse().filter((version) => version.contentItemId === contentItemId)
      .map((version, index) => ({
        contentItemId: version.contentItemId,
        contentVersionId: version.contentVersionId,
        versionNumber: version.versionNumber,
        title: version.command.title,
        origin: version.command.origin,
        source: version.command.source,
        contentSha256: version.contentSha256,
        blobSha256: version.command.blob.sha256,
        brandSha256: version.command.brand.sha256,
        approvalRequestId: version.approvalRequestId,
        approvalDecisionId: version.approvalDecisionId,
        approvalStatus: version.approvalStatus,
        approvalStale: index > 0,
      }));
  }

  async requestApproval(
    _context: DatabaseRequestContext,
    command: Readonly<{
      commandKey: string;
      contentItemId: string;
      contentVersionId: string;
      reviewNote?: string | null;
    }>,
  ) {
    const version = this.versions.find((candidate) => (
      candidate.contentItemId === command.contentItemId
      && candidate.contentVersionId === command.contentVersionId
    ));
    if (!version) throw new Error('fake content version missing');
    const requestId = APPROVAL_REQUEST_IDS[this.requests.size]!;
    version.approvalRequestId = requestId;
    version.approvalStatus = 'pending';
    this.requests.set(requestId, version);
    return {
      disposition: 'applied' as const,
      approvalRequestId: requestId,
      contentItemId: version.contentItemId,
      contentVersionId: version.contentVersionId,
      requestNumber: this.requests.size,
      contentSha256: version.contentSha256,
    };
  }

  async decideApproval(
    _context: DatabaseRequestContext,
    command: Readonly<{
      commandKey: string;
      approvalRequestId: string;
      decision: CompanyContentApprovalDecision;
      decisionNote?: string | null;
    }>,
  ) {
    const version = this.requests.get(command.approvalRequestId);
    if (!version) throw new Error('fake approval request missing');
    const decisionId = APPROVAL_DECISION_IDS.filter((id) => (
      !this.versions.some((candidate) => candidate.approvalDecisionId === id)
    ))[0]!;
    version.approvalDecisionId = decisionId;
    version.approvalStatus = command.decision;
    return {
      disposition: 'applied' as const,
      approvalDecisionId: decisionId,
      approvalRequestId: command.approvalRequestId,
      contentItemId: version.contentItemId,
      contentVersionId: version.contentVersionId,
      decision: command.decision,
      contentSha256: version.contentSha256,
    };
  }
}

function fixture(index: 1 | 2 = 1) {
  const brain = readyBrandBrain();
  const brandSha256 = brain.brain.runtimeBrandSha256;
  const drafts: Array<(contextSha256: string) => PropertyPredatorGeneratedDraft> = [
    (contextSha256) => generatedDraft(index, brandSha256, contextSha256),
  ];
  const generationCalls: PropertyPredatorGenerateDraftCommand[] = [];
  const content = new FakeContentLifecycle();
  const lifecycle = new PropertyPredatorGeneratedDraftLifecycle({
    generation: {
      async generateDraft(command) {
        generationCalls.push(command);
        return drafts.shift()!(command.contextSha256);
      },
    },
    content,
    now: () => NOW,
  });
  const generation: Omit<PropertyPredatorGenerateDraftCommand, 'contextSha256'> = Object.freeze({
    idempotencyKey: `growth-hq-stage-generation-000${index}`,
    expectedBrandSha256: brandSha256,
    maximumCostMinor: 25,
    brief: Object.freeze({
      kind: 'post',
      platform: 'linkedin',
      topic: 'A practical guide to evaluating an investment property',
      tone: 'direct',
    }),
  });
  return { brain, brandSha256, content, drafts, generation, generationCalls, lifecycle };
}

test('stages an exact generated social draft as immutable review-required version with no outbound effect', async () => {
  const setup = fixture();
  const staged = await setup.lifecycle.generateAndStage(CONTEXT, {
    persistenceCommandKey: 'persist-generated-social-draft-v1',
    generation: setup.generation,
    draftPlan: {
      selection: 'property-predator-agency-laps:presentation',
      brandBrainSnapshot: setup.brain,
    },
  });

  assert.equal(setup.generationCalls.length, 1);
  assert.deepEqual({
    status: staged.status,
    approval: staged.approvalStatus,
    reviewRequired: staged.reviewRequired,
    publishable: staged.publishable,
    providerEffects: staged.providerEffects,
    versionNumber: staged.reviewTarget.versionNumber,
  }, {
    status: 'draft',
    approval: 'unrequested',
    reviewRequired: true,
    publishable: false,
    providerEffects: false,
    versionNumber: 1,
  });
  assert.match(staged.planSha256, /^[0-9a-f]{64}$/);
  assert.match(staged.generationContextSha256, /^[0-9a-f]{64}$/);
  assert.equal(setup.generationCalls[0]?.contextSha256, staged.generationContextSha256);
  assert.equal(staged.brandSha256, setup.brandSha256);
  assert.equal(staged.sourceItemId, staged.sourceDraftId);

  const command = setup.content.versions[0]!.command;
  assert.equal(command.origin, 'generated');
  assert.equal(command.kind, 'social_post');
  assert.equal(command.contentMimeType, 'application/vnd.propertypredator.company-content+json');
  assert.equal(command.contentItemId, undefined);
  assert.equal(command.previousVersionId, undefined);
  assert.equal(command.source.system, 'property_predator_generation');
  assert.equal(command.source.itemId, staged.sourceItemId);
  assert.equal(command.brand.sha256, setup.brandSha256);
  assert.equal(digest(command.content), staged.reviewTarget.contentSha256);
  assert.equal(command.blob.sha256, staged.reviewTarget.contentSha256);
  assert.equal(command.attestation.checkedAt, NOW.toISOString());
  assert.equal(command.attestation.expiresAt, new Date(NOW.getTime() + 10 * 60_000).toISOString());
  const metadata = command.metadata as Record<string, any>;
  assert.equal(metadata.providerEffects, false);
  assert.equal(metadata.draftStatus, 'review_required');
  assert.equal(metadata.marketing.planSha256, staged.planSha256);
  assert.equal(metadata.marketing.journeySlug, 'property-predator-agency-laps');
  assert.equal(metadata.marketing.targetMilestoneKey, 'presentation');
  assert.equal(metadata.source.contentSha256, staged.reviewTarget.contentSha256);
  assert.equal(metadata.source.generationContextSha256, staged.generationContextSha256);
  assert.equal(metadata.marketing.generationContextSha256, staged.generationContextSha256);
  const generationContext = metadata.marketing.generationContext as Record<string, any>;
  assert.equal(digest(canonicalCompanyContentJson(generationContext)), staged.generationContextSha256);
  assert.equal(generationContext.planSha256, staged.planSha256);
  assert.equal(generationContext.selection.journeySlug, 'property-predator-agency-laps');
  assert.equal(generationContext.selection.targetMilestoneKey, 'presentation');
  assert.match(generationContext.selection.marketingJob, /presentation/i);
  assert.deepEqual(
    generationContext.methods.map((method: Record<string, unknown>) => Object.keys(method).sort()),
    generationContext.methods.map(() => ['contentSha256', 'methodId']),
  );
  assert.deepEqual(
    generationContext.specialists.map((specialist: Record<string, unknown>) => Object.keys(specialist).sort()),
    generationContext.specialists.map(() => ['sequence', 'specialistId', 'status']),
  );
  const changedMethod = {
    ...generationContext,
    methods: generationContext.methods.map((method: Record<string, unknown>, index: number) => (
      index === 0 ? { ...method, contentSha256: 'f'.repeat(64) } : method
    )),
  };
  const changedSpecialist = {
    ...generationContext,
    specialists: generationContext.specialists.map((specialist: Record<string, unknown>, index: number) => (
      index === 0 ? { ...specialist, specialistId: 'forged.specialist/v1' } : specialist
    )),
  };
  const changedJob = {
    ...generationContext,
    selection: { ...generationContext.selection, marketingJob: 'A different conversion job.' },
  };
  for (const tampered of [changedMethod, changedSpecialist, changedJob]) {
    assert.notEqual(digest(canonicalCompanyContentJson(tampered)), staged.generationContextSha256);
  }
  assert.doesNotMatch(JSON.stringify(metadata), /investment property|growth-hq-stage-generation/i);
});

test('joins request, rejection and exact revision while preserving the first decision as stale history', async () => {
  const setup = fixture();
  const first = await setup.lifecycle.generateAndStage(CONTEXT, {
    persistenceCommandKey: 'persist-generated-social-draft-v1',
    generation: setup.generation,
    draftPlan: { brandBrainSnapshot: setup.brain },
  });
  const requested = await setup.lifecycle.requestApproval(CONTEXT, {
    commandKey: 'request-generated-social-review-v1',
    reviewTarget: first.reviewTarget,
    reviewNote: 'Review this exact generated version.',
  });
  assert.deepEqual({
    status: requested.status,
    publishable: requested.publishable,
    effects: requested.providerEffects,
    target: requested.reviewTarget,
  }, {
    status: 'pending_review',
    publishable: false,
    effects: false,
    target: first.reviewTarget,
  });
  const rejected = await setup.lifecycle.recordRestriction(CONTEXT, {
    commandKey: 'reject-generated-social-v1',
    approvalRequestId: requested.approvalRequestId,
    reviewTarget: first.reviewTarget,
    decision: 'rejected',
    decisionNote: 'The call to action needs a clearer evidence-led next step.',
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.providerEffects, false);
  assert.equal(rejected.publishable, false);

  setup.drafts.push((contextSha256) => generatedDraft(2, setup.brandSha256, contextSha256));
  const second = await setup.lifecycle.generateAndStage(CONTEXT, {
    persistenceCommandKey: 'persist-generated-social-draft-v2',
    generation: {
      ...setup.generation,
      idempotencyKey: 'growth-hq-stage-generation-0002',
    },
    draftPlan: {
      selection: 'property-predator-self-serve:priced',
      brandBrainSnapshot: setup.brain,
    },
    revision: {
      sourceItemId: first.sourceItemId,
      contentItemId: first.reviewTarget.contentItemId,
      previousVersionId: first.reviewTarget.contentVersionId,
      previousVersionNumber: first.reviewTarget.versionNumber,
      previousContentSha256: first.reviewTarget.contentSha256,
    },
  });
  assert.equal(second.reviewTarget.versionNumber, 2);
  assert.equal(second.sourceItemId, first.sourceItemId);
  assert.notEqual(second.generationContextSha256, first.generationContextSha256);
  assert.notEqual(second.sourceDraftId, first.sourceDraftId);
  assert.notEqual(second.reviewTarget.contentSha256, first.reviewTarget.contentSha256);
  assert.equal(setup.content.versions[1]!.command.previousVersionId, first.reviewTarget.contentVersionId);
  assert.equal(setup.content.versions[1]!.command.contentItemId, first.reviewTarget.contentItemId);
  const history = await setup.content.listVersionApprovalStates(CONTEXT, CONTENT_ITEM_ID);
  assert.deepEqual(history.map((version) => ({
    version: version.versionNumber,
    approval: version.approvalStatus,
    stale: version.approvalStale,
  })), [
    { version: 2, approval: 'unrequested', stale: false },
    { version: 1, approval: 'rejected', stale: true },
  ]);
});

test('blocks an unready LAPS or Brand Brain recipe before generation or persistence', async () => {
  const setup = fixture();
  await assert.rejects(setup.lifecycle.generateAndStage(CONTEXT, {
    persistenceCommandKey: 'blocked-generated-social-draft',
    generation: setup.generation,
    draftPlan: { brandBrainSnapshot: createPropertyPredatorBrandBrainFixture() },
  }), (error: unknown) => (
    error instanceof PropertyPredatorGeneratedDraftLifecycleError
    && error.code === 'draft_plan_blocked'
  ));
  assert.equal(setup.generationCalls.length, 0);
  assert.equal(setup.content.versions.length, 0);
});

test('checks an exact latest revision tuple before generation and fails closed when stale', async () => {
  const setup = fixture();
  const first = await setup.lifecycle.generateAndStage(CONTEXT, {
    persistenceCommandKey: 'persist-generated-social-draft-v1',
    generation: setup.generation,
    draftPlan: { brandBrainSnapshot: setup.brain },
  });
  setup.drafts.push((contextSha256) => generatedDraft(2, setup.brandSha256, contextSha256));
  await assert.rejects(setup.lifecycle.generateAndStage(CONTEXT, {
    persistenceCommandKey: 'stale-generated-social-draft-v2',
    generation: { ...setup.generation, idempotencyKey: 'stale-generation-0000002' },
    draftPlan: { brandBrainSnapshot: setup.brain },
    revision: {
      sourceItemId: first.sourceItemId,
      contentItemId: first.reviewTarget.contentItemId,
      previousVersionId: first.reviewTarget.contentVersionId,
      previousVersionNumber: first.reviewTarget.versionNumber,
      previousContentSha256: 'f'.repeat(64),
    },
  }), (error: unknown) => (
    error instanceof PropertyPredatorGeneratedDraftLifecycleError
    && error.code === 'revision_conflict'
  ));
  assert.equal(setup.generationCalls.length, 1);
  assert.equal(setup.content.versions.length, 1);
});

test('rejects a generation hash/brand mismatch and cannot record approval through the restrictive decision boundary', async () => {
  const setup = fixture();
  setup.drafts.splice(0, 1, (contextSha256) => ({
    ...generatedDraft(1, setup.brandSha256, contextSha256),
    contentSha256: 'f'.repeat(64),
  } as PropertyPredatorGeneratedDraft));
  await assert.rejects(setup.lifecycle.generateAndStage(CONTEXT, {
    persistenceCommandKey: 'tampered-generated-social-draft',
    generation: setup.generation,
    draftPlan: { brandBrainSnapshot: setup.brain },
  }), (error: unknown) => (
    error instanceof PropertyPredatorGeneratedDraftLifecycleError
    && error.code === 'integrity_mismatch'
  ));
  assert.equal(setup.content.versions.length, 0);

  await assert.rejects(setup.lifecycle.recordRestriction(CONTEXT, {
    commandKey: 'forged-approval-decision',
    approvalRequestId: APPROVAL_REQUEST_IDS[0],
    reviewTarget: {
      contentItemId: CONTENT_ITEM_ID,
      contentVersionId: VERSION_IDS[0],
      versionNumber: 1,
      contentSha256: 'a'.repeat(64),
    },
    decision: 'approved',
    decisionNote: 'This boundary must never approve.',
  } as unknown as Parameters<PropertyPredatorGeneratedDraftLifecycle['recordRestriction']>[1]),
  (error: unknown) => (
    error instanceof PropertyPredatorGeneratedDraftLifecycleError
    && error.code === 'invalid_input'
  ));
});

test('rejects an echoed strategy-context mismatch before immutable persistence', async () => {
  const setup = fixture();
  setup.drafts.splice(0, 1, () => generatedDraft(
    1,
    setup.brandSha256,
    'f'.repeat(64),
  ));
  await assert.rejects(setup.lifecycle.generateAndStage(CONTEXT, {
    persistenceCommandKey: 'context-tampered-generated-social-draft',
    generation: setup.generation,
    draftPlan: {
      selection: 'property-predator-agency-laps:presentation',
      brandBrainSnapshot: setup.brain,
    },
  }), (error: unknown) => (
    error instanceof PropertyPredatorGeneratedDraftLifecycleError
    && error.code === 'integrity_mismatch'
  ));
  assert.equal(setup.generationCalls.length, 1);
  assert.notEqual(setup.generationCalls[0]?.contextSha256, 'f'.repeat(64));
  assert.equal(setup.content.versions.length, 0);
});
