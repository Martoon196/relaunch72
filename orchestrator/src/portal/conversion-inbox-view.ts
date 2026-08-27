import { escapeHtml } from './ui.js';
import {
  CONVERSION_INBOX_CREATE_DRAFT_ROUTE,
  conversionInboxDecisionRoute,
  conversionInboxRequestApprovalRoute,
  conversionInboxReviseDraftRoute,
  conversionInboxTestQueueRoute,
} from './conversion-inbox-actions.js';
import {
  CONVERSION_INBOX_ROUTE,
  type ConversionInboxChannelFilter,
  type ConversionInboxConsentView,
  type ConversionInboxDeliveryState,
  type ConversionInboxQueueFilter,
  type ConversionInboxQueueItemView,
  type ConversionInboxSelectedThreadView,
  type ConversionInboxView,
} from './conversion-inbox-presenter.js';

export interface ConversionInboxActionSecurity {
  readonly csrfToken: string;
  readonly createDraftKeys: Readonly<Record<string, string>>;
  readonly reviseDraftKeys: Readonly<Record<string, string>>;
  readonly requestApprovalKeys: Readonly<Record<string, string>>;
  readonly decisionKeys: Readonly<Record<string, string>>;
  readonly queueKeys: Readonly<Record<string, string>>;
}

export interface RenderConversionInboxOptions {
  readonly security?: ConversionInboxActionSecurity;
}

const CHANNEL_GLYPHS: Readonly<Record<ConversionInboxChannelFilter, string>> = Object.freeze({
  all: 'HQ', email: 'EM', whatsapp: 'WA', sms: 'SM', instagram: 'IG', facebook: 'FB',
});

