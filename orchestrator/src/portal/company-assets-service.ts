import type {
  CompanyAssetItemPage,
  CompanyAssetQuarantineDimension,
  CompanyAssetReleaseSummary,
} from '../company-asset-pg/types.js';

/** Opaque browser identity; workspace and actor ids are always resolved server-side. */
export interface PortalCompanyAssetsRequestIdentity {
  readonly sessionToken: string;
  readonly requestId: string;
}

export interface PortalCompanyAssetsWorkspaceAccess {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly snapshotAt: string;
  readonly canManage: boolean;
}

export const PORTAL_COMPANY_ASSET_REVIEW_REPRESENTATION_AVAILABLE = false;

export interface PortalCompanyAssetsSnapshot {
  readonly workspace: PortalCompanyAssetsWorkspaceAccess;
  readonly releases: readonly CompanyAssetReleaseSummary[];
  readonly selectedRelease: CompanyAssetReleaseSummary | null;
  readonly itemPage: CompanyAssetItemPage;
  readonly dataset: 'illustrative_fixture' | 'postgres_authoritative';
  readonly providerEffects: false;
  readonly reviewRepresentationAvailable: false;
}

export type PortalCompanyAssetQuarantineReasonCode =
  | 'visual_policy_conflict'
  | 'claims_unsubstantiated'
  | 'asset_integrity_failed';

export interface PortalQuarantineCompanyAssetInput {
  readonly commandKey: string;
  readonly sourceReleaseId: string;
  readonly releaseItemId: string;
  readonly itemType: 'asset' | 'generated' | 'media';
  readonly itemId: string;
  readonly itemContentSha256: string;
  readonly itemBrandSha256: string;
  readonly dimension: CompanyAssetQuarantineDimension;
  readonly outcome: 'quarantined';
  readonly reasonCode: PortalCompanyAssetQuarantineReasonCode;
  readonly evidenceSha256: string;
}

export type PortalCompanyAssetsFailureKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'validation'
  | 'not_found'
  | 'idempotency_conflict'
  | 'exact_item_conflict'
  | 'review_unavailable'
  | 'unavailable';

export interface PortalCompanyAssetsFailure {
  readonly ok: false;
  readonly kind: PortalCompanyAssetsFailureKind;
  /** Safe browser copy only; database, storage and provider detail never crosses. */
  readonly message: string;
}

export type PortalCompanyAssetsSnapshotOutcome =
  | { readonly ok: true; readonly snapshot: PortalCompanyAssetsSnapshot }
  | PortalCompanyAssetsFailure;

export type PortalQuarantineCompanyAssetOutcome =
  | {
      readonly ok: true;
      readonly disposition: 'applied' | 'replayed';
      readonly quarantineDecisionId: string;
      readonly sourceReleaseId: string;
      readonly releaseItemId: string;
      readonly itemType: 'asset' | 'generated' | 'media';
      readonly itemId: string;
      readonly itemContentSha256: string;
      readonly itemBrandSha256: string;
      readonly dimension: CompanyAssetQuarantineDimension;
      readonly outcome: 'quarantined';
      readonly reasonCode: PortalCompanyAssetQuarantineReasonCode;
      readonly evidenceSha256: string;
      readonly providerEffects: false;
    }
  | PortalCompanyAssetsFailure;

/**
 * Metadata-only founder boundary. There is intentionally no content fetch,
 * clear, approve, generate, enqueue, provider, publish or send method.
 */
export interface PortalCompanyAssetsService {
  snapshot(identity: PortalCompanyAssetsRequestIdentity): Promise<PortalCompanyAssetsSnapshotOutcome>;
  quarantine(
    identity: PortalCompanyAssetsRequestIdentity,
    input: PortalQuarantineCompanyAssetInput,
  ): Promise<PortalQuarantineCompanyAssetOutcome>;
}
