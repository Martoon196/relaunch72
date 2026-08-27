import type { SqlExecutor } from '../crm-pg/types.js';
import {
  SocialCampaignPgContractError,
  type CancelSocialCampaignTargetCommand,
  type CancelSocialCampaignTargetResult,
  type CancelSocialPlanningTargetCommand,
  type CancelSocialPlanningTargetResult,
  type ClaimSocialPlanningRevalidationsCommand,
  type CompleteSocialPlanningRevalidationCommand,
  type CompleteSocialPlanningRevalidationResult,
  type CreateSocialCampaignRevisionCommand,
  type CreateSocialCampaignRevisionResult,
  type FailSocialPlanningRevalidationCommand,
  type FailSocialPlanningRevalidationResult,
  type MaterializeSocialPlanningIntentCommand,
  type MaterializeSocialPlanningIntentResult,
  type PlanSocialCampaignIntentCommand,
  type PlanSocialCampaignIntentResult,
  type RegisterSocialCampaignTestTargetCommand,
  type RegisterSocialCampaignTestTargetResult,
  type RescheduleSocialPlanningTargetCommand,
  type RescheduleSocialPlanningTargetResult,
  type ResolvedSocialCampaignTestTarget,
  type ScheduleSocialCampaignCommand,
  type ScheduleSocialCampaignResult,
  type SocialCampaignCalendarProjection,
  type SocialCampaignCalendarProjectionPage,
  type SocialCampaignCommandProjection,
  type SocialCampaignCommandProjectionPage,
  type SocialPlannerTargetProjectionPage,
  type SocialPlanningCalendarProjectionPage,
  type SocialPlanningRevalidationClaim,
  type SocialPlanningRevalidationMediaMaterial,
} from './types.js';
import {
  socialCampaignDisposition,
  socialCampaignInteger,
  socialCampaignNetwork,
  socialCampaignOptionalTimestamp,
  socialPlanningState,
  socialRevalidationState,
  socialCampaignSha256,
  socialCampaignState,
  socialCampaignTimestamp,
  socialCampaignUuid,
  validateCancelSocialCampaignTarget,
  validateCancelSocialPlanningTarget,
  validateClaimSocialPlanningRevalidations,
  validateCompleteSocialPlanningRevalidation,
  validateCreateSocialCampaignRevision,
  validateFailSocialPlanningRevalidation,
  validateMaterializeSocialPlanningIntent,
  validatePlanSocialCampaignIntent,
  validateRegisterSocialCampaignTestTarget,
  validateRescheduleSocialPlanningTarget,
  validateScheduleSocialCampaign,
} from './validation.js';

interface CreateRevisionRow extends Record<string, unknown> {
  campaignId: unknown;
  revisionId: unknown;
  revisionNumber: unknown;
  disposition: unknown;
}

interface RegisterTargetRow extends Record<string, unknown> {
  targetId: unknown;
  disposition: unknown;
}

interface ResolveTargetRow extends Record<string, unknown> {
  ordinal: unknown;
  targetId: unknown;
  network: unknown;
  testAccountRef: unknown;
}

interface ScheduleRow extends Record<string, unknown> {
  postId: unknown;
  operationIds: unknown;
  disposition: unknown;
}

interface CancelRow extends Record<string, unknown> {
  operationId: unknown;
  state: unknown;
  disposition: unknown;
}

interface PlanIntentRow extends Record<string, unknown> {
  intentId: unknown;
  intentSha256: unknown;
  disposition: unknown;
}

interface ReschedulePlanningTargetRow extends Record<string, unknown> {
  successorIntentId: unknown;
  disposition: unknown;
}

interface CancelPlanningTargetRow extends Record<string, unknown> {
  intentId: unknown;
  targetId: unknown;
  state: unknown;
  disposition: unknown;
}

interface PlannerTargetRow extends Record<string, unknown> {
  targetId: unknown;
  network: unknown;
  targetLabel: unknown;
  hasMore: unknown;
}

interface PlanningCalendarRow extends Record<string, unknown> {
  intentId: unknown;
  campaignId: unknown;
  revisionId: unknown;
  revisionNumber: unknown;
  campaignTitle: unknown;
  desiredFor: unknown;
  contentItemId: unknown;
  contentVersionId: unknown;
  contentSha256: unknown;
  intentSha256: unknown;
  targetId: unknown;
  network: unknown;
  targetLabel: unknown;
  planningState: unknown;
  materializedPostId: unknown;
  materializedOperationId: unknown;
  operationState: unknown;
  revalidationState: unknown;
  nextRevalidationAt: unknown;
  lastErrorCode: unknown;
  updatedAt: unknown;
  hasMore: unknown;
}

interface RevalidationClaimRow extends Record<string, unknown> {
  jobId: unknown;
  workspaceId: unknown;
  intentId: unknown;
  leaseVersion: unknown;
  desiredFor: unknown;
  contentItemId: unknown;
  contentVersionId: unknown;
  sourceSystem: unknown;
  sourceItemId: unknown;
  sourceVersion: unknown;
  contentSha256: unknown;
  blobSha256: unknown;
  brandSha256: unknown;
  media: unknown;
}

interface CompleteRevalidationRow extends Record<string, unknown> {
  proofId: unknown;
  state: unknown;
  disposition: unknown;
}

interface FailRevalidationRow extends Record<string, unknown> {
  jobId: unknown;
  state: unknown;
}

