import assert from 'node:assert/strict';
import test from 'node:test';
import {
  conversionInboxStatus,
  socialUncheckedStatus,
  socialMessagingStatus,
} from '../src/portal/inbox-source-status.js';
import { renderInboxSourceSwitcher } from '../src/portal/inbox-source-switcher-view.js';
import { renderZernioMessagingBody } from '../src/portal/zernio-messaging-view.js';

test('source switcher distinguishes unavailable, disconnected and failed social reads', () => {
  assert.equal(socialUncheckedStatus(false).state, 'not_available');
  assert.equal(socialUncheckedStatus(true).state, 'check_on_open');
  assert.equal(socialMessagingStatus({ ok: false, kind: 'provider_unavailable', providerEffects: false }).state, 'read_failed');
  assert.equal(socialMessagingStatus({ ok: false, kind: 'forbidden', providerEffects: false }).state, 'permission_missing');
  assert.equal(socialMessagingStatus({ ok: false, kind: 'not_connected', providerEffects: false }).state, 'not_connected');
});

test('successful social reads keep read readiness separate from reply pause', () => {
  const status = socialMessagingStatus({
    ok: true, provider: 'zernio', providerEffects: false,
    outboundEffectsEnabled: false, emergencyPaused: false,
    checkedAt: '2026-09-08T09:42:00.000Z', conversations: [], commentPosts: [],
    selectedConversation: null, selectedCommentPost: null, selectedComment: null,
    selectedTarget: null, messages: [], comments: [], reply: null,
    conversationHistoryTruncated: false, queueTruncated: false,
  });
  assert.equal(status.state, 'paused');
  assert.match(status.readDetail, /checked/);
  assert.match(status.readDetail, /8 Sept 2026, 10:42 BST/);
  assert.doesNotMatch(status.readDetail, /T09:42/);
  assert.match(status.replyDetail, /replies are paused/i);
});

test('switcher has one current source and exposes plain state text', () => {
  const html = renderInboxSourceSwitcher([
    conversionInboxStatus(true), socialMessagingStatus({ ok: false, kind: 'not_connected', providerEffects: false }),
  ], 'conversion');
  assert.equal((html.match(/<a[^>]* aria-current="page"/gu) ?? []).length, 1);
  assert.match(html, /Not connected/);
  assert.match(html, /No active social account is connected/);
});

test('failed social read is not presented as an empty social queue', () => {
  const failed = { ok: false as const, kind: 'provider_unavailable' as const, providerEffects: false as const };
  const html = renderZernioMessagingBody(failed, {
    sourceStatuses: [conversionInboxStatus(true), socialMessagingStatus(failed)],
  });
  assert.match(html, /Social messages could not be refreshed/);
  assert.match(html, /other inbox sources remain available/);
  assert.doesNotMatch(html, /No social conversations or commented posts are available yet/);
});
