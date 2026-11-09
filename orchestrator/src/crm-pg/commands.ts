import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { validateDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { createPlatformEvent, type JsonObject } from '../platform/events.js';
import {
  CommandInProgressError,
  CrmEntityNotFoundError,
  IdempotencyKeyReusedError,
  InvalidCrmCommandError,
  InvalidCrmStateError,
  OptimisticConflictError,
} from './errors.js';
import { CrmPgRepository } from './repository.js';
import type {
  CompleteTaskCommand,
  CompleteTaskResult,
  ContactPointKind,
  CreateLeadCommand,
  CreateLeadResult,
  CrmCommandDependencies,
  LeadContactPointInput,
  MoveOpportunityStageCommand,
  MoveOpportunityStageResult,
} from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMAND_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RFC3339_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

interface NormalizedContactPoint {
  kind: ContactPointKind;
  label: string | null;
  value: string;
  normalizedValue: string;
  isPrimary: boolean;
  consentStatus: 'unknown' | 'opted_in' | 'opted_out';
}

interface NormalizedCreateLead {
  commandKey: string;
  displayName: string;
  companyName: string | null;
  source: string | null;
  ownerUserId: string | null;
  contactPoints: readonly NormalizedContactPoint[];
  pipelineId: string;
  stageId: string;
  opportunityName: string;
  valueMinor: number;
  currency: string;
  task: {
    title: string;
    description: string | null;
    assigneeUserId: string | null;
    dueAt: string | null;
  } | null;
}

interface NormalizedMoveStage {
  commandKey: string;
  opportunityId: string;
  targetStageId: string;
  expectedRowVersion: number;
  note: string | null;
}

interface NormalizedCompleteTask {
  commandKey: string;
  taskId: string;
  expectedRowVersion: number;
}

function requiredText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new InvalidCrmCommandError(`${label} is required`);
  if (normalized.length > maxLength) throw new InvalidCrmCommandError(`${label} is too long`);
  return normalized;
}

function optionalText(value: string | null | undefined, label: string, maxLength: number): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) throw new InvalidCrmCommandError(`${label} is too long`);
  return normalized;
}

function commandKey(value: string): string {
  if (!COMMAND_KEY_PATTERN.test(value)) {
    throw new InvalidCrmCommandError(
      'commandKey must be 1-128 characters using letters, numbers, dot, underscore, colon or hyphen',
    );
  }
  return value;
}

function uuid(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new InvalidCrmCommandError(`${label} must be a UUID`);
  return normalized;
}

function optionalUuid(value: string | null | undefined, label: string): string | null {
  return value == null ? null : uuid(value, label);
}

function rowVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InvalidCrmCommandError('expectedRowVersion must be a positive safe integer');
  }
  return value;
}

function canonicalDate(value: string | null | undefined, label: string): string | null {
  if (value == null || !value.trim()) return null;
  const candidate = value.trim();
  const match = RFC3339_TIMESTAMP_PATTERN.exec(candidate);
  if (!match) throw new InvalidCrmCommandError(`${label} must be an RFC3339 timestamp with an explicit timezone`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? '').padEnd(3, '0'));
  const offset = match[8]!;
  if (year < 1 || hour > 23 || minute > 59 || second > 59
      || (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59))) {
    throw new InvalidCrmCommandError(`${label} must be a valid timestamp`);
  }
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, millisecond);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1
      || calendar.getUTCDate() !== day || calendar.getUTCHours() !== hour
      || calendar.getUTCMinutes() !== minute || calendar.getUTCSeconds() !== second) {
    throw new InvalidCrmCommandError(`${label} must be a real calendar timestamp`);
  }
  const parsed = new Date(candidate);
  if (!Number.isFinite(parsed.getTime())) throw new InvalidCrmCommandError(`${label} must be a valid timestamp`);
  return parsed.toISOString();
}

