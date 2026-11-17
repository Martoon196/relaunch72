/**
 * "Engine verifiably on" (release 1 of the SEO quality plan): one credential resolution for research and search
 * numbers; the strict setting SEO_BLOG_REQUIRE_FULL_ENGINE (off by default) that stops planning and writing with a
 * neutral owner message instead of quietly producing a weaker article; and the engine stamp on every plan, brief and
 * version. With the setting off nothing stops that did not stop before.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { ENGINE_GAP_MESSAGE, FULL_ENGINE_FLAG, fullEngineRequired, MIN_PLAN_SOURCES, researchCredentials } from '../src/seo-blog/engine-stamp.js';
import { configuredSearchProvider } from '../src/seo-blog/research.js';
import { seoBlogRuntime } from '../src/portal/seo-blog-service.js';
import type { KeywordMetric, KeywordProvider } from '../src/keyword/types.js';
import type { MethodSnapshot } from '../src/seo-blog/method-packs.js';
import type { ArticleBrief, Brand, EngineStamp, TopicPlan } from '../src/seo-blog/types.js';
import type { SearchHit, SearchProvider } from '../src/seo-blog/research.js';
import { harness, OWNER, seedBrandSite, type Harness } from './seo-blog-fixtures.js';
import { sha256 } from '../src/seo-blog/engine.js';

const BUDGETS = { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 };
const BANNED = /dataforseo|data for seo|anthropic|claude|openai|\bgpt\b|\bmodel\b|method pack|production.core|blog.writing|editorial.planning|supplier|provider|prompt|\bAPI\b/i;

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

/** Search numbers: measured for every phrase, none at all, or a failed request. */
function numbers(kind: 'measured' | 'none' | 'fail'): KeywordProvider & { calls: number } {
  return {
    mode: 'live', calls: 0,
    async metrics(keywords: string[]): Promise<KeywordMetric[]> {
      this.calls++;
      if (kind === 'fail') throw new Error('request failed');
      return kind === 'none' ? [] : keywords.map((keyword) => ({ keyword, volume: 320, difficulty: 20, cpc: null, source: 'dataforseo' }));
    },
  };
}

/** A method assignment as the store would report it (read-only; the method itself is not run here). */
const assigned = (brandId: string): { snapshot(id: string): Promise<MethodSnapshot> } => ({
  async snapshot() { return { brandId, assignment: { revision: 1, scope: 'private-owned-brands', pins: [], assignedAt: '2026-11-01T00:00:00.000Z', assignedBy: OWNER.userId } as never, releases: [], tokensUsed: 0 }; },
});
const unassigned = (brandId: string): { snapshot(id: string): Promise<MethodSnapshot> } => ({ async snapshot() { return { brandId, assignment: null, releases: [], tokensUsed: 0 }; } });

function engine(h: Harness, extra: Partial<ConstructorParameters<typeof SeoBlogEngine>[0]> = {}): SeoBlogEngine {
  return new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, batchLimit: 20, ...extra });
}

async function plans(e: SeoBlogEngine, brandId: string) {
  return e.listPlans(OWNER, brandId) as Promise<{ plan: TopicPlan; briefs: ArticleBrief[] }[]>;
}

const planJob = async (h: Harness, brandId: string) => (await h.store.listJobs(brandId)).filter((j) => j.kind === 'plan').at(-1)!;
const writeJob = async (h: Harness, brandId: string) => (await h.store.listJobs(brandId)).filter((j) => j.kind === 'write').at(-1)!;

// ─── Settings and credentials ────────────────────────────────────────────────

test('the strict setting is off by default and on only for the exact value "true"', () => {
  assert.equal(FULL_ENGINE_FLAG, 'SEO_BLOG_REQUIRE_FULL_ENGINE');
  assert.equal(fullEngineRequired({}), false);
  for (const v of ['false', 'TRUE', '1', 'yes', '']) assert.equal(fullEngineRequired({ SEO_BLOG_REQUIRE_FULL_ENGINE: v }), false, v);
  assert.equal(fullEngineRequired({ SEO_BLOG_REQUIRE_FULL_ENGINE: 'true' }), true);
  assert.equal(fullEngineRequired({ SEO_BLOG_REQUIRE_FULL_ENGINE: ' true ' }), true);
  assert.equal(seoBlogRuntime({}).requireFullEngine, false);
  assert.equal(seoBlogRuntime({ SEO_BLOG_REQUIRE_FULL_ENGINE: 'true' }).requireFullEngine, true);
});