const CONVERSION_INBOX_STYLE = `
  .ci{--ci-bg:#07090b;--ci-panel:#0c1012;--ci-raised:#12181b;--ci-line:#263138;--ci-line-strong:#3a4850;--ci-ink:#f3f7f6;--ci-muted:#a5b2b5;--ci-faint:#77858a;--ci-teal:#00e5cc;--ci-amber:#f1bb51;--ci-red:#ff7169;--ci-green:#79deb5;min-width:0;color:var(--ci-ink);font-family:var(--sans,ui-sans-serif,system-ui,sans-serif);background:var(--ci-bg);border:1px solid #020304;overflow:hidden}.ci *{box-sizing:border-box}.ci button,.ci input,.ci select,.ci textarea{font:inherit}.ci h1,.ci h2,.ci h3,.ci p{margin-top:0}.ci a{text-decoration:none}.ci-sr{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}.ci-skip{position:absolute;z-index:20;left:12px;top:-80px;background:var(--ci-teal);color:#03110f;padding:10px 13px;font-weight:900}.ci-skip:focus{top:12px}
  .ci-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:22px;align-items:end;padding:24px 26px 20px;border-bottom:1px solid var(--ci-line);background:radial-gradient(circle at 88% 0,rgba(0,229,204,.1),transparent 30%),linear-gradient(135deg,#12181b,#080a0c 70%)}.ci-kicker{color:var(--ci-teal);font:850 12px/1.2 var(--mono,monospace);letter-spacing:.14em;text-transform:uppercase}.ci-head h1{margin:8px 0 6px;font-family:var(--display,var(--sans));font-size:clamp(2rem,3.7vw,3.7rem);font-weight:620;line-height:.94;letter-spacing:-.038em}.ci-head h1 em{color:var(--ci-teal);font-style:normal}.ci-head p{max-width:760px;margin:0;color:var(--ci-muted);font-size:13px;line-height:1.6}.ci-mode{min-width:245px;border:1px solid #25746b;background:#071b19;padding:13px 15px}.ci-mode strong{display:block;color:var(--ci-teal);font:900 13px var(--mono,monospace);letter-spacing:.08em}.ci-mode span{display:block;margin-top:5px;color:#b4cbc7;font-size:12px;line-height:1.45}
  .ci-truth{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:12px;align-items:center;padding:11px 26px;border-bottom:1px solid var(--ci-line);background:#0a0d0f}.ci-truth strong{color:var(--ci-teal);font:850 12px var(--mono,monospace);letter-spacing:.08em;text-transform:uppercase}.ci-truth p{margin:0;color:var(--ci-muted);font-size:12px;line-height:1.5}.ci-snapshot{color:var(--ci-faint);font:700 12px var(--mono,monospace);white-space:nowrap}
  .ci-toolbar{display:grid;grid-template-columns:minmax(220px,1fr) 170px auto auto;gap:9px;align-items:end;padding:13px 18px;border-bottom:1px solid var(--ci-line);background:#0b0f11}.ci-field{display:grid;gap:5px}.ci-field label{color:var(--ci-faint);font:780 11px var(--mono,monospace);letter-spacing:.07em;text-transform:uppercase}.ci-field input,.ci-field select{width:100%;height:44px;border:1px solid var(--ci-line-strong);border-radius:7px;background:var(--ci-raised);color:var(--ci-ink);padding:0 11px;font-size:13px}.ci-field input:focus,.ci-field select:focus,.ci-composer textarea:focus{border-color:var(--ci-teal);box-shadow:0 0 0 3px rgba(0,229,204,.13);outline:0}.ci-button,.ci-clear{height:44px;border:1px solid var(--ci-line-strong);border-radius:7px;padding:0 14px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:900}.ci-button{background:var(--ci-teal);border-color:var(--ci-teal);color:#03110f}.ci-clear{background:var(--ci-raised);color:var(--ci-ink)}
  .ci-workspace{display:grid;grid-template-columns:76px minmax(280px,350px) minmax(420px,1fr) minmax(270px,315px);height:min(760px,calc(100vh - 235px));min-height:620px}.ci-channels{border-right:1px solid var(--ci-line);background:#090c0e;padding:10px 8px;overflow-y:auto}.ci-channels ul{list-style:none;display:grid;gap:7px;margin:0;padding:0}.ci-channel{position:relative;min-height:56px;display:grid;place-items:center;border:1px solid transparent;border-radius:8px;color:var(--ci-faint)}.ci-channel:hover,.ci-channel:focus-visible{border-color:var(--ci-line-strong);background:var(--ci-raised);color:var(--ci-ink)}.ci-channel[aria-current="page"]{border-color:#267b71;background:#092421;color:var(--ci-teal)}.ci-glyph{font:900 12px var(--mono,monospace);letter-spacing:.03em}.ci-channel-count{position:absolute;right:3px;top:3px;min-width:18px;height:18px;display:grid;place-items:center;border:1px solid var(--ci-line-strong);border-radius:999px;background:#07090b;color:var(--ci-muted);font:800 10px var(--mono,monospace)}.ci-channel-test{display:block;margin-top:3px;font:800 9px var(--mono,monospace);letter-spacing:.05em}
  .ci-queue{min-width:0;border-right:1px solid var(--ci-line);background:var(--ci-panel);overflow-y:auto}.ci-queue-head{position:sticky;z-index:3;top:0;padding:13px 14px 11px;border-bottom:1px solid var(--ci-line);background:rgba(12,16,18,.97)}.ci-queue-title{display:flex;align-items:center;justify-content:space-between;gap:10px}.ci-queue-title h2{margin:0;font-size:14px}.ci-unread{border:1px solid #63542f;border-radius:999px;padding:3px 7px;color:var(--ci-amber);font:850 11px var(--mono,monospace)}.ci-queue-head p{margin:5px 0 0;color:var(--ci-faint);font-size:11px}.ci-conversations{list-style:none;margin:0;padding:0}.ci-conversation{border-bottom:1px solid var(--ci-line)}.ci-conversation>a{position:relative;display:grid;grid-template-columns:38px minmax(0,1fr) auto;gap:9px;min-height:112px;padding:12px 12px 11px;color:var(--ci-ink)}.ci-conversation>a:hover,.ci-conversation>a:focus-visible{background:#111719}.ci-conversation>a[aria-current="true"]{background:#10201f;box-shadow:inset 3px 0 var(--ci-teal)}.ci-avatar{width:38px;height:38px;display:grid;place-items:center;border:1px solid var(--ci-line-strong);border-radius:50%;background:#0a0d0f;color:var(--ci-teal);font:900 12px var(--mono,monospace)}.ci-person{min-width:0}.ci-person-line{display:flex;gap:6px;align-items:center}.ci-person strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.ci-dot{width:7px;height:7px;flex:0 0 auto;border-radius:50%;background:var(--ci-teal)}.ci-subject{display:block;margin-top:3px;color:var(--ci-muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ci-preview{display:-webkit-box;margin:6px 0 0;color:#c7d0d1;font-size:12px;line-height:1.45;overflow:hidden;-webkit-line-clamp:2;-webkit-box-orient:vertical}.ci-queue-meta{text-align:right}.ci-queue-meta time{display:block;color:var(--ci-faint);font:700 10px var(--mono,monospace)}.ci-channel-pill,.ci-approval-pill{display:inline-flex;margin-top:7px;border:1px solid var(--ci-line-strong);border-radius:999px;padding:3px 6px;color:var(--ci-muted);font:800 9px var(--mono,monospace);text-transform:uppercase}.ci-approval-pill{border-color:#66552e;color:var(--ci-amber)}.ci-boundary,.ci-queue-empty{margin:12px;border:1px dashed var(--ci-line-strong);padding:12px;color:var(--ci-faint);font-size:11px;line-height:1.5}.ci-queue-empty{padding:25px 14px;text-align:center}
  .ci-thread{min-width:0;display:grid;grid-template-rows:auto auto minmax(180px,1fr) auto;background:#0a0d0f;overflow:hidden}.ci-thread-head{display:flex;align-items:center;justify-content:space-between;gap:13px;min-height:68px;padding:10px 17px;border-bottom:1px solid var(--ci-line);background:#0d1113}.ci-thread-person{min-width:0}.ci-thread-person h2{margin:0;font-size:16px}.ci-thread-person p{margin:4px 0 0;color:var(--ci-muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ci-test-stamp{flex:0 0 auto;border:1px solid #267b71;background:#092421;padding:7px 9px;color:var(--ci-teal);font:850 10px var(--mono,monospace);letter-spacing:.05em;text-align:center}.ci-rail-activity{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:5px 9px;min-width:0;padding:9px 17px;border-bottom:1px solid var(--ci-line);background:#090d0f}.ci-rail-kicker{grid-column:1;border:1px solid #267b71;border-radius:999px;padding:3px 7px;color:var(--ci-teal);font:900 9px var(--mono,monospace);letter-spacing:.07em;white-space:nowrap}.ci-rail-state{grid-column:2;min-width:0;color:var(--ci-green);font:850 11px var(--mono,monospace)}.ci-rail-copy{grid-column:1/-1;grid-row:2;min-width:0;color:var(--ci-muted);font-size:10px;line-height:1.4}.ci-rail-trace{grid-column:1;grid-row:3}.ci-rail-time{grid-column:2;grid-row:3;justify-self:end}.ci-rail-trace,.ci-rail-time{color:var(--ci-faint);font:750 9px var(--mono,monospace);white-space:nowrap}.ci-rail-activity[data-rail-state="queued"] .ci-rail-state{color:var(--ci-amber)}.ci-rail-activity[data-rail-state="attention"]{background:#160d0d}.ci-rail-activity[data-rail-state="attention"] .ci-rail-state{color:var(--ci-red)}.ci-rail-activity[data-rail-state="none"] .ci-rail-state{color:var(--ci-faint)}.ci-transcript{min-height:0;overflow-y:auto;padding:18px 18px 8px;scrollbar-color:var(--ci-line-strong) transparent}.ci-transcript ol{list-style:none;display:grid;gap:12px;margin:0;padding:0}.ci-message{max-width:min(78%,650px)}.ci-message[data-direction="outbound"]{margin-left:auto}.ci-message[data-direction="internal_note"]{max-width:100%;margin-inline:auto}.ci-message-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:4px;color:var(--ci-faint);font-size:10px}.ci-message[data-direction="outbound"] .ci-message-head{justify-content:flex-end}.ci-inbound-proof{display:inline-flex;align-items:center;border:1px solid #267b71;border-radius:999px;background:#092421;padding:2px 6px;color:var(--ci-teal);font:900 9px var(--mono,monospace);letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}.ci-message-body{border:1px solid var(--ci-line);border-radius:4px 12px 12px 12px;background:var(--ci-raised);padding:10px 12px;color:#e5ebea;font-size:13px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}.ci-message[data-direction="outbound"] .ci-message-body{border-color:#276c65;border-radius:12px 4px 12px 12px;background:#0c2421}.ci-message[data-direction="internal_note"] .ci-message-body{border-color:#6c582c;background:#171308;color:#d9cba9}.ci-inbound-proof-detail{margin-top:5px;color:var(--ci-faint);font:750 9px/1.45 var(--mono,monospace);overflow-wrap:anywhere}.ci-delivery{display:flex;align-items:center;justify-content:flex-end;gap:5px;margin-top:5px;color:var(--ci-faint);font:750 10px var(--mono,monospace)}.ci-delivery::before{content:"TEST";border:1px solid var(--ci-line-strong);padding:1px 4px;color:var(--ci-teal)}.ci-truncated{display:block;margin-top:5px;color:var(--ci-amber);font-size:10px}.ci-transcript-boundary{margin:0 0 12px;border:1px dashed var(--ci-line-strong);padding:8px;color:var(--ci-faint);font-size:10px;text-align:center}
  .ci-composer{border-top:1px solid var(--ci-line);background:#0d1113;padding:12px 15px 14px}.ci-composer-top{display:flex;align-items:center;justify-content:space-between;gap:9px;margin-bottom:7px}.ci-composer-top label,.ci-composer-top strong{font-size:12px;font-weight:850}.ci-version{color:var(--ci-faint);font:750 10px var(--mono,monospace)}.ci-composer textarea{display:block;width:100%;min-height:78px;max-height:170px;resize:vertical;border:1px solid var(--ci-line-strong);border-radius:8px;background:#090c0e;color:var(--ci-ink);padding:10px 11px;font-size:13px;line-height:1.5}.ci-composer textarea[readonly]{color:var(--ci-muted);background:#090b0d}.ci-composer-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:9px}.ci-gate-copy{min-width:0;color:var(--ci-muted);font-size:10px;line-height:1.4}.ci-gate-copy strong{display:block;color:var(--ci-amber);font:850 10px var(--mono,monospace);text-transform:uppercase}.ci-draft-actions{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.ci-action-form{margin:0}.ci-review-form{display:grid;grid-template-columns:minmax(145px,1fr) auto;gap:8px;align-items:end;margin-top:9px}.ci-review-form label{display:grid;gap:5px;color:var(--ci-faint);font:750 10px var(--mono,monospace);letter-spacing:.05em;text-transform:uppercase}.ci-review-form textarea{min-height:52px}.ci-review-actions{display:flex;gap:6px;flex-wrap:wrap}.ci-draft-actions button,.ci-review-actions button{min-height:44px;border:1px solid var(--ci-line-strong);border-radius:7px;padding:0 11px;background:var(--ci-raised);color:var(--ci-ink);font-size:11px;font-weight:850;cursor:pointer}.ci-draft-actions .ci-primary,.ci-review-actions .ci-primary{border-color:var(--ci-teal);background:var(--ci-teal);color:#03110f}.ci-review-actions .ci-warn{border-color:#806834;color:var(--ci-amber)}.ci-review-actions .ci-danger{border-color:#78413d;color:var(--ci-red)}.ci-draft-actions button:disabled,.ci-review-actions button:disabled{cursor:not-allowed;opacity:.58}.ci-preview-note{margin:8px 0 0;color:var(--ci-faint);font-size:10px}.ci-notice{margin:12px 18px 0;border:1px solid var(--ci-line-strong);border-left:4px solid var(--ci-teal);background:#0b1514;padding:11px 13px}.ci-notice[data-kind="info"]{border-left-color:var(--ci-amber);background:#171308}.ci-notice[data-kind="error"]{border-left-color:var(--ci-red);background:#190d0d}.ci-notice strong{display:block;font-size:12px}.ci-notice p{margin:4px 0 0;color:var(--ci-muted);font-size:11px;line-height:1.45}
  .ci-context{min-width:0;border-left:1px solid var(--ci-line);background:var(--ci-panel);overflow-y:auto}.ci-context section{padding:14px;border-bottom:1px solid var(--ci-line)}.ci-context h2{margin:0 0 10px;color:var(--ci-faint);font:850 10px var(--mono,monospace);letter-spacing:.09em;text-transform:uppercase}.ci-lead-name{font-size:15px;font-weight:850}.ci-company{display:block;margin-top:3px;color:var(--ci-muted);font-size:11px}.ci-lead-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:11px}.ci-stat{border:1px solid var(--ci-line);background:#090c0e;padding:8px}.ci-stat span{display:block;color:var(--ci-faint);font:750 9px var(--mono,monospace);text-transform:uppercase}.ci-stat strong{display:block;margin-top:4px;font-size:12px}.ci-score{color:var(--ci-teal)}.ci-fact{margin:9px 0 0;color:var(--ci-muted);font-size:11px;line-height:1.5}.ci-fact b{color:var(--ci-ink)}.ci-lead-link{min-height:44px;display:flex;align-items:center;justify-content:center;margin-top:11px;border:1px solid var(--ci-line-strong);border-radius:7px;color:var(--ci-ink);font-size:11px;font-weight:850}.ci-lead-link:hover,.ci-lead-link:focus-visible{border-color:var(--ci-teal);color:var(--ci-teal)}
  .ci-consents{list-style:none;display:grid;gap:7px;margin:0;padding:0}.ci-consent{border:1px solid var(--ci-line);background:#090c0e;padding:8px}.ci-consent-top{display:flex;align-items:center;justify-content:space-between;gap:7px}.ci-consent strong{font-size:11px}.ci-consent-badge{border:1px solid var(--ci-line-strong);border-radius:999px;padding:2px 5px;color:var(--ci-muted);font:800 9px var(--mono,monospace);text-transform:uppercase}.ci-consent[data-state="permitted"] .ci-consent-badge{border-color:#2a705c;color:var(--ci-green)}.ci-consent[data-state="denied"] .ci-consent-badge,.ci-consent[data-state="withdrawn"] .ci-consent-badge,.ci-consent[data-state="suppressed"] .ci-consent-badge{border-color:#75403c;color:var(--ci-red)}.ci-consent p{margin:5px 0 0;color:var(--ci-faint);font-size:10px;line-height:1.4}
  .ci-gate{list-style:none;display:grid;gap:7px;margin:0;padding:0}.ci-gate li{position:relative;display:grid;grid-template-columns:22px minmax(0,1fr);gap:7px}.ci-gate li:not(:last-child)::after{content:"";position:absolute;left:10px;top:22px;bottom:-8px;width:1px;background:var(--ci-line-strong)}.ci-step{z-index:1;width:22px;height:22px;display:grid;place-items:center;border:1px solid var(--ci-line-strong);border-radius:50%;background:#090c0e;color:var(--ci-faint);font:850 9px var(--mono,monospace)}.ci-gate [data-complete="true"] .ci-step{border-color:#2a705c;color:var(--ci-green)}.ci-step-copy strong{display:block;font-size:11px}.ci-step-copy span{display:block;margin-top:2px;color:var(--ci-faint);font-size:10px;line-height:1.4}.ci-delivery-card{border:1px solid var(--ci-line);background:#090c0e;padding:9px}.ci-delivery-card strong{display:block;color:var(--ci-teal);font:850 11px var(--mono,monospace)}.ci-delivery-card p{margin:5px 0 0;color:var(--ci-muted);font-size:10px;line-height:1.45}
  .ci-empty-thread{grid-column:3/-1;display:grid;place-items:center;padding:28px;text-align:center;background:#0a0d0f}.ci-empty-thread div{max-width:420px}.ci-empty-thread h2{margin-bottom:6px}.ci-empty-thread p{margin:0;color:var(--ci-muted);font-size:12px;line-height:1.6}
  @media(max-width:1180px){.ci-workspace{grid-template-columns:70px minmax(270px,330px) minmax(390px,1fr)}.ci-context{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-column:2/-1;border-left:0;border-top:1px solid var(--ci-line);overflow:visible}.ci-workspace{height:auto;min-height:700px}.ci-queue{max-height:720px}.ci-thread{min-height:700px}.ci-context section{border-bottom:0;border-right:1px solid var(--ci-line)}.ci-context section:last-child{border-right:0}.ci-empty-thread{grid-column:2/-1;min-height:650px}}
  @media(max-width:840px){.ci-head{grid-template-columns:1fr}.ci-mode{min-width:0}.ci-truth{grid-template-columns:1fr}.ci-snapshot{white-space:normal}.ci-toolbar{grid-template-columns:1fr 1fr}.ci-field:first-child{grid-column:1/-1}.ci-workspace{grid-template-columns:1fr}.ci-channels{border-right:0;border-bottom:1px solid var(--ci-line);overflow-x:auto;padding:8px 12px}.ci-channels ul{display:flex}.ci-channel{width:58px;min-height:52px;flex:0 0 58px}.ci-queue{max-height:410px;border-right:0;border-bottom:1px solid var(--ci-line)}.ci-thread{min-height:680px}.ci-context{grid-column:1;grid-template-columns:1fr 1fr}.ci-context section:last-child{grid-column:1/-1;border-top:1px solid var(--ci-line)}.ci-empty-thread{grid-column:1;min-height:480px}}
  @media(max-width:560px){.ci-head{padding:21px 17px 17px}.ci-head h1{font-size:2.3rem}.ci-truth{padding-inline:17px}.ci-toolbar{grid-template-columns:1fr;padding:12px 14px}.ci-field:first-child{grid-column:auto}.ci-button,.ci-clear{width:100%}.ci-conversation>a{min-height:118px}.ci-thread{min-height:650px}.ci-thread-head{align-items:start}.ci-test-stamp{max-width:106px}.ci-rail-activity{grid-template-columns:auto minmax(0,1fr);align-items:start;padding-inline:12px}.ci-rail-state{grid-column:2}.ci-rail-copy{grid-column:1/-1;grid-row:2}.ci-rail-trace{grid-column:1;grid-row:3}.ci-rail-time{grid-column:2;grid-row:3;justify-self:end}.ci-transcript{padding-inline:12px}.ci-message{max-width:91%}.ci-inbound-proof{flex-basis:auto}.ci-inbound-proof-detail{width:100%}.ci-composer{padding-inline:12px}.ci-composer-bar{align-items:stretch;flex-direction:column}.ci-draft-actions,.ci-review-actions{display:grid;grid-template-columns:1fr}.ci-draft-actions button,.ci-review-actions button{width:100%}.ci-review-form{grid-template-columns:1fr}.ci-context{grid-template-columns:1fr}.ci-context section,.ci-context section:last-child{grid-column:1;border-right:0}.ci-lead-grid{grid-template-columns:1fr 1fr}}
  @media(prefers-reduced-motion:reduce){.ci *{scroll-behavior:auto!important;transition:none!important}}
  @media(forced-colors:active){.ci,.ci-mode,.ci-conversation>a[aria-current="true"],.ci-message-body,.ci-channel,.ci-inbound-proof{forced-color-adjust:auto}.ci-channel,.ci-conversation>a,.ci-message-body,.ci-composer textarea,.ci-stat,.ci-consent,.ci-inbound-proof{border:1px solid CanvasText}.ci-channel[aria-current="page"],.ci-conversation>a[aria-current="true"]{border:2px solid Highlight}}
`;

function safeDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function dateTime(value: string | null, timezone: string, compact = false): string {
  const date = safeDate(value);
  if (!date) return '<span>Time not recorded</span>';
  let label: string;
  try {
    label = new Intl.DateTimeFormat('en-GB', compact
      ? { hour: '2-digit', minute: '2-digit', timeZone: timezone }
      : { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(date);
  } catch {
    label = new Intl.DateTimeFormat('en-GB', compact
      ? { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }
      : { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date);
  }
  return `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(label)}</time>`;
}

function queryUrl(
  view: ConversionInboxView,
  changes: Readonly<Partial<{ channel: ConversionInboxChannelFilter; queue: ConversionInboxQueueFilter; conversationId: string }>>,
): string {
  const params = new URLSearchParams();
  const channel = changes.channel ?? view.filters.channel;
  const queue = changes.queue ?? view.filters.queue;
  const conversationId = changes.conversationId;
  if (view.filters.query) params.set('q', view.filters.query);
  if (channel !== 'all') params.set('channel', channel);
  if (queue !== 'all') params.set('queue', queue);
  if (conversationId) params.set('conversation', conversationId);
  const query = params.toString();
  return `${CONVERSION_INBOX_ROUTE}${query ? `?${query}` : ''}`;
}

function initials(name: string | null): string {
  if (!name) return '??';
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] ?? '').join('').toUpperCase() || '??';
}

function loadedConversationLabel(count: number): string {
  return `${count} loaded test ${count === 1 ? 'conversation' : 'conversations'}`;
}

function renderChannelRail(view: ConversionInboxView): string {
  const items = view.channels.map((channel) => `
    <li><a class="ci-channel" href="${escapeHtml(queryUrl(view, { channel: channel.channel }))}"${channel.selected ? ' aria-current="page"' : ''} aria-label="${escapeHtml(channel.label)}, ${escapeHtml(loadedConversationLabel(channel.count))}">
      <span><span class="ci-glyph" aria-hidden="true">${escapeHtml(CHANNEL_GLYPHS[channel.channel])}</span><span class="ci-channel-test">TEST</span></span>
      <span class="ci-channel-count" aria-hidden="true">${escapeHtml(channel.count)}</span>
    </a></li>`).join('');
  return `<nav class="ci-channels" aria-label="Test conversation channels"><ul>${items}</ul></nav>`;
}

function renderQueueItem(view: ConversionInboxView, item: ConversionInboxQueueItemView): string {
  const name = item.contactName ?? 'Unmatched test contact';
  return `<li class="ci-conversation">
    <a href="${escapeHtml(queryUrl(view, { conversationId: item.conversationId }))}"${item.selected ? ' aria-current="true"' : ''} aria-label="Open test conversation with ${escapeHtml(name)} on ${escapeHtml(item.channelLabel)}">
      <span class="ci-avatar" aria-hidden="true">${escapeHtml(initials(name))}</span>
      <span class="ci-person">
        <span class="ci-person-line"><strong>${escapeHtml(name)}</strong>${item.unreadCount > 0 ? '<span class="ci-dot" aria-label="Unread"></span>' : ''}</span>
        <span class="ci-subject">${escapeHtml(item.subject ?? item.stateLabel)}</span>
        <span class="ci-preview">${escapeHtml(item.preview)}</span>
      </span>
      <span class="ci-queue-meta">${dateTime(item.lastMessageAt, view.timezone, true)}<span class="ci-channel-pill">${escapeHtml(item.channelLabel)} · TEST</span>${item.requiresApproval ? '<span class="ci-approval-pill">Review</span>' : ''}</span>
    </a>
  </li>`;
}

function renderQueue(view: ConversionInboxView): string {
  const boundary = view.hasMore
    ? `<p class="ci-boundary"><strong>Bounded queue.</strong> Showing ${escapeHtml(view.loadedConversationCount)} loaded records; more may exist.</p>` : '';
  const items = view.conversations.length > 0
    ? `<ol class="ci-conversations" aria-label="TEST and simulated conversation queue">${view.conversations.map((item) => renderQueueItem(view, item)).join('')}</ol>`
    : '<p class="ci-queue-empty">No match in the loaded test queue. Clear a filter to keep exploring.</p>';
  return `<section class="ci-queue" aria-labelledby="ci-queue-title">
    <header class="ci-queue-head"><div class="ci-queue-title"><h2 id="ci-queue-title">Conversation queue</h2><span class="ci-unread">${escapeHtml(view.totalUnreadCount)} unread</span></div><p>${escapeHtml(view.matchingConversationCount)} of ${escapeHtml(view.loadedConversationCount)} loaded · TEST / simulated conversations</p></header>
    ${items}${boundary}
  </section>`;
}

function renderTranscript(thread: ConversionInboxSelectedThreadView, timezone: string): string {
  const truncated = thread.transcriptTruncated
    ? '<p class="ci-transcript-boundary">Older test messages are outside this bounded transcript.</p>' : '';
  const items = thread.messages.map((message) => {
    const evidence = message.inboundEvidence;
    const proof = evidence
      ? `<span class="ci-inbound-proof" aria-label="${escapeHtml(evidence.accessibleLabel)}">${escapeHtml(evidence.label)} · ${escapeHtml(evidence.networkCode)}</span>`
      : '';
    const proofDetail = evidence
      ? `<div class="ci-inbound-proof-detail">Simulator signature verified · Receipt ${escapeHtml(evidence.receiptLabel)} · verified ${dateTime(evidence.verifiedAt, timezone, true)}</div>`
      : '';
    return `<li class="ci-message" data-direction="${escapeHtml(message.direction)}">
      <div class="ci-message-head"><strong>${escapeHtml(message.authorLabel)}</strong><span>·</span>${dateTime(message.occurredAt, timezone, true)}${proof}</div>
      <div class="ci-message-body">${escapeHtml(message.body)}${message.bodyTruncated ? '<span class="ci-truncated">Long body clipped at the safe display boundary.</span>' : ''}</div>
      ${proofDetail}${message.deliveryLabel ? `<div class="ci-delivery">${escapeHtml(message.deliveryLabel)} · no real delivery occurred</div>` : ''}
    </li>`;
  }).join('');
  return `<div class="ci-transcript" id="ci-transcript" tabindex="-1"><h3 class="ci-sr">Test message transcript</h3>${truncated}<ol aria-label="Test message transcript">${items}</ol></div>`;
}

function renderRailActivity(thread: ConversionInboxSelectedThreadView, timezone: string): string {
  const activity = thread.railActivity;
  if (activity === null) {
    return `<section class="ci-rail-activity" data-rail-state="none" aria-label="TEST rail activity"><span class="ci-rail-kicker">Latest TEST rail</span><strong class="ci-rail-state">No operation recorded</strong><span class="ci-rail-copy">Nothing is queued for this conversation.</span></section>`;
  }
  return `<section class="ci-rail-activity" data-rail-state="${escapeHtml(activity.state)}" aria-label="TEST rail activity: ${escapeHtml(activity.label)}"><span class="ci-rail-kicker">Latest TEST rail</span><strong class="ci-rail-state">${escapeHtml(activity.label)}</strong><span class="ci-rail-copy">${escapeHtml(activity.detail)}</span><span class="ci-rail-trace">Trace ${escapeHtml(activity.correlationLabel)}</span><span class="ci-rail-time">Last change ${dateTime(activity.occurredAt, timezone, true)}</span></section>`;
}

function inboxReturnFields(view: ConversionInboxView, thread: ConversionInboxSelectedThreadView): string {
  return `<input type="hidden" name="return_q" value="${escapeHtml(view.filters.query)}"><input type="hidden" name="return_channel" value="${escapeHtml(view.filters.channel)}"><input type="hidden" name="return_queue" value="${escapeHtml(view.filters.queue)}"><input type="hidden" name="return_conversation" value="${escapeHtml(thread.summary.conversationId)}">`;
}

function protectedFields(
  view: ConversionInboxView,
  thread: ConversionInboxSelectedThreadView,
  security: ConversionInboxActionSecurity,
  commandKey: string,
): string {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(security.csrfToken)}"><input type="hidden" name="command_key" value="${escapeHtml(commandKey)}">${inboxReturnFields(view, thread)}`;
}

