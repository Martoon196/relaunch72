import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_SOURCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;
const SAFE_ERROR = /^[a-z][a-z0-9_.:-]{0,99}$/u;

export interface PublicSocialRevalidationLease {
  readonly workerId: string;
  readonly token: Uint8Array;
}

export interface PublicSocialRevalidationMediaClaim {
  readonly ordinal: number;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly sourceSystem: string;
  readonly sourceItemId: string;
  readonly sourceVersion: string;
  readonly sourceResourceVersionId: string;
  readonly sourceApprovalId: string;
  readonly sourceApprovedAt: string;
  readonly contentSha256: string;
  readonly blobSha256: string;
  readonly brandSha256: string;
}

interface PublicSocialRevalidationClaimBase {
  readonly jobId: string;
  readonly workspaceId: string;
  readonly intentId: string;
  readonly leaseVersion: number;
  readonly desiredFor: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly sourceSystem: string;
  readonly sourceItemId: string;
  readonly sourceVersion: string;
  readonly contentSha256: string;
  readonly blobSha256: string;
  readonly brandSha256: string;
  readonly media: readonly PublicSocialRevalidationMediaClaim[];
}

export interface LegacyPublicSocialRevalidationClaim extends PublicSocialRevalidationClaimBase {
  readonly evidenceType: 'legacy';
  readonly sourceResourceVersionId: string;
  readonly sourceApprovalId: string;
  readonly sourceApprovedAt: string;
}

export interface GeneratedPublicSocialRevalidationClaim extends PublicSocialRevalidationClaimBase {
  readonly evidenceType: 'generated';
  readonly generatedSourceItemId: string;
  readonly generatedSourceVersionId: string;
  readonly generatedSourceItemVersion: number;
  readonly generatedContentSha256: string;
  readonly generatedBrandSha256: string;
  readonly generatedLineage: readonly Readonly<Record<string, unknown>>[];
}

export type PublicSocialRevalidationClaim =
  | LegacyPublicSocialRevalidationClaim
  | GeneratedPublicSocialRevalidationClaim;

export interface PublicSocialRevalidationSourceProof {
  readonly sourceCatalogSha256: string;
  readonly checkedAt: string;
  readonly expiresAt: string;
  readonly content: Readonly<{
    evidenceType: 'legacy';
    sourceResourceVersionId: string;
    sourceApprovalId: string;
    sourceApprovedAt: string;
  } | {
    evidenceType: 'generated';
    generatedSourceItemId: string;
    generatedSourceVersionId: string;
    generatedSourceItemVersion: number;
    generatedContentSha256: string;
    generatedBrandSha256: string;
  }>;
  readonly media: readonly Readonly<{
    sourceResourceVersionId: string;
    sourceApprovalId: string;
    sourceApprovedAt: string;
  }>[];
}

export interface PublicSocialMaterializationResult {
  readonly proofId: string;
  readonly postId: string;
  readonly operationIds: readonly string[];
  readonly disposition: 'applied' | 'replayed';
}

interface ClaimRow extends QueryResultRow {
  jobId: unknown;
  workspaceId: unknown;
  intentId: unknown;
  leaseVersion: unknown;
  desiredFor: unknown;
  contentItemId: unknown;
  contentVersionId: unknown;
  sourceSystem: unknown;
  sourceItemId: unknown;
  sourceVersion: unknown;
  sourceResourceVersionId: unknown;
  sourceApprovalId: unknown;
  sourceApprovedAt: unknown;
  evidenceType: unknown;
  generatedSourceItemId: unknown;
  generatedSourceVersionId: unknown;
  generatedSourceItemVersion: unknown;
  generatedContentSha256: unknown;
  generatedBrandSha256: unknown;
  generatedLineage: unknown;
  contentSha256: unknown;
  blobSha256: unknown;
  brandSha256: unknown;
  media: unknown;
}

type QueuePool = Pick<Pool, 'query' | 'connect'>;

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error(`Revalidation ${label} is invalid`);
  }
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`Revalidation ${label} is invalid`);
  }
  return value;
}

function source(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_SOURCE.test(value)) {
    throw new Error(`Revalidation ${label} is invalid`);
  }
  return value;
}

function safeInteger(value: unknown, label: string): number {
  const number = typeof value === 'string' && /^[1-9][0-9]*$/u.test(value)
    ? Number(value) : value;
  if (!Number.isSafeInteger(number) || (number as number) < 1) {
    throw new Error(`Revalidation ${label} is invalid`);
  }
  return number as number;
}

