import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import {
  operatorActionNoticeToken,
  operatorActionSnoozeChoiceToken,
  type OperatorActionNoticeCode,
} from '../src/portal/operator-action-centre-actions.js';
import type {
  PgOperatorActionCentreSnapshot,
  PortalOperatorActionAssignmentInput,
  PortalOperatorActionCentreService,
  PortalOperatorActionCommandOutcome,
  PortalOperatorActionSnoozeInput,
} from '../src/portal/operator-action-centre-pg-service.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE, portalCsrfToken } from '../src/portal/session.js';

const SECRET = 'operator-action-router-secret';
const NOW = Date.parse('2026-08-26T15:30:00.000Z');
const SESSION = Buffer.alloc(32, 29).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const WORKSPACE_ID = '70000000-0000-4000-8000-000000000001';
const USER_ID = '71000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '72000000-0000-4000-8000-000000000001';
const SOURCE_ID = '73000000-0000-4000-8000-000000000001';
const ACTION_ID = `crm.task:${SOURCE_ID}`;
const COMMAND_KEY = '74000000-0000-4000-8000-000000000001';

const auth: PortalAuthService = {
  resolve: async (token) => token === SESSION ? {
    sessionToken: token,
    userId: USER_ID,
    userEmail: 'owner@propertypredator.test',
    workspaceId: WORKSPACE_ID,
  } : null,
  login: async () => null,
  revoke: async () => undefined,
};

const crm: PortalCrmService = {
  snapshot: async () => ({
    workspace: {
      id: WORKSPACE_ID,
      name: 'Property Predator Growth HQ',
      timezone: 'Europe/London',
      snapshotAt: '2026-08-26T15:30:00.000Z',
      canWrite: true,
    },
    contacts: [], stages: [], opportunities: [], tasks: [], timeline: [],
  }),
  createLead: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  moveOpportunity: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  completeTask: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
};

function authoritativeSnapshot(): PgOperatorActionCentreSnapshot {
  return {
    workspaceId: WORKSPACE_ID,
    workspaceName: 'Property Predator Growth HQ',
    asOf: '2026-08-26T15:30:00.000Z',
    environment: 'production',
    datasetKind: 'postgres_authoritative',
    currentUserId: USER_ID,
    canWrite: true,
    canManage: true,
    canAssign: true,
    commandBoundaryAvailable: true,
    assignableMembers: [
      { userId: USER_ID, displayName: 'Founder Operator', role: 'owner' },
      { userId: OTHER_USER_ID, displayName: 'Sales Operator', role: 'sales' },
    ],
    membersTruncated: false,
    inputTruncated: false,
    actions: [{
      actionId: ACTION_ID,
      actionKind: 'crm.task',
      sourceReference: SOURCE_ID,
      source: 'crm',
      priority: 'p1',
      status: 'open',
      title: 'Call the hot acquisition lead',
      detail: 'A measured CRM task is overdue and still open.',
      ownerLabel: null,
      ownerTeam: 'Acquisitions',
      assignedUserId: null,
      assignmentOverridden: false,
      relatedPersonLabel: 'Avery Stone',
      signalLabel: 'CRM due time passed',
      createdAt: '2026-08-25T12:00:00.000Z',
      dueAt: '2026-08-26T14:30:00.000Z',
      blockedBy: null,
      deepLink: '/portal/crm/tasks?status=open',
      deepLinkLabel: 'Open the CRM task queue',
      evidence: {
        label: 'Open CRM task',
        detail: 'Status open; due at 26 Aug 14:30 UTC.',
        truth: 'measured',
        evidenceRef: `crm_task:${SOURCE_ID}:version:3`,
        observedAt: '2026-08-26T15:30:00.000Z',
      },
      rowVersion: 7,
      sourceRowVersion: 3,
      snoozedUntil: null,
      canSnooze: true,
      canAssign: true,
    }],
  };
}

class FakeOperatorActions implements PortalOperatorActionCentreService {
  snapshotCalls: unknown[] = [];
  snoozeCalls: Array<Readonly<{ identity: unknown; input: PortalOperatorActionSnoozeInput }>> = [];
  assignmentCalls: Array<Readonly<{ identity: unknown; input: PortalOperatorActionAssignmentInput }>> = [];
  snoozeOutcome: PortalOperatorActionCommandOutcome = {
    ok: true, disposition: 'applied', changed: true, rowVersion: 8,
  };
  assignmentOutcome: PortalOperatorActionCommandOutcome = {
    ok: true, disposition: 'applied', changed: true, rowVersion: 8,
  };
  throwOnSnooze = false;
  throwOnAssignment = false;

