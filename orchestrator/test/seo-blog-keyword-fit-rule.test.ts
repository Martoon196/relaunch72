/**
 * Review fix F1 (review-keyword-followups): the half rule alone still bound a sibling's phrase and number to the wrong
 * article. The fit rule now also requires every word with a digit, every negation and every qualified letter (band D,
 * class Q, rating C), refuses a question that names a different place, stems cautiously, and binds a phrase only when
 * no other target candidate in the shortlist fits the brief better or exactly as well. Secondary phrases pass the same
 * rule. The reviewer's own pair table and sibling-slip table are re-run here, plus the end-to-end case through the
 * engine. Doubles only: no network and no paid call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { bestFit, bindByIds, candidateIds, fitScore, meaningTerms, phraseFits, type PlanningCandidates, type ShortlistRow } from '../src/seo-blog/keyword-planning.js';
import { emptyKeywordStore, type StoredKeywordRow } from '../src/seo-blog/keyword-store-shape.js';
import type { KeywordResearchProvider } from '../src/keyword/dataforseo-labs.js';
import type { LlmRequest } from '../src/llm/client.js';
import { harness, OWNER, seedBrandSite } from './seo-blog-fixtures.js';
import { clusters, pairs } from './keyword-fit-cases.js';

const t = (question: string, title = question) => ({ question, title });
const short = (phrase: string, i: number): ShortlistRow => ({ id: `r${i}`, phrase, basis: 'measured', searches: 1000 + i, measuredMonth: '2026-10', measuredAt: '2026-11-01T00:00:00.000Z',
  parent: null, parentSearches: null, difficulty: 20, intent: 'informational', clusterId: 'c', role: i ? 'supporting' : 'pillar', why: '' });

test('F1-b, c: a word with a digit, a qualified letter and a negation must each be in the brief', () => {
  // Digits.
  assert.equal(phraseFits('section 21 notice', t('How does a section 8 notice work?')), false);
  assert.equal(phraseFits('section 21', t('What is a section 8 eviction?')), false);
  assert.equal(phraseFits('section 8 notice', t('How do I serve a section 21 notice correctly?')), false);
  assert.equal(phraseFits('section 21 notice', t('How do I serve a section 21 notice correctly?')), true);
  assert.equal(phraseFits('form 6a', t('What is form 3 for landlords?')), false);
  assert.equal(phraseFits('form 6a', t('What is form 6A and when do I use it?')), true);
  // Letters after a qualifier, and a letter next to a number.
  assert.equal(phraseFits('council tax band d', t('What is council tax band A?')), false);
  assert.equal(phraseFits('council tax band d', t('How much is council tax band D in Leeds?')), true);
  assert.equal(phraseFits('class q planning', t('What is class E planning use?')), false);
  assert.equal(phraseFits('epc rating c', t('What is an EPC and who needs one?')), false);
  assert.equal(phraseFits('epc rating c', t('How do I get my rental property to EPC rating C?')), true);
  assert.deepEqual([...meaningTerms('zone 2 a flats').required].sort(), ['2', 'a']);
  // Negation.
  assert.equal(phraseFits('no deposit mortgage', t('How big a deposit do I need for a buy-to-let mortgage?')), false);
  assert.equal(phraseFits('no deposit mortgage', t('Can I get a mortgage with no deposit?')), true);
  assert.equal(phraseFits('non resident landlord tax', t('How is a non-resident landlord taxed?', 'Non-Resident Landlord Tax')), true);
  assert.equal(phraseFits('non resident landlord tax', t('How is a resident landlord taxed?', 'Resident Landlord Tax')), false);
});

test('F1-d: no over-stemming merges (new/news, rat/rate, site/sitting, plan/planning); licence/licensing and evict/eviction now fit', () => {
  assert.equal(phraseFits('new builds', t('What is the latest news for landlords this month?', 'Landlord News: November Round-up')), false);
  assert.equal(phraseFits('mortgage rates', t('How do I get rid of rats in a rented house?', 'Rats in a Rental: Who Pays?')), false);
  assert.equal(phraseFits('site survey', t('What rights does a sitting tenant have?', 'Sitting Tenants: Rights and Buy-outs')), false);
  assert.equal(phraseFits('planning permission', t('How do I read a floor plan?', 'Reading Floor Plans Before You View')), false);
  assert.equal(phraseFits('eviction notice', t('How do I evict a tenant legally?', 'Evicting a Tenant: The Legal Process for Landlords')), true);
  assert.equal(phraseFits('selective licensing', t('Do I need a licence to rent out my property?', 'Landlord Licences: Selective, Additional and HMO')), true);
  assert.equal(phraseFits('hmo licence', t('Do I need an HMO licence for my rental property?', 'HMO Licensing: When You Need One')), true);
});

test('F1-e: a question that names a different place does not take the phrase; a phrase with no place still fits a question with one', () => {
  assert.equal(phraseFits('plumber leeds', t('How do I find a plumber in Bradford?', 'Finding a Plumber in Bradford')), false);
  assert.equal(phraseFits('boiler repair leeds', t('How much does boiler repair cost in Sheffield?', 'Boiler Repair Costs in Sheffield')), false);
  assert.equal(phraseFits('estate agents york', t('Which estate agents are best in New York?', 'New York Estate Agents Compared')), false);
  assert.equal(phraseFits('boiler repair leeds', t('Who can repair my boiler in Leeds?', 'Boiler Repair in Leeds: Costs and Call-Out Times')), true);
  assert.equal(phraseFits('estate agents york', t('Which estate agent should I use to sell in York?', 'Estate Agents in York: How to Choose')), true);
  assert.equal(phraseFits('landlord insurance', t('What does landlord insurance cover in Scotland?')), true, 'the phrase names no place');
  assert.equal(phraseFits('emergency plumber manchester', t('How quickly can an emergency plumber reach me in Manchester?')), true);
  // Left open (no list of places): a lower-case place in a phrase that is also an ordinary word.
  assert.equal(phraseFits('letting agents reading', t("How do I read a letting agent's contract?", 'Reading Your Letting Agent Agreement')), true);
});

test('F1-a: the best fit among the shortlist: a better-fitting sibling blocks the choice; the longer phrase wins a tie of share; an exact tie binds neither', () => {
  const rows = ['landlord insurance', 'landlord tax', 'landlord electrical safety certificate', 'landlord gas safety certificate'].map(short);
  // The reviewer's case: 49,500 searches of "landlord insurance" against an electrical safety certificate article.
  assert.equal(phraseFits('landlord insurance', t('Do landlords need an electrical safety certificate?')), true, 'the half rule alone passes it');
  assert.equal(bestFit(rows[0]!, t('Do landlords need an electrical safety certificate?'), rows), 'fits_another_better');
  assert.equal(bestFit(rows[2]!, t('Do landlords need an electrical safety certificate?'), rows), 'fits');
  // Same share, more words: the longer phrase wins.
  const agents = ['letting agent', 'letting agent fees'].map(short);
  assert.equal(bestFit(agents[0]!, t('How much are letting agent fees?'), agents), 'fits_another_better');
  assert.equal(bestFit(agents[1]!, t('How much are letting agent fees?'), agents), 'fits');
  // Same share over the same number of words: nobody can tell, so neither binds.
  assert.equal(bestFit(rows[0]!, t('What must a landlord do by law?'), rows), 'tied');
  assert.equal(bestFit(rows[1]!, t('What must a landlord do by law?'), rows), 'tied');
  assert.equal(fitScore('landlord tax', t('What tax do landlords pay?')).share, 1);
});

test('F1-a for secondary phrases: a secondary that another target fits better is dropped; the brief\'s own target is not compared', () => {
  const c: PlanningCandidates = { primary: ['tenancy deposit protection', 'landlord gas safety certificate', 'landlord electrical safety certificate'].map(short),
    secondary: ['deposit protection schemes', 'landlord safety certificate', 'landlord electrical safety'].map((p, i) => short(p, 10 + i)) };
  const id = (phrase: string) => [...candidateIds(c)].find(([, v]) => v.row.phrase === phrase)![0];
  const out = bindByIds([
    { key: 'deposit', primaryId: id('tenancy deposit protection'), secondaryIds: [id('deposit protection schemes')], text: t('How does tenancy deposit protection work?', 'Deposit protection schemes compared') },
    // On a gas article: "landlord safety certificate" (3/3) is kept; the brief's own target, which fits better, is not
    // compared. "landlord electrical safety" (2/3) passes the half rule but the electrical certificate target fits better.
    { key: 'gas', primaryId: id('landlord gas safety certificate'), secondaryIds: [id('landlord safety certificate'), id('landlord electrical safety')], text: t('How often do landlords need a gas safety certificate?') },
  ], c);
  assert.deepEqual(out.bound.get('deposit')!.secondary.map((r) => r.phrase), ['deposit protection schemes']);
  assert.equal(out.bound.get('gas')!.primary?.phrase, 'landlord gas safety certificate');
  assert.deepEqual(out.bound.get('gas')!.secondary.map((r) => r.phrase), ['landlord safety certificate']);
  assert.deepEqual(out.dropped.map((d) => `${d.key}:${d.field}:${d.reason}`), ['gas:secondary:fits_another_better']);
  assert.equal(out.unfit, 1);
});

test('F1: the reviewer\'s pair table (86 pairs): right pairs refused and wrong pairs accepted, by the pairwise rule alone', (t) => {
  const right = pairs.filter((p) => p.kind === 'right'), wrong = pairs.filter((p) => p.kind === 'wrong');
  const refused = right.filter((p) => !phraseFits(p.phrase, { question: p.q, title: p.t }));
  const accepted = wrong.filter((p) => phraseFits(p.phrase, { question: p.q, title: p.t }));
  t.diagnostic(`right pairs refused ${refused.length}/${right.length}; wrong pairs accepted ${accepted.length}/${wrong.length}`);
  // Shipped half rule: 4/36 and 42/50. A pair has no shortlist, so the best-fit comparison cannot act here.
  assert.equal(right.length, 36); assert.equal(wrong.length, 50);
  // Bounds, not exact counts (review2 SF3): the rule may improve, but no right pair beyond the two pure paraphrases
  // (worth/valuation, adviser/broker) may be refused, and no more than the 27 wrong pairs at the first fix may pass.
  const PARAPHRASES = ['property valuation', 'mortgage broker fees'];
  for (const p of refused) assert.ok(PARAPHRASES.includes(p.phrase), `right pair refused: ${p.phrase} ⇐ ${p.q}`);
  assert.ok(accepted.length <= 27, `wrong pairs accepted rose to ${accepted.length} (at most 27)`);
  for (const note of ['number', 'single letter dropped', 'code', 'negation', 'stem new/news', 'stem sit/site', 'stem plan/planning', 'stem rat/rate'])
    assert.ok(!accepted.some((p) => p.note === note), `every "${note}" pair is refused`);
  for (const phrase of ['plumber leeds', 'boiler repair leeds', 'estate agents york']) assert.ok(!accepted.some((p) => p.note === 'place' && p.phrase === phrase), phrase);
});

test('F1: the reviewer\'s sibling-slip table (8 shortlists, 56 correct choices, 336 slips) through the real bindByIds', (t) => {
  let rights = 0, refused = 0, slips = 0, bound = 0;
  const refusedNames: string[] = [];
  for (const [name, c] of Object.entries(clusters)) {
    const cands: PlanningCandidates = { primary: c.map(([phrase], i) => short(phrase, i)), secondary: [] };
    for (let i = 0; i < c.length; i++) for (let j = 0; j < c.length; j++) {
      const out = bindByIds([{ key: 'b', primaryId: `K${j + 1}`, secondaryIds: [], text: { question: c[i]![1], title: c[i]![2] } }], cands);
      const got = out.bound.get('b')!.primary;
      if (i === j) { rights++; if (!got) { refused++; refusedNames.push(`${name}: ${c[i]![0]}`); } else assert.equal(got.phrase, c[i]![0]); }
      else { slips++; if (got) bound++; }
    }
  }
  t.diagnostic(`correct refused ${refused}/${rights} (${(100 * refused / rights).toFixed(1)}%); slips bound ${bound}/${slips} (${(100 * bound / slips).toFixed(1)}%)`);
  assert.equal(rights, 56); assert.equal(slips, 336);
  // Shipped half rule: 3/56 refused, 116/336 slips bound.
  assert.equal(bound, 0, 'no sibling slip binds');
  assert.ok(bound / slips <= 0.05);
  // Over the 8% target by two: both extra refusals are exact ties in the deliberately paraphrased shortlists (the brief
  // matches only "landlord" or only "estate agent", as several candidates do), so neither phrase can be told apart.
  assert.deepEqual(refusedNames, [
    'PARAPHRASED lettings agent (landlords): landlord responsibilities', 'PARAPHRASED lettings agent (landlords): accidental landlord',
    'PARAPHRASED lettings agent (landlords): landlord electrical safety certificate', 'PARAPHRASED estate agent (selling): estate agent fees',
    'PARAPHRASED estate agent (selling): house prices york', 'PARAPHRASED estate agent (selling): conveyancing fees']);
  for (const [name] of Object.entries(clusters).filter(([n]) => !n.startsWith('PARAPHRASED'))) assert.ok(!refusedNames.some((r) => r.startsWith(name)), `${name}: nothing correct refused`);
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

test('F1 through the engine (the reviewer\'s e2e case): each article given the next article\'s valid id stores no other article\'s phrase or number', async () => {
  const now = '2026-11-16T10:00:00.000Z';
  const C: [string, number, string, string][] = [
    ['landlord insurance', 49500, 'What does landlord insurance cover?', 'Landlord Insurance: What It Covers'],
    ['landlord tax', 6600, 'What tax do landlords pay on rental income?', 'Landlord Tax: What You Owe'],
    ['landlord licence', 2900, 'Do I need a landlord licence?', 'Landlord Licence Rules by Council'],
    ['landlord gas safety certificate', 8100, 'How often do landlords need a gas safety certificate?', 'Gas Safety Certificates for Landlords'],
    ['landlord responsibilities', 1900, "What are a landlord's legal responsibilities?", 'Landlord Responsibilities: The Full List'],
    ['accidental landlord', 720, 'What should an accidental landlord do first?', 'Accidental Landlords: First Steps'],
    ['landlord electrical safety certificate', 4400, 'Do landlords need an electrical safety certificate?', 'Electrical Safety Certificates for Landlords'],
  ];
  const row = (phrase: string, searches: number, i: number): StoredKeywordRow => ({ id: `id-${phrase}`, key: phrase, phrase, basis: 'measured', searches, measuredMonth: '2026-10', measuredAt: now,
    parent: null, parentSearches: null, rankingDifficulty: 20, intent: 'informational', clusterId: 'c1', role: i === 0 ? 'pillar' : 'supporting', why: 'w', sources: ['ideas'], ownPosition: null, opportunity: 1 - i * 0.05 });
  for (const shift of [0, 1]) {
    const h = harness(now);
    const e = new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, batchLimit: 20, keywordResearch: new NoCallKeywords() });
    seedBrandSite(h.web, 'https://harbour.example', 'deposits');
    const { brand } = await e.createBrand(OWNER, { commandId: randomUUID(), name: 'Harbour Lettings', website: 'https://harbour.example' });
    await e.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'Plans', filename: 'plans.txt', bytes: Buffer.from('Harbour Lettings Compliance Plan costs £49 per month.') });
    await e.updateSettings(OWNER, brand.id, (await e.getBrand(OWNER, brand.id)).rowVersion, { budgets: { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 } });
    const profile = await e.extractBrandProfile(OWNER, brand.id); await e.confirmProfile(OWNER, brand.id, profile.version); await e.refreshInventory(brand.id);
    const store = h.store as unknown as { inventories: Map<string, Record<string, unknown>> };
    store.inventories.set(brand.id, { ...store.inventories.get(brand.id)!, keywordPool: { ...emptyKeywordStore(2826, 'en').pool, builtAt: now, state: 'measured', rows: C.map(([p, n], i) => row(p, n, i)), calls: [] } });
    const inner = h.llm.complete.bind(h.llm);
    h.llm.complete = async (req: LlmRequest) => {
      const res = await inner(req);
      if (req.meta?.stage !== 'SEO_BLOG_PLAN') return res;
      const block = JSON.parse(/<keyword_candidates>\n([\s\S]*?)\n<\/keyword_candidates>/.exec(req.messages[0]!.content)![1]!) as { id: string; phrase: string }[];
      const v = JSON.parse(res.text) as { pillar: Record<string, unknown>; supporting: Record<string, unknown>[] };
      [v.pillar, ...v.supporting].forEach((a, i) => { a.target_query = C[i]![2]; a.working_title = C[i]![3]; a.primary_phrase_id = block.find((b) => b.phrase === C[(i + shift) % 7]![0])!.id; a.secondary_phrase_ids = []; });
      return { ...res, text: JSON.stringify(v) };
    };
    const info = console.info; console.info = () => {};
    try { await e.requestPlan(OWNER, brand.id, { commandId: randomUUID() }); h.clock.advance(1000); await e.tick('w'); } finally { console.info = info; }
    const { briefs } = (await e.listPlans(OWNER, brand.id)).at(-1)!;
    assert.equal(briefs.length, 7);
    briefs.forEach((b, i) => {
      if (shift === 0) { assert.equal(b.seo!.primary.phrase, C[i]![0], b.targetQuery); assert.equal(b.seo!.primary.searches, C[i]![1]); assert.equal(b.demand.kind, 'measured'); }
      else { assert.equal(b.seo!.primary.basis, 'none', `${b.targetQuery} must not carry "${b.seo!.primary.phrase}"`); assert.equal(b.seo!.primary.searches, null); assert.equal(b.demand.kind, 'qualitative'); }
    });
  }
});
