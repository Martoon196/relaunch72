import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  COMPANY_ASSET_RELEASE_ID,
  PROPERTY_PREDATOR_GROWTH_HQ_BRIDGE_CONTRACT,
  companyAssetReleaseScopeSha256,
  parseCompanyAssetReleaseBridge,
} from '../src/company-asset-release/domain.js';
import {
  COMPANY_ASSET_EVAL_DIMENSIONS,
  COMPANY_ASSET_EVAL_RUNNER,
} from '../src/company-asset-release/evaluation.js';
import {
  PROPERTY_PREDATOR_AI_RUNTIME_BRAND_V1_SHA256,
  canonicalPropertyPredatorAiInventoryJson,
} from '../src/company-content-adapter/property-predator-ai-inventory.js';
import {
  CompanyAssetConflictError,
  CompanyAssetValidationError,
  boundedCompanyAssetReadLimit,
  normalizeCompanyAssetApproval,
  normalizeCompanyAssetEvaluation,
  normalizeCompanyAssetQuarantineDecision,
  normalizeCompanyAssetReconciliation,
  normalizeStageCompanyAssetRelease,
} from '../src/company-asset-pg/index.js';

type Mutable = Record<string, any>;
const manifestUrl = new URL('./fixtures/property-predator-ai-inventory-v1.golden.json', import.meta.url);
const CONTENT_SHA = '11'.repeat(32);
const BLOB_SHA = '22'.repeat(32);
const CATALOG_SHA = '33'.repeat(32);
const VERSION_ID = '10000000-0000-4000-8000-000000000001';

function canonicalSha256(value: unknown): string {
  return createHash('sha256')
    .update(canonicalPropertyPredatorAiInventoryJson(value), 'utf8')
    .digest('hex');
}

async function envelope(): Promise<Mutable> {
  const release = {
    approvedItemCount: 1,
    approvedItems: [{
      affiliateMode: 'forbidden',
      approvalExpiresAt: null,
      approvalExpiryStatus: 'missing',
      approvalId: 'fictional-source-approval-1',
      approvedAt: '2026-08-27T09:10:00Z',
      assetResourcePath: `/api/internal/company-content/assets/${VERSION_ID}/file`,
      blobSha256: BLOB_SHA,
      brandSha256: PROPERTY_PREDATOR_AI_RUNTIME_BRAND_V1_SHA256,
      contentMode: 'company-owned',
      contentResourcePath: `/api/internal/company-content/versions/${VERSION_ID}`,
      contentSha256: CONTENT_SHA,
      hqUseStatus: 'review-required',
      itemId: 'asset:fictional-evidence-card',
      itemType: 'asset',
      itemVersion: 1,
      ownershipStatus: 'source-asserted-company-owned',
      privacyStatus: 'customer-private-data-forbidden',
      quarantineStatus: 'not-recorded-at-source',
      sourceApprovalStatus: 'source-approved-exact-version',
      versionId: VERSION_ID,
    }],
    brandBrain: {
      hqUseStatus: 'review-required',
      manifest: JSON.parse(await readFile(manifestUrl, 'utf8')) as unknown,
      runtimeBrandSha256: PROPERTY_PREDATOR_AI_RUNTIME_BRAND_V1_SHA256,
      sourceApprovalStatus: 'source-current',
    },
    contract: JSON.parse(JSON.stringify(PROPERTY_PREDATOR_GROWTH_HQ_BRIDGE_CONTRACT)),
    releaseId: COMPANY_ASSET_RELEASE_ID,
    sourceCatalogSha256: CATALOG_SHA,
    sourceSystem: 'property-predator',
  };
  return {
    generatedAt: '2026-08-27T09:12:00Z',
    release,
    releaseSha256: canonicalSha256(release),
    schemaVersion: 1,
  };
}

function founderApproval(release: ReturnType<typeof parseCompanyAssetReleaseBridge>): Mutable {
  return {
    approvalAuthority: 'growth_hq_founder',
    approvalExpiresAt: '2026-08-28T10:00:00Z',
    approvalId: 'fictional-founder-approval-1',
    approvalStatus: 'founder_approved',
    approvedAt: '2026-08-27T10:00:00Z',
    hqHumanApproval: true,
    schemaVersion: 1,
    scope: JSON.parse(JSON.stringify(release.scope)),
    scopeSha256: release.scopeSha256,
  };
}

