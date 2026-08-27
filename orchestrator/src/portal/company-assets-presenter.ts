import type {
  CompanyAssetItemDecisionSummary,
  CompanyAssetItemSummary,
  CompanyAssetQuarantineDimension,
  CompanyAssetReleaseSummary,
} from '../company-asset-pg/types.js';
import type { CompanyAssetsNoticeView } from './company-assets-actions.js';
import type {
  PortalCompanyAssetQuarantineReasonCode,
  PortalCompanyAssetsSnapshot,
} from './company-assets-service.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIMENSIONS: readonly CompanyAssetQuarantineDimension[] = Object.freeze([
  'visual_policy', 'claim', 'asset',
]);
const QUARANTINE_REASON_BY_DIMENSION: Readonly<Record<
  CompanyAssetQuarantineDimension,
  PortalCompanyAssetQuarantineReasonCode
>> = Object.freeze({
  visual_policy: 'visual_policy_conflict',
  claim: 'claims_unsubstantiated',
  asset: 'asset_integrity_failed',
});

export interface CompanyAssetDecisionView {
  readonly dimension: CompanyAssetQuarantineDimension;
  readonly dimensionLabel: string;
  readonly outcome: 'clear' | 'quarantined';
  readonly outcomeLabel: 'Clear recorded' | 'Quarantined';
  readonly reasonLabel: string;
  readonly evidenceSha256: string;
  readonly recordedAt: string;
}

export interface CompanyAssetQuarantineActionView {
  readonly dimension: CompanyAssetQuarantineDimension;
  readonly label: string;
  readonly reasonCode: PortalCompanyAssetQuarantineReasonCode;
  readonly evidenceSha256: string;
}

export interface CompanyAssetItemView {
  readonly anchorId: string;
  readonly releaseItemId: string;
  readonly sourceReleaseId: string;
  readonly itemType: CompanyAssetItemSummary['itemType'];
  readonly itemTypeLabel: string;
  readonly itemId: string;
  readonly itemLabel: string;
  readonly itemVersion: number;
  readonly versionId: string;
  readonly contentSha256: string;
  readonly blobSha256: string | null;
  readonly brandSha256: string;
  readonly approvalId: string;
  readonly approvedAt: string;
  readonly recordedAt: string;
  readonly sourceApprovalLabel: 'Exact source version approved';
  readonly ownershipLabel: 'Source asserted company owned';
  readonly privacyLabel: 'Customer-private data forbidden';
  readonly hqUseLabel: 'Review required';
  readonly decisions: readonly CompanyAssetDecisionView[];
  readonly decisionComplete: boolean;
  readonly quarantined: boolean;
  readonly quarantineActions: readonly CompanyAssetQuarantineActionView[];
}

export interface CompanyAssetsView {
  readonly workspaceName: string;
  readonly asOf: string;
  readonly datasetLabel: string;
  readonly illustrative: boolean;
  readonly release: null | Readonly<{
    sourceReleaseId: string;
    releaseSha256: string;
    sourceCatalogSha256: string;
    scopeSha256: string;
    runtimeBrandSha256: string;
    brandBrainPackageSha256: string;
    approvedItemCount: number;
    recordedAt: string;
    sourceFresh: boolean;
    evaluationPassed: boolean;
    founderApproved: boolean;
    quarantineDecisionComplete: boolean;
    quarantined: boolean;
    latestUsable: boolean;
    latestUsabilityReasonCodes: readonly string[];
    latestGuardReasonCodes: readonly string[];
  }>;
  readonly items: readonly CompanyAssetItemView[];
  readonly metrics: Readonly<{
    loadedItems: number;
    assetItems: number;
    recordedDecisions: number;
    quarantinedItems: number;
    unresolvedDimensions: number;
  }>;
  readonly canManage: boolean;
  readonly canQuarantine: boolean;
  readonly clearLocked: true;
  readonly approvalLocked: true;
  readonly providerEffectsOff: true;
  readonly inputTruncated: boolean;
  readonly notice?: CompanyAssetsNoticeView;
}

export interface PresentCompanyAssetsOptions {
  readonly notice?: CompanyAssetsNoticeView;
}

export class CompanyAssetsPresentationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanyAssetsPresentationError';
  }
}

