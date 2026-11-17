/**
 * The SEO report on the article page: what it shows (measured and unmeasured searches, no invented numbers, no brief),
 * that it escapes everything, adds no main action and no form, names no supplier, method or model, opens on ?open=seo,
 * appears in both looks, and that it is the ONLY change to the pages (preview off).
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { editorPage, ARTICLE_FOLDS } from '../src/portal/seo-blog-article-view.js';
import { articleSeoScore, SEO_PANEL_CSS, SEO_PANEL_END, SEO_PANEL_START } from '../src/portal/seo-blog-seo-panel.js';
import { seoNextSteps } from '../src/seo-blog/seo-score.js';
import { OWNER } from './seo-blog-fixtures.js';
import { websiteFixture } from './seo-blog-website-fixtures.js';
import * as fx from './seo-blog-article-page-fixtures.js';
import * as sp from './seo-panel-fixtures.js';
import { seoPanelPieces, withoutSeoPanel } from './seo-panel-strip.js';
import * as LS from './seo-panel-lead-fixtures.js';
import * as R from './seo-score-review-fixtures.js';
import * as R2 from './seo-score-review2-fixtures.js';
import * as R3 from './seo-score-review3-fixtures.js';
import * as RB4 from './seo-score-review4-rubbish.js';
import { articleId, BRAND_ID, call, identity, showcase } from './content-area-shell-fixtures.js';
import { goldenPages, GOLDEN_NOW } from './content-area-shell-golden.js';

// The tests choose the look themselves; the build machine's own setting must not leak in.
delete process.env.CONTENT_AREA_PREVIEW;

const newLook = () => ({ ...fx.shell(), preview: { needsYou: 1, path: '/x' } }) as ReturnType<typeof fx.shell>;
/** The panel's two pieces, joined. */
const panelOf = (html: string) => [...html.matchAll(new RegExp(`${SEO_PANEL_START}([\\s\\S]*?)${SEO_PANEL_END}`, 'g'))].map((m) => m[1]).join('\n');
/** What a person reads in the panel: no style, no tags. */
const visible = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const HOSTILE = '<script>alert("x")</script><img src=x onerror=alert(1)> & "quotes" \'apos\'';
const SECRET_WORDS = /dataforseo|data for seo|anthropic|claude|openai|\bgpt\b|\bmodel\b|method pack|writing method|production.core|blog.writing|editorial.planning|keyword provider|supplier/i;

const briefs = { measured: sp.measured(), unmeasured: sp.brief(), none: null, zeroless: sp.brief({ demand: { kind: 'measured', volume: null, competition: null, provider: 'dataforseo', retrievedAt: 'not a date' } }) } as const;

test('in reading mode the panel is two marked pieces: a quiet score line near the top and a fold just above "How it appears in Google"', () => {
  for (const shell of [fx.shell(), newLook()]) {
    const html = editorPage(shell, { ...fx.pageData('ready'), articleBrief: sp.brief() });
    assert.equal(seoPanelPieces(html), 2);
    assert.match(html, /<!--r72-seo-panel--><p class="ap-quiet-line sp-line"><span class="sp-pill sp-(?:hi|mid|lo)">SEO score \d+ out of 100<\/span> <a href="\/portal\/seo-blog\/b\/[^"]+\/articles\/[^"]+\?open=seo#seo">/);
    assert.match(html, /<div class="ap-folds">\n<!--r72-seo-panel--><details class="ap-fold sp" id="seo"><summary><h2>SEO report: \d+ out of 100<\/h2><\/summary>[\s\S]*?<!--\/r72-seo-panel-->\n<details class="ap-fold" id="google">/);
    // Opens on ?open=seo, which the router accepts because it is a known fold.
    assert.ok((ARTICLE_FOLDS as readonly string[]).includes('seo'));
    assert.match(editorPage(shell, { ...fx.pageData('ready'), articleBrief: sp.brief(), open: ['seo'] }), /<details class="ap-fold sp" id="seo" open>/);
  }
  // Not while editing, and not before the article is written.
  assert.equal(seoPanelPieces(editorPage(fx.shell(), { ...fx.pageData('ready'), mode: 'edit', articleBrief: sp.brief() })), 0);
  assert.equal(seoPanelPieces(editorPage(fx.shell(), { ...fx.pageData('writing'), articleBrief: sp.brief() })), 0);
});

