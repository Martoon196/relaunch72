import assert from 'node:assert/strict';
import test from 'node:test';
import type { SocialCampaignCommandProjection } from '../src/social-campaign-pg/types.js';
import { createPropertyPredatorPublicSocialCampaignsFixture } from '../src/portal/public-social-campaigns-fixtures.js';
import {
  presentPublicSocialCampaigns,
  PublicSocialCampaignsPresentationError,
  PUBLIC_SOCIAL_CAMPAIGNS_MAX_PROJECTIONS,
  PUBLIC_SOCIAL_CAMPAIGNS_ROUTE,
} from '../src/portal/public-social-campaigns-presenter.js';
import { renderPublicSocialCampaignsBody } from '../src/portal/public-social-campaigns-view.js';

const IDS = Object.freeze({
  campaign: '11111111-1111-4111-8111-111111111111',
  revision: '22222222-2222-4222-8222-222222222222',
  post: '33333333-3333-4333-8333-333333333333',
  item: '44444444-4444-4444-8444-444444444444',
  version: '55555555-5555-4555-8555-555555555555',
  operation: '66666666-6666-4666-8666-666666666666',
  target: '77777777-7777-4777-8777-777777777777',
});

const OPTIONS = Object.freeze({
  workspaceName: 'Property Predator Growth HQ',
  workspaceTimezone: 'Europe/London',
  snapshotAt: '2026-08-27T12:00:00.000Z',
  requestedCampaignId: IDS.campaign,
  inputTruncated: false,
});

function projection(
  overrides: Partial<SocialCampaignCommandProjection> = {},
): SocialCampaignCommandProjection {
  return Object.freeze({
    campaignId: IDS.campaign,
    revisionId: IDS.revision,
    revisionNumber: 3,
    revisionSha256: 'a'.repeat(64),
    title: 'Predator Signal Sprint',
    objective: 'Move approved opportunity education into a measured TEST rhythm.',
    timezone: 'Europe/London',
    postId: IDS.post,
    contentItemId: IDS.item,
    contentVersionId: IDS.version,
    contentSha256: 'b'.repeat(64),
    planSha256: 'c'.repeat(64),
    scheduledFor: '2026-08-28T09:30:00.000Z',
    operationId: IDS.operation,
    targetId: IDS.target,
    network: 'linkedin',
    targetLabel: 'LinkedIn TEST rail',
    state: 'simulated_succeeded',
    simulationAttemptCount: 1,
    maxSimulationAttempts: 3,
    reconciliationAttemptCount: 0,
    maxReconciliationAttempts: 3,
    testReferenceSha256: 'd'.repeat(64),
    environment: 'test',
    providerEffects: 'none',
    ...overrides,
  });
}

test('presents exact campaign, revision, post and target TEST provenance without unsafe fields', () => {
  const secondOperation = projection({
    operationId: '88888888-8888-4888-8888-888888888888',
    targetId: '99999999-9999-4999-8999-999999999999',
    network: 'instagram',
    targetLabel: 'Instagram TEST rail',
    state: 'reconciliation_required',
    simulationAttemptCount: 2,
    reconciliationAttemptCount: 1,
    testReferenceSha256: null,
  });
  const view = presentPublicSocialCampaigns([projection(), secondOperation], OPTIONS);

  assert.equal(view.route, PUBLIC_SOCIAL_CAMPAIGNS_ROUTE);
  assert.equal(view.campaignId, IDS.campaign);
  assert.equal(view.campaignTitle, 'Predator Signal Sprint');
  assert.equal(view.calendarHref, '/portal/content/calendar?mode=week&date=2026-08-27&channel=all');
  assert.deepEqual(view.summary, {
    revisionCount: 1,
    postCount: 1,
    targetCount: 2,
    attentionCount: 1,
  });
  assert.equal(view.revisions[0]?.posts[0]?.contentSha256, 'b'.repeat(64));
  assert.equal(view.revisions[0]?.posts[0]?.planSha256, 'c'.repeat(64));
  assert.deepEqual(
    view.revisions[0]?.posts[0]?.targets.map((target) => target.network),
    ['instagram', 'linkedin'],
  );
  assert.equal(view.revisions[0]?.posts[0]?.targets[0]?.stateTone, 'attention');
  assert.equal(view.revisions[0]?.posts[0]?.receiptCount, 1);
  assert.deepEqual(
    view.revisions[0]?.posts[0]?.launchSteps.map((step) => [step.key, step.tone]),
    [
      ['content', 'complete'],
      ['builder', 'complete'],
      ['calendar', 'complete'],
      ['approval', 'complete'],
      ['queue', 'attention'],
      ['receipt', 'working'],
    ],
  );
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.revisions), true);
  assert.doesNotMatch(
    JSON.stringify(view),
    /"(?:body|text|testAccountRef|accountRef|storageKey|connectionId|credential|secret|token)"/i,
  );
});

