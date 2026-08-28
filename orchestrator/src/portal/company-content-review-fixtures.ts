import { createHash } from 'node:crypto';
import { canonicalCompanyContentJson } from '../company-content-pg/validation.js';
import type { CompanyAssetItemDecisionSummary } from '../company-asset-pg/types.js';
import { createPropertyPredatorCompanyAssetsFixture } from './company-assets-fixtures.js';
import type { PortalCompanyAssetsSnapshot } from './company-assets-service.js';
import {
  COMPANY_CONTENT_REVIEW_ROUTE_PREFIX,
  type PortalCompanyContentReviewSnapshot,
} from './company-content-review-service.js';

export const PROPERTY_PREDATOR_REVIEW_FIXTURE_RELEASE_ITEM_ID =
  'a7200000-0000-4000-8000-000000000002';

const SOURCE_APPROVAL_ID = 'a7400000-0000-4000-8000-000000000002';
const SNAPSHOT_AT = '2026-08-27T11:15:00.000Z';

const SOURCE_PAYLOAD = Object.freeze({
  active: true,
  body: 'Most property decisions feel urgent because the evidence arrives in pieces.\n\nProperty Predator brings the deal, risks and next questions into one clear review—so the next move is deliberate, not rushed.\n\nSave this framework for the next opportunity you assess.',
  category: 'education',
  kind: 'text',
  schema: 'propertypredator.company-content/v1',
  title: 'Proof before pressure',
  type: 'media',
});

const CANONICAL_CONTENT = canonicalCompanyContentJson(SOURCE_PAYLOAD);
const CONTENT_SHA256 = createHash('sha256')
  .update(CANONICAL_CONTENT, 'utf8')
  .digest('hex');

const DECISIONS: readonly CompanyAssetItemDecisionSummary[] = Object.freeze([
  Object.freeze({
    dimension: 'visual_policy',
    outcome: 'clear',
    reasonCode: 'visual_policy_match',
    evidenceSha256: CONTENT_SHA256,
    recordedAt: '2026-08-27T11:05:00.000Z',
  }),
  Object.freeze({
    dimension: 'claim',
    outcome: 'clear',
    reasonCode: 'no_claims_present',
    evidenceSha256: CONTENT_SHA256,
    recordedAt: '2026-08-27T11:06:00.000Z',
  }),
]);

/**
 * Fictional local-preview item. It contains no person, address, customer record,
 * affiliate payload, prompt, credential, provider capability or writable action.
 */
export function createPropertyPredatorCompanyContentReviewFixture(): PortalCompanyContentReviewSnapshot {
  return Object.freeze({
    workspace: Object.freeze({
      workspaceId: 'a7000000-0000-4000-8000-000000000001',
      workspaceName: 'Property Predator Growth HQ',
      snapshotAt: SNAPSHOT_AT,
      canManage: true,
    }),
    item: Object.freeze({
      releaseItemId: PROPERTY_PREDATOR_REVIEW_FIXTURE_RELEASE_ITEM_ID,
      sourceReleaseId: 'a7100000-0000-4000-8000-000000000001',
      itemType: 'media',
      itemId: 'media:evidence-led-social-card',
      itemVersion: 4,
      sourceVersionId: 'a7300000-0000-4000-8000-000000000002',
      contentSha256: CONTENT_SHA256,
      blobSha256: null,
      brandSha256: 'b'.repeat(64),
      sourceApproval: Object.freeze({
        approvalId: SOURCE_APPROVAL_ID,
        approvedAt: '2026-08-27T09:10:00.000Z',
        meaning: 'source_provenance_only',
        expiresAt: null,
      }),
      hqUseStatus: 'review_required',
      decisions: DECISIONS,
      pendingDimensions: Object.freeze(['asset'] as const),
      quarantined: false,
    }),
    exactContent: Object.freeze({
      mediaType: 'application/json',
      canonicalContent: CANONICAL_CONTENT,
      payload: Object.freeze({
        body: SOURCE_PAYLOAD.body,
        category: SOURCE_PAYLOAD.category,
        kind: SOURCE_PAYLOAD.kind,
        title: SOURCE_PAYLOAD.title,
      }),
      verified: true,
    }),
    artwork: null,
    safety: Object.freeze({
      providerEffects: false,
      customerPrivateDataAccepted: false,
      affiliateContentAccepted: false,
      sourceApprovalPromotedToHqApproval: false,
    }),
  });
}

/**
 * Reuses the existing illustrative Company Assets page, replacing only its
 * matching media metadata with the exact fictional review tuple above.
 */
export function createPropertyPredatorCompanyAssetsReviewPreviewFixture(): PortalCompanyAssetsSnapshot {
  const source = createPropertyPredatorCompanyAssetsFixture();
  const review = createPropertyPredatorCompanyContentReviewFixture();
  const matched = source.itemPage.items.some((item) => (
    item.releaseItemId === review.item.releaseItemId
      && item.itemType === review.item.itemType
      && item.itemId === review.item.itemId
      && item.versionId === review.item.sourceVersionId
  ));
  if (!matched) throw new Error('Company-content review fixture lost its Company Assets identity');
  if (!source.selectedRelease) {
    throw new Error('Company-content review fixture lost its illustrative release');
  }

  const items = Object.freeze(source.itemPage.items.map((item) => (
    item.releaseItemId !== review.item.releaseItemId
      ? item
      : Object.freeze({
          ...item,
          itemVersion: review.item.itemVersion,
          contentSha256: review.item.contentSha256,
          blobSha256: review.item.blobSha256,
          brandSha256: review.item.brandSha256,
          approvalId: review.item.sourceApproval.approvalId,
          approvedAt: review.item.sourceApproval.approvedAt,
          decisions: review.item.decisions,
        })
  )));
  const selectedRelease = Object.freeze({
    ...source.selectedRelease,
    quarantined: false,
    latestUsable: false,
    latestGuardReasonCodes: Object.freeze(['quarantine_decision_missing']),
  });
  const releases = Object.freeze(source.releases.map((release) => (
    release.sourceReleaseId === selectedRelease.sourceReleaseId
      ? selectedRelease
      : release
  )));

  return Object.freeze({
    ...source,
    releases,
    selectedRelease,
    itemPage: Object.freeze({
      ...source.itemPage,
      items,
    }),
  });
}

export function createPropertyPredatorCompanyContentReviewHrefs(): Readonly<Record<string, string>> {
  return Object.freeze({
    [PROPERTY_PREDATOR_REVIEW_FIXTURE_RELEASE_ITEM_ID]:
      `${COMPANY_CONTENT_REVIEW_ROUTE_PREFIX}/${PROPERTY_PREDATOR_REVIEW_FIXTURE_RELEASE_ITEM_ID}`,
  });
}
