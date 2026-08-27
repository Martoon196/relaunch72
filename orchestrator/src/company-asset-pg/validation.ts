import { createHash } from 'node:crypto';
import type { DatabaseRequestContext } from '../db/rls.js';
import {
  PROPERTY_PREDATOR_COMPANY_ASSET_SOURCE_COMMIT,
  parseCompanyAssetFounderApproval,
  parseCompanyAssetReleaseBridge,
  reconcileCompanyAssetRelease,
  type CompanyAssetFounderApproval,
  type CompanyAssetRelease,
  type CompanyAssetReleaseReconciliation,
} from '../company-asset-release/domain.js';
import {
  evaluateCompanyAssetRegressionSuite,
  type CompanyAssetEvalReport,
} from '../company-asset-release/evaluation.js';
import {
  CompanyAssetConflictError,
  CompanyAssetValidationError,
  type ApproveCompanyAssetScopeCommand,
  type CompanyAssetQuarantineDimension,
  type CompanyAssetQuarantineOutcome,
  type CompanyAssetQuarantineReasonCode,
  type DecideCompanyAssetQuarantineCommand,
  type RecordCompanyAssetEvaluationCommand,
  type ReconcileCompanyAssetReleaseCommand,
  type StageCompanyAssetReleaseCommand,
} from './types.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/u;
const MAX_COMMAND_KEY_BYTES = 512;
const SOURCE_ATTESTATION_MAX_MS = 15 * 60_000;
const SOURCE_ATTESTATION_CLOCK_SKEW_MS = 5 * 60_000;
const SOURCE_ATTESTATION_FUTURE_SKEW_MS = 30_000;

export interface NormalizedStageCompanyAssetRelease {
  readonly commandKeySha256: string;
  readonly release: CompanyAssetRelease;
  readonly checkedAt: string;
  readonly expiresAt: string;
  readonly attestationSha256: string;
}

export interface NormalizedCompanyAssetEvaluation {
  readonly commandKeySha256: string;
  readonly report: CompanyAssetEvalReport;
}

export interface NormalizedCompanyAssetApproval {
  readonly commandKeySha256: string;
  readonly approval: CompanyAssetFounderApproval;
}

export interface NormalizedCompanyAssetQuarantineDecision {
  readonly commandKeySha256: string;
  readonly sourceReleaseId: string;
  readonly itemType: 'asset' | 'generated' | 'media';
  readonly itemId: string;
  readonly dimension: CompanyAssetQuarantineDimension;
  readonly outcome: CompanyAssetQuarantineOutcome;
  readonly reasonCode: CompanyAssetQuarantineReasonCode;
  readonly evidenceSha256: string;
}

export interface NormalizedCompanyAssetReconciliation {
  readonly commandKeySha256: string;
  readonly release: CompanyAssetRelease;
  readonly founderApproval: CompanyAssetFounderApproval | null;
  readonly evaluationReportSha256: string | null;
  readonly reconciliation: CompanyAssetReleaseReconciliation;
}

function fail(message: string): never {
  throw new CompanyAssetValidationError(`Company asset ${message}`);
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function commandKeySha256(commandKey: string): string {
  if (typeof commandKey !== 'string'
      || commandKey.length < 1
      || commandKey !== commandKey.trim()
      || Buffer.byteLength(commandKey, 'utf8') > MAX_COMMAND_KEY_BYTES
      || /[\u0000-\u001f\u007f]/u.test(commandKey)) {
    return fail('commandKey is invalid');
  }
  return digest(commandKey);
}

export function exactSha256(value: string, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) return fail(`${label} is invalid`);
  return value;
}

export function exactUuid(value: string, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) return fail(`${label} is invalid`);
  return value.toLowerCase();
}

