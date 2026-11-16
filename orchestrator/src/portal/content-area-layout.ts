/**
 * The content area shell (preview): a sidebar with the business and seven places, a bottom bar on a phone, and the
 * page inside. It only wraps what a page already renders; it decides nothing and posts nothing except the
 * "Back to the old look" switch.
 *
 * Used only when the preview is on for this browser (see content-area-preview.ts). With it off, `layout()` in
 * seo-blog-view.ts renders exactly as before.
 */
import type { Shell, SeoBlogTab } from './seo-blog-view.js';
import { escapeHtml as e } from './ui.js';
import { CONTENT_AREA_TOKENS } from './content-area-theme.js';

const BASE = '/portal/seo-blog';

export type ContentAreaPlace = 'home' | 'dna' | 'calendar' | 'articles' | 'social' | 'results' | 'settings';

/** What the shell itself shows on every page (all read from the business's real records). */
export interface ContentAreaPreview {
  /** Articles that are written and waiting for the owner (the "Ready for you" group of the articles list). */
  readonly needsYou: number;
  /** The address of the page being shown (for "Back to the old look"). */
  readonly path: string;
  /** Overrides the place worked out from the page's tab. */
  readonly place?: ContentAreaPlace;
}

const ICON: Record<ContentAreaPlace | 'more' | 'down', string> = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1.5 1.5 0 0 1-1.5 1.5h-4.5v-6h-6v6H4.5A1.5 1.5 0 0 1 3 20z"/>',
  dna: '<path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  articles: '<path d="M6 3h8l4.5 4.5V19.5A1.5 1.5 0 0 1 17 21H6a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 6 3z"/><path d="M14 3v4.5h4.5M8 12.5h7M8 16h7"/>',
  social: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6"/>',
  results: '<path d="M5 20V12M12 20V5M19 20v-9"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  more: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
};
export function icon(name: keyof typeof ICON, size = 20): string {
  return `<svg class="ca-ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON[name]}</svg>`;
}

const PLACES: readonly [ContentAreaPlace, string, string][] = [
  ['home', 'Home', 'overview'], ['dna', 'Brand DNA', 'dna'], ['calendar', 'Calendar', 'calendar'], ['articles', 'Articles', 'articles'],
  ['social', 'Social', 'social'], ['results', 'Results', 'results'], ['settings', 'Settings', 'publishing'],
];
const PHONE: readonly ContentAreaPlace[] = ['home', 'calendar', 'articles', 'results'];

function placeFor(shell: Shell): ContentAreaPlace | null {
  if (shell.preview?.place) return shell.preview.place;
  if (shell.switchTo === 'dna') return 'dna';
  const byTab: Partial<Record<SeoBlogTab, ContentAreaPlace>> = { overview: 'home', calendar: 'calendar', articles: 'articles', social: 'social', publishing: 'settings', setup: 'settings' };
  // Topics, Activity, the studio and the other tools are not one of the seven places: nothing is marked.
  return (shell.tab && byTab[shell.tab]) || null;
}

function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase() || '?';
}

/** The tools that are not one of the seven places, kept one step away. */
function otherTools(shell: Shell): string {
  const b = shell.brand!;
  const href = (tab: string) => e(`${BASE}/b/${b.id}/${tab}`);
  const items: [string, string][] = [[href('topics'), 'Topics'], [href('setup'), 'Business set-up'], [href('activity'), 'Activity'],
    [e(`/portal/approvals?brand=${b.id}`), 'Approvals'], [e(`/portal/campaign-journey?brand=${b.id}`), 'Campaign results']];
  if (shell.applicationName === 'Relaunch72 Content') items.push([href('authority'), 'Authority']);
  if (shell.creativeAvailable) items.push([href('creative'), 'Creative studio']);
  if (shell.creatorsAvailable) items.push([href('campaigns'), 'Campaign creators']);
  if (shell.methodsAvailable) items.push([href('methods'), 'Production rules']);
  if (shell.limitsAvailable) items.push([`${BASE}/limits`, 'Usage and limits']);
  if (shell.applicationName === 'Relaunch72 Content') items.push(['/portal/webinars', 'Webinars']);
  items.push([BASE, 'All your businesses'], ['/portal', shell.applicationName ? 'Content home' : 'Back to the portal']);
  return items.map(([h, l]) => `<li><a href="${h}">${e(l)}</a></li>`).join('');
}

function oldLook(shell: Shell, cls: string): string {
  return `<form method="post" action="${BASE}/look" class="${cls}"><input type="hidden" name="_csrf" value="${e(shell.csrf)}"><input type="hidden" name="look" value="old"><input type="hidden" name="back" value="${e(shell.preview?.path ?? BASE)}"><button type="submit" class="ca-quiet">Back to the old look</button></form>`;
}

