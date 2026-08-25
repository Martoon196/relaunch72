import type { CrmOpportunityView, CrmTaskView, CrmWorkspaceSnapshot } from './crm-views.js';
import type { GrowthFunnelView, GrowthIntelligenceView, GrowthLeadView } from './growth-intelligence.js';
import { emptyGrowthIntelligence } from './growth-intelligence.js';
import type { PortalProductProfile } from './product-profile.js';
import { escapeHtml, icon } from './ui.js';

const GROWTH_HOME_STYLE = `
  .pp-home{display:grid;gap:16px}.pp-hero{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:16px;background:var(--panel);padding:clamp(26px,4vw,52px);min-height:280px}.pp-hero::before{content:"";position:absolute;inset:0 0 auto;height:2px;background:var(--accent)}.pp-hero::after{content:"";position:absolute;right:clamp(20px,7vw,96px);top:50%;width:190px;height:190px;transform:translateY(-50%);opacity:.07;background:linear-gradient(30deg,transparent 48%,var(--accent) 49% 51%,transparent 52%),linear-gradient(150deg,transparent 48%,var(--accent) 49% 51%,transparent 52%);clip-path:polygon(50% 0,93% 25%,93% 75%,50% 100%,7% 75%,7% 25%);pointer-events:none}.pp-hero-copy{position:relative;z-index:1;max-width:820px}.pp-live-line{display:flex;align-items:center;gap:9px;color:var(--accent);font:700 .62rem var(--mono);letter-spacing:.15em;text-transform:uppercase}.pp-live-dot{width:6px;height:6px;border-radius:50%;background:var(--accent)}.pp-live-line.preview{color:#f59e0b}.pp-live-line.preview .pp-live-dot{background:#f59e0b}.pp-live-line.empty{color:var(--faint)}.pp-live-line.empty .pp-live-dot{background:var(--faint)}.pp-hero h1{font-family:var(--display);font-size:clamp(2.55rem,5.4vw,5.3rem);font-weight:600;line-height:.92;letter-spacing:-.035em;max-width:760px;margin:23px 0 20px}.pp-hero h1 em{font-style:normal;color:var(--accent)}.pp-hero p{max-width:670px;color:var(--muted);font-size:clamp(.84rem,1.3vw,1rem);line-height:1.72;margin:0}.pp-hero-actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:28px}.pp-hero-proof{display:flex;flex-wrap:wrap;gap:14px 24px;margin-top:28px;padding-top:20px;border-top:1px solid var(--line);color:var(--faint);font:650 .6rem var(--mono);letter-spacing:.04em;text-transform:uppercase}.pp-hero-proof span{display:flex;align-items:center;gap:7px}.pp-hero-proof i{width:5px;height:5px;background:var(--accent);border-radius:50%}
  .pp-metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border:1px solid var(--line);border-radius:14px;background:var(--panel);overflow:hidden}.pp-metric{padding:17px 18px;border-right:1px solid var(--line)}.pp-metric:last-child{border-right:0}.pp-metric small{display:block;color:var(--faint);font:700 .57rem var(--mono);letter-spacing:.09em;text-transform:uppercase}.pp-metric strong{display:block;margin:7px 0 4px;color:var(--ink);font:700 1.55rem/1 var(--mono);letter-spacing:-.045em;font-variant-numeric:tabular-nums}.pp-metric span{display:block;color:var(--muted);font-size:.62rem;line-height:1.4}
  .pp-grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(300px,.55fr);gap:16px;align-items:start}.pp-stack{display:grid;gap:16px}.pp-panel{border:1px solid var(--line);border-radius:14px;background:var(--panel);overflow:hidden}.pp-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:18px 19px 15px;border-bottom:1px solid var(--line)}.pp-panel-head h2{font-family:var(--display);font-size:1.34rem;font-weight:600;letter-spacing:-.015em;margin:0}.pp-panel-head p{color:var(--muted);font-size:.67rem;margin:4px 0 0}.pp-panel-kicker{color:var(--accent);font:700 .55rem var(--mono);letter-spacing:.1em;text-transform:uppercase;margin-bottom:4px}.pp-panel-action{color:var(--accent);font:700 .59rem var(--mono);letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}.pp-panel-body{padding:18px 19px}
  .pp-funnels{display:grid;gap:17px}.pp-funnel{border:1px solid var(--line);border-radius:12px;background:var(--panel-subtle);padding:14px}.pp-funnel-top{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:13px}.pp-funnel-top h3{font-size:.78rem;margin:0}.pp-funnel-top p{color:var(--muted);font-size:.62rem;margin:3px 0 0}.pp-track{border:1px solid var(--line-strong);border-radius:999px;padding:4px 7px;color:var(--faint);font:700 .52rem var(--mono);letter-spacing:.07em;text-transform:uppercase}.pp-funnel-rail{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}.pp-funnel-stage{position:relative;min-height:126px;border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:12px;overflow:visible}.pp-funnel-stage:not(:last-child)::after{content:"";position:absolute;z-index:2;right:-10px;top:25px;width:10px;border-top:1px solid var(--accent)}.pp-stage-index{color:var(--accent);font:700 .52rem var(--mono);letter-spacing:.08em}.pp-stage-label{display:block;color:var(--muted);font:700 .55rem var(--mono);letter-spacing:.09em;text-transform:uppercase;margin-top:8px}.pp-stage-count{display:block;color:var(--ink);font:700 1.72rem/1 var(--mono);letter-spacing:-.05em;margin:7px 0 9px}.pp-stage-foot{display:flex;justify-content:space-between;gap:6px;color:var(--faint);font:650 .51rem var(--mono);text-transform:uppercase}.pp-stage-foot strong{color:var(--muted);font-weight:700}.pp-funnel-empty{color:var(--faint);font-size:.62rem;margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
  .pp-hot-list{display:grid}.pp-lead{display:grid;grid-template-columns:58px minmax(150px,1.05fr) minmax(140px,.8fr) minmax(190px,1.25fr) minmax(165px,1fr);gap:13px;align-items:center;padding:14px 0;border-bottom:1px solid var(--line)}.pp-lead:first-child{padding-top:0}.pp-lead:last-child{border-bottom:0;padding-bottom:0}.pp-score{width:52px;height:52px;border:1px solid var(--line-strong);border-radius:50%;display:grid;place-items:center;text-align:center;background:var(--panel-subtle)}.pp-score strong{display:block;font:750 1rem/1 var(--mono)}.pp-score small{display:block;margin-top:3px;color:var(--faint);font:700 .43rem var(--mono);letter-spacing:.08em;text-transform:uppercase}.pp-score.burning{border-color:#ef4444;color:#ef4444}.pp-score.hot{border-color:#f59e0b;color:#f59e0b}.pp-score.warm{border-color:#facc15;color:#facc15}.pp-lead-name{font-size:.75rem;font-weight:760;color:var(--ink)}.pp-lead-name:hover{color:var(--accent)}.pp-lead-company{display:block;color:var(--faint);font-size:.61rem;margin-top:3px}.pp-lead-stage{display:flex;flex-direction:column;gap:5px}.pp-lead-stage span{color:var(--faint);font:650 .51rem var(--mono);letter-spacing:.07em;text-transform:uppercase}.pp-lead-stage strong{color:var(--accent);font:700 .61rem var(--mono);text-transform:uppercase}.pp-evidence{min-width:0}.pp-evidence-kind{color:var(--accent);font:700 .51rem var(--mono);letter-spacing:.08em;text-transform:uppercase}.pp-evidence strong{display:block;font-size:.66rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}.pp-evidence small{display:block;color:var(--faint);font-size:.56rem;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pp-next-move{border-left:1px solid var(--line);padding-left:13px}.pp-next-move span{display:block;color:var(--faint);font:700 .49rem var(--mono);letter-spacing:.08em;text-transform:uppercase}.pp-next-move strong{display:block;font-size:.64rem;line-height:1.45;margin-top:4px}.pp-empty{border:1px dashed var(--line-strong);border-radius:11px;background:var(--panel-subtle);padding:22px;color:var(--muted);font-size:.68rem;line-height:1.55}.pp-empty strong{display:block;color:var(--ink);font-size:.77rem;margin-bottom:4px}
  .pp-evidence-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.pp-evidence-total{border:1px solid var(--line);border-radius:10px;background:var(--panel-subtle);padding:12px}.pp-evidence-total strong{display:block;font:700 1.14rem var(--mono)}.pp-evidence-total span{display:block;color:var(--faint);font:650 .52rem var(--mono);letter-spacing:.06em;text-transform:uppercase;margin-top:4px}.pp-attention{list-style:none;margin:0;padding:0}.pp-attention li{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:9px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}.pp-attention li:last-child{border-bottom:0}.pp-attention-mark{width:27px;height:27px;border:1px solid var(--line);border-radius:8px;display:grid;place-items:center;color:var(--accent)}.pp-attention-mark .icon{width:13px}.pp-attention-copy strong{display:block;font-size:.68rem}.pp-attention-copy span{display:block;color:var(--faint);font-size:.57rem;margin-top:2px}.pp-attention-state{color:var(--accent);font:700 .48rem var(--mono);letter-spacing:.06em;text-transform:uppercase}.pp-attention-state.overdue{color:#ef4444}.pp-rail-list{display:grid;gap:8px}.pp-rail{border:1px solid var(--line);border-radius:10px;background:var(--panel-subtle);padding:11px}.pp-rail-top{display:flex;align-items:center;justify-content:space-between;gap:8px}.pp-rail strong{font-size:.66rem}.pp-rail p{color:var(--muted);font-size:.57rem;line-height:1.45;margin:5px 0 0}.pp-rail-state{color:var(--faint);font:700 .47rem var(--mono);letter-spacing:.07em;text-transform:uppercase}.pp-rail-state.ready{color:var(--accent)}
  @media(max-width:1180px){.pp-metrics{grid-template-columns:repeat(3,1fr)}.pp-metric:nth-child(3){border-right:0}.pp-metric:nth-child(n+4){border-top:1px solid var(--line)}.pp-grid{grid-template-columns:1fr}.pp-lead{grid-template-columns:52px minmax(150px,1fr) minmax(130px,.7fr) minmax(180px,1fr)}.pp-next-move{grid-column:2/-1;border-left:0;border-top:1px solid var(--line);padding:9px 0 0}}
  @media(max-width:760px){.pp-hero::after{display:none}.pp-metrics{grid-template-columns:repeat(2,1fr)}.pp-metric,.pp-metric:nth-child(3){border-right:1px solid var(--line);border-top:1px solid var(--line)}.pp-metric:nth-child(-n+2){border-top:0}.pp-metric:nth-child(even){border-right:0}.pp-metric:last-child{grid-column:1/-1}.pp-funnel-rail{grid-template-columns:repeat(2,1fr)}.pp-funnel-stage:nth-child(2)::after{display:none}.pp-lead{grid-template-columns:48px 1fr}.pp-lead-stage,.pp-evidence,.pp-next-move{grid-column:2}.pp-next-move{border-top:1px solid var(--line);padding-top:9px}.pp-panel-head{padding:15px}.pp-panel-body{padding:15px}}
  @media(max-width:480px){.pp-metrics{grid-template-columns:1fr}.pp-metric,.pp-metric:nth-child(3),.pp-metric:nth-child(even){border-right:0}.pp-metric:nth-child(n+2){border-top:1px solid var(--line)}.pp-funnel-rail{grid-template-columns:1fr}.pp-funnel-stage::after{display:none}.pp-hero-actions .button{width:100%}.pp-evidence-grid{grid-template-columns:1fr 1fr}}
`;

