import test from 'node:test';
import assert from 'node:assert/strict';
import {loadInstallations,createDispatcher,sendControl,ALL_ACTIONS,GatewayError} from '../src/integrations/leadrelay/node-gateway.mjs';
const raw=JSON.stringify([{id:'key-properties',label:'Key Properties UK',base_url:'https://leadrelay.example.com',key_env:'LR_KEY'}]);
const key='a'.repeat(48),identity={userId:'owner',workspaceId:'approved-workspace'};
const installs=()=>loadInstallations(raw,{LR_KEY:key});
const build=(extra={})=>createDispatcher({installations:installs(),authorize:async user=>user.workspaceId==='approved-workspace'?ALL_ACTIONS:[],verifyCsrf:async()=>true,transport:async(i,m,p,b)=>({method:m,path:p,body:b}),...extra});
test('Registry is secret-free and permissions explicit',async()=>{const r=await build()({identity,method:'GET',path:'/installations'});assert.equal(r[0].id,'key-properties');assert.ok(!JSON.stringify(r).includes(key));assert.ok(!JSON.stringify(r).includes('example.com'));});
test('No identity is denied',async()=>{await assert.rejects(build()({method:'GET',path:'/installations'}),e=>e.status===401);});
test('Other tenant cannot enumerate or access installation',async()=>{const who={userId:'owner',workspaceId:'wrong'};assert.deepEqual(await build()({identity:who,path:'/installations'}),[]);await assert.rejects(build()({identity:who,path:'/installations/key-properties/status'}),e=>e.status===404);});
test('Write requires explicit action grant',async()=>{const fn=build({authorize:async()=>['GET:status']});await assert.rejects(fn({identity,method:'POST',path:'/installations/key-properties/pause',body:{reason:'x'}}),e=>e.status===403);});
test('Mutating action requires valid existing HQ CSRF',async()=>{await assert.rejects(build({verifyCsrf:async()=>false})({identity,method:'POST',path:'/installations/key-properties/pause',body:{reason:'x'}}),e=>e.status===403);});
test('Business export is mapped to bounded control route',async()=>{const r=await build()({identity,method:'POST',path:'/installations/key-properties/pack-export',body:{}});assert.equal(r.path,'business-pack/export');});
test('Unsupported paths and traversal rejected',async()=>{for(const path of ['/installations/key-properties/../../live/test-call','/installations/key-properties/test-call','/installations/key-properties/status?url=https://evil.invalid'])await assert.rejects(build()({identity,path}),e=>e.status===404);});
test('Credential host must be configured trusted HTTPS domain',()=>{for(const base_url of ['http://example.com','https://127.0.0.1','https://evil.invalid/path','https://u:p@example.com','https://host.internal'])assert.throws(()=>loadInstallations(JSON.stringify([{id:'test',label:'Test',base_url,key_env:'LR_KEY'}]),{LR_KEY:key}));});
test('No redirect and only server key forwarded',async()=>{let observed;const result=await sendControl(installs().get('key-properties'),'GET','status',undefined,async(url,options)=>{observed={url,options};return new Response('{}',{headers:{'content-type':'application/json'}});});assert.equal(observed.options.redirect,'error');assert.equal(observed.options.headers.authorization,'Bearer '+key);assert.equal(observed.url,'https://leadrelay.example.com/api/control/status');assert.deepEqual(result,{});});
test('Raw upstream error body not leaked; no retry',async()=>{let calls=0;await assert.rejects(sendControl(installs().get('key-properties'),'GET','status',undefined,async()=>{calls++;return new Response('secret:'+key,{status:500});}),e=>e instanceof GatewayError&&e.status===502&&!e.message.includes(key));assert.equal(calls,1);});
test('Oversized body rejected before sending',async()=>{await assert.rejects(build()({identity,method:'PUT',path:'/installations/key-properties/settings',body:{text:'x'.repeat(800001)}}),e=>e.status===413);});
test('Oversized upstream response rejected',async()=>{await assert.rejects(sendControl(installs().get('key-properties'),'GET','status',undefined,async()=>new Response('x'.repeat(800001),{headers:{'content-type':'application/json'}})),e=>e.status===502);});

