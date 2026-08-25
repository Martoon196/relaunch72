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
  return { sessionToken: 'opaque-session-token', requestId: 'portal-crm-request' };
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

test('PostgreSQL portal workspace shell uses the one-query context read without loading a CRM snapshot', async () => {
  let commandContextReads = 0;
  let fullSnapshotReads = 0;
  const service = new PgPortalCrmService({
    principalResolver: { resolve: async () => ({ userId: USER_ID, workspaceId: WORKSPACE_ID }) },
    readService: {
      loadWorkspaceCommandContext: async () => {
        commandContextReads += 1;
        return readSnapshot().workspace;
      },
      loadWorkspaceSnapshot: async () => {
        fullSnapshotReads += 1;
        throw new Error('workspace shell must not load the full CRM snapshot');
      },
    },
    commandService: {} as PgPortalCrmDependencies['commandService'],
  });

  const shell = await service.workspaceShell(identity());
  assert.deepEqual(shell, {
    workspace: {
      id: WORKSPACE_ID,
      name: 'Northstar Property',
      timezone: 'Europe/London',
      snapshotAt: '2026-08-24T08:00:00.000Z',
      canWrite: true,
    },
  });
  assert.equal(commandContextReads, 1);
  assert.equal(fullSnapshotReads, 0);
  assert.ok(Object.isFrozen(shell));
  assert.ok(Object.isFrozen(shell?.workspace));
});

test('portal adapter maps verified Growth HQ evidence without treating CRM stages as funnel stages', async () => {
  const service = new PgPortalCrmService({
    principalResolver: { resolve: async () => ({ userId: USER_ID, workspaceId: WORKSPACE_ID }) },
    readService: { loadWorkspaceSnapshot: async () => readSnapshot() },
    growthReadService: {
      load: async () => ({
        asOf: '2026-08-25T12:00:00.000Z',
        windowLabel: 'Last 30 days' as const,
        funnels: [
          {
            journeySlug: 'property-predator-self-serve' as const,
            journeyName: 'Self-serve conversion', journeyDescription: 'Verified product route',
            milestoneKey: 'lead', milestoneName: 'Lead', position: 1, count: 0, movedInWindow: 0,
          },
          {
            journeySlug: 'property-predator-self-serve' as const,
            journeyName: 'Self-serve conversion', journeyDescription: 'Verified product route',
            milestoneKey: 'activated', milestoneName: 'Activated', position: 2, count: 6, movedInWindow: 3,
          },
        ],
        hotLeads: [{
          contactId: CONTACT_ID, displayName: 'Avery Stone', companyName: null,
          journeySlug: 'property-predator-self-serve' as const, currentStage: 'Activated',
          score: 71, band: 'unexpected-database-label', evidenceKind: 'watched' as const,
          evidenceLabel: 'Predator Briefing', evidenceDetail: '82% complete',
          evidenceAt: '2026-08-25T10:00:00.000Z', contentSummary: 'Predator Briefing · 82%',
          offerSummary: null,
        }],
        evidenceTotals: { contentStarted: 3, contentCompleted: 1, offersShown: 0, replies: 0, appointments: 0 },
      }),
    },
    commandService: {} as PgPortalCrmDependencies['commandService'],
  });

  const growth = await service.growth(identity());
  assert.equal(growth?.dataState, 'live');
  assert.deepEqual(growth?.funnels[0]?.stages.map((stage) => [stage.key, stage.count, stage.stepConversionPercent]), [
    ['lead', 0, null], ['activated', 6, null],
  ]);
  assert.equal(growth?.funnels[1]?.stages[0]?.count, 0, 'missing journey keeps a truthful zero blueprint');
  assert.equal(growth?.hotLeads[0]?.band, 'burning', 'published score thresholds own the display band');
  assert.equal(growth?.hotLeads[0]?.lastEvidence?.kind, 'watched');
  assert.match(growth?.hotLeads[0]?.nextMove ?? '', /Contact personally/);
  assert.ok(Object.isFrozen(growth));
});

