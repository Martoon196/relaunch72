/** Phone-first approval queue and campaign journey pages. Native forms only; no client script. */
import { escapeHtml as e } from './ui.js';
import { APPROVAL_ALL_COUNT_MAX, APPROVAL_QUEUE_BATCH_MAX, APPROVAL_QUEUE_BATCH_ROUTE, APPROVAL_QUEUE_DECIDE_ROUTE, APPROVAL_QUEUE_ROUTE, BRAND_ACCOUNT, BRAND_ALL, brandQuery,
  type ApprovalDecisionResult, type ApprovalItem, type ApprovalOverview, type ApprovalQueueSnapshot, type BrandSelection } from './approval-queue-service.js';
import { CAMPAIGN_JOURNEY_ROUTE, type CampaignJourneySnapshot, type JourneyCounts } from './campaign-journey-service.js';

const STYLE = `<style data-approval-queue>
.aq{max-width:760px;margin:0 auto;padding:0 2px 96px}
.aq h1{margin:0 0 6px;font-size:clamp(24px,6vw,32px)}.aq-lede{margin:0 0 14px;color:var(--muted,#555)}
.aq-boundary{border:1px solid var(--line,#ddd);border-radius:10px;padding:10px 12px;margin:0 0 16px;font-size:14px;background:var(--panel-subtle,#f7f7f7)}
.aq-notice{border-radius:10px;padding:10px 12px;margin:0 0 16px;border:1px solid var(--line-strong,#999)}.aq-notice.bad{border-color:#b42318}
.aq-links{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px}.aq-links a{min-height:44px;display:inline-flex;align-items:center;padding:0 14px;border:1px solid var(--line,#ddd);border-radius:999px;background:var(--panel,#fff);color:var(--ink,#152033);font-weight:700;font-size:14px;text-decoration:none}.aq-links a:hover{border-color:var(--line-strong,#999)}
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
.aq-quiet{min-height:48px}
.aq-actions>a{min-height:44px;display:inline-flex;align-items:center;font-weight:700}
.aq-confirm{display:flex;gap:8px;align-items:flex-start;font-size:14px;flex:1 1 100%}
.aq-pick{display:inline-flex;gap:6px;align-items:center;min-height:44px;font-size:14px}
.aq-batch{position:sticky;bottom:12px;z-index:20;box-shadow:0 8px 24px rgba(16,24,39,.12);margin:18px 0 0;padding:10px 12px;border:1px solid var(--line-strong,#999);border-radius:12px;background:var(--panel,#fff);display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.aq-batch p{margin:0;font-size:13px;flex:1 1 200px}
.aq-results li{margin:0 0 8px}.aq-ok{font-weight:800}.aq-fail{font-weight:800;color:#b42318}
.aq-table{width:100%;border-collapse:collapse;font-size:14px}.aq-table th,.aq-table td{text-align:left;padding:6px 4px;border-top:1px solid var(--line,#ddd);vertical-align:top}
.aq-table td.n{text-align:right;font-variant-numeric:tabular-nums}.aq-thumb{width:56px;height:auto;border-radius:6px}
.aq-unknown{font-style:italic}
.aq-brands{margin:0 0 16px;padding:10px 12px;border:1px solid var(--line,#ddd);border-radius:12px;background:var(--panel,#fff)}
.aq-brands-label{display:block;margin:0 0 8px;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#555)}
.aq-brands-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.aq-brand{min-height:48px;display:inline-flex;align-items:center;gap:8px;padding:0 16px;border:1px solid var(--line-strong,#999);border-radius:10px;background:var(--panel,#fff);color:var(--ink,#152033);font-weight:700;font-size:15px;text-decoration:none;overflow-wrap:anywhere}
.aq-brand[aria-current=page]{background:var(--ink,#152033);color:var(--panel,#fff);border-color:var(--ink,#152033)}
.aq-brand.quiet{border-style:dashed;font-weight:600}
.aq-count{display:inline-flex;min-width:24px;height:24px;padding:0 7px;align-items:center;justify-content:center;border-radius:999px;background:#b42318;color:#fff;font-size:13px;font-weight:800;font-variant-numeric:tabular-nums}
.aq-brands select{min-height:48px;font-size:16px;flex:1 1 200px;max-width:100%}.aq-brands form{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0;flex:1 1 100%}
.aq-brands-note{margin:8px 0 0;font-size:13px;color:var(--muted,#555)}
.aq-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.aq-biz{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}.aq-biz h2{margin:0;font-size:18px;overflow-wrap:anywhere}.aq-biz p{margin:4px 0 0}
@media(max-width:640px){.aq-batch{bottom:calc(86px + env(safe-area-inset-bottom))}}
/* The batch bar only takes screen space once something is ticked (browsers without :has keep it always on). */
@supports selector(:has(a)){.aq:not(:has(.aq-pick input:checked)) .aq-batch{display:none}}
@media(max-width:560px){.aq-table thead{display:none}.aq-table tr{display:block;border-top:1px solid var(--line,#ddd);padding:6px 0}.aq-table td{display:inline-block;border:0;padding:2px 6px 2px 0}.aq-table td.n::before{content:attr(data-label) ": ";font-weight:700}}
</style>`;

