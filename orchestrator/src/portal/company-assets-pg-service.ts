import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import {
  CompanyAssetConflictError,
  CompanyAssetNotFoundError,
  CompanyAssetService,
  CompanyAssetValidationError,
  createCompanyAssetTransactionRunner,
  type CompanyAssetTransactionRunner,
} from '../company-asset-pg/index.js';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { InactivePortalSessionError } from '../db/transaction.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipal,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';
import type {
  PortalCompanyAssetsFailure,
  PortalCompanyAssetsRequestIdentity,
  PortalCompanyAssetsService,
  PortalCompanyAssetsSnapshotOutcome,
  PortalCompanyAssetsWorkspaceAccess,
  PortalQuarantineCompanyAssetInput,
  PortalQuarantineCompanyAssetOutcome,
} from './company-assets-service.js';

interface WorkspaceAccessRow extends QueryResultRow {
  readonly workspaceId: unknown;
  readonly workspaceName: unknown;
  readonly snapshotAt: unknown;
  readonly canManage: unknown;
}

const WORKSPACE_ACCESS_SQL = `/* portal.company-assets.workspace-access */
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

export interface PortalCompanyAssetsWorkspaceAccessReader {
  load(context: DatabaseRequestContext): Promise<PortalCompanyAssetsWorkspaceAccess | null>;
}

/** Web-role reader for workspace chrome and the founder/admin capability bit. */
export class PgPortalCompanyAssetsWorkspaceAccessReader
implements PortalCompanyAssetsWorkspaceAccessReader {
  constructor(private readonly transactionRunner: CompanyAssetTransactionRunner) {}

  async load(context: DatabaseRequestContext): Promise<PortalCompanyAssetsWorkspaceAccess | null> {
    return this.transactionRunner.run(context, async (transaction) => {
      const result = await transaction.query<WorkspaceAccessRow>(WORKSPACE_ACCESS_SQL);
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) {
        throw new Error('Company assets workspace access was returned more than once');
      }
      const row = result.rows[0]!;
      const workspaceId = canonicalUuid(row.workspaceId);
      const snapshotAt = isoTimestamp(row.snapshotAt);
      if (workspaceId !== context.workspaceId.toLowerCase()
          || typeof row.workspaceName !== 'string'
          || row.workspaceName.length === 0
          || !snapshotAt
          || typeof row.canManage !== 'boolean') {
        throw new Error('Company assets workspace access returned invalid data');
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

type CompanyAssetServiceShape = CompanyAssetService;

export interface PgPortalCompanyAssetsDependencies {
  readonly principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  readonly accessReader: PortalCompanyAssetsWorkspaceAccessReader;
  /** Must use r72_content_adapter in deployed composition. */
  readonly readService: Pick<CompanyAssetServiceShape, 'listReleases' | 'listItems'>;
  /** Must use r72_content_command in deployed composition. */
  readonly commandService: Pick<CompanyAssetServiceShape, 'decideQuarantine'>;
}

function databaseContext(
  identity: PortalCompanyAssetsRequestIdentity,
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
  kind: PortalCompanyAssetsFailure['kind'],
  message: string,
): PortalCompanyAssetsFailure {
  return Object.freeze({ ok: false, kind, message });
}

function readFailure(error: unknown): PortalCompanyAssetsFailure {
  if (error instanceof InactivePortalSessionError) {
    return failure('unauthenticated', 'This portal session is no longer active.');
  }
  if (error instanceof CompanyAssetValidationError) {
    return failure('validation', 'The company-assets request is invalid. Refresh and try again.');
  }
  if (postgresCode(error) === '42501') {
    return failure('forbidden', 'Founder or workspace-admin access is required for company assets.');
  }
  return failure('unavailable', 'The company-assets metadata is temporarily unavailable.');
}

function commandFailure(error: unknown): PortalCompanyAssetsFailure {
  if (error instanceof InactivePortalSessionError) {
    return failure('unauthenticated', 'This portal session is no longer active.');
  }
  if (error instanceof CompanyAssetValidationError) {
    return failure('validation', 'Check the exact item tuple, evidence digest and quarantine reason.');
  }
  if (error instanceof CompanyAssetNotFoundError) {
    return failure('not_found', 'That exact company-asset item is not available in this workspace.');
  }
  if (error instanceof CompanyAssetConflictError) {
    return failure(
      'exact_item_conflict',
      'The immutable item tuple, prior decision or command key no longer matches. Refresh first.',
    );
  }
  if (postgresCode(error) === '42501') {
    return failure('forbidden', 'Only a workspace owner or admin can quarantine company assets.');
  }
  return failure('unavailable', 'The quarantine decision could not be saved safely. Nothing else changed.');
}

const QUARANTINE_REASON_BY_DIMENSION = Object.freeze({
  visual_policy: 'visual_policy_conflict',
  claim: 'claims_unsubstantiated',
  asset: 'asset_integrity_failed',
} as const);

export class PgPortalCompanyAssetsService implements PortalCompanyAssetsService {
  constructor(private readonly dependencies: PgPortalCompanyAssetsDependencies) {}

  private async context(
    identity: PortalCompanyAssetsRequestIdentity,
  ): Promise<DatabaseRequestContext | null> {
    const principal = await this.dependencies.principalResolver.resolve(identity.sessionToken);
    return principal ? databaseContext(identity, principal) : null;
  }

  async snapshot(
    identity: PortalCompanyAssetsRequestIdentity,
  ): Promise<PortalCompanyAssetsSnapshotOutcome> {
    try {
      const context = await this.context(identity);
      if (!context) return failure('unauthenticated', 'This portal session is no longer active.');
      const workspace = await this.dependencies.accessReader.load(context);
      if (!workspace || !workspace.canManage) {
        return failure('forbidden', 'Founder or workspace-admin access is required for company assets.');
      }
      const releases = await this.dependencies.readService.listReleases(context, { limit: 10 });
      if (releases.some((release) => release.providerEffects !== false)) {
        return failure('unavailable', 'The company-assets metadata did not pass its effects-off boundary.');
      }
      const selectedRelease = releases[0] ?? null;
      const itemPage = selectedRelease
        ? await this.dependencies.readService.listItems(context, {
            sourceReleaseId: selectedRelease.sourceReleaseId,
            limit: 50,
          })
        : Object.freeze({ items: Object.freeze([]), hasMore: false });
      if (itemPage.items.some((item) => item.sourceReleaseId !== selectedRelease?.sourceReleaseId)) {
        return failure('unavailable', 'The company-assets metadata did not match one immutable release.');
      }
      return Object.freeze({
        ok: true,
        snapshot: Object.freeze({
          workspace,
          releases,
          selectedRelease,
          itemPage,
          dataset: 'postgres_authoritative' as const,
          providerEffects: false as const,
          reviewRepresentationAvailable: false as const,
        }),
      });
    } catch (error) {
      return readFailure(error);
    }
  }

  async quarantine(
    identity: PortalCompanyAssetsRequestIdentity,
    input: PortalQuarantineCompanyAssetInput,
  ): Promise<PortalQuarantineCompanyAssetOutcome> {
    if (input.outcome !== 'quarantined') {
      return failure(
        'review_unavailable',
        'Clear and approval remain locked until exact review content is available.',
      );
    }
    if (QUARANTINE_REASON_BY_DIMENSION[input.dimension] !== input.reasonCode
        || (input.dimension === 'asset' && input.itemType !== 'asset')
        || input.evidenceSha256 !== input.itemContentSha256) {
      return failure('validation', 'The quarantine reason does not match this exact item and dimension.');
    }
    try {
      const context = await this.context(identity);
      if (!context) return failure('unauthenticated', 'This portal session is no longer active.');
      const workspace = await this.dependencies.accessReader.load(context);
      if (!workspace || !workspace.canManage) {
        return failure('forbidden', 'Only a workspace owner or admin can quarantine company assets.');
      }
      const result = await this.dependencies.commandService.decideQuarantine(context, {
        commandKey: input.commandKey,
        sourceReleaseId: input.sourceReleaseId,
        releaseItemId: input.releaseItemId,
        itemType: input.itemType,
        itemId: input.itemId,
        itemContentSha256: input.itemContentSha256,
        itemBrandSha256: input.itemBrandSha256,
        dimension: input.dimension,
        outcome: 'quarantined',
        reasonCode: input.reasonCode,
        evidenceSha256: input.evidenceSha256,
      });
      if ((result.disposition !== 'applied' && result.disposition !== 'replayed')
          || canonicalUuid(result.quarantineDecisionId) !== result.quarantineDecisionId
          || result.sourceReleaseId !== input.sourceReleaseId.toLowerCase()
          || result.releaseItemId !== input.releaseItemId.toLowerCase()
          || result.itemType !== input.itemType
          || result.itemId !== input.itemId
          || result.itemContentSha256 !== input.itemContentSha256
          || result.itemBrandSha256 !== input.itemBrandSha256
          || result.dimension !== input.dimension
          || result.outcome !== 'quarantined'
          || result.reasonCode !== input.reasonCode
          || result.evidenceSha256 !== input.evidenceSha256
          || result.providerEffects !== false) {
        return failure('exact_item_conflict', 'The stored decision did not match the exact quarantine command.');
      }
      return Object.freeze({
        ok: true,
        ...result,
        outcome: 'quarantined' as const,
        reasonCode: input.reasonCode,
      });
    } catch (error) {
      return commandFailure(error);
    }
  }
}

/**
 * Production-safe role split: web resolves session/chrome, content-adapter
 * performs RLS-scoped metadata reads, and content-command records founder-only
 * restrictive decisions. None of the three gains provider capability.
 */
export function createPgPortalCompanyAssetsService(input: {
  readonly webPool: Pool;
  readonly adapterPool: Pool;
  readonly commandPool: Pool;
}): PgPortalCompanyAssetsService {
  const webRunner = createCompanyAssetTransactionRunner(input.webPool);
  return new PgPortalCompanyAssetsService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    accessReader: new PgPortalCompanyAssetsWorkspaceAccessReader(webRunner),
    readService: new CompanyAssetService({
      transactionRunner: createCompanyAssetTransactionRunner(input.adapterPool),
    }),
    commandService: new CompanyAssetService({
      transactionRunner: createCompanyAssetTransactionRunner(input.commandPool),
    }),
  });
}
