import type { CrmOpportunityView, CrmTaskView, CrmWorkspaceSnapshot } from './crm-views.js';
import type { PortalProductProfile } from './product-profile.js';
import { escapeHtml, icon } from './ui.js';

const GROWTH_HOME_STYLE = `
  .growth-hero{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:22px;background:linear-gradient(135deg,var(--nav) 0%,var(--nav-raised) 72%,#173237 100%);color:var(--nav-text);padding:clamp(24px,4vw,48px);box-shadow:var(--shadow-lg);margin-bottom:18px}.growth-hero::after{content:"";position:absolute;right:-95px;top:-130px;width:330px;height:330px;border-radius:50%;background:radial-gradient(circle,var(--accent),transparent 67%);opacity:.16;pointer-events:none}.growth-hero-copy{position:relative;z-index:1;max-width:790px}.growth-hero .eyebrow{color:var(--accent)}.growth-hero h1{max-width:760px;font-size:clamp(2rem,4.5vw,4.2rem);line-height:.98;letter-spacing:-.055em;margin:13px 0 17px}.growth-hero p{max-width:690px;color:var(--nav-muted);font-size:clamp(.86rem,1.2vw,1rem);line-height:1.7}.growth-hero-actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:24px}.growth-hero .button.secondary{border-color:var(--nav-line);background:rgba(255,255,255,.035);color:var(--nav-text)}
  .growth-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:11px;margin-bottom:18px}.growth-metric{border:1px solid var(--line);background:var(--panel);border-radius:15px;padding:17px;box-shadow:var(--shadow)}.growth-metric small{display:block;color:var(--faint);font:750 .58rem var(--mono);text-transform:uppercase;letter-spacing:.07em}.growth-metric strong{display:block;font-size:1.62rem;letter-spacing:-.04em;margin:6px 0 2px}.growth-metric span{display:block;color:var(--muted);font-size:.68rem;line-height:1.4}
  .growth-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(300px,.65fr);gap:18px;align-items:start}.attention-list,.journey-list,.rail-grid{list-style:none;padding:0;margin:0}.attention-item{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:11px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line)}.attention-item:last-child{border-bottom:0}.attention-mark{width:32px;height:32px;border-radius:10px;background:var(--accent-soft);color:var(--accent-deep);display:grid;place-items:center}.attention-mark .icon{width:16px}.attention-copy strong{display:block;font-size:.79rem}.attention-copy span{display:block;color:var(--muted);font-size:.67rem;margin-top:3px}.attention-state{font:750 .56rem var(--mono);letter-spacing:.04em;text-transform:uppercase;color:var(--accent-deep);background:var(--accent-soft);border-radius:999px;padding:5px 8px}.attention-state.overdue{color:var(--danger);background:var(--danger-soft)}
  .journey-card{border:1px solid var(--line);border-radius:14px;background:var(--panel);padding:15px;margin-bottom:10px}.journey-card:last-child{margin-bottom:0}.journey-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.journey-top h3{font-size:.86rem;margin:0}.journey-top span{white-space:nowrap;color:var(--accent-deep);background:var(--accent-soft);border-radius:999px;padding:4px 7px;font:750 .54rem var(--mono);text-transform:uppercase}.journey-card p{color:var(--muted);font-size:.68rem;line-height:1.5;margin:7px 0 12px}.milestones{display:flex;align-items:center;flex-wrap:wrap;gap:5px}.milestone{display:flex;align-items:center;gap:5px;color:var(--ink);font-size:.62rem;font-weight:760}.milestone:not(:last-child)::after{content:"→";color:var(--faint);margin-left:1px}
  .rail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.rail-card{border:1px solid var(--line);background:var(--panel-subtle);border-radius:13px;padding:13px}.rail-card strong{display:block;font-size:.73rem}.rail-card p{color:var(--muted);font-size:.63rem;line-height:1.45;margin:5px 0 10px}.rail-state{display:inline-flex;align-items:center;gap:5px;color:var(--faint);font:700 .54rem var(--mono);text-transform:uppercase;letter-spacing:.05em}.rail-state .dot{width:6px;height:6px;border-radius:50%;background:var(--accent)}
  .growth-empty{border:1px dashed var(--line-strong);border-radius:14px;padding:18px;color:var(--muted);font-size:.72rem;line-height:1.55}.growth-empty strong{display:block;color:var(--ink);font-size:.82rem;margin-bottom:4px}
  @media(max-width:980px){.growth-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.growth-grid{grid-template-columns:1fr}.rail-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
  @media(max-width:640px){.growth-hero{border-radius:16px;padding:23px 19px}.growth-hero-actions .button{width:100%}.growth-metrics{grid-template-columns:1fr 1fr}.growth-metric{padding:14px}.growth-metric strong{font-size:1.35rem}.rail-grid{grid-template-columns:1fr}.attention-item{grid-template-columns:32px minmax(0,1fr)}.attention-state{grid-column:2;justify-self:start}}
`;

