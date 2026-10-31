import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMhpMount } from '../src/mhp/mount.js';
import { MhpCommerceError } from '../src/mhp/commerce-service.js';
import { portalCsrfToken } from '../src/portal/session.js';
import type { PostgresPortalDeps } from '../src/portal/router.js';
import { MARTIN_HOWARD_PROPERTY_PROFILE } from '../src/portal/product-profile.js';
import { mhpOwnerEmailNewDraft, mhpOwnerEmailPage } from '../src/mhp/owner-email-view.js';
import type { MhpOwnerEmailService } from '../src/mhp/owner-email-service.js';
import { ids,identity,token,now,copy,local,review,snapshot } from './helpers/mhp-owner-email-fixture.js';

const HOST='app.martinhowardproperty.co.uk',ORIGIN=`https://${HOST}`,SECRET='synthetic-owner-email-native-session-secret-32';
function fixture(){
  const state={authenticated:true,allowed:true,calls:[] as string[],input:null as unknown,current:{...review}};
  const authorize=(given:{sessionToken:string;workspaceId:string})=>{assert.equal(given.sessionToken,token);assert.equal(given.workspaceId,identity.workspaceId);if(!state.allowed)throw new MhpCommerceError(403,'Open the owner marketing workspace.');};
  const emails:Pick<MhpOwnerEmailService,'snapshot'|'review'|'preview'|'save'|'publish'|'queue'|'test'>={
    snapshot:async given=>{authorize(given);return snapshot;},review:async(given,_request,item,version)=>{authorize(given);assert.equal(item,ids.item);assert.equal(version,ids.version);return{review:state.current,local};},
    preview:async(given,_request,subject,body)=>{authorize(given);state.calls.push('preview');return{subject,text:body,html:'<p>sample</p>',unsubscribe:'https://example.invalid/preview'};},
    save:async(given,_request,input)=>{authorize(given);state.calls.push('save');state.input=input;return{contentItemId:ids.item,contentVersionId:ids.version,replayed:false};},
    publish:async given=>{authorize(given);state.calls.push('publish');state.current={...review,approvalStatus:'approved'};},
    test:async given=>{authorize(given);state.calls.push('test');return'accepted';},
    queue:async(given,_request,input)=>{authorize(given);state.calls.push(input.action);state.input=input;return{action:input.action,contentItemId:ids.item,contentVersionId:ids.version,changed:3,remaining:0,inFlight:1,replayed:false};}};
  const portal={kind:'postgres',secure:true,sessionSecret:SECRET,sessionCookieName:'__Host-mhp_session',productProfile:MARTIN_HOWARD_PROPERTY_PROFILE,portalBaseUrl:ORIGIN,now:()=>now,
    crm:{} as PostgresPortalDeps['crm'],auth:{resolve:async given=>state.authenticated&&given===token?identity:null,login:async()=>null,revoke:async()=>{}},abuseHashSecret:SECRET,
    requestContext:()=>({requestId:ids.request,requestHash:Buffer.alloc(32,1),sourceHash:Buffer.alloc(32,2)}),
    abuse:{admit:async()=>({allowed:true,leaseHash:Buffer.alloc(32,1),retryAfterSeconds:0}),complete:async()=>{},assertReady:async()=>{},close:async()=>{}}} as PostgresPortalDeps;
  const mount=createMhpMount({portal,ownerEmail:emails,authMount:{handle:async()=>false},readiness:async()=>[],
    hq:{isOwner:async()=>true,snapshot:async()=>({people:[],products:[],grants:[]}),grant:async()=>ids.command},
    commerce:{billingEnabled:false,snapshot:async()=>{throw Error('excluded');},refund:async()=>{},billingPortal:async()=>'',webhook:async()=>{}},
    marketingWorkspace:{snapshot:async given=>{authorize(given);return{userId:identity.userId,selectedWorkspaceId:identity.workspaceId,personalWorkspaceId:ids.prospect,marketingWorkspaceId:identity.workspaceId,marketingSelected:true};},select:async()=>{throw Error('not part of editor test');}}});
  const saved=(extra:Record<string,string>={})=>new URLSearchParams({csrf:portalCsrfToken(SECRET,token),commandId:ids.command,itemId:ids.item,versionId:ids.version,...extra}).toString();
  const draft=(extra:Record<string,string>={})=>new URLSearchParams({csrf:portalCsrfToken(SECRET,token),commandId:ids.command,...copy,contentItemId:'',previousVersionId:'',...extra}).toString();
  async function request(method:string,path:string,body='',headers:Record<string,string>={}){
    const result={status:0,headers:{} as Record<string,string>,body:''};
    const req=Object.assign(Readable.from([Buffer.from(body)]),{method,url:path,headers:{host:HOST,cookie:`__Host-mhp_session=${token}`,'content-type':'application/x-www-form-urlencoded',origin:ORIGIN,...headers}}) as unknown as IncomingMessage;
    const res={writeHead(status:number,head:Record<string,string>={}){result.status=status;Object.assign(result.headers,head);},setHeader(key:string,value:string){result.headers[key.toLowerCase()]=value;},end(body=''){result.body=body;}} as unknown as ServerResponse;
    await mount.handle(req,res);return result;
  }
  return{state,request,saved,draft};
}
test('native marketing frontdoor links to editor and pages preserve same-origin forms, no-store and return control',async()=>{
  const f=fixture();const landing=await f.request('GET','/hq/marketing');assert.match(landing.body,/href="\/hq\/marketing\/emails"/);
  for(const path of ['/hq/marketing/emails','/hq/marketing/emails?new=blank',`/hq/marketing/emails?item=${ids.item}&version=${ids.version}`]){
    const page=await f.request('GET',path);assert.equal(page.status,200);assert.equal(page.headers['cache-control'],'no-store');assert.equal(page.headers['referrer-policy'],'same-origin');
    assert.match(page.headers['content-security-policy']!,/form-action 'self'/);assert.match(page.body,/<meta name="referrer" content="same-origin">/);assert.match(page.body,/Return to personal Desk/);
  }
});
test('native save redirects to immutable version, preview keeps unsaved fields and invokes no publication',async()=>{
  const f=fixture();const saved=await f.request('POST','/hq/marketing/emails/save',f.draft());assert.equal(saved.status,303);assert.equal(saved.headers.location,`/hq/marketing/emails?item=${ids.item}&version=${ids.version}`);
  const preview=await f.request('POST','/hq/marketing/emails/preview',f.draft({subject:'Changed subject'}));assert.equal(preview.status,200);assert.match(preview.body,/Changed subject/);assert.deepEqual(f.state.calls,['save','preview']);
});
test('Publish is a single action with no queue effect; schedule explicitly converts entered UTC dates and reports in-flight limits',async()=>{
  const f=fixture();const result=await f.request('POST','/hq/marketing/emails/publish',f.saved());assert.equal(result.status,200);assert.match(result.body,/No audience email was scheduled or sent/);assert.deepEqual(f.state.calls,['publish']);
  const scheduled=await f.request('POST','/hq/marketing/emails/schedule',f.saved({dueAt:'2026-11-01T09:30',expiresAt:'2026-11-02T09:30'}));assert.equal(scheduled.status,200);assert.match(scheduled.body,/1 already being sent were left unchanged/);
  assert.equal((f.state.input as {dueAt:string}).dueAt,'2026-11-01T09:30:00.000Z');
});
test('foreign/null Origin, cross-site, old CSRF, forged actor/recipient, duplicate fields and wrong methods fail before action',async()=>{
  const f=fixture();
  for(const headers of [{origin:'null'},{origin:'https://evil.example'},{'sec-fetch-site':'cross-site'}] as Record<string,string>[])assert.equal((await f.request('POST','/hq/marketing/emails/test',f.saved(),headers)).status,403);
  assert.equal((await f.request('POST','/hq/marketing/emails/test',f.saved({csrf:portalCsrfToken(SECRET,'old-token')}))).status,403);
  for(const extra of ['&recipient=somebody%40example.invalid','&actorId='+ids.user,'&versionId='+ids.version])assert.equal((await f.request('POST','/hq/marketing/emails/test',f.saved()+extra)).status,400);
  assert.equal((await f.request('GET','/hq/marketing/emails/publish')).status,405);assert.equal((await f.request('POST','/hq/marketing/emails')).status,405);
  assert.deepEqual(f.state.calls,[]);
});
test('foreign host, missing native session and denied owner fail without capability access',async()=>{
  const f=fixture();assert.equal((await f.request('GET','/hq/marketing/emails','',{host:'app.propertypredator.co.uk'})).status,421);
  f.state.authenticated=false;const login=await f.request('GET','/hq/marketing/emails');assert.equal(login.status,303);assert.equal(login.headers.location,'/portal/login');
  f.state.authenticated=true;f.state.allowed=false;assert.equal((await f.request('GET','/hq/marketing/emails')).status,403);assert.equal((await f.request('POST','/hq/marketing/emails/publish',f.saved())).status,403);assert.deepEqual(f.state.calls,[]);
});
test('malformed schedule time, oversized form and mixed query selectors are rejected',async()=>{
  const f=fixture();assert.equal((await f.request('POST','/hq/marketing/emails/schedule',f.saved({dueAt:'2026-02-30T10:00',expiresAt:'2026-11-02T10:00'}))).status,400);
  assert.equal((await f.request('POST','/hq/marketing/emails/save',f.draft(),{'content-length':'180001'})).status,413);
  assert.equal((await f.request('GET',`/hq/marketing/emails?new=blank&item=${ids.item}&version=${ids.version}`)).status,400);assert.deepEqual(f.state.calls,[]);
});
test('unsaved preview cannot publish/test old bytes and automatic five remain clearly separate',()=>{
  const html=mhpOwnerEmailPage({snapshot,detail:{review:{...review,approvalStatus:'approved'},local},draft:{...mhpOwnerEmailNewDraft('blank',ids.command),...copy,subject:'Changed subject',contentItemId:ids.item,previousVersionId:ids.version},csrf:'synthetic',commandId:ids.command,returnCommandId:ids.request});
  assert.match(html,/Save the changes above before publishing or testing/);assert.match(html,/<button disabled>Publish this version/);assert.match(html,/<button class="secondary" disabled>Send test/);assert.doesNotMatch(html,/action="\/hq\/marketing\/emails\/schedule"/);
  assert.match(html,/These five emails keep their existing wording and timing/);assert.equal((html.match(/Use wording as a starting point/g)??[]).length,5);
});
