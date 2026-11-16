/**
 * Release 4 wiring: a business's keyword list is filled through the research allowance, one reserved attempt per
 * supplier call with its receipt and cost saved, served from the cache inside its freshness window, stored in jsonb
 * on the inventory record (no migration), kept across website refreshes, and never repeated after an unknown outcome.
 * The supplier is a test double: the paid service is never called.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { FILL_MESSAGE, fillCalls, KEYWORD_FILL_CALLS } from '../src/seo-blog/keyword-fill.js';
import type { KeywordResearchProvider, LabsCallResult, LabsMarket } from '../src/keyword/dataforseo-labs.js';
import type { KeywordCandidate, KeywordCandidateSource } from '../src/keyword/types.js';
import type { Brand } from '../src/seo-blog/types.js';
import { harness, OWNER, seedBrandSite, type Harness } from './seo-blog-fixtures.js';

const BUDGETS = { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 };
const BANNED = /dataforseo|data for seo|\blabs\b|endpoint|supplier|provider|\bapi\b|\bmodel\b|keyword_ideas|ranked_keywords/i;

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

function row(phrase: string, searches: number | null, difficulty: number | null, source: KeywordCandidateSource, market: LabsMarket): KeywordCandidate {
  return { phrase, searches, measuredMonth: searches === null ? null : '2026-10', dataUpdatedAt: '2026-11-01T00:00:00.000Z', rankingDifficulty: difficulty, adCompetition: null, cpc: null,
    intent: 'informational', secondaryIntents: [], source, parent: null, locationCode: market.locationCode, languageCode: market.languageCode };
}

/** A keyword research double: realistic rows, counted calls, optional failure. Never touches the network. */
class FakeKeywords implements KeywordResearchProvider {
  readonly mode = 'live' as const;
  calls: string[] = [];
  fail = false;
  private answer(endpoint: string, market: LabsMarket, rows: KeywordCandidate[]): LabsCallResult<KeywordCandidate> {
    this.calls.push(endpoint);
    if (this.fail) return { endpoint: endpoint as never, status: 'failed', rows: [], skippedRows: 0, totalCount: null, providerReportedCost: null, taskId: null, diagnostic: { category: 'unknown' } as never };
    return { endpoint: endpoint as never, status: rows.length ? 'ok' : 'no_data', rows, skippedRows: 0, totalCount: rows.length, providerReportedCost: 0.0132, taskId: `t-${this.calls.length}`, diagnostic: null };
  }
  async keywordsForSite(_d: string, m: LabsMarket) { return this.answer('keywords_for_site', m, [row('landlord compliance checklist', 880, 22, 'site_keywords', m), row('deposit protection rules landlords', 590, 31, 'site_keywords', m)]); }
  async rankedKeywords(_d: string, m: LabsMarket) { return this.answer('ranked_keywords', m, [{ ...row('accidental landlord guide', 320, 18, 'own_ranked', m), ranking: { position: 14, url: 'https://harbour.example/guide' } }]); }
  async keywordIdeas(_s: readonly string[], m: LabsMarket) { return this.answer('keyword_ideas', m, [row('landlord compliance plan cost', 140, 12, 'ideas', m), row('portfolio landlords tax changes', 1900, 55, 'ideas', m)]); }
  async keywordSuggestions(seed: string, m: LabsMarket) { return this.answer('keyword_suggestions', m, [row(`${seed} for beginners`, 50, 8, 'suggestions', m)]); }
  async relatedKeywords(): Promise<never> { throw new Error('not used'); }
  async competitorDomains(): Promise<never> { throw new Error('not used'); }
  async keywordOverview(): Promise<never> { throw new Error('not used'); }
  async bulkKeywordDifficulty(): Promise<never> { throw new Error('not used'); }
  async searchIntent(): Promise<never> { throw new Error('not used'); }
  async readSerpObservations(): Promise<never> { throw new Error('not used'); }
}

function engine(h: Harness, keywordResearch: KeywordResearchProvider | null) {
  return new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, batchLimit: 20, keywordResearch });
}
const usage = (h: Harness, brandId: string) => (h.store as unknown as { usage: { brandId: string; kind: string; amount: number; reference: string }[] }).usage.filter((u) => u.brandId === brandId && u.kind === 'search_calls');
const fillJob = async (h: Harness, brandId: string) => (await h.store.listJobs(brandId)).filter((j) => j.kind === 'inventory' && j.payload.keywordFill).at(-1)!;