function percent(value: number | null): string {
  if (value === null) return '—';
  return `${Math.max(0, value).toLocaleString('en-GB', { maximumFractionDigits: 1 })}%`;
}

function dateTime(value: string, timezone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Recorded time unavailable';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    timeZone: timezone,
  }).format(date);
}

function isOverdue(task: CrmTaskView, snapshotAt: string): boolean {
  return task.status === 'open' && Boolean(task.dueAt) && task.dueAt! < snapshotAt;
}

function stageName(snapshot: CrmWorkspaceSnapshot, opportunity: CrmOpportunityView): string {
  return snapshot.stages.find((stage) => stage.id === opportunity.stageId)?.name ?? 'Current CRM stage';
}

function attentionQueue(snapshot: CrmWorkspaceSnapshot, openStageIds: ReadonlySet<string>): string {
  const overdue = snapshot.tasks.filter((task) => isOverdue(task, snapshot.workspace.snapshotAt));
  const open = snapshot.tasks.filter((task) => task.status === 'open' && !isOverdue(task, snapshot.workspace.snapshotAt));
  const unworked = snapshot.opportunities.filter((opportunity) => openStageIds.has(opportunity.stageId) && !opportunity.nextTaskAt);
  const entries: string[] = [];
  for (const task of overdue.slice(0, 3)) {
    entries.push(`<li><span class="pp-attention-mark">${icon('calendar')}</span><span class="pp-attention-copy"><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(task.contactName ?? task.opportunityTitle ?? 'Workspace task')}</span></span><span class="pp-attention-state overdue">Overdue</span></li>`);
  }
  for (const task of open.slice(0, Math.max(0, 4 - entries.length))) {
    entries.push(`<li><span class="pp-attention-mark">${icon('activity')}</span><span class="pp-attention-copy"><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(task.contactName ?? task.opportunityTitle ?? 'Workspace task')}</span></span><span class="pp-attention-state">Open</span></li>`);
  }
  for (const opportunity of unworked.slice(0, Math.max(0, 4 - entries.length))) {
    const href = `/portal/crm/contacts/${encodeURIComponent(opportunity.contactId)}`;
    entries.push(`<li><span class="pp-attention-mark">${icon('pipeline')}</span><span class="pp-attention-copy"><strong><a href="${href}">${escapeHtml(opportunity.title)}</a></strong><span>${escapeHtml(opportunity.contactName)} · ${escapeHtml(stageName(snapshot, opportunity))}</span></span><span class="pp-attention-state">No task</span></li>`);
  }
  return entries.length
    ? `<ol class="pp-attention">${entries.join('')}</ol>`
    : '<div class="pp-empty"><strong>No urgent CRM work.</strong>Add a next task when a lead needs a human move.</div>';
}

