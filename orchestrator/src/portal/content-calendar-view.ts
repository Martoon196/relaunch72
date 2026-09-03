/**
 * Server-rendered TEST content planner. Protected command routes are injected
 * explicitly; without them the surface remains read-only. No provider adapter
 * or credential is reachable from this view.
 */

import { escapeHtml } from './ui.js';
import { CONTENT_CALENDAR_CLIENT_ROUTE } from './content-calendar-client.js';
import { renderContentWorkspaceNavigation } from './content-workspace-navigation.js';
import { PUBLIC_SOCIAL_CAMPAIGNS_ROUTE } from './public-social-campaigns-presenter.js';
import { CAMPAIGN_WIZARD_ROUTE } from './campaign-wizard-actions.js';
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ContentCalendarChoiceView {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
}

export interface ContentCalendarCommandActionView {
  readonly actionUrl: string;
  readonly csrfToken: string;
  readonly commandKey: string;
}

export interface ContentCalendarCreateActionView extends ContentCalendarCommandActionView {
  /** One opaque, server-validated campaign/revision selector value. */
  readonly campaignRevisions: readonly ContentCalendarChoiceView[];
  readonly contentVersions: readonly ContentCalendarChoiceView[];
  readonly targets: readonly ContentCalendarChoiceView[];
}

export interface ContentCalendarSlotActionView {
  readonly intentId: string;
  readonly targetId: string;
  readonly intentSha256?: string;
  readonly expectedUpdatedAt?: string;
  readonly reschedule?: ContentCalendarCommandActionView;
  readonly cancel?: ContentCalendarCommandActionView;
  readonly jitStatus?: Readonly<{
    state: 'current' | 'due' | 'blocked' | 'complete' | 'cancelled';
    label: string;
    detail: string;
    nextRevalidationAt: string | null;
  }>;
}

export interface ContentCalendarOperationOutcomeView {
  readonly kind: 'success' | 'info' | 'error';
  readonly title: string;
  readonly detail: string;
  readonly intentId?: string;
  readonly targetId?: string;
  /** Optional same-origin GET projection for one fresh status read. */
  readonly statusUrl?: string;
}

export interface ContentCalendarMutationView {
  readonly create?: ContentCalendarCreateActionView;
  readonly slots?: Readonly<Record<string, ContentCalendarSlotActionView>>;
  readonly outcome?: ContentCalendarOperationOutcomeView;
}

export interface ContentCalendarLiveScheduleView {
  readonly scheduleId: string;
  readonly content: string;
  readonly scheduledFor: string;
  readonly state: 'reserved' | 'scheduled' | 'failed' | 'outcome_unknown' | 'cancelled';
}

export interface ContentCalendarLiveSchedulerView extends ContentCalendarCommandActionView {
  readonly mediaUploadUrl: string;
  readonly mediaCommandKey: string;
  readonly items: readonly ContentCalendarLiveScheduleView[];
}

