import type { Pool } from 'pg';
import type { DatabaseRequestContext } from '../db/rls.js';

export const PROPERTY_PREDATOR_OWNED_SEED_MESSAGE_EMAIL =
  'office@propertypredator.com' as const;

export interface CreateOwnedSeedMessageDraftCommand {
  readonly commandKey: string;
  readonly companyContentVersionId: string;
}

export interface ResumeOwnedSeedMessageCommand {
  readonly companyContentVersionId: string;
}

export interface RequestOwnedSeedMessageApprovalCommand {
  readonly commandKey: string;
  readonly messageId: string;
  readonly reviewNote?: string | null;
}

export interface DecideOwnedSeedMessageApprovalCommand {
  readonly commandKey: string;
  readonly approvalRequestId: string;
  readonly decision: 'approved' | 'rejected' | 'changes_requested';
  readonly decisionNote?: string | null;
}

export interface OwnedSeedMessageDigestEvidence {
  readonly subjectSha256: string;
  readonly bodySha256: string;
  readonly sourceContentSha256: string;
  readonly recipient: typeof PROPERTY_PREDATOR_OWNED_SEED_MESSAGE_EMAIL;
  readonly providerEffects: false;
}

export interface CreateOwnedSeedMessageDraftResult extends OwnedSeedMessageDigestEvidence {
  readonly disposition: 'created' | 'replayed';
  readonly messageId: string;
  readonly messageVersionId: string;
  readonly companyContentVersionId: string;
  readonly companyContentApprovalDecisionId: string;
  /** State written by this command; a replay does not claim it is still current. */
  readonly lifecycleAtCommand: 'draft';
}

export interface RequestOwnedSeedMessageApprovalResult extends OwnedSeedMessageDigestEvidence {
  readonly disposition: 'requested' | 'replayed';
  readonly messageId: string;
  readonly messageVersionId: string;
  readonly approvalRequestId: string;
  /** State written by this command; a replay does not claim it is still current. */
  readonly lifecycleAtCommand: 'approval_pending';
}

export interface DecideOwnedSeedMessageApprovalResult extends OwnedSeedMessageDigestEvidence {
  readonly disposition: 'decided' | 'replayed';
  readonly messageId: string;
  readonly messageVersionId: string;
  readonly approvalRequestId: string;
  readonly approvalDecisionId: string;
  readonly decision: 'approved' | 'rejected' | 'changes_requested';
  /** State written by this command; a replay does not claim it is still current. */
  readonly lifecycleAtCommand: 'approved' | 'draft';
}

export interface ResumeOwnedSeedMessageResult {
  readonly messageId: string;
  readonly messageVersionId: string;
  readonly companyContentVersionId: string;
  readonly phase: 'drafted' | 'approval_pending' | 'approved' | 'staged';
  readonly approvalRequestId: string | null;
  readonly subjectSha256: string;
  readonly bodySha256: string;
  readonly sourceContentSha256: string;
  readonly recipient: typeof PROPERTY_PREDATOR_OWNED_SEED_MESSAGE_EMAIL;
}

export interface PropertyPredatorOwnedSeedMessageRepository {
  createDraft(
    context: DatabaseRequestContext,
    command: CreateOwnedSeedMessageDraftCommand,
  ): Promise<CreateOwnedSeedMessageDraftResult>;
  requestApproval(
    context: DatabaseRequestContext,
    command: RequestOwnedSeedMessageApprovalCommand,
  ): Promise<RequestOwnedSeedMessageApprovalResult>;
  decideApproval(
    context: DatabaseRequestContext,
    command: DecideOwnedSeedMessageApprovalCommand,
  ): Promise<DecideOwnedSeedMessageApprovalResult>;
  resume(
    context: DatabaseRequestContext,
    command: ResumeOwnedSeedMessageCommand,
  ): Promise<ResumeOwnedSeedMessageResult | null>;
  assertReady(): Promise<void>;
}

export interface PropertyPredatorOwnedSeedMessageServiceDependencies {
  readonly commandPool: Pick<Pool, 'connect'>;
  readonly workspaceId: string;
}

export class PropertyPredatorOwnedSeedMessageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PropertyPredatorOwnedSeedMessageValidationError';
  }
}

export class PropertyPredatorOwnedSeedMessageConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PropertyPredatorOwnedSeedMessageConflictError';
  }
}
