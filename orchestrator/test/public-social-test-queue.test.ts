import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { SqlExecutor, SqlResult } from '../src/crm-pg/types.js';
import {
  DeterministicPublicSocialTestProvider,
  PgPublicSocialTestQueue,
  PublicSocialTestDispatcher,
  PublicSocialTestLeaseLostError,
  SocialCampaignPgContractError,
  type PublicSocialTestClaim,
  type PublicSocialTestLeaseIdentity,
  type PublicSocialTestProvider,
  type PublicSocialTestQueue,
  type PublicSocialTestSettlement,
} from '../src/social-campaign-pg/index.js';

const IDS = {
  operation: '11111111-1111-4111-8111-111111111111',
  workspace: '22222222-2222-4222-8222-222222222222',
  post: '33333333-3333-4333-8333-333333333333',
  target: '44444444-4444-4444-8444-444444444444',
  connection: '55555555-5555-4555-8555-555555555555',
  correlation: '66666666-6666-4666-8666-666666666666',
  version: '77777777-7777-4777-8777-777777777777',
  decision: '88888888-8888-4888-8888-888888888888',
  attestation: '99999999-9999-4999-8999-999999999999',
  artifact: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  worker: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
} as const;
const NOW = '2026-08-28T09:00:00.000Z';
const text = 'Fictional TEST post body.';
const bodySha = createHash('sha256').update(text, 'utf8').digest('hex');
const lease: PublicSocialTestLeaseIdentity = Object.freeze({
  workerId: IDS.worker,
  leaseToken: Buffer.alloc(32, 7),
});

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

function claimRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: IDS.operation, workspaceId: IDS.workspace, postId: IDS.post,
    targetId: IDS.target, connectionId: IDS.connection, network: 'facebook',
    idempotencyKey: 'social-operation-1', correlationId: IDS.correlation,
    attemptNumber: 1, leaseVersion: 1,
    leaseExpiresAt: '2026-08-28T09:01:00.000Z', attemptKind: 'simulation',
    testReference: null, ...overrides,
  };
}

function payloadRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    network: 'facebook', testAccountRef: 'test-account:facebook:property-predator',
    contentVersionId: IDS.version, contentSha256: bodySha,
    approvalDecisionId: IDS.decision, text, scheduledFor: NOW,
    planSha256: 'b'.repeat(64),
    media: [{
      contentVersionId: IDS.artifact,
      contentSha256: 'c'.repeat(64),
      blobStorageKey: 'test-assets/property-predator/social-card.png',
      blobSha256: 'd'.repeat(64),
      mimeType: 'image/png',
    }], ...overrides,
  };
}

function settledRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationState: 'simulated_succeeded', completedAt: NOW, ...overrides,
  };
}

test('queue runs a complete function-only claim/load/calling/settlement cycle', async () => {
  const executor = new FakeExecutor([
    [claimRow()], [payloadRow()], [{ marked: true }], [settledRow()],
  ]);
  const queue = new PgPublicSocialTestQueue(executor);
  const claims = await queue.claim(lease, { batchSize: 1, leaseSeconds: 60 });
  const claim = claims[0]!;
  const payload = await queue.load(claim, lease);
  await queue.markCalling(claim, lease);
  const result = await new DeterministicPublicSocialTestProvider({ now: () => new Date(NOW) })
    .simulate({
      workspaceId: claim.workspaceId, connectionId: claim.connectionId,
      operationId: claim.operationId, correlationId: claim.correlationId,
      idempotencyKey: claim.idempotencyKey,
    }, {
      targetId: payload.targetId, network: payload.network,
      testAccountRef: payload.testAccountRef, text: payload.text,
      bodySha256: payload.bodySha256, planSha256: payload.planSha256,
      contentVersionId: payload.contentVersionId, contentSha256: payload.contentSha256,
      media: payload.media,
    });
  assert.deepEqual(await queue.settle(claim, lease, result), {
    operationId: IDS.operation, state: 'simulated_succeeded', completedAt: NOW,
  });
  const expectedLeaseHash = createHash('sha256').update(Buffer.alloc(32, 7)).digest('hex');
  for (const call of executor.calls) {
    assert.match(call.sql, /app_private\./);
    assert.doesNotMatch(call.sql, /\b(?:insert|update|delete)\s+(?:into\s+)?app\./i);
    assert.doesNotMatch(JSON.stringify(call.values), /0707070707070707/);
  }
  assert.equal(Buffer.from(executor.calls[0]!.values[1] as Uint8Array).toString('hex'), expectedLeaseHash);
});