function funnel(funnelView: GrowthFunnelView, dataState: GrowthIntelligenceView['dataState']): string {
  const leadCount = funnelView.stages[0]?.count ?? 0;
  const stages = funnelView.stages.map((stage, index) => `<article class="pp-funnel-stage">
    <span class="pp-stage-index">0${index + 1}</span><span class="pp-stage-label">${escapeHtml(stage.label)}</span>
    <strong class="pp-stage-count">${stage.count.toLocaleString('en-GB')}</strong>
    <span class="pp-stage-foot"><span>Step <strong>${percent(stage.stepConversionPercent)}</strong></span><span>+${stage.movedInWindow}</span></span>
  </article>`).join('');
  const empty = dataState === 'empty' || leadCount === 0
    ? '<div class="pp-funnel-empty">No journey evidence is recorded yet. CRM pipeline stages are deliberately not counted as conversion stages.</div>'
    : '';
  return `<section class="pp-funnel"><div class="pp-funnel-top"><div><h3>${escapeHtml(funnelView.label)}</h3><p>${escapeHtml(funnelView.description)}</p></div><span class="pp-track">${funnelView.track === 'self_serve' ? 'Product-led' : 'Sales-assisted'}</span></div><div class="pp-funnel-rail">${stages}</div>${empty}</section>`;
}

