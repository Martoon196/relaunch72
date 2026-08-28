import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  PROPERTY_PREDATOR_CAMPAIGN_DRAFT_CONTEXT_SCHEMA,
  PROPERTY_PREDATOR_CAMPAIGN_DRAFT_RESULT_SCHEMA,
  PropertyPredatorCampaignDraftRuntime,
  PropertyPredatorCampaignDraftRuntimeError,
  type PropertyPredatorCampaignDraftApprovedVersionEvidence,
  type PropertyPredatorCampaignDraftCommand,
} from '../src/company-content-adapter/property-predator-campaign-draft-runtime.js';
import type {
  PropertyPredatorGenerateDraftCommand,
  PropertyPredatorGeneratedDraft,
} from '../src/company-content-adapter/property-predator-generation.js';
import {
  planPropertyPredatorMarketingDraft,
  type PlanPropertyPredatorMarketingDraftInput,
} from '../src/company-content-adapter/property-predator-marketing-draft-plan.js';
import { canonicalCompanyContentJson } from '../src/company-content-pg/validation.js';
import { createPropertyPredatorBrandBrainFixture } from '../src/portal/brand-brain-fixtures.js';
import type { PortalBrandBrainSnapshot } from '../src/portal/brand-brain-service.js';

function sha256(value: string): string {
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

const BRAIN = readyBrandBrain();
const PLAN_INPUT: PlanPropertyPredatorMarketingDraftInput = Object.freeze({
  selection: 'property-predator-self-serve:activated',
  brandBrainSnapshot: BRAIN,
});
const PLAN = planPropertyPredatorMarketingDraft(PLAN_INPUT);
if (!PLAN.brandBrain) throw new Error('ready Brand Brain fixture is blocked');
const BRAND_SHA = PLAN.brandBrain.runtimeBrandSha256;

function approvedVersion(
  kind: 'fact' | 'asset',
  suffix: number,
  contentSeed = `${kind}-${suffix}`,
): PropertyPredatorCampaignDraftApprovedVersionEvidence {
  const hex = suffix.toString(16).padStart(12, '0');
  return Object.freeze({
    contentItemId: `${kind === 'fact' ? 'f1000000' : 'a1000000'}-0000-4000-8000-${hex}`,
    contentVersionId: `${kind === 'fact' ? 'f2000000' : 'a2000000'}-0000-4000-8000-${hex}`,
    versionNumber: suffix,
    contentSha256: sha256(`content:${contentSeed}`),
    blobSha256: sha256(`blob:${contentSeed}`),
    brandSha256: BRAND_SHA,
    approvalRequestId: `${kind === 'fact' ? 'f3000000' : 'a3000000'}-0000-4000-8000-${hex}`,
    approvalDecisionId: `${kind === 'fact' ? 'f4000000' : 'a4000000'}-0000-4000-8000-${hex}`,
    approvalStatus: 'approved',
    approvalStale: false,
    sourceFresh: true,
    publishable: true,
    sourceSystem: 'propertypredator.company-content',
    sourceItemId: `${kind}-source-${suffix}`,
    sourceVersion: `v${suffix}`,
    kind: kind === 'fact' ? 'document' : 'image',
  });
}

function command(overrides: Partial<PropertyPredatorCampaignDraftCommand> = {}): PropertyPredatorCampaignDraftCommand {
  return {
    idempotencyKey: 'campaign-draft-test-00000001',
    expectedPlanSha256: PLAN.planSha256,
    maximumCostMinor: 250,
    providerEffects: 'generation_only',
    brief: Object.freeze({
      platform: 'linkedin',
      topic: 'Why property opportunities deserve an evidence-first decision',
      tone: 'direct and useful',
    }),
    draftPlan: PLAN_INPUT,
    brandBrain: Object.freeze({
      sourceSystem: 'property-predator',
      sourceReleaseId: PLAN.brandBrain!.sourceReleaseId,
      manifestSha256: PLAN.brandBrain!.manifestSha256,
      runtimeBrandSha256: PLAN.brandBrain!.runtimeBrandSha256,
      specialistProfileId: 'propertypredator.owned.social/v1',
    }),
    approvedFacts: Object.freeze([approvedVersion('fact', 1)]),
    approvedAssets: Object.freeze([approvedVersion('asset', 1)]),
    ...overrides,
  };
}

function draft(generation: PropertyPredatorGenerateDraftCommand): PropertyPredatorGeneratedDraft {
  const payload = Object.freeze({
    body: 'Exciting property headlines are easy. Evidence-led decisions are what protect your time.',
    contextSha256: generation.contextSha256,
    cta_url: 'https://propertypredator.com/learn',
    kind: 'post' as const,
    platform: generation.brief.platform,
    schema: 'propertypredator.company-content/v1' as const,
    title: 'Start with the evidence',
    type: 'generated' as const,
  });
  const usage = Object.freeze({
    accountingState: 'provider_tokens_unpriced' as const,
    inputTokens: 850,
    outputTokens: 190,
    model: 'test-company-content-model',
    providerRequestId: 'provider-request-test-00000001',
  });
  return {
    ok: true,
    schemaVersion: 1,
    brandSha256: generation.expectedBrandSha256,
    contentSha256: sha256(canonicalCompanyContentJson(payload)),
    contextSha256: generation.contextSha256,
    draftId: 'd1000000-0000-4000-8000-000000000001',
    itemVersion: 1,
    payload,
    status: 'source_review_required',
    usage,
    usageSha256: sha256(canonicalCompanyContentJson(usage)),
    versionId: 'd2000000-0000-4000-8000-000000000001',
  };
}

function runtime(
  calls: PropertyPredatorGenerateDraftCommand[],
  switches: Readonly<{ enabled?: boolean; paused?: boolean; hardCost?: number }> = {},
) {
  return new PropertyPredatorCampaignDraftRuntime({
    generation: {
      generateDraft: async (generation) => {
        calls.push(generation);
        return draft(generation);
      },
    },
    providerEffectsEnabled: switches.enabled ?? true,
    emergencyPaused: switches.paused ?? false,
    hardMaximumCostMinor: switches.hardCost ?? 500,
  });
}

test('generates exactly one evidence-bound, immutable and review-only campaign draft', async () => {
  const calls: PropertyPredatorGenerateDraftCommand[] = [];
  const service = runtime(calls);
  const result = await service.generateReviewDraft(command());

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.maximumCostMinor, 250);
  assert.equal(calls[0]!.brief.kind, 'post');
  assert.equal(calls[0]!.contextSha256, result.evidenceSha256);
  assert.equal(result.schema, PROPERTY_PREDATOR_CAMPAIGN_DRAFT_RESULT_SCHEMA);
  assert.equal(result.evidence.schema, PROPERTY_PREDATOR_CAMPAIGN_DRAFT_CONTEXT_SCHEMA);
  assert.equal(result.status, 'source_review_required');
  assert.equal(result.approvalStatus, 'unrequested');
  assert.equal(result.reviewRequired, true);
  assert.equal(result.publishable, false);
  assert.equal(result.sendable, false);
  assert.equal(result.schedulable, false);
  assert.equal(result.outboundEffects, false);
  assert.equal(result.providerEffects, 'generation_only');
  assert.equal(result.evidence.generationLimit.requestCount, 1);
  assert.equal(result.evidence.generationLimit.quotaAuthority, 'generation_bridge_atomic_policy');
  assert.equal(result.immutableSource.versionId, result.draft.versionId);
  const { resultSha256, ...withoutResultSha256 } = result;
  assert.equal(resultSha256, sha256(canonicalCompanyContentJson(withoutResultSha256)));
});

