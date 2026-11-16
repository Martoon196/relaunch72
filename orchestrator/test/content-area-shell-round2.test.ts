/**
 * Round 2 of the content area shell (preview on only): the shell never says something the article page or the engine
 * would contradict. One test per item of the review, using the reviewer's states.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER, STRANGER } from './seo-blog-fixtures.js';
import { websiteFixture } from './seo-blog-website-fixtures.js';
import * as fx from './seo-blog-article-page-fixtures.js';
import { portalCsrfToken } from '../src/portal/session.js';
import { CONTENT_AREA_CSS } from '../src/portal/content-area-layout.js';
import { articleId, BRAND_ID, call, identity, NOW, SECRET, showcase, type Scenario, type Showcase } from './content-area-shell-fixtures.js';

const B = `/portal/seo-blog/b/${BRAND_ID}`;
const ON = { headers: { cookie: 'r72_content_look=new' }, input: { contentAreaPreview: 'enabled' } };
const visible = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const mainOf = (html: string) => /<main id="ca-main"[^>]*>([\s\S]*?)<\/main>/.exec(html)![1]!;
const badge = (html: string) => Number(/class="ca-count" aria-label="(\d+) need you"/.exec(html)?.[1] ?? 0);
const hero = (html: string) => visible(/<section class="ca-hero[\s\S]*?<\/section>/.exec(html)![0]);
const primary = (html: string) => /<(?:a|button)[^>]*data-primary[^>]*>[\s\S]*?<\/(?:a|button)>/.exec(mainOf(html))?.[0] ?? '';

const row = (s: Showcase, n: number) => s.rows.find((r) => r.article.id === articleId(n))!;
const patch = (s: Showcase, n: number, p: object) => { const r = row(s, n); r.article = { ...r.article, ...p }; };

/** The reviewer's states (shell-review/scripts/states.mts), as showcase mutations. */
// The tests decide the switch themselves (a build machine may have CONTENT_AREA_PREVIEW=enabled in its environment).
delete process.env.CONTENT_AREA_PREVIEW;

const STATES: Record<string, { scenario: Scenario; settings?: object; mut?: (s: Showcase) => void }> = {
  busy: { scenario: 'busy' },
  calm: { scenario: 'calm' },
  'website-disconnected-calm': { scenario: 'calm', mut: (s) => { s.destinations = [{ ...fx.destination, status: 'failed', statusDetail: 'The website refused the key.' }]; } },
  'website-disconnected-busy': { scenario: 'busy', mut: (s) => { s.destinations = [{ ...fx.destination, status: 'failed', statusDetail: 'The website refused the key.' }]; } },
  'writing-failed-job': { scenario: 'calm', mut: (s) => { s.jobs[0] = { ...s.jobs[0]!, state: 'failed', error: 'TypeError: cannot read properties of undefined (reading id) at engine.ts:1234' }; } },
  'writing-blocked-allowance': { scenario: 'calm', mut: (s) => { s.jobs[0] = { ...s.jobs[0]!, state: 'blocked', error: 'The monthly writing allowance is used up.' }; } },
  'paused-busy': { scenario: 'busy', settings: { pauseAll: true } },
  'paused-calm': { scenario: 'calm', settings: { pauseAll: true } },
  'auto-on-busy': { scenario: 'busy', settings: { autoPublish: true } },
  'held-missed': { scenario: 'calm', mut: (s) => patch(s, 6, { hold: { reason: 'missed_window', detail: 'internal: window missed by scheduler tick 9931', at: '2026-11-14T10:00:00.000Z' }, schedule: null }) },
  'held-owner': { scenario: 'calm', mut: (s) => patch(s, 6, { hold: { reason: 'owner', detail: null, at: '2026-11-14T10:00:00.000Z' } }) },
  'delivery-failed': { scenario: 'calm', mut: (s) => patch(s, 6, { delivery: 'failed', failure: 'HTTP 502 from content API endpoint (req 7f3a)', schedule: null }) },
  'delivery-unknown': { scenario: 'calm', mut: (s) => patch(s, 6, { delivery: 'unknown' }) },
  'time-passed-approved': { scenario: 'calm', mut: (s) => patch(s, 6, { schedule: { ...row(s, 6).article.schedule!, publishAtUtc: '2026-11-13T09:00:00.000Z', localDate: '2026-11-13' } }) },
  'new-dna-proposed': { scenario: 'new', mut: (s) => { s.dna = 'proposed'; } },
  'new-dna-none': { scenario: 'new', mut: (s) => { s.dna = 'none'; } },
  'calm-dna-out-of-date': { scenario: 'calm', mut: (s) => { s.dna = 'out_of_date'; } },
  'no-weekdays': { scenario: 'calm', settings: { cadence: { weekdays: [], localTime: '09:00', perWeek: 3 } } },
  'bad-timezone': { scenario: 'busy', mut: (s) => { (s.brand as { timezone: string }).timezone = 'Mars/Olympus'; } },
};

