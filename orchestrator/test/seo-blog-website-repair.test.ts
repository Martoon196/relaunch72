import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {OWNER} from './seo-blog-fixtures.js';
import {websiteFixture} from './seo-blog-website-fixtures.js';
import {GithubStaticPublisher} from '../src/seo-blog/publishers/github-static.js';
import {staticCataloguePath} from '../src/seo-blog/publishers/static-catalogue.js';
import {websiteSha} from '../src/seo-blog/website-target.js';
import {sha256} from '../src/seo-blog/engine.js';
async function published(){
  const f=await websiteFixture('github_static');const structure=await f.approveStructure();let detail=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);
  const version=await f.h.engine.reviewArticleWebsiteTarget(OWNER,f.brand.id,f.articleId,{expectedVersionId:detail.version!.id,destinationId:f.destination.id,categoryIds:[structure.website!.categories[0]!.id]});await f.h.engine.approve(OWNER,f.brand.id,f.articleId,version.id);detail=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);await f.h.engine.schedule(OWNER,f.brand.id,f.articleId,detail.article.rowVersion,{localDate:'2026-11-03',localTime:'09:00',destinationId:f.destination.id});f.h.clock.set('2026-11-03T09:00:01Z');await f.h.engine.tick('publisher');
  const publication=(await f.h.store.listPublications(f.brand.id,f.articleId))[0]!;assert.equal(publication.state,'published');
  return {...f,publication,version};
}
function removeEntry(f:Awaited<ReturnType<typeof published>>){const xml=f.h.github.files().get('sitemap.xml')!;f.h.github.files().set('sitemap.xml',xml.replace(/<url>\s*<loc>[^<]+<\/loc>[\s\S]*?<\/url>/g,(block)=>block.includes(f.publication.publicUrl)?'':block));}
test('a missing sitemap stays an independent pending outcome; duplicate repair workers make one sitemap-only commit',async()=>{
  const f=await published();removeEntry(f);await f.h.engine.reobservePublication(OWNER,f.brand.id,f.articleId,f.publication.id);const before=f.h.github.files();const article=before.get(`blog/${f.version.body.slug}/index.html`)!;const index=before.get('blog/index.html')!;
  let p=(await f.h.store.listPublications(f.brand.id,f.articleId))[0]!;assert.equal(p.state,'published');assert.equal(p.websiteDelivery!.sitemap.state,'pending');const effects=f.h.github.refPatches;
  const commandId=randomUUID();await f.h.engine.requestSitemapRepair(OWNER,f.brand.id,f.articleId,{publicationId:p.id,commandId});await f.h.engine.requestSitemapRepair(OWNER,f.brand.id,f.articleId,{publicationId:p.id,commandId});await Promise.all([f.h.engine.tick('one'),f.h.makeEngine().tick('two')]);
  assert.equal(f.h.github.refPatches,effects+1);assert.equal(f.h.github.files().get(`blog/${f.version.body.slug}/index.html`),article);assert.equal(f.h.github.files().get('blog/index.html'),index);p=(await f.h.store.listPublications(f.brand.id,f.articleId))[0]!;assert.equal(p.sitemapRepair!.state,'done');assert.ok(f.h.github.files().get('sitemap.xml')!.includes(p.publicUrl));
});
test('pause/revocation/newer version committed before repair begin prevent a fresh commit',async()=>{
  for(const control of ['pause','revoke','version']){
    const f=await published();removeEntry(f);await f.h.engine.requestSitemapRepair(OWNER,f.brand.id,f.articleId,{publicationId:f.publication.id,commandId:randomUUID()});
    if(control==='pause'){const b=await f.h.engine.getBrand(OWNER,f.brand.id);await f.h.engine.updateSettings(OWNER,f.brand.id,b.rowVersion,{pauseAll:true});}
    else if(control==='revoke')f.h.store.revoke(OWNER.userId,f.brand.id);
    else await f.h.engine.editArticle(OWNER,f.brand.id,f.articleId,f.version.id,{title:f.version.body.title+' changed'});
    const effects=f.h.github.refPatches;await f.h.engine.tick('worker');assert.equal(f.h.github.refPatches,effects);assert.equal((await f.h.store.listPublications(f.brand.id,f.articleId))[0]!.sitemapRepair!.state,'held');
  }
});
test('lost repair acknowledgement reconciles without a second commit, and a concurrent human head remains intact',async()=>{
  for(const human of [false,true]){
    const f=await published();removeEntry(f);await f.h.engine.requestSitemapRepair(OWNER,f.brand.id,f.articleId,{publicationId:f.publication.id,commandId:randomUUID()});const effects=f.h.github.refPatches;
    if(human)f.h.github.concurrentEditOnce=true;else f.h.github.dropNextRefResponse=true;
    await f.h.engine.tick('first');const after=f.h.github.refPatches;f.h.clock.advance(30_000);await f.h.engine.tick('reconcile');await f.h.engine.tick('again');assert.equal(f.h.github.refPatches,after,'uncertain repair never sends another commit');
    if(human){assert.equal(after,effects+1,'one nonforce PATCH was refused; no second PATCH was attempted');assert.equal(f.h.github.files().get('about.html'),'<p>edited by a human</p>');assert.ok(!f.h.github.files().get('sitemap.xml')!.includes(f.publication.publicUrl),'the refused repair did not overwrite the human head');}else{assert.equal(after,effects+1);assert.equal((await f.h.store.listPublications(f.brand.id,f.articleId))[0]!.sitemapRepair!.state,'done');}
  }
});

