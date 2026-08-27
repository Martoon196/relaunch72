import { randomUUID } from 'node:crypto';
import type { DatabaseRequestContext } from '../db/rls.js';
import { CompanyAssetPgRepository } from './repository.js';
import {
  CompanyAssetConflictError,
  CompanyAssetNotFoundError,
  type ApproveCompanyAssetScopeCommand,
  type ApproveCompanyAssetScopeResult,
  type CompanyAssetReleaseSummary,
  type CompanyAssetServiceDependencies,
  type DecideCompanyAssetQuarantineCommand,
  type DecideCompanyAssetQuarantineResult,
  type RecordCompanyAssetEvaluationCommand,
  type RecordCompanyAssetEvaluationResult,
  type ReconcileCompanyAssetReleaseCommand,
  type ReconcileCompanyAssetReleaseResult,
  type StageCompanyAssetReleaseCommand,
  type StageCompanyAssetReleaseResult,
} from './types.js';
import {
  boundedCompanyAssetReadLimit,
  normalizeCompanyAssetApproval,
  normalizeCompanyAssetEvaluation,
  normalizeCompanyAssetQuarantineDecision,
  normalizeCompanyAssetReconciliation,
  normalizeStageCompanyAssetRelease,
  instantEpochMicros,
  validateCompanyAssetManagerContext,
} from './validation.js';

interface PgErrorLike { readonly code?: unknown; readonly message?: unknown }

function pgError(error: unknown): PgErrorLike {
  return error && typeof error === 'object' ? error as PgErrorLike : {};
}

function translateConflict(error: unknown): never {
  const candidate = pgError(error);
  if (candidate.code === '23505' || candidate.code === '23514' || candidate.code === '40001') {
    throw new CompanyAssetConflictError(
      'Company asset immutable evidence changed or was recorded concurrently',
    );
  }
  throw error;
}

function releaseMatches(
  actual: Readonly<{
    releaseSha256: string;
    sourceCatalogSha256: string;
    scopeSha256: string;
    runtimeBrandSha256: string;
    brandBrainPackageSha256: string;
    approvedItemCount: number | string;
  }>,
  expected: Readonly<{
    releaseSha256: string;
    sourceCatalogSha256: string;
    scopeSha256: string;
    runtimeBrandSha256: string;
    brandBrainPackageSha256: string;
    approvedItemCount: number;
  }>,
): boolean {
  return actual.releaseSha256 === expected.releaseSha256
    && actual.sourceCatalogSha256 === expected.sourceCatalogSha256
    && actual.scopeSha256 === expected.scopeSha256
    && actual.runtimeBrandSha256 === expected.runtimeBrandSha256
    && actual.brandBrainPackageSha256 === expected.brandBrainPackageSha256
    && Number(actual.approvedItemCount) === expected.approvedItemCount;
}

export class CompanyAssetService {
  readonly #nextId: () => string;
  readonly #now: () => Date;

  constructor(private readonly dependencies: CompanyAssetServiceDependencies) {
    this.#nextId = dependencies.nextId ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date());
  }

