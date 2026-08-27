import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type {
  PortalCrmService,
  PortalCrmMutationOutcome,
  PortalCrmRequestIdentity,
  PortalCrmSnapshotRequest,
  PortalJourneyBoardFilters,
  PortalJourneyBoardSnapshot,
} from '../src/portal/crm-service.js';
import {
  PgPortalCrmService,
  type PgPortalCrmDependencies,
} from '../src/portal/crm-pg-service.js';
import type { CrmWorkspaceSnapshot } from '../src/portal/crm-views.js';
import type { Lead360View } from '../src/portal/lead-360-view.js';
import { handlePortal, type PortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE, portalCsrfToken, signTenant } from '../src/portal/session.js';

const SECRET = 'crm-router-secret';
const NOW = 1_000_000;
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CURSOR_SECRET = 'server-only-crm-cursor-secret-for-tests-123456';
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
  snapshotRequests: Array<PortalCrmSnapshotRequest | undefined> = [];
  snapshotCalls = 0;
  createCalls = 0;
  moveCalls = 0;
  completeCalls = 0;
  lead360Calls: string[] = [];
  journeyBoardCalls: PortalJourneyBoardFilters[] = [];
  moveOutcome: PortalCrmMutationOutcome = { ok: true, disposition: 'applied' };

  async snapshot(identity: PortalCrmRequestIdentity, request?: PortalCrmSnapshotRequest) {
    this.snapshotCalls += 1;
    this.identities.push(identity);
    this.snapshotRequests.push(request);
    return snapshot();
  }

  async createLead() {
    this.createCalls += 1;
    return { ok: true as const, disposition: 'applied' as const };
  }

  async moveOpportunity(): Promise<PortalCrmMutationOutcome> {
    this.moveCalls += 1;
    return this.moveOutcome;
  }

  async completeTask() {
    this.completeCalls += 1;
    return { ok: true as const, disposition: 'applied' as const };
  }

  async lead360(_identity: PortalCrmRequestIdentity, contactId: string): Promise<Lead360View | null> {
    this.lead360Calls.push(contactId);
    if (contactId !== CONTACT_ID) return null;
    return {
      identity: {
        contactId, displayName: 'Avery <Stone>', companyName: 'Stone Developments',
        primaryEmail: 'avery@example.test', primaryPhone: null, ownerName: 'Assigned workspace member',
      },
      score: 76,
      scoreExplanation: 'Watched 92% · requested contact',
      journey: {
        label: 'Agency LAPS',
        stages: [
          { key: 'lead', label: 'Lead', state: 'complete', reachedAt: '2026-08-20T09:00:00.000Z' },
          { key: 'appointment', label: 'Appointment', state: 'current', reachedAt: '2026-08-23T10:00:00.000Z' },
        ],
      },
      evidence: [{
        id: '88888888-8888-4888-8888-888888888888', kind: 'watched', title: 'Predator <Briefing>',
        detail: '92% complete', percentage: 92, occurredAt: '2026-08-23T10:00:00.000Z', sourceLabel: 'Content · video',
      }],
      nextMove: { label: 'Review personally', reason: 'Latest verified signal.', dueAt: null },
      offers: [], consent: [], suppressionReason: null,
      crm: { opportunities: [], tasks: [] },
      asOf: '2026-08-23T12:00:00.000Z',
    };
  }

  async journeyBoard(
    _identity: PortalCrmRequestIdentity,
    filters: PortalJourneyBoardFilters = {},
  ): Promise<PortalJourneyBoardSnapshot> {
    this.journeyBoardCalls.push(filters);
    return {
      workspace: { name: 'Northstar Property', asOf: '2026-08-25T12:00:00.000Z', timezone: 'Europe/London', canWrite: true },
      filters: {
        query: filters.query ?? '', route: filters.route ?? '', band: filters.band ?? '',
        routes: [{ value: 'property-predator-agency-laps', label: 'Agency LAPS' }],
        bands: [{ value: 'hot', label: 'Hot' }],
      },
      lanes: [
        { id: STAGE_ID, label: 'New lead', description: 'Team workflow queue.', position: 1, cardCount: 1, totalCardCount: 1, attentionCount: 1, isClosed: false, isPartial: false },
        { id: OTHER_STAGE_ID, label: 'Qualified', description: 'Team workflow queue.', position: 2, cardCount: 0, totalCardCount: 0, attentionCount: 0, isClosed: false, isPartial: false },
      ],
      cards: [{
        id: OPPORTUNITY_ID, contactId: CONTACT_ID, laneId: STAGE_ID, displayName: 'Avery Stone',
        companyName: 'Stone Developments', ownerName: 'Assigned workspace member', score: 52, scoreBand: 'hot',
        sourceLabel: 'LinkedIn', affiliateLabel: 'PP-AVERY',
        journey: {
          routeKey: 'property-predator-agency-laps', routeLabel: 'Agency LAPS', stageKey: 'appointment',
          stageLabel: 'Appointment', stageSemantic: 'appointment', lastAdvancedAt: '2026-08-25T10:00:00.000Z',
          stageAutomatic: true, otherJourneyCount: 1, paymentVerifiedSale: false,
        },
        latestSignal: {
          kind: 'appointment', label: 'Appointment booked', detail: 'Strategy call',
          occurredAt: '2026-08-25T10:00:00.000Z', progressPercent: null, automatic: true,
        },
        offer: null,
        nextMove: { label: 'Prepare the call', dueAt: '2026-08-25T13:00:00.000Z', dueState: 'due' },
        move: { commandKey: 'board-move-command-1', expectedVersion: 2, allowedLaneIds: [STAGE_ID, OTHER_STAGE_ID] },
      }],
      coverage: { loadedCardCount: 1, totalCardCount: 1, perLaneCardLimit: 75, partial: false },
    };
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
  assert.match(contacts.body, /Private workspace/);
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
  assert.deepEqual(crm.snapshotRequests, [
    { section: 'contacts' },
    { section: 'tasks', filter: 'open' },
    { section: 'tasks', filter: 'all' },
    { section: 'tasks', filter: 'completed' },
  ]);
});