interface MaterializePlanningIntentRow extends Record<string, unknown> {
  postId: unknown;
  operationIds: unknown;
  disposition: unknown;
}

interface CommandProjectionRow extends Record<string, unknown> {
  campaignId: unknown;
  revisionId: unknown;
  revisionNumber: unknown;
  revisionSha256: unknown;
  title: unknown;
  objective: unknown;
  timezone: unknown;
  postId: unknown;
  contentItemId: unknown;
  contentVersionId: unknown;
  contentSha256: unknown;
  planSha256: unknown;
  scheduledFor: unknown;
  operationId: unknown;
  targetId: unknown;
  network: unknown;
  targetLabel: unknown;
  state: unknown;
  simulationAttemptCount: unknown;
  maxSimulationAttempts: unknown;
  reconciliationAttemptCount: unknown;
  maxReconciliationAttempts: unknown;
  testReferenceSha256: unknown;
  hasMore: unknown;
}

interface CalendarProjectionRow extends Record<string, unknown> {
  campaignId: unknown;
  revisionId: unknown;
  revisionNumber: unknown;
  campaignTitle: unknown;
  postId: unknown;
  contentItemId: unknown;
  contentVersionId: unknown;
  contentSha256: unknown;
  planSha256: unknown;
  scheduledFor: unknown;
  operationId: unknown;
  targetId: unknown;
  network: unknown;
  targetLabel: unknown;
  state: unknown;
  simulationAttemptCount: unknown;
  maxSimulationAttempts: unknown;
  reconciliationAttemptCount: unknown;
  maxReconciliationAttempts: unknown;
  updatedAt: unknown;
  hasMore: unknown;
}

const CAMPAIGN_COMMAND_PROJECTION_LIMIT = 120;

function exactOne<TRow extends Record<string, unknown>>(rows: readonly TRow[], label: string): TRow {
  const row = rows[0];
  if (rows.length !== 1 || !row) throw new SocialCampaignPgContractError(`${label} returned invalid cardinality`);
  return row;
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
      || value !== value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new SocialCampaignPgContractError(`${label} returned invalid text`);
  }
  return value;
}

function optionalUuid(value: unknown, label: string): string | null {
  return value === null ? null : socialCampaignUuid(value, label);
}

function optionalSha(value: unknown, label: string): string | null {
  return value === null ? null : socialCampaignSha256(value, label);
}

function boundedProjectionRows<TRow extends { readonly hasMore: unknown }>(
  rows: readonly TRow[],
  limit: number,
  aggregateKey: (row: TRow) => string,
  label: string,
): Readonly<{ rows: readonly TRow[]; hasMore: boolean }> {
  if (rows.length > limit + 1) {
    throw new SocialCampaignPgContractError(`${label} exceeded its limit-plus-one contract`);
  }
  const hasMore = rows.length > limit;
  for (const row of rows) {
    if (typeof row.hasMore !== 'boolean' || row.hasMore !== hasMore) {
      throw new SocialCampaignPgContractError(`${label} returned inconsistent truncation evidence`);
    }
  }
  if (!hasMore) return Object.freeze({ rows, hasMore: false });

  const extra = rows[limit];
  if (!extra) {
    throw new SocialCampaignPgContractError(`${label} omitted its limit-plus-one evidence row`);
  }
  const extraAggregate = aggregateKey(extra);
  const complete = rows.slice(0, limit);
  while (complete.length > 0 && aggregateKey(complete[complete.length - 1]!) === extraAggregate) {
    complete.pop();
  }
  return Object.freeze({ rows: Object.freeze(complete), hasMore: true });
}

function optionalNetwork(value: unknown, label: string) {
  return value === null ? null : socialCampaignNetwork(value, label);
}

function optionalState(value: unknown, label: string) {
  return value === null ? null : socialCampaignState(value, label);
}

function optionalSafeCode(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_.:-]{0,99}$/u.test(value)) {
    throw new SocialCampaignPgContractError(`${label} returned invalid code`);
  }
  return value;
}

function sourceSystem(value: unknown, label: string): string {
  const system = requiredText(value, label, 100);
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/u.test(system)) {
    throw new SocialCampaignPgContractError(`${label} returned invalid source system`);
  }
  return system;
}

function parseRevalidationMedia(value: unknown): readonly SocialPlanningRevalidationMediaMaterial[] {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source) as unknown; }
    catch { throw new SocialCampaignPgContractError('revalidation media returned invalid JSON'); }
  }
  if (!Array.isArray(source) || source.length > 10) {
    throw new SocialCampaignPgContractError('revalidation media returned invalid material');
  }
  const seenVersions = new Set<string>();
  const result = source.map((candidate, index) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new SocialCampaignPgContractError(
        `revalidation media[${index}] returned invalid material`,
      );
    }
    const row = candidate as Record<string, unknown>;
    const ordinal = socialCampaignInteger(row.ordinal, `media[${index}].ordinal`, 1, 10);
    if (ordinal !== index + 1) {
      throw new SocialCampaignPgContractError('revalidation media ordinals are not contiguous');
    }
    const contentVersionId = socialCampaignUuid(
      row.contentVersionId ?? row.content_version_id,
      `media[${index}].contentVersionId`,
    );
    if (seenVersions.has(contentVersionId)) {
      throw new SocialCampaignPgContractError('revalidation media returned duplicate versions');
    }
    seenVersions.add(contentVersionId);
    return Object.freeze({
      ordinal,
      contentItemId: socialCampaignUuid(
        row.contentItemId ?? row.content_item_id,
        `media[${index}].contentItemId`,
      ),
      contentVersionId,
      sourceSystem: sourceSystem(
        row.sourceSystem ?? row.source_system,
        `media[${index}].sourceSystem`,
      ),
      sourceItemId: requiredText(
        row.sourceItemId ?? row.source_item_id,
        `media[${index}].sourceItemId`, 500,
      ),
      sourceVersion: requiredText(
        row.sourceVersion ?? row.source_version,
        `media[${index}].sourceVersion`, 500,
      ),
      contentSha256: socialCampaignSha256(
        row.contentSha256 ?? row.content_sha256,
        `media[${index}].contentSha256`,
      ),
      blobSha256: socialCampaignSha256(
        row.blobSha256 ?? row.blob_sha256,
        `media[${index}].blobSha256`,
      ),
      brandSha256: socialCampaignSha256(
        row.brandSha256 ?? row.brand_sha256,
        `media[${index}].brandSha256`,
      ),
    });
  });
  return Object.freeze(result);
}

