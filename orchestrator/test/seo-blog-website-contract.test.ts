import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {contentApiSignature} from '../src/seo-blog/publishers/content-api.js';
import {parseWebsiteCapabilities,reviewedWebsiteTarget} from '../src/seo-blog/website-target.js';
import {OWNER,STRANGER} from './seo-blog-fixtures.js';
import {websiteCaps,websiteFixture} from './seo-blog-website-fixtures.js';

test('paired PP v1/v2 golden bytes retain exact HMAC signatures',async()=>{
  const root=new URL('./fixtures/seo-blog-website-v2/',import.meta.url);
  const fixture=JSON.parse(await readFile(new URL('blog-publish-signatures.golden.json',root),'utf8'));
  for(const [name,signature]of Object.entries(fixture.signatures)){const body=await readFile(new URL(name,root),'utf8');assert.equal(contentApiSignature(fixture.testSecret,fixture.timestamp,fixture.method,fixture.path,body),signature);}
});
test('signed capability parsing accepts legacy without inventing roots and refuses unsupported/cross-site capabilities',()=>{
  assert.deepEqual(parseWebsiteCapabilities(undefined,'https://bay.example','now'),{protocol:'legacy',checkedAt:'now'});
  const caps=websiteCaps();assert.equal(parseWebsiteCapabilities(caps,'https://bay.example','now').protocol,'v2');
  for(const bad of [{...caps,contractVersion:3},{...caps,publicOrigin:'https://foreign.example'},{...caps,roots:[{...caps.roots[0],path:'../other'}]},{...caps,roots:[{...caps.roots[0],indexUrl:'https://foreign.example/blog'}]},{...caps,sitemaps:['https://foreign.example/sitemap.xml']}])assert.throws(()=>parseWebsiteCapabilities(bad,'https://bay.example','now'));
});
test('explicit structure approval creates stable brand-scoped UUIDs across scans and label edits, and new addresses require acknowledgement',async()=>{
  const f=await websiteFixture();const first=await f.approveStructure();const uuid=/^[a-f0-9-]{36}$/;
  assert.match(first.website!.structureId,uuid);assert.match(first.website!.categories[0]!.id,uuid);
  await f.h.engine.refreshInventory(f.brand.id);const label=await f.approveStructure('/blog','Owner guides');
  assert.equal(label.website!.structureId,first.website!.structureId);assert.equal(label.website!.categories[0]!.id,first.website!.categories[0]!.id);
  const scan=(await f.h.engine.getInventory(OWNER,f.brand.id))!;await f.h.store.saveInventory({...scan,editorial:{...scan.editorial!,categories:scan.editorial!.categories.map((c,i)=>i===0?{...c,id:'observed-after-rescan'}:c)}});
  const rescanned=await f.approveStructure('/blog','Owner guides');assert.equal(rescanned.website!.categories[0]!.id,first.website!.categories[0]!.id,'recommendation identity changes cannot reassign an existing archive UUID');
  await assert.rejects(f.approveStructure('/investment-info'),/Explicitly confirm/);
  const moved=await f.approveStructure('/investment-info','Guides','guides',true);assert.equal(moved.website!.structureId,first.website!.structureId);assert.notEqual(moved.website!.categories[0]!.id,first.website!.categories[0]!.id);
  const other=await websiteFixture();const foreign=await other.approveStructure();assert.notEqual(foreign.website!.structureId,first.website!.structureId);assert.notEqual(foreign.website!.categories[0]!.id,first.website!.categories[0]!.id);
});
test('target review appends one immutable unconfirmed version, preserves sources, rejects stale and foreign actions, and makes no model call',async()=>{
  const f=await websiteFixture();const structure=await f.approveStructure();const old=(await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId)).version!;const calls=f.h.llm.calls.length;
  await f.h.engine.approve(OWNER,f.brand.id,f.articleId,old.id);
  const version=await f.h.engine.reviewArticleWebsiteTarget(OWNER,f.brand.id,f.articleId,{expectedVersionId:old.id,destinationId:f.destination.id,categoryIds:[structure.website!.categories[0]!.id]});
  assert.equal(version.number,old.number+1);assert.equal(version.parentVersionId,old.id);assert.deepEqual(version.body,old.body);assert.deepEqual(version.knowledge,old.knowledge);assert.equal(f.h.llm.calls.length,calls);
  assert.equal((await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId)).article.approval,null);assert.equal(old.websiteTarget,undefined);assert.match(version.websiteTarget!.target.canonicalUrl,/\/blog\//);
  await assert.rejects(f.h.engine.reviewArticleWebsiteTarget(OWNER,f.brand.id,f.articleId,{expectedVersionId:old.id,destinationId:f.destination.id,categoryIds:[]}),/changed/);
  await assert.rejects(f.h.engine.reviewArticleWebsiteTarget(STRANGER,f.brand.id,f.articleId,{expectedVersionId:version.id,destinationId:f.destination.id,categoryIds:[]}),{status:404});
});
test('changing the default root does not move an existing live blog article; reviewed updates retain original target and timestamp on retry',async()=>{
  const f=await websiteFixture();const structure=await f.approveStructure();let detail=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);
  let version=await f.h.engine.reviewArticleWebsiteTarget(OWNER,f.brand.id,f.articleId,{expectedVersionId:detail.version!.id,destinationId:f.destination.id,categoryIds:[structure.website!.categories[0]!.id]});
  await f.h.engine.approve(OWNER,f.brand.id,f.articleId,version.id);detail=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);await f.h.engine.schedule(OWNER,f.brand.id,f.articleId,detail.article.rowVersion,{localDate:'2026-11-03',localTime:'09:00',destinationId:f.destination.id});f.h.clock.set('2026-11-03T09:00:01Z');await f.h.engine.tick('publisher');
  detail=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);assert.equal(detail.article.delivery,'published');const original=detail.article.publishedUrl!;
  assert.equal(detail.publications[0]!.websiteSnapshot,undefined,'private sealed destination never enters the owner projection');
  await f.approveStructure('/investment-info','Guides','guides',true);
  version=await f.h.engine.editArticle(OWNER,f.brand.id,f.articleId,version.id,{title:version.body.title+' updated'});
  version=await f.h.engine.reviewArticleWebsiteTarget(OWNER,f.brand.id,f.articleId,{expectedVersionId:version.id,destinationId:f.destination.id,categoryIds:[structure.website!.categories[0]!.id]});assert.equal(version.websiteTarget!.target.canonicalUrl,original);assert.equal(version.websiteTarget!.target.rootId,'blog');
  await assert.rejects(f.h.engine.editArticle(OWNER,f.brand.id,f.articleId,version.id,{slug:'new-address'}),/original slug/);
  await f.h.engine.approve(OWNER,f.brand.id,f.articleId,version.id);detail=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);await f.h.engine.schedule(OWNER,f.brand.id,f.articleId,detail.article.rowVersion,{localDate:'2026-11-04',localTime:'09:00',destinationId:f.destination.id});f.h.clock.set('2026-11-04T09:00:01Z');await f.h.engine.tick('update');
  assert.equal(f.h.site.payloads.at(-1)!.canonicalUrl,original);assert.equal((f.h.site.payloads.at(-1)!.target as {rootId:string}).rootId,'blog');assert.equal(f.h.site.payloads.at(-1)!.contractVersion,2);
  const operation=(await f.h.store.listPublications(f.brand.id,f.articleId)).at(-1)!;assert.equal(operation.websiteSnapshot!.publishedAt,f.h.site.payloads.at(-1)!.publishedAt);
  assert.equal((await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId)).article.publishedUrl,original);
  const posts=f.h.site.posts;await assert.rejects(f.h.engine.requestSitemapRepair(OWNER,f.brand.id,f.articleId,{publicationId:operation.id,commandId:randomUUID()}),/does not support sitemap-only repair/);assert.equal(f.h.site.posts,posts);
});

