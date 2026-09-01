import { randomUUID } from 'node:crypto';
import type { DatabaseRequestContext } from '../db/rls.js';
import type {
  CompanyAssetItemSummary,
  CompanyAssetService,
} from '../company-asset-pg/index.js';
import type { BrandBrainService } from '../brand-brain-pg/index.js';
import type {
  CompanyContentCatalogCursor,
  CompanyContentCatalogItem,
  CompanyContentService,
  CreateCompanyContentVersionCommand,
} from '../company-content-pg/index.js';
import {
  canonicalCompanyContentJson,
  validateCompanyContentUserContext,
} from '../company-content-pg/validation.js';
import type {
  CompanyAssetRelease,
  PropertyPredatorCompanyAssetBridgeTransport,
} from '../company-asset-release/index.js';
import type {
  PropertyPredatorApprovedResourceTransport,
  PropertyPredatorApprovedVersionResource,
} from '../company-content-adapter/property-predator-resources.js';
import {
  propertyPredatorItemToVersionCommand,
  type PropertyPredatorCompanyContentAdapter,
  type PropertyPredatorCompanyContentCatalog,
  type PropertyPredatorCompanyContentItem,
} from '../company-content-adapter/property-predator.js';

const SOURCE_SYSTEM = 'propertypredator.company-content';
const MAX_SOURCE_ITEMS = 500;
const SOURCE_PROOF_MS = 10 * 60_000;
const MAX_RETRY_MS = 5 * 60_000;
// Both independently authenticated source components must describe the same
// observation. A catalogue older than five minutes is not safe to stage even
// though a successful local attestation may itself remain useful for ten.
const SOURCE_OBSERVATION_MAX_AGE_MS = 5 * 60_000;
const SOURCE_OBSERVATION_FUTURE_SKEW_MS = 30_000;

export type PropertyPredatorContentSyncState =
  | 'not_run'
  | 'running'
  | 'current'
  | 'attention'
  | 'retry_wait';

export type PropertyPredatorContentSyncBlockerCode =
  | 'source_sync_not_run'
  | 'source_proof_expired'
  | 'source_unavailable'
  | 'source_contract_invalid'
  | 'source_observation_invalid'
  | 'release_catalog_mismatch'
  | 'brand_brain_mismatch'
  | 'exact_resource_mismatch'
  | 'local_version_conflict'
  | 'local_write_failed'
  | 'source_item_quarantined'
  | 'quarantine_review_incomplete'
  | 'source_import_incomplete';

export interface PropertyPredatorContentSyncBlocker {
  readonly code: PropertyPredatorContentSyncBlockerCode;
  readonly itemRef: string | null;
  readonly message: string;
  readonly retryable: boolean;
}

export interface PropertyPredatorContentSyncStatus {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly state: PropertyPredatorContentSyncState;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly nextRetryAt: string | null;
  readonly sourceCheckedAt: string | null;
  readonly sourceExpiresAt: string | null;
  readonly sourceFresh: boolean;
  readonly sourceCatalogSha256: string | null;
  readonly sourceReleaseSha256: string | null;
  readonly brandBrainPackageSha256: string | null;
  readonly counts: Readonly<{
    sourceItems: number;
    importedVersions: number;
    refreshedAttestations: number;
    unchangedVersions: number;
    verifiedArtworkBytes: number;
    quarantinedItems: number;
    reviewIncompleteItems: number;
    blockedItems: number;
  }>;
  readonly blockers: readonly PropertyPredatorContentSyncBlocker[];
  readonly canRetry: boolean;
  readonly exactContentBytesPersisted: boolean;
  readonly artworkBytesCopied: false;
  readonly customerPrivateDataAccepted: false;
  readonly affiliateContentAccepted: false;
  readonly providerEffects: false;
}

type ContentService = Pick<
  CompanyContentService,
  'createVersion' | 'refreshSourceAttestation' | 'listCatalog'
