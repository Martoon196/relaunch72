import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as domainApi from '../src/company-asset-release/domain.js';
import {
  COMPANY_ASSET_RELEASE_ID,
  COMPANY_OWNED_GENERATION_CONTRACT,
  PROPERTY_PREDATOR_COMPANY_ASSET_SOURCE_COMMIT,
  PROPERTY_PREDATOR_GROWTH_HQ_BRIDGE_CONTRACT,
  companyAssetReleaseScopeSha256,
  parseCompanyAssetFounderApproval,
  parseCompanyAssetReleaseBridge,
  reconcileCompanyAssetRelease,
  type CompanyAssetRelease,
  type CompanyAssetReleaseScope,
} from '../src/company-asset-release/domain.js';
import {
  PROPERTY_PREDATOR_AI_RUNTIME_BRAND_V1_SHA256,
  canonicalPropertyPredatorAiInventoryJson,
} from '../src/company-content-adapter/property-predator-ai-inventory.js';

type MutableObject = Record<string, any>;

const FIXTURE_URL = new URL('./fixtures/property-predator-ai-inventory-v1.golden.json', import.meta.url);
const SOURCE_CATALOG_SHA256 = 'c'.repeat(64);
const CONTENT_SHA256 = 'd'.repeat(64);
const BLOB_SHA256 = 'e'.repeat(64);
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const ITEM_ID = 'asset:company-evidence-card';
const APPROVAL_ID = 'source-approval-asset-4';

function canonicalSha256(value: unknown): string {
  return createHash('sha256')
    .update(canonicalPropertyPredatorAiInventoryJson(value), 'utf8')
    .digest('hex');
}

function detached<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function manifest(): Promise<MutableObject> {
  return JSON.parse(await readFile(FIXTURE_URL, 'utf8')) as MutableObject;
}

function assetItem(overrides: MutableObject = {}): MutableObject {
  const version = overrides.versionId ?? VERSION_ID;
  return {
    affiliateMode: 'forbidden',
    approvalExpiresAt: null,
    approvalExpiryStatus: 'missing',
    approvalId: APPROVAL_ID,
    approvedAt: '2026-08-27T09:10:11.123456+00:00',
    assetResourcePath: `/api/internal/company-content/assets/${version}/file`,
    blobSha256: BLOB_SHA256,
    brandSha256: PROPERTY_PREDATOR_AI_RUNTIME_BRAND_V1_SHA256,
    contentMode: 'company-owned',
    contentResourcePath: `/api/internal/company-content/versions/${version}`,
    contentSha256: CONTENT_SHA256,
    hqUseStatus: 'review-required',
    itemId: ITEM_ID,
    itemType: 'asset',
    itemVersion: 4,
    ownershipStatus: 'source-asserted-company-owned',
    privacyStatus: 'customer-private-data-forbidden',
    quarantineStatus: 'not-recorded-at-source',
    sourceApprovalStatus: 'source-approved-exact-version',
    versionId: version,
    ...overrides,
  };
}

function generatedItem(): MutableObject {
  const version = '33333333-3333-4333-8333-333333333333';
  return {
    affiliateMode: 'forbidden',
    approvalExpiresAt: null,
    approvalExpiryStatus: 'missing',
    approvalId: 'source-approval-generated-1',
    approvedAt: '2026-08-27T09:11:00Z',
    assetResourcePath: null,
    blobSha256: null,
    brandSha256: PROPERTY_PREDATOR_AI_RUNTIME_BRAND_V1_SHA256,
    contentMode: 'company-owned',
    contentResourcePath: `/api/internal/company-content/versions/${version}`,
    contentSha256: 'f'.repeat(64),
    hqUseStatus: 'review-required',
    itemId: 'generated:company-update',
    itemType: 'generated',
    itemVersion: 1,
    ownershipStatus: 'source-asserted-company-owned',
    privacyStatus: 'customer-private-data-forbidden',
    quarantineStatus: 'not-recorded-at-source',
    sourceApprovalStatus: 'source-approved-exact-version',
    versionId: version,
  };
}

