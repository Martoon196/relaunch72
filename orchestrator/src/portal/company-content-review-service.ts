import type {
  CompanyAssetItemDecisionSummary,
  CompanyAssetItemSummary,
  CompanyAssetQuarantineDimension,
} from '../company-asset-pg/types.js';
import type { DatabaseRequestContext } from '../db/rls.js';

export const COMPANY_CONTENT_REVIEW_ROUTE_PREFIX = '/portal/content/assets/review';

export interface PortalCompanyContentReviewRequestIdentity {
  readonly sessionToken: string;
  readonly requestId: string;
}

export interface PortalCompanyContentReviewWorkspace {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly snapshotAt: string;
  readonly canManage: true;
}

export interface PortalCompanyContentReviewSnapshot {
  readonly workspace: PortalCompanyContentReviewWorkspace;
  readonly item: Readonly<{
    readonly releaseItemId: string;
    readonly sourceReleaseId: string;
    readonly itemType: 'asset' | 'generated' | 'media';
    readonly itemId: string;
    readonly itemVersion: number;
    readonly sourceVersionId: string;
    readonly contentSha256: string;
    readonly blobSha256: string | null;
    readonly brandSha256: string;
    readonly sourceApproval: Readonly<{
      readonly approvalId: string;
      readonly approvedAt: string;
      readonly meaning: 'source_provenance_only';
      readonly expiresAt: null;
    }>;
    readonly hqUseStatus: 'review_required';
    readonly decisions: readonly CompanyAssetItemDecisionSummary[];
    readonly pendingDimensions: readonly CompanyAssetQuarantineDimension[];
    readonly quarantined: boolean;
  }>;
  readonly exactContent: Readonly<{
    readonly mediaType: 'application/json';
    /** Exact canonical copy for media/generated items; null for asset metadata containing a filename. */
    readonly canonicalContent: string | null;
    /** Strict review allowlist. Raw source payload/storage fields never cross this boundary. */
    readonly payload: Readonly<Record<string, unknown>>;
    readonly verified: true;
  }>;
  readonly artwork: null | Readonly<{
    readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
    readonly expectedByteLength: number;
    readonly blobSha256: string;
    readonly fileHref: string;
    readonly verification: 'verified_at_response_boundary';
  }>;
  readonly safety: Readonly<{
    readonly providerEffects: false;
    readonly customerPrivateDataAccepted: false;
    readonly affiliateContentAccepted: false;
    readonly sourceApprovalPromotedToHqApproval: false;
  }>;
}

export interface PortalCompanyContentStagedItemReader {
  load(
    context: DatabaseRequestContext,
    releaseItemId: string,
  ): Promise<CompanyAssetItemSummary | null>;
}

export type PortalCompanyContentReviewFailureKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'validation'
  | 'not_found'
  | 'source_mismatch'
  | 'unavailable';

export interface PortalCompanyContentReviewFailure {
  readonly ok: false;
  readonly kind: PortalCompanyContentReviewFailureKind;
  readonly message: string;
}

export type PortalCompanyContentReviewOutcome =
  | { readonly ok: true; readonly snapshot: PortalCompanyContentReviewSnapshot }
  | PortalCompanyContentReviewFailure;

export type PortalCompanyContentReviewArtworkOutcome =
  | {
      readonly ok: true;
      readonly contentVersionId: string;
      readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
      readonly sha256: string;
      readonly bytes: Uint8Array;
      readonly providerEffects: false;
    }
  | PortalCompanyContentReviewFailure;

/** Read-only exact-version boundary. It exposes no decision or provider method. */
export interface PortalCompanyContentReviewService {
  review(
    identity: PortalCompanyContentReviewRequestIdentity,
    releaseItemId: string,
  ): Promise<PortalCompanyContentReviewOutcome>;
  artwork(
    identity: PortalCompanyContentReviewRequestIdentity,
    releaseItemId: string,
  ): Promise<PortalCompanyContentReviewArtworkOutcome>;
}
