import { createHash } from 'node:crypto';
import type { SocialNetwork } from '../providers/contracts.js';
import { verifyPublicSocialDarkPlan } from '../social-dark/contracts.js';
import {
  SocialCampaignPgContractError,
  type CancelSocialCampaignTargetCommand,
  type CreateSocialCampaignRevisionCommand,
  type RegisterSocialCampaignTestTargetCommand,
  type ScheduleSocialCampaignCommand,
  type SocialCampaignApprovedMediaBinding,
  type SocialCampaignTargetState,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const TEST_ACCOUNT = /^test-account:([a-z_]+):[a-z0-9_-]{1,64}$/u;
const SAFE_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]*$/u;
const SAFE_KEY = /^[\x21-\x7e]{1,200}$/u;
const SAFE_CODE = /^[a-z][a-z0-9_.:-]{0,99}$/u;

export const PUBLIC_SOCIAL_NETWORKS = Object.freeze([
  'facebook', 'instagram', 'linkedin', 'tiktok', 'x', 'youtube',
  'google_business_profile', 'threads', 'pinterest',
] as const satisfies readonly SocialNetwork[]);
const NETWORKS = new Set<string>(PUBLIC_SOCIAL_NETWORKS);

export const PUBLIC_SOCIAL_TEST_STATES = Object.freeze([
  'waiting_for_test_time', 'leased', 'calling_simulator', 'retry_wait',
  'simulated_succeeded', 'simulated_failed', 'simulated_cancelled',
  'reconciliation_required', 'simulated_reconciled', 'dead_letter',
] as const satisfies readonly SocialCampaignTargetState[]);
const STATES = new Set<string>(PUBLIC_SOCIAL_TEST_STATES);

function fail(message: string): never {
  throw new SocialCampaignPgContractError(message);
}

export function socialCampaignUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} must be a canonical UUID`);
  return value;
}

export function socialCampaignSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${label} must be a lowercase SHA-256`);
  return value;
}

export function socialCampaignTimestamp(value: unknown, label: string): string {
  const canonical = value instanceof Date && Number.isFinite(Date.prototype.getTime.call(value))
    ? new Date(Date.prototype.getTime.call(value)).toISOString()
    : value;
  if (typeof canonical !== 'string' || !RFC3339_UTC.test(canonical)
      || Number.isNaN(Date.parse(canonical)) || new Date(canonical).toISOString() !== canonical) {
    fail(`${label} must be a canonical UTC timestamp`);
  }
  return canonical;
}

export function socialCampaignOptionalTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : socialCampaignTimestamp(value, label);
}

export function socialCampaignInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

export function socialCampaignNetwork(value: unknown, label: string): SocialNetwork {
  if (typeof value !== 'string' || !NETWORKS.has(value)) fail(`${label} is invalid`);
  return value as SocialNetwork;
}

export function socialCampaignState(value: unknown, label: string): SocialCampaignTargetState {
  if (typeof value !== 'string' || !STATES.has(value)) fail(`${label} is invalid`);
  return value as SocialCampaignTargetState;
}

export function socialCampaignSafeKey(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_KEY.test(value)) fail(`${label} is invalid`);
  return value;
}

export function socialCampaignSafeCode(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_CODE.test(value)) fail(`${label} is invalid`);
  return value;
}

export function socialCampaignBoundedText(
  value: unknown,
  label: string,
  minimumBytes: number,
  maximumBytes: number,
): string {
  if (typeof value !== 'string' || !SAFE_TEXT.test(value)) fail(`${label} is invalid`);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (value !== value.trim() || bytes < minimumBytes || bytes > maximumBytes) fail(`${label} is invalid`);
  return value;
}

export function socialCampaignDisposition(value: unknown): 'applied' | 'replayed' {
  if (value !== 'applied' && value !== 'replayed') fail('disposition is invalid');
  return value;
}

