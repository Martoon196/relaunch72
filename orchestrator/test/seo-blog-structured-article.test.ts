import test from 'node:test';
import assert from 'node:assert/strict';
import {Ajv2020} from 'ajv/dist/2020.js';
import {MethodController} from '../src/seo-blog/method-packs.js';
import {MemoryMethodStore} from '../src/seo-blog/method-store.js';
import {writeArticle} from '../src/seo-blog/generation.js';
import {fixtureBrand,block} from './rl72-method-fixtures.js';
import {UpgradeFixtureModel,upgradeSnapshot} from './rl72-upgrade-fixtures.js';
import type {LlmRequest} from '../src/llm/client.js';
import {decodeArticleOutput,resolveArticleEvidence} from '../src/seo-blog/article-output.js';

async function article(mutate?:(v:any,r:LlmRequest)=>void,visual?:any){
 const f=fixtureBrand(),store=new MemoryMethodStore(),model=new UpgradeFixtureModel();
 store.snapshots.set(f.brand.id,upgradeSnapshot(f.brand.id,['production-core','blog-writing','visual-briefing']));
 const original=model.complete.bind(model);let prior:any;
 model.complete=async r=>{const reply=await original(r),v=JSON.parse(reply.text);mutate?.(v,r);prior=structuredClone(v);
   const {_method_sidecar:s,...asset}=v,{decisions,...review}=s;
   return {...reply,text:JSON.stringify({article:asset,_method_sidecar:{...review,decisionsJson:JSON.stringify(decisions)}})};
 };
 const llm=await new MethodController(store,true).prepare(model,{...f,stage:'blog',stages:['blog','visual-brief'],assetRef:'article:'+f.brief.id,sources:['S1','fixture-source'],baselineTokens:32000,evidence:{research:f.sources,editorialFormat:{formatId:'checklist',rationale:'Practical checks suit this question.'},...(visual?{visual}:{})}});
 const run=(linkable:any[]=[])=>writeArticle(llm,{...f,linkable,length:'concise'});
 return {f,store,model,run,prior:()=>prior};
}

test('private article native envelope requires every detail and decodes the complete original article and decisions',async()=>{
 const f=await article(),out=await f.run();const request=f.model.requests[0]!;
 assert.ok(out.record.methodReceiptId);assert.ok(request.outputSchema);
 assert.deepEqual((request.outputSchema as any).required,['article','_method_sidecar']);
 const schema:any=request.outputSchema,validate=new Ajv2020({strict:false}).compile(schema);
 const prior=f.prior(),{_method_sidecar:s,...asset}=prior,{decisions,...review}=s;
 const wire={article:asset,_method_sidecar:{...review,decisionsJson:JSON.stringify(decisions)}};
 assert.deepEqual(Object.keys(schema.properties),['article','_method_sidecar']);
 assert.ok(Object.keys(schema.properties._method_sidecar.properties).indexOf('decisionsJson')<Object.keys(schema.properties._method_sidecar.properties).indexOf('qualityFindings'));
 assert.equal(validate(wire),true);delete wire._method_sidecar.qualityFindings[0].detail;assert.equal(validate(wire),false);
 assert.equal(out.value.title,prior.title);assert.deepEqual(out.value.sections,prior.sections);
 const receipt=[...f.store.receipts.values()][0]!;assert.equal(receipt.outcome,'accepted');assert.equal(receipt.heldResponse,undefined);
 assert.deepEqual(receipt.sidecar?.decisions,decisions);
});

test('native article schema and the existing correction reject a section fragment even when its method review also fails',async()=>{
 const f=await article((v,r)=>{if(r.meta?.attempt===1){const section=v.sections[0];for(const k of Object.keys(v))if(k!=='_method_sidecar')delete v[k];Object.assign(v,section);v._method_sidecar.qualityFindings[0].evidence=['/asset/absent'];}});
 const out=await f.run();assert.ok(out.value.sections.length);assert.equal(f.model.requests.length,2);
 const schema:any=f.model.requests[0]!.outputSchema,validate=new Ajv2020({strict:false}).compile(schema);
 assert.equal(validate({article:{heading:'A section',body:'Only one section.'},_method_sidecar:{}}),false);
 const feedback=f.model.requests[1]!.messages.at(-1)!.content;
 assert.match(feedback,/required property 'title'/);assert.match(feedback,/required property 'sections'/);
});

