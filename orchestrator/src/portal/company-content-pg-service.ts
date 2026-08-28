import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import {
  CompanyContentApprovalConflictError,
  CompanyContentCommandInProgressError,
  CompanyContentIdempotencyConflictError,
  CompanyContentNotFoundError,
  CompanyContentService,
  CompanyContentValidationError,
  CompanyContentVersionConflictError,
  createCompanyContentTransactionRunner,
  type CompanyContentCatalogPage,
  type CompanyContentCatalogQuery,
  type CompanyContentService as CompanyContentServiceShape,
  type CompanyContentTransactionRunner,
} from '../company-content-pg/index.js';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { InactivePortalSessionError } from '../db/transaction.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipal,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';
import type {
  PortalCompanyContentFailure,
  PortalCompanyContentRequestIdentity,
  PortalCompanyContentReviewInput,
  PortalCompanyContentReviewOutcome,
  PortalCompanyContentService,
  PortalCompanyContentSnapshotOutcome,
  PortalCompanyContentWorkspaceAccess,
  PortalCreateCompanyContentEmailDraftVersionInput,
  PortalCreateCompanyContentEmailDraftVersionOutcome,
  PortalDecideCompanyContentApprovalInput,
  PortalDecideExactReviewedCompanyContentApprovalInput,
  PortalDecideCompanyContentApprovalOutcome,
  PortalRequestCompanyContentApprovalInput,
  PortalRequestCompanyContentApprovalOutcome,
} from './company-content-service.js';
import {
  PORTAL_COMPANY_CONTENT_EXACT_REVIEW_AVAILABLE,
  PORTAL_COMPANY_CONTENT_REVIEW_REPRESENTATION_AVAILABLE,
} from './company-content-service.js';

interface WorkspaceAccessRow extends QueryResultRow {
  readonly workspaceId: unknown;
  readonly workspaceName: unknown;
  readonly snapshotAt: unknown;
  readonly canWrite: unknown;
  readonly canManage: unknown;
}

const WORKSPACE_ACCESS_SQL = `/* portal.company-content.workspace-access */
  SELECT workspace.id::text AS "workspaceId",
         workspace.name AS "workspaceName",
         transaction_timestamp() AS "snapshotAt",
         app_private.can_write_workspace(
           app_private.current_user_id(), workspace.id
         ) AS "canWrite",
         app_private.can_manage_workspace(
           app_private.current_user_id(), workspace.id
         ) AS "canManage"
  FROM app.workspaces AS workspace
  WHERE workspace.id = app_private.current_workspace_id()`;

export interface PortalCompanyContentWorkspaceAccessReader {
  load(context: DatabaseRequestContext): Promise<PortalCompanyContentWorkspaceAccess | null>;
}

function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function isoTimestamp(value: unknown): string | null {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/** Small RLS-scoped reader used for truthful portal capabilities and workspace chrome. */
export class PgPortalCompanyContentWorkspaceAccessReader
implements PortalCompanyContentWorkspaceAccessReader {
  constructor(private readonly transactionRunner: CompanyContentTransactionRunner) {}

  async load(context: DatabaseRequestContext): Promise<PortalCompanyContentWorkspaceAccess | null> {
    return this.transactionRunner.run(context, async (transaction) => {
      const result = await transaction.query<WorkspaceAccessRow>(WORKSPACE_ACCESS_SQL);
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) {
        throw new Error('Company content workspace access was returned more than once');
      }
      const row = result.rows[0]!;
      const workspaceId = canonicalUuid(row.workspaceId);
      const snapshotAt = isoTimestamp(row.snapshotAt);
      if (workspaceId !== context.workspaceId.toLowerCase()
          || typeof row.workspaceName !== 'string'
          || row.workspaceName.length === 0
          || !snapshotAt
          || typeof row.canWrite !== 'boolean'
          || typeof row.canManage !== 'boolean') {
        throw new Error('Company content workspace access returned invalid data');
      }
      return Object.freeze({
        workspaceId,
        workspaceName: row.workspaceName,
        snapshotAt,
        canWrite: row.canWrite,
        canManage: row.canManage,
      });
    }, { readOnly: true });
  }
}

