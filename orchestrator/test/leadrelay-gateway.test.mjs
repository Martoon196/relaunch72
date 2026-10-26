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
