import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { publicationMediaEffectBoundary } from '../src/seo-blog/media-publication.js';
import { SeoBlogError, type Publication } from '../src/seo-blog/types.js';
import { sha256 } from '../src/seo-blog/engine.js';
import { websiteFixture } from './seo-blog-website-fixtures.js';
import { OWNER } from './seo-blog-fixtures.js';

test('media boundary translates only its scoped55000; unrelated database or transport errors keep their identity', async () => {
  await assert.rejects(publicationMediaEffectBoundary(async () => { throw Object.assign(Error('Private SQL details must not reach the UI'), { code: '55000' }); }),
    (error: unknown) => error instanceof SeoBlogError && error.code === 'media_effect_held' && error.status === 409 && !error.message.includes('Private SQL'));
  for (const code of ['42501', '40001', '08006']) {
    const original = Object.assign(Error('Synthetic unrelated failure'), { code });
    await assert.rejects(publicationMediaEffectBoundary(async () => { throw original; }), error => error === original);
  }
});
test('fresh media guard rejection holds the unchanged due article without sending; races preserve newer owner state and unknown operation', async () => {
  for (const scenario of ['unchanged', 'draft', 'schedule', 'owner_hold', 'new_operation', 'unknown_receipt'] as const) {
    const f = await websiteFixture('github_static'); let detail = await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId);
    await f.h.engine.approve(OWNER, f.brand.id, f.articleId, detail.version!.id); detail = await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId);
    await f.h.engine.schedule(OWNER, f.brand.id, f.articleId, detail.article.rowVersion, { localDate: '2026-11-03', localTime: '09:00', destinationId: f.destination.id });
    f.h.clock.set('2026-11-03T09:00:01.000Z');
    const normal = f.h.store.beginPublication.bind(f.h.store), capture = { publication: null as Publication | null }; let mutated = false;
    f.h.store.beginPublication = async input => {
      try { return await normal({ ...input, decide: snapshot => {
        const decision = input.decide(snapshot);
        if (decision.kind === 'begin') { capture.publication = decision.publication; throw new SeoBlogError(409, 'Image use needs review. Synthetic current eligibility changed.', 'media_effect_held'); }
        return decision;
      } }); } catch (error) {
        if (!(error instanceof SeoBlogError) || error.code !== 'media_effect_held' || mutated) throw error;
        mutated = true; const article = (await f.h.store.getArticle(f.brand.id, f.articleId))!;
        if (scenario === 'draft') {
          const old = (await f.h.store.getVersion(f.brand.id, article.currentVersionId!))!, body = { ...old.body, title: 'A newer owner draft' };
          const version = { ...old, id: randomUUID(), number: old.number + 1, parentVersionId: old.id, body, contentSha: sha256(body) };
          await f.h.store.addVersion(version); await f.h.store.updateArticle({ ...article, currentVersionId: version.id, approval: null });
        } else if (scenario === 'schedule') await f.h.store.updateArticle({ ...article, schedule: { ...article.schedule!, setAt: '2026-11-03T09:00:01.500Z', publishAtUtc: '2026-11-04T09:00:00.000Z' } });
        else if (scenario === 'owner_hold') await f.h.store.updateArticle({ ...article, hold: { reason: 'owner', detail: 'A newer deliberate owner hold', at: f.h.clock.now() } });
        else if (scenario === 'new_operation' || scenario === 'unknown_receipt') {
          const p = { ...capture.publication!, id: randomUUID(), idempotencyKey: `race:${randomUUID()}`, state: scenario === 'unknown_receipt' ? 'outcome_unknown' as const : 'prepared' as const };
          await f.h.store.insertPublication(p);
          if (scenario === 'new_operation') await f.h.store.updateArticle({ ...article, delivery: 'publishing', deliveryPublicationId: p.id });
          else f.h.github.failReads = true; // Read-only reconcile remains unknown; projection must not touch its receipt.
        }
        throw error;
      }
    };
    const writes = f.h.github.refPatches, result = await f.h.engine.dispatchDue(f.brand.id);
    assert.equal(result.held, 1, scenario); assert.equal(f.h.github.refPatches, writes, `${scenario}: no provider write`);
    const after = (await f.h.store.getArticle(f.brand.id, f.articleId))!;
    if (scenario === 'unchanged') { assert.equal(after.hold?.reason, 'owner'); assert.match(after.hold!.detail, /Image use needs review/); }
    else if (scenario === 'owner_hold') assert.equal(after.hold!.detail, 'A newer deliberate owner hold');
    else assert.equal(after.hold, null, `${scenario}: no new hold projects over the race`);
    if (scenario === 'draft') assert.notEqual(after.currentVersionId, detail.version!.id);
    if (scenario === 'schedule') assert.equal(after.schedule!.publishAtUtc, '2026-11-04T09:00:00.000Z');
    if (scenario === 'unknown_receipt') assert.equal((await f.h.store.listPublications(f.brand.id, f.articleId))[0]!.state, 'outcome_unknown');
  }
});
