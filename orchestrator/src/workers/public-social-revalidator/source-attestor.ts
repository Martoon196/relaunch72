import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import type {
  PropertyPredatorApprovedResourceTransport,
  PropertyPredatorApprovedVersionResource,
} from '../../company-content-adapter/property-predator-resources.js';
import { canonicalCompanyContentJson } from '../../company-content-pg/validation.js';
import type {
  PublicSocialRevalidationSourceProof,
  PublicSocialRevalidationClaim,
  PublicSocialRevalidationLease,
  PublicSocialRevalidationMediaClaim,
} from './queue.js';
import { publicSocialRevalidationLeaseHash } from './queue.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PROPERTY_PREDATOR_SOURCE = 'propertypredator.company-content';
const ATTESTATION_LIFETIME_MS = 15 * 60_000;
const REQUIRED_POST_SLOT_MARGIN_MS = 2 * 60_000;

type RevalidatorCapabilityPool = Pick<Pool, 'query'>;
type ClaimedEvidence = Omit<PublicSocialRevalidationMediaClaim, 'ordinal'>;

interface VersionRow extends QueryResultRow {
  resourceOrdinal: unknown;
  contentItemId: unknown;
  contentVersionId: unknown;
  sourceSystem: unknown;
  sourceItemId: unknown;
  sourceVersion: unknown;
  contentSha256: unknown;
  bodySha256: unknown;
  blobSha256: unknown;
  brandSha256: unknown;
  sourceResourceVersionId: unknown;
  sourceApprovalId: unknown;
  sourceApprovedAt: unknown;
}

interface ExactVersion {
  readonly resourceOrdinal: number;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly sourceSystem: string;
  readonly sourceItemId: string;
  readonly sourceVersion: string;
  readonly contentSha256: string;
  readonly blobSha256: string;
  readonly brandSha256: string;
  readonly sourceResourceVersionId: string;
  readonly sourceApprovalId: string;
  readonly sourceApprovedAt: string;
}

interface VerifiedVersion extends ExactVersion {
  readonly resource: PropertyPredatorApprovedVersionResource;
}

export interface PropertyPredatorJitAttestorDependencies {
  /**
   * The function-only r72_public_social_revalidator_command identity. It has
   * no table privileges and cannot create content, approvals or provider work.
   */
  readonly pool: RevalidatorCapabilityPool;
  readonly transport: PropertyPredatorApprovedResourceTransport;
  readonly now?: () => Date;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error(`JIT source ${label} is invalid`);
  }
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`JIT source ${label} is invalid`);
  }
  return value;
}

function exactSource(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
      || value !== value.trim()) {
    throw new Error(`JIT source ${label} is invalid`);
  }
  return value;
}

function instant(value: unknown, label: string): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 80
      || !Number.isFinite(Date.parse(value))) {
    throw new Error(`JIT source ${label} is invalid`);
  }
  return value;
}

function parseVersion(row: VersionRow): ExactVersion {
  const resourceOrdinal = typeof row.resourceOrdinal === 'string'
    && /^(?:0|[1-9]|10)$/u.test(row.resourceOrdinal)
    ? Number(row.resourceOrdinal) : row.resourceOrdinal;
  if (!Number.isSafeInteger(resourceOrdinal)
      || (resourceOrdinal as number) < 0 || (resourceOrdinal as number) > 10) {
    throw new Error('JIT source resource ordinal is invalid');
  }
  const contentSha256 = sha(row.contentSha256, 'content digest');
  const bodySha256 = sha(row.bodySha256, 'body digest');
  if (bodySha256 !== contentSha256) throw new Error('JIT source body digest changed');
  return Object.freeze({
    resourceOrdinal: resourceOrdinal as number,
    contentItemId: uuid(row.contentItemId, 'content item'),
    contentVersionId: uuid(row.contentVersionId, 'content version'),
    sourceSystem: exactSource(row.sourceSystem, 'system', 100),
    sourceItemId: exactSource(row.sourceItemId, 'item', 500),
    sourceVersion: exactSource(row.sourceVersion, 'version', 500),
    contentSha256,
    blobSha256: sha(row.blobSha256, 'blob digest'),
    brandSha256: sha(row.brandSha256, 'brand digest'),
    sourceResourceVersionId: uuid(row.sourceResourceVersionId, 'resource version'),
    sourceApprovalId: uuid(row.sourceApprovalId, 'approval'),
    sourceApprovedAt: instant(row.sourceApprovedAt, 'approval time'),
  });
}

