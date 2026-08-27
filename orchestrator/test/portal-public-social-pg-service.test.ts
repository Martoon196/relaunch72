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
  const readRunner = new FakeRunner([[
    workspace(),
    [campaignRow],
    [calendarRow],
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
  assert.equal(outcome.snapshot.environment, 'test');
  assert.equal(commandRunner.calls.length, 0);
  assert.equal(readRunner.calls.length, 1);
  assert.deepEqual(readRunner.calls[0]?.options, { readOnly: true, serializable: true });
  assert.deepEqual(readRunner.calls[0]?.executor.calls.map((call) => call.values[0]), [
    undefined,
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

test('manager commands inject the session workspace, derive TEST refs and keep write-only plan data out of outcomes', async () => {
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
    [[{ targetId: IDS.target, disposition: 'applied' }]],
    [
      [{
        ordinal: 1,
        targetId: IDS.target,
        network: 'facebook',
        testAccountRef: 'test-account:facebook:database_owned_target',
      }],
      [{ postId: IDS.post, operationIds: [IDS.operation], disposition: 'applied' }],
    ],
    [[{ operationId: IDS.operation, state: 'simulated_cancelled', disposition: 'applied' }]],
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
  const registered = await service.registerTestTarget(IDENTITY, {
    targetId: IDS.target,
    connectionId: IDS.connection,
    network: 'facebook',
    displayName: 'Property Predator Facebook TEST',
    testAccountRef: 'test-account:facebook:browser-controlled',
  } as never);
  const body = 'Write-only fictional TEST post content.';
  const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex');
  const scheduled = await service.schedule(IDENTITY, {
    postId: IDS.post,
    campaignId: IDS.campaign,
    revisionId: IDS.revision,
    contentItemId: IDS.item,
    contentVersionId: IDS.version,
    contentSha256: bodySha256,
    approvalRequestId: IDS.approvalRequest,
    approvalDecisionId: IDS.approvalDecision,
    sourceAttestationId: IDS.attestation,
    text: body,
    scheduledFor: '2026-08-28T09:00:00.000Z',
    maxAttempts: 3,
    targets: [{ targetId: IDS.target, network: 'instagram' }],
    mediaBindings: [{
      planArtifactId: IDS.mediaVersion,
      contentItemId: IDS.item,
      contentVersionId: IDS.mediaVersion,
      contentSha256: '4'.repeat(64),
      blobSha256: '5'.repeat(64),
      approvalRequestId: IDS.approvalRequest,
      approvalDecisionId: IDS.approvalDecision,
      sourceAttestationId: IDS.attestation,
    }],
    workspaceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    testAccountRef: 'test-account:facebook:browser-controlled',
    blobStorageKey: 'browser/controlled/secret.png',
  } as never);
  const cancelled = await service.cancelTarget(IDENTITY, {
    operationId: IDS.operation,
    reason: 'Cancel this fictional TEST target.',
    workspaceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  } as never);

  for (const outcome of [revision, registered, scheduled, cancelled]) {
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
  assert.equal(commandRunner.calls[1]!.executor.calls[0]!.values[4],
    'test-account:facebook:portal_66666666666646668666666666666666');
  const targetResolutionQuery = commandRunner.calls[2]!.executor.calls[0]!;
  const scheduleQuery = commandRunner.calls[2]!.executor.calls[1]!;
  assert.match(targetResolutionQuery.sql, /resolve_test_social_campaign_targets/u);
  assert.deepEqual(targetResolutionQuery.values[1], [IDS.target]);
  assert.doesNotMatch(JSON.stringify(scheduleQuery.values), /browser-controlled|secret\.png/u);
  assert.doesNotMatch(JSON.stringify(scheduleQuery.values), new RegExp(body, 'u'));
  assert.deepEqual(Object.keys(JSON.parse(scheduleQuery.values[14] as string)[0]).sort(), [
    'approvalDecisionId', 'approvalRequestId', 'blobSha256', 'contentItemId',
    'contentSha256', 'contentVersionId', 'sourceAttestationId',
  ]);
  assert.doesNotMatch(
    JSON.stringify({ revision, registered, scheduled, cancelled }),
    /test-account:|Write-only fictional|blobStorageKey|secret\.png/u,
  );
});

test('schedule rejects a browser body that does not hash to the approved content before command SQL', async () => {
  const readRunner = new FakeRunner([[workspace()]]);
  const commandRunner = new FakeRunner([]);
  const service = new PgPortalPublicSocialService({
    principalResolver: principalResolver().resolver,
    readRunner,
    commandRunner,
  });
  const outcome = await service.schedule(IDENTITY, {
    postId: IDS.post,
    campaignId: IDS.campaign,
    revisionId: IDS.revision,
    contentItemId: IDS.item,
    contentVersionId: IDS.version,
    contentSha256: '2'.repeat(64),
    approvalRequestId: IDS.approvalRequest,
    approvalDecisionId: IDS.approvalDecision,
    sourceAttestationId: IDS.attestation,
    text: 'A different browser-supplied body.',
    scheduledFor: '2026-08-28T09:00:00.000Z',
    maxAttempts: 3,
    targets: [{ targetId: IDS.target }],
    mediaBindings: [],
  });
  assert.deepEqual(outcome, {
    ok: false,
    kind: 'validation',
    message: 'Check the exact TEST campaign evidence and try again.',
  });
  assert.equal(commandRunner.calls.length, 0);
});

test('schedule explains the short source-proof window without exposing database detail', async () => {
  const body = 'Exact short-horizon TEST rehearsal body.';
  const service = new PgPortalPublicSocialService({
    principalResolver: principalResolver().resolver,
    readRunner: new FakeRunner([[workspace()]]),
    commandRunner: new RejectingRunner('P0039'),
  });
  const outcome = await service.schedule(IDENTITY, {
    postId: IDS.post,
    campaignId: IDS.campaign,
    revisionId: IDS.revision,
    contentItemId: IDS.item,
    contentVersionId: IDS.version,
    contentSha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    approvalRequestId: IDS.approvalRequest,
    approvalDecisionId: IDS.approvalDecision,
    sourceAttestationId: IDS.attestation,
    text: body,
    scheduledFor: '2026-08-28T09:00:00.000Z',
    maxAttempts: 3,
    targets: [{ targetId: IDS.target }],
    mediaBindings: [],
  });
  assert.deepEqual(outcome, {
    ok: false,
    kind: 'validation',
    message: 'The exact source proof expires before that TEST time. Refresh the proof or choose an earlier rehearsal time.',
  });
  assert.doesNotMatch(JSON.stringify(outcome), /PostgreSQL|private|P0039/iu);
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
  const outcome = await readOnly.cancelTarget(IDENTITY, {
    operationId: IDS.operation,
    reason: 'Cannot run.',
  });
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.kind, 'forbidden');
  assert.equal(forbiddenCommand.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(outcome), /postgres|token|test-account:/iu);
});