test('CRM list routes reject ambiguous cursors and invalid task filters before entering the service', async () => {
  const crm = new FakeCrm();
  const duplicateCursor = await call(
    'GET',
    '/portal/crm/contacts?after=one&after=two',
    deps(crm),
  );
  assert.equal(duplicateCursor.statusCode, 400);
  assert.match(duplicateCursor.body, /CRM page link expired/);

  const duplicateStatus = await call(
    'GET',
    '/portal/crm/tasks?status=open&status=all',
    deps(crm),
  );
  assert.equal(duplicateStatus.statusCode, 400);

  const invalidStatus = await call('GET', '/portal/crm/tasks?status=cancelled', deps(crm));
  assert.equal(invalidStatus.statusCode, 400);
  assert.equal(crm.snapshotCalls, 0);
});

test('Live Journey Board renders real people, serves fixed enhancement code and moves only the CRM workflow lane', async () => {
  const crm = new FakeCrm();
  const board = await call('GET', '/portal/journeys/board?q=Avery&route=property-predator-agency-laps&band=hot', deps(crm));
  assert.equal(board.statusCode, 200);
  assert.match(board.body, /People moving\. <em>Evidence proving why\.<\/em>/);
  assert.match(board.body, /Avery Stone/);
  assert.match(board.body, /AUTO/);
  assert.match(board.body, /Dragging changes the team workflow lane only/);
  assert.match(board.body, /name="target_lane_id"/);
  assert.match(board.body, /name="return_q" value="Avery"/);
  assert.match(board.body, /name="return_route" value="property-predator-agency-laps"/);
  assert.match(board.body, /name="return_band" value="hot"/);
  assert.match(board.body, /src="\/portal\/assets\/journey-board\.js"/);
  assert.match(board.headers['content-security-policy'] ?? '', /script-src 'self'/);
  assert.match(board.headers['content-security-policy'] ?? '', /connect-src 'self'/);
  assert.deepEqual(crm.journeyBoardCalls, [{
    query: 'Avery', route: 'property-predator-agency-laps', band: 'hot',
  }]);

  const asset = await call('GET', '/portal/assets/journey-board.js', deps());
  assert.equal(asset.statusCode, 200);
  assert.match(asset.headers['content-type'] ?? '', /^text\/javascript/);
  assert.equal(asset.headers['cache-control'], 'no-cache, max-age=0, must-revalidate');
  assert.match(asset.body, /data-drag-handle/);
  assert.doesNotMatch(asset.body, /sessionToken|cookie\s*=/i);

  const forged = await call('POST', `/portal/journeys/board/opportunities/${OPPORTUNITY_ID}/stage`, deps(crm), new URLSearchParams({
    _csrf: 'forged', command_key: 'board-move-command-1', target_lane_id: OTHER_STAGE_ID, expected_version: '2',
  }).toString());
  assert.equal(forged.statusCode, 403);
  assert.equal(crm.moveCalls, 0);

  const csrf = portalCsrfToken(SECRET, sessionToken);
  const moved = await call('POST', `/portal/journeys/board/opportunities/${OPPORTUNITY_ID}/stage`, deps(crm), new URLSearchParams({
    _csrf: csrf, command_key: 'board-move-command-1', target_lane_id: OTHER_STAGE_ID, expected_version: '2',
    return_q: 'Avery & team', return_route: 'property-predator-agency-laps', return_band: 'hot',
  }).toString());
  assert.equal(moved.statusCode, 303);
  assert.match(moved.headers.location ?? '', /^\/portal\/journeys\/board\?notice=moved\./);
  const movedLocation = new URL(moved.headers.location!, 'https://portal.example');
  assert.equal(movedLocation.searchParams.get('q'), 'Avery & team');
  assert.equal(movedLocation.searchParams.get('route'), 'property-predator-agency-laps');
  assert.equal(movedLocation.searchParams.get('band'), 'hot');
  assert.equal(crm.moveCalls, 1);

  const conflictCrm = new FakeCrm();
  conflictCrm.moveOutcome = { ok: false, kind: 'conflict', message: 'The card changed.' };
  const conflict = await call('POST', `/portal/journeys/board/opportunities/${OPPORTUNITY_ID}/stage`, deps(conflictCrm), new URLSearchParams({
    _csrf: csrf, command_key: 'board-move-command-1', target_lane_id: OTHER_STAGE_ID, expected_version: '2',
    return_q: 'Avery', return_route: 'property-predator-agency-laps', return_band: 'hot',
  }).toString());
  assert.equal(conflict.statusCode, 303);
  const conflictLocation = new URL(conflict.headers.location!, 'https://portal.example');
  assert.match(conflictLocation.searchParams.get('notice') ?? '', /^conflict\./);
  assert.equal(conflictLocation.searchParams.get('q'), 'Avery');
  assert.equal(conflictLocation.searchParams.get('route'), 'property-predator-agency-laps');
  assert.equal(conflictLocation.searchParams.get('band'), 'hot');

  const invalidReturn = await call('POST', `/portal/journeys/board/opportunities/${OPPORTUNITY_ID}/stage`, deps(new FakeCrm()), new URLSearchParams({
    _csrf: csrf, command_key: 'board-move-command-1', target_lane_id: OTHER_STAGE_ID, expected_version: '2',
    return_q: `A${'x'.repeat(121)}`, return_route: 'https://outside.example/', return_band: 'vip',
  }).toString());
  const invalidLocation = new URL(invalidReturn.headers.location!, 'https://portal.example');
  assert.equal(invalidLocation.searchParams.has('q'), false);
  assert.equal(invalidLocation.searchParams.has('route'), false);
  assert.equal(invalidLocation.searchParams.has('band'), false);
});