function normalizePoint(input: LeadContactPointInput, index: number): NormalizedContactPoint {
  const value = requiredText(input.value, `contactPoints[${index}].value`, 320);
  let normalizedValue: string;
  if (input.kind === 'email') {
    normalizedValue = value.toLowerCase();
    if (!EMAIL_PATTERN.test(normalizedValue)) {
      throw new InvalidCrmCommandError(`contactPoints[${index}] must contain a valid email address`);
    }
  } else if (input.kind === 'phone' || input.kind === 'whatsapp') {
    let number = value.replace(/[\s().-]/g, '');
    if (number.startsWith('00')) number = `+${number.slice(2)}`;
    if (!/^\+?\d{7,15}$/.test(number)) {
      throw new InvalidCrmCommandError(`contactPoints[${index}] must contain a valid phone number`);
    }
    normalizedValue = number;
  } else if (input.kind === 'social' || input.kind === 'other') {
    normalizedValue = value.toLocaleLowerCase('en-GB');
  } else {
    throw new InvalidCrmCommandError(`contactPoints[${index}].kind is invalid`);
  }
  const consentStatus = input.consentStatus ?? 'unknown';
  if (!['unknown', 'opted_in', 'opted_out'].includes(consentStatus)) {
    throw new InvalidCrmCommandError(`contactPoints[${index}].consentStatus is invalid`);
  }
  return {
    kind: input.kind,
    label: optionalText(input.label, `contactPoints[${index}].label`, 50),
    value,
    normalizedValue,
    isPrimary: input.isPrimary ?? false,
    consentStatus,
  };
}

function normalizeCreateLead(input: CreateLeadCommand): NormalizedCreateLead {
  if (!Array.isArray(input.contactPoints) || input.contactPoints.length < 1 || input.contactPoints.length > 10) {
    throw new InvalidCrmCommandError('contactPoints must contain between 1 and 10 entries');
  }
  const displayName = requiredText(input.displayName, 'displayName', 200);
  const seenKinds = new Set<ContactPointKind>();
  const points = input.contactPoints.map((point, index) => {
    const firstOfKind = !seenKinds.has(point.kind);
    seenKinds.add(point.kind);
    const normalized = normalizePoint(point, index);
    return { ...normalized, isPrimary: point.isPrimary ?? firstOfKind };
  });
  const seen = new Set<string>();
  const primaryKinds = new Set<ContactPointKind>();
  for (const point of points) {
    const key = `${point.kind}\u0000${point.normalizedValue}`;
    if (seen.has(key)) throw new InvalidCrmCommandError('contactPoints contains a duplicate destination');
    seen.add(key);
    if (point.isPrimary && primaryKinds.has(point.kind)) {
      throw new InvalidCrmCommandError(`contactPoints contains more than one primary ${point.kind}`);
    }
    if (point.isPrimary) primaryKinds.add(point.kind);
  }
  const valueMinor = input.valueMinor ?? 0;
  if (!Number.isSafeInteger(valueMinor) || valueMinor < 0) {
    throw new InvalidCrmCommandError('valueMinor must be a non-negative safe integer');
  }
  const currency = (input.currency ?? 'GBP').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new InvalidCrmCommandError('currency must be a three-letter code');
  return {
    commandKey: commandKey(input.commandKey),
    displayName,
    companyName: optionalText(input.companyName, 'companyName', 200),
    source: optionalText(input.source, 'source', 100),
    ownerUserId: optionalUuid(input.ownerUserId, 'ownerUserId'),
    contactPoints: points,
    pipelineId: uuid(input.pipelineId, 'pipelineId'),
    stageId: uuid(input.stageId, 'stageId'),
    opportunityName: optionalText(input.opportunityName, 'opportunityName', 200)
      ?? `${displayName.slice(0, 188)} opportunity`,
    valueMinor,
    currency,
    task: input.task ? {
      title: requiredText(input.task.title, 'task.title', 240),
      description: optionalText(input.task.description, 'task.description', 4_000),
      assigneeUserId: optionalUuid(input.task.assigneeUserId, 'task.assigneeUserId'),
      dueAt: canonicalDate(input.task.dueAt, 'task.dueAt'),
    } : null,
  };
}

