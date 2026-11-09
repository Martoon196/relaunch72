/**
 * Manual visual proof (not part of `npm test`): the storyboard → video journey through the real
 * router and forms with a fictional brand, real headless Chromium, no provider and no network.
 *   node --import tsx test/manual-video-demo.ts <out-dir>
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { handleSeoBlog } from '../src/portal/seo-blog-router.js';
import type { PortalSeoBlogService } from '../src/portal/seo-blog-service.js';
import { CreativeStudioService } from '../src/creative-studio/service.js';
import { MemoryCreativeLibraryStore, mediaOf } from '../src/creative-studio/store.js';
import { ChromiumArtworkRenderer, findCreativeChromium } from '../src/creative-studio/renderer.js';
import { harness, OWNER } from './seo-blog-fixtures.js';
import { creativeBrand, HEARTH, syntheticLandscapeJpeg, syntheticLogoPng } from './creative-studio-fixtures.js';

const out = path.resolve(process.argv[2] ?? 'video-demo'); mkdirSync(out, { recursive: true });
const executable = findCreativeChromium(); if (!executable) throw new Error('Chromium not found');
const h = harness(); const hearth = await creativeBrand(h, HEARTH);
const library = new MemoryCreativeLibraryStore();
const studio = new CreativeStudioService({ library, brands: h.store, renderer: new ChromiumArtworkRenderer(executable) });
const service: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => h.engine, socialCallback: async () => null, creativeEnabled: true, creativeFor: () => studio, creativeSavedImages: async () => [] };
const identity = { sessionToken: `token-${OWNER.userId}`, userId: OWNER.userId, workspaceId: hearth.brand.id, userEmail: 'owner@example.test' };
const server = createServer((req, res) => { void handleSeoBlog(req, res, new URL(req.url!, 'http://127.0.0.1'), { service, identity, requestId: 'demo', sessionSecret: 's'.repeat(48), vaultReady: true }); });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, base = `${origin}/portal/seo-blog/b/${hearth.brand.id}/creative`;
const files = path.join(out, 'inputs'); mkdirSync(files, { recursive: true });
writeFileSync(path.join(files, 'logo.png'), syntheticLogoPng([255, 255, 255])); writeFileSync(path.join(files, 'background.jpg'), syntheticLandscapeJpeg());
const browser = await chromium.launch({ executablePath: executable });
const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
const shot = (name: string) => page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
try {
  await page.goto(`${base}/kit`);
  for (const [k, v] of Object.entries({ primary: '#0f766e', accent: '#fbbf24', dark: '#0b2421', light: '#ffffff' })) await page.fill(`#kit-${k}`, v);
  await page.setInputFiles('#kit-logo', path.join(files, 'logo.png'));
  await page.fill('#kit-disc', 'Fictional demonstration brand. Price for a standard domestic boiler.');
  await Promise.all([page.waitForURL(/\/creative\?/u), page.click('form.cs-form button[type=submit]')]);
  await page.check('input[name=background][value=upload]'); await page.setInputFiles('#cs-file', path.join(files, 'background.jpg'));
  await page.selectOption('#cs-dest', HEARTH.pages[0]!.url); await page.selectOption('#cs-n', '1');
  await Promise.all([page.waitForURL(/\/creative\/s\//u), page.click('form.cs-form button[type=submit]')]);
  // Draft a vertical storyboard (uploaded imagery needs the permission confirmation).
  const start = page.locator('form[action*="/storyboard/c1"]');
  await start.locator('input[name=likeness]').check();
  await Promise.all([page.waitForLoadState('load'), start.locator('button[type=submit]').click()]);
  await shot('01-storyboard-drafted');
  // Scene-level edit: change scene 2 text and timing.
  await page.locator('summary:text("Edit scenes")').first().click();
  await page.locator('input[name="scene.1.headline"]').fill('Checked by a registered engineer');
  await page.locator('select[name="scene.1.duration"]').selectOption('4500');
  await Promise.all([page.waitForLoadState('load'), page.locator('form[action$="/scenes"] button[type=submit]').click()]);
  const t0 = Date.now();
  await Promise.all([page.waitForLoadState('load', { timeout: 120_000 }), page.locator('form[action$="/video"] button[type=submit]').first().click()]);
  const renderMs = Date.now() - t0;
  await Promise.all([page.waitForLoadState('load'), page.locator('button:text("Approve this video")').first().click()]);
  await page.locator('h2:text("Video")').scrollIntoViewIfNeeded();
  await shot('02-video-rendered-and-approved');
  const record = (await library.listSets(hearth.brand.id))[0]!;
  for (const v of (await library.getSet(hearth.brand.id, record.set.id))!.versions.filter((x) => mediaOf(x) !== 'image')) {
    const art = await studio.artwork(OWNER.userId, hearth.brand.id, v.id, v.render.sha256);
    writeFileSync(path.join(out, `c1-${mediaOf(v)}-${v.placement}-v${v.number}${art.approved ? '-approved' : ''}.${v.render.mime === 'video/mp4' ? 'mp4' : v.render.mime === 'video/webm' ? 'webm' : 'jpg'}`), art.bytes);
  }
  console.log(JSON.stringify({ out, renderMs }));
} finally { await browser.close(); server.close(); }