function leadScore(lead: GrowthLeadView): string {
  const score = lead.score === null ? '—' : String(lead.score);
  const band = lead.band === 'unscored' ? 'Unscored' : lead.band;
  return `<span class="pp-score ${escapeHtml(lead.band)}"><span><strong>${escapeHtml(score)}</strong><small>${escapeHtml(band)}</small></span></span>`;
}

function leadEvidence(lead: GrowthLeadView, timezone: string): string {
  if (!lead.lastEvidence) return '<div class="pp-evidence"><span class="pp-evidence-kind">No evidence</span><strong>Awaiting a recorded signal</strong><small>Nothing inferred</small></div>';
  return `<div class="pp-evidence"><span class="pp-evidence-kind">${escapeHtml(lead.lastEvidence.kind.replace('_', ' '))}</span><strong>${escapeHtml(lead.lastEvidence.label)}</strong><small>${escapeHtml(lead.lastEvidence.detail)} · ${escapeHtml(dateTime(lead.lastEvidence.occurredAt, timezone))}</small></div>`;
}

function hotList(growth: GrowthIntelligenceView, timezone: string): string {
  if (!growth.hotLeads.length) {
    return '<div class="pp-empty"><strong>No scored case files yet.</strong>Once a known identity is enrolled, its content, offer and conversion evidence will appear here.</div>';
  }
  return `<div class="pp-hot-list">${growth.hotLeads.slice(0, 8).map((lead) => `<article class="pp-lead">
    ${leadScore(lead)}
    <div><a class="pp-lead-name" href="/portal/crm/contacts/${encodeURIComponent(lead.contactId)}">${escapeHtml(lead.displayName)}</a><span class="pp-lead-company">${escapeHtml(lead.companyName ?? (lead.track === 'agency' ? 'Agency lead' : 'Self-serve lead'))}</span></div>
    <div class="pp-lead-stage"><span>${lead.track === 'agency' ? 'Agency LAPS' : 'Self-serve'}</span><strong>${escapeHtml(lead.stage)}</strong></div>
    ${leadEvidence(lead, timezone)}
    <div class="pp-next-move"><span>Best next move</span><strong>${escapeHtml(lead.nextMove)}</strong></div>
  </article>`).join('')}</div>`;
}

