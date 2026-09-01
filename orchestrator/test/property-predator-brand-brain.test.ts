import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  canonicalPropertyPredatorAiInventoryJson,
  parsePropertyPredatorAiInventory,
  PROPERTY_PREDATOR_AI_INVENTORY_V1_FILE_SHA256,
  PROPERTY_PREDATOR_AI_INVENTORY_V1_PACKAGE_SHA256,
  PROPERTY_PREDATOR_AI_RUNTIME_BRAND_V1_SHA256,
  PROPERTY_PREDATOR_EXTERNAL_GPT_PLACEHOLDERS,
  type PropertyPredatorAiInventory,
} from '../src/company-content-adapter/property-predator-ai-inventory.js';
import {
  BrandBrainConflictError,
  BrandBrainValidationError,
  planEffectsOffBrandBrainRuntime,
  type BrandBrainSnapshot,
} from '../src/brand-brain-pg/index.js';
import {
  normalizeBrandBrainEvaluation,
  normalizeBrandBrainReview,
  PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_RUNNER_V1,
  PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_SUITE_V1_SHA256,
} from '../src/brand-brain-pg/validation.js';

const fixtureUrl = new URL('./fixtures/property-predator-ai-inventory-v1.golden.json', import.meta.url);
const evalFixtureUrl = new URL('./fixtures/property-predator-brand-brain-eval-v1.golden.json', import.meta.url);
const UUID_A = '11111111-1111-4111-8111-111111111111';
const HASH_A = 'a'.repeat(64);

async function fixture(): Promise<{ raw: Buffer; inventory: PropertyPredatorAiInventory }> {
  const checkoutBytes = await readFile(fixtureUrl);
  // Git may materialize the repository's final LF as CRLF on Windows. Pin the
  // trusted inventory's repository-canonical bytes, not a checkout convention.
  const raw = Buffer.from(checkoutBytes.toString('utf8').replaceAll('\r\n', '\n'), 'utf8');
  return { raw, inventory: parsePropertyPredatorAiInventory(JSON.parse(raw.toString('utf8'))) };
}

function mutable(value: unknown): Record<string, any> {
  return JSON.parse(JSON.stringify(value)) as Record<string, any>;
}

function rehash(candidate: Record<string, any>): void {
  const { packageSha256: _ignored, ...manifest } = candidate;
  candidate.packageSha256 = createHash('sha256')
    .update(canonicalPropertyPredatorAiInventoryJson(manifest), 'utf8')
    .digest('hex');
}

function approvedSnapshot(inventory: PropertyPredatorAiInventory): BrandBrainSnapshot {
  return Object.freeze({
    sourceReleaseId: UUID_A,
    manifestSha256: inventory.packageSha256,
    runtimeBrandSha256: PROPERTY_PREDATOR_AI_RUNTIME_BRAND_V1_SHA256,
    sourceSystem: 'property-predator' as const,
    sources: Object.freeze(inventory.sources.map((source) => Object.freeze({
      sourceId: source.sourceId,
      assetRole: source.assetRole,
      authorityStatus: source.authorityStatus,
      contentSha256: source.contentSha256,
      ownershipStatus: source.ownershipStatus,
      licenceStatus: source.licenceStatus,
      privacyClass: source.privacyClass,
      consumerUse: source.consumerUse,
    }))),
    specialists: Object.freeze(inventory.specialistProfiles.map((profile) => Object.freeze({
      profileId: profile.profileId,
      name: profile.name,
      capabilities: profile.capabilities,
      runtimeBrandSha256: profile.runtimeBrandSha256,
      sourceStatus: profile.sourceStatus,
      hqActivationStatus: profile.hqActivationStatus,
      runtimeReady: profile.profileId !== 'propertypredator.owned.image/v1',
      blockedReason: profile.profileId === 'propertypredator.owned.image/v1'
        ? 'visual_policy_conflict' : null,
    }))),
    artworkCount: inventory.artworkReferences.length,
    quarantineCount: inventory.quarantines.length,
    visualPolicyConflict: true,
    sourceFresh: true,
    evaluationPassed: true,
    reviews: Object.freeze([
      Object.freeze({ dimension: 'ownership_licence' as const, decision: 'approved' as const,
        decisionId: '21111111-1111-4111-8111-111111111111' }),
      Object.freeze({ dimension: 'privacy_security' as const, decision: 'approved' as const,
        decisionId: '31111111-1111-4111-8111-111111111111' }),
      Object.freeze({ dimension: 'brand_readiness' as const, decision: 'approved' as const,
        decisionId: '41111111-1111-4111-8111-111111111111' }),
    ]),
    activated: true,
    providerEffects: false,
    recordedAt: '2026-08-27T10:00:00.000Z',
  });
}

test('frozen Property Predator AI inventory verifies exact bytes and canonical trusted package', async () => {
  const { raw, inventory } = await fixture();
  assert.equal(raw.byteLength, 14_354);
  assert.equal(createHash('sha256').update(raw).digest('hex'), PROPERTY_PREDATOR_AI_INVENTORY_V1_FILE_SHA256);
  assert.equal(inventory.packageSha256, PROPERTY_PREDATOR_AI_INVENTORY_V1_PACKAGE_SHA256);
  assert.equal(inventory.sources.length, 11);
  assert.equal(inventory.specialistProfiles.length, 6);
  assert.equal(inventory.artworkReferences.length, 10);
  assert.equal(inventory.quarantines.length, 1);
  assert.equal(inventory.quarantines[0]?.quarantineId,
    'legacy-black-panther-vs-current-no-animal/v1');
  assert.doesNotMatch(raw.toString('utf8'), /(?:prompt|body|secret|api[_-]?key)\s*:/iu);
});

