import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPropertyPredatorDailyOutreachFixture,
  PROPERTY_PREDATOR_DAILY_OUTREACH_AS_OF,
} from '../src/portal/daily-outreach-fixtures.js';
import {
  DAILY_OUTREACH_MAX_PROSPECTS,
  DAILY_OUTREACH_ROUTE,
  presentDailyOutreach,
  type DailyOutreachSnapshot,
} from '../src/portal/daily-outreach-presenter.js';
import { renderDailyOutreachBody } from '../src/portal/daily-outreach-view.js';

function fixture(): DailyOutreachSnapshot {
  return createPropertyPredatorDailyOutreachFixture();
}

test('Daily Outreach presents the daily fuel target and next fictional prospect immediately', () => {
  const snapshot = fixture();
  const view = presentDailyOutreach(snapshot);
  assert.equal(DAILY_OUTREACH_ROUTE, '/portal/outreach/daily');
  assert.equal(snapshot.snapshotAt, PROPERTY_PREDATOR_DAILY_OUTREACH_AS_OF);
  assert.equal(view.dataset, 'fictional_test');
  assert.equal(view.datasetLabel, 'FICTIONAL TEST DATA');
  assert.equal(view.externalEffects, false);
  assert.equal(view.providerEffects, 'none');
  assert.deepEqual(view.progress, {
    dailyTarget: 12,
    completed: 7,
    remaining: 5,
    progressPercent: 58,
    progressLabel: '7 / 12',
    channels: view.progress.channels,
  });
  assert.deepEqual(view.progress.channels.map((row) => ({
    channel: row.channel,
    segment: row.segmentLabel,
    progress: row.progressLabel,
  })), [
    { channel: 'linkedin', segment: 'Active developers · FICTIONAL TEST SEGMENT', progress: '4 / 6' },
    { channel: 'instagram', segment: 'Property sourcers · FICTIONAL TEST SEGMENT', progress: '2 / 4' },
    { channel: 'creator_watch', segment: 'Authority conversations · FICTIONAL TEST SEGMENT', progress: '1 / 2' },
  ]);
  assert.equal(view.nextProspect.prospectId, 'test-prospect-mara-vane');
  assert.equal(view.nextProspect.actionMode, 'manual_first_touch');
  assert.equal(view.nextProspect.actionModeLabel, 'MANUAL FIRST TOUCH');
  assert.match(view.nextProspect.selectionReason, /Strong audience fit/);
  assert.match(view.nextProspect.sourceEvidenceRef, /approved-csv:014/);
  assert.equal(view.nextProspect.draft.status, 'draft_locked');
  assert.equal(view.nextProspect.draft.immutable, true);
  assert.equal(view.nextProspect.draft.providerEffects, false);
  assert.equal(view.nextProspect.cooldown.state, 'clear');
  assert.equal(view.nextProspect.outcome.outcome, 'pending');
  assert.match(view.nextProspect.nextAction.journeyConsequence, /does not create a LAPS Lead/);
  assert.equal(view.integrity.coherent, true);
  assert.equal(view.inputTruncated, false);
  assert.deepEqual(view.safety, {
    liveAuthorised: false,
    providerOperationsCreated: 0,
    contactEffects: false,
    commandBoundaryAvailable: false,
  });
});

test('Daily Outreach keeps manual, Zernio-supported and blocked execution truth distinct', () => {
  const view = presentDailyOutreach(fixture());
  assert.deepEqual(view.prospects.map((prospect) => prospect.actionMode), [
    'manual_first_touch',
    'zernio_reply_eligible',
    'blocked',
    'blocked',
  ]);
  const supported = view.prospects.find((prospect) => prospect.actionMode === 'zernio_reply_eligible');
  assert.ok(supported);
  assert.equal(supported.actionModeLabel, 'ZERNIO-SUPPORTED');
  assert.equal(supported.draft.status, 'approved_exact_version');
  assert.equal(supported.draft.statusLabel, 'APPROVED · EXACT VERSION');
  assert.match(supported.actionModeReason, /no provider operation/);

  const blocked = view.prospects.find((prospect) => prospect.personLabel.startsWith('Sora Pike'));
  assert.ok(blocked);
  assert.equal(blocked.actionModeLabel, 'BLOCKED');
  assert.equal(blocked.cooldown.state, 'stopped');
  assert.match(blocked.cooldown.stopReason ?? '', /suppression/);
  assert.equal(blocked.outcome.outcome, 'suppressed');
  assert.match(blocked.nextAction.label, /Resolve the blocker|Keep stopped/);

  const cooling = view.prospects.find((prospect) => prospect.personLabel.startsWith('Nico Fenn'));
  assert.ok(cooling);
  assert.equal(cooling.actionMode, 'blocked');
  assert.match(cooling.actionModeReason, /Cooldown prevents another attempt/);
  assert.equal(cooling.cooldown.state, 'cooling');
  assert.match(cooling.cooldown.stateLabel, /COOLDOWN/);
  assert.match(cooling.cooldown.stopReason ?? '', /72-hour/);
  assert.equal(cooling.outcome.outcome, 'no_response');
});

