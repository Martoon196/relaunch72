import assert from 'node:assert/strict';
import test from 'node:test';
import type { ZernioCommentPlatform } from '../src/public-social-outbound/zernio-messaging-client.js';
import type { PortalZernioMessagingSnapshot } from '../src/portal/zernio-messaging-service.js';
import {
  reconcileZernioInboundFixtures,
  ZERNIO_INBOUND_FIXTURE_ATTESTATION,
  ZernioInboundReconciliationError,
  type ZernioInboundPersonEvidence,
} from '../src/portal/zernio-inbound-reconciliation.js';

const ACCOUNT = '6a95e99a77555aae01643ae2';
const LINKEDIN_ACCOUNT = 'linkedin-account-1';
const CONTACT = '11111111-1111-4111-8111-111111111111';
const CONTACT_POINT = '22222222-2222-4222-8222-222222222222';
const ATTEMPT = '33333333-3333-4333-8333-333333333333';

type SuccessfulSnapshot = Extract<PortalZernioMessagingSnapshot, { ok: true }>;

function person(overrides: Partial<{
  outreachAttemptReceiptId: string | null;
}> = {}) {
  return Object.freeze({
    contactId: CONTACT,
    contactPointId: CONTACT_POINT,
    displayName: 'Amelia Hart',
    companyName: 'Hart Property Ltd',
    stageLabel: 'Lead',
    score: 46,
    sourceLabel: 'Daily Outreach',
    affiliateLabel: null,
    nextMove: 'Review response',
    outreachAttemptReceiptId: ATTEMPT,
    ...overrides,
  });
}

function dmSnapshot(overrides: Readonly<{
  body?: string;
  messageId?: string;
  direction?: 'incoming' | 'outgoing';
  senderId?: string;
  historyTruncated?: boolean;
  queueTruncated?: boolean;
  checkedAt?: string;
}> = {}): SuccessfulSnapshot {
  const conversation = Object.freeze({
    providerConversationId: 'conversation-1',
    platform: 'instagram' as const,
    accountId: ACCOUNT,
    accountUsername: 'propertypredator',
    participantId: 'person-1',
    participantName: 'Amelia Hart',
    lastMessage: overrides.body ?? 'Can you show me the Deal Analyser?',
    updatedAt: '2026-09-02T08:00:00.000Z',
    status: 'active' as const,
    unreadCount: 1,
    url: 'https://www.instagram.com/direct/t/1/',
  });
  const message = Object.freeze({
    providerMessageId: overrides.messageId ?? 'message-1',
    providerConversationId: conversation.providerConversationId,
    accountId: ACCOUNT,
    platform: 'instagram' as const,
    body: overrides.body ?? 'Can you show me the Deal Analyser?',
    senderId: overrides.senderId ?? 'person-1',
    senderName: 'Amelia Hart',
    direction: overrides.direction ?? 'incoming' as const,
    occurredAt: '2026-09-02T08:00:00.000Z',
    deliveryStatus: null,
    sentVia: null,
  });
  return Object.freeze({
    ok: true as const,
    provider: 'zernio' as const,
    providerEffects: false as const,
    outboundEffectsEnabled: false,
    emergencyPaused: true,
    checkedAt: overrides.checkedAt ?? '2026-09-02T08:01:00.000Z',
    conversations: Object.freeze([conversation]),
    commentPosts: Object.freeze([]),
    selectedConversation: conversation,
    selectedCommentPost: null,
    selectedComment: null,
    selectedTarget: Object.freeze({
      kind: 'dm' as const,
      accountId: ACCOUNT,
      providerConversationId: conversation.providerConversationId,
    }),
    messages: Object.freeze([message]),
    comments: Object.freeze([]),
    reply: null,
    conversationHistoryTruncated: overrides.historyTruncated ?? false,
    queueTruncated: overrides.queueTruncated ?? false,
  });
}

