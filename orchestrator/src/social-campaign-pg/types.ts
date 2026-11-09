import type { SocialNetwork } from '../providers/contracts.js';
import type { PublicSocialDarkPlan } from '../social-dark/contracts.js';

export const PUBLIC_SOCIAL_TEST_PROVIDER_ID = 'public_social_dark_simulator' as const;

export type SocialCampaignDisposition = 'applied' | 'replayed';
export type SocialCampaignTargetState =
  | 'waiting_for_test_time'
  | 'leased'
  | 'calling_simulator'
  | 'retry_wait'
  | 'simulated_succeeded'
  | 'simulated_failed'
  | 'simulated_cancelled'
  | 'reconciliation_required'
  | 'simulated_reconciled'
  | 'dead_letter';

/** Durable, browser-visible state of one target on a planning intent. */
export type SocialPlanningState =
  | 'awaiting_revalidation'
  | 'revalidation_leased'
  | 'proof_ready'
  | 'materialized'
  | 'cancelled'
  | 'superseded'
  | 'revalidation_attention';

/** Internal JIT source-check state. It is projected only as bounded status copy. */
export type SocialRevalidationState =
  | 'waiting_for_window'
  | 'leased'
  | 'retry_wait'
  | 'verified'
  | 'materialized'
  | 'dead_letter';

export interface CreateSocialCampaignRevisionCommand {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly previousRevisionId: string | null;
  readonly title: string;
  readonly objective: string;
  readonly timezone: string;
  /** SHA-256 of the caller's immutable canonical campaign revision. */
  readonly revisionSha256: string;
}

export interface CreateSocialCampaignRevisionResult {
  readonly campaignId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly disposition: SocialCampaignDisposition;
}

export interface RegisterSocialCampaignTestTargetCommand {
  readonly workspaceId: string;
  readonly targetId: string;
  readonly connectionId: string;
  readonly network: SocialNetwork;
  /** Reserved non-routable reference; never returned by read projections. */
  readonly testAccountRef: string;
  readonly displayName: string;
}

export interface RegisterSocialCampaignTestTargetResult {
  readonly targetId: string;
  readonly disposition: SocialCampaignDisposition;
}

/** Command-role truth used to seal a plan without trusting browser target labels. */
export interface ResolvedSocialCampaignTestTarget {
  readonly targetId: string;
  readonly network: SocialNetwork;
  /** Reserved non-routable reference; never returned by portal read projections. */
  readonly testAccountRef: string;
}

export interface SocialCampaignTargetBinding {
  /** PostgreSQL target UUID. */
  readonly targetId: string;
  /** Exact logical target id sealed into the dark plan. */
  readonly planTargetId: string;
}

export interface SocialCampaignApprovedMediaBinding {
  /** Exact artifact id sealed into the dark plan. */
  readonly planArtifactId: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly blobSha256: string;
  readonly approvalRequestId: string;
  readonly approvalDecisionId: string;
  readonly sourceAttestationId: string;
}

export interface ScheduleSocialCampaignCommand {
  readonly workspaceId: string;
  readonly postId: string;
  readonly campaignId: string;
  readonly revisionId: string;
  readonly contentItemId: string;
  readonly approvalRequestId: string;
  readonly approvalDecisionId: string;
  readonly sourceAttestationId: string;
  readonly targetBindings: readonly SocialCampaignTargetBinding[];
  readonly mediaBindings: readonly SocialCampaignApprovedMediaBinding[];
  /**
   * Revalidated at this boundary; PostgreSQL independently binds its evidence.
   * Migration 0039 rejects a schedule beyond any exact source-attestation expiry.
   */
  readonly plan: PublicSocialDarkPlan;
}

export interface ScheduleSocialCampaignResult {
  readonly postId: string;
  readonly operationIds: readonly string[];
  readonly disposition: SocialCampaignDisposition;
}

export interface CancelSocialCampaignTargetCommand {
  readonly workspaceId: string;
  readonly operationId: string;
  /** Hashed before crossing the SQL boundary. */
  readonly reason: string;
}

