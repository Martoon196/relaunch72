/** Synthetic rendering only. No database, login session or provider connection. */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { investorPage } from '../src/portal/investor-view.js';
import { investorEmailPage } from '../src/portal/investor-email-centre.js';
import { investorSitePage } from '../src/portal/investor-site.js';
import type { InvestorBusiness, InvestorProgramme } from '../src/portal/investor-service.js';
import type { CrmWorkspaceSnapshot } from '../src/portal/crm-views.js';

const id=(n:number)=>`71000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const business:InvestorBusiness={workspaceId:id(1),ownerName:'Martin · preview',ownerEmail:'martin@example.invalid',brandName:'Northstar Property',accentColor:'#4361d8',signature:'Martin\nNorthstar Property',senderEmail:'hello@example.invalid',accessState:'test',version:1,paymentReference:null};
const programme:InvestorProgramme={isAdmin:true,selectedWorkspaceId:id(1),workspaces:[{id:id(1),name:business.brandName,role:'admin'},{id:id(2),name:'Growth HQ',role:'owner'}],businesses:[business]};
const names=['Alex Morgan','Sam Patel','Jamie Ellis','Jordan Clarke'];
const snapshot:CrmWorkspaceSnapshot={workspace:{id:id(1),name:business.brandName,timezone:'Europe/London',snapshotAt:'2026-10-27T12:00:00Z',canWrite:true},
  contacts:names.map((name,i)=>({id:id(10+i),displayName:name,primaryEmail:`preview${i}@example.invalid`,lifecycle:'lead',openOpportunityCount:1,createdAt:'2026-10-21T10:00:00Z'})),
  stages:['New enquiry','Contacted','Call booked','Qualified','Opportunity shared','Follow-up','Completed','Not proceeding'].map((name,i)=>({id:id(30+i),name,position:i,isClosed:i>5})),
  opportunities:names.map((name,i)=>({id:id(50+i),contactId:id(10+i),contactName:name,title:['Manchester buy-to-let','First investment conversation','Liverpool portfolio search','Birmingham opportunity review'][i]!,stageId:id(30+i),valueMinor:null,updatedAt:'2026-10-26T10:00:00Z',rowVersion:1,moveCommandKey:id(70+i)})),
  tasks:names.slice(0,3).map((name,i)=>({id:id(80+i),title:['Confirm investment requirements','Prepare for the discovery call','Follow up on the appraisal'][i]!,status:'open',contactName:name,dueAt:['2026-10-26T09:00:00Z','2026-10-27T15:00:00Z','2026-10-29T10:00:00Z'][i]!,rowVersion:1,completeCommandKey:id(90+i)})),timeline:[]};
const output=new URL('../../docs/investor-preview/',import.meta.url);
await mkdir(output,{recursive:true});
function render(path:string) {
  const admin=path.includes('admin');
  const empty=path.includes('empty');
  const p=admin?{...programme,selectedWorkspaceId:id(2)}:programme;
  const mail={account:{provider:'smtp' as const,address:'hello@example.invalid',status:'verified' as const,version:1,verifiedAt:'2026-10-27T12:00:00Z',settings:{}},customAvailable:true,googleAvailable:true,microsoftAvailable:true,deliveryEnabled:false};
  if(path.includes('email'))return investorEmailPage({business,csrf:'preview-only',connection:mail,centre:{contacts:[{id:id(10),name:'Alex Morgan',address:'alex@example.invalid',verified:true}],selected:{id:id(100),version:1,bodyHash:'a'.repeat(64),reviewHash:'b'.repeat(64),subject:'A clear next step for your Manchester search',text:'Hi Alex,\n\nThanks for sharing what you are looking for. Before I put anything in front of you, I would like to understand the locations, budget and timing that matter most.\n\nWould a short conversation on Thursday work for you?\n\nMartin\nNorthstar Property',to:'alex@example.invalid',from:'hello@example.invalid',contactName:'Alex Morgan',contactPointId:id(10),lifecycle:'draft',state:'draft',direction:'outbound',internetMessageId:'<test@example.invalid>',permissionRecorded:true},messages:names.map((name,i)=>({id:id(100+i),contactName:name,to:`preview${i}@example.invalid`,subject:['A clear next step for your Manchester search','Thank you for your time today','Your Liverpool search','A quick check-in'][i]!,preview:['Thanks for sharing what you are looking for.','Really useful conversation. Here is what I took away.','We can make a start with your preferred areas.','How are your plans taking shape?'][i]!,direction:i===2?'inbound':'outbound',state:['draft','accepted','received','approved'][i]!,createdAt:'2026-10-27T12:00:00Z'}))}});
  if(path.includes('site'))return investorSitePage({slug:'northstar',brandName:business.brandName,accentColor:business.accentColor,headline:'Your next property investment starts with a conversation.',introduction:'Tell us where you want to go. We will take the time to understand your goals, explore the possibilities and agree a clear next step together.',locations:'Manchester · Liverpool · Birmingham',contactEmail:'hello@example.invalid',privacyUrl:'https://example.invalid/privacy'},'',true);
  const html=investorPage({programme:p,csrf:'preview-only',email:business.ownerEmail,crm:empty?{...snapshot,contacts:[],opportunities:[],tasks:[]}:snapshot,message:'Design preview · fictional investor records · no messages are sent.',view:path.includes('settings')?'settings':path.includes('playbook')?'playbook':undefined,mail});
  return html;
}
const browser=await chromium.launch({executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
const results=[];
try {
  for(const [name,width,height,path] of [['desktop',1440,1100,'/'],['mobile',390,844,'/'],['empty',1440,1100,'/empty'],['admin',1440,1100,'/admin'],['email',1440,1100,'/email'],['email-mobile',390,844,'/email'],['settings',1440,1100,'/settings'],['settings-mobile',390,844,'/settings'],['playbook',1440,1100,'/playbook'],['site',1440,1100,'/site'],['site-mobile',390,844,'/site']] as const){
    const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.setContent(render(path));
    await page.screenshot({path:fileURLToPath(new URL(`${name}.png`,output)),fullPage:false});
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
    results.push({name,width,height,overflow,errors,heading:await page.locator('h1').innerText()});
    if(overflow||errors.length)throw new Error(`${name}: layout or runtime failure`);
    await page.close();
  }
  await writeFile(new URL('checks.json',output),JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify(results));
} finally {await browser.close();}
