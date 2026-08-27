import type { CompanyContentCatalogPage } from '../company-content-pg/types.js';
import type { SocialNetwork } from '../providers/contracts.js';
import type {
  SocialCampaignCalendarProjection,
  SocialCampaignTargetState,
  SocialPlanningCalendarProjection,
  SocialPlanningState,
  SocialRevalidationState,
} from '../social-campaign-pg/types.js';
import {
  CONTENT_CALENDAR_MAX_SLOTS,
  type ContentCalendarPlanningProvenance,
  type ContentCalendarPublicSocialChannel,
  type ContentCalendarPublicSocialProvenance,
  type ContentCalendarSlotSnapshot,
  type ContentCalendarSnapshot,
} from './content-calendar-presenter.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]+$/u;
const PUBLIC_SOCIAL_NETWORKS = new Set<SocialNetwork>([
  'facebook', 'instagram', 'linkedin', 'tiktok', 'x', 'youtube',
  'google_business_profile', 'threads', 'pinterest',
]);
const PUBLIC_SOCIAL_STATES = new Set<SocialCampaignTargetState>([
  'waiting_for_test_time', 'leased', 'calling_simulator', 'retry_wait',
  'simulated_succeeded', 'simulated_failed', 'simulated_cancelled',
  'reconciliation_required', 'simulated_reconciled', 'dead_letter',
]);
const PUBLIC_SOCIAL_PLANNING_STATES = new Set<SocialPlanningState>([
  'awaiting_revalidation', 'revalidation_leased', 'proof_ready', 'materialized',
  'cancelled', 'superseded', 'revalidation_attention',
]);
const PUBLIC_SOCIAL_REVALIDATION_STATES = new Set<SocialRevalidationState>([
  'waiting_for_window', 'leased', 'retry_wait', 'verified', 'materialized', 'dead_letter',
]);
const ALLOWED_PROJECTION_FIELDS = new Set<keyof SocialCampaignCalendarProjection>([
  'campaignId', 'revisionId', 'revisionNumber', 'campaignTitle', 'postId',
  'contentItemId', 'contentVersionId', 'contentSha256', 'planSha256',
  'scheduledFor', 'operationId', 'targetId', 'network', 'targetLabel', 'state',
  'simulationAttemptCount', 'maxSimulationAttempts',
  'reconciliationAttemptCount', 'maxReconciliationAttempts',
  'updatedAt', 'environment', 'providerEffects',
]);
const ALLOWED_PLANNING_FIELDS = new Set<keyof SocialPlanningCalendarProjection>([
  'intentId', 'campaignId', 'revisionId', 'revisionNumber', 'campaignTitle',
  'desiredFor', 'contentItemId', 'contentVersionId', 'contentSha256', 'intentSha256',
  'targetId', 'network', 'targetLabel', 'planningState', 'materializedPostId',
  'materializedOperationId', 'operationState', 'revalidationState',
  'nextRevalidationAt', 'lastErrorCode', 'updatedAt', 'environment', 'providerEffects',
]);

export class PublicSocialCalendarAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicSocialCalendarAdapterError';
  }
}

function fail(message: string): never {
  throw new PublicSocialCalendarAdapterError(message);
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} must be a canonical UUID`);
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${label} must be a lowercase SHA-256`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be a canonical UTC timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(`${label} is outside its safe bound`);
  }
  return value as number;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length > maximum
      || !SAFE_TEXT.test(value)) fail(`${label} is invalid`);
  return value;
}

function network(value: unknown): ContentCalendarPublicSocialChannel {
  if (typeof value !== 'string' || !PUBLIC_SOCIAL_NETWORKS.has(value as SocialNetwork)) {
    fail('network is outside the supported public-social taxonomy');
  }
  return value as ContentCalendarPublicSocialChannel;
}

function state(value: unknown): SocialCampaignTargetState {
  if (typeof value !== 'string' || !PUBLIC_SOCIAL_STATES.has(value as SocialCampaignTargetState)) {
    fail('state is outside the durable TEST taxonomy');
  }
  return value as SocialCampaignTargetState;
}