function evidenceTotals(growth: GrowthIntelligenceView): string {
  const totals = [
    ['Started', growth.evidenceTotals.contentStarted],
    ['Completed', growth.evidenceTotals.contentCompleted],
    ['Offers shown', growth.evidenceTotals.offersShown],
    ['Replies', growth.evidenceTotals.replies],
    ['Appointments', growth.evidenceTotals.appointments],
  ] as const;
  return `<div class="pp-evidence-grid">${totals.map(([label, value]) => `<article class="pp-evidence-total"><strong>${value.toLocaleString('en-GB')}</strong><span>${escapeHtml(label)}</span></article>`).join('')}</div>`;
}

function readiness(profile: PortalProductProfile): string {
  return `<div class="pp-rail-list">${profile.readinessRails.map((rail) => `<article class="pp-rail"><div class="pp-rail-top"><strong>${escapeHtml(rail.label)}</strong><span class="pp-rail-state ${rail.state === 'foundation' ? 'ready' : ''}">${rail.state === 'foundation' ? 'Foundation' : 'Not connected'}</span></div><p>${escapeHtml(rail.summary)}</p></article>`).join('')}</div>`;
}

function stageCount(growth: GrowthIntelligenceView, key: string): number {
  return growth.funnels.reduce((sum, item) => sum + (item.stages.find((stage) => stage.key === key)?.count ?? 0), 0);
}

