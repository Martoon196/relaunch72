import type { SqlExecutor } from '../crm-pg/types.js';
import {
  SocialCampaignPgContractError,
  type CancelSocialCampaignTargetCommand,
  type CancelSocialCampaignTargetResult,
  type CreateSocialCampaignRevisionCommand,
  type CreateSocialCampaignRevisionResult,
  type RegisterSocialCampaignTestTargetCommand,
  type RegisterSocialCampaignTestTargetResult,
  type ResolvedSocialCampaignTestTarget,
  type ScheduleSocialCampaignCommand,
  type ScheduleSocialCampaignResult,
  type SocialCampaignCalendarProjection,
  type SocialCampaignCalendarProjectionPage,
  type SocialCampaignCommandProjection,
  type SocialCampaignCommandProjectionPage,
} from './types.js';
import {
  socialCampaignDisposition,
  socialCampaignInteger,
  socialCampaignNetwork,
  socialCampaignOptionalTimestamp,
  socialCampaignSha256,
  socialCampaignState,
  socialCampaignTimestamp,
  socialCampaignUuid,
  validateCancelSocialCampaignTarget,
  validateCreateSocialCampaignRevision,
  validateRegisterSocialCampaignTestTarget,
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
    return Object.freeze({
      campaignId: socialCampaignUuid(row.campaignId, 'campaignId'),
      revisionId: socialCampaignUuid(row.revisionId, 'revisionId'),
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
}

/** Function-only read boundary for safe portal projections. */
export class PgSocialCampaignReadRepository {
  constructor(private readonly executor: SqlExecutor) {}

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
}
