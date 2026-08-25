import { escapeHtml } from './ui.js';

export type JourneyManagerState = 'ready' | 'action_required' | 'degraded';
export type JourneyDefinitionState = 'active' | 'missing' | 'drifted';
export type JourneySetupState = 'ready' | 'available' | 'blocked';

export interface JourneyManagerMilestoneView {
  readonly key: string;
  readonly label: string;
  readonly semantic: string;
  readonly isCompletion: boolean;
}

export interface JourneyManagerTriggerView {
  readonly kind: 'event' | 'commerce';
  readonly sourceKey: string;
  readonly milestoneKey: string;
  readonly evidenceLabel: string;
}

export interface JourneyManagerRouteView {
  readonly slug: string;
  readonly label: string;
  readonly description: string;
  readonly version: number;
  readonly state: JourneyDefinitionState;
  readonly enrollmentLabel: string;
  readonly milestones: readonly JourneyManagerMilestoneView[];
  readonly triggers: readonly JourneyManagerTriggerView[];
}

export interface JourneyScoreComponentView {
  readonly key: string;
  readonly label: string;
  readonly maxPoints: number;
  readonly allocatedPoints: number;
}

export interface JourneyScoreBandView {
  readonly key: string;
  readonly label: string;
  readonly minScore: number;
  readonly maxScore: number;
}

export interface JourneyManagerScoringView {
  readonly label: string;
  readonly version: number;
  readonly state: JourneyDefinitionState;
  readonly components: readonly JourneyScoreComponentView[];
  readonly bands: readonly JourneyScoreBandView[];
  readonly ruleCount: number;
  readonly excludedSignals: readonly string[];
}

export interface JourneyManagerSetupView {
  readonly state: JourneySetupState;
  readonly canManage: boolean;
  readonly postAction: string;
  readonly csrfToken?: string;
  readonly commandKey?: string;
  readonly confirmationToken?: string;
  readonly blocker?: string;
}

export interface JourneyManagerNoticeView {
  readonly kind: 'success' | 'error' | 'info';
  readonly title: string;
  readonly message: string;
}

export interface JourneyManagerView {
  readonly workspaceName: string;
  readonly asOf: string;
  readonly state: JourneyManagerState;
  readonly readinessTitle: string;
  readonly readinessSummary: string;
  readonly routes: readonly JourneyManagerRouteView[];
  readonly scoring: JourneyManagerScoringView;
  readonly setup: JourneyManagerSetupView;
  readonly notice?: JourneyManagerNoticeView;
}

