/**
 * Follow-up findings N1 and N2 from the delta review of keyword-first planning (N3 is in
 * seo-blog-engine-strict-autopilot, N4 in content-area-keywords-wrap).
 * - N1: after binding by id, a chosen phrase must fit the brief (at least half its meaning words in the question or
 *   title, compared on simple stems), else the brief stays unbound with no numbers; secondary phrases likewise.
 * - N2: a bad id (not sent, a secondary-only id as a target, one target twice, the primary repeated as a secondary,
 *   a field left out, not text) is stripped; the plan is accepted, never refused or thrown for it.
 * Doubles only: no network and no paid call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { bindByIds, briefSeo, candidateIds, meaningWords, phraseFits, simpleStem, type ChosenIds, type PlanningCandidates } from '../src/seo-blog/keyword-planning.js';
import { proposeCluster } from '../src/seo-blog/generation.js';
import { emptyKeywordStore, type StoredKeywordRow } from '../src/seo-blog/keyword-store-shape.js';
import type { InventoryKeywordPool } from '../src/seo-blog/keyword-fill.js';
import type { KeywordResearchProvider } from '../src/keyword/dataforseo-labs.js';
import type { LlmClient, LlmRequest } from '../src/llm/client.js';
import type { ArticleBrief, Brand, TopicPlan } from '../src/seo-blog/types.js';
import { harness, OWNER, seedBrandSite, type Harness } from './seo-blog-fixtures.js';
import { fixtureBrand } from './rl72-method-fixtures.js';

const now = '2026-11-16T10:00:00.000Z';
const row = (phrase: string, searches: number | null, i = 0, extra: Partial<StoredKeywordRow> = {}): StoredKeywordRow => ({ id: `id-${phrase}`, key: phrase, phrase, basis: 'measured', searches, measuredMonth: '2026-10',
  measuredAt: now, parent: null, parentSearches: null, rankingDifficulty: 20, intent: 'informational', clusterId: 'c1', role: i === 0 ? 'pillar' : 'supporting', why: 'w', sources: ['ideas'], ownPosition: null,
  opportunity: 1 - i * 0.05, ...extra });
const pool = (rows: StoredKeywordRow[]): InventoryKeywordPool => ({ ...emptyKeywordStore(2826, 'en').pool, builtAt: now, state: 'measured', rows, calls: [] });
const short = (phrase: string, i: number) => { const r = row(phrase, 1000 - i, i); return { id: r.id, phrase: r.phrase, basis: r.basis, searches: r.searches, measuredMonth: r.measuredMonth,
  measuredAt: r.measuredAt, parent: null, parentSearches: null, difficulty: 20, intent: r.intent, clusterId: r.clusterId, role: r.role, why: r.why }; };
/** Exactly the given targets, in order, then the given secondary-only phrases (as the reviewer built them). */
const cands = (targets: string[], secondary: string[] = []): PlanningCandidates => ({ primary: targets.map(short), secondary: secondary.map((p, i) => short(p, 20 + i)) });
const t = (question: string, title = question) => ({ question, title });

// ─── N1: the fit check ───────────────────────────────────────────────────────

test('N1, F1-d: simple stems join plurals and -ing/-ed forms, never two different words; licence and evict families come from a table', () => {
  for (const [a, b] of [['fees', 'fee'], ['properties', 'property'], ['lettings', 'letting'], ['lets', 'let'], ['rented', 'rent'], ['renting', 'rents'], ['managed', 'managing'],
    ['taxes', 'tax'], ['houses', 'house'], ['classes', 'class'], ['returning', 'returned'], ['studies', 'studied'], ['deposits', 'deposit'], ['agents', 'agent'], ['calling', 'called'], ['rates', 'rate'],
    ['licence', 'licensing'], ['license', 'licences'], ['licensed', 'licence'], ['evict', 'eviction'], ['evicting', 'evictions']] as const) {
    assert.equal(simpleStem(a), simpleStem(b), `${a} / ${b}`);
  }
  // Under-stemming is preferred: these pairs are different words and stay apart (the review's over-stemming cases).
  for (const [a, b] of [['new', 'news'], ['rat', 'rate'], ['rats', 'rates'], ['site', 'sitting'], ['plan', 'planning'], ['bus', 'business'], ['let', 'letter'], ['let', 'letting'],
    ['fall', 'fal'], ['dress', 'dres'], ['status', 'statu'], ['speed', 'spe'], ['bed', 'b']] as const) assert.notEqual(simpleStem(a), simpleStem(b), `${a} / ${b}`);
  assert.equal(simpleStem('2026'), '2026');
});

