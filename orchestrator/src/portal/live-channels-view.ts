/** Side-effect-free Property Predator Live Channels control room. */

import { renderContentWorkspaceNavigation } from './content-workspace-navigation.js';
import { escapeHtml } from './ui.js';
import {
  LIVE_CHANNELS_OWNED_SOCIAL_BIND_ROUTE,
  LIVE_CHANNELS_OWNED_SOCIAL_REVOKE_ROUTE,
  LIVE_CHANNELS_OWNED_SOCIAL_STAGE_ROUTE,
  LIVE_CHANNELS_PAUSE_ROUTE,
  LIVE_CHANNELS_SMS_BIND_ROUTE,
  LIVE_CHANNELS_SMS_REVOKE_ROUTE,
  LIVE_CHANNELS_SMS_STAGE_ROUTE,
  type LiveChannelCardView,
  type LiveChannelGaugeView,
  type LiveChannelLinkView,
  type LiveChannelToneClass,
  type LiveChannelsNoticeView,
  type LiveChannelsPauseScope,
  type LiveChannelsView,
} from './live-channels-presenter.js';
import { CONVERSION_INBOX_ROUTE } from './conversion-inbox-presenter.js';
import { PROVIDER_READINESS_COCKPIT_ROUTE } from './provider-readiness-cockpit-presenter.js';
import { SOCIAL_ACCOUNT_CONTROL_ROUTE } from './social-account-control-presenter.js';