test('static publication refuses changed metadata for the same version and empty category archives leave the sitemap',async()=>{
  const f=await published();const snap=f.publication.websiteSnapshot!;const publisher=new GithubStaticPublisher(f.h.github.fetch,1000);const before=f.h.github.refPatches;
  const body={...f.version.body,title:'Changed under same version'};const {deliverySha:_old,...target}=f.version.websiteTarget!;const changedTarget={...target,deliverySha:websiteSha({body,...target})};
  await assert.rejects(publisher.publish({operationId:randomUUID(),destination:snap.destination,credential:'gh-token-fixture',brandName:snap.brandName,locale:snap.locale,articleId:f.articleId,versionId:f.version.id,versionNumber:f.version.number,contentSha:f.version.contentSha,body,publishedAt:snap.publishedAt,websiteTarget:changedTarget}),/immutable publication metadata/);assert.equal(f.h.github.refPatches,before);
  const v=await f.h.engine.reviewArticleWebsiteTarget(OWNER,f.brand.id,f.articleId,{expectedVersionId:f.version.id,destinationId:f.destination.id,categoryIds:[]});await f.h.engine.approve(OWNER,f.brand.id,f.articleId,v.id);const article=(await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId)).article;await f.h.engine.schedule(OWNER,f.brand.id,f.articleId,article.rowVersion,{localDate:'2026-11-04',localTime:'09:00',destinationId:f.destination.id});f.h.clock.set('2026-11-04T09:00:01Z');await f.h.engine.tick('remove-category');
  assert.match(f.h.github.files().get('blog/category/guides/index.html')!,/noindex, follow/);assert.ok(!f.h.github.files().get('sitemap.xml')!.includes('blog/category/guides/'));
});

test('repair intent and wakeup survive a lost enqueue acknowledgement; known commit receipts retry database writes only',async()=>{
  const f=await published();removeEntry(f);const enqueue=f.h.store.enqueueJob.bind(f.h.store);let lost=false;
  f.h.store.enqueueJob=async(job)=>{if(job.idempotencyKey.startsWith('sitemap-repair:')&&!lost){lost=true;throw new Error('lost enqueue acknowledgement');}return enqueue(job);};
  const commandId=randomUUID();await assert.rejects(f.h.engine.requestSitemapRepair(OWNER,f.brand.id,f.articleId,{publicationId:f.publication.id,commandId}),/lost enqueue/);
  assert.ok((await f.h.store.listJobs(f.brand.id)).some((j)=>j.idempotencyKey===`sitemap-repair:${commandId}`&&j.state==='queued'),'wakeup was committed with publication intent');
  f.h.store.enqueueJob=enqueue;await f.h.engine.requestSitemapRepair(OWNER,f.brand.id,f.articleId,{publicationId:f.publication.id,commandId});const before=f.h.github.refPatches;f.h.store.failNext.updatePublication=1;await f.h.engine.tick('recover');assert.equal(f.h.github.refPatches,before+1);assert.equal((await f.h.store.listPublications(f.brand.id,f.articleId))[0]!.sitemapRepair!.state,'done');
});

