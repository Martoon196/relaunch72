import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {appShell, PORTAL_APPEARANCE_CLIENT_SOURCE} from '../src/portal/ui.ts';
import {PROPERTY_PREDATOR_GROWTH_PROFILE} from '../src/portal/product-profile.ts';
import {createPropertyPredatorContentCalendarFixture, PROPERTY_PREDATOR_CONTENT_CALENDAR_AS_OF} from '../src/portal/content-calendar-fixtures.ts';
import {presentContentCalendar} from '../src/portal/content-calendar-presenter.ts';
import {renderContentCalendarBody} from '../src/portal/content-calendar-view.ts';
import {CAMPAIGN_WIZARD_CREATE_TEST_ROUTE} from '../src/portal/campaign-wizard-actions.ts';
const fixture=createPropertyPredatorContentCalendarFixture();
const item={...fixture.catalog.items[0],kind:'social_post'};
const target='96000000-0000-4000-8000-000000000001';
const view=presentContentCalendar({...fixture,slots:[],catalog:{items:[item],nextCursor:null}}, {
  workspaceName:'Property Predator',timezone:'Europe/London',asOf:PROPERTY_PREDATOR_CONTENT_CALENDAR_AS_OF,
});
const html=appShell({title:'Calendar preview',tenantName:'Property Predator',active:'content',
  productProfile:PROPERTY_PREDATOR_GROWTH_PROFILE,body:renderContentCalendarBody(view,{
    selectedContentVersionId:item.contentVersionId,
    liveSchedules:{status:'ready',configuredNetworks:['linkedin'],items:[]},
    postPlan:{actionUrl:CAMPAIGN_WIZARD_CREATE_TEST_ROUTE,csrfToken:'preview-csrf-token-012',commandKey:'preview-plan-012',
      contentVersions:[{value:item.contentVersionId,label:item.title}],targets:[{value:target,label:'LinkedIn · Property Predator'}]},
  })});
let posts=[];
const server=createServer(async(req,res)=>{
  if(req.method==='POST'){
    assert.equal(req.url,CAMPAIGN_WIZARD_CREATE_TEST_ROUTE);
    const chunks=[];for await(const chunk of req) chunks.push(chunk);
    posts.push(new URLSearchParams(Buffer.concat(chunks).toString()));
    res.setHeader('content-type','text/html');res.end('<h1>Local plan received</h1><p>Fixture only. Nothing published.</p>');return;
  }
  if(req.url==='/portal/appearance.js'){res.setHeader('content-type','text/javascript');res.end(PORTAL_APPEARANCE_CLIENT_SOURCE);return;}
  if(req.url?.endsWith('.js')){res.setHeader('content-type','text/javascript');res.end('');return;}
  res.setHeader('content-type','text/html');res.end(html);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/portal/content/calendar`;
const browser=await chromium.launch({channel:'msedge',headless:true});
let checks=0;
try{
  for(const width of [1366,390]) for(const theme of ['light','dark']){
    const context=await browser.newContext({viewport:{width,height:950}});
    await context.addInitScript(theme=>localStorage.setItem('property-predator-appearance',theme),theme);
    const page=await context.newPage();await page.route('https://**/*',route=>route.abort());
    await page.goto(url,{waitUntil:'domcontentloaded'});
    const text=await page.locator('main').innerText();
    assert.doesNotMatch(text,/immutable|simulation|\bTEST\b|worker|exact hash|gate locked/i);
    assert.equal(await page.locator('#new-plan').count(),1);
    assert.equal(await page.locator('[data-calendar-post-plan] [name="content_version_id"]').inputValue(),item.contentVersionId);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    const button=page.getByRole('button',{name:'Save plan',exact:true});
    await button.click();assert.equal(posts.length,checks,'empty account/time must not submit');
    await page.getByLabel('Where should it appear?').selectOption(target);
    await page.getByLabel('Date and time').fill('2026-09-18T14:30');
    await page.getByLabel('Save this plan only. I will confirm publishing on the next step.').check();
    await page.screenshot({path:`../../../overnight-build-2026-09-07/_verification/calendar-012-${width}-${theme}.png`,fullPage:true});
    await button.click();await page.waitForURL(url=>url.pathname===CAMPAIGN_WIZARD_CREATE_TEST_ROUTE);
    checks++;assert.equal(posts.length,checks);
    assert.equal(posts.at(-1).get('content_version_id'),item.contentVersionId);
    assert.equal(posts.at(-1).get('target_ids'),target);
    assert.equal(posts.at(-1).get('environment'),'test');
    assert.equal(posts.at(-1).get('confirm_test_only'),'confirmed');
    assert.equal(posts.at(-1).get('desired_for_local'),'2026-09-18T14:30');
    console.log(`${width}/${theme}: readable, no jargon, native required fields, selected exact version, one fixture plan submit`);
    await context.close();
  }
  console.log(`${checks} browser checks passed; 0 live mutations`);
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
