import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type ZernioMessagingClient,
  ZernioMessagingError,
} from '../src/public-social-outbound/zernio-messaging-client.js';
import {
  LivePortalZernioMessagingService,
  type PortalZernioMessagingSnapshot,
  zernioMessagingTargetReference,
} from '../src/portal/zernio-messaging-service.js';
import { renderZernioMessagingBody } from '../src/portal/zernio-messaging-view.js';

const ACCOUNT = '6a95e99a77555aae01643ae2';
const identity = Object.freeze({
  sessionToken: 'session-token', requestId: 'request-1',
});

const conversation = Object.freeze({
  providerConversationId: 'conversation-1', platform: 'instagram' as const,
  accountId: ACCOUNT, accountUsername: 'propertypredator', participantId: 'participant-1',
  participantName: 'A <Hunter>', lastMessage: 'Is this available?',
  updatedAt: '2026-09-01T01:00:00.000Z', status: 'active' as const,
  unreadCount: 1, url: 'https://www.instagram.com/direct/t/1/',
});

const message = Object.freeze({
  providerMessageId: 'message-1', providerConversationId: 'conversation-1',
  accountId: ACCOUNT, platform: 'instagram' as const, body: '<script>alert(1)</script>',
  senderId: 'participant-1', senderName: 'A <Hunter>', direction: 'incoming' as const,
  occurredAt: '2026-09-01T01:00:00.000Z', deliveryStatus: null, sentVia: null,
});

const commentedPost = Object.freeze({
  providerPostId: 'ig-post-1', platform: 'instagram' as const, accountId: ACCOUNT,
  accountUsername: 'propertypredator', content: 'A <banger> walkthrough',
  pictureUrl: null, permalinkUrl: 'https://www.instagram.com/p/ig-post-1/',
  createdAt: '2026-09-01T00:30:00.000Z', commentCount: 1, likeCount: 8,
});

const comment = Object.freeze({
  providerCommentId: 'ig-comment-1', providerPostId: 'ig-post-1',
  platform: 'instagram' as const, accountId: ACCOUNT,
  body: 'Can I see <script>this</script>?', createdAt: '2026-09-01T01:10:00.000Z',
  author: Object.freeze({
    providerAuthorId: 'participant-1', name: 'Comment Hunter', username: 'hunter',
    pictureUrl: null, isOwner: false, verifiedType: null,
  }),
  likeCount: 1, replyCount: 0, url: null, parentCommentId: null,
  canReply: true, repliesHaveMore: false, replies: Object.freeze([]),
});

function client(): Pick<ZernioMessagingClient,
  'listConversations' | 'listMessages' | 'listCommentedPosts' | 'listPostComments'> {
  return {
    async listConversations() {
      return { conversations: [conversation], checkedAt: '2026-09-01T01:01:00.000Z', hasMore: false };
    },
    async listMessages() {
      return { messages: [message], checkedAt: '2026-09-01T01:01:01.000Z', hasMore: false };
    },
    async listCommentedPosts() {
      return { posts: [commentedPost], checkedAt: '2026-09-01T01:01:02.000Z',
        hasMore: false, nextCursor: null };
    },
    async listPostComments() {
      return { comments: [comment], checkedAt: '2026-09-01T01:01:03.000Z',
        hasMore: false, nextCursor: null };
    },
  };
}

function replies() {
  return {
    async read() { return { ok: true as const, value: null }; },
    async create() { return { ok: true as const, value: 'created' as const }; },
    async requestApproval() { return { ok: true as const, value: 'requested' as const }; },
    async decide() { return { ok: true as const, value: 'approved' as const }; },
    async claim() { return { ok: true as const, value: {
      disposition: 'claimed', body: 'Approved reply', bodySha256: 'a'.repeat(64),
    } }; },
    async settle() { return { ok: true as const, value: 'accepted' }; },
  };
}

const sender = {
  async sendMessage() {
    return { accepted: true as const, providerMessageId: 'provider-message-2',
      responseSha256: 'b'.repeat(64), idempotentReplay: false };
  },
  async replyToComment() {
    return { accepted: true as const, providerReplyCommentId: 'provider-comment-2',
      responseSha256: 'c'.repeat(64), idempotentReplay: false };
  },
};

const commentAccountBindings = Object.freeze([
  Object.freeze({ accountId: ACCOUNT, platform: 'instagram' as const }),
]);