>;
type AssetService = Pick<CompanyAssetService, 'stageRelease' | 'listItems'>;
type BrainService = Pick<BrandBrainService, 'stageInventory'>;

export interface PropertyPredatorContentSyncDependencies {
  readonly bridge: PropertyPredatorCompanyAssetBridgeTransport;
  readonly catalog: Pick<PropertyPredatorCompanyContentAdapter, 'catalog'>;
  readonly resources: PropertyPredatorApprovedResourceTransport;
  readonly content: ContentService;
  readonly assets: AssetService;
  readonly brandBrain: BrainService;
  readonly now?: () => Date;
  readonly nextRunId?: () => string;
}

interface MutableSyncState {
  state: PropertyPredatorContentSyncState;
  attemptCount: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextRetryAt: string | null;
  sourceCheckedAt: string | null;
  sourceExpiresAt: string | null;
  sourceCatalogSha256: string | null;
  sourceReleaseSha256: string | null;
  brandBrainPackageSha256: string | null;
  counts: PropertyPredatorContentSyncStatus['counts'];
  blockers: readonly PropertyPredatorContentSyncBlocker[];
}

function blocker(
  code: PropertyPredatorContentSyncBlockerCode,
  message: string,
  retryable: boolean,
  itemRef: string | null = null,
): PropertyPredatorContentSyncBlocker {
  return Object.freeze({ code, itemRef, message, retryable });
}

function emptyCounts(): PropertyPredatorContentSyncStatus['counts'] {
  return Object.freeze({
    sourceItems: 0,
    importedVersions: 0,
    refreshedAttestations: 0,
    unchangedVersions: 0,
    verifiedArtworkBytes: 0,
    quarantinedItems: 0,
    reviewIncompleteItems: 0,
    blockedItems: 0,
  });
}

function initialState(): MutableSyncState {
  return {
    state: 'not_run',
    attemptCount: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextRetryAt: null,
    sourceCheckedAt: null,
    sourceExpiresAt: null,
    sourceCatalogSha256: null,
    sourceReleaseSha256: null,
    brandBrainPackageSha256: null,
    counts: emptyCounts(),
    blockers: Object.freeze([
      blocker(
        'source_sync_not_run',
        'The owned Property Predator source has not been checked in this server process yet.',
        true,
      ),
    ]),
  };
}

function status(workspaceId: string, state: MutableSyncState, nowMs: number): PropertyPredatorContentSyncStatus {
  const sourceFresh = state.sourceExpiresAt !== null
    && Date.parse(state.sourceExpiresAt) > nowMs
    && state.lastSuccessAt !== null;
  const sourceExpired = state.lastSuccessAt !== null && !sourceFresh;
  const blockers = sourceExpired
    && !state.blockers.some((entry) => entry.code === 'source_proof_expired')
    ? Object.freeze([
        ...state.blockers,
        blocker(
          'source_proof_expired',
          'The last owned-source proof has expired. Run a new effects-off sync before relying on it.',
          true,
        ),
      ])
    : state.blockers;
  return Object.freeze({
    schemaVersion: 1,
    workspaceId,
    state: sourceExpired && state.state === 'current' ? 'attention' : state.state,
    lastAttemptAt: state.lastAttemptAt,
    lastSuccessAt: state.lastSuccessAt,
    nextRetryAt: state.nextRetryAt,
    sourceCheckedAt: state.sourceCheckedAt,
    sourceExpiresAt: state.sourceExpiresAt,
    sourceFresh,
    sourceCatalogSha256: state.sourceCatalogSha256,
    sourceReleaseSha256: state.sourceReleaseSha256,
    brandBrainPackageSha256: state.brandBrainPackageSha256,
    counts: state.counts,
    blockers,
    canRetry: state.state !== 'running'
      && (state.nextRetryAt === null || Date.parse(state.nextRetryAt) <= nowMs),
    exactContentBytesPersisted: state.counts.importedVersions > 0
      || state.counts.unchangedVersions > 0
      || state.counts.refreshedAttestations > 0,
    artworkBytesCopied: false,
    customerPrivateDataAccepted: false,
    affiliateContentAccepted: false,
    providerEffects: false,
  });
}

