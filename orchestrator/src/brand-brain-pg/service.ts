import { randomUUID } from 'node:crypto';
import type { DatabaseRequestContext } from '../db/rls.js';
import { BrandBrainPgRepository } from './repository.js';
import {
  BrandBrainConflictError,
  type ActivateBrandBrainCommand,
  type ActivateBrandBrainResult,
  type BrandBrainServiceDependencies,
  type BrandBrainSnapshot,
  type DecideBrandBrainReviewCommand,
  type DecideBrandBrainReviewResult,
  type RecordBrandBrainEvaluationCommand,
  type RecordBrandBrainEvaluationResult,
  type StageBrandBrainInventoryCommand,
  type StageBrandBrainInventoryResult,
} from './types.js';
import {
  normalizeBrandBrainActivation,
  normalizeBrandBrainEvaluation,
  normalizeBrandBrainReview,
  normalizeStageBrandBrainInventory,
  validateBrandBrainUserContext,
} from './validation.js';

interface PgErrorLike { readonly code?: unknown; readonly message?: unknown }

function pgError(error: unknown): PgErrorLike {
  return error && typeof error === 'object' ? error as PgErrorLike : {};
}

function translateConflict(error: unknown): never {
  const candidate = pgError(error);
  if (candidate.code === '23505' || candidate.code === '40001') {
    throw new BrandBrainConflictError('Brand Brain evidence changed or was recorded concurrently');
  }
  throw error;
}

export class BrandBrainService {
  readonly #nextId: () => string;
  readonly #now: () => Date;

  constructor(private readonly dependencies: BrandBrainServiceDependencies) {
    this.#nextId = dependencies.nextId ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date());
  }

