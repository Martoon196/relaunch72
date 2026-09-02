import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createZernioMessagingClient,
  ZernioMessagingError,
} from '../src/public-social-outbound/zernio-messaging-client.js';

const ACCOUNT = '6a95e99a77555aae01643ae2';
const PROFILE = 'profile_property_predator';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function conversation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ig-conversation-1', platform: 'instagram', accountId: ACCOUNT,
    accountUsername: 'propertypredator', participantId: 'participant-1',
    participantName: 'Property Hunter', lastMessage: 'Is this available?',
    updatedTime: '2026-09-01T01:00:00.000Z', status: 'active', unreadCount: 1,
    url: 'https://www.instagram.com/direct/t/123/', ...overrides,
  };
}

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ig-message-1', conversationId: 'ig-conversation-1', accountId: ACCOUNT,
    platform: 'instagram', message: 'Is this available?', senderId: 'participant-1',
    senderName: 'Property Hunter', direction: 'incoming',
    createdAt: '2026-09-01T01:00:00.000Z', deliveryStatus: null, sentVia: null,
    ...overrides,
  };
}

function commentedPost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ig-post-1', platform: 'instagram', accountId: ACCOUNT,
    accountUsername: 'propertypredator', content: 'The two-minute deal-finder walkthrough.',
    picture: 'https://cdn.example.test/post.jpg',
    permalink: 'https://www.instagram.com/p/ig-post-1/',
    createdTime: '2026-09-01T00:30:00.000Z', commentCount: 4, likeCount: 21,
    isAd: false, ...overrides,
  };
}

function comment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ig-comment-1', message: 'Where can I see the full walkthrough?',
    createdTime: '2026-09-01T01:10:00.000Z',
    from: {
      id: 'participant-1', name: 'Property Hunter', username: 'propertyhunter',
      picture: 'https://cdn.example.test/contact.jpg', isOwner: false, verifiedType: null,
    },
    likeCount: 2, replyCount: 0, platform: 'instagram',
    url: 'https://www.instagram.com/p/ig-post-1/c/ig-comment-1/', replies: [],
    repliesHasMore: false, canReply: true, parentId: null,
    ...overrides,
  };
}

test('Zernio Messaging lists only an explicitly bound account and uses the dedicated bearer boundary', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = createZernioMessagingClient({
    apiKey: 'zrk_test_messaging_secret', providerProfileId: PROFILE,
    allowedAccountIds: [ACCOUNT], now: () => new Date('2026-09-01T01:01:00Z'),
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return json({ data: [conversation()], pagination: { hasMore: false } });
    },
  });
  const result = await client.listConversations({ accountIds: [ACCOUNT] });
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0]?.participantName, 'Property Hunter');
  assert.equal(result.checkedAt, '2026-09-01T01:01:00.000Z');
  const url = new URL(requests[0]!.url);
  assert.equal(url.origin, 'https://zernio.com');
  assert.equal(url.pathname, '/api/v1/inbox/conversations');
  assert.equal(url.searchParams.get('profileId'), PROFILE);
  assert.equal(url.searchParams.get('limit'), '100');
  assert.equal((requests[0]!.init.headers as Record<string, string>).authorization,
    'Bearer zrk_test_messaging_secret');
  assert.equal(requests[0]!.init.redirect, 'error');
});

test('Zernio Messaging reads an exact conversation without causing a read receipt', async () => {
  const requests: string[] = [];
  const client = createZernioMessagingClient({
    apiKey: 'zrk_test_messaging_secret', providerProfileId: PROFILE,
    allowedAccountIds: [ACCOUNT],
    fetch: async (url, init) => {
      assert.equal(init?.method, 'GET');
      requests.push(String(url));
      return json({ messages: [message()], pagination: { hasMore: false }, sortOrderApplied: 'asc' });
    },
  });
  const result = await client.listMessages({
    accountId: ACCOUNT, providerConversationId: 'ig-conversation-1',
  });
  assert.equal(result.messages[0]?.direction, 'incoming');
  const url = new URL(requests[0]!);
  assert.equal(url.pathname, '/api/v1/inbox/conversations/ig-conversation-1/messages');
  assert.equal(url.searchParams.get('accountId'), ACCOUNT);
  assert.equal(url.searchParams.get('sortOrder'), 'asc');
});

