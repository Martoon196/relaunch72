import type { DatabaseRequestContext } from '../db/rls.js';
import type { SqlExecutor } from '../crm-pg/types.js';

export type CompanyContentOrigin = 'imported' | 'generated' | 'edited';
export type CompanyContentKind =
  | 'article'
  | 'document'
  | 'email'
  | 'image'
  | 'social_post'
  | 'video'
  | 'webinar'
  | 'other';
export type CompanyContentApprovalDecision =
  | 'approved'
  | 'rejected'
  | 'changes_requested';
export type CompanyContentApprovalStatus =
  | 'unrequested'
  | 'pending'
  | CompanyContentApprovalDecision;

export interface CompanyContentSourceProvenance {
  /** Stable product/provider name; retained exactly after validation. */
  readonly system: string;
  /** Stable source-owned item identity; retained exactly after validation. */
  readonly itemId: string;
  /** Exact source revision, ETag, commit, export revision or fixture version. */
  readonly version: string;
}

export interface CompanyContentBlobProvenance {
  /** Opaque storage reference. This boundary never reads it or calls a provider. */
  readonly storageKey: string;
  /** Lowercase hexadecimal SHA-256 of the exact source/output blob bytes. */
  readonly sha256: string;
}

export interface CompanyContentBrandProvenance {
  /** Opaque reference to the exact brand snapshot used for this version. */
  readonly snapshotRef: string;
  /** Lowercase hexadecimal SHA-256 of that exact canonical brand snapshot. */
  readonly sha256: string;
}

export interface CompanyContentSourceAttestationInput {
  /** SHA-256 of the exact source catalogue/export snapshot used for the check. */
  readonly catalogSha256: string;
  readonly checkedAt: string;
  readonly expiresAt: string;
}

