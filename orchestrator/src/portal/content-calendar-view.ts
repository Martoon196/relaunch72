/**
 * Pure, server-rendered content planner. It exposes only GET navigation and
 * disabled simulator controls; there is no provider or command dependency.
 */

import { escapeHtml } from './ui.js';
import { CONTENT_CALENDAR_CLIENT_ROUTE } from './content-calendar-client.js';
import { renderContentWorkspaceNavigation } from './content-workspace-navigation.js';
import { PUBLIC_SOCIAL_CAMPAIGNS_ROUTE } from './public-social-campaigns-presenter.js';
import {
  CONTENT_CALENDAR_ROUTE,
  type ContentCalendarBacklogItemView,
  type ContentCalendarChannel,
  type ContentCalendarChannelFilter,
  type ContentCalendarDayView,
  type ContentCalendarFiltersView,
  type ContentCalendarMode,
  type ContentCalendarSlotView,
  type ContentCalendarView,
} from './content-calendar-presenter.js';

const CHANNELS: readonly Readonly<{
  value: ContentCalendarChannelFilter;
  label: string;
}>[] = Object.freeze([
  { value: 'all', label: 'All rails' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'x', label: 'X' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'google_business_profile', label: 'Google Business Profile' },
  { value: 'threads', label: 'Threads' },
  { value: 'pinterest', label: 'Pinterest' },
  { value: 'email', label: 'Email' },
  { value: 'webinar', label: 'Webinar' },
]);

const CHANNEL_CLASS: Readonly<Record<ContentCalendarChannel, string>> = Object.freeze({
  linkedin: 'linkedin', instagram: 'instagram', facebook: 'facebook', tiktok: 'tiktok', x: 'x',
  youtube: 'youtube', google_business_profile: 'google-business', threads: 'threads',
  pinterest: 'pinterest', email: 'email', webinar: 'webinar',
});

