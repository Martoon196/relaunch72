import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CompanyContentCatalogItem,
  CompanyContentCatalogPage,
} from '../src/company-content-pg/types.js';
import {
  CONTENT_CONTROL_ROOM_MAX_ITEMS,
  CONTENT_CONTROL_ROOM_MAX_QUERY_LENGTH,
  CONTENT_CONTROL_ROOM_MAX_REVIEW_ITEMS,
  normaliseContentControlRoomFilters,
  presentContentControlRoom,
} from '../src/portal/content-control-room-presenter.js';
import { renderContentControlRoomBody } from '../src/portal/content-control-room-view.js';
import {
  GENERATED_SOURCE_REFRESH_ROUTE,
  contentControlNoticeFromQuery,
  contentControlNoticeToken,
} from '../src/portal/content-control-room-actions.js';

const HASH_A = '11'.repeat(32);
const HASH_B = '22'.repeat(32);
const HASH_C = '33'.repeat(32);

function item(overrides: Partial<CompanyContentCatalogItem> = {}): CompanyContentCatalogItem {
  return {
    contentItemId: '11111111-1111-4111-8111-111111111111',
    contentVersionId: '22222222-2222-4222-8222-222222222222',
    versionNumber: 3,
    origin: 'imported',
    kind: 'social_post',
    title: 'Property Predator launch signal',
    contentMimeType: 'text/plain',
    source: {
      system: 'property_predator',
      itemId: 'launch-signal',
      version: 'source-v7',
    },
    contentSha256: HASH_A,
    blobSha256: HASH_B,
    brandSha256: HASH_C,
    approvalRequestId: '33333333-3333-4333-8333-333333333333',
    approvalDecisionId: '44444444-4444-4444-8444-444444444444',
    approvalStatus: 'approved',
    approvalStale: false,
    sourceAttestationId: '55555555-5555-4555-8555-555555555555',
    sourceCheckedAt: '2026-08-26T08:00:00.000Z',
    sourceExpiresAt: '2026-08-26T08:15:00.000Z',
    sourceFresh: true,
    publishable: true,
    createdAt: '2026-08-26T08:01:00.000Z',
    ...overrides,
  };
}

function page(items: readonly CompanyContentCatalogItem[]): CompanyContentCatalogPage {
  return { items, nextCursor: null };
}

function present(
  items: readonly CompanyContentCatalogItem[],
  filters: Readonly<{ query?: unknown; channel?: unknown; format?: unknown; status?: unknown }> = {},
) {
  return presentContentControlRoom(page(items), {
    workspaceName: 'Property Predator Growth HQ',
    asOf: '2026-08-26T08:05:00.000Z',
    filters,
  });
}

test('Content Control Room presents exact provenance and filters by deterministic channel and format', () => {
  const social = item();
  const email = item({
    contentItemId: '66666666-6666-4666-8666-666666666666',
    contentVersionId: '77777777-7777-4777-8777-777777777777',
    kind: 'email',
    title: 'Agency nurture email',
    source: { system: 'property_predator', itemId: 'agency-email', version: 'email-v2' },
  });
  const image = item({
    contentItemId: '88888888-8888-4888-8888-888888888888',
    contentVersionId: '99999999-9999-4999-8999-999999999999',
    kind: 'image',
    title: 'Owned launch artwork',
    source: { system: 'property_predator', itemId: 'launch-art', version: 'art-v4' },
  });

  const view = present([social, email, image], {
    query: ' launch ', channel: 'social', format: 'social_post',
  });
  assert.equal(view.items.length, 1);
  assert.deepEqual({
    title: view.items[0]?.title,
    channel: view.items[0]?.channel,
    format: view.items[0]?.kind,
    sourceSystem: view.items[0]?.sourceSystem,
    sourceItemId: view.items[0]?.sourceItemId,
    sourceVersion: view.items[0]?.sourceVersion,
    versionNumber: view.items[0]?.versionNumber,
  }, {
    title: 'Property Predator launch signal',
    channel: 'social',
    format: 'social_post',
    sourceSystem: 'property_predator',
    sourceItemId: 'launch-signal',
    sourceVersion: 'source-v7',
    versionNumber: 3,
  });
  assert.equal(present([image], { channel: 'library' }).items.length, 1);
  assert.equal(view.metrics.loaded, 3);
  assert.equal(view.metrics.publishable, 3);
  assert.equal(view.metrics.needsAttention, 0);
  assert.equal(view.matchingCount, 1);
});

