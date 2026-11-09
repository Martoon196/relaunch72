import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const baseUrl = (process.env.PROPERTY_PREDATOR_PREVIEW_URL
  ?? 'http://127.0.0.1:43172').replace(/\/+$/u, '');
const chromePath = process.env.PROPERTY_PREDATOR_CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const outputDirectory = process.env.PROPERTY_PREDATOR_BROWSER_ACCEPTANCE_OUTPUT
  ?? join(tmpdir(), `property-predator-browser-acceptance-${Date.now()}`);

const viewports = Object.freeze([
  Object.freeze({ name: 'desktop', width: 1440, height: 1000, hasTouch: false, isMobile: false }),
  Object.freeze({ name: 'tablet', width: 820, height: 1180, hasTouch: true, isMobile: false }),
  Object.freeze({ name: 'mobile', width: 390, height: 844, hasTouch: true, isMobile: true }),
]);

interface AcceptanceResult {
  readonly page: 'daily-outreach' | 'linkedin-inbox';
  readonly viewport: string;
  readonly screenshot: string;
  readonly documentWidth: number;
  readonly viewportWidth: number;
  readonly keyboardFocusStops: number;
  readonly checkedTouchTargets: number;
}

async function assertNoDocumentOverflow(page: Page): Promise<Readonly<{
  documentWidth: number;
  viewportWidth: number;
}>> {
  const dimensions = await page.evaluate(() => Object.freeze({
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  assert.ok(
    dimensions.documentWidth <= dimensions.viewportWidth + 1,
    `document overflowed horizontally: ${dimensions.documentWidth}px > ${dimensions.viewportWidth}px`,
  );
  assert.ok(
    dimensions.bodyWidth <= dimensions.viewportWidth + 1,
    `body overflowed horizontally: ${dimensions.bodyWidth}px > ${dimensions.viewportWidth}px`,
  );
  return dimensions;
}

async function keyboardFocusStops(page: Page): Promise<number> {
  await page.locator('body').focus();
  const visited = new Set<string>();
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press('Tab');
    const identity = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body) return '';
      return [
        active.tagName.toLowerCase(), active.id,
        active.getAttribute('href') ?? '', active.getAttribute('name') ?? '',
        active.textContent?.trim().slice(0, 40) ?? '',
      ].join('|');
    });
    if (identity) visited.add(identity);
  }
  assert.ok(visited.size >= 4, `keyboard traversal reached only ${visited.size} distinct controls`);
  return visited.size;
}

async function assertTouchTargets(page: Page, selector: string): Promise<number> {
  const targets = await page.locator(selector).evaluateAll((elements) => elements
    .map((element) => {
      const node = element as HTMLElement;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        label: node.getAttribute('aria-label') ?? node.textContent?.trim().slice(0, 60)
          ?? node.tagName.toLowerCase(),
        width: rect.width,
        height: rect.height,
        visible: style.display !== 'none' && style.visibility !== 'hidden'
          && rect.width > 0 && rect.height > 0,
      };
    })
    .filter((target) => target.visible));
  assert.ok(targets.length > 0, `no visible touch targets matched ${selector}`);
  const undersized = targets.filter((target) => target.width < 44 || target.height < 44);
  assert.deepEqual(
    undersized,
    [],
    `touch targets below 44px: ${JSON.stringify(undersized)}`,
  );
  return targets.length;
}

async function assertDailyOutreach(page: Page): Promise<void> {
  await assert.doesNotReject(page.waitForSelector('article.pdo[data-dataset="fictional_test"]'));
  await assert.doesNotReject(page.waitForSelector('#pdo-watch[aria-labelledby="pdo-watch-title"]'));
  assert.match(await page.locator('#pdo-title').innerText(), /Fill the tank/u);
  assert.match(await page.locator('#pdo-watch-title').innerText(), /no_comment/u);
  assert.equal(await page.locator('article.pdo').getAttribute('data-provider-effects'), 'none');
  assert.equal(await page.locator('article.pdo').getAttribute('data-command-boundary'), 'absent');
  const unsafeForms = await page.locator('form').evaluateAll((forms) => forms
    .map((form) => ({ action: form.getAttribute('action') ?? '', method: form.getAttribute('method') ?? 'get' }))
    .filter((form) => !/\/portal\/logout$/u.test(form.action)));
  assert.deepEqual(unsafeForms, [], 'Daily Outreach preview unexpectedly exposed a command form');
}

