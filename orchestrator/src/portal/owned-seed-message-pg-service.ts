import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { InactivePortalSessionError } from '../db/transaction.js';
import {
  PropertyPredatorOwnedSeedMessageConflictError,
  PropertyPredatorOwnedSeedMessageValidationError,
  type CreateOwnedSeedMessageDraftCommand,
  type DecideOwnedSeedMessageApprovalCommand,
  type PropertyPredatorOwnedSeedMessageService,
  type RequestOwnedSeedMessageApprovalCommand,
  type ResumeOwnedSeedMessageCommand,
} from '../property-predator-owned-seed-message-pg/index.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipal,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';
import type {
  PortalCreateOwnedSeedMessageDraftOutcome,
  PortalDecideOwnedSeedMessageApprovalOutcome,
  PortalOwnedSeedMessageFailure,
  PortalOwnedSeedMessageIdentity,
  PortalOwnedSeedMessageService,
  PortalRequestOwnedSeedMessageApprovalOutcome,
  PortalResumeOwnedSeedMessageOutcome,
} from './owned-seed-message-service.js';

type CoreMessageService = Pick<PropertyPredatorOwnedSeedMessageService,
  'resume' | 'createDraft' | 'requestApproval' | 'decideApproval'>;

export interface PgPortalOwnedSeedMessageDependencies {
  readonly principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  readonly messages: CoreMessageService;
}

function context(
  identity: PortalOwnedSeedMessageIdentity,
  principal: PortalCrmPrincipal,
): DatabaseRequestContext {
  return requestDatabaseContext({
    ...principal,
    requestId: identity.requestId,
    portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest(),
  });
}

function failure(error: unknown): PortalOwnedSeedMessageFailure {
  if (error instanceof InactivePortalSessionError) return Object.freeze({
    ok: false, kind: 'unauthenticated', message: 'This portal session is no longer active.',
  });
  if (error instanceof PropertyPredatorOwnedSeedMessageValidationError) return Object.freeze({
    ok: false, kind: 'validation', message: 'The exact owned-seed message command was invalid. Nothing changed.',
  });
  if (error instanceof PropertyPredatorOwnedSeedMessageConflictError) return Object.freeze({
    ok: false, kind: 'conflict', message: 'The exact source or message changed. Refresh before continuing.',
  });
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { readonly code?: unknown }).code : undefined;
  if (code === '42501') return Object.freeze({
    ok: false, kind: 'forbidden', message: 'Owner or admin access is required for the owned-seed message.',
  });
  return Object.freeze({
    ok: false, kind: 'unavailable', message: 'The owned-seed message command could not complete safely. No provider call ran.',
  });
}

export class PgPortalOwnedSeedMessageService implements PortalOwnedSeedMessageService {
  constructor(private readonly dependencies: PgPortalOwnedSeedMessageDependencies) {}

  private async resolve(identity: PortalOwnedSeedMessageIdentity): Promise<DatabaseRequestContext | null> {
    const principal = await this.dependencies.principalResolver.resolve(identity.sessionToken);
    return principal ? context(identity, principal) : null;
  }

  async resume(
    identity: PortalOwnedSeedMessageIdentity,
    input: ResumeOwnedSeedMessageCommand,
  ): Promise<PortalResumeOwnedSeedMessageOutcome> {
    try {
      const request = await this.resolve(identity);
      if (!request) return Object.freeze({
        ok: false, kind: 'unauthenticated', message: 'This portal session is no longer active.',
      });
      return Object.freeze({
        ok: true,
        result: await this.dependencies.messages.resume(request, input),
      });
    } catch (error) { return failure(error); }
  }

  async createDraft(
    identity: PortalOwnedSeedMessageIdentity,
    input: CreateOwnedSeedMessageDraftCommand,
  ): Promise<PortalCreateOwnedSeedMessageDraftOutcome> {
    try {
      const request = await this.resolve(identity);
      if (!request) return Object.freeze({
        ok: false, kind: 'unauthenticated', message: 'This portal session is no longer active.',
      });
      return Object.freeze({ ok: true, result: await this.dependencies.messages.createDraft(request, input) });
    } catch (error) { return failure(error); }
  }

  async requestApproval(
    identity: PortalOwnedSeedMessageIdentity,
    input: RequestOwnedSeedMessageApprovalCommand,
  ): Promise<PortalRequestOwnedSeedMessageApprovalOutcome> {
    try {
      const request = await this.resolve(identity);
      if (!request) return Object.freeze({
        ok: false, kind: 'unauthenticated', message: 'This portal session is no longer active.',
      });
      return Object.freeze({ ok: true, result: await this.dependencies.messages.requestApproval(request, input) });
    } catch (error) { return failure(error); }
  }

  async decideApproval(
    identity: PortalOwnedSeedMessageIdentity,
    input: DecideOwnedSeedMessageApprovalCommand,
  ): Promise<PortalDecideOwnedSeedMessageApprovalOutcome> {
    try {
      const request = await this.resolve(identity);
      if (!request) return Object.freeze({
        ok: false, kind: 'unauthenticated', message: 'This portal session is no longer active.',
      });
      return Object.freeze({ ok: true, result: await this.dependencies.messages.decideApproval(request, input) });
    } catch (error) { return failure(error); }
  }
}

export function createPgPortalOwnedSeedMessageService(input: {
  readonly webPool: Pick<Pool, 'query' | 'connect'>;
  readonly messages: CoreMessageService;
}): PgPortalOwnedSeedMessageService {
  return new PgPortalOwnedSeedMessageService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    messages: input.messages,
  });
}
