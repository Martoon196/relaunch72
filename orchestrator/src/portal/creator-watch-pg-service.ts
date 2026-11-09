import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { requestDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { InactivePortalSessionError, withTransaction } from '../db/transaction.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';
import {
  createPgPortalCrmPrincipalResolver,
  type PortalCrmPrincipal,
  type PortalCrmPrincipalResolver,
} from './crm-pg-service.js';
import {
  CREATOR_WATCH_MESSAGE_FAMILY_LIMIT_PER_CHANNEL,
  CREATOR_WATCH_QUEUE_LIMIT,
  type CreatorWatchAuthoritativeSnapshot,
  type CreatorWatchCommandOutcome,
  type CreatorWatchCommentPurpose,
  type CreatorWatchDecision,
  type CreatorWatchFailureKind,
  type CreatorWatchMessageFamily,
  type CreatorWatchNetwork,
  type CreatorWatchNoCommentReason,
  type CreatorWatchQueueRow,
  type CreatorWatchRelevanceInput,
  type CreatorWatchReviewState,
  type CreatorWatchSnapshotOutcome,
  type PortalCreatorWatchService,
} from './creator-watch-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const KEY = /^[a-z][a-z0-9_.-]{0,99}$/u;
const COMMAND_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

const NETWORKS = new Set<CreatorWatchNetwork>(['linkedin', 'instagram']);
const CHANNELS = new Set<CreatorWatchMessageFamily['channel']>([
  'linkedin', 'instagram', 'other_social',
]);
const PURPOSES = new Set<CreatorWatchMessageFamily['purpose']>([
  'cold_first_touch', 'reply_follow_up', 'authority_comment', 'comment_to_dm',
]);
const LAPS_STAGES = new Set<CreatorWatchMessageFamily['lapsStage']>([
  'prospect', 'lead', 'pitch', 'appointment',
]);
const NEXT_ACTIONS = new Set<CreatorWatchMessageFamily['nextAction']>([
  'open_conversation', 'reply', 'book_call', 'visit_demo', 'download',
]);
const CONTEXT_FIELDS = new Set<CreatorWatchMessageFamily['allowedContextFields'][number]>([
  'post_topic', 'role', 'company', 'observed_problem',
  'relationship_context', 'campaign_context',
]);
const TONES = new Set<CreatorWatchMessageFamily['toneVariant']>([
  'founder_direct', 'helpful_expert', 'curious_peer', 'evidence_led',
]);
const COMMENT_PURPOSES = new Set<CreatorWatchCommentPurpose>([
  'add_useful_evidence', 'extend_the_idea', 'ask_sharp_question',
  'offer_counterpoint', 'open_genuine_conversation',
]);
const NO_COMMENT_REASONS = new Set<CreatorWatchNoCommentReason>([
  'irrelevant', 'insufficient_context', 'no_useful_contribution',
  'cooldown_active', 'frequency_cap', 'stale_evidence', 'subject_paused',
  'unsupported_action', 'policy_blocked',
]);

function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
      || CONTROL_CHARACTERS.test(value)) {
    throw new Error(`Creator Watch ${label} is invalid`);
  }
  return value;
}

function nullableText(value: unknown, label: string, maximum = 512): string | null {
  return value === null ? null : text(value, label, maximum);
}

function uuid(value: unknown, label: string): string {
  const selected = text(value, label, 36).toLowerCase();
  if (!UUID.test(selected)) throw new Error(`Creator Watch ${label} is invalid`);
  return selected;
}

function hash(value: unknown, label: string): string {
  const selected = text(value, label, 64).toLowerCase();
  if (!SHA256.test(selected)) throw new Error(`Creator Watch ${label} is invalid`);
  return selected;
}

function key(value: unknown, label: string): string {
  const selected = text(value, label, 100);
  if (!KEY.test(selected)) throw new Error(`Creator Watch ${label} is invalid`);
  return selected;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, label: string): T {
  const selected = text(value, label, 64) as T;
  if (!allowed.has(selected)) throw new Error(`Creator Watch ${label} is invalid`);
  return selected;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  const selected = typeof value === 'string' && /^\d{1,10}$/u.test(value)
    ? Number(value) : value;
  if (typeof selected !== 'number' || !Number.isSafeInteger(selected)
      || selected < minimum || selected > maximum) {
    throw new Error(`Creator Watch ${label} is invalid`);
  }
  return selected;
}

function instant(value: unknown, label: string): string {
  const selected = value instanceof Date ? value : new Date(text(value, label, 64));
  if (!Number.isFinite(selected.getTime())) throw new Error(`Creator Watch ${label} is invalid`);
  return selected.toISOString();
}