export interface CancelSocialCampaignTargetResult {
  readonly operationId: string;
  readonly state: SocialCampaignTargetState;
  readonly disposition: SocialCampaignDisposition;
}

/**
 * A durable TEST planning command. The caller selects immutable identities;
 * PostgreSQL resolves body, hashes, approvals, attestations and connections.
 */
export interface PlanSocialCampaignIntentCommand {
  readonly workspaceId: string;
  readonly intentId: string;
  readonly campaignId: string;
  readonly revisionId: string;
  readonly contentVersionId: string;
  readonly desiredFor: string;
  readonly maxAttempts: number;
  readonly targetIds: readonly string[];
  readonly mediaVersionIds: readonly string[];
}

export interface PlanSocialCampaignIntentResult {
  readonly intentId: string;
  readonly intentSha256: string;
  readonly disposition: SocialCampaignDisposition;
}

export interface RescheduleSocialPlanningTargetCommand {
  readonly workspaceId: string;
  readonly predecessorIntentId: string;
  readonly targetId: string;
  readonly successorIntentId: string;
  readonly newDesiredFor: string;
  /** Plain safe operator copy; only its SHA-256 crosses into PostgreSQL. */
  readonly reason: string;
}

export interface RescheduleSocialPlanningTargetResult {
  readonly successorIntentId: string;
  readonly disposition: SocialCampaignDisposition;
}

export interface CancelSocialPlanningTargetCommand {
  readonly workspaceId: string;
  readonly intentId: string;
  readonly targetId: string;
  /** Plain safe operator copy; only its SHA-256 crosses into PostgreSQL. */
  readonly reason: string;
}

export interface CancelSocialPlanningTargetResult {
  readonly intentId: string;
  readonly targetId: string;
  readonly state: 'cancelled';
  readonly disposition: SocialCampaignDisposition;
}

/**
 * Worker-only claim command for the bounded just-in-time source check. The raw
 * lease token is hashed before it crosses the PostgreSQL function boundary.
 */
export interface ClaimSocialPlanningRevalidationsCommand {
  readonly workerId: string;
  readonly leaseToken: Uint8Array;
  readonly batchSize?: number;
  readonly leaseSeconds?: number;
}

/** Exact immutable source tuple that a trusted adapter must re-attest. */
export interface SocialPlanningRevalidationMediaMaterial {
  readonly ordinal: number;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly sourceSystem: string;
  readonly sourceItemId: string;
  readonly sourceVersion: string;
  readonly contentSha256: string;
  readonly blobSha256: string;
  readonly brandSha256: string;
}

/**
 * Worker-only JIT material. It is deliberately not part of any portal DTO or
 * browser projection.
 */
export interface SocialPlanningRevalidationClaim {
  readonly jobId: string;
  readonly workspaceId: string;
  readonly intentId: string;
  readonly leaseVersion: number;
  readonly desiredFor: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly sourceSystem: string;
  readonly sourceItemId: string;
  readonly sourceVersion: string;
  readonly contentSha256: string;
  readonly blobSha256: string;
  readonly brandSha256: string;
  readonly media: readonly SocialPlanningRevalidationMediaMaterial[];
}

export interface CompleteSocialPlanningRevalidationCommand {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly workerId: string;
  readonly leaseToken: Uint8Array;
  readonly leaseVersion: number;
  readonly proofId: string;
  readonly contentAttestationId: string;
  /** Ordered exactly like the claimed media ordinals. */
  readonly mediaAttestationIds: readonly string[];
}

export interface CompleteSocialPlanningRevalidationResult {
  readonly proofId: string;
  readonly state: 'verified';
  readonly disposition: SocialCampaignDisposition;
}

export interface FailSocialPlanningRevalidationCommand {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly workerId: string;
  readonly leaseToken: Uint8Array;
  readonly leaseVersion: number;
  readonly errorCode: string;
  readonly retryable: boolean;
}

export interface FailSocialPlanningRevalidationResult {
  readonly jobId: string;
  readonly state: 'retry_wait' | 'dead_letter';
}

export interface MaterializeSocialPlanningIntentCommand {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly proofId: string;
  readonly postId: string;
}