  async stageRelease(
    context: DatabaseRequestContext,
    command: StageCompanyAssetReleaseCommand,
  ): Promise<StageCompanyAssetReleaseResult> {
    validateCompanyAssetManagerContext(context);
    const stage = normalizeStageCompanyAssetRelease(command, this.#now());
    const expected = {
      releaseSha256: stage.release.releaseSha256,
      sourceCatalogSha256: stage.release.sourceCatalogSha256,
      scopeSha256: stage.release.scopeSha256,
      runtimeBrandSha256: stage.release.scope.runtimeBrandSha256,
      brandBrainPackageSha256: stage.release.scope.brandBrainPackageSha256,
      approvedItemCount: stage.release.approvedItemCount,
    };
    try {
      return await this.dependencies.transactionRunner.run(context, async (transaction) => {
        const repository = new CompanyAssetPgRepository(transaction);
        const priorCommand = await repository.findAttestationByCommand(stage.commandKeySha256);
        if (priorCommand) {
          if (!releaseMatches(priorCommand, expected)
              || priorCommand.attestationSha256 !== stage.attestationSha256
              || BigInt(priorCommand.checkedAtEpochMicros)
                !== instantEpochMicros(stage.checkedAt, 'checkedAt')
              || BigInt(priorCommand.expiresAtEpochMicros)
                !== instantEpochMicros(stage.expiresAt, 'expiresAt')) {
            throw new CompanyAssetConflictError('Company asset command key was reused for another release');
          }
          return Object.freeze({
            disposition: 'replayed' as const,
            sourceReleaseId: priorCommand.sourceReleaseId,
            sourceAttestationId: priorCommand.sourceAttestationId,
            ...expected,
            usable: false as const,
            providerEffects: false as const,
          });
        }

        await repository.lockRelease(stage.release.releaseSha256, stage.release.scopeSha256);
        let stored = await repository.findRelease(stage.release);
        if (!stored) {
          const sourceReleaseId = this.#nextId();
          await repository.insertRelease(sourceReleaseId, stage.release);
          for (const [index, item] of stage.release.approvedItems.entries()) {
            await repository.insertReleaseItem({
              id: this.#nextId(),
              sourceReleaseId,
              release: stage.release,
              item,
              ordinal: index + 1,
            });
          }
          stored = await repository.findRelease(stage.release);
          if (!stored) throw new Error('Inserted company asset release was not visible');
        }
        if (!releaseMatches(stored, expected)) {
          throw new CompanyAssetConflictError('Stored company asset release differs from the sealed release');
        }
        if (!await repository.releaseProjectionComplete(
          stored.sourceReleaseId,
          stored.approvedItemCount,
        )) {
          throw new CompanyAssetConflictError('Stored company asset item projection is incomplete');
        }
        const inserted = await repository.insertAttestation({
          id: this.#nextId(),
          sourceReleaseId: stored.sourceReleaseId,
          release: stage.release,
          attestationSha256: stage.attestationSha256,
          checkedAt: stage.checkedAt,
          expiresAt: stage.expiresAt,
          commandKeySha256: stage.commandKeySha256,
        });
        const attestation = await repository.findAttestationByCommand(stage.commandKeySha256);
        if (!attestation || !releaseMatches(attestation, expected)
            || attestation.attestationSha256 !== stage.attestationSha256
            || BigInt(attestation.checkedAtEpochMicros)
              !== instantEpochMicros(stage.checkedAt, 'checkedAt')
            || BigInt(attestation.expiresAtEpochMicros)
              !== instantEpochMicros(stage.expiresAt, 'expiresAt')) {
          throw new CompanyAssetConflictError('Company asset stage replay differs from the sealed release');
        }
        return Object.freeze({
          disposition: inserted ? 'applied' as const : 'replayed' as const,
          sourceReleaseId: stored.sourceReleaseId,
          sourceAttestationId: attestation.sourceAttestationId,
          ...expected,
          usable: false as const,
          providerEffects: false as const,
        });
      }, { readOnly: false, serializable: true });
    } catch (error) {
      translateConflict(error);
    }
  }

  async recordEvaluation(
    context: DatabaseRequestContext,
    command: RecordCompanyAssetEvaluationCommand,
  ): Promise<RecordCompanyAssetEvaluationResult> {
    validateCompanyAssetManagerContext(context);
    const input = normalizeCompanyAssetEvaluation(command);
    try {
      return await this.dependencies.transactionRunner.run(context, async (transaction) => {
        const repository = new CompanyAssetPgRepository(transaction);
        const prior = await repository.findEvaluationByCommand(input.commandKeySha256);
        if (prior) {
          if (prior.reportSha256 !== input.report.reportSha256
              || prior.releaseSha256 !== input.report.sourceReleaseSha256
              || prior.scopeSha256 !== input.report.sourceScopeSha256
              || prior.brandBrainPackageSha256 !== input.report.brandBrainPackageSha256
              || Number(prior.caseCount) !== input.report.caseCount
              || Number(prior.passedCaseCount) !== input.report.passedCaseCount) {
            throw new CompanyAssetConflictError('Company asset evaluation command key was reused');
          }
          if (!await repository.evaluationProjectionComplete(prior.evaluationReportId, input.report)) {
            throw new CompanyAssetConflictError('Stored company asset evaluation projection is incomplete');
          }
          return Object.freeze({
            disposition: 'replayed' as const,
            evaluationReportId: prior.evaluationReportId,
            sourceReleaseId: prior.sourceReleaseId,
            reportSha256: prior.reportSha256,
            passed: input.report.passed,
            caseCount: input.report.caseCount,
            providerEffects: false as const,
            modelCalls: false as const,
          });
        }
        const release = await repository.findReleaseForEvaluation(input.report);
        if (!release) {
          throw new CompanyAssetNotFoundError('Company asset evaluation release was not staged');
        }
        await repository.lockRelease(release.releaseSha256, release.scopeSha256);
        const reportId = this.#nextId();
        const inserted = await repository.insertEvaluationReport({
          id: reportId,
          release,
          report: input.report,
          commandKeySha256: input.commandKeySha256,
        });
        if (inserted) {
          for (const entry of input.report.cases) {
            await repository.insertEvaluationCase({
              id: this.#nextId(),
              sourceReleaseId: release.sourceReleaseId,
              evaluationReportId: inserted.id,
              entry,
            });
          }
        }
        const row = await repository.findEvaluationByCommand(input.commandKeySha256);
        if (!row || row.reportSha256 !== input.report.reportSha256) {
          throw new CompanyAssetConflictError('Company asset evaluation replay differs');
        }
        if (!await repository.evaluationProjectionComplete(row.evaluationReportId, input.report)) {
          throw new CompanyAssetConflictError('Stored company asset evaluation projection is incomplete');
        }
        return Object.freeze({
          disposition: inserted ? 'applied' as const : 'replayed' as const,
          evaluationReportId: row.evaluationReportId,
          sourceReleaseId: row.sourceReleaseId,
          reportSha256: row.reportSha256,
          passed: input.report.passed,
          caseCount: input.report.caseCount,
          providerEffects: false as const,
          modelCalls: false as const,
        });
      }, { readOnly: false, serializable: true });
    } catch (error) {
      translateConflict(error);
    }
  }

  async approveScope(
    context: DatabaseRequestContext,
    command: ApproveCompanyAssetScopeCommand,
  ): Promise<ApproveCompanyAssetScopeResult> {
    validateCompanyAssetManagerContext(context);
    const input = normalizeCompanyAssetApproval(command);
    try {
      return await this.dependencies.transactionRunner.run(context, async (transaction) => {
        const repository = new CompanyAssetPgRepository(transaction);
        const prior = await repository.findApprovalByCommand(input.commandKeySha256);
        if (prior) {
          if (prior.approvalId !== input.approval.approvalId
              || prior.scopeSha256 !== input.approval.scopeSha256
              || BigInt(prior.approvedAtEpochMicros)
                !== instantEpochMicros(input.approval.approvedAt, 'approvedAt')
              || BigInt(prior.approvalExpiresAtEpochMicros)
                !== instantEpochMicros(input.approval.approvalExpiresAt, 'approvalExpiresAt')) {
            throw new CompanyAssetConflictError('Company asset approval command key was reused');
          }
          return Object.freeze({
            disposition: 'replayed' as const,
            founderApprovalId: prior.founderApprovalId,
            sourceReleaseId: prior.sourceReleaseId,
            approvalId: prior.approvalId,
            scopeSha256: prior.scopeSha256,
            approvalExpiresAt: input.approval.approvalExpiresAt,
            providerEffects: false as const,
          });
        }
        const release = await repository.findReleaseForApproval(input.approval);
        if (!release) {
          throw new CompanyAssetConflictError(
            'Founder approval is not bound to an exact staged immutable release scope',
          );
        }
        await repository.lockRelease(release.releaseSha256, release.scopeSha256);
        const inserted = await repository.insertApproval({
          id: this.#nextId(),
          release,
          approval: input.approval,
          commandKeySha256: input.commandKeySha256,
        });
        const row = await repository.findApprovalByCommand(input.commandKeySha256);
        if (!row || row.approvalId !== input.approval.approvalId
            || row.scopeSha256 !== input.approval.scopeSha256
            || BigInt(row.approvedAtEpochMicros)
              !== instantEpochMicros(input.approval.approvedAt, 'approvedAt')
            || BigInt(row.approvalExpiresAtEpochMicros)
              !== instantEpochMicros(input.approval.approvalExpiresAt, 'approvalExpiresAt')) {
          throw new CompanyAssetConflictError('Company asset approval replay differs');
        }
        return Object.freeze({
          disposition: inserted ? 'applied' as const : 'replayed' as const,
          founderApprovalId: row.founderApprovalId,
          sourceReleaseId: row.sourceReleaseId,
          approvalId: row.approvalId,
          scopeSha256: row.scopeSha256,
          approvalExpiresAt: input.approval.approvalExpiresAt,
          providerEffects: false as const,
        });
      }, { readOnly: false, serializable: true });
    } catch (error) {
      translateConflict(error);
    }
  }

  async decideQuarantine(
    context: DatabaseRequestContext,
    command: DecideCompanyAssetQuarantineCommand,
  ): Promise<DecideCompanyAssetQuarantineResult> {
    validateCompanyAssetManagerContext(context);
    const input = normalizeCompanyAssetQuarantineDecision(command);
    try {
      return await this.dependencies.transactionRunner.run(context, async (transaction) => {
        const repository = new CompanyAssetPgRepository(transaction);
        const prior = await repository.findQuarantineByCommand(input.commandKeySha256);
        if (prior) {
          if (prior.sourceReleaseId !== input.sourceReleaseId
              || prior.dimension !== input.dimension || prior.outcome !== input.outcome
              || prior.reasonCode !== input.reasonCode
              || prior.itemType !== input.itemType || prior.itemId !== input.itemId
              || prior.evidenceSha256 !== input.evidenceSha256) {
            throw new CompanyAssetConflictError('Company asset quarantine command key was reused');
          }
          return Object.freeze({
            disposition: 'replayed' as const,
            quarantineDecisionId: prior.quarantineDecisionId,
            sourceReleaseId: prior.sourceReleaseId,
            releaseItemId: prior.releaseItemId,
            dimension: prior.dimension,
            outcome: prior.outcome,
            evidenceSha256: prior.evidenceSha256,
            providerEffects: false as const,
          });
        }
        const item = await repository.findItem(input.sourceReleaseId, input.itemType, input.itemId);
        if (!item) throw new CompanyAssetNotFoundError('Company asset release item was not found');
        await repository.lockRelease(item.releaseSha256, item.scopeSha256);
        const inserted = await repository.insertQuarantineDecision({
          id: this.#nextId(), item, decision: input,
        });
        const row = await repository.findQuarantineByCommand(input.commandKeySha256);
        if (!row || row.releaseItemId !== item.releaseItemId
            || row.dimension !== input.dimension || row.outcome !== input.outcome
            || row.reasonCode !== input.reasonCode
            || row.itemType !== input.itemType || row.itemId !== input.itemId
            || row.evidenceSha256 !== input.evidenceSha256) {
          throw new CompanyAssetConflictError('Company asset quarantine decision replay differs');
        }
        return Object.freeze({
          disposition: inserted ? 'applied' as const : 'replayed' as const,
          quarantineDecisionId: row.quarantineDecisionId,
          sourceReleaseId: row.sourceReleaseId,
          releaseItemId: row.releaseItemId,
          dimension: row.dimension,
          outcome: row.outcome,
          evidenceSha256: row.evidenceSha256,
          providerEffects: false as const,
        });
      }, { readOnly: false, serializable: true });
    } catch (error) {
      translateConflict(error);
    }
  }

  async reconcile(
    context: DatabaseRequestContext,
    command: ReconcileCompanyAssetReleaseCommand,
  ): Promise<ReconcileCompanyAssetReleaseResult> {
    validateCompanyAssetManagerContext(context);
    const input = normalizeCompanyAssetReconciliation(command);
    try {
      return await this.dependencies.transactionRunner.run(context, async (transaction) => {
        const repository = new CompanyAssetPgRepository(transaction);
        const prior = await repository.findReconciliationByCommand(input.commandKeySha256);
        const release = await repository.findRelease(input.release);
        if (!release) throw new CompanyAssetNotFoundError('Company asset release was not staged');
        await repository.lockRelease(release.releaseSha256, release.scopeSha256);
        const approval = input.founderApproval
          ? await repository.findApproval(
            release.sourceReleaseId,
            input.founderApproval.approvalId,
            input.founderApproval.scopeSha256,
          )
          : null;
        if (input.founderApproval && !approval) {
          throw new CompanyAssetConflictError(
            'Company asset reconciliation rejects a missing or changed founder approval',
          );
        }
        const evaluation = input.evaluationReportSha256
          ? await repository.findEvaluationByHash(
            release.sourceReleaseId,
            input.evaluationReportSha256,
          )
          : null;
        if (input.evaluationReportSha256 && !evaluation) {
          throw new CompanyAssetConflictError(
            'Company asset reconciliation rejects missing or changed evaluation evidence',
          );
        }
        if (prior) {
          if (prior.domainReconciliationSha256
                !== input.reconciliation.reconciliationSha256
              || prior.sourceReleaseId !== release.sourceReleaseId
              || prior.founderApprovalId !== (approval?.founderApprovalId ?? null)
              || prior.evaluationReportId !== (evaluation?.evaluationReportId ?? null)) {
            throw new CompanyAssetConflictError('Company asset reconciliation command key was reused');
          }
          return this.reconciliationResult(repository, prior, 'replayed');
        }
        const inserted = await repository.insertReconciliation({
          id: this.#nextId(),
          release,
          founderApprovalId: approval?.founderApprovalId ?? null,
          evaluationReportId: evaluation?.evaluationReportId ?? null,
          reconciliation: input.reconciliation,
          commandKeySha256: input.commandKeySha256,
        });
        const row = inserted
          ?? await repository.findReconciliationByCommand(input.commandKeySha256);
        if (!row || row.domainReconciliationSha256
              !== input.reconciliation.reconciliationSha256
            || row.sourceReleaseId !== release.sourceReleaseId
            || row.founderApprovalId !== (approval?.founderApprovalId ?? null)
            || row.evaluationReportId !== (evaluation?.evaluationReportId ?? null)) {
          throw new CompanyAssetConflictError('Company asset reconciliation replay differs');
        }
        return this.reconciliationResult(
          repository,
          row,
          inserted ? 'applied' : 'replayed',
        );
      }, { readOnly: false, serializable: true });
    } catch (error) {
      translateConflict(error);
    }
  }

  async listReleases(
    context: DatabaseRequestContext,
    input: Readonly<{ limit?: number }> = {},
  ): Promise<readonly CompanyAssetReleaseSummary[]> {
    validateCompanyAssetManagerContext(context);
    const limit = boundedCompanyAssetReadLimit(input.limit);
    return this.dependencies.transactionRunner.run(
      context,
      async (transaction) => new CompanyAssetPgRepository(transaction).listReleases(limit),
      { readOnly: true },
    );
  }

  private reconciliationResult(
    repository: CompanyAssetPgRepository,
    row: Parameters<CompanyAssetPgRepository['reconciliationResult']>[0],
    disposition: 'applied' | 'replayed',
  ): ReconcileCompanyAssetReleaseResult {
    const result = repository.reconciliationResult(row);
    return Object.freeze({
      disposition,
      ...result,
      generationMode: 'simulated_draft_only' as const,
      providerEffects: false as const,
      modelCalls: false as const,
      sourceCalls: false as const,
      publishEffects: false as const,
    });
  }
}
