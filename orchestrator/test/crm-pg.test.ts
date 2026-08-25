import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolClient, QueryResult } from 'pg';
import {
  CrmCommandService,
  IdempotencyKeyReusedError,
  InvalidCrmCommandError,
  InvalidCrmStateError,
  OptimisticConflictError,
  createPgCrmTransactionRunner,
} from '../src/crm-pg/index.js';
import { requestDatabaseContext } from '../src/db/rls.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const PIPELINE_ID = '33333333-3333-4333-8333-333333333333';
const STAGE_ID = '44444444-4444-4444-8444-444444444444';
const TARGET_STAGE_ID = '55555555-5555-4555-8555-555555555555';
const OPPORTUNITY_ID = '66666666-6666-4666-8666-666666666666';
const CONTACT_ID = '77777777-7777-4777-8777-777777777777';
const TASK_ID = '88888888-8888-4888-8888-888888888888';
const NOW = '2026-08-23T20:30:00.000Z';

interface RecordedQuery {
  sql: string;
  values?: unknown[];
}

interface StoredReceipt {
  [key: string]: unknown;
  id: string;
  payloadHash: Uint8Array;
  status: 'started' | 'succeeded';
  result: unknown;
}

class FakeClient {
  readonly calls: RecordedQuery[] = [];
  committedReceipt: StoredReceipt | null = null;
  pendingReceipt: StoredReceipt | null = null;
  connectCount = 0;
  failMarker: string | null = null;
  stageStatus: 'open' | 'won' | 'lost' = 'open';
  contactPointRows: Record<string, unknown>[] = [];
  contactPointRowsByValue: Record<string, Record<string, unknown>[]> = {};
  primaryContactPointKinds = new Set<string>();
  lockOpportunityRow: Record<string, unknown> | null = null;
  updatedOpportunityVersion = 2;
  lockTaskRow: Record<string, unknown> | null = null;
  completedTaskVersion = 2;

  async query(sql: string, values?: unknown[]): Promise<QueryResult<Record<string, unknown>>> {
    this.calls.push({ sql, values });
    const marker = queryMarker(sql);
    if (marker && marker === this.failMarker) throw new Error(`simulated failure: ${marker}`);

    if (sql.startsWith('BEGIN ')) this.pendingReceipt = null;
    if (sql === 'COMMIT') {
      if (this.pendingReceipt) this.committedReceipt = this.pendingReceipt;
      this.pendingReceipt = null;
    }
    if (sql === 'ROLLBACK') this.pendingReceipt = null;

    if (marker === 'crm.claim-command') {
      if (this.committedReceipt) return result([]);
      const receipt: StoredReceipt = {
        id: String(values?.[0]),
        payloadHash: Buffer.from(values?.[5] as Uint8Array),
        status: 'started',
        result: null,
      };
      this.pendingReceipt = receipt;
      return result([receipt]);
    }
    if (marker === 'crm.read-command-receipt') {
      return result(this.committedReceipt ? [this.committedReceipt] : []);
    }
    if (marker === 'crm.complete-command') {
      assert.ok(this.pendingReceipt, 'receipt must be claimed before it is completed');
      this.pendingReceipt = {
        ...this.pendingReceipt,
        status: 'succeeded',
        result: JSON.parse(String(values?.[2])) as unknown,
      };
      return result([{ id: this.pendingReceipt.id }]);
    }
    if (marker === 'crm.find-contact-point') {
      const normalizedValue = String(values?.[1]);
      return result(this.contactPointRowsByValue[normalizedValue] ?? this.contactPointRows);
    }
    if (marker === 'crm.has-primary-contact-point') {
      return result(this.primaryContactPointKinds.has(String(values?.[1])) ? [{ id: 'primary-point' }] : []);
    }
    if (marker === 'crm.get-pipeline-stage') {
      return result([{ id: String(values?.[0]), pipelineId: String(values?.[1]), status: this.stageStatus }]);
    }
    if (marker === 'crm.lock-opportunity') return result(this.lockOpportunityRow ? [this.lockOpportunityRow] : []);
    if (marker === 'crm.update-opportunity-stage') return result([{ rowVersion: this.updatedOpportunityVersion }]);
    if (marker === 'crm.lock-task') return result(this.lockTaskRow ? [this.lockTaskRow] : []);
    if (marker === 'crm.complete-task') return result([{ rowVersion: this.completedTaskVersion }]);
    if (marker?.startsWith('crm.insert-')) return result([{ id: String(values?.[0]) }]);
    return result([]);
  }

