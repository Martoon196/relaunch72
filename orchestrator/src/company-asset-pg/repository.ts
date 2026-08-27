import type { Pool } from 'pg';
import type { SqlExecutor } from '../crm-pg/types.js';
import { withTransaction } from '../db/transaction.js';
import {
  PROPERTY_PREDATOR_COMPANY_ASSET_SOURCE_COMMIT,
  type CompanyAssetFounderApproval,
  type CompanyAssetRelease,
  type CompanyAssetReleaseReconciliation,
} from '../company-asset-release/domain.js';
import type { CompanyAssetEvalReport } from '../company-asset-release/evaluation.js';
import type {
  CompanyAssetQuarantineDimension,
  CompanyAssetQuarantineOutcome,
  CompanyAssetReleaseSummary,
  CompanyAssetTransactionRunner,
} from './types.js';
import type { NormalizedCompanyAssetQuarantineDecision } from './validation.js';

interface ReleaseRow extends Record<string, unknown> {
  sourceReleaseId: string;
  releaseSha256: string;
  sourceCatalogSha256: string;
  scopeSha256: string;
  runtimeBrandSha256: string;
  brandBrainPackageSha256: string;
  approvedItemCount: number | string;
  recordedAt: string;
}

interface IdRow extends Record<string, unknown> { id: string }
interface CompleteRow extends Record<string, unknown> { complete: boolean }

interface AttestationRow extends ReleaseRow {
  sourceAttestationId: string;
  commandKeySha256: string;
  attestationSha256: string;
  checkedAtEpochMicros: string;
  expiresAtEpochMicros: string;
}

interface EvalReportRow extends Record<string, unknown> {
  evaluationReportId: string;
  sourceReleaseId: string;
  releaseSha256: string;
  scopeSha256: string;
  brandBrainPackageSha256: string;
  reportSha256: string;
  caseCount: number | string;
  passedCaseCount: number | string;
  commandKeySha256: string;
}

interface ApprovalRow extends Record<string, unknown> {
  founderApprovalId: string;
  sourceReleaseId: string;
  approvalId: string;
  scopeSha256: string;
  approvalExpiresAt: string;
  approvedAtEpochMicros: string;
  approvalExpiresAtEpochMicros: string;
  commandKeySha256: string;
}

export interface StoredCompanyAssetItem {
  readonly releaseItemId: string;
  readonly sourceReleaseId: string;
  readonly releaseSha256: string;
  readonly scopeSha256: string;
  readonly itemType: 'asset' | 'generated' | 'media';
  readonly itemId: string;
  readonly contentSha256: string;
  readonly brandSha256: string;
}

interface ItemRow extends Record<string, unknown>, StoredCompanyAssetItem {}

interface QuarantineRow extends Record<string, unknown> {
  quarantineDecisionId: string;
  sourceReleaseId: string;
  releaseItemId: string;
  dimension: CompanyAssetQuarantineDimension;
  outcome: CompanyAssetQuarantineOutcome;
  reasonCode: string;
  itemType: string;
  itemId: string;
  evidenceSha256: string;
  commandKeySha256: string;
}

interface ReconciliationRow extends Record<string, unknown> {
  reconciliationId: string;
  sourceReleaseId: string;
  status: 'reconciled' | 'review_required';
  reconciliationReasonCodes: unknown;
  usabilityReasonCodes: unknown;
  guardReasonCodes: unknown;
  usable: boolean;
  domainReconciliationSha256: string;
  founderApprovalId: string | null;
  evaluationReportId: string | null;
  commandKeySha256: string;
}

interface SummaryRow extends ReleaseRow {
  sourceFresh: boolean;
  evaluationPassed: boolean;
  founderApproved: boolean;
  quarantineDecisionComplete: boolean;
  quarantined: boolean;
  latestUsable: boolean;
  latestUsabilityReasonCodes: unknown;
  latestGuardReasonCodes: unknown;
}

