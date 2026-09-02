import { escapeHtml } from './ui.js';
import type {
  DailyOutreachAuthoritativeOutcome,
  DailyOutreachAuthoritativeSnapshot,
  DailyOutreachQueueRow,
  DailyOutreachRecentOutcomeRow,
} from './daily-outreach-service.js';

export const DAILY_OUTREACH_MANUAL_ATTEMPT_ROUTE = '/portal/outreach/daily/manual-attempt' as const;
export const DAILY_OUTREACH_OUTCOME_ROUTE = '/portal/outreach/daily/outcome' as const;

export interface DailyOutreachLiveViewSecurity {
  readonly csrfToken: string;
  readonly nextCommandKey: () => string;
}

const STYLE = `
  .pdo-live{--pdo:#00d8c8;--pdo-soft:rgba(0,216,200,.11);display:grid;gap:16px}.pdo-live *{box-sizing:border-box}.pdo-live a{color:inherit}.pdo-live-link{display:inline-flex;align-items:center;min-height:32px;color:var(--pdo)!important;font:750 .55rem var(--mono);letter-spacing:.03em;text-underline-offset:3px}.pdo-live-link:focus-visible{outline:3px solid var(--pdo);outline-offset:3px;border-radius:4px}.pdo-live-hero{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:18px;background:linear-gradient(135deg,var(--panel),var(--panel-subtle));padding:clamp(25px,4vw,48px)}.pdo-live-hero:before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:var(--pdo)}.pdo-live-kicker,.pdo-live-label{font:750 .57rem var(--mono);letter-spacing:.11em;text-transform:uppercase;color:var(--pdo)}.pdo-live h1{font-family:var(--display);font-size:clamp(2.5rem,5vw,4.8rem);line-height:.94;letter-spacing:-.04em;margin:17px 0}.pdo-live h1 em{font-style:normal;color:var(--pdo)}.pdo-live-hero p{max-width:760px;color:var(--muted);line-height:1.7}.pdo-live-boundary{display:flex;flex-wrap:wrap;gap:8px;margin-top:22px}.pdo-live-pill{border:1px solid var(--line-strong);border-radius:999px;padding:7px 10px;color:var(--muted);font:700 .55rem var(--mono);letter-spacing:.05em;text-transform:uppercase}.pdo-live-pill.good{border-color:rgba(0,216,200,.45);color:var(--pdo)}.pdo-live-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(280px,.75fr);gap:16px}.pdo-live-panel{border:1px solid var(--line);border-radius:15px;background:var(--panel);padding:19px}.pdo-live-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:16px}.pdo-live-head h2{font:600 1.35rem var(--display);margin:5px 0 0}.pdo-live-head p{max-width:430px;color:var(--muted);font-size:.65rem;line-height:1.55;text-align:right;margin:0}.pdo-live-fuel{display:grid;grid-template-columns:auto 1fr;gap:22px;align-items:center}.pdo-live-gauge{width:130px;height:130px;border-radius:50%;display:grid;place-items:center;background:conic-gradient(var(--pdo) var(--fuel),var(--line) 0);position:relative}.pdo-live-gauge:after{content:"";position:absolute;inset:12px;border-radius:50%;background:var(--panel)}.pdo-live-gauge div{position:relative;z-index:1;text-align:center}.pdo-live-gauge strong{display:block;font:800 1.8rem var(--mono)}.pdo-live-gauge span{font:700 .48rem var(--mono);color:var(--faint);text-transform:uppercase}.pdo-live-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.pdo-live-stat{border:1px solid var(--line);border-radius:11px;background:var(--panel-subtle);padding:13px;min-height:90px}.pdo-live-stat span{display:block;color:var(--faint);font:700 .52rem var(--mono);text-transform:uppercase}.pdo-live-stat strong{display:block;font:780 1.45rem var(--mono);margin:9px 0 4px}.pdo-live-stat small{color:var(--muted);font-size:.57rem}.pdo-live-next{border-color:rgba(0,216,200,.38);box-shadow:0 0 0 1px rgba(0,216,200,.05) inset}.pdo-live-person{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.pdo-live-person h2{font:600 1.8rem var(--display);margin:6px 0 4px}.pdo-live-person p{color:var(--muted);margin:0}.pdo-live-rank{border:1px solid var(--pdo);border-radius:50%;width:58px;height:58px;display:grid;place-items:center;color:var(--pdo);font:800 1rem var(--mono)}.pdo-live-evidence{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin:17px 0}.pdo-live-evidence div{border-top:1px solid var(--line);padding-top:11px}.pdo-live-evidence span{display:block;color:var(--faint);font:700 .5rem var(--mono);text-transform:uppercase}.pdo-live-evidence strong,.pdo-live-evidence code{display:block;margin-top:6px;font-size:.63rem;overflow-wrap:anywhere}.pdo-live-action{display:flex;align-items:center;justify-content:space-between;gap:14px;border:1px solid rgba(0,216,200,.28);border-radius:11px;background:var(--pdo-soft);padding:14px}.pdo-live-action p{margin:0;color:var(--muted);font-size:.62rem}.pdo-live-action button,.pdo-live-outcomes button{border:0;border-radius:9px;background:var(--pdo);color:#001916;min-height:44px;padding:10px 14px;font:800 .59rem var(--mono);letter-spacing:.04em;text-transform:uppercase;cursor:pointer}.pdo-live-action button:focus-visible,.pdo-live-outcomes button:focus-visible{outline:3px solid var(--ink);outline-offset:3px}.pdo-live-queue{display:grid;gap:9px}.pdo-live-row{border:1px solid var(--line);border-radius:12px;background:var(--panel-subtle);padding:14px}.pdo-live-row-top{display:grid;grid-template-columns:38px minmax(150px,1fr) auto auto;gap:12px;align-items:center}.pdo-live-row-rank{color:var(--pdo);font:750 .64rem var(--mono)}.pdo-live-row-person strong{display:block;font-size:.72rem}.pdo-live-row-person span{display:block;color:var(--faint);font-size:.58rem;margin-top:3px}.pdo-live-state{border:1px solid var(--line-strong);border-radius:999px;padding:6px 8px;color:var(--muted);font:700 .5rem var(--mono);text-transform:uppercase}.pdo-live-state.ready{border-color:rgba(0,216,200,.5);color:var(--pdo)}.pdo-live-row-meta{color:var(--faint);font:650 .52rem var(--mono)}.pdo-live-outcomes{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}.pdo-live-outcomes button{min-height:38px;background:var(--panel);color:var(--ink);border:1px solid var(--line-strong);padding:7px 10px}.pdo-live-outcomes button.primary{border-color:var(--pdo);color:var(--pdo)}.pdo-live-recent{display:grid;gap:9px}.pdo-live-recent article{display:grid;grid-template-columns:auto 1fr auto;gap:11px;align-items:center;border-bottom:1px solid var(--line);padding-bottom:10px}.pdo-live-recent article:last-child{border-bottom:0}.pdo-live-recent b{font:750 .52rem var(--mono);color:var(--pdo);text-transform:uppercase}.pdo-live-recent strong{font-size:.68rem}.pdo-live-recent span{color:var(--faint);font-size:.56rem}.pdo-live-recent .pdo-live-outcomes{grid-column:1/-1}.pdo-live-empty{border:1px dashed var(--line-strong);border-radius:11px;color:var(--muted);padding:18px;font-size:.65rem;line-height:1.5}.pdo-live-footer{display:flex;justify-content:space-between;gap:16px;color:var(--faint);font:650 .53rem var(--mono);text-transform:uppercase;padding:4px 2px 22px}.pdo-live-footer strong{color:var(--pdo)}
  @media(max-width:950px){.pdo-live-grid{grid-template-columns:1fr}.pdo-live-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.pdo-live-head p{text-align:left}.pdo-live-head{display:block}.pdo-live-head p{margin-top:7px}}
  @media(max-width:650px){.pdo-live-fuel{grid-template-columns:1fr}.pdo-live-gauge{margin:auto}.pdo-live-evidence{grid-template-columns:1fr}.pdo-live-action{align-items:stretch;flex-direction:column}.pdo-live-row-top{grid-template-columns:30px minmax(130px,1fr) auto}.pdo-live-row-meta{display:none}.pdo-live-footer{display:block}.pdo-live-footer span{display:block;margin-top:7px}}
  @media(max-width:420px){.pdo-live-stats{grid-template-columns:1fr}.pdo-live-row-top{grid-template-columns:25px 1fr}.pdo-live-state{grid-column:2}.pdo-live-person{display:block}.pdo-live-rank{margin-top:12px}.pdo-live-outcomes form{width:100%}.pdo-live-outcomes button{width:100%}}
  @media(pointer:coarse){.pdo-live-action button,.pdo-live-outcomes button{min-height:48px}}
  @media(prefers-reduced-motion:reduce){.pdo-live *{scroll-behavior:auto!important;transition:none!important}}
`;

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function number(value: number): string {
  return Math.max(0, Math.trunc(value)).toLocaleString('en-GB');
}

