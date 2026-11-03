import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createArticleCampaign, currentCampaignRevision, fallbackCampaignDrafts } from '../src/seo-blog/campaign.js';
import { SeoBlogCampaignService } from '../src/seo-blog/campaign-service.js';
import type { Article, ArticleBody, ArticleVersion } from '../src/seo-blog/types.js';
import { harness, OWNER, STRANGER } from './seo-blog-fixtures.js';

import { campaignFixture as fixture } from './seo-blog-campaign-fixtures.js';

test('native campaign edit changes only one immutable post revision; controls do not change reviewed bytes', async () => {
  const { h, brand, article, version, service } = await fixture();
  const v = article.campaign!.variants[0]!, selection = { variantId: v.id, revisionId: v.currentRevisionId };
  const next = await service.edit(OWNER.userId, brand.id, article.id, version.id, selection, { title: 'An owner perspective', copy: 'A considered practical perspective from the exact source guide.', artworkInstructions: 'A calm editorial illustration without fabricated evidence.' });
  assert.equal(next.currentVersionId, version.id); assert.equal(next.campaign!.variants[0]!.revisions.length, 2);
  assert.deepEqual(next.campaign!.variants[1], article.campaign!.variants[1]);
  const edited = next.campaign!.variants[0]!, before = currentCampaignRevision(edited);
  const controlled = await service.control(OWNER.userId, brand.id, article.id, version.id, { variantId: v.id, revisionId: edited.currentRevisionId }, { kind: 'pin', localDate: '2026-11-05', localTime: '14:00' });
  assert.deepEqual(currentCampaignRevision(controlled.campaign!.variants[0]!), before);
  assert.equal(h.llm.calls.length, 0);
  await assert.rejects(service.edit(OWNER.userId, brand.id, article.id, version.id, selection, { title: 'Stale edit', copy: 'This stale edit must not overwrite anything.', artworkInstructions: 'Plain illustration.' }), /changed/);
  await assert.rejects(service.control(STRANGER.userId, brand.id, article.id, version.id, selection, { kind: 'omit', omitted: true }), /cannot manage/);
});
test('explicit rebase preserves owner text/pins/omissions and history while renewing parent-bound revisions', async () => {
  const { h, brand, article, version, service } = await fixture();
  const first = article.campaign!.variants[0]!, selection = { variantId: first.id, revisionId: first.currentRevisionId };
  await service.control(OWNER.userId, brand.id, article.id, version.id, selection, { kind: 'omit', omitted: true });
  const newVersion = { ...version, id: randomUUID(), number: 2, contentSha: 'c'.repeat(64), parentVersionId: version.id };
  await h.store.addVersion(newVersion); const stored = (await h.store.getArticle(brand.id, article.id))!;
  await h.store.updateArticle({ ...stored, currentVersionId: newVersion.id });
  const rebased = await service.rebase(OWNER.userId, brand.id, article.id, newVersion.id);
  const after = rebased.campaign!.variants[0]!;
  assert.equal(after.omitted, true); assert.equal(after.revisions.length, 2); assert.deepEqual(after.revisions[0], first.revisions[0]);
  assert.equal(currentCampaignRevision(after).copy, currentCampaignRevision(first).copy);
  assert.equal(currentCampaignRevision(after).articleVersionId, newVersion.id); assert.equal(after.approval, null);
  assert.equal(h.llm.calls.length, 0);
});