test('cancel before repair begin prevents a write; cancellation after unknown preserves bounded read-only recovery',async()=>{
  const cancelled=await published();removeEntry(cancelled);const command=randomUUID();await cancelled.h.engine.requestSitemapRepair(OWNER,cancelled.brand.id,cancelled.articleId,{publicationId:cancelled.publication.id,commandId:command});const job=(await cancelled.h.store.listJobs(cancelled.brand.id)).find((j)=>j.idempotencyKey===`sitemap-repair:${command}`)!;await cancelled.h.engine.cancelJob(OWNER,cancelled.brand.id,job.id);const writes=cancelled.h.github.refPatches;await cancelled.h.engine.tick('cancelled');assert.equal(cancelled.h.github.refPatches,writes);assert.equal((await cancelled.h.store.listPublications(cancelled.brand.id,cancelled.articleId))[0]!.sitemapRepair!.state,'held');
  const f=await published();removeEntry(f);const id=randomUUID();await f.h.engine.requestSitemapRepair(OWNER,f.brand.id,f.articleId,{publicationId:f.publication.id,commandId:id});f.h.github.dropNextRefResponse=true;await f.h.engine.tick('unknown');const after=f.h.github.refPatches;f.h.github.failReads=true;
  const recovery=(await f.h.store.listJobs(f.brand.id)).find((j)=>j.idempotencyKey.startsWith('repair-observe:')&&j.state==='queued')!;await assert.rejects(f.h.engine.cancelJob(OWNER,f.brand.id,recovery.id),/Read-only reconciliation must continue/);const b=await f.h.engine.getBrand(OWNER,f.brand.id);await f.h.engine.updateSettings(OWNER,f.brand.id,b.rowVersion,{pauseAll:true});const a=(await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId)).article;await f.h.engine.unschedule(OWNER,f.brand.id,f.articleId,a.rowVersion);
  for(let n=0;n<6;n++){f.h.clock.advance(300_000);await f.h.engine.tick(`read-${n}`);}
  const p=(await f.h.store.listPublications(f.brand.id,f.articleId))[0]!;assert.equal(p.sitemapRepair!.state,'held');assert.equal(p.sitemapRepair!.uncertain,true);assert.equal(p.sitemapRepair!.reconcileAttempts,6);assert.equal(f.h.github.refPatches,after);
  const jobs=await f.h.store.listJobs(f.brand.id);assert.equal(jobs.filter((j)=>j.payload.sitemapRepair===p.id).length,1);assert.ok(jobs.filter((j)=>j.idempotencyKey.startsWith('repair-observe:')).every((j)=>j.payload.websiteObservation===p.id&&j.payload.sitemapRepair===undefined));
  await assert.rejects(f.h.engine.requestSitemapRepair(OWNER,f.brand.id,f.articleId,{publicationId:p.id,commandId:randomUUID()}),/earlier sitemap repair may already have committed/);
});

test('published-only pending observations retain durable wakeups after unscheduling and stop at their finite limit',async()=>{
  const f=await published();removeEntry(f);await f.h.engine.reobservePublication(OWNER,f.brand.id,f.articleId,f.publication.id);const article=(await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId)).article;await f.h.engine.unschedule(OWNER,f.brand.id,f.articleId,article.rowVersion);const writes=f.h.github.refPatches;
  for(let n=0;n<12;n++){f.h.clock.advance(300_000);await f.h.engine.tick(`observation-${n}`);}
  const p=(await f.h.store.listPublications(f.brand.id,f.articleId))[0]!;assert.equal(p.state,'published');assert.equal(p.websiteObserveAttempts,12);assert.equal(p.websiteObserveAfter,null);assert.equal(f.h.github.refPatches,writes);
});

test('unowned or missing v2 catalogue prevents a fresh publication without overwriting existing website bytes',async()=>{
  for(const kind of ['unowned','missing']){
    const f=await published();const path=staticCataloguePath(f.version.websiteTarget!.target.siteId);assert.ok(f.h.github.files().has(path));
    if(kind==='unowned')f.h.github.files().set(path,'{"source":"human-owned"}');else f.h.github.files().delete(path);
    const oldPage=f.h.github.files().get(`blog/${f.version.body.slug}/index.html`);const version=await f.h.engine.editArticle(OWNER,f.brand.id,f.articleId,f.version.id,{title:f.version.body.title+' new'});await f.h.engine.approve(OWNER,f.brand.id,f.articleId,version.id);const article=(await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId)).article;await f.h.engine.schedule(OWNER,f.brand.id,f.articleId,article.rowVersion,{localDate:'2026-11-04',localTime:'09:00',destinationId:f.destination.id});const before=f.h.github.refPatches;f.h.clock.set('2026-11-04T09:00:01Z');await f.h.engine.tick('held');assert.equal(f.h.github.refPatches,before);assert.equal((await f.h.store.listPublications(f.brand.id,f.articleId)).at(-1)!.state,'failed');assert.equal(f.h.github.files().get(`blog/${f.version.body.slug}/index.html`),oldPage);
  }
});

