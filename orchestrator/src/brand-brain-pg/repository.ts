import type { Pool } from 'pg';
import type { SqlExecutor } from '../crm-pg/types.js';
import { withTransaction } from '../db/transaction.js';
import { BrandBrainConflictError } from './types.js';
import type {
  BrandBrainReviewDecision,
  BrandBrainReviewDimension,
  BrandBrainReviewSummary,
  BrandBrainSourceSummary,
  BrandBrainSpecialistSummary,
  BrandBrainSnapshot,
  BrandBrainTransactionRunner,
} from './types.js';
import type {
  NormalizedBrandBrainActivation,
  NormalizedBrandBrainEvaluation,
  NormalizedBrandBrainReview,
  NormalizedStageBrandBrainInventory,
} from './validation.js';

interface ReleaseRow extends Record<string, unknown> {
  sourceReleaseId: string;
  manifestSha256: string;
  runtimeBrandSha256: string;
  sourceCount: number | string;
  specialistCount: number | string;
  artworkCount: number | string;
  quarantineCount: number | string;
  recordedAt: string;
  sourceFresh?: boolean;
  evaluationPassed?: boolean;
  activated?: boolean;
  visualPolicyConflict?: boolean;
}

interface IdRow extends Record<string, unknown> { id: string }
interface EvaluationRow extends IdRow { passed: boolean }
interface ReviewRow extends IdRow {
  dimension: BrandBrainReviewDimension;
  decision: BrandBrainReviewDecision;
}
interface SourceRow extends Record<string, unknown> {
  sourceId: string;
  assetRole: string;
  authorityStatus: string;
  contentSha256: string;
  ownershipStatus: string;
  licenceStatus: string;
  privacyClass: string;
  consumerUse: string;
}
interface SpecialistRow extends Record<string, unknown> {
  profileId: string;
  name: string;
  capabilities: unknown;
  runtimeBrandSha256: string;
  sourceStatus: string;
  hqActivationStatus: string;
}
interface CompleteRow extends Record<string, unknown> { complete: boolean }

