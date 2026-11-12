/**
 * Website inventory: sitemap(s) plus the home page's same-site links, bounded,
 * through the guarded transport. Records canonical URL, title, headings, text
 * excerpt, dates where the page states them, and the fetch result for every
 * page — including failures, so an incomplete inventory is visible.
 */

import { parseHtmlPage, parseSitemap } from './html.js';
import { SafeFetchError, validatePublicUrl, type FetchTransport } from './safe-fetch.js';
import type { InventoryPage, WebsiteInventory, WebsiteLook } from './types.js';
import { BRAND_PAGE_LIMIT, BRAND_PAGE_TEXT_LIMIT, brandPageRank } from './brand-dna.js';

export interface InventoryOptions {
  readonly maxPages?: number;
  readonly maxSitemaps?: number;
  readonly now: string;
  /**
   * Brand DNA website read: also keep bounded text for the home page and the few pages that describe the
   * business (about, pricing, services…), and read those pages first. Same crawl, same guarded transport.
   */
  readonly captureText?: boolean;
}

const UNUSABLE_LOGO = /\.(svg|ico|gif|webp|avif|bmp)(\?|$)/i;

const NON_EDITORIAL = /\/(login|logout|sign-?in|sign-?up|register|account|app|dashboard|portal|checkout|cart|basket|pay|payment|billing|pricing|terms|privacy|cookies?|dpa|legal|thanks|thank-you|404|admin|api|search|members?|desk|sso)(\/|$|\.html?$)/i;

export function sameSite(url: string, website: string): boolean {
  try {
    const a = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    const b = new URL(website).hostname.replace(/^www\./, '').toLowerCase();
    return a === b;
  } catch {
    return false;
  }
}

function normaliseUrl(url: string): string {
  const u = new URL(url);
  u.hash = '';
  u.search = '';
  if (u.pathname !== '/' && u.pathname.endsWith('/index.html')) u.pathname = u.pathname.slice(0, -'index.html'.length);
  return u.toString();
}

export function isEditorial(url: string, words: number, headingCount: number): boolean {
  let path = '/';
  try { path = new URL(url).pathname; } catch { return false; }
  if (path === '/' || NON_EDITORIAL.test(path)) return false;
  return words >= 250 && headingCount >= 2;
}