function readOnlyComposer(
  view: ConversionInboxView,
  thread: ConversionInboxSelectedThreadView,
  security: ConversionInboxActionSecurity | undefined,
): string {
  const draft = thread.draft;
  const version = draft.versionNumber === null ? 'Unsaved test draft' : `Immutable test draft v${draft.versionNumber}`;
  const messageId = draft.messageId;
  const approvalRequestId = draft.approvalRequestId;
  const decisionKey = approvalRequestId ? security?.decisionKeys[approvalRequestId] : undefined;
  const queueKey = messageId ? security?.queueKeys[messageId] : undefined;
  const canDecide = view.canManage && draft.approvalState === 'pending'
    && !draft.bodyTruncated && approvalRequestId !== null && decisionKey && security;
  const canQueue = view.canManage && !draft.bodyTruncated && draft.mayQueueTestOperation
    && messageId !== null && draft.rowVersion !== null && queueKey && security;
  const decision = canDecide ? `<form class="ci-review-form" method="post" action="${escapeHtml(conversionInboxDecisionRoute(approvalRequestId))}">${protectedFields(view, thread, security, decisionKey)}<label>Reviewer note<textarea name="decision_note" maxlength="4000" placeholder="Required for changes or rejection"></textarea></label><div class="ci-review-actions"><button class="ci-primary" type="submit" name="decision" value="approved">Approve exact v${escapeHtml(draft.versionNumber ?? '—')}</button><button class="ci-warn" type="submit" name="decision" value="changes_requested">Request changes</button><button class="ci-danger" type="submit" name="decision" value="rejected">Reject</button></div></form>` : '';
  const queue = canQueue ? `<form class="ci-action-form" method="post" action="${escapeHtml(conversionInboxTestQueueRoute(messageId))}">${protectedFields(view, thread, security, queueKey)}<input type="hidden" name="expected_row_version" value="${escapeHtml(draft.rowVersion)}"><input type="hidden" name="purpose" value="${escapeHtml(draft.purpose)}"><button class="ci-primary" type="submit">Queue TEST operation</button></form>` : `<button class="ci-primary" type="button" disabled>${draft.bodyTruncated ? 'Full review required' : draft.mayQueueTestOperation ? 'Queue permission required' : 'Approval gate locked'}</button>`;
  return `<section class="ci-composer" aria-labelledby="ci-draft-title">
    <div class="ci-composer-top"><strong id="ci-draft-title">Reply draft</strong><span class="ci-version">${escapeHtml(version)}</span></div>
    <textarea aria-labelledby="ci-draft-title" maxlength="8192" readonly>${escapeHtml(draft.body)}</textarea>${draft.bodyTruncated ? '<span class="ci-truncated" role="alert">Long draft clipped at the safe display boundary. Approval, editing and queueing are locked until the complete draft can be reviewed.</span>' : ''}
    <div class="ci-composer-bar">
      <div class="ci-gate-copy"><strong>${escapeHtml(draft.approvalLabel)} · ${escapeHtml(draft.deliveryLabel)}</strong>${escapeHtml(draft.gateDetail)}</div>
      <div class="ci-draft-actions" aria-label="Test draft controls">${queue}</div>
    </div>
    ${decision}<p class="ci-preview-note">Protected controls create approval evidence or a non-routable TEST queue record only. They cannot contact anyone or invoke a live provider.</p>
  </section>`;
}