test('portal social Messaging authenticates through the durable connected-account boundary before Zernio', async () => {
  const service = new LivePortalZernioMessagingService({
    accounts: { async snapshot() {
      return { ok: true as const, accounts: [{
        accountId: '00000000-0000-4000-8000-000000000001', network: 'instagram' as const,
        username: 'propertypredator', displayName: 'Property Predator', status: 'active' as const,
        linkedAt: '2026-08-31T20:00:00.000Z', lastEventAt: '2026-08-31T20:00:00.000Z',
        webhookReceiptCount: 1,
      }] };
    } },
    client: client(), sender, replies: replies(), allowedAccountIds: [ACCOUNT],
    commentAccountBindings, providerEffectsEnabled: false, emergencyPaused: true,
  });
  const result = await service.snapshot(identity, { providerConversationId: 'conversation-1' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.providerEffects, false);
  assert.equal(result.selectedConversation?.providerConversationId, 'conversation-1');
  assert.equal(result.messages.length, 1);
});

test('portal social Messaging refuses provider reads when the Instagram connection is not active', async () => {
  let providerCalled = false;
  const service = new LivePortalZernioMessagingService({
    accounts: { async snapshot() { return { ok: true as const, accounts: [] }; } },
    client: {
      async listConversations() { providerCalled = true; return client().listConversations({ accountIds: [ACCOUNT] }); },
      async listMessages(input) { providerCalled = true; return client().listMessages(input); },
      async listCommentedPosts(input) { providerCalled = true; return client().listCommentedPosts(input); },
      async listPostComments(input) { providerCalled = true; return client().listPostComments(input); },
    },
    sender, replies: replies(), allowedAccountIds: [ACCOUNT],
    commentAccountBindings, providerEffectsEnabled: false, emergencyPaused: true,
  });
  const result = await service.snapshot(identity, {});
  assert.deepEqual(result, { ok: false, kind: 'unavailable', providerEffects: false });
  assert.equal(providerCalled, false);
});

test('portal social Messaging excludes Facebook DMs from the Instagram-only reply rail', async () => {
  let claims = 0;
  const facebookConversation = Object.freeze({ ...conversation, platform: 'facebook' as const });
  const service = new LivePortalZernioMessagingService({
    accounts: { async snapshot() { return { ok: true as const, accounts: [{
      accountId: '00000000-0000-4000-8000-000000000001', network: 'instagram' as const,
      username: 'propertypredator', displayName: 'Property Predator', status: 'active' as const,
      linkedAt: '2026-08-31T20:00:00.000Z', lastEventAt: '2026-08-31T20:00:00.000Z',
      webhookReceiptCount: 1,
    }] }; } },
    client: {
      ...client(),
      async listConversations() {
        return { conversations: [facebookConversation], checkedAt: '2026-09-01T01:01:00.000Z',
          hasMore: false };
      },
      async listCommentedPosts() {
        return { posts: [], checkedAt: '2026-09-01T01:01:00.000Z',
          hasMore: false, nextCursor: null };
      },
    },
    sender, replies: {
      ...replies(), async claim() { claims += 1; return replies().claim(); },
    },
    allowedAccountIds: [ACCOUNT], commentAccountBindings,
    providerEffectsEnabled: true, emergencyPaused: false,
  });
  const snapshot = await service.snapshot(identity, {});
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  assert.deepEqual(snapshot.conversations, []);
  assert.equal(snapshot.selectedConversation, null);
  const send = await service.sendApproved(identity, {
    draftId: '00000000-0000-4000-8000-000000000006',
    deliveryId: '00000000-0000-4000-8000-000000000007',
    leaseToken: '00000000-0000-4000-8000-000000000008',
    target: { kind: 'dm', accountId: ACCOUNT, providerConversationId: 'conversation-1' },
  });
  assert.deepEqual(send, { ok: false, kind: 'forbidden', providerEffects: 'none' });
  assert.equal(claims, 0);
});

test('social Messaging view escapes provider content and withholds send until approval', () => {
  const snapshot: Extract<PortalZernioMessagingSnapshot, { ok: true }> = {
    ok: true, provider: 'zernio', providerEffects: false,
    outboundEffectsEnabled: false, emergencyPaused: true,
    checkedAt: '2026-09-01T01:01:01.000Z', conversations: [conversation],
    commentPosts: [commentedPost], selectedConversation: conversation,
    selectedCommentPost: null, selectedComment: null,
    selectedTarget: { kind: 'dm', accountId: ACCOUNT, providerConversationId: 'conversation-1' },
    messages: [message], comments: [],
    reply: null,
    conversationHistoryTruncated: false, queueTruncated: false,
  };
  const html = renderZernioMessagingBody(snapshot, { security: {
    csrfToken: 'csrf', draftId: '00000000-0000-4000-8000-000000000001',
    approvalRequestId: '00000000-0000-4000-8000-000000000002',
    decisionId: '00000000-0000-4000-8000-000000000003',
    deliveryId: '00000000-0000-4000-8000-000000000004',
    leaseToken: '00000000-0000-4000-8000-000000000005',
  } });
  assert.match(html, /Social messages/u);
  assert.doesNotMatch(html, /<script>alert/u);
  assert.match(html, /&lt;script&gt;alert/u);
  assert.match(html, /Save immutable draft/u);
  assert.doesNotMatch(html, /Send approved reply now/u);
  assert.match(html, /OUTBOUND EFFECTS OFF/u);
});

test('approved social reply claims once, calls the provider once and settles accepted evidence', async () => {
  let sends = 0;
  const settlements: unknown[] = [];
  const service = new LivePortalZernioMessagingService({
    accounts: { async snapshot() { return { ok: true as const, accounts: [{
      accountId: '00000000-0000-4000-8000-000000000001', network: 'instagram' as const,
      username: 'propertypredator', displayName: 'Property Predator', status: 'active' as const,
      linkedAt: '2026-08-31T20:00:00.000Z', lastEventAt: '2026-08-31T20:00:00.000Z',
      webhookReceiptCount: 1,
    }] }; } },
    client: client(),
    sender: { async sendMessage() {
      sends += 1;
      return { accepted: true as const, providerMessageId: 'provider-message-2',
        responseSha256: 'b'.repeat(64), idempotentReplay: false };
    }, async replyToComment() { throw new Error('not expected'); } },
    replies: {
      ...replies(),
      async settle(_identity, input) {
        settlements.push(input);
        return { ok: true as const, value: 'accepted' };
      },
    },
    allowedAccountIds: [ACCOUNT], commentAccountBindings,
    providerEffectsEnabled: true, emergencyPaused: false,
  });
  const result = await service.sendApproved(identity, {
    draftId: '00000000-0000-4000-8000-000000000010',
    deliveryId: '00000000-0000-4000-8000-000000000011',
    leaseToken: '00000000-0000-4000-8000-000000000012',
    target: { kind: 'dm', accountId: ACCOUNT, providerConversationId: 'conversation-1' },
  });
  assert.deepEqual(result, {
    ok: true, disposition: 'sent', providerEffects: 'one_message_accepted',
  });
  assert.equal(sends, 1);
  assert.equal(settlements.length, 1);
  assert.equal((settlements[0] as { state: string }).state, 'accepted');
});

test('a malformed successful provider response is quarantined instead of marked failed', async () => {
  const settlements: unknown[] = [];
  const service = new LivePortalZernioMessagingService({
    accounts: { async snapshot() { return { ok: true as const, accounts: [{
      accountId: '00000000-0000-4000-8000-000000000001', network: 'instagram' as const,
      username: 'propertypredator', displayName: 'Property Predator', status: 'active' as const,
      linkedAt: '2026-08-31T20:00:00.000Z', lastEventAt: '2026-08-31T20:00:00.000Z',
      webhookReceiptCount: 1,
    }] }; } },
    client: client(),
    sender: {
      async sendMessage() { throw new ZernioMessagingError('invalid_provider_response'); },
      async replyToComment() { throw new Error('not expected'); },
    },
    replies: {
      ...replies(),
      async settle(_identity, input) {
        settlements.push(input);
        return { ok: true as const, value: 'outcome_unknown' };
      },
    },
    allowedAccountIds: [ACCOUNT], commentAccountBindings,
    providerEffectsEnabled: true, emergencyPaused: false,
  });
  const result = await service.sendApproved(identity, {
    draftId: '00000000-0000-4000-8000-000000000013',
    deliveryId: '00000000-0000-4000-8000-000000000014',
    leaseToken: '00000000-0000-4000-8000-000000000015',
    target: { kind: 'dm', accountId: ACCOUNT, providerConversationId: 'conversation-1' },
  });
  assert.deepEqual(result, { ok: false, kind: 'outcome_unknown', providerEffects: 'unknown' });
  assert.equal(settlements.length, 1);
  assert.deepEqual(settlements[0], {
    deliveryId: '00000000-0000-4000-8000-000000000014',
    leaseToken: '00000000-0000-4000-8000-000000000015',
    state: 'outcome_unknown', providerMessageIdSha256: null,
    providerResponseSha256: null, failureCode: 'outcome_unknown',
  });
});

test('an accepted provider response stays outcome unknown when evidence settlement is unavailable', async () => {
  const service = new LivePortalZernioMessagingService({
    accounts: { async snapshot() { return { ok: true as const, accounts: [{
      accountId: '00000000-0000-4000-8000-000000000001', network: 'instagram' as const,
      username: 'propertypredator', displayName: 'Property Predator', status: 'active' as const,
      linkedAt: '2026-08-31T20:00:00.000Z', lastEventAt: '2026-08-31T20:00:00.000Z',
      webhookReceiptCount: 1,
    }] }; } },
    client: client(), sender,
    replies: {
      ...replies(), async settle() { throw new Error('database unavailable'); },
    },
    allowedAccountIds: [ACCOUNT], commentAccountBindings,
    providerEffectsEnabled: true, emergencyPaused: false,
  });
  const result = await service.sendApproved(identity, {
    draftId: '00000000-0000-4000-8000-000000000016',
    deliveryId: '00000000-0000-4000-8000-000000000017',
    leaseToken: '00000000-0000-4000-8000-000000000018',
    target: { kind: 'dm', accountId: ACCOUNT, providerConversationId: 'conversation-1' },
  });
  assert.deepEqual(result, { ok: false, kind: 'outcome_unknown', providerEffects: 'unknown' });
});

test('an already-claimed social reply never calls the provider again', async () => {
  let sends = 0;
  const service = new LivePortalZernioMessagingService({
    accounts: { async snapshot() { return { ok: true as const, accounts: [{
      accountId: '00000000-0000-4000-8000-000000000001', network: 'instagram' as const,
      username: null, displayName: null, status: 'active' as const,
      linkedAt: '2026-08-31T20:00:00.000Z', lastEventAt: '2026-08-31T20:00:00.000Z',
      webhookReceiptCount: 1,
    }] }; } },
    client: client(),
    sender: { async sendMessage() {
      sends += 1;
      return { accepted: true as const, providerMessageId: 'provider-message-2',
        responseSha256: 'b'.repeat(64), idempotentReplay: false };
    }, async replyToComment() { throw new Error('not expected'); } },
    replies: {
      ...replies(),
      async claim() { return { ok: true as const, value: {
        disposition: 'already_outcome_unknown', body: null, bodySha256: 'a'.repeat(64),
      } }; },
    },
    allowedAccountIds: [ACCOUNT], commentAccountBindings,
    providerEffectsEnabled: true, emergencyPaused: false,
  });
  const result = await service.sendApproved(identity, {
    draftId: '00000000-0000-4000-8000-000000000020',
    deliveryId: '00000000-0000-4000-8000-000000000021',
    leaseToken: '00000000-0000-4000-8000-000000000022',
    target: { kind: 'dm', accountId: ACCOUNT, providerConversationId: 'conversation-1' },
  });
  assert.deepEqual(result, { ok: false, kind: 'conflict', providerEffects: 'none' });
  assert.equal(sends, 0);
});

test('Instagram comment posts and exact threads join the inbox while reads stay live under pause', async () => {
  const reads: unknown[] = [];
  const service = new LivePortalZernioMessagingService({
    accounts: { async snapshot() { return { ok: true as const, accounts: [{
      accountId: '00000000-0000-4000-8000-000000000001', network: 'instagram' as const,
      username: 'propertypredator', displayName: 'Property Predator', status: 'active' as const,
      linkedAt: '2026-08-31T20:00:00.000Z', lastEventAt: '2026-08-31T20:00:00.000Z',
      webhookReceiptCount: 1,
    }] }; } },
    client: client(), sender, replies: {
      ...replies(),
      async read(_identity, input) { reads.push(input); return { ok: true as const, value: null }; },
    },
    allowedAccountIds: [ACCOUNT], commentAccountBindings,
    providerEffectsEnabled: false, emergencyPaused: true,
  });
  const result = await service.snapshot(identity, { comment: {
    accountId: ACCOUNT, platform: 'instagram', providerPostId: 'ig-post-1',
    providerCommentId: 'ig-comment-1',
  } });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.conversations.length, 1);
  assert.equal(result.commentPosts.length, 1);
  assert.equal(result.selectedConversation, null);
  assert.equal(result.selectedComment?.providerCommentId, 'ig-comment-1');
  assert.equal(result.selectedTarget?.kind, 'comment');
  assert.equal(result.outboundEffectsEnabled, false);
  assert.equal(result.emergencyPaused, true);
  assert.equal(reads.length, 1);
  assert.equal((reads[0] as { providerConversationId: string }).providerConversationId,
    zernioMessagingTargetReference({
      kind: 'comment', accountId: ACCOUNT, platform: 'instagram',
      providerPostId: 'ig-post-1', providerCommentId: 'ig-comment-1',
    }));
  const html = renderZernioMessagingBody(result, { security: {
    csrfToken: 'csrf', draftId: '00000000-0000-4000-8000-000000000001',
    approvalRequestId: '00000000-0000-4000-8000-000000000002',
    decisionId: '00000000-0000-4000-8000-000000000003',
    deliveryId: '00000000-0000-4000-8000-000000000004',
    leaseToken: '00000000-0000-4000-8000-000000000005',
  } });
  assert.match(html, /Instagram comments/u);
  assert.match(html, /A &lt;banger&gt; walkthrough/u);
  assert.match(html, /Can I see &lt;script&gt;this&lt;\/script&gt;\?/u);
  assert.match(html, /Save immutable draft/u);
  assert.match(html, /OUTBOUND EFFECTS OFF/u);
});

