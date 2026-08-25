import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseRequestContext } from '../db/rls.js';
import { CompanyContentPgRepository } from './repository.js';
import {
  CompanyContentApprovalConflictError,
  CompanyContentCommandInProgressError,
  CompanyContentIdempotencyConflictError,
  CompanyContentNotFoundError,
  CompanyContentValidationError,
  CompanyContentVersionConflictError,
  type CompanyContentCatalogPage,
  type CompanyContentCatalogQuery,
  type CompanyContentServiceDependencies,
  type CompanyContentVersionApprovalState,
  type CreateCompanyContentVersionCommand,
  type CreateCompanyContentVersionResult,
  type DecideCompanyContentApprovalCommand,
  type DecideCompanyContentApprovalResult,
  type RequestCompanyContentApprovalCommand,
  type RequestCompanyContentApprovalResult,
} from './types.js';
import {
  companyContentRequestHash,
  normalizeApprovalDecisionCommand,
  normalizeApprovalRequestCommand,
  normalizeCompanyContentVersionCommand,
  validateCompanyContentUserContext,
} from './validation.js';

const CREATE_VERSION = 'companyContent.createVersion';
const REQUEST_APPROVAL = 'companyContent.requestApproval';
const DECIDE_APPROVAL = 'companyContent.decideApproval';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface PgErrorLike {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly message?: unknown;
}

