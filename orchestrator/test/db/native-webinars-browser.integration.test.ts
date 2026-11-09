/** Real browser form submission: native privacy metadata must not break strict Origin/CSRF checks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser } from 'playwright-core';
import { findCreativeChromium } from '../../src/creative-studio/renderer.js';
import { openTestDatabase, testDatabaseSkipReason } from './database-helper.js';
import { PROFILES, loginRole, seedBrand, startWebinarHttpHarness, syntheticConfig } from './webinar-harness.js';

const executable = findCreativeChromium();
test('real Chromium creates a webinar through the normal form without relaxing Origin or CSRF',
  { skip: testDatabaseSkipReason() || (!executable && 'Pinned Chromium is required'), timeout: 180_000 }, async () => {
    const admin = await openTestDatabase();
    const content = await loginRole(admin, 'r72_content_command');
    const crm = await loginRole(admin, 'r72_crm_command');
    let harness: Awaited<ReturnType<typeof startWebinarHttpHarness>> | undefined;
    let browser: Browser | undefined;
    try {
      const brand = await seedBrand(admin, 'Browser form');
      harness = await startWebinarHttpHarness({ contentPool: content, crmPool: crm,
        users: { owner: { identity: brand.owner, profile: PROFILES.relaunch72 } },
        configFor: origin => syntheticConfig(brand.ws, null, origin) });
      browser = await chromium.launch({ executablePath: executable!, headless: true, chromiumSandbox: process.getuid?.() !== 0 });
      const context = await browser.newContext();
      await context.route('**/*', route => new URL(route.request().url()).origin === harness!.origin ? route.continue() : route.abort());
      const page = await context.newPage();
      await page.goto(harness.origin + '/preview/sign-in?as=owner&next=' + encodeURIComponent('/portal/webinars/new'));
      await page.getByLabel('Title', { exact: true }).fill('Browser-created private webinar');
      await page.getByLabel('Presenter', { exact: true }).fill('Synthetic host');
      await page.getByLabel('Start (local time)', { exact: true }).fill('2030-11-25T19:00');
      const posted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/portal/webinars');
      await page.getByRole('button', { name: 'Create webinar', exact: true }).click();
      const response = await posted;
      assert.equal(response.status(), 303, 'a genuine same-origin native form must pass the unchanged guards');
      assert.equal((await response.request().allHeaders()).origin, harness.origin, 'the browser supplies its actual origin, not an opaque null origin');
      await page.waitForURL(/\/portal\/webinars\/[0-9a-f-]{36}\?/);
      const stored = await harness.service.list(brand.owner, randomUUID());
      assert.equal(stored.webinars.length, 1);
      assert.equal(stored.webinars[0]!.title, 'Browser-created private webinar');
    } finally {
      await browser?.close();
      await harness?.close();
      await content.end(); await crm.end(); await admin.end();
    }
  });