test('Daily Outreach fails stale or source-less execution truth closed', () => {
  const source = fixture();
  const first = source.prospects[0];
  const second = source.prospects[1];
  assert.ok(first);
  assert.ok(second);
  const view = presentDailyOutreach({
    ...source,
    prospects: [
      { ...first, sourceEvidenceRef: '' },
      { ...second, eligibilityExpiresAt: '2026-09-02T08:14:59.000Z' },
      ...source.prospects.slice(2),
    ],
  });
  assert.equal(view.prospects[0]?.actionMode, 'blocked');
  assert.equal(view.prospects[0]?.failClosedReason, 'Source evidence is missing.');
  assert.equal(view.prospects[1]?.actionMode, 'blocked');
  assert.equal(view.prospects[1]?.failClosedReason, 'Channel eligibility is missing or stale.');
  assert.equal(view.integrity.coherent, false);
  assert.ok(view.integrity.issues.some((issue) => /failed closed/.test(issue)));
});

test('Creator Watch records both a useful comment draft and the explicit no_comment choice', () => {
  const view = presentDailyOutreach(fixture());
  assert.equal(view.creatorWatch.length, 2);
  const comment = view.creatorWatch.find((item) => item.decision === 'comment');
  const noComment = view.creatorWatch.find((item) => item.decision === 'no_comment');
  assert.ok(comment);
  assert.ok(noComment);
  assert.equal(comment.reviewMode, 'review_only');
  assert.equal(comment.draft?.status, 'draft_locked');
  assert.equal(comment.draft?.providerEffects, false);
  assert.equal(comment.purpose, 'ask_question');
  assert.equal(noComment.decisionLabel, 'no_comment');
  assert.equal(noComment.purpose, 'none');
  assert.equal(noComment.draft, null);
  assert.match(noComment.decisionReason, /Generic praise would create noise/);
  assert.match(noComment.cooldown.stateLabel, /COOLDOWN/);
});

test('manager reporting separates controllable inputs, outcomes, stops and management dimensions', () => {
  const view = presentDailyOutreach(fixture());
  assert.deepEqual({
    reviewed: view.manager.prospectsReviewed,
    attempts: view.manager.validAttempts,
    responseRate: view.manager.responseRateLabel,
    positiveRate: view.manager.positiveResponseRateLabel,
    conversations: view.manager.conversationsCreated,
    leads: view.manager.lapsLeadsCreated,
    appointments: view.manager.lapsAppointmentsCreated,
    duplicates: view.manager.duplicatesPrevented,
    blocks: view.manager.blockedAttempts,
    suppressions: view.manager.suppressions,
    failures: view.manager.providerFailures,
  }, {
    reviewed: 19,
    attempts: 7,
    responseRate: '42.9%',
    positiveRate: '28.6%',
    conversations: 3,
    leads: 2,
    appointments: 1,
    duplicates: 1,
    blocks: 2,
    suppressions: 1,
    failures: 0,
  });
  assert.deepEqual(view.breakdowns.map((row) => row.dimension), [
    'operator', 'audience', 'campaign', 'source', 'angle', 'channel',
  ]);
  assert.ok(view.recentOutcomes.some((row) => row.outcome === 'positive'));
  assert.ok(view.recentOutcomes.some((row) => row.outcome === 'declined'));
  assert.ok(view.recentOutcomes.every((row) => row.nextActionLabel.length > 0));
});

test('Daily Outreach bounds oversized queues and marks contradictory reporting as unsafe', () => {
  const source = fixture();
  const first = source.prospects[0];
  assert.ok(first);
  const prospects = Array.from({ length: DAILY_OUTREACH_MAX_PROSPECTS + 4 }, (_, index) => ({
    ...first,
    prospectId: `bounded-test-prospect-${index}`,
  }));
  const view = presentDailyOutreach({
    ...source,
    nextProspectId: 'bounded-test-prospect-0',
    prospects,
    manager: {
      ...source.manager,
      validAttempts: 2,
      responses: 3,
      positiveResponses: 4,
    },
  });
  assert.equal(view.prospects.length, DAILY_OUTREACH_MAX_PROSPECTS);
  assert.equal(view.inputTruncated, true);
  assert.equal(view.manager.responseRateLabel, 'Unavailable');
  assert.equal(view.manager.positiveResponseRateLabel, 'Unavailable');
  assert.equal(view.integrity.coherent, false);
  assert.ok(view.integrity.issues.some((issue) => /contradictory/.test(issue)));
});