const STYLE = `
  .plc{--plc-bg:#060809;--plc-panel:#0c1013;--plc-lift:#12181c;--plc-line:#263038;--plc-line-2:#39474f;--plc-ink:#f3f6f5;--plc-muted:#a2aeb2;--plc-faint:#7b898f;--plc-teal:#00e5cc;--plc-green:#6fdaa4;--plc-amber:#f2b84b;--plc-red:#ff7169;min-width:0;overflow:hidden;border:1px solid #020304;background:var(--plc-bg);color:var(--plc-ink)}.plc *{box-sizing:border-box}.plc h1,.plc h2,.plc h3,.plc p{margin-top:0}.plc-mono{font-family:var(--mono,ui-monospace,monospace)}
  .plc a{color:inherit}.plc a:focus-visible,.plc button:focus-visible,.plc summary:focus-visible,.plc input:focus-visible{outline:3px solid var(--plc-teal);outline-offset:2px}
  .plc-hero{position:relative;display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,380px);gap:32px;align-items:end;padding:34px 34px 29px;border-bottom:1px solid var(--plc-line);background:radial-gradient(circle at 84% 12%,rgba(0,229,204,.13),transparent 32%),linear-gradient(140deg,#12191c,#060809 67%);overflow:hidden}.plc-hero:after{content:"";position:absolute;right:26%;top:-130px;width:250px;height:250px;border:1px solid rgba(0,229,204,.11);transform:rotate(45deg);pointer-events:none}
  .plc-kicker{position:relative;color:var(--plc-teal);font:850 11px/1.3 var(--mono,monospace);letter-spacing:.15em;text-transform:uppercase}.plc-hero h1{position:relative;margin:10px 0 12px;font-family:var(--display,Georgia,serif);font-size:clamp(2.4rem,5.2vw,4.9rem);font-weight:600;line-height:.9;letter-spacing:-.04em}.plc-hero h1 em{color:var(--plc-teal);font-style:normal}.plc-hero-copy p{position:relative;max-width:700px;margin:0;color:var(--plc-muted);font-size:14px;line-height:1.7}
  .plc-launch{position:relative;display:grid;gap:10px;border:1px solid var(--plc-line-2);background:rgba(4,7,8,.8);padding:16px}.plc-launch-top{display:flex;align-items:center;justify-content:space-between;gap:12px}.plc-launch-top span{color:var(--plc-faint);font:800 10px var(--mono,monospace);letter-spacing:.09em;text-transform:uppercase}.plc-launch h2{margin:0;font-size:19px}.plc-launch p{margin:0;color:var(--plc-muted);font-size:12px;line-height:1.55}
  .plc-launch-split{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:4px;list-style:none;margin:0;padding:0}.plc-launch-split li{min-width:0;border:1px solid var(--plc-line);background:#090c0e;padding:7px 6px}.plc-launch-split span{display:block;color:var(--plc-faint);font:750 8px var(--mono,monospace);letter-spacing:.04em;text-transform:uppercase}.plc-launch-split strong{display:block;margin-top:3px;font:900 16px var(--mono,monospace)}.plc-launch-split .ready strong{color:var(--plc-teal)}.plc-launch-split .working strong{color:var(--plc-amber)}.plc-launch-split .paused strong{color:var(--plc-amber)}.plc-launch-split .blocked strong{color:var(--plc-red)}.plc-launch-split .muted strong{color:var(--plc-faint)}
  .plc-chip{border:1px solid var(--plc-red);padding:5px 8px;color:var(--plc-red);font:900 10px var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}.plc-chip.ready{border-color:var(--plc-teal);color:var(--plc-teal)}.plc-chip.working,.plc-chip.paused{border-color:var(--plc-amber);color:var(--plc-amber)}.plc-chip.muted{border-color:var(--plc-line-2);color:var(--plc-faint)}
  .plc-boundary{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:14px;align-items:center;padding:13px 34px;border-bottom:1px solid #785e28;background:#181205;color:#f3ca73}.plc-boundary strong{border:1px solid currentColor;padding:5px 8px;font:900 10px var(--mono,monospace);letter-spacing:.08em;white-space:nowrap}.plc-boundary p{margin:0;color:#d7c89e;font-size:12px;line-height:1.5}.plc-boundary>span{font:800 10px var(--mono,monospace);letter-spacing:.05em;white-space:nowrap}
  .plc-boundary.evidence{border-bottom-color:#1f4a44;background:#07211e;color:#7ff0e0}.plc-boundary.evidence p{color:#9fd9d0}
  .plc-notice{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;align-items:baseline;margin:0;padding:12px 34px;border-bottom:1px solid var(--plc-line);background:#0a1512;color:var(--plc-green);font-size:13px}.plc-notice.error{background:#190b0c;color:var(--plc-red)}.plc-notice.info{background:#101416;color:var(--plc-muted)}.plc-notice strong{font:850 11px var(--mono,monospace);letter-spacing:.06em;text-transform:uppercase}.plc-notice span{color:inherit;opacity:.85}
  .plc-pulse{display:grid;grid-template-columns:minmax(250px,1.4fr) repeat(4,minmax(120px,.65fr));border-bottom:1px solid var(--plc-line);background:var(--plc-panel)}.plc-pulse-lead,.plc-pulse-stat{padding:18px 20px;border-right:1px solid var(--plc-line)}.plc-pulse-stat:last-child{border-right:0}.plc-pulse-lead span,.plc-pulse-stat span{display:block;color:var(--plc-faint);font:800 10px var(--mono,monospace);letter-spacing:.07em;text-transform:uppercase}.plc-pulse-lead strong{display:block;margin:7px 0 5px;font-size:17px}.plc-pulse-lead p{margin:0;color:var(--plc-muted);font-size:12px;line-height:1.45}.plc-pulse-stat strong{display:block;margin-top:7px;font:900 21px var(--mono,monospace)}.plc-pulse-stat small{color:var(--plc-muted);font-size:11px}.plc-pulse-stat.attention strong{color:var(--plc-amber)}
  .plc-master{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,460px);gap:16px;align-items:center;padding:15px 34px;border-bottom:1px solid var(--plc-line);background:#0a0d0f}.plc-master-copy strong{display:block;font-size:13px}.plc-master-copy span{display:block;margin-top:3px;color:var(--plc-muted);font-size:11px;line-height:1.5}.plc-master .plc-guard{min-width:0}
  .plc-guard{border:1px solid var(--plc-line-2);background:#0d1113;min-width:0}.plc-guard>summary{display:flex;min-height:48px;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;cursor:pointer;font-size:12px;font-weight:800;list-style:none}.plc-guard>summary::-webkit-details-marker{display:none}.plc-guard>summary b{border:1px solid var(--plc-red);padding:4px 7px;color:var(--plc-red);font:900 9px var(--mono,monospace);letter-spacing:.05em;white-space:nowrap}.plc-guard>summary:after{content:"+";display:grid;width:22px;height:22px;place-items:center;border:1px solid var(--plc-line-2);color:var(--plc-teal);font:900 14px var(--mono,monospace);flex:0 0 auto}.plc-guard[open]>summary:after{content:"−"}
  .plc-guard-body{display:grid;gap:10px;padding:2px 14px 14px;border-top:1px solid var(--plc-line)}.plc-guard-body p{margin:8px 0 0;color:var(--plc-muted);font-size:12px;line-height:1.55}.plc-guard-check{display:flex;align-items:flex-start;gap:9px;color:var(--plc-ink);font-size:12px;line-height:1.5}.plc-guard-check input{width:18px;height:18px;margin:1px 0 0;accent-color:var(--plc-red);flex:0 0 auto}.plc-field{display:block;color:var(--plc-ink);font-size:12px;line-height:1.5}.plc-field span{display:block;color:var(--plc-muted);margin:0 0 4px}.plc-field input{display:block;width:100%;min-height:44px;box-sizing:border-box;padding:0 10px;background:var(--plc-bg);border:1px solid var(--plc-line-2);border-radius:8px;color:var(--plc-ink);font:inherit}
  .plc-guard-button{min-height:44px;border:1px solid var(--plc-red);background:#1c0c0d;color:var(--plc-red);padding:0 16px;font:850 12px var(--sans,sans-serif);letter-spacing:.04em;cursor:pointer}.plc-guard-button:hover{background:#2a1214}.plc-guard-button[disabled]{border-color:var(--plc-line-2);background:#0d1113;color:var(--plc-faint);cursor:not-allowed}
  .plc-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px;padding:16px}
  .plc-card{min-width:0;border:1px solid var(--plc-line);border-top:3px solid var(--plc-red);border-radius:8px;background:var(--plc-panel);overflow:hidden}.plc-card.ready{border-top-color:var(--plc-teal)}.plc-card.working,.plc-card.paused{border-top-color:var(--plc-amber)}.plc-card.muted{border-top-color:var(--plc-line-2)}
  .plc-card-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;padding:17px 18px 15px;border-bottom:1px solid var(--plc-line);background:linear-gradient(145deg,var(--plc-lift),var(--plc-panel))}.plc-eyebrow{color:var(--plc-faint);font:800 10px var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase}.plc-card h2{margin:5px 0 4px;font-family:var(--display,Georgia,serif);font-size:23px;font-weight:600;letter-spacing:-.01em}.plc-idline{margin:0;color:var(--plc-muted);font-size:12px;line-height:1.5;overflow-wrap:anywhere}.plc-idline b{color:var(--plc-ink);font-weight:700}
  .plc-state{align-self:start;border:1px solid var(--plc-red);padding:6px 8px;color:var(--plc-red);font:900 10px var(--mono,monospace);letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}.plc-state.ready{border-color:var(--plc-teal);color:var(--plc-teal)}.plc-state.working,.plc-state.paused{border-color:var(--plc-amber);color:var(--plc-amber)}.plc-state.muted{border-color:var(--plc-line-2);color:var(--plc-faint)}
  .plc-switchrow{display:flex;flex-wrap:wrap;gap:6px;align-items:center;list-style:none;margin:0;padding:11px 18px;border-bottom:1px solid var(--plc-line);background:#101416}.plc-switch{border:1px solid var(--plc-line-2);padding:4px 7px;color:var(--plc-muted);font:800 9px var(--mono,monospace);letter-spacing:.05em;white-space:nowrap}.plc-switch.ready{border-color:#2f746c;color:var(--plc-teal)}.plc-switch.working{border-color:#6b5a2a;color:var(--plc-amber)}.plc-switch.blocked,.plc-switch.pause{border-color:var(--plc-red);color:var(--plc-red)}.plc-switch.muted{color:var(--plc-faint)}
  .plc-why{padding:13px 18px;border-bottom:1px solid var(--plc-line);background:#080b0d}.plc-why h3,.plc-caps h3,.plc-gov h3,.plc-receipt h3,.plc-depth h3{margin:0 0 8px;color:var(--plc-faint);font:800 10px var(--mono,monospace);letter-spacing:.07em;text-transform:uppercase}.plc-why ul{display:grid;gap:7px;margin:0;padding:0;list-style:none}.plc-why li{display:grid;grid-template-columns:7px minmax(0,1fr);gap:9px;color:var(--plc-muted);font-size:12px;line-height:1.5}.plc-why li:before{content:"";width:6px;height:6px;margin-top:5px;border-radius:50%;background:var(--plc-red)}.plc-why li.clear:before{background:var(--plc-green)}.plc-why code{display:block;margin-top:2px;color:var(--plc-faint);font-size:9px;overflow-wrap:anywhere}
  .plc-next{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:11px;align-items:center;padding:12px 18px;border-bottom:1px solid var(--plc-line);background:#0a0e10}.plc-next>span{color:var(--plc-faint);font:800 9px var(--mono,monospace);letter-spacing:.07em;text-transform:uppercase;white-space:nowrap}.plc-next-copy{min-width:0}.plc-next-copy strong{display:block;font-size:12px}.plc-next-copy small{display:block;margin-top:2px;color:var(--plc-muted);font-size:11px;line-height:1.45}.plc-next a{border:1px solid var(--plc-line-2);padding:8px 10px;color:var(--plc-teal);font:800 10px var(--mono,monospace);letter-spacing:.04em;text-decoration:none;white-space:nowrap;min-height:44px;display:inline-flex;align-items:center}.plc-next a:hover{border-color:var(--plc-teal)}
  .plc-depth{padding:13px 18px;border-bottom:1px solid var(--plc-line)}.plc-unavail{margin:0;border:1px dashed var(--plc-line-2);background:#0d1113;padding:10px 12px;color:var(--plc-faint);font-size:11px;line-height:1.55}
  .plc-caps{padding:13px 18px;border-bottom:1px solid var(--plc-line);background:#090d0f}.plc-gauges{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.plc-gauge{min-width:0;border:1px solid var(--plc-line);background:#0d1113;padding:10px}.plc-gauge-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}.plc-gauge-head span{color:var(--plc-faint);font:750 9px var(--mono,monospace);letter-spacing:.05em;text-transform:uppercase}.plc-gauge-head strong{font:900 15px var(--mono,monospace)}.plc-gauge.attention .plc-gauge-head strong{color:var(--plc-amber)}.plc-gauge-track{margin-top:8px;height:6px;border:1px solid var(--plc-line-2);background:#060809}.plc-gauge-fill{height:100%;background:var(--plc-teal)}.plc-gauge.attention .plc-gauge-fill{background:var(--plc-amber)}.plc-gauge small{display:block;margin-top:6px;color:var(--plc-muted);font-size:10px}.plc-perjob{margin:9px 0 0;color:var(--plc-faint);font:700 9px var(--mono,monospace);letter-spacing:.04em}
  .plc-gov{padding:13px 18px;border-bottom:1px solid var(--plc-line)}.plc-gov-grid{display:grid;gap:8px}.plc-gov-item{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;align-items:baseline;border:1px solid var(--plc-line);background:#090c0e;padding:9px 10px}.plc-gov-item>span{color:var(--plc-faint);font:800 9px var(--mono,monospace);letter-spacing:.05em;text-transform:uppercase;white-space:nowrap}.plc-gov-copy{min-width:0;color:var(--plc-muted);font-size:11px;line-height:1.5}.plc-gov-copy b{color:var(--plc-ink);font-weight:750}.plc-gov-copy .plc-chip{display:inline-block;margin-right:7px;padding:3px 6px;font-size:8px}
  .plc-receipt{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:12px 18px;border-bottom:1px solid var(--plc-line);background:#080b0d}.plc-receipt-copy{min-width:0;color:var(--plc-muted);font-size:11px;line-height:1.5;overflow-wrap:anywhere}.plc-receipt-copy b{color:var(--plc-ink)}.plc-receipt-copy code{color:var(--plc-faint);font-size:9px}.plc-receipt time{color:var(--plc-faint);font:700 9px var(--mono,monospace);white-space:nowrap}
  .plc-linkrow{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:12px 18px;border-bottom:1px solid var(--plc-line)}.plc-linkrow a{border:1px solid var(--plc-line-2);padding:0 12px;min-height:44px;display:inline-flex;align-items:center;color:var(--plc-ink);font-size:11px;font-weight:750;text-decoration:none}.plc-linkrow a:hover{border-color:var(--plc-teal);color:var(--plc-teal)}
  .plc-card-foot{display:flex;justify-content:space-between;gap:10px;padding:10px 18px;color:var(--plc-faint);font:700 8px var(--mono,monospace);overflow-wrap:anywhere}
  .plc-card .plc-guard{border-left:0;border-right:0;border-bottom:0}
  .plc-handoff-list{display:grid;gap:8px;margin:0;padding:15px 18px;list-style:none;border-bottom:1px solid var(--plc-line)}.plc-handoff-list li{display:grid;grid-template-columns:7px minmax(0,1fr);gap:9px;color:var(--plc-muted);font-size:12px;line-height:1.5}.plc-handoff-list li:before{content:"";width:6px;height:6px;margin-top:5px;border-radius:50%;background:var(--plc-line-2)}.plc-handoff-list li.on:before{background:var(--plc-green)}
  .plc-panel{margin:0 16px 16px;border:1px solid var(--plc-line);border-radius:8px;background:var(--plc-panel);overflow:hidden}.plc-panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid var(--plc-line);background:linear-gradient(145deg,var(--plc-lift),var(--plc-panel))}.plc-panel-head h2{margin:0;font-family:var(--display,Georgia,serif);font-size:20px;font-weight:600}.plc-panel-head span{color:var(--plc-faint);font:700 10px var(--mono,monospace)}
  .plc-approval-row{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1.8fr) auto;gap:12px;align-items:center;padding:12px 18px;border-bottom:1px solid var(--plc-line)}.plc-approval-row:last-child{border-bottom:0}.plc-approval-row h3{margin:0;font-size:13px}.plc-approval-row p{margin:0;color:var(--plc-muted);font-size:11px}.plc-approval-row a{border:1px solid var(--plc-line-2);padding:0 12px;min-height:44px;display:inline-flex;align-items:center;color:var(--plc-teal);font:800 10px var(--mono,monospace);text-decoration:none;white-space:nowrap}.plc-approval-row a:hover{border-color:var(--plc-teal)}
  .plc-timeline-list{list-style:none;margin:0;padding:0}.plc-timeline-list li{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;gap:12px;align-items:baseline;padding:11px 18px;border-bottom:1px solid var(--plc-line)}.plc-timeline-list li:last-child{border-bottom:0}.plc-timeline-list time{color:var(--plc-faint);font:700 9px var(--mono,monospace);white-space:nowrap}.plc-timeline-chip{border:1px solid var(--plc-line-2);padding:3px 6px;color:var(--plc-muted);font:800 8px var(--mono,monospace);letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}.plc-timeline-copy{min-width:0;font-size:12px;overflow-wrap:anywhere}.plc-timeline-copy code{color:var(--plc-faint);font-size:9px}.plc-timeline-list .plc-chip{padding:3px 6px;font-size:8px}
  .plc-empty{padding:22px 18px;color:var(--plc-muted);font-size:12px;line-height:1.6}.plc-empty b{display:block;color:var(--plc-ink);font-size:13px;margin-bottom:3px}
  .plc-footer{display:flex;justify-content:space-between;gap:16px;padding:13px 18px;border-top:1px solid var(--plc-line);background:#080b0d;color:var(--plc-faint);font-size:10px;line-height:1.5}.plc-footer strong{color:var(--plc-muted)}
  @media(max-width:1180px){.plc-grid{grid-template-columns:1fr}.plc-pulse{grid-template-columns:repeat(4,minmax(0,1fr))}.plc-pulse-lead{grid-column:1/-1;border-right:0;border-bottom:1px solid var(--plc-line)}}
  @media(max-width:1024px){.plc-hero{grid-template-columns:1fr}.plc-master{grid-template-columns:1fr}}
  @media(max-width:760px){.plc-hero{padding:27px 20px 22px}.plc-boundary{grid-template-columns:1fr;padding:13px 20px}.plc-boundary>span{white-space:normal}.plc-notice{grid-template-columns:1fr;padding:12px 20px}.plc-pulse{grid-template-columns:repeat(2,minmax(0,1fr))}.plc-master{padding:15px 20px}.plc-grid{padding:10px}.plc-panel{margin:0 10px 10px}.plc-approval-row{grid-template-columns:minmax(0,1fr);row-gap:6px}.plc-approval-row a{justify-self:start}.plc-timeline-list li{grid-template-columns:auto minmax(0,1fr);row-gap:4px}.plc-timeline-copy{grid-column:1/-1}.plc-footer{display:grid}}
  @media(max-width:480px){.plc-hero h1{font-size:2.4rem}.plc-launch-split{grid-template-columns:repeat(2,minmax(0,1fr))}.plc-card-head,.plc-next{grid-template-columns:1fr}.plc-state{justify-self:start}.plc-next a{justify-self:start}.plc-gauges{grid-template-columns:1fr}.plc-gov-item{grid-template-columns:1fr;row-gap:4px}.plc-receipt{grid-template-columns:1fr}.plc-card-foot{flex-direction:column}}
  @media(prefers-reduced-motion:reduce){.plc *{scroll-behavior:auto!important;transition:none!important}}
  @media(forced-colors:active){.plc-state,.plc-chip,.plc-switch,.plc-guard>summary b,.plc-guard>summary:after{border:1px solid CanvasText}.plc-gauge-track{border-color:CanvasText}.plc-gauge-fill{background:CanvasText}.plc-why li:before,.plc-handoff-list li:before{background:CanvasText}.plc a:focus-visible,.plc button:focus-visible,.plc summary:focus-visible,.plc input:focus-visible{outline-color:Highlight}}
`;

