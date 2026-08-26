import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPropertyPredatorGrowthAnalyticsFixture,
  PROPERTY_PREDATOR_ANALYTICS_AS_OF,
} from '../src/portal/growth-analytics-fixtures.js';
import {
  GROWTH_ANALYTICS_MAX_CONTENT,
  GROWTH_ANALYTICS_MAX_TEXT,
  GROWTH_ANALYTICS_ROUTE,
  presentGrowthAnalytics,
  type GrowthAnalyticsSnapshot,
} from '../src/portal/growth-analytics-presenter.js';
import { renderGrowthAnalyticsBody } from '../src/portal/growth-analytics-view.js';

function fixture(): GrowthAnalyticsSnapshot {
  return createPropertyPredatorGrowthAnalyticsFixture();
}

test('Growth Analytics presents a coherent Property Predator TEST evidence command centre', () => {
  const view = presentGrowthAnalytics(fixture());
  assert.equal(GROWTH_ANALYTICS_ROUTE, '/portal/analytics');
  assert.equal(view.environment, 'test');
  assert.equal(view.environmentLabel, 'TEST');
  assert.equal(view.datasetKind, 'test_fixture');
  assert.equal(view.funnel.length, 6);
  assert.equal(view.content.length, 7);
  assert.equal(view.sources.length, 6);
  assert.equal(view.webinars.length, 2);
  assert.equal(view.cohorts.length, 5);
  assert.equal(view.qualitySignals.length, 5);
  assert.deepEqual(view.headline, {
    peopleLabel: '480',
    bookingsLabel: '20',
    revenueLabel: '£32,750',
    funnelConversionLabel: '1.5%',
  });
  assert.deepEqual(view.truthLedger, {
    measured: 25,
    simulated: 5,
    unavailable: 2,
    invalidMeasured: 0,
  });
  assert.equal(view.integrity.coherent, true);
  assert.equal(view.integrity.label, 'COHERENT');
  assert.equal(view.inputTruncated, false);
  assert.equal(view.readOnly, true);
  assert.equal(view.providerEffects, 'none');
});

test('milestone conversion keeps adjacent and entry denominators distinct', () => {
  const view = presentGrowthAnalytics(fixture());
  assert.deepEqual(view.funnel.map((row) => row.stepConversionLabel), [
    '100.0%',
    '65.0%',
    '62.8%',
    '39.8%',
    '29.5%',
    '30.4%',
  ]);
  assert.deepEqual(view.funnel.map((row) => row.totalConversionLabel), [
    '100.0%',
    '65.0%',
    '40.8%',
    '16.3%',
    '4.8%',
    '1.5%',
  ]);
  assert.deepEqual(view.funnel.map((row) => row.coherent), [true, true, true, true, true, true]);
  assert.equal(view.funnel[5]?.people, 7);
});

test('measured claims without exact evidence fail closed to unavailable', () => {
  const source = fixture();
  const measuredContent = source.content[0];
  const measuredSource = source.sources[0];
  assert.ok(measuredContent);
  assert.ok(measuredSource);
  const snapshot: GrowthAnalyticsSnapshot = {
    ...source,
    content: [{ ...measuredContent, evidenceRef: null }, ...source.content.slice(1)],
    sources: [{ ...measuredSource, observedAt: '2026-08-27T10:30:00.000Z' }, ...source.sources.slice(1)],
  };
  const view = presentGrowthAnalytics(snapshot);
  assert.equal(view.content[0]?.truth, 'unavailable');
  assert.equal(view.content[0]?.truthValid, false);
  assert.equal(view.content[0]?.influencedPeople, null);
  assert.equal(view.content[0]?.revenueLabel, 'Unavailable');
  assert.match(view.content[0]?.truthDetail ?? '', /failed closed/);
  assert.equal(view.sources[0]?.truth, 'unavailable');
  assert.equal(view.sources[0]?.bookings, null);
  assert.equal(view.sources[0]?.revenueLabel, 'Unavailable');
  assert.equal(view.truthLedger.invalidMeasured, 2);
  assert.equal(view.integrity.coherent, false);
  assert.equal(view.integrity.label, 'CHECK REQUIRED');
});

test('simulated values remain visible but never enter measured headline totals', () => {
  const source = fixture();
  const simulated = source.sources.find((row) => row.truth === 'simulated');
  assert.ok(simulated);
  const inflated = source.sources.map((row) => row.sourceId === simulated.sourceId ? {
    ...row,
    leads: 9_000_000,
    qualified: 8_000_000,
    bookings: 7_000_000,
    attributedRevenuePence: 99_000_000_00,
  } : row);
  const view = presentGrowthAnalytics({ ...source, sources: inflated });
  assert.equal(view.headline.bookingsLabel, '20');
  assert.equal(view.headline.revenueLabel, '£32,750');
  assert.equal(view.sources.find((row) => row.sourceId === simulated.sourceId)?.truthLabel, 'SIMULATED');
  assert.match(view.sources.find((row) => row.sourceId === simulated.sourceId)?.truthDetail ?? '', /planning or rehearsal/);
});

