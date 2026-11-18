/**
 * Affiliate Studio routes, inside handleSeoBlog under /portal/seo-blog/b/:brand/. Reached only when the new look is
 * on and AFFILIATE_STUDIO is enabled (the service composes affiliateFor); otherwise every path answers as it did
 * before. Every store call uses the session's own business: any other business id answers 404 (review 0158, note 2).
 * POSTs have already passed the router's same-origin and CSRF checks.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { SeoBlogError, type Brand } from '../seo-blog/types.js';
import type { Actor, SeoBlogEngine } from '../seo-blog/engine.js';
import { programmeFor, parseRegisteredSite } from '../affiliate/programmes.js';
import { decodeReportBytes, readAmazonTrackingReport, reportTrackingIdProblem } from '../affiliate/amazon-tracking-report.js';
import { cleanDisplay, quotedName, siteHost } from '../affiliate/article.js';
import { monthRange } from '../affiliate/report-store.js';
import type { AffiliateResult } from '../affiliate/product-store.js';
import type { AffiliateStores } from './affiliate-service.js';
import { monthName, productsPage, reportPage, reportsCard, programmeCard, SAME_FIGURES_OPENING, writePage } from './affiliate-views.js';
import type { Shell } from './seo-blog-view.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const GET = new RegExp(`^(?:products|products/write|results/report/${UUID})$`, 'i');
const POST = new RegExp(`^(?:products|products/write|products/${UUID}/retire|affiliate/settings|articles/${UUID}/affiliate-(?:refresh|remove)|results/report)$`, 'i');
export const isAffiliateGet = (rest: string) => GET.test(rest);
export const isAffiliatePost = (rest: string) => POST.test(rest);

/** The session's own business only. */
function own(stores: AffiliateStores, brandId: string): void {
  if (brandId.toLowerCase() !== stores.workspaceId.toLowerCase()) throw new SeoBlogError(404, 'That page was not found.');
}
const opened = (r: AffiliateResult<unknown>) => !(!r.ok && r.kind === 'not_opened_yet');
const message = (r: AffiliateResult<unknown>) => (r.ok ? '' : r.kind === 'not_opened_yet' ? 'Products are not switched on for this business yet.' : r.message);
/** A version-4-shaped id derived from text: the same form sent twice makes the same id (review S8). */
function idFrom(text: string): string {
  const h = createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** A tracking ID inside a sentence: quoted, so the owner-words pass lifts it out untouched. */
const idWords = (id: string) => quotedName(id);

/** How many product articles use each product (from the briefs). */
async function usedIn(engine: SeoBlogEngine, actor: Actor, brandId: string): Promise<Map<string, number>> {
  const plans = await engine.listPlans(actor, brandId).catch(() => []);
  const out = new Map<string, number>();
  for (const b of plans.flatMap((p) => p.briefs)) if (b.products && !['omitted', 'skipped'].includes(b.status)) for (const p of b.products.products) out.set(p.productId, (out.get(p.productId) ?? 0) + 1);
  return out;
}

export async function affiliateGet(ctx: { engine: SeoBlogEngine; actor: Actor; brand: Brand; rest: string; stores: AffiliateStores; shell: (place: 'articles' | 'results') => Shell }): Promise<string> {
  const { stores, brand, rest } = ctx;
  own(stores, brand.id);
  if (rest === 'products' || rest === 'products/write') {
    const [list, settings] = await Promise.all([stores.products.list(brand.id), stores.products.settings(brand.id, 'amazon_uk')]);
    const isOpen = opened(list) && opened(settings);
    const products = list.ok ? list.value : [];
    const saved = settings.ok ? settings.value : null;
    if (rest === 'products/write') return writePage(ctx.shell('articles'), brand, { opened: isOpen, products, settings: saved, commandId: randomUUID() });
    return productsPage(ctx.shell('articles'), brand, { opened: isOpen, products, settings: saved, usedIn: await usedIn(ctx.engine, ctx.actor, brand.id), commandId: randomUUID() });
  }
  const id = rest.split('/')[2]!.toLowerCase();
  const report = await stores.reports.get(brand.id, id);
  if (!report.ok || !report.value) throw new SeoBlogError(404, 'That report was not found.');
  return reportPage(ctx.shell('results'), brand, report.value);
}

/** The Amazon UK details card for Settings. */
export async function affiliateSettingsCard(stores: AffiliateStores, shell: Shell, brand: Brand): Promise<string> {
  own(stores, brand.id);
  const settings = await stores.products.settings(brand.id, 'amazon_uk');
  return programmeCard(shell, brand, { opened: opened(settings), settings: settings.ok ? settings.value : null, commandId: randomUUID() });
}

/** The "What Amazon reported" card for Results. */
export async function affiliateReportsCard(stores: AffiliateStores, shell: Shell, brand: Brand, linkedArticles: number, now: string): Promise<string> {
  own(stores, brand.id);
  const [reports, settings] = await Promise.all([stores.reports.list(brand.id), stores.products.settings(brand.id, 'amazon_uk')]);
  const d = new Date(now); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  const list = reports.ok ? reports.value : [];
  // The saved tracking ID's own row is the headline (review S4): read the rows of the most recent reports.
  const recent = [...list].sort((a, b) => b.reportStart.localeCompare(a.reportStart) || b.createdAt.localeCompare(a.createdAt)).slice(0, RECENT_REPORTS);
  const rows = new Map<string, readonly import('../affiliate/amazon-tracking-report.js').TrackingIdReportRow[]>();
  for (const r of await Promise.all(recent.map((x) => stores.reports.get(brand.id, x.id).catch(() => null)))) if (r?.ok && r.value) rows.set(r.value.id, r.value.payload.rows);
  return reportsCard(shell, brand, { opened: opened(reports), reports: list, linkedArticles, commandId: randomUUID(), thisMonth: last.toISOString().slice(0, 7),
    trackingId: settings.ok ? settings.value?.trackingId ?? null : null, rows });
}
const RECENT_REPORTS = 12;

export async function affiliatePost(ctx: {
  res: ServerResponse; engine: SeoBlogEngine; actor: Actor; brandId: string; rest: string; stores: AffiliateStores;
  f: (name: string) => string | null; all: (name: string) => string[]; file: { filename: string; data: Buffer } | null;
  ok: (location: string, text: string) => void; fail: (location: string, text: string) => void;
  /** The current time (tests); defaults to the clock. */
  now?: () => string;
}): Promise<void> {
  const { stores, brandId, rest, f } = ctx;
  own(stores, brandId);
  const base = `/portal/seo-blog/b/${brandId}`;
  const commandId = (() => { const c = f('commandId') ?? ''; return new RegExp(`^${UUID}$`, 'i').test(c) ? c.toLowerCase() : randomUUID(); })();
  const tick = (name: string) => f(name) === '1';
  const programme = programmeFor('amazon_uk')!;

  if (rest === 'affiliate/settings') {
    const revision = Number(f('revision') ?? '0');
    const tracking = programme.validateTrackingId(f('trackingId') ?? ''), site = parseRegisteredSite(f('registeredSite') ?? '');
    const typed = tracking.ok && site.ok && tick('siteListed') && tick('accountMine') ? { trackingId: tracking.trackingId, registeredSite: site.site } : null;
    const before = await stores.products.settings(brandId, 'amazon_uk');
    // Approvals are taken back BEFORE the new details are saved (review S-a): if anything fails after this, nothing is
    // left approved with a link made for the old tracking ID or website. Only articles whose links differ are touched.
    let cleared = typed && before.ok && before.value ? await ctx.engine.affiliateDetailsChanged(ctx.actor, brandId, { settings: typed }) : 0;
    const r = await stores.products.saveSettings({ workspaceId: brandId, programme: 'amazon_uk', expectedRevision: Number.isSafeInteger(revision) ? revision : -1,
      trackingId: f('trackingId') ?? '', registeredSite: f('registeredSite') ?? '', siteListedConfirmed: tick('siteListed'), accountConfirmed: tick('accountMine'), commandId });
    const after = await stores.products.settings(brandId, 'amazon_uk');
    const saved = after.ok ? after.value : null;
    // A stale or replayed form whose details are already the saved ones is the same save arriving again: it counts as
    // saved, never as "changed somewhere else" (review S-a).
    const alreadySaved = Boolean(typed && saved && saved.trackingId === typed.trackingId && siteHost(saved.registeredSite) === siteHost(typed.registeredSite));
    if (!r.ok && !alreadySaved) {
      return ctx.fail(`${base}/publishing#affiliate`, (!tracking.ok ? tracking.reason : !site.ok ? site.reason : !tick('siteListed') || !tick('accountMine') ? 'Tick both boxes to confirm the website and tracking ID are yours.' : message(r))
        + (cleared ? ` ${clearedWords(cleared)}` : ''));
    }
    // Once more against what is saved now: an article approved meanwhile, or a save that arrived twice (review S-a).
    if (saved) cleared += await ctx.engine.affiliateDetailsChanged(ctx.actor, brandId, { settings: saved });
    return ctx.ok(`${base}/publishing#affiliate`, `Your Amazon UK details are saved. Links use your tracking ID ${idWords(saved?.trackingId ?? (f('trackingId') ?? '').trim())}.${cleared ? ` ${clearedWords(cleared)}` : ''}`);
  }

  if (rest === 'products') {
    const settings = await stores.products.settings(brandId, 'amazon_uk');
    if (!settings.ok) return ctx.fail(`${base}/products`, message(settings));
    const parsed = programme.parseLink(f('link') ?? '');
    if (!parsed.ok) return ctx.fail(`${base}/products`, parsed.reason);
    let trackingId = settings.value?.trackingId ?? null;
    const firstTime = !settings.value;
    if (!settings.value) {
      // The first product also saves the details. The tracking ID is only ever the one the owner typed: a tracking ID
      // found in a pasted link is never adopted, because a link copied from someone else's page carries theirs (review M3).
      const typed = (f('trackingId') ?? '').trim();
      if (!typed) return ctx.fail(`${base}/products`, TYPE_TRACKING_ID);
      const tracking = programme.validateTrackingId(typed), site = parseRegisteredSite(f('registeredSite') ?? '');
      if (!tracking.ok) return ctx.fail(`${base}/products`, tracking.reason);
      if (!site.ok) return ctx.fail(`${base}/products`, site.reason);
      if (!tick('siteListed') || !tick('accountMine')) return ctx.fail(`${base}/products`, 'Tick both boxes to confirm the website and tracking ID are yours.');
      const saved = await stores.products.saveSettings({ workspaceId: brandId, programme: 'amazon_uk', expectedRevision: 0, trackingId: tracking.trackingId, registeredSite: site.site,
        siteListedConfirmed: true, accountConfirmed: true, commandId: idFrom(`affiliate-settings:${brandId}:${commandId}`) });
      if (!saved.ok) return ctx.fail(`${base}/products`, message(saved));
      trackingId = tracking.trackingId;
    }
    const name = (f('productName') ?? '').trim() || parsed.suggestedName || '';
    // A name of invisible characters only would show as nothing and could never be a heading (review S9).
    if (!cleanDisplay(name)) return ctx.fail(`${base}/products`, 'Give the product a name.');
    // The same form sent twice makes the same product (review S8); the same product is kept once (review N4).
    const productId = idFrom(`affiliate-product:${brandId}:${commandId}`);
    const list = await stores.products.list(brandId);
    const same = list.ok ? list.value.find((p) => p.status === 'active' && p.merchantProductId.toUpperCase() === parsed.productCode) : undefined;
    if (same?.productId === productId) return ctx.ok(`${base}/products`, 'That product was already added.');
    if (same) return ctx.fail(`${base}/products`, `You already have this product, as ${quotedName(same.productName)}. Each product is added once.`);
    // The link is always rebuilt from the product page with the saved tracking ID; a pasted tracking ID is dropped.
    const r = await stores.products.add({ workspaceId: brandId, commandId, productId, details: { programme: 'amazon_uk', link: parsed.productUrl, productName: name, notes: f('notes') || null, ownerUsed: tick('ownerUsed'), infoUrl: f('infoUrl') || null } });
    if (!r.ok) return ctx.fail(`${base}/products`, message(r));
    if (r.value.replayed) return ctx.ok(`${base}/products`, 'That product was already added.');
    const other = parsed.trackingId !== null && parsed.trackingId !== trackingId
      ? ` The link you pasted carried a different tracking ID, ${idWords(parsed.trackingId)}, so we used yours instead.` : '';
    return ctx.ok(`${base}/products`, firstTime
      ? `Product added. Your tracking ID ${idWords(trackingId!)} is saved, and every link uses it.${other}`
      : `Product added. Its link uses your tracking ID ${idWords(trackingId!)}.${other}`);
  }

  const retire = new RegExp(`^products/(${UUID})/retire$`, 'i').exec(rest);
  if (retire) {
    const productId = retire[1]!.toLowerCase();
    // Articles linking to it lose their approval until their links are updated (review S1), BEFORE it is retired, so a
    // lost second step never leaves one approved (review S-a). Only this business's own articles are read.
    let cleared = await ctx.engine.affiliateDetailsChanged(ctx.actor, brandId, { productId });
    const r = await stores.products.retire({ workspaceId: brandId, productId, expectedRevision: Number(f('revision') ?? '0'), commandId });
    if (!r.ok) {
      // A stale or replayed form for a product that is retired by now is the same press arriving again (review S-a).
      const now = await stores.products.get(brandId, productId);
      if (!(now.ok && now.value?.status === 'retired')) return ctx.fail(`${base}/products`, message(r) + (cleared ? ` ${clearedWords(cleared)}` : ''));
    }
    cleared += await ctx.engine.affiliateDetailsChanged(ctx.actor, brandId, { productId });
    return ctx.ok(`${base}/products`, `You have stopped using that product. Articles already written keep their link until you update them.${cleared ? ` ${clearedWords(cleared)}` : ''}`);
  }

  if (rest === 'products/write') {
    try {
      await ctx.engine.requestProductArticle(ctx.actor, brandId, { commandId, kind: f('kind') ?? '', topic: f('topic') ?? '', productIds: ctx.all('product') });
    } catch (error) {
      if (error instanceof SeoBlogError && error.status < 500) return ctx.fail(`${base}/products/write`, error.message);
      throw error;
    }
    return ctx.ok(`${base}/articles`, 'We are writing it now. It will wait for your approval before it goes anywhere.');
  }

  const article = new RegExp(`^articles/(${UUID})/affiliate-(refresh|remove)$`, 'i').exec(rest);
  if (article) {
    const articleId = article[1]!.toLowerCase(), versionId = f('versionId') ?? '';
    try {
      if (article[2] === 'refresh') await ctx.engine.refreshAffiliateLinks(ctx.actor, brandId, articleId, versionId);
      else await ctx.engine.removeAffiliateLink(ctx.actor, brandId, articleId, versionId, (f('productId') ?? '').toLowerCase());
    } catch (error) {
      if (error instanceof SeoBlogError && error.status < 500) return ctx.fail(`${base}/articles/${articleId}`, error.message);
      throw error;
    }
    return ctx.ok(`${base}/articles/${articleId}`, article[2] === 'refresh' ? 'The product links are up to date. Approve this version when you are ready.' : 'That link was removed. Approve this version when you are ready.');
  }

  // results/report: the file is read here (size, letters, layout) before anything is stored.
  if (!ctx.file || !ctx.file.data.length) return ctx.fail(`${base}/results`, 'Choose the report file you downloaded from Amazon UK.');
  const decoded = decodeReportBytes(new Uint8Array(ctx.file.data));
  if (!decoded.ok) return ctx.fail(`${base}/results`, decoded.reason);
  const month = f('month') ?? '';
  // A month that has not started yet cannot have a report (review N5).
  const current = (ctx.now?.() ?? new Date().toISOString()).slice(0, 7);
  if (monthRange(month) && month > current) return ctx.fail(`${base}/results`, 'Choose this month or an earlier one. Amazon only reports months that have started.');
  const reading = readAmazonTrackingReport(decoded.text);
  if (reading.ok) {
    // Only Amazon UK's own tracking IDs (review N6).
    const idProblem = reportTrackingIdProblem(reading.report);
    if (idProblem) return ctx.fail(`${base}/results`, idProblem);
    // The same figures as another month's report: kept only when the owner says this file really is for this month (review N5).
    const listed = await stores.reports.list(brandId);
    const twin = listed.ok && monthRange(month) ? listed.value.find((x) => x.reportStart.slice(0, 7) !== month && sameFigures(x.summary, x.rowCount, reading.report)) : undefined;
    if (twin && !tick('sameFiguresConfirmed')) return ctx.fail(`${base}/results`, `${SAME_FIGURES_OPENING}${monthName(twin.reportStart)}. If it really is the report for ${monthName(`${month}-01`)}, tick the box that says so and add it again.`);
  }
  const r = await stores.reports.save({ workspaceId: brandId, month, originalText: decoded.text, commandId });
  if (!r.ok) return ctx.fail(`${base}/results`, message(r));
  return ctx.ok(`${base}/results/report/${r.value.id}`, r.value.replayed ? 'That report was already added.' : 'Amazon\'s report is added.');
}

const TYPE_TRACKING_ID = 'Type your Amazon UK tracking ID (it ends in -21). We never take it from a link you paste, because a link copied from another page can carry someone else\'s.';
const clearedWords = (n: number) => n === 1 ? '1 approved article with product links now waits for your approval again.' : `${n} approved articles with product links now wait for your approval again.`;

/** Two reports with the same figures (most likely the same file uploaded for two months). */
function sameFigures(summary: { readonly knownEarningsMinor: number; readonly clicksKnown: number; readonly unknownEarningsRows: number; readonly clicksUnknownRows: number; readonly unallocatedEarningsMinor: number } | null | undefined, rowCount: number,
  report: { readonly rows: readonly unknown[]; readonly knownEarningsMinor: number; readonly clicksKnown: number; readonly unknownEarningsRows: number; readonly clicksUnknownRows: number; readonly unallocatedEarningsMinor: number }): boolean {
  return Boolean(summary) && rowCount === report.rows.length && summary!.knownEarningsMinor === report.knownEarningsMinor && summary!.clicksKnown === report.clicksKnown
    && summary!.unknownEarningsRows === report.unknownEarningsRows && summary!.clicksUnknownRows === report.clicksUnknownRows && summary!.unallocatedEarningsMinor === report.unallocatedEarningsMinor;
}