test('N1: half of the meaning words, exactly at the boundary; stop words do not count', () => {
  // Four meaning words (landlord, deposit, return, rule): two present fits, one does not.
  assert.equal(phraseFits('landlord deposit return rules', t('How to return a tenancy deposit')), true, '2 of 4 is exactly half');
  assert.equal(phraseFits('landlord deposit return rules', t('Tenancy deposit protection explained')), false, '1 of 4');
  // Three meaning words: one is under half, two is over.
  assert.equal(phraseFits('section 21 notice', t('What is a notice to quit?')), false, '1 of 3');
  assert.equal(phraseFits('section 21 notice', t('How long is a section 21 notice valid?')), true);
  // Two meaning words: one is exactly half.
  assert.equal(phraseFits('landlord insurance', t('Do landlords need a licence?')), true, '1 of 2 is exactly half');
  assert.equal(phraseFits('combi boiler', t('How long does a new kitchen take?')), false, '0 of 2');
  // Stop words never count either way: "the best guide to" adds nothing.
  assert.deepEqual([...meaningWords('the best guide to letting agent fees in the UK')].sort(), ['agent', 'fee', 'lett']);
  // The title counts as well as the question.
  assert.equal(phraseFits('rental yield calculator', t('How do I work out what my flat earns?', 'Rental yield: a calculator and a worked example')), true);
});

test('N1: a one-word phrase must itself appear; a phrase of stop words only never fits', () => {
  assert.equal(phraseFits('landlords', t('What must every landlord check before a let?')), true);
  assert.equal(phraseFits('landlords', t('Tenancy deposit rules explained')), false);
  assert.equal(phraseFits('epc', t('What EPC rating does a rental need?')), true);
  for (const phrase of ['how to do it', 'what is the best', 'the', '']) {
    assert.equal(meaningWords(phrase).size, 0, phrase);
    assert.equal(phraseFits(phrase, t('How to do it: what is the best way, the complete guide')), false, `"${phrase}" has nothing to check, so it never fits`);
  }
});

test('N1: words in other languages and scripts: accents fold, Unicode letters count, and a script without spaces fails safe (unbound)', () => {
  assert.equal(phraseFits('Mietkaution zurückfordern', t('Wie kann ich meine Mietkaution zurückfordern?')), true);
  assert.equal(phraseFits('Mietkaution zurückfordern', t('Wie hoch darf die Miete steigen?')), false);
  assert.equal(phraseFits('café prices leeds', t('Cafe prices in Leeds this year')), true, 'accents fold');
  assert.equal(phraseFits('εγγύηση ενοικίου', t('Πότε επιστρέφεται η εγγύηση;')), true, 'Greek, 1 of 2');
  assert.equal(phraseFits('прокат автомобилей', t('Как выбрать прокат автомобилей в Москве?')), true, 'Cyrillic');
  assert.equal(phraseFits('прокат автомобилей', t('Как продать квартиру?')), false);
  assert.equal(phraseFits('東京 賃貸', t('東京 賃貸 ガイド')), true, 'spaced Japanese words are words');
  assert.equal(phraseFits('東京 賃貸', t('東京の賃貸物件の探し方')), false, 'unspaced text is one word here: left unbound, never a wrong number');
  assert.equal(phraseFits('हिंदी किराया', t('हिंदी किराया नियम')), true, 'combining vowel signs stay inside the word');
});