const CONTENT_CALENDAR_STYLE = `
  .ccal{--cal-bg:#07090b;--cal-panel:#0d1114;--cal-raised:#12181c;--cal-soft:#090c0e;--cal-line:#263238;--cal-line2:#39474e;--cal-ink:#f2f6f5;--cal-muted:#a6b2b5;--cal-faint:#75868b;--cal-teal:#00e5cc;--cal-teal-soft:#062b26;--cal-amber:#f4ba4c;--cal-red:#ff736b;--cal-blue:#77a8ff;min-width:0;overflow:hidden;border:1px solid #020304;background:var(--cal-bg);color:var(--cal-ink);font-family:var(--sans,ui-sans-serif,system-ui,sans-serif)}
  .ccal *{box-sizing:border-box}.ccal h1,.ccal h2,.ccal h3,.ccal p{margin-top:0}.ccal a{text-decoration:none}.ccal button{font:inherit}.ccal code{font-family:var(--mono,ui-monospace,monospace);overflow-wrap:anywhere}.ccal-visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
  .ccal-hero{position:relative;display:grid;grid-template-columns:minmax(0,1fr) minmax(255px,335px);gap:28px;align-items:end;padding:28px 30px 25px;border-bottom:1px solid var(--cal-line);background:radial-gradient(circle at 79% -15%,rgba(0,229,204,.17),transparent 34%),linear-gradient(135deg,#12191c,#080a0c 67%);overflow:hidden}.ccal-hero::before{content:"";position:absolute;width:260px;height:260px;right:18%;top:-190px;border:1px solid rgba(0,229,204,.19);transform:rotate(45deg)}.ccal-kicker{position:relative;color:var(--cal-teal);font:850 12px/1.2 var(--mono,monospace);letter-spacing:.14em;text-transform:uppercase}.ccal-hero h1{position:relative;margin:9px 0 9px;font-family:var(--display,var(--sans));font-size:clamp(2.3rem,4.6vw,4.8rem);font-weight:600;line-height:.91;letter-spacing:-.05em}.ccal-hero h1 em{color:var(--cal-teal);font-style:normal}.ccal-hero p{position:relative;max-width:790px;margin:0;color:var(--cal-muted);font-size:14px;line-height:1.65}.ccal-test-card{position:relative;border:1px solid #36756e;background:rgba(3,17,16,.74);padding:15px}.ccal-test-card strong{display:block;color:var(--cal-teal);font:900 13px var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase}.ccal-test-card span{display:block;margin:8px 0 5px;font-size:14px;font-weight:800}.ccal-test-card small{display:block;color:var(--cal-muted);font-size:12px;line-height:1.5}
  .ccal-safety{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:13px;align-items:center;padding:11px 30px;border-bottom:1px solid var(--cal-line);background:#090d0f}.ccal-safety-mark{color:var(--cal-teal);font:900 12px var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase}.ccal-safety p{margin:0;color:var(--cal-muted);font-size:12px;line-height:1.5}.ccal-safety p strong{color:var(--cal-ink)}.ccal-safety-badge{border:1px solid var(--cal-line2);padding:5px 8px;color:var(--cal-faint);font:850 12px var(--mono,monospace);letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
  .ccal-toolbar{display:grid;grid-template-columns:auto minmax(230px,1fr) auto;gap:13px;align-items:center;padding:14px 18px;border-bottom:1px solid var(--cal-line);background:var(--cal-panel)}.ccal-mode{display:flex;padding:3px;border:1px solid var(--cal-line2);border-radius:8px;background:var(--cal-soft)}.ccal-mode a{min-height:40px;display:grid;place-items:center;border-radius:5px;padding:0 14px;color:var(--cal-muted);font-size:12px;font-weight:900}.ccal-mode a.active{background:var(--cal-teal);color:#02110f}.ccal-period{display:grid;grid-template-columns:44px minmax(0,1fr) 44px;align-items:center;max-width:460px;justify-self:center;width:100%}.ccal-period>a{width:44px;height:44px;display:grid;place-items:center;border:1px solid var(--cal-line2);border-radius:7px;color:var(--cal-ink);font-size:19px}.ccal-period-title{text-align:center}.ccal-period-title strong{display:block;font-size:15px}.ccal-period-title span{display:block;margin-top:3px;color:var(--cal-faint);font:750 12px var(--mono,monospace)}.ccal-draft-action{min-height:44px;border:1px solid #355d59;border-radius:7px;background:#0a211e;color:var(--cal-teal);padding:0 14px;font-size:12px;font-weight:900;cursor:not-allowed;opacity:.76}.ccal-channelbar{display:flex;gap:7px;overflow-x:auto;padding:10px 18px;border-bottom:1px solid var(--cal-line);background:#0a0e10;scrollbar-width:thin}.ccal-channelbar a{min-height:40px;display:inline-flex;align-items:center;border:1px solid var(--cal-line2);border-radius:999px;padding:0 13px;color:var(--cal-muted);font-size:12px;font-weight:850;white-space:nowrap}.ccal-channelbar a.active{border-color:#2d897e;background:var(--cal-teal-soft);color:var(--cal-teal)}
  .ccal-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-bottom:1px solid var(--cal-line);background:var(--cal-panel)}.ccal-metric{min-width:0;padding:14px 18px;border-right:1px solid var(--cal-line)}.ccal-metric:last-child{border-right:0}.ccal-metric small{display:block;color:var(--cal-faint);font:800 12px var(--mono,monospace);letter-spacing:.06em;text-transform:uppercase}.ccal-metric strong{display:block;margin:6px 0 3px;font:900 22px/1 var(--mono,monospace)}.ccal-metric span{color:var(--cal-muted);font-size:12px}.ccal-metric.ready strong{color:var(--cal-teal)}.ccal-metric.blocked strong{color:var(--cal-amber)}
  .ccal-workspace{display:grid;grid-template-columns:minmax(0,1fr) minmax(285px,330px);gap:12px;padding:12px}.ccal-calendar,.ccal-backlog{min-width:0;border:1px solid var(--cal-line);background:var(--cal-panel)}.ccal-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:14px 16px;border-bottom:1px solid var(--cal-line)}.ccal-section-head h2{margin:0;font-size:15px}.ccal-section-head p{margin:4px 0 0;color:var(--cal-muted);font-size:12px;line-height:1.45}.ccal-count{border:1px solid var(--cal-line2);padding:4px 8px;color:var(--cal-muted);font:850 12px var(--mono,monospace);white-space:nowrap}
  .ccal-scroll{max-width:100%;overflow-x:auto;scrollbar-color:var(--cal-line2) var(--cal-soft)}.ccal-weekdays{display:grid;grid-template-columns:repeat(7,minmax(155px,1fr));min-width:1085px;border-bottom:1px solid var(--cal-line);background:var(--cal-soft)}.ccal-weekday{padding:8px 10px;border-right:1px solid var(--cal-line);color:var(--cal-faint);font:800 12px var(--mono,monospace);letter-spacing:.06em;text-transform:uppercase}.ccal-weekday:last-child{border-right:0}.ccal-grid{display:grid;grid-template-columns:repeat(7,minmax(155px,1fr));min-width:1085px}.ccal-day{min-width:0;min-height:410px;border-right:1px solid var(--cal-line);background:#0c1012}.ccal-day:last-child{border-right:0}.ccal-day-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px;border-bottom:1px solid var(--cal-line)}.ccal-day-head strong{font:900 16px var(--mono,monospace)}.ccal-day-head span{color:var(--cal-faint);font-size:12px}.ccal-day.today .ccal-day-head{box-shadow:inset 0 -2px var(--cal-teal)}.ccal-day.today .ccal-day-head strong{color:var(--cal-teal)}.ccal-day.outside{opacity:.48}.ccal-day-slots{display:grid;gap:7px;padding:7px}.ccal-empty-day{min-height:74px;display:grid;place-items:center;border:1px dashed var(--cal-line);color:var(--cal-faint);font-size:12px;text-align:center;padding:8px}
  .ccal-slot{position:relative;min-width:0;border:1px solid var(--cal-line2);border-left:3px solid var(--cal-teal);border-radius:7px;background:var(--cal-raised);overflow:hidden}.ccal-slot.locked{border-left-color:var(--cal-amber)}.ccal-slot.attention{border-left-color:var(--cal-red);box-shadow:inset 0 0 0 1px rgba(255,115,107,.2)}.ccal-slot-top{display:flex;align-items:center;justify-content:space-between;gap:7px;padding:8px 9px;border-bottom:1px solid var(--cal-line)}.ccal-channel{display:inline-flex;align-items:center;gap:6px;min-width:0;color:var(--cal-muted);font-size:12px;font-weight:850}.ccal-channel-code{width:23px;height:23px;display:grid;place-items:center;border:1px solid currentColor;border-radius:5px;color:var(--cal-blue);font:900 10px var(--mono,monospace);text-transform:uppercase}.ccal-channel-code.instagram{color:#e38ad9}.ccal-channel-code.facebook{color:#91aeff}.ccal-channel-code.tiktok{color:#74f0e3}.ccal-channel-code.x{color:#e4e9eb}.ccal-channel-code.youtube{color:#ff8179}.ccal-channel-code.google-business{color:#78b5ff}.ccal-channel-code.threads{color:#d2d7d9}.ccal-channel-code.pinterest{color:#ff8b88}.ccal-channel-code.email{color:#e6c477}.ccal-channel-code.webinar{color:#bb92ff}.ccal-time{color:var(--cal-ink);font:900 12px var(--mono,monospace)}.ccal-slot-body{padding:9px}.ccal-slot-state{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:7px}.ccal-chip{display:inline-flex;align-items:center;min-height:22px;border:1px solid var(--cal-line2);border-radius:999px;padding:2px 6px;color:var(--cal-faint);font:800 10px var(--mono,monospace);letter-spacing:.03em;text-transform:uppercase}.ccal-chip.test{border-color:#2d756d;background:var(--cal-teal-soft);color:var(--cal-teal)}.ccal-chip.durable.planned{border-color:#39716b;color:#8fe8dc}.ccal-chip.durable.working{border-color:#675b35;color:var(--cal-amber)}.ccal-chip.durable.complete{border-color:#357a61;color:#89efb9}.ccal-chip.durable.cancelled{border-color:#596369;color:#a8b1b4}.ccal-chip.durable.attention{border-color:#7b3f3b;background:#24100e;color:#ff948d}.ccal-slot h3{margin:0;font-size:12px;line-height:1.4}.ccal-variant{margin:5px 0 0;color:var(--cal-muted);font-size:11px;line-height:1.4}.ccal-social-line{margin:7px 0 0;color:var(--cal-faint);font:800 9px/1.45 var(--mono,monospace)}.ccal-campaign-link{min-height:44px;display:inline-flex;align-items:center;margin-top:6px;color:var(--cal-teal);font-size:10px;font-weight:900}.ccal-campaign-link:focus-visible{outline:3px solid rgba(0,229,204,.3);outline-offset:2px}.ccal-gate{display:flex;align-items:center;gap:6px;margin-top:8px;color:var(--cal-teal);font-size:11px;font-weight:900}.ccal-gate::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}.ccal-slot.locked .ccal-gate{color:var(--cal-amber)}.ccal-slot.attention .ccal-gate{color:var(--cal-red)}.ccal-slot details{border-top:1px solid var(--cal-line)}.ccal-slot summary{min-height:40px;display:flex;align-items:center;justify-content:space-between;gap:7px;list-style:none;padding:0 9px;color:var(--cal-faint);font:800 10px var(--mono,monospace);cursor:pointer;text-transform:uppercase}.ccal-slot summary::-webkit-details-marker{display:none}.ccal-slot summary::after{content:"+";color:var(--cal-teal);font-size:15px}.ccal-slot details[open] summary::after{content:"−"}.ccal-proof{display:grid;gap:6px;padding:0 9px 9px}.ccal-proof-row{display:grid;grid-template-columns:62px minmax(0,1fr);gap:5px;color:var(--cal-muted);font-size:10px;line-height:1.35}.ccal-proof-row span{color:var(--cal-faint)}.ccal-proof-row code{color:var(--cal-ink)}.ccal-proof-note{margin:2px 0 0;color:var(--cal-muted);font-size:10px;line-height:1.45}.ccal-social-proof{display:grid;gap:6px;margin-top:3px;padding-top:8px;border-top:1px dashed var(--cal-line2)}.ccal-social-proof>strong{color:var(--cal-teal);font-size:10px}.ccal-social-proof.attention>strong{color:var(--cal-red)}
  .ccal-slot-move{display:none;grid-template-columns:44px minmax(0,1fr);gap:6px;padding:7px 8px;border-top:1px solid var(--cal-line);background:var(--cal-soft)}.ccal-enhanced .ccal-slot-move{display:grid}.ccal-move-handle,.ccal-move-sheet-button{min-height:44px;border:1px solid var(--cal-line2);border-radius:6px;background:#101619;color:var(--cal-muted);font-size:11px;font-weight:900}.ccal-move-handle{min-width:44px;padding:0;color:var(--cal-teal);font:900 15px var(--mono,monospace);cursor:grab;touch-action:none}.ccal-move-handle[aria-pressed="true"]{cursor:grabbing;background:var(--cal-teal-soft);box-shadow:inset 0 0 0 2px var(--cal-teal)}.ccal-move-sheet-button{padding:0 9px}.ccal-move-handle:focus-visible,.ccal-move-sheet-button:focus-visible,.ccal-sheet-button:focus-visible{outline:3px solid rgba(0,229,204,.3);outline-offset:2px}.ccal-slot[data-preview-moving="true"]{opacity:.76;box-shadow:0 0 0 2px var(--cal-teal)}.ccal-day[data-preview-drop-target="true"]{background:#0a2521;box-shadow:inset 0 0 0 2px var(--cal-teal)}.ccal-local-truth{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:0 12px 12px;padding:10px 12px;border:1px solid #2f6963;background:#071b19;color:var(--cal-muted);font-size:11px;line-height:1.5}.ccal-local-truth strong{color:var(--cal-teal)}.ccal-local-truth span:last-child{color:var(--cal-faint);font:800 10px var(--mono,monospace);white-space:nowrap}.ccal[data-preview-dirty="true"] .ccal-local-truth{border-color:var(--cal-amber)}.ccal[data-preview-dirty="true"] .ccal-local-truth strong{color:var(--cal-amber)}
  .ccal-move-sheet[hidden]{display:none!important}.ccal-move-sheet{position:fixed;z-index:1000;inset:0;display:grid;place-items:end center;padding:18px;background:rgba(0,0,0,.72)}.ccal-move-sheet-panel{width:min(100%,480px);border:1px solid var(--cal-line2);border-radius:13px;background:#101619;box-shadow:0 25px 80px rgba(0,0,0,.55);padding:18px}.ccal-move-sheet-panel h2{margin:0;font-size:18px}.ccal-move-sheet-panel>p{margin:6px 0 15px;color:var(--cal-muted);font-size:12px;line-height:1.5}.ccal-sheet-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.ccal-sheet-grid label{display:grid;gap:6px;color:var(--cal-muted);font-size:11px;font-weight:850}.ccal-sheet-grid input{width:100%;min-height:46px;border:1px solid var(--cal-line2);border-radius:7px;background:#090d0f;color:var(--cal-ink);padding:8px 10px;font:800 12px var(--mono,monospace);color-scheme:dark}.ccal-sheet-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px}.ccal-sheet-button{min-height:46px;border:1px solid var(--cal-line2);border-radius:7px;background:#141b1e;color:var(--cal-muted);font-size:11px;font-weight:900}.ccal-sheet-button.primary{border-color:#337a72;background:#08211e;color:var(--cal-teal)}.ccal-live{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  .ccal-grid.month .ccal-day{min-height:160px}.ccal-grid.month .ccal-day-head{padding:7px 8px}.ccal-grid.month .ccal-day-head span{display:none}.ccal-grid.month .ccal-day-slots{gap:4px;padding:5px}.ccal-grid.month .ccal-slot-top{padding:5px 6px}.ccal-grid.month .ccal-channel span:last-child,.ccal-grid.month .ccal-variant,.ccal-grid.month .ccal-social-line,.ccal-grid.month .ccal-slot details{display:none}.ccal-grid.month .ccal-slot-state .ccal-chip:not(.durable){display:none}.ccal-grid.month .ccal-slot-body{padding:6px}.ccal-grid.month .ccal-slot h3{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2}.ccal-grid.month .ccal-gate{margin-top:5px}.ccal-grid.month .ccal-empty-day{min-height:55px;border:0}.ccal-grid.month .ccal-slot-move{grid-template-columns:44px 1fr;padding:5px}.ccal-grid.month .ccal-move-sheet-button{font-size:10px}
  .ccal-backlog{align-self:start}.ccal-backlog-list{list-style:none;display:grid;gap:0;margin:0;padding:0}.ccal-backlog-item{padding:12px 13px;border-bottom:1px solid var(--cal-line)}.ccal-backlog-item:last-child{border-bottom:0}.ccal-backlog-meta{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:7px}.ccal-backlog h3{margin:0;font-size:13px;line-height:1.4}.ccal-backlog-proof{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:8px}.ccal-backlog-proof span{color:var(--cal-faint);font-size:10px}.ccal-backlog-proof strong{display:block;margin-top:2px;color:var(--cal-muted);font-size:10px}.ccal-backlog-gate{margin:8px 0 0;color:var(--cal-muted);font-size:11px;line-height:1.45}.ccal-sim-action{width:100%;min-height:44px;margin-top:9px;border:1px solid var(--cal-line2);border-radius:6px;background:var(--cal-soft);color:var(--cal-faint);font-size:11px;font-weight:900;cursor:not-allowed}.ccal-empty-backlog{padding:25px 17px;text-align:center;color:var(--cal-muted);font-size:12px;line-height:1.55}.ccal-backlog-note{margin:0;padding:11px 13px;border-top:1px solid var(--cal-line);background:var(--cal-soft);color:var(--cal-faint);font-size:11px;line-height:1.5}
  .ccal-warning{margin:0 12px 12px;border:1px solid #6f5a2c;background:#171308;padding:10px 12px;color:var(--cal-amber);font-size:12px;line-height:1.5}.ccal-footer{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:13px 18px;border-top:1px solid var(--cal-line);background:#080b0d;color:var(--cal-faint);font-size:11px;line-height:1.5}.ccal-footer strong{color:var(--cal-muted)}
  @media(max-width:1040px){.ccal-workspace{grid-template-columns:1fr}.ccal-backlog{grid-row:1}.ccal-backlog-list{grid-template-columns:repeat(2,minmax(0,1fr))}.ccal-backlog-item:nth-child(odd){border-right:1px solid var(--cal-line)}}
  @media(max-width:800px){.ccal-hero{grid-template-columns:1fr;padding:22px 20px}.ccal-safety{grid-template-columns:1fr;padding:11px 20px}.ccal-safety-badge{justify-self:start}.ccal-toolbar{grid-template-columns:1fr auto}.ccal-period{grid-column:1/-1;grid-row:1;max-width:none}.ccal-mode{justify-self:start}.ccal-draft-action{justify-self:end}.ccal-metrics{grid-template-columns:repeat(2,1fr)}.ccal-metric:nth-child(2){border-right:0}.ccal-metric:nth-child(n+3){border-top:1px solid var(--cal-line)}.ccal-workspace{padding:8px}.ccal-footer{flex-direction:column}.ccal-backlog-list{grid-template-columns:1fr}.ccal-backlog-item:nth-child(odd){border-right:0}}
  @media(max-width:520px){.ccal-hero h1{font-size:2.45rem}.ccal-toolbar{grid-template-columns:1fr}.ccal-mode,.ccal-draft-action{width:100%;justify-self:stretch}.ccal-mode a{flex:1}.ccal-draft-action{grid-row:3}.ccal-metrics{grid-template-columns:1fr}.ccal-metric,.ccal-metric:nth-child(2){border-right:0}.ccal-metric:nth-child(n+2){border-top:1px solid var(--cal-line)}.ccal-section-head{flex-direction:column}.ccal-weekdays,.ccal-grid{grid-template-columns:repeat(7,minmax(145px,1fr));min-width:1015px}.ccal-local-truth{align-items:flex-start;flex-direction:column}.ccal-local-truth span:last-child{white-space:normal}.ccal-sheet-grid,.ccal-sheet-actions{grid-template-columns:1fr}.ccal-move-sheet{padding:8px}.ccal-footer{gap:7px}}
  @media(forced-colors:active){.ccal,.ccal-slot,.ccal-calendar,.ccal-backlog,.ccal-test-card,.ccal-chip,.ccal-channel-code,.ccal-move-sheet-panel{forced-color-adjust:auto}.ccal-slot{border-left-width:5px}.ccal-draft-action,.ccal-sim-action,.ccal-move-handle,.ccal-move-sheet-button{border:2px solid GrayText}.ccal-day[data-preview-drop-target="true"]{outline:4px solid Highlight}}
  @media(prefers-reduced-motion:reduce){.ccal *{scroll-behavior:auto!important;transition:none!important}}
`;

