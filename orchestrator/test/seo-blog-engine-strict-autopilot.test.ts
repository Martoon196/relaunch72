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
import { activityPage } from '../src/portal/seo-blog-view.js';
import { ENGINE_GAP_MESSAGE, NUMBERS_RECHECK_DELAY_MS, NUMBERS_RECHECK_MESSAGE, NUMBERS_RECHECK_NOW, NUMBERS_RECHECK_SUPERSEDED } from '../src/seo-blog/engine-stamp.js';
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
  for (const m of [NUMBERS_RECHECK_MESSAGE, NUMBERS_RECHECK_NOW, NUMBERS_RECHECK_SUPERSEDED]) {
    assert.equal(ownerWords(m), m);
    assert.equal(revealsInternals(m), false);
    assert.doesNotMatch(m, /[–—]|supplier|provider|\bmodel\b|method|engine|Retry/i);
  }
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

// ─── F3: no second plan while the re-check waits ─────────────────────────────

test('F3: a plan asked for by hand during the 30-minute wait resumes the waiting task: one plan, one planning call (before: 2 and 2)', async () => {
  const h = harness(); const kw = flaky(); const e = strictEngine(h, kw, true);
  const brand = await readyBrand(h, e);
  const waiting = await autopilotPlan(h, e, brand);
  assert.equal(waiting.state, 'queued');
  kw.healthy = true;
  const planCalls = () => h.llm.calls.filter((c) => c === 'SEO_BLOG_PLAN').length;
  const before = planCalls();
  const asked = await e.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  assert.equal(asked.id, waiting.id, 'the request resumes the waiting task instead of starting another');
  assert.equal(Date.parse(asked.runAfter) <= Date.parse(h.clock.now()), true, 'now, not in half an hour');
  h.clock.advance(1000); await e.tick('w');
  h.clock.advance(NUMBERS_RECHECK_DELAY_MS); await e.tick('w');
  assert.equal((await planJobs(h, brand.id)).length, 1);
  assert.equal((await planJobs(h, brand.id))[0]!.state, 'done');
  assert.equal((await e.listPlans(OWNER, brand.id)).length, 1, 'one plan');
  assert.equal(planCalls() - before, 1, 'one planning call');
  assert.equal(kw.calls, 2, 'the one repeated lookup');
});

test('F3: if a plan was made after the re-check was queued anyway, the re-check completes without planning or spending', async () => {
  const h = harness(); const kw = flaky(); const e = strictEngine(h, kw, true);
  const brand = await readyBrand(h, e);
  const waiting = await autopilotPlan(h, e, brand);
  // A plan made some other way during the wait (planted as the store would hold it).
  const plans0 = await e.listPlans(OWNER, brand.id);
  assert.equal(plans0.length, 0);
  const store = h.store as unknown as { plans: Map<string, Record<string, unknown>> };
  h.clock.advance(60_000);
  store.plans.set('p-other', { id: 'p-other', brandId: brand.id, status: 'proposed', topic: 'Other', moneyPage: null, briefIds: [], sources: [], inputs: { focus: null, excluded: [], sourceArticleUrl: null },
    profileVersion: 1, inventoryAt: null, generation: { mode: 'simulated', model: 'm', promptVersion: 'p', tokensIn: 0, tokensOut: 0 }, createdAt: h.clock.now(), acceptedAt: null });
  kw.healthy = true;
  const spent = research(h, brand.id), calls = h.llm.calls.length;
  h.clock.advance(NUMBERS_RECHECK_DELAY_MS); await e.tick('w');
  const job = (await planJobs(h, brand.id)).find((j) => j.id === waiting.id)!;
  assert.equal(job.state, 'done');
  assert.match(job.progress, /newer plan/);
  assert.equal(kw.calls, 1, 'no lookup');
  assert.equal(research(h, brand.id), spent);
  assert.equal(h.llm.calls.length, calls, 'no planning call');
  assert.equal((await e.listPlans(OWNER, brand.id)).length, 1);
});

