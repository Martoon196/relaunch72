import test from 'node:test';
import assert from 'node:assert/strict';
import { Ajv } from 'ajv';
import { AnthropicClient, providerJsonSchema, type LlmRequest } from '../src/llm/client.js';
import { MethodController } from '../src/seo-blog/method-packs.js';
import { MemoryMethodStore } from '../src/seo-blog/method-store.js';
import { PLAN_SCHEMA, proposeCluster } from '../src/seo-blog/generation.js';
import { fixtureBrand, block } from './rl72-method-fixtures.js';
import { UpgradeFixtureModel, upgradeSnapshot } from './rl72-upgrade-fixtures.js';
import { decodePlanningOutput } from '../src/seo-blog/planning-output.js';

async function plan(mutate?: (v:any,request:LlmRequest)=>void,mutateWire?:(v:any)=>void) {
  const f=fixtureBrand(),store=new MemoryMethodStore(),model=new UpgradeFixtureModel();
  let wire:any;
  store.snapshots.set(f.brand.id,upgradeSnapshot(f.brand.id,['production-core','editorial-planning']));
  model.mutate=(v,request)=>{
    const d=v._method_sidecar.decisions;
    v.pillar.key_points[0]=f.profile.approvedClaims[0];
    v._method_sidecar.evidenceReferences=['profile:1:claim:0'];
    v._method_sidecar.decisions={claimLedger:[{assetPointer:'/asset/pillar/key_points/0',references:['profile:1:claim:0']}],sourceAssessments:[],ownerDecisionsNeeded:[],formatPerArticle:d.formatPerArticle,planningNotes:'The practical checks serve the supplied audience without an invented outcome.'};
    mutate?.(v,request);
    const {_method_sidecar:sidecar,...asset}=structuredClone(v),{decisions,...review}=sidecar;
    for(const key of Object.keys(v))delete v[key];
    Object.assign(v,{planJson:JSON.stringify(asset),_method_sidecar:{...review,decisionsJson:JSON.stringify(decisions)}});
    mutateWire?.(v);
    wire=structuredClone(v);
  };
  const llm=await new MethodController(store,true).prepare(model,{...f,stage:'planning',stages:['planning'],assetRef:'plan:test',sources:['S1','fixture-source'],baselineTokens:16000,evidence:{research:f.sources}});
  const run=(inventory:any[]=[])=>proposeCluster(llm,{brandName:f.brand.name,profile:f.profile,inventory,sources:f.sources,focus:null,excluded:[],sourceArticleUrl:null});
  return {f,store,model,run,wire:()=>wire};
}

test('native planning request carries the full wire grammar once and persists exactly resolved claim text',async()=>{
  const f=await plan();const out=await f.run();const req=f.model.requests[0]!;const wire=f.wire();
  assert.ok(req.outputSchema);assert.equal(req.maxTokens,20000);
  assert.doesNotMatch(req.messages[0]!.content,/<research_sources>|Server response schema/);
  assert.match(req.messages[0]!.content,/<method_context>/);
  const validate=new Ajv({strict:false,allErrors:true}).compile(req.outputSchema!);
  assert.equal(validate(wire),true,JSON.stringify(validate.errors));
  delete wire._method_sidecar.qualityFindings[0].detail;
  assert.equal(validate(wire),false); // The observed production omission is forbidden.
  const receipt=await f.store.receipt(f.f.brand.id,out.record.methodReceiptId!);
  const row=(receipt!.sidecar!.decisions as any).claimLedger[0];
  assert.equal(row.text,out.value.pillar.key_points[0]);assert.equal(row.assetPointer,'/asset/pillar/key_points/0');
  assert.equal(f.model.requests.length,1);assert.equal(f.store.receipts.size,1);
  assert.equal(receipt!.heldResponse,undefined);
  assert(!('_method_sidecar' in out.value));
});