test('Zernio Messaging renders attachment-only provider events without weakening identity checks', async () => {
  const client = createZernioMessagingClient({
    apiKey: 'zrk_test_messaging_secret', providerProfileId: PROFILE,
    allowedAccountIds: [ACCOUNT],
    fetch: async () => json({
      messages: [message({ message: '', attachments: [{ type: 'image' }] })],
      pagination: { hasMore: false }, sortOrderApplied: 'asc',
    }),
  });
  const result = await client.listMessages({
    accountId: ACCOUNT, providerConversationId: 'ig-conversation-1',
  });
  assert.equal(result.messages[0]?.body, '[Attachment]');
  assert.equal(result.messages[0]?.providerConversationId, 'ig-conversation-1');
  assert.equal(result.messages[0]?.accountId, ACCOUNT);
});

test('Zernio Messaging rejects account or conversation substitution before provider I/O', async () => {
  let called = false;
  const client = createZernioMessagingClient({
    apiKey: 'zrk_test_messaging_secret', providerProfileId: PROFILE,
    allowedAccountIds: [ACCOUNT], fetch: async () => { called = true; return json({}); },
  });
  await assert.rejects(
    client.listConversations({ accountIds: ['attacker-account'] }),
    (error: unknown) => error instanceof ZernioMessagingError && error.code === 'unbound_target',
  );
  await assert.rejects(
    client.listMessages({ accountId: ACCOUNT, providerConversationId: 'line\nbreak' }),
    (error: unknown) => error instanceof ZernioMessagingError && error.code === 'unbound_target',
  );
  assert.equal(called, false);
});

test('Zernio Messaging fails closed on permission and response-shape regressions', async () => {
  const forbidden = createZernioMessagingClient({
    apiKey: 'zrk_test_messaging_secret', providerProfileId: PROFILE,
    allowedAccountIds: [ACCOUNT], fetch: async () => json({ error: 'disabled' }, 403),
  });
  await assert.rejects(
    forbidden.listConversations({ accountIds: [ACCOUNT] }),
    (error: unknown) => error instanceof ZernioMessagingError && error.code === 'forbidden',
  );
  const malformed = createZernioMessagingClient({
    apiKey: 'zrk_test_messaging_secret', providerProfileId: PROFILE,
    allowedAccountIds: [ACCOUNT], fetch: async () => json({ data: [conversation({ unreadCount: -1 })] }),
  });
  await assert.rejects(
    malformed.listConversations({ accountIds: [ACCOUNT] }),
    (error: unknown) => error instanceof ZernioMessagingError
      && error.code === 'invalid_provider_response',
  );
});

test('Zernio Messaging sends only an exact approved body with an idempotency key', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = createZernioMessagingClient({
    apiKey: 'zrk_test_messaging_secret', providerProfileId: PROFILE,
    allowedAccountIds: [ACCOUNT],
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return json({ data: { messageId: 'provider-message-2' } }, 200,
        { 'idempotent-replayed': 'true' });
    },
  });
  const result = await client.sendMessage({
    accountId: ACCOUNT, providerConversationId: 'ig-conversation-1',
    body: 'Yes — I can help with that.', idempotencyKey: 'reply:00000000-0000-4000-8000-000000000001',
  });
  assert.equal(result.providerMessageId, 'provider-message-2');
  assert.equal(result.idempotentReplay, true);
  assert.match(result.responseSha256, /^[0-9a-f]{64}$/u);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.init.method, 'POST');
  assert.equal((requests[0]!.init.headers as Record<string, string>)['idempotency-key'],
    'reply:00000000-0000-4000-8000-000000000001');
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), {
    accountId: ACCOUNT, message: 'Yes — I can help with that.',
  });
});