test('result and nested review evidence are frozen and the runtime has no outbound operation', async () => {
  const result = await runtime([]).generateReviewDraft(command());
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.evidence), true);
  assert.equal(Object.isFrozen(result.evidence.approvedFacts), true);
  assert.equal(Object.isFrozen(result.evidence.approvedFacts[0]), true);
  assert.equal(Object.isFrozen(result.draft), true);
  assert.equal(Object.isFrozen(result.draft.payload), true);
  assert.deepEqual(
    Object.getOwnPropertyNames(PropertyPredatorCampaignDraftRuntime.prototype),
    ['constructor', 'generateReviewDraft'],
  );
});

test('exact fact and asset version hashes are part of the provider context digest', async () => {
  const calls: PropertyPredatorGenerateDraftCommand[] = [];
  const service = runtime(calls);
  await service.generateReviewDraft(command({ idempotencyKey: 'campaign-draft-test-00000002' }));
  await service.generateReviewDraft(command({
    idempotencyKey: 'campaign-draft-test-00000003',
    approvedFacts: Object.freeze([approvedVersion('fact', 1, 'corrected-fact')]),
  }));
  await service.generateReviewDraft(command({
    idempotencyKey: 'campaign-draft-test-00000004',
    approvedAssets: Object.freeze([approvedVersion('asset', 1, 'revised-artwork')]),
  }));
  assert.notEqual(calls[0]!.contextSha256, calls[1]!.contextSha256);
  assert.notEqual(calls[0]!.contextSha256, calls[2]!.contextSha256);
});