export interface MaterializeSocialPlanningIntentResult {
  readonly postId: string;
  readonly operationIds: readonly string[];
  readonly disposition: SocialCampaignDisposition;
}

/** Safe wizard option. Provider connection and TEST account references are omitted. */
export interface SocialPlannerTargetProjection {
  readonly targetId: string;
  readonly network: SocialNetwork;
  readonly targetLabel: string;
  readonly environment: 'test';
  readonly providerEffects: 'none';
}

/**
 * Safe durable calendar row. It exposes identities and bounded state only: no
 * content body, approval/attestation ids, connection ids, account refs or blob keys.
 */
export interface SocialPlanningCalendarProjection {
  readonly intentId: string;
  readonly campaignId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly campaignTitle: string;
  readonly desiredFor: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly intentSha256: string;
  readonly targetId: string;
  readonly network: SocialNetwork;
  readonly targetLabel: string;
  readonly planningState: SocialPlanningState;
  readonly materializedPostId: string | null;
  readonly materializedOperationId: string | null;
  readonly operationState: SocialCampaignTargetState | null;
  readonly revalidationState: SocialRevalidationState | null;
  readonly nextRevalidationAt: string | null;
  readonly lastErrorCode: string | null;
  readonly updatedAt: string;
  readonly environment: 'test';
  readonly providerEffects: 'none';
}

/** Safe campaign projection. It contains no credentials, account references or post body. */
export interface SocialCampaignCommandProjection {
  readonly campaignId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly revisionSha256: string;
  readonly title: string;
  readonly objective: string;
  readonly timezone: string;
  readonly postId: string | null;
  readonly contentItemId: string | null;
  readonly contentVersionId: string | null;
  readonly contentSha256: string | null;
  readonly planSha256: string | null;
  readonly scheduledFor: string | null;
  readonly operationId: string | null;
  readonly targetId: string | null;
  readonly network: SocialNetwork | null;
  readonly targetLabel: string | null;
  readonly state: SocialCampaignTargetState | null;
  readonly simulationAttemptCount: number | null;
  readonly maxSimulationAttempts: number | null;
  readonly reconciliationAttemptCount: number | null;
  readonly maxReconciliationAttempts: number | null;
  readonly testReferenceSha256: string | null;
  readonly environment: 'test';
  readonly providerEffects: 'none';
}

/** Safe calendar projection. It deliberately omits body text and provider/test account refs. */
export interface SocialCampaignCalendarProjection {
  readonly campaignId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly campaignTitle: string;
  readonly postId: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly planSha256: string;
  readonly scheduledFor: string;
  readonly operationId: string;
  readonly targetId: string;
  readonly network: SocialNetwork;
  readonly targetLabel: string;
  readonly state: SocialCampaignTargetState;
  readonly simulationAttemptCount: number;
  readonly maxSimulationAttempts: number;
  readonly reconciliationAttemptCount: number;
  readonly maxReconciliationAttempts: number;
  readonly updatedAt: string;
  readonly environment: 'test';
  readonly providerEffects: 'none';
}

/**
 * A bounded safe-read page. `hasMore` is database-proven by reading one row
 * beyond the public bound; callers must never treat `items` as a complete set
 * when it is true.
 */
export interface SocialCampaignProjectionPage<TProjection> {
  readonly items: readonly TProjection[];
  readonly hasMore: boolean;
}

export type SocialCampaignCommandProjectionPage = SocialCampaignProjectionPage<
  SocialCampaignCommandProjection
>;

export type SocialCampaignCalendarProjectionPage = SocialCampaignProjectionPage<
  SocialCampaignCalendarProjection
>;

export type SocialPlannerTargetProjectionPage = SocialCampaignProjectionPage<
  SocialPlannerTargetProjection
>;

export type SocialPlanningCalendarProjectionPage = SocialCampaignProjectionPage<
  SocialPlanningCalendarProjection
>;

export type PublicSocialTestAttemptKind = 'simulation' | 'reconcile';

export interface PublicSocialTestLeaseIdentity {
  readonly workerId: string;
  /** Raw 32-byte worker secret. Only its SHA-256 crosses into PostgreSQL. */
  readonly leaseToken: Uint8Array;
}

