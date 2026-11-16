/**
 * Keywords page, review fixes 6-A, 6-B and 6-C, and lighter rows on a phone. Read only; every number from the
 * stored list; nothing unbound is promised.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentKeywordsPage, ESTIMATE_EXPLAINED, keywordsPageState, keywordState, rollupLine, type KeywordsPageData } from '../src/portal/content-area-keywords.js';
import type { InventoryKeywordPool } from '../src/seo-blog/keyword-fill.js';
import type { StoredKeywordRow } from '../src/seo-blog/keyword-store-shape.js';
import type { ShortlistRow } from '../src/seo-blog/keyword-planning.js';
import type { ArticleBrief, Brand, Job } from '../src/seo-blog/types.js';
import * as fx from './seo-blog-article-page-fixtures.js';

const NOW = '2026-11-16T12:00:00.000Z';
const row = (phrase: string, o: Partial<StoredKeywordRow> = {}): StoredKeywordRow => ({ id: `k-${phrase.replace(/\W+/g, '-')}`, key: phrase, phrase, basis: 'measured', searches: 400, measuredMonth: '2026-10', parent: null, parentSearches: null,
  rankingDifficulty: 22, intent: 'informational', sources: ['ideas'], clusterId: 'c1', role: 'supporting', ownPosition: null, opportunity: 0.5, why: 'We chose this because it is searched about 400 times a month.', measuredAt: '2026-11-01T00:00:00.000Z', ...o });
const pool = (rows: StoredKeywordRow[], o: Partial<InventoryKeywordPool> = {}): InventoryKeywordPool => ({ schema: 1, locationCode: 2826, languageCode: 'en', builtAt: '2026-11-01T00:00:00.000Z', rows, state: 'measured', ledger: { entries: [], months: {} }, ...o });
const brief = (id: string, phrase: string, status: ArticleBrief['status'], o: Partial<NonNullable<ArticleBrief['seo']>['primary']> = {}): ArticleBrief => ({
  id, planId: 'p1', brandId: fx.BRAND_ID, role: 'supporting', slug: id, workingTitle: id, targetQuery: `${id}?`, searchIntent: 'learn', relatedQuestions: [], angle: '', outline: [], keyPoints: [], cta: null, internalLinks: [], whyFit: '',
  demand: { kind: 'qualitative', rationale: '' }, sourceIds: [], duplicate: { verdict: 'distinct', score: 0, against: null, againstKind: null, advice: '' }, status, suggestedAtUtc: null, articleId: null,
  seo: { schema: 2, primary: { phrase, searches: 400, difficulty: 20, intent: 'informational', basis: 'measured', parent: null, parentSearches: null, measuredMonth: '2026-10', measuredAt: '2026-11-01T00:00:00.000Z', locationCode: 2826, candidateId: `k-${phrase}`, ...o }, secondary: [], questions: [], cluster: null, why: null },
} as ArticleBrief);
const next = (r: StoredKeywordRow): ShortlistRow => ({ id: r.id, phrase: r.phrase, basis: r.basis, searches: r.searches, measuredMonth: r.measuredMonth, measuredAt: r.measuredAt, parent: r.parent, parentSearches: r.parentSearches,
  difficulty: r.rankingDifficulty, intent: r.intent, clusterId: r.clusterId, role: r.role, why: r.why });
const brand = (settings: Partial<Brand['settings']> = {}, locale = 'en-GB'): Brand => ({ ...fx.brand, locale, settings: { ...fx.brand.settings, ...settings } });
const shell = () => ({ ...fx.shell(), preview: { needsYou: 0, path: `/portal/seo-blog/b/${fx.BRAND_ID}/keywords`, keywords: true } }) as ReturnType<typeof fx.shell>;
const data = (o: Partial<KeywordsPageData> = {}): KeywordsPageData => ({ pool: null, choices: null, briefs: [], articles: [], jobs: [], nextUp: [], now: NOW, ...o });
const visible = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const main = (html: string) => /<main id="ca-main"[\s\S]*<\/main>/.exec(html)![0];

test('6-A: phrases the planner is not bound to are never promised: no "Next up", no "we will write these", no autopilot roll-up', () => {
  const rows = [row('tenancy deposit protection', { role: 'pillar' }), row('deposit protection deadline'), row('return tenancy deposit')];
  for (const autoAcceptPlans of [true, false]) {
    const b = brand({ ongoingProduction: true, autoAcceptPlans });
    const d = data({ pool: pool(rows), nextUp: rows.map(next) });
    const v = visible(main(contentKeywordsPage(shell(), b, d)));
    assert.doesNotMatch(v, /Next up|write these|will write|lined up|Say yes to start|autopilot will write next/i);
    assert.equal(rollupLine(b, d), null);
  }
  // Bound by id and accepted: Chosen, and counted.
  const b = brand({ ongoingProduction: true, autoAcceptPlans: true });
  const d = data({ pool: pool(rows), briefs: [brief('b1', 'deposit protection deadline', 'accepted')], nextUp: rows.map(next) });
  assert.equal(keywordState(rows[1]!, d), 'chosen');
  assert.match(rollupLine(b, d)!, /^The 1 keyword you have chosen could bring about 40 to 120 visits a month if it reaches the top three\. Estimate\.$/);
  // A brief whose target is the honest "none" never marks a row as chosen, even when its words equal the phrase.
  assert.equal(keywordState(rows[2]!, data({ briefs: [brief('b2', 'return tenancy deposit', 'accepted', { basis: 'none', searches: null })] })), 'suggested');
  // What is really queued: a planning task.
  const planning = { id: 'p', kind: 'plan', state: 'queued', payload: {} } as unknown as Job;
  assert.match(visible(main(contentKeywordsPage(shell(), b, data({ pool: pool(rows), jobs: [planning] })))), /Autopilot is planning your next articles now\./);
});

test('6-B: a row measured more than 90 days ago shows no number and no estimate; a list measured for another country is not shown as this business\'s', () => {
  const b = brand();
  const old = row('landlord gas safety', { searches: 2400, measuredAt: '2026-04-10T00:00:00.000Z', measuredMonth: '2026-04' });
  const v = visible(main(contentKeywordsPage(shell(), b, data({ pool: pool([old, row('fresh phrase')]) }))));
  assert.match(v, /landlord gas safety Suggested Measured more than three months ago, so no number is shown until it is measured again How hard/);
  assert.doesNotMatch(v, /2,400|April 2026/);
  assert.match(v, /fresh phrase Suggested About 400 searches a month/);
  // An old number on a chosen article is not counted either.
  const roll = rollupLine(b, data({ briefs: [brief('b-old', 'landlord gas safety', 'accepted', { searches: 2400, measuredAt: '2026-04-10T00:00:00.000Z' })] }));
  assert.ok(roll === null || !/\d+ to \d+/.test(roll), String(roll));
  assert.match(String(roll), /no search number yet|^null$/);
  // Another country: the list is not shown, and its numbers are not counted on this business's articles.
  const us = data({ pool: pool([row('realtor fees', { searches: 5000 })], { locationCode: 2840 }) });
  assert.equal(keywordsPageState(us, 'en-GB'), 'other_country');
  const html = visible(main(contentKeywordsPage(shell(), b, us)));
  assert.match(html, /Your keyword list was measured for another country, so it is not shown here\./);
  assert.doesNotMatch(html, /realtor fees|5,000/);
  assert.doesNotMatch(rollupLine(b, data({ briefs: [brief('b-us', 'realtor fees', 'accepted', { searches: 5000, locationCode: 2840 })] }))!, /\d+ to \d+/);
  // A country outside the supported table.
  assert.equal(keywordsPageState(data({ pool: pool([row('x y')]) }), 'fr-FR'), 'unsupported_country');
  assert.match(visible(main(contentKeywordsPage(shell(), brand({}, 'fr-FR'), data({ pool: pool([row('x y')]) })))), /Keyword lists are not available for your business's country yet\./);
});

test('6-C: the wider phrase is named; a measured 0 says "too few searches to measure"; two articles on one phrase: the furthest along decides and it counts once', () => {
  const b = brand();
  const rows = [row('prescribed information checklist', { basis: 'parent_phrase', searches: null, parent: 'prescribed information', parentSearches: 720 }), row('deposit cap rules', { searches: 0 })];
  const v = visible(main(contentKeywordsPage(shell(), b, data({ pool: pool(rows) }))));
  assert.match(v, /About 720 searches a month for the wider phrase "prescribed information", measured October 2026/);
  assert.match(v, /deposit cap rules Suggested Too few searches to measure, measured October 2026 How hard Easier Wants to Learn prescribed/);
  assert.doesNotMatch(v, /deposit cap rules.*fewer than 10 visits/i);
  // Two articles on one phrase: the first listed is only accepted, the second is ready; the phrase is Ready and counted once.
  const twin = data({ pool: pool([row('deposit dispute evidence', { searches: 170 })]), briefs: [brief('b-a', 'deposit dispute evidence', 'accepted', { searches: 170 }), brief('b-b', 'deposit dispute evidence', 'generated', { searches: 170 })] });
  assert.equal(keywordState(twin.pool!.rows[0]!, twin), 'ready');
  assert.equal(rollupLine(b, twin), 'The 1 keyword you have chosen could bring about 15 to 50 visits a month if it reaches the top three. Estimate.');
});

test('lighter rows on a phone: the full estimate sentence once at the top, a short form on each row, no per-row reason paragraph', () => {
  const b = brand({ ongoingProduction: true, autoAcceptPlans: true });
  const rows = [row('tenancy deposit protection', { searches: 1300 }), row('deposit protection deadline', { searches: 480, rankingDifficulty: 35 }), row('return tenancy deposit', { searches: 390, intent: 'commercial' }),
    row('deposit dispute evidence', { searches: 170, rankingDifficulty: 55 }), row('landlord deposit scheme comparison', { searches: 90 }), row('prescribed information checklist', { basis: 'parent_phrase', searches: null, parent: 'prescribed information', parentSearches: 720 }),
    row('how long to protect a deposit', { basis: 'observed', searches: null, measuredMonth: null, rankingDifficulty: null, intent: null }), row('deposit protection certificate', { searches: 40, ownPosition: 6 }), row('cheap deposit insurance', { searches: 8, intent: 'transactional' })];
  const d = data({ pool: pool(rows), briefs: [brief('b1', 'tenancy deposit protection', 'generated', { searches: 1300 }), brief('b2', 'deposit dispute evidence', 'accepted', { searches: 170 })], nextUp: rows.map(next) });
  const html = main(contentKeywordsPage(shell(), b, d));
  const v = visible(html);
  assert.equal(v.split(ESTIMATE_EXPLAINED).length - 1, 1);
  const shown = [...html.matchAll(/<li class="kw-row[\s\S]*?<\/li>/g)].map((m) => visible(m[0]).trim());
  assert.ok(shown.length >= 8);
  for (const r of shown) assert.ok(r.length <= 190, `row too long for a phone (${r.length}): ${r}`);
  assert.doesNotMatch(html, /kw-why|kw-next/);
  assert.match(contentKeywordsPage(shell(), b, d), /@media\(max-width:600px\)\{[^}]*\}\.kw-row\{gap:4px\}/);
});