test('unapproved, stale, wrong-brand or duplicate evidence fails before a provider call', async () => {
  const cases = [
    command({
      approvedFacts: [{ ...approvedVersion('fact', 1), approvalStatus: 'pending' as 'approved' }],
    }),
    command({
      approvedFacts: [{ ...approvedVersion('fact', 1), sourceFresh: false as true }],
    }),
    command({
      approvedAssets: [{ ...approvedVersion('asset', 1), brandSha256: sha256('wrong-brand') }],
    }),
    command({
      approvedAssets: [approvedVersion('asset', 1), approvedVersion('asset', 1)],
    }),
  ];
  for (const candidate of cases) {
    const calls: PropertyPredatorGenerateDraftCommand[] = [];
    await assert.rejects(runtime(calls).generateReviewDraft(candidate), (error: unknown) =>
      error instanceof PropertyPredatorCampaignDraftRuntimeError
        && error.code === 'evidence_invalid');
    assert.equal(calls.length, 0);
  }
});

test('stale plan, effects-off, emergency pause and hard spend ceiling all fail closed', async () => {
  const staleCalls: PropertyPredatorGenerateDraftCommand[] = [];
  await assert.rejects(runtime(staleCalls).generateReviewDraft(command({
    expectedPlanSha256: sha256('stale-plan'),
  })), (error: unknown) => error instanceof PropertyPredatorCampaignDraftRuntimeError
    && error.code === 'stale_plan');
  assert.equal(staleCalls.length, 0);

  await assert.rejects(runtime([], { enabled: false }).generateReviewDraft(command()),
    (error: unknown) => error instanceof PropertyPredatorCampaignDraftRuntimeError
      && error.code === 'effects_disabled');
  await assert.rejects(runtime([], { paused: true }).generateReviewDraft(command()),
    (error: unknown) => error instanceof PropertyPredatorCampaignDraftRuntimeError
      && error.code === 'emergency_paused');
  await assert.rejects(runtime([], { hardCost: 100 }).generateReviewDraft(command()),
    (error: unknown) => error instanceof PropertyPredatorCampaignDraftRuntimeError
      && error.code === 'cost_limit_exceeded');
});

test('a forged source response cannot cross the review boundary', async () => {
  const service = new PropertyPredatorCampaignDraftRuntime({
    generation: {
      generateDraft: async (generation) => ({
        ...draft(generation),
        contentSha256: sha256('forged-content'),
      }),
    },
    providerEffectsEnabled: true,
    emergencyPaused: false,
    hardMaximumCostMinor: 500,
  });
  await assert.rejects(service.generateReviewDraft(command()),
    (error: unknown) => error instanceof PropertyPredatorCampaignDraftRuntimeError
      && error.code === 'integrity_mismatch');
});
