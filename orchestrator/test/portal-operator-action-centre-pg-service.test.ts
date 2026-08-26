import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import type { DatabaseRequestContext } from '../src/db/rls.js';
import {
  OPERATOR_ACTION_DATABASE_MAX_LIMIT,
  OPERATOR_ACTION_DATABASE_DEFAULT_LIMIT,
  PgOperatorActionCentreCommandService,
  PgOperatorActionCentreReadServiceImpl,
  PgPortalOperatorActionCentreService,
  type PgOperatorActionSnapshot,
} from '../src/portal/operator-action-centre-pg-service.js';

const WORKSPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SOURCE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SESSION = 'opaque-operator-session';
const context: DatabaseRequestContext = Object.freeze({
  actorKind: 'user',
  workspaceId: WORKSPACE_ID,
  userId: USER_ID,
  requestId: 'operator-actions-read-1',
  portalSessionTokenHash: createHash('sha256').update(SESSION).digest(),
});

function result<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return {
    command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows,
  };
}

function rawAction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actionId: `crm.task:${SOURCE_ID}`,
    actionKind: 'crm.task',
    sourceReference: `app.tasks:${SOURCE_ID}`,
    source: 'crm',
    priority: 'p1',
    status: 'open',
    title: 'Call the sales-ready lead',
    detail: 'Review the exact open CRM task.',
    sourceOwnerUserId: USER_ID,
    sourceOwnerLabel: 'Martin O’Connell',
    ownerTeam: 'CRM operations',
    relatedPersonLabel: 'Avery Stone',
    signalLabel: 'Open CRM task · overdue',
    createdAt: '2026-08-25T08:00:00.000Z',
    dueAt: '2026-08-26T08:00:00.000Z',
    blockedBy: null,
    destinationId: SOURCE_ID,
    destinationChannel: null,
    destinationQuery: 'Avery Stone',
    evidenceLabel: 'CRM task ledger',
    evidenceDetail: 'Open status and due time are database-derived.',
    evidenceRef: `postgres:app.tasks:${SOURCE_ID}:v3`,
    observedAt: '2026-08-26T08:30:00.000Z',
    sourceRowVersion: '3',
    ...overrides,
  };
}

class ReadClient {
  readonly calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  released = false;
  sourceRows: Readonly<Record<string, readonly Record<string, unknown>[]>> = Object.freeze({});
  controls: readonly Record<string, unknown>[] = [];
  workspaceRow: Record<string, unknown> = {
    workspaceId: WORKSPACE_ID,
    workspaceName: 'Property Predator Growth HQ',
    snapshotAt: '2026-08-26T12:00:00.000Z',
    role: 'owner',
    canWrite: true,
    canAssign: true,
  };
  memberRows: readonly Record<string, unknown>[] = [
    { userId: USER_ID, displayName: 'Martin O’Connell', role: 'owner' },
    { userId: OTHER_USER_ID, displayName: 'Growth Operator', role: 'sales' },
  ];

  async query<T extends QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<QueryResult<T>> {
    this.calls.push({ sql, values });
    if (sql.includes('database.lock-portal-session')) return result([{ active: true }] as unknown as T[]);
    if (sql.includes('operator-actions.workspace')) {
      return result([this.workspaceRow] as unknown as T[]);
    }
    if (sql.includes('operator-actions.assignable-members')) {
      return result([...this.memberRows] as unknown as T[]);
    }
    if (sql.includes('operator-actions.authoritative')) {
      return result(Object.values(this.sourceRows).flat() as unknown as T[]);
    }
    for (const source of ['crm', 'journey', 'content', 'inbox', 'test-operations', 'readiness']) {
      if (sql.includes(`operator-actions.${source}`)) {
        return result([...(this.sourceRows[source] ?? [])] as unknown as T[]);
      }
    }
    if (sql.includes('operator-actions.controls')) return result([...this.controls] as unknown as T[]);
    return result([] as T[]);
  }

  release(): void { this.released = true; }
}