for(const [name,mutate,pattern] of [
  ['foreign reference',(v:any)=>{v._method_sidecar.decisions.claimLedger[0].references=['foreign'];},/supplied reference/],
  ['metadata pointer',(v:any)=>{v._method_sidecar.decisions.claimLedger[0].assetPointer='/asset/pillar/source_ids/0';},/planning prose/],
  ['prototype pointer',(v:any)=>{v._method_sidecar.decisions.claimLedger[0].assetPointer='/asset/__proto__/angle';},/planning prose/],
  ['missing pointer',(v:any)=>{v._method_sidecar.decisions.claimLedger[0].assetPointer='/asset/pillar/key_points/99';},/missing, oversized/],
  ['conflicting copied text',(v:any)=>{v._method_sidecar.decisions.claimLedger[0].text='An invented paraphrase.';},/mismatched claim/],
  ['unsupported numerical claim',(v:any)=>{v.pillar.key_points[0]='The service saves £999 every month.';},/numerical claim/],
  ['unledgered monetary claim',(v:any)=>{v.supporting[0].angle='This service saves £999 for every household.';},/no ledger entry/],
  ['altered provenance',(v:any)=>{v._method_sidecar.decisions.sourceAssessments=[{sourceId:'S1',publishedAt:'2026-01-01',observedPeriod:null,confidence:'unknown',freshness:'evergreen',reason:'A useful source.'}];},/provenance/],
  ['unresolved owner decision',(v:any)=>{v._method_sidecar.decisions.ownerDecisionsNeeded=['Confirm a necessary claim.'];},/Owner decision required/],
  ['missing review detail',(v:any)=>{delete v._method_sidecar.qualityFindings[0].detail;},/Invalid quality finding/],
  ['unavailable format',(v:any)=>{v._method_sidecar.decisions.formatPerArticle[0].formatId='expert-interview';},/eligible format/],
  ['wrong article count',(v:any)=>{v.supporting.pop();v._method_sidecar.decisions.formatPerArticle.pop();},/6 items/],
] as const)test('structured planning still rejects '+name,async()=>{
  const f=await plan(mutate);await assert.rejects(f.run,pattern);assert.equal(f.model.requests.length,2);assert.equal(f.store.receipts.size,1);
  assert.ok(f.model.requests.every(r=>r.outputSchema));
});

test('provider grammar keeps enums, required fields and closed objects while full AJV keeps unsupported bounds',()=>{
  const schema=providerJsonSchema({type:'object',required:['name','values'],properties:{name:{type:'string',minLength:3,enum:['alpha','beta']},values:{type:'array',minItems:6,maxItems:6,items:{type:'string'}}}});
  const p=schema.properties as any;
  assert.equal(schema.additionalProperties,false);assert.deepEqual(p.name.enum,['alpha','beta']);assert.equal(p.name.minLength,undefined);assert.match(p.name.description,/minLength/);
  assert.equal(p.values.minItems,undefined);assert.match(p.values.description,/minItems/);
  const original=new Ajv({strict:false}).compile(PLAN_SCHEMA);assert.equal(original({}),false);
});

test('large ID catalogues stay in guidance instead of expanding the native grammar; server schema still rejects foreign IDs',()=>{
  const ids=Array.from({length:70},(_,i)=>'profile:12:claim:'+i);
  const original={type:'object',required:['reference','status'],properties:{reference:{type:'string',enum:ids},status:{type:'string',enum:['pass','fail']}}};
  const projected=providerJsonSchema(original),p=projected.properties as any;
  assert.equal(p.reference.enum,undefined);assert.match(p.reference.description,/profile:12:claim:69/);
  assert.deepEqual(p.status.enum,['pass','fail']);assert.deepEqual(projected.required,['reference','status']);assert.equal(projected.additionalProperties,false);
  assert.equal(new Ajv({strict:false}).compile(original)({reference:'foreign',status:'pass'}),false);
});