function editableComposer(
  view: ConversionInboxView,
  thread: ConversionInboxSelectedThreadView,
  security: ConversionInboxActionSecurity,
): string {
  const draft = thread.draft;
  const messageId = draft.messageId;
  const version = draft.versionNumber === null ? 'New test draft' : `Immutable test draft v${draft.versionNumber}`;
  if (messageId === null) {
    const commandKey = security.createDraftKeys[thread.summary.conversationId];
    if (!commandKey || !thread.contactPointId) return readOnlyComposer(view, thread, security);
    return `<section class="ci-composer" aria-labelledby="ci-draft-title"><form method="post" action="${CONVERSION_INBOX_CREATE_DRAFT_ROUTE}">${protectedFields(view, thread, security, commandKey)}<input type="hidden" name="conversation_id" value="${escapeHtml(thread.summary.conversationId)}"><input type="hidden" name="contact_point_id" value="${escapeHtml(thread.contactPointId)}"><div class="ci-composer-top"><label id="ci-draft-title" for="ci-reply-draft">Reply draft</label><span class="ci-version">${escapeHtml(version)}</span></div><textarea id="ci-reply-draft" name="body" maxlength="8192" required>${escapeHtml(draft.body)}</textarea><div class="ci-composer-bar"><div class="ci-gate-copy"><strong>Draft only · nothing queued</strong>Create immutable version 1 before human review.</div><div class="ci-draft-actions"><button class="ci-primary" type="submit">Create TEST draft</button></div></div></form><p class="ci-preview-note">Saving creates database evidence only. No provider can be called from this control.</p></section>`;
  }
  const reviseKey = security.reviseDraftKeys[messageId];
  const requestKey = security.requestApprovalKeys[messageId];
  if (!reviseKey || !requestKey || draft.rowVersion === null) return readOnlyComposer(view, thread, security);
  return `<section class="ci-composer" aria-labelledby="ci-draft-title"><form method="post" action="${escapeHtml(conversionInboxReviseDraftRoute(messageId))}">${protectedFields(view, thread, security, reviseKey)}<input type="hidden" name="expected_row_version" value="${escapeHtml(draft.rowVersion)}"><div class="ci-composer-top"><label id="ci-draft-title" for="ci-reply-draft">Reply draft</label><span class="ci-version">${escapeHtml(version)}</span></div><textarea id="ci-reply-draft" name="body" maxlength="8192" required>${escapeHtml(draft.body)}</textarea><div class="ci-composer-bar"><div class="ci-gate-copy"><strong>${escapeHtml(draft.approvalLabel)} · ${escapeHtml(draft.deliveryLabel)}</strong>${escapeHtml(draft.gateDetail)}</div><div class="ci-draft-actions"><button type="submit">Save new immutable version</button></div></div></form><form class="ci-review-form" method="post" action="${escapeHtml(conversionInboxRequestApprovalRoute(messageId))}">${protectedFields(view, thread, security, requestKey)}<input type="hidden" name="expected_row_version" value="${escapeHtml(draft.rowVersion)}"><label>Review brief<textarea name="review_note" maxlength="4000" placeholder="What must the reviewer verify?"></textarea></label><div class="ci-review-actions"><button class="ci-primary" type="submit">Request human approval</button></div></form><p class="ci-preview-note">Every save creates a new immutable body hash. Approval never carries across to changed copy.</p></section>`;
}