function nullableInstant(value: unknown, label: string): string | null {
  return value === null ? null : instant(value, label);
}

function nullableUuid(value: unknown, label: string): string | null {
  return value === null ? null : uuid(value, label);
}

function uniqueContextFields(value: unknown): CreatorWatchMessageFamily['allowedContextFields'] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) {
    throw new Error('Creator Watch allowed context fields are invalid');
  }
  const parsed = value.map((field) => enumValue(
    field, CONTEXT_FIELDS, 'allowed context field',
  ));
  if (new Set(parsed).size !== parsed.length) {
    throw new Error('Creator Watch allowed context fields are duplicated');
  }
  return Object.freeze(parsed);
}

interface MessageFamilyRow extends QueryResultRow {
  messageFamilyVersionId: unknown;
  familyKey: unknown;
  versionNumber: unknown;
  programmeVersionId: unknown;
  channel: unknown;
  purpose: unknown;
  lapsStage: unknown;
  audienceSegmentKey: unknown;
  nextAction: unknown;
  allowedContextFields: unknown;
  toneVariant: unknown;
  cooldownSeconds: unknown;
  maxPerCreatorPerUtcDay: unknown;
  maxPerChannelPerUtcDay: unknown;
  maxPerCreatorRolling7Days: unknown;
  configurationSha256: unknown;
  contentVersionId: unknown;
  contentSha256: unknown;
  effectiveFrom: unknown;
  effectiveUntil: unknown;
  executionState: unknown;
}

interface QueueRow extends QueryResultRow {
  observedPostId: unknown;
  subjectVersionId: unknown;
  subjectKey: unknown;
  subjectVersionNumber: unknown;
  network: unknown;
  sourceKind: unknown;
  providerPostRefSha256: unknown;
  sourceReferenceSha256: unknown;
  postContentSha256: unknown;
  observedAt: unknown;
  expiresAt: unknown;
  latestRelevanceDecisionId: unknown;
  relevanceDecision: unknown;
  commentPurpose: unknown;
  noCommentReason: unknown;
  commentAssignmentId: unknown;
  effectState: unknown;
  cooldownUntil: unknown;
  creatorDayCount: unknown;
  creatorWeekCount: unknown;
  maxCommentsPerUtcDay: unknown;
  maxCommentsRolling7Days: unknown;
}

interface RelevanceRow extends QueryResultRow {
  disposition: unknown;
  relevanceDecisionId: unknown;
}

interface AssignmentRow extends QueryResultRow {
  disposition: unknown;
  commentAssignmentId: unknown;
  effectState: unknown;
  cooldownUntil: unknown;
}

interface ReplayRow extends QueryResultRow {
  disposition: unknown;
  observedPostId: unknown;
  previousDecisionId: unknown;
  decision: unknown;
  commentPurpose: unknown;
  noCommentReason: unknown;
  decisionSource: unknown;
  relevanceDecisionId: unknown;
  decidedByUserId: unknown;
  messageFamilyVersionId: unknown;
  commentAssignmentId: unknown;
  assignedByUserId: unknown;
  effectState: unknown;
}

const MESSAGE_FAMILY_SQL = `/* portal.creator-watch.message-families */
  SELECT message_family_version_id AS "messageFamilyVersionId",
         family_key AS "familyKey", version_number AS "versionNumber",
         programme_version_id AS "programmeVersionId", channel, purpose,
         laps_stage AS "lapsStage", audience_segment_key AS "audienceSegmentKey",
         next_action AS "nextAction", allowed_context_fields AS "allowedContextFields",
         tone_variant AS "toneVariant", cooldown_seconds AS "cooldownSeconds",
         max_per_creator_per_utc_day AS "maxPerCreatorPerUtcDay",
         max_per_channel_per_utc_day AS "maxPerChannelPerUtcDay",
         max_per_creator_rolling_7_days AS "maxPerCreatorRolling7Days",
         encode(configuration_sha256, 'hex') AS "configurationSha256",
         content_version_id AS "contentVersionId",
         encode(content_sha256, 'hex') AS "contentSha256",
         effective_from AS "effectiveFrom", effective_until AS "effectiveUntil",
         execution_state AS "executionState"
  FROM app_private.read_daily_outreach_message_families($1, $2)
  LIMIT $3`;