/** The autopilot line: only what the business's own settings say. */
export function autopilot(shell: Shell): { on: boolean; title: string; line: string } {
  const s = shell.brand!.settings;
  if (s.pauseAll) return { on: false, title: 'Publishing is paused', line: 'Nothing goes out until you switch it back on in Settings.' };
  // Automatic publishing only waives approval: an article still goes out only at a time it has (engine and article page).
  const yes = s.autoPublish ? 'Articles with a time go out then without waiting for your approval. An article with no time waits for you.' : 'Nothing goes out until you say yes.';
  // Ongoing production plans for empty days; without automatic plan acceptance, it writes only topics he accepts.
  if (s.ongoingProduction) return { on: true, title: 'Autopilot is on', line: `${s.autoAcceptPlans ? 'We plan and write for your publishing days.' : 'We suggest topics for your publishing days and write the ones you accept.'} ${yes}` };
  return { on: false, title: 'Autopilot is off', line: `We write the topics you choose. ${yes}` };
}

const DAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export function publishingDays(weekdays: readonly number[], time: string): string {
  const names = [...weekdays].sort((a, b) => a - b).map((d) => DAY[d - 1]).filter(Boolean) as string[];
  if (!names.length) return 'your publishing days';
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list} at ${time.replace(/^0(\d)/, '$1')}`;
}

export function contentAreaLayout(shell: Shell, title: string, body: string, extraHead: string, legacyCss: string, feedbackHead: string, feedbackStatus: string): string {
  const b = shell.brand!;
  const place = placeFor(shell);
  const href = (tab: string) => e(`${BASE}/b/${b.id}/${tab}`);
  const badge = (p: ContentAreaPlace) => p === 'articles' && (shell.preview?.needsYou ?? 0) > 0 ? `<span class="ca-count" aria-label="${shell.preview!.needsYou} need you">${shell.preview!.needsYou}</span>` : '';
  const link = (p: ContentAreaPlace, label: string, tab: string, cls: string) => `<a class="${cls}" href="${href(tab)}"${p === place ? ' aria-current="page"' : ''}>${icon(p)}<span>${e(label)}</span>${badge(p)}</a>`;
  const stay = shell.switchTo ?? (place === 'home' ? 'overview' : shell.tab ?? 'overview');
  const switcher = `<details class="ca-biz"><summary><span class="ca-biz-av" aria-hidden="true">${e(initials(b.name))}</span><span class="ca-biz-name"><span class="ca-sr">Business: </span>${e(b.name)}</span>${icon('down', 18)}</summary>
<div class="ca-biz-panel">${shell.brands.length > 1 ? `<form method="get" action="${BASE}/switch"><label for="ca-brand-switch">Open another business</label><select id="ca-brand-switch" name="brand">${shell.brands.map((x) => `<option value="${e(x.id)}"${x.id === b.id ? ' selected' : ''}>${e(x.name)}</option>`).join('')}</select><input type="hidden" name="to" value="${e(stay)}"><button type="submit" class="ca-btn-2">Open</button></form>` : ''}<a href="${BASE}">All your businesses</a></div></details>`;
  const auto = autopilot(shell);
  const more = PLACES.filter(([p]) => !PHONE.includes(p));
  return `<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark"><title>${e(title)} · ${e(b.name)}</title><style>${legacyCss}</style><style>${CONTENT_AREA_TOKENS}${CONTENT_AREA_CSS}</style>${extraHead}${feedbackHead}</head><body class="ca">${feedbackStatus}<a class="ca-skip" href="#ca-main">Skip to the page</a>