test('LinkedIn comment posts and threads enter the network-qualified immutable ledger', async () => {
  const linkedinAccount = 'linkedin-account-1';
  const linkedinPost = Object.freeze({
    ...commentedPost, providerPostId: 'linkedin-post-1', platform: 'linkedin' as const,
    accountId: linkedinAccount, accountUsername: 'propertypredator-linkedin',
  });
  const linkedinComment = Object.freeze({
    ...comment, providerCommentId: 'linkedin-comment-1', providerPostId: 'linkedin-post-1',
    platform: 'linkedin' as const, accountId: linkedinAccount,
  });
  const ledgerReads: unknown[] = [];
  const ledgerCreates: unknown[] = [];
  const service = new LivePortalZernioMessagingService({
    accounts: { async snapshot() { return { ok: true as const, accounts: [{
      accountId: '00000000-0000-4000-8000-000000000002', network: 'linkedin' as const,
      username: 'propertypredator-linkedin', displayName: 'Property Predator', status: 'active' as const,
      linkedAt: '2026-08-31T20:00:00.000Z', lastEventAt: '2026-08-31T20:00:00.000Z',
      webhookReceiptCount: 1,
    }] }; } },
    client: {
      async listConversations() { throw new Error('LinkedIn has no personal DM read'); },
      async listMessages() { throw new Error('LinkedIn has no personal DM read'); },
      async listCommentedPosts() { return {
        posts: [linkedinPost], checkedAt: '2026-09-01T01:30:00.000Z',
        hasMore: false, nextCursor: null,
      }; },
      async listPostComments() { return {
        comments: [linkedinComment], checkedAt: '2026-09-01T01:30:01.000Z',
        hasMore: false, nextCursor: null,
      }; },
    },
    sender, replies: {
      ...replies(),
      async read(_identity, input) {
        ledgerReads.push(input);
        return { ok: true as const, value: null };
      },
      async create(_identity, input) {
        ledgerCreates.push(input);
        return { ok: true as const, value: 'created' as const };
      },
    },
    allowedAccountIds: [linkedinAccount], commentAccountBindings: [{
      accountId: linkedinAccount, platform: 'linkedin',
    }],
    providerEffectsEnabled: true, emergencyPaused: false,
  });
  const target = {
    kind: 'comment' as const, accountId: linkedinAccount, platform: 'linkedin' as const,
    providerPostId: 'linkedin-post-1', providerCommentId: 'linkedin-comment-1',
  };
  const result = await service.snapshot(identity, { comment: target });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.selectedComment?.platform, 'linkedin');
  assert.equal(result.reply, null);
  assert.equal(ledgerReads.length, 1);
  const html = renderZernioMessagingBody(result, { security: {
    csrfToken: 'csrf', draftId: '00000000-0000-4000-8000-000000000001',
    approvalRequestId: '00000000-0000-4000-8000-000000000002',
    decisionId: '00000000-0000-4000-8000-000000000003',
    deliveryId: '00000000-0000-4000-8000-000000000004',
    leaseToken: '00000000-0000-4000-8000-000000000005',
  } });
  assert.match(html, /LinkedIn comments/u);
  assert.match(html, /Save immutable draft/u);
  assert.deepEqual(await service.createDraft(identity, {
    draftId: '00000000-0000-4000-8000-000000000010', target, body: 'Approved draft',
  }), { ok: true, disposition: 'created', providerEffects: 'none' });
  assert.deepEqual(ledgerCreates[0], {
    draftId: '00000000-0000-4000-8000-000000000010', network: 'linkedin',
    accountId: linkedinAccount, providerConversationId: zernioMessagingTargetReference(target),
    body: 'Approved draft',
  });
});