test('renders an accessible responsive Property Predator read-only command surface', () => {
  const failed = projection({
    state: 'dead_letter',
    simulationAttemptCount: 3,
    reconciliationAttemptCount: 3,
    testReferenceSha256: null,
  });
  const html = renderPublicSocialCampaignsBody(
    presentPublicSocialCampaigns([failed], OPTIONS),
    { companyAssetsAvailable: true, brandBrainAvailable: true },
  );

  assert.match(html, /Property Predator · Public-social command truth/);
  assert.match(html, /data-environment="test"/);
  assert.match(html, /data-provider-effects="none"/);
  assert.match(html, /data-read-only="true"/);
  assert.match(html, /Authenticated read model · TEST only/);
  assert.match(html, /href="\/portal\/campaigns\/new">Build TEST campaign<\/a>/);
  assert.match(html, /Open TEST calendar/);
  assert.match(html, /data-campaign-launch-runway/);
  assert.match(html, /TEST launch runway/);
  assert.match(html, /Approved company content/);
  assert.match(html, /Campaign Builder/);
  assert.match(html, /Campaign Calendar/);
  assert.match(html, /Approval \+ source gate/);
  assert.match(html, /Dark simulator queue/);
  assert.match(html, /Simulated evidence/);
  assert.match(html, /No simulator receipt hash has been recorded/);
  assert.match(html, /TEST dead letter/);
  assert.match(html, /role="status"/);
  assert.match(html, new RegExp(IDS.campaign));
  assert.match(html, new RegExp(IDS.revision));
  assert.match(html, new RegExp(IDS.post));
  assert.match(html, new RegExp(IDS.operation));
  assert.match(html, new RegExp('a'.repeat(64)));
  assert.match(html, new RegExp('b'.repeat(64)));
  assert.match(html, new RegExp('c'.repeat(64)));
  assert.match(html, /Post bodies, account references, storage paths and secrets are absent/);
  assert.match(html, /@media\(max-width:680px\)/);
  assert.match(html, /@media\(forced-colors:active\)/);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(html, /min-height:44px/);
  assert.doesNotMatch(html, /<(?:form|button|input|textarea|select|script)\b/i);
  assert.doesNotMatch(html, /(?:Activate campaign|Publish now|Retry now|Cancel operation)/i);
  assert.doesNotMatch(html, /test-account:|storageKey|connectionId|providerToken|body text/i);
});

test('launch runway shows a complete TEST chain only when every target has settled receipt evidence', () => {
  const secondOperation = projection({
    operationId: '88888888-8888-4888-8888-888888888888',
    targetId: '99999999-9999-4999-8999-999999999999',
    network: 'instagram',
    targetLabel: 'Instagram TEST rail',
    state: 'simulated_reconciled',
    reconciliationAttemptCount: 1,
    testReferenceSha256: 'e'.repeat(64),
  });
  const view = presentPublicSocialCampaigns([projection(), secondOperation], OPTIONS);
  const post = view.revisions[0]?.posts[0];
  assert.ok(post);
  assert.equal(post.receiptCount, 2);
  assert.equal(post.launchSteps.find((step) => step.key === 'queue')?.tone, 'complete');
  assert.equal(post.launchSteps.find((step) => step.key === 'receipt')?.tone, 'complete');
  const html = renderPublicSocialCampaignsBody(view);
  assert.match(html, /2 receipts sealed/);
  assert.match(html, /They prove simulation, never publication/);
});

test('launch runway does not claim approval materialisation or receipt evidence for a post-only plan', () => {
  const postOnly = projection({
    operationId: null,
    targetId: null,
    network: null,
    targetLabel: null,
    state: null,
    simulationAttemptCount: null,
    maxSimulationAttempts: null,
    reconciliationAttemptCount: null,
    maxReconciliationAttempts: null,
    testReferenceSha256: null,
  });
  const post = presentPublicSocialCampaigns([postOnly], OPTIONS).revisions[0]?.posts[0];
  assert.ok(post);
  assert.equal(post.receiptCount, 0);
  assert.deepEqual(
    post.launchSteps.slice(3).map((step) => [step.key, step.stateLabel, step.tone]),
    [
      ['approval', 'Awaiting operation proof', 'planned'],
      ['queue', 'No target operation yet', 'planned'],
      ['receipt', 'Awaiting TEST evidence', 'planned'],
    ],
  );
});