function revisionField(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

export function socialCampaignRevisionSha256(
  input: Omit<CreateSocialCampaignRevisionCommand, 'revisionSha256'>,
): string {
  const canonical = [
    'public-social-revision/v1',
    revisionField(input.workspaceId),
    revisionField(input.campaignId),
    revisionField(input.revisionId),
    revisionField(String(input.revisionNumber)),
    input.previousRevisionId === null ? '-1:' : revisionField(input.previousRevisionId),
    revisionField(input.title),
    revisionField(input.objective),
    revisionField(input.timezone),
  ].join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function validateCreateSocialCampaignRevision(
  input: CreateSocialCampaignRevisionCommand,
): CreateSocialCampaignRevisionCommand {
  const workspaceId = socialCampaignUuid(input.workspaceId, 'workspaceId');
  const campaignId = socialCampaignUuid(input.campaignId, 'campaignId');
  const revisionId = socialCampaignUuid(input.revisionId, 'revisionId');
  const revisionNumber = socialCampaignInteger(input.revisionNumber, 'revisionNumber', 1, 1_000_000);
  const previousRevisionId = input.previousRevisionId === null
    ? null : socialCampaignUuid(input.previousRevisionId, 'previousRevisionId');
  if ((revisionNumber === 1) !== (previousRevisionId === null)) {
    fail('previousRevisionId must be absent only for revision one');
  }
  const title = socialCampaignBoundedText(input.title, 'title', 1, 200);
  const objective = socialCampaignBoundedText(input.objective, 'objective', 1, 2_000);
  const timezone = socialCampaignBoundedText(input.timezone, 'timezone', 1, 100);
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).format(new Date(0));
  } catch {
    fail('timezone is invalid');
  }
  const normalized = {
    workspaceId, campaignId, revisionId, revisionNumber, previousRevisionId,
    title, objective, timezone,
  };
  const revisionSha256 = socialCampaignSha256(input.revisionSha256, 'revisionSha256');
  if (revisionSha256 !== socialCampaignRevisionSha256(normalized)) {
    fail('revisionSha256 does not match the canonical campaign revision');
  }
  return Object.freeze({ ...normalized, revisionSha256 });
}

export function validateRegisterSocialCampaignTestTarget(
  input: RegisterSocialCampaignTestTargetCommand,
): RegisterSocialCampaignTestTargetCommand {
  const workspaceId = socialCampaignUuid(input.workspaceId, 'workspaceId');
  const targetId = socialCampaignUuid(input.targetId, 'targetId');
  const connectionId = socialCampaignUuid(input.connectionId, 'connectionId');
  const network = socialCampaignNetwork(input.network, 'network');
  const testAccountRef = socialCampaignBoundedText(
    input.testAccountRef, 'testAccountRef', 1, 128,
  );
  const match = TEST_ACCOUNT.exec(testAccountRef);
  if (!match || match[1] !== network) fail('testAccountRef is not bound to its network');
  const displayName = socialCampaignBoundedText(input.displayName, 'displayName', 1, 120);
  return Object.freeze({ workspaceId, targetId, connectionId, network, testAccountRef, displayName });
}

export interface ValidatedScheduleSocialCampaign extends Omit<
  ScheduleSocialCampaignCommand,
  'plan' | 'targetBindings' | 'mediaBindings'
> {
  readonly plan: ReturnType<typeof verifyPublicSocialDarkPlan>;
  readonly targetIds: readonly string[];
  readonly media: readonly Omit<SocialCampaignApprovedMediaBinding, 'planArtifactId'>[];
}