function commentSnapshot(
  platform: ZernioCommentPlatform = 'instagram',
  overrides: Readonly<{
    body?: string;
    commentId?: string;
    authorId?: string;
    authorIsOwner?: boolean;
    checkedAt?: string;
  }> = {},
): SuccessfulSnapshot {
  const accountId = platform === 'instagram' ? ACCOUNT : LINKEDIN_ACCOUNT;
  const post = Object.freeze({
    providerPostId: `${platform}-post-1`,
    platform,
    accountId,
    accountUsername: 'propertypredator',
    content: 'Two-minute Property Predator walkthrough',
    pictureUrl: null,
    permalinkUrl: `https://example.test/${platform}/post-1`,
    createdAt: '2026-09-02T07:00:00.000Z',
    commentCount: 1,
    likeCount: 12,
  });
  const comment = Object.freeze({
    providerCommentId: overrides.commentId ?? `${platform}-comment-1`,
    providerPostId: post.providerPostId,
    platform,
    accountId,
    body: overrides.body ?? 'This is useful. Can I see the full walkthrough?',
    createdAt: '2026-09-02T08:05:00.000Z',
    author: Object.freeze({
      providerAuthorId: overrides.authorId ?? 'person-1',
      name: 'Amelia Hart',
      username: 'amelia.hart',
      pictureUrl: null,
      isOwner: overrides.authorIsOwner ?? false,
      verifiedType: null,
    }),
    likeCount: 1,
    replyCount: 0,
    url: null,
    parentCommentId: null,
    canReply: true,
    repliesHaveMore: false,
    replies: Object.freeze([]),
  });
  return Object.freeze({
    ok: true as const,
    provider: 'zernio' as const,
    providerEffects: false as const,
    outboundEffectsEnabled: false,
    emergencyPaused: true,
    checkedAt: overrides.checkedAt ?? '2026-09-02T08:06:00.000Z',
    conversations: Object.freeze([]),
    commentPosts: Object.freeze([post]),
    selectedConversation: null,
    selectedCommentPost: post,
    selectedComment: comment,
    selectedTarget: Object.freeze({
      kind: 'comment' as const,
      accountId,
      platform,
      providerPostId: post.providerPostId,
      providerCommentId: comment.providerCommentId,
    }),
    messages: Object.freeze([]),
    comments: Object.freeze([comment]),
    reply: null,
    conversationHistoryTruncated: false,
    queueTruncated: false,
  });
}

test('Instagram DM and owned-post comment reconcile to one canonical Lead 360 person', async () => {
  const resolutions: ZernioInboundPersonEvidence[] = [];
  const batch = await reconcileZernioInboundFixtures({
    fixtureAttestation: ZERNIO_INBOUND_FIXTURE_ATTESTATION,
    snapshots: [dmSnapshot(), commentSnapshot('instagram')],
  }, {
    async resolve(evidence) {
      resolutions.push(evidence);
      return person();
    },
  });

  assert.equal(batch.providerEffects, false);
  assert.equal(batch.environment, 'test');
  assert.equal(batch.acceptedEventCount, 2);
  assert.equal(batch.threads.length, 2);
  assert.equal(resolutions.length, 1, 'same account/person identity must resolve once');
  assert.equal(new Set(batch.threads.map((item) => item.thread.lead.contactId)).size, 1);
  assert.equal(batch.threads.every((item) => item.thread.lead.contactId === CONTACT), true);
  assert.equal(batch.threads.every((item) => item.thread.contactPointId === CONTACT_POINT), true);
  assert.equal(batch.threads.every((item) => item.conversation.channel === 'instagram'), true);
  assert.equal(batch.threads.every((item) =>
    item.conversation.channelCompatibility === 'conversion_inbox_native'), true);
  assert.equal(batch.threads.flatMap((item) => item.lead360Evidence).length, 2);
  assert.equal(batch.threads.flatMap((item) => item.outreachResponses)
    .every((item) => item.attemptReceiptId === ATTEMPT
      && item.disposition === 'ready_for_command'
      && item.providerEffects === false), true);
  assert.equal(batch.threads.flatMap((item) => item.thread.messages)
    .every((item) => item.inboundEvidence === null), true,
  'polled fixtures must never masquerade as signed inbound receipts');
});

test('LinkedIn comments preserve their real network as a native read-only inbox projection', async () => {
  const batch = await reconcileZernioInboundFixtures({
    fixtureAttestation: ZERNIO_INBOUND_FIXTURE_ATTESTATION,
    snapshots: [commentSnapshot('linkedin')],
  }, { async resolve() { return person({ outreachAttemptReceiptId: null }); } });

  assert.equal(batch.acceptedEventCount, 1);
  assert.deepEqual(batch.blockers, []);
  assert.equal(batch.threads[0]?.conversation.channel, 'linkedin');
  assert.equal(batch.threads[0]?.conversation.channelCompatibility,
    'conversion_inbox_read_only');
  assert.equal(batch.threads[0]?.outreachResponses[0]?.disposition, 'unlinked');
  assert.equal(batch.threads[0]?.lead360Evidence[0]?.sourceLabel,
    'Zernio · LinkedIn comment');
});