function hashesEqual(left: Uint8Array, right: Uint8Array): boolean {
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.byteLength === second.byteLength && timingSafeEqual(first, second);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function createVersionResult(value: unknown): value is CreateCompanyContentVersionResult {
  return record(value)
    && (value.disposition === 'applied' || value.disposition === 'replayed')
    && typeof value.contentItemId === 'string'
    && typeof value.contentVersionId === 'string'
    && typeof value.versionNumber === 'number'
    && validSha(value.contentSha256)
    && typeof value.sourceAttestationId === 'string'
    && typeof value.sourceAttestationExpiresAt === 'string';
}

function approvalRequestResult(value: unknown): value is RequestCompanyContentApprovalResult {
  return record(value)
    && (value.disposition === 'applied' || value.disposition === 'replayed')
    && typeof value.approvalRequestId === 'string'
    && typeof value.contentItemId === 'string'
    && typeof value.contentVersionId === 'string'
    && typeof value.requestNumber === 'number'
    && validSha(value.contentSha256);
}

function approvalDecisionResult(value: unknown): value is DecideCompanyContentApprovalResult {
  return record(value)
    && (value.disposition === 'applied' || value.disposition === 'replayed')
    && typeof value.approvalDecisionId === 'string'
    && typeof value.approvalRequestId === 'string'
    && typeof value.contentItemId === 'string'
    && typeof value.contentVersionId === 'string'
    && ['approved', 'rejected', 'changes_requested'].includes(String(value.decision))
    && validSha(value.contentSha256);
}

function replay<TResult extends { readonly disposition: 'applied' | 'replayed' }>(
  value: unknown,
  validate: (candidate: unknown) => candidate is TResult,
): TResult {
  if (!validate(value)) throw new Error('Stored company content command result is invalid');
  return Object.freeze({ ...value, disposition: 'replayed' }) as TResult;
}

function actorUserId(context: DatabaseRequestContext): string {
  return context.userId!.toLowerCase();
}

function pgError(error: unknown): PgErrorLike {
  return error && typeof error === 'object' ? error as PgErrorLike : {};
}

function translateContentWriteError(error: unknown): never {
  const candidate = pgError(error);
  if (candidate.code === '40001') {
    throw new CompanyContentVersionConflictError();
  }
  if (candidate.code === '23505') {
    throw new CompanyContentApprovalConflictError(
      'This content source, approval request or decision already exists',
    );
  }
  throw error;
}

export class CompanyContentService {
  readonly #nextId: () => string;
  readonly #now: () => Date;

  constructor(private readonly dependencies: CompanyContentServiceDependencies) {
    this.#nextId = dependencies.nextId ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date());
  }

  async createVersion(
    context: DatabaseRequestContext,
    command: CreateCompanyContentVersionCommand,
  ): Promise<CreateCompanyContentVersionResult> {
    validateCompanyContentUserContext(context);
    const input = normalizeCompanyContentVersionCommand(command);
    const requestHash = companyContentRequestHash(context, CREATE_VERSION, input);
    try {
      return await this.dependencies.transactionRunner.run(context, async (transaction) => {
        const repository = new CompanyContentPgRepository(transaction);
        const at = this.#now().toISOString();
        const claim = await repository.claimCommand({
          id: this.#nextId(),
          commandName: CREATE_VERSION,
          commandKey: input.commandKey,
          requestId: context.requestId,
          payloadHash: requestHash,
          createdAt: at,
        });
        if (!hashesEqual(claim.payloadHash, requestHash)) {
          throw new CompanyContentIdempotencyConflictError();
        }
        if (!claim.inserted) {
          if (claim.status === 'succeeded') return replay(claim.result, createVersionResult);
          throw new CompanyContentCommandInProgressError();
        }

        const sourceItem = await repository.lockSourceIdentity(
          input.sourceSystem,
          input.sourceItemId,
        );
        let contentItemId: string;
        let previousVersionId: string | null;
        let versionNumber: number;
        if (input.contentItemId === null) {
          if (sourceItem === null) {
            contentItemId = this.#nextId();
            previousVersionId = null;
            versionNumber = 1;
            await repository.insertContentItem({
              id: contentItemId,
              sourceSystem: input.sourceSystem,
              sourceItemId: input.sourceItemId,
              actorUserId: actorUserId(context),
              requestId: context.requestId,
              createdAt: at,
            });
          } else {
            if (sourceItem.latestVersionId === null
                || sourceItem.latestVersionNumber === null) {
              throw new CompanyContentVersionConflictError(
                'Company content source identity has no committed version',
              );
            }
            contentItemId = sourceItem.contentItemId;
            previousVersionId = sourceItem.latestVersionId;
            versionNumber = sourceItem.latestVersionNumber + 1;
          }
        } else {
          if (!sourceItem || sourceItem.contentItemId !== input.contentItemId) {
            throw new CompanyContentNotFoundError('Company content source identity');
          }
          if (sourceItem.latestVersionId !== input.previousVersionId
              || sourceItem.latestVersionNumber === null) {
            throw new CompanyContentVersionConflictError();
          }
          contentItemId = sourceItem.contentItemId;
          previousVersionId = sourceItem.latestVersionId;
          versionNumber = sourceItem.latestVersionNumber + 1;
        }

        const version = await repository.insertVersion({
          id: this.#nextId(),
          contentItemId,
          previousVersionId,
          versionNumber,
          command: input,
          actorUserId: actorUserId(context),
          requestId: context.requestId,
          createdAt: at,
        });
        if (version.contentSha256 !== input.contentSha256) {
          throw new Error('PostgreSQL content digest did not match the canonical UTF-8 bytes');
        }
        const sourceAttestation = await repository.insertSourceAttestation({
          id: this.#nextId(),
          version,
          command: input,
          actorUserId: actorUserId(context),
          requestId: context.requestId,
          createdAt: at,
        });
        const result = Object.freeze<CreateCompanyContentVersionResult>({
          disposition: 'applied',
          contentItemId,
          contentVersionId: version.contentVersionId,
          versionNumber,
          contentSha256: version.contentSha256,
          sourceAttestationId: sourceAttestation.id,
          sourceAttestationExpiresAt: sourceAttestation.expiresAt,
        });
        await repository.completeCommand({
          receiptId: claim.id,
          payloadHash: requestHash,
          result: { ...result },
          completedAt: at,
        });
        return result;
      }, { readOnly: false, serializable: true });
    } catch (error) {
      if (error instanceof CompanyContentIdempotencyConflictError
          || error instanceof CompanyContentCommandInProgressError
          || error instanceof CompanyContentNotFoundError
          || error instanceof CompanyContentVersionConflictError) {
        throw error;
      }
      return translateContentWriteError(error);
    }
  }

  async requestApproval(
    context: DatabaseRequestContext,
    command: RequestCompanyContentApprovalCommand,
  ): Promise<RequestCompanyContentApprovalResult> {
    validateCompanyContentUserContext(context);
    const input = normalizeApprovalRequestCommand(command);
    const requestHash = companyContentRequestHash(context, REQUEST_APPROVAL, input);
    try {
      return await this.dependencies.transactionRunner.run(context, async (transaction) => {
        const repository = new CompanyContentPgRepository(transaction);
        const at = this.#now().toISOString();
        const claim = await repository.claimCommand({
          id: this.#nextId(),
          commandName: REQUEST_APPROVAL,
          commandKey: input.commandKey,
          requestId: context.requestId,
          payloadHash: requestHash,
          createdAt: at,
        });
        if (!hashesEqual(claim.payloadHash, requestHash)) {
          throw new CompanyContentIdempotencyConflictError();
        }
        if (!claim.inserted) {
          if (claim.status === 'succeeded') return replay(claim.result, approvalRequestResult);
          throw new CompanyContentCommandInProgressError();
        }

        const version = await repository.lockVersion(
          input.contentItemId,
          input.contentVersionId,
        );
        if (!version) throw new CompanyContentNotFoundError('Company content version');
        if (!version.isLatest) throw new CompanyContentVersionConflictError();
        const requestNumber = await repository.nextApprovalRequestNumber(
          version.contentItemId,
          version.contentVersionId,
        );
        const request = await repository.insertApprovalRequest({
          id: this.#nextId(),
          version,
          requestNumber,
          reviewNote: input.reviewNote,
          actorUserId: actorUserId(context),
          requestId: context.requestId,
          requestedAt: at,
        });
        const result = Object.freeze<RequestCompanyContentApprovalResult>({
          disposition: 'applied',
          approvalRequestId: request.approvalRequestId,
          contentItemId: request.contentItemId,
          contentVersionId: request.contentVersionId,
          requestNumber: request.requestNumber,
          contentSha256: request.contentSha256,
        });
        await repository.completeCommand({
          receiptId: claim.id,
          payloadHash: requestHash,
          result: { ...result },
          completedAt: at,
        });
        return result;
      }, { readOnly: false, serializable: true });
    } catch (error) {
      if (error instanceof CompanyContentIdempotencyConflictError
          || error instanceof CompanyContentCommandInProgressError
          || error instanceof CompanyContentNotFoundError
          || error instanceof CompanyContentVersionConflictError) {
        throw error;
      }
      return translateContentWriteError(error);
    }
  }

  async decideApproval(
    context: DatabaseRequestContext,
    command: DecideCompanyContentApprovalCommand,
  ): Promise<DecideCompanyContentApprovalResult> {
    validateCompanyContentUserContext(context);
    const input = normalizeApprovalDecisionCommand(command);
    const requestHash = companyContentRequestHash(context, DECIDE_APPROVAL, input);
    try {
      return await this.dependencies.transactionRunner.run(context, async (transaction) => {
        const repository = new CompanyContentPgRepository(transaction);
        const at = this.#now().toISOString();
        const claim = await repository.claimCommand({
          id: this.#nextId(),
          commandName: DECIDE_APPROVAL,
          commandKey: input.commandKey,
          requestId: context.requestId,
          payloadHash: requestHash,
          createdAt: at,
        });
        if (!hashesEqual(claim.payloadHash, requestHash)) {
          throw new CompanyContentIdempotencyConflictError();
        }
        if (!claim.inserted) {
          if (claim.status === 'succeeded') return replay(claim.result, approvalDecisionResult);
          throw new CompanyContentCommandInProgressError();
        }

        const request = await repository.lockApprovalRequest(input.approvalRequestId);
        if (!request) throw new CompanyContentNotFoundError('Company content approval request');
        if (!request.isLatest) throw new CompanyContentVersionConflictError();
        if (request.decision !== null) {
          throw new CompanyContentApprovalConflictError(
            'Company content approval request already has a decision',
          );
        }
        const approvalDecisionId = this.#nextId();
        await repository.insertApprovalDecision({
          id: approvalDecisionId,
          request,
          decision: input.decision,
          decisionNote: input.decisionNote,
          actorUserId: actorUserId(context),
          requestId: context.requestId,
          decidedAt: at,
        });
        const result = Object.freeze<DecideCompanyContentApprovalResult>({
          disposition: 'applied',
          approvalDecisionId,
          approvalRequestId: request.approvalRequestId,
          contentItemId: request.contentItemId,
          contentVersionId: request.contentVersionId,
          decision: input.decision,
          contentSha256: request.contentSha256,
        });
        await repository.completeCommand({
          receiptId: claim.id,
          payloadHash: requestHash,
          result: { ...result },
          completedAt: at,
        });
        return result;
      }, { readOnly: false, serializable: true });
    } catch (error) {
      if (error instanceof CompanyContentIdempotencyConflictError
          || error instanceof CompanyContentCommandInProgressError
          || error instanceof CompanyContentNotFoundError
          || error instanceof CompanyContentVersionConflictError
          || error instanceof CompanyContentApprovalConflictError) {
        throw error;
      }
      return translateContentWriteError(error);
    }
  }

  async listVersionApprovalStates(
    context: DatabaseRequestContext,
    contentItemId: string,
  ): Promise<CompanyContentVersionApprovalState[]> {
    validateCompanyContentUserContext(context);
    if (!UUID.test(contentItemId)) {
      throw new CompanyContentValidationError('contentItemId must be a UUID');
    }
    return this.dependencies.transactionRunner.run(context, async (transaction) => {
      const repository = new CompanyContentPgRepository(transaction);
      return repository.listVersionApprovalStates(contentItemId.toLowerCase());
    }, { readOnly: true });
  }

  async listCatalog(
    context: DatabaseRequestContext,
    query: CompanyContentCatalogQuery = {},
  ): Promise<CompanyContentCatalogPage> {
    validateCompanyContentUserContext(context);
    const limit = query.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new CompanyContentValidationError('Catalog limit must be an integer from 1 to 100');
    }
    const cursor = query.cursor ?? null;
    if (cursor !== null) {
      if (!cursor || typeof cursor !== 'object'
          || typeof cursor.beforeCreatedAt !== 'string'
          || !Number.isFinite(new Date(cursor.beforeCreatedAt).getTime())
          || !UUID.test(cursor.beforeVersionId)) {
        throw new CompanyContentValidationError('Catalog cursor is invalid');
      }
    }
    return this.dependencies.transactionRunner.run(context, async (transaction) => {
      const repository = new CompanyContentPgRepository(transaction);
      const loaded = await repository.listCatalog({
        limit: limit + 1,
        cursor: cursor === null ? null : Object.freeze({
          beforeCreatedAt: cursor.beforeCreatedAt,
          beforeVersionId: cursor.beforeVersionId.toLowerCase(),
        }),
      });
      const hasMore = loaded.length > limit;
      const items = Object.freeze(loaded.slice(0, limit));
      const finalItem = items.at(-1);
      return Object.freeze({
        items,
        nextCursor: hasMore && finalItem ? Object.freeze({
          beforeCreatedAt: finalItem.createdAt,
          beforeVersionId: finalItem.contentVersionId,
        }) : null,
      });
    }, { readOnly: true });
  }
}
