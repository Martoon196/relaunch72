/**
 * Affiliate Studio screens (slice 1, release 2), in the new look only and behind AFFILIATE_STUDIO:
 * Products inside Articles (two pills), Write a product article, the Amazon UK details card in Settings, and what
 * Amazon reported in Results. Plain English; every value escaped and cleaned of invisible or direction-changing
 * characters; no hashes, revisions or technical fields; one main action per page.
 */

import type { AffiliateProduct, ProgrammeSettings } from '../affiliate/product-store.js';
import type { SavedReport, SavedReportSummary } from '../affiliate/report-store.js';
import type { TrackingIdReportRow } from '../affiliate/amazon-tracking-report.js';
import { programmeFor } from '../affiliate/programmes.js';
import { cleanDisplay, cleanNotes, KIND_LABEL, KIND_LIMITS, type ProductArticleKind } from '../affiliate/article.js';
import { csrfField, layout, SEO_BLOG_BASE, type Shell } from './seo-blog-view.js';
import { CONTENT_PAGE_CSS } from './content-area-pages.js';
import { escapeHtml as e } from './ui.js';
import type { Brand } from '../seo-blog/types.js';

const href = (b: Brand, rest: string) => `${SEO_BLOG_BASE}/b/${b.id}/${rest}`;
const t = (s: unknown, max = 200) => e(cleanDisplay(s, max));

/** "Articles | Products" at the top of both lists. */
export function articlePills(b: Brand, current: 'articles' | 'products'): string {
  const pill = (to: 'articles' | 'products', label: string) => `<a class="af-pill" href="${e(href(b, to))}"${current === to ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<nav class="af-pills" aria-label="Articles and products">${pill('articles', 'Articles')}${pill('products', 'Products')}</nav>`;
}

/** 0158 not applied yet: a normal state, said plainly. */
export const NOT_OPENED = 'Products are not switched on for this business yet. Nothing has been set up, and nothing else changes.';

export interface ProductsPageData {
  readonly opened: boolean;
  readonly products: readonly AffiliateProduct[];
  readonly settings: ProgrammeSettings | null;
  /** How many articles use each product (by product id). */
  readonly usedIn: ReadonlyMap<string, number>;
  readonly commandId: string;
}

function settingsFields(prefix = ''): string {
  return `<fieldset class="af-first"><legend>Your Amazon UK details (needed once)</legend>
<p class="af-help">We use these to make every link. Type your tracking ID yourself: we never take it from a link you paste, because a link copied from another page can carry someone else's.</p>
<label for="${prefix}tracking">Your tracking ID <span class="af-opt">(ends in -21)</span></label><input id="${prefix}tracking" name="trackingId" autocomplete="off" maxlength="64" required>
<label for="${prefix}site">Which website will carry these links?</label><input id="${prefix}site" name="registeredSite" placeholder="www.example.co.uk" maxlength="300" required>
<label class="af-tick"><input type="checkbox" name="siteListed" value="1" required> This website is listed in my Amazon UK Associates account.</label>
<label class="af-tick"><input type="checkbox" name="accountMine" value="1" required> This tracking ID is mine, in my own Amazon UK Associates account.</label></fieldset>`;
}

function productForm(b: Brand, shell: Shell, d: ProductsPageData, primary: boolean): string {
  return `<form method="post" action="${e(href(b, 'products'))}" class="af-form">${csrfField(shell.csrf)}<input type="hidden" name="commandId" value="${e(d.commandId)}">
<label for="af-link">The product's page on Amazon UK</label><input id="af-link" name="link" required maxlength="2048" placeholder="https://www.amazon.co.uk/...">
<p class="af-help">Paste the full address from your browser. Short links cannot be used. ${d.settings ? `The link is made with your tracking ID <strong>${e(d.settings.trackingId)}</strong>, whatever the address you paste carries.` : 'The link is made with the tracking ID you type below, whatever the address you paste carries.'}</p>
<label for="af-name">Its name <span class="af-opt">(optional: we suggest one from the address)</span></label><input id="af-name" name="productName" maxlength="200">
<label for="af-notes">What you know about it <span class="af-opt">(optional)</span></label><textarea id="af-notes" name="notes" rows="3" maxlength="2000"></textarea>
<label class="af-tick"><input type="checkbox" name="ownerUsed" value="1"> I have used this myself.</label>
<label for="af-info">The maker's own page about it <span class="af-opt">(optional)</span></label><input id="af-info" name="infoUrl" maxlength="2048" placeholder="https://">
${d.settings ? '' : settingsFields()}
<button type="submit" class="${primary ? 'ca-btn' : 'ca-btn-quiet'}"${primary ? ' data-primary' : ''}>Add a product</button></form>`;
}