function readableInstant(value: string | null): string {
  if (!value) return 'No dated proof';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/London', timeZoneName: 'short',
  }).format(new Date(value));
}

function tone(value: LiveChannelToneClass): string {
  return value;
}

export interface LiveChannelsRenderOptions {
  readonly workspaceName: string;
  readonly csrfToken: string;
  /**
   * True only when a Codex-provided typed pause command boundary is composed.
   * No such boundary exists at the 9e26bae5 checkpoint, so production always
   * renders the truthful disabled control.
   */
  readonly pauseCommandAvailable: boolean;
  /** Fresh idempotency keys minted per render, one per pause scope. */
  readonly pauseCommandKeys: Readonly<Record<LiveChannelsPauseScope, string>>;
  /** True only when the readiness cockpit route is composed and linked for this workspace. */
  readonly railStatusAvailable: boolean;
  /** Composition facts proven by the composed services for this exact response. */
  readonly handoff: Readonly<{
    conversionInboxComposed: boolean;
    inboxOperationsComposed: boolean;
    lead360Composed: boolean;
  }>;
  readonly notice?: LiveChannelsNoticeView;
  /** True only when the owned-social founder command boundary is composed. */
  readonly ownedSocialCommandAvailable?: boolean;
  /** True only when staging resolves an already-connected Zernio account server-side. */
  readonly zernioCalendarCommandAvailable?: boolean;
  /** Networks with an exact deployment-configured Zernio account binding. */
  readonly zernioCalendarConfiguredNetworks?: readonly ('instagram' | 'linkedin')[];
  /**
   * True only when this process also holds the owned-social profile-key
   * encryption contract. Without it the portal will not accept a Profile Key
   * it could not seal, and says so instead.
   */
  readonly ownedSocialProfileBindingComposed?: boolean;
  /** Fresh per-render command keys, one per owned-social founder command. */
  readonly ownedSocialCommandKeys?: Readonly<{
    bind: string;
    revoke: string;
    stage: string;
  }>;
  /** Evidence-only values carried from an exact durable calendar slot. */
  readonly ownedSocialStagePrefill?: Readonly<{
    network: 'instagram' | 'linkedin';
    planningIntentId: string;
    planningTargetId: string;
    contentItemId: string;
    contentVersionId: string;
    approvalRequestId: string;
    approvalDecisionId: string;
    sourceAttestationId: string;
    scheduledFor: string;
    operationTag: string;
  }>;
  /** True only when the Twilio SMS founder command boundary is composed. */
  readonly smsCommandAvailable?: boolean;
  /** Fresh per-render command keys, one per Twilio SMS founder command. */
  readonly smsCommandKeys?: Readonly<{
    bind: string;
    revoke: string;
    stage: string;
  }>;
}