export function renderGrowthHomeBody(
  snapshot: CrmWorkspaceSnapshot,
  profile: PortalProductProfile,
  suppliedGrowth?: GrowthIntelligenceView,
): string {
  const growth = suppliedGrowth ?? emptyGrowthIntelligence(snapshot.workspace.snapshotAt);
  const openStageIds = new Set(snapshot.stages.filter((stage) => !stage.isClosed).map((stage) => stage.id));
  const leadCount = stageCount(growth, 'lead');
  const priced = stageCount(growth, 'priced') + stageCount(growth, 'presentation');
  const sales = stageCount(growth, 'sale');
  const selfServe = growth.funnels.find((item) => item.track === 'self_serve');
  const selfLead = selfServe?.stages.find((stage) => stage.key === 'lead')?.count ?? 0;
  const selfActivated = selfServe?.stages.find((stage) => stage.key === 'activated')?.count ?? 0;
  const activationRate = selfLead > 0 ? (selfActivated / selfLead) * 100 : null;
  const stateClass = growth.dataState === 'live' ? '' : growth.dataState;
  const stateLabel = growth.dataState === 'live' ? 'Live intelligence' : growth.dataState === 'preview' ? 'Demo evidence' : 'Awaiting signals';
  const stateTruth = growth.dataState === 'preview'
    ? 'Clearly labelled preview facts · no messages or posts sent'
    : growth.dataState === 'live'
      ? 'Exact recorded journey, content and offer evidence only'
      : 'CRM records are live · conversion evidence has not landed yet';
  const heroTitle = profile.id === 'property_predator_growth'
    ? 'See what every <em>lead</em> is hiding.'
    : escapeHtml(profile.home.title);

  return `<style>${GROWTH_HOME_STYLE}</style><div class="pp-home">
    <section class="pp-hero" aria-labelledby="growth-home-title"><div class="pp-hero-copy">
      <div class="pp-live-line ${stateClass}"><span class="pp-live-dot"></span>${escapeHtml(stateLabel)} · ${escapeHtml(growth.windowLabel)}</div>
      <h1 id="growth-home-title">${heroTitle}</h1>
      <p>${escapeHtml(profile.home.summary)}</p>
      <div class="pp-hero-actions"><a class="button" href="#hot-list">Work the hot list</a><a class="button secondary" href="/portal/crm/contacts">Open CRM</a></div>
      <div class="pp-hero-proof"><span><i></i>${escapeHtml(stateTruth)}</span><span><i></i>Sale requires collected payment</span><span><i></i>Consent never adds score</span></div>
    </div></section>
    <section class="pp-metrics" aria-label="Conversion evidence snapshot">
      <article class="pp-metric"><small>Route leads</small><strong>${leadCount}</strong><span>Distinct within each journey · routes may overlap</span></article>
      <article class="pp-metric"><small>Activation rate</small><strong>${percent(activationRate)}</strong><span>First weapon fired after capture</span></article>
      <article class="pp-metric"><small>Priced / presented</small><strong>${priced}</strong><span>Offer evidence, not an assumed intent</span></article>
      <article class="pp-metric"><small>Sales</small><strong>${sales}</strong><span>Authoritative payment-backed milestones</span></article>
      <article class="pp-metric"><small>CRM leads</small><strong>${snapshot.contacts.filter((contact) => contact.lifecycle === 'lead' || contact.lifecycle === 'prospect').length}</strong><span>Saved contacts awaiting or inside journeys</span></article>
    </section>
    <div class="pp-grid"><div class="pp-stack">
      <section class="pp-panel" aria-labelledby="funnel-title"><div class="pp-panel-head"><div><div class="pp-panel-kicker">Measured conversion</div><h2 id="funnel-title">Two routes. No fake stages.</h2><p>Self-serve and agency buying journeys stay distinct.</p></div><span class="pp-panel-action">As of ${escapeHtml(dateTime(growth.asOf, snapshot.workspace.timezone))}</span></div><div class="pp-panel-body"><div class="pp-funnels">${growth.funnels.map((item) => funnel(item, growth.dataState)).join('')}</div></div></section>
      <section class="pp-panel" id="hot-list" aria-labelledby="hot-list-title"><div class="pp-panel-head"><div><div class="pp-panel-kicker">Case files</div><h2 id="hot-list-title">Who needs the next move?</h2><p>Score, exact last evidence and a human-readable action.</p></div><a class="pp-panel-action" href="/portal/crm/contacts">All leads →</a></div><div class="pp-panel-body">${hotList(growth, snapshot.workspace.timezone)}</div></section>
    </div><aside class="pp-stack" aria-label="Evidence and action rails">
      <section class="pp-panel" aria-labelledby="evidence-title"><div class="pp-panel-head"><div><div class="pp-panel-kicker">Consumption + intent</div><h2 id="evidence-title">Evidence captured</h2></div></div><div class="pp-panel-body">${evidenceTotals(growth)}</div></section>
      <section class="pp-panel" aria-labelledby="attention-title"><div class="pp-panel-head"><div><div class="pp-panel-kicker">Human work</div><h2 id="attention-title">Needs attention</h2><p>CRM tasks remain separate from journey evidence.</p></div><a class="pp-panel-action" href="/portal/crm/tasks">Tasks →</a></div><div class="pp-panel-body">${attentionQueue(snapshot, openStageIds)}</div></section>
      <section class="pp-panel" aria-labelledby="machine-title"><div class="pp-panel-head"><div><div class="pp-panel-kicker">Modular machine</div><h2 id="machine-title">Rails</h2></div></div><div class="pp-panel-body">${readiness(profile)}</div></section>
    </aside></div>
  </div>`;
}