function integer(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} is invalid`);
  }
  return Object.freeze([...value] as string[]);
}

export interface BrandBrainReleaseIdentity {
  readonly sourceReleaseId: string;
  readonly manifestSha256: string;
  readonly runtimeBrandSha256: string;
  readonly sourceCount: number;
  readonly specialistCount: number;
  readonly artworkCount: number;
  readonly quarantineCount: number;
  readonly recordedAt: string;
}

function releaseIdentity(row: ReleaseRow): BrandBrainReleaseIdentity {
  return Object.freeze({
    sourceReleaseId: row.sourceReleaseId,
    manifestSha256: row.manifestSha256,
    runtimeBrandSha256: row.runtimeBrandSha256,
    sourceCount: integer(row.sourceCount, 'sourceCount'),
    specialistCount: integer(row.specialistCount, 'specialistCount'),
    artworkCount: integer(row.artworkCount, 'artworkCount'),
    quarantineCount: integer(row.quarantineCount, 'quarantineCount'),
    recordedAt: row.recordedAt,
  });
}

export class BrandBrainPgRepository {
  constructor(private readonly transaction: SqlExecutor) {}

  async lockPackage(packageSha256: string): Promise<void> {
    await this.transaction.query(
      `/* brand-brain.lock-package */
       SELECT pg_catalog.pg_advisory_xact_lock(
         pg_catalog.hashtextextended(
           'brand-brain:' || app_private.current_workspace_id()::text || ':' || $1,
           7200031
         )
       )`,
      [packageSha256],
    );
  }

  async findReleaseByPackage(packageSha256: string): Promise<BrandBrainReleaseIdentity | null> {
    const result = await this.transaction.query<ReleaseRow>(
      `/* brand-brain.find-release-by-package */
       SELECT release.id::text AS "sourceReleaseId",
              encode(release.manifest_sha256, 'hex') AS "manifestSha256",
              encode(release.runtime_brand_sha256, 'hex') AS "runtimeBrandSha256",
              release.source_count AS "sourceCount",
              release.specialist_count AS "specialistCount",
              release.artwork_count AS "artworkCount",
              release.quarantine_count AS "quarantineCount",
              release.recorded_at::text AS "recordedAt"
       FROM app_private.brand_brain_source_releases AS release
       WHERE release.source_package_sha256 = decode($1, 'hex')`,
      [packageSha256],
    );
    if (result.rows.length > 1) throw new Error('Brand Brain package resolved more than once');
    return result.rows[0] ? releaseIdentity(result.rows[0]) : null;
  }

  async isReleaseProjectionComplete(sourceReleaseId: string): Promise<boolean> {
    const result = await this.transaction.query<CompleteRow>(
      `/* brand-brain.verify-release-projection */
       SELECT
         (SELECT count(*) = 11
          FROM app_private.brand_brain_source_version_refs
          WHERE source_release_id = $1)
         AND (SELECT count(*) = 6
              FROM app_private.brand_brain_specialist_profile_refs
              WHERE source_release_id = $1)
         AND (SELECT count(*) = 10
              FROM app_private.brand_brain_artwork_version_refs
              WHERE source_release_id = $1)
         AND (SELECT count(*) = 1
              FROM app_private.brand_brain_quarantines
              WHERE source_release_id = $1)
         AND NOT EXISTS (
           SELECT 1
           FROM app_private.brand_brain_specialist_profile_refs AS profile
           LEFT JOIN app_private.brand_brain_specialist_source_refs AS reference
             ON reference.workspace_id = profile.workspace_id
             AND reference.source_release_id = profile.source_release_id
             AND reference.specialist_profile_ref_id = profile.id
           WHERE profile.source_release_id = $1
           GROUP BY profile.id
           HAVING count(*) FILTER (WHERE reference.reference_kind = 'role') <> 1
             OR count(*) FILTER (WHERE reference.reference_kind = 'policy') <> 1
             OR count(*) FILTER (WHERE reference.reference_kind = 'instruction') <> 1
             OR count(*) FILTER (WHERE reference.reference_kind = 'knowledge') <> 1
         )
         AND NOT EXISTS (
           SELECT 1
           FROM app_private.brand_brain_quarantines AS quarantine
           LEFT JOIN app_private.brand_brain_quarantine_source_refs AS reference
             ON reference.workspace_id = quarantine.workspace_id
             AND reference.source_release_id = quarantine.source_release_id
             AND reference.quarantine_id = quarantine.id
           WHERE quarantine.source_release_id = $1
           GROUP BY quarantine.id
           HAVING count(reference.id) <> 2
         ) AS complete`,
      [sourceReleaseId],
    );
    return result.rows[0]?.complete === true;
  }

  async insertRelease(input: {
    readonly id: string;
    readonly stage: NormalizedStageBrandBrainInventory;
  }): Promise<void> {
    const inventory = input.stage.inventory;
    const result = await this.transaction.query(
      `/* brand-brain.insert-release */
       INSERT INTO app_private.brand_brain_source_releases (
         id, workspace_id, inventory_id, source_system, canonical_manifest,
         source_package_sha256, runtime_brand_sha256,
         source_count, specialist_count, artwork_count, quarantine_count,
         recorded_by_user_id, recorded_request_id
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4,
         decode($5, 'hex'), decode($6, 'hex'), $7, $8, $9, $10,
         app_private.current_user_id(), app_private.current_request_id()
       )`,
      [input.id, inventory.inventoryId, inventory.sourceSystem,
        input.stage.canonicalManifest, input.stage.manifestSha256,
        input.stage.runtimeBrandSha256, inventory.sources.length,
        inventory.specialistProfiles.length, inventory.artworkReferences.length,
        inventory.quarantines.length],
    );
    if (result.rowCount !== 1) throw new Error('Brand Brain source release was not inserted');
  }

  async insertSource(input: {
    readonly id: string;
    readonly releaseId: string;
    readonly source: NormalizedStageBrandBrainInventory['inventory']['sources'][number];
  }): Promise<void> {
    const source = input.source;
    const result = await this.transaction.query(
      `/* brand-brain.insert-source */
       INSERT INTO app_private.brand_brain_source_version_refs (
         id, workspace_id, source_release_id, source_id, asset_role,
         authority_status, repository_path, locator_kind, source_symbol,
         media_type, byte_length, content_sha256, supplied_by,
         ownership_status, licence_status, privacy_class, consumer_use,
         recorded_by_user_id, recorded_request_id
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4, $5, $6, $7, $8,
         $9, $10, decode($11, 'hex'), $12, $13, $14, $15, $16,
         app_private.current_user_id(), app_private.current_request_id()
       )`,
      [input.id, input.releaseId, source.sourceId, source.assetRole,
        source.authorityStatus, source.path, source.locatorKind, source.symbol,
        source.mediaType, source.byteLength, source.contentSha256,
        source.suppliedBy, source.ownershipStatus, source.licenceStatus,
        source.privacyClass, source.consumerUse],
    );
    if (result.rowCount !== 1) throw new Error('Brand Brain source reference was not inserted');
  }

  async insertSpecialist(input: {
    readonly id: string;
    readonly releaseId: string;
    readonly profile: NormalizedStageBrandBrainInventory['inventory']['specialistProfiles'][number];
  }): Promise<void> {
    const profile = input.profile;
    const result = await this.transaction.query(
      `/* brand-brain.insert-specialist */
       INSERT INTO app_private.brand_brain_specialist_profile_refs (
         id, workspace_id, source_release_id, profile_id, profile_name,
         capabilities, runtime_brand_sha256, source_status, hq_activation_status,
         recorded_by_user_id, recorded_request_id
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4, $5::jsonb,
         decode($6, 'hex'), $7, $8,
         app_private.current_user_id(), app_private.current_request_id()
       )`,
      [input.id, input.releaseId, profile.profileId, profile.name,
        JSON.stringify(profile.capabilities), profile.runtimeBrandSha256,
        profile.sourceStatus, profile.hqActivationStatus],
    );
    if (result.rowCount !== 1) throw new Error('Brand Brain specialist was not inserted');
  }

  async insertSpecialistSource(input: {
    readonly id: string;
    readonly releaseId: string;
    readonly profileRefId: string;
    readonly sourceRefId: string;
    readonly kind: 'role' | 'policy' | 'instruction' | 'knowledge';
  }): Promise<void> {
    const result = await this.transaction.query(
      `/* brand-brain.insert-specialist-source */
       INSERT INTO app_private.brand_brain_specialist_source_refs (
         id, workspace_id, source_release_id, specialist_profile_ref_id,
         source_version_ref_id, reference_kind,
         recorded_by_user_id, recorded_request_id
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4, $5,
         app_private.current_user_id(), app_private.current_request_id()
       )`,
      [input.id, input.releaseId, input.profileRefId, input.sourceRefId, input.kind],
    );
    if (result.rowCount !== 1) throw new Error('Brand Brain specialist source link was not inserted');
  }

  async insertArtwork(input: {
    readonly id: string;
    readonly releaseId: string;
    readonly artwork: NormalizedStageBrandBrainInventory['inventory']['artworkReferences'][number];
  }): Promise<void> {
    const artwork = input.artwork;
    const result = await this.transaction.query(
      `/* brand-brain.insert-artwork */
       INSERT INTO app_private.brand_brain_artwork_version_refs (
         id, workspace_id, source_release_id, asset_id, repository_path,
         media_type, byte_length, content_sha256, purpose,
         source_approval_status, hq_use_status, supplied_by,
         ownership_status, licence_status,
         recorded_by_user_id, recorded_request_id
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4, $5, $6,
         decode($7, 'hex'), $8, $9, $10, $11, $12, $13,
         app_private.current_user_id(), app_private.current_request_id()
       )`,
      [input.id, input.releaseId, artwork.assetId, artwork.path, artwork.mediaType,
        artwork.byteLength, artwork.contentSha256, artwork.purpose,
        artwork.sourceApprovalStatus, artwork.hqUseStatus, artwork.suppliedBy,
        artwork.ownershipStatus, artwork.licenceStatus],
    );
    if (result.rowCount !== 1) throw new Error('Brand Brain artwork reference was not inserted');
  }

  async insertQuarantine(input: {
    readonly id: string;
    readonly releaseId: string;
    readonly quarantine: NormalizedStageBrandBrainInventory['inventory']['quarantines'][number];
  }): Promise<void> {
    const quarantine = input.quarantine;
    const result = await this.transaction.query(
      `/* brand-brain.insert-quarantine */
       INSERT INTO app_private.brand_brain_quarantines (
         id, workspace_id, source_release_id, quarantine_id, status,
         reason_code, usable, resolution, rule_ids, evidence_sha256,
         recorded_by_user_id, recorded_request_id
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4, $5,
         false, $6, $7::jsonb, decode($8, 'hex'),
         app_private.current_user_id(), app_private.current_request_id()
       )`,
      [input.id, input.releaseId, quarantine.quarantineId, quarantine.status,
        quarantine.reasonCode, quarantine.resolution, JSON.stringify(quarantine.ruleIds),
        quarantine.evidenceSha256],
    );
    if (result.rowCount !== 1) throw new Error('Brand Brain quarantine was not inserted');
  }

  async insertQuarantineSource(input: {
    readonly id: string;
    readonly releaseId: string;
    readonly quarantineRefId: string;
    readonly sourceRefId: string;
  }): Promise<void> {
    const result = await this.transaction.query(
      `/* brand-brain.insert-quarantine-source */
       INSERT INTO app_private.brand_brain_quarantine_source_refs (
         id, workspace_id, source_release_id, quarantine_id, source_version_ref_id,
         recorded_by_user_id, recorded_request_id
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, $3, $4,
         app_private.current_user_id(), app_private.current_request_id()
       )`,
      [input.id, input.releaseId, input.quarantineRefId, input.sourceRefId],
    );
    if (result.rowCount !== 1) throw new Error('Brand Brain quarantine source link was not inserted');
  }

  async insertAttestation(input: {
    readonly id: string;
    readonly releaseId: string;
    readonly manifestSha256: string;
    readonly checkedAt: string;
    readonly expiresAt: string;
  }): Promise<string> {
    const result = await this.transaction.query<IdRow>(
      `/* brand-brain.insert-attestation */
       INSERT INTO app_private.brand_brain_source_attestations (
         id, workspace_id, source_release_id, manifest_sha256,
         checked_at, expires_at, recorded_by_user_id, recorded_request_id
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, decode($3, 'hex'),
         $4::timestamptz, $5::timestamptz,
         app_private.current_user_id(), app_private.current_request_id()
       )
       ON CONFLICT (
         workspace_id, source_release_id, manifest_sha256, checked_at
       ) DO NOTHING
       RETURNING id::text AS id`,
      [input.id, input.releaseId, input.manifestSha256, input.checkedAt, input.expiresAt],
    );
    if (result.rows[0]) return result.rows[0].id;
    const existing = await this.transaction.query<IdRow & { expiresAt: string }>(
      `/* brand-brain.find-attestation */
       SELECT id::text AS id, expires_at::text AS "expiresAt"
       FROM app_private.brand_brain_source_attestations
       WHERE source_release_id = $1
         AND manifest_sha256 = decode($2, 'hex')
         AND checked_at = $3::timestamptz`,
      [input.releaseId, input.manifestSha256, input.checkedAt],
    );
    const row = existing.rows[0];
    if (!row) throw new Error('Brand Brain attestation conflict was not visible');
    if (Date.parse(row.expiresAt) !== Date.parse(input.expiresAt)) {
      throw new BrandBrainConflictError('Brand Brain attestation identity was reused with a different expiry');
    }
    return row.id;
  }

  async insertEvaluation(id: string, input: NormalizedBrandBrainEvaluation): Promise<EvaluationRow | null> {
    const result = await this.transaction.query<EvaluationRow>(
      `/* brand-brain.insert-evaluation */
       INSERT INTO app_private.brand_brain_eval_results (
         id, workspace_id, source_release_id, manifest_sha256,
         eval_suite_sha256, runner_version, positive_case_count,
         negative_case_count, passed_case_count, passed, result_sha256,
         recorded_by_user_id, recorded_request_id
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, decode($3, 'hex'),
         decode($4, 'hex'), $5, $6, $7, $8, $9, decode($10, 'hex'),
         app_private.current_user_id(), app_private.current_request_id()
       )
       ON CONFLICT (
         workspace_id, source_release_id, manifest_sha256,
         eval_suite_sha256, runner_version
       ) DO NOTHING
       RETURNING id::text AS id, passed`,
      [id, input.sourceReleaseId, input.manifestSha256, input.evalSuiteSha256,
        input.runnerVersion, input.positiveCaseCount, input.negativeCaseCount,
        input.passedCaseCount, input.passed, input.resultSha256],
    );
    return result.rows[0] ?? null;
  }

  async findEvaluation(input: NormalizedBrandBrainEvaluation): Promise<EvaluationRow | null> {
    const result = await this.transaction.query<EvaluationRow & {
      resultSha256: string; positiveCaseCount: number | string;
      negativeCaseCount: number | string; passedCaseCount: number | string;
    }>(
      `/* brand-brain.find-evaluation */
       SELECT id::text AS id, passed,
              encode(result_sha256, 'hex') AS "resultSha256",
              positive_case_count AS "positiveCaseCount",
              negative_case_count AS "negativeCaseCount",
              passed_case_count AS "passedCaseCount"
       FROM app_private.brand_brain_eval_results
       WHERE source_release_id = $1 AND manifest_sha256 = decode($2, 'hex')
         AND eval_suite_sha256 = decode($3, 'hex') AND runner_version = $4`,
      [input.sourceReleaseId, input.manifestSha256, input.evalSuiteSha256, input.runnerVersion],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.resultSha256 !== input.resultSha256
        || integer(row.positiveCaseCount, 'positiveCaseCount') !== input.positiveCaseCount
        || integer(row.negativeCaseCount, 'negativeCaseCount') !== input.negativeCaseCount
        || integer(row.passedCaseCount, 'passedCaseCount') !== input.passedCaseCount) {
      throw new BrandBrainConflictError('Brand Brain evaluation identity was reused with different evidence');
    }
    return row;
  }

  async insertReview(id: string, input: NormalizedBrandBrainReview): Promise<ReviewRow | null> {
    const result = await this.transaction.query<ReviewRow>(
      `/* brand-brain.insert-review */
       INSERT INTO app_private.brand_brain_review_decisions (
         id, workspace_id, source_release_id, manifest_sha256,
         review_dimension, decision, decision_reason_code,
         recorded_by_user_id, recorded_request_id
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, decode($3, 'hex'),
         $4, $5, $6, app_private.current_user_id(), app_private.current_request_id()
       )
       ON CONFLICT (workspace_id, source_release_id, review_dimension) DO NOTHING
       RETURNING id::text AS id, review_dimension AS dimension, decision`,
      [id, input.sourceReleaseId, input.manifestSha256, input.dimension,
        input.decision, input.decisionReasonCode],
    );
    return result.rows[0] ?? null;
  }

  async findReview(input: NormalizedBrandBrainReview): Promise<ReviewRow | null> {
    const result = await this.transaction.query<ReviewRow & {
      manifestSha256: string; decisionReasonCode: string | null;
    }>(
      `/* brand-brain.find-review */
       SELECT id::text AS id, review_dimension AS dimension, decision,
              encode(manifest_sha256, 'hex') AS "manifestSha256",
              decision_reason_code AS "decisionReasonCode"
       FROM app_private.brand_brain_review_decisions
       WHERE source_release_id = $1 AND review_dimension = $2`,
      [input.sourceReleaseId, input.dimension],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.manifestSha256 !== input.manifestSha256 || row.decision !== input.decision
        || row.decisionReasonCode !== input.decisionReasonCode) {
      throw new BrandBrainConflictError('Brand Brain review dimension was reused with different input');
    }
    return row;
  }

  async insertActivation(id: string, input: NormalizedBrandBrainActivation): Promise<IdRow | null> {
    const result = await this.transaction.query<IdRow>(
      `/* brand-brain.insert-activation */
       INSERT INTO app_private.brand_brain_activations (
         id, workspace_id, source_release_id, manifest_sha256, eval_result_id,
         ownership_decision_id, privacy_decision_id, brand_decision_id,
         provider_effects, recorded_by_user_id, recorded_request_id
       ) VALUES (
         $1, app_private.current_workspace_id(), $2, decode($3, 'hex'), $4,
         $5, $6, $7, false,
         app_private.current_user_id(), app_private.current_request_id()
       )
       ON CONFLICT (workspace_id, source_release_id) DO NOTHING
       RETURNING id::text AS id`,
      [id, input.sourceReleaseId, input.manifestSha256, input.evaluationId,
        input.ownershipDecisionId, input.privacyDecisionId, input.brandDecisionId],
    );
    return result.rows[0] ?? null;
  }

  async findActivation(input: NormalizedBrandBrainActivation): Promise<(IdRow & {
    manifestSha256: string; evaluationId: string; ownershipDecisionId: string;
    privacyDecisionId: string; brandDecisionId: string;
  }) | null> {
    const result = await this.transaction.query<IdRow & {
      manifestSha256: string; evaluationId: string; ownershipDecisionId: string;
      privacyDecisionId: string; brandDecisionId: string;
    }>(
      `/* brand-brain.find-activation */
       SELECT id::text AS id, encode(manifest_sha256, 'hex') AS "manifestSha256",
              eval_result_id::text AS "evaluationId",
              ownership_decision_id::text AS "ownershipDecisionId",
              privacy_decision_id::text AS "privacyDecisionId",
              brand_decision_id::text AS "brandDecisionId"
       FROM app_private.brand_brain_activations
       WHERE source_release_id = $1`,
      [input.sourceReleaseId],
    );
    return result.rows[0] ?? null;
  }

  async latestSnapshot(): Promise<BrandBrainSnapshot | null> {
    const releaseResult = await this.transaction.query<ReleaseRow>(
      `/* brand-brain.latest-snapshot-release */
       SELECT release.id::text AS "sourceReleaseId",
              encode(release.manifest_sha256, 'hex') AS "manifestSha256",
              encode(release.runtime_brand_sha256, 'hex') AS "runtimeBrandSha256",
              release.source_count AS "sourceCount",
              release.specialist_count AS "specialistCount",
              release.artwork_count AS "artworkCount",
              release.quarantine_count AS "quarantineCount",
              release.recorded_at::text AS "recordedAt",
              EXISTS (
                SELECT 1 FROM app_private.brand_brain_source_attestations AS attestation
                WHERE attestation.workspace_id = release.workspace_id
                  AND attestation.source_release_id = release.id
                  AND attestation.manifest_sha256 = release.manifest_sha256
                  AND attestation.checked_at <= statement_timestamp()
                  AND attestation.expires_at > statement_timestamp()
              ) AS "sourceFresh",
              EXISTS (
                SELECT 1 FROM app_private.brand_brain_eval_results AS evaluation
                WHERE evaluation.workspace_id = release.workspace_id
                  AND evaluation.source_release_id = release.id
                  AND evaluation.manifest_sha256 = release.manifest_sha256
                  AND evaluation.passed IS TRUE
              ) AS "evaluationPassed",
              EXISTS (
                SELECT 1 FROM app_private.brand_brain_activations AS activation
                WHERE activation.workspace_id = release.workspace_id
                  AND activation.source_release_id = release.id
                  AND activation.manifest_sha256 = release.manifest_sha256
                  AND activation.provider_effects IS FALSE
              ) AS activated,
              EXISTS (
                SELECT 1 FROM app_private.brand_brain_quarantines AS quarantine
                WHERE quarantine.workspace_id = release.workspace_id
                  AND quarantine.source_release_id = release.id
                  AND quarantine.reason_code = 'visual-policy-conflict'
                  AND quarantine.usable IS FALSE
              ) AS "visualPolicyConflict"
       FROM app_private.brand_brain_source_releases AS release
       ORDER BY release.recorded_at DESC, release.id DESC
       LIMIT 1`,
    );
    const release = releaseResult.rows[0];
    if (!release) return null;
    const [sourceResult, specialistResult, reviewResult] = await Promise.all([
      this.transaction.query<SourceRow>(
        `/* brand-brain.latest-snapshot-sources */
         SELECT source_id AS "sourceId", asset_role AS "assetRole",
                authority_status AS "authorityStatus",
                encode(content_sha256, 'hex') AS "contentSha256",
                ownership_status AS "ownershipStatus",
                licence_status AS "licenceStatus", privacy_class AS "privacyClass",
                consumer_use AS "consumerUse"
         FROM app_private.brand_brain_source_version_refs
         WHERE source_release_id = $1 ORDER BY source_id`,
        [release.sourceReleaseId],
      ),
      this.transaction.query<SpecialistRow>(
        `/* brand-brain.latest-snapshot-specialists */
         SELECT profile_id AS "profileId", profile_name AS name, capabilities,
                encode(runtime_brand_sha256, 'hex') AS "runtimeBrandSha256",
                source_status AS "sourceStatus",
                hq_activation_status AS "hqActivationStatus"
         FROM app_private.brand_brain_specialist_profile_refs
         WHERE source_release_id = $1 ORDER BY recorded_at, id`,
        [release.sourceReleaseId],
      ),
      this.transaction.query<ReviewRow>(
        `/* brand-brain.latest-snapshot-reviews */
         SELECT id::text AS id, review_dimension AS dimension, decision
         FROM app_private.brand_brain_review_decisions
         WHERE source_release_id = $1 ORDER BY review_dimension`,
        [release.sourceReleaseId],
      ),
    ]);
    const visualConflict = release.visualPolicyConflict === true;
    const sources: readonly BrandBrainSourceSummary[] = Object.freeze(sourceResult.rows.map((row) => Object.freeze({ ...row })));
    const specialists: readonly BrandBrainSpecialistSummary[] = Object.freeze(specialistResult.rows.map((row) => {
      const capabilities = stringArray(row.capabilities, 'specialist capabilities');
      const imageBlocked = visualConflict && capabilities.includes('image');
      return Object.freeze({
        profileId: row.profileId,
        name: row.name,
        capabilities,
        runtimeBrandSha256: row.runtimeBrandSha256,
        sourceStatus: row.sourceStatus,
        hqActivationStatus: row.hqActivationStatus,
        runtimeReady: release.activated === true && release.sourceFresh === true
          && release.evaluationPassed === true && !imageBlocked,
        blockedReason: imageBlocked ? 'visual_policy_conflict' : null,
      });
    }));
    const reviews: readonly BrandBrainReviewSummary[] = Object.freeze(reviewResult.rows.map((row) => Object.freeze({
      dimension: row.dimension,
      decision: row.decision,
      decisionId: row.id,
    })));
    return Object.freeze({
      sourceReleaseId: release.sourceReleaseId,
      manifestSha256: release.manifestSha256,
      runtimeBrandSha256: release.runtimeBrandSha256,
      sourceSystem: 'property-predator' as const,
      sources,
      specialists,
      artworkCount: integer(release.artworkCount, 'artworkCount'),
      quarantineCount: integer(release.quarantineCount, 'quarantineCount'),
      visualPolicyConflict: visualConflict,
      sourceFresh: release.sourceFresh === true,
      evaluationPassed: release.evaluationPassed === true,
      reviews,
      activated: release.activated === true,
      providerEffects: false,
      recordedAt: release.recordedAt,
    });
  }
}

export function createBrandBrainTransactionRunner(
  pool: Pick<Pool, 'connect'>,
): BrandBrainTransactionRunner {
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
