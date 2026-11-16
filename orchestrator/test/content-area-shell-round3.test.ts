/**
 * Round 3 of the content area shell (preview on only): the amber primary really renders amber, stopped writing always
 * needs the owner, "We will fill this" uses the engine's own planning estimates, a held autopilot says so everywhere,
 * and the small wording fixes. One test per item, using the reviewer's states.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { OWNER } from './seo-blog-fixtures.js';
import { websiteFixture } from './seo-blog-website-fixtures.js';
import * as fx from './seo-blog-article-page-fixtures.js';
import { USAGE_ESTIMATES } from '../src/seo-blog/engine.js';
import { articleId, BRAND_ID, call, identity, NOW, showcase, type Scenario, type Showcase } from './content-area-shell-fixtures.js';

const B = `/portal/seo-blog/b/${BRAND_ID}`;
const ON = { headers: { cookie: 'r72_content_look=new' }, input: { contentAreaPreview: 'enabled' } };
const visible = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const mainOf = (html: string) => /<main id="ca-main"[^>]*>([\s\S]*?)<\/main>/.exec(html)![1]!;
const sideOf = (html: string) => /<aside class="ca-side"[\s\S]*?<\/aside>/.exec(html)![0];
const badge = (html: string) => Number(/class="ca-count" aria-label="(\d+) need you"/.exec(html)?.[1] ?? 0);
const hero = (html: string) => visible(/<section class="ca-hero[\s\S]*?<\/section>/.exec(html)![0]);
const row = (s: Showcase, n: number) => s.rows.find((r) => r.article.id === articleId(n))!;
const patch = (s: Showcase, n: number, p: object) => { const r = row(s, n); r.article = { ...r.article, ...p }; };
const job = (s: Showcase, p: object) => { s.jobs[0] = { ...s.jobs[0]!, ...p }; };

// The tests decide the switch themselves (a build machine may have CONTENT_AREA_PREVIEW=enabled in its environment).
delete process.env.CONTENT_AREA_PREVIEW;

const STATES: Record<string, { scenario: Scenario; settings?: object; mut?: (s: Showcase) => void }> = {
  busy: { scenario: 'busy' },
  calm: { scenario: 'calm' },
  'writing-failed-job': { scenario: 'calm', mut: (s) => job(s, { state: 'failed', error: 'TypeError: cannot read properties of undefined' }) },
  'writing-blocked-allowance': { scenario: 'calm', mut: (s) => job(s, { state: 'blocked', error: 'The monthly writing allowance is used up.' }) },
  'writing-cancelled': { scenario: 'calm', mut: (s) => job(s, { state: 'cancelled' }) },
  'writing-service-not-connected': { scenario: 'calm', mut: (s) => job(s, { state: 'blocked', error: 'Generation is not configured. Connect a model provider.' }) },
  'writing-stopped-no-job': { scenario: 'calm', mut: (s) => { s.jobs.length = 0; patch(s, 13, { editorialState: 'failed', failure: 'The model returned an unusable draft.' }); } },
  'writing-done-but-failed': { scenario: 'calm', mut: (s) => { job(s, { state: 'done' }); patch(s, 13, { editorialState: 'failed', failure: null }); } },
  'website-disconnected': { scenario: 'calm', mut: (s) => { s.destinations = [{ ...fx.destination, status: 'failed' }]; } },
  'website-removed': { scenario: 'calm', mut: (s) => { s.destinations = []; } },
  paused: { scenario: 'busy', settings: { pauseAll: true } },
  'held-missed': { scenario: 'calm', mut: (s) => patch(s, 6, { hold: { reason: 'missed_window', detail: 'x', at: '2026-11-14T10:00:00.000Z' }, schedule: null }) },
  'held-owner': { scenario: 'calm', mut: (s) => patch(s, 6, { hold: { reason: 'owner', detail: null, at: '2026-11-14T10:00:00.000Z' } }) },
  'delivery-failed': { scenario: 'calm', mut: (s) => patch(s, 6, { delivery: 'failed', failure: 'HTTP 502', schedule: null }) },
  'dna-proposed': { scenario: 'new', mut: (s) => { s.dna = 'proposed'; } },
  'brand-new': { scenario: 'new', mut: (s) => { s.dna = 'none'; } },
  'fill-zero-allowance': { scenario: 'calm', settings: { budgets: { modelTokensPerMonth: 0, searchCallsPerMonth: 0, imagesPerMonth: 0 } } },
  'fill-tokens-35000-left': { scenario: 'calm', mut: (s) => { s.usage = { ...s.usage, model_tokens: 2_000_000 - 35_000 }; } },
  'fill-searches-3-left': { scenario: 'calm', mut: (s) => { s.usage = { ...s.usage, search_calls: 197 }; } },
  'fill-research-hold': { scenario: 'calm', settings: { programme: { researchHold: { jobId: 'x', at: '2026-11-15T00:00:00.000Z', reason: 'supplier' } } } },
  'fill-plan-proposed': { scenario: 'calm', mut: (s) => { s.planStatus = 'proposed'; } },
  'fill-dna-unconfirmed': { scenario: 'calm', mut: (s) => { s.dna = 'proposed'; } },
  'fill-backlog-1': { scenario: 'calm', settings: { backlogCeiling: 1 } },
  'time-passed-both': { scenario: 'calm', mut: (s) => { for (const n of [6, 7]) patch(s, n, { schedule: { ...row(s, n).article.schedule!, publishAtUtc: '2026-11-13T09:00:00.000Z', localDate: '2026-11-13' } }); } },
};
function make(name: string): Showcase {
  const st = STATES[name]!;
  const s = showcase(st.scenario, st.settings ?? {});
  st.mut?.(s);
  return s;
}
async function page(name: string | Showcase, path: string) {
  const s = typeof name === 'string' ? make(name) : name;
  return (await call(s.service, identity(), 'GET', `${B}/${path}`, ON)).body;
}
async function during<T>(fn: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  try { return await fn(); } finally { mock.timers.reset(); }
}

/** Relative luminance contrast of two CSS rgb() colours. */
function contrast(a: string, b: string): number {
  const lum = (c: string) => { const [r, g, bl] = (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!; };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

test('1. every hero\'s primary action renders amber in Chromium, light and dark, with readable text', async (t) => {
  let chromium: { launch: () => Promise<any> } | null = null;
  try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch { /* not installed here */ }
  if (!chromium) return t.skip('Playwright is not installed on this machine');
  const pages = await during(async () => {
    const out: [string, string][] = [];
    // (Stopped writing with no button of its own has no amber action since round 4: see content-area-shell-round4.test.ts.)
    for (const name of ['busy', 'writing-failed-job', 'writing-blocked-allowance', 'website-disconnected', 'website-removed', 'paused', 'held-missed', 'held-owner', 'delivery-failed', 'dna-proposed', 'brand-new', 'fill-zero-allowance', 'fill-plan-proposed']) {
      out.push([`${name} home`, await page(name, 'overview')]);
    }
    out.push(['busy calendar', await page('busy', 'calendar')], ['busy articles', await page('busy', 'articles')], ['brand-new articles', await page('brand-new', 'articles')]);
    return out;
  });
  const browser = await chromium.launch();
  try {
    for (const scheme of ['light', 'dark'] as const) {
      const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });
      const tab = await ctx.newPage();
      for (const [name, html] of pages) {
        await tab.setContent(html.replace(/<script[^>]*><\/script>/g, ''));
        const found = await tab.evaluate(() => {
          const el = document.querySelector('main [data-primary]');
          if (!el) return null;
          const s = getComputedStyle(el);
          return { bg: s.backgroundColor, fg: s.color, tag: el.tagName };
        });
        assert.ok(found, `${scheme} ${name}: a primary action`);
        assert.equal(found!.bg, 'rgb(242, 180, 65)', `${scheme} ${name}: the ${found!.tag.toLowerCase()} is amber`);
        assert.ok(contrast(found!.bg, found!.fg) >= 4.5, `${scheme} ${name}: text contrast ${contrast(found!.bg, found!.fg).toFixed(2)}`);
      }
      await ctx.close();
    }
  } finally { await browser.close(); }
});

