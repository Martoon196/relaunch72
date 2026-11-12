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
import {websiteFixture} from './seo-blog-website-fixtures.js';

const SECRET = 's'.repeat(48);

test('article FAQ corrections save through the normal free editor with legacy-form and malformed-pair protection',async()=>{
 const f=await websiteFixture(),engine=f.h.engine,who=identity(OWNER.userId),csrf=portalCsrfToken(SECRET,who.sessionToken);
 const service:PortalSeoBlogService={generation:'live',research:'live',social:'unavailable',engineFor:()=>engine,socialCallback:async()=>null};
 const base=`/portal/seo-blog/b/${f.brand.id}/articles/${f.articleId}`,before=(await engine.getArticle(OWNER,f.brand.id,f.articleId)).version!,b=before.body,calls=f.h.llm.calls.length,usage=await engine.usage(OWNER,f.brand.id);
 const form={_csrf:csrf,versionId:before.id,title:b.title,slug:b.slug,seoTitle:b.seoTitle,metaDescription:b.metaDescription,excerpt:b.excerpt,intro:b.intro,conclusion:b.conclusion,imageUrl:b.image.url??'',imageAlt:b.image.alt,sectionId:b.sections.map(s=>s.id),sectionHeading:b.sections.map(s=>s.heading),sectionBody:b.sections.map(s=>s.body)};
 const questions=b.faqs.map(f=>f.q),answers=b.faqs.map(f=>f.a);answers[0]='Keep the source and its limitations visible when comparing the evidence.';
 const page=await call(service,who,'GET',base);assert.match(page.body,/name="faqQuestion"/);assert.match(page.body,/name="faqAnswer"/);
 for(const bad of [{faqAnswer:[]},{faqAnswer:['']},{faqQuestion:Array(9).fill('A question?'),faqAnswer:Array(9).fill('A useful answer.')}]){
  const invalidForm=Object.assign({...form,faqEditor:'1',faqQuestion:questions,faqAnswer:answers},bad);const result=await call(service,who,'POST',base+'/edit',invalidForm);assert.ok(new URL(result.headers.location!,'https://x').searchParams.has('e'));assert.equal((await engine.getArticle(OWNER,f.brand.id,f.articleId)).version!.id,before.id);
 }
 const saved=await call(service,who,'POST',base+'/edit',{...form,faqEditor:'1',faqQuestion:questions,faqAnswer:answers});assert.ok(new URL(saved.headers.location!,'https://x').searchParams.has('n'));
 const current=(await engine.getArticle(OWNER,f.brand.id,f.articleId)).version!;assert.equal(current.body.faqs[0]!.a,answers[0]);assert.equal(current.number,before.number+1);
 const legacy=await call(service,who,'POST',base+'/edit',{...form,versionId:current.id,excerpt:'An older editor can still save without overwriting the existing questions.'});assert.ok(new URL(legacy.headers.location!,'https://x').searchParams.has('n'));assert.deepEqual((await engine.getArticle(OWNER,f.brand.id,f.articleId)).version!.body.faqs,current.body.faqs);
 const stale=await call(service,who,'POST',base+'/edit',{...form,faqEditor:'1',faqQuestion:questions,faqAnswer:answers});assert.ok(new URL(stale.headers.location!,'https://x').searchParams.has('e'));
 assert.equal(f.h.llm.calls.length,calls);assert.deepEqual(await engine.usage(OWNER,f.brand.id),usage);assert.equal(f.h.site.posts,0);
});