function safeCount(value: number): string {
  return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-GB') : '0';
}

function isoTime(value: string | null, fallback = 'Not recorded'): string {
  if (!value) return escapeHtml(fallback);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return escapeHtml(fallback);
  const label = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
  }).format(date);
  return `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(label)} UTC</time>`;
}

function plannerHref(view: ContentCalendarView, input: Readonly<{
  mode?: ContentCalendarMode;
  date?: string;
  channel?: ContentCalendarChannelFilter;
}>): string {
  const mode = input.mode ?? view.filters.mode;
  const date = input.date ?? view.filters.date;
  const channel = input.channel ?? view.filters.channel;
  return `${CONTENT_CALENDAR_ROUTE}?mode=${encodeURIComponent(mode)}&amp;date=${encodeURIComponent(date)}&amp;channel=${encodeURIComponent(channel)}`;
}

function publicSocialProof(slot: ContentCalendarSlotView): string {
  const social = slot.publicSocial;
  if (!social) return '';
  return `<div class="ccal-social-proof${social.attention ? ' attention' : ''}"><strong>Durable public-social TEST provenance</strong><div class="ccal-proof-row"><span>Campaign</span><span>${escapeHtml(social.campaignTitle)} · r${safeCount(social.revisionNumber)} · <code>${escapeHtml(social.campaignShortId)}/${escapeHtml(social.revisionShortId)}</code></span></div><div class="ccal-proof-row"><span>Post</span><code>${escapeHtml(social.postShortId)}…</code></div><div class="ccal-proof-row"><span>Operation</span><code>${escapeHtml(social.operationShortId)}…</code></div><div class="ccal-proof-row"><span>Target</span><span>${escapeHtml(social.targetLabel)} · <code>${escapeHtml(social.targetShortId)}…</code></span></div><div class="ccal-proof-row"><span>Plan hash</span><code>${escapeHtml(social.planShortHash)}…</code></div><div class="ccal-proof-row"><span>Simulation attempts</span><span>${safeCount(social.simulationAttemptCount)} / ${safeCount(social.maxSimulationAttempts)}</span></div><div class="ccal-proof-row"><span>Reconciliation attempts</span><span>${safeCount(social.reconciliationAttemptCount)} / ${safeCount(social.maxReconciliationAttempts)}</span></div><div class="ccal-proof-row"><span>Updated</span><span>${isoTime(social.updatedAt)}</span></div><p class="ccal-proof-note"><strong>${escapeHtml(social.stateLabel)}.</strong> ${escapeHtml(social.stateDetail)}</p><p class="ccal-proof-note">Environment ${escapeHtml(social.environment)} · provider effects ${escapeHtml(social.providerEffects)} · identity proof ${social.identityProofValid ? 'exact' : 'locked'}.</p></div>`;
}