test('2. stopped writing with a button of its own needs the owner: the row\'s own words and that button, never "all clear"', () => during(async () => {
  // Stopped writing with no button of its own (cancelled, stopped, service not connected) is covered by round 4:
  // it is listed under "Stopped", ranks below reading and stays off the badge.
  const cases: [string, RegExp, RegExp, RegExp][] = [
    ['writing-failed-job', /Writing has stopped/, /Paused: something stopped it before it finished/, /<button type="submit" class="ca-btn" data-primary>Try again<\/button>/],
    ['writing-blocked-allowance', /Writing has stopped/, /Paused: waiting for more writing allowance this month/, /publishing#writing-budget" data-primary>Check the allowance/],
  ];
  for (const [name, title, words, action] of cases) {
    const home = await page(name, 'overview');
    const text = visible(mainOf(home));
    assert.doesNotMatch(text, /All clear|Everything is running|being written; we will show it here/, name);
    assert.match(hero(home), title, name);
    assert.match(hero(home), words, name);
    assert.match(mainOf(home), action, name);
    assert.equal(badge(home), 1, `${name}: counted`);
    const list = await page(name, 'articles');
    assert.match(visible(list), /Needs you : 1/, `${name}: under "Needs you" in Articles`);
    assert.match(visible(list), new RegExp(words.source.split('\\.')[0]!), `${name}: the same words in the Articles row`);
  }
}));

test('3. "We will fill this" uses the engine\'s own planning estimates (35,000 tokens or 3 searches left is not enough)', () => during(async () => {
  assert.ok(USAGE_ESTIMATES.plan > 35_000 && USAGE_ESTIMATES.searchPerPlan > 3, 'the engine estimates this test relies on');
  for (const name of ['fill-tokens-35000-left', 'fill-searches-3-left', 'fill-zero-allowance']) {
    const cal = await page(name, 'calendar');
    assert.doesNotMatch(mainOf(cal), /We will fill this/, name);
    assert.match(mainOf(cal), /Free publishing day/, name);
    assert.match(visible(cal), /not filled until there is enough writing and research allowance left this month/, name);
  }
  assert.match(mainOf(await page('calm', 'calendar')), /We will fill this/, 'with allowance left it still fills');
}));

test('3b. the real engine over six simulated days: 35,000 tokens or 3 searches left writes nothing, and the calendar says so', async () => {
  for (const [label, kind] of [['35,000 writing tokens left', 'tokens'], ['3 research calls left', 'searches']] as const) {
    const f = await websiteFixture();
    mock.timers.enable({ apis: ['Date'], now: f.h.clock.ms });
    try {
      const e = f.h.engine;
      const b0 = await e.getBrand(OWNER, f.brand.id);
      const used = await e.usage(OWNER, b0.id);
      const budgets = kind === 'tokens' ? { modelTokensPerMonth: used.model_tokens + 35_000, searchCallsPerMonth: 100, imagesPerMonth: 0 } : { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: used.search_calls + 3, imagesPerMonth: 0 };
      await e.updateSettings(OWNER, b0.id, b0.rowVersion, { ongoingProduction: true, autoAcceptPlans: true, budgets } as never);
      const service = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => e, socialCallback: async () => null } as unknown as Parameters<typeof call>[0];
      const calendar = async () => (await call(service, identity(OWNER.userId), 'GET', `/portal/seo-blog/b/${f.brand.id}/calendar`, ON)).body;
      const before = await calendar();
      assert.doesNotMatch(mainOf(before), /We will fill this/, `${label}: before`);
      assert.match(mainOf(before), /Free publishing day/, `${label}: before`);
      assert.match(visible(before), /enough writing and research allowance/, `${label}: the allowance reason`);
      // Topics already accepted may still be written; what fills an empty day is a new topic with a date on it, and none
      // is given one (with 3 searches left the engine saves a plan whose topics are all postponed, then holds research).
      const dated = async () => (await e.listPlans(OWNER, b0.id)).flatMap((p) => p.briefs).filter((x) => (x as { suggestedAtUtc?: string | null }).suggestedAtUtc).map((x) => x.id).sort();
      const dated0 = await dated();
      for (let d = 0; d < 6; d++) { await e.runDaily(b0.id); for (let i = 0; i < 8; i++) await e.tick(`w${d}-${i}`); f.h.clock.advance(86_400_000); mock.timers.setTime(f.h.clock.ms); }
      assert.deepEqual(await dated(), dated0, `${label}: no new topic was given an empty day`);
      assert.doesNotMatch(mainOf(await calendar()), /We will fill this/, `${label}: after six days`);
    } finally { mock.timers.reset(); }
  }
});