test('launch runway distinguishes a cancelled TEST operation from queued or published work', () => {
  const cancelled = projection({
    state: 'simulated_cancelled',
    simulationAttemptCount: 0,
    testReferenceSha256: null,
  });
  const post = presentPublicSocialCampaigns([cancelled], OPTIONS).revisions[0]?.posts[0];
  assert.ok(post);
  assert.deepEqual(
    post.launchSteps.slice(4).map((step) => [step.key, step.stateLabel, step.tone]),
    [
      ['queue', 'TEST operations cancelled', 'cancelled'],
      ['receipt', 'No receipt expected · cancelled', 'cancelled'],
    ],
  );
});

test('Property Predator preview fixture demonstrates both a complete launch and a revalidation attention path', () => {
  const fixture = presentPublicSocialCampaigns(
    createPropertyPredatorPublicSocialCampaignsFixture(),
    {
      ...OPTIONS,
      requestedCampaignId: 'a1000000-0000-4000-8000-000000000001',
    },
  );
  const posts = fixture.revisions[0]?.posts ?? [];
  assert.equal(posts.length, 2);
  assert.equal(posts[0]?.receiptCount, 2);
  assert.equal(posts[0]?.launchSteps.find((step) => step.key === 'queue')?.tone, 'complete');
  assert.equal(posts[0]?.launchSteps.find((step) => step.key === 'receipt')?.tone, 'complete');
  assert.equal(posts[1]?.launchSteps.find((step) => step.key === 'queue')?.tone, 'attention');
  assert.equal(posts[1]?.launchSteps.find((step) => step.key === 'receipt')?.tone, 'attention');
});

test('presents the complete nine-network and ten-state TEST taxonomy without inventing live states', () => {
  const networks = [
    'facebook', 'instagram', 'linkedin', 'tiktok', 'x', 'youtube',
    'google_business_profile', 'threads', 'pinterest',
  ] as const;
  const states = [
    'waiting_for_test_time', 'leased', 'calling_simulator', 'retry_wait',
    'simulated_succeeded', 'simulated_failed', 'simulated_cancelled',
    'reconciliation_required', 'simulated_reconciled', 'dead_letter',
  ] as const;
  const rows = states.map((state, index) => projection({
    operationId: `00000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`,
    targetId: `00000000-0000-4000-8000-${String(200 + index).padStart(12, '0')}`,
    network: networks[index % networks.length],
    targetLabel: `${networks[index % networks.length]} TEST rail`,
    state,
    simulationAttemptCount: state === 'waiting_for_test_time' ? 0 : 1,
    reconciliationAttemptCount: state === 'reconciliation_required'
      || state === 'simulated_reconciled' ? 1 : 0,
    testReferenceSha256: state === 'simulated_succeeded' || state === 'simulated_reconciled'
      ? `${index.toString(16)}`.repeat(64)
      : null,
  }));
  const targets = presentPublicSocialCampaigns(rows, OPTIONS).revisions[0]?.posts[0]?.targets ?? [];

  assert.deepEqual(new Set(targets.map((target) => target.state)), new Set(states));
  assert.deepEqual(new Set(targets.map((target) => target.network)), new Set(networks));
  assert.equal(targets.filter((target) => target.attention).length, 3);
  assert.ok(targets.every((target) => target.stateLabel.length > 0 && target.stateDetail.length > 0));
});

test('fails closed on unsafe extensions, live effects and inconsistent immutable evidence', () => {
  const unsafe = {
    ...projection(),
    body: 'must not cross the read boundary',
    testAccountRef: 'private-test-account',
  } as unknown as SocialCampaignCommandProjection;
  assert.throws(
    () => presentPublicSocialCampaigns([unsafe], OPTIONS),
    (error: unknown) => error instanceof PublicSocialCampaignsPresentationError
      && /unsupported field (?:body|testAccountRef)/.test(error.message),
  );
  assert.throws(
    () => presentPublicSocialCampaigns([
      projection({ providerEffects: 'live' as never }),
    ], OPTIONS),
    /zero-effect TEST projection/,
  );
  assert.throws(
    () => presentPublicSocialCampaigns([
      projection({ contentVersionId: null }),
    ], OPTIONS),
    /incomplete post provenance/,
  );
  assert.throws(
    () => presentPublicSocialCampaigns([
      projection({ operationId: null }),
    ], OPTIONS),
    /target evidence without an operation/,
  );
  assert.throws(
    () => presentPublicSocialCampaigns([
      projection({ testReferenceSha256: null }),
    ], OPTIONS),
    /complete without an exact TEST receipt hash/,
  );
});