test('contradictory funnel, source and webinar sequences are surfaced as integrity issues', () => {
  const source = fixture();
  const second = source.funnel[1];
  const firstSource = source.sources[0];
  const webinar = source.webinars[0];
  assert.ok(second);
  assert.ok(firstSource);
  assert.ok(webinar);
  const view = presentGrowthAnalytics({
    ...source,
    funnel: [source.funnel[0]!, { ...second, people: 999 }, ...source.funnel.slice(2)],
    sources: [{ ...firstSource, qualified: 150, bookings: 151 }, ...source.sources.slice(1)],
    webinars: [{ ...webinar, registrations: 20, attended: 58 }, ...source.webinars.slice(1)],
  });
  assert.equal(view.funnel[1]?.coherent, false);
  assert.equal(view.funnel[1]?.stepConversionLabel, 'Unavailable');
  assert.equal(view.integrity.coherent, false);
  assert.equal(view.integrity.issueCount, 3);
  assert.match(view.integrity.detail, /3 evidence or sequence checks/);
});

test('analytics bounds oversized collections and display text without claiming completeness', () => {
  const source = fixture();
  const first = source.content[0];
  assert.ok(first);
  const longTitle = 'X'.repeat(GROWTH_ANALYTICS_MAX_TEXT + 50);
  const content = Array.from({ length: GROWTH_ANALYTICS_MAX_CONTENT + 5 }, (_, index) => ({
    ...first,
    contentVersionId: `version-${index}`,
    title: `${longTitle}-${index}`,
  }));
  const view = presentGrowthAnalytics({ ...source, content });
  assert.equal(view.content.length, GROWTH_ANALYTICS_MAX_CONTENT);
  assert.equal(view.content[0]?.title.length, GROWTH_ANALYTICS_MAX_TEXT);
  assert.equal(view.inputTruncated, true);
  assert.equal(view.integrity.coherent, false);
  assert.match(renderGrowthAnalyticsBody(view), /Safe display bound reached/);
});

test('analytics rendering escapes hostile workspace, content, source, webinar, cohort and quality text', () => {
  const source = fixture();
  const hostile: GrowthAnalyticsSnapshot = {
    ...source,
    workspaceName: '</p><script>alert(1)</script>',
    datasetLabel: '<img src=x onerror=alert(2)>',
    funnel: [{ ...source.funnel[0]!, label: '<svg onload=alert(3)>' }, ...source.funnel.slice(1)],
    content: [{ ...source.content[0]!, title: '"><script>alert(4)</script>' }, ...source.content.slice(1)],
    sources: [{ ...source.sources[0]!, affiliateLabel: '<img src=x onerror=alert(5)>' }, ...source.sources.slice(1)],
    webinars: [{ ...source.webinars[0]!, title: '<svg onload=alert(6)>' }, ...source.webinars.slice(1)],
    cohorts: [{ ...source.cohorts[0]!, label: '</article><script>alert(7)</script>' }, ...source.cohorts.slice(1)],
    qualitySignals: [{ ...source.qualitySignals[0]!, detail: '<img src=x onerror=alert(8)>' }, ...source.qualitySignals.slice(1)],
  };
  const html = renderGrowthAnalyticsBody(presentGrowthAnalytics(hostile));
  assert.doesNotMatch(html, /<(?:script|img|svg)\b/i);
  assert.ok(html.includes('&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/);
  assert.match(html, /&lt;svg onload=alert\(3\)&gt;/);
  assert.match(html, /Affiliate · &lt;img src=x onerror=alert\(5\)&gt;/);
  assert.ok(html.includes('&lt;/article&gt;&lt;script&gt;alert(7)&lt;/script&gt;'));
});

test('Growth Analytics renders premium responsive read-only UX with explicit truth labels', () => {
  const html = renderGrowthAnalyticsBody(presentGrowthAnalytics(fixture()));
  assert.match(html, /data-property-predator-growth-analytics/);
  assert.match(html, /<article class="pga" aria-labelledby="pga-title" data-environment="test" data-dataset-kind="test_fixture" data-read-only="true" data-provider-effects="none">/);
  assert.match(html, /Know what moved\. <em>Prove what paid\.<\/em>/);
  assert.match(html, /Measured is not a synonym for live/);
  assert.match(html, /not production performance/);
  assert.match(html, /Milestone truth, person by person/);
  assert.match(html, /Content → revenue attribution/);
  assert.match(html, /Channel, source &amp; affiliate truth/);
  assert.match(html, /Affiliate · The Developers Circle · TEST affiliate/);
  assert.match(html, /Webinar contribution/);
  assert.match(html, /Cohort trend/);
  assert.match(html, /Identity confidence/);
  assert.match(html, /Data quality watch/);
  assert.match(html, /Truth ledger/);
  assert.match(html, />MEASURED<\/span>/);
  assert.match(html, />SIMULATED<\/span>/);
  assert.match(html, />UNAVAILABLE<\/span>/);
  assert.match(html, /Attribution is a decision model, not causal proof/);
  assert.match(html, /@media\(max-width:1100px\)/);
  assert.match(html, /@media\(max-width:760px\)/);
  assert.match(html, /@media\(max-width:480px\)/);
  assert.match(html, /@media\(forced-colors:active\)/);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(html, /<(?:form|button|input)\b/i);
  assert.doesNotMatch(html, /Send now|Publish now|Go live|Connect provider/i);
});

test('Growth Analytics presentation is deterministic for the same evidence snapshot', () => {
  const source = fixture();
  assert.equal(source.asOf, PROPERTY_PREDATOR_ANALYTICS_AS_OF);
  const first = presentGrowthAnalytics(source);
  const second = presentGrowthAnalytics(source);
  assert.deepEqual(second, first);
  assert.equal(renderGrowthAnalyticsBody(second), renderGrowthAnalyticsBody(first));
});
