import type {
  CompanyContentApprovalDecision,
  CompanyContentCatalogPage,
  CompanyContentCatalogQuery,
  CompanyContentExactReview,
  CreateCompanyContentEmailDraftVersionCommand,
} from '../company-content-pg/types.js';

/**
 * Opaque browser identity. Implementations must resolve the session server-side
 * and must never accept a workspace or actor id from a portal form.
 */
export interface PortalCompanyContentRequestIdentity {
  readonly sessionToken: string;
  readonly requestId: string;
}

export interface PortalCompanyContentWorkspaceAccess {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly snapshotAt: string;
  readonly canWrite: boolean;
  readonly canManage: boolean;
}

/**
 * Exact version reads now return complete hash-checked bytes under the
 * authenticated workspace context. Keep the final approval capability dark
 * until the router places that review beside the exact decision action.
 */
export const PORTAL_COMPANY_CONTENT_EXACT_REVIEW_AVAILABLE = true;
export const PORTAL_COMPANY_CONTENT_REVIEW_REPRESENTATION_AVAILABLE = false;

export interface PortalCompanyContentSnapshot {
  readonly workspace: PortalCompanyContentWorkspaceAccess;
  readonly catalog: CompanyContentCatalogPage;
}

export type PortalCompanyContentFailureKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'validation'
  | 'not_found'
  | 'idempotency_conflict'
  | 'command_in_progress'
  | 'version_conflict'
  | 'approval_conflict'
  | 'review_unavailable'
  | 'unavailable';

export interface PortalCompanyContentFailure {
  readonly ok: false;
  readonly kind: PortalCompanyContentFailureKind;
  /** Safe, user-facing copy. Database and provider details never cross this boundary. */
  readonly message: string;
}

export type PortalCompanyContentSnapshotOutcome =
  | {
      readonly ok: true;
      readonly snapshot: PortalCompanyContentSnapshot;
    }
  | PortalCompanyContentFailure;

export interface PortalCompanyContentReviewInput {
  readonly contentItemId: string;
  readonly contentVersionId: string;
}

export interface PortalCompanyContentReviewSnapshot {
  readonly workspace: PortalCompanyContentWorkspaceAccess;
  readonly review: CompanyContentExactReview;
}

export type PortalCompanyContentReviewOutcome =
  | {
      readonly ok: true;
      readonly snapshot: PortalCompanyContentReviewSnapshot;
    }
  | PortalCompanyContentFailure;

/**
 * Must be assembled by the server from the generated draft plus the exact
 * Brand Brain/source evidence already held by the campaign runtime. A browser
 * must never be allowed to choose workspace or actor identity.
 */
export type PortalCreateCompanyContentEmailDraftVersionInput =
  CreateCompanyContentEmailDraftVersionCommand;

export type PortalCreateCompanyContentEmailDraftVersionOutcome =
  | {
      readonly ok: true;
      readonly disposition: 'applied' | 'replayed';
      readonly contentItemId: string;
      readonly contentVersionId: string;
      readonly versionNumber: number;
      readonly contentSha256: string;
      readonly sourceAttestationId: string;
      readonly sourceAttestationExpiresAt: string;
    }
  | PortalCompanyContentFailure;

/** Both ids are mandatory: the portal can never submit an implicit "latest" approval. */
export interface PortalRequestCompanyContentApprovalInput {
  readonly commandKey: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly reviewNote?: string | null;
}

export type PortalRequestCompanyContentApprovalOutcome =
  | {
      readonly ok: true;
      readonly disposition: 'applied' | 'replayed';
      readonly approvalRequestId: string;
      readonly contentItemId: string;
      readonly contentVersionId: string;
      readonly requestNumber: number;
      readonly contentSha256: string;
    }
  | PortalCompanyContentFailure;

export interface PortalDecideCompanyContentApprovalInput {
  readonly commandKey: string;
  readonly approvalRequestId: string;
  readonly decision: CompanyContentApprovalDecision;
  readonly decisionNote?: string | null;
}

export interface PortalDecideExactReviewedCompanyContentApprovalInput
  extends PortalDecideCompanyContentApprovalInput {
  readonly decision: 'approved';
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
}

export type PortalDecideCompanyContentApprovalOutcome =
  | {
      readonly ok: true;
      readonly disposition: 'applied' | 'replayed';
      readonly approvalDecisionId: string;
      readonly approvalRequestId: string;
      readonly contentItemId: string;
      readonly contentVersionId: string;
      readonly decision: CompanyContentApprovalDecision;
      readonly contentSha256: string;
    }
  | PortalCompanyContentFailure;

/**
 * Router-facing company-content boundary. It deliberately has no source fetch,
 * version creation, scheduling, provider, send or publish operation.
 */
export interface PortalCompanyContentService {
  snapshot(
    identity: PortalCompanyContentRequestIdentity,
    query?: CompanyContentCatalogQuery,
  ): Promise<PortalCompanyContentSnapshotOutcome>;

  review?(
    identity: PortalCompanyContentRequestIdentity,
    input: PortalCompanyContentReviewInput,
  ): Promise<PortalCompanyContentReviewOutcome>;

  createEmailDraftVersion?(
    identity: PortalCompanyContentRequestIdentity,
    input: PortalCreateCompanyContentEmailDraftVersionInput,
  ): Promise<PortalCreateCompanyContentEmailDraftVersionOutcome>;

  requestApproval(
    identity: PortalCompanyContentRequestIdentity,
    input: PortalRequestCompanyContentApprovalInput,
  ): Promise<PortalRequestCompanyContentApprovalOutcome>;

  decideApproval(
    identity: PortalCompanyContentRequestIdentity,
    input: PortalDecideCompanyContentApprovalInput,
  ): Promise<PortalDecideCompanyContentApprovalOutcome>;

  /**
   * Approval-only seam used after a short-lived exact-review capability has
   * been verified. Implementations must re-read the exact pending version;
   * callers cannot promote the ordinary summary decision path.
   */
  decideExactReviewedApproval?(
    identity: PortalCompanyContentRequestIdentity,
    input: PortalDecideExactReviewedCompanyContentApprovalInput,
  ): Promise<PortalDecideCompanyContentApprovalOutcome>;
}
