/**
 * Manual visual proof (not part of `npm test`): serves the real SEO-blog router
 * with the Creative Studio over two clearly fictional brands (memory stores,
 * real headless Chromium renderer, no provider and no network), drives the
 * actual forms with Playwright, and writes screenshots plus the exact rendered
 * artwork files to the output directory.
 *
 *   node --import tsx test/manual-creative-studio-demo.ts <out-dir>
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { handleSeoBlog } from '../src/portal/seo-blog-router.js';
import type { PortalSeoBlogService } from '../src/portal/seo-blog-service.js';
import { CreativeStudioService } from '../src/creative-studio/service.js';
import { MemoryCreativeLibraryStore } from '../src/creative-studio/store.js';
import { ChromiumArtworkRenderer, findCreativeChromium } from '../src/creative-studio/renderer.js';
import { harness, OWNER } from './seo-blog-fixtures.js';
import { creativeBrand, HEARTH, QUEUE, syntheticLandscapeJpeg, syntheticLogoPng } from './creative-studio-fixtures.js';

const out = path.resolve(process.argv[2] ?? 'creative-demo'); mkdirSync(out, { recursive: true });
const executable = findCreativeChromium(); if (!executable) throw new Error('Chromium not found');
const h = harness();
const hearth = await creativeBrand(h, HEARTH);
const queue = await creativeBrand(h, { ...QUEUE, name: 'Fictional Queue Scheduling', exclusions: [] });
const library = new MemoryCreativeLibraryStore(), renderer = new ChromiumArtworkRenderer(executable);
const studio = new CreativeStudioService({ library, brands: h.store, renderer, savedImages: { list: async () => [], load: async () => { throw new Error('none'); } } });
const service: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => h.engine, socialCallback: async () => null,
  creativeEnabled: true, creativeFor: () => studio, creativeSavedImages: async () => [] };
const SECRET = 's'.repeat(48);
const identity = { sessionToken: `token-${OWNER.userId}`, userId: OWNER.userId, workspaceId: hearth.brand.id, userEmail: 'owner@example.test' };
const server = createServer((req, res) => { void handleSeoBlog(req, res, new URL(req.url!, 'http://127.0.0.1'), { service, identity, requestId: 'demo', sessionSecret: SECRET, vaultReady: true }); });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const files = path.join(out, 'inputs'); mkdirSync(files, { recursive: true });
writeFileSync(path.join(files, 'hearth-logo.png'), syntheticLogoPng([255, 255, 255]));
writeFileSync(path.join(files, 'queue-logo.png'), syntheticLogoPng([255, 255, 255]));
writeFileSync(path.join(files, 'background.jpg'), syntheticLandscapeJpeg());

const browser = await chromium.launch({ executablePath: executable });
const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 })).newPage();
const shot = (name: string) => page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
try {
  // Brand A: confirm a kit with real logo bytes, then create an advert from its approved offer.
  const a = `${origin}/portal/seo-blog/b/${hearth.brand.id}/creative`;
  await page.goto(a); await shot('01-hearth-studio-before-kit');
  await page.goto(`${a}/kit`);
  for (const [k, v] of Object.entries({ primary: '#0f766e', accent: '#fbbf24', dark: '#0b2421', light: '#ffffff' })) await page.fill(`#kit-${k}`, v);
  await page.setInputFiles('#kit-logo', path.join(files, 'hearth-logo.png')); await page.fill('#kit-logo-label', 'Hearth fixture logo (white)');
  await page.fill('#kit-disc', 'Fictional demonstration brand. Price for a standard domestic boiler.');
  await Promise.all([page.waitForURL(/\/creative\?/u), page.click('form.cs-form button[type=submit]')]);
  await page.check('input[name=background][value=upload]'); await page.setInputFiles('#cs-file', path.join(files, 'background.jpg'));
  await page.selectOption('#cs-dest', HEARTH.pages[0]!.url); await page.selectOption('#cs-aud', HEARTH.audiences[0]!);
  await shot('02-hearth-request-form');
  await Promise.all([page.waitForURL(/\/creative\/s\//u), page.click('form.cs-form button[type=submit]')]);
  await shot('03-hearth-compare-initial');
  // Edit one component of concept 1, approve two exact images.
  await page.locator('details:has(summary:text("Edit concept"))').first().locator('summary').click();
  await page.locator('details:has(summary:text("Edit concept"))').first().locator('input[name=headline]').fill('Your boiler, serviced calmly — £89');
  await Promise.all([page.waitForLoadState('load'), page.locator('details:has(summary:text("Edit concept"))').first().locator('button[type=submit]').click()]);
  for (const _ of [0, 1]) { await Promise.all([page.waitForLoadState('load'), page.locator('button:text("Approve this image")').first().click()]); }
  await shot('04-hearth-compare-after-edit-and-approvals');
  // Brand B: different kit, a carousel from a short brief on a neutral background.
  const b = `${origin}/portal/seo-blog/b/${queue.brand.id}/creative`;
  await page.goto(`${b}/kit`);
  for (const [k, v] of Object.entries({ primary: '#1e3a8a', accent: '#fb7185', dark: '#0b1430', light: '#ffffff' })) await page.fill(`#kit-${k}`, v);
  await page.setInputFiles('#kit-logo', path.join(files, 'queue-logo.png'));
  await Promise.all([page.waitForURL(/\/creative\?/u), page.click('form.cs-form button[type=submit]')]);
  await page.check('input[name=purpose][value=carousel]'); await page.check('input[name=source_kind][value=offer]');
  for (const p of ['vertical']) await page.uncheck(`input[name=placements][value=${p}]`);
  await page.uncheck('input[name=placements][value=square]');
  await page.selectOption('#cs-n', '2'); await page.selectOption('#cs-cards', '3'); await page.selectOption('#cs-dest', QUEUE.pages[0]!.url);
  await Promise.all([page.waitForURL(/\/creative\/s\//u), page.click('form.cs-form button[type=submit]')]);
  await shot('05-queue-carousel-compare');
  await page.goto(b); await shot('06-queue-studio-library');
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(a); await shot('07-hearth-studio-mobile');
  // Export the exact stored artwork bytes for inspection.
  for (const brand of [hearth.brand, queue.brand]) {
    for (const s of await library.listSets(brand.id)) {
      const record = (await library.getSet(brand.id, s.set.id))!;
      for (const v of record.versions) {
        const art = await studio.artwork(OWNER.userId, brand.id, v.id, v.render.sha256);
        writeFileSync(path.join(out, `${brand.slug}-${v.conceptKey}-${v.placement}${v.card ? `-card${v.card}` : ''}-v${v.number}${art.approved ? '-approved' : ''}.jpg`), art.bytes);
      }
    }
  }
  console.log(JSON.stringify({ out, hearthSets: (await library.listSets(hearth.brand.id)).length, queueSets: (await library.listSets(queue.brand.id)).length }));
} finally { await browser.close(); server.close(); }
