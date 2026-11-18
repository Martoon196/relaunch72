/**
 * Keyword-first planning, review fixes 4-A, 4-B, 4-C and 4-E: the planner is shown measured candidates with ids and
 * must return, for each brief, the id it targets (or none) and ids of its secondary phrases. The server binds by id
 * only (never by similarity), checks every id is one it sent, never lets two briefs take one target, never uses a
 * number measured for another country, and never offers a near duplicate of a phrase already targeted. With the
 * switches off the planning request is byte for byte the one 7ac4392 sends. The supplier is a test double.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { bindByIds, briefSeo, candidateIds, nearUsed, planningCandidates, planningShortlist, type PlanningCandidates } from '../src/seo-blog/keyword-planning.js';
import { PLAN_PROMPT_V2, PLAN_SCHEMA, PLAN_SCHEMA_V2_VERSION, planSchemaWithCandidates, proposeCluster } from '../src/seo-blog/generation.js';
import { loadPrompt } from '../src/stages/prompt.js';
import { MethodController } from '../src/seo-blog/method-packs.js';
import { MemoryMethodStore } from '../src/seo-blog/method-store.js';
import { emptyKeywordStore, type StoredKeywordRow } from '../src/seo-blog/keyword-store-shape.js';
import type { InventoryKeywordPool } from '../src/seo-blog/keyword-fill.js';
import type { KeywordResearchProvider } from '../src/keyword/dataforseo-labs.js';
import type { LlmClient, LlmRequest } from '../src/llm/client.js';
import type { ArticleBrief, Brand, TopicPlan } from '../src/seo-blog/types.js';
import { harness, OWNER, seedBrandSite, type Harness } from './seo-blog-fixtures.js';
import { fixtureBrand } from './rl72-method-fixtures.js';
import { UpgradeFixtureModel, upgradeSnapshot } from './rl72-upgrade-fixtures.js';

const now = '2026-11-16T10:00:00.000Z';
const row = (phrase: string, searches: number | null, i = 0, extra: Partial<StoredKeywordRow> = {}): StoredKeywordRow => ({ id: `id-${phrase}`, key: phrase, phrase, basis: 'measured', searches, measuredMonth: '2026-10',
  measuredAt: now, parent: null, parentSearches: null, rankingDifficulty: 20, intent: 'informational', clusterId: 'c1', role: i === 0 ? 'pillar' : 'supporting', why: 'w', sources: ['ideas'], ownPosition: null,
  opportunity: 1 - i * 0.05, ...extra });
const pool = (rows: StoredKeywordRow[], extra: Partial<InventoryKeywordPool> = {}): InventoryKeywordPool => ({ ...emptyKeywordStore(2826, 'en').pool, builtAt: now, state: 'measured', rows, calls: [], ...extra });

// ─── 4-A: the reviewer's adversarial set (33 briefs over five shortlists) ──────────────────────────────

type Case = { name: string; phrases: [string, number][]; briefs: { q: string; t: string; about: string | null }[] };
const CASES: Case[] = [
  { name: 'A. cooperative planner', phrases: [['letting agent', 9900], ['letting agent fees', 1300], ['letting agent leeds', 720], ['how to choose a letting agent', 390], ['letting agent vs self manage', 170], ['letting agent contract', 260], ['change letting agent', 480]], briefs: [
    { q: 'What does a letting agent do for a landlord?', t: 'What a letting agent does: a plain guide for landlords', about: 'letting agent' },
    { q: 'How much are letting agent fees?', t: 'Letting agent fees explained', about: 'letting agent fees' },
    { q: 'Which letting agent in Leeds should I use?', t: 'Choosing a letting agent in Leeds', about: 'letting agent leeds' },
    { q: 'How do I choose a letting agent?', t: 'How to choose a letting agent: eight checks', about: 'how to choose a letting agent' },
    { q: 'Should I use a letting agent or self manage?', t: 'Letting agent vs self manage: which suits you', about: 'letting agent vs self manage' },
    { q: 'What should a letting agent contract include?', t: 'Your letting agent contract, clause by clause', about: 'letting agent contract' },
    { q: 'How do I change letting agent?', t: 'How to change letting agent without losing your tenant', about: 'change letting agent' } ] },
  { name: 'B. planner writes its own cluster in the same niche', phrases: [['letting agent', 9900], ['letting agent fees', 1300], ['letting agent leeds', 720], ['landlord insurance', 5400], ['landlord licence', 2900], ['rental yield calculator', 1900], ['section 21 notice', 8100]], briefs: [
    { q: 'How does tenancy deposit protection work?', t: 'Tenancy deposit protection: the landlord guide', about: null },
    { q: 'What notice must a letting agent give before an inspection?', t: 'Inspection notice rules for letting agents and landlords', about: null },
    { q: 'Do landlords need a licence to rent out a flat in Leeds?', t: 'Landlord licence rules in Leeds', about: 'landlord licence' },
    { q: 'How do letting agents handle tenancy deposit disputes?', t: 'Deposit disputes: what your letting agent should do', about: null },
    { q: 'What fees can a letting agent no longer charge tenants?', t: 'The tenant fees ban and letting agent fees', about: null },
    { q: 'Is landlord insurance a legal requirement?', t: 'Do you need landlord insurance by law?', about: 'landlord insurance' },
    { q: 'How do I serve a section 8 notice?', t: 'Serving a section 8 notice step by step', about: null } ] },
  { name: 'C. near-miss meanings', phrases: [['boiler repair cost', 2400], ['plumber leeds', 3600], ['buy to let mortgage rates', 12100], ['emergency plumber', 14800], ['bathroom fitting cost', 880], ['combi boiler', 22200], ['landlord gas safety certificate cost', 1600]], briefs: [
    { q: 'How much does a new boiler cost to replace?', t: 'Boiler replacement cost in 2026', about: null },
    { q: 'How do I find a good plumber in Bradford?', t: 'Finding a plumber in Bradford you can trust', about: null },
    { q: 'Should I sell my buy to let before mortgage rates rise?', t: 'Selling a buy to let: is now the time?', about: null },
    { q: 'What counts as a plumbing emergency?', t: 'When to call an emergency plumber and when to wait', about: 'emergency plumber' },
    { q: 'How long does bathroom fitting take?', t: 'How long a bathroom fitting takes and what it costs', about: null },
    { q: 'Combi boiler or system boiler: which is right?', t: 'Combi boiler vs system boiler', about: 'combi boiler' },
    { q: 'How often does a landlord need a gas safety certificate?', t: 'Landlord gas safety certificate: how often and who pays the cost', about: null } ] },
  { name: 'D. one- and two-word head phrases', phrases: [['landlords', 40500], ['lettings', 18100], ['tenancy agreement', 33100], ['epc', 90500], ['rent arrears', 6600], ['hmo', 49500], ['inventory', 74000]], briefs: [
    { q: 'How do landlords protect a tenancy deposit?', t: 'Deposit protection for landlords', about: null },
    { q: 'What is an HMO licence and who needs one?', t: 'HMO licence rules explained', about: null },
    { q: 'What EPC rating does a rental property need?', t: 'EPC rules for rental property', about: null },
    { q: 'How do I end a tenancy agreement early?', t: 'Ending a tenancy agreement early', about: null },
    { q: 'What can a landlord do about rent arrears?', t: 'Rent arrears: a landlord action plan', about: 'rent arrears' },
    { q: 'Why does a rental inventory matter at check out?', t: 'The rental inventory at check out', about: null },
    { q: 'Is the lettings market slowing down?', t: 'Lettings market outlook', about: null } ] },
  { name: 'E. two briefs fit one phrase', phrases: [['tenancy deposit protection', 2400], ['landlord deposit return rules', 210], ['deposit protection deadline', 320]], briefs: [
    { q: 'How does tenancy deposit protection work?', t: 'Tenancy deposit protection: the complete landlord guide to schemes, deadlines, prescribed information and returning the deposit', about: 'tenancy deposit protection' },
    { q: 'Which tenancy deposit protection scheme?', t: 'Tenancy deposit protection schemes', about: null },
    { q: 'Deposits basics for landlords', t: 'Deposits basics for landlords', about: null },
    { q: 'How to return a tenancy deposit', t: 'Returning a tenancy deposit', about: 'landlord deposit return rules' },
    { q: 'What is the deposit protection deadline?', t: 'The 30 day deposit protection deadline', about: 'deposit protection deadline' } ] },
];
// As the reviewer did: the case's phrases are the target candidates, in order.
const candidatesFor = (c: Case): PlanningCandidates => ({ primary: c.phrases.map(([p, n], i) => { const r = row(p, n, i); return { id: r.id, phrase: r.phrase, basis: r.basis, searches: r.searches, measuredMonth: r.measuredMonth,
  measuredAt: r.measuredAt, parent: null, parentSearches: null, difficulty: 20, intent: r.intent, clusterId: r.clusterId, role: r.role, why: r.why }; }), secondary: [] });
const idFor = (c: PlanningCandidates, phrase: string | null) => phrase === null ? null : [...candidateIds(c)].find(([, v]) => v.row.phrase === phrase)?.[0] ?? null;

test('4-A: the 33 adversarial briefs: with no ids returned nothing is bound; with the planner\'s ids every binding is the chosen one (zero wrong)', () => {
  let briefs = 0, boundWithout = 0, bound = 0, wrong = 0;
  for (const c of CASES) {
    const cands = candidatesFor(c);
    assert.equal(cands.primary.length, c.phrases.length, c.name);
    // The planner returned no ids (what the similarity binder used to fill in by itself).
    const none = bindByIds(c.briefs.map((b, i) => ({ key: `k${i}`, primaryId: null, secondaryIds: [] })), cands);
    // The planner chose, by id, the phrase each brief is really about (or none).
    const chosen = bindByIds(c.briefs.map((b, i) => ({ key: `k${i}`, primaryId: idFor(cands, b.about), secondaryIds: [] })), cands);
    assert.equal(chosen.stripped, 0, c.name);
    c.briefs.forEach((b, i) => {
      briefs++;
      if (none.bound.get(`k${i}`)!.primary) boundWithout++;
      const got = chosen.bound.get(`k${i}`)!.primary;
      if (got) { bound++; if (got.phrase !== b.about) wrong++; } else assert.equal(b.about, null, `${c.name}: ${b.q}`);
    });
  }
  assert.equal(briefs, 33);
  assert.equal(boundWithout, 0, 'nothing is ever bound by the words of a brief');
  assert.equal(bound, CASES.flatMap((c) => c.briefs).filter((b) => b.about).length);
  assert.equal(wrong, 0, 'zero wrong bindings');
});

test('4-A: ids are checked against what was sent: unknown, foreign, secondary-only and repeated targets are stripped; the first brief keeps a shared target', () => {
  const c = CASES[4]!;
  const p = pool([...c.phrases.map(([ph, n], i) => row(ph, n, i)), row('deposit dispute evidence', 170, 9, { clusterId: 'c9' })]);
  const cands: PlanningCandidates = { primary: planningShortlist(p, [], now).slice(0, 3), secondary: planningCandidates(p, [], now).primary.slice(3) };
  const ids = candidateIds(cands);
  const secondaryOnly = [...ids].find(([, v]) => !v.target)![0];
  const { bound, stripped } = bindByIds([
    { key: 'pillar', primaryId: 'K1', secondaryIds: ['K1', 'K2', secondaryOnly, secondaryOnly, 'K99', 'S1'] },
    { key: 'twin', primaryId: 'K1', secondaryIds: [] },
    { key: 'foreign', primaryId: 'K99', secondaryIds: [] },
    { key: 'source', primaryId: 'S1', secondaryIds: [] },
    { key: 'not-a-target', primaryId: secondaryOnly, secondaryIds: [] },
    { key: 'ok', primaryId: 'K2', secondaryIds: [] },
  ], cands);
  assert.equal(bound.get('pillar')!.primary?.phrase, 'tenancy deposit protection');
  assert.equal(bound.get('twin')!.primary, null, 'two briefs in one plan never take the same target');
  assert.equal(bound.get('foreign')!.primary, null);
  assert.equal(bound.get('source')!.primary, null);
  assert.equal(bound.get('not-a-target')!.primary, null);
  assert.equal(bound.get('ok')!.primary?.id, ids.get('K2')!.row.id);
  assert.deepEqual(bound.get('pillar')!.secondary.map((r) => r.phrase), ['deposit dispute evidence'], 'a target, a repeat and unknown ids are never secondary phrases');
  assert.equal(stripped, 4 + 5);
});

test('4-A: the output contract: a new versioned prompt and schema; the schema shown refuses an id that was not sent; two targets alike are accepted and stripped at binding (N2)', async () => {
  const v2 = loadPrompt(PLAN_PROMPT_V2);
  assert.equal(v2.header.version, '2.0.0');
  assert.equal(v2.header.stage, 'SEO_BLOG_PLAN', 'same stage, so model overrides still apply');
  assert.equal(PLAN_SCHEMA_V2_VERSION, 'seo-blog-plan-schema@2.0.0');
  assert.match(v2.body, /<keyword_candidates>/);
  assert.match(v2.body, /primary_phrase_id/);
  const old = loadPrompt('seo-blog-plan.md');
  assert.equal(old.header.version, '1.0.1', 'the old prompt is unchanged');
  assert.doesNotMatch(old.body, /keyword_candidates|primary_phrase_id/);
  const schema = planSchemaWithCandidates(['K1', 'K2'], ['K1', 'K2', 'K3']);
  const v = new Ajv({ strict: false, allErrors: true }).compile(schema);
  const art = (role: string, i: number, primary: string | null, secondary: string[] = []) => ({ role, slug: `slug-number-${i}`, working_title: 'A working title for this', target_query: 'how does this work', search_intent: 'learn',
    related_questions: ['A related question'], angle: 'An angle that is long enough here.', outline: ['First part', 'Second part', 'Third part', 'Fourth part'], key_points: ['A key point here', 'Another key point'],
    why_fit: 'Why this fits the brand well.', cta_url: null, internal_links: [], source_ids: ['S1'], primary_phrase_id: primary, secondary_phrase_ids: secondary });
  const plan = (p: string | null, s: string[] = []) => ({ topic: 'Topic', money_page: { url: null, label: 'See' }, pillar: art('pillar', 0, p, s), supporting: Array.from({ length: 6 }, (_, i) => art('supporting', i + 1, null)), provenance_note: 'A short provenance note.' });
  const valid = v(plan('K1', ['K3']));
  assert.equal(valid, true, JSON.stringify(v.errors));
  assert.equal(v(plan('K3')), false, 'a secondary-only id is not a target');
  assert.equal(v(plan('K9')), false, 'an id that was not sent is refused');
  assert.equal(v(plan('K1', ['K7'])), false);
  assert.equal(new Ajv({ strict: false }).compile(PLAN_SCHEMA)(plan('K9')), true, 'the old contract is unchanged');

  // N2 (was: refused after a correction): a planner that gives one target to two articles is accepted at once, with
  // no correction call; the repeat is stripped when binding, so the first article keeps it.
  let calls = 0;
  const model: LlmClient = { mode: 'mock', async complete(_req: LlmRequest) {
    calls++; const out = plan('K1'); out.supporting[0]!.primary_phrase_id = 'K1';
    out.pillar.internal_links = []; return { text: JSON.stringify(out), tokensIn: 1, tokensOut: 1, stopReason: 'end_turn', model: 'm' }; } };
  const { profile, sources } = fixtureBrand() as unknown as { profile: never; sources: never };
  const accepted = await proposeCluster(model, { brandName: 'B', profile, inventory: [], sources, focus: null, excluded: [], sourceArticleUrl: null,
    keywordCandidates: { targetIds: ['K1', 'K2'], allIds: ['K1', 'K2', 'K3'], block: [] } });
  assert.equal(calls, 1, 'no correction call for an id slip');
  assert.equal(accepted.value.supporting[0]!.primary_phrase_id, 'K1', 'the answer is kept as the planner returned it; binding strips it');
});

test('4-A: the planning method pack\'s validators pass with the new contract (structured planning carries the candidates and accepts the ids)', async () => {
  const f = fixtureBrand(), store = new MemoryMethodStore(), model = new UpgradeFixtureModel();
  store.snapshots.set(f.brand.id, upgradeSnapshot(f.brand.id, ['production-core', 'editorial-planning']));
  model.mutate = (v, request) => {
    const d = v._method_sidecar.decisions;
    v.pillar.key_points[0] = f.profile.approvedClaims[0];
    v.pillar.primary_phrase_id = 'K1'; v.pillar.secondary_phrase_ids = ['K3'];
    for (const [i, s] of v.supporting.entries()) { s.primary_phrase_id = i === 0 ? 'K2' : null; s.secondary_phrase_ids = []; }
    assert.match(request.messages[0]!.content, /<keyword_candidates>/);
    v._method_sidecar.evidenceReferences = ['profile:1:claim:0'];
    v._method_sidecar.decisions = { claimLedger: [{ assetPointer: '/asset/pillar/key_points/0', references: ['profile:1:claim:0'] }], sourceAssessments: [], ownerDecisionsNeeded: [], formatPerArticle: d.formatPerArticle, planningNotes: 'The practical checks serve the supplied audience without an invented outcome.' };
    const { _method_sidecar: sidecar, ...asset } = structuredClone(v), { decisions, ...review } = sidecar;
    for (const key of Object.keys(v)) delete v[key];
    Object.assign(v, { planJson: JSON.stringify(asset), _method_sidecar: { ...review, decisionsJson: JSON.stringify(decisions) } });
  };
  const llm = await new MethodController(store, true).prepare(model, { ...f, stage: 'planning', stages: ['planning'], assetRef: 'plan:test', sources: ['S1', 'fixture-source'], baselineTokens: 16000, evidence: { research: f.sources } });
  const out = await proposeCluster(llm, { brandName: f.brand.name, profile: f.profile, inventory: [], sources: f.sources, focus: null, excluded: [], sourceArticleUrl: null,
    keywordCandidates: { targetIds: ['K1', 'K2'], allIds: ['K1', 'K2', 'K3'], block: [{ id: 'K1', phrase: 'practical preparation' }, { id: 'K2', phrase: 'evidence checks' }, { id: 'K3', phrase: 'practical checks' }] } });
  assert.equal(out.value.pillar.primary_phrase_id, 'K1');
  assert.deepEqual(out.value.pillar.secondary_phrase_ids, ['K3']);
  assert.ok(out.record.methodReceiptId, 'the method run accepted the plan');
  assert.match(out.record.promptVersion, /^seo-blog-plan-v2\.md@2\.0\.0#/);
  assert.equal(model.requests.length, 1, 'no correction was needed');
});

// ─── Through the engine ─────────────────────────────────────────────────────

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

async function readyBrand(h: Harness, e: SeoBlogEngine): Promise<Brand> {
  seedBrandSite(h.web, 'https://harbour.example', 'deposits');
  const { brand } = await e.createBrand(OWNER, { commandId: randomUUID(), name: 'Harbour Lettings', website: 'https://harbour.example' });
  await e.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'Plans', filename: 'plans.txt', bytes: Buffer.from('Harbour Lettings Compliance Plan costs £49 per month.') });
  const b = await e.getBrand(OWNER, brand.id);
  await e.updateSettings(OWNER, brand.id, b.rowVersion, { budgets: { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 } });
  const profile = await e.extractBrandProfile(OWNER, brand.id);
  await e.confirmProfile(OWNER, brand.id, profile.version);
  await e.refreshInventory(brand.id);
  return e.getBrand(OWNER, brand.id);
}
const keywordEngine = (h: Harness) => new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, batchLimit: 20, keywordResearch: new NoCallKeywords() });
function setPool(h: Harness, brandId: string, p: InventoryKeywordPool): void {
  const store = h.store as unknown as { inventories: Map<string, Record<string, unknown>> };
  store.inventories.set(brandId, { ...store.inventories.get(brandId)!, keywordPool: p });
}
async function planOnce(h: Harness, e: SeoBlogEngine, brandId: string): Promise<{ plan: TopicPlan; briefs: ArticleBrief[] }> {
  await e.requestPlan(OWNER, brandId, { commandId: randomUUID() });
  h.clock.advance(1000); await e.tick('w');
  const job = (await h.store.listJobs(brandId)).filter((j) => j.kind === 'plan').at(-1)!;
  assert.equal(job.state, 'done', job.error ?? '');
  return (await e.listPlans(OWNER, brandId)).at(-1)!;
}
const DEPOSITS: [string, number][] = [['tenancy deposit protection', 2400], ['deposit protection deadline', 480], ['return tenancy deposit', 390], ['deposit dispute evidence', 170],
  ['deposit protection schemes', 720], ['prescribed information deposit', 260], ['landlord deposit return rules', 210]];

test('4-A through the engine: the scripted planner chooses by id; the brief it gives no id stays unmeasured (no more "deposits basics" bound to a return-rules number)', async () => {
  const h = harness(now);
  const e = keywordEngine(h);
  const brand = await readyBrand(h, e);
  setPool(h, brand.id, pool([...DEPOSITS.map(([p, n], i) => row(p, n, i)), row('deposit scheme costs', 90, 9, { clusterId: 'c2' })]));
  const seen: LlmRequest[] = [];
  const inner = h.llm.complete.bind(h.llm);
  h.llm.complete = async (req: LlmRequest) => { if (req.meta?.stage === 'SEO_BLOG_PLAN') seen.push(req); return inner(req); };
  const { plan, briefs } = await planOnce(h, e, brand.id);
  assert.match(plan.generation.promptVersion, /^seo-blog-plan-v2\.md@2\.0\.0#/);
  assert.equal(plan.keywordPlanning?.contract, PLAN_SCHEMA_V2_VERSION);
  assert.equal(plan.keywordPlanning?.stripped, 0);
  assert.match(seen[0]!.messages[0]!.content, /<keyword_candidates>/);
  assert.doesNotMatch(seen[0]!.messages[0]!.content, /Measured search phrases for this business/, 'no free-text guidance in the owner inputs');
  const basics = briefs.find((b) => b.slug.startsWith('deposits-basics'))!;
  assert.equal(basics.seo!.primary.basis, 'none');
  assert.equal(basics.seo!.primary.searches, null);
  assert.equal(basics.demand.kind, 'qualitative');
  assert.equal(basics.engine!.numbers, 'no_data', 'the stamp says this brief was not measured');
  const returning = briefs.find((b) => b.slug === 'returning-a-tenancy-deposit')!;
  assert.equal(returning.seo!.primary.phrase, 'return tenancy deposit');
  const targets = briefs.map((b) => b.seo!.primary.candidateId).filter(Boolean);
  assert.equal(new Set(targets).size, targets.length);
  for (const b of briefs) for (const s of b.seo!.secondary) assert.ok(!targets.includes(s.candidateId), 'a secondary phrase is never another brief\'s target');
});

test('4-B: a number measured for one country is never stored on a business in another', async () => {
  const h = harness(now);
  const e = keywordEngine(h);
  const brand = await readyBrand(h, e);
  setPool(h, brand.id, pool(DEPOSITS.map(([p, n], i) => row(p, n, i))));
  const store = h.store as unknown as { brands: Map<string, Brand> };
  store.brands.set(brand.id, { ...store.brands.get(brand.id)!, locale: 'en-US' });
  assert.deepEqual(await e.keywordNextUp(OWNER, brand.id), [], 'a UK list is not offered to a US business');
  const { plan, briefs } = await planOnce(h, e, brand.id);
  assert.equal(plan.keywordPlanning, undefined);
  assert.match(plan.generation.promptVersion, /^seo-blog-plan\.md@1\.0\.1#/, 'nothing to choose from: the original contract');
  assert.ok(briefs.every((b) => !b.seo || b.seo.primary.basis === 'none'));
  assert.ok(briefs.every((b) => b.demand.kind === 'qualitative'));
  // A list measured for the United States is not used for a UK business either; nor for a locale outside the table.
  for (const [locale, location] of [['en-GB', 2840], ['fr-FR', 2826]] as const) {
    store.brands.set(brand.id, { ...store.brands.get(brand.id)!, locale });
    setPool(h, brand.id, pool(DEPOSITS.map(([p, n], i) => row(p, n, i)), { locationCode: location }));
    assert.deepEqual(await e.keywordNextUp(OWNER, brand.id), [], `${locale} / ${location}`);
  }
});

test('4-C: near duplicates of a phrase already targeted are not offered again', () => {
  const p = pool([row('letting agent fees', 1300, 0), row('letting agent fees uk', 880, 1), row('letting agent fee', 500, 2, { key: 'x-other' }), row('rental yield calculator', 700, 3, { clusterId: 'c2' }),
    row('tenancy deposit protection', 2400, 4, { clusterId: 'c3' }), row('deposit protection deadline', 480, 5, { clusterId: 'c3' })]);
  assert.deepEqual(planningShortlist(p, ['letting agent fees'], now).map((r) => r.phrase).sort(), ['deposit protection deadline', 'rental yield calculator', 'tenancy deposit protection']);
  assert.equal(nearUsed('letting agent fees uk', ['letting agent fees']), true);
  assert.equal(nearUsed('deposit protection deadline', ['tenancy deposit protection']), false, 'a related but different phrase is still offered');
  // Secondary-only candidates follow the same rule.
  assert.ok(!planningCandidates(p, ['letting agent fees'], now).secondary.some((r) => /letting agent fee/.test(r.phrase)));
});

test('4-E: a brief bound to nothing gets no secondary phrases and no numbers; secondary phrases come only by id', () => {
  const p = pool([row('landlord insurance cost', 1900, 0), row('how much is landlord insurance', 880, 1), row('landlord licence cost', 700, 2), row('cheap landlord insurance', 300, 3)]);
  const cands = planningCandidates(p, [], now);
  const { bound } = bindByIds([{ key: 'licence', primaryId: null, secondaryIds: null }], cands);
  const seo = briefSeo({ targetQuery: 'Do landlords need a licence?', binding: bound.get('licence')!, pool: p, now });
  assert.equal(seo.primary.basis, 'none');
  assert.deepEqual(seo.secondary, [], 'no "landlord insurance cost: 1900" on a licence article');
  assert.deepEqual(seo.questions, []);
  const chosen = bindByIds([{ key: 'cost', primaryId: idFor(cands, 'landlord insurance cost'), secondaryIds: [idFor(cands, 'cheap landlord insurance')!] }], cands).bound.get('cost')!;
  const s2 = briefSeo({ targetQuery: 'How much does landlord insurance cost?', binding: chosen, pool: p, now });
  assert.deepEqual(s2.secondary.map((x) => `${x.phrase}:${x.searches}`), ['cheap landlord insurance:300']);
  assert.deepEqual(s2.questions, [], 'a question that does not contain every word of the target is not attached');
});

test('switches off: the planning request is byte for byte the one 7ac4392 sends (old prompt, old contract, no candidates)', async () => {
  const h = harness();
  const seen: unknown[] = [];
  const inner = h.llm.complete.bind(h.llm);
  h.llm.complete = async (req: LlmRequest) => { if (req.meta?.stage === 'SEO_BLOG_PLAN') seen.push({ model: req.model, maxTokens: req.maxTokens, system: req.system, messages: req.messages, outputSchema: req.outputSchema ?? null }); return inner(req); };
  seedBrandSite(h.web, 'https://harbour.example', 'deposits');
  const { brand } = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name: 'Harbour Lettings', website: 'https://harbour.example' });
  await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'Plans', filename: 'plans.txt', bytes: Buffer.from('Harbour Lettings Compliance Plan costs £49 per month.') });
  const b = await h.engine.getBrand(OWNER, brand.id);
  await h.engine.updateSettings(OWNER, brand.id, b.rowVersion, { budgets: { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 } });
  const profile = await h.engine.extractBrandProfile(OWNER, brand.id);
  await h.engine.confirmProfile(OWNER, brand.id, profile.version);
  await h.engine.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  await h.engine.tick('w');
  const { plan, briefs } = (await h.engine.listPlans(OWNER, brand.id))[0]!;
  assert.equal(seen.length, 1);
  const old = loadPrompt('seo-blog-plan.md');
  assert.equal((seen[0] as { system: string }).system, old.body);
  assert.equal(plan.generation.promptVersion, `seo-blog-plan.md@1.0.1#${old.sha256.slice(0, 12)}`);
  assert.equal(plan.keywordPlanning, undefined);
  assert.ok(briefs.every((x) => x.seo === undefined));
  // The whole request, with ids normalised, hashed on 7ac4392 with the same fixture and journey.
  const norm = JSON.stringify(seen).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID');
  assert.equal(createHash('sha256').update(norm).digest('hex'), 'cddf777b461dda4ff4c4ad83b00e6a0e62d9b7fa0f8a036f1d729348006ebee9');
});