function rate(numerator: number, denominator: number): string {
  if (denominator <= 0) return '—';
  const value = Math.round((Math.max(0, numerator) / denominator) * 1_000) / 10;
  return `${value.toLocaleString('en-GB', { maximumFractionDigits: 1 })}%`;
}

function timestamp(value: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      timeZone: 'UTC', hour12: false,
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function label(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/gu, (character) => character.toUpperCase());
}

function lead360Href(contactId: string): string {
  return `/portal/crm/contacts/${encodeURIComponent(contactId)}`;
}

function exactContentReviewHref(contentItemId: string, contentVersionId: string): string {
  return `/portal/content/items/${encodeURIComponent(contentItemId)}/versions/${encodeURIComponent(contentVersionId)}/review`;
}

function stateClass(row: DailyOutreachQueueRow): string {
  return row.actionState === 'manual_ready' ? ' ready' : '';
}

function validTransitions(outcome: DailyOutreachAuthoritativeOutcome): readonly Exclude<DailyOutreachAuthoritativeOutcome, 'attempted'>[] {
  if (outcome === 'attempted') return ['replied', 'positive', 'referred', 'booked', 'declined', 'no_response', 'invalid_target', 'suppressed'];
  if (outcome === 'no_response') return ['replied', 'positive', 'referred', 'booked', 'declined', 'suppressed'];
  if (outcome === 'replied') return ['positive', 'referred', 'booked', 'declined'];
  if (outcome === 'positive') return ['referred', 'booked', 'declined'];
  if (outcome === 'referred') return ['booked', 'declined'];
  return [];
}