function revalidationClaim(row: RevalidationClaimRow): SocialPlanningRevalidationClaim {
  return Object.freeze({
    jobId: socialCampaignUuid(row.jobId, 'jobId'),
    workspaceId: socialCampaignUuid(row.workspaceId, 'workspaceId'),
    intentId: socialCampaignUuid(row.intentId, 'intentId'),
    leaseVersion: socialCampaignInteger(
      row.leaseVersion, 'leaseVersion', 1, Number.MAX_SAFE_INTEGER,
    ),
    desiredFor: socialCampaignTimestamp(row.desiredFor, 'desiredFor'),
    contentItemId: socialCampaignUuid(row.contentItemId, 'contentItemId'),
    contentVersionId: socialCampaignUuid(row.contentVersionId, 'contentVersionId'),
    sourceSystem: sourceSystem(row.sourceSystem, 'sourceSystem'),
    sourceItemId: requiredText(row.sourceItemId, 'sourceItemId', 500),
    sourceVersion: requiredText(row.sourceVersion, 'sourceVersion', 500),
    contentSha256: socialCampaignSha256(row.contentSha256, 'contentSha256'),
    blobSha256: socialCampaignSha256(row.blobSha256, 'blobSha256'),
    brandSha256: socialCampaignSha256(row.brandSha256, 'brandSha256'),
    media: parseRevalidationMedia(row.media),
  });
}

function uuidArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new SocialCampaignPgContractError(`${label} returned invalid cardinality`);
  }
  const ids = value.map((candidate, index) => socialCampaignUuid(candidate, `${label}[${index}]`));
  if (new Set(ids).size !== ids.length) {
    throw new SocialCampaignPgContractError(`${label} returned duplicate identities`);
  }
  return Object.freeze(ids);
}