test('Agent actions are individually granted and never inherited from control setup',async()=>{
  const fn=build({authorize:async()=>['GET:status','PUT:settings','GET:agent-status']});
  assert.equal((await fn({identity,method:'GET',path:'/installations/key-properties/agent-status'})).path,'/api/agent-builder');
  for(const action of ['scan','approve','publish','chat','test-call','deploy']) {
    await assert.rejects(fn({identity,method:'POST',path:'/installations/key-properties/agent-'+action,body:{}}),e=>e.status===403);
  }
});
test('Every agent mutation retains existing HQ CSRF protection',async()=>{
  const fn=build({verifyCsrf:async()=>false});
  for(const action of ['scan','approve','publish','chat','test-call','deploy']) {
    await assert.rejects(fn({identity,method:'POST',path:'/installations/key-properties/agent-'+action,body:{}}),e=>e.status===403);
  }
});
test('Agent transport uses only the fixed configured installation and operation',async()=>{
  const calls=[];
  for(const [method,path] of [['GET','/api/agent-builder'],...['scan','approve','publish','chat','test-call','deploy'].map(x=>['POST','/api/agent-builder/'+x])]) {
    await sendControl(installs().get('key-properties'),method,path,method==='GET'?undefined:{version_id:'version-a'},async(url,options)=>{
      calls.push({url,options});return new Response('{}',{headers:{'content-type':'application/json'}});
    });
  }
  assert.equal(calls.length,7);
  for(const {url,options} of calls) {
    assert.match(url,/^https:\/\/leadrelay\.example\.com\/api\/agent-builder(?:\/(scan|approve|publish|chat|test-call|deploy))?$/);
    assert.equal(options.headers.authorization,'Bearer '+key);
    assert.equal(options.redirect,'error');
    assert.deepEqual(Object.keys(options.headers).sort(),['accept','authorization','content-type']);
  }
});
test('Agent callers cannot override identity, supplier credential or call destination',async()=>{
  const fn=build();
  for(const field of ['installationId','workspaceId','userId','base_url','key','key_env','secret','provider_key','to_number','phone','own_phone','recipient']) {
    await assert.rejects(fn({identity,method:'POST',path:'/installations/key-properties/agent-test-call',body:{[field]:'other'}}),e=>e.status===400);
  }
  const scan=await fn({identity,method:'POST',path:'/installations/key-properties/agent-scan',body:{url:'https://business.example/'}});
  assert.equal(scan.path,'/api/agent-builder/scan');
});
test('Agent path or method spoofing is rejected before any fetch',async()=>{
  let fetched=false;
  for(const [method,path] of [['POST','https://evil.invalid/'],['GET','/api/agent-builder?url=https://evil.invalid'],['DELETE','/api/agent-builder'],['GET','/api/live/status'],['GET','/api/agent-builder/../live/status']]) {
    await assert.rejects(sendControl(installs().get('key-properties'),method,path,{},async()=>{fetched=true;}),e=>e.status===404);
  }
  assert.equal(fetched,false);
});
test('Agent grants remain isolated by canonical workspace',async()=>{
  const fn=build({authorize:async user=>user.workspaceId==='approved-workspace'?['GET:agent-status','POST:agent-chat']:[]});
  await assert.rejects(fn({identity:{...identity,workspaceId:'different'},method:'POST',path:'/installations/key-properties/agent-chat',body:{message:'Hello'}}),e=>e.status===404);
});

const providerSecret='fictional-provider-key-12345';
const webhookSecret='fictional-webhook-key-12345';
const setupConfig={voice_id:'voice-a',from_number:'',verified_at:123};
const jsonResponse=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
test('Provider setup has separate explicit grants and cannot inherit agent publication or business settings',async()=>{
  const fn=build({authorize:async()=>['GET:agent-status','POST:agent-publish','PUT:settings']});
  for(const [method,action,body] of [['GET','agent-connection',undefined],['POST','agent-voices',{}],['POST','agent-connect',{voice_id:'voice-a'}]]) {
    await assert.rejects(fn({identity,method,path:'/installations/key-properties/'+action,body}),e=>e.status===403);
  }
  const permitted=build({authorize:async()=>['GET:agent-connection','POST:agent-voices','POST:agent-connect']});
  assert.equal((await permitted({identity,path:'/installations/key-properties/agent-connection'})).path,'/api/agent-builder/connection');
  assert.equal((await permitted({identity,method:'POST',path:'/installations/key-properties/agent-voices',body:{secret:providerSecret}})).path,'/api/agent-builder/connection/voices');
});
test('Credential setup requires HQ CSRF and canonical installation authority before transport',async()=>{
  let calls=0;
  const transport=async()=>{calls++;return {};};
  for(const action of ['agent-voices','agent-connect']) {
    const body=action==='agent-voices'?{secret:providerSecret}:{secret:providerSecret,voice_id:'voice-a'};
    await assert.rejects(build({verifyCsrf:async()=>false,transport})({identity,method:'POST',path:'/installations/key-properties/'+action,body}),e=>e.status===403&&!e.message.includes(providerSecret));
    await assert.rejects(build({transport})({identity:{...identity,workspaceId:'another'},method:'POST',path:'/installations/key-properties/'+action,body}),e=>e.status===404);
    await assert.rejects(build({transport})({method:'POST',path:'/installations/key-properties/'+action,body}),e=>e.status===401);
  }
  assert.equal(calls,0);
});
test('Provider credential exception accepts only the exact setup fields',async()=>{
  const fn=build();
  const fields=['installationId','workspaceId','userId','base_url','headers','key','key_env','provider_key','to_number','phone','own_phone','recipient','url'];
  for(const action of ['agent-voices','agent-connect']) for(const field of fields) {
    const body={secret:providerSecret,...(action==='agent-connect'?{voice_id:'voice-a'}:{}),[field]:'override'};
    await assert.rejects(fn({identity,method:'POST',path:'/installations/key-properties/'+action,body}),e=>e.status===400);
  }
  for(const body of [{secret:'short'}, {secret:'x'.repeat(10001)}, {secret:providerSecret+'\n'}, {secret:null}, {secret:{key:providerSecret}}, {webhook_secret:webhookSecret}]) {
    await assert.rejects(fn({identity,method:'POST',path:'/installations/key-properties/agent-voices',body}),e=>e.status===400);
  }
  for(const body of [{}, {voice_id:''}, {voice_id:'x'.repeat(121)}, {voice_id:'voice-a',from_number:'x'.repeat(21)}, {voice_id:'voice-a',webhook_secret:'short'}]) {
    await assert.rejects(fn({identity,method:'POST',path:'/installations/key-properties/agent-connect',body}),e=>e.status===400);
  }
  const r=await fn({identity,method:'POST',path:'/installations/key-properties/agent-connect',body:{voice_id:'voice-a',from_number:'+447700900123',secret:providerSecret,webhook_secret:webhookSecret}});
  assert.equal(r.path,'/api/agent-builder/connection/verify');
  for(const action of ['agent-publish','agent-test-call','agent-chat']) for(const field of ['secret','webhook_secret','from_number']) {
    await assert.rejects(fn({identity,method:'POST',path:'/installations/key-properties/'+action,body:{[field]:providerSecret}}),e=>e.status===400);
  }
});
test('Provider setup transport is fixed-host and projects safe status and credential-free voice metadata',async()=>{
  const observed=[];
  const status=await sendControl(installs().get('key-properties'),'GET','/api/agent-builder/connection',undefined,async(url,options)=>{
    observed.push({url,options});
    return jsonResponse({provider:'retell',verified:true,has_secret:true,has_webhook_secret:true,config:{...setupConfig,secret:providerSecret},secret:providerSecret,outreach_started:false});
  });
  assert.deepEqual(status,{provider:'retell',verified:true,has_secret:true,has_webhook_secret:true,config:setupConfig,outreach_started:false});
  const voices=await sendControl(installs().get('key-properties'),'POST','/api/agent-builder/connection/voices',{secret:providerSecret},async(url,options)=>{
    observed.push({url,options});
    return jsonResponse({provider:'retell',voices:[{voice_id:'voice-a',voice_name:'Alex',provider:'elevenlabs',accent:'British',preview_audio_url:'https://supplier.invalid/secret',secret:providerSecret}],secret:providerSecret,outreach_started:false});
  });
  assert.deepEqual(voices,{provider:'retell',voices:[{voice_id:'voice-a',voice_name:'Alex',provider:'elevenlabs',accent:'British'}],outreach_started:false});
  const verified=await sendControl(installs().get('key-properties'),'POST','/api/agent-builder/connection/verify',{secret:providerSecret,webhook_secret:webhookSecret,voice_id:'voice-a'},async(url,options)=>{
    observed.push({url,options});
    return jsonResponse({verified:true,config:{...setupConfig,key:providerSecret,webhook_secret:webhookSecret},outreach_started:false,secret:providerSecret});
  });
  assert.deepEqual(verified,{verified:true,config:setupConfig,outreach_started:false});
  assert.doesNotMatch(JSON.stringify([status,voices,verified]),/fictional-provider|fictional-webhook/);
  assert.equal(observed.length,3);
  for(const {url,options} of observed) {
    assert.match(url,/^https:\/\/leadrelay\.example\.com\/api\/agent-builder\/connection(?:\/(voices|verify))?$/);
    assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,'Bearer '+key);
    assert.deepEqual(Object.keys(options.headers).sort(),['accept','authorization','content-type']);
  }
});
test('Provider setup rejects credential echoes even when disguised as permitted metadata',async()=>{
  for(const voice_name of [providerSecret,webhookSecret,key]) {
    await assert.rejects(sendControl(installs().get('key-properties'),'POST','/api/agent-builder/connection/verify',{secret:providerSecret,webhook_secret:webhookSecret,voice_id:'voice-a'},async()=>jsonResponse({verified:true,config:{...setupConfig,voice_name},outreach_started:false})),e=>e.status===502&&!e.message.includes(voice_name));
  }
});
test('Provider setup refuses malformed or oversized metadata and false safety assertions',async()=>{
  for(const payload of [
    {provider:'retell',voices:Array.from({length:201},()=>({voice_id:'x',voice_name:'x'})),outreach_started:false},
    {provider:'retell',voices:[{voice_id:'x',voice_name:'x'.repeat(121)}],outreach_started:false},
    {provider:'retell',voices:[],outreach_started:true},
    {provider:'other',voices:[],outreach_started:false},
  ]) await assert.rejects(sendControl(installs().get('key-properties'),'POST','/api/agent-builder/connection/voices',{},async()=>jsonResponse(payload)),e=>e.status===502);
  let sent=false;
  await assert.rejects(sendControl(installs().get('key-properties'),'GET','/api/agent-builder/connection',{secret:providerSecret},async()=>{sent=true;}),e=>e.status===400);
  assert.equal(sent,false);
});
test('Provider setup failure discards supplier bodies and does not automatically retry credentials',async()=>{
  let calls=0;
  await assert.rejects(sendControl(installs().get('key-properties'),'POST','/api/agent-builder/connection/verify',{secret:providerSecret,voice_id:'voice-a'},async()=>{calls++;return new Response(providerSecret,{status:400});}),e=>e.status===400&&/could not be verified/.test(e.message)&&!e.message.includes(providerSecret));
  assert.equal(calls,1);
});