const QUEUE_SQL = `/* portal.creator-watch.queue */
  SELECT observed_post_id AS "observedPostId",
         subject_version_id AS "subjectVersionId", subject_key AS "subjectKey",
         subject_version_number AS "subjectVersionNumber", network,
         source_kind AS "sourceKind",
         encode(provider_post_ref_sha256, 'hex') AS "providerPostRefSha256",
         encode(source_reference_sha256, 'hex') AS "sourceReferenceSha256",
         encode(post_content_sha256, 'hex') AS "postContentSha256",
         observed_at AS "observedAt", expires_at AS "expiresAt",
         latest_relevance_decision_id AS "latestRelevanceDecisionId",
         relevance_decision AS "relevanceDecision",
         comment_purpose AS "commentPurpose", no_comment_reason AS "noCommentReason",
         comment_assignment_id AS "commentAssignmentId", effect_state AS "effectState",
         cooldown_until AS "cooldownUntil", creator_day_count AS "creatorDayCount",
         creator_week_count AS "creatorWeekCount",
         max_comments_per_utc_day AS "maxCommentsPerUtcDay",
         max_comments_rolling_7_days AS "maxCommentsRolling7Days"
  FROM app_private.read_daily_outreach_creator_watch_queue($1, $2)`;

function parseFamily(row: MessageFamilyRow, requestedChannel: CreatorWatchNetwork): CreatorWatchMessageFamily {
  const channel = enumValue(row.channel, CHANNELS, 'message-family channel');
  if (channel !== requestedChannel) {
    throw new Error('Creator Watch message-family channel crossed its read boundary');
  }
  const maxPerDay = integer(row.maxPerCreatorPerUtcDay, 'creator daily cap', 1, 10);
  const maxPerWeek = integer(row.maxPerCreatorRolling7Days, 'creator weekly cap', 1, 50);
  if (maxPerDay > maxPerWeek) throw new Error('Creator Watch message-family caps are inconsistent');
  const effectiveFrom = instant(row.effectiveFrom, 'message-family effective-from');
  const effectiveUntil = nullableInstant(row.effectiveUntil, 'message-family effective-until');
  if (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) {
    throw new Error('Creator Watch message-family effective window is invalid');
  }
  return Object.freeze({
    id: uuid(row.messageFamilyVersionId, 'message-family id'),
    familyKey: key(row.familyKey, 'message-family key'),
    versionNumber: integer(row.versionNumber, 'message-family version', 1, 1_000_000),
    programmeVersionId: uuid(row.programmeVersionId, 'programme version id'),
    channel,
    purpose: enumValue(row.purpose, PURPOSES, 'message-family purpose'),
    lapsStage: enumValue(row.lapsStage, LAPS_STAGES, 'message-family LAPS stage'),
    audienceSegmentKey: key(row.audienceSegmentKey, 'audience segment key'),
    nextAction: enumValue(row.nextAction, NEXT_ACTIONS, 'message-family next action'),
    allowedContextFields: uniqueContextFields(row.allowedContextFields),
    toneVariant: enumValue(row.toneVariant, TONES, 'message-family tone'),
    cooldownSeconds: integer(row.cooldownSeconds, 'message-family cooldown', 3_600, 7_776_000),
    maxPerCreatorPerUtcDay: maxPerDay,
    maxPerChannelPerUtcDay: integer(row.maxPerChannelPerUtcDay, 'channel daily cap', 1, 250),
    maxPerCreatorRolling7Days: maxPerWeek,
    configurationSha256: hash(row.configurationSha256, 'configuration hash'),
    contentVersionId: uuid(row.contentVersionId, 'content version id'),
    contentSha256: hash(row.contentSha256, 'content hash'),
    effectiveFrom,
    effectiveUntil,
    executionState: enumValue(
      row.executionState,
      new Set(['approved_review_only'] as const),
      'message-family execution state',
    ),
  });
}

function reviewState(input: Readonly<{
  nowMs: number;
  expiresAt: string;
  relevanceDecision: CreatorWatchDecision | null;
  commentAssignmentId: string | null;
  creatorDayCount: number;
  creatorWeekCount: number;
  maxCommentsPerUtcDay: number;
  maxCommentsRolling7Days: number;
}>): CreatorWatchReviewState {
  if (input.commentAssignmentId) return 'comment_assigned_review_only';
  if (input.relevanceDecision === 'no_comment') return 'no_comment_recorded';
  if (Date.parse(input.expiresAt) <= input.nowMs) return 'expired';
  if (input.creatorDayCount >= input.maxCommentsPerUtcDay
      || input.creatorWeekCount >= input.maxCommentsRolling7Days) {
    return 'frequency_cap_reached';
  }
  if (input.relevanceDecision === 'comment') return 'comment_selected_awaiting_assignment';
  return 'awaiting_decision';
}

