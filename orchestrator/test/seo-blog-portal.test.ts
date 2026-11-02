import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleSeoBlog } from '../src/portal/seo-blog-router.js';
import { portalCsrfToken } from '../src/portal/session.js';
import type { PortalSeoBlogService } from '../src/portal/seo-blog-service.js';
import type { PortalSessionIdentity } from '../src/portal/auth-service.js';
import { harness, OWNER, STRANGER, seedBrandSite } from './seo-blog-fixtures.js';

const SECRET = 's'.repeat(48);

test('profile issues are individually editable and explicitly resolved under the exact version without generation or lost sources', async () => {
  const h = harness();
  const { brand } = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name: 'Harbour', website: 'https://harbour.example' });
  await h.engine.updateSettings(OWNER, brand.id, brand.rowVersion, { budgets: { modelTokensPerMonth: 1_000_000, searchCallsPerMonth: 0, imagesPerMonth: 0 } });
  const doc = await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'Current offers', pastedText: 'Harbour Compliance Plan costs £49 per month.' });
  const extracted = await h.engine.extractBrandProfile(OWNER, brand.id);
  const withIssues = await h.engine.editProfile(OWNER, brand.id, extracted.version, {
    conflicts: [
      { field: 'Offer', detail: 'Different offer terms', documentIds: [doc.id] },
      { field: 'Service area', detail: 'Conflicting areas', documentIds: [doc.id] },
    ], missingFacts: ['No named author', 'No stated contact route'],
  });
  const original = await h.engine.confirmProfile(OWNER, brand.id, withIssues.version);
  const knowledge = await h.engine.listKnowledge(OWNER, brand.id);
  const calls = h.llm.calls.length;
  const usage = await h.engine.usage(OWNER, brand.id);
  const service: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => h.engine, socialCallback: async () => null };
  const who = identity(OWNER.userId); const csrf = portalCsrfToken(SECRET, who.sessionToken);
  const path = `/portal/seo-blog/b/${brand.id}/profile/edit`;
  const fields = { _csrf: csrf, version: String(original.version), summary: original.summary, positioning: original.positioning,
    audiences: original.audiences.join('\n'), approvedClaims: original.approvedClaims.join('\n'), exclusions: original.exclusions.join('\n'), voiceDont: original.voice.dont.join('\n') };
  const setup = await call(service, who, 'GET', `/portal/seo-blog/b/${brand.id}/setup`);
  assert.match(setup.body, /name="conflict_0_field" value="Offer"/);
  assert.match(setup.body, /name="conflict_1_detail"/); assert.match(setup.body, /name="missingFact_0_text"/);
  assert.match(setup.body, /Source documents: Current offers/);
  assert.doesNotMatch(setup.body, /name="(?:conflict|missingFact)_\d+_resolved"[^>]*checked/);

  // Blank edits and foreign indices cannot quietly erase an issue or create a version.
  const invalidIssues: Record<string, string>[] = [{ conflict_0_detail: ' ' }, { conflict_99_resolved: '1' }, { missingFact_99_text: 'invented' }, { conflict_0_documentIds: 'replacement' }];
  for (const extra of invalidIssues) {
    const result = await call(service, who, 'POST', path, { ...fields, ...extra });
    assert.ok(new URL(result.headers.location!, 'https://x').searchParams.has('e'));
    assert.equal((await h.engine.getProfile(OWNER, brand.id))!.version, original.version);
  }
  const saved = await call(service, who, 'POST', path, { ...fields, conflict_0_resolved: '1', conflict_1_detail: 'Owner checked: service is nationwide', missingFact_0_text: 'Owner will supply the author biography' });
  assert.ok(new URL(saved.headers.location!, 'https://x').searchParams.has('n'));
  const edited = (await h.engine.getProfile(OWNER, brand.id))!;
  assert.equal(edited.version, original.version + 1); assert.equal(edited.source, 'owner_edited');
  assert.equal(edited.confirmedAt, null); assert.equal(edited.confirmedBy, null);
  assert.deepEqual(edited.conflicts, [{ ...original.conflicts[1]!, detail: 'Owner checked: service is nationwide' }]);
  assert.deepEqual(edited.missingFacts, ['Owner will supply the author biography', original.missingFacts[1]]);
  assert.deepEqual(edited.knowledge, original.knowledge); assert.deepEqual(edited.offers, original.offers);
  assert.equal(original.conflicts.length, 2); assert.ok(original.confirmedAt);
  assert.deepEqual(await h.engine.listKnowledge(OWNER, brand.id), knowledge);
  assert.equal(h.llm.calls.length, calls); assert.deepEqual(await h.engine.usage(OWNER, brand.id), usage);

  // A stale form cannot reinterpret an index from the old profile against the new one.
  const stale = await call(service, who, 'POST', path, { ...fields, conflict_0_resolved: '1' });
  assert.ok(new URL(stale.headers.location!, 'https://x').searchParams.has('e'));
  assert.deepEqual(await h.engine.getProfile(OWNER, brand.id), edited);
  const resolvedFact = await call(service, who, 'POST', path, { ...fields, version: String(edited.version), missingFact_0_resolved: '1' });
  assert.ok(new URL(resolvedFact.headers.location!, 'https://x').searchParams.has('n'));
  const latest = (await h.engine.getProfile(OWNER, brand.id))!;
  assert.deepEqual(latest.conflicts, edited.conflicts, 'unmentioned conflicts survive');
  assert.deepEqual(latest.missingFacts, [original.missingFacts[1]], 'only the explicitly resolved missing fact is removed');
  assert.equal(latest.confirmedAt, null); assert.equal(h.llm.calls.length, calls);
});