function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency', currency, maximumFractionDigits: 0,
    }).format(minor / 100);
  } catch {
    return `${escapeHtml(currency)} ${(minor / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
  }
}

function isOverdue(task: CrmTaskView, snapshotAt: string): boolean {
  return task.status === 'open' && Boolean(task.dueAt) && task.dueAt! < snapshotAt;
}

function stageName(snapshot: CrmWorkspaceSnapshot, opportunity: CrmOpportunityView): string {
  return snapshot.stages.find((stage) => stage.id === opportunity.stageId)?.name ?? 'Current pipeline stage';
}

function attentionQueue(snapshot: CrmWorkspaceSnapshot, openStageIds: ReadonlySet<string>): string {
  const overdue = snapshot.tasks.filter((task) => isOverdue(task, snapshot.workspace.snapshotAt));
  const open = snapshot.tasks.filter((task) => task.status === 'open' && !isOverdue(task, snapshot.workspace.snapshotAt));
  const unworked = snapshot.opportunities.filter((opportunity) =>
    openStageIds.has(opportunity.stageId) && !opportunity.nextTaskAt);
  const entries: string[] = [];
  for (const task of overdue.slice(0, 4)) {
    entries.push(`<li class="attention-item"><span class="attention-mark">${icon('calendar')}</span><span class="attention-copy"><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(task.contactName ?? task.opportunityTitle ?? 'Workspace task')}</span></span><span class="attention-state overdue">Overdue</span></li>`);
  }
  for (const task of open.slice(0, Math.max(0, 5 - entries.length))) {
    entries.push(`<li class="attention-item"><span class="attention-mark">${icon('activity')}</span><span class="attention-copy"><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(task.contactName ?? task.opportunityTitle ?? 'Workspace task')}</span></span><span class="attention-state">Open</span></li>`);
  }
  for (const opportunity of unworked.slice(0, Math.max(0, 5 - entries.length))) {
    entries.push(`<li class="attention-item"><span class="attention-mark">${icon('pipeline')}</span><span class="attention-copy"><strong>${escapeHtml(opportunity.title)}</strong><span>${escapeHtml(opportunity.contactName)} · ${escapeHtml(stageName(snapshot, opportunity))}</span></span><span class="attention-state">No task</span></li>`);
  }
  if (!entries.length) {
    return '<div class="growth-empty" role="status"><strong>No urgent work is recorded.</strong>Add a lead or schedule the next task; this queue only shows saved CRM facts.</div>';
  }
  return `<ol class="attention-list">${entries.join('')}</ol>`;
}

function journeyBlueprints(profile: PortalProductProfile): string {
  if (!profile.journeyBlueprints.length) {
    return '<div class="growth-empty"><strong>No journey blueprint selected.</strong>Conversion Journeys will appear here after a product profile installs them.</div>';
  }
  return `<div class="journey-list">${profile.journeyBlueprints.map((journey) => `<article class="journey-card"><div class="journey-top"><h3>${escapeHtml(journey.label)}</h3><span>Blueprint</span></div><p>${escapeHtml(journey.summary)}</p><div class="milestones" aria-label="${escapeHtml(journey.label)} milestones">${journey.milestones.map((milestone) => `<span class="milestone">${escapeHtml(milestone)}</span>`).join('')}</div></article>`).join('')}</div>`;
}

function readiness(profile: PortalProductProfile): string {
  return `<div class="rail-grid">${profile.readinessRails.map((rail) => `<article class="rail-card"><strong>${escapeHtml(rail.label)}</strong><p>${escapeHtml(rail.summary)}</p><span class="rail-state"><span class="dot"></span>${rail.state === 'foundation' ? 'Foundation ready' : 'Not connected'}</span></article>`).join('')}</div>`;
}

export function renderGrowthHomeBody(snapshot: CrmWorkspaceSnapshot, profile: PortalProductProfile): string {
  const openStageIds = new Set(snapshot.stages.filter((stage) => !stage.isClosed).map((stage) => stage.id));
  const openOpportunities = snapshot.opportunities.filter((opportunity) => openStageIds.has(opportunity.stageId));
  const openTasks = snapshot.tasks.filter((task) => task.status === 'open');
  const overdueTasks = openTasks.filter((task) => isOverdue(task, snapshot.workspace.snapshotAt));
  const pipelineValue = openOpportunities.reduce((sum, opportunity) => sum + (opportunity.valueMinor ?? 0), 0);
  const currency = openOpportunities.find((opportunity) => opportunity.currency)?.currency ?? 'GBP';
  const leadCount = snapshot.contacts.filter((contact) => contact.lifecycle === 'lead' || contact.lifecycle === 'prospect').length;

  return `<style>${GROWTH_HOME_STYLE}</style>
    <section class="growth-hero" aria-labelledby="growth-home-title"><div class="growth-hero-copy"><div class="eyebrow">${escapeHtml(profile.home.eyebrow)}</div><h1 id="growth-home-title">${escapeHtml(profile.home.title)}</h1><p>${escapeHtml(profile.home.summary)}</p><div class="growth-hero-actions"><a class="button" href="/portal/crm/contacts#crm-create-lead">Create a lead</a><a class="button secondary" href="/portal/crm/pipeline">Open pipeline</a></div></div></section>
    <section class="growth-metrics" aria-label="Saved CRM snapshot">
      <article class="growth-metric"><small>Leads</small><strong>${leadCount}</strong><span>Captured people in lead or prospect status</span></article>
      <article class="growth-metric"><small>Open opportunities</small><strong>${openOpportunities.length}</strong><span>Across saved open pipeline stages</span></article>
      <article class="growth-metric"><small>Open pipeline value</small><strong>${money(pipelineValue, currency)}</strong><span>Potential value, not collected revenue</span></article>
      <article class="growth-metric"><small>Needs attention</small><strong>${overdueTasks.length}</strong><span>Recorded tasks now overdue</span></article>
    </section>
    <div class="growth-grid"><div class="stack">
      <section class="panel" aria-labelledby="attention-title"><div class="panel-head"><div><h2 id="attention-title">What needs attention</h2><p class="panel-subtitle">Saved tasks first · then unworked opportunities</p></div><a class="text-link" href="/portal/crm/tasks">All tasks →</a></div><div class="panel-body">${attentionQueue(snapshot, openStageIds)}</div></section>
      <section class="panel" aria-labelledby="readiness-title"><div class="panel-head"><div><h2 id="readiness-title">The machine we are connecting</h2><p class="panel-subtitle">Truthful build state · unavailable rails have no action controls</p></div></div><div class="panel-body">${readiness(profile)}</div></section>
    </div><aside class="stack" aria-label="Conversion context">
      <section class="panel" aria-labelledby="journeys-title"><div class="panel-head"><div><h2 id="journeys-title">Conversion Journeys</h2><p class="panel-subtitle">Profile blueprints · live milestone facts come next</p></div></div><div class="panel-body">${journeyBlueprints(profile)}</div></section>
      <section class="panel" aria-labelledby="workspace-truth-title"><div class="panel-head"><div><h2 id="workspace-truth-title">Workspace truth</h2><p class="panel-subtitle">Growth HQ channels are not connected</p></div></div><div class="panel-body"><div class="growth-empty"><strong>${escapeHtml(snapshot.workspace.name)}</strong>${snapshot.contacts.length} contacts · ${snapshot.opportunities.length} opportunities · ${openTasks.length} open tasks. Growth HQ messaging, social publishing and webinar reminders remain locked until their provider rails are proven.</div></div></section>
    </aside></div>`;
}
