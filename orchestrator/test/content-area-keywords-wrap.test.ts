/**
 * Follow-up finding N4 from the delta review of keyword-first planning: a long unbroken word in a phrase, a wider
 * phrase or a dismissed phrase wraps instead of pushing the Keywords page sideways on a phone. With F2 the same holds
 * for a phrase named beside its number on Topics and in the SEO report. Measured in a real browser at 390 px and
 * 1280 px (scrollWidth against clientWidth, every fold open), and since review2 SF1/SF2 on Topics at 390 px too (no
 * word of the Demand cell broken mid-word). The browser is driven by `playwright-core` against a local server only
 * (`browserSession`); where no browser can start, the browser tests report themselves skipped and the CSS checks
 * below still run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentKeywordsPage } from '../src/portal/content-area-keywords.js';
import { emptyKeywordStore, type StoredKeywordRow } from '../src/seo-blog/keyword-store-shape.js';
import type { InventoryKeywordPool } from '../src/seo-blog/keyword-fill.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser, Page } from 'playwright-core';
import { findCreativeChromium } from '../src/creative-studio/renderer.js';
import { CONTENT_AREA_SCRIPT } from '../src/portal/content-area-layout.js';
import { editorPage } from '../src/portal/seo-blog-article-view.js';
import { SEO_BLOG_BASE, topicsPage } from '../src/portal/seo-blog-view.js';
import * as fx from './seo-blog-article-page-fixtures.js';
import * as sp from './seo-panel-fixtures.js';
import { OWNER } from './seo-blog-fixtures.js';

const now = '2026-11-16T10:00:00.000Z';
const row = (phrase: string, searches: number | null, i = 0, extra: Partial<StoredKeywordRow> = {}): StoredKeywordRow => ({ id: `id-${phrase}`, key: phrase, phrase, basis: 'measured', searches, measuredMonth: '2026-10',
  measuredAt: now, parent: null, parentSearches: null, rankingDifficulty: 20, intent: 'informational', clusterId: 'c1', role: i === 0 ? 'pillar' : 'supporting', why: 'w', sources: ['ideas'], ownPosition: null,
  opportunity: 1 - i * 0.05, ...extra });
const pool = (rows: StoredKeywordRow[]): InventoryKeywordPool => ({ ...emptyKeywordStore(2826, 'en').pool, builtAt: now, state: 'measured', rows, calls: [] });

const long = 'x'.repeat(80);
function keywordsHtml(): string {
  const rows = [row(`prescribed ${long}`, 900, 0), row('prescribed information checklist', null, 1, { basis: 'parent_phrase', parent: `prescribed information ${long}`, parentSearches: 720 })];
  return contentKeywordsPage({ ...fx.shell(), preview: { needsYou: 0, path: `/portal/seo-blog/b/${fx.BRAND_ID}/keywords`, keywords: true } } as never, fx.brand,
    { pool: { ...pool(rows), ledger: { entries: [], months: {} } } as never, choices: { schema: 1, dismissed: [{ key: 'x', phrase: `deposit ${long}`, at: now, by: OWNER.userId }], chosen: [], ownerSeeds: [] } as never,
      briefs: [], articles: [], jobs: [], nextUp: [], now });
}
function seoReportHtml(): string {
  const seo = { schema: 2, primary: { phrase: `landlord ${long}`, searches: 6600, difficulty: 20, intent: 'informational', basis: 'measured', parent: null, parentSearches: null, measuredMonth: '2026-10', measuredAt: now, locationCode: 2826, candidateId: 'id' },
    secondary: [], questions: [], cluster: null, why: null };
  return editorPage(fx.shell(), { ...fx.pageData('ready'), articleBrief: sp.brief({ demand: { kind: 'measured', volume: 6600, competition: null, provider: 'keyword list', retrievedAt: now }, seo, targetQuery: `What about ${long}?` } as never), open: ['seo'] });
}

/** Topics with one measured brief whose phrase is `phrase`, in the old look or the new look (content-area preview). */
function topicsHtml(phrase: string, look: 'old' | 'new'): string {
  const seo = { schema: 2, primary: { phrase, searches: 6600, difficulty: 20, intent: 'informational', basis: 'measured', parent: null, parentSearches: null, measuredMonth: '2026-10', measuredAt: now, locationCode: 2826, candidateId: 'id' },
    secondary: [], questions: [], cluster: null, why: null };
  const briefs = [sp.brief({ id: 'b0', status: 'planned', articleId: null, demand: { kind: 'measured', volume: 6600, competition: null, provider: 'keyword list', retrievedAt: now }, seo, targetQuery: 'How often do landlords need a gas safety check?' } as never)];
  const plan = { id: 'p1', brandId: fx.BRAND_ID, status: 'proposed', topic: 'Topic', moneyPage: null, briefIds: ['b0'], sources: [], inputs: { focus: null, excluded: [], sourceArticleUrl: null }, profileVersion: 1, inventoryAt: null,
    generation: { mode: 'simulated', model: 'm', promptVersion: 'p', tokensIn: 0, tokensOut: 0 }, createdAt: now, acceptedAt: null };
  const shell = look === 'old' ? { ...fx.shell(), tab: 'topics' } : { ...fx.shell(), tab: 'topics', preview: { needsYou: 0, path: `/portal/seo-blog/b/${fx.BRAND_ID}/topics`, keywords: true } };
  return topicsPage(shell as never, { plans: [{ plan: plan as never, briefs }], readiness: { canPlan: true, canWrite: true, canPublish: true, missing: [], profile: 'confirmed' } as never, jobs: [],
    commandId: '00000000-0000-4000-8000-000000000000', estimatePerArticle: 32000 });
}
/**
 * In the page: the words of the Demand cell that are split over two lines (each word's client rectangles at different
 * heights), the sideways scroll of the page, and the cell's text.
 */
