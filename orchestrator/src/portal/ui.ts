/**
 * Dependency-free portal design system.  The portal is server rendered, so the
 * shell deliberately uses native HTML controls (details/summary, forms and
 * anchors) instead of pretending that client-side application state exists.
 */

import { CORE_PLATFORM_MODULES, platformModules, type PlatformModuleId, type PlatformModuleManifest } from '../platform/modules.js';
import type { PlatformCapability } from '../platform/capabilities.js';
import { RELAUNCH72_PRODUCT_PROFILE, type PortalProductProfile } from './product-profile.js';

export type PortalSection = 'overview' | 'crm' | 'journeys' | 'content' | 'inbox' | 'billing';

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]!));
}

type IconName = 'activity' | 'automation' | 'billing' | 'calendar' | 'chevron' | 'contacts' | 'content' |
  'inbox' | 'listening' | 'lock' | 'logout' | 'overview' | 'pipeline' | 'search' | 'social' | 'sparkles';

const ICON_PATHS: Record<IconName, string> = {
  activity: '<path d="M4 12h3l2-6 4 12 2-6h5"/>',
  automation: '<path d="M7 7h4V3m6 14h-4v4M5 17a8 8 0 0 1 12-10l2 2M19 7A8 8 0 0 1 7 17l-2-2"/>',
  billing: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h3"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  contacts: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  content: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
  inbox: '<path d="M4 4h16v13H4z"/><path d="m4 13 4 4h8l4-4M8 8h8"/>',
  listening: '<path d="M4 12a8 8 0 0 1 16 0M7 12a5 5 0 0 1 10 0M10 12a2 2 0 0 1 4 0"/><path d="M12 14v7"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  logout: '<path d="M10 17l5-5-5-5M15 12H3M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/>',
  overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  pipeline: '<path d="M4 5h16M4 12h10M4 19h6"/><circle cx="19" cy="12" r="2"/><circle cx="15" cy="19" r="2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  social: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/>',
  sparkles: '<path d="m12 3 1.4 3.6L17 8l-3.6 1.4L12 13l-1.4-3.6L7 8l3.6-1.4zM19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8zM5 14l.6 1.4L7 16l-1.4.6L5 18l-.6-1.4L3 16l1.4-.6z"/>',
};

const MODULE_ICONS: Record<PlatformModuleId, IconName> = {
  overview: 'overview', crm: 'contacts', journeys: 'automation', content: 'content', social: 'social', inbox: 'inbox',
  listening: 'listening', webinars: 'calendar', automations: 'automation', analytics: 'activity', settings: 'billing',
};

export const plannedPortalModules: readonly PlatformModuleManifest[] = CORE_PLATFORM_MODULES.filter((module) => module.stage === 'planned');

export function portalModuleIcon(id: PlatformModuleId, className = 'icon'): string {
  return icon(MODULE_ICONS[id], className);
}

export function icon(name: IconName, className = 'icon'): string {
  return `<svg class="${escapeHtml(className)}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`;
}