function boundedText(value: unknown, fallback: string, maximum = 240): string {
  if (typeof value !== 'string') return fallback;
  const text = value.trim().replace(/[\u0000-\u001f\u007f]/gu, ' ');
  return [...text].slice(0, maximum).join('') || fallback;
}

function exactUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new CompanyAssetsPresentationError(`${label} is invalid`);
  }
  return value.toLowerCase();
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new CompanyAssetsPresentationError(`${label} is invalid`);
  }
  return value;
}

function safeInstant(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new CompanyAssetsPresentationError(`${label} is invalid`);
  }
  return new Date(value).toISOString();
}

function safeCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new CompanyAssetsPresentationError(`${label} is invalid`);
  }
  return value;
}

function label(value: string): string {
  return value
    .replace(/^[^:]+:/u, '')
    .replace(/[._:-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^./u, (character) => character.toLocaleUpperCase('en-GB'));
}

function dimensionLabel(dimension: CompanyAssetQuarantineDimension): string {
  if (dimension === 'visual_policy') return 'Visual policy';
  if (dimension === 'claim') return 'Claims';
  return 'Asset integrity';
}

function reasonLabel(reasonCode: string): string {
  return label(reasonCode);
}

function decisionView(decision: CompanyAssetItemDecisionSummary): CompanyAssetDecisionView {
  if (!DIMENSIONS.includes(decision.dimension)
      || (decision.outcome !== 'clear' && decision.outcome !== 'quarantined')) {
    throw new CompanyAssetsPresentationError('Asset decision crossed its allowlist');
  }
  const validReason = decision.dimension === 'visual_policy'
    ? decision.outcome === 'clear'
      ? decision.reasonCode === 'visual_policy_match'
      : decision.reasonCode === 'visual_policy_conflict'
    : decision.dimension === 'claim'
      ? decision.outcome === 'clear'
        ? decision.reasonCode === 'claims_supported' || decision.reasonCode === 'no_claims_present'
        : decision.reasonCode === 'claims_unsubstantiated'
      : decision.outcome === 'clear'
        ? decision.reasonCode === 'asset_integrity_verified'
          || decision.reasonCode === 'no_asset_payload'
        : decision.reasonCode === 'asset_integrity_failed';
  if (!validReason) {
    throw new CompanyAssetsPresentationError('Asset decision reason is inconsistent');
  }
  return Object.freeze({
    dimension: decision.dimension,
    dimensionLabel: dimensionLabel(decision.dimension),
    outcome: decision.outcome,
    outcomeLabel: decision.outcome === 'quarantined' ? 'Quarantined' : 'Clear recorded',
    reasonLabel: reasonLabel(decision.reasonCode),
    evidenceSha256: exactSha(decision.evidenceSha256, 'decision evidence SHA-256'),
    recordedAt: safeInstant(decision.recordedAt, 'decision recordedAt'),
  });
}

function itemView(item: CompanyAssetItemSummary, index: number): CompanyAssetItemView {
  const ordinal = safeCount(item.itemOrdinal, 'itemOrdinal');
  if (!SAFE_ITEM_ID.test(item.itemId)
      || ordinal < 1
      || !['asset', 'generated', 'media'].includes(item.itemType)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(item.versionId)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item.approvalId)
      || item.approvalExpiryStatus !== 'missing'
      || item.contentMode !== 'company-owned'
      || item.hqUseStatus !== 'review-required'
      || item.ownershipStatus !== 'source-asserted-company-owned'
      || item.privacyStatus !== 'customer-private-data-forbidden'
      || item.sourceQuarantineStatus !== 'not-recorded-at-source'
      || item.sourceApprovalStatus !== 'source-approved-exact-version') {
    throw new CompanyAssetsPresentationError('Asset item crossed the sealed metadata boundary');
  }
  const decisions = Object.freeze(item.decisions.slice(0, 3).map(decisionView));
  if (decisions.length !== item.decisions.length
      || new Set(decisions.map((decision) => decision.dimension)).size !== decisions.length) {
    throw new CompanyAssetsPresentationError('Asset item decisions are invalid');
  }
  if (item.decisions.some((entry) => entry.dimension === 'asset'
      && ((item.itemType === 'asset' && entry.reasonCode === 'no_asset_payload')
        || (item.itemType !== 'asset' && entry.reasonCode !== 'no_asset_payload')))) {
    throw new CompanyAssetsPresentationError('Asset integrity decision does not match item type');
  }
  const decidedDimensions = new Set(decisions.map((decision) => decision.dimension));
  const actions = DIMENSIONS
    .filter((dimension) => !decidedDimensions.has(dimension))
    .filter((dimension) => dimension !== 'asset' || item.itemType === 'asset')
    .map((dimension): CompanyAssetQuarantineActionView => Object.freeze({
      dimension,
      label: dimension === 'visual_policy'
        ? 'Quarantine visual conflict'
        : dimension === 'claim'
          ? 'Quarantine unsupported claim'
          : 'Quarantine failed asset integrity',
      reasonCode: QUARANTINE_REASON_BY_DIMENSION[dimension],
      evidenceSha256: exactSha(item.contentSha256, 'content SHA-256'),
    }));
  return Object.freeze({
    anchorId: `company-asset-${index + 1}`,
    releaseItemId: exactUuid(item.releaseItemId, 'releaseItemId'),
    sourceReleaseId: exactUuid(item.sourceReleaseId, 'sourceReleaseId'),
    itemType: item.itemType,
    itemTypeLabel: label(item.itemType),
    itemId: item.itemId,
    itemLabel: label(item.itemId) || 'Company asset',
    itemVersion: (() => {
      const version = safeCount(item.itemVersion, 'itemVersion');
      if (version < 1) throw new CompanyAssetsPresentationError('itemVersion is invalid');
      return version;
    })(),
    versionId: boundedText(item.versionId, 'version-unavailable', 100),
    contentSha256: exactSha(item.contentSha256, 'content SHA-256'),
    blobSha256: item.blobSha256 === null ? null : exactSha(item.blobSha256, 'blob SHA-256'),
    brandSha256: exactSha(item.brandSha256, 'brand SHA-256'),
    approvalId: boundedText(item.approvalId, 'approval-unavailable', 128),
    approvedAt: safeInstant(item.approvedAt, 'approvedAt'),
    recordedAt: safeInstant(item.recordedAt, 'item recordedAt'),
    sourceApprovalLabel: 'Exact source version approved',
    ownershipLabel: 'Source asserted company owned',
    privacyLabel: 'Customer-private data forbidden',
    hqUseLabel: 'Review required',
    decisions,
    decisionComplete: decidedDimensions.size === 3,
    quarantined: decisions.some((decision) => decision.outcome === 'quarantined'),
    quarantineActions: Object.freeze(actions),
  });
}

