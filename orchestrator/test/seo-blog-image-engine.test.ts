import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { automaticImageCommandId, isArticleWriteJob, isImageJob, type ArticleImageService } from '../src/seo-blog/image-campaign.js';
import type { Job } from '../src/seo-blog/types.js';
import { harness, OWNER } from './seo-blog-fixtures.js';

async function task() {
  const h = harness();
  const { brand } = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name: 'Image proof', website: 'https://harbour.example' });
  const job: Job = { id: randomUUID(), brandId: brand.id, kind: 'write', idempotencyKey: `seo-image:${randomUUID()}`, payload: { stage: 'image', requestedBy: OWNER.userId, image: { start: { nonce: randomUUID() } } },
    state: 'running', attempts: 1, maxAttempts: 3, leaseOwner: 'image-proof-worker', leaseExpiresAt: '2026-11-03T16:00:00.000Z', runAfter: h.clock.now(), progress: 'Queued', error: null, createdAt: h.clock.now(), updatedAt: h.clock.now(), rowVersion: 1 };
  return { h, brand, job: (await h.store.enqueueJob(job)).job };
}

test('unknown/unavailable image stage holds without entering article writing or pretending completion', async () => {
  const { h, job } = await task();
  const result = await h.engine.runJob(job);
  assert.equal(result.state, 'blocked'); assert.match(result.error!, /capable image worker/);
  assert.deepEqual(result.payload.image, job.payload.image, 'no durable start metadata is cleared');
  assert.equal(h.llm.calls.length, 0);
  await assert.rejects(h.engine.retryJob(OWNER, job.brandId, job.id), /cannot repeat a paid call/);
});

test('image handler returns atomic held/cancelled outcome directly, without generic done overwrite', async () => {
  const { h, job } = await task(); let calls = 0;
  const images: ArticleImageService = { configured: false, request: async () => { throw new Error('not used'); }, retryPreparation: async () => { throw new Error('not used'); }, run: async claimed => {
    calls++; return h.store.updateJob({ ...claimed, state: 'blocked', leaseOwner: null, leaseExpiresAt: null, progress: 'Known candidate; local preparation needs attention.', error: 'Local preparation unavailable' });
  } };
  const engine = new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, images });
  const result = await engine.runJob(job);
  assert.equal(calls, 1); assert.equal(result.state, 'blocked'); assert.equal((await h.store.getJob(job.brandId, job.id))!.state, 'blocked');
  assert.equal(h.llm.calls.length, 0);
});

test('unavailable image handler does not adopt a replacement worker lease epoch', async () => {
  const { h, job } = await task();
  const replacement = await h.store.updateJob({ ...job, attempts: 2, leaseOwner: job.leaseOwner, progress: 'Reclaimed by a newer epoch' });
  const result = await h.engine.runJob(job);
  assert.equal(result.state, 'running'); assert.equal(result.attempts, 2); assert.equal(result.rowVersion, replacement.rowVersion);
});

test('only unstaged article writes count towards article backlog; image/profile/unknown stages do not', () => {
  for (const stage of ['image', 'profile', 'future']) assert.equal(isArticleWriteJob({ kind: 'write', payload: { stage } }), false);
  assert.equal(isImageJob({ kind: 'write', payload: { stage: 'image' } }), true);
  assert.equal(isImageJob({ kind: 'plan', payload: { stage: 'image' } }), false);
  assert.equal(isArticleWriteJob({ kind: 'write', payload: { briefId: randomUUID() } }), true);
  const article = randomUUID(), version = randomUUID();
  assert.equal(automaticImageCommandId(article, version), automaticImageCommandId(article, version));
  assert.notEqual(automaticImageCommandId(article, version), automaticImageCommandId(article, randomUUID()));
});

test('image opt-in starts absent/off, stamps the genuine owner and preserves allowance/caps', async () => {
  const { h, brand } = await task();
  assert.equal(brand.settings.media?.imageGenerationEnabled ?? false, false);
  const next = await h.engine.updateSettings(OWNER, brand.id, brand.rowVersion, { media: { imageGenerationEnabled: true, authorizedBy: randomUUID(), authorizedAt: '2001-01-01T00:00:00.000Z' } });
  assert.equal(next.settings.media!.authorizedBy, OWNER.userId); assert.equal(next.settings.media!.authorizedAt, h.clock.now());
  assert.deepEqual(next.settings.budgets, brand.settings.budgets);
  assert.equal(next.settings.autoPublish, brand.settings.autoPublish); assert.equal(next.settings.pauseAll, brand.settings.pauseAll);
});

test('ordinary image job DTO omits private prompt, article/profile snapshots and raw receipts without changing the durable job', async () => {
  const { h, job } = await task();
  const saved = await h.store.updateJob({ ...job, payload: { ...job.payload, image: { articleId: randomUUID(), articleVersionId: randomUUID(), intentId: randomUUID(),
    privateCommand: { prompt: 'PRIVATE GENERATOR PROMPT' }, sourceSnapshot: { articleBody: 'PRIVATE BODY', profile: 'PRIVATE PROFILE' }, receipt: { raw: 'PRIVATE RECEIPT' } } } });
  const dto = (await h.engine.listJobs(OWNER, job.brandId))[0]!;
  assert.doesNotMatch(JSON.stringify(dto), /PRIVATE|privateCommand|sourceSnapshot|raw/);
  assert.match(JSON.stringify((await h.store.getJob(job.brandId, saved.id))!), /PRIVATE GENERATOR PROMPT/);
});