async function envelope(items: MutableObject[] = [assetItem()]): Promise<MutableObject> {
  const release = {
    approvedItemCount: items.length,
    approvedItems: items,
    brandBrain: {
      hqUseStatus: 'review-required',
      manifest: await manifest(),
      runtimeBrandSha256: PROPERTY_PREDATOR_AI_RUNTIME_BRAND_V1_SHA256,
      sourceApprovalStatus: 'source-current',
    },
    contract: detached(PROPERTY_PREDATOR_GROWTH_HQ_BRIDGE_CONTRACT),
    releaseId: COMPANY_ASSET_RELEASE_ID,
    sourceCatalogSha256: SOURCE_CATALOG_SHA256,
    sourceSystem: 'property-predator',
  };
  return {
    generatedAt: '2026-08-27T09:12:00+00:00',
    release,
    releaseSha256: canonicalSha256(release),
    schemaVersion: 1,
  };
}

function rehashBridge(value: MutableObject): void {
  value.releaseSha256 = canonicalSha256(value.release);
}

function founderApproval(release: CompanyAssetRelease): MutableObject {
  return {
    approvalAuthority: 'growth_hq_founder',
    approvalExpiresAt: '2026-08-28T10:00:00Z',
    approvalId: 'hq-founder-release-approval-1',
    approvalStatus: 'founder_approved',
    approvedAt: '2026-08-27T10:00:00Z',
    hqHumanApproval: true,
    schemaVersion: 1,
    scope: detached(release.scope),
    scopeSha256: release.scopeSha256,
  };
}

function rehashApproval(value: MutableObject): void {
  value.scopeSha256 = companyAssetReleaseScopeSha256(value.scope as CompanyAssetReleaseScope);
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value as Record<string, unknown>)) assertDeepFrozen(child, seen);
}

test('parses source commit b5986c bridge v1 into detached immutable release and item domains', async () => {
  assert.equal(PROPERTY_PREDATOR_COMPANY_ASSET_SOURCE_COMMIT,
    'b5986c94d0f8690236c9f290ba14b49cc978e887');
  const input = await envelope();
  const parsed = parseCompanyAssetReleaseBridge(input);
  assert.equal(parsed.releaseSha256, input.releaseSha256);
  assert.equal(parsed.sourceCatalogSha256, SOURCE_CATALOG_SHA256);
  assert.equal(parsed.brandBrain.manifest.packageSha256, input.release.brandBrain.manifest.packageSha256);
  assert.equal(parsed.approvedItemCount, 1);
  assert.deepEqual(parsed.approvedItems[0], {
    ...assetItem(),
    usable: false,
    usabilityReasonCodes: ['source_approval_expiry_missing', 'source_quarantine_unknown'],
  });
  assert.match(parsed.scopeSha256, /^[0-9a-f]{64}$/);
  assert.equal(companyAssetReleaseScopeSha256(parsed.scope), parsed.scopeSha256);
  assert.equal(parsed.usable, false);
  assert.deepEqual(parsed.usabilityReasonCodes, [
    'hq_human_approval_required',
    'source_approval_expiry_missing',
    'source_quarantine_unknown',
  ]);
  assertDeepFrozen(parsed);
  assertDeepFrozen(parsed.approvedItems[0]);

  input.release.approvedItems[0].contentSha256 = '0'.repeat(64);
  input.release.brandBrain.manifest.sources[0].sourceId = 'mutated-after-parse';
  assert.equal(parsed.approvedItems[0]!.contentSha256, CONTENT_SHA256);
  assert.notEqual(parsed.brandBrain.manifest.sources[0]!.sourceId, 'mutated-after-parse');
});

test('observation time is canonical but excluded from the exact release and scope digest', async () => {
  const firstInput = await envelope();
  const secondInput = detached(firstInput);
  secondInput.generatedAt = '2026-08-27T11:12:00+02:00';
  const first = parseCompanyAssetReleaseBridge(firstInput);
  const second = parseCompanyAssetReleaseBridge(secondInput);
  assert.equal(first.releaseSha256, second.releaseSha256);
  assert.equal(first.scopeSha256, second.scopeSha256);
  assert.notEqual(first.generatedAt, second.generatedAt);
});

test('rejects a changed release digest and rejects rehashed unknown body or operation fields', async () => {
  const changedHash = await envelope();
  changedHash.release.approvedItems[0].contentSha256 = '0'.repeat(64);
  assert.throws(() => parseCompanyAssetReleaseBridge(changedHash), /releaseSha256 does not verify/);

  for (const field of [
    'body', 'payload', 'rawPrompt', 'promptText', 'knowledgeText', 'imageBytes', 'dataB64',
    'customerId', 'leadId', 'affiliateId', 'sessionId', 'credential', 'secret',
    'providerOperation', 'publishOperation',
  ]) {
    const candidate = await envelope();
    candidate.release.approvedItems[0][field] = field === 'payload' ? {} : 'forbidden';
    rehashBridge(candidate);
    assert.throws(
      () => parseCompanyAssetReleaseBridge(candidate),
      /unknown or missing fields/,
      field,
    );
  }
});

