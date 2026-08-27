import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { SqlExecutor, SqlResult } from '../src/crm-pg/types.js';
import {
  PgSocialCampaignCommandRepository,
  PgSocialCampaignReadRepository,
  PgSocialPlanningRevalidationRepository,
  SocialCampaignPgContractError,
} from '../src/social-campaign-pg/index.js';

const IDS = {
  workspace: '11111111-1111-4111-8111-111111111111',
  intent: '22222222-2222-4222-8222-222222222222',
  campaign: '33333333-3333-4333-8333-333333333333',
  revision: '44444444-4444-4444-8444-444444444444',
  content: '55555555-5555-4555-8555-555555555555',
  target: '66666666-6666-4666-8666-666666666666',
  media: '77777777-7777-4777-8777-777777777777',
  successor: '88888888-8888-4888-8888-888888888888',
  item: '99999999-9999-4999-8999-999999999999',
  post: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  operation: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  job: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  worker: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  proof: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  attestation: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  mediaAttestation: '12121212-1212-4121-8121-121212121212',
} as const;

interface RecordedQuery {
  readonly sql: string;
  readonly values: readonly unknown[];
}

class FakeExecutor implements SqlExecutor {
  readonly calls: RecordedQuery[] = [];
  constructor(private readonly replies: readonly (readonly Record<string, unknown>[])[]) {}

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<SqlResult<TRow>> {
    this.calls.push({ sql, values });
    const rows = this.replies[this.calls.length - 1] ?? [];
    return { rows: rows as TRow[], rowCount: rows.length };
  }
}

test('planning commands cross only the 0040 function boundary with selected identities', async () => {
  const executor = new FakeExecutor([
    [{ intentId: IDS.intent, intentSha256: '1'.repeat(64), disposition: 'applied' }],
    [{ successorIntentId: IDS.successor, disposition: 'applied' }],
    [{ intentId: IDS.intent, targetId: IDS.target, state: 'cancelled', disposition: 'replayed' }],
  ]);
  const repository = new PgSocialCampaignCommandRepository(executor);

  assert.deepEqual(await repository.planIntent({
    workspaceId: IDS.workspace,
    intentId: IDS.intent,
    campaignId: IDS.campaign,
    revisionId: IDS.revision,
    contentVersionId: IDS.content,
    desiredFor: '2026-09-02T10:30:00.000Z',
    maxAttempts: 3,
    targetIds: [IDS.target],
    mediaVersionIds: [IDS.media],
  }), {
    intentId: IDS.intent,
    intentSha256: '1'.repeat(64),
    disposition: 'applied',
  });
  assert.deepEqual(await repository.reschedulePlanningTarget({
    workspaceId: IDS.workspace,
    predecessorIntentId: IDS.intent,
    targetId: IDS.target,
    successorIntentId: IDS.successor,
    newDesiredFor: '2026-09-03T11:00:00.000Z',
    reason: 'Move the TEST target to the later evidence window.',
  }), { successorIntentId: IDS.successor, disposition: 'applied' });
  assert.deepEqual(await repository.cancelPlanningTarget({
    workspaceId: IDS.workspace,
    intentId: IDS.intent,
    targetId: IDS.target,
    reason: 'Founder cancelled this fictional TEST target.',
  }), {
    intentId: IDS.intent,
    targetId: IDS.target,
    state: 'cancelled',
    disposition: 'replayed',
  });

  assert.match(executor.calls[0]!.sql, /create_test_social_planning_intent/u);
  assert.deepEqual(executor.calls[0]!.values, [
    IDS.workspace, IDS.intent, IDS.campaign, IDS.revision, IDS.content,
    '2026-09-02T10:30:00.000Z', 3, [IDS.target], [IDS.media],
  ]);
  assert.match(executor.calls[1]!.sql, /reschedule_test_social_planning_target/u);
  assert.equal(executor.calls[1]!.values[5], createHash('sha256')
    .update('Move the TEST target to the later evidence window.', 'utf8').digest('hex'));
  assert.match(executor.calls[2]!.sql, /cancel_test_social_planning_target/u);
  assert.equal(executor.calls[2]!.values[3], createHash('sha256')
    .update('Founder cancelled this fictional TEST target.', 'utf8').digest('hex'));
  for (const call of executor.calls) {
    assert.doesNotMatch(call.sql, /\b(?:insert|update|delete)\s+(?:into\s+)?app\./iu);
    assert.doesNotMatch(JSON.stringify(call.values),
      /test-account:|body|approval|attestation|connection|storage[_ -]?key/iu);
  }
});

test('planner reads expose bounded state but no outbound material', async () => {
  const executor = new FakeExecutor([
    [{
      targetId: IDS.target,
      network: 'linkedin',
      targetLabel: 'LinkedIn owned TEST rail',
      hasMore: false,
    }],
    [{
      intentId: IDS.intent,
      campaignId: IDS.campaign,
      revisionId: IDS.revision,
      revisionNumber: 1,
      campaignTitle: 'Property Predator evidence week',
      desiredFor: '2026-09-02T10:30:00.000Z',
      contentItemId: IDS.item,
      contentVersionId: IDS.content,
      contentSha256: '2'.repeat(64),
      intentSha256: '3'.repeat(64),
      targetId: IDS.target,
      network: 'linkedin',
      targetLabel: 'LinkedIn owned TEST rail',
      planningState: 'proof_ready',
      materializedPostId: IDS.post,
      materializedOperationId: IDS.operation,
      operationState: 'waiting_for_test_time',
      revalidationState: 'verified',
      nextRevalidationAt: null,
      lastErrorCode: null,
      updatedAt: '2026-09-02T10:20:00.000Z',
      hasMore: false,
    }],
  ]);
  const repository = new PgSocialCampaignReadRepository(executor);
  const targets = await repository.listPlannerTargets(IDS.workspace, 60);
  const calendar = await repository.listPlanningCalendar({
    workspaceId: IDS.workspace,
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-09-08T00:00:00.000Z',
    limit: 60,
  });

  assert.equal(targets.items[0]?.providerEffects, 'none');
  assert.equal(calendar.items[0]?.planningState, 'proof_ready');
  assert.equal(calendar.items[0]?.operationState, 'waiting_for_test_time');
  assert.equal(calendar.items[0]?.revalidationState, 'verified');
  assert.match(executor.calls[0]!.sql, /list_test_social_planner_targets/u);
  assert.match(executor.calls[1]!.sql, /list_test_social_planning_calendar/u);
  assert.doesNotMatch(JSON.stringify({ targets, calendar }),
    /test-account:|body_text|approval|attestation|connection|blobStorageKey/iu);
});

