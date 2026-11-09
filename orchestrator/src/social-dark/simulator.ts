import { createHash } from 'node:crypto';
import type { ProviderOperationContext } from '../providers/contracts.js';
import {
  PUBLIC_SOCIAL_DARK_PROVIDER_ID,
  PublicSocialDarkContractError,
  assertPublicSocialDarkContext,
  socialDarkTimestamp,
  verifyPublicSocialDarkPlan,
  type PublicSocialDarkAdapter,
  type PublicSocialDarkBatch,
  type PublicSocialDarkContextSnapshot,
  type PublicSocialDarkPlan,
  type PublicSocialDarkTargetState,
} from './contracts.js';

const BATCH_ID = /^social_test_batch_[a-f0-9]{32}$/u;
const TARGET_ID = /^social_test_target_[a-z0-9_]{1,64}$/u;
const TEST_REFERENCE = /^social_test_ref_[a-f0-9]{32}$/u;
const SAFE_REASON = /^[^\u0000-\u001f\u007f]{1,500}$/u;
const RETRY_SECONDS = [60, 300, 1_800] as const;

interface MutableTarget {
  readonly targetId: string;
  readonly network: PublicSocialDarkTargetState['network'];
  readonly testAccountRef: string;
  status: PublicSocialDarkTargetState['status'];
  attempts: number;
  nextAttemptAt: string | null;
  testReference: string | null;
  lastErrorCode: PublicSocialDarkTargetState['lastErrorCode'];
}

interface InternalBatch {
  readonly batchId: string;
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly operationId: string;
  readonly correlationId: string;
  readonly idempotencyKeySha256: string;
  readonly requestSha256: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
  readonly approvalId: string;
  readonly bodySha256: string;
  readonly planSha256: string;
  readonly scheduledFor: string;
  readonly maxAttempts: number;
  readonly targets: MutableTarget[];
}

export interface PublicSocialDarkAudit {
  readonly action: 'scheduled' | 'attempted' | 'retry_planned' | 'failed' | 'cancelled' | 'reconciled';
  readonly batchId: string;
  readonly targetId: string | null;
  readonly attempt: number | null;
  readonly reasonSha256: string | null;
  readonly externalPublishAttempted: false;
}

function fail(message: string): never {
  throw new PublicSocialDarkContractError(message);
}

function addSeconds(timestamp: string, seconds: number): string {
  return new Date(Date.parse(timestamp) + seconds * 1_000).toISOString();
}

function batchId(context: PublicSocialDarkContextSnapshot): string {
  return `social_test_batch_${createHash('sha256')
    .update(`${context.workspaceId}\n${context.connectionId}\n${context.operationId}`, 'utf8')
    .digest('hex').slice(0, 32)}`;
}

function testReference(batch: InternalBatch, target: MutableTarget): string {
  return `social_test_ref_${createHash('sha256')
    .update(`${batch.batchId}\n${target.targetId}\n${target.attempts}`, 'utf8')
    .digest('hex').slice(0, 32)}`;
}

function snapshot(batch: InternalBatch, disposition: PublicSocialDarkBatch['disposition']): PublicSocialDarkBatch {
  const targets = batch.targets.map((target) => Object.freeze({
    targetId: target.targetId,
    network: target.network,
    testAccountRef: target.testAccountRef,
    status: target.status,
    attempts: target.attempts,
    nextAttemptAt: target.nextAttemptAt,
    testReference: target.testReference,
    lastErrorCode: target.lastErrorCode,
    externalPublishAttempted: false as const,
  }));
  return Object.freeze({
    batchId: batch.batchId,
    workspaceId: batch.workspaceId,
    connectionId: batch.connectionId,
    operationId: batch.operationId,
    contentVersionId: batch.contentVersionId,
    contentSha256: batch.contentSha256,
    approvalId: batch.approvalId,
    bodySha256: batch.bodySha256,
    planSha256: batch.planSha256,
    scheduledFor: batch.scheduledFor,
    targets: Object.freeze(targets),
    disposition,
    providerOperationsCreated: 0,
    externalPublishAttempted: false,
  });
}

export class SimulatedPublicSocialDarkAdapter implements PublicSocialDarkAdapter {
  readonly providerId = PUBLIC_SOCIAL_DARK_PROVIDER_ID;
  readonly mode = 'simulated_test_only' as const;
  readonly #batches = new Map<string, InternalBatch>();
  readonly #idempotencyBindings = new Map<string, Readonly<{ batchId: string; requestSha256: string }>>();
  readonly #audit: PublicSocialDarkAudit[] = [];
  readonly #failureBudgets: ReadonlyMap<string, number>;
  readonly #now: () => Date;

