/** Isolated browser fixture. Every request is intercepted; no real provider or post. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { renderPortalCompanyContentReviewBody } from '../src/portal/company-content-review-view.js';
import { SOCIAL_IMAGE_CLIENT_SOURCE } from '../src/portal/social-image-client.js';
import { socialImageFromDataUrl } from '../src/company-content-pg/social-image.js';
import type { CompanyContentExactReview } from '../src/company-content-pg/types.js';
import { COMPANY_CONTENT_SOCIAL_DRAFT_SCHEMA } from '../src/company-content-pg/types.js';
const browser = await chromium.launch({channel:'msedge',headless:true});
const context = await browser.newContext({viewport:{width:1100,height:1000}});
context.setDefaultTimeout(10_000);
const page = await context.newPage();
page.on('pageerror', error => console.log('fixture page error:',error.message));
page.on('console',message=>{if(message.type()==='error')console.log('fixture console:',message.text());});
const jpeg = await page.evaluate(() => {
  const c=document.createElement('canvas'); c.width=800;c.height=600;
  const ctx=c.getContext('2d')!;ctx.fillStyle='#06232d';ctx.fillRect(0,0,800,600);
  ctx.fillStyle='#00e5cc';ctx.font='32px sans-serif';ctx.fillText('LOCAL TEST IMAGE — NOT FOR POSTING',45,300);
  return c.toDataURL('image/jpeg',0.9);
});
const pp = await readFile(new URL('../../../astra-pp-login-009-20260911/frontend/image-maker.html',import.meta.url),'utf8');
const ppScript = await readFile(new URL('../../../astra-pp-login-009-20260911/frontend/image-maker.js',import.meta.url),'utf8');
let image: ReturnType<typeof socialImageFromDataUrl> | undefined;
let saves=0, generated=0;
const item='11111111-1111-4111-8111-111111111111',version='22222222-2222-4222-8222-222222222222';
function render() {
  const review:CompanyContentExactReview={contentItemId:item,contentVersionId:version,versionNumber:2,
    isLatest:true,origin:'edited',kind:'social_post',title:'Local image integration check',contentMimeType:'application/json',
    canonicalContent:'LOCAL FIXTURE',canonicalByteLength:13,contentSha256:'a'.repeat(64),blobSha256:'b'.repeat(64),
    brandSha256:'c'.repeat(64),source:{system:'property_predator_generation',itemId:'fixture',version:'v2'},
    approvalRequestId:null,approvalDecisionId:null,approvalStatus:'unrequested',approvalStale:false,email:null,
    createdAt:'2026-09-11T12:00:00Z',social:{schema:COMPANY_CONTENT_SOCIAL_DRAFT_SCHEMA,type:'generated',kind:'post',
      title:'Fixture',platform:'LinkedIn',publicationCopy:'LOCAL FIXTURE. This is not a marketing post.',
      artworkInstructions:'Abstract test image',ctaUrl:null,contextSha256:null,legacyCombined:false,
      publicationCopySha256:'a'.repeat(64),artworkInstructionsSha256:'b'.repeat(64),image}};
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui,sans-serif;background:#07090b;margin:0;padding:12px}button,input{font:inherit}</style></head><body>'
    +renderPortalCompanyContentReviewBody({workspace:{workspaceId:item,workspaceName:'Local fixture',
      snapshotAt:review.createdAt,canWrite:true,canManage:true},review},{security:{csrfToken:'fixture_csrf_00000000001',
      requestCommandKey:'fixture-request-01',revisionCommandKey:'fixture-revision-01',exactRevisionToken:'fixture_revision_token_00000000001'}})+'</body></html>';
}
await context.addInitScript(() => {
  if(location.hostname==='propertypredator.com')localStorage.setItem('pp_refresh','LOCAL_TEST_SESSION');
});
await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.hostname==='propertypredator.com') {
    if(url.pathname==='/image-maker.html')return route.fulfill({contentType:'text/html',body:pp,headers:{
      'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src blob:; frame-ancestors https://hq.propertypredator.com"}});
    if(url.pathname==='/image-maker.js')return route.fulfill({contentType:'text/javascript',body:ppScript});
    if(url.pathname==='/api/auth/refresh')return route.fulfill({json:{access_token:'LOCAL_TEST_ONLY',refresh_token:'LOCAL_TEST_SESSION'}});
    if(url.pathname==='/api/admin/me')return route.fulfill({json:{email:'fixture@example.invalid'}});
    if(url.pathname==='/api/admin/generate-image'){generated++;return route.fulfill({json:{ok:true,image:jpeg,model:'LOCAL_FIXTURE'}});}
    return route.fulfill({status:404,body:'No external request in this fixture'});
  }
  if(url.hostname!=='hq.propertypredator.com')return route.abort();
  if(url.pathname.endsWith('/social-image.js'))return route.fulfill({contentType:'text/javascript',body:SOCIAL_IMAGE_CLIENT_SOURCE});
  if(url.pathname.endsWith('/image')&&image)return route.fulfill({contentType:'image/jpeg',body:Buffer.from(image.base64,'base64')});
  if(request.method()==='POST'){
    const form=new URLSearchParams(request.postData()!);
    image=socialImageFromDataUrl(form.get('image_data_url')!,form.get('image_alt')!);saves++;
    // Fulfil the saved page directly: Playwright interception does not reliably
    // re-intercept a fulfilled redirect's continuation. Never follow a real URL.
    return route.fulfill({contentType:'text/html',body:render()});
  }
  return route.fulfill({contentType:'text/html',body:render(),headers:{
    'content-security-policy':"default-src 'none'; script-src 'self'; img-src 'self' blob:; frame-src https://propertypredator.com/image-maker.html; style-src 'unsafe-inline'; form-action 'self'"}});
});
try {
  await page.goto('https://hq.propertypredator.com/review');
  assert.equal(await page.getByRole('heading',{name:'Add the image first'}).count(),1);
  page.on('popup',()=>{throw new Error('Unexpected popup');});
  await page.getByRole('button',{name:'Create image',exact:true}).click();
  const maker=page.frameLocator('#post-image-frame');
  await maker.locator('#prompt').waitFor({state:'visible'});
  assert.equal(await maker.locator('#prompt').inputValue(),'Abstract test image');
  await maker.getByRole('button',{name:'Create picture',exact:true}).click();
  await maker.locator('#preview').waitFor({state:'visible'});
  await maker.getByRole('button',{name:'Use this image',exact:true}).click();
  await page.locator('#post-image-selection').waitFor({state:'visible'});
  await page.getByLabel('Describe the picture for people who cannot see it').fill('Local test graphic');
  await page.getByRole('button',{name:'Save image with this post'}).click();
  await page.waitForFunction(()=>document.querySelector('#post-image img')?.getAttribute('src')?.includes('/versions/'),undefined,{timeout:10_000});
  await page.locator('#post-image img').first().waitFor({state:'visible'});
  assert.equal(await page.locator('#post-image img').first().evaluate((img:HTMLImageElement)=>img.naturalWidth),800);
  assert.equal(saves,1);assert.equal(generated,1);
  assert.equal(await page.getByRole('button',{name:'Send for approval',exact:true}).count(),1);
  await page.screenshot({path:'../../../overnight-build-2026-09-07/_verification/hq-login-009-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
  await page.screenshot({path:'../../../overnight-build-2026-09-07/_verification/hq-login-009-mobile.png',fullPage:true});
  console.log(JSON.stringify({task:'HQ-LOGIN-009',browserChecks:7,passed:7,failed:0,
    realNetworkRequests:0,providerCalls:0,productionChanges:0,
    verified:'Real browser in-page frame handshake, existing generator endpoint, image decode, save, reload, approval availability, mobile width'}));
} catch(error) {
  console.log(JSON.stringify({saves,generated,url:page.url(),imagePersisted:!!image,
    status:await page.locator('#post-image-status').textContent().catch(()=>null)}));
  await page.screenshot({path:'../../../overnight-build-2026-09-07/_verification/hq-login-009-browser-failure.png',fullPage:true});
  throw error;
} finally {await browser.close();}
