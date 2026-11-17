/**
 * Follow-up finding N4 from the delta review of keyword-first planning: a long unbroken word in a phrase, a wider
 * phrase or a dismissed phrase wraps instead of pushing the Keywords page sideways on a phone. With F2 the same holds
 * for a phrase named beside its number on Topics and in the SEO report. Measured in a real browser at 390 px and
 * 1280 px (scrollWidth against clientWidth, every fold open) when Playwright and its browser are installed; where they
 * are not, the browser test reports itself skipped and the CSS check below still runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentKeywordsPage } from '../src/portal/content-area-keywords.js';
import { emptyKeywordStore, type StoredKeywordRow } from '../src/seo-blog/keyword-store-shape.js';
import type { InventoryKeywordPool } from '../src/seo-blog/keyword-fill.js';
import { createRequire } from 'node:module';
import { editorPage } from '../src/portal/seo-blog-article-view.js';
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

type Chromium = { launch(): Promise<{ newPage(o: unknown): Promise<{ setContent(h: string): Promise<void>; evaluate<T>(f: () => T): Promise<T>; close(): Promise<void> }>; close(): Promise<void> }> };
async function browser(): Promise<Awaited<ReturnType<Chromium['launch']>> | string> {
  let chromium: Chromium;
  try { chromium = (createRequire(import.meta.url)('playwright') as { chromium: Chromium }).chromium; } catch { return 'Playwright is not installed here'; }
  try { return await chromium.launch(); } catch (x) { return `no browser could start here (${String((x as Error).message).split('\n')[0]!.slice(0, 120)})`; }
}

test('N4 and F2 in a real browser: no sideways scroll at 390 px or 1280 px on Keywords and the SEO report, folds open', async (t) => {
  const b = await browser();
  if (typeof b === 'string') { t.skip(b); return; }
  try {
    for (const [name, html] of [['keywords', keywordsHtml()], ['seo report', seoReportHtml()]] as const) {
      for (const width of [390, 1280]) {
        const page = await b.newPage({ viewport: { width, height: 900 } });
        await page.setContent(html);
        const m = await page.evaluate(() => { for (const d of document.querySelectorAll('details')) d.open = true; return { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }; });
        t.diagnostic(`${name} at ${width} px: scrollWidth ${m.scroll}, clientWidth ${m.client}`);
        assert.ok(m.scroll <= m.client, `${name} at ${width} px scrolls sideways: ${m.scroll} > ${m.client}`);
        await page.close();
      }
    }
  } finally { await b.close(); }
});

test('N4: every place on the Keywords page that shows a phrase wraps a long unbroken word (the CSS rule, checked without a browser)', async () => {

  const html = keywordsHtml();
  for (const cls of ['kw-row', 'kw-plain']) assert.match(html, new RegExp(`\\.${cls}\\{[^}]*overflow-wrap:anywhere`), cls);
  // The phrase, the wider phrase and the dismissed phrase are each inside one of those.
  assert.match(html, /<li class="kw-row[^"]*">[\s\S]*?prescribed x{80}/);
  assert.match(html, /<p class="kw-searches">[^<]*prescribed information x{80}/);
  assert.match(html, /<ul class="kw-plain"><li>deposit x{80}<\/li>/);
});
