/**
 * The four follow-ups from the allowance-resume review:
 * 1. "Write it now" only when nothing else would stop the write (A1);
 * 2. next month's wake-up is kept when the month's pass is skipped for a pause or unconfirmed details;
 * 3. the resume and the pages read waiting writes directly, not only among the newest tasks;
 * 4. the waiting sentence says the write starts again by itself (only when that is true).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writingStatus, type ResumeFacts } from '../src/portal/seo-blog-article-view.js';
import { SeoBlogEngine, USAGE_ESTIMATES } from '../src/seo-blog/engine.js';
import type { Brand, Job } from '../src/seo-blog/types.js';
import { OWNER } from './seo-blog-fixtures.js';
import { websiteFixture } from './seo-blog-website-fixtures.js';
import * as fx from './seo-blog-article-page-fixtures.js';

delete process.env.CONTENT_AREA_PREVIEW;

const BRIEF = 'brief-1';
const job = (error: string, o: Partial<Job> = {}): Job => ({ id: 'job-1', brandId: fx.BRAND_ID, kind: 'write', idempotencyKey: `write:${BRIEF}`, payload: { briefId: BRIEF }, state: 'blocked', attempts: 1, maxAttempts: 3,
  leaseOwner: null, leaseExpiresAt: null, runAfter: '2026-11-16T12:00:00.000Z', progress: 'Paused until the issue is fixed.', error, createdAt: '2026-11-10T09:00:00.000Z', updatedAt: '2026-11-16T09:00:00.000Z', rowVersion: 3 });
const ALLOWANCE = 'Writing allowance: monthly ceiling reached. Used 100,000; ceiling 100,000; remaining 0 model tokens.';
const brand = (o: Partial<Brand['settings']> = {}): Brand => ({ ...fx.brand, settings: { ...fx.brand.settings, budgets: { ...fx.brand.settings.budgets, modelTokensPerMonth: 1_000_000 }, ...o } });
const facts = (o: Partial<ResumeFacts> = {}): ResumeFacts => ({ usage: { model_tokens: 0, search_calls: 0, images: 0 }, profile: 'confirmed', generation: 'live', ...o });

test('1. "Write it now" is offered only when nothing else would stop the write; otherwise the other reason is said, with no button', () => {
  const ok = writingStatus(brand(), null, BRIEF, [job(ALLOWANCE)], facts());
  assert.equal(ok.retryLabel, 'Write it now'); assert.equal(ok.retryJobId, 'job-1');
  const paused = writingStatus(brand({ pauseAll: true }), null, BRIEF, [job(ALLOWANCE)], facts());
  assert.equal(paused.retryJobId, null); assert.equal(paused.sentence, 'Paused: writing is paused for your business.'); assert.match(paused.link!.href, /publishing$/);
  const unconfirmed = writingStatus(brand(), null, BRIEF, [job(ALLOWANCE)], facts({ profile: 'unconfirmed' }));
  assert.equal(unconfirmed.retryJobId, null); assert.equal(unconfirmed.sentence, 'Paused: waiting for you to confirm your business details.'); assert.match(unconfirmed.link!.href, /\/dna$/);
  const noService = writingStatus(brand(), null, BRIEF, [job(ALLOWANCE)], facts({ generation: 'unavailable' }));
  assert.equal(noService.retryJobId, null); assert.equal(noService.sentence, 'Paused: the writing service is not connected.');
  // The same for the other causes: details confirmed now, but the allowance is still short.
  const short = writingStatus(brand({ budgets: { ...fx.brand.settings.budgets, modelTokensPerMonth: 10_000 } }), null, BRIEF, [job('Confirm the current brand profile before writing.')], facts());
  assert.equal(short.retryJobId, null); assert.match(short.sentence, /^Paused: waiting for more writing allowance this month\./);
  // Unknown facts never earn the button.
  const unknown = writingStatus(brand(), null, BRIEF, [job(ALLOWANCE)], facts({ profile: null }));
  assert.equal(unknown.retryJobId, null);
  for (const s of [paused, unconfirmed, noService, short, unknown]) assert.doesNotMatch(s.sentence, /There is enough now|[–—]/);
});

test('4. the waiting sentence says it starts again by itself, only when a whole article can fit and writing is not paused', () => {
  const later = writingStatus(brand({ budgets: { ...fx.brand.settings.budgets, modelTokensPerMonth: 100_000 } }), null, BRIEF, [job(ALLOWANCE)], facts({ usage: { model_tokens: 90_000, search_calls: 0, images: 0 } }));
  assert.equal(later.sentence, 'Paused: waiting for more writing allowance this month. It starts again by itself when next month’s allowance begins, if not before.');
  const never = writingStatus(brand({ budgets: { ...fx.brand.settings.budgets, modelTokensPerMonth: USAGE_ESTIMATES.article - 1 } }), null, BRIEF, [job(ALLOWANCE)], facts());
  assert.equal(never.sentence, 'Paused: waiting for more writing allowance this month.', 'a month can never fit one article: no promise');
  const zero = writingStatus(brand({ budgets: { ...fx.brand.settings.budgets, modelTokensPerMonth: 0 } }), null, BRIEF, [job(ALLOWANCE)], facts());
  assert.doesNotMatch(zero.sentence, /by itself/);
});

/** A business whose first write stopped for the allowance (as in seo-blog-allowance-resume.test.ts). */
async function stopped() {
  const f = await websiteFixture('content_api', undefined, async (h, brandId) => {
    const b = await h.engine.getBrand(OWNER, brandId);
    await h.engine.updateSettings(OWNER, brandId, b.rowVersion, { budgets: { ...b.settings.budgets, modelTokensPerMonth: 100_000 } });
    const used = await h.engine.usage(OWNER, brandId);
    await h.store.recordUsage({ brandId, kind: 'model_tokens', amount: Math.max(0, 90_000 - used.model_tokens), at: h.clock.now(), reference: 'fixture' });
  });
  const write = async () => (await f.h.store.listJobs(f.brand.id)).find((j) => j.kind === 'write' && !j.payload.fromVersionId)!;
  assert.equal((await write()).state, 'blocked');
  return { f, write };
}
const wakes = async (f: Awaited<ReturnType<typeof websiteFixture>>) => (await f.h.store.listJobs(f.brand.id)).filter((j) => j.kind === 'daily' && j.payload.allowanceWake === true).map((j) => j.idempotencyKey).sort();