test('portal adapter maps the narrow Lead 360 read model without losing exact offer or consent states', async () => {
  const service = new PgPortalCrmService({
    principalResolver: { resolve: async () => ({ userId: USER_ID, workspaceId: WORKSPACE_ID }) },
    readService: { loadWorkspaceSnapshot: async () => readSnapshot() },
    lead360ReadService: {
      load: async () => ({
        workspaceId: WORKSPACE_ID, contactId: CONTACT_ID, asOf: '2026-08-25T12:00:00.000Z',
        identity: {
          contactId: CONTACT_ID, displayName: 'Avery Stone', companyName: null,
          primaryEmail: 'avery@example.test', primaryPhone: null, lifecycle: 'lead' as const,
          ownerUserId: USER_ID, createdAt: '2026-08-20T09:00:00.000Z', updatedAt: '2026-08-25T11:00:00.000Z',
        },
        journeys: [{
          enrollmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', journeyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          journeyVersionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Agency LAPS', status: 'active' as const,
          currentMilestoneId: STAGE_ID, enrolledAt: '2026-08-20T09:00:00.000Z', lastEventAt: '2026-08-25T10:00:00.000Z', endedAt: null,
          stages: [{ id: STAGE_ID, key: 'appointment', name: 'Appointment', position: 2, semantic: 'appointment' as const, isCompletion: false, isCurrent: true, reachedAt: '2026-08-25T10:00:00.000Z' }],
        }, {
          enrollmentId: '15151515-1515-4515-8515-151515151515', journeyId: '16161616-1616-4616-8616-161616161616',
          journeyVersionId: '17171717-1717-4717-8717-171717171717', name: 'Self-serve conversion', status: 'active' as const,
          currentMilestoneId: '18181818-1818-4818-8818-181818181818', enrolledAt: '2026-08-21T09:00:00.000Z', lastEventAt: '2026-08-24T10:00:00.000Z', endedAt: null,
          stages: [{ id: '18181818-1818-4818-8818-181818181818', key: 'activated', name: 'Activated', position: 2, semantic: 'activation' as const, isCompletion: false, isCurrent: true, reachedAt: '2026-08-24T10:00:00.000Z' }],
          score: {
            id: '19191919-1919-4919-8919-191919191919', enrollmentId: '15151515-1515-4515-8515-151515151515',
            total: 35, band: 'warm', componentScores: { engagement: 35, intent: 0 }, reasons: ['Completed analysis'],
            sourceOccurredAt: '2026-08-24T10:00:00.000Z', evaluatedAt: '2026-08-24T10:01:00.000Z',
          },
        }],
        journey: {
          enrollmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', journeyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          journeyVersionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Agency LAPS', status: 'active' as const,
          currentMilestoneId: STAGE_ID, enrolledAt: '2026-08-20T09:00:00.000Z', lastEventAt: '2026-08-25T10:00:00.000Z', endedAt: null,
          stages: [{ id: STAGE_ID, key: 'appointment', name: 'Appointment', position: 2, semantic: 'appointment' as const, isCompletion: false, isCurrent: true, reachedAt: '2026-08-25T10:00:00.000Z' }],
        },
        score: {
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', enrollmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          total: 52, band: 'hot', componentScores: { engagement: 42, intent: 10 }, reasons: ['Requested contact'],
          sourceOccurredAt: '2026-08-25T10:00:00.000Z', evaluatedAt: '2026-08-25T10:01:00.000Z',
        },
        evidence: [{
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', kind: 'offer' as const, title: 'Apex Annual',
          detail: 'requested contact', progressBasisPoints: null, occurredAt: '2026-08-25T10:00:00.000Z', sourceLabel: 'Offer response',
        }],
        offers: [{
          id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', offerKey: 'apex-annual', label: 'Apex Annual', offerVersion: '2026.08',
          productKey: 'apex', priceMinor: 9900, currency: 'GBP', placement: 'results', presentedAt: '2026-08-25T09:58:00.000Z',
          latestResponse: { id: '12121212-1212-4212-8212-121212121212', response: 'requested_contact' as const, respondedAt: '2026-08-25T10:00:00.000Z' },
        }],
        consent: [{
          contactPointId: '13131313-1313-4313-8313-131313131313', contactPointKind: 'email' as const, contactPointLabel: 'Work',
          contactPointValue: 'avery@example.test', isPrimary: true, isVerified: true, dedupeState: 'normal' as const,
          channel: 'email' as const, purpose: 'property_predator_marketing', state: 'denied' as const, lawfulBasis: null,
          updatedAt: '2026-08-25T09:00:00.000Z', consentEventId: '14141414-1414-4414-8414-141414141414',
          suppressionEventId: null, suppressionReason: null,
        }],
        crm: {
          opportunities: [{
            id: OPPORTUNITY_ID, pipelineId: PIPELINE_ID, stageId: STAGE_ID, stageName: 'Qualified', title: 'Apex Annual',
            status: 'open' as const, valueMinor: 9900, currency: 'GBP', probability: 50, expectedCloseDate: null, closedAt: null,
            updatedAt: '2026-08-25T11:00:00.000Z',
          }],
          tasks: [{
            id: TASK_ID, opportunityId: OPPORTUNITY_ID, title: 'Old task', priority: 'normal' as const, status: 'cancelled' as const,
            dueAt: null, completedAt: null, updatedAt: '2026-08-25T11:00:00.000Z',
          }],
        },
      }),
    },
    commandService: {} as PgPortalCrmDependencies['commandService'],
  });

  const caseFile = await service.lead360(identity(), CONTACT_ID);
  assert.equal(caseFile?.offers[0]?.title, 'Apex Annual');
  assert.equal(caseFile?.offers[0]?.state, 'requested_contact');
  assert.equal(caseFile?.consent[0]?.state, 'denied');
  assert.equal(caseFile?.crm.tasks[0]?.state, 'cancelled');
  assert.match(caseFile?.scoreExplanation ?? '', /Requested contact · Engagement 42 · Intent 10/);
  assert.equal(caseFile?.journeys?.length, 2);
  assert.equal(caseFile?.journeys?.[0]?.status, 'active');
  assert.equal(caseFile?.journeys?.[0]?.isPrimary, true);
  assert.equal(caseFile?.journeys?.[1]?.isPrimary, false);
  assert.equal(caseFile?.primaryJourneyLabel, 'Agency LAPS');
  assert.match(caseFile?.journeys?.[0]?.score?.explanation ?? '', /Requested contact · Engagement 42 · Intent 10/);
  assert.equal(caseFile?.journeys?.[1]?.score?.total, 35);
  assert.equal(caseFile?.nextMove?.label, 'Review channel permission before any outreach');
  assert.ok(Object.isFrozen(caseFile));
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