test('post-begin reconnection cannot retarget v2 work, and lost acknowledgement reconciles the original bytes without a second POST',async()=>{
  const f=await websiteFixture();const structure=await f.approveStructure();const old=(await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId)).version!;
  const version=await f.h.engine.reviewArticleWebsiteTarget(OWNER,f.brand.id,f.articleId,{expectedVersionId:old.id,destinationId:f.destination.id,categoryIds:[structure.website!.categories[0]!.id]});await f.h.engine.approve(OWNER,f.brand.id,f.articleId,version.id);const a=(await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId)).article;await f.h.engine.schedule(OWNER,f.brand.id,f.articleId,a.rowVersion,{localDate:'2026-11-03',localTime:'09:00',destinationId:f.destination.id});
  const begin=f.h.store.beginPublication.bind(f.h.store);let swapped=false;
  f.h.store.beginPublication=async(input)=>{const result=await begin(input);if(result.kind==='begin'&&!swapped){swapped=true;await assert.rejects(f.h.engine.reviewArticleWebsiteTarget(OWNER,f.brand.id,f.articleId,{expectedVersionId:version.id,destinationId:f.destination.id,categoryIds:[]}),/existing publication outcome/);await f.h.store.saveDestination({...result.destination,publicBaseUrl:'https://replacement.example',status:'unverified',config:{...result.destination.config,endpoint:'https://replacement.example/api/blog/publish'}});}return result;};
  f.h.site.dropNextPublishResponse=true;f.h.clock.set('2026-11-03T09:00:01Z');await f.h.engine.tick('publisher');assert.equal(f.h.site.posts,1);await f.h.engine.tick('reconcile');
  const p=(await f.h.store.listPublications(f.brand.id,f.articleId))[0]!;assert.equal(p.state,'published');assert.equal(f.h.site.posts,1);assert.equal(p.publicUrl,version.websiteTarget!.target.canonicalUrl);assert.deepEqual(f.h.site.payloads[0]!.target,version.websiteTarget!.target);assert.equal(f.h.site.payloads[0]!.publishedAt,p.websiteSnapshot!.publishedAt);
});

