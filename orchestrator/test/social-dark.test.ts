import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ProviderOperationContext } from '../src/providers/contracts.js';
import {
  PublicSocialDarkContractError,
  SimulatedPublicSocialDarkAdapter,
  createPublicSocialDarkPlan,
} from '../src/social-dark/index.js';

const NOW = new Date('2026-08-27T15:00:00.000Z');
const context: ProviderOperationContext = Object.freeze({
  workspaceId: '11111111-1111-4111-8111-111111111111',
  connectionId: '22222222-2222-4222-8222-222222222222',
  providerId: 'public_social_dark_simulator',
  operationId: '33333333-3333-4333-8333-333333333333',
  idempotencyKey: 'social-dark-plan-1',
  correlationId: '44444444-4444-4444-8444-444444444444',
});

function plan(overrides: Record<string, unknown> = {}) {
  return createPublicSocialDarkPlan({
    contentVersionId: '55555555-5555-4555-8555-555555555555',
    contentSha256: 'a'.repeat(64),
    approvalId: '66666666-6666-4666-8666-666666666666',
    text: 'A fictional Property Predator test post. Nothing leaves this process.',
    media: [{ artifactId: '77777777-7777-4777-8777-777777777777', sha256: 'b'.repeat(64) }],
    targets: [
      { targetId: 'social_test_target_facebook', network: 'facebook', testAccountRef: 'test-account:facebook:property-predator' },
      { targetId: 'social_test_target_linkedin', network: 'linkedin', testAccountRef: 'test-account:linkedin:property-predator' },
      { targetId: 'social_test_target_instagram', network: 'instagram', testAccountRef: 'test-account:instagram:property-predator' },
    ],
    scheduledFor: '2026-08-27T15:01:00.000Z',
    maxAttempts: 3,
    ...overrides,
  });
}

test('plan is immutable and rejects real, mismatched or duplicate account targets', () => {
  const created = plan();
  assert.equal(created.mode, 'simulated_test_only');
  assert.match(created.planSha256, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(created));
  assert.ok(Object.isFrozen(created.targets));
  assert.throws(() => plan({
    targets: [{ targetId: 'social_test_target_real', network: 'facebook', testAccountRef: 'facebook:real-account' }],
  }), PublicSocialDarkContractError);
  const adapter = new SimulatedPublicSocialDarkAdapter({ now: () => NOW });
  assert.throws(() => adapter.scheduleSimulation(context, {
    ...created,
    targets: [{
      targetId: 'social_test_target_forged', network: 'facebook',
      testAccountRef: 'facebook:real-account',
    }],
  }), PublicSocialDarkContractError);
  assert.throws(() => plan({
    targets: [{ targetId: 'social_test_target_wrong', network: 'facebook', testAccountRef: 'test-account:linkedin:wrong' }],
  }), PublicSocialDarkContractError);
  assert.throws(() => plan({
    targets: [
      { targetId: 'social_test_target_dup', network: 'facebook', testAccountRef: 'test-account:facebook:a' },
      { targetId: 'social_test_target_dup', network: 'facebook', testAccountRef: 'test-account:facebook:b' },
    ],
  }), PublicSocialDarkContractError);
});

test('scheduler is idempotent and snapshots hashes rather than post text', () => {
  const adapter = new SimulatedPublicSocialDarkAdapter({ now: () => NOW });
  const first = adapter.scheduleSimulation(context, plan());
  const replay = adapter.scheduleSimulation(context, plan());
  assert.equal(first.disposition, 'applied');
  assert.equal(replay.disposition, 'replayed');
  assert.equal(first.batchId, replay.batchId);
  assert.equal(first.targets.length, 3);
  assert.ok(first.targets.every((target) => target.status === 'waiting_for_test_time'));
  assert.match(first.bodySha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(first), /fictional Property Predator test post/);
  assert.equal(first.providerOperationsCreated, 0);
  assert.equal(first.externalPublishAttempted, false);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.targets));
});

