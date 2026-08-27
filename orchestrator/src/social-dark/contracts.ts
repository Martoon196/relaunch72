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

export interface PublicSocialDarkContextSnapshot extends ProviderOperationContext {
  readonly providerId: typeof PUBLIC_SOCIAL_DARK_PROVIDER_ID;
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

export function assertPublicSocialDarkContext(
  context: ProviderOperationContext,
): PublicSocialDarkContextSnapshot {
  if (typeof context !== 'object' || context === null) fail('provider context is invalid');
  const source = context as unknown as Record<string, unknown>;
  const snapshot = {
    workspaceId: source.workspaceId,
    connectionId: source.connectionId,
    providerId: source.providerId,
    operationId: source.operationId,
    idempotencyKey: source.idempotencyKey,
    correlationId: source.correlationId,
  };
  if (snapshot.providerId !== PUBLIC_SOCIAL_DARK_PROVIDER_ID) {
    fail('provider context is not the dark simulator');
  }
  const workspaceId = socialDarkUuid(snapshot.workspaceId, 'context.workspaceId');
  const connectionId = socialDarkUuid(snapshot.connectionId, 'context.connectionId');
  const operationId = socialDarkUuid(snapshot.operationId, 'context.operationId');
  const correlationId = socialDarkUuid(snapshot.correlationId, 'context.correlationId');
  if (typeof snapshot.idempotencyKey !== 'string' || snapshot.idempotencyKey.length < 1
      || snapshot.idempotencyKey.length > 200 || !SAFE_TEXT.test(snapshot.idempotencyKey)) {
    fail('context.idempotencyKey is invalid');
  }
  return Object.freeze({
    workspaceId,
    connectionId,
    providerId: PUBLIC_SOCIAL_DARK_PROVIDER_ID,
    operationId,
    idempotencyKey: snapshot.idempotencyKey,
    correlationId,
  });
}

function safeText(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== 'string' || value.length < 1 || !SAFE_TEXT.test(value)
      || Buffer.byteLength(value, 'utf8') > maximumBytes) fail(`${label} is invalid`);
  return value;
}

interface PublicSocialDarkMediaSnapshot {
  readonly artifactId: unknown;
  readonly sha256: unknown;
}

interface PublicSocialDarkTargetSnapshot {
  readonly targetId: unknown;
  readonly network: unknown;
  readonly testAccountRef: unknown;
}

interface PublicSocialDarkPlanSnapshot {
  readonly contentVersionId: unknown;
  readonly contentSha256: unknown;
  readonly approvalId: unknown;
  readonly text: unknown;
  readonly media: readonly PublicSocialDarkMediaSnapshot[];
  readonly targets: readonly PublicSocialDarkTargetSnapshot[];
  readonly scheduledFor: unknown;
  readonly maxAttempts: unknown;
  readonly mode: unknown;
  readonly planSha256: unknown;
}

function snapshotArray(value: unknown, label: string, minimum: number, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) fail(`${label} is invalid`);
  const length: unknown = value.length;
  if (typeof length !== 'number' || !Number.isSafeInteger(length)
      || length < minimum || length > maximum) fail(`${label} is invalid`);
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) snapshot.push(value[index]);
  return Object.freeze(snapshot);
}

function snapshotMedia(value: unknown): PublicSocialDarkMediaSnapshot {
  if (typeof value !== 'object' || value === null) fail('media evidence is invalid');
  const source = value as Record<string, unknown>;
  return Object.freeze({ artifactId: source.artifactId, sha256: source.sha256 });
}

function snapshotTarget(value: unknown): PublicSocialDarkTargetSnapshot {
  if (typeof value !== 'object' || value === null) fail('target is invalid');
  const source = value as Record<string, unknown>;
  return Object.freeze({
    targetId: source.targetId,
    network: source.network,
    testAccountRef: source.testAccountRef,
  });
}

