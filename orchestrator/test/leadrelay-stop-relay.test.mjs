import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createPropertyPredatorStopRelay} from '../src/integrations/leadrelay/stop-relay.mjs';

const ids={hq:'11111111-1111-4111-8111-111111111111',lr:'22222222-2222-4222-8222-222222222222',lead:'33333333-3333-4333-8333-333333333333',account:'44444444-4444-4444-8444-444444444444',event:'55555555-5555-4555-8555-555555555555',other:'66666666-6666-4666-8666-666666666666'};
const cfg={hqWorkspaceId:ids.hq,leadRelayWorkspaceId:ids.lr,installationId:'pp',origin:'https://leadrelay.example',hookSecret:'synthetic-test-only-hook-secret-0123456789',purchaseProductKeys:['pro_investor']};
const purchase=()=>({id:ids.event,type:'commerce.purchase.completed',version:1,occurredAt:'2026-10-28T12:00:00.000Z',correlationId:ids.other,subject:{kind:'account',id:ids.account},data:{provider:'stripe',providerEventId:'evt_synthetic',checkoutSessionId:'cs_synthetic',productKey:'pro_investor',billingKind:'subscription',subscriptionId:'sub_synthetic',amountMinor:4950,currency:'gbp'}});
const appointment=()=>({...purchase(),type:'sales.appointment.booked',data:{appointmentId:'google_event_synthetic',startsAt:'2026-11-01T12:30:00.000Z',bookingSource:'self_serve_calendar',meetingKind:'discovery'}});
const success=(duplicate=false)=>new Response(JSON.stringify({ok:true,duplicate}),{headers:{'Content-Type':'application/json'}});
function setup({event=purchase(),installation=cfg,loader,mapping,fetcher}={}){
  const calls=[],loads=[],mappings=[];
  const relay=createPropertyPredatorStopRelay({installation,nowSeconds:()=>1793188800,
    loadCanonicalEvent:async q=>{loads.push(q);return loader?loader(q):{hqWorkspaceId:ids.hq,source:'property_predator',event};},
    resolveLeadBinding:async q=>{mappings.push(q);return mapping?mapping(q):{...q,leadId:ids.lead,stopScope:'all_sales_followup_for_lead'};},
    fetchImpl:async(url,options)=>{calls.push({url,options});return fetcher?fetcher(url,options):success();}});
  return {relay,calls,loads,mappings,run:()=>relay({hqWorkspaceId:ids.hq,eventId:ids.event})};
}
test('verified purchase is translated to the existing exact signed HookInput with configured destination and explicit identity map',async()=>{
  const h=setup(),result=await h.run();assert.equal(result.disposition,'delivered');assert.equal(h.calls.length,1);
  const {url,options}=h.calls[0];assert.equal(url,`https://leadrelay.example/hooks/${ids.lr}/events`);assert.equal(options.redirect,'error');
  const body=JSON.parse(options.body);assert.deepEqual(body,{event_id:result.hookEventId,type:'purchase.confirmed',lead_id:ids.lead,conversion_ref:'stripe:cs_synthetic:pro_investor'});
  assert.equal(options.headers['X-LeadRelay-Signature'],createHmac('sha256',cfg.hookSecret).update(options.headers['X-LeadRelay-Timestamp']+'.'+options.body).digest('hex'));
  assert.deepEqual(h.mappings[0],{hqWorkspaceId:ids.hq,installationId:'pp',leadRelayWorkspaceId:ids.lr,source:'property_predator',sourceSubjectId:ids.account,eventType:'commerce.purchase.completed',productKey:'pro_investor'});
  assert.equal(options.body.includes('email'),false);assert.equal(options.body.includes(cfg.hookSecret),false);
});
test('confirmed source appointment preserves its supplied reference and time without making a calendar request',async()=>{
  const h=setup({event:appointment()}),result=await h.run();assert.equal(result.disposition,'delivered');
  const body=JSON.parse(h.calls[0].options.body);assert.equal(body.type,'meeting.booked');assert.equal(body.booking_ref,'google_event_synthetic');assert.equal(body.starts_at,Date.parse('2026-11-01T12:30:00.000Z')/1000);
});
test('duplicate delivery keeps the same event ID and raw body and accepts only receiver replay proof',async()=>{
  let times=0;const h=setup({fetcher:()=>success(times++>0)});const first=await h.run(),second=await h.run();
  assert.equal(first.duplicate,false);assert.equal(second.duplicate,true);assert.equal(first.hookEventId,second.hookEventId);assert.equal(h.calls[0].options.body,h.calls[1].options.body);
});
test('source ID payload conflict remains the same hook ID and is held instead of treated as a duplicate',async()=>{
  let times=0;const event=purchase(),h=setup({event,fetcher:()=>times++===0?success():new Response('private supplier response',{status:409})});
  const first=await h.run();event.data.checkoutSessionId='cs_changed';const second=await h.run();
  assert.equal(first.disposition,'delivered');assert.equal(second.reason,'event_conflict');assert.equal(h.calls.length,2);
  assert.equal(JSON.parse(h.calls[0].options.body).event_id,JSON.parse(h.calls[1].options.body).event_id);
  assert.equal(JSON.stringify(second).includes('private'),false);
});
test('wrong HQ workspace is denied before even invoking canonical loader',async()=>{
  const h=setup(),result=await h.relay({hqWorkspaceId:ids.other,eventId:ids.event});assert.equal(result.reason,'source_binding_required');assert.equal(h.loads.length,0);assert.equal(h.calls.length,0);
});
for(const [label,loader] of [
  ['missing source',()=>null],['another workspace',()=>({hqWorkspaceId:ids.other,source:'property_predator',event:purchase()})],
  ['wrong source',()=>({hqWorkspaceId:ids.hq,source:'retell',event:purchase()})],
  ['source ID mismatch',()=>({hqWorkspaceId:ids.hq,source:'property_predator',event:{...purchase(),id:ids.other}})],
])test(label+' holds before mapping or delivery',async()=>{const h=setup({loader});assert.equal((await h.run()).disposition,'held');assert.equal(h.mappings.length,0);assert.equal(h.calls.length,0);});
for(const field of ['hqWorkspaceId','installationId','leadRelayWorkspaceId','sourceSubjectId','eventType','productKey','stopScope'])test('mapping cannot change '+field,async()=>{
  const h=setup({mapping:q=>({...q,leadId:ids.lead,stopScope:'all_sales_followup_for_lead',[field]:'wrong'})});assert.equal((await h.run()).reason,'lead_mapping_required');assert.equal(h.calls.length,0);
});
test('missing mapping never guesses a lead from canonical source identity',async()=>{const h=setup({mapping:()=>null});assert.equal((await h.run()).reason,'lead_mapping_required');assert.equal(h.calls.length,0);});
test('validated canonical intent cannot change while the mapping lookup is pending',async()=>{
  const event=purchase();let release,started;
  const pending=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
  const h=setup({event,mapping:async q=>{started();await pending;return {...q,leadId:ids.lead,stopScope:'all_sales_followup_for_lead'};}});
  const result=h.run();await entered;event.data.productKey='pro_business';event.data.checkoutSessionId='cs_replaced';release();
  assert.equal((await result).disposition,'delivered');assert.equal(JSON.parse(h.calls[0].options.body).conversion_ref,'stripe:cs_synthetic:pro_investor');
});
test('invalid caller identifiers are never echoed into held receipts',async()=>{
  const h=setup(),result=await h.relay({hqWorkspaceId:ids.hq,eventId:'private-untrusted-value'});assert.equal(result.eventId,null);assert.equal(h.calls.length,0);
});
test('email-only consent withdrawal and made-up reply events never become a global LeadRelay opt-out',async()=>{
  for(const event of [{...purchase(),type:'privacy.consent.updated',data:{purpose:'property_predator_marketing',channel:'email',state:'withdrawn',source:'unsubscribe'}},{...purchase(),type:'lead.replied',data:{summary:'not a source event'}}]){
    const h=setup({event});assert.equal((await h.run()).reason,'unsupported_event');assert.equal(h.calls.length,0);
  }
});
test('no purchase product mapping, invalid payment and invalid currency hold instead of producing a conversion',async()=>{
  for(const [field,value] of [['productKey','pro_business'],['amountMinor',0],['currency','GBP'],['provider','manual'],['checkoutSessionId','']]){
    const event=purchase();event.data[field]=value;const h=setup({event});assert.equal((await h.run()).disposition,'held');assert.equal(h.calls.length,0);
  }
});
test('payload target and client lead ID fields cannot override configured destination or mapping',async()=>{
  for(const [field,value] of [['lead_id',ids.other],['url','https://attacker.example/'],['workspaceId',ids.other]]){
    const h=setup({event:{...purchase(),[field]:value}});assert.equal((await h.run()).disposition,'held');assert.equal(h.calls.length,0);
  }
});
for(const origin of ['http://leadrelay.example','https://127.0.0.1','https://127.1','https://localhost','https://service.internal','https://a:b@leadrelay.example','https://leadrelay.example/hooks/x/events','https://leadrelay.example/?token=x','https://leadrelay.example/#x','https://leadrelay.example:444'])test('rejects untrusted configured target '+origin,()=>{
  assert.throws(()=>setup({installation:{...cfg,origin}}),/Invalid stop relay configuration/);
});
test('network failure is an unknown held stop; no internal retry or error/credential exposure',async()=>{
  const h=setup({fetcher:()=>{throw Error(cfg.hookSecret+' private response');}}),result=await h.run();assert.equal(result.reason,'stop_outcome_unknown');assert.equal(h.calls.length,1);assert.equal(JSON.stringify(result).includes(cfg.hookSecret),false);
});
test('rejected, redirected, malformed and oversized receipts never acknowledge successful stop',async()=>{
  for(const response of [new Response('unauthorized',{status:401}),new Response('retry',{status:503}),new Response('redirect',{status:302,headers:{location:'https://attacker.example'}}),new Response('{"ok":true}',{headers:{'content-type':'application/json'}}),new Response('{"ok":true,"duplicate":false,"secret":"x"}',{headers:{'content-type':'application/json'}}),new Response('x'.repeat(4097),{headers:{'content-type':'application/json'}}),new Response('{"ok":true,"duplicate":false}',{headers:{'content-type':'application/json','content-length':'999999'}})]){
    const h=setup({fetcher:()=>response});assert.equal((await h.run()).disposition,'held');assert.equal(h.calls.length,1);
  }
});
test('loader and mapping failures remain held and cannot acknowledge or send',async()=>{
  for(const options of [{loader:()=>{throw Error('private');}},{mapping:()=>{throw Error('private');}}]){const h=setup(options),r=await h.run();assert.equal(r.disposition,'held');assert.equal(h.calls.length,0);assert.equal(JSON.stringify(r).includes('private'),false);}
});
test('bounded deadline holds an unresponsive transport with no retry even if it ignores abort',async()=>{
  const h=setup({installation:{...cfg,timeoutMs:250},fetcher:()=>new Promise(()=>{})});
  const result=await h.run();assert.equal(result.reason,'stop_outcome_unknown');assert.equal(h.calls.length,1);assert.equal(h.calls[0].options.signal.aborted,true);
});
test('bounded deadline also covers an unfinished response stream',async()=>{
  const h=setup({installation:{...cfg,timeoutMs:250},fetcher:()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));}}),{headers:{'content-type':'application/json'}})});
  assert.equal((await h.run()).disposition,'held');assert.equal(h.calls.length,1);
});
