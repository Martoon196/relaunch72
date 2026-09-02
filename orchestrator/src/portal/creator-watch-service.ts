import type { PortalCrmRequestIdentity } from './crm-service.js';

export const CREATOR_WATCH_QUEUE_LIMIT = 24;
export const CREATOR_WATCH_MESSAGE_FAMILY_LIMIT_PER_CHANNEL = 32;
export const CREATOR_WATCH_RELEVANCE_ROUTE = '/portal/outreach/daily/creator-watch/relevance';

export type CreatorWatchNetwork = 'linkedin' | 'instagram';
export type CreatorWatchDecision = 'comment' | 'no_comment';
export type CreatorWatchCommentPurpose =
  | 'add_useful_evidence'
  | 'extend_the_idea'
  | 'ask_sharp_question'
  | 'offer_counterpoint'
  | 'open_genuine_conversation';
export type CreatorWatchNoCommentReason =
  | 'irrelevant'
  | 'insufficient_context'
  | 'no_useful_contribution'
  | 'cooldown_active'
  | 'frequency_cap'
  | 'stale_evidence'
  | 'subject_paused'
  | 'unsupported_action'
  | 'policy_blocked';

export interface CreatorWatchMessageFamily {
  readonly id: string;
  readonly familyKey: string;
  readonly versionNumber: number;
  readonly programmeVersionId: string;
  readonly channel: CreatorWatchNetwork | 'other_social';
  readonly purpose: 'cold_first_touch' | 'reply_follow_up' | 'authority_comment' | 'comment_to_dm';
  readonly lapsStage: 'prospect' | 'lead' | 'pitch' | 'appointment';
  readonly audienceSegmentKey: string;
  readonly nextAction: 'open_conversation' | 'reply' | 'book_call' | 'visit_demo' | 'download';
  readonly allowedContextFields: readonly (
    | 'post_topic'
    | 'role'
    | 'company'
    | 'observed_problem'
    | 'relationship_context'
    | 'campaign_context'
  )[];
  readonly toneVariant: 'founder_direct' | 'helpful_expert' | 'curious_peer' | 'evidence_led';
  readonly cooldownSeconds: number;
  readonly maxPerCreatorPerUtcDay: number;
  readonly maxPerChannelPerUtcDay: number;
  readonly maxPerCreatorRolling7Days: number;
  readonly configurationSha256: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly executionState: 'approved_review_only';
}

export type CreatorWatchReviewState =
  | 'awaiting_decision'
  | 'comment_selected_awaiting_assignment'
  | 'no_comment_recorded'
  | 'comment_assigned_review_only'
  | 'frequency_cap_reached'
  | 'expired';

export interface CreatorWatchQueueRow {
  readonly observedPostId: string;
  readonly subjectVersionId: string;
  readonly subjectKey: string;
  readonly subjectVersionNumber: number;
  readonly network: CreatorWatchNetwork;
  readonly sourceKind: 'official_provider_event' | 'operator_supplied_reference';
  readonly providerPostRefSha256: string;
  readonly sourceReferenceSha256: string;
  readonly postContentSha256: string;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly latestRelevanceDecisionId: string | null;
  readonly relevanceDecision: CreatorWatchDecision | null;
  readonly commentPurpose: CreatorWatchCommentPurpose | null;
  readonly noCommentReason: CreatorWatchNoCommentReason | null;
  readonly commentAssignmentId: string | null;
  readonly effectState: 'unassigned_review_only' | 'review_only';
  readonly cooldownUntil: string | null;
  readonly creatorDayCount: number;
  readonly creatorWeekCount: number;
  readonly maxCommentsPerUtcDay: number;
  readonly maxCommentsRolling7Days: number;
  readonly reviewState: CreatorWatchReviewState;
  readonly cooldownActive: boolean;
  readonly requiresHumanApproval: true;
  readonly autonomousCommentEnabled: false;
  readonly providerEffectsEnabled: false;
}

export interface CreatorWatchAuthoritativeSnapshot {
  readonly schemaVersion: 1;
  readonly dataset: 'postgres_authoritative';
  readonly snapshotAt: string;
  readonly workspace: Readonly<{ id: string }>;
  readonly messageFamilies: readonly CreatorWatchMessageFamily[];
  readonly queue: readonly CreatorWatchQueueRow[];
  readonly commandBoundaryAvailable: boolean;
  readonly reviewMode: 'one_tap_review';
  readonly requiresHumanApproval: true;
  readonly autonomousCommentEnabled: false;
  readonly providerEffectsEnabled: false;
  readonly externalEffects: false;
}

export type CreatorWatchFailureKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'unavailable';

export type CreatorWatchSnapshotOutcome =
  | Readonly<{ ok: true; snapshot: CreatorWatchAuthoritativeSnapshot }>
  | Readonly<{ ok: false; kind: CreatorWatchFailureKind; message: string }>;

export interface CreatorWatchRelevanceInput {
  readonly observedPostId: string;
  readonly previousDecisionId: string | null;
  readonly decision: CreatorWatchDecision;
  readonly commentPurpose: CreatorWatchCommentPurpose | null;
  readonly noCommentReason: CreatorWatchNoCommentReason | null;
  readonly commandKey: string;
}

export type CreatorWatchCommandOutcome =
  | Readonly<{
    ok: true;
    disposition: 'recorded' | 'replayed';
    relevanceDecisionId: string;
    messageFamilyVersionId: string | null;
    commentAssignmentId: string | null;
    effectState: 'review_only';
  }>
  | Readonly<{ ok: false; kind: CreatorWatchFailureKind; message: string }>;

export interface PortalCreatorWatchService {
  snapshot(identity: PortalCrmRequestIdentity): Promise<CreatorWatchSnapshotOutcome>;
  recordRelevance(
    identity: PortalCrmRequestIdentity,
    input: CreatorWatchRelevanceInput,
  ): Promise<CreatorWatchCommandOutcome>;
}

export const CREATOR_WATCH_INTEGRATION_CONTRACT = Object.freeze({
  readFunctions: Object.freeze([
    'app_private.read_daily_outreach_message_families(uuid,text)',
    'app_private.read_daily_outreach_creator_watch_queue(uuid,smallint)',
  ]),
  humanReviewCommand:
    'app_private.record_daily_outreach_creator_watch_relevance(uuid,uuid,uuid,text,text,text,text,bytea,bytea,bytea)',
  replayCommand:
    'app_private.resolve_daily_outreach_creator_watch_replay(uuid,bytea)',
  serverResolvedAssignment:
    'app_private.assign_current_daily_outreach_creator_watch_comment(uuid,uuid,uuid,uuid,bytea,bytea)',
  assignmentRequirement:
    'Exactly one current approved authority-comment family must exist for the network. Exact content and approval evidence is resolved behind the command boundary; the browser cannot supply it.',
  providerEffects: false,
  autonomousComments: false,
} as const);
