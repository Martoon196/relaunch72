import type {
  CompanyAssetItemDecisionSummary,
  CompanyAssetItemSummary,
  CompanyAssetReleaseSummary,
} from '../company-asset-pg/types.js';
import type { PortalCompanyAssetsSnapshot } from './company-assets-service.js';

const RELEASE_ID = 'a7100000-0000-4000-8000-000000000001';
const SNAPSHOT_AT = '2026-08-27T11:15:00.000Z';

function decision(
  dimension: CompanyAssetItemDecisionSummary['dimension'],
  outcome: CompanyAssetItemDecisionSummary['outcome'],
  reasonCode: CompanyAssetItemDecisionSummary['reasonCode'],
  evidence: string,
): CompanyAssetItemDecisionSummary {
  return Object.freeze({
    dimension,
    outcome,
    reasonCode,
    evidenceSha256: evidence.repeat(64),
    recordedAt: '2026-08-27T11:05:00.000Z',
  });
}

function item(input: Readonly<{
  ordinal: number;
  releaseItemId: string;
  itemType: CompanyAssetItemSummary['itemType'];
  itemId: string;
  versionId: string;
  content: string;
  blob?: string;
  decisions?: readonly CompanyAssetItemDecisionSummary[];
}>): CompanyAssetItemSummary {
  return Object.freeze({
    releaseItemId: input.releaseItemId,
    sourceReleaseId: RELEASE_ID,
    itemOrdinal: input.ordinal,
    itemType: input.itemType,
    itemId: input.itemId,
    itemVersion: input.ordinal + 2,
    versionId: input.versionId,
    contentSha256: input.content.repeat(64),
    blobSha256: input.blob?.repeat(64) ?? null,
    brandSha256: 'b'.repeat(64),
    approvalId: `source-approval-${input.ordinal}`,
    approvedAt: '2026-08-27T09:10:00.000Z',
    approvalExpiryStatus: 'missing',
    contentMode: 'company-owned',
    hqUseStatus: 'review-required',
    ownershipStatus: 'source-asserted-company-owned',
    privacyStatus: 'customer-private-data-forbidden',
    sourceQuarantineStatus: 'not-recorded-at-source',
    sourceApprovalStatus: 'source-approved-exact-version',
    decisions: Object.freeze([...(input.decisions ?? [])]),
    recordedAt: '2026-08-27T10:45:00.000Z',
  });
}

const RELEASE: CompanyAssetReleaseSummary = Object.freeze({
  sourceReleaseId: RELEASE_ID,
  releaseSha256: '1'.repeat(64),
  sourceCatalogSha256: '2'.repeat(64),
  scopeSha256: '3'.repeat(64),
  runtimeBrandSha256: '4'.repeat(64),
  brandBrainPackageSha256: '5'.repeat(64),
  approvedItemCount: 3,
  sourceFresh: true,
  evaluationPassed: true,
  founderApproved: false,
  quarantineDecisionComplete: false,
  quarantined: true,
  latestUsable: false,
  latestUsabilityReasonCodes: Object.freeze([
    'source_approval_expiry_missing', 'source_quarantine_unknown',
  ]),
  latestGuardReasonCodes: Object.freeze([
    'quarantine_decision_missing', 'quarantine_decision_quarantined',
  ]),
  generationMode: 'simulated_draft_only',
  providerEffects: false,
  recordedAt: '2026-08-27T10:45:00.000Z',
});

const ITEMS: readonly CompanyAssetItemSummary[] = Object.freeze([
  item({
    ordinal: 1,
    releaseItemId: 'a7200000-0000-4000-8000-000000000001',
    itemType: 'asset',
    itemId: 'asset:legacy-panther-hero',
    versionId: 'a7300000-0000-4000-8000-000000000001',
    content: '6',
    blob: '7',
  }),
  item({
    ordinal: 2,
    releaseItemId: 'a7200000-0000-4000-8000-000000000002',
    itemType: 'media',
    itemId: 'media:evidence-led-social-card',
    versionId: 'a7300000-0000-4000-8000-000000000002',
    content: '8',
    decisions: Object.freeze([
      decision('visual_policy', 'clear', 'visual_policy_match', '9'),
      decision('claim', 'quarantined', 'claims_unsubstantiated', 'a'),
    ]),
  }),
  item({
    ordinal: 3,
    releaseItemId: 'a7200000-0000-4000-8000-000000000003',
    itemType: 'generated',
    itemId: 'generated:postcode-decision-brief',
    versionId: 'a7300000-0000-4000-8000-000000000003',
    content: 'c',
    decisions: Object.freeze([
      decision('asset', 'clear', 'no_asset_payload', 'd'),
    ]),
  }),
]);

/** Synthetic metadata-only preview; no body, artwork, prompt or private bytes. */
export function createPropertyPredatorCompanyAssetsFixture(): PortalCompanyAssetsSnapshot {
  return Object.freeze({
    workspace: Object.freeze({
      workspaceId: 'a7000000-0000-4000-8000-000000000001',
      workspaceName: 'Property Predator Growth HQ',
      snapshotAt: SNAPSHOT_AT,
      canManage: true,
    }),
    releases: Object.freeze([RELEASE]),
    selectedRelease: RELEASE,
    itemPage: Object.freeze({ items: ITEMS, hasMore: false }),
    dataset: 'illustrative_fixture',
    providerEffects: false,
    reviewRepresentationAvailable: false,
  });
}
