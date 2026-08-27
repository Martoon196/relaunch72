import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolClient, QueryResult } from 'pg';
import {
  CrmReadDataError,
  CrmReadService,
  createPgCrmReadTransactionRunner,
  type CrmTransactionRunner,
  type SqlExecutor,
} from '../src/crm-pg/index.js';
import { requestDatabaseContext, type DatabaseRequestContext } from '../src/db/rls.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const PIPELINE_ID = '22222222-2222-4222-8222-222222222222';
const CONTACT_ID = '33333333-3333-4333-8333-333333333333';
const STAGE_ID = '44444444-4444-4444-8444-444444444444';
const OPPORTUNITY_ID = '55555555-5555-4555-8555-555555555555';
const TASK_ID = '66666666-6666-4666-8666-666666666666';
const ACTIVITY_ID = '77777777-7777-4777-8777-777777777777';
const USER_ID = '88888888-8888-4888-8888-888888888888';
const SNAPSHOT_AT = '2026-08-23T12:00:00.000Z';

type Row = Record<string, unknown>;

function validRows(): Record<string, Row[]> {
  return {
    'crm.read.workspace': [{
      id: WORKSPACE_ID,
      name: 'Northstar Property',
      timezone: 'Europe/London',
      currency: 'GBP',
      snapshot_at: new Date(SNAPSHOT_AT),
      default_pipeline_id: PIPELINE_ID,
      can_write: true,
    }],
    'crm.read.contacts': [{
      id: CONTACT_ID,
      display_name: 'Avery Stone',
      company_name: 'Stone Developments',
      lifecycle_status: 'lead',
      owner_user_id: USER_ID,
      row_version: '4',
      created_at: '2026-08-20T09:00:00+00:00',
      updated_at: new Date('2026-08-23T10:15:00.000Z'),
      primary_email: 'avery@example.test',
      primary_phone: '+447700900000',
      open_opportunity_count: '2',
      next_task_id: TASK_ID,
      next_task_title: 'Call Avery',
      next_task_due_at: '2026-08-24T09:00:00Z',
      last_activity_at: '2026-08-23T10:15:00Z',
    }],
    'crm.read.stages': [{
      id: STAGE_ID,
      pipeline_id: PIPELINE_ID,
      name: 'Qualified',
      position: 2,
      stage_type: 'open',
      is_terminal: false,
      row_version: '1',
    }],
    'crm.read.opportunities': [{
      id: OPPORTUNITY_ID,
      contact_id: CONTACT_ID,
      contact_name: 'Avery Stone',
      company_name: 'Stone Developments',
      pipeline_id: PIPELINE_ID,
      stage_id: STAGE_ID,
      title: 'Riverside acquisition',
      status: 'open',
      value_minor: '12500000',
      currency: 'GBP',
      probability: 60,
      owner_user_id: USER_ID,
      expected_close_date: '2026-09-30',
      updated_at: '2026-08-23T10:15:00Z',
      row_version: '5',
      next_task_id: TASK_ID,
      next_task_title: 'Call Avery',
      next_task_due_at: '2026-08-24T09:00:00Z',
    }],
    'crm.read.tasks': [{
      id: TASK_ID,
      contact_id: CONTACT_ID,
      contact_name: 'Avery Stone',
      opportunity_id: OPPORTUNITY_ID,
      opportunity_title: 'Riverside acquisition',
      title: 'Call Avery',
      description: null,
      assignee_user_id: USER_ID,
      priority: 'high',
      status: 'open',
      due_at: '2026-08-24T09:00:00Z',
      completed_at: null,
      completed_by_user_id: null,
      updated_at: '2026-08-23T10:15:00Z',
      row_version: '2',
    }],
    'crm.read.timeline': [{
      id: ACTIVITY_ID,
      contact_id: CONTACT_ID,
      opportunity_id: OPPORTUNITY_ID,
      task_id: null,
      activity_type: 'crm.contact.created',
      subject: 'Avery Stone was added as a lead',
      actor_kind: 'user',
      actor_user_id: USER_ID,
      occurred_at: '2026-08-23T10:15:00Z',
    }],
  };
}