const JOURNEY_MANAGER_STYLE = `
  .jm{--jm-bg:#080a0a;--jm-panel:#101313;--jm-raised:#161a1a;--jm-line:#2a3030;--jm-line-strong:#3b4342;--jm-ink:#f5f2e9;--jm-muted:#9aa29f;--jm-faint:#707a77;--jm-teal:var(--accent,#00e5cc);--jm-orange:#ef9f28;--jm-danger:#ee7168;color:var(--jm-ink);background:var(--jm-bg);border:1px solid #030404;border-radius:var(--radius,16px);overflow:hidden;box-shadow:0 28px 74px rgba(0,0,0,.27)}
  .jm *{box-sizing:border-box}.jm h1,.jm h2,.jm h3,.jm p{margin-top:0}.jm a{text-decoration:none}.jm-kicker,.jm-section-kicker{font:800 .6rem/1.25 var(--mono,monospace);letter-spacing:.145em;text-transform:uppercase;color:var(--jm-teal)}
  .jm-hero{position:relative;display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,.38fr);gap:35px;align-items:end;padding:clamp(26px,4vw,49px);border-bottom:1px solid var(--jm-line);background:radial-gradient(circle at 88% 12%,rgba(239,159,40,.14),transparent 28%),linear-gradient(126deg,#171b1b,#090b0b 68%)}.jm-hero::before{content:"";position:absolute;inset:0 auto 0 0;width:4px;background:var(--jm-teal)}.jm-hero::after{content:"";position:absolute;right:6%;top:15%;width:152px;height:152px;opacity:.055;background:linear-gradient(30deg,transparent 48%,var(--jm-orange) 49% 51%,transparent 52%),linear-gradient(150deg,transparent 48%,var(--jm-orange) 49% 51%,transparent 52%);clip-path:polygon(50% 0,93% 25%,93% 75%,50% 100%,7% 75%,7% 25%);pointer-events:none}.jm-hero-copy{position:relative;z-index:1}.jm-hero h1{max-width:800px;margin:13px 0 15px;font-family:var(--display,var(--sans));font-size:clamp(2rem,4.8vw,4.6rem);font-weight:600;line-height:.94;letter-spacing:-.045em}.jm-hero h1 em{font-style:normal;color:var(--jm-teal)}.jm-hero p{max-width:750px;margin:0;color:#b1b9b6;font-size:clamp(.76rem,1.1vw,.91rem);line-height:1.7}.jm-readiness{position:relative;z-index:1;border:1px solid var(--jm-line-strong);background:rgba(5,7,7,.64);padding:17px 18px}.jm-readiness-top{display:flex;align-items:center;justify-content:space-between;gap:9px}.jm-readiness-label{font:850 .58rem var(--mono,monospace);letter-spacing:.1em;text-transform:uppercase}.jm-state{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--jm-line-strong);padding:4px 7px;color:#b9c0bd;font:850 .53rem var(--mono,monospace);letter-spacing:.07em;text-transform:uppercase}.jm-state::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}.jm-state.active,.jm-state.ready{border-color:#216b5d;color:var(--jm-teal)}.jm-state.missing,.jm-state.action_required{border-color:#715328;color:#f2b85f}.jm-state.drifted,.jm-state.degraded{border-color:#7b3f3a;color:var(--jm-danger)}.jm-readiness strong{display:block;margin:16px 0 5px;font-size:1rem}.jm-readiness p{color:var(--jm-muted);font-size:.68rem;line-height:1.55}.jm-readiness small{display:block;padding-top:12px;border-top:1px solid var(--jm-line);color:var(--jm-faint);font:650 .54rem var(--mono,monospace)}
  .jm-notice{display:grid;grid-template-columns:8px minmax(0,1fr);gap:13px;margin:20px 24px 0;border:1px solid var(--jm-line);background:var(--jm-panel);padding:13px 15px}.jm-notice::before{content:"";border-radius:99px;background:var(--jm-teal)}.jm-notice.error::before{background:var(--jm-danger)}.jm-notice.info::before{background:var(--jm-orange)}.jm-notice strong{display:block;font-size:.73rem}.jm-notice p{margin:3px 0 0;color:var(--jm-muted);font-size:.65rem;line-height:1.5}
  .jm-snapshot{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-bottom:1px solid var(--jm-line);background:#0c0f0f}.jm-stat{padding:17px clamp(16px,2.4vw,27px);border-right:1px solid var(--jm-line)}.jm-stat:last-child{border-right:0}.jm-stat small{display:block;color:var(--jm-faint);font:800 .51rem var(--mono,monospace);letter-spacing:.09em;text-transform:uppercase}.jm-stat strong{display:block;margin:7px 0 4px;font:900 1.35rem/1 var(--mono,monospace);letter-spacing:-.045em}.jm-stat span{display:block;color:var(--jm-muted);font-size:.59rem}
  .jm-body{display:grid;grid-template-columns:minmax(0,1.48fr) minmax(310px,.52fr);align-items:start}.jm-routes{min-width:0;padding:clamp(20px,3vw,32px);border-right:1px solid var(--jm-line)}.jm-side{min-width:0;background:#0c0f0f}.jm-section-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;margin-bottom:17px}.jm-section-head h2{margin:5px 0 0;font-size:clamp(1.08rem,1.8vw,1.45rem);letter-spacing:-.025em}.jm-section-head>p{max-width:390px;margin:0;color:var(--jm-muted);font-size:.64rem;line-height:1.5;text-align:right}.jm-route-list{display:grid;gap:16px}.jm-route{border:1px solid var(--jm-line);background:var(--jm-panel)}.jm-route[data-state="active"]{box-shadow:inset 3px 0 var(--jm-teal)}.jm-route[data-state="missing"]{box-shadow:inset 3px 0 var(--jm-orange)}.jm-route[data-state="drifted"]{box-shadow:inset 3px 0 var(--jm-danger)}.jm-route-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;padding:17px 18px;border-bottom:1px solid var(--jm-line)}.jm-route-identity{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:7px}.jm-route-identity span:first-child{color:var(--jm-orange);font:850 .55rem var(--mono,monospace);letter-spacing:.09em;text-transform:uppercase}.jm-route-version{border-left:1px solid var(--jm-line-strong);padding-left:8px;color:var(--jm-faint);font:700 .52rem var(--mono,monospace)}.jm-route h3{font-size:.9rem;margin:0 0 5px}.jm-route-head p{max-width:690px;margin:0;color:var(--jm-muted);font-size:.65rem;line-height:1.55}.jm-topology{list-style:none;display:grid;grid-template-columns:repeat(var(--jm-stages,4),minmax(125px,1fr));margin:0;padding:18px;overflow-x:auto;scrollbar-color:var(--jm-line-strong) transparent}.jm-milestone{position:relative;min-width:125px;padding-right:12px}.jm-milestone:not(:last-child)::after{content:"";position:absolute;z-index:0;top:16px;left:33px;right:0;border-top:1px solid #47504e}.jm-node-head{position:relative;z-index:1;display:grid;grid-template-columns:33px 1fr;gap:9px;align-items:center}.jm-node{width:33px;height:33px;display:grid;place-items:center;border:1px solid #505a57;border-radius:50%;background:#101414;color:#b2b9b6;font:900 .58rem var(--mono,monospace)}.jm-milestone.is-completion .jm-node{border-color:var(--jm-orange);color:var(--jm-orange)}.jm-node-copy{min-width:0}.jm-node-copy strong{display:block;font-size:.69rem;line-height:1.2;overflow-wrap:anywhere}.jm-node-copy span{display:block;margin-top:3px;color:var(--jm-faint);font:750 .48rem/1.25 var(--mono,monospace);letter-spacing:.05em;text-transform:uppercase}.jm-trigger-list{list-style:none;display:grid;gap:5px;margin:11px 6px 0 0;padding:0}.jm-trigger{display:block;border-left:2px solid #37403e;background:var(--jm-raised);padding:8px;min-height:0}.jm-trigger.commerce{border-left-color:var(--jm-orange)}.jm-trigger-label{display:flex;align-items:flex-start;gap:5px;color:#cad0cd;font-size:.57rem;font-weight:750;line-height:1.35}.jm-trigger-label>span{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}.jm-trigger-label::before{content:"";flex:0 0 auto;width:5px;height:5px;margin-top:.28em;border-radius:50%;background:var(--jm-teal)}.jm-trigger.commerce .jm-trigger-label::before{background:var(--jm-orange)}.jm-trigger code{display:block;margin-top:5px;color:var(--jm-faint);font:650 .47rem/1.45 var(--mono,monospace);overflow-wrap:anywhere}.jm-no-trigger{display:block;margin:11px 6px 0 0;border:1px dashed #343b39;padding:8px;color:var(--jm-faint);font:650 .48rem var(--mono,monospace);text-align:center}.jm-route-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 18px;border-top:1px solid var(--jm-line);color:var(--jm-faint);font:650 .52rem var(--mono,monospace)}.jm-route-foot code{color:#8d9693;font:inherit;overflow-wrap:anywhere}
  .jm-side-section{padding:clamp(20px,3vw,28px);border-bottom:1px solid var(--jm-line)}.jm-side-section:last-child{border-bottom:0}.jm-score-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:17px}.jm-score-head h2{font-size:.95rem;margin:5px 0 3px}.jm-score-head p{margin:0;color:var(--jm-muted);font-size:.61rem}.jm-components{display:grid;gap:11px}.jm-component-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px}.jm-component-top strong{font-size:.66rem}.jm-component-top span{color:#aeb6b3;font:800 .53rem var(--mono,monospace)}.jm-meter{height:5px;background:#232a28;overflow:hidden}.jm-meter>span{display:block;height:100%;width:var(--jm-fill);background:var(--jm-teal)}.jm-bands{display:flex;margin:17px 0 0}.jm-band{flex:var(--jm-span) 1 0;min-width:0;border-left:1px solid #090b0b;padding:8px 6px;background:#1a201e}.jm-band:nth-child(2){background:#2a281c}.jm-band:nth-child(3){background:#322116}.jm-band:nth-child(4){background:#351a18}.jm-band strong{display:block;font:850 .48rem var(--mono,monospace);text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.jm-band span{display:block;margin-top:2px;color:#aeb4b1;font:650 .46rem var(--mono,monospace)}.jm-score-proof{display:grid;gap:7px;margin-top:16px}.jm-proof-row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding-top:8px;border-top:1px solid var(--jm-line);color:var(--jm-muted);font-size:.59rem}.jm-proof-row strong{color:var(--jm-ink);font:800 .53rem var(--mono,monospace)}.jm-exclusions{display:flex;flex-wrap:wrap;gap:5px;margin-top:10px}.jm-exclusions span{border:1px solid #3b4240;padding:3px 6px;color:#8f9895;font:700 .47rem var(--mono,monospace);text-transform:uppercase}
  .jm-setup-box{border:1px solid var(--jm-line-strong);background:var(--jm-panel);padding:16px}.jm-setup-box.ready{border-color:#205b50}.jm-setup-box.available{border-color:#6e532c}.jm-setup-box.blocked{border-color:#593532}.jm-setup-title{display:flex;align-items:center;justify-content:space-between;gap:8px}.jm-setup-title h2{font-size:.73rem;margin:0}.jm-setup-box p{margin:8px 0 0;color:var(--jm-muted);font-size:.63rem;line-height:1.55}.jm-setup-form{display:grid;gap:10px;margin-top:15px;padding-top:14px;border-top:1px solid var(--jm-line)}.jm-setup-form label{font-size:.61rem;font-weight:750}.jm-setup-form label code{color:var(--jm-orange);font:750 .58rem var(--mono,monospace)}.jm-setup-form input[type="text"]{width:100%;min-height:40px;border:1px solid var(--jm-line-strong);border-radius:0;background:#090b0b;color:var(--jm-ink);padding:8px 10px;font:700 .65rem var(--mono,monospace)}.jm-setup-form input[type="text"]:focus{border-color:var(--jm-teal);box-shadow:0 0 0 3px rgba(0,229,204,.1)}.jm-setup-button{appearance:none;border:0;min-height:42px;background:var(--jm-teal);color:#03110f;padding:9px 13px;font-size:.7rem;font-weight:900;cursor:pointer}.jm-setup-button:hover{filter:brightness(1.08)}.jm-setup-note{display:block;color:var(--jm-faint);font-size:.54rem;line-height:1.5}.jm-blocker{margin-top:12px!important;border-left:2px solid var(--jm-danger);padding:8px 9px;background:#1e1111;color:#cda4a0!important}.jm-safety-list{list-style:none;display:grid;gap:8px;margin:15px 0 0;padding:0}.jm-safety-list li{display:grid;grid-template-columns:7px 1fr;gap:8px;color:var(--jm-muted);font-size:.59rem}.jm-safety-list li::before{content:"";width:5px;height:5px;margin-top:5px;border-radius:50%;background:var(--jm-teal)}
  .jm-footer{display:flex;align-items:center;justify-content:space-between;gap:13px;padding:11px clamp(20px,3vw,32px);border-top:1px solid var(--jm-line);background:#070909;color:var(--jm-faint);font:650 .52rem var(--mono,monospace)}
  @media(max-width:1360px){.jm-hero{grid-template-columns:minmax(0,1fr) minmax(250px,.46fr)}.jm-body{grid-template-columns:1fr}.jm-routes{border-right:0;border-bottom:1px solid var(--jm-line)}.jm-side{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.jm-side-section{border-bottom:0}.jm-side-section+.jm-side-section{border-left:1px solid var(--jm-line)}}
  @media(max-width:760px){.jm-hero{grid-template-columns:1fr;align-items:start}.jm-hero::after{display:none}.jm-snapshot{grid-template-columns:repeat(2,1fr)}.jm-stat:nth-child(2){border-right:0}.jm-stat:nth-child(n+3){border-top:1px solid var(--jm-line)}.jm-body,.jm-side{display:block}.jm-side-section+.jm-side-section{border-left:0;border-top:1px solid var(--jm-line)}.jm-section-head{display:block}.jm-section-head>p{margin-top:7px;text-align:left}.jm-route-head{grid-template-columns:1fr}.jm-topology{grid-template-columns:1fr!important;gap:8px;overflow:visible}.jm-milestone{padding:0 0 7px}.jm-milestone:not(:last-child)::after{left:16px;right:auto;top:33px;bottom:-8px;width:1px;border-top:0;border-left:1px solid #47504e}.jm-trigger-list,.jm-no-trigger{margin-left:42px}.jm-route-foot,.jm-footer{align-items:flex-start;flex-direction:column}}
  @media(max-width:480px){.jm-snapshot{grid-template-columns:1fr}.jm-stat,.jm-stat:nth-child(2){border-right:0}.jm-stat:nth-child(n+2){border-top:1px solid var(--jm-line)}.jm-notice{margin-inline:15px}.jm-routes,.jm-side-section{padding:18px 15px}.jm-topology{padding:15px}.jm-bands{display:grid;grid-template-columns:repeat(2,1fr)}.jm-band{min-height:49px}.jm-setup-button{width:100%}}
  @media(forced-colors:active){.jm,.jm-route,.jm-readiness,.jm-setup-box,.jm-trigger{forced-color-adjust:auto}.jm-node,.jm-state,.jm-setup-button{border:2px solid CanvasText}.jm-meter>span{background:Highlight}}
`;

