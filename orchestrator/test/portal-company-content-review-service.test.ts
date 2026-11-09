import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { CompanyAssetItemSummary } from '../src/company-asset-pg/types.js';
import type { PropertyPredatorCompanyContentItem } from '../src/company-content-adapter/property-predator.js';
import { PropertyPredatorContentContractError } from '../src/company-content-adapter/property-predator.js';
import type { PropertyPredatorApprovedVersionResource } from '../src/company-content-adapter/property-predator-resources.js';
import { canonicalCompanyContentJson } from '../src/company-content-pg/validation.js';
import {
  COMPANY_CONTENT_REVIEW_STAGED_ITEM_SQL,
  PgPortalCompanyContentReviewService,
  type PortalCompanyContentReviewDependencies,
} from '../src/portal/company-content-review-pg-service.js';
import {
  PROPERTY_PREDATOR_GROWTH_PROFILE,
  RELAUNCH72_PRODUCT_PROFILE,
} from '../src/portal/product-profile.js';
import { buildPostgresPortalDeps } from '../src/portal/provision.js';
import type { PortalCompanyContentReviewService } from '../src/portal/company-content-review-service.js';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const USER_ID = '10000000-0000-4000-8000-000000000002';
const RELEASE_ITEM_ID = '10000000-0000-4000-8000-000000000003';
const RELEASE_ID = '10000000-0000-4000-8000-000000000004';
const VERSION_ID = '10000000-0000-4000-8000-000000000005';
const APPROVAL_ID = '10000000-0000-4000-8000-000000000006';
const BRAND_SHA = 'b'.repeat(64);

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function mediaFixture() {
  const payload = Object.freeze({
    active: true,
    body: 'Find the evidence before you make the offer.',
    category: 'Social posts',
    kind: 'text',
    schema: 'propertypredator.company-content/v1',
    title: 'Evidence before emotion',
    type: 'media',
  });
  const canonicalContent = canonicalCompanyContentJson(payload);
  const contentSha256 = digest(canonicalContent);
  const staged: CompanyAssetItemSummary = Object.freeze({
    releaseItemId: RELEASE_ITEM_ID,
    sourceReleaseId: RELEASE_ID,
    itemOrdinal: 1,
    itemType: 'media',
    itemId: 'media:evidence-before-emotion',
    itemVersion: 3,
    versionId: VERSION_ID,
    contentSha256,
    blobSha256: null,
    brandSha256: BRAND_SHA,
    approvalId: APPROVAL_ID,
    approvedAt: '2026-08-27T10:00:00.000Z',
    approvalExpiryStatus: 'missing',
    contentMode: 'company-owned',
    hqUseStatus: 'review-required',
    ownershipStatus: 'source-asserted-company-owned',
    privacyStatus: 'customer-private-data-forbidden',
    sourceQuarantineStatus: 'not-recorded-at-source',
    sourceApprovalStatus: 'source-approved-exact-version',
    decisions: Object.freeze([]),
    recordedAt: '2026-08-27T10:01:00.000Z',
  });
  const catalog: PropertyPredatorCompanyContentItem = Object.freeze({
    approvalId: APPROVAL_ID,
    approvedAt: staged.approvedAt,
    blobSha256: null,
    brandSha256: BRAND_SHA,
    contentSha256,
    itemId: staged.itemId,
    itemType: 'media',
    itemVersion: staged.itemVersion,
    payload,
    versionId: VERSION_ID,
    assetFilePath: null,
  });
  const resource: PropertyPredatorApprovedVersionResource = Object.freeze({
    versionId: VERSION_ID,
    itemId: staged.itemId,
    itemType: 'media',
    itemVersion: staged.itemVersion,
    approvalId: APPROVAL_ID,
    approvedAt: staged.approvedAt,
    contentSha256,
    blobSha256: null,
    brandSha256: BRAND_SHA,
    payload,
    canonicalContent,
    assetResourcePath: null,
  });
  return { staged, catalog, resource };
}