function renderComposer(
  view: ConversionInboxView,
  thread: ConversionInboxSelectedThreadView,
  security: ConversionInboxActionSecurity | undefined,
): string {
  if (view.canWrite && security && thread.draft.lifecycle === 'draft'
      && !thread.draft.bodyTruncated) {
    return editableComposer(view, thread, security);
  }
  return readOnlyComposer(view, thread, security);
}

function renderConsent(consent: ConversionInboxConsentView, timezone: string): string {
  const detail = consent.basis
    ? `${escapeHtml(consent.basis)}${consent.updatedAt ? ` · ${dateTime(consent.updatedAt, timezone, true)}` : ''}`
    : 'No usable basis is recorded in this test snapshot.';
  return `<li class="ci-consent" data-state="${escapeHtml(consent.state)}"><div class="ci-consent-top"><strong>${escapeHtml(consent.channelLabel)}</strong><span class="ci-consent-badge">${escapeHtml(consent.stateLabel)}</span></div><p>${detail}</p></li>`;
}

function deliveryExplanation(state: ConversionInboxDeliveryState): string {
  if (state === 'not_queued') return 'No provider operation exists for this exact draft. No message left Growth HQ.';
  if (state === 'queued') return 'A simulator-only operation is waiting in the TEST queue. No message left Growth HQ.';
  return `The simulator recorded “${state}”. No message left Growth HQ.`;
}