function releaseEnvelope(release: CompanyAssetRelease): unknown {
  const approvedItems = release.approvedItems.map((item) => Object.freeze({
    affiliateMode: item.affiliateMode,
    approvalExpiresAt: item.approvalExpiresAt,
    approvalExpiryStatus: item.approvalExpiryStatus,
    approvalId: item.approvalId,
    approvedAt: item.approvedAt,
    assetResourcePath: item.assetResourcePath,
    blobSha256: item.blobSha256,
    brandSha256: item.brandSha256,
    contentMode: item.contentMode,
    contentResourcePath: item.contentResourcePath,
    contentSha256: item.contentSha256,
    hqUseStatus: item.hqUseStatus,
    itemId: item.itemId,
    itemType: item.itemType,
    itemVersion: item.itemVersion,
    ownershipStatus: item.ownershipStatus,
    privacyStatus: item.privacyStatus,
    quarantineStatus: item.quarantineStatus,
    sourceApprovalStatus: item.sourceApprovalStatus,
    versionId: item.versionId,
  }));
  return Object.freeze({
    generatedAt: release.generatedAt,
    release: Object.freeze({
      approvedItemCount: release.approvedItemCount,
      approvedItems: Object.freeze(approvedItems),
      brandBrain: release.brandBrain,
      contract: release.contract,
      releaseId: release.releaseId,
      sourceCatalogSha256: release.sourceCatalogSha256,
      sourceSystem: release.sourceSystem,
    }),
    releaseSha256: release.releaseSha256,
    schemaVersion: 1,
  });
}

function exactItemIdentity(item: Pick<PropertyPredatorCompanyContentItem, 'itemType' | 'itemId'>): string {
  return `${item.itemType}:${item.itemId}`;
}

function resourceMatches(
  item: PropertyPredatorCompanyContentItem,
  resource: PropertyPredatorApprovedVersionResource,
): boolean {
  return resource.versionId === item.versionId
    && resource.itemId === item.itemId
    && resource.itemType === item.itemType
    && resource.itemVersion === item.itemVersion
    && resource.approvalId === item.approvalId
    && resource.approvedAt === item.approvedAt
    && resource.contentSha256 === item.contentSha256
    && resource.blobSha256 === item.blobSha256
    && resource.brandSha256 === item.brandSha256
    && resource.assetResourcePath === item.assetFilePath
    && resource.canonicalContent === canonicalCompanyContentJson(item.payload);
}

function assertCoherentRelease(
  release: CompanyAssetRelease,
  catalog: PropertyPredatorCompanyContentCatalog,
  observedAt: Date,
): void {
  const observedMs = observedAt.getTime();
  const catalogObservedMs = Date.parse(catalog.generatedAt);
  const releaseObservedMs = Date.parse(release.generatedAt);
  const observationIsInvalid = (sourceMs: number): boolean => (
    !Number.isFinite(sourceMs)
    || sourceMs > observedMs + SOURCE_OBSERVATION_FUTURE_SKEW_MS
    || observedMs - sourceMs > SOURCE_OBSERVATION_MAX_AGE_MS
  );
  // The bridge and catalogue are separate authenticated reads. Their source
  // timestamps will normally differ by a few milliseconds, so coherence must
  // be bound by the immutable catalogue hash and exact item tuples below—not
  // by impossible timestamp equality. Both observations still fail closed if
  // either is stale or future-dated.
  if (!Number.isFinite(observedMs)
      || observationIsInvalid(catalogObservedMs)
      || observationIsInvalid(releaseObservedMs)) {
    throw new Error('source_observation_invalid');
  }
  if (release.sourceCatalogSha256 !== catalog.catalogSha256
      || release.approvedItemCount !== catalog.itemCount) {
    throw new Error('release_catalog_mismatch');
  }
  if (release.scope.runtimeBrandSha256 !== catalog.brandSha256
      || release.brandBrain.runtimeBrandSha256 !== catalog.brandSha256
      || release.brandBrain.manifest.specialistProfiles.some(
        (profile) => profile.runtimeBrandSha256 !== catalog.brandSha256,
      )) {
    throw new Error('brand_brain_mismatch');
  }
  const releaseByVersion = new Map(release.approvedItems.map((item) => [item.versionId, item]));
  for (const item of catalog.items) {
    const source = releaseByVersion.get(item.versionId);
    if (!source
        || source.itemType !== item.itemType
        || source.itemId !== item.itemId
        || source.itemVersion !== item.itemVersion
        || source.approvalId !== item.approvalId
        || source.approvedAt !== item.approvedAt
        || source.contentSha256 !== item.contentSha256
        || source.blobSha256 !== item.blobSha256
        || source.brandSha256 !== item.brandSha256
        || source.assetResourcePath !== item.assetFilePath) {
      throw new Error('release_catalog_mismatch');
    }
  }
}