test('Content Control Room truth labels keep stale approval and expired source proof non-publishable', () => {
  const stale = item({
    contentItemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    contentVersionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    versionNumber: 4,
    title: 'Revised investor post',
    approvalDecisionId: null,
    approvalStatus: 'stale',
    approvalStale: true,
    publishable: false,
  });
  const expired = item({
    contentItemId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    contentVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    title: 'Approved webinar script',
    kind: 'webinar',
    sourceFresh: false,
    publishable: false,
  });
  const pending = item({
    contentItemId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    contentVersionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    title: 'Pending email',
    kind: 'email',
    approvalDecisionId: null,
    approvalStatus: 'pending',
    publishable: false,
  });
  const view = present([item(), stale, expired, pending]);
  const html = renderContentControlRoomBody(view);

  assert.equal(view.metrics.publishable, 1);
  assert.equal(view.metrics.needsAttention, 3);
  assert.deepEqual(view.reviewQueue.map((entry) => entry.reason), [
    'Approve this exact version',
    'Decision waiting',
    'Refresh source proof',
  ]);
  assert.match(html, /Review updated version/);
  assert.match(html, /This post has changed/);
  assert.match(html, /Needs a quick check/);
  assert.match(html, /Awaiting approval/);
  assert.equal((html.match(/class="ccr-card eligible"/g) ?? []).length, 1);
  assert.equal((html.match(/class="ccr-card locked"/g) ?? []).length, 3);
  assert.match(html, /Approving a post does not publish it/);
});

test('Content Control Room fails a contradictory stored publishable claim closed', () => {
  const contradictory = item({
    approvalStatus: 'pending',
    approvalDecisionId: null,
    publishable: true,
  });
  const view = present([contradictory]);
  assert.equal(view.items[0]?.publishable, false);
  assert.equal(view.items[0]?.publishableLabel, 'Locked');
  assert.equal(view.metrics.publishable, 0);
  assert.equal(view.reviewQueue[0]?.reason, 'Decision waiting');
  assert.match(renderContentControlRoomBody(view), /waiting for a decision/i);
});

