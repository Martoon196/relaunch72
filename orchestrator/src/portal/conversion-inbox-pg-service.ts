import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { InactivePortalSessionError } from '../db/transaction.js';
import {
  createPgInboxCommandService,
  createPgInboxTransactionRunner,
  InboxCommandInProgressError,
  InboxConsentBlockedError,
  InboxIdempotencyConflictError,
  InboxNotFoundError,
  InboxValidationError,
  InboxVersionConflictError,
  type InboxCommandService,
  type InboxTransactionRunner,
} from '../inbox-pg/index.js';
import { INBOX_COMPLETE_REVIEW_MAX_BODY_BYTES } from '../inbox-pg/limits.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipal,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';
import type {
  PortalConversionInboxCommandService,
  PortalConversionInboxFailure,
  PortalConversionInboxRequestIdentity,
  PortalConversionInboxWorkspaceAccess,
  PortalCreateInboxDraftInput,
  PortalDecideInboxApprovalInput,
  PortalDecideInboxApprovalOutcome,
  PortalInboxMessageMutationOutcome,
  PortalQueueApprovedInboxMessageInput,
  PortalQueueApprovedInboxMessageOutcome,
  PortalRequestInboxApprovalInput,
  PortalRequestInboxApprovalOutcome,
  PortalReviseInboxDraftInput,
} from './conversion-inbox-service.js';

interface WorkspaceAccessRow extends QueryResultRow {
  readonly workspaceId: unknown;
  readonly canWrite: unknown;
  readonly canManage: unknown;
}

const WORKSPACE_ACCESS_SQL = `/* portal.conversion-inbox.workspace-access */
  SELECT workspace.id::text AS "workspaceId",
         app_private.can_write_workspace(
           app_private.current_user_id(), workspace.id
         ) AS "canWrite",
         app_private.can_manage_workspace(
           app_private.current_user_id(), workspace.id
         ) AS "canManage"
  FROM app.workspaces AS workspace
  WHERE workspace.id = app_private.current_workspace_id()`;

export interface PortalConversionInboxWorkspaceAccessReader {
  load(context: DatabaseRequestContext): Promise<PortalConversionInboxWorkspaceAccess | null>;
}

function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

/** RLS-scoped capability read performed before every portal command. */
export class PgPortalConversionInboxWorkspaceAccessReader
implements PortalConversionInboxWorkspaceAccessReader {
  constructor(private readonly transactionRunner: InboxTransactionRunner) {}

  async load(context: DatabaseRequestContext): Promise<PortalConversionInboxWorkspaceAccess | null> {
    return this.transactionRunner.run(context, async (transaction) => {
      const result = await transaction.query<WorkspaceAccessRow>(WORKSPACE_ACCESS_SQL);
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) {
        throw new Error('Conversion Inbox workspace access was returned more than once');
      }
      const row = result.rows[0]!;
      const workspaceId = canonicalUuid(row.workspaceId);
      if (workspaceId !== context.workspaceId.toLowerCase()
          || typeof row.canWrite !== 'boolean'
          || typeof row.canManage !== 'boolean') {
        throw new Error('Conversion Inbox workspace access returned invalid data');
      }
      return Object.freeze({ workspaceId, canWrite: row.canWrite, canManage: row.canManage });
    }, { readOnly: true });
  }
}

type InboxCommandBoundary = Pick<InboxCommandService,
  | 'createDraft'
  | 'reviseDraft'
  | 'requestApproval'
  | 'decideApproval'
  | 'queueApprovedMessage'>;

export interface PgPortalConversionInboxDependencies {
  readonly principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  readonly accessReader: PortalConversionInboxWorkspaceAccessReader;
  /** Must be backed by the least-privilege r72_crm_command role. */
  readonly commandService: InboxCommandBoundary;
}

function databaseContext(
  identity: PortalConversionInboxRequestIdentity,
  principal: PortalCrmPrincipal,
): DatabaseRequestContext {
  return requestDatabaseContext({
    ...principal,
    requestId: identity.requestId,
    portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest(),
  });
}

function positiveVersion(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function postgresCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof (error as { readonly code?: unknown }).code === 'string'
    ? (error as { readonly code: string }).code
    : null;
}

function failure(
  kind: PortalConversionInboxFailure['kind'],
  message: string,
): PortalConversionInboxFailure {
  return Object.freeze({ ok: false, kind, message });
}

function completeReviewBodyFailure(body: unknown): PortalConversionInboxFailure | null {
  if (typeof body === 'string'
      && Buffer.byteLength(body, 'utf8') <= INBOX_COMPLETE_REVIEW_MAX_BODY_BYTES) {
    return null;
  }
  return failure(
    'validation',
    `Keep the draft within ${INBOX_COMPLETE_REVIEW_MAX_BODY_BYTES.toLocaleString('en-GB')} UTF-8 bytes so its complete immutable copy can be reviewed.`,
  );
}

function commandFailure(error: unknown): PortalConversionInboxFailure {
  if (error instanceof InactivePortalSessionError) {
    return failure('unauthenticated', 'This portal session is no longer active.');
  }
  if (error instanceof InboxValidationError) {
    return failure('validation', 'Check the secure command, exact draft version and message details.');
  }
  if (error instanceof InboxNotFoundError) {
    return failure('not_found', 'That TEST conversation, message or approval is not available in this workspace.');
  }
  if (error instanceof InboxIdempotencyConflictError) {
    return failure('idempotency_conflict', 'This command key was already used for different message details. Refresh before trying again.');
  }
  if (error instanceof InboxCommandInProgressError) {
    return failure('command_in_progress', 'This message command is already being processed. Refresh before trying again.');
  }
  if (error instanceof InboxVersionConflictError) {
    return failure('version_conflict', 'That immutable draft changed after the page loaded. Refresh before trying again.');
  }
  if (error instanceof InboxConsentBlockedError) {
    return failure('consent_blocked', 'This TEST delivery was not queued because the current consent or suppression state blocks it.');
  }
  if (postgresCode(error) === '42501') {
    return failure('forbidden', 'Your workspace role cannot perform that Conversion Inbox action.');
  }
  return failure('unavailable', 'The Conversion Inbox change could not be saved safely. No provider call was made.');
}

