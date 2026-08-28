import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { CompanyAssetItemSummary } from '../src/company-asset-pg/index.js';
import type { CompanyAssetRelease } from '../src/company-asset-release/index.js';
import type {
  PropertyPredatorApprovedVersionResource,
} from '../src/company-content-adapter/property-predator-resources.js';
import type {
  PropertyPredatorCompanyContentCatalog,
  PropertyPredatorCompanyContentItem,
} from '../src/company-content-adapter/property-predator.js';
import type {
  CompanyContentCatalogItem,
  CreateCompanyContentVersionCommand,
  RefreshCompanyContentSourceAttestationCommand,
} from '../src/company-content-pg/index.js';
import { canonicalCompanyContentJson } from '../src/company-content-pg/validation.js';
import { PropertyPredatorContentSyncCoordinator } from '../src/company-content-sync/index.js';
import type { DatabaseRequestContext } from '../src/db/rls.js';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const USER_ID = '10000000-0000-4000-8000-000000000002';
const VERSION_ID = '10000000-0000-4000-8000-000000000003';
const APPROVAL_ID = '10000000-0000-4000-8000-000000000004';
const RELEASE_ROW_ID = '10000000-0000-4000-8000-000000000005';
const CONTENT_ITEM_ID = '10000000-0000-4000-8000-000000000006';
const CONTENT_VERSION_ID = '10000000-0000-4000-8000-000000000007';
const CHECKED_AT = '2026-08-28T10:00:00.000Z';
const BRAND_SHA = 'b'.repeat(64);
const CATALOG_SHA = 'c'.repeat(64);
const RELEASE_SHA = 'd'.repeat(64);
const PACKAGE_SHA = 'e'.repeat(64);

const CONTEXT: DatabaseRequestContext = Object.freeze({
  actorKind: 'user',
  workspaceId: WORKSPACE_ID,
  userId: USER_ID,
  requestId: 'sync-test',
  portalSessionTokenHash: Buffer.alloc(32, 7),
});