function campaignHref(slot: ContentCalendarSlotView, filters: ContentCalendarFiltersView): string {
  const campaignId = slot.publicSocial?.campaignId ?? '';
  return `${PUBLIC_SOCIAL_CAMPAIGNS_ROUTE}?campaign=${encodeURIComponent(campaignId)}`
    + `&calendar_mode=${encodeURIComponent(filters.mode)}`
    + `&calendar_date=${encodeURIComponent(filters.date)}`
    + `&calendar_channel=${encodeURIComponent(filters.channel)}`;
}

function slotCard(slot: ContentCalendarSlotView, filters: ContentCalendarFiltersView): string {
  const stateClass = slot.publicSocial?.attention
    ? 'locked attention'
    : slot.simulationEligible ? 'ready' : 'locked';
  const helpId = `${slot.anchorId}-move-help`;
  return `<article class="ccal-slot ${stateClass}" id="${escapeHtml(slot.anchorId)}" aria-labelledby="${escapeHtml(slot.anchorId)}-title" data-calendar-slot data-slot-id="${escapeHtml(slot.slotId)}" data-scheduled-for="${escapeHtml(slot.scheduledFor)}">
    <header class="ccal-slot-top"><span class="ccal-channel"><span class="ccal-channel-code ${CHANNEL_CLASS[slot.channel]}" aria-hidden="true">${escapeHtml(slot.channelCode)}</span><span>${escapeHtml(slot.channelLabel)}</span></span><time class="ccal-time" datetime="${escapeHtml(slot.scheduledFor)}">${escapeHtml(slot.timeLabel)}</time></header>
    <div class="ccal-slot-body"><div class="ccal-slot-state"><span class="ccal-chip test">TEST · ${escapeHtml(slot.plannerStateLabel)}</span>${slot.versionNumber === null ? '' : `<span class="ccal-chip">Immutable v${safeCount(slot.versionNumber)}</span>`}${slot.publicSocial ? `<span class="ccal-chip durable ${escapeHtml(slot.publicSocial.stateTone)}"${slot.publicSocial.attention ? ' role="status"' : ''}>${escapeHtml(slot.publicSocial.stateLabel)}</span>` : ''}</div><h3 id="${escapeHtml(slot.anchorId)}-title">${escapeHtml(slot.title)}</h3><p class="ccal-variant">${escapeHtml(slot.variantLabel)}</p>${slot.publicSocial ? `<p class="ccal-social-line">${escapeHtml(slot.publicSocial.campaignTitle)} · revision ${safeCount(slot.publicSocial.revisionNumber)} · ${escapeHtml(slot.publicSocial.targetLabel)}</p><a class="ccal-campaign-link" href="${escapeHtml(campaignHref(slot, filters))}" aria-label="Open exact campaign ${escapeHtml(slot.publicSocial.campaignTitle)} for ${escapeHtml(slot.publicSocial.targetLabel)}">Open exact campaign →</a>` : ''}<span class="ccal-gate">${escapeHtml(slot.gateLabel)}</span></div>
    <div class="ccal-slot-move"><button class="ccal-move-handle" type="button" aria-pressed="false" aria-describedby="${escapeHtml(helpId)}" data-calendar-move-handle>⋮⋮<span class="ccal-visually-hidden">Move ${escapeHtml(slot.title)} in this browser-only TEST preview</span></button><button class="ccal-move-sheet-button" type="button" data-calendar-sheet-open>Choose date &amp; time</button><p class="ccal-visually-hidden" id="${escapeHtml(helpId)}">Drag with mouse or touch. With a keyboard, press Space, use Left and Right for the day and Up and Down for 30-minute time steps, then press Space again. Movement is not saved.</p></div>
    <details><summary>Planning proof</summary><div class="ccal-proof"><div class="ccal-proof-row"><span>Version</span><code>${escapeHtml(slot.contentVersionId)}</code></div><div class="ccal-proof-row"><span>Hash</span><code>${escapeHtml(slot.shortHash)}…</code></div><div class="ccal-proof-row"><span>Approval</span><strong>${escapeHtml(slot.approvalLabel)}</strong></div><div class="ccal-proof-row"><span>Source</span><strong>${escapeHtml(slot.sourceFreshnessLabel)}</strong></div><div class="ccal-proof-row"><span>Owner</span><strong>${escapeHtml(slot.ownerLabel)}</strong></div><div class="ccal-proof-row"><span>Goal</span><strong>${escapeHtml(slot.objectiveLabel)}</strong></div>${publicSocialProof(slot)}<p class="ccal-proof-note">${escapeHtml(slot.gateDetail)}</p><p class="ccal-proof-note"><strong>Draft/simulated only.</strong> This planner cannot call ${escapeHtml(slot.channelLabel)} or any provider.</p></div></details>
  </article>`;
}