<div class="ca-app"><aside class="ca-side" aria-label="${e(b.name)}">${switcher}
<nav class="ca-nav" aria-label="Content area">${PLACES.map(([p, label, tab]) => link(p, label, tab, 'ca-nav-item')).join('')}</nav>
<div class="ca-foot"><p class="ca-auto"><span class="ca-dot${auto.on ? ' on' : ''}" aria-hidden="true"></span><strong>${e(auto.title)}</strong><span>${e(auto.line)}</span></p>
<details class="ca-tools"><summary>More tools</summary><ul>${otherTools(shell)}</ul></details>${oldLook(shell, 'ca-oldlook')}</div></aside>
<main id="ca-main" class="ca-main" tabindex="-1">${shell.notice ? `<p class="notice ca-notice" role="status">${e(shell.notice)}</p>` : ''}${shell.error ? `<p class="notice bad ca-notice" role="alert">${e(shell.error)}</p>` : ''}${body}</main></div>
<nav class="ca-tabbar" aria-label="Content area (phone)">${PLACES.filter(([p]) => PHONE.includes(p)).map(([p, label, tab]) => link(p, label, tab, 'ca-tab')).join('')}<details class="ca-tab-more"><summary class="ca-tab${more.some(([p]) => p === place) ? ' ca-on' : ''}">${icon('more')}<span>More</span></summary><div class="ca-sheet"><ul>${more.map(([p, label, tab]) => `<li><a href="${href(tab)}"${p === place ? ' aria-current="page"' : ''}>${icon(p)}<span>${e(label)}</span></a></li>`).join('')}</ul><ul class="ca-sheet-tools">${otherTools(shell)}</ul>${oldLook(shell, 'ca-oldlook')}</div></details></nav>
<script src="${BASE}/content-area.js" defer></script></body></html>`;
}

/** The shell's own styles, and the existing pages' classes re-pointed at the tokens (no page logic changes). */
export const CONTENT_AREA_CSS = `
html{-webkit-text-size-adjust:100%}
body.ca{margin:0;background:var(--ca-mist);color:var(--ca-ink);font-family:var(--ca-font-body);font-size:var(--ca-size-body);line-height:1.5;-webkit-font-smoothing:antialiased}
body.ca{color-scheme:light dark;--bg:var(--ca-mist);--card:var(--ca-surface);--ink:var(--ca-ink);--muted:var(--ca-muted);--line:var(--ca-line);--accent:var(--ca-link);--ok:var(--ca-ok);--warn:var(--ca-warn);--bad:var(--ca-bad)}
.ca-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.ca-skip{position:absolute;left:12px;top:-60px;z-index:50;padding:10px 16px;border-radius:var(--ca-radius-pill);background:var(--ca-amber);color:var(--ca-on-amber);font-weight:700}.ca-skip:focus{top:12px}
.ca :focus-visible{outline:3px solid var(--ca-focus);outline-offset:3px}
.ca-ic{flex:none;display:block}
.ca-app{display:flex;min-height:100vh;background:linear-gradient(to right,var(--ca-deep) var(--ca-side-width),transparent 0)}
.ca-side{position:sticky;top:0;height:100vh;flex:none;width:var(--ca-side-width);display:flex;flex-direction:column;gap:22px;padding:20px 18px;background:var(--ca-deep);color:var(--ca-on-deep-2);overflow-y:auto;--ca-focus:var(--ca-focus-on-deep)}
.ca-side a{color:inherit}
.ca-biz{position:relative}.ca-biz>summary{list-style:none;display:flex;align-items:center;gap:10px;padding:10px;border-radius:18px;background:var(--ca-on-deep-fill);border:1px solid var(--ca-on-deep-line);cursor:pointer;color:var(--ca-on-deep)}
.ca-biz>summary::-webkit-details-marker{display:none}
.ca-biz-av{width:36px;height:36px;flex:none;display:grid;place-items:center;border-radius:50%;background:var(--ca-amber);color:var(--ca-on-amber);font:var(--ca-weight-display) 14px/1 var(--ca-font-display)}
.ca-biz-name{flex:1;min-width:0;font-weight:600;font-size:14px;line-height:1.25;overflow-wrap:anywhere}
.ca-biz-panel{margin-top:8px;padding:12px;border-radius:var(--ca-radius-m);background:var(--ca-surface);color:var(--ca-ink);box-shadow:var(--ca-shadow-pop);display:grid;gap:10px;font-size:14px;--ca-focus:var(--ca-link)}
.ca-biz-panel a{color:var(--ca-link);font-weight:600}.ca-biz-panel form{display:grid;gap:6px}.ca-biz-panel label{margin:0;font-weight:600}
.ca-biz-panel button{appearance:none;min-height:40px;padding:0 16px;border-radius:var(--ca-radius-pill);border:0;background:var(--ca-deep);color:var(--ca-on-deep);font:600 14px/1 var(--ca-font-body);cursor:pointer;justify-self:start}
.ca-biz-panel select{width:100%;padding:8px;border:1px solid var(--ca-line);border-radius:var(--ca-radius-xs);background:var(--ca-mist);color:var(--ca-ink);font:inherit}
.ca-nav{display:flex;flex-direction:column;gap:4px}
.ca-nav-item{display:flex;align-items:center;gap:12px;min-height:44px;padding:0 14px;border-radius:var(--ca-radius-pill);font-weight:600;font-size:15px;text-decoration:none;color:var(--ca-on-deep-2)}
.ca-nav-item span:not(.ca-count){flex:1}.ca-nav-item:hover{background:var(--ca-on-deep-fill);color:var(--ca-on-deep)}
.ca-nav-item[aria-current=page]{background:var(--ca-surface);color:var(--ca-ink);font-weight:700;--ca-focus:var(--ca-focus-on-deep)}
.ca-count{min-width:22px;height:22px;padding:0 7px;display:inline-grid;place-items:center;border-radius:var(--ca-radius-pill);background:var(--ca-amber);color:var(--ca-on-amber);font:700 12px/1 var(--ca-font-body)}
.ca-foot{margin-top:auto;display:grid;gap:14px;font-size:13px;line-height:1.45}
.ca-auto{margin:0;padding:0 6px;display:grid;grid-template-columns:auto 1fr;column-gap:10px;row-gap:4px;align-items:center}.ca-auto strong{font-size:14px;color:var(--ca-on-deep)}.ca-auto span:last-child{grid-column:1/-1}
.ca-dot{width:9px;height:9px;border-radius:50%;background:var(--ca-on-deep-2)}.ca-dot.on{background:var(--ca-amber);box-shadow:0 0 0 4px var(--ca-amber-ring)}
.ca-tools>summary{cursor:pointer;padding:6px;font-weight:600;color:var(--ca-on-deep)}.ca-tools ul{list-style:none;margin:4px 0 0;padding:0 6px;display:grid;gap:2px}.ca-tools a{display:block;padding:6px 0;text-decoration:underline;text-underline-offset:3px}
.ca-quiet{appearance:none;background:none;border:0;padding:6px;min-height:auto;color:inherit;font:inherit;font-weight:600;text-decoration:underline;text-underline-offset:3px;cursor:pointer;border-radius:var(--ca-radius-xs)}
.ca-oldlook{margin:0}
.ca-main{flex:1;min-width:0;padding:36px 44px 56px}
.ca-main:focus{outline:none}
.ca-notice{max-width:900px;margin:0 auto 18px}
.ca-tabbar{display:none}
/* The existing pages inside the shell: same markup, same wording, the shell's tokens. */
body.ca main{max-width:none}
.ca-main h1{font-family:var(--ca-font-display);font-weight:var(--ca-weight-display);letter-spacing:-.02em}
.ca-main h2{font-family:var(--ca-font-display);font-weight:var(--ca-weight-display)}
.ca-main .card{border:0;border-radius:var(--ca-radius-l);box-shadow:var(--ca-shadow);background:var(--ca-surface)}
.ca-main button,.ca-main .button{border-radius:var(--ca-radius-pill);background:var(--ca-deep);border-color:var(--ca-deep);color:var(--ca-on-deep)}
.ca-main button.secondary,.ca-main .button.secondary{background:transparent;color:var(--ca-link);border-color:var(--ca-link)}
.ca-main button.danger{background:var(--ca-bad);border-color:var(--ca-bad)}
.ca-main input[type=text],.ca-main input[type=url],.ca-main input[type=date],.ca-main input[type=time],.ca-main input[type=number],.ca-main input[type=password],.ca-main select,.ca-main textarea{border-radius:var(--ca-radius-s);background:var(--ca-surface);border-color:var(--ca-line)}
.ca-main .notice{border-radius:var(--ca-radius-m);background:var(--ca-surface);border-color:var(--ca-line)}
.ca-main .pill{border-radius:var(--ca-radius-pill)}
.ca-main .programme-hero{border:0;border-radius:var(--ca-radius-xl);background:var(--ca-surface);box-shadow:var(--ca-shadow)}
.ca-main .metric,.ca-main .day,.ca-main .view-switch{background:var(--ca-surface);border-color:var(--ca-line)}.ca-main .day.outside-month,.ca-main .empty-state,.ca-main .slot.planned{background:var(--ca-mist)}
.ca-main .view-switch a{color:var(--ca-link)}.ca-main .view-switch a[aria-current=page]{background:var(--ca-glow);color:var(--ca-ink)}
.ca-main .slot{background:var(--ca-glow);border-left-color:var(--ca-link)}.ca-main .review-note,.ca-main nav.tabs a[aria-current=page],.ca-main .step-number{background:var(--ca-glow);color:var(--ca-ink)}
.ca-main .ap-bar{border:0;border-radius:var(--ca-radius-pill);background:var(--ca-deep);color:var(--ca-on-deep);box-shadow:var(--ca-shadow);--ink:var(--ca-on-deep);--muted:var(--ca-on-deep-2);--accent:var(--ca-on-deep);--ca-focus:var(--ca-focus-on-deep)}
.ca-main .ap-bar .ap-menu,.ca-main .ap-bar .ap-panel{--ink:var(--ca-ink);--muted:var(--ca-muted);--accent:var(--ca-link);--ca-focus:var(--ca-focus);color:var(--ca-ink)}
.ca-main .ap .ap-primary,.ca-main .ap-bar .ap-primary,.ca-main .dna .main{background:var(--ca-amber);border-color:var(--ca-amber);color:var(--ca-on-amber);border-radius:var(--ca-radius-pill)}
.ca-main .ap-read{background:var(--ca-surface);border-radius:var(--ca-radius-xl);box-shadow:var(--ca-shadow);padding:28px 40px 44px;max-width:calc(var(--col) + 80px)}
.ca-main .ap-title,.ca-main .ap-read h2{font-family:var(--ca-font-display);font-weight:var(--ca-weight-display)}
.ca-main .ap-pic img,.ca-main .ap-pic-empty{border-radius:var(--ca-radius-m)}
.ca-main .ap-fix,.ca-main .ap-putback,.ca-main .ap-post,.ca-main .ap-serp{border-radius:var(--ca-radius-m)}
.ca-main .dna fieldset{border-radius:var(--ca-radius-m)}
@media (max-width:700px){
.ca-app{display:block;min-height:0;background:none}
.ca-side{position:static;height:auto;width:auto;padding:12px 16px;gap:0;overflow:visible}
.ca-side .ca-nav,.ca-side .ca-foot{display:none}
.ca-main{padding:24px 16px 28px}
.ca-main .ap-bar{border-radius:var(--ca-radius-l);margin:0 0 20px}
.ca-main .ap-read{padding:18px 18px 28px;border-radius:var(--ca-radius-l)}
.ca-tabbar{display:flex;position:sticky;bottom:12px;margin:0 12px 12px;z-index:40;padding:6px;border-radius:var(--ca-radius-pill);background:var(--ca-deep);box-shadow:0 12px 28px -10px rgba(0,0,0,.5);--ca-focus:var(--ca-focus-on-deep)}
.ca-tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:7px 0;border-radius:var(--ca-radius-pill);color:var(--ca-on-deep-2);font:600 11px/1 var(--ca-font-body);text-decoration:none;position:relative;list-style:none;cursor:pointer}
.ca-tab::-webkit-details-marker{display:none}
.ca-tab[aria-current=page],.ca-tab.ca-on{background:var(--ca-surface);color:var(--ca-ink)}
.ca-tab .ca-count{position:absolute;top:2px;right:calc(50% - 22px);min-width:18px;height:18px;font-size:11px;padding:0 5px}
.ca-tab-more{flex:1;display:flex}.ca-tab-more>summary{width:100%}
.ca-sheet{position:absolute;left:0;right:0;bottom:calc(100% + 10px);max-height:70vh;overflow:auto;padding:14px;border-radius:var(--ca-radius-l);background:var(--ca-surface);color:var(--ca-ink);box-shadow:var(--ca-shadow-pop);--ca-focus:var(--ca-link)}
.ca-sheet ul{list-style:none;margin:0;padding:0;display:grid;gap:2px}.ca-sheet a{display:flex;align-items:center;gap:12px;min-height:44px;padding:0 10px;border-radius:var(--ca-radius-s);color:var(--ca-ink);text-decoration:none;font-weight:600}
.ca-sheet a[aria-current=page]{background:var(--ca-glow)}
.ca-sheet-tools{margin-top:10px!important;padding-top:10px!important;border-top:1px solid var(--ca-line)!important}.ca-sheet-tools a{min-height:40px;font-weight:500}
.ca-sheet .ca-oldlook{margin-top:8px}.ca-sheet .ca-quiet{color:var(--ca-link)}
}
@media (prefers-reduced-motion:no-preference){.ca-nav-item,.ca-tab{transition:background-color .15s}}
`;

/** Closes the business switcher, "More tools" and the phone "More" sheet on Escape or a tap outside (served same-origin). */
export const CONTENT_AREA_SCRIPT = `(() => {
  const sel = 'details.ca-tab-more,details.ca-biz,details.ca-tools';
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    for (const d of document.querySelectorAll(sel)) if (d.open) { d.open = false; const s = d.querySelector('summary'); if (s) s.focus(); }
  });
  document.addEventListener('click', (ev) => {
    const inside = ev.target instanceof Element ? ev.target.closest(sel) : null;
    for (const d of document.querySelectorAll(sel)) if (d.open && d !== inside) d.open = false;
  });
})();
`;
