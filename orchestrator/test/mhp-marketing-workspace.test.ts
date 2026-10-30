import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMhpMount } from '../src/mhp/mount.js';
import { PgMhpMarketingWorkspaceService, MHP_MARKETING_WORKSPACE_ID as BRAND } from '../src/mhp/marketing-workspace-service.js';
import { authorizeMhpMemberRoute } from '../src/mhp/member-service.js';
import { MhpCommerceError } from '../src/mhp/commerce-service.js';
import { portalCsrfToken } from '../src/portal/session.js';
import type { PostgresPortalDeps } from '../src/portal/router.js';
import { MARTIN_HOWARD_PROPERTY_PROFILE, MHP_MARKETING_WORKSPACE_PROFILE } from '../src/portal/product-profile.js';
import { appShell, pageHead } from '../src/portal/ui.js';

const HOST='app.martinhowardproperty.co.uk', ORIGIN=`https://${HOST}`;
const SECRET='mhp-marketing-synthetic-session-secret-at-least-32';
const TOKEN=Buffer.alloc(32,7).toString('base64url'), NEXT=Buffer.alloc(32,8).toString('base64url');
const USER='12400000-0000-4000-8000-000000000001', PERSONAL='12400000-0000-4000-8000-000000000002';
const COMMAND='12400000-0000-4000-8000-000000000003', STAGE='12400000-0000-4000-8000-000000000004';
const NOW=Date.parse('2026-10-30T12:00:00Z');
const hash=(value:string)=>createHash('sha256').update(value).digest();

