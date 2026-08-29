import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { SqlExecutor, SqlResult } from '../src/crm-pg/types.js';
import { requestDatabaseContext } from '../src/db/rls.js';
import { InactivePortalSessionError } from '../src/db/transaction.js';
import {
  createPortalConversionInboxOperationsTransactionRunner,
  PgPortalConversionInboxOperationsService,
  type PortalConversionInboxOperationsTransactionRunner,
} from '../src/portal/conversion-inbox-operations-pg-service.js';
import {
  CONVERSION_INBOX_INTERNAL_NOTE_MAX_BYTES,
  CONVERSION_INBOX_NEXT_ACTION_TITLE_MAX_BYTES,
} from '../src/portal/conversion-inbox-operations-service.js';

const IDS = Object.freeze({
  workspace: '11111111-1111-4111-8111-111111111111',
  user: '22222222-2222-4222-8222-222222222222',
  conversation: '33333333-3333-4333-8333-333333333333',
  contact: '44444444-4444-4444-8444-444444444444',
  message: '55555555-5555-4555-8555-555555555555',
  messageVersion: '66666666-6666-4666-8666-666666666666',
  task: '77777777-7777-4777-8777-777777777777',
  outcome: '88888888-8888-4888-8888-888888888888',
  nextTask: '99999999-9999-4999-8999-999999999999',
});
const SESSION = 'opaque-server-session-token';
const IDENTITY = Object.freeze({ sessionToken: SESSION, requestId: 'inbox-ops-request-001' });
const SESSION_DIGEST = createHash('sha256').update(SESSION).digest();
const DUE_AT = '2026-08-29T16:30:00.000Z';
const OCCURRED_AT = '2026-08-29T15:30:00.000Z';

interface RecordedQuery {
  readonly sql: string;
  readonly values: readonly unknown[];
}

class FakeExecutor implements SqlExecutor {
  readonly calls: RecordedQuery[] = [];

  constructor(private readonly rows: readonly Record<string, unknown>[]) {}

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<SqlResult<TRow>> {
    this.calls.push({ sql, values });
    return { rows: this.rows as TRow[], rowCount: this.rows.length };
  }
}

interface RunnerCall {
  readonly context: Parameters<PortalConversionInboxOperationsTransactionRunner['run']>[0];
  readonly executor: FakeExecutor;
}

class FakeRunner implements PortalConversionInboxOperationsTransactionRunner {
  readonly calls: RunnerCall[] = [];

  constructor(private readonly responses: readonly (readonly Record<string, unknown>[])[]) {}

  async run<T>(
    context: Parameters<PortalConversionInboxOperationsTransactionRunner['run']>[0],
    operation: (transaction: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    const executor = new FakeExecutor(this.responses[this.calls.length] ?? []);
    this.calls.push({ context, executor });
    return operation(executor);
  }
}

class RejectingRunner implements PortalConversionInboxOperationsTransactionRunner {
  calls = 0;

  constructor(private readonly error: unknown) {}

