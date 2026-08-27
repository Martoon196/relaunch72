import { createHash } from 'node:crypto';
import type { ProviderOperationContext } from '../providers/contracts.js';
import {
  PUBLIC_SOCIAL_DARK_PROVIDER_ID,
  PublicSocialDarkContractError,
  assertPublicSocialDarkContext,
  createPublicSocialDarkPlan,
  socialDarkTimestamp,
  type PublicSocialDarkAdapter,
  type PublicSocialDarkBatch,
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

function batchId(context: ProviderOperationContext): string {
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
  readonly #audit: PublicSocialDarkAudit[] = [];
  readonly #failureBudgets: ReadonlyMap<string, number>;
  readonly #now: () => Date;

  constructor(options: Readonly<{
    now?: () => Date;
    transientFailuresByTargetId?: Readonly<Record<string, number>>;
  }> = {}) {
    this.#now = options.now ?? (() => new Date());
    const budgets = new Map<string, number>();
    for (const [targetId, count] of Object.entries(options.transientFailuresByTargetId ?? {})) {
      if (!TARGET_ID.test(targetId) || !Number.isSafeInteger(count) || count < 0 || count > 3) {
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
    assertPublicSocialDarkContext(context);
    if (!BATCH_ID.test(requestedBatchId)) fail('batchId is invalid');
    const batch = this.#batches.get(requestedBatchId);
    if (!batch || batch.workspaceId !== context.workspaceId
        || batch.connectionId !== context.connectionId || batch.operationId !== context.operationId) {
      fail('batch is not bound to this simulation context');
    }
    return batch;
  }

  scheduleSimulation(context: ProviderOperationContext, plan: PublicSocialDarkPlan): PublicSocialDarkBatch {
    assertPublicSocialDarkContext(context);
    if (plan.mode !== 'simulated_test_only') fail('plan mode is invalid');
    const sealedPlan = createPublicSocialDarkPlan(plan);
    if (sealedPlan.planSha256 !== plan.planSha256) fail('plan hash is invalid');
    const now = this.#now().toISOString();
    if (Date.parse(sealedPlan.scheduledFor) < Date.parse(now)
        || Date.parse(sealedPlan.scheduledFor) > Date.parse(now) + 366 * 24 * 60 * 60 * 1_000) {
      fail('scheduledFor is outside the test scheduling window');
    }
    const requestSha256 = createHash('sha256')
      .update(`${sealedPlan.planSha256}\n${context.idempotencyKey}`, 'utf8').digest('hex');
    const id = batchId(context);
    const existing = this.#batches.get(id);
    if (existing) {
      if (existing.requestSha256 !== requestSha256) fail('operation id was reused with a different social plan');
      return snapshot(existing, 'replayed');
    }
    const batch: InternalBatch = {
      batchId: id,
      workspaceId: context.workspaceId,
      connectionId: context.connectionId,
      operationId: context.operationId,
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
    const batch = this.#boundBatch(context, requestedBatchId);
    const asOf = socialDarkTimestamp(rawAsOf, 'asOf');
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
    const batch = this.#boundBatch(context, requestedBatchId);
    if (!TARGET_ID.test(targetId) || typeof reason !== 'string' || !SAFE_REASON.test(reason)
        || Buffer.byteLength(reason, 'utf8') > 2_000) {
      fail('cancellation input is invalid');
    }
    const target = batch.targets.find((candidate) => candidate.targetId === targetId);
    if (!target) fail('target is not part of this batch');
    if (target.status !== 'waiting_for_test_time' && target.status !== 'retry_wait') {
      fail('target can no longer be cancelled');
    }
    target.status = 'simulated_cancelled';
    target.nextAttemptAt = null;
    target.lastErrorCode = null;
    this.#audit.push(Object.freeze({
      action: 'cancelled', batchId: batch.batchId, targetId, attempt: target.attempts,
      reasonSha256: createHash('sha256').update(reason, 'utf8').digest('hex'),
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
    const batch = this.#boundBatch(context, requestedBatchId);
    if (!TARGET_ID.test(targetId) || !TEST_REFERENCE.test(suppliedReference)) {
      fail('reconciliation input is invalid');
    }
    const target = batch.targets.find((candidate) => candidate.targetId === targetId);
    if (!target || target.testReference !== suppliedReference) fail('simulation cannot be reconciled');
    if (target.status === 'simulated_reconciled') return snapshot(batch, 'replayed');
    if (target.status !== 'simulated_succeeded') fail('simulation cannot be reconciled');
    target.status = 'simulated_reconciled';
    this.#audit.push(Object.freeze({
      action: 'reconciled', batchId: batch.batchId, targetId, attempt: target.attempts,
      reasonSha256: null, externalPublishAttempted: false,
    }));
    return snapshot(batch, 'applied');
  }
}