test('Zernio Messaging treats transport failure during a send as outcome unknown', async () => {
  const client = createZernioMessagingClient({
    apiKey: 'zrk_test_messaging_secret', providerProfileId: PROFILE,
    allowedAccountIds: [ACCOUNT], fetch: async () => { throw new Error('timeout'); },
  });
  await assert.rejects(
    client.sendMessage({
      accountId: ACCOUNT, providerConversationId: 'ig-conversation-1',
      body: 'Approved exact reply', idempotencyKey: 'reply:00000000-0000-4000-8000-000000000002',
    }),
    (error: unknown) => error instanceof ZernioMessagingError && error.code === 'outcome_unknown',
  );
});

test('Zernio Messaging quarantines a malformed successful send response as outcome unknown', async () => {
  const client = createZernioMessagingClient({
    apiKey: 'zrk_test_messaging_secret', providerProfileId: PROFILE,
    allowedAccountIds: [ACCOUNT], fetch: async () => json({ data: {} }),
  });
  await assert.rejects(
    client.sendMessage({
      accountId: ACCOUNT, providerConversationId: 'ig-conversation-1',
      body: 'Approved exact reply', idempotencyKey: 'reply:00000000-0000-4000-8000-000000000006',
    }),
    (error: unknown) => error instanceof ZernioMessagingError && error.code === 'outcome_unknown',
  );
});

test('Zernio Messaging lists an exact account organic comment feed with opaque cursor paging', async () => {
  const requests: string[] = [];
  const client = createZernioMessagingClient({
    apiKey: 'zrk_test_messaging_secret', providerProfileId: PROFILE,
    allowedAccountIds: [ACCOUNT], now: () => new Date('2026-09-01T01:20:00Z'),
    fetch: async (url, init) => {
      assert.equal(init?.method, 'GET');
      requests.push(String(url));
      return json({
        data: [commentedPost(), commentedPost()],
        pagination: { hasMore: true, nextCursor: 'opaque/+cursor==' },
        meta: { accountsQueried: 1, accountsFailed: 0, failedAccounts: [] },
      });
    },
  });
  const result = await client.listCommentedPosts({
    accountId: ACCOUNT, platform: 'instagram', cursor: 'incoming/+cursor==',
  });
  assert.equal(result.posts.length, 1, 'the client deduplicates moving-window pages by post id');
  assert.equal(result.posts[0]?.commentCount, 4);
  assert.equal(result.posts[0]?.pictureUrl, 'https://cdn.example.test/post.jpg');
  assert.equal(result.checkedAt, '2026-09-01T01:20:00.000Z');
  assert.equal(result.hasMore, true);
  assert.equal(result.nextCursor, 'opaque/+cursor==');
  const url = new URL(requests[0]!);
  assert.equal(url.pathname, '/api/v1/inbox/comments');
  assert.equal(url.searchParams.get('profileId'), PROFILE);
  assert.equal(url.searchParams.get('accountId'), ACCOUNT);
  assert.equal(url.searchParams.get('platform'), 'instagram');
  assert.equal(url.searchParams.get('sortBy'), 'date');
  assert.equal(url.searchParams.get('sortOrder'), 'desc');
  assert.equal(url.searchParams.get('limit'), '100');
  assert.equal(url.searchParams.get('cursor'), 'incoming/+cursor==');
});