test('one credential resolution: research and search numbers both work with only the scoped names, or only the shared ones', () => {
  const scoped = { SEO_BLOG_DATAFORSEO_LOGIN: 'synthetic-login', SEO_BLOG_DATAFORSEO_PASSWORD: 'synthetic-password', SEO_BLOG_KEYWORD_METRICS: 'dataforseo' };
  const shared = { DATAFORSEO_LOGIN: 'synthetic-login', DATAFORSEO_PASSWORD: 'synthetic-password', SEO_BLOG_KEYWORD_METRICS: 'dataforseo' };
  for (const env of [scoped, shared]) {
    const r = seoBlogRuntime(env);
    assert.equal(r.search.mode, 'live');
    assert.equal(r.keywords?.mode, 'live', 'the numbers find the same credentials as research');
  }
  // Field by field, scoped first: exactly as research has always resolved them.
  assert.deepEqual(researchCredentials({ SEO_BLOG_DATAFORSEO_LOGIN: 'a', DATAFORSEO_LOGIN: 'b', DATAFORSEO_PASSWORD: 'c' }), { login: 'a', password: 'c' });
  assert.equal(researchCredentials({ SEO_BLOG_DATAFORSEO_LOGIN: 'a' }), null);
  assert.equal(researchCredentials({}), null);
  // Search numbers stay opt-in: without the setting there are none, whatever credentials exist.
  assert.equal(seoBlogRuntime({ ...scoped, SEO_BLOG_KEYWORD_METRICS: undefined }).keywords, null);
  assert.equal(seoBlogRuntime({ ...shared, SEO_BLOG_KEYWORD_METRICS: 'off' }).keywords, null);
  // Research is unchanged: no credentials, or research switched off, is unconfigured.
  assert.equal(configuredSearchProvider({}).mode, 'unconfigured');
  assert.equal(configuredSearchProvider({ ...scoped, SEO_BLOG_RESEARCH_PROVIDER: 'none' }).mode, 'unconfigured');
});

// ─── With the setting off: nothing new stops; the stamp records what ran ─────

test('setting off: planning without search numbers and writing without the method go on exactly as before, and are stamped', async () => {
  const h = harness();
  const brand = await readyBrand(h);
  const e = engine(h, { methodAssignments: assigned(brand.id) }); // recorded, but nothing stops without the strict setting
  assert.equal((await e.readiness(OWNER, brand.id)).canPlan, true);
  await e.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  await e.tick('worker-1');
  const { plan, briefs } = (await plans(e, brand.id))[0]!;
  assert.ok(plan && briefs.length > 0);
  const stamp = plan.engine!;
  assert.deepEqual({ ...stamp, at: 'x' }, { schema: 1, strict: false, research: 'live', numbers: 'off', method: 'inactive', methodReceiptId: null, at: 'x' });
  for (const b of briefs) { assert.equal(b.engine?.numbers, 'off'); assert.equal(b.engine?.strict, false); assert.equal(b.demand.kind, 'qualitative'); }
  await e.acceptPlan(OWNER, brand.id, plan.id);
  await e.requestArticles(OWNER, brand.id, [briefs[0]!.id]);
  await e.tick('worker-1');
  const article = (await e.listArticles(OWNER, brand.id))[0]!.article;
  const version = await h.store.getVersion(brand.id, article.currentVersionId!);
  assert.ok(version, 'written as before');
  assert.equal(version!.engine?.method, 'inactive');
  // Composed as in production (no assignment reader without the strict setting), the method is simply off.
  assert.equal((await plans(engine(h), brand.id))[0]!.plan.engine?.method, 'inactive', 'stored stamps are unchanged by later reads');
  assert.equal(version!.engine?.numbers, 'off');
  assert.equal(version!.contentSha, sha256(version!.body), 'the stamp is outside the body and its hash');
  assert.ok(!('engine' in version!.body));
});

test('setting off: a failed search numbers request still plans with qualitative demand, as before, and the stamp says unavailable', async () => {
  const h = harness();
  const brand = await readyBrand(h);
  const e = engine(h, { keywords: numbers('fail') });
  await e.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  await e.tick('worker-1');
  const { plan, briefs } = (await plans(e, brand.id))[0]!;
  assert.equal((await planJob(h, brand.id)).state, 'done');
  assert.equal(plan.engine?.numbers, 'unavailable');
  for (const b of briefs) { assert.equal(b.demand.kind, 'qualitative'); assert.equal(b.engine?.numbers, 'unavailable'); }
});

// ─── With the setting on ─────────────────────────────────────────────────────