test('article prose selectors bind exact existing paragraphs before the original evidence guards',async()=>{
 const f=await article(v=>{
   v._method_sidecar.decisions.claimLedger=[{assetPointer:'/asset/intro',paragraphIndex:null,references:['profile:1:claim:0']}];
   v._method_sidecar.decisions.mechanismMap=[{assetPointer:'/asset/intro',paragraphIndex:0,reason:'The recorded check makes an unknown visible before deciding.'}];
 });
 const out=await f.run(),receipt=[...f.store.receipts.values()][0]!;
 const bound=receipt.sidecar!.decisions as {claimLedger:{text:string}[];mechanismMap:{recommendation:string}[]};
 assert.equal(bound.claimLedger[0]!.text,out.value.intro);
 assert.equal(bound.mechanismMap[0]!.recommendation,out.value.intro);
 assert.equal(f.model.requests.length,1);
 const asset={intro:' First paragraph.\r\n \r\nSecond paragraph. ',sections:[{body:'Section prose.'}]};
 const sidecar:any={decisions:{claimLedger:[{assetPointer:'/asset/intro',paragraphIndex:1,references:['S1']}],mechanismMap:[{assetPointer:'/asset/sections/0/body',paragraphIndex:null,reason:'A reason.'}]}};
 assert.deepEqual(resolveArticleEvidence(sidecar,asset),[]);assert.equal(sidecar.decisions.claimLedger[0].text,'Second paragraph. ');assert.equal(asset.intro,' First paragraph.\r\n \r\nSecond paragraph. ');
});

for(const [name,row] of [
 ['metadata',{assetPointer:'/asset/public_source_ids/0',paragraphIndex:null}],
 ['prototype',{assetPointer:'/asset/__proto__/body',paragraphIndex:null}],
 ['missing field',{assetPointer:'/asset/sections/9/body',paragraphIndex:null}],
 ['missing paragraph',{assetPointer:'/asset/intro',paragraphIndex:2}],
 ['negative paragraph',{assetPointer:'/asset/intro',paragraphIndex:-1}],
 ['fractional paragraph',{assetPointer:'/asset/intro',paragraphIndex:0.5}],
 ['string paragraph',{assetPointer:'/asset/intro',paragraphIndex:'0'}],
 ['conflicting copied text',{assetPointer:'/asset/intro',paragraphIndex:null,text:'Invented paraphrase'}],
] as const)test('article selectors reject '+name,async()=>{
 const f=await article(v=>{v._method_sidecar.decisions.claimLedger=[{...row,references:['profile:1:claim:0']}];});
 await assert.rejects(f.run,/claimLedger\[0\]/);assert.equal([...f.store.receipts.values()][0]!.outcome,'rejected');
});

test('selector resolution preserves oversized-quote, mechanism and unsupported-numeric rejections',async()=>{
 for(const mutate of [
  (v:any)=>{v.intro='A long selected paragraph. '.repeat(80);v._method_sidecar.decisions.claimLedger=[{assetPointer:'/asset/intro',paragraphIndex:null,references:['profile:1:claim:0']}];},
  (v:any)=>{v._method_sidecar.decisions.mechanismMap=[{assetPointer:'/asset/sections/99/body',paragraphIndex:null,reason:'A recorded reason.'}];},
  (v:any)=>{v.intro='The product guarantees a 98765 percent return.';v._method_sidecar.decisions.claimLedger=[{assetPointer:'/asset/intro',paragraphIndex:null,references:['profile:1:claim:0']}];},
 ]){const f=await article(mutate);await assert.rejects(f.run);assert.equal([...f.store.receipts.values()][0]!.outcome,'rejected');}
});

