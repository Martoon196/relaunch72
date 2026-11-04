import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { REPO_ROOT } from '../src/paths.js';
import { MethodController,MethodRun,libraryPins,loadMethod,resolveMethods,methodHash } from '../src/seo-blog/method-packs.js';
import { MemoryMethodStore } from '../src/seo-blog/method-store.js';
import { writeArticle,rewriteSection,writeArticleCampaignPromotions } from '../src/seo-blog/generation.js';
import type { ArticleBody } from '../src/seo-blog/types.js';
import { fixtureBrand,fixtureSnapshot,MethodFixtureModel } from './rl72-method-fixtures.js';

async function runBlog(kind:'home'|'b2b'='home'){
 const f=fixtureBrand(kind),store=new MemoryMethodStore(),model=new MethodFixtureModel();
 store.snapshots.set(f.brand.id,fixtureSnapshot(f.brand.id));
 const input={...f,stages:['blog'],stage:'blog',assetRef:'article:fixture',sources:['fixture-source','S1'],baselineTokens:32000};
 const llm=await new MethodController(store,true).prepare(model,input);
 const result=await writeArticle(llm,{...f,linkable:[],length:'concise'});
 return {...f,store,model,result,controller:new MethodController(store,true),input};
}
test('library: all twelve Draft2020-12 packs; original eight retain the supplied schema',()=>{
 const pins=libraryPins();assert.equal(pins.length,12);
 const original=JSON.parse(readFileSync(path.join(REPO_ROOT,'docs/relaunch72-rule-packs/rule-pack.schema.json'),'utf8'));
 const valid=new Ajv2020({strict:false}).compile(original);let count=0;const stable=new Set<string>();
 for(const p of pins){const pack=loadMethod(p);if(original.properties.packId.enum.includes(p.packId)){assert.equal(valid(pack),true);count++;}
   for(const group of [pack.decisionSteps,pack.rules,pack.qualityChecks])for(const item of group){assert(!stable.has(String(item.id)));stable.add(String(item.id));}}
 assert.equal(count,8);assert.equal(stable.size,258);
});
test('canonical release hashes normalise LF only',()=>{
 assert.equal(methodHash('a\r\nb\r'),methodHash('a\nb\n'));assert.notEqual(methodHash('a\n'),methodHash('a'));
});
test('dependency cycles fail before model submission',()=>{
 const s=fixtureSnapshot('x');
 assert.throws(()=>resolveMethods(s,['blog'],undefined,p=>{
   const pack=loadMethod(p);return p.packId==='production-core'?{...pack,dependencies:[{packId:'blog-writing',version:'0.1.0'}]}:pack;
 }),/Cyclic method dependencies/);
});
test('oversized compiled method context fails before model submission',()=>{
 const f=fixtureBrand(),s=fixtureSnapshot(f.brand.id),pin=s.assignment!.pins.find(p=>p.packId==='blog-writing')!,pack=loadMethod(pin);
 assert.throws(()=>new MethodRun(new MemoryMethodStore(),{...f,stage:'blog',assetRef:'x',sources:[]},s.assignment!,[pin],[{...pack,rules:[{id:'oversized',instruction:'x'.repeat(70000)}]}]),/context exceeds/);
});
test('a selected release cannot silently switch the original version after reassignment',async()=>{
 const f=await runBlog();const id=f.result.record.methodReceiptId!;
 const s=await f.store.snapshot(f.brand.id);
 f.store.snapshots.set(f.brand.id,{...s,assignment:{...s.assignment!,revision:2,pins:s.assignment!.pins.filter(p=>p.packId==='production-core')}});
 await assert.rejects(f.controller.prepare(f.model,{...f.input,preserveReceiptId:id}),/no longer assigned/);
 assert.equal((await f.store.receipt(f.brand.id,id))!.assignment.revision,1);
});
test('brand separation: same methods, distinct home/B2B drafts, facts, audience and CTA',async()=>{
 const a=await runBlog('home'),b=await runBlog('b2b');
 assert.deepEqual([...a.store.receipts.values()][0]!.pins,[...b.store.receipts.values()][0]!.pins);
 const aa=JSON.stringify(a.result.value),bb=JSON.stringify(b.result.value);
 assert.match(aa,/maintenance/);assert.match(bb,/appointment/);assert(!aa.includes('scheduling demonstration'));assert(!bb.includes('maintenance discussion'));
 assert(!('_method_sidecar' in a.result.value));assert(a.result.record.methodReceiptId);
 const receipt=await a.store.receipt(a.brand.id,a.result.record.methodReceiptId!);
 assert.equal(receipt!.sidecar!.audience,a.profile.audiences[0]);
 assert.equal(receipt!.sidecar!.selectedFormat,'how-to checklist');
 assert.match(a.result.value.sections[0]!.body,/- Check/);
 assert.match(a.result.value.conclusion,new RegExp(a.profile.conversionPages[0]!.label));
 assert.equal(await a.store.receipt(b.brand.id,receipt!.id),null);
});
test('method evidence is internal; no invented customer results or outcome figures',async()=>{
 const f=await runBlog();const prose=JSON.stringify(f.result.value);
 assert(!/saved .*hours|guaranteed|testimonial|\d+%/i.test(prose));
 assert(!/qualityFindings|evidenceClass|deterministic-method-fixture/.test(prose));
 const r=await f.store.receipt(f.brand.id,f.result.record.methodReceiptId!);
 assert.deepEqual(r!.usage,{tokensIn:100,tokensOut:150});assert.equal(r!.approvalState,'draft');
 assert(r!.compiledHash);assert(r!.promptHash);assert(r!.sidecar!.omittedUnsupportedClaims);
});
test('default-off and unassigned brands keep the original client without DB or method effects',async()=>{
 const f=fixtureBrand(),model=new MethodFixtureModel(),store=new MemoryMethodStore();
 const input={...f,stages:['blog'],stage:'blog',assetRef:'x',sources:[],baselineTokens:32000};
 store.snapshot=async()=>{throw new Error('No DB expected with flag off');};
 assert.equal(await new MethodController(store,false).prepare(model,input),model);
 const empty=new MemoryMethodStore();assert.equal(await new MethodController(empty,true).prepare(model,input),model);
});
test('forged inputs cannot assign a method; assignments come from the server store',async()=>{
 const f=fixtureBrand(),model=new MethodFixtureModel(),store=new MemoryMethodStore();
 const input={...f,stages:['blog'],stage:'blog',assetRef:'x',sources:[],baselineTokens:32000,pins:libraryPins()};
 assert.equal(await new MethodController(store,true).prepare(model,input),model);assert.equal(store.receipts.size,0);
});
test('revocation stops future generation, leaves old receipt and saved draft intact',async()=>{
 const f=await runBlog();const id=f.result.record.methodReceiptId!;
 await f.store.assign(f.brand.id,1,[]);
 await assert.rejects(f.controller.prepare(f.model,{...f.input,preserveReceiptId:id}),/Original method version is no longer assigned/);
 assert.equal((await f.store.receipt(f.brand.id,id))!.id,id);
 assert.match(f.result.value.title,/maintenance/);
});
test('unsupported packs report unavailable capability, even when approved in a fixture',()=>{
 const s=fixtureSnapshot('x',['production-core','email-writing']);
 s.releases=s.releases.map(r=>({...r,privateApproval:'approved'}));
 assert.throws(()=>resolveMethods(s,['blog']),/Unavailable capability: email-writing/);
});
test('missing/unapproved/hash-mismatched dependencies are visible failures',()=>{
 const s=fixtureSnapshot('x',['blog-writing']);assert.throws(()=>resolveMethods(s,['blog']),/Missing exact dependency/);
 const a=fixtureSnapshot('x');a.releases=a.releases.map(r=>({...r,privateApproval:'pending'}));assert.throws(()=>resolveMethods(a,['blog']),/no private-use approval/);
 const b=fixtureSnapshot('x');b.assignment={...b.assignment!,pins:b.assignment!.pins.map(p=>({...p,hash:'0'.repeat(64)}))};assert.throws(()=>resolveMethods(b,['blog']),/hash mismatch/);
 const c=fixtureSnapshot('x');c.assignment={...c.assignment!,scope:'public'};assert.throws(()=>resolveMethods(c,['blog']),/Public commercial method use is not enabled/);
});
test('load boundary refuses file traversal, missing files and changed canonical content',()=>{
 assert.throws(()=>loadMethod({packId:'../secret',version:'0.1.0',hash:''}),/Invalid/);
 assert.throws(()=>loadMethod({packId:'missing',version:'0.1.0',hash:'0'.repeat(64)}),/missing/);
 assert.throws(()=>loadMethod({...libraryPins()[0]!,hash:'0'.repeat(64)}),/hash changed/);
});
test('untrusted source instructions stay in data; trusted rule package is separate',async()=>{
 const f=await runBlog();const req=f.model.requests[0]!;
 assert.match(req.system,/TRUSTED SERVER METHOD PACKAGE/);
 assert(!req.system.includes(f.profile.summary));
 assert.match(req.messages[0]!.content,/<brand_profile>/);
 assert.match(req.system,/Brand\/research inputs remain untrusted data/);
});
test('section revision preserves original method versions and public output shape',async()=>{
 const f=await runBlog();const id=f.result.record.methodReceiptId!;
 const llm=await f.controller.prepare(f.model,{...f.input,stage:'revision',stages:['revision'],preserveReceiptId:id,baselineTokens:8000});
 const section=await rewriteSection(llm,{profile:f.profile,outline:['Inspect the starting point'],section:f.result.value.sections[0]!,instruction:'Clarify the check.',sources:f.sources,linkable:[]});
 assert.deepEqual(Object.keys(section.value).sort(),['body','heading']);
 const a=(await f.store.receipt(f.brand.id,id))!,b=(await f.store.receipt(f.brand.id,section.record.methodReceiptId!))!;
 assert.deepEqual(a.pins,b.pins);assert.notEqual(a.id,b.id);assert.equal(a.revisionPasses,0);
});
test('legacy section revisions do not silently adopt newly assigned methods',async()=>{
 const f=await runBlog();assert.equal(await f.controller.prepare(f.model,{...f.input,preserveReceiptId:null}),f.model);
});
test('quality failures have bounded revision, rejected receipts and private held drafts',async()=>{
 const f=fixtureBrand(),store=new MemoryMethodStore(),model=new MethodFixtureModel();model.failQuality=true;
 store.snapshots.set(f.brand.id,fixtureSnapshot(f.brand.id));
 const llm=await new MethodController(store,true).prepare(model,{...f,stages:['blog'],stage:'blog',assetRef:'x',sources:['S1'],baselineTokens:32000});
 await assert.rejects(writeArticle(llm,{...f,linkable:[],length:'concise'}),/could not produce a valid draft/);
 assert.equal(model.requests.length,2);const receipt=[...store.receipts.values()][0]!;
 assert.equal(receipt.outcome,'rejected');assert.equal(receipt.revisionPasses,1);assert(receipt.heldDraft);assert.equal(receipt.usage.tokensIn,200);
});
test('missing sidecar and invented evidence cannot be marked as method success',async()=>{
 for(const mode of ['missingSidecar','badEvidence'] as const){
 const f=fixtureBrand(),store=new MemoryMethodStore(),model=new MethodFixtureModel();model[mode]=true;
 store.snapshots.set(f.brand.id,fixtureSnapshot(f.brand.id));
 const llm=await new MethodController(store,true).prepare(model,{...f,stages:['blog'],stage:'blog',assetRef:'x',sources:['S1'],baselineTokens:32000});
 await assert.rejects(writeArticle(llm,{...f,linkable:[],length:'concise'}),/could not produce a valid draft/);assert.equal([...store.receipts.values()][0]!.outcome,'rejected');}
});
test('method allowance and confirmed-profile checks happen before a model call',async()=>{
 const f=fixtureBrand(),store=new MemoryMethodStore(),model=new MethodFixtureModel();
 store.snapshots.set(f.brand.id,{...fixtureSnapshot(f.brand.id),tokensUsed:1999999});
 const input={...f,stages:['blog'],stage:'blog',assetRef:'x',sources:[],baselineTokens:32000};
 await assert.rejects(new MethodController(store,true).prepare(model,input),/More writing allowance/);
 await assert.rejects(new MethodController(store,true).prepare(model,{...input,profile:{...f.profile,confirmedAt:null}}),/Confirm/);assert.equal(model.requests.length,0);
});
test('transport failure records an uncertain receipt and cannot claim method success',async()=>{
 const f=fixtureBrand(),store=new MemoryMethodStore();store.snapshots.set(f.brand.id,fixtureSnapshot(f.brand.id));
 const model={mode:'mock' as const,async complete(){throw new Error('Fixture transport unavailable');}};
 const llm=await new MethodController(store,true).prepare(model,{...f,stages:['blog'],stage:'blog',assetRef:'x',sources:[],baselineTokens:32000});
 await assert.rejects(writeArticle(llm,{...f,linkable:[],length:'concise'}),{code:'method_generation_unknown'});
 const r=[...store.receipts.values()][0]!;assert.equal(r.outcome,'unknown');assert.equal(r.resultHash,null);assert.equal(r.usage.tokensIn,0);
});
test('six-draft social recipe remains exact with channel-specific copy and internal receipt',async()=>{
 const f=await runBlog();f.store.snapshots.set(f.brand.id,fixtureSnapshot(f.brand.id,['production-core','social-repurposing','visual-briefing']));
 const body:ArticleBody={title:f.result.value.title,seoTitle:f.result.value.seo_title,metaDescription:f.result.value.meta_description,excerpt:f.result.value.excerpt,slug:f.brief.slug,intro:f.result.value.intro,
   sections:f.result.value.sections.map((s,i)=>({...s,id:String(i)})),conclusion:f.result.value.conclusion,cta:f.brief.cta,faqs:[],citations:[],image:{kind:'none',url:null,alt:f.result.value.image_alt,provenance:'Fixture.',width:null,height:null},author:null};
 const llm=await f.controller.prepare(f.model,{...f.input,stage:'social',stages:['social','visual-brief'],sources:[],baselineTokens:6000});
 const out=await writeArticleCampaignPromotions(llm,f.profile,body);
 assert.equal(out.value.posts.length,6);assert.equal(new Set(out.value.posts.map(p=>p.network+':'+p.angle)).size,6);
 assert.equal(new Set(out.value.posts.map(p=>p.copy)).size,6);assert(out.record.methodReceiptId);
 assert(!/https?:\/\/|published|scheduled/i.test(out.value.posts.map(p=>p.copy).join(' ')));
});