test('setting on, search numbers not switched on: planning is refused before anything is spent, with a neutral reason', async () => {
  const h = harness();
  const brand = await readyBrand(h);
  const e = engine(h, { requireFullEngine: true });
  const readiness = await e.readiness(OWNER, brand.id);
  assert.equal(readiness.canPlan, false);
  assert.ok(readiness.missing.includes('Search numbers need to be switched on before planning (server set-up).'));
  const before = { search: h.search.calls, model: h.llm.calls.length };
  await assert.rejects(e.requestPlan(OWNER, brand.id, { commandId: randomUUID() }), (err: Error & { status?: number }) => err.status === 409 && /Search numbers need to be switched on/.test(err.message));
  // A plan already queued before the setting was turned on holds too, still before any search or writing.
  await engine(h).requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  await e.tick('worker-1');
  const job = await planJob(h, brand.id);
  assert.equal(job.state, 'blocked');
  assert.equal(job.error, ENGINE_GAP_MESSAGE.numbers_off, 'not switched on is said as such, not as a passing fault');
  assert.deepEqual({ search: h.search.calls, model: h.llm.calls.length }, before, 'no search and no writing allowance spent');
  assert.equal((await plans(e, brand.id)).length, 0);
});

test('setting on, the search numbers request fails: planning holds before writing the plan; "no data" goes on', async () => {
  const h = harness();
  const brand = await readyBrand(h);
  const failing = numbers('fail');
  const e = engine(h, { requireFullEngine: true, keywords: failing });
  const modelBefore = h.llm.calls.length;
  await e.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  await e.tick('worker-1');
  const job = await planJob(h, brand.id);
  assert.equal(job.state, 'blocked');
  assert.equal(job.error, ENGINE_GAP_MESSAGE.numbers);
  assert.equal(failing.calls, 1, 'asked once, never repeated automatically');
  assert.equal(h.llm.calls.length, modelBefore, 'the plan was not written');
  assert.equal((await plans(e, brand.id)).length, 0);

  // The supplier answering with no numbers is not a failure: the plan goes on, stamped "no data".
  const h2 = harness();
  const brand2 = await readyBrand(h2);
  const e2 = engine(h2, { requireFullEngine: true, keywords: numbers('none') });
  await e2.requestPlan(OWNER, brand2.id, { commandId: randomUUID() });
  await e2.tick('worker-1');
  const { plan, briefs } = (await plans(e2, brand2.id))[0]!;
  assert.equal(plan.engine?.numbers, 'no_data');
  assert.equal(plan.engine?.strict, true);
  for (const b of briefs) assert.equal(b.engine?.numbers, 'no_data');
});

test('setting on, measured numbers: briefs whose phrase was measured are stamped measured', async () => {
  const h = harness();
  const brand = await readyBrand(h);
  // Measure every phrase asked about, so the planner's chosen phrase is measured whenever it was a research phrase.
  const e = engine(h, { requireFullEngine: true, keywords: numbers('measured') });
  await e.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  await e.tick('worker-1');
  const { plan, briefs } = (await plans(e, brand.id))[0]!;
  assert.equal(plan.engine?.numbers, 'measured');
  for (const b of briefs) assert.equal(b.engine?.numbers, b.demand.kind === 'measured' ? 'measured' : 'no_data');
});

test('setting on, thin research: planning holds rather than going ahead on too few sources', async () => {
  const h = harness();
  const brand = await readyBrand(h);
  const one: SearchProvider = { id: 'fake-serp', mode: 'live', async search(): Promise<SearchHit[]> { return [{ url: 'https://www.gov.uk/deposit-protection-schemes-and-landlords', title: 'Deposit protection', snippet: '' }]; } };
  const e = engine(h, { requireFullEngine: true, keywords: numbers('none'), search: one });
  const modelBefore = h.llm.calls.length;
  await e.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  await e.tick('worker-1');
  const job = await planJob(h, brand.id);
  assert.equal(job.state, 'blocked');
  assert.equal(job.error, ENGINE_GAP_MESSAGE.thin_research);
  assert.equal(h.llm.calls.length, modelBefore);
  assert.ok(MIN_PLAN_SOURCES >= 2);
});

