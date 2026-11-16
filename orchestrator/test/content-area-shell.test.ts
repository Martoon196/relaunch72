/**
 * The content area shell preview: off by default and then byte-for-byte unchanged; on only with the server switch AND
 * this browser's choice; the seven places, the badge, honest empty states, escaping and the CSRF-protected switch.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { portalCsrfToken } from '../src/portal/session.js';
import { contentArticlesPage } from '../src/portal/content-area-pages.js';
import { OWNER } from './seo-blog-fixtures.js';
import { websiteFixture } from './seo-blog-website-fixtures.js';
import * as fx from './seo-blog-article-page-fixtures.js';
import { articleId, BRAND_ID, call, HOSTILE_NAME, HOSTILE_TITLE, identity, NOW, SECRET, showcase, type Scenario } from './content-area-shell-fixtures.js';
import { goldenPages, GOLDEN_BASE, GOLDEN_FILE, GOLDEN_NOW, type GoldenRecord } from './content-area-shell-golden.js';

// The tests decide the switch themselves. A build machine may have the real setting in its environment (the live
// service does once the preview is switched on), and it must not leak into the "server does not allow it" cases.
delete process.env.CONTENT_AREA_PREVIEW;

const GOLDEN: GoldenRecord = JSON.parse(gunzipSync(readFileSync(new URL(`./${GOLDEN_FILE}`, import.meta.url))).toString('utf8'));
const B = `/portal/seo-blog/b/${BRAND_ID}`;
const ON = { headers: { cookie: 'r72_content_look=new' }, input: { contentAreaPreview: 'enabled' } };
const csrf = portalCsrfToken(SECRET, identity().sessionToken);
/** What a person reads: no styles, no tags. */
const visible = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');

async function on(scenario: Scenario, path: string, settings = {}) {
  return call(showcase(scenario, settings).service, identity(), 'GET', path, ON);
}

/** Where two recordings first differ, for a readable failure. */
function firstDifference(a: string, b: string): string {
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  return `at ${i}: recorded …${JSON.stringify(a.slice(Math.max(0, i - 80), i + 80))}… now …${JSON.stringify(b.slice(Math.max(0, i - 80), i + 80))}…`;
}

test(`with the preview off, every page and form post is byte-identical to the foundation (${GOLDEN_BASE}): status, every header and the whole body`, async () => {
  const saved = process.env.CONTENT_AREA_PREVIEW;
  try {
    const cases: [string, Parameters<typeof goldenPages>[0], string | undefined][] = [
      ['no switch, no cookie', {}, undefined],
      ['cookie but no switch', { headers: { cookie: 'r72_content_look=new' } }, undefined],
      ['switch on (environment) but no cookie', {}, 'enabled'],
      ['switch on (input) but the cookie says old', { headers: { cookie: 'r72_content_look=old; other=new' }, input: { contentAreaPreview: 'enabled' } }, undefined],
      ['cookie but the switch is not exactly "enabled"', { headers: { cookie: 'r72_content_look=new' } }, 'true'],
    ];
    for (const [name, opts, env] of cases) {
      if (env === undefined) delete process.env.CONTENT_AREA_PREVIEW; else process.env.CONTENT_AREA_PREVIEW = env;
      mock.timers.enable({ apis: ['Date'], now: Date.parse(GOLDEN_NOW) });
      let now: Awaited<ReturnType<typeof goldenPages>>;
      try { now = await goldenPages(opts); } finally { mock.timers.reset(); }
      assert.deepEqual(Object.keys(now).sort(), Object.keys(GOLDEN).sort(), name);
      // While the server allows the preview, the switch itself exists for people who manage a business: its page, its
      // post and its script. Everything else, including the switch for someone who manages none, stays as it was.
      const allowed = env === 'enabled' || opts?.input?.contentAreaPreview === 'enabled';
      const newWhenAllowed = (key: string) => !key.startsWith('stranger:') && /:(look-unknown|look-back|look|post-look|script-unknown|anonymous-script|font-unknown|anonymous-font)$/.test(key) || key === 'post:look';
      let compared = 0;
      for (const key of Object.keys(GOLDEN)) {
        if (allowed && newWhenAllowed(key)) continue;
        const was = JSON.stringify(GOLDEN[key]), is = JSON.stringify(now[key]);
        if (was !== is) assert.fail(`${name}: ${key} changed ${firstDifference(was, is)}`);
        compared++;
      }
      assert.ok(compared > 150, `${name}: ${compared} requests compared`);
    }
  } finally { if (saved === undefined) delete process.env.CONTENT_AREA_PREVIEW; else process.env.CONTENT_AREA_PREVIEW = saved; }
});