function integer(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function textArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} is invalid`);
  }
  return Object.freeze([...value] as string[]);
}

export interface StoredCompanyAssetRelease {
  readonly sourceReleaseId: string;
  readonly releaseSha256: string;
  readonly sourceCatalogSha256: string;
  readonly scopeSha256: string;
  readonly runtimeBrandSha256: string;
  readonly brandBrainPackageSha256: string;
  readonly approvedItemCount: number;
  readonly recordedAt: string;
}

function storedRelease(row: ReleaseRow): StoredCompanyAssetRelease {
  return Object.freeze({
    sourceReleaseId: row.sourceReleaseId,
    releaseSha256: row.releaseSha256,
    sourceCatalogSha256: row.sourceCatalogSha256,
    scopeSha256: row.scopeSha256,
    runtimeBrandSha256: row.runtimeBrandSha256,
    brandBrainPackageSha256: row.brandBrainPackageSha256,
    approvedItemCount: integer(row.approvedItemCount, 'approvedItemCount'),
    recordedAt: row.recordedAt,
  });
}

function releaseColumns(alias: string): string {
  return `${alias}.id::text AS "sourceReleaseId",
          encode(${alias}.release_sha256, 'hex') AS "releaseSha256",
          encode(${alias}.source_catalog_sha256, 'hex') AS "sourceCatalogSha256",
          encode(${alias}.scope_sha256, 'hex') AS "scopeSha256",
          encode(${alias}.runtime_brand_sha256, 'hex') AS "runtimeBrandSha256",
          encode(${alias}.brand_brain_package_sha256, 'hex') AS "brandBrainPackageSha256",
          ${alias}.approved_item_count AS "approvedItemCount",
          ${alias}.recorded_at::text AS "recordedAt"`;
}

export class CompanyAssetPgRepository {
  constructor(private readonly transaction: SqlExecutor) {}

  async lockRelease(releaseSha256: string, scopeSha256: string): Promise<void> {
    await this.transaction.query(
      `/* company-asset.lock-release */
       SELECT pg_catalog.pg_advisory_xact_lock(
         pg_catalog.hashtextextended(
           'company-asset:' || app_private.current_workspace_id()::text || ':' || $1 || ':' || $2,
           7200033
         )
       )`,
      [releaseSha256, scopeSha256],
    );
  }

  async findRelease(release: Pick<CompanyAssetRelease,
    'releaseSha256' | 'sourceCatalogSha256' | 'scopeSha256'> & {
      readonly scope: Pick<CompanyAssetRelease['scope'],
        'runtimeBrandSha256' | 'brandBrainPackageSha256'>;
    }): Promise<StoredCompanyAssetRelease | null> {
    const result = await this.transaction.query<ReleaseRow>(
      `/* company-asset.find-release */
       SELECT ${releaseColumns('release')}
       FROM app_private.company_asset_releases AS release
       WHERE release.release_sha256 = decode($1, 'hex')
         AND release.source_catalog_sha256 = decode($2, 'hex')
         AND release.scope_sha256 = decode($3, 'hex')
         AND release.runtime_brand_sha256 = decode($4, 'hex')
         AND release.brand_brain_package_sha256 = decode($5, 'hex')`,
      [release.releaseSha256, release.sourceCatalogSha256, release.scopeSha256,
        release.scope.runtimeBrandSha256, release.scope.brandBrainPackageSha256],
    );
    if (result.rows.length > 1) throw new Error('Company asset release resolved more than once');
    return result.rows[0] ? storedRelease(result.rows[0]) : null;
  }

  async findReleaseForEvaluation(report: CompanyAssetEvalReport): Promise<StoredCompanyAssetRelease | null> {
    const result = await this.transaction.query<ReleaseRow>(
      `/* company-asset.find-release-for-evaluation */
       SELECT ${releaseColumns('release')}
       FROM app_private.company_asset_releases AS release
       WHERE release.release_sha256 = decode($1, 'hex')
         AND release.scope_sha256 = decode($2, 'hex')
         AND release.brand_brain_package_sha256 = decode($3, 'hex')`,
      [report.sourceReleaseSha256, report.sourceScopeSha256,
        report.brandBrainPackageSha256],
    );
    if (result.rows.length > 1) throw new Error('Company asset evaluation release resolved more than once');
    return result.rows[0] ? storedRelease(result.rows[0]) : null;
  }

  async findReleaseForApproval(
    approval: CompanyAssetFounderApproval,
  ): Promise<StoredCompanyAssetRelease | null> {
    const result = await this.transaction.query<ReleaseRow>(
      `/* company-asset.find-release-for-approval */
       SELECT ${releaseColumns('release')}
       FROM app_private.company_asset_releases AS release
       WHERE release.release_sha256 = decode($1, 'hex')
         AND release.source_catalog_sha256 = decode($2, 'hex')
         AND release.scope_sha256 = decode($3, 'hex')
         AND release.runtime_brand_sha256 = decode($4, 'hex')
         AND release.brand_brain_package_sha256 = decode($5, 'hex')`,
      [approval.scope.releaseSha256, approval.scope.sourceCatalogSha256,
        approval.scopeSha256, approval.scope.runtimeBrandSha256,
        approval.scope.brandBrainPackageSha256],
    );
    if (result.rows.length > 1) throw new Error('Company asset approval release resolved more than once');
    return result.rows[0] ? storedRelease(result.rows[0]) : null;
  }

  async insertRelease(id: string, release: CompanyAssetRelease): Promise<void> {
    const result = await this.transaction.query(
      `/* company-asset.insert-release */
       INSERT INTO app_private.company_asset_releases (
         id, workspace_id, schema_version, release_id, source_system,
         source_commit, generated_at, release_sha256, source_catalog_sha256,
         scope_sha256, runtime_brand_sha256, brand_brain_package_sha256,
         approved_item_count, recorded_by_user_id, recorded_request_id
       ) VALUES (
         $1, app_private.current_workspace_id(), 1, $2, $3, $4, $5,
         decode($6, 'hex'), decode($7, 'hex'), decode($8, 'hex'),
         decode($9, 'hex'), decode($10, 'hex'), $11,
         app_private.current_user_id(), app_private.current_request_id()
       )`,
      [id, release.releaseId, release.sourceSystem,
        PROPERTY_PREDATOR_COMPANY_ASSET_SOURCE_COMMIT, release.generatedAt,
        release.releaseSha256, release.sourceCatalogSha256, release.scopeSha256,
        release.scope.runtimeBrandSha256, release.scope.brandBrainPackageSha256,
        release.approvedItemCount],
    );
    if (result.rowCount !== 1) throw new Error('Company asset release was not inserted');
  }

  async insertReleaseItem(input: {
    readonly id: string;
    readonly sourceReleaseId: string;
    readonly release: CompanyAssetRelease;
    readonly item: CompanyAssetRelease['approvedItems'][number];
    readonly ordinal: number;
  }): Promise<void> {
    const item = input.item;
    const result = await this.transaction.query(
      `/* company-asset.insert-release-item */
       INSERT INTO app_private.company_asset_release_items (
         id, workspace_id, source_release_id, release_sha256,
         source_catalog_sha256, scope_sha256, runtime_brand_sha256,
         brand_brain_package_sha256, item_ordinal, item_id, item_type,
         item_version, version_id, content_sha256, blob_sha256, brand_sha256,
         content_resource_path, asset_resource_path, affiliate_mode,
         approval_id, approved_at, approval_expires_at, approval_expiry_status,
         content_mode, hq_use_status, ownership_status, privacy_status,
         quarantine_status, source_approval_status,
         recorded_by_user_id, recorded_request_id
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, decode($3, 'hex'),
         decode($4, 'hex'), decode($5, 'hex'), decode($6, 'hex'),
         decode($7, 'hex'), $8, $9, $10, $11, $12, decode($13, 'hex'),
         CASE WHEN $14::text IS NULL THEN NULL ELSE decode($14, 'hex') END,
         decode($15, 'hex'), $16, $17, $18, $19, $20, $21, $22,
         $23, $24, $25, $26, $27, $28,
         app_private.current_user_id(), app_private.current_request_id()
       )`,
      [input.id, input.sourceReleaseId, input.release.releaseSha256,
        input.release.sourceCatalogSha256, input.release.scopeSha256,
        input.release.scope.runtimeBrandSha256,
        input.release.scope.brandBrainPackageSha256, input.ordinal,
        item.itemId, item.itemType, item.itemVersion, item.versionId,
        item.contentSha256, item.blobSha256, item.brandSha256,
        item.contentResourcePath, item.assetResourcePath, item.affiliateMode,
        item.approvalId, item.approvedAt, item.approvalExpiresAt,
        item.approvalExpiryStatus, item.contentMode, item.hqUseStatus,
        item.ownershipStatus, item.privacyStatus, item.quarantineStatus,
        item.sourceApprovalStatus],
    );
    if (result.rowCount !== 1) throw new Error('Company asset release item was not inserted');
  }

  async releaseProjectionComplete(sourceReleaseId: string, expectedCount: number): Promise<boolean> {
    const result = await this.transaction.query<CompleteRow>(
      `/* company-asset.release-projection-complete */
       SELECT count(*) = $2
         AND ($2 = 0 OR (min(item_ordinal) = 1 AND max(item_ordinal) = $2))
         AS complete
       FROM app_private.company_asset_release_items
       WHERE source_release_id = $1`,
      [sourceReleaseId, expectedCount],
    );
    return result.rows[0]?.complete === true;
  }

  async findAttestationByCommand(commandKeySha256: string): Promise<AttestationRow | null> {
    const result = await this.transaction.query<AttestationRow>(
      `/* company-asset.find-attestation-by-command */
       SELECT attestation.id::text AS "sourceAttestationId",
              encode(attestation.command_key_sha256, 'hex') AS "commandKeySha256",
              encode(attestation.attestation_sha256, 'hex') AS "attestationSha256",
              (extract(epoch FROM attestation.checked_at) * 1000000)::bigint::text
                AS "checkedAtEpochMicros",
              (extract(epoch FROM attestation.expires_at) * 1000000)::bigint::text
                AS "expiresAtEpochMicros",
              ${releaseColumns('release')}
       FROM app_private.company_asset_source_attestations AS attestation
       JOIN app_private.company_asset_releases AS release
         ON release.workspace_id = attestation.workspace_id
        AND release.id = attestation.source_release_id
       WHERE attestation.command_key_sha256 = decode($1, 'hex')`,
      [commandKeySha256],
    );
    return result.rows[0] ?? null;
  }

  async insertAttestation(input: {
    readonly id: string;
    readonly sourceReleaseId: string;
    readonly release: CompanyAssetRelease;
    readonly attestationSha256: string;
    readonly checkedAt: string;
    readonly expiresAt: string;
    readonly commandKeySha256: string;
  }): Promise<IdRow | null> {
    const result = await this.transaction.query<IdRow>(
      `/* company-asset.insert-attestation */
       INSERT INTO app_private.company_asset_source_attestations (
         id, workspace_id, source_release_id, release_sha256,
         source_catalog_sha256, scope_sha256, runtime_brand_sha256,
         brand_brain_package_sha256, source_commit, attestation_sha256,
         checked_at, expires_at, command_key_sha256,
         recorded_by_user_id, recorded_request_id
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, decode($3, 'hex'),
         decode($4, 'hex'), decode($5, 'hex'), decode($6, 'hex'),
         decode($7, 'hex'), $8, decode($9, 'hex'), $10, $11,
         decode($12, 'hex'), app_private.current_user_id(),
         app_private.current_request_id()
       )
       ON CONFLICT (workspace_id, command_key_sha256) DO NOTHING
       RETURNING id::text AS id`,
      [input.id, input.sourceReleaseId, input.release.releaseSha256,
        input.release.sourceCatalogSha256, input.release.scopeSha256,
        input.release.scope.runtimeBrandSha256,
        input.release.scope.brandBrainPackageSha256,
        PROPERTY_PREDATOR_COMPANY_ASSET_SOURCE_COMMIT,
        input.attestationSha256, input.checkedAt, input.expiresAt,
        input.commandKeySha256],
    );
    return result.rows[0] ?? null;
  }

  async findEvaluationByCommand(commandKeySha256: string): Promise<EvalReportRow | null> {
    const result = await this.transaction.query<EvalReportRow>(
      `/* company-asset.find-evaluation-by-command */
       SELECT report.id::text AS "evaluationReportId",
              report.source_release_id::text AS "sourceReleaseId",
              encode(report.release_sha256, 'hex') AS "releaseSha256",
              encode(report.scope_sha256, 'hex') AS "scopeSha256",
              encode(report.brand_brain_package_sha256, 'hex') AS "brandBrainPackageSha256",
              encode(report.report_sha256, 'hex') AS "reportSha256",
              report.case_count AS "caseCount",
              report.passed_case_count AS "passedCaseCount",
              encode(report.command_key_sha256, 'hex') AS "commandKeySha256"
       FROM app_private.company_asset_eval_reports AS report
       WHERE report.command_key_sha256 = decode($1, 'hex')`,
      [commandKeySha256],
    );
    return result.rows[0] ?? null;
  }

  async findEvaluationByHash(sourceReleaseId: string, reportSha256: string): Promise<EvalReportRow | null> {
    const result = await this.transaction.query<EvalReportRow>(
      `/* company-asset.find-evaluation-by-hash */
       SELECT report.id::text AS "evaluationReportId",
              report.source_release_id::text AS "sourceReleaseId",
              encode(report.release_sha256, 'hex') AS "releaseSha256",
              encode(report.scope_sha256, 'hex') AS "scopeSha256",
              encode(report.brand_brain_package_sha256, 'hex') AS "brandBrainPackageSha256",
              encode(report.report_sha256, 'hex') AS "reportSha256",
              report.case_count AS "caseCount",
              report.passed_case_count AS "passedCaseCount",
              encode(report.command_key_sha256, 'hex') AS "commandKeySha256"
       FROM app_private.company_asset_eval_reports AS report
       WHERE report.source_release_id = $1
         AND report.report_sha256 = decode($2, 'hex')`,
      [sourceReleaseId, reportSha256],
    );
    return result.rows[0] ?? null;
  }

  async insertEvaluationReport(input: {
    readonly id: string;
    readonly release: StoredCompanyAssetRelease;
    readonly report: CompanyAssetEvalReport;
    readonly commandKeySha256: string;
  }): Promise<IdRow | null> {
    const result = await this.transaction.query<IdRow>(
      `/* company-asset.insert-evaluation-report */
       INSERT INTO app_private.company_asset_eval_reports (
         id, workspace_id, source_release_id, release_sha256,
         source_catalog_sha256, scope_sha256, runtime_brand_sha256,
         brand_brain_package_sha256, suite_id, runner_version, case_count,
         golden_case_count, rejected_case_count, passed_case_count,
         report_sha256, command_key_sha256,
         recorded_by_user_id, recorded_request_id
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, decode($3, 'hex'),
         decode($4, 'hex'), decode($5, 'hex'), decode($6, 'hex'),
         decode($7, 'hex'), $8, $9, $10, $11, $12, $13,
         decode($14, 'hex'), decode($15, 'hex'),
         app_private.current_user_id(), app_private.current_request_id()
       )
       ON CONFLICT (workspace_id, command_key_sha256) DO NOTHING
       RETURNING id::text AS id`,
      [input.id, input.release.sourceReleaseId, input.release.releaseSha256,
        input.release.sourceCatalogSha256, input.release.scopeSha256,
        input.release.runtimeBrandSha256, input.release.brandBrainPackageSha256,
        input.report.suiteId, input.report.runnerVersion, input.report.caseCount,
        input.report.goldenCaseCount, input.report.rejectedCaseCount,
        input.report.passedCaseCount, input.report.reportSha256,
        input.commandKeySha256],
    );
    return result.rows[0] ?? null;
  }

  async insertEvaluationCase(input: {
    readonly id: string;
    readonly sourceReleaseId: string;
    readonly evaluationReportId: string;
    readonly entry: CompanyAssetEvalReport['cases'][number];
  }): Promise<void> {
    const entry = input.entry;
    const result = await this.transaction.query(
      `/* company-asset.insert-evaluation-case */
       INSERT INTO app_private.company_asset_eval_cases (
         id, workspace_id, source_release_id, eval_report_id, case_id,
         case_kind, dimension, input_sha256, output_sha256, evidence_sha256,
         expected_disposition, observed_disposition, reason_code,
         recorded_by_user_id, recorded_request_id
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4, $5, $6,
         decode($7, 'hex'), decode($8, 'hex'), decode($9, 'hex'),
         $10, $11, $12, app_private.current_user_id(),
         app_private.current_request_id()
       )`,
      [input.id, input.sourceReleaseId, input.evaluationReportId,
        entry.caseId, entry.caseKind, entry.dimension, entry.inputSha256,
        entry.outputSha256, entry.evidenceSha256, entry.expectedDisposition,
        entry.observedDisposition, entry.reasonCode],
    );
    if (result.rowCount !== 1) throw new Error('Company asset evaluation case was not inserted');
  }

  async evaluationProjectionComplete(
    evaluationReportId: string,
    report: Pick<CompanyAssetEvalReport,
      'caseCount' | 'goldenCaseCount' | 'rejectedCaseCount' | 'passedCaseCount'>,
  ): Promise<boolean> {
    const result = await this.transaction.query<CompleteRow>(
      `/* company-asset.evaluation-projection-complete */
       SELECT count(*) = $2
         AND count(*) FILTER (WHERE case_kind = 'golden') = $3
         AND count(*) FILTER (WHERE case_kind = 'rejected') = $4
         AND count(*) FILTER (WHERE passed) = $5
         AND count(DISTINCT dimension || ':' || case_kind) = 10 AS complete
       FROM app_private.company_asset_eval_cases
       WHERE eval_report_id = $1`,
      [evaluationReportId, report.caseCount, report.goldenCaseCount,
        report.rejectedCaseCount, report.passedCaseCount],
    );
    return result.rows[0]?.complete === true;
  }

  async findApprovalByCommand(commandKeySha256: string): Promise<ApprovalRow | null> {
    const result = await this.transaction.query<ApprovalRow>(
      `/* company-asset.find-approval-by-command */
       SELECT approval.id::text AS "founderApprovalId",
              approval.source_release_id::text AS "sourceReleaseId",
              approval.approval_id AS "approvalId",
              encode(approval.scope_sha256, 'hex') AS "scopeSha256",
              approval.approval_expires_at::text AS "approvalExpiresAt",
              (extract(epoch FROM approval.approved_at) * 1000000)::bigint::text
                AS "approvedAtEpochMicros",
              (extract(epoch FROM approval.approval_expires_at) * 1000000)::bigint::text
                AS "approvalExpiresAtEpochMicros",
              encode(approval.command_key_sha256, 'hex') AS "commandKeySha256"
       FROM app_private.company_asset_founder_approvals AS approval
       WHERE approval.command_key_sha256 = decode($1, 'hex')`,
      [commandKeySha256],
    );
    return result.rows[0] ?? null;
  }

  async findApproval(
    sourceReleaseId: string,
    approvalId: string,
    scopeSha256: string,
  ): Promise<ApprovalRow | null> {
    const result = await this.transaction.query<ApprovalRow>(
      `/* company-asset.find-approval */
       SELECT approval.id::text AS "founderApprovalId",
              approval.source_release_id::text AS "sourceReleaseId",
              approval.approval_id AS "approvalId",
              encode(approval.scope_sha256, 'hex') AS "scopeSha256",
              approval.approval_expires_at::text AS "approvalExpiresAt",
              (extract(epoch FROM approval.approved_at) * 1000000)::bigint::text
                AS "approvedAtEpochMicros",
              (extract(epoch FROM approval.approval_expires_at) * 1000000)::bigint::text
                AS "approvalExpiresAtEpochMicros",
              encode(approval.command_key_sha256, 'hex') AS "commandKeySha256"
       FROM app_private.company_asset_founder_approvals AS approval
       WHERE approval.source_release_id = $1 AND approval.approval_id = $2
         AND approval.scope_sha256 = decode($3, 'hex')`,
      [sourceReleaseId, approvalId, scopeSha256],
    );
    return result.rows[0] ?? null;
  }

  async insertApproval(input: {
    readonly id: string;
    readonly release: StoredCompanyAssetRelease;
    readonly approval: CompanyAssetFounderApproval;
    readonly commandKeySha256: string;
  }): Promise<IdRow | null> {
    const result = await this.transaction.query<IdRow>(
      `/* company-asset.insert-founder-approval */
       INSERT INTO app_private.company_asset_founder_approvals (
         id, workspace_id, source_release_id, release_sha256,
         source_catalog_sha256, scope_sha256, runtime_brand_sha256,
         brand_brain_package_sha256, approval_id, approval_status,
         approval_authority, hq_human_approval, approved_at,
         approval_expires_at, command_key_sha256,
         recorded_by_user_id, recorded_request_id
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, decode($3, 'hex'),
         decode($4, 'hex'), decode($5, 'hex'), decode($6, 'hex'),
         decode($7, 'hex'), $8, $9, $10, $11, $12, $13,
         decode($14, 'hex'), app_private.current_user_id(),
         app_private.current_request_id()
       )
       ON CONFLICT (workspace_id, command_key_sha256) DO NOTHING
       RETURNING id::text AS id`,
      [input.id, input.release.sourceReleaseId, input.release.releaseSha256,
        input.release.sourceCatalogSha256, input.release.scopeSha256,
        input.release.runtimeBrandSha256, input.release.brandBrainPackageSha256,
        input.approval.approvalId, input.approval.approvalStatus,
        input.approval.approvalAuthority, input.approval.hqHumanApproval,
        input.approval.approvedAt, input.approval.approvalExpiresAt,
        input.commandKeySha256],
    );
    return result.rows[0] ?? null;
  }

  async findItem(
    sourceReleaseId: string,
    itemType: StoredCompanyAssetItem['itemType'],
    itemId: string,
  ): Promise<StoredCompanyAssetItem | null> {
    const result = await this.transaction.query<ItemRow>(
      `/* company-asset.find-item */
       SELECT item.id::text AS "releaseItemId",
              item.source_release_id::text AS "sourceReleaseId",
              encode(item.release_sha256, 'hex') AS "releaseSha256",
              encode(item.scope_sha256, 'hex') AS "scopeSha256",
              item.item_type AS "itemType", item.item_id AS "itemId",
              encode(item.content_sha256, 'hex') AS "contentSha256",
              encode(item.brand_sha256, 'hex') AS "brandSha256"
       FROM app_private.company_asset_release_items AS item
       WHERE item.source_release_id = $1 AND item.item_type = $2 AND item.item_id = $3`,
      [sourceReleaseId, itemType, itemId],
    );
    return result.rows[0] ? Object.freeze({ ...result.rows[0] }) : null;
  }

  async findQuarantineByCommand(commandKeySha256: string): Promise<QuarantineRow | null> {
    const result = await this.transaction.query<QuarantineRow>(
      `/* company-asset.find-quarantine-by-command */
       SELECT decision.id::text AS "quarantineDecisionId",
              decision.source_release_id::text AS "sourceReleaseId",
              decision.release_item_id::text AS "releaseItemId",
              decision.decision_dimension AS dimension,
              decision.decision_outcome AS outcome,
              decision.reason_code AS "reasonCode",
              item.item_type AS "itemType", item.item_id AS "itemId",
              encode(decision.evidence_sha256, 'hex') AS "evidenceSha256",
              encode(decision.command_key_sha256, 'hex') AS "commandKeySha256"
       FROM app_private.company_asset_quarantine_decisions AS decision
       JOIN app_private.company_asset_release_items AS item
         ON item.workspace_id = decision.workspace_id
        AND item.source_release_id = decision.source_release_id
        AND item.id = decision.release_item_id
       WHERE decision.command_key_sha256 = decode($1, 'hex')`,
      [commandKeySha256],
    );
    return result.rows[0] ?? null;
  }

  async insertQuarantineDecision(input: {
    readonly id: string;
    readonly item: StoredCompanyAssetItem;
    readonly decision: NormalizedCompanyAssetQuarantineDecision;
  }): Promise<IdRow | null> {
    const result = await this.transaction.query<IdRow>(
      `/* company-asset.insert-quarantine-decision */
       INSERT INTO app_private.company_asset_quarantine_decisions (
         id, workspace_id, source_release_id, release_sha256, scope_sha256,
         release_item_id, item_content_sha256, item_brand_sha256,
         decision_dimension, decision_outcome, reason_code, evidence_sha256,
         command_key_sha256, recorded_by_user_id, recorded_request_id
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, decode($3, 'hex'),
         decode($4, 'hex'), $5, decode($6, 'hex'), decode($7, 'hex'),
         $8, $9, $10, decode($11, 'hex'), decode($12, 'hex'),
         app_private.current_user_id(), app_private.current_request_id()
       )
       ON CONFLICT (workspace_id, command_key_sha256) DO NOTHING
       RETURNING id::text AS id`,
      [input.id, input.item.sourceReleaseId, input.item.releaseSha256,
        input.item.scopeSha256, input.item.releaseItemId,
        input.item.contentSha256, input.item.brandSha256,
        input.decision.dimension, input.decision.outcome,
        input.decision.reasonCode, input.decision.evidenceSha256,
        input.decision.commandKeySha256],
    );
    return result.rows[0] ?? null;
  }

  async findReconciliationByCommand(commandKeySha256: string): Promise<ReconciliationRow | null> {
    const result = await this.transaction.query<ReconciliationRow>(
      `/* company-asset.find-reconciliation-by-command */
       SELECT reconciliation.id::text AS "reconciliationId",
              reconciliation.source_release_id::text AS "sourceReleaseId",
              reconciliation.status,
              reconciliation.reconciliation_reason_codes AS "reconciliationReasonCodes",
              reconciliation.usability_reason_codes AS "usabilityReasonCodes",
              reconciliation.guard_reason_codes AS "guardReasonCodes",
              reconciliation.usable,
              encode(reconciliation.domain_reconciliation_sha256, 'hex')
                AS "domainReconciliationSha256",
              reconciliation.founder_approval_id::text AS "founderApprovalId",
              reconciliation.eval_report_id::text AS "evaluationReportId",
              encode(reconciliation.command_key_sha256, 'hex') AS "commandKeySha256"
       FROM app_private.company_asset_reconciliations AS reconciliation
       WHERE reconciliation.command_key_sha256 = decode($1, 'hex')`,
      [commandKeySha256],
    );
    return result.rows[0] ?? null;
  }

  async insertReconciliation(input: {
    readonly id: string;
    readonly release: StoredCompanyAssetRelease;
    readonly founderApprovalId: string | null;
    readonly evaluationReportId: string | null;
    readonly reconciliation: CompanyAssetReleaseReconciliation;
    readonly commandKeySha256: string;
  }): Promise<ReconciliationRow | null> {
    const result = await this.transaction.query<ReconciliationRow>(
      `/* company-asset.insert-reconciliation */
       INSERT INTO app_private.company_asset_reconciliations (
         id, workspace_id, source_release_id, release_sha256,
         source_catalog_sha256, scope_sha256, runtime_brand_sha256,
         brand_brain_package_sha256, founder_approval_id, eval_report_id,
         evaluated_at, domain_reconciliation_sha256, command_key_sha256,
         recorded_by_user_id, recorded_request_id
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, decode($3, 'hex'),
         decode($4, 'hex'), decode($5, 'hex'), decode($6, 'hex'),
         decode($7, 'hex'), $8, $9, $10, decode($11, 'hex'),
         decode($12, 'hex'), app_private.current_user_id(),
         app_private.current_request_id()
       )
       ON CONFLICT (workspace_id, command_key_sha256) DO NOTHING
       RETURNING id::text AS "reconciliationId",
         source_release_id::text AS "sourceReleaseId", status,
         reconciliation_reason_codes AS "reconciliationReasonCodes",
         usability_reason_codes AS "usabilityReasonCodes",
         guard_reason_codes AS "guardReasonCodes", usable,
         encode(domain_reconciliation_sha256, 'hex') AS "domainReconciliationSha256",
         founder_approval_id::text AS "founderApprovalId",
         eval_report_id::text AS "evaluationReportId",
         encode(command_key_sha256, 'hex') AS "commandKeySha256"`,
      [input.id, input.release.sourceReleaseId, input.release.releaseSha256,
        input.release.sourceCatalogSha256, input.release.scopeSha256,
        input.release.runtimeBrandSha256, input.release.brandBrainPackageSha256,
        input.founderApprovalId, input.evaluationReportId,
        input.reconciliation.evaluatedAt,
        input.reconciliation.reconciliationSha256, input.commandKeySha256],
    );
    return result.rows[0] ?? null;
  }

  reconciliationResult(row: ReconciliationRow): Readonly<{
    reconciliationId: string;
    sourceReleaseId: string;
    status: 'reconciled' | 'review_required';
    reconciliationReasonCodes: readonly string[];
    usabilityReasonCodes: readonly string[];
    guardReasonCodes: readonly string[];
    usable: boolean;
    domainReconciliationSha256: string;
  }> {
    return Object.freeze({
      reconciliationId: row.reconciliationId,
      sourceReleaseId: row.sourceReleaseId,
      status: row.status,
      reconciliationReasonCodes: textArray(
        row.reconciliationReasonCodes,
        'reconciliationReasonCodes',
      ),
      usabilityReasonCodes: textArray(row.usabilityReasonCodes, 'usabilityReasonCodes'),
      guardReasonCodes: textArray(row.guardReasonCodes, 'guardReasonCodes'),
      usable: row.usable === true,
      domainReconciliationSha256: row.domainReconciliationSha256,
    });
  }

  async listReleases(limit: number): Promise<readonly CompanyAssetReleaseSummary[]> {
    const result = await this.transaction.query<SummaryRow>(
      `/* company-asset.list-releases-bounded */
       SELECT ${releaseColumns('release')},
         EXISTS (
           SELECT 1 FROM app_private.company_asset_source_attestations AS attestation
           WHERE attestation.workspace_id = release.workspace_id
             AND attestation.source_release_id = release.id
             AND attestation.release_sha256 = release.release_sha256
             AND attestation.scope_sha256 = release.scope_sha256
             AND attestation.checked_at <= statement_timestamp()
             AND attestation.expires_at > statement_timestamp()
         ) AS "sourceFresh",
         EXISTS (
           SELECT 1 FROM app_private.company_asset_eval_reports AS report
           WHERE report.workspace_id = release.workspace_id
             AND report.source_release_id = release.id
             AND report.passed_case_count = report.case_count
             AND (SELECT count(*) = report.case_count
                    AND count(*) FILTER (WHERE eval_case.case_kind = 'golden')
                      = report.golden_case_count
                    AND count(*) FILTER (WHERE eval_case.case_kind = 'rejected')
                      = report.rejected_case_count
                    AND count(*) FILTER (WHERE eval_case.passed) = report.case_count
                    AND count(DISTINCT eval_case.dimension || ':' || eval_case.case_kind) = 10
                  FROM app_private.company_asset_eval_cases AS eval_case
                  WHERE eval_case.workspace_id = report.workspace_id
                    AND eval_case.eval_report_id = report.id)
         ) AS "evaluationPassed",
         EXISTS (
           SELECT 1 FROM app_private.company_asset_founder_approvals AS approval
           WHERE approval.workspace_id = release.workspace_id
             AND approval.source_release_id = release.id
             AND approval.scope_sha256 = release.scope_sha256
             AND approval.approved_at <= statement_timestamp() + interval '5 minutes'
             AND approval.approval_expires_at > statement_timestamp()
         ) AS "founderApproved",
         NOT EXISTS (
           SELECT 1
           FROM app_private.company_asset_release_items AS item
           CROSS JOIN (VALUES ('visual_policy'), ('claim'), ('asset')) AS required(dimension)
           WHERE item.workspace_id = release.workspace_id
             AND item.source_release_id = release.id
             AND NOT EXISTS (
               SELECT 1 FROM app_private.company_asset_quarantine_decisions AS decision
               WHERE decision.workspace_id = item.workspace_id
                 AND decision.source_release_id = item.source_release_id
                 AND decision.release_item_id = item.id
                 AND decision.decision_dimension = required.dimension
             )
         ) AS "quarantineDecisionComplete",
         EXISTS (
           SELECT 1 FROM app_private.company_asset_quarantine_decisions AS decision
           WHERE decision.workspace_id = release.workspace_id
             AND decision.source_release_id = release.id
             AND decision.decision_outcome = 'quarantined'
         ) AS quarantined,
         COALESCE(latest.usable, false) AS "latestUsable",
         COALESCE(latest.usability_reason_codes, ARRAY[]::text[])
           AS "latestUsabilityReasonCodes",
         COALESCE(latest.guard_reason_codes, ARRAY[]::text[])
           AS "latestGuardReasonCodes"
       FROM app_private.company_asset_releases AS release
       LEFT JOIN LATERAL (
         SELECT reconciliation.usable, reconciliation.usability_reason_codes,
                reconciliation.guard_reason_codes
         FROM app_private.company_asset_reconciliations AS reconciliation
         WHERE reconciliation.workspace_id = release.workspace_id
           AND reconciliation.source_release_id = release.id
         ORDER BY reconciliation.evaluated_at DESC, reconciliation.id DESC
         LIMIT 1
       ) AS latest ON true
       ORDER BY release.recorded_at DESC, release.id DESC
       LIMIT $1`,
      [limit],
    );
    return Object.freeze(result.rows.map((row): CompanyAssetReleaseSummary => Object.freeze({
      sourceReleaseId: row.sourceReleaseId,
      releaseSha256: row.releaseSha256,
      sourceCatalogSha256: row.sourceCatalogSha256,
      scopeSha256: row.scopeSha256,
      runtimeBrandSha256: row.runtimeBrandSha256,
      brandBrainPackageSha256: row.brandBrainPackageSha256,
      approvedItemCount: integer(row.approvedItemCount, 'approvedItemCount'),
      sourceFresh: row.sourceFresh === true,
      evaluationPassed: row.evaluationPassed === true,
      founderApproved: row.founderApproved === true,
      quarantineDecisionComplete: row.quarantineDecisionComplete === true,
      quarantined: row.quarantined === true,
      latestUsable: row.latestUsable === true,
      latestUsabilityReasonCodes: textArray(
        row.latestUsabilityReasonCodes,
        'latestUsabilityReasonCodes',
      ),
      latestGuardReasonCodes: textArray(row.latestGuardReasonCodes, 'latestGuardReasonCodes'),
      generationMode: 'simulated_draft_only',
      providerEffects: false,
      recordedAt: row.recordedAt,
    })));
  }
}

export function createCompanyAssetTransactionRunner(
  pool: Pick<Pool, 'connect'>,
): CompanyAssetTransactionRunner {
  return {
    run: (context, operation, options) => withTransaction(
      pool,
      context,
      operation,
      {
        readOnly: options.readOnly,
        isolation: options.serializable ? 'serializable' : 'read committed',
      },
    ),
  };
}