test('legacy article JSON and canonical receipts remain transport-compatible without inventing fields',()=>{
 const canonical={title:'Original title',_method_sidecar:{decisions:{claimLedger:[{text:'A legacy exact quote',references:['S1']}]}}};
 assert.deepEqual(decodeArticleOutput(canonical),{value:canonical,problems:[]});
 const {decisions}=canonical._method_sidecar;
 assert.deepEqual(decodeArticleOutput({articleJson:JSON.stringify({title:canonical.title}),_method_sidecar:{decisionsJson:JSON.stringify(decisions)}}),{value:canonical,problems:[]});
 assert.ok(decodeArticleOutput({article:{intro:'x'.repeat(64001)}}).problems.length);
 assert.ok(decodeArticleOutput({article:{title:'A title'},extra:'conflicting'}).problems.length);
});

test('the existing article correction receives the entire prior draft, unchanged facts/sources and the same link URLs',async()=>{
 let first:any;
 const f=await article((v,r)=>{if(r.meta?.attempt===1){v._method_sidecar.decisions.claimLedger=[{text:'A paraphrase absent from the actual returned article',references:['profile:1:claim:0']}];first=structuredClone(v);}});
 const out=await f.run([{url:'https://hearth.example/guide',title:'Existing title'}]);assert.ok(out.record.methodReceiptId);assert.equal(f.model.requests.length,2);
 const [a,b]=f.model.requests;assert.deepEqual(JSON.parse(b!.messages.find(m=>m.role==='assistant')!.content),first);
 const context=block(a!.messages[0]!.content,'method_context');assert.deepEqual(context,block(b!.messages[0]!.content,'method_context'));
 assert.equal(context.research[0].publishedAt,f.f.sources[0]!.publishedAt??null);
 assert.equal(context.research[0].confidence,f.f.sources[0]!.confidence??'unknown');
 const profile=block(a!.messages[0]!.content,'brand_profile');assert.equal(profile.approvedClaimReferences.length,f.f.profile.approvedClaims.length);
 assert.equal(profile.approvedClaims,undefined);assert.deepEqual(profile.voice,f.f.profile.voice);assert.deepEqual(profile.missingFacts,f.f.profile.missingFacts);
 assert.deepEqual(block(b!.messages[0]!.content,'linkable_pages').map((l:any)=>l.url),block(a!.messages[0]!.content,'linkable_pages').map((l:any)=>l.url));
 assert.ok(block(b!.messages[0]!.content,'linkable_pages').some((l:any)=>l.url==='https://hearth.example/guide'));
 assert.doesNotMatch(a!.messages[0]!.content,/<research_sources>/);assert.match(a!.system,/Complete verified claims and full offer facts appear once/);
 assert.ok(f.model.requests.every(r=>Buffer.byteLength(JSON.stringify(r),'utf8')<=150000));
});

test('a genuine no-assets review may evidence the empty used-asset list without inventing an image',async()=>{
 const f=await article(v=>{v._method_sidecar.qualityFindings.find((q:any)=>q.ruleId==='visual.check-assets-exist').evidence=['/decisions/visualDecision/assetIds'];});
 assert.ok((await f.run()).record.methodReceiptId);assert.equal(f.model.requests.length,1);
});