test('4. a held autopilot says so in the sidebar, on Home and on the Calendar, with the reason and where to fix it', () => during(async () => {
  const cases: [string, RegExp, RegExp, RegExp][] = [
    ['fill-zero-allowance', /Autopilot is waiting for allowance/, /not enough writing or research allowance left this month/, /publishing#writing-budget/],
    ['fill-tokens-35000-left', /Autopilot is waiting for allowance/, /not enough writing or research allowance/, /publishing#writing-budget/],
    ['fill-research-hold', /Autopilot is waiting for you in Topics/, /Research is on hold until you look at it/, /topics#research-status/],
    ['fill-plan-proposed', /Autopilot is waiting for you in Topics/, /Suggested topics are waiting for you to accept them/, /\/topics"/],
    ['fill-dna-unconfirmed', /Autopilot is waiting for your Brand DNA/, /until your Brand DNA is confirmed/, /\/dna"/],
  ];
  for (const [name, title, reason, where] of cases) {
    for (const p of ['overview', 'calendar', 'articles']) {
      const side = visible(sideOf(await page(name, p)));
      assert.doesNotMatch(side, /Autopilot is on|We plan and write for your publishing days/, `${name} ${p}: sidebar`);
      assert.match(side, title, `${name} ${p}: sidebar title`);
      assert.match(side, reason, `${name} ${p}: sidebar reason`);
      assert.match(sideOf(await page(name, p)), where, `${name} ${p}: where to fix it`);
    }
    const home = await page(name, 'overview');
    assert.doesNotMatch(visible(mainOf(home)), /Everything is running|All clear/, `${name}: Home`);
    if (name !== 'fill-dna-unconfirmed') { assert.match(hero(home), title, `${name}: Home hero`); assert.match(hero(home), reason, `${name}: Home reason`); }
    const cal = await page(name, 'calendar');
    assert.doesNotMatch(mainOf(cal), /We will fill this/, `${name}: Calendar`);
  }
  // Running normally it is still "on".
  assert.match(visible(sideOf(await page('calm', 'overview'))), /Autopilot is on/);
  assert.match(visible(mainOf(await page('calm', 'overview'))), /Everything is running/);
}));

test('5. a zero allowance gives the allowance reason, not "set-up is finished"', () => during(async () => {
  const cal = await page('fill-zero-allowance', 'calendar');
  assert.doesNotMatch(visible(cal), /set-up is finished/);
  assert.match(visible(cal), /allowance left this month/);
}));

test('6. small words: plurals, the Articles button, a removed website, and articles going out right now', () => during(async () => {
  // Two scheduled, one being written and its running write task: four, as the engine counts them.
  assert.match(visible(await page('fill-backlog-1', 'calendar')), /while 4 unpublished articles are waiting \(your limit is 1\)/);
  // Only the article being written (no task left): one, in the singular.
  const s1 = make('fill-backlog-1');
  s1.jobs.length = 0;
  for (const r of s1.rows) if (r.article.id === articleId(6) || r.article.id === articleId(7)) r.article = { ...r.article, delivery: 'published', publishedVersionId: r.article.currentVersionId, publishedAt: '2026-11-10T09:00:00.000Z' };
  assert.match(visible(await page(s1, 'calendar')), /while 1 unpublished article is waiting \(your limit is 1\)/);
  // The Articles header button opens a stopped article; it does not say "Read it" for something not written yet.
  const list = await page('writing-failed-job', 'articles');
  assert.match(list, /data-primary>Open it /);
  assert.doesNotMatch(list, /data-primary>Read it/);
  // A website that was removed has no name: say so. With no other website connected, the step is connecting one (round 4).
  const removed = await page('website-removed', 'overview');
  assert.doesNotMatch(visible(removed), /a website that was removed/);
  assert.match(hero(removed), /was planned for a website that has been removed, and no other website is connected/);
  assert.match(mainOf(removed), /setup#website-connection" data-primary>Connect your website/);
  assert.match(visible(await page('website-removed', 'articles')), /Planned for a website that has been removed/);
  // Only articles due right now: Home says they are going out now.
  const due = await page('time-passed-both', 'overview');
  assert.doesNotMatch(visible(due), /Nothing is booked to go out yet/);
  assert.match(hero(due), /“What a lender’s valuer looks for” is going out now\./);
}));