export async function buildInventory(brandId: string, website: string, transport: FetchTransport, options: InventoryOptions): Promise<WebsiteInventory> {
  const root = validatePublicUrl(website);
  const origin = `${root.protocol}//${root.host}`;
  const maxPages = Math.min(Math.max(options.maxPages ?? 60, 1), 300);
  const maxSitemaps = Math.min(Math.max(options.maxSitemaps ?? 5, 1), 20);
  const notes: string[] = [];
  const candidates = new Set<string>();
  const sitemapQueue: string[] = [];

  try {
    const robots = await transport.fetch(`${origin}/robots.txt`, { maxBytes: 64 * 1024, accept: 'text/plain' });
    if (robots.status === 200) {
      for (const line of robots.body.toString('utf8').split(/\r?\n/)) {
        const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
        if (m?.[1] && sameSite(m[1], origin)) sitemapQueue.push(m[1]);
      }
    }
  } catch (error) {
    notes.push(`robots.txt could not be read (${(error as Error).message}).`);
  }
  if (sitemapQueue.length === 0) sitemapQueue.push(`${origin}/sitemap.xml`);

  let sitemapUrls = 0;
  let sitemapsRead = 0;
  while (sitemapQueue.length > 0 && sitemapsRead < maxSitemaps) {
    const next = sitemapQueue.shift()!;
    sitemapsRead++;
    try {
      const res = await transport.fetch(next, { maxBytes: 5 * 1024 * 1024, accept: 'application/xml,text/xml' });
      if (res.status !== 200) { notes.push(`Sitemap ${next} returned HTTP ${res.status}.`); continue; }
      const parsed = parseSitemap(res.body.toString('utf8'));
      for (const loc of parsed.locs) {
        if (!sameSite(loc, origin)) continue;
        if (parsed.index) sitemapQueue.push(loc);
        else { candidates.add(normaliseUrl(loc)); sitemapUrls++; }
      }
    } catch (error) {
      notes.push(`Sitemap ${next} could not be read (${(error as Error).message}).`);
    }
  }

  // The home page's links find standalone editorial pages a sitemap omits.
  const pages: InventoryPage[] = [];
  const seen = new Set<string>();
  const home = normaliseUrl(origin + '/');
  let look: WebsiteLook | undefined;
  let withText = 0;
  const fetchPage = async (url: string): Promise<string[]> => {
    if (seen.has(url) || pages.length >= maxPages) return [];
    seen.add(url);
    try {
      const res = await transport.fetch(url);
      if (res.status !== 200) {
        pages.push(emptyPage(url, res.status >= 400 ? 'http_error' : 'error', res.status));
        return [];
      }
      if (!/html/i.test(res.contentType)) { pages.push(emptyPage(url, 'not_html', res.status)); return []; }
      const parsed = parseHtmlPage(res.body.toString('utf8'), res.finalUrl);
      const words = parsed.text.split(/\s+/).filter(Boolean).length;
      if (parsed.robotsNoindex) notes.push(`${url} is marked noindex.`);
      if (url === home) {
        // What the site itself declares. A suggestion for the owner; nothing is applied from here.
        const logoCandidates = [...parsed.icons, ...(parsed.ogImage ? [parsed.ogImage] : [])]
          .filter((u, i, all) => /^https:\/\//i.test(u) && !UNUSABLE_LOGO.test(u) && all.indexOf(u) === i).slice(0, 6);
        if (logoCandidates.length || parsed.themeColour) look = { logoCandidates, themeColour: parsed.themeColour };
      }
      // Words are kept only from a page that is still on the brand's own site after any redirect: a "join" page that
      // forwards to a checkout or sign-in elsewhere is somebody else's words, not the brand's.
      const keepText = options.captureText === true && withText < BRAND_PAGE_LIMIT && brandPageRank(url) !== null && !res.truncated && sameSite(res.finalUrl, origin);
      const text = keepText ? parsed.text.replace(/\s+/g, ' ').trim().slice(0, BRAND_PAGE_TEXT_LIMIT) : '';
      if (text) withText++;
      pages.push({
        ...(text ? { text } : {}),
        url,
        canonical: parsed.canonical,
        title: parsed.title,
        headings: parsed.headings.map((h) => h.text).slice(0, 20),
        excerpt: (parsed.description ?? parsed.text).replace(/\s+/g, ' ').slice(0, 400),
        publishedAt: parsed.publishedAt,
        modifiedAt: parsed.modifiedAt,
        fetchStatus: res.truncated ? 'too_large' : 'ok',
        httpStatus: res.status,
        editorial: !parsed.robotsNoindex && isEditorial(url, words, parsed.headings.length),
      });
      return parsed.links.filter((l) => sameSite(l, origin)).map(normaliseUrl);
    } catch (error) {
      const kind = error instanceof SafeFetchError && error.kind === 'blocked' ? 'blocked' : 'error';
      pages.push(emptyPage(url, kind, null));
      return [];
    }
  };

  const homeLinks = await fetchPage(home);
  for (const link of homeLinks) candidates.add(link);
  // A Brand DNA read reaches the pages that describe the business before the page limit can cut them off.
  const ordered = options.captureText
    ? [...candidates].map((url, index) => ({ url, index, rank: brandPageRank(url) ?? 99 })).sort((a, b) => a.rank - b.rank || a.index - b.index).map((c) => c.url)
    : [...candidates];
  for (const url of ordered) {
    if (pages.length >= maxPages) {
      notes.push(`Inventory stopped at ${maxPages} pages; ${candidates.size - pages.length} further URLs were not read.`);
      break;
    }
    await fetchPage(url);
  }
  return { brandId, website: origin, fetchedAt: options.now, sitemapUrls, pages, notes, ...(look ? { look } : {}) };
}

function emptyPage(url: string, fetchStatus: InventoryPage['fetchStatus'], httpStatus: number | null): InventoryPage {
  return { url, canonical: null, title: null, headings: [], excerpt: '', publishedAt: null, modifiedAt: null, fetchStatus, httpStatus, editorial: false };
}

/** Published URLs that a generated article may link to publicly. */
export function linkableUrls(inventory: WebsiteInventory | null): Set<string> {
  const urls = new Set<string>();
  for (const page of inventory?.pages ?? []) {
    if (page.fetchStatus !== 'ok') continue;
    urls.add(page.url);
    if (page.canonical) urls.add(page.canonical);
  }
  return urls;
}