test('with the preview on, the seven places land on real pages, with the right one marked and the badge counting what needs him', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  try {
    const places: [string, string, string][] = [['Home', `${B}/overview`, 'Good afternoon'], ['Brand DNA', `${B}/dna`, ''], ['Calendar', `${B}/calendar`, 'November 2026'], ['Articles', `${B}/articles`, 'Needs you'],
      ['Social', `${B}/social`, ''], ['Results', `${B}/results`, 'We do not count readers yet'], ['Settings', `${B}/publishing`, 'Publishing']];
    const home = await on('busy', `${B}/overview`);
    assert.equal(home.status, 200);
    const nav = /<nav class="ca-nav" aria-label="Content area">([\s\S]*?)<\/nav>/.exec(home.body)![1]!;
    const items = [...nav.matchAll(/<a class="ca-nav-item" href="([^"]+)"[^>]*>[\s\S]*?<span>([^<]+)<\/span>/g)].map((m) => [m[2], m[1]]);
    assert.deepEqual(items, places.map(([label, path]) => [label, path]), 'exactly seven places, each on its page');
    assert.match(nav, /<span class="ca-count" aria-label="5 need you">5<\/span>/);
    const phone = /<nav class="ca-tabbar"[^>]*>([\s\S]*?)<\/nav>/.exec(home.body)![1]!;
    assert.deepEqual([...phone.matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]).slice(0, 5), ['Home', 'Calendar', 'Articles', 'Results', 'More']);
    for (const [label, path, marker] of places) {
      if (label === 'Brand DNA' || label === 'Social') continue; // need the real engine; checked below
      const r = await on('busy', path);
      assert.equal(r.status, 200, label);
      assert.match(r.body, new RegExp(`aria-current="page">[\\s\\S]{0,800}?<span>${label}</span>`), `${label} is marked`);
      if (marker) assert.ok(visible(r.body).includes(marker), `${label}: ${marker}`);
      assert.ok((r.body.match(/data-primary/g) ?? []).length <= 1, `${label}: at most one main action`);
      assert.doesNotMatch(visible(r.body), /[–—]/, `${label}: no long dashes`);
    }
    // The badge is the articles list's own "Needs you" count, and is absent when nothing needs him.
    const list = await on('busy', `${B}/articles`);
    assert.match(list.body, /id="ca-g-ready" class="ca-h2">Needs you<\/h2><span class="ca-gcount ca-gcount-needs"><span class="ca-sr">: <\/span>5<\/span>/);
    for (const scenario of ['calm', 'new'] as const) assert.doesNotMatch((await on(scenario, `${B}/overview`)).body, /class="ca-count"/, scenario);
    // A tool that is not one of the seven places (Activity) opens in the shell with nothing marked.
    const activity = await on('busy', `${B}/activity`);
    assert.match(activity.body, /class="ca-nav"/);
    assert.doesNotMatch(/<nav class="ca-nav"[\s\S]*?<\/nav>/.exec(activity.body)![0], /aria-current/);
    // The article page and its existing actions, inside the shell.
    const article = await on('busy', `${B}/articles/${articleId(1)}`);
    assert.match(article.body, /class="ca-nav-item" href="[^"]+\/articles" aria-current="page"/);
    assert.match(article.body, /action="[^"]+\/approve-publish"/);
  } finally { mock.timers.reset(); }
});

test('the article page and Brand DNA keep their own content, forms and wording inside the shell (real engine)', async () => {
  const f = await websiteFixture();
  const service = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => f.h.engine, socialCallback: async () => null } as unknown as Parameters<typeof call>[0];
  const R = `/portal/seo-blog/b/${f.brand.id}`;
  for (const [path, start] of [[`${R}/articles/${f.articleId}`, '<div class="ap">'], [`${R}/dna`, '<style>\n.dna{'], [`${R}/social`, '<h1>'], [`${R}/publishing`, '<h1>Publishing</h1>'], [`${R}/setup`, '<h1>']] as const) {
    const before = await call(service, identity(OWNER.userId), 'GET', path);
    const after = await call(service, identity(OWNER.userId), 'GET', path, ON);
    assert.equal(after.status, 200, path);
    assert.match(after.body, /class="ca-nav"/, path);
    const inner = (html: string) => { const from = html.indexOf(start); return html.slice(from, html.indexOf('</main>', from)); };
    assert.ok(inner(before.body).length > 200, path);
    assert.equal(inner(after.body).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, 'ID'), inner(before.body).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, 'ID'), `${path}: the page itself is unchanged`);
    // The shell's page adds only its own fonts to the policy; the page without the shell is unchanged.
    assert.equal(after.headers['content-security-policy'], `${before.headers['content-security-policy']}; font-src 'self'`);
    assert.doesNotMatch(after.body, /<script(?![^>]*src="\/portal\/seo-blog\/)/, 'no inline script');
  }
  const dna = await call(service, identity(OWNER.userId), 'GET', `${R}/dna`, ON);
  assert.match(dna.body, /<a class="ca-nav-item" href="[^"]+\/dna" aria-current="page"/);
});