  async snapshot(identity: unknown, options?: unknown) {
    this.snapshotCalls.push({ identity, options });
    return authoritativeSnapshot();
  }

  async snoozeAction(identity: unknown, input: PortalOperatorActionSnoozeInput) {
    this.snoozeCalls.push({ identity, input });
    if (this.throwOnSnooze) throw new Error('simulated command outage');
    return this.snoozeOutcome;
  }

  async assignAction(identity: unknown, input: PortalOperatorActionAssignmentInput) {
    this.assignmentCalls.push({ identity, input });
    if (this.throwOnAssignment) throw new Error('simulated command outage');
    return this.assignmentOutcome;
  }
}

function postgres(over: Partial<PostgresPortalDeps> = {}): PostgresPortalDeps {
  return {
    kind: 'postgres',
    sessionSecret: SECRET,
    secure: false,
    now: () => NOW,
    requestId: () => 'operator-action-router-request',
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    auth,
    crm,
    ...over,
  };
}

function request(method: 'GET' | 'POST', url: string, body: string, cookie?: string) {
  const req = new EventEmitter() as EventEmitter & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = method;
  req.url = url;
  req.headers = {
    ...(cookie ? { cookie } : {}),
    ...(method === 'POST' ? {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(body)),
    } : {}),
  };
  setImmediate(() => {
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
    writeHead(code: number, headers?: Record<string, string | string[]>) {
      this.statusCode = code;
      for (const [key, value] of Object.entries(headers ?? {})) {
        this.headers[key.toLowerCase()] = Array.isArray(value) ? value.join('\n') : value;
      }
      return this;
    },
    end(body?: string) { if (body) this.body = body; },
  };
}

async function call(
  method: 'GET' | 'POST',
  url: string,
  deps: PostgresPortalDeps,
  fields: Readonly<Record<string, string>> = {},
  cookie?: string,
) {
  const body = method === 'POST' ? new URLSearchParams(fields).toString() : '';
  const res = response();
  await handlePortal(request(method, url, body, cookie) as never, res as never, deps);
  return res;
}

function commandFields(over: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
  return {
    _csrf: portalCsrfToken(SECRET, SESSION),
    command_key: COMMAND_KEY,
    expected_row_version: '7',
    ...over,
  };
}

function noticeLocation(code: OperatorActionNoticeCode): string {
  const notice = operatorActionNoticeToken(SECRET, SESSION, code);
  return `/portal/actions?notice=${encodeURIComponent(notice)}`;
}

test('Action Centre redirects unauthenticated requests and fails closed when its service is absent', async () => {
  const operatorActions = new FakeOperatorActions();
  const unauthenticated = await call('GET', '/portal/actions', postgres({ operatorActions }));
  assert.equal(unauthenticated.statusCode, 302);
  assert.equal(unauthenticated.headers.location, '/portal/login');
  assert.equal(operatorActions.snapshotCalls.length, 0);

  const missing = await call('GET', '/portal/actions', postgres(), {}, COOKIE);
  assert.equal(missing.statusCode, 404);
  assert.match(missing.body, /Action Centre not connected/);
  assert.match(missing.body, /protected workspace action queue is not enabled/);
  assert.doesNotMatch(missing.body, /href="\/portal\/actions" aria-current="page"/);
});

test('Action Centre renders the authoritative PostgreSQL queue and active Property Predator navigation', async () => {
  const operatorActions = new FakeOperatorActions();
  const result = await call('GET', '/portal/actions', postgres({ operatorActions }), {}, COOKIE);

  assert.equal(result.statusCode, 200);
  assert.match(result.body, /data-dataset-kind="postgres_authoritative"/);
  assert.match(result.body, /data-environment="production"/);
  assert.match(result.body, /data-command-boundary="ready"/);
  assert.match(result.body, /Call the hot acquisition lead/);
  assert.match(result.body, /Measured workspace facts/);
  assert.match(result.body, /<a class="nav-item" href="\/portal\/actions" aria-current="page">/);
  assert.match(result.body, new RegExp(`/portal/actions/${encodeURIComponent(ACTION_ID)}/assignment`));
  assert.match(result.body, new RegExp(`/portal/actions/${encodeURIComponent(ACTION_ID)}/snooze`));
  assert.doesNotMatch(result.body, /FICTIONAL FIXTURE|Operationally shaped TEST data only/);
  assert.doesNotMatch(result.body, />Complete</);
  assert.deepEqual(operatorActions.snapshotCalls, [{
    identity: { sessionToken: SESSION, requestId: 'operator-action-router-request' },
    options: { limit: 60 },
  }]);
});

