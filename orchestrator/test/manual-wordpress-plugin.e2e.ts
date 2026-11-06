/**
 * MANUAL end-to-end proof: the real RL72 WordPressPublisher + public evidence code
 * against a DISPOSABLE WordPress (WordPress Playground) running the real
 * Relaunch72 Publisher & SEO plugin. Not part of `npm test` (no live WordPress there).
 *
 *   WP_E2E_BASE=http://127.0.0.1:9400 WP_E2E_TOKEN=... \
 *   node --import ./test/windows-node24-shim.mjs --import tsx --test test/manual-wordpress-plugin.e2e.ts
 *
 * The harness serves the site as https://wp.test; this driver maps that origin onto
 * WP_E2E_BASE. It never contacts a real website and publishes only disposable fixtures.
 * WP_E2E_SCENARIO selects: standalone (default) | rank_math | yoast | hold.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { WordPressPublisher } from '../src/seo-blog/publishers/wordpress.js';
import { PublisherOutcomeUnknownError, PublisherRejectedError, type PublishInput } from '../src/seo-blog/publishers/types.js';
import { websiteSha, type ArticleWebsiteTarget } from '../src/seo-blog/website-target.js';
import { observeWebsiteDelivery } from '../src/seo-blog/website-delivery.js';
import { versionMarker } from '../src/seo-blog/render.js';
import type { ArticleBody, Destination } from '../src/seo-blog/types.js';
import type { FetchTransport } from '../src/seo-blog/safe-fetch.js';

const BASE = process.env.WP_E2E_BASE ?? 'http://127.0.0.1:9400';
const TOKEN = process.env.WP_E2E_TOKEN ?? 'harness-token-0123456789';
const SCENARIO = process.env.WP_E2E_SCENARIO ?? 'standalone';
const ORIGIN = 'https://wp.test';
const HERO_SHA = '91c745dcf86f0e6cf796bbcaa0ab365b9f534204fe0574b23657aaa2be13d7bc';
const HERO = `https://app.relaunch72.com/api/public/seo-blog/media/${'1'.repeat(8)}-1111-4111-8111-${'1'.repeat(12)}/${HERO_SHA}.png`;
const map = (url: string) => url.startsWith(ORIGIN) ? BASE + url.slice(ORIGIN.length) : url;
let dropNextResponse = false;
const wpFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  const res = await fetch(map(url), init);
  if (dropNextResponse) { dropNextResponse = false; await res.arrayBuffer(); throw new TypeError('simulated lost acknowledgement'); }
  return res;
};
const transport: FetchTransport = {
  async fetch(url) {
    const res = await fetch(map(url), { redirect: 'manual' });
    const body = Buffer.from(await res.arrayBuffer());
    const location = res.headers.get('location');
    return { url, finalUrl: location ? location.replace(BASE, ORIGIN) : url, status: res.status, contentType: res.headers.get('content-type') ?? '', body, truncated: false, headers: {} };
  },
};
async function control(op: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${BASE}/?rest_route=/r72test/v1/do`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-token': TOKEN }, body: JSON.stringify({ op, ...args }) });
  const json = await res.json();
  if (!res.ok) throw new Error(`control ${op}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const publisher = new WordPressPublisher(wpFetch, 60_000);
const brandId = randomUUID(); const destinationId = randomUUID();
let secret = '';
let destination: Destination;
function makeDestination(cap?: Destination['websiteCapability']): Destination {
  const v = publisher.validateConfig({ siteUrl: ORIGIN });
  return { id: destinationId, brandId, type: 'wordpress', label: 'Disposable WP', config: v.config, sealedCredential: 'sealed', publicBaseUrl: v.publicBaseUrl, status: 'connected', statusDetail: '', checkedAt: null, createdAt: new Date().toISOString(), ...(cap ? { websiteCapability: cap } : {}) };
}
function body(slug: string, title: string, withImage = true): ArticleBody {
  return {
    title, seoTitle: `${title} | Disposable`, metaDescription: `Disposable test description for ${slug}.`, excerpt: `Excerpt for ${slug}.`, slug,
    intro: `Intro paragraph with a cited fact [src:s1].`, sections: [{ id: 's-1', heading: 'Section heading', body: 'Body text with **bold** and a [link](https://example.org/ref).' }],
    conclusion: 'Conclusion.', cta: null, faqs: [{ q: 'Question?', a: 'Answer.' }],
    citations: [{ sourceId: 's1', url: 'https://www.gov.uk/example-source', title: 'Example public source', retrievedAt: '2026-11-01T00:00:00Z', passage: 'p', public: true } as never, { sourceId: 's2', url: 'https://private.example/notes', title: 'Private research', retrievedAt: '2026-11-01T00:00:00Z', passage: 'p', public: false } as never],
    image: withImage ? { kind: 'generated', url: HERO, alt: 'Disposable hero alt text', provenance: 'fixture', width: 64, height: 40 } : { kind: 'none', url: null, alt: '', provenance: '', width: null, height: null },
    author: { name: 'Fixture Author' },
  };
}
const categoryId = randomUUID();
function target(slug: string, b: ArticleBody, categorySlug = 'investor-education'): ArticleWebsiteTarget {
  const cap = destination.websiteCapability!; if (cap.protocol !== 'v2') throw new Error('no v2');
  const c = cap.capabilities; const root = c.roots[0]!;
  const base = { schema: 1 as const, origin: 'owner_review' as const, destinationId, brandName: 'Disposable Brand', locale: 'en-GB', contractVersion: 2 as const,
    target: { siteId: c.siteId, capabilitiesSha: c.capabilitiesSha, rootId: root.id, rootPath: root.path, canonicalUrl: root.articleUrlPattern.replace('{slug}', slug), indexUrl: root.indexUrl, structureId: randomUUID(), structureRevision: 1, structureSha: 'b'.repeat(64), categories: [{ id: categoryId, slug: categorySlug, label: 'Investor Education' }], categoryIds: [categoryId] },
    categoryUrls: [root.categoryUrlPattern.replace('{slug}', categorySlug)], sitemapUrls: c.sitemaps };
  return { ...base, deliverySha: websiteSha({ body: b, ...base }) };
}
function input(articleId: string, versionNumber: number, b: ArticleBody, t: ArticleWebsiteTarget, versionId = randomUUID()): PublishInput {
  return { operationId: randomUUID(), destination, credential: secret, brandName: 'Disposable Brand', locale: 'en-GB', articleId, versionId, contentSha: createHash('sha256').update(JSON.stringify(b) + versionId).digest('hex'), versionNumber, body: b, publishedAt: new Date().toISOString(), websiteTarget: t };
}
const rejected = async (p: Promise<unknown>, re: RegExp) => { await assert.rejects(p, (e: unknown) => e instanceof PublisherRejectedError && re.test((e as Error).message)); };
async function headOf(url: string) { const page = await transport.fetch(url); return page.body.toString('utf8'); }
const count = (html: string, re: RegExp) => (/<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html.replace(/<!--[\s\S]*?-->/g, ''))?.[1]!.match(re) ?? []).length;

test(`Relaunch72 Publisher & SEO — disposable WordPress e2e (${SCENARIO})`, async (t) => {
  if (SCENARIO === 'rank_math') await control('plugins', { deactivate: ['wordpress-seo/wp-seo.php'], activate: ['seo-by-rank-math/rank-math.php'] });
  if (SCENARIO === 'yoast') await control('plugins', { deactivate: ['seo-by-rank-math/rank-math.php'], activate: ['wordpress-seo/wp-seo.php'] });
  if (SCENARIO === 'hold') await control('plugins', { activate: ['seo-by-rank-math/rank-math.php', 'wordpress-seo/wp-seo.php'] });
  if (SCENARIO === 'standalone' || SCENARIO === 'lifecycle') await control('plugins', { deactivate: ['seo-by-rank-math/rank-math.php', 'wordpress-seo/wp-seo.php'] }).catch(() => undefined);
  secret = (await control('rotate')).secret;
  destination = makeDestination();

  await t.test('wrong key and malformed key are refused; nothing is published by a check', async () => {
    const before = await control('count');
    assert.equal((await publisher.checkConnection(destination, 'r72wp_' + '0'.repeat(64))).ok, false);
    assert.equal((await publisher.checkConnection(destination, 'not-a-key')).ok, false);
    assert.deepEqual(await control('count'), before);
  });

  if (SCENARIO === 'hold') {
    await t.test('two active SEO plugins: connection check reports a hold, never capabilities', async () => {
      const r = await publisher.checkConnection(destination, secret);
      assert.equal(r.ok, false); assert.match(r.detail, /More than one SEO plugin/); assert.equal(r.websiteCapability, undefined);
    });
    await control('plugins', { deactivate: ['seo-by-rank-math/rank-math.php', 'wordpress-seo/wp-seo.php'] });
    return;
  }

  await t.test('signed check verifies, pairs this brand and advertises the declared WordPress URLs', async () => {
    const r = await publisher.checkConnection(destination, secret);
    assert.equal(r.ok, true, r.detail);
    assert.ok(r.websiteCapability && r.websiteCapability.protocol === 'v2');
    const c = r.websiteCapability.capabilities;
    assert.equal(c.urlContract, 'wordpress-permalinks-1');
    assert.deepEqual(c.roots[0], { id: 'investor-insights', path: 'investor-insights', indexUrl: `${ORIGIN}/investor-insights/`, articleUrlPattern: `${ORIGIN}/{slug}/`, categoryUrlPattern: `${ORIGIN}/category/{slug}/` });
    assert.match(r.detail, SCENARIO === 'standalone' || SCENARIO === 'lifecycle' ? /standalone/ : SCENARIO === 'rank_math' ? /rank_math/ : /yoast/);
    destination = makeDestination(r.websiteCapability);
  });

  await t.test('another brand cannot use the same site, even with the key', async () => {
    const other = { ...destination, brandId: randomUUID() };
    const r = await publisher.checkConnection(other, secret);
    assert.equal(r.ok, false); assert.match(r.detail, /different Relaunch72 brand/);
  });

  const articleId = randomUUID(); const slug = `fixture-${SCENARIO.replace(/_/g, "-")}-${Date.now().toString(36)}`;
  const b1 = body(slug, 'Fixture article one'); const t1 = target(slug, b1);
  let postId = 0; let v1: PublishInput;

  await t.test('exact-version delivery: post, featured image, alt, category, marker, SEO', async () => {
    v1 = input(articleId, 1, b1, t1);
    const out = await publisher.publish(v1);
    assert.equal(out.status, 'accepted'); assert.equal(out.publicUrl, `${ORIGIN}/${slug}/`);
    postId = Number(/^wp-post:(\d+):/.exec(out.providerRef)![1]);
    const p = await control('post', { post: postId });
    assert.equal(p.post.post_status, 'publish'); assert.equal(p.permalink, `${ORIGIN}/${slug}/`);
    assert.deepEqual(p.cats, ['investor-education']); assert.ok(p.thumb > 0);
    assert.equal(p.meta._r72_marker, versionMarker(articleId, v1.versionId, v1.contentSha));
    assert.match(p.post.post_content, /example-source/); assert.doesNotMatch(p.post.post_content, /private\.example/);
    if (SCENARIO === 'rank_math') { assert.equal(p.meta.rank_math_title, b1.seoTitle); assert.equal(p.meta.rank_math_description, b1.metaDescription); }
    if (SCENARIO === 'yoast') { assert.equal(p.meta._yoast_wpseo_title, b1.seoTitle); assert.equal(p.meta._yoast_wpseo_metadesc, b1.metaDescription); }
    const thumb = await control('post', { post: p.thumb });
    assert.equal(thumb.meta._wp_attachment_image_alt, 'Disposable hero alt text');
  });

  if (SCENARIO === 'lifecycle') {
    await t.test('deactivation and uninstall keep posts, media and SEO data; only plugin settings are removed', async () => {
      const before = await control('count');
      await control('plugins', { deactivate: ['relaunch72-publisher/relaunch72-publisher.php'] });
      const off = await publisher.checkConnection(destination, secret);
      assert.equal(off.ok, false); assert.match(off.detail, /not found/);
      assert.equal((await transport.fetch(`${ORIGIN}/${slug}/`)).status, 200, 'post stays public while the plugin is inactive');
      assert.deepEqual(await control('count'), before);
      await control('plugins', { activate: ['relaunch72-publisher/relaunch72-publisher.php'] });
      assert.equal((await publisher.findExisting(v1)).state, 'present', 'reactivation resumes reconciliation');
      const removed = await control('uninstall');
      assert.deepEqual(removed.options, ['r72pub_site_id'], 'only the site identity survives uninstall');
      assert.equal(removed.managedMeta, before.managed);
      const after = await control('count'); assert.equal(after.posts, before.posts); assert.equal(after.attachments, before.attachments);
      assert.equal((await transport.fetch(`${ORIGIN}/${slug}/`)).status, 200, 'post stays public after uninstall');
    });
    return;
  }

  await t.test('public delivery evidence: article, index, category and sitemap verified independently', async () => {
    const evidence = await observeWebsiteDelivery(transport, { url: `${ORIGIN}/${slug}/`, marker: versionMarker(articleId, v1.versionId, v1.contentSha), indexUrl: t1.target.indexUrl, categoryUrls: t1.categoryUrls, sitemapUrls: t1.sitemapUrls, at: new Date().toISOString(), pagination: 'wordpress', seoHead: true });
    assert.equal(evidence.article.state, 'verified', evidence.article.detail);
    assert.equal(evidence.index.state, 'verified', evidence.index.detail);
    assert.equal(evidence.categories[0]!.state, 'verified', evidence.categories[0]!.detail);
    assert.equal(evidence.sitemap.state, 'verified', evidence.sitemap.detail);
    assert.equal(evidence.article.seoHead?.canonical, 1);
    assert.ok((evidence.article.seoHead?.robots ?? 0) <= 1); assert.ok((evidence.article.seoHead?.description ?? 0) === 1);
    const html = await headOf(`${ORIGIN}/${slug}/`);
    assert.equal(count(html, /<meta[^>]+name=["']r72-blog-version["']/gi), 1);
    assert.equal(count(html, /property=["']og:title["']/gi), 1);
    assert.ok(count(html, /application\/ld\+json/gi) >= 1);
    if (SCENARIO === 'standalone') {
      assert.match(html, /"@type":"Article"/); assert.match(html, /"citation"/); assert.doesNotMatch(html, /private\.example/);
    }
  });

  await t.test('retry of the same version is idempotent: no second post or media download', async () => {
    const before = await control('count');
    const again = await publisher.publish({ ...v1, operationId: randomUUID() });
    assert.equal(again.status, 'already_present');
    assert.deepEqual(await control('count'), before);
  });

  const b2 = { ...b1, intro: 'Updated intro [src:s1].' }; const t2 = target(slug, b2); let v2: PublishInput;
  await t.test('concurrent deliveries of a new version produce exactly one update', async () => {
    const before = await control('count');
    v2 = input(articleId, 2, b2, t2);
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => publisher.publish({ ...v2, operationId: i ? randomUUID() : v2.operationId })));
    const ok = results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ status: string }>).value.status);
    const unknown = results.filter((r) => r.status === 'rejected' && (r as PromiseRejectedResult).reason instanceof PublisherOutcomeUnknownError).length;
    assert.equal(ok.length + unknown, 6, JSON.stringify(results.map((r) => r.status === 'rejected' ? String((r as PromiseRejectedResult).reason) : 'ok')));
    assert.ok(ok.includes('accepted') || unknown > 0);
    assert.deepEqual(await control('count'), before);
    assert.equal((await publisher.findExisting(v2)).state, 'present');
    assert.equal((await control('post', { post: postId })).meta._r72_version_number, '2');
  });

  const b3 = { ...b1, intro: 'Third intro [src:s1].' }; const t3 = target(slug, b3); let v3: PublishInput;
  await t.test('lost acknowledgement: outcome unknown, then reconciliation proves delivery; no duplicate', async () => {
    v3 = input(articleId, 3, b3, t3);
    const before = await control('count');
    assert.equal((await publisher.findExisting(v3)).state, 'other_version');
    dropNextResponse = true;
    await assert.rejects(publisher.publish(v3), PublisherOutcomeUnknownError);
    const found = await publisher.findExisting(v3);
    assert.equal(found.state, 'present'); assert.match(found.providerRef!, new RegExp(`^wp-post:${postId}:`));
    const after = await control('count');
    assert.equal(after.posts, before.posts); assert.equal(after.attachments, before.attachments); assert.equal(after.managed, before.managed);
  });

  await t.test('stale version is refused without overwriting the newer one', async () => {
    await rejected(publisher.publish({ ...v2, operationId: randomUUID() }), /newer version/);
    assert.equal((await control('post', { post: postId })).meta._r72_version_number, '3');
  });

  await t.test('a manual WordPress edit holds later updates until an administrator releases it', async () => {
    await control('human_edit', { post: postId, field: 'post_content', value: '<p>Edited by a person in WordPress.</p>' });
    const b4 = { ...b1, intro: 'Fourth intro.' }; const v4 = input(articleId, 4, b4, target(slug, b4));
    await rejected(publisher.publish(v4), /edited in WordPress/);
    assert.match((await control('post', { post: postId })).post.post_content, /Edited by a person/);
    assert.equal((await publisher.findExisting(v3)).state, 'present');
    await control('human_meta', { post: postId, key: '_r72_allow_overwrite', value: '1' });
    assert.equal((await publisher.publish({ ...v4, operationId: randomUUID() })).status, 'accepted');
    assert.match((await control('post', { post: postId })).post.post_content, /Fourth intro/);
  });

  if (SCENARIO !== 'standalone') {
    await t.test('a person’s change to an SEO-plugin field is preserved on the next update', async () => {
      const key = SCENARIO === 'rank_math' ? 'rank_math_description' : '_yoast_wpseo_metadesc';
      await control('human_meta', { post: postId, key, value: 'Human-written description.' });
      const b5 = { ...b1, intro: 'Fifth intro.', metaDescription: 'RL72 new description.' }; const v5 = input(articleId, 5, b5, target(slug, b5));
      assert.equal((await publisher.publish(v5)).status, 'accepted');
      const p = await control('post', { post: postId });
      assert.equal(p.meta[key], 'Human-written description.');
      assert.match(String(p.meta._r72_seo_preserved), new RegExp(key));
      const html = await headOf(`${ORIGIN}/${slug}/`);
      assert.equal(count(html, /<link[^>]+rel=["']canonical["']/gi), 1);
      assert.equal(count(html, /<meta[^>]+name=["']description["']/gi), 1);
      assert.equal(count(html, /<meta[^>]+name=["']robots["']/gi), 1);
    });
  }

  await t.test('an explicit noindex/nofollow article is served with exactly one robots policy', async () => {
    const s = `noindex-${Date.now().toString(36)}`; const bn = body(s, 'Noindex fixture', false); const vn = input(randomUUID(), 1, bn, target(s, bn));
    const original = publisher.payload.bind(publisher);
    (publisher as unknown as { payload: (i: PublishInput) => string }).payload = (i) => { const p = JSON.parse(original(i)); p.wordpress.robots = { index: false, follow: false }; return JSON.stringify(p); };
    try { assert.equal((await publisher.publish(vn)).status, 'accepted'); } finally { (publisher as unknown as { payload: typeof original }).payload = original; }
    const html = await headOf(`${ORIGIN}/${s}/`);
    assert.equal(count(html, /<meta[^>]+name=["']robots["']/gi), 1);
    assert.match(html, /<meta[^>]+name=["']robots["'][^>]*noindex/i); assert.match(html, /<meta[^>]+name=["']robots["'][^>]*nofollow/i);
  });

  await t.test('an unrelated human post with the same slug is never adopted or overwritten', async () => {
    const humanSlug = `human-${Date.now().toString(36)}`;
    const human = await control('human_post', { title: 'Human post', slug: humanSlug });
    const bh = body(humanSlug, 'Collision', false);
    await rejected(publisher.publish(input(randomUUID(), 1, bh, target(humanSlug, bh))), /did not create/);
    const p = await control('post', { post: human.id });
    assert.equal(p.post.post_content, 'Human post'); assert.equal(p.meta._r72_article_id, undefined);
  });

  await t.test('local stop switch refuses writes but keeps reconciliation available', async () => {
    await control('settings', { value: { paused: true } });
    try {
      const bp = body(`paused-${Date.now().toString(36)}`, 'Paused', false);
      await rejected(publisher.publish(input(randomUUID(), 1, bp, target(bp.slug, bp))), /paused/i);
      assert.equal((await publisher.findExisting(v3)).state, 'other_version');
      assert.equal((await publisher.checkConnection(destination, secret)).ok, true);
    } finally { await control('settings', { value: { paused: false } }); }
  });

  await t.test('media is restricted to validated sources; tampering and redirects are refused', async () => {
    const before = await control('count');
    const bad = async (url: string, re: RegExp) => { const s = `media-${Math.random().toString(36).slice(2, 8)}`; const bm = { ...body(s, 'Media'), image: { ...body(s, 'Media').image, url } }; await rejected(publisher.publish(input(randomUUID(), 1, bm, target(s, bm))), re); };
    await bad(`https://evil.example/${HERO_SHA}.png`, /approved media source/);
    await bad(HERO.replace('/media/', '/media/tamper/'), /does not match the digest/);
    await bad(HERO.replace('/media/', '/media/redirect/'), /redirects are not followed/);
    const s = `media-down-${Date.now().toString(36)}`; const bd = { ...body(s, 'Down'), image: { ...body(s, 'Down').image, url: HERO.replace('/media/', '/media/down/') } };
    await assert.rejects(publisher.publish(input(randomUUID(), 1, bd, target(s, bd))), PublisherOutcomeUnknownError);
    const after = await control('count'); assert.equal(after.posts, before.posts); assert.equal(after.attachments, before.attachments);
  });

  if (SCENARIO === 'standalone') {
    await t.test('permalink variations: prefix without trailing slash works; unsupported structures hold; old targets refused', async () => {
      try {
        await control('option', { name: 'permalink_structure', value: '/blog/%postname%' });
        const r = await publisher.checkConnection(destination, secret);
        assert.equal(r.ok, true, r.detail); assert.ok(r.websiteCapability?.protocol === 'v2');
        const root = r.websiteCapability.capabilities.roots[0]!;
        assert.equal(root.articleUrlPattern, `${ORIGIN}/blog/{slug}`); assert.equal(root.categoryUrlPattern, `${ORIGIN}/blog/category/{slug}`);
        const stale = body(`stale-${Date.now().toString(36)}`, 'Stale target', false);
        await rejected(publisher.publish(input(randomUUID(), 1, stale, target(stale.slug, stale))), /changed since the article target was reviewed|does not match/);
        destination = makeDestination(r.websiteCapability);
        const ns = `noslash-${Date.now().toString(36)}`; const bn = body(ns, 'No trailing slash', false); const tn = target(ns, bn); const vn = input(randomUUID(), 1, bn, tn);
        assert.equal((await publisher.publish(vn)).publicUrl, `${ORIGIN}/blog/${ns}`);
        const ev = await observeWebsiteDelivery(transport, { url: `${ORIGIN}/blog/${ns}`, marker: versionMarker(vn.articleId, vn.versionId, vn.contentSha), indexUrl: tn.target.indexUrl, categoryUrls: tn.categoryUrls, sitemapUrls: tn.sitemapUrls, at: new Date().toISOString(), pagination: 'wordpress', seoHead: true });
        assert.equal(ev.article.state, 'verified', ev.article.detail); assert.equal(ev.categories[0]!.state, 'verified', ev.categories[0]!.detail);
        for (const structure of ['/%year%/%monthnum%/%postname%/', '/%category%/%postname%/', '']) {
          await control('option', { name: 'permalink_structure', value: structure });
          const held = await publisher.checkConnection(destination, secret);
          assert.equal(held.ok, false); assert.match(held.detail, structure ? /on hold/ : /Plain permalinks|not found/); assert.equal(held.websiteCapability, undefined);
        }
      } finally {
        await control('option', { name: 'permalink_structure', value: '/%postname%/' });
        destination = makeDestination((await publisher.checkConnection(destination, secret)).websiteCapability);
      }
    });
  }
});