test('Daily Outreach renders premium responsive, touch and keyboard-accessible zero-effect UX', () => {
  const html = renderDailyOutreachBody(presentDailyOutreach(fixture()));
  assert.match(html, /data-property-predator-daily-outreach/);
  assert.match(html, /<article class="pdo" aria-labelledby="pdo-title" data-dataset="fictional_test" data-provider-effects="none" data-contact-effects="none" data-command-boundary="absent">/);
  assert.match(html, /Fill the tank\. <em>Start the right conversation\.<\/em>/);
  assert.match(html, /role="progressbar" aria-label="Daily outreach fuel: 7 completed of 12"/);
  assert.match(html, />7 \/ 12<\/strong><span>completed \/ target/);
  assert.match(html, /Channel × segment/);
  assert.match(html, /Next best fictional prospect/);
  assert.match(html, /Why this target/);
  assert.match(html, /MANUAL FIRST TOUCH/);
  assert.match(html, /ZERNIO-SUPPORTED/);
  assert.match(html, />BLOCKED<\/span>/);
  assert.match(html, /Immutable message evidence/);
  assert.match(html, /DRAFT · LOCKED/);
  assert.match(html, /APPROVED · EXACT VERSION/);
  assert.match(html, /Cooldown \/ stop/);
  assert.match(html, /Outcomes create the next move/);
  assert.match(html, /Control the work\. Read the result\./);
  assert.match(html, /Creator Watch · Authority Commenter preview/);
  assert.match(html, /Add value — or choose <em>no_comment<\/em>/);
  assert.match(html, /aria-label="Recorded Authority Commenter decision"/);
  assert.match(html, /aria-current="true">no_comment/);
  assert.match(html, /Cold activity ≠ LAPS Lead/);
  assert.match(html, /<details id="pdo-prospect-/);
  assert.match(html, /<summary>/);
  assert.match(html, /min-height:44px/);
  assert.match(html, /@media\(pointer:coarse\)/);
  assert.match(html, /@media\(max-width:880px\)/);
  assert.match(html, /@media\(max-width:600px\)/);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(html, /@media\(forced-colors:active\)/);
  assert.doesNotMatch(html, /<(?:form|button|input|textarea|select)\b/i);
  assert.doesNotMatch(html, /method="post"|Send now|Publish now|Connect provider|Go live/i);
});

test('Daily Outreach rendering escapes hostile prospect, outcome and creator content', () => {
  const source = fixture();
  const firstProspect = source.prospects[0];
  const firstOutcome = source.recentOutcomes[0];
  const firstWatch = source.creatorWatch[0];
  assert.ok(firstProspect);
  assert.ok(firstOutcome);
  assert.ok(firstWatch);
  const hostile: DailyOutreachSnapshot = {
    ...source,
    workspaceName: '</p><script>alert(1)</script>',
    prospects: [{
      ...firstProspect,
      personLabel: '<img src=x onerror=alert(2)> · FICTIONAL TEST PERSON',
      selectionReason: '<svg onload=alert(3)>',
      draft: { ...firstProspect.draft, body: '</blockquote><script>alert(4)</script>' },
    }, ...source.prospects.slice(1)],
    recentOutcomes: [{
      ...firstOutcome,
      nextActionLabel: '<img src=x onerror=alert(5)>',
    }, ...source.recentOutcomes.slice(1)],
    creatorWatch: [{
      ...firstWatch,
      creatorLabel: '</h3><script>alert(6)</script> · FICTIONAL TEST CREATOR',
      concretePoint: '<svg onload=alert(7)>',
    }, ...source.creatorWatch.slice(1)],
  };
  const html = renderDailyOutreachBody(presentDailyOutreach(hostile));
  assert.match(html, /&lt;\/p&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/);
  assert.match(html, /&lt;svg onload=alert\(3\)&gt;/);
  assert.match(html, /&lt;\/blockquote&gt;&lt;script&gt;alert\(4\)&lt;\/script&gt;/);
  assert.match(html, /&lt;\/h3&gt;&lt;script&gt;alert\(6\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<(?:script|img)\b|<svg\s+onload/i);
});

test('Daily Outreach fixture and presentation stay deterministic and immutable', () => {
  const snapshot = fixture();
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.prospects), true);
  assert.equal(Object.isFrozen(snapshot.prospects[0]?.draft), true);
  assert.equal(Object.isFrozen(snapshot.creatorWatch), true);
  const first = presentDailyOutreach(snapshot);
  const second = presentDailyOutreach(snapshot);
  assert.deepEqual(second, first);
  assert.equal(renderDailyOutreachBody(second), renderDailyOutreachBody(first));
});

test('Daily Outreach requires at least one bounded fictional prospect', () => {
  const source = fixture();
  assert.throws(
    () => presentDailyOutreach({ ...source, prospects: [] }),
    /requires at least one bounded fictional prospect/,
  );
});
