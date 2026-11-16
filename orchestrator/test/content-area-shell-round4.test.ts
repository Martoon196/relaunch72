/**
 * Round 4 of the content area shell (preview on only): "Your businesses" in the new look, every page reachable from the
 * shell wrapped in it, the self-hosted fonts and their policy only on shell pages, the phone layout, the reviewer's
 * leftovers (stopped writing, a removed website, the set-up anchor) and the article page's place in the queue.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { OWNER } from './seo-blog-fixtures.js';
import { websiteFixture } from './seo-blog-website-fixtures.js';
import * as fx from './seo-blog-article-page-fixtures.js';
import { CONTENT_AREA_CSS, CONTENT_AREA_SCRIPT } from '../src/portal/content-area-layout.js';
import { contentAreaFont } from '../src/portal/content-area-fonts.js';
import type { Brand } from '../src/seo-blog/types.js';
import { articleId, BRAND_ID, call, HOSTILE_NAME, identity, NOW, showcase, type Scenario, type Showcase } from './content-area-shell-fixtures.js';

// The tests decide the switch themselves (a build machine may have CONTENT_AREA_PREVIEW=enabled in its environment).
delete process.env.CONTENT_AREA_PREVIEW;

const B = `/portal/seo-blog/b/${BRAND_ID}`;
const ON = { headers: { cookie: 'r72_content_look=new' }, input: { contentAreaPreview: 'enabled' } };
const ALLOWED = { input: { contentAreaPreview: 'enabled' } };
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' https: data:; media-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const SHELL_CSP = `${PAGE_CSP}; font-src 'self'`;
const visible = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const mainOf = (html: string) => /<main id="ca-main"[^>]*>([\s\S]*?)<\/main>/.exec(html)![1]!;
const hero = (html: string) => visible(/<section class="ca-hero[\s\S]*?<\/section>/.exec(html)![0]);
const badge = (html: string) => Number(/class="ca-count" aria-label="(\d+) need you"/.exec(html)?.[1] ?? 0);
const row = (s: Showcase, n: number) => s.rows.find((r) => r.article.id === articleId(n))!;
const patch = (s: Showcase, n: number, p: object) => { const r = row(s, n); r.article = { ...r.article, ...p }; };
const job = (s: Showcase, p: object) => { s.jobs[0] = { ...s.jobs[0]!, ...p }; };
async function during<T>(fn: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  try { return await fn(); } finally { mock.timers.reset(); }
}
function make(scenario: Scenario, mut?: (s: Showcase) => void, settings: object = {}): Showcase { const s = showcase(scenario, settings); mut?.(s); return s; }
async function get(s: Showcase, path: string, opts: { headers?: Record<string, string>; input?: Record<string, unknown> } = ON) { return call(s.service, identity(), 'GET', path, opts); }

test('1. "Your businesses" in the new look: a card per business that opens its Home, an honest line, every action kept', () => during(async () => {
  const s = make('busy');
  const r = await get(s, '/portal/seo-blog');
  assert.equal(r.status, 200);
  assert.match(r.body, /<body class="ca ca-topped">/);
  assert.match(r.body, /<header class="ca-topbar">[\s\S]*Back to the old look/);
  assert.doesNotMatch(r.body, /class="ca-side"/, 'no business sidebar here');
  const cards = [...r.body.matchAll(/<a class="ca-bcard-main" href="([^"]+)">[\s\S]*?<span class="ca-bcard-name">([^<]+)<\/span>[\s\S]*?<\/a>/g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(cards, [['Martin Howard Property', `${B}/overview`], ['Key Lettings', '/portal/seo-blog/b/e0000000-0000-4000-8000-000000000001/overview']]);
  assert.match(visible(r.body), /5 written articles need you/, 'the badge rule for written articles');
  assert.match(visible(r.body), /No written articles waiting for you/);
  assert.match(r.body, /class="ca-bcard-av" aria-hidden="true">MH</);
  // Existing actions: add a business (same form and anchor), approvals and campaign results.
  assert.match(r.body, /id="add-business"[\s\S]*<form method="post" action="\/portal\/seo-blog\/brands"><input type="hidden" name="_csrf" value="[^"]+"><input type="hidden" name="commandId" value="[^"]+">[\s\S]*name="name"[\s\S]*name="website"/);
  assert.match(r.body, /href="\/portal\/approvals\?brand=all">See what is waiting in every business/);
  assert.match(r.body, /href="\/portal\/campaign-journey\?brand=[^"]+">Campaign results/);
  assert.ok((r.body.match(/data-primary/g) ?? []).length <= 1, 'at most one amber action');
  assert.equal(r.headers['content-security-policy'], SHELL_CSP);
  // A brand-new account: one amber "Add a business".
  const none = make('new');
  const engine = none.service.engineFor(identity(), 'r') as unknown as Record<string, unknown>;
  const empty = await call({ ...none.service, engineFor: () => ({ ...engine, listBrands: async () => [] }) as never }, identity(), 'GET', '/portal/seo-blog', ON);
  assert.match(empty.body, /<button type="submit" class="ca-btn" data-primary>Add a business<\/button>/);
  assert.equal((empty.body.match(/data-primary/g) ?? []).length, 1);
  // Hostile names are escaped; Brand DNA and pause states have their own line.
  const hostile = await get(make('hostile'), '/portal/seo-blog');
  assert.ok(!hostile.body.includes(HOSTILE_NAME) && hostile.body.includes('&lt;script&gt;alert(&quot;biz&quot;)'));
  assert.match(visible((await get(make('busy', (x) => { x.dna = 'proposed'; }), '/portal/seo-blog')).body), /Your Brand DNA card is waiting for you/);
  assert.match(visible((await get(make('busy', undefined, { pauseAll: true }), '/portal/seo-blog')).body), /Publishing is paused/);
}));

test('1b. the status line is read for at most 12 businesses (two reads each); the rest show just the name', () => during(async () => {
  const s = make('calm');
  const inner = s.service.engineFor(identity(), 'r') as unknown as Record<string, (...a: unknown[]) => unknown>;
  const many: Brand[] = Array.from({ length: 15 }, (_, i) => ({ ...s.brand, id: `f0000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `Business ${i + 1}` }) as Brand);
  const counts: Record<string, number> = {};
  const engine = new Proxy(inner, { get: (t, k: string) => k === 'listBrands' ? async () => many : typeof t[k] === 'function' ? (...a: unknown[]) => { counts[k] = (counts[k] ?? 0) + 1; return t[k]!(...a); } : t[k] });
  const r = await call({ ...s.service, engineFor: () => engine as never }, identity(), 'GET', '/portal/seo-blog', ON);
  assert.equal((r.body.match(/class="ca-bcard"/g) ?? []).length, 15);
  assert.equal(counts.listArticles, 12); assert.equal(counts.listDestinations, 12);
  assert.equal((r.body.match(/class="ca-bcard-line"/g) ?? []).length, 12);
  assert.match(visible(r.body), /The status line is shown for the first 12 businesses/);
}));

test('2. every page reachable from the shell comes back in the shell (real engine crawl), Usage and limits and errors included', async () => {
  const f = await websiteFixture();
  const limits = { allowed: async () => true, list: async () => ({ policy: { version: 1, enabled: true, maxConcurrency: 1, monthlyMicrousd: 0 }, brands: [] }) };
  const service = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => f.h.engine, socialCallback: async () => null, limitsFor: () => limits } as unknown as Parameters<typeof call>[0];
  const R = `/portal/seo-blog/b/${f.brand.id}`;
  const seen = new Set<string>(), outside = new Set<string>(), bare: string[] = [];
  const queue = [`${R}/overview`, '/portal/seo-blog'];
  while (queue.length && seen.size < 120) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const r = await call(service, identity(OWNER.userId), 'GET', path, ON);
    if (r.status === 303 || !/text\/html/.test(r.headers['content-type'] ?? '')) continue;
    if (!/<body class="ca[ "]/.test(r.body)) bare.push(`${path} (${r.status})`);
    for (const m of r.body.matchAll(/href="([^"#]+)/g)) {
      const href = m[1]!.replace(/&amp;/g, '&');
      if (!href.startsWith('/')) continue;
      if (!href.startsWith('/portal/seo-blog')) { outside.add(href.split('?')[0]!); continue; }
      // Downloads, the website's own rendering, media and scripts are not pages of the app.
      if (/\/(export|preview|post-export)\b|\.(js|jpg|mp4|webm|woff2)$|[?&]download=1|\/media\//.test(href)) continue;
      queue.push(href);
    }
  }
  assert.deepEqual(bare, [], 'pages without the shell');
  assert.ok(seen.has('/portal/seo-blog/limits'), 'Usage and limits was reached');
  // Pages of other parts of the portal (other routers) are listed, not wrapped by this router.
  assert.deepEqual([...outside].sort(), ['/portal', '/portal/approvals', '/portal/campaign-journey']);
  const missing = await call(service, identity(OWNER.userId), 'GET', `${R}/no-such-page`, ON);
  assert.equal(missing.status, 404);
  assert.match(missing.body, /<body class="ca ca-topped">[\s\S]*Not found[\s\S]*That page was not found\./);
});

test('3. fonts: self-hosted, about 46 KB, served only while allowed, and font-src only on pages that render the shell', async () => {
  const s = make('busy');
  const sizes: number[] = [];
  for (const name of ['urbanist-800-5.3.0.woff2', 'hanken-grotesk-wght-5.3.0.woff2']) {
    const allowed = await call(s.service, null, 'GET', `/portal/seo-blog/fonts/${name}`, ALLOWED);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers['content-type'], 'font/woff2');
    assert.equal(allowed.headers['cache-control'], 'public, max-age=31536000, immutable');
    sizes.push(contentAreaFont(name)!.byteLength);
    assert.equal(Number(allowed.headers['content-length']), contentAreaFont(name)!.byteLength);
    assert.equal(contentAreaFont(name)!.subarray(0, 4).toString('latin1'), 'wOF2');
    // Not allowed: exactly as before (signed out: to the login page).
    const off = await call(s.service, null, 'GET', `/portal/seo-blog/fonts/${name}`, { input: {} });
    assert.equal(off.status, 303); assert.equal(off.headers.location, '/portal/login');
  }
  assert.ok(sizes.reduce((a, b) => a + b, 0) < 150_000, `font payload ${sizes.reduce((a, b) => a + b, 0)} bytes`);
  assert.equal(contentAreaFont('../content-area-fonts.ts'), null);
  await during(async () => {
    for (const path of [`${B}/overview`, `${B}/calendar`, `${B}/articles`, `${B}/articles/${articleId(1)}`, `${B}/results`, '/portal/seo-blog']) {
      const on = await get(s, path);
      assert.equal(on.headers['content-security-policy'], SHELL_CSP, path);
      assert.match(on.body, /@font-face\{font-family:"Urbanist"[^}]*font-display:swap[^}]*url\(\/portal\/seo-blog\/fonts\/urbanist-800-5\.3\.0\.woff2\)/, path);
      const off = await get(s, path, { headers: { cookie: 'r72_content_look=new' }, input: {} });
      assert.equal(off.headers['content-security-policy'], PAGE_CSP, `${path} with the preview off`);
      assert.doesNotMatch(off.body, /@font-face|\/fonts\//, `${path}: no fonts when off`);
      const notChosen = await get(s, path, ALLOWED);
      assert.equal(notChosen.headers['content-security-policy'], PAGE_CSP, `${path} allowed but not chosen`);
    }
    // The switch page itself is not the shell: no font policy, no fonts.
    const look = await get(s, '/portal/seo-blog/look', ALLOWED);
    assert.equal(look.headers['content-security-policy'], PAGE_CSP);
    assert.doesNotMatch(look.body, /@font-face/);
  });
});

test('4. phone: the bar matches the sidebar, 44 px targets, the business at the top, and More is a proper sheet', async (t) => {
  const phone = /@media \(max-width:700px\)\{([\s\S]*?)\n\}/.exec(CONTENT_AREA_CSS)![1]!;
  assert.match(phone, /\.ca-tabbar\{display:flex;[^}]*background:var\(--ca-deep\)/);
  assert.match(phone, /\.ca-tab\[aria-current=page\],\.ca-tab\.ca-on\{background:var\(--ca-surface\)/);
  assert.match(phone, /\.ca-tab\{[^}]*min-height:52px/);
  assert.match(phone, /\.ca-sheet a\{[^}]*min-height:48px/);
  assert.match(phone, /\.ca-sheet\{position:fixed;/);
  assert.match(phone, /\.ca-side\{position:sticky;top:0;/);
  let chromium: { launch: () => Promise<any> } | null = null;
  try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch { /* not installed here */ }
  if (!chromium) return t.skip('Playwright is not installed on this machine');
  const html = await during(async () => (await get(make('busy'), `${B}/overview`)).body);
  const browser = await chromium.launch();
  try {
    const tab = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await tab.setContent(html.replace(/<script[^>]*><\/script>/g, `<script>${CONTENT_AREA_SCRIPT}</script>`));
    const sizes = await tab.evaluate(() => [...document.querySelectorAll('.ca-tab')].map((e) => e.getBoundingClientRect().height));
    assert.ok(sizes.length === 5 && sizes.every((h: number) => h >= 44), `tab heights ${sizes.join(', ')}`);
    assert.ok(await tab.evaluate(() => (document.querySelector('.ca-biz-name') as HTMLElement).getBoundingClientRect().top < 80), 'the business name at the top');
    await tab.click('.ca-tab-more > summary');
    const sheet = await tab.evaluate(() => { const r = document.querySelector('.ca-sheet')!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, open: (document.querySelector('.ca-tab-more') as HTMLDetailsElement).open }; });
    assert.ok(sheet.open && sheet.left <= 8 && sheet.right >= 382 && sheet.bottom <= 844, `sheet ${JSON.stringify(sheet)}`);
    await tab.keyboard.press('Escape');
    assert.equal(await tab.evaluate(() => (document.querySelector('.ca-tab-more') as HTMLDetailsElement).open), false, 'Escape closes it');
    assert.equal(await tab.evaluate(() => document.documentElement.scrollWidth), 390, 'no sideways scroll');
  } finally { await browser.close(); }
});

