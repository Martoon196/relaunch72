/**
 * Keywords, the eighth place in the new look (release 6 with the traffic-estimate addendum). Read only. Shown only
 * when keyword lists are on; otherwise the seven places are exactly as before. Every number comes from the stored
 * list; estimates appear only for a phrase measured itself, always with their condition and the word "Estimate".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { autopilotStatement, contentKeywordsPage, keywordsPageState, keywordState, rollupLine, STATE_LABEL, type KeywordsPageData } from '../src/portal/content-area-keywords.js';
import { contentHomePage } from '../src/portal/content-area-pages.js';
import type { InventoryKeywordPool } from '../src/seo-blog/keyword-fill.js';
import type { StoredKeywordRow } from '../src/seo-blog/keyword-store-shape.js';
import type { ShortlistRow } from '../src/seo-blog/keyword-planning.js';
import { ESTIMATE_DISCLOSURE } from '../src/seo-blog/traffic-estimate.js';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import type { ArticleBrief, Brand, Job } from '../src/seo-blog/types.js';
import type { KeywordResearchProvider } from '../src/keyword/dataforseo-labs.js';
import * as fx from './seo-blog-article-page-fixtures.js';
import { call, identity } from './content-area-shell-fixtures.js';
import { websiteFixture } from './seo-blog-website-fixtures.js';
import { OWNER } from './seo-blog-fixtures.js';

delete process.env.CONTENT_AREA_PREVIEW;

const NOW = '2026-11-16T12:00:00.000Z';
const BANNED = /dataforseo|data for seo|\blabs\b|endpoint|supplier|provider|\bapi\b|\bmodel\b|algorithm|\bai\b|method pack|keyword_ideas|ranked_keywords/i;

export function row(phrase: string, o: Partial<StoredKeywordRow> = {}): StoredKeywordRow {
  return { id: `k-${phrase.replace(/\W+/g, '-')}`, key: phrase, phrase, basis: 'measured', searches: 400, measuredMonth: '2026-10', parent: null, parentSearches: null, rankingDifficulty: 22,
    intent: 'informational', sources: ['ideas'], clusterId: 'c1', role: 'supporting', ownPosition: null, opportunity: 0.5, why: 'We chose this because it is searched about 400 times a month and it is easier to rank for.',
    measuredAt: '2026-11-01T00:00:00.000Z', ...o };
}
const pool = (rows: StoredKeywordRow[], o: Partial<InventoryKeywordPool> = {}): InventoryKeywordPool => ({ schema: 1, locationCode: 2826, languageCode: 'en', builtAt: '2026-11-01T00:00:00.000Z', rows, state: 'measured', ledger: { entries: [], months: {} }, ...o });
const brief = (id: string, phrase: string, status: ArticleBrief['status'], searches: number | null = 400, basis: 'measured' | 'none' = 'measured'): ArticleBrief => ({ ...fx_brief(id), status,
  seo: { schema: 1, primary: { phrase, searches, difficulty: 20, intent: 'informational', basis, parent: null, parentSearches: null, measuredMonth: '2026-10', measuredAt: '2026-11-01T00:00:00.000Z', locationCode: 2826, candidateId: null }, secondary: [], questions: [], cluster: null, why: null } } as ArticleBrief);
function fx_brief(id: string): ArticleBrief {
  return { id, planId: 'p1', brandId: fx.BRAND_ID, role: 'supporting', slug: id, workingTitle: id, targetQuery: `${id}?`, searchIntent: 'learn', relatedQuestions: [], angle: '', outline: [], keyPoints: [], cta: null, internalLinks: [], whyFit: '',
    demand: { kind: 'qualitative', rationale: '' }, sourceIds: [], duplicate: { verdict: 'distinct', score: 0, against: null, againstKind: null, advice: '' }, status: 'planned', suggestedAtUtc: null, articleId: null } as ArticleBrief;
}
const next = (r: StoredKeywordRow): ShortlistRow => ({ id: r.id, phrase: r.phrase, basis: r.basis, searches: r.searches, measuredMonth: r.measuredMonth, measuredAt: r.measuredAt, parent: r.parent, parentSearches: r.parentSearches,
  difficulty: r.rankingDifficulty, intent: r.intent, clusterId: r.clusterId, role: r.role, why: r.why });

const brand = (settings: Partial<Brand['settings']> = {}): Brand => ({ ...fx.brand, settings: { ...fx.brand.settings, ...settings } });
const shell = (keywords = true, page = 'keywords') => ({ ...fx.shell(), preview: { needsYou: 0, path: `/portal/seo-blog/b/${fx.BRAND_ID}/${page}`, ...(keywords ? { keywords: true } : {}) } }) as ReturnType<typeof fx.shell>;
const data = (o: Partial<KeywordsPageData> = {}): KeywordsPageData => ({ pool: null, choices: null, briefs: [], articles: [], jobs: [], nextUp: [], now: NOW, ...o });
const visible = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const main = (html: string) => /<main id="ca-main"[\s\S]*<\/main>/.exec(html)![0];

/** A full fixture covering every state and every kind of number. */
export function fullFixture(): { brand: Brand; data: KeywordsPageData } {
  const rows = [
    row('tenancy deposit protection', { searches: 1300, rankingDifficulty: 25, role: 'pillar', opportunity: 0.9 }),
    row('deposit protection deadline', { searches: 480, rankingDifficulty: 35, opportunity: 0.7 }),
    row('return tenancy deposit', { searches: 390, rankingDifficulty: 18, intent: 'commercial', opportunity: 0.65 }),
    row('deposit dispute evidence', { searches: 170, rankingDifficulty: 55, opportunity: 0.6 }),
    row('landlord deposit scheme comparison', { searches: 90, rankingDifficulty: 28, intent: 'commercial', opportunity: 0.5, why: 'We chose this because it is searched about 90 times a month, it is easier to rank for and it ties in with your Compliance Plan.' }),
    row('prescribed information checklist', { basis: 'parent_phrase', searches: null, parent: 'prescribed information', parentSearches: 720, rankingDifficulty: null, opportunity: 0.4 }),
    row('how long to protect a deposit', { basis: 'observed', searches: null, measuredMonth: null, rankingDifficulty: null, intent: null, opportunity: 0.3 }),
    row('deposit protection certificate', { searches: 40, rankingDifficulty: 12, ownPosition: 6, opportunity: 0.2 }),
    row('cheap deposit insurance', { searches: 8, rankingDifficulty: 10, intent: 'transactional', opportunity: 0.1 }),
  ];
  const briefs = [brief('b-live', 'tenancy deposit protection', 'generated', 1300), brief('b-ready', 'deposit protection deadline', 'generated', 480), brief('b-writing', 'return tenancy deposit', 'generating', 390), brief('b-chosen', 'deposit dispute evidence', 'accepted', 170)];
  const live = fx.article({ id: 'a-live', briefId: 'b-live', delivery: 'published', publishedUrl: 'https://www.martinhowardproperty.example/blog/x' });
  const ready = fx.article({ id: 'a-ready', briefId: 'b-ready' });
  return {
    brand: brand({ ongoingProduction: true, autoAcceptPlans: true }),
    data: data({ pool: pool(rows), briefs, articles: [{ article: live, title: 'Live', status: 'published' }, { article: ready, title: 'Ready', status: 'draft' }],
      choices: { schema: 1, dismissed: [{ key: 'x', phrase: 'deposit loans for students', at: NOW, by: OWNER.userId }], chosen: [], ownerSeeds: [] }, nextUp: [next(rows[4]!)] }),
  };
}