function parseQueueRow(row: QueueRow, nowMs: number): CreatorWatchQueueRow {
  const latestRelevanceDecisionId = nullableUuid(
    row.latestRelevanceDecisionId, 'latest relevance decision id',
  );
  const relevanceDecision = row.relevanceDecision === null ? null : enumValue(
    row.relevanceDecision,
    new Set<CreatorWatchDecision>(['comment', 'no_comment']),
    'relevance decision',
  );
  const commentPurpose = row.commentPurpose === null ? null : enumValue(
    row.commentPurpose, COMMENT_PURPOSES, 'comment purpose',
  );
  const noCommentReason = row.noCommentReason === null ? null : enumValue(
    row.noCommentReason, NO_COMMENT_REASONS, 'no-comment reason',
  );
  const commentAssignmentId = nullableUuid(row.commentAssignmentId, 'comment assignment id');
  const effectState = enumValue(
    row.effectState,
    new Set(['unassigned_review_only', 'review_only'] as const),
    'effect state',
  );
  if ((latestRelevanceDecisionId === null) !== (relevanceDecision === null)
      || (relevanceDecision === 'comment' && (!commentPurpose || noCommentReason !== null))
      || (relevanceDecision === 'no_comment' && (commentPurpose !== null || !noCommentReason))
      || (relevanceDecision === null && (commentPurpose !== null || noCommentReason !== null))
      || (commentAssignmentId !== null && relevanceDecision !== 'comment')
      || (commentAssignmentId === null) !== (effectState === 'unassigned_review_only')) {
    throw new Error('Creator Watch queue evidence is inconsistent');
  }
  const observedAt = instant(row.observedAt, 'post observed-at');
  const expiresAt = instant(row.expiresAt, 'post expiry');
  const creatorDayCount = integer(row.creatorDayCount, 'creator day count', 0, 1_000_000);
  const creatorWeekCount = integer(row.creatorWeekCount, 'creator week count', 0, 1_000_000);
  const maxCommentsPerUtcDay = integer(row.maxCommentsPerUtcDay, 'creator daily cap', 1, 10);
  const maxCommentsRolling7Days = integer(row.maxCommentsRolling7Days, 'creator weekly cap', 1, 50);
  if (creatorDayCount > creatorWeekCount || maxCommentsPerUtcDay > maxCommentsRolling7Days) {
    throw new Error('Creator Watch queue counters are inconsistent');
  }
  const cooldownUntil = nullableInstant(row.cooldownUntil, 'cooldown-until');
  if (Date.parse(expiresAt) <= Date.parse(observedAt)
      || (commentAssignmentId === null) !== (cooldownUntil === null)) {
    throw new Error('Creator Watch post window or cooldown evidence is inconsistent');
  }
  return Object.freeze({
    observedPostId: uuid(row.observedPostId, 'observed post id'),
    subjectVersionId: uuid(row.subjectVersionId, 'subject version id'),
    subjectKey: key(row.subjectKey, 'subject key'),
    subjectVersionNumber: integer(row.subjectVersionNumber, 'subject version', 1, 1_000_000),
    network: enumValue(row.network, NETWORKS, 'network'),
    sourceKind: enumValue(
      row.sourceKind,
      new Set(['official_provider_event', 'operator_supplied_reference'] as const),
      'source kind',
    ),
    providerPostRefSha256: hash(row.providerPostRefSha256, 'provider-post hash'),
    sourceReferenceSha256: hash(row.sourceReferenceSha256, 'source-reference hash'),
    postContentSha256: hash(row.postContentSha256, 'post-content hash'),
    observedAt,
    expiresAt,
    latestRelevanceDecisionId,
    relevanceDecision,
    commentPurpose,
    noCommentReason,
    commentAssignmentId,
    effectState,
    cooldownUntil,
    creatorDayCount,
    creatorWeekCount,
    maxCommentsPerUtcDay,
    maxCommentsRolling7Days,
    reviewState: reviewState({ nowMs, expiresAt, relevanceDecision, commentAssignmentId,
      creatorDayCount, creatorWeekCount, maxCommentsPerUtcDay, maxCommentsRolling7Days }),
    cooldownActive: cooldownUntil !== null && Date.parse(cooldownUntil) > nowMs,
    requiresHumanApproval: true,
    autonomousCommentEnabled: false,
    providerEffectsEnabled: false,
  });
}

function context(
  identity: PortalCrmRequestIdentity,
  principal: PortalCrmPrincipal,
): DatabaseRequestContext {
  return requestDatabaseContext({
    ...principal,
    requestId: identity.requestId,
    portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest(),
  });
}

function digest(...parts: readonly string[]): Buffer {
  const selected = createHash('sha256');
  for (const part of parts) selected.update(part).update('\0');
  return selected.digest();
}

function postgresCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof (error as { readonly code?: unknown }).code === 'string'
    ? (error as { readonly code: string }).code : null;
}

function failure(kind: CreatorWatchFailureKind, message: string) {
  return Object.freeze({ ok: false as const, kind, message });
}

