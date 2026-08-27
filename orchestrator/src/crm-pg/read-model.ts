import type { Pool } from 'pg';
import { validateDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { withTransaction } from '../db/transaction.js';
import type { CrmTransactionRunner, SqlExecutor } from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;
const ORDERING_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3,6})Z$/;
const PAGE_SIZE = 50;
const PAGE_QUERY_LIMIT = PAGE_SIZE + 1;
const STAGE_LIMIT = 100;
const STAGE_QUERY_LIMIT = STAGE_LIMIT + 1;
const TIMELINE_LIMIT = 100;

export type CrmLifecycleStatus = 'lead' | 'customer' | 'archived';
export type CrmOpportunityReadStatus = 'open' | 'won' | 'lost';
export type CrmTaskReadStatus = 'open' | 'completed' | 'cancelled';
export type CrmStageType = 'open' | 'won' | 'lost';
export type CrmTaskReadFilter = 'open' | 'completed' | 'all';

export interface CrmContactReadCursor {
  readonly updatedAt: string;
  readonly id: string;
}

export interface CrmOpportunityReadCursor {
  readonly updatedAt: string;
  readonly id: string;
}

export interface CrmTaskReadCursor {
  readonly statusRank: 0 | 1 | 2;
  readonly dueAt: string | null;
  readonly updatedAt: string;
  readonly id: string;
}

export interface CrmReadPageInfo<TCursor> {
  readonly hasNextPage: boolean;
  /** Raw database tuple. The portal must authenticate and bind this before exposing it. */
  readonly endCursor: TCursor | null;
}

export interface CrmWorkspaceReadPagination {
  readonly contacts: CrmReadPageInfo<CrmContactReadCursor> | null;
  readonly opportunities: CrmReadPageInfo<CrmOpportunityReadCursor> | null;
  readonly tasks: CrmReadPageInfo<CrmTaskReadCursor> | null;
}

export type CrmWorkspaceReadRequest =
  | {
      readonly section: 'overview';
      readonly contactsAfter?: CrmContactReadCursor;
      readonly opportunitiesAfter?: CrmOpportunityReadCursor;
      readonly tasksAfter?: CrmTaskReadCursor;
      readonly taskFilter?: CrmTaskReadFilter;
    }
  | { readonly section: 'contacts'; readonly after?: CrmContactReadCursor }
  | { readonly section: 'pipeline'; readonly after?: CrmOpportunityReadCursor }
  | {
      readonly section: 'tasks';
      readonly after?: CrmTaskReadCursor;
      readonly filter?: CrmTaskReadFilter;
    };

export interface CrmWorkspaceRead {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly currency: string;
  readonly snapshotAt: string;
  readonly defaultPipelineId: string | null;
  readonly canWrite: boolean;
}

export interface CrmNextTaskRead {
  readonly id: string;
  readonly title: string;
  readonly dueAt: string | null;
}

export interface CrmContactRead {
  readonly id: string;
  readonly displayName: string;
  readonly companyName: string | null;
  readonly primaryEmail: string | null;
  readonly primaryPhone: string | null;
  readonly lifecycle: CrmLifecycleStatus;
  readonly ownerUserId: string | null;
  readonly openOpportunityCount: number;
  readonly nextTask: CrmNextTaskRead | null;
  readonly lastActivityAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly rowVersion: number;
}

export interface CrmStageRead {
  readonly id: string;
  readonly pipelineId: string;
  readonly name: string;
  readonly position: number;
  readonly stageType: CrmStageType;
  readonly isTerminal: boolean;
  readonly rowVersion: number;
}

export interface CrmOpportunityRead {
  readonly id: string;
  readonly contactId: string;
  readonly contactName: string;
  readonly companyName: string | null;
  readonly pipelineId: string;
  readonly stageId: string;
  readonly title: string;
  readonly status: CrmOpportunityReadStatus;
  readonly valueMinor: number;
  readonly currency: string;
  readonly probability: number;
  readonly ownerUserId: string | null;
  readonly expectedCloseDate: string | null;
  readonly nextTask: CrmNextTaskRead | null;
  readonly updatedAt: string;
  readonly rowVersion: number;
}

export interface CrmTaskRead {
  readonly id: string;
  readonly contactId: string | null;
  readonly contactName: string | null;
  readonly opportunityId: string | null;
  readonly opportunityTitle: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly assigneeUserId: string | null;
  readonly priority: 'low' | 'normal' | 'high' | 'urgent';
  readonly status: CrmTaskReadStatus;
  readonly dueAt: string | null;
  readonly completedAt: string | null;
  readonly completedByUserId: string | null;
  readonly updatedAt: string;
  readonly rowVersion: number;
}

