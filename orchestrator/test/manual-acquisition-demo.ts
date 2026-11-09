/**
 * Manual visual proof (not part of `npm test`): the acquisition-proposal journey through the
 * real router with a fictional brand, a deterministic fixture model (no provider) and the
 * Creative Studio hand-off. Writes screenshots to the output directory.
 *   node --import tsx test/manual-acquisition-demo.ts <out-dir>
 */
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { handleSeoBlog } from '../src/portal/seo-blog-router.js';
import type { PortalSeoBlogService } from '../src/portal/seo-blog-service.js';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { UnconfiguredSearchProvider } from '../src/seo-blog/research.js';
import { CreativeStudioService } from '../src/creative-studio/service.js';
import { MemoryCreativeLibraryStore } from '../src/creative-studio/store.js';
import { ChromiumArtworkRenderer, findCreativeChromium } from '../src/creative-studio/renderer.js';
import { FakeWeb } from './seo-blog-fixtures.js';
import { acquisitionFixture } from './acquisition-campaign-fixtures.js';

const out = path.resolve(process.argv[2] ?? 'acquisition-demo'); mkdirSync(out, { recursive: true });
const executable = findCreativeChromium(); if (!executable) throw new Error('Chromium not found');
const f = await acquisitionFixture();
const engine = new SeoBlogEngine({ store: f.blogs, methods: f.controller, creatorStore: f.store, llm: f.model, search: new UnconfiguredSearchProvider(), transport: new FakeWeb(), publishers: new Map(), vault: null });
const studio = new CreativeStudioService({ library: new MemoryCreativeLibraryStore(), brands: f.blogs, renderer: new ChromiumArtworkRenderer(executable) });
const service: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => engine, socialCallback: async () => null,
  creativeEnabled: true, creativeFor: () => studio, creativeSavedImages: async () => [] };
const identity = { sessionToken: `token-${f.actor}`, userId: f.actor, workspaceId: f.brand.id, userEmail: 'owner@example.test' };
const server = createServer((req, res) => { void handleSeoBlog(req, res, new URL(req.url!, 'http://127.0.0.1'), { service, identity, requestId: 'demo', sessionSecret: 's'.repeat(48), vaultReady: true }); });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: executable });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const shot = (name: string) => page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
try {
  await page.goto(`${origin}/portal/seo-blog/b/${f.brand.id}/campaigns`);
  const form = page.locator('form:has(input[name=kind][value=acquisition])');
  await form.locator('input[name=name]').fill('Spring maintenance enquiries');
  await form.locator('textarea[name=goal]').fill('Help homeowners take a calm first step towards a maintenance enquiry.');
  await form.locator('input[name=channels][value=facebook]').check();
  await shot('01-acquisition-form');
  await Promise.all([page.waitForURL(/\/campaigns\/[0-9a-f-]{36}/u), form.locator('button[type=submit]').click()]);
  await shot('02-acquisition-proposal-review');
  await Promise.all([page.waitForURL(/\/creative\?/u), page.locator('a:text("Create artwork for this concept")').first().click()]);
  await shot('03-creative-prefilled-from-concept');
  console.log(JSON.stringify({ out, calls: f.model.acquisitionCalls }));
} finally { await browser.close(); server.close(); }