test('N1: binding with the brief\'s words: a target that does not fit leaves the brief unbound with no secondaries; a secondary that does not fit is dropped and the primary stays', () => {
  const c = cands(['tenancy deposit protection', 'section 21 notice', 'landlord insurance'], ['deposit protection schemes', 'eviction notice period']);
  const ids = candidateIds(c);
  const id = (phrase: string) => [...ids].find(([, v]) => v.row.phrase === phrase)![0];
  const briefs: ChosenIds[] = [
    { key: 'deposits', primaryId: id('tenancy deposit protection'), secondaryIds: [id('deposit protection schemes'), id('eviction notice period')], text: t('How does tenancy deposit protection work?') },
    // Valid id, wrong article: "section 21 notice" on an insurance article.
    { key: 'insurance', primaryId: id('section 21 notice'), secondaryIds: [id('deposit protection schemes')], text: t('Is landlord insurance a legal requirement?') },
    // Chose the same target as the brief above; it fits here, so this brief keeps it (it was not taken above).
    { key: 'notice', primaryId: id('section 21 notice'), secondaryIds: [], text: t('How long is a section 21 notice valid?') },
  ];
  const { bound, stripped, unfit, withdrawn, dropped } = bindByIds(briefs, c);
  assert.equal(bound.get('deposits')!.primary?.phrase, 'tenancy deposit protection');
  assert.deepEqual(bound.get('deposits')!.secondary.map((r) => r.phrase), ['deposit protection schemes'], 'the secondary that does not fit is dropped; the primary stays');
  assert.equal(bound.get('insurance')!.primary, null, 'never re-bound to another phrase by guesswork');
  assert.deepEqual(bound.get('insurance')!.secondary, [], 'an unbound brief carries no secondary phrase (no number)');
  assert.equal(bound.get('notice')!.primary?.phrase, 'section 21 notice');
  assert.equal(unfit, 2);
  assert.equal(stripped, 0, 'no bad id');
  assert.equal(withdrawn, 1, 'the unbound brief\'s secondary is counted apart, not as a bad id');
  assert.deepEqual(dropped.map((d) => `${d.key}:${d.field}:${d.reason}`), ['insurance:primary:does_not_fit', 'deposits:secondary:does_not_fit', 'insurance:secondary:brief_unbound']);
  const seo = briefSeo({ targetQuery: 'Is landlord insurance a legal requirement?', binding: bound.get('insurance')!, pool: pool([row('section 21 notice', 8100)]), now });
  assert.equal(seo.primary.basis, 'none');
  assert.equal(seo.primary.searches, null);
  assert.equal(seo.primary.candidateId, null);
  assert.deepEqual(seo.secondary, []);
  assert.deepEqual(seo.questions, []);
});

test('N1, F1: the reviewer\'s rotation, asserted brief by brief: right ids bind their own phrase; ids shifted by one bind nothing', () => {
  const phrases = ['letting agent', 'letting agent fees', 'letting agent leeds', 'how to choose a letting agent', 'letting agent vs self manage', 'letting agent contract', 'change letting agent'];
  const texts = [t('What does a letting agent do for a landlord?', 'What a letting agent does: a plain guide for landlords'), t('How much are letting agent fees?', 'Letting agent fees explained'),
    t('Which letting agent in Leeds should I use?', 'Choosing a letting agent in Leeds'), t('How do I choose a letting agent?', 'How to choose a letting agent: eight checks'),
    t('Should I use a letting agent or self manage?', 'Letting agent vs self manage: which suits you'), t('What should a letting agent contract include?', 'Your letting agent contract, clause by clause'),
    t('How do I change letting agent?', 'How to change letting agent without losing your tenant')];
  const c = cands(phrases);
  const ids = [...candidateIds(c).keys()];
  const boundTo = (shift: number) => { const out = bindByIds(texts.map((text, i) => ({ key: `k${i}`, primaryId: ids[(i + shift) % ids.length], secondaryIds: [], text })), c);
    return { phrases: texts.map((_, i) => out.bound.get(`k${i}`)!.primary?.phrase ?? null), reasons: out.dropped.map((d) => d.reason) }; };
  assert.deepEqual(boundTo(0).phrases, phrases, 'every brief keeps the phrase it really targets');
  // Before F1, 5 of these 7 were bound to the next article's phrase and number (all share "letting agent").
  const shifted = boundTo(1);
  assert.deepEqual(shifted.phrases, [null, null, null, null, null, null, null]);
  assert.deepEqual(shifted.reasons, ['fits_another_better', 'fits_another_better', 'does_not_fit', 'fits_another_better', 'fits_another_better', 'fits_another_better', 'fits_another_better']);
  // Across different subjects, rotation is caught as well, by the half rule alone.
  const mixed = ['tenancy deposit protection', 'landlord insurance', 'section 21 notice', 'rental yield calculator', 'gas safety certificate', 'hmo licence', 'rent arrears'];
  const mixedTexts = [t('How does tenancy deposit protection work?'), t('Is landlord insurance a legal requirement?'), t('How do I serve a section 21 notice?'), t('How do I work out rental yield?'),
    t('How often is a gas safety certificate needed?'), t('Who needs an HMO licence?'), t('What can a landlord do about rent arrears?')];
  const mc = cands(mixed);
  const mids = [...candidateIds(mc).keys()];
  const mixedRight = bindByIds(mixedTexts.map((text, i) => ({ key: `k${i}`, primaryId: mids[i], secondaryIds: [], text })), mc);
  assert.deepEqual(mixedTexts.map((_, i) => mixedRight.bound.get(`k${i}`)!.primary?.phrase), mixed);
  const mixedRotated = bindByIds(mixedTexts.map((text, i) => ({ key: `k${i}`, primaryId: mids[(i + 1) % mids.length], secondaryIds: [], text })), mc);
  assert.equal(mixedRotated.unfit, 7, 'all seven wrong choices are left unbound');
  assert.ok([...mixedRotated.bound.values()].every((b) => b.primary === null));
});

