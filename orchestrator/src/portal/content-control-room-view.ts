/**
 * Pure server-rendered Content Control Room.
 *
 * This view is deliberately operational but side-effect free. It exposes the
 * exact version, approval and source-freshness gates that a future delivery
 * rail may consume; it never claims that content was scheduled or published.
 */

import { escapeHtml } from './ui.js';
import {
  CONTENT_APPROVAL_DECISION_ROUTE,
  CONTENT_APPROVAL_REQUEST_ROUTE,
  type ContentControlNoticeView,
} from './content-control-room-actions.js';
import {
  CONTENT_CONTROL_ROOM_MAX_QUERY_LENGTH,
  CONTENT_CONTROL_ROOM_ROUTE,
  type ContentApprovalTone,
  type ContentControlRoomChannel,
  type ContentControlRoomFormat,
  type ContentControlRoomItemView,
  type ContentControlRoomView,
} from './content-control-room-presenter.js';
import { renderContentWorkspaceNavigation } from './content-workspace-navigation.js';

export interface ContentControlRoomActionSecurity {
  readonly csrfToken: string;
  /** Exact content-version id to server-created command key. */
  readonly requestApprovalKeys: Readonly<Record<string, string>>;
  /** Exact approval-request id to server-created decision command key. */
  readonly decisionKeys: Readonly<Record<string, string>>;
}

export interface RenderContentControlRoomOptions {
  readonly security?: ContentControlRoomActionSecurity;
  readonly companyAssetsAvailable?: boolean;
  readonly companyAssetsLabel?: string;
  readonly brandBrainAvailable?: boolean;
  readonly brandBrainLabel?: string;
}

const CHANNEL_OPTIONS: readonly Readonly<{ value: ContentControlRoomChannel; label: string }>[] = Object.freeze([
  { value: 'all', label: 'All channels' },
  { value: 'social', label: 'Social' },
  { value: 'email', label: 'Email' },
  { value: 'webinar', label: 'Webinar' },
  { value: 'library', label: 'Owned library' },
]);

const FORMAT_OPTIONS: readonly Readonly<{ value: ContentControlRoomFormat; label: string }>[] = Object.freeze([
  { value: 'all', label: 'All formats' },
  { value: 'social_post', label: 'Social post' },
  { value: 'email', label: 'Email' },
  { value: 'article', label: 'Article' },
  { value: 'document', label: 'Document' },
  { value: 'image', label: 'Image' },
  { value: 'video', label: 'Video' },
  { value: 'webinar', label: 'Webinar' },
  { value: 'other', label: 'Other' },
]);

