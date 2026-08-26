import assert from 'node:assert/strict';
import test from 'node:test';
import { createPropertyPredatorAutomationStudioFixture } from '../src/portal/automation-studio-fixtures.js';
import { presentAutomationStudio } from '../src/portal/automation-studio-presenter.js';
import { createPropertyPredatorContentCatalogFixture } from '../src/portal/content-control-room-fixtures.js';
import { presentContentControlRoom } from '../src/portal/content-control-room-presenter.js';
import { createPropertyPredatorTestInboxSnapshot } from '../src/portal/conversion-inbox-fixtures.js';
import { presentConversionInbox } from '../src/portal/conversion-inbox-presenter.js';
import {
  createPropertyPredatorOperatorActionCentreFixture,
} from '../src/portal/operator-action-centre-fixtures.js';
import {
  OPERATOR_ACTION_CENTRE_MAX_ACTIONS,
  OPERATOR_ACTION_CENTRE_ROUTE,
  presentOperatorActionCentre,
  type OperatorActionCentreSnapshot,
} from '../src/portal/operator-action-centre-presenter.js';
import { renderOperatorActionCentreBody } from '../src/portal/operator-action-centre-view.js';
import { createPropertyPredatorProviderConnectionsFixture } from '../src/portal/provider-connections-fixtures.js';
import { presentProviderConnections } from '../src/portal/provider-connections-presenter.js';
import { createPropertyPredatorWebinarStudioFixture } from '../src/portal/webinar-studio-fixtures.js';
import { presentWebinarStudio } from '../src/portal/webinar-studio-presenter.js';
import { renderWebinarStudioBody } from '../src/portal/webinar-studio-view.js';

test('Operator Action Centre aggregates all seven operating surfaces into one safe TEST queue', () => {
  const view = presentOperatorActionCentre(createPropertyPredatorOperatorActionCentreFixture());
  assert.equal(OPERATOR_ACTION_CENTRE_ROUTE, '/portal/actions');
  assert.equal(view.environment, 'test');
  assert.equal(view.datasetKind, 'fictional_test_fixture');
  assert.equal(view.datasetBoundary, 'FICTIONAL TEST FIXTURE · no customer, provider or production records');
  assert.equal(view.actions.length, 14);
  assert.equal(view.sources.length, 7);
  assert.ok(view.sources.every((source) => source.total === 2));
  assert.deepEqual(view.sources.map((source) => source.source), [
    'journey', 'inbox', 'content', 'webinar', 'automation', 'provider', 'crm',
  ]);
  assert.deepEqual(view.headline, {
    total: 14,
    needsNow: 5,
    breached: 2,
    blocked: 4,
    unassigned: 1,
    evidenceUnavailable: 0,
  });
  assert.equal(view.integrity.coherent, true);
  assert.equal(view.integrity.label, 'QUEUE COHERENT');
  assert.equal(view.commandBoundaryAvailable, false);
  assert.equal(view.mutatingControlsEnabled, false);
  assert.equal(view.providerEffects, 'none');
});

test('queue ranks breaches, due-now work and blocked P0 work ahead of the deck', () => {
  const view = presentOperatorActionCentre(createPropertyPredatorOperatorActionCentreFixture());
  assert.deepEqual(view.needsNow.map((action) => action.actionId), [
    'journey-laila-stall',
    'inbox-email-approval',
    'automation-consent-expiry',
    'content-rejection-revision',
    'webinar-replay-approval',
  ]);
  assert.deepEqual(view.needsNow.map((action) => action.indexLabel), ['01', '02', '03', '04', '05']);
  assert.equal(view.onDeck[0]?.actionId, 'crm-call-sophie');
  assert.equal(view.actions.at(-1)?.actionId, 'provider-listening-scope');
  assert.equal(view.actions.at(-1)?.slaState, 'no_target');
  assert.equal(view.actions.at(-1)?.slaLabel, 'NO VALID SLA');
});

test('SLA derivation remains exact and human-readable at the operational boundary', () => {
  const byId = new Map(presentOperatorActionCentre(createPropertyPredatorOperatorActionCentreFixture()).actions.map((row) => [row.actionId, row]));
  assert.deepEqual(
    ['journey-laila-stall', 'inbox-email-approval', 'automation-consent-expiry', 'content-rejection-revision'].map((id) => ({
      id,
      state: byId.get(id)?.slaState,
      label: byId.get(id)?.slaLabel,
      minutes: byId.get(id)?.minutesToDue,
    })),
    [
      { id: 'journey-laila-stall', state: 'breached', label: 'BREACHED · 4h', minutes: -240 },
      { id: 'inbox-email-approval', state: 'breached', label: 'BREACHED · 40m', minutes: -40 },
      { id: 'automation-consent-expiry', state: 'due_now', label: 'DUE · 40m', minutes: 40 },
      { id: 'content-rejection-revision', state: 'due_now', label: 'DUE · 1h 30m', minutes: 90 },
    ],
  );
  assert.equal(byId.get('webinar-replay-approval')?.needsNow, true, 'blocked P0 joins needs-now even when due later today');
  assert.equal(byId.get('webinar-replay-approval')?.slaState, 'due_today');
});