function fixture(owner=true) {
  let selected=PERSONAL, currentToken=TOKEN;
  const calls:string[]=[];
  const identity=()=>({sessionToken:currentToken,userId:USER,workspaceId:selected,userEmail:'owner@example.invalid'});
  const portal:PostgresPortalDeps={kind:'postgres',secure:true,sessionSecret:SECRET,sessionCookieName:'__Host-mhp_session',
    productProfile:MARTIN_HOWARD_PROPERTY_PROFILE,portalBaseUrl:ORIGIN,now:()=>NOW,
    financeDrafts:{} as PostgresPortalDeps['financeDrafts'],
    auth:{resolve:async token=>token===currentToken?identity():null,login:async()=>null,revoke:async()=>{}},
    abuseHashSecret:'mhp-marketing-abuse-secret-at-least-32-characters',
    requestContext:()=>({requestId:COMMAND,requestHash:Buffer.alloc(32,1),sourceHash:Buffer.alloc(32,2)}),
    abuse:{admit:async()=>({allowed:true,leaseHash:Buffer.alloc(32,1),retryAfterSeconds:0}),complete:async()=>{},assertReady:async()=>{},close:async()=>{}},
    authorizeMemberRequest:async({path,method})=>authorizeMhpMemberRoute({userId:USER,workspaceId:selected,isAdmin:owner,crm:true,
      enquirySite:false,emailWorkflow:false,emailWritable:false,leadrelay:false,readOnly:false,endsAt:null,
      marketingWorkspace:selected===BRAND},{path,method}),
    crm:{snapshot:async request=>{assert.equal(request.sessionToken,currentToken);calls.push('crm');return {
      workspace:{id:selected,name:selected===BRAND?'Martin Howard Property · Marketing':'Personal Desk',timezone:'Europe/London',snapshotAt:new Date(NOW).toISOString(),canWrite:true},
      contacts:[],opportunities:[{id:COMMAND,contactId:USER,contactName:'Synthetic enquiry',title:'Website enquiry',stageId:STAGE,valueMinor:0,currency:'GBP',updatedAt:new Date(NOW).toISOString(),rowVersion:1,moveCommandKey:'synthetic-move'}],tasks:[],timeline:[],stages:[{id:STAGE,name:'New enquiry',position:10,isClosed:false},{id:'12400000-0000-4000-8000-000000000005',name:'Contacted',position:20,isClosed:false}]};},
      createLead:async request=>{assert.equal(request.sessionToken,currentToken);calls.push('create');return {ok:true,disposition:'applied'};},
      moveOpportunity:async request=>{assert.equal(request.sessionToken,currentToken);calls.push('move');return {ok:true,disposition:'applied'};},
      completeTask:async request=>{assert.equal(request.sessionToken,currentToken);calls.push('complete');return {ok:true,disposition:'applied'};},
      lead360:async(request,contactId)=>{assert.equal(request.sessionToken,currentToken);return {
        identity:{contactId,displayName:'Synthetic enquiry',companyName:null,primaryEmail:null,primaryPhone:null,ownerName:null},
        score:0,scoreExplanation:'No saved signals',journey:{label:'Enquiry',stages:[]},evidence:[],nextMove:{label:'Follow up',reason:'Saved enquiry',dueAt:null},
        offers:[],consent:[],suppressionReason:null,crm:{opportunities:[],tasks:[]},asOf:new Date(NOW).toISOString(),
      };},
    } as PostgresPortalDeps['crm'],
    investors:{snapshot:async()=>{calls.push('investor-programme');throw new Error('brand must not invoke investor programme');},
      requirementSummaries:async()=>{calls.push('requirements');throw new Error('brand must not invoke investor requirements');}} as unknown as PostgresPortalDeps['investors'],
  };
  const mount=createMhpMount({portal,authMount:{handle:async()=>false},readiness:async()=>[],
    hq:{isOwner:async()=>owner,snapshot:async()=>({people:[],products:[],grants:[]}),grant:async()=>COMMAND},
    commerce:{billingEnabled:false,snapshot:async()=>{throw new Error('excluded commerce');},refund:async()=>{},billingPortal:async()=>'',webhook:async()=>{}},
    marketingWorkspace:{snapshot:async input=>{
      if(!owner)throw new MhpCommerceError(403,'Owner access required.');
      assert.equal(input.workspaceId,selected);
      return {userId:USER,selectedWorkspaceId:selected,personalWorkspaceId:PERSONAL,marketingWorkspaceId:selected===BRAND?BRAND:null,marketingSelected:selected===BRAND};
    },select:async(input,action)=>{assert.equal(input.sessionToken,currentToken);calls.push(action);
      selected=action==='open'?BRAND:PERSONAL;currentToken=currentToken===TOKEN?NEXT:TOKEN;
      return {sessionToken:currentToken,expiresAt:new Date(NOW+60_000).toISOString(),workspaceId:selected};}},
  });
  async function request(method:string,url:string,body='',headers:Record<string,string>={}) {
    const captured={status:0,body:'',headers:{} as Record<string,string>};
    const req=Object.assign(Readable.from([Buffer.from(body)]),{method,url,headers:{host:HOST,cookie:`__Host-mhp_session=${currentToken}`,
      'content-type':'application/x-www-form-urlencoded',...headers}}) as unknown as IncomingMessage;
    const res={writeHead(status:number,headers={}){captured.status=status;Object.assign(captured.headers,headers);},
      setHeader(key:string,value:string){captured.headers[key.toLowerCase()]=value;},end(body=''){captured.body=body;}} as unknown as ServerResponse;
    await mount.handle(req,res);return captured;
  }
  const form=()=>new URLSearchParams({csrf:portalCsrfToken(SECRET,currentToken),commandId:COMMAND}).toString();
  return {request,form,calls,portal};
}

