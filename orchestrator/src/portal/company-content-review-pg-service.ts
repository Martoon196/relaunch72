import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import {
  createCompanyAssetTransactionRunner,
  type CompanyAssetItemDecisionSummary,
  type CompanyAssetItemSummary,
  type CompanyAssetTransactionRunner,
} from '../company-asset-pg/index.js';
import {
  PropertyPredatorCompanyContentAdapter,
  PropertyPredatorContentContractError,
  createPropertyPredatorHttpCatalogTransport,
  type PropertyPredatorCompanyContentItem,
} from '../company-content-adapter/property-predator.js';
import {
  createPropertyPredatorApprovedResourceTransport,
  type PropertyPredatorApprovedResourceTransport,
  type PropertyPredatorApprovedVersionResource,
} from '../company-content-adapter/property-predator-resources.js';
import { canonicalCompanyContentJson } from '../company-content-pg/validation.js';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { InactivePortalSessionError } from '../db/transaction.js';
import {
  PgPortalCompanyAssetsWorkspaceAccessReader,
  type PortalCompanyAssetsWorkspaceAccessReader,
} from './company-assets-pg-service.js';
import type { PropertyPredatorContentSyncSourceConfig } from './company-content-sync-pg-service.js';
import {
  COMPANY_CONTENT_REVIEW_ROUTE_PREFIX,
  type PortalCompanyContentReviewArtworkOutcome,
  type PortalCompanyContentReviewFailure,
  type PortalCompanyContentReviewOutcome,
  type PortalCompanyContentReviewRequestIdentity,
  type PortalCompanyContentReviewService,
  type PortalCompanyContentReviewSnapshot,
  type PortalCompanyContentStagedItemReader,
} from './company-content-review-service.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipal,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_SOURCE_VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const DIMENSIONS = Object.freeze(['visual_policy', 'claim', 'asset'] as const);

interface StagedItemRow extends QueryResultRow {
  readonly releaseItemId: unknown;
  readonly sourceReleaseId: unknown;
  readonly itemOrdinal: unknown;
  readonly itemType: unknown;
  readonly itemId: unknown;
  readonly itemVersion: unknown;
  readonly versionId: unknown;
  readonly contentSha256: unknown;
  readonly blobSha256: unknown;
  readonly brandSha256: unknown;
  readonly approvalId: unknown;
  readonly approvedAt: unknown;
  readonly approvalExpiryStatus: unknown;
  readonly contentMode: unknown;
  readonly hqUseStatus: unknown;
  readonly ownershipStatus: unknown;
  readonly privacyStatus: unknown;
  readonly sourceQuarantineStatus: unknown;
  readonly sourceApprovalStatus: unknown;
  readonly recordedAt: unknown;
  readonly decisions: unknown;
}

/** Adapter-role query: exact staged metadata only; resource/storage paths are never selected. */
export const COMPANY_CONTENT_REVIEW_STAGED_ITEM_SQL = `/* portal.company-content-review.staged-item */
  SELECT item.id::text AS "releaseItemId",
         item.source_release_id::text AS "sourceReleaseId",
         item.item_ordinal AS "itemOrdinal",
         item.item_type AS "itemType",
         item.item_id AS "itemId",
         item.item_version AS "itemVersion",
         item.version_id AS "versionId",
         encode(item.content_sha256, 'hex') AS "contentSha256",
         CASE WHEN item.blob_sha256 IS NULL THEN NULL
              ELSE encode(item.blob_sha256, 'hex') END AS "blobSha256",
         encode(item.brand_sha256, 'hex') AS "brandSha256",
         item.approval_id AS "approvalId",
         item.approved_at::text AS "approvedAt",
         item.approval_expiry_status AS "approvalExpiryStatus",
         item.content_mode AS "contentMode",
         item.hq_use_status AS "hqUseStatus",
         item.ownership_status AS "ownershipStatus",
         item.privacy_status AS "privacyStatus",
         item.quarantine_status AS "sourceQuarantineStatus",
         item.source_approval_status AS "sourceApprovalStatus",
         item.recorded_at::text AS "recordedAt",
         COALESCE(jsonb_agg(jsonb_build_object(
           'dimension', decision.decision_dimension,
           'outcome', decision.decision_outcome,
           'reasonCode', decision.reason_code,
           'evidenceSha256', encode(decision.evidence_sha256, 'hex'),
           'recordedAt', decision.recorded_at::text
         ) ORDER BY decision.decision_dimension)
           FILTER (WHERE decision.id IS NOT NULL), '[]'::jsonb) AS decisions
  FROM app_private.company_asset_release_items AS item
  LEFT JOIN app_private.company_asset_quarantine_decisions AS decision
    ON decision.workspace_id = item.workspace_id
   AND decision.source_release_id = item.source_release_id
   AND decision.release_item_id = item.id
   AND decision.item_content_sha256 = item.content_sha256
   AND decision.item_brand_sha256 = item.brand_sha256
  WHERE item.workspace_id = app_private.current_workspace_id()
    AND item.id = $1::uuid
  GROUP BY item.id, item.source_release_id, item.item_ordinal, item.item_type,
           item.item_id, item.item_version, item.version_id, item.content_sha256,
           item.blob_sha256, item.brand_sha256, item.approval_id, item.approved_at,
           item.approval_expiry_status, item.content_mode, item.hq_use_status,
           item.ownership_status, item.privacy_status, item.quarantine_status,
           item.source_approval_status, item.recorded_at`;

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value.toLowerCase())) {
    throw new Error(`${label} is invalid`);
  }
  return value.toLowerCase();
}