test('inventory parser fails closed on unknown fields, semantic drift, and self-signed replacement packages', async () => {
  const { inventory } = await fixture();
  const unknown = mutable(inventory);
  unknown.rawPrompt = 'never accepted';
  assert.throws(() => parsePropertyPredatorAiInventory(unknown), /unknown or missing fields/);

  const selfSigned = mutable(inventory);
  selfSigned.sources[1].contentSha256 = HASH_A;
  rehash(selfSigned);
  assert.notEqual(selfSigned.packageSha256, PROPERTY_PREDATOR_AI_INVENTORY_V1_PACKAGE_SHA256);
  assert.throws(() => parsePropertyPredatorAiInventory(selfSigned), /trusted v1 release/);

  const heldOutPromoted = mutable(inventory);
  heldOutPromoted.specialistProfiles[0].knowledgeSourceIds = ['ai-brief-grounding'];
  rehash(heldOutPromoted);
  assert.throws(() => parsePropertyPredatorAiInventory(heldOutPromoted),
    /eval-only or quarantined material/);

  const usableQuarantine = mutable(inventory);
  usableQuarantine.quarantines[0].usable = true;
  rehash(usableQuarantine);
  assert.throws(() => parsePropertyPredatorAiInventory(usableQuarantine), /must be false/);
});

test('offline eval v1 separates held-out negatives from runtime sources and has a pinned canonical digest', async () => {
  const suite = JSON.parse(await readFile(evalFixtureUrl, 'utf8')) as Record<string, any>;
  const { suiteSha256, ...hashInput } = suite;
  assert.equal(suiteSha256, PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_SUITE_V1_SHA256);
  assert.equal(createHash('sha256')
    .update(canonicalPropertyPredatorAiInventoryJson(hashInput), 'utf8').digest('hex'), suiteSha256);
  assert.equal(suite.runnerVersion, PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_RUNNER_V1);
  const negatives = suite.cases.filter((entry: any) => entry.class === 'negative');
  const positives = suite.cases.filter((entry: any) => entry.class === 'positive');
  assert.equal(positives.length, suite.positiveCaseCount);
  assert.equal(negatives.length, suite.negativeCaseCount);
  assert.deepEqual(suite.holdoutCaseIds, negatives.map((entry: any) => entry.caseId));
  assert.ok(positives.every((entry: any) => !suite.holdoutCaseIds.includes(entry.caseId)));
  assert.ok(suite.cases.every((entry: any) => !Object.hasOwn(entry, 'prompt')
    && !Object.hasOwn(entry, 'content') && !Object.hasOwn(entry, 'expectedText')));
});

test('effects-off planner selects only exact runtime-authority hashes and never makes a callable plan', async () => {
  const { inventory } = await fixture();
  const plan = planEffectsOffBrandBrainRuntime(approvedSnapshot(inventory), inventory, {
    planKey: 'fixture-social-1', deliverableKind: 'post',
  });
  assert.equal(plan.specialistProfileId, 'propertypredator.owned.social/v1');
  assert.deepEqual(plan.sourceReferences.map(({ kind }) => kind),
    ['role', 'policy', 'instruction', 'knowledge']);
  assert.ok(plan.sourceReferences.every((source) =>
    source.authorityStatus === 'authoritative-runtime'
      && source.consumerUse === 'runtime-authority-reference'));
  assert.ok(!plan.sourceReferences.some((source) =>
    ['ai-brief-grounding', 'legacy-admin-image-style'].includes(source.sourceId)));
  assert.match(plan.planSha256, /^[0-9a-f]{64}$/);
  assert.equal(plan.callable, false);
  assert.equal(plan.providerEffects, false);
  assert.equal(plan.sourceReviewRequired, true);
  assert.ok(plan.externalSpecialists.every((specialist) => specialist.callable === false));
  assert.deepEqual(plan.externalSpecialists, PROPERTY_PREDATOR_EXTERNAL_GPT_PLACEHOLDERS);
});

test('panther conflict blocks image readiness while an approved non-image plan remains metadata-only', async () => {
  const { inventory } = await fixture();
  const snapshot = approvedSnapshot(inventory);
  assert.throws(() => planEffectsOffBrandBrainRuntime(snapshot, inventory, {
    planKey: 'fixture-image-1', deliverableKind: 'image',
  }), BrandBrainConflictError);
  const stale = { ...snapshot, sourceFresh: false };
  assert.throws(() => planEffectsOffBrandBrainRuntime(stale, inventory, {
    planKey: 'fixture-email-1', deliverableKind: 'email',
  }), /not activated, fresh and evaluation-passed/);
});

test('evaluation and review validation require held-out negatives and metadata-only reason codes', () => {
  assert.throws(() => normalizeBrandBrainEvaluation({
    commandKey: 'eval-1', sourceReleaseId: UUID_A, manifestSha256: HASH_A,
    evalSuiteSha256: PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_SUITE_V1_SHA256,
    runnerVersion: PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_RUNNER_V1, positiveCaseCount: 4,
    negativeCaseCount: 0, passedCaseCount: 3, resultSha256: HASH_A,
  }), /trusted offline v1 suite/);
  assert.throws(() => normalizeBrandBrainReview({
    commandKey: 'review-1', sourceReleaseId: UUID_A, manifestSha256: HASH_A,
    dimension: 'privacy_security', decision: 'rejected',
    decisionReasonCode: 'contains martin@example.com',
  }), BrandBrainValidationError);
  assert.equal(normalizeBrandBrainReview({
    commandKey: 'review-2', sourceReleaseId: UUID_A, manifestSha256: HASH_A,
    dimension: 'privacy_security', decision: 'rejected',
    decisionReasonCode: 'privacy_review_required',
  }).decisionReasonCode, 'privacy_review_required');
});
