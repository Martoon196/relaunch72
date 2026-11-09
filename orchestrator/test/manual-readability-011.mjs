import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
const browser = await chromium.launch({channel:'msedge', headless:true});
let passed = 0;
try {
  for (const width of [1366, 390]) for (const theme of ['light', 'dark', 'system']) {
    const context = await browser.newContext({viewport:{width,height:950}, colorScheme:'light'});
    await context.addInitScript(value => localStorage.setItem('property-predator-appearance', value), theme);
    const page = await context.newPage();
    await page.route('https://**/*', route => route.abort());
    await page.goto('http://127.0.0.1:43184/portal/content/calendar', {waitUntil:'domcontentloaded'});
    const result = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.ccal p,.ccal label,.ccal-live-workflow li')];
      const panel = document.querySelector('.ccal-live-scheduler');
      return {count:nodes.length, small:nodes.filter(n => parseFloat(getComputedStyle(n).fontSize) < 16).map(n=>n.className),
        panel:panel ? getComputedStyle(panel).backgroundColor : null,
        overflow:document.documentElement.scrollWidth > innerWidth + 1};
    });
    assert.ok(result.count > 5);
    assert.deepEqual(result.small, [], JSON.stringify({width,theme,result}));
    assert.equal(result.overflow, false, JSON.stringify({width,theme,result}));
    if (result.panel) assert.equal(result.panel, theme === 'dark' ? 'rgb(17, 19, 24)' : 'rgb(255, 255, 255)');
    await page.screenshot({path:`../../../overnight-build-2026-09-07/_verification/readability-011-${width}-${theme}.png`,fullPage:true});
    console.log(JSON.stringify({width,theme,...result}));
    passed++;
    await context.close();
  }
  console.log(`Visual layout checks: ${passed} pass / 0 fail`);
} finally { await browser.close(); }