function evaluationSuite(release: ReturnType<typeof parseCompanyAssetReleaseBridge>): Mutable {
  const reason = {
    brand: { accept: 'brand_style_match', reject: 'brand_style_violation' },
    avatar: { accept: 'avatar_fit_match', reject: 'avatar_fit_violation' },
    claims: { accept: 'claims_supported', reject: 'claims_unsubstantiated' },
    disclosure: { accept: 'disclosure_present', reject: 'disclosure_missing' },
    visual_policy: { accept: 'visual_policy_match', reject: 'visual_policy_conflict' },
  } as const;
  const cases = COMPANY_ASSET_EVAL_DIMENSIONS.flatMap((dimension) => ([
    {
      caseId: `a-${dimension}-golden`, caseKind: 'golden', dimension,
      inputSha256: '44'.repeat(32), outputSha256: '55'.repeat(32),
      evidenceSha256: '66'.repeat(32), expectedDisposition: 'accept',
      observedDisposition: 'accept', reasonCode: reason[dimension].accept,
    },
    {
      caseId: `b-${dimension}-rejected`, caseKind: 'rejected', dimension,
      inputSha256: '77'.repeat(32), outputSha256: '88'.repeat(32),
      evidenceSha256: '99'.repeat(32), expectedDisposition: 'reject',
      observedDisposition: 'reject', reasonCode: reason[dimension].reject,
    },
  ])).sort((left, right) => left.caseId.localeCompare(right.caseId));
  return {
    brandBrainPackageSha256: release.scope.brandBrainPackageSha256,
    cases,
    runnerVersion: COMPANY_ASSET_EVAL_RUNNER,
    schemaVersion: 1,
    sourceReleaseSha256: release.releaseSha256,
    sourceScopeSha256: release.scopeSha256,
    suiteId: 'fictional-company-assets-v1',
  };
}

test('normalises a sealed release into a fresh exact-hash attestation without enabling use', async () => {
  const raw = await envelope();
  const staged = normalizeStageCompanyAssetRelease({
    commandKey: 'fictional-stage-1',
    releaseEnvelope: raw,
    checkedAt: '2026-08-27T10:00:00Z',
    expiresAt: '2026-08-27T10:10:00Z',
  }, new Date('2026-08-27T10:00:02Z'));
  assert.equal(staged.release.releaseSha256, raw.releaseSha256);
  assert.equal(staged.release.sourceCatalogSha256, CATALOG_SHA);
  assert.equal(staged.release.usable, false);
  assert.deepEqual(staged.release.usabilityReasonCodes, [
    'hq_human_approval_required',
    'source_approval_expiry_missing',
    'source_quarantine_unknown',
  ]);
  assert.match(staged.commandKeySha256, /^[0-9a-f]{64}$/);
  assert.match(staged.attestationSha256, /^[0-9a-f]{64}$/);

  assert.throws(() => normalizeStageCompanyAssetRelease({
    commandKey: 'fictional-stage-stale', releaseEnvelope: raw,
    checkedAt: '2026-08-27T09:00:00Z', expiresAt: '2026-08-27T09:10:00Z',
  }, new Date('2026-08-27T10:00:00Z')), CompanyAssetValidationError);
  assert.throws(() => normalizeStageCompanyAssetRelease({
    commandKey: 'fictional-stage-future', releaseEnvelope: raw,
    checkedAt: '2026-08-27T10:00:31Z', expiresAt: '2026-08-27T10:10:31Z',
  }, new Date('2026-08-27T10:00:00Z')), CompanyAssetValidationError);
});

test('normalises only complete hash-only golden/rejected reports bound to the staged tuple', async () => {
  const release = parseCompanyAssetReleaseBridge(await envelope());
  const evaluation = normalizeCompanyAssetEvaluation({
    commandKey: 'fictional-eval-1', evaluationSuite: evaluationSuite(release),
  });
  assert.equal(evaluation.report.sourceReleaseSha256, release.releaseSha256);
  assert.equal(evaluation.report.sourceScopeSha256, release.scopeSha256);
  assert.equal(evaluation.report.caseCount, 10);
  assert.equal(evaluation.report.passed, true);
  assert.equal(evaluation.report.providerEffects, false);
  assert.equal(evaluation.report.modelCalls, false);

  const unsafe = evaluationSuite(release);
  unsafe.cases[0].outputBody = 'forbidden fictional body';
  assert.throws(() => normalizeCompanyAssetEvaluation({
    commandKey: 'fictional-eval-unsafe', evaluationSuite: unsafe,
  }));
});