test('Owned caller inventory requires its own grant, canonical tenant and HQ CSRF',async()=>{
  const path='/installations/key-properties/agent-phone-numbers';
  let sent=0;const transport=async()=>{sent++;return {};};
  await assert.rejects(build({authorize:async()=>['GET:agent-connection','POST:agent-connect'],transport})({identity,method:'POST',path,body:{}}),e=>e.status===403);
  await assert.rejects(build({verifyCsrf:async()=>false,transport})({identity,method:'POST',path,body:{secret:providerSecret}}),e=>e.status===403);
  await assert.rejects(build({transport})({identity:{...identity,workspaceId:'other'},method:'POST',path,body:{}}),e=>e.status===404);
  await assert.rejects(build({transport})({method:'POST',path,body:{}}),e=>e.status===401);
  assert.equal(sent,0);
  const result=await build({authorize:async()=>['POST:agent-phone-numbers']})({identity,method:'POST',path,body:{secret:providerSecret}});
  assert.equal(result.path,'/api/agent-builder/connection/phone-numbers');
  for(const field of ['workspaceId','userId','base_url','headers','webhook_secret','phone_number','from_number','to_number','agent_id','page_token']) {
    await assert.rejects(build()({identity,method:'POST',path,body:{[field]:'override'}}),e=>e.status===400);
  }
});

