import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JOURNEY_BOARD_CLIENT_ROUTE as JOURNEY_BOARD_VIEW_CLIENT_ROUTE,
  JOURNEY_BOARD_ROUTE,
  JOURNEY_BOARD_ROUTES,
  renderJourneyBoardBody,
  type JourneyBoardCardView,
  type JourneyBoardView,
} from '../src/portal/journey-board-view.js';
import {
  JOURNEY_BOARD_CLIENT_ASSET_PATH,
  JOURNEY_BOARD_CLIENT_ROUTE,
  JOURNEY_BOARD_CLIENT_SOURCE,
  JOURNEY_BOARD_CLIENT_SCRIPT,
} from '../src/portal/journey-board-client.js';

const CSRF = 'preview-csrf-token-000000000000';

function card(overrides: Partial<JourneyBoardCardView> = {}): JourneyBoardCardView {
  return {
    id: 'card-amelia',
    contactId: '44444444-4444-4444-8444-444444444444',
    laneId: 'work-next',
    displayName: 'Amelia Hart',
    companyName: 'Hart Property Group',
    ownerName: 'Martin',
    score: 82,
    scoreBand: 'burning',
    sourceLabel: 'Predator Briefing',
    affiliateLabel: 'North Star Partners',
    journey: {
      routeKey: 'property-predator-self-serve',
      routeLabel: 'Self-serve conversion',
      stageKey: 'priced',
      stageLabel: 'Priced',
      stageSemantic: 'offer',
      lastAdvancedAt: '2026-08-25T15:10:00.000Z',
      stageAutomatic: true,
      otherJourneyCount: 1,
      paymentVerifiedSale: false,
    },
    latestSignal: {
      kind: 'watched',
      label: 'Predator Briefing replay',
      detail: '47 minutes consumed',
      occurredAt: '2026-08-25T15:18:00.000Z',
      progressPercent: 94,
      automatic: true,
    },
    offer: { label: 'Apex Annual', state: 'requested_contact', valueLabel: '£99.00' },
    nextMove: { label: 'Review requested contact', dueAt: '2026-08-25T16:30:00.000Z', dueState: 'due' },
    move: { commandKey: 'move-amelia-command', expectedVersion: 4, allowedLaneIds: ['conversation', 'decision'] },
    ...overrides,
  };
}

function view(overrides: Partial<JourneyBoardView> = {}): JourneyBoardView {
  return {
    workspace: {
      name: 'Property Predator Launch',
      asOf: '2026-08-25T15:30:00.000Z',
      timezone: 'Europe/London',
      canWrite: true,
    },
    filters: {
      query: '', route: '', band: '',
      routes: [
        { value: 'self_serve', label: 'Self-serve conversion' },
        { value: 'agency', label: 'Agency LAPS' },
      ],
      bands: [
        { value: 'burning', label: 'Burning' },
        { value: 'hot', label: 'Hot' },
        { value: 'warm', label: 'Warm' },
      ],
    },
    lanes: [
      { id: 'new', label: 'New signal', description: 'Fresh people to triage.', position: 1, cardCount: 0, totalCardCount: 0, attentionCount: 0, isClosed: false, isPartial: false },
      { id: 'work-next', label: 'Work next', description: 'The highest-value human queue.', position: 2, cardCount: 1, totalCardCount: 1, attentionCount: 1, isClosed: false, isPartial: false },
      { id: 'conversation', label: 'Conversation', description: 'A human response is active.', position: 3, cardCount: 0, totalCardCount: 0, attentionCount: 0, isClosed: false, isPartial: false },
      { id: 'decision', label: 'Decision', description: 'Commercial decision pending.', position: 4, cardCount: 0, totalCardCount: 0, attentionCount: 0, isClosed: false, isPartial: false },
    ],
    cards: [card()],
    coverage: { loadedCardCount: 1, totalCardCount: 1, perLaneCardLimit: 75, partial: false },
    csrfToken: CSRF,
    ...overrides,
  };
}

