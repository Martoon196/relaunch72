import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MethodController, MethodRun, libraryPins, loadMethod, resolveMethods, methodHash } from '../src/seo-blog/method-packs.js';
import { MemoryMethodStore } from '../src/seo-blog/method-store.js';
import { confirmedVisualInputs, validateMethodEvidence, selectionCatalogue } from '../src/seo-blog/method-evidence.js';
import { writeArticle, rewriteSection, proposeCluster, researchForPrompt, shortSourceIds } from '../src/seo-blog/generation.js';
import { CampaignCreator, campaignProblems } from '../src/seo-blog/campaign-creator.js';
import { MemorySeoBlogStore } from '../src/seo-blog/store.js';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { UnconfiguredSearchProvider } from '../src/seo-blog/research.js';
import { nativeCsrf, nativeIdentity, nativeSeoCall } from './seo-blog-native-request.js';
import { FakeWeb } from './seo-blog-fixtures.js';
import { fixtureBrand } from './rl72-method-fixtures.js';
import { UpgradeFixtureModel, upgradeSnapshot, campaignBrief, MemoryCreatorFixture } from './rl72-upgrade-fixtures.js';
import { creatorContentFromForm } from '../src/portal/campaign-creator-view.js';
import { discoverMigrations } from '../src/db/migrate.js';
import { assertRuntimeSchemaCurrent } from '../src/db/runtime-readiness.js';
import type { Pool } from 'pg';

async function upgradedBlog(mutate?:UpgradeFixtureModel['mutate']){
 const f=fixtureBrand(),store=new MemoryMethodStore(),model=new UpgradeFixtureModel();model.mutate=mutate??null;
 store.snapshots.set(f.brand.id,upgradeSnapshot(f.brand.id,['production-core','blog-writing','visual-briefing']));
 const controller=new MethodController(store,true),input={...f,stage:'blog',stages:['blog','visual-brief'],assetRef:'article:'+f.brief.id,sources:['S1','fixture-source'],baselineTokens:32000,
  evidence:{research:f.sources,editorialFormat:{formatId:'checklist',rationale:'Checks suit this practical question.'}}};
 const llm=await controller.prepare(model,input),out=await writeArticle(llm,{...f,linkable:[],length:'concise'});
 return {...f,store,model,controller,input,out};
}
export async function creatorFixture(kind:'home'|'b2b'='home'){
 const f=fixtureBrand(kind),blogs=new MemorySeoBlogStore(),actor=f.profile.confirmedBy!;
 const created=await blogs.createBrand({commandId:randomUUID(),actorId:actor,name:f.brand.name,slug:'fixture-'+randomUUID(),website:f.brand.website,now:f.profile.createdAt});
 const brand=await blogs.updateBrand({...created.brand,settings:f.brand.settings});
 const profile={...f.profile,brandId:brand.id};await blogs.saveProfile(profile);
 const methods=new MemoryMethodStore();methods.snapshots.set(brand.id,upgradeSnapshot(brand.id));
 const controller=new MethodController(methods,true),model=new UpgradeFixtureModel(),store=new MemoryCreatorFixture(methods);
 const creator=new CampaignCreator(store,blogs,controller,model);
 const engine=new SeoBlogEngine({store:blogs,methods:controller,creatorStore:store,llm:model,search:new UnconfiguredSearchProvider(),transport:new FakeWeb(),publishers:new Map(),vault:null});
 return {...f,brand,profile,blogs,actor,methods,controller,model,store,creator,engine};
}

