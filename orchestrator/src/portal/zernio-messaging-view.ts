import type { PortalZernioMessagingSnapshot } from './zernio-messaging-service.js';
import {
  ZERNIO_MESSAGING_APPROVAL_DECISION_ROUTE,
  ZERNIO_MESSAGING_APPROVAL_REQUEST_ROUTE,
  ZERNIO_MESSAGING_DRAFT_ROUTE,
  ZERNIO_MESSAGING_ROUTE,
  ZERNIO_MESSAGING_SEND_ROUTE,
} from './zernio-messaging-service.js';
import type { ZernioMessagingNotice } from './zernio-messaging-actions.js';
import { escapeHtml } from './ui.js';

function time(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
  }).format(new Date(value));
}

function style(): string {
  return `<style>
.zmsg{max-width:1480px;margin:0 auto;padding:24px}.zmsg *{box-sizing:border-box}.zmsg-head{display:flex;justify-content:space-between;gap:24px;align-items:end;margin-bottom:18px}.zmsg-head h1{margin:4px 0 7px;font-size:clamp(30px,4vw,58px);letter-spacing:-.045em}.zmsg-kicker{color:#10d5d2;font-size:12px;font-weight:900;letter-spacing:.16em;text-transform:uppercase}.zmsg-sub{max-width:780px;color:#9ba5b4}.zmsg-badge{border:1px solid #1d3740;border-radius:999px;padding:9px 13px;color:#8ff6eb;font-size:12px;font-weight:800}.zmsg-tabs{display:flex;gap:8px;margin:0 0 16px}.zmsg-tabs a{border:1px solid #27303d;border-radius:9px;padding:9px 13px;color:#cdd6e4;text-decoration:none}.zmsg-tabs a[aria-current]{border-color:#10d5d2;color:#10d5d2}.zmsg-grid{display:grid;grid-template-columns:minmax(280px,370px) minmax(0,1fr);gap:14px;min-height:620px}.zmsg-panel{background:#0b1017;border:1px solid #222c39;border-radius:16px;overflow:hidden}.zmsg-panel h2{font-size:15px;margin:0;padding:16px;border-bottom:1px solid #222c39}.zmsg-list{list-style:none;margin:0;padding:0}.zmsg-list a{display:block;padding:15px;border-bottom:1px solid #18202b;text-decoration:none;color:#dfe8f3}.zmsg-list a[aria-current]{background:#0d292d}.zmsg-row{display:flex;justify-content:space-between;gap:10px}.zmsg-row strong{overflow-wrap:anywhere}.zmsg-preview{display:block;color:#8793a3;margin-top:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.zmsg-count{background:#10d5d2;color:#031011;border-radius:99px;min-width:22px;height:22px;text-align:center;padding:2px 6px;font-size:12px;font-weight:900}.zmsg-thread{padding:18px}.zmsg-thread-head{padding-bottom:14px;border-bottom:1px solid #222c39}.zmsg-thread-head h2{padding:0;border:0;font-size:24px;margin:0 0 5px}.zmsg-transcript{list-style:none;padding:14px 0;margin:0;display:flex;flex-direction:column;gap:10px}.zmsg-bubble{max-width:78%;padding:11px 13px;border-radius:13px;background:#151e2a;color:#e6edf5;white-space:pre-wrap;overflow-wrap:anywhere}.zmsg-bubble.out{align-self:flex-end;background:#0b4b50}.zmsg-meta{display:block;color:#8b98a8;font-size:11px;margin-top:6px}.zmsg-compose{border-top:1px solid #222c39;padding-top:14px}.zmsg-compose textarea{width:100%;min-height:105px;background:#080c12;color:#e9f2f5;border:1px solid #2c3848;border-radius:10px;padding:12px}.zmsg-compose button,.zmsg-action{margin-top:9px;background:#10d5d2;color:#031011;border:0;border-radius:9px;padding:10px 14px;font-weight:900;cursor:pointer}.zmsg-action.danger{background:#41232a;color:#ffd8df}.zmsg-action.send{background:#70ef8b}.zmsg-note{font-size:12px;color:#8e9baa;margin-top:8px}.zmsg-empty{padding:28px;color:#9da8b6}.zmsg-draft{margin-top:14px;padding:14px;border:1px solid #29404a;border-radius:12px;background:#09181c}.zmsg-draft pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#e9f2f5;font:inherit}.zmsg-actions{display:flex;flex-wrap:wrap;gap:9px}.zmsg-check{display:block;margin-top:12px;color:#d9e4ec}.zmsg-notice{margin:0 0 16px;padding:13px 15px;border-radius:11px;border:1px solid #27515a;background:#0b2428}.zmsg-notice.error{border-color:#713641;background:#29141a}.zmsg-notice h2{border:0;padding:0;margin:0 0 4px}.zmsg-notice p{margin:0;color:#c8d2dc}@media(max-width:820px){.zmsg-grid{grid-template-columns:1fr}.zmsg-head{align-items:start;flex-direction:column}.zmsg-bubble{max-width:92%}}
</style>`;
}