/** Function-only command boundary for r72_social_command. */
export class PgSocialCampaignCommandRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async createRevision(
    command: CreateSocialCampaignRevisionCommand,
  ): Promise<CreateSocialCampaignRevisionResult> {
    const input = validateCreateSocialCampaignRevision(command);
    const result = await this.executor.query<CreateRevisionRow>(
      `/* social-campaign.create-revision */
       SELECT campaign_id AS "campaignId", revision_id AS "revisionId",
              revision_number AS "revisionNumber", disposition
       FROM app_private.create_test_social_campaign_revision(
         $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid,
         $6::text, $7::text, $8::text, decode($9, 'hex')
       )`,
      [input.workspaceId, input.campaignId, input.revisionId, input.revisionNumber,
        input.previousRevisionId, input.title, input.objective, input.timezone,
        input.revisionSha256],
    );
    const row = exactOne(result.rows, 'create revision');
    const campaignId = socialCampaignUuid(row.campaignId, 'campaignId');
    const revisionId = socialCampaignUuid(row.revisionId, 'revisionId');
    if (campaignId !== input.campaignId || revisionId !== input.revisionId) {
      throw new SocialCampaignPgContractError('create revision returned different identities');
    }
    return Object.freeze({
      campaignId,
      revisionId,
      revisionNumber: socialCampaignInteger(row.revisionNumber, 'revisionNumber', 1, 1_000_000),
      disposition: socialCampaignDisposition(row.disposition),
    });
  }

  async registerTestTarget(
    command: RegisterSocialCampaignTestTargetCommand,
  ): Promise<RegisterSocialCampaignTestTargetResult> {
    const input = validateRegisterSocialCampaignTestTarget(command);
    const result = await this.executor.query<RegisterTargetRow>(
      `/* social-campaign.register-test-target */
       SELECT target_id AS "targetId", disposition
       FROM app_private.register_test_social_campaign_target(
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text
       )`,
      [input.workspaceId, input.targetId, input.connectionId, input.network,
        input.testAccountRef, input.displayName],
    );
    const row = exactOne(result.rows, 'register target');
    return Object.freeze({
      targetId: socialCampaignUuid(row.targetId, 'targetId'),
      disposition: socialCampaignDisposition(row.disposition),
    });
  }

  async resolveTestTargets(
    workspaceId: string,
    targetIds: readonly string[],
  ): Promise<readonly ResolvedSocialCampaignTestTarget[]> {
    const canonicalWorkspaceId = socialCampaignUuid(workspaceId, 'workspaceId');
    if (!Array.isArray(targetIds) || targetIds.length < 1 || targetIds.length > 9) {
      throw new SocialCampaignPgContractError('targetIds must contain between one and nine targets');
    }
    const canonicalTargetIds = targetIds.map((value, index) =>
      socialCampaignUuid(value, `targetIds[${index}]`));
    if (new Set(canonicalTargetIds).size !== canonicalTargetIds.length) {
      throw new SocialCampaignPgContractError('targetIds must be unique');
    }
    const result = await this.executor.query<ResolveTargetRow>(
      `/* social-campaign.resolve-test-targets */
       SELECT ordinal, target_id AS "targetId", network,
              test_account_ref AS "testAccountRef"
       FROM app_private.resolve_test_social_campaign_targets($1::uuid, $2::uuid[])
       ORDER BY ordinal`,
      [canonicalWorkspaceId, canonicalTargetIds],
    );
    if (result.rows.length !== canonicalTargetIds.length) {
      throw new SocialCampaignPgContractError('resolved TEST targets returned invalid cardinality');
    }
    const resolved = result.rows.map((row, index) => {
      const ordinal = socialCampaignInteger(row.ordinal, 'ordinal', 1, 9);
      const targetId = socialCampaignUuid(row.targetId, 'targetId');
      const network = socialCampaignNetwork(row.network, 'network');
      const testAccountRef = requiredText(row.testAccountRef, 'testAccountRef', 128);
      if (ordinal !== index + 1 || targetId !== canonicalTargetIds[index]
          || !new RegExp(`^test-account:${network}:[a-z0-9_-]{1,64}$`, 'u').test(testAccountRef)) {
        throw new SocialCampaignPgContractError('resolved TEST target is not bound to command truth');
      }
      return Object.freeze({ targetId, network, testAccountRef });
    });
    return Object.freeze(resolved);
  }

  async schedule(command: ScheduleSocialCampaignCommand): Promise<ScheduleSocialCampaignResult> {
    const input = validateScheduleSocialCampaign(command);
    const media = input.media.map((item) => ({ ...item }));
    const result = await this.executor.query<ScheduleRow>(
      `/* social-campaign.schedule */
       SELECT post_id AS "postId", operation_ids AS "operationIds", disposition
       FROM app_private.schedule_test_social_campaign(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         decode($7, 'hex'), $8::uuid, $9::uuid, $10::uuid,
         $11::timestamptz, $12::smallint, decode($13, 'hex'), $14::uuid[], $15::jsonb
       )`,
      [input.workspaceId, input.postId, input.campaignId, input.revisionId,
        input.contentItemId, input.plan.contentVersionId, input.plan.contentSha256,
        input.approvalRequestId, input.approvalDecisionId, input.sourceAttestationId,
        input.plan.scheduledFor, input.plan.maxAttempts, input.plan.planSha256,
        [...input.targetIds], JSON.stringify(media)],
    );
    const row = exactOne(result.rows, 'schedule campaign');
    if (!Array.isArray(row.operationIds) || row.operationIds.length !== input.targetIds.length) {
      throw new SocialCampaignPgContractError('schedule campaign returned invalid operation ids');
    }
    const operationIds = row.operationIds.map((value, index) =>
      socialCampaignUuid(value, `operationIds[${index}]`));
    if (new Set(operationIds).size !== operationIds.length) {
      throw new SocialCampaignPgContractError('schedule campaign returned duplicate operation ids');
    }
    return Object.freeze({
      postId: socialCampaignUuid(row.postId, 'postId'),
      operationIds: Object.freeze(operationIds),
      disposition: socialCampaignDisposition(row.disposition),
    });
  }

  async cancelTarget(
    command: CancelSocialCampaignTargetCommand,
  ): Promise<CancelSocialCampaignTargetResult> {
    const input = validateCancelSocialCampaignTarget(command);
    const result = await this.executor.query<CancelRow>(
      `/* social-campaign.cancel-target */
       SELECT operation_id AS "operationId", state, disposition
       FROM app_private.cancel_test_social_campaign_target(
         $1::uuid, $2::uuid, decode($3, 'hex')
       )`,
      [input.workspaceId, input.operationId, input.reasonSha256],
    );
    const row = exactOne(result.rows, 'cancel target');
    return Object.freeze({
      operationId: socialCampaignUuid(row.operationId, 'operationId'),
      state: socialCampaignState(row.state, 'state'),
      disposition: socialCampaignDisposition(row.disposition),
    });
  }

  async planIntent(
    command: PlanSocialCampaignIntentCommand,
  ): Promise<PlanSocialCampaignIntentResult> {
    const input = validatePlanSocialCampaignIntent(command);
    const result = await this.executor.query<PlanIntentRow>(
      `/* social-campaign.plan-intent */
       SELECT intent_id AS "intentId", intent_sha256 AS "intentSha256", disposition
       FROM app_private.create_test_social_planning_intent(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6::timestamptz, $7::smallint, $8::uuid[], $9::uuid[]
       )`,
      [input.workspaceId, input.intentId, input.campaignId, input.revisionId,
        input.contentVersionId, input.desiredFor, input.maxAttempts,
        [...input.targetIds], [...input.mediaVersionIds]],
    );
    const row = exactOne(result.rows, 'plan intent');
    const intentId = socialCampaignUuid(row.intentId, 'intentId');
    if (intentId !== input.intentId) {
      throw new SocialCampaignPgContractError('plan intent returned a different identity');
    }
    return Object.freeze({
      intentId,
      intentSha256: socialCampaignSha256(row.intentSha256, 'intentSha256'),
      disposition: socialCampaignDisposition(row.disposition),
    });
  }

  async reschedulePlanningTarget(
    command: RescheduleSocialPlanningTargetCommand,
  ): Promise<RescheduleSocialPlanningTargetResult> {
    const input = validateRescheduleSocialPlanningTarget(command);
    const result = await this.executor.query<ReschedulePlanningTargetRow>(
      `/* social-campaign.reschedule-planning-target */
       SELECT successor_intent_id AS "successorIntentId", disposition
       FROM app_private.reschedule_test_social_planning_target(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz,
         decode($6, 'hex')
       )`,
      [input.workspaceId, input.predecessorIntentId, input.targetId,
        input.successorIntentId, input.newDesiredFor, input.reasonSha256],
    );
    const row = exactOne(result.rows, 'reschedule planning target');
    const successorIntentId = socialCampaignUuid(row.successorIntentId, 'successorIntentId');
    if (successorIntentId !== input.successorIntentId) {
      throw new SocialCampaignPgContractError('reschedule returned a different successor identity');
    }
    return Object.freeze({
      successorIntentId,
      disposition: socialCampaignDisposition(row.disposition),
    });
  }

  async cancelPlanningTarget(
    command: CancelSocialPlanningTargetCommand,
  ): Promise<CancelSocialPlanningTargetResult> {
    const input = validateCancelSocialPlanningTarget(command);
    const result = await this.executor.query<CancelPlanningTargetRow>(
      `/* social-campaign.cancel-planning-target */
       SELECT intent_id AS "intentId", target_id AS "targetId", state, disposition
       FROM app_private.cancel_test_social_planning_target(
         $1::uuid, $2::uuid, $3::uuid, decode($4, 'hex')
       )`,
      [input.workspaceId, input.intentId, input.targetId, input.reasonSha256],
    );
    const row = exactOne(result.rows, 'cancel planning target');
    if (row.state !== 'cancelled') {
      throw new SocialCampaignPgContractError('cancel planning target returned invalid state');
    }
    const intentId = socialCampaignUuid(row.intentId, 'intentId');
    const targetId = socialCampaignUuid(row.targetId, 'targetId');
    if (intentId !== input.intentId || targetId !== input.targetId) {
      throw new SocialCampaignPgContractError('cancel planning target returned different identities');
    }
    return Object.freeze({
      intentId,
      targetId,
      state: 'cancelled' as const,
      disposition: socialCampaignDisposition(row.disposition),
    });
  }
}