export interface PublicSocialTestClaim {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly postId: string;
  readonly targetId: string;
  readonly connectionId: string;
  readonly network: SocialNetwork;
  readonly environment: 'test';
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly attemptNumber: number;
  readonly leaseVersion: number;
  readonly leaseExpiresAt: string;
  readonly attemptKind: PublicSocialTestAttemptKind;
  readonly testReference: string | null;
}

export interface PublicSocialTestMediaEvidence {
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly blobStorageKey: string;
  readonly blobSha256: string;
  readonly mimeType: string;
}

/** Worker-only payload. The raw TEST account ref and body must never enter portal projections/logs. */
export interface PublicSocialTestDispatchPayload {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly connectionId: string;
  readonly providerId: typeof PUBLIC_SOCIAL_TEST_PROVIDER_ID;
  readonly postId: string;
  readonly targetId: string;
  readonly network: SocialNetwork;
  readonly testAccountRef: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly approvalDecisionId: string;
  readonly text: string;
  readonly bodySha256: string;
  readonly planSha256: string;
  readonly scheduledFor: string;
  readonly media: readonly PublicSocialTestMediaEvidence[];
}

export interface PublicSocialTestProviderContext {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly operationId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface PublicSocialTestProviderRequest {
  readonly targetId: string;
  readonly network: SocialNetwork;
  readonly testAccountRef: string;
  readonly text: string;
  readonly bodySha256: string;
  readonly planSha256: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly media: readonly PublicSocialTestMediaEvidence[];
}

export interface PublicSocialTestProviderResult {
  readonly status: 'succeeded' | 'failed' | 'needs_attention';
  readonly testReference: string | null;
  readonly occurredAt: string;
  readonly retryable: boolean;
  readonly errorCode: string | null;
  readonly summary: string;
  readonly externalPublishAttempted: false;
}

export interface PublicSocialTestProvider {
  simulate(
    context: PublicSocialTestProviderContext,
    request: PublicSocialTestProviderRequest,
  ): Promise<PublicSocialTestProviderResult>;
  reconcile(
    context: PublicSocialTestProviderContext,
    testReference: string | null,
  ): Promise<PublicSocialTestProviderResult>;
}

export interface PublicSocialTestSettlement {
  readonly operationId: string;
  readonly state: SocialCampaignTargetState;
  readonly completedAt: string | null;
}

export interface PublicSocialTestQueue {
  claim(
    lease: PublicSocialTestLeaseIdentity,
    options?: Readonly<{ batchSize?: number; leaseSeconds?: number }>,
  ): Promise<readonly PublicSocialTestClaim[]>;
  load(
    claim: PublicSocialTestClaim,
    lease: PublicSocialTestLeaseIdentity,
  ): Promise<PublicSocialTestDispatchPayload>;
  markCalling(
    claim: PublicSocialTestClaim,
    lease: PublicSocialTestLeaseIdentity,
  ): Promise<void>;
  renew(
    claim: PublicSocialTestClaim,
    lease: PublicSocialTestLeaseIdentity,
    leaseSeconds?: number,
  ): Promise<string>;
  settle(
    claim: PublicSocialTestClaim,
    lease: PublicSocialTestLeaseIdentity,
    result: PublicSocialTestProviderResult,
  ): Promise<PublicSocialTestSettlement>;
  reconcile(
    claim: PublicSocialTestClaim,
    lease: PublicSocialTestLeaseIdentity,
    result: PublicSocialTestProviderResult,
  ): Promise<PublicSocialTestSettlement>;
}

export interface PublicSocialTestDispatchCycleResult {
  readonly disposition: 'idle' | 'settled';
  readonly operationId: string | null;
  readonly state: SocialCampaignTargetState | null;
}

export class SocialCampaignPgContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocialCampaignPgContractError';
  }
}

export class PublicSocialTestLeaseLostError extends Error {
  constructor() {
    super('Public social TEST lease was lost');
    this.name = 'PublicSocialTestLeaseLostError';
  }
}