/** Above this many businesses the picker is one select instead of a row of buttons. */
const PICKER_BUTTON_MAX = 6;

export interface BrandPickerInput {
  /** The page the picker switches (the queue or campaign results). */
  readonly route: string;
  /** Items waiting in the business being shown. Other businesses are not counted here: that would read every queue on every page. */
  readonly waiting?: number | null;
  /** Offer the "All businesses" list (the queue only). */
  readonly all?: boolean;
  /** Where a new business is added. Omitted where that page is not served. */
  readonly addHref?: string | null;
}

/** What the signed-in account's own items are called (they sit outside the businesses). */
export const ACCOUNT_LABEL = 'Follow-ups and your content';

/** "Business" picker: plain links (or one select when there are many). Names are escaped; every target is re-checked by the server. */
export function renderBrandPicker(selection: BrandSelection, input: BrandPickerInput): string {
  const { brands, selected, view } = selection;
  // The signed-in workspace's own items need their own entry only when that workspace is not one of the businesses.
  // (`selection.account` is false on the central address, where those items are never served.)
  const account = brands.length > 0 && selection.account && input.all === true;
  const add = input.addHref && selection.canAdd ? `<a class="aq-brand quiet" href="${e(input.addHref)}">Add a business</a>` : '';
  // No business yet: say so only when nothing else is on the page, never above items that are waiting.
  if (!brands.length) return add ? `<nav class="aq-brands" aria-label="Business"><span class="aq-brands-label">Business</span><div class="aq-brands-row">${add}</div>${typeof input.waiting === 'number' && input.waiting > 0 ? '' : '<p class="aq-brands-note">No business is set up for content yet.</p>'}</nav>` : '';
  // One business and nothing else to switch to: a picker with nothing to pick is noise. The page already names the business.
  if (brands.length === 1 && !account) return '';
  const count = (id: string) => selected?.id === id && typeof input.waiting === 'number' && input.waiting > 0
    ? `<span class="aq-count" title="${input.waiting} waiting">${input.waiting}<span class="aq-sr"> waiting</span></span>` : '';
  const all = input.all && brands.length > 1;
  let choices: string, label = '<span class="aq-brands-label">Business</span>';
  if (brands.length > PICKER_BUTTON_MAX) {
    label = ''; // the select carries its own <label>
    const options = [
      ...brands.map((b) => `<option value="${e(b.id)}"${selected?.id === b.id ? ' selected' : ''}>${e(b.name)}${selected?.id === b.id && typeof input.waiting === 'number' && input.waiting > 0 ? ` (${input.waiting} waiting)` : ''}</option>`),
      ...(all ? [`<option value="${BRAND_ALL}"${view === 'all' ? ' selected' : ''}>All businesses</option>`] : []),
      ...(account ? [`<option value="${BRAND_ACCOUNT}"${view === 'account' ? ' selected' : ''}>${ACCOUNT_LABEL}</option>`] : []),
    ].join('');
    choices = `<form method="get" action="${e(input.route)}"><label class="aq-brands-label" for="aq-business">Business</label><select id="aq-business" name="brand">${options}</select><button class="button" type="submit">Show</button></form>${add}`;
  } else {
    choices = `${brands.map((b) => `<a class="aq-brand" href="${e(input.route)}?brand=${e(b.id)}"${selected?.id === b.id ? ' aria-current="page"' : ''}>${e(b.name)}${count(b.id)}</a>`).join('')}`
      + (all ? `<a class="aq-brand" href="${e(input.route)}?brand=${BRAND_ALL}"${view === 'all' ? ' aria-current="page"' : ''}>All businesses</a>` : '')
      + (account ? `<a class="aq-brand" href="${e(input.route)}?brand=${BRAND_ACCOUNT}"${view === 'account' ? ' aria-current="page"' : ''}>${ACCOUNT_LABEL}</a>` : '') + add;
  }
  return `<nav class="aq-brands" aria-label="Business">${label}<div class="aq-brands-row">${choices}</div></nav>`;
}