test('setting on, the writing method expected but switched off: planning and writing stop; a business without one goes on', async () => {
  const h = harness();
  const brand = await readyBrand(h);
  // Plan and accept with the setting off, so writing can be tested on its own.
  const plain = engine(h, { keywords: numbers('none') });
  await plain.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  await plain.tick('worker-1');
  const { plan, briefs } = (await plans(plain, brand.id))[0]!;
  await plain.acceptPlan(OWNER, brand.id, plan.id);

  const strict = engine(h, { requireFullEngine: true, keywords: numbers('none'), methodAssignments: assigned(brand.id) });
  const modelBefore = h.llm.calls.length;
  await strict.requestArticles(OWNER, brand.id, [briefs[0]!.id]);
  await strict.tick('worker-1');
  const job = await writeJob(h, brand.id);
  assert.equal(job.state, 'blocked');
  assert.equal(job.error, ENGINE_GAP_MESSAGE.method);
  assert.equal(h.llm.calls.length, modelBefore, 'nothing was written');
  const held = (await strict.listArticles(OWNER, brand.id))[0]?.article;
  assert.equal(held!.currentVersionId, null);
  assert.equal(held!.editorialState, 'failed');
  assert.equal(held!.failure, ENGINE_GAP_MESSAGE.method);
  // Planning stops the same way, before research.
  const searches = h.search.calls;
  await strict.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  await strict.tick('worker-1');
  assert.equal((await planJob(h, brand.id)).error, ENGINE_GAP_MESSAGE.method);
  assert.equal(h.search.calls, searches);

  // A business with no method assigned (the house standard, as for clients) is written, and stamped so.
  const h2 = harness();
  const brand2 = await readyBrand(h2);
  const e2 = engine(h2, { requireFullEngine: true, keywords: numbers('none'), methodAssignments: unassigned(brand2.id) });
  await e2.requestPlan(OWNER, brand2.id, { commandId: randomUUID() });
  await e2.tick('worker-1');
  const { plan: p2, briefs: b2 } = (await plans(e2, brand2.id))[0]!;
  assert.equal(p2.engine?.method, 'not_assigned');
  await e2.acceptPlan(OWNER, brand2.id, p2.id);
  await e2.requestArticles(OWNER, brand2.id, [b2[0]!.id]);
  await e2.tick('worker-1');
  const a2 = (await e2.listArticles(OWNER, brand2.id))[0]!.article;
  const v2 = await h2.store.getVersion(brand2.id, a2.currentVersionId!);
  assert.deepEqual({ ...v2!.engine!, at: 'x' }, { schema: 1, strict: true, research: 'live', numbers: 'no_data', method: 'not_assigned', methodReceiptId: null, at: 'x' } satisfies EngineStamp);
});

test('setting on: a brief planned before the setting was on is written ("planned before", review 5-B); one planned under it without numbers is not', async () => {
  const h = harness();
  const brand = await readyBrand(h);
  const plain = engine(h);
  await plain.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  await plain.tick('worker-1');
  const { plan, briefs } = (await plans(plain, brand.id))[0]!;
  await plain.acceptPlan(OWNER, brand.id, plan.id);
  assert.equal(briefs[0]!.engine?.numbers, 'off');
  assert.equal(briefs[0]!.engine?.strict, false);
  const strict = engine(h, { requireFullEngine: true, keywords: numbers('none') });
  await strict.requestArticles(OWNER, brand.id, [briefs[0]!.id]);
  await strict.tick('worker-1');
  const first = (await strict.listArticles(OWNER, brand.id)).map((x) => x.article).find((a) => a.briefId === briefs[0]!.id)!;
  assert.ok(first.currentVersionId, 'planned before: written, there is no way to plan an accepted brief again');
  // An older brief (planned before stamps existed) is written too.
  const older = (await h.store.getBrief(brand.id, briefs[1]!.id))!;
  const { engine: _none, ...unstamped } = older;
  await h.store.saveBrief(unstamped as ArticleBrief);
  await strict.requestArticles(OWNER, brand.id, [older.id]);
  await strict.tick('worker-1');
  const written = (await strict.listArticles(OWNER, brand.id)).map((x) => x.article).find((a) => a.briefId === older.id)!;
  assert.ok(written.currentVersionId);
  assert.equal((await h.store.getVersion(brand.id, written.currentVersionId!))!.engine?.numbers, 'not_recorded');
  // A brief stamped as planned under the strict setting without numbers (which strict planning never makes) is held.
  const third = (await h.store.getBrief(brand.id, briefs[2]!.id))!;
  await h.store.saveBrief({ ...third, engine: { ...third.engine!, strict: true, numbers: 'unavailable' } });
  await strict.requestArticles(OWNER, brand.id, [third.id]);
  await strict.tick('worker-1');
  const held = (await h.store.listJobs(brand.id)).find((j) => j.kind === 'write' && j.payload.briefId === third.id)!;
  assert.equal(held.error, ENGINE_GAP_MESSAGE.planned_without_numbers);
  assert.doesNotMatch(held.error!, /planning it again/i, 'no promise of an action that does not exist');
});

test('every owner message is plain English: no supplier, method, model or mechanism, and no long dashes', () => {
  for (const text of [...Object.values(ENGINE_GAP_MESSAGE), 'Search numbers need to be switched on before planning (server set-up).']) {
    assert.doesNotMatch(text, BANNED, text);
    assert.doesNotMatch(text, /[–—]/, text);
  }
});