function marker(sql: string): string {
  const match = /\/\* (crm\.read\.[a-z]+) \*\//.exec(sql);
  if (!match) throw new Error(`Missing read marker: ${sql}`);
  return match[1]!;
}

interface ReadCall {
  sql: string;
  values?: readonly unknown[];
}

class FakeReadRunner implements CrmTransactionRunner {
  readonly calls: ReadCall[] = [];
  readonly contexts: DatabaseRequestContext[] = [];
  runCount = 0;

  constructor(readonly fixtures: Record<string, Row[]>) {}

  async run<T>(context: DatabaseRequestContext, operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    this.runCount += 1;
    this.contexts.push(context);
    return operation({
      query: async <TRow extends Row = Row>(sql: string, values?: readonly unknown[]) => {
        this.calls.push({ sql, values });
        const rows = this.fixtures[marker(sql)];
        if (!rows) throw new Error(`No fixture for ${marker(sql)}`);
        return { rows: rows as TRow[], rowCount: rows.length };
      },
    });
  }
}

function context() {
  return requestDatabaseContext({
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    requestId: 'crm-read-test',
  });
}

function pageUuid(index: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, '0')}`;
}

test('CrmReadService maps one frozen workspace snapshot and preserves safe integer/timestamp truth', async () => {
  const runner = new FakeReadRunner(validRows());
  const snapshot = await new CrmReadService({ transactionRunner: runner }).loadWorkspaceSnapshot(context());

  assert.equal(runner.runCount, 1);
  assert.deepEqual(runner.contexts, [context()]);
  assert.deepEqual(snapshot.workspace, {
    id: WORKSPACE_ID,
    name: 'Northstar Property',
    timezone: 'Europe/London',
    currency: 'GBP',
    snapshotAt: SNAPSHOT_AT,
    defaultPipelineId: PIPELINE_ID,
    canWrite: true,
  });
  assert.deepEqual(snapshot.contacts[0], {
    id: CONTACT_ID,
    displayName: 'Avery Stone',
    companyName: 'Stone Developments',
    primaryEmail: 'avery@example.test',
    primaryPhone: '+447700900000',
    lifecycle: 'lead',
    ownerUserId: USER_ID,
    openOpportunityCount: 2,
    nextTask: { id: TASK_ID, title: 'Call Avery', dueAt: '2026-08-24T09:00:00.000Z' },
    lastActivityAt: '2026-08-23T10:15:00.000Z',
    createdAt: '2026-08-20T09:00:00.000Z',
    updatedAt: '2026-08-23T10:15:00.000Z',
    rowVersion: 4,
  });
  assert.equal(snapshot.stages[0]?.position, 2);
  assert.equal(snapshot.opportunities[0]?.valueMinor, 12_500_000);
  assert.equal(snapshot.opportunities[0]?.expectedCloseDate, '2026-09-30');
  assert.equal(snapshot.tasks[0]?.rowVersion, 2);
  assert.equal(snapshot.timeline[0]?.occurredAt, '2026-08-23T10:15:00.000Z');
  assert.deepEqual(snapshot.pagination, {
    contacts: {
      hasNextPage: false,
      endCursor: { updatedAt: '2026-08-23T10:15:00.000Z', id: CONTACT_ID },
    },
    opportunities: {
      hasNextPage: false,
      endCursor: { updatedAt: '2026-08-23T10:15:00.000Z', id: OPPORTUNITY_ID },
    },
    tasks: {
      hasNextPage: false,
      endCursor: {
        statusRank: 0,
        dueAt: '2026-08-24T09:00:00.000Z',
        updatedAt: '2026-08-23T10:15:00.000Z',
        id: TASK_ID,
      },
    },
  });
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.contacts));
  assert.ok(Object.isFrozen(snapshot.contacts[0]));
  assert.ok(Object.isFrozen(snapshot.contacts[0]?.nextTask));
});

test('command preflight reads only workspace permission and defaults, not the whole CRM', async () => {
  const runner = new FakeReadRunner(validRows());
  const workspace = await new CrmReadService({ transactionRunner: runner }).loadWorkspaceCommandContext(context());

  assert.equal(runner.runCount, 1);
  assert.deepEqual(runner.calls.map((call) => marker(call.sql)), ['crm.read.workspace']);
  assert.equal(workspace.defaultPipelineId, PIPELINE_ID);
  assert.equal(workspace.currency, 'GBP');
  assert.equal(workspace.canWrite, true);
});

test('default overview bounds every collection and derives workspace scope from RLS context', async () => {
  const runner = new FakeReadRunner(validRows());
  await new CrmReadService({ transactionRunner: runner }).loadWorkspaceSnapshot(context());

  assert.deepEqual(runner.calls.map((call) => marker(call.sql)), [
    'crm.read.workspace',
    'crm.read.contacts',
    'crm.read.stages',
    'crm.read.opportunities',
    'crm.read.tasks',
    'crm.read.timeline',
  ]);
  for (const call of runner.calls) {
    assert.match(call.sql, /app_private\.current_workspace_id\(\)/);
    assert.equal(call.sql.includes(WORKSPACE_ID), false, 'workspace IDs never enter component SQL');
  }
  assert.deepEqual(runner.calls.map((call) => call.values), [
    undefined,
    [null, null, 51],
    [101],
    [null, null, 51],
    ['all', null, null, null, null, 51],
    undefined,
  ]);
  assert.match(runner.calls[0]!.sql, /app_private\.can_write_workspace/);
  assert.match(runner.calls[1]!.sql, /ORDER BY point\.is_primary DESC/);
  assert.match(runner.calls[1]!.sql, /contact\.updated_at < \$1::timestamptz/);
  assert.match(runner.calls[1]!.sql, /contact\.updated_at = \$1::timestamptz AND contact\.id > \$2::uuid/);
  assert.match(runner.calls[1]!.sql, /LIMIT \$3/);
  assert.match(runner.calls[2]!.sql, /pipeline\.is_default/);
  assert.match(runner.calls[2]!.sql, /ORDER BY stage\.position, stage\.id/);
  assert.match(runner.calls[2]!.sql, /LIMIT \$1/);
  assert.match(runner.calls[3]!.sql, /pipeline\.is_default/);
  assert.match(runner.calls[3]!.sql, /opportunity\.updated_at < \$1::timestamptz/);
  assert.match(runner.calls[3]!.sql, /opportunity\.updated_at = \$1::timestamptz AND opportunity\.id > \$2::uuid/);
  assert.match(runner.calls[3]!.sql, /LIMIT \$3/);
  assert.match(runner.calls[4]!.sql, /\$1::text = 'all' OR task\.status = \$1::text/);
  assert.match(runner.calls[4]!.sql, /task\.due_at ASC NULLS LAST/);
  assert.match(runner.calls[4]!.sql, /LIMIT \$6/);
  assert.doesNotMatch(runner.calls[4]!.sql, /task\.description/);
  assert.match(runner.calls[5]!.sql, /ORDER BY activity\.occurred_at DESC, activity\.id DESC\s+LIMIT 100/);
});

test('route-specific requests fetch only the collections each CRM screen actually renders', async () => {
  const contactsRunner = new FakeReadRunner(validRows());
  const contacts = await new CrmReadService({ transactionRunner: contactsRunner }).loadWorkspaceSnapshot(
    context(),
    { section: 'contacts' },
  );
  assert.deepEqual(contactsRunner.calls.map((call) => marker(call.sql)), [
    'crm.read.workspace',
    'crm.read.contacts',
    'crm.read.stages',
    'crm.read.timeline',
  ]);
  assert.equal(contacts.opportunities.length, 0);
  assert.equal(contacts.tasks.length, 0);
  assert.equal(contacts.pagination?.opportunities, null);
  assert.equal(contacts.pagination?.tasks, null);

  const pipelineRunner = new FakeReadRunner(validRows());
  const pipeline = await new CrmReadService({ transactionRunner: pipelineRunner }).loadWorkspaceSnapshot(
    context(),
    { section: 'pipeline' },
  );
  assert.deepEqual(pipelineRunner.calls.map((call) => marker(call.sql)), [
    'crm.read.workspace',
    'crm.read.stages',
    'crm.read.opportunities',
    'crm.read.timeline',
  ]);
  assert.equal(pipeline.contacts.length, 0);
  assert.equal(pipeline.tasks.length, 0);
  assert.equal(pipeline.pagination?.contacts, null);
  assert.equal(pipeline.pagination?.tasks, null);

  const tasksRunner = new FakeReadRunner(validRows());
  const tasks = await new CrmReadService({ transactionRunner: tasksRunner }).loadWorkspaceSnapshot(
    context(),
    { section: 'tasks' },
  );
  assert.deepEqual(tasksRunner.calls.map((call) => marker(call.sql)), [
    'crm.read.workspace',
    'crm.read.tasks',
    'crm.read.timeline',
  ]);
  assert.deepEqual(tasksRunner.calls[1]?.values, ['open', null, null, null, null, 51]);
  assert.equal(tasks.contacts.length, 0);
  assert.equal(tasks.stages.length, 0);
  assert.equal(tasks.opportunities.length, 0);
  assert.equal(tasks.pagination?.contacts, null);
  assert.equal(tasks.pagination?.opportunities, null);
});

test('contact pages fetch 51, return 50 and expose the exact stable tie-break cursor', async () => {
  const fixtures = validRows();
  const source = fixtures['crm.read.contacts']![0]!;
  fixtures['crm.read.contacts'] = Array.from({ length: 51 }, (_, index) => ({
    ...source,
    id: pageUuid(index + 1),
    updated_at: '2026-08-23T10:15:00Z',
  }));
  const runner = new FakeReadRunner(fixtures);
  const snapshot = await new CrmReadService({ transactionRunner: runner }).loadWorkspaceSnapshot(
    context(),
    { section: 'contacts' },
  );

  assert.equal(snapshot.contacts.length, 50);
  assert.deepEqual(snapshot.pagination?.contacts, {
    hasNextPage: true,
    endCursor: {
      updatedAt: '2026-08-23T10:15:00.000Z',
      id: pageUuid(50),
    },
  });
  assert.deepEqual(runner.calls[1]?.values, [null, null, 51]);

  const cursorRunner = new FakeReadRunner(validRows());
  await new CrmReadService({ transactionRunner: cursorRunner }).loadWorkspaceSnapshot(context(), {
    section: 'contacts',
    after: { updatedAt: '2026-08-23T10:15:00Z', id: CONTACT_ID.toUpperCase() },
  });
  assert.deepEqual(cursorRunner.calls[1]?.values, [
    '2026-08-23T10:15:00.000Z',
    CONTACT_ID,
    51,
  ]);
});

test('contact keysets preserve PostgreSQL microseconds so rows inside one millisecond are not skipped', async () => {
  const fixtures = validRows();
  const source = fixtures['crm.read.contacts']![0]!;
  fixtures['crm.read.contacts'] = Array.from({ length: 51 }, (_, index) => ({
    ...source,
    id: pageUuid(index + 1),
    updated_at: new Date('2026-08-23T10:15:00.000Z'),
    cursor_updated_at: index < 50
      ? '2026-08-23T10:15:00.000500Z'
      : '2026-08-23T10:15:00.000400Z',
  }));
  const firstRunner = new FakeReadRunner(fixtures);
  const first = await new CrmReadService({ transactionRunner: firstRunner }).loadWorkspaceSnapshot(
    context(),
    { section: 'contacts' },
  );

  assert.deepEqual(first.pagination?.contacts, {
    hasNextPage: true,
    endCursor: {
      updatedAt: '2026-08-23T10:15:00.000500Z',
      id: pageUuid(50),
    },
  });
  assert.match(firstRunner.calls[1]!.sql, /to_char\([\s\S]*contact\.updated_at AT TIME ZONE 'UTC'[\s\S]*\) AS cursor_updated_at/);

  const secondRunner = new FakeReadRunner(validRows());
  await new CrmReadService({ transactionRunner: secondRunner }).loadWorkspaceSnapshot(context(), {
    section: 'contacts',
    after: first.pagination!.contacts!.endCursor!,
  });
  assert.deepEqual(secondRunner.calls[1]?.values, [
    '2026-08-23T10:15:00.000500Z',
    pageUuid(50),
    51,
  ]);
  assert.ok(
    '2026-08-23T10:15:00.000400Z' < '2026-08-23T10:15:00.000500Z',
    'the immediately older microsecond remains below the exact database cursor',
  );
});

test('opportunity cursor uses updated-desc then id-asc keyset values and predicates', async () => {
  const runner = new FakeReadRunner(validRows());
  await new CrmReadService({ transactionRunner: runner }).loadWorkspaceSnapshot(context(), {
    section: 'pipeline',
    after: { updatedAt: '2026-08-22T08:30:00+00:00', id: OPPORTUNITY_ID.toUpperCase() },
  });
  const call = runner.calls.find((entry) => marker(entry.sql) === 'crm.read.opportunities')!;
  assert.deepEqual(call.values, ['2026-08-22T08:30:00.000Z', OPPORTUNITY_ID, 51]);
  assert.match(call.sql, /opportunity\.updated_at < \$1::timestamptz/);
  assert.match(call.sql, /opportunity\.updated_at = \$1::timestamptz AND opportunity\.id > \$2::uuid/);
  assert.match(call.sql, /ORDER BY opportunity\.updated_at DESC, opportunity\.id\s+LIMIT \$3/);
});

test('opportunity and task pages also trim the 51st row and return raw continuation tuples', async () => {
  const opportunityFixtures = validRows();
  const opportunitySource = opportunityFixtures['crm.read.opportunities']![0]!;
  opportunityFixtures['crm.read.opportunities'] = Array.from({ length: 51 }, (_, index) => ({
    ...opportunitySource,
    id: pageUuid(index + 1),
    cursor_updated_at: '2026-08-23T10:15:00.000700Z',
  }));
  const opportunityRunner = new FakeReadRunner(opportunityFixtures);
  const opportunitySnapshot = await new CrmReadService({
    transactionRunner: opportunityRunner,
  }).loadWorkspaceSnapshot(context(), { section: 'pipeline' });
  assert.equal(opportunitySnapshot.opportunities.length, 50);
  assert.deepEqual(opportunitySnapshot.pagination?.opportunities, {
    hasNextPage: true,
    endCursor: {
      updatedAt: '2026-08-23T10:15:00.000700Z',
      id: pageUuid(50),
    },
  });
  assert.match(opportunityRunner.calls[2]!.sql, /opportunity\.updated_at AT TIME ZONE 'UTC'/);

  const taskFixtures = validRows();
  const taskSource = taskFixtures['crm.read.tasks']![0]!;
  taskFixtures['crm.read.tasks'] = Array.from({ length: 51 }, (_, index) => ({
    ...taskSource,
    id: pageUuid(index + 1),
  }));
  const taskSnapshot = await new CrmReadService({
    transactionRunner: new FakeReadRunner(taskFixtures),
  }).loadWorkspaceSnapshot(context(), { section: 'tasks', filter: 'open' });
  assert.equal(taskSnapshot.tasks.length, 50);
  assert.deepEqual(taskSnapshot.pagination?.tasks, {
    hasNextPage: true,
    endCursor: {
      statusRank: 0,
      dueAt: '2026-08-24T09:00:00.000Z',
      updatedAt: '2026-08-23T10:15:00.000Z',
      id: pageUuid(50),
    },
  });
});

test('task continuation tuples preserve exact due and updated microseconds independently', async () => {
  const fixtures = validRows();
  const source = fixtures['crm.read.tasks']![0]!;
  fixtures['crm.read.tasks'] = Array.from({ length: 51 }, (_, index) => ({
    ...source,
    id: pageUuid(index + 1),
    cursor_due_at: '2026-08-24T09:00:00.000600Z',
    cursor_updated_at: '2026-08-23T10:15:00.000500Z',
  }));
  const runner = new FakeReadRunner(fixtures);
  const snapshot = await new CrmReadService({ transactionRunner: runner }).loadWorkspaceSnapshot(
    context(),
    { section: 'tasks', filter: 'open' },
  );

  assert.deepEqual(snapshot.pagination?.tasks?.endCursor, {
    statusRank: 0,
    dueAt: '2026-08-24T09:00:00.000600Z',
    updatedAt: '2026-08-23T10:15:00.000500Z',
    id: pageUuid(50),
  });
  assert.match(runner.calls[1]!.sql, /task\.due_at AT TIME ZONE 'UTC'/);
  assert.match(runner.calls[1]!.sql, /task\.updated_at AT TIME ZONE 'UTC'/);

  const nextRunner = new FakeReadRunner(validRows());
  await new CrmReadService({ transactionRunner: nextRunner }).loadWorkspaceSnapshot(context(), {
    section: 'tasks',
    filter: 'open',
    after: snapshot.pagination!.tasks!.endCursor!,
  });
  assert.deepEqual(nextRunner.calls[1]?.values, [
    'open',
    0,
    '2026-08-24T09:00:00.000600Z',
    '2026-08-23T10:15:00.000500Z',
    pageUuid(50),
    51,
  ]);
});

test('task pages normalize filters and implement nullable due-at keysets without gaps', async () => {
  const cases = [
    {
      filter: 'open' as const,
      after: {
        statusRank: 0 as const,
        dueAt: '2026-08-24T09:00:00Z',
        updatedAt: '2026-08-23T10:15:00Z',
        id: TASK_ID.toUpperCase(),
      },
      values: ['open', 0, '2026-08-24T09:00:00.000Z', '2026-08-23T10:15:00.000Z', TASK_ID, 51],
    },
    {
      filter: 'completed' as const,
      after: {
        statusRank: 1 as const,
        dueAt: null,
        updatedAt: '2026-08-22T10:15:00Z',
        id: TASK_ID,
      },
      values: ['completed', 1, null, '2026-08-22T10:15:00.000Z', TASK_ID, 51],
    },
    {
      filter: 'all' as const,
      after: {
        statusRank: 2 as const,
        dueAt: null,
        updatedAt: '2026-08-21T10:15:00Z',
        id: TASK_ID,
      },
      values: ['all', 2, null, '2026-08-21T10:15:00.000Z', TASK_ID, 51],
    },
  ];
  for (const item of cases) {
    const runner = new FakeReadRunner(validRows());
    await new CrmReadService({ transactionRunner: runner }).loadWorkspaceSnapshot(context(), {
      section: 'tasks',
      filter: item.filter,
      after: item.after,
    });
    const call = runner.calls.find((entry) => marker(entry.sql) === 'crm.read.tasks')!;
    assert.deepEqual(call.values, item.values);
    assert.match(call.sql, /task\.due_at IS NULL\s+OR task\.due_at > \$3::timestamptz/);
    assert.match(call.sql, /task\.due_at = \$3::timestamptz[\s\S]*task\.updated_at < \$4::timestamptz/);
    assert.match(call.sql, /\$3::timestamptz IS NULL\s+AND task\.due_at IS NULL/);
    assert.match(call.sql, /task\.updated_at = \$4::timestamptz AND task\.id > \$5::uuid/);
    assert.match(call.sql, /ORDER BY CASE task\.status[\s\S]*task\.due_at ASC NULLS LAST,[\s\S]*task\.updated_at DESC,[\s\S]*task\.id\s+LIMIT \$6/);
  }
});

test('task filter and cursor mismatches fail before a database transaction opens', async () => {
  const invalidFilterRunner = new FakeReadRunner(validRows());
  await assert.rejects(
    new CrmReadService({ transactionRunner: invalidFilterRunner }).loadWorkspaceSnapshot(context(), {
      section: 'tasks',
      filter: 'cancelled' as never,
    }),
    (error: unknown) => error instanceof CrmReadDataError && /filter is invalid/.test(error.message),
  );
  assert.equal(invalidFilterRunner.runCount, 0);

  const mismatchedCursorRunner = new FakeReadRunner(validRows());
  await assert.rejects(
    new CrmReadService({ transactionRunner: mismatchedCursorRunner }).loadWorkspaceSnapshot(context(), {
      section: 'tasks',
      filter: 'open',
      after: {
        statusRank: 1,
        dueAt: null,
        updatedAt: '2026-08-23T10:15:00Z',
        id: TASK_ID,
      },
    }),
    (error: unknown) => error instanceof CrmReadDataError && /does not belong/.test(error.message),
  );
  assert.equal(mismatchedCursorRunner.runCount, 0);
});

test('default pipeline stages hard-stop at 100 and fail closed on the 101st row', async () => {
  const allowedFixtures = validRows();
  allowedFixtures['crm.read.stages'] = Array.from({ length: 100 }, () => ({ ...allowedFixtures['crm.read.stages']![0]! }));
  const allowed = await new CrmReadService({
    transactionRunner: new FakeReadRunner(allowedFixtures),
  }).loadWorkspaceSnapshot(context(), { section: 'pipeline' });
  assert.equal(allowed.stages.length, 100);

  const fixtures = validRows();
  fixtures['crm.read.stages'] = Array.from({ length: 101 }, () => ({ ...fixtures['crm.read.stages']![0]! }));
  const runner = new FakeReadRunner(fixtures);
  await assert.rejects(
    new CrmReadService({ transactionRunner: runner }).loadWorkspaceSnapshot(context(), { section: 'pipeline' }),
    (error: unknown) => error instanceof CrmReadDataError && /hard limit of 100 stages/.test(error.message),
  );
  assert.deepEqual(runner.calls.map((call) => marker(call.sql)), ['crm.read.workspace', 'crm.read.stages']);
  assert.deepEqual(runner.calls[1]?.values, [101]);
});

test('dependent CRM reads suppress soft-deleted contact relationships consistently', async () => {
  const runner = new FakeReadRunner(validRows());
  await new CrmReadService({ transactionRunner: runner }).loadWorkspaceSnapshot(context());
  const opportunities = runner.calls.find((call) => marker(call.sql) === 'crm.read.opportunities')!.sql;
  const tasks = runner.calls.find((call) => marker(call.sql) === 'crm.read.tasks')!.sql;

  assert.match(opportunities, /contact\.deleted_at IS NULL/);
  assert.match(tasks, /contact\.deleted_at IS NULL/);
  assert.match(tasks, /task\.contact_id IS NULL OR contact\.id IS NOT NULL/);
});

test('viewer write capability is mapped from the database rather than inferred in the UI', async () => {
  const fixtures = validRows();
  fixtures['crm.read.workspace']![0]!.can_write = false;
  const snapshot = await new CrmReadService({
    transactionRunner: new FakeReadRunner(fixtures),
  }).loadWorkspaceSnapshot(context());
  assert.equal(snapshot.workspace.canWrite, false);

  fixtures['crm.read.workspace']![0]!.can_write = 'false';
  await assert.rejects(
    new CrmReadService({ transactionRunner: new FakeReadRunner(fixtures) }).loadWorkspaceSnapshot(context()),
    (error: unknown) => error instanceof CrmReadDataError && /canWrite must be a boolean/.test(error.message),
  );
});

test('malformed database rows fail closed instead of losing bigint or timestamp precision', async (t) => {
  await t.test('unsafe bigint', async () => {
    const fixtures = validRows();
    fixtures['crm.read.contacts']![0]!.open_opportunity_count = '9007199254740992';
    await assert.rejects(
      new CrmReadService({ transactionRunner: new FakeReadRunner(fixtures) }).loadWorkspaceSnapshot(context()),
      (error: unknown) => error instanceof CrmReadDataError && /outside its safe range/.test(error.message),
    );
  });

  await t.test('invalid snapshot timestamp', async () => {
    const fixtures = validRows();
    fixtures['crm.read.workspace']![0]!.snapshot_at = 'not-a-date';
    await assert.rejects(
      new CrmReadService({ transactionRunner: new FakeReadRunner(fixtures) }).loadWorkspaceSnapshot(context()),
      (error: unknown) => error instanceof CrmReadDataError && /valid timestamp/.test(error.message),
    );
  });

  await t.test('invalid workspace timezone', async () => {
    const fixtures = validRows();
    fixtures['crm.read.workspace']![0]!.timezone = 'Mars/Olympus_Mons';
    await assert.rejects(
      new CrmReadService({ transactionRunner: new FakeReadRunner(fixtures) }).loadWorkspaceSnapshot(context()),
      (error: unknown) => error instanceof CrmReadDataError && /valid IANA timezone/.test(error.message),
    );
  });

  await t.test('impossible calendar date', async () => {
    const fixtures = validRows();
    fixtures['crm.read.opportunities']![0]!.expected_close_date = '2026-02-30';
    await assert.rejects(
      new CrmReadService({ transactionRunner: new FakeReadRunner(fixtures) }).loadWorkspaceSnapshot(context()),
      (error: unknown) => error instanceof CrmReadDataError && /real calendar date/.test(error.message),
    );
  });

  await t.test('mixed default pipelines', async () => {
    const fixtures = validRows();
    fixtures['crm.read.stages']![0]!.pipeline_id = '99999999-9999-4999-8999-999999999999';
    await assert.rejects(
      new CrmReadService({ transactionRunner: new FakeReadRunner(fixtures) }).loadWorkspaceSnapshot(context()),
      (error: unknown) => error instanceof CrmReadDataError && /internally inconsistent/.test(error.message),
    );
  });
});

test('workspace lookup must resolve exactly one RLS-visible workspace', async () => {
  for (const workspaceRows of [[], [validRows()['crm.read.workspace']![0]!, validRows()['crm.read.workspace']![0]!]]) {
    const fixtures = validRows();
    fixtures['crm.read.workspace'] = workspaceRows;
    const runner = new FakeReadRunner(fixtures);
    await assert.rejects(
      new CrmReadService({ transactionRunner: runner }).loadWorkspaceSnapshot(context()),
      (error: unknown) => error instanceof CrmReadDataError && /exactly one/.test(error.message),
    );
    assert.deepEqual(runner.calls.map((call) => marker(call.sql)), ['crm.read.workspace']);
  }
});

class FakePgClient {
  readonly calls: Array<{ sql: string; values?: unknown[] }> = [];
  releasedWith: boolean | undefined;

  async query(sql: string, values?: unknown[]): Promise<QueryResult<Row>> {
    this.calls.push({ sql, values });
    return {
      rows: sql === 'SELECT 42 AS answer' ? [{ answer: 42 }] : [],
      rowCount: sql === 'SELECT 42 AS answer' ? 1 : 0,
      command: '',
      oid: 0,
      fields: [],
    };
  }

  release(destroy?: boolean): void {
    this.releasedWith = destroy;
  }
}

test('PostgreSQL read runner owns one repeatable-read, read-only RLS transaction', async () => {
  const client = new FakePgClient();
  const pool = {
    connect: async () => client as unknown as PoolClient,
  } as Pick<Pool, 'connect'>;
  const runner = createPgCrmReadTransactionRunner(pool);

  const result = await runner.run(context(), async (transaction) => transaction.query('SELECT 42 AS answer'));

  assert.deepEqual(result.rows, [{ answer: 42 }]);
  assert.equal(client.calls[0]?.sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.match(client.calls[1]?.sql ?? '', /set_config\('app\.workspace_id', \$2, true\)/);
  assert.deepEqual(client.calls[1]?.values, [USER_ID, WORKSPACE_ID, 'user', 'crm-read-test']);
  assert.equal(client.calls[2]?.sql, 'SELECT 42 AS answer');
  assert.equal(client.calls[3]?.sql, 'COMMIT');
  assert.equal(client.releasedWith, false);
});