function sha(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sourceItem(): PropertyPredatorCompanyContentItem {
  const payload = Object.freeze({
    type: 'generated',
    schema: 'propertypredator.company-content/v1',
    kind: 'post',
    title: 'Why evidence beats noise',
    body: 'A company-owned Property Predator post with a clear evidence-led position.',
    cta_url: 'https://propertypredator.com',
    platform: 'linkedin',
  });
  return Object.freeze({
    approvalId: APPROVAL_ID,
    approvedAt: '2026-08-28T09:00:00.000Z',
    blobSha256: null,
    brandSha256: BRAND_SHA,
    contentSha256: sha(canonicalCompanyContentJson(payload)),
    itemId: 'evidence-beats-noise',
    itemType: 'generated',
    itemVersion: 1,
    payload,
    versionId: VERSION_ID,
    assetFilePath: null,
  });
}

function sourceFixture(): Readonly<{
  item: PropertyPredatorCompanyContentItem;
  catalog: PropertyPredatorCompanyContentCatalog;
  release: CompanyAssetRelease;
  resource: PropertyPredatorApprovedVersionResource;
}> {
  const item = sourceItem();
  const catalog: PropertyPredatorCompanyContentCatalog = Object.freeze({
    schemaVersion: 1,
    brandSha256: BRAND_SHA,
    catalogSha256: CATALOG_SHA,
    generatedAt: CHECKED_AT,
    itemCount: 1,
    items: Object.freeze([item]),
  });
  const releaseItem = Object.freeze({
    affiliateMode: 'forbidden' as const,
    approvalExpiresAt: null,
    approvalExpiryStatus: 'missing' as const,
    approvalId: item.approvalId,
    approvedAt: item.approvedAt,
    assetResourcePath: null,
    blobSha256: null,
    brandSha256: BRAND_SHA,
    contentMode: 'company-owned' as const,
    contentResourcePath: `/api/internal/company-content/versions/${VERSION_ID}`,
    contentSha256: item.contentSha256,
    hqUseStatus: 'review-required' as const,
    itemId: item.itemId,
    itemType: item.itemType,
    itemVersion: item.itemVersion,
    ownershipStatus: 'source-asserted-company-owned' as const,
    privacyStatus: 'customer-private-data-forbidden' as const,
    quarantineStatus: 'not-recorded-at-source' as const,
    sourceApprovalStatus: 'source-approved-exact-version' as const,
    versionId: item.versionId,
    usable: false as const,
    usabilityReasonCodes: Object.freeze(['source_approval_expiry_missing'] as const),
  });
  const scopeItem = Object.freeze({ ...releaseItem });
  const manifest = Object.freeze({
    packageSha256: PACKAGE_SHA,
    specialistProfiles: Object.freeze([
      Object.freeze({ runtimeBrandSha256: BRAND_SHA }),
    ]),
    sources: Object.freeze([]),
    artworkReferences: Object.freeze([]),
    quarantines: Object.freeze([]),
  });
  const release = Object.freeze({
    schemaVersion: 1,
    generatedAt: CHECKED_AT,
    releaseId: 'property-predator.company-content-growth-hq/v1',
    sourceSystem: 'property-predator',
    releaseSha256: RELEASE_SHA,
    sourceCatalogSha256: CATALOG_SHA,
    contract: Object.freeze({}),
    brandBrain: Object.freeze({
      sourceApprovalStatus: 'source-current',
      hqUseStatus: 'review-required',
      runtimeBrandSha256: BRAND_SHA,
      manifest,
    }),
    approvedItemCount: 1,
    approvedItems: Object.freeze([releaseItem]),
    scope: Object.freeze({
      approvedItems: Object.freeze([scopeItem]),
      brandBrainPackageSha256: PACKAGE_SHA,
      releaseId: 'property-predator.company-content-growth-hq/v1',
      releaseSha256: RELEASE_SHA,
      runtimeBrandSha256: BRAND_SHA,
      schemaVersion: 1,
      sourceCatalogSha256: CATALOG_SHA,
      sourceSystem: 'property-predator',
    }),
    scopeSha256: 'f'.repeat(64),
    generationContract: Object.freeze({}),
    usable: false,
    usabilityReasonCodes: Object.freeze(['hq_human_approval_required']),
  }) as unknown as CompanyAssetRelease;
  const resource: PropertyPredatorApprovedVersionResource = Object.freeze({
    versionId: item.versionId,
    itemId: item.itemId,
    itemType: item.itemType,
    itemVersion: item.itemVersion,
    approvalId: item.approvalId,
    approvedAt: item.approvedAt,
    contentSha256: item.contentSha256,
    blobSha256: item.blobSha256,
    brandSha256: item.brandSha256,
    payload: item.payload,
    canonicalContent: canonicalCompanyContentJson(item.payload),
    assetResourcePath: null,
  });
  return Object.freeze({ item, catalog, release, resource });
}

function decisionItem(
  fixture: ReturnType<typeof sourceFixture>,
  quarantined = false,
): CompanyAssetItemSummary {
  const decision = (dimension: 'visual_policy' | 'claim') => Object.freeze({
    dimension,
    outcome: quarantined && dimension === 'claim' ? 'quarantined' as const : 'clear' as const,
    reasonCode: quarantined && dimension === 'claim'
      ? 'claims_unsubstantiated' as const
      : dimension === 'claim' ? 'claims_supported' as const : 'visual_policy_match' as const,
    evidenceSha256: fixture.item.contentSha256,
    recordedAt: CHECKED_AT,
  });
  return Object.freeze({
    releaseItemId: '10000000-0000-4000-8000-000000000008',
    sourceReleaseId: RELEASE_ROW_ID,
    itemOrdinal: 1,
    itemType: fixture.item.itemType,
    itemId: fixture.item.itemId,
    itemVersion: fixture.item.itemVersion,
    versionId: fixture.item.versionId,
    contentSha256: fixture.item.contentSha256,
    blobSha256: null,
    brandSha256: fixture.item.brandSha256,
    approvalId: fixture.item.approvalId,
    approvedAt: fixture.item.approvedAt,
    approvalExpiryStatus: 'missing',
    contentMode: 'company-owned',
    hqUseStatus: 'review-required',
    ownershipStatus: 'source-asserted-company-owned',
    privacyStatus: 'customer-private-data-forbidden',
    sourceQuarantineStatus: 'not-recorded-at-source',
    sourceApprovalStatus: 'source-approved-exact-version',
    decisions: Object.freeze([decision('visual_policy'), decision('claim')]),
    recordedAt: CHECKED_AT,
  });
}

function existingItem(fixture: ReturnType<typeof sourceFixture>): CompanyContentCatalogItem {
  return Object.freeze({
    contentItemId: CONTENT_ITEM_ID,
    contentVersionId: CONTENT_VERSION_ID,
    versionNumber: 1,
    origin: 'imported',
    kind: 'social_post',
    title: fixture.item.payload.title as string,
    contentMimeType: 'application/json',
    source: Object.freeze({
      system: 'propertypredator.company-content',
      itemId: `${fixture.item.itemType}:${fixture.item.itemId}`,
      version: String(fixture.item.itemVersion),
    }),
    contentSha256: fixture.item.contentSha256,
    blobSha256: fixture.item.contentSha256,
    brandSha256: fixture.item.brandSha256,
    approvalRequestId: null,
    approvalDecisionId: null,
    approvalStatus: 'unrequested',
    approvalStale: false,
    sourceAttestationId: '10000000-0000-4000-8000-000000000009',
    sourceCheckedAt: CHECKED_AT,
    sourceExpiresAt: '2026-08-28T10:10:00.000Z',
    sourceFresh: true,
    publishable: false,
    createdAt: CHECKED_AT,
  });
}

function harness(input: Readonly<{
  local?: readonly CompanyContentCatalogItem[];
  quarantined?: boolean;
  resource?: PropertyPredatorApprovedVersionResource;
  bridgeError?: Error;
  reviewIncomplete?: boolean;
  duplicateReviewDimension?: boolean;
  wrongLocalProjection?: boolean;
  contentWriteError?: Error;
}> = {}) {
  const fixture = sourceFixture();
  const created: CreateCompanyContentVersionCommand[] = [];
  const refreshed: RefreshCompanyContentSourceAttestationCommand[] = [];
  let bridgeCalls = 0;
  let resourceCalls = 0;
  let stageCalls = 0;
  let clock = new Date(CHECKED_AT);
  const coordinator = new PropertyPredatorContentSyncCoordinator({
    now: () => new Date(clock),
    nextRunId: () => 'sync-run-0001',
    bridge: {
      async loadRelease() {
        bridgeCalls += 1;
        if (input.bridgeError) throw input.bridgeError;
        return fixture.release;
      },
    },
    catalog: { async catalog() { return fixture.catalog; } },
    resources: {
      async loadVersion() {
        resourceCalls += 1;
        return input.resource ?? fixture.resource;
      },
      async loadAsset() { throw new Error('unexpected asset read'); },
    },
    brandBrain: {
      async stageInventory() {
        stageCalls += 1;
        return Object.freeze({
          disposition: 'applied' as const,
          sourceReleaseId: RELEASE_ROW_ID,
          sourceAttestationId: '10000000-0000-4000-8000-000000000010',
          manifestSha256: PACKAGE_SHA,
          runtimeBrandSha256: BRAND_SHA,
          sourceCount: 0,
          specialistCount: 1,
          artworkCount: 0,
          quarantineCount: 0,
          providerEffects: false as const,
        });
      },
    },
    assets: {
      async stageRelease() {
        stageCalls += 1;
        return Object.freeze({
          disposition: 'applied' as const,
          sourceReleaseId: RELEASE_ROW_ID,
          sourceAttestationId: '10000000-0000-4000-8000-000000000011',
          releaseSha256: RELEASE_SHA,
          sourceCatalogSha256: CATALOG_SHA,
          scopeSha256: 'f'.repeat(64),
          runtimeBrandSha256: BRAND_SHA,
          brandBrainPackageSha256: PACKAGE_SHA,
          approvedItemCount: 1,
          usable: false as const,
          providerEffects: false as const,
        });
      },
      async listItems() {
        const item = decisionItem(fixture, input.quarantined);
        return Object.freeze({
          items: Object.freeze([input.reviewIncomplete
            ? Object.freeze({ ...item, decisions: Object.freeze(item.decisions.slice(0, 1)) })
            : input.duplicateReviewDimension
              ? Object.freeze({
                  ...item,
                  decisions: Object.freeze([item.decisions[0]!, item.decisions[0]!]),
                })
              : input.wrongLocalProjection
                ? Object.freeze({
                    ...item,
                    versionId: '20000000-0000-4000-8000-000000000099',
                  })
                : item]),
          hasMore: false,
        });
      },
    },
    content: {
      async listCatalog() {
        return Object.freeze({
          items: Object.freeze([...(input.local ?? [])]),
          nextCursor: null,
        });
      },
      async createVersion(_context, command) {
        if (input.contentWriteError) throw input.contentWriteError;
        created.push(command);
        return Object.freeze({
          disposition: 'applied' as const,
          contentItemId: CONTENT_ITEM_ID,
          contentVersionId: CONTENT_VERSION_ID,
          versionNumber: 1,
          contentSha256: fixture.item.contentSha256,
          sourceAttestationId: '10000000-0000-4000-8000-000000000012',
          sourceAttestationExpiresAt: '2026-08-28T10:10:00.000Z',
        });
      },
      async refreshSourceAttestation(_context, command) {
        if (input.contentWriteError) throw input.contentWriteError;
        refreshed.push(command);
        return Object.freeze({
          disposition: 'applied' as const,
          contentItemId: command.contentItemId,
          contentVersionId: command.contentVersionId,
          sourceAttestationId: '10000000-0000-4000-8000-000000000013',
          sourceAttestationExpiresAt: command.attestation.expiresAt,
          providerEffects: false as const,
        });
      },
    },
  });
  return {
    coordinator, fixture, created, refreshed,
    get bridgeCalls() { return bridgeCalls; },
    get resourceCalls() { return resourceCalls; },
    get stageCalls() { return stageCalls; },
    advance(ms: number) { clock = new Date(clock.getTime() + ms); },
  };
}

test('imports only the exact canonical company-owned bytes through the effects-off boundary', async () => {
  const subject = harness();
  const result = await subject.coordinator.sync(CONTEXT);

  assert.equal(result.state, 'current');
  assert.equal(result.sourceFresh, true);
  assert.equal(result.providerEffects, false);
  assert.equal(result.customerPrivateDataAccepted, false);
  assert.equal(result.affiliateContentAccepted, false);
  assert.equal(result.artworkBytesCopied, false);
  assert.equal(result.counts.importedVersions, 1);
  assert.equal(subject.created.length, 1);
  assert.equal(subject.created[0]?.content, subject.fixture.resource.canonicalContent);
  assert.equal(subject.created[0]?.metadata?.exactResourceVerified, true);
  assert.equal(subject.created[0]?.source.system, 'propertypredator.company-content');
  assert.equal(subject.refreshed.length, 0);
});

test('refreshes a source proof instead of duplicating an existing immutable revision', async () => {
  const fixture = sourceFixture();
  const subject = harness({ local: [existingItem(fixture)] });
  const result = await subject.coordinator.sync(CONTEXT);

  assert.equal(result.state, 'current');
  assert.equal(result.counts.importedVersions, 0);
  assert.equal(result.counts.refreshedAttestations, 1);
  assert.equal(subject.created.length, 0);
  assert.equal(subject.refreshed.length, 1);
  assert.equal(subject.refreshed[0]?.contentVersionId, CONTENT_VERSION_ID);
  assert.equal(subject.refreshed[0]?.expected.contentSha256, fixture.item.contentSha256);
});

test('skips a locally quarantined exact item before any content resource is fetched', async () => {
  const subject = harness({ quarantined: true });
  const result = await subject.coordinator.sync(CONTEXT);

  assert.equal(result.state, 'attention');
  assert.equal(result.counts.quarantinedItems, 1);
  assert.equal(result.counts.importedVersions, 0);
  assert.equal(subject.resourceCalls, 0);
  assert.equal(subject.created.length, 0);
  assert.equal(result.blockers[0]?.code, 'source_item_quarantined');
  assert.equal(result.blockers[0]?.retryable, false);
  assert.equal(result.lastSuccessAt, CHECKED_AT);
});

test('quarantines an exact-resource mismatch and exposes the item-scoped reason', async () => {
  const fixture = sourceFixture();
  const mismatched = Object.freeze({ ...fixture.resource, brandSha256: 'a'.repeat(64) });
  const subject = harness({ resource: mismatched });
  const result = await subject.coordinator.sync(CONTEXT);

  assert.equal(result.state, 'attention');
  assert.equal(result.counts.blockedItems, 1);
  assert.equal(subject.created.length, 0);
  assert.equal(result.blockers[0]?.code, 'exact_resource_mismatch');
  assert.equal(result.blockers[0]?.itemRef, 'generated:evidence-beats-noise');
  assert.equal(result.lastSuccessAt, null);
  assert.equal(result.sourceFresh, false);
});

test('stops before source bytes or persistence when exact review dimensions are incomplete', async () => {
  const subject = harness({ reviewIncomplete: true });
  const result = await subject.coordinator.sync(CONTEXT);
  assert.equal(result.state, 'attention');
  assert.equal(result.blockers[0]?.code, 'quarantine_review_incomplete');
  assert.equal(result.counts.reviewIncompleteItems, 1);
  assert.equal(result.counts.importedVersions, 0);
  assert.equal(result.counts.unchangedVersions, 0);
  assert.equal(subject.resourceCalls, 0);
  assert.equal(subject.created.length, 0);
  assert.equal(result.lastSuccessAt, CHECKED_AT);
});

test('duplicate review dimensions cannot substitute for exact review coverage', async () => {
  const subject = harness({ duplicateReviewDimension: true });
  const result = await subject.coordinator.sync(CONTEXT);
  assert.equal(result.state, 'attention');
  assert.equal(result.blockers[0]?.code, 'quarantine_review_incomplete');
  assert.equal(result.counts.reviewIncompleteItems, 1);
  assert.equal(result.counts.unchangedVersions, 0);
  assert.equal(subject.resourceCalls, 0);
  assert.equal(subject.created.length, 0);
});

test('a wrong local release projection is blocked and never counted as unchanged', async () => {
  const subject = harness({ wrongLocalProjection: true });
  const result = await subject.coordinator.sync(CONTEXT);
  assert.equal(result.state, 'attention');
  assert.equal(result.blockers[0]?.code, 'source_import_incomplete');
  assert.equal(result.counts.blockedItems, 1);
  assert.equal(result.counts.unchangedVersions, 0);
  assert.equal(subject.resourceCalls, 0);
  assert.equal(subject.created.length, 0);
  assert.equal(result.lastSuccessAt, null);
});

test('classifies local persistence failures separately and does not record a safe completion', async () => {
  const subject = harness({ contentWriteError: new Error('database unavailable') });
  const result = await subject.coordinator.sync(CONTEXT);
  assert.equal(result.state, 'attention');
  assert.equal(result.blockers[0]?.code, 'local_write_failed');
  assert.equal(result.blockers[0]?.retryable, true);
  assert.equal(result.lastSuccessAt, null);
  assert.equal(result.sourceFresh, false);
  assert.equal(result.canRetry, false);
});

test('backs off a source failure and does not contact it again before retry time', async () => {
  const subject = harness({ bridgeError: new Error('secret provider detail') });
  const first = await subject.coordinator.sync(CONTEXT);
  const blocked = await subject.coordinator.sync(CONTEXT);

  assert.equal(first.state, 'retry_wait');
  assert.equal(first.blockers[0]?.code, 'source_unavailable');
  assert.equal(first.blockers[0]?.message.includes('secret provider detail'), false);
  assert.equal(first.canRetry, false);
  assert.equal(blocked.nextRetryAt, first.nextRetryAt);
  assert.equal(subject.bridgeCalls, 1);
  subject.advance(5_001);
  await subject.coordinator.sync(CONTEXT);
  assert.equal(subject.bridgeCalls, 2);
});

test('rejects any source dependency that exposes an external-effect-shaped method', () => {
  const base = harness();
  assert.throws(() => new PropertyPredatorContentSyncCoordinator({
    bridge: Object.assign({ loadRelease: async () => base.fixture.release }, { publish() {} }),
    catalog: { catalog: async () => base.fixture.catalog },
    resources: {
      loadVersion: async () => base.fixture.resource,
      loadAsset: async () => { throw new Error('not used'); },
    },
    content: {
      createVersion: async () => { throw new Error('not used'); },
      refreshSourceAttestation: async () => { throw new Error('not used'); },
      listCatalog: async () => ({ items: [], nextCursor: null }),
    },
    assets: {
      stageRelease: async () => { throw new Error('not used'); },
      listItems: async () => ({ items: [], hasMore: false }),
    },
    brandBrain: { stageInventory: async () => { throw new Error('not used'); } },
  }), /forbidden effect method/);
});

test('coalesces concurrent operator retries into one source transaction', async () => {
  const subject = harness();
  const [first, second] = await Promise.all([
    subject.coordinator.sync(CONTEXT),
    subject.coordinator.sync(CONTEXT),
  ]);
  assert.strictEqual(first, second);
  assert.equal(subject.bridgeCalls, 1);
  assert.equal(subject.stageCalls, 2);
  assert.equal(subject.created.length, 1);
});

test('an expired process proof becomes attention with an explicit retry reason', async () => {
  const subject = harness();
  await subject.coordinator.sync(CONTEXT);
  subject.advance(10 * 60_000 + 1);
  const snapshot = subject.coordinator.snapshot(CONTEXT);
  assert.equal(snapshot.state, 'attention');
  assert.equal(snapshot.sourceFresh, false);
  assert.equal(snapshot.blockers.at(-1)?.code, 'source_proof_expired');
  assert.equal(snapshot.canRetry, true);
});
