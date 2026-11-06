/**
 * WordPress destination type: capability extension, signing, brand pairing and a full
 * engine journey (structure approval → automatic target → exact-version approval →
 * scheduled publication → independent public evidence) against an in-memory model of
 * the Relaunch72 Publisher & SEO plugin. The real plugin is proven separately in
 * disposable WordPress by test/manual-wordpress-plugin.e2e.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { ContentApiPublisher } from '../src/seo-blog/publishers/content-api.js';
import { GithubStaticPublisher } from '../src/seo-blog/publishers/github-static.js';
import { WordPressPublisher, wordpressSignature } from '../src/seo-blog/publishers/wordpress.js';
import type { PublisherRegistry, } from '../src/seo-blog/publishers/registry.js';
import type { WebsitePublisher } from '../src/seo-blog/publishers/types.js';
import { articleUrlMatches, parseWebsiteCapabilities, websiteIdentity, websiteSha, WORDPRESS_URL_CONTRACT } from '../src/seo-blog/website-target.js';
import { observeMembership } from '../src/seo-blog/website-delivery.js';
import type { DestinationType } from '../src/seo-blog/types.js';
import { harness, OWNER, seedBrandSite } from './seo-blog-fixtures.js';
import { websiteCaps } from './seo-blog-website-fixtures.js';

const ORIGIN = 'https://pi.example';
const KEY = `r72wp_${'a'.repeat(64)}`;

function wpCaps(origin = ORIGIN, overrides: Record<string, unknown> = {}) {
  const base = {
    contractVersion: 2, urlContract: WORDPRESS_URL_CONTRACT, siteId: websiteIdentity('wp-site', origin), publicOrigin: origin,
    roots: [{ id: 'investor-insights', path: 'investor-insights', indexUrl: `${origin}/investor-insights/`, articleUrlPattern: `${origin}/{slug}/`, categoryUrlPattern: `${origin}/category/{slug}/` }],
    taxonomy: { mode: 'categories', maxCategoriesPerArticle: 3 }, sitemaps: [`${origin}/sitemap_index.xml`], updates: { preservePublishedUrl: true }, repair: { sitemap: false }, ...overrides,
  };
  return { ...base, capabilitiesSha: websiteSha(base) };
}

/** In-memory model of the plugin's signed contract (see wordpress-plugin/relaunch72-publisher). */
class FakeWordPress {
  pairing: { brand: string; destination: string } | null = null;
  paused = false;
  holds: { code: string; message: string }[] = [];
  caps = wpCaps();
  readonly payloads: Record<string, any>[] = [];
  readonly posts = new Map<string, { payload: Record<string, any>; sha: string }>();
  constructor(readonly secret = KEY) {}
  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url); const h = init.headers as Record<string, string>; const body = typeof init.body === 'string' ? init.body : '';
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    if (h['x-r72-signing'] !== 'path-query-1' || h['x-r72-signature'] !== wordpressSignature(this.secret, h['x-r72-timestamp']!, init.method ?? 'GET', `${u.pathname}${u.search}`, body)) return json(401, { code: 'r72_bad_signature' });
    if (u.pathname.endsWith('/status') && u.searchParams.get('check')) {
      const brand = u.searchParams.get('brand')!; const destination = u.searchParams.get('destination')!;
      if (this.pairing && (this.pairing.brand !== brand || this.pairing.destination !== destination)) return json(403, { code: 'r72_other_brand', error: 'paired elsewhere' });
      this.pairing ??= { brand, destination };
      return json(200, { ok: true, protocol: 'r72-wordpress-1', plugin: { version: '1.0.0' }, wordpress: { version: '6.9', supported: true, writesPaused: this.paused, seo: { mode: 'rank_math', provider: 'Rank Math 1.0.281' }, sitemap: { owner: 'rank_math' } }, holds: this.holds, ...(this.holds.length ? {} : { capabilities: this.caps }) });
    }
    if (u.pathname.endsWith('/status')) {
      const stored = this.posts.get(u.searchParams.get('article')!);
      if (!stored) return json(200, { state: 'absent' });
      return json(200, { state: stored.payload.versionId === u.searchParams.get('version') ? 'present' : 'other_version', ref: `wp-post:7:${stored.payload.versionId}`, canonicalUrl: stored.payload.canonicalUrl, contractVersion: 2, target: stored.payload.target, payloadSha: stored.sha });
    }
    const p = JSON.parse(body); this.payloads.push(p);
    if (this.paused) return json(409, { status: 'paused', error: 'paused' });
    if (p.wordpress?.brandId !== this.pairing?.brand) return json(403, { code: 'r72_other_brand', error: 'other brand' });
    if (p.target?.capabilitiesSha !== this.caps.capabilitiesSha) return json(409, { code: 'r72_capabilities_changed', error: 'Capabilities changed since review. Nothing was changed.' });
    const existing = this.posts.get(p.articleId);
    if (existing && existing.payload.versionNumber > p.versionNumber) return json(409, { status: 'superseded', error: 'newer' });
    if (existing?.payload.versionId === p.versionId) return json(200, { status: 'already_present', ref: `wp-post:7:${p.versionId}` });
    this.posts.set(p.articleId, { payload: p, sha: createHash('sha256').update(body).digest('hex') });
    return json(201, { status: 'published', ref: `wp-post:7:${p.versionId}` });
  };
  /** Public pages as WordPress serves them, including /page/2/ pagination on the posts index. */
  serve() {
    return (url: string) => {
      const posts = [...this.posts.values()].map((p) => p.payload);
      for (const p of posts) if (url === p.canonicalUrl) return { body: `<html><head><link rel="canonical" href="${p.canonicalUrl}"><meta name="description" content="d"><meta name="robots" content="index, follow"><meta name="r72-blog-version" content="${p.marker}"></head><body>${p.articleHtml}${p.target.categories.filter((c: any) => p.target.categoryIds.includes(c.id)).map((c: any) => `<a href="${ORIGIN}/category/${c.slug}/">${c.label}</a>`).join('')}</body></html>` };
      if (url === `${ORIGIN}/investor-insights/`) return { body: `<html><head><link rel="next" href="${ORIGIN}/investor-insights/page/2/"></head><body><a href="${ORIGIN}/older-human-post/">Older</a></body></html>` };
      if (url === `${ORIGIN}/investor-insights/page/2/`) return { body: `<html><head></head><body>${posts.map((p) => `<a href="${p.canonicalUrl}">${p.title}</a>`).join('')}</body></html>` };
      const cat = /^https:\/\/pi\.example\/category\/([a-z0-9-]+)\/$/.exec(url);
      if (cat) return { body: `<html><head></head><body>${posts.filter((p) => p.target.categories.some((c: any) => c.slug === cat[1] && p.target.categoryIds.includes(c.id))).map((p) => `<a href="${p.canonicalUrl}">${p.title}</a>`).join('')}</body></html>` };
      if (url === `${ORIGIN}/sitemap_index.xml`) return { contentType: 'application/xml', body: `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${ORIGIN}/post-sitemap.xml</loc></sitemap></sitemapindex>` };
      if (url === `${ORIGIN}/post-sitemap.xml`) return { contentType: 'application/xml', body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${posts.map((p) => `<url><loc>${p.canonicalUrl}</loc></url>`).join('')}</urlset>` };
      return null;
    };
  }
}

function wpHarness() {
  const h = harness(); const wp = new FakeWordPress(); h.web.dynamic.push(wp.serve()); seedBrandSite(h.web, ORIGIN, 'investor');
  const publishers: PublisherRegistry = new Map<DestinationType, WebsitePublisher>([
    ['github_static', new GithubStaticPublisher(h.github.fetch, 1000)],
    ['content_api', new ContentApiPublisher(h.site.fetch, 1000, () => h.clock.ms)],
    ['wordpress', new WordPressPublisher(wp.fetch, 1000, () => h.clock.ms)],
  ]);
  const engine = new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers, vault: h.vault, now: h.clock.now, batchLimit: 20 });
  return { h, wp, engine };
}

async function connectedBrand(engine: SeoBlogEngine, name = 'Prop Invest Fixture') {
  const { brand } = await engine.createBrand(OWNER, { commandId: randomUUID(), name, website: ORIGIN });
  await engine.updateSettings(OWNER, brand.id, brand.rowVersion, { budgets: { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 100, imagesPerMonth: 0 } });
  await engine.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'Facts', pastedText: 'Fixture facts only. Capital at risk.' });
  const profile = await engine.extractBrandProfile(OWNER, brand.id); await engine.confirmProfile(OWNER, brand.id, profile.version);
  const destination = await engine.connectDestination(OWNER, brand.id, { type: 'wordpress', label: 'WordPress', credential: KEY, config: { siteUrl: ORIGIN } });
  return { brand, destination };
}

test('WordPress URL extension is opt-in and versioned; strict v2 consumers are unchanged', () => {
  const caps = wpCaps();
  assert.throws(() => parseWebsiteCapabilities(caps, ORIGIN, 'now'), /URL contract this connection type does not support/);
  const receipt = parseWebsiteCapabilities(caps, ORIGIN, 'now', { urlContract: WORDPRESS_URL_CONTRACT });
  assert.ok(receipt.protocol === 'v2'); assert.equal(receipt.capabilities.urlContract, WORDPRESS_URL_CONTRACT);
  assert.equal(receipt.capabilities.roots[0]!.articleUrlPattern, `${ORIGIN}/{slug}/`);
  const strict = websiteCaps(); const parsed = parseWebsiteCapabilities(strict, 'https://bay.example', 'now', { urlContract: WORDPRESS_URL_CONTRACT });
  assert.ok(parsed.protocol === 'v2'); assert.equal(parsed.capabilities.urlContract, undefined, 'strict caps never gain the extension');
  assert.throws(() => parseWebsiteCapabilities({ ...caps, urlContract: 'wordpress-permalinks-2' }, ORIGIN, 'now', { urlContract: WORDPRESS_URL_CONTRACT }));
  const root = caps.roots[0]!;
  for (const bad of [
    { ...root, articleUrlPattern: 'https://foreign.example/{slug}/' }, { ...root, articleUrlPattern: `${ORIGIN}/{slug}/{slug}/` }, { ...root, articleUrlPattern: `${ORIGIN}/%year%/{slug}/` },
    { ...root, articleUrlPattern: `${ORIGIN}/{slug}/?x=1` }, { ...root, categoryUrlPattern: `${ORIGIN}/{slug}/` }, { ...root, categoryUrlPattern: `${ORIGIN}/category/{slug}` },
    { ...root, indexUrl: 'https://foreign.example/investor-insights/' }, { ...root, indexUrl: `${ORIGIN}/investor-insights/?p=1` }, { ...root, articleUrlPattern: `${ORIGIN}/../{slug}/` },
  ]) assert.throws(() => parseWebsiteCapabilities(wpCaps(ORIGIN, { roots: [bad] }), ORIGIN, 'now', { urlContract: WORDPRESS_URL_CONTRACT }), Error, JSON.stringify(bad));
  const prefixed = wpCaps(ORIGIN, { roots: [{ ...root, articleUrlPattern: `${ORIGIN}/blog/{slug}`, categoryUrlPattern: `${ORIGIN}/blog/category/{slug}` }] });
  const r2 = parseWebsiteCapabilities(prefixed, ORIGIN, 'now', { urlContract: WORDPRESS_URL_CONTRACT }); assert.ok(r2.protocol === 'v2');
  assert.equal(articleUrlMatches(r2.capabilities.roots[0]!, `${ORIGIN}/blog/a-post`), true);
  assert.equal(articleUrlMatches(r2.capabilities.roots[0]!, `${ORIGIN}/blog/a-post/`), false);
  assert.equal(articleUrlMatches(r2.capabilities.roots[0]!, `${ORIGIN}/blog/a/post`), false);
});

test('WordPress config: same-site plugin endpoint only; plain ?rest_route= and foreign endpoints refused', () => {
  const p = new WordPressPublisher(async () => new Response('{}'));
  assert.equal(p.validateConfig({ siteUrl: ORIGIN }).config.endpoint, `${ORIGIN}/wp-json/relaunch72/v1/publish`);
  assert.equal(p.validateConfig({ siteUrl: ORIGIN, endpoint: `${ORIGIN}/wp/wp-json/relaunch72/v1/publish` }).config.endpoint, `${ORIGIN}/wp/wp-json/relaunch72/v1/publish`);
  assert.throws(() => p.validateConfig({ siteUrl: 'http://pi.example' }));
  assert.throws(() => p.validateConfig({ siteUrl: ORIGIN, endpoint: 'https://other.example/wp-json/relaunch72/v1/publish' }));
  assert.throws(() => p.validateConfig({ siteUrl: ORIGIN, endpoint: `${ORIGIN}/?rest_route=/relaunch72/v1/publish` }));
  assert.throws(() => p.validateConfig({ siteUrl: ORIGIN, endpoint: `${ORIGIN}/wp-json/wp/v2/posts` }));
});

test('WordPress archive pagination is followed only in WordPress mode and only within the same archive', async () => {
  const pages: Record<string, string> = {
    'https://pi.example/investor-insights/': '<html><head><link rel="next" href="https://pi.example/investor-insights/page/2/"></head><body></body></html>',
    'https://pi.example/investor-insights/page/2/': '<html><head></head><body><a href="https://pi.example/post/">x</a></body></html>',
  };
  const transport = { fetch: async (url: string) => ({ url, finalUrl: url, status: pages[url] ? 200 : 404, contentType: 'text/html', body: Buffer.from(pages[url] ?? ''), truncated: false, headers: {} }) };
  assert.equal((await observeMembership(transport, 'https://pi.example/investor-insights/', 'https://pi.example/post/', 'now')).state, 'incomplete');
  assert.equal((await observeMembership(transport, 'https://pi.example/investor-insights/', 'https://pi.example/post/', 'now', 10, 'wordpress')).state, 'verified');
  pages['https://pi.example/investor-insights/'] = '<html><head><link rel="next" href="https://pi.example/other-archive/page/2/"></head><body></body></html>';
  assert.equal((await observeMembership(transport, 'https://pi.example/investor-insights/', 'https://pi.example/post/', 'now', 10, 'wordpress')).state, 'incomplete');
});

test('full engine journey to WordPress: pairing, automatic reviewed target, exact-version approval, publication and independent evidence', async () => {
  const { h, wp, engine } = wpHarness();
  const { brand, destination } = await connectedBrand(engine);
  assert.equal(destination.status, 'connected', destination.statusDetail);
  assert.ok(destination.websiteCapability?.protocol === 'v2' && destination.websiteCapability.capabilities.urlContract === WORDPRESS_URL_CONTRACT);
  assert.match(destination.statusDetail, /Rank Math/);
  assert.deepEqual(wp.pairing, { brand: brand.id, destination: destination.id });
  const inventory = await engine.refreshInventory(brand.id);
  const current = await engine.getBrand(OWNER, brand.id);
  await engine.approveEditorialStructure(OWNER, brand.id, { rowVersion: current.rowVersion, scanId: inventory.editorial!.scanId, scanSha: inventory.editorial!.scanSha, destinationId: destination.id, root: '/investor-insights', categories: [{ id: inventory.editorial!.categories[0]!.id, label: 'Investor Education', slug: 'investor-education' }] });
  await engine.requestPlan(OWNER, brand.id, { commandId: randomUUID() }); await engine.tick('wp-plan');
  const [plan] = await engine.listPlans(OWNER, brand.id); await engine.acceptPlan(OWNER, brand.id, plan!.plan.id);
  await engine.requestArticles(OWNER, brand.id, [plan!.briefs[0]!.id]); await engine.tick('wp-write');
  const [detail] = await engine.listArticles(OWNER, brand.id); const articleId = detail!.article.id;
  let a = await engine.getArticle(OWNER, brand.id, articleId); const v = a.version!;
  assert.equal(v.websiteTarget!.target.rootId, 'investor-insights');
  assert.equal(v.websiteTarget!.target.canonicalUrl, `${ORIGIN}/${v.body.slug}/`);
  assert.equal(wp.payloads.length, 0, 'connection check, planning and writing publish nothing');
  await engine.approve(OWNER, brand.id, articleId, v.id); a = await engine.getArticle(OWNER, brand.id, articleId);
  await engine.schedule(OWNER, brand.id, articleId, a.article.rowVersion, { localDate: '2026-11-03', localTime: '09:00', destinationId: destination.id });
  h.clock.set('2026-11-03T09:00:01Z'); await engine.tick('wp-publish');
  a = await engine.getArticle(OWNER, brand.id, articleId);
  assert.equal(a.article.delivery, 'published'); assert.equal(a.article.publishedUrl, `${ORIGIN}/${v.body.slug}/`);
  const sent = wp.payloads[0]!;
  assert.equal(sent.contractVersion, 2); assert.equal(sent.wordpress.protocol, 'r72-wordpress-1'); assert.equal(sent.wordpress.brandId, brand.id); assert.equal(sent.wordpress.destinationId, destination.id);
  assert.equal(sent.versionId, v.id); assert.equal(sent.canonicalUrl, `${ORIGIN}/${v.body.slug}/`);
  const publication = (await h.store.listPublications(brand.id, articleId)).find((p) => p.state === 'published')!;
  assert.equal(publication.websiteDelivery!.article.state, 'verified');
  assert.equal(publication.websiteDelivery!.index.state, 'verified', 'article found on /investor-insights/page/2/');
  assert.equal(publication.websiteDelivery!.sitemap.state, 'verified');
  assert.equal(publication.websiteDelivery!.article.seoHead?.canonical, 1);
});

test('a WordPress site paired to one brand refuses a second brand; holds and pause are reported, not hidden', async () => {
  const { wp, engine } = wpHarness();
  const first = await connectedBrand(engine, 'Prop Invest Fixture');
  assert.equal(first.destination.status, 'connected');
  const second = await connectedBrand(engine, 'Key Properties Fixture');
  assert.equal(second.destination.status, 'failed'); assert.match(second.destination.statusDetail, /different Relaunch72 brand/);
  wp.holds = [{ code: 'seo_hold', message: 'More than one SEO plugin is active (Yoast SEO, Rank Math).' }];
  const held = await engine.checkDestination(OWNER, first.brand.id, first.destination.id);
  assert.equal(held.status, 'failed'); assert.match(held.statusDetail, /on hold: More than one SEO plugin/);
  wp.holds = []; wp.paused = true;
  const paused = await engine.checkDestination(OWNER, first.brand.id, first.destination.id);
  assert.equal(paused.status, 'connected'); assert.match(paused.statusDetail, /PAUSED/);
});

test('content-API destinations still refuse a WordPress URL extension (existing consumers unchanged)', async () => {
  const h = harness(); h.site.capabilities = wpCaps('https://bay.example');
  const { brand } = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name: 'Bay', website: 'https://bay.example' });
  const d = await h.engine.connectDestination(OWNER, brand.id, { type: 'content_api', label: 'Website', credential: 'x'.repeat(40), config: { endpoint: 'https://bay.example/api/blog/publish', publicBaseUrl: 'https://bay.example', blogPath: 'blog' } });
  assert.equal(d.status, 'failed'); assert.match(d.statusDetail, /URL contract/);
});

test('portal setup offers WordPress through the existing secure connection form and shows readiness without secrets', async () => {
  const { setupPage } = await import('../src/portal/seo-blog-view.js');
  const { engine } = wpHarness();
  const { brand, destination } = await connectedBrand(engine);
  const { sealedCredential: _sealed, ...visible } = destination;
  const html = setupPage({ brand, brands: [brand], tab: 'setup', csrf: 'fixture', notice: null, error: null }, { documents: [], profile: null, inventory: null, destinations: [visible], publishers: [new WordPressPublisher(async () => new Response('{}'))], vaultReady: true });
  assert.match(html, /Connect: WordPress \(Relaunch72 Publisher &amp; SEO plugin\)/);
  assert.match(html, /<input type="hidden" name="type" value="wordpress">/);
  assert.match(html, /name="cfg_siteUrl"/);
  assert.match(html, /<input id="dc-wordpress" name="credential" type="password" autocomplete="off" required>/);
  assert.match(html, /Connected<\/span> <span class="muted">WordPress 6\.9 verified/);
  assert.doesNotMatch(html, new RegExp(KEY));
  assert.doesNotMatch(html, /sealedCredential/);
});