test('an approved LinkedIn comment reply claims and sends with exact network and target binding', async () => {
  const linkedinAccount = 'linkedin-account-1';
  const linkedinPost = Object.freeze({
    ...commentedPost, providerPostId: 'linkedin-post-1', platform: 'linkedin' as const,
    accountId: linkedinAccount, accountUsername: 'propertypredator-linkedin',
  });
  const linkedinComment = Object.freeze({
    ...comment, providerCommentId: 'linkedin-comment-1', providerPostId: 'linkedin-post-1',
    platform: 'linkedin' as const, accountId: linkedinAccount,
  });
  const claims: unknown[] = [];
  const sends: unknown[] = [];
  const target = {
    kind: 'comment' as const, accountId: linkedinAccount, platform: 'linkedin' as const,
    providerPostId: 'linkedin-post-1', providerCommentId: 'linkedin-comment-1',
  };
  const service = new LivePortalZernioMessagingService({
    accounts: { async snapshot() { return { ok: true as const, accounts: [{
      accountId: '00000000-0000-4000-8000-000000000002', network: 'linkedin' as const,
      username: 'propertypredator-linkedin', displayName: 'Property Predator', status: 'active' as const,
      linkedAt: '2026-08-31T20:00:00.000Z', lastEventAt: '2026-08-31T20:00:00.000Z',
      webhookReceiptCount: 1,
    }] }; } },
    client: {
      async listConversations() { throw new Error('LinkedIn has no personal DM read'); },
      async listMessages() { throw new Error('LinkedIn has no personal DM read'); },
      async listCommentedPosts() { return {
        posts: [linkedinPost], checkedAt: '2026-09-01T01:30:00.000Z',
        hasMore: false, nextCursor: null,
      }; },
      async listPostComments() { return {
        comments: [linkedinComment], checkedAt: '2026-09-01T01:30:01.000Z',
        hasMore: false, nextCursor: null,
      }; },
    },
    sender: {
      async sendMessage() { throw new Error('DM sender must not run'); },
      async replyToComment(input) {
        sends.push(input);
        return { accepted: true as const, providerReplyCommentId: 'linkedin-reply-1',
          responseSha256: 'd'.repeat(64), idempotentReplay: false };
      },
    },
    replies: {
      ...replies(), async claim(_identity, input) {
        claims.push(input);
        return { ok: true as const, value: {
          disposition: 'claimed', body: 'Approved LinkedIn reply', bodySha256: 'a'.repeat(64),
        } };
      },
    },
    allowedAccountIds: [], commentAccountBindings: [{
      accountId: linkedinAccount, platform: 'linkedin',
    }],
    providerEffectsEnabled: true, emergencyPaused: false,
  });
  const result = await service.sendApproved(identity, {
    draftId: '00000000-0000-4000-8000-000000000050',
    deliveryId: '00000000-0000-4000-8000-000000000051',
    leaseToken: '00000000-0000-4000-8000-000000000052', target,
  });
  assert.deepEqual(result, { ok: true, disposition: 'sent', providerEffects: 'one_message_accepted' });
  assert.deepEqual(claims[0], {
    draftId: '00000000-0000-4000-8000-000000000050',
    deliveryId: '00000000-0000-4000-8000-000000000051',
    leaseToken: '00000000-0000-4000-8000-000000000052', network: 'linkedin',
    accountId: linkedinAccount, providerConversationId: zernioMessagingTargetReference(target),
    idempotencyKey: 'reply:00000000-0000-4000-8000-000000000051',
  });
  assert.deepEqual(sends[0], {
    accountId: linkedinAccount, platform: 'linkedin', providerPostId: 'linkedin-post-1',
    providerCommentId: 'linkedin-comment-1', body: 'Approved LinkedIn reply',
    idempotencyKey: 'reply:00000000-0000-4000-8000-000000000051',
  });
});