test('2. a business paused (or with unconfirmed details) at the turn of the month keeps a wake-up for the next month', async () => {
  const { f } = await stopped();
  assert.deepEqual(await wakes(f), ['allowance-wake:2026-12']);
  const b = (await f.h.store.getBrand(f.brand.id))!;
  await f.h.store.updateBrand({ ...b, settings: { ...b.settings, pauseAll: true } });
  f.h.clock.set('2026-12-01T00:00:01Z');
  await f.h.engine.tick('w');
  assert.deepEqual(await wakes(f), ['allowance-wake:2026-12', 'allowance-wake:2027-01'], 'the skipped month renews its wake-up');
  assert.equal((await f.h.store.listJobs(f.brand.id)).find((j) => j.kind === 'write')!.state, 'blocked', 'still nothing written while paused');
  // Unpaused by January: the wake writes it, by itself.
  const b2 = (await f.h.store.getBrand(f.brand.id))!;
  await f.h.store.updateBrand({ ...b2, settings: { ...b2.settings, pauseAll: false } });
  f.h.clock.set('2027-01-01T00:00:01Z');
  await f.h.engine.tick('w'); await f.h.engine.tick('w');
  const [detail] = await f.h.engine.listArticles(OWNER, f.brand.id);
  assert.ok(detail!.article.currentVersionId, 'written in the new month');
});

test('3. the resume and the pages find a waiting write that is older than the newest tasks', async () => {
  const { f, write } = await stopped();
  const waiting = await write();
  // A store whose task list holds only the newest few (as PostgreSQL returns only the newest 200).
  const store = f.h.store;
  const capped = new Proxy(store, { get(target, key, receiver) {
    if (key === 'listJobs') return async (brandId: string) => (await target.listJobs(brandId)).filter((j) => j.id !== waiting.id);
    const v = Reflect.get(target, key, receiver); return typeof v === 'function' ? v.bind(target) : v;
  } });
  const engine = new SeoBlogEngine({ ...(f.h.engine as unknown as { deps: ConstructorParameters<typeof SeoBlogEngine>[0] }).deps, store: capped });
  assert.ok((await engine.listJobs(OWNER, f.brand.id)).some((j) => j.id === waiting.id), 'the page sees it');
  const b = (await f.h.store.getBrand(f.brand.id))!;
  await f.h.store.updateBrand({ ...b, settings: { ...b.settings, budgets: { ...b.settings.budgets, modelTokensPerMonth: 1_000_000 } } });
  assert.equal(await engine.resumeAllowanceBlockedWrites(OWNER, f.brand.id), 1, 'the resume finds it');
  assert.equal((await write()).state, 'queued');
});
