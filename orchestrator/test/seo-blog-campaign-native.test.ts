import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { campaignPromotionCommand } from '../src/seo-blog/campaign-promotions.js';
import { campaignFixture } from './seo-blog-campaign-fixtures.js';
import { OWNER, STRANGER } from './seo-blog-fixtures.js';
import { nativeCsrf, nativeIdentity, nativeSeoCall } from './seo-blog-native-request.js';

test('native campaign routes preserve genuine owner/CSRF/version fences and social-only edits make no model/provider calls', async () => {
  const f = await campaignFixture(), who = nativeIdentity(OWNER.userId), base = `/portal/seo-blog/b/${f.brand.id}/articles/${f.article.id}`;
  const v = f.article.campaign!.variants[0]!, fields = { _csrf: nativeCsrf(who), versionId: f.version.id, variantId: v.id, revisionId: v.currentRevisionId, title: 'A practical perspective', copy: 'Owner-edited practical context from the saved article.', artworkInstructions: 'Editorial illustration without invented evidence.' };
  const page = await nativeSeoCall(f.h.engine, { who, method: 'GET', path: `${base}/campaign`, applicationName: 'Relaunch72 Content' });
  assert.equal(page.status, 200); assert.match(page.body, /ARTICLE CAMPAIGN/);
  const denied = await nativeSeoCall(f.h.engine, { who, method: 'POST', path: `${base}/campaign-edit`, fields: { ...fields, _csrf: 'wrong' } });
  assert.equal(denied.status, 303); assert.match(denied.headers.location!, /\/campaign\?e=/);
  assert.equal((await f.h.store.getArticle(f.brand.id, f.article.id))!.campaign!.variants[0]!.revisions.length, 1);
  const cross = await nativeSeoCall(f.h.engine, { who, method: 'POST', path: `${base}/campaign-edit`, fields, headers: { origin: 'https://foreign.example' } });
  assert.equal(cross.status, 303); assert.match(cross.headers.location!, /\/campaign\?e=/);
  assert.equal((await f.h.store.getArticle(f.brand.id, f.article.id))!.campaign!.variants[0]!.revisions.length, 1);
  assert.equal((await nativeSeoCall(f.h.engine, { who: nativeIdentity(STRANGER.userId), method: 'GET', path: `${base}/campaign` })).status, 404);
  const saved = await nativeSeoCall(f.h.engine, { who, method: 'POST', path: `${base}/campaign-edit`, fields });
  assert.equal(saved.status, 303); assert.match(saved.headers.location!, /\/campaign\?n=/);
  const current = (await f.h.store.getArticle(f.brand.id, f.article.id))!;
  assert.equal(current.currentVersionId, f.version.id); assert.equal(current.campaign!.variants[0]!.revisions.length, 2);
  assert.deepEqual(current.campaign!.variants[1], f.article.campaign!.variants[1]); assert.equal(f.h.llm.calls.length, 0); assert.equal(f.h.site.posts, 0);
});

test('native selected review returns each confirmed/uncertain/unsupported result independently and reuses committed canonical draft identity', async () => {
  const f = await campaignFixture(), who = nativeIdentity(OWNER.userId), canonical = new Map<string, [string, string]>();
  let failed = false;
  const engine = new SeoBlogEngine({ store: f.h.store, llm: f.h.llm, search: f.h.search, transport: f.h.web, publishers: new Map(), vault: f.h.vault, now: f.h.clock.now,
    campaignReview: { loadImage: async () => { throw Error('No fixture images'); }, authorizeImage: async () => { throw Error('No image use'); }, approval: { async approve(request) {
      const command = campaignPromotionCommand(request), revision = request.variant.revisions.find(r => r.id === request.variant.currentRevisionId)!;
      let ids = canonical.get(revision.id);
      if (!ids) { ids = [randomUUID(), randomUUID()]; canonical.set(revision.id, ids); }
      await request.recordDraft(ids[0], ids[1]);
      if (request.variant.angle === 'takeaway' && !failed) { failed = true; throw Error('Synthetic lost acknowledgement'); }
      return { revisionId: revision.id, revisionSha256: revision.sha256, contentItemId: ids[0], contentVersionId: ids[1], contentSha256: command.blob.sha256,
        approvalRequestId: randomUUID(), approvalDecisionId: randomUUID() };
    } } } });
  const linkedIn = f.article.campaign!.variants.filter(v => v.network === 'linkedin'), instagram = f.article.campaign!.variants[0]!;
  const fields: Record<string, string> = { _csrf: nativeCsrf(who), versionId: f.version.id };
  for (const v of [...linkedIn, instagram]) fields[`approve_${v.id}`] = v.currentRevisionId;
  const path = `/portal/seo-blog/b/${f.brand.id}/articles/${f.article.id}/campaign-approve-selected`;
  const page = await nativeSeoCall(engine, { who, method: 'POST', path, fields, applicationName: 'Relaunch72 Content' });
  assert.equal(page.status, 200); assert.match(page.body, /Your results/); assert.match(page.body, /Approval result not confirmed/); assert.match(page.body, /Instagram needs a real reviewed image crop/);
  const after = (await f.h.store.getArticle(f.brand.id, f.article.id))!;
  assert.equal(after.campaign!.variants.filter(v => v.approval).length, 2); assert.equal(canonical.size, 3);
  const retry = await nativeSeoCall(engine, { who, method: 'POST', path, fields, applicationName: 'Relaunch72 Content' });
  assert.equal(retry.status, 200); assert.equal(canonical.size, 3);
  assert.equal((await f.h.store.getArticle(f.brand.id, f.article.id))!.campaign!.variants.filter(v => v.approval).length, 3);
  assert.equal(f.h.llm.calls.length, 0); assert.equal(f.h.site.posts, 0);
});

test('Authority GET is central-only, genuinely authorised and read-only with truthful setup state', async () => {
  const f = await campaignFixture(), who = nativeIdentity(OWNER.userId), path = `/portal/seo-blog/b/${f.brand.id}/authority`;
  for (const name of [undefined, 'Property Predator', 'Martin Howard Property']) assert.equal((await nativeSeoCall(f.h.engine, { who, method: 'GET', path, applicationName: name })).status, 404);
  assert.equal((await nativeSeoCall(f.h.engine, { who: null, method: 'GET', path, applicationName: 'Relaunch72 Content' })).status, 303);
  assert.equal((await nativeSeoCall(f.h.engine, { who: nativeIdentity(STRANGER.userId), method: 'GET', path, applicationName: 'Relaunch72 Content' })).status, 404);
  const before = await f.h.store.getArticle(f.brand.id, f.article.id);
  const allowed = await nativeSeoCall(f.h.engine, { who, method: 'GET', path, applicationName: 'Relaunch72 Content' });
  assert.equal(allowed.status, 200); assert.match(allowed.body, /Authority programme/); assert.match(allowed.body, new RegExp(`/b/${f.brand.id}/setup#brand-profile`));
  assert.deepEqual(await f.h.store.getArticle(f.brand.id, f.article.id), before); assert.equal(f.h.llm.calls.length, 0); assert.equal(f.h.web.requests.length, 0);
});
