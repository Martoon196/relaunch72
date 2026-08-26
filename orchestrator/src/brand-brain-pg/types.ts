import type { DatabaseRequestContext } from '../db/rls.js';
import type { SqlExecutor } from '../crm-pg/types.js';
import type { PropertyPredatorAiInventory } from '../company-content-adapter/property-predator-ai-inventory.js';

export type BrandBrainReviewDimension =
  | 'ownership_licence'
  | 'privacy_security'
  | 'brand_readiness';
export type BrandBrainReviewDecision = 'approved' | 'rejected';

export interface StageBrandBrainInventoryCommand {
  readonly commandKey: string;
  readonly inventory: PropertyPredatorAiInventory;
  readonly checkedAt: string;
  readonly expiresAt: string;
}

export interface StageBrandBrainInventoryResult {
  readonly disposition: 'applied' | 'replayed';
  readonly sourceReleaseId: string;
  readonly sourceAttestationId: string;
  readonly manifestSha256: string;
  readonly runtimeBrandSha256: string;
  readonly sourceCount: number;
  readonly specialistCount: number;
  readonly artworkCount: number;
  readonly quarantineCount: number;
  readonly providerEffects: false;
}

export interface RecordBrandBrainEvaluationCommand {
  readonly commandKey: string;
  readonly sourceReleaseId: string;
  readonly manifestSha256: string;
  readonly evalSuiteSha256: string;
  readonly runnerVersion: string;
  readonly positiveCaseCount: number;
  readonly negativeCaseCount: number;
  readonly passedCaseCount: number;
  readonly resultSha256: string;
}

export interface RecordBrandBrainEvaluationResult {
  readonly disposition: 'applied' | 'replayed';
  readonly evaluationId: string;
  readonly sourceReleaseId: string;
  readonly manifestSha256: string;
  readonly passed: boolean;
  readonly providerEffects: false;
}

export interface DecideBrandBrainReviewCommand {
  readonly commandKey: string;
  readonly sourceReleaseId: string;
  readonly manifestSha256: string;
  readonly dimension: BrandBrainReviewDimension;
  readonly decision: BrandBrainReviewDecision;
  readonly decisionReasonCode?: string | null;
}

export interface DecideBrandBrainReviewResult {
  readonly disposition: 'applied' | 'replayed';
  readonly decisionId: string;
  readonly sourceReleaseId: string;
  readonly manifestSha256: string;
  readonly dimension: BrandBrainReviewDimension;
  readonly decision: BrandBrainReviewDecision;
  readonly providerEffects: false;
}

export interface ActivateBrandBrainCommand {
  readonly commandKey: string;
  readonly sourceReleaseId: string;
  readonly manifestSha256: string;
  readonly evaluationId: string;
  readonly ownershipDecisionId: string;
  readonly privacyDecisionId: string;
  readonly brandDecisionId: string;
}

export interface ActivateBrandBrainResult {
  readonly disposition: 'applied' | 'replayed';
  readonly activationId: string;
  readonly sourceReleaseId: string;
  readonly manifestSha256: string;
  readonly providerEffects: false;
}

export interface BrandBrainSourceSummary {
  readonly sourceId: string;
  readonly assetRole: string;
  readonly authorityStatus: string;
  readonly contentSha256: string;
  readonly ownershipStatus: string;
  readonly licenceStatus: string;
  readonly privacyClass: string;
  readonly consumerUse: string;
}

export interface BrandBrainSpecialistSummary {
  readonly profileId: string;
  readonly name: string;
  readonly capabilities: readonly string[];
  readonly runtimeBrandSha256: string;
  readonly sourceStatus: string;
  readonly hqActivationStatus: string;
  readonly runtimeReady: boolean;
  readonly blockedReason: string | null;
}

export interface BrandBrainReviewSummary {
  readonly dimension: BrandBrainReviewDimension;
  readonly decision: BrandBrainReviewDecision;
  readonly decisionId: string;
}

export interface BrandBrainSnapshot {
  readonly sourceReleaseId: string;
  readonly manifestSha256: string;
  readonly runtimeBrandSha256: string;
  readonly sourceSystem: 'property-predator';
  readonly sources: readonly BrandBrainSourceSummary[];
  readonly specialists: readonly BrandBrainSpecialistSummary[];
  readonly artworkCount: number;
  readonly quarantineCount: number;
  readonly visualPolicyConflict: boolean;
  readonly sourceFresh: boolean;
  readonly evaluationPassed: boolean;
  readonly reviews: readonly BrandBrainReviewSummary[];
  readonly activated: boolean;
  readonly providerEffects: false;
  readonly recordedAt: string;
}

export interface BrandBrainTransactionRunner {
  run<T>(
    context: DatabaseRequestContext,
    operation: (transaction: SqlExecutor) => Promise<T>,
    options: Readonly<{ readOnly: boolean; serializable?: boolean }>,
  ): Promise<T>;
}

export interface BrandBrainServiceDependencies {
  readonly transactionRunner: BrandBrainTransactionRunner;
  readonly nextId?: () => string;
  readonly now?: () => Date;
}

export class BrandBrainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrandBrainValidationError';
  }
}

export class BrandBrainConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrandBrainConflictError';
  }
}

export class BrandBrainNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrandBrainNotFoundError';
  }
}