function renderContext(thread: ConversionInboxSelectedThreadView, timezone: string): string {
  const lead = thread.lead;
  const draft = thread.draft;
  const consentComplete = draft.consentAllowsQueueing;
  return `<aside class="ci-context" aria-label="Lead and safety context">
    <section aria-labelledby="ci-lead-title"><h2 id="ci-lead-title">Lead 360 context</h2><span class="ci-lead-name">${escapeHtml(lead.displayName)}</span>${lead.companyName ? `<span class="ci-company">${escapeHtml(lead.companyName)}</span>` : ''}
      <div class="ci-lead-grid"><div class="ci-stat"><span>Journey stage</span><strong>${escapeHtml(lead.stageLabel)}</strong></div><div class="ci-stat"><span>Lead score</span><strong class="ci-score">${lead.score === null ? '—' : escapeHtml(Math.round(Math.max(0, Math.min(100, lead.score))))}</strong></div></div>
      <p class="ci-fact"><b>Source:</b> ${escapeHtml(lead.sourceLabel)}</p>${lead.affiliateLabel ? `<p class="ci-fact"><b>Affiliate:</b> ${escapeHtml(lead.affiliateLabel)}</p>` : ''}${lead.nextMove ? `<p class="ci-fact"><b>Next move:</b> ${escapeHtml(lead.nextMove)}</p>` : ''}
      <a class="ci-lead-link" href="/portal/crm/contacts/${encodeURIComponent(lead.contactId)}">Open full Lead 360</a>
    </section>
    <section aria-labelledby="ci-consent-title"><h2 id="ci-consent-title">Consent checkpoint</h2><ul class="ci-consents">${thread.consents.map((consent) => renderConsent(consent, timezone)).join('')}</ul></section>
    <section aria-labelledby="ci-gate-title"><h2 id="ci-gate-title">Outbound safety gate</h2>
      <ol class="ci-gate"><li data-complete="${draft.versionNumber !== null}"><span class="ci-step">1</span><span class="ci-step-copy"><strong>Exact draft version</strong><span>${draft.versionNumber === null ? 'No immutable version yet.' : `Version ${escapeHtml(draft.versionNumber)} is the review target.`}</span></span></li><li data-complete="${draft.exactApproval}"><span class="ci-step">2</span><span class="ci-step-copy"><strong>Human approval</strong><span>${escapeHtml(draft.approvalLabel)}${draft.approvalNote ? ` · ${escapeHtml(draft.approvalNote)}` : ''}</span></span></li><li data-complete="${consentComplete}"><span class="ci-step">3</span><span class="ci-step-copy"><strong>Current consent</strong><span>${consentComplete ? 'Permitted inside the test snapshot.' : 'Gate remains closed.'}</span></span></li></ol>
      <div class="ci-delivery-card" data-delivery-state="${escapeHtml(draft.deliveryState)}"><strong>${escapeHtml(draft.deliveryLabel)}</strong><p>${escapeHtml(deliveryExplanation(draft.deliveryState))}</p></div>
    </section>
  </aside>`;
}