async function localCatalog(
  service: ContentService,
  context: DatabaseRequestContext,
): Promise<readonly CompanyContentCatalogItem[]> {
  const items: CompanyContentCatalogItem[] = [];
  let cursor: CompanyContentCatalogCursor | null = null;
  do {
    const page = await service.listCatalog(context, {
      limit: 100,
      cursor,
      sourceSystem: SOURCE_SYSTEM,
    });
    items.push(...page.items);
    if (items.length > MAX_SOURCE_ITEMS) throw new Error('source_import_incomplete');
    cursor = page.nextCursor;
  } while (cursor !== null);
  return Object.freeze(items);
}

function importedTupleMatches(
  local: CompanyContentCatalogItem,
  item: PropertyPredatorCompanyContentItem,
): boolean {
  return local.source.system === SOURCE_SYSTEM
    && local.source.itemId === exactItemIdentity(item)
    && local.source.version === String(item.itemVersion)
    && local.contentSha256 === item.contentSha256
    && local.blobSha256 === (item.blobSha256 ?? item.contentSha256)
    && local.brandSha256 === item.brandSha256;
}

function exactDecisionCoverage(
  item: PropertyPredatorCompanyContentItem,
  decision: CompanyAssetItemSummary,
  sourceReleaseId: string,
): boolean {
  if (decision.sourceReleaseId !== sourceReleaseId
      || decision.itemType !== item.itemType
      || decision.itemId !== item.itemId
      || decision.itemVersion !== item.itemVersion
      || decision.versionId !== item.versionId
      || decision.contentSha256 !== item.contentSha256
      || decision.blobSha256 !== item.blobSha256
      || decision.brandSha256 !== item.brandSha256
      || decision.approvalId !== item.approvalId
      || !Number.isFinite(Date.parse(decision.approvedAt))
      || Date.parse(decision.approvedAt) !== Date.parse(item.approvedAt)
      || decision.contentMode !== 'company-owned'
      || decision.hqUseStatus !== 'review-required'
      || decision.ownershipStatus !== 'source-asserted-company-owned'
      || decision.privacyStatus !== 'customer-private-data-forbidden'
      || decision.sourceQuarantineStatus !== 'not-recorded-at-source'
      || decision.sourceApprovalStatus !== 'source-approved-exact-version'
      || !Number.isFinite(Date.parse(decision.recordedAt))) {
    return false;
  }
  const required = item.itemType === 'asset'
    ? new Set(['visual_policy', 'claim', 'asset'])
    : new Set(['visual_policy', 'claim']);
  const clearReasons = new Map<string, ReadonlySet<string>>([
    ['visual_policy', new Set(['visual_policy_match'])],
    ['claim', new Set(['claims_supported', 'no_claims_present'])],
    ['asset', new Set(['asset_integrity_verified'])],
  ]);
  const observed = new Set<string>();
  for (const entry of decision.decisions) {
    if (!required.has(entry.dimension) || entry.outcome !== 'clear'
        || observed.has(entry.dimension)
        || !clearReasons.get(entry.dimension)?.has(entry.reasonCode)
        || !/^[a-f0-9]{64}$/u.test(entry.evidenceSha256)
        || !Number.isFinite(Date.parse(entry.recordedAt))
        || Date.parse(entry.recordedAt) < Date.parse(decision.recordedAt)) {
      return false;
    }
    observed.add(entry.dimension);
  }
  return observed.size === required.size;
}

