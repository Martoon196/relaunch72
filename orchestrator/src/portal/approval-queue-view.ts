/** Phone-first approval queue and campaign journey pages. Native forms only; no client script. */
import { escapeHtml as e } from './ui.js';
import { APPROVAL_QUEUE_BATCH_MAX, APPROVAL_QUEUE_BATCH_ROUTE, APPROVAL_QUEUE_DECIDE_ROUTE, APPROVAL_QUEUE_ROUTE,
  type ApprovalDecisionResult, type ApprovalItem, type ApprovalQueueSnapshot } from './approval-queue-service.js';
import { CAMPAIGN_JOURNEY_ROUTE, type CampaignJourneySnapshot, type JourneyCounts } from './campaign-journey-service.js';

const STYLE = `<style data-approval-queue>
.aq{max-width:760px;margin:0 auto;padding:0 2px 96px}
.aq h1{margin:0 0 6px;font-size:clamp(24px,6vw,32px)}.aq-lede{margin:0 0 14px;color:var(--muted,#555)}
.aq-boundary{border:1px solid var(--line,#ddd);border-radius:10px;padding:10px 12px;margin:0 0 16px;font-size:14px;background:var(--panel-subtle,#f7f7f7)}
.aq-notice{border-radius:10px;padding:10px 12px;margin:0 0 16px;border:1px solid var(--line-strong,#999)}.aq-notice.bad{border-color:#b42318}
.aq-links{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px}.aq-links a{min-height:44px;display:inline-flex;align-items:center}
.aq-section{margin:22px 0 0}.aq-section>h2{font-size:18px;margin:0 0 10px}
.aq-card{border:1px solid var(--line,#ddd);border-radius:12px;padding:14px;margin:0 0 12px;background:var(--panel,#fff)}
.aq-meta{display:flex;justify-content:space-between;gap:8px;font-size:12px;font-weight:700;color:var(--muted,#555);text-transform:uppercase;letter-spacing:.03em}
.aq-card h3{margin:6px 0 8px;font-size:17px;overflow-wrap:anywhere}
.aq-preview{margin:0 0 8px;white-space:pre-wrap;overflow-wrap:anywhere}.aq-why{margin:0 0 10px;font-size:14px;color:var(--muted,#555)}
.aq-card img,.aq-card video{display:block;max-width:100%;height:auto;border-radius:8px;margin:0 0 10px}
.aq-blocked{margin:0 0 10px;padding:8px 10px;border-radius:8px;border:1px solid var(--line-strong,#999);font-size:14px}
.aq-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.aq-actions form{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:0;flex:1 1 100%}
.aq-main{min-height:48px;padding:0 22px;font-size:16px;font-weight:800;flex:1 1 auto}
.aq-quiet{min-height:44px;background:transparent;border:1px solid var(--line-strong,#999);color:inherit}
.aq-confirm{display:flex;gap:8px;align-items:flex-start;font-size:14px;flex:1 1 100%}
.aq-pick{display:inline-flex;gap:6px;align-items:center;min-height:44px;font-size:14px}
.aq-batch{position:sticky;bottom:0;margin:18px 0 0;padding:10px 12px;border:1px solid var(--line-strong,#999);border-radius:12px;background:var(--panel,#fff);display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.aq-batch p{margin:0;font-size:13px;flex:1 1 200px}
.aq-results li{margin:0 0 8px}.aq-ok{font-weight:800}.aq-fail{font-weight:800;color:#b42318}
.aq-table{width:100%;border-collapse:collapse;font-size:14px}.aq-table th,.aq-table td{text-align:left;padding:6px 4px;border-top:1px solid var(--line,#ddd);vertical-align:top}
.aq-table td.n{text-align:right;font-variant-numeric:tabular-nums}.aq-thumb{width:56px;height:auto;border-radius:6px}
.aq-unknown{font-style:italic}
@media(max-width:560px){.aq-table thead{display:none}.aq-table tr{display:block;border-top:1px solid var(--line,#ddd);padding:6px 0}.aq-table td{display:inline-block;border:0;padding:2px 6px 2px 0}.aq-table td.n::before{content:attr(data-label) ": ";font-weight:700}}
</style>`;