const MEASURE_DEMAND = `(() => {
  const th = [...document.querySelectorAll('th')].findIndex((x) => x.textContent.trim() === 'Demand');
  const td = document.querySelector('tbody tr td:nth-child(' + (th + 1) + ')');
  const broken = [];
  const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent;
    for (const m of text.matchAll(/\\S+/g)) {
      const range = document.createRange(); range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
      const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
      if (tops.size > 1) broken.push(m[0]);
    }
  }
  return { broken, scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, text: td.textContent.trim() };
})()`;

/**
 * A real browser against a local server only (review2 SF2). Chromium is driven through `playwright-core`, the repo's
 * own dependency (not `playwright`, which the repo does not depend on), using an installed Chromium when one is found
 * (`findCreativeChromium`: the env override, PLAYWRIGHT_BROWSERS_PATH, the container's browsers), else Playwright's own
 * install. Each page is served by a server on 127.0.0.1 together with the new look's script, and every request to any
 * other origin is aborted by a route set before the first navigation. Where no browser can start (CI without one),
 * the reason comes back and the browser tests skip themselves.
 */
interface BrowserSession {
  /** Serve `html` locally and open it at `width` px. */
  open(html: string, width: number): Promise<Page>;
  /** Every request that was aborted for leaving the local server. */
  readonly aborted: readonly string[];
  close(): Promise<void>;
}
async function browserSession(): Promise<BrowserSession | string> {
  let chromium: typeof import('playwright-core').chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { return 'playwright-core is not installed here'; }
  const executablePath = findCreativeChromium() ?? undefined;
  let browser: Browser;
  try { browser = await chromium.launch(executablePath ? { executablePath } : {}); } catch (x) { return `no browser could start here (${String((x as Error).message).split('\n')[0]!.slice(0, 120)})`; }
  const pages = new Map<string, string>();
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const body = path === `${SEO_BLOG_BASE}/content-area.js` ? CONTENT_AREA_SCRIPT : pages.get(path);
    if (body === undefined) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' }).end(body);
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (x) { await browser.close(); return `no local server could start here (${String((x as Error).message).slice(0, 120)})`; }
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const context = await browser.newContext();
  const aborted: string[] = [];
  // Set before any page exists, so it holds from the first navigation: only the local server is ever reached.
  await context.route('**/*', (route) => {
    const target = route.request().url();
    if (target.startsWith(`${origin}/`)) return route.continue();
    aborted.push(target);
    return route.abort('blockedbyclient');
  });
  return {
    aborted,
    async open(html, width) {
      const path = `/page/${pages.size + 1}`;
      pages.set(path, html);
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}${path}`, { waitUntil: 'load' });
      return page;
    },
    async close() {
      await context.close();
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('SF2: the browser session reaches the local server only; a request to any other host is aborted', async (t) => {
  const b = await browserSession();
  if (typeof b === 'string') { t.skip(b); return; }
  try {
    const page = await b.open('<!doctype html><title>x</title><img alt="" src="https://example.com/pixel.png"><script src="https://cdn.example.org/x.js"></script><p id="ok">served</p>', 390);
    assert.equal(await page.evaluate(() => document.getElementById('ok')?.textContent), 'served');
    assert.ok(page.url().startsWith('http://127.0.0.1:'), page.url());
    assert.deepEqual([...b.aborted].sort(), ['https://cdn.example.org/x.js', 'https://example.com/pixel.png']);
    await page.close();
  } finally { await b.close(); }
});

test('N4 and F2 in a real browser: no sideways scroll at 390 px or 1280 px on Keywords and the SEO report, folds open', async (t) => {
  const b = await browserSession();
  if (typeof b === 'string') { t.skip(b); return; }
  try {
    for (const [name, html] of [['keywords', keywordsHtml()], ['seo report', seoReportHtml()]] as const) {
      for (const width of [390, 1280]) {
        const page = await b.open(html, width);
        const m = await page.evaluate(() => { for (const d of document.querySelectorAll('details')) d.open = true; return { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }; });
        t.diagnostic(`${name} at ${width} px: scrollWidth ${m.scroll}, clientWidth ${m.client}`);
        assert.ok(m.scroll <= m.client, `${name} at ${width} px scrolls sideways: ${m.scroll} > ${m.client}`);
        await page.close();
      }
    }
    assert.deepEqual(b.aborted, [], 'the pages need nothing beyond the local server');
  } finally { await b.close(); }
});

test('SF1 in a real browser: on Topics at 390 px no word of the Demand cell breaks mid-word and the page does not scroll sideways', async (t) => {
  const b = await browserSession();
  if (typeof b === 'string') { t.skip(b); return; }
  try {
    for (const look of ['old', 'new'] as const) {
      for (const [name, phrase] of [['ordinary phrase', 'landlord gas safety certificate'], ['300-letter phrase', `landlord ${'y'.repeat(300)}`]] as const) {
        const page = await b.open(topicsHtml(phrase, look), 390);
        if (look === 'new') assert.ok(await page.evaluate(() => [...document.scripts].some((x) => x.src.endsWith('/portal/seo-blog/content-area.js'))), 'the new look loads its script');
        const m = await page.evaluate<{ broken: string[]; scroll: number; client: number; text: string }>(MEASURE_DEMAND);
        // Evidence on request only: KEYWORD_WRAP_SHOTS=<folder> saves each Topics page as a full-page screenshot.
        if (process.env.KEYWORD_WRAP_SHOTS) await page.screenshot({ path: `${process.env.KEYWORD_WRAP_SHOTS}/topics-${look}-${name.split(' ')[0]}-390.png`, fullPage: true });
        t.diagnostic(`Topics, ${look} look, ${name}, 390 px: scrollWidth ${m.scroll}, clientWidth ${m.client}; words broken mid-word: ${m.broken.length ? m.broken.map((w) => w.slice(0, 20)).join(' | ') : 'none'}`);
        assert.match(m.text, new RegExp(`^Measured: 6,600 searches a month for "${phrase}"`), 'the cell names its phrase');
        assert.ok(m.scroll <= m.client, `Topics (${look}, ${name}) at 390 px scrolls sideways: ${m.scroll} > ${m.client}`);
        // Only a word too long for any line may break; every ordinary word wraps whole.
        assert.deepEqual(m.broken.filter((w) => w.length < 40), [], `Topics (${look}, ${name}): ordinary words broken mid-word`);
        await page.close();
      }
    }
    assert.deepEqual(b.aborted, [], 'Topics needs nothing beyond the local server');
  } finally { await b.close(); }
});

test('SF1: the Topics Demand cell keeps a minimum width and still lets a very long word wrap (the CSS rule, checked without a browser)', () => {
  for (const look of ['old', 'new'] as const) {
    const html = topicsHtml('landlord gas safety certificate', look);
    assert.match(html, /<span class="demand-measured" style="display:inline-block;min-width:10em;overflow-wrap:anywhere">Measured: 6,600 searches a month for &quot;landlord gas safety certificate&quot;/);
  }
});

test('N4: every place on the Keywords page that shows a phrase wraps a long unbroken word (the CSS rule, checked without a browser)', async () => {

  const html = keywordsHtml();
  for (const cls of ['kw-row', 'kw-plain']) assert.match(html, new RegExp(`\\.${cls}\\{[^}]*overflow-wrap:anywhere`), cls);
  // The phrase, the wider phrase and the dismissed phrase are each inside one of those.
  assert.match(html, /<li class="kw-row[^"]*">[\s\S]*?prescribed x{80}/);
  assert.match(html, /<p class="kw-searches">[^<]*prescribed information x{80}/);
  assert.match(html, /<ul class="kw-plain"><li>deposit x{80}<\/li>/);
});
