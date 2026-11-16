/**
 * Release 5: keyword-first planning behind SEO_BLOG_KEYWORD_POOL. Research runs on shortlisted measured phrases, the
 * planner is told about them, every new brief is bound to the measured phrase its question answers and carries its
 * secondary phrases and real searched questions, and the question-style target the planning method requires is kept.
 * With the switch off, planning is exactly as before. The supplier is a test double.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { bindByIds, briefSeo, candidateIds, candidatesForPrompt, planningCandidates, planningShortlist, SHORTLIST_SIZE } from '../src/seo-blog/keyword-planning.js';
import type { InventoryKeywordPool } from '../src/seo-blog/keyword-fill.js';
import type { StoredKeywordRow } from '../src/seo-blog/keyword-store-shape.js';
import type { KeywordResearchProvider, LabsCallResult, LabsMarket } from '../src/keyword/dataforseo-labs.js';
import type { KeywordCandidate } from '../src/keyword/types.js';
import type { ArticleBrief, Brand, TopicPlan } from '../src/seo-blog/types.js';
import type { SearchHit, SearchProvider } from '../src/seo-blog/research.js';
import { FakeSearch, harness, OWNER, seedBrandSite, type Harness } from './seo-blog-fixtures.js';

const NOW = '2026-11-02T10:00:00.000Z';
const BUDGETS = { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 };
const BANNED = /dataforseo|data for seo|\blabs\b|endpoint|supplier|provider|\bapi\b|\bmodel\b/i;

function stored(phrase: string, o: Partial<StoredKeywordRow> = {}): StoredKeywordRow {
  return { id: `id-${phrase.replace(/\W+/g, '-')}`, key: phrase, phrase, basis: 'measured', searches: 500, measuredMonth: '2026-10', parent: null, parentSearches: null,
    rankingDifficulty: 20, intent: 'informational', sources: ['ideas'], clusterId: 'c1', role: 'supporting', ownPosition: null, opportunity: 0.5,
    why: 'We chose this because it is searched about 500 times a month.', measuredAt: '2026-11-01T00:00:00.000Z', ...o };
}
const pool = (rows: StoredKeywordRow[]): InventoryKeywordPool => ({ schema: 1, locationCode: 2826, languageCode: 'en', builtAt: NOW, rows, state: 'measured', ledger: { entries: [], months: {} } });

test('the shortlist: the best cluster first (pillar, then its phrases), topped up to seven; no questions, no used, near-used or expired phrases', () => {
  const p = pool([
    stored('tenancy deposit protection', { role: 'pillar', opportunity: 0.9, clusterId: 'deposits' }),
    stored('deposit protection deadline', { opportunity: 0.6, clusterId: 'deposits' }),
    stored('landlord gas safety certificate', { role: 'pillar', opportunity: 0.95, clusterId: 'gas' }),
    stored('how long to protect a deposit', { opportunity: 0.99, clusterId: 'deposits' }),
    stored('old phrase', { opportunity: 0.99, measuredAt: '2026-06-01T00:00:00.000Z' }),
    stored('used phrase', { opportunity: 0.98 }),
    ...Array.from({ length: 8 }, (_, i) => stored(`extra phrase ${i}`, { opportunity: 0.1 + i / 100, clusterId: `x${i}` })),
  ]);
  const s = planningShortlist(p, ['used phrase'], NOW);
  assert.equal(s.length, SHORTLIST_SIZE);
  assert.equal(s[0]!.phrase, 'landlord gas safety certificate', 'the best pillar leads');
  assert.ok(!s.some((r) => /^how /.test(r.phrase)), 'questions are answered inside articles, not planned as targets');
  assert.ok(!s.some((r) => r.phrase === 'old phrase' || r.phrase === 'used phrase'));
  assert.deepEqual(planningShortlist(null, [], NOW), []);
  assert.deepEqual(planningShortlist(pool([]), [], NOW), []);
  // The candidates the planner sees: ids, plain facts from the stored list, naming no mechanism.
  const c = planningCandidates(p, ['used phrase'], NOW);
  const block = candidatesForPrompt(c);
  assert.equal(block[0]!.id, 'K1');
  assert.equal(block[0]!.phrase, 'landlord gas safety certificate');
  assert.equal(block[0]!.can_be_target, true);
  assert.equal(block[0]!.searches_a_month, 500);
  assert.ok(block.slice(SHORTLIST_SIZE).every((x) => x.can_be_target === false), 'further phrases are offered as secondary only');
  assert.doesNotMatch(JSON.stringify(block), BANNED);
});

test('binding is by id only: the chosen candidate is bound, the honest "none" otherwise, and no number is ever made up', () => {
  const p = pool([stored('tenancy deposit protection', { searches: 2400 }), stored('deposit protection deadline', { searches: 480 }), stored('deposit protection schemes', { searches: 720 }),
    stored('how long does tenancy deposit protection last', { searches: 210 }), stored('what is prescribed information', { searches: 140 })]);
  const c = planningCandidates(p, [], NOW);
  const ids = candidateIds(c);
  const idOf = (phrase: string) => [...ids].find(([, v]) => v.row.phrase === phrase)![0];
  const { bound, stripped } = bindByIds([
    { key: 'a', primaryId: idOf('tenancy deposit protection'), secondaryIds: [idOf('deposit protection schemes')] },
    { key: 'b', primaryId: idOf('deposit protection deadline'), secondaryIds: [] },
    // The words match a candidate exactly, but no id was chosen: never bound.
    { key: 'c', primaryId: null, secondaryIds: undefined },
  ], c);
  assert.equal(stripped, 0);
  assert.equal(bound.get('a')!.primary?.phrase, 'tenancy deposit protection');
  assert.equal(bound.get('b')!.primary?.phrase, 'deposit protection deadline');
  assert.equal(bound.get('c')!.primary, null);
  const seo = briefSeo({ targetQuery: 'how does tenancy deposit protection work', binding: bound.get('a')!, pool: p, now: NOW });
  assert.equal(seo.schema, 2);
  assert.equal(seo.primary.phrase, 'tenancy deposit protection');
  assert.equal(seo.primary.searches, 2400);
  assert.equal(seo.primary.basis, 'measured');
  assert.equal(seo.primary.measuredMonth, '2026-10');
  assert.deepEqual(seo.secondary.map((x) => x.phrase), ['deposit protection schemes'], 'secondary phrases come only by id');
  assert.ok(seo.questions.some((q) => q.text === 'how long does tenancy deposit protection last' && q.searches === null), 'questions carry text only');
  const none = briefSeo({ targetQuery: 'deposit protection deadline', binding: bound.get('c')!, pool: p, now: NOW });
  assert.equal(none.primary.basis, 'none');
  assert.equal(none.primary.searches, null, 'no number is ever made up');
  assert.equal(none.cluster, null);
  assert.deepEqual(none.secondary, []);
  assert.deepEqual(none.questions, []);
});

// ─── Through the engine ─────────────────────────────────────────────────────

async function readyBrand(h: Harness): Promise<Brand> {
  seedBrandSite(h.web, 'https://harbour.example', 'deposits');
  const { brand } = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name: 'Harbour Lettings', website: 'https://harbour.example' });
  await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'Plans', filename: 'plans.txt', bytes: Buffer.from('Harbour Lettings Compliance Plan costs £49 per month.') });
  const b = await h.engine.getBrand(OWNER, brand.id);
  await h.engine.updateSettings(OWNER, brand.id, b.rowVersion, { budgets: BUDGETS });
  const profile = await h.engine.extractBrandProfile(OWNER, brand.id);
  await h.engine.confirmProfile(OWNER, brand.id, profile.version);
  return h.engine.getBrand(OWNER, brand.id);
}

const DEPOSITS: [string, number][] = [['tenancy deposit protection', 2400], ['deposit protection deadline', 480], ['return tenancy deposit', 390], ['deposit dispute evidence', 170],
  ['deposit protection schemes', 720], ['prescribed information deposit', 260], ['how long to protect a tenancy deposit', 210]];

class DepositKeywords implements KeywordResearchProvider {
  readonly mode = 'live' as const;
  calls = 0;
  private ok(m: LabsMarket, rows: [string, number][]): LabsCallResult<KeywordCandidate> {
    this.calls++;
    return { endpoint: 'keywords_for_site', status: 'ok', rows: rows.map(([phrase, searches]) => ({ phrase, searches, measuredMonth: '2026-10', dataUpdatedAt: null, rankingDifficulty: 20, adCompetition: null, cpc: null,
      intent: 'informational', secondaryIntents: [], source: 'site_keywords', parent: null, locationCode: m.locationCode, languageCode: m.languageCode })), skippedRows: 0, totalCount: rows.length, providerReportedCost: 0.01, taskId: null, diagnostic: null };
  }
  async keywordsForSite(_d: string, m: LabsMarket) { return this.ok(m, DEPOSITS); }
  async rankedKeywords(_d: string, m: LabsMarket) { return this.ok(m, []); }
  async keywordIdeas(_s: readonly string[], m: LabsMarket) { return this.ok(m, []); }
  async keywordSuggestions(_s: string, m: LabsMarket) { return this.ok(m, []); }
  async relatedKeywords(): Promise<never> { throw new Error('not used'); }
  async competitorDomains(): Promise<never> { throw new Error('not used'); }
  async keywordOverview(): Promise<never> { throw new Error('not used'); }
  async bulkKeywordDifficulty(): Promise<never> { throw new Error('not used'); }
  async searchIntent(): Promise<never> { throw new Error('not used'); }
  async readSerpObservations(): Promise<never> { throw new Error('not used'); }
}

class RecordingSearch implements SearchProvider {
  readonly id = 'fake-serp';
  readonly mode = 'live' as const;
  queries: string[] = [];
  private inner = new FakeSearch();
  async search(query: string, options: { locale: string; limit: number }): Promise<SearchHit[]> { this.queries.push(query); return this.inner.search(); }
}

function engine(h: Harness, search: SearchProvider, keywordResearch: KeywordResearchProvider | null) {
  return new SeoBlogEngine({ store: h.store, llm: h.llm, search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, batchLimit: 20, keywordResearch });
}
async function plans(e: SeoBlogEngine, brandId: string) { return e.listPlans(OWNER, brandId) as Promise<{ plan: TopicPlan; briefs: ArticleBrief[] }[]>; }

test('switch on: research runs on the shortlisted phrases, and every new brief carries its measured phrase, secondary phrases and real questions', async () => {
  const h = harness();
  const brand = await readyBrand(h);
  const search = new RecordingSearch();
  const e = engine(h, search, new DepositKeywords());
  await e.requestKeywordFill(OWNER, brand.id, { commandId: randomUUID() });
  await e.tick('worker-1');
  const shortlist = planningShortlist((await h.store.getInventory(brand.id))!.keywordPool, [], h.clock.now());
  assert.ok(shortlist.length >= 3);
  await e.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  await e.tick('worker-1');
  const job = (await h.store.listJobs(brand.id)).filter((j) => j.kind === 'plan').at(-1)!;
  assert.equal(job.state, 'done', job.error ?? '');
  assert.deepEqual(job.payload.keywordShortlist, shortlist, 'the shortlist is saved on the task');
  assert.deepEqual([...new Set(search.queries)].sort(), shortlist.map((r) => r.phrase).sort(), 'research ran on the measured phrases');
  // The planner was told about them.
  assert.ok(h.llm.calls.includes('SEO_BLOG_PLAN'));
  const { briefs } = (await plans(e, brand.id))[0]!;
  assert.ok(briefs.length > 0);
  for (const b of briefs) {
    assert.ok(b.seo, b.slug);
    assert.ok(/\?|^how |^which /.test(b.targetQuery) || b.targetQuery.split(' ').length >= 2, 'the question-style target is kept as the planner wrote it');
  }
  const pillar = briefs.find((b) => b.slug === 'tenancy-deposit-protection-guide')!;
  assert.equal(pillar.targetQuery, 'how does tenancy deposit protection work', 'the target stays a question');
  assert.equal(pillar.seo!.primary.phrase, 'tenancy deposit protection');
  assert.equal(pillar.seo!.primary.searches, 2400);
  assert.deepEqual(pillar.demand, { kind: 'measured', volume: 2400, competition: null, provider: 'keyword list', retrievedAt: pillar.seo!.primary.measuredAt });
  assert.ok(pillar.seo!.questions.every((q) => q.searches === null));
  const bound = briefs.filter((b) => b.seo!.primary.basis === 'measured');
  assert.ok(bound.length >= 3, `${bound.length} briefs bound to measured phrases`);
  assert.equal(new Set(bound.map((b) => b.seo!.primary.phrase)).size, bound.length, 'one phrase per brief');
  for (const b of briefs.filter((x) => x.seo!.primary.basis === 'none')) { assert.equal(b.seo!.primary.searches, null); assert.equal(b.demand.kind, 'qualitative'); }
  // The next plan does not target the same phrases again.
  const next = planningShortlist((await h.store.getInventory(brand.id))!.keywordPool, briefs.map((b) => b.seo!.primary.phrase), h.clock.now());
  assert.ok(!next.some((r) => bound.some((b) => b.seo!.primary.phrase === r.phrase)));
});

test('switch off: planning is exactly as before, with no shortlist, no brief.seo and the usual research questions', async () => {
  const h = harness();
  const brand = await readyBrand(h);
  const search = new RecordingSearch();
  const e = engine(h, search, null);
  await e.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  await e.tick('worker-1');
  const job = (await h.store.listJobs(brand.id)).filter((j) => j.kind === 'plan').at(-1)!;
  assert.equal(job.state, 'done');
  assert.equal(job.payload.keywordShortlist, undefined);
  const { briefs } = (await plans(e, brand.id))[0]!;
  assert.ok(briefs.every((b) => b.seo === undefined));
  assert.ok(search.queries.length > 0 && !search.queries.includes('tenancy deposit protection'));
});

test('switch on with an empty list: planning falls back to the usual research, and briefs say honestly that no phrase was measured', async () => {
  const h = harness();
  const brand = await readyBrand(h);
  const search = new RecordingSearch();
  const e = engine(h, search, new DepositKeywords());
  await e.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  await e.tick('worker-1');
  const job = (await h.store.listJobs(brand.id)).filter((j) => j.kind === 'plan').at(-1)!;
  assert.equal(job.state, 'done', job.error ?? '');
  assert.deepEqual(job.payload.keywordShortlist, []);
  const { briefs } = (await plans(e, brand.id))[0]!;
  assert.ok(briefs.every((b) => b.seo === undefined || b.seo.primary.basis === 'none'));
});