test('measured searches show the number and when it was measured, never who measured it; otherwise one plain sentence and no number anywhere', () => {
  const page = (b: typeof briefs[keyof typeof briefs]) => panelOf(editorPage(newLook(), { ...fx.pageData('ready'), articleBrief: b }));
  const m = visible(page(briefs.measured));
  assert.match(m, /1,300 searches a month in Google/);
  assert.match(m, /Measured on 3 November 2026\./);
  assert.match(m, /depends on where the page ranks in Google\./);
  assert.doesNotMatch(m, /42|competition/i, 'competition is not shown');
  for (const b of [briefs.unmeasured, briefs.none, briefs.zeroless]) {
    const demand = /How many people search for this(.*?)How many visits/.exec(visible(page(b)))![1]!;
    assert.equal(demand.trim(), 'We do not have search numbers for this phrase yet.');
    assert.doesNotMatch(visible(page(b)), /searches a month|traffic|visits a month|\d[\d,]* (?:visits|visitors|clicks)/i, 'no invented numbers');
  }
  // The engine's own reasoning text is not shown either.
  assert.doesNotMatch(visible(page(briefs.unmeasured)), /No measured search data/);
});

test('what the article aims for, tags and data for search engines: truthful rows, including no tags and no topics', () => {
  const v = visible(panelOf(editorPage(fx.shell(), { ...fx.pageData('ready'), articleBrief: sp.brief() })));
  assert.match(v, /The search phrase appraise a property deal/);
  assert.match(v, /What the searcher wants Learning: they want to understand how something works\./);
  assert.match(v, /Why we picked it Investors who come to Martin Howard Property/);
  assert.match(v, /Questions people ask about it How long should a property appraisal take\?/);
  assert.match(v, /Tags None\. Articles do not have tags, so we do not send any\./);
  assert.match(v, /Topics on your website None\. Your website connection does not offer topics\./);
  assert.match(v, /Author None set, so your business name is shown as the author\./);
  assert.match(v, /Main picture None yet\./);
  assert.match(v, /Data for search engines We send the title, the Google title/, 'a content API site renders its own tags');
  assert.match(v, /questions and answers are not marked as a questions block/);
  assert.match(v, /SEO score \d+ out of 100\. These are the same kind of checks SEO plugins such as Rank Math and Yoast run, plus checks they cannot run\. It is our score; their number can differ a little\./);
  const none = visible(panelOf(editorPage(fx.shell(), { ...fx.pageData('ready'), articleBrief: null })));
  assert.match(none, /The search phrase is not on record for this article/);
  assert.match(none, /Left out because they cannot be checked for this article: the search phrase checks/);
});

test('the checks: failures first, each with what to do, linked to the existing control; no picture is a clear fail', () => {
  const html = panelOf(editorPage(fx.shell(), { ...fx.pageData('ready'), articleBrief: sp.brief() }));
  const v = visible(html);
  assert.ok(v.indexOf('Not yet (') < v.indexOf('Nearly there ('));
  assert.match(html, /A main picture with a picture description <\/strong> <span class="sp-tag">Not yet<\/span>|A main picture with a picture description<\/strong> <span class="sp-tag">Not yet<\/span>/);
  assert.match(html, /The article has no main picture yet\.<\/p><p class="sp-todo"><span class="sp-label">What to do:<\/span> Add a picture: upload a photo, use one from your website or ask us to make one\. <a class="sp-fix" href="#picture">Add a picture<\/a>/);
  assert.match(html, /<a class="sp-fix" href="\/portal\/seo-blog\/b\/[^"]+\/articles\/[^"]+\?edit=1#google">Edit the Google title<\/a>/);
  assert.match(html, /<a class="sp-fix" href="\/portal\/seo-blog\/b\/[^"]+\/articles\/[^"]+\?edit=1#opening">Edit the opening paragraph<\/a>/);
  // Every fix link points at a control the page already has.
  for (const m of html.matchAll(/class="sp-fix" href="([^"]+)"/g)) assert.match(m[1]!, /^(#picture|#fix|\/portal\/seo-blog\/b\/[^/]+\/articles\/[^?#]+\?(edit=1(#(google|opening|part-[^"]+))?|open=rewrite#rewrite))$/, m[1]);
  // While it is going onto the website, nothing offers editing.
  const busy = panelOf(editorPage(fx.shell(), { ...fx.pageData('ready'), article: fx.article({ delivery: 'publishing' }), articleBrief: sp.brief() }));
  assert.doesNotMatch(busy, /edit=1/);
  // A live article's address cannot change, so no link offers it.
  const live = panelOf(editorPage(fx.shell(), { ...fx.pageData('published'), articleBrief: sp.brief({ targetQuery: 'zebra crossing' }) }));
  assert.doesNotMatch(live, /Edit the page address/);
});

