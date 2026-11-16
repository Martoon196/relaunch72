/**
 * Affiliate Studio routes, inside handleSeoBlog under /portal/seo-blog/b/:brand/. Reached only when the new look is
 * on and AFFILIATE_STUDIO is enabled (the service composes affiliateFor); otherwise every path answers as it did
 * before. Every store call uses the session's own business: any other business id answers 404 (review 0158, note 2).
 * POSTs have already passed the router's same-origin and CSRF checks.
 */

import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { SeoBlogError, type Brand } from '../seo-blog/types.js';
import type { Actor, SeoBlogEngine } from '../seo-blog/engine.js';
import { programmeFor, parseRegisteredSite } from '../affiliate/programmes.js';
import { decodeReportBytes } from '../affiliate/amazon-tracking-report.js';
import type { AffiliateResult } from '../affiliate/product-store.js';
import type { AffiliateStores } from './affiliate-service.js';
import { productsPage, reportPage, reportsCard, programmeCard, writePage } from './affiliate-views.js';
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
  const reports = await stores.reports.list(brand.id);
  const d = new Date(now); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return reportsCard(shell, brand, { opened: opened(reports), reports: reports.ok ? reports.value : [], linkedArticles, commandId: randomUUID(), thisMonth: last.toISOString().slice(0, 7) });
}

export async function affiliatePost(ctx: {
  res: ServerResponse; engine: SeoBlogEngine; actor: Actor; brandId: string; rest: string; stores: AffiliateStores;
  f: (name: string) => string | null; all: (name: string) => string[]; file: { filename: string; data: Buffer } | null;
  ok: (location: string, text: string) => void; fail: (location: string, text: string) => void;
}): Promise<void> {
  const { stores, brandId, rest, f } = ctx;
  own(stores, brandId);
  const base = `/portal/seo-blog/b/${brandId}`;
  const commandId = (() => { const c = f('commandId') ?? ''; return new RegExp(`^${UUID}$`, 'i').test(c) ? c.toLowerCase() : randomUUID(); })();
  const tick = (name: string) => f(name) === '1';
  const programme = programmeFor('amazon_uk')!;

  if (rest === 'affiliate/settings') {
    const revision = Number(f('revision') ?? '0');
    const r = await stores.products.saveSettings({ workspaceId: brandId, programme: 'amazon_uk', expectedRevision: Number.isSafeInteger(revision) ? revision : -1,
      trackingId: f('trackingId') ?? '', registeredSite: f('registeredSite') ?? '', siteListedConfirmed: tick('siteListed'), accountConfirmed: tick('accountMine'), commandId });
    if (!r.ok) {
      const tracking = programme.validateTrackingId(f('trackingId') ?? ''), site = parseRegisteredSite(f('registeredSite') ?? '');
      return ctx.fail(`${base}/publishing#affiliate`, !tracking.ok ? tracking.reason : !site.ok ? site.reason : !tick('siteListed') || !tick('accountMine') ? 'Tick both boxes to confirm the website and tracking ID are yours.' : message(r));
    }
    return ctx.ok(`${base}/publishing#affiliate`, 'Your Amazon UK details are saved.');
  }

  if (rest === 'products') {
    const settings = await stores.products.settings(brandId, 'amazon_uk');
    if (!settings.ok) return ctx.fail(`${base}/products`, message(settings));
    const link = f('link') ?? '';
    const parsed = programme.parseLink(link);
    if (!parsed.ok) return ctx.fail(`${base}/products`, parsed.reason);
    if (!settings.value) {
      // The first product also saves the details: the tracking ID typed, or the one the link carries.
      const trackingId = (f('trackingId') ?? '').trim() || parsed.trackingId || '';
      const tracking = programme.validateTrackingId(trackingId), site = parseRegisteredSite(f('registeredSite') ?? '');
      if (!tracking.ok) return ctx.fail(`${base}/products`, tracking.reason);
      if (!site.ok) return ctx.fail(`${base}/products`, site.reason);
      if (!tick('siteListed') || !tick('accountMine')) return ctx.fail(`${base}/products`, 'Tick both boxes to confirm the website and tracking ID are yours.');
      const saved = await stores.products.saveSettings({ workspaceId: brandId, programme: 'amazon_uk', expectedRevision: 0, trackingId: tracking.trackingId, registeredSite: site.site,
        siteListedConfirmed: true, accountConfirmed: true, commandId: randomUUID() });
      if (!saved.ok) return ctx.fail(`${base}/products`, message(saved));
    }
    const name = (f('productName') ?? '').trim() || parsed.suggestedName || '';
    if (!name) return ctx.fail(`${base}/products`, 'Give the product a name.');
    const r = await stores.products.add({ workspaceId: brandId, commandId, details: { programme: 'amazon_uk', link, productName: name, notes: f('notes') || null, ownerUsed: tick('ownerUsed'), infoUrl: f('infoUrl') || null } });
    if (!r.ok) return ctx.fail(`${base}/products`, message(r));
    return ctx.ok(`${base}/products`, r.value.replayed ? 'That product was already added.' : 'Product added.');
  }

  const retire = new RegExp(`^products/(${UUID})/retire$`, 'i').exec(rest);
  if (retire) {
    const r = await stores.products.retire({ workspaceId: brandId, productId: retire[1]!.toLowerCase(), expectedRevision: Number(f('revision') ?? '0'), commandId });
    if (!r.ok) return ctx.fail(`${base}/products`, message(r));
    return ctx.ok(`${base}/products`, 'You have stopped using that product. Articles already written keep their link until you update them.');
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
  const r = await stores.reports.save({ workspaceId: brandId, month: f('month') ?? '', originalText: decoded.text, commandId });
  if (!r.ok) return ctx.fail(`${base}/results`, message(r));
  return ctx.ok(`${base}/results/report/${r.value.id}`, r.value.replayed ? 'That report was already added.' : 'Amazon\'s report is added.');
}