test('exact provider replays deduplicate while conflicting replays quarantine fail closed', async () => {
  const batch = await reconcileZernioInboundFixtures({
    fixtureAttestation: ZERNIO_INBOUND_FIXTURE_ATTESTATION,
    snapshots: [
      dmSnapshot(),
      dmSnapshot(),
      dmSnapshot({ body: 'Conflicting body for the same provider message id' }),
    ],
  }, { async resolve() { return person(); } });

  assert.equal(batch.acceptedEventCount, 1);
  assert.equal(batch.duplicateReplayCount, 1);
  assert.equal(batch.quarantine.length, 1);
  assert.equal(batch.quarantine[0]?.blocker, 'provider_event_conflict');
  assert.equal(batch.blockers.includes('provider_event_conflict'), true);
  assert.doesNotMatch(JSON.stringify(batch.quarantine), /Conflicting body/u);
  assert.doesNotMatch(JSON.stringify(batch.quarantine), /message-1/u);
});

test('unmatched people and empty content never become inbox or Lead 360 records', async () => {
  const batch = await reconcileZernioInboundFixtures({
    fixtureAttestation: ZERNIO_INBOUND_FIXTURE_ATTESTATION,
    snapshots: [dmSnapshot(), commentSnapshot('instagram', { body: '' })],
  }, { async resolve() { return null; } });

  assert.equal(batch.acceptedEventCount, 0);
  assert.deepEqual(batch.threads, []);
  assert.deepEqual(new Set(batch.quarantine.map((item) => item.blocker)),
    new Set(['unmatched_person', 'empty_inbound_body']));
  assert.equal(batch.blockers.includes('unmatched_person'), true);
  assert.equal(batch.blockers.includes('empty_inbound_body'), true);
});

test('owner replies and outgoing DMs are not treated as inbound human responses', async () => {
  let resolutions = 0;
  const batch = await reconcileZernioInboundFixtures({
    fixtureAttestation: ZERNIO_INBOUND_FIXTURE_ATTESTATION,
    snapshots: [
      dmSnapshot({ direction: 'outgoing' }),
      commentSnapshot('instagram', { authorIsOwner: true }),
    ],
  }, { async resolve() { resolutions += 1; return person(); } });

  assert.equal(batch.acceptedEventCount, 0);
  assert.equal(batch.threads.length, 0);
  assert.equal(resolutions, 0);
});

test('truncated provider reads remain usable but are truthfully marked partial', async () => {
  const batch = await reconcileZernioInboundFixtures({
    fixtureAttestation: ZERNIO_INBOUND_FIXTURE_ATTESTATION,
    snapshots: [dmSnapshot({ historyTruncated: true, queueTruncated: true })],
  }, { async resolve() { return person(); } });

  assert.equal(batch.coverage, 'partial');
  assert.equal(batch.acceptedEventCount, 1);
  assert.deepEqual(batch.blockers, ['history_truncated', 'queue_truncated']);
});

test('mismatched provider bindings are rejected before identity or projection work', async () => {
  let resolutions = 0;
  await assert.rejects(() => reconcileZernioInboundFixtures({
    fixtureAttestation: ZERNIO_INBOUND_FIXTURE_ATTESTATION,
    snapshots: [dmSnapshot({ senderId: 'different-person' })],
  }, { async resolve() { resolutions += 1; return person(); } }),
  (error: unknown) => error instanceof ZernioInboundReconciliationError
    && /mismatched provider binding/u.test(error.message));
  assert.equal(resolutions, 0);
});

test('fixture-only attestation is mandatory and the boundary has no provider send method', async () => {
  await assert.rejects(() => reconcileZernioInboundFixtures({
    fixtureAttestation: 'live' as never,
    snapshots: [dmSnapshot()],
  }, { async resolve() { return person(); } }), ZernioInboundReconciliationError);
  assert.equal('send' in reconcileZernioInboundFixtures, false);
  assert.equal('publish' in reconcileZernioInboundFixtures, false);
});