test('the planning envelope preserves actual nulls and exact metadata without inferring or repairing values',async()=>{
  const f=await plan(v=>{v.money_page.url=null;v.pillar.cta_url=null;v._method_sidecar.primaryNextAction=null;v._method_sidecar.decisions.sourceAssessments=[{sourceId:'S1',publishedAt:null,observedPeriod:null,confidence:'unknown',freshness:'evergreen',reason:'The supplied source has unknown publication metadata.'}];});
  const out=await f.run();const receipt=await f.store.receipt(f.f.brand.id,out.record.methodReceiptId!);
  assert.equal(out.value.money_page.url,null);assert.equal(out.value.pillar.cta_url,null);assert.equal(receipt!.sidecar!.primaryNextAction,null);
  assert.equal((receipt!.sidecar!.decisions as any).sourceAssessments[0].publishedAt,null);
  assert.equal(JSON.parse(f.wire().planJson).pillar.cta_url,null);
});

test('wire decoding rejects malformed, oversized, conflicting or non-object JSON; it never manufactures a valid plan',()=>{
  for(const raw of [{planJson:'{'},{planJson:'[]'},{planJson:'x'.repeat(64001)},{planJson:'{"_method_sidecar":{}}'},{planJson:'{}',extra:true},{_method_sidecar:{decisionsJson:'{' }},{_method_sidecar:{decisionsJson:'[]'}},{_method_sidecar:{decisionsJson:'{}',decisions:{}}}])assert.ok(decodePlanningOutput(raw).problems.length);
  const raw={planJson:'{"topic":"An unchanged topic"}',_method_sidecar:{decisionsJson:'{"ownerDecisionsNeeded":[]}'}};
  assert.deepEqual(decodePlanningOutput(raw),{value:{topic:'An unchanged topic',_method_sidecar:{decisions:{ownerDecisionsNeeded:[]}}},problems:[]});
  assert.equal(raw.planJson,'{"topic":"An unchanged topic"}');
});

test('inner JSON uses the existing platform fence/prose extractor, then runs the complete plan and evidence checks',async()=>{
  const fence=(v:any)=>{v.planJson='```json\n'+v.planJson+'\n```';v._method_sidecar.decisionsJson='The decisions follow:\n```json\n'+v._method_sidecar.decisionsJson+'\n```';};
  const f=await plan(undefined,fence);const out=await f.run();assert.equal(out.value.supporting.length,6);assert.ok(out.record.methodReceiptId);
  const bad=await plan(v=>{v._method_sidecar.decisions.claimLedger[0].references=['foreign'];},fence);
  await assert.rejects(bad.run,/supplied reference/);
});

test('an early wire rejection retains the exact final response and known usage in one private immutable receipt',async()=>{
  const f=await plan(undefined,v=>{v._method_sidecar.decisionsJson='not a JSON object';});
  await assert.rejects(f.run,/decisionsJson must contain/);
  const receipt=[...f.store.receipts.values()][0]!;
  assert.equal(receipt.outcome,'rejected');assert.equal(receipt.sidecar,null);assert.equal(receipt.heldDraft,null);
  assert.equal(receipt.heldResponse,JSON.stringify(f.wire()));assert.equal(receipt.usage.tokensIn+receipt.usage.tokensOut,500);
  assert.equal(f.store.receipts.size,1);assert.equal(f.model.requests.length,2);
  assert.ok(Buffer.byteLength(JSON.stringify(receipt),'utf8')<131072);
  await assert.rejects(()=>f.store.saveReceipt(receipt),/immutable/);
});

test('nested review conflicts are rejected with specific feedback and retained instead of discarding the evidence',async()=>{
  const f=await plan(undefined,v=>{v.planJson=JSON.stringify({...JSON.parse(v.planJson),_method_sidecar:{decisions:{ownerDecisionsNeeded:['An unresolved decision']}}});});
  await assert.rejects(f.run,/Keep _method_sidecar outside planJson/);
  const receipt=[...f.store.receipts.values()][0]!;assert.equal(receipt.outcome,'rejected');assert.ok(receipt.heldResponse?.includes('An unresolved decision'));
});

