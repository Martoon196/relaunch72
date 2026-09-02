import {
  CREATOR_WATCH_RELEVANCE_ROUTE,
  type CreatorWatchAuthoritativeSnapshot,
  type CreatorWatchCommentPurpose,
  type CreatorWatchNoCommentReason,
  type CreatorWatchQueueRow,
} from './creator-watch-service.js';

export interface CreatorWatchViewSecurity {
  readonly csrfToken: string;
  readonly nextCommandKey: () => string;
}

const COMMENT_CHOICES: readonly Readonly<{
  value: CreatorWatchCommentPurpose;
  label: string;
}>[] = Object.freeze([
  { value: 'add_useful_evidence', label: 'Add useful evidence' },
  { value: 'ask_sharp_question', label: 'Ask a sharp question' },
  { value: 'open_genuine_conversation', label: 'Open a genuine conversation' },
]);

const NO_COMMENT_CHOICE: Readonly<{
  value: CreatorWatchNoCommentReason;
  label: string;
}> = Object.freeze({ value: 'no_useful_contribution', label: 'No useful comment' });

const STYLE = `
.creator-watch{margin-top:24px;border:1px solid rgba(255,255,255,.12);border-radius:22px;background:#090d11;color:#f6f8fa;padding:24px;box-shadow:0 22px 70px rgba(0,0,0,.24)}
.creator-watch *{box-sizing:border-box}.creator-watch header{display:flex;gap:20px;align-items:flex-end;justify-content:space-between}.creator-watch h2{font-size:clamp(25px,3vw,39px);line-height:1;margin:5px 0 0}.creator-watch p{color:#aab5bf;max-width:720px}.creator-watch-badges{display:flex;gap:8px;flex-wrap:wrap}.creator-watch-badge{border:1px solid rgba(0,220,200,.32);border-radius:999px;padding:7px 10px;color:#70eadf;font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase}.creator-watch-grid{display:grid;gap:12px;margin-top:20px}.creator-watch-row{border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:17px;background:#0e141a}.creator-watch-top{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center}.creator-watch-network{display:inline-grid;place-items:center;min-width:36px;height:36px;border-radius:11px;background:#01dac8;color:#001a18;font-weight:950}.creator-watch-row h3{margin:0;font-size:17px}.creator-watch-meta{display:block;color:#8f9ba6;font-size:12px;margin-top:4px}.creator-watch-state{border-radius:999px;padding:7px 9px;background:rgba(255,255,255,.06);font-size:11px;font-weight:850;text-transform:uppercase}.creator-watch-evidence{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:14px}.creator-watch-evidence div{padding:9px 10px;border-radius:10px;background:rgba(255,255,255,.035)}.creator-watch-evidence span{display:block;color:#82909c;font-size:11px}.creator-watch-evidence code{font-size:11px;color:#ced8df;word-break:break-all}.creator-watch-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:13px}.creator-watch-actions form{margin:0}.creator-watch-actions button{border:1px solid rgba(0,220,200,.3);border-radius:10px;background:#101d21;color:#eafdfb;padding:9px 11px;font:inherit;font-size:12px;font-weight:800;cursor:pointer}.creator-watch-actions button:hover,.creator-watch-actions button:focus-visible{outline:2px solid #00d9c6;outline-offset:2px}.creator-watch-actions .skip{border-color:rgba(255,255,255,.16);background:#14181d;color:#cbd2d8}.creator-watch-empty{padding:22px;border:1px dashed rgba(255,255,255,.14);border-radius:14px;color:#93a0aa}.creator-watch-foot{display:flex;justify-content:space-between;gap:15px;margin-top:18px;color:#83909a;font-size:12px}
@media(max-width:760px){.creator-watch{padding:17px}.creator-watch header,.creator-watch-foot{align-items:flex-start;flex-direction:column}.creator-watch-top{grid-template-columns:auto 1fr}.creator-watch-state{grid-column:1/-1;justify-self:start}.creator-watch-evidence{grid-template-columns:1fr}.creator-watch-actions button{min-height:44px}}
@media(prefers-reduced-motion:reduce){.creator-watch *{scroll-behavior:auto!important;transition:none!important}}
`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function label(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function timestamp(value: string): string {
  return new Date(value).toISOString().replace('T', ' ').slice(0, 16);
}

function form(
  row: CreatorWatchQueueRow,
  security: CreatorWatchViewSecurity,
  decision: 'comment' | 'no_comment',
  value: CreatorWatchCommentPurpose | CreatorWatchNoCommentReason,
  buttonLabel: string,
  className = '',
): string {
  const evidence = decision === 'comment'
    ? hidden('comment_purpose', value)
    : hidden('no_comment_reason', value);
  return `<form method="post" action="${CREATOR_WATCH_RELEVANCE_ROUTE}">${hidden('_csrf', security.csrfToken)}${hidden('command_key', security.nextCommandKey())}${hidden('observed_post_id', row.observedPostId)}${hidden('previous_decision_id', row.latestRelevanceDecisionId ?? '')}${hidden('decision', decision)}${evidence}<button${className ? ` class="${className}"` : ''} type="submit">${escapeHtml(buttonLabel)}</button></form>`;
}

function actions(
  row: CreatorWatchQueueRow,
  snapshot: CreatorWatchAuthoritativeSnapshot,
  security?: CreatorWatchViewSecurity,
): string {
  if (!snapshot.commandBoundaryAvailable || !security) {
    return '<p class="creator-watch-meta">Human-review command boundary is not connected. This item is read-only.</p>';
  }
  if (row.reviewState === 'expired') {
    return `<div class="creator-watch-actions" aria-label="Record stale evidence">${form(
      row, security, 'no_comment', 'stale_evidence', 'Mark stale · no comment', 'skip',
    )}</div>`;
  }
  if (row.reviewState === 'frequency_cap_reached') {
    return `<div class="creator-watch-actions" aria-label="Record frequency cap">${form(
      row, security, 'no_comment', 'frequency_cap', 'Frequency cap · no comment', 'skip',
    )}</div>`;
  }
  if (!['awaiting_decision', 'comment_selected_awaiting_assignment'].includes(row.reviewState)) {
    return '';
  }
  const approvedFamilies = snapshot.messageFamilies.filter((family) => (
    family.channel === row.network && family.purpose === 'authority_comment'
  ));
  if (approvedFamilies.length !== 1) {
    const reason = approvedFamilies.length === 0
      ? 'No current approved comment family is available for this network.'
      : 'One-tap assignment is paused because more than one approved comment family is active for this network.';
    return `<p class="creator-watch-meta">${escapeHtml(reason)}</p><div class="creator-watch-actions" aria-label="Record no comment while approved family is unavailable">${form(
      row, security, 'no_comment', 'policy_blocked', 'Approved family unavailable · no comment', 'skip',
    )}</div>`;
  }
  return `<div class="creator-watch-actions" aria-label="One-tap human relevance review">${COMMENT_CHOICES.map((choice) => form(
    row, security, 'comment', choice.value, choice.label,
  )).join('')}${form(
    row, security, 'no_comment', NO_COMMENT_CHOICE.value, NO_COMMENT_CHOICE.label, 'skip',
  )}</div>`;
}

function rowHtml(
  row: CreatorWatchQueueRow,
  snapshot: CreatorWatchAuthoritativeSnapshot,
  security?: CreatorWatchViewSecurity,
): string {
  const decision = row.relevanceDecision
    ? `${label(row.relevanceDecision)}${row.commentPurpose ? ` · ${label(row.commentPurpose)}` : ''}${row.noCommentReason ? ` · ${label(row.noCommentReason)}` : ''}`
    : 'No relevance decision yet';
  return `<article class="creator-watch-row" id="creator-watch-${escapeHtml(row.observedPostId)}"><div class="creator-watch-top"><span class="creator-watch-network" aria-label="${escapeHtml(label(row.network))}">${row.network === 'linkedin' ? 'in' : 'ig'}</span><div><h3>${escapeHtml(label(row.subjectKey))}</h3><span class="creator-watch-meta">${escapeHtml(label(row.sourceKind))} · observed ${escapeHtml(timestamp(row.observedAt))} UTC</span></div><span class="creator-watch-state">${escapeHtml(label(row.reviewState))}</span></div><div class="creator-watch-evidence"><div><span>Human decision</span><code>${escapeHtml(decision)}</code></div><div><span>Frequency</span><code>${row.creatorDayCount}/${row.maxCommentsPerUtcDay} today · ${row.creatorWeekCount}/${row.maxCommentsRolling7Days} rolling 7d</code></div><div><span>Hash-only post evidence</span><code>${escapeHtml(row.postContentSha256.slice(0, 16))}…</code></div></div>${actions(row, snapshot, security)}</article>`;
}

export function renderCreatorWatchFragment(
  snapshot: CreatorWatchAuthoritativeSnapshot,
  security?: CreatorWatchViewSecurity,
): string {
  const commentFamilies = snapshot.messageFamilies.filter((family) => (
    family.purpose === 'authority_comment'
  )).length;
  const awaiting = snapshot.queue.filter((row) => (
    ['awaiting_decision', 'comment_selected_awaiting_assignment'].includes(row.reviewState)
  )).length;
  const assigned = snapshot.queue.filter((row) => (
    row.reviewState === 'comment_assigned_review_only'
  )).length;
  const capped = snapshot.queue.filter((row) => (
    row.reviewState === 'frequency_cap_reached'
  )).length;
  const rows = snapshot.queue.map((row) => rowHtml(row, snapshot, security)).join('');
  return `<style data-property-predator-creator-watch>${STYLE}</style><section class="creator-watch" data-dataset="postgres_authoritative" data-review-mode="one_tap_review" data-provider-effects="off" aria-labelledby="creator-watch-title"><header><div><span class="creator-watch-meta">Property Predator · Creator Watch</span><h2 id="creator-watch-title">Be useful—or don’t comment.</h2><p>Hash-only observations enter a human relevance review. One comment choice atomically records the human decision and pins the exact approved review-only message family. It does not publish, send or create a provider operation.</p></div><div class="creator-watch-badges"><span class="creator-watch-badge">Human approval required</span><span class="creator-watch-badge">${awaiting} awaiting review</span><span class="creator-watch-badge">${assigned} review-only assignments</span><span class="creator-watch-badge">${capped} frequency-capped</span><span class="creator-watch-badge">${commentFamilies} approved review families</span><span class="creator-watch-badge">Autonomous comments OFF</span></div></header><div class="creator-watch-grid">${rows || '<div class="creator-watch-empty">No bounded Creator Watch observations are awaiting review.</div>'}</div><footer class="creator-watch-foot"><span>Post content is not stored here—only exact evidence hashes and decisions.</span><span>Provider effects 0 · external effects OFF · review-only assignments</span></footer></section>`;
}