function nullableUuid(value: unknown, label: string): string | null {
  return value === null ? null : uuid(value, label);
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function planningState(value: unknown): SocialPlanningState {
  if (typeof value !== 'string' || !PUBLIC_SOCIAL_PLANNING_STATES.has(value as SocialPlanningState)) {
    fail('planningState is outside the durable TEST taxonomy');
  }
  return value as SocialPlanningState;
}

function revalidationState(value: unknown): SocialRevalidationState {
  if (typeof value !== 'string'
      || !PUBLIC_SOCIAL_REVALIDATION_STATES.has(value as SocialRevalidationState)) {
    fail('revalidationState is outside the durable TEST taxonomy');
  }
  return value as SocialRevalidationState;
}

function assertAllowlistedShape(value: SocialCampaignCalendarProjection, index: number): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`projection ${index + 1} is not an object`);
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_PROJECTION_FIELDS.has(key as keyof SocialCampaignCalendarProjection)) {
      fail(`projection ${index + 1} contains unsupported field ${key}`);
    }
  }
}

function assertPlanningAllowlistedShape(
  value: SocialPlanningCalendarProjection,
  index: number,
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`planning projection ${index + 1} is not an object`);
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_PLANNING_FIELDS.has(key as keyof SocialPlanningCalendarProjection)) {
      fail(`planning projection ${index + 1} contains unsupported field ${key}`);
    }
  }
}

function plannerState(value: SocialCampaignTargetState): ContentCalendarSlotSnapshot['plannerState'] {
  return value === 'waiting_for_test_time' ? 'draft' : 'simulated_preview';
}

function adaptOne(
  input: SocialCampaignCalendarProjection,
  index: number,
): ContentCalendarSlotSnapshot {
  assertAllowlistedShape(input, index);
  if (input.environment !== 'test' || input.providerEffects !== 'none') {
    fail(`projection ${index + 1} is not a zero-effect TEST projection`);
  }
  const operationId = uuid(input.operationId, 'operationId');
  const campaignId = uuid(input.campaignId, 'campaignId');
  const revisionId = uuid(input.revisionId, 'revisionId');
  const revisionNumber = integer(input.revisionNumber, 'revisionNumber', 1, 1_000_000);
  const campaignTitle = text(input.campaignTitle, 'campaignTitle', 200);
  const postId = uuid(input.postId, 'postId');
  const contentItemId = uuid(input.contentItemId, 'contentItemId');
  const contentVersionId = uuid(input.contentVersionId, 'contentVersionId');
  const contentSha256 = sha256(input.contentSha256, 'contentSha256');
  const planSha256 = sha256(input.planSha256, 'planSha256');
  const scheduledFor = timestamp(input.scheduledFor, 'scheduledFor');
  const targetId = uuid(input.targetId, 'targetId');
  const targetLabel = text(input.targetLabel, 'targetLabel', 120);
  const publicNetwork = network(input.network);
  const durableState = state(input.state);
  const simulationAttemptCount = integer(
    input.simulationAttemptCount, 'simulationAttemptCount', 0, 4,
  );
  const maxSimulationAttempts = integer(
    input.maxSimulationAttempts, 'maxSimulationAttempts', 1, 4,
  );
  const reconciliationAttemptCount = integer(
    input.reconciliationAttemptCount, 'reconciliationAttemptCount', 0, 4,
  );
  const maxReconciliationAttempts = integer(
    input.maxReconciliationAttempts, 'maxReconciliationAttempts', 1, 4,
  );
  if (simulationAttemptCount > maxSimulationAttempts) {
    fail('simulationAttemptCount cannot exceed maxSimulationAttempts');
  }
  if (reconciliationAttemptCount > maxReconciliationAttempts) {
    fail('reconciliationAttemptCount cannot exceed maxReconciliationAttempts');
  }
  const updatedAt = timestamp(input.updatedAt, 'updatedAt');

  const publicSocial: ContentCalendarPublicSocialProvenance = Object.freeze({
    campaignId,
    revisionId,
    revisionNumber,
    campaignTitle,
    postId,
    planSha256,
    operationId,
    targetId,
    targetLabel,
    network: publicNetwork,
    state: durableState,
    simulationAttemptCount,
    maxSimulationAttempts,
    reconciliationAttemptCount,
    maxReconciliationAttempts,
    updatedAt,
    environment: 'test',
    providerEffects: 'none',
  });
  return Object.freeze({
    slotId: operationId,
    contentItemId,
    contentVersionId,
    contentSha256,
    scheduledFor,
    channel: publicNetwork,
    variantLabel: `${campaignTitle} · revision ${revisionNumber}`,
    objectiveLabel: `Durable public-social TEST plan · ${planSha256.slice(0, 10)}…`,
    ownerLabel: 'Public social TEST rail',
    plannerState: plannerState(durableState),
    executionMode: 'simulated',
    publicSocial,
  });
}

