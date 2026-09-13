// Offline rendering only: no accounts, database, model requests or social posts.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { appShell } from '../src/portal/ui.ts';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.ts';
import { createPropertyPredatorBrandBrainFixture } from '../src/portal/brand-brain-fixtures.ts';
import { planPropertyPredatorMarketingDraft } from '../src/company-content-adapter/property-predator-marketing-draft-plan.ts';
import { presentCampaignWizard } from '../src/portal/campaign-wizard-presenter.ts';
import { renderCampaignWizardBody } from '../src/portal/campaign-wizard-view.ts';
import { CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE } from '../src/portal/campaign-wizard-actions.ts';

const fixture = createPropertyPredatorBrandBrainFixture();
const brain = { ...fixture, workspace: { ...fixture.workspace, canManage: true }, brain: {
  ...fixture.brain, activated: true, sourceFresh: true, evaluationPassed: true, visualPolicyConflict: false,
  reviews: [...fixture.brain.reviews, { dimension:'brand_readiness', decision:'approved', decisionId:'b3000000-0000-4000-8000-000000000003' }],
  specialists: fixture.brain.specialists.map(p => p.profileId === 'propertypredator.owned.social/v1'
    ? {...p, capabilities:['post','thread'], runtimeReady:true, blockedReason:null} : p),
} };
const draftPlan = planPropertyPredatorMarketingDraft({selection:'property-predator-agency-laps:appointment', brandBrainSnapshot:brain});
const view = presentCampaignWizard({content:[{
  contentItemId:'11111111-1111-4111-8111-111111111111', contentVersionId:'22222222-2222-4222-8222-222222222222',
  contentSha256:'a'.repeat(64), title:'The appraisal should work for you. Not the other way around.',
  versionNumber:2, kindLabel:'Social post', approvalStatus:'approved', sourceFresh:false, publishable:false,
}],media:[],targets:[],sourceTruncated:false}, {workspaceName:'Property Predator',timezone:'Europe/London',asOf:new Date().toISOString(),draftPlan});
const html = appShell({title:'Create your post',tenantName:'Property Predator',active:'content',productProfile:PROPERTY_PREDATOR_GROWTH_PROFILE,
  body:renderCampaignWizardBody(view, {draftGenerationAction:{actionUrl:CAMPAIGN_WIZARD_GENERATE_REVIEW_DRAFT_ROUTE,
    csrfToken:'offline-preview-csrf-token',commandKey:'offline-preview-command',maximumCostMinor:100,
    mediaUploadUrl:'/portal/content/calendar/media-uploads',mediaCommandKey:'offline-preview-media'},
    outcome:{kind:'error',title:'Your plan could not be saved',detail:'Planning access needs checking. Your post, picture and approval are unchanged. Nothing has been scheduled. You do not need to create your post again.'}})});
const browser = await chromium.launch({channel:'msedge',headless:true});
try {
  for (const width of [1366,390]) for (const theme of ['light','dark','system']) {
    const context = await browser.newContext({viewport:{width,height:950},colorScheme:'light'});
    const page = await context.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent(html);
    await page.evaluate(t => document.documentElement.dataset.theme=t, theme);
    assert.equal(await page.locator('textarea[name="topic"]').count(),1);
    assert.equal(await page.locator('input[name="platform"]:checked').count(),1);
    const result = await page.evaluate(() => {
      function luminance(rgb) {
        return rgb.slice(0,3).map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4)
          .reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
      }
      const selectors=['.cwiz-outcome p','.cwiz-generate-option span','.cwiz-pack-drop span','.cwiz-saved p','.cwiz-generate-submit'];
      const readings=selectors.flatMap(s=>[...document.querySelectorAll(s)].map(n=>{
        const style=getComputedStyle(n); let ancestor=n; let bg;
        do { bg=getComputedStyle(ancestor).backgroundColor; ancestor=ancestor.parentElement; }
        while (bg==='rgba(0, 0, 0, 0)' && ancestor);
        const a=luminance(style.color.match(/[\d.]+/g).map(Number));
        const b=luminance(bg.match(/[\d.]+/g).map(Number));
        return {selector:s,font:parseFloat(style.fontSize),contrast:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)};
      }));
      return {readings,overflow:document.documentElement.scrollWidth>innerWidth+1};
    });
    assert.ok(result.readings.length>=8);
    assert.equal(result.overflow,false,JSON.stringify({width,theme,result}));
    for(const r of result.readings) {assert.ok(r.font>=16,JSON.stringify(r));assert.ok(r.contrast>=4.5,JSON.stringify({theme,...r}));}
    await page.screenshot({path:`../../../overnight-build-2026-09-07/_verification/post-flow-015-${width}-${theme}.png`,fullPage:true});
    console.log(JSON.stringify({width,theme,...result}));
    await context.close();
  }
  console.log('Offline visual checks: 6 pass / 0 fail / 0 skip');
} finally {await browser.close();}
