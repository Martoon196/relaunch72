import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { calendarPage } from '../src/portal/seo-blog-view.js';
import { canonicalPromotionApproval, promotionCommand, promotionPublicationHold } from '../src/seo-blog/promotions.js';
import { sha256 } from '../src/seo-blog/engine.js';
import { harness, OWNER, seedBrandSite } from './seo-blog-fixtures.js';

async function written() {
  const h = harness(); seedBrandSite(h.web, 'https://harbour.example', 'deposits');
  let { brand } = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name: 'Harbour', website: 'https://harbour.example' });
  await h.engine.updateSettings(OWNER, brand.id, brand.rowVersion, { budgets: { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 } });
  await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'Plans', filename: 'plans.txt', bytes: Buffer.from('Harbour compliance plan costs £49 per month.') });
  const profile = await h.engine.extractBrandProfile(OWNER, brand.id); await h.engine.confirmProfile(OWNER, brand.id, profile.version);
  const destination = await h.engine.connectDestination(OWNER, brand.id, { type: 'github_static', label: 'Harbour website', credential: 'gh-token-fixture', config: { repository: 'acme/site', branch: 'main', publicBaseUrl: 'https://harbour.example', blogPath: 'blog', sitemapPath: 'sitemap.xml' } });
  assert.equal(destination.status, 'connected');
  await h.engine.requestPlan(OWNER, brand.id, { commandId: randomUUID() }); await h.engine.tick('fixture-worker');
  const [plan] = await h.engine.listPlans(OWNER, brand.id); await h.engine.acceptPlan(OWNER, brand.id, plan!.plan.id);
  const brief = plan!.briefs.find(b => b.role === 'pillar')!; await h.engine.requestArticles(OWNER, brand.id, [brief.id]); await h.engine.tick('fixture-worker');
  const [row] = await h.engine.listArticles(OWNER, brand.id); const detail = await h.engine.getArticle(OWNER, brand.id, row!.article.id);
  brand = await h.engine.getBrand(OWNER, brand.id);
  return { h, brand, brief: (await h.engine.listPlans(OWNER, brand.id))[0]!.briefs.find(b => b.id === brief.id)!, ...detail };
}
test('generated articles automatically carry model promotion drafts and appear at proposed dates without publication schedules', async () => {
  const f = await written(); const { version, article, brand, h } = f;
  assert.ok(version?.promotionPack); assert.equal(version.promotionPack.mode, 'model'); assert.equal(version.promotionPack.posts.length, 2);
  assert.equal(version.promotionPack.brandId, brand.id); assert.equal(version.promotionPack.versionId, version.id); assert.equal(version.promotionPack.contentSha, version.contentSha);
  assert.ok(h.llm.calls.includes('SEO_BLOG_SOCIAL')); assert.equal(article.schedule, null);
  const html = calendarPage({ brands: [brand], brand, tab: 'calendar', csrf: 'fixture', notice: null, error: null }, { view: 'list', anchor: f.brief.suggestedAtUtc!.slice(0,10), articles: [{ article, title: version.body.title, status: 'Needs approval' }], briefs: [f.brief], destinations: [], brandsAll: false });
  assert.match(html, /Proposed/); assert.match(html, /no publication scheduled/i); assert.match(html, /Needs approval/);
  await h.engine.moveProposedDate(OWNER, brand.id, article.id, article.rowVersion, '2026-11-09', '09:30');
  assert.equal((await h.engine.getArticle(OWNER, brand.id, article.id)).article.schedule, null);
});
test('exact canonical promotion provenance is stable; missing URL and non-user approval remain held', async () => {
  const f = await written(); const v = f.version!;
  const command = promotionCommand(f.brand, v, 'linkedin');
  assert.deepEqual(command, promotionCommand(f.brand, v, 'linkedin'));
  assert.equal(command.source.system, 'relaunch72.seo-blog'); assert.match(command.source.version, new RegExp(v.id));
  assert.equal(command.blob.sha256, sha256(command.content)); assert.ok(command.content.includes(v.promotionPack!.canonicalUrl!));
  assert.throws(() => promotionCommand(f.brand, { ...v, promotionPack: { ...v.promotionPack!, canonicalUrl: null } }, 'linkedin'), /final URL/);
  const unused = {} as never;
  const adapter = canonicalPromotionApproval({ context: () => ({ workspaceId: f.brand.id, actorKind: 'worker', requestId: 'fixture' }), drafts: unused, approvals: unused });
  await assert.rejects(adapter.approve(f.brand, f.article, v, 'linkedin'), /owner session/);
  assert.match(promotionPublicationHold(f.article, v, 'linkedin')!, /verified public/);
});
test('article edits stale only the linked old version, keeping other article promotions independent', async () => {
  const f = await written(); const v = f.version!;
  const linked = { articleVersionId: v.id, network: 'linkedin' as const, packSha: sha256(v.promotionPack), contentItemId: randomUUID(), contentVersionId: randomUUID(), approvalDecisionId: randomUUID() };
  const published = { ...f.article, delivery: 'published' as const, publishedVersionId: v.id, publishedUrl: v.promotionPack!.canonicalUrl, linkedPromotions: [linked] };
  assert.equal(promotionPublicationHold(published, v, 'linkedin'), null);
  assert.match(promotionPublicationHold(published, v, 'instagram')!, /approval/);
  const next = await f.h.engine.editArticle(OWNER, f.brand.id, f.article.id, v.id, { title: `${v.body.title} updated` });
  const current = (await f.h.engine.getArticle(OWNER, f.brand.id, f.article.id)).article;
  assert.notEqual(next.id, v.id); assert.equal(current.approval, null);
  assert.match(promotionPublicationHold({ ...current, linkedPromotions: [linked] }, v, 'linkedin')!, /article changed/);
  assert.equal(promotionPublicationHold(published, v, 'linkedin'), null, 'unrelated historical tuple was not mutated');
});
