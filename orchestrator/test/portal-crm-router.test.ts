import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { PortalCrmService, PortalCrmRequestIdentity } from '../src/portal/crm-service.js';
import type { CrmWorkspaceSnapshot } from '../src/portal/crm-views.js';
import { handlePortal, type PortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE, portalCsrfToken, signTenant } from '../src/portal/session.js';

const SECRET = 'crm-router-secret';
const NOW = 1_000_000;
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const STAGE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_STAGE_ID = '33333333-3333-4333-8333-333333333333';
const CONTACT_ID = '44444444-4444-4444-8444-444444444444';
const OPPORTUNITY_ID = '55555555-5555-4555-8555-555555555555';
const OPEN_TASK_ID = '66666666-6666-4666-8666-666666666666';
const COMPLETE_TASK_ID = '77777777-7777-4777-8777-777777777777';
const sessionToken = signTenant(SECRET, 'legacy-t1', NOW);
const cookie = `${PORTAL_COOKIE}=${sessionToken}`;

function snapshot(): CrmWorkspaceSnapshot {
  return {
    workspace: { id: WORKSPACE_ID, name: 'Northstar Property', timezone: 'Europe/London', snapshotAt: '2026-08-23T12:00:00.000Z', canWrite: true },
    contacts: [{
      id: CONTACT_ID, displayName: 'Avery Stone', companyName: 'Stone Developments',
      primaryEmail: 'avery@example.test', lifecycle: 'lead', openOpportunityCount: 1,
      nextTaskAt: '2026-08-24T09:00:00.000Z', createdAt: '2026-08-20T09:00:00.000Z',
    }],
    stages: [
      { id: STAGE_ID, name: 'New lead', position: 1, isClosed: false },
      { id: OTHER_STAGE_ID, name: 'Qualified', position: 2, isClosed: false },
    ],
    opportunities: [{
      id: OPPORTUNITY_ID, contactId: CONTACT_ID, contactName: 'Avery Stone', title: 'Riverside acquisition',
      stageId: STAGE_ID, valueMinor: 125_000, currency: 'GBP', updatedAt: '2026-08-23T10:00:00.000Z',
      rowVersion: 2, moveCommandKey: 'move-command-1',
    }],
    tasks: [
      { id: OPEN_TASK_ID, title: 'Call Avery', status: 'open', contactName: 'Avery Stone', dueAt: '2026-08-24T09:00:00.000Z', rowVersion: 2, completeCommandKey: 'complete-command-1' },
      { id: COMPLETE_TASK_ID, title: 'Review pack', status: 'completed', contactName: 'Avery Stone', completedAt: '2026-08-22T09:00:00.000Z', rowVersion: 3, completeCommandKey: 'complete-command-2' },
    ],
    timeline: [],
  };
}

class FakeCrm implements PortalCrmService {
  identities: PortalCrmRequestIdentity[] = [];
  createCalls = 0;
  moveCalls = 0;
  completeCalls = 0;

  async snapshot(identity: PortalCrmRequestIdentity) {
    this.identities.push(identity);
    return snapshot();
  }

  async createLead() {
    this.createCalls += 1;
    return { ok: true as const, disposition: 'applied' as const };
  }

  async moveOpportunity() {
    this.moveCalls += 1;
    return { ok: true as const, disposition: 'applied' as const };
  }

  async completeTask() {
    this.completeCalls += 1;
    return { ok: true as const, disposition: 'applied' as const };
  }
}

function deps(crm?: PortalCrmService): PortalDeps {
  return {
    kind: 'legacy',
    sessionSecret: SECRET,
    secure: false,
    now: () => NOW,
    requestId: () => 'request-crm-router',
    login: async () => null,
    dashboard: async () => ({
      tenant: { id: 'legacy-t1', name: 'Northstar Property', createdAt: '2026-08-01T00:00:00.000Z' },
      contacts: [], pipeline: { lead: 0, contacted: 0, qualified: 0, won: 0, lost: 0 }, activity: [], artifacts: {},
    }),
    runTick: async () => 0,
    crm,
  };
}

function request(method: string, url: string, body?: string) {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string; headers: Record<string, string> };
  req.method = method;
  req.url = url;
  req.headers = { cookie };
  queueMicrotask(() => {
    if (body) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

function response() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(code: number, headers?: Record<string, string>) {
      this.statusCode = code;
      for (const [key, value] of Object.entries(headers ?? {})) this.headers[key.toLowerCase()] = value;
      return this;
    },
    end(body?: string) { if (body) this.body = body; },
  };
}

async function call(method: string, url: string, portal: PortalDeps, body?: string) {
  const res = response();
  await handlePortal(request(method, url, body) as never, res as never, portal);
  return res;
}

test('CRM remains truthfully locked when no durable service is composed', async () => {
  const dashboard = await call('GET', '/portal', deps());
  assert.equal(dashboard.statusCode, 200);
  assert.doesNotMatch(dashboard.body, /href="\/portal\/crm\/contacts"/);
  assert.match(dashboard.body, /CRM.*Setup/s);

  const crm = await call('GET', '/portal/crm/contacts', deps());
  assert.equal(crm.statusCode, 404);
  assert.match(crm.body, /CRM not connected/);
});

