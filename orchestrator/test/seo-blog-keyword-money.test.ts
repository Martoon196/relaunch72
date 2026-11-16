/**
 * Review fixes 3-A to 3-F: money on the keyword list fill. Reproductions follow the reviewer's money script with a
 * supplier double (no network, no paid call).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { FILL_MESSAGE, KEYWORD_FILL_CALLS, rebuiltPool } from '../src/seo-blog/keyword-fill.js';
import { emptyKeywordStore, type StoredKeywordRow } from '../src/seo-blog/keyword-store-shape.js';
import { marketForLocale, supportedMarketForLocale, type LabsMarket } from '../src/keyword/dataforseo-labs.js';
import type { Brand, Job } from '../src/seo-blog/types.js';
import { harness, OWNER, seedBrandSite, type Harness } from './seo-blog-fixtures.js';

const BUDGETS = { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 };
const BANNED = /dataforseo|data for seo|\blabs\b|endpoint|supplier|provider|\bapi\b|\bmodel\b|\blease\b|receipt|\battempts?\b/i;

async function readyBrand(h: Harness, budgets = BUDGETS): Promise<Brand> {
  seedBrandSite(h.web, 'https://harbour.example', 'deposits');
  const { brand } = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name: 'Harbour Lettings', website: 'https://harbour.example' });
  await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'Plans', filename: 'plans.txt', bytes: Buffer.from('Harbour Lettings Compliance Plan costs £49 per month.') });
  const b = await h.engine.getBrand(OWNER, brand.id);
  await h.engine.updateSettings(OWNER, brand.id, b.rowVersion, { budgets });
  const profile = await h.engine.extractBrandProfile(OWNER, brand.id);
  await h.engine.confirmProfile(OWNER, brand.id, profile.version);
  await h.engine.refreshInventory(brand.id);
  return h.engine.getBrand(OWNER, brand.id);
}
const cand = (phrase: string, searches: number, m: LabsMarket, source: string) => ({ phrase, searches, measuredMonth: '2026-10', dataUpdatedAt: '2026-11-01T00:00:00.000Z', rankingDifficulty: 20, adCompetition: null, cpc: null,
  intent: 'informational', secondaryIntents: [], source, parent: null, locationCode: m.locationCode, languageCode: m.languageCode });
class Fake {
  readonly mode = 'live' as const;
  args: string[] = [];
  behaviour: 'ok' | 'timeout' | 'throw' = 'ok';
  delayMs = 0;
  private async answer(endpoint: string, m: LabsMarket, arg: string, source: string) {
    this.args.push(`${endpoint}(${arg})@${m.locationCode}`);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.behaviour === 'throw') throw new Error('socket hang up');
    if (this.behaviour === 'timeout') return { endpoint, status: 'failed', rows: [], skippedRows: 0, totalCount: null, providerReportedCost: null, taskId: null, diagnostic: { category: 'unknown', retryable: false } };
    const rows = ['landlord compliance', 'deposit protection'].map((p, i) => cand(`${p} ${endpoint.split('_')[1]} ${i}`, 100 + i, m, source));
    return { endpoint, status: 'ok', rows, skippedRows: 0, totalCount: rows.length, providerReportedCost: 0.0124, taskId: 't', diagnostic: null };
  }
  keywordsForSite(d: string, m: LabsMarket) { return this.answer('keywords_for_site', m, d, 'site_keywords'); }
  rankedKeywords(d: string, m: LabsMarket) { return this.answer('ranked_keywords', m, d, 'own_ranked'); }
  keywordIdeas(s: readonly string[], m: LabsMarket) { return this.answer('keyword_ideas', m, s.join('|'), 'ideas'); }
  keywordSuggestions(seed: string, m: LabsMarket) { return this.answer('keyword_suggestions', m, seed, 'suggestions'); }
  async relatedKeywords(): Promise<never> { throw new Error('not used'); }
  async competitorDomains(): Promise<never> { throw new Error('not used'); }
  async keywordOverview(): Promise<never> { throw new Error('not used'); }
  async bulkKeywordDifficulty(): Promise<never> { throw new Error('not used'); }
  async searchIntent(): Promise<never> { throw new Error('not used'); }
  async readSerpObservations(): Promise<never> { throw new Error('not used'); }
}
const engine = (h: Harness, kw: Fake) => new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, batchLimit: 20, keywordResearch: kw as never });
const usage = (h: Harness, id: string) => (h.store as unknown as { usage: { brandId: string; kind: string; amount: number; reference: string }[] }).usage.filter((u) => u.brandId === id && u.kind === 'search_calls' && u.reference.startsWith('keywords:'));
const fills = async (h: Harness, id: string) => (await h.store.listJobs(id)).filter((j) => j.kind === 'inventory' && j.payload.keywordFill);
const setBrand = (h: Harness, id: string, patch: Partial<Brand>) => { const s = h.store as unknown as { brands: Map<string, Brand> }; s.brands.set(id, { ...s.brands.get(id)!, ...patch }); };

test('3-A: two fill commands for one business never pay twice: a second request joins the first; two workers racing two tasks make each lookup once', async () => {
  const h = harness(); const brand = await readyBrand(h); const kw = new Fake(); kw.delayMs = 15;
  const e1 = engine(h, kw), e2 = engine(h, kw);
  const first = await e1.requestKeywordFill(OWNER, brand.id, { commandId: randomUUID() });
  const second = await e2.requestKeywordFill(OWNER, brand.id, { commandId: randomUUID() });
  assert.equal(second.id, first.id, 'a request while one is queued is joined to it');
  // Two tasks exist anyway (as if two requests raced past that check), claimed by two workers at once.
  await h.store.enqueueJob({ ...first, id: randomUUID(), idempotencyKey: `keywords:${randomUUID()}`, payload: { keywordFill: { commandId: 'x', attempts: [] } }, createdAt: h.clock.now() } as Job);
  const jobsBefore = await fills(h, brand.id);
  assert.equal(jobsBefore.length, 2);
  const [a] = await h.store.claimJobs({ now: h.clock.now(), owner: 'wA', leaseMs: 600_000, limit: 1 });
  const [b] = await h.store.claimJobs({ now: h.clock.now(), owner: 'wB', leaseMs: 600_000, limit: 1 });
  assert.ok(a && b, 'two workers each hold one task');
  await Promise.all([e1.runJob(a!), e2.runJob(b!)]);
  const counts = new Map<string, number>(); for (const x of kw.args) counts.set(x, (counts.get(x) ?? 0) + 1);
  assert.ok([...counts.values()].every((n) => n === 1), `each lookup paid once: ${JSON.stringify([...counts])}`);
  assert.equal(usage(h, brand.id).length, counts.size, 'one research attempt per lookup');
  assert.ok(jobsBefore.length >= 1);
  assert.ok((await fills(h, brand.id)).every((j) => j.state === 'done'), 'the joined task finishes without paying');
});

test('3-B: a rebuild removes rows the builder now excludes (for example a phrase an article is now planned for)', () => {
  const now = '2026-11-16T10:00:00.000Z';
  const srow = (phrase: string, searches: number, o: Partial<StoredKeywordRow> = {}): StoredKeywordRow => ({ id: `id-${phrase}`, key: phrase, phrase, basis: 'measured', searches, measuredMonth: '2026-10', parent: null, parentSearches: null,
    rankingDifficulty: 20, intent: 'informational', sources: ['ideas'], clusterId: 'c1', role: 'supporting', ownPosition: null, opportunity: 0.5, why: 'w', measuredAt: now, ...o });
  const prior = { ...emptyKeywordStore(2826, 'en').pool, builtAt: now, state: 'measured' as const, rows: [srow('letting agent fees', 1300), srow('letting agent fees uk', 880), srow('rental yield calculator', 700, { clusterId: 'c2' })], calls: [] };
  const business = { profile: { offers: [{ name: 'Letting agent service' }], audiences: ['Landlords'], exclusions: [], voice: { tone: [], do: [], dont: [], examples: [] }, confirmedAt: now }, brandName: 'X', website: 'https://x.example', pages: [],
    planned: [{ id: 'b1', title: 'Letting agent fees explained', targetQuery: 'How much are letting agent fees?' }], dismissed: [] };
  const m = { locationCode: 2826, languageCode: 'en' };
  const rebuilt = rebuiltPool(prior, [cand('letting agent fees', 1300, m, 'ideas'), cand('letting agent fees uk', 880, m, 'ideas'), cand('rental yield calculator', 700, m, 'ideas')] as never, business as never, { schema: 1, dismissed: [], chosen: [], ownerSeeds: [] }, now);
  const excluded = new Set(rebuilt.built.excluded.map((x) => x.key));
  assert.ok(excluded.size > 0, 'the builder excludes something here');
  for (const r of rebuilt.pool.rows) assert.ok(!excluded.has(r.key), `${r.phrase} was excluded by the builder and must not be carried over`);
  // A row the new answers simply did not mention is still carried over (a thin rebuild never erases good data).
  const thin = rebuiltPool({ ...prior, rows: [...prior.rows, srow('deposit scheme comparison', 90, { clusterId: 'c3' })] }, [], business as never, { schema: 1, dismissed: [], chosen: [], ownerSeeds: [] }, now);
  assert.ok(thin.pool.rows.some((r) => r.phrase === 'deposit scheme comparison'));
});

test('3-C: a change of country starts a new list but keeps the cost ledger and its month totals', async () => {
  const h = harness(); const brand = await readyBrand(h); const kw = new Fake(); const e = engine(h, kw);
  await e.requestKeywordFill(OWNER, brand.id, { commandId: randomUUID() }); await e.tick('w');
  const before = (await h.store.getInventory(brand.id))!.keywordPool!;
  assert.ok(before.ledger.entries.length > 0);
  setBrand(h, brand.id, { locale: 'en-US' });
  await e.requestKeywordFill(OWNER, brand.id, { commandId: randomUUID() }); await e.tick('w');
  const after = (await h.store.getInventory(brand.id))!.keywordPool!;
  assert.equal(after.locationCode, 2840);
  assert.equal(after.ledger.entries.length, before.ledger.entries.length * 2, 'nothing spent earlier is lost from the ledger');
  const month = Object.keys(before.ledger.months)[0]!;
  assert.equal(after.ledger.months[month]!.calls, before.ledger.months[month]!.calls * 2);
  assert.ok(after.rows.every((r) => !before.rows.some((b) => b.id === r.id)), 'rows measured for the UK are not carried into the US list');
});

test('3-D: a lookup that timed out (uncertain charge) is not repeated by a new owner command unless the owner explicitly accepts that', async () => {
  for (const behaviour of ['timeout', 'throw'] as const) {
    const h = harness(); const brand = await readyBrand(h); const kw = new Fake(); kw.behaviour = behaviour; const e = engine(h, kw);
    await e.requestKeywordFill(OWNER, brand.id, { commandId: randomUUID() }); await e.tick('w');
    const made = kw.args.length;
    assert.ok(made > 0);
    kw.behaviour = 'ok';
    await assert.rejects(() => e.requestKeywordFill(OWNER, brand.id, { commandId: randomUUID() }), (err: Error) => err.message === FILL_MESSAGE.unknown);
    assert.equal(kw.args.length, made, 'nothing repeated');
    // The explicit owner decision: try again, accepting the earlier charges may be uncertain. Each lookup is made once more, not more.
    await e.requestKeywordFill(OWNER, brand.id, { commandId: randomUUID(), acceptUncertain: true }); await e.tick('w');
    assert.equal(kw.args.length, made * 2, behaviour);
    const latest = (await fills(h, brand.id)).at(-1)!;
    assert.equal(latest.state, 'done', latest.error ?? '');
    // A further plain command is not blocked by the uncertainty the owner already accepted, and is served from the saved answers.
    await e.requestKeywordFill(OWNER, brand.id, { commandId: randomUUID() }); await e.tick('w');
    assert.equal(kw.args.length, made * 2);
  }
});

test('3-E: the whole refresh must fit in the allowance before anything is paid, with a plain owner message', async () => {
  const h = harness(); const brand = await readyBrand(h, { ...BUDGETS, searchCallsPerMonth: 3 }); const kw = new Fake(); const e = engine(h, kw);
  await assert.rejects(() => e.requestKeywordFill(OWNER, brand.id, { commandId: randomUUID() }), (err: Error) => {
    assert.match(err.message, /not enough research allowance left this month to refresh your keyword list\. It needs up to \d+ searches and 3 are left\./);
    assert.doesNotMatch(err.message, BANNED); assert.doesNotMatch(err.message, /[–—]/); return true; });
  assert.equal(kw.args.length, 0);
  // Allowance lowered after the request was accepted: the task stops before the first call, and a Retry after it is raised completes.
  const h2 = harness(); const b2 = await readyBrand(h2); const kw2 = new Fake(); const e2 = engine(h2, kw2);
  const job = await e2.requestKeywordFill(OWNER, b2.id, { commandId: randomUUID() });
  const fresh = await h2.engine.getBrand(OWNER, b2.id);
  await h2.engine.updateSettings(OWNER, b2.id, fresh.rowVersion, { budgets: { ...BUDGETS, searchCallsPerMonth: 3 } });
  await e2.tick('w');
  const held = (await h2.store.getJob(b2.id, job.id))!;
  assert.equal(held.state, 'blocked');
  assert.match(held.error!, /not enough research allowance left/);
  assert.equal(kw2.args.length, 0, 'nothing paid for a refresh that cannot finish');
  const again = await h2.engine.getBrand(OWNER, b2.id);
  await h2.engine.updateSettings(OWNER, b2.id, again.rowVersion, { budgets: BUDGETS });
  await e2.retryJob(OWNER, b2.id, job.id); await e2.tick('w');
  assert.equal((await h2.store.getJob(b2.id, job.id))!.state, 'done');
  assert.ok(kw2.args.length > 0 && kw2.args.length <= KEYWORD_FILL_CALLS);
  for (const m of Object.values(FILL_MESSAGE)) { assert.doesNotMatch(m, BANNED, m); assert.doesNotMatch(m, /[–—]/, m); }
});

test('3-F: a locale outside the supported table is refused with a plain message and never measured as the UK', async () => {
  assert.equal(supportedMarketForLocale('fr-FR'), null);
  assert.equal(supportedMarketForLocale('en-NZ'), null);
  assert.deepEqual(supportedMarketForLocale('en-US'), { locationCode: 2840, languageCode: 'en' });
  assert.equal(marketForLocale('fr-FR').locationCode, 2826, 'the old helper is unchanged for its other callers');
  const h = harness(); const brand = await readyBrand(h); const kw = new Fake(); const e = engine(h, kw);
  setBrand(h, brand.id, { locale: 'en-NZ' });
  await assert.rejects(() => e.requestKeywordFill(OWNER, brand.id, { commandId: randomUUID() }), (err: Error) => err.message === FILL_MESSAGE.unsupportedCountry);
  // A task queued earlier stops at the same rule before any call.
  setBrand(h, brand.id, { locale: 'en-GB' });
  const job = await e.requestKeywordFill(OWNER, brand.id, { commandId: randomUUID() });
  setBrand(h, brand.id, { locale: 'en-NZ' });
  await e.tick('w');
  const held = (await h.store.getJob(brand.id, job.id))!;
  assert.equal(held.state, 'blocked');
  assert.equal(held.error, FILL_MESSAGE.unsupportedCountry);
  assert.equal(kw.args.length, 0);
});