/** Function-only worker boundary for r72_social_revalidator_command. */
export class PgSocialPlanningRevalidationRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async claimDue(
    command: ClaimSocialPlanningRevalidationsCommand,
  ): Promise<readonly SocialPlanningRevalidationClaim[]> {
    const input = validateClaimSocialPlanningRevalidations(command);
    const result = await this.executor.query<RevalidationClaimRow>(
      `/* social-planning-revalidation.claim-due */
       SELECT job_id AS "jobId", workspace_id AS "workspaceId",
              intent_id AS "intentId", lease_version AS "leaseVersion",
              desired_for AS "desiredFor", content_item_id AS "contentItemId",
              content_version_id AS "contentVersionId",
              source_system AS "sourceSystem", source_item_id AS "sourceItemId",
              source_version AS "sourceVersion", content_sha256 AS "contentSha256",
              blob_sha256 AS "blobSha256", brand_sha256 AS "brandSha256", media
       FROM app_private.claim_due_test_social_revalidations(
         $1::uuid, $2::bytea, $3::integer, $4::integer
       )`,
      [input.workerId, input.leaseTokenHash, input.batchSize, input.leaseSeconds],
    );
    if (result.rows.length > input.batchSize) {
      throw new SocialCampaignPgContractError('revalidation claim exceeded its requested bound');
    }
    return Object.freeze(result.rows.map(revalidationClaim));
  }

  async complete(
    command: CompleteSocialPlanningRevalidationCommand,
  ): Promise<CompleteSocialPlanningRevalidationResult> {
    const input = validateCompleteSocialPlanningRevalidation(command);
    const result = await this.executor.query<CompleteRevalidationRow>(
      `/* social-planning-revalidation.complete */
       SELECT proof_id AS "proofId", state, disposition
       FROM app_private.complete_test_social_revalidation(
         $1::uuid, $2::uuid, $3::uuid, $4::bytea, $5::bigint,
         $6::uuid, $7::uuid, $8::uuid[]
       )`,
      [
        input.workspaceId, input.jobId, input.workerId, input.leaseTokenHash,
        input.leaseVersion, input.proofId, input.contentAttestationId,
        [...input.mediaAttestationIds],
      ],
    );
    const row = exactOne(result.rows, 'complete revalidation');
    const proofId = socialCampaignUuid(row.proofId, 'proofId');
    if (proofId !== input.proofId || row.state !== 'verified') {
      throw new SocialCampaignPgContractError('complete revalidation returned mismatched identity');
    }
    return Object.freeze({
      proofId,
      state: 'verified' as const,
      disposition: socialCampaignDisposition(row.disposition),
    });
  }

  async fail(
    command: FailSocialPlanningRevalidationCommand,
  ): Promise<FailSocialPlanningRevalidationResult> {
    const input = validateFailSocialPlanningRevalidation(command);
    const result = await this.executor.query<FailRevalidationRow>(
      `/* social-planning-revalidation.fail */
       SELECT job_id AS "jobId", state
       FROM app_private.fail_test_social_revalidation(
         $1::uuid, $2::uuid, $3::uuid, $4::bytea, $5::bigint, $6::text, $7::boolean
       )`,
      [
        input.workspaceId, input.jobId, input.workerId, input.leaseTokenHash,
        input.leaseVersion, input.errorCode, input.retryable,
      ],
    );
    const row = exactOne(result.rows, 'fail revalidation');
    const jobId = socialCampaignUuid(row.jobId, 'jobId');
    if (jobId !== input.jobId || (row.state !== 'retry_wait' && row.state !== 'dead_letter')) {
      throw new SocialCampaignPgContractError('fail revalidation returned invalid state');
    }
    return Object.freeze({ jobId, state: row.state });
  }

  async materialize(
    command: MaterializeSocialPlanningIntentCommand,
  ): Promise<MaterializeSocialPlanningIntentResult> {
    const input = validateMaterializeSocialPlanningIntent(command);
    const result = await this.executor.query<MaterializePlanningIntentRow>(
      `/* social-planning-revalidation.materialize */
       SELECT post_id AS "postId", operation_ids AS "operationIds", disposition
       FROM app_private.materialize_test_social_planning_intent(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid
       )`,
      [input.workspaceId, input.jobId, input.proofId, input.postId],
    );
    const row = exactOne(result.rows, 'materialize planning intent');
    const postId = socialCampaignUuid(row.postId, 'postId');
    if (postId !== input.postId) {
      throw new SocialCampaignPgContractError('materialize planning intent returned mismatched identity');
    }
    return Object.freeze({
      postId,
      operationIds: uuidArray(row.operationIds, 'operationIds', 1, 9),
      disposition: socialCampaignDisposition(row.disposition),
    });
  }
}