  constructor(options: Readonly<{
    now?: () => Date;
    transientFailuresByTargetId?: Readonly<Record<string, number>>;
  }> = {}) {
    if (typeof options !== 'object' || options === null) fail('simulator options are invalid');
    const rawOptions = options as unknown as Record<string, unknown>;
    const rawNow = rawOptions.now;
    const rawBudgets = rawOptions.transientFailuresByTargetId;
    if (rawNow !== undefined && typeof rawNow !== 'function') fail('simulator clock is invalid');
    this.#now = (rawNow as (() => Date) | undefined) ?? (() => new Date());
    const budgets = new Map<string, number>();
    if (rawBudgets !== undefined && (typeof rawBudgets !== 'object' || rawBudgets === null
        || Array.isArray(rawBudgets))) fail('transient failure plan is invalid');
    const budgetEntries = Object.entries(rawBudgets ?? {});
    for (const [targetId, count] of budgetEntries) {
      if (typeof targetId !== 'string' || !TARGET_ID.test(targetId)
          || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 3) {
        fail('transient failure plan is invalid');
      }
      budgets.set(targetId, count);
    }
    this.#failureBudgets = budgets;
  }

  get audit(): readonly PublicSocialDarkAudit[] {
    return Object.freeze(this.#audit.map((entry) => Object.freeze({ ...entry })));
  }

  #boundBatch(context: ProviderOperationContext, requestedBatchId: string): InternalBatch {
    const sealedContext = assertPublicSocialDarkContext(context);
    const batchIdInput: unknown = requestedBatchId;
    if (typeof batchIdInput !== 'string' || !BATCH_ID.test(batchIdInput)) fail('batchId is invalid');
    const batch = this.#batches.get(batchIdInput);
    const idempotencyKeySha256 = createHash('sha256').update(sealedContext.idempotencyKey, 'utf8').digest('hex');
    if (!batch || batch.workspaceId !== sealedContext.workspaceId
        || batch.connectionId !== sealedContext.connectionId || batch.operationId !== sealedContext.operationId
        || batch.correlationId !== sealedContext.correlationId
        || batch.idempotencyKeySha256 !== idempotencyKeySha256) {
      fail('batch is not bound to this simulation context');
    }
    return batch;
  }

