import { createHash } from 'node:crypto';
import type { DatabaseRequestContext } from '../db/rls.js';
import { validateDatabaseContext } from '../db/rls.js';
import {
  canonicalPropertyPredatorAiInventoryJson,
  parsePropertyPredatorAiInventory,
} from '../company-content-adapter/property-predator-ai-inventory.js';
import {
  BrandBrainValidationError,
  type ActivateBrandBrainCommand,
  type BrandBrainReviewDecision,
  type BrandBrainReviewDimension,
  type DecideBrandBrainReviewCommand,
  type RecordBrandBrainEvaluationCommand,
  type StageBrandBrainInventoryCommand,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMAND_KEY = /^[\x21-\x7e]{1,200}$/;
const REASON_CODE = /^[a-z][a-z0-9_-]{0,99}$/;
const DIMENSIONS = new Set<BrandBrainReviewDimension>([
  'ownership_licence', 'privacy_security', 'brand_readiness',
]);
const DECISIONS = new Set<BrandBrainReviewDecision>(['approved', 'rejected']);

export const PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_SUITE_V1_SHA256 =
  '88ca474133d36bbc4345f180e9045feb31d9ddec6b2bb0a5eb810c894f22de51';
export const PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_RUNNER_V1 =
  'property-predator-brand-brain-offline-eval/v1';
export const PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_POSITIVE_CASES_V1 = 4;
export const PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_NEGATIVE_CASES_V1 = 5;

function exactText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value !== value.trim()
      || value.length < 1 || value.length > maximum
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new BrandBrainValidationError(`${label} must be bounded trimmed text`);
  }
  return value;
}

