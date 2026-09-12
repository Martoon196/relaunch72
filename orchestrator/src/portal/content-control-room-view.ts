/**
 * Pure server-rendered Content Control Room.
 *
 * This view is deliberately operational but side-effect free. It exposes the
 * exact version, approval and source-freshness gates that a future delivery
 * rail may consume; it never claims that content was scheduled or published.
 */

import { escapeHtml } from './ui.js';
import {
  GENERATED_SOURCE_REFRESH_ROUTE,
  type ContentControlNoticeView,
} from './content-control-room-actions.js';
import {
  CONTENT_CONTROL_ROOM_MAX_QUERY_LENGTH,
  CONTENT_CONTROL_ROOM_ROUTE,
  type ContentControlRoomChannel,
  type ContentControlRoomFormat,
  type ContentControlRoomItemView,
  type ContentControlRoomView,
} from './content-control-room-presenter.js';
import { renderContentWorkspaceNavigation } from './content-workspace-navigation.js';
import { OWNED_SEED_PROOF_PREPARE_ROUTE } from './owned-seed-actions.js';

export interface ContentControlRoomActionSecurity {
  readonly csrfToken: string;
  /** Exact content-version id to server-created command key. */
  readonly requestApprovalKeys: Readonly<Record<string, string>>;
  /** Exact approval-request id to server-created decision command key. */
  readonly decisionKeys: Readonly<Record<string, string>>;
  /** Exact generated content-version id to server-created revalidation command key. */
  readonly sourceRefreshKeys?: Readonly<Record<string, string>>;
}

