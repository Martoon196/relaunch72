/**
 * Review fixes 5-A and 5-C for the strict setting (SEO_BLOG_REQUIRE_FULL_ENGINE). 5-B is in seo-blog-engine-strict.
 * - 5-A: a failed search-numbers lookup no longer latches a hold Retry cannot clear: Retry repeats only that lookup,
 *   within the allowance, reusing every saved search; the message says where to go.
 * - 5-C: the method check resolves the same stages as the writer; the allowance and not-switched-on cases have their
 *   own true messages, and thin research says what happens next.
 * Doubles only: no network and no paid call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { ENGINE_GAP_MESSAGE } from '../src/seo-blog/engine-stamp.js';
import { MethodController, resolveMethods } from '../src/seo-blog/method-packs.js';
import { MemoryMethodStore } from '../src/seo-blog/method-store.js';
import type { KeywordMetric, KeywordProvider } from '../src/keyword/types.js';
import type { Brand } from '../src/seo-blog/types.js';
import { harness, OWNER, seedBrandSite, type Harness } from './seo-blog-fixtures.js';
import { upgradeSnapshot } from './rl72-upgrade-fixtures.js';

const BUDGETS = { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 };

async function readyBrand(h: Harness, e: SeoBlogEngine, budgets = BUDGETS): Promise<Brand> {
  seedBrandSite(h.web, 'https://harbour.example', 'deposits');
  const { brand } = await e.createBrand(OWNER, { commandId: randomUUID(), name: 'Harbour Lettings', website: 'https://harbour.example' });
  await e.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'Plans', filename: 'plans.txt', bytes: Buffer.from('Harbour Lettings Compliance Plan costs £49 per month.') });
  const b = await e.getBrand(OWNER, brand.id);
  await e.updateSettings(OWNER, brand.id, b.rowVersion, { budgets });
  const profile = await e.extractBrandProfile(OWNER, brand.id);
  await e.confirmProfile(OWNER, brand.id, profile.version);
  return e.getBrand(OWNER, brand.id);
}
function flaky(): KeywordProvider & { calls: number; healthy: boolean } {
  return { mode: 'live', calls: 0, healthy: false, async metrics(keywords: string[]): Promise<KeywordMetric[]> {
    this.calls++; if (!this.healthy) throw new Error('503');
    return keywords.map((keyword) => ({ keyword, volume: 50, difficulty: 3, cpc: 1, source: 'dataforseo' }));
  } };
}
const engine = (h: Harness, extra: Partial<ConstructorParameters<typeof SeoBlogEngine>[0]> = {}) =>
  new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, batchLimit: 20, ...extra });
const research = (h: Harness, id: string) => (h.store as unknown as { usage: { brandId: string; kind: string; amount: number }[] }).usage.filter((u) => u.brandId === id && u.kind === 'search_calls').reduce((n, u) => n + u.amount, 0);
const planJob = async (h: Harness, id: string) => (await h.store.listJobs(id)).filter((j) => j.kind === 'plan').at(-1)!;

test('5-A: one failed numbers lookup holds with a message that says where to go; Retry repeats only that lookup and the plan completes', async () => {
  const h = harness(); const kw = flaky(); const e = engine(h, { requireFullEngine: true, keywords: kw });
  const brand = await readyBrand(h, e);
  await e.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  h.clock.advance(1000); await e.tick('w');
  const held = await planJob(h, brand.id);
  assert.equal(held.state, 'blocked');
  assert.equal(held.error, ENGINE_GAP_MESSAGE.numbers);
  assert.match(held.error!, /press Retry beside this planning task in Activity/);
  const searchesBefore = h.search.calls, researchBefore = research(h, brand.id);
  assert.equal(kw.calls, 1);
  kw.healthy = true;
  const requeued = await e.retryJob(OWNER, brand.id, held.id);
  assert.equal(requeued.state, 'queued');
  assert.match(requeued.progress, /again/);
  h.clock.advance(60_000); await e.tick('w');
  const done = await planJob(h, brand.id);
  assert.equal(done.state, 'done', done.error ?? '');
  assert.equal(kw.calls, 2, 'the failed lookup was repeated once');
  assert.equal(h.search.calls, searchesBefore, 'no saved search was repeated');
  assert.equal(research(h, brand.id), researchBefore + 1, 'one research attempt for the one repeated lookup');
  assert.equal((await e.getBrand(OWNER, brand.id)).settings.programme?.researchHold ?? null, null, 'the hold is cleared');
  // Autopilot and new plans are no longer held.
  await e.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
});

test('5-A, 5-C: a retry that does not fit the allowance asks for nothing and says so (no "just now"); once raised, Retry completes', async () => {
  const h = harness(); const kw = flaky();
  const e = engine(h, { requireFullEngine: true, keywords: kw });
  const brand = await readyBrand(h, e);
  await e.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  h.clock.advance(1000); await e.tick('w');
  const held = await planJob(h, brand.id);
  assert.equal(held.error, ENGINE_GAP_MESSAGE.numbers);
  kw.healthy = true;
  // The allowance is now used up: the one repeated lookup does not fit.
  const used = research(h, brand.id);
  let b = await e.getBrand(OWNER, brand.id);
  await e.updateSettings(OWNER, brand.id, b.rowVersion, { budgets: { ...BUDGETS, searchCallsPerMonth: used } });
  await e.retryJob(OWNER, brand.id, held.id); h.clock.advance(60_000); await e.tick('w');
  const again = await planJob(h, brand.id);
  assert.equal(again.state, 'blocked');
  assert.equal(again.error, ENGINE_GAP_MESSAGE.numbers_allowance);
  assert.doesNotMatch(again.error!, /just now/);
  assert.equal(kw.calls, 1, 'nothing was asked beyond the allowance');
  assert.equal(research(h, brand.id), used);
  b = await e.getBrand(OWNER, brand.id);
  await e.updateSettings(OWNER, brand.id, b.rowVersion, { budgets: BUDGETS });
  await e.retryJob(OWNER, brand.id, held.id); h.clock.advance(60_000); await e.tick('w');
  assert.equal((await planJob(h, brand.id)).state, 'done');
  assert.equal(kw.calls, 2);
});

test('5-C: the strict method check resolves the same stages as the writer (an article and its visual brief)', async () => {
  const h = harness();
  const store = new MemoryMethodStore();
  const e = engine(h, { requireFullEngine: true, methods: new MethodController(store, true) });
  const brand = await readyBrand(h, engine(h));
  const state = (e as unknown as { methodState(id: string, stage: 'planning' | 'blog'): Promise<string> }).methodState.bind(e);
  for (const ids of [['production-core'], ['production-core', 'visual-briefing'], ['production-core', 'blog-writing', 'visual-briefing'], ['visual-briefing'], ['editorial-planning']]) {
    const snapshot = upgradeSnapshot(brand.id, ids);
    store.snapshots.set(brand.id, snapshot);
    let writer: boolean; try { writer = resolveMethods(snapshot, ['blog', 'visual-brief']).packs.length > 0; } catch { writer = false; }
    assert.equal(await state(brand.id, 'blog'), writer ? 'active' : 'inactive', ids.join('+'));
  }
});

test('5-C: the corrected messages: not switched on is not "just now", thin research says what happens next, and none promises an action that does not exist', () => {
  assert.doesNotMatch(ENGINE_GAP_MESSAGE.numbers_off, /just now|Retry/);
  assert.match(ENGINE_GAP_MESSAGE.thin_research, /To try again, start a new plan in Topics/);
  assert.doesNotMatch(ENGINE_GAP_MESSAGE.numbers, /started again/);
  assert.doesNotMatch(ENGINE_GAP_MESSAGE.planned_without_numbers, /Planning it again/);
  for (const m of Object.values(ENGINE_GAP_MESSAGE)) assert.doesNotMatch(m, /[–—]|supplier|provider|\bmodel\b|method|engine/i, m);
});