test('rejects rehashed affiliate semantics and every changed bridge trust literal', async () => {
  const mutations: ((candidate: MutableObject) => void)[] = [
    (candidate) => { candidate.release.contract.affiliateMode = 'allowed'; },
    (candidate) => { candidate.release.contract.mode = 'affiliate'; },
    (candidate) => { candidate.release.contract.customerPrivateData = 'allowed'; },
    (candidate) => { candidate.release.contract.generation = 'enabled'; },
    (candidate) => { candidate.release.contract.providerEffects = 'enabled'; },
    (candidate) => { candidate.release.contract.hqApprovalRequired = false; },
    (candidate) => { candidate.release.approvedItems[0].affiliateMode = 'allowed'; },
    (candidate) => { candidate.release.approvedItems[0].contentMode = 'affiliate'; },
    (candidate) => { candidate.release.approvedItems[0].privacyStatus = 'customer-data-allowed'; },
    (candidate) => { candidate.release.brandBrain.hqUseStatus = 'approved'; },
  ];
  for (const mutate of mutations) {
    const candidate = await envelope();
    mutate(candidate);
    rehashBridge(candidate);
    assert.throws(() => parseCompanyAssetReleaseBridge(candidate), /unsupported/);
  }
});

test('rejects invented expiry and quarantine certainty even when an attacker rehashes the release', async () => {
  const mutations: ((item: MutableObject) => void)[] = [
    (item) => { item.approvalExpiresAt = '2099-01-01T00:00:00Z'; },
    (item) => { item.approvalExpiryStatus = 'current'; },
    (item) => { item.quarantineStatus = 'clear'; },
    (item) => { item.quarantineStatus = 'quarantined'; },
    (item) => { item.sourceApprovalStatus = 'missing'; },
    (item) => { item.sourceApprovalStatus = 'unknown'; },
    (item) => { item.sourceApprovalStatus = 'unapproved'; },
    (item) => { item.sourceApprovalStatus = 'expired'; },
  ];
  for (const mutate of mutations) {
    const candidate = await envelope();
    mutate(candidate.release.approvedItems[0]);
    rehashBridge(candidate);
    assert.throws(
      () => parseCompanyAssetReleaseBridge(candidate),
      /unsupported|invents source approval expiry evidence/,
    );
  }
});

test('validates canonical RFC3339 instants without accepting naive, impossible or unknown-offset dates', async () => {
  for (const badInstant of [
    '2026-08-27T09:12:00',
    '2026-08-27t09:12:00z',
    '2026-02-30T09:12:00Z',
    '2026-08-27T24:00:00Z',
    '2026-08-27T09:12:00-00:00',
    '2026-08-27T09:12:00+14:01',
    '2026-08-27T09:12:00.1234567Z',
  ]) {
    const candidate = await envelope();
    candidate.generatedAt = badInstant;
    assert.throws(() => parseCompanyAssetReleaseBridge(candidate), /canonical RFC3339 instant/);
  }

  const candidate = await envelope();
  candidate.release.approvedItems[0].approvedAt = '2026-02-30T09:12:00Z';
  rehashBridge(candidate);
  assert.throws(() => parseCompanyAssetReleaseBridge(candidate), /canonical RFC3339 instant/);
});

test('requires sorted unique item tuples, unique versions and exact asset resource paths', async () => {
  const unsorted = await envelope([generatedItem(), assetItem()]);
  assert.throws(() => parseCompanyAssetReleaseBridge(unsorted), /sorted and unique/);

  const duplicateVersion = await envelope([assetItem(), generatedItem()]);
  duplicateVersion.release.approvedItems[1].versionId = VERSION_ID;
  duplicateVersion.release.approvedItems[1].contentResourcePath =
    `/api/internal/company-content/versions/${VERSION_ID}`;
  rehashBridge(duplicateVersion);
  assert.throws(() => parseCompanyAssetReleaseBridge(duplicateVersion), /repeats a versionId/);

  const wrongAssetPath = await envelope();
  wrongAssetPath.release.approvedItems[0].assetResourcePath =
    `/api/internal/company-content/assets/not-${VERSION_ID}/file`;
  rehashBridge(wrongAssetPath);
  assert.throws(() => parseCompanyAssetReleaseBridge(wrongAssetPath), /invalid asset resource path/);

  const nonAssetBlob = await envelope([generatedItem()]);
  nonAssetBlob.release.approvedItems[0].blobSha256 = BLOB_SHA256;
  rehashBridge(nonAssetBlob);
  assert.throws(() => parseCompanyAssetReleaseBridge(nonAssetBlob), /non-asset item/);
});

