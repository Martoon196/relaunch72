import assert from 'node:assert/strict';
import test from 'node:test';
import {
  operatorActionNoticeFromQuery,
  operatorActionNoticeToken,
  operatorActionSnoozeChoiceToken,
  operatorActionSnoozeInstantFromToken,
} from '../src/portal/operator-action-centre-actions.js';
import {
  presentOperatorActionCentre,
  type OperatorActionCentreSnapshot,
  type OperatorActionSnapshot,
} from '../src/portal/operator-action-centre-presenter.js';
import { renderOperatorActionCentreBody } from '../src/portal/operator-action-centre-view.js';

const CURRENT_USER_ID = '10000000-0000-4000-8000-000000000001';
const SECOND_USER_ID = '10000000-0000-4000-8000-000000000002';

function authoritativeAction(overrides: Partial<OperatorActionSnapshot> = {}): OperatorActionSnapshot {
  return {
    actionId: 'crm_task:20000000-0000-4000-8000-000000000001',
    actionKind: 'crm_task_due',
    sourceReference: '20000000-0000-4000-8000-000000000001',
    source: 'crm',
    priority: 'p1',
    status: 'open',
    title: 'Call the warm prospect',
    detail: 'The next consented follow-up is due.',
    ownerLabel: 'Martin O’Connell',
    ownerTeam: 'Sales',
    relatedPersonLabel: 'Aisha Rahman',
    signalLabel: 'Open CRM task is inside its action window',
    createdAt: '2026-08-26T08:00:00.000Z',
    dueAt: '2026-08-26T11:00:00.000Z',
    blockedBy: null,
    deepLink: '/portal/crm/tasks?status=open',
    deepLinkLabel: 'Open CRM task queue',
    evidence: {
      label: 'CRM task ledger',
      detail: 'Open task and due time measured from PostgreSQL',
      truth: 'measured',
      evidenceRef: 'crm_task:20000000-0000-4000-8000-000000000001:v3',
      observedAt: '2026-08-26T10:00:00.000Z',
    },
    rowVersion: 7,
    sourceRowVersion: 3,
    assignedUserId: CURRENT_USER_ID,
    assignmentOverridden: false,
    snoozedUntil: null,
    canSnooze: true,
    canAssign: true,
    ...overrides,
  };
}

function authoritativeSnapshot(
  overrides: Partial<OperatorActionCentreSnapshot> = {},
): OperatorActionCentreSnapshot {
  return {
    workspaceId: '30000000-0000-4000-8000-000000000001',
    workspaceName: 'Property Predator Growth HQ',
    asOf: '2026-08-26T10:00:00.000Z',
    environment: 'production',
    datasetKind: 'postgres_authoritative',
    currentUserId: CURRENT_USER_ID,
    canWrite: true,
    canManage: true,
    canAssign: true,
    commandBoundaryAvailable: true,
    assignableMembers: [
      { userId: CURRENT_USER_ID, displayName: 'Martin O’Connell', role: 'owner' },
      { userId: SECOND_USER_ID, displayName: 'Sam Jones', role: 'sales' },
    ],
    actions: [authoritativeAction()],
    ...overrides,
  };
}

interface RenderedForm {
  readonly attributes: string;
  readonly body: string;
  readonly action: string;
  readonly method: string;
  readonly fieldNames: readonly string[];
}

function renderedForms(html: string): readonly RenderedForm[] {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map((match) => {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    return {
      attributes,
      body,
      action: /\baction="([^"]*)"/.exec(attributes)?.[1] ?? '',
      method: /\bmethod="([^"]*)"/.exec(attributes)?.[1] ?? '',
      fieldNames: [...body.matchAll(/\bname="([^"]+)"/g)].map((field) => field[1] ?? ''),
    };
  });
}

const SECURITY = Object.freeze({
  csrfToken: 'csrf-token-for-this-session',
  snoozeCommandKeys: Object.freeze({
    'crm_task:20000000-0000-4000-8000-000000000001': 'snooze-command-key',
  }),
  snoozeChoices: Object.freeze({
    'crm_task:20000000-0000-4000-8000-000000000001': Object.freeze([
      Object.freeze({ label: '1 hour', token: 'absolute-choice-one' }),
      Object.freeze({ label: '4 hours', token: 'absolute-choice-four' }),
      Object.freeze({ label: '1 day', token: 'absolute-choice-day' }),
    ]),
  }),
  assignmentCommandKeys: Object.freeze({
    'crm_task:20000000-0000-4000-8000-000000000001': 'assignment-command-key',
  }),
});