test('legacy live blog updates remain v1 after a new default root; v2 adoption requires genuine original-root guidance',async()=>{
  const f=await websiteFixture();let detail=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);await f.h.engine.approve(OWNER,f.brand.id,f.articleId,detail.version!.id);detail=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);await f.h.engine.schedule(OWNER,f.brand.id,f.articleId,detail.article.rowVersion,{localDate:'2026-11-03',localTime:'09:00',destinationId:f.destination.id});f.h.clock.set('2026-11-03T09:00:01Z');await f.h.engine.tick('legacy');
  detail=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);assert.equal(detail.article.delivery,'published');const original=detail.article.publishedUrl!;assert.equal(f.h.site.payloads[0]!.contractVersion,undefined);
  await f.approveStructure('/investment-info');const edited=await f.h.engine.editArticle(OWNER,f.brand.id,f.articleId,detail.version!.id,{title:detail.version!.body.title+' revised'});
  await assert.rejects(f.h.engine.reviewArticleWebsiteTarget(OWNER,f.brand.id,f.articleId,{expectedVersionId:edited.id,destinationId:f.destination.id,categoryIds:[]}),/Approve website guidance.*original root/);assert.equal(edited.websiteTarget,undefined);
  await f.h.engine.approve(OWNER,f.brand.id,f.articleId,edited.id);detail=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);await f.h.engine.schedule(OWNER,f.brand.id,f.articleId,detail.article.rowVersion,{localDate:'2026-11-04',localTime:'09:00',destinationId:f.destination.id});f.h.clock.set('2026-11-04T09:00:01Z');await f.h.engine.tick('legacy-update');assert.equal(f.h.site.payloads.at(-1)!.contractVersion,undefined);assert.equal(f.h.site.payloads.at(-1)!.canonicalUrl,original);assert.equal((await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId)).article.delivery,'published');
});

test('new articles automatically propose the approved default and proceed through normal approval without an extra target command',async()=>{
  const f=await websiteFixture('content_api','/investment-info');let detail=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);const v=detail.version!;
  assert.equal(v.websiteTarget!.origin,'programme_default');assert.equal(v.websiteTarget!.target.rootId,'investment-info');assert.deepEqual(v.websiteTarget!.target.categoryIds,[]);assert.equal(v.promotionPack!.canonicalUrl,v.websiteTarget!.target.canonicalUrl);assert.equal(f.h.llm.calls.length,4);
  await f.h.engine.approve(OWNER,f.brand.id,f.articleId,v.id);detail=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);await f.h.engine.schedule(OWNER,f.brand.id,f.articleId,detail.article.rowVersion,{localDate:'2026-11-03',localTime:'09:00',destinationId:f.destination.id});f.h.clock.set('2026-11-03T09:00:01Z');await f.h.engine.tick('default-publisher');assert.equal((await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId)).article.delivery,'published');assert.equal(f.h.site.payloads[0]!.contractVersion,2);assert.equal((f.h.site.payloads[0]!.target as {rootId:string}).rootId,'investment-info');
});
test('atomic first-target insertion rejects changed structure or destination rather than attach stale metadata',async()=>{
  for(const control of ['structure','destination']){
    const f=await websiteFixture('content_api','/blog',async(h,brandId,destinationId)=>{
      const insert=h.store.addVersion.bind(h.store);let changed=false;
      h.store.addVersion=async(version,guard)=>{if(guard&&!changed){changed=true;if(control==='structure'){const b=await h.engine.getBrand(OWNER,brandId);const scan=(await h.engine.getInventory(OWNER,brandId))!;await h.engine.approveEditorialStructure(OWNER,brandId,{rowVersion:b.rowVersion,scanId:scan.editorial!.scanId,scanSha:scan.editorial!.scanSha,destinationId,root:'/blog',categories:[{id:scan.editorial!.categories[0]!.id,label:'Changed during append',slug:'guides'}]});}else{const d=(await h.store.getDestination(brandId,destinationId))!;await h.store.saveDestination({...d,status:'unverified'});}}return insert(version,guard);};
    });
    assert.equal((await f.h.store.listVersions(f.brand.id,f.articleId)).length,0);const job=(await f.h.store.listJobs(f.brand.id)).find((j)=>j.kind==='write')!;assert.equal(job.state,'blocked');assert.match(job.error!,/changed while the target proposal/);assert.equal(f.h.site.posts,0);
  }
});
test('visual-only changes before writing remain eligible, and an owner-pinned root/categories survive a later default change and body edit',async()=>{
  const f=await websiteFixture('content_api','/blog',async(h,brandId)=>{await h.engine.uploadKnowledge(OWNER,brandId,{category:'visual_guidance',title:'Current colours',pastedText:'Use the current approved blue and green palette.'});});let detail=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);assert.ok(detail.version?.websiteTarget);
  const category=f.initialStructure!.website!.categories[0]!.id;const pinned=await f.h.engine.reviewArticleWebsiteTarget(OWNER,f.brand.id,f.articleId,{expectedVersionId:detail.version!.id,destinationId:f.destination.id,categoryIds:[category]});await f.approveStructure('/investment-info','Guides','guides',true);const edited=await f.h.engine.editArticle(OWNER,f.brand.id,f.articleId,pinned.id,{title:pinned.body.title+' owner edit'});assert.equal(edited.websiteTarget!.origin,'owner_review');assert.equal(edited.websiteTarget!.target.rootId,'blog');assert.deepEqual(edited.websiteTarget!.target.categoryIds,[category]);assert.equal((await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId)).article.approval,null);
});