export const PORTAL_STYLE = `
  :root{
    color-scheme:light;
    --canvas:#f4f6f8;--panel:#fff;--panel-subtle:#f8f9fb;--panel-strong:#edf1f5;
    --nav:#101827;--nav-raised:#192337;--nav-line:#28354a;--nav-text:#f7f9fc;--nav-muted:#9aa8bb;
    --ink:#152033;--muted:#657187;--faint:#59677d;--line:#dfe4eb;--line-strong:#cbd3df;
    --accent:#ed9c24;--accent-deep:#a85c0c;--accent-soft:#fff5e4;--success:#0b6a4d;--success-soft:#e9f7f1;
    --danger:#b74242;--danger-soft:#fff0ef;--info:#2f63b7;--info-soft:#edf4ff;
    --shadow-sm:0 1px 2px rgba(16,24,39,.045),0 5px 14px rgba(16,24,39,.035);
    --shadow-lg:0 20px 55px rgba(16,24,39,.16);--radius:16px;--radius-sm:11px;
    --sans:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
    --mono:"SFMono-Regular",Consolas,"Liberation Mono",monospace;
  }
  *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--canvas);color:var(--ink);font-family:var(--sans);line-height:1.5;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
  button,input,summary{font:inherit}button,a,summary{-webkit-tap-highlight-color:transparent}a{color:inherit;text-decoration:none}button{color:inherit}h1,h2,h3,h4,p{margin-top:0;overflow-wrap:anywhere}.icon{width:18px;height:18px;flex:0 0 auto}.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
  :focus-visible{outline:3px solid rgba(237,156,36,.72);outline-offset:3px}.skip-link{position:fixed;z-index:100;top:10px;left:12px;transform:translateY(-150%);background:var(--ink);color:#fff;padding:9px 13px;border-radius:9px;font-weight:750}.skip-link:focus{transform:none}

  .app-shell{min-height:100vh}.sidebar{position:fixed;inset:0 auto 0 0;z-index:20;width:264px;background:var(--nav);color:var(--nav-text);display:flex;flex-direction:column;padding:18px 14px 14px;border-right:1px solid #0a101c}
  .brand-lockup{display:flex;align-items:center;gap:10px;padding:4px 10px 18px}.brand-mark{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:linear-gradient(145deg,#ffc568,var(--accent));color:#161b25;font-family:var(--mono);font-weight:900;font-size:.74rem;box-shadow:0 7px 20px rgba(237,156,36,.2)}
  .brand-name{font-size:.86rem;font-weight:850;letter-spacing:.075em}.brand-name small{display:block;color:var(--nav-muted);font-size:.61rem;font-weight:650;letter-spacing:.08em;text-transform:uppercase;margin-top:1px}
  .workspace-menu{margin:0 2px 18px;position:relative}.workspace-menu summary{list-style:none;cursor:pointer;border:1px solid var(--nav-line);border-radius:12px;background:var(--nav-raised);padding:10px;display:grid;grid-template-columns:34px 1fr 16px;align-items:center;gap:9px}.workspace-menu summary::-webkit-details-marker{display:none}.workspace-menu[open] summary{border-color:#56647a}.workspace-avatar{width:34px;height:34px;border-radius:9px;background:#283b54;display:grid;place-items:center;font-weight:800;color:#dbe7f5}.workspace-copy{min-width:0}.workspace-copy strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.82rem}.workspace-copy small{display:block;color:var(--nav-muted);font-size:.67rem;margin-top:1px}.workspace-menu summary .chev{color:var(--nav-muted);width:14px;transition:transform .18s ease}.workspace-menu[open] summary .chev{transform:rotate(90deg)}
  .workspace-popover{position:absolute;z-index:30;top:calc(100% + 7px);left:0;right:0;background:#fff;color:var(--ink);border:1px solid var(--line);border-radius:12px;padding:8px;box-shadow:var(--shadow-lg)}.workspace-current{display:flex;align-items:center;gap:9px;padding:8px;border-radius:8px;background:var(--panel-subtle);font-size:.78rem;font-weight:750}.workspace-popover p{margin:7px 6px 3px;color:var(--muted);font-size:.68rem;line-height:1.4}
  .nav-label{color:#6f8097;font-family:var(--mono);font-size:.61rem;font-weight:750;letter-spacing:.11em;text-transform:uppercase;margin:15px 11px 7px}.primary-nav{display:flex;flex-direction:column;gap:3px;min-height:0;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#37465d transparent}.nav-item{width:100%;min-height:40px;border:0;border-radius:10px;display:flex;align-items:center;gap:11px;padding:9px 10px;background:transparent;color:var(--nav-muted);font-size:.82rem;font-weight:650;text-align:left}.nav-item:hover{background:rgba(255,255,255,.055);color:#fff}.nav-item[aria-current="page"]{color:#fff;background:rgba(237,156,36,.13);box-shadow:inset 3px 0 var(--accent)}.nav-item[aria-current="page"] .icon{color:var(--accent)}.nav-locked{cursor:not-allowed;color:#748398}.nav-locked:hover{color:#8796aa;background:rgba(255,255,255,.025)}.module-state{margin-left:auto;display:inline-flex;align-items:center;gap:4px;color:#77879c;font-family:var(--mono);font-size:.54rem;letter-spacing:.04em;text-transform:uppercase}.module-state .icon{width:11px;height:11px}.sidebar-foot{margin-top:auto;border-top:1px solid var(--nav-line);padding:13px 5px 2px}.sandbox-note{display:flex;gap:9px;align-items:flex-start;color:var(--nav-muted);font-size:.69rem;line-height:1.4;padding:5px}.sandbox-dot{width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px rgba(237,156,36,.1);margin:5px 2px 0;flex:0 0 auto}.sandbox-note strong{display:block;color:#d8e0eb;font-size:.7rem;margin-bottom:1px}

  .workspace{min-height:100vh;margin-left:264px}.topbar{height:70px;position:sticky;top:0;z-index:15;background:rgba(244,246,248,.9);backdrop-filter:blur(14px);border-bottom:1px solid rgba(203,211,223,.82);display:flex;align-items:center;justify-content:space-between;padding:0 34px;gap:16px}.mobile-brand{display:none}.top-actions{display:flex;align-items:center;gap:9px}.top-icon-button{width:38px;height:38px;border:1px solid var(--line);border-radius:11px;background:var(--panel);display:grid;place-items:center;cursor:pointer}.top-icon-button:hover{border-color:var(--line-strong);background:var(--panel-subtle)}
  .quick-menu{position:relative;width:min(420px,42vw)}.quick-menu summary{list-style:none;cursor:pointer;height:40px;border:1px solid var(--line);border-radius:11px;background:var(--panel);display:flex;align-items:center;gap:10px;color:var(--muted);padding:0 11px;box-shadow:var(--shadow-sm)}.quick-menu summary::-webkit-details-marker{display:none}.quick-menu summary:hover{border-color:var(--line-strong)}.quick-menu summary span{font-size:.82rem}.quick-menu summary kbd{margin-left:auto;border:1px solid var(--line);border-bottom-color:var(--line-strong);border-radius:6px;background:var(--panel-subtle);padding:2px 7px;font:600 .63rem var(--mono);color:var(--faint)}.command-popover{position:absolute;z-index:40;top:calc(100% + 8px);left:0;width:min(480px,calc(100vw - 36px));background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:9px;box-shadow:var(--shadow-lg)}.command-title{font:750 .61rem var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--faint);padding:7px 9px 5px}.command-link{display:flex;align-items:center;gap:10px;padding:9px;border-radius:9px;font-size:.8rem;font-weight:650}.command-link:hover{background:var(--panel-subtle)}.command-link small{margin-left:auto;color:var(--faint);font:650 .61rem var(--mono)}.command-link.locked{color:var(--muted);cursor:not-allowed}.command-link.locked small{display:flex;align-items:center;gap:4px;text-transform:uppercase}.command-link.locked .icon:last-child{width:11px;height:11px}
  .main{max-width:1420px;margin:0 auto;padding:32px 34px 78px}.page-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:25px}.eyebrow{display:flex;align-items:center;gap:7px;margin-bottom:8px;color:var(--accent-deep);font:750 .66rem var(--mono);letter-spacing:.095em;text-transform:uppercase}.eyebrow .icon{width:14px;height:14px}.page-heading h1{font-size:clamp(1.65rem,2.4vw,2.25rem);line-height:1.14;letter-spacing:-.035em;margin:0}.page-heading p{max-width:700px;color:var(--muted);font-size:.91rem;margin:8px 0 0}.page-heading-actions{display:flex;align-items:center;gap:9px;flex:0 0 auto}
  .button{appearance:none;border:1px solid transparent;border-radius:11px;min-height:42px;padding:9px 15px;display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--accent);color:#1b2028;font-weight:800;font-size:.82rem;cursor:pointer;box-shadow:0 5px 15px rgba(237,156,36,.16)}.button:hover{background:#f3a832;transform:translateY(-1px)}.button:active{transform:translateY(0)}.button.secondary{background:var(--panel);color:var(--ink);border-color:var(--line);box-shadow:var(--shadow-sm);font-weight:700}.button.secondary:hover{background:var(--panel-subtle);border-color:var(--line-strong)}.button.compact{min-height:36px;padding:7px 11px;font-size:.75rem}.button .icon{width:16px;height:16px}.run-helper{color:var(--faint);font-size:.69rem;margin-top:7px;text-align:right}
  .status-badge,.pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:4px 8px;font:750 .59rem var(--mono);letter-spacing:.055em;text-transform:uppercase}.status-badge{background:var(--accent-soft);color:var(--accent-deep);border:1px solid #f3d6a7}.status-badge .dot{width:6px;height:6px;border-radius:50%;background:var(--accent)}.pill{background:var(--panel-strong);color:var(--muted);border:1px solid var(--line)}.pill.draft{background:var(--info-soft);border-color:#cbddf9;color:var(--info)}.pill.paused{background:var(--accent-soft);border-color:#efd5ab;color:var(--accent-deep)}.pill.ok{background:var(--success-soft);border-color:#bee7d8;color:var(--success)}
  .metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px;margin-bottom:24px}.metric{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:17px 18px;box-shadow:var(--shadow-sm)}.metric-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:13px}.metric-icon{width:31px;height:31px;border-radius:9px;display:grid;place-items:center;background:var(--panel-strong);color:var(--muted)}.metric-icon .icon{width:16px;height:16px}.metric .n{font:800 1.65rem/1 var(--mono);letter-spacing:-.04em;font-variant-numeric:tabular-nums}.metric .l{color:var(--muted);font-size:.72rem;margin-top:7px}.metric-context{font-size:.64rem;color:var(--faint)}
  .dashboard-grid{display:grid;grid-template-columns:minmax(0,1.75fr) minmax(280px,.75fr);gap:18px;align-items:start}.stack{display:grid;gap:18px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow-sm);overflow:hidden}.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:18px 19px 14px}.panel-title-wrap{min-width:0}.panel h2,.panel h3{font-size:.91rem;letter-spacing:-.01em;margin:0}.panel-subtitle{font-size:.72rem;color:var(--muted);margin:4px 0 0}.panel-body{padding:0 19px 19px}.panel-divider{border-top:1px solid var(--line)}
  .pipeline{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}.stage{position:relative;min-height:91px;background:var(--panel-subtle);border:1px solid var(--line);border-radius:11px;padding:12px;overflow:hidden}.stage::after{content:"";position:absolute;inset:auto 0 0;height:3px;background:var(--stage-color,var(--faint));opacity:.75}.stage .c{font:800 1.35rem/1.1 var(--mono);font-variant-numeric:tabular-nums}.stage .l{font-size:.68rem;color:var(--muted);text-transform:capitalize;margin-top:8px}.stage .share{font-size:.59rem;color:var(--faint);margin-top:3px}.stage-won{--stage-color:var(--success)}.stage-lost{--stage-color:var(--danger)}.stage-qualified{--stage-color:var(--accent)}.stage-contacted{--stage-color:var(--info)}
  .content-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.draft-card{border:1px solid var(--line);border-radius:12px;background:var(--panel-subtle);padding:15px;min-width:0}.draft-card.wide{grid-column:1/-1}.draft-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:11px}.draft-label{font:750 .61rem var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--faint)}.draft-card h4{font-size:.86rem;line-height:1.4;margin:0 0 7px}.draft-card p{font-size:.76rem;color:var(--muted);line-height:1.55;margin:0}.draft-card .hook{color:var(--ink);font-weight:740;font-size:.82rem;margin-bottom:5px}.draft-list{list-style:none;padding:0;margin:0}.draft-list li{display:grid;grid-template-columns:64px 1fr;gap:10px;padding:10px 0;border-top:1px solid var(--line);font-size:.78rem}.draft-list li:first-child{border-top:0;padding-top:1px}.draft-role{font:700 .56rem var(--mono);letter-spacing:.04em;text-transform:uppercase;color:var(--faint)}
  .keyword-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;padding:9px 0;border-top:1px solid var(--line);font-size:.76rem}.keyword-row:first-child{border-top:0}.keyword-row .volume{font:750 .7rem var(--mono);color:var(--accent-deep)}.ad-headlines{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}.ad-headlines span{border:1px solid var(--line);border-radius:7px;padding:4px 7px;background:var(--panel);font-size:.68rem;color:var(--ink)}
  .data-table{width:100%;border-collapse:collapse;font-size:.78rem}.data-table th{text-align:left;color:var(--faint);font:750 .59rem var(--mono);letter-spacing:.07em;text-transform:uppercase;padding:10px 8px;border-bottom:1px solid var(--line)}.data-table td{padding:12px 8px;border-bottom:1px solid var(--line);vertical-align:middle}.data-table tbody tr:last-child td{border-bottom:0}.contact-name{font-weight:720}.contact-reach{font-family:var(--mono);font-size:.68rem;color:var(--muted);word-break:break-word}.stage-badge{display:inline-flex;justify-self:start;border:1px solid var(--line);background:var(--panel-subtle);border-radius:999px;padding:3px 8px;font:700 .58rem var(--mono);text-transform:capitalize;color:var(--muted)}
  .timeline{position:relative}.event{display:grid;grid-template-columns:28px 1fr;gap:10px;padding:9px 0}.event:not(:last-child){border-bottom:1px solid var(--line)}.event-icon{width:27px;height:27px;border-radius:8px;background:var(--panel-strong);color:var(--muted);display:grid;place-items:center;font:800 .67rem var(--mono)}.event-icon.run{background:var(--accent-soft);color:var(--accent-deep)}.event-summary{font-size:.75rem;line-height:1.45}.event-time{font:600 .58rem var(--mono);color:var(--faint);margin-top:3px}.brand-quote{border-left:3px solid var(--accent);padding-left:12px;color:var(--muted);font-size:.76rem;line-height:1.55;margin:2px 0 14px}.pillar{display:grid;grid-template-columns:19px 1fr;gap:7px;align-items:start;padding:6px 0;font-size:.75rem}.pillar-index{color:var(--accent-deep);font:800 .67rem var(--mono)}
  .empty-state{border:1px dashed var(--line-strong);border-radius:12px;background:var(--panel-subtle);padding:22px;text-align:center;color:var(--muted)}.empty-icon{width:36px;height:36px;margin:0 auto 9px;border-radius:10px;background:var(--panel-strong);display:grid;place-items:center;color:var(--faint)}.empty-state strong{display:block;color:var(--ink);font-size:.82rem;margin-bottom:4px}.empty-state p{max-width:420px;margin:0 auto;font-size:.72rem;line-height:1.5}
  .plan-card-inline{display:flex;align-items:center;justify-content:space-between;gap:12px}.plan-name{font-size:.85rem;font-weight:740}.status{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;padding:4px 8px;font:750 .57rem var(--mono);letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}.status .dot{width:6px;height:6px;border-radius:50%;background:var(--faint)}.status.ok{color:var(--success);border-color:#a9dcca;background:var(--success-soft)}.status.ok .dot{background:var(--success)}.status.warn{color:var(--accent-deep);border-color:#ecd09f;background:var(--accent-soft)}.status.warn .dot{background:var(--accent)}.billing-link{display:inline-flex;align-items:center;gap:4px;margin-top:13px;color:var(--accent-deep);font-size:.71rem;font-weight:760}.billing-link .icon{width:12px;height:12px}
  .module-preview{margin-top:24px}.module-preview-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px}.module-card{min-height:105px;border:1px solid var(--line);border-radius:13px;background:linear-gradient(145deg,var(--panel),var(--panel-subtle));padding:13px;color:var(--muted)}.module-card-top{display:flex;align-items:center;justify-content:space-between;gap:7px}.module-card .icon{color:var(--faint)}.module-card h3{font-size:.73rem;margin:13px 0 3px;color:var(--ink)}.module-card p{font-size:.63rem;line-height:1.4;margin:0}.lock-label{display:inline-flex;align-items:center;gap:3px;color:var(--faint);font:700 .52rem var(--mono);text-transform:uppercase}.lock-label .icon{width:10px;height:10px}
  .notice{display:flex;align-items:flex-start;gap:10px;border:1px solid #efd09a;background:var(--accent-soft);color:#71430d;border-radius:12px;padding:12px 14px;margin-bottom:18px;font-size:.77rem}.notice .icon{width:16px;height:16px;margin-top:1px;flex:0 0 auto}.billing-summary{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap}.billing-summary h2{font-size:1.06rem;margin:0}.billing-summary p{font-size:.77rem;color:var(--muted);margin:4px 0 0}.billing-actions{display:flex;align-items:center;gap:9px}.plans{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px}.plan{border:1px solid var(--line);border-radius:14px;background:var(--panel-subtle);padding:17px;display:flex;flex-direction:column;min-height:220px}.plan.current{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent);background:var(--accent-soft)}.plan h3{font-size:.88rem;margin:0}.plan-price{font:850 1.35rem var(--mono);letter-spacing:-.04em;color:var(--ink);margin:8px 0}.plan-description{color:var(--muted);font-size:.73rem;line-height:1.55;flex:1;margin:0 0 14px}.current-plan-tag{color:var(--accent-deep);font:750 .59rem var(--mono);letter-spacing:.04em;text-transform:uppercase}

  .auth-shell{min-height:100vh;display:grid;grid-template-columns:minmax(320px,.9fr) minmax(420px,1.1fr);background:var(--panel)}.auth-panel{display:grid;place-items:center;padding:44px 28px}.auth-card{width:100%;max-width:420px}.auth-brand{display:flex;align-items:center;gap:10px;margin-bottom:42px}.auth-brand .brand-mark{width:38px;height:38px}.auth-brand strong{letter-spacing:.08em;font-size:.86rem}.auth-card h1{font-size:2rem;letter-spacing:-.04em;margin:0 0 8px}.auth-lead{color:var(--muted);font-size:.88rem;margin-bottom:26px}.field{margin-bottom:15px}.field label{display:block;color:var(--ink);font-size:.72rem;font-weight:740;margin:0 0 6px}.field input{width:100%;height:45px;border:1px solid var(--line-strong);border-radius:11px;background:#fff;color:var(--ink);padding:0 12px;font-size:.88rem}.field input:hover{border-color:#abb6c5}.field input:focus{border-color:var(--accent);box-shadow:0 0 0 4px rgba(237,156,36,.11)}.field input:focus-visible{outline:3px solid var(--accent);outline-offset:2px}.auth-button{width:100%;margin-top:7px}.auth-error{display:flex;gap:8px;border:1px solid #f0c0bd;background:var(--danger-soft);color:var(--danger);border-radius:10px;padding:10px 11px;font-size:.76rem;margin-bottom:16px}.auth-error .icon{width:15px;height:15px}.auth-foot{color:var(--faint);font-size:.67rem;text-align:center;margin:19px 0 0}.auth-story{position:relative;overflow:hidden;background:var(--nav);color:var(--nav-text);padding:8vh 7vw;display:flex;flex-direction:column;justify-content:center}.auth-story::before{content:"";position:absolute;width:520px;height:520px;right:-180px;top:-220px;border-radius:50%;background:radial-gradient(circle,rgba(237,156,36,.22),transparent 67%)}.auth-story-inner{position:relative;max-width:580px}.auth-kicker{color:var(--accent);font:750 .65rem var(--mono);letter-spacing:.11em;text-transform:uppercase}.auth-story h2{font-size:clamp(2.2rem,4vw,4rem);line-height:1.02;letter-spacing:-.05em;margin:17px 0 21px}.auth-story p{max-width:500px;color:#aeb9c8;font-size:.9rem;line-height:1.7}.auth-modules{display:flex;flex-wrap:wrap;gap:7px;margin-top:30px}.auth-modules span{border:1px solid var(--nav-line);background:rgba(255,255,255,.035);border-radius:999px;padding:6px 10px;color:#c7d0dc;font-size:.66rem}.auth-modules .planned{color:#8290a4}
  .mobile-nav{display:none}

  @media(max-width:1120px){.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.module-preview-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.dashboard-grid{grid-template-columns:minmax(0,1.5fr) minmax(260px,.8fr)}}
  @media(max-width:880px){.sidebar{display:none}.workspace{margin-left:0}.topbar{height:62px;padding:0 18px}.mobile-brand{display:flex;align-items:center;gap:8px}.mobile-brand .brand-mark{width:30px;height:30px;border-radius:8px;font-size:.63rem}.mobile-brand strong{font-size:.72rem;letter-spacing:.07em}.quick-menu{width:auto;margin-left:auto}.quick-menu summary{width:40px;padding:0;justify-content:center}.quick-menu summary span,.quick-menu summary kbd{display:none}.command-popover{position:fixed;top:70px;left:18px;right:18px;width:auto;max-height:calc(100vh - 90px);overflow:auto}.main{padding:25px 18px calc(102px + env(safe-area-inset-bottom))}.dashboard-grid{grid-template-columns:1fr}.module-preview-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.mobile-nav{display:grid;grid-template-columns:repeat(var(--mobile-nav-count),minmax(0,1fr));position:fixed;z-index:25;left:10px;right:10px;bottom:calc(10px + env(safe-area-inset-bottom));background:rgba(16,24,39,.96);backdrop-filter:blur(14px);border:1px solid var(--nav-line);border-radius:15px;padding:5px;box-shadow:0 18px 42px rgba(16,24,39,.28)}.mobile-nav a{display:flex;min-height:56px;flex-direction:column;align-items:center;justify-content:center;gap:3px;color:#9aa8bb;font-size:.66rem;font-weight:700;border-radius:10px}.mobile-nav a[aria-current="page"],.mobile-nav a:active{color:#fff;background:rgba(237,156,36,.13)}.mobile-nav .icon{width:17px;height:17px}.auth-shell{grid-template-columns:1fr}.auth-story{display:none}}
  @media(max-width:640px){html{scroll-padding-top:74px}.page-heading{display:block}.page-heading-actions{margin-top:17px}.page-heading-actions form,.page-heading-actions .button{width:100%}.run-helper{text-align:left}.metric-grid{gap:9px}.metric{padding:14px}.pipeline{grid-template-columns:repeat(2,minmax(0,1fr))}.pipeline .stage:last-child{grid-column:1/-1}.content-grid{grid-template-columns:1fr}.draft-card.wide{grid-column:auto}.module-preview-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.plans{grid-template-columns:1fr}.panel-head{padding:16px 15px 12px}.panel-body{padding:0 15px 15px}.data-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.data-table,.data-table tbody,.data-table tr,.data-table td{display:block;width:100%}.data-table tr{padding:10px 0;border-bottom:1px solid var(--line)}.data-table tr:last-child{border-bottom:0}.data-table td{display:grid;grid-template-columns:78px 1fr;gap:9px;border:0;padding:4px 0}.data-table td::before{content:attr(data-label);color:var(--faint);font:700 .56rem var(--mono);letter-spacing:.05em;text-transform:uppercase}.auth-panel{padding:28px 20px}.auth-brand{margin-bottom:34px}}
  @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*::before,*::after{scroll-behavior:auto!important;transition:none!important;animation:none!important}.button:hover{transform:none}}
  @media(forced-colors:active){.brand-mark,.button,.status-badge,.pill,.status,.stage-badge{forced-color-adjust:none}.nav-item[aria-current="page"]{outline:2px solid Highlight}.field input:focus-visible{outline:3px solid Highlight}.stage::after{background:CanvasText}.skip-link{border:1px solid ButtonText}}
`;