for(const [name,mutate,visual] of [
 ['unrelated empty evidence',(v:any)=>{v._method_sidecar.qualityFindings.find((q:any)=>q.ruleId==='core.check-claims-supported').evidence=['/decisions/visualDecision/assetIds'];}],
 ['invented evidential assets',(v:any)=>{v._method_sidecar.decisions.visualDecision.evidenceClass='evidential';v._method_sidecar.qualityFindings.find((q:any)=>q.ruleId==='visual.check-assets-exist').evidence=['/decisions/visualDecision/assetIds'];}],
 ['wrong visual placement',(v:any)=>{v._method_sidecar.decisions.visualDecision.placement='social-post';v._method_sidecar.qualityFindings.find((q:any)=>q.ruleId==='visual.check-assets-exist').evidence=['/decisions/visualDecision/assetIds'];}],
 ['invented visual guidance',(v:any)=>{v._method_sidecar.decisions.visualDecision.styleReferences=['made-up'];v._method_sidecar.qualityFindings.find((q:any)=>q.ruleId==='visual.check-assets-exist').evidence=['/decisions/visualDecision/assetIds'];}],
 ['empty-list proof when a supplied asset exists',(v:any)=>{v._method_sidecar.qualityFindings.find((q:any)=>q.ruleId==='visual.check-assets-exist').evidence=['/decisions/visualDecision/assetIds'];},{placement:'article-hero',guidance:[],assets:[{id:'real-supplied',sha256:'a'.repeat(64),kind:'illustration',description:'A supplied illustration.'}]}],
] as const)test('article evidence still rejects '+name,async()=>{
 const f=await article(mutate,visual);await assert.rejects(f.run,/evidence|Visual/);assert.equal(f.model.requests.length,2);assert.equal([...f.store.receipts.values()][0]!.outcome,'rejected');
});

test('missing review detail is identified and retained; the server never manufactures passing findings',async()=>{
 const f=await article(v=>{delete v._method_sidecar.qualityFindings[0].detail;});await assert.rejects(f.run,/Invalid quality finding core.check-claims-supported/);
 assert.match(f.model.requests[1]!.messages.at(-1)!.content,/detail must be a meaningful string/);
 const receipt=[...f.store.receipts.values()][0]!;assert.equal(receipt.outcome,'rejected');assert.equal((receipt.sidecar!.qualityFindings as any[])[0].detail,undefined);
});

test('article metadata and exact quotations remain mandatory after wire decoding',async()=>{
 for(const mutate of [(v:any)=>{v._method_sidecar.decisions.sourceAssessments=[{sourceId:'S1',publishedAt:'2000-01-01',observedPeriod:null,confidence:'unknown',freshness:'evergreen',reason:'General guidance from the supplied source.'}];},(v:any)=>{v._method_sidecar.decisions.mechanismMap[0].recommendation='A recommendation absent from the returned prose';}]){
  const f=await article(mutate);await assert.rejects(f.run,/provenance|VERBATIM/);assert.equal([...f.store.receipts.values()][0]!.outcome,'rejected');
 }
});

test('quality review can inspect a complete long article section while exact claim spans remain bounded',async()=>{
 const mutate=(v:any)=>{v.sections[0].body='A bounded paragraph explaining an observable preparation check. '.repeat(40);v._method_sidecar.qualityFindings[0].evidence=['/asset/sections/0/body'];};
 const f=await article(mutate);assert.ok((await f.run()).record.methodReceiptId);
 const invalid=await article(v=>{mutate(v);v._method_sidecar.decisions.claimLedger=[{text:v.sections[0].body,references:['profile:1:claim:0']}];});
 await assert.rejects(invalid.run,/claimLedger\[0\]/);
});

test('a confirmed brief CTA remains usable when a bounded inventory omits it; other URLs remain rejected',async()=>{
 const f=await article(v=>{v.conclusion+=` [Take the next step](${f.f.brief.cta!.url})`;});
 assert.ok((await f.run()).record.methodReceiptId);
 assert.ok(block(f.model.requests[0]!.messages[0]!.content,'linkable_pages').some((l:any)=>l.url===f.f.brief.cta!.url));
 const foreign=await article(v=>{v.conclusion+=' [Unapproved next step](https://foreign.example/unapproved)';});
 (foreign.f.brief as any).cta={url:'https://foreign.example/unapproved',label:'Unapproved conversion page'};
 await assert.rejects(foreign.run,/not a listed page or source/);
});