/** Links shown under the heading. On the central content address only the pages served there are offered. */
export interface QueueLinks { readonly actionCentre: boolean; readonly central: boolean }
const homeLink = (links: QueueLinks) => links.central ? '<a href="/portal/seo-blog">Your businesses</a>' : '<a href="/portal">Home</a>';
const addBusinessHref = '/portal/seo-blog#add-business';

function waiting(since: string | null, now: number): string {
  if (!since) return '';
  const ms = now - Date.parse(since);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const days = Math.floor(ms / 86_400_000), hours = Math.floor(ms / 3_600_000);
  return days >= 1 ? `waiting ${days} day${days === 1 ? '' : 's'}` : hours >= 1 ? `waiting ${hours} hour${hours === 1 ? '' : 's'}` : 'new';
}

function card(item: ApprovalItem, csrf: string, now: number, brandKey: string): string {
  const media = item.imageHref ? `<img src="${e(item.imageHref)}" alt="${e(`Preview: ${item.title}`)}" loading="lazy">`
    : item.videoHref ? `<video controls muted playsinline preload="metadata" src="${e(item.videoHref)}"></video>` : '';
  const ready = item.state === 'ready';
  const confirm = ready && item.confirmation ? `<label class="aq-confirm"><input type="checkbox" name="confirmed" value="1" required> ${e(item.confirmation)}</label>` : '';
  const refuse = item.refuseLabel ? `<button class="button secondary aq-quiet" type="submit" name="action" value="refuse" formnovalidate>${e(item.refuseLabel)}</button>` : '';
  const form = ready || refuse ? `<form method="post" action="${APPROVAL_QUEUE_DECIDE_ROUTE}"><input type="hidden" name="_csrf" value="${e(csrf)}"><input type="hidden" name="brand" value="${e(brandKey)}"><input type="hidden" name="ref" value="${e(item.ref)}">${confirm}${ready ? '<button class="button aq-main" type="submit" name="action" value="approve">Approve</button>' : ''}${refuse}</form>` : '';
  const pick = ready && item.batchable ? `<label class="aq-pick"><input type="checkbox" name="ref" value="${e(item.ref)}" form="aq-batch"> Tick to approve several at once</label>` : '';
  return `<article class="aq-card" data-kind="${e(item.kind)}"><div class="aq-meta"><span>${e(item.label)}</span><span>${e(waiting(item.since, now))}</span></div>
<h3>${e(item.title)}</h3>${media}<p class="aq-preview">${e(item.preview)}</p><p class="aq-why"><strong>Why you are seeing this:</strong> ${e(item.why)}</p>
${ready ? '' : `<p class="aq-blocked">${e(item.blockedReason ?? 'Open this item on its own page first.')}</p>`}
<div class="aq-actions">${form}<a href="${e(item.editHref)}">${e(item.editLabel)}</a>${pick}</div></article>`;
}