function resourceFailure(error: unknown, itemRef: string): PropertyPredatorContentSyncBlocker {
  const unavailable = error instanceof Error
    && /request (?:failed closed|returned HTTP)|response stream failed closed/u.test(error.message);
  return blocker(
    unavailable ? 'source_unavailable' : 'exact_resource_mismatch',
    unavailable
      ? 'The exact source resource is temporarily unavailable and was not imported or refreshed.'
      : 'The exact source resource or artwork bytes did not match the approved catalogue.',
    unavailable,
    itemRef,
  );
}

function localWriteFailure(error: unknown, itemRef: string): PropertyPredatorContentSyncBlocker {
  const conflict = error instanceof Error
    && (error.name.includes('Conflict') || error.name.includes('NotFound')
      || error.message === 'local_version_conflict');
  return blocker(
    conflict ? 'local_version_conflict' : 'local_write_failed',
    conflict
      ? 'The same source revision is already stored with a different immutable tuple.'
      : 'The local immutable content write did not complete and may be retried safely.',
    !conflict,
    itemRef,
  );
}

class LocalContentSyncPersistenceError extends Error {
  constructor() {
    super('local_write_failed');
    this.name = 'LocalContentSyncPersistenceError';
  }
}

function enrichedCommand(
  catalog: PropertyPredatorCompanyContentCatalog,
  item: PropertyPredatorCompanyContentItem,
  commandKey: string,
  checkedAt: string,
  expiresAt: string,
  resource: PropertyPredatorApprovedVersionResource,
  local: CompanyContentCatalogItem | undefined,
  verifiedAsset: Readonly<{ byteLength: number; mediaType: string }> | null,
): CreateCompanyContentVersionCommand {
  const base = propertyPredatorItemToVersionCommand(
    catalog,
    item,
    commandKey,
    checkedAt,
    expiresAt,
  );
  return Object.freeze({
    ...base,
    ...(local ? {
      contentItemId: local.contentItemId,
      previousVersionId: local.contentVersionId,
    } : {}),
    content: resource.canonicalContent,
    metadata: Object.freeze({
      ...base.metadata,
      sourceResourceVersionId: resource.versionId,
      exactResourceVerified: true,
      assetBytesVerified: verifiedAsset !== null,
      ...(verifiedAsset ? {
        assetByteLength: verifiedAsset.byteLength,
        assetMediaType: verifiedAsset.mediaType,
      } : {}),
    }),
  });
}

/**
 * Authenticated, effects-off operator coordinator. Network transports are
 * source-read-only; every database write goes through r72_content_adapter's
 * existing RLS-scoped services. It never requests approval or calls a provider.
 */
export class PropertyPredatorContentSyncCoordinator {
  readonly #now: () => Date;
  readonly #nextRunId: () => string;
  readonly #states = new Map<string, MutableSyncState>();
  readonly #running = new Map<string, Promise<PropertyPredatorContentSyncStatus>>();

  constructor(private readonly dependencies: PropertyPredatorContentSyncDependencies) {
    this.#now = dependencies.now ?? (() => new Date());
    this.#nextRunId = dependencies.nextRunId ?? randomUUID;
    for (const surface of [dependencies.bridge, dependencies.catalog, dependencies.resources]) {
      if ('publish' in surface || 'send' in surface || 'schedule' in surface || 'generate' in surface) {
        throw new Error('Company-content sync source exposes a forbidden effect method');
      }
    }
  }