function commandFailure(error: unknown): CreatorWatchCommandOutcome {
  if (error instanceof InactivePortalSessionError) {
    return failure('unauthenticated', 'This portal session is no longer active.');
  }
  const code = postgresCode(error);
  if (code === '42501') return failure('forbidden', 'Your workspace role cannot review that Creator Watch item.');
  if (code === '23503') return failure('not_found', 'That Creator Watch evidence is no longer available.');
  if (['23505', '23514', '40001', '55000', '55P03'].includes(code ?? '')) {
    return failure('conflict', 'That Creator Watch item changed, expired or is no longer reviewable. Refresh the queue.');
  }
  if (code?.startsWith('22') || code === '54000') {
    return failure('validation', 'That review choice is invalid or a bounded frequency cap has been reached.');
  }
  return failure('unavailable', 'Creator Watch could not save the review safely. No comment or provider action was triggered.');
}

export interface PgPortalCreatorWatchDependencies {
  readonly principalResolver: Pick<PortalCrmPrincipalResolver, 'resolve'>;
  readonly readPool: Pick<Pool, 'connect'>;
  readonly commandPool?: Pick<Pool, 'connect'>;
  readonly now?: () => number;
}

export class PgPortalCreatorWatchService implements PortalCreatorWatchService {
  private readonly now: () => number;

  constructor(private readonly dependencies: PgPortalCreatorWatchDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  private async principal(identity: PortalCrmRequestIdentity): Promise<PortalCrmPrincipal | null> {
    return this.dependencies.principalResolver.resolve(identity.sessionToken);
  }

  private async replay(
    databaseContext: DatabaseRequestContext,
    principal: PortalCrmPrincipal,
    input: CreatorWatchRelevanceInput,
    commandKeySha: Buffer,
  ): Promise<CreatorWatchCommandOutcome | null> {
    if (!this.dependencies.commandPool) return null;
    return withTransaction(
      this.dependencies.commandPool,
      databaseContext,
      async (transaction) => {
        const result = await transaction.query<ReplayRow>(
          `/* portal.creator-watch.resolve-command-replay */
           SELECT disposition,
                  observed_post_id AS "observedPostId",
                  previous_decision_id AS "previousDecisionId",
                  decision, comment_purpose AS "commentPurpose",
                  no_comment_reason AS "noCommentReason",
                  decision_source AS "decisionSource",
                  relevance_decision_id AS "relevanceDecisionId",
                  decided_by_user_id AS "decidedByUserId",
                  message_family_version_id AS "messageFamilyVersionId",
                  comment_assignment_id AS "commentAssignmentId",
                  assigned_by_user_id AS "assignedByUserId",
                  effect_state AS "effectState"
           FROM app_private.resolve_daily_outreach_creator_watch_replay($1,$2)`,
          [principal.workspaceId, commandKeySha],
        );
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) {
          throw new Error('Creator Watch replay resolved incorrectly');
        }
        const row = result.rows[0]!;
        const disposition = enumValue(
          row.disposition, new Set(['replayed'] as const), 'replay disposition',
        );
        const observedPostId = uuid(row.observedPostId, 'replay observed post id');
        const previousDecisionId = nullableUuid(
          row.previousDecisionId, 'replay previous decision id',
        );
        const decision = enumValue(
          row.decision, new Set<CreatorWatchDecision>(['comment', 'no_comment']),
          'replay decision',
        );
        const commentPurpose = row.commentPurpose === null ? null : enumValue(
          row.commentPurpose, COMMENT_PURPOSES, 'replay comment purpose',
        );
        const noCommentReason = row.noCommentReason === null ? null : enumValue(
          row.noCommentReason, NO_COMMENT_REASONS, 'replay no-comment reason',
        );
        const decisionSource = enumValue(
          row.decisionSource,
          new Set(['human_review', 'brand_brain_assist'] as const),
          'replay decision source',
        );
        const relevanceDecisionId = uuid(
          row.relevanceDecisionId, 'replay relevance decision id',
        );
        const decidedByUserId = uuid(row.decidedByUserId, 'replay deciding user id');
        const messageFamilyVersionId = nullableUuid(
          row.messageFamilyVersionId, 'replay message-family id',
        );
        const commentAssignmentId = nullableUuid(
          row.commentAssignmentId, 'replay comment assignment id',
        );
        const assignedByUserId = nullableUuid(
          row.assignedByUserId, 'replay assigning user id',
        );
        const effectState = row.effectState === null ? null : enumValue(
          row.effectState, new Set(['review_only'] as const), 'replay effect state',
        );
        const stableIntentMatches = observedPostId === input.observedPostId.toLowerCase()
          && previousDecisionId === (input.previousDecisionId?.toLowerCase() ?? null)
          && decision === input.decision
          && commentPurpose === input.commentPurpose
          && noCommentReason === input.noCommentReason
          && decisionSource === 'human_review'
          && decidedByUserId === principal.userId.toLowerCase();
        const receiptShapeMatches = decision === 'comment'
          ? messageFamilyVersionId !== null && commentAssignmentId !== null
            && assignedByUserId === principal.userId.toLowerCase()
            && effectState === 'review_only'
          : messageFamilyVersionId === null && commentAssignmentId === null
            && assignedByUserId === null && effectState === null;
        if (!stableIntentMatches || !receiptShapeMatches) {
          return failure(
            'conflict',
            'That command key has already been used for another Creator Watch review.',
          );
        }
        return Object.freeze({
          ok: true as const,
          disposition,
          relevanceDecisionId,
          messageFamilyVersionId,
          commentAssignmentId,
          effectState: 'review_only' as const,
        });
      },
      { readOnly: true, isolation: 'read committed' },
    );
  }

