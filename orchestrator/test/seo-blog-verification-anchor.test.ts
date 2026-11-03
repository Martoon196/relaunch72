import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { websiteFixture } from './seo-blog-website-fixtures.js';
import { OWNER } from './seo-blog-fixtures.js';
import { campaignDateProposal } from '../src/seo-blog/campaign.js';

async function published() {
  const f = await websiteFixture('github_static');
  let detail = await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId);
  await f.h.engine.approve(OWNER, f.brand.id, f.articleId, detail.version!.id);
  detail = await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId);
  await f.h.engine.schedule(OWNER, f.brand.id, f.articleId, detail.article.rowVersion, { localDate: '2026-11-03', localTime: '09:00', destinationId: f.destination.id });
  f.h.clock.set('2026-11-03T09:00:01.123Z'); await f.h.engine.tick('anchor-publish');
  const publication = (await f.h.store.listPublications(f.brand.id, f.articleId))[0]!;
  assert.equal(publication.state, 'published'); assert.equal(publication.firstVerifiedAt, f.h.clock.now());
  return { ...f, publication };
}
test('real engine publish/reobserve keeps first independent verification and relative slot immutable while latest observation advances', async () => {
  const f = await published();
  const article = (await f.h.store.getArticle(f.brand.id, f.articleId))!, variant = article.campaign!.variants.find(v => v.network === 'linkedin' && v.angle === 'takeaway')!;
  const before = campaignDateProposal(variant, f.publication.firstVerifiedAt!, f.h.clock.now(), 'Europe/London');
  f.h.clock.advance(10 * 60_000); const writes = f.h.github.refPatches;
  await f.h.engine.reobservePublication(OWNER, f.brand.id, f.articleId, f.publication.id);
  let current = (await f.h.store.listPublications(f.brand.id, f.articleId))[0]!;
  assert.equal(current.firstVerifiedAt, f.publication.firstVerifiedAt); assert.notEqual(current.verifiedAt, f.publication.verifiedAt);
  assert.deepEqual(campaignDateProposal(variant, current.firstVerifiedAt!, f.h.clock.now(), 'Europe/London'), before);
  assert.equal(f.h.github.refPatches, writes, 'read-only observation never republishes to preserve a date');
  current = await f.h.store.updatePublication({ ...current, firstVerifiedAt: '2040-01-01T00:00:00.000Z' });
  assert.equal(current.firstVerifiedAt, f.publication.firstVerifiedAt, 'store rejects an attempted implicit rebase by retaining the original latch');
});
test('legacy verified history without stable first anchor stays explicitly unknown after repeated successful observation', async () => {
  const f = await published(), { firstVerifiedAt: _original, ...record } = f.publication;
  const legacy = { ...record, id: randomUUID(), idempotencyKey: `legacy-anchor:${randomUUID()}`, rowVersion: 1 };
  await f.h.store.insertPublication(legacy); f.h.clock.advance(60_000);
  await f.h.engine.reobservePublication(OWNER, f.brand.id, f.articleId, legacy.id);
  let current = (await f.h.store.listPublications(f.brand.id, f.articleId)).find(p => p.id === legacy.id)!;
  assert.equal(current.firstVerifiedAt, null);
  f.h.clock.advance(60_000); await f.h.engine.reobservePublication(OWNER, f.brand.id, f.articleId, legacy.id);
  current = (await f.h.store.listPublications(f.brand.id, f.articleId)).find(p => p.id === legacy.id)!;
  assert.equal(current.firstVerifiedAt, null, 'a later genuine observation is never relabelled the original event');
});
