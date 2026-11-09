import type { DatabaseRequestContext } from '../db/rls.js';
import { validateDatabaseContext } from '../db/rls.js';
import { PgPropertyPredatorOwnedSeedMessageRepository } from './repository.js';
import {
  PropertyPredatorOwnedSeedMessageValidationError,
  type CreateOwnedSeedMessageDraftCommand,
  type CreateOwnedSeedMessageDraftResult,
  type DecideOwnedSeedMessageApprovalCommand,
  type DecideOwnedSeedMessageApprovalResult,
  type PropertyPredatorOwnedSeedMessageRepository,
  type PropertyPredatorOwnedSeedMessageServiceDependencies,
  type RequestOwnedSeedMessageApprovalCommand,
  type RequestOwnedSeedMessageApprovalResult,
  type ResumeOwnedSeedMessageCommand,
  type ResumeOwnedSeedMessageResult,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMAND_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new PropertyPredatorOwnedSeedMessageValidationError(`${label} must be a UUID`);
  }
  return value;
}

function commandKey(value: unknown): string {
  if (typeof value !== 'string' || !COMMAND_KEY.test(value)) {
    throw new PropertyPredatorOwnedSeedMessageValidationError('commandKey is invalid');
  }
  return value;
}

function note(value: unknown, label: string, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value !== value.trim()
      || value.length < 1 || value.length > maximum) {
    throw new PropertyPredatorOwnedSeedMessageValidationError(
      `${label} must be trimmed and contain 1-${maximum} characters`,
    );
  }
  return value;
}

export class PropertyPredatorOwnedSeedMessageService {
  readonly #repository: PropertyPredatorOwnedSeedMessageRepository;
  readonly #workspaceId: string;

  constructor(dependencies: PropertyPredatorOwnedSeedMessageServiceDependencies) {
    this.#workspaceId = uuid(dependencies.workspaceId, 'workspaceId');
    this.#repository = new PgPropertyPredatorOwnedSeedMessageRepository({
      commandPool: dependencies.commandPool,
      workspaceId: this.#workspaceId,
    });
  }

  async createDraft(
    context: DatabaseRequestContext,
    input: CreateOwnedSeedMessageDraftCommand,
  ): Promise<CreateOwnedSeedMessageDraftResult> {
    this.#context(context);
    if (!input || typeof input !== 'object') {
      throw new PropertyPredatorOwnedSeedMessageValidationError('Draft command is required');
    }
    return this.#repository.createDraft(context, Object.freeze({
      commandKey: commandKey(input.commandKey),
      companyContentVersionId: uuid(
        input.companyContentVersionId,
        'companyContentVersionId',
      ),
    }));
  }

  async requestApproval(
    context: DatabaseRequestContext,
    input: RequestOwnedSeedMessageApprovalCommand,
  ): Promise<RequestOwnedSeedMessageApprovalResult> {
    this.#context(context);
    if (!input || typeof input !== 'object') {
      throw new PropertyPredatorOwnedSeedMessageValidationError('Approval request is required');
    }
    return this.#repository.requestApproval(context, Object.freeze({
      commandKey: commandKey(input.commandKey),
      messageId: uuid(input.messageId, 'messageId'),
      reviewNote: note(input.reviewNote, 'reviewNote', 2_000),
    }));
  }

  async decideApproval(
    context: DatabaseRequestContext,
    input: DecideOwnedSeedMessageApprovalCommand,
  ): Promise<DecideOwnedSeedMessageApprovalResult> {
    this.#context(context);
    if (!input || typeof input !== 'object'
        || !['approved', 'rejected', 'changes_requested'].includes(input.decision)) {
      throw new PropertyPredatorOwnedSeedMessageValidationError('Approval decision is invalid');
    }
    const decisionNote = note(input.decisionNote, 'decisionNote', 4_000);
    if (input.decision !== 'approved' && decisionNote === null) {
      throw new PropertyPredatorOwnedSeedMessageValidationError(
        'A rejection or change request requires a decisionNote',
      );
    }
    return this.#repository.decideApproval(context, Object.freeze({
      commandKey: commandKey(input.commandKey),
      approvalRequestId: uuid(input.approvalRequestId, 'approvalRequestId'),
      decision: input.decision,
      decisionNote,
    }));
  }

  async resume(
    context: DatabaseRequestContext,
    input: ResumeOwnedSeedMessageCommand,
  ): Promise<ResumeOwnedSeedMessageResult | null> {
    this.#context(context);
    if (!input || typeof input !== 'object') {
      throw new PropertyPredatorOwnedSeedMessageValidationError(
        'Resume command is required',
      );
    }
    return this.#repository.resume(context, Object.freeze({
      companyContentVersionId: uuid(
        input.companyContentVersionId,
        'companyContentVersionId',
      ),
    }));
  }

  async assertReady(): Promise<void> { return this.#repository.assertReady(); }

  #context(context: DatabaseRequestContext): void {
    validateDatabaseContext(context);
    if (context.actorKind !== 'user' || !context.userId) {
      throw new PropertyPredatorOwnedSeedMessageValidationError(
        'Owned-seed message commands require an authenticated user context',
      );
    }
    if (context.workspaceId !== this.#workspaceId) {
      throw new PropertyPredatorOwnedSeedMessageValidationError(
        'Owned-seed message context is outside the configured workspace',
      );
    }
  }
}

export function createPropertyPredatorOwnedSeedMessageService(
  dependencies: PropertyPredatorOwnedSeedMessageServiceDependencies,
): PropertyPredatorOwnedSeedMessageService {
  return new PropertyPredatorOwnedSeedMessageService(dependencies);
}