export interface CreateCompanyContentVersionCommand {
  readonly commandKey: string;
  /** Omit for a new logical item; required together with previousVersionId for an edit/import revision. */
  readonly contentItemId?: string | null;
  readonly previousVersionId?: string | null;
  readonly origin: CompanyContentOrigin;
  readonly kind: CompanyContentKind;
  readonly title: string;
  readonly contentMimeType: string;
  /** Exact canonical UTF-8 content. Its SHA-256 is computed, never trusted from a caller. */
  readonly content: string;
  readonly source: CompanyContentSourceProvenance;
  readonly blob: CompanyContentBlobProvenance;
  readonly brand: CompanyContentBrandProvenance;
  readonly attestation: CompanyContentSourceAttestationInput;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CreateCompanyContentVersionResult {
  readonly disposition: 'applied' | 'replayed';
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly versionNumber: number;
  readonly contentSha256: string;
  readonly sourceAttestationId: string;
  readonly sourceAttestationExpiresAt: string;
}

/**
 * Exact, hash-bound representation used for owned email drafts. Subject and
 * body live inside `content_body` together so neither can change without
 * changing the immutable version digest.
 */
export const COMPANY_CONTENT_EMAIL_DRAFT_SCHEMA =
  'propertypredator.email-draft/v1' as const;
export const COMPANY_CONTENT_EMAIL_DRAFT_MIME_TYPE =
  'application/vnd.propertypredator.email-draft+json' as const;

export interface CompanyContentEmailDraftPayload {
  readonly schema: typeof COMPANY_CONTENT_EMAIL_DRAFT_SCHEMA;
  readonly subject: string;
  readonly bodyText: string;
}

export interface CreateCompanyContentEmailDraftVersionCommand
extends Omit<CreateCompanyContentVersionCommand, 'kind' | 'contentMimeType' | 'content'> {
  /** Generated drafts use `generated`; operator imports use `imported`; edits identify a predecessor. */
  readonly origin: CompanyContentOrigin;
  readonly subject: string;
  readonly bodyText: string;
}

export interface CompanyContentExactReviewQuery {
  readonly contentItemId: string;
  readonly contentVersionId: string;
}

export interface CompanyContentExactEmailReview {
  readonly schema: typeof COMPANY_CONTENT_EMAIL_DRAFT_SCHEMA;
  readonly subject: string;
  readonly bodyText: string;
  readonly subjectSha256: string;
  readonly bodySha256: string;
}

/**
 * One complete immutable version. The canonical bytes and their digest are
 * returned together so a human review surface never approves a title/hash
 * placeholder while hiding the actual copy.
 */
export interface CompanyContentExactReview {
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly versionNumber: number;
  readonly isLatest: boolean;
  readonly origin: CompanyContentOrigin;
  readonly kind: CompanyContentKind;
  readonly title: string;
  readonly contentMimeType: string;
  readonly canonicalContent: string;
  readonly canonicalByteLength: number;
  readonly contentSha256: string;
  readonly source: CompanyContentSourceProvenance;
  readonly blobSha256: string;
  readonly brandSha256: string;
  readonly approvalRequestId: string | null;
  readonly approvalDecisionId: string | null;
  readonly approvalStatus: CompanyContentApprovalStatus;
  readonly approvalStale: boolean;
  readonly email: CompanyContentExactEmailReview | null;
  readonly createdAt: string;
}

/**
 * Append a new short-lived source proof to an existing immutable version.
 * The expected tuple prevents a stale adapter read from refreshing a version
 * whose source, content, blob or brand evidence has changed.
 */
export interface RefreshCompanyContentSourceAttestationCommand {
  /** Actor-scoped replay key for this exact source observation. */
  readonly commandKey: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly expected: Readonly<{
    readonly source: CompanyContentSourceProvenance;
    readonly contentSha256: string;
    readonly blobSha256: string;
    readonly brandSha256: string;
  }>;
  readonly attestation: CompanyContentSourceAttestationInput;
}

export interface RefreshCompanyContentSourceAttestationResult {
  readonly disposition: 'applied' | 'replayed';
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly sourceAttestationId: string;
  readonly sourceAttestationExpiresAt: string;
  readonly providerEffects: false;
}

export interface RequestCompanyContentApprovalCommand {
  readonly commandKey: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly reviewNote?: string | null;
}

export interface RequestCompanyContentApprovalResult {
  readonly disposition: 'applied' | 'replayed';
  readonly approvalRequestId: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly requestNumber: number;
  readonly contentSha256: string;
}

export interface DecideCompanyContentApprovalCommand {
  readonly commandKey: string;
  readonly approvalRequestId: string;
  readonly decision: CompanyContentApprovalDecision;
  readonly decisionNote?: string | null;
}

export interface DecideCompanyContentApprovalResult {
  readonly disposition: 'applied' | 'replayed';
  readonly approvalDecisionId: string;
  readonly approvalRequestId: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly decision: CompanyContentApprovalDecision;
  readonly contentSha256: string;
}

/** Approval remains an immutable fact; freshness is derived against the latest version. */
export interface CompanyContentVersionApprovalState {
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly versionNumber: number;
  readonly title: string;
  readonly origin: CompanyContentOrigin;
  readonly source: CompanyContentSourceProvenance;
  readonly contentSha256: string;
  readonly blobSha256: string;
  readonly brandSha256: string;
  readonly approvalRequestId: string | null;
  readonly approvalDecisionId: string | null;
  readonly approvalStatus: CompanyContentApprovalStatus;
  readonly approvalStale: boolean;
}

export type CompanyContentCatalogApprovalStatus =
  | CompanyContentApprovalStatus
  | 'stale';

export interface CompanyContentCatalogCursor {
  readonly beforeCreatedAt: string;
  readonly beforeVersionId: string;
}

export interface CompanyContentCatalogQuery {
  /** Defaults to 50 and is always capped at 100 in SQL. */
  readonly limit?: number;
  readonly cursor?: CompanyContentCatalogCursor | null;
  /** Optional exact source filter, applied in SQL before pagination. */
  readonly sourceSystem?: string;
}

export interface CompanyContentCatalogItem {
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly versionNumber: number;
  readonly origin: CompanyContentOrigin;
  readonly kind: CompanyContentKind;
  readonly title: string;
  readonly contentMimeType: string;
  readonly source: CompanyContentSourceProvenance;
  readonly contentSha256: string;
  readonly blobSha256: string;
  readonly brandSha256: string;
  readonly approvalRequestId: string | null;
  readonly approvalDecisionId: string | null;
  readonly approvalStatus: CompanyContentCatalogApprovalStatus;
  /** True when an older approval no longer covers this latest version. */
  readonly approvalStale: boolean;
  readonly sourceAttestationId: string | null;
  readonly sourceCheckedAt: string | null;
  readonly sourceExpiresAt: string | null;
  readonly sourceFresh: boolean;
  /** Approval and source freshness are independent fail-closed prerequisites. */
  readonly publishable: boolean;
  readonly createdAt: string;
}

export interface CompanyContentCatalogPage {
  readonly items: readonly CompanyContentCatalogItem[];
  readonly nextCursor: CompanyContentCatalogCursor | null;
}

export interface CompanyContentTransactionRunner {
  run<T>(
    context: DatabaseRequestContext,
    operation: (transaction: SqlExecutor) => Promise<T>,
    options: Readonly<{ readOnly: boolean; serializable?: boolean }>,
  ): Promise<T>;
}

export interface CompanyContentServiceDependencies {
  readonly transactionRunner: CompanyContentTransactionRunner;
  readonly nextId?: () => string;
  readonly now?: () => Date;
}

export class CompanyContentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanyContentValidationError';
  }
}

export class CompanyContentIdempotencyConflictError extends Error {
  constructor() {
    super('Company content command key was reused with different input');
    this.name = 'CompanyContentIdempotencyConflictError';
  }
}

export class CompanyContentCommandInProgressError extends Error {
  constructor() {
    super('Company content command is already in progress');
    this.name = 'CompanyContentCommandInProgressError';
  }
}

export class CompanyContentNotFoundError extends Error {
  constructor(entity: string) {
    super(`${entity} was not found in this workspace`);
    this.name = 'CompanyContentNotFoundError';
  }
}

export class CompanyContentVersionConflictError extends Error {
  constructor(message = 'Company content version is no longer current') {
    super(message);
    this.name = 'CompanyContentVersionConflictError';
  }
}

export class CompanyContentApprovalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanyContentApprovalConflictError';
  }
}