interface AdaptedPlanningSlot {
  readonly slot: ContentCalendarSlotSnapshot;
  readonly campaignId: string;
  readonly revisionId: string;
  readonly targetId: string;
  readonly materializedOperationId: string | null;
}

function adaptPlanningOne(
  input: SocialPlanningCalendarProjection,
  index: number,
): AdaptedPlanningSlot {
  assertPlanningAllowlistedShape(input, index);
  if (input.environment !== 'test' || input.providerEffects !== 'none') {
    fail(`planning projection ${index + 1} is not a zero-effect TEST projection`);
  }
  const intentId = uuid(input.intentId, 'intentId');
  const campaignId = uuid(input.campaignId, 'campaignId');
  const revisionId = uuid(input.revisionId, 'revisionId');
  const revisionNumber = integer(input.revisionNumber, 'revisionNumber', 1, 1_000_000);
  const campaignTitle = text(input.campaignTitle, 'campaignTitle', 200);
  const desiredFor = timestamp(input.desiredFor, 'desiredFor');
  const contentItemId = uuid(input.contentItemId, 'contentItemId');
  const contentVersionId = uuid(input.contentVersionId, 'contentVersionId');
  const contentSha256 = sha256(input.contentSha256, 'contentSha256');
  const intentSha256 = sha256(input.intentSha256, 'intentSha256');
  const targetId = uuid(input.targetId, 'targetId');
  const publicNetwork = network(input.network);
  const targetLabel = text(input.targetLabel, 'targetLabel', 120);
  const durablePlanningState = planningState(input.planningState);
  const materializedPostId = nullableUuid(input.materializedPostId, 'materializedPostId');
  const materializedOperationId = nullableUuid(
    input.materializedOperationId,
    'materializedOperationId',
  );
  if ((materializedPostId === null) !== (materializedOperationId === null)) {
    fail('materialized planning identities must be present together');
  }
  if (input.operationState !== null) state(input.operationState);
  const durableRevalidationState = revalidationState(input.revalidationState);
  const nextRevalidationAt = nullableTimestamp(input.nextRevalidationAt, 'nextRevalidationAt');
  if (input.lastErrorCode !== null) text(input.lastErrorCode, 'lastErrorCode', 80);
  const updatedAt = timestamp(input.updatedAt, 'updatedAt');
  const planning: ContentCalendarPlanningProvenance = Object.freeze({
    intentId,
    intentSha256,
    targetId,
    desiredFor,
    planningState: durablePlanningState,
    revalidationState: durableRevalidationState,
    nextRevalidationAt,
    updatedAt,
    environment: 'test',
    providerEffects: 'none',
  });
  return Object.freeze({
    campaignId,
    revisionId,
    targetId,
    materializedOperationId,
    slot: Object.freeze({
      slotId: materializedOperationId ?? `${intentId}:${targetId}`,
      contentItemId,
      contentVersionId,
      contentSha256,
      scheduledFor: desiredFor,
      channel: publicNetwork,
      variantLabel: `${campaignTitle} · revision ${revisionNumber}`,
      objectiveLabel: `Durable TEST planning intent · ${intentSha256.slice(0, 10)}…`,
      ownerLabel: `${targetLabel} · public social TEST planner`,
      plannerState: durablePlanningState === 'materialized' ? 'simulated_preview' : 'draft',
      executionMode: 'simulated',
      planning,
    }),
  });
}

/**
 * Allowlisted adapter from the safe DB projection to the existing planner model.
 * It does not read content bodies, provider accounts, connection ids or storage keys.
 */