function stateLabel(state: JourneyManagerState | JourneyDefinitionState | JourneySetupState): string {
  return state === 'action_required' ? 'Action required'
    : state === 'available' ? 'Setup available'
      : state.charAt(0).toUpperCase() + state.slice(1);
}

function count(value: number): string {
  return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-GB') : '—';
}

function boundedPoints(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function timestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'time unavailable';
  return `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
  }).format(date))} UTC</time>`;
}

function notice(view: JourneyManagerNoticeView | undefined): string {
  if (!view) return '';
  const role = view.kind === 'error' ? 'alert' : 'status';
  return `<aside class="jm-notice ${view.kind}" role="${role}"><span><strong>${escapeHtml(view.title)}</strong><p>${escapeHtml(view.message)}</p></span></aside>`;
}

function routeCard(route: JourneyManagerRouteView, index: number): string {
  const triggerMap = new Map<string, JourneyManagerTriggerView[]>();
  for (const trigger of route.triggers) {
    const items = triggerMap.get(trigger.milestoneKey) ?? [];
    items.push(trigger);
    triggerMap.set(trigger.milestoneKey, items);
  }
  const milestones = route.milestones.map((milestone, milestoneIndex) => {
    const triggers = triggerMap.get(milestone.key) ?? [];
    const triggerList = triggers.length
      ? `<ul class="jm-trigger-list" aria-label="Evidence that advances ${escapeHtml(milestone.label)}">${triggers.map((trigger) => `<li class="jm-trigger ${trigger.kind}"><span class="jm-trigger-label"><span>${escapeHtml(trigger.evidenceLabel)}</span></span><code>${escapeHtml(trigger.sourceKey)}</code></li>`).join('')}</ul>`
      : '<span class="jm-no-trigger">No direct trigger</span>';
    return `<li class="jm-milestone${milestone.isCompletion ? ' is-completion' : ''}"><div class="jm-node-head"><span class="jm-node" aria-hidden="true">${String(milestoneIndex + 1).padStart(2, '0')}</span><span class="jm-node-copy"><strong>${escapeHtml(milestone.label)}</strong><span>${escapeHtml(milestone.semantic)}${milestone.isCompletion ? ' · completion' : ''}</span></span></div>${triggerList}</li>`;
  }).join('');
  return `<article class="jm-route" data-state="${route.state}" aria-labelledby="jm-route-${index}-title"><header class="jm-route-head"><div><div class="jm-route-identity"><span>${escapeHtml(route.enrollmentLabel)}</span><span class="jm-route-version">Immutable v${escapeHtml(count(route.version))}</span></div><h3 id="jm-route-${index}-title">${escapeHtml(route.label)}</h3><p>${escapeHtml(route.description)}</p></div><span class="jm-state ${route.state}">${escapeHtml(stateLabel(route.state))}</span></header><ol class="jm-topology" style="--jm-stages:${Math.max(1, route.milestones.length)}" aria-label="${escapeHtml(route.label)} milestones">${milestones}</ol><footer class="jm-route-foot"><span>${count(route.triggers.length)} exact advance trigger${route.triggers.length === 1 ? '' : 's'}</span><code>${escapeHtml(route.slug)}</code></footer></article>`;
}

