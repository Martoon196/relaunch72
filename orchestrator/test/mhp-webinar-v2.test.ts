import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PostgresPortalDeps } from '../src/portal/router.js';
import { handleMhpGrowth } from '../src/mhp/growth-router.js';
import { MhpGrowthError, PgMhpGrowthService, mhpWebinarConfig, parseMhpApplication } from '../src/mhp/growth-service.js';
import type { Pool } from 'pg';

const SITE='https://martinhowardproperty.co.uk', APP='https://app.martinhowardproperty.co.uk';
const TOKEN='A'.repeat(43), USER='a1360000-0000-4000-8000-000000000001', WS='a1360000-0000-4000-8000-000000000002';
const applicationForm={NAME:'Applicant Test',EMAIL:'applicant@example.invalid',PHONE:'07700 900136',LOCATION:'Test area',EXPERIENCE:'None yet',DOOR:'Source',HOURS:'5 to 10',OBJECTIVE:'A clear ninety day objective',OBSTACLE:'Direction',SUPPORT:'Group mentoring',PRICE_UNDERSTOOD:'yes',DISCUSS:'yes',CONSENT:'1',SOURCE:'site'};
function fixture(owner=true){
 const calls={apply:0,events:0,apps:0,registrants:0,capturedConsent:null as boolean|null,handoffs:0};
 const portal={kind:'postgres',secure:true,sessionSecret:'mhp136-synthetic-secret-at-least32',abuseHashSecret:'mhp136-abuse-secret-at-least32',
  auth:{resolve:async(token:string)=>token===TOKEN?{sessionToken:TOKEN,userId:USER,workspaceId:WS,userEmail:'owner@example.invalid'}:null},
  requestContext:()=>({requestId:USER,sourceHash:Buffer.alloc(32,1),requestHash:Buffer.alloc(32,2)}),
  abuse:{admit:async()=>({allowed:true}),complete:async()=>{}},now:()=>Date.parse('2026-11-03T12:00:00Z')} as unknown as PostgresPortalDeps;
 const checkOwner=()=>{if(!owner)throw new MhpGrowthError(403,'MHP administration required');};
 const deps={portal,unsubscribeSecret:'s'.repeat(48),marketingMode:'test',learning:{} as never,
  growth:{capture:async(s:{consent:boolean})=>{calls.capturedConsent=s.consent;return {prospectId:USER,signupId:WS,campaign:'webinar-2026-11-04',entryEventSequence:'1',queued:4};},story:async()=>{},unsubscribe:async()=>true,summary:async()=>{checkOwner();return {} as never;},
   apply:async()=>{calls.apply++;return {applicationId:USER,prospectId:WS};},event:async()=>{calls.events++;return true;},
   listApplications:async()=>{checkOwner();calls.apps++;return [];},listRegistrants:async()=>{checkOwner();calls.registrants++;return [];}},
  phoneSignup:{fromSignup:async()=>{calls.handoffs++;return {capability:'C'.repeat(43),maxAge:900};}}};
 async function request(method:string,path:string,fields:Record<string,string>={},headers:Record<string,string>={}){
  const result={status:0,headers:{} as Record<string,string>,body:''};
  const req=Object.assign(Readable.from([Buffer.from(new URLSearchParams(fields).toString())]),{method,url:path,headers:{origin:SITE,'content-type':'application/x-www-form-urlencoded',cookie:`__Host-mhp_session=${TOKEN}`,...headers}}) as unknown as IncomingMessage;
  const res={writeHead(status:number,headers={}){result.status=status;Object.assign(result.headers,headers);},end(body=''){result.body=body;}} as unknown as ServerResponse;
  await handleMhpGrowth(req,res,new URL(path,APP),deps);return result;
 }
 return{calls,request};
}

test('public applications enforce actual Origin, body/honeypot and required permission fields',async()=>{
 const f=fixture();assert.equal((await f.request('POST','/api/mhp/apply',applicationForm)).status,303);assert.equal(f.calls.apply,1);
 assert.equal((await f.request('POST','/api/mhp/apply',{...applicationForm,email_address_check:'bot'})).status,303);assert.equal(f.calls.apply,1);
 for(const origin of ['null','https://evil.example',''])assert.equal((await f.request('POST','/api/mhp/apply',applicationForm,{origin})).status,403);
 assert.equal((await f.request('POST','/api/mhp/apply',{...applicationForm,CONSENT:''})).status,400);
 assert.equal((await f.request('POST','/api/mhp/apply',applicationForm,{'content-length':'16385'})).status,413);
 assert.equal((await f.request('POST','/api/mhp/apply',applicationForm,{'content-type':'application/json'})).status,415);
 assert.equal(f.calls.apply,1);
});