test('reuses the exact AI inventory parser, including its trusted package and quarantine checks', async () => {
  const changedPackage = await envelope();
  changedPackage.release.brandBrain.manifest.packageSha256 = '0'.repeat(64);
  rehashBridge(changedPackage);
  assert.throws(
    () => parseCompanyAssetReleaseBridge(changedPackage),
    /manifest is invalid: AI inventory package is not the trusted v1 release/,
  );

  const fakeQuarantine = await envelope();
  fakeQuarantine.release.brandBrain.manifest.quarantines[0].usable = true;
  const unsigned = detached(fakeQuarantine.release.brandBrain.manifest);
  delete unsigned.packageSha256;
  fakeQuarantine.release.brandBrain.manifest.packageSha256 = canonicalSha256(unsigned);
  rehashBridge(fakeQuarantine);
  assert.throws(
    () => parseCompanyAssetReleaseBridge(fakeQuarantine),
    /manifest is invalid: quarantine\.usable must be false/,
  );
});

test('fails before invoking getters and rejects prototype, sparse-array, width and depth surprises', async () => {
  const getterInput = await envelope();
  let getterCalls = 0;
  Object.defineProperty(getterInput, 'generatedAt', {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('must never execute');
    },
  });
  assert.throws(() => parseCompanyAssetReleaseBridge(getterInput), /enumerable data property/);
  assert.equal(getterCalls, 0);

  const prototypeInput = await envelope();
  Object.setPrototypeOf(prototypeInput, { inheritedSecret: 'surprise' });
  assert.throws(() => parseCompanyAssetReleaseBridge(prototypeInput), /surprising object prototype/);

  const sparseInput = await envelope();
  sparseInput.release.approvedItems = new Array(2);
  sparseInput.release.approvedItemCount = 2;
  assert.throws(() => parseCompanyAssetReleaseBridge(sparseInput), /dense array/);

  const wideInput = await envelope();
  wideInput.attack = Object.fromEntries(
    Array.from({ length: 20_001 }, (_, index) => [`x${String(index).padStart(5, '0')}`, index]),
  );
  assert.throws(() => parseCompanyAssetReleaseBridge(wideInput), /total key bound/);

  const deepInput = await envelope();
  let cursor: MutableObject = deepInput;
  for (let depth = 0; depth < 14; depth += 1) {
    cursor.attack = {};
    cursor = cursor.attack;
  }
  assert.throws(() => parseCompanyAssetReleaseBridge(deepInput), /depth bound/);
});

test('enforces single-string, aggregate-string, node and canonical byte budgets', async () => {
  const largeString = await envelope();
  largeString.attack = 'x'.repeat(4_097);
  assert.throws(() => parseCompanyAssetReleaseBridge(largeString), /oversized string/);

  const aggregateStrings = await envelope();
  aggregateStrings.attack = Array.from({ length: 140 }, () => 'x'.repeat(4_000));
  assert.throws(() => parseCompanyAssetReleaseBridge(aggregateStrings), /total string bound/);

  const tooManyNodes = await envelope();
  tooManyNodes.attack = Array.from({ length: 1_000 }, () =>
    Array.from({ length: 20 }, () => null));
  assert.throws(() => parseCompanyAssetReleaseBridge(tooManyNodes), /total node bound/);

  const tooManyBytes = await envelope();
  tooManyBytes.attack = Array.from({ length: 90 }, () => '\u20ac'.repeat(4_000));
  assert.throws(() => parseCompanyAssetReleaseBridge(tooManyBytes), /byte bound/);
});