function profileTheme(profile: PortalProductProfile): string {
  const theme = profile.theme;
  const predator = profile.id === 'property_predator_growth'
    ? `:root{color-scheme:dark;--sans:Syne,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"IBM Plex Mono","SFMono-Regular",Consolas,monospace;--display:"Cormorant Garamond",Georgia,serif;--success:#22c55e;--success-soft:#10291d;--danger:#ef4444;--danger-soft:#321719;--info:#72a7ff;--info-soft:#121f34;--shadow-sm:none;--shadow-lg:none;--radius:14px;--radius-sm:10px}
      .topbar{background:rgba(5,6,8,.91);border-bottom-color:var(--line)}.sidebar{border-right-color:var(--line)}
      .brand-name{font-family:var(--display);font-size:1.06rem;font-weight:600;letter-spacing:-.01em}.brand-name .brand-accent{color:var(--accent)}.brand-name small{font-family:var(--mono);font-size:.54rem;letter-spacing:.14em;margin-top:4px}
      .brand-mark{background:var(--nav);box-shadow:none;border-radius:0;color:var(--accent)}.brand-mark svg{width:31px;height:31px}
      .workspace-avatar{background:var(--panel-strong);color:var(--ink)}.workspace-popover{background:var(--panel);color:var(--ink)}
      .nav-item[aria-current="page"]{color:var(--ink);background:rgba(0,229,204,.07);box-shadow:inset 2px 0 var(--accent)}.nav-item[aria-current="page"] .icon{color:var(--accent)}
      .button{color:#03110f;box-shadow:none}.button:hover{background:#00ffde}.button.secondary{color:var(--ink)}
      .status-badge{border-color:#185047}.panel,.metric,.growth-metric,.crm-panel{box-shadow:none}
      .field input,.crm-field input,.crm-field select,.crm-move-field select{background:var(--panel-strong);color:var(--ink);border-color:var(--line-strong)}
      .auth-story h2,.growth-hero h1,.pp-display{font-family:var(--display);font-weight:600;letter-spacing:-.025em}
      .mobile-nav{background:rgba(5,6,8,.96)!important}`
    : ':root{--display:Georgia,serif}';
  return `:root{--canvas:${theme.canvas};--panel:${theme.panel};--panel-subtle:${theme.panelSubtle};--panel-strong:${theme.panelStrong};--ink:${theme.ink};--muted:${theme.muted};--faint:${theme.faint};--line:${theme.line};--line-strong:${theme.lineStrong};--accent:${theme.accent};--accent-deep:${theme.accentDeep};--accent-soft:${theme.accentSoft};--nav:${theme.nav};--nav-raised:${theme.navRaised};--nav-line:${theme.navLine};--nav-text:${theme.navText};--nav-muted:${theme.navMuted}}${predator}`;
}