function dayColumn(
  day: ContentCalendarDayView,
  mode: ContentCalendarMode,
  filters: ContentCalendarFiltersView,
): string {
  const slots = day.slots.map((slot) => slotCard(slot, filters)).join('');
  return `<section class="ccal-day${day.isToday ? ' today' : ''}${day.inPrimaryPeriod ? '' : ' outside'}" aria-label="${escapeHtml(day.fullDateLabel)}" data-calendar-day data-date="${escapeHtml(day.date)}"><header class="ccal-day-head"><strong>${escapeHtml(day.dayNumber)}</strong><span>${day.isToday ? 'Today · TEST' : escapeHtml(day.weekdayLabel)}</span></header><div class="ccal-day-slots">${slots || `<div class="ccal-empty-day"><span>${mode === 'month' ? '—' : 'No TEST plans'}</span></div>`}</div></section>`;
}

function backlogItem(item: ContentCalendarBacklogItemView): string {
  return `<li class="ccal-backlog-item"><article><div class="ccal-backlog-meta"><span class="ccal-chip">${escapeHtml(item.kindLabel)}</span><span class="ccal-chip">Immutable v${safeCount(item.versionNumber)}</span><span class="ccal-chip ${item.simulationEligible ? 'test' : ''}">${item.simulationEligible ? 'Simulation eligible' : 'Locked'}</span></div><h3>${escapeHtml(item.title)}</h3><div class="ccal-backlog-proof"><span>Exact hash<strong>${escapeHtml(item.shortHash)}…</strong></span><span>Approval<strong>${escapeHtml(item.approvalLabel)}</strong></span><span>Source<strong>${escapeHtml(item.sourceFreshnessLabel)}</strong></span><span>Provider<strong>None connected</strong></span></div><p class="ccal-backlog-gate">${escapeHtml(item.gateDetail)}</p><button class="ccal-sim-action" type="button" disabled aria-disabled="true">Create TEST draft slot · simulator only</button></article></li>`;
}