test('exports fixed same-origin board, asset, move, Lead 360 and preview routes', () => {
  assert.equal(JOURNEY_BOARD_ROUTES.board, '/portal/journeys/board');
  assert.equal(JOURNEY_BOARD_ROUTE, '/portal/journeys/board');
  assert.equal(JOURNEY_BOARD_CLIENT_ROUTE, '/portal/assets/journey-board.js');
  assert.equal(JOURNEY_BOARD_VIEW_CLIENT_ROUTE, JOURNEY_BOARD_CLIENT_ROUTE);
  assert.equal(JOURNEY_BOARD_ROUTES.clientAsset, JOURNEY_BOARD_CLIENT_ASSET_PATH);
  assert.equal(JOURNEY_BOARD_ROUTES.moveWorkflow('a/b ?'), '/portal/journeys/board/opportunities/a%2Fb%20%3F/stage');
  assert.equal(JOURNEY_BOARD_ROUTES.lead360('a/b ?'), '/portal/crm/contacts/a%2Fb%20%3F');
  assert.equal(JOURNEY_BOARD_ROUTES.previewSignal, '/portal/journeys/board/test-signal');
});

test('renders a dense branded people board with explicit workflow and evidence boundaries', () => {
  const html = renderJourneyBoardBody(view());
  assert.match(html, /data-property-predator-journey-board/);
  assert.match(html, /Growth HQ · Live journeys/);
  assert.match(html, /People moving\. <em>Evidence proving why\.<\/em>/);
  assert.match(html, /Dragging changes the team workflow lane only/);
  assert.match(html, /Journey stages advance from recorded evidence/);
  assert.match(html, /Sale journey badge is payment-only/);
  assert.match(html, /grid-auto-columns:minmax\(300px,320px\)/);
  assert.match(html, /font-size:12px/);
  assert.match(html, /height:44px/);
  assert.match(html, /--jb-teal:#00e5cc/);
  assert.doesNotMatch(html, /crm-stage-tone-[0-9]/);
});

test('renders search, route and band filters as shareable GET controls', () => {
  const html = renderJourneyBoardBody(view({
    filters: {
      query: 'Amelia & <team>', route: 'agency', band: 'hot',
      routes: [{ value: 'agency', label: 'Agency <LAPS>' }],
      bands: [{ value: 'hot', label: 'Hot & ready' }],
    },
  }));
  assert.match(html, /method="get" action="\/portal\/journeys\/board"/);
  assert.match(html, /name="q" type="search" value="Amelia &amp; &lt;team&gt;"/);
  assert.match(html, /value="agency" selected>Agency &lt;LAPS&gt;<\/option>/);
  assert.match(html, /value="hot" selected>Hot &amp; ready<\/option>/);
  assert.match(html, /href="\/portal\/journeys\/board">Clear/);
  assert.match(html, /name="return_q" value="Amelia &amp; &lt;team&gt;"/);
  assert.match(html, /name="return_route" value="agency"/);
  assert.match(html, /name="return_band" value="hot"/);
});

test('partial filtered boards disclose their loaded boundary and avoid absolute empty claims', () => {
  const html = renderJourneyBoardBody(view({
    filters: { ...view().filters, query: 'Missing person' },
    lanes: [{
      id: 'work-next', label: 'Work next', description: 'Loaded queue.', position: 1,
      cardCount: 0, totalCardCount: 90, attentionCount: 0, isClosed: false, isPartial: true,
    }],
    cards: [],
    coverage: { loadedCardCount: 75, totalCardCount: 90, perLaneCardLimit: 75, partial: true },
  }));
  assert.match(html, /Showing 75 of 90 saved workflow cards/);
  assert.match(html, /Filters search the loaded cards only/);
  assert.match(html, /No match in the loaded cards/);
  assert.doesNotMatch(html, /No people in this workflow lane/);
});

test('partial lanes never turn a loaded-page filter miss into a global no-match claim', () => {
  const base = view();
  const html = renderJourneyBoardBody(view({
    filters: { ...base.filters, query: 'not in the loaded page' },
    lanes: base.lanes.map((lane) => lane.id === 'work-next'
      ? { ...lane, cardCount: 0, totalCardCount: 90, isPartial: true }
      : lane),
    cards: [],
    coverage: { loadedCardCount: 75, totalCardCount: 90, perLaneCardLimit: 75, partial: true },
  }));
  assert.match(html, /Bounded live view/);
  assert.match(html, /Showing 75 of 90 saved workflow cards/);
  assert.match(html, /Filters search the loaded cards only/);
  assert.match(html, /No match in the loaded cards/);
  assert.doesNotMatch(html, />No matching people</);
});

test('card shows score, source, affiliate, automatic signal, offer, next move and Lead 360 link', () => {
  const html = renderJourneyBoardBody(view());
  assert.match(html, /aria-label="Lead score 82, Burning"/);
  assert.match(html, /Source · Predator Briefing/);
  assert.match(html, /Affiliate · North Star Partners/);
  assert.match(html, /Self-serve conversion/);
  assert.match(html, /Priced/);
  assert.match(html, /\+1 other route/);
  assert.match(html, /AUTO ·/);
  assert.match(html, /94% complete/);
  assert.match(html, /Apex Annual/);
  assert.match(html, /Requested contact · £99\.00/);
  assert.match(html, /Review requested contact/);
  assert.match(html, /href="\/portal\/crm\/contacts\/44444444-4444-4444-8444-444444444444" data-lead360-link/);
});

test('payment-confirmed sale receives the only authoritative sale badge', () => {
  const sale = card({
    journey: {
      ...card().journey,
      stageKey: 'sale', stageLabel: 'Sale', stageSemantic: 'sale', paymentVerifiedSale: true,
    },
  });
  const html = renderJourneyBoardBody(view({ cards: [sale] }));
  assert.match(html, /Sale · payment verified/);

  const notPaid = renderJourneyBoardBody(view({ cards: [card()] }));
  assert.doesNotMatch(notPaid, /class="jb-payment-only">Sale/);
});

test('non-automatic milestone provenance is labelled recorded without claiming a manual action', () => {
  const html = renderJourneyBoardBody(view({
    cards: [card({ journey: { ...card().journey, stageAutomatic: false } })],
  }));
  assert.match(html, />RECORDED<\/small>/);
  assert.doesNotMatch(html, />MANUAL<\/small>/);
});

test('authorised cards have dedicated drag handles and real protected POST fallbacks', () => {
  const html = renderJourneyBoardBody(view());
  assert.match(html, /data-journey-card data-workflow-movable="true"/);
  assert.match(html, /<button class="jb-drag-handle" type="button" aria-pressed="false"/);
  assert.doesNotMatch(html, /draggable="true"/);
  assert.match(html, /Press and drag this handle, or press Space then arrows and Space/);
  assert.match(html, /Swipe a blank area of this card left or right/);
  assert.match(html, /<form class="jb-move" method="post" action="\/portal\/journeys\/board\/opportunities\/card-amelia\/stage" data-workflow-move-form>/);
  assert.match(html, /name="_csrf" value="preview-csrf-token-000000000000"/);
  assert.match(html, /name="command_key" value="move-amelia-command"/);
  assert.match(html, /name="expected_version" value="4"/);
  assert.match(html, /name="target_lane_id" required data-lane-select/);
  assert.match(html, /value="conversation">Conversation/);
  assert.match(html, /value="decision">Decision/);
  assert.doesNotMatch(html, /value="new">New signal/);
  assert.doesNotMatch(html, /value="work-next">Work next/);
  assert.match(html, /does not fabricate journey evidence, send a message or verify payment/);
});

test('read-only and malformed mutation state render no deceptive move control', () => {
  const readOnly = renderJourneyBoardBody(view({
    workspace: { ...view().workspace, canWrite: false },
  }));
  assert.match(readOnly, /Workflow movement is unavailable for this workspace role/);
  assert.doesNotMatch(readOnly, /data-drag-handle|data-workflow-move-form/);

  const malformed = renderJourneyBoardBody(view({
    cards: [card({ move: { commandKey: '', expectedVersion: -1, allowedLaneIds: ['conversation'] } })],
  }));
  assert.match(malformed, /Refresh the board before moving this workflow card/);
  assert.doesNotMatch(malformed, /data-drag-handle|name="target_lane_id"/);
});

test('mobile enhancement uses honest pressed buttons while no-JS markup preserves every lane', () => {
  const html = renderJourneyBoardBody(view());
  assert.match(html, /class="jb-mobile-stage-tabs" role="group" aria-label="Choose a workflow lane"/);
  assert.match(html, /type="button" aria-pressed="true" aria-controls="jb-lane-panel-new" aria-label="Show New signal workflow lane, 0 visible cards" data-lane-tab="new">New signal · 0/);
  assert.match(html, /id="jb-lane-panel-new" data-journey-lane/);
  assert.doesNotMatch(html, /role="tab(?:list)?"|aria-selected=/);
  assert.match(html, /data-mobile-active="true"/);
  assert.match(html, /data-mobile-active="false"/);
  assert.match(html, /\.jb-enhanced \.jb-lane:not\(\[data-mobile-active="true"\]\)\{display:none\}/);
  assert.match(html, /\.jb-board\{display:block;overflow:visible/);
  assert.match(html, /\.jb-mobile-stage-tab\{[^}]*min-height:44px/);
  assert.match(html, /\.jb-move-row\{grid-template-columns:1fr\}/);
  assert.match(html, /\.jb-move-field,\.jb-move-submit\{grid-column:1\/-1\}/);
  assert.match(html, /\.jb-enhanced \.jb-card\[data-workflow-movable="true"\]\{cursor:grab;touch-action:pan-y\}/);
  assert.match(html, /\.jb-move-help-desktop\{display:none\}\.jb-move-help-mobile\{display:inline\}/);
});

test('drawer is an accessible progressive enhancement over full-page Lead 360 links', () => {
  const html = renderJourneyBoardBody(view());
  assert.match(html, /data-lead360-drawer role="dialog" aria-modal="true" aria-labelledby="jb-drawer-title" hidden/);
  assert.match(html, /data-drawer-close aria-label="Close Lead 360"/);
  assert.match(html, /data-board-live role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /<script src="\/portal\/assets\/journey-board\.js" defer><\/script>$/);
  assert.doesNotMatch(html, /onclick=|onkeydown=|ondrag|javascript:/i);
  assert.equal((html.match(/<script\b/g) ?? []).length, 1);
});

test('optional preview signal form is unmistakably test-only and absent by default', () => {
  const normal = renderJourneyBoardBody(view());
  assert.doesNotMatch(normal, /Record test signal|preview_fixture_only/);

  const preview = renderJourneyBoardBody(view({
    previewSignal: {
      enabled: true,
      commandKey: 'preview-signal-command',
      contacts: [{ value: 'contact-test', label: 'Amelia <Test>' }],
      signals: [{ value: 'sales.appointment.booked', label: 'Appointment & booked' }],
    },
  }));
  assert.match(preview, /Preview fixtures only/);
  assert.match(preview, /explicitly configured disposable preview runtime/);
  assert.match(preview, /never contacts a person, sends a message or claims a real payment/);
  assert.match(preview, /method="post" action="\/portal\/journeys\/board\/test-signal"/);
  assert.match(preview, /name="preview_fixture_only" value="true"/);
  assert.match(preview, /Amelia &lt;Test&gt;/);
  assert.match(preview, /Appointment &amp; booked/);
});

test('preview Lead 360 never borrows the current milestone timestamp for earlier stages', async () => {
  process.env.PROPERTY_PREDATOR_PREVIEW_IMPORT_ONLY = '1';
  const { previewLead360 } = await import('./manual-property-predator-preview.js');
  delete process.env.PROPERTY_PREDATOR_PREVIEW_IMPORT_ONLY;
  const caseFile = previewLead360(card());
  const journey = caseFile.journeys?.[0];
  assert.ok(journey);
  assert.deepEqual(journey.stages.map((stage) => stage.state), ['complete', 'complete', 'current', 'upcoming']);
  assert.deepEqual(journey.stages.map((stage) => stage.reachedAt), [
    null,
    null,
    '2026-08-25T15:10:00.000Z',
    null,
  ]);
  assert.equal(journey.score?.sourceOccurredAt, '2026-08-25T15:18:00.000Z');
  assert.notEqual(journey.score?.evaluatedAt, journey.score?.sourceOccurredAt);
});

test('all supplied display data is escaped and unavailable-lane cards are withheld', () => {
  const poisoned = '<img src=x onerror=alert(1)>';
  const html = renderJourneyBoardBody(view({
    workspace: { ...view().workspace, name: poisoned },
    cards: [card({
      displayName: poisoned,
      companyName: '<script>bad()</script>',
      sourceLabel: 'A&B',
      affiliateLabel: '"affiliate"',
      laneId: 'missing-lane',
    })],
  }));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /1 card referenced an unavailable lane and were withheld for review/);
  assert.doesNotMatch(html, /<img\b|<script>bad|A&amp;B|&quot;affiliate&quot;/i);
});

test('empty board and empty card facts invent no operational or conversion data', () => {
  const noLanes = renderJourneyBoardBody(view({ lanes: [], cards: [] }));
  assert.match(noLanes, /No workflow lanes have been configured/);
  assert.doesNotMatch(noLanes, /data-journey-card/);

  const sparse = renderJourneyBoardBody(view({
    cards: [card({ score: null, scoreBand: 'unscored', latestSignal: null, offer: null, nextMove: null })],
  }));
  assert.match(sparse, /Lead score —, Unscored/);
  assert.match(sparse, /No evidence recorded/);
  assert.match(sparse, /No offer recorded/);
  assert.match(sparse, /No evidence-based move/);
  assert.doesNotMatch(sparse, /94% complete|£99\.00/);
});

test('client asset compiles and implements pointer, keyboard, mobile and drawer enhancement safely', () => {
  assert.equal(JOURNEY_BOARD_CLIENT_SOURCE, JOURNEY_BOARD_CLIENT_SCRIPT);
  assert.doesNotThrow(() => new Function(JOURNEY_BOARD_CLIENT_SCRIPT));
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /addEventListener\('pointerdown'/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /addEventListener\('pointermove'/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /addEventListener\('pointerup'/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /setPointerCapture/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /elementFromPoint/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /directionalDestination/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /max-width: 760px/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /target\.closest\('a, button, input, select, textarea, label/);
  assert.doesNotMatch(JOURNEY_BOARD_CLIENT_SCRIPT, /addEventListener\('dragstart'|dataTransfer/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /key === ' '/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /key === 'Enter'/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /key === 'ArrowRight'/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /key === 'ArrowLeft'/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /key === 'Escape'/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /form\.requestSubmit\(\)/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /data-mobile-active/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /setAttribute\('aria-pressed'/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /new URL\(link\.href, window\.location\.href\)/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /url\.origin !== window\.location\.origin/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /credentials: 'same-origin'/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /setAttribute\('inert', ''\)/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /removeAttribute\('inert'\)/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /event\.key === 'Tab'/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /drawerReturnFocus\.isConnected/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /new AbortController\(\)/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /request !== drawerRequest/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /signal: drawerController/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /querySelector\('\.lead360'\)/);
  assert.match(JOURNEY_BOARD_CLIENT_SCRIPT, /replaceChildren/);
  assert.doesNotMatch(JOURNEY_BOARD_CLIENT_SCRIPT, /eval\(|new Function|innerHTML|insertAdjacentHTML|localStorage|sessionStorage/);
});
