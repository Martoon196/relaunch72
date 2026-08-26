import type { DatabaseRequestContext } from '../db/rls.js';
import type { SqlExecutor } from '../crm-pg/types.js';

export type LegacyLeadIdentityKind = 'email' | 'phone';

export interface LegacyLeadIdentityInput {
  readonly kind: LegacyLeadIdentityKind;
  readonly value: string;
  /** True only when the source can stand behind this identity. */
  readonly verified: boolean;
  readonly label?: string | null;
  readonly primary?: boolean;
}

export interface LegacyLeadAttributionInput {
  readonly affiliateSourceId?: string | null;
  readonly affiliateName?: string | null;
  readonly affiliateCode?: string | null;
  readonly referralCode?: string | null;
  readonly utmSource?: string | null;
  readonly utmMedium?: string | null;
  readonly utmCampaign?: string | null;
  readonly utmTerm?: string | null;
  readonly utmContent?: string | null;
  readonly referrerUrl?: string | null;
  readonly landingUrl?: string | null;
  readonly attributedAt?: string | null;
  /** Exact source-owned attribution object, retained without field loss. */
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface LegacyLeadRowInput {
  readonly sourceRecordId: string;
  readonly displayName: string;
  readonly companyName?: string | null;
  readonly originalCreatedAt: string;
  readonly identities: readonly LegacyLeadIdentityInput[];
  readonly attribution?: LegacyLeadAttributionInput | null;
  /** Source-integrity reasons that force this row into quarantine after replay checks. */
  readonly sourceQuarantineReasons?: readonly string[];
}

export interface LegacyLeadBatchInput {
  readonly schemaVersion: 1;
  readonly sourceSystem: string;
  readonly batchKey: string;
  readonly rows: readonly LegacyLeadRowInput[];
  /** Dangling source facts retained without fabricating a CRM contact. */
  readonly unresolvedAttributions?: readonly LegacyUnresolvedAttributionInput[];
}

export type LegacyUnresolvedAttributionKind =
  | 'affiliate'
  | 'referral'
  | 'commission'
  | 'attribution';

export type LegacyUnresolvedAttributionReason =
  | 'missing_contact'
  | 'missing_affiliate_owner'
  | 'broken_reference'
  | 'source_integrity_conflict';

export interface LegacyUnresolvedAttributionInput {
  readonly recordKind: LegacyUnresolvedAttributionKind;
  readonly sourceRecordId: string;
  readonly referredSourceRecordId?: string | null;
  readonly originalCreatedAt: string;
  readonly reason: LegacyUnresolvedAttributionReason;
  readonly affiliateSourceId?: string | null;
  readonly affiliateCode?: string | null;
  readonly referralCode?: string | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface NormalizedLegacyLeadIdentity {
  readonly kind: LegacyLeadIdentityKind;
  readonly value: string;
  readonly normalizedValue: string;
  readonly verified: boolean;
  readonly label: string | null;
  readonly primary: boolean;
}

export interface NormalizedLegacyLeadAttribution {
  readonly affiliateSourceId: string | null;
  readonly affiliateName: string | null;
  readonly affiliateCode: string | null;
  readonly referralCode: string | null;
  readonly utmSource: string | null;
  readonly utmMedium: string | null;
  readonly utmCampaign: string | null;
  readonly utmTerm: string | null;
  readonly utmContent: string | null;
  readonly referrerUrl: string | null;
  readonly landingUrl: string | null;
  readonly attributedAt: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface NormalizedLegacyLeadRow {
  readonly sourceRecordId: string;
  readonly displayName: string;
  readonly companyName: string | null;
  readonly originalCreatedAt: string;
  readonly identities: readonly NormalizedLegacyLeadIdentity[];
  readonly attribution: NormalizedLegacyLeadAttribution | null;
  readonly sourceQuarantineReasons: readonly string[];
  readonly payloadJson: string;
  readonly payloadHash: Uint8Array;
}

export interface NormalizedLegacyLeadBatch {
  readonly schemaVersion: 1;
  readonly sourceSystem: string;
  readonly batchKey: string;
  readonly rows: readonly NormalizedLegacyLeadRow[];
  readonly unresolvedAttributions: readonly NormalizedLegacyUnresolvedAttribution[];
  readonly inputJson: string;
  readonly inputHash: Uint8Array;
}

export interface NormalizedLegacyUnresolvedAttribution {
  readonly recordKind: LegacyUnresolvedAttributionKind;
  readonly sourceRecordId: string;
  readonly referredSourceRecordId: string | null;
  readonly originalCreatedAt: string;
  readonly reason: LegacyUnresolvedAttributionReason;
  readonly affiliateSourceId: string | null;
  readonly affiliateCode: string | null;
  readonly referralCode: string | null;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly payloadJson: string;
  readonly payloadHash: Uint8Array;
}

export type LegacyLeadResolution = 'create' | 'match' | 'replay' | 'quarantine';

export interface LegacyLeadDryRunRow {
  readonly ordinal: number;
  readonly sourceRecordId: string;
  readonly resolution: LegacyLeadResolution;
  readonly contactId: string | null;
  readonly reasons: readonly string[];
}

export interface LegacyLeadDryRunReport {
  readonly mode: 'dry_run';
  readonly writes: 0;
  readonly sourceSystem: string;
  readonly batchKey: string;
  readonly inputHash: string;
  readonly rows: readonly LegacyLeadDryRunRow[];
  readonly counts: Readonly<Record<LegacyLeadResolution, number>>;
}

export interface LegacyLeadStageResult {
  readonly disposition: 'staged' | 'replayed';
  readonly batchId: string;
  readonly rowCount: number;
  readonly inputHash: string;
}

export interface LegacyLeadCommitResult {
  readonly disposition: 'committed' | 'replayed';
  readonly batchId: string;
  readonly imported: number;
  readonly matched: number;
  readonly replayed: number;
  readonly quarantined: number;
}

export interface LegacyImportTransactionRunner {
  run<T>(
    context: DatabaseRequestContext,
    operation: (transaction: SqlExecutor) => Promise<T>,
    options: Readonly<{ readOnly: boolean; serializable?: boolean }>,
  ): Promise<T>;
}

export interface LegacyLeadImportDependencies {
  readonly transactionRunner: LegacyImportTransactionRunner;
  readonly nextId?: () => string;
  readonly now?: () => Date;
}

export interface LegacyImportValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class LegacyImportValidationError extends Error {
  constructor(readonly issues: readonly LegacyImportValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
    this.name = 'LegacyImportValidationError';
  }
}

export class LegacyImportConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyImportConflictError';
  }
}