function instant(value: unknown, label: string): string {
  const candidate = value instanceof Date ? value.toISOString() : value;
  if (typeof candidate !== 'string' || !Number.isFinite(Date.parse(candidate))) {
    throw new Error(`Revalidation ${label} is invalid`);
  }
  return new Date(candidate).toISOString();
}

function sourceInstant(value: unknown, label: string): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 80
      || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Revalidation ${label} is invalid`);
  }
  return value;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function mediaClaim(value: unknown, index: number): PublicSocialRevalidationMediaClaim {
  if (!plainRecord(value)) throw new Error('Revalidation media evidence is invalid');
  const ordinal = safeInteger(value.ordinal, 'media ordinal');
  if (ordinal !== index + 1 || ordinal > 10) {
    throw new Error('Revalidation media order is invalid');
  }
  return Object.freeze({
    ordinal,
    contentItemId: uuid(value.contentItemId, 'media content item'),
    contentVersionId: uuid(value.contentVersionId, 'media content version'),
    sourceSystem: source(value.sourceSystem, 'media source system'),
    sourceItemId: source(value.sourceItemId, 'media source item'),
    sourceVersion: source(value.sourceVersion, 'media source version'),
    sourceResourceVersionId: uuid(value.sourceResourceVersionId, 'media source resource version'),
    sourceApprovalId: uuid(value.sourceApprovalId, 'media source approval'),
    sourceApprovedAt: sourceInstant(value.sourceApprovedAt, 'media source approval time'),
    contentSha256: sha(value.contentSha256, 'media content digest'),
    blobSha256: sha(value.blobSha256, 'media blob digest'),
    brandSha256: sha(value.brandSha256, 'media brand digest'),
  });
}

function claim(row: ClaimRow): PublicSocialRevalidationClaim {
  if (!Array.isArray(row.media) || row.media.length > 10) {
    throw new Error('Revalidation media evidence is invalid');
  }
  const common = {
    jobId: uuid(row.jobId, 'job id'),
    workspaceId: uuid(row.workspaceId, 'workspace id'),
    intentId: uuid(row.intentId, 'intent id'),
    leaseVersion: safeInteger(row.leaseVersion, 'lease version'),
    desiredFor: instant(row.desiredFor, 'desired time'),
    contentItemId: uuid(row.contentItemId, 'content item'),
    contentVersionId: uuid(row.contentVersionId, 'content version'),
    sourceSystem: source(row.sourceSystem, 'source system'),
    sourceItemId: source(row.sourceItemId, 'source item'),
    sourceVersion: source(row.sourceVersion, 'source version'),
    contentSha256: sha(row.contentSha256, 'content digest'),
    blobSha256: sha(row.blobSha256, 'blob digest'),
    brandSha256: sha(row.brandSha256, 'brand digest'),
    media: Object.freeze(row.media.map(mediaClaim)),
  };
  if (row.evidenceType === 'legacy') {
    if (row.generatedSourceItemId != null || row.generatedSourceVersionId != null
        || row.generatedSourceItemVersion != null || row.generatedContentSha256 != null
        || row.generatedBrandSha256 != null || row.generatedLineage != null) {
      throw new Error('Revalidation claim mixes legacy and generated evidence');
    }
    return Object.freeze({ ...common, evidenceType: 'legacy' as const,
      sourceResourceVersionId: uuid(row.sourceResourceVersionId, 'source resource version'),
      sourceApprovalId: uuid(row.sourceApprovalId, 'source approval'),
      sourceApprovedAt: sourceInstant(row.sourceApprovedAt, 'source approval time') });
  }
  if (row.evidenceType !== 'generated' || row.sourceResourceVersionId != null
      || row.sourceApprovalId != null || row.sourceApprovedAt != null
      || !Array.isArray(row.generatedLineage)) {
    throw new Error('Revalidation claim evidence discriminator is invalid');
  }
  return Object.freeze({ ...common, evidenceType: 'generated' as const,
    generatedSourceItemId: uuid(row.generatedSourceItemId, 'generated source item'),
    generatedSourceVersionId: uuid(row.generatedSourceVersionId, 'generated source version'),
    generatedSourceItemVersion: safeInteger(row.generatedSourceItemVersion, 'generated source item version'),
    generatedContentSha256: sha(row.generatedContentSha256, 'generated content digest'),
    generatedBrandSha256: sha(row.generatedBrandSha256, 'generated brand digest'),
    generatedLineage: Object.freeze(row.generatedLineage.map((item) => {
      if (!plainRecord(item)) throw new Error('Revalidation generated lineage is invalid');
      return Object.freeze({ ...item });
    })) });
}

export function publicSocialRevalidationLeaseHash(
  lease: PublicSocialRevalidationLease,
): Buffer {
  if (!UUID.test(lease.workerId) || Buffer.from(lease.token).byteLength !== 32) {
    throw new Error('Revalidation lease identity is invalid');
  }
  return createHash('sha256').update(lease.token).digest();
}

export class PgPublicSocialRevalidationQueue {
  constructor(private readonly pool: QueuePool) {}

  async claim(
    lease: PublicSocialRevalidationLease,
    leaseSeconds = 300,
  ): Promise<PublicSocialRevalidationClaim | null> {
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 300) {
      throw new Error('Revalidation lease duration is invalid');
    }
    const result = await this.pool.query<ClaimRow>(
      `/* public-social-revalidator.claim */
       SELECT job_id AS "jobId", workspace_id AS "workspaceId",
              intent_id AS "intentId", lease_version AS "leaseVersion",
              desired_for AS "desiredFor", content_item_id AS "contentItemId",
              content_version_id AS "contentVersionId",
              source_system AS "sourceSystem", source_item_id AS "sourceItemId",
              source_version AS "sourceVersion",
              evidence_type AS "evidenceType",
              source_resource_version_id AS "sourceResourceVersionId",
              source_approval_id AS "sourceApprovalId",
              source_approved_at AS "sourceApprovedAt",
              generated_source_item_id AS "generatedSourceItemId",
              generated_source_version_id AS "generatedSourceVersionId",
              generated_source_item_version AS "generatedSourceItemVersion",
              generated_content_sha256 AS "generatedContentSha256",
              generated_brand_sha256 AS "generatedBrandSha256",
              generated_lineage AS "generatedLineage",
              content_sha256 AS "contentSha256",
              blob_sha256 AS "blobSha256", brand_sha256 AS "brandSha256", media
      FROM app_private.claim_due_test_social_revalidations_v2($1, $2, 1, $3)`,
      [lease.workerId, publicSocialRevalidationLeaseHash(lease), leaseSeconds],
    );
    if (result.rows.length > 1) throw new Error('Revalidation claim exceeded its bound');
    return result.rows[0] ? claim(result.rows[0]) : null;
  }

  async fail(
    current: PublicSocialRevalidationClaim,
    lease: PublicSocialRevalidationLease,
    errorCode: string,
    retryable = true,
  ): Promise<'retry_wait' | 'dead_letter'> {
    if (!SAFE_ERROR.test(errorCode)) throw new Error('Revalidation error code is invalid');
    const result = await this.pool.query<{ jobId: unknown; state: unknown }>(
      `/* public-social-revalidator.fail */
       SELECT job_id AS "jobId", state
       FROM app_private.fail_test_social_revalidation(
         $1, $2, $3, $4, $5, $6, $7
       )`,
      [current.workspaceId, current.jobId, lease.workerId,
        publicSocialRevalidationLeaseHash(lease),
        current.leaseVersion, errorCode, retryable],
    );
    const row = result.rows[0];
    if (result.rows.length !== 1 || uuid(row?.jobId, 'failed job') !== current.jobId
        || (row?.state !== 'retry_wait' && row?.state !== 'dead_letter')) {
      throw new Error('Revalidation failure result is invalid');
    }
    return row.state;
  }

  async completeAndMaterialize(
    current: PublicSocialRevalidationClaim,
    lease: PublicSocialRevalidationLease,
    sourceProof: PublicSocialRevalidationSourceProof,
    proofId: string,
    postId: string,
  ): Promise<PublicSocialMaterializationResult> {
    uuid(proofId, 'proof id');
    uuid(postId, 'post id');
    const checkedAt = instant(sourceProof.checkedAt, 'proof check time');
    const expiresAt = instant(sourceProof.expiresAt, 'proof expiry');
    const sourceCatalogSha256 = sha(sourceProof.sourceCatalogSha256, 'source catalog digest');
    if (sourceProof.content.evidenceType !== current.evidenceType
        || (current.evidenceType === 'legacy' && (sourceProof.content.evidenceType !== 'legacy'
          || uuid(sourceProof.content.sourceResourceVersionId, 'proof source resource version') !== current.sourceResourceVersionId
          || uuid(sourceProof.content.sourceApprovalId, 'proof source approval') !== current.sourceApprovalId
          || sourceInstant(sourceProof.content.sourceApprovedAt, 'proof source approval time') !== current.sourceApprovedAt))
        || (current.evidenceType === 'generated' && (sourceProof.content.evidenceType !== 'generated'
          || uuid(sourceProof.content.generatedSourceItemId, 'proof generated source item') !== current.generatedSourceItemId
          || uuid(sourceProof.content.generatedSourceVersionId, 'proof generated source version') !== current.generatedSourceVersionId
          || safeInteger(sourceProof.content.generatedSourceItemVersion, 'proof generated source item version') !== current.generatedSourceItemVersion
          || sha(sourceProof.content.generatedContentSha256, 'proof generated content digest') !== current.generatedContentSha256
          || sha(sourceProof.content.generatedBrandSha256, 'proof generated brand digest') !== current.generatedBrandSha256))
        || sourceProof.media.length !== current.media.length
        || sourceProof.media.some((item, index) => {
          const expected = current.media[index];
          return !expected
            || uuid(item.sourceResourceVersionId, 'media proof source resource version')
              !== expected.sourceResourceVersionId
            || uuid(item.sourceApprovalId, 'media proof source approval')
              !== expected.sourceApprovalId
            || sourceInstant(item.sourceApprovedAt, 'media proof source approval time')
              !== expected.sourceApprovedAt;
        })) {
      throw new Error('Revalidation system source proof is not the exact leased evidence');
    }
    const completed = await this.pool.query<{
      proofId: unknown; postId: unknown; operationIds: unknown; disposition: unknown;
    }>(
      `/* public-social-revalidator.complete-and-materialize */
       SELECT proof_id AS "proofId", post_id AS "postId",
              operation_ids AS "operationIds", disposition
       FROM app_private.complete_and_materialize_test_social_revalidation_v2(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11::uuid[], $12::uuid[], $13::timestamptz[], decode($14, 'hex'),
         $15, $16, $17, $18, $19, $20, decode($21, 'hex'), decode($22, 'hex')
       )`,
      [current.workspaceId, current.jobId, lease.workerId,
        publicSocialRevalidationLeaseHash(lease), current.leaseVersion,
        proofId, postId,
        sourceProof.content.evidenceType === 'legacy' ? sourceProof.content.sourceResourceVersionId : null,
        sourceProof.content.evidenceType === 'legacy' ? sourceProof.content.sourceApprovalId : null,
        sourceProof.content.evidenceType === 'legacy' ? sourceProof.content.sourceApprovedAt : null,
        sourceProof.media.map((item) => item.sourceResourceVersionId),
        sourceProof.media.map((item) => item.sourceApprovalId),
        sourceProof.media.map((item) => item.sourceApprovedAt), sourceCatalogSha256,
        checkedAt, expiresAt, sourceProof.content.evidenceType,
        sourceProof.content.evidenceType === 'generated' ? sourceProof.content.generatedSourceItemId : null,
        sourceProof.content.evidenceType === 'generated' ? sourceProof.content.generatedSourceVersionId : null,
        sourceProof.content.evidenceType === 'generated' ? sourceProof.content.generatedSourceItemVersion : null,
        sourceProof.content.evidenceType === 'generated' ? sourceProof.content.generatedContentSha256 : null,
        sourceProof.content.evidenceType === 'generated' ? sourceProof.content.generatedBrandSha256 : null],
    );
    const row = completed.rows[0];
    if (completed.rows.length !== 1 || uuid(row?.proofId, 'proof result') !== proofId
        || uuid(row?.postId, 'materialized post') !== postId
        || !Array.isArray(row?.operationIds) || row.operationIds.length < 1
        || row.operationIds.some((id) => typeof id !== 'string' || !UUID.test(id))
        || (row.disposition !== 'applied' && row.disposition !== 'replayed')) {
      throw new Error('Revalidation completion result is invalid');
    }
    return Object.freeze({
      proofId,
      postId,
      operationIds: Object.freeze([...row.operationIds] as string[]),
      disposition: row.disposition,
    });
  }
}