export interface CrmActivityRead {
  readonly id: string;
  readonly contactId: string | null;
  readonly opportunityId: string | null;
  readonly taskId: string | null;
  readonly activityType: string;
  readonly subject: string;
  readonly actorKind: 'user' | 'worker' | 'webhook' | 'system';
  readonly actorUserId: string | null;
  readonly occurredAt: string;
}

export interface CrmWorkspaceReadSnapshot {
  readonly workspace: CrmWorkspaceRead;
  readonly contacts: readonly CrmContactRead[];
  readonly stages: readonly CrmStageRead[];
  readonly opportunities: readonly CrmOpportunityRead[];
  readonly tasks: readonly CrmTaskRead[];
  readonly timeline: readonly CrmActivityRead[];
  /** Optional only for backwards-compatible callers constructing test snapshots. DB reads always provide it. */
  readonly pagination?: CrmWorkspaceReadPagination;
}

export interface CrmReadDependencies {
  readonly transactionRunner: CrmTransactionRunner;
}

export class CrmReadDataError extends Error {
  readonly code = 'invalid_crm_read_data';

  constructor(message: string) {
    super(message);
    this.name = 'CrmReadDataError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new CrmReadDataError(`${label} must be a database row`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CrmReadDataError(`${label} must be a non-empty string`);
  }
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function timezone(value: unknown, label: string): string {
  const name = text(value, label);
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: name }).format(0);
  } catch {
    throw new CrmReadDataError(`${label} must be a valid IANA timezone`);
  }
  return name;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new CrmReadDataError(`${label} must be a UUID`);
  }
  return value.toLowerCase();
}

function nullableUuid(value: unknown, label: string): string | null {
  return value === null ? null : uuid(value, label);
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new CrmReadDataError(`${label} must be a boolean`);
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, options: T, label: string): T[number] {
  if (typeof value !== 'string' || !options.includes(value)) {
    throw new CrmReadDataError(`${label} is invalid`);
  }
  return value as T[number];
}

function currency(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    throw new CrmReadDataError(`${label} must be a three-letter uppercase currency code`);
  }
  return value;
}

function safeInteger(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  let parsed: bigint;
  if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new CrmReadDataError(`${label} must be a safe integer`);
    parsed = BigInt(value);
  } else if (typeof value === 'string' && INTEGER_PATTERN.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new CrmReadDataError(`${label} must be an integer`);
  }
  if (parsed < BigInt(minimum) || parsed > BigInt(maximum)) {
    throw new CrmReadDataError(`${label} is outside its safe range`);
  }
  return Number(parsed);
}

function timestamp(value: unknown, label: string): string {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) {
    throw new CrmReadDataError(`${label} must be a valid timestamp`);
  }
  return date.toISOString();
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

/**
 * Cursor timestamps must retain PostgreSQL's microseconds. JavaScript Date
 * intentionally remains the UI projection above, but it is not precise enough
 * to be a database ordering key.
 */
function orderingTimestamp(value: unknown, label: string): string {
  if (value instanceof Date) return timestamp(value, label);
  if (typeof value !== 'string') {
    throw new CrmReadDataError(`${label} must be a precise UTC timestamp`);
  }
  const match = ORDERING_TIMESTAMP_PATTERN.exec(value);
  // Compatibility for pre-precision cursors and narrow adapters. Real list SQL
  // always returns the dedicated six-digit cursor columns below.
  if (!match) return timestamp(value, label);
  const millisecondProjection = `${match[1]}.${match[2]!.slice(0, 3)}Z`;
  const parsed = new Date(millisecondProjection);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== millisecondProjection) {
    throw new CrmReadDataError(`${label} must be a precise UTC timestamp`);
  }
  return value;
}

function nullableOrderingTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : orderingTimestamp(value, label);
}

function contactCursor(value: unknown, label: string): CrmContactReadCursor {
  const row = record(value, label);
  return Object.freeze({
    updatedAt: orderingTimestamp(row.updatedAt, `${label}.updatedAt`),
    id: uuid(row.id, `${label}.id`),
  });
}

function opportunityCursor(value: unknown, label: string): CrmOpportunityReadCursor {
  const row = record(value, label);
  return Object.freeze({
    updatedAt: orderingTimestamp(row.updatedAt, `${label}.updatedAt`),
    id: uuid(row.id, `${label}.id`),
  });
}

function taskCursor(value: unknown, label: string): CrmTaskReadCursor {
  const row = record(value, label);
  return Object.freeze({
    statusRank: safeInteger(row.statusRank, `${label}.statusRank`, 0, 2) as 0 | 1 | 2,
    dueAt: nullableOrderingTimestamp(row.dueAt, `${label}.dueAt`),
    updatedAt: orderingTimestamp(row.updatedAt, `${label}.updatedAt`),
    id: uuid(row.id, `${label}.id`),
  });
}