  snapshot(context: DatabaseRequestContext): PropertyPredatorContentSyncStatus {
    validateCompanyContentUserContext(context);
    const current = this.#states.get(context.workspaceId) ?? initialState();
    return status(context.workspaceId, current, this.#now().getTime());
  }

  async sync(context: DatabaseRequestContext): Promise<PropertyPredatorContentSyncStatus> {
    validateCompanyContentUserContext(context);
    const running = this.#running.get(context.workspaceId);
    if (running) return running;
    const current = this.#states.get(context.workspaceId) ?? initialState();
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) throw new Error('Company-content sync clock is invalid');
    if (current.nextRetryAt && Date.parse(current.nextRetryAt) > now.getTime()) {
      return status(context.workspaceId, current, now.getTime());
    }
    const operation = this.#run(context, current, now);
    this.#running.set(context.workspaceId, operation);
    try { return await operation; }
    finally { this.#running.delete(context.workspaceId); }
  }

  async #run(
    context: DatabaseRequestContext,
    previous: MutableSyncState,
    attemptTime: Date,
  ): Promise<PropertyPredatorContentSyncStatus> {
    const checkedAt = attemptTime.toISOString();
    const expiresAt = new Date(attemptTime.getTime() + SOURCE_PROOF_MS).toISOString();
    const runId = this.#nextRunId();
    const running: MutableSyncState = {
      ...previous,
      state: 'running',
      lastAttemptAt: checkedAt,
      nextRetryAt: null,
      blockers: Object.freeze([]),
    };
    this.#states.set(context.workspaceId, running);
    try {
      const [release, catalog] = await Promise.all([
        this.dependencies.bridge.loadRelease(),
        this.dependencies.catalog.catalog(),
      ]);
      // Freshness/coherence is proved before Brand Brain, asset staging or any
      // exact-resource/local-content operation can observe the source tuple.
      assertCoherentRelease(release, catalog, attemptTime);

      let staged: Awaited<ReturnType<AssetService['stageRelease']>>;
      let localItems: Awaited<ReturnType<AssetService['listItems']>>;
      let localContent: readonly CompanyContentCatalogItem[];
      try {
        await this.dependencies.brandBrain.stageInventory(context, {
          commandKey: `pp-sync:brain:${runId}`,
          inventory: release.brandBrain.manifest,
          checkedAt,
          expiresAt,
        });
        staged = await this.dependencies.assets.stageRelease(context, {
          commandKey: `pp-sync:assets:${runId}`,
          releaseEnvelope: releaseEnvelope(release),
          checkedAt,
          expiresAt,
        });
        [localItems, localContent] = await Promise.all([
          this.dependencies.assets.listItems(context, {
            sourceReleaseId: staged.sourceReleaseId,
            limit: MAX_SOURCE_ITEMS,
          }),
          localCatalog(this.dependencies.content, context),
        ]);
      } catch {
        throw new LocalContentSyncPersistenceError();
      }
      if (localItems.hasMore || localItems.items.length !== release.approvedItemCount) {
        throw new Error('source_import_incomplete');
      }
      const decisions = new Map(localItems.items.map((item) => [item.versionId, item]));
      const localBySource = new Map(
        localContent
          .filter((item) => item.source.system === SOURCE_SYSTEM)
          .map((item) => [item.source.itemId, item]),
      );
      const blockers: PropertyPredatorContentSyncBlocker[] = [];
      let importedVersions = 0;
      let refreshedAttestations = 0;
      let unchangedVersions = 0;
      let verifiedArtworkBytes = 0;
      let quarantinedItems = 0;
      let reviewIncompleteItems = 0;

      for (const item of catalog.items) {
        const itemRef = exactItemIdentity(item);
        const decision = decisions.get(item.versionId);
        if (!decision) {
          blockers.push(blocker(
            'source_import_incomplete',
            'The immutable local release projection is missing this source item.',
            true,
            itemRef,
          ));
          continue;
        }
        if (decision.decisions.some((entry) => entry.outcome === 'quarantined')) {
          quarantinedItems += 1;
          blockers.push(blocker(
            'source_item_quarantined',
            'This exact source item is quarantined and was not imported or refreshed.',
            false,
            itemRef,
          ));
          continue;
        }
        if (!exactDecisionCoverage(item, decision, staged.sourceReleaseId)) {
          reviewIncompleteItems += 1;
          blockers.push(blocker(
            'quarantine_review_incomplete',
            'This item is staged for review; its local quarantine decision coverage is incomplete.',
            false,
            itemRef,
          ));
          continue;
        }
        let resource: PropertyPredatorApprovedVersionResource;
        let verifiedAsset: Readonly<{ byteLength: number; mediaType: string }> | null = null;
        try {
          resource = await this.dependencies.resources.loadVersion(
            item.versionId,
            item.contentSha256,
          );
          if (!resourceMatches(item, resource)) throw new Error('exact_resource_mismatch');
          if (item.itemType === 'asset') {
            if (!item.blobSha256) throw new Error('exact_resource_mismatch');
            const asset = await this.dependencies.resources.loadAsset(item.versionId, item.blobSha256);
            if (asset.mediaType !== item.payload.media_type
                || asset.bytes.byteLength !== item.payload.bytes) {
              throw new Error('exact_resource_mismatch');
            }
            verifiedAsset = Object.freeze({
              byteLength: asset.bytes.byteLength,
              mediaType: asset.mediaType,
            });
            verifiedArtworkBytes += asset.bytes.byteLength;
          }
        } catch (error) {
          blockers.push(resourceFailure(error, itemRef));
          continue;
        }
        try {
          const local = localBySource.get(itemRef);
          if (local && Number(local.source.version) > item.itemVersion) {
            throw new Error('local_version_conflict');
          }
          if (local && local.source.version === String(item.itemVersion)) {
            if (!importedTupleMatches(local, item)) throw new Error('local_version_conflict');
            await this.dependencies.content.refreshSourceAttestation(context, {
              commandKey: `pp-sync:attestation:${runId}:${item.versionId}`,
              contentItemId: local.contentItemId,
              contentVersionId: local.contentVersionId,
              expected: Object.freeze({
                source: local.source,
                contentSha256: local.contentSha256,
                blobSha256: local.blobSha256,
                brandSha256: local.brandSha256,
              }),
              attestation: Object.freeze({
                catalogSha256: catalog.catalogSha256,
                checkedAt,
                expiresAt,
              }),
            });
            refreshedAttestations += 1;
            continue;
          }
          const command = enrichedCommand(
            catalog,
            item,
            `pp-sync:version:${runId}:${item.versionId}`,
            checkedAt,
            expiresAt,
            resource,
            local,
            verifiedAsset,
          );
          await this.dependencies.content.createVersion(context, command);
          importedVersions += 1;
        } catch (error) {
          blockers.push(localWriteFailure(error, itemRef));
        }
      }

      unchangedVersions = Math.max(
        0,
        catalog.itemCount - importedVersions - refreshedAttestations
          - quarantinedItems - reviewIncompleteItems - blockers.filter((entry) => (
            entry.code === 'exact_resource_mismatch' || entry.code === 'local_version_conflict'
              || entry.code === 'local_write_failed' || entry.code === 'source_unavailable'
              || entry.code === 'source_import_incomplete'
          )).length,
      );
      const materialBlockers = blockers.filter((entry) => (
        entry.code !== 'quarantine_review_incomplete' && entry.code !== 'source_item_quarantined'
      ));
      const safeCompletion = materialBlockers.length === 0;
      const retryableFailure = materialBlockers.some((entry) => entry.retryable);
      const attemptCount = safeCompletion ? 0 : previous.attemptCount + 1;
      const retryDelay = Math.min(MAX_RETRY_MS, 5_000 * (2 ** Math.min(6, attemptCount - 1)));
      const next: MutableSyncState = {
        state: blockers.length === 0 ? 'current' : 'attention',
        attemptCount,
        lastAttemptAt: checkedAt,
        lastSuccessAt: safeCompletion ? checkedAt : previous.lastSuccessAt,
        nextRetryAt: retryableFailure
          ? new Date(attemptTime.getTime() + retryDelay).toISOString()
          : null,
        sourceCheckedAt: safeCompletion ? checkedAt : previous.sourceCheckedAt,
        sourceExpiresAt: safeCompletion ? expiresAt : previous.sourceExpiresAt,
        sourceCatalogSha256: safeCompletion ? catalog.catalogSha256 : previous.sourceCatalogSha256,
        sourceReleaseSha256: safeCompletion ? release.releaseSha256 : previous.sourceReleaseSha256,
        brandBrainPackageSha256: safeCompletion
          ? release.brandBrain.manifest.packageSha256
          : previous.brandBrainPackageSha256,
        counts: Object.freeze({
          sourceItems: catalog.itemCount,
          importedVersions,
          refreshedAttestations,
          unchangedVersions,
          verifiedArtworkBytes,
          quarantinedItems,
          reviewIncompleteItems,
          blockedItems: materialBlockers.length,
        }),
        blockers: Object.freeze(blockers),
      };
      this.#states.set(context.workspaceId, next);
      return status(context.workspaceId, next, attemptTime.getTime());
    } catch (error) {
      const code: PropertyPredatorContentSyncBlockerCode = error instanceof Error
        && (error.message === 'release_catalog_mismatch'
          || error.message === 'brand_brain_mismatch'
          || error.message === 'source_import_incomplete'
          || error.message === 'source_observation_invalid')
        ? error.message
        : error instanceof LocalContentSyncPersistenceError
          ? 'local_write_failed'
          : error instanceof Error && error.name.endsWith('ContractError')
            ? 'source_contract_invalid'
            : 'source_unavailable';
      const messages: Readonly<Record<PropertyPredatorContentSyncBlockerCode, string>> = {
        source_sync_not_run: 'The source sync has not run.',
        source_proof_expired: 'The last owned-source proof has expired.',
        source_unavailable: 'The owned source could not be checked safely.',
        source_contract_invalid: 'The source response did not match the approved company-content contract.',
        source_observation_invalid: 'The source catalogue and release observation time was stale, future-dated or inconsistent.',
        release_catalog_mismatch: 'The source release and exact content catalogue do not describe the same immutable set.',
        brand_brain_mismatch: 'The catalogue brand hash and trusted Brand Brain package do not agree.',
        exact_resource_mismatch: 'An exact source resource did not match its approved catalogue tuple.',
        local_version_conflict: 'A local immutable source tuple conflicts with the current approved source.',
        local_write_failed: 'The local immutable projection could not be updated safely.',
        source_item_quarantined: 'An exact source item is quarantined.',
        quarantine_review_incomplete: 'Local quarantine decision coverage is incomplete.',
        source_import_incomplete: 'The local immutable release projection is incomplete.',
      };
      const attemptCount = previous.attemptCount + 1;
      const retryDelay = Math.min(MAX_RETRY_MS, 5_000 * (2 ** Math.min(6, attemptCount - 1)));
      const next: MutableSyncState = {
        ...previous,
        state: 'retry_wait',
        attemptCount,
        lastAttemptAt: checkedAt,
        nextRetryAt: new Date(attemptTime.getTime() + retryDelay).toISOString(),
        blockers: Object.freeze([blocker(code, messages[code], true)]),
      };
      this.#states.set(context.workspaceId, next);
      return status(context.workspaceId, next, attemptTime.getTime());
    }
  }
}