test('an approved Instagram comment reply reuses the immutable ledger and exact target binding', async () => {
  const claims: unknown[] = [];
  const calls: unknown[] = [];
  const target = {
    kind: 'comment' as const, accountId: ACCOUNT, platform: 'instagram' as const,
    providerPostId: 'ig-post-1', providerCommentId: 'ig-comment-1',
  };
  const service = new LivePortalZernioMessagingService({
    accounts: { async snapshot() { return { ok: true as const, accounts: [{
      accountId: '00000000-0000-4000-8000-000000000001', network: 'instagram' as const,
      username: 'propertypredator', displayName: 'Property Predator', status: 'active' as const,
      linkedAt: '2026-08-31T20:00:00.000Z', lastEventAt: '2026-08-31T20:00:00.000Z',
      webhookReceiptCount: 1,
    }] }; } },
    client: client(),
    sender: {
      async sendMessage() { throw new Error('DM sender must not run'); },
      async replyToComment(input) {
        calls.push(input);
        return { accepted: true as const, providerReplyCommentId: 'provider-comment-2',
          responseSha256: 'c'.repeat(64), idempotentReplay: false };
      },
    },
    replies: {
      ...replies(), async claim(_identity, input) {
        claims.push(input);
        return { ok: true as const, value: {
          disposition: 'claimed', body: 'Approved public reply', bodySha256: 'a'.repeat(64),
        } };
      },
    },
    allowedAccountIds: [ACCOUNT], commentAccountBindings,
    providerEffectsEnabled: true, emergencyPaused: false,
  });
  const result = await service.sendApproved(identity, {
    draftId: '00000000-0000-4000-8000-000000000030',
    deliveryId: '00000000-0000-4000-8000-000000000031',
    leaseToken: '00000000-0000-4000-8000-000000000032', target,
  });
  assert.deepEqual(result, { ok: true, disposition: 'sent', providerEffects: 'one_message_accepted' });
  assert.equal(claims.length, 1);
  assert.equal((claims[0] as { network: string }).network, 'instagram');
  assert.equal((claims[0] as { providerConversationId: string }).providerConversationId,
    zernioMessagingTargetReference(target));
  assert.deepEqual(calls[0], {
    accountId: ACCOUNT, platform: 'instagram', providerPostId: 'ig-post-1',
    providerCommentId: 'ig-comment-1', body: 'Approved public reply',
    idempotencyKey: 'reply:00000000-0000-4000-8000-000000000031',
  });
});

test('effects and emergency pause block all social sends before claim or provider I/O', async () => {
  let touched = 0;
  const make = (providerEffectsEnabled: boolean, emergencyPaused: boolean) =>
    new LivePortalZernioMessagingService({
      accounts: { async snapshot() { touched += 1; return { ok: true as const, accounts: [] }; } },
      client: client(), sender, replies: {
        ...replies(), async claim() { touched += 1; return replies().claim(); },
      },
      allowedAccountIds: [ACCOUNT], commentAccountBindings,
      providerEffectsEnabled, emergencyPaused,
    });
  const input = {
    draftId: '00000000-0000-4000-8000-000000000040',
    deliveryId: '00000000-0000-4000-8000-000000000041',
    leaseToken: '00000000-0000-4000-8000-000000000042',
    target: { kind: 'dm' as const, accountId: ACCOUNT, providerConversationId: 'conversation-1' },
  };
  assert.deepEqual(await make(false, false).sendApproved(identity, input), {
    ok: false, kind: 'effects_disabled', providerEffects: 'none',
  });
  assert.deepEqual(await make(true, true).sendApproved(identity, input), {
    ok: false, kind: 'emergency_paused', providerEffects: 'none',
  });
  assert.equal(touched, 0);
});
