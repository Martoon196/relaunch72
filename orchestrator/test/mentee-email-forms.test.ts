import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { investorPage } from '../src/portal/investor-view.js';
import { investorProfile } from '../src/portal/investor-view.js';
import { appShell } from '../src/portal/ui.js';
import { RELAUNCH72_PRODUCT_PROFILE } from '../src/portal/product-profile.js';
import { learnHomePage } from '../src/mhp/learning-view.js';
import { accountPage } from '../src/mhp/account-view.js';
import { mhpMemberNavigationLinks } from '../src/mhp/member-navigation.js';
import { investorEmailPage } from '../src/portal/investor-email-centre.js';
import { investorEmbedCode, handleInvestorPublicSite, type InvestorSiteSettings } from '../src/portal/investor-site.js';
import { INVESTOR_CLIENT_SOURCE } from '../src/portal/investor-client.js';
import type { InvestorBusiness, InvestorProgramme, InvestorService } from '../src/portal/investor-service.js';
import type { InvestorMailService, InvestorMailView } from '../src/portal/investor-mail-service.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { MARTIN_HOWARD_PROPERTY_PROFILE } from '../src/portal/product-profile.js';
import { Readable } from 'node:stream';

const origin='https://app.martinhowardproperty.co.uk';
const feature={crm:true,enquirySite:true,emailWorkflow:true,emailWritable:true,leadrelay:false,readOnly:false,endsAt:null};
const businesses:InvestorBusiness[]=['maple','harbour'].map((name,i)=>({workspaceId:`71111111-0000-4000-8000-00000000000${i+1}`,ownerName:'Synthetic owner',ownerEmail:`${name}@example.invalid`,brandName:name==='maple'?'Maple Property':'Harbour Homes',accentColor:'#E8A33D',signature:'',senderEmail:`${name}@example.invalid`,accessState:'active',paymentReference:null,version:1,productProfileId:'martin_howard_property',features:feature}));
const sites:InvestorSiteSettings[]=['maple','harbour'].map(slug=>({slug,headline:'Our plans',introduction:'',locations:'',contact_email:`${slug}@example.invalid`,privacy_url:`https://${slug}.example.invalid/privacy`,requested_domain:'',published:true,row_version:1}));
const programme=(i=0):InvestorProgramme=>({isAdmin:false,selectedWorkspaceId:businesses[i]!.workspaceId,businesses,workspaces:businesses.map(b=>({id:b.workspaceId,name:b.brandName,role:'owner'}))});
const connection:InvestorMailView={account:null,customAvailable:true,googleAvailable:true,microsoftAvailable:true,deliveryEnabled:true};
const page=(extra:Partial<Parameters<typeof investorPage>[0]>={})=>investorPage({programme:programme(),csrf:'synthetic-csrf',email:businesses[0]!.ownerEmail,site:sites[0],siteOrigin:origin,mail:connection,...extra});

