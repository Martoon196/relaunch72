import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { CrmWorkspaceReadSnapshot } from '../src/crm-pg/index.js';
import {
  PgPortalCrmService,
  createPgPortalCrmPrincipalResolver,
  workspaceLocalDateTime,
  type PgPortalCrmDependencies,
} from '../src/portal/crm-pg-service.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const PIPELINE_ID = '33333333-3333-4333-8333-333333333333';
const STAGE_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_STAGE_ID = '55555555-5555-4555-8555-555555555555';
const CONTACT_ID = '66666666-6666-4666-8666-666666666666';
const OPPORTUNITY_ID = '77777777-7777-4777-8777-777777777777';
const TASK_ID = '88888888-8888-4888-8888-888888888888';

function readSnapshot(canWrite = true): CrmWorkspaceReadSnapshot {
  return {
    workspace: { id: WORKSPACE_ID, name: 'Northstar Property', timezone: 'Europe/London', currency: 'USD', snapshotAt: '2026-08-24T08:00:00.000Z', defaultPipelineId: PIPELINE_ID, canWrite },
    contacts: [{
      id: CONTACT_ID, displayName: 'Avery Stone', companyName: null, primaryEmail: 'avery@example.test', primaryPhone: null,
      lifecycle: 'lead', ownerUserId: USER_ID, openOpportunityCount: 1, nextTask: null, lastActivityAt: null,
      createdAt: '2026-08-20T09:00:00.000Z', updatedAt: '2026-08-23T09:00:00.000Z', rowVersion: 1,
    }],
    stages: [
      { id: STAGE_ID, pipelineId: PIPELINE_ID, name: 'New lead', position: 1, stageType: 'open', isTerminal: false, rowVersion: 1 },
      { id: OTHER_STAGE_ID, pipelineId: PIPELINE_ID, name: 'Won', position: 2, stageType: 'won', isTerminal: true, rowVersion: 1 },
    ],
    opportunities: [{
      id: OPPORTUNITY_ID, contactId: CONTACT_ID, contactName: 'Avery Stone', companyName: null,
      pipelineId: PIPELINE_ID, stageId: STAGE_ID, title: 'Riverside acquisition', status: 'open', valueMinor: 125_000,
      currency: 'GBP', probability: 50, ownerUserId: USER_ID, expectedCloseDate: '2026-09-30', nextTask: null,
      updatedAt: '2026-08-23T09:00:00.000Z', rowVersion: 2,
    }],
    tasks: [{
      id: TASK_ID, contactId: CONTACT_ID, contactName: 'Avery Stone', opportunityId: OPPORTUNITY_ID,
      opportunityTitle: 'Riverside acquisition', title: 'Call Avery', description: null, assigneeUserId: USER_ID,
      priority: 'normal', status: 'open', dueAt: '2026-08-25T08:00:00.000Z', completedAt: null,
      completedByUserId: null, updatedAt: '2026-08-23T09:00:00.000Z', rowVersion: 2,
    }],
    timeline: [{
      id: '99999999-9999-4999-8999-999999999999', contactId: CONTACT_ID, opportunityId: OPPORTUNITY_ID,
      taskId: null, activityType: 'crm.lead.created', subject: 'Lead created', actorKind: 'user',
      actorUserId: USER_ID, occurredAt: '2026-08-23T09:00:00.000Z',
    }],
  };
}

function identity() {
  return { sessionToken: 'opaque-session-token', legacyTenantId: 'legacy-t1', requestId: 'portal-crm-request' };
}

test('PostgreSQL principal resolver sends only a SHA-256 token hash to the safe session function', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: [{ user_id: USER_ID.toUpperCase(), selected_workspace_id: WORKSPACE_ID.toUpperCase() }] };
    },
  };
  const principal = await createPgPortalCrmPrincipalResolver(pool as never).resolve('raw-secret-token');

  assert.deepEqual(principal, { userId: USER_ID, workspaceId: WORKSPACE_ID });
  assert.match(calls[0]!.sql, /app_private\.resolve_session\(\$1\)/);
  assert.deepEqual(calls[0]!.values[0], createHash('sha256').update('raw-secret-token').digest());
  assert.doesNotMatch(String(calls[0]!.values[0]), /raw-secret-token/);
});

test('workspace wall time resolves exactly and rejects DST gaps and ambiguous clock folds', () => {
  assert.equal(workspaceLocalDateTime('2026-08-24T09:30', 'Europe/London'), '2026-08-24T08:30:00.000Z');
  assert.throws(() => workspaceLocalDateTime('2026-03-29T01:30', 'Europe/London'), /does not exist/);
  assert.throws(() => workspaceLocalDateTime('2026-10-25T01:30', 'Europe/London'), /ambiguous/);
  assert.throws(() => workspaceLocalDateTime('2026-02-30T09:30', 'Europe/London'), /real calendar/);
});