test('Zernio Messaging reads one account-bound post thread including bounded replies', async () => {
  const requests: string[] = [];
  const client = createZernioMessagingClient({
    apiKey: 'zrk_test_messaging_secret', providerProfileId: PROFILE,
    allowedAccountIds: [ACCOUNT],
    fetch: async (url, init) => {
      assert.equal(init?.method, 'GET');
      requests.push(String(url));
      return json({
        status: 'success',
        comments: [comment({
          replyCount: 1,
          replies: [comment({
            id: 'ig-comment-reply-1', message: 'The link is in our profile.',
            from: {
              id: ACCOUNT, name: 'Property Predator', username: 'propertypredator',
              picture: null, isOwner: true, verifiedType: 'blue',
            },
            parentId: 'ig-comment-1',
          })],
        })],
        pagination: { hasMore: false, cursor: null },
        meta: { platform: 'instagram', postId: 'native-ig-post-1', accountId: ACCOUNT },
      });
    },
  });
  const result = await client.listPostComments({
    accountId: ACCOUNT, platform: 'instagram', providerPostId: 'ig-post-1',
  });
  assert.equal(result.comments.length, 1);
  assert.equal(result.comments[0]?.providerPostId, 'ig-post-1');
  assert.equal(result.comments[0]?.author.providerAuthorId, 'participant-1');
  assert.equal(result.comments[0]?.replies[0]?.providerCommentId, 'ig-comment-reply-1');
  assert.equal(result.comments[0]?.replies[0]?.author.isOwner, true);
  assert.equal(result.hasMore, false);
  assert.equal(result.nextCursor, null);
  const url = new URL(requests[0]!);
  assert.equal(url.pathname, '/api/v1/inbox/comments/ig-post-1');
  assert.equal(url.searchParams.get('accountId'), ACCOUNT);
  assert.equal(url.searchParams.get('limit'), '100');
});

test('Zernio Messaging posts only an exact approved public reply with required idempotency', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = createZernioMessagingClient({
    apiKey: 'zrk_test_messaging_secret', providerProfileId: PROFILE,
    allowedAccountIds: [ACCOUNT],
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return json({
        success: true, data: { commentId: 'ig-comment-reply-2', isReply: true, cid: null },
      }, 200, { 'idempotent-replayed': 'true' });
    },
  });
  const result = await client.replyToComment({
    accountId: ACCOUNT, platform: 'instagram', providerPostId: 'ig-post-1',
    providerCommentId: 'ig-comment-1', body: 'The full walkthrough is linked in our profile.',
    idempotencyKey: 'comment-reply:00000000-0000-4000-8000-000000000003',
  });
  assert.equal(result.accepted, true);
  assert.equal(result.providerReplyCommentId, 'ig-comment-reply-2');
  assert.equal(result.idempotentReplay, true);
  assert.match(result.responseSha256, /^[0-9a-f]{64}$/u);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0]!.url).pathname, '/api/v1/inbox/comments/ig-post-1');
  assert.equal(requests[0]!.init.method, 'POST');
  assert.equal((requests[0]!.init.headers as Record<string, string>)['idempotency-key'],
    'comment-reply:00000000-0000-4000-8000-000000000003');
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), {
    accountId: ACCOUNT,
    message: 'The full walkthrough is linked in our profile.',
    commentId: 'ig-comment-1',
  });
});

test('Zernio Messaging rejects comment target substitution before provider I/O', async () => {
  let called = false;
  const client = createZernioMessagingClient({
    apiKey: 'zrk_test_messaging_secret', providerProfileId: PROFILE,
    allowedAccountIds: [ACCOUNT], fetch: async () => { called = true; return json({}); },
  });
  await assert.rejects(
    client.listCommentedPosts({ accountId: 'attacker-account', platform: 'instagram' }),
    (error: unknown) => error instanceof ZernioMessagingError && error.code === 'unbound_target',
  );
  await assert.rejects(
    client.listPostComments({
      accountId: ACCOUNT, platform: 'linkedin', providerPostId: 'line\nbreak',
    }),
    (error: unknown) => error instanceof ZernioMessagingError && error.code === 'unbound_target',
  );
  await assert.rejects(
    client.replyToComment({
      accountId: ACCOUNT, platform: 'instagram', providerPostId: 'ig-post-1',
      providerCommentId: 'ig-comment-1', body: 'Approved body',
      idempotencyKey: undefined as never,
    }),
    (error: unknown) => error instanceof ZernioMessagingError && error.code === 'unbound_target',
  );
  assert.equal(called, false);
});

