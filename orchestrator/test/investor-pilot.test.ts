import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { InvestorService, renderInvestorTemplate, type InvestorBusiness, type InvestorProgramme } from '../src/portal/investor-service.js';
import { investorPage } from '../src/portal/investor-view.js';
import { portalCsrfToken } from '../src/portal/session.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import type { InvestorMailService } from '../src/portal/investor-mail-service.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';

const workspace='71000000-0000-4000-8000-000000000011';
const identity={sessionToken:'a'.repeat(43),requestId:'test-investor-1'};
const business:InvestorBusiness={workspaceId:workspace,ownerName:'Test owner',ownerEmail:'owner@example.invalid',brandName:'Northstar Partners',accentColor:'#155e75',signature:'Alex\nNorthstar Partners',senderEmail:'hello@northstar.example.invalid',accessState:'test',version:1,paymentReference:null};
const programme:InvestorProgramme={isAdmin:true,selectedWorkspaceId:workspace,workspaces:[{id:workspace,name:business.brandName,role:'admin'}],businesses:[business]};
function service() {
  const calls:{sql:string;values:unknown[]}[]=[];
  const identityPool={query:async(sql:string,values:unknown[])=>{calls.push({sql,values});return {rows:[{id:workspace,result:{setupNeeded:true}}]};}} as unknown as Pool;
  const readPool={query:async()=>({rows:[{snapshot:programme}]})} as unknown as Pool;
  return {calls,service:new InvestorService(readPool,identityPool,{} as Pool)};
}
test('new business uses a stable command key and stores only the session hash',async()=>{
  const s=service();
  await s.service.create(identity,{commandKey:workspace,brandName:'Northstar',ownerName:'Alex',ownerEmail:'ALEX@example.invalid',kind:'test'});
  assert.equal(s.calls.length,1);assert.equal(s.calls[0]!.values[5],'alex@example.invalid');
  assert.equal((s.calls[0]!.values[0] as Buffer).length,32);
  assert.ok(!s.calls[0]!.values.includes(identity.sessionToken));
});
test('invalid creation fields never reach database authority',async()=>{
  const s=service();
  await assert.rejects(()=>s.service.create(identity,{commandKey:workspace,brandName:'Northstar',ownerName:'Alex',ownerEmail:'a@b.invalid\nBcc: other@c.invalid',kind:'test'}));
  assert.equal(s.calls.length,0);
});
test('paid activation requires explicit checked confirmation and a reference',async()=>{
  const s=service();const f={workspaceId:workspace,version:'1',state:'active',paymentReference:'TEST-ONLY'};
  await assert.rejects(()=>s.service.access(identity,f));
  await assert.rejects(()=>s.service.access(identity,{...f,paymentConfirmed:'yes',paymentReference:''}));
  assert.equal(s.calls.length,0);
  const path=await s.service.access(identity,{...f,paymentConfirmed:'yes'});
  assert.match(path!,/^\/portal\/setup\?token=[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(s.calls).includes(path!.split('=')[1]!));
});
test('switching creates a fresh token and never trusts a browser user id',async()=>{
  const s=service();const token=await s.service.switchWorkspace(identity,workspace);
  assert.match(token,/^[A-Za-z0-9_-]{43}$/);assert.notEqual(token,identity.sessionToken);
  assert.equal(s.calls[0]!.values.length,4);assert.equal(s.calls[0]!.values[1],workspace);
  assert.notDeepEqual(s.calls[0]!.values[0],s.calls[0]!.values[2]);
});
test('brand controls reject CSS and email header injection',async()=>{
  const s=service();const f={workspaceId:workspace,version:'1',brandName:'Northstar',accentColor:'#155e75',senderEmail:'hello@example.invalid',signature:'Alex'};
  await assert.rejects(()=>s.service.branding(identity,{...f,accentColor:'red;display:none'}));
  await assert.rejects(()=>s.service.branding(identity,{...f,senderEmail:'hello@example.invalid\r\nBcc:x@y.invalid'}));
  assert.equal(s.calls.length,0);
});
test('templates bind each business independently and never expand tokens inside investor names',()=>{
  const a=renderInvestorTemplate('introduction',business,'{{business}}');
  const b=renderInvestorTemplate('introduction',{...business,brandName:'Harbour Homes',signature:'Sam'},'Jamie');
  assert.match(a.body,/Hi \{\{business\}\}/);assert.match(a.body,/Northstar Partners/);
  assert.match(b.body,/Harbour Homes/);assert.ok(!b.body.includes('Northstar'));
});
test('mentee view omits programme and paid-access controls and escapes untrusted content',()=>{
  const html=investorPage({programme:{...programme,isAdmin:false,businesses:[{...business,brandName:'<script>bad()</script>'}]},csrf:'csrf',email:'owner@example.invalid'});
  assert.ok(!html.includes('action="/portal/investors/create"'));assert.ok(!html.includes('action="/portal/investors/access"'));
  assert.ok(!html.includes('<script>bad()</script>'));assert.match(html,/&lt;script&gt;/);
});

async function route(method:string,path:string,body:string,cookie=identity.sessionToken,mail?:InvestorMailService,crmValidation=false) {
  const s=service();
  const req=new EventEmitter() as IncomingMessage; req.method=method;req.url=path;req.headers={cookie:`r72_portal=${cookie}`,'content-type':'application/x-www-form-urlencoded'};
  let status=0,headers:Record<string,unknown>={},html='';
  const res={writeHead:(code:number,h:Record<string,unknown>)=>{status=code;headers=h;},end:(value='')=>{html=value;}} as unknown as ServerResponse;
  const deps:PostgresPortalDeps={kind:'postgres',sessionSecret:'test-secret',secure:true,productProfile:PROPERTY_PREDATOR_GROWTH_PROFILE,investors:s.service,investorMail:mail,
    auth:{resolve:async token=>token===identity.sessionToken?{...identity,userId:workspace,workspaceId:workspace,userEmail:'owner@example.invalid'}:null,login:async()=>null,revoke:async()=>{}},
    crm:{snapshot:async()=>crmValidation?{workspace:{id:workspace,name:business.brandName,timezone:'Europe/London',snapshotAt:'2026-10-28T00:00:00Z',canWrite:true},contacts:[],stages:[],opportunities:[],tasks:[],timeline:[]}:null,
      createLead:async()=>crmValidation?{ok:false,kind:'validation',fieldErrors:{displayName:'Enter a name.'}}:{ok:true,disposition:'applied'},
      moveOpportunity:async()=>({ok:true,disposition:'applied'}),completeTask:async()=>({ok:true,disposition:'applied'})}};
  const run=handlePortal(req,res,deps);
  setImmediate(()=>{req.emit('data',Buffer.from(body));req.emit('end');});await run;
  return {status,headers,html,calls:s.calls};
}
test('anonymous investor page redirects to sign-in',async()=>{
  const r=await route('GET','/portal/investors','','invalid');assert.equal(r.status,302);assert.match(String(r.headers.location),/login/);
});
test('workspace switch rejects forged CSRF before calling the database',async()=>{
  const r=await route('POST','/portal/investors/switch',new URLSearchParams({_csrf:'forged',workspaceId:workspace}).toString());
  assert.equal(r.status,403);assert.equal(r.calls.length,0);
});
test('workspace switch renews secure cookie after database confirms the change',async()=>{
  const r=await route('POST','/portal/investors/switch',new URLSearchParams({_csrf:portalCsrfToken('test-secret',identity.sessionToken),workspaceId:workspace}).toString());
  assert.equal(r.status,302);assert.equal(r.calls.length,1);assert.match(String(r.headers['set-cookie']),/HttpOnly; SameSite=Lax; Path=\/; Max-Age=\d+; Secure/);
  assert.ok(!String(r.headers['set-cookie']).includes(identity.sessionToken));
});
test('conversation commands reject forged CSRF before any mail action',async()=>{
 let actions=0;const mail={draft:async()=>{actions++;return workspace;},send:async()=>{actions++;return 'accepted';},sync:async()=>{actions++;return {};}} as unknown as InvestorMailService;
 for(const action of ['draft','send','sync']){
  const r=await route('POST',`/portal/investors/email/${action}`,'_csrf=forged',identity.sessionToken,mail);assert.equal(r.status,403);
 }
 assert.equal(actions,0);
});
test('saving a draft redirects to canonical review without sending',async()=>{
 let drafts=0,sends=0;const mail={draft:async()=>{drafts++;return workspace;},send:async()=>{sends++;return 'accepted';}} as unknown as InvestorMailService;
 const r=await route('POST','/portal/investors/email/draft',new URLSearchParams({_csrf:portalCsrfToken('test-secret',identity.sessionToken),subject:'Draft'}).toString(),identity.sessionToken,mail);
 assert.equal(r.status,302);assert.equal(r.headers.location,`/portal/investors/email?message=${workspace}`);assert.equal(drafts,1);assert.equal(sends,0);
});
test('CRM validation keeps the selected investor brand on POST without mutating the deployment profile',async()=>{
 const get=await route('GET','/portal/crm/contacts','',identity.sessionToken,undefined,true);
 const post=await route('POST','/portal/crm/leads',new URLSearchParams({_csrf:portalCsrfToken('test-secret',identity.sessionToken),command_key:'branded-validation-proof'}).toString(),identity.sessionToken,undefined,true);
 assert.equal(get.status,200);assert.equal(post.status,400);
 for(const response of [get,post])assert.match(response.html,/<title>Northstar Partners CRM — Northstar Partners<\/title>/);
 assert.equal(PROPERTY_PREDATOR_GROWTH_PROFILE.productName,'PropertyPredator');
 assert.equal(PROPERTY_PREDATOR_GROWTH_PROFILE.investorWorkspace,undefined);
});