export interface PgPortalCompanyContentDependencies {
  readonly principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  readonly accessReader: PortalCompanyContentWorkspaceAccessReader;
  /** Must use the web/read database role in production. */
  readonly readService: Pick<CompanyContentServiceShape, 'listCatalog'>
    & Partial<Pick<CompanyContentServiceShape, 'getExactReview'>>;
  /** Must use the dedicated company-content command role in production. */
  readonly commandService: Pick<CompanyContentServiceShape, 'requestApproval' | 'decideApproval'>;
  /** Must use the append-only company-content adapter role; never r72_web or r72_content_command. */
  readonly draftService?: Pick<CompanyContentServiceShape, 'createEmailDraftVersion'>;
}

function databaseContext(
  identity: PortalCompanyContentRequestIdentity,
  principal: PortalCrmPrincipal,
): DatabaseRequestContext {
  return requestDatabaseContext({
    ...principal,
    requestId: identity.requestId,
    portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest(),
  });
}

function postgresCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof (error as { readonly code?: unknown }).code === 'string'
    ? (error as { readonly code: string }).code
    : null;
}

function failure(kind: PortalCompanyContentFailure['kind'], message: string): PortalCompanyContentFailure {
  return Object.freeze({ ok: false, kind, message });
}

function commandFailure(error: unknown): PortalCompanyContentFailure {
  if (error instanceof InactivePortalSessionError) {
    return failure('unauthenticated', 'This portal session is no longer active.');
  }
  if (error instanceof CompanyContentValidationError) {
    return failure('validation', 'Check the exact content version, command key and review note.');
  }
  if (error instanceof CompanyContentNotFoundError) {
    return failure('not_found', 'That content version or approval request is not available in this workspace.');
  }
  if (error instanceof CompanyContentIdempotencyConflictError) {
    return failure('idempotency_conflict', 'This command key was already used for different approval details. Refresh before trying again.');
  }
  if (error instanceof CompanyContentCommandInProgressError) {
    return failure('command_in_progress', 'This approval command is already being processed. Refresh before trying again.');
  }
  if (error instanceof CompanyContentVersionConflictError) {
    return failure('version_conflict', 'That immutable version is no longer the current review target. Refresh before trying again.');
  }
  if (error instanceof CompanyContentApprovalConflictError) {
    return failure('approval_conflict', 'That exact approval request already has a decision or conflicts with another review.');
  }
  if (postgresCode(error) === '42501') {
    return failure('forbidden', 'Your workspace role cannot perform that content approval action.');
  }
  return failure('unavailable', 'The content approval change could not be saved safely. No provider action was triggered.');
}

function readFailure(error: unknown): PortalCompanyContentFailure {
  if (error instanceof InactivePortalSessionError) {
    return failure('unauthenticated', 'This portal session is no longer active.');
  }
  if (error instanceof CompanyContentValidationError) {
    return failure('validation', 'The company content request is invalid. Refresh the page and try again.');
  }
  if (postgresCode(error) === '42501') {
    return failure('forbidden', 'Your workspace role cannot read this company content catalogue.');
  }
  return failure('unavailable', 'The company content catalogue is temporarily unavailable.');
}

function reviewSafeCatalog(catalog: CompanyContentCatalogPage): CompanyContentCatalogPage {
  if (PORTAL_COMPANY_CONTENT_EXACT_REVIEW_AVAILABLE
      || !catalog.items.some((item) => item.publishable)) return catalog;
  return Object.freeze({
    ...catalog,
    items: Object.freeze(catalog.items.map((item) => (
      item.publishable ? Object.freeze({ ...item, publishable: false }) : item
    ))),
  });
}