export function renderApprovalQueueBody(snapshot: ApprovalQueueSnapshot, input: { csrf: string; now: number; notice?: { ok: boolean; text: string } | null; actionCentre: boolean; central?: boolean }): string {
  const links: QueueLinks = { actionCentre: input.actionCentre, central: input.central === true };
  const { selection } = snapshot, name = selection.selected?.name ?? null;
  const notice = input.notice ? `<p class="aq-notice${input.notice.ok ? '' : ' bad'}" role="status">${e(input.notice.text)}</p>` : '';
  const sections = snapshot.sections.map((s) => `<section class="aq-section" aria-labelledby="aq-${e(s.kind)}"><h2 id="aq-${e(s.kind)}">${e(s.label)} (${s.items.length})</h2>${s.error ? `<p class="aq-blocked">${e(s.error)}</p>` : ''}${s.items.map((i) => card(i, input.csrf, input.now, snapshot.brandKey)).join('')}</section>`).join('');
  const batchable = snapshot.sections.some((s) => s.items.some((i) => i.state === 'ready' && i.batchable));
  const batch = batchable ? `<form id="aq-batch" class="aq-batch" method="post" action="${APPROVAL_QUEUE_BATCH_ROUTE}"><input type="hidden" name="_csrf" value="${e(input.csrf)}"><input type="hidden" name="brand" value="${e(snapshot.brandKey)}"><button class="button aq-main" type="submit">Approve selected</button><p>Up to ${APPROVAL_QUEUE_BATCH_MAX} at a time${name ? `, for ${e(name)} only` : ''}. Each one is checked on its own; if one fails, the others still go through and you see which.</p></form>` : '';
  const empty = snapshot.total === 0 ? `<p class="aq-boundary"><strong>Nothing is waiting for you${name ? ` in ${e(name)}` : ''}.</strong> New drafts appear here as soon as they are ready.</p>` : '';
  // Flows and "Your content" are read through the sign-in, so they are only ever listed under the business signed in to.
  const elsewhere = !input.central && name && !snapshot.sessionSections
    ? `<p class="aq-brands-note">Follow-up flows and “Your content” are not listed for ${e(name)}. They stay with the business you signed in to.</p>` : '';
  const journey = `${CAMPAIGN_JOURNEY_ROUTE}${selection.selected ? brandQuery(selection) : ''}`;
  return `${STYLE}<div class="aq"><h1>Waiting for your approval</h1>
${renderBrandPicker(selection, { route: APPROVAL_QUEUE_ROUTE, waiting: snapshot.total, all: true, addHref: addBusinessHref })}
<p class="aq-lede">${name ? `<strong>${e(name)}</strong> · ` : ''}${snapshot.total} item${snapshot.total === 1 ? '' : 's'} · ${snapshot.ready} ready to approve now</p>
<p class="aq-boundary">Approving content only says the words and pictures are right. It does not give permission to contact anyone, it does not start anything, and it does not spend money. Those stay separate.</p>
${notice}<nav class="aq-links" aria-label="Related pages">${links.actionCentre && !links.central ? '<a href="/portal/actions">Action Centre</a>' : ''}<a href="${e(journey)}">Campaign results</a>${selection.selected ? `<a href="/portal/seo-blog/b/${e(selection.selected.id)}/dna">Brand DNA</a>` : ''}${homeLink(links)}</nav>
${empty}${sections}${elsewhere}${batch}</div>`;
}