  private async load(
    databaseContext: DatabaseRequestContext,
    principal: PortalCrmPrincipal,
  ): Promise<CreatorWatchAuthoritativeSnapshot> {
    const nowMs = this.now();
    return withTransaction(this.dependencies.readPool, databaseContext, async (transaction) => {
      const families: CreatorWatchMessageFamily[] = [];
      for (const channel of ['linkedin', 'instagram'] as const) {
        const result = await transaction.query<MessageFamilyRow>(MESSAGE_FAMILY_SQL, [
          principal.workspaceId, channel, CREATOR_WATCH_MESSAGE_FAMILY_LIMIT_PER_CHANNEL + 1,
        ]);
        if (result.rows.length > CREATOR_WATCH_MESSAGE_FAMILY_LIMIT_PER_CHANNEL) {
          throw new Error('Creator Watch message-family result exceeds its bounded limit');
        }
        families.push(...result.rows.map((row) => parseFamily(row, channel)));
      }
      if (new Set(families.map((family) => family.id)).size !== families.length
          || new Set(families.map((family) => family.familyKey)).size !== families.length) {
        throw new Error('Creator Watch message-family identities are duplicated');
      }
      const queueResult = await transaction.query<QueueRow>(QUEUE_SQL, [
        principal.workspaceId, CREATOR_WATCH_QUEUE_LIMIT,
      ]);
      if (queueResult.rows.length > CREATOR_WATCH_QUEUE_LIMIT) {
        throw new Error('Creator Watch queue exceeds its bounded limit');
      }
      const queue = queueResult.rows.map((row) => parseQueueRow(row, nowMs));
      if (new Set(queue.map((item) => item.observedPostId)).size !== queue.length) {
        throw new Error('Creator Watch observed-post identities are duplicated');
      }
      return Object.freeze({
        schemaVersion: 1 as const,
        dataset: 'postgres_authoritative' as const,
        snapshotAt: new Date(nowMs).toISOString(),
        workspace: Object.freeze({ id: principal.workspaceId.toLowerCase() }),
        messageFamilies: Object.freeze(families),
        queue: Object.freeze(queue),
        commandBoundaryAvailable: Boolean(this.dependencies.commandPool),
        reviewMode: 'one_tap_review' as const,
        requiresHumanApproval: true as const,
        autonomousCommentEnabled: false as const,
        providerEffectsEnabled: false as const,
        externalEffects: false as const,
      });
    }, { readOnly: true, isolation: 'repeatable read' });
  }

  async snapshot(identity: PortalCrmRequestIdentity): Promise<CreatorWatchSnapshotOutcome> {
    try {
      const principal = await this.principal(identity);
      if (!principal) return failure('unauthenticated', 'This portal session is no longer active.');
      return Object.freeze({
        ok: true as const,
        snapshot: await this.load(context(identity, principal), principal),
      });
    } catch (error) {
      if (error instanceof InactivePortalSessionError) {
        return failure('unauthenticated', 'This portal session is no longer active.');
      }
      if (postgresCode(error) === '42501') {
        return failure('forbidden', 'Creator Watch is not available to this workspace role.');
      }
      return failure('unavailable', 'The authoritative Creator Watch queue is temporarily unavailable.');
    }
  }