function allowedLink(
  link: LiveChannelLinkView | null,
  options: LiveChannelsRenderOptions,
): LiveChannelLinkView | null {
  if (!link) return null;
  if (link.href === PROVIDER_READINESS_COCKPIT_ROUTE && !options.railStatusAvailable) return null;
  return link;
}

function renderGauge(item: LiveChannelGaugeView): string {
  return `<div class="plc-gauge${item.attention ? ' attention' : ''}">
    <div class="plc-gauge-head"><span>${escapeHtml(item.label)}</span><strong>${item.used} / ${item.cap}</strong></div>
    <div class="plc-gauge-track" aria-hidden="true"><div class="plc-gauge-fill" style="width:${item.percent}%"></div></div>
    <small>${escapeHtml(item.summary)}</small>
  </div>`;
}

function renderPauseGuard(
  card: LiveChannelCardView,
  options: LiveChannelsRenderOptions,
): string {
  const heading = `<summary><span>Emergency pause</span><b>${card.pauseEngaged ? 'ENGAGED' : 'UNAVAILABLE'}</b></summary>`;
  if (card.pauseEngaged) {
    return `<details class="plc-guard">${heading}<div class="plc-guard-body"><p>The emergency pause is already engaged on this rail, so no provider call can begin. Releasing a pause is a separate founder decision made outside this portal — there is deliberately no resume control here.</p></div></details>`;
  }
  if (!options.pauseCommandAvailable) {
    return `<details class="plc-guard">${heading}<div class="plc-guard-body"><p>No typed pause command boundary is composed at this backend checkpoint, so the pause remains controlled by the channel's environment switches only. This portal will not invent one.</p><button class="plc-guard-button" type="button" disabled aria-disabled="true">Engage emergency pause — command boundary not composed</button></div></details>`;
  }
  return `<details class="plc-guard">${heading}<div class="plc-guard-body">
    <p>Engaging the emergency pause stops every ${escapeHtml(card.label)} dispatch immediately and cannot be released from this portal. Confirm deliberately.</p>
    <form method="post" action="${LIVE_CHANNELS_PAUSE_ROUTE}">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
      <input type="hidden" name="command_key" value="${escapeHtml(options.pauseCommandKeys[card.rail])}">
      <input type="hidden" name="scope" value="${escapeHtml(card.rail)}">
      <label class="plc-guard-check"><input type="checkbox" name="confirm_pause" value="ENGAGE" required> I understand this pauses ${escapeHtml(card.label)} dispatch immediately and release happens outside this portal.</label>
      <button class="plc-guard-button" type="submit">Engage emergency pause</button>
    </form>
  </div></details>`;
}

function renderWhy(card: LiveChannelCardView): string {
  const items = card.whyBlocked.length
    ? card.whyBlocked.map((blocker) => `<li><span>${escapeHtml(blocker.message)}<code>${escapeHtml(blocker.code)}${blocker.derived ? ' · derived from proven state' : ''}</code></span></li>`).join('')
    : `<li class="clear"><span>No blocker code is recorded. ${card.pauseEngaged ? 'Only the emergency pause holds this rail dark.' : 'The rail is operating inside its proven envelope.'}</span></li>`;
  return `<section class="plc-why" aria-label="Why this channel is ${escapeHtml(card.postureLabel)}"><h3>Why · in plain English</h3><ul>${items}</ul></section>`;
}

function renderCard(card: LiveChannelCardView, options: LiveChannelsRenderOptions): string {
  const receipt = card.latestReceipt
    ? `<div class="plc-receipt-copy"><b>${escapeHtml(card.latestReceipt.outcomeLabel)}</b> · evidence <code>${escapeHtml(card.latestReceipt.evidenceShaShort)}</code> · receipt <code>${escapeHtml(card.latestReceipt.receiptId)}</code></div><time datetime="${escapeHtml(card.latestReceipt.recordedAt)}">${escapeHtml(readableInstant(card.latestReceipt.recordedAt))}</time>`
    : '<div class="plc-receipt-copy">No receipt recorded yet. The first durable, sanitised receipt for this rail will appear here.</div>';
  const nextLink = allowedLink(card.nextAction.link, options);
  const chips = card.stateChips.map((chip) =>
    `<li class="plc-switch ${tone(chip.tone)}">${escapeHtml(chip.label.toUpperCase())} · ${escapeHtml(chip.value.toUpperCase())}</li>`).join('')
    + (card.pauseEngaged ? '<li class="plc-switch pause">PAUSE ENGAGED</li>' : '');
  return `<article class="plc-card ${tone(card.postureTone)}" id="${escapeHtml(card.anchorId)}" aria-labelledby="${escapeHtml(card.anchorId)}-title">
    <header class="plc-card-head"><div><span class="plc-eyebrow">${escapeHtml(card.eyebrow)}</span><h2 id="${escapeHtml(card.anchorId)}-title">${escapeHtml(card.label)}</h2><p class="plc-idline"><b>${escapeHtml(card.providerLabel)}</b><br>Account identity stays server-side; only sanitised evidence crosses this seam.</p></div><span class="plc-state ${tone(card.postureTone)}">${escapeHtml(card.postureLabel)}</span></header>
    <ul class="plc-switchrow" aria-label="Proven rail states">${chips}</ul>
    ${renderWhy(card)}
    <div class="plc-next"><span>Safe next action</span><div class="plc-next-copy"><strong>${escapeHtml(card.nextAction.label)}</strong><small>${escapeHtml(card.nextAction.detail)}</small></div>${nextLink ? `<a href="${escapeHtml(nextLink.href)}">${escapeHtml(nextLink.label)}</a>` : ''}</div>
    <section class="plc-depth" aria-label="Operational depth"><h3>Operational depth</h3><p class="plc-unavail">Queue depth, in-flight and attention counts are not yet readable through the sanitised truth seam. They render here the moment the backend exposes them — never as zero in the meantime.</p></section>
    <section class="plc-caps" aria-label="Caps and usage"><h3>Hard caps · usage</h3><div class="plc-gauges">${card.gauges.map(renderGauge).join('')}</div>${card.perJobLabel ? `<p class="plc-perjob">${escapeHtml(card.perJobLabel)}</p>` : ''}</section>
    <section class="plc-gov" aria-label="Approvals and scope"><h3>Governance</h3><div class="plc-gov-grid">
      <div class="plc-gov-item"><span>Approvals</span><div class="plc-gov-copy">${card.approvalRequired ? '<span class="plc-chip working">Approval required now</span>' : ''}${escapeHtml(card.approvalRequirement)}</div></div>
      <div class="plc-gov-item"><span>Allowed scope</span><div class="plc-gov-copy">${escapeHtml(card.targetScope)}</div></div>
    </div></section>
    <section class="plc-receipt" aria-label="Latest receipt"><div><h3>Latest receipt</h3>${receipt}</div></section>
    <nav class="plc-linkrow" aria-label="${escapeHtml(card.label)} shortcuts">${card.links.flatMap((link) => allowedLink(link, options) ? [`<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`] : []).join('')}</nav>
    ${renderPauseGuard(card, options)}
    <footer class="plc-card-foot"><span>Contract · ${escapeHtml(card.contractLabel)}</span></footer>
  </article>`;
}