/** "All businesses": one row per business with what is waiting and one tap into it. Nothing can be approved from here. */
export function renderApprovalOverviewBody(overview: ApprovalOverview, input: { actionCentre: boolean; central?: boolean }): string {
  const links: QueueLinks = { actionCentre: input.actionCentre, central: input.central === true };
  const rows = overview.rows.map((r) => {
    const line = !r.counted ? 'Open it to see what is waiting.'
      : r.total === null ? 'This could not be counted just now. That is unknown, not zero. Open it to check.'
      : r.total === 0 ? 'Nothing is waiting.'
      : `<strong>${r.total} waiting</strong> · ${r.ready} ready to approve now`;
    return `<section class="aq-card"><div class="aq-biz"><div><h2>${e(r.brand.name)}</h2><p>${line}</p></div>
<a class="button aq-main" href="${APPROVAL_QUEUE_ROUTE}?brand=${e(r.brand.id)}">Open ${e(r.brand.name)}</a></div></section>`;
  }).join('');
  const own = overview.account ?? null;
  const ownRow = !own ? '' : `<section class="aq-card"><div class="aq-biz"><div><h2>${ACCOUNT_LABEL}</h2><p>${own.total === null ? 'This could not be counted just now. That is unknown, not zero. Open it to check.'
    : own.total === 0 ? 'Nothing is waiting.' : `<strong>${own.total} waiting</strong> · ${own.ready} ready to approve now`}</p></div>
<a class="button aq-main" href="${APPROVAL_QUEUE_ROUTE}?brand=${BRAND_ACCOUNT}">Open ${ACCOUNT_LABEL.toLowerCase()}</a></div></section>`;
  const known = overview.rows.filter((r) => r.total !== null), total = known.reduce((sum, r) => sum + (r.total ?? 0), 0) + (own?.total ?? 0);
  const partial = known.length < overview.rows.length || (own !== null && own.total === null);
  return `${STYLE}<div class="aq"><h1>All businesses</h1>
${renderBrandPicker(overview.selection, { route: APPROVAL_QUEUE_ROUTE, all: true, addHref: addBusinessHref })}
<p class="aq-lede">${total} item${total === 1 ? '' : 's'} waiting across ${known.length} business${known.length === 1 ? '' : 'es'}${partial ? ' that could be counted' : ''}. Open a business to approve its items.</p>
<p class="aq-boundary">Each business is approved on its own page, so nothing is ever approved for the wrong business.${overview.rows.length > APPROVAL_ALL_COUNT_MAX ? ` Only the first ${APPROVAL_ALL_COUNT_MAX} businesses are counted here.` : ''}</p>
<nav class="aq-links" aria-label="Related pages">${links.actionCentre && !links.central ? '<a href="/portal/actions">Action Centre</a>' : ''}${homeLink(links)}</nav>
${ownRow}${rows}</div>`;
}

export function renderBatchResultsBody(results: readonly ApprovalDecisionResult[], back = APPROVAL_QUEUE_ROUTE as string): string {
  const done = results.filter((r) => r.ok).length;
  return `${STYLE}<div class="aq"><h1>Approval results</h1><p class="aq-lede">${done} of ${results.length} done. Nothing else was changed.</p>
<ul class="aq-results">${results.map((r) => `<li><span class="${r.ok ? 'aq-ok' : 'aq-fail'}">${r.ok ? 'Done' : 'Not done'}</span> — <strong>${e(r.title)}</strong>: ${e(r.message)}</li>`).join('')}</ul>
<p><a class="button" href="${e(back)}">Back to approvals</a></p></div>`;
}

const cells = (c: JourneyCounts) => `<td class="n" data-label="Leads">${c.leads}</td><td class="n" data-label="Qualified">${c.qualified}</td><td class="n" data-label="Booked">${c.booked}</td><td class="n" data-label="Sold">${c.sold}</td>`;