export function exactInstant(value: string, label: string): string {
  const match = typeof value === 'string' ? RFC3339.exec(value) : null;
  if (!match) return fail(`${label} must be a valid RFC3339 instant`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetSign = match[9];
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]!
      || hour > 23 || minute > 59 || second > 59
      || offsetHour > 23 || offsetMinute > 59
      || (offsetSign === '-' && offsetHour === 0 && offsetMinute === 0)
      || !Number.isFinite(Date.parse(value))) {
    return fail(`${label} must be a valid RFC3339 instant`);
  }
  return value;
}

export function instantEpochMicros(value: string, label: string): bigint {
  const instant = exactInstant(value, label);
  const fraction = /\.(\d{1,6})(?:Z|[+-]\d{2}:\d{2})$/u.exec(instant)?.[1] ?? '';
  const wholeSecond = fraction ? instant.replace(`.${fraction}`, '') : instant;
  return BigInt(Date.parse(wholeSecond)) * 1_000n
    + BigInt(fraction.padEnd(6, '0') || '0');
}

export function validateCompanyAssetManagerContext(context: DatabaseRequestContext): void {
  if (context.actorKind !== 'user') fail('manager actorKind must be user');
  exactUuid(context.workspaceId, 'workspaceId');
  if (!context.userId) fail('manager userId is required');
  exactUuid(context.userId, 'userId');
  if (typeof context.requestId !== 'string'
      || !/^[\x21-\x7e]{1,128}$/u.test(context.requestId)) {
    fail('requestId is invalid');
  }
}

export function normalizeStageCompanyAssetRelease(
  command: StageCompanyAssetReleaseCommand,
  now: Date,
): NormalizedStageCompanyAssetRelease {
  const release = parseCompanyAssetReleaseBridge(command.releaseEnvelope);
  const checkedAt = exactInstant(command.checkedAt, 'checkedAt');
  const expiresAt = exactInstant(command.expiresAt, 'expiresAt');
  const checkedMs = Date.parse(checkedAt);
  const expiresMs = Date.parse(expiresAt);
  if (checkedMs < now.getTime() - SOURCE_ATTESTATION_CLOCK_SKEW_MS
      || checkedMs > now.getTime() + SOURCE_ATTESTATION_FUTURE_SKEW_MS) {
    fail('source check is outside the accepted staging window');
  }
  if (expiresMs <= checkedMs || expiresMs > checkedMs + SOURCE_ATTESTATION_MAX_MS) {
    fail('source attestation expiry is invalid');
  }
  const attestationSha256 = digest(JSON.stringify({
    brandBrainPackageSha256: release.scope.brandBrainPackageSha256,
    checkedAt,
    expiresAt,
    releaseSha256: release.releaseSha256,
    runtimeBrandSha256: release.scope.runtimeBrandSha256,
    scopeSha256: release.scopeSha256,
    sourceCatalogSha256: release.sourceCatalogSha256,
    sourceCommit: PROPERTY_PREDATOR_COMPANY_ASSET_SOURCE_COMMIT,
  }));
  return Object.freeze({
    commandKeySha256: commandKeySha256(command.commandKey),
    release,
    checkedAt,
    expiresAt,
    attestationSha256,
  });
}

export function normalizeCompanyAssetEvaluation(
  command: RecordCompanyAssetEvaluationCommand,
): NormalizedCompanyAssetEvaluation {
  return Object.freeze({
    commandKeySha256: commandKeySha256(command.commandKey),
    report: evaluateCompanyAssetRegressionSuite(command.evaluationSuite),
  });
}

export function normalizeCompanyAssetApproval(
  command: ApproveCompanyAssetScopeCommand,
): NormalizedCompanyAssetApproval {
  return Object.freeze({
    commandKeySha256: commandKeySha256(command.commandKey),
    approval: parseCompanyAssetFounderApproval(command.founderApproval),
  });
}