function outcomeForms(
  row: DailyOutreachQueueRow,
  snapshot: DailyOutreachAuthoritativeSnapshot,
  security: DailyOutreachLiveViewSecurity,
): string {
  const latest = row.latestOutcome;
  if (!snapshot.commandBoundaryAvailable || !latest) return '';
  return `<div class="pdo-live-outcomes" aria-label="Record the next verified outcome">${validTransitions(latest.outcome).map((outcome) => `<form method="post" action="${DAILY_OUTREACH_OUTCOME_ROUTE}">${hidden('_csrf', security.csrfToken)}${hidden('command_key', security.nextCommandKey())}${hidden('attempt_receipt_id', latest.attemptReceiptId)}${hidden('previous_outcome_event_id', latest.id)}${hidden('outcome', outcome)}<button class="${['replied', 'positive', 'booked'].includes(outcome) ? 'primary' : ''}" type="submit">${escapeHtml(label(outcome))}</button></form>`).join('')}</div>`;
}

function recentOutcomeForms(
  row: DailyOutreachRecentOutcomeRow,
  snapshot: DailyOutreachAuthoritativeSnapshot,
  security: DailyOutreachLiveViewSecurity,
  alreadyInQueue: boolean,
): string {
  if (!snapshot.commandBoundaryAvailable || alreadyInQueue || !row.canRecordOutcome) return '';
  return `<div class="pdo-live-outcomes" aria-label="Record the next verified outcome for ${escapeHtml(row.contact.displayName)}">${validTransitions(row.outcome).map((outcome) => `<form method="post" action="${DAILY_OUTREACH_OUTCOME_ROUTE}">${hidden('_csrf', security.csrfToken)}${hidden('command_key', security.nextCommandKey())}${hidden('attempt_receipt_id', row.attemptReceiptId)}${hidden('previous_outcome_event_id', row.id)}${hidden('outcome', outcome)}<button class="${['replied', 'positive', 'booked'].includes(outcome) ? 'primary' : ''}" type="submit">${escapeHtml(label(outcome))}</button></form>`).join('')}</div>`;
}