function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const number = typeof value === 'string' && /^[1-9][0-9]*$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(number) || (number as number) < 1) {
    throw new Error(`${label} is invalid`);
  }
  return number as number;
}

function instant(value: unknown, label: string): string {
  if (!(value instanceof Date) && typeof value !== 'string') throw new Error(`${label} is invalid`);
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed.toISOString();
}

function decision(value: unknown): CompanyAssetItemDecisionSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('staged item decision is invalid');
  }
  const candidate = value as Record<string, unknown>;
  if (!DIMENSIONS.includes(candidate.dimension as never)
      || (candidate.outcome !== 'clear' && candidate.outcome !== 'quarantined')
      || typeof candidate.reasonCode !== 'string'
      || !/^[a-z][a-z0-9_]{0,79}$/u.test(candidate.reasonCode)) {
    throw new Error('staged item decision is invalid');
  }
  return Object.freeze({
    dimension: candidate.dimension as CompanyAssetItemDecisionSummary['dimension'],
    outcome: candidate.outcome,
    reasonCode: candidate.reasonCode as CompanyAssetItemDecisionSummary['reasonCode'],
    evidenceSha256: sha(candidate.evidenceSha256, 'decision evidence digest'),
    recordedAt: instant(candidate.recordedAt, 'decision time'),
  });
}

function stagedItem(row: StagedItemRow): CompanyAssetItemSummary {
  if ((row.itemType !== 'asset' && row.itemType !== 'generated' && row.itemType !== 'media')
      || typeof row.itemId !== 'string' || !SAFE_ITEM_ID.test(row.itemId)
      || typeof row.versionId !== 'string' || !SAFE_SOURCE_VERSION_ID.test(row.versionId)
      || typeof row.approvalId !== 'string' || !SAFE_ITEM_ID.test(row.approvalId)
      || row.approvalExpiryStatus !== 'missing'
      || row.contentMode !== 'company-owned'
      || row.hqUseStatus !== 'review-required'
      || row.ownershipStatus !== 'source-asserted-company-owned'
      || row.privacyStatus !== 'customer-private-data-forbidden'
      || row.sourceQuarantineStatus !== 'not-recorded-at-source'
      || row.sourceApprovalStatus !== 'source-approved-exact-version'
      || !Array.isArray(row.decisions) || row.decisions.length > 3) {
    throw new Error('staged company content crossed its sealed metadata boundary');
  }
  const decisions = Object.freeze(row.decisions.map(decision));
  if (new Set(decisions.map((entry) => entry.dimension)).size !== decisions.length) {
    throw new Error('staged company content repeats a review dimension');
  }
  const blobSha256 = row.blobSha256 === null ? null : sha(row.blobSha256, 'blob digest');
  if ((row.itemType === 'asset') !== (blobSha256 !== null)) {
    throw new Error('staged company content blob tuple is invalid');
  }
  return Object.freeze({
    releaseItemId: uuid(row.releaseItemId, 'release item id'),
    sourceReleaseId: uuid(row.sourceReleaseId, 'source release id'),
    itemOrdinal: positiveInteger(row.itemOrdinal, 'item ordinal'),
    itemType: row.itemType,
    itemId: row.itemId,
    itemVersion: positiveInteger(row.itemVersion, 'item version'),
    versionId: row.versionId,
    contentSha256: sha(row.contentSha256, 'content digest'),
    blobSha256,
    brandSha256: sha(row.brandSha256, 'brand digest'),
    approvalId: row.approvalId,
    approvedAt: instant(row.approvedAt, 'source approval time'),
    approvalExpiryStatus: 'missing',
    contentMode: 'company-owned',
    hqUseStatus: 'review-required',
    ownershipStatus: 'source-asserted-company-owned',
    privacyStatus: 'customer-private-data-forbidden',
    sourceQuarantineStatus: 'not-recorded-at-source',
    sourceApprovalStatus: 'source-approved-exact-version',
    decisions,
    recordedAt: instant(row.recordedAt, 'staged item time'),
  });
}