function waiting(since: string | null, now: number): string {
  if (!since) return '';
  const ms = now - Date.parse(since);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const days = Math.floor(ms / 86_400_000), hours = Math.floor(ms / 3_600_000);
  return days >= 1 ? `waiting ${days} day${days === 1 ? '' : 's'}` : hours >= 1 ? `waiting ${hours} hour${hours === 1 ? '' : 's'}` : 'new';
}

function card(item: ApprovalItem, csrf: string, now: number): string {
  const media = item.imageHref ? `<img src="${e(item.imageHref)}" alt="${e(`Preview: ${item.title}`)}" loading="lazy">`
    : item.videoHref ? `<video controls muted playsinline preload="metadata" src="${e(item.videoHref)}"></video>` : '';
  const ready = item.state === 'ready';
  const confirm = ready && item.confirmation ? `<label class="aq-confirm"><input type="checkbox" name="confirmed" value="1" required> ${e(item.confirmation)}</label>` : '';
  const refuse = item.refuseLabel ? `<button class="aq-quiet secondary" type="submit" name="action" value="refuse" formnovalidate>${e(item.refuseLabel)}</button>` : '';
  const form = ready || refuse ? `<form method="post" action="${APPROVAL_QUEUE_DECIDE_ROUTE}"><input type="hidden" name="_csrf" value="${e(csrf)}"><input type="hidden" name="ref" value="${e(item.ref)}">${confirm}${ready ? '<button class="aq-main" type="submit" name="action" value="approve">Approve</button>' : ''}${refuse}</form>` : '';
  const pick = ready && item.batchable ? `<label class="aq-pick"><input type="checkbox" name="ref" value="${e(item.ref)}" form="aq-batch"> Select</label>` : '';
  return `<article class="aq-card" data-kind="${e(item.kind)}"><div class="aq-meta"><span>${e(item.label)}</span><span>${e(waiting(item.since, now))}</span></div>
<h3>${e(item.title)}</h3>${media}<p class="aq-preview">${e(item.preview)}</p><p class="aq-why"><strong>Why you are seeing this:</strong> ${e(item.why)}</p>
${ready ? '' : `<p class="aq-blocked">${e(item.blockedReason ?? 'Open this item on its own page first.')}</p>`}
<div class="aq-actions">${form}<a href="${e(item.editHref)}">${e(item.editLabel)}</a>${pick}</div></article>`;
}

export function renderApprovalQueueBody(snapshot: ApprovalQueueSnapshot, input: { csrf: string; now: number; notice?: { ok: boolean; text: string } | null; actionCentre: boolean }): string {
  const notice = input.notice ? `<p class="aq-notice${input.notice.ok ? '' : ' bad'}" role="status">${e(input.notice.text)}</p>` : '';
  const sections = snapshot.sections.map((s) => `<section class="aq-section" aria-labelledby="aq-${e(s.kind)}"><h2 id="aq-${e(s.kind)}">${e(s.label)} (${s.items.length})</h2>${s.error ? `<p class="aq-blocked">${e(s.error)}</p>` : ''}${s.items.map((i) => card(i, input.csrf, input.now)).join('')}</section>`).join('');
  const batchable = snapshot.sections.some((s) => s.items.some((i) => i.state === 'ready' && i.batchable));
  const batch = batchable ? `<form id="aq-batch" class="aq-batch" method="post" action="${APPROVAL_QUEUE_BATCH_ROUTE}"><input type="hidden" name="_csrf" value="${e(input.csrf)}"><button class="aq-main" type="submit">Approve selected</button><p>Up to ${APPROVAL_QUEUE_BATCH_MAX} at a time. Each one is checked on its own; if one fails, the others still go through and you see which.</p></form>` : '';
  const empty = snapshot.total === 0 ? '<p class="aq-boundary"><strong>Nothing is waiting for you.</strong> New drafts appear here as soon as they are ready.</p>' : '';
  return `${STYLE}<div class="aq"><h1>Waiting for your approval</h1><p class="aq-lede">${snapshot.total} item${snapshot.total === 1 ? '' : 's'} · ${snapshot.ready} ready to approve now</p>
<p class="aq-boundary">Approving content only says the words and pictures are right. It does not give permission to contact anyone, it does not start anything, and it does not spend money. Those stay separate.</p>
${notice}<nav class="aq-links" aria-label="Related pages">${input.actionCentre ? '<a href="/portal/actions">Action Centre</a>' : ''}<a href="${CAMPAIGN_JOURNEY_ROUTE}">Campaign results</a><a href="/portal">Home</a></nav>
${empty}${sections}${batch}</div>`;
}

