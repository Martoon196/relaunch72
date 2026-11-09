import test from 'node:test';
import assert from 'node:assert/strict';
import {SeoBlogError,type KnowledgeDocument,type Article} from '../src/seo-blog/types.js';
import {loadAuthorityProgrammePage,AUTHORITY_NATIVE_LIMITS} from '../src/seo-blog/authority-programme-controller.js';
import {authorityProgrammeContent} from '../src/seo-blog/authority-programme-view.js';
import {authorityNativeFixture,NATIVE_ACTOR} from './seo-blog-authority-native-fixtures.js';
import {reviewId} from './seo-blog-authority-programme-fixtures.js';
const load=(f:ReturnType<typeof authorityNativeFixture>)=>loadAuthorityProgrammePage(f.engine,NATIVE_ACTOR,f.data.brand.id,{now:f.source.now});
test('ready assembly propagates the identical genuine actor and brand through all six read methods',async()=>{
 const f=authorityNativeFixture(),page=await load(f);assert.equal(page.status,'ready');assert.equal(page.readOnly,true);assert.equal(page.atomicSnapshot,false);assert.ok(f.calls.every(c=>c.actor===NATIVE_ACTOR&&c.brandId===f.data.brand.id));assert.deepEqual(new Set(f.calls.map(c=>c.method)),new Set(['getBrand','getProfile','listKnowledge','getInventory','listArticles','getArticle']));assert.equal(page.review?.indexedSample,null);assert.ok(page.briefs.length>0);
});
test('brand403 stops before any subsequent read and is not converted into a setup suggestion',async()=>{
 const f=authorityNativeFixture();f.before(method=>{if(method==='getBrand')throw new SeoBlogError(403,'No brand access.');});await assert.rejects(load(f),{status:403});assert.equal(f.calls.length,1);
});
test('permission revocation during parallel detail reads propagates and prevents later batches',async()=>{
 const f=authorityNativeFixture(40);f.before(method=>{if(method==='getArticle')throw new SeoBlogError(403,'Access revoked.');});await assert.rejects(load(f),{status:403});assert.equal(f.calls.filter(c=>c.method==='getArticle').length,AUTHORITY_NATIVE_LIMITS.concurrency);
});
test('missing website, profile, confirmation and inventory show specific genuine setup links without detail reads',async()=>{
 for(const state of ['needs_website','needs_profile','needs_confirmation','needs_inventory'] as const){const f=authorityNativeFixture();if(state==='needs_website')f.data.brand={...f.data.brand,website:null};if(state==='needs_profile')f.data.profile=null;if(state==='needs_confirmation')f.data.profile={...f.data.profile!,confirmedAt:null};if(state==='needs_inventory')f.data.inventory=null;const p=await load(f);assert.equal(p.status,state);assert.ok(!f.calls.some(c=>c.method==='getArticle'));assert.match(authorityProgrammeContent(p),new RegExp('/portal/seo-blog/b/'+f.data.brand.id+'/setup#'));assert.equal(p.review,null);}
});
test('latest retired document never resurrects its active historical version',async()=>{
 const f=authorityNativeFixture();f.data.documents.push({...f.data.documents[0]!,version:2,active:false});const p=await load(f);assert.equal(p.status,'guidance_changed');assert.equal(p.guidanceChange,'other');assert.equal(p.review,null);
});
test('a visual-only text-guidance mismatch asks for review without requiring another paid extraction',async()=>{
 const f=authorityNativeFixture(),visual={documentId:reviewId(50),version:1,sha256:'e'.repeat(64),category:'visual_guidance' as const};f.data.profile={...f.data.profile!,knowledge:[...f.data.profile!.knowledge,visual]};f.data.documents.push({...f.data.documents[0]!,id:visual.documentId,version:2,sha256:'f'.repeat(64),category:'visual_guidance'});const p=await load(f),html=authorityProgrammeContent(p);assert.equal(p.guidanceChange,'visual_only');assert.match(html,/Review the changed visual guidance/u);assert.doesNotMatch(html,/must.*extract|extract again|re-extract/u);assert.ok(!f.calls.some(c=>c.method==='listArticles'));
});
test('nontext visual reference does not pretend to be an extracted profile document',async()=>{
 const f=authorityNativeFixture();f.data.documents.push({...f.data.documents[0]!,id:reviewId(51),category:'visual_guidance',text:null,status:'image_reference'});assert.equal((await load(f)).status,'ready');
});
test('newer unapproved draft retains evidence for the immutable published version',async()=>{
 const f=authorityNativeFixture(),d=f.data.details.values().next().value!;assert.notEqual(d.version!.id,d.article.publishedVersionId);const p=await load(f);assert.equal(p.coverage.observed,1);assert.ok(p.review?.findings.some(x=>x.evidence.some(e=>e.sourceId.startsWith(d.publications[0]!.id+':'))));assert.ok(!JSON.stringify(p).includes(d.version!.id));
});
test('multiple matching historical operations are unknown unless an exact owning publication is pinned',async()=>{
 const f=authorityNativeFixture(),d=f.data.details.values().next().value!,original=d.publications[0]!;d.publications.push({...original,id:reviewId(700),verifiedAt:'2026-11-03T09:00:00.000Z'});d.article={...d.article,deliveryPublicationId:undefined};let p=await load(f);assert.equal(p.coverage.ambiguous,1);assert.equal(p.coverage.observed,0);d.article={...d.article,deliveryPublicationId:original.id};p=await load(f);assert.equal(p.coverage.observed,1);assert.equal(p.coverage.ambiguous,0);
});
test('a different current operation cannot displace the old published tuple or choose by UUID/date',async()=>{
 const f=authorityNativeFixture(),d=f.data.details.values().next().value!,original=d.publications[0]!;d.publications.push({...original,id:reviewId(701),versionId:d.version!.id,state:'verifying'});d.article={...d.article,delivery:'unknown',deliveryPublicationId:reviewId(701)};const p=await load(f);assert.equal(p.coverage.observed,1);assert.ok(p.review?.findings.some(x=>x.evidence.some(e=>e.sourceId.startsWith(original.id+':'))));
});
test('invalid saved delivery is omitted honestly and no public observation is fabricated',async()=>{
 const f=authorityNativeFixture(),d=f.data.details.values().next().value!,original=d.publications[0]!;d.publications[0]={...original,websiteDelivery:{...original.websiteDelivery!,article:{...original.websiteDelivery!.article,url:'https://foreign.example/page'}}};const p=await load(f);assert.equal(p.status,'ready');assert.equal(p.coverage.unusable,1);assert.equal(p.coverage.observed,0);assert.ok(!p.review?.findings.some(x=>x.evidence.some(e=>e.source==='served_delivery')));
});
test('published detail coverage is capped at30 and real concurrent reads at3',async()=>{
 const f=authorityNativeFixture(40);f.setDelay(5);const p=await load(f);assert.equal(p.coverage.publishedArticles,40);assert.equal(p.coverage.detailReads,30);assert.equal(p.coverage.omitted,10);assert.equal(p.coverage.observed,30);assert.equal(f.calls.filter(c=>c.method==='getArticle').length,30);assert.ok(f.maxActive<=3&&f.maxActive>1);assert.match(authorityProgrammeContent(p),/10 are outside this bounded review/u);
});
test('raw documents, blob IDs, brand settings, article body and sealed publication data never enter the page model',async()=>{
 const p=await load(authorityNativeFixture()),json=JSON.stringify(p);assert.doesNotMatch(json,/DO_NOT_RETURN_/u);assert.ok(p.review?.identity.knowledgeSha256);assert.ok(p.review?.identity.deliverySha256);
});
test('foreign records and read failures do not leak private context or return partial authorised results',async()=>{
 const foreign=authorityNativeFixture();foreign.data.documents[0]={...foreign.data.documents[0]!,brandId:reviewId(900)};await assert.rejects(load(foreign),{status:503});const fail=authorityNativeFixture();fail.before(method=>{if(method==='getInventory')throw new Error('SECRET_DATABASE_CONNECTION');});await assert.rejects(load(fail),e=>e instanceof SeoBlogError&&e.status===503&&!e.message.includes('SECRET'));
});
test('setup and ready fragments escape owner supplied labels and expose no fake mutation controls',async()=>{
 const f=authorityNativeFixture();f.data.brand={...f.data.brand,name:'<script>alert(1)</script>'};const ready=await load(f),html=authorityProgrammeContent(ready);assert.match(html,/&lt;script&gt;/u);assert.doesNotMatch(html,/<script>|<form|Approve proposal|Publish now/u);f.data.profile=null;assert.doesNotMatch(authorityProgrammeContent(await load(f)),/<script>/u);
});