test('rejects cross-campaign mixtures, duplicate operations, conflicts and oversized projections', () => {
  assert.throws(
    () => presentPublicSocialCampaigns([
      projection(),
      projection({
        campaignId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
    ], { ...OPTIONS, requestedCampaignId: null }),
    /more than one campaign/,
  );
  assert.throws(
    () => presentPublicSocialCampaigns([projection(), projection()], OPTIONS),
    /appears more than once/,
  );
  assert.throws(
    () => presentPublicSocialCampaigns([
      projection(),
      projection({
        operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        targetId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        contentSha256: 'e'.repeat(64),
      }),
    ], OPTIONS),
    /conflicting immutable provenance/,
  );
  assert.throws(
    () => presentPublicSocialCampaigns(
      Array.from({ length: PUBLIC_SOCIAL_CAMPAIGNS_MAX_PROJECTIONS + 1 }, projection),
      OPTIONS,
    ),
    /exceed the 120-row bound/,
  );
});

test('empty projection is truthful and renders no fictional campaign or outbound control', () => {
  const view = presentPublicSocialCampaigns([], OPTIONS);
  assert.equal(view.campaignId, IDS.campaign);
  assert.equal(view.campaignTitle, null);
  assert.equal(view.summary.targetCount, 0);
  const html = renderPublicSocialCampaignsBody(view);
  assert.match(html, /No exact campaign projection loaded/);
  assert.match(html, /No demo campaign has been substituted/);
  assert.match(html, /Open the TEST calendar/);
  assert.doesNotMatch(html, /<(?:form|button|input|script)\b/i);
});

test('database-proven continuation is visible and all displayed counts are qualified as loaded', () => {
  const view = presentPublicSocialCampaigns([projection()], {
    ...OPTIONS,
    inputTruncated: true,
  });
  assert.equal(view.inputTruncated, true);
  const html = renderPublicSocialCampaignsBody(view);
  assert.match(html, /data-input-truncated="true"/);
  assert.match(html, /Safe read boundary reached/);
  assert.match(html, /complete post aggregates/);
  assert.match(html, /Loaded revisions/);
  assert.match(html, /additional evidence omitted/);
  assert.doesNotMatch(html, /Every fact visible/);
});

test('escapes allowlisted campaign copy while keeping exact hashes and IDs intact', () => {
  const html = renderPublicSocialCampaignsBody(presentPublicSocialCampaigns([
    projection({
      title: '<img src=x onerror=alert(1)>',
      objective: 'Teach & convert <without pretending>.',
      targetLabel: 'Owned "TEST" rail',
    }),
  ], OPTIONS));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /Teach &amp; convert &lt;without pretending&gt;\./);
  assert.match(html, /Owned &quot;TEST&quot; rail/);
  assert.doesNotMatch(html, /<img src=x/);
});

test('rejects Unicode bidi controls that could visually spoof campaign or target labels', () => {
  assert.throws(
    () => presentPublicSocialCampaigns([
      projection({ title: 'Trusted campaign\u202egnp.exe' }),
    ], OPTIONS),
    /title is invalid/,
  );
  assert.throws(
    () => presentPublicSocialCampaigns([
      projection({ targetLabel: 'LinkedIn rail\u2066spoof' }),
    ], OPTIONS),
    /targetLabel is invalid/,
  );
});

test('preserves allowlisted calendar context and canonicalises hostile return filters', () => {
  const contextual = presentPublicSocialCampaigns([projection()], {
    ...OPTIONS,
    calendarFilters: { mode: 'month', date: '2026-10-12', channel: 'instagram' },
  });
  assert.equal(
    contextual.calendarHref,
    '/portal/content/calendar?mode=month&date=2026-10-12&channel=instagram',
  );
  assert.match(
    renderPublicSocialCampaignsBody(contextual),
    /href="\/portal\/content\/calendar\?mode=month&amp;date=2026-10-12&amp;channel=instagram"/,
  );

  const hostile = presentPublicSocialCampaigns([projection()], {
    ...OPTIONS,
    calendarFilters: {
      mode: 'month<script>', date: '2026-02-31', channel: 'instagram<script>',
    },
  });
  assert.equal(hostile.calendarHref, '/portal/content/calendar?mode=week&date=2026-08-27&channel=all');
});