test('per-target partial failure retries independently and reconciles exact test evidence', () => {
  const adapter = new SimulatedPublicSocialDarkAdapter({
    now: () => NOW,
    transientFailuresByTargetId: { social_test_target_linkedin: 1 },
  });
  let batch = adapter.scheduleSimulation(context, plan());
  batch = adapter.runDueSimulations(context, batch.batchId, '2026-08-27T15:01:00.000Z');
  assert.equal(batch.targets.find((target) => target.network === 'facebook')?.status, 'simulated_succeeded');
  const linkedIn = batch.targets.find((target) => target.network === 'linkedin');
  assert.equal(linkedIn?.status, 'retry_wait');
  assert.equal(linkedIn?.nextAttemptAt, '2026-08-27T15:02:00.000Z');
  assert.equal(batch.targets.find((target) => target.network === 'instagram')?.status, 'simulated_succeeded');
  batch = adapter.runDueSimulations(context, batch.batchId, '2026-08-27T15:02:00.000Z');
  const recovered = batch.targets.find((target) => target.network === 'linkedin');
  assert.equal(recovered?.status, 'simulated_succeeded');
  assert.equal(recovered?.attempts, 2);
  assert.match(recovered?.testReference ?? '', /^social_test_ref_[a-f0-9]{32}$/);
  batch = adapter.reconcileSimulation(context, batch.batchId, recovered!.targetId, recovered!.testReference!);
  assert.equal(batch.targets.find((target) => target.network === 'linkedin')?.status, 'simulated_reconciled');
  assert.equal(adapter.reconcileSimulation(
    context, batch.batchId, recovered!.targetId, recovered!.testReference!,
  ).disposition, 'replayed');
  assert.throws(() => adapter.reconcileSimulation(
    context, batch.batchId, 'social_test_target_facebook', 'social_test_ref_00000000000000000000000000000000',
  ));
  assert.ok(adapter.audit.every((entry) => entry.externalPublishAttempted === false));
});