export class PgPortalCompanyContentService implements PortalCompanyContentService {
  constructor(private readonly dependencies: PgPortalCompanyContentDependencies) {}

  private async context(
    identity: PortalCompanyContentRequestIdentity,
  ): Promise<DatabaseRequestContext | null> {
    const principal = await this.dependencies.principalResolver.resolve(identity.sessionToken);
    return principal ? databaseContext(identity, principal) : null;
  }

  async snapshot(
    identity: PortalCompanyContentRequestIdentity,
    query: CompanyContentCatalogQuery = {},
  ): Promise<PortalCompanyContentSnapshotOutcome> {
    try {
      const context = await this.context(identity);
      if (!context) return failure('unauthenticated', 'This portal session is no longer active.');
      const workspace = await this.dependencies.accessReader.load(context);
      if (!workspace) {
        return failure('forbidden', 'This workspace is not available to the current portal session.');
      }
      const catalog = reviewSafeCatalog(
        await this.dependencies.readService.listCatalog(context, query),
      );
      return Object.freeze({
        ok: true,
        snapshot: Object.freeze({ workspace, catalog }),
      });
    } catch (error) {
      return readFailure(error);
    }
  }

  async review(
    identity: PortalCompanyContentRequestIdentity,
    input: PortalCompanyContentReviewInput,
  ): Promise<PortalCompanyContentReviewOutcome> {
    try {
      const context = await this.context(identity);
      if (!context) return failure('unauthenticated', 'This portal session is no longer active.');
      const workspace = await this.dependencies.accessReader.load(context);
      if (!workspace) {
        return failure('forbidden', 'This workspace is not available to the current portal session.');
      }
      const exactReview = this.dependencies.readService.getExactReview;
      if (!exactReview) {
        return failure('review_unavailable', 'Exact company content review is temporarily unavailable.');
      }
      const review = await exactReview.call(this.dependencies.readService, context, input);
      if (!review) {
        return failure('not_found', 'That exact content version is not available in this workspace.');
      }
      return Object.freeze({
        ok: true,
        snapshot: Object.freeze({ workspace, review }),
      });
    } catch (error) {
      return readFailure(error);
    }
  }

  async requestApproval(
    identity: PortalCompanyContentRequestIdentity,
    input: PortalRequestCompanyContentApprovalInput,
  ): Promise<PortalRequestCompanyContentApprovalOutcome> {
    try {
      const context = await this.context(identity);
      if (!context) return failure('unauthenticated', 'This portal session is no longer active.');
      const access = await this.dependencies.accessReader.load(context);
      if (!access) return failure('forbidden', 'This workspace is not available to the current portal session.');
      if (!access.canWrite) {
        return failure('forbidden', 'Your workspace role has read-only company content access.');
      }
      const result = await this.dependencies.commandService.requestApproval(context, input);
      return Object.freeze({ ok: true, ...result });
    } catch (error) {
      return commandFailure(error);
    }
  }

  async createEmailDraftVersion(
    identity: PortalCompanyContentRequestIdentity,
    input: PortalCreateCompanyContentEmailDraftVersionInput,
  ): Promise<PortalCreateCompanyContentEmailDraftVersionOutcome> {
    try {
      const context = await this.context(identity);
      if (!context) return failure('unauthenticated', 'This portal session is no longer active.');
      const access = await this.dependencies.accessReader.load(context);
      if (!access) return failure('forbidden', 'This workspace is not available to the current portal session.');
      if (!access.canManage) {
        return failure('forbidden', 'Only a workspace owner or admin can persist campaign email drafts.');
      }
      const createEmailDraft = this.dependencies.draftService?.createEmailDraftVersion;
      if (!createEmailDraft) {
        return failure('unavailable', 'Email draft persistence is temporarily unavailable.');
      }
      const result = await createEmailDraft.call(this.dependencies.draftService, context, input);
      return Object.freeze({ ok: true, ...result });
    } catch (error) {
      return commandFailure(error);
    }
  }