function renderHandoffCard(view: LiveChannelsView, options: LiveChannelsRenderOptions): string {
  const rows = [
    [options.handoff.conversionInboxComposed, options.handoff.conversionInboxComposed
      ? 'Conversion Inbox is composed — replies and receipts land in one queue.'
      : 'Conversion Inbox is not composed for this workspace yet.'],
    [options.handoff.inboxOperationsComposed, options.handoff.inboxOperationsComposed
      ? 'Inbox operations are composed — assignment, internal notes and admin calls are live commands.'
      : 'Inbox operations are not composed for this workspace yet.'],
    [options.handoff.lead360Composed, options.handoff.lead360Composed
      ? 'Lead 360 is composed — every contact opens a full case file.'
      : 'Lead 360 is not composed for this workspace yet.'],
    [view.whatsappInboundReady, view.whatsappInboundReady
      ? 'Inbound WhatsApp ingress is proven ready and projects into Conversion Inbox and Lead 360.'
      : 'Inbound WhatsApp ingress is not proven ready yet.'],
  ].map(([on, label]) => `<li${on ? ' class="on"' : ''}><span>${escapeHtml(String(label))}</span></li>`).join('');
  return `<article class="plc-card muted" id="live-conversion-handoff" aria-labelledby="live-conversion-handoff-title">
    <header class="plc-card-head"><div><span class="plc-eyebrow">Conversion handoff</span><h2 id="live-conversion-handoff-title">Inbox &amp; Lead 360</h2><p class="plc-idline">Where every live reply, receipt and consent change becomes CRM truth.</p></div><span class="plc-state ${options.handoff.conversionInboxComposed ? 'ready' : 'muted'}">${options.handoff.conversionInboxComposed ? 'Connected' : 'Not composed'}</span></header>
    <ul class="plc-handoff-list">${rows}</ul>
    <nav class="plc-linkrow" aria-label="Conversion handoff shortcuts"><a href="${CONVERSION_INBOX_ROUTE}">Open Conversion Inbox</a><a href="${CONVERSION_INBOX_ROUTE}?queue=approval">Approval queue</a><a href="/portal/crm/contacts">Lead 360 via contacts</a></nav>
    <footer class="plc-card-foot"><span>Inbound WhatsApp projection contract · conversion_inbox_and_lead360</span></footer>
  </article>`;
}

function renderMasterStop(view: LiveChannelsView, options: LiveChannelsRenderOptions): string {
  if (view.allComposedPaused) {
    return `<section class="plc-master" aria-label="Master emergency stop"><div class="plc-master-copy"><strong>Master emergency stop · engaged everywhere</strong><span>Every composed live rail already holds an engaged emergency pause. Releasing any pause is a separate founder decision made outside this portal.</span></div><span class="plc-chip">ALL COMPOSED RAILS PAUSED</span></section>`;
  }
  const body = options.pauseCommandAvailable
    ? `<details class="plc-guard"><summary><span>Pause every live rail</span><b>ARMED</b></summary><div class="plc-guard-body">
        <p>This engages the emergency pause on every composed rail at once. Nothing can be released from this portal afterwards.</p>
        <form method="post" action="${LIVE_CHANNELS_PAUSE_ROUTE}">
          <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
          <input type="hidden" name="command_key" value="${escapeHtml(options.pauseCommandKeys.all)}">
          <input type="hidden" name="scope" value="all">
          <label class="plc-guard-check"><input type="checkbox" name="confirm_pause" value="ENGAGE" required> I understand this pauses every live channel immediately.</label>
          <button class="plc-guard-button" type="submit">Engage master emergency stop</button>
        </form>
      </div></details>`
    : `<details class="plc-guard"><summary><span>Pause every live rail</span><b>UNAVAILABLE</b></summary><div class="plc-guard-body"><p>No typed pause command boundary is composed at this backend checkpoint, so the master stop is controlled by environment switches only. This portal will not invent one.</p><button class="plc-guard-button" type="button" disabled aria-disabled="true">Engage master emergency stop — command boundary not composed</button></div></details>`;
  return `<section class="plc-master" aria-label="Master emergency stop"><div class="plc-master-copy"><strong>Master emergency stop</strong><span>At least one composed rail is not paused. The master stop is fail-safe: it can only move rails towards OFF.</span></div>${body}</section>`;
}

/**
 * Founder-only owned Ayrshare/X commands. Reuses the existing panel and guard
 * surface so nothing is redesigned, and follows the same three-state honesty
 * rule as the pause control: done, not composed, or a deliberate form.
 *
 * The Profile Key field is write-only. It is never re-rendered, never echoed
 * back on failure and never appears in a notice.
 */
const SMS_BIND_FIELDS: readonly (readonly [string, string])[] = Object.freeze([
  ['binding_id', 'Binding record id'],
  ['connection_id', 'Provider connection id'],
  ['endpoint_id', 'Sender endpoint id'],
  ['display_name', 'Display name'],
  ['account_sid', 'Twilio Account SID'],
  ['messaging_service_sid', 'Messaging Service SID'],
  ['sender_number', 'Owned sender number, +44 E.164'],
  ['regulatory_evidence', 'UK regulatory evidence reference'],
  ['ownership_evidence', 'Number ownership evidence reference'],
  ['evidence_observed_at', 'Evidence observed at, UTC instant'],
] as const);

const SMS_STAGE_FIELDS: readonly (readonly [string, string])[] = Object.freeze([
  ['binding_id', 'Binding record id'],
  ['connection_id', 'Provider connection id'],
  ['endpoint_id', 'Sender endpoint id'],
  ['message_version_id', 'Approved message version id'],
  ['approval_request_id', 'Approval request id'],
  ['approval_decision_id', 'Approval decision id'],
  ['person_id', 'Owned test person id'],
  ['phone_endpoint_id', 'Owned test phone endpoint id'],
  ['consent_event_id', 'Consent evidence id'],
  ['compliance_subject_id', 'Compliance subject id'],
  ['policy_publication_id', 'Policy publication id'],
  ['pecr_sender_id', 'PECR sender decision id'],
  ['pecr_instigator_id', 'PECR instigator decision id'],
  ['permission_use_id', 'Permission-use receipt id'],
  ['operation_id', 'Provider operation id'],
  ['delivery_id', 'Message delivery id'],
  ['correlation_id', 'Correlation id'],
  ['authority_valid_until', 'Authority valid until, UTC instant'],
  ['segment_count', 'Expected segment count, 1 to 10'],
  ['owned_recipient', 'Owned test recipient, +44 E.164'],
  ['purpose', 'Consent purpose'],
] as const);

function smsFields(fields: readonly (readonly [string, string])[]): string {
  return fields.map(([name, label]) =>
    `<label class="plc-field"><span>${escapeHtml(label)}</span><input type="text" name="${escapeHtml(name)}" required maxlength="200" autocomplete="off"></label>`).join('');
}