function commandKey(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim() || !COMMAND_KEY.test(value)) {
    throw new BrandBrainValidationError('commandKey must be 1-200 printable ASCII characters');
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new BrandBrainValidationError(`${label} must be a UUID`);
  }
  return value.toLowerCase();
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new BrandBrainValidationError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function canonicalInstant(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new BrandBrainValidationError(`${label} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new BrandBrainValidationError(`${label} must be a canonical UTC ISO timestamp`);
  }
  return value;
}

function count(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new BrandBrainValidationError(`${label} must be a bounded non-negative integer`);
  }
  return value as number;
}

export function validateBrandBrainUserContext(context: DatabaseRequestContext): void {
  validateDatabaseContext(context);
  if (context.actorKind !== 'user' || !context.userId) {
    throw new BrandBrainValidationError('Brand Brain commands require an authenticated workspace member');
  }
}

export interface NormalizedStageBrandBrainInventory {
  readonly commandKey: string;
  readonly inventory: ReturnType<typeof parsePropertyPredatorAiInventory>;
  readonly canonicalManifest: string;
  readonly manifestSha256: string;
  readonly runtimeBrandSha256: string;
  readonly checkedAt: string;
  readonly expiresAt: string;
}

export function normalizeStageBrandBrainInventory(
  command: StageBrandBrainInventoryCommand,
): NormalizedStageBrandBrainInventory {
  if (!command || typeof command !== 'object') throw new BrandBrainValidationError('stage command is required');
  const inventory = parsePropertyPredatorAiInventory(command.inventory);
  const checkedAt = canonicalInstant(command.checkedAt, 'checkedAt');
  const expiresAt = canonicalInstant(command.expiresAt, 'expiresAt');
  const checked = Date.parse(checkedAt);
  const expires = Date.parse(expiresAt);
  if (expires <= checked || expires - checked > 15 * 60_000) {
    throw new BrandBrainValidationError('source attestation must expire within 15 minutes');
  }
  const manifestValue = {
    schemaVersion: inventory.schemaVersion,
    inventoryId: inventory.inventoryId,
    sourceSystem: inventory.sourceSystem,
    contract: inventory.contract,
    sources: inventory.sources,
    specialistProfiles: inventory.specialistProfiles,
    artworkReferences: inventory.artworkReferences,
    quarantines: inventory.quarantines,
  };
  const canonicalManifest = canonicalPropertyPredatorAiInventoryJson(manifestValue);
  const manifestSha256 = createHash('sha256').update(canonicalManifest, 'utf8').digest('hex');
  if (manifestSha256 !== inventory.packageSha256) {
    throw new BrandBrainValidationError('verified inventory package hash changed during normalization');
  }
  return Object.freeze({
    commandKey: commandKey(command.commandKey),
    inventory,
    canonicalManifest,
    manifestSha256,
    runtimeBrandSha256: inventory.specialistProfiles[0]!.runtimeBrandSha256,
    checkedAt,
    expiresAt,
  });
}

export interface NormalizedBrandBrainEvaluation {
  readonly commandKey: string;
  readonly sourceReleaseId: string;
  readonly manifestSha256: string;
  readonly evalSuiteSha256: string;
  readonly runnerVersion: string;
  readonly positiveCaseCount: number;
  readonly negativeCaseCount: number;
  readonly passedCaseCount: number;
  readonly passed: boolean;
  readonly resultSha256: string;
}

export function normalizeBrandBrainEvaluation(
  command: RecordBrandBrainEvaluationCommand,
): NormalizedBrandBrainEvaluation {
  if (!command || typeof command !== 'object') throw new BrandBrainValidationError('evaluation command is required');
  const positiveCaseCount = count(command.positiveCaseCount, 'positiveCaseCount', 1000);
  const negativeCaseCount = count(command.negativeCaseCount, 'negativeCaseCount', 1000);
  const evalSuiteSha256 = digest(command.evalSuiteSha256, 'evalSuiteSha256');
  const runnerVersion = exactText(command.runnerVersion, 'runnerVersion', 100);
  if (evalSuiteSha256 !== PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_SUITE_V1_SHA256
      || runnerVersion !== PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_RUNNER_V1
      || positiveCaseCount !== PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_POSITIVE_CASES_V1
      || negativeCaseCount !== PROPERTY_PREDATOR_BRAND_BRAIN_EVAL_NEGATIVE_CASES_V1) {
    throw new BrandBrainValidationError('evaluation evidence is not the trusted offline v1 suite');
  }
  const passedCaseCount = count(command.passedCaseCount, 'passedCaseCount', 2000);
  if (passedCaseCount > positiveCaseCount + negativeCaseCount) {
    throw new BrandBrainValidationError('passedCaseCount exceeds the evaluation case count');
  }
  return Object.freeze({
    commandKey: commandKey(command.commandKey),
    sourceReleaseId: uuid(command.sourceReleaseId, 'sourceReleaseId'),
    manifestSha256: digest(command.manifestSha256, 'manifestSha256'),
    evalSuiteSha256,
    runnerVersion,
    positiveCaseCount,
    negativeCaseCount,
    passedCaseCount,
    passed: passedCaseCount === positiveCaseCount + negativeCaseCount,
    resultSha256: digest(command.resultSha256, 'resultSha256'),
  });
}

export interface NormalizedBrandBrainReview {
  readonly commandKey: string;
  readonly sourceReleaseId: string;
  readonly manifestSha256: string;
  readonly dimension: BrandBrainReviewDimension;
  readonly decision: BrandBrainReviewDecision;
  readonly decisionReasonCode: string | null;
}

export function normalizeBrandBrainReview(
  command: DecideBrandBrainReviewCommand,
): NormalizedBrandBrainReview {
  if (!command || typeof command !== 'object') throw new BrandBrainValidationError('review command is required');
  if (!DIMENSIONS.has(command.dimension)) throw new BrandBrainValidationError('review dimension is invalid');
  if (!DECISIONS.has(command.decision)) throw new BrandBrainValidationError('review decision is invalid');
  const decisionReasonCode = command.decisionReasonCode === undefined || command.decisionReasonCode === null
    || command.decisionReasonCode === '' ? null : command.decisionReasonCode;
  if (decisionReasonCode !== null && (typeof decisionReasonCode !== 'string'
      || !REASON_CODE.test(decisionReasonCode))) {
    throw new BrandBrainValidationError('decisionReasonCode must be a safe reason code');
  }
  if (command.decision === 'rejected' && !decisionReasonCode) {
    throw new BrandBrainValidationError('a rejected review requires a reason code');
  }
  return Object.freeze({
    commandKey: commandKey(command.commandKey),
    sourceReleaseId: uuid(command.sourceReleaseId, 'sourceReleaseId'),
    manifestSha256: digest(command.manifestSha256, 'manifestSha256'),
    dimension: command.dimension,
    decision: command.decision,
    decisionReasonCode,
  });
}

export interface NormalizedBrandBrainActivation {
  readonly commandKey: string;
  readonly sourceReleaseId: string;
  readonly manifestSha256: string;
  readonly evaluationId: string;
  readonly ownershipDecisionId: string;
  readonly privacyDecisionId: string;
  readonly brandDecisionId: string;
}

export function normalizeBrandBrainActivation(
  command: ActivateBrandBrainCommand,
): NormalizedBrandBrainActivation {
  if (!command || typeof command !== 'object') throw new BrandBrainValidationError('activation command is required');
  return Object.freeze({
    commandKey: commandKey(command.commandKey),
    sourceReleaseId: uuid(command.sourceReleaseId, 'sourceReleaseId'),
    manifestSha256: digest(command.manifestSha256, 'manifestSha256'),
    evaluationId: uuid(command.evaluationId, 'evaluationId'),
    ownershipDecisionId: uuid(command.ownershipDecisionId, 'ownershipDecisionId'),
    privacyDecisionId: uuid(command.privacyDecisionId, 'privacyDecisionId'),
    brandDecisionId: uuid(command.brandDecisionId, 'brandDecisionId'),
  });
}