test('cancellation blocks later simulation and stores only its reason hash', () => {
  const adapter = new SimulatedPublicSocialDarkAdapter({ now: () => NOW });
  let batch = adapter.scheduleSimulation(context, plan());
  batch = adapter.cancelTargetSimulation(
    context, batch.batchId, 'social_test_target_instagram', 'Founder cancelled fictional test target.',
  );
  assert.equal(batch.targets.find((target) => target.network === 'instagram')?.status, 'simulated_cancelled');
  batch = adapter.runDueSimulations(context, batch.batchId, '2026-08-27T15:05:00.000Z');
  assert.equal(batch.targets.find((target) => target.network === 'instagram')?.attempts, 0);
  assert.doesNotMatch(JSON.stringify(adapter.audit), /Founder cancelled/);
  assert.match(adapter.audit.find((entry) => entry.action === 'cancelled')?.reasonSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.throws(() => adapter.cancelTargetSimulation(
    context, batch.batchId, 'social_test_target_facebook', 'Too late.',
  ), /can no longer be cancelled/);
});

test('exhausted retries terminate and cross-context batches fail closed', () => {
  const adapter = new SimulatedPublicSocialDarkAdapter({
    now: () => NOW,
    transientFailuresByTargetId: { social_test_target_facebook: 3 },
  });
  let batch = adapter.scheduleSimulation(context, plan({ maxAttempts: 2 }));
  batch = adapter.runDueSimulations(context, batch.batchId, '2026-08-27T15:01:00.000Z');
  batch = adapter.runDueSimulations(context, batch.batchId, '2026-08-27T15:02:00.000Z');
  const facebook = batch.targets.find((target) => target.network === 'facebook');
  assert.equal(facebook?.status, 'simulated_failed');
  assert.equal(facebook?.lastErrorCode, 'simulated_attempts_exhausted');
  assert.throws(() => adapter.runDueSimulations({
    ...context, workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }, batch.batchId, '2026-08-27T15:03:00.000Z'), /not bound/);
});

test('scheduler snapshots plan arrays and nested evidence once before validation, hashing and storage', () => {
  const facebookTarget = Object.freeze({
    targetId: 'social_test_target_facebook',
    network: 'facebook' as const,
    testAccountRef: 'test-account:facebook:property-predator',
  });
  const sealed = plan({ targets: [facebookTarget], maxAttempts: 3 });
  const reads = new Map<string, number>();
  const valueOnRead = <T>(name: string, first: T, later: T = first): T => {
    const count = (reads.get(name) ?? 0) + 1;
    reads.set(name, count);
    return count === 1 ? first : later;
  };
  const mediaItem = Object.defineProperties({}, {
    artifactId: { enumerable: true, get: () => valueOnRead('media.artifactId', sealed.media[0]!.artifactId) },
    sha256: { enumerable: true, get: () => valueOnRead('media.sha256', sealed.media[0]!.sha256, 'c'.repeat(64)) },
  });
  const targetItem = Object.defineProperties({}, {
    targetId: { enumerable: true, get: () => valueOnRead('target.targetId', facebookTarget.targetId) },
    network: { enumerable: true, get: () => valueOnRead('target.network', 'facebook', 'linkedin') },
    testAccountRef: {
      enumerable: true,
      get: () => valueOnRead(
        'target.testAccountRef',
        'test-account:facebook:property-predator',
        'test-account:linkedin:victim',
      ),
    },
  });
  const trackedArray = (name: string, item: object): readonly object[] => new Proxy([item], {
    get(target, property, receiver) {
      if (property === 'length' || property === '0') {
        const key = `${name}.${String(property)}`;
        reads.set(key, (reads.get(key) ?? 0) + 1);
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const media = trackedArray('media', mediaItem);
  const targets = trackedArray('targets', targetItem);
  const hostilePlan = Object.defineProperties({}, {
    contentVersionId: { enumerable: true, get: () => valueOnRead('plan.contentVersionId', sealed.contentVersionId) },
    contentSha256: {
      enumerable: true,
      get: () => valueOnRead('plan.contentSha256', sealed.contentSha256, 'c'.repeat(64)),
    },
    approvalId: { enumerable: true, get: () => valueOnRead('plan.approvalId', sealed.approvalId) },
    text: { enumerable: true, get: () => valueOnRead('plan.text', sealed.text, 'changed after validation') },
    media: { enumerable: true, get: () => valueOnRead('plan.media', media) },
    targets: { enumerable: true, get: () => valueOnRead('plan.targets', targets) },
    scheduledFor: { enumerable: true, get: () => valueOnRead('plan.scheduledFor', sealed.scheduledFor) },
    maxAttempts: { enumerable: true, get: () => valueOnRead('plan.maxAttempts', 3, 1) },
    mode: { enumerable: true, get: () => valueOnRead('plan.mode', sealed.mode) },
    planSha256: { enumerable: true, get: () => valueOnRead('plan.planSha256', sealed.planSha256) },
  });
  const adapter = new SimulatedPublicSocialDarkAdapter({
    now: () => NOW,
    transientFailuresByTargetId: { social_test_target_facebook: 3 },
  });
  let batch = adapter.scheduleSimulation(context, hostilePlan as ReturnType<typeof plan>);
  batch = adapter.runDueSimulations(context, batch.batchId, '2026-08-27T15:01:00.000Z');
  batch = adapter.runDueSimulations(context, batch.batchId, '2026-08-27T15:02:00.000Z');
  batch = adapter.runDueSimulations(context, batch.batchId, '2026-08-27T15:07:00.000Z');
  assert.equal(batch.targets[0]?.network, 'facebook');
  assert.equal(batch.targets[0]?.attempts, 3);
  assert.equal(batch.targets[0]?.status, 'simulated_failed');
  for (const [field, count] of reads) assert.equal(count, 1, `${field} was read ${count} times`);
});

test('scheduler snapshots the complete context once and cannot swap to a victim workspace', () => {
  const reads = new Map<string, number>();
  const victim: ProviderOperationContext = {
    workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    providerId: 'public_social_dark_simulator',
    operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    idempotencyKey: 'victim-operation',
    correlationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  };
  const changing = (field: keyof ProviderOperationContext) => () => {
    const count = (reads.get(field) ?? 0) + 1;
    reads.set(field, count);
    return count === 1 ? context[field] : victim[field];
  };
  const hostileContext = Object.defineProperties({}, {
    workspaceId: { enumerable: true, get: changing('workspaceId') },
    connectionId: { enumerable: true, get: changing('connectionId') },
    providerId: { enumerable: true, get: changing('providerId') },
    operationId: { enumerable: true, get: changing('operationId') },
    idempotencyKey: { enumerable: true, get: changing('idempotencyKey') },
    correlationId: { enumerable: true, get: changing('correlationId') },
  }) as ProviderOperationContext;
  const batch = new SimulatedPublicSocialDarkAdapter({ now: () => NOW })
    .scheduleSimulation(hostileContext, plan());
  assert.equal(batch.workspaceId, context.workspaceId);
  assert.equal(batch.connectionId, context.connectionId);
  assert.equal(batch.operationId, context.operationId);
  for (const field of Object.keys(context)) assert.equal(reads.get(field), 1, `${field} was read more than once`);
});

test('simulator snapshots clock and retry configuration without later getter drift', () => {
  let optionsClockReads = 0;
  let optionsBudgetReads = 0;
  let failureCountReads = 0;
  let clockCalls = 0;
  const retryConfiguration = Object.defineProperty({}, 'social_test_target_facebook', {
    enumerable: true,
    get() {
      failureCountReads += 1;
      return failureCountReads === 1 ? 1 : 3;
    },
  });
  const options = Object.defineProperties({}, {
    now: {
      enumerable: true,
      get() {
        optionsClockReads += 1;
        return () => {
          clockCalls += 1;
          return NOW;
        };
      },
    },
    transientFailuresByTargetId: {
      enumerable: true,
      get() {
        optionsBudgetReads += 1;
        return retryConfiguration;
      },
    },
  });
  const adapter = new SimulatedPublicSocialDarkAdapter(options);
  let batch = adapter.scheduleSimulation(context, plan({
    targets: [{
      targetId: 'social_test_target_facebook',
      network: 'facebook',
      testAccountRef: 'test-account:facebook:property-predator',
    }],
  }));
  batch = adapter.runDueSimulations(context, batch.batchId, '2026-08-27T15:01:00.000Z');
  assert.equal(batch.targets[0]?.status, 'retry_wait');
  batch = adapter.runDueSimulations(context, batch.batchId, '2026-08-27T15:02:00.000Z');
  assert.equal(batch.targets[0]?.status, 'simulated_succeeded');
  assert.equal(optionsClockReads, 1);
  assert.equal(optionsBudgetReads, 1);
  assert.equal(failureCountReads, 1);
  assert.equal(clockCalls, 1);
});

test('idempotency binds plan, operation and correlation and follow-up calls require the same evidence', () => {
  const adapter = new SimulatedPublicSocialDarkAdapter({ now: () => NOW });
  const scheduled = adapter.scheduleSimulation(context, plan());
  assert.throws(() => adapter.scheduleSimulation({
    ...context,
    operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }, plan()), /idempotency key was reused/);
  assert.throws(() => adapter.scheduleSimulation({
    ...context,
    correlationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  }, plan()), /idempotency key was reused/);
  assert.throws(() => adapter.scheduleSimulation(context, plan({ text: 'Different sealed test plan.' })),
    /idempotency key was reused/);
  assert.throws(() => adapter.runDueSimulations({
    ...context,
    correlationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  }, scheduled.batchId, '2026-08-27T15:01:00.000Z'), /not bound/);
  assert.throws(() => adapter.runDueSimulations({
    ...context,
    idempotencyKey: 'different-key',
  }, scheduled.batchId, '2026-08-27T15:01:00.000Z'), /not bound/);
  assert.equal(adapter.scheduleSimulation(context, plan()).disposition, 'replayed');
});

test('runtime guards reject non-strings before regular expressions can coerce them', () => {
  const adapter = new SimulatedPublicSocialDarkAdapter({ now: () => NOW });
  const scheduled = adapter.scheduleSimulation(context, plan());
  let coercions = 0;
  const coercible = {
    toString() {
      coercions += 1;
      return scheduled.batchId;
    },
  } as unknown as string;
  assert.throws(() => adapter.runDueSimulations(
    context, coercible, '2026-08-27T15:01:00.000Z',
  ), /batchId is invalid/);
  assert.throws(() => adapter.cancelTargetSimulation(
    context, scheduled.batchId, coercible, 'safe cancellation reason',
  ), /cancellation input is invalid/);
  assert.throws(() => adapter.reconcileSimulation(
    context, scheduled.batchId, 'social_test_target_facebook', coercible,
  ), /reconciliation input is invalid/);
  assert.equal(coercions, 0);
});

test('dark social module contains no network, SDK, registry, live status or provider-operation path', async () => {
  const source = (await Promise.all(['contracts.ts', 'simulator.ts', 'index.ts'].map((name) => readFile(
    new URL(`../src/social-dark/${name}`, import.meta.url), 'utf8',
  )))).join('\n');
  assert.doesNotMatch(source, /\bfetch\s*\(|node:https|axios|ayrshare|hootsuite|providerRegistry|access[_-]?token|api[_-]?key/i);
  assert.doesNotMatch(source, /status:\s*['"](?:sent|delivered|published)['"]/i);
  assert.doesNotMatch(source, /provider_operations|createProviderOperation/i);
  assert.match(source, /externalPublishAttempted:\s*false/g);
  assert.match(source, /providerOperationsCreated:\s*0/g);
});
