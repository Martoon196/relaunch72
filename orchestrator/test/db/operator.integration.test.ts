/**
 * Operator API on a disposable PostgreSQL with the actual roles: delegated sessions
 * through r72_identity_command, CRM tools through r72_web / r72_crm_command and
 * webinar tools through r72_content_command, all acting as the configured user.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase, testDatabaseSkipReason } from './database-helper.js';
import { loginRole, seedBrand } from './webinar-harness.js';
import { CrmCommandService, createPgCrmTransactionRunner } from '../../src/crm-pg/index.js';
import { loadOperatorConfig } from '../../src/operator/config.js';
import { OperatorSessions } from '../../src/operator/sessions.js';
import { createOperatorTools } from '../../src/operator/tools.js';
import { PgPortalAuthService } from '../../src/portal/auth-pg-service.js';
import { createPgPortalCrmService } from '../../src/portal/crm-pg-service.js';
import { loadWebinarConfig } from '../../src/webinars/config.js';
import { PgWebinarService } from '../../src/webinars/service.js';

const skip = testDatabaseSkipReason();

test('operator tools act as the configured owner through delegated sessions on actual roles', { skip, timeout: 300_000 }, async () => {
  const admin = await openTestDatabase();
  const identityPool = await loginRole(admin, 'r72_identity_command');
  const webPool = await loginRole(admin, 'r72_web');
  const crmPool = await loginRole(admin, 'r72_crm_command');
  const content = await loginRole(admin, 'r72_content_command');
  try {
    const a = await seedBrand(admin, 'Alpha');
    const b = await seedBrand(admin, 'Bravo');
    const auth = new PgPortalAuthService({ readPool: webPool, commandPool: identityPool });
    const crm = createPgPortalCrmService({ webPool, commandPool: crmPool, cursorSecret: 'cursor-secret-synthetic-at-least-32-chars!!' });
    const webinarConfig = loadWebinarConfig({ WEBINAR_ACCESS_SECRET: 's'.repeat(40), WEBINAR_PUBLIC_ORIGIN: 'https://app.example.test' });
    const webinars = new PgWebinarService({ pool: content, config: webinarConfig, stream: null,
      crm: { commands: new CrmCommandService({ transactionRunner: createPgCrmTransactionRunner(crmPool) }), pool: crmPool } });
    const env = { R72_OPERATOR_TOKEN: 't'.repeat(40), R72_OPERATOR_USER_ID: a.owner.userId, R72_GROUP_HQ_CRM_PP_WORKSPACE_ID: a.ws, R72_OPERATOR_WRITES: 'enabled' };
    const tools = createOperatorTools({ sessions: new OperatorSessions(loadOperatorConfig(env)!, { pp: auth, mhp: undefined }), crm, webinars, writes: true });

    const overview = await tools.callTool('workspace_overview', { brand: 'pp' }) as { workspace: { id: string; canWrite: boolean }; stages: { id: string; name: string }[] };
    assert.equal(overview.workspace.id, a.ws);
    assert.equal(overview.workspace.canWrite, true);
    const stage = overview.stages.find((s) => s.name === 'New')!;
    const created = await tools.callTool('crm_create_lead', { brand: 'pp', commandKey: 'operator.test.lead-1', displayName: 'Land Buyer', email: 'buyer@example.test', opportunityTitle: 'Unregistered plot', stageId: stage.id, taskTitle: 'Call back' });
    assert.deepEqual(created, { ok: true, disposition: 'applied' });
    assert.deepEqual(await tools.callTool('crm_create_lead', { brand: 'pp', commandKey: 'operator.test.lead-1', displayName: 'Land Buyer', email: 'buyer@example.test', opportunityTitle: 'Unregistered plot', stageId: stage.id, taskTitle: 'Call back' }), { ok: true, disposition: 'replayed' }, 'same command key and payload replays');
    await assert.rejects(tools.callTool('crm_create_lead', { brand: 'pp', commandKey: 'operator.test.lead-1', displayName: 'Someone Else', email: 'buyer@example.test', opportunityTitle: 'Unregistered plot', stageId: stage.id, taskTitle: 'Call back' }), /conflict/, 'same key with a different payload is refused');
    const contacts = await tools.callTool('crm_contacts', { brand: 'pp' }) as { contacts: { displayName: string; id: string }[] };
    assert.ok(contacts.contacts.some((c) => c.displayName === 'Land Buyer'));
    const pipeline = await tools.callTool('crm_pipeline', { brand: 'pp' }) as { opportunities: { title: string; rowVersion: number; id: string }[] };
    assert.ok(pipeline.opportunities.some((o) => o.title === 'Unregistered plot'));
    const tasks = await tools.callTool('crm_tasks', { brand: 'pp', filter: 'open' }) as { tasks: { title: string; id: string; rowVersion: number }[] };
    const task = tasks.tasks.find((t) => t.title === 'Call back')!;
    assert.deepEqual(await tools.callTool('crm_complete_task', { brand: 'pp', taskId: task.id, expectedRowVersion: task.rowVersion }), { ok: true, disposition: 'applied' });
    await assert.rejects(tools.callTool('crm_complete_task', { brand: 'pp', taskId: task.id, expectedRowVersion: task.rowVersion + 10, commandKey: 'operator.test.stale' }), /conflict|not_found/);
    const lead = await tools.callTool('crm_lead_360', { brand: 'pp', contactId: contacts.contacts.find((c) => c.displayName === 'Land Buyer')!.id }) as { identity: { displayName: string } };
    assert.equal(lead.identity.displayName, 'Land Buyer');

    const webinar = await tools.callTool('webinar_create', { brand: 'pp', title: 'Unregistered land', presenterName: 'Martin', startsLocal: '2026-11-25T19:00', durationMinutes: 60, settings: { crmAutoHandoff: false } }) as { event: { id: string; status: string; title: string; settings: { crmAutoHandoff: boolean } }; rowVersion: number };
    assert.deepEqual([webinar.event.status, webinar.event.title, webinar.event.settings.crmAutoHandoff], ['draft', 'Unregistered land', false]);
    const published = await tools.callTool('webinar_set_status', { brand: 'pp', id: webinar.event.id, action: 'publish' }) as { event: { status: string }; rowVersion: number };
    assert.equal(published.event.status, 'published');
    const updated = await tools.callTool('webinar_update', { brand: 'pp', id: webinar.event.id, rowVersion: published.rowVersion, summary: 'How to buy it.' }) as { webinar: { event: { summary: string; title: string; startsAt: string } } };
    assert.deepEqual([updated.webinar.event.title, updated.webinar.event.summary, updated.webinar.event.startsAt], ['Unregistered land', 'How to buy it.', '2026-11-25T19:00:00.000Z'], 'omitted fields keep their value');
    const list = await tools.callTool('webinars_list', { brand: 'pp' }) as { webinars: { event: { id: string } }[] };
    assert.equal(list.webinars.length, 1);
    assert.deepEqual(await tools.callTool('webinar_registrants', { brand: 'pp', id: webinar.event.id }), []);

    // The other brand's owner is not the operator: nothing of theirs is reachable, and a non-owner operator is refused.
    const bravoTools = createOperatorTools({ sessions: new OperatorSessions(loadOperatorConfig({ ...env, R72_OPERATOR_USER_ID: a.viewer.userId })!, { pp: auth, mhp: undefined }), crm, webinars, writes: true });
    await assert.rejects(bravoTools.callTool('workspace_overview', { brand: 'pp' }), /not an owner/);
    const crossTools = createOperatorTools({ sessions: new OperatorSessions(loadOperatorConfig({ ...env, R72_GROUP_HQ_CRM_PP_WORKSPACE_ID: b.ws })!, { pp: auth, mhp: undefined }), crm, webinars, writes: true });
    await assert.rejects(crossTools.callTool('webinars_list', { brand: 'pp' }), /not an owner/);
  } finally {
    await Promise.all([identityPool.end(), webPool.end(), crmPool.end(), content.end()]);
    await admin.end();
  }
});