interface NormalizedCrmWorkspaceReadRequest {
  readonly section: 'overview' | 'contacts' | 'pipeline' | 'tasks';
  readonly contactsAfter: CrmContactReadCursor | null;
  readonly opportunitiesAfter: CrmOpportunityReadCursor | null;
  readonly tasksAfter: CrmTaskReadCursor | null;
  readonly taskFilter: CrmTaskReadFilter;
}

function normalizeReadRequest(value: CrmWorkspaceReadRequest | undefined): NormalizedCrmWorkspaceReadRequest {
  if (value === undefined) {
    return Object.freeze({
      section: 'overview',
      contactsAfter: null,
      opportunitiesAfter: null,
      tasksAfter: null,
      taskFilter: 'all',
    });
  }
  const row = record(value, 'CRM read request');
  const section = oneOf(row.section, ['overview', 'contacts', 'pipeline', 'tasks'] as const, 'CRM read request.section');
  const normalized: NormalizedCrmWorkspaceReadRequest = section === 'overview'
    ? {
        section,
        contactsAfter: row.contactsAfter === undefined ? null : contactCursor(row.contactsAfter, 'CRM read request.contactsAfter'),
        opportunitiesAfter: row.opportunitiesAfter === undefined
          ? null : opportunityCursor(row.opportunitiesAfter, 'CRM read request.opportunitiesAfter'),
        tasksAfter: row.tasksAfter === undefined ? null : taskCursor(row.tasksAfter, 'CRM read request.tasksAfter'),
        taskFilter: oneOf(row.taskFilter ?? 'all', ['open', 'completed', 'all'] as const, 'CRM read request.taskFilter'),
      }
    : section === 'contacts'
      ? {
          section,
          contactsAfter: row.after === undefined ? null : contactCursor(row.after, 'CRM read request.after'),
          opportunitiesAfter: null,
          tasksAfter: null,
          taskFilter: 'all',
        }
      : section === 'pipeline'
        ? {
            section,
            contactsAfter: null,
            opportunitiesAfter: row.after === undefined ? null : opportunityCursor(row.after, 'CRM read request.after'),
            tasksAfter: null,
            taskFilter: 'all',
          }
        : {
            section,
            contactsAfter: null,
            opportunitiesAfter: null,
            tasksAfter: row.after === undefined ? null : taskCursor(row.after, 'CRM read request.after'),
            taskFilter: oneOf(row.filter ?? 'open', ['open', 'completed', 'all'] as const, 'CRM read request.filter'),
          };
  if (normalized.tasksAfter && normalized.taskFilter !== 'all') {
    const requiredRank = normalized.taskFilter === 'open' ? 0 : 1;
    if (normalized.tasksAfter.statusRank !== requiredRank) {
      throw new CrmReadDataError('CRM task cursor does not belong to the requested status filter');
    }
  }
  return Object.freeze(normalized);
}

function nullableDate(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new CrmReadDataError(`${label} must be a calendar date`);
  const match = DATE_PATTERN.exec(value);
  if (!match) throw new CrmReadDataError(`${label} must be a calendar date`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new CrmReadDataError(`${label} must be a real calendar date`);
  }
  return value;
}

function nextTask(row: Record<string, unknown>, prefix: string): CrmNextTaskRead | null {
  const idValue = row[`${prefix}_id`];
  const titleValue = row[`${prefix}_title`];
  const dueValue = row[`${prefix}_due_at`];
  if (idValue === null) {
    if (titleValue !== null || dueValue !== null) {
      throw new CrmReadDataError(`${prefix} fields must be null together`);
    }
    return null;
  }
  return Object.freeze({
    id: uuid(idValue, `${prefix}.id`),
    title: text(titleValue, `${prefix}.title`),
    dueAt: nullableTimestamp(dueValue, `${prefix}.dueAt`),
  });
}

function mapWorkspace(value: unknown): CrmWorkspaceRead {
  const row = record(value, 'workspace');
  return Object.freeze({
    id: uuid(row.id, 'workspace.id'),
    name: text(row.name, 'workspace.name'),
    timezone: timezone(row.timezone, 'workspace.timezone'),
    currency: currency(row.currency, 'workspace.currency'),
    snapshotAt: timestamp(row.snapshot_at, 'workspace.snapshotAt'),
    defaultPipelineId: nullableUuid(row.default_pipeline_id, 'workspace.defaultPipelineId'),
    canWrite: bool(row.can_write, 'workspace.canWrite'),
  });
}

