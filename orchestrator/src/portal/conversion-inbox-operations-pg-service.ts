import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import type { SqlExecutor } from '../crm-pg/types.js';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { InactivePortalSessionError, withTransaction } from '../db/transaction.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipal,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';
import type { PortalConversionInboxRequestIdentity } from './conversion-inbox-service.js';
import {
  CONVERSION_INBOX_CALL_NOTE_MAX_BYTES,
  CONVERSION_INBOX_CALL_OUTCOMES,
  CONVERSION_INBOX_CALL_SUMMARY_MAX_BYTES,
  CONVERSION_INBOX_INTERNAL_NOTE_MAX_BYTES,
  CONVERSION_INBOX_NEXT_ACTION_KINDS,
  CONVERSION_INBOX_NEXT_ACTION_PRIORITIES,
  CONVERSION_INBOX_NEXT_ACTION_TITLE_MAX_BYTES,
  CONVERSION_INBOX_OPERATION_COMMAND_KEY_PATTERN,
  type PortalAppendConversionInboxInternalNoteInput,
  type PortalAppendConversionInboxInternalNoteOutcome,
  type PortalAssignConversionInboxConversationInput,
  type PortalAssignConversionInboxConversationOutcome,
  type PortalConversionInboxOperationFailure,
  type PortalConversionInboxOperationsService,
  type PortalCreateConversionInboxAdminCallInput,
  type PortalCreateConversionInboxAdminCallOutcome,
  type PortalRecordConversionInboxCallOutcomeInput,
  type PortalRecordConversionInboxCallOutcomeOutcome,
} from './conversion-inbox-operations-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const CALL_OUTCOMES = new Set<string>(CONVERSION_INBOX_CALL_OUTCOMES);
const NEXT_ACTION_KINDS = new Set<string>(CONVERSION_INBOX_NEXT_ACTION_KINDS);
const NEXT_ACTION_PRIORITIES = new Set<string>(CONVERSION_INBOX_NEXT_ACTION_PRIORITIES);

interface AssignmentRow extends QueryResultRow {
  readonly disposition: unknown;
  readonly conversationId: unknown;
  readonly assignedUserId: unknown;
  readonly rowVersion: unknown;
}

interface InternalNoteRow extends QueryResultRow {
  readonly disposition: unknown;
  readonly conversationId: unknown;
  readonly messageId: unknown;
  readonly messageVersionId: unknown;
  readonly versionNumber: unknown;
  readonly bodySha256: unknown;
  readonly conversationRowVersion: unknown;
}

interface AdminCallRow extends QueryResultRow {
  readonly disposition: unknown;
  readonly conversationId: unknown;
  readonly contactId: unknown;
  readonly taskId: unknown;
  readonly taskRowVersion: unknown;
}

interface CallOutcomeRow extends QueryResultRow {
  readonly disposition: unknown;
  readonly conversationId: unknown;
  readonly contactId: unknown;
  readonly outcomeId: unknown;
  readonly completedTaskId: unknown;
  readonly completedTaskRowVersion: unknown;
  readonly nextTaskId: unknown;
  readonly nextTaskRowVersion: unknown;
}

export interface PortalConversionInboxOperationsTransactionRunner {
  run<T>(
    context: DatabaseRequestContext,
    operation: (transaction: SqlExecutor) => Promise<T>,
  ): Promise<T>;
}

export interface PgPortalConversionInboxOperationsDependencies {
  readonly principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  /** Must be backed by the least-privilege r72_crm_command role. */
  readonly commandRunner: PortalConversionInboxOperationsTransactionRunner;
}

function failure(
  kind: PortalConversionInboxOperationFailure['kind'],
  message: string,
): PortalConversionInboxOperationFailure {
  return Object.freeze({ ok: false, kind, message });
}

function postgresCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof (error as { readonly code?: unknown }).code === 'string'
    ? (error as { readonly code: string }).code
    : null;
}

function commandFailure(error: unknown): PortalConversionInboxOperationFailure {
  if (error instanceof InactivePortalSessionError) {
    return failure('unauthenticated', 'This portal session is no longer active.');
  }
  const code = postgresCode(error);
  if (code === '42501') {
    return failure('forbidden', 'The current portal session cannot perform that Conversion Inbox action.');
  }
  if (code === '23503' || code === 'P0002') {
    return failure('not_found', 'That workspace-scoped conversation or admin-call task is unavailable.');
  }
  if (code === '40001') {
    return failure('version_conflict', 'The operational record changed after this page loaded. Refresh before trying again.');
  }
  if (code === '23505' || code === '22000') {
    return failure('idempotency_conflict', 'This command key was already used for different operational details.');
  }
  if (code === '55P03' || code === '55000') {
    return failure('command_in_progress', 'This operational command is already being processed. Refresh before trying again.');
  }
  if (code === '22023' || code === '23514') {
    return failure('validation', 'Check the exact Conversion Inbox action details and try again.');
  }
  return failure('unavailable', 'The Conversion Inbox operation could not be saved safely. No external effect was requested.');
}