function sameEvidence(version: ExactVersion, expected: ClaimedEvidence): boolean {
  return version.contentItemId === expected.contentItemId
    && version.contentVersionId === expected.contentVersionId
    && version.sourceSystem === expected.sourceSystem
    && version.sourceItemId === expected.sourceItemId
    && version.sourceVersion === expected.sourceVersion
    && version.contentSha256 === expected.contentSha256
    && version.blobSha256 === expected.blobSha256
    && version.brandSha256 === expected.brandSha256
    && version.sourceResourceVersionId === expected.sourceResourceVersionId
    && version.sourceApprovalId === expected.sourceApprovalId
    && version.sourceApprovedAt === expected.sourceApprovedAt;
}

function sourceIdentity(resource: PropertyPredatorApprovedVersionResource): string {
  return `${resource.itemType}:${resource.itemId}`;
}

function effectiveBlob(resource: PropertyPredatorApprovedVersionResource): string {
  return resource.blobSha256 ?? resource.contentSha256;
}

function evidenceDigest(claim: PublicSocialRevalidationClaim, versions: readonly VerifiedVersion[]): string {
  const canonical = canonicalCompanyContentJson({
    contract: 'property-predator-public-social-jit-source/v1',
    intentId: claim.intentId,
    jobId: claim.jobId,
    resources: versions.map((version) => ({
      brandSha256: version.brandSha256,
      contentSha256: version.contentSha256,
      contentVersionId: version.contentVersionId,
      itemId: version.resource.itemId,
      itemType: version.resource.itemType,
      itemVersion: version.resource.itemVersion,
      resourceVersionId: version.sourceResourceVersionId,
      sourceApprovalId: version.sourceApprovalId,
      sourceApprovedAt: version.sourceApprovedAt,
      blobSha256: version.blobSha256,
    })),
    schemaVersion: 1,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export class PgPropertyPredatorJitSourceAttestor {
  readonly #now: () => Date;

  constructor(private readonly dependencies: PropertyPredatorJitAttestorDependencies) {
    this.#now = dependencies.now ?? (() => new Date());
    if ('publish' in dependencies.transport || 'send' in dependencies.transport
        || 'schedule' in dependencies.transport || 'generate' in dependencies.transport) {
      throw new Error('JIT source transport exposes a forbidden effect method');
    }
  }

  async #loadExactVersions(
    claim: PublicSocialRevalidationClaim,
    lease: PublicSocialRevalidationLease,
  ): Promise<readonly ExactVersion[]> {
    const expected: readonly (ClaimedEvidence & { readonly resourceOrdinal: number })[] = Object.freeze([
      Object.freeze({
        resourceOrdinal: 0,
        contentItemId: claim.contentItemId,
        contentVersionId: claim.contentVersionId,
        sourceSystem: claim.sourceSystem,
        sourceItemId: claim.sourceItemId,
        sourceVersion: claim.sourceVersion,
        sourceResourceVersionId: claim.sourceResourceVersionId,
        sourceApprovalId: claim.sourceApprovalId,
        sourceApprovedAt: claim.sourceApprovedAt,
        contentSha256: claim.contentSha256,
        blobSha256: claim.blobSha256,
        brandSha256: claim.brandSha256,
      }),
      ...claim.media.map(({ ordinal, ...media }) => Object.freeze({
        resourceOrdinal: ordinal,
        ...media,
      })),
    ]);
    const rows = (await this.dependencies.pool.query<VersionRow>(
      `/* public-social-revalidator.load-leased-source-proof */
       SELECT resource_ordinal AS "resourceOrdinal",
              content_item_id AS "contentItemId",
              content_version_id AS "contentVersionId",
              source_system AS "sourceSystem",
              source_item_id AS "sourceItemId",
              source_version AS "sourceVersion",
              content_sha256 AS "contentSha256",
              body_sha256 AS "bodySha256",
              blob_sha256 AS "blobSha256",
              brand_sha256 AS "brandSha256",
              source_resource_version_id AS "sourceResourceVersionId",
              source_approval_id AS "sourceApprovalId",
              source_approved_at AS "sourceApprovedAt"
       FROM app_private.load_leased_test_social_source_versions($1, $2, $3, $4)`,
      [claim.jobId, lease.workerId, publicSocialRevalidationLeaseHash(lease),
        claim.leaseVersion],
    )).rows.map(parseVersion);
    if (rows.length !== expected.length) throw new Error('JIT source version set is incomplete');
    const byOrdinal = new Map(rows.map((row) => [row.resourceOrdinal, row]));
    if (byOrdinal.size !== rows.length) throw new Error('JIT source resource order is invalid');
    return Object.freeze(expected.map((item) => {
      const row = byOrdinal.get(item.resourceOrdinal);
      if (!row || !sameEvidence(row, item)) throw new Error('JIT source evidence changed');
      if (row.sourceSystem !== PROPERTY_PREDATOR_SOURCE) {
        throw new Error('JIT source is outside the approved Property Predator boundary');
      }
      return row;
    }));
  }

  async #verifyRemote(versions: readonly ExactVersion[]): Promise<readonly VerifiedVersion[]> {
    const verified: VerifiedVersion[] = [];
    for (const version of versions) {
      const resource = await this.dependencies.transport.loadVersion(
        version.sourceResourceVersionId,
        version.contentSha256,
      );
      if (sourceIdentity(resource) !== version.sourceItemId
          || String(resource.itemVersion) !== version.sourceVersion
          || resource.versionId !== version.sourceResourceVersionId
          || resource.approvalId !== version.sourceApprovalId
          || instant(resource.approvedAt, 'remote approval time') !== version.sourceApprovedAt
          || resource.brandSha256 !== version.brandSha256
          || effectiveBlob(resource) !== version.blobSha256) {
        throw new Error('JIT source resource no longer matches immutable planning evidence');
      }
      if (resource.itemType === 'asset') {
        if (!resource.blobSha256) throw new Error('JIT source asset digest is missing');
        await this.dependencies.transport.loadAsset(
          resource.versionId,
          resource.blobSha256,
        );
      }
      verified.push(Object.freeze({ ...version, resource }));
    }
    return Object.freeze(verified);
  }

  async attest(
    claim: PublicSocialRevalidationClaim,
    lease: PublicSocialRevalidationLease,
  ): Promise<PublicSocialRevalidationSourceProof> {
    const exact = await this.#loadExactVersions(claim, lease);
    const verified = await this.#verifyRemote(exact);
    const checkedAt = this.#now();
    if (!Number.isFinite(checkedAt.getTime())) throw new Error('JIT source clock is invalid');
    const expiresAt = new Date(checkedAt.getTime() + ATTESTATION_LIFETIME_MS);
    if (expiresAt.getTime() <= Date.parse(claim.desiredFor) + REQUIRED_POST_SLOT_MARGIN_MS) {
      throw new Error('JIT source proof cannot cover the desired TEST slot');
    }
    const catalogSha256 = evidenceDigest(claim, verified);
    const provenance = verified.map((version) => Object.freeze({
      sourceResourceVersionId: version.sourceResourceVersionId,
      sourceApprovalId: version.sourceApprovalId,
      sourceApprovedAt: version.sourceApprovedAt,
    }));
    return Object.freeze({
      sourceCatalogSha256: catalogSha256,
      checkedAt: checkedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      content: provenance[0]!,
      media: Object.freeze(provenance.slice(1)),
    });
  }
}