function mapContact(value: unknown, index: number): CrmContactRead {
  const row = record(value, `contacts[${index}]`);
  return Object.freeze({
    id: uuid(row.id, `contacts[${index}].id`),
    displayName: text(row.display_name, `contacts[${index}].displayName`),
    companyName: nullableText(row.company_name, `contacts[${index}].companyName`),
    primaryEmail: nullableText(row.primary_email, `contacts[${index}].primaryEmail`),
    primaryPhone: nullableText(row.primary_phone, `contacts[${index}].primaryPhone`),
    lifecycle: oneOf(row.lifecycle_status, ['lead', 'customer', 'archived'] as const, `contacts[${index}].lifecycle`),
    ownerUserId: nullableUuid(row.owner_user_id, `contacts[${index}].ownerUserId`),
    openOpportunityCount: safeInteger(row.open_opportunity_count, `contacts[${index}].openOpportunityCount`),
    nextTask: nextTask(row, 'next_task'),
    lastActivityAt: nullableTimestamp(row.last_activity_at, `contacts[${index}].lastActivityAt`),
    createdAt: timestamp(row.created_at, `contacts[${index}].createdAt`),
    updatedAt: timestamp(row.updated_at, `contacts[${index}].updatedAt`),
    rowVersion: safeInteger(row.row_version, `contacts[${index}].rowVersion`, 1),
  });
}

function mapStage(value: unknown, index: number): CrmStageRead {
  const row = record(value, `stages[${index}]`);
  const stage = Object.freeze({
    id: uuid(row.id, `stages[${index}].id`),
    pipelineId: uuid(row.pipeline_id, `stages[${index}].pipelineId`),
    name: text(row.name, `stages[${index}].name`),
    position: safeInteger(row.position, `stages[${index}].position`, 1, 2_147_483_647),
    stageType: oneOf(row.stage_type, ['open', 'won', 'lost'] as const, `stages[${index}].stageType`),
    isTerminal: bool(row.is_terminal, `stages[${index}].isTerminal`),
    rowVersion: safeInteger(row.row_version, `stages[${index}].rowVersion`, 1),
  });
  if (stage.isTerminal !== (stage.stageType === 'won' || stage.stageType === 'lost')) {
    throw new CrmReadDataError(`stages[${index}] has inconsistent terminal state`);
  }
  return stage;
}

function mapOpportunity(value: unknown, index: number): CrmOpportunityRead {
  const row = record(value, `opportunities[${index}]`);
  return Object.freeze({
    id: uuid(row.id, `opportunities[${index}].id`),
    contactId: uuid(row.contact_id, `opportunities[${index}].contactId`),
    contactName: text(row.contact_name, `opportunities[${index}].contactName`),
    companyName: nullableText(row.company_name, `opportunities[${index}].companyName`),
    pipelineId: uuid(row.pipeline_id, `opportunities[${index}].pipelineId`),
    stageId: uuid(row.stage_id, `opportunities[${index}].stageId`),
    title: text(row.title, `opportunities[${index}].title`),
    status: oneOf(row.status, ['open', 'won', 'lost'] as const, `opportunities[${index}].status`),
    valueMinor: safeInteger(row.value_minor, `opportunities[${index}].valueMinor`),
    currency: currency(row.currency, `opportunities[${index}].currency`),
    probability: safeInteger(row.probability, `opportunities[${index}].probability`, 0, 100),
    ownerUserId: nullableUuid(row.owner_user_id, `opportunities[${index}].ownerUserId`),
    expectedCloseDate: nullableDate(row.expected_close_date, `opportunities[${index}].expectedCloseDate`),
    nextTask: nextTask(row, 'next_task'),
    updatedAt: timestamp(row.updated_at, `opportunities[${index}].updatedAt`),
    rowVersion: safeInteger(row.row_version, `opportunities[${index}].rowVersion`, 1),
  });
}

function mapTask(value: unknown, index: number): CrmTaskRead {
  const row = record(value, `tasks[${index}]`);
  const task = Object.freeze({
    id: uuid(row.id, `tasks[${index}].id`),
    contactId: nullableUuid(row.contact_id, `tasks[${index}].contactId`),
    contactName: nullableText(row.contact_name, `tasks[${index}].contactName`),
    opportunityId: nullableUuid(row.opportunity_id, `tasks[${index}].opportunityId`),
    opportunityTitle: nullableText(row.opportunity_title, `tasks[${index}].opportunityTitle`),
    title: text(row.title, `tasks[${index}].title`),
    // Task descriptions are deliberately excluded from list reads; detail reads may expose them later.
    description: null,
    assigneeUserId: nullableUuid(row.assignee_user_id, `tasks[${index}].assigneeUserId`),
    priority: oneOf(row.priority, ['low', 'normal', 'high', 'urgent'] as const, `tasks[${index}].priority`),
    status: oneOf(row.status, ['open', 'completed', 'cancelled'] as const, `tasks[${index}].status`),
    dueAt: nullableTimestamp(row.due_at, `tasks[${index}].dueAt`),
    completedAt: nullableTimestamp(row.completed_at, `tasks[${index}].completedAt`),
    completedByUserId: nullableUuid(row.completed_by_user_id, `tasks[${index}].completedByUserId`),
    updatedAt: timestamp(row.updated_at, `tasks[${index}].updatedAt`),
    rowVersion: safeInteger(row.row_version, `tasks[${index}].rowVersion`, 1),
  });
  const isComplete = task.status === 'completed';
  if (isComplete !== (task.completedAt !== null) || isComplete !== (task.completedByUserId !== null)) {
    throw new CrmReadDataError(`tasks[${index}] has inconsistent completion metadata`);
  }
  return task;
}

