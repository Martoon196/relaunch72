import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import type { SqlExecutor } from '../crm-pg/types.js';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { InactivePortalSessionError, withTransaction } from '../db/transaction.js';
import {
  PgSocialCampaignCommandRepository,
  PgSocialCampaignReadRepository,
  SocialCampaignPgContractError,
  socialCampaignRevisionSha256,
} from '../social-campaign-pg/index.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipal,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';
import type {
  PortalCancelPublicSocialPlanningTargetInput,
  PortalCreatePublicSocialCampaignPlanInput,
  PortalCreatePublicSocialRevisionInput,
  PortalPlanPublicSocialCampaignInput,
  PortalPublicSocialCommandOutcome,
  PortalPublicSocialFailure,
  PortalPublicSocialRequestIdentity,
  PortalPublicSocialService,
  PortalPublicSocialSnapshotInput,
  PortalPublicSocialSnapshotOutcome,
  PortalPublicSocialWorkspaceAccess,
  PortalReschedulePublicSocialTargetInput,
} from './public-social-service.js';

interface WorkspaceAccessRow extends QueryResultRow {
  readonly workspaceId: unknown;
  readonly workspaceName: unknown;
  readonly timezone: unknown;
  readonly snapshotAt: unknown;
  readonly canManage: unknown;
}

const WORKSPACE_ACCESS_SQL = `/* portal.public-social.workspace-access */
  SELECT workspace.id::text AS "workspaceId",
         workspace.name AS "workspaceName",
         workspace.timezone,
         transaction_timestamp() AS "snapshotAt",
         app_private.can_manage_workspace(
           app_private.current_user_id(), workspace.id
         ) AS "canManage"
  FROM app.workspaces AS workspace
  WHERE workspace.id = app_private.current_workspace_id()`;

export interface PortalPublicSocialTransactionRunner {
  run<T>(
    context: DatabaseRequestContext,
    operation: (transaction: SqlExecutor) => Promise<T>,
    options: Readonly<{ readOnly: boolean; serializable?: boolean }>,
  ): Promise<T>;
}

export interface PgPortalPublicSocialDependencies {
  readonly principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  /** Must be backed by the web/read role. */
  readonly readRunner: PortalPublicSocialTransactionRunner;
  /** Must be backed by the dedicated public-social command role. */
  readonly commandRunner: PortalPublicSocialTransactionRunner;
}

function databaseContext(
  identity: PortalPublicSocialRequestIdentity,
  principal: PortalCrmPrincipal,
): DatabaseRequestContext {
  return requestDatabaseContext({
    ...principal,
    requestId: identity.requestId,
    portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest(),
  });
}

function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ? value.toLowerCase()
    : null;
}

function requiredText(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value === value.trim() && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maximum
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function timestamp(value: unknown): string | null {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function timezone(value: unknown): string | null {
  const candidate = requiredText(value, 100);
  if (!candidate) return null;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return null;
  }
}

function workspaceAccess(
  row: WorkspaceAccessRow,
  context: DatabaseRequestContext,
): PortalPublicSocialWorkspaceAccess {
  const workspaceId = canonicalUuid(row.workspaceId);
  const workspaceName = requiredText(row.workspaceName, 200);
  const selectedTimezone = timezone(row.timezone);
  const snapshotAt = timestamp(row.snapshotAt);
  if (workspaceId !== context.workspaceId.toLowerCase() || !workspaceName
      || !selectedTimezone || !snapshotAt || typeof row.canManage !== 'boolean') {
    throw new Error('Public-social workspace access returned invalid data');
  }
  return Object.freeze({
    workspaceId,
    workspaceName,
    timezone: selectedTimezone,
    snapshotAt,
    canManage: row.canManage,
  });
}

async function loadWorkspaceAccess(
  transaction: SqlExecutor,
  context: DatabaseRequestContext,
): Promise<PortalPublicSocialWorkspaceAccess | null> {
  const result = await transaction.query<WorkspaceAccessRow>(WORKSPACE_ACCESS_SQL);
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) {
    throw new Error('Public-social workspace access was returned more than once');
  }
  return workspaceAccess(result.rows[0]!, context);
}

function postgresCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof (error as { readonly code?: unknown }).code === 'string'
    ? (error as { readonly code: string }).code
    : null;
}

function failure(
  kind: PortalPublicSocialFailure['kind'],
  message: string,
): PortalPublicSocialFailure {
  return Object.freeze({ ok: false, kind, message });
}

function outcomeFailure(error: unknown, operation: 'read' | 'command'): PortalPublicSocialFailure {
  if (error instanceof InactivePortalSessionError) {
    return failure('unauthenticated', 'This portal session is no longer active.');
  }
  if (error instanceof SocialCampaignPgContractError || postgresCode(error) === '22023') {
    return failure('validation', 'Check the exact TEST campaign evidence and try again.');
  }
  if (postgresCode(error) === 'P0039') {
    return failure(
      'validation',
      'The exact source proof expires before that TEST time. Refresh the proof or choose an earlier rehearsal time.',
    );
  }
  if (postgresCode(error) === 'P0002') {
    return failure('not_found', 'That exact TEST planning intent or target is unavailable.');
  }
  if (postgresCode(error) === '42501') {
    return failure('forbidden', 'Workspace owner or admin access is required for TEST campaign command.');
  }
  if (postgresCode(error) === '23503') {
    return failure('not_found', 'That exact TEST campaign, target or approved content evidence is unavailable.');
  }
  if (['23505', '40001', '55000'].includes(postgresCode(error) ?? '')) {
    return failure('conflict', 'The TEST campaign changed after this page loaded. Refresh before trying again.');
  }
  return operation === 'read'
    ? failure('unavailable', 'The TEST campaign snapshot is temporarily unavailable.')
    : failure('unavailable', 'The TEST campaign change could not be saved safely. No provider action was triggered.');
}

function portalCommandKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,128}$/u.test(value)) {
    throw new SocialCampaignPgContractError('commandKey is invalid');
  }
  return value;
}