const CONTENT_CALENDAR_STYLE = `
  .ccal{--cal-bg:#07090b;--cal-panel:#0d1114;--cal-raised:#12181c;--cal-soft:#090c0e;--cal-line:#263238;--cal-line2:#39474e;--cal-ink:#f2f6f5;--cal-muted:#a6b2b5;--cal-faint:#75868b;--cal-teal:#00e5cc;--cal-teal-soft:#062b26;--cal-amber:#f4ba4c;--cal-red:#ff736b;--cal-blue:#77a8ff;min-width:0;overflow:hidden;border:1px solid #020304;background:var(--cal-bg);color:var(--cal-ink);font-family:var(--sans,ui-sans-serif,system-ui,sans-serif)}
  .ccal *{box-sizing:border-box}.ccal h1,.ccal h2,.ccal h3,.ccal p{margin-top:0}.ccal a{text-decoration:none}.ccal button{font:inherit}.ccal code{font-family:var(--mono,ui-monospace,monospace);overflow-wrap:anywhere}.ccal-visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
  .ccal-hero{position:relative;display:grid;grid-template-columns:minmax(0,1fr) minmax(255px,335px);gap:28px;align-items:end;padding:28px 30px 25px;border-bottom:1px solid var(--cal-line);background:radial-gradient(circle at 79% -15%,rgba(0,229,204,.17),transparent 34%),linear-gradient(135deg,#12191c,#080a0c 67%);overflow:hidden}.ccal-hero::before{content:"";position:absolute;width:260px;height:260px;right:18%;top:-190px;border:1px solid rgba(0,229,204,.19);transform:rotate(45deg)}.ccal-kicker{position:relative;color:var(--cal-teal);font:850 12px/1.2 var(--mono,monospace);letter-spacing:.14em;text-transform:uppercase}.ccal-hero h1{position:relative;margin:9px 0 9px;font-family:var(--display,var(--sans));font-size:clamp(2.3rem,4.6vw,4.8rem);font-weight:600;line-height:.91;letter-spacing:-.05em}.ccal-hero h1 em{color:var(--cal-teal);font-style:normal}.ccal-hero p{position:relative;max-width:790px;margin:0;color:var(--cal-muted);font-size:14px;line-height:1.65}.ccal-test-card{position:relative;border:1px solid #36756e;background:rgba(3,17,16,.74);padding:15px}.ccal-test-card strong{display:block;color:var(--cal-teal);font:900 13px var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase}.ccal-test-card span{display:block;margin:8px 0 5px;font-size:14px;font-weight:800}.ccal-test-card small{display:block;color:var(--cal-muted);font-size:12px;line-height:1.5}
  .ccal-safety{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:13px;align-items:center;padding:11px 30px;border-bottom:1px solid var(--cal-line);background:#090d0f}.ccal-safety-mark{color:var(--cal-teal);font:900 12px var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase}.ccal-safety p{margin:0;color:var(--cal-muted);font-size:12px;line-height:1.5}.ccal-safety p strong{color:var(--cal-ink)}.ccal-safety-badge{border:1px solid var(--cal-line2);padding:5px 8px;color:var(--cal-faint);font:850 12px var(--mono,monospace);letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
  .ccal-toolbar{display:grid;grid-template-columns:auto minmax(230px,1fr) auto;gap:13px;align-items:center;padding:14px 18px;border-bottom:1px solid var(--cal-line);background:var(--cal-panel)}.ccal-mode{display:flex;padding:3px;border:1px solid var(--cal-line2);border-radius:8px;background:var(--cal-soft)}.ccal-mode a{min-height:40px;display:grid;place-items:center;border-radius:5px;padding:0 14px;color:var(--cal-muted);font-size:12px;font-weight:900}.ccal-mode a.active{background:var(--cal-teal);color:#02110f}.ccal-period{display:grid;grid-template-columns:44px minmax(0,1fr) 44px;align-items:center;max-width:460px;justify-self:center;width:100%}.ccal-period>a{width:44px;height:44px;display:grid;place-items:center;border:1px solid var(--cal-line2);border-radius:7px;color:var(--cal-ink);font-size:19px}.ccal-period-title{text-align:center}.ccal-period-title strong{display:block;font-size:15px}.ccal-period-title span{display:block;margin-top:3px;color:var(--cal-faint);font:750 12px var(--mono,monospace)}.ccal-draft-action{min-height:44px;display:inline-flex;align-items:center;justify-content:center;border:1px solid #355d59;border-radius:7px;background:#0a211e;color:var(--cal-teal);padding:0 14px;font-size:12px;font-weight:900;cursor:pointer;text-decoration:none}.ccal-draft-action[disabled]{cursor:not-allowed;opacity:.76}.ccal-channelbar{display:flex;gap:7px;overflow-x:auto;padding:10px 18px;border-bottom:1px solid var(--cal-line);background:#0a0e10;scrollbar-width:thin}.ccal-channelbar a{min-height:40px;display:inline-flex;align-items:center;border:1px solid var(--cal-line2);border-radius:999px;padding:0 13px;color:var(--cal-muted);font-size:12px;font-weight:850;white-space:nowrap}.ccal-channelbar a.active{border-color:#2d897e;background:var(--cal-teal-soft);color:var(--cal-teal)}
  .ccal-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-bottom:1px solid var(--cal-line);background:var(--cal-panel)}.ccal-metric{min-width:0;padding:14px 18px;border-right:1px solid var(--cal-line)}.ccal-metric:last-child{border-right:0}.ccal-metric small{display:block;color:var(--cal-faint);font:800 12px var(--mono,monospace);letter-spacing:.06em;text-transform:uppercase}.ccal-metric strong{display:block;margin:6px 0 3px;font:900 22px/1 var(--mono,monospace)}.ccal-metric span{color:var(--cal-muted);font-size:12px}.ccal-metric.ready strong{color:var(--cal-teal)}.ccal-metric.blocked strong{color:var(--cal-amber)}
  .ccal-workspace{display:grid;grid-template-columns:minmax(0,1fr) minmax(285px,330px);gap:12px;padding:12px}.ccal-calendar,.ccal-backlog{min-width:0;border:1px solid var(--cal-line);background:var(--cal-panel)}.ccal-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:14px 16px;border-bottom:1px solid var(--cal-line)}.ccal-section-head h2{margin:0;font-size:15px}.ccal-section-head p{margin:4px 0 0;color:var(--cal-muted);font-size:12px;line-height:1.45}.ccal-count{border:1px solid var(--cal-line2);padding:4px 8px;color:var(--cal-muted);font:850 12px var(--mono,monospace);white-space:nowrap}
  .ccal-scroll{max-width:100%;overflow-x:auto;scrollbar-color:var(--cal-line2) var(--cal-soft)}.ccal-weekdays{display:grid;grid-template-columns:repeat(7,minmax(155px,1fr));min-width:1085px;border-bottom:1px solid var(--cal-line);background:var(--cal-soft)}.ccal-weekday{padding:8px 10px;border-right:1px solid var(--cal-line);color:var(--cal-faint);font:800 12px var(--mono,monospace);letter-spacing:.06em;text-transform:uppercase}.ccal-weekday:last-child{border-right:0}.ccal-grid{display:grid;grid-template-columns:repeat(7,minmax(155px,1fr));min-width:1085px}.ccal-day{min-width:0;min-height:410px;border-right:1px solid var(--cal-line);background:#0c1012}.ccal-day:last-child{border-right:0}.ccal-day-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px;border-bottom:1px solid var(--cal-line)}.ccal-day-head strong{font:900 16px var(--mono,monospace)}.ccal-day-head span{color:var(--cal-faint);font-size:12px}.ccal-day.today .ccal-day-head{box-shadow:inset 0 -2px var(--cal-teal)}.ccal-day.today .ccal-day-head strong{color:var(--cal-teal)}.ccal-day.outside{opacity:.48}.ccal-day-slots{display:grid;gap:7px;padding:7px}.ccal-empty-day{min-height:74px;display:grid;place-items:center;border:1px dashed var(--cal-line);color:var(--cal-faint);font-size:12px;text-align:center;padding:8px}
  .ccal-slot{position:relative;min-width:0;border:1px solid var(--cal-line2);border-left:3px solid var(--cal-teal);border-radius:7px;background:var(--cal-raised);overflow:hidden}.ccal-slot.locked{border-left-color:var(--cal-amber)}.ccal-slot.attention{border-left-color:var(--cal-red);box-shadow:inset 0 0 0 1px rgba(255,115,107,.2)}.ccal-slot-top{display:flex;align-items:center;justify-content:space-between;gap:7px;padding:8px 9px;border-bottom:1px solid var(--cal-line)}.ccal-channel{display:inline-flex;align-items:center;gap:6px;min-width:0;color:var(--cal-muted);font-size:12px;font-weight:850}.ccal-channel-code{width:23px;height:23px;display:grid;place-items:center;border:1px solid currentColor;border-radius:5px;color:var(--cal-blue);font:900 10px var(--mono,monospace);text-transform:uppercase}.ccal-channel-code.instagram{color:#e38ad9}.ccal-channel-code.facebook{color:#91aeff}.ccal-channel-code.tiktok{color:#74f0e3}.ccal-channel-code.x{color:#e4e9eb}.ccal-channel-code.youtube{color:#ff8179}.ccal-channel-code.google-business{color:#78b5ff}.ccal-channel-code.threads{color:#d2d7d9}.ccal-channel-code.pinterest{color:#ff8b88}.ccal-channel-code.email{color:#e6c477}.ccal-channel-code.webinar{color:#bb92ff}.ccal-time{color:var(--cal-ink);font:900 12px var(--mono,monospace)}.ccal-slot-body{padding:9px}.ccal-slot-state{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:7px}.ccal-chip{display:inline-flex;align-items:center;min-height:22px;border:1px solid var(--cal-line2);border-radius:999px;padding:2px 6px;color:var(--cal-faint);font:800 10px var(--mono,monospace);letter-spacing:.03em;text-transform:uppercase}.ccal-chip.test{border-color:#2d756d;background:var(--cal-teal-soft);color:var(--cal-teal)}.ccal-chip.durable.planned{border-color:#39716b;color:#8fe8dc}.ccal-chip.durable.working{border-color:#675b35;color:var(--cal-amber)}.ccal-chip.durable.complete{border-color:#357a61;color:#89efb9}.ccal-chip.durable.cancelled{border-color:#596369;color:#a8b1b4}.ccal-chip.durable.attention{border-color:#7b3f3b;background:#24100e;color:#ff948d}.ccal-slot h3{margin:0;font-size:12px;line-height:1.4}.ccal-variant{margin:5px 0 0;color:var(--cal-muted);font-size:11px;line-height:1.4}.ccal-social-line{margin:7px 0 0;color:var(--cal-faint);font:800 9px/1.45 var(--mono,monospace)}.ccal-campaign-link{min-height:44px;display:inline-flex;align-items:center;margin-top:6px;color:var(--cal-teal);font-size:10px;font-weight:900}.ccal-campaign-link:focus-visible{outline:3px solid rgba(0,229,204,.3);outline-offset:2px}.ccal-gate{display:flex;align-items:center;gap:6px;margin-top:8px;color:var(--cal-teal);font-size:11px;font-weight:900}.ccal-gate::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}.ccal-slot.locked .ccal-gate{color:var(--cal-amber)}.ccal-slot.attention .ccal-gate{color:var(--cal-red)}.ccal-slot details{border-top:1px solid var(--cal-line)}.ccal-slot summary{min-height:40px;display:flex;align-items:center;justify-content:space-between;gap:7px;list-style:none;padding:0 9px;color:var(--cal-faint);font:800 10px var(--mono,monospace);cursor:pointer;text-transform:uppercase}.ccal-slot summary::-webkit-details-marker{display:none}.ccal-slot summary::after{content:"+";color:var(--cal-teal);font-size:15px}.ccal-slot details[open] summary::after{content:"−"}.ccal-proof{display:grid;gap:6px;padding:0 9px 9px}.ccal-proof-row{display:grid;grid-template-columns:62px minmax(0,1fr);gap:5px;color:var(--cal-muted);font-size:10px;line-height:1.35}.ccal-proof-row span{color:var(--cal-faint)}.ccal-proof-row code{color:var(--cal-ink)}.ccal-proof-note{margin:2px 0 0;color:var(--cal-muted);font-size:10px;line-height:1.45}.ccal-social-proof{display:grid;gap:6px;margin-top:3px;padding-top:8px;border-top:1px dashed var(--cal-line2)}.ccal-social-proof>strong{color:var(--cal-teal);font-size:10px}.ccal-social-proof.attention>strong{color:var(--cal-red)}
  .ccal-slot-move{display:none;grid-template-columns:44px minmax(0,1fr);gap:6px;padding:7px 8px;border-top:1px solid var(--cal-line);background:var(--cal-soft)}.ccal-enhanced .ccal-slot-move{display:grid}.ccal-move-handle,.ccal-move-sheet-button{min-height:44px;border:1px solid var(--cal-line2);border-radius:6px;background:#101619;color:var(--cal-muted);font-size:11px;font-weight:900}.ccal-move-handle{min-width:44px;padding:0;color:var(--cal-teal);font:900 15px var(--mono,monospace);cursor:grab;touch-action:none}.ccal-move-handle[aria-pressed="true"]{cursor:grabbing;background:var(--cal-teal-soft);box-shadow:inset 0 0 0 2px var(--cal-teal)}.ccal-move-sheet-button{padding:0 9px}.ccal-move-handle:focus-visible,.ccal-move-sheet-button:focus-visible,.ccal-sheet-button:focus-visible{outline:3px solid rgba(0,229,204,.3);outline-offset:2px}.ccal-slot[data-preview-moving="true"]{opacity:.76;box-shadow:0 0 0 2px var(--cal-teal)}.ccal-day[data-preview-drop-target="true"]{background:#0a2521;box-shadow:inset 0 0 0 2px var(--cal-teal)}.ccal-local-truth{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:0 12px 12px;padding:10px 12px;border:1px solid #2f6963;background:#071b19;color:var(--cal-muted);font-size:11px;line-height:1.5}.ccal-local-truth strong{color:var(--cal-teal)}.ccal-local-truth span:last-child{color:var(--cal-faint);font:800 10px var(--mono,monospace);white-space:nowrap}.ccal[data-preview-dirty="true"] .ccal-local-truth{border-color:var(--cal-amber)}.ccal[data-preview-dirty="true"] .ccal-local-truth strong{color:var(--cal-amber)}
  .ccal-move-sheet[hidden]{display:none!important}.ccal-move-sheet{position:fixed;z-index:1000;inset:0;display:grid;place-items:end center;padding:18px;background:rgba(0,0,0,.72)}.ccal-move-sheet-panel{width:min(100%,480px);border:1px solid var(--cal-line2);border-radius:13px;background:#101619;box-shadow:0 25px 80px rgba(0,0,0,.55);padding:18px}.ccal-move-sheet-panel h2{margin:0;font-size:18px}.ccal-move-sheet-panel>p{margin:6px 0 15px;color:var(--cal-muted);font-size:12px;line-height:1.5}.ccal-sheet-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.ccal-sheet-grid label{display:grid;gap:6px;color:var(--cal-muted);font-size:11px;font-weight:850}.ccal-sheet-grid input{width:100%;min-height:46px;border:1px solid var(--cal-line2);border-radius:7px;background:#090d0f;color:var(--cal-ink);padding:8px 10px;font:800 12px var(--mono,monospace);color-scheme:dark}.ccal-sheet-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px}.ccal-sheet-button{min-height:46px;border:1px solid var(--cal-line2);border-radius:7px;background:#141b1e;color:var(--cal-muted);font-size:11px;font-weight:900}.ccal-sheet-button.primary{border-color:#337a72;background:#08211e;color:var(--cal-teal)}.ccal-live{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  .ccal-grid.month .ccal-day{min-height:160px}.ccal-grid.month .ccal-day-head{padding:7px 8px}.ccal-grid.month .ccal-day-head span{display:none}.ccal-grid.month .ccal-day-slots{gap:4px;padding:5px}.ccal-grid.month .ccal-slot-top{padding:5px 6px}.ccal-grid.month .ccal-channel span:last-child,.ccal-grid.month .ccal-variant,.ccal-grid.month .ccal-social-line,.ccal-grid.month .ccal-slot details{display:none}.ccal-grid.month .ccal-slot-state .ccal-chip:not(.durable){display:none}.ccal-grid.month .ccal-slot-body{padding:6px}.ccal-grid.month .ccal-slot h3{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2}.ccal-grid.month .ccal-gate{margin-top:5px}.ccal-grid.month .ccal-empty-day{min-height:55px;border:0}.ccal-grid.month .ccal-slot-move{grid-template-columns:44px 1fr;padding:5px}.ccal-grid.month .ccal-move-sheet-button{font-size:10px}
  .ccal-backlog{align-self:start}.ccal-backlog-list{list-style:none;display:grid;gap:0;margin:0;padding:0}.ccal-backlog-item{padding:12px 13px;border-bottom:1px solid var(--cal-line)}.ccal-backlog-item:last-child{border-bottom:0}.ccal-backlog-meta{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:7px}.ccal-backlog h3{margin:0;font-size:13px;line-height:1.4}.ccal-backlog-proof{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:8px}.ccal-backlog-proof span{color:var(--cal-faint);font-size:10px}.ccal-backlog-proof strong{display:block;margin-top:2px;color:var(--cal-muted);font-size:10px}.ccal-backlog-gate{margin:8px 0 0;color:var(--cal-muted);font-size:11px;line-height:1.45}.ccal-sim-action{width:100%;min-height:44px;margin-top:9px;border:1px solid var(--cal-line2);border-radius:6px;background:var(--cal-soft);color:var(--cal-faint);font-size:11px;font-weight:900;cursor:not-allowed}.ccal-empty-backlog{padding:25px 17px;text-align:center;color:var(--cal-muted);font-size:12px;line-height:1.55}.ccal-backlog-note{margin:0;padding:11px 13px;border-top:1px solid var(--cal-line);background:var(--cal-soft);color:var(--cal-faint);font-size:11px;line-height:1.5}
  .ccal-warning{margin:0 12px 12px;border:1px solid #6f5a2c;background:#171308;padding:10px 12px;color:var(--cal-amber);font-size:12px;line-height:1.5}.ccal-footer{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:13px 18px;border-top:1px solid var(--cal-line);background:#080b0d;color:var(--cal-faint);font-size:11px;line-height:1.5}.ccal-footer strong{color:var(--cal-muted)}
  .ccal-outcome{margin:12px 12px 0;border:1px solid #33766e;border-left:4px solid var(--cal-teal);background:#081b18;padding:11px 13px}.ccal-outcome[data-kind="info"]{border-color:#6f5b30;border-left-color:var(--cal-amber);background:#171308}.ccal-outcome[data-kind="error"]{border-color:#7a413d;border-left-color:var(--cal-red);background:#190d0d}.ccal-outcome strong{display:block;font-size:12px}.ccal-outcome p{margin:4px 0 0;color:var(--cal-muted);font-size:11px;line-height:1.5}.ccal-outcome code{display:block;margin-top:6px;color:var(--cal-faint);font:750 10px var(--mono,monospace);overflow-wrap:anywhere}.ccal-outcome[data-jit-loading="true"]{border-left-color:var(--cal-blue)}
  .ccal-create{position:relative;justify-self:end}.ccal-create>summary{min-height:44px;display:flex;align-items:center;justify-content:center;border:1px solid #347a72;border-radius:7px;background:#08211e;color:var(--cal-teal);padding:0 14px;font-size:12px;font-weight:900;cursor:pointer;list-style:none}.ccal-create>summary::-webkit-details-marker{display:none}.ccal-create[open]>summary{box-shadow:0 0 0 3px rgba(0,229,204,.12)}.ccal-create-panel{position:absolute;z-index:40;top:calc(100% + 8px);right:0;width:min(520px,calc(100vw - 36px));border:1px solid var(--cal-line2);border-radius:11px;background:#101619;box-shadow:0 24px 70px rgba(0,0,0,.55);padding:15px}.ccal-create-panel h2{margin:0 0 4px;font-size:15px}.ccal-create-panel>p{margin:0 0 12px;color:var(--cal-muted);font-size:11px;line-height:1.5}
  .ccal-command-form{display:grid;gap:9px}.ccal-command-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.ccal-command-field{display:grid;gap:5px;color:var(--cal-muted);font-size:10px;font-weight:850}.ccal-command-field.wide{grid-column:1/-1}.ccal-command-field input,.ccal-command-field select,.ccal-command-field textarea{width:100%;min-height:44px;border:1px solid var(--cal-line2);border-radius:6px;background:#090d0f;color:var(--cal-ink);padding:8px 9px}.ccal-command-field textarea{min-height:64px;resize:vertical;line-height:1.45}.ccal-command-field input:focus,.ccal-command-field select:focus,.ccal-command-field textarea:focus{border-color:var(--cal-teal);box-shadow:0 0 0 3px rgba(0,229,204,.12);outline:0}.ccal-command-confirm{display:grid;grid-template-columns:20px 1fr;gap:7px;align-items:start;color:var(--cal-muted);font-size:10px;line-height:1.45}.ccal-command-confirm input{width:18px;height:18px;margin:0;accent-color:var(--cal-teal)}.ccal-command-submit{min-height:44px;border:1px solid #337a72;border-radius:6px;background:#08211e;color:var(--cal-teal);padding:0 11px;font-size:10px;font-weight:900;cursor:pointer}.ccal-command-submit.danger{border-color:#78413d;background:#21100f;color:var(--cal-red)}.ccal-command-submit[disabled],.ccal-command-form[aria-busy="true"] .ccal-command-submit{opacity:.58;cursor:wait}.ccal-command-status{min-height:1.45em;margin:0;color:var(--cal-faint);font-size:10px;line-height:1.45}
  .ccal-operations{border-top:1px solid var(--cal-line);background:#0b0f11}.ccal-operations>summary{min-height:42px;display:flex;align-items:center;justify-content:space-between;list-style:none;padding:0 9px;color:var(--cal-teal);font:850 10px var(--mono,monospace);cursor:pointer;text-transform:uppercase}.ccal-operations>summary::-webkit-details-marker{display:none}.ccal-operations>summary::after{content:"+";font-size:15px}.ccal-operations[open]>summary::after{content:"−"}.ccal-operation-body{display:grid;gap:10px;padding:0 9px 10px}.ccal-jit{border:1px solid var(--cal-line2);border-left:3px solid var(--cal-teal);background:#0d1416;padding:8px}.ccal-jit[data-state="due"],.ccal-jit[data-state="blocked"]{border-left-color:var(--cal-amber)}.ccal-jit[data-state="cancelled"]{border-left-color:var(--cal-faint)}.ccal-jit strong{display:block;font-size:10px}.ccal-jit p{margin:3px 0 0;color:var(--cal-muted);font-size:9px;line-height:1.45}.ccal-jit time{display:block;margin-top:4px;color:var(--cal-faint);font:700 9px var(--mono,monospace)}.ccal-operation-separator{border:0;border-top:1px solid var(--cal-line);margin:2px 0}.ccal-slot[data-command-state="saving"]{opacity:.72;box-shadow:0 0 0 2px var(--cal-blue)}.ccal-slot[data-command-state="saved"]{box-shadow:0 0 0 2px var(--cal-teal)}.ccal-slot[data-command-state="error"]{box-shadow:0 0 0 2px var(--cal-red)}
  @media(max-width:1040px){.ccal-workspace{grid-template-columns:1fr}.ccal-backlog{grid-row:1}.ccal-backlog-list{grid-template-columns:repeat(2,minmax(0,1fr))}.ccal-backlog-item:nth-child(odd){border-right:1px solid var(--cal-line)}}
  @media(max-width:800px){.ccal-hero{grid-template-columns:1fr;padding:22px 20px}.ccal-safety{grid-template-columns:1fr;padding:11px 20px}.ccal-safety-badge{justify-self:start}.ccal-toolbar{grid-template-columns:1fr auto}.ccal-period{grid-column:1/-1;grid-row:1;max-width:none}.ccal-mode{justify-self:start}.ccal-draft-action,.ccal-create{justify-self:end}.ccal-metrics{grid-template-columns:repeat(2,1fr)}.ccal-metric:nth-child(2){border-right:0}.ccal-metric:nth-child(n+3){border-top:1px solid var(--cal-line)}.ccal-workspace{padding:8px}.ccal-footer{flex-direction:column}.ccal-backlog-list{grid-template-columns:1fr}.ccal-backlog-item:nth-child(odd){border-right:0}}
  @media(max-width:520px){.ccal-hero h1{font-size:2.45rem}.ccal-toolbar{grid-template-columns:1fr}.ccal-mode,.ccal-draft-action,.ccal-create,.ccal-create>summary{width:100%;justify-self:stretch}.ccal-mode a{flex:1}.ccal-draft-action,.ccal-create{grid-row:3}.ccal-create-panel{position:fixed;inset:auto 8px 8px;width:auto;max-height:calc(100vh - 16px);overflow-y:auto}.ccal-metrics{grid-template-columns:1fr}.ccal-metric,.ccal-metric:nth-child(2){border-right:0}.ccal-metric:nth-child(n+2){border-top:1px solid var(--cal-line)}.ccal-section-head{flex-direction:column}.ccal-weekdays,.ccal-grid{grid-template-columns:repeat(7,minmax(145px,1fr));min-width:1015px}.ccal-local-truth{align-items:flex-start;flex-direction:column}.ccal-local-truth span:last-child{white-space:normal}.ccal-sheet-grid,.ccal-sheet-actions,.ccal-command-grid{grid-template-columns:1fr}.ccal-move-sheet{padding:8px}.ccal-footer{gap:7px}}
  @media(forced-colors:active){.ccal,.ccal-slot,.ccal-calendar,.ccal-backlog,.ccal-test-card,.ccal-chip,.ccal-channel-code,.ccal-move-sheet-panel{forced-color-adjust:auto}.ccal-slot{border-left-width:5px}.ccal-draft-action,.ccal-sim-action,.ccal-move-handle,.ccal-move-sheet-button{border:2px solid GrayText}.ccal-day[data-preview-drop-target="true"]{outline:4px solid Highlight}}
  @media(prefers-reduced-motion:reduce){.ccal *{scroll-behavior:auto!important;transition:none!important}}
  .ccal-live-scheduler{margin:12px;border:1px solid #337a72;background:#0b1214;padding:clamp(16px,2.2vw,26px);box-shadow:inset 0 1px rgba(255,255,255,.03),0 18px 55px rgba(0,0,0,.28)}.ccal-live-scheduler-grid{display:grid;grid-template-columns:minmax(0,1.12fr) minmax(280px,.72fr);gap:24px}.ccal-live-scheduler h2{margin:0;font-size:clamp(20px,2.2vw,28px);letter-spacing:-.025em}.ccal-live-scheduler header p{margin:7px 0 18px;color:var(--cal-muted);font-size:13px;line-height:1.55}.ccal-live-form{display:grid;gap:15px}.ccal-live-form textarea{min-height:148px;resize:vertical;font-size:15px;line-height:1.55}.ccal-live-form .ccal-command-field{gap:8px}.ccal-live-field-label{display:flex;align-items:center;justify-content:space-between;gap:12px}.ccal-live-field-label small{color:var(--cal-faint);font:750 10px var(--mono,monospace)}.ccal-live-when{border:1px solid var(--cal-line2);background:#080d0f;padding:14px}.ccal-live-when legend{padding:0 7px;color:var(--cal-ink);font-size:12px;font-weight:900}.ccal-live-time-grid{display:grid;grid-template-columns:1fr .72fr;gap:10px}.ccal-live-time-grid label{display:grid;gap:6px;color:var(--cal-muted);font-size:11px;font-weight:850}.ccal-live-time-grid input{width:100%;min-height:50px;border:1px solid var(--cal-line2);border-radius:8px;background:#11191c;color:var(--cal-ink);padding:9px 11px;font:850 13px var(--mono,monospace);color-scheme:dark}.ccal-date-card{position:relative;min-height:50px;align-content:center;border:1px solid var(--cal-line2);border-radius:8px;background:#11191c;padding:7px 42px 7px 11px;cursor:pointer;overflow:hidden}.ccal-date-card>span{color:var(--cal-faint);font-size:9px;letter-spacing:.06em;text-transform:uppercase}.ccal-date-card>strong{color:var(--cal-ink);font-size:13px;line-height:1.35}.ccal-date-card:after{content:'▦';position:absolute;right:14px;top:50%;translate:0 -50%;color:var(--cal-teal);font-size:20px}.ccal-date-card input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}.ccal-date-card:focus-within{border-color:var(--cal-teal);box-shadow:0 0 0 3px rgba(0,229,204,.16)}.ccal-suggested-times{margin-top:12px}.ccal-suggested-times>span{display:block;margin-bottom:7px;color:var(--cal-faint);font:800 10px var(--mono,monospace);letter-spacing:.05em;text-transform:uppercase}.ccal-suggestion-list{display:flex;gap:7px;flex-wrap:wrap}.ccal-time-suggestion{min-height:44px;border:1px solid #315c58;border-radius:999px;background:#0b201e;color:var(--cal-teal);padding:0 13px;font-size:11px;font-weight:900;cursor:pointer}.ccal-time-suggestion:hover,.ccal-time-suggestion:focus-visible{border-color:var(--cal-teal);background:#0e2c28;outline:none;box-shadow:0 0 0 3px rgba(0,229,204,.16)}.ccal-suggestion-note{margin:8px 0 0;color:var(--cal-faint);font-size:10px;line-height:1.45}.ccal-media-drop{display:grid;grid-template-columns:48px minmax(0,1fr) auto;gap:12px;align-items:center;min-height:82px;border:1px dashed #3a625e;border-radius:10px;background:#091113;padding:12px}.ccal-media-icon{width:48px;height:48px;display:grid;place-items:center;border:1px solid #315c58;border-radius:9px;color:var(--cal-teal);font-size:22px}.ccal-media-copy strong{display:block;font-size:12px}.ccal-media-copy span{display:block;margin-top:4px;color:var(--cal-faint);font-size:10px;line-height:1.4}.ccal-media-pick{position:relative;min-height:44px;display:grid;place-items:center;border:1px solid #3b716b;border-radius:8px;background:#0b211f;color:var(--cal-teal);padding:0 14px;font-size:11px;font-weight:900;cursor:pointer;overflow:hidden}.ccal-media-pick input{position:absolute;inset:0;opacity:0;cursor:pointer}.ccal-media-preview{display:flex;align-items:center;gap:10px;border:1px solid var(--cal-line2);border-radius:8px;background:#11191c;padding:9px}.ccal-media-preview[hidden]{display:none}.ccal-media-preview img,.ccal-media-preview video{width:64px;height:52px;object-fit:cover;border-radius:5px;background:#050708}.ccal-media-preview p{min-width:0;flex:1;margin:0;color:var(--cal-muted);font-size:11px;overflow-wrap:anywhere}.ccal-media-remove{min-height:44px;border:1px solid var(--cal-line2);border-radius:7px;background:#151b1e;color:var(--cal-muted);padding:0 12px;font-size:11px;font-weight:850}.ccal-live-submit{min-height:52px;font-size:13px}.ccal-live-status{margin:-5px 0 0}.ccal-live-list{list-style:none;margin:0;padding:0;border:1px solid var(--cal-line)}.ccal-live-list li{padding:10px;border-bottom:1px solid var(--cal-line)}.ccal-live-list li:last-child{border-bottom:0}.ccal-live-list strong{display:block;font-size:12px}.ccal-live-list p{margin:5px 0;color:var(--cal-muted);font-size:11px;line-height:1.4}.ccal-live-list time{color:var(--cal-teal);font:800 10px var(--mono,monospace)}
  .ccal-date-control{position:relative}.ccal-date-trigger{display:none;width:100%;text-align:left;font-family:inherit}.ccal-date-native{width:100%;min-height:50px}.ccal-live-controls-ready .ccal-date-trigger{display:grid}.ccal-live-controls-ready .ccal-date-native{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.ccal-date-popover{position:absolute;z-index:60;top:calc(100% + 8px);left:0;width:min(340px,calc(100vw - 42px));border:1px solid #3d7770;border-radius:13px;background:#10191c;padding:12px;box-shadow:0 24px 72px rgba(0,0,0,.62)}.ccal-date-popover[hidden]{display:none}.ccal-date-picker-head{display:grid;grid-template-columns:44px 1fr 44px;align-items:center;gap:8px;margin-bottom:9px}.ccal-date-picker-head strong{text-align:center;font-size:13px}.ccal-date-nav,.ccal-date-today{min-height:44px;border:1px solid var(--cal-line2);border-radius:8px;background:#0b211f;color:var(--cal-teal);font-weight:900;cursor:pointer}.ccal-date-nav[disabled]{opacity:.35;cursor:not-allowed}.ccal-date-weekdays,.ccal-date-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}.ccal-date-weekdays span{text-align:center;color:var(--cal-faint);font:800 9px var(--mono,monospace);text-transform:uppercase}.ccal-date-day{min-width:0;min-height:42px;border:1px solid transparent;border-radius:8px;background:#0a1113;color:var(--cal-muted);font:850 11px var(--mono,monospace);cursor:pointer}.ccal-date-day:hover,.ccal-date-day:focus-visible{border-color:var(--cal-teal);color:var(--cal-ink);outline:none}.ccal-date-day[data-other-month="true"]{color:#667073}.ccal-date-day[disabled]{opacity:.3;cursor:not-allowed}.ccal-date-day[aria-pressed="true"]{border-color:var(--cal-teal);background:#0b2a26;color:var(--cal-teal);box-shadow:0 0 0 2px rgba(0,229,204,.12)}.ccal-date-today{width:100%;margin-top:9px}.ccal-time-control{display:grid;gap:6px;color:var(--cal-muted);font-size:11px;font-weight:850}.ccal-time-stepper{display:grid;grid-template-columns:46px minmax(0,1fr) 46px;gap:6px}.ccal-time-stepper input{text-align:center;font-size:15px}.ccal-time-step{min-height:50px;border:1px solid var(--cal-line2);border-radius:8px;background:#0b211f;color:var(--cal-teal);font-size:20px;font-weight:900;cursor:pointer}.ccal-time-step:hover,.ccal-time-step:focus-visible{border-color:var(--cal-teal);outline:none;box-shadow:0 0 0 3px rgba(0,229,204,.14)}.ccal-media-drop{transition:border-color .15s ease,background .15s ease,box-shadow .15s ease}.ccal-media-drop[data-drag-active="true"]{border-style:solid;border-color:var(--cal-teal);background:#0b2522;box-shadow:0 0 0 4px rgba(0,229,204,.12)}.ccal-media-input{position:absolute!important;width:1px!important;height:1px!important;overflow:hidden!important;clip-path:inset(50%)!important}.ccal-media-pick{border:1px solid #3b716b}.ccal-media-drop-note{color:var(--cal-teal)!important;font-weight:850}.ccal-media-pick:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(0,229,204,.16)}
  .ccal-date-trigger:focus-visible{border-color:var(--cal-teal);outline:none;box-shadow:0 0 0 3px rgba(0,229,204,.16)}
  @media(max-width:800px){.ccal-live-scheduler-grid{grid-template-columns:1fr}.ccal-live-time-grid{grid-template-columns:1fr 1fr}}@media(max-width:520px){.ccal-live-time-grid{grid-template-columns:1fr}.ccal-media-drop{grid-template-columns:48px minmax(0,1fr)}.ccal-media-pick{grid-column:1/-1;width:100%}.ccal-date-popover{position:fixed;inset:auto 10px 10px;width:auto;max-height:calc(100vh - 20px);overflow:auto}}
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

function safePortalPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 500
      || !/^\/portal(?:\/|$)[^\u0000-\u001f\u007f]*$/u.test(value)
      || value.startsWith('//') || value.includes('\\')) return false;
  try {
    const parsed = new URL(value, 'https://growth-hq.invalid');
    return parsed.origin === 'https://growth-hq.invalid' && parsed.pathname.startsWith('/portal/');
  } catch {
    return false;
  }
}

function commandReady(action: ContentCalendarCommandActionView | undefined): action is ContentCalendarCommandActionView {
  return Boolean(action
    && safePortalPath(action.actionUrl)
    && typeof action.csrfToken === 'string'
    && action.csrfToken.length >= 16
    && action.csrfToken.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(action.csrfToken)
    && typeof action.commandKey === 'string'
    && /^[\x21-\x7e]{8,200}$/u.test(action.commandKey));
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}

function safeOperationText(value: string, fallback: string, maximum: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= maximum
    && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(text)
    ? text
    : fallback;
}

function operationOutcome(view: ContentCalendarOperationOutcomeView | undefined): string {
  if (!view) return '';
  const title = safeOperationText(view.title, 'TEST calendar result', 120);
  const detail = safeOperationText(
    view.detail,
    'The protected command completed without exposing raw provider or error data.',
    500,
  );
  const ids = [view.intentId, view.targetId]
    .filter((value): value is string => typeof value === 'string' && UUID.test(value));
  const statusUrl = safePortalPath(view.statusUrl) ? view.statusUrl : '';
  return `<aside class="ccal-outcome" data-kind="${escapeHtml(view.kind)}"${statusUrl ? ` data-calendar-jit-status-url="${escapeHtml(statusUrl)}"` : ''} role="${view.kind === 'error' ? 'alert' : 'status'}"><strong>${escapeHtml(title)}</strong><p data-calendar-outcome-detail>${escapeHtml(detail)}</p>${ids.length ? `<code>${escapeHtml(ids.join(' · '))}</code>` : ''}</aside>`;
}

function actionFields(action: ContentCalendarCommandActionView): string {
  return `${hidden('_csrf', action.csrfToken)}${hidden('command_key', action.commandKey)}`;
}

function choiceOptions(choices: readonly ContentCalendarChoiceView[]): string {
  return choices.slice(0, 80).map((choice) => {
    const label = safeOperationText(choice.label, 'Unavailable option', 160);
    const detail = choice.detail ? ` · ${safeOperationText(choice.detail, 'Gate detail unavailable', 160)}` : '';
    return `<option value="${escapeHtml(choice.value)}">${escapeHtml(label + detail)}</option>`;
  }).join('');
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

function createCalendarControl(
  create: ContentCalendarCreateActionView | undefined,
  timezone: string,
): string {
  if (!commandReady(create)
      || create.campaignRevisions.length === 0
      || create.contentVersions.length === 0
      || create.targets.length === 0) {
    return `<a class="ccal-draft-action" href="${CAMPAIGN_WIZARD_ROUTE}">+ Build campaign</a>`;
  }
  const targetSize = Math.max(2, Math.min(5, create.targets.length));
  return `<details class="ccal-create"><summary>+ New TEST plan</summary><section class="ccal-create-panel"><h2>Create a durable planning intent</h2><p>This records a desired TEST time and exact IDs. It cannot call or schedule a social provider.</p><form class="ccal-command-form" method="post" action="${escapeHtml(create.actionUrl)}" data-calendar-command-form data-command-kind="create">${actionFields(create)}${hidden('environment', 'test')}${hidden('timezone', timezone)}<div class="ccal-command-grid"><label class="ccal-command-field wide">Campaign revision<select name="campaign_revision_key" required>${choiceOptions(create.campaignRevisions)}</select></label><label class="ccal-command-field wide">Exact content version<select name="content_version_id" required>${choiceOptions(create.contentVersions)}</select></label><label class="ccal-command-field wide">Owned TEST targets<select name="target_ids" multiple required size="${targetSize}">${choiceOptions(create.targets)}</select></label><label class="ccal-command-field">Desired TEST time<input type="datetime-local" name="desired_for_local" step="300" required></label><label class="ccal-command-field">Maximum attempts<select name="max_attempts"><option value="1" selected>1 · deliberate</option><option value="2">2 · one retry</option><option value="3">3 · maximum</option></select></label></div><label class="ccal-command-confirm"><input type="checkbox" name="confirm_test_only" value="confirmed" required><span>I understand this creates durable TEST planning evidence, not an external schedule or publication.</span></label><button class="ccal-command-submit" type="submit">Create durable TEST plan</button><p class="ccal-command-status" data-calendar-form-status role="status" aria-live="polite">Ready · provider effects none.</p></form></section></details>`;
}

function slotJitStatus(slot: ContentCalendarSlotView, actions: ContentCalendarSlotActionView | undefined): string {
  const status = actions?.jitStatus ?? (slot.planning ? {
    state: slot.planning.statusTone,
    label: slot.planning.statusLabel,
    detail: slot.planning.statusDetail,
    nextRevalidationAt: slot.planning.nextRevalidationAt,
  } : null);
  if (!status) return '';
  const state = ['current', 'due', 'blocked', 'complete', 'cancelled'].includes(status.state)
    ? status.state
    : 'blocked';
  return `<aside class="ccal-jit" data-state="${escapeHtml(state)}"><strong>${escapeHtml(safeOperationText(status.label, 'JIT status unavailable', 120))}</strong><p>${escapeHtml(safeOperationText(status.detail, 'Exact revalidation detail is unavailable.', 400))}</p>${status.nextRevalidationAt ? isoTime(status.nextRevalidationAt, 'Revalidation time unavailable') : ''}</aside>`;
}

function returnFields(filters: ContentCalendarFiltersView): string {
  return `${hidden('return_mode', filters.mode)}${hidden('return_date', filters.date)}${hidden('return_channel', filters.channel)}`;
}

function slotOperations(
  slot: ContentCalendarSlotView,
  localDate: string,
  filters: ContentCalendarFiltersView,
  actions: ContentCalendarSlotActionView | undefined,
): string {
  const identityReady = Boolean(actions
    && UUID.test(actions.intentId)
    && UUID.test(actions.targetId)
    && (!slot.planning || (slot.planning.identityProofValid
      && slot.planning.intentId === actions.intentId
      && slot.planning.targetId === actions.targetId)));
  const rescheduleReady = identityReady && commandReady(actions?.reschedule);
  const cancelReady = identityReady && commandReady(actions?.cancel);
  const jit = slotJitStatus(slot, actions);
  if (!jit && !rescheduleReady && !cancelReady) return '';
  const immutable = actions?.intentSha256 && /^[a-f0-9]{64}$/u.test(actions.intentSha256)
    ? hidden('intent_sha256', actions.intentSha256)
    : '';
  const expected = actions?.expectedUpdatedAt
    && Number.isFinite(new Date(actions.expectedUpdatedAt).getTime())
    ? hidden('expected_updated_at', actions.expectedUpdatedAt)
    : '';
  const identity = actions
    ? `${hidden('intent_id', actions.intentId)}${hidden('target_id', actions.targetId)}${immutable}${expected}${returnFields(filters)}`
    : '';
  const localValue = /^\d{4}-\d{2}-\d{2}$/u.test(localDate) && /^\d{2}:\d{2}$/u.test(slot.timeLabel)
    ? `${localDate}T${slot.timeLabel}`
    : '';
  const reschedule = rescheduleReady && actions?.reschedule
    ? `<form class="ccal-command-form" method="post" action="${escapeHtml(actions.reschedule.actionUrl)}" data-calendar-command-form data-command-kind="reschedule" data-confirm-message="Save this new desired TEST time?">${actionFields(actions.reschedule)}${identity}<label class="ccal-command-field">New desired TEST time<input type="datetime-local" name="desired_for_local" value="${escapeHtml(localValue)}" step="300" required data-calendar-reschedule-time></label><label class="ccal-command-field">Reason<textarea name="reason" maxlength="500" required placeholder="Why is this TEST time changing?"></textarea></label><label class="ccal-command-confirm"><input type="checkbox" name="confirm_change" value="confirmed" required><span>Confirm a new immutable planning intent should supersede this target time.</span></label><button class="ccal-command-submit" type="submit">Save new TEST time</button><p class="ccal-command-status" data-calendar-form-status role="status" aria-live="polite">No change saved yet.</p></form>`
    : '';
  const cancel = cancelReady && actions?.cancel
    ? `<form class="ccal-command-form" method="post" action="${escapeHtml(actions.cancel.actionUrl)}" data-calendar-command-form data-command-kind="cancel" data-confirm-message="Cancel this exact TEST planning target?">${actionFields(actions.cancel)}${identity}<label class="ccal-command-field">Cancellation reason<textarea name="reason" maxlength="500" required placeholder="Why should this TEST target stop?"></textarea></label><label class="ccal-command-confirm"><input type="checkbox" name="confirm_cancel" value="confirmed" required><span>Confirm this exact target should stop. No external provider action will run.</span></label><button class="ccal-command-submit danger" type="submit">Cancel TEST target</button><p class="ccal-command-status" data-calendar-form-status role="status" aria-live="polite">Target remains unchanged.</p></form>`
    : '';
  return `<details class="ccal-operations"><summary>Durable TEST controls</summary><div class="ccal-operation-body">${jit}${reschedule}${reschedule && cancel ? '<hr class="ccal-operation-separator">' : ''}${cancel}</div></details>`;
}

function slotCard(
  slot: ContentCalendarSlotView,
  localDate: string,
  filters: ContentCalendarFiltersView,
  mutations: ContentCalendarMutationView | undefined,
): string {
  const stateClass = slot.publicSocial?.attention
    ? 'locked attention'
    : slot.simulationEligible ? 'ready' : 'locked';
  const helpId = `${slot.anchorId}-move-help`;
  const slotActions = mutations?.slots?.[slot.slotId];
  const durableMove = Boolean(slotActions && commandReady(slotActions.reschedule));
  return `<article class="ccal-slot ${stateClass}" id="${escapeHtml(slot.anchorId)}" aria-labelledby="${escapeHtml(slot.anchorId)}-title" data-calendar-slot data-slot-id="${escapeHtml(slot.slotId)}" data-scheduled-for="${escapeHtml(slot.scheduledFor)}">
    <header class="ccal-slot-top"><span class="ccal-channel"><span class="ccal-channel-code ${CHANNEL_CLASS[slot.channel]}" aria-hidden="true">${escapeHtml(slot.channelCode)}</span><span>${escapeHtml(slot.channelLabel)}</span></span><time class="ccal-time" datetime="${escapeHtml(slot.scheduledFor)}">${escapeHtml(slot.timeLabel)}</time></header>
    <div class="ccal-slot-body"><div class="ccal-slot-state"><span class="ccal-chip test">TEST · ${escapeHtml(slot.plannerStateLabel)}</span>${slot.versionNumber === null ? '' : `<span class="ccal-chip">Immutable v${safeCount(slot.versionNumber)}</span>`}${slot.publicSocial ? `<span class="ccal-chip durable ${escapeHtml(slot.publicSocial.stateTone)}"${slot.publicSocial.attention ? ' role="status"' : ''}>${escapeHtml(slot.publicSocial.stateLabel)}</span>` : ''}</div><h3 id="${escapeHtml(slot.anchorId)}-title">${escapeHtml(slot.title)}</h3><p class="ccal-variant">${escapeHtml(slot.variantLabel)}</p>${slot.publicSocial ? `<p class="ccal-social-line">${escapeHtml(slot.publicSocial.campaignTitle)} · revision ${safeCount(slot.publicSocial.revisionNumber)} · ${escapeHtml(slot.publicSocial.targetLabel)}</p><a class="ccal-campaign-link" href="${escapeHtml(campaignHref(slot, filters))}" aria-label="Open exact campaign ${escapeHtml(slot.publicSocial.campaignTitle)} for ${escapeHtml(slot.publicSocial.targetLabel)}">Open exact campaign →</a>` : ''}${slot.ownedSocialStageHref ? `<a class="ccal-campaign-link" href="${escapeHtml(slot.ownedSocialStageHref)}" aria-label="Stage ${escapeHtml(slot.title)} for the owned ${escapeHtml(slot.channelLabel)} live rail">Schedule live on ${escapeHtml(slot.channelLabel)} →</a>` : ''}<span class="ccal-gate">${escapeHtml(slot.gateLabel)}</span></div>
    <div class="ccal-slot-move"><button class="ccal-move-handle" type="button" aria-pressed="false" aria-describedby="${escapeHtml(helpId)}" data-calendar-move-handle>⋮⋮<span class="ccal-visually-hidden">Move ${escapeHtml(slot.title)} ${durableMove ? 'and confirm the durable TEST time' : 'in this browser-only TEST preview'}</span></button><button class="ccal-move-sheet-button" type="button" data-calendar-sheet-open>Choose date &amp; time</button><p class="ccal-visually-hidden" id="${escapeHtml(helpId)}">Drag with mouse or touch. With a keyboard, press Space, use Left and Right for the day and Up and Down for 30-minute time steps, then press Space again. ${durableMove ? 'A confirmation sheet opens before the protected TEST command is saved.' : 'Movement is not saved.'}</p></div>
    ${slotOperations(slot, localDate, filters, slotActions)}
    <details><summary>Planning proof</summary><div class="ccal-proof"><div class="ccal-proof-row"><span>Version</span><code>${escapeHtml(slot.contentVersionId)}</code></div><div class="ccal-proof-row"><span>Hash</span><code>${escapeHtml(slot.shortHash)}…</code></div><div class="ccal-proof-row"><span>Approval</span><strong>${escapeHtml(slot.approvalLabel)}</strong></div><div class="ccal-proof-row"><span>Source</span><strong>${escapeHtml(slot.sourceFreshnessLabel)}</strong></div><div class="ccal-proof-row"><span>Owner</span><strong>${escapeHtml(slot.ownerLabel)}</strong></div><div class="ccal-proof-row"><span>Goal</span><strong>${escapeHtml(slot.objectiveLabel)}</strong></div>${publicSocialProof(slot)}<p class="ccal-proof-note">${escapeHtml(slot.gateDetail)}</p><p class="ccal-proof-note"><strong>Draft/simulated only.</strong> This planner cannot call ${escapeHtml(slot.channelLabel)} or any provider.</p></div></details>
  </article>`;
}

function dayColumn(
  day: ContentCalendarDayView,
  mode: ContentCalendarMode,
  filters: ContentCalendarFiltersView,
  mutations: ContentCalendarMutationView | undefined,
): string {
  const slots = day.slots.map((slot) => slotCard(slot, day.date, filters, mutations)).join('');
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
  readonly mutations?: ContentCalendarMutationView;
  readonly liveScheduler?: ContentCalendarLiveSchedulerView;
}

function liveScheduler(
  action: ContentCalendarLiveSchedulerView | undefined,
  timezone: string,
): string {
  if (!commandReady(action)) return '';
  const items = action.items.slice(0, 20).map((item) => {
    const summary = safeOperationText(item.content, 'Scheduled LinkedIn post', 3000);
    const short = summary.length > 180 ? `${summary.slice(0, 177)}…` : summary;
    return `<li><strong>${item.state === 'scheduled' ? 'Scheduled' : escapeHtml(item.state.replace('_', ' '))}</strong><p>${escapeHtml(short)}</p>${isoTime(item.scheduledFor)}</li>`;
  }).join('');
  return `<section class="ccal-live-scheduler" aria-labelledby="ccal-live-title"><div class="ccal-live-scheduler-grid"><div><header><span class="ccal-kicker">Live company publishing</span><h2 id="ccal-live-title">Build your next LinkedIn post</h2><p>Write the post, add optional media and pick the exact minute. One click books it into your company schedule.</p></header><form class="ccal-command-form ccal-live-form" method="post" action="${escapeHtml(action.actionUrl)}" data-calendar-live-form data-media-upload-url="${escapeHtml(action.mediaUploadUrl)}" data-media-command-key="${escapeHtml(action.mediaCommandKey)}">${actionFields(action)}${hidden('network', 'linkedin')}${hidden('timezone', timezone)}${hidden('scheduled_for_local', '')}${hidden('media_type', '')}${hidden('media_url', '')}<label class="ccal-command-field"><span class="ccal-live-field-label"><strong>Post copy</strong><small>Up to 3,000 characters</small></span><textarea name="content" maxlength="3000" required placeholder="Share something genuinely useful with property investors…"></textarea></label><div class="ccal-command-field"><span class="ccal-live-field-label"><strong>Image or video</strong><small>Optional</small></span><div class="ccal-media-drop" data-calendar-media-drop><span class="ccal-media-icon" aria-hidden="true">＋</span><span class="ccal-media-copy"><strong>Drop your image or video here</strong><span class="ccal-media-drop-note">Drag &amp; drop, or choose a file</span><span>JPG, PNG, WebP, GIF, MP4, MOV or WebM · up to 500 MB</span></span><button class="ccal-media-pick" type="button" data-calendar-media-choose>Choose file</button><input class="ccal-media-input" type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm" data-calendar-media-input aria-label="Choose post image or video"></div><div class="ccal-media-preview" data-calendar-media-preview hidden><span data-calendar-media-visual></span><p data-calendar-media-name></p><button class="ccal-media-remove" type="button" data-calendar-media-remove>Remove</button></div></div><fieldset class="ccal-live-when"><legend>When should it go out?</legend><div class="ccal-live-time-grid"><div class="ccal-date-control"><button class="ccal-date-card ccal-date-trigger" type="button" data-calendar-date-trigger aria-expanded="false" aria-controls="ccal-date-picker"><span>Date</span><strong data-calendar-live-date-label>Choose a date</strong></button><label class="ccal-command-field ccal-date-native">Choose publication date<input type="date" data-calendar-live-date aria-label="Choose publication date" required></label><div class="ccal-date-popover" id="ccal-date-picker" data-calendar-date-popover hidden><div class="ccal-date-picker-head"><button class="ccal-date-nav" type="button" data-calendar-date-previous aria-label="Previous month">‹</button><strong data-calendar-date-month></strong><button class="ccal-date-nav" type="button" data-calendar-date-next aria-label="Next month">›</button></div><div class="ccal-date-weekdays" aria-hidden="true"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div><div class="ccal-date-grid" data-calendar-date-grid role="grid" aria-label="Publication dates"></div><button class="ccal-date-today" type="button" data-calendar-date-today>Jump to today</button></div></div><div class="ccal-time-control"><label for="ccal-live-time">Exact time</label><div class="ccal-time-stepper"><button class="ccal-time-step" type="button" data-calendar-time-step="-1" aria-label="One minute earlier">−</button><input id="ccal-live-time" type="text" inputmode="numeric" pattern="(?:[01]\\d|2[0-3]):[0-5]\\d" maxlength="5" placeholder="HH:MM" data-calendar-live-time required><button class="ccal-time-step" type="button" data-calendar-time-step="1" aria-label="One minute later">＋</button></div></div></div><div class="ccal-suggested-times"><span>Smart starting points</span><div class="ccal-suggestion-list"><button class="ccal-time-suggestion" type="button" data-calendar-suggestion-time="08:17">Morning · 08:17</button><button class="ccal-time-suggestion" type="button" data-calendar-suggestion-time="12:23">Lunch · 12:23</button><button class="ccal-time-suggestion" type="button" data-calendar-suggestion-time="17:35">After work · 17:35</button></div><p class="ccal-suggestion-note">Starting points, not invented performance claims. Growth HQ will personalise these once your own post results build up.</p></div></fieldset><button class="ccal-command-submit ccal-live-submit" type="submit" data-calendar-live-submit>Schedule LinkedIn post</button><p class="ccal-command-status ccal-live-status" data-calendar-live-status role="status" aria-live="polite">Choose any exact minute. Nothing publishes before your selected time.</p></form></div><div><header><h2>Coming up</h2><p>Your latest live LinkedIn schedules.</p></header>${items ? `<ol class="ccal-live-list">${items}</ol>` : '<p class="ccal-empty-backlog">Nothing scheduled yet. Your first post will appear here.</p>'}</div></div></section>`;
}