test('Owned caller inventory is a fixed read-only route and projects only bounded safe metadata',async()=>{
  let observed;
  const result=await sendControl(installs().get('key-properties'),'POST','/api/agent-builder/connection/phone-numbers',{secret:providerSecret},async(url,options)=>{
    observed={url,options};
    return jsonResponse({provider:'retell',phone_numbers:[{phone_number:'+447700900123',nickname:'Office',number_type:'custom',secret:providerSecret,outbound_agent_id:'private-binding',sip_trunk_auth_password:'private-sip'}],truncated:false,outreach_started:false,secret:providerSecret});
  });
  assert.deepEqual(result,{provider:'retell',phone_numbers:[{phone_number:'+447700900123',nickname:'Office',number_type:'custom'}],truncated:false,outreach_started:false});
  assert.equal(observed.url,'https://leadrelay.example.com/api/agent-builder/connection/phone-numbers');
  assert.equal(observed.options.method,'POST');assert.equal(observed.options.redirect,'error');
  assert.deepEqual(JSON.parse(observed.options.body),{secret:providerSecret});
  assert.equal(observed.options.headers.authorization,'Bearer '+key);
  let fetched=false;
  for(const [method,path] of [['GET','/api/agent-builder/connection/phone-numbers'],['POST','/api/agent-builder/connection/purchase-number'],['POST','/api/agent-builder/connection/create-call']]) {
    await assert.rejects(sendControl(installs().get('key-properties'),method,path,{},async()=>{fetched=true;}),e=>e.status===404);
  }
  assert.equal(fetched,false);
});

test('Owned caller inventory rejects unsafe metadata, credential echoes and unknown truncation',async()=>{
  const path='/api/agent-builder/connection/phone-numbers';
  for(const payload of [
    {provider:'retell',phone_numbers:[{phone_number:'not-e164'}],truncated:false,outreach_started:false},
    {provider:'retell',phone_numbers:[],outreach_started:false},
    {provider:'retell',phone_numbers:[],truncated:'false',outreach_started:false},
    {provider:'retell',phone_numbers:Array.from({length:201},()=>({phone_number:'+447700900123'})),truncated:true,outreach_started:false},
    {provider:'retell',phone_numbers:[{phone_number:'+447700900123',nickname:providerSecret}],truncated:false,outreach_started:false},
    {provider:'retell',phone_numbers:[{phone_number:'+447700900123',nickname:key}],truncated:false,outreach_started:false},
    {provider:'retell',phone_numbers:[{phone_number:'+447700900123',number_type:'x'.repeat(121)}],truncated:false,outreach_started:false},
    {provider:'retell',phone_numbers:[],truncated:false,outreach_started:true},
  ]) await assert.rejects(sendControl(installs().get('key-properties'),'POST',path,{secret:providerSecret},async()=>jsonResponse(payload)),e=>e.status===502&&!e.message.includes(providerSecret));
  const empty=await sendControl(installs().get('key-properties'),'POST',path,{},async()=>jsonResponse({provider:'retell',phone_numbers:[],truncated:false,outreach_started:false}));
  assert.deepEqual(empty.phone_numbers,[]);
});

test('Owned caller lookup failures never echo supplier credentials or retry',async()=>{
  let calls=0;
  await assert.rejects(sendControl(installs().get('key-properties'),'POST','/api/agent-builder/connection/phone-numbers',{secret:providerSecret},async()=>{calls++;return new Response(providerSecret,{status:400});}),e=>e.status===400&&/numbers could not be read/.test(e.message)&&!e.message.includes(providerSecret));
  assert.equal(calls,1);
});

const callMeBody={version_id:'version-a',own_contact_confirmed:true,ai_call_consent:true,
  confirmation:'PLACE ONE PAID TEST CALL TO MY OWN NUMBER',mode:'call_me',request_id:'9aca7ecd-9a94-43e0-9414-8af424b29c13'};
const callMeReceipt={queued:true,job_id:'job-a',operation_id:callMeBody.request_id,status:'queued',
  earliest_delay_seconds:0,maximum_call_seconds:180,paid_provider_usage:true,one_call_only:true};
test('Call me reuses only the explicit existing test grant and CSRF without any settings authority',async()=>{
  const path='/installations/key-properties/agent-test-call';let sends=0;
  const transport=async(_i,_m,target,body)=>{sends++;return {target,body};};
  const allowed=build({authorize:async who=>who.workspaceId==='approved-workspace'?['POST:agent-test-call']:[],transport});
  const result=await allowed({identity,method:'POST',path,body:callMeBody});
  assert.equal(result.target,'/api/agent-builder/test-call');assert.deepEqual(result.body,callMeBody);
  assert.equal(sends,1);
  for(const options of [
    {authorize:async()=>['PUT:settings','POST:agent-publish']},
    {authorize:async()=>['POST:agent-test-call'],verifyCsrf:async()=>false},
  ]) await assert.rejects(build({...options,transport})({identity,method:'POST',path,body:callMeBody}),e=>e.status===403);
  await assert.rejects(allowed({identity:{...identity,workspaceId:'other'},method:'POST',path,body:callMeBody}),e=>e.status===404);
  assert.equal(sends,1);
});

test('Call me permits no destination, binding or temporary-control override and requires a stable intent',async()=>{
  const fn=build(),path='/installations/key-properties/agent-test-call';
  for(const field of ['phone','own_phone','to_number','from_number','recipient','workspaceId','userId','secret','provider_key','agent_id','calendar_id','paused','start_hour','weekdays','daily_call_limit','live_outreach','maximum_call_seconds']) {
    await assert.rejects(fn({identity,method:'POST',path,body:{...callMeBody,[field]:'override'}}),e=>e.status===400);
  }
  for(const values of [{mode:'immediate'},{request_id:undefined},{request_id:'short'},{request_id:'invalid request identifier'},{own_contact_confirmed:false},{ai_call_consent:false},{confirmation:'call someone'},{version_id:''}]) {
    const body=JSON.parse(JSON.stringify({...callMeBody,...values}));
    await assert.rejects(fn({identity,method:'POST',path,body}),e=>e.status===400);
  }
  const {mode,request_id,...legacy}=callMeBody;
  const queued=await fn({identity,method:'POST',path,body:legacy});
  assert.deepEqual(queued.body,legacy); // The ordinary two-minute route is unchanged.
});