/**
 * Founder-only Twilio SMS commands. Reuses the existing panel and guard
 * surface, and follows the same three-state honesty rule as the pause control.
 * No Twilio credential is ever collected here: the Auth Token and restricted
 * API key stay in the secret manager, held by the webhook and worker only.
 */
function renderSmsCommands(
  view: LiveChannelsView,
  options: LiveChannelsRenderOptions,
): string {
  const card = view.channels.find((channel) => channel.rail === 'sms');
  if (!card) return '';
  const head = `<div class="plc-panel-head"><h2 id="plc-sms-title">Owned SMS sender commands</h2><span>${escapeHtml(card.postureLabel)}</span></div>`;
  if (!options.smsCommandAvailable) {
    return `<section class="plc-panel" aria-labelledby="plc-sms-title">${head}<div class="plc-guard-body"><p>The Twilio SMS founder command boundary is not composed for this workspace, so no sender can be bound and no owned test can be staged from here. This portal will not invent one.</p><button class="plc-guard-button" type="button" disabled aria-disabled="true">Bind owned SMS sender — command boundary not composed</button></div></section>`;
  }
  const keys = options.smsCommandKeys ?? { bind: '', revoke: '', stage: '' };
  const csrf = escapeHtml(options.csrfToken);
  return `<section class="plc-panel" aria-labelledby="plc-sms-title">${head}
    <details class="plc-guard"><summary><span>Bind one owned Twilio sender</span><b>EVIDENCE ONLY</b></summary><div class="plc-guard-body">
      <p>The Account SID and Messaging Service SID are reduced to digests before they reach the database. No Auth Token or API key is accepted, stored or shown here.</p>
      <form method="post" action="${LIVE_CHANNELS_SMS_BIND_ROUTE}" autocomplete="off">
        <input type="hidden" name="_csrf" value="${csrf}">
        <input type="hidden" name="command_key" value="${escapeHtml(keys.bind)}">
        ${smsFields(SMS_BIND_FIELDS)}
        <label class="plc-guard-check"><input type="checkbox" name="confirm_sender" value="BIND" required> I attest this Twilio account and UK number are company-owned and cleared for use.</label>
        <button class="plc-guard-button" type="submit">Bind owned SMS sender</button>
      </form>
    </div></details>
    <details class="plc-guard"><summary><span>Revoke a bound sender</span><b>PERMANENT</b></summary><div class="plc-guard-body">
      <p>Revocation is append-only and disables the connection, so this rail can never dispatch through it again. A rotation is a revoke followed by binding a successor number.</p>
      <form method="post" action="${LIVE_CHANNELS_SMS_REVOKE_ROUTE}" autocomplete="off">
        <input type="hidden" name="_csrf" value="${csrf}">
        <input type="hidden" name="command_key" value="${escapeHtml(keys.revoke)}">
        <label class="plc-field"><span>Binding record id</span><input type="text" name="binding_id" required autocomplete="off"></label>
        <label class="plc-field"><span>Reason code</span><input type="text" name="reason_code" required maxlength="100" autocomplete="off"></label>
        <label class="plc-field"><span>Revocation evidence reference</span><input type="text" name="revocation_evidence" required maxlength="200" autocomplete="off"></label>
        <label class="plc-guard-check"><input type="checkbox" name="confirm_sender_revoke" value="REVOKE" required> I understand this permanently ends dispatch for this owned sender.</label>
        <button class="plc-guard-button" type="submit">Revoke owned sender</button>
      </form>
    </div></details>
    <details class="plc-guard"><summary><span>Stage one owned test message</span><b>${card.capReached ? 'CAP REACHED' : 'DATABASE PROVED'}</b></summary><div class="plc-guard-body">
      <p>Staging queues one already-approved message to one explicitly owned test number. The database re-proves the binding, sender, approval, recipient identity, current consent, latest-wins suppression, ${card.gauges.length > 0 ? escapeHtml(String(card.gauges[0]?.cap ?? 10)) : '10'} per day and 50 per month segment caps, an unreconciled-outcome check and the emergency pause first; every dimension must pass or nothing is queued. No worker lease is claimed and Twilio is not called.</p>
      <form method="post" action="${LIVE_CHANNELS_SMS_STAGE_ROUTE}" autocomplete="off">
        <input type="hidden" name="_csrf" value="${csrf}">
        <input type="hidden" name="command_key" value="${escapeHtml(keys.stage)}">
        ${smsFields(SMS_STAGE_FIELDS)}
        <label class="plc-guard-check"><input type="checkbox" name="confirm_sms_stage" value="STAGE" required> I confirm this exact approved message may be queued to this owned test number.</label>
        <button class="plc-guard-button" type="submit">Stage owned test message</button>
      </form>
    </div></details>
  </section>`;
}

