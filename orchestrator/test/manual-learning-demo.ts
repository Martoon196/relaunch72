/**
 * Manual visual proof for Milestone 5 (not part of `npm test`): the acquisition proposal's "What we learned"
 * section through the real router. CRM outcome counts are SYNTHETIC fixture rows, labelled in the file names;
 * the real SQL read and evidence checks are proved by test/db/creative-studio-learning-pg.integration.test.ts.
 *   node --import tsx test/manual-learning-demo.ts <out-dir>
 */
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { handleSeoBlog } from '../src/portal/seo-blog-router.js';
import type { PortalSeoBlogService } from '../src/portal/seo-blog-service.js';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { UnconfiguredSearchProvider } from '../src/seo-blog/research.js';
import { CreativeStudioService } from '../src/creative-studio/service.js';
import { MemoryCreativeLibraryStore } from '../src/creative-studio/store.js';
import { findCreativeChromium, type ArtworkRenderer } from '../src/creative-studio/renderer.js';
import { MemoryLearningStore } from '../src/creative-studio/learning.js';
import { creativeUtmContent, type OutcomeBucket } from '../src/creative-studio/distribution.js';
import { FakeWeb } from './seo-blog-fixtures.js';
import { acquisitionBrief, acquisitionFixture } from './acquisition-campaign-fixtures.js';

const out = path.resolve(process.argv[2] ?? 'learning-demo'); mkdirSync(out, { recursive: true });
const executable = findCreativeChromium(); if (!executable) throw new Error('Chromium not found');
const f = await acquisitionFixture();
const engine = new SeoBlogEngine({ store: f.blogs, methods: f.controller, creatorStore: f.store, llm: f.model, search: new UnconfiguredSearchProvider(), transport: new FakeWeb(), publishers: new Map(), now: () => new Date().toISOString(), batchLimit: 20 } as never);
const record = await f.creator.create(f.actor, f.brand.id, randomUUID(), acquisitionBrief(f.profile));
const at = (d: string) => `2026-11-${d}T09:00:00.000Z`;
const buckets: OutcomeBucket[] = [
  { utmContent: creativeUtmContent(0, '1a2b3c4d-0000-4000-8000-000000000001'), leads: 60, qualified: 30, booked: 9, sold: 2, customers: 2, subscriptionsCancelled: 0, firstAt: at('01'), lastAt: at('08') },
  { utmContent: creativeUtmContent(1, '5e6f7a8b-0000-4000-8000-000000000002'), leads: 80, qualified: 12, booked: 8, sold: 1, customers: 1, subscriptionsCancelled: 0, firstAt: at('01'), lastAt: at('08') },
];
const learning = new MemoryLearningStore(async () => buckets);
const studio = new CreativeStudioService({ library: new MemoryCreativeLibraryStore(), brands: f.blogs, renderer: { available: () => false } as unknown as ArtworkRenderer, creators: f.store,
  distribution: { delivery: async () => [], outcomes: async (_b, u) => ({ utmCampaign: u, readAt: new Date().toISOString(), buckets }) }, learning,
  guidance: { saveAudienceNote: async () => ({ documentId: randomUUID() }) } });
await studio.learning().record(f.actor, f.brand.id, record.id, randomUUID());
const [rec] = await learning.listFindings(f.brand.id, record.id);
await studio.learning().sharePattern(f.actor, f.brand.id, rec!.id, 'Practical first-step questions drew more qualified enquiries than general invitations.', randomUUID());
const service: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => engine, socialCallback: async () => null, creativeEnabled: true, creativeFor: () => studio, creativeSavedImages: async () => [] };
const identity = { sessionToken: `token-${f.actor}`, userId: f.actor, workspaceId: f.brand.id, userEmail: 'owner@example.test' };
const server = createServer((req, res) => { void handleSeoBlog(req, res, new URL(req.url!, 'http://127.0.0.1'), { service, identity, requestId: 'demo', sessionSecret: 's'.repeat(48), vaultReady: true }); });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: executable });
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/portal/seo-blog/b/${f.brand.id}/campaigns/${record.id}`);
  await page.locator('#learning').screenshot({ path: path.join(out, 'm5-what-we-learned-synthetic-crm.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#learning').screenshot({ path: path.join(out, 'm5-what-we-learned-mobile-synthetic-crm.png') });
  console.log(JSON.stringify({ out, findings: rec!.snapshot.findings.map((x) => [x.kind, x.strength]), nextTests: rec!.snapshot.nextTests.map((t) => t.title) }, null, 2));
} finally { await browser.close(); server.close(); }