/** Function-only read boundary for safe portal projections. */
export class PgSocialCampaignReadRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async listPlannerTargets(
    workspaceId: string,
    limit = 120,
  ): Promise<SocialPlannerTargetProjectionPage> {
    const workspace = socialCampaignUuid(workspaceId, 'workspaceId');
    const boundedLimit = socialCampaignInteger(limit, 'limit', 1, 120);
    const result = await this.executor.query<PlannerTargetRow>(
      `/* social-campaign.list-planner-targets */
       SELECT target_id AS "targetId", network, target_label AS "targetLabel",
              has_more AS "hasMore"
       FROM app_private.list_test_social_planner_targets($1::uuid, $2::integer)`,
      [workspace, boundedLimit],
    );
    const page = boundedProjectionRows(
      result.rows,
      boundedLimit,
      (row) => socialCampaignUuid(row.targetId, 'targetId'),
      'planner target projection',
    );
    const items = page.rows.map((row) => Object.freeze({
      targetId: socialCampaignUuid(row.targetId, 'targetId'),
      network: socialCampaignNetwork(row.network, 'network'),
      targetLabel: requiredText(row.targetLabel, 'targetLabel', 120),
      environment: 'test' as const,
      providerEffects: 'none' as const,
    }));
    return Object.freeze({ items: Object.freeze(items), hasMore: page.hasMore });
  }

  async listCampaign(
    workspaceId: string,
    campaignId: string,
  ): Promise<SocialCampaignCommandProjectionPage> {
    const workspace = socialCampaignUuid(workspaceId, 'workspaceId');
    const campaign = socialCampaignUuid(campaignId, 'campaignId');
    const result = await this.executor.query<CommandProjectionRow>(
      `/* social-campaign.list-command */
       SELECT $2::uuid AS "campaignId", revision_id AS "revisionId",
              revision_number AS "revisionNumber",
              revision_sha256 AS "revisionSha256",
              title, objective, timezone,
              post_id AS "postId", content_item_id AS "contentItemId",
              content_version_id AS "contentVersionId", content_sha256 AS "contentSha256",
              plan_sha256 AS "planSha256",
              scheduled_for AS "scheduledFor", operation_id AS "operationId",
              target_id AS "targetId", network, target_label AS "targetLabel",
               operation_state AS state,
               simulation_attempt_count AS "simulationAttemptCount",
               max_simulation_attempts AS "maxSimulationAttempts",
               reconciliation_attempt_count AS "reconciliationAttemptCount",
               max_reconciliation_attempts AS "maxReconciliationAttempts",
               test_reference_sha256 AS "testReferenceSha256",
               has_more AS "hasMore"
       FROM app_private.list_social_campaign_command($1::uuid, $2::uuid, $3::integer)`,
      [workspace, campaign, CAMPAIGN_COMMAND_PROJECTION_LIMIT],
    );
    const page = boundedProjectionRows(
      result.rows,
      CAMPAIGN_COMMAND_PROJECTION_LIMIT,
      (row) => {
        const revisionId = socialCampaignUuid(row.revisionId, 'revisionId');
        const postId = optionalUuid(row.postId, 'postId');
        return postId === null ? `revision:${revisionId}` : `post:${postId}`;
      },
      'campaign projection',
    );
    const items = page.rows.map((row) => Object.freeze({
      campaignId: socialCampaignUuid(row.campaignId, 'campaignId'),
      revisionId: socialCampaignUuid(row.revisionId, 'revisionId'),
      revisionNumber: socialCampaignInteger(row.revisionNumber, 'revisionNumber', 1, 1_000_000),
      revisionSha256: socialCampaignSha256(row.revisionSha256, 'revisionSha256'),
      title: requiredText(row.title, 'title', 200),
      objective: requiredText(row.objective, 'objective', 2_000),
      timezone: requiredText(row.timezone, 'timezone', 100),
      postId: optionalUuid(row.postId, 'postId'),
      contentItemId: optionalUuid(row.contentItemId, 'contentItemId'),
      contentVersionId: optionalUuid(row.contentVersionId, 'contentVersionId'),
      contentSha256: optionalSha(row.contentSha256, 'contentSha256'),
      planSha256: optionalSha(row.planSha256, 'planSha256'),
      scheduledFor: socialCampaignOptionalTimestamp(row.scheduledFor, 'scheduledFor'),
      operationId: optionalUuid(row.operationId, 'operationId'),
      targetId: optionalUuid(row.targetId, 'targetId'),
      network: optionalNetwork(row.network, 'network'),
      targetLabel: row.targetLabel === null ? null : requiredText(row.targetLabel, 'targetLabel', 120),
      state: optionalState(row.state, 'state'),
      simulationAttemptCount: row.simulationAttemptCount === null ? null
        : socialCampaignInteger(row.simulationAttemptCount, 'simulationAttemptCount', 0, 4),
      maxSimulationAttempts: row.maxSimulationAttempts === null ? null
        : socialCampaignInteger(row.maxSimulationAttempts, 'maxSimulationAttempts', 1, 4),
      reconciliationAttemptCount: row.reconciliationAttemptCount === null ? null
        : socialCampaignInteger(row.reconciliationAttemptCount, 'reconciliationAttemptCount', 0, 4),
      maxReconciliationAttempts: row.maxReconciliationAttempts === null ? null
        : socialCampaignInteger(row.maxReconciliationAttempts, 'maxReconciliationAttempts', 1, 4),
      testReferenceSha256: optionalSha(row.testReferenceSha256, 'testReferenceSha256'),
      environment: 'test' as const,
      providerEffects: 'none' as const,
    }));
    return Object.freeze({ items: Object.freeze(items), hasMore: page.hasMore });
  }

  async listCalendar(input: Readonly<{
    workspaceId: string;
    from: string;
    to: string;
    limit?: number;
  }>): Promise<SocialCampaignCalendarProjectionPage> {
    const workspaceId = socialCampaignUuid(input.workspaceId, 'workspaceId');
    const from = socialCampaignTimestamp(input.from, 'from');
    const to = socialCampaignTimestamp(input.to, 'to');
    if (Date.parse(to) <= Date.parse(from)
        || Date.parse(to) - Date.parse(from) > 366 * 24 * 60 * 60 * 1_000) {
      throw new SocialCampaignPgContractError('calendar range is invalid');
    }
    const limit = socialCampaignInteger(input.limit ?? 120, 'limit', 1, 120);
    const result = await this.executor.query<CalendarProjectionRow>(
      `/* social-campaign.list-calendar */
       SELECT campaign_id AS "campaignId", revision_id AS "revisionId",
              revision_number AS "revisionNumber", campaign_title AS "campaignTitle",
              post_id AS "postId", content_item_id AS "contentItemId",
              content_version_id AS "contentVersionId", content_sha256 AS "contentSha256",
              plan_sha256 AS "planSha256", scheduled_for AS "scheduledFor",
              operation_id AS "operationId", target_id AS "targetId",
              network, target_label AS "targetLabel", operation_state AS state,
               simulation_attempt_count AS "simulationAttemptCount",
               max_simulation_attempts AS "maxSimulationAttempts",
               reconciliation_attempt_count AS "reconciliationAttemptCount",
               max_reconciliation_attempts AS "maxReconciliationAttempts",
               updated_at AS "updatedAt", has_more AS "hasMore"
       FROM app_private.list_social_campaign_calendar(
         $1::uuid, $2::timestamptz, $3::timestamptz, $4::integer
       )`,
      [workspaceId, from, to, limit],
    );
    const page = boundedProjectionRows(
      result.rows,
      limit,
      (row) => `post:${socialCampaignUuid(row.postId, 'postId')}`,
      'calendar projection',
    );
    const items = page.rows.map((row) => Object.freeze({
      campaignId: socialCampaignUuid(row.campaignId, 'campaignId'),
      revisionId: socialCampaignUuid(row.revisionId, 'revisionId'),
      revisionNumber: socialCampaignInteger(row.revisionNumber, 'revisionNumber', 1, 1_000_000),
      campaignTitle: requiredText(row.campaignTitle, 'campaignTitle', 200),
      postId: socialCampaignUuid(row.postId, 'postId'),
      contentItemId: socialCampaignUuid(row.contentItemId, 'contentItemId'),
      contentVersionId: socialCampaignUuid(row.contentVersionId, 'contentVersionId'),
      contentSha256: socialCampaignSha256(row.contentSha256, 'contentSha256'),
      planSha256: socialCampaignSha256(row.planSha256, 'planSha256'),
      scheduledFor: socialCampaignTimestamp(row.scheduledFor, 'scheduledFor'),
      operationId: socialCampaignUuid(row.operationId, 'operationId'),
      targetId: socialCampaignUuid(row.targetId, 'targetId'),
      network: socialCampaignNetwork(row.network, 'network'),
      targetLabel: requiredText(row.targetLabel, 'targetLabel', 120),
      state: socialCampaignState(row.state, 'state'),
      simulationAttemptCount: socialCampaignInteger(
        row.simulationAttemptCount, 'simulationAttemptCount', 0, 4,
      ),
      maxSimulationAttempts: socialCampaignInteger(
        row.maxSimulationAttempts, 'maxSimulationAttempts', 1, 4,
      ),
      reconciliationAttemptCount: socialCampaignInteger(
        row.reconciliationAttemptCount, 'reconciliationAttemptCount', 0, 4,
      ),
      maxReconciliationAttempts: socialCampaignInteger(
        row.maxReconciliationAttempts, 'maxReconciliationAttempts', 1, 4,
      ),
      updatedAt: socialCampaignTimestamp(row.updatedAt, 'updatedAt'),
      environment: 'test' as const,
      providerEffects: 'none' as const,
    }));
    return Object.freeze({ items: Object.freeze(items), hasMore: page.hasMore });
  }

  async listPlanningCalendar(input: Readonly<{
    workspaceId: string;
    from: string;
    to: string;
    limit?: number;
  }>): Promise<SocialPlanningCalendarProjectionPage> {
    const workspaceId = socialCampaignUuid(input.workspaceId, 'workspaceId');
    const from = socialCampaignTimestamp(input.from, 'from');
    const to = socialCampaignTimestamp(input.to, 'to');
    if (Date.parse(to) <= Date.parse(from)
        || Date.parse(to) - Date.parse(from) > 366 * 24 * 60 * 60 * 1_000) {
      throw new SocialCampaignPgContractError('planning calendar range is invalid');
    }
    const limit = socialCampaignInteger(input.limit ?? 120, 'limit', 1, 120);
    const result = await this.executor.query<PlanningCalendarRow>(
      `/* social-campaign.list-planning-calendar */
       SELECT intent_id AS "intentId", campaign_id AS "campaignId",
              revision_id AS "revisionId", revision_number AS "revisionNumber",
              campaign_title AS "campaignTitle", desired_for AS "desiredFor",
              content_item_id AS "contentItemId",
              content_version_id AS "contentVersionId",
              content_sha256 AS "contentSha256", intent_sha256 AS "intentSha256",
              target_id AS "targetId", network, target_label AS "targetLabel",
              planning_state AS "planningState",
              materialized_post_id AS "materializedPostId",
              materialized_operation_id AS "materializedOperationId",
              operation_state AS "operationState",
              revalidation_state AS "revalidationState",
              next_revalidation_at AS "nextRevalidationAt",
              last_error_code AS "lastErrorCode", updated_at AS "updatedAt",
              has_more AS "hasMore"
       FROM app_private.list_test_social_planning_calendar(
         $1::uuid, $2::timestamptz, $3::timestamptz, $4::integer
       )`,
      [workspaceId, from, to, limit],
    );
    const page = boundedProjectionRows(
      result.rows,
      limit,
      (row) => `intent:${socialCampaignUuid(row.intentId, 'intentId')}`,
      'planning calendar projection',
    );
    const items = page.rows.map((row) => Object.freeze({
      intentId: socialCampaignUuid(row.intentId, 'intentId'),
      campaignId: socialCampaignUuid(row.campaignId, 'campaignId'),
      revisionId: socialCampaignUuid(row.revisionId, 'revisionId'),
      revisionNumber: socialCampaignInteger(row.revisionNumber, 'revisionNumber', 1, 1_000_000),
      campaignTitle: requiredText(row.campaignTitle, 'campaignTitle', 200),
      desiredFor: socialCampaignTimestamp(row.desiredFor, 'desiredFor'),
      contentItemId: socialCampaignUuid(row.contentItemId, 'contentItemId'),
      contentVersionId: socialCampaignUuid(row.contentVersionId, 'contentVersionId'),
      contentSha256: socialCampaignSha256(row.contentSha256, 'contentSha256'),
      intentSha256: socialCampaignSha256(row.intentSha256, 'intentSha256'),
      targetId: socialCampaignUuid(row.targetId, 'targetId'),
      network: socialCampaignNetwork(row.network, 'network'),
      targetLabel: requiredText(row.targetLabel, 'targetLabel', 120),
      planningState: socialPlanningState(row.planningState, 'planningState'),
      materializedPostId: optionalUuid(row.materializedPostId, 'materializedPostId'),
      materializedOperationId: optionalUuid(
        row.materializedOperationId, 'materializedOperationId',
      ),
      operationState: optionalState(row.operationState, 'operationState'),
      revalidationState: row.revalidationState === null
        ? null : socialRevalidationState(row.revalidationState, 'revalidationState'),
      nextRevalidationAt: socialCampaignOptionalTimestamp(
        row.nextRevalidationAt, 'nextRevalidationAt',
      ),
      lastErrorCode: optionalSafeCode(row.lastErrorCode, 'lastErrorCode'),
      updatedAt: socialCampaignTimestamp(row.updatedAt, 'updatedAt'),
      environment: 'test' as const,
      providerEffects: 'none' as const,
    }));
    return Object.freeze({ items: Object.freeze(items), hasMore: page.hasMore });
  }
}
