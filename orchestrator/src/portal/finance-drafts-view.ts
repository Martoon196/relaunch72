import { escapeHtml as e } from './ui.js';
import { CRM_PORTAL_ROUTES } from './crm-views.js';
import { FIELDS, PACKAGE_VERSION, MODEL_VERSION, type Catalog, type Illustration, type ReviewPacket } from '../integrations/mh196/planning-client.js';
import type { FinanceReview, FinanceSnapshot, FinanceSource, SavedFinance } from './finance-drafts-service.js';

export const FINANCE_CLIENT_ROUTE = '/portal/assets/finance-drafts.js';
export const FINANCE_CLIENT_SOURCE = `(() => {
  let dirty = false;
  const form = document.querySelector('[data-finance-form]');
  if (form) {
    form.addEventListener('input', () => { dirty = true; });
    form.addEventListener('change', () => { dirty = true; });
    form.addEventListener('submit', () => { dirty = false; });
    addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
    form.addEventListener('invalid', event => { const details = event.target.closest('details'); if (details) details.open = true; }, true);
  }
  document.querySelectorAll('[data-finance-copy]').forEach(button => button.addEventListener('click', async () => {
    const target = document.getElementById(button.dataset.financeCopy);
    const status = document.getElementById(button.dataset.status);
    if (!target || !status) return;
    try {
      const bytes = new TextEncoder().encode(target.dataset.packet);
      let binary = ''; bytes.forEach(byte => { binary += String.fromCharCode(byte); });
      const encoded = btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
      const link = 'https://propertypredator.com/finance.html#import=' + encoded;
      target.value = link; target.hidden = false;
      try { await navigator.clipboard.writeText(link); status.textContent = 'Client review link copied. It contains these figures. Share it only with the intended client.'; }
      catch { target.focus(); target.select(); status.textContent = 'Copy the selected link. It contains these figures and is for the intended client.'; }
    } catch { status.textContent = 'The review link could not be prepared. Reopen this saved illustration.'; }
  }));
})();`;
const MODEL_NAMES: Record<string, string> = { btl: 'Buy to let', brrr: 'Buy, refurbish and refinance', bridging_refurb: 'Bridging and refurbishment', land_development: 'Land and development', conversion: 'Conversion', development_exit: 'Development exit' };
const LABELS: Record<string, string> = { current_value: 'Current security value (£)', exit_value: 'Value on exit / after works (£)', loan_requested: 'Requested borrowing (£)', purchase_price: 'Purchase price (£)', existing_debt: 'Existing debt (£)', works_cost: 'Works cost (£)', monthly_rent: 'Monthly rent (£)', term_months: 'Loan term (months)', borrower_broker_fee: 'MH196 broker fee', btl_fee_financed: 'Add BTL product fee to borrowing?', costs_confirmed: 'Have you checked all costs?', ltgdv_cap_pct: 'Loan to gross development value cap (%)', ltc_cap_pct: 'Loan to cost cap (%)' };
const CORE = ['purchase_price', 'current_value', 'exit_value', 'loan_requested', 'existing_debt', 'works_cost', 'term_months', 'monthly_rent'];
const path = (source: FinanceSource) => `/portal/crm/opportunities/${source.opportunityId}/finance`;
function label(key: string) { return LABELS[key] ?? `${key.replaceAll('_', ' ').replace(/^./, s => s.toUpperCase())}${FIELDS[key]?.kind === 'amount' ? ' (£)' : FIELDS[key]?.kind === 'percent' ? ' (%)' : ''}`; }
function header(source: FinanceSource): string { return `<style>.finance-panel{padding:22px;margin:18px 0}.finance-panel h2{font-size:1.15rem;margin-bottom:12px}.finance-panel summary{font-weight:700;cursor:pointer;min-height:44px}.finance-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:18px}.finance-field{display:grid;gap:6px;margin:10px 0;min-width:0}.finance-field input,.finance-field select,.finance-field textarea{font:inherit;width:100%;min-height:44px;padding:10px;border:1px solid var(--line-strong);border-radius:8px;background:var(--panel);color:var(--ink)}.finance-field small{color:var(--muted)}.finance-grid dd{margin:0;font-size:1.25rem;font-weight:700}.finance-grid dt{color:var(--muted)}.finance-panel textarea[readonly]{width:100%;max-width:100%;margin-top:12px;background:var(--panel);color:var(--ink)}@media(max-width:480px){.finance-panel{padding:15px}.finance-grid{grid-template-columns:1fr}}</style><nav aria-label="Finance breadcrumb"><a class="button secondary compact" href="/portal/crm/contacts/${e(source.contactId)}">← ${e(source.contactName)}</a> <a class="button secondary compact" href="${e(CRM_PORTAL_ROUTES.pipeline)}">Pipeline</a></nav><header class="page-heading"><div><p class="eyebrow">Staff preparation · MH196</p><h1>Indicative finance</h1><p>${e(source.opportunityName)} · ${e(source.contactName)}</p></div></header><p class="muted">Prepare figures with your client. This is a planning illustration, not a lender quote, offer or approval. No lender is contacted.</p>`; }
function scripts() { return `<script src="${FINANCE_CLIENT_ROUTE}" defer></script>`; }
function hidden(name: string, value: unknown): string { return `<input type="hidden" name="${name}" value="${e(value)}">`; }
function control(key: string, value: unknown): string {
  const field = FIELDS[key]!, id = `finance-${key}`, name = `input_${key}`;
  let input: string;
  if (field.kind === 'boolean' || field.kind === 'select') {
    const options = field.kind === 'boolean' ? ['false', 'true'] : field.options!;
    input = `<select id="${id}" name="${name}" required>${options.map(option => `<option value="${option}"${String(value) === option ? ' selected' : ''}>${field.kind === 'boolean' ? option === 'true' ? 'Yes' : 'No' : e(option.replaceAll('_', ' '))}</option>`).join('')}</select>`;
  } else if (field.kind === 'schedule') {
    return `<div class="finance-field"><span>Works spending</span><p>Spread evenly across the works period. Set the works cost, contingency and number of works months above.</p>${hidden(name, '[]')}</div>`;
  } else input = `<input id="${id}" name="${name}" type="number" inputmode="decimal" min="${field.min ?? 0}" max="${field.max}" step="${field.kind === 'integer' ? '1' : field.kind === 'amount' ? '0.01' : '0.00001'}" value="${e(value ?? '')}"${field.nullable ? '' : ' required'}>${field.nullable ? '<small>Leave blank if no cap is specified.</small>' : field.kind === 'amount' ? '<small>Enter 0 only when you have confirmed none applies.</small>' : ''}`;
  return `<label class="finance-field" for="${id}"><span>${e(label(key))}</span>${input}</label>`;
}
export function renderFinanceForm(snapshot: FinanceSnapshot, catalog: Catalog, model: string, csrf: string, form?: Record<string, string>, error?: string): string {
  const source = snapshot.source, product = catalog.products.find(p => p.id === model) ?? catalog.products[0]!;
  const values: Record<string, unknown> = { ...product.inputs };
  // Catalogue values are examples, never evidence of this client's property or costs.
  for (const [key, field] of Object.entries(FIELDS)) if (field.kind === 'amount' || ['term_months', 'works_months'].includes(key)) values[key] = '';
  values.borrower_broker_fee = '0';
  values.costs_confirmed = false;
  if (form) for (const key of Object.keys(FIELDS)) if (form[`input_${key}`] !== undefined) values[key] = form[`input_${key}`];
  const costs = Object.keys(FIELDS).filter(key => !CORE.includes(key) && FIELDS[key]!.kind === 'amount' && key !== 'borrower_broker_fee');
  const assumptions = Object.keys(FIELDS).filter(key => !CORE.includes(key) && !costs.includes(key) && key !== 'borrower_broker_fee');
  return `${header(source)}${error ? `<div role="alert" class="notice">${e(error)} Your figures are still below.</div>` : ''}
    <form action="${path(source)}" method="get"><input type="hidden" name="prepare" value="1"><label class="finance-field">Finance model<select name="model">${catalog.products.map(p => `<option value="${p.id}"${product.id === p.id ? ' selected' : ''}>${e(MODEL_NAMES[p.id])}</option>`).join('')}</select></label><button class="button secondary" type="submit">Choose model</button></form>
    <form action="${path(source)}/calculate" method="post" data-finance-form>
    ${hidden('_csrf', csrf)}${hidden('model', product.id)}${hidden('assumptions_as_of', product.as_of)}${hidden('opportunity_version', source.opportunityVersion)}${hidden('latest_version', source.latestVersion)}
    <section class="panel finance-panel"><h2>Property and borrowing</h2><p>Enter the client's figures. The CRM opportunity value has not been used as a property price.</p><div class="finance-grid">${CORE.map(key => control(key, values[key])).join('')}</div></section>
    <details class="panel finance-panel"><summary>Complete the costs</summary><p>Check each cost, including any acquisition costs you have already established. Tax is not calculated here.</p><div class="finance-grid">${costs.map(key => control(key, values[key])).join('')}</div></details>
    <details class="panel finance-panel"><summary>Review rates and finance assumptions</summary><p>Starting examples dated ${e(product.as_of)}. These are planning assumptions, not live lender rates. Check them with the client.</p><div class="finance-grid">${assumptions.map(key => control(key, values[key])).join('')}</div></details>
    <p>MH196 calculates its broker fee within the total finance cost. VAT and lender-paid commission remain unconfirmed.</p><button class="button" type="submit">Calculate illustration</button> <a class="button secondary" href="${path(source)}">Saved illustrations</a></form>${scripts()}`;
}
function pounds(value: string | null | undefined): string { return value == null ? 'Not available' : Number(value).toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 2 }); }
function result(illustration: Illustration): string {
  const pairs = [['gross_initial_advance', 'Modelled initial loan'], ['net_completion_cash', 'Cash available at completion'], ['total_interest', 'Interest over the term'], ['total_finance_cost', 'Total finance cost, including MH196 fee'], ['peak_cash_required', 'Peak cash required'], ['funding_shortfall', 'Funding shortfall'], ['monthly_rental_cash_flow', 'Monthly rental cash flow']];
  const additional = Object.entries(illustration.results).filter(([key]) => !pairs.some(([primary]) => primary === key));
  const columns = ['month', 'works_spend', 'drawdown', 'interest', 'equity_required', 'debt_balance'];
  return `<dl class="finance-grid">${pairs.filter(([key]) => illustration.results[key!] != null).map(([key, title]) => `<div><dt>${e(title)}</dt><dd>${e(pounds(illustration.results[key!]))}</dd></div>`).join('')}<div><dt>MH196 fee included above (VAT unconfirmed)</dt><dd>${e(pounds(illustration.borrower_fee))}</dd></div></dl><ul>${[...new Set(illustration.warnings)].map(item => `<li>${e(item)}</li>`).join('')}</ul>
    <details><summary>Additional results and assumptions</summary><dl>${additional.map(([key, value]) => `<div><dt>${e(label(key))}</dt><dd>${e(value === null ? 'Not available' : key === 'binding_constraint' ? value.replaceAll('_', ' ') : key.endsWith('_pct') ? `${value}%` : pounds(value))}</dd></div>`).join('')}</dl><h3>Calculation assumptions</h3><ul>${[...new Set(illustration.assumptions)].map(item => `<li>${e(item)}</li>`).join('')}</ul></details>
    <details><summary>Monthly calculation</summary><div role="region" aria-label="Monthly finance figures" tabindex="0" style="overflow-x:auto"><table><caption>Modelled works, borrowing and cash needed each month</caption><thead><tr>${columns.map(key => `<th scope="col">${e(label(key))}</th>`).join('')}</tr></thead><tbody>${illustration.schedule.map(row => `<tr>${columns.map(key => `<td>${e(key === 'month' ? row[key] : pounds(String(row[key])))}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}
function packetDetails(p: ReviewPacket): string {
  return `<details><summary>Reviewed input figures</summary><dl>${Object.entries(p.planning.inputs).map(([key, value]) => {
    if (Array.isArray(value)) return `<div><dt>Works spending</dt><dd>${value.length ? `<table><caption>Reviewed works schedule</caption><thead><tr><th scope="col">Month</th><th scope="col">Amount</th></tr></thead><tbody>${value.map(row => `<tr><td>${row.month}</td><td>${e(pounds(row.amount))}</td></tr>`).join('')}</tbody></table>` : 'Spread evenly across the works period'}</dd></div>`;
    const field = FIELDS[key]!;
    const display = value === null ? 'No cap' : typeof value === 'boolean' ? value ? 'Yes' : 'No' : field.kind === 'amount' ? pounds(String(value)) : field.kind === 'percent' ? `${value}%` : String(value).replaceAll('_', ' ');
    return `<div><dt>${e(label(key))}</dt><dd>${e(display)}</dd></div>`;
  }).join('')}</dl></details>`;
}
export function renderFinanceReview(review: FinanceReview, csrf: string): string {
  return `${header(review.source)}<section class="panel finance-panel"><h2>Review the illustration</h2><p>Calculated ${e(review.calculatedAt)} · assumptions ${e(review.packet.assumptions_as_of)}</p>${result(review.illustration)}${packetDetails(review.packet)}</section><form action="${path(review.source)}/save" method="post">${hidden('_csrf', csrf)}${hidden('review_token', review.reviewToken)}<p>Save these exact reviewed figures as a dated version. Nothing is sent to the client or a lender.</p><button class="button" type="submit">Save reviewed illustration</button> <a class="button secondary" href="${path(review.source)}?prepare=1&model=${review.packet.planning.preset_id}">Start another review</a></form>`;
}
function savedSection(source: FinanceSource, saved: SavedFinance, showResult: boolean): string {
  const stale = saved.opportunityVersion !== source.opportunityVersion || saved.packet.package_version !== PACKAGE_VERSION || saved.packet.model_version !== MODEL_VERSION, inputId = `finance-link-${saved.version}`, statusId = `${inputId}-status`;
  return `<section class="panel finance-panel"><h2>Saved illustration · version ${saved.version}</h2><p>${e(MODEL_NAMES[saved.packet.planning.preset_id])} · calculated ${e(saved.calculatedAt)} · assumptions ${e(saved.packet.assumptions_as_of)}</p>${stale ? '<p class="notice">The opportunity or finance versions changed after this illustration. Review the current position before sharing these figures.</p>' : ''}<p>Opening this saved illustration has not run another calculation.</p>${showResult ? result(saved.illustration) + packetDetails(saved.packet) : `<a class="button secondary" href="${path(source)}?version=${saved.version}">Open version ${saved.version}</a>`}
    ${showResult ? `<p>The client review link contains these numeric figures. Share it only with the intended client. They must sign into their own PP account and review/recalculate before continuing with MH196. Creating the link does not submit an enquiry.</p><button type="button" class="button secondary" data-finance-copy="${inputId}" data-status="${statusId}">Copy client review link</button><textarea id="${inputId}" aria-label="Client review link containing figures" data-packet="${e(JSON.stringify(saved.packet))}" readonly hidden rows="3"></textarea><p id="${statusId}" role="status"></p>` : ''}</section>`;
}
export function renderFinanceSaved(snapshot: FinanceSnapshot, exactVersion?: number): string {
  return `${header(snapshot.source)}<p><a class="button" href="${path(snapshot.source)}?prepare=1">Prepare an illustration</a></p>${snapshot.versions.length ? snapshot.versions.map((item, index) => savedSection(snapshot.source, item, exactVersion !== undefined || index === 0)).join('') : '<section class="panel finance-panel"><h2>No saved illustrations yet</h2><p>Prepare one using the client’s figures, then review and save it here.</p></section>'}${exactVersion ? `<a href="${path(snapshot.source)}">All recent saved versions</a>` : '<p class="muted">Showing the 20 most recent saved versions. Exact version links remain available.</p>'}${scripts()}`;
}