function taskStatusRank(status: CrmTaskReadStatus): 0 | 1 | 2 {
  return status === 'open' ? 0 : status === 'completed' ? 1 : 2;
}

function boundedPage<TItem, TCursor>(
  inputRows: readonly Record<string, unknown>[],
  label: string,
  mapper: (value: unknown, index: number) => TItem,
  cursorFor: (item: TItem, row: Record<string, unknown>) => TCursor,
): { readonly items: readonly TItem[]; readonly pageInfo: CrmReadPageInfo<TCursor> } {
  if (inputRows.length > PAGE_QUERY_LIMIT) {
    throw new CrmReadDataError(`${label} query exceeded its fixed database limit`);
  }
  const hasNextPage = inputRows.length === PAGE_QUERY_LIMIT;
  const items = Object.freeze(inputRows.slice(0, PAGE_SIZE).map(mapper));
  const lastItem = items.at(-1);
  const lastRow = inputRows[Math.min(inputRows.length, PAGE_SIZE) - 1];
  return Object.freeze({
    items,
    pageInfo: Object.freeze({
      hasNextPage,
      endCursor: lastItem === undefined || lastRow === undefined
        ? null
        : Object.freeze(cursorFor(lastItem, lastRow)),
    }),
  });
}

function contactPage(inputRows: readonly Record<string, unknown>[]) {
  return boundedPage(inputRows, 'Contact page', mapContact, (item, row) => ({
    updatedAt: orderingTimestamp(row.cursor_updated_at ?? row.updated_at, 'Contact page cursor.updatedAt'),
    id: item.id,
  }));
}

function opportunityPage(inputRows: readonly Record<string, unknown>[]) {
  return boundedPage(inputRows, 'Opportunity page', mapOpportunity, (item, row) => ({
    updatedAt: orderingTimestamp(row.cursor_updated_at ?? row.updated_at, 'Opportunity page cursor.updatedAt'),
    id: item.id,
  }));
}

function taskPage(inputRows: readonly Record<string, unknown>[]) {
  return boundedPage(inputRows, 'Task page', mapTask, (item, row) => ({
    statusRank: taskStatusRank(item.status),
    dueAt: nullableOrderingTimestamp(row.cursor_due_at ?? row.due_at, 'Task page cursor.dueAt'),
    updatedAt: orderingTimestamp(row.cursor_updated_at ?? row.updated_at, 'Task page cursor.updatedAt'),
    id: item.id,
  }));
}

function mapActivity(value: unknown, index: number): CrmActivityRead {
  const row = record(value, `timeline[${index}]`);
  const activity = Object.freeze({
    id: uuid(row.id, `timeline[${index}].id`),
    contactId: nullableUuid(row.contact_id, `timeline[${index}].contactId`),
    opportunityId: nullableUuid(row.opportunity_id, `timeline[${index}].opportunityId`),
    taskId: nullableUuid(row.task_id, `timeline[${index}].taskId`),
    activityType: text(row.activity_type, `timeline[${index}].activityType`),
    subject: text(row.subject, `timeline[${index}].subject`),
    actorKind: oneOf(row.actor_kind, ['user', 'worker', 'webhook', 'system'] as const, `timeline[${index}].actorKind`),
    actorUserId: nullableUuid(row.actor_user_id, `timeline[${index}].actorUserId`),
    occurredAt: timestamp(row.occurred_at, `timeline[${index}].occurredAt`),
  });
  if ((activity.actorKind === 'user') !== (activity.actorUserId !== null)) {
    throw new CrmReadDataError(`timeline[${index}] has inconsistent actor metadata`);
  }
  return activity;
}

const WORKSPACE_SQL = `/* crm.read.workspace */
  SELECT workspace.id,
         workspace.name,
         workspace.timezone,
         workspace.currency,
         transaction_timestamp() AS snapshot_at,
         default_pipeline.id AS default_pipeline_id,
         app_private.can_write_workspace(
           app_private.current_user_id(), app_private.current_workspace_id()
         ) AS can_write
  FROM app.workspaces AS workspace
  LEFT JOIN app.pipelines AS default_pipeline
    ON default_pipeline.workspace_id = workspace.id
   AND default_pipeline.is_default
  WHERE workspace.id = app_private.current_workspace_id()`;

