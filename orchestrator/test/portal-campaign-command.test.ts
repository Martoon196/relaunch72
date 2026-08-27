import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPropertyPredatorCampaignCommandFixture,
  PROPERTY_PREDATOR_CAMPAIGN_COMMAND_AS_OF,
} from '../src/portal/campaign-command-fixtures.js';
import {
  CAMPAIGN_COMMAND_MAX_CONTENT,
  CAMPAIGN_COMMAND_ROUTE,
  presentCampaignCommand,
  type CampaignCommandSnapshot,
} from '../src/portal/campaign-command-presenter.js';
import { renderCampaignCommandBody } from '../src/portal/campaign-command-view.js';

const OPTIONS = Object.freeze({
  workspaceName: 'Property Predator Growth HQ',
  asOf: PROPERTY_PREDATOR_CAMPAIGN_COMMAND_AS_OF,
});

function present(snapshot = createPropertyPredatorCampaignCommandFixture()) {
  return presentCampaignCommand(snapshot, OPTIONS);
}

test('Campaign Command assembles one immutable campaign system and opens only the TEST rehearsal gate', () => {
  const view = present();
  assert.equal(CAMPAIGN_COMMAND_ROUTE, '/portal/campaigns');
  assert.equal(view.revision.state, 'immutable');
  assert.equal(view.revision.environment, 'test');
  assert.equal(view.revision.revisionNumber, 4);
  assert.equal(view.revision.immutableProofValid, true);
  assert.equal(view.offer.offerId, 'offer-opportunity-autopsy');
  assert.equal(view.cohort.dataTruth, 'simulated');
  assert.equal(view.cohort.eligiblePeople, 420);
  assert.equal(view.journey.milestones.length, 6);
  assert.equal(view.contentVersions.length, 4);
  assert.equal(view.channels.length, 5);
  assert.ok(view.contentVersions.every((content) => content.gatePasses));
  assert.ok(view.channels.every((channel) => channel.gatePasses));
  assert.equal(view.webinar.gatePasses, true);
  assert.deepEqual(view.activationGate, {
    open: true,
    label: 'REHEARSAL READY',
    headline: 'The exact TEST campaign can enter rehearsal.',
    detail: 'All deterministic checks pass for this immutable revision. Controls remain disabled: no command boundary or provider call exists.',
    passed: 10,
    total: 10,
    checks: view.activationGate.checks,
    blockers: [],
  });
  assert.equal(view.commandBoundaryAvailable, false);
  assert.equal(view.providerEffects, 'none');
});

test('Campaign Command keeps simulated targets separate from unavailable measured performance', () => {
  const view = present();
  assert.deepEqual(view.journey.milestones.map((milestone) => milestone.targetCount), [420, 260, 96, 58, 34, 14]);
  assert.ok(view.targets.every((target) => target.source === 'simulated_plan'));
  assert.deepEqual(view.metricTruth, { simulated: 3, measured: 0, unavailable: 4 });
  assert.ok(view.metrics.filter((metric) => metric.truth === 'simulated').every((metric) => metric.truthLabel === 'SIMULATED'));
  assert.ok(view.metrics.filter((metric) => metric.truth === 'unavailable').every((metric) => (
    metric.value === null && metric.displayValue === 'Not connected' && metric.truthLabel === 'UNAVAILABLE'
  )));
  assert.equal(view.metrics.some((metric) => metric.truth === 'measured'), false);
  assert.equal(view.activationGate.checks.find((check) => check.key === 'truth')?.passed, true);
});

test('Campaign Command fails closed when immutable revision approval points at another hash', () => {
  const fixture = createPropertyPredatorCampaignCommandFixture();
  const firstApproval = fixture.approvals[0];
  assert.ok(firstApproval);
  const snapshot: CampaignCommandSnapshot = {
    ...fixture,
    approvals: [{ ...firstApproval, subjectSha256: 'f'.repeat(64) }, ...fixture.approvals.slice(1)],
  };
  const view = present(snapshot);
  assert.equal(view.activationGate.open, false);
  assert.equal(view.activationGate.label, 'LOCKED');
  assert.equal(view.activationGate.checks.find((check) => check.key === 'revision')?.passed, true);
  assert.equal(view.activationGate.checks.find((check) => check.key === 'approvals')?.passed, false);
  assert.equal(view.approvals[0]?.exactSubject, false);
  assert.equal(view.approvals[0]?.statusLabel, 'Approval mismatch');
});

test('Campaign Command closes content, channel and webinar gates when exact source proof expires', () => {
  const fixture = createPropertyPredatorCampaignCommandFixture();
  const webinarContentIndex = fixture.contentVersions.findIndex((content) => content.contentVersionId === fixture.webinar.contentVersionId);
  const webinarContent = fixture.contentVersions[webinarContentIndex];
  assert.ok(webinarContent);
  const contentVersions = [...fixture.contentVersions];
  contentVersions[webinarContentIndex] = { ...webinarContent, sourceProofExpiresAt: PROPERTY_PREDATOR_CAMPAIGN_COMMAND_AS_OF };
  const view = present({ ...fixture, contentVersions });
  assert.equal(view.activationGate.open, false);
  assert.equal(view.activationGate.checks.find((check) => check.key === 'content')?.passed, false);
  assert.equal(view.activationGate.checks.find((check) => check.key === 'webinar')?.passed, false);
  assert.equal(view.webinar.gatePasses, false);
  assert.match(view.webinar.gateDetail, /not exactly approved and fresh/);
});

