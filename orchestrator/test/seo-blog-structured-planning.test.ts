import test from 'node:test';
import assert from 'node:assert/strict';
import { Ajv } from 'ajv';
import { AnthropicClient, providerJsonSchema, type LlmRequest } from '../src/llm/client.js';
import { MethodController } from '../src/seo-blog/method-packs.js';
import { MemoryMethodStore } from '../src/seo-blog/method-store.js';
import { PLAN_SCHEMA, proposeCluster } from '../src/seo-blog/generation.js';
import { fixtureBrand } from './rl72-method-fixtures.js';
import { UpgradeFixtureModel, upgradeSnapshot } from './rl72-upgrade-fixtures.js';
import { decodePlanningOutput } from '../src/seo-blog/planning-output.js';

async function plan(mutate?: (v:any,request:LlmRequest)=>void) {
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
    wire=structuredClone(v);
  };
  const llm=await new MethodController(store,true).prepare(model,{...f,stage:'planning',stages:['planning'],assetRef:'plan:test',sources:['S1','fixture-source'],baselineTokens:16000,evidence:{research:f.sources}});
  const run=()=>proposeCluster(llm,{brandName:f.brand.name,profile:f.profile,inventory:[],sources:f.sources,focus:null,excluded:[],sourceArticleUrl:null});
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

test('Anthropic serializes native output_config only when requested; streaming and usage are preserved',async()=>{
  const client=new AnthropicClient('fictional-test-key');const sent:any[]=[];
  (client as any).client={messages:{stream:(params:any)=>{sent.push(params);return {finalMessage:async()=>({content:[{type:'text',text:'{}'}],usage:{input_tokens:11,output_tokens:3},stop_reason:'end_turn',model:'fixture'})};}}};
  const req:LlmRequest={model:'claude-sonnet-4-6',maxTokens:100,system:'test',messages:[{role:'user',content:'test'}],thinking:false};
  await client.complete(req);const result=await client.complete({...req,outputSchema:{type:'object',properties:{answer:{type:'string'}},required:['answer']}});
  assert.equal(sent[0].output_config,undefined);assert.equal(sent[1].output_config.format.type,'json_schema');
  assert.equal(sent[1].output_config.format.schema.additionalProperties,false);assert.equal(result.tokensIn+result.tokensOut,14);
});
