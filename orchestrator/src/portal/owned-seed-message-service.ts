import type {
  CreateOwnedSeedMessageDraftCommand,
  CreateOwnedSeedMessageDraftResult,
  DecideOwnedSeedMessageApprovalCommand,
  DecideOwnedSeedMessageApprovalResult,
  RequestOwnedSeedMessageApprovalCommand,
  RequestOwnedSeedMessageApprovalResult,
  ResumeOwnedSeedMessageCommand,
  ResumeOwnedSeedMessageResult,
} from '../property-predator-owned-seed-message-pg/index.js';

export interface PortalOwnedSeedMessageIdentity {
  readonly sessionToken: string;
  readonly requestId: string;
}

export type PortalOwnedSeedMessageFailure = Readonly<{
  readonly ok: false;
  readonly kind: 'unauthenticated' | 'forbidden' | 'validation' | 'conflict' | 'unavailable';
  readonly message: string;
}>;

export type PortalCreateOwnedSeedMessageDraftOutcome =
  | Readonly<{ readonly ok: true; readonly result: CreateOwnedSeedMessageDraftResult }>
  | PortalOwnedSeedMessageFailure;
export type PortalRequestOwnedSeedMessageApprovalOutcome =
  | Readonly<{ readonly ok: true; readonly result: RequestOwnedSeedMessageApprovalResult }>
  | PortalOwnedSeedMessageFailure;
export type PortalDecideOwnedSeedMessageApprovalOutcome =
  | Readonly<{ readonly ok: true; readonly result: DecideOwnedSeedMessageApprovalResult }>
  | PortalOwnedSeedMessageFailure;
export type PortalResumeOwnedSeedMessageOutcome =
  | Readonly<{ readonly ok: true; readonly result: ResumeOwnedSeedMessageResult | null }>
  | PortalOwnedSeedMessageFailure;

/**
 * Browser-safe command boundary. The database resolves the fixed office seed,
 * exact source copy and lifecycle evidence; no method can send or stage a job.
 */
export interface PortalOwnedSeedMessageService {
  resume(
    identity: PortalOwnedSeedMessageIdentity,
    input: ResumeOwnedSeedMessageCommand,
  ): Promise<PortalResumeOwnedSeedMessageOutcome>;
  createDraft(
    identity: PortalOwnedSeedMessageIdentity,
    input: CreateOwnedSeedMessageDraftCommand,
  ): Promise<PortalCreateOwnedSeedMessageDraftOutcome>;
  requestApproval(
    identity: PortalOwnedSeedMessageIdentity,
    input: RequestOwnedSeedMessageApprovalCommand,
  ): Promise<PortalRequestOwnedSeedMessageApprovalOutcome>;
  decideApproval(
    identity: PortalOwnedSeedMessageIdentity,
    input: DecideOwnedSeedMessageApprovalCommand,
  ): Promise<PortalDecideOwnedSeedMessageApprovalOutcome>;
}
