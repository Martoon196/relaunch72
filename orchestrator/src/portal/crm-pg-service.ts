import { createHash, randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import {
  CrmCommandError,
  CrmCommandService,
  CrmReadService,
  createPgCrmReadService,
  createPgCrmTransactionRunner,
  type CrmWorkspaceReadSnapshot,
} from '../crm-pg/index.js';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import type {
  CrmTimelineItemView,
  CrmWorkspaceSnapshot,
  CreateLeadField,
} from './crm-views.js';
import type {
  PortalCompleteTaskInput,
  PortalCreateLeadInput,
  PortalCrmMutationOutcome,
  PortalCrmRequestIdentity,
  PortalCrmService,
  PortalMoveOpportunityInput,
} from './crm-service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMAND_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export interface PortalCrmPrincipal {
  readonly userId: string;
  readonly workspaceId: string;
}

export interface PortalCrmPrincipalResolver {
  resolve(sessionToken: string): Promise<PortalCrmPrincipal | null>;
}

interface SessionRow extends QueryResultRow {
  user_id: string;
  selected_workspace_id: string;
}

function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

/** Resolve only the hash of an opaque DB session; raw browser tokens never enter a table. */
export function createPgPortalCrmPrincipalResolver(pool: Pick<Pool, 'query'>): PortalCrmPrincipalResolver {
  return {
    async resolve(sessionToken: string): Promise<PortalCrmPrincipal | null> {
      if (!sessionToken || sessionToken.length > 4_096) return null;
      const hash = createHash('sha256').update(sessionToken).digest();
      const result = await pool.query<SessionRow>(
        `/* portal.crm.resolve-session */
         SELECT user_id, selected_workspace_id
         FROM app_private.resolve_session($1)`,
        [hash],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw new Error('Portal CRM session resolved more than once');
      const userId = canonicalUuid(result.rows[0]?.user_id);
      const workspaceId = canonicalUuid(result.rows[0]?.selected_workspace_id);
      if (!userId || !workspaceId) throw new Error('Portal CRM session returned invalid identity data');
      return Object.freeze({ userId, workspaceId });
    },
  };
}

function timelineKind(activityType: string): CrmTimelineItemView['kind'] {
  if (activityType === 'crm.lead.created' || activityType === 'crm.contact.created') return 'lead_created';
  if (activityType === 'crm.opportunity.stage_changed') return 'stage_moved';
  if (activityType === 'crm.task.completed') return 'task_completed';
  if (activityType === 'crm.task.created') return 'task_created';
  if (activityType === 'crm.note.created') return 'note';
  return 'other';
}

function mapSnapshot(read: CrmWorkspaceReadSnapshot, nextKey: () => string): CrmWorkspaceSnapshot {
  return Object.freeze({
    workspace: Object.freeze({
      id: read.workspace.id,
      name: read.workspace.name,
      timezone: read.workspace.timezone,
      snapshotAt: read.workspace.snapshotAt,
      canWrite: read.workspace.canWrite,
    }),
    contacts: Object.freeze(read.contacts.map((contact) => Object.freeze({
      id: contact.id,
      displayName: contact.displayName,
      companyName: contact.companyName,
      primaryEmail: contact.primaryEmail,
      primaryPhone: contact.primaryPhone,
      lifecycle: contact.lifecycle,
      openOpportunityCount: contact.openOpportunityCount,
      nextTaskAt: contact.nextTask?.dueAt ?? null,
      lastActivityAt: contact.lastActivityAt,
      createdAt: contact.createdAt,
    }))),
    stages: Object.freeze(read.stages.map((stage) => Object.freeze({
      id: stage.id,
      name: stage.name,
      position: stage.position,
      isClosed: stage.stageType !== 'open',
    }))),
    opportunities: Object.freeze(read.opportunities.map((opportunity) => Object.freeze({
      id: opportunity.id,
      contactId: opportunity.contactId,
      contactName: opportunity.contactName,
      companyName: opportunity.companyName,
      title: opportunity.title,
      stageId: opportunity.stageId,
      valueMinor: opportunity.valueMinor,
      currency: opportunity.currency,
      ownerName: opportunity.ownerUserId ? 'Assigned workspace member' : null,
      expectedCloseDate: opportunity.expectedCloseDate,
      nextTaskAt: opportunity.nextTask?.dueAt ?? null,
      updatedAt: opportunity.updatedAt,
      rowVersion: opportunity.rowVersion,
      moveCommandKey: nextKey(),
    }))),
    tasks: Object.freeze(read.tasks.map((task) => Object.freeze({
      id: task.id,
      title: task.title,
      status: task.status,
      contactName: task.contactName,
      opportunityTitle: task.opportunityTitle,
      assigneeName: task.assigneeUserId ? 'Assigned workspace member' : null,
      dueAt: task.dueAt,
      completedAt: task.completedAt,
      rowVersion: task.rowVersion,
      completeCommandKey: nextKey(),
    }))),
    timeline: Object.freeze(read.timeline.map((activity) => Object.freeze({
      id: activity.id,
      kind: timelineKind(activity.activityType),
      summary: activity.subject,
      actorName: null,
      occurredAt: activity.occurredAt,
    }))),
  });
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function localParts(timestamp: number, timezone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat('en-GB-u-nu-latn', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const values = new Map(formatter.formatToParts(new Date(timestamp))
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
  return {
    year: values.get('year')!, month: values.get('month')!, day: values.get('day')!,
    hour: values.get('hour')!, minute: values.get('minute')!,
  };
}

function sameLocal(left: LocalParts, right: LocalParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute;
}

/** Strictly resolve browser wall time, rejecting DST gaps and ambiguous folds. */
export function workspaceLocalDateTime(value: string, timezone: string): string {
  const match = LOCAL_DATE_TIME.exec(value);
  if (!match) throw new Error('Use a complete date and time');
  const wanted: LocalParts = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]),
  };
  const naive = Date.UTC(wanted.year, wanted.month - 1, wanted.day, wanted.hour, wanted.minute);
  const check = new Date(naive);
  if (check.getUTCFullYear() !== wanted.year || check.getUTCMonth() !== wanted.month - 1
      || check.getUTCDate() !== wanted.day || wanted.hour > 23 || wanted.minute > 59) {
    throw new Error('Use a real calendar date and time');
  }

  // Offset samples around the requested day cover DST and all IANA civil zones.
  const offsets = new Set<number>();
  for (const sample of [naive - 86_400_000, naive, naive + 86_400_000]) {
    const shown = localParts(sample, timezone);
    offsets.add(Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute) - sample);
  }
  const matches = [...offsets]
    .map((offset) => naive - offset)
    .filter((candidate, index, all) => all.indexOf(candidate) === index)
    .filter((candidate) => sameLocal(localParts(candidate, timezone), wanted));
  if (matches.length === 0) throw new Error('That local time does not exist because the clocks change');
  if (matches.length > 1) throw new Error('That local time is ambiguous because the clocks change');
  return new Date(matches[0]!).toISOString();
}