test('Call me projects only a bounded matching receipt and preserves the same stable request identifier',async()=>{
  let request;
  const result=await sendControl(installs().get('key-properties'),'POST','/api/agent-builder/test-call',callMeBody,async(url,options)=>{
    request={url,options};
    return jsonResponse({...callMeReceipt,bindings:{secret:key},secret:key,own_phone:'+447700900123',previous_settings:{paused:true},provider_call_id:'unverified-extra-id'});
  });
  assert.deepEqual(result,callMeReceipt);
  assert.equal(request.url,'https://leadrelay.example.com/api/agent-builder/test-call');
  assert.deepEqual(JSON.parse(request.options.body),callMeBody);
  assert.equal(request.options.redirect,'error');assert.equal(request.options.headers.authorization,'Bearer '+key);
  assert.equal(Object.hasOwn(result,'bindings'),false);assert.equal(Object.hasOwn(result,'own_phone'),false);
  for(const status of ['queued','processing','awaiting_outcome','completed','cancelled','blocked','failed','uncertain','skipped']) {
    const queued=['queued','processing','awaiting_outcome'].includes(status);
    const replay=await sendControl(installs().get('key-properties'),'POST','/api/agent-builder/test-call',callMeBody,async()=>jsonResponse({...callMeReceipt,status,queued}));
    assert.equal(replay.operation_id,callMeBody.request_id);assert.equal(replay.status,status);
    assert.equal(replay.queued,queued);
  }
  const {job_id,...cancelled}=callMeReceipt;
  const expired=await sendControl(installs().get('key-properties'),'POST','/api/agent-builder/test-call',callMeBody,async()=>jsonResponse({...cancelled,queued:false,status:'cancelled'}));
  assert.equal(expired.queued,false);assert.equal(expired.status,'cancelled');assert.equal(Object.hasOwn(expired,'job_id'),false);
});

test('Call me refuses mismatched or unsafe receipts without retrying provider submission',async()=>{
  for(const change of [{operation_id:'another-operation'}, {job_id:key}, {status:'call_started_without_receipt'}, {queued:false}, {earliest_delay_seconds:120}, {maximum_call_seconds:3600}, {paid_provider_usage:false}, {one_call_only:false}]) {
    let sends=0;
    await assert.rejects(sendControl(installs().get('key-properties'),'POST','/api/agent-builder/test-call',callMeBody,async()=>{sends++;return jsonResponse({...callMeReceipt,...change});}),e=>e.status===502&&!e.message.includes(key));
    assert.equal(sends,1);
  }
  let fetched=false;
  await assert.rejects(sendControl(installs().get('key-properties'),'POST','/api/agent-builder/test-call',{...callMeBody,paused:false},async()=>{fetched=true;}),e=>e.status===400);
  assert.equal(fetched,false);
});