function reasonCodes(value: unknown, labelText: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 50
      || value.some((entry) => typeof entry !== 'string')) {
    throw new CompanyAssetsPresentationError(`${labelText} is invalid`);
  }
  return Object.freeze(value.map((entry) => boundedText(entry, 'unavailable', 120)));
}

function releaseView(release: CompanyAssetReleaseSummary): NonNullable<CompanyAssetsView['release']> {
  if (release.providerEffects !== false || release.generationMode !== 'simulated_draft_only') {
    throw new CompanyAssetsPresentationError('Company asset release crossed the effects-off boundary');
  }
  if ([release.sourceFresh, release.evaluationPassed, release.founderApproved,
    release.quarantineDecisionComplete, release.quarantined, release.latestUsable]
    .some((value) => typeof value !== 'boolean')) {
    throw new CompanyAssetsPresentationError('Company asset release gates are invalid');
  }
  return Object.freeze({
    sourceReleaseId: exactUuid(release.sourceReleaseId, 'sourceReleaseId'),
    releaseSha256: exactSha(release.releaseSha256, 'release SHA-256'),
    sourceCatalogSha256: exactSha(release.sourceCatalogSha256, 'catalog SHA-256'),
    scopeSha256: exactSha(release.scopeSha256, 'scope SHA-256'),
    runtimeBrandSha256: exactSha(release.runtimeBrandSha256, 'runtime brand SHA-256'),
    brandBrainPackageSha256: exactSha(
      release.brandBrainPackageSha256,
      'Brand Brain package SHA-256',
    ),
    approvedItemCount: safeCount(release.approvedItemCount, 'approvedItemCount'),
    recordedAt: safeInstant(release.recordedAt, 'release recordedAt'),
    sourceFresh: release.sourceFresh === true,
    evaluationPassed: release.evaluationPassed === true,
    founderApproved: release.founderApproved === true,
    quarantineDecisionComplete: release.quarantineDecisionComplete === true,
    quarantined: release.quarantined === true,
    latestUsable: release.latestUsable === true,
    latestUsabilityReasonCodes: reasonCodes(
      release.latestUsabilityReasonCodes,
      'usability reason codes',
    ),
    latestGuardReasonCodes: reasonCodes(release.latestGuardReasonCodes, 'guard reason codes'),
  });
}