  async run<T>(): Promise<T> {
    this.calls += 1;
    throw this.error;
  }
}

function principalResolver(
  principal: { readonly userId: string; readonly workspaceId: string } | null = {
    userId: IDS.user,
    workspaceId: IDS.workspace,
  },
) {
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

function service(
  runner: PortalConversionInboxOperationsTransactionRunner,
  principal = principalResolver(),
) {
  return {
    principal,
    operations: new PgPortalConversionInboxOperationsService({
      principalResolver: principal.resolver,
      commandRunner: runner,
    }),
  };
}

test('the operational boundary exposes no delivery, provider or enqueue method', () => {
  assert.deepEqual(
    Object.getOwnPropertyNames(PgPortalConversionInboxOperationsService.prototype).sort(),
    [
      'appendInternalNote',
      'assignConversation',
      'constructor',
      'createAdminCall',
      'recordCallOutcome',
    ],
  );
});

test('all operational commands bind the active server session and call the exact 0055 functions', async () => {
  const runner = new FakeRunner([
    [{
      disposition: 'applied', conversationId: IDS.conversation,
      assignedUserId: IDS.user, rowVersion: '4',
    }],
    [{
      disposition: 'replayed', conversationId: IDS.conversation,
      messageId: IDS.message, messageVersionId: IDS.messageVersion,
      versionNumber: 1, bodySha256: Buffer.from('ab'.repeat(32), 'hex'),
      conversationRowVersion: '5',
    }],
    [{
      disposition: 'applied', conversationId: IDS.conversation,
      contactId: IDS.contact, taskId: IDS.task, taskRowVersion: '1',
    }],
    [{
      disposition: 'applied', conversationId: IDS.conversation,
      contactId: IDS.contact, outcomeId: IDS.outcome,
      completedTaskId: IDS.task, completedTaskRowVersion: '2',
      nextTaskId: IDS.nextTask, nextTaskRowVersion: '1',
    }],
  ]);
  const built = service(runner);

  const assigned = await built.operations.assignConversation(IDENTITY, {
    commandKey: 'assign_command_0001',
    conversationId: IDS.conversation.toUpperCase(),
    expectedRowVersion: '3',
    assignment: 'self',
    assignedUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    accessToken: 'must-not-cross-the-boundary',
  } as never);
  const noted = await built.operations.appendInternalNote(IDENTITY, {
    commandKey: 'note_command_000001',
    conversationId: IDS.conversation,
    body: 'Founder reviewed the reply and queued no external effect.',
    providerConnectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    recipient: 'private-recipient@example.test',
  } as never);
  const created = await built.operations.createAdminCall(IDENTITY, {
    commandKey: 'call_command_000001',
    conversationId: IDS.conversation,
    priority: 'urgent',
    dueAt: DUE_AT,
    note: 'Call to clarify the requested next step.',
    credential: 'must-not-cross-the-boundary',
  } as never);
  const recorded = await built.operations.recordCallOutcome(IDENTITY, {
    commandKey: 'outcome_command_001',
    conversationId: IDS.conversation,
    taskId: IDS.task,
    expectedTaskRowVersion: '1',
    outcome: 'follow_up_requested',
    summary: 'Contact asked for a follow-up after reviewing the evidence.',
    occurredAt: OCCURRED_AT,
    nextAction: {
      kind: 'internal_follow_up',
      title: 'Review evidence before the promised follow-up',
      dueAt: DUE_AT,
      priority: 'high',
      externalRecipient: 'must-not-cross-the-boundary',
    },
    secret: 'must-not-cross-the-boundary',
  } as never);

  assert.deepEqual(assigned, {
    ok: true, disposition: 'applied', conversationId: IDS.conversation,
    assignedUserId: IDS.user, rowVersion: 4,
  });
  assert.deepEqual(noted, {
    ok: true, disposition: 'replayed', conversationId: IDS.conversation,
    messageId: IDS.message, messageVersionId: IDS.messageVersion,
    versionNumber: 1, bodySha256: 'ab'.repeat(32), conversationRowVersion: 5,
  });
  assert.deepEqual(created, {
    ok: true, disposition: 'applied', conversationId: IDS.conversation,
    contactId: IDS.contact, taskId: IDS.task, taskRowVersion: 1,
  });
  assert.deepEqual(recorded, {
    ok: true, disposition: 'applied', conversationId: IDS.conversation,
    contactId: IDS.contact, outcomeId: IDS.outcome, completedTaskId: IDS.task,
    completedTaskRowVersion: 2, nextTaskId: IDS.nextTask, nextTaskRowVersion: 1,
  });

  assert.deepEqual(built.principal.tokens, [SESSION, SESSION, SESSION, SESSION]);
  assert.equal(runner.calls.length, 4);
  for (const call of runner.calls) {
    assert.equal(call.context.actorKind, 'user');
    assert.equal(call.context.userId, IDS.user);
    assert.equal(call.context.workspaceId, IDS.workspace);
    assert.deepEqual(call.context.portalSessionTokenHash, SESSION_DIGEST);
    assert.equal(call.executor.calls.length, 1);
    assert.equal(call.executor.calls[0]?.values[0], IDS.workspace);
    assert.deepEqual(call.executor.calls[0]?.values[1], SESSION_DIGEST);
  }

  const queries = runner.calls.map((call) => call.executor.calls[0]!);
  const assignmentQuery = queries[0]!;
  const noteQuery = queries[1]!;
  const callQuery = queries[2]!;
  const outcomeQuery = queries[3]!;
  assert.match(assignmentQuery.sql, /app_private\.assign_operational_inbox_conversation\(/u);
  assert.deepEqual(assignmentQuery.values.slice(2), [
    IDS.conversation, IDS.user, 3, 'assign_command_0001',
  ]);
  assert.match(noteQuery.sql, /app_private\.append_operational_inbox_internal_note\(/u);
  assert.deepEqual(noteQuery.values.slice(2), [
    IDS.conversation,
    'Founder reviewed the reply and queued no external effect.',
    'note_command_000001',
  ]);
  assert.match(callQuery.sql, /app_private\.create_operational_inbox_admin_call_task\(/u);
  assert.deepEqual(callQuery.values.slice(2), [
    IDS.conversation, 'urgent', DUE_AT,
    'Call to clarify the requested next step.', 'call_command_000001',
  ]);
  assert.match(outcomeQuery.sql, /app_private\.record_operational_inbox_admin_call_outcome\(/u);
  assert.deepEqual(outcomeQuery.values.slice(2), [
    IDS.conversation, IDS.task, 1, 'follow_up_requested',
    'Contact asked for a follow-up after reviewing the evidence.', OCCURRED_AT,
    'internal_follow_up', 'Review evidence before the promised follow-up',
    DUE_AT, 'high', 'outcome_command_001',
  ]);

  const commandBoundary = JSON.stringify(
    runner.calls.flatMap((call) => call.executor.calls.map((query) => query.values)),
  );
  assert.doesNotMatch(commandBoundary,
    /must-not-cross|private-recipient|providerConnectionId|externalRecipient|accessToken/u);
  assert.ok(Object.isFrozen(assigned));
  assert.ok(Object.isFrozen(recorded));
});

test('the production command runner revalidates the session in a serializable read-write transaction', async () => {
  const calls: { readonly sql: string; readonly values: readonly unknown[] }[] = [];
  let released = false;
  const client = {
    async query(sql: string, values: readonly unknown[] = []) {
      calls.push({ sql, values });
      if (/lock_active_portal_session/u.test(sql)) {
        return { rows: [{ active: true }], rowCount: 1 };
      }
      if (/SELECT 42 AS answer/u.test(sql)) {
        return { rows: [{ answer: 42 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() { released = true; },
  };
  const runner = createPortalConversionInboxOperationsTransactionRunner({
    async connect() { return client; },
  } as never);
  const context = requestDatabaseContext({
    workspaceId: IDS.workspace,
    userId: IDS.user,
    requestId: IDENTITY.requestId,
    portalSessionTokenHash: SESSION_DIGEST,
  });

  const result = await runner.run(context, async (transaction) => {
    const selected = await transaction.query<{ answer: number }>('SELECT 42 AS answer');
    return selected.rows[0]?.answer;
  });

  assert.equal(result, 42);
  assert.equal(calls[0]?.sql, 'BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE');
  assert.match(calls[1]!.sql, /app_private\.lock_active_portal_session/u);
  assert.deepEqual(calls[1]?.values, [SESSION_DIGEST, IDS.user, IDS.workspace]);
  assert.match(calls[2]!.sql, /set_config\('app\.user_id'/u);
  assert.deepEqual(calls[2]?.values, [IDS.user, IDS.workspace, 'user', IDENTITY.requestId]);
  assert.equal(calls[3]?.sql, 'SELECT 42 AS answer');
  assert.equal(calls[4]?.sql, 'COMMIT');
  assert.equal(released, true);
});

test('unassignment passes null and never accepts a browser-selected user id', async () => {
  const runner = new FakeRunner([[{
    disposition: 'replayed', conversationId: IDS.conversation,
    assignedUserId: null, rowVersion: 9,
  }]]);
  const built = service(runner);
  const result = await built.operations.assignConversation(IDENTITY, {
    commandKey: 'unassign_command_01',
    conversationId: IDS.conversation,
    expectedRowVersion: '8',
    assignment: 'unassigned',
    assignedUserId: IDS.user,
  } as never);
  assert.equal(result.ok && result.assignedUserId, null);
  assert.deepEqual(runner.calls[0]?.executor.calls[0]?.values.slice(2), [
    IDS.conversation, null, 8, 'unassign_command_01',
  ]);
});

test('browser validation rejects malformed ids, command keys, UTF-8 text, enums and timestamps before SQL', async () => {
  const runner = new FakeRunner([]);
  const built = service(runner);
  const invalidOutcomes = await Promise.all([
    built.operations.assignConversation(IDENTITY, {
      commandKey: 'short', conversationId: IDS.conversation,
      expectedRowVersion: '1', assignment: 'self',
    }),
    built.operations.assignConversation(IDENTITY, {
      commandKey: 'assign command with spaces', conversationId: 'not-a-uuid',
      expectedRowVersion: '0', assignment: 'another-user',
    } as never),
    built.operations.appendInternalNote(IDENTITY, {
      commandKey: 'note_command_000001', conversationId: IDS.conversation,
      body: '\ud800',
    }),
    built.operations.appendInternalNote(IDENTITY, {
      commandKey: 'note_command_000002', conversationId: IDS.conversation,
      body: '🦈'.repeat(Math.floor(CONVERSION_INBOX_INTERNAL_NOTE_MAX_BYTES / 4) + 1),
    }),
    built.operations.createAdminCall(IDENTITY, {
      commandKey: 'call_command_000001', conversationId: IDS.conversation,
      priority: 'normal', dueAt: '2026-08-29T16:30:00Z', note: 'not allowed\u0000',
    } as never),
    built.operations.recordCallOutcome(IDENTITY, {
      commandKey: 'outcome_command_001', conversationId: IDS.conversation,
      taskId: IDS.task, expectedTaskRowVersion: '1', outcome: 'busy',
      summary: 'Outcome summary', occurredAt: OCCURRED_AT,
    } as never),
    built.operations.recordCallOutcome(IDENTITY, {
      commandKey: 'outcome_command_002', conversationId: IDS.conversation,
      taskId: IDS.task, expectedTaskRowVersion: '1', outcome: 'connected',
      summary: 'Outcome summary', occurredAt: OCCURRED_AT,
      nextAction: {
        kind: 'reply_draft', title: 'x'.repeat(CONVERSION_INBOX_NEXT_ACTION_TITLE_MAX_BYTES + 1),
        dueAt: 'not-an-iso-timestamp', priority: 'low',
      },
    } as never),
  ]);

  assert.ok(invalidOutcomes.every((outcome) => !outcome.ok && outcome.kind === 'validation'));
  assert.equal(built.principal.tokens.length, 0, 'invalid browser input resolves no session');
  assert.equal(runner.calls.length, 0, 'invalid browser input opens no command transaction');
});

test('inactive and missing sessions fail closed before operational SQL', async () => {
  const missingPrincipal = principalResolver(null);
  const missingRunner = new FakeRunner([]);
  const missing = service(missingRunner, missingPrincipal);
  const missingResult = await missing.operations.appendInternalNote(IDENTITY, {
    commandKey: 'note_command_000001', conversationId: IDS.conversation,
    body: 'Private internal note.',
  });
  assert.deepEqual(missingResult, {
    ok: false, kind: 'unauthenticated', message: 'This portal session is no longer active.',
  });
  assert.equal(missingRunner.calls.length, 0);

  const inactiveRunner = new RejectingRunner(new InactivePortalSessionError());
  const inactive = service(inactiveRunner);
  const inactiveResult = await inactive.operations.createAdminCall(IDENTITY, {
    commandKey: 'call_command_000001', conversationId: IDS.conversation,
    priority: 'high', dueAt: DUE_AT,
  });
  assert.deepEqual(inactiveResult, {
    ok: false, kind: 'unauthenticated', message: 'This portal session is no longer active.',
  });
  assert.equal(inactiveRunner.calls, 1);
});

test('PostgreSQL failures map to stable safe outcomes without leaking database detail', async () => {
  const cases = [
    ['42501', 'forbidden'],
    ['23503', 'not_found'],
    ['P0002', 'not_found'],
    ['40001', 'version_conflict'],
    ['23505', 'idempotency_conflict'],
    ['22000', 'idempotency_conflict'],
    ['55P03', 'command_in_progress'],
    ['55000', 'command_in_progress'],
    ['22023', 'validation'],
    ['23514', 'validation'],
    ['XX999', 'unavailable'],
  ] as const;
  for (const [code, kind] of cases) {
    const runner = new RejectingRunner(Object.assign(
      new Error('PRIVATE SQL DETAIL credential=do-not-leak'),
      { code },
    ));
    const built = service(runner);
    const outcome = await built.operations.appendInternalNote(IDENTITY, {
      commandKey: 'note_command_000001', conversationId: IDS.conversation,
      body: 'Private internal note.',
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) continue;
    assert.equal(outcome.kind, kind);
    assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE|credential|SQL DETAIL/u);
  }
});

test('malformed database results fail closed and never expose raw row values', async () => {
  const runner = new FakeRunner([[{
    disposition: 'applied', conversationId: IDS.conversation,
    assignedUserId: 'PRIVATE-invalid-user', rowVersion: 2,
  }]]);
  const built = service(runner);
  const outcome = await built.operations.assignConversation(IDENTITY, {
    commandKey: 'assign_command_0001', conversationId: IDS.conversation,
    expectedRowVersion: '1', assignment: 'self',
  });
  assert.deepEqual(outcome, {
    ok: false,
    kind: 'unavailable',
    message: 'The Conversion Inbox operation could not be saved safely. No external effect was requested.',
  });
  assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE-invalid-user/u);
});