  async recordRelevance(
    identity: PortalCrmRequestIdentity,
    input: CreatorWatchRelevanceInput,
  ): Promise<CreatorWatchCommandOutcome> {
    try {
      if (!this.dependencies.commandPool) {
        return failure('unavailable', 'The Creator Watch human-review boundary is not installed.');
      }
      if (!UUID.test(input.observedPostId) || !COMMAND_KEY.test(input.commandKey)
          || (input.previousDecisionId !== null && !UUID.test(input.previousDecisionId))
          || !['comment', 'no_comment'].includes(input.decision)
          || (input.decision === 'comment'
            && (!input.commentPurpose || !COMMENT_PURPOSES.has(input.commentPurpose)
              || input.noCommentReason !== null))
          || (input.decision === 'no_comment'
            && (input.commentPurpose !== null || !input.noCommentReason
              || !NO_COMMENT_REASONS.has(input.noCommentReason)))) {
        return failure('validation', 'That Creator Watch review choice is invalid.');
      }
      const principal = await this.principal(identity);
      if (!principal) return failure('unauthenticated', 'This portal session is no longer active.');
      const databaseContext = context(identity, principal);
      const commandKeySha = digest(
        'propertypredator.creator-watch-command/v1', input.commandKey,
      );
      const replay = await this.replay(
        databaseContext, principal, input, commandKeySha,
      );
      if (replay) return replay;
      const snapshot = await this.load(databaseContext, principal);
      const observedPostId = input.observedPostId.toLowerCase();
      const previousDecisionId = input.previousDecisionId?.toLowerCase() ?? null;
      const selected = snapshot.queue.find((item) => (
        item.observedPostId === observedPostId
      ));
      if (!selected || selected.commentAssignmentId !== null
          || selected.latestRelevanceDecisionId !== previousDecisionId) {
        return failure('conflict', 'That Creator Watch review chain changed. Refresh the queue.');
      }
      if (input.decision === 'comment'
          && ['expired', 'frequency_cap_reached'].includes(selected.reviewState)) {
        return failure('conflict', 'That post is expired or frequency-capped and cannot receive a comment decision.');
      }
      const assignmentFamily = input.decision === 'comment'
        ? snapshot.messageFamilies.filter((family) => (
          family.channel === selected.network && family.purpose === 'authority_comment'
        ))
        : [];
      if (input.decision === 'comment' && assignmentFamily.length !== 1) {
        return failure(
          'conflict',
          assignmentFamily.length === 0
            ? 'No current approved comment family is available for that network.'
            : 'More than one approved comment family is active for that network. A manager must leave exactly one active family before one-tap assignment.',
        );
      }
      const selectedFamily = assignmentFamily[0] ?? null;
      const grounding = digest(
        'propertypredator.creator-watch-grounding/v1', principal.workspaceId,
        selected.observedPostId, selected.subjectVersionId,
        selected.sourceReferenceSha256, selected.postContentSha256,
      );
      const decisionEvidence = digest(
        'propertypredator.creator-watch-human-review/v1', principal.workspaceId,
        principal.userId, input.commandKey, selected.observedPostId,
        previousDecisionId ?? '', input.decision, input.commentPurpose ?? '',
        input.noCommentReason ?? '', grounding.toString('hex'),
      );
      return await withTransaction(
        this.dependencies.commandPool,
        databaseContext,
        async (transaction) => {
          const result = await transaction.query<RelevanceRow>(
            `/* portal.creator-watch.record-human-relevance */
             SELECT disposition,
                    relevance_decision_id AS "relevanceDecisionId"
             FROM app_private.record_daily_outreach_creator_watch_relevance(
               $1,$2,$3,$4,$5,$6,'human_review',$7,$8,$9
             )`,
            [principal.workspaceId, selected.observedPostId,
              previousDecisionId, input.decision, input.commentPurpose,
              input.noCommentReason, grounding, decisionEvidence, commandKeySha],
          );
          if (result.rows.length !== 1) {
            throw new Error('Creator Watch relevance command returned incorrectly');
          }
           const row = result.rows[0]!;
           const disposition = enumValue(
             row.disposition, new Set(['recorded', 'replayed'] as const),
             'relevance disposition',
           );
           const relevanceDecisionId = uuid(
             row.relevanceDecisionId, 'relevance decision id',
           );
           if (selectedFamily === null) {
             return Object.freeze({
               ok: true as const,
               disposition,
               relevanceDecisionId,
               messageFamilyVersionId: null,
               commentAssignmentId: null,
               effectState: 'review_only' as const,
             });
           }
           const assignmentEvidence = digest(
             'propertypredator.creator-watch-review-assignment/v1',
             principal.workspaceId, principal.userId, input.commandKey,
             selected.observedPostId, relevanceDecisionId, selectedFamily.id,
             selectedFamily.configurationSha256, selectedFamily.contentSha256,
             input.commentPurpose ?? '', grounding.toString('hex'),
           );
           const assignmentCommandKey = digest(
             'propertypredator.creator-watch-assignment-command/v1', input.commandKey,
           );
           const assignmentResult = await transaction.query<AssignmentRow>(
             `/* portal.creator-watch.assign-approved-review-family */
              SELECT disposition,
                     comment_assignment_id AS "commentAssignmentId",
                     effect_state AS "effectState",
                     cooldown_until AS "cooldownUntil"
              FROM app_private.assign_current_daily_outreach_creator_watch_comment(
                $1,$2,$3,$4,$5,$6
              )`,
             [principal.workspaceId, selected.observedPostId, relevanceDecisionId,
               selectedFamily.id, assignmentEvidence, assignmentCommandKey],
           );
           if (assignmentResult.rows.length !== 1) {
             throw new Error('Creator Watch assignment command returned incorrectly');
           }
           const assignment = assignmentResult.rows[0]!;
           enumValue(
             assignment.disposition, new Set(['recorded', 'replayed'] as const),
             'assignment disposition',
           );
           enumValue(
             assignment.effectState, new Set(['review_only'] as const),
             'assignment effect state',
           );
           instant(assignment.cooldownUntil, 'assignment cooldown-until');
           return Object.freeze({
             ok: true as const,
             disposition,
             relevanceDecisionId,
             messageFamilyVersionId: selectedFamily.id,
             commentAssignmentId: uuid(
               assignment.commentAssignmentId, 'comment assignment id',
             ),
             effectState: 'review_only' as const,
           });
        },
        { isolation: 'read committed' },
      );
    } catch (error) {
      return commandFailure(error);
    }
  }
}