function scoring(view: JourneyManagerScoringView): string {
  const components = view.components.map((component) => {
    const denominator = boundedPoints(component.maxPoints);
    const fill = denominator > 0 ? Math.round((boundedPoints(component.allocatedPoints) / denominator) * 100) : 0;
    return `<div class="jm-component"><div class="jm-component-top"><strong>${escapeHtml(component.label)}</strong><span>${count(component.allocatedPoints)} / ${count(component.maxPoints)} pts</span></div><div class="jm-meter" role="meter" aria-label="${escapeHtml(component.label)} score allocation" aria-valuemin="0" aria-valuemax="${escapeHtml(count(component.maxPoints))}" aria-valuenow="${escapeHtml(count(component.allocatedPoints))}"><span style="--jm-fill:${Math.max(0, Math.min(100, fill))}%"></span></div></div>`;
  }).join('');
  const bands = view.bands.map((band) => {
    const span = Number.isSafeInteger(band.maxScore - band.minScore + 1) ? Math.max(1, band.maxScore - band.minScore + 1) : 1;
    return `<div class="jm-band" style="--jm-span:${span}"><strong>${escapeHtml(band.label)}</strong><span>${count(band.minScore)}–${count(band.maxScore)}</span></div>`;
  }).join('');
  const exclusions = view.excludedSignals.length
    ? `<div class="jm-exclusions" aria-label="Signals excluded from scoring">${view.excludedSignals.map((signal) => `<span>${escapeHtml(signal)}</span>`).join('')}</div>`
    : '';
  return `<section class="jm-side-section" aria-labelledby="jm-score-title"><div class="jm-score-head"><div><div class="jm-section-kicker">Explainable intent</div><h2 id="jm-score-title">${escapeHtml(view.label)}</h2><p>v${escapeHtml(count(view.version))} · ${count(view.ruleCount)} evidence rules</p></div><span class="jm-state ${view.state}">${escapeHtml(stateLabel(view.state))}</span></div><div class="jm-components">${components || '<p class="jm-blocker">No scoring components are published.</p>'}</div>${bands ? `<div class="jm-bands" aria-label="Score bands">${bands}</div>` : ''}<div class="jm-score-proof"><div class="jm-proof-row"><span>Advancement</span><strong>Exact evidence only</strong></div><div class="jm-proof-row"><span>Scoring</span><strong>Auditable per enrollment</strong></div><div class="jm-proof-row"><span>Communication permission</span><strong>Separate from intent</strong></div></div>${exclusions}</section>`;
}