test('switch off (no keyword research composed): keyword lists are not offered and nothing is spent', async () => {
  const h = harness();
  const brand = await readyBrand(h);
  const e = engine(h, null);
  assert.equal(e.keywordListsReady, false);
  await assert.rejects(e.requestKeywordFill(OWNER, brand.id, { commandId: randomUUID() }), (err: Error) => err.message === FILL_MESSAGE.notAvailable);
  assert.equal(await e.keywordList(OWNER, brand.id), null);
  assert.equal((await h.store.listJobs(brand.id)).filter((j) => j.payload.keywordFill).length, 0);
});

test('a fill reserves one research attempt per call, saves each receipt and cost, and stores the list on the inventory record', async () => {
  const h = harness();
  const brand = await readyBrand(h);
  const kw = new FakeKeywords();
  const e = engine(h, kw);
  const before = usage(h, brand.id).length;
  const job = await e.requestKeywordFill(OWNER, brand.id, { commandId: randomUUID() });
  assert.equal(job.kind, 'inventory');
  await e.tick('worker-1');
  const done = await fillJob(h, brand.id);
  assert.equal(done.state, 'done', done.error ?? '');
  assert.ok(kw.calls.length >= 3 && kw.calls.length <= KEYWORD_FILL_CALLS, kw.calls.join(','));
  // One research attempt per call, each with its own reference, and every receipt saved.
  const spent = usage(h, brand.id).slice(before);
  assert.equal(spent.length, kw.calls.length);
  assert.ok(spent.every((u) => u.amount === 1 && u.reference.startsWith(`keywords:${done.id}:`)));
  const attempts = (done.payload.keywordFill as { attempts: { receivedAt?: string; status?: string; providerReportedCost?: number }[] }).attempts;
  assert.equal(attempts.length, kw.calls.length);
  assert.ok(attempts.every((a) => a.receivedAt && a.status === 'ok' && a.providerReportedCost === 0.0132));
  // The list, its ledger and cache live on the inventory record next to the pages, which are untouched.
  const inventory = (await h.store.getInventory(brand.id))!;
  const pool = inventory.keywordPool!;
  assert.ok(inventory.pages.length > 0);
  assert.ok(pool.rows.length > 0);
  assert.ok(pool.rows.some((r) => r.phrase === 'landlord compliance checklist' && r.searches === 880));
  assert.equal(pool.ledger.entries.length, kw.calls.length);
  assert.equal(pool.ledger.months['2026-11']!.calls, kw.calls.length);
  assert.equal(pool.calls?.length, kw.calls.length);
  assert.equal(pool.locationCode, 2826);
  for (const r of pool.rows) assert.doesNotMatch(r.why, BANNED, r.why);
  assert.deepEqual(await e.keywordList(OWNER, brand.id), pool);
});

test('a repeat inside the freshness window is served from the saved answers: no call and no research attempt', async () => {
  const h = harness();
  const brand = await readyBrand(h);
  const kw = new FakeKeywords();
  const e = engine(h, kw);
  await e.requestKeywordFill(OWNER, brand.id, { commandId: randomUUID() });
  await e.tick('worker-1');
  const calls = kw.calls.length, spent = usage(h, brand.id).length;
  h.clock.ms += 3 * 24 * 3600_000;
  await e.requestKeywordFill(OWNER, brand.id, { commandId: randomUUID() });
  await e.tick('worker-1');
  assert.equal((await fillJob(h, brand.id)).state, 'done');
  assert.equal(kw.calls.length, calls, 'no new supplier call');
  assert.equal(usage(h, brand.id).length, spent, 'no new research attempt');
  // The same command twice is one job.
  const id = randomUUID();
  const a = await e.requestKeywordFill(OWNER, brand.id, { commandId: id });
  const b = await e.requestKeywordFill(OWNER, brand.id, { commandId: id });
  assert.equal(a.id, b.id);
});

test('a website refresh keeps the keyword list (the inventory write is not a blind overwrite)', async () => {
  const h = harness();
  const brand = await readyBrand(h);
  const e = engine(h, new FakeKeywords());
  await e.requestKeywordFill(OWNER, brand.id, { commandId: randomUUID() });
  await e.tick('worker-1');
  const pool = (await h.store.getInventory(brand.id))!.keywordPool;
  h.clock.ms += 2 * 24 * 3600_000;
  await e.refreshInventory(brand.id);
  const after = (await h.store.getInventory(brand.id))!;
  assert.equal(after.fetchedAt, h.clock.now());
  assert.deepEqual(after.keywordPool, pool);
});