function manualAttemptForm(
  row: DailyOutreachQueueRow,
  snapshot: DailyOutreachAuthoritativeSnapshot,
  security: DailyOutreachLiveViewSecurity,
  isNextActionable: boolean,
): string {
  if (!snapshot.commandBoundaryAvailable || !isNextActionable
      || row.actionState !== 'manual_ready') return '';
  return `<form method="post" action="${DAILY_OUTREACH_MANUAL_ATTEMPT_ROUTE}">${hidden('_csrf', security.csrfToken)}${hidden('command_key', security.nextCommandKey())}${hidden('allocation_id', row.allocationId)}<button type="submit">Record completed LinkedIn first touch</button></form>`;
}

function queueRow(
  row: DailyOutreachQueueRow,
  snapshot: DailyOutreachAuthoritativeSnapshot,
  security: DailyOutreachLiveViewSecurity,
  isNextActionable: boolean,
): string {
  const company = row.contact.companyName ? ` · ${escapeHtml(row.contact.companyName)}` : '';
  return `<article class="pdo-live-row" id="outreach-${escapeHtml(row.allocationId)}"><div class="pdo-live-row-top"><span class="pdo-live-row-rank">${String(row.priorityRank).padStart(2, '0')}</span><div class="pdo-live-row-person"><strong><a href="${escapeHtml(lead360Href(row.contact.id))}">${escapeHtml(row.contact.displayName)}</a></strong><span>${escapeHtml(label(row.segmentKey))}${company}</span></div><span class="pdo-live-state${stateClass(row)}">${escapeHtml(label(row.actionState))}</span><span class="pdo-live-row-meta">${escapeHtml(label(row.channel))} · ${escapeHtml(row.source.adapter)}</span></div>${row.task ? `<p class="pdo-live-row-meta" style="margin:10px 0 0">Task ${escapeHtml(row.task.status)} · due ${escapeHtml(row.task.dueAt ? timestamp(row.task.dueAt) : 'not set')} UTC</p>` : ''}${manualAttemptForm(row, snapshot, security, isNextActionable)}${outcomeForms(row, snapshot, security)}</article>`;
}

function nextCard(
  row: DailyOutreachQueueRow | undefined,
  snapshot: DailyOutreachAuthoritativeSnapshot,
  security: DailyOutreachLiveViewSecurity,
): string {
  if (!row) return '<section class="pdo-live-panel pdo-live-next"><div class="pdo-live-empty"><strong>No actionable prospect is ready.</strong><br>Nothing will be contacted. Add or refresh exact source, eligibility and approved-content evidence first.</div></section>';
  const assignment = row.contentAssignment;
  return `<section class="pdo-live-panel pdo-live-next" aria-labelledby="pdo-live-next"><div class="pdo-live-person"><div><span class="pdo-live-label">Next authoritative prospect</span><h2 id="pdo-live-next"><a href="${escapeHtml(lead360Href(row.contact.id))}">${escapeHtml(row.contact.displayName)}</a></h2><p>${escapeHtml(row.contact.companyName ?? label(row.segmentKey))}</p><a class="pdo-live-link" href="${escapeHtml(lead360Href(row.contact.id))}">Open Lead 360</a></div><span class="pdo-live-rank">#${number(row.priorityRank)}</span></div><div class="pdo-live-evidence"><div><span>Execution route</span><strong>${escapeHtml(label(row.actionState))}</strong></div><div><span>Eligibility</span><strong>${escapeHtml(row.eligibility ? `${label(row.eligibility.decision)} · ${row.eligibility.reasonCode}` : 'Missing')}</strong></div><div><span>Approved content</span><code>${escapeHtml(assignment ? `${assignment.contentVersionId.slice(0, 8)} · ${assignment.contentSha256.slice(0, 12)}…` : 'Not assigned')}</code>${assignment ? `<a class="pdo-live-link" href="${escapeHtml(exactContentReviewHref(assignment.contentItemId, assignment.contentVersionId))}">Open exact approved copy</a>` : ''}</div></div><div class="pdo-live-action"><p>Open Lead 360 and the exact approved copy, then perform the first touch manually in LinkedIn. This button records evidence and creates the bounded follow-up task; it cannot send anything.</p>${manualAttemptForm(row, snapshot, security, true)}</div></section>`;
}