test('one existing planning correction sees both an orphan pointer and an insufficient source',async()=>{
  const f=await plan(v=>{
    v._method_sidecar.decisions.claimLedger[0].assetPointer='/asset/pillar/key_points/99';
    v._method_sidecar.decisions.claimLedger.push({assetPointer:'/asset/supporting/0/key_points/0',references:['S1']});
    v._method_sidecar.decisions.sourceAssessments=[{sourceId:'S1',publishedAt:null,observedPeriod:null,confidence:'unknown',freshness:'insufficient',reason:'No usable evidence has been established for this assertion.'}];
  });
  await assert.rejects(f.run,/claimLedger/);assert.equal(f.model.requests.length,2);
  const critique=f.model.requests[1]!.messages.at(-1)!.content;
  assert.match(critique,/key_points\/99/);assert.match(critique,/zero-based/);
  assert.match(critique,/references S1 without a usable source assessment/);assert.match(critique,/never invent dates or confidence/);
  assert.equal([...f.store.receipts.values()][0]!.outcome,'rejected');
});

test('private correction carries the complete unchanged draft and facts while deduplicating inventory and offer text',async()=>{
  let firstDraft:any;
  const f=await plan((v,req)=>{if(req.meta?.attempt===1){v._method_sidecar.decisions.claimLedger[0].assetPointer='/asset/pillar/key_points/99';firstDraft=structuredClone(v);}});
  const url='https://hearth.example/guide',canonical='https://hearth.example/guide-canonical';
  const out=await f.run([{url,canonical,fetchStatus:'ok',title:'An existing website guide',headings:['Its existing heading'],editorial:true}]);
  assert.ok(out.record.methodReceiptId);assert.equal(f.model.requests.length,2);
  const [first,second]=f.model.requests;
  const assistant=second!.messages.find(m=>m.role==='assistant');assert.ok(assistant);
  assert.deepEqual(JSON.parse(assistant!.content),firstDraft); // No fact, field or failed finding repaired by the server.
  assert.deepEqual(block(first!.messages[0]!.content,'method_context'),block(second!.messages[0]!.content,'method_context'));
  const before=block(first!.messages[0]!.content,'brand_profile'),after=block(second!.messages[0]!.content,'brand_profile');
  for(const key of ['summary','audiences','positioning','conversionPages','voice','exclusions','unresolvedConflicts','missingFacts'])assert.deepEqual(after[key],before[key]);
  assert.equal(after.approvedClaims,undefined);assert.equal(after.approvedClaimReferences.length,f.f.profile.approvedClaims.length);
  assert.deepEqual(after.offers.map((o:any)=>[o.name,o.url,o.sourceDocumentId]),before.offers.map((o:any)=>[o.name,o.url,o.sourceDocumentId]));
  assert.deepEqual(block(second!.messages[0]!.content,'website_inventory'),[{url},{url:canonical}]);
  assert.match(second!.system,/complete verified claims and full offer facts remain in method_context.factReferences/);
  assert.ok(Buffer.byteLength(JSON.stringify(second),'utf8')<150000);
});

test('malformed basic review shape still holds safely before deeper evidence evaluation',async()=>{
  const f=await plan(v=>{v._method_sidecar.qualityFindings[0]=null;});await assert.rejects(f.run,/Invalid quality findings/);
  assert.equal(f.model.requests.length,2);assert.equal([...f.store.receipts.values()][0]!.outcome,'rejected');
});

test('Anthropic serializes native output_config only when requested; streaming and usage are preserved',async()=>{
  const client=new AnthropicClient('fictional-test-key');const sent:any[]=[];
  (client as any).client={messages:{stream:(params:any)=>{sent.push(params);return {finalMessage:async()=>({content:[{type:'text',text:'{}'}],usage:{input_tokens:11,output_tokens:3},stop_reason:'end_turn',model:'fixture'})};}}};
  const req:LlmRequest={model:'claude-sonnet-4-6',maxTokens:100,system:'test',messages:[{role:'user',content:'test'}],thinking:false};
  await client.complete(req);const result=await client.complete({...req,outputSchema:{type:'object',properties:{answer:{type:'string'}},required:['answer']}});
  assert.equal(sent[0].output_config,undefined);assert.equal(sent[1].output_config.format.type,'json_schema');
  assert.equal(sent[1].output_config.format.schema.additionalProperties,false);assert.equal(result.tokensIn+result.tokensOut,14);
});