test('posting draft owner routes save, export and restore versions with CSRF and foreign access protection',async()=>{
  const f=await websiteFixture(),engine=f.h.engine,who=identity(OWNER.userId),csrf=portalCsrfToken(SECRET,who.sessionToken);
  const service:PortalSeoBlogService={generation:'live',research:'live',social:'unavailable',engineFor:()=>engine,socialCallback:async()=>null};
  const base=`/portal/seo-blog/b/${f.brand.id}/articles/${f.articleId}`,before=await engine.getArticle(OWNER,f.brand.id,f.articleId);
  const page=await call(service,who,'GET',base+'/posts');assert.equal(page.status,200);assert.match(page.body,/Copy\/export handoff/);assert.match(page.body,/Substack/);assert.match(page.body,/name="_csrf"/);
  const data=await engine.getPostingDrafts(OWNER,f.brand.id,f.articleId),d=data.drafts.find(x=>x.draft.platform==='substack')!.draft,r=d.revisions[0]!;
  const fields={versionId:data.version.id,rowVersion:String(data.article.rowVersion),draftId:d.id,revisionId:r.id,commandId:randomUUID(),title:r.title,body:r.body+'\nOwner addition.',question:'',targetUrl:'https://publication.example/'};
  for(const denied of [await call(service,who,'POST',base+'/post-save',fields),await call(service,who,'POST',base+'/post-save',{...fields,_csrf:csrf},{origin:'https://evil.example'})]){
    assert.equal(denied.status,303);assert.ok(new URL(denied.headers.location!,'https://portal.example').searchParams.has('e'));
  }
  assert.deepEqual((await engine.getArticle(OWNER,f.brand.id,f.articleId)).article,before.article);
  assert.equal((await call(service,identity(STRANGER.userId),'GET',base+'/posts')).status,404);
  const saved=await call(service,who,'POST',base+'/post-save',{...fields,_csrf:csrf});assert.equal(saved.status,303);const location=new URL(saved.headers.location!,'https://portal.example');assert.ok(location.searchParams.has('n'));assert.equal(location.hash,'#post-'+d.id);
  const exported=await call(service,who,'GET',base+'/post-export?draft='+d.id);assert.equal(exported.status,200);assert.match(exported.body,/Owner addition/);assert.match(exported.headers['content-disposition']!,/substack-post.md/);
  const foreign=await call(service,who,'GET',base+'/post-export?draft='+randomUUID());assert.equal(foreign.status,404);
  const current=await engine.getPostingDrafts(OWNER,f.brand.id,f.articleId),savedDraft=current.drafts.find(x=>x.draft.id===d.id)!.draft;
  const restored=await call(service,who,'POST',base+'/post-restore',{_csrf:csrf,versionId:current.version.id,rowVersion:String(current.article.rowVersion),draftId:d.id,revisionId:savedDraft.currentRevisionId,restoreId:r.id,commandId:randomUUID()});assert.equal(restored.status,303);
  assert.deepEqual((await engine.getArticle(OWNER,f.brand.id,f.articleId)).version,before.version);assert.equal(f.h.site.posts,0);
  assert.equal((await call(service,null,'GET','/portal/seo-blog/posting-drafts.js')).status,200);
});