export function productsPage(shell: Shell, b: Brand, d: ProductsPageData): string {
  const head = `<header>${articlePills(b, 'products')}<h1 class="ca-h1">Products</h1><p class="ca-lede">Products you recommend, and the articles we write about them. Every link carries the label readers need.</p></header>`;
  if (!d.opened) return page(shell, 'Products', `${head}<p class="af-card">${e(NOT_OPENED)}</p>`);
  const programme = programmeFor('amazon_uk')!;
  const active = d.products.filter((p) => p.status === 'active');
  const card = (p: AffiliateProduct) => {
    const fresh = d.settings ? programme.validateLink(p.affiliateUrl, d.settings.trackingId).ok : false;
    const n = d.usedIn.get(p.productId) ?? 0;
    return `<li class="af-item"><h2 class="af-name">${t(p.productName)}</h2><p class="af-line">Amazon UK · ${n ? `used in ${n} ${n === 1 ? 'article' : 'articles'}` : 'not used in an article yet'}${p.ownerUsed ? ' · you have used it' : ''}</p>
${p.notes ? `<p class="af-notes">${e(cleanNotes(p.notes, 400))}</p>` : ''}${fresh ? '' : '<p class="af-warn">This link was made with a different tracking ID from the one saved now. Add it again from its product page before using it.</p>'}
<form method="post" action="${e(href(b, `products/${p.productId}/retire`))}" class="af-quiet">${csrfField(shell.csrf)}<input type="hidden" name="revision" value="${p.revision}"><button type="submit" class="af-link">Stop using</button></form></li>`;
  };
  const write = active.length ? `<p class="af-main"><a class="ca-btn" data-primary href="${e(href(b, 'products/write'))}">Write an article</a></p>` : '';
  const details = d.settings ? `<p class="af-quiet-line">Links use your tracking ID ${e(d.settings.trackingId)} for ${t(d.settings.registeredSite.replace(/^https:\/\//u, ''))}. <a href="${e(href(b, 'publishing'))}#affiliate">Change these details in Settings</a></p>` : '';
  return page(shell, 'Products', `${head}${write}${details}${active.length ? `<ul class="af-list">${active.map(card).join('')}</ul>` : '<p class="af-card">No products yet. Paste the link of a product you recommend to add the first one.</p>'}
<section class="af-card" aria-labelledby="af-add"><h2 id="af-add" class="ca-h2">Add a product</h2>${productForm(b, shell, d, !active.length)}</section>`);
}