test('orange dashboard/nav email CTA opens actual settings controls and retains truthful mailbox status',()=>{
 const html=page();assert.match(html,/class="button iv-email-cta" href="\/portal\/investors\?view=settings#iv-email-connection">Set up email/u);
 assert.match(html,/background:#e8a33d;color:#142019/u);assert.match(html,/iv-email-cta:focus-visible/u);
 const settings=page({view:'settings'});assert.match(settings,/id="iv-email-connection"/u);
 for(const provider of ['google','microsoft'])assert.match(settings,new RegExp(`name="provider" value="${provider}"`));
 assert.match(settings,/Custom email · SMTP \+ IMAP/u);assert.match(settings,/name="_csrf" value="synthetic-csrf"/u);
 assert.match(settings,/reads recent Inbox messages to find replies matching known investors/u);
 assert.match(settings,/Saved mailbox credentials and tokens are encrypted/u);
 assert.match(settings,/Connection managers can use Disconnect/u);
 const linked=page({mail:{...connection,account:{provider:'smtp',address:'connected@example.invalid',status:'verified',version:2,verifiedAt:'2026-11-01',settings:{}}}});
 assert.match(linked,/Email connected: <strong>connected@example.invalid<\/strong>/u);assert.match(linked,/>Manage email connection<\/a>/u);
});

test('course users see Forms without email entitlement; read-only and non-managers never get mailbox writes',()=>{
 const limited={...businesses[0]!,features:{...feature,emailWorkflow:false,emailWritable:false}};
 const html=page({programme:{...programme(),businesses:[limited]}});
 assert.match(html,/href="\/portal\/investors\?view=forms">Forms/u);assert.match(html,/Open Forms/u);assert.doesNotMatch(html,/iv-email-cta" href/u);
 const readOnly=page({view:'settings',programme:{...programme(),businesses:[{...businesses[0]!,features:{...feature,readOnly:true}}]}});
 assert.doesNotMatch(readOnly,/action="\/portal\/investors\/mail\//u);
 const viewer=page({view:'settings',programme:{...programme(),workspaces:programme().workspaces.map(w=>({...w,role:'viewer'}))}});
 assert.doesNotMatch(viewer,/action="\/portal\/investors\/mail\//u);
});

test('Forms uses selected business, resource title and trusted installation origin; code is copyable without sending',()=>{
 for(let i=0;i<2;i++) {
  const html=page({view:'forms',programme:programme(i),site:sites[i],offer:'BRR & "next" guide'});
  assert.match(html,new RegExp(`${businesses[i]!.brandName} · FORMS`));
  assert.match(html,new RegExp(`/investor-sites/${sites[i]!.slug}/embed\\?offer=BRR`));
  assert.doesNotMatch(html,new RegExp(`/investor-sites/${sites[1-i]!.slug}/embed`));
  assert.match(html,/method="get" action="\/portal\/investors"/u);assert.match(html,/name="view" value="forms"/u);
  assert.match(html,/id="iv-form-code" readonly/u);assert.match(html,/data-copy-template="iv-form-code"/u);
  assert.match(html,/not separate marketing consent/u);assert.doesNotMatch(html,/<script(?! src=)/u);
 }
 const own=investorEmbedCode(sites[0]!,'https://another-brand.example.invalid/path','A <script>bad</script> resource');
 assert.ok(own);assert.match(own.url,/^https:\/\/another-brand.example.invalid\/investor-sites\/maple\/embed/u);
 assert.doesNotMatch(own.snippet,/<script>|app\.martinhowardproperty/u);assert.match(own.snippet,/&lt;script&gt;/u);
});

test('unpublished, missing privacy, read-only and unentitled forms keep setup and public-capture gates',()=>{
 for(const site of [{...sites[0]!,published:false},{...sites[0]!,privacy_url:''}]) {
  assert.equal(investorEmbedCode(site,origin,'Guide'),null);
  const html=page({view:'forms',site});assert.doesNotMatch(html,/id="iv-form-code"/u);assert.match(html,/view=settings#iv-site-setup/u);
 }
 assert.equal(investorEmbedCode(sites[0]!,'javascript:alert(1)','Guide'),null);
 assert.equal(investorEmbedCode(sites[0]!,origin,'x'.repeat(101)),null);
 const grace=page({view:'forms',programme:{...programme(),businesses:[{...businesses[0]!,features:{...feature,readOnly:true}}]}});
 assert.match(grace,/public form cannot receive new requests/u);assert.doesNotMatch(grace,/id="iv-form-code"/u);
 const none=page({view:'forms',programme:{...programme(),businesses:[{...businesses[0]!,features:{...feature,enquirySite:false}}]}});
 assert.match(none,/Forms unavailable/u);assert.doesNotMatch(none,/id="iv-form-code"/u);
});

test('copy code succeeds, preserves existing template feedback and selects text when clipboard is denied',async()=>{
 for(const denied of [false,true]) {
  let handler:(event:unknown)=>Promise<void>=async()=>{},copied='',focused=false,selected=false;
  const status={textContent:''};class Element{closest(){return button;}}
  class HTMLButtonElement extends Element{dataset:Record<string,string>={copyTemplate:'iv-form-code',copySuccess:'Code copied.'};parentElement={querySelector:()=>status};}
  class HTMLTextAreaElement{value='<iframe>Exact copy</iframe>';focus(){focused=true;}select(){selected=true;}}
  const button=new HTMLButtonElement(),field=new HTMLTextAreaElement();
  runInNewContext(INVESTOR_CLIENT_SOURCE,{Element,HTMLButtonElement,HTMLTextAreaElement,document:{addEventListener:(_name:string,fn:typeof handler)=>{handler=fn;},getElementById:()=>field},navigator:{clipboard:{writeText:async(value:string)=>{if(denied)throw Error('denied');copied=value;}}}});
  await handler({target:button});
  if(denied){assert.equal(focused,true);assert.equal(selected,true);assert.match(status.textContent,/device’s Copy command/u);}
  else{assert.equal(copied,field.value);assert.equal(status.textContent,'Code copied.');delete button.dataset.copySuccess;await handler({target:button});assert.equal(status.textContent,'Copied. Review it before sending.');}
 }
});

export function menteeSetupRouterFixture(admin=false) {
 let selected=0;const loaded:string[]=[];const token='a'.repeat(43);
 const investors={snapshot:async()=>({...programme(selected),isAdmin:admin}),site:async()=>{loaded.push(businesses[selected]!.workspaceId);return sites[selected];},requirementSummaries:async()=>({})} as unknown as InvestorService;
 const deps:PostgresPortalDeps={kind:'postgres',secure:true,sessionSecret:'synthetic-secret',portalBaseUrl:origin,productProfile:MARTIN_HOWARD_PROPERTY_PROFILE,investors,
  investorMail:{snapshot:async()=>connection,centre:async()=>({selected:null,contacts:[],messages:[]})} as unknown as InvestorMailService,
  auth:{resolve:async()=>({sessionToken:token,userId:businesses[selected]!.workspaceId,workspaceId:businesses[selected]!.workspaceId,userEmail:businesses[selected]!.ownerEmail}),login:async()=>null,revoke:async()=>{}},
  crm:{snapshot:async()=>({workspace:{id:businesses[selected]!.workspaceId,name:businesses[selected]!.brandName,timezone:'Europe/London',snapshotAt:'2026-11-01T00:00:00Z',canWrite:true},contacts:[],stages:[],opportunities:[],tasks:[],timeline:[]})} as never};
 async function request(url:string){const output={status:0,html:'',headers:{} as Record<string,unknown>};const req=new EventEmitter() as IncomingMessage;req.method='GET';req.url=url;req.headers={cookie:`r72_portal=${token}`};const res={writeHead:(status:number,headers:Record<string,unknown>)=>{output.status=status;output.headers=headers;},end:(html='')=>{output.html=html;}} as unknown as ServerResponse;await handlePortal(req,res,deps);return output;}
 return{request,loaded,switchBusiness:(index:number)=>{selected=index;}};
}

test('native Forms GET loads selected site, ignores browser workspace guesses and bounds resource labels',async()=>{
 const f=menteeSetupRouterFixture();const first=await f.request('/portal/investors?view=forms&offer=BRR%20guide&workspaceId=forged');
 assert.equal(first.status,200);assert.match(first.html,/\/investor-sites\/maple\/embed\?offer=BRR\+guide/u);
 f.switchBusiness(1);const second=await f.request('/portal/investors?view=forms&offer=Harbour%20guide');
 assert.equal(second.status,200);assert.match(second.html,/\/investor-sites\/harbour\/embed/u);assert.doesNotMatch(second.html,/\/investor-sites\/maple\/embed/u);
 assert.deepEqual(f.loaded,businesses.map(b=>b.workspaceId));
 assert.equal((await f.request('/portal/investors?view=forms&offer='+encodeURIComponent('x'.repeat(101)))).status,400);
});

test('two existing public forms keep independent branding, slug-bound token and consented CRM source',async()=>{
 const captures:{slug:string;message:string}[]=[];const publicSites=sites.map((s,i)=>({...s,brandName:businesses[i]!.brandName,accentColor:'#E8A33D',contactEmail:s.contact_email,privacyUrl:s.privacy_url}));
 const service={publicSite:async(slug:string)=>publicSites.find(s=>s.slug===slug)??null,captureSiteEnquiry:async(slug:string,_token:string,_name:string,_email:string,message:string)=>{captures.push({slug,message});}} as unknown as InvestorService;
 const run=async(method:string,url:string,body='')=>{const result={status:0,html:''};const req=Object.assign(Readable.from([Buffer.from(body)]),{method,url,headers:{'content-type':'application/x-www-form-urlencoded'}}) as unknown as IncomingMessage;const res={writeHead:(status:number)=>{result.status=status;},end:(html='')=>{result.html=html;}} as unknown as ServerResponse;await handleInvestorPublicSite(req,res,service,'synthetic-form-secret-at-least32');return result;};
 let token='';for(const s of publicSites){const url=`/investor-sites/${s.slug}/embed?offer=BRR%20guide`;const response=await run('GET',url);assert.equal(response.status,200);assert.match(response.html,new RegExp(s.brandName));token=/name="token" value="([^"]+)"/u.exec(response.html)![1]!;assert.equal((await run('POST',url,new URLSearchParams({token,name:'Synthetic investor',email:'owned@example.invalid',contactRequest:'yes'}).toString())).status,200);}
 assert.deepEqual(captures,[{slug:'maple',message:'Requested lead magnet: BRR guide'},{slug:'harbour',message:'Requested lead magnet: BRR guide'}]);
 assert.equal((await run('POST','/investor-sites/maple/embed?offer=BRR',new URLSearchParams({token,name:'Synthetic',email:'owned@example.invalid',contactRequest:'yes'}).toString())).status,400);
 assert.equal(captures.length,2);
});

test('shared MHP member navigation is reciprocal, visible in CRM and absent from other brands/marketing context',()=>{
 const member=page();const learning=learnHomePage({tier:'full',isAdmin:false,modules:[],progress:{}},'csrf');
 for(const html of [member,learning])for(const href of ['/app/learn','/app/desk','/portal/investors','/app/account'])assert.ok(html.includes(`href="${href}"`),href);
 assert.match(member,/class="mhp-member-nav" aria-label="Member navigation"/u);
 assert.doesNotMatch(mhpMemberNavigationLinks(),/href="\/hq"/u);assert.doesNotMatch(member,/group-hq/u);
 const shell=(productProfile:Parameters<typeof appShell>[0]['productProfile'])=>appShell({title:'Synthetic',tenantName:'Synthetic',active:'crm',body:'Body',productProfile});
 assert.doesNotMatch(shell(RELAUNCH72_PRODUCT_PROFILE),/mhp-member-nav" aria-label/u);
 assert.doesNotMatch(shell({...MARTIN_HOWARD_PROPERTY_PROFILE,marketingWorkspace:true}),/mhp-member-nav" aria-label/u);
 assert.match(shell(investorProfile(businesses[0]!,true)),/href="\/hq">HQ/u);
 assert.doesNotMatch(shell(investorProfile(businesses[0]!)),/href="\/hq">HQ/u);
 for(const programmeAdmin of [undefined,false,true]) {
  const mail=investorEmailPage({business:businesses[0]!,centre:{selected:null,contacts:[],messages:[]},connection,csrf:'csrf',programmeAdmin});
  assert.equal(mail.includes('href="/hq">HQ'),programmeAdmin===true);
 }
});

test('account navigation keeps actual Desk/CRM gates and default-denies HQ',()=>{
 const snapshot={purchases:[],access:{...feature,crm:false,enquirySite:false,emailWorkflow:false,leadrelay:false}};
 const limited=accountPage({snapshot,csrf:'csrf',billingEnabled:false});
 for(const href of ['/app/desk','/portal/investors','/hq'])assert.ok(!limited.includes(`href="${href}"`));
 const owner=accountPage({snapshot:{...snapshot,access:{...snapshot.access,crm:true}},csrf:'csrf',billingEnabled:false,deskAccess:true,ownerAccess:true});
 for(const href of ['/app/learn','/app/desk','/portal/investors','/app/account','/hq'])assert.ok(owner.includes(`href="${href}"`));
});

test('actual selected MHP contacts/pipeline/conversations shells all provide a route back to training',async()=>{
 for(const admin of [false,true]) {
  const f=menteeSetupRouterFixture(admin);
  for(const path of ['/portal/crm/contacts','/portal/crm/opportunities','/portal/investors/email']) {
   const page=await f.request(path);assert.equal(page.status,200,path);
   assert.match(page.html,/class="mhp-member-nav" aria-label="Member navigation"/u,path);
   for(const href of ['/app/learn','/app/desk','/portal/investors','/app/account'])assert.ok(page.html.includes(`href="${href}"`),`${path}:${href}`);
   if(!admin)assert.ok(!page.html.includes('href="/hq">HQ'));
   else assert.ok(page.html.includes('href="/hq">HQ'));
  }
 }
});