test('parses a bounded founder approval and reconciles an unchanged exact tuple deterministically', async () => {
  const release = parseCompanyAssetReleaseBridge(await envelope());
  const rawApproval = founderApproval(release);
  const approval = parseCompanyAssetFounderApproval(rawApproval);
  assert.equal(approval.scopeSha256, release.scopeSha256);
  assertDeepFrozen(approval);

  const first = reconcileCompanyAssetRelease(release, rawApproval, '2026-08-27T12:00:00Z');
  const second = reconcileCompanyAssetRelease(release, rawApproval, '2026-08-27T12:00:00Z');
  assert.equal(first.status, 'reconciled');
  assert.deepEqual(first.reconciliationReasonCodes, []);
  assert.equal(first.currentScopeSha256, release.scopeSha256);
  assert.equal(first.approvedScopeSha256, release.scopeSha256);
  assert.equal(first.reconciliationSha256, second.reconciliationSha256);
  assert.match(first.reconciliationSha256, /^[0-9a-f]{64}$/);
  assert.equal(first.usable, false);
  assert.deepEqual(first.usabilityReasonCodes, [
    'source_approval_expiry_missing',
    'source_quarantine_unknown',
  ]);
  assertDeepFrozen(first);
});

test('missing, invalid or expired founder approval is review_required and never usable', async () => {
  const release = parseCompanyAssetReleaseBridge(await envelope());
  const missing = reconcileCompanyAssetRelease(release, undefined, '2026-08-27T12:00:00Z');
  assert.equal(missing.status, 'review_required');
  assert.equal(missing.usable, false);
  assert.deepEqual(missing.reconciliationReasonCodes, ['founder_approval_missing']);
  assert.equal(missing.approvedScopeSha256, null);

  const invalidApproval = founderApproval(release);
  invalidApproval.hqHumanApproval = false;
  const invalid = reconcileCompanyAssetRelease(release, invalidApproval, '2026-08-27T12:00:00Z');
  assert.deepEqual(invalid.reconciliationReasonCodes, ['founder_approval_invalid']);
  assert.equal(invalid.usable, false);

  const expiredApproval = founderApproval(release);
  expiredApproval.approvalExpiresAt = '2026-08-27T11:59:59Z';
  const expired = reconcileCompanyAssetRelease(release, expiredApproval, '2026-08-27T12:00:00Z');
  assert.deepEqual(expired.reconciliationReasonCodes, ['founder_approval_expired']);
  assert.equal(expired.status, 'review_required');
  assert.equal(expired.usable, false);
});

test('release, catalog and item hash changes produce ordered deterministic review reasons', async () => {
  const original = parseCompanyAssetReleaseBridge(await envelope());
  const approval = founderApproval(original);
  const changedInput = await envelope();
  changedInput.release.sourceCatalogSha256 = '1'.repeat(64);
  changedInput.release.approvedItems[0].contentSha256 = '2'.repeat(64);
  rehashBridge(changedInput);
  const changed = parseCompanyAssetReleaseBridge(changedInput);
  const result = reconcileCompanyAssetRelease(changed, approval, '2026-08-27T12:00:00Z');
  assert.equal(result.status, 'review_required');
  assert.equal(result.usable, false);
  assert.deepEqual(result.reconciliationReasonCodes, [
    'release_hash_changed',
    'source_catalog_hash_changed',
    'item_hash_changed',
  ]);
});

test('item addition and removal never flow forward from an old exact founder approval', async () => {
  const original = parseCompanyAssetReleaseBridge(await envelope());
  const approval = founderApproval(original);

  const addedInput = await envelope([assetItem(), generatedItem()]);
  rehashBridge(addedInput);
  const added = reconcileCompanyAssetRelease(
    parseCompanyAssetReleaseBridge(addedInput),
    approval,
    '2026-08-27T12:00:00Z',
  );
  assert.deepEqual(added.reconciliationReasonCodes, ['release_hash_changed', 'item_added']);

  const emptyInput = await envelope([]);
  const removed = reconcileCompanyAssetRelease(
    parseCompanyAssetReleaseBridge(emptyInput),
    approval,
    '2026-08-27T12:00:00Z',
  );
  assert.deepEqual(removed.reconciliationReasonCodes, ['release_hash_changed', 'item_removed']);
  assert.ok(removed.usabilityReasonCodes.includes('source_material_missing'));
  assert.equal(removed.usable, false);
});