function renderSelected(
  view: ConversionInboxView,
  security: ConversionInboxActionSecurity | undefined,
): string {
  const thread = view.selectedThread;
  if (!thread) return '<section class="ci-empty-thread"><div><h2>Select a loaded test conversation</h2><p>The thread, Lead 360 context, consent check and approval gate will appear here. No provider is connected.</p></div></section>';
  return `<main class="ci-thread" aria-labelledby="ci-thread-title">
    <header class="ci-thread-head"><div class="ci-thread-person"><h2 id="ci-thread-title">${escapeHtml(thread.lead.displayName)}</h2><p>${escapeHtml(thread.summary.subject ?? thread.summary.channelLabel)} · ${escapeHtml(thread.summary.stateLabel)}</p></div><span class="ci-test-stamp">${escapeHtml(thread.summary.channelLabel)}<br>TEST / SIMULATED</span></header>
    ${renderRailActivity(thread, view.timezone)}${renderTranscript(thread, view.timezone)}${renderComposer(view, thread, security)}
  </main>${renderContext(thread, view.timezone)}`;
}

function renderNotice(view: ConversionInboxView): string {
  if (!view.notice) return '';
  return `<aside class="ci-notice" data-kind="${escapeHtml(view.notice.kind)}" role="status"><strong>${escapeHtml(view.notice.title)}</strong><p>${escapeHtml(view.notice.message)}</p></aside>`;
}

export function renderConversionInboxBody(
  view: ConversionInboxView,
  options: RenderConversionInboxOptions = {},
): string {
  const queueOptions: readonly Readonly<{ value: ConversionInboxQueueFilter; label: string }>[] = [
    { value: 'all', label: 'Everything loaded' }, { value: 'unread', label: 'Unread' },
    { value: 'approval', label: 'Approval & rework' }, { value: 'open', label: 'Open' },
  ];
  return `<section class="ci" data-property-predator-conversion-inbox data-environment="test">
    <style>${CONVERSION_INBOX_STYLE}</style><a class="ci-skip" href="#ci-transcript">Skip to transcript</a>
    <header class="ci-head"><div><span class="ci-kicker">Growth HQ · Conversion Inbox</span><h1>Every channel. <em>One human queue.</em></h1><p>Turn engagement into confident conversations with the lead journey, consent and exact approval state visible beside every reply.</p></div><div class="ci-mode"><strong>TEST / SIMULATED</strong><span>Contact records may be workspace CRM data. Provider adapters are non-routable; no message here has contacted anyone.</span></div></header>
    <div class="ci-truth"><strong>Safety boundary</strong><p>Delivery labels describe simulator outcomes only. An approved draft is still blocked unless current channel consent also agrees.</p><span class="ci-snapshot">${escapeHtml(view.workspaceName)} · Snapshot ${dateTime(view.asOf, view.timezone)}</span></div>${renderNotice(view)}
    <form class="ci-toolbar" method="get" action="${CONVERSION_INBOX_ROUTE}" aria-label="Filter loaded test conversations"><div class="ci-field"><label for="ci-query">Search loaded queue</label><input id="ci-query" name="q" type="search" maxlength="80" value="${escapeHtml(view.filters.query)}" placeholder="Person, subject or message"></div><div class="ci-field"><label for="ci-queue-filter">Work queue</label><select id="ci-queue-filter" name="queue">${queueOptions.map((item) => `<option value="${item.value}"${item.value === view.filters.queue ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}</select></div>${view.filters.channel !== 'all' ? `<input type="hidden" name="channel" value="${escapeHtml(view.filters.channel)}">` : ''}<button class="ci-button" type="submit">Apply filters</button><a class="ci-clear" href="${CONVERSION_INBOX_ROUTE}">Clear</a></form>
    <div class="ci-workspace">${renderChannelRail(view)}${renderQueue(view)}${renderSelected(view, options.security)}</div>
    <div class="ci-sr" role="status" aria-live="polite">${escapeHtml(loadedConversationLabel(view.matchingConversationCount))} ${view.matchingConversationCount === 1 ? 'matches' : 'match'} the current filters.</div>
  </section>`;
}