function renderOwnedSocialCommands(
  view: LiveChannelsView,
  options: LiveChannelsRenderOptions,
): string {
  const card = view.channels.find((channel) => channel.rail === 'owned_social');
  if (!card) return '';
  const head = `<div class="plc-panel-head"><h2 id="plc-owned-social-title">Instagram &amp; LinkedIn publishing</h2><span>${escapeHtml(card.postureLabel)}</span></div>`;
  if (!options.ownedSocialCommandAvailable) {
    return `<section class="plc-panel" aria-labelledby="plc-owned-social-title">${head}<div class="plc-guard-body"><p>The social command boundary is not composed for this workspace, so no account can be bound and no publication can be staged from here.</p><button class="plc-guard-button" type="button" disabled aria-disabled="true">Connect social account — command boundary not composed</button></div></section>`;
  }
  const keys = options.ownedSocialCommandKeys ?? { bind: '', revoke: '', stage: '' };
  const prefill = options.ownedSocialStagePrefill;
  const value = (exact: string | undefined): string => exact
    ? ` value="${escapeHtml(exact)}"` : '';
  const csrf = escapeHtml(options.csrfToken);
  if (options.zernioCalendarCommandAvailable) {
    const configuredNetworks = options.zernioCalendarConfiguredNetworks ?? [];
    const networkOptions = configuredNetworks.map((network) => {
      const selected = prefill?.network === network ? ' selected' : '';
      const label = network === 'instagram' ? 'Instagram' : 'LinkedIn';
      return `<option value="${network}"${selected}>${label}</option>`;
    }).join('');
    const field = (name: string, label: string, exact: string | undefined, maximum = 100): string =>
      `<label class="plc-field"><span>${escapeHtml(label)}</span><input type="text" name="${escapeHtml(name)}"${value(exact)} required maxlength="${maximum}" autocomplete="off"></label>`;
    return `<section class="plc-panel" aria-labelledby="plc-owned-social-title">${head}
      <details class="plc-guard"><summary><span>Zernio connected accounts</span><b>${configuredNetworks.length > 0 ? 'CONNECTED' : 'UNAVAILABLE'}</b></summary><div class="plc-guard-body">
        <p>Account linking and permission evidence live in the Zernio connection centre. The calendar never accepts or exposes a provider profile, account id or API key.</p>
        <a class="plc-guard-button" href="${SOCIAL_ACCOUNT_CONTROL_ROUTE}">Manage connected accounts</a>
      </div></details>
      <details class="plc-guard" id="plc-owned-social-stage"${prefill ? ' open' : ''}><summary><span>Stage one approved calendar publication</span><b>${card.capReached ? 'CAP REACHED' : 'ZERNIO READY'}</b></summary><div class="plc-guard-body">
        <p>The database re-proves the connected Zernio account, exact content version, approval, source attestation, 1-per-day / 3-per-month cap and pause posture. This action only stages the job; it does not claim a worker lease or call Zernio.</p>
        <form method="post" action="${LIVE_CHANNELS_OWNED_SOCIAL_STAGE_ROUTE}" autocomplete="off">
          <input type="hidden" name="_csrf" value="${csrf}">
          <input type="hidden" name="command_key" value="${escapeHtml(keys.stage)}">
          <label class="plc-field"><span>Connected network</span><select name="network" required>${networkOptions}</select></label>
          ${field('planning_intent_id', 'Calendar planning intent id', prefill?.planningIntentId)}
          ${field('planning_target_id', 'Calendar planning target id', prefill?.planningTargetId)}
          ${field('content_item_id', 'Content item id', prefill?.contentItemId)}
          ${field('content_version_id', 'Approved content version id', prefill?.contentVersionId)}
          ${field('approval_request_id', 'Approval request id', prefill?.approvalRequestId)}
          ${field('approval_decision_id', 'Approval decision id', prefill?.approvalDecisionId)}
          ${field('source_attestation_id', 'Source attestation id', prefill?.sourceAttestationId)}
          ${field('operation_tag', 'Operation tag', prefill?.operationTag)}
          ${field('scheduled_for', 'Scheduled publish time (exact UTC instant)', prefill?.scheduledFor, 40)}
          <label class="plc-guard-check"><input type="checkbox" name="confirm_stage" value="STAGE" required> I confirm this exact approved calendar post may be queued to the server-selected owned account.</label>
          <button class="plc-guard-button" type="submit"${configuredNetworks.length > 0 ? '' : ' disabled aria-disabled="true"'}>Arm Zernio calendar publication</button>
        </form>
      </div></details>
    </section>`;
  }
  const bind = options.ownedSocialProfileBindingComposed
    ? `<form method="post" action="${LIVE_CHANNELS_OWNED_SOCIAL_BIND_ROUTE}" autocomplete="off">
      <input type="hidden" name="_csrf" value="${csrf}">
      <input type="hidden" name="command_key" value="${escapeHtml(keys.bind)}">
      <label class="plc-field"><span>Network</span><select name="network" required><option value="instagram">Instagram</option><option value="linkedin">LinkedIn</option></select></label>
      <label class="plc-field"><span>Profile record id</span><input type="text" name="profile_id" required autocomplete="off"></label>
      <label class="plc-field"><span>Display name</span><input type="text" name="display_name" required maxlength="120" autocomplete="off"></label>
      <label class="plc-field"><span>Ayrshare profile reference</span><input type="text" name="profile_reference" required maxlength="200" autocomplete="off"></label>
      <label class="plc-field"><span>Owned account reference</span><input type="text" name="owned_account" required maxlength="200" autocomplete="off"></label>
      <label class="plc-field"><span>Ayrshare Profile Key, sealed immediately and never stored here</span><input type="password" name="profile_credential" required maxlength="500" autocomplete="off"></label>
      <label class="plc-field"><span>OAuth link evidence reference</span><input type="text" name="oauth_evidence" required maxlength="200" autocomplete="off"></label>
      <label class="plc-field"><span>Linked at, UTC instant</span><input type="text" name="linked_at" required maxlength="40" autocomplete="off"></label>
      <label class="plc-field"><span>Evidence observed at, UTC instant</span><input type="text" name="evidence_observed_at" required maxlength="40" autocomplete="off"></label>
      <label class="plc-guard-check"><input type="checkbox" name="confirm_owned" value="OWNED" required> I attest this account is company-owned and linked with publishing permission.</label>
      <button class="plc-guard-button" type="submit">Connect owned social profile</button>
    </form>`
    : `<p>This process does not hold the social profile-key encryption contract, so it will not accept a Profile Key it could not seal. Nothing is stored.</p><button class="plc-guard-button" type="button" disabled aria-disabled="true">Connect social profile — encryption contract not composed</button>`;
  return `<section class="plc-panel" aria-labelledby="plc-owned-social-title">${head}
    <details class="plc-guard"><summary><span>Connect Instagram or LinkedIn</span><b>${options.ownedSocialProfileBindingComposed ? 'READY' : 'UNAVAILABLE'}</b></summary><div class="plc-guard-body">
      <p>The Profile Key is encrypted with the existing owned-social contract before it reaches the database. It is never stored in the clear, echoed back, logged or shown again.</p>${bind}
    </div></details>
    <details class="plc-guard"><summary><span>Revoke a bound profile</span><b>PERMANENT</b></summary><div class="plc-guard-body">
      <p>Revocation is append-only and permanent. A rotation is a revoke followed by binding the successor profile; there is deliberately no un-revoke.</p>
      <form method="post" action="${LIVE_CHANNELS_OWNED_SOCIAL_REVOKE_ROUTE}" autocomplete="off">
        <input type="hidden" name="_csrf" value="${csrf}">
        <input type="hidden" name="command_key" value="${escapeHtml(keys.revoke)}">
        <label class="plc-field"><span>Profile record id</span><input type="text" name="profile_id" required autocomplete="off"></label>
        <label class="plc-field"><span>Reason code</span><input type="text" name="reason_code" required maxlength="100" autocomplete="off"></label>
        <label class="plc-field"><span>Revocation evidence reference</span><input type="text" name="revocation_evidence" required maxlength="200" autocomplete="off"></label>
        <label class="plc-guard-check"><input type="checkbox" name="confirm_revoke" value="REVOKE" required> I understand this permanently ends publication for this owned profile.</label>
        <button class="plc-guard-button" type="submit">Revoke owned profile</button>
      </form>
    </div></details>
    <details class="plc-guard" id="plc-owned-social-stage"${prefill ? ' open' : ''}><summary><span>Stage one approved publication</span><b>${card.capReached ? 'CAP REACHED' : 'DATABASE PROVED'}</b></summary><div class="plc-guard-body">
      <p>Staging queues one already-approved post behind the command boundary. The database re-proves the owned profile, content hash, approval, source attestation, caps and pause posture first; every dimension must pass or nothing is queued. No worker lease is claimed and Ayrshare is not called.</p>
      <form method="post" action="${LIVE_CHANNELS_OWNED_SOCIAL_STAGE_ROUTE}" autocomplete="off">
        <input type="hidden" name="_csrf" value="${csrf}">
        <input type="hidden" name="command_key" value="${escapeHtml(keys.stage)}">
        <input type="hidden" name="network"${value(prefill?.network)}>
        <input type="hidden" name="planning_intent_id"${value(prefill?.planningIntentId)}>
        <input type="hidden" name="planning_target_id"${value(prefill?.planningTargetId)}>
        <label class="plc-field"><span>Profile record id</span><input type="text" name="profile_id" required autocomplete="off"></label>
        <label class="plc-field"><span>Content item id</span><input type="text" name="content_item_id"${value(prefill?.contentItemId)} required autocomplete="off"></label>
        <label class="plc-field"><span>Approved content version id</span><input type="text" name="content_version_id"${value(prefill?.contentVersionId)} required autocomplete="off"></label>
        <label class="plc-field"><span>Approval request id</span><input type="text" name="approval_request_id"${value(prefill?.approvalRequestId)} required autocomplete="off"></label>
        <label class="plc-field"><span>Approval decision id</span><input type="text" name="approval_decision_id"${value(prefill?.approvalDecisionId)} required autocomplete="off"></label>
        <label class="plc-field"><span>Source attestation id</span><input type="text" name="source_attestation_id"${value(prefill?.sourceAttestationId)} required autocomplete="off"></label>
        <label class="plc-field"><span>Owned account reference</span><input type="text" name="owned_account" required maxlength="200" autocomplete="off"></label>
        <label class="plc-field"><span>Operation tag</span><input type="text" name="operation_tag"${value(prefill?.operationTag)} required maxlength="100" autocomplete="off"></label>
        <label class="plc-field"><span>Scheduled publish time (exact UTC ISO instant from the calendar)</span><input type="text" name="scheduled_for"${value(prefill?.scheduledFor)} maxlength="40" placeholder="2026-09-02T09:00:00.000Z" autocomplete="off"></label>
        <label class="plc-guard-check"><input type="checkbox" name="confirm_stage" value="STAGE" required> I confirm this exact approved calendar post may be queued for the selected owned account.</label>
        <button class="plc-guard-button" type="submit">Arm calendar publication</button>
      </form>
    </div></details>
  </section>`;
}

