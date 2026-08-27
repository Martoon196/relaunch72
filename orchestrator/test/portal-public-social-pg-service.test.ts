import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { SqlExecutor, SqlResult } from '../src/crm-pg/types.js';
import {
  PgPortalPublicSocialService,
  type PortalPublicSocialTransactionRunner,
} from '../src/portal/public-social-pg-service.js';

const IDS = {
  workspace: '11111111-1111-4111-8111-111111111111',
  user: '22222222-2222-4222-8222-222222222222',
  campaign: '33333333-3333-4333-8333-333333333333',
  revision: '44444444-4444-4444-8444-444444444444',
  connection: '55555555-5555-4555-8555-555555555555',
  target: '66666666-6666-4666-8666-666666666666',
  post: '77777777-7777-4777-8777-777777777777',
  item: '88888888-8888-4888-8888-888888888888',
  version: '99999999-9999-4999-8999-999999999999',
  approvalRequest: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  approvalDecision: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  attestation: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  mediaVersion: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  operation: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  intent: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  successor: '12121212-1212-4212-8212-121212121212',
} as const;
const SESSION = 'opaque-browser-session-token';
const IDENTITY = Object.freeze({ sessionToken: SESSION, requestId: 'portal-public-social-test' });
const NOW = '2026-08-27T12:00:00.000Z';

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

interface RunnerCall {
  readonly context: Parameters<PortalPublicSocialTransactionRunner['run']>[0];
  readonly options: Readonly<{ readOnly: boolean; serializable?: boolean }>;
  readonly executor: FakeExecutor;
}

class FakeRunner implements PortalPublicSocialTransactionRunner {
  readonly calls: RunnerCall[] = [];
  constructor(private readonly runs: readonly (readonly (readonly Record<string, unknown>[])[])[]) {}

  async run<T>(
    context: Parameters<PortalPublicSocialTransactionRunner['run']>[0],
    operation: (transaction: SqlExecutor) => Promise<T>,
    options: Readonly<{ readOnly: boolean; serializable?: boolean }>,
  ): Promise<T> {
    const executor = new FakeExecutor(this.runs[this.calls.length] ?? []);
    this.calls.push({ context, options, executor });
    return operation(executor);
  }
}

class RejectingRunner implements PortalPublicSocialTransactionRunner {
  constructor(private readonly code: string) {}

  async run<T>(): Promise<T> {
    throw Object.assign(new Error('private PostgreSQL detail'), { code: this.code });
  }
}

function workspace(canManage = true): readonly Record<string, unknown>[] {
  return [{
    workspaceId: IDS.workspace,
    workspaceName: 'Property Predator',
    timezone: 'Europe/London',
    snapshotAt: NOW,
    canManage,
  }];
}

function principalResolver(principal: { userId: string; workspaceId: string } | null = {
  userId: IDS.user,
  workspaceId: IDS.workspace,
}) {
  const tokens: string[] = [];
  return {
    tokens,
    resolver: {
      async resolve(token: string) {
        tokens.push(token);
        return principal;
      },
    },
  };
}

