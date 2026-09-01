import assert from 'node:assert/strict';
import test from 'node:test';
import type { ZernioMessagingClient } from '../src/public-social-outbound/zernio-messaging-client.js';
import {
  LivePortalZernioMessagingService,
  type PortalZernioMessagingSnapshot,
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

function client(): Pick<ZernioMessagingClient, 'listConversations' | 'listMessages'> {
  return {
    async listConversations() {
      return { conversations: [conversation], checkedAt: '2026-09-01T01:01:00.000Z', hasMore: false };
    },
    async listMessages() {
      return { messages: [message], checkedAt: '2026-09-01T01:01:01.000Z', hasMore: false };
    },
  };
}

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
    client: client(), allowedAccountIds: [ACCOUNT],
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
    },
    allowedAccountIds: [ACCOUNT],
  });
  const result = await service.snapshot(identity, {});
  assert.deepEqual(result, { ok: false, kind: 'unavailable', providerEffects: false });
  assert.equal(providerCalled, false);
});

test('social Messaging view escapes provider content and exposes no enabled outbound control', () => {
  const snapshot: Extract<PortalZernioMessagingSnapshot, { ok: true }> = {
    ok: true, provider: 'zernio', providerEffects: false,
    checkedAt: '2026-09-01T01:01:01.000Z', conversations: [conversation],
    selectedConversation: conversation, messages: [message],
    conversationHistoryTruncated: false, queueTruncated: false,
  };
  const html = renderZernioMessagingBody(snapshot);
  assert.match(html, /Social messages/u);
  assert.doesNotMatch(html, /<script>alert/u);
  assert.match(html, /&lt;script&gt;alert/u);
  assert.match(html, /disabled>Create immutable draft/u);
  assert.match(html, /PROVIDER EFFECTS OFF/u);
});
