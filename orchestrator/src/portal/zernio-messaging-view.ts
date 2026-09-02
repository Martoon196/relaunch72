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
.zmsg-kind{display:inline-block;margin-right:7px;color:#10d5d2;font-size:10px;font-weight:900;letter-spacing:.08em;text-transform:uppercase}.zmsg-comments,.zmsg-replies{list-style:none;margin:0;padding:14px 0;display:flex;flex-direction:column;gap:10px}.zmsg-replies{padding:8px 0 0 24px}.zmsg-comment a{display:block;border:1px solid #253140;border-radius:12px;padding:12px;color:#e6edf5;text-decoration:none;background:#121a24}.zmsg-comment a[aria-current]{border-color:#10d5d2;background:#0b292d}.zmsg-comment.owner a{margin-left:12%;background:#0b4b50}.zmsg-readonly{margin-top:14px;border:1px solid #4b3c25;border-radius:11px;padding:12px;background:#20180d;color:#f2d49b}
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

function targetFields(target: NonNullable<Extract<PortalZernioMessagingSnapshot, { ok: true }>['selectedTarget']>): string {
  if (target.kind === 'dm') {
    return hidden('target_kind', 'dm') + hidden('account_id', target.accountId)
      + hidden('conversation_id', target.providerConversationId);
  }
  return hidden('target_kind', 'comment') + hidden('account_id', target.accountId)
    + hidden('platform', target.platform) + hidden('post_id', target.providerPostId)
    + hidden('comment_id', target.providerCommentId);
}

function replyComposer(
  snapshot: Extract<PortalZernioMessagingSnapshot, { ok: true }>,
  options: ZernioMessagingViewOptions,
): string {
  const selected = snapshot.selectedTarget;
  const security = options.security;
  if (!selected || !security) {
    return '<p class="zmsg-note">Reply commands are unavailable. No provider action can run.</p>';
  }
  if (selected.kind === 'comment' && !snapshot.selectedComment?.canReply) {
    return '<p class="zmsg-readonly">Zernio reports that this comment cannot be replied to. No draft or provider action is available.</p>';
  }
  const target = targetFields(selected) + hidden('_csrf', security.csrfToken);
  const reply = snapshot.reply;
  const mayReplace = reply?.approvalDecision === 'rejected' || reply?.deliveryState === 'failed';
  if (!reply || mayReplace) {
    return `<form class="zmsg-compose" method="post" action="${ZERNIO_MESSAGING_DRAFT_ROUTE}">${target}${hidden('draft_id', security.draftId)}<label for="zmsg-reply"><strong>${reply ? 'Replacement reply draft' : 'Reply draft'}</strong></label><textarea id="zmsg-reply" name="body" required maxlength="10000" placeholder="Write the exact ${selected.kind === 'comment' ? 'public comment' : 'Instagram DM'} reply..."></textarea><button type="submit">Save immutable draft</button><p class="zmsg-note">Saving does not send. The exact copy and target are sealed before approval.</p></form>`;
  }
  const state = reply.deliveryState ?? reply.approvalDecision
    ?? (reply.approvalRequestId ? 'pending' : 'draft');
  let action = '';
  if (!reply.approvalRequestId) {
    action = `<form method="post" action="${ZERNIO_MESSAGING_APPROVAL_REQUEST_ROUTE}">${target}${hidden('draft_id', reply.draftId)}${hidden('approval_request_id', security.approvalRequestId)}<button class="zmsg-action" type="submit">Request approval</button></form>`;
  } else if (!reply.approvalDecision) {
    action = `<div class="zmsg-actions"><form method="post" action="${ZERNIO_MESSAGING_APPROVAL_DECISION_ROUTE}">${target}${hidden('approval_request_id', reply.approvalRequestId)}${hidden('decision_id', security.decisionId)}${hidden('decision', 'approved')}<label class="zmsg-check"><input type="checkbox" name="confirm_decision" value="yes" required> I approve this exact target and copy</label><button class="zmsg-action" type="submit">Approve exact reply</button></form><form method="post" action="${ZERNIO_MESSAGING_APPROVAL_DECISION_ROUTE}">${target}${hidden('approval_request_id', reply.approvalRequestId)}${hidden('decision_id', security.decisionId)}${hidden('decision', 'rejected')}<label class="zmsg-check"><input type="checkbox" name="confirm_decision" value="yes" required> Reject this exact draft</label><button class="zmsg-action danger" type="submit">Reject</button></form></div>`;
  } else if (reply.approvalDecision === 'approved' && !reply.deliveryState) {
    action = !snapshot.outboundEffectsEnabled
      ? '<p class="zmsg-readonly">This exact reply is approved, but the provider-effects switch is OFF. It cannot leave Growth HQ.</p>'
      : snapshot.emergencyPaused
        ? '<p class="zmsg-readonly">This exact reply is approved, but the social emergency pause is engaged. It cannot leave Growth HQ.</p>'
        : `<form method="post" action="${ZERNIO_MESSAGING_SEND_ROUTE}">${target}${hidden('draft_id', reply.draftId)}${hidden('delivery_id', security.deliveryId)}${hidden('lease_token', security.leaseToken)}<label class="zmsg-check"><input type="checkbox" name="confirm_send" value="yes" required> Send this one approved ${selected.kind === 'comment' ? 'public comment' : 'Instagram DM'} reply now</label><button class="zmsg-action send" type="submit">Send approved reply now</button><p class="zmsg-note">This is the only provider-effect action. It has a one-shot lease and cannot blind-retry an uncertain result.</p></form>`;
  }
  return `<section class="zmsg-draft"><strong>Exact sealed reply · ${escapeHtml(state)}</strong><pre>${escapeHtml(reply.body)}</pre>${action}</section>`;
}

type ReadySnapshot = Extract<PortalZernioMessagingSnapshot, { ok: true }>;

function commentHref(
  post: ReadySnapshot['commentPosts'][number],
  providerCommentId?: string,
): string {
  const query = new URLSearchParams({
    kind: 'comment', account: post.accountId, platform: post.platform,
    post: post.providerPostId,
  });
  if (providerCommentId) query.set('comment', providerCommentId);
  return `${ZERNIO_MESSAGING_ROUTE}?${query.toString()}`;
}

function renderCommentThread(
  snapshot: ReadySnapshot,
  comments: ReadySnapshot['comments'],
): string {
  const post = snapshot.selectedCommentPost;
  if (!post) return '';
  return comments.map((item) => {
    const href = commentHref(post, item.providerCommentId);
    const selected = snapshot.selectedComment?.providerCommentId === item.providerCommentId;
    const replies = item.replies.length > 0
      ? `<ol class="zmsg-replies">${renderCommentThread(snapshot, item.replies)}</ol>` : '';
    return `<li class="zmsg-comment${item.author.isOwner ? ' owner' : ''}"><a href="${escapeHtml(href)}"${selected ? ' aria-current="page"' : ''}><span>${escapeHtml(item.body || '[Media comment]')}</span><span class="zmsg-meta">${item.author.isOwner ? 'Property Predator' : escapeHtml(item.author.name)} · ${escapeHtml(time(item.createdAt))} · ${item.replyCount} ${item.replyCount === 1 ? 'reply' : 'replies'}${item.canReply ? ' · choose to reply' : ''}</span></a>${replies}</li>`;
  }).join('');
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
  const selectedConversation = snapshot.selectedConversation;
  const selectedPost = snapshot.selectedCommentPost;
  const dmQueue = snapshot.conversations.map((item) => {
    const href = `${ZERNIO_MESSAGING_ROUTE}?conversation=${encodeURIComponent(item.providerConversationId)}`;
    return `<li><a href="${escapeHtml(href)}"${selectedConversation?.providerConversationId === item.providerConversationId ? ' aria-current="page"' : ''}><span class="zmsg-row"><strong><span class="zmsg-kind">DM</span>${escapeHtml(item.participantName)}</strong>${item.unreadCount > 0 ? `<span class="zmsg-count">${item.unreadCount}</span>` : ''}</span><span class="zmsg-preview">${escapeHtml(item.lastMessage || 'No text preview')}</span><span class="zmsg-meta">Instagram · ${escapeHtml(time(item.updatedAt))}</span></a></li>`;
  }).join('');
  const commentQueue = snapshot.commentPosts.map((item) => {
    const href = commentHref(item);
    const current = selectedPost?.accountId === item.accountId
      && selectedPost.platform === item.platform
      && selectedPost.providerPostId === item.providerPostId;
    return `<li><a href="${escapeHtml(href)}"${current ? ' aria-current="page"' : ''}><span class="zmsg-row"><strong><span class="zmsg-kind">Comment</span>${escapeHtml(item.accountUsername || 'Property Predator')}</strong><span class="zmsg-count">${item.commentCount}</span></span><span class="zmsg-preview">${escapeHtml(item.content || 'Media post')}</span><span class="zmsg-meta">${item.platform === 'linkedin' ? 'LinkedIn' : 'Instagram'} · ${escapeHtml(time(item.createdAt))}</span></a></li>`;
  }).join('');
  const queue = dmQueue + commentQueue;
  const dmTranscript = snapshot.messages.map((item) => `<li class="zmsg-bubble${item.direction === 'outgoing' ? ' out' : ''}">${escapeHtml(item.body)}<span class="zmsg-meta">${item.direction === 'outgoing' ? 'Property Predator' : escapeHtml(item.senderName)} · ${escapeHtml(time(item.occurredAt))}</span></li>`).join('');
  const commentTranscript = renderCommentThread(snapshot, snapshot.comments);
  const thread = selectedConversation
    ? `<div class="zmsg-thread-head"><h2>${escapeHtml(selectedConversation.participantName)}</h2><div class="zmsg-meta">Instagram DM · @${escapeHtml(selectedConversation.accountUsername)} · ${selectedConversation.unreadCount} unread · checked ${escapeHtml(time(snapshot.checkedAt))}</div></div><ol class="zmsg-transcript">${dmTranscript || '<li class="zmsg-empty">No messages returned for this conversation.</li>'}</ol>${replyComposer(snapshot, options)}`
    : selectedPost
      ? `<div class="zmsg-thread-head"><h2>${selectedPost.platform === 'linkedin' ? 'LinkedIn' : 'Instagram'} comments</h2><div class="zmsg-meta">@${escapeHtml(selectedPost.accountUsername)} · ${selectedPost.commentCount} comments · checked ${escapeHtml(time(snapshot.checkedAt))}</div><p>${escapeHtml(selectedPost.content || 'Media post')}</p></div><ol class="zmsg-comments">${commentTranscript || '<li class="zmsg-empty">No comments returned for this post.</li>'}</ol>${snapshot.selectedComment ? replyComposer(snapshot, options) : '<p class="zmsg-note">Choose a comment before drafting a reply.</p>'}`
      : '<div class="zmsg-empty">Choose a DM or commented post to view its thread.</div>';
  const outboundStatus = !snapshot.outboundEffectsEnabled
    ? 'OUTBOUND EFFECTS OFF' : snapshot.emergencyPaused ? 'EMERGENCY PAUSED' : 'APPROVAL-GATED SEND';
  return `${style()}<section class="zmsg">${notice}<header class="zmsg-head"><div><div class="zmsg-kicker">Growth HQ · Zernio live inbox</div><h1>Social messages &amp; comments</h1><p class="zmsg-sub">Read Instagram DMs and Instagram or LinkedIn comment threads in one queue. Every available reply uses an immutable draft and approval boundary before any provider action.</p></div><span class="zmsg-badge">LIVE READ · ${outboundStatus}</span></header><nav class="zmsg-tabs"><a href="/portal/inbox">Email &amp; rails</a><a href="${ZERNIO_MESSAGING_ROUTE}" aria-current="page">Social messages</a></nav><div class="zmsg-grid"><section class="zmsg-panel"><h2>DMs &amp; comments · ${snapshot.conversations.length + snapshot.commentPosts.length}${snapshot.queueTruncated ? '+' : ''}</h2>${queue ? `<ul class="zmsg-list">${queue}</ul>` : '<div class="zmsg-empty">No social conversations or commented posts are available yet.</div>'}</section><section class="zmsg-panel zmsg-thread">${thread}</section></div></section>`;
}
