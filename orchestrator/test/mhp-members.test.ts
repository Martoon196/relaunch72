import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { MhpInvestorService, PgMhpMemberService, authorizeMhpMemberRoute, type MhpMemberAccess } from '../src/mhp/member-service.js';
import { InvestorService, type InvestorBusiness, type InvestorProgramme } from '../src/portal/investor-service.js';
import { investorPage, investorProfile } from '../src/portal/investor-view.js';
import { investorEmailPage } from '../src/portal/investor-email-centre.js';
import type { InvestorMailView } from '../src/portal/investor-mail-service.js';
import { MARTIN_HOWARD_PROPERTY_PROFILE, PROPERTY_PREDATOR_GROWTH_PROFILE, resolvePortalProductProfile } from '../src/portal/product-profile.js';

const ws='71111111-0000-4000-8000-000000000001', user='71111111-0000-4000-8000-000000000002';
const session='x'.repeat(43), identity={sessionToken:session,requestId:'mhp-member-proof'};
const access:MhpMemberAccess={userId:user,workspaceId:ws,isAdmin:false,crm:true,enquirySite:true,emailWorkflow:false,emailWritable:false,leadrelay:false,readOnly:false,endsAt:null};
const business:InvestorBusiness={workspaceId:ws,ownerEmail:'member@example.invalid',ownerName:'Member',brandName:'Maple Property',accentColor:'#E8A33D',signature:'Member',senderEmail:'',accessState:'active',paymentReference:'proof',version:1,productProfileId:'martin_howard_property',features:access};
const programme:InvestorProgramme={isAdmin:false,selectedWorkspaceId:ws,workspaces:[{id:ws,name:'Maple Property',role:'owner'}],businesses:[business]};
const route=(a:MhpMemberAccess,path:string,method='GET')=>authorizeMhpMemberRoute(a,{path,method});