function backlog(view: ContentCalendarView): string {
  const items = view.backlog.map(backlogItem).join('');
  return `<aside class="ccal-backlog" aria-labelledby="ccal-backlog-title"><header class="ccal-section-head"><div><h2 id="ccal-backlog-title">Ready room</h2><p>Owned versions not placed on this planner.</p></div><span class="ccal-count">${safeCount(view.backlog.length)}</span></header>${items ? `<ol class="ccal-backlog-list">${items}</ol>` : '<div class="ccal-empty-backlog" role="status"><strong>No unplanned catalogue items in this bounded snapshot.</strong><br>Nothing new has been generated.</div>'}<p class="ccal-backlog-note"><strong>Presentation control only.</strong> Disabled controls show the intended workflow without creating slots, provider jobs or outbound effects.</p></aside>`;
}

function modeNav(view: ContentCalendarView): string {
  return `<nav class="ccal-mode" aria-label="Calendar view"><a href="${plannerHref(view, { mode: 'week' })}"${view.filters.mode === 'week' ? ' class="active" aria-current="page"' : ''}>Week</a><a href="${plannerHref(view, { mode: 'month' })}"${view.filters.mode === 'month' ? ' class="active" aria-current="page"' : ''}>Month</a></nav>`;
}

function channelNav(view: ContentCalendarView): string {
  const links = CHANNELS.map((channel) => `<a href="${plannerHref(view, { channel: channel.value })}"${view.filters.channel === channel.value ? ' class="active" aria-current="page"' : ''}>${escapeHtml(channel.label)}</a>`).join('');
  return `<nav class="ccal-channelbar" aria-label="Filter planner by channel">${links}</nav>`;
}