function setupPanel(view: JourneyManagerSetupView): string {
  const complete = view.state === 'available' && view.canManage
    && Boolean(view.csrfToken) && Boolean(view.commandKey) && Boolean(view.confirmationToken) && Boolean(view.postAction);
  let body: string;
  if (view.state === 'ready') {
    body = '<p>The exact route definitions and shared scoring model are active. No setup action is required.</p>';
  } else if (complete) {
    const token = view.confirmationToken!;
    body = `<p>Publish or exactly replay the owned Property Predator foundation. This changes definitions only.</p><form class="jm-setup-form" method="post" action="${escapeHtml(view.postAction)}"><input type="hidden" name="_csrf" value="${escapeHtml(view.csrfToken!)}"><input type="hidden" name="command_key" value="${escapeHtml(view.commandKey!)}"><label for="jm-setup-confirmation">Type <code>${escapeHtml(token)}</code> to confirm</label><input id="jm-setup-confirmation" type="text" name="confirmation" required autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="jm-setup-effect"><button class="jm-setup-button" type="submit">Install journey foundation</button><small class="jm-setup-note" id="jm-setup-effect">Creates or exactly replays immutable definitions. It does not send a message, publish a post or connect a provider.</small></form>`;
  } else if (view.state === 'available' && !view.canManage) {
    body = '<p>The journey foundation needs a workspace manager. Your access remains read-only.</p>';
  } else {
    body = `<p>Setup is closed until the protected runtime boundary reports a safe state.</p>${view.blocker ? `<p class="jm-blocker">${escapeHtml(view.blocker)}</p>` : ''}`;
  }
  return `<section class="jm-side-section" aria-labelledby="jm-setup-title"><div class="jm-section-kicker">Controlled setup</div><div class="jm-setup-box ${view.state}"><div class="jm-setup-title"><h2 id="jm-setup-title">Journey foundation</h2><span class="jm-state ${view.state}">${escapeHtml(stateLabel(view.state))}</span></div>${body}</div><ul class="jm-safety-list" aria-label="Setup safety boundary"><li>Definitions are versioned and integrity checked.</li><li>Leads advance only from recorded first-party or commerce evidence.</li><li>Consent, suppression and CRM tasks stay separate from intent score.</li></ul></section>`;
}

