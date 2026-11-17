/**
 * Review fix F2: every measured number shown for an article or brief names the phrase it belongs to, so the pilot's
 * person can check each match on screen: Topics (old look) and the SEO report on the article page (both looks). The
 * Keywords page already shows every number inside its own phrase's row; Results shows no numbers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { topicsPage } from '../src/portal/seo-blog-view.js';
import { editorPage } from '../src/portal/seo-blog-article-view.js';
import { demandSentence, measuredDemand } from '../src/portal/brief-demand.js';
import { emptyKeywordStore, type StoredKeywordRow } from '../src/seo-blog/keyword-store-shape.js';
import type { KeywordResearchProvider } from '../src/keyword/dataforseo-labs.js';
import type { ArticleBrief } from '../src/seo-blog/types.js';
import { harness, OWNER, seedBrandSite } from './seo-blog-fixtures.js';
import * as fx from './seo-blog-article-page-fixtures.js';
import * as sp from './seo-panel-fixtures.js';

const now = '2026-11-16T10:00:00.000Z';
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const seo = (phrase: string, searches: number, basis: 'measured' | 'none' = 'measured'): ArticleBrief['seo'] => ({ schema: 2,
  primary: { phrase, searches: basis === 'none' ? null : searches, difficulty: 20, intent: 'informational', basis, parent: null, parentSearches: null, measuredMonth: '2026-10', measuredAt: now, locationCode: 2826, candidateId: basis === 'none' ? null : 'id' },
  secondary: [], questions: [], cluster: null, why: null });
const measured = (volume: number) => ({ kind: 'measured' as const, volume, competition: null, provider: 'keyword list', retrievedAt: now });

test('F2: the phrase a number belongs to is the bound phrase, else the brief\'s own search phrase; no number, no line', () => {
  assert.deepEqual(measuredDemand({ demand: measured(6600), seo: seo('landlord tax', 6600), targetQuery: 'What tax do landlords pay?' }), { searches: 6600, phrase: 'landlord tax', retrievedAt: now });
  assert.equal(measuredDemand({ demand: measured(390), seo: undefined, targetQuery: 'return tenancy deposit' })!.phrase, 'return tenancy deposit', 'the older planner measured the brief\'s own phrase');
  assert.equal(measuredDemand({ demand: { kind: 'qualitative', rationale: 'x' }, seo: seo('What tax?', 0, 'none'), targetQuery: 'What tax?' }), null);
  assert.equal(measuredDemand({ demand: { ...measured(5), volume: null }, seo: undefined, targetQuery: 'x' }), null);
  assert.equal(demandSentence({ searches: 6600, phrase: 'landlord tax', retrievedAt: null }), '6,600 searches a month for "landlord tax"');
});

test('F2: the SEO report names the phrase beside its number, escaped', () => {
  const hostile = 'landlord tax <b>"&\'</b>';
  const html = editorPage(fx.shell(), { ...fx.pageData('ready'), articleBrief: sp.brief({ demand: measured(6600), seo: seo(hostile, 6600), targetQuery: 'What tax do landlords pay on rental income?' }), open: ['seo'] });
  assert.match(text(html), /6,600 searches a month in Google for landlord tax /);
  assert.ok(html.includes('for <span class="sp-phrase">landlord tax &lt;b&gt;&quot;&amp;&#39;&lt;/b&gt;</span>'), 'escaped');
  // The older planner: the brief's own phrase.
  const old = editorPage(fx.shell(), { ...fx.pageData('ready'), articleBrief: sp.measured(1300), open: ['seo'] });
  assert.match(text(old), /1,300 searches a month in Google for appraise a property deal/);
});

class NoCallKeywords implements KeywordResearchProvider {
  readonly mode = 'live' as const;
  async keywordsForSite(): Promise<never> { throw new Error('not used'); }
  async rankedKeywords(): Promise<never> { throw new Error('not used'); }
  async keywordIdeas(): Promise<never> { throw new Error('not used'); }
  async keywordSuggestions(): Promise<never> { throw new Error('not used'); }
  async relatedKeywords(): Promise<never> { throw new Error('not used'); }
  async competitorDomains(): Promise<never> { throw new Error('not used'); }
  async keywordOverview(): Promise<never> { throw new Error('not used'); }
  async bulkKeywordDifficulty(): Promise<never> { throw new Error('not used'); }
  async searchIntent(): Promise<never> { throw new Error('not used'); }
  async readSerpObservations(): Promise<never> { throw new Error('not used'); }
}

test('F2: Topics shows each measured number with its phrase (before: "Measured: 2400 searches/month" beside the article\'s question)', async () => {
  const h = harness(now);
  const e = new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, batchLimit: 20, keywordResearch: new NoCallKeywords() });
  seedBrandSite(h.web, 'https://harbour.example', 'deposits');
  const { brand } = await e.createBrand(OWNER, { commandId: randomUUID(), name: 'Harbour Lettings', website: 'https://harbour.example' });
  await e.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'Plans', filename: 'plans.txt', bytes: Buffer.from('Harbour Lettings Compliance Plan costs £49 per month.') });
  await e.updateSettings(OWNER, brand.id, (await e.getBrand(OWNER, brand.id)).rowVersion, { budgets: { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 } });
  const profile = await e.extractBrandProfile(OWNER, brand.id); await e.confirmProfile(OWNER, brand.id, profile.version); await e.refreshInventory(brand.id);
  const rows: StoredKeywordRow[] = [['tenancy deposit protection', 2400], ['deposit protection deadline', 480], ['return tenancy deposit', 390]].map(([p, n], i) => ({ id: `id-${p}`, key: String(p), phrase: String(p),
    basis: 'measured', searches: Number(n), measuredMonth: '2026-10', measuredAt: now, parent: null, parentSearches: null, rankingDifficulty: 20, intent: 'informational', clusterId: 'c1',
    role: i === 0 ? 'pillar' : 'supporting', why: 'w', sources: ['ideas'], ownPosition: null, opportunity: 1 - i * 0.05 }));
  const store = h.store as unknown as { inventories: Map<string, Record<string, unknown>> };
  store.inventories.set(brand.id, { ...store.inventories.get(brand.id)!, keywordPool: { ...emptyKeywordStore(2826, 'en').pool, builtAt: now, state: 'measured', rows, calls: [] } });
  await e.requestPlan(OWNER, brand.id, { commandId: randomUUID() }); h.clock.advance(1000); await e.tick('w');
  const { plan, briefs } = (await e.listPlans(OWNER, brand.id)).at(-1)!;
  const b2 = await e.getBrand(OWNER, brand.id);
  const html = topicsPage({ brand: b2, brands: [b2], tab: 'topics', csrf: 'test' }, { plans: [{ plan, briefs }], readiness: await e.readiness(OWNER, brand.id), jobs: await e.listJobs(OWNER, brand.id), commandId: randomUUID(), estimatePerArticle: 32000 });
  const page = text(html);
  assert.match(page, /Measured: 2,400 searches a month for "tenancy deposit protection" \(measured, Nov 2026\)/);
  assert.match(page, /Measured: 480 searches a month for "deposit protection deadline"/);
  assert.match(page, /Measured: 390 searches a month for "return tenancy deposit"/);
  assert.doesNotMatch(page, /searches\/month/);
  // Unbound briefs show no number at all.
  const unbound = briefs.filter((b) => b.seo?.primary.basis === 'none');
  assert.ok(unbound.length > 0);
  for (const b of unbound) assert.equal(measuredDemand(b), null);
  assert.equal((page.match(/searches a month for/g) ?? []).length, briefs.filter((b) => measuredDemand(b)).length);
});