  async decideApproval(
    identity: PortalCompanyContentRequestIdentity,
    input: PortalDecideCompanyContentApprovalInput,
  ): Promise<PortalDecideCompanyContentApprovalOutcome> {
    try {
      const context = await this.context(identity);
      if (!context) return failure('unauthenticated', 'This portal session is no longer active.');
      const access = await this.dependencies.accessReader.load(context);
      if (!access) return failure('forbidden', 'This workspace is not available to the current portal session.');
      if (!access.canManage) {
        return failure('forbidden', 'Only a workspace owner or admin can decide company content approvals.');
      }
      if (input.decision === 'approved'
          && !PORTAL_COMPANY_CONTENT_REVIEW_REPRESENTATION_AVAILABLE) {
        return failure(
          'review_unavailable',
          'Approval is locked until the exact hash-bound content can be shown for review.',
        );
      }
      const result = await this.dependencies.commandService.decideApproval(context, input);
      return Object.freeze({ ok: true, ...result });
    } catch (error) {
      return commandFailure(error);
    }
  }

  async decideExactReviewedApproval(
    identity: PortalCompanyContentRequestIdentity,
    input: PortalDecideExactReviewedCompanyContentApprovalInput,
  ): Promise<PortalDecideCompanyContentApprovalOutcome> {
    try {
      const context = await this.context(identity);
      if (!context) return failure('unauthenticated', 'This portal session is no longer active.');
      const access = await this.dependencies.accessReader.load(context);
      if (!access) return failure('forbidden', 'This workspace is not available to the current portal session.');
      if (!access.canManage) {
        return failure('forbidden', 'Only a workspace owner or admin can decide company content approvals.');
      }
      const exactReview = this.dependencies.readService.getExactReview;
      if (!exactReview) {
        return failure('review_unavailable', 'Exact company content review is temporarily unavailable.');
      }
      const review = await exactReview.call(this.dependencies.readService, context, {
        contentItemId: input.contentItemId,
        contentVersionId: input.contentVersionId,
      });
      if (!review
          || review.contentItemId !== input.contentItemId.toLowerCase()
          || review.contentVersionId !== input.contentVersionId.toLowerCase()
          || review.contentSha256 !== input.contentSha256.toLowerCase()
          || review.approvalStatus !== 'pending'
          || review.approvalStale
          || review.approvalRequestId !== input.approvalRequestId.toLowerCase()) {
        return failure(
          'review_unavailable',
          'The exact reviewed version or pending approval changed. Refresh before approving.',
        );
      }
      const result = await this.dependencies.commandService.decideApproval(context, {
        commandKey: input.commandKey,
        approvalRequestId: input.approvalRequestId,
        decision: 'approved',
        decisionNote: input.decisionNote,
      });
      return Object.freeze({ ok: true, ...result });
    } catch (error) {
      return commandFailure(error);
    }
  }
}

/**
 * Production composition keeps catalogue reads on r72_web and approval writes
 * on r72_content_command. Both runners independently revalidate the same portal
 * session hash inside their RLS transaction.
 */
export function createPgPortalCompanyContentService(input: {
  readonly webPool: Pool;
  readonly commandPool: Pool;
  readonly adapterPool?: Pool;
}): PgPortalCompanyContentService {
  const webRunner = createCompanyContentTransactionRunner(input.webPool);
  return new PgPortalCompanyContentService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    accessReader: new PgPortalCompanyContentWorkspaceAccessReader(webRunner),
    readService: new CompanyContentService({ transactionRunner: webRunner }),
    commandService: new CompanyContentService({
      transactionRunner: createCompanyContentTransactionRunner(input.commandPool),
    }),
    draftService: input.adapterPool ? new CompanyContentService({
      transactionRunner: createCompanyContentTransactionRunner(input.adapterPool),
    }) : undefined,
  });
}