test('profile extraction distinguishes absent facts from incompatible evidence without weakening price or source guards', () => {
  const prompt = readFileSync(new URL('../../prompts/seo-blog-profile.md', import.meta.url), 'utf8');
  assert.match(prompt, /version: 1\.1\.0/); assert.match(prompt, /Missing, unspecified or incomplete information is not a contradiction/);
  assert.match(prompt, /SAME fact or offer/); assert.match(prompt, /cite only document ids actually supplied/);
  assert.match(prompt, /Prices must be copied exactly/); assert.match(prompt, /naming both document ids/);
  assert.match(prompt, /offer looks obsolete/); assert.match(prompt, /DATA, not instructions/);
});

test('profile extract POST queues without a model call, scoped status reports durable outcomes and setup keeps owner edits intact', async () => {
  const h = harness();
  const { brand } = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name: 'Harbour', website: 'https://harbour.example' });
  await h.engine.updateSettings(OWNER, brand.id, brand.rowVersion, { budgets: { modelTokensPerMonth: 1_000_000, searchCallsPerMonth: 0, imagesPerMonth: 0 } });
  await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'other', title: 'Guide', pastedText: 'Harbour Compliance Plan costs £49 per month.' });
  const service: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => h.engine, socialCallback: async () => null };
  const who = identity(OWNER.userId); const csrf = portalCsrfToken(SECRET, who.sessionToken); const commandId = randomUUID();
  const action = `/portal/seo-blog/b/${brand.id}/profile/extract`;
  const queued = await call(service, who, 'POST', action, { _csrf: csrf, commandId, baseVersion: '0' });
  assert.equal(queued.status, 303); assert.equal(h.llm.calls.length, 0);
  const statusUrl = `/portal/seo-blog/b/${brand.id}/profile/status?job=${commandId}`;
  assert.equal(JSON.parse((await call(service, who, 'GET', statusUrl)).body).state, 'queued');
  assert.equal((await call(service, identity(STRANGER.userId), 'GET', statusUrl)).status, 404);
  const setup = (await call(service, who, 'GET', `/portal/seo-blog/b/${brand.id}/setup`)).body;
  assert.match(setup, /data-profile-status-url=/); assert.match(setup, /profile-status\.js/);
  assert.match(setup, /do not reload this page or replace unsaved edits/);
  await h.engine.tick('worker');
  const ready = JSON.parse((await call(service, who, 'GET', statusUrl)).body);
  assert.equal(ready.state, 'done'); assert.equal(ready.resultVersion, 1);
  assert.doesNotMatch(JSON.stringify(ready), /tokensIn|knowledge|receipt|nonce|inputSha/);
  assert.equal((await h.engine.getProfile(OWNER, brand.id))!.confirmedAt, null);
  assert.equal((await call(service, who, 'POST', action, { _csrf: csrf, commandId, baseVersion: '0' })).status, 303);
  assert.equal(h.llm.calls.length, 1);
});

