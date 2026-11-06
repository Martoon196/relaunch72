import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApolloDiscovery,CompaniesHouseClient,corporateProfile,normaliseEmail,type ApolloStore,type CorporateCompany,type Prospect } from '../src/integrations/apollo/index.js';
import { coverage,readCompanyCsv } from '../src/integrations/apollo/coverage.js';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/apollo/synthetic.json',import.meta.url),'utf8'));
const seed={name:'Fixture Property Limited',domain:'fixture.example',company_number:'01234567',segment:'agent'};
function setup(responses:Response[]=[Response.json(fixture.people)]){
  const calls:{url:string;body:Record<string,unknown>}[]=[],records:Prospect[]=[],settled:{actual:number|null;blocked:boolean}[]=[],reservations:string[]=[];
  let held=false,spent=0;
  const store:ApolloStore={
    usage:async()=>({enabled:!held,brandLimit:50,globalLimit:50,brandUsedOrReserved:spent,globalUsedOrReserved:spent,remaining:50-spent,freeAllowanceConfirmed:true,resetAt:null}),
    seed:async()=>{},reserve:async p=>{reservations.push(p.operation);const cost=p.operation==='people-search'?0:1;if(spent+cost>50)throw new Error('budget held');spent+=cost;return {reserved:cost};},
    settle:async(_id,actual,blocked=false)=>{settled.push({actual,blocked});if(blocked)held=true;},save:async(_id,r)=>{records.push(r);}};
  const companies=new CompaniesHouseClient('fixture-ch-key',async()=>Response.json(fixture.company));
  const discovery=new ApolloDiscovery(store,companies,{enabled:true,apiKey:'fixture-api-key',maxRunCredits:25,sleep:async()=>{},
    fetcher:async(url,init)=>{calls.push({url:String(url),body:JSON.parse(String(init?.body))});const next=responses.shift();if(!next)throw new Error('network timeout');return next;}});
  return {discovery,store,calls,records,settled,reservations};
}
test('Corporate gate rejects sole traders, dissolved companies and mismatched CH names before Apollo',async()=>{
  for(const patch of [{type:'sole-trader'},{company_status:'dissolved'},{company_name:'Different Company Ltd'},{type:'private-unlimited'}]){
    assert.throws(()=>corporateProfile({...fixture.company,...patch},seed));
  }
  const s=setup();let vendorCalls=0;
  const d=new ApolloDiscovery(s.store,new CompaniesHouseClient('fixture',async()=>Response.json({...fixture.company,type:'sole-trader'})),{enabled:true,apiKey:'fixture',maxRunCredits:0,fetcher:async()=>{vendorCalls++;return Response.json({});}});
  await assert.rejects(d.preview(seed));assert.equal(vendorCalls,0);
});
test('Disabled feature performs no company or Apollo HTTP calls',async()=>{
  let n=0;const s=setup();const d=new ApolloDiscovery(s.store,new CompaniesHouseClient('fixture',async()=>{n++;return Response.json({});}),{enabled:false,apiKey:'fixture',maxRunCredits:0});
  await assert.rejects(d.preview(seed));assert.equal(n,0);
});
test('Preview pull stores corporate provenance, omits contact uploads and reports unknown email availability',async()=>{
  const s=setup();const p=await s.discovery.preview(seed,{titles:['Director']});
  assert.equal(p.orgFound,true);assert.equal(p.peopleMatched,2);assert.equal(p.directorOrOwner,true);assert.equal(p.verifiedEmailIndicated,null);
  assert.deepEqual(s.calls[0]!.body.q_organization_domains_list,['fixture.example']);
  assert.equal(s.calls[0]!.body.email,undefined);assert.equal(s.records[0]!.source_vendor,'apollo');
  assert.equal(s.records[0]!.licence_ref,'apollo-free-internal');assert.equal(s.records[0]!.company_number,'01234567');assert.equal(s.records[0]!.credits_spent,0);
  assert.equal(s.records[0]!.subscriber_class,'corporate');assert.equal(s.discovery.totals.actualCredits,0);
});
test('Run cap blocks paid endpoint before reservation; no account allowance assumed',async()=>{
  const s=setup();const d=new ApolloDiscovery(s.store,new CompaniesHouseClient('x'),{enabled:true,apiKey:'x',maxRunCredits:0});
  await assert.rejects(d.organizations(corporateProfile(fixture.company,seed)),/coverage_credit_cap/);assert.equal(s.reservations.length,0);
  assert.throws(()=>new ApolloDiscovery(s.store,new CompaniesHouseClient('x'),{enabled:true,apiKey:'x',maxRunCredits:26}));
});
test('Dedupe store refusal precedes enrichment HTTP; email normalization is stable',async()=>{
  const s=setup();s.store.reserve=async()=>{throw new Error('already held or suppressed');};
  await assert.rejects(s.discovery.enrich(corporateProfile(fixture.company,seed),'fixture-owner'),/already held/);assert.equal(s.calls.length,0);
  assert.equal(normaliseEmail(' Director@Fixture.Example '),'director@fixture.example');
});
test('Paid timeout reserves cost, never retries, and stops further calls',async()=>{
  const s=setup([]);await assert.rejects(s.discovery.enrich(corporateProfile(fixture.company,seed),'fixture-owner'),/network timeout/);
  assert.equal(s.calls.length,1);assert.equal(s.settled[0]!.actual,null);assert.equal(s.discovery.totals.reservedCredits,1);
  await assert.rejects(s.discovery.preview(seed));assert.equal(s.calls.length,1);
});
test('Free searches retry rate limits; plan/permission error stops entire coverage run',async()=>{
  const retry=setup([new Response('',{status:429}),Response.json(fixture.people)]);await retry.discovery.preview(seed);assert.equal(retry.calls.length,2);
  const blocked=setup([new Response('',{status:403})]);const r=await coverage(blocked.discovery,[seed,{...seed,name:'Second fixture'}]);
  assert.equal(r.rows.length,1);assert.equal(blocked.calls.length,1);assert.equal(r.credits.actualCredits,0);
});
test('Enrichment disables personal emails, phone and waterfall and preserves explicit charge',async()=>{
  const s=setup([Response.json(fixture.enrichment)]);const r=await s.discovery.enrich(corporateProfile(fixture.company,seed),'fixture-owner');
  assert.equal(r.credits_spent,1);assert.equal(r.vendor_confidence,'verified');
  assert.deepEqual(s.calls[0]!.body,{id:'fixture-owner',reveal_personal_emails:false,reveal_phone_number:false,run_waterfall_email:false,run_waterfall_phone:false});
});
test('CSV handles quoted commas, rejects duplicate firms, width errors and absent company evidence',()=>{
  const p=readCompanyCsv('name,domain,company_number,segment\n"Fixture, Ltd",fixture.example,01234567,agent\n');assert.equal(p[0]!.name,'Fixture, Ltd');
  assert.throws(()=>readCompanyCsv('name,domain,segment\nA,fixture.example,agent\n'));
  assert.throws(()=>readCompanyCsv('name,domain,company_number,segment\nA,fixture.example,01234567,agent\nA,fixture.example,01234567,agent\n'));
});
