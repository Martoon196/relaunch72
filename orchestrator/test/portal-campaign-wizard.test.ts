import assert from 'node:assert/strict';
import test from 'node:test';
import {
  campaignWizardNoticeFromQuery,
  campaignWizardNoticeToken,
  isCampaignWizardCreateActionReady,
} from '../src/portal/campaign-wizard-actions.js';
import {
  presentCampaignWizard,
  type CampaignWizardContentSnapshot,
  type CampaignWizardSnapshot,
} from '../src/portal/campaign-wizard-presenter.js';
import { renderCampaignWizardBody } from '../src/portal/campaign-wizard-view.js';

const COPY: CampaignWizardContentSnapshot = Object.freeze({
  contentItemId: '11111111-1111-4111-8111-111111111111',
  contentVersionId: '22222222-2222-4222-8222-222222222222',
  contentSha256: 'a'.repeat(64),
  title: 'Investor signal sprint',
  versionNumber: 3,
  kindLabel: 'Social post',
  approvalStatus: 'approved',
  sourceFresh: true,
  publishable: true,
});
const MEDIA: CampaignWizardContentSnapshot = Object.freeze({
  ...COPY,
  contentItemId: '33333333-3333-4333-8333-333333333333',
  contentVersionId: '44444444-4444-4444-8444-444444444444',
  contentSha256: 'b'.repeat(64),
  title: 'Property Predator launch artwork',
  kindLabel: 'Artwork',
});
const SNAPSHOT: CampaignWizardSnapshot = Object.freeze({
  content: Object.freeze([COPY, { ...COPY, contentVersionId: '55555555-5555-4555-8555-555555555555', approvalStatus: 'pending' as const }]),
  media: Object.freeze([MEDIA]),
  targets: Object.freeze([{
    targetId: '66666666-6666-4666-8666-666666666666',
    network: 'linkedin' as const,
    targetLabel: 'Property Predator LinkedIn TEST target',
    planningEnabled: true,
    environment: 'test' as const,
    providerEffects: 'none' as const,
  }]),
  sourceTruncated: false,
});

function view(snapshot: CampaignWizardSnapshot = SNAPSHOT) {
  return presentCampaignWizard(snapshot, {
    workspaceName: 'Property Predator Growth HQ',
    timezone: 'Europe/London',
    asOf: '2026-08-27T09:00:00.000Z',
  });
}

const ACTION = Object.freeze({
  actionUrl: '/portal/campaigns/test-planning-intents',
  csrfToken: 'csrf-campaign-wizard-token-1234',
  commandKey: 'campaign:wizard:create:001',
  returnTo: '/portal/campaigns',
});

test('Campaign Wizard presents only exact eligible copy, media and owned TEST targets', () => {
  const result = view();
  assert.equal(result.environment, 'test');
  assert.equal(result.providerEffects, 'none');
  assert.equal(result.eligibleContentCount, 1);
  assert.equal(result.eligibleMediaCount, 1);
  assert.equal(result.eligibleTargetCount, 1);
  assert.equal(result.channelGroups[0]?.label, 'LinkedIn');
  assert.equal(result.content[1]?.eligible, false);
  assert.equal(result.content[1]?.gateLabel, 'Exact approval required');
});

test('Campaign Wizard renders a native protected POST with separate copy and approved media selections', () => {
  const html = renderCampaignWizardBody(view(), { action: ACTION });
  assert.match(html, /Build the rhythm\. <em>Keep control\.<\/em>/);
  assert.match(html, /<form class="cwiz-form" method="post" action="\/portal\/campaigns\/test-planning-intents" data-campaign-wizard-form>/);
  assert.match(html, /name="_csrf" value="csrf-campaign-wizard-token-1234"/);
  assert.match(html, /name="command_key" value="campaign:wizard:create:001"/);
  assert.match(html, /Required social-post copy/);
  assert.match(html, /name="content_version_id" value="22222222-2222-4222-8222-222222222222" checked required/);
  assert.match(html, /Approved artwork or media · optional/);
  assert.match(html, /name="media_version_ids" value="44444444-4444-4444-8444-444444444444"/);
  assert.match(html, /data-max-selections="10"/);
  assert.match(html, /name="target_ids" value="66666666-6666-4666-8666-666666666666"/);
  assert.match(html, /name="desired_for_local"/);
  assert.match(html, /name="confirm_test_only" value="confirmed" required/);
  assert.match(html, />Create durable TEST campaign<\/button>/);
  assert.match(html, /@media\(max-width:580px\)/);
  assert.match(html, /@media\(forced-colors:active\)/);
  assert.doesNotMatch(html, /providerToken|accessToken|apiKey|testAccountRef|storageKey|blobSha256/);
});

test('Campaign Wizard fails closed when an unsafe or incomplete action is injected', () => {
  const hostile = { ...ACTION, actionUrl: 'https://attacker.example/collect' };
  assert.equal(isCampaignWizardCreateActionReady(hostile), false);
  const html = renderCampaignWizardBody(view(), { action: hostile });
  assert.doesNotMatch(html, /<form\b|attacker\.example/);
  assert.match(html, /data-read-only="true"/);
  assert.match(html, /router has not supplied a protected command boundary/i);
});

test('Campaign Wizard escapes hostile labels and bounded operation outcomes', () => {
  const hostile = view({
    ...SNAPSHOT,
    content: [{ ...COPY, title: '<img src=x onerror=alert(1)>' }],
    media: [{ ...MEDIA, title: '"><script>alert(2)</script>' }],
  });
  const html = renderCampaignWizardBody(hostile, {
    action: ACTION,
    outcome: {
      kind: 'error',
      title: '<svg onload=alert(3)>',
      detail: '<script>alert(4)</script>',
    },
  });
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&quot;&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.match(html, /&lt;svg onload=alert\(3\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(4\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<(?:img|svg)\b|<script>/i);
});

test('Campaign Wizard PRG notices are session-bound and never expose raw errors', () => {
  const token = campaignWizardNoticeToken('notice-secret', 'session-a', 'planned');
  const query = new URLSearchParams({ notice: token });
  assert.deepEqual(campaignWizardNoticeFromQuery(query, 'notice-secret', 'session-a'), {
    kind: 'success',
    title: 'Durable TEST campaign planned',
    detail: 'The exact copy, approved media, targets and desired time were recorded. No provider was called.',
    disposition: 'applied',
  });
  assert.equal(campaignWizardNoticeFromQuery(query, 'notice-secret', 'session-b'), undefined);
  assert.equal(campaignWizardNoticeFromQuery(
    new URLSearchParams({ notice: `${token}tampered` }),
    'notice-secret',
    'session-a',
  ), undefined);
});