export function validateScheduleSocialCampaign(
  input: ScheduleSocialCampaignCommand,
): ValidatedScheduleSocialCampaign {
  const workspaceId = socialCampaignUuid(input.workspaceId, 'workspaceId');
  const postId = socialCampaignUuid(input.postId, 'postId');
  const campaignId = socialCampaignUuid(input.campaignId, 'campaignId');
  const revisionId = socialCampaignUuid(input.revisionId, 'revisionId');
  const contentItemId = socialCampaignUuid(input.contentItemId, 'contentItemId');
  const approvalRequestId = socialCampaignUuid(input.approvalRequestId, 'approvalRequestId');
  const approvalDecisionId = socialCampaignUuid(input.approvalDecisionId, 'approvalDecisionId');
  const sourceAttestationId = socialCampaignUuid(input.sourceAttestationId, 'sourceAttestationId');
  const plan = verifyPublicSocialDarkPlan(input.plan);
  const bodySha256 = createHash('sha256').update(plan.text, 'utf8').digest('hex');
  if (bodySha256 !== plan.contentSha256) {
    fail('sealed plan body does not match the exact approved content hash');
  }
  if (plan.approvalId !== approvalDecisionId) fail('plan approval is not the exact approval decision');
  const bindings = Array.isArray(input.targetBindings) ? [...input.targetBindings] : fail('targetBindings is invalid');
  if (bindings.length !== plan.targets.length) fail('targetBindings do not cover the sealed plan');
  const byPlanTarget = new Map<string, string>();
  const databaseIds = new Set<string>();
  for (const binding of bindings) {
    if (typeof binding !== 'object' || binding === null) fail('target binding is invalid');
    const targetId = socialCampaignUuid(binding.targetId, 'targetBindings.targetId');
    if (typeof binding.planTargetId !== 'string'
        || !plan.targets.some((target) => target.targetId === binding.planTargetId)
        || byPlanTarget.has(binding.planTargetId) || databaseIds.has(targetId)) {
      fail('target bindings must uniquely cover the sealed plan');
    }
    byPlanTarget.set(binding.planTargetId, targetId);
    databaseIds.add(targetId);
  }
  const targetIds = plan.targets.map((target) => {
    const targetId = byPlanTarget.get(target.targetId);
    if (!targetId) fail('targetBindings do not cover the sealed plan');
    return targetId;
  });
  const mediaBindings = Array.isArray(input.mediaBindings) ? [...input.mediaBindings]
    : fail('mediaBindings is invalid');
  if (mediaBindings.length !== plan.media.length) fail('mediaBindings do not cover the sealed plan');
  const byPlanArtifact = new Map<string, Omit<SocialCampaignApprovedMediaBinding, 'planArtifactId'>>();
  for (const binding of mediaBindings) {
    if (typeof binding !== 'object' || binding === null
        || typeof binding.planArtifactId !== 'string'
        || !plan.media.some((item) => item.artifactId === binding.planArtifactId)
        || byPlanArtifact.has(binding.planArtifactId)) {
      fail('media bindings must uniquely cover the sealed plan');
    }
    const contentItemId = socialCampaignUuid(binding.contentItemId, 'mediaBindings.contentItemId');
    const contentVersionId = socialCampaignUuid(binding.contentVersionId, 'mediaBindings.contentVersionId');
    const contentSha256 = socialCampaignSha256(binding.contentSha256, 'mediaBindings.contentSha256');
    const blobSha256 = socialCampaignSha256(binding.blobSha256, 'mediaBindings.blobSha256');
    const approvalRequestId = socialCampaignUuid(
      binding.approvalRequestId, 'mediaBindings.approvalRequestId',
    );
    const approvalDecisionId = socialCampaignUuid(
      binding.approvalDecisionId, 'mediaBindings.approvalDecisionId',
    );
    const sourceAttestationId = socialCampaignUuid(
      binding.sourceAttestationId, 'mediaBindings.sourceAttestationId',
    );
    const sealedMedia = plan.media.find((item) => item.artifactId === binding.planArtifactId)!;
    if (sealedMedia.sha256 !== contentSha256) fail('media binding hash does not match the sealed plan');
    byPlanArtifact.set(binding.planArtifactId, Object.freeze({
      contentItemId, contentVersionId, contentSha256, blobSha256,
      approvalRequestId, approvalDecisionId, sourceAttestationId,
    }));
  }
  const media = plan.media.map((item) => {
    const binding = byPlanArtifact.get(item.artifactId);
    if (!binding) fail('mediaBindings do not cover the sealed plan');
    return binding;
  });
  return Object.freeze({
    workspaceId, postId, campaignId, revisionId, contentItemId,
    approvalRequestId, approvalDecisionId, sourceAttestationId,
    plan, targetIds: Object.freeze(targetIds), media: Object.freeze(media),
  });
}

export function validateCancelSocialCampaignTarget(
  input: CancelSocialCampaignTargetCommand,
): Readonly<{ workspaceId: string; operationId: string; reasonSha256: string }> {
  const workspaceId = socialCampaignUuid(input.workspaceId, 'workspaceId');
  const operationId = socialCampaignUuid(input.operationId, 'operationId');
  const reason = socialCampaignBoundedText(input.reason, 'reason', 1, 2_000);
  return Object.freeze({
    workspaceId,
    operationId,
    reasonSha256: createHash('sha256').update(reason, 'utf8').digest('hex'),
  });
}