test('ownership load exposes urgent concentration and the unassigned gap', () => {
  const view = presentOperatorActionCentre(createPropertyPredatorOperatorActionCentreFixture());
  assert.deepEqual(view.owners[0], {
    ownerLabel: 'Martin O’Connell',
    ownerInitials: 'MO',
    total: 5,
    needsNow: 3,
    breached: 2,
  });
  assert.deepEqual(view.owners.find((owner) => owner.ownerLabel === 'Unassigned'), {
    ownerLabel: 'Unassigned',
    ownerInitials: 'UN',
    total: 1,
    needsNow: 0,
    breached: 0,
  });
});

test('unsafe links, impossible chronology and evidence-free claims fail visibly', () => {
  const fixture = createPropertyPredatorOperatorActionCentreFixture();
  const first = fixture.actions[0];
  assert.ok(first);
  const view = presentOperatorActionCentre({
    ...fixture,
    actions: [{
      ...first,
      deepLink: 'https://attacker.invalid/steal',
      createdAt: '2027-01-01T00:00:00.000Z',
      evidence: { ...first.evidence, evidenceRef: null, observedAt: null },
    }],
  });
  assert.equal(view.actions[0]?.deepLink, '/portal/actions');
  assert.equal(view.actions[0]?.deepLinkValid, false);
  assert.equal(view.actions[0]?.evidence.available, false);
  assert.equal(view.actions[0]?.inputValid, false);
  assert.equal(view.headline.evidenceUnavailable, 1);
  assert.equal(view.integrity.coherent, false);
  assert.equal(view.integrity.invalidActions, 1);
  assert.equal(view.integrity.label, 'REVIEW INPUT');
});

test('duplicate IDs and oversized queues fail integrity while the display stays bounded', () => {
  const fixture = createPropertyPredatorOperatorActionCentreFixture();
  const source = fixture.actions[0];
  assert.ok(source);
  const actions = Array.from({ length: OPERATOR_ACTION_CENTRE_MAX_ACTIONS + 5 }, (_, index) => ({
    ...source,
    actionId: index < 2 ? 'duplicate-action' : `bounded-action-${index}`,
    title: `${'<unsafe>'}${'x'.repeat(500)}-${index}`,
  }));
  const view = presentOperatorActionCentre({ ...fixture, actions });
  assert.equal(view.actions.length, OPERATOR_ACTION_CENTRE_MAX_ACTIONS);
  assert.equal(view.inputTruncated, true);
  assert.equal(view.integrity.duplicateActions, 1);
  assert.equal(view.integrity.coherent, false);
  assert.ok((view.actions[0]?.title.length ?? 0) <= 180);
  assert.match(renderOperatorActionCentreBody(view), /Safe queue bound reached/);
});