export function renderJourneyManagerBody(view: JourneyManagerView): string {
  const milestoneCount = view.routes.reduce((sum, route) => sum + route.milestones.length, 0);
  const triggerCount = view.routes.reduce((sum, route) => sum + route.triggers.length, 0);
  const activeCount = view.routes.filter((route) => route.state === 'active').length;
  const routeList = view.routes.length
    ? view.routes.map(routeCard).join('')
    : '<div class="jm-setup-box blocked"><strong>No route definitions found</strong><p>Nothing has been invented. A workspace manager can install the owned foundation when protected setup is available.</p></div>';
  return `<style data-property-predator-journey-manager>${JOURNEY_MANAGER_STYLE}</style><article class="jm" aria-labelledby="jm-title"><header class="jm-hero"><div class="jm-hero-copy"><div class="jm-kicker">Growth HQ · Journey control</div><h1 id="jm-title">Build the route. <em>Prove every move.</em></h1><p>See exactly how a lead enters, advances and earns intent — across the product-led and agency buying motions. The map describes evidence. It never pretends a CRM stage, task or consent flag is conversion.</p></div><aside class="jm-readiness" aria-label="Journey runtime readiness"><div class="jm-readiness-top"><span class="jm-readiness-label">Protected runtime</span><span class="jm-state ${view.state}">${escapeHtml(stateLabel(view.state))}</span></div><strong>${escapeHtml(view.readinessTitle)}</strong><p>${escapeHtml(view.readinessSummary)}</p><small>${escapeHtml(view.workspaceName)} · as of ${timestamp(view.asOf)}</small></aside></header>${notice(view.notice)}<section class="jm-snapshot" aria-label="Journey definition snapshot"><div class="jm-stat"><small>Routes</small><strong>${count(view.routes.length)}</strong><span>${count(activeCount)} active</span></div><div class="jm-stat"><small>Milestones</small><strong>${count(milestoneCount)}</strong><span>Ordered conversion facts</span></div><div class="jm-stat"><small>Advance triggers</small><strong>${count(triggerCount)}</strong><span>Exact evidence sources</span></div><div class="jm-stat"><small>Score model</small><strong>v${count(view.scoring.version)}</strong><span>${count(view.scoring.ruleCount)} auditable rules</span></div></section><div class="jm-body"><section class="jm-routes" aria-labelledby="jm-map-title"><header class="jm-section-head"><div><div class="jm-section-kicker">Visual journey map</div><h2 id="jm-map-title">Two motions. One evidence spine.</h2></div><p>Each source key lands on one named milestone. Collected payment is the only sale trigger.</p></header><div class="jm-route-list">${routeList}</div></section><aside class="jm-side" aria-label="Scoring and setup controls">${scoring(view.scoring)}${setupPanel(view.setup)}</aside></div><footer class="jm-footer"><span>Definitions only · no provider action from this screen</span><span>Viewed ${timestamp(view.asOf)}</span></footer></article>`;
}