export class PgPortalConversionInboxCommandService
implements PortalConversionInboxCommandService {
  constructor(private readonly dependencies: PgPortalConversionInboxDependencies) {}

  async #context(
    identity: PortalConversionInboxRequestIdentity,
  ): Promise<DatabaseRequestContext | null> {
    const principal = await this.dependencies.principalResolver.resolve(identity.sessionToken);
    return principal ? databaseContext(identity, principal) : null;
  }

  async #writableContext(
    identity: PortalConversionInboxRequestIdentity,
    managerOnly = false,
  ): Promise<DatabaseRequestContext | PortalConversionInboxFailure> {
    const context = await this.#context(identity);
    if (!context) return failure('unauthenticated', 'This portal session is no longer active.');
    const access = await this.dependencies.accessReader.load(context);
    if (!access) {
      return failure('forbidden', 'This workspace is not available to the current portal session.');
    }
    if (!access.canWrite) {
      return failure('forbidden', 'Your workspace role has read-only Conversion Inbox access.');
    }
    if (managerOnly && !access.canManage) {
      return failure('forbidden', 'Only a workspace owner or admin can approve or queue TEST delivery.');
    }
    return context;
  }

  async createDraft(
    identity: PortalConversionInboxRequestIdentity,
    input: PortalCreateInboxDraftInput,
  ): Promise<PortalInboxMessageMutationOutcome> {
    const bodyFailure = completeReviewBodyFailure(input.body);
    if (bodyFailure) return bodyFailure;
    try {
      const context = await this.#writableContext(identity);
      if ('ok' in context) return context;
      const result = await this.dependencies.commandService.createDraft(context, input);
      return Object.freeze({ ok: true, ...result });
    } catch (error) {
      return commandFailure(error);
    }
  }

  async reviseDraft(
    identity: PortalConversionInboxRequestIdentity,
    input: PortalReviseInboxDraftInput,
  ): Promise<PortalInboxMessageMutationOutcome> {
    const expectedRowVersion = positiveVersion(input.expectedRowVersion);
    if (expectedRowVersion === null) {
      return failure('validation', 'Refresh the secure draft form before saving this version.');
    }
    const bodyFailure = completeReviewBodyFailure(input.body);
    if (bodyFailure) return bodyFailure;
    try {
      const context = await this.#writableContext(identity);
      if ('ok' in context) return context;
      const result = await this.dependencies.commandService.reviseDraft(context, {
        ...input,
        expectedRowVersion,
      });
      return Object.freeze({ ok: true, ...result });
    } catch (error) {
      return commandFailure(error);
    }
  }

  async requestApproval(
    identity: PortalConversionInboxRequestIdentity,
    input: PortalRequestInboxApprovalInput,
  ): Promise<PortalRequestInboxApprovalOutcome> {
    const expectedRowVersion = positiveVersion(input.expectedRowVersion);
    if (expectedRowVersion === null) {
      return failure('validation', 'Refresh the secure draft form before requesting approval.');
    }
    try {
      const context = await this.#writableContext(identity);
      if ('ok' in context) return context;
      const result = await this.dependencies.commandService.requestApproval(context, {
        ...input,
        expectedRowVersion,
      });
      return Object.freeze({ ok: true, ...result });
    } catch (error) {
      return commandFailure(error);
    }
  }

  async decideApproval(
    identity: PortalConversionInboxRequestIdentity,
    input: PortalDecideInboxApprovalInput,
  ): Promise<PortalDecideInboxApprovalOutcome> {
    try {
      const context = await this.#writableContext(identity, true);
      if ('ok' in context) return context;
      const result = await this.dependencies.commandService.decideApproval(context, input);
      return Object.freeze({ ok: true, ...result });
    } catch (error) {
      return commandFailure(error);
    }
  }

  async queueApprovedMessage(
    identity: PortalConversionInboxRequestIdentity,
    input: PortalQueueApprovedInboxMessageInput,
  ): Promise<PortalQueueApprovedInboxMessageOutcome> {
    const expectedRowVersion = positiveVersion(input.expectedRowVersion);
    if (expectedRowVersion === null) {
      return failure('validation', 'Refresh the secure approved message before queueing TEST delivery.');
    }
    try {
      const context = await this.#writableContext(identity, true);
      if ('ok' in context) return context;
      const result = await this.dependencies.commandService.queueApprovedMessage(context, {
        ...input,
        expectedRowVersion,
      });
      return Object.freeze({
        ok: true,
        ...result,
        environment: 'test' as const,
        provider: 'test_conversation' as const,
      });
    } catch (error) {
      return commandFailure(error);
    }
  }
}

/**
 * Production-ready composition seam. Portal reads/session resolution stay on
 * r72_web and every mutation runs as r72_crm_command. The returned service has
 * no provider-dispatch capability and therefore cannot perform network I/O.
 */
export function createPgPortalConversionInboxCommandService(input: {
  readonly webPool: Pool;
  readonly commandPool: Pool;
}): PgPortalConversionInboxCommandService {
  const webRunner = createPgInboxTransactionRunner(input.webPool);
  return new PgPortalConversionInboxCommandService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    accessReader: new PgPortalConversionInboxWorkspaceAccessReader(webRunner),
    commandService: createPgInboxCommandService(input.commandPool),
  });
}