test('Content Control Room escapes every supplied display and audit field', () => {
  const hostile = item({
    contentItemId: 'item"><img src=x onerror=alert(1)>',
    contentVersionId: 'version"><script>alert(2)</script>',
    title: '<img src=x onerror=alert(3)> A&B',
    source: {
      system: 'source"><script>alert(4)</script>',
      itemId: '<source-item>',
      version: 'rev&"7',
    },
    contentMimeType: 'text/html"><img src=x>',
    contentSha256: '<hash-content>',
    blobSha256: '<hash-blob>',
    brandSha256: '<hash-brand>',
    approvalRequestId: '<request>',
    approvalDecisionId: '<decision>',
    sourceAttestationId: '<attestation>',
  });
  const presented = presentContentControlRoom(page([hostile]), {
    workspaceName: '<script>alert(5)</script>',
    asOf: 'not-a-time"><img src=x>',
  });
  const view = {
    ...presented,
    filters: { ...presented.filters, query: '"><script>alert(6)</script>' },
  };
  const html = renderContentControlRoomBody(view);

  assert.match(html, /&lt;script&gt;alert\(5\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(3\)&gt; A&amp;B/);
  assert.match(html, /source&quot;&gt;&lt;script&gt;alert\(4\)&lt;\/script&gt;/);
  assert.match(html, /value="&quot;&gt;&lt;script&gt;alert\(6\)&lt;\/script&gt;"/);
  assert.match(html, /&lt;hash-content&gt;/);
  assert.doesNotMatch(html, /<(?:script|img)\b/i);
});

test('Content Control Room has labelled, touch-sized, responsive review semantics', () => {
  const html = renderContentControlRoomBody(present([item(), item({
    title: 'Pending social review',
    contentItemId: 'aaaaaaaa-1111-4111-8111-111111111111',
    contentVersionId: 'bbbbbbbb-2222-4222-8222-222222222222',
    approvalStatus: 'pending',
    approvalDecisionId: null,
    publishable: false,
  })]));

  assert.match(html, /<article class="ccr" aria-labelledby="ccr-title">/);
  assert.match(html, /<form class="ccr-filterbar" method="get" action="\/portal\/content" aria-label="Filter company content">/);
  assert.match(html, /<label for="ccr-query">Find a post<\/label>/);
  assert.match(html, /<label for="ccr-channel">Channel<\/label>/);
  assert.match(html, /<label for="ccr-format">Format<\/label>/);
  assert.match(html, /<nav class="ccr-metrics" aria-label="Content status">/);
  assert.doesNotMatch(html, /<aside class="ccr-review"/);
  assert.match(html, /<details class="ccr-proof"><summary>Technical details<\/summary>/);
  assert.match(html, /min-height:44px/);
  assert.match(html, /@media\(max-width:820px\)/);
  assert.match(html, /@media\(max-width:520px\)/);
  assert.match(html, /@media\(forced-colors:active\)/);
  assert.doesNotMatch(html, /method="post"|Connect provider|Publish now|Schedule now/i);
  assert.match(html, /Approving a post does not publish it/);
});

test('Content Control Room links to full review instead of offering blind library approvals', () => {
  const pending = item({
    approvalStatus: 'pending',
    approvalDecisionId: null,
    publishable: false,
  });
  const unrequested = item({
    contentItemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    contentVersionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    approvalRequestId: null,
    approvalDecisionId: null,
    approvalStatus: 'unrequested',
    publishable: false,
  });
  const view = presentContentControlRoom(page([pending, unrequested]), {
    workspaceName: 'Property Predator Growth HQ',
    asOf: '2026-08-26T08:05:00.000Z',
    canWrite: true,
    canManage: true,
  });
  const html = renderContentControlRoomBody(view, {
    security: {
      csrfToken: 'content-csrf-token-0000000000000001',
      requestApprovalKeys: {
        [unrequested.contentVersionId]: 'content-request-command-0001',
      },
      decisionKeys: {
        [pending.approvalRequestId!]: 'content-decision-command-0001',
      },
    },
  });

  assert.doesNotMatch(html, /method="post"|name="decision"/);
  assert.match(html, /Review &amp; approve/);
  assert.ok(html.includes(`href="/portal/content/items/${pending.contentItemId}/versions/${pending.contentVersionId}/review"`));
  assert.ok(html.includes(`href="/portal/content/items/${unrequested.contentItemId}/versions/${unrequested.contentVersionId}/review"`));

  const readOnly = renderContentControlRoomBody(present([pending, unrequested]), {
    security: {
      csrfToken: 'content-csrf-token-0000000000000001',
      requestApprovalKeys: { [unrequested.contentVersionId]: 'content-request-command-0001' },
      decisionKeys: { [pending.approvalRequestId!]: 'content-decision-command-0001' },
    },
  });
  assert.doesNotMatch(readOnly, /method="post"/);
  assert.match(readOnly, /Ask a workspace editor to make changes/);
});

test('approved expired generated drafts expose exact source renewal without regeneration', () => {
  const generated = item({
    origin: 'generated', sourceFresh: false, publishable: false,
    source: {
      system: 'property_predator_generation',
      itemId: 'd1000000-0000-4000-8000-000000000001',
      version: 'd2000000-0000-4000-8000-000000000001:v1',
    },
  });
  const view = presentContentControlRoom(page([generated]), {
    workspaceName: 'Property Predator Growth HQ', asOf: '2026-08-26T08:20:00.000Z',
    canWrite: true, canManage: true,
  });
  const html = renderContentControlRoomBody(view, { security: {
    csrfToken: 'content-csrf-token-0000000000000001', requestApprovalKeys: {}, decisionKeys: {},
    sourceRefreshKeys: { [generated.contentVersionId]: 'refresh-generated-source-0001' },
  } });
  assert.match(html, new RegExp(`action="${GENERATED_SOURCE_REFRESH_ROUTE}"`));
  assert.match(html, /Check for scheduling/);
  assert.match(html, /Your wording stays the same/);
  assert.ok(html.includes(`name="content_sha256" value="${generated.contentSha256}"`));
  assert.match(html, /name="_csrf" value="content-csrf-token-0000000000000001"/);
  assert.doesNotMatch(html, /Generate new|Publish now/);

  const restricted = renderContentControlRoomBody(presentContentControlRoom(page([{
    ...generated, approvalStatus: 'changes_requested', approvalDecisionId: null,
  }]), { workspaceName: 'Growth HQ', asOf: '2026-08-26T08:20:00.000Z', canWrite: true, canManage: true }), {
    security: { csrfToken: 'content-csrf-token-0000000000000001', requestApprovalKeys: {
      [generated.contentVersionId]: 'request-review-again-0001',
    }, decisionKeys: {}, sourceRefreshKeys: {
      [generated.contentVersionId]: 'refresh-must-not-show-0001',
    } },
  });
  assert.doesNotMatch(restricted, new RegExp(`action="${GENERATED_SOURCE_REFRESH_ROUTE}"`));
  const inspectOnly = renderContentControlRoomBody({ ...view, canWrite: false }, { security: {
    csrfToken: 'content-csrf-token-0000000000000001', requestApprovalKeys: {}, decisionKeys: {},
    sourceRefreshKeys: { [generated.contentVersionId]: 'refresh-generated-source-0001' },
  } });
  assert.doesNotMatch(inspectOnly, /method="post"/);
});

test('Content Control notices are session-bound and never claim publishing occurred', () => {
  const secret = 'content-notice-secret';
  const session = 'content-session';
  for (const code of ['requested', 'approved', 'rejected', 'changes_requested', 'replayed'] as const) {
    const query = new URLSearchParams({ notice: contentControlNoticeToken(secret, session, code) });
    const notice = contentControlNoticeFromQuery(query, secret, session);
    assert.ok(notice);
    assert.doesNotMatch(`${notice.title} ${notice.message}`, /published successfully|post sent|message sent/i);
    assert.equal(contentControlNoticeFromQuery(query, secret, 'another-session'), undefined);
  }
  const lockedQuery = new URLSearchParams({
    notice: contentControlNoticeToken(secret, session, 'review_unavailable'),
  });
  const locked = contentControlNoticeFromQuery(lockedQuery, secret, session);
  assert.deepEqual(locked, {
    kind: 'error',
    title: 'Preview unavailable',
    message: 'We cannot show a verified preview right now. Open the post again shortly. It cannot be approved or published until the preview is available.',
  });
});

test('Content Control Room bounds query, catalogue and review output and fails invalid filters closed', () => {
  const filters = normaliseContentControlRoomFilters({
    query: 'x'.repeat(200),
    channel: 'tiktok<script>',
    format: 'carousel<script>',
  });
  assert.equal(filters.query.length, CONTENT_CONTROL_ROOM_MAX_QUERY_LENGTH);
  assert.equal(filters.channel, 'all');
  assert.equal(filters.format, 'all');

  const oversized = Array.from({ length: 130 }, (_, index) => item({
    contentItemId: `item-${index}`,
    contentVersionId: `version-${index}`,
    title: `Pending item ${index}`,
    approvalStatus: 'unrequested',
    approvalRequestId: null,
    approvalDecisionId: null,
    publishable: false,
  }));
  const view = present(oversized);
  const html = renderContentControlRoomBody(view);
  assert.equal(view.loadedCount, CONTENT_CONTROL_ROOM_MAX_ITEMS);
  assert.equal(view.items.length, CONTENT_CONTROL_ROOM_MAX_ITEMS);
  assert.equal(view.reviewQueue.length, CONTENT_CONTROL_ROOM_MAX_REVIEW_ITEMS);
  assert.equal(view.inputTruncated, true);
  assert.equal(view.hasMore, true);
  assert.equal((html.match(/class="ccr-card locked"/g) ?? []).length, CONTENT_CONTROL_ROOM_MAX_ITEMS);
  assert.match(html, /Showing the latest 100 items/);
  assert.match(html, /Counts and filters cover these items/);
});

test('Content Control Room distinguishes an empty source catalogue from empty filter results', () => {
  const empty = renderContentControlRoomBody(present([]));
  assert.match(empty, /Your first post starts here/);
  assert.match(empty, /Create a draft, then come back to review it/);

  const noMatches = renderContentControlRoomBody(present([item()], { query: 'definitely absent' }));
  assert.match(noMatches, /No content in this view/);
  assert.match(noMatches, /Try another status or clear your filters/);
  assert.match(noMatches, /href="\/portal\/content">Show all content/);
  assert.doesNotMatch(noMatches, /Your first post starts here/);
});


test('Content library has real status links and hides support details by default', () => {
  const html = renderContentControlRoomBody(present([item()]), { brandBrainAvailable: true });
  assert.match(html, /aria-label="Content status"/);
  assert.ok(html.includes('href="/portal/campaigns/new">+ Create a post'));
  assert.ok(html.includes('href="/portal/content?status=attention#content-library"'));
  assert.ok(html.includes('href="/portal/content?status=approved#content-library"'));
  assert.ok(html.includes('href="/portal/content?status=ready#content-library"'));
  assert.match(html, /<details class="ccr-proof"><summary>Technical details/);
  assert.doesNotMatch(html, /<details[^>]* open|Version catalogue|Publishable gate|Immutable v/);
  assert.match(html, /Content tools and settings/);
});

test('empty library offers a real first action', () => {
  const html = renderContentControlRoomBody(present([]));
  assert.ok(html.includes('href="/portal/campaigns/new">Create a post'));
  assert.match(html, /Your first post starts here/);
});

test('status links filter the real items, preserve total counts and reject invalid statuses', () => {
  const ready = item({ title: 'Ready post' });
  const expired = item({ title: 'Expired post', sourceFresh: false, publishable: false });
  const draft = item({ title: 'New draft', approvalStatus: 'unrequested', approvalRequestId: null, approvalDecisionId: null, publishable: false });
  const items = [ready, expired, draft];
  assert.deepEqual(present(items, { status: 'ready' }).items.map(i => i.title), ['Ready post']);
  assert.deepEqual(present(items, { status: 'approved' }).items.map(i => i.title), ['Ready post', 'Expired post']);
  assert.deepEqual(present(items, { status: 'attention' }).items.map(i => i.title), ['Expired post', 'New draft']);
  assert.equal(present(items, { status: 'attention', query: 'new' }).items.length, 1);
  assert.equal(present(items, { status: 'approved' }).metrics.loaded, 3);
  assert.equal(present(items, { status: 'bad<script>' }).filters.status, 'all');
  const html = renderContentControlRoomBody(present(items, { status: 'ready' }));
  assert.ok(html.includes('href="/portal/content?status=ready#content-library" aria-current="page"'));
  assert.ok(html.includes('name="status" value="ready"'));
});