export function adaptPublicSocialCalendar(
  projections: readonly SocialCampaignCalendarProjection[],
  catalog: CompanyContentCatalogPage,
  sourceTruncated: boolean,
  planningProjections: readonly SocialPlanningCalendarProjection[] = [],
  planningSourceTruncated = false,
): ContentCalendarSnapshot {
  if (!Array.isArray(projections)) fail('projections must be an array');
  if (!Array.isArray(planningProjections)) fail('planningProjections must be an array');
  if (typeof sourceTruncated !== 'boolean' || typeof planningSourceTruncated !== 'boolean') {
    fail('source truncation flags must be boolean');
  }
  if (projections.length > CONTENT_CALENDAR_MAX_SLOTS) {
    fail(`projections exceed the ${CONTENT_CALENDAR_MAX_SLOTS}-slot calendar bound`);
  }
  if (planningProjections.length > CONTENT_CALENDAR_MAX_SLOTS) {
    fail(`planning projections exceed the ${CONTENT_CALENDAR_MAX_SLOTS}-slot calendar bound`);
  }
  const operationIds = new Set<string>();
  const postTargets = new Map<string, string>();
  const operationSlots = projections
    .map((projection, index) => adaptOne(projection, index))
    .map((slot) => {
      const operationId = slot.publicSocial!.operationId;
      if (operationIds.has(operationId)) fail(`duplicate operation ${operationId}`);
      operationIds.add(operationId);
      const postTargetKey = `${slot.publicSocial!.postId}:${slot.publicSocial!.targetId}`;
      const previousOperation = postTargets.get(postTargetKey);
      if (previousOperation && previousOperation !== operationId) {
        fail(`conflicting operations ${previousOperation} and ${operationId} cover one post target`);
      }
      postTargets.set(postTargetKey, operationId);
      return slot;
    });
  const planningKeys = new Set<string>();
  const planningByOperation = new Map<string, AdaptedPlanningSlot>();
  const planningSlots = planningProjections.map((projection, index) => {
    const adapted = adaptPlanningOne(projection, index);
    const key = `${adapted.slot.planning!.intentId}:${adapted.targetId}`;
    if (planningKeys.has(key)) fail(`duplicate planning target ${key}`);
    planningKeys.add(key);
    if (adapted.materializedOperationId) {
      if (planningByOperation.has(adapted.materializedOperationId)) {
        fail(`duplicate materialized planning operation ${adapted.materializedOperationId}`);
      }
      planningByOperation.set(adapted.materializedOperationId, adapted);
    }
    return adapted;
  });
  const matchedOperations = new Set<string>();
  const enrichedOperationSlots = operationSlots.map((slot) => {
    const operationId = slot.publicSocial!.operationId;
    const planning = planningByOperation.get(operationId);
    if (!planning) return slot;
    if (planning.campaignId !== slot.publicSocial!.campaignId
        || planning.revisionId !== slot.publicSocial!.revisionId
        || planning.targetId !== slot.publicSocial!.targetId
        || planning.slot.contentItemId !== slot.contentItemId
        || planning.slot.contentVersionId !== slot.contentVersionId
        || planning.slot.contentSha256 !== slot.contentSha256
        || planning.slot.channel !== slot.channel
        || planning.slot.scheduledFor !== slot.scheduledFor) {
      fail(`materialized planning proof contradicts operation ${operationId}`);
    }
    matchedOperations.add(operationId);
    return Object.freeze({ ...slot, planning: planning.slot.planning });
  });
  const slots = [
    ...enrichedOperationSlots,
    ...planningSlots
      .filter((planning) => !planning.materializedOperationId
        || !matchedOperations.has(planning.materializedOperationId))
      .map((planning) => planning.slot),
  ]
    .sort((left, right) => left.scheduledFor.localeCompare(right.scheduledFor)
      || left.slotId.localeCompare(right.slotId));
  const bounded = slots.slice(0, CONTENT_CALENDAR_MAX_SLOTS);
  return Object.freeze({
    catalog,
    slots: Object.freeze(bounded),
    sourceTruncated: sourceTruncated || planningSourceTruncated
      || slots.length > CONTENT_CALENDAR_MAX_SLOTS,
  });
}