// ─── F4: an unknown lookup outcome is never answered with a Retry that cannot work ───

async function unknownLookup(origin: 'autopilot' | 'owner') {
  const h = harness(); const kw = flaky() as ReturnType<typeof flaky> & { hang: Promise<never> | null }; kw.hang = null;
  const metrics = kw.metrics.bind(kw);
  kw.metrics = async (keywords: string[]) => { if (kw.hang) { kw.calls++; return kw.hang; } return metrics(keywords); };
  const e = strictEngine(h, kw, true);
  const brand = await readyBrand(h, e);
  kw.hang = new Promise<never>(() => undefined);
  if (origin === 'autopilot') { const b = await e.getBrand(OWNER, brand.id); await e.updateSettings(OWNER, brand.id, b.rowVersion, { ongoingProduction: true }); await e.runDaily(brand.id); }
  else await e.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  h.clock.advance(1000);
  void e.tick('A'); // This worker dies inside the lookup: its outcome is never known.
  for (let i = 0; i < 50 && kw.calls === 0; i++) await new Promise((r) => setTimeout(r, 20));
  kw.hang = null; kw.healthy = true;
  h.clock.advance(20 * 60_000); await e.tick('B');
  return { h, kw, e, brand, job: (await planJobs(h, brand.id))[0]! };
}

for (const origin of ['autopilot', 'owner'] as const) {
  test(`F4 (${origin} plan): an unknown lookup outcome holds with a true message and no working-looking Retry; it is never bought again`, async () => {
    const { h, kw, e, brand, job } = await unknownLookup(origin);
    assert.equal(job.state, 'blocked');
    assert.equal(job.error, ENGINE_GAP_MESSAGE.numbers_unknown);
    assert.doesNotMatch(job.error!, /Retry/);
    assert.match(job.error!, /will not be repeated/);
    assert.match(job.error!, /Topics/);
    assert.equal(kw.calls, 1);
    // Before: Retry said "Checking … again", checked nothing and held again. Now it refuses with the same plain words.
    await assert.rejects(() => e.retryJob(OWNER, brand.id, job.id), (x: Error) => x.message === ENGINE_GAP_MESSAGE.numbers_unknown);
    h.clock.advance(NUMBERS_RECHECK_DELAY_MS * 3); await e.tick('B');
    assert.equal(kw.calls, 1, 'never bought again, by itself or by Retry');
    // The Activity page offers no Retry for it, only the way that works.
    const html = activityPage({ brand: await e.getBrand(OWNER, brand.id), brands: [await e.getBrand(OWNER, brand.id)], tab: 'activity', csrf: 'x' }, { jobs: await e.listJobs(OWNER, brand.id), events: [] } as never);
    assert.ok(!html.includes(`jobs/${job.id}/retry`), 'no Retry form for this task');
    assert.match(html, /Start a fresh plan in Topics/);
    // The fresh start it names really works.
    const hold = (await e.getBrand(OWNER, brand.id)).settings.programme!.researchHold!;
    await e.requestPlan(OWNER, brand.id, { commandId: randomUUID(), resumeHoldId: hold.logicalRunId });
    h.clock.advance(1000); await e.tick('B');
    assert.equal((await planJobs(h, brand.id)).find((j) => j.id !== job.id)!.state, 'done');
    assert.equal(kw.calls, 2);
  });
}

test('F4: the message is plain and neutral and passes the owner-words rule unchanged', () => {
  const m = ENGINE_GAP_MESSAGE.numbers_unknown;
  assert.equal(ownerWords(m), m);
  assert.equal(revealsInternals(m), false);
  assert.ok(m.length <= 400, 'fits the stored error');
  assert.doesNotMatch(m, /[–—]|supplier|provider|\bmodel\b|method|engine|Retry/i);
});