test('5a. stopped writing with no button of its own ranks below reading, stays off the badge and never pins Home', () => during(async () => {
  for (const [name, mut] of [
    ['cancelled', (s: Showcase) => job(s, { state: 'cancelled' })],
    // Still not connected (once it is, the article page and Home offer "Write it now" instead).
    ['service not connected', (s: Showcase) => { job(s, { state: 'blocked', error: 'Generation is not configured. Connect a model provider.' }); s.generation = 'unavailable'; }],
    ['stopped, no task', (s: Showcase) => { s.jobs.length = 0; patch(s, 13, { editorialState: 'failed', failure: 'The model returned an unusable draft.' }); }],
  ] as const) {
    const calm = make('calm', mut);
    const home = (await get(calm, `${B}/overview`)).body;
    assert.equal(badge(home), 0, `${name}: off the badge`);
    assert.doesNotMatch(visible(mainOf(home)), /Everything is running|All clear/, `${name}: not "all clear"`);
    assert.match(hero(home), /Nothing needs you today/, name);
    assert.match(hero(home), /It will not carry on by itself\./, name);
    assert.doesNotMatch(mainOf(home), /data-primary/, `${name}: nothing amber to press`);
    assert.match(mainOf(home), /\/activity">See what happened/, name);
    const list = (await get(calm, `${B}/articles`)).body;
    assert.match(visible(list), /Stopped : 1/, `${name}: listed under "Stopped"`);
    assert.doesNotMatch(visible(list), /Needs you :/, name);
    // With articles to read, reading comes first.
    const busy = make('busy', mut);
    const busyHome = (await get(busy, `${B}/overview`)).body;
    assert.match(hero(busyHome), /5 articles need you/, `${name}: reading first`);
    assert.equal(badge(busyHome), 5, `${name}: badge counts only what he can act on`);
  }
}));

test('5b/5c. a removed website with none other says "Connect your website"; the shell links to the real set-up anchor', () => during(async () => {
  const removed = make('calm', (s) => { s.destinations = []; });
  const home = (await get(removed, `${B}/overview`)).body;
  assert.match(mainOf(home), /href="[^"]+\/setup#website-connection" data-primary>Connect your website/);
  assert.doesNotMatch(mainOf(home), /Choose another website/);
  const list = (await get(removed, `${B}/articles`)).body;
  assert.match(list, /href="[^"]+\/setup#website-connection">Connect your website/);
  const other = make('calm', (s) => { s.destinations = [{ ...fx.destination, id: '7e7e7e7e-2222-4222-8333-444455556666', label: 'second-site.example' }]; });
  assert.match(mainOf((await get(other, `${B}/overview`)).body), /articles\/a0000000-0000-4000-8000-000000000006" data-primary>Choose another website/);
  for (const page of ['overview', 'articles', 'calendar']) {
    const body = mainOf((await get(make('calm', (s) => { s.destinations = [{ ...fx.destination, status: 'failed' }]; }), `${B}/${page}`)).body);
    assert.doesNotMatch(body, /setup#websites/, `${page}: the shell's own links use the real anchor`);
  }
  assert.match((await get(make('calm', (s) => { s.destinations = [{ ...fx.destination, status: 'failed' }]; }), `${B}/overview`)).body, /setup#website-connection/);
  // Links inside the existing pages still say #websites; the shell's script takes them to the website section.
  assert.match(CONTENT_AREA_SCRIPT, /location\.hash === '#websites'[\s\S]*getElementById\('website-connection'\)/);
  // The set-up page itself is unchanged: its section is website-connection.
  const f = await websiteFixture();
  const service = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => f.h.engine, socialCallback: async () => null } as unknown as Parameters<typeof call>[0];
  assert.match((await call(service, identity(OWNER.userId), 'GET', `/portal/seo-blog/b/${f.brand.id}/setup`, ON)).body, /id="website-connection"/);
}));

test('6. the article page inside the shell: "1 of 5 that need you" and Next above it, the page itself untouched', () => during(async () => {
  const s = make('busy');
  const first = (await get(s, `${B}/articles/${articleId(1)}`)).body;
  assert.match(first, /<nav class="ca-queue" aria-label="Articles that need you"><span><b>1 of 5<\/b> that need you<\/span><a href="[^"]+\/articles\/a0000000-0000-4000-8000-000000000[0-9]{3}">Next/);
  const off = (await get(s, `${B}/articles/${articleId(1)}`, { input: {} })).body;
  // Fresh command ids (made per render) aside, the page is the same bytes.
  const inner = (html: string) => { const from = html.indexOf('<div class="ap">'); return html.slice(from, html.indexOf('</main>', from)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, (id) => /^[abc]0000000-/.test(id) ? id : 'ID'); };
  assert.equal(inner(first), inner(off), 'the article page itself is identical');
  const live = (await get(s, `${B}/articles/${articleId(8)}`)).body;
  assert.doesNotMatch(live, /class="ca-queue"/, 'a live article is not in the queue');
  assert.match(CONTENT_AREA_CSS, /\.ca-main \.ap-read\{padding:32px 48px 48px\}/);
}));
