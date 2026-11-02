import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { harness, OWNER, seedBrandSite } from './seo-blog-fixtures.js';
import { CALENDAR_SCRIPT, calendarPage, overviewPage, setupPage, type Shell } from '../src/portal/seo-blog-view.js';
import { suggestedKnowledgeCategory, researchDiagnostic } from '../src/seo-blog/programme.js';
import { KNOWLEDGE_CATEGORY_SCRIPT } from '../src/portal/knowledge-category.js';

async function fixture(confirm=true) {
  const h=harness();seedBrandSite(h.web,'https://harbour.example','deposits');const {brand}=await h.engine.createBrand(OWNER,{commandId:randomUUID(),name:'Harbour',website:'https://harbour.example'});
  await h.engine.updateSettings(OWNER,brand.id,brand.rowVersion,{budgets:{modelTokensPerMonth:2_000_000,searchCallsPerMonth:100,imagesPerMonth:0}});
  const doc=await h.engine.uploadKnowledge(OWNER,brand.id,{category:'brand_guidelines',title:'02_Product_Facts',pastedText:'Harbour Compliance Plan costs £49 per month.'});
  const profile=await h.engine.extractBrandProfile(OWNER,brand.id);if(confirm)await h.engine.confirmProfile(OWNER,brand.id,profile.version);
  return {h,brand,doc,shell:async(tab:Shell['tab']):Promise<Shell>=>({brand:await h.engine.getBrand(OWNER,brand.id),brands:[await h.engine.getBrand(OWNER,brand.id)],tab,csrf:'fixture-csrf',applicationName:'Relaunch72 Content'})};
}
test('programme overview gives an unconfirmed profile a direct action while supplier health remains distinct from configured credentials',async()=>{
  const f=await fixture(false);const shell=await f.shell('overview');
  const brand={...shell.brand!,settings:{...shell.brand!.settings,programme:{researchHold:{logicalRunId:'demo',jobId:'demo',at:f.h.clock.now(),reason:'transient',diagnostic:researchDiagnostic(40101)}}}};
  const html=overviewPage({...shell,brand},{readiness:await f.h.engine.readiness(OWNER,f.brand.id),articles:[],usage:await f.h.engine.usage(OWNER,f.brand.id),jobs:[]});
  assert.match(html,/programme-hero/);assert.match(html,/Your brand profile needs review/);assert.ok(html.includes(`/b/${f.brand.id}/setup#brand-profile`));
  assert.match(html,/Needs attention/);assert.match(html,/Supplier status 40101/);assert.match(html,/Supplier attempts, including failed calls/);
  assert.equal((await f.h.engine.getProfile(OWNER,f.brand.id))!.confirmedAt,null);
});
test('calendar has a real desktop week grid and occupied-day mobile agenda with keyboard proposal moves and no implicit publication schedule',async()=>{
  const f=await fixture();await f.h.engine.requestPlan(OWNER,f.brand.id,{commandId:randomUUID()});await f.h.engine.tick('worker');
  const [plan]=await f.h.engine.listPlans(OWNER,f.brand.id);await f.h.engine.acceptPlan(OWNER,f.brand.id,plan!.plan.id);
  await f.h.engine.requestArticles(OWNER,f.brand.id,[plan!.briefs.find((b)=>b.status==='planned')!.id]);await f.h.engine.tick('worker');
  const articles=await f.h.engine.listArticles(OWNER,f.brand.id);const first=articles[0]!.article;
  await f.h.engine.moveProposedDate(OWNER,f.brand.id,first.id,first.rowVersion,'2026-11-05','09:00');
  const plans=await f.h.engine.listPlans(OWNER,f.brand.id);const html=calendarPage(await f.shell('calendar'),{view:'month',anchor:'2026-11-02',articles:await f.h.engine.listArticles(OWNER,f.brand.id),briefs:plans.flatMap((p)=>p.briefs),destinations:[],brandsAll:false,readiness:await f.h.engine.readiness(OWNER,f.brand.id),jobs:await f.h.engine.listJobs(OWNER,f.brand.id)});
  assert.match(html,/calendar-desktop/);assert.match(html,/calendar-agenda/);assert.match(html,/grid-template-columns:repeat\(7,minmax\(0,1fr\)\)/);
  assert.match(html,/\.calendar-desktop\{display:none\}\.calendar-agenda\{display:block\}/);assert.match(html,/Draft for review · no publication scheduled/);
  assert.match(html,/Move proposed date/);assert.match(html,/name="_csrf" value="fixture-csrf"/);
  const dropForm=html.match(/<form id="dnd-form"[^>]*>([\s\S]*?)<\/form>/)![1]!;
  assert.match(CALENDAR_SCRIPT,/document\.getElementById\('dnd-form'\)/);
  for(const field of ['_csrf','rowVersion','localDate','localTime','destinationId'])assert.ok(dropForm.includes(`name="${field}"`));
  assert.match(dropForm,/name="_csrf" value="fixture-csrf"/);assert.match(CALENDAR_SCRIPT,/form\.submit\(\)/);
  const agenda=html.slice(html.indexOf('<div class="calendar-agenda'));assert.ok((agenda.match(/class="agenda-day"/g)??[]).length<42);
  assert.equal((await f.h.engine.getArticle(OWNER,f.brand.id,first.id)).article.schedule,null);
});
test('guidance kind suggestions are correctable, reclassification retains source versions and does not invoke a model',async()=>{
  const f=await fixture();assert.equal(suggestedKnowledgeCategory('02_Product_Facts.txt'),'product_facts');assert.equal(suggestedKnowledgeCategory('04_Brand_Voice.md'),'voice_samples');
  const count=f.h.llm.calls.length;await f.h.engine.changeKnowledgeCategory(OWNER,f.brand.id,f.doc.id,f.doc.version,'product_facts');
  const docs=await f.h.engine.listKnowledge(OWNER,f.brand.id);assert.equal(docs.length,2);assert.equal(docs[0]!.sha256,docs[1]!.sha256);assert.equal(docs[0]!.text,docs[1]!.text);
  assert.equal(f.h.llm.calls.length,count);
  const html=setupPage(await f.shell('setup'),{documents:docs,profile:await f.h.engine.getProfile(OWNER,f.brand.id),inventory:null,destinations:[],publishers:[],vaultReady:false,usage:await f.h.engine.usage(OWNER,f.brand.id)});
  assert.match(html,/Choose a guidance kind/);assert.match(html,/Save kind/);assert.match(html,/replaced version retained/);assert.match(html,/Active guidance/);
});
test('browser kind hint never overrides an explicit owner choice or reads file bytes',()=>{
  const handlers=new Map<string,()=>void>();const add=(prefix:string)=>(event:string,fn:()=>void)=>handlers.set(prefix+event,fn);
  const title={value:'02_Product_Facts',addEventListener:add('title')};const file={files:[{name:'facts.txt',get arrayBuffer(){throw new Error('file bytes accessed');}}],addEventListener:add('file')};
  const values=['','product_facts','voice_samples'];let selected='';const kind={get value(){return selected;},set value(v:string){selected=v;},get selectedIndex(){return values.indexOf(selected);},options:values.map((text)=>({text})),addEventListener:add('kind')};const hint={textContent:''};
  runInNewContext(KNOWLEDGE_CATEGORY_SCRIPT,{document:{querySelector:()=>({querySelector:(selector:string)=>selector.includes('title')?title:selector.includes('file')?file:selector.includes('category')?kind:hint})}});
  handlers.get('titleinput')!();assert.equal(kind.value,'product_facts');kind.value='voice_samples';handlers.get('kindchange')!();title.value='Product facts';handlers.get('titleinput')!();assert.equal(kind.value,'voice_samples');
});
test('editorial support copy follows the actual connected site instead of assigning PP limits to another brand',async()=>{
  const f=await fixture();const inventory=await f.h.engine.refreshInventory(f.brand.id);
  const destination=await f.h.engine.connectDestination(OWNER,f.brand.id,{type:'github_static',label:'Harbour site',credential:'gh-token-fixture',config:{repository:'acme/site',branch:'main',publicBaseUrl:'https://harbour.example',blogPath:'blog',sitemapPath:'sitemap.xml'}});
  const input={documents:await f.h.engine.listKnowledge(OWNER,f.brand.id),profile:await f.h.engine.getProfile(OWNER,f.brand.id),inventory,publishers:[],vaultReady:false,usage:await f.h.engine.usage(OWNER,f.brand.id)};
  const generic=setupPage(await f.shell('setup'),{...input,destinations:[destination]});assert.doesNotMatch(generic,/Property Predator currently supports/);assert.match(generic,/configured, verified publishing root/);
  const pp=setupPage(await f.shell('setup'),{...input,destinations:[{...destination,publicBaseUrl:'https://propertypredator.com'}]});assert.match(pp,/Property Predator currently supports \/blog only/);
});