const CONTENT_CONTROL_ROOM_STYLE = `
  .ccr{--ccr-bg:#07090b;--ccr-panel:#0d1013;--ccr-raised:#12171b;--ccr-soft:#0a0d0f;--ccr-line:#253038;--ccr-line-strong:#36444e;--ccr-ink:#f1f5f4;--ccr-muted:#a5b1b4;--ccr-faint:#7f8d92;--ccr-teal:#00e5cc;--ccr-teal-soft:#082923;--ccr-amber:#f2b84b;--ccr-red:#ff7169;--ccr-green:#73d7a2;min-width:0;color:var(--ccr-ink);font-family:var(--sans,ui-sans-serif,system-ui,sans-serif);background:var(--ccr-bg);border:1px solid #020304;overflow:hidden}
  .ccr *{box-sizing:border-box}.ccr h1,.ccr h2,.ccr h3,.ccr p{margin-top:0}.ccr a{text-decoration:none}.ccr button,.ccr input,.ccr select{font:inherit}.ccr code{font-family:var(--mono,monospace);overflow-wrap:anywhere}.ccr-visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
  .ccr-hero{position:relative;display:grid;grid-template-columns:minmax(0,1fr) minmax(240px,310px);gap:24px;align-items:end;padding:28px 30px 24px;border-bottom:1px solid var(--ccr-line);background:radial-gradient(circle at 86% 6%,rgba(0,229,204,.12),transparent 31%),linear-gradient(135deg,#111619,#080a0c 68%);overflow:hidden}.ccr-hero::after{content:"";position:absolute;right:22%;top:-75px;width:190px;height:190px;border:1px solid rgba(0,229,204,.11);transform:rotate(45deg);pointer-events:none}.ccr-kicker{position:relative;color:var(--ccr-teal);font:850 12px/1.2 var(--mono,monospace);letter-spacing:.13em;text-transform:uppercase}.ccr-hero h1{position:relative;margin:9px 0 9px;font-family:var(--display,var(--sans));font-size:clamp(2.15rem,4.4vw,4.35rem);font-weight:600;line-height:.93;letter-spacing:-.04em}.ccr-hero h1 em{color:var(--ccr-teal);font-style:normal}.ccr-hero-copy>p{position:relative;max-width:800px;margin:0;color:var(--ccr-muted);font-size:14px;line-height:1.65}.ccr-snapshot{position:relative;border:1px solid var(--ccr-line-strong);background:rgba(5,7,8,.74);padding:14px 15px}.ccr-snapshot>span{display:block;color:var(--ccr-faint);font:750 12px var(--mono,monospace);letter-spacing:.07em;text-transform:uppercase}.ccr-snapshot strong{display:block;margin:7px 0 5px;font-size:15px}.ccr-snapshot small{display:block;color:var(--ccr-muted);font-size:12px;line-height:1.45}
  .ccr-truth{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:13px;align-items:center;padding:12px 30px;border-bottom:1px solid var(--ccr-line);background:#0a0d0f}.ccr-truth-mark{color:var(--ccr-teal);font:850 12px var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase}.ccr-truth p{margin:0;color:var(--ccr-muted);font-size:12px;line-height:1.5}.ccr-truth p strong{color:var(--ccr-ink)}.ccr-readonly{border:1px solid var(--ccr-line-strong);padding:4px 8px;color:var(--ccr-faint);font:800 12px var(--mono,monospace);letter-spacing:.05em;text-transform:uppercase;white-space:nowrap}
  .ccr-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-bottom:1px solid var(--ccr-line);background:var(--ccr-panel)}.ccr-metric{min-width:0;padding:16px 19px;border-right:1px solid var(--ccr-line)}.ccr-metric:last-child{border-right:0}.ccr-metric small{display:block;color:var(--ccr-faint);font:800 12px var(--mono,monospace);letter-spacing:.07em;text-transform:uppercase}.ccr-metric strong{display:block;margin:7px 0 4px;font:900 24px/1 var(--mono,monospace)}.ccr-metric span{display:block;color:var(--ccr-muted);font-size:12px;line-height:1.4}.ccr-metric.attention strong{color:var(--ccr-amber)}.ccr-metric.eligible strong{color:var(--ccr-teal)}
  .ccr-filterbar{display:grid;grid-template-columns:minmax(220px,1fr) minmax(150px,210px) minmax(150px,210px) auto auto;gap:9px;align-items:end;padding:16px 30px;border-bottom:1px solid var(--ccr-line);background:#0b0e11}.ccr-field{display:grid;gap:5px;min-width:0}.ccr-field label{color:var(--ccr-faint);font:750 12px var(--mono,monospace);letter-spacing:.06em;text-transform:uppercase}.ccr-field input,.ccr-field select{width:100%;height:44px;min-width:0;border:1px solid var(--ccr-line-strong);border-radius:7px;background:var(--ccr-raised);color:var(--ccr-ink);padding:0 12px;font-size:13px}.ccr-field input::placeholder{color:var(--ccr-faint)}.ccr-field input:focus,.ccr-field select:focus{border-color:var(--ccr-teal);box-shadow:0 0 0 3px rgba(0,229,204,.13);outline:0}.ccr-filter-button,.ccr-clear{min-height:44px;border:1px solid var(--ccr-line-strong);border-radius:7px;padding:0 15px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;white-space:nowrap}.ccr-filter-button{background:var(--ccr-teal);border-color:var(--ccr-teal);color:#03110f;cursor:pointer}.ccr-clear{background:var(--ccr-raised);color:var(--ccr-ink)}
  .ccr-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,355px);gap:14px;align-items:start;padding:16px;background:var(--ccr-bg)}.ccr-catalog,.ccr-review{min-width:0;border:1px solid var(--ccr-line);background:var(--ccr-panel)}.ccr-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:17px 18px 14px;border-bottom:1px solid var(--ccr-line)}.ccr-section-head h2{margin:0;font-size:16px;letter-spacing:-.01em}.ccr-section-head p{margin:4px 0 0;color:var(--ccr-muted);font-size:12px;line-height:1.45}.ccr-result-count{border:1px solid var(--ccr-line-strong);padding:4px 8px;color:var(--ccr-muted);font:800 12px var(--mono,monospace);white-space:nowrap}
  .ccr-items{list-style:none;display:grid;gap:9px;margin:0;padding:10px}.ccr-card{scroll-margin-top:84px;border:1px solid var(--ccr-line);border-left:3px solid var(--ccr-teal);border-radius:8px;background:var(--ccr-raised);overflow:hidden}.ccr-card.locked{border-left-color:var(--ccr-amber)}.ccr-card-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;padding:14px 14px 12px;border-bottom:1px solid var(--ccr-line)}.ccr-card-identity{min-width:0}.ccr-card-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:7px}.ccr-chip{display:inline-flex;align-items:center;min-height:24px;border:1px solid var(--ccr-line-strong);border-radius:999px;padding:3px 8px;color:var(--ccr-muted);font:800 12px var(--mono,monospace);letter-spacing:.03em;text-transform:uppercase}.ccr-chip.version{border-color:#2a7b70;background:var(--ccr-teal-soft);color:var(--ccr-teal)}.ccr-card h3{margin:0;font-size:16px;line-height:1.35;letter-spacing:-.01em}.ccr-source-line{display:flex;gap:6px;flex-wrap:wrap;margin:7px 0 0;color:var(--ccr-muted);font-size:12px}.ccr-source-line code{color:var(--ccr-ink)}.ccr-publish-state{align-self:start;min-width:92px;border:1px solid var(--ccr-line-strong);padding:8px 9px;text-align:center}.ccr-publish-state span{display:block;color:var(--ccr-faint);font:750 12px var(--mono,monospace);text-transform:uppercase}.ccr-publish-state strong{display:block;margin-top:4px;font:900 13px var(--mono,monospace);text-transform:uppercase}.ccr-publish-state.eligible{border-color:#2a7b70;background:var(--ccr-teal-soft);color:var(--ccr-teal)}.ccr-publish-state.locked{border-color:#66552e;background:#171308;color:var(--ccr-amber)}
  .ccr-gates{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-bottom:1px solid var(--ccr-line)}.ccr-gate{min-width:0;padding:12px 13px;border-right:1px solid var(--ccr-line)}.ccr-gate:last-child{border-right:0}.ccr-gate-label{display:block;color:var(--ccr-faint);font:750 12px var(--mono,monospace);letter-spacing:.06em;text-transform:uppercase}.ccr-gate-state{display:inline-flex;align-items:center;gap:6px;margin-top:7px;font-size:12px;font-weight:850}.ccr-gate-state::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--ccr-faint)}.ccr-gate-state.approved,.ccr-gate-state.fresh,.ccr-gate-state.eligible{color:var(--ccr-teal)}.ccr-gate-state.approved::before,.ccr-gate-state.fresh::before,.ccr-gate-state.eligible::before{background:var(--ccr-teal)}.ccr-gate-state.pending{color:#8db7ff}.ccr-gate-state.pending::before{background:#8db7ff}.ccr-gate-state.warning,.ccr-gate-state.locked{color:var(--ccr-amber)}.ccr-gate-state.warning::before,.ccr-gate-state.locked::before{background:var(--ccr-amber)}.ccr-gate-state.rejected{color:var(--ccr-red)}.ccr-gate-state.rejected::before{background:var(--ccr-red)}.ccr-gate p{margin:6px 0 0;color:var(--ccr-muted);font-size:12px;line-height:1.5}.ccr-stale-flag{display:inline-flex;margin-top:7px;border:1px solid #66552e;padding:3px 6px;color:var(--ccr-amber);font:800 12px var(--mono,monospace);text-transform:uppercase}
  .ccr-notice{margin:14px 16px 0;border:1px solid var(--ccr-line-strong);border-left:4px solid var(--ccr-teal);background:#0b1514;padding:12px 14px}.ccr-notice[data-kind="info"]{border-left-color:var(--ccr-amber);background:#171308}.ccr-notice[data-kind="error"]{border-left-color:var(--ccr-red);background:#190d0d}.ccr-notice strong{display:block;font-size:13px}.ccr-notice p{margin:4px 0 0;color:var(--ccr-muted);font-size:12px;line-height:1.5}.ccr-actions{border-bottom:1px solid var(--ccr-line);background:#0a0e10;padding:12px 13px}.ccr-action-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.ccr-action-head strong{font-size:12px}.ccr-action-head span{color:var(--ccr-faint);font:750 11px var(--mono,monospace);text-transform:uppercase}.ccr-action-form{display:grid;grid-template-columns:minmax(160px,1fr) auto;gap:8px;align-items:end;margin-top:9px}.ccr-action-form label{display:grid;gap:5px;color:var(--ccr-faint);font:750 11px var(--mono,monospace);letter-spacing:.04em;text-transform:uppercase}.ccr-action-form textarea{width:100%;min-height:54px;resize:vertical;border:1px solid var(--ccr-line-strong);border-radius:7px;background:var(--ccr-raised);color:var(--ccr-ink);padding:9px 10px;font:500 12px/1.45 var(--sans,system-ui,sans-serif)}.ccr-action-form textarea:focus{border-color:var(--ccr-teal);box-shadow:0 0 0 3px rgba(0,229,204,.13);outline:0}.ccr-action-buttons{display:flex;gap:7px;flex-wrap:wrap}.ccr-action-button{min-height:44px;border:1px solid var(--ccr-line-strong);border-radius:7px;background:var(--ccr-raised);color:var(--ccr-ink);padding:0 12px;font-size:11px;font-weight:900;cursor:pointer}.ccr-action-button.primary{border-color:var(--ccr-teal);background:var(--ccr-teal);color:#03110f}.ccr-action-button.warn{border-color:#806834;color:var(--ccr-amber)}.ccr-action-button.danger{border-color:#78413d;color:var(--ccr-red)}.ccr-action-lock{margin:8px 0 0;color:var(--ccr-faint);font-size:11px;line-height:1.45}
  .ccr-card-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 13px}.ccr-card-foot>span{color:var(--ccr-faint);font-size:12px}.ccr-proof{position:relative}.ccr-proof summary{min-height:44px;display:flex;align-items:center;justify-content:flex-end;gap:6px;list-style:none;color:var(--ccr-teal);font:800 12px var(--mono,monospace);cursor:pointer;text-transform:uppercase}.ccr-proof summary::-webkit-details-marker{display:none}.ccr-proof summary::after{content:"+";font-size:16px}.ccr-proof[open] summary::after{content:"−"}.ccr-proof-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;padding:0 13px 13px}.ccr-proof-block{min-width:0;border:1px solid var(--ccr-line);background:var(--ccr-soft);padding:10px}.ccr-proof-block.wide{grid-column:1/-1}.ccr-proof-block strong{display:block;margin-bottom:6px;color:var(--ccr-faint);font:800 12px var(--mono,monospace);letter-spacing:.05em;text-transform:uppercase}.ccr-proof-row{display:grid;grid-template-columns:92px minmax(0,1fr);gap:8px;padding:4px 0;font-size:12px}.ccr-proof-row span{color:var(--ccr-faint)}.ccr-proof-row code,.ccr-proof-row time{color:var(--ccr-ink);overflow-wrap:anywhere}
  .ccr-review{position:sticky;top:86px}.ccr-review-list{list-style:none;margin:0;padding:8px 14px}.ccr-review-item{border-bottom:1px solid var(--ccr-line)}.ccr-review-item:last-child{border-bottom:0}.ccr-review-link{min-height:70px;display:grid;grid-template-columns:32px minmax(0,1fr) auto;gap:9px;align-items:center;padding:10px 0}.ccr-review-index{width:29px;height:29px;border:1px solid var(--ccr-line-strong);display:grid;place-items:center;color:var(--ccr-teal);font:900 12px var(--mono,monospace)}.ccr-review-copy{min-width:0}.ccr-review-copy strong{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ccr-review-copy span{display:block;margin-top:3px;color:var(--ccr-amber);font-size:12px}.ccr-review-version{color:var(--ccr-faint);font:800 12px var(--mono,monospace)}.ccr-review-note{margin:0;padding:12px 14px;border-top:1px solid var(--ccr-line);color:var(--ccr-muted);font-size:12px;line-height:1.5;background:var(--ccr-soft)}
  .ccr-empty{margin:10px;border:1px dashed var(--ccr-line-strong);padding:30px 22px;text-align:center;background:var(--ccr-soft)}.ccr-empty-mark{width:42px;height:42px;margin:0 auto 11px;border:1px solid var(--ccr-line-strong);display:grid;place-items:center;color:var(--ccr-teal);font:900 16px var(--mono,monospace)}.ccr-empty strong{display:block;font-size:14px}.ccr-empty p{max-width:520px;margin:6px auto 0;color:var(--ccr-muted);font-size:12px;line-height:1.55}.ccr-empty a{display:inline-flex;min-height:44px;align-items:center;margin-top:10px;color:var(--ccr-teal);font-size:12px;font-weight:850}.ccr-page-note{display:flex;justify-content:space-between;gap:12px;padding:11px 18px;border-top:1px solid var(--ccr-line);color:var(--ccr-faint);font-size:12px}.ccr-footer{display:flex;justify-content:space-between;gap:14px;padding:13px 18px;border-top:1px solid var(--ccr-line);background:#080a0c;color:var(--ccr-faint);font-size:12px}.ccr-footer strong{color:var(--ccr-muted)}
  @media(max-width:1080px){.ccr-filterbar{grid-template-columns:minmax(220px,1fr) repeat(2,minmax(150px,190px));}.ccr-filter-button,.ccr-clear{grid-row:2}.ccr-layout{grid-template-columns:minmax(0,1fr) 310px}.ccr-gates{grid-template-columns:1fr}.ccr-gate{border-right:0;border-bottom:1px solid var(--ccr-line)}.ccr-gate:last-child{border-bottom:0}}
  @media(max-width:820px){.ccr-hero{grid-template-columns:1fr;padding:23px 20px 20px}.ccr-truth{grid-template-columns:1fr;padding:12px 20px}.ccr-readonly{justify-self:start}.ccr-metrics{grid-template-columns:repeat(2,1fr)}.ccr-metric:nth-child(2){border-right:0}.ccr-metric:nth-child(n+3){border-top:1px solid var(--ccr-line)}.ccr-filterbar{grid-template-columns:repeat(2,minmax(0,1fr));padding:14px 20px}.ccr-field.search{grid-column:1/-1}.ccr-layout{grid-template-columns:1fr;padding:10px}.ccr-review{position:static;grid-row:1}.ccr-proof-grid{grid-template-columns:1fr}.ccr-proof-block.wide{grid-column:auto}}
  @media(max-width:520px){.ccr-hero h1{font-size:2.3rem}.ccr-metrics{grid-template-columns:1fr}.ccr-metric,.ccr-metric:nth-child(2){border-right:0}.ccr-metric:nth-child(n+2){border-top:1px solid var(--ccr-line)}.ccr-filterbar{grid-template-columns:1fr}.ccr-field.search{grid-column:auto}.ccr-filter-button,.ccr-clear{grid-row:auto;width:100%}.ccr-section-head,.ccr-card-head,.ccr-page-note,.ccr-footer{align-items:stretch;flex-direction:column}.ccr-card-head{grid-template-columns:1fr}.ccr-publish-state{width:100%;text-align:left}.ccr-card-foot{align-items:flex-start;flex-direction:column}.ccr-proof{width:100%}.ccr-proof summary{justify-content:flex-start}.ccr-proof-row{grid-template-columns:1fr}.ccr-proof-row span{margin-bottom:-2px}.ccr-action-form{grid-template-columns:1fr}.ccr-action-buttons{display:grid;grid-template-columns:1fr}.ccr-action-button{width:100%}}
  @media(forced-colors:active){.ccr,.ccr-card,.ccr-catalog,.ccr-review,.ccr-snapshot,.ccr-chip,.ccr-publish-state,.ccr-gate-state::before{forced-color-adjust:auto}.ccr-card{border-left-width:5px}.ccr-filter-button{border:2px solid ButtonText}}
  @media(prefers-reduced-motion:reduce){.ccr *{scroll-behavior:auto!important;transition:none!important}}
`;