test('Zernio Messaging fails closed when a comment feed crosses account or platform boundaries', async () => {
  const crossedAccount = createZernioMessagingClient({
    apiKey: 'zrk_test_messaging_secret', providerProfileId: PROFILE,
    allowedAccountIds: [ACCOUNT],
    fetch: async () => json({
      data: [commentedPost({ accountId: 'attacker-account' })],
      pagination: { hasMore: false },
    }),
  });
  await assert.rejects(
    crossedAccount.listCommentedPosts({ accountId: ACCOUNT, platform: 'instagram' }),
    (error: unknown) => error instanceof ZernioMessagingError && error.code === 'unbound_target',
  );
  const crossedPlatform = createZernioMessagingClient({
    apiKey: 'zrk_test_messaging_secret', providerProfileId: PROFILE,
    allowedAccountIds: [ACCOUNT],
    fetch: async () => json({
      comments: [comment({ platform: 'linkedin' })],
      pagination: { hasMore: false },
      meta: { platform: 'linkedin', postId: 'ig-post-1', accountId: ACCOUNT },
    }),
  });
  await assert.rejects(
    crossedPlatform.listPostComments({
      accountId: ACCOUNT, platform: 'instagram', providerPostId: 'ig-post-1',
    }),
    (error: unknown) => error instanceof ZernioMessagingError && error.code === 'unbound_target',
  );
});

test('Zernio Messaging treats a transport failure during a comment reply as outcome unknown', async () => {
  const client = createZernioMessagingClient({
    apiKey: 'zrk_test_messaging_secret', providerProfileId: PROFILE,
    allowedAccountIds: [ACCOUNT], fetch: async () => { throw new Error('timeout'); },
  });
  await assert.rejects(
    client.replyToComment({
      accountId: ACCOUNT, platform: 'instagram', providerPostId: 'ig-post-1',
      providerCommentId: 'ig-comment-1', body: 'Approved exact reply',
      idempotencyKey: 'comment-reply:00000000-0000-4000-8000-000000000004',
    }),
    (error: unknown) => error instanceof ZernioMessagingError && error.code === 'outcome_unknown',
  );
});

test('Zernio Messaging quarantines a malformed successful comment reply as outcome unknown', async () => {
  const client = createZernioMessagingClient({
    apiKey: 'zrk_test_messaging_secret', providerProfileId: PROFILE,
    allowedAccountIds: [ACCOUNT], fetch: async () => json({ success: true, data: { isReply: true } }),
  });
  await assert.rejects(
    client.replyToComment({
      accountId: ACCOUNT, platform: 'instagram', providerPostId: 'ig-post-1',
      providerCommentId: 'ig-comment-1', body: 'Approved exact reply',
      idempotencyKey: 'comment-reply:00000000-0000-4000-8000-000000000006',
    }),
    (error: unknown) => error instanceof ZernioMessagingError && error.code === 'outcome_unknown',
  );
});

test('Zernio Messaging fails closed on in-flight and ambiguous provider comment replies', async () => {
  const input = {
    accountId: ACCOUNT,
    platform: 'instagram' as const,
    providerPostId: 'ig-post-1',
    providerCommentId: 'ig-comment-1',
    body: 'Approved exact reply',
    idempotencyKey: 'comment-reply:00000000-0000-4000-8000-000000000005',
  };
  const inFlight = createZernioMessagingClient({
    apiKey: 'zrk_test_messaging_secret', providerProfileId: PROFILE,
    allowedAccountIds: [ACCOUNT], fetch: async () => new Response(null, { status: 409 }),
  });
  await assert.rejects(
    inFlight.replyToComment(input),
    (error: unknown) => error instanceof ZernioMessagingError && error.code === 'provider_rejected',
  );
  const ambiguous = createZernioMessagingClient({
    apiKey: 'zrk_test_messaging_secret', providerProfileId: PROFILE,
    allowedAccountIds: [ACCOUNT], fetch: async () => new Response(null, { status: 502 }),
  });
  await assert.rejects(
    ambiguous.replyToComment(input),
    (error: unknown) => error instanceof ZernioMessagingError && error.code === 'outcome_unknown',
  );
});