function dependencies(
  fixture = mediaFixture(),
  changes: Partial<PortalCompanyContentReviewDependencies> = {},
): PortalCompanyContentReviewDependencies {
  return {
    principalResolver: { resolve: async () => ({ userId: USER_ID, workspaceId: WORKSPACE_ID }) },
    accessReader: { load: async () => ({
      workspaceId: WORKSPACE_ID,
      workspaceName: 'Property Predator Growth HQ',
      snapshotAt: '2026-08-27T10:02:00.000Z',
      canManage: true,
    }) },
    stagedItems: { load: async () => fixture.staged },
    catalog: { catalog: async () => ({
      schemaVersion: 1,
      brandSha256: BRAND_SHA,
      catalogSha256: 'c'.repeat(64),
      generatedAt: '2026-08-27T10:00:30.000Z',
      itemCount: 1,
      items: Object.freeze([fixture.catalog]),
    }) },
    resources: {
      loadVersion: async () => fixture.resource,
      loadAsset: async () => { throw new Error('not an asset'); },
    },
    ...changes,
  };
}

test('exact review requires staged tuple, validated catalog and exact resource to agree', async () => {
  const service = new PgPortalCompanyContentReviewService(dependencies());
  const outcome = await service.review({ sessionToken: 'opaque', requestId: 'review-1' }, RELEASE_ITEM_ID);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.snapshot.exactContent.canonicalContent,
    canonicalCompanyContentJson(mediaFixture().catalog.payload));
  assert.deepEqual(outcome.snapshot.exactContent.payload, {
    title: 'Evidence before emotion',
    body: 'Find the evidence before you make the offer.',
    category: 'Social posts',
    kind: 'text',
  });
  assert.deepEqual(outcome.snapshot.item.pendingDimensions,
    ['visual_policy', 'claim', 'asset']);
  assert.equal(outcome.snapshot.item.sourceApproval.meaning, 'source_provenance_only');
  assert.equal(outcome.snapshot.item.hqUseStatus, 'review_required');
  assert.equal(outcome.snapshot.safety.providerEffects, false);
  assert.equal('publish' in service, false);
  assert.equal('decide' in service, false);
});

test('catalog validation failure closes review before exact resources are read', async () => {
  let resourceCalled = false;
  const service = new PgPortalCompanyContentReviewService(dependencies(mediaFixture(), {
    catalog: { catalog: async () => {
      throw new PropertyPredatorContentContractError(
        'item.payload contains customer-private data or personalisation fields',
      );
    } },
    resources: {
      loadVersion: async () => {
        resourceCalled = true;
        return mediaFixture().resource;
      },
      loadAsset: async () => { throw new Error('not used'); },
    },
  }));
  const outcome = await service.review({ sessionToken: 'opaque', requestId: 'review-private' }, RELEASE_ITEM_ID);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.kind, 'source_mismatch');
  assert.equal(resourceCalled, false);
});

test('duplicate catalog version identities fail closed before exact resources are read', async () => {
  const fixture = mediaFixture();
  let resourceCalled = false;
  const service = new PgPortalCompanyContentReviewService(dependencies(fixture, {
    catalog: { catalog: async () => ({
      schemaVersion: 1,
      brandSha256: BRAND_SHA,
      catalogSha256: 'c'.repeat(64),
      generatedAt: '2026-08-27T10:00:30.000Z',
      itemCount: 2,
      items: Object.freeze([
        fixture.catalog,
        Object.freeze({
          ...fixture.catalog,
          itemId: 'media:ambiguous-version-identity',
          itemVersion: fixture.catalog.itemVersion + 1,
        }),
      ]),
    }) },
    resources: {
      loadVersion: async () => {
        resourceCalled = true;
        return fixture.resource;
      },
      loadAsset: async () => { throw new Error('not used'); },
    },
  }));

  const outcome = await service.review(
    { sessionToken: 'opaque', requestId: 'review-ambiguous-version' },
    RELEASE_ITEM_ID,
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.kind, 'source_mismatch');
  assert.equal(resourceCalled, false);
});

