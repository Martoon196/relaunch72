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
