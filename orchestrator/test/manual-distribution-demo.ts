/**
 * Manual visual proof for Milestone 4 (not part of `npm test`): fictional brands, real Chromium artwork, the real
 * router. Part A hands an approved portrait into an article's existing private images. Part B hands artwork to an
 * acquisition proposal as a tracked link and shows "Actual results". CRM outcome rows in Part B are SYNTHETIC and
 * labelled as such; the real SQL read is proved by test/db/creative-studio-distribution-pg.integration.test.ts.
 *   node --import tsx test/manual-distribution-demo.ts <out-dir>
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { handleSeoBlog } from '../src/portal/seo-blog-router.js';
import type { PortalSeoBlogService } from '../src/portal/seo-blog-service.js';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { UnconfiguredSearchProvider } from '../src/seo-blog/research.js';
import { ArticleMediaReviewService, canonicalImageQualityApproval } from '../src/seo-blog/media-review.js';
import { GithubStaticPublisher } from '../src/seo-blog/publishers/github-static.js';
import { CreativeStudioService, type DistributionReadPort } from '../src/creative-studio/service.js';
import { MemoryCreativeLibraryStore } from '../src/creative-studio/store.js';
import { ChromiumArtworkRenderer, findCreativeChromium } from '../src/creative-studio/renderer.js';
import { FakeWeb, OWNER } from './seo-blog-fixtures.js';
import { acquisitionFixture } from './acquisition-campaign-fixtures.js';
import { websiteFixture } from './seo-blog-website-fixtures.js';
import { nativeMediaPorts } from './seo-blog-native-media-fixture.js';

const out = path.resolve(process.argv[2] ?? 'distribution-demo'); mkdirSync(out, { recursive: true });
const executable = findCreativeChromium(); if (!executable) throw new Error('Chromium not found');
const renderer = new ChromiumArtworkRenderer(executable);
const browser = await chromium.launch({ executablePath: executable });
const report: Record<string, unknown> = {};

async function serve(service: PortalSeoBlogService, identity: { sessionToken: string; userId: string; workspaceId: string; userEmail: string }) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => { void handleSeoBlog(req, res, new URL(req.url!, 'http://127.0.0.1'), { service, identity, requestId: 'demo', sessionSecret: 's'.repeat(48), vaultReady: true }); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}
async function draftAndApprove(page: Page, origin: string, brandId: string, extra: (p: Page) => Promise<void>) {
  await page.goto(`${origin}/portal/seo-blog/b/${brandId}/creative`);
  await extra(page);
  await Promise.all([page.waitForURL(/\/creative\/s\/[0-9a-f-]{36}/u, { timeout: 120_000 }), page.locator('form[action$="/creative/draft"] button[type=submit]').click()]);
  const portrait = page.locator('figure.art:has(span:text("1080×1350"))').first();
  await Promise.all([page.waitForURL(/#v-/u), portrait.locator('form[action$="/approve"] button').click()]);
}

try {
  // ── Part A: approved portrait → existing article images ──
  {
    const f = await websiteFixture('github_static'), h = f.h, ports = nativeMediaPorts(h.store, f.brand.id, OWNER.userId, h.clock.now);
    const engine = new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map([['github_static', new GithubStaticPublisher(h.github.fetch, 1000)]]), vault: h.vault, now: h.clock.now, batchLimit: 20,
      mediaReview: new ArticleMediaReviewService(h.store, ports.media, canonicalImageQualityApproval({ context: ports.context, drafts: ports.drafts, approvals: ports.approvals, find: (s, x) => ports.find(s, x) }), h.clock.now) });
    const studio = new CreativeStudioService({ library: new MemoryCreativeLibraryStore(), brands: h.store, renderer,
      articleMedia: { importApproved: (a, b, art, c, bytes, profile, origin) => engine.importCreativeImage({ userId: a }, b, art, c, bytes, profile, origin) } });
    const service: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => engine, socialCallback: async () => null, creativeEnabled: true, creativeFor: () => studio, creativeSavedImages: async () => [] };
    const { server, origin } = await serve(service, { sessionToken: `token-${OWNER.userId}`, userId: OWNER.userId, workspaceId: f.brand.id, userEmail: 'owner@example.test' });
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    try {
      await draftAndApprove(page, origin, f.brand.id, async (p) => {
        await p.locator('input[name=purpose][value=organic_social]').check();
        await p.locator('input[name=source_kind][value=brief]').check();
        await p.locator('textarea[name=brief]').fill('Harbour Compliance Plan costs £49 per month.');
        for (const v of ['square', 'vertical']) await p.locator(`input[name=placements][value=${v}]`).uncheck().catch(() => undefined);
        await p.locator('input[name=placements][value=portrait]').check();
        await p.locator('select[name=concepts]').selectOption('1').catch(() => undefined);
      });
      const portrait = page.locator('figure.art:has(span:text("1080×1350"))').first();
      await portrait.locator('details:has(summary:text("Hand off")) summary').click();
      await page.screenshot({ path: path.join(out, '01-handoff-choice.png'), fullPage: false, clip: { x: 0, y: Math.max(0, (await portrait.boundingBox())!.y - 20), width: 1280, height: 900 } });
      await Promise.all([page.waitForURL(/#distribution/u, { timeout: 60_000 }), portrait.locator('form[action$="/handoff"] button').click()]);
      await page.locator('#distribution').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, '02-distribution-article.png'), fullPage: true });
      writeFileSync(path.join(out, '02-notice.txt'), await page.locator('[role=status], .notice').first().innerText().catch(() => ''));
      await page.goto(`${origin}/portal/seo-blog/b/${f.brand.id}/articles/${f.articleId}/campaign`);
      await page.screenshot({ path: path.join(out, '03-article-images-from-studio.png'), fullPage: false });
      const article = (await h.store.getArticle(f.brand.id, f.articleId))!;
      report.articleImport = article.localImageProposals?.filter((p) => p.origin).map((p) => ({ origin: p.origin, variants: p.variants.map((v) => `${v.profile} ${v.width}x${v.height}`) }));
      report.articleAfterHandoff = { qualityReviews: article.mediaQualityReviews?.length ?? 0, postingPlans: article.campaign?.queueInstructions?.length ?? 0 };
    } finally { server.close(); }
  }
  // ── Part B: acquisition proposal → tracked link → actual results (SYNTHETIC CRM rows) ──
  {
    const f = await acquisitionFixture();
    const engine = new SeoBlogEngine({ store: f.blogs, methods: f.controller, creatorStore: f.store, llm: f.model, search: new UnconfiguredSearchProvider(), transport: new FakeWeb(), publishers: new Map(), vault: undefined as never, now: () => new Date().toISOString(), batchLimit: 20 } as never);
    let tag = '';
    const distribution: DistributionReadPort = {
      delivery: async () => [],
      outcomes: async (_b, utmCampaign) => ({ utmCampaign, readAt: new Date().toISOString(), buckets: tag ? [
        { utmContent: tag, leads: 4, qualified: 2, booked: 1, sold: 0, customers: 0, subscriptionsCancelled: 0, firstAt: '2026-11-04T10:12:00.000Z', lastAt: '2026-11-08T16:40:00.000Z' },
        { utmContent: 'concept-1', leads: 1, qualified: 0, booked: 0, sold: 0, customers: 0, subscriptionsCancelled: 0, firstAt: '2026-11-05T09:00:00.000Z', lastAt: '2026-11-05T09:00:00.000Z' }] : [] }),
    };
    const studio = new CreativeStudioService({ library: new MemoryCreativeLibraryStore(), brands: f.blogs, renderer,
      creators: { get: (b, id) => f.store.get(b, id), list: (b) => f.store.list(b) }, distribution });
    const service: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => engine, socialCallback: async () => null, creativeEnabled: true, creativeFor: () => studio, creativeSavedImages: async () => [] };
    const { server, origin } = await serve(service, { sessionToken: `token-${f.actor}`, userId: f.actor, workspaceId: f.brand.id, userEmail: 'owner@example.test' });
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    try {
      await page.goto(`${origin}/portal/seo-blog/b/${f.brand.id}/campaigns`);
      const form = page.locator('form:has(input[name=kind][value=acquisition])');
      await form.locator('input[name=name]').fill('Spring maintenance enquiries');
      await form.locator('textarea[name=goal]').fill('Help homeowners take a calm first step towards a maintenance enquiry.');
      await Promise.all([page.waitForURL(/\/campaigns\/[0-9a-f-]{36}/u), form.locator('button[type=submit]').click()]);
      const campaignUrl = page.url();
      await Promise.all([page.waitForURL(/\/creative\?/u), page.locator('a:text("Create artwork for this concept")').first().click()]);
      await Promise.all([page.waitForURL(/\/creative\/s\/[0-9a-f-]{36}/u, { timeout: 120_000 }), page.locator('form[action$="/creative/draft"] button[type=submit]').click()]);
      const fig = page.locator('figure.art').filter({ has: page.locator('form[action$="/approve"]') }).first();
      await Promise.all([page.waitForURL(/#v-/u), fig.locator('form[action$="/approve"] button').click()]);
      const approved = page.locator('figure.art:has(details:has(summary:text("Hand off")))').first();
      await approved.locator('summary:text("Hand off")').click();
      const option = await approved.locator('select[name=target] option[value^="acq:"]').first().getAttribute('value');
      await approved.locator('select[name=target]').selectOption(option!);
      await Promise.all([page.waitForURL(/#distribution/u), approved.locator('form[action$="/handoff"] button').click()]);
      const linkText = await page.locator('.dist p.link-out strong').first().innerText();
      tag = new URL(linkText).searchParams.get('utm_content')!;
      await page.reload();
      await page.locator('#distribution').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, '04-distribution-tracked-link-synthetic-crm.png'), fullPage: true });
      await page.goto(campaignUrl);
      await page.locator('h2:text("Actual results")').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, '05-actual-results-synthetic-crm.png'), fullPage: true });
      report.trackedLink = linkText;
    } finally { server.close(); }
  }
  console.log(JSON.stringify({ out, ...report }, null, 2));
} finally { await browser.close(); }