function normalizeMoveStage(input: MoveOpportunityStageCommand): NormalizedMoveStage {
  return {
    commandKey: commandKey(input.commandKey),
    opportunityId: uuid(input.opportunityId, 'opportunityId'),
    targetStageId: uuid(input.targetStageId, 'targetStageId'),
    expectedRowVersion: rowVersion(input.expectedRowVersion),
    note: optionalText(input.note, 'note', 2_000),
  };
}

function normalizeCompleteTask(input: CompleteTaskCommand): NormalizedCompleteTask {
  return {
    commandKey: commandKey(input.commandKey),
    taskId: uuid(input.taskId, 'taskId'),
    expectedRowVersion: rowVersion(input.expectedRowVersion),
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new InvalidCrmCommandError('Command contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  }
  throw new InvalidCrmCommandError('Command contains a value that cannot be hashed');
}

function requestHash(context: DatabaseRequestContext, commandName: string, payload: unknown): Buffer {
  return createHash('sha256').update(stableJson({
    actorKind: context.actorKind,
    actorUserId: actorUserId(context),
    commandName,
    payload,
  })).digest();
}

function hashesEqual(left: Uint8Array, right: Uint8Array): boolean {
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
}

function actorUserId(context: DatabaseRequestContext): string | null {
  return context.actorKind === 'user' ? context.userId?.toLowerCase() ?? null : null;
}

function validatePortalCommandContext(context: DatabaseRequestContext): void {
  validateDatabaseContext(context);
  if (context.actorKind !== 'user' || !context.userId) {
    throw new InvalidCrmCommandError('CRM portal commands require an authenticated user context');
  }
}

function replayResult<TResult extends { disposition: 'applied' | 'replayed' }>(
  stored: unknown,
  validate: (value: unknown) => value is TResult,
): TResult {
  if (!validate(stored)) throw new Error('Stored command result is invalid');
  return Object.freeze({ ...stored, disposition: 'replayed' }) as TResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCreateLeadResult(value: unknown): value is CreateLeadResult {
  return isRecord(value)
    && (value.disposition === 'applied' || value.disposition === 'replayed')
    && typeof value.contactId === 'string'
    && typeof value.opportunityId === 'string'
    && (typeof value.taskId === 'string' || value.taskId === null)
    && typeof value.createdContact === 'boolean';
}

function isMoveStageResult(value: unknown): value is MoveOpportunityStageResult {
  return isRecord(value)
    && (value.disposition === 'applied' || value.disposition === 'replayed')
    && typeof value.opportunityId === 'string'
    && typeof value.fromStageId === 'string'
    && typeof value.toStageId === 'string'
    && ['open', 'won', 'lost'].includes(String(value.status))
    && typeof value.rowVersion === 'number';
}

function isCompleteTaskResult(value: unknown): value is CompleteTaskResult {
  return isRecord(value)
    && (value.disposition === 'applied' || value.disposition === 'replayed')
    && typeof value.taskId === 'string'
    && typeof value.completedAt === 'string'
    && typeof value.rowVersion === 'number';
}

export class CrmCommandService {
  private readonly nextId: () => string;
  private readonly now: () => Date;

  constructor(private readonly dependencies: CrmCommandDependencies) {
    this.nextId = dependencies.nextId ?? randomUUID;
    this.now = dependencies.now ?? (() => new Date());
  }

  async createLead(context: DatabaseRequestContext, command: CreateLeadCommand): Promise<CreateLeadResult> {
    validatePortalCommandContext(context);
    const input = normalizeCreateLead(command);
    const payloadHash = requestHash(context, 'crm.createLead', input);
    return this.dependencies.transactionRunner.run(context, async (transaction) => {
      const repository = new CrmPgRepository(transaction);
      const at = this.now().toISOString();
      const claim = await repository.claimCommand({
        id: this.nextId(),
        commandName: 'crm.createLead',
        commandKey: input.commandKey,
        requestId: context.requestId,
        actorUserId: actorUserId(context),
        payloadHash,
        createdAt: at,
      });
      if (!hashesEqual(claim.payloadHash, payloadHash)) throw new IdempotencyKeyReusedError();
      if (!claim.inserted) {
        if (claim.status === 'succeeded') return replayResult(claim.result, isCreateLeadResult);
        throw new CommandInProgressError();
      }

      const matchedContactIds = new Set<string>();
      const matchedPointOwners = new Map<string, string>();
      for (const point of input.contactPoints) {
        const match = await repository.findContactPoint(point.kind, point.normalizedValue);
        if (match?.contactState === 'archived') {
          throw new InvalidCrmStateError('A contact with this destination is archived and must be restored before it can receive a new opportunity');
        }
        if (match?.contactState === 'deleted') {
          throw new InvalidCrmStateError('A deleted contact still owns this destination and must be restored or permanently resolved first');
        }
        if (match) {
          matchedContactIds.add(match.contactId);
          matchedPointOwners.set(`${point.kind}:${point.normalizedValue}`, match.contactId);
        }
      }
      if (matchedContactIds.size > 1) {
        throw new InvalidCrmStateError('Lead contact points belong to different existing contacts');
      }

      const existingContactId = matchedContactIds.values().next().value as string | undefined;
      const contactId = existingContactId ?? this.nextId();
      const createdContact = existingContactId === undefined;
      if (createdContact) {
        await repository.insertContact({
          id: contactId,
          displayName: input.displayName,
          companyName: input.companyName,
          ownerUserId: input.ownerUserId,
          source: input.source,
          createdAt: at,
        });
      }

      for (const point of input.contactPoints) {
        const existingOwner = matchedPointOwners.get(`${point.kind}:${point.normalizedValue}`);
        if (existingOwner === contactId) continue;
        const isPrimary = createdContact
          ? point.isPrimary
          : point.isPrimary && !(await repository.hasPrimaryContactPoint(contactId, point.kind));
        const inserted = await repository.insertContactPoint({
          id: this.nextId(),
          contactId,
          ...point,
          // Never replace an existing primary while creating an opportunity,
          // but make the first destination of each kind visible immediately.
          isPrimary,
          createdAt: at,
        });
        if (!inserted) {
          const owner = await repository.findContactPoint(point.kind, point.normalizedValue);
          if (!owner || owner.contactId !== contactId) {
            throw new OptimisticConflictError('Contact point');
          }
        }
      }

      const stage = await repository.getPipelineStage(input.stageId, input.pipelineId);
      if (!stage) throw new CrmEntityNotFoundError('Pipeline stage');
      if (stage.status !== 'open') throw new InvalidCrmStateError('A new lead must start in an open pipeline stage');

      const opportunityId = this.nextId();
      await repository.insertOpportunity({
        id: opportunityId,
        contactId,
        pipelineId: input.pipelineId,
        stageId: input.stageId,
        name: input.opportunityName,
        status: stage.status,
        valueMinor: input.valueMinor,
        currency: input.currency,
        ownerUserId: input.ownerUserId,
        createdAt: at,
      });

      const taskId = input.task ? this.nextId() : null;
      if (input.task && taskId) {
        await repository.insertTask({
          id: taskId,
          contactId,
          opportunityId,
          ...input.task,
          createdAt: at,
        });
      }

      const correlationId = this.nextId();
      await repository.insertActivity({
        id: this.nextId(),
        contactId,
        opportunityId,
        taskId,
        activityType: 'crm.lead.created',
        actorUserId: actorUserId(context),
        actorKind: context.actorKind,
        subject: 'Lead created',
        body: input.source ? `Source: ${input.source}` : null,
        metadata: { createdContact, pipelineId: input.pipelineId, stageId: input.stageId },
        requestId: context.requestId,
        correlationId,
        causationId: null,
        occurredAt: at,
      });

      if (createdContact) {
        const contactCreatedEvent = createPlatformEvent({
          id: this.nextId(),
          type: 'crm.contact.created',
          workspaceId: context.workspaceId,
          occurredAt: at,
          actorId: actorUserId(context),
          correlationId,
          payload: { contactId, source: input.source } as JsonObject,
        });
        await repository.insertOutboxEvent(contactCreatedEvent, 'contact', contactId, context.requestId);
      }

      const eventId = this.nextId();
      const event = createPlatformEvent({
        id: eventId,
        type: 'crm.lead.created',
        workspaceId: context.workspaceId,
        occurredAt: at,
        actorId: actorUserId(context),
        correlationId,
        payload: {
          contactId,
          opportunityId,
          taskId,
          pipelineId: input.pipelineId,
          stageId: input.stageId,
          source: input.source,
          createdContact,
        } as JsonObject,
      });
      await repository.insertOutboxEvent(event, 'opportunity', opportunityId, context.requestId);

      const result = Object.freeze<CreateLeadResult>({
        disposition: 'applied',
        contactId,
        opportunityId,
        taskId,
        createdContact,
      });
      await repository.completeCommand({ receiptId: claim.id, payloadHash, result, completedAt: at });
      return result;
    });
  }

  async moveOpportunityStage(
    context: DatabaseRequestContext,
    command: MoveOpportunityStageCommand,
  ): Promise<MoveOpportunityStageResult> {
    validatePortalCommandContext(context);
    const input = normalizeMoveStage(command);
    const payloadHash = requestHash(context, 'crm.moveOpportunityStage', input);
    return this.dependencies.transactionRunner.run(context, async (transaction) => {
      const repository = new CrmPgRepository(transaction);
      const at = this.now().toISOString();
      const claim = await repository.claimCommand({
        id: this.nextId(),
        commandName: 'crm.moveOpportunityStage',
        commandKey: input.commandKey,
        requestId: context.requestId,
        actorUserId: actorUserId(context),
        payloadHash,
        createdAt: at,
      });
      if (!hashesEqual(claim.payloadHash, payloadHash)) throw new IdempotencyKeyReusedError();
      if (!claim.inserted) {
        if (claim.status === 'succeeded') return replayResult(claim.result, isMoveStageResult);
        throw new CommandInProgressError();
      }

      const opportunity = await repository.lockOpportunity(input.opportunityId);
      if (!opportunity) throw new CrmEntityNotFoundError('Opportunity');
      if (opportunity.rowVersion !== input.expectedRowVersion) throw new OptimisticConflictError('Opportunity');
      if (opportunity.stageId === input.targetStageId) {
        throw new InvalidCrmStateError('Opportunity is already in the requested stage');
      }
      const targetStage = await repository.getPipelineStage(input.targetStageId, opportunity.pipelineId);
      if (!targetStage) throw new CrmEntityNotFoundError('Target pipeline stage');
      const updatedVersion = await repository.updateOpportunityStage({
        opportunityId: opportunity.id,
        targetStageId: targetStage.id,
        targetStatus: targetStage.status,
        expectedRowVersion: input.expectedRowVersion,
        changedAt: at,
      });
      if (updatedVersion === null) throw new OptimisticConflictError('Opportunity');

      const correlationId = this.nextId();
      await repository.insertStageHistory({
        id: this.nextId(),
        pipelineId: opportunity.pipelineId,
        opportunityId: opportunity.id,
        fromStageId: opportunity.stageId,
        toStageId: targetStage.id,
        changedByUserId: actorUserId(context),
        actorKind: context.actorKind,
        requestId: context.requestId,
        correlationId,
        note: input.note,
        changedAt: at,
      });
      await repository.insertActivity({
        id: this.nextId(),
        contactId: opportunity.contactId,
        opportunityId: opportunity.id,
        taskId: null,
        activityType: 'crm.opportunity.stage_changed',
        actorUserId: actorUserId(context),
        actorKind: context.actorKind,
        subject: 'Opportunity stage changed',
        body: input.note,
        metadata: { fromStageId: opportunity.stageId, toStageId: targetStage.id, status: targetStage.status },
        requestId: context.requestId,
        correlationId,
        causationId: null,
        occurredAt: at,
      });
      const event = createPlatformEvent({
        id: this.nextId(),
        type: 'crm.opportunity.stage_changed',
        workspaceId: context.workspaceId,
        occurredAt: at,
        actorId: actorUserId(context),
        correlationId,
        payload: {
          opportunityId: opportunity.id,
          contactId: opportunity.contactId,
          fromStageId: opportunity.stageId,
          toStageId: targetStage.id,
          status: targetStage.status,
          rowVersion: updatedVersion,
        },
      });
      await repository.insertOutboxEvent(event, 'opportunity', opportunity.id, context.requestId);

      const result = Object.freeze<MoveOpportunityStageResult>({
        disposition: 'applied',
        opportunityId: opportunity.id,
        fromStageId: opportunity.stageId,
        toStageId: targetStage.id,
        status: targetStage.status,
        rowVersion: updatedVersion,
      });
      await repository.completeCommand({ receiptId: claim.id, payloadHash, result, completedAt: at });
      return result;
    });
  }

  async completeTask(context: DatabaseRequestContext, command: CompleteTaskCommand): Promise<CompleteTaskResult> {
    validatePortalCommandContext(context);
    const input = normalizeCompleteTask(command);
    const payloadHash = requestHash(context, 'crm.completeTask', input);
    return this.dependencies.transactionRunner.run(context, async (transaction) => {
      const repository = new CrmPgRepository(transaction);
      const at = this.now().toISOString();
      const claim = await repository.claimCommand({
        id: this.nextId(),
        commandName: 'crm.completeTask',
        commandKey: input.commandKey,
        requestId: context.requestId,
        actorUserId: actorUserId(context),
        payloadHash,
        createdAt: at,
      });
      if (!hashesEqual(claim.payloadHash, payloadHash)) throw new IdempotencyKeyReusedError();
      if (!claim.inserted) {
        if (claim.status === 'succeeded') return replayResult(claim.result, isCompleteTaskResult);
        throw new CommandInProgressError();
      }

      const task = await repository.lockTask(input.taskId);
      if (!task) throw new CrmEntityNotFoundError('Task');
      if (task.rowVersion !== input.expectedRowVersion) throw new OptimisticConflictError('Task');
      if (task.status !== 'open') throw new InvalidCrmStateError('Only an open task can be completed');
      const updatedVersion = await repository.completeTask({
        taskId: task.id,
        expectedRowVersion: input.expectedRowVersion,
        completedByUserId: actorUserId(context),
        completedAt: at,
      });
      if (updatedVersion === null) throw new OptimisticConflictError('Task');

      const correlationId = this.nextId();
      await repository.insertActivity({
        id: this.nextId(),
        contactId: task.contactId,
        opportunityId: task.opportunityId,
        taskId: task.id,
        activityType: 'crm.task.completed',
        actorUserId: actorUserId(context),
        actorKind: context.actorKind,
        subject: 'Task completed',
        body: null,
        metadata: { rowVersion: updatedVersion },
        requestId: context.requestId,
        correlationId,
        causationId: null,
        occurredAt: at,
      });
      const event = createPlatformEvent({
        id: this.nextId(),
        type: 'crm.task.completed',
        workspaceId: context.workspaceId,
        occurredAt: at,
        actorId: actorUserId(context),
        correlationId,
        payload: {
          taskId: task.id,
          contactId: task.contactId,
          opportunityId: task.opportunityId,
          rowVersion: updatedVersion,
        } as JsonObject,
      });
      await repository.insertOutboxEvent(event, 'task', task.id, context.requestId);

      const result = Object.freeze<CompleteTaskResult>({
        disposition: 'applied',
        taskId: task.id,
        completedAt: at,
        rowVersion: updatedVersion,
      });
      await repository.completeCommand({ receiptId: claim.id, payloadHash, result, completedAt: at });
      return result;
    });
  }
}