test('queue supports lease renewal and exact-reference reconciliation', async () => {
  const testReference = 'social_test_ref_0123456789abcdef0123456789abcdef';
  const executor = new FakeExecutor([
    [{ leaseExpiresAt: '2026-08-28T09:02:00.000Z' }],
    [settledRow({ operationState: 'simulated_reconciled' })],
  ]);
  const queue = new PgPublicSocialTestQueue(executor);
  const claim = Object.freeze({
    ...claimRow({ attemptKind: 'reconcile', testReference }),
  }) as unknown as PublicSocialTestClaim;
  assert.equal(await queue.renew(claim, lease, 60), '2026-08-28T09:02:00.000Z');
  assert.deepEqual(await queue.reconcile(claim, lease, {
    status: 'succeeded', testReference, occurredAt: NOW, retryable: false,
    errorCode: null, summary: 'Reserved TEST social target reconciled',
    externalPublishAttempted: false,
  }), {
    operationId: IDS.operation, state: 'simulated_reconciled', completedAt: NOW,
  });
  assert.match(executor.calls[0]!.sql, /renew_test_social_target_lease/);
  assert.match(executor.calls[1]!.sql, /reconcile_test_social_target/);
});

test('queue claims and reconciles an ambiguous operation without a prior TEST reference', async () => {
  const recoveredReference = 'social_test_ref_fedcba9876543210fedcba9876543210';
  const executor = new FakeExecutor([
    [claimRow({ attemptKind: 'reconcile', testReference: null, attemptNumber: 4 })],
    [settledRow({ operationState: 'simulated_reconciled' })],
  ]);
  const queue = new PgPublicSocialTestQueue(executor);
  const claim = (await queue.claim(lease))[0]!;
  assert.equal(claim.attemptKind, 'reconcile');
  assert.equal(claim.testReference, null);
  assert.deepEqual(await queue.reconcile(claim, lease, {
    status: 'succeeded', testReference: recoveredReference, occurredAt: NOW,
    retryable: false, errorCode: null,
    summary: 'Reference-less TEST ambiguity reconciled by operation identity',
    externalPublishAttempted: false,
  }), {
    operationId: IDS.operation, state: 'simulated_reconciled', completedAt: NOW,
  });
  assert.equal(executor.calls[1]!.values[5], recoveredReference);
});

test('queue rejects invalid claims, claim/payload swaps and stale calling leases', async () => {
  const wrongAttempt = new PgPublicSocialTestQueue(new FakeExecutor([[claimRow({ attemptKind: 'publish' })]]));
  await assert.rejects(wrongAttempt.claim(lease), /attemptKind is invalid/);
  const retainedReference = new PgPublicSocialTestQueue(new FakeExecutor([[
    claimRow({ testReference: 'social_test_ref_0123456789abcdef0123456789abcdef' }),
  ]]));
  await assert.rejects(retainedReference.claim(lease), /unexpectedly retained/);
  const swapped = new PgPublicSocialTestQueue(new FakeExecutor([
    [claimRow()], [payloadRow({ network: 'instagram' })],
  ]));
  const claim = (await swapped.claim(lease))[0]!;
  await assert.rejects(swapped.load(claim, lease), /not bound/);
  const mismatchedBody = new PgPublicSocialTestQueue(new FakeExecutor([
    [payloadRow({ contentSha256: 'a'.repeat(64) })],
  ]));
  await assert.rejects(
    mismatchedBody.load(claim, lease),
    /body does not match the exact approved content hash/,
  );
  const bidiText = 'Safe prefix\u2066hidden isolate\u2069';
  const bidiPayload = new PgPublicSocialTestQueue(new FakeExecutor([[
    payloadRow({
      text: bidiText,
      contentSha256: createHash('sha256').update(bidiText, 'utf8').digest('hex'),
    }),
  ]]));
  await assert.rejects(bidiPayload.load(claim, lease), /invalid text/);
  const stale = new PgPublicSocialTestQueue(new FakeExecutor([[{ marked: false }]]));
  await assert.rejects(stale.markCalling(claim, lease), PublicSocialTestLeaseLostError);
});

test('dispatcher loads before the boundary and settles deterministic TEST evidence', async () => {
  const executor = new FakeExecutor([
    [claimRow()], [payloadRow()], [{ marked: true }], [settledRow()],
  ]);
  const dispatcher = new PublicSocialTestDispatcher({
    queue: new PgPublicSocialTestQueue(executor),
    provider: new DeterministicPublicSocialTestProvider({ now: () => new Date(NOW) }),
  });
  assert.deepEqual(await dispatcher.runOnce(lease), {
    disposition: 'settled', operationId: IDS.operation, state: 'simulated_succeeded',
  });
  assert.match(executor.calls[0]!.sql, /claim_due/);
  assert.match(executor.calls[1]!.sql, /load_test_social_dispatch_payload/);
  assert.match(executor.calls[2]!.sql, /mark_test_social_target_calling/);
  assert.match(executor.calls[3]!.sql, /settle_test_social_target/);
});