test('version, path, approval, status and brand tuple changes each require fresh review', async () => {
  const original = parseCompanyAssetReleaseBridge(await envelope());
  const approval = founderApproval(original);

  const nextVersion = '44444444-4444-4444-8444-444444444444';
  const versionInput = await envelope([assetItem({
    approvalId: 'source-approval-asset-5',
    approvedAt: '2026-08-27T13:00:00Z',
    itemVersion: 5,
    versionId: nextVersion,
  })]);
  rehashBridge(versionInput);
  const versionResult = reconcileCompanyAssetRelease(
    parseCompanyAssetReleaseBridge(versionInput),
    approval,
    '2026-08-27T14:00:00Z',
  );
  assert.deepEqual(versionResult.reconciliationReasonCodes, [
    'release_hash_changed',
    'item_version_changed',
    'item_path_changed',
    'item_approval_changed',
  ]);

  const statusApproval = founderApproval(original);
  statusApproval.scope.approvedItems[0].hqUseStatus = 'approved';
  rehashApproval(statusApproval);
  const statusResult = reconcileCompanyAssetRelease(
    original,
    statusApproval,
    '2026-08-27T12:00:00Z',
  );
  assert.deepEqual(statusResult.reconciliationReasonCodes, ['item_status_changed']);

  const brandApproval = founderApproval(original);
  brandApproval.scope.runtimeBrandSha256 = 'a'.repeat(64);
  brandApproval.scope.approvedItems[0].brandSha256 = 'a'.repeat(64);
  rehashApproval(brandApproval);
  const brandResult = reconcileCompanyAssetRelease(
    original,
    brandApproval,
    '2026-08-27T12:00:00Z',
  );
  assert.deepEqual(brandResult.reconciliationReasonCodes, ['brand_hash_changed']);
});

test('tampered founder scope digests and unsafe approval records fail closed', async () => {
  const release = parseCompanyAssetReleaseBridge(await envelope());
  const approval = founderApproval(release);
  approval.scope.approvedItems[0].contentSha256 = '0'.repeat(64);
  assert.throws(() => parseCompanyAssetFounderApproval(approval), /scopeSha256 does not verify/);
  const result = reconcileCompanyAssetRelease(release, approval, '2026-08-27T12:00:00Z');
  assert.deepEqual(result.reconciliationReasonCodes, ['founder_approval_invalid']);
  assert.equal(result.usable, false);

  const affiliateApproval = founderApproval(release);
  affiliateApproval.scope.approvedItems[0].affiliateMode = 'allowed';
  affiliateApproval.scope.approvedItems[0].contentMode = 'affiliate';
  rehashApproval(affiliateApproval);
  const affiliateResult = reconcileCompanyAssetRelease(
    release,
    affiliateApproval,
    '2026-08-27T12:00:00Z',
  );
  assert.deepEqual(affiliateResult.reconciliationReasonCodes, ['item_status_changed']);
  assert.equal(affiliateResult.usable, false);
});

test('company-owned generation contract is effects-off and the module exposes no operation path', async () => {
  assert.deepEqual(COMPANY_OWNED_GENERATION_CONTRACT, {
    mode: 'simulated_draft_only',
    ownershipMode: 'company_owned',
    affiliateInput: 'forbidden',
    sessionInput: 'forbidden',
    customerInput: 'forbidden',
    hqHumanApprovalRequired: true,
    modelCalls: false,
    sourceCalls: false,
    providerEffects: false,
    publishEffects: false,
  });
  assertDeepFrozen(COMPANY_OWNED_GENERATION_CONTRACT);
  for (const operation of [
    'generate', 'publish', 'send', 'loadSource', 'callModel', 'callProvider', 'createTransport',
  ]) {
    assert.equal(operation in domainApi, false, operation);
  }

  const source = await readFile(new URL('../src/company-asset-release/domain.ts', import.meta.url), 'utf8');
  for (const executablePattern of [
    /\bfetch\s*\(/u,
    /\b(?:http|https)\.request\s*\(/u,
    /\bpublish\s*\(/u,
    /\bgenerate\s*\(/u,
    /\.generate\s*\(/u,
    /node:(?:http|https|net|tls|child_process)/u,
  ]) {
    assert.doesNotMatch(source, executablePattern);
  }
});

test('parsed release contains reference metadata only, never raw content or private/provider material', async () => {
  const release = parseCompanyAssetReleaseBridge(await envelope());
  const forbiddenKeys = new Set([
    'affiliateId', 'body', 'credential', 'customerId', 'dataB64', 'imageBytes', 'knowledgeText',
    'leadId', 'payload', 'promptText', 'rawPrompt', 'secret', 'sessionId', 'providerOperation',
  ]);
  function walk(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        assert.equal(forbiddenKeys.has(key), false, key);
        walk(child);
      }
    }
  }
  walk(release);
});