test('premium responsive UI exposes deep links and visibly disabled mutation controls', () => {
  const view = presentOperatorActionCentre(createPropertyPredatorOperatorActionCentreFixture());
  const html = renderOperatorActionCentreBody(view);
  assert.match(html, /data-property-predator-operator-action-centre/);
  assert.match(html, /data-property-predator-operator-actions/);
  assert.match(html, /data-command-boundary="absent"/);
  assert.match(html, /data-mutating-controls="disabled"/);
  assert.match(html, /data-provider-effects="none"/);
  assert.match(html, /data-dataset-kind="fictional_test_fixture"/);
  assert.match(html, /FICTIONAL TEST FIXTURE · no customer, provider or production records/);
  assert.match(html, /FICTIONAL FIXTURE/);
  assert.match(html, /One queue\. <em>Nothing gets dropped\.<\/em>/);
  assert.match(html, /Seven systems\. One operator rhythm\./);
  assert.match(html, /Needs you now/);
  assert.match(html, /On deck/);
  assert.match(html, /Journey runtime/);
  assert.match(html, /Conversion inbox/);
  assert.match(html, /Content control/);
  assert.match(html, /Webinar studio/);
  assert.match(html, /Automation gate/);
  assert.match(html, /Provider readiness/);
  assert.match(html, /CRM task/);
  assert.match(html, /Source evidence/);
  assert.match(html, /href="\/portal\/journeys\/board\?q=Laila\+Morgan&amp;route=property-predator-self-serve&amp;band=warm"/);
  assert.equal((html.match(/class="oac-action-button" type="button" disabled aria-disabled="true"/g) ?? []).length, 14);
  assert.equal((html.match(/class="oac-action-button complete" type="button" disabled aria-disabled="true"/g) ?? []).length, 14);
  assert.match(html, /Snooze is unavailable because no Operator Action command boundary is connected/);
  assert.match(html, /Complete is unavailable because no Operator Action command boundary is connected/);
  assert.match(html, /min-height:46px/);
  assert.match(html, /@media\(max-width:760px\)/);
  assert.match(html, /@media\(max-width:520px\)/);
  assert.match(html, /@media\(forced-colors:active\)/);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(html, /<form|method="post"|fetch\(|XMLHttpRequest|apiKey|accessToken|secretKey/i);
});

test('every action link uses only an implemented destination contract', () => {
  const view = presentOperatorActionCentre(createPropertyPredatorOperatorActionCentreFixture());
  const allowedParams = new Map<string, ReadonlySet<string>>([
    ['/portal/journeys/board', new Set(['q', 'route', 'band'])],
    ['/portal/inbox', new Set(['q', 'channel', 'queue', 'conversation'])],
    ['/portal/content', new Set(['q', 'channel', 'format'])],
    ['/portal/automations', new Set(['node'])],
    ['/portal/webinars', new Set()],
    ['/portal/connections', new Set()],
    ['/portal/crm/tasks', new Set(['status'])],
  ]);
  for (const action of view.actions) {
    const url = new URL(action.deepLink, 'https://growth-hq.test');
    const permitted = allowedParams.get(url.pathname);
    assert.ok(permitted, `${action.actionId} must target an implemented Action Centre destination`);
    for (const key of url.searchParams.keys()) {
      assert.ok(permitted.has(key), `${action.actionId} uses unsupported ${key} on ${url.pathname}`);
    }
    assert.equal(url.searchParams.has('focus'), false);
    assert.equal(url.searchParams.has('approval'), false);
    if (action.source === 'journey') {
      assert.equal(url.pathname, '/portal/journeys/board');
      assert.equal(action.relatedPersonLabel?.startsWith(url.searchParams.get('q') ?? ''), true);
      assert.ok((url.searchParams.get('q') ?? '').length > 0);
    }
    if (action.source === 'crm') {
      assert.equal(url.pathname, '/portal/crm/tasks');
      assert.equal(url.searchParams.get('status'), 'open');
      assert.match(action.deepLinkLabel, /queue/i, 'section-level CRM links must describe the queue honestly');
    }
  }
});

test('canonical Inbox links select their intended fictional conversation records', () => {
  const actionView = presentOperatorActionCentre(createPropertyPredatorOperatorActionCentreFixture());
  const snapshot = createPropertyPredatorTestInboxSnapshot();
  const expected = new Map([
    ['inbox-email-approval', { id: '10000000-0000-4000-8000-000000000001', name: 'Aisha Rahman' }],
    ['inbox-facebook-draft', { id: '10000000-0000-4000-8000-000000000005', name: 'Liam Carter' }],
  ]);
  for (const action of actionView.actions.filter((row) => row.source === 'inbox')) {
    const wanted = expected.get(action.actionId);
    assert.ok(wanted);
    const url = new URL(action.deepLink, 'https://growth-hq.test');
    const conversationId = url.searchParams.get('conversation');
    assert.match(conversationId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    const inbox = presentConversionInbox(snapshot, {
      workspaceName: 'Property Predator Growth HQ',
      filters: {
        channel: url.searchParams.get('channel'),
        queue: url.searchParams.get('queue'),
        conversationId,
      },
    });
    assert.equal(inbox.selectedThread?.summary.conversationId, wanted.id);
    assert.equal(inbox.selectedThread?.lead.displayName, wanted.name);
    assert.equal(action.relatedPersonLabel?.startsWith(wanted.name), true);
  }
});

test('Content Control links use real filters and resolve to one intended immutable fixture', () => {
  const actionView = presentOperatorActionCentre(createPropertyPredatorOperatorActionCentreFixture());
  const expected = new Map([
    ['content-rejection-revision', 'Why comparables need context, not just a radius'],
    ['content-mixed-use-approval', 'Predator Briefing: mixed-use intelligence follow-up'],
  ]);
  for (const action of actionView.actions.filter((row) => row.source === 'content')) {
    const url = new URL(action.deepLink, 'https://growth-hq.test');
    const content = presentContentControlRoom(createPropertyPredatorContentCatalogFixture(), {
      workspaceName: 'Property Predator Growth HQ',
      asOf: '2026-08-26T08:42:00.000Z',
      filters: {
        query: url.searchParams.get('q'),
        channel: url.searchParams.get('channel'),
        format: url.searchParams.get('format'),
      },
    });
    assert.equal(content.matchingCount, 1, `${action.actionId} should select exactly one content item`);
    assert.equal(content.items[0]?.title, expected.get(action.actionId));
  }
});

test('automation nodes and section fragments resolve against their rendered feature surfaces', () => {
  const actionView = presentOperatorActionCentre(createPropertyPredatorOperatorActionCentreFixture());
  for (const action of actionView.actions.filter((row) => row.source === 'automation')) {
    const url = new URL(action.deepLink, 'https://growth-hq.test');
    const node = url.searchParams.get('node');
    assert.ok(node);
    assert.equal(
      presentAutomationStudio(createPropertyPredatorAutomationStudioFixture(), { node }).selectedNode.nodeId,
      node,
      `${action.actionId} must select its intended automation node`,
    );
  }

  const providerAnchors = new Set(presentProviderConnections(
    createPropertyPredatorProviderConnectionsFixture(),
  ).adapters.map((adapter) => adapter.anchorId));
  for (const action of actionView.actions.filter((row) => row.source === 'provider')) {
    const fragment = new URL(action.deepLink, 'https://growth-hq.test').hash.slice(1);
    assert.ok(providerAnchors.has(fragment), `${action.actionId} must resolve to a rendered provider card`);
  }

  const webinarHtml = renderWebinarStudioBody(presentWebinarStudio(
    createPropertyPredatorWebinarStudioFixture(),
  ));
  for (const action of actionView.actions.filter((row) => row.source === 'webinar')) {
    const fragment = new URL(action.deepLink, 'https://growth-hq.test').hash.slice(1);
    assert.match(webinarHtml, new RegExp(`id="${fragment}"`), `${action.actionId} must resolve to a rendered webinar section`);
  }
});

test('hostile text is escaped and a hostile evidence route cannot leave the portal', () => {
  const fixture = createPropertyPredatorOperatorActionCentreFixture();
  const first = fixture.actions[0];
  assert.ok(first);
  const hostile = {
    ...fixture,
    workspaceName: '<script>alert(1)</script>',
    actions: [{
      ...first,
      title: '<img src=x onerror=alert(2)>',
      detail: '</p><script>alert(3)</script>',
      ownerLabel: '<svg onload=alert(4)>',
      deepLink: 'javascript:alert(5)',
      evidence: { ...first.evidence, label: 'A&B <script>alert(6)</script>' },
    }],
    apiKey: 'SUPER-SECRET-MUST-NOT-RENDER',
    accessToken: 'TOKEN-MUST-NOT-RENDER',
  } as OperatorActionCentreSnapshot & { apiKey: string; accessToken: string };
  const html = renderOperatorActionCentreBody(presentOperatorActionCentre(hostile));
  assert.doesNotMatch(html, /<(?:script|img|svg)\b/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/);
  assert.match(html, /&lt;svg onload=alert\(4\)&gt;/);
  assert.match(html, /A&amp;B &lt;script&gt;alert\(6\)&lt;\/script&gt;/);
  assert.match(html, /href="\/portal\/actions" aria-disabled="true" tabindex="-1"/);
  assert.doesNotMatch(html, /javascript:alert|SUPER-SECRET|TOKEN-MUST/);
  assert.doesNotMatch(html, /apiKey|accessToken/i);
});

test('empty queue renders calm zero states without inventing operational work', () => {
  const fixture = createPropertyPredatorOperatorActionCentreFixture();
  const view = presentOperatorActionCentre({ ...fixture, actions: [] });
  assert.equal(view.headline.total, 0);
  assert.equal(view.integrity.coherent, true);
  assert.ok(view.sources.every((source) => source.total === 0));
  const html = renderOperatorActionCentreBody(view);
  assert.match(html, /No urgent TEST work/);
  assert.match(html, /Deck clear/);
  assert.match(html, /No TEST work is assigned/);
  assert.equal((html.match(/<button class="oac-action-button/g) ?? []).length, 0, 'no phantom action controls render');
});

test('presentation and HTML are deterministic for one immutable snapshot', () => {
  const fixture = createPropertyPredatorOperatorActionCentreFixture();
  const first = presentOperatorActionCentre(fixture);
  const second = presentOperatorActionCentre(fixture);
  assert.deepEqual(second, first);
  assert.equal(renderOperatorActionCentreBody(second), renderOperatorActionCentreBody(first));
});