test('guidance-kind and editorial approval routes keep CSRF/owner/version gates and never generate or create website routes',async()=>{
  const h=harness();seedBrandSite(h.web,'https://harbour.example','deposits');
  const {brand}=await h.engine.createBrand(OWNER,{commandId:randomUUID(),name:'Harbour',website:'https://harbour.example'});
  const doc=await h.engine.uploadKnowledge(OWNER,brand.id,{category:'brand_guidelines',title:'Product Facts',pastedText:'Source facts for this brand.'});
  const inventory=await h.engine.refreshInventory(brand.id);
  const destination=await h.engine.connectDestination(OWNER,brand.id,{type:'github_static',label:'Site',credential:'gh-token-fixture',config:{repository:'acme/site',branch:'main',publicBaseUrl:'https://harbour.example',blogPath:'blog',sitemapPath:'sitemap.xml'}});
  const service:PortalSeoBlogService={generation:'live',research:'live',social:'unavailable',engineFor:()=>h.engine,socialCallback:async()=>null};
  const who=identity(OWNER.userId),csrf=portalCsrfToken(SECRET,who.sessionToken);
  const category=`/portal/seo-blog/b/${brand.id}/knowledge/${doc.id}/category`;
  const expired=await call(service,who,'POST',category,{version:'1',category:'product_facts'});assert.ok(new URL(expired.headers.location!,'https://x').searchParams.has('e'));assert.equal((await h.engine.listKnowledge(OWNER,brand.id)).length,1);
  assert.equal((await call(service,who,'POST',category,{_csrf:csrf,version:'1',category:'product_facts'})).status,303);
  assert.equal((await h.engine.listKnowledge(OWNER,brand.id)).length,2);assert.equal(h.llm.calls.length,0);
  const b=await h.engine.getBrand(OWNER,brand.id);const c=inventory.editorial!.categories[0]!;
  const form={_csrf:csrf,rowVersion:String(b.rowVersion),scanId:inventory.editorial!.scanId,scanSha:inventory.editorial!.scanSha,destinationId:destination.id,root:'/blog',category_0_id:c.id,category_0_include:'1',category_0_label:'Owner guides',category_0_slug:'owner-guides'};
  const route=`/portal/seo-blog/b/${brand.id}/editorial/approve`;
  const foreign=identity(STRANGER.userId);assert.equal((await call(service,foreign,'POST',route,{...form,_csrf:portalCsrfToken(SECRET,foreign.sessionToken)})).status,404);
  const approved=await call(service,who,'POST',route,form);assert.ok(new URL(approved.headers.location!,'https://x').searchParams.has('n'));
  const saved=(await h.engine.getBrand(OWNER,brand.id)).settings.programme!.structure!;assert.equal(saved.categories[0]!.label,'Owner guides');assert.equal(saved.root,'/blog');
  const stale=await call(service,who,'POST',route,form);assert.ok(new URL(stale.headers.location!,'https://x').searchParams.has('e'));
  assert.deepEqual((await h.engine.getBrand(OWNER,brand.id)).settings.programme!.structure,saved);
  const page=(await call(service,who,'GET',`/portal/seo-blog/b/${brand.id}/setup`)).body;assert.match(page,/replaced version retained/);assert.match(page,/Approved guidance · version 1/);
  assert.equal(h.llm.calls.length,0);assert.equal(h.github.commits.size,1);assert.equal(await h.engine.getProfile(OWNER,brand.id),null);
});

function identity(userId: string): PortalSessionIdentity {
  return { sessionToken: `token-${userId}`, userId, workspaceId: '33333333-3333-4333-8333-333333333333', userEmail: 'owner@example.test' };
}

async function call(service: PortalSeoBlogService, who: PortalSessionIdentity | null, method: string, path: string, form?: Record<string, string | string[]>, extraHeaders: Record<string, string> = {}) {
  const body = form ? new URLSearchParams(Object.entries(form).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]))).toString() : '';
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, { method, url: path, headers: { host: 'portal.example', ...(form ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body)), origin: 'https://portal.example' } : {}), ...extraHeaders } });
  (req as PassThrough).end(body);
  let status = 0; let headers: Record<string, string> = {}; let out = '';
  const res = {
    writeHead(s: number, h: Record<string, string>) { status = s; headers = h; return res; },
    end(chunk?: string) { if (chunk) out += chunk; },
  } as unknown as ServerResponse;
  await handleSeoBlog(req, res, new URL(path, 'https://portal.example'), { service, identity: who, requestId: `r-${randomUUID()}`, sessionSecret: SECRET, vaultReady: true });
  return { status, headers, body: out };
}