function safeCount(value: number): string {
  return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-GB') : '0';
}

function option(value: string, label: string, selectedValue: string): string {
  return `<option value="${escapeHtml(value)}"${value === selectedValue ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

function time(value: string | null, fallback = 'Not recorded'): string {
  if (!value) return escapeHtml(fallback);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return escapeHtml(fallback);
  const label = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date);
  return `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(label)} UTC</time>`;
}

function approvalTone(value: ContentApprovalTone): string {
  return ['approved', 'pending', 'warning', 'rejected', 'neutral'].includes(value)
    ? value
    : 'neutral';
}

function validSecurityToken(value: string | undefined): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 512;
}

function validCommandKey(value: string | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value);
}

function returnFilterFields(view: ContentControlRoomView, item: ContentControlRoomItemView): string {
  return `<input type="hidden" name="return_q" value="${escapeHtml(view.filters.query)}"><input type="hidden" name="return_channel" value="${escapeHtml(view.filters.channel)}"><input type="hidden" name="return_format" value="${escapeHtml(view.filters.format)}"><input type="hidden" name="return_anchor" value="${escapeHtml(item.anchorId)}">`;
}

function contentActions(
  view: ContentControlRoomView,
  item: ContentControlRoomItemView,
  security: ContentControlRoomActionSecurity | undefined,
): string {
  const csrfToken = security?.csrfToken;
  if (!view.canWrite || !validSecurityToken(csrfToken)) {
    return '<section class="ccr-actions" aria-label="Content review controls"><div class="ccr-action-head"><strong>Review controls</strong><span>Read only</span></div><p class="ccr-action-lock">Your current workspace role can inspect immutable evidence but cannot change approval state.</p></section>';
  }

  if (item.approvalStatus === 'pending' && item.approvalRequestId) {
    const commandKey = security?.decisionKeys[item.approvalRequestId];
    if (!view.canManage || !validCommandKey(commandKey)) {
      return '<section class="ccr-actions" aria-label="Content review controls"><div class="ccr-action-head"><strong>Review decision required</strong><span>Manager gate</span></div><p class="ccr-action-lock">Approval is unavailable because the exact text or artwork cannot be inspected here. An owner or admin may still reject it or request changes.</p></section>';
    }
    return `<section class="ccr-actions" aria-label="Content review controls"><div class="ccr-action-head"><strong>Approval locked · exact review content unavailable</strong><span>Fail closed</span></div><form class="ccr-action-form" method="post" action="${CONTENT_APPROVAL_DECISION_ROUTE}"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="command_key" value="${escapeHtml(commandKey)}"><input type="hidden" name="approval_request_id" value="${escapeHtml(item.approvalRequestId)}">${returnFilterFields(view, item)}<label>Decision note<textarea name="decision_note" maxlength="4000" required placeholder="Explain the required change or rejection"></textarea></label><div class="ccr-action-buttons"><button class="ccr-action-button warn" type="submit" name="decision" value="changes_requested">Request changes</button><button class="ccr-action-button danger" type="submit" name="decision" value="rejected">Reject</button></div></form><p class="ccr-action-lock">Only metadata and hashes are visible. The server will reject any forged approval until the exact hash-bound content can be inspected.</p></section>`;
  }

  if (['unrequested', 'rejected', 'changes_requested', 'stale'].includes(item.approvalStatus)) {
    const commandKey = security?.requestApprovalKeys[item.contentVersionId];
    if (!validCommandKey(commandKey)) {
      return '<section class="ccr-actions" aria-label="Content review controls"><div class="ccr-action-head"><strong>Review action unavailable</strong><span>Fail closed</span></div><p class="ccr-action-lock">Refresh the page to obtain a protected command. Nothing changed.</p></section>';
    }
    return `<section class="ccr-actions" aria-label="Content review controls"><div class="ccr-action-head"><strong>Submit this exact version for review</strong><span>Version locked</span></div><form class="ccr-action-form" method="post" action="${CONTENT_APPROVAL_REQUEST_ROUTE}"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="command_key" value="${escapeHtml(commandKey)}"><input type="hidden" name="content_item_id" value="${escapeHtml(item.contentItemId)}"><input type="hidden" name="content_version_id" value="${escapeHtml(item.contentVersionId)}">${returnFilterFields(view, item)}<label>Review brief<textarea name="review_note" maxlength="4000" placeholder="What should the reviewer verify?"></textarea></label><div class="ccr-action-buttons"><button class="ccr-action-button primary" type="submit">Request human approval</button></div></form><p class="ccr-action-lock">The request is pinned to v${safeCount(item.versionNumber)} and its SHA-256 content digest.</p></section>`;
  }

  return `<section class="ccr-actions" aria-label="Content review controls"><div class="ccr-action-head"><strong>${item.publishable ? 'Review complete' : 'Approval recorded'}</strong><span>${item.publishable ? 'Outbound eligible' : 'Review gate locked'}</span></div><p class="ccr-action-lock">${escapeHtml(item.publishableDetail)}</p></section>`;
}

function notice(view: ContentControlNoticeView | undefined): string {
  if (!view) return '';
  return `<section class="ccr-notice" data-kind="${escapeHtml(view.kind)}" role="status"><strong>${escapeHtml(view.title)}</strong><p>${escapeHtml(view.message)}</p></section>`;
}

function fullProof(item: ContentControlRoomItemView): string {
  return `<details class="ccr-proof"><summary>Integrity proof</summary><div class="ccr-proof-grid">
    <div class="ccr-proof-block"><strong>Immutable identity</strong><div class="ccr-proof-row"><span>Item</span><code>${escapeHtml(item.contentItemId)}</code></div><div class="ccr-proof-row"><span>Version</span><code>${escapeHtml(item.contentVersionId)}</code></div><div class="ccr-proof-row"><span>Created</span>${time(item.createdAt)}</div></div>
    <div class="ccr-proof-block"><strong>Approval ledger</strong><div class="ccr-proof-row"><span>Request</span><code>${escapeHtml(item.approvalRequestId ?? 'No request')}</code></div><div class="ccr-proof-row"><span>Decision</span><code>${escapeHtml(item.approvalDecisionId ?? 'No decision')}</code></div><div class="ccr-proof-row"><span>Status</span><code>${escapeHtml(item.approvalStatus)}</code></div></div>
    <div class="ccr-proof-block"><strong>Source attestation</strong><div class="ccr-proof-row"><span>Attestation</span><code>${escapeHtml(item.sourceAttestationId ?? 'Not recorded')}</code></div><div class="ccr-proof-row"><span>Checked</span>${time(item.sourceCheckedAt)}</div><div class="ccr-proof-row"><span>Expires</span>${time(item.sourceExpiresAt)}</div></div>
    <div class="ccr-proof-block"><strong>Exact source</strong><div class="ccr-proof-row"><span>System</span><code>${escapeHtml(item.sourceSystem)}</code></div><div class="ccr-proof-row"><span>Item</span><code>${escapeHtml(item.sourceItemId)}</code></div><div class="ccr-proof-row"><span>Revision</span><code>${escapeHtml(item.sourceVersion)}</code></div></div>
    <div class="ccr-proof-block wide"><strong>SHA-256 chain</strong><div class="ccr-proof-row"><span>Content</span><code>${escapeHtml(item.contentSha256)}</code></div><div class="ccr-proof-row"><span>Blob</span><code>${escapeHtml(item.blobSha256)}</code></div><div class="ccr-proof-row"><span>Brand</span><code>${escapeHtml(item.brandSha256)}</code></div></div>
  </div></details>`;
}

function contentCard(
  view: ContentControlRoomView,
  item: ContentControlRoomItemView,
  security: ContentControlRoomActionSecurity | undefined,
): string {
  const publishTone = item.publishable ? 'eligible' : 'locked';
  const sourceTone = item.sourceFresh ? 'fresh' : 'warning';
  return `<li><article class="ccr-card ${publishTone}" id="${escapeHtml(item.anchorId)}" aria-labelledby="${escapeHtml(item.anchorId)}-title">
    <header class="ccr-card-head"><div class="ccr-card-identity"><div class="ccr-card-meta"><span class="ccr-chip version">Immutable v${safeCount(item.versionNumber)}</span><span class="ccr-chip">${escapeHtml(item.channelLabel)}</span><span class="ccr-chip">${escapeHtml(item.kindLabel)}</span><span class="ccr-chip">${escapeHtml(item.originLabel)}</span></div><h3 id="${escapeHtml(item.anchorId)}-title">${escapeHtml(item.title)}</h3><p class="ccr-source-line"><span>Source</span><code>${escapeHtml(item.sourceSystem)}</code><span>·</span><code>${escapeHtml(item.sourceItemId)}</code><span>· revision</span><code>${escapeHtml(item.sourceVersion)}</code></p></div><div class="ccr-publish-state ${publishTone}" aria-label="Publishable gate: ${escapeHtml(item.publishableLabel)}"><span>Publishable gate</span><strong>${escapeHtml(item.publishableLabel)}</strong></div></header>
    <div class="ccr-gates" aria-label="Version safety gates"><section class="ccr-gate"><span class="ccr-gate-label">Exact approval</span><strong class="ccr-gate-state ${approvalTone(item.approvalTone)}">${escapeHtml(item.approvalLabel)}</strong><p>${escapeHtml(item.approvalDetail)}</p>${item.approvalStale ? '<span class="ccr-stale-flag">Stale · newer version exists</span>' : ''}</section><section class="ccr-gate"><span class="ccr-gate-label">Review representation</span><strong class="ccr-gate-state ${item.reviewRepresentationAvailable ? 'fresh' : 'warning'}">${escapeHtml(item.reviewRepresentationLabel)}</strong><p>${escapeHtml(item.reviewRepresentationDetail)}</p></section><section class="ccr-gate"><span class="ccr-gate-label">Source freshness</span><strong class="ccr-gate-state ${sourceTone}">${escapeHtml(item.sourceFreshnessLabel)}</strong><p>${escapeHtml(item.sourceFreshnessDetail)}</p></section><section class="ccr-gate"><span class="ccr-gate-label">Outbound eligibility</span><strong class="ccr-gate-state ${publishTone}">${escapeHtml(item.publishableLabel)}</strong><p>${escapeHtml(item.publishableDetail)}</p></section></div>${contentActions(view, item, security)}
    <footer class="ccr-card-foot"><span>${escapeHtml(item.contentMimeType)} · captured ${time(item.createdAt)}</span>${fullProof(item)}</footer>
  </article></li>`;
}

function emptyState(view: ContentControlRoomView): string {
  if (view.catalogEmpty) {
    return '<div class="ccr-empty" role="status"><span class="ccr-empty-mark" aria-hidden="true">00</span><strong>No company content has landed yet.</strong><p>The control room stays honest until an owned, source-attested version is imported. Nothing has been invented and no customer-private content is shown.</p></div>';
  }
  return `<div class="ccr-empty" role="status"><span class="ccr-empty-mark" aria-hidden="true">0</span><strong>No content matches these filters.</strong><p>The loaded catalogue is intact. Clear the channel, format or search filter to see the current versions again.</p><a href="${CONTENT_CONTROL_ROOM_ROUTE}">Clear all filters</a></div>`;
}

function reviewQueue(view: ContentControlRoomView): string {
  const items = view.reviewQueue.map((item, index) => `<li class="ccr-review-item"><a class="ccr-review-link" href="#${escapeHtml(item.anchorId)}"><span class="ccr-review-index" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span><span class="ccr-review-copy"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.reason)}</span></span><span class="ccr-review-version">v${safeCount(item.versionNumber)}</span><span class="ccr-visually-hidden">${escapeHtml(item.approvalLabel)}. Source ${item.sourceFresh ? 'fresh' : 'stale'}.</span></a></li>`).join('');
  const body = items
    ? `<ol class="ccr-review-list">${items}</ol>`
    : `<div class="ccr-empty" role="status"><span class="ccr-empty-mark" aria-hidden="true">✓</span><strong>${view.matchingCount === 0 ? 'Nothing in this filtered view.' : 'No review blockers here.'}</strong><p>${view.matchingCount === 0 ? 'Change the current filters to inspect another slice.' : 'Every matching item has exact approval and fresh source proof.'}</p></div>`;
  const bounded = view.matchingAttentionCount > view.reviewQueue.length
    ? `Showing first ${safeCount(view.reviewQueue.length)} of ${safeCount(view.matchingAttentionCount)} matching attention items.`
    : `${safeCount(view.matchingAttentionCount)} matching item${view.matchingAttentionCount === 1 ? ' needs' : 's need'} attention.`;
  return `<aside class="ccr-review" aria-labelledby="ccr-review-title"><header class="ccr-section-head"><div><h2 id="ccr-review-title">Review queue</h2><p>Prioritised by stale version, pending decision, then source proof.</p></div><span class="ccr-result-count">${safeCount(view.matchingAttentionCount)}</span></header>${body}<p class="ccr-review-note"><strong>Protected workflow.</strong> ${escapeHtml(bounded)} Approval actions record immutable review evidence and never trigger a provider.</p></aside>`;
}

function filters(view: ContentControlRoomView): string {
  const channels = CHANNEL_OPTIONS.map((entry) => option(entry.value, entry.label, view.filters.channel)).join('');
  const formats = FORMAT_OPTIONS.map((entry) => option(entry.value, entry.label, view.filters.format)).join('');
  return `<form class="ccr-filterbar" method="get" action="${CONTENT_CONTROL_ROOM_ROUTE}" aria-label="Filter company content"><div class="ccr-field search"><label for="ccr-query">Search content or source</label><input id="ccr-query" name="q" type="search" maxlength="${CONTENT_CONTROL_ROOM_MAX_QUERY_LENGTH}" autocomplete="off" value="${escapeHtml(view.filters.query)}" placeholder="Title, source item or revision"></div><div class="ccr-field"><label for="ccr-channel">Channel</label><select id="ccr-channel" name="channel">${channels}</select></div><div class="ccr-field"><label for="ccr-format">Format</label><select id="ccr-format" name="format">${formats}</select></div><button class="ccr-filter-button" type="submit">Apply filters</button><a class="ccr-clear" href="${CONTENT_CONTROL_ROOM_ROUTE}">Clear</a></form>`;
}

export function renderContentControlRoomBody(
  view: ContentControlRoomView,
  options: RenderContentControlRoomOptions = {},
): string {
  const cards = view.items.map((item) => contentCard(view, item, options.security)).join('');
  const pageTruth = view.hasMore
    ? 'This is a bounded latest-version page; more catalogue records are available.'
    : 'This is the complete bounded latest-version page returned for this workspace.';
  const truncationTruth = view.inputTruncated
    ? ' The presenter rejected unbounded output and rendered only the first 100 records.'
    : '';
  const workspaceNavigation = options.companyAssetsAvailable || options.brandBrainAvailable
    ? renderContentWorkspaceNavigation('library', {
        companyAssetsAvailable: options.companyAssetsAvailable === true,
        assetsLabel: options.companyAssetsLabel,
        brandBrainAvailable: options.brandBrainAvailable === true,
        brainLabel: options.brandBrainLabel,
      })
    : '';
  return `${workspaceNavigation}<style data-property-predator-content-control>${CONTENT_CONTROL_ROOM_STYLE}</style><article class="ccr" aria-labelledby="ccr-title">
    <header class="ccr-hero"><div class="ccr-hero-copy"><div class="ccr-kicker">Growth HQ · Content control</div><h1 id="ccr-title">Every asset. Every version. <em>No guesswork.</em></h1><p>Reuse the owned Property Predator content machine, then hold every revision behind an exact approval and a fresh source proof. Fast to inspect. Impossible to confuse with a live publishing screen.</p></div><aside class="ccr-snapshot" aria-label="Content catalogue snapshot"><span>Company-owned catalogue</span><strong>${escapeHtml(view.workspaceName)}</strong><small>${safeCount(view.sourceCount)} source system${view.sourceCount === 1 ? '' : 's'} · viewed ${time(view.asOf)}</small></aside></header>
    <section class="ccr-truth" aria-label="Content safety boundary"><span class="ccr-truth-mark">Truth boundary</span><p><strong>Approval and outbound use are locked.</strong> This catalogue currently shows identity, provenance and hashes, but not the exact text or artwork a human must inspect. No post, message, schedule or provider call happens here.</p><span class="ccr-readonly">${view.canManage ? 'Fail-closed controls' : view.canWrite ? 'Submit controls' : 'Review control only'}</span></section>${notice(view.notice)}
    <section class="ccr-metrics" aria-label="Loaded catalogue summary"><div class="ccr-metric"><small>Latest versions loaded</small><strong>${safeCount(view.metrics.loaded)}</strong><span>Bounded to 100 exact records</span></div><div class="ccr-metric"><small>Recorded approvals</small><strong>${safeCount(view.metrics.exactApproved)}</strong><span>Hash-bound decisions, not reviewable here</span></div><div class="ccr-metric eligible"><small>Outbound eligible</small><strong>${safeCount(view.metrics.publishable)}</strong><span>Locked until exact content is reviewable</span></div><div class="ccr-metric attention"><small>Needs attention</small><strong>${safeCount(view.metrics.needsAttention)}</strong><span>Review representation or source proof blocked</span></div></section>
    ${filters(view)}
    <div class="ccr-layout"><section class="ccr-catalog" aria-labelledby="ccr-catalog-title"><header class="ccr-section-head"><div><h2 id="ccr-catalog-title">Version catalogue</h2><p>Latest immutable version per owned source item.</p></div><span class="ccr-result-count">${safeCount(view.matchingCount)} / ${safeCount(view.loadedCount)}</span></header>${cards ? `<ol class="ccr-items">${cards}</ol>` : emptyState(view)}<div class="ccr-page-note"><span>${escapeHtml(pageTruth)}${escapeHtml(truncationTruth)}</span><span>Filters apply to this loaded page.</span></div></section>${reviewQueue(view)}</div>
    <footer class="ccr-footer"><span><strong>Zero provider effects:</strong> approvals change review state only; no scheduling, sending or publishing happens here.</span><span>Snapshot ${time(view.asOf)}</span></footer>
  </article>`;
}