test('an attempt whose outcome is unknown is never repeated automatically; the task holds with a plain message', async () => {
  const h = harness();
  const brand = await readyBrand(h);
  const kw = new FakeKeywords();
  const e = engine(h, kw);
  const job = await e.requestKeywordFill(OWNER, brand.id, { commandId: randomUUID() });
  // As if a worker reserved the first call and stopped before saving its receipt.
  const inventory = await e.refreshInventory(brand.id);
  const profile = (await h.store.latestProfile(brand.id))!;
  const first = fillCalls({ profile, brandName: brand.name, website: brand.website, pages: inventory.pages, planned: [], dismissed: [] }, { locationCode: 2826, languageCode: 'en' })[0]!;
  const stored = (await h.store.getJob(brand.id, job.id))!;
  await h.store.updateJob({ ...stored, payload: { ...stored.payload, keywordFill: { commandId: 'x', attempts: [{ sha: first.sha, endpoint: first.endpoint, nonce: randomUUID(), startedAt: h.clock.now() }] } } });
  await e.tick('worker-1');
  const held = await fillJob(h, brand.id);
  assert.equal(held.state, 'blocked');
  assert.equal(held.error, FILL_MESSAGE.unknown);
  assert.equal(kw.calls.length, 0);
});

test('no research allowance left: nothing is called; a failed call is recorded once and never retried', async () => {
  const h = harness();
  const brand = await readyBrand(h);
  const kw = new FakeKeywords();
  const e = engine(h, kw);
  await e.requestKeywordFill(OWNER, brand.id, { commandId: randomUUID() });
  const b = await h.store.getBrand(brand.id);
  await h.store.updateBrand({ ...b!, settings: { ...b!.settings, budgets: { ...b!.settings.budgets, searchCallsPerMonth: usage(h, brand.id).reduce((n, u) => n + u.amount, 0) } } });
  await e.tick('worker-1');
  const held = await fillJob(h, brand.id);
  assert.equal(held.state, 'blocked');
  assert.match(held.error!, /Research allowance/);
  assert.equal(kw.calls.length, 0);

  const h2 = harness();
  const brand2 = await readyBrand(h2);
  const failing = new FakeKeywords(); failing.fail = true;
  const e2 = engine(h2, failing);
  await e2.requestKeywordFill(OWNER, brand2.id, { commandId: randomUUID() });
  await e2.tick('worker-1');
  const j = await fillJob(h2, brand2.id);
  assert.equal(j.state, 'blocked');
  assert.equal(j.error, FILL_MESSAGE.allFailed);
  const n = failing.calls.length;
  assert.ok(n > 0);
  const tried = (j.payload.keywordFill as { attempts: { sha: string; status?: string }[] }).attempts;
  assert.equal(tried.length, n, 'each call once');
  assert.equal(new Set(tried.map((a) => a.sha)).size, n);
  assert.ok(tried.every((a) => a.status === 'failed'));
  h2.clock.ms += 3600_000;
  await e2.tick('worker-1');
  assert.equal(failing.calls.length, n, 'a held task is not retried automatically');
  assert.equal((await h2.store.getInventory(brand2.id))!.keywordPool?.rows.length ?? 0, 0);
  assert.equal((await h2.store.getInventory(brand2.id))!.keywordPool?.ledger.entries.length, n, 'the failed calls are on the ledger');
});

test('a phrase the owner dismissed never comes back into the list', async () => {
  const h = harness();
  const brand = await readyBrand(h);
  const b = await h.store.getBrand(brand.id);
  await h.store.updateBrand({ ...b!, settings: { ...b!.settings, programme: { ...(b!.settings.programme ?? {}), keywordChoices: { schema: 1, dismissed: [{ key: 'checklist compliance landlord', phrase: 'landlord compliance checklist', at: h.clock.now(), by: OWNER.userId }], chosen: [], ownerSeeds: [] } } as never } });
  const e = engine(h, new FakeKeywords());
  await e.requestKeywordFill(OWNER, brand.id, { commandId: randomUUID() });
  await e.tick('worker-1');
  const pool = (await h.store.getInventory(brand.id))!.keywordPool!;
  assert.ok(pool.rows.length > 0);
  assert.ok(!pool.rows.some((r) => r.phrase === 'landlord compliance checklist'));
});

test('owner messages for keyword lists name no supplier, mechanism or model, and use no long dashes', () => {
  for (const m of Object.values(FILL_MESSAGE)) { assert.doesNotMatch(m, BANNED, m); assert.doesNotMatch(m, /[–—]/, m); }
});