test('Campaign Command rejects impossible conversion targets and ambiguous metric truth', () => {
  const fixture = createPropertyPredatorCampaignCommandFixture();
  const secondTarget = fixture.targets[1];
  const unavailableMetric = fixture.metrics.find((metric) => metric.truth === 'unavailable');
  assert.ok(secondTarget);
  assert.ok(unavailableMetric);
  const snapshot: CampaignCommandSnapshot = {
    ...fixture,
    targets: [fixture.targets[0]!, { ...secondTarget, targetCount: 999 }, ...fixture.targets.slice(2)],
    metrics: fixture.metrics.map((metric) => metric.metricId === unavailableMetric.metricId
      ? { ...metric, value: 123 }
      : metric),
  };
  const view = present(snapshot);
  assert.equal(view.activationGate.open, false);
  assert.equal(view.activationGate.checks.find((check) => check.key === 'targets')?.passed, false);
  assert.equal(view.activationGate.checks.find((check) => check.key === 'truth')?.passed, false);
  assert.equal(view.metrics.find((metric) => metric.metricId === unavailableMetric.metricId)?.truthful, false);
});

test('Campaign Command bounds oversized inputs and fails closed despite visible checks', () => {
  const fixture = createPropertyPredatorCampaignCommandFixture();
  const source = fixture.contentVersions[0];
  assert.ok(source);
  const snapshot: CampaignCommandSnapshot = {
    ...fixture,
    contentVersions: Array.from({ length: CAMPAIGN_COMMAND_MAX_CONTENT + 4 }, (_, index) => ({
      ...source,
      contentItemId: `item-${index}`,
      contentVersionId: `version-${index}`,
      contentSha256: (index % 10).toString().repeat(64),
      approvedContentVersionId: `version-${index}`,
      approvedContentSha256: (index % 10).toString().repeat(64),
    })),
  };
  const view = present(snapshot);
  assert.equal(view.contentVersions.length, CAMPAIGN_COMMAND_MAX_CONTENT);
  assert.equal(view.inputTruncated, true);
  assert.equal(view.activationGate.open, false);
  assert.match(view.activationGate.detail, /safe evaluation bound/);
  assert.match(renderCampaignCommandBody(view), /fails closed/);
});

test('Campaign Command renders premium responsive command UX with disabled TEST controls only', () => {
  const html = renderCampaignCommandBody(present());
  assert.match(html, /<nav class="pp-content-nav" aria-label="Content operations">/);
  assert.match(html, /href="\/portal\/campaigns" aria-current="page">Campaigns/);
  assert.match(html, /data-property-predator-campaign-command/);
  assert.match(html, /<article class="ccm" aria-labelledby="ccm-title" data-environment="test" data-provider-effects="none" data-command-boundary="absent">/);
  assert.match(html, /A campaign is a system\. <em>Command it\.<\/em>/);
  assert.match(html, /One controlled path from person to offer/);
  assert.match(html, /Conversion target spine/);
  assert.match(html, /SIMULATED planning targets/);
  assert.match(html, /Channel choreography/);
  assert.match(html, /Webinar conversion room/);
  assert.match(html, /Owned content manifest/);
  assert.match(html, /Spend & metric truth/);
  assert.match(html, /No measured performance is loaded/);
  assert.match(html, /Activation ledger/);
  assert.match(html, /Next operator actions/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-label="Disabled TEST rehearsal controls"/);
  assert.match(html, /Start TEST rehearsal · unavailable/);
  assert.match(html, /Activate campaign · unavailable/);
  assert.equal((html.match(/disabled aria-disabled="true"/g) ?? []).length, 2);
  assert.match(html, /No send · no publish · no spend/);
  assert.match(html, /aria-label="Campaign planning views"/);
  assert.doesNotMatch(html, /href="\/portal\/content\/compose"/);
  assert.match(html, /Composer remains offline until its company-content adapter is mounted/);
  assert.match(html, /\/portal\/content\/calendar\?mode=week&amp;date=2026-08-27&amp;channel=all/);
  assert.match(html, /min-height:46px/);
  assert.match(html, /@media\(max-width:920px\)/);
  assert.match(html, /@media\(max-width:440px\)/);
  assert.match(html, /@media\(forced-colors:active\)/);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(html, /<form|method="post"|Publish now|Send now|providerToken|accessToken|apiKey|secretKey/i);
});

test('Campaign Command escapes hostile campaign, cohort, offer, metric and operator text', () => {
  const fixture = createPropertyPredatorCampaignCommandFixture();
  const metric = fixture.metrics[0];
  const action = fixture.nextActions[0];
  assert.ok(metric);
  assert.ok(action);
  const hostile: CampaignCommandSnapshot = {
    ...fixture,
    revision: { ...fixture.revision, objective: '</p><script>alert(1)</script>' },
    cohort: { ...fixture.cohort, label: '<img src=x onerror=alert(2)> A&B' },
    offer: { ...fixture.offer, label: '"><script>alert(3)</script>' },
    metrics: [{ ...metric, detail: '</p><img src=x onerror=alert(4)>' }, ...fixture.metrics.slice(1)],
    nextActions: [{ ...action, label: '<svg onload=alert(5)>' }, ...fixture.nextActions.slice(1)],
  };
  const html = renderCampaignCommandBody(presentCampaignCommand(hostile, {
    ...OPTIONS,
    workspaceName: '<script>alert(6)</script>',
  }));
  assert.match(html, /&lt;\/p&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt; A&amp;B/);
  assert.match(html, /&quot;&gt;&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.match(html, /&lt;svg onload=alert\(5\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(6\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<(?:script|img|svg)\b/i);
});

test('Campaign Command presentation is deterministic for the same immutable snapshot', () => {
  const fixture = createPropertyPredatorCampaignCommandFixture();
  const first = presentCampaignCommand(fixture, OPTIONS);
  const second = presentCampaignCommand(fixture, OPTIONS);
  assert.deepEqual(second, first);
  assert.equal(renderCampaignCommandBody(second), renderCampaignCommandBody(first));
});