test('asset DTO hides filename and internal path while file bytes remain exact', async () => {
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const blobSha256 = digest(bytes);
  const payload = Object.freeze({
    active: true,
    blob_sha256: blobSha256,
    bytes: bytes.byteLength,
    caption: 'A clean evidence-led campaign card.',
    category: 'Campaign artwork',
    filename: 'do-not-expose.png',
    media_type: 'image/png',
    schema: 'propertypredator.company-content/v1',
    title: 'Evidence card',
    type: 'asset',
  });
  const canonicalContent = canonicalCompanyContentJson(payload);
  const base = mediaFixture();
  const staged: CompanyAssetItemSummary = Object.freeze({
    ...base.staged,
    itemType: 'asset',
    itemId: 'asset:evidence-card',
    contentSha256: digest(canonicalContent),
    blobSha256,
  });
  const catalog: PropertyPredatorCompanyContentItem = Object.freeze({
    ...base.catalog,
    itemType: 'asset',
    itemId: staged.itemId,
    contentSha256: staged.contentSha256,
    blobSha256,
    payload,
    assetFilePath: `/api/internal/company-content/assets/${VERSION_ID}/file`,
  });
  const resource: PropertyPredatorApprovedVersionResource = Object.freeze({
    ...base.resource,
    itemType: 'asset',
    itemId: staged.itemId,
    contentSha256: staged.contentSha256,
    blobSha256,
    payload,
    canonicalContent,
    assetResourcePath: `/api/internal/company-content/assets/${VERSION_ID}/file`,
  });
  const fixture = { staged, catalog, resource };
  const service = new PgPortalCompanyContentReviewService(dependencies(fixture, {
    resources: {
      loadVersion: async () => resource,
      loadAsset: async () => ({ versionId: VERSION_ID, mediaType: 'image/png', sha256: blobSha256, bytes }),
    },
  }));
  const review = await service.review({ sessionToken: 'opaque', requestId: 'review-asset' }, RELEASE_ITEM_ID);
  assert.equal(review.ok, true);
  if (!review.ok) return;
  assert.equal(review.snapshot.exactContent.canonicalContent, null);
  const serialized = JSON.stringify(review.snapshot);
  assert.doesNotMatch(serialized, /do-not-expose|assetFilePath|\/api\/internal|filename|storage/i);
  assert.equal(review.snapshot.artwork?.verification, 'verified_at_response_boundary');

  const file = await service.artwork({ sessionToken: 'opaque', requestId: 'review-file' }, RELEASE_ITEM_ID);
  assert.equal(file.ok, true);
  if (!file.ok) return;
  assert.equal(file.mediaType, 'image/png');
  assert.equal(file.sha256, blobSha256);
  assert.deepEqual(file.bytes, bytes);
});

test('adapter staged-item SQL is exact, RLS-scoped and excludes resource/storage paths', () => {
  assert.match(COMPANY_CONTENT_REVIEW_STAGED_ITEM_SQL, /app_private\.current_workspace_id\(\)/);
  assert.match(COMPANY_CONTENT_REVIEW_STAGED_ITEM_SQL, /item\.id = \$1::uuid/);
  assert.doesNotMatch(COMPANY_CONTENT_REVIEW_STAGED_ITEM_SQL,
    /content_resource_path|asset_resource_path|blob_storage_key|content_body/i);
});

test('portal composition mounts exact review only on the Property Predator profile', () => {
  const review: PortalCompanyContentReviewService = {
    review: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
    artwork: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  };
  const common = {
    sessionSecret: 'company-content-review-session-secret',
    secure: false,
    auth: {},
    crm: {},
    companyContentReview: review,
    abuse: {
      admit: async () => ({ allowed: true, retryAfterSeconds: 0, leaseHash: null }),
      complete: async () => undefined,
    },
    requestContext: () => null,
    abuseHashSecret: 'company-content-review-abuse-secret-distinct',
  };
  assert.throws(() => buildPostgresPortalDeps({
    ...common,
    productProfile: RELAUNCH72_PRODUCT_PROFILE,
  } as never), /forbidden outside property_predator_growth/);
  const exact = buildPostgresPortalDeps({
    ...common,
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
  } as never);
  assert.equal(exact.companyContentReview, review);
  assert.deepEqual(Object.keys(review), ['review', 'artwork']);
});