function allSourceRows(): Readonly<Record<string, readonly Record<string, unknown>[]>> {
  return Object.freeze({
    crm: [rawAction()],
    journey: [rawAction({
      actionId: `journey.attention:${SOURCE_ID}`,
      actionKind: 'journey.attention',
      sourceReference: `app.conversion_enrollments:${SOURCE_ID}`,
      source: 'journey',
      priority: 'p0',
      status: 'blocked',
      title: 'Choose the next move for Avery Stone',
      blockedBy: 'No open CRM task is linked.',
      destinationChannel: null,
      evidenceRef: `postgres:app.conversion_enrollments:${SOURCE_ID}:v4`,
      sourceRowVersion: 4,
    })],
    content: [rawAction({
      actionId: `content.review:${SOURCE_ID}`,
      actionKind: 'content.approval',
      sourceReference: `app.company_content_approval_requests:${SOURCE_ID}`,
      source: 'content',
      priority: 'p2',
      status: 'waiting',
      title: 'Review the comparables article',
      relatedPersonLabel: null,
      destinationChannel: 'article',
      destinationQuery: 'Why comparables need context',
      evidenceRef: `postgres:app.company_content_approval_requests:${SOURCE_ID}:sha256:${'a'.repeat(64)}`,
      sourceRowVersion: 1,
    })],
    inbox: [rawAction({
      actionId: `inbox.message:${SOURCE_ID}`,
      actionKind: 'inbox.approval',
      sourceReference: `app.messages:${SOURCE_ID}`,
      source: 'inbox',
      status: 'waiting',
      destinationChannel: 'email',
      destinationId: SOURCE_ID,
      evidenceRef: `postgres:app.messages:${SOURCE_ID}:v1:sha256:${'b'.repeat(64)}`,
      sourceRowVersion: 2,
    })],
    'test-operations': [rawAction({
      actionId: `provider.test_operation:${SOURCE_ID}`,
      actionKind: 'provider.test_operation',
      sourceReference: `app.provider_operations:${SOURCE_ID}`,
      source: 'provider',
      status: 'blocked',
      sourceOwnerUserId: null,
      sourceOwnerLabel: null,
      destinationChannel: 'email',
      destinationId: SOURCE_ID,
      evidenceRef: `postgres:app.provider_operations:${SOURCE_ID}:v2`,
      sourceRowVersion: 2,
    })],
    readiness: [rawAction({
      actionId: `provider.readiness:${SOURCE_ID}`,
      actionKind: 'provider.readiness',
      sourceReference: `app.provider_connections:${SOURCE_ID}`,
      source: 'provider',
      status: 'blocked',
      sourceOwnerUserId: null,
      sourceOwnerLabel: null,
      destinationChannel: null,
      destinationId: SOURCE_ID,
      evidenceRef: `postgres:app.provider_connections:${SOURCE_ID}:v1`,
      sourceRowVersion: 1,
    })],
  });
}