const trainingProfile={objective:null,reply_length:'existing',one_question:null,sales_guidance:false,signup_url:'',payment_url:'',instructions:'',business_capabilities:'',knowledge_ids:[],executable_tools:null};
const trainingVersion={id:'version-a',draft_id:'draft-a',status:'published',step:'publish_chat',content_digest:'e'.repeat(64),business_name:'Business A',agent_name:'Alex',approved_at:1,created_at:1,updated_at:1};
const trainingSource={category:'general',source_id:'source-a',title:'Reviewed facts',media_type:'text/plain',status:'ready',approved:false,sha256:'b'.repeat(64),created_at:1,knowledge_id:'knowledge-a',content:'Unapproved source text'};
const trainingState={profile:trainingProfile,saved:false,saved_at:null,profile_digest:'c'.repeat(64),review_digest:'d'.repeat(64),latest_version:trainingVersion,published_version:trainingVersion,applied_version_id:null,executable_tool_catalog:[{id:'offer_signup_link',title:'Offer approved signup',description:'An approved link, not account creation',execution:'approved_link',requires:'signup_url'}],approval_required:true,provider_publication_required:true,legacy_sales_brief:'Existing unapproved sales notes'};
const trainingWriteBodies={
  'agent-training-source':{title:'Draft',content:'Facts'},
  'agent-training-upload':{filename:'facts.txt',content_base64:Buffer.from('Facts').toString('base64')},
  'agent-training-review':{source_id:'source-a',title:'Reviewed',content:'Approved facts',approved:true},
  'agent-training-profile':trainingProfile,
  'agent-training-approve':{source_version_id:'version-a',review_digest:'d'.repeat(64),confirmation:'APPROVE THIS TRAINING VERSION'},
};
test('Training actions require explicit grants and existing HQ CSRF for each separate write',async()=>{
  let sends=0;const transport=async()=>{sends++;return {};};
  for(const [action,body] of Object.entries(trainingWriteBodies)){
    const request={identity,method:'POST',path:'/installations/key-properties/'+action,body};
    await assert.rejects(build({authorize:async()=>['PUT:settings','POST:agent-approve','POST:agent-publish','POST:agent-connect'],transport})(request),e=>e.status===403);
    await assert.rejects(build({verifyCsrf:async()=>false,transport})(request),e=>e.status===403);
    await assert.rejects(build({transport})({...request,identity:{...identity,workspaceId:'other'}}),e=>e.status===404);
  }
  assert.equal(sends,0);
  for(const [action,body] of Object.entries(trainingWriteBodies)) {
    const result=await build({authorize:async()=>['POST:'+action]})({identity,method:'POST',path:'/installations/key-properties/'+action,body});
    assert.match(result.path,/^\/api\/agent-builder\/training\/(source|upload|source-review|profile|approve)$/);
  }
});
test('Training payloads are bounded and cannot add identities, credentials or arbitrary executable tools',async()=>{
  for(const [action,body] of Object.entries(trainingWriteBodies))for(const field of ['workspaceId','userId','base_url','secret','provider_key','url','headers']) {
    await assert.rejects(build()({identity,method:'POST',path:'/installations/key-properties/'+action,body:{...body,[field]:'override'}}),e=>e.status===400);
  }
  const bad=[
    ['agent-training-source',{title:'Draft',content:'x'.repeat(50001)}],
    ['agent-training-upload',{filename:'../facts.txt',content_base64:'RmFjdHM='}],
    ['agent-training-upload',{filename:'run.html',content_base64:'RmFjdHM='}],
    ['agent-training-upload',{filename:'facts.txt',content_base64:Buffer.alloc(524289).toString('base64')}],
    ['agent-training-upload',{filename:'facts.txt',content_base64:'not base64'}],
    ['agent-training-review',{...trainingWriteBodies['agent-training-review'],approved:false}],
    ['agent-training-profile',{...trainingProfile,executable_tools:['fetch_arbitrary_url']}],
    ['agent-training-profile',{...trainingProfile,knowledge_ids:Array(21).fill('knowledge-a')}],
    ['agent-training-profile',{...trainingProfile,signup_url:'https://user:password@business.example/'}],
    ['agent-training-profile',{...trainingProfile,instructions:'x'.repeat(8001)}],
    ['agent-training-approve',{...trainingWriteBodies['agent-training-approve'],review_digest:'stale'}],
  ];
  for(const [action,body] of bad)await assert.rejects(build()({identity,method:'POST',path:'/installations/key-properties/'+action,body}),e=>e.status===400);
});
test('Training source responses contain only business-scoped metadata and reviewed text, never upload bytes or secrets',async()=>{
  const source=await sendControl(installs().get('key-properties'),'POST','/api/agent-builder/training/source',trainingWriteBodies['agent-training-source'],async()=>jsonResponse({source:{...trainingSource,encrypted_secret:key,content_base64:'private-upload',workspace_id:'other'},outreach_started:false}));
  assert.deepEqual(source,{source:trainingSource,outreach_started:false});
  const list=await sendControl(installs().get('key-properties'),'GET','/api/agent-builder/training/sources',undefined,async()=>jsonResponse({sources:[trainingSource],outreach_started:false,secret:key}));
  assert.deepEqual(list,{sources:[trainingSource],outreach_started:false});
  await assert.rejects(sendControl(installs().get('key-properties'),'GET','/api/agent-builder/training/sources',undefined,async()=>jsonResponse({sources:Array(21).fill(trainingSource),outreach_started:false})),e=>e.status===502);
});
test('Training draft and approval metadata preserve explicit review/publication boundaries and strip provider bindings',async()=>{
  const dirty={...trainingState,latest_version:{...trainingVersion,bindings:{secret:key}},published_version:{...trainingVersion,bindings:{voice:{agent_id:'supplier-binding'}}},secret:key};
  const state=await sendControl(installs().get('key-properties'),'GET','/api/agent-builder/training/profile',undefined,async()=>jsonResponse(dirty));
  assert.deepEqual(state,trainingState);
  const approval=await sendControl(installs().get('key-properties'),'POST','/api/agent-builder/training/approve',trainingWriteBodies['agent-training-approve'],async()=>jsonResponse({version:{...trainingVersion,bindings:{secret:key}},draft_id:'draft-a',outreach_started:false,published_version_unchanged:true,provider_publication_required:true}));
  assert.equal(Object.hasOwn(approval.version,'bindings'),false);assert.equal(approval.published_version_unchanged,true);
  await assert.rejects(sendControl(installs().get('key-properties'),'GET','/api/agent-builder/training/profile',undefined,async()=>jsonResponse({...trainingState,legacy_sales_brief:key})),e=>e.status===502&&!e.message.includes(key));
});
const voiceApplyBody={version_id:'version-a',request_id:'9aca7ecd-9a94-43e0-9414-8af424b29c13',confirmation:'APPLY VERIFIED VOICE TO MY AGENT'};
test('Training progress projects current approved and published evidence without receipt contents',async()=>{
  const progress={approval_current:true,approved_version_id:'version-a',approved_version_status:'published',training_published:true};
  const data={...trainingState,...progress,approval_receipt:{secret:key},provider_bindings:{secret:key}};
  const result=await sendControl(installs().get('key-properties'),'GET','/api/agent-builder/training/profile',undefined,async()=>jsonResponse(data));
  assert.deepEqual(result,{...trainingState,...progress});
  const changed={approval_current:false,approved_version_id:null,approved_version_status:null,training_published:false};
  const draft=await sendControl(installs().get('key-properties'),'GET','/api/agent-builder/training/profile',undefined,async()=>jsonResponse({...trainingState,...changed}));
  assert.equal(draft.approval_current,false);assert.equal(draft.training_published,false);
});
test('Training progress rejects partial contradictory unsafe or unsupported publication evidence',async()=>{
  const progress={approval_current:true,approved_version_id:'version-a',approved_version_status:'published',training_published:true};
  for(const change of [
    {approval_current:false},{approved_version_id:null},{approved_version_status:'queued'},
    {approved_version_status:'invented'},{approved_version_id:key},{training_published:'yes'},
  ])await assert.rejects(sendControl(installs().get('key-properties'),'GET','/api/agent-builder/training/profile',undefined,async()=>jsonResponse({...trainingState,...progress,...change})),e=>e.status===502&&!e.message.includes(key));
  await assert.rejects(sendControl(installs().get('key-properties'),'GET','/api/agent-builder/training/profile',undefined,async()=>jsonResponse({...trainingState,approval_current:true})),e=>e.status===502);
});
const voiceSettingsState={provider:'retell',verified:true,saved_voice:{voice_id:'voice-new',voice_name:'New voice'},published:{version_id:'version-a',voice_id:'voice-old',status:'published'},can_apply:false,blocker:'A voice change is pending.',outreach_started:false};
const voiceProgress={operation_id:voiceApplyBody.request_id,parent_version_id:'version-a',version_id:'version-b',status:'queued',step:'voice',unchanged:false};
test('Voice progress returns only a bounded existing operation and never posts while checking',async()=>{
  const seen=[];
  const result=await sendControl(installs().get('key-properties'),'GET','/api/agent-builder/voice-settings',undefined,async(_url,options)=>{seen.push(options.method);return jsonResponse({...voiceSettingsState,voice_operation:{...voiceProgress,secret:key,from_number:'+447700900123',bindings:{secret:key}}});});
  assert.deepEqual(result,{...voiceSettingsState,voice_operation:voiceProgress});assert.deepEqual(seen,['GET']);
  for(const status of ['processing','uncertain','failed','reconciling']){
    const response=await sendControl(installs().get('key-properties'),'GET','/api/agent-builder/voice-settings',undefined,async()=>jsonResponse({...voiceSettingsState,voice_operation:{...voiceProgress,status}}));
    assert.equal(response.voice_operation.status,status);
  }
  const published={...voiceSettingsState,published:{version_id:'version-b',voice_id:'voice-new',status:'published'},voice_operation:{...voiceProgress,status:'published',step:'complete'}};
  assert.equal((await sendControl(installs().get('key-properties'),'GET','/api/agent-builder/voice-settings',undefined,async()=>jsonResponse(published))).voice_operation.status,'published');
  assert.equal((await sendControl(installs().get('key-properties'),'GET','/api/agent-builder/voice-settings',undefined,async()=>jsonResponse({...voiceSettingsState,voice_operation:null}))).voice_operation,null);
});
test('Voice progress holds mismatched publication malformed IDs unknown states and credential exposure',async()=>{
  for(const change of [{operation_id:'short'},{operation_id:key},{parent_version_id:'version-b'},{status:'published',step:'complete'},{status:'not-real'},{step:'create_brain'},{unchanged:true}]){
    let requests=0;
    await assert.rejects(sendControl(installs().get('key-properties'),'GET','/api/agent-builder/voice-settings',undefined,async()=>{requests++;return jsonResponse({...voiceSettingsState,voice_operation:{...voiceProgress,...change}});}),e=>e.status===502&&!e.message.includes(key));
    assert.equal(requests,1);
  }
});
test('Voice apply uses an explicit action and a saved verified choice, never a client-selected voice or caller',async()=>{
  const path='/installations/key-properties/agent-voice-apply';
  await assert.rejects(build({authorize:async()=>['POST:agent-connect','POST:agent-publish']})({identity,method:'POST',path,body:voiceApplyBody}),e=>e.status===403);
  await assert.rejects(build({verifyCsrf:async()=>false})({identity,method:'POST',path,body:voiceApplyBody}),e=>e.status===403);
  for(const field of ['voice_id','secret','from_number','to_number','workspaceId','bindings'])await assert.rejects(build()({identity,method:'POST',path,body:{...voiceApplyBody,[field]:'override'}}),e=>e.status===400);
  const raw={version_id:'new-version',operation_id:voiceApplyBody.request_id,status:'queued',queued:true,unchanged:false,outreach_started:false,bindings:{secret:key}};
  const result=await sendControl(installs().get('key-properties'),'POST','/api/agent-builder/voice-apply',voiceApplyBody,async()=>jsonResponse(raw));
  assert.deepEqual(result,{version_id:'new-version',operation_id:voiceApplyBody.request_id,status:'queued',queued:true,unchanged:false,outreach_started:false});
  await assert.rejects(sendControl(installs().get('key-properties'),'POST','/api/agent-builder/voice-apply',voiceApplyBody,async()=>jsonResponse({...raw,operation_id:'other-operation'})),e=>e.status===502);
});
test('Voice catalog keeps pre-page filtering explicit and safely projects supported voices and facets',async()=>{
  const body={provider:'cartesia',gender:'female',accent:'British',query:'Eve',offset:0};
  const raw={provider:'retell',voices:[{voice_id:'voice-eve',voice_name:'Eve',provider:'cartesia',gender:'female',accent:'British',supported:true,preview_audio_url:'https://supplier.invalid/private',secret:key}],facets:{providers:['cartesia'],genders:['female'],accents:['British']},total:1,offset:0,next_offset:null,truncated:false,outreach_started:false};
  let sent;
  const result=await sendControl(installs().get('key-properties'),'POST','/api/agent-builder/voice-catalog',body,async(url,options)=>{sent={url,options};return jsonResponse(raw);});
  assert.equal(result.voices[0].voice_name,'Eve');assert.equal(result.voices[0].supported,true);assert.equal(Object.hasOwn(result.voices[0],'preview_audio_url'),false);
  assert.deepEqual(JSON.parse(sent.options.body),body);assert.equal(sent.url,'https://leadrelay.example.com/api/agent-builder/voice-catalog');
  for(const change of [{offset:-1},{offset:2001},{url:'https://evil.invalid'},{secret:providerSecret},{query:'x'.repeat(121)}])await assert.rejects(build()({identity,method:'POST',path:'/installations/key-properties/agent-voice-catalog',body:{...body,...change}}),e=>e.status===400);
});
test('Voice previews contain bounded audio bytes only and reject targets, credentials and active content',async()=>{
  const body={voice_id:'voice-eve'},audio=Buffer.from('RIFF synthetic audio WAVE').toString('base64');
  const result=await sendControl(installs().get('key-properties'),'POST','/api/agent-builder/voice-preview',body,async()=>jsonResponse({provider:'retell',voice_id:'voice-eve',mime:'audio/wav',audio_base64:audio,outreach_started:false,preview_audio_url:'https://supplier.invalid/private'}));
  assert.deepEqual(result,{provider:'retell',voice_id:'voice-eve',mime:'audio/wav',audio_base64:audio,outreach_started:false});
  for(const change of [{url:'https://evil.invalid'},{from_number:'+447700900123'},{secret:providerSecret}])await assert.rejects(build()({identity,method:'POST',path:'/installations/key-properties/agent-voice-preview',body:{...body,...change}}),e=>e.status===400);
  for(const change of [{mime:'text/html'},{audio_base64:Buffer.alloc(524289).toString('base64')},{voice_id:'different'},{audio_base64:Buffer.from(key).toString('base64')},{outreach_started:true}])await assert.rejects(sendControl(installs().get('key-properties'),'POST','/api/agent-builder/voice-preview',body,async()=>jsonResponse({...result,...change})),e=>e.status===502);
});

