/**
 * The reviewers' engine fixture for the writer-requirements tests: a business with keyword-first work configured, a
 * measured keyword list, research pages per search, an accepted plan and its briefs. Fakes only: no live calls.
 */
import { randomUUID } from 'node:crypto';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import type { LlmRequest } from '../src/llm/client.js';
import type { SearchHit, SearchProvider } from '../src/seo-blog/research.js';
import type { KeywordResearchProvider, LabsCallResult, LabsMarket } from '../src/keyword/dataforseo-labs.js';
import type { KeywordCandidate } from '../src/keyword/types.js';
import type { ArticleBrief, ArticleVersion, TopicPlan } from '../src/seo-blog/types.js';
import { harness, OWNER, seedBrandSite } from './seo-blog-fixtures.js';

export const PHRASE = 'tenancy deposit protection';
export const DEPOSITS: [string, number][] = [['tenancy deposit protection', 2400], ['deposit protection deadline', 480], ['return tenancy deposit', 390], ['deposit dispute evidence', 170], ['deposit protection schemes', 720], ['prescribed information deposit', 260], ['how long to protect a tenancy deposit', 210], ['how does tenancy deposit protection work', 90]];

export class DepositKeywords implements KeywordResearchProvider {
  readonly mode = 'live' as const;
  constructor(private readonly rows: [string, number][] = DEPOSITS) {}
  private ok(m: LabsMarket, rows: [string, number][]): LabsCallResult<KeywordCandidate> {
    return { endpoint: 'keywords_for_site', status: 'ok', rows: rows.map(([phrase, searches]) => ({ phrase, searches, measuredMonth: '2026-10', dataUpdatedAt: null, rankingDifficulty: 20, adCompetition: null, cpc: null,
      intent: 'informational', secondaryIntents: [], source: 'site_keywords', parent: null, locationCode: m.locationCode, languageCode: m.languageCode })), skippedRows: 0, totalCount: rows.length, providerReportedCost: 0.01, taskId: null, diagnostic: null };
  }
  async keywordsForSite(_d: string, m: LabsMarket) { return this.ok(m, this.rows); }
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
class QuerySearch implements SearchProvider {
  readonly id = 'fake-serp';
  readonly mode = 'live' as const;
  async search(query: string): Promise<SearchHit[]> { const slug = query.replace(/\W+/g, '-'); return [0, 1, 2].map((i) => ({ url: `https://rank${i}.example/${slug}`, title: `${query} ${i}`, snippet: '' })); }
}
const filler = (i: number) => 'Landlords must protect a deposit within 30 days of getting it. '.repeat(20 + i * 10);

export async function setup(opts: { rows?: [string, number][]; headingsFor?: (i: number) => string[] } = {}) {
  const h = harness();
  seedBrandSite(h.web, 'https://harbour.example', 'deposits');
  const rows = opts.rows ?? DEPOSITS;
  const headingsFor = opts.headingsFor ?? ((i: number) => ['How tenancy deposit protection works', i === 0 ? 'Which scheme to choose' : 'Common mistakes']);
  for (const [q] of rows) for (const i of [0, 1, 2]) h.web.set(`https://rank${i}.example/${q.replace(/\W+/g, '-')}`, `<html><head><title>${q}</title></head><body><main><h1>${q}</h1>${headingsFor(i).map((x) => `<h2>${x}</h2><p>${filler(i)}</p>`).join('')}</main></body></html>`);
  const { brand: b0 } = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name: 'Harbour Lettings', website: 'https://harbour.example' });
  await h.engine.uploadKnowledge(OWNER, b0.id, { category: 'product_facts', title: 'Plans', filename: 'plans.txt', bytes: Buffer.from('Harbour Lettings Compliance Plan costs £49 per month.') });
  const b = await h.engine.getBrand(OWNER, b0.id);
  await h.engine.updateSettings(OWNER, b0.id, b.rowVersion, { budgets: { modelTokensPerMonth: 5_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 } });
  const profile = await h.engine.extractBrandProfile(OWNER, b0.id);
  await h.engine.confirmProfile(OWNER, b0.id, profile.version);
  const e = new SeoBlogEngine({ store: h.store, llm: h.llm, search: new QuerySearch(), transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, batchLimit: 20, keywordResearch: new DepositKeywords(rows), internalLog: () => undefined });
  await e.requestKeywordFill(OWNER, b0.id, { commandId: randomUUID() }); await e.tick('w');
  await e.requestPlan(OWNER, b0.id, { commandId: randomUUID() }); await e.tick('w');
  const { plan, briefs } = (await e.listPlans(OWNER, b0.id))[0]! as { plan: TopicPlan; briefs: ArticleBrief[] };
  await e.acceptPlan(OWNER, b0.id, plan.id);
  const pillar = briefs.find((x) => x.seo?.primary.phrase === PHRASE)!;
  const seen: LlmRequest[] = [];
  const inner = h.llm.complete.bind(h.llm);
  h.llm.complete = async (req: LlmRequest) => { if (/ARTICLE|SECTION/.test(req.meta?.stage ?? '')) seen.push(req); return inner(req); };
  return { h, e, brandId: b0.id, plan, briefs, pillar, seen };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

export async function write(s: Setup, briefId: string) {
  await s.e.requestArticles(OWNER, s.brandId, [briefId]);
  for (let i = 0; i < 3; i++) { await s.e.tick('w'); s.h.clock.advance(3600_000); }
  const article = (await s.h.store.listArticles(s.brandId)).find((a) => a.briefId === briefId);
  const version = article?.currentVersionId ? (await s.h.store.getVersion(s.brandId, article.currentVersionId)) as ArticleVersion : null;
  return { article, version };
}
export const briefBlock = (req: LlmRequest) => JSON.parse(/<brief>\n([\s\S]*?)\n<\/brief>/.exec(req.messages[0]!.content)![1]!);