test('portal adapter maps the durable read model and supplies server-owned mutation keys', async () => {
  const keys = ['move-key-1', 'complete-key-1'];
  const service = new PgPortalCrmService({
    principalResolver: { resolve: async () => ({ userId: USER_ID, workspaceId: WORKSPACE_ID }) },
    readService: { loadWorkspaceSnapshot: async () => readSnapshot() },
    commandService: {} as PgPortalCrmDependencies['commandService'],
    nextCommandKey: () => keys.shift()!,
  });
  const snapshot = await service.snapshot(identity());

  assert.equal(snapshot?.workspace.canWrite, true);
  assert.equal(snapshot?.contacts[0]?.displayName, 'Avery Stone');
  assert.equal(snapshot?.stages[1]?.isClosed, true);
  assert.equal(snapshot?.opportunities[0]?.moveCommandKey, 'move-key-1');
  assert.equal(snapshot?.opportunities[0]?.ownerName, 'Assigned workspace member');
  assert.equal(snapshot?.opportunities[0]?.expectedCloseDate, '2026-09-30');
  assert.equal(snapshot?.tasks[0]?.completeCommandKey, 'complete-key-1');
  assert.equal(snapshot?.tasks[0]?.assigneeName, 'Assigned workspace member');
  assert.equal(snapshot?.timeline[0]?.kind, 'lead_created');
  assert.ok(Object.isFrozen(snapshot));
});

test('create lead validates browser input, owns actor fields and resolves task due time in workspace time', async () => {
  const commands: unknown[] = [];
  let commandContextReads = 0;
  const service = new PgPortalCrmService({
    principalResolver: { resolve: async () => ({ userId: USER_ID, workspaceId: WORKSPACE_ID }) },
    readService: {
      loadWorkspaceSnapshot: async () => { throw new Error('mutation must not load the full CRM snapshot'); },
      loadWorkspaceCommandContext: async () => {
        commandContextReads += 1;
        return readSnapshot().workspace;
      },
    },
    commandService: {
      createLead: async (context, command) => {
        commands.push({ context, command });
        return { disposition: 'applied', contactId: CONTACT_ID, opportunityId: OPPORTUNITY_ID, taskId: TASK_ID, createdContact: true };
      },
      moveOpportunityStage: async () => { throw new Error('not used'); },
      completeTask: async () => { throw new Error('not used'); },
    },
  });

  const invalid = await service.createLead(identity(), {
    commandKey: 'lead-key-1', displayName: 'Ada', companyName: '', email: '', phone: '',
    opportunityTitle: 'Website relaunch', stageId: STAGE_ID, taskTitle: '', taskDueAt: '',
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.ok ? '' : invalid.kind, 'validation');
  assert.equal(commands.length, 0);

  const outcome = await service.createLead(identity(), {
    commandKey: 'lead-key-2', displayName: ' Ada Lovelace ', companyName: ' Engines Ltd ',
    email: 'ada@example.test', phone: '+44 7700 900123', opportunityTitle: ' Website relaunch ', stageId: STAGE_ID,
    taskTitle: ' Call Ada ', taskDueAt: '2026-08-24T09:30',
  });
  assert.deepEqual(outcome, { ok: true, disposition: 'applied' });
  assert.equal(commandContextReads, 2, 'each attempted command performs one lightweight permission/default read');
  const saved = commands[0] as { context: { userId?: string }; command: Record<string, unknown> };
  assert.equal(saved.context.userId, USER_ID);
  assert.equal(saved.command.ownerUserId, USER_ID);
  assert.equal(saved.command.pipelineId, PIPELINE_ID);
  assert.equal(saved.command.currency, 'USD');
  assert.deepEqual(saved.command.contactPoints, [
    { kind: 'email', value: 'ada@example.test', isPrimary: true },
    { kind: 'phone', value: '+44 7700 900123', isPrimary: true },
  ]);
  assert.deepEqual(saved.command.task, { title: 'Call Ada', assigneeUserId: USER_ID, dueAt: '2026-08-24T08:30:00.000Z' });
});

test('viewer membership blocks all portal mutation services before a command transaction', async () => {
  let commands = 0;
  const service = new PgPortalCrmService({
    principalResolver: { resolve: async () => ({ userId: USER_ID, workspaceId: WORKSPACE_ID }) },
    readService: { loadWorkspaceSnapshot: async () => readSnapshot(false) },
    commandService: {
      createLead: async () => { commands += 1; throw new Error('must not run'); },
      moveOpportunityStage: async () => { commands += 1; throw new Error('must not run'); },
      completeTask: async () => { commands += 1; throw new Error('must not run'); },
    },
  });
  const outcome = await service.completeTask(identity(), { commandKey: 'task-key-1', taskId: TASK_ID, expectedRowVersion: '2' });
  assert.deepEqual(outcome, { ok: false, kind: 'forbidden', message: 'Your workspace role has read-only CRM access.' });
  assert.equal(commands, 0);
});