/** Allowlist presentation: unknown raw/private fields cannot reach the view model. */
export function presentCompanyAssets(
  snapshot: PortalCompanyAssetsSnapshot,
  options: PresentCompanyAssetsOptions = {},
): CompanyAssetsView {
  if ((snapshot.dataset !== 'illustrative_fixture'
      && snapshot.dataset !== 'postgres_authoritative')
      || snapshot.providerEffects !== false
      || snapshot.reviewRepresentationAvailable !== false
      || !snapshot.workspace
      || exactUuid(snapshot.workspace.workspaceId, 'workspaceId') !== snapshot.workspace.workspaceId.toLowerCase()
      || typeof snapshot.workspace.canManage !== 'boolean'
      || !snapshot.itemPage
      || !Array.isArray(snapshot.itemPage.items)
      || typeof snapshot.itemPage.hasMore !== 'boolean'
      || !Array.isArray(snapshot.releases)) {
    throw new CompanyAssetsPresentationError('Company assets crossed the metadata-only boundary');
  }
  const inputItems = snapshot.itemPage.items;
  const inputReleases = snapshot.releases;
  if (inputReleases.length > 10
      || inputReleases.some((candidate) => candidate.providerEffects !== false)) {
    throw new CompanyAssetsPresentationError('Company asset release page is invalid');
  }
  const items = Object.freeze(inputItems.slice(0, 50).map(itemView));
  const release = snapshot.selectedRelease ? releaseView(snapshot.selectedRelease) : null;
  const latestRelease = inputReleases[0] ?? null;
  if ((release === null) !== (latestRelease === null)
      || (release && latestRelease && (
        release.sourceReleaseId !== latestRelease.sourceReleaseId.toLowerCase()
        || release.releaseSha256 !== latestRelease.releaseSha256
        || release.scopeSha256 !== latestRelease.scopeSha256
      ))) {
    throw new CompanyAssetsPresentationError('Selected company asset release is not the latest page row');
  }
  if (!release && items.length > 0) {
    throw new CompanyAssetsPresentationError('Company asset items require an exact release');
  }
  if (release && items.some((item) => item.sourceReleaseId !== release.sourceReleaseId)) {
    throw new CompanyAssetsPresentationError('Company asset item belongs to another release');
  }
  const recordedDecisions = items.reduce((total, item) => total + item.decisions.length, 0);
  return Object.freeze({
    workspaceName: boundedText(
      snapshot.workspace.workspaceName,
      'Property Predator Growth HQ',
      200,
    ),
    asOf: safeInstant(snapshot.workspace.snapshotAt, 'workspace snapshotAt'),
    datasetLabel: snapshot.dataset === 'postgres_authoritative'
      ? 'Authoritative migration 0033 metadata'
      : 'Illustrative migration 0033 metadata fixture',
    illustrative: snapshot.dataset !== 'postgres_authoritative',
    release,
    items,
    metrics: Object.freeze({
      loadedItems: items.length,
      assetItems: items.filter((item) => item.itemType === 'asset').length,
      recordedDecisions,
      quarantinedItems: items.filter((item) => item.quarantined).length,
      unresolvedDimensions: items.reduce(
        (total, item) => total + (3 - item.decisions.length),
        0,
      ),
    }),
    canManage: snapshot.workspace.canManage === true,
    canQuarantine: snapshot.workspace.canManage === true
      && snapshot.dataset === 'postgres_authoritative',
    clearLocked: true,
    approvalLocked: true,
    providerEffectsOff: true,
    inputTruncated: inputItems.length > 50 || snapshot.itemPage.hasMore === true,
    ...(options.notice ? { notice: options.notice } : {}),
  });
}