export interface RenderContentControlRoomOptions {
  readonly security?: ContentControlRoomActionSecurity;
  readonly companyAssetsAvailable?: boolean;
  readonly companyAssetsLabel?: string;
  readonly brandBrainAvailable?: boolean;
  readonly brandBrainLabel?: string;
  readonly companyContentSyncAvailable?: boolean;
  readonly ownedSeedProofAvailable?: boolean;
  readonly ownedSeedPrepareCommandKey?: string;
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
  .ccr-jobs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;padding:16px;background:var(--ccr-soft);border-bottom:1px solid var(--ccr-line)}.ccr-job{display:grid;align-content:start;min-height:150px;border:1px solid var(--ccr-line);border-radius:10px;background:var(--ccr-panel);padding:16px;color:var(--ccr-ink)}.ccr-job small{color:var(--ccr-teal);font:850 11px var(--mono,monospace);text-transform:uppercase}.ccr-job strong{margin:8px 0 5px;font-size:17px}.ccr-job span{color:var(--ccr-muted);font-size:12px;line-height:1.5}.ccr-job b{margin-top:auto;padding-top:12px;color:var(--ccr-teal);font-size:12px}.ccr-library-details>summary{min-height:48px;padding:14px 18px;background:var(--ccr-panel);border-bottom:1px solid var(--ccr-line);cursor:pointer;font-weight:850}.ccr-library-details>summary span{display:block;color:var(--ccr-muted);font-size:11px;font-weight:500}@media(max-width:820px){.ccr-jobs{grid-template-columns:1fr}}
  .ccr{--ccr-bg:var(--canvas);--ccr-panel:var(--panel);--ccr-raised:var(--panel-strong);--ccr-soft:var(--panel-subtle);--ccr-line:var(--line);--ccr-line-strong:var(--line-strong);--ccr-ink:var(--ink);--ccr-muted:var(--muted);--ccr-faint:var(--faint);--ccr-teal:var(--accent);--ccr-teal-soft:var(--accent-soft);--ccr-amber:var(--accent-deep);--ccr-red:var(--danger);--ccr-green:var(--success);min-width:0;color:var(--ccr-ink);font-family:var(--sans,ui-sans-serif,system-ui,sans-serif);background:var(--ccr-bg);border:1px solid var(--line);overflow:hidden}
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
  .ccr-exact-link{min-height:38px;display:inline-flex;align-items:center;justify-content:center;margin-top:11px;border:1px solid var(--ccr-teal);border-radius:6px;padding:7px 10px;color:var(--ccr-teal);font-size:11px;font-weight:900;text-decoration:none}.ccr-exact-link:hover{background:#092521}.ccr-exact-link:focus-visible{outline:3px solid rgba(0,229,204,.36);outline-offset:2px}
  .ccr-empty{margin:10px;border:1px dashed var(--ccr-line-strong);padding:30px 22px;text-align:center;background:var(--ccr-soft)}.ccr-empty-mark{width:42px;height:42px;margin:0 auto 11px;border:1px solid var(--ccr-line-strong);display:grid;place-items:center;color:var(--ccr-teal);font:900 16px var(--mono,monospace)}.ccr-empty strong{display:block;font-size:14px}.ccr-empty p{max-width:520px;margin:6px auto 0;color:var(--ccr-muted);font-size:12px;line-height:1.55}.ccr-empty a{display:inline-flex;min-height:44px;align-items:center;margin-top:10px;color:var(--ccr-teal);font-size:12px;font-weight:850}.ccr-page-note{display:flex;justify-content:space-between;gap:12px;padding:11px 18px;border-top:1px solid var(--ccr-line);color:var(--ccr-faint);font-size:12px}.ccr-footer{display:flex;justify-content:space-between;gap:14px;padding:13px 18px;border-top:1px solid var(--ccr-line);background:#080a0c;color:var(--ccr-faint);font-size:12px}.ccr-footer strong{color:var(--ccr-muted)}
  @media(max-width:1080px){.ccr-filterbar{grid-template-columns:minmax(220px,1fr) repeat(2,minmax(150px,190px));}.ccr-filter-button,.ccr-clear{grid-row:2}.ccr-layout{grid-template-columns:minmax(0,1fr) 310px}.ccr-gates{grid-template-columns:1fr}.ccr-gate{border-right:0;border-bottom:1px solid var(--ccr-line)}.ccr-gate:last-child{border-bottom:0}}
  @media(max-width:820px){.ccr-hero{grid-template-columns:1fr;padding:23px 20px 20px}.ccr-truth{grid-template-columns:1fr;padding:12px 20px}.ccr-readonly{justify-self:start}.ccr-metrics{grid-template-columns:repeat(2,1fr)}.ccr-metric:nth-child(2){border-right:0}.ccr-metric:nth-child(n+3){border-top:1px solid var(--ccr-line)}.ccr-filterbar{grid-template-columns:repeat(2,minmax(0,1fr));padding:14px 20px}.ccr-field.search{grid-column:1/-1}.ccr-layout{grid-template-columns:1fr;padding:10px}.ccr-review{position:static;grid-row:1}.ccr-proof-grid{grid-template-columns:1fr}.ccr-proof-block.wide{grid-column:auto}}
  @media(max-width:520px){.ccr-hero h1{font-size:2.3rem}.ccr-metrics{grid-template-columns:1fr}.ccr-metric,.ccr-metric:nth-child(2){border-right:0}.ccr-metric:nth-child(n+2){border-top:1px solid var(--ccr-line)}.ccr-filterbar{grid-template-columns:1fr}.ccr-field.search{grid-column:auto}.ccr-filter-button,.ccr-clear{grid-row:auto;width:100%}.ccr-section-head,.ccr-card-head,.ccr-page-note,.ccr-footer{align-items:stretch;flex-direction:column}.ccr-card-head{grid-template-columns:1fr}.ccr-publish-state{width:100%;text-align:left}.ccr-card-foot{align-items:flex-start;flex-direction:column}.ccr-proof{width:100%}.ccr-proof summary{justify-content:flex-start}.ccr-proof-row{grid-template-columns:1fr}.ccr-proof-row span{margin-bottom:-2px}.ccr-action-form{grid-template-columns:1fr}.ccr-action-buttons{display:grid;grid-template-columns:1fr}.ccr-action-button{width:100%}}
  @media(forced-colors:active){.ccr,.ccr-card,.ccr-catalog,.ccr-review,.ccr-snapshot,.ccr-chip,.ccr-publish-state,.ccr-gate-state::before{forced-color-adjust:auto}.ccr-card{border-left-width:5px}.ccr-filter-button{border:2px solid ButtonText}}
  html[data-theme="light"] .ccr-hero,html[data-theme="light"] .ccr-snapshot,html[data-theme="light"] .ccr-truth,html[data-theme="light"] .ccr-filterbar,html[data-theme="light"] .ccr-actions,html[data-theme="light"] .ccr-footer{background:var(--ccr-panel)}html[data-theme="light"] .ccr-notice{background:var(--ccr-teal-soft)}html[data-theme="light"] .ccr-notice[data-kind="info"],html[data-theme="light"] .ccr-publish-state.locked{background:var(--ccr-soft)}html[data-theme="light"] .ccr-notice[data-kind="error"]{background:var(--danger-soft)}html[data-theme="light"] .ccr-exact-link:hover{background:var(--ccr-teal-soft)}html[data-theme="light"] .ccr-filter-button,html[data-theme="light"] .ccr-action-button.primary{color:#fff;background:var(--ccr-teal)}
  @media(prefers-color-scheme:light){html[data-theme="system"] .ccr-hero,html[data-theme="system"] .ccr-snapshot,html[data-theme="system"] .ccr-truth,html[data-theme="system"] .ccr-filterbar,html[data-theme="system"] .ccr-actions,html[data-theme="system"] .ccr-footer{background:var(--ccr-panel)}html[data-theme="system"] .ccr-notice{background:var(--ccr-teal-soft)}html[data-theme="system"] .ccr-notice[data-kind="info"],html[data-theme="system"] .ccr-publish-state.locked{background:var(--ccr-soft)}html[data-theme="system"] .ccr-notice[data-kind="error"]{background:var(--danger-soft)}html[data-theme="system"] .ccr-exact-link:hover{background:var(--ccr-teal-soft)}html[data-theme="system"] .ccr-filter-button,html[data-theme="system"] .ccr-action-button.primary{color:#fff;background:var(--ccr-teal)}}
  html[data-theme="light"] .ccr-hero{background:radial-gradient(circle at 86% 8%,var(--accent-soft),transparent 35%),linear-gradient(135deg,var(--panel),var(--panel-subtle) 68%)}html[data-theme="light"] .ccr-safety,html[data-theme="light"] .ccr-toolbar,html[data-theme="light"] .ccr-filterbar,html[data-theme="light"] .ccr-footer{background:var(--panel-subtle)}html[data-theme="light"] .ccr-card,html[data-theme="light"] .ccr-panel,html[data-theme="light"] .ccr-metric{background:var(--panel)}
  @media(prefers-color-scheme:light){html[data-theme="system"] .ccr-hero{background:radial-gradient(circle at 86% 8%,var(--accent-soft),transparent 35%),linear-gradient(135deg,var(--panel),var(--panel-subtle) 68%)}html[data-theme="system"] .ccr-safety,html[data-theme="system"] .ccr-toolbar,html[data-theme="system"] .ccr-filterbar,html[data-theme="system"] .ccr-footer{background:var(--panel-subtle)}html[data-theme="system"] .ccr-card,html[data-theme="system"] .ccr-panel,html[data-theme="system"] .ccr-metric{background:var(--panel)}}

  .ccr{border-radius:16px}.ccr-hero{display:flex;align-items:center;justify-content:space-between;padding:28px;gap:20px;background:var(--ccr-panel)}.ccr-hero::after{display:none}.ccr-hero h1{font-size:32px;line-height:1.15;letter-spacing:-.025em}.ccr-hero-copy>p{font-size:15px;max-width:620px}.ccr-kicker{font:600 12px var(--sans,system-ui);letter-spacing:0;text-transform:none;color:var(--ccr-muted)}
  .ccr .ccr-action-button,.ccr-exact-link{display:inline-flex;align-items:center;justify-content:center;min-height:46px;font-size:14px;font-weight:700;padding:10px 18px;border-radius:9px}.ccr-exact-link{margin:0;background:var(--ccr-teal);color:var(--ccr-bg)}.ccr-exact-link:hover{background:var(--ccr-teal-soft);color:var(--ccr-ink)}
  .ccr-metrics{gap:8px;padding:16px 24px;border:0}.ccr-metric{border:1px solid var(--ccr-line);border-radius:10px;padding:14px 16px;color:var(--ccr-ink)}.ccr-metric:last-child{border-right:1px solid var(--ccr-line)}.ccr-metric:hover,.ccr-metric[aria-current="page"]{border-color:var(--ccr-teal);background:var(--ccr-teal-soft)}.ccr-metric small{font:600 14px var(--sans,system-ui);letter-spacing:0;text-transform:none;color:var(--ccr-muted)}.ccr-metric strong{font:750 24px var(--sans,system-ui)}
  .ccr-filterbar{padding:8px 24px 20px;background:var(--ccr-panel)}.ccr-field label{font:600 13px var(--sans,system-ui);text-transform:none;letter-spacing:0}.ccr-layout{display:block;padding:0 24px 24px}.ccr-catalog{border:0}.ccr-items{padding:0;gap:14px}.ccr-section-head{padding:18px 0;border:0}.ccr-section-head h2{font-size:20px}.ccr-card{border:1px solid var(--ccr-line);border-radius:12px;background:var(--ccr-panel)}.ccr-card-head{display:block;padding:20px 20px 12px;border:0}.ccr-card h3{font-size:19px;line-height:1.5;margin:8px 0}.ccr-title-link{color:var(--ccr-ink);text-decoration:underline!important;text-underline-offset:4px;text-decoration-color:var(--ccr-line)!important}.ccr-title-link:hover{color:var(--ccr-teal)}
  .ccr-card-meta{font-size:13px;color:var(--ccr-muted);gap:12px}.ccr-status-label{font-weight:650;color:var(--ccr-ink)}.ccr-next{margin:4px 0 0;color:var(--ccr-muted);font-size:14px;line-height:1.6}.ccr-actions{padding:0 20px 18px;background:var(--ccr-panel);border:0}.ccr-action-form{margin:0;display:block}.ccr-action-lock{font:400 13px/1.6 var(--sans,system-ui);margin:8px 0}.ccr-card-foot{padding:0 20px 12px;display:block}.ccr-proof summary{justify-content:flex-start;font:500 13px var(--sans,system-ui);text-transform:none;color:var(--ccr-muted)}.ccr-proof-grid{padding:8px 0}.ccr-footer{background:var(--ccr-panel);font-size:13px}.ccr-admin{margin:0 24px 20px}.ccr-admin>summary{cursor:pointer;min-height:44px;padding:12px;color:var(--ccr-muted)}
  .ccr a:focus-visible,.ccr summary:focus-visible{outline:3px solid var(--ccr-teal);outline-offset:3px}
  @media(max-width:820px){.ccr-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.ccr-hero{align-items:flex-start;flex-direction:column;padding:20px}.ccr-hero h1{font-size:28px}.ccr-layout{padding:0 12px 16px}.ccr-metrics{padding:12px}.ccr-filterbar{padding:8px 12px 16px}}
  @media(max-width:520px){.ccr-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.ccr-metric{padding:12px}.ccr-card-head{padding:16px}.ccr-actions,.ccr-card-foot{padding-left:16px;padding-right:16px}.ccr-exact-link{width:100%}.ccr-hero>.ccr-action-button{width:100%}}

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


function validSecurityToken(value: string | undefined): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 512;
}
function validCommandKey(value: string | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value);
}
function reviewHref(item: ContentControlRoomItemView): string {
  return `/portal/content/items/${encodeURIComponent(item.contentItemId)}/versions/${encodeURIComponent(item.contentVersionId)}/review`;
}
function postStatus(item: ContentControlRoomItemView): string {
  if (item.approvalStale || item.approvalStatus === 'stale') return 'Review updated version';
  if (item.approvalStatus === 'changes_requested') return 'Changes requested';
  if (item.approvalStatus === 'rejected') return 'Not approved';
  if (item.approvalStatus === 'pending') return 'Awaiting approval';
  if (item.approvalStatus === 'unrequested') return 'Draft';
  if (item.publishable) return 'Ready to plan';
  if (!item.sourceFresh) return 'Needs a quick check';
  return 'Needs attention';
}
function nextStep(item: ContentControlRoomItemView): string {
  if (!item.reviewRepresentationAvailable) return 'The preview is unavailable. Try opening this post again shortly.';
  if (item.approvalStale || item.approvalStatus === 'stale') return 'This post has changed. Review the updated version before using it.';
  if (item.approvalStatus === 'unrequested') return 'Open this post to read it, make changes or send it for approval.';
  if (item.approvalStatus === 'pending') return 'This post is waiting for a decision. Open it to review the wording.';
  if (item.approvalStatus === 'changes_requested') return 'Open this post and make the requested changes.';
  if (item.approvalStatus === 'rejected') return 'This version was not approved. Open it to make changes.';
  if (!item.sourceFresh) return 'Your approval is saved. Check the saved source again before planning.';
  return item.publishable ? 'Approved and checked. Open the post to continue to your calendar.' : 'Open the post to see what still needs attention.';
}
function contentActions(view: ContentControlRoomView, item: ContentControlRoomItemView,
  security: ContentControlRoomActionSecurity | undefined): string {
  const label = item.approvalStatus === 'pending' && view.canManage ? 'Review & approve'
    : item.publishable ? 'Open approved post' : 'Open post';
  const open = `<a class="ccr-exact-link" href="${reviewHref(item)}">${escapeHtml(label)} <span aria-hidden="true">→</span></a>`;
  const key = security?.sourceRefreshKeys?.[item.contentVersionId];
  if (item.approvalStatus === 'approved' && !item.approvalStale && !item.sourceFresh
      && item.sourceSystem === 'property_predator_generation' && view.canWrite && view.canManage
      && validSecurityToken(security?.csrfToken) && validCommandKey(key)) {
    return `<section class="ccr-actions" aria-label="Next step"><form class="ccr-action-form" method="post" action="${GENERATED_SOURCE_REFRESH_ROUTE}"><input type="hidden" name="_csrf" value="${escapeHtml(security.csrfToken)}"><input type="hidden" name="command_key" value="${escapeHtml(key)}"><input type="hidden" name="content_item_id" value="${escapeHtml(item.contentItemId)}"><input type="hidden" name="content_version_id" value="${escapeHtml(item.contentVersionId)}"><input type="hidden" name="version_number" value="${safeCount(item.versionNumber)}"><input type="hidden" name="content_sha256" value="${escapeHtml(item.contentSha256)}"><input type="hidden" name="return_q" value="${escapeHtml(view.filters.query)}"><input type="hidden" name="return_channel" value="${escapeHtml(view.filters.channel)}"><input type="hidden" name="return_format" value="${escapeHtml(view.filters.format)}"><input type="hidden" name="return_anchor" value="${escapeHtml(item.anchorId)}"><button class="ccr-action-button primary" type="submit">Check for scheduling</button> <a class="ccr-clear" href="${reviewHref(item)}">View post</a></form><p class="ccr-action-lock">Checks the saved source. Your wording stays the same.</p></section>`;
  }
  return `<section class="ccr-actions" aria-label="Next step">${open}${!view.canWrite ? '<p class="ccr-action-lock">You can view this content. Ask a workspace editor to make changes.</p>' : ''}</section>`;
}
function notice(view: ContentControlNoticeView | undefined): string {
  if (!view) return '';
  return `<section class="ccr-notice" id="ccr-notice" style="scroll-margin-top:100px" data-kind="${escapeHtml(view.kind)}" role="status"><strong>${escapeHtml(view.title)}</strong><p>${escapeHtml(view.message)}</p></section>`;
}

function fullProof(item: ContentControlRoomItemView): string {
  return `<details class="ccr-proof"><summary>Technical details</summary><div class="ccr-proof-grid">
    <div class="ccr-proof-block"><strong>Version history</strong><div class="ccr-proof-row"><span>Item</span><code>${escapeHtml(item.contentItemId)}</code></div><div class="ccr-proof-row"><span>Version</span><code>${escapeHtml(item.contentVersionId)}</code></div><div class="ccr-proof-row"><span>Created</span>${time(item.createdAt)}</div></div>
    <div class="ccr-proof-block"><strong>Approval ledger</strong><div class="ccr-proof-row"><span>Request</span><code>${escapeHtml(item.approvalRequestId ?? 'No request')}</code></div><div class="ccr-proof-row"><span>Decision</span><code>${escapeHtml(item.approvalDecisionId ?? 'No decision')}</code></div><div class="ccr-proof-row"><span>Status</span><code>${escapeHtml(item.approvalStatus)}</code></div></div>
    <div class="ccr-proof-block"><strong>Source attestation</strong><div class="ccr-proof-row"><span>Attestation</span><code>${escapeHtml(item.sourceAttestationId ?? 'Not recorded')}</code></div><div class="ccr-proof-row"><span>Checked</span>${time(item.sourceCheckedAt)}</div><div class="ccr-proof-row"><span>Expires</span>${time(item.sourceExpiresAt)}</div></div>
    <div class="ccr-proof-block"><strong>Source record</strong><div class="ccr-proof-row"><span>File type</span><code>${escapeHtml(item.contentMimeType)}</code></div><div class="ccr-proof-row"><span>System</span><code>${escapeHtml(item.sourceSystem)}</code></div><div class="ccr-proof-row"><span>Item</span><code>${escapeHtml(item.sourceItemId)}</code></div><div class="ccr-proof-row"><span>Revision</span><code>${escapeHtml(item.sourceVersion)}</code></div></div>
    <div class="ccr-proof-block wide"><strong>SHA-256 chain</strong><div class="ccr-proof-row"><span>Content</span><code>${escapeHtml(item.contentSha256)}</code></div><div class="ccr-proof-row"><span>Blob</span><code>${escapeHtml(item.blobSha256)}</code></div><div class="ccr-proof-row"><span>Brand</span><code>${escapeHtml(item.brandSha256)}</code></div></div>
  </div></details>`;
}


function contentCard(view: ContentControlRoomView, item: ContentControlRoomItemView,
  security: ContentControlRoomActionSecurity | undefined): string {
  return `<li><article class="ccr-card ${item.publishable ? 'eligible' : 'locked'}" id="${escapeHtml(item.anchorId)}" aria-labelledby="${escapeHtml(item.anchorId)}-title"><header class="ccr-card-head"><div class="ccr-card-meta"><span>${escapeHtml(item.kindLabel)}</span><span class="ccr-status-label">${escapeHtml(postStatus(item))}</span></div><h3 id="${escapeHtml(item.anchorId)}-title"><a class="ccr-title-link" href="${reviewHref(item)}">${escapeHtml(item.title)}</a></h3><p class="ccr-next">${escapeHtml(nextStep(item))}</p></header>${contentActions(view, item, security)}<footer class="ccr-card-foot">${fullProof(item)}</footer></article></li>`;
}
function emptyState(view: ContentControlRoomView): string {
  return view.catalogEmpty
    ? '<div class="ccr-empty" role="status"><strong>Your first post starts here.</strong><p>Create a draft, then come back to review it.</p><a href="/portal/campaigns/new">Create a post →</a></div>'
    : `<div class="ccr-empty" role="status"><strong>No content in this view.</strong><p>Try another status or clear your filters.</p><a href="${CONTENT_CONTROL_ROOM_ROUTE}">Show all content</a></div>`;
}
function filters(view: ContentControlRoomView): string {
  return `<form class="ccr-filterbar" method="get" action="${CONTENT_CONTROL_ROOM_ROUTE}" aria-label="Filter company content"><input type="hidden" name="status" value="${escapeHtml(view.filters.status)}"><div class="ccr-field search"><label for="ccr-query">Find a post</label><input id="ccr-query" name="q" type="search" maxlength="${CONTENT_CONTROL_ROOM_MAX_QUERY_LENGTH}" autocomplete="off" value="${escapeHtml(view.filters.query)}" placeholder="Search your content"></div><div class="ccr-field"><label for="ccr-channel">Channel</label><select id="ccr-channel" name="channel">${CHANNEL_OPTIONS.map(entry => option(entry.value, entry.label, view.filters.channel)).join('')}</select></div><div class="ccr-field"><label for="ccr-format">Format</label><select id="ccr-format" name="format">${FORMAT_OPTIONS.map(entry => option(entry.value, entry.label, view.filters.format)).join('')}</select></div><button class="ccr-filter-button" type="submit">Find</button><a class="ccr-clear" href="${CONTENT_CONTROL_ROOM_ROUTE}">Clear</a></form>`;
}
export function renderContentControlRoomBody(view: ContentControlRoomView,
  options: RenderContentControlRoomOptions = {}): string {
  const workspaceNavigation = options.companyAssetsAvailable || options.brandBrainAvailable || options.companyContentSyncAvailable
    ? renderContentWorkspaceNavigation('library', { companyAssetsAvailable: options.companyAssetsAvailable === true,
      assetsLabel: options.companyAssetsLabel, brandBrainAvailable: options.brandBrainAvailable === true,
      brainLabel: options.brandBrainLabel, companyContentSyncAvailable: options.companyContentSyncAvailable === true }) : '';
  const tabs = [
    { value: 'all', label: 'All content', count: view.metrics.loaded },
    { value: 'attention', label: 'Needs attention', count: view.metrics.needsAttention },
    { value: 'approved', label: 'Approved', count: view.metrics.exactApproved },
    { value: 'ready', label: 'Ready to plan', count: view.metrics.publishable },
  ].map(tab => `<a class="ccr-metric" href="${CONTENT_CONTROL_ROOM_ROUTE}?status=${tab.value}#content-library"${view.filters.status === tab.value ? ' aria-current="page"' : ''}><small>${tab.label}</small><strong>${safeCount(tab.count)}</strong></a>`).join('');
  const admin = options.ownedSeedProofAvailable && view.canManage && validSecurityToken(options.security?.csrfToken) && validCommandKey(options.ownedSeedPrepareCommandKey)
    ? `<details class="ccr-admin"><summary>Internal email test</summary><p>Prepare a draft for the office-only email test.</p><form method="post" action="${OWNED_SEED_PROOF_PREPARE_ROUTE}"><input type="hidden" name="_csrf" value="${escapeHtml(options.security!.csrfToken)}"><input type="hidden" name="command_key" value="${escapeHtml(options.ownedSeedPrepareCommandKey)}"><button class="ccr-action-button" type="submit">Prepare test email</button></form></details>` : '';
  return `${workspaceNavigation}<style data-property-predator-content-control>${CONTENT_CONTROL_ROOM_STYLE}</style><article class="ccr" aria-labelledby="ccr-title"><header class="ccr-hero"><div class="ccr-hero-copy"><div class="ccr-kicker">${escapeHtml(view.workspaceName)}</div><h1 id="ccr-title">Your content</h1><p>Open a post to read it, edit it or get it ready for your calendar.</p></div><a class="ccr-action-button primary" href="/portal/campaigns/new">+ Create a post</a></header>${notice(view.notice)}<nav class="ccr-metrics" aria-label="Content status">${tabs}</nav>${filters(view)}<div class="ccr-layout" id="content-library"><section class="ccr-catalog" aria-labelledby="ccr-catalog-title"><header class="ccr-section-head"><h2 id="ccr-catalog-title">${view.filters.status === 'attention' ? 'Needs your attention' : view.filters.status === 'approved' ? 'Approved content' : view.filters.status === 'ready' ? 'Ready for your calendar' : 'Saved content'}</h2><span class="ccr-result-count">${safeCount(view.matchingCount)} item${view.matchingCount === 1 ? '' : 's'}</span></header>${view.items.length ? `<ol class="ccr-items">${view.items.map(item => contentCard(view, item, options.security)).join('')}</ol>` : emptyState(view)}</section></div>${admin}<footer class="ccr-footer"><span>Approving a post does not publish it.</span><span>${view.hasMore || view.inputTruncated ? 'Showing the latest 100 items. Counts and filters cover these items.' : `${safeCount(view.loadedCount)} saved item${view.loadedCount === 1 ? '' : 's'}`}</span></footer></article>`;
}
