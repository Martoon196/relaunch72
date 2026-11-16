/**
 * Review fix 2-C: a damaged or newer-shaped stored keyword list never throws. One shape check (`readKeywordPool`) is
 * used by planning, the fill and the Keywords page: the worker's pass survives and other businesses' tasks run, the
 * page shows the honest empty state, planning goes on as if there were no list, and a fill never overwrites a list a
 * newer release saved. The supplier is a test double.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { readKeywordPool, readablePool } from '../src/seo-blog/keyword-fill.js';
import { emptyKeywordStore } from '../src/seo-blog/keyword-store-shape.js';
import { contentKeywordsPage, keywordsPageState } from '../src/portal/content-area-keywords.js';
import type { KeywordResearchProvider } from '../src/keyword/dataforseo-labs.js';
import type { Brand } from '../src/seo-blog/types.js';
import * as fx from './seo-blog-article-page-fixtures.js';
import { harness, OWNER, seedBrandSite, type Harness } from './seo-blog-fixtures.js';

const now = '2026-11-16T10:00:00.000Z';
const good = (o: Record<string, unknown> = {}) => ({ id: 'id-a', key: 'a b', phrase: 'a b', basis: 'measured', searches: 100, measuredMonth: '2026-10', measuredAt: now, parent: null, parentSearches: null,
  rankingDifficulty: 20, intent: 'informational', sources: ['ideas'], clusterId: 'c1', role: 'pillar', ownPosition: null, opportunity: 0.5, why: 'w', ...o });
const base = (o: Record<string, unknown> = {}) => ({ ...emptyKeywordStore(2826, 'en').pool, builtAt: now, state: 'measured', rows: [good()], calls: [], ...o });

test('2-C: the one shape check reads every damaged or newer shape without throwing', () => {
  const cases: [string, unknown, string, number][] = [
    ['absent', undefined, 'absent', 0],
    ['readable', base(), 'ok', 1],
    ['rows missing', { ...base(), rows: undefined }, 'damaged', 0],
    ['rows not an array', { ...base(), rows: 'x' }, 'damaged', 0],
    ['newer schema with other fields', { schema: 2, locationCode: 2826, languageCode: 'en', entries: {} }, 'newer', 0],
    ['a row with no phrase', base({ rows: [{ id: 'x', measuredAt: now }, good()] }), 'ok', 1],
    ['a row with a garbage date', base({ rows: [good({ measuredAt: 'not a date' })] }), 'ok', 0],
    ['a row with a negative number', base({ rows: [good({ searches: -5 })] }), 'ok', 0],
    ['ledger missing', { ...base(), ledger: undefined }, 'damaged', 0],
    ['a string', 'nonsense', 'damaged', 0],
    ['an array', [], 'damaged', 0],
  ];
  for (const [label, value, status, rows] of cases) {
    const read = readKeywordPool(value);
    assert.equal(read.status, status, label);
    assert.equal(read.pool?.rows.length ?? 0, rows, label);
    assert.doesNotThrow(() => readablePool({ keywordPool: value }), label);
  }
});

class NoCallKeywords implements KeywordResearchProvider {
  readonly mode = 'live' as const;
  calls = 0;
  private no(): never { this.calls++; throw new Error('the supplier must not be called'); }
  async keywordsForSite(): Promise<never> { return this.no(); }
  async rankedKeywords(): Promise<never> { return this.no(); }
  async keywordIdeas(): Promise<never> { return this.no(); }
  async keywordSuggestions(): Promise<never> { return this.no(); }
  async relatedKeywords(): Promise<never> { return this.no(); }
  async competitorDomains(): Promise<never> { return this.no(); }
  async keywordOverview(): Promise<never> { return this.no(); }
  async bulkKeywordDifficulty(): Promise<never> { return this.no(); }
  async searchIntent(): Promise<never> { return this.no(); }
  async readSerpObservations(): Promise<never> { return this.no(); }
}

async function business(h: Harness, e: SeoBlogEngine, name: string): Promise<string> {
  const { brand } = await e.createBrand(OWNER, { commandId: randomUUID(), name, website: 'https://harbour.example' });
  await e.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'Plans', filename: 'plans.txt', bytes: Buffer.from('Harbour Lettings Compliance Plan costs £49 per month.') });
  const b = await e.getBrand(OWNER, brand.id);
  await e.updateSettings(OWNER, brand.id, b.rowVersion, { budgets: { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 } });
  const profile = await e.extractBrandProfile(OWNER, brand.id);
  await e.confirmProfile(OWNER, brand.id, profile.version);
  await e.refreshInventory(brand.id);
  return brand.id;
}
const setPool = (h: Harness, id: string, value: unknown) => { const s = h.store as unknown as { inventories: Map<string, Record<string, unknown>> }; s.inventories.set(id, { ...s.inventories.get(id)!, keywordPool: value }); };

test('2-C: a newer-shaped list on one business: every worker pass completes, both planning tasks run, the page data reads', async () => {
  const h = harness(now);
  const kw = new NoCallKeywords();
  const e = new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, batchLimit: 20, keywordResearch: kw });
  seedBrandSite(h.web, 'https://harbour.example', 'deposits');
  const bad = await business(h, e, 'Damaged List Ltd');
  const ok = await business(h, e, 'Healthy Ltd');
  setPool(h, bad, { schema: 2, locationCode: 2826, languageCode: 'en', builtAt: now, entries: {} });
  await e.requestPlan(OWNER, bad, { commandId: randomUUID() }); h.clock.advance(10);
  await e.requestPlan(OWNER, ok, { commandId: randomUUID() }); h.clock.advance(1000);
  for (let i = 0; i < 4; i++) { await e.tick('w'); h.clock.advance(11 * 60 * 1000); }
  for (const id of [bad, ok]) {
    const job = (await h.store.listJobs(id)).find((j) => j.kind === 'plan')!;
    assert.equal(job.state, 'done', job.error ?? '');
    const plans = await e.listPlans(OWNER, id);
    assert.equal(plans.length, 1);
    assert.match(plans[0]!.plan.generation.promptVersion, /^seo-blog-plan\.md@/, 'with no readable list, the original planning');
  }
  assert.deepEqual(await e.keywordNextUp(OWNER, bad), []);
  assert.equal((await e.keywordListRead(OWNER, bad)).status, 'newer');
  // A fill never overwrites a newer list, and spends nothing.
  await assert.rejects(() => e.requestKeywordFill(OWNER, bad, { commandId: randomUUID() }), /newer version/);
  assert.equal(kw.calls, 0);
  assert.equal((h.store as unknown as { usage: { brandId: string; kind: string; reference: string }[] }).usage.filter((u) => u.brandId === bad && u.kind === 'search_calls' && u.reference.startsWith('keywords:')).length, 0);
  assert.deepEqual(((await h.store.getInventory(bad)) as unknown as { keywordPool: unknown }).keywordPool, { schema: 2, locationCode: 2826, languageCode: 'en', builtAt: now, entries: {} });
});

test('2-C: the Keywords page shows the honest empty state for a damaged or newer list, and never throws on damaged choices', () => {
  const brand: Brand = fx.brand;
  const shell = { ...fx.shell(), preview: { needsYou: 0, path: `/portal/seo-blog/b/${fx.BRAND_ID}/keywords`, keywords: true } } as ReturnType<typeof fx.shell>;
  for (const status of ['damaged', 'newer'] as const) {
    const d = { pool: null, listStatus: status, choices: { dismissed: 'nonsense' } as never, briefs: [], articles: [], jobs: [], nextUp: [], now };
    assert.equal(keywordsPageState(d), 'unreadable');
    const html = contentKeywordsPage(shell, brand, d);
    assert.match(html, /We cannot show your keyword list just now\. Your plans and articles are not affected\./);
    assert.doesNotMatch(html, /searches a month|Estimate/);
  }
});