export async function assertCreatorWatchReadBoundaryReady(
  pool: Pick<Pool, 'query'>,
): Promise<void> {
  const result = await pool.query<{ ready: boolean }>(
    `/* portal.creator-watch.read-role-readiness */
     SELECT current_user = 'r72_daily_outreach_read'
        AND pg_catalog.has_function_privilege(
          current_user,
          'app_private.read_daily_outreach_message_families(uuid,text)',
          'EXECUTE'
        )
        AND pg_catalog.has_function_privilege(
          current_user,
          'app_private.read_daily_outreach_creator_watch_queue(uuid,smallint)',
          'EXECUTE'
        )
        AND NOT pg_catalog.has_function_privilege(
          current_user,
          'app_private.record_daily_outreach_creator_watch_relevance(uuid,uuid,uuid,text,text,text,text,bytea,bytea,bytea)',
          'EXECUTE'
        ) AS ready`,
  );
  if (result.rows.length !== 1 || result.rows[0]?.ready !== true) {
    throw new Error('Creator Watch read boundary is incomplete');
  }
}

export async function assertCreatorWatchCommandBoundaryReady(
  pool: Pick<Pool, 'query'>,
): Promise<void> {
  const result = await pool.query<{ ready: boolean }>(
    `/* portal.creator-watch.command-role-readiness */
     SELECT current_user = 'r72_daily_outreach_command'
        AND pg_catalog.has_function_privilege(
          current_user,
          'app_private.record_daily_outreach_creator_watch_relevance(uuid,uuid,uuid,text,text,text,text,bytea,bytea,bytea)',
          'EXECUTE'
        )
         AND pg_catalog.has_function_privilege(
           current_user,
           'app_private.assign_current_daily_outreach_creator_watch_comment(uuid,uuid,uuid,uuid,bytea,bytea)',
           'EXECUTE'
         )
         AND pg_catalog.has_function_privilege(
           current_user,
           'app_private.resolve_daily_outreach_creator_watch_replay(uuid,bytea)',
           'EXECUTE'
         )
         AND NOT pg_catalog.has_function_privilege(
           current_user,
           'app_private.assign_daily_outreach_creator_watch_comment(uuid,uuid,uuid,uuid,uuid,uuid,bytea,uuid,uuid,bytea,bytea)',
           'EXECUTE'
         )
        AND NOT pg_catalog.has_function_privilege(
          current_user,
          'app_private.read_daily_outreach_creator_watch_queue(uuid,smallint)',
          'EXECUTE'
        ) AS ready`,
  );
  if (result.rows.length !== 1 || result.rows[0]?.ready !== true) {
    throw new Error('Creator Watch command boundary is incomplete');
  }
}

export function createPgPortalCreatorWatchService(input: Readonly<{
  webPool: Pick<Pool, 'query'>;
  readPool: Pick<Pool, 'connect'>;
  commandPool?: Pick<Pool, 'connect'>;
  now?: () => number;
}>): PgPortalCreatorWatchService {
  return new PgPortalCreatorWatchService({
    principalResolver: createPgPortalCrmPrincipalResolver(input.webPool),
    readPool: input.readPool,
    ...(input.commandPool ? { commandPool: input.commandPool } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
}
