import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import {
  BrandBrainConflictError,
  BrandBrainNotFoundError,
  BrandBrainService,
  BrandBrainValidationError,
  createBrandBrainTransactionRunner,
  type BrandBrainService as BrandBrainServiceShape,
  type BrandBrainSnapshot,
  type BrandBrainTransactionRunner,
} from '../brand-brain-pg/index.js';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { InactivePortalSessionError } from '../db/transaction.js';
import {
  PROPERTY_PREDATOR_BRAND_BRAIN_ADAPTED_METHOD_PACKS,
  PROPERTY_PREDATOR_BRAND_BRAIN_EXTERNAL_PROFILES,
} from './brand-brain-registry.js';
import type {
  PortalBrandBrainFailure,
  PortalBrandBrainRequestIdentity,
  PortalBrandBrainService,
  PortalBrandBrainSnapshotOutcome,
  PortalBrandBrainWorkspaceAccess,
} from './brand-brain-service.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipal,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';

interface WorkspaceAccessRow extends QueryResultRow {
  readonly workspaceId: unknown;
  readonly workspaceName: unknown;
  readonly snapshotAt: unknown;
  readonly canManage: unknown;
}

const WORKSPACE_ACCESS_SQL = `/* portal.brand-brain.workspace-access */
  SELECT workspace.id::text AS "workspaceId",
         workspace.name AS "workspaceName",
         transaction_timestamp() AS "snapshotAt",
         app_private.can_manage_workspace(
           app_private.current_user_id(), workspace.id
         ) AS "canManage"
  FROM app.workspaces AS workspace
  WHERE workspace.id = app_private.current_workspace_id()`;

function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(value)
    ? value.toLowerCase()
    : null;
}

function isoTimestamp(value: unknown): string | null {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export interface PortalBrandBrainWorkspaceAccessReader {
  load(context: DatabaseRequestContext): Promise<PortalBrandBrainWorkspaceAccess | null>;
}

/** Web-role reader for workspace chrome and the manager capability bit. */
export class PgPortalBrandBrainWorkspaceAccessReader
implements PortalBrandBrainWorkspaceAccessReader {
  constructor(private readonly transactionRunner: BrandBrainTransactionRunner) {}

  async load(context: DatabaseRequestContext): Promise<PortalBrandBrainWorkspaceAccess | null> {
    return this.transactionRunner.run(context, async (transaction) => {
      const result = await transaction.query<WorkspaceAccessRow>(WORKSPACE_ACCESS_SQL);
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) {
        throw new Error('Brand Brain workspace access was returned more than once');
      }
      const row = result.rows[0]!;
      const workspaceId = canonicalUuid(row.workspaceId);
      const snapshotAt = isoTimestamp(row.snapshotAt);
      if (workspaceId !== context.workspaceId.toLowerCase()
          || typeof row.workspaceName !== 'string'
          || row.workspaceName.length === 0
          || !snapshotAt
          || typeof row.canManage !== 'boolean') {
        throw new Error('Brand Brain workspace access returned invalid data');
      }
      return Object.freeze({
        workspaceId,
        workspaceName: row.workspaceName,
        snapshotAt,
        canManage: row.canManage,
      });
    }, { readOnly: true });
  }
}

export interface PgPortalBrandBrainDependencies {
  readonly principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  readonly accessReader: PortalBrandBrainWorkspaceAccessReader;
  /** Must use the dedicated r72_content_adapter identity in production. */
  readonly readService: Pick<BrandBrainServiceShape, 'latestSnapshot'>;
}

function databaseContext(
  identity: PortalBrandBrainRequestIdentity,
  principal: PortalCrmPrincipal,
): DatabaseRequestContext {
  return requestDatabaseContext({
    ...principal,
    requestId: identity.requestId,
    portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest(),
  });
}

function postgresCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    && typeof (error as { readonly code?: unknown }).code === 'string'
    ? (error as { readonly code: string }).code
    : null;
}

function failure(
  kind: PortalBrandBrainFailure['kind'],
  message: string,
): PortalBrandBrainFailure {
  return Object.freeze({ ok: false, kind, message });
}

class InvalidBrandBrainSnapshotError extends Error {
  constructor() {
    super('Brand Brain snapshot failed its effects-off product boundary');
    this.name = 'InvalidBrandBrainSnapshotError';
  }
}

/**
 * Rebuild the public portal object field-by-field. This prevents an accidental
 * future repository field (prompt body, storage key or provider state) from
 * crossing this deliberately metadata-only boundary.
 */