// ─── N2: bad ids are stripped, the plan stays ────────────────────────────────

test('N2: bindByIds never throws and strips every kind of bad id; with every id bad nothing is bound', () => {
  const c = cands(['tenancy deposit protection', 'deposit protection deadline'], ['deposit protection schemes']);
  const garbage: ChosenIds[] = [
    { key: 'a', primaryId: 'K99', secondaryIds: ['K42', 'S1', ''] },
    { key: 'b', primaryId: 7, secondaryIds: 'K1' },
    { key: 'c', primaryId: { id: 'K1' }, secondaryIds: [null, 3, { id: 'K2' }] },
    { key: 'd', primaryId: ['K1'], secondaryIds: { 0: 'K1' } },
    { key: 'e', primaryId: 'K3', secondaryIds: [] }, // a secondary-only id as a target
    { key: 'f', primaryId: 'k1', secondaryIds: ['K 1'] }, // close is not equal
    { key: 'g', primaryId: '<script>alert(1)</script>', secondaryIds: ['\u0000'] },
  ];
  let out!: ReturnType<typeof bindByIds>;
  assert.doesNotThrow(() => { out = bindByIds(garbage, c); });
  assert.ok([...out.bound.values()].every((b) => b.primary === null && b.secondary.length === 0));
  assert.equal(out.bound.size, garbage.length);
  assert.equal(out.unfit, 0);
  // a: 1 + 3, b: 1 + 1 (not a list), c: 1 + 3, d: 1 + 1, e: 1, f: 1 + 1, g: 1 + 1.
  assert.equal(out.stripped, 17, 'each bad value once (a value that is not a list counts once)');
  assert.ok(out.dropped.every((d) => d.id === null || candidateIds(c).has(d.id)), 'a planner\'s own text is never logged');
  // Left out entirely: nothing chosen, nothing stripped.
  const missing = bindByIds([{ key: 'x', primaryId: undefined, secondaryIds: undefined }], c);
  assert.equal(missing.bound.get('x')!.primary, null);
  assert.equal(missing.stripped, 0);
  // One target twice, and the primary repeated as a secondary: the first keeps it, the repeats go.
  const twice = bindByIds([{ key: 'p', primaryId: 'K1', secondaryIds: ['K1', 'K3'] }, { key: 'q', primaryId: 'K1', secondaryIds: [] }], c);
  assert.equal(twice.bound.get('p')!.primary?.phrase, 'tenancy deposit protection');
  assert.deepEqual(twice.bound.get('p')!.secondary.map((r) => r.phrase), ['deposit protection schemes']);
  assert.equal(twice.bound.get('q')!.primary, null);
  assert.deepEqual(twice.dropped.map((d) => d.reason), ['target_taken', 'is_a_target']);
});

const article = (role: string, i: number, extra: Record<string, unknown>) => ({ role, slug: `slug-number-${i}`, working_title: 'A working title for this', target_query: 'how does this work', search_intent: 'learn',
  related_questions: ['A related question'], angle: 'An angle that is long enough here.', outline: ['First part', 'Second part', 'Third part', 'Fourth part'], key_points: ['A key point here', 'Another key point'],
  why_fit: 'Why this fits the brand well.', cta_url: null, internal_links: [], source_ids: ['S1'], ...extra });