export function writePage(shell: Shell, b: Brand, d: { readonly opened: boolean; readonly products: readonly AffiliateProduct[]; readonly settings: ProgrammeSettings | null; readonly commandId: string }): string {
  const head = `<header>${articlePills(b, 'products')}<h1 class="ca-h1">Write a product article</h1><p class="ca-lede">Choose the products and say what the article is about. It waits for your approval before it goes anywhere.</p></header>`;
  if (!d.opened) return page(shell, 'Write a product article', `${head}<p class="af-card">${e(NOT_OPENED)}</p>`);
  const programme = programmeFor('amazon_uk')!;
  const usable = d.settings ? d.products.filter((p) => p.status === 'active' && programme.validateLink(p.affiliateUrl, d.settings!.trackingId).ok) : [];
  if (!d.settings || !usable.length) return page(shell, 'Write a product article', `${head}<p class="af-card">${d.settings ? 'Add a product first.' : 'Add your Amazon UK details and a product first.'} <a href="${e(href(b, 'products'))}">Open Products</a></p>`);
  const kinds = (Object.keys(KIND_LIMITS) as ProductArticleKind[]).map((k, i) => `<label class="af-tick"><input type="radio" name="kind" value="${k}"${i === 0 ? ' checked' : ''}> ${KIND_LABEL[k]} <span class="af-opt">(${KIND_LIMITS[k][0] === KIND_LIMITS[k][1] ? KIND_LIMITS[k][0] : `${KIND_LIMITS[k][0]} to ${KIND_LIMITS[k][1]}`} products)</span></label>`).join('');
  return page(shell, 'Write a product article', `${head}<form method="post" action="${e(href(b, 'products/write'))}" class="af-form af-card">${csrfField(shell.csrf)}<input type="hidden" name="commandId" value="${e(d.commandId)}">
<fieldset><legend>What kind of article</legend>${kinds}</fieldset>
<fieldset><legend>Which products</legend>${usable.map((p) => `<label class="af-tick"><input type="checkbox" name="product" value="${e(p.productId)}"> ${t(p.productName)}</label>`).join('')}</fieldset>
<label for="af-topic">What is it about?</label><input id="af-topic" name="topic" required maxlength="200" placeholder="For example: what to pack for a power cut">
<button type="submit" class="ca-btn" data-primary>Write it</button><p class="af-help">Uses some of your writing allowance.</p></form>`);
}

