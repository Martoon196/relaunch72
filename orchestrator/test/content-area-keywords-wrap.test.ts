/**
 * Follow-up finding N4 from the delta review of keyword-first planning: a long unbroken word in a phrase, a wider
 * phrase or a dismissed phrase wraps instead of pushing the Keywords page sideways on a phone (measured with a
 * browser at 390 px and 1280 px during the fix; this test keeps the rule in place).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentKeywordsPage } from '../src/portal/content-area-keywords.js';
import { emptyKeywordStore, type StoredKeywordRow } from '../src/seo-blog/keyword-store-shape.js';
import type { InventoryKeywordPool } from '../src/seo-blog/keyword-fill.js';
import * as fx from './seo-blog-article-page-fixtures.js';
import { OWNER } from './seo-blog-fixtures.js';

const now = '2026-11-16T10:00:00.000Z';
const row = (phrase: string, searches: number | null, i = 0, extra: Partial<StoredKeywordRow> = {}): StoredKeywordRow => ({ id: `id-${phrase}`, key: phrase, phrase, basis: 'measured', searches, measuredMonth: '2026-10',
  measuredAt: now, parent: null, parentSearches: null, rankingDifficulty: 20, intent: 'informational', clusterId: 'c1', role: i === 0 ? 'pillar' : 'supporting', why: 'w', sources: ['ideas'], ownPosition: null,
  opportunity: 1 - i * 0.05, ...extra });
const pool = (rows: StoredKeywordRow[]): InventoryKeywordPool => ({ ...emptyKeywordStore(2826, 'en').pool, builtAt: now, state: 'measured', rows, calls: [] });

test('N4: every place on the Keywords page that shows a phrase wraps a long unbroken word (no sideways scroll at 390 px)', async () => {
  const long = 'x'.repeat(80);
  const rows = [row(`prescribed ${long}`, 900, 0), row('prescribed information checklist', null, 1, { basis: 'parent_phrase', parent: `prescribed information ${long}`, parentSearches: 720 })];
  const html = contentKeywordsPage({ ...fx.shell(), preview: { needsYou: 0, path: `/portal/seo-blog/b/${fx.BRAND_ID}/keywords`, keywords: true } } as never, fx.brand,
    { pool: { ...pool(rows), ledger: { entries: [], months: {} } } as never, choices: { schema: 1, dismissed: [{ key: 'x', phrase: `deposit ${long}`, at: now, by: OWNER.userId }], chosen: [], ownerSeeds: [] } as never,
      briefs: [], articles: [], jobs: [], nextUp: [], now });
  for (const cls of ['kw-row', 'kw-plain']) assert.match(html, new RegExp(`\\.${cls}\\{[^}]*overflow-wrap:anywhere`), cls);
  // The phrase, the wider phrase and the dismissed phrase are each inside one of those.
  assert.match(html, /<li class="kw-row[^"]*">[\s\S]*?prescribed x{80}/);
  assert.match(html, /<p class="kw-searches">[^<]*prescribed information x{80}/);
  assert.match(html, /<ul class="kw-plain"><li>deposit x{80}<\/li>/);
});