test('N2: the planner\'s answer is accepted at once whatever its id fields hold (no refusal, no correction call)', async () => {
  const { profile, sources } = fixtureBrand() as unknown as { profile: never; sources: never };
  const variants: Record<string, unknown>[] = [
    { primary_phrase_id: 'K99', secondary_phrase_ids: ['K98'] }, // not sent
    { primary_phrase_id: 'K3', secondary_phrase_ids: [] }, // secondary-only as a target
    { primary_phrase_id: 'K1', secondary_phrase_ids: ['K1', 'K1'] }, // primary repeated, duplicates
    {}, // both fields left out
    { primary_phrase_id: 4, secondary_phrase_ids: 'K2' }, // not text, not a list
  ];
  for (const ids of variants) {
    let calls = 0;
    const model: LlmClient = { mode: 'mock', async complete() {
      calls++;
      const out = { topic: 'Topic', money_page: { url: null, label: 'See' }, pillar: article('pillar', 0, ids), supporting: Array.from({ length: 6 }, (_, i) => article('supporting', i + 1, { ...ids, primary_phrase_id: i === 0 ? 'K1' : 'nope' })), provenance_note: 'A short provenance note.' };
      return { text: JSON.stringify(out), tokensIn: 1, tokensOut: 1, stopReason: 'end_turn', model: 'm' };
    } };
    const out = await proposeCluster(model, { brandName: 'B', profile, inventory: [], sources, focus: null, excluded: [], sourceArticleUrl: null,
      keywordCandidates: { targetIds: ['K1', 'K2'], allIds: ['K1', 'K2', 'K3'], block: [] } });
    assert.equal(calls, 1, JSON.stringify(ids));
    assert.equal(out.value.supporting.length, 6);
  }
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
const BUDGETS = { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 };
async function readyBrand(h: Harness, e: SeoBlogEngine, budgets = BUDGETS): Promise<Brand> {
  seedBrandSite(h.web, 'https://harbour.example', 'deposits');
  const { brand } = await e.createBrand(OWNER, { commandId: randomUUID(), name: 'Harbour Lettings', website: 'https://harbour.example' });
  await e.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'Plans', filename: 'plans.txt', bytes: Buffer.from('Harbour Lettings Compliance Plan costs £49 per month.') });
  const b = await e.getBrand(OWNER, brand.id);
  await e.updateSettings(OWNER, brand.id, b.rowVersion, { budgets });
  const profile = await e.extractBrandProfile(OWNER, brand.id);
  await e.confirmProfile(OWNER, brand.id, profile.version);
  await e.refreshInventory(brand.id);
  return e.getBrand(OWNER, brand.id);
}
function setPool(h: Harness, brandId: string, p: InventoryKeywordPool): void {
  const store = h.store as unknown as { inventories: Map<string, Record<string, unknown>> };
  store.inventories.set(brandId, { ...store.inventories.get(brandId)!, keywordPool: p });
}
const DEPOSITS: [string, number][] = [['tenancy deposit protection', 2400], ['deposit protection deadline', 480], ['return tenancy deposit', 390], ['deposit dispute evidence', 170],
  ['deposit protection schemes', 720], ['prescribed information deposit', 260], ['landlord deposit return rules', 210]];
/** Rewrites the fixture planner's id fields (keyword-first planning is on; the planner is a double). */
function rewritePlanIds(h: Harness, edit: (a: Record<string, unknown>, i: number, ids: string[]) => void): { calls: () => number } {
  let calls = 0;
  const inner = h.llm.complete.bind(h.llm);
  h.llm.complete = async (req: LlmRequest) => {
    const res = await inner(req);
    if (req.meta?.stage !== 'SEO_BLOG_PLAN') return res;
    calls++;
    const ids = [...req.messages[0]!.content.matchAll(/"id": "(K\d+)"/g)].map((m) => m[1]!);
    const v = JSON.parse(res.text) as { pillar: Record<string, unknown>; supporting: Record<string, unknown>[] };
    [v.pillar, ...v.supporting].forEach((a, i) => edit(a, i, ids));
    return { ...res, text: JSON.stringify(v) };
  };
  return { calls: () => calls };
}
async function planOnce(h: Harness, e: SeoBlogEngine, brandId: string): Promise<{ plan: TopicPlan; briefs: ArticleBrief[] }> {
  await e.requestPlan(OWNER, brandId, { commandId: randomUUID() });
  h.clock.advance(1000); await e.tick('w');
  const job = (await h.store.listJobs(brandId)).filter((j) => j.kind === 'plan').at(-1)!;
  assert.equal(job.state, 'done', job.error ?? '');
  return (await e.listPlans(OWNER, brandId)).at(-1)!;
}
async function captureInfo<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { return { value: await run(), lines }; } finally { console.info = original; }
}