test('course members can work CRM but cannot reach email, provider configuration or AI mounts',()=>{
  for(const path of ['/portal/investors','/portal/crm/contacts','/portal/crm/opportunities','/portal/crm/tasks']) assert.equal(route(access,path).allowed,true,path);
  assert.equal(route(access,'/portal/mhp-crm.js').allowed,true);
  assert.equal(route(access,'/portal/mhp-crm.js','POST').allowed,false);
  assert.equal(route(access,'/portal/crm/leads','POST').allowed,true);
  for(const path of ['/portal/investors/email','/portal/investors/mail/save','/portal/leadrelay','/portal/api/leadrelay/v1/chat','/portal/providers/readiness','/portal/crm/opportunities/'+ws+'/finance']) assert.equal(route(access,path).allowed,false,path);
});
test('mentoring flags allow the existing email and LeadRelay surfaces without opening unrelated modules',()=>{
  const mentoring={...access,emailWorkflow:true,emailWritable:true,leadrelay:true};
  for(const path of ['/portal/investors/email','/portal/investors/mail/callback','/portal/api/leadrelay/v1/chat']) assert.equal(route(mentoring,path).allowed,true,path);
  assert.equal(route(mentoring,'/portal/content').allowed,false);
});
test('refund grace retains saved records while blocking data writes and OAuth/AI GET side effects',()=>{
  const grace={...access,emailWorkflow:true,leadrelay:true,readOnly:true};
  assert.equal(route(grace,'/portal/crm/contacts').allowed,true);
  assert.equal(route(grace,'/portal/investors/email').allowed,true);
  for(const [path,method] of [['/portal/crm/leads','POST'],['/portal/investors/email/sync','POST'],['/portal/investors/mail/callback','GET'],['/portal/leadrelay','GET'],['/portal/investors/branding','POST']]) assert.equal(route(grace,path!,method!).allowed,false,path);
  assert.equal(route(grace,'/app/account/refund','POST').allowed,true);
  assert.equal(route(grace,'/portal/logout','POST').allowed,true);
});
test('kit and expired members keep their account without obtaining a Desk',()=>{
  const kit={...access,crm:false,enquirySite:false};
  assert.equal(route(kit,'/app/account').allowed,true);
  assert.equal(route(kit,'/app/account/portal','POST').allowed,true);
  for(const path of ['/portal/investors','/portal/crm/contacts','/portal/leadrelay']) assert.equal(route(kit,path).allowed,false,path);
});
test('active course preserves CRM writes while refunded mentoring permits only saved email reads',()=>{
  const overlap={...access,emailWorkflow:true};
  assert.equal(route(overlap,'/portal/crm/leads','POST').allowed,true);
  assert.equal(route(overlap,'/portal/investors/branding','POST').allowed,true);
  assert.equal(route(overlap,'/portal/investors/email').allowed,true);
  for(const [path,method] of [['/portal/investors/email/draft','POST'],['/portal/investors/email/send','POST'],['/portal/investors/email/sync','POST'],['/portal/investors/mail/save','POST'],['/portal/investors/mail/connect','POST'],['/portal/investors/mail/callback','GET']]) assert.equal(route(overlap,path!,method!).allowed,false,path);
  const member={...business,features:overlap};
  const connection:InvestorMailView={account:{provider:'smtp',address:business.ownerEmail,status:'verified',version:1,verifiedAt:null,settings:{}},customAvailable:true,googleAvailable:true,microsoftAvailable:true,deliveryEnabled:true};
  const settings=investorPage({programme:{...programme,businesses:[member]},csrf:'csrf',email:business.ownerEmail,view:'settings',mail:connection});
  assert.ok(settings.includes('action="/portal/investors/branding"'));
  assert.ok(!settings.includes('action="/portal/investors/mail/'));
  const conversations=investorEmailPage({business:member,centre:{selected:null,contacts:[],messages:[]},connection,csrf:'csrf'});
  assert.match(conversations,/saved conversations are read-only/);
  assert.ok(!conversations.includes('action="/portal/investors/email/'));
});
test('a card conversation preselects its exact contact point and explains the test-email permission step',()=>{
  const member={...business,features:{...access,emailWorkflow:true,emailWritable:true}};
  const connection:InvestorMailView={account:{provider:'smtp',address:'owner@example.invalid',status:'verified',version:1,verifiedAt:null,settings:{}},customAvailable:true,googleAvailable:false,microsoftAvailable:false,deliveryEnabled:true};
  const point='71111111-0000-4000-8000-000000000010';
  const compose=investorEmailPage({business:member,centre:{selected:null,contacts:[{id:point,name:'Martin Test Investor',address:'owner@example.invalid',verified:true}],messages:[]},connection,csrf:'csrf',selectedPoint:point});
  assert.match(compose,/New message to Martin Test Investor/);
  assert.match(compose,/value="71111111-0000-4000-8000-000000000010" selected/);
  const approved=investorEmailPage({business:member,centre:{selected:{id:'71111111-0000-4000-8000-000000000011',version:2,bodyHash:'a'.repeat(64),reviewHash:'b'.repeat(64),subject:'Test',text:'A test',to:'owner@example.invalid',from:'sender@example.invalid',contactName:'Martin Test Investor',contactPointId:point,lifecycle:'approved',state:'approved',direction:'outbound',internetMessageId:'<test@example.invalid>',permissionRecorded:false},contacts:[],messages:[]},connection,csrf:'csrf'});
  assert.match(approved,/Email request and permission/);
  assert.match(approved,/including my own test address/);
  assert.doesNotMatch(approved,/Send approved email/);
});
test('programme mutations require an administrator even when other features are enabled',()=>{
  assert.equal(route(access,'/portal/investors/create','POST').allowed,false);
  assert.equal(route({...access,isAdmin:true},'/portal/investors/create','POST').allowed,true);
});
test('MHP profile and feature navigation are request-local and preserve the existing PP profile',()=>{
  const p=investorProfile(business);
  assert.equal(p.suiteLabel,'Your Desk'); assert.equal(p.id,'martin_howard_property'); assert.equal(p.theme.nav,'#142019');
  assert.ok(!p.visibleNavigation.includes('inbox')); assert.ok(!p.visibleNavigation.includes('leadrelay'));
  assert.equal(investorProfile({...business,features:{...access,emailWorkflow:true,leadrelay:true}}).visibleNavigation.includes('leadrelay'),true);
  assert.equal(resolvePortalProductProfile('martin_howard_property'),MARTIN_HOWARD_PROPERTY_PROFILE);
  assert.equal(PROPERTY_PREDATOR_GROWTH_PROFILE.productName,'PropertyPredator');
});
test('MHP Conversations menu is clickable only with the business email entitlement',()=>{
  const noEmail=investorPage({programme,csrf:'csrf',email:business.ownerEmail});
  assert.doesNotMatch(noEmail,/class="nav-item" href="\/portal\/investors\/email"/);
  const member={...business,features:{...access,emailWorkflow:true,emailWritable:true}};
  const yesEmail=investorPage({programme:{...programme,businesses:[member]},csrf:'csrf',email:business.ownerEmail});
  assert.match(yesEmail,/class="nav-item" href="\/portal\/investors\/email"/);
  assert.doesNotMatch(yesEmail,/Conversations<\/span><span class="module-state">Setup/);
});
test('MHP dashboard contains the connected mailbox and setup controls',()=>{
  const member={...business,features:{...access,emailWorkflow:true,emailWritable:true}};
  const connection:InvestorMailView={account:{provider:'smtp',address:'martin@propinvestuk.co.uk',status:'verified',version:1,verifiedAt:'2026-10-29T10:00:00Z',settings:{}},customAvailable:true,googleAvailable:false,microsoftAvailable:false,deliveryEnabled:true};
  const html=investorPage({programme:{...programme,businesses:[member]},csrf:'csrf',email:business.ownerEmail,mail:connection});
  assert.match(html,/id="iv-email-setup"/);
  assert.match(html,/Email connected: <strong>martin@propinvestuk\.co\.uk<\/strong>/);
  assert.match(html,/href="\/portal\/investors\/email">Open Conversations<\/a>/);
  assert.match(html,/Manage your email connection/);
  assert.match(html,/action="\/portal\/investors\/mail\/verify"/);
});
test('MHP pages use Your Desk, hide unentitled controls and render the refund read-only state',()=>{
  const html=investorPage({programme,csrf:'csrf',email:business.ownerEmail,view:'settings'});
  assert.match(html,/Your Desk/); assert.ok(!html.includes('Investor Desk')); assert.ok(!html.includes('action="/portal/investors/mail/save"'));
  const grace=investorPage({programme:{...programme,businesses:[{...business,features:{...access,readOnly:true}}]},csrf:'csrf',email:business.ownerEmail,view:'settings'});
  assert.match(grace,/Your Desk is read-only/); assert.ok(!grace.includes('action="/portal/investors/branding"')); assert.ok(!grace.includes('action="/portal/investors/site"'));
});
test('membership lookup hashes the browser token and rejects malformed database authority',async()=>{
  let values:unknown[]=[];
  const pool={query:async(_sql:string,args:unknown[])=>{values=args;return{rows:[{access}]};}} as unknown as Pool;
  assert.equal((await new PgMhpMemberService(pool).snapshot(session)).workspaceId,ws);
  assert.equal((values[0] as Buffer).length,32); assert.notEqual(values[0],session);
  await assert.rejects(()=>new PgMhpMemberService({query:async()=>({rows:[{access:{...access,crm:'true'}}]})} as unknown as Pool).snapshot(session));
});
test('MHP manual activation records a chosen tier without issuing a cross-brand setup token',async()=>{
  const calls:{sql:string;values:unknown[]}[]=[];
  const pool={query:async(sql:string,values:unknown[])=>{calls.push({sql,values});return{rows:[]};}} as unknown as Pool;
  const service=new MhpInvestorService(pool,pool,pool);
  const form={workspaceId:ws,version:'1',state:'active',paymentReference:'checked-offline',entitlementTier:'mentoring',paymentConfirmed:'yes'};
  await assert.rejects(()=>service.access(identity,{...form,paymentConfirmed:'no'})); assert.equal(calls.length,0);
  assert.equal(await service.access(identity,form),null); assert.match(calls[0]!.sql,/set_mhp_investor_access/); assert.equal(calls[0]!.values[5],'mentoring');
});
test('each public host calls its own site lookup and enquiry authority',async()=>{
  const calls:string[]=[];
  const pool={query:async(sql:string)=>{calls.push(sql);return{rows:[{site:null}]};}} as unknown as Pool;
  const mhp=new MhpInvestorService(pool,pool,pool), pp=new InvestorService(pool,pool,pool);
  await mhp.publicSite('member-site'); await pp.publicSite('member-site');
  await mhp.captureSiteEnquiry('member-site','nonce','Someone','person@example.invalid','Please contact me');
  await pp.captureSiteEnquiry('member-site','nonce','Someone','person@example.invalid','Please contact me');
  assert.match(calls[0]!,/public_mhp_investor_site/); assert.match(calls[1]!,/public_investor_site/);
  assert.match(calls[2]!,/capture_mhp_investor_site_enquiry/); assert.match(calls[3]!,/capture_investor_site_enquiry/);
});