test('Home says the one thing that needs him, or says calmly that nothing does, and invents no numbers', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  try {
    const busy = (await on('busy', `${B}/overview`)).body;
    assert.match(busy, /<a class="ca-btn " href="[^"]+\/articles\/a0000000-0000-4000-8000-000000000001" data-primary>Start reading/);
    assert.equal(busy.match(/data-primary/g)!.length, 1);
    assert.match(visible(busy), /5 articles need you/);
    // This week: the live one on Monday, the two going out on Wednesday and Friday, nothing else.
    const week = /id="ca-week"[\s\S]*?<\/section>/.exec(busy)![0];
    assert.deepEqual([...week.matchAll(/class="ca-row-title">([^<]+)</g)].map((m) => m[1]), ['Buy, refurbish, refinance: the numbers on a £140,000 terrace', 'What a lender’s valuer looks for', 'Rental yield: gross, net and what really matters']);
    assert.doesNotMatch(busy, /people read|readers asked|most-read|1,284/);
    const calm = (await on('calm', `${B}/overview`)).body;
    assert.match(visible(calm), /Nothing needs you today/);
    assert.match(visible(calm), /Next out: “What a lender’s valuer looks for” on Wednesday 18 November at 9:00\./);
    assert.doesNotMatch(calm, /data-primary/);
    const fresh = (await on('new', `${B}/overview`)).body;
    assert.match(fresh, /href="[^"]+\/dna" data-primary>Start with your website/);
    assert.doesNotMatch(fresh, /Going out this week/);
    const freshList = (await on('new', `${B}/articles`)).body;
    assert.match(visible(freshList), /No articles yet/);
    assert.match(freshList, /href="[^"]+\/topics" data-primary>Choose topics/);
    const results = (await on('busy', `${B}/results`)).body;
    assert.doesNotMatch(visible(results), /\d[\d,]*\s+(?:people|readers|visits|views|clicks|enquiries)/i, 'no reader numbers the system does not have');
    assert.match(visible(results), /5 articles are live/);
    assert.match(results, /<a class="ca-nav-item" href="[^"]+\/results" aria-current="page"/);
  } finally { mock.timers.reset(); }
});

test('the calendar shows live, going out, needs you, being written and the empty days ahead, honestly labelled', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  try {
    const page = (await on('busy', `${B}/calendar`)).body;
    const day = (n: number) => new RegExp(`<li class="ca-day[^"]*"><h3 class="ca-dnum"><span class="ca-sr">[^<]* ${n} November</span>[\\s\\S]*?</li>`).exec(page)![0];
    assert.match(day(16), /ca-today[\s\S]*?Live/);
    assert.match(day(18), /href="[^"]+\/articles\/a0000000-0000-4000-8000-000000000006"[\s\S]*?Goes out 9:00/);
    assert.match(day(23), /Needs you/);
    assert.match(day(27), /Being written/);
    assert.match(day(25), /We will fill this/);
    assert.doesNotMatch(day(24), /ca-cal-item/, 'Tuesday is not a publishing day');
    assert.equal(page.match(/data-primary/g)!.length, 1);
    assert.match(page, /data-primary>Start with the first of the 5 that need you/);
    assert.match(page, /href="[^"]+\/calendar\?view=month&amp;date=2026-11-01">Move dates and schedule drafts by hand/);
    const manual = await on('busy', `${B}/calendar?view=month&date=2026-11-01`);
    assert.match(manual.body, /<h1>Content calendar<\/h1>/, 'the existing diary stays one step away');
    const off = (await on('busy', `${B}/calendar`, { ongoingProduction: false })).body;
    assert.doesNotMatch(off, /We will fill this/);
    assert.match(off, /Free publishing day/);
    assert.match(off, /Empty publishing days stay empty until you choose topics for them\./);
    const paused = (await on('busy', `${B}/calendar`, { pauseAll: true })).body;
    assert.doesNotMatch(paused, /We will fill this|Free publishing day/);
  } finally { mock.timers.reset(); }
});

