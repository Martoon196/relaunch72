/**
 * Follow-up finding N3 from the delta review of keyword-first planning (the rest of 5-A): with the strict setting
 * (SEO_BLOG_REQUIRE_FULL_ENGINE) on, an autopilot plan whose search-numbers lookup fails is checked once more by itself,
 * within the research allowance and reusing every saved search, then holds plainly; the owner's Retry on that hold
 * really resumes it. Owner-requested plans and the strict setting off are unchanged. Doubles only: no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { ENGINE_GAP_MESSAGE, NUMBERS_RECHECK_DELAY_MS, NUMBERS_RECHECK_MESSAGE } from '../src/seo-blog/engine-stamp.js';
import { ownerWords, revealsInternals } from '../src/seo-blog/owner-words.js';
import type { KeywordMetric, KeywordProvider } from '../src/keyword/types.js';
import type { Brand } from '../src/seo-blog/types.js';
import { harness, OWNER, seedBrandSite, type Harness } from './seo-blog-fixtures.js';

const BUDGETS = { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 };
async function readyBrand(h: Harness, e: SeoBlogEngine): Promise<Brand> {
  seedBrandSite(h.web, 'https://harbour.example', 'deposits');
  const { brand } = await e.createBrand(OWNER, { commandId: randomUUID(), name: 'Harbour Lettings', website: 'https://harbour.example' });
  await e.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'Plans', filename: 'plans.txt', bytes: Buffer.from('Harbour Lettings Compliance Plan costs £49 per month.') });
  const b = await e.getBrand(OWNER, brand.id);
  await e.updateSettings(OWNER, brand.id, b.rowVersion, { budgets: BUDGETS });
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
const strictEngine = (h: Harness, kw: KeywordProvider, strict: boolean) =>
  new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, batchLimit: 20, keywords: kw, ...(strict ? { requireFullEngine: true } : {}) });
const research = (h: Harness, id: string) => (h.store as unknown as { usage: { brandId: string; kind: string; amount: number }[] }).usage.filter((u) => u.brandId === id && u.kind === 'search_calls').reduce((n, u) => n + u.amount, 0);
const planJobs = async (h: Harness, id: string) => (await h.store.listJobs(id)).filter((j) => j.kind === 'plan');
async function autopilotPlan(h: Harness, e: SeoBlogEngine, brand: Brand) {
  const b = await e.getBrand(OWNER, brand.id);
  await e.updateSettings(OWNER, brand.id, b.rowVersion, { ongoingProduction: true });
  await e.runDaily(brand.id);
  const jobs = await planJobs(h, brand.id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.payload.requestedBy, 'system', 'an autopilot plan');
  h.clock.advance(1000); await e.tick('w');
  return (await planJobs(h, brand.id))[0]!;
}

test('N3: the new owner message is plain, neutral and passes the owner-words rule unchanged', () => {
  assert.equal(ownerWords(NUMBERS_RECHECK_MESSAGE), NUMBERS_RECHECK_MESSAGE);
  assert.equal(revealsInternals(NUMBERS_RECHECK_MESSAGE), false);
  assert.doesNotMatch(NUMBERS_RECHECK_MESSAGE, /[–—]|supplier|provider|\bmodel\b|method|engine|Retry/i);
});

test('N3: an autopilot plan whose numbers lookup fails once checks once more by itself and completes; saved searches are reused; no hold is latched', async () => {
  const h = harness(); const kw = flaky(); const e = strictEngine(h, kw, true);
  const brand = await readyBrand(h, e);
  const first = await autopilotPlan(h, e, brand);
  assert.equal(first.state, 'queued', first.error ?? '');
  assert.equal(first.progress, NUMBERS_RECHECK_MESSAGE);
  assert.equal(first.error, null);
  assert.equal((await e.getBrand(OWNER, brand.id)).settings.programme?.researchHold ?? null, null, 'no hold for the re-check');
  assert.equal(kw.calls, 1);
  const searches = h.search.calls, spent = research(h, brand.id);
  h.clock.advance(NUMBERS_RECHECK_DELAY_MS - 60_000); await e.tick('w');
  assert.equal(kw.calls, 1, 'not before its time');
  kw.healthy = true;
  h.clock.advance(60_000); await e.tick('w');
  const done = (await planJobs(h, brand.id))[0]!;
  assert.equal(done.state, 'done', done.error ?? '');
  assert.equal(kw.calls, 2, 'one repeated lookup');
  assert.equal(h.search.calls, searches, 'no saved search was repeated');
  assert.equal(research(h, brand.id), spent + 1);
  assert.equal((await planJobs(h, brand.id)).length, 1);
});

test('N3: when the re-check also fails it holds plainly, with no further automatic attempt over the following days; the owner\'s Retry then really resumes it', async () => {
  const h = harness(); const kw = flaky(); const e = strictEngine(h, kw, true);
  const brand = await readyBrand(h, e);
  await autopilotPlan(h, e, brand);
  h.clock.advance(NUMBERS_RECHECK_DELAY_MS); await e.tick('w');
  let held = (await planJobs(h, brand.id))[0]!;
  assert.equal(held.state, 'blocked');
  assert.equal(held.error, ENGINE_GAP_MESSAGE.numbers);
  assert.equal(kw.calls, 2, 'exactly one automatic re-check');
  for (let day = 0; day < 3; day++) { h.clock.advance(86_400_000); await e.runDaily(brand.id); await e.tick('w'); }
  assert.equal(kw.calls, 2, 'no loop: nothing more by itself');
  assert.equal((await planJobs(h, brand.id)).length, 1, 'and no new plan while it is held');
  // Before this fix, Retry on an autopilot plan blocked again with "Research is held…".
  kw.healthy = true;
  const spent = research(h, brand.id), searches = h.search.calls;
  await e.retryJob(OWNER, brand.id, held.id);
  h.clock.advance(60_000); await e.tick('w');
  held = (await planJobs(h, brand.id))[0]!;
  assert.equal(held.state, 'done', held.error ?? '');
  assert.equal(kw.calls, 3, 'Retry repeated only the lookup');
  assert.equal(h.search.calls, searches);
  assert.equal(research(h, brand.id), spent + 1);
  assert.equal((await e.getBrand(OWNER, brand.id)).settings.programme?.researchHold ?? null, null, 'the hold is cleared');
});

test('N3: no re-check when the allowance has no room: it holds at once, asking for nothing more', async () => {
  const h = harness(); const kw = flaky(); const e = strictEngine(h, kw, true);
  const brand = await readyBrand(h, e);
  // The month's allowance is used up by the very lookup that fails.
  const store = h.store as unknown as { brands: Map<string, Brand> };
  const metrics = kw.metrics.bind(kw);
  kw.metrics = async (keywords: string[]) => {
    const b = store.brands.get(brand.id)!;
    store.brands.set(brand.id, { ...b, settings: { ...b.settings, budgets: { ...b.settings.budgets, searchCallsPerMonth: research(h, brand.id) } } });
    return metrics(keywords);
  };
  const job = await autopilotPlan(h, e, brand);
  assert.equal(job.state, 'blocked');
  assert.equal(job.error, ENGINE_GAP_MESSAGE.numbers);
  const spent = research(h, brand.id);
  h.clock.advance(NUMBERS_RECHECK_DELAY_MS * 4); await e.tick('w');
  assert.equal(kw.calls, 1);
  assert.equal(research(h, brand.id), spent);
});

test('N3: an owner-requested plan is unchanged: it holds at once and waits for Retry (no automatic re-check)', async () => {
  const h = harness(); const kw = flaky(); const e = strictEngine(h, kw, true);
  const brand = await readyBrand(h, e);
  await e.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  h.clock.advance(1000); await e.tick('w');
  const held = (await planJobs(h, brand.id))[0]!;
  assert.equal(held.state, 'blocked');
  assert.equal(held.error, ENGINE_GAP_MESSAGE.numbers);
  h.clock.advance(NUMBERS_RECHECK_DELAY_MS * 4); await e.tick('w');
  assert.equal(kw.calls, 1);
});

test('N3: with the strict setting off there is no re-check: the autopilot plan goes on with demand in words, exactly as before', async () => {
  const h = harness(); const kw = flaky(); const e = strictEngine(h, kw, false);
  const brand = await readyBrand(h, e);
  const job = await autopilotPlan(h, e, brand);
  assert.equal(job.state, 'done', job.error ?? '');
  assert.equal(kw.calls, 1);
  const run = job.payload.programme as Record<string, unknown>;
  assert.equal(run.numbersRecheckAt, undefined);
  assert.equal(job.payload.numbersRetry, undefined);
  h.clock.advance(NUMBERS_RECHECK_DELAY_MS * 4); await e.tick('w');
  assert.equal(kw.calls, 1);
});
