import type {
  CancelSocialPlanningTargetResult,
  CreateSocialCampaignRevisionCommand,
  CreateSocialCampaignRevisionResult,
  PlanSocialCampaignIntentResult,
  RescheduleSocialPlanningTargetResult,
  SocialCampaignCalendarProjectionPage,
  SocialCampaignCommandProjectionPage,
  SocialPlannerTargetProjectionPage,
  SocialPlanningCalendarProjectionPage,
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
  /** Durable planner truth, including intents waiting for just-in-time source proof. */
  readonly planning?: Readonly<{
    readonly targets: SocialPlannerTargetProjectionPage;
    readonly calendar: SocialPlanningCalendarProjectionPage;
  }>;
  readonly environment: 'test';
  readonly providerEffects: 'none';
}

export type PortalCreatePublicSocialRevisionInput = Omit<
  CreateSocialCampaignRevisionCommand,
  'workspaceId' | 'revisionSha256'
>;

/** One browser command; revision and intent are committed or rolled back together. */
export interface PortalCreatePublicSocialCampaignPlanInput {
  readonly commandKey: string;
  readonly title: string;
  readonly objective: string;
  readonly contentVersionId: string;
  readonly desiredFor: string;
  readonly maxAttempts?: number;
  readonly targetIds: readonly string[];
  readonly mediaVersionIds: readonly string[];
}

export interface PortalCreatePublicSocialCampaignPlanResult {
  readonly campaignId: string;
  readonly revisionId: string;
  readonly intentId: string;
  readonly intentSha256: string;
  readonly disposition: 'applied' | 'replayed';
}

/**
 * Browser-safe planner input. It intentionally has no body, hash, approval,
 * attestation, provider connection, TEST account reference or storage key.
 */
export interface PortalPlanPublicSocialCampaignInput {
  readonly commandKey: string;
  readonly campaignId: string;
  readonly revisionId: string;
  readonly contentVersionId: string;
  readonly desiredFor: string;
  readonly maxAttempts: number;
  readonly targetIds: readonly string[];
  readonly mediaVersionIds: readonly string[];
}

export interface PortalReschedulePublicSocialTargetInput {
  readonly commandKey: string;
  readonly predecessorIntentId: string;
  readonly targetId: string;
  readonly newDesiredFor: string;
  readonly reason: string;
}

export interface PortalCancelPublicSocialPlanningTargetInput {
  readonly intentId: string;
  readonly targetId: string;
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

  createCampaignPlan?(
    identity: PortalPublicSocialRequestIdentity,
    input: PortalCreatePublicSocialCampaignPlanInput,
  ): Promise<PortalPublicSocialCommandOutcome<PortalCreatePublicSocialCampaignPlanResult>>;

  plan?(
    identity: PortalPublicSocialRequestIdentity,
    input: PortalPlanPublicSocialCampaignInput,
  ): Promise<PortalPublicSocialCommandOutcome<PlanSocialCampaignIntentResult>>;

  reschedule?(
    identity: PortalPublicSocialRequestIdentity,
    input: PortalReschedulePublicSocialTargetInput,
  ): Promise<PortalPublicSocialCommandOutcome<RescheduleSocialPlanningTargetResult>>;

  cancel?(
    identity: PortalPublicSocialRequestIdentity,
    input: PortalCancelPublicSocialPlanningTargetInput,
  ): Promise<PortalPublicSocialCommandOutcome<CancelSocialPlanningTargetResult>>;

  /** @deprecated Read-only route fixture compatibility; production has no such portal capability. */
  readonly registerTestTarget?: () => Promise<PortalPublicSocialCommandOutcome<never>>;
  /** @deprecated Read-only route fixture compatibility; planning never directly schedules a provider. */
  readonly schedule?: () => Promise<PortalPublicSocialCommandOutcome<never>>;
  /** @deprecated Read-only route fixture compatibility; cancel the planning target instead. */
  readonly cancelTarget?: () => Promise<PortalPublicSocialCommandOutcome<never>>;
}