test('the report leads with the three changes worth most and the score they reach; everything else is folded away', () => {
  for (const shell of [fx.shell(), newLook()]) {
    const d = { ...fx.pageData('ready'), articleBrief: sp.brief(), open: ['seo'] };
    const html = panelOf(editorPage(shell, d));
    const s = articleSeoScore(fx.brand, { article: d.article, articleBrief: d.articleBrief, destinations: d.destinations }, d.version!);
    const next = seoNextSteps(s);
    assert.ok(next.to > next.from);
    assert.match(html, new RegExp(`<h4 class="sp-sub sp-lead">Three things would take this from ${s.score} to ${next.to}</h4>`));
    // The three are shown open, in a list straight after the lead; the rest sit in folds.
    const top = /<ul class="sp-checks sp-top">([\s\S]*?)<\/ul>/.exec(html)![1]!;
    assert.equal(top.match(/<li class="sp-check/g)?.length, 3);
    for (const c of next.checks) assert.ok(top.includes(c.name.replace(/&/g, '&amp;')), c.name);
    assert.match(html, /<details class="sp-done sp-rest"><summary>Everything else to improve \(\d+\)<\/summary>/);
    assert.match(html, /<details class="sp-done sp-parts"><summary>Score by part<\/summary>/);
    assert.match(html, /<details class="sp-done"><summary>Already good \(\d+\)<\/summary>/);
    // Nothing outside the lead and its three is open: every other check is inside a fold.
    const card = /<section class="sp-card sp-wide sp-score"[\s\S]*?<\/section>/.exec(html)![0];
    const open = card.replace(/<details[\s\S]*?<\/details>/g, '');
    assert.equal(open.match(/<li class="sp-check/g)?.length, 3);
    const v = visible(html);
    assert.ok(v.indexOf('Three things would take this') < v.indexOf('Everything else to improve'));
    assert.ok(v.indexOf('Not yet (') < v.indexOf('Nearly there ('));
  }
});

test('the lead says plainly when a must-fix issue holds the score, and every check passing says so', () => {
  const v = fx.version(3, sp.strongBody());
  const held = fx.article({ currentVersionId: v.id, checks: { versionId: v.id, contentSha: v.contentSha, factsSha: 'f'.repeat(64), ranAt: '2026-11-13T09:00:00.000Z', status: 'blocked', issues: [fx.critical] } as never });
  const html = panelOf(editorPage(newLook(), { ...fx.pageData('ready'), version: v, versions: [v], article: held, articleBrief: sp.measured(), open: ['seo'] }));
  assert.match(html, /SEO report: 59 out of 100/);
  assert.match(visible(html), /The checks found 1 thing to fix, so the score stays at 59 or below until it is fixed\. Show me what to fix/);
  // The wording is true on a live article too, and it links to the thing to fix.
  assert.doesNotMatch(visible(html), /goes out/);
  assert.match(html, /<p class="ap-note sp-cap">[^<]*<a class="sp-fix" href="#fix">Show me what to fix<\/a><\/p>/);
  assert.match(html, /<h4 class="sp-sub sp-lead">The (?:three|two|one) things? that would help most<\/h4>|<h4 class="sp-sub sp-lead">The thing that would help most<\/h4>/);
  const live = fx.article({ currentVersionId: v.id, publishedVersionId: v.id, publishedUrl: 'https://www.martinhowardproperty.example/blog/appraise-a-property-deal', editorialState: 'published' as never, checks: held.checks });
  const liveHtml = panelOf(editorPage(newLook(), { ...fx.pageData('published'), version: v, versions: [v], article: live, articleBrief: sp.measured(), open: ['seo'] }));
  assert.match(liveHtml, /<p class="ap-note sp-cap">The checks found 1 thing to fix, so the score stays at 59 or below until it is fixed\. <a class="sp-fix" href="#fix">Show me what to fix<\/a><\/p>/);
});

test('the headline counts only changes the owner can make now: never the page address once the article is live, and it never overstates', () => {
  // The strong article with an address that lacks the phrase, live: the address cannot change any more.
  const body = { ...sp.strongBody(), slug: 'maximum-offer-guide' };
  const v = fx.version(3, body);
  const checks = { versionId: v.id, contentSha: v.contentSha, factsSha: 'f'.repeat(64), ranAt: '2026-11-13T09:00:00.000Z', status: 'passed', issues: [] };
  const live = fx.article({ currentVersionId: v.id, publishedVersionId: v.id, publishedUrl: 'https://www.martinhowardproperty.example/blog/maximum-offer-guide', checks } as never);
  const d = { ...fx.pageData('published'), version: v, versions: [v], article: live, articleBrief: sp.brief(), open: ['seo'] };
  const s = articleSeoScore(fx.brand, { article: live, articleBrief: d.articleBrief, destinations: d.destinations }, v);
  assert.ok(s.checks.some((c) => c.id === 'phrase.address' && c.result !== 'pass'), 'the address check is open');
  const html = panelOf(editorPage(newLook(), d));
  const top = /<ul class="sp-checks sp-top">([\s\S]*?)<\/ul>/.exec(html)![1]!;
  assert.doesNotMatch(top, /The search phrase is in the page address/, 'the live address is not one of the three');
  assert.doesNotMatch(html, /Edit the page address/);
  const lead = /<h4 class="sp-sub sp-lead">(?:\w+ things?|One thing) would take this from (\d+) to (\d+)<\/h4>/.exec(html);
  assert.ok(lead, 'a headline with the reachable score');
  const actionable = seoNextSteps(s, 3, (c) => c.fix !== 'address');
  assert.equal(Number(lead![2]), actionable.to);
  // Never more than the open points of the checks it names can reach (rounded down).
  const gained = actionable.checks.reduce((t, c) => t + c.weight - c.points, 0);
  assert.ok(actionable.to <= Math.floor(((s.earned + gained) * 100) / s.available));
  // Before it is live, the address is a change the owner can make, so it may be counted.
  const draft = fx.article({ currentVersionId: v.id, checks } as never);
  const draftScore = articleSeoScore(fx.brand, { article: draft, articleBrief: sp.brief(), destinations: d.destinations }, v);
  assert.ok(seoNextSteps(draftScore, 10).checks.some((c) => c.id === 'phrase.address'));
  assert.match(panelOf(editorPage(newLook(), { ...fx.pageData('ready'), version: v, versions: [v], article: draft, articleBrief: sp.brief(), open: ['seo'] })), /Edit the page address/);
});

test('checks that ran on an earlier version and found a must-fix: the report says plainly that they need running, and the score is held with the page\'s "to fix" box', () => {
  const v = fx.version(3, sp.strongBody());
  const older = fx.versions[1]!;
  const stale = fx.article({ currentVersionId: v.id, checks: { versionId: older.id, contentSha: older.contentSha, factsSha: 'f'.repeat(64), ranAt: '2026-11-12T09:00:00.000Z', status: 'blocked', issues: [fx.critical] } as never });
  const d = { ...fx.pageData('ready'), version: v, versions: [older, v], article: stale, articleBrief: sp.measured(), open: ['seo'] };
  const s = articleSeoScore(fx.brand, { article: stale, articleBrief: d.articleBrief, destinations: d.destinations }, v);
  assert.equal(s.cap?.kind, 'stale-checks');
  assert.ok(s.score <= 59, String(s.score));
  const v2 = visible(panelOf(editorPage(newLook(), d)));
  assert.match(v2, /The checks last ran on an earlier version and found 1 thing to fix\. They have not run on this version, so the score stays at 59 or below until they run again\./);
  assert.match(v2, /Left out because they cannot be checked for this article: every figure has a source \(the checks have not run on this version yet\)/);
  // Without a must-fix on record, an earlier run does not hold the score: the figures are simply left out.
  const calm = fx.article({ currentVersionId: v.id, checks: { versionId: older.id, contentSha: older.contentSha, factsSha: 'f'.repeat(64), ranAt: '2026-11-12T09:00:00.000Z', status: 'warnings', issues: fx.warnings } as never });
  assert.equal(articleSeoScore(fx.brand, { article: calm, articleBrief: d.articleBrief, destinations: d.destinations }, v).cap, null);
});

test('dark mode: the tick, cross and "!" use the card colour on their coloured circle, so they read in both themes', () => {
  assert.match(SEO_PANEL_CSS, /\.sp-mark\{[^}]*color:var\(--card\)/);
  assert.doesNotMatch(SEO_PANEL_CSS, /\.sp-mark\{[^}]*color:#fff/);
});

test('the score is worked out once per page view: the summary line and the report share it', () => {
  const d = { article: fx.article(), articleBrief: sp.brief(), destinations: [fx.destination] };
  const v = fx.versions[2]!;
  const a = articleSeoScore(fx.brand, d, v);
  assert.equal(articleSeoScore(fx.brand, d, v), a, 'the same objects give the same result without scoring again');
  assert.notEqual(articleSeoScore(fx.brand, { ...d }, v), a, 'new page data is scored afresh');
  const html = editorPage(fx.shell(), { ...fx.pageData('ready'), articleBrief: sp.brief() });
  const line = /SEO score (\d+) out of 100<\/span>/.exec(html)![1];
  const fold = /SEO report: (\d+) out of 100/.exec(html)![1];
  assert.equal(line, fold);
});

test('an article with no sub-headings is not offered "Edit the sub-headings"', () => {
  const b = fx.body({ sections: [] });
  const v = fx.version(3, b);
  const html = panelOf(editorPage(fx.shell(), { ...fx.pageData('ready'), version: v, versions: [v], article: fx.article({ currentVersionId: v.id }), articleBrief: sp.brief(), open: ['seo'] }));
  assert.doesNotMatch(html, /Edit the sub-headings/);
});

test('every state, both looks, every kind of brief: no main action, no form or field, no dashes, no supplier, method or model name', () => {
  for (const state of fx.PAGE_STATES) for (const shell of [fx.shell(), newLook()]) for (const b of Object.values(briefs)) {
    const html = editorPage(shell, { ...fx.pageData(state), articleBrief: b, open: ['seo'] });
    const panel = panelOf(html);
    if (!fx.pageData(state).version) { assert.equal(panel, ''); continue; }
    assert.doesNotMatch(panel, /data-primary|ap-primary|ca-btn|<form|<input|<button|<select|<textarea/, `${state}: the panel adds no action`);
    assert.doesNotMatch(visible(panel), /[–—]/, `${state}: no em or en dash`);
    assert.doesNotMatch(panel, SECRET_WORDS, `${state}: no supplier, method or model name`);
    // At most one main action on the whole page, as before.
    assert.ok((html.replace(/<style>[\s\S]*?<\/style>/g, '').match(/data-primary/g)?.length ?? 0) <= 1);
  }
});

test('hostile text in every field is escaped in the panel', () => {
  const hostileBrief = sp.brief({ targetQuery: HOSTILE, whyFit: HOSTILE, relatedQuestions: [HOSTILE, HOSTILE], searchIntent: HOSTILE as never,
    demand: { kind: 'measured', volume: 5 as never, competition: null, provider: HOSTILE, retrievedAt: HOSTILE } });
  const body = fx.body({ title: HOSTILE, seoTitle: HOSTILE, metaDescription: HOSTILE, excerpt: HOSTILE, slug: HOSTILE, author: { name: HOSTILE },
    image: { kind: 'brand_asset', url: 'https://x.example/a.jpg', alt: HOSTILE, provenance: '', width: null, height: null }, cta: { label: HOSTILE, url: HOSTILE } });
  const v = fx.version(3, body);
  const html = editorPage(newLook(), { ...fx.pageData('ready'), version: v, article: fx.article({ currentVersionId: v.id }), versions: [v], articleBrief: hostileBrief, open: ['seo'] });
  const panel = panelOf(html);
  assert.doesNotMatch(panel, /<script|<img src=x|"quotes"|'apos'/, 'no raw tag or quote from the data');
  assert.match(panel, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(panel, SECRET_WORDS);
});

test('the existing page is untouched: lifting the panel out leaves every form, field and token as it was', () => {
  for (const state of fx.PAGE_STATES) {
    const html = editorPage(newLook(), { ...fx.pageData(state), articleBrief: sp.brief() });
    const without = withoutSeoPanel(html);
    const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;
    for (const re of [/<form\b/g, /<input\b/g, /<button\b/g, /name="_csrf"/g, /data-primary/g, /<details class="ap-fold"/g]) assert.equal(count(html, re), count(without, re), `${state} ${re}`);
  }
});

test('preview off: through the real router, the only change to any page or form post is the SEO report on written article pages', async () => {
  const saved = process.env.CONTENT_AREA_PREVIEW;
  delete process.env.CONTENT_AREA_PREVIEW;
  mock.timers.enable({ apis: ['Date'], now: Date.parse(GOLDEN_NOW) });
  try {
    const pages = await goldenPages({});
    let articles = 0;
    for (const [key, r] of Object.entries(pages)) {
      const pieces = seoPanelPieces(r.body);
      if (/:article(?:-\d+|-folds)?$/.test(key) && /<div class="ap-folds">/.test(r.body)) { assert.equal(pieces, 2, key); articles++; }
      else assert.equal(pieces, 0, `${key} has no SEO report`);
    }
    assert.ok(articles >= 10, `${articles} written article pages carry the report`);
  } finally { mock.timers.reset(); if (saved === undefined) delete process.env.CONTENT_AREA_PREVIEW; else process.env.CONTENT_AREA_PREVIEW = saved; }
});

test('through the real engine and router: the article\'s own brief reaches the report (getArticle returns it), in both looks', async () => {
  const f = await websiteFixture();
  const service = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => f.h.engine, socialCallback: async () => null } as unknown as Parameters<typeof call>[0];
  const detail = await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId);
  assert.ok(detail.articleBrief, 'getArticle returns the article\'s brief');
  assert.equal(detail.articleBrief!.id, detail.article.briefId);
  const path = `/portal/seo-blog/b/${f.brand.id}/articles/${f.articleId}?open=seo`;
  for (const opts of [{}, { headers: { cookie: 'r72_content_look=new' }, input: { contentAreaPreview: 'enabled' } }]) {
    const r = await call(service, identity(OWNER.userId), 'GET', path, opts);
    assert.equal(r.status, 200);
    const v = visible(panelOf(r.body));
    assert.ok(v.includes(detail.articleBrief!.targetQuery.replace(/&/g, '&')), 'the search phrase is shown');
    assert.match(r.body, /<details class="ap-fold sp" id="seo" open>/);
    assert.doesNotMatch(panelOf(r.body), SECRET_WORDS);
  }
  // A test double engine without the brief (older articles) still renders.
  const s = showcase('busy');
  const r = await call(s.service, identity(), 'GET', `/portal/seo-blog/b/${BRAND_ID}/articles/${articleId(1)}`, {});
  assert.equal(r.status, 200);
});

test('the headline never overstates: in each of the review\'s twelve states, really making the listed changes reaches at least the promised score', () => {
  let promised = 0, n = 100;
  for (const [name, d] of Object.entries(LS.states())) {
    const l = LS.lead(d);
    assert.ok(Number.isFinite(l.score), name);
    if (l.to === null) { assert.ok(l.capNote || /help most|Every check passes|left to improve/.test(l.headline), `${name}: ${l.headline}`); continue; }
    let body = d.version.body;
    for (const raw of l.names) {
      const k = raw.replace(' [NO LINK]', '');
      assert.ok(LS.FIX[k], `${name}: no change written for "${k}"`);
      assert.ok(!raw.includes('[NO LINK]'), `${name}: "${k}" is listed without a link to make the change`);
      body = LS.FIX[k]!(body);
    }
    const v = fx.version(n++ % 9 + 1, body); (v as { id: string }).id = `9000000${n}-bbbb-4ccc-8ddd-0000000000${n}`;
    const ran = d.article.checks && d.article.checks.versionId === d.version.id;
    const after = LS.lead({ ...d, article: { ...d.article, currentVersionId: v.id, ...(d.article.publishedVersionId ? { publishedVersionId: v.id } : {}), checks: ran ? { ...d.article.checks, versionId: v.id } : d.article.checks }, version: v, versions: [v] });
    assert.ok(after.score >= l.to!, `${name}: promised ${l.from} to ${l.to}, really ${after.score}`);
    promised++;
  }
  assert.ok(promised >= 8, `${promised} states made a promise`);
});

test('every cap state: the panel stays read-only, names no supplier, method or model, escapes hostile text, and says the cap plainly', () => {
  const hostile = (b: ReturnType<typeof fx.body>) => ({ ...b, seoTitle: `${b.seoTitle} ${HOSTILE}`, metaDescription: `${b.metaDescription} ${HOSTILE}`, image: { kind: 'brand_asset', url: 'https://x.example/a.jpg', alt: HOSTILE, provenance: '', width: null, height: null } });
  const bodies: [string, ReturnType<typeof fx.body>, RegExp][] = [
    ['repetition', R.spunArticle(12), /The wording repeats itself a lot, so the score stays at 40 or below until it reads naturally\./],
    ['some repetition', R2.make(R2.GEN.platitude), /Parts of the wording repeat earlier sentences, so the score stays at 70 or below until each part says something new\./],
    ['not sentences', R.wordSalad(), /The text does not read as ordinary sentences: it has very few of the small words/],
    ['stuffing', R2.strongPlusPhrase(16), /The search phrase comes up far too often, so the score stays at 60 or below until it is used naturally\./],
    ['short items', R3.BULLET_ATTACKS.find(([n]) => n.startsWith('X3b'))![1](), /Much of the article is short list items rather than sentences, so the score stays at 70 or below until more of it is written out in full sentences\./],
    ['run-on', RB4.RUBBISH4.find(([n]) => /run-on/.test(n))![1](), /Some of the text runs on without a full stop for a very long way, so the score stays at 70 or below until it is written in sentences of a readable length\./],
  ];
  for (const [kind, raw, sentence] of bodies) for (const shell of [fx.shell(), newLook()]) {
    const v = fx.version(3, hostile(raw) as never);
    const html = editorPage(shell, { ...fx.pageData('ready'), version: v, versions: [v], article: fx.article({ currentVersionId: v.id, checks: { versionId: v.id, contentSha: v.contentSha, factsSha: 'f'.repeat(64), ranAt: '2026-11-13T09:00:00.000Z', status: 'passed', issues: [] } as never }), articleBrief: sp.brief(), open: ['seo'] });
    const panel = panelOf(html);
    assert.match(visible(panel), sentence, kind);
    assert.doesNotMatch(panel, /data-primary|ap-primary|ca-btn|<form|<input|<button|<select|<textarea/, kind);
    assert.doesNotMatch(panel, SECRET_WORDS, kind);
    assert.doesNotMatch(visible(panel), /[–—]|n-gram|function word|threshold|measure/, `${kind}: plain words only`);
    assert.doesNotMatch(panel, /<script|<img src=x|"quotes"/, `${kind}: escaped`);
    assert.match(panel, /&lt;script&gt;/);
  }
});