test('authoritative queue is bounded, repeatable-read, RLS-scoped and self-describing', async () => {
  const client = new ReadClient();
  client.sourceRows = allSourceRows();
  client.controls = [{
    actionId: `content.review:${SOURCE_ID}`,
    sourceKind: 'content',
    sourceReference: `app.company_content_approval_requests:${SOURCE_ID}`,
    assignmentOverridden: true,
    assignedUserId: null,
    assignedUserLabel: null,
    snoozedUntil: null,
    rowVersion: '2',
  }];
  const service = new PgOperatorActionCentreReadServiceImpl({
    connect: async () => client,
  } as unknown as Pick<Pool, 'connect'>, 'production');

  const snapshot = await service.load(context);

  assert.equal(client.calls[0]?.sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.match(client.calls[1]?.sql ?? '', /active_portal_session/);
  assert.match(client.calls[2]?.sql ?? '', /set_config\('app\.workspace_id'/);
  assert.equal(client.calls.at(-1)?.sql, 'COMMIT');
  assert.equal(client.released, true);
  assert.equal(snapshot.datasetKind, 'postgres_authoritative');
  assert.equal(snapshot.environment, 'production');
  assert.equal(snapshot.currentUserId, USER_ID);
  assert.equal(snapshot.workspaceId, WORKSPACE_ID);
  assert.equal(snapshot.workspaceName, 'Property Predator Growth HQ');
  assert.equal(snapshot.asOf, '2026-08-26T12:00:00.000Z');
  assert.equal(snapshot.canWrite, true);
  assert.equal(snapshot.canManage, true);
  assert.equal(snapshot.commandBoundaryAvailable, true);
  assert.deepEqual(snapshot.assignableMembers.map((member) => member.userId), [USER_ID, OTHER_USER_ID]);
  assert.equal(snapshot.actions.length, 6);
  assert.ok(snapshot.actions.every((action) => action.evidence.truth === 'measured'));
  assert.ok(snapshot.actions.every((action) => action.evidence.evidenceRef.startsWith('postgres:')));
  assert.equal(snapshot.actions.find((action) => action.source === 'content')?.assignmentOverridden, true);
  assert.equal(snapshot.actions.find((action) => action.source === 'content')?.ownerLabel, null);
  assert.ok(snapshot.actions.every((action) => [
    '/portal/actions', '/portal/crm/tasks', '/portal/journeys/board', '/portal/inbox', '/portal/content',
  ].some((route) => action.deepLink.startsWith(route))));
  assert.ok(snapshot.actions.every((action) => !/\/portal\/(connections|automations|webinars)/.test(action.deepLink)));

  const sourceCalls = client.calls.filter((call) => call.sql.includes('portal.operator-actions.')
    && !call.sql.includes('operator-actions.workspace */')
    && !call.sql.includes('operator-actions.controls */')
    && !call.sql.includes('operator-actions.assignable-members */'));
  assert.equal(sourceCalls.length, 1);
  assert.deepEqual(sourceCalls[0]?.values, [61, false, null]);
  const joinedSql = sourceCalls.map((call) => call.sql).join('\n');
  for (const table of [
    'app.tasks', 'app.conversion_enrollments', 'app.company_content_approval_requests',
    'app.messages', 'app.provider_operations', 'app.provider_connections',
  ]) assert.match(joinedSql, new RegExp(table.replace('.', '\\.')));
  assert.match(joinedSql, /app_private\.current_workspace_id\(\)/);
  assert.match(joinedSql, /NOT EXISTS[\s\S]*snoozed_until > transaction_timestamp\(\)/);
  assert.match(joinedSql, /candidate\.priority = 'p0' AND candidate\.status = 'blocked'/);
  assert.doesNotMatch(joinedSql, /fictional|test-ledger|Laila|Aisha|fixture/i);
});

test('snooze-only overlay preserves the source owner and normal queue hides active snoozes', async () => {
  const future = '2026-08-27T12:00:00.000Z';
  const control = {
    actionId: `crm.task:${SOURCE_ID}`,
    sourceKind: 'crm',
    sourceReference: `app.tasks:${SOURCE_ID}`,
    assignmentOverridden: false,
    assignedUserId: null,
    assignedUserLabel: null,
    snoozedUntil: future,
    rowVersion: '1',
  };
  const normalClient = new ReadClient();
  normalClient.sourceRows = { crm: [rawAction()] };
  normalClient.controls = [control];
  const normalService = new PgOperatorActionCentreReadServiceImpl({
    connect: async () => normalClient,
  } as unknown as Pick<Pool, 'connect'>, 'test');
  assert.equal((await normalService.load(context)).actions.length, 0);

  const replayClient = new ReadClient();
  replayClient.sourceRows = { crm: [rawAction()] };
  replayClient.controls = [control];
  const replayService = new PgOperatorActionCentreReadServiceImpl({
    connect: async () => replayClient,
  } as unknown as Pick<Pool, 'connect'>, 'test');
  const action = (await replayService.load(context, { includeSnoozed: true })).actions[0];
  assert.equal(action?.ownerLabel, 'Martin O’Connell');
  assert.equal(action?.assignedUserId, USER_ID);
  assert.equal(action?.assignmentOverridden, false);
  assert.equal(action?.snoozedUntil, future);
});

test('writer snapshot exposes only self-service assignment while managers receive the member directory', async () => {
  const client = new ReadClient();
  client.workspaceRow = { ...client.workspaceRow, role: 'sales', canAssign: false };
  client.memberRows = [{ userId: USER_ID, displayName: 'Martin O’Connell', role: 'sales' }];
  client.sourceRows = { crm: [rawAction()] };
  const service = new PgOperatorActionCentreReadServiceImpl({
    connect: async () => client,
  } as unknown as Pick<Pool, 'connect'>, 'production');

  const snapshot = await service.load(context);

  assert.equal(snapshot.canWrite, true);
  assert.equal(snapshot.canManage, false);
  assert.equal(snapshot.canAssign, false);
  assert.equal(snapshot.commandBoundaryAvailable, true);
  assert.deepEqual(snapshot.assignableMembers.map((member) => member.userId), [USER_ID]);
  assert.equal(snapshot.actions[0]?.canAssign, true, 'writer may claim or release their own overlay');
  const memberCall = client.calls.find((call) => call.sql.includes('assignable-members'));
  assert.deepEqual(memberCall?.values, [OPERATOR_ACTION_DATABASE_MAX_LIMIT + 1]);
  assert.match(memberCall?.sql ?? '', /list_operator_action_assignable_members\(\$1\)/);
  assert.doesNotMatch(memberCall?.sql ?? '', /app\.users|workspace_memberships/);
});

test('a writer sees assignment truth without receiving a hidden teammate identity label', async () => {
  const client = new ReadClient();
  client.workspaceRow = { ...client.workspaceRow, role: 'sales', canAssign: false };
  client.memberRows = [{ userId: USER_ID, displayName: 'Martin O’Connell', role: 'sales' }];
  client.sourceRows = { crm: [rawAction({
    sourceOwnerUserId: OTHER_USER_ID,
    sourceOwnerLabel: 'Private teammate name that must not cross the directory boundary',
  })] };
  const service = new PgOperatorActionCentreReadServiceImpl({
    connect: async () => client,
  } as unknown as Pick<Pool, 'connect'>, 'production');

  const action = (await service.load(context)).actions[0];

  assert.equal(action?.assignedUserId, OTHER_USER_ID);
  assert.equal(action?.ownerLabel, 'Assigned workspace member');
  assert.equal(action?.canAssign, false);
});

test('max+1 reads disclose truncation while the returned queue remains bounded', async () => {
  const client = new ReadClient();
  client.sourceRows = {
    crm: [0, 1, 2].map((index) => rawAction({
      actionId: `crm.task:${index}ddddddd-dddd-4ddd-8ddd-dddddddddddd`.slice(0, 45),
      sourceReference: `app.tasks:${index}ddddddd-dddd-4ddd-8ddd-dddddddddddd`.slice(0, 46),
    })),
  };
  // Use valid, distinct UUID-backed keys.
  client.sourceRows = {
    crm: [
      rawAction({ actionId: 'crm.task:10000000-0000-4000-8000-000000000001', sourceReference: 'app.tasks:10000000-0000-4000-8000-000000000001' }),
      rawAction({ actionId: 'crm.task:10000000-0000-4000-8000-000000000002', sourceReference: 'app.tasks:10000000-0000-4000-8000-000000000002' }),
      rawAction({ actionId: 'crm.task:10000000-0000-4000-8000-000000000003', sourceReference: 'app.tasks:10000000-0000-4000-8000-000000000003' }),
    ],
  };
  const service = new PgOperatorActionCentreReadServiceImpl({
    connect: async () => client,
  } as unknown as Pick<Pool, 'connect'>, 'test');

  const snapshot = await service.load(context, { limit: 2 });

  assert.equal(snapshot.actions.length, 2);
  assert.equal(snapshot.inputTruncated, true);
  const crmCall = client.calls.find((call) => call.sql.includes('operator-actions.crm'));
  assert.deepEqual(crmCall?.values, [3, false, null]);
  await assert.rejects(service.load(context, { limit: OPERATOR_ACTION_DATABASE_MAX_LIMIT + 1 }), /limit/);
});

test('a no-deadline blocked P0 survives the global bound ahead of dated lower-priority work', async () => {
  const client = new ReadClient();
  const dated = Array.from({ length: OPERATOR_ACTION_DATABASE_DEFAULT_LIMIT }, (_, index) => {
    const id = `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    return rawAction({
      actionId: `crm.task:${id}`,
      sourceReference: `app.tasks:${id}`,
      destinationId: id,
      dueAt: `2026-09-${String((index % 28) + 1).padStart(2, '0')}T12:00:00.000Z`,
      evidenceRef: `postgres:app.tasks:${id}:v1`,
      sourceRowVersion: 1,
    });
  });
  const blockedId = '20000000-0000-4000-8000-000000000099';
  client.sourceRows = {
    crm: dated,
    readiness: [rawAction({
      actionId: `provider.readiness:${blockedId}`,
      actionKind: 'provider.readiness',
      sourceReference: `app.provider_connections:${blockedId}`,
      source: 'provider',
      priority: 'p0',
      status: 'blocked',
      dueAt: null,
      destinationId: blockedId,
      evidenceRef: `postgres:app.provider_connections:${blockedId}:v1`,
      sourceRowVersion: 1,
    })],
  };
  const service = new PgOperatorActionCentreReadServiceImpl({
    connect: async () => client,
  } as unknown as Pick<Pool, 'connect'>, 'production');

  const snapshot = await service.load(context);

  assert.equal(snapshot.actions.length, OPERATOR_ACTION_DATABASE_DEFAULT_LIMIT);
  assert.equal(snapshot.inputTruncated, true);
  assert.equal(snapshot.actions[0]?.actionId, `provider.readiness:${blockedId}`);
});

test('state transitions keep content and inbox action identities stable', async () => {
  async function idsFor(contentKind: 'content.approval' | 'content.changes_requested', inboxKind: 'inbox.approval' | 'inbox.draft') {
    const client = new ReadClient();
    const inboxId = '30000000-0000-4000-8000-000000000001';
    client.sourceRows = {
      content: [rawAction({
        actionId: `content.review:${SOURCE_ID}`,
        actionKind: contentKind,
        sourceReference: `app.company_content_approval_requests:${SOURCE_ID}`,
        source: 'content',
      })],
      inbox: [rawAction({
        actionId: `inbox.message:${inboxId}`,
        actionKind: inboxKind,
        sourceReference: `app.messages:${inboxId}`,
        source: 'inbox',
        destinationId: inboxId,
        evidenceRef: `postgres:app.messages:${inboxId}:v1`,
      })],
    };
    const service = new PgOperatorActionCentreReadServiceImpl({
      connect: async () => client,
    } as unknown as Pick<Pool, 'connect'>, 'production');
    return (await service.load(context)).actions.map((action) => action.actionId).sort();
  }

  const before = await idsFor('content.approval', 'inbox.approval');
  const after = await idsFor('content.changes_requested', 'inbox.draft');
  assert.deepEqual(after, before);
  assert.deepEqual(before, [
    `content.review:${SOURCE_ID}`,
    'inbox.message:30000000-0000-4000-8000-000000000001',
  ]);
});

class CommandClient {
  readonly calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  released = false;
  nextRow: Record<string, unknown> = {
    actionId: `crm.task:${SOURCE_ID}`,
    sourceKind: 'crm',
    sourceReference: `app.tasks:${SOURCE_ID}`,
    assignmentOverridden: false,
    assignedUserId: null,
    snoozedUntil: '2026-08-27T12:00:00.000Z',
    rowVersion: '1',
    changed: true,
    replayed: false,
  };

  async query<T extends QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<QueryResult<T>> {
    this.calls.push({ sql, values });
    if (sql.includes('set_operator_action_')) return result([this.nextRow] as unknown as T[]);
    return result([] as T[]);
  }
  release(): void { this.released = true; }
}

const commandContext: DatabaseRequestContext = Object.freeze({
  actorKind: 'user', workspaceId: WORKSPACE_ID, userId: USER_ID, requestId: 'operator-command-1',
});

test('command boundary calls only the two six-argument 0028 functions with version zero for a new overlay', async () => {
  const snoozeClient = new CommandClient();
  const service = new PgOperatorActionCentreCommandService({
    connect: async () => snoozeClient,
  } as unknown as Pick<Pool, 'connect'>);
  const snoozed = await service.snooze(commandContext, {
    actionId: `crm.task:${SOURCE_ID}`,
    sourceKind: 'crm',
    sourceReference: `app.tasks:${SOURCE_ID}`,
    snoozedUntil: '2026-08-27T12:00:00.000Z',
    idempotencyKey: 'operator.snooze.0001',
    expectedRowVersion: null,
  });
  const snoozeCall = snoozeClient.calls.find((call) => call.sql.includes('set_operator_action_snooze'));
  assert.match(snoozeCall?.sql ?? '', /set_operator_action_snooze\(\$1, \$2, \$3, \$4, \$5, \$6\)/);
  assert.deepEqual(snoozeCall?.values, [
    `crm.task:${SOURCE_ID}`, 'crm', `app.tasks:${SOURCE_ID}`,
    '2026-08-27T12:00:00.000Z', 0, 'operator.snooze.0001',
  ]);
  assert.equal(snoozeCall?.values?.some(Buffer.isBuffer), false, 'the database owns the payload hash');
  assert.equal(snoozed.disposition, 'applied');
  assert.equal(snoozed.changed, true);

  const assignClient = new CommandClient();
  assignClient.nextRow = {
    ...assignClient.nextRow,
    assignmentOverridden: true,
    assignedUserId: OTHER_USER_ID,
    snoozedUntil: null,
    rowVersion: '6',
    replayed: true,
    changed: false,
  };
  const assignService = new PgOperatorActionCentreCommandService({
    connect: async () => assignClient,
  } as unknown as Pick<Pool, 'connect'>);
  const assigned = await assignService.assign(commandContext, {
    actionId: `crm.task:${SOURCE_ID}`,
    sourceKind: 'crm',
    sourceReference: `app.tasks:${SOURCE_ID}`,
    assignedUserId: OTHER_USER_ID,
    idempotencyKey: 'operator.assign.0001',
    expectedRowVersion: 5,
  });
  const assignCall = assignClient.calls.find((call) => call.sql.includes('set_operator_action_assignment'));
  assert.deepEqual(assignCall?.values, [
    `crm.task:${SOURCE_ID}`, 'crm', `app.tasks:${SOURCE_ID}`,
    OTHER_USER_ID, 5, 'operator.assign.0001',
  ]);
  assert.equal(assigned.disposition, 'replayed');
  assert.equal(assigned.assignmentOverridden, true);
  const allCommandSql = [...snoozeClient.calls, ...assignClient.calls].map((call) => call.sql).join('\n');
  assert.doesNotMatch(allCommandSql, /UPDATE\s+app\.(tasks|messages|provider_operations)|complete|dispatch|send/i);
});

function pgAction(overrides: Partial<PgOperatorActionSnapshot> = {}): PgOperatorActionSnapshot {
  return Object.freeze({
    actionId: `crm.task:${SOURCE_ID}`,
    actionKind: 'crm.task',
    sourceReference: `app.tasks:${SOURCE_ID}`,
    source: 'crm',
    priority: 'p1',
    status: 'open',
    title: 'Call Avery',
    detail: 'Open CRM task.',
    ownerLabel: 'Martin',
    ownerTeam: 'CRM operations',
    assignedUserId: USER_ID,
    assignmentOverridden: false,
    relatedPersonLabel: 'Avery',
    signalLabel: 'Overdue',
    createdAt: '2026-08-25T08:00:00.000Z',
    dueAt: '2026-08-26T08:00:00.000Z',
    blockedBy: null,
    deepLink: '/portal/crm/tasks?status=open',
    deepLinkLabel: 'Open tasks',
    evidence: {
      label: 'CRM task', detail: 'Database row.', truth: 'measured' as const,
      evidenceRef: `postgres:app.tasks:${SOURCE_ID}:v3`, observedAt: '2026-08-26T08:00:00.000Z',
    },
    rowVersion: null,
    sourceRowVersion: 3,
    snoozedUntil: null,
    canSnooze: true,
    canAssign: true,
    ...overrides,
  });
}

test('portal commands resolve source identity server-side and reject forged or stale queue keys', async () => {
  const calls: unknown[] = [];
  const action = pgAction();
  const service = new PgPortalOperatorActionCentreService({
    principalResolver: { resolve: async () => ({ workspaceId: WORKSPACE_ID, userId: USER_ID }) },
    readService: {
      load: async () => ({
        workspaceId: WORKSPACE_ID,
        workspaceName: 'Property Predator Growth HQ',
        asOf: '2026-08-26T12:00:00.000Z',
        environment: 'production' as const,
        datasetKind: 'postgres_authoritative' as const,
        currentUserId: USER_ID,
        canWrite: true,
        canManage: true,
        canAssign: true,
        commandBoundaryAvailable: true,
        assignableMembers: [],
        membersTruncated: false,
        inputTruncated: false,
        actions: [action],
      }),
    },
    commandService: {
      snooze: async (_context, input) => {
        calls.push(input);
        return {
          actionId: action.actionId,
          sourceKind: 'crm' as const,
          sourceReference: action.sourceReference,
          assignmentOverridden: false,
          assignedUserId: USER_ID,
          snoozedUntil: '2026-08-27T12:00:00.000Z',
          rowVersion: 1,
          changed: true,
          disposition: 'applied' as const,
        };
      },
      assign: async () => assert.fail('snooze must not call assignment'),
    },
  });

  const outcome = await service.snoozeAction({ sessionToken: SESSION, requestId: 'portal-action-1' }, {
    actionId: action.actionId,
    commandKey: 'operator.snooze.0002',
    expectedRowVersion: null,
    snoozedUntil: '2026-08-27T12:00:00.000Z',
  });
  assert.deepEqual(outcome, { ok: true, disposition: 'applied', changed: true, rowVersion: 1 });
  assert.deepEqual(calls, [{
    actionId: action.actionId,
    sourceKind: 'crm',
    sourceReference: action.sourceReference,
    snoozedUntil: '2026-08-27T12:00:00.000Z',
    idempotencyKey: 'operator.snooze.0002',
    expectedRowVersion: null,
  }]);

  assert.equal((await service.snoozeAction({ sessionToken: SESSION, requestId: 'portal-action-2' }, {
    actionId: 'crm.task:10000000-0000-4000-8000-000000000099',
    commandKey: 'operator.snooze.0003', expectedRowVersion: null,
    snoozedUntil: '2026-08-27T12:00:00.000Z',
  })).ok, false);
  const malformed = await service.snoozeAction({ sessionToken: SESSION, requestId: 'portal-action-3' }, {
    actionId: 'provider.readiness:not-a-uuid',
    commandKey: 'operator.snooze.0004', expectedRowVersion: null,
    snoozedUntil: '2026-08-27T12:00:00.000Z',
  });
  assert.deepEqual(malformed, { ok: false, kind: 'validation', message: 'The selected action is invalid.' });
  assert.equal(calls.length, 1, 'forged keys never reach the command pool');
});

test('assignment commands re-authorize manager and self-service rules on the server', async () => {
  async function run(input: Readonly<{
    canManage: boolean;
    action: PgOperatorActionSnapshot;
    target: string | null;
    directory?: readonly Readonly<{ userId: string; displayName: string; role: 'owner' | 'sales' }>[];
  }>) {
    const calls: unknown[] = [];
    const service = new PgPortalOperatorActionCentreService({
      principalResolver: { resolve: async () => ({ workspaceId: WORKSPACE_ID, userId: USER_ID }) },
      readService: { load: async () => ({
        workspaceId: WORKSPACE_ID,
        workspaceName: 'Property Predator Growth HQ',
        asOf: '2026-08-26T12:00:00.000Z',
        environment: 'production' as const,
        datasetKind: 'postgres_authoritative' as const,
        currentUserId: USER_ID,
        canWrite: true,
        canManage: input.canManage,
        canAssign: input.canManage,
        commandBoundaryAvailable: true,
        assignableMembers: input.directory ?? [{ userId: USER_ID, displayName: 'Self', role: 'sales' as const }],
        membersTruncated: false,
        inputTruncated: false,
        actions: [input.action],
      }) },
      commandService: {
        snooze: async () => assert.fail('not used'),
        assign: async (_context, command) => {
          calls.push(command);
          return {
            actionId: input.action.actionId,
            sourceKind: input.action.source,
            sourceReference: input.action.sourceReference,
            assignmentOverridden: true,
            assignedUserId: input.target,
            snoozedUntil: null,
            rowVersion: 1,
            changed: true,
            disposition: 'applied' as const,
          };
        },
      },
    });
    const outcome = await service.assignAction({ sessionToken: SESSION, requestId: 'assignment-auth' }, {
      actionId: input.action.actionId,
      commandKey: 'operator.assign.authorization',
      expectedRowVersion: input.action.rowVersion,
      assignedUserId: input.target,
    });
    return { outcome, calls };
  }

  const otherOwned = await run({
    canManage: false,
    action: pgAction({ assignedUserId: OTHER_USER_ID, ownerLabel: 'Another member' }),
    target: USER_ID,
  });
  assert.deepEqual(otherOwned.outcome, {
    ok: false, kind: 'forbidden',
    message: 'This role may claim only an unassigned or already self-owned action.',
  });
  assert.equal(otherOwned.calls.length, 0);

  const selfClaim = await run({
    canManage: false,
    action: pgAction({ assignedUserId: null, ownerLabel: null }),
    target: USER_ID,
  });
  assert.equal(selfClaim.outcome.ok, true);
  assert.equal(selfClaim.calls.length, 1);

  const sourceOwnerRelease = await run({
    canManage: false,
    action: pgAction({ assignedUserId: USER_ID, assignmentOverridden: false }),
    target: null,
  });
  assert.equal(sourceOwnerRelease.outcome.ok, false);
  assert.equal(sourceOwnerRelease.calls.length, 0);

  const ownOverlayRelease = await run({
    canManage: false,
    action: pgAction({ assignedUserId: USER_ID, assignmentOverridden: true }),
    target: null,
  });
  assert.equal(ownOverlayRelease.outcome.ok, true);
  assert.equal(ownOverlayRelease.calls.length, 1);

  const managerUnknownTarget = await run({
    canManage: true,
    action: pgAction(),
    target: OTHER_USER_ID,
    directory: [{ userId: USER_ID, displayName: 'Founder', role: 'owner' }],
  });
  assert.equal(managerUnknownTarget.outcome.ok, false);
  assert.equal(managerUnknownTarget.calls.length, 0);

  const managerKnownTarget = await run({
    canManage: true,
    action: pgAction(),
    target: OTHER_USER_ID,
    directory: [
      { userId: USER_ID, displayName: 'Founder', role: 'owner' },
      { userId: OTHER_USER_ID, displayName: 'Sales', role: 'sales' },
    ],
  });
  assert.equal(managerKnownTarget.outcome.ok, true);
  assert.equal(managerKnownTarget.calls.length, 1);
});

test('portal command outcomes sanitise validation, permission and optimistic-concurrency failures', async () => {
  const action = pgAction();
  async function outcomeFor(code: string) {
    const service = new PgPortalOperatorActionCentreService({
      principalResolver: { resolve: async () => ({ workspaceId: WORKSPACE_ID, userId: USER_ID }) },
      readService: { load: async () => ({
        workspaceId: WORKSPACE_ID,
        workspaceName: 'Property Predator Growth HQ',
        asOf: '2026-08-26T12:00:00.000Z',
        environment: 'production' as const,
        datasetKind: 'postgres_authoritative' as const,
        currentUserId: USER_ID,
        canWrite: true,
        canManage: true,
        canAssign: true,
        commandBoundaryAvailable: true,
        assignableMembers: [],
        membersTruncated: false,
        inputTruncated: false,
        actions: [action],
      }) },
      commandService: {
        snooze: async () => { throw Object.assign(new Error('private database detail'), { code }); },
        assign: async () => assert.fail('not used'),
      },
    });
    return service.snoozeAction({ sessionToken: SESSION, requestId: `failure-${code}` }, {
      actionId: action.actionId,
      commandKey: 'operator.snooze.0005', expectedRowVersion: null,
      snoozedUntil: '2026-08-27T12:00:00.000Z',
    });
  }
  const validation = await outcomeFor('22023');
  const forbidden = await outcomeFor('42501');
  const conflict = await outcomeFor('40001');
  assert.equal(validation.ok, false);
  if (!validation.ok) assert.equal(validation.kind, 'validation');
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) assert.equal(forbidden.kind, 'forbidden');
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.kind, 'conflict');
  assert.doesNotMatch(JSON.stringify(forbidden), /private database detail/);
});