export class PgPortalCompanyContentStagedItemReader
implements PortalCompanyContentStagedItemReader {
  constructor(private readonly transactionRunner: CompanyAssetTransactionRunner) {}

  async load(
    context: DatabaseRequestContext,
    releaseItemId: string,
  ): Promise<CompanyAssetItemSummary | null> {
    return this.transactionRunner.run(context, async (transaction) => {
      const result = await transaction.query<StagedItemRow>(
        COMPANY_CONTENT_REVIEW_STAGED_ITEM_SQL,
        [releaseItemId],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw new Error('staged company content returned more than once');
      return stagedItem(result.rows[0]!);
    }, { readOnly: true });
  }
}

export interface PortalCompanyContentReviewDependencies {
  readonly principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  readonly accessReader: PortalCompanyAssetsWorkspaceAccessReader;
  readonly stagedItems: PortalCompanyContentStagedItemReader;
  readonly catalog: Pick<PropertyPredatorCompanyContentAdapter, 'catalog'>;
  readonly resources: PropertyPredatorApprovedResourceTransport;
}

function databaseContext(
  identity: PortalCompanyContentReviewRequestIdentity,
  principal: PortalCrmPrincipal,
): DatabaseRequestContext {
  return requestDatabaseContext({
    ...principal,
    requestId: identity.requestId,
    portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest(),
  });
}

function failure(
  kind: PortalCompanyContentReviewFailure['kind'],
  message: string,
): PortalCompanyContentReviewFailure {
  return Object.freeze({ ok: false, kind, message });
}

function catalogTupleMatches(
  staged: CompanyAssetItemSummary,
  catalog: PropertyPredatorCompanyContentItem,
): boolean {
  return catalog.versionId === staged.versionId
    && catalog.itemType === staged.itemType
    && catalog.itemId === staged.itemId
    && catalog.itemVersion === staged.itemVersion
    && catalog.approvalId === staged.approvalId
    && new Date(catalog.approvedAt).toISOString() === staged.approvedAt
    && catalog.contentSha256 === staged.contentSha256
    && catalog.blobSha256 === staged.blobSha256
    && catalog.brandSha256 === staged.brandSha256;
}

function resourceTupleMatches(
  staged: CompanyAssetItemSummary,
  catalog: PropertyPredatorCompanyContentItem,
  resource: PropertyPredatorApprovedVersionResource,
): boolean {
  return resource.versionId === staged.versionId
    && resource.itemType === staged.itemType
    && resource.itemId === staged.itemId
    && resource.itemVersion === staged.itemVersion
    && resource.approvalId === staged.approvalId
    && new Date(resource.approvedAt).toISOString() === staged.approvedAt
    && resource.contentSha256 === staged.contentSha256
    && resource.blobSha256 === staged.blobSha256
    && resource.brandSha256 === staged.brandSha256
    && resource.canonicalContent === canonicalCompanyContentJson(catalog.payload)
    && canonicalCompanyContentJson(resource.payload)
      === canonicalCompanyContentJson(catalog.payload);
}

function reviewPayload(
  itemType: CompanyAssetItemSummary['itemType'],
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (itemType === 'asset') {
    return Object.freeze({
      title: payload.title,
      caption: payload.caption,
      category: payload.category,
      mediaType: payload.media_type,
      bytes: payload.bytes,
    });
  }
  if (itemType === 'media') {
    return Object.freeze({
      title: payload.title,
      body: payload.body,
      category: payload.category,
      kind: payload.kind,
    });
  }
  return Object.freeze({
    title: payload.title,
    body: payload.body,
    kind: payload.kind,
    platform: payload.platform,
    ctaUrl: payload.cta_url,
  });
}

function artwork(
  staged: CompanyAssetItemSummary,
  resource: PropertyPredatorApprovedVersionResource,
): PortalCompanyContentReviewSnapshot['artwork'] {
  if (staged.itemType !== 'asset') return null;
  const mediaType = resource.payload.media_type;
  const bytes = resource.payload.bytes;
  if ((mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/webp')
      || !Number.isSafeInteger(bytes) || (bytes as number) < 1
      || (bytes as number) > 10 * 1024 * 1024 || staged.blobSha256 === null) {
    throw new PropertyPredatorContentContractError('review artwork metadata is invalid');
  }
  return Object.freeze({
    mediaType,
    expectedByteLength: bytes as number,
    blobSha256: staged.blobSha256,
    fileHref: `${COMPANY_CONTENT_REVIEW_ROUTE_PREFIX}/${staged.releaseItemId}/file`,
    verification: 'verified_at_response_boundary' as const,
  });
}

export class PgPortalCompanyContentReviewService implements PortalCompanyContentReviewService {
  constructor(private readonly dependencies: PortalCompanyContentReviewDependencies) {}

  private async load(
    identity: PortalCompanyContentReviewRequestIdentity,
    releaseItemId: string,
  ): Promise<PortalCompanyContentReviewSnapshot | PortalCompanyContentReviewFailure> {
    if (!UUID.test(releaseItemId)) {
      return failure('validation', 'Choose an exact staged company asset from Company Assets.');
    }
    try {
      const principal = await this.dependencies.principalResolver.resolve(identity.sessionToken);
      if (!principal) return failure('unauthenticated', 'This portal session is no longer active.');
      const context = databaseContext(identity, principal);
      const workspace = await this.dependencies.accessReader.load(context);
      if (!workspace || !workspace.canManage) {
        return failure('forbidden', 'Founder or workspace-admin access is required for exact review.');
      }
      const staged = await this.dependencies.stagedItems.load(context, releaseItemId);
      if (!staged) {
        return failure('not_found', 'That exact staged company asset is not available in this workspace.');
      }
      const sourceCatalog = await this.dependencies.catalog.catalog();
      const catalogCandidates = sourceCatalog.items.filter((candidate) => (
        candidate.versionId === staged.versionId
      ));
      if (catalogCandidates.length !== 1) {
        throw new PropertyPredatorContentContractError(
          'validated catalog did not identify exactly one staged version',
        );
      }
      const catalogItem = catalogCandidates[0]!;
      if (!catalogTupleMatches(staged, catalogItem)) {
        throw new PropertyPredatorContentContractError('staged item does not match validated catalog');
      }
      const resource = await this.dependencies.resources.loadVersion(
        staged.versionId,
        staged.contentSha256,
      );
      if (!resourceTupleMatches(staged, catalogItem, resource)) {
        throw new PropertyPredatorContentContractError('exact resource tuple does not match staged item');
      }
      const decided = new Set(staged.decisions.map((entry) => entry.dimension));
      return Object.freeze({
        workspace: Object.freeze({
          workspaceId: workspace.workspaceId,
          workspaceName: workspace.workspaceName,
          snapshotAt: workspace.snapshotAt,
          canManage: true as const,
        }),
        item: Object.freeze({
          releaseItemId: staged.releaseItemId,
          sourceReleaseId: staged.sourceReleaseId,
          itemType: staged.itemType,
          itemId: staged.itemId,
          itemVersion: staged.itemVersion,
          sourceVersionId: staged.versionId,
          contentSha256: staged.contentSha256,
          blobSha256: staged.blobSha256,
          brandSha256: staged.brandSha256,
          sourceApproval: Object.freeze({
            approvalId: staged.approvalId,
            approvedAt: staged.approvedAt,
            meaning: 'source_provenance_only' as const,
            expiresAt: null,
          }),
          hqUseStatus: 'review_required' as const,
          decisions: staged.decisions,
          pendingDimensions: Object.freeze(DIMENSIONS.filter((entry) => !decided.has(entry))),
          quarantined: staged.decisions.some((entry) => entry.outcome === 'quarantined'),
        }),
        exactContent: Object.freeze({
          mediaType: 'application/json' as const,
          canonicalContent: staged.itemType === 'asset' ? null : resource.canonicalContent,
          payload: reviewPayload(staged.itemType, resource.payload),
          verified: true as const,
        }),
        artwork: artwork(staged, resource),
        safety: Object.freeze({
          providerEffects: false as const,
          customerPrivateDataAccepted: false as const,
          affiliateContentAccepted: false as const,
          sourceApprovalPromotedToHqApproval: false as const,
        }),
      });
    } catch (error) {
      if (error instanceof InactivePortalSessionError) {
        return failure('unauthenticated', 'This portal session is no longer active.');
      }
      if (error instanceof PropertyPredatorContentContractError) {
        return failure(
          'source_mismatch',
          'The staged item, validated catalogue and exact source resource did not match. Review is locked.',
        );
      }
      return failure('unavailable', 'The exact company-content review is temporarily unavailable.');
    }
  }

  async review(
    identity: PortalCompanyContentReviewRequestIdentity,
    releaseItemId: string,
  ): Promise<PortalCompanyContentReviewOutcome> {
    const snapshot = await this.load(identity, releaseItemId);
    return 'ok' in snapshot ? snapshot : Object.freeze({ ok: true, snapshot });
  }

  async artwork(
    identity: PortalCompanyContentReviewRequestIdentity,
    releaseItemId: string,
  ): Promise<PortalCompanyContentReviewArtworkOutcome> {
    const snapshot = await this.load(identity, releaseItemId);
    if ('ok' in snapshot) return snapshot;
    if (!snapshot.artwork) {
      return failure('not_found', 'This exact staged item has no approved artwork bytes.');
    }
    try {
      const asset = await this.dependencies.resources.loadAsset(
        snapshot.item.sourceVersionId,
        snapshot.artwork.blobSha256,
      );
      if (asset.versionId !== snapshot.item.sourceVersionId
          || asset.mediaType !== snapshot.artwork.mediaType
          || asset.sha256 !== snapshot.artwork.blobSha256
          || asset.bytes.byteLength !== snapshot.artwork.expectedByteLength) {
        throw new PropertyPredatorContentContractError('exact artwork tuple changed');
      }
      return Object.freeze({
        ok: true,
        contentVersionId: snapshot.item.sourceVersionId,
        mediaType: asset.mediaType,
        sha256: asset.sha256,
        bytes: asset.bytes,
        providerEffects: false,
      });
    } catch (error) {
      if (error instanceof PropertyPredatorContentContractError) {
        return failure('source_mismatch', 'The artwork bytes failed exact-version verification.');
      }
      return failure('unavailable', 'The exact artwork preview is temporarily unavailable.');
    }
  }
}

export function createPgPortalCompanyContentReviewService(input: {
  readonly webPool: Pool;
  readonly adapterPool: Pool;
  readonly source: PropertyPredatorContentSyncSourceConfig;
}): PgPortalCompanyContentReviewService {
  const sourceOptions = Object.freeze({
    baseUrl: input.source.sourceOrigin,
    clientId: input.source.sourceClientId,
    readToken: input.source.sourceReadToken,
    timeoutMs: input.source.sourceTimeoutMs,
    allowLocalHttp: input.source.allowLocalHttp,
  });
  return new PgPortalCompanyContentReviewService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    accessReader: new PgPortalCompanyAssetsWorkspaceAccessReader(
      createCompanyAssetTransactionRunner(input.webPool),
    ),
    stagedItems: new PgPortalCompanyContentStagedItemReader(
      createCompanyAssetTransactionRunner(input.adapterPool),
    ),
    catalog: new PropertyPredatorCompanyContentAdapter(
      createPropertyPredatorHttpCatalogTransport(sourceOptions),
    ),
    resources: createPropertyPredatorApprovedResourceTransport(sourceOptions),
  });
}