function positiveVersion(value: string): number | null {
  return /^(?:[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

function commandOutcome(error: unknown): PortalCrmMutationOutcome {
  if (!(error instanceof CrmCommandError)) {
    return { ok: false, kind: 'unavailable', message: 'The CRM could not safely save that change. No external action was triggered.' };
  }
  if (error.code === 'not_found') return { ok: false, kind: 'not_found', message: 'That CRM record is no longer available in this workspace.' };
  if (error.code === 'optimistic_conflict' || error.code === 'idempotency_key_reused' || error.code === 'command_in_progress') {
    return { ok: false, kind: 'conflict', message: 'The record or command changed after the page loaded. Refresh before trying again.' };
  }
  if (error.code === 'invalid_state') return { ok: false, kind: 'conflict', message: error.message };
  return { ok: false, kind: 'validation', message: 'Check the submitted CRM values and try again.' };
}

export interface PgPortalCrmDependencies {
  principalResolver: PortalCrmPrincipalResolver;
  readService: Pick<CrmReadService, 'loadWorkspaceSnapshot'>
    & Partial<Pick<CrmReadService, 'loadWorkspaceCommandContext'>>;
  commandService: Pick<CrmCommandService, 'createLead' | 'moveOpportunityStage' | 'completeTask'>;
  nextCommandKey?: () => string;
}

export class PgPortalCrmService implements PortalCrmService {
  private readonly nextCommandKey: () => string;

  constructor(private readonly dependencies: PgPortalCrmDependencies) {
    this.nextCommandKey = dependencies.nextCommandKey ?? randomUUID;
  }

  private async context(identity: PortalCrmRequestIdentity): Promise<DatabaseRequestContext | null> {
    const principal = await this.dependencies.principalResolver.resolve(identity.sessionToken);
    return principal ? requestDatabaseContext({ ...principal, requestId: identity.requestId }) : null;
  }

  private async commandWorkspace(context: DatabaseRequestContext): Promise<CrmWorkspaceReadSnapshot['workspace']> {
    if (this.dependencies.readService.loadWorkspaceCommandContext) {
      return this.dependencies.readService.loadWorkspaceCommandContext(context);
    }
    // Compatibility for narrow test/custom adapters. The production PostgreSQL
    // service always supplies the one-query command context method above.
    return (await this.dependencies.readService.loadWorkspaceSnapshot(context)).workspace;
  }

  async snapshot(identity: PortalCrmRequestIdentity): Promise<CrmWorkspaceSnapshot | null> {
    const context = await this.context(identity);
    if (!context) return null;
    return mapSnapshot(await this.dependencies.readService.loadWorkspaceSnapshot(context), this.nextCommandKey);
  }

  async createLead(identity: PortalCrmRequestIdentity, input: PortalCreateLeadInput): Promise<PortalCrmMutationOutcome> {
    const context = await this.context(identity);
    if (!context) return { ok: false, kind: 'forbidden', message: 'This portal session is no longer active.' };
    const workspace = await this.commandWorkspace(context);
    if (!workspace.canWrite) return { ok: false, kind: 'forbidden', message: 'Your workspace role has read-only CRM access.' };

    const errors: Partial<Record<CreateLeadField, readonly string[]>> = {};
    const displayName = input.displayName.trim();
    const companyName = input.companyName.trim();
    const email = input.email.trim();
    const phone = input.phone.trim();
    const opportunityTitle = input.opportunityTitle.trim();
    const taskTitle = input.taskTitle.trim();
    if (!displayName || displayName.length > 160) errors.display_name = ['Use a contact name between 1 and 160 characters.'];
    if (companyName.length > 160) errors.company_name = ['Keep the company name to 160 characters or fewer.'];
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) errors.email = ['Enter a valid email address.'];
    const normalizedPhone = phone.replace(/[\s().-]/g, '').replace(/^00/, '+');
    if (phone && !/^\+?\d{7,15}$/.test(normalizedPhone)) errors.phone = ['Enter a valid phone number with 7 to 15 digits.'];
    if (!email && !phone) {
      errors.email = ['Add an email address or phone number.'];
      errors.phone = ['Add a phone number or email address.'];
    }
    if (!opportunityTitle || opportunityTitle.length > 180) errors.opportunity_title = ['Use an opportunity name between 1 and 180 characters.'];
    if (!UUID_PATTERN.test(input.stageId)) errors.stage_id = ['Choose a saved open pipeline stage.'];
    if (taskTitle.length > 180) errors.task_title = ['Keep the first task to 180 characters or fewer.'];
    if (input.taskDueAt && !taskTitle) errors.task_title = ['Add a task name when setting a due date.'];
    const invalidCommandKey = !COMMAND_KEY_PATTERN.test(input.commandKey);

    let taskDueAt: string | null = null;
    if (input.taskDueAt) {
      try { taskDueAt = workspaceLocalDateTime(input.taskDueAt, workspace.timezone); }
      catch (error) { errors.task_due_at = [error instanceof Error ? error.message : 'Use a valid due date and time.']; }
    }
    if (Object.keys(errors).length > 0 || invalidCommandKey) {
      return {
        ok: false,
        kind: 'validation',
        message: invalidCommandKey ? 'Refresh the secure form before saving this lead.' : 'Check the highlighted lead details.',
        fieldErrors: errors,
      };
    }
    if (!workspace.defaultPipelineId) {
      return { ok: false, kind: 'unavailable', message: 'This workspace does not have a default CRM pipeline yet.' };
    }

    try {
      const result = await this.dependencies.commandService.createLead(context, {
        commandKey: input.commandKey,
        displayName,
        companyName: companyName || null,
        source: 'portal',
        ownerUserId: context.userId!,
        contactPoints: [
          ...(email ? [{ kind: 'email' as const, value: email, isPrimary: true }] : []),
          ...(phone ? [{ kind: 'phone' as const, value: phone, isPrimary: true }] : []),
        ],
        pipelineId: workspace.defaultPipelineId,
        stageId: input.stageId,
        opportunityName: opportunityTitle,
        currency: workspace.currency,
        task: taskTitle ? { title: taskTitle, assigneeUserId: context.userId!, dueAt: taskDueAt } : null,
      });
      return { ok: true, disposition: result.disposition };
    } catch (error) {
      return commandOutcome(error);
    }
  }

  async moveOpportunity(identity: PortalCrmRequestIdentity, input: PortalMoveOpportunityInput): Promise<PortalCrmMutationOutcome> {
    const context = await this.context(identity);
    if (!context) return { ok: false, kind: 'forbidden', message: 'This portal session is no longer active.' };
    const workspace = await this.commandWorkspace(context);
    if (!workspace.canWrite) return { ok: false, kind: 'forbidden', message: 'Your workspace role has read-only CRM access.' };
    const expectedRowVersion = positiveVersion(input.expectedRowVersion);
    if (!COMMAND_KEY_PATTERN.test(input.commandKey) || !UUID_PATTERN.test(input.opportunityId)
        || !UUID_PATTERN.test(input.targetStageId) || expectedRowVersion === null) {
      return { ok: false, kind: 'validation', message: 'Refresh the pipeline and choose a valid destination stage.' };
    }
    try {
      const result = await this.dependencies.commandService.moveOpportunityStage(context, {
        commandKey: input.commandKey,
        opportunityId: input.opportunityId,
        targetStageId: input.targetStageId,
        expectedRowVersion,
      });
      return { ok: true, disposition: result.disposition };
    } catch (error) {
      return commandOutcome(error);
    }
  }

  async completeTask(identity: PortalCrmRequestIdentity, input: PortalCompleteTaskInput): Promise<PortalCrmMutationOutcome> {
    const context = await this.context(identity);
    if (!context) return { ok: false, kind: 'forbidden', message: 'This portal session is no longer active.' };
    const workspace = await this.commandWorkspace(context);
    if (!workspace.canWrite) return { ok: false, kind: 'forbidden', message: 'Your workspace role has read-only CRM access.' };
    const expectedRowVersion = positiveVersion(input.expectedRowVersion);
    if (!COMMAND_KEY_PATTERN.test(input.commandKey) || !UUID_PATTERN.test(input.taskId) || expectedRowVersion === null) {
      return { ok: false, kind: 'validation', message: 'Refresh the task list before trying again.' };
    }
    try {
      const result = await this.dependencies.commandService.completeTask(context, {
        commandKey: input.commandKey,
        taskId: input.taskId,
        expectedRowVersion,
      });
      return { ok: true, disposition: result.disposition };
    } catch (error) {
      return commandOutcome(error);
    }
  }
}

export function createPgPortalCrmService(input: {
  webPool: Pool;
  commandPool: Pool;
}): PgPortalCrmService {
  return new PgPortalCrmService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    readService: createPgCrmReadService(input.webPool),
    commandService: new CrmCommandService({ transactionRunner: createPgCrmTransactionRunner(input.commandPool) }),
  });
}