test('bad CSRF and malformed command keys redirect safely without calling a command service', async () => {
  const operatorActions = new FakeOperatorActions();
  const route = `/portal/actions/${encodeURIComponent(ACTION_ID)}/snooze`;

  const forgedCsrf = await call('POST', route, postgres({ operatorActions }), commandFields({
    _csrf: 'forged-csrf',
    minutes: '60',
  }), COOKIE);
  assert.equal(forgedCsrf.statusCode, 303);
  assert.equal(forgedCsrf.headers.location, noticeLocation('invalid'));

  const malformedKey = await call('POST', route, postgres({ operatorActions }), commandFields({
    command_key: 'not-a-uuid',
    minutes: '60',
  }), COOKIE);
  assert.equal(malformedKey.statusCode, 303);
  assert.equal(malformedKey.headers.location, noticeLocation('invalid'));

  const malformedVersion = await call('POST', route, postgres({ operatorActions }), commandFields({
    expected_row_version: '-1',
    minutes: '60',
  }), COOKIE);
  assert.equal(malformedVersion.statusCode, 303);
  assert.equal(malformedVersion.headers.location, noticeLocation('invalid'));
  assert.equal(operatorActions.snoozeCalls.length, 0);
  assert.equal(operatorActions.assignmentCalls.length, 0);
});

test('signed absolute snooze choices are retry-stable and forged provenance is ignored', async () => {
  const operatorActions = new FakeOperatorActions();
  const route = `/portal/actions/${encodeURIComponent(ACTION_ID)}/snooze`;

  for (const minutes of [60, 240, 1_440]) {
    const snoozedUntil = new Date(NOW + minutes * 60_000).toISOString();
    const choice = operatorActionSnoozeChoiceToken(
      SECRET, SESSION, ACTION_ID, COMMAND_KEY, snoozedUntil,
    );
    const result = await call('POST', route, postgres({ operatorActions }), commandFields({
      snooze_choice: choice,
      snoozed_until: '2099-01-01T00:00:00.000Z',
      workspace_id: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
      source_kind: 'provider',
      source_reference: 'forged-browser-reference',
      action_id: 'provider:forged',
    }), COOKIE);
    assert.equal(result.statusCode, 303);
    assert.equal(result.headers.location, noticeLocation('snoozed'));
  }

  const retryInstant = new Date(NOW + 60 * 60_000).toISOString();
  const retryChoice = operatorActionSnoozeChoiceToken(
    SECRET, SESSION, ACTION_ID, COMMAND_KEY, retryInstant,
  );
  operatorActions.snoozeOutcome = {
    ok: true, disposition: 'replayed', changed: false, rowVersion: 8,
  };
  const retry = await call('POST', route, postgres({
    operatorActions,
    now: () => NOW + 30 * 60_000,
  }), commandFields({ snooze_choice: retryChoice }), COOKIE);
  assert.equal(retry.headers.location, noticeLocation('replayed'));

  const expectedCalls = [60, 240, 1_440, 60].map((minutes) => ({
    identity: { sessionToken: SESSION, requestId: 'operator-action-router-request' },
    input: {
      actionId: ACTION_ID,
      commandKey: COMMAND_KEY,
      expectedRowVersion: 7,
      snoozedUntil: new Date(NOW + minutes * 60_000).toISOString(),
    },
  }));
  assert.deepEqual(operatorActions.snoozeCalls, expectedCalls);
  for (const call of operatorActions.snoozeCalls) {
    assert.deepEqual(Object.keys(call.input).sort(), [
      'actionId', 'commandKey', 'expectedRowVersion', 'snoozedUntil',
    ]);
  }

  const invalidChoice = await call('POST', route, postgres({ operatorActions }), commandFields({
    snooze_choice: `${retryChoice.slice(0, -1)}${retryChoice.endsWith('A') ? 'B' : 'A'}`,
  }), COOKIE);
  assert.equal(invalidChoice.headers.location, noticeLocation('invalid'));
  assert.equal(operatorActions.snoozeCalls.length, 4);
});

