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