test('owner entry and return rotate the native cookie, render one brand mode and preserve request-local personal mode',async()=>{
  const f=fixture();const page=await f.request('GET','/hq/marketing');
  assert.equal(page.status,200);assert.equal(page.headers['cache-control'],'no-store');assert.match(page.body,/Open marketing workspace/);
  const opened=await f.request('POST','/hq/marketing/open',f.form(),{origin:ORIGIN});
  assert.equal(opened.status,303);assert.equal(opened.headers.location,'/portal/crm/opportunities');
  assert.match(opened.headers['set-cookie']!,new RegExp(`^__Host-mhp_session=${NEXT}`));assert.match(opened.headers['set-cookie']!,/Secure/);
  assert.equal(opened.headers['cache-control'],'no-store');
  const board=await f.request('GET','/portal/crm/opportunities');
  assert.equal(board.status,200);assert.match(board.body,/MHP marketing CRM/);assert.match(board.body,/Return to personal Desk/);
  assert.doesNotMatch(board.body,/href="\/portal\/investors|Investor record|Investor requirements/);
  assert.doesNotMatch(board.body,/Indicative finance/);
  assert.match(board.body,/data-opportunity-id="12400000-0000-4000-8000-000000000003"/);
  assert.match(board.body,/data-contact-href="\/portal\/crm\/contacts\/12400000-0000-4000-8000-000000000001"/);
  assert.match(board.body,/data-stage-id="12400000-0000-4000-8000-000000000004"/);
  assert.match(board.body,/draggable="true"/);
  assert.match(board.body,/action="\/portal\/crm\/opportunities\/12400000-0000-4000-8000-000000000003\/stage"/);
  assert.match(board.body,/Move stage<\/button>/);
  assert.equal(f.calls.includes('investor-programme'),false);assert.equal(f.calls.includes('requirements'),false);
  assert.equal(f.portal.productProfile,MARTIN_HOWARD_PROPERTY_PROFILE);
  const returned=await f.request('POST','/hq/marketing/return',f.form(),{origin:ORIGIN});
  assert.equal(returned.status,303);assert.equal(returned.headers.location,'/portal/investors');
  assert.match((await f.request('GET','/hq/marketing')).body,/Open marketing workspace/);
});

test('owner form denies member, foreign host/cookie, Origin, CSRF, duplicate and override fields before selection',async()=>{
  const f=fixture();const body=f.form();
  assert.equal((await fixture(false).request('GET','/hq/marketing')).status,403);
  assert.equal((await f.request('GET','/hq/marketing','',{host:'hq.propertypredator.com'})).status,421);
  assert.equal((await f.request('GET','/hq/marketing','',{cookie:`r72_portal=${TOKEN}`})).headers.location,'/portal/login');
  for(const origin of ['', 'null','https://hq.propertypredator.com'])assert.equal((await f.request('POST','/hq/marketing/open',body,{origin})).status,403);
  assert.equal((await f.request('POST','/hq/marketing/open',body,{origin:ORIGIN,'sec-fetch-site':'cross-site'})).status,403);
  assert.equal((await f.request('POST','/hq/marketing/open',body.replace(/csrf=[^&]+/,'csrf=wrong'),{origin:ORIGIN})).status,403);
  for(const extra of [`&commandId=${COMMAND}`,`&workspaceId=${PERSONAL}`,`&userId=${USER}`])assert.equal((await f.request('POST','/hq/marketing/open',body+extra,{origin:ORIGIN})).status,400);
  assert.equal((await f.request('GET','/hq/marketing/open')).status,405);
  assert.deepEqual(f.calls,[]);
});

test('rotated token and old CSRF fail; current brand session reaches shared stage/task commands only',async()=>{
  const f=fixture();const oldCsrf=portalCsrfToken(SECRET,TOKEN);
  await f.request('POST','/hq/marketing/open',f.form(),{origin:ORIGIN});
  assert.equal((await f.request('GET','/hq/marketing','',{cookie:`__Host-mhp_session=${TOKEN}`})).headers.location,'/portal/login');
  const common=new URLSearchParams({_csrf:portalCsrfToken(SECRET,NEXT),command_key:'synthetic-1',expected_version:'1',target_stage_id:STAGE}).toString();
  const path=`/portal/crm/opportunities/${COMMAND}/stage`;
  assert.equal((await f.request('POST',path,common.replace(/_csrf=[^&]+/,`_csrf=${oldCsrf}`),{origin:ORIGIN})).status,403);
  assert.equal((await f.request('POST',path,common,{origin:ORIGIN})).status,302);
  assert.equal((await f.request('POST',`/portal/crm/tasks/${COMMAND}/complete`,common,{origin:ORIGIN})).status,302);
  for(const path of ['/portal/investors','/portal/investors/email','/portal/investors/site','/portal/leadrelay','/portal/api/leadrelay/v1/chat',`/portal/crm/opportunities/${COMMAND}/finance`])assert.equal((await f.request('GET',path)).status,404,path);
  assert.deepEqual(f.calls,['open','move','complete']);
});

test('every selected marketing CRM page uses matching same-origin header and head policy for native return',async()=>{
  const f=fixture();
  await f.request('POST','/hq/marketing/open',f.form(),{origin:ORIGIN});
  for(const path of ['/portal/crm/opportunities','/portal/crm/contacts','/portal/crm/tasks',`/portal/crm/contacts/${USER}`]){
    const page=await f.request('GET',path);
    assert.equal(page.status,200,path);
    assert.equal(page.headers['referrer-policy'],'same-origin',path);
    assert.equal(page.headers['cache-control'],'no-store',path);
    assert.match(page.body,/<meta name="referrer" content="same-origin">/,path);
    assert.doesNotMatch(page.body,/<meta name="referrer" content="no-referrer">/,path);
    assert.match(page.body,/action="\/hq\/marketing\/return"/,path);
  }
  for(const origin of ['null','', 'https://hq.propertypredator.com']){
    assert.equal((await f.request('POST','/hq/marketing/return',f.form(),{origin})).status,403);
  }
  assert.equal((await f.request('POST','/hq/marketing/return',f.form().replace(/csrf=[^&]+/,'csrf=wrong'),{origin:ORIGIN})).status,403);
  assert.equal((await f.request('POST','/hq/marketing/return',f.form(),{origin:ORIGIN})).status,303);
  assert.equal(f.portal.productProfile,MARTIN_HOWARD_PROPERTY_PROFILE);
});

test('marketing presentation does not change non-CRM page-head or shell policy',()=>{
  assert.match(pageHead('Unrelated page',MHP_MARKETING_WORKSPACE_PROFILE),/<meta name="referrer" content="no-referrer">/);
  assert.match(appShell({title:'Unrelated page',tenantName:'Synthetic',active:'overview',body:'',productProfile:MHP_MARKETING_WORKSPACE_PROFILE}),/<meta name="referrer" content="no-referrer">/);
});

test('service sends only session hashes, fixed action and entropy to existing SQL capability',async()=>{
  const identity={sessionToken:TOKEN,userId:USER,workspaceId:PERSONAL,userEmail:'owner@example.invalid'};
  const calls:unknown[][]=[];
  const service=new PgMhpMarketingWorkspaceService({query:async()=>({rows:[{snapshot:{userId:USER,selectedWorkspaceId:PERSONAL,personalWorkspaceId:PERSONAL,marketingWorkspaceId:null,marketingSelected:false}}]})} as never,
    {query:async(_sql:string,values:unknown[])=>{calls.push(values);return {rows:[{user_id:USER,selected_workspace_id:BRAND,expires_at:new Date(NOW+60_000)}]};}} as never);
  assert.equal((await service.snapshot(identity)).personalWorkspaceId,PERSONAL);
  const opened=await service.select(identity,'open',COMMAND,NOW);
  assert.deepEqual(calls[0]?.[0],hash(TOKEN));assert.equal(calls[0]?.[1],'open');assert.deepEqual(calls[0]?.[2],hash(opened.sessionToken));
  assert.equal((calls[0]?.[3] as Buffer).length,32);assert.equal(calls[0]?.[4],COMMAND);assert.equal(calls[0]?.length,5);
  assert.notEqual(opened.sessionToken,TOKEN);assert.equal(calls.flat().includes(TOKEN),false);
  await assert.rejects(service.select(identity,'open','not-a-command',NOW),MhpCommerceError);
});

test('service rejects identity drift and keeps raw database errors out of safe failures',async()=>{
  const identity={sessionToken:TOKEN,userId:USER,workspaceId:PERSONAL,userEmail:'owner@example.invalid'};
  const service=new PgMhpMarketingWorkspaceService({query:async()=>({rows:[{snapshot:{userId:USER,selectedWorkspaceId:BRAND,personalWorkspaceId:PERSONAL,marketingWorkspaceId:BRAND,marketingSelected:true}}]})} as never,
    {query:async()=>{throw Object.assign(new Error('raw database private detail'),{code:'42501'});}} as never);
  await assert.rejects(service.snapshot(identity),/Sign in to your MHP workspace/);
  await assert.rejects(service.select(identity,'open',COMMAND,NOW),error=>error instanceof MhpCommerceError&&error.status===403&&!error.message.includes('raw database'));
});