/** The Amazon UK details card, in Settings. */
export function programmeCard(shell: Shell, b: Brand, d: { readonly opened: boolean; readonly settings: ProgrammeSettings | null; readonly commandId: string }): string {
  if (!d.opened) return `<section class="af-card" id="affiliate" aria-labelledby="af-prog"><h2 id="af-prog" class="ca-h2">Amazon UK details</h2><p>${e(NOT_OPENED)}</p><style>${AFFILIATE_CSS}</style></section>`;
  const s = d.settings;
  return `<section class="af-card" id="affiliate" aria-labelledby="af-prog"><h2 id="af-prog" class="ca-h2">Amazon UK details</h2>
${s ? `<p>Links use your tracking ID <strong>${e(s.trackingId)}</strong> for <strong>${t(s.registeredSite.replace(/^https:\/\//u, ''))}</strong>.</p><p class="af-help">Changing the tracking ID does not change links already in articles: open each article and update its links.</p>` : '<p>Add these before your first product.</p>'}
<form method="post" action="${e(href(b, 'affiliate/settings'))}" class="af-form">${csrfField(shell.csrf)}<input type="hidden" name="commandId" value="${e(d.commandId)}"><input type="hidden" name="revision" value="${s?.revision ?? 0}">
<label for="afs-tracking">Your tracking ID <span class="af-opt">(ends in -21)</span></label><input id="afs-tracking" name="trackingId" required maxlength="64" value="${e(s?.trackingId ?? '')}">
<label for="afs-site">Which website carries these links?</label><input id="afs-site" name="registeredSite" required maxlength="300" value="${t(s?.registeredSite.replace(/^https:\/\//u, '') ?? '')}">
<label class="af-tick"><input type="checkbox" name="siteListed" value="1" required> This website is listed in my Amazon UK Associates account.</label>
<label class="af-tick"><input type="checkbox" name="accountMine" value="1" required> This tracking ID is mine, in my own Amazon UK Associates account.</label>
<button type="submit" class="ca-btn-quiet">Save these details</button></form><style>${AFFILIATE_CSS}</style></section>`;
}

const pounds = (minor: number | null) => minor === null ? 'Not shown by Amazon' : `${minor < 0 ? '-' : ''}£${(Math.abs(minor) / 100).toFixed(2)}`;
const count = (n: number | null) => n === null ? 'Not shown by Amazon' : n.toLocaleString('en-GB');
export const monthName = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d) : ''; };
const dayName = (iso: string) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d) : ''; };

/**
 * "What Amazon reported", inside Results. Amazon's own figures only; never a rate, never per article. The headline is
 * the saved tracking ID's own row; without it, the figures are said to be for all tracking IDs in the file, and any
 * cell Amazon did not show makes that figure "Not shown by Amazon", never a partial sum (review S4).
 */
export function reportsCard(shell: Shell, b: Brand, d: { readonly opened: boolean; readonly reports: readonly SavedReportSummary[]; readonly linkedArticles: number; readonly commandId: string; readonly thisMonth: string;
  readonly trackingId?: string | null; readonly rows?: ReadonlyMap<string, readonly TrackingIdReportRow[]> }): string {
  if (!d.opened) return `<section class="af-card" aria-labelledby="af-rep"><h2 id="af-rep" class="ca-h2">What Amazon reported</h2><p>${e(NOT_OPENED)}</p><style>${AFFILIATE_CSS}</style></section>`;
  const line = (r: SavedReportSummary) => {
    const s = r.summary;
    const head = `<a href="${e(href(b, `results/report/${r.id}`))}">Amazon's report for ${e(monthName(r.reportStart))}</a>, in the file you uploaded on ${e(dayName(r.createdAt))}`;
    const own = d.trackingId ? d.rows?.get(r.id)?.find((x) => !x.isOther && x.trackingId.toLowerCase() === d.trackingId!.toLowerCase()) : undefined;
    if (own) return `<li>${head}. Your tracking ID <strong>${t(own.trackingId, 120)}</strong>: Clicks counted by Amazon ${e(count(own.clicks))} · Earnings ${e(pounds(own.earningsMinor))}</li>`;
    const missing = d.trackingId && d.rows?.has(r.id) ? ` Your tracking ID <strong>${t(d.trackingId, 120)}</strong> is not in this file.` : '';
    return `<li>${head}.${missing} All tracking IDs in this file: Clicks counted by Amazon ${e(count(s.clicksUnknownRows ? null : s.clicksKnown))} · Earnings ${e(pounds(s.unknownEarningsRows ? null : s.knownEarningsMinor))}</li>`;
  };
  return `<section class="af-card" aria-labelledby="af-rep"><h2 id="af-rep" class="ca-h2">What Amazon reported</h2>
<p>${d.linkedArticles} published ${d.linkedArticles === 1 ? 'article carries' : 'articles carry'} product links.</p>
${d.reports.length ? `<ul class="af-reports">${d.reports.map(line).join('')}</ul>` : '<p class="af-help">No report yet. Download the Tracking ID Summary from your Amazon UK Associates account and add it here.</p>'}
<form method="post" action="${e(href(b, 'results/report'))}" enctype="multipart/form-data" class="af-form">${csrfField(shell.csrf)}<input type="hidden" name="commandId" value="${e(d.commandId)}">
<label for="af-month">Which month it covers</label><input id="af-month" type="month" name="month" required value="${e(d.thisMonth)}">
<label for="af-file">The Tracking ID Summary file</label><input id="af-file" type="file" name="file" required accept=".csv,.tsv,.txt,text/csv,text/plain">
${sameFiguresAsked(shell) ? '<label class="af-tick"><input type="checkbox" name="sameFiguresConfirmed" value="1"> This file is for the month above, even if its figures match another month\'s.</label>\n' : ''}<button type="submit" class="ca-btn-quiet">Add Amazon's report</button></form><style>${AFFILIATE_CSS}</style></section>`;
}

/** The words that begin the "exactly the same figures" refusal; the tick that answers it is shown only after it (review S-e). */
export const SAME_FIGURES_OPENING = 'This file has exactly the same figures as Amazon\'s report for ';
const sameFiguresAsked = (shell: Shell) => Boolean(shell.error?.startsWith(SAME_FIGURES_OPENING));

export function reportPage(shell: Shell, b: Brand, r: SavedReport): string {
  const p = r.payload;
  const rows = p.rows.map((x) => `<tr><th scope="row">${x.isOther ? 'Not tied to a tracking ID' : t(x.trackingId, 120)}</th><td>${e(count(x.clicks))}</td><td>${e(count(x.orderedItems))}</td><td>${e(count(x.shippedItems))}</td><td>${e(pounds(x.earningsMinor))}</td></tr>`).join('');
  return page(shell, 'What Amazon reported', `<header><h1 class="ca-h1">Amazon's report for ${e(monthName(r.reportStart))}</h1><p class="ca-lede">These are Amazon's own figures, from the file you uploaded on ${e(dayName(r.createdAt))}. We do not count clicks or sales ourselves.</p></header>
<div class="af-card af-table"><table><thead><tr><th scope="col">Tracking ID</th><th scope="col">Clicks counted by Amazon</th><th scope="col">Items ordered</th><th scope="col">Items dispatched</th><th scope="col">Earnings</th></tr></thead><tbody>${rows}</tbody></table></div>
<p><a href="${e(href(b, 'results'))}">Back to Results</a></p>`);
}

function page(shell: Shell, title: string, body: string): string {
  return layout(shell, title, `<div class="ca-col">${body}</div>`, `<style>${CONTENT_PAGE_CSS}${AFFILIATE_CSS}</style>`);
}

export const AFFILIATE_CSS = `
.af-pills{display:inline-flex;gap:4px;padding:4px;border-radius:var(--ca-radius-pill);background:var(--ca-surface);box-shadow:var(--ca-shadow);margin-bottom:14px}
.af-pill{display:inline-flex;align-items:center;min-height:40px;padding:0 18px;border-radius:var(--ca-radius-pill);font-weight:700;text-decoration:none;color:var(--ca-ink)!important}
.af-pill[aria-current="page"]{background:var(--ca-ink);color:var(--ca-surface)!important}
.af-card{margin:0;padding:18px 20px;border-radius:var(--ca-radius-l);background:var(--ca-surface);box-shadow:var(--ca-shadow);display:grid;gap:10px;min-width:0}
.af-list{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.af-item{padding:16px 20px;border-radius:var(--ca-radius-l);background:var(--ca-surface);box-shadow:var(--ca-shadow);display:grid;gap:6px;min-width:0}
.af-name{margin:0;font:700 17px/1.3 var(--ca-font-body);overflow-wrap:anywhere}.af-line,.af-help,.af-quiet-line{margin:0;color:var(--ca-muted)}
.af-notes{margin:0;white-space:pre-line;overflow-wrap:anywhere}.af-warn{margin:0;color:var(--ca-bad);font-weight:600}
.af-form{display:grid;gap:8px;max-width:640px}.af-form label{font-weight:600}.af-form input:not([type=checkbox]):not([type=radio]),.af-form textarea{min-height:44px;padding:8px 12px;border:1px solid var(--ca-line);border-radius:10px;font:inherit;width:100%;box-sizing:border-box}
.af-form fieldset{border:1px solid var(--ca-line);border-radius:12px;padding:12px 14px;display:grid;gap:8px;min-width:0}.af-form legend{font-weight:700;padding:0 6px}
.af-tick{display:flex;gap:10px;align-items:flex-start;font-weight:500!important}.af-tick input{width:20px;height:20px;margin-top:2px}.af-opt{font-weight:400;color:var(--ca-muted)}
.af-quiet{margin:0}.af-link{background:none;border:0;padding:6px 0;min-height:24px;color:var(--ca-link);font:600 14px var(--ca-font-body);cursor:pointer;text-decoration:underline}
.af-main{margin:0}.af-reports{margin:0;padding-left:1.2em;display:grid;gap:6px}
.af-table{overflow-x:auto}.af-table table{border-collapse:collapse;width:100%;font-size:15px}.af-table th,.af-table td{padding:8px 10px;border-bottom:1px solid var(--ca-line);text-align:left}
.r72-disclosure{padding:10px 14px;border-left:4px solid var(--ca-amber,#c47f00)}
`;