function projectBrainMetadata(snapshot: BrandBrainSnapshot): BrandBrainSnapshot {
  if (snapshot.sourceSystem !== 'property-predator' || snapshot.providerEffects !== false) {
    throw new InvalidBrandBrainSnapshotError();
  }
  return Object.freeze({
    sourceReleaseId: snapshot.sourceReleaseId,
    manifestSha256: snapshot.manifestSha256,
    runtimeBrandSha256: snapshot.runtimeBrandSha256,
    sourceSystem: 'property-predator',
    sources: Object.freeze(snapshot.sources.map((source) => Object.freeze({
      sourceId: source.sourceId,
      assetRole: source.assetRole,
      authorityStatus: source.authorityStatus,
      contentSha256: source.contentSha256,
      ownershipStatus: source.ownershipStatus,
      licenceStatus: source.licenceStatus,
      privacyClass: source.privacyClass,
      consumerUse: source.consumerUse,
    }))),
    specialists: Object.freeze(snapshot.specialists.map((specialist) => Object.freeze({
      profileId: specialist.profileId,
      name: specialist.name,
      capabilities: Object.freeze([...specialist.capabilities]),
      runtimeBrandSha256: specialist.runtimeBrandSha256,
      sourceStatus: specialist.sourceStatus,
      hqActivationStatus: specialist.hqActivationStatus,
      runtimeReady: specialist.runtimeReady,
      blockedReason: specialist.blockedReason,
    }))),
    artworkCount: snapshot.artworkCount,
    quarantineCount: snapshot.quarantineCount,
    visualPolicyConflict: snapshot.visualPolicyConflict,
    sourceFresh: snapshot.sourceFresh,
    evaluationPassed: snapshot.evaluationPassed,
    reviews: Object.freeze(snapshot.reviews.map((review) => Object.freeze({
      dimension: review.dimension,
      decision: review.decision,
      decisionId: review.decisionId,
    }))),
    activated: snapshot.activated,
    providerEffects: false,
    recordedAt: snapshot.recordedAt,
  });
}

function readFailure(error: unknown): PortalBrandBrainFailure {
  if (error instanceof InactivePortalSessionError) {
    return failure('unauthenticated', 'This portal session is no longer active.');
  }
  if (error instanceof BrandBrainNotFoundError) {
    return failure('not_found', 'No Brand Brain release is available in this workspace.');
  }
  if (error instanceof InvalidBrandBrainSnapshotError
      || error instanceof BrandBrainValidationError
      || error instanceof BrandBrainConflictError) {
    return failure('invalid_snapshot', 'The Brand Brain metadata did not pass its read-only safety boundary.');
  }
  if (postgresCode(error) === '42501') {
    return failure('forbidden', 'This workspace role cannot read the Brand Brain metadata.');
  }
  return failure('unavailable', 'The Brand Brain metadata is temporarily unavailable.');
}

/**
 * PostgreSQL-authoritative, read-only Brand Brain portal boundary. It exposes
 * one snapshot operation and has no stage, review, activation, model, provider
 * or publishing command.
 */
export class PgPortalBrandBrainService implements PortalBrandBrainService {
  constructor(private readonly dependencies: PgPortalBrandBrainDependencies) {}

  async snapshot(
    identity: PortalBrandBrainRequestIdentity,
  ): Promise<PortalBrandBrainSnapshotOutcome> {
    try {
      const principal = await this.dependencies.principalResolver.resolve(identity.sessionToken);
      if (!principal) {
        return failure('unauthenticated', 'This portal session is no longer active.');
      }
      const context = databaseContext(identity, principal);
      const workspace = await this.dependencies.accessReader.load(context);
      if (!workspace) {
        return failure('forbidden', 'This workspace is not available to the current portal session.');
      }
      const stored = await this.dependencies.readService.latestSnapshot(context);
      if (!stored) {
        return failure('not_found', 'No Brand Brain release is available in this workspace.');
      }
      const brain = projectBrainMetadata(stored);
      return Object.freeze({
        ok: true,
        snapshot: Object.freeze({
          workspace,
          brain,
          externalProfiles: PROPERTY_PREDATOR_BRAND_BRAIN_EXTERNAL_PROFILES,
          adaptedMethodPacks: PROPERTY_PREDATOR_BRAND_BRAIN_ADAPTED_METHOD_PACKS,
          dataset: 'postgres_authoritative' as const,
        }),
      });
    } catch (error) {
      return readFailure(error);
    }
  }
}

export function createPgPortalBrandBrainService(input: Readonly<{
  webPool: Pick<Pool, 'query' | 'connect'>;
  adapterPool: Pick<Pool, 'connect'>;
}>): PgPortalBrandBrainService {
  return new PgPortalBrandBrainService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    accessReader: new PgPortalBrandBrainWorkspaceAccessReader(
      createBrandBrainTransactionRunner(input.webPool),
    ),
    readService: new BrandBrainService({
      transactionRunner: createBrandBrainTransactionRunner(input.adapterPool),
    }),
  });
}