test('assignment and release forward only the route identity and protected operator fields', async () => {
  const operatorActions = new FakeOperatorActions();
  const route = `/portal/actions/${encodeURIComponent(ACTION_ID)}/assignment`;
  const forged = {
    workspace_id: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
    source_kind: 'provider',
    source_reference: 'forged-browser-reference',
    action_id: 'provider:forged',
  };

  const assigned = await call('POST', route, postgres({ operatorActions }), commandFields({
    assigned_user_id: OTHER_USER_ID.toUpperCase(),
    ...forged,
  }), COOKIE);
  assert.equal(assigned.statusCode, 303);
  assert.equal(assigned.headers.location, noticeLocation('assigned'));

  const released = await call('POST', route, postgres({ operatorActions }), commandFields({
    assigned_user_id: '   ',
    ...forged,
  }), COOKIE);
  assert.equal(released.statusCode, 303);
  assert.equal(released.headers.location, noticeLocation('released'));

  assert.deepEqual(operatorActions.assignmentCalls, [{
    identity: { sessionToken: SESSION, requestId: 'operator-action-router-request' },
    input: {
      actionId: ACTION_ID,
      commandKey: COMMAND_KEY,
      expectedRowVersion: 7,
      assignedUserId: OTHER_USER_ID,
    },
  }, {
    identity: { sessionToken: SESSION, requestId: 'operator-action-router-request' },
    input: {
      actionId: ACTION_ID,
      commandKey: COMMAND_KEY,
      expectedRowVersion: 7,
      assignedUserId: null,
    },
  }]);
  for (const call of operatorActions.assignmentCalls) {
    assert.deepEqual(Object.keys(call.input).sort(), [
      'actionId', 'assignedUserId', 'commandKey', 'expectedRowVersion',
    ]);
  }
});

test('command outcomes produce signed redirects and user-facing notices', async (t) => {
  const cases: ReadonlyArray<Readonly<{
    outcome: PortalOperatorActionCommandOutcome | 'throw';
    code: OperatorActionNoticeCode;
    title: RegExp;
  }>> = [
    { outcome: { ok: true, disposition: 'replayed', changed: false, rowVersion: 8 }, code: 'replayed', title: /Safe replay confirmed/ },
    { outcome: { ok: false, kind: 'forbidden', message: 'no' }, code: 'forbidden', title: /Action access required/ },
    { outcome: { ok: false, kind: 'conflict', message: 'stale' }, code: 'conflict', title: /Queue conflict protected/ },
    { outcome: { ok: false, kind: 'not_found', message: 'gone' }, code: 'missing', title: /Action no longer active/ },
    { outcome: { ok: false, kind: 'validation', message: 'invalid' }, code: 'invalid', title: /Action rejected safely/ },
    { outcome: { ok: false, kind: 'unavailable', message: 'down' }, code: 'unavailable', title: /Action Centre unavailable/ },
    { outcome: 'throw', code: 'unavailable', title: /Action Centre unavailable/ },
  ];

  for (const item of cases) await t.test(item.code + (item.outcome === 'throw' ? '-throw' : ''), async () => {
    const operatorActions = new FakeOperatorActions();
    if (item.outcome === 'throw') operatorActions.throwOnAssignment = true;
    else operatorActions.assignmentOutcome = item.outcome;
    const route = `/portal/actions/${encodeURIComponent(ACTION_ID)}/assignment`;
    const result = await call('POST', route, postgres({ operatorActions }), commandFields({
      assigned_user_id: OTHER_USER_ID,
    }), COOKIE);
    assert.equal(result.statusCode, 303);
    assert.equal(result.headers.location, noticeLocation(item.code));

    const noticePage = await call('GET', result.headers.location, postgres({ operatorActions }), {}, COOKIE);
    assert.equal(noticePage.statusCode, 200);
    assert.match(noticePage.body, item.title);
  });
});