  async stageInventory(
    context: DatabaseRequestContext,
    command: StageBrandBrainInventoryCommand,
  ): Promise<StageBrandBrainInventoryResult> {
    validateBrandBrainUserContext(context);
    const stage = normalizeStageBrandBrainInventory(command);
    const now = this.#now().getTime();
    if (Math.abs(Date.parse(stage.checkedAt) - now) > 5 * 60_000) {
      throw new BrandBrainConflictError('Brand Brain source check is outside the accepted staging window');
    }
    try {
      return await this.dependencies.transactionRunner.run(context, async (transaction) => {
        const repository = new BrandBrainPgRepository(transaction);
        await repository.lockPackage(stage.manifestSha256);
        let release = await repository.findReleaseByPackage(stage.manifestSha256);
        const replayed = release !== null;
        if (!release) {
          const sourceReleaseId = this.#nextId();
          await repository.insertRelease({ id: sourceReleaseId, stage });
          const sourceRefs = new Map<string, string>();
          for (const source of stage.inventory.sources) {
            const id = this.#nextId();
            await repository.insertSource({ id, releaseId: sourceReleaseId, source });
            sourceRefs.set(source.sourceId, id);
          }
          for (const profile of stage.inventory.specialistProfiles) {
            const profileRefId = this.#nextId();
            await repository.insertSpecialist({ id: profileRefId, releaseId: sourceReleaseId, profile });
            const references: readonly (readonly [string, 'role' | 'policy' | 'instruction' | 'knowledge'])[] = [
              [profile.roleSourceId, 'role'],
              [profile.policySourceId, 'policy'],
              ...profile.instructionSourceIds.map((id) => [id, 'instruction'] as const),
              ...profile.knowledgeSourceIds.map((id) => [id, 'knowledge'] as const),
            ];
            for (const [sourceId, kind] of references) {
              const sourceRefId = sourceRefs.get(sourceId);
              if (!sourceRefId) throw new Error('Verified specialist source reference was not staged');
              await repository.insertSpecialistSource({
                id: this.#nextId(), releaseId: sourceReleaseId,
                profileRefId, sourceRefId, kind,
              });
            }
          }
          for (const artwork of stage.inventory.artworkReferences) {
            await repository.insertArtwork({ id: this.#nextId(), releaseId: sourceReleaseId, artwork });
          }
          for (const quarantine of stage.inventory.quarantines) {
            const quarantineRefId = this.#nextId();
            await repository.insertQuarantine({
              id: quarantineRefId, releaseId: sourceReleaseId, quarantine,
            });
            for (const sourceId of quarantine.sourceIds) {
              const sourceRefId = sourceRefs.get(sourceId);
              if (!sourceRefId) throw new Error('Verified quarantine source reference was not staged');
              await repository.insertQuarantineSource({
                id: this.#nextId(), releaseId: sourceReleaseId,
                quarantineRefId, sourceRefId,
              });
            }
          }
          release = {
            sourceReleaseId,
            manifestSha256: stage.manifestSha256,
            runtimeBrandSha256: stage.runtimeBrandSha256,
            sourceCount: stage.inventory.sources.length,
            specialistCount: stage.inventory.specialistProfiles.length,
            artworkCount: stage.inventory.artworkReferences.length,
            quarantineCount: stage.inventory.quarantines.length,
            recordedAt: this.#now().toISOString(),
          };
        }
        if (release.manifestSha256 !== stage.manifestSha256
            || release.runtimeBrandSha256 !== stage.runtimeBrandSha256
            || release.sourceCount !== stage.inventory.sources.length
            || release.specialistCount !== stage.inventory.specialistProfiles.length
            || release.artworkCount !== stage.inventory.artworkReferences.length
            || release.quarantineCount !== stage.inventory.quarantines.length) {
          throw new BrandBrainConflictError('Stored Brand Brain release differs from the verified package');
        }
        if (!await repository.isReleaseProjectionComplete(release.sourceReleaseId)) {
          throw new BrandBrainConflictError('Stored Brand Brain release projection is incomplete');
        }
        const sourceAttestationId = await repository.insertAttestation({
          id: this.#nextId(),
          releaseId: release.sourceReleaseId,
          manifestSha256: release.manifestSha256,
          checkedAt: stage.checkedAt,
          expiresAt: stage.expiresAt,
        });
        return Object.freeze({
          disposition: replayed ? 'replayed' as const : 'applied' as const,
          sourceReleaseId: release.sourceReleaseId,
          sourceAttestationId,
          manifestSha256: release.manifestSha256,
          runtimeBrandSha256: release.runtimeBrandSha256,
          sourceCount: release.sourceCount,
          specialistCount: release.specialistCount,
          artworkCount: release.artworkCount,
          quarantineCount: release.quarantineCount,
          providerEffects: false as const,
        });
      }, { readOnly: false, serializable: true });
    } catch (error) {
      translateConflict(error);
    }
  }

  async recordEvaluation(
    context: DatabaseRequestContext,
    command: RecordBrandBrainEvaluationCommand,
  ): Promise<RecordBrandBrainEvaluationResult> {
    validateBrandBrainUserContext(context);
    const input = normalizeBrandBrainEvaluation(command);
    try {
      return await this.dependencies.transactionRunner.run(context, async (transaction) => {
        const repository = new BrandBrainPgRepository(transaction);
        const inserted = await repository.insertEvaluation(this.#nextId(), input);
        const row = inserted ?? await repository.findEvaluation(input);
        if (!row) throw new Error('Brand Brain evaluation conflict was not visible');
        return Object.freeze({
          disposition: inserted ? 'applied' as const : 'replayed' as const,
          evaluationId: row.id,
          sourceReleaseId: input.sourceReleaseId,
          manifestSha256: input.manifestSha256,
          passed: row.passed,
          providerEffects: false as const,
        });
      }, { readOnly: false, serializable: true });
    } catch (error) {
      translateConflict(error);
    }
  }

  async decideReview(
    context: DatabaseRequestContext,
    command: DecideBrandBrainReviewCommand,
  ): Promise<DecideBrandBrainReviewResult> {
    validateBrandBrainUserContext(context);
    const input = normalizeBrandBrainReview(command);
    try {
      return await this.dependencies.transactionRunner.run(context, async (transaction) => {
        const repository = new BrandBrainPgRepository(transaction);
        const inserted = await repository.insertReview(this.#nextId(), input);
        const row = inserted ?? await repository.findReview(input);
        if (!row) throw new Error('Brand Brain review conflict was not visible');
        return Object.freeze({
          disposition: inserted ? 'applied' as const : 'replayed' as const,
          decisionId: row.id,
          sourceReleaseId: input.sourceReleaseId,
          manifestSha256: input.manifestSha256,
          dimension: row.dimension,
          decision: row.decision,
          providerEffects: false as const,
        });
      }, { readOnly: false, serializable: true });
    } catch (error) {
      translateConflict(error);
    }
  }

  async activate(
    context: DatabaseRequestContext,
    command: ActivateBrandBrainCommand,
  ): Promise<ActivateBrandBrainResult> {
    validateBrandBrainUserContext(context);
    const input = normalizeBrandBrainActivation(command);
    try {
      return await this.dependencies.transactionRunner.run(context, async (transaction) => {
        const repository = new BrandBrainPgRepository(transaction);
        const inserted = await repository.insertActivation(this.#nextId(), input);
        let activationId: string;
        if (inserted) {
          activationId = inserted.id;
        } else {
          const existing = await repository.findActivation(input);
          if (!existing) throw new Error('Brand Brain activation conflict was not visible');
          if (existing.manifestSha256 !== input.manifestSha256
              || existing.evaluationId !== input.evaluationId
              || existing.ownershipDecisionId !== input.ownershipDecisionId
              || existing.privacyDecisionId !== input.privacyDecisionId
              || existing.brandDecisionId !== input.brandDecisionId) {
            throw new BrandBrainConflictError('Brand Brain release was activated with different evidence');
          }
          activationId = existing.id;
        }
        return Object.freeze({
          disposition: inserted ? 'applied' as const : 'replayed' as const,
          activationId,
          sourceReleaseId: input.sourceReleaseId,
          manifestSha256: input.manifestSha256,
          providerEffects: false as const,
        });
      }, { readOnly: false, serializable: true });
    } catch (error) {
      translateConflict(error);
    }
  }

  async latestSnapshot(context: DatabaseRequestContext): Promise<BrandBrainSnapshot | null> {
    validateBrandBrainUserContext(context);
    return this.dependencies.transactionRunner.run(context, async (transaction) => (
      new BrandBrainPgRepository(transaction).latestSnapshot()
    ), { readOnly: true });
  }
}