test('current pinned old-root catalogue wins over older published history after a default-root switch',async()=>{
  const f=await websiteFixture('content_api','/blog');let detail=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);const first=await f.h.engine.reviewArticleWebsiteTarget(OWNER,f.brand.id,f.articleId,{expectedVersionId:detail.version!.id,destinationId:f.destination.id,categoryIds:[f.initialStructure!.website!.categories[0]!.id]});await f.h.engine.approve(OWNER,f.brand.id,f.articleId,first.id);detail=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);await f.h.engine.schedule(OWNER,f.brand.id,f.articleId,detail.article.rowVersion,{localDate:'2026-11-03',localTime:'09:00',destinationId:f.destination.id});f.h.clock.set('2026-11-03T09:00:01Z');await f.h.engine.tick('first');
  const brand=await f.h.engine.getBrand(OWNER,f.brand.id);const scan=(await f.h.engine.getInventory(OWNER,f.brand.id))!;const second=await f.h.engine.approveEditorialStructure(OWNER,f.brand.id,{rowVersion:brand.rowVersion,scanId:scan.editorial!.scanId,scanSha:scan.editorial!.scanSha,destinationId:f.destination.id,root:'/blog',categories:[{id:scan.editorial!.categories[0]!.id,label:'Guides',slug:'guides'},{id:'owner-0',label:'Tax',slug:'tax'}],newCategoryAddresses:true});const tax=second.website!.categories.find((c)=>c.slug==='tax')!.id;const v=await f.h.engine.reviewArticleWebsiteTarget(OWNER,f.brand.id,f.articleId,{expectedVersionId:first.id,destinationId:f.destination.id,categoryIds:[tax]});await f.h.engine.approve(OWNER,f.brand.id,f.articleId,v.id);detail=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);await f.h.engine.schedule(OWNER,f.brand.id,f.articleId,detail.article.rowVersion,{localDate:'2026-11-04',localTime:'09:00',destinationId:f.destination.id});f.h.clock.set('2026-11-04T09:00:01Z');await f.h.engine.tick('second');await f.approveStructure('/investment-info','Guides','guides',true);
  const same=await f.h.engine.reviewArticleWebsiteTarget(OWNER,f.brand.id,f.articleId,{expectedVersionId:v.id,destinationId:f.destination.id,categoryIds:[tax]});assert.equal(same.websiteTarget!.target.structureRevision,second.version);assert.deepEqual(same.websiteTarget!.target.categoryIds,[tax]);assert.equal(same.websiteTarget!.target.rootId,'blog');
  const article=(await f.h.store.getArticle(f.brand.id,f.articleId))!;const destination=(await f.h.store.getDestination(f.brand.id,f.destination.id))!;const fallback=reviewedWebsiteTarget({brand:await f.h.engine.getBrand(OWNER,f.brand.id),article,version:{...same,websiteTarget:undefined},destination,publications:await f.h.store.listPublications(f.brand.id,f.articleId)},[tax]);assert.equal(fallback.target.structureRevision,second.version);assert.deepEqual(fallback.target.categoryIds,[tax]);
});
test('a health-only recheck during automatic target insertion preserves the semantic website identity',async()=>{
  const f=await websiteFixture('content_api','/blog',async(h,brandId,destinationId)=>{const insert=h.store.addVersion.bind(h.store);let checked=false;h.store.addVersion=async(version,guard)=>{if(guard&&!checked){checked=true;h.clock.advance(60_000);await h.engine.checkDestination(OWNER,brandId,destinationId);}return insert(version,guard);};});assert.ok((await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId)).version!.websiteTarget);assert.equal(f.h.site.posts,0);
});