export function renderBatchResultsBody(results: readonly ApprovalDecisionResult[]): string {
  const done = results.filter((r) => r.ok).length;
  return `${STYLE}<div class="aq"><h1>Approval results</h1><p class="aq-lede">${done} of ${results.length} done. Nothing else was changed.</p>
<ul class="aq-results">${results.map((r) => `<li><span class="${r.ok ? 'aq-ok' : 'aq-fail'}">${r.ok ? 'Done' : 'Not done'}</span> — <strong>${e(r.title)}</strong>: ${e(r.message)}</li>`).join('')}</ul>
<p><a class="button" href="${APPROVAL_QUEUE_ROUTE}">Back to approvals</a></p></div>`;
}

const cells = (c: JourneyCounts) => `<td class="n" data-label="Leads">${c.leads}</td><td class="n" data-label="Qualified">${c.qualified}</td><td class="n" data-label="Booked">${c.booked}</td><td class="n" data-label="Sold">${c.sold}</td>`;

export function renderCampaignJourneyBody(snapshot: CampaignJourneySnapshot): string {
  const campaigns = snapshot.campaigns.map((c) => `<section class="aq-card"><div class="aq-meta"><span>Campaign</span><span>${c.readAt ? `read ${e(c.readAt.slice(0, 16).replace('T', ' '))} UTC` : 'results unavailable'}</span></div>
<h3><a href="${e(c.href)}">${e(c.name)}</a></h3><p class="aq-why">Campaign tag: ${e(c.utmCampaign)}${c.qualifiedMapped === false ? ' · No “qualified” stage is set, so only won opportunities count as qualified.' : ''}</p>
${c.readAt === null ? '<p class="aq-blocked">The results could not be read just now. These counts are unknown, not zero.</p>' : ''}
<table class="aq-table"><thead><tr><th>Asset</th><th>Leads</th><th>Qualified</th><th>Booked</th><th>Sold</th></tr></thead><tbody>
${c.assets.length ? c.assets.map((a) => `<tr${a.unknown ? ' class="aq-unknown"' : ''}><td>${a.imageHref ? `<img class="aq-thumb" src="${e(a.imageHref)}" alt="">` : ''}<strong>${e(a.label)}</strong><br><small>${e(a.detail)}</small></td>${cells(a.counts)}</tr>`).join('') : '<tr><td colspan="5">No tracked assets yet. Approve artwork in Creative Studio and hand it to this campaign to get a tracked link.</td></tr>'}
<tr><td><strong>Campaign total</strong></td>${cells(c.totals)}</tr></tbody></table></section>`).join('');
  const body = snapshot.available
    ? (campaigns || '<p class="aq-boundary">No acquisition campaigns yet. Results appear here once a campaign has tracked links.</p>')
    : '<p class="aq-boundary">Campaign results need the campaign creator and Creative Studio, which are not switched on here.</p>';
  return `${STYLE}<div class="aq"><h1>Campaign results</h1><p class="aq-lede">From campaign, to the asset someone saw, to their enquiry, contact and opportunity.</p>
<p class="aq-boundary"><strong>These are observations, not proof.</strong> A count shows what happened after someone used a tracked link, not that the campaign caused it.</p>
<nav class="aq-links" aria-label="Related pages"><a href="${APPROVAL_QUEUE_ROUTE}">Approvals</a><a href="/portal/crm/contacts">Contacts</a><a href="/portal">Home</a></nav>
${body}
<section class="aq-card"><h2>Unknown source</h2>${snapshot.taggedEnquiries === null ? '' : `<p>${snapshot.taggedEnquiries} enquir${snapshot.taggedEnquiries === 1 ? 'y has' : 'ies have'} a campaign tag that matched a link this brand issued.</p>`}
<p>These are not counted against any campaign above, because the records cannot connect them:</p><ul>${snapshot.unknownSources.map((s) => `<li>${e(s)}</li>`).join('')}</ul></section>
<details class="aq-card"><summary><strong>How these numbers are counted</strong></summary><ul>${snapshot.limits.map((s) => `<li>${e(s)}</li>`).join('')}</ul></details></div>`;
}