function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}

function positiveVersion(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString() === value ? value : null;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function boundedText(value: unknown, maximumBytes: number): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && isWellFormedUnicode(value)
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    && Buffer.byteLength(value, 'utf8') <= maximumBytes
    ? value
    : null;
}

function commandKey(value: unknown): string | null {
  return typeof value === 'string' && CONVERSION_INBOX_OPERATION_COMMAND_KEY_PATTERN.test(value)
    ? value
    : null;
}

function disposition(value: unknown): 'applied' | 'replayed' {
  if (value !== 'applied' && value !== 'replayed') {
    throw new Error('Conversion Inbox operation returned an invalid disposition');
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  const parsed = canonicalUuid(value);
  if (!parsed) throw new Error(`Conversion Inbox operation returned an invalid ${label}`);
  return parsed;
}

function nullableUuid(value: unknown, label: string): string | null {
  if (value === null) return null;
  return uuid(value, label);
}

function version(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Conversion Inbox operation returned an invalid ${label}`);
  }
  return parsed;
}

function nullableVersion(value: unknown, label: string): number | null {
  if (value === null) return null;
  return version(value, label);
}

function digestHex(value: unknown): string {
  if (Buffer.isBuffer(value) && value.length === 32) return value.toString('hex');
  if (typeof value === 'string' && SHA256.test(value)) return value;
  throw new Error('Conversion Inbox operation returned an invalid body digest');
}

function oneRow<TRow extends QueryResultRow>(
  rows: readonly TRow[],
  label: string,
): TRow {
  if (rows.length !== 1 || !rows[0]) {
    throw new Error(`Conversion Inbox ${label} returned invalid cardinality`);
  }
  return rows[0];
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

function validIdentity(identity: PortalConversionInboxRequestIdentity): boolean {
  return typeof identity?.sessionToken === 'string'
    && identity.sessionToken.length > 0
    && identity.sessionToken.length <= 4_096
    && typeof identity.requestId === 'string'
    && /^[\x21-\x7e]{1,128}$/u.test(identity.requestId);
}

export class PgPortalConversionInboxOperationsService
implements PortalConversionInboxOperationsService {
  constructor(private readonly dependencies: PgPortalConversionInboxOperationsDependencies) {}

  async #context(
    identity: PortalConversionInboxRequestIdentity,
  ): Promise<DatabaseRequestContext | PortalConversionInboxOperationFailure> {
    if (!validIdentity(identity)) {
      return failure('unauthenticated', 'This portal session is no longer active.');
    }
    const principal = await this.dependencies.principalResolver.resolve(identity.sessionToken);
    return principal
      ? databaseContext(identity, principal)
      : failure('unauthenticated', 'This portal session is no longer active.');
  }

  async assignConversation(
    identity: PortalConversionInboxRequestIdentity,
    input: PortalAssignConversionInboxConversationInput,
  ): Promise<PortalAssignConversionInboxConversationOutcome> {
    const key = commandKey(input?.commandKey);
    const conversationId = canonicalUuid(input?.conversationId);
    const expectedRowVersion = positiveVersion(input?.expectedRowVersion);
    if (!key || !conversationId || expectedRowVersion === null
        || (input.assignment !== 'self' && input.assignment !== 'unassigned')) {
      return failure('validation', 'Refresh the assignment control and check the exact operational details.');
    }
    try {
      const context = await this.#context(identity);
      if ('ok' in context) return context;
      const assignedUserId = input.assignment === 'self' ? context.userId! : null;
      return await this.dependencies.commandRunner.run(context, async (transaction) => {
        const result = await transaction.query<AssignmentRow>(
          `/* portal.conversion-inbox-operations.assign-conversation */
           SELECT disposition,
                  conversation_id AS "conversationId",
                  assigned_user_id AS "assignedUserId",
                  row_version AS "rowVersion"
           FROM app_private.assign_operational_inbox_conversation(
             $1::uuid, $2::bytea, $3::uuid, $4::uuid, $5::bigint, $6::text
           )`,
          [context.workspaceId, context.portalSessionTokenHash!, conversationId,
            assignedUserId, expectedRowVersion, key],
        );
        const row = oneRow(result.rows, 'assignment');
        return Object.freeze({
          ok: true as const,
          disposition: disposition(row.disposition),
          conversationId: uuid(row.conversationId, 'conversation id'),
          assignedUserId: nullableUuid(row.assignedUserId, 'assigned user id'),
          rowVersion: version(row.rowVersion, 'conversation row version'),
        });
      });
    } catch (error) {
      return commandFailure(error);
    }
  }

  async appendInternalNote(
    identity: PortalConversionInboxRequestIdentity,
    input: PortalAppendConversionInboxInternalNoteInput,
  ): Promise<PortalAppendConversionInboxInternalNoteOutcome> {
    const key = commandKey(input?.commandKey);
    const conversationId = canonicalUuid(input?.conversationId);
    const body = boundedText(input?.body, CONVERSION_INBOX_INTERNAL_NOTE_MAX_BYTES);
    if (!key || !conversationId || !body) {
      return failure('validation', `Keep the internal note within ${CONVERSION_INBOX_INTERNAL_NOTE_MAX_BYTES.toLocaleString('en-GB')} UTF-8 bytes.`);
    }
    try {
      const context = await this.#context(identity);
      if ('ok' in context) return context;
      return await this.dependencies.commandRunner.run(context, async (transaction) => {
        const result = await transaction.query<InternalNoteRow>(
          `/* portal.conversion-inbox-operations.append-internal-note */
           SELECT disposition,
                  conversation_id AS "conversationId",
                  message_id AS "messageId",
                  message_version_id AS "messageVersionId",
                  version_number AS "versionNumber",
                  body_sha256 AS "bodySha256",
                  conversation_row_version AS "conversationRowVersion"
           FROM app_private.append_operational_inbox_internal_note(
             $1::uuid, $2::bytea, $3::uuid, $4::text, $5::text
           )`,
          [context.workspaceId, context.portalSessionTokenHash!, conversationId, body, key],
        );
        const row = oneRow(result.rows, 'internal note');
        return Object.freeze({
          ok: true as const,
          disposition: disposition(row.disposition),
          conversationId: uuid(row.conversationId, 'conversation id'),
          messageId: uuid(row.messageId, 'message id'),
          messageVersionId: uuid(row.messageVersionId, 'message version id'),
          versionNumber: version(row.versionNumber, 'message version number'),
          bodySha256: digestHex(row.bodySha256),
          conversationRowVersion: version(
            row.conversationRowVersion,
            'conversation row version',
          ),
        });
      });
    } catch (error) {
      return commandFailure(error);
    }
  }

  async createAdminCall(
    identity: PortalConversionInboxRequestIdentity,
    input: PortalCreateConversionInboxAdminCallInput,
  ): Promise<PortalCreateConversionInboxAdminCallOutcome> {
    const key = commandKey(input?.commandKey);
    const conversationId = canonicalUuid(input?.conversationId);
    const dueAt = canonicalTimestamp(input?.dueAt);
    const note = input?.note === null || input?.note === undefined
      ? null
      : boundedText(input.note, CONVERSION_INBOX_CALL_NOTE_MAX_BYTES);
    if (!key || !conversationId || !dueAt
        || (input.priority !== 'high' && input.priority !== 'urgent')
        || (input.note !== null && input.note !== undefined && !note)) {
      return failure('validation', 'Check the high-priority admin-call task details and canonical due time.');
    }
    try {
      const context = await this.#context(identity);
      if ('ok' in context) return context;
      return await this.dependencies.commandRunner.run(context, async (transaction) => {
        const result = await transaction.query<AdminCallRow>(
          `/* portal.conversion-inbox-operations.create-admin-call */
           SELECT disposition,
                  conversation_id AS "conversationId",
                  contact_id AS "contactId",
                  task_id AS "taskId",
                  task_row_version AS "taskRowVersion"
           FROM app_private.create_operational_inbox_admin_call_task(
             $1::uuid, $2::bytea, $3::uuid, $4::text, $5::timestamptz,
             $6::text, $7::text
           )`,
          [context.workspaceId, context.portalSessionTokenHash!, conversationId,
            input.priority, dueAt, note, key],
        );
        const row = oneRow(result.rows, 'admin call');
        return Object.freeze({
          ok: true as const,
          disposition: disposition(row.disposition),
          conversationId: uuid(row.conversationId, 'conversation id'),
          contactId: uuid(row.contactId, 'contact id'),
          taskId: uuid(row.taskId, 'task id'),
          taskRowVersion: version(row.taskRowVersion, 'task row version'),
        });
      });
    } catch (error) {
      return commandFailure(error);
    }
  }

  async recordCallOutcome(
    identity: PortalConversionInboxRequestIdentity,
    input: PortalRecordConversionInboxCallOutcomeInput,
  ): Promise<PortalRecordConversionInboxCallOutcomeOutcome> {
    const key = commandKey(input?.commandKey);
    const conversationId = canonicalUuid(input?.conversationId);
    const taskId = canonicalUuid(input?.taskId);
    const expectedTaskRowVersion = positiveVersion(input?.expectedTaskRowVersion);
    const outcome = typeof input?.outcome === 'string' && CALL_OUTCOMES.has(input.outcome)
      ? input.outcome
      : null;
    const summary = boundedText(input?.summary, CONVERSION_INBOX_CALL_SUMMARY_MAX_BYTES);
    const occurredAt = canonicalTimestamp(input?.occurredAt);
    const next = input?.nextAction;
    const nextKind = next === null || next === undefined
      ? null
      : typeof next.kind === 'string' && NEXT_ACTION_KINDS.has(next.kind) ? next.kind : null;
    const nextTitle = next === null || next === undefined
      ? null
      : boundedText(next.title, CONVERSION_INBOX_NEXT_ACTION_TITLE_MAX_BYTES);
    const nextDueAt = next === null || next === undefined ? null : canonicalTimestamp(next.dueAt);
    const nextPriority = next === null || next === undefined
      ? null
      : typeof next.priority === 'string' && NEXT_ACTION_PRIORITIES.has(next.priority)
        ? next.priority
        : null;
    if (!key || !conversationId || !taskId || expectedTaskRowVersion === null
        || !outcome || !summary || !occurredAt
        || (next !== null && next !== undefined
          && (!nextKind || !nextTitle || !nextDueAt || !nextPriority))) {
      return failure('validation', 'Check the typed call outcome, exact task version and optional next action.');
    }
    try {
      const context = await this.#context(identity);
      if ('ok' in context) return context;
      return await this.dependencies.commandRunner.run(context, async (transaction) => {
        const result = await transaction.query<CallOutcomeRow>(
          `/* portal.conversion-inbox-operations.record-call-outcome */
           SELECT disposition,
                  conversation_id AS "conversationId",
                  contact_id AS "contactId",
                  outcome_id AS "outcomeId",
                  completed_task_id AS "completedTaskId",
                  completed_task_row_version AS "completedTaskRowVersion",
                  next_task_id AS "nextTaskId",
                  next_task_row_version AS "nextTaskRowVersion"
           FROM app_private.record_operational_inbox_admin_call_outcome(
             $1::uuid, $2::bytea, $3::uuid, $4::uuid, $5::bigint,
             $6::text, $7::text, $8::timestamptz, $9::text, $10::text,
             $11::timestamptz, $12::text, $13::text
           )`,
          [context.workspaceId, context.portalSessionTokenHash!, conversationId,
            taskId, expectedTaskRowVersion, outcome, summary, occurredAt,
            nextKind, nextTitle, nextDueAt, nextPriority, key],
        );
        const row = oneRow(result.rows, 'call outcome');
        const nextTaskId = nullableUuid(row.nextTaskId, 'next task id');
        const nextTaskRowVersion = nullableVersion(
          row.nextTaskRowVersion,
          'next task row version',
        );
        if ((nextTaskId === null) !== (nextTaskRowVersion === null)) {
          throw new Error('Conversion Inbox operation returned a partial next task');
        }
        return Object.freeze({
          ok: true as const,
          disposition: disposition(row.disposition),
          conversationId: uuid(row.conversationId, 'conversation id'),
          contactId: uuid(row.contactId, 'contact id'),
          outcomeId: uuid(row.outcomeId, 'outcome id'),
          completedTaskId: uuid(row.completedTaskId, 'completed task id'),
          completedTaskRowVersion: version(
            row.completedTaskRowVersion,
            'completed task row version',
          ),
          nextTaskId,
          nextTaskRowVersion,
        });
      });
    } catch (error) {
      return commandFailure(error);
    }
  }
}

export function createPortalConversionInboxOperationsTransactionRunner(
  pool: Pick<Pool, 'connect'>,
): PortalConversionInboxOperationsTransactionRunner {
  return {
    run: (context, operation) => withTransaction(
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
      { isolation: 'serializable' },
    ),
  };
}

/** Portal identity resolves on r72_web; all four commands run on r72_crm_command. */
export function createPgPortalConversionInboxOperationsService(input: {
  readonly webPool: Pool;
  readonly crmCommandPool: Pool;
}): PgPortalConversionInboxOperationsService {
  return new PgPortalConversionInboxOperationsService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    commandRunner: createPortalConversionInboxOperationsTransactionRunner(
      input.crmCommandPool,
    ),
  });
}