test('New voice read, catalog, preview and choice actions never inherit older connection grants',async()=>{
  let sends=0;const transport=async()=>{sends++;return {};};
  const old=build({authorize:async()=>['GET:agent-connection','POST:agent-voices','POST:agent-connect','POST:agent-publish'],transport});
  for(const [method,action,body] of [['GET','agent-voice-settings',undefined],['POST','agent-voice-catalog',{}],['POST','agent-voice-preview',{voice_id:'voice-a'}],['POST','agent-voice-choice',{voice_id:'voice-a'}]]){
    await assert.rejects(old({identity,method,path:'/installations/key-properties/'+action,body}),e=>e.status===403);
    if(method==='POST')await assert.rejects(build({verifyCsrf:async()=>false,transport})({identity,method,path:'/installations/key-properties/'+action,body}),e=>e.status===403);
  }
  assert.equal(sends,0);
});
test('Saving a voice choice accepts no caller or credential override and returns only the matching choice',async()=>{
  const path='/api/agent-builder/voice-choice',body={voice_id:'voice-eve'};
  for(const field of ['from_number','secret','webhook_secret','version_id','workspaceId','bindings'])await assert.rejects(build()({identity,method:'POST',path:'/installations/key-properties/agent-voice-choice',body:{...body,[field]:'override'}}),e=>e.status===400);
  const result=await sendControl(installs().get('key-properties'),'POST',path,body,async()=>jsonResponse({provider:'retell',saved:true,voice_id:'voice-eve',voice_name:'Eve',outreach_started:false,caller:'+447700900123',bindings:{secret:key}}));
  assert.deepEqual(result,{provider:'retell',saved:true,voice_id:'voice-eve',voice_name:'Eve',outreach_started:false});
  await assert.rejects(sendControl(installs().get('key-properties'),'POST',path,body,async()=>jsonResponse({...result,voice_id:'other-voice'})),e=>e.status===502);
});