test('quarantine decisions use exact allowlisted dimension/outcome/reason combinations', () => {
  const valid = normalizeCompanyAssetQuarantineDecision({
    commandKey: 'fictional-quarantine-1',
    sourceReleaseId: '10000000-0000-4000-8000-000000000002',
    itemType: 'asset', itemId: 'asset:fictional-evidence-card',
    dimension: 'asset', outcome: 'clear', reasonCode: 'asset_integrity_verified',
    evidenceSha256: 'aa'.repeat(32),
  });
  assert.equal(valid.reasonCode, 'asset_integrity_verified');
  assert.match(valid.commandKeySha256, /^[0-9a-f]{64}$/);

  assert.throws(() => normalizeCompanyAssetQuarantineDecision({
    commandKey: 'fictional-quarantine-bypass',
    sourceReleaseId: '10000000-0000-4000-8000-000000000002',
    itemType: 'asset', itemId: 'asset:fictional-evidence-card',
    dimension: 'asset', outcome: 'clear', reasonCode: 'no_asset_payload',
    evidenceSha256: 'aa'.repeat(32),
  }), CompanyAssetValidationError);
  assert.throws(() => normalizeCompanyAssetQuarantineDecision({
    commandKey: 'fictional-quarantine-raw',
    sourceReleaseId: '10000000-0000-4000-8000-000000000002',
    itemType: 'generated', itemId: 'generated:fictional-copy',
    dimension: 'claim', outcome: 'clear', reasonCode: 'claims_unsubstantiated',
    evidenceSha256: 'aa'.repeat(32),
  }), CompanyAssetValidationError);
});

test('founder approval is exact-scope/expiry bound and reconciliation stays dark on unknown source facts', async () => {
  const release = parseCompanyAssetReleaseBridge(await envelope());
  const approval = founderApproval(release);
  const normalizedApproval = normalizeCompanyAssetApproval({
    commandKey: 'fictional-approval-1', founderApproval: approval,
  });
  assert.equal(normalizedApproval.approval.scopeSha256, release.scopeSha256);
  assert.equal(normalizedApproval.approval.approvalExpiresAt, '2026-08-28T10:00:00Z');

  const reconciled = normalizeCompanyAssetReconciliation({
    commandKey: 'fictional-reconcile-1', releaseEnvelope: await envelope(),
    founderApproval: approval, evaluatedAt: '2026-08-27T12:00:00Z',
  });
  assert.equal(reconciled.reconciliation.status, 'reconciled');
  assert.equal(reconciled.reconciliation.usable, false);
  assert.deepEqual(reconciled.reconciliation.usabilityReasonCodes, [
    'source_approval_expiry_missing', 'source_quarantine_unknown',
  ]);

  const changed = founderApproval(release);
  changed.scope.approvedItems[0].contentSha256 = 'ff'.repeat(32);
  changed.scopeSha256 = companyAssetReleaseScopeSha256(changed.scope);
  const changedEnvelope = await envelope();
  assert.throws(() => normalizeCompanyAssetReconciliation({
    commandKey: 'fictional-reconcile-changed', releaseEnvelope: changedEnvelope,
    founderApproval: changed, evaluatedAt: '2026-08-27T12:00:00Z',
  }), CompanyAssetConflictError);
});

test('reads are bounded and implementation exposes no model, network, publish or provider operation path', async () => {
  assert.equal(boundedCompanyAssetReadLimit(undefined), 20);
  assert.equal(boundedCompanyAssetReadLimit(50), 50);
  assert.throws(() => boundedCompanyAssetReadLimit(51), CompanyAssetValidationError);
  const sources = await Promise.all([
    'types.ts', 'validation.ts', 'repository.ts', 'service.ts', 'index.ts',
  ].map((name) => readFile(new URL(`../src/company-asset-pg/${name}`, import.meta.url), 'utf8')));
  const source = sources.join('\n');
  assert.doesNotMatch(source, /@anthropic-ai|openai|fetch\s*\(|node:http|node:net|INSERT INTO app\.provider_operations/i);
  assert.doesNotMatch(source, /enqueueProvider|publishContent|sendMessage|customerPrivateBody|rawKnowledgeBody/i);
  assert.match(source, /providerEffects: false/);
  assert.match(source, /simulated_draft_only/);
});