test('dispatcher converts a post-boundary provider throw into needs-attention evidence', async () => {
  const calls: string[] = [];
  const claim = Object.freeze({
    operationId: IDS.operation, workspaceId: IDS.workspace, postId: IDS.post,
    targetId: IDS.target, connectionId: IDS.connection, network: 'facebook' as const,
    environment: 'test' as const, idempotencyKey: 'social-operation-1',
    correlationId: IDS.correlation, attemptNumber: 1,
    leaseVersion: 1, leaseExpiresAt: '2026-08-28T09:01:00.000Z',
    attemptKind: 'simulation' as const, testReference: null,
  });
  const queue: PublicSocialTestQueue = {
    async claim() { calls.push('claim'); return [claim]; },
    async load() {
      calls.push('load');
      return Object.freeze({
        workspaceId: IDS.workspace,
        operationId: IDS.operation,
        connectionId: IDS.connection,
        providerId: 'public_social_dark_simulator',
        postId: IDS.post,
        targetId: IDS.target,
        network: 'facebook',
        testAccountRef: 'test-account:facebook:property-predator',
        contentVersionId: IDS.version,
        contentSha256: 'a'.repeat(64),
        approvalDecisionId: IDS.decision,
        text,
        bodySha256: bodySha,
        planSha256: 'b'.repeat(64),
        scheduledFor: NOW,
        media: Object.freeze([Object.freeze({
          contentVersionId: IDS.artifact,
          contentSha256: 'c'.repeat(64),
          blobStorageKey: 'test-assets/property-predator/social-card.png',
          blobSha256: 'd'.repeat(64),
          mimeType: 'image/png',
        })]),
      });
    },
    async markCalling() { calls.push('mark'); },
    async renew() { throw new Error('unused'); },
    async settle(_claim, _lease, result) {
      calls.push(`settle:${result.status}:${result.errorCode}`);
      return Object.freeze({
        operationId: IDS.operation, state: 'reconciliation_required',
        completedAt: null,
      }) satisfies PublicSocialTestSettlement;
    },
    async reconcile() { throw new Error('unused'); },
  };
  const provider: PublicSocialTestProvider = {
    async simulate() { calls.push('provider'); throw new Error('secret-bearing provider failure'); },
    async reconcile() { throw new Error('unused'); },
  };
  const dispatcher = new PublicSocialTestDispatcher({
    queue, provider, now: () => new Date(NOW),
  });
  assert.deepEqual(await dispatcher.runOnce(lease), {
    disposition: 'settled', operationId: IDS.operation, state: 'reconciliation_required',
  });
  assert.deepEqual(calls, [
    'claim', 'load', 'mark', 'provider',
    'settle:needs_attention:ambiguous_test_provider_exception',
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /secret-bearing/);
});

test('dispatcher terminalizes a reconciliation throw even when the original call had no reference', async () => {
  const calls: string[] = [];
  const claim = Object.freeze({
    operationId: IDS.operation, workspaceId: IDS.workspace, postId: IDS.post,
    targetId: IDS.target, connectionId: IDS.connection, network: 'facebook' as const,
    environment: 'test' as const, idempotencyKey: 'social-operation-final-attempt',
    correlationId: IDS.correlation, attemptNumber: 1,
    leaseVersion: 2, leaseExpiresAt: '2026-08-28T09:01:00.000Z',
    attemptKind: 'reconcile' as const, testReference: null,
  });
  const queue: PublicSocialTestQueue = {
    async claim() { calls.push('claim'); return [claim]; },
    async load() { throw new Error('unused'); },
    async markCalling() { calls.push('mark'); },
    async renew() { throw new Error('unused'); },
    async settle(_claim, _lease, result) {
      calls.push(`settle:${result.status}:${String(result.testReference)}`);
      return Object.freeze({
        operationId: IDS.operation, state: 'dead_letter', completedAt: NOW,
      }) satisfies PublicSocialTestSettlement;
    },
    async reconcile() { throw new Error('unused'); },
  };
  const provider: PublicSocialTestProvider = {
    async simulate() { throw new Error('unused'); },
    async reconcile(_context, testReference) {
      calls.push(`provider:${String(testReference)}`);
      throw new Error('secret-bearing reconciliation failure');
    },
  };
  const dispatcher = new PublicSocialTestDispatcher({
    queue, provider, now: () => new Date(NOW),
  });
  assert.deepEqual(await dispatcher.runOnce(lease), {
    disposition: 'settled', operationId: IDS.operation, state: 'dead_letter',
  });
  assert.deepEqual(calls, [
    'claim', 'mark', 'provider:null', 'settle:needs_attention:null',
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /secret-bearing/);
});

test('malformed provider results fail closed', async () => {
  const queue = new PgPublicSocialTestQueue(new FakeExecutor([[settledRow()]]));
  const claim = Object.freeze(claimRow()) as unknown as PublicSocialTestClaim;
  await assert.rejects(queue.settle(claim, lease, {
    status: 'succeeded', testReference: 'real-provider-id', occurredAt: NOW,
    retryable: false, errorCode: null, summary: 'bad', externalPublishAttempted: false,
  }), SocialCampaignPgContractError);
});