test('Training categories are exact metadata on source/upload and cannot rewrite a reviewed source category',async()=>{
  for(const category of ['general','brand_guidelines','brand_voice'])for(const action of ['agent-training-source','agent-training-upload']){
    const body={...trainingWriteBodies[action],category};
    const accepted=await build()({identity,method:'POST',path:'/installations/key-properties/'+action,body});
    assert.equal(accepted.body.category,category);
  }
  for(const category of ['',null,'brand','agent.train',{workspaceId:'other'}])for(const action of ['agent-training-source','agent-training-upload'])
    await assert.rejects(build()({identity,method:'POST',path:'/installations/key-properties/'+action,body:{...trainingWriteBodies[action],category}}),e=>e.status===400);
  await assert.rejects(build()({identity,method:'POST',path:'/installations/key-properties/agent-training-review',body:{...trainingWriteBodies['agent-training-review'],category:'brand_voice'}}),e=>e.status===400);
  const legacy={...trainingSource};delete legacy.category;
  const result=await sendControl(installs().get('key-properties'),'GET','/api/agent-builder/training/sources',undefined,async()=>jsonResponse({sources:[legacy,{...trainingSource,category:'brand_guidelines'},{...trainingSource,category:'brand_voice'}],outreach_started:false}));
  assert.deepEqual(result.sources.map(row=>row.category),['general','brand_guidelines','brand_voice']);
  await assert.rejects(sendControl(installs().get('key-properties'),'GET','/api/agent-builder/training/sources',undefined,async()=>jsonResponse({sources:[{...trainingSource,category:'unsupported'}],outreach_started:false})),e=>e.status===502);
});


test('Existing builder read safely projects scoped website installer metadata without new permissions',async()=>{
  const details={workspace_id:'business-a',script_url:'https://leadrelay.example.com/widget.js',runtime_enabled:true,worker_enabled:true,business_enabled:true,chat_enabled:true,origins:['https://business.example/'],deployed_version_id:'version-a',paused:false,available:true};
  const request={identity,path:'/installations/key-properties/agent-status'};
  const allowed=await build({authorize:async()=>['GET:agent-status']})(request);assert.equal(allowed.path,'/api/agent-builder');
  const result=await sendControl(installs().get('key-properties'),'GET','/api/agent-builder',undefined,async()=>jsonResponse({business_name:'A',website_chat:{...details,secret:key,provider_bindings:{private:key}}}));
  assert.deepEqual(result,{business_name:'A',website_chat:{...details,origins:['https://business.example']}});
  for(const change of [{script_url:'javascript:alert(1)'},{script_url:'https://user:password@leadrelay.example.com/widget.js'},{script_url:'https://leadrelay.example.com/other.js'},{origins:['https://business.example/path']},{origins:Array(21).fill('https://business.example')},{paused:true},{worker_enabled:false},{workspace_id:key},{available:'true'},{deployed_version_id:null}])
    await assert.rejects(sendControl(installs().get('key-properties'),'GET','/api/agent-builder',undefined,async()=>jsonResponse({website_chat:{...details,...change}})),e=>e.status===502&&!e.message.includes(key));
  assert.deepEqual(await sendControl(installs().get('key-properties'),'GET','/api/agent-builder',undefined,async()=>jsonResponse({business_name:'Old version'})),{business_name:'Old version'});
});