function snapshotPublicSocialDarkPlan(input: PublicSocialDarkPlanInput): PublicSocialDarkPlanSnapshot {
  if (typeof input !== 'object' || input === null) fail('plan is invalid');
  const source = input as unknown as Record<string, unknown>;
  const topLevel = {
    contentVersionId: source.contentVersionId,
    contentSha256: source.contentSha256,
    approvalId: source.approvalId,
    text: source.text,
    media: source.media,
    targets: source.targets,
    scheduledFor: source.scheduledFor,
    maxAttempts: source.maxAttempts,
    mode: source.mode,
    planSha256: source.planSha256,
  };
  const media = snapshotArray(topLevel.media, 'media', 0, 10).map(snapshotMedia);
  const targets = snapshotArray(topLevel.targets, 'targets', 1, 9).map(snapshotTarget);
  return Object.freeze({
    ...topLevel,
    media: Object.freeze(media),
    targets: Object.freeze(targets),
  });
}

function sealPublicSocialDarkPlan(snapshot: PublicSocialDarkPlanSnapshot): PublicSocialDarkPlan {
  const contentVersionId = socialDarkUuid(snapshot.contentVersionId, 'contentVersionId');
  const approvalId = socialDarkUuid(snapshot.approvalId, 'approvalId');
  if (typeof snapshot.contentSha256 !== 'string' || !SHA256.test(snapshot.contentSha256)) {
    fail('contentSha256 is invalid');
  }
  const text = safeText(snapshot.text, 'text', 16_384);
  const scheduledFor = socialDarkTimestamp(snapshot.scheduledFor, 'scheduledFor');
  if (typeof snapshot.maxAttempts !== 'number' || !Number.isSafeInteger(snapshot.maxAttempts)
      || snapshot.maxAttempts < 1 || snapshot.maxAttempts > 4) {
    fail('maxAttempts is invalid');
  }
  const mediaIds = new Set<string>();
  const media = snapshot.media.map((item) => {
    const artifactId = socialDarkUuid(item.artifactId, 'media.artifactId');
    const sha256 = item.sha256;
    if (mediaIds.has(artifactId) || typeof sha256 !== 'string' || !SHA256.test(sha256)) {
      fail('media evidence is invalid');
    }
    mediaIds.add(artifactId);
    return Object.freeze({ artifactId, sha256 });
  });
  const targetIds = new Set<string>();
  const targetBindings = new Set<string>();
  const targets = snapshot.targets.map((target) => {
    const { targetId, network, testAccountRef } = target;
    if (typeof targetId !== 'string' || !TARGET_ID.test(targetId)
        || typeof network !== 'string' || !NETWORKS.has(network as SocialNetwork)
        || typeof testAccountRef !== 'string') fail('target is invalid');
    const match = TEST_ACCOUNT.exec(testAccountRef);
    if (!match || match[1] !== network) fail('target must use its network-bound test account');
    const binding = `${network}\n${testAccountRef}`;
    if (targetIds.has(targetId) || targetBindings.has(binding)) fail('targets must be unique');
    targetIds.add(targetId);
    targetBindings.add(binding);
    return Object.freeze({
      targetId,
      network: network as SocialNetwork,
      testAccountRef,
    });
  });
  const canonical = JSON.stringify({
    approvalId, contentSha256: snapshot.contentSha256, contentVersionId,
    maxAttempts: snapshot.maxAttempts, media, scheduledFor, targets, text,
  });
  return Object.freeze({
    contentVersionId,
    contentSha256: snapshot.contentSha256,
    approvalId,
    text,
    media: Object.freeze(media),
    targets: Object.freeze(targets),
    scheduledFor,
    maxAttempts: snapshot.maxAttempts,
    mode: 'simulated_test_only',
    planSha256: createHash('sha256').update(canonical, 'utf8').digest('hex'),
  });
}

export function createPublicSocialDarkPlan(input: PublicSocialDarkPlanInput): PublicSocialDarkPlan {
  return sealPublicSocialDarkPlan(snapshotPublicSocialDarkPlan(input));
}

export function verifyPublicSocialDarkPlan(input: PublicSocialDarkPlan): PublicSocialDarkPlan {
  const snapshot = snapshotPublicSocialDarkPlan(input);
  if (snapshot.mode !== 'simulated_test_only'
      || typeof snapshot.planSha256 !== 'string' || !SHA256.test(snapshot.planSha256)) {
    fail('plan seal is invalid');
  }
  const sealed = sealPublicSocialDarkPlan(snapshot);
  if (sealed.planSha256 !== snapshot.planSha256) fail('plan hash is invalid');
  return sealed;
}