test('the place: an eighth, between Brand DNA and Calendar, under More on a phone; without the switch the seven are unchanged', () => {
  const html = contentKeywordsPage(shell(), fullFixture().brand, fullFixture().data);
  const nav = /<nav class="ca-nav"[\s\S]*?<\/nav>/.exec(html)![0];
  const labels = [...nav.matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Home', 'Brand DNA', 'Keywords', 'Calendar', 'Articles', 'Social', 'Results', 'Settings']);
  assert.match(nav, /<a class="ca-nav-item" href="\/portal\/seo-blog\/b\/[^"]+\/keywords" aria-current="page">/);
  const phone = /<nav class="ca-tabbar"[\s\S]*?<\/nav>/.exec(html)![0];
  assert.deepEqual([...phone.matchAll(/class="ca-tab"[^>]*>(?:<svg[\s\S]*?<\/svg>)<span>([^<]+)<\/span>/g)].map((m) => m[1]), ['Home', 'Calendar', 'Articles', 'Results']);
  assert.match(/<div class="ca-sheet"[\s\S]*?<\/div>/.exec(phone)![0], /\/keywords" aria-current="page">[\s\S]*?<span>Keywords<\/span>/, 'under More on a phone');
  // Switch off: every other page renders byte for byte as before (no Keywords anywhere).
  const d = { articles: [], destinations: [], jobs: [], briefs: [], now: NOW, fill: { readiness: null, usage: null, dna: undefined, plans: [] } };
  const plain = contentHomePage(shell(false, 'overview'), d as never);
  assert.doesNotMatch(plain, /<span>Keywords<\/span>|\/keywords"/);
  const on = contentHomePage(shell(true, 'overview'), d as never);
  assert.equal(plain, on.replace(/<a class="ca-nav-item" href="[^"]+\/keywords">[\s\S]*?<\/a>/, '').replace(/<li><a href="[^"]+\/keywords">[\s\S]*?<\/a><\/li>/, ''), 'the only difference is the Keywords links');
});

test('each row: phrase, monthly searches with the month, easier / medium / harder, what the searcher wants, and the labelled estimate', () => {
  const { brand: b, data: d } = fullFixture();
  const v = visible(main(contentKeywordsPage(shell(), b, d)));
  assert.match(v, /tenancy deposit protection Live About 1,300 searches a month, measured October 2026 How hard Easier What the searcher wants Learn Could bring about 140 to 380 visits a month if it reaches the top three\. Estimate\./);
  assert.match(v, /deposit protection deadline Ready About 480 searches a month, measured October 2026 How hard Medium/);
  assert.match(v, /return tenancy deposit Being written .*?What the searcher wants Compare/);
  assert.match(v, /deposit dispute evidence Chosen .*?How hard Harder/);
  // A wider phrase shows its own number, labelled as the wider phrase, and no estimate.
  assert.match(v, /prescribed information checklist Suggested About 720 searches a month for the wider phrase, measured October 2026 How hard Not rated yet What the searcher wants Learn how long to protect/, 'no estimate for a wider phrase');
  // Observed only: no number, no estimate.
  assert.match(v, /how long to protect a deposit Suggested No search number yet How hard Not rated yet What the searcher wants Not known yet No search number yet, so no estimate\./);
  // Too few searches: fewer than 10.
  assert.match(v, /cheap deposit insurance Suggested About 8 searches a month.*?What the searcher wants Buy Could bring fewer than 10 visits a month if it reaches the top three\. Estimate\./);
  // Every number shown as an estimate carries its condition and the word.
  for (const m of v.matchAll(/Could bring [^.]*\./g)) assert.match(m[0], /if it reaches the top three\./);
  assert.equal((v.match(/Could bring/g) ?? []).length, (v.match(/Estimate\./g) ?? []).length - 1, 'the roll-up line is the one extra Estimate');
});

test('the seven states are derived (only "Not for us" is stored), and in-progress phrases come first', () => {
  const { brand: b, data: d } = fullFixture();
  const states = d.pool!.rows.map((r) => keywordState(r, d));
  assert.deepEqual(new Set(states), new Set(['live', 'ready', 'being_written', 'chosen', 'suggested', 'already_covered']));
  assert.equal(keywordState({ phrase: 'deposit loans for students', ownPosition: null }, d), 'dismissed');
  assert.deepEqual(Object.values(STATE_LABEL), ['Suggested', 'Chosen', 'Being written', 'Ready', 'Live', 'Already covered', 'Not for us']);
  const html = main(contentKeywordsPage(shell(), b, d));
  const order = [...html.matchAll(/<li class="kw-row kw-([a-z_]+)">/g)].map((m) => m[1]);
  assert.deepEqual(order.slice(0, 4), ['live', 'ready', 'being_written', 'chosen']);
  assert.equal(order.at(-1), 'already_covered');
  assert.match(visible(html), /deposit protection certificate Already covered/);
  // Not for us: folded, never in the list.
  assert.match(html, /<details class="kw-fold"><summary>Not for us \(1\)<\/summary><ul class="kw-plain"><li>deposit loans for students<\/li><\/ul><\/details>/);
  assert.ok(!order.includes('dismissed'));
  // Next up, with its one-sentence reason.
  assert.match(visible(html), /landlord deposit scheme comparison Suggested Next up .*?We chose this because/);
});

test('the roll-up line is worded exactly as the addendum: chosen phrases, one per article, with the uncounted ones said', () => {
  const { brand: b, data: d } = fullFixture();
  // Counted: live 1,300 (140 to 380), ready 480 (50 to 140), being written 390 (40 to 120), chosen 170 (15 to 50).
  assert.equal(rollupLine(b, d), 'The 4 keywords you have chosen could bring about 240 to 690 visits a month if they all reach the top three. Estimate.');
  const withNone = { ...d, briefs: [...d.briefs, brief('b-none', 'some unmeasured phrase', 'accepted', null, 'none')] };
  assert.equal(rollupLine(b, withNone), 'The 4 keywords you have chosen could bring about 240 to 690 visits a month if they all reach the top three. Estimate. 1 more has no search number yet and is not counted.');
  // Nothing chosen and autopilot on: what autopilot will write next.
  const lined = { ...d, briefs: [], articles: [] };
  assert.equal(rollupLine(b, lined), 'The 1 keyword autopilot will write next could bring about 5 to 30 visits a month if it reaches the top three. Estimate.');
  assert.equal(rollupLine(brand({ ongoingProduction: false }), lined), null);
  const html = contentKeywordsPage(shell(), b, d);
  assert.match(visible(main(html)), /The 4 keywords you have chosen could bring about 240 to 690 visits a month if they all reach the top three\. Estimate\. How we work this out/);
  assert.ok(visible(html).includes(ESTIMATE_DISCLOSURE));
  assert.match(html, /<details class="kw-how"><summary>How we work this out<\/summary>/);
});

test('the plain autopilot statement, from the business settings', () => {
  assert.equal(autopilotStatement(brand({ ongoingProduction: true, autoAcceptPlans: true }), 7), 'Autopilot is on. If you do not choose, we will write these 7 next to fill Tuesday and Thursday at 9:00.');
  assert.equal(autopilotStatement(brand({ ongoingProduction: true, autoAcceptPlans: false }), 7), 'Autopilot is on. We have lined up these 7. Say yes to start.');
  assert.equal(autopilotStatement(brand({ ongoingProduction: false }), 7), 'Autopilot is off. Nothing is written until you choose.');
  assert.equal(autopilotStatement(brand({ ongoingProduction: true, pauseAll: true }), 7), 'Publishing is paused. Nothing is written or goes out until you switch it back on in Settings.');
  assert.equal(autopilotStatement(brand({ ongoingProduction: true }), 0), 'Autopilot is on. There is nothing lined up from your keywords yet.');
});

test('page states: not built, building, no data, thin, measured; no numbers are ever invented', () => {
  const b = brand();
  const fill = { id: 'j', kind: 'inventory', payload: { keywordFill: { attempts: [] } }, state: 'running' } as unknown as Job;
  assert.equal(keywordsPageState(data()), 'not_built');
  assert.equal(keywordsPageState(data({ jobs: [fill] })), 'building');
  assert.equal(keywordsPageState(data({ pool: pool([], { state: 'no_data' }) })), 'no_data');
  assert.equal(keywordsPageState(data({ pool: pool([row('a b c', { basis: 'observed', searches: null })], { state: 'thin' }) })), 'thin');
  assert.equal(keywordsPageState(data({ pool: pool([row('a b c')]) })), 'measured');
  assert.match(visible(main(contentKeywordsPage(shell(), b, data()))), /We have not built your keyword list yet\./);
  assert.match(visible(main(contentKeywordsPage(shell(), b, data({ jobs: [fill] })))), /We are building your keyword list\./);
  const none = visible(main(contentKeywordsPage(shell(), b, data({ pool: pool([], { state: 'no_data' }) }))));
  assert.match(none, /We could not find search numbers for your niche yet\. That is common for specialist and local businesses\./);
  for (const v of [none, visible(main(contentKeywordsPage(shell(), b, data())))]) assert.doesNotMatch(v, /\d+ (searches|visits)/);
});

test('read only and plain: no form, field, button or main action; no supplier, mechanism or model; no long dashes; hostile phrases escaped', () => {
  const { brand: b, data: d } = fullFixture();
  const hostile = { ...d, pool: pool([...d.pool!.rows, row('<script>alert(1)</script> "x"')]) };
  for (const html of [contentKeywordsPage(shell(), b, d), contentKeywordsPage(shell(), b, hostile), contentKeywordsPage(shell(), b, data())]) {
    const m = main(html);
    assert.doesNotMatch(m, /<form|<input|<button|<select|<textarea|data-primary/);
    assert.doesNotMatch(visible(m), BANNED);
    assert.doesNotMatch(visible(m), /[–—]/);
    assert.doesNotMatch(m, /<script>alert/);
  }
  assert.match(main(contentKeywordsPage(shell(), b, hostile)), /&lt;script&gt;alert\(1\)&lt;\/script&gt; &quot;x&quot;/);
});

class NoCalls implements KeywordResearchProvider {
  readonly mode = 'live' as const;
  private no(): never { throw new Error('a page view must never call the supplier'); }
  keywordIdeas() { return this.no(); } keywordSuggestions() { return this.no(); } relatedKeywords() { return this.no(); } keywordsForSite() { return this.no(); } rankedKeywords() { return this.no(); }
  competitorDomains() { return this.no(); } keywordOverview() { return this.no(); } bulkKeywordDifficulty() { return this.no(); } searchIntent() { return this.no(); } readSerpObservations() { return this.no(); }
}

test('through the real router: Keywords renders in the new look when keyword lists are on; off, the address behaves as before; a view never spends', async () => {
  const f = await websiteFixture();
  const on = new SeoBlogEngine({ ...(f.h.engine as unknown as { deps: ConstructorParameters<typeof SeoBlogEngine>[0] }).deps, keywordResearch: new NoCalls() });
  const service = (engine: SeoBlogEngine) => ({ generation: 'live', research: 'live', social: 'unavailable', engineFor: () => engine, socialCallback: async () => null }) as unknown as Parameters<typeof call>[0];
  const path = `/portal/seo-blog/b/${f.brand.id}/keywords`;
  const look = { headers: { cookie: 'r72_content_look=new' }, input: { contentAreaPreview: 'enabled' } };
  const r = await call(service(on), identity(OWNER.userId), 'GET', path, look);
  assert.equal(r.status, 200);
  assert.match(r.body, /<h1 class="ca-h1">Keywords<\/h1>/);
  assert.match(r.body, /We have not built your keyword list yet\./);
  assert.match(r.body, /<span>Keywords<\/span>/);
  // Home in the same look shows the eighth place too.
  assert.match((await call(service(on), identity(OWNER.userId), 'GET', `/portal/seo-blog/b/${f.brand.id}/overview`, look)).body, /\/keywords"[^>]*>[\s\S]*?<span>Keywords<\/span>/);
  // Switch off: the same address answers exactly as it did before this change, and no page mentions Keywords.
  const before = await call(service(f.h.engine), identity(OWNER.userId), 'GET', path, look);
  assert.notEqual(before.status, 200);
  assert.doesNotMatch((await call(service(f.h.engine), identity(OWNER.userId), 'GET', `/portal/seo-blog/b/${f.brand.id}/overview`, look)).body, /<span>Keywords<\/span>/);
  // The old look never shows it.
  assert.doesNotMatch((await call(service(on), identity(OWNER.userId), 'GET', `/portal/seo-blog/b/${f.brand.id}/overview`, {})).body, /<span>Keywords<\/span>/);
  void randomUUID;
});
