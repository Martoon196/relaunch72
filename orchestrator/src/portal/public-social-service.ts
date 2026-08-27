import type { SocialNetwork } from '../providers/contracts.js';
import type {
  CancelSocialCampaignTargetResult,
  CreateSocialCampaignRevisionCommand,
  CreateSocialCampaignRevisionResult,
  RegisterSocialCampaignTestTargetResult,
  SocialCampaignApprovedMediaBinding,
  SocialCampaignCalendarProjectionPage,
  SocialCampaignCommandProjectionPage,
  ScheduleSocialCampaignResult,
} from '../social-campaign-pg/index.js';

/** Opaque browser identity; workspace and actor identity are always session-resolved. */
export interface PortalPublicSocialRequestIdentity {
  readonly sessionToken: string;
  readonly requestId: string;
}

export interface PortalPublicSocialWorkspaceAccess {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly timezone: string;
  readonly snapshotAt: string;
  readonly canManage: boolean;
}

export interface PortalPublicSocialSnapshotInput {
  /** Omit for the all-campaign calendar; provide for a campaign command projection. */
  readonly campaignId?: string | null;
  readonly from: string;
  readonly to: string;
  readonly limit?: number;
}

/** Safe read model: it cannot contain post bodies, account refs or blob storage keys. */
export interface PortalPublicSocialSnapshot {
  readonly workspace: PortalPublicSocialWorkspaceAccess;
  readonly campaign: SocialCampaignCommandProjectionPage;
  readonly calendar: SocialCampaignCalendarProjectionPage;
  readonly environment: 'test';
  readonly providerEffects: 'none';
}

export type PortalCreatePublicSocialRevisionInput = Omit<
  CreateSocialCampaignRevisionCommand,
  'workspaceId' | 'revisionSha256'
>;

/** The reserved TEST account reference is derived server-side and never crosses the browser boundary. */
export interface PortalRegisterPublicSocialTestTargetInput {
  readonly targetId: string;
  readonly connectionId: string;
  readonly network: SocialNetwork;
  readonly displayName: string;
}

export interface PortalPublicSocialScheduleTargetInput {
  readonly targetId: string;
}

/**
 * Browser-safe plan material. The server seals the plan and derives logical
 * target ids plus reserved account refs; callers cannot submit either value.
 * The body is write-only and is never returned by this service.
 */
export interface PortalSchedulePublicSocialCampaignInput {
  readonly postId: string;
  readonly campaignId: string;
  readonly revisionId: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly approvalRequestId: string;
  readonly approvalDecisionId: string;
  readonly sourceAttestationId: string;
  readonly text: string;
  /** TEST-only 0039 boundary: must be earlier than every exact source attestation expiry. */
  /**
   * Must remain inside every exact source-attestation expiry. Current source
   * proofs last at most 15 minutes; long-dated delivery needs a future audited
   * just-in-time re-attestation workflow rather than silently reusing stale proof.
   */
  readonly scheduledFor: string;
  readonly maxAttempts: number;
  readonly targets: readonly PortalPublicSocialScheduleTargetInput[];
  readonly mediaBindings: readonly SocialCampaignApprovedMediaBinding[];
}

export interface PortalCancelPublicSocialTargetInput {
  readonly operationId: string;
  readonly reason: string;
}

export type PortalPublicSocialFailureKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'unavailable';

export interface PortalPublicSocialFailure {
  readonly ok: false;
  readonly kind: PortalPublicSocialFailureKind;
  /** Safe copy only. PostgreSQL, body and provider details never cross this boundary. */
  readonly message: string;
}

export type PortalPublicSocialSnapshotOutcome =
  | { readonly ok: true; readonly snapshot: PortalPublicSocialSnapshot }
  | PortalPublicSocialFailure;

export type PortalPublicSocialCommandOutcome<TResult> =
  | {
      readonly ok: true;
      readonly result: TResult;
      readonly environment: 'test';
      readonly providerEffects: 'none';
    }
  | PortalPublicSocialFailure;

export interface PortalPublicSocialService {
  snapshot(
    identity: PortalPublicSocialRequestIdentity,
    input: PortalPublicSocialSnapshotInput,
  ): Promise<PortalPublicSocialSnapshotOutcome>;

  createRevision(
    identity: PortalPublicSocialRequestIdentity,
    input: PortalCreatePublicSocialRevisionInput,
  ): Promise<PortalPublicSocialCommandOutcome<CreateSocialCampaignRevisionResult>>;

  registerTestTarget(
    identity: PortalPublicSocialRequestIdentity,
    input: PortalRegisterPublicSocialTestTargetInput,
  ): Promise<PortalPublicSocialCommandOutcome<RegisterSocialCampaignTestTargetResult>>;

  schedule(
    identity: PortalPublicSocialRequestIdentity,
    input: PortalSchedulePublicSocialCampaignInput,
  ): Promise<PortalPublicSocialCommandOutcome<ScheduleSocialCampaignResult>>;

  cancelTarget(
    identity: PortalPublicSocialRequestIdentity,
    input: PortalCancelPublicSocialTargetInput,
  ): Promise<PortalPublicSocialCommandOutcome<CancelSocialCampaignTargetResult>>;
}