function predatorMark(): string {
  return '<svg viewBox="0 0 512 512" aria-hidden="true" focusable="false"><path d="M256 96 388 176v160L256 416 124 336V176Z" fill="none" stroke="currentColor" stroke-width="30" stroke-linejoin="round"/><circle cx="256" cy="256" r="52" fill="currentColor"/></svg>';
}

export function productBrandMark(profile: PortalProductProfile): string {
  return profile.id === 'property_predator_growth' ? predatorMark() : escapeHtml(profile.compactMark);
}

export function productBrandName(profile: PortalProductProfile): string {
  return profile.id === 'property_predator_growth'
    ? '<span>Property</span><span class="brand-accent">Predator</span>'
    : escapeHtml(profile.productName);
}

export function pageHead(title: string, productProfile: PortalProductProfile = RELAUNCH72_PRODUCT_PROFILE): string {
  const brandFonts = productProfile.id === 'property_predator_growth'
    ? '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Syne:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap">'
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="${productProfile.theme.nav}"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title>${brandFonts}<style>${PORTAL_STYLE}${profileTheme(productProfile)}</style></head>`;
}

export interface AppShellOptions {
  title: string;
  tenantName: string;
  active: PortalSection;
  body: string;
  /** Trusted deployment presentation only. It never grants a capability. */
  productProfile?: PortalProductProfile;
  /** Capabilities proven by the composed services for this exact response. */
  capabilities?: ReadonlySet<PlatformCapability>;
  billingAvailable?: boolean;
  /** Only advertise CRM routes when a real workspace service is wired. */
  crmAvailable?: boolean;
  /** Changes truth labels only; it never unlocks a capability. */
  mode?: 'sandbox' | 'crm';
  /** Session-bound synchronizer token for shell-level authenticated forms. */
  csrfToken?: string;
}

function workspaceInitial(name: string): string {
  const first = Array.from(name.trim())[0] ?? 'W';
  return escapeHtml(first.toLocaleUpperCase('en-GB'));
}

function plannedNav(module: PlatformModuleManifest): string {
  return `<span class="nav-item nav-locked" role="link" aria-disabled="true" title="${escapeHtml(module.label)} is planned and not available in this sandbox">${portalModuleIcon(module.id)}<span>${escapeHtml(module.shortLabel)}</span><span class="module-state">${icon('lock')}Planned</span></span>`;
}

export function appShell(opts: AppShellOptions): string {
  const profile = opts.productProfile ?? RELAUNCH72_PRODUCT_PROFILE;
  const tenant = escapeHtml(opts.tenantName);
  const crmMode = opts.mode === 'crm';
  const capabilities = new Set<PlatformCapability>(opts.capabilities ?? ['workspace.overview.read']);
  if (opts.crmAvailable) {
    capabilities.add('crm.contacts.read');
    capabilities.add('crm.pipeline.read');
    capabilities.add('crm.tasks.read');
  }
  if (opts.billingAvailable) capabilities.add('billing.read');
  const resolvedModules = platformModules.navigation({ capabilities });
  const visibleIds = new Set(profile.visibleNavigation);
  const workingModules = resolvedModules.filter((module) => visibleIds.has(module.id) && module.state !== 'planned' && module.route);
  const moduleLabel = (module: PlatformModuleManifest): string => profile.moduleLabels[module.id] ?? module.shortLabel;
  const isCurrent = (id: PlatformModuleId): boolean =>
    (opts.active === 'overview' && id === 'overview')
    || (opts.active === 'crm' && id === 'crm')
    || (opts.active === 'journeys' && id === 'journeys')
    || (opts.active === 'content' && id === 'content')
    || (opts.active === 'inbox' && id === 'inbox')
    || (opts.active === 'billing' && id === 'settings');
  const workingNav = workingModules.map((module) => {
    const current = isCurrent(module.id);
    const stateLabel = module.state === 'preview' ? 'Preview' : module.state === 'setup_required' ? 'Setup' : '';
    const state = stateLabel ? `<span class="module-state">${escapeHtml(stateLabel)}</span>` : '';
    if (module.state === 'setup_required' || module.state === 'unavailable') {
      return `<span class="nav-item nav-locked" role="link" aria-disabled="true" title="${escapeHtml(module.label)} is not connected in this workspace">${portalModuleIcon(module.id)}<span>${escapeHtml(moduleLabel(module))}</span>${state}</span>`;
    }
    return `<a class="nav-item" href="${escapeHtml(module.route!)}"${current ? ' aria-current="page"' : ''}>${portalModuleIcon(module.id)}<span>${escapeHtml(moduleLabel(module))}</span>${state}</a>`;
  }).join('');
  const quickWorking = workingModules.map((module) => module.state === 'setup_required' || module.state === 'unavailable'
    ? `<span class="command-link locked" role="link" aria-disabled="true">${portalModuleIcon(module.id)}${escapeHtml(module.label)}<small>${icon('lock')}Setup</small></span>`
    : `<a class="command-link" href="${escapeHtml(module.route!)}">${portalModuleIcon(module.id)}${escapeHtml(module.label)}<small>${module.state === 'preview' ? 'Preview' : module.group}</small></a>`).join('');
  const mobileModules = workingModules.filter((module) => module.state === 'ready' || module.state === 'preview');
  const mobileNav = mobileModules.map((module) => `<a href="${escapeHtml(module.route!)}"${isCurrent(module.id) ? ' aria-current="page"' : ''}>${portalModuleIcon(module.id)}${escapeHtml(moduleLabel(module))}</a>`).join('');
  const csrfField = opts.csrfToken
    ? `<input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">`
    : '';
  const productName = escapeHtml(profile.productName);
  const compactMark = productBrandMark(profile);
  const brandName = productBrandName(profile);
  const suiteLabel = escapeHtml(profile.suiteLabel);
  return `${pageHead(opts.title, profile)}<body><a class="skip-link" href="#main-content">Skip to main content</a>
  <div class="app-shell">
    <aside class="sidebar" aria-label="Workspace navigation">
      <a class="brand-lockup" href="/portal" aria-label="${productName} overview"><span class="brand-mark">${compactMark}</span><span class="brand-name">${brandName}<small>${suiteLabel}</small></span></a>
      <details class="workspace-menu">
        <summary aria-label="Workspace menu: ${tenant}"><span class="workspace-avatar">${workspaceInitial(opts.tenantName)}</span><span class="workspace-copy"><strong>${tenant}</strong><small>Current workspace</small></span>${icon('chevron', 'chev')}</summary>
        <div class="workspace-popover"><div class="workspace-current"><span class="workspace-avatar">${workspaceInitial(opts.tenantName)}</span><span>${tenant}</span></div><p>One workspace is connected. Multi-workspace switching is planned.</p></div>
      </details>
      <nav class="primary-nav" aria-label="Primary">
        <div class="nav-label">Workspace</div>
        ${workingNav}
      </nav>
      <div class="sidebar-foot"><div class="sandbox-note"><span class="sandbox-dot"></span><span><strong>${crmMode ? 'Private workspace' : 'Private sandbox'}</strong>${crmMode ? (capabilities.has('conversations.read') ? 'Saved CRM records · TEST channel rails only' : 'Saved CRM records · live channel rails locked') : 'Mock generation only · no publishing'}</span></div></div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <a class="mobile-brand" href="/portal"><span class="brand-mark">${compactMark}</span><strong class="brand-name">${brandName}</strong></a>
        <details class="quick-menu">
          <summary aria-label="Open quick navigation">${icon('search')}<span>Quick navigation</span></summary>
          <nav class="command-popover" aria-label="Quick navigation">
            <div class="command-title">Go to</div>
            ${quickWorking}
          </nav>
        </details>
        <div class="top-actions"><span class="status-badge"><span class="dot"></span>${crmMode ? (capabilities.has('conversations.read') ? 'CRM + TEST rails' : 'CRM records') : 'Mock workspace'}</span><form method="post" action="/portal/logout">${csrfField}<button class="top-icon-button" type="submit" aria-label="Sign out" title="Sign out">${icon('logout')}</button></form></div>
      </header>
      <main class="main" id="main-content" tabindex="-1">${opts.body}</main>
    </div>
    <nav class="mobile-nav" aria-label="Mobile navigation" style="--mobile-nav-count:${mobileModules.length}">${mobileNav}</nav>
  </div></body></html>`;
}