function derivedCommandUuid(
  kind: 'campaign' | 'revision' | 'plan' | 'reschedule',
  commandKey: string,
): string {
  const bytes = createHash('sha256').update([
    'public-social-portal-command/v1', kind, IDS.workspace, IDS.user, commandKey,
  ].join('\n'), 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

test('authenticated snapshot stays on the web transaction and exposes only safe projections', async () => {
  const campaignRow = {
    campaignId: IDS.campaign,
    revisionId: IDS.revision,
    revisionNumber: 1,
    revisionSha256: '1'.repeat(64),
    title: 'Launch rehearsal',
    objective: 'Exercise the TEST-only social rail.',
    timezone: 'Europe/London',
    postId: IDS.post,
    contentItemId: IDS.item,
    contentVersionId: IDS.version,
    contentSha256: '2'.repeat(64),
    planSha256: '3'.repeat(64),
    scheduledFor: '2026-08-28T09:00:00.000Z',
    operationId: IDS.operation,
    targetId: IDS.target,
    network: 'facebook',
    targetLabel: 'Facebook TEST',
    state: 'waiting_for_test_time',
    simulationAttemptCount: 0,
    maxSimulationAttempts: 3,
    reconciliationAttemptCount: 0,
    maxReconciliationAttempts: 3,
    testReferenceSha256: null,
    hasMore: false,
  };
  const calendarRow = {
    campaignId: IDS.campaign,
    revisionId: IDS.revision,
    revisionNumber: 1,
    campaignTitle: 'Launch rehearsal',
    postId: IDS.post,
    contentItemId: IDS.item,
    contentVersionId: IDS.version,
    contentSha256: '2'.repeat(64),
    planSha256: '3'.repeat(64),
    scheduledFor: '2026-08-28T09:00:00.000Z',
    operationId: IDS.operation,
    targetId: IDS.target,
    network: 'facebook',
    targetLabel: 'Facebook TEST',
    state: 'waiting_for_test_time',
    simulationAttemptCount: 0,
    maxSimulationAttempts: 3,
    reconciliationAttemptCount: 0,
    maxReconciliationAttempts: 3,
    updatedAt: NOW,
    hasMore: false,
  };
  const plannerTargetRow = {
    targetId: IDS.target,
    network: 'facebook',
    targetLabel: 'Facebook TEST',
    hasMore: false,
  };
  const planningRow = {
    intentId: IDS.intent,
    campaignId: IDS.campaign,
    revisionId: IDS.revision,
    revisionNumber: 1,
    campaignTitle: 'Launch rehearsal',
    desiredFor: '2026-08-28T09:00:00.000Z',
    contentItemId: IDS.item,
    contentVersionId: IDS.version,
    contentSha256: '2'.repeat(64),
    intentSha256: '4'.repeat(64),
    targetId: IDS.target,
    network: 'facebook',
    targetLabel: 'Facebook TEST',
    planningState: 'awaiting_revalidation',
    materializedPostId: null,
    materializedOperationId: null,
    operationState: null,
    revalidationState: 'waiting_for_window',
    nextRevalidationAt: '2026-08-28T08:50:00.000Z',
    lastErrorCode: null,
    updatedAt: NOW,
    hasMore: false,
  };
  const readRunner = new FakeRunner([[
    workspace(),
    [campaignRow],
    [calendarRow],
    [plannerTargetRow],
    [planningRow],
  ]]);
  const commandRunner = new FakeRunner([]);
  const principal = principalResolver();
  const service = new PgPortalPublicSocialService({
    principalResolver: principal.resolver,
    readRunner,
    commandRunner,
  });
  const outcome = await service.snapshot(IDENTITY, {
    campaignId: IDS.campaign,
    from: '2026-08-27T00:00:00.000Z',
    to: '2026-09-03T00:00:00.000Z',
    limit: 60,
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.snapshot.workspace.workspaceId, IDS.workspace);
  assert.equal(outcome.snapshot.campaign.items[0]?.providerEffects, 'none');
  assert.equal(outcome.snapshot.campaign.hasMore, false);
  assert.equal(outcome.snapshot.calendar.items[0]?.providerEffects, 'none');
  assert.equal(outcome.snapshot.calendar.hasMore, false);
  assert.equal(outcome.snapshot.planning?.targets.items[0]?.targetLabel, 'Facebook TEST');
  assert.equal(
    outcome.snapshot.planning?.calendar.items[0]?.planningState,
    'awaiting_revalidation',
  );
  assert.equal(outcome.snapshot.environment, 'test');
  assert.equal(commandRunner.calls.length, 0);
  assert.equal(readRunner.calls.length, 1);
  assert.deepEqual(readRunner.calls[0]?.options, { readOnly: true, serializable: true });
  assert.deepEqual(readRunner.calls[0]?.executor.calls.map((call) => call.values[0]), [
    undefined,
    IDS.workspace,
    IDS.workspace,
    IDS.workspace,
    IDS.workspace,
  ]);
  assert.deepEqual(principal.tokens, [SESSION]);
  assert.equal(readRunner.calls[0]?.context.workspaceId, IDS.workspace);
  assert.deepEqual(readRunner.calls[0]?.context.portalSessionTokenHash,
    createHash('sha256').update(SESSION).digest());
  assert.doesNotMatch(
    JSON.stringify(outcome),
    /test-account:|body_text|blobStorageKey|fixtures\/|opaque-browser-session-token/u,
  );
});

test('manager commands persist browser-safe planning identities without accepting provider evidence', async () => {
  const readRunner = new FakeRunner([
    [workspace()], [workspace()], [workspace()], [workspace()],
  ]);
  const commandRunner = new FakeRunner([
    [[{
      campaignId: IDS.campaign,
      revisionId: IDS.revision,
      revisionNumber: 1,
      disposition: 'applied',
    }]],
    [[{
      intentId: derivedCommandUuid('plan', 'plan-command-001'),
      intentSha256: '5'.repeat(64),
      disposition: 'applied',
    }]],
    [[{
      successorIntentId: derivedCommandUuid('reschedule', 'reschedule-command-001'),
      disposition: 'applied',
    }]],
    [[{
      intentId: IDS.intent,
      targetId: IDS.target,
      state: 'cancelled',
      disposition: 'applied',
    }]],
  ]);
  const service = new PgPortalPublicSocialService({
    principalResolver: principalResolver().resolver,
    readRunner,
    commandRunner,
  });

  const revision = await service.createRevision(IDENTITY, {
    campaignId: IDS.campaign,
    revisionId: IDS.revision,
    revisionNumber: 1,
    previousRevisionId: null,
    title: 'Launch rehearsal',
    objective: 'Prove the TEST campaign command path.',
    timezone: 'Europe/London',
    revisionSha256: '1'.repeat(64),
    workspaceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  } as never);
  const planned = await service.plan(IDENTITY, {
    commandKey: 'plan-command-001',
    campaignId: IDS.campaign,
    revisionId: IDS.revision,
    contentVersionId: IDS.version,
    desiredFor: '2026-08-28T09:00:00.000Z',
    maxAttempts: 3,
    targetIds: [IDS.target],
    mediaVersionIds: [IDS.mediaVersion],
    workspaceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    text: 'PRIVATE-BROWSER-BODY',
    contentSha256: '8'.repeat(64),
    approvalDecisionId: IDS.approvalDecision,
    sourceAttestationId: IDS.attestation,
    connectionId: IDS.connection,
    testAccountRef: 'test-account:facebook:browser-controlled',
    blobStorageKey: 'browser/controlled/secret.png',
  } as never);
  const rescheduled = await service.reschedule(IDENTITY, {
    commandKey: 'reschedule-command-001',
    predecessorIntentId: IDS.intent,
    targetId: IDS.target,
    newDesiredFor: '2026-08-29T10:00:00.000Z',
    reason: 'Move this TEST placement to the next evidence window.',
    workspaceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  } as never);
  const cancelled = await service.cancel(IDENTITY, {
    intentId: IDS.intent,
    targetId: IDS.target,
    reason: 'Cancel this fictional TEST placement.',
  });

  for (const outcome of [revision, planned, rescheduled, cancelled]) {
    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok && outcome.environment, 'test');
    assert.equal(outcome.ok && outcome.providerEffects, 'none');
  }
  assert.equal(readRunner.calls.length, 4);
  assert.equal(commandRunner.calls.length, 4);
  assert.ok(readRunner.calls.every((call) => call.options.readOnly === true));
  assert.ok(commandRunner.calls.every((call) =>
    call.options.readOnly === false && call.options.serializable === true));

  const commandQueries = commandRunner.calls.flatMap((run) => run.executor.calls);
  assert.ok(commandQueries.every((call) => call.values[0] === IDS.workspace));
  assert.match(commandRunner.calls[0]!.executor.calls[0]!.values[8] as string, /^[a-f0-9]{64}$/u);
  assert.notEqual(commandRunner.calls[0]!.executor.calls[0]!.values[8], '1'.repeat(64));
  const planQuery = commandRunner.calls[1]!.executor.calls[0]!;
  const rescheduleQuery = commandRunner.calls[2]!.executor.calls[0]!;
  const cancelQuery = commandRunner.calls[3]!.executor.calls[0]!;
  assert.match(planQuery.sql, /create_test_social_planning_intent/u);
  assert.match(planQuery.values[1] as string, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(planQuery.values.slice(2), [
    IDS.campaign, IDS.revision, IDS.version, '2026-08-28T09:00:00.000Z',
    3, [IDS.target], [IDS.mediaVersion],
  ]);
  assert.match(rescheduleQuery.sql, /reschedule_test_social_planning_target/u);
  assert.match(cancelQuery.sql, /cancel_test_social_planning_target/u);
  assert.equal(rescheduleQuery.values[5], createHash('sha256')
    .update('Move this TEST placement to the next evidence window.', 'utf8').digest('hex'));
  assert.equal(cancelQuery.values[3], createHash('sha256')
    .update('Cancel this fictional TEST placement.', 'utf8').digest('hex'));
  assert.doesNotMatch(JSON.stringify(commandRunner.calls),
    /PRIVATE-BROWSER-BODY|browser-controlled|secret\.png|approvalDecisionId|sourceAttestationId/u);
  assert.doesNotMatch(
    JSON.stringify({ revision, planned, rescheduled, cancelled }),
    /test-account:|PRIVATE-BROWSER-BODY|blobStorageKey|secret\.png/u,
  );
});

test('campaign wizard creates revision and planning intent in one serializable transaction', async () => {
  const commandKey = 'wizard-command-001';
  const campaignId = derivedCommandUuid('campaign', commandKey);
  const revisionId = derivedCommandUuid('revision', commandKey);
  const intentId = derivedCommandUuid('plan', commandKey);
  const readRunner = new FakeRunner([[workspace()]]);
  const commandRunner = new FakeRunner([[
    [{ campaignId, revisionId, revisionNumber: 1, disposition: 'applied' }],
    [{ intentId, intentSha256: '6'.repeat(64), disposition: 'applied' }],
  ]]);
  const service = new PgPortalPublicSocialService({
    principalResolver: principalResolver().resolver,
    readRunner,
    commandRunner,
  });

  const outcome = await service.createCampaignPlan(IDENTITY, {
    commandKey,
    title: 'Predator evidence week',
    objective: 'Move one approved company asset through the TEST planning rail.',
    contentVersionId: IDS.version,
    desiredFor: '2026-09-02T10:30:00.000Z',
    targetIds: [IDS.target],
    mediaVersionIds: [IDS.mediaVersion],
  });

  assert.deepEqual(outcome, {
    ok: true,
    result: {
      campaignId,
      revisionId,
      intentId,
      intentSha256: '6'.repeat(64),
      disposition: 'applied',
    },
    environment: 'test',
    providerEffects: 'none',
  });
  assert.equal(commandRunner.calls.length, 1);
  assert.deepEqual(commandRunner.calls[0]?.options, { readOnly: false, serializable: true });
  assert.equal(commandRunner.calls[0]?.executor.calls.length, 2);
  assert.match(commandRunner.calls[0]!.executor.calls[0]!.sql,
    /create_test_social_campaign_revision/u);
  assert.match(commandRunner.calls[0]!.executor.calls[1]!.sql,
    /create_test_social_planning_intent/u);
  assert.deepEqual(commandRunner.calls[0]!.executor.calls[1]!.values.slice(1), [
    intentId, campaignId, revisionId, IDS.version,
    '2026-09-02T10:30:00.000Z', 3, [IDS.target], [IDS.mediaVersion],
  ]);
});

test('planning rejects an invalid command key before command SQL', async () => {
  const readRunner = new FakeRunner([[workspace()]]);
  const commandRunner = new FakeRunner([]);
  const service = new PgPortalPublicSocialService({
    principalResolver: principalResolver().resolver,
    readRunner,
    commandRunner,
  });
  const outcome = await service.plan(IDENTITY, {
    commandKey: 'contains spaces',
    campaignId: IDS.campaign,
    revisionId: IDS.revision,
    contentVersionId: IDS.version,
    desiredFor: '2026-08-28T09:00:00.000Z',
    maxAttempts: 3,
    targetIds: [IDS.target],
    mediaVersionIds: [],
  });
  assert.deepEqual(outcome, {
    ok: false,
    kind: 'validation',
    message: 'Check the exact TEST campaign evidence and try again.',
  });
  assert.equal(commandRunner.calls.length, 0);
});

test('unsafe planning lifecycle conflicts return safe copy', async () => {
  const service = new PgPortalPublicSocialService({
    principalResolver: principalResolver().resolver,
    readRunner: new FakeRunner([[workspace()]]),
    commandRunner: new RejectingRunner('55000'),
  });
  const outcome = await service.cancel(IDENTITY, {
    intentId: IDS.intent,
    targetId: IDS.target,
    reason: 'Cancel only if the lifecycle is still safe.',
  });
  assert.deepEqual(outcome, {
    ok: false,
    kind: 'conflict',
    message: 'The TEST campaign changed after this page loaded. Refresh before trying again.',
  });
  assert.doesNotMatch(JSON.stringify(outcome), /PostgreSQL|private|55000/iu);
});

test('missing sessions and read-only memberships fail before command SQL with safe copy', async () => {
  const unauthenticatedRead = new FakeRunner([]);
  const unauthenticatedCommand = new FakeRunner([]);
  const unauthenticated = new PgPortalPublicSocialService({
    principalResolver: principalResolver(null).resolver,
    readRunner: unauthenticatedRead,
    commandRunner: unauthenticatedCommand,
  });
  assert.deepEqual(await unauthenticated.createRevision(IDENTITY, {
    campaignId: IDS.campaign,
    revisionId: IDS.revision,
    revisionNumber: 1,
    previousRevisionId: null,
    title: 'TEST',
    objective: 'TEST objective',
    timezone: 'UTC',
  }), {
    ok: false,
    kind: 'unauthenticated',
    message: 'This portal session is no longer active.',
  });
  assert.equal(unauthenticatedRead.calls.length, 0);
  assert.equal(unauthenticatedCommand.calls.length, 0);

  const readOnlyRunner = new FakeRunner([[workspace(false)]]);
  const forbiddenCommand = new FakeRunner([]);
  const readOnly = new PgPortalPublicSocialService({
    principalResolver: principalResolver().resolver,
    readRunner: readOnlyRunner,
    commandRunner: forbiddenCommand,
  });
  const outcome = await readOnly.cancel(IDENTITY, {
    intentId: IDS.intent,
    targetId: IDS.target,
    reason: 'Cannot run.',
  });
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.kind, 'forbidden');
  assert.equal(forbiddenCommand.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(outcome), /postgres|token|test-account:/iu);
});