test('Lead 360 route renders one read-only RLS case file and rejects malformed or invisible contacts', async () => {
  const crm = new FakeCrm();
  const found = await call('GET', `/portal/crm/contacts/${CONTACT_ID}`, deps(crm));
  assert.equal(found.statusCode, 200);
  assert.match(found.body, /Lead 360 · Evidence case file/);
  assert.match(found.body, /Avery &lt;Stone&gt;/);
  assert.match(found.body, /Predator &lt;Briefing&gt;/);
  assert.doesNotMatch(found.body, /Send message|Publish post/i);
  assert.deepEqual(crm.lead360Calls, [CONTACT_ID]);
  assert.equal(crm.snapshotCalls, 1, 'legacy adapters without workspaceShell keep the snapshot fallback');

  const malformed = await call('GET', '/portal/crm/contacts/not-a-uuid', deps(crm));
  assert.equal(malformed.statusCode, 404);
  assert.deepEqual(crm.lead360Calls, [CONTACT_ID], 'malformed IDs never enter the service');
  assert.equal(crm.snapshotCalls, 1);

  const invisible = await call('GET', '/portal/crm/contacts/99999999-9999-4999-8999-999999999999', deps(crm));
  assert.equal(invisible.statusCode, 404);
  assert.match(invisible.body, /No RLS-visible contact exists/);
  assert.equal(crm.snapshotCalls, 2);
});

test('Pg-backed Lead 360 route reads only workspace shell context and the contact case file', async () => {
  let commandContextReads = 0;
  let fullSnapshotReads = 0;
  let leadReads = 0;
  const crm = new PgPortalCrmService({
    cursorSecret: CURSOR_SECRET,
    principalResolver: { resolve: async () => ({ userId: '88888888-8888-4888-8888-888888888888', workspaceId: WORKSPACE_ID }) },
    readService: {
      loadWorkspaceCommandContext: async () => {
        commandContextReads += 1;
        return {
          id: WORKSPACE_ID,
          name: 'Northstar Property',
          timezone: 'Europe/London',
          currency: 'GBP',
          snapshotAt: '2026-08-23T12:00:00.000Z',
          defaultPipelineId: null,
          canWrite: true,
        };
      },
      loadWorkspaceSnapshot: async () => {
        fullSnapshotReads += 1;
        throw new Error('Lead 360 route must not load a full CRM snapshot');
      },
    },
    lead360ReadService: {
      load: async () => {
        leadReads += 1;
        return {
          workspaceId: WORKSPACE_ID,
          contactId: CONTACT_ID,
          asOf: '2026-08-23T12:00:00.000Z',
          identity: {
            contactId: CONTACT_ID,
            displayName: 'Narrow Avery',
            companyName: null,
            primaryEmail: null,
            primaryPhone: null,
            lifecycle: 'lead' as const,
            ownerUserId: null,
            createdAt: '2026-08-20T09:00:00.000Z',
            updatedAt: '2026-08-23T11:00:00.000Z',
          },
          journey: null,
          score: null,
          evidence: [],
          offers: [],
          consent: [],
          crm: { opportunities: [], tasks: [] },
        };
      },
    },
    commandService: {} as PgPortalCrmDependencies['commandService'],
  });

  const found = await call('GET', `/portal/crm/contacts/${CONTACT_ID}`, deps(crm));
  assert.equal(found.statusCode, 200);
  assert.match(found.body, /Narrow Avery/);
  assert.equal(commandContextReads, 1);
  assert.equal(leadReads, 1);
  assert.equal(fullSnapshotReads, 0);
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