  scheduleSimulation(context: ProviderOperationContext, plan: PublicSocialDarkPlan): PublicSocialDarkBatch {
    const sealedContext = assertPublicSocialDarkContext(context);
    const sealedPlan = verifyPublicSocialDarkPlan(plan);
    const rawNow = this.#now();
    if (!(rawNow instanceof Date)) fail('simulator clock returned an invalid instant');
    const nowMilliseconds = Date.prototype.getTime.call(rawNow);
    if (!Number.isFinite(nowMilliseconds)) fail('simulator clock returned an invalid instant');
    const now = new Date(nowMilliseconds).toISOString();
    if (Date.parse(sealedPlan.scheduledFor) < Date.parse(now)
        || Date.parse(sealedPlan.scheduledFor) > Date.parse(now) + 366 * 24 * 60 * 60 * 1_000) {
      fail('scheduledFor is outside the test scheduling window');
    }
    const idempotencyKeySha256 = createHash('sha256')
      .update(sealedContext.idempotencyKey, 'utf8').digest('hex');
    const requestSha256 = createHash('sha256').update(JSON.stringify({
      connectionId: sealedContext.connectionId,
      correlationId: sealedContext.correlationId,
      idempotencyKeySha256,
      operationId: sealedContext.operationId,
      planSha256: sealedPlan.planSha256,
      providerId: sealedContext.providerId,
      workspaceId: sealedContext.workspaceId,
    }), 'utf8').digest('hex');
    const idempotencyBindingKey = createHash('sha256')
      .update(`${sealedContext.workspaceId}\n${sealedContext.connectionId}\n${sealedContext.idempotencyKey}`, 'utf8')
      .digest('hex');
    const idempotencyBinding = this.#idempotencyBindings.get(idempotencyBindingKey);
    if (idempotencyBinding) {
      if (idempotencyBinding.requestSha256 !== requestSha256) {
        fail('idempotency key was reused with different social operation evidence');
      }
      const replay = this.#batches.get(idempotencyBinding.batchId);
      if (!replay) fail('idempotency binding is invalid');
      return snapshot(replay, 'replayed');
    }
    const id = batchId(sealedContext);
    const existing = this.#batches.get(id);
    if (existing) {
      if (existing.requestSha256 !== requestSha256) fail('operation id was reused with a different social plan');
      return snapshot(existing, 'replayed');
    }
    const batch: InternalBatch = {
      batchId: id,
      workspaceId: sealedContext.workspaceId,
      connectionId: sealedContext.connectionId,
      operationId: sealedContext.operationId,
      correlationId: sealedContext.correlationId,
      idempotencyKeySha256,
      requestSha256,
      contentVersionId: sealedPlan.contentVersionId,
      contentSha256: sealedPlan.contentSha256,
      approvalId: sealedPlan.approvalId,
      bodySha256: createHash('sha256').update(sealedPlan.text, 'utf8').digest('hex'),
      planSha256: sealedPlan.planSha256,
      scheduledFor: sealedPlan.scheduledFor,
      maxAttempts: sealedPlan.maxAttempts,
      targets: sealedPlan.targets.map((target) => ({
        ...target,
        status: 'waiting_for_test_time',
        attempts: 0,
        nextAttemptAt: sealedPlan.scheduledFor,
        testReference: null,
        lastErrorCode: null,
      })),
    };
    this.#batches.set(id, batch);
    this.#idempotencyBindings.set(idempotencyBindingKey, Object.freeze({ batchId: id, requestSha256 }));
    this.#audit.push(Object.freeze({
      action: 'scheduled', batchId: id, targetId: null, attempt: null,
      reasonSha256: null, externalPublishAttempted: false,
    }));
    return snapshot(batch, 'applied');
  }

  runDueSimulations(
    context: ProviderOperationContext,
    requestedBatchId: string,
    rawAsOf: string,
  ): PublicSocialDarkBatch {
    const batchIdInput = requestedBatchId;
    const asOfInput = rawAsOf;
    const batch = this.#boundBatch(context, batchIdInput);
    const asOf = socialDarkTimestamp(asOfInput, 'asOf');
    for (const target of batch.targets) {
      if ((target.status !== 'waiting_for_test_time' && target.status !== 'retry_wait')
          || target.nextAttemptAt === null || Date.parse(target.nextAttemptAt) > Date.parse(asOf)) continue;
      target.attempts += 1;
      this.#audit.push(Object.freeze({
        action: 'attempted', batchId: batch.batchId, targetId: target.targetId,
        attempt: target.attempts, reasonSha256: null, externalPublishAttempted: false,
      }));
      const configuredFailures = this.#failureBudgets.get(target.targetId) ?? 0;
      if (target.attempts <= configuredFailures) {
        if (target.attempts < batch.maxAttempts) {
          target.status = 'retry_wait';
          target.nextAttemptAt = addSeconds(asOf, RETRY_SECONDS[Math.min(target.attempts - 1, 2)]!);
          target.lastErrorCode = 'simulated_transient_failure';
          this.#audit.push(Object.freeze({
            action: 'retry_planned', batchId: batch.batchId, targetId: target.targetId,
            attempt: target.attempts, reasonSha256: null, externalPublishAttempted: false,
          }));
        } else {
          target.status = 'simulated_failed';
          target.nextAttemptAt = null;
          target.lastErrorCode = 'simulated_attempts_exhausted';
          this.#audit.push(Object.freeze({
            action: 'failed', batchId: batch.batchId, targetId: target.targetId,
            attempt: target.attempts, reasonSha256: null, externalPublishAttempted: false,
          }));
        }
        continue;
      }
      target.status = 'simulated_succeeded';
      target.nextAttemptAt = null;
      target.lastErrorCode = null;
      target.testReference = testReference(batch, target);
    }
    return snapshot(batch, 'applied');
  }

  cancelTargetSimulation(
    context: ProviderOperationContext,
    requestedBatchId: string,
    targetId: string,
    reason: string,
  ): PublicSocialDarkBatch {
    const batchIdInput = requestedBatchId;
    const targetIdInput: unknown = targetId;
    const reasonInput: unknown = reason;
    const batch = this.#boundBatch(context, batchIdInput);
    if (typeof targetIdInput !== 'string' || !TARGET_ID.test(targetIdInput)
        || typeof reasonInput !== 'string' || !SAFE_REASON.test(reasonInput)
        || Buffer.byteLength(reasonInput, 'utf8') > 2_000) {
      fail('cancellation input is invalid');
    }
    const target = batch.targets.find((candidate) => candidate.targetId === targetIdInput);
    if (!target) fail('target is not part of this batch');
    if (target.status !== 'waiting_for_test_time' && target.status !== 'retry_wait') {
      fail('target can no longer be cancelled');
    }
    target.status = 'simulated_cancelled';
    target.nextAttemptAt = null;
    target.lastErrorCode = null;
    this.#audit.push(Object.freeze({
      action: 'cancelled', batchId: batch.batchId, targetId: targetIdInput, attempt: target.attempts,
      reasonSha256: createHash('sha256').update(reasonInput, 'utf8').digest('hex'),
      externalPublishAttempted: false,
    }));
    return snapshot(batch, 'applied');
  }

  reconcileSimulation(
    context: ProviderOperationContext,
    requestedBatchId: string,
    targetId: string,
    suppliedReference: string,
  ): PublicSocialDarkBatch {
    const batchIdInput = requestedBatchId;
    const targetIdInput: unknown = targetId;
    const referenceInput: unknown = suppliedReference;
    const batch = this.#boundBatch(context, batchIdInput);
    if (typeof targetIdInput !== 'string' || !TARGET_ID.test(targetIdInput)
        || typeof referenceInput !== 'string' || !TEST_REFERENCE.test(referenceInput)) {
      fail('reconciliation input is invalid');
    }
    const target = batch.targets.find((candidate) => candidate.targetId === targetIdInput);
    if (!target || target.testReference !== referenceInput) fail('simulation cannot be reconciled');
    if (target.status === 'simulated_reconciled') return snapshot(batch, 'replayed');
    if (target.status !== 'simulated_succeeded') fail('simulation cannot be reconciled');
    target.status = 'simulated_reconciled';
    this.#audit.push(Object.freeze({
      action: 'reconciled', batchId: batch.batchId, targetId: targetIdInput, attempt: target.attempts,
      reasonSha256: null, externalPublishAttempted: false,
    }));
    return snapshot(batch, 'applied');
  }
}
