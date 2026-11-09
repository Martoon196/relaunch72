import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { SqlExecutor, SqlResult } from '../src/crm-pg/types.js';
import { createPublicSocialDarkPlan } from '../src/social-dark/contracts.js';
import {
  PgSocialCampaignCommandRepository,
  PgSocialCampaignReadRepository,
  SocialCampaignPgContractError,
  socialCampaignRevisionSha256,
} from '../src/social-campaign-pg/index.js';

const IDS = {
  workspace: '11111111-1111-4111-8111-111111111111',
  campaign: '22222222-2222-4222-8222-222222222222',
  revision: '33333333-3333-4333-8333-333333333333',
  connection: '44444444-4444-4444-8444-444444444444',
  target: '55555555-5555-4555-8555-555555555555',
  post: '66666666-6666-4666-8666-666666666666',
  item: '77777777-7777-4777-8777-777777777777',
  version: '88888888-8888-4888-8888-888888888888',
  request: '99999999-9999-4999-8999-999999999999',
  decision: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  attestation: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  operation: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  media: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
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

function sealedPlan() {
  const text = 'Fictional TEST social post. It cannot leave this process.';
  return createPublicSocialDarkPlan({
    contentVersionId: IDS.version,
    contentSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    approvalId: IDS.decision,
    text,
    media: [{ artifactId: IDS.media, sha256: 'b'.repeat(64) }],
    targets: [{
      targetId: 'social_test_target_facebook',
      network: 'facebook',
      testAccountRef: 'test-account:facebook:property-predator',
    }],
    scheduledFor: '2026-08-28T09:00:00.000Z',
    maxAttempts: 3,
  });
}

function approvedMediaBindings() {
  return [{
    planArtifactId: IDS.media,
    contentItemId: IDS.item,
    contentVersionId: IDS.media,
    contentSha256: 'b'.repeat(64),
    blobSha256: 'd'.repeat(64),
    approvalRequestId: IDS.request,
    approvalDecisionId: IDS.decision,
    sourceAttestationId: IDS.attestation,
  }] as const;
}

test('command repository crosses only function boundaries and returns canonical results', async () => {
  const executor = new FakeExecutor([
    [{ campaignId: IDS.campaign, revisionId: IDS.revision, revisionNumber: 1, disposition: 'applied' }],
    [{ targetId: IDS.target, disposition: 'replayed' }],
    [{
      ordinal: 1,
      targetId: IDS.target,
      network: 'facebook',
      testAccountRef: 'test-account:facebook:property-predator',
    }],
    [{ postId: IDS.post, operationIds: [IDS.operation], disposition: 'applied' }],
    [{ operationId: IDS.operation, state: 'simulated_cancelled', disposition: 'applied' }],
  ]);
  const repository = new PgSocialCampaignCommandRepository(executor);
  const revision = {
    workspaceId: IDS.workspace, campaignId: IDS.campaign, revisionId: IDS.revision,
    revisionNumber: 1, previousRevisionId: null, title: 'Property Predator launch',
    objective: 'Move approved fictional TEST content through the social rehearsal rail.',
    timezone: 'Europe/London',
  } as const;
  assert.deepEqual(await repository.createRevision({
    ...revision,
    revisionSha256: socialCampaignRevisionSha256(revision),
  }), {
    campaignId: IDS.campaign, revisionId: IDS.revision,
    revisionNumber: 1, disposition: 'applied',
  });
  assert.deepEqual(await repository.registerTestTarget({
    workspaceId: IDS.workspace, targetId: IDS.target, connectionId: IDS.connection,
    network: 'facebook', testAccountRef: 'test-account:facebook:property-predator',
    displayName: 'Property Predator Facebook TEST',
  }), { targetId: IDS.target, disposition: 'replayed' });
  assert.deepEqual(await repository.resolveTestTargets(IDS.workspace, [IDS.target]), [{
    targetId: IDS.target,
    network: 'facebook',
    testAccountRef: 'test-account:facebook:property-predator',
  }]);
  assert.deepEqual(await repository.schedule({
    workspaceId: IDS.workspace, postId: IDS.post, campaignId: IDS.campaign,
    revisionId: IDS.revision, contentItemId: IDS.item,
    approvalRequestId: IDS.request, approvalDecisionId: IDS.decision,
    sourceAttestationId: IDS.attestation, plan: sealedPlan(),
    targetBindings: [{ targetId: IDS.target, planTargetId: 'social_test_target_facebook' }],
    mediaBindings: approvedMediaBindings(),
  }), { postId: IDS.post, operationIds: [IDS.operation], disposition: 'applied' });
  assert.deepEqual(await repository.cancelTarget({
    workspaceId: IDS.workspace, operationId: IDS.operation,
    reason: 'Founder cancelled this fictional target.',
  }), { operationId: IDS.operation, state: 'simulated_cancelled', disposition: 'applied' });

  assert.match(executor.calls[0]!.sql, /app_private\.create_test_social_campaign_revision/);
  assert.match(executor.calls[1]!.sql, /app_private\.register_test_social_campaign_target/);
  assert.match(executor.calls[2]!.sql, /app_private\.resolve_test_social_campaign_targets/);
  assert.match(executor.calls[3]!.sql, /app_private\.schedule_test_social_campaign/);
  assert.match(executor.calls[4]!.sql, /app_private\.cancel_test_social_campaign_target/);
  for (const call of executor.calls) {
    assert.doesNotMatch(call.sql, /\b(?:insert|update|delete)\s+(?:into\s+)?app\./i);
  }
  assert.deepEqual(executor.calls[3]!.values[13], [IDS.target]);
  assert.equal(executor.calls[3]!.values[12], sealedPlan().planSha256);
  assert.deepEqual(JSON.parse(executor.calls[3]!.values[14] as string), [{
    contentItemId: IDS.item,
    contentVersionId: IDS.media,
    contentSha256: 'b'.repeat(64),
    blobSha256: 'd'.repeat(64),
    approvalRequestId: IDS.request,
    approvalDecisionId: IDS.decision,
    sourceAttestationId: IDS.attestation,
  }]);
  assert.equal(executor.calls[4]!.values[2], createHash('sha256')
    .update('Founder cancelled this fictional target.', 'utf8').digest('hex'));
  assert.doesNotMatch(JSON.stringify(executor.calls[4]!.values), /Founder cancelled/);
});

test('schedule fails before SQL on a forged plan or incomplete target binding', async () => {
  const executor = new FakeExecutor([]);
  const repository = new PgSocialCampaignCommandRepository(executor);
  const base = {
    workspaceId: IDS.workspace, postId: IDS.post, campaignId: IDS.campaign,
    revisionId: IDS.revision, contentItemId: IDS.item,
    approvalRequestId: IDS.request, approvalDecisionId: IDS.decision,
    sourceAttestationId: IDS.attestation,
  };
  await assert.rejects(repository.schedule({
    ...base, plan: { ...sealedPlan(), text: 'Changed after sealing.' }, targetBindings: [],
    mediaBindings: approvedMediaBindings(),
  }), /plan hash|cover/);
  await assert.rejects(repository.schedule({
    ...base, plan: sealedPlan(), targetBindings: [], mediaBindings: approvedMediaBindings(),
  }), /cover/);
  await assert.rejects(repository.schedule({
    ...base, approvalDecisionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    plan: sealedPlan(),
    targetBindings: [{ targetId: IDS.target, planTargetId: 'social_test_target_facebook' }],
    mediaBindings: approvedMediaBindings(),
  }), /exact approval/);
  const bodyMismatch = createPublicSocialDarkPlan({
    ...sealedPlan(),
    contentSha256: 'f'.repeat(64),
  });
  await assert.rejects(repository.schedule({
    ...base,
    plan: bodyMismatch,
    targetBindings: [{ targetId: IDS.target, planTargetId: 'social_test_target_facebook' }],
    mediaBindings: approvedMediaBindings(),
  }), /body does not match the exact approved content hash/);
  assert.equal(executor.calls.length, 0);
});

test('revision command rejects a caller-supplied hash that is not its canonical payload', async () => {
  const executor = new FakeExecutor([]);
  const repository = new PgSocialCampaignCommandRepository(executor);
  await assert.rejects(repository.createRevision({
    workspaceId: IDS.workspace,
    campaignId: IDS.campaign,
    revisionId: IDS.revision,
    revisionNumber: 1,
    previousRevisionId: null,
    title: 'Canonical campaign title',
    objective: 'Canonical campaign objective',
    timezone: 'Europe/London',
    revisionSha256: 'a'.repeat(64),
  }), /canonical campaign revision/);
  const bidiRevision = {
    workspaceId: IDS.workspace,
    campaignId: IDS.campaign,
    revisionId: IDS.revision,
    revisionNumber: 1,
    previousRevisionId: null,
    title: 'Campaign\u202Etxt.exe',
    objective: 'Canonical campaign objective',
    timezone: 'Europe/London',
  } as const;
  await assert.rejects(repository.createRevision({
    ...bidiRevision,
    revisionSha256: socialCampaignRevisionSha256(bidiRevision),
  }), /title is invalid/);
  assert.equal(executor.calls.length, 0);
});

test('target resolution rejects reordered or browser-forged command truth', async () => {
  const executor = new FakeExecutor([[{
    ordinal: 1,
    targetId: IDS.target,
    network: 'instagram',
    testAccountRef: 'test-account:facebook:property-predator',
  }]]);
  const repository = new PgSocialCampaignCommandRepository(executor);
  await assert.rejects(
    repository.resolveTestTargets(IDS.workspace, [IDS.target]),
    /not bound to command truth/,
  );
});

test('read projections are bounded, canonical and never select account refs, bodies or secrets', async () => {
  const executor = new FakeExecutor([
    [{
      campaignId: IDS.campaign, revisionId: IDS.revision, revisionNumber: 1,
      revisionSha256: 'c'.repeat(64), title: 'TEST campaign', objective: 'Safe objective',
      timezone: 'Europe/London', postId: IDS.post, contentItemId: IDS.item,
      contentVersionId: IDS.version, contentSha256: 'a'.repeat(64),
      planSha256: 'd'.repeat(64), scheduledFor: '2026-08-28T09:00:00.000Z',
      operationId: IDS.operation, targetId: IDS.target, network: 'facebook',
      targetLabel: 'Facebook TEST', state: 'waiting_for_test_time',
      simulationAttemptCount: 0, maxSimulationAttempts: 3,
      reconciliationAttemptCount: 0, maxReconciliationAttempts: 3,
      testReferenceSha256: null,
      hasMore: false,
    }],
    [{
      campaignId: IDS.campaign, revisionId: IDS.revision, revisionNumber: 1,
      campaignTitle: 'TEST campaign', postId: IDS.post, contentItemId: IDS.item,
      contentVersionId: IDS.version, contentSha256: 'a'.repeat(64),
      planSha256: 'd'.repeat(64), scheduledFor: '2026-08-28T09:00:00.000Z',
      operationId: IDS.operation, targetId: IDS.target, network: 'facebook',
      targetLabel: 'Facebook TEST', state: 'waiting_for_test_time',
      simulationAttemptCount: 0, maxSimulationAttempts: 3,
      reconciliationAttemptCount: 0, maxReconciliationAttempts: 3,
      updatedAt: '2026-08-27T12:00:00.000Z',
      hasMore: false,
    }],
  ]);
  const repository = new PgSocialCampaignReadRepository(executor);
  const command = await repository.listCampaign(IDS.workspace, IDS.campaign);
  const calendar = await repository.listCalendar({
    workspaceId: IDS.workspace,
    from: '2026-08-27T00:00:00.000Z',
    to: '2026-09-03T00:00:00.000Z',
    limit: 100,
  });
  assert.equal(command.items[0]?.providerEffects, 'none');
  assert.equal(command.items[0]?.environment, 'test');
  assert.equal(command.hasMore, false);
  assert.equal(calendar.items[0]?.providerEffects, 'none');
  assert.equal(calendar.items[0]?.environment, 'test');
  assert.equal(calendar.hasMore, false);
  for (const call of executor.calls) {
    assert.doesNotMatch(call.sql, /test_account_ref|body(?:_text)?|credential|secret|token/i);
    assert.match(call.sql, /app_private\.list_social_campaign_/);
  }
  assert.doesNotMatch(JSON.stringify({ command, calendar }), /test-account:|Fictional TEST social post/);
});

test('limit-plus-one reads disclose continuation and never return a partial post aggregate', async () => {
  const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
  const commandRows = Array.from({ length: 121 }, (_, index) => ({
    campaignId: IDS.campaign,
    revisionId: IDS.revision,
    revisionNumber: 1,
    revisionSha256: 'c'.repeat(64),
    title: 'TEST campaign',
    objective: 'Safe objective',
    timezone: 'Europe/London',
    postId: index < 119 ? uuid(10_000 + index) : uuid(99_999),
    contentItemId: IDS.item,
    contentVersionId: IDS.version,
    contentSha256: 'a'.repeat(64),
    planSha256: 'd'.repeat(64),
    scheduledFor: '2026-08-28T09:00:00.000Z',
    operationId: uuid(20_000 + index),
    targetId: uuid(30_000 + index),
    network: index === 120 ? 'instagram' : 'facebook',
    targetLabel: `Target ${index}`,
    state: 'waiting_for_test_time',
    simulationAttemptCount: 0,
    maxSimulationAttempts: 3,
    reconciliationAttemptCount: 0,
    maxReconciliationAttempts: 3,
    testReferenceSha256: null,
    hasMore: true,
  }));
  const calendarRows = [
    { ...commandRows[0], campaignTitle: 'TEST campaign', updatedAt: '2026-08-27T12:00:00.000Z' },
    { ...commandRows[119], campaignTitle: 'TEST campaign', updatedAt: '2026-08-27T12:00:00.000Z' },
    { ...commandRows[120], campaignTitle: 'TEST campaign', updatedAt: '2026-08-27T12:00:00.000Z' },
  ];
  const repository = new PgSocialCampaignReadRepository(new FakeExecutor([
    commandRows,
    calendarRows,
  ]));

  const command = await repository.listCampaign(IDS.workspace, IDS.campaign);
  const calendar = await repository.listCalendar({
    workspaceId: IDS.workspace,
    from: '2026-08-27T00:00:00.000Z',
    to: '2026-09-03T00:00:00.000Z',
    limit: 2,
  });

  assert.equal(command.hasMore, true);
  assert.equal(command.items.length, 119);
  assert.equal(command.items.some((row) => row.postId === uuid(99_999)), false);
  assert.equal(calendar.hasMore, true);
  assert.equal(calendar.items.length, 1);
  assert.equal(calendar.items.some((row) => row.postId === uuid(99_999)), false);
});

test('repository rejects malformed database rows rather than normalising them', async () => {
  const executor = new FakeExecutor([[
    { campaignId: IDS.campaign, revisionId: IDS.revision,
      revisionNumber: 1, disposition: 'APPLIED' },
  ]]);
  const repository = new PgSocialCampaignCommandRepository(executor);
  const revision = {
    workspaceId: IDS.workspace, campaignId: IDS.campaign, revisionId: IDS.revision,
    revisionNumber: 1, previousRevisionId: null, title: 'TEST', objective: 'Objective',
    timezone: 'UTC',
  } as const;
  await assert.rejects(repository.createRevision({
    ...revision,
    revisionSha256: socialCampaignRevisionSha256(revision),
  }), SocialCampaignPgContractError);
});
