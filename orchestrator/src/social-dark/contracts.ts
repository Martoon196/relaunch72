import { createHash } from 'node:crypto';
import type { ProviderOperationContext, SocialNetwork } from '../providers/contracts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const TARGET_ID = /^social_test_target_[a-z0-9_]{1,64}$/u;
const TEST_ACCOUNT = /^test-account:([a-z_]+):[a-z0-9_-]{1,64}$/u;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u;
const NETWORKS = new Set<SocialNetwork>([
  'facebook', 'instagram', 'linkedin', 'tiktok', 'x', 'youtube',
  'google_business_profile', 'threads', 'pinterest',
]);

export const PUBLIC_SOCIAL_DARK_PROVIDER_ID = 'public_social_dark_simulator';

export interface PublicSocialDarkTargetInput {
  readonly targetId: string;
  readonly network: SocialNetwork;
  readonly testAccountRef: string;
}

export interface PublicSocialDarkMediaInput {
  readonly artifactId: string;
  readonly sha256: string;
}

export interface PublicSocialDarkPlanInput {
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly approvalId: string;
  readonly text: string;
  readonly media: readonly PublicSocialDarkMediaInput[];
  readonly targets: readonly PublicSocialDarkTargetInput[];
  readonly scheduledFor: string;
  readonly maxAttempts: number;
}

export interface PublicSocialDarkPlan extends PublicSocialDarkPlanInput {
  readonly mode: 'simulated_test_only';
  readonly planSha256: string;
}

export type PublicSocialDarkTargetStatus =
  | 'waiting_for_test_time'
  | 'retry_wait'
  | 'simulated_succeeded'
  | 'simulated_failed'
  | 'simulated_cancelled'
  | 'simulated_reconciled';

export interface PublicSocialDarkTargetState {
  readonly targetId: string;
  readonly network: SocialNetwork;
  readonly testAccountRef: string;
  readonly status: PublicSocialDarkTargetStatus;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly testReference: string | null;
  readonly lastErrorCode: 'simulated_transient_failure' | 'simulated_attempts_exhausted' | null;
  readonly externalPublishAttempted: false;
}

export interface PublicSocialDarkBatch {
  readonly batchId: string;
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly operationId: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly approvalId: string;
  readonly bodySha256: string;
  readonly planSha256: string;
  readonly scheduledFor: string;
  readonly targets: readonly PublicSocialDarkTargetState[];
  readonly disposition: 'applied' | 'replayed';
  readonly providerOperationsCreated: 0;
  readonly externalPublishAttempted: false;
}

export interface PublicSocialDarkAdapter {
  readonly providerId: typeof PUBLIC_SOCIAL_DARK_PROVIDER_ID;
  readonly mode: 'simulated_test_only';
  scheduleSimulation(context: ProviderOperationContext, plan: PublicSocialDarkPlan): PublicSocialDarkBatch;
  runDueSimulations(context: ProviderOperationContext, batchId: string, asOf: string): PublicSocialDarkBatch;
  cancelTargetSimulation(
    context: ProviderOperationContext,
    batchId: string,
    targetId: string,
    reason: string,
  ): PublicSocialDarkBatch;
  reconcileSimulation(
    context: ProviderOperationContext,
    batchId: string,
    targetId: string,
    testReference: string,
  ): PublicSocialDarkBatch;
}

export class PublicSocialDarkContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicSocialDarkContractError';
  }
}

function fail(message: string): never {
  throw new PublicSocialDarkContractError(message);
}

export function socialDarkUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} must be a canonical UUID`);
  return value;
}

export function socialDarkTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !RFC3339_UTC.test(value)
      || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

export function assertPublicSocialDarkContext(context: ProviderOperationContext): void {
  if (context.providerId !== PUBLIC_SOCIAL_DARK_PROVIDER_ID) fail('provider context is not the dark simulator');
  socialDarkUuid(context.workspaceId, 'context.workspaceId');
  socialDarkUuid(context.connectionId, 'context.connectionId');
  socialDarkUuid(context.operationId, 'context.operationId');
  socialDarkUuid(context.correlationId, 'context.correlationId');
  if (typeof context.idempotencyKey !== 'string' || context.idempotencyKey.length < 1
      || context.idempotencyKey.length > 200 || !SAFE_TEXT.test(context.idempotencyKey)) {
    fail('context.idempotencyKey is invalid');
  }
}

function safeText(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== 'string' || value.length < 1 || !SAFE_TEXT.test(value)
      || Buffer.byteLength(value, 'utf8') > maximumBytes) fail(`${label} is invalid`);
  return value;
}

export function createPublicSocialDarkPlan(input: PublicSocialDarkPlanInput): PublicSocialDarkPlan {
  const contentVersionId = socialDarkUuid(input.contentVersionId, 'contentVersionId');
  const approvalId = socialDarkUuid(input.approvalId, 'approvalId');
  if (typeof input.contentSha256 !== 'string' || !SHA256.test(input.contentSha256)) {
    fail('contentSha256 is invalid');
  }
  const text = safeText(input.text, 'text', 16_384);
  const scheduledFor = socialDarkTimestamp(input.scheduledFor, 'scheduledFor');
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 4) {
    fail('maxAttempts is invalid');
  }
  if (!Array.isArray(input.media) || input.media.length > 10) fail('media is invalid');
  const mediaIds = new Set<string>();
  const media = input.media.map((item) => {
    const artifactId = socialDarkUuid(item.artifactId, 'media.artifactId');
    if (mediaIds.has(artifactId) || typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)) {
      fail('media evidence is invalid');
    }
    mediaIds.add(artifactId);
    return Object.freeze({ artifactId, sha256: item.sha256 });
  });
  if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 9) {
    fail('targets are invalid');
  }
  const targetIds = new Set<string>();
  const targetBindings = new Set<string>();
  const targets = input.targets.map((target) => {
    if (typeof target.targetId !== 'string' || !TARGET_ID.test(target.targetId)
        || !NETWORKS.has(target.network)) fail('target is invalid');
    const match = typeof target.testAccountRef === 'string' ? TEST_ACCOUNT.exec(target.testAccountRef) : null;
    if (!match || match[1] !== target.network) fail('target must use its network-bound test account');
    const binding = `${target.network}\n${target.testAccountRef}`;
    if (targetIds.has(target.targetId) || targetBindings.has(binding)) fail('targets must be unique');
    targetIds.add(target.targetId);
    targetBindings.add(binding);
    return Object.freeze({
      targetId: target.targetId,
      network: target.network,
      testAccountRef: target.testAccountRef,
    });
  });
  const canonical = JSON.stringify({
    approvalId, contentSha256: input.contentSha256, contentVersionId,
    maxAttempts: input.maxAttempts, media, scheduledFor, targets, text,
  });
  return Object.freeze({
    contentVersionId,
    contentSha256: input.contentSha256,
    approvalId,
    text,
    media: Object.freeze(media),
    targets: Object.freeze(targets),
    scheduledFor,
    maxAttempts: input.maxAttempts,
    mode: 'simulated_test_only',
    planSha256: createHash('sha256').update(canonical, 'utf8').digest('hex'),
  });
}