/** Stable server-derived UUID makes a browser command key replay-safe without trusting an id. */
function portalCommandUuid(
  kind: 'campaign' | 'revision' | 'plan' | 'reschedule',
  context: DatabaseRequestContext,
  rawCommandKey: unknown,
): string {
  const commandKey = portalCommandKey(rawCommandKey);
  if (!context.userId) throw new SocialCampaignPgContractError('user context is invalid');
  const bytes = createHash('sha256').update([
    'public-social-portal-command/v1', kind, context.workspaceId, context.userId, commandKey,
  ].join('\n'), 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function commandSuccess<TResult>(
  result: TResult,
): PortalPublicSocialCommandOutcome<TResult> {
  return Object.freeze({
    ok: true as const,
    result,
    environment: 'test' as const,
    providerEffects: 'none' as const,
  });
}

export class PgPortalPublicSocialService implements PortalPublicSocialService {
  constructor(private readonly dependencies: PgPortalPublicSocialDependencies) {}

  private async context(
    identity: PortalPublicSocialRequestIdentity,
  ): Promise<DatabaseRequestContext | null> {
    const principal = await this.dependencies.principalResolver.resolve(identity.sessionToken);
    return principal ? databaseContext(identity, principal) : null;
  }

  private async canManage(context: DatabaseRequestContext): Promise<boolean> {
    return this.dependencies.readRunner.run(context, async (transaction) => {
      const access = await loadWorkspaceAccess(transaction, context);
      return access?.canManage === true;
    }, { readOnly: true });
  }

  private async workspaceAccess(
    context: DatabaseRequestContext,
  ): Promise<PortalPublicSocialWorkspaceAccess | null> {
    return this.dependencies.readRunner.run(
      context,
      (transaction) => loadWorkspaceAccess(transaction, context),
      { readOnly: true },
    );
  }

  async snapshot(
    identity: PortalPublicSocialRequestIdentity,
    input: PortalPublicSocialSnapshotInput,
  ): Promise<PortalPublicSocialSnapshotOutcome> {
    try {
      const context = await this.context(identity);
      if (!context) return failure('unauthenticated', 'This portal session is no longer active.');
      return await this.dependencies.readRunner.run(context, async (transaction) => {
        const workspace = await loadWorkspaceAccess(transaction, context);
        if (!workspace) {
          return failure('forbidden', 'This workspace is not available to the current portal session.');
        }
        const repository = new PgSocialCampaignReadRepository(transaction);
        const campaign = input.campaignId
          ? await repository.listCampaign(context.workspaceId, input.campaignId)
          : Object.freeze({ items: Object.freeze([]), hasMore: false });
        const calendar = await repository.listCalendar({
          workspaceId: context.workspaceId,
          from: input.from,
          to: input.to,
          limit: input.limit,
        });
        const planningTargets = await repository.listPlannerTargets(
          context.workspaceId,
          input.limit ?? 120,
        );
        const planningCalendar = await repository.listPlanningCalendar({
          workspaceId: context.workspaceId,
          from: input.from,
          to: input.to,
          limit: input.limit,
        });
        return Object.freeze({
          ok: true,
          snapshot: Object.freeze({
            workspace,
            campaign,
            calendar,
            planning: Object.freeze({
              targets: planningTargets,
              calendar: planningCalendar,
            }),
            environment: 'test' as const,
            providerEffects: 'none' as const,
          }),
        });
      }, { readOnly: true, serializable: true });
    } catch (error) {
      return outcomeFailure(error, 'read');
    }
  }

  async createRevision(
    identity: PortalPublicSocialRequestIdentity,
    input: PortalCreatePublicSocialRevisionInput,
  ) {
    try {
      const context = await this.context(identity);
      if (!context) return failure('unauthenticated', 'This portal session is no longer active.');
      if (!await this.canManage(context)) {
        return failure('forbidden', 'Only a workspace owner or admin can manage TEST campaigns.');
      }
      const revision = {
        ...input,
        workspaceId: context.workspaceId,
      };
      const result = await this.dependencies.commandRunner.run(context, (transaction) =>
        new PgSocialCampaignCommandRepository(transaction).createRevision({
          ...revision,
          revisionSha256: socialCampaignRevisionSha256(revision),
        }), { readOnly: false, serializable: true });
      return commandSuccess(result);
    } catch (error) {
      return outcomeFailure(error, 'command');
    }
  }

  async createCampaignPlan(
    identity: PortalPublicSocialRequestIdentity,
    input: PortalCreatePublicSocialCampaignPlanInput,
  ) {
    try {
      const context = await this.context(identity);
      if (!context) return failure('unauthenticated', 'This portal session is no longer active.');
      const access = await this.workspaceAccess(context);
      if (!access?.canManage) {
        return failure('forbidden', 'Only a workspace owner or admin can plan TEST campaigns.');
      }
      const campaignId = portalCommandUuid('campaign', context, input.commandKey);
      const revisionId = portalCommandUuid('revision', context, input.commandKey);
      const intentId = portalCommandUuid('plan', context, input.commandKey);
      const result = await this.dependencies.commandRunner.run(context, async (transaction) => {
        const repository = new PgSocialCampaignCommandRepository(transaction);
        const revision = {
          workspaceId: context.workspaceId,
          campaignId,
          revisionId,
          revisionNumber: 1,
          previousRevisionId: null,
          title: input.title,
          objective: input.objective,
          timezone: access.timezone,
        } as const;
        const created = await repository.createRevision({
          ...revision,
          revisionSha256: socialCampaignRevisionSha256(revision),
        });
        const planned = await repository.planIntent({
          workspaceId: context.workspaceId,
          intentId,
          campaignId,
          revisionId,
          contentVersionId: input.contentVersionId,
          desiredFor: input.desiredFor,
          maxAttempts: input.maxAttempts ?? 3,
          targetIds: input.targetIds,
          mediaVersionIds: input.mediaVersionIds,
        });
        return Object.freeze({
          campaignId: created.campaignId,
          revisionId: created.revisionId,
          intentId: planned.intentId,
          intentSha256: planned.intentSha256,
          disposition: created.disposition === 'replayed' && planned.disposition === 'replayed'
            ? 'replayed' as const
            : 'applied' as const,
        });
      }, { readOnly: false, serializable: true });
      return commandSuccess(result);
    } catch (error) {
      return outcomeFailure(error, 'command');
    }
  }

  async plan(
    identity: PortalPublicSocialRequestIdentity,
    input: PortalPlanPublicSocialCampaignInput,
  ) {
    try {
      const context = await this.context(identity);
      if (!context) return failure('unauthenticated', 'This portal session is no longer active.');
      if (!await this.canManage(context)) {
        return failure('forbidden', 'Only a workspace owner or admin can plan TEST campaigns.');
      }
      const intentId = portalCommandUuid('plan', context, input.commandKey);
      const result = await this.dependencies.commandRunner.run(context, (transaction) =>
        new PgSocialCampaignCommandRepository(transaction).planIntent({
          workspaceId: context.workspaceId,
          intentId,
          campaignId: input.campaignId,
          revisionId: input.revisionId,
          contentVersionId: input.contentVersionId,
          desiredFor: input.desiredFor,
          maxAttempts: input.maxAttempts,
          targetIds: input.targetIds,
          mediaVersionIds: input.mediaVersionIds,
        }), { readOnly: false, serializable: true });
      return commandSuccess(result);
    } catch (error) {
      return outcomeFailure(error, 'command');
    }
  }

  async reschedule(
    identity: PortalPublicSocialRequestIdentity,
    input: PortalReschedulePublicSocialTargetInput,
  ) {
    try {
      const context = await this.context(identity);
      if (!context) return failure('unauthenticated', 'This portal session is no longer active.');
      if (!await this.canManage(context)) {
        return failure('forbidden', 'Only a workspace owner or admin can reschedule TEST campaigns.');
      }
      const successorIntentId = portalCommandUuid('reschedule', context, input.commandKey);
      const result = await this.dependencies.commandRunner.run(context, (transaction) =>
        new PgSocialCampaignCommandRepository(transaction).reschedulePlanningTarget({
          workspaceId: context.workspaceId,
          predecessorIntentId: input.predecessorIntentId,
          targetId: input.targetId,
          successorIntentId,
          newDesiredFor: input.newDesiredFor,
          reason: input.reason,
        }), { readOnly: false, serializable: true });
      return commandSuccess(result);
    } catch (error) {
      return outcomeFailure(error, 'command');
    }
  }

  async cancel(
    identity: PortalPublicSocialRequestIdentity,
    input: PortalCancelPublicSocialPlanningTargetInput,
  ) {
    try {
      const context = await this.context(identity);
      if (!context) return failure('unauthenticated', 'This portal session is no longer active.');
      if (!await this.canManage(context)) {
        return failure('forbidden', 'Only a workspace owner or admin can cancel TEST campaign plans.');
      }
      const result = await this.dependencies.commandRunner.run(context, (transaction) =>
        new PgSocialCampaignCommandRepository(transaction).cancelPlanningTarget({
          workspaceId: context.workspaceId,
          intentId: input.intentId,
          targetId: input.targetId,
          reason: input.reason,
        }), { readOnly: false, serializable: true });
      return commandSuccess(result);
    } catch (error) {
      return outcomeFailure(error, 'command');
    }
  }
}

export function createPortalPublicSocialTransactionRunner(
  pool: Pick<Pool, 'connect'>,
): PortalPublicSocialTransactionRunner {
  return {
    run: (context, operation, options) => withTransaction(
      pool,
      context,
      async (client) => operation({
        async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          values: readonly unknown[] = [],
        ) {
          const result = await client.query<TRow>(sql, [...values]);
          return { rows: result.rows, rowCount: result.rowCount };
        },
      }),
      {
        readOnly: options.readOnly,
        isolation: options.serializable ? 'serializable' : 'read committed',
      },
    ),
  };
}

/** Production composition keeps portal reads and social commands on separate least-privilege pools. */
export function createPgPortalPublicSocialService(input: {
  readonly webPool: Pool;
  readonly publicSocialCommandPool: Pool;
}): PgPortalPublicSocialService {
  return new PgPortalPublicSocialService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    readRunner: createPortalPublicSocialTransactionRunner(input.webPool),
    commandRunner: createPortalPublicSocialTransactionRunner(input.publicSocialCommandPool),
  });
}