const CONTACTS_SQL = `/* crm.read.contacts */
  SELECT contact.id,
         contact.display_name,
         contact.company_name,
         contact.lifecycle_status,
         contact.owner_user_id,
         contact.row_version::text AS row_version,
         contact.created_at,
         contact.updated_at,
         to_char(
           contact.updated_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         ) AS cursor_updated_at,
         primary_email.value AS primary_email,
         primary_phone.value AS primary_phone,
         open_opportunities.open_count::text AS open_opportunity_count,
         next_task.id AS next_task_id,
         next_task.title AS next_task_title,
         next_task.due_at AS next_task_due_at,
         last_activity.occurred_at AS last_activity_at
  FROM app.contacts AS contact
  LEFT JOIN LATERAL (
    SELECT point.value
    FROM app.contact_points AS point
    WHERE point.workspace_id = contact.workspace_id
      AND point.contact_id = contact.id
      AND point.kind = 'email'
      AND point.deleted_at IS NULL
    ORDER BY point.is_primary DESC, point.updated_at DESC, point.id
    LIMIT 1
  ) AS primary_email ON true
  LEFT JOIN LATERAL (
    SELECT point.value
    FROM app.contact_points AS point
    WHERE point.workspace_id = contact.workspace_id
      AND point.contact_id = contact.id
      AND point.kind = 'phone'
      AND point.deleted_at IS NULL
    ORDER BY point.is_primary DESC,
             point.updated_at DESC,
             point.id
    LIMIT 1
  ) AS primary_phone ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS open_count
    FROM app.opportunities AS opportunity
    WHERE opportunity.workspace_id = contact.workspace_id
      AND opportunity.contact_id = contact.id
      AND opportunity.status = 'open'
  ) AS open_opportunities ON true
  LEFT JOIN LATERAL (
    SELECT task.id, task.title, task.due_at
    FROM app.tasks AS task
    WHERE task.workspace_id = contact.workspace_id
      AND task.contact_id = contact.id
      AND task.status = 'open'
    ORDER BY task.due_at ASC NULLS LAST, task.created_at, task.id
    LIMIT 1
  ) AS next_task ON true
  LEFT JOIN LATERAL (
    SELECT activity.occurred_at
    FROM app.activities AS activity
    WHERE activity.workspace_id = contact.workspace_id
      AND activity.contact_id = contact.id
    ORDER BY activity.occurred_at DESC, activity.id DESC
    LIMIT 1
  ) AS last_activity ON true
  WHERE contact.workspace_id = app_private.current_workspace_id()
    AND contact.deleted_at IS NULL
    AND (
      $1::timestamptz IS NULL
      OR contact.updated_at < $1::timestamptz
      OR (contact.updated_at = $1::timestamptz AND contact.id > $2::uuid)
    )
  ORDER BY contact.updated_at DESC, contact.id
  LIMIT $3`;

const STAGES_SQL = `/* crm.read.stages */
  SELECT stage.id,
         stage.pipeline_id,
         stage.name,
         stage.position,
         stage.stage_type,
         stage.is_terminal,
         stage.row_version::text AS row_version
  FROM app.pipeline_stages AS stage
  JOIN app.pipelines AS pipeline
    ON pipeline.workspace_id = stage.workspace_id
   AND pipeline.id = stage.pipeline_id
   AND pipeline.is_default
  WHERE stage.workspace_id = app_private.current_workspace_id()
  ORDER BY stage.position, stage.id
  LIMIT $1`;

const OPPORTUNITIES_SQL = `/* crm.read.opportunities */
  SELECT opportunity.id,
         opportunity.contact_id,
         contact.display_name AS contact_name,
         contact.company_name,
         opportunity.pipeline_id,
         opportunity.stage_id,
         opportunity.name AS title,
         opportunity.status,
         opportunity.value_minor::text AS value_minor,
         opportunity.currency,
         opportunity.probability,
         opportunity.owner_user_id,
         opportunity.expected_close_date::text AS expected_close_date,
         opportunity.updated_at,
         to_char(
           opportunity.updated_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         ) AS cursor_updated_at,
         opportunity.row_version::text AS row_version,
         next_task.id AS next_task_id,
         next_task.title AS next_task_title,
         next_task.due_at AS next_task_due_at
  FROM app.opportunities AS opportunity
  JOIN app.pipelines AS pipeline
    ON pipeline.workspace_id = opportunity.workspace_id
   AND pipeline.id = opportunity.pipeline_id
   AND pipeline.is_default
  JOIN app.contacts AS contact
    ON contact.workspace_id = opportunity.workspace_id
   AND contact.id = opportunity.contact_id
   AND contact.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT task.id, task.title, task.due_at
    FROM app.tasks AS task
    WHERE task.workspace_id = opportunity.workspace_id
      AND task.opportunity_id = opportunity.id
      AND task.status = 'open'
    ORDER BY task.due_at ASC NULLS LAST, task.created_at, task.id
    LIMIT 1
  ) AS next_task ON true
  WHERE opportunity.workspace_id = app_private.current_workspace_id()
    AND (
      $1::timestamptz IS NULL
      OR opportunity.updated_at < $1::timestamptz
      OR (opportunity.updated_at = $1::timestamptz AND opportunity.id > $2::uuid)
    )
  ORDER BY opportunity.updated_at DESC, opportunity.id
  LIMIT $3`;