export function renderDailyOutreachLiveBody(
  snapshot: DailyOutreachAuthoritativeSnapshot,
  security: DailyOutreachLiveViewSecurity,
): string {
  const completed = snapshot.manager.validAttempts;
  const target = snapshot.programme.dailyTarget;
  const fuel = target > 0 ? Math.min(100, Math.round((completed / target) * 100)) : 0;
  // Valid attempts can legitimately exceed the programme target up to the
  // operating cap. Keep the visible truth while satisfying the ARIA range
  // invariant that valuemin <= valuenow <= valuemax.
  const accessibleCompleted = Math.min(completed, target);
  const responseRate = rate(snapshot.manager.responses, snapshot.manager.validAttempts);
  const positiveRate = rate(
    snapshot.manager.positiveResponses, snapshot.manager.validAttempts,
  );
  const next = snapshot.queue.find((row) => row.actionState === 'manual_ready');
  const queue = snapshot.queue.map((row) => queueRow(
    row,
    snapshot,
    security,
    row.allocationId === next?.allocationId,
  )).join('');
  const queuedOutcomeIds = new Set(snapshot.queue.flatMap((row) => (
    row.latestOutcome ? [row.latestOutcome.id] : []
  )));
  const recent = snapshot.recentOutcomes.map((row) => `<article><b>${escapeHtml(label(row.outcome))}</b><strong><a href="${escapeHtml(lead360Href(row.contact.id))}">${escapeHtml(row.contact.displayName)}</a></strong><span>${escapeHtml(timestamp(row.occurredAt))} UTC · attempt ${escapeHtml(row.quotaDayUtc)}</span>${recentOutcomeForms(row, snapshot, security, queuedOutcomeIds.has(row.id))}</article>`).join('');
  return `<style data-property-predator-daily-outreach-live>${STYLE}</style><article class="pdo-live" data-dataset="postgres_authoritative" data-provider-effects="none" data-external-effects="off"><header class="pdo-live-hero"><span class="pdo-live-kicker">Property Predator Growth HQ · Daily Outreach</span><h1>Fill the tank. <em>Start the right conversation.</em></h1><p>The queue below is the real PostgreSQL operating record for the signed-in workspace and operator. LinkedIn first touches remain human; replies, cooldowns and admin work become immutable operational evidence.</p><div class="pdo-live-boundary"><span class="pdo-live-pill good">PostgreSQL authoritative</span><span class="pdo-live-pill">UTC quota day ${escapeHtml(snapshot.quotaDayUtc)}</span><span class="pdo-live-pill">Provider effects OFF</span><span class="pdo-live-pill">Command recheck on every click</span></div></header><section class="pdo-live-grid"><article class="pdo-live-panel"><div class="pdo-live-head"><div><span class="pdo-live-label">Daily fuel</span><h2>${number(snapshot.manager.remainingToTarget)} attempts remain</h2></div><p>Target, operating cap and every counted attempt come from the immutable database ledger.</p></div><div class="pdo-live-fuel"><div class="pdo-live-gauge" style="--fuel:${fuel}%" role="progressbar" aria-valuemin="0" aria-valuemax="${target}" aria-valuenow="${accessibleCompleted}" aria-label="Daily outreach fuel: ${completed} completed of ${target}"><div><strong>${number(completed)}/${number(target)}</strong><span>attempts</span></div></div><div class="pdo-live-stats"><article class="pdo-live-stat"><span>Responses</span><strong>${number(snapshot.manager.responses)}</strong><small>Verified outcomes</small></article><article class="pdo-live-stat"><span>Response rate</span><strong>${escapeHtml(responseRate)}</strong><small>Responses ÷ valid attempts</small></article><article class="pdo-live-stat"><span>Positive rate</span><strong>${escapeHtml(positiveRate)}</strong><small>Positive ÷ valid attempts</small></article><article class="pdo-live-stat"><span>Tasks</span><strong>${number(snapshot.manager.tasksCreated)}</strong><small>Follow-up + admin work</small></article></div></div></article><aside class="pdo-live-panel"><div class="pdo-live-head"><div><span class="pdo-live-label">Programme truth</span><h2>${escapeHtml(label(snapshot.programme.key))}</h2></div></div><div class="pdo-live-evidence" style="grid-template-columns:1fr"><div><span>Channel × segment</span><strong>${escapeHtml(label(snapshot.programme.channel))} · ${escapeHtml(label(snapshot.programme.segmentKey))}</strong></div><div><span>Caps</span><strong>${number(snapshot.programme.operatingDailyCap)} operating · ${number(snapshot.programme.providerDailyCap)} provider</strong></div><div><span>Version</span><code>${escapeHtml(snapshot.programme.id)} · v${number(snapshot.programme.versionNumber)}</code></div></div></aside></section>${nextCard(next, snapshot, security)}<section class="pdo-live-panel" aria-labelledby="pdo-live-queue"><div class="pdo-live-head"><div><span class="pdo-live-label">Priority queue</span><h2 id="pdo-live-queue">Reason, route, stop.</h2></div><p>No browser-supplied workspace, operator, programme, endpoint or provider identity is trusted.</p></div><div class="pdo-live-queue">${queue || '<div class="pdo-live-empty">The bounded queue is empty.</div>'}</div></section><section class="pdo-live-grid"><article class="pdo-live-panel"><div class="pdo-live-head"><div><span class="pdo-live-label">Manager evidence</span><h2>Inputs and outcomes stay separate.</h2></div></div><div class="pdo-live-stats"><article class="pdo-live-stat"><span>Reviewed</span><strong>${number(snapshot.manager.prospectsReviewed)}</strong><small>Queue evidence</small></article><article class="pdo-live-stat"><span>Attempts</span><strong>${number(snapshot.manager.validAttempts)}</strong><small>Human-recorded</small></article><article class="pdo-live-stat"><span>Positive</span><strong>${number(snapshot.manager.positiveResponses)}</strong><small>Verified outcome</small></article><article class="pdo-live-stat"><span>Stopped</span><strong>${number(snapshot.manager.stopped + snapshot.manager.suppressed)}</strong><small>Protected contacts</small></article><article class="pdo-live-stat"><span>Blocked</span><strong>${number(snapshot.manager.blocked)}</strong><small>Fail closed</small></article><article class="pdo-live-stat"><span>Cooling</span><strong>${number(snapshot.manager.cooling)}</strong><small>No repeat yet</small></article><article class="pdo-live-stat"><span>Booked</span><strong>${number(snapshot.manager.booked)}</strong><small>Admin task created</small></article><article class="pdo-live-stat"><span>No response</span><strong>${number(snapshot.manager.noResponse)}</strong><small>Follow-up cooldown</small></article><article class="pdo-live-stat"><span>Invalid</span><strong>${number(snapshot.manager.invalidTargets)}</strong><small>Stopped safely</small></article><article class="pdo-live-stat"><span>LAPS pending</span><strong>${number(snapshot.manager.responseEvidencePending)}</strong><small>No false promotion</small></article></div></article><aside class="pdo-live-panel"><div class="pdo-live-head"><div><span class="pdo-live-label">Recent outcomes</span><h2>Delayed replies stay actionable</h2></div></div><div class="pdo-live-recent">${recent || '<div class="pdo-live-empty">No outcomes recorded in the last 30 UTC days.</div>'}</div></aside></section><footer class="pdo-live-footer"><span><strong>Authoritative operating page.</strong> Snapshot ${escapeHtml(timestamp(snapshot.snapshotAt))} UTC.</span><span>Provider effects 0 · external effects OFF · immutable outcomes · admin tasks only</span></footer></article>`;
}
