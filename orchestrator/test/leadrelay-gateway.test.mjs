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
