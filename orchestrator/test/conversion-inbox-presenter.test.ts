import assert from 'node:assert/strict';
import test from 'node:test';
import type { InboxConversationSummary } from '../src/inbox-pg/types.js';
import { createPropertyPredatorTestInboxSnapshot } from '../src/portal/conversion-inbox-fixtures.js';
import {
  CONVERSION_INBOX_MAX_CONVERSATIONS,
  CONVERSION_INBOX_MAX_CONSENTS,
  CONVERSION_INBOX_MAX_MESSAGE_BYTES,
  CONVERSION_INBOX_MAX_MESSAGES,
  CONVERSION_INBOX_MAX_QUERY_LENGTH,
  normaliseConversionInboxFilters,
  presentConversionInbox,
  type ConversionInboxSnapshot,
} from '../src/portal/conversion-inbox-presenter.js';

const WORKSPACE = 'Property Predator Growth HQ';

test('normalises channel, queue and Unicode-safe bounded search filters', () => {
  const filters = normaliseConversionInboxFilters({
    query: `  ${'🐆'.repeat(CONVERSION_INBOX_MAX_QUERY_LENGTH + 10)}  `,
    channel: 'whatsapp',
    queue: 'approval',
  });
  assert.equal([...filters.query].length, CONVERSION_INBOX_MAX_QUERY_LENGTH);
  assert.equal(filters.channel, 'whatsapp');
  assert.equal(filters.queue, 'approval');
  assert.deepEqual(normaliseConversionInboxFilters({ channel: 'telegram', queue: 'mine' }), {
    query: '', channel: 'all', queue: 'all',
  });
});

test('projects the canonical inbox page into a channel-aware conversion queue', () => {
  const view = presentConversionInbox(createPropertyPredatorTestInboxSnapshot(), {
    workspaceName: WORKSPACE,
  });
  assert.equal(view.loadedConversationCount, 5);
  assert.equal(view.matchingConversationCount, 5);
  assert.equal(view.totalUnreadCount, 6);
  assert.deepEqual(view.channels.map(({ channel, count }) => [channel, count]), [
    ['all', 5], ['email', 1], ['whatsapp', 1], ['sms', 1], ['instagram', 1], ['facebook', 1],
  ]);
  assert.equal(view.selectedThread?.lead.displayName, 'Aisha Rahman');
  assert.equal(view.selectedThread?.summary.channel, 'email');
  assert.equal(view.selectedThread?.draft.approvalLabel, 'Approval pending');
  assert.equal(view.selectedThread?.draft.mayQueueTestOperation, false);
});

test('filters loaded summaries without inventing data outside InboxConversationPage', () => {
  const snapshot = createPropertyPredatorTestInboxSnapshot();
  const whatsapp = presentConversionInbox(snapshot, {
    workspaceName: WORKSPACE,
    filters: { channel: 'whatsapp' },
  });
  assert.deepEqual(whatsapp.conversations.map((item) => item.contactName), ['Priya Nair']);
  assert.equal(whatsapp.selectedThread?.draft.exactApproval, true);
  assert.equal(whatsapp.selectedThread?.draft.deliveryLabel, 'TEST queue only');
  assert.equal(whatsapp.selectedThread?.draft.mayQueueTestOperation, false);

  const query = presentConversionInbox(snapshot, {
    workspaceName: WORKSPACE,
    filters: { query: 'compare two potential' },
  });
  assert.deepEqual(query.conversations.map((item) => item.channel), ['facebook']);

  const approvals = presentConversionInbox(snapshot, {
    workspaceName: WORKSPACE,
    filters: { queue: 'approval' },
  });
  assert.deepEqual(approvals.conversations.map((item) => item.contactName), [
    'Aisha Rahman', 'Sophie Grant', 'Liam Carter',
  ]);
});

test('keeps approved content fail-closed when current channel consent is unknown', () => {
  const view = presentConversionInbox(createPropertyPredatorTestInboxSnapshot(), {
    workspaceName: WORKSPACE,
    filters: { channel: 'instagram' },
  });
  assert.equal(view.selectedThread?.lead.displayName, 'Marcus Reed');
  assert.equal(view.selectedThread?.draft.exactApproval, true);
  assert.equal(view.selectedThread?.draft.consentAllowsQueueing, false);
  assert.equal(view.selectedThread?.draft.mayQueueTestOperation, false);
  assert.match(view.selectedThread?.draft.gateDetail ?? '', /consent does not permit/i);
});