test('authoritative production presentation never inherits fictional fixture labels', () => {
  const view = presentOperatorActionCentre(authoritativeSnapshot());
  const html = renderOperatorActionCentreBody(view, { security: SECURITY });

  assert.equal(view.datasetKind, 'postgres_authoritative');
  assert.equal(view.datasetBoundary, 'RLS-SCOPED POSTGRESQL SNAPSHOT · source records remain authoritative');
  assert.equal(view.environment, 'production');
  assert.equal(view.mutatingControlsEnabled, true);
  assert.match(html, />PRODUCTION</);
  assert.match(html, />RLS WORKSPACE</);
  assert.match(html, /Measured workspace facts/);
  assert.doesNotMatch(html, /fictional|test fixture|test data|simulated test/i);
});

test('protected authoritative forms expose only the exact bounded command fields', () => {
  const view = presentOperatorActionCentre(authoritativeSnapshot());
  const html = renderOperatorActionCentreBody(view, { security: SECURITY });
  const forms = renderedForms(html);

  assert.equal(forms.length, 2);
  const assignment = forms.find((form) => form.action.endsWith('/assignment'));
  const snooze = forms.find((form) => form.action.endsWith('/snooze'));
  assert.ok(assignment);
  assert.ok(snooze);
  assert.equal(assignment.method, 'post');
  assert.equal(snooze.method, 'post');
  assert.equal(assignment.action, '/portal/actions/crm_task%3A20000000-0000-4000-8000-000000000001/assignment');
  assert.equal(snooze.action, '/portal/actions/crm_task%3A20000000-0000-4000-8000-000000000001/snooze');
  assert.deepEqual(assignment.fieldNames, [
    '_csrf', 'command_key', 'expected_row_version', 'assigned_user_id',
  ]);
  assert.deepEqual(snooze.fieldNames, [
    '_csrf', 'command_key', 'expected_row_version', 'snooze_choice',
  ]);
  assert.match(assignment.body, /name="_csrf" value="csrf-token-for-this-session"/);
  assert.match(assignment.body, /name="command_key" value="assignment-command-key"/);
  assert.match(snooze.body, /name="command_key" value="snooze-command-key"/);
  assert.match(assignment.body, /name="expected_row_version" value="7"/);
  assert.match(snooze.body, /name="expected_row_version" value="7"/);
  assert.deepEqual(
    [...snooze.body.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]),
    ['absolute-choice-one', 'absolute-choice-four', 'absolute-choice-day'],
  );

  const commandMarkup = forms.map((form) => `${form.attributes}${form.body}`).join('\n');
  assert.doesNotMatch(commandMarkup, /\bcomplete\b/i);
  assert.doesNotMatch(html, /action="[^"]*\/complete"|>\s*Complete\s*</i);
});

test('authoritative read-only sessions cannot be tricked into rendering command forms', () => {
  const view = presentOperatorActionCentre(authoritativeSnapshot({
    canWrite: false,
    canManage: false,
    canAssign: false,
  }));
  const html = renderOperatorActionCentreBody(view, { security: SECURITY });

  assert.equal(view.commandBoundaryAvailable, true);
  assert.equal(view.mutatingControlsEnabled, false);
  assert.equal(renderedForms(html).length, 0);
  assert.match(html, /data-command-boundary="absent"/);
  assert.match(html, /data-mutating-controls="disabled"/);
  assert.match(html, /Read-only queue/);
  assert.match(html, /Source-owned completion/);
  assert.doesNotMatch(html, />\s*Snooze\s*<|>\s*Save owner\s*</);
});

test('hostile server-derived action keys remain inert and cannot form command routes', () => {
  const hostileActionId = '../../"><script>alert(1)</script>?next=//evil.example#';
  const snapshot = authoritativeSnapshot({
    actions: [authoritativeAction({ actionId: hostileActionId })],
  });
  const security = {
    csrfToken: 'csrf-safe',
    snoozeCommandKeys: { [hostileActionId]: 'snooze-safe' },
    snoozeChoices: { [hostileActionId]: [{ label: '1 hour', token: 'choice-safe' }] },
    assignmentCommandKeys: { [hostileActionId]: 'assignment-safe' },
  };
  const html = renderOperatorActionCentreBody(presentOperatorActionCentre(snapshot), { security });
  const forms = renderedForms(html);
  assert.equal(forms.length, 0);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/i);
  assert.doesNotMatch(html, /action="\/portal\/actions\//);
  assert.match(html, /data-action-id="\.\.\/\.\.\/&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;\?next=\/\/evil\.example#"/);
  assert.match(html, /Open source to act/);
});