const TASKS_SQL = `/* crm.read.tasks */
  SELECT task.id,
         task.contact_id,
         contact.display_name AS contact_name,
         task.opportunity_id,
         opportunity.name AS opportunity_title,
         task.title,
         task.assignee_user_id,
         task.priority,
         task.status,
         task.due_at,
         to_char(
           task.due_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         ) AS cursor_due_at,
         task.completed_at,
         task.completed_by_user_id,
         task.updated_at,
         to_char(
           task.updated_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         ) AS cursor_updated_at,
         task.row_version::text AS row_version
  FROM app.tasks AS task
  LEFT JOIN app.contacts AS contact
    ON contact.workspace_id = task.workspace_id
   AND contact.id = task.contact_id
   AND contact.deleted_at IS NULL
  LEFT JOIN app.opportunities AS opportunity
    ON opportunity.workspace_id = task.workspace_id
   AND opportunity.id = task.opportunity_id
  WHERE task.workspace_id = app_private.current_workspace_id()
    AND (task.contact_id IS NULL OR contact.id IS NOT NULL)
    AND ($1::text = 'all' OR task.status = $1::text)
    AND (
      $2::integer IS NULL
      OR CASE task.status WHEN 'open' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END > $2::integer
      OR (
        CASE task.status WHEN 'open' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END = $2::integer
        AND (
          (
            $3::timestamptz IS NOT NULL
            AND (
              task.due_at IS NULL
              OR task.due_at > $3::timestamptz
              OR (
                task.due_at = $3::timestamptz
                AND (
                  task.updated_at < $4::timestamptz
                  OR (task.updated_at = $4::timestamptz AND task.id > $5::uuid)
                )
              )
            )
          )
          OR (
            $3::timestamptz IS NULL
            AND task.due_at IS NULL
            AND (
              task.updated_at < $4::timestamptz
              OR (task.updated_at = $4::timestamptz AND task.id > $5::uuid)
            )
          )
        )
      )
    )
  ORDER BY CASE task.status WHEN 'open' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
           task.due_at ASC NULLS LAST,
           task.updated_at DESC,
           task.id
  LIMIT $6`;

const TIMELINE_SQL = `/* crm.read.timeline */
  SELECT activity.id,
         activity.contact_id,
         activity.opportunity_id,
         activity.task_id,
         activity.activity_type,
         activity.subject,
         activity.actor_kind,
         activity.actor_user_id,
         activity.occurred_at
  FROM app.activities AS activity
  WHERE activity.workspace_id = app_private.current_workspace_id()
  ORDER BY activity.occurred_at DESC, activity.id DESC
  LIMIT ${TIMELINE_LIMIT}`;

async function rows(
  transaction: SqlExecutor,
  sql: string,
  values?: readonly unknown[],
): Promise<readonly Record<string, unknown>[]> {
  const result = await transaction.query(sql, values);
  return result.rows;
}

export class CrmReadService {
  constructor(private readonly dependencies: CrmReadDependencies) {}

  async loadWorkspaceCommandContext(context: DatabaseRequestContext): Promise<CrmWorkspaceRead> {
    validateDatabaseContext(context);
    if (context.actorKind !== 'user' || !context.userId) {
      throw new CrmReadDataError('CRM workspace context requires an authenticated user context');
    }
    return this.dependencies.transactionRunner.run(context, async (transaction) => {
      const workspaceRows = await rows(transaction, WORKSPACE_SQL);
      if (workspaceRows.length !== 1) {
        throw new CrmReadDataError('CRM workspace context must resolve exactly one visible workspace');
      }
      return mapWorkspace(workspaceRows[0]);
    });
  }