function make(name: string, extra: object = {}): Showcase {
  const st = STATES[name]!;
  const s = showcase(st.scenario, { ...(st.settings ?? {}), ...extra });
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

test('1. never "all clear" while a website is disconnected or writing has stopped: counted, named, with the real action', () => during(async () => {
  const calm = await page('website-disconnected-calm', 'overview');
  assert.doesNotMatch(visible(calm), /All clear|Nothing needs you today|Everything is running/);
  assert.match(hero(calm), /Your website is not connected/);
  assert.match(hero(calm), /“What a lender’s valuer looks for” was planned for martinhowardproperty\.example, which is not connected any more/);
  assert.match(primary(calm), /href="[^"]+\/setup#website-connection" data-primary>Check the connection to martinhowardproperty\.example/);
  assert.equal(badge(calm), 2, 'both scheduled articles need him');
  // The article page agrees: its main action is the same connection check.
  const article = await page('website-disconnected-calm', `articles/${articleId(6)}`);
  assert.match(article, /data-primary href="[^"]+\/setup#websites">Check the connection to martinhowardproperty\.example/);
  const busy = await page('website-disconnected-busy', 'overview');
  assert.equal(badge(busy), 7, 'five to read and two on the disconnected website');
  assert.match(hero(busy), /Your website is not connected[\s\S]*6 more need you in Articles/);
  const list = await page('website-disconnected-calm', 'articles');
  assert.match(visible(list), /Needs you : 2/);
  assert.match(list, /href="[^"]+\/setup#website-connection">Check the connection to martinhowardproperty\.example/);
  const cal = await page('website-disconnected-calm', 'calendar');
  assert.doesNotMatch(cal, /Goes out 9:00/, 'not "going out" on a website that is not connected');

  const stopped = await page('writing-blocked-allowance', 'overview');
  assert.doesNotMatch(visible(stopped), /All clear|Nothing needs you today/);
  assert.match(hero(stopped), /Writing has stopped/);
  assert.match(hero(stopped), /Paused: waiting for more writing allowance this month/);
  assert.match(primary(stopped), /publishing#writing-budget" data-primary>Check the allowance/);
  assert.equal(badge(stopped), 1);
  const failed = await page('writing-failed-job', 'overview');
  assert.match(hero(failed), /Writing has stopped/);
  assert.match(mainOf(failed), /<form method="post" action="[^"]+\/jobs\/cccccccc-1111-4222-8333-444455556666\/retry" class="ca-hero-form"><input type="hidden" name="_csrf" value="[^"]+"><input type="hidden" name="back" value="articles"><button type="submit" class="ca-btn" data-primary>Try again<\/button>/);
  assert.doesNotMatch(visible(failed), /TypeError|engine\.ts/, 'no technical error text');
  assert.equal(badge(failed), 1);
}));

test('2. "We will fill this" only when the engine really will write for that day (stub states and the real engine)', () => during(async () => {
  const fills = (html: string) => (mainOf(html).match(/We will fill this/g) ?? []).length;
  const free = (html: string) => (mainOf(html).match(/Free publishing day/g) ?? []).length;
  const ready = await page('busy', 'calendar');
  assert.ok(fills(ready) > 0, 'everything in place: the days ahead are filled');
  assert.match(visible(ready), /Empty publishing days up to 30 days ahead fill themselves/);
  const cases: [string, Showcase, RegExp][] = [
    ['production off', make('busy', { ongoingProduction: false }), /stay empty until you choose topics/],
    ['plans need the owner to accept them', make('busy', { autoAcceptPlans: false }), /not filled until you accept new topics in Topics/],
    ['no allowance left', (() => { const s = make('busy'); s.usage = { model_tokens: 2_000_000, search_calls: 37, images: 4 }; return s; })(), /not filled until there is enough writing and research allowance left/],
    ['no research allowance left', (() => { const s = make('busy'); s.usage = { model_tokens: 0, search_calls: 200, images: 0 }; return s; })(), /not filled until there is enough writing and research allowance left/],
    ['backlog ceiling reached', make('busy', { backlogCeiling: 8 }), /not filled while 9 unpublished articles are waiting \(your limit is 8\)/],
    ['a suggested plan waits for the owner', (() => { const s = make('busy'); s.planStatus = 'proposed'; return s; })(), /until you accept the topics already suggested/],
    ['research hold', make('busy', { programme: { researchHold: { jobId: 'x', reason: 'r', at: NOW } } }), /look at the research hold/],
    ['Brand DNA waiting', (() => { const s = make('busy'); s.dna = 'proposed'; return s; })(), /until your Brand DNA is confirmed/],
    ['brand-new business without Brand DNA', make('new-dna-none'), /until your Brand DNA is confirmed/],
    ['paused', make('busy', { pauseAll: true }), /Publishing is paused/],
  ];
  for (const [label, s, line] of cases) {
    const html = await page(s, 'calendar');
    assert.equal(fills(html), 0, label);
    assert.match(visible(html), line, label);
    if (label !== 'paused') assert.ok(free(html) > 0, `${label}: the empty days say "Free publishing day"`);
    const home = await page(s, 'overview');
    assert.doesNotMatch(visible(home), /fill themselves/, label);
  }
  // The real engine: the fixture business (plans need acceptance by default), no allowance, a zero backlog ceiling.
  for (const [label, settings] of [['defaults', { ongoingProduction: true }], ['no allowance', { ongoingProduction: true, autoAcceptPlans: true, budgets: { modelTokensPerMonth: 0, searchCallsPerMonth: 0, imagesPerMonth: 0 } }],
    ['backlog ceiling 0', { ongoingProduction: true, autoAcceptPlans: true, backlogCeiling: 0 }]] as const) {
    const f = await websiteFixture();
    const b = await f.h.engine.getBrand(OWNER, f.brand.id);
    await f.h.engine.updateSettings(OWNER, b.id, b.rowVersion, settings as never);
    const service = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => f.h.engine, socialCallback: async () => null } as unknown as Parameters<typeof call>[0];
    const html = (await call(service, identity(OWNER.userId), 'GET', `/portal/seo-blog/b/${f.brand.id}/calendar`, ON)).body;
    assert.equal(fills(html), 0, `real engine: ${label}`);
  }
}));

test('3. the automatic-publishing sentence says what the engine does: approval waived, a time still needed', () => during(async () => {
  const html = await page('auto-on-busy', 'overview');
  assert.doesNotMatch(visible(html), /go out on their own/);
  assert.match(visible(html), /Articles with a time go out then without waiting for your approval\. An article with no time waits for you\./);
  assert.match(visible(await page('busy', 'overview')), /Nothing goes out until you say yes\./);
}));

test('4. paused, failed delivery, held and Brand DNA each get their own hero and action; no past "Next out"; "being checked" is not "going out"', () => during(async () => {
  const paused = await page('paused-busy', 'overview');
  assert.match(hero(paused), /Publishing is paused/);
  assert.match(primary(paused), /publishing#pause" data-primary>Switch publishing back on/);
  assert.equal(badge(paused), 5, 'approved and scheduled articles are not counted as waiting for him');
  const pausedCalm = await page('paused-calm', 'overview');
  assert.equal(badge(pausedCalm), 0);
  assert.match(primary(pausedCalm), /Switch publishing back on/);
  assert.match(primary(await page('paused-calm', 'calendar')), /Switch publishing back on/);
  assert.doesNotMatch(mainOf(await page('paused-calm', 'calendar')), /Goes out|Going out now/);

  const failed = await page('delivery-failed', 'overview');
  assert.match(hero(failed), /An article did not reach your website/);
  assert.match(hero(failed), /“What a lender’s valuer looks for”: It did not reach your website last time\./);
  assert.doesNotMatch(visible(failed), /HTTP 502|req 7f3a/);
  assert.match(primary(failed), /articles\/a0000000-0000-4000-8000-000000000006" data-primary>Open it and try again/);
  assert.equal(badge(failed), 1);

  const held = await page('held-missed', 'overview');
  assert.match(hero(held), /An article is on hold/);
  assert.doesNotMatch(visible(held), /scheduler tick|internal:/);
  assert.equal(badge(held), 1);
  const owner = await page('held-owner', 'overview');
  assert.match(hero(owner), /waiting for your go-ahead[\s\S]*You asked for this not to go out yet/);
  assert.equal(badge(owner), 1);

  const passed = await page('time-passed-approved', 'overview');
  assert.doesNotMatch(visible(passed), /Next out: “What a lender’s valuer looks for”/, 'never a past date');
  assert.match(visible(passed), /Next out: “Rental yield: gross, net and what really matters” on Friday 20 November at 9:00\./);
  const checking = await page('delivery-unknown', 'calendar');
  const day18 = /<span class="ca-sr">Wednesday 18 November<\/span>[\s\S]*?<\/li>/.exec(checking)![0];
  assert.match(day18, /Being checked/);
  assert.doesNotMatch(day18, /Going out now/);

  const proposed = await page('new-dna-proposed', 'overview');
  assert.match(hero(proposed), /Check your Brand DNA card/);
  assert.match(primary(proposed), /\/dna" data-primary>Check your Brand DNA card/);
  assert.doesNotMatch(visible(proposed), /Start with your website/);
  const stale = await page('calm-dna-out-of-date', 'overview');
  assert.match(hero(stale), /Your Brand DNA is out of date/);
  assert.match(primary(stale), /\/dna" data-primary>Look at your Brand DNA/);
  assert.doesNotMatch(visible(stale), /All clear/);
  assert.match(primary(await page('new-dna-none', 'overview')), /\/dna" data-primary>Start with your website/);
  // Unusual settings still render.
  for (const name of ['no-weekdays', 'bad-timezone']) for (const p of ['overview', 'calendar', 'articles']) assert.ok((await page(name, p)).includes('ca-main'), `${name} ${p}`);
  assert.match(visible(await page('no-weekdays', 'calendar')), /No publishing days are set\./);
}));

test('5. on a phone the shell is a plain block, so wrapped pages fit as they did', () => {
  const phone = /@media \(max-width:700px\)\{([\s\S]*?)\n\}/.exec(CONTENT_AREA_CSS)![1]!;
  assert.match(phone, /\.ca-app\{display:block;/);
});

test('6. contrast: the switcher button, the old diary\'s current view and the articles summary line', () => {
  assert.match(CONTENT_AREA_CSS, /\.ca-biz-panel button\{[^}]*background:var\(--ca-deep\);color:var\(--ca-on-deep\)/);
  assert.match(CONTENT_AREA_CSS, /\.ca-main \.view-switch a\[aria-current=page\]\{background:var\(--ca-glow\);color:var\(--ca-ink\)\}/);
});

test('7. true button words, the diary returns to itself, the menus close, week rows read well, one read per page', () => during(async () => {
  const cal = await page('busy', 'calendar');
  assert.match(primary(cal), /Start with the first of the 5 that need you/);
  // After a move in the existing diary the page comes back with its message: that is the diary, not the month view.
  const diary = await page('busy', 'calendar?n=bm90ZQ&s=x');
  assert.match(diary, /<h1>Content calendar<\/h1>/);
  assert.match(diary, /class="ca-nav"/);
  const home = await page('busy', 'overview');
  assert.match(home, /<script src="\/portal\/seo-blog\/content-area\.js" defer><\/script>/);
  const script = await call(showcase('busy').service, null, 'GET', '/portal/seo-blog/content-area.js', ON);
  assert.equal(script.status, 200);
  assert.match(script.body, /Escape/);
  assert.match(script.headers['content-type']!, /javascript/);
  assert.match(home, /<a class="ca-wk" href="[^"]+"><span class="ca-sr">Monday 16 November: <\/span><span class="ca-wk-date" aria-hidden="true">/);
  // One read of articles and websites per page, for the badge and the page together.
  const s = showcase('busy');
  const engine = s.service.engineFor(identity(), 'r') as unknown as Record<string, (...a: unknown[]) => unknown>;
  const counts: Record<string, number> = {};
  const counted = new Proxy(engine, { get: (t, k: string) => typeof t[k] === 'function' ? (...a: unknown[]) => { counts[k] = (counts[k] ?? 0) + 1; return t[k]!(...a); } : t[k] });
  for (const p of ['overview', 'calendar', 'articles', 'results']) {
    for (const k of Object.keys(counts)) delete counts[k];
    await call({ ...s.service, engineFor: () => counted as never }, identity(), 'GET', `${B}/${p}`, ON);
    assert.equal(counts.listArticles, 1, `${p}: articles read once`);
    assert.equal(counts.listDestinations, 1, `${p}: websites read once`);
  }
}));

test('8. only someone who manages a business can switch the look on; anyone else gets the same 404 as when it is off', async () => {
  const s = showcase('busy');
  const stranger = identity(STRANGER.userId);
  const lonely = { ...s.service, engineFor: () => ({ ...(s.service.engineFor(stranger, 'r') as object), listBrands: async () => [] }) as never };
  const csrf = portalCsrfToken(SECRET, stranger.sessionToken);
  for (const input of [{ contentAreaPreview: 'enabled' }, {}]) {
    const get = await call(lonely, stranger, 'GET', '/portal/seo-blog/look', { input });
    const post = await call(lonely, stranger, 'POST', '/portal/seo-blog/look', { form: { _csrf: csrf, look: 'new' }, input });
    assert.equal(get.status, 404); assert.equal(post.status, 404); assert.equal(post.headers['set-cookie'], undefined);
    if (!('contentAreaPreview' in input)) continue;
    const off = await call(lonely, stranger, 'GET', '/portal/seo-blog/look', { input: {} });
    assert.equal(get.body, off.body, 'the same 404 as when the preview is off');
  }
  const owner = await call(s.service, identity(), 'POST', '/portal/seo-blog/look', { form: { _csrf: portalCsrfToken(SECRET, identity().sessionToken), look: 'new' }, input: { contentAreaPreview: 'enabled' } });
  assert.equal(owner.status, 303); assert.match(owner.headers['set-cookie']!, /^r72_content_look=new/);
});