export interface ZernioMessagingViewOptions {
  readonly notice?: ZernioMessagingNotice;
  readonly security?: Readonly<{
    csrfToken: string;
    draftId: string;
    approvalRequestId: string;
    decisionId: string;
    deliveryId: string;
    leaseToken: string;
  }>;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function replyComposer(
  snapshot: Extract<PortalZernioMessagingSnapshot, { ok: true }>,
  options: ZernioMessagingViewOptions,
): string {
  const selected = snapshot.selectedConversation;
  const security = options.security;
  if (!selected || !security) {
    return '<p class="zmsg-note">Reply commands are unavailable. No provider action can run.</p>';
  }
  const target = hidden('account_id', selected.accountId)
    + hidden('conversation_id', selected.providerConversationId)
    + hidden('_csrf', security.csrfToken);
  const reply = snapshot.reply;
  const mayReplace = reply?.approvalDecision === 'rejected' || reply?.deliveryState === 'failed';
  if (!reply || mayReplace) {
    return `<form class="zmsg-compose" method="post" action="${ZERNIO_MESSAGING_DRAFT_ROUTE}">${target}${hidden('draft_id', security.draftId)}<label for="zmsg-reply"><strong>${reply ? 'Replacement reply draft' : 'Reply draft'}</strong></label><textarea id="zmsg-reply" name="body" required maxlength="10000" placeholder="Write the exact Instagram reply..."></textarea><button type="submit">Save immutable draft</button><p class="zmsg-note">Saving does not send. The exact copy and target are sealed before approval.</p></form>`;
  }
  const state = reply.deliveryState ?? reply.approvalDecision
    ?? (reply.approvalRequestId ? 'pending' : 'draft');
  let action = '';
  if (!reply.approvalRequestId) {
    action = `<form method="post" action="${ZERNIO_MESSAGING_APPROVAL_REQUEST_ROUTE}">${target}${hidden('draft_id', reply.draftId)}${hidden('approval_request_id', security.approvalRequestId)}<button class="zmsg-action" type="submit">Request approval</button></form>`;
  } else if (!reply.approvalDecision) {
    action = `<div class="zmsg-actions"><form method="post" action="${ZERNIO_MESSAGING_APPROVAL_DECISION_ROUTE}">${target}${hidden('approval_request_id', reply.approvalRequestId)}${hidden('decision_id', security.decisionId)}${hidden('decision', 'approved')}<label class="zmsg-check"><input type="checkbox" name="confirm_decision" value="yes" required> I approve this exact target and copy</label><button class="zmsg-action" type="submit">Approve exact reply</button></form><form method="post" action="${ZERNIO_MESSAGING_APPROVAL_DECISION_ROUTE}">${target}${hidden('approval_request_id', reply.approvalRequestId)}${hidden('decision_id', security.decisionId)}${hidden('decision', 'rejected')}<label class="zmsg-check"><input type="checkbox" name="confirm_decision" value="yes" required> Reject this exact draft</label><button class="zmsg-action danger" type="submit">Reject</button></form></div>`;
  } else if (reply.approvalDecision === 'approved' && !reply.deliveryState) {
    action = `<form method="post" action="${ZERNIO_MESSAGING_SEND_ROUTE}">${target}${hidden('draft_id', reply.draftId)}${hidden('delivery_id', security.deliveryId)}${hidden('lease_token', security.leaseToken)}<label class="zmsg-check"><input type="checkbox" name="confirm_send" value="yes" required> Send this one approved Instagram reply now</label><button class="zmsg-action send" type="submit">Send approved reply now</button><p class="zmsg-note">This is the only provider-effect action. It has a one-shot lease and cannot blind-retry an uncertain result.</p></form>`;
  }
  return `<section class="zmsg-draft"><strong>Exact sealed reply · ${escapeHtml(state)}</strong><pre>${escapeHtml(reply.body)}</pre>${action}</section>`;
}

export function renderZernioMessagingBody(
  snapshot: PortalZernioMessagingSnapshot,
  options: ZernioMessagingViewOptions = {},
): string {
  if (!snapshot.ok) {
    return `${style()}<section class="zmsg"><nav class="zmsg-tabs"><a href="/portal/inbox">Email &amp; rails</a><a href="${ZERNIO_MESSAGING_ROUTE}" aria-current="page">Social messages</a></nav><div class="zmsg-panel zmsg-empty"><h1>Social messages are temporarily unavailable</h1><p>The signed-in workspace is safe and no provider action ran. Refresh shortly.</p></div></section>`;
  }
  const notice = options.notice
    ? `<section class="zmsg-notice${options.notice.kind === 'error' ? ' error' : ''}" role="${options.notice.kind === 'error' ? 'alert' : 'status'}"><h2>${escapeHtml(options.notice.title)}</h2><p>${escapeHtml(options.notice.message)}</p></section>`
    : '';
  const selected = snapshot.selectedConversation;
  const queue = snapshot.conversations.map((item) => {
    const href = `${ZERNIO_MESSAGING_ROUTE}?conversation=${encodeURIComponent(item.providerConversationId)}`;
    return `<li><a href="${escapeHtml(href)}"${selected?.providerConversationId === item.providerConversationId ? ' aria-current="page"' : ''}><span class="zmsg-row"><strong>${escapeHtml(item.participantName)}</strong>${item.unreadCount > 0 ? `<span class="zmsg-count">${item.unreadCount}</span>` : ''}</span><span class="zmsg-preview">${escapeHtml(item.lastMessage || 'No text preview')}</span><span class="zmsg-meta">Instagram · ${escapeHtml(time(item.updatedAt))}</span></a></li>`;
  }).join('');
  const transcript = snapshot.messages.map((item) => `<li class="zmsg-bubble${item.direction === 'outgoing' ? ' out' : ''}">${escapeHtml(item.body)}<span class="zmsg-meta">${item.direction === 'outgoing' ? 'Property Predator' : escapeHtml(item.senderName)} · ${escapeHtml(time(item.occurredAt))}</span></li>`).join('');
  return `${style()}<section class="zmsg">${notice}<header class="zmsg-head"><div><div class="zmsg-kicker">Growth HQ · Zernio live inbox</div><h1>Social messages</h1><p class="zmsg-sub">Read Instagram conversations without marking them read. Replies use a separate immutable draft and approval boundary before any message can leave Growth HQ.</p></div><span class="zmsg-badge">LIVE READ · APPROVAL-GATED REPLIES</span></header><nav class="zmsg-tabs"><a href="/portal/inbox">Email &amp; rails</a><a href="${ZERNIO_MESSAGING_ROUTE}" aria-current="page">Social messages</a></nav><div class="zmsg-grid"><section class="zmsg-panel"><h2>Instagram queue · ${snapshot.conversations.length}${snapshot.queueTruncated ? '+' : ''}</h2>${queue ? `<ul class="zmsg-list">${queue}</ul>` : '<div class="zmsg-empty">No Instagram conversations are available yet.</div>'}</section><section class="zmsg-panel zmsg-thread">${selected ? `<div class="zmsg-thread-head"><h2>${escapeHtml(selected.participantName)}</h2><div class="zmsg-meta">@${escapeHtml(selected.accountUsername)} · ${selected.unreadCount} unread · checked ${escapeHtml(time(snapshot.checkedAt))}</div></div><ol class="zmsg-transcript">${transcript || '<li class="zmsg-empty">No messages returned for this conversation.</li>'}</ol>${replyComposer(snapshot, options)}<p class="zmsg-note">LinkedIn exposes comments through Zernio, but not personal DMs.</p>` : '<div class="zmsg-empty">Choose a conversation to view its messages.</div>'}</section></div></section>`;
}