test('owner screens: add brand, switch, every tab renders, CSRF and foreign access are enforced', async () => {
  const h = harness();
  const service: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => h.engine, socialCallback: async () => null };
  const owner = identity(OWNER.userId);
  const csrf = portalCsrfToken(SECRET, owner.sessionToken);

  assert.equal((await call(service, null, 'GET', '/portal/seo-blog')).status, 303, 'signed-out users go to login');
  const feedback = await call(service, null, 'GET', '/portal/seo-blog/action-feedback.js');
  assert.equal(feedback.status, 200); assert.match(feedback.headers['content-type']!, /javascript/); assert.equal(feedback.headers['x-content-type-options'], 'nosniff');
  const home = await call(service, owner, 'GET', '/portal/seo-blog');
  assert.equal(home.status, 200);
  assert.match(home.body, /Add brand/);
  assert.match(home.headers['content-security-policy']!, /script-src 'self'/);

  const commandId = randomUUID();
  const noCsrf = await call(service, owner, 'POST', '/portal/seo-blog/brands', { commandId, name: 'Harbour <b>Lettings</b>', website: 'harbour.example' });
  assert.equal(noCsrf.status, 403);
  const crossSite = await call(service, owner, 'POST', '/portal/seo-blog/brands', { _csrf: csrf, commandId, name: 'X', website: '' }, { origin: 'https://evil.example' });
  assert.equal(crossSite.status, 403);
  const created = await call(service, owner, 'POST', '/portal/seo-blog/brands', { _csrf: csrf, commandId, name: 'Harbour <b>Lettings</b>', website: 'harbour.example' });
  assert.equal(created.status, 303);
  const location = created.headers.location!;
  assert.match(location, /^\/portal\/seo-blog\/b\/[0-9a-f-]{36}\/setup\?n=/);
  const brandId = /\/b\/([0-9a-f-]{36})\//.exec(location)![1]!;
  const retry = await call(service, owner, 'POST', '/portal/seo-blog/brands', { _csrf: csrf, commandId, name: 'Harbour <b>Lettings</b>', website: 'harbour.example' });
  assert.equal(/\/b\/([0-9a-f-]{36})\//.exec(retry.headers.location!)![1], brandId, 'retrying the same form does not duplicate');
  assert.equal((await h.engine.listBrands(OWNER)).length, 1);

  const setup = await call(service, owner, 'GET', location);
  assert.equal(setup.status, 200);
  assert.match(setup.body, /role="status">Harbour &lt;b&gt;Lettings&lt;\/b&gt; created/);
  assert.ok(!setup.body.includes('<b>Lettings</b>'), 'brand names are escaped everywhere');
  assert.match(setup.body, /enctype="multipart\/form-data"/);
  assert.match(setup.body, /Static website in a GitHub repository/);
  assert.match(setup.body, /Website content API/);
  assert.match(setup.body, /Writing allowance not configured/);
  assert.match(setup.body, /Used 0 · Monthly ceiling 0 · Remaining 0/);
  assert.ok(setup.body.includes(`/b/${brandId}/publishing#writing-budget`));
  // A forged notice is not displayed.
  const forged = await call(service, owner, 'GET', `/portal/seo-blog/b/${brandId}/setup?n=${Buffer.from('Your account is suspended').toString('base64url')}&s=bad`);
  assert.ok(!forged.body.includes('suspended'));

  // Seed a ready brand with content, then render every tab.
  seedBrandSite(h.web, 'https://harbour.example', 'deposits');
  const b = await h.engine.getBrand(OWNER, brandId);
  await h.engine.updateSettings(OWNER, brandId, b.rowVersion, { budgets: { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 } });
  await h.engine.uploadKnowledge(OWNER, brandId, { category: 'product_facts', title: 'Plans', pastedText: 'Harbour Compliance Plan costs £49 per month.' });
  const p = await h.engine.extractBrandProfile(OWNER, brandId);
  await h.engine.confirmProfile(OWNER, brandId, p.version);
  const plan = await call(service, owner, 'POST', `/portal/seo-blog/b/${brandId}/plan`, { _csrf: csrf, commandId: randomUUID(), focus: '', excluded: '', sourceArticleUrl: '' });
  assert.equal(plan.status, 303);
  await h.engine.tick('w');
  const topics = await call(service, owner, 'GET', `/portal/seo-blog/b/${brandId}/topics`);
  assert.match(topics.body, /Tenancy deposit protection/);
  assert.match(topics.body, /Qualitative/);
  assert.match(topics.body, /Update existing page/);
  const { plans } = { plans: await h.engine.listPlans(OWNER, brandId) };
  const ids = plans[0]!.briefs.filter((x) => x.status === 'planned').slice(0, 2).map((x) => x.id);
  const gen = await call(service, owner, 'POST', `/portal/seo-blog/b/${brandId}/generate`, { _csrf: csrf, brief: ids });
  assert.equal(gen.status, 303, gen.body);
  await h.engine.tick('w');
  const articles = await h.engine.listArticles(OWNER, brandId);
  assert.equal(articles.length, 2);
  const articleId = articles[0]!.article.id;
  for (const tab of ['overview', 'setup', 'topics', 'articles', `articles/${articleId}`, 'calendar', 'calendar?view=week', 'calendar?view=list', 'publishing', 'activity']) {
    const page = await call(service, owner, 'GET', `/portal/seo-blog/b/${brandId}/${tab}`);
    assert.equal(page.status, 200, tab);
    assert.ok(!/[0-9a-f]{64}/.test(page.body.replace(/value="[^"]*"/g, '')), `${tab}: no raw hashes on screen`);
  }
  const preview = await call(service, owner, 'GET', `/portal/seo-blog/b/${brandId}/articles/${articleId}/preview`);
  assert.match(preview.headers['content-security-policy']!, /default-src 'none'/);
  assert.match(preview.body, /noindex/);
  const md = await call(service, owner, 'GET', `/portal/seo-blog/b/${brandId}/articles/${articleId}/export?format=markdown`);
  assert.match(md.headers['content-disposition']!, /attachment; filename=".+\.md"/);
  assert.match(md.body, /^---\ntitle:/);

  // Keyboard/form scheduling path and the editor's section regeneration.
  const editor = await h.engine.getArticle(OWNER, brandId, articleId);
  const regen = await call(service, owner, 'POST', `/portal/seo-blog/b/${brandId}/articles/${articleId}/regenerate-section`, { _csrf: csrf, versionId: editor.version!.id, sectionId: editor.version!.body.sections[1]!.id, instruction: 'Simpler' });
  assert.equal(regen.status, 303);
  assert.match(Buffer.from(new URL(regen.headers.location!, 'https://x').searchParams.get('n')!, 'base64url').toString(), /Other sections are unchanged/);

  // Foreign access: another signed-in user sees "not found", never the brand.
  const stranger = identity(STRANGER.userId);
  const foreign = await call(service, stranger, 'GET', `/portal/seo-blog/b/${brandId}/overview`);
  assert.equal(foreign.status, 404);
  assert.ok(!foreign.body.includes('Harbour'));

  // Optional: write the rendered screens for screenshot evidence.
  const dir = process.env.SEO_BLOG_SNAPSHOT_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    for (const [name, path] of [['brands', '/portal/seo-blog'], ['overview', `/portal/seo-blog/b/${brandId}/overview`], ['setup', `/portal/seo-blog/b/${brandId}/setup`], ['topics', `/portal/seo-blog/b/${brandId}/topics`], ['editor', `/portal/seo-blog/b/${brandId}/articles/${articleId}`], ['calendar', `/portal/seo-blog/b/${brandId}/calendar?date=2026-11-01`], ['publishing', `/portal/seo-blog/b/${brandId}/publishing`], ['preview', `/portal/seo-blog/b/${brandId}/articles/${articleId}/preview`]] as const) {
      writeFileSync(`${dir}/${name}.html`, (await call(service, owner, 'GET', path)).body);
    }
  }
});