test('the articles list keeps every existing action: open, try again (with its form token) and the status links', () => {
  const d = fx.listData();
  const html = contentArticlesPage({ ...fx.shell(), preview: { needsYou: 3, path: '/portal/seo-blog' } }, { articles: d.articles, jobs: d.jobs, briefs: d.briefs, destinations: [fx.destination], now: d.now });
  assert.match(html, /<form method="post" action="[^"]+\/jobs\/eeeeeeee-1111-4222-8333-444455556666\/retry" class="ca-row-act"><input type="hidden" name="_csrf" value="csrf-fixture"><input type="hidden" name="back" value="articles"><button type="submit" class="ca-btn-quiet">Try again<\/button>/);
  assert.match(html, /href="[^"]+publishing#writing-budget">Check the allowance</);
  for (const r of d.articles) assert.ok(html.includes(`/articles/${r.article.id}"`), r.article.id);
  assert.match(html, /href="[^"]+\/topics"/, 'a topic not started yet opens Topics');
});

test('hostile business names and titles are escaped everywhere in the shell', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  try {
    for (const path of [`${B}/overview`, `${B}/articles`, `${B}/calendar`, `${B}/results`, `${B}/articles/${articleId(1)}`]) {
      const html = (await on('hostile', path)).body;
      assert.ok(!html.includes(HOSTILE_NAME) && !html.includes('<script>alert'), `${path}: business name`);
      assert.ok(!html.includes(HOSTILE_TITLE) && !html.includes('<img src=x'), `${path}: title`);
      assert.ok(html.includes('&lt;script&gt;alert(&quot;biz&quot;)&lt;/script&gt; &amp; Sons&#39;'), `${path}: shown escaped`);
    }
  } finally { mock.timers.reset(); }
});

test('the opt-in is a CSRF-protected, same-origin POST that only sets a harmless cookie, and only when the server allows it', async () => {
  const s = showcase('busy');
  const post = (form: Record<string, string>, extra: { headers?: Record<string, string>; input?: Record<string, unknown> } = {}) => call(s.service, identity(), 'POST', '/portal/seo-blog/look', { form, headers: extra.headers, input: extra.input ?? { contentAreaPreview: 'enabled' } });
  const page = await call(s.service, identity(), 'GET', '/portal/seo-blog/look', { input: { contentAreaPreview: 'enabled' } });
  assert.equal(page.status, 200);
  assert.match(page.body, /<form method="post" action="\/portal\/seo-blog\/look"><input type="hidden" name="_csrf" value="[^"]+"><input type="hidden" name="look" value="new">/);
  const noToken = await post({ look: 'new', back: B });
  assert.equal(noToken.status, 403); assert.equal(noToken.headers['set-cookie'], undefined);
  const badToken = await post({ _csrf: 'nope', look: 'new' });
  assert.equal(badToken.status, 403); assert.equal(badToken.headers['set-cookie'], undefined);
  const crossSite = await post({ _csrf: csrf, look: 'new' }, { headers: { origin: 'https://evil.example' } });
  assert.equal(crossSite.status, 403); assert.equal(crossSite.headers['set-cookie'], undefined);
  const yes = await post({ _csrf: csrf, look: 'new', back: `${B}/articles` });
  assert.equal(yes.status, 303); assert.equal(yes.headers.location, `${B}/articles`);
  assert.equal(yes.headers['set-cookie'], 'r72_content_look=new; HttpOnly; SameSite=Lax; Path=/portal/seo-blog; Max-Age=15552000; Secure');
  const no = await post({ _csrf: csrf, look: 'old', back: 'https://evil.example/' });
  assert.equal(no.headers.location, '/portal/seo-blog');
  assert.match(no.headers['set-cookie']!, /^r72_content_look=; HttpOnly; SameSite=Lax; Path=\/portal\/seo-blog; Max-Age=0/);
  for (const back of ['//evil.example', '/portal/seo-blog/../../admin', '/portal/seo-blog-evil', 'javascript:alert(1)']) assert.equal((await post({ _csrf: csrf, look: 'new', back })).headers.location, '/portal/seo-blog', back);
  const disallowed = await post({ _csrf: csrf, look: 'new' }, { input: {} });
  assert.equal(disallowed.status, 404); assert.equal(disallowed.headers['set-cookie'], undefined);
  // The shell's own "Back to the old look" is the same protected form.
  const shell = await call(s.service, identity(), 'GET', `${B}/calendar`, ON);
  assert.match(shell.body, /<form method="post" action="\/portal\/seo-blog\/look" class="ca-oldlook"><input type="hidden" name="_csrf" value="[^"]+"><input type="hidden" name="look" value="old"><input type="hidden" name="back" value="\/portal\/seo-blog\/b\/[^"]+\/calendar">/);
});