test('website target routes expose installed roots, preserve CSRF/owner/version gates and never publish or generate on review',async()=>{
  const f=await websiteFixture();const structure=await f.approveStructure();const service:PortalSeoBlogService={generation:'live',research:'live',social:'unavailable',engineFor:()=>f.h.engine,socialCallback:async()=>null};const who=identity(OWNER.userId);const csrf=portalCsrfToken(SECRET,who.sessionToken);
  const setup=await call(service,who,'GET',`/portal/seo-blog/b/${f.brand.id}/setup`);assert.match(setup.body,/<select id="editorial-root" name="root"/);assert.match(setup.body,/<option value="\/investment-info"/);assert.doesNotMatch(setup.body,/Property Predator currently supports/);
  const old=(await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId)).version!;const path=`/portal/seo-blog/b/${f.brand.id}/articles/${f.articleId}/website-target`;const form={_csrf:csrf,versionId:old.id,destinationId:f.destination.id,categoryId:[structure.website!.categories[0]!.id]};const calls=f.h.llm.calls.length;
  const denied=await call(service,who,'POST',path,{...form,_csrf:'wrong'});assert.equal(denied.status,303);assert.ok(new URL(denied.headers.location!,'https://x').searchParams.has('e'));assert.equal((await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId)).version!.id,old.id);const foreign=identity(STRANGER.userId);assert.equal((await call(service,foreign,'POST',path,{...form,_csrf:portalCsrfToken(SECRET,foreign.sessionToken)})).status,404);
  const saved=await call(service,who,'POST',path,form);assert.equal(saved.status,303);assert.ok(new URL(saved.headers.location!,'https://x').searchParams.has('n'));const current=(await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId)).version!;assert.equal(current.number,old.number+1);assert.equal(f.h.llm.calls.length,calls);assert.equal(f.h.site.posts,0);
  const stale=await call(service,who,'POST',path,form);assert.ok(new URL(stale.headers.location!,'https://x').searchParams.has('e'));assert.equal((await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId)).version!.id,current.id);
  const editor=await call(service,who,'GET',`/portal/seo-blog/b/${f.brand.id}/articles/${f.articleId}`);assert.match(editor.body,/Reviewed URL/);assert.match(editor.body,/Save publishing target as a new version/);assert.ok(!editor.body.includes(f.destination.sealedCredential!));
});

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
  assert.match(home.body, /<h1>Your businesses<\/h1>/); assert.match(home.body, /<a class="button" href="#add-business"[^>]*>Add a business<\/a>/);
  assert.match(home.body, /<button type="submit">Add a business<\/button>/); assert.match(home.body, /<label for="name">Business name<\/label>/);
  assert.match(home.headers['content-security-policy']!, /script-src 'self'/);

  const commandId = randomUUID();
  const noCsrf = await call(service, owner, 'POST', '/portal/seo-blog/brands', { commandId, name: 'Harbour <b>Lettings</b>', website: 'harbour.example' });
  assert.equal(noCsrf.status, 403);
  const crossSite = await call(service, owner, 'POST', '/portal/seo-blog/brands', { _csrf: csrf, commandId, name: 'X', website: '' }, { origin: 'https://evil.example' });
  assert.equal(crossSite.status, 403);
  const created = await call(service, owner, 'POST', '/portal/seo-blog/brands', { _csrf: csrf, commandId, name: 'Harbour <b>Lettings</b>', website: 'harbour.example' });
  assert.equal(created.status, 303);
  const location = created.headers.location!;
  assert.match(location, /^\/portal\/seo-blog\/b\/[0-9a-f-]{36}\/dna\?n=/, 'a new business lands on the Brand DNA door');
  const brandId = /\/b\/([0-9a-f-]{36})\//.exec(location)![1]!;
  const retry = await call(service, owner, 'POST', '/portal/seo-blog/brands', { _csrf: csrf, commandId, name: 'Harbour <b>Lettings</b>', website: 'harbour.example' });
  assert.equal(/\/b\/([0-9a-f-]{36})\//.exec(retry.headers.location!)![1], brandId, 'retrying the same form does not duplicate');
  assert.equal((await h.engine.listBrands(OWNER)).length, 1);

  const door = await call(service, owner, 'GET', location);
  assert.equal(door.status, 200);
  assert.match(door.body, /role="status">Harbour &lt;b&gt;Lettings&lt;\/b&gt; is added\. Start with its website\./);
  assert.match(door.body, /<h1>Start with your website<\/h1>/);
  assert.ok(!door.body.includes('<b>Lettings</b>'), 'brand names are escaped everywhere');
  const setup = await call(service, owner, 'GET', `/portal/seo-blog/b/${brandId}/setup`);
  assert.equal(setup.status, 200);
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

test('add a business → Start with your website: the path is plain, lands on the Brand DNA door, and an empty allowance leads somewhere the owner can act', async () => {
  const h = harness();
  const base: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => h.engine, socialCallback: async () => null };
  const owner = identity(OWNER.userId), csrf = portalCsrfToken(SECRET, owner.sessionToken);

  // No businesses yet: one heading, one main button, one plain form.
  const empty = (await call(base, owner, 'GET', '/portal/seo-blog')).body;
  assert.match(empty, /<h1>Your businesses<\/h1>/); assert.match(empty, /Add your first business to start\./);
  assert.match(empty, /<section class="card" id="add-business"/); assert.match(empty, /Adding it publishes nothing, contacts no one and spends nothing\./);
  assert.doesNotMatch(empty, /Add brand|workspace/i, 'no engine words');

  // A name that will not do keeps the owner on the form with the reason; nothing is created.
  const short = await call(base, owner, 'POST', '/portal/seo-blog/brands', { _csrf: csrf, commandId: randomUUID(), name: 'X', website: '' });
  assert.equal(short.status, 303); assert.match(short.headers.location!, /^\/portal\/seo-blog\?e=[^#]+#add-business$/);
  assert.match((await call(base, owner, 'GET', short.headers.location!.replace(/#.*$/u, ''))).body, /role="alert">Enter a business name between 2 and 120 characters\./);
  assert.equal((await h.engine.listBrands(OWNER)).length, 0);

  // Add two businesses. Each lands on its own Brand DNA door.
  const add = async (name: string, website: string) => {
    const made = await call(base, owner, 'POST', '/portal/seo-blog/brands', { _csrf: csrf, commandId: randomUUID(), name, website });
    assert.equal(made.status, 303);
    const id = /^\/portal\/seo-blog\/b\/([0-9a-f-]{36})\/dna\?n=/u.exec(made.headers.location!)?.[1];
    assert.ok(id, made.headers.location); return { id: id!, location: made.headers.location! };
  };
  const key = await add('Key Properties UK', 'keyproperties.example'), prop = await add('Prop Invest <UK>', '');
  const door = (await call(base, owner, 'GET', key.location)).body;
  assert.match(door, /role="status">Key Properties UK is added\. Start with its website\./); assert.match(door, /<h1>Start with your website<\/h1>/);

  // A new business has no allowance. An ordinary owner is sent to that business's own setting, with the number to type.
  assert.match(door, /<h2>Set a monthly allowance first<\/h2>/); assert.match(door, /Nothing has been read and nothing has been spent\./);
  assert.ok(door.includes(`<a class="button main" href="/portal/seo-blog/b/${key.id}/publishing#writing-budget">Set my monthly allowance</a>`));
  const needed = (await h.engine.brandDna(OWNER, key.id)).allowance.estimate;
  assert.ok(door.includes(`type ${needed} or more in “Writing allowance”, press “Save settings and authorise the draft programme” at the bottom`)); assert.doesNotMatch(door, /\/portal\/seo-blog\/limits/);
  const settings = (await call(base, owner, 'GET', `/portal/seo-blog/b/${key.id}/publishing`)).body;
  assert.match(settings, /<div id="writing-budget"><label for="bm">Writing allowance/); assert.match(settings, /<input id="bm" name="modelTokens" type="number" min="0" value="0">/);

  // An account whose allowance is capped below what is needed cannot raise it there (saving would be refused), so the
  // door says who can instead of sending the owner to a box that will not take the number.
  const brands = (h.store as unknown as { brands: Map<string, Awaited<ReturnType<typeof h.engine.getBrand>>> }).brands;
  const uncapped = brands.get(key.id)!;
  brands.set(key.id, { ...uncapped, settings: { ...uncapped.settings, operatorLimits: { modelTokens: 0, searchCalls: 0, images: 0, studioImages: 0, configuredBy: 'founder', configuredAt: '2026-11-02T10:00:00.000Z' } } });
  const cappedDoor = (await call(base, owner, 'GET', `/portal/seo-blog/b/${key.id}/dna`)).body;
  assert.match(cappedDoor, /<h2>Set a monthly allowance first<\/h2>/); assert.match(cappedDoor, /Ask whoever looks after your account to raise it, then come back here\./);
  assert.doesNotMatch(cappedDoor, /Set my monthly allowance<\/a>|or more in “Writing allowance”/, 'no button and no instruction that would end in a refusal');
  brands.set(key.id, uncapped);

  // The founder is sent to the limits page, at that business, and only because the server says the page is open to him.
  const saved: unknown[] = [];
  const limits = { allowed: async () => true, save: async (...args: unknown[]) => { saved.push(args); }, policy: async () => {},
    list: async () => ({ policy: { version: 1, enabled: false, maxConcurrency: 1, monthlyMicrousd: 0 }, brands: [
      { id: key.id, name: 'Key Properties UK', owner: 'owner@example.test', rowVersion: 1, managed: false, limits: { modelTokens: 0, searchCalls: 0, images: 0, studioImages: 0 }, usage: { modelTokens: 0, searchCalls: 0, images: 0, studioImages: 0 } },
      { id: randomUUID(), name: 'Somebody else’s', owner: 'other@example.test', rowVersion: 1, managed: false, limits: { modelTokens: 0, searchCalls: 0, images: 0, studioImages: 0 }, usage: { modelTokens: 0, searchCalls: 0, images: 0, studioImages: 0 } }] }) };
  const founder: PortalSeoBlogService = { ...base, limitsFor: () => limits };
  const founderDoor = (await call(founder, owner, 'GET', `/portal/seo-blog/b/${key.id}/dna`)).body;
  assert.ok(founderDoor.includes(`<a class="button main" href="/portal/seo-blog/limits#limits-${key.id}">Set my monthly allowance</a>`));
  assert.ok(founderDoor.includes(`Under “Writing tokens”, type ${needed} or more (or tick Unlimited), then press “Save limits for Key Properties UK” and come back here.`));
  const limitsPage = await call(founder, owner, 'GET', '/portal/seo-blog/limits');
  assert.equal(limitsPage.status, 200, 'the link opens for the founder');
  assert.ok(limitsPage.body.includes(`<section class="card" id="limits-${key.id}"><h2>Key Properties UK</h2>`)); assert.match(limitsPage.body, /<legend>Writing tokens<\/legend>/);
  assert.match(limitsPage.body, /<button type="submit">Save limits for Key Properties UK<\/button>/);
  assert.ok(limitsPage.body.includes(`<a href="/portal/seo-blog/b/${key.id}/dna">Back to Key Properties UK: start with your website</a>`));
  assert.equal((limitsPage.body.match(/start with your website<\/a>/gu) ?? []).length, 1, 'no way back is offered into a business he does not manage');
  const set = await call(founder, owner, 'POST', '/portal/seo-blog/limits', { _csrf: csrf, target: key.id, rowVersion: '1', modelTokens: String(needed), searchCalls: '0', images: '0', studioImages: '0' });
  assert.equal(set.status, 303); assert.deepEqual(saved, [[key.id, 1, { modelTokens: needed, searchCalls: 0, images: 0, studioImages: 0 }]]);
  assert.equal((await call(base, owner, 'GET', '/portal/seo-blog/limits')).status, 403, 'anyone else is refused, so they are never shown that link');

  // With an allowance, the door's one main button is "Read my website".
  const brand = await h.engine.getBrand(OWNER, key.id);
  await h.engine.updateSettings(OWNER, key.id, brand.rowVersion, { budgets: { modelTokensPerMonth: needed, searchCallsPerMonth: 0, imagesPerMonth: 0 } });
  const ready = (await call(base, owner, 'GET', `/portal/seo-blog/b/${key.id}/dna`)).body;
  assert.match(ready, /<button class="main" type="submit">Read my website<\/button>/); assert.doesNotMatch(ready, /Set a monthly allowance first/);
  assert.match(ready, /value="https:\/\/keyproperties\.example"/, 'the address typed when adding is already filled in');

  // Your businesses: each one shows its door, its approvals and its results; the picker is labelled "Business".
  const home = (await call(base, owner, 'GET', '/portal/seo-blog')).body;
  assert.ok(home.includes(`<a class="button" href="/portal/seo-blog/b/${key.id}/dna">Start with your website</a>`));
  assert.ok(home.includes(`<a href="/portal/approvals?brand=${prop.id}">Approvals</a> · <a href="/portal/campaign-journey?brand=${prop.id}">Campaign results</a>`));
  assert.match(home, /href="\/portal\/approvals\?brand=all"[^>]*>See what is waiting in every business<\/a>/);
  assert.match(home, /Prop Invest &lt;UK&gt;/); assert.doesNotMatch(home, /Prop Invest <UK>/);
  assert.match(ready, /<label for="brand-switch" class="muted" style="margin:0">Business<\/label><select id="brand-switch" name="brand">/);
  assert.match(ready, /<input type="hidden" name="to" value="dna">/, 'choosing another business keeps the Brand DNA page open');
  assert.ok(ready.includes(`<a href="/portal/approvals?brand=${key.id}">Approvals</a>`));
  assert.match(home, /<option value="" selected disabled>Choose a business<\/option>/);

  // The picker only ever redirects to a fixed page of a well-formed id; the page it lands on checks who may see it.
  const switched = await call(base, owner, 'GET', `/portal/seo-blog/switch?brand=${prop.id.toUpperCase()}&to=dna`);
  assert.equal(switched.status, 303); assert.equal(switched.headers.location, `/portal/seo-blog/b/${prop.id}/dna`);
  assert.equal((await call(base, owner, 'GET', `/portal/seo-blog/switch?brand=${prop.id}`)).headers.location, `/portal/seo-blog/b/${prop.id}/overview`);
  for (const to of ['//evil.example', '../../login', 'dna/read', 'https://evil.example', 'limits']) {
    assert.equal((await call(base, owner, 'GET', `/portal/seo-blog/switch?brand=${prop.id}&to=${encodeURIComponent(to)}`)).headers.location, `/portal/seo-blog/b/${prop.id}/overview`, to);
  }
  assert.equal((await call(base, owner, 'GET', '/portal/seo-blog/switch?brand=nope&to=dna')).status, 400);
  assert.equal((await call(base, identity(STRANGER.userId), 'GET', `/portal/seo-blog/b/${prop.id}/dna`)).status, 404, 'a business the user does not manage is never opened');
  assert.equal(h.llm.calls.length, 0); assert.equal(h.web.requests.length, 0, 'nothing was read and nothing was spent on this path');
});