test('owner application and CSV routes preserve native authorization and no-store while member/absent sessions are denied',async()=>{
 const f=fixture();for(const path of ['/hq/applications','/hq/registrants','/hq/registrants?format=csv']){const r=await f.request('GET',path);assert.equal(r.status,200);assert.equal(r.headers['cache-control'],'no-store');}
 const csv=await f.request('GET','/hq/registrants?format=csv');assert.equal(csv.headers['content-type'],'text/csv; charset=utf-8');assert.match(csv.headers['content-disposition']!,/attachment/);
 const member=fixture(false);for(const path of ['/hq/applications','/hq/registrants?format=csv'])assert.equal((await member.request('GET',path)).status,403);
 assert.equal((await f.request('GET','/hq/applications',{}, {cookie:''})).status,303);
 assert.equal((await f.request('POST','/hq/registrants',{}, {origin:APP})).status,405);
});

test('optional checkbox registration keeps the existing same-browser handoff and real returned signup identity',async()=>{
 const f=fixture();const r=await f.request('POST','/api/mhp/subscribe',{FIRSTNAME:'Test',EMAIL:'new@example.invalid',CHEATSHEET:'Webinar',CHEATSHEET_LINK:`${SITE}/webinar/`,OPT_IN:''});
 assert.equal(r.status,303);assert.equal(r.headers.location,`${APP}/webinar/phone-reminders/choose`);assert.match(r.headers['set-cookie']!,/Secure; HttpOnly; SameSite=Strict/);assert.equal(f.calls.capturedConsent,false);assert.equal(f.calls.handoffs,1);
});

test('event beacons count only bounded allowlisted requests and always reveal no result',async()=>{
 const f=fixture();assert.equal((await f.request('POST','/api/mhp/event',{e:'live_page_opened',p:'/webinar/live/'})).status,204);assert.equal(f.calls.events,1);
 for(const [fields,headers] of [[{e:'watched',p:'/webinar/'},{}],[{e:'live_page_opened',p:'/webinar/'},{origin:'https://evil.example'}]] as const)assert.equal((await f.request('POST','/api/mhp/event',fields,headers)).status,204);
 assert.equal(f.calls.events,1);
});

test('PG adapter uses the new closed capture/claim and owner capabilities; optional phone never invokes email-only setters',async()=>{
 const calls:{sql:string;values:unknown[]}[]=[];
 const pool={query:async(sql:string,values:unknown[]=[])=>{calls.push({sql,values});return {rows:[{outcome:{signupId:WS,prospectId:USER,campaign:'webinar-2026-11-04',entryEventSequence:'12',queued:4},claimed:[],applications:[],registrants:[]}]};}} as unknown as Pick<Pool,'query'>;
 const service=new PgMhpGrowthService(pool,pool,mhpWebinarConfig({}));
 await service.capture({email:'new@example.invalid',firstName:'Test',level:null,consent:false,kind:'webinar',label:'Webinar',module:null,link:null,phone:'07700 900136'},Buffer.alloc(32,1),Date.parse('2026-11-03T12:00:00Z'));
 await service.claim(10,60,['new@example.invalid']);await service.listApplications(TOKEN);await service.listRegistrants(TOKEN);
 assert.match(calls[0]!.sql,/mhp_capture_signup_v3/);assert.equal(calls[0]!.values[3],false);assert.equal(calls[0]!.values[12],'07700 900136');
 assert.ok(calls.some(x=>x.sql.includes('mhp_claim_marketing_sends_v2')));assert.doesNotMatch(calls.map(x=>x.sql).join('\n'),/mhp_set_prospect_phone|INSERT|UPDATE/);
 const invalid={query:async()=>({rows:[{outcome:{applicationId:USER,prospectId:'forged'}}]})} as unknown as Pick<Pool,'query'>;
 await assert.rejects(new PgMhpGrowthService(pool,invalid,mhpWebinarConfig({})).apply(parseMhpApplication(new URLSearchParams(applicationForm)) as never,null),MhpGrowthError);
});