test('real CRM pages render through the authenticated service boundary and task filter links work', async () => {
  const crm = new FakeCrm();
  const contacts = await call('GET', '/portal/crm/contacts', deps(crm));
  assert.equal(contacts.statusCode, 200);
  assert.match(contacts.body, /Create lead in CRM/);
  assert.match(contacts.body, /Private CRM/);
  assert.match(contacts.body, /CRM records/);
  assert.doesNotMatch(contacts.body, /Mock workspace/);
  assert.match(contacts.body, /href="\/portal\/crm\/contacts" aria-current="page"/);
  assert.equal(crm.identities[0]?.sessionToken, sessionToken);
  assert.equal(crm.identities[0]?.requestId, 'request-crm-router');
  assert.deepEqual(Object.keys(crm.identities[0]!).sort(), ['requestId', 'sessionToken']);

  const open = await call('GET', '/portal/crm/tasks?status=open', deps(crm));
  assert.match(open.body, /Call Avery/);
  assert.doesNotMatch(open.body, /Review pack/);
  const all = await call('GET', '/portal/crm/tasks?status=all', deps(crm));
  assert.match(all.body, /Call Avery/);
  assert.match(all.body, /Review pack/);
  const completed = await call('GET', '/portal/crm/tasks?status=completed', deps(crm));
  assert.doesNotMatch(completed.body, /Call Avery/);
  assert.match(completed.body, /Review pack/);
});

test('CRM mutations require a session-bound CSRF token and redirect with signed notices', async () => {
  const crm = new FakeCrm();
  const invalid = await call('POST', '/portal/crm/leads', deps(crm), '_csrf=forged&command_key=lead-1');
  assert.equal(invalid.statusCode, 403);
  assert.equal(crm.createCalls, 0);

  const csrf = portalCsrfToken(SECRET, sessionToken);
  const body = new URLSearchParams({
    _csrf: csrf,
    command_key: 'lead-command-1',
    display_name: 'Ada Lovelace',
    email: 'ada@example.test',
    opportunity_title: 'Website relaunch',
    stage_id: STAGE_ID,
  }).toString();
  const created = await call('POST', '/portal/crm/leads', deps(crm), body);
  assert.equal(created.statusCode, 302);
  assert.match(created.headers.location ?? '', /^\/portal\/crm\/contacts\?notice=created\./);
  assert.equal(crm.createCalls, 1);

  const confirmed = await call('GET', created.headers.location!, deps(crm));
  assert.match(confirmed.body, /Lead saved/);
  const forged = await call('GET', '/portal/crm/contacts?created=1&notice=created.forged', deps(crm));
  assert.doesNotMatch(forged.body, /Lead saved/);
});

test('pipeline and task commands route only canonical IDs through CSRF-protected POSTs', async () => {
  const crm = new FakeCrm();
  const csrf = portalCsrfToken(SECRET, sessionToken);
  const move = await call('POST', `/portal/crm/opportunities/${OPPORTUNITY_ID}/stage`, deps(crm), new URLSearchParams({
    _csrf: csrf, command_key: 'move-command-1', target_stage_id: OTHER_STAGE_ID, expected_version: '2',
  }).toString());
  assert.equal(move.statusCode, 302);
  assert.match(move.headers.location ?? '', /^\/portal\/crm\/opportunities\?notice=moved\./);
  assert.equal(crm.moveCalls, 1);

  const complete = await call('POST', `/portal/crm/tasks/${OPEN_TASK_ID}/complete`, deps(crm), new URLSearchParams({
    _csrf: csrf, command_key: 'complete-command-1', expected_version: '2',
  }).toString());
  assert.equal(complete.statusCode, 302);
  assert.match(complete.headers.location ?? '', /^\/portal\/crm\/tasks\?notice=completed\./);
  assert.equal(crm.completeCalls, 1);

  const invalid = await call('POST', '/portal/crm/tasks/not-an-id/complete', deps(crm), `_csrf=${encodeURIComponent(csrf)}`);
  assert.equal(invalid.statusCode, 404);
  assert.equal(crm.completeCalls, 1);
});

test('a missing CRM mapping never destroys the still-valid legacy portal login', async () => {
  const crm: PortalCrmService = {
    snapshot: async () => null,
    createLead: async () => ({ ok: false, kind: 'forbidden', message: 'no mapping' }),
    moveOpportunity: async () => ({ ok: false, kind: 'forbidden', message: 'no mapping' }),
    completeTask: async () => ({ ok: false, kind: 'forbidden', message: 'no mapping' }),
  };
  const res = await call('GET', '/portal/crm/contacts', deps(crm));
  assert.equal(res.statusCode, 403);
  assert.match(res.body, /no longer has access to the durable CRM workspace/);
  assert.match(res.body, /Skip to main content/);
  assert.equal(res.headers['set-cookie'], undefined);
});