export interface RenderContentCalendarOptions {
  readonly companyAssetsAvailable?: boolean;
  readonly assetsLabel?: string;
  readonly brandBrainAvailable?: boolean;
  readonly brainLabel?: string;
}

export function renderContentCalendarBody(
  view: ContentCalendarView,
  options: RenderContentCalendarOptions = {},
): string {
  const weekdays = view.days.slice(0, 7).map((day) => `<div class="ccal-weekday">${escapeHtml(day.weekdayLabel)}</div>`).join('');
  const days = view.days.map((day) => dayColumn(day, view.filters.mode, view.filters)).join('');
  const warning = view.hasUnknownVersion
    ? '<p class="ccal-warning" role="alert"><strong>Fail-closed planner:</strong> at least one draft slot points to an unavailable or mismatched immutable version. It remains locked.</p>'
    : '';
  const bounded = view.sourceTruncated
    ? ' The database proved that additional complete public-social post aggregates exist beyond this loaded view.'
    : view.inputTruncated
      ? ' Bounded safety limits were applied to the supplied catalogue or draft slots.'
    : '';
  const loaded = view.inputTruncated ? 'Loaded ' : '';
  const firstDate = view.days[0]?.date ?? view.filters.date;
  const lastDate = view.days[view.days.length - 1]?.date ?? view.filters.date;
  return `${renderContentWorkspaceNavigation('calendar', {
    companyAssetsAvailable: options.companyAssetsAvailable,
    assetsLabel: options.assetsLabel,
    brandBrainAvailable: options.brandBrainAvailable ?? false,
    brainLabel: options.brainLabel,
  })}<style data-property-predator-content-calendar>${CONTENT_CALENDAR_STYLE}</style><article class="ccal" aria-labelledby="ccal-title" data-provider-effects="none" data-content-calendar data-calendar-mode="${escapeHtml(view.filters.mode)}" data-calendar-timezone="${escapeHtml(view.timezone)}" data-source-truncated="${view.sourceTruncated ? 'true' : 'false'}" data-preview-dirty="false">
    <header class="ccal-hero"><div><div class="ccal-kicker">Growth HQ · Campaign command</div><h1 id="ccal-title">Own the week. <em>Control the signal.</em></h1><p>Turn approved Property Predator assets into a calm, channel-aware campaign rhythm. Every placement remains tied to one exact immutable version, with the approval and source proof visible before any future outbound rail can exist.</p></div><aside class="ccal-test-card" aria-label="Planner safety mode"><strong>TEST planner · zero delivery</strong><span>${escapeHtml(view.workspaceName)}</span><small>${escapeHtml(view.timezone)} planning label · snapshot ${isoTime(view.asOf)}. No social, email or webinar provider is connected by this view.</small></aside></header>
    <section class="ccal-safety" aria-label="Planner truth boundary"><span class="ccal-safety-mark">Truth boundary</span><p><strong>A slot is not a scheduled provider job.</strong> “Simulation ready” means only that exact version, approval and source provenance agree. Durable TEST execution currently requires source proof still valid at the rehearsal time; long-dated scheduling remains locked pending audited just-in-time re-attestation.</p><span class="ccal-safety-badge">No provider calls</span></section>
    <div class="ccal-toolbar">${modeNav(view)}<div class="ccal-period"><a href="${plannerHref(view, { date: view.previousDate })}" aria-label="Previous ${escapeHtml(view.filters.mode)}">‹</a><div class="ccal-period-title"><strong>${escapeHtml(view.periodLabel)}</strong><span>${escapeHtml(view.timezone)} · display snapshot</span></div><a href="${plannerHref(view, { date: view.nextDate })}" aria-label="Next ${escapeHtml(view.filters.mode)}">›</a></div><button class="ccal-draft-action" type="button" disabled aria-disabled="true">+ New TEST draft slot · disabled</button></div>
    ${channelNav(view)}
    <section class="ccal-metrics" aria-label="${loaded}planner summary"><div class="ccal-metric"><small>${loaded}draft placements</small><strong>${safeCount(view.metrics.plannedSlots)}</strong><span>No provider jobs created</span></div><div class="ccal-metric ready"><small>${loaded}simulation ready</small><strong>${safeCount(view.metrics.simulationReady)}</strong><span>Exact gates agree</span></div><div class="ccal-metric blocked"><small>${loaded}gate locked</small><strong>${safeCount(view.metrics.blocked)}</strong><span>Fails closed before outbound</span></div><div class="ccal-metric"><small>${loaded}active rails</small><strong>${safeCount(view.metrics.activeChannels)}</strong><span>Planning variants only</span></div></section>
    <div class="ccal-workspace"><section class="ccal-calendar" aria-labelledby="ccal-calendar-title"><header class="ccal-section-head"><div><h2 id="ccal-calendar-title">${view.filters.mode === 'week' ? 'Weekly signal board' : 'Monthly campaign map'}</h2><p>Channel placements around approved company content. Scroll sideways on compact screens.</p></div><span class="ccal-count">${view.inputTruncated ? 'Loaded ' : ''}${safeCount(view.visibleSlotCount)} TEST plan${view.visibleSlotCount === 1 ? '' : 's'}</span></header><div class="ccal-scroll" tabindex="0" aria-label="Scrollable ${escapeHtml(view.filters.mode)} content calendar"><div class="ccal-weekdays" aria-hidden="true">${weekdays}</div><div class="ccal-grid ${escapeHtml(view.filters.mode)}">${days}</div></div></section>${backlog(view)}</div>
    <aside class="ccal-local-truth" role="status"><span><strong>Browser-only movement.</strong> Drag, use the keyboard handle or choose a date and time to rehearse the rhythm. Nothing is saved; reloading restores this exact snapshot.</span><span>TEST plan · zero external effects</span></aside>
    ${warning}
    <div class="ccal-move-sheet" data-calendar-move-sheet role="dialog" aria-modal="true" aria-labelledby="ccal-move-sheet-title" hidden><section class="ccal-move-sheet-panel"><h2 id="ccal-move-sheet-title">Move TEST plan</h2><p>Choose a date visible in this loaded calendar and a time. This changes the browser preview only and is discarded on reload.</p><div class="ccal-sheet-grid"><label>Date<input type="date" min="${escapeHtml(firstDate)}" max="${escapeHtml(lastDate)}" data-calendar-sheet-date></label><label>Time<input type="time" step="1800" data-calendar-sheet-time></label></div><div class="ccal-sheet-actions"><button class="ccal-sheet-button" type="button" data-calendar-sheet-cancel>Cancel</button><button class="ccal-sheet-button primary" type="button" data-calendar-sheet-apply>Move in preview</button></div></section></div>
    <div class="ccal-live" data-calendar-live role="status" aria-live="polite" aria-atomic="true"></div>
    <footer class="ccal-footer"><span><strong>Draft/simulated throughout:</strong> no posts, messages, webinar registrations or provider schedules are created here.${escapeHtml(bounded)}</span><span>${safeCount(view.catalogCount)} owned catalogue versions inspected · generated output: 0</span></footer>
  </article><script src="${CONTENT_CALENDAR_CLIENT_ROUTE}" defer></script>`;
}