const QUARANTINE_REASON_MATRIX = Object.freeze({
  visual_policy: Object.freeze({
    clear: Object.freeze(['visual_policy_match'] as const),
    quarantined: Object.freeze(['visual_policy_conflict'] as const),
  }),
  claim: Object.freeze({
    clear: Object.freeze(['claims_supported', 'no_claims_present'] as const),
    quarantined: Object.freeze(['claims_unsubstantiated'] as const),
  }),
  asset: Object.freeze({
    clear: Object.freeze(['asset_integrity_verified', 'no_asset_payload'] as const),
    quarantined: Object.freeze(['asset_integrity_failed'] as const),
  }),
}) satisfies Readonly<Record<
  CompanyAssetQuarantineDimension,
  Readonly<Record<CompanyAssetQuarantineOutcome, readonly CompanyAssetQuarantineReasonCode[]>>
>>;

export function normalizeCompanyAssetQuarantineDecision(
  command: DecideCompanyAssetQuarantineCommand,
): NormalizedCompanyAssetQuarantineDecision {
  if (!['asset', 'generated', 'media'].includes(command.itemType)) fail('itemType is invalid');
  if (!SAFE_ITEM_ID.test(command.itemId)) fail('itemId is invalid');
  const matrix: Readonly<Record<
    CompanyAssetQuarantineDimension,
    Readonly<Record<CompanyAssetQuarantineOutcome, readonly CompanyAssetQuarantineReasonCode[]>>
  >> = QUARANTINE_REASON_MATRIX;
  const allowed = matrix[command.dimension]?.[command.outcome];
  if (!allowed || !allowed.includes(command.reasonCode)) {
    fail('quarantine reason and outcome are inconsistent');
  }
  if (command.dimension === 'asset') {
    if (command.itemType === 'asset' && command.reasonCode === 'no_asset_payload') {
      fail('asset item requires asset integrity evidence');
    }
    if (command.itemType !== 'asset' && command.reasonCode !== 'no_asset_payload') {
      fail('non-asset item cannot claim asset payload evidence');
    }
  }
  return Object.freeze({
    commandKeySha256: commandKeySha256(command.commandKey),
    sourceReleaseId: exactUuid(command.sourceReleaseId, 'sourceReleaseId'),
    itemType: command.itemType,
    itemId: command.itemId,
    dimension: command.dimension,
    outcome: command.outcome,
    reasonCode: command.reasonCode,
    evidenceSha256: exactSha256(command.evidenceSha256, 'evidenceSha256'),
  });
}

const MATERIAL_CHANGE_REASONS = new Set([
  'release_hash_changed', 'source_catalog_hash_changed', 'brand_hash_changed',
  'brand_inventory_hash_changed', 'item_added', 'item_removed',
  'item_version_changed', 'item_hash_changed', 'item_status_changed',
  'item_path_changed', 'item_approval_changed', 'scope_changed',
]);

export function normalizeCompanyAssetReconciliation(
  command: ReconcileCompanyAssetReleaseCommand,
): NormalizedCompanyAssetReconciliation {
  const release = parseCompanyAssetReleaseBridge(command.releaseEnvelope);
  const evaluatedAt = exactInstant(command.evaluatedAt, 'evaluatedAt');
  const founderApproval = command.founderApproval === undefined
    || command.founderApproval === null
    ? null
    : parseCompanyAssetFounderApproval(command.founderApproval);
  const reconciliation = reconcileCompanyAssetRelease(
    release,
    founderApproval ?? undefined,
    evaluatedAt,
  );
  if (reconciliation.reconciliationReasonCodes.some((reason) => MATERIAL_CHANGE_REASONS.has(reason))) {
    throw new CompanyAssetConflictError(
      'Company asset reconciliation rejects changed, added, removed or unapproved material',
    );
  }
  return Object.freeze({
    commandKeySha256: commandKeySha256(command.commandKey),
    release,
    founderApproval,
    evaluationReportSha256: command.evaluationReportSha256 == null
      ? null
      : exactSha256(command.evaluationReportSha256, 'evaluationReportSha256'),
    reconciliation,
  });
}

export function boundedCompanyAssetReadLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    return fail('read limit must be between 1 and 50');
  }
  return limit;
}
