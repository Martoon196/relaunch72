import type { DatabaseRequestContext } from '../db/rls.js';
import type { SqlExecutor } from '../crm-pg/types.js';

export type CompanyAssetQuarantineDimension = 'visual_policy' | 'claim' | 'asset';
export type CompanyAssetQuarantineOutcome = 'clear' | 'quarantined';
export type CompanyAssetQuarantineReasonCode =
  | 'visual_policy_match'
  | 'visual_policy_conflict'
  | 'claims_supported'
  | 'claims_unsubstantiated'
  | 'no_claims_present'
  | 'asset_integrity_verified'
  | 'asset_integrity_failed'
  | 'no_asset_payload';

export interface StageCompanyAssetReleaseCommand {
  readonly commandKey: string;
  readonly releaseEnvelope: unknown;
  readonly checkedAt: string;
  readonly expiresAt: string;
}

export interface StageCompanyAssetReleaseResult {
  readonly disposition: 'applied' | 'replayed';
  readonly sourceReleaseId: string;
  readonly sourceAttestationId: string;
  readonly releaseSha256: string;
  readonly sourceCatalogSha256: string;
  readonly scopeSha256: string;
  readonly runtimeBrandSha256: string;
  readonly brandBrainPackageSha256: string;
  readonly approvedItemCount: number;
  readonly usable: false;
  readonly providerEffects: false;
}

export interface RecordCompanyAssetEvaluationCommand {
  readonly commandKey: string;
  readonly evaluationSuite: unknown;
}

export interface RecordCompanyAssetEvaluationResult {
  readonly disposition: 'applied' | 'replayed';
  readonly evaluationReportId: string;
  readonly sourceReleaseId: string;
  readonly reportSha256: string;
  readonly passed: boolean;
  readonly caseCount: number;
  readonly providerEffects: false;
  readonly modelCalls: false;
}

export interface ApproveCompanyAssetScopeCommand {
  readonly commandKey: string;
  readonly founderApproval: unknown;
}

export interface ApproveCompanyAssetScopeResult {
  readonly disposition: 'applied' | 'replayed';
  readonly founderApprovalId: string;
  readonly sourceReleaseId: string;
  readonly approvalId: string;
  readonly scopeSha256: string;
  readonly approvalExpiresAt: string;
  readonly providerEffects: false;
}

export interface DecideCompanyAssetQuarantineCommand {
  readonly commandKey: string;
  readonly sourceReleaseId: string;
  readonly itemType: 'asset' | 'generated' | 'media';
  readonly itemId: string;
  readonly dimension: CompanyAssetQuarantineDimension;
  readonly outcome: CompanyAssetQuarantineOutcome;
  readonly reasonCode: CompanyAssetQuarantineReasonCode;
  readonly evidenceSha256: string;
}

export interface DecideCompanyAssetQuarantineResult {
  readonly disposition: 'applied' | 'replayed';
  readonly quarantineDecisionId: string;
  readonly sourceReleaseId: string;
  readonly releaseItemId: string;
  readonly dimension: CompanyAssetQuarantineDimension;
  readonly outcome: CompanyAssetQuarantineOutcome;
  readonly evidenceSha256: string;
  readonly providerEffects: false;
}

export interface ReconcileCompanyAssetReleaseCommand {
  readonly commandKey: string;
  readonly releaseEnvelope: unknown;
  readonly founderApproval?: unknown;
  readonly evaluationReportSha256?: string | null;
  readonly evaluatedAt: string;
}

export interface ReconcileCompanyAssetReleaseResult {
  readonly disposition: 'applied' | 'replayed';
  readonly reconciliationId: string;
  readonly sourceReleaseId: string;
  readonly status: 'reconciled' | 'review_required';
  readonly reconciliationReasonCodes: readonly string[];
  readonly usabilityReasonCodes: readonly string[];
  readonly guardReasonCodes: readonly string[];
  readonly usable: boolean;
  readonly domainReconciliationSha256: string;
  readonly generationMode: 'simulated_draft_only';
  readonly providerEffects: false;
  readonly modelCalls: false;
  readonly sourceCalls: false;
  readonly publishEffects: false;
}

export interface CompanyAssetReleaseSummary {
  readonly sourceReleaseId: string;
  readonly releaseSha256: string;
  readonly sourceCatalogSha256: string;
  readonly scopeSha256: string;
  readonly runtimeBrandSha256: string;
  readonly brandBrainPackageSha256: string;
  readonly approvedItemCount: number;
  readonly sourceFresh: boolean;
  readonly evaluationPassed: boolean;
  readonly founderApproved: boolean;
  readonly quarantineDecisionComplete: boolean;
  readonly quarantined: boolean;
  readonly latestUsable: boolean;
  readonly latestUsabilityReasonCodes: readonly string[];
  readonly latestGuardReasonCodes: readonly string[];
  readonly generationMode: 'simulated_draft_only';
  readonly providerEffects: false;
  readonly recordedAt: string;
}

export interface CompanyAssetTransactionRunner {
  run<T>(
    context: DatabaseRequestContext,
    operation: (transaction: SqlExecutor) => Promise<T>,
    options: Readonly<{ readOnly: boolean; serializable?: boolean }>,
  ): Promise<T>;
}

export interface CompanyAssetServiceDependencies {
  readonly transactionRunner: CompanyAssetTransactionRunner;
  readonly nextId?: () => string;
  readonly now?: () => Date;
}

export class CompanyAssetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanyAssetValidationError';
  }
}

export class CompanyAssetConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanyAssetConflictError';
  }
}

export class CompanyAssetNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompanyAssetNotFoundError';
  }
}