test('v2 article, catalogue, archives and sitemap share one nonforce commit and retain concurrent human changes',async()=>{
  const f=await websiteFixture('github_static');const structure=await f.approveStructure();const old=(await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId)).version!;const version=await f.h.engine.reviewArticleWebsiteTarget(OWNER,f.brand.id,f.articleId,{expectedVersionId:old.id,destinationId:f.destination.id,categoryIds:[structure.website!.categories[0]!.id]});await f.h.engine.approve(OWNER,f.brand.id,f.articleId,version.id);const article=(await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId)).article;await f.h.engine.schedule(OWNER,f.brand.id,f.articleId,article.rowVersion,{localDate:'2026-11-03',localTime:'09:00',destinationId:f.destination.id});f.h.github.concurrentEditOnce=true;f.h.clock.set('2026-11-03T09:00:01Z');await f.h.engine.tick('publisher');
  const files=f.h.github.files();assert.equal(files.get('about.html'),'<p>edited by a human</p>');assert.ok(files.has(staticCataloguePath(version.websiteTarget!.target.siteId)));assert.ok(files.has(`blog/${version.body.slug}/index.html`));assert.ok(files.has('blog/category/guides/index.html'));assert.ok(files.get('sitemap.xml')!.includes(version.websiteTarget!.target.canonicalUrl));const commit=f.h.github.commits.get(f.h.github.head)!;assert.match(commit.message,/catalogue-base:absent/);assert.equal((await f.h.store.listPublications(f.brand.id,f.articleId)).length,1);
});

test('known older static catalogue can publish another article without reverting the newer shared archive label',async()=>{
  const f=await published();const original=f.version.websiteTarget!;await f.approveStructure('/blog','Current guides');let detail=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);const revised=await f.h.engine.reviewArticleWebsiteTarget(OWNER,f.brand.id,f.articleId,{expectedVersionId:detail.version!.id,destinationId:f.destination.id,categoryIds:original.target.categoryIds});await f.h.engine.approve(OWNER,f.brand.id,f.articleId,revised.id);detail=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);await f.h.engine.schedule(OWNER,f.brand.id,f.articleId,detail.article.rowVersion,{localDate:'2026-11-04',localTime:'09:00',destinationId:f.destination.id});f.h.clock.set('2026-11-04T09:00:01Z');await f.h.engine.tick('new-label');assert.match(f.h.github.files().get('blog/category/guides/index.html')!,/<h1>Current guides<\/h1>/);
  const body={...f.version.body,slug:`${f.version.body.slug}-another`};const {deliverySha:_old,...base}=original;const target={...base,target:{...base.target,canonicalUrl:`https://harbour.example/blog/${body.slug}/`}};const websiteTarget={...target,deliverySha:websiteSha({body,...target})};const publication=(await f.h.store.listPublications(f.brand.id,f.articleId)).at(-1)!;const destination=publication.websiteSnapshot!.destination;
  await new GithubStaticPublisher(f.h.github.fetch,1000).publish({operationId:randomUUID(),destination,credential:'gh-token-fixture',brandName:original.brandName,locale:original.locale,articleId:randomUUID(),versionId:randomUUID(),versionNumber:1,contentSha:sha256(body),body,publishedAt:f.h.clock.now(),websiteTarget});
  assert.match(f.h.github.files().get('blog/category/guides/index.html')!,/<h1>Current guides<\/h1>/);const article=f.h.github.files().get(`blog/${body.slug}/index.html`)!;assert.match(article,/>Guides<\/a>/);assert.doesNotMatch(article,/>Current guides<\/a>/);
});