function renderApprovalsPanel(view: LiveChannelsView): string {
  const gated = view.approvalRequiredRailLabels;
  const rows = gated.length
    ? gated.map((label) => `<div class="plc-approval-row">
        <h3>${escapeHtml(label)}</h3>
        <p>The truth seam reports an approval gate is active on this rail right now. Queue depth and ages are not yet readable.</p>
        <a href="${CONVERSION_INBOX_ROUTE}?queue=approval">Review queue</a>
      </div>`).join('')
    : `<div class="plc-empty"><b>No rail reports an active approval gate.</b>Approval queue counts and ages are not yet readable through the sanitised truth seam — this panel shows only the gates the backend proves, never fabricated totals.</div>`;
  return `<section class="plc-panel" aria-labelledby="plc-approvals-title"><div class="plc-panel-head"><h2 id="plc-approvals-title">Approval gates</h2><span>${gated.length} rail${gated.length === 1 ? '' : 's'} gated</span></div>${rows}</section>`;
}

function renderReceiptsPanel(view: LiveChannelsView): string {
  const body = view.latestReceipts.length
    ? `<ol class="plc-timeline-list">${view.latestReceipts.map((event) => `<li><time datetime="${escapeHtml(event.recordedAt)}">${escapeHtml(readableInstant(event.recordedAt))}</time><span class="plc-timeline-chip">${escapeHtml(event.railLabel)}</span><span class="plc-timeline-copy">${escapeHtml(event.outcomeLabel)} · evidence <code>${escapeHtml(event.evidenceShaShort)}</code></span><span class="plc-chip ${tone(event.tone)}">${escapeHtml(event.outcome)}</span></li>`).join('')}</ol>`
    : '<div class="plc-empty"><b>No receipts recorded yet.</b>When a durable receipt lands for any rail, its sanitised evidence appears here newest-first. Nothing is inferred; only recorded receipts are shown.</div>';
  return `<section class="plc-panel" aria-labelledby="plc-timeline-title"><div class="plc-panel-head"><h2 id="plc-timeline-title">Latest receipts</h2><span>${view.latestReceipts.length} of ${view.channels.length} rails have proof</span></div>${body}</section>`;
}

export function renderLiveChannelsBody(
  view: LiveChannelsView,
  options: LiveChannelsRenderOptions,
): string {
  const boundary = view.illustrative
    ? '<strong>ILLUSTRATIVE TEST DATA</strong><p>Every state, count and receipt on this page is invented to demonstrate the operating view in the local preview. Nothing was read from Mailgun, Zernio, Meta or any database, and nothing here can authorise a send.</p>'
    : '<strong>POSTGRES-AUTHORITATIVE EVIDENCE</strong><p>Every state, cap, blocker and receipt below is read from the durable truth seam. This page cannot load a credential, flip an effect switch on, or create a provider operation.</p>';
  const notice = options.notice
    ? `<div class="plc-notice ${escapeHtml(options.notice.kind)}" role="${options.notice.kind === 'error' ? 'alert' : 'status'}"><strong>${escapeHtml(options.notice.title)}</strong><span>${escapeHtml(options.notice.message)}</span></div>`
    : '';
  const splits: readonly [LiveChannelToneClass, string, number][] = [
    ['ready', 'Live', view.readyCount],
    // Composed and healthy, but a gate stops every send. Without its own slot
    // a gated rail would vanish from the summary entirely: not live, not
    // degraded, not blocked, not dark.
    ['working', 'Gated', view.gatedCount],
    ['working', 'Degraded', view.degradedCount],
    ['paused', 'Paused', view.pausedCount],
    ['blocked', 'Blocked', view.blockedCount],
    ['muted', 'Dark', view.notConnectedCount],
  ];
  return `${renderContentWorkspaceNavigation('live', { companyAssetsAvailable: true, composerAvailable: true, brandBrainAvailable: true, liveChannelsAvailable: true, providerReadinessAvailable: options.railStatusAvailable })}<style>${STYLE}</style><section class="plc" aria-labelledby="live-channels-title" data-dataset="${escapeHtml(view.dataset)}">
    <header class="plc-hero"><div class="plc-hero-copy"><span class="plc-kicker">PropertyPredator · live operations</span><h1 id="live-channels-title">Every channel.<br><em>One operational truth.</em></h1><p>Customer email, owned social, Meta WhatsApp and the social-DM rail on one fail-closed control room. Every state below is proven by the shared truth seam — typed states, hard caps, stable blocker codes and sanitised receipts. Never assumed, never decorative.</p></div><aside class="plc-launch" aria-label="Launch readiness"><div class="plc-launch-top"><span>Launch readiness</span><span class="plc-chip ${tone(view.launchReadinessTone)}">${escapeHtml(view.allComposedPaused ? 'PAUSED' : view.readyCount === view.channels.length ? 'ALL LIVE' : view.readyCount > 0 ? 'PARTIAL' : 'NOT LIVE')}</span></div><h2>${escapeHtml(view.launchReadinessLabel)}</h2><ul class="plc-launch-split">${splits.map(([toneClass, label, count]) => `<li class="${toneClass}"><span>${label}</span><strong>${count}</strong></li>`).join('')}</ul><p>${view.allComposedPaused ? 'The emergency pause is engaged on every composed rail. No provider call can begin anywhere.' : 'Rails move one controlled gate at a time. A channel only counts as live when the truth seam proves it.'}</p></aside></header>
    <section class="plc-boundary${view.illustrative ? '' : ' evidence'}" aria-label="Data provenance">${boundary}<span>${view.illustrative ? 'NO PROVIDER WAS READ' : 'READ-ONLY EVIDENCE'}</span></section>
    ${notice}
    <section class="plc-pulse" aria-label="Operations summary"><div class="plc-pulse-lead"><span>Today across all rails</span><strong>${view.totalUsedToday} of ${view.totalDailyCap} capped dispatches used</strong><p>Hard caps are enforced twice — at enqueue and again at call time — per workspace and connection, in UTC.</p></div><div class="plc-pulse-stat${view.blockedCount > 0 ? ' attention' : ''}"><span>Blocked rails</span><strong>${view.blockedCount}</strong><small>hard gates open</small></div><div class="plc-pulse-stat${view.attentionRailCount > 0 ? ' attention' : ''}"><span>Attention rails</span><strong>${view.attentionRailCount}</strong><small>human decision required</small></div><div class="plc-pulse-stat${view.approvalRequiredRailLabels.length > 0 ? ' attention' : ''}"><span>Approval gates</span><strong>${view.approvalRequiredRailLabels.length}</strong><small>rails waiting on a human</small></div><div class="plc-pulse-stat"><span>Receipts</span><strong>${view.latestReceipts.length}</strong><small>rails with durable proof</small></div></section>
    ${renderMasterStop(view, options)}
    <div class="plc-grid">${view.channels.map((card) => renderCard(card, options)).join('')}${renderHandoffCard(view, options)}</div>
    ${renderApprovalsPanel(view)}
    ${renderOwnedSocialCommands(view, options)}
    ${renderSmsCommands(view, options)}
    ${renderReceiptsPanel(view)}
    <footer class="plc-footer"><span><strong>Snapshot</strong> · ${escapeHtml(readableInstant(view.snapshotAt))} · ${escapeHtml(options.workspaceName)}</span><span><strong>Safety invariant</strong> · read-only evidence · no credentials · pause commands only move rails towards OFF</span></footer>
  </section>`;
}