test('never joins a thread projection to a different contact', () => {
  const base = createPropertyPredatorTestInboxSnapshot();
  const first = base.threads[0]!;
  const snapshot: ConversionInboxSnapshot = {
    page: base.page,
    threads: [{
      ...first,
      lead: { ...first.lead, contactId: '99999999-9999-4999-8999-999999999999' },
    }, ...base.threads.slice(1)],
  };
  const view = presentConversionInbox(snapshot, { workspaceName: WORKSPACE });
  assert.equal(view.conversations[0]?.selected, true);
  assert.equal(view.selectedThread, null);
});

test('honours an explicit selected conversation only when it matches active filters', () => {
  const snapshot = createPropertyPredatorTestInboxSnapshot();
  const facebookId = snapshot.page.conversations[4]!.conversationId;
  const hidden = presentConversionInbox(snapshot, {
    workspaceName: WORKSPACE,
    filters: { channel: 'email', conversationId: facebookId },
  });
  assert.equal(hidden.selectedThread?.summary.channel, 'email');
  const visible = presentConversionInbox(snapshot, {
    workspaceName: WORKSPACE,
    filters: { channel: 'facebook', conversationId: facebookId },
  });
  assert.equal(visible.selectedThread?.summary.conversationId, facebookId);
});

test('bounds conversation, transcript and UTF-8 message rendering', () => {
  const base = createPropertyPredatorTestInboxSnapshot();
  const seed = base.page.conversations[0]!;
  const conversations: InboxConversationSummary[] = Array.from(
    { length: CONVERSION_INBOX_MAX_CONVERSATIONS + 7 },
    (_, index) => ({
      ...seed,
      conversationId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      contactId: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      contactName: `Fictional Lead ${index + 1}`,
    }),
  );
  const selectedSummary = conversations[0]!;
  const longBody = '🐆'.repeat(CONVERSION_INBOX_MAX_MESSAGE_BYTES);
  const templateThread = base.threads[0]!;
  const messages = Array.from({ length: CONVERSION_INBOX_MAX_MESSAGES + 9 }, (_, index) => ({
    ...templateThread.messages[0]!,
    messageId: `50000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    body: index === CONVERSION_INBOX_MAX_MESSAGES + 8 ? longBody : `Bounded message ${index + 1}`,
  }));
  const snapshot: ConversionInboxSnapshot = {
    page: { ...base.page, conversations, nextCursor: base.page.nextCursor },
    threads: [{
      ...templateThread,
      conversationId: selectedSummary.conversationId,
      lead: { ...templateThread.lead, contactId: selectedSummary.contactId! },
      messages,
      consents: Array.from({ length: CONVERSION_INBOX_MAX_CONSENTS + 4 }, () => templateThread.consents[0]!),
      draft: { ...templateThread.draft, body: longBody },
    }],
  };
  const view = presentConversionInbox(snapshot, { workspaceName: WORKSPACE });
  assert.equal(view.loadedConversationCount, CONVERSION_INBOX_MAX_CONVERSATIONS);
  assert.equal(view.inputTruncated, true);
  assert.equal(view.hasMore, true);
  assert.equal(view.selectedThread?.messages.length, CONVERSION_INBOX_MAX_MESSAGES);
  assert.equal(view.selectedThread?.transcriptTruncated, true);
  assert.equal(view.selectedThread?.consents.length, CONVERSION_INBOX_MAX_CONSENTS);
  const finalBody = view.selectedThread?.messages.at(-1)?.body ?? '';
  assert.ok(Buffer.byteLength(finalBody, 'utf8') <= CONVERSION_INBOX_MAX_MESSAGE_BYTES);
  assert.equal(view.selectedThread?.messages.at(-1)?.bodyTruncated, true);
  assert.ok(Buffer.byteLength(view.selectedThread?.draft.body ?? '', 'utf8') <= CONVERSION_INBOX_MAX_MESSAGE_BYTES);
  assert.equal(view.selectedThread?.draft.bodyTruncated, true);
});

test('fixture remains explicitly fictional and spans every supported conversation channel', () => {
  const snapshot = createPropertyPredatorTestInboxSnapshot();
  assert.deepEqual(new Set(snapshot.page.conversations.map((item) => item.channel)), new Set([
    'email', 'whatsapp', 'sms', 'instagram', 'facebook',
  ]));
  assert.ok(snapshot.threads.every((thread) => thread.consents.length > 0));
  assert.equal(snapshot.page.conversations.length, snapshot.threads.length);
});
