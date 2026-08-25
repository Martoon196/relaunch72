import type {
  CompanyContentApprovalDecision,
  CompanyContentCatalogPage,
  CompanyContentCatalogQuery,
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

  requestApproval(
    identity: PortalCompanyContentRequestIdentity,
    input: PortalRequestCompanyContentApprovalInput,
  ): Promise<PortalRequestCompanyContentApprovalOutcome>;

  decideApproval(
    identity: PortalCompanyContentRequestIdentity,
    input: PortalDecideCompanyContentApprovalInput,
  ): Promise<PortalDecideCompanyContentApprovalOutcome>;
}
