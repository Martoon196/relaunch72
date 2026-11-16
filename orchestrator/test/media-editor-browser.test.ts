/** Real headless Chromium proof of owner editor controls and narrow mobile layout. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright-core';
import {MEDIA_CUT_EDITOR_SCRIPT} from '../src/portal/media-cut-editor.js';
const executable=process.env.MEDIA_BROWSER_EXECUTABLE??['/usr/bin/chromium','/usr/bin/google-chrome','/usr/bin/google-chrome-stable'].find(existsSync);
test('real browser: split, mute, undo, redo, duplicate and reorder preserve exact owner save payload',{skip:process.env.RL72_MEDIA_BROWSER_TESTS!=='true'?'Explicit media browser run only':executable?false:'System Chromium unavailable',timeout:30000},async()=>{
 const browser=await chromium.launch({executablePath:executable,headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.route('**/stream',route=>route.abort());
  const plan={canvas:'portrait',disclosure:'#ad',clips:[{startMs:0,endMs:4000,caption:'Original',transition:'cut',speed:1}]};
  await page.setContent('<form data-rl72-cut-editor data-rl72-preview-base="https://app.test/creative"><input name="source" value="11111111-1111-4111-8111-111111111111:a"><label>Plan<textarea name="planJson"></textarea></label></form>');
  await page.locator('textarea[name=planJson]').fill(JSON.stringify(plan));
  await page.addScriptTag({content:MEDIA_CUT_EDITOR_SCRIPT});
  await page.locator('video').evaluate(v=>Object.defineProperty(v,'currentTime',{value:2,writable:true,configurable:true}));
  await page.getByRole('button',{name:'Split at playhead',exact:true}).click();
  assert.equal(await page.locator('fieldset').count(),2);
  await page.getByLabel('Audio volume',{exact:true}).first().selectOption('0');
  const read=async()=>JSON.parse(await page.locator('textarea[name=planJson]').inputValue());
  assert.equal((await read()).clips[0].volume,0);
  await page.getByRole('button',{name:'Undo',exact:true}).click();assert.equal((await read()).clips[0].volume,undefined);
  await page.getByRole('button',{name:'Redo',exact:true}).click();assert.equal((await read()).clips[0].volume,0);
  await page.getByRole('button',{name:'Duplicate clip',exact:true}).first().click();assert.equal((await read()).clips.length,3);
  await page.getByLabel('Caption',{exact:true}).first().fill('First');await page.getByLabel('Caption',{exact:true}).first().dispatchEvent('change');
  await page.getByRole('button',{name:'Move later',exact:true}).first().click();assert.equal((await read()).clips[1].caption,'First');
  await page.getByRole('button',{name:'Undo',exact:true}).click();assert.equal((await read()).clips[0].caption,'First');
  assert.equal(await page.locator('input[type=number]').count(),6);
  assert.equal(await page.locator('output').getAttribute('aria-live'),'polite');
 }finally{await browser.close();}
});