async function assertLinkedinInboxReadOnly(page: Page): Promise<void> {
  await assert.doesNotReject(page.waitForSelector('section.ci[data-property-predator-conversion-inbox]'));
  assert.match(await page.locator('.ci-head h1').innerText(), /Every channel\. One human queue\./u);
  assert.match(await page.locator('section.ci').innerText(), /Conversion Inbox/iu);
  const selectedChannel = page.locator('.ci-channel[aria-current="page"]');
  assert.equal(await selectedChannel.count(), 1);
  assert.match(await selectedChannel.innerText(), /LinkedIn|LI/iu);
  const unsafeForms = await page.locator('form').evaluateAll((forms) => forms
    .map((element) => {
      const form = element as HTMLFormElement;
      return {
        action: new URL(form.action, document.baseURI).pathname,
        method: (form.getAttribute('method') ?? 'get').toLowerCase(),
      };
    })
    .filter((form) => !['/portal/logout', '/portal/inbox'].includes(form.action)));
  assert.deepEqual(unsafeForms, [], 'LinkedIn inbox unexpectedly exposed a message mutation form');
  const effectfulButtons = await page.getByRole('button', {
    name: /send|publish|queue live|post comment|send dm/iu,
  }).count();
  assert.equal(effectfulButtons, 0, 'LinkedIn inbox exposed an external-effect button');
  assert.match(
    await page.locator('.ci-truth').innerText(),
    /SAFETY BOUNDARY[\s\S]*simulator outcomes only/iu,
  );
}

await mkdir(outputDirectory, { recursive: true });
const response = await fetch(`${baseUrl}/portal/outreach/daily`, { redirect: 'manual' });
assert.equal(response.status, 200, `preview was not reachable at ${baseUrl}`);

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--disable-background-networking', '--disable-component-update'],
});
const results: AcceptanceResult[] = [];
try {
  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.hasTouch,
      isMobile: viewport.isMobile,
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    });
    try {
      for (const target of [
        Object.freeze({
          page: 'daily-outreach' as const,
          path: '/portal/outreach/daily',
          assertion: assertDailyOutreach,
          touchSelector: '.pdo-jump a, .pdo-queue summary',
        }),
        Object.freeze({
          page: 'linkedin-inbox' as const,
          path: '/portal/inbox?channel=linkedin',
          assertion: assertLinkedinInboxReadOnly,
          touchSelector: '.ci-toolbar input, .ci-toolbar select, .ci-toolbar button, .ci-toolbar a, .ci-channel, .ci-conversation>a, .ci-lead-link',
        }),
      ]) {
        const pageErrors: string[] = [];
        const page = await context.newPage();
        page.on('pageerror', (error) => pageErrors.push(error.message));
        const navigation = await page.goto(`${baseUrl}${target.path}`, {
          waitUntil: 'domcontentloaded',
          timeout: 20_000,
        });
        assert.equal(navigation?.status(), 200, `${target.path} did not return 200`);
        await target.assertion(page);
        const dimensions = await assertNoDocumentOverflow(page);
        const focusStops = await keyboardFocusStops(page);
        const checkedTouchTargets = viewport.hasTouch
          ? await assertTouchTargets(page, target.touchSelector)
          : 0;
        assert.deepEqual(pageErrors, [], `browser errors on ${target.path}: ${pageErrors.join('; ')}`);
        const screenshot = join(outputDirectory, `${target.page}-${viewport.name}.png`);
        await page.screenshot({ path: screenshot, fullPage: true });
        results.push(Object.freeze({
          page: target.page,
          viewport: viewport.name,
          screenshot,
          documentWidth: dimensions.documentWidth,
          viewportWidth: dimensions.viewportWidth,
          keyboardFocusStops: focusStops,
          checkedTouchTargets,
        }));
        await page.close();
      }
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}

const report = Object.freeze({
  ok: true,
  baseUrl,
  chromePath,
  outputDirectory,
  checkedAt: new Date().toISOString(),
  results,
});
await writeFile(join(outputDirectory, 'results.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