  async loadWorkspaceSnapshot(
    context: DatabaseRequestContext,
    request?: CrmWorkspaceReadRequest,
  ): Promise<CrmWorkspaceReadSnapshot> {
    validateDatabaseContext(context);
    if (context.actorKind !== 'user' || !context.userId) {
      throw new CrmReadDataError('CRM workspace snapshots require an authenticated user context');
    }
    const normalized = normalizeReadRequest(request);
    return this.dependencies.transactionRunner.run(context, async (transaction) => {
      const workspaceRows = await rows(transaction, WORKSPACE_SQL);
      if (workspaceRows.length !== 1) {
        throw new CrmReadDataError('Workspace snapshot must resolve exactly one visible workspace');
      }
      const workspace = mapWorkspace(workspaceRows[0]);
      const includeContacts = normalized.section === 'overview' || normalized.section === 'contacts';
      const includeStages = normalized.section === 'overview'
        || normalized.section === 'contacts'
        || normalized.section === 'pipeline';
      const includeOpportunities = normalized.section === 'overview' || normalized.section === 'pipeline';
      const includeTasks = normalized.section === 'overview' || normalized.section === 'tasks';

      const contactRows = includeContacts
        ? await rows(transaction, CONTACTS_SQL, [
            normalized.contactsAfter?.updatedAt ?? null,
            normalized.contactsAfter?.id ?? null,
            PAGE_QUERY_LIMIT,
          ])
        : [];
      const stageRows = includeStages
        ? await rows(transaction, STAGES_SQL, [STAGE_QUERY_LIMIT])
        : [];
      if (stageRows.length > STAGE_LIMIT) {
        throw new CrmReadDataError(`Default pipeline exceeds the hard limit of ${STAGE_LIMIT} stages`);
      }
      const opportunityRows = includeOpportunities
        ? await rows(transaction, OPPORTUNITIES_SQL, [
            normalized.opportunitiesAfter?.updatedAt ?? null,
            normalized.opportunitiesAfter?.id ?? null,
            PAGE_QUERY_LIMIT,
          ])
        : [];
      const taskRows = includeTasks
        ? await rows(transaction, TASKS_SQL, [
            normalized.taskFilter,
            normalized.tasksAfter?.statusRank ?? null,
            normalized.tasksAfter?.dueAt ?? null,
            normalized.tasksAfter?.updatedAt ?? null,
            normalized.tasksAfter?.id ?? null,
            PAGE_QUERY_LIMIT,
          ])
        : [];
      const timelineRows = await rows(transaction, TIMELINE_SQL);

      const contactsPage = includeContacts ? contactPage(contactRows) : null;
      const stages = Object.freeze(stageRows.map(mapStage));
      const opportunitiesPage = includeOpportunities ? opportunityPage(opportunityRows) : null;
      const tasksPage = includeTasks ? taskPage(taskRows) : null;
      const contacts = contactsPage?.items ?? Object.freeze([] as CrmContactRead[]);
      const opportunities = opportunitiesPage?.items ?? Object.freeze([] as CrmOpportunityRead[]);
      const tasks = tasksPage?.items ?? Object.freeze([] as CrmTaskRead[]);
      const timeline = Object.freeze(timelineRows.map(mapActivity));

      if (workspace.defaultPipelineId !== null) {
        if (includeStages && stages.some((stage) => stage.pipelineId !== workspace.defaultPipelineId)) {
          throw new CrmReadDataError('Default pipeline stage snapshot is internally inconsistent');
        }
        if (includeOpportunities && opportunities.some((opportunity) => opportunity.pipelineId !== workspace.defaultPipelineId)) {
          throw new CrmReadDataError('Default pipeline opportunity snapshot is internally inconsistent');
        }
        const stageIds = includeStages ? new Set(stages.map((stage) => stage.id)) : null;
        if (stageIds && opportunities.some((opportunity) => !stageIds.has(opportunity.stageId))) {
          throw new CrmReadDataError('An opportunity references a stage outside the default pipeline snapshot');
        }
      } else if ((includeStages && stages.length > 0) || (includeOpportunities && opportunities.length > 0)) {
        throw new CrmReadDataError('Pipeline rows were returned without a visible default pipeline');
      }

      const pagination: CrmWorkspaceReadPagination = Object.freeze({
        contacts: contactsPage?.pageInfo ?? null,
        opportunities: opportunitiesPage?.pageInfo ?? null,
        tasks: tasksPage?.pageInfo ?? null,
      });
      return Object.freeze({ workspace, contacts, stages, opportunities, tasks, timeline, pagination });
    });
  }
}

/** Production read adapter: all component queries share one stable RLS snapshot. */
export function createPgCrmReadTransactionRunner(pool: Pick<Pool, 'connect'>): CrmTransactionRunner {
  return {
    run<T>(context: DatabaseRequestContext, operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
      return withTransaction(pool, context, async (client) => operation({
        async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          values?: readonly unknown[],
        ) {
          const result = await client.query<TRow>(sql, values ? [...values] : undefined);
          return { rows: result.rows, rowCount: result.rowCount };
        },
      }), { isolation: 'repeatable read', readOnly: true });
    },
  };
}

export function createPgCrmReadService(pool: Pick<Pool, 'connect'>): CrmReadService {
  return new CrmReadService({ transactionRunner: createPgCrmReadTransactionRunner(pool) });
}