export function renderCampaignJourneyBody(snapshot: CampaignJourneySnapshot, input: { central?: boolean } = {}): string {
  const { selection } = snapshot, name = selection.selected?.name ?? null;
  // The contacts page shows the signed-in business's contacts, so it is only offered when these results are that business's.
  const contacts = !input.central && (!selection.selected || selection.selected.id === selection.sessionWorkspaceId.toLowerCase());
  const campaigns = snapshot.campaigns.map((c) => `<section class="aq-card"><div class="aq-meta"><span>Campaign</span><span>${c.readAt ? `read ${e(c.readAt.slice(0, 16).replace('T', ' '))} UTC` : 'results unavailable'}</span></div>
<h3><a href="${e(c.href)}">${e(c.name)}</a></h3><p class="aq-why">Campaign tag: ${e(c.utmCampaign)}${c.qualifiedMapped === false ? ' · No “qualified” stage is set, so only won opportunities count as qualified.' : ''}</p>
${c.readAt === null ? '<p class="aq-blocked">The results could not be read just now. These counts are unknown, not zero.</p>' : ''}
<table class="aq-table"><thead><tr><th>Asset</th><th>Leads</th><th>Qualified</th><th>Booked</th><th>Sold</th></tr></thead><tbody>
${c.assets.length ? c.assets.map((a) => `<tr${a.unknown ? ' class="aq-unknown"' : ''}><td>${a.imageHref ? `<img class="aq-thumb" src="${e(a.imageHref)}" alt="">` : ''}<strong>${e(a.label)}</strong><br><small>${e(a.detail)}</small></td>${cells(a.counts)}</tr>`).join('') : '<tr><td colspan="5">No tracked assets yet. Approve artwork in Creative Studio and hand it to this campaign to get a tracked link.</td></tr>'}
<tr><td><strong>Campaign total</strong></td>${cells(c.totals)}</tr></tbody></table></section>`).join('');
  const body = snapshot.available
    ? (campaigns || '<p class="aq-boundary">No acquisition campaigns yet. Results appear here once a campaign has tracked links.</p>')
    : !name && selection.brands.length === 0 && selection.canAdd ? '<p class="aq-boundary">No business is set up for content yet, so there are no campaign results to show.</p>'
    : !name ? '<p class="aq-boundary">Choose a business above to see its campaign results.</p>'
    : '<p class="aq-boundary">Campaign results need the campaign creator and Creative Studio, which are not switched on here.</p>';
  return `${STYLE}<div class="aq"><h1>Campaign results</h1>
${renderBrandPicker(selection, { route: CAMPAIGN_JOURNEY_ROUTE, addHref: addBusinessHref })}
<p class="aq-lede">${name ? `<strong>${e(name)}</strong> · ` : ''}From campaign, to the asset someone saw, to their enquiry, contact and opportunity.</p>
<p class="aq-boundary"><strong>These are observations, not proof.</strong> A count shows what happened after someone used a tracked link, not that the campaign caused it.</p>
<nav class="aq-links" aria-label="Related pages"><a href="${APPROVAL_QUEUE_ROUTE}${selection.selected ? brandQuery(selection) : ''}">Approvals</a>${contacts ? '<a href="/portal/crm/contacts">Contacts</a>' : ''}${homeLink({ actionCentre: false, central: input.central === true })}</nav>
${body}
<section class="aq-card"><h2>Unknown source</h2>${snapshot.taggedEnquiries === null ? '' : `<p>${snapshot.taggedEnquiries} enquir${snapshot.taggedEnquiries === 1 ? 'y has' : 'ies have'} a campaign tag that matched a link this brand issued.</p>`}
<p>These are not counted against any campaign above, because the records cannot connect them:</p><ul>${snapshot.unknownSources.map((s) => `<li>${e(s)}</li>`).join('')}</ul></section>
<details class="aq-card"><summary><strong>How these numbers are counted</strong></summary><ul>${snapshot.limits.map((s) => `<li>${e(s)}</li>`).join('')}</ul></details></div>`;
}