export function renderContentCalendarBody(
  view: ContentCalendarView,
  options: RenderContentCalendarOptions = {},
): string {
  const weekdays = view.days.slice(0, 7).map((day) => `<div class="ccal-weekday">${escapeHtml(day.weekdayLabel)}</div>`).join('');
  const days = view.days.map((day) => dayColumn(
    day,
    view.filters.mode,
    view.filters,
    options.mutations,
  )).join('');
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
  const durableControls = Boolean(options.mutations?.create
    || (options.mutations?.slots && Object.keys(options.mutations.slots).length > 0));
  const live = commandReady(options.liveScheduler);
  return `${renderContentWorkspaceNavigation('calendar', {
    companyAssetsAvailable: options.companyAssetsAvailable,
    assetsLabel: options.assetsLabel,
    brandBrainAvailable: options.brandBrainAvailable ?? false,
    brainLabel: options.brainLabel,
  })}<style data-property-predator-content-calendar>${CONTENT_CALENDAR_STYLE}</style><article class="ccal" aria-labelledby="ccal-title" data-provider-effects="${live ? 'explicit-form-only' : 'none'}" data-content-calendar data-calendar-mode="${escapeHtml(view.filters.mode)}" data-calendar-timezone="${escapeHtml(view.timezone)}" data-source-truncated="${view.sourceTruncated ? 'true' : 'false'}" data-preview-dirty="false">
    <header class="ccal-hero"><div><div class="ccal-kicker">Growth HQ · Campaign calendar</div><h1 id="ccal-title">Own the week. <em>Control the signal.</em></h1><p>${live ? 'Create and schedule Property Predator company posts from one clear calendar.' : 'Turn approved Property Predator assets into a calm, channel-aware campaign rhythm.'}</p></div><aside class="ccal-test-card" aria-label="Calendar connection"><strong>${live ? 'LinkedIn connected' : 'Planning workspace'}</strong><span>${escapeHtml(view.workspaceName)}</span><small>${escapeHtml(view.timezone)} · snapshot ${isoTime(view.asOf)}.${live ? ' Scheduling is live only when you press Schedule post.' : ''}</small></aside></header>
    ${live ? liveScheduler(options.liveScheduler, view.timezone) : '<section class="ccal-safety" aria-label="Planner truth boundary"><span class="ccal-safety-mark">Planning only</span><p>The live scheduling connection is not available yet.</p><span class="ccal-safety-badge">No provider calls</span></section>'}
    ${operationOutcome(options.mutations?.outcome)}
    <div class="ccal-toolbar">${modeNav(view)}<div class="ccal-period"><a href="${plannerHref(view, { date: view.previousDate })}" aria-label="Previous ${escapeHtml(view.filters.mode)}">‹</a><div class="ccal-period-title"><strong>${escapeHtml(view.periodLabel)}</strong><span>${escapeHtml(view.timezone)} · durable TEST truth</span></div><a href="${plannerHref(view, { date: view.nextDate })}" aria-label="Next ${escapeHtml(view.filters.mode)}">›</a></div>${createCalendarControl(options.mutations?.create, view.timezone)}</div>
    ${channelNav(view)}
    <section class="ccal-metrics" aria-label="${loaded}planner summary"><div class="ccal-metric"><small>${loaded}draft placements</small><strong>${safeCount(view.metrics.plannedSlots)}</strong><span>No provider jobs created</span></div><div class="ccal-metric ready"><small>${loaded}simulation ready</small><strong>${safeCount(view.metrics.simulationReady)}</strong><span>Exact gates agree</span></div><div class="ccal-metric blocked"><small>${loaded}gate locked</small><strong>${safeCount(view.metrics.blocked)}</strong><span>Fails closed before outbound</span></div><div class="ccal-metric"><small>${loaded}active rails</small><strong>${safeCount(view.metrics.activeChannels)}</strong><span>Planning variants only</span></div></section>
    <div class="ccal-workspace"><section class="ccal-calendar" aria-labelledby="ccal-calendar-title"><header class="ccal-section-head"><div><h2 id="ccal-calendar-title">${view.filters.mode === 'week' ? 'Weekly signal board' : 'Monthly campaign map'}</h2><p>Channel placements around approved company content. Scroll sideways on compact screens.</p></div><span class="ccal-count">${view.inputTruncated ? 'Loaded ' : ''}${safeCount(view.visibleSlotCount)} TEST plan${view.visibleSlotCount === 1 ? '' : 's'}</span></header><div class="ccal-scroll" tabindex="0" aria-label="Scrollable ${escapeHtml(view.filters.mode)} content calendar"><div class="ccal-weekdays" aria-hidden="true">${weekdays}</div><div class="ccal-grid ${escapeHtml(view.filters.mode)}">${days}</div></div></section>${backlog(view)}</div>
    <aside class="ccal-local-truth" role="status"><span><strong>${durableControls ? 'Protected TEST commands available.' : 'Browser-only movement.'}</strong> Drag, use the keyboard handle or choose a date and time. ${durableControls ? 'Durable slots open confirmation before saving; unavailable slots remain local previews.' : 'Nothing is saved; reloading restores this exact snapshot.'}</span><span>TEST plan · zero external effects</span></aside>
    ${warning}
    <div class="ccal-move-sheet" data-calendar-move-sheet role="dialog" aria-modal="true" aria-labelledby="ccal-move-sheet-title" hidden><section class="ccal-move-sheet-panel"><h2 id="ccal-move-sheet-title">Move TEST plan</h2><p data-calendar-sheet-copy>Choose a date visible in this loaded calendar and a time. Durable slots require confirmation before the protected TEST command runs.</p><div class="ccal-sheet-grid"><label>Date<input type="date" min="${escapeHtml(firstDate)}" max="${escapeHtml(lastDate)}" data-calendar-sheet-date></label><label>Time<input type="time" step="1800" data-calendar-sheet-time></label></div><div data-calendar-sheet-durable-fields hidden><label class="ccal-command-field">Reason<textarea maxlength="500" data-calendar-sheet-reason placeholder="Why is this TEST time changing?"></textarea></label><label class="ccal-command-confirm"><input type="checkbox" data-calendar-sheet-confirm><span>Confirm a new immutable TEST planning intent should supersede this target time.</span></label></div><div class="ccal-sheet-actions"><button class="ccal-sheet-button" type="button" data-calendar-sheet-cancel>Cancel</button><button class="ccal-sheet-button primary" type="button" data-calendar-sheet-apply>Review TEST move</button></div></section></div>
    <div class="ccal-live" data-calendar-live role="status" aria-live="polite" aria-atomic="true"></div>
    <footer class="ccal-footer"><span><strong>Draft/simulated throughout:</strong> no posts, messages, webinar registrations or provider schedules are created here.${escapeHtml(bounded)}</span><span>${safeCount(view.catalogCount)} owned catalogue versions inspected · generated output: 0</span></footer>
  </article><script src="${CONTENT_CALENDAR_CLIENT_ROUTE}" defer></script>`;
}