test('planner validation rejects duplicate targets before SQL', async () => {
  const executor = new FakeExecutor([]);
  const repository = new PgSocialCampaignCommandRepository(executor);
  await assert.rejects(repository.planIntent({
    workspaceId: IDS.workspace,
    intentId: IDS.intent,
    campaignId: IDS.campaign,
    revisionId: IDS.revision,
    contentVersionId: IDS.content,
    desiredFor: '2026-09-02T10:30:00.000Z',
    maxAttempts: 3,
    targetIds: [IDS.target, IDS.target],
    mediaVersionIds: [],
  }), SocialCampaignPgContractError);
  assert.equal(executor.calls.length, 0);
});

test('trusted revalidator claims immutable material then proves, fails or materializes by function', async () => {
  const leaseToken = new Uint8Array(32).fill(7);
  const leaseTokenHash = createHash('sha256').update(leaseToken).digest('hex');
  const executor = new FakeExecutor([
    [{
      jobId: IDS.job,
      workspaceId: IDS.workspace,
      intentId: IDS.intent,
      leaseVersion: 2,
      desiredFor: '2026-09-02T10:30:00.000Z',
      contentItemId: IDS.item,
      contentVersionId: IDS.content,
      sourceSystem: 'property_predator',
      sourceItemId: 'social/launch-proof',
      sourceVersion: 'v3',
      contentSha256: '1'.repeat(64),
      blobSha256: '2'.repeat(64),
      brandSha256: '3'.repeat(64),
      media: [{
        ordinal: 1,
        contentItemId: IDS.media,
        contentVersionId: IDS.successor,
        sourceSystem: 'property_predator',
        sourceItemId: 'artwork/launch-proof',
        sourceVersion: 'v2',
        contentSha256: '4'.repeat(64),
        blobSha256: '5'.repeat(64),
        brandSha256: '6'.repeat(64),
      }],
    }],
    [{ proofId: IDS.proof, state: 'verified', disposition: 'applied' }],
    [{ jobId: IDS.job, state: 'retry_wait' }],
    [{ postId: IDS.post, operationIds: [IDS.operation], disposition: 'applied' }],
  ]);
  const repository = new PgSocialPlanningRevalidationRepository(executor);

  const claims = await repository.claimDue({
    workerId: IDS.worker,
    leaseToken,
    batchSize: 2,
    leaseSeconds: 90,
  });
  assert.equal(claims[0]?.media[0]?.sourceItemId, 'artwork/launch-proof');
  assert.equal(claims[0]?.media[0]?.ordinal, 1);
  assert.equal(Buffer.from(executor.calls[0]!.values[1] as Uint8Array).toString('hex'), leaseTokenHash);

  assert.deepEqual(await repository.complete({
    workspaceId: IDS.workspace,
    jobId: IDS.job,
    workerId: IDS.worker,
    leaseToken,
    leaseVersion: 2,
    proofId: IDS.proof,
    contentAttestationId: IDS.attestation,
    mediaAttestationIds: [IDS.mediaAttestation],
  }), { proofId: IDS.proof, state: 'verified', disposition: 'applied' });

  assert.deepEqual(await repository.fail({
    workspaceId: IDS.workspace,
    jobId: IDS.job,
    workerId: IDS.worker,
    leaseToken,
    leaseVersion: 2,
    errorCode: 'source.catalog_unavailable',
    retryable: true,
  }), { jobId: IDS.job, state: 'retry_wait' });

  assert.deepEqual(await repository.materialize({
    workspaceId: IDS.workspace,
    jobId: IDS.job,
    proofId: IDS.proof,
    postId: IDS.post,
  }), { postId: IDS.post, operationIds: [IDS.operation], disposition: 'applied' });

  assert.match(executor.calls[0]!.sql, /claim_due_test_social_revalidations/u);
  assert.match(executor.calls[1]!.sql, /complete_test_social_revalidation/u);
  assert.match(executor.calls[2]!.sql, /fail_test_social_revalidation/u);
  assert.match(executor.calls[3]!.sql, /materialize_test_social_planning_intent/u);
  assert.equal(Buffer.from(executor.calls[1]!.values[3] as Uint8Array).toString('hex'), leaseTokenHash);
  assert.deepEqual(executor.calls[3]!.values, [IDS.workspace, IDS.job, IDS.proof, IDS.post]);
  for (const call of executor.calls) {
    assert.doesNotMatch(call.sql, /\b(?:insert|update|delete)\s+(?:into\s+)?app\./iu);
  }
});

test('trusted revalidator rejects malformed lease material before SQL', async () => {
  const executor = new FakeExecutor([]);
  const repository = new PgSocialPlanningRevalidationRepository(executor);
  await assert.rejects(repository.claimDue({
    workerId: IDS.worker,
    leaseToken: new Uint8Array(31),
  }), SocialCampaignPgContractError);
  assert.equal(executor.calls.length, 0);
});