test('action notices require a valid signature bound to both code and session', () => {
  const secret = 'notice-signing-secret-with-enough-entropy';
  const session = 'session-token-a';
  const token = operatorActionNoticeToken(secret, session, 'snoozed');
  const query = new URLSearchParams({ notice: token });

  assert.match(token, /^snoozed\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(operatorActionNoticeFromQuery(query, secret, session), {
    kind: 'success',
    title: 'Action snoozed',
    message: 'The action is out of the active queue until the selected time. Its source record was not changed.',
  });
  assert.equal(operatorActionNoticeFromQuery(query, secret, 'session-token-b'), undefined);
  assert.equal(operatorActionNoticeFromQuery(query, 'different-secret', session), undefined);

  const separator = token.indexOf('.');
  const mac = token.slice(separator + 1);
  const flippedMac = `${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`;
  assert.equal(operatorActionNoticeFromQuery(
    new URLSearchParams({ notice: `snoozed.${flippedMac}` }), secret, session,
  ), undefined);
  assert.equal(operatorActionNoticeFromQuery(
    new URLSearchParams({ notice: `assigned.${mac}` }), secret, session,
  ), undefined);
  assert.equal(operatorActionNoticeFromQuery(
    new URLSearchParams({ notice: `snoozed.${mac}.extra` }), secret, session,
  ), undefined);
  assert.equal(operatorActionNoticeFromQuery(
    new URLSearchParams({ notice: 'snoozed' }), secret, session,
  ), undefined);
  assert.equal(operatorActionNoticeToken('', session, 'snoozed'), '');
  assert.equal(operatorActionNoticeToken(secret, '', 'snoozed'), '');
});

test('absolute snooze choices are retry-stable and bound to session, action and command', () => {
  const secret = 'snooze-signing-secret-with-enough-entropy';
  const session = 'session-token-a';
  const actionId = 'crm.task:20000000-0000-4000-8000-000000000001';
  const commandKey = '40000000-0000-4000-8000-000000000001';
  const instant = '2026-08-26T11:00:00.000Z';
  const token = operatorActionSnoozeChoiceToken(
    secret, session, actionId, commandKey, instant,
  );

  assert.ok(token.length > 60);
  assert.equal(operatorActionSnoozeInstantFromToken(
    token, secret, session, actionId, commandKey,
  ), instant);
  // A retry reuses the exact rendered instant instead of recomputing "one hour from now".
  assert.equal(operatorActionSnoozeInstantFromToken(
    token, secret, session, actionId, commandKey,
  ), instant);
  assert.equal(operatorActionSnoozeInstantFromToken(
    token, secret, 'session-token-b', actionId, commandKey,
  ), null);
  assert.equal(operatorActionSnoozeInstantFromToken(
    token, secret, session, 'crm.task:20000000-0000-4000-8000-000000000002', commandKey,
  ), null);
  assert.equal(operatorActionSnoozeInstantFromToken(
    token, secret, session, actionId, '40000000-0000-4000-8000-000000000002',
  ), null);
  assert.equal(operatorActionSnoozeInstantFromToken(
    `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`,
    secret, session, actionId, commandKey,
  ), null);
});

test('bounded assignment UI preserves an unlisted current owner and exposes the directory warning', () => {
  const action = authoritativeAction({
    assignedUserId: SECOND_USER_ID,
    ownerLabel: 'Assigned workspace member',
  });
  const view = presentOperatorActionCentre(authoritativeSnapshot({
    membersTruncated: true,
    assignableMembers: [
      { userId: CURRENT_USER_ID, displayName: 'Martin O’Connell', role: 'owner' },
    ],
    actions: [action],
  }));
  const html = renderOperatorActionCentreBody(view, { security: SECURITY });

  assert.match(html, /value="__keep_current_owner__" selected/);
  assert.match(html, /Current owner is outside this bounded list/);
  assert.match(html, /Assignable member list limited/);
  assert.match(html, /Set unassigned/);
  assert.doesNotMatch(html, /<main\b/i, 'the body is mounted inside the shell main landmark');
});