test('reconciling an applied old operation clears only its own unknown delivery claim while retaining a newer draft',async()=>{
  const f=await websiteFixture('github_static');let detail=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);await f.h.engine.approve(OWNER,f.brand.id,f.articleId,detail.version!.id);detail=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);await f.h.engine.schedule(OWNER,f.brand.id,f.articleId,detail.article.rowVersion,{localDate:'2026-11-03',localTime:'09:00',destinationId:f.destination.id});const reconcile=f.h.engine.reconcile.bind(f.h.engine);f.h.engine.reconcile=async()=>0;f.h.github.dropNextRefResponse=true;f.h.clock.set('2026-11-03T09:00:01Z');await f.h.engine.tick('lost-ack');
  detail=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);assert.equal(detail.article.delivery,'unknown');const publishedVersion=detail.version!.id;const edited=await f.h.engine.editArticle(OWNER,f.brand.id,f.articleId,publishedVersion,{title:detail.version!.body.title+' owner draft',slug:'temporary-owner-draft'});f.h.engine.reconcile=reconcile;await reconcile(f.brand.id);const after=await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId);assert.equal(after.article.currentVersionId,edited.id);assert.equal(after.version!.body.title,edited.body.title);assert.equal(after.article.delivery,'published');assert.equal(after.article.publishedVersionId,publishedVersion);const restored=await f.h.engine.editArticle(OWNER,f.brand.id,f.articleId,edited.id,{slug:detail.version!.body.slug});assert.equal(restored.body.slug,detail.version!.body.slug);assert.equal((await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId)).article.publishedUrl,after.article.publishedUrl);
});

test('an old verified receipt cannot overwrite delivery owned by a newly begun publication',async()=>{
  const f=await published();const edited=await f.h.engine.editArticle(OWNER,f.brand.id,f.articleId,f.version.id,{title:f.version.body.title+' current'});await f.h.engine.approve(OWNER,f.brand.id,f.articleId,edited.id);const a=(await f.h.engine.getArticle(OWNER,f.brand.id,f.articleId)).article;await f.h.engine.schedule(OWNER,f.brand.id,f.articleId,a.rowVersion,{localDate:'2026-11-04',localTime:'09:00',destinationId:f.destination.id});const begin=f.h.store.beginPublication.bind(f.h.store);let checked=false;
  f.h.store.beginPublication=async(input)=>{const result=await begin(input);if(result.kind==='begin'&&!checked){checked=true;await f.h.engine.reobservePublication(OWNER,f.brand.id,f.articleId,f.publication.id);const current=(await f.h.store.getArticle(f.brand.id,f.articleId))!;assert.equal(current.deliveryPublicationId,result.publication.id);assert.equal(current.delivery,'publishing');assert.equal(current.currentVersionId,edited.id);assert.equal(current.approval!.versionId,edited.id);}return result;};
  f.h.clock.set('2026-11-04T09:00:01Z');await f.h.engine.tick('current');assert.ok(checked);const current=(await f.h.store.getArticle(f.brand.id,f.articleId))!;assert.equal(current.publishedVersionId,edited.id);assert.equal(current.delivery,'published');
});

test('healthy connection rechecks preserve repair eligibility before request and after queue without rewriting the pinned publication',async()=>{
  const f=await published();removeEntry(f);const original=f.publication.websiteSnapshot!.requestSha;f.h.clock.advance(60_000);await f.h.engine.checkDestination(OWNER,f.brand.id,f.destination.id);await f.h.engine.requestSitemapRepair(OWNER,f.brand.id,f.articleId,{publicationId:f.publication.id,commandId:randomUUID()});f.h.clock.advance(60_000);await f.h.engine.checkDestination(OWNER,f.brand.id,f.destination.id);const before=f.h.github.refPatches;await f.h.engine.tick('healthy-recheck');const p=(await f.h.store.listPublications(f.brand.id,f.articleId))[0]!;assert.equal(p.sitemapRepair!.state,'done');assert.equal(f.h.github.refPatches,before+1);assert.equal(p.websiteSnapshot!.requestSha,original);
});
test('actual connection config, key and capability changes still hold queued sitemap repair',async()=>{
  for(const control of ['config','key','capabilities']){
    const f=await published();removeEntry(f);await f.h.engine.requestSitemapRepair(OWNER,f.brand.id,f.articleId,{publicationId:f.publication.id,commandId:randomUUID()});const d=(await f.h.store.getDestination(f.brand.id,f.destination.id))!;
    if(control==='config')await f.h.store.saveDestination({...d,config:{...d.config,sitemapPath:'changed.xml'}});
    else if(control==='key')await f.h.store.saveDestination({...d,sealedCredential:f.h.vault.seal(f.brand.id,d.id,'different-current-key')});
    else{assert.equal(d.websiteCapability!.protocol,'v2');const c=d.websiteCapability!;if(c.protocol==='v2')await f.h.store.saveDestination({...d,websiteCapability:{...c,capabilities:{...c.capabilities,capabilitiesSha:'e'.repeat(64)}}});}
    const before=f.h.github.refPatches;await f.h.engine.tick('changed-connection');assert.equal(f.h.github.refPatches,before);assert.equal((await f.h.store.listPublications(f.brand.id,f.articleId))[0]!.sitemapRepair!.state,'held');
  }
});