  release(): void {}
}

function result(rows: Record<string, unknown>[]): QueryResult<Record<string, unknown>> {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
}

function queryMarker(sql: string): string | null {
  return /\/\* (crm\.[a-z-]+) \*\//.exec(sql)?.[1] ?? null;
}

function markers(client: FakeClient, from = 0): string[] {
  return client.calls.slice(from).flatMap((call) => {
    const marker = queryMarker(call.sql);
    return marker ? [marker] : [];
  });
}

function fakePool(client: FakeClient): Pick<Pool, 'connect'> {
  return {
    connect: async () => {
      client.connectCount += 1;
      return client as unknown as PoolClient;
    },
  } as Pick<Pool, 'connect'>;
}

function idSequence(): () => string {
  let value = 0;
  return () => {
    value += 1;
    return `0198d3b9-5731-7000-8000-${String(value).padStart(12, '0')}`;
  };
}

function service(client: FakeClient): CrmCommandService {
  return new CrmCommandService({
    transactionRunner: createPgCrmTransactionRunner(fakePool(client)),
    nextId: idSequence(),
    now: () => new Date(NOW),
  });
}

function context(requestId = 'request-crm-1') {
  return requestDatabaseContext({ workspaceId: WORKSPACE_ID, userId: USER_ID, requestId });
}

function createLeadCommand(commandKey = 'lead:browser-001') {
  return {
    commandKey,
    displayName: 'Ada Lovelace',
    companyName: 'Analytical Engines Ltd',
    source: 'portal',
    ownerUserId: USER_ID,
    contactPoints: [{ kind: 'email' as const, value: ' ADA@Example.com ', isPrimary: true }],
    pipelineId: PIPELINE_ID,
    stageId: STAGE_ID,
    opportunityName: 'Website relaunch',
    valueMinor: 125_000,
    currency: 'gbp',
    task: { title: 'Call Ada', assigneeUserId: USER_ID, dueAt: '2026-08-25T09:00:00Z' },
  };
}