test('0.1.1: eight schema-valid exact releases retain original 0.1.0 files and have a broad original selection catalogue',()=>{
 const pins=libraryPins('0.1.1');assert.equal(pins.length,8);assert.equal(libraryPins().length,12);
 const packs=pins.map(loadMethod),catalogue=selectionCatalogue(packs)!;
 assert.equal(catalogue.formats.length,61);assert.equal(catalogue.hooks.length,14);assert.equal(catalogue.structures.length,8);
 assert.equal(new Set(catalogue.formats.map(f=>f.id)).size,61);
 assert.equal(methodHash(readFileSync(new URL('../src/db/migrations/0138_seo_blog_method_packs.sql',import.meta.url),'utf8')),'84f1abb3a152ac93800edbfd92b281d34d31e8ffe4e4ec5b0df2019e806898d8');
 const s=upgradeSnapshot('x');for(const stages of [['planning'],['blog','copy','visual-brief'],['social','visual-brief'],['email'],['advocacy']]){
  const f=fixtureBrand(),r=resolveMethods(s,stages);assert(new MethodRun(new MemoryMethodStore(),{...f,stage:stages[0]!,assetRef:'x',sources:[]},s.assignment!,r.pins,r.packs).compiled.length<65000);
 }
});
test('typed evidence persists the selected format, actual provenance metadata and exact compiled request',async()=>{
 const f=await upgradedBlog();const r=await f.store.receipt(f.brand.id,f.out.record.methodReceiptId!);
 assert.equal((r!.sidecar!.decisions as any).formatDecision.formatId,'checklist');
 assert.match(f.model.requests[0]!.messages[0]!.content,/<method_context>/);assert.match(f.model.requests[0]!.messages[0]!.content,/retrievedAt/);
 assert.equal(r!.promptHash,methodHash(JSON.stringify({system:f.model.requests[0]!.system,messages:f.model.requests[0]!.messages})));
 assert(!('_method_sidecar' in f.out.value));assert.equal(r!.approvalState,'draft');
 const projected=researchForPrompt(shortSourceIds([{...f.sources[0]!,publishedAt:'2026-10-02T00:00:00Z',observedPeriod:'2025 calendar year',confidence:'medium'}])) as any[];
 assert.equal(projected[0].observedPeriod,'2025 calendar year');assert.equal(projected[0].confidence,'medium');assert(projected[0].retrievedAt);
});
for(const [name,mutate] of [
 ['generic pass without evidence',(v:any)=>{delete v._method_sidecar.qualityFindings[0].evidence;}],
 ['unassessed critical review',(v:any)=>{v._method_sidecar.qualityFindings[0].status='not_assessed';}],
 ['invented claim reference',(v:any)=>{v._method_sidecar.decisions.claimLedger=[{text:v.intro,references:['foreign-brand-fact']}];}],
 ['unavailable interview material',(v:any)=>{v._method_sidecar.decisions.formatDecision.formatId='expert-interview';}],
 ['format drift',(v:any)=>{v._method_sidecar.decisions.formatDecision.formatId='how-to';}],
 ['false real-image evidence',(v:any)=>{v._method_sidecar.decisions.visualDecision.evidenceClass='evidential';}],
 ['unverified palette',(v:any)=>{v.image_alt='An illustrative checklist in #ffcc00.';}],
 ['malformed ledger',(v:any)=>{v._method_sidecar.decisions.claimLedger={};}],
 ['fabricated source date',(v:any)=>{v._method_sidecar.decisions.sourceAssessments=[{sourceId:'S1',publishedAt:'2026-11-04',observedPeriod:null,confidence:'high',freshness:'dated',reason:'Invented current date.'}];}]
] as const)test('typed evidence rejects '+name+' with a bounded held receipt',async()=>{
 await assert.rejects(upgradedBlog(mutate),{code:'method_generation_rejected'});
});
test('planner records an eligible format for every article and revision keeps the original format',async()=>{
 const f=await upgradedBlog(),s=upgradeSnapshot(f.brand.id,['production-core','editorial-planning']);f.store.snapshots.set(f.brand.id,s);
 const llm=await f.controller.prepare(f.model,{...f.input,stage:'planning',stages:['planning'],assetRef:'plan:fixture'});
 const plan=await proposeCluster(llm,{brandName:f.brand.name,profile:f.profile,inventory:[],sources:f.sources,focus:null,excluded:[],sourceArticleUrl:null});
 const receipt=await f.store.receipt(f.brand.id,plan.record.methodReceiptId!);assert.equal((receipt!.sidecar!.decisions as any).formatPerArticle.length,7);
 f.store.snapshots.set(f.brand.id,upgradeSnapshot(f.brand.id,['production-core','blog-writing','visual-briefing']));
 const section=await rewriteSection(await f.controller.prepare(f.model,{...f.input,stage:'revision',stages:['revision'],preserveReceiptId:f.out.record.methodReceiptId}),{profile:f.profile,outline:f.brief.outline,section:f.out.value.sections[0]!,instruction:'Clarify the observable check.',sources:f.sources,linkable:[]});
 assert.equal((await f.store.receipt(f.brand.id,section.record.methodReceiptId!))!.pins[0]!.version,'0.1.1');
});
test('confirmed visual guidance excludes retired, stale and other-brand references',()=>{
 const f=fixtureBrand();const doc:any={id:randomUUID(),brandId:f.brand.id,version:1,sha256:'b'.repeat(64),active:true,category:'visual_guidance',text:'Approved palette #112233 and a supplied brand font.'};
 const p={...f.profile,knowledge:[{documentId:doc.id,version:1,sha256:doc.sha256,category:'visual_guidance' as const}]};
 assert.equal(confirmedVisualInputs(p,[doc],'social-post').guidance.length,1);
 assert.equal(confirmedVisualInputs(p,[doc,{...doc,version:2,active:false}],'social-post').guidance.length,0);
 assert.equal(confirmedVisualInputs(p,[{...doc,sha256:'c'.repeat(64)}],'social-post').guidance.length,0);
});
test('email and advocacy authoring produce saved reviewed drafts, durable result text and no delivery effects',async()=>{
 const a=await creatorFixture('home'),b=await creatorFixture('b2b');
 for(const f of [a,b])for(const kind of ['email','advocacy'] as const){
  let r=await f.creator.create(f.actor,f.brand.id,randomUUID(),campaignBrief(f.profile,kind));assert.equal(r.state,'draft');
  assert(r.version?.methodReceiptId);const receipt=await f.methods.receipt(f.brand.id,r.version!.methodReceiptId!);assert(receipt!.resultText);assert.equal(receipt!.resultHash,r.version!.contentSha);
  await assert.rejects(f.creator.export(f.actor,f.brand.id,r.id),/Review and approve/);
  r=await f.creator.approve(f.actor,f.brand.id,r.id,r.rowVersion,r.version!.contentSha,true);
  const exported=JSON.parse(await f.creator.export(f.actor,f.brand.id,r.id));assert.match(exported.status,/not sent/);assert.match(exported.recipientConsent,/Not established/);
  if(kind==='email'){assert.equal(exported.content.emails.length,3);assert.equal(exported.content.emails[0].subjects.length,3);assert(exported.content.emails[0].subjects.includes(exported.content.emails[0].subject));}
  else{assert.equal(exported.content.incentiveTerms,'None');assert(exported.content.consentChecklist.some((s:string)=>/withdrawal/i.test(s)));}
 }
 assert.notEqual(a.profile.audiences[0],b.profile.audiences[0]);assert.equal((await a.blogs.listJobs(a.brand.id)).length,0);
 await assert.rejects(a.creator.get(b.actor,a.brand.id,(await a.creator.list(a.actor,a.brand.id))[0]!.id),/cannot manage/);
});
test('same campaign command never repeats a paid call; a changed brief cannot reuse it',async()=>{
 const f=await creatorFixture(),id=randomUUID(),brief=campaignBrief(f.profile);
 const first=await f.creator.create(f.actor,f.brand.id,id,brief),calls=f.model.requests.length;
 f.store.rows.get(id)!.brief=Object.fromEntries(Object.entries(brief).reverse()) as typeof brief;
 assert.equal((await f.creator.create(f.actor,f.brand.id,id,brief)).id,first.id);assert.equal(f.model.requests.length,calls);
 await assert.rejects(f.creator.create(f.actor,f.brand.id,id,{...brief,goal:'A different purpose.'}),/different inputs/);
});
test('owner edit clears approval and changing the profile holds export',async()=>{
 const f=await creatorFixture();let r=await f.creator.create(f.actor,f.brand.id,randomUUID(),campaignBrief(f.profile));
 r=await f.creator.approve(f.actor,f.brand.id,r.id,r.rowVersion,r.version!.contentSha,true);
 const body=structuredClone(r.version!.content);body.summary='An owner-edited useful sequence, ready for another exact review.';
 r=await f.creator.edit(f.actor,f.brand.id,r.id,r.rowVersion,r.version!.contentSha,body);assert.equal(r.approval,null);assert.equal(r.version!.number,2);assert.equal(r.version!.methodReceiptId,null);
 await assert.rejects(f.creator.export(f.actor,f.brand.id,r.id),/Review and approve/);
 await f.blogs.saveProfile({...f.profile,version:2,factsSha:'d'.repeat(64)});
 await assert.rejects(f.creator.export(f.actor,f.brand.id,r.id),/current campaign/);
});
test('campaign validation rejects foreign audience/actions, invented commercial figures, fake reply subjects and positive-review rewards',async()=>{
 const f=await creatorFixture();const brief=campaignBrief(f.profile);
 await assert.rejects(f.creator.create(f.actor,f.brand.id,randomUUID(),{...brief,audience:'Another brand audience'}),/audience/);
 await assert.rejects(f.creator.create(f.actor,f.brand.id,randomUUID(),{...brief,cta:{label:'Foreign',url:'https://foreign.example/'}}),/confirmed action/);
 const r=await f.creator.create(f.actor,f.brand.id,randomUUID(),brief),body=structuredClone(r.version!.content) as any;
 body.emails[0].body+=' Buy now for £999.';body.emails[0].subjects[0]='Re: we spoke';
 assert(campaignProblems(brief,body,f.profile).some(p=>/Commercial figures/.test(p)));assert(campaignProblems(brief,body,f.profile).some(p=>/subject/.test(p)));
 await assert.rejects(f.creator.create(f.actor,f.brand.id,randomUUID(),{...campaignBrief(f.profile,'advocacy'),incentiveTerms:'Reward for a positive review'}),/positive review/);
});
test('native creator journey protects CSRF, renders both creators, approves/exports, and parses ordinary edit controls',async()=>{
 const f=await creatorFixture(),who=nativeIdentity(f.actor),csrf=nativeCsrf(who),base='/portal/seo-blog/b/'+f.brand.id+'/campaigns';
 let page=await nativeSeoCall(f.engine,{who,method:'GET',path:base});assert.equal(page.status,200);assert.match(page.body,/Inbox Engine/);assert.match(page.body,/Word of Mouth Engine/);
 const b=campaignBrief(f.profile),id=randomUUID(),fields={_csrf:csrf,commandId:id,kind:b.kind,name:b.name,goal:b.goal,audience:b.audience,purpose:b.purpose,count:String(b.count),ctaIndex:'0',offerName:'',permissionContext:b.permissionContext,customerMoment:b.customerMoment,consentProcess:b.consentProcess,incentiveTerms:b.incentiveTerms};
 const denied=await nativeSeoCall(f.engine,{who,method:'POST',path:base+'/create',fields:{...fields,_csrf:'forged'}});assert.equal(denied.status,303);assert.equal(f.model.requests.length,0);
 page=await nativeSeoCall(f.engine,{who,method:'POST',path:base+'/create',fields});assert.equal(page.status,303);assert.doesNotMatch(page.headers.location!,/\?e=/);
 let r=(await f.store.get(f.brand.id,id))!;
 page=await nativeSeoCall(f.engine,{who,method:'GET',path:base+'/'+id});assert.match(page.body,/Chosen subject/);assert.doesNotMatch(page.body,/textarea[^>]*>\s*\{"/);
 const editFields=new URLSearchParams({title:r.version!.content.title,summary:r.version!.content.summary});
 for(const [i,m] of (r.version!.content as any).emails.entries()){editFields.set(`email.${i}.dayOffset`,String(m.dayOffset));editFields.set(`email.${i}.purpose`,m.purpose);m.subjects.forEach((s:string,j:number)=>editFields.set(`email.${i}.subject.${j}`,s));editFields.set(`email.${i}.chosen`,'1');editFields.set(`email.${i}.preview`,m.preview);editFields.set(`email.${i}.body`,m.body);}
 const edited=creatorContentFromForm(r,editFields) as any;assert.equal(edited.emails[0].subject,edited.emails[0].subjects[1]);
 page=await nativeSeoCall(f.engine,{who,method:'POST',path:base+'/'+id+'/approve',fields:{_csrf:csrf,rowVersion:String(r.rowVersion),contentSha:r.version!.contentSha,reviewed:'1'}});assert.equal(page.status,303);
 page=await nativeSeoCall(f.engine,{who,method:'GET',path:base+'/'+id+'/export'});assert.equal(page.status,200);assert.match(page.body,/EMAIL 1/);assert.match(page.body,/not sent or scheduled/);
});
test('exact schema bridge works at 137/138 only when both features are off, then strict 139 is required',async()=>{
 const migrations=await discoverMigrations(),rows=migrations.map(({filename,checksum})=>({filename,checksum}));
 const pool=(r:typeof rows)=>({query:async()=>({rows:r})}) as unknown as Pick<Pool,'query'>;
 const env={RL72_METHOD_SCHEMA_BRIDGE:'138-139',SEO_BLOG_METHOD_PACKS:'false',SEO_BLOG_CAMPAIGN_CREATORS:'false'};
 for(const count of [137,138]){
  await assert.doesNotReject(assertRuntimeSchemaCurrent(pool(rows.slice(0,count)),undefined,env));
  await assert.rejects(assertRuntimeSchemaCurrent(pool(rows.slice(0,count)),undefined,{}),/schema is behind/);
  await assert.rejects(assertRuntimeSchemaCurrent(pool(rows.slice(0,count)),undefined,{...env,SEO_BLOG_METHOD_PACKS:'true'}),/schema is behind/);
 }
 await assert.doesNotReject(assertRuntimeSchemaCurrent(pool(rows),undefined,{}));
 await assert.rejects(assertRuntimeSchemaCurrent(pool([...rows,{filename:'0140_unknown.sql',checksum:'0'.repeat(64)}]),undefined,env),/not present/);
});