test('N2 through the engine: a planner whose every id is bad still makes the plan; every brief is unbound with no numbers; one internal log line, nothing client-visible', async () => {
  const h = harness(now);
  const e = new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, batchLimit: 20, keywordResearch: new NoCallKeywords() });
  const brand = await readyBrand(h, e);
  setPool(h, brand.id, pool(DEPOSITS.map(([p, n], i) => row(p, n, i))));
  const planner = rewritePlanIds(h, (a, i) => {
    if (i === 0) { a.primary_phrase_id = 'K99'; a.secondary_phrase_ids = ['K98', 'K1']; }
    else if (i === 1) { a.primary_phrase_id = 42; a.secondary_phrase_ids = 'K2'; }
    else if (i === 2) { delete a.primary_phrase_id; delete a.secondary_phrase_ids; }
    else { a.primary_phrase_id = `bad-${i}`; a.secondary_phrase_ids = [null]; }
  });
  const { value: { plan, briefs }, lines } = await captureInfo(() => planOnce(h, e, brand.id));
  assert.equal(planner.calls(), 1, 'one planning call: no correction for a bad id');
  assert.equal(briefs.length, 7);
  for (const b of briefs) {
    assert.equal(b.seo!.primary.basis, 'none', b.slug);
    assert.equal(b.seo!.primary.searches, null);
    assert.deepEqual(b.seo!.secondary, []);
    assert.equal(b.demand.kind, 'qualitative');
    assert.equal(b.engine!.numbers, 'no_data');
  }
  assert.ok((plan.keywordPlanning?.stripped ?? 0) >= 9);
  const logged = lines.filter((l) => l.includes('seo_blog.keyword_ids_dropped'));
  assert.equal(logged.length, 1);
  const event = JSON.parse(logged[0]!) as { stripped: number; dropped: { id: string | null }[] };
  assert.equal(event.stripped, plan.keywordPlanning!.stripped);
  assert.ok(!logged[0]!.includes('bad-'), 'the planner\'s own text is not logged');
  const activity = (h.store as unknown as { activity: { brandId: string; message: string }[] }).activity.filter((x) => x.brandId === brand.id).map((x) => x.message).join('\n');
  assert.doesNotMatch(activity, /stripped|unknown_id|keyword_ids|K99|candidate/i);
});

test('N1 through the engine: valid ids on the wrong articles are left unbound (no number shown against them); fitting choices stay bound', async () => {
  const h = harness(now);
  const e = new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, batchLimit: 20, keywordResearch: new NoCallKeywords() });
  const brand = await readyBrand(h, e);
  setPool(h, brand.id, pool([...DEPOSITS.map(([p, n], i) => row(p, n, i)), row('section 21 notice', 8100, 9, { clusterId: 'c2' }), row('rental yield calculator', 5400, 10, { clusterId: 'c3' })]));
  // Pillar on its right phrase but with an unrelated secondary; the dispute article on the deadline phrase (wrong).
  rewritePlanIds(h, (a, i, ids) => {
    if (i === 0) { a.secondary_phrase_ids = ids.slice(-2); }
    if (a.slug === 'deposit-dispute-evidence') a.primary_phrase_id = 'K2';
    if (a.slug === 'deposit-deadline-30-days') a.primary_phrase_id = null;
  });
  const { plan, briefs } = await captureInfo(() => planOnce(h, e, brand.id)).then((r) => r.value);
  const pillar = briefs.find((b) => b.role === 'pillar')!;
  assert.equal(pillar.seo!.primary.phrase, 'tenancy deposit protection');
  assert.deepEqual(pillar.seo!.secondary, [], 'no "section 21 notice: 8,100" on a deposits pillar');
  const dispute = briefs.find((b) => b.slug === 'deposit-dispute-evidence')!;
  assert.equal(dispute.seo!.primary.basis, 'none');
  assert.equal(dispute.seo!.primary.searches, null);
  assert.equal(dispute.demand.kind, 'qualitative');
  assert.equal(dispute.engine!.numbers, 'no_data');
  assert.equal(briefs.find((b) => b.slug === 'returning-a-tenancy-deposit')!.seo!.primary.phrase, 'return tenancy deposit', 'a fitting choice stays bound');
  assert.equal(plan.keywordPlanning!.unfit, 3);
});