test('createLead owns one transaction and writes receipt, CRM state, timeline, outbox, then result in order', async () => {
  const client = new FakeClient();
  const output = await service(client).createLead(context(), createLeadCommand());

  assert.deepEqual(markers(client), [
    'crm.claim-command',
    'crm.find-contact-point',
    'crm.insert-contact',
    'crm.insert-contact-point',
    'crm.get-pipeline-stage',
    'crm.insert-opportunity',
    'crm.insert-task',
    'crm.insert-activity',
    'crm.insert-outbox-event',
    'crm.insert-outbox-event',
    'crm.complete-command',
  ]);
  assert.equal(output.disposition, 'applied');
  assert.equal(output.createdContact, true);
  assert.match(output.contactId, /^[0-9a-f-]{36}$/);
  assert.equal(client.calls[0]!.sql, 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
  assert.match(client.calls[1]!.sql, /set_config\('app\.workspace_id', \$2, true\)/);
  assert.equal(client.calls.at(-1)!.sql, 'COMMIT');

  const pointCall = client.calls.find((call) => queryMarker(call.sql) === 'crm.insert-contact-point');
  assert.equal(pointCall?.values?.[5], 'ada@example.com');
  const activity = client.calls.find((call) => queryMarker(call.sql) === 'crm.insert-activity');
  const outbox = client.calls.filter((call) => queryMarker(call.sql) === 'crm.insert-outbox-event');
  assert.equal(activity?.values?.[11], outbox[0]?.values?.[7], 'activity and events share a correlation id');
  assert.equal(activity?.values?.[11], outbox[1]?.values?.[7], 'activity and events share a correlation id');
  assert.match(String(outbox[0]?.values?.[5]), /"type":"crm.contact.created"/);
  assert.match(String(outbox[1]?.values?.[5]), /"type":"crm.lead.created"/);
  assert.match(String(outbox[1]?.values?.[5]), /"createdContact":true/);
  const stageLookup = client.calls.find((call) => queryMarker(call.sql) === 'crm.get-pipeline-stage');
  assert.match(String(stageLookup?.sql), /app_private\.lock_active_default_pipeline_stage\(\$1, \$2\)/);
});

test('a lead matched by phone adds a new email as secondary without replacing the contact primary', async () => {
  const client = new FakeClient();
  client.contactPointRowsByValue['+447700900123'] = [{
    id: '99999999-9999-4999-8999-999999999999',
    contactId: CONTACT_ID,
    contactState: 'active',
  }];
  client.primaryContactPointKinds.add('email');
  const output = await service(client).createLead(context(), {
    ...createLeadCommand(),
    contactPoints: [
      { kind: 'email' as const, value: 'new@example.com', isPrimary: true },
      { kind: 'phone' as const, value: '+447700900123', isPrimary: true },
    ],
  });

  assert.equal(output.createdContact, false);
  assert.equal(output.contactId, CONTACT_ID);
  assert.equal(markers(client).includes('crm.insert-contact'), false);
  const pointInserts = client.calls.filter((call) => queryMarker(call.sql) === 'crm.insert-contact-point');
  assert.equal(pointInserts.length, 1, 'the already-owned phone is not inserted twice');
  assert.equal(pointInserts[0]?.values?.[5], 'new@example.com');
  assert.equal(pointInserts[0]?.values?.[6], false, 'new destination is secondary on a reused contact');
  const outbox = client.calls.filter((call) => queryMarker(call.sql) === 'crm.insert-outbox-event');
  assert.equal(outbox.length, 1, 'reused contacts do not emit crm.contact.created');
  assert.match(String(outbox[0]?.values?.[5]), /"type":"crm.lead.created"/);
  assert.match(String(outbox[0]?.values?.[5]), /"createdContact":false/);
});

test('the first phone on a reused contact becomes visible as that kind primary', async () => {
  const client = new FakeClient();
  client.contactPointRowsByValue['existing@example.com'] = [{
    id: '99999999-9999-4999-8999-999999999999',
    contactId: CONTACT_ID,
    contactState: 'active',
  }];
  await service(client).createLead(context(), {
    ...createLeadCommand(),
    contactPoints: [
      { kind: 'email' as const, value: 'existing@example.com', isPrimary: true },
      { kind: 'phone' as const, value: '+447700900456', isPrimary: true },
    ],
  });

  const pointInsert = client.calls.find((call) => queryMarker(call.sql) === 'crm.insert-contact-point');
  assert.equal(pointInsert?.values?.[5], '+447700900456');
  assert.equal(pointInsert?.values?.[6], true);
});

test('unspecified primary flags default to the first destination of each kind', async () => {
  const client = new FakeClient();
  await service(client).createLead(context(), {
    ...createLeadCommand(),
    contactPoints: [
      { kind: 'email' as const, value: 'first@example.com' },
      { kind: 'phone' as const, value: '+447700900789' },
    ],
  });

  const pointInserts = client.calls.filter((call) => queryMarker(call.sql) === 'crm.insert-contact-point');
  assert.deepEqual(pointInserts.map((call) => call.values?.[6]), [true, true]);
});

test('more than one explicit primary of a kind is rejected before opening a transaction', async () => {
  const client = new FakeClient();
  await assert.rejects(
    service(client).createLead(context(), {
      ...createLeadCommand(),
      contactPoints: [
        { kind: 'email' as const, value: 'first@example.com', isPrimary: true },
        { kind: 'email' as const, value: 'second@example.com', isPrimary: true },
      ],
    }),
    (error: unknown) => error instanceof InvalidCrmCommandError && /more than one primary email/.test(error.message),
  );
  assert.equal(client.connectCount, 0);
});

test('a completed command replays its stored result without repeating domain SQL', async () => {
  const client = new FakeClient();
  const commands = service(client);
  const first = await commands.createLead(context(), createLeadCommand());
  const replayStart = client.calls.length;
  const replay = await commands.createLead(context('request-retry'), createLeadCommand());

  assert.equal(first.disposition, 'applied');
  assert.deepEqual(replay, { ...first, disposition: 'replayed' });
  assert.deepEqual(markers(client, replayStart), ['crm.claim-command', 'crm.read-command-receipt']);
  assert.equal(client.calls.at(-1)!.sql, 'COMMIT');
});

test('a retry canonicalises UUID casing before hashing the logical actor', async () => {
  const client = new FakeClient();
  const commands = service(client);
  const first = await commands.createLead(context(), createLeadCommand());
  const uppercaseContext = requestDatabaseContext({
    workspaceId: WORKSPACE_ID.toUpperCase(),
    userId: USER_ID.toUpperCase(),
    requestId: 'request-uppercase-retry',
  });
  const replay = await commands.createLead(uppercaseContext, createLeadCommand());

  assert.deepEqual(replay, { ...first, disposition: 'replayed' });
});

test('an archived contact destination is a typed conflict instead of creating an orphaned lead', async () => {
  const client = new FakeClient();
  client.contactPointRows = [{
    id: '99999999-9999-4999-8999-999999999999',
    contactId: CONTACT_ID,
    contactState: 'archived',
  }];

  await assert.rejects(
    service(client).createLead(context(), createLeadCommand()),
    (error: unknown) => error instanceof InvalidCrmStateError && /archived/.test(error.message),
  );
  assert.deepEqual(markers(client), ['crm.claim-command', 'crm.find-contact-point']);
  assert.equal(client.calls.at(-1)!.sql, 'ROLLBACK');
});

test('reusing a command key for different input is a typed conflict and rolls back before domain SQL', async () => {
  const client = new FakeClient();
  const commands = service(client);
  await commands.createLead(context(), createLeadCommand());
  const retryStart = client.calls.length;

  await assert.rejects(
    commands.createLead(context('request-reused'), { ...createLeadCommand(), displayName: 'Different person' }),
    (error: unknown) => error instanceof IdempotencyKeyReusedError && error.code === 'idempotency_key_reused',
  );
  assert.deepEqual(markers(client, retryStart), ['crm.claim-command', 'crm.read-command-receipt']);
  assert.equal(client.calls.at(-1)!.sql, 'ROLLBACK');
});

test('moveOpportunityStage locks, version-checks, mutates and appends history/activity/outbox atomically', async () => {
  const client = new FakeClient();
  client.lockOpportunityRow = {
    id: OPPORTUNITY_ID,
    contactId: CONTACT_ID,
    pipelineId: PIPELINE_ID,
    stageId: STAGE_ID,
    status: 'open',
    rowVersion: '4',
  };
  client.stageStatus = 'won';
  client.updatedOpportunityVersion = 5;
  const output = await service(client).moveOpportunityStage(context(), {
    commandKey: 'move:opportunity-001',
    opportunityId: OPPORTUNITY_ID,
    targetStageId: TARGET_STAGE_ID,
    expectedRowVersion: 4,
    note: 'Signed agreement received',
  });

  assert.deepEqual(markers(client), [
    'crm.claim-command',
    'crm.lock-opportunity',
    'crm.get-pipeline-stage',
    'crm.update-opportunity-stage',
    'crm.insert-stage-history',
    'crm.insert-activity',
    'crm.insert-outbox-event',
    'crm.complete-command',
  ]);
  assert.deepEqual(output, {
    disposition: 'applied',
    opportunityId: OPPORTUNITY_ID,
    fromStageId: STAGE_ID,
    toStageId: TARGET_STAGE_ID,
    status: 'won',
    rowVersion: 5,
  });
  const history = client.calls.find((call) => queryMarker(call.sql) === 'crm.insert-stage-history');
  const activity = client.calls.find((call) => queryMarker(call.sql) === 'crm.insert-activity');
  const outbox = client.calls.find((call) => queryMarker(call.sql) === 'crm.insert-outbox-event');
  assert.equal(history?.values?.[8], activity?.values?.[11]);
  assert.equal(activity?.values?.[11], outbox?.values?.[7]);
  assert.match(String(outbox?.values?.[5]), /"type":"crm.opportunity.stage_changed"/);
  assert.match(
    String(outbox?.sql),
    /\$1::uuid[\s\S]*\$1::uuid::text/,
    'the shared event id is typed once as UUID before deriving its text idempotency key',
  );
});

test('a stale opportunity version is a typed conflict and leaves no history or outbox', async () => {
  const client = new FakeClient();
  client.lockOpportunityRow = {
    id: OPPORTUNITY_ID,
    contactId: CONTACT_ID,
    pipelineId: PIPELINE_ID,
    stageId: STAGE_ID,
    status: 'open',
    rowVersion: 9,
  };
  await assert.rejects(
    service(client).moveOpportunityStage(context(), {
      commandKey: 'move:stale-001',
      opportunityId: OPPORTUNITY_ID,
      targetStageId: TARGET_STAGE_ID,
      expectedRowVersion: 8,
    }),
    (error: unknown) => error instanceof OptimisticConflictError && error.code === 'optimistic_conflict',
  );
  assert.deepEqual(markers(client), ['crm.claim-command', 'crm.lock-opportunity']);
  assert.equal(client.calls.at(-1)!.sql, 'ROLLBACK');
});

test('completeTask version-checks and commits activity plus an internal task event', async () => {
  const client = new FakeClient();
  client.lockTaskRow = {
    id: TASK_ID,
    contactId: CONTACT_ID,
    opportunityId: OPPORTUNITY_ID,
    status: 'open',
    rowVersion: 2,
  };
  client.completedTaskVersion = 3;
  const output = await service(client).completeTask(context(), {
    commandKey: 'task:complete-001',
    taskId: TASK_ID,
    expectedRowVersion: 2,
  });

  assert.deepEqual(markers(client), [
    'crm.claim-command',
    'crm.lock-task',
    'crm.complete-task',
    'crm.insert-activity',
    'crm.insert-outbox-event',
    'crm.complete-command',
  ]);
  assert.deepEqual(output, {
    disposition: 'applied', taskId: TASK_ID, completedAt: NOW, rowVersion: 3,
  });
  const outbox = client.calls.find((call) => queryMarker(call.sql) === 'crm.insert-outbox-event');
  assert.match(String(outbox?.values?.[5]), /"type":"crm.task.completed"/);
});

test('a late SQL failure rolls the whole lead command back and never completes its receipt', async () => {
  const client = new FakeClient();
  client.failMarker = 'crm.insert-activity';
  await assert.rejects(service(client).createLead(context(), createLeadCommand()), /simulated failure/);
  assert.equal(client.calls.at(-1)!.sql, 'ROLLBACK');
  assert.equal(markers(client).includes('crm.complete-command'), false);
  assert.equal(client.committedReceipt, null);
});

test('invalid caller command keys fail as validation errors before opening a database connection', async () => {
  const client = new FakeClient();
  await assert.rejects(
    service(client).createLead(context(), createLeadCommand('contains whitespace')),
    (error: unknown) => error instanceof InvalidCrmCommandError && error.code === 'invalid_command',
  );
  assert.equal(client.connectCount, 0);
  assert.deepEqual(client.calls, []);
});

test('opportunity names are bounded to the database column before opening a transaction', async () => {
  const client = new FakeClient();
  await assert.rejects(
    service(client).createLead(context(), { ...createLeadCommand(), opportunityName: 'x'.repeat(201) }),
    (error: unknown) => error instanceof InvalidCrmCommandError && /opportunityName/.test(error.message),
  );
  assert.equal(client.connectCount, 0);
});

test('task due dates require a real RFC3339 timestamp with an explicit timezone', async () => {
  for (const dueAt of ['2026-08-25T09:00:00', '2026-02-30T09:00:00Z']) {
    const client = new FakeClient();
    await assert.rejects(
      service(client).createLead(context(), {
        ...createLeadCommand(),
        task: { title: 'Call Ada', assigneeUserId: USER_ID, dueAt },
      }),
      (error: unknown) => error instanceof InvalidCrmCommandError && /timestamp/.test(error.message),
    );
    assert.equal(client.connectCount, 0);
  }
});

test('the derived opportunity name stays within its database bound at the maximum contact name', async () => {
  const client = new FakeClient();
  await service(client).createLead(context(), {
    ...createLeadCommand(),
    displayName: 'x'.repeat(200),
    opportunityName: undefined,
  });
  const insert = client.calls.find((call) => queryMarker(call.sql) === 'crm.insert-opportunity');
  assert.equal(String(insert?.values?.[4]).length, 200);
  assert.match(String(insert?.values?.[4]), / opportunity$/);
});
