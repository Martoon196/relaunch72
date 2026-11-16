/**
 * Review round 3 of the article page: every new finding, ported.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleSeoBlog } from '../src/portal/seo-blog-router.js';
import { portalCsrfToken } from '../src/portal/session.js';
import type { PortalSeoBlogService } from '../src/portal/seo-blog-service.js';
import type { PortalSessionIdentity } from '../src/portal/auth-service.js';
import { editorPage } from '../src/portal/seo-blog-article-view.js';
import { putBackSentence, restoreCitationsDetailed, withoutCitations } from '../src/seo-blog/citation-edit.js';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { SeoBlogError } from '../src/seo-blog/types.js';
import { OWNER } from './seo-blog-fixtures.js';
import { websiteFixture } from './seo-blog-website-fixtures.js';
import * as fx from './seo-blog-article-page-fixtures.js';

const SECRET = 's'.repeat(48);
const who: PortalSessionIdentity = { sessionToken: `token-${OWNER.userId}`, userId: OWNER.userId, workspaceId: '33333333-3333-4333-8333-333333333333', userEmail: 'owner@example.test' };
const csrf = portalCsrfToken(SECRET, who.sessionToken);
async function call(service: PortalSeoBlogService, method: string, path: string, form?: [string, string][]) {
  const body = form ? new URLSearchParams(form).toString() : '';
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, { method, url: path, headers: { host: 'portal.example', ...(form ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body)), origin: 'https://portal.example' } : {}) } });
  (req as PassThrough).end(body);
  let status = 0; let headers: Record<string, string> = {}; let out = '';
  const res = { writeHead(s: number, h: Record<string, string>) { status = s; headers = h; return res; }, end(chunk?: string) { if (chunk) out += chunk; } } as unknown as ServerResponse;
  await handleSeoBlog(req, res, new URL(path, 'https://portal.example'), { service, identity: who, requestId: `r-${randomUUID()}`, sessionSecret: SECRET, vaultReady: true });
  return { status, headers, body: out };
}
const message = (r: { headers: Record<string, string> }) => { const u = new URL(r.headers.location!, 'https://x'); const m = u.searchParams.get('n') ?? u.searchParams.get('e'); return { ok: u.searchParams.has('n'), text: m ? Buffer.from(m, 'base64url').toString() : '', path: u.pathname }; };
const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const visible = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, '');
const bar = (html: string) => (/<p class="ap-state">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const mainForm = (html: string) => /<form method="post" action="[^"]*\/approve-publish" class="ap-inline">([\s\S]*?)data-primary/.exec(html)?.[1] ?? '';
const field = (formHtml: string, name: string) => unescape(new RegExp(`name="${name}" value="([^"]*)"`).exec(formHtml)?.[1] ?? '');

async function setup() {
  const f = await websiteFixture();
  const service: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => f.h.engine, socialCallback: async () => null };
  const base = `/portal/seo-blog/b/${f.brand.id}/articles/${f.articleId}`;
  const get = () => f.h.engine.getArticle(OWNER, f.brand.id, f.articleId);
  return { f, service, base, get };
}

const press = (formHtml: string): [string, string][] => [['_csrf', csrf], ...[...formHtml.matchAll(/name="([^"]+)" value="([^"]*)"/g)].filter((m) => m[1] !== '_csrf').map((m) => [m[1]!, unescape(m[2]!)] as [string, string])];
const formFor = (html: string, action: string, label: string) => new RegExp(`<form method="post" action="[^"]*/${action}" class="ap-inline">((?:(?!</form>)[\\s\\S])*?)>${label}</button>`).exec(html)?.[1] ?? null;

test('N1: with a time already set, plain approval says when it goes out; with a time just passed it is not offered', async () => {
  const { f, service, base, get } = await setup();
  let a = (await get()).article;
  // No time: "Approve without a date".
  let page = visible((await call(service, 'GET', base)).body);
  assert.match(page, />Approve without a date<\/button><span class="ap-note"> It will not go out until it has a time\.<\/span>/);
  await f.h.engine.schedule(OWNER, f.brand.id, f.articleId, a.rowVersion, { localDate: '2026-11-05', localTime: '09:00', destinationId: f.destination.id });
  page = visible((await call(service, 'GET', base)).body);
  assert.doesNotMatch(page, /Approve without a date/);
  const form = formFor(page, 'approve', 'Approve: it goes out on Thu 5 Nov at 9:00');
  assert.ok(form, 'the item says when it goes out');
  const r = await call(service, 'POST', `${base}/approve`, press(form!));
  assert.equal(message(r).text, 'Approved. It goes out on Thursday 5 November at 9:00.');
  // A time that has just passed, not yet held: no plain approval at all.
  const g = await setup(); a = (await g.get()).article;
  await g.f.h.engine.schedule(OWNER, g.f.brand.id, g.f.articleId, a.rowVersion, { localDate: '2026-11-02', localTime: '10:30', destinationId: g.f.destination.id });
  g.f.h.clock.set('2026-11-02T10:31:00.000Z');
  page = visible((await call(g.service, 'GET', g.base)).body);
  assert.doesNotMatch(page, /\/approve" class="ap-inline">/);
  // Two websites on record: the item names the website.
  const d = fx.pageData('ready'); const second = { ...fx.destination, id: '8f8f8f8f-1111-4222-8333-444455556666', label: 'Key Properties blog', status: 'failed' as const };
  const html = visible(editorPage(fx.shell(), { ...d, destinations: [fx.destination, second], article: { ...d.article, schedule: { publishAtUtc: '2026-11-19T09:00:00.000Z', localDate: '2026-11-19', localTime: '09:00', timezone: 'Europe/London', destinationId: fx.destination.id, setAt: '', setBy: '' } } }));
  assert.match(html, />Approve: it goes out on Thu 19 Nov at 9:00 on martinhowardproperty\.example<\/button>/);
});

test('N2: a time set on a website that is no longer connected is never moved silently', async () => {
  const { f, service, base, get } = await setup();
  const second = await f.h.engine.connectDestination(OWNER, f.brand.id, { type: 'github_static', label: 'Second site', credential: 'gh-token-fixture', config: { repository: 'acme/site', branch: 'main', publicBaseUrl: 'https://harbour.example', blogPath: 'blog', sitemapPath: 'sitemap.xml' } });
  const a = (await get()).article; const v = (await get()).version!;
  await f.h.engine.schedule(OWNER, f.brand.id, f.articleId, a.rowVersion, { localDate: '2026-11-03', localTime: '09:00', destinationId: second.id });
  await f.h.store.saveDestination({ ...(await f.h.store.getDestination(f.brand.id, second.id))!, status: 'failed' });
  const page = visible((await call(service, 'GET', base)).body);
  assert.match(bar(page), /^This was planned for Second site, which is not connected any more\./);
  assert.match(page, /data-primary href="[^"]*setup#websites">Check the connection to Second site</);
  assert.equal((page.match(/data-primary/g) ?? []).length, 1);
  // The engine refuses a press that does not name a website, rather than reroute.
  await assert.rejects(f.h.engine.approveAndSchedule(OWNER, f.brand.id, f.articleId, { versionId: v.id, when: 'next' }), /planned for Second site, which is not connected any more/);
  assert.equal((await get()).article.approval, null);
  // "Publish it on Website instead" names the target and, pressed, schedules there.
  const instead = formFor(page, 'approve-publish', 'Publish it on Website instead');
  assert.ok(instead); assert.equal(field(instead!, 'destinationId'), f.destination.id);
  const r = await call(service, 'POST', `${base}/approve-publish`, press(instead!));
  assert.equal(message(r).text, 'Approved. It goes out on Website on Tuesday 3 November at 9:00.');
  assert.equal((await get()).article.schedule?.destinationId, f.destination.id);
});

test('a: a failed take-back is logged as such and the owner is told the true state', async () => {
  const { f, get } = await setup();
  const v = (await get()).version!;
  const engine = f.h.engine as SeoBlogEngine & { schedule: SeoBlogEngine['schedule'] };
  const store = f.h.store as typeof f.h.store & { updateArticle: typeof f.h.store.updateArticle };
  const real = store.updateArticle.bind(store);
  engine.schedule = async () => { store.updateArticle = async () => { throw new Error('database unavailable'); }; throw new SeoBlogError(409, 'Simulated scheduling refusal.'); };
  await assert.rejects(engine.approveAndSchedule(OWNER, f.brand.id, f.articleId, { versionId: v.id, when: 'next' }), /It is approved but has no time\. Choose a time, or use More › Don’t publish this\./);
  store.updateArticle = real;
  const events = (await f.h.engine.activity(OWNER, f.brand.id)).map((x) => x.kind);
  assert.ok(events.includes('article.approval_withdraw_failed')); assert.ok(!events.includes('article.approval_withdrawn'));
});

test('b: the same press twice gives the same confirmation; after it is live the old press says so', async () => {
  const { f, service, base } = await setup();
  const form = mainForm((await call(service, 'GET', base)).body);
  const first = message(await call(service, 'POST', `${base}/approve-publish`, press(form)));
  const second = message(await call(service, 'POST', `${base}/approve-publish`, press(form)));
  assert.equal(first.text, 'Approved. It goes out on Tuesday 3 November at 9:00.'); assert.deepEqual(second, first);
  const sched = visible((await call(service, 'GET', base)).body);
  const now = formFor(sched, 'approve-publish', 'Publish now')!;
  const n1 = message(await call(service, 'POST', `${base}/approve-publish`, press(now)));
  const n2 = message(await call(service, 'POST', `${base}/approve-publish`, press(now)));
  assert.equal(n1.text, 'It goes onto your website in about 2 minutes.'); assert.deepEqual(n2, n1);
  f.h.clock.set('2026-11-02T10:03:00.000Z'); await f.h.engine.tick('w');
  assert.equal(message(await call(service, 'POST', `${base}/approve-publish`, press(now))).text, 'This article is already live on your website.');
});

test('c: typed or pasted marker text is removed (and said), never wiping the field’s own sources', async () => {
  const A = '[src:5452de1e-e616-492b-8fa5-eb393534457d]', B = '[src:0f9a2b3c-4d5e-4f60-8a1b-2c3d4e5f6a7b]';
  const stored = `Prices rose 5% in 2024 ${A}. The end.`;
  const r = restoreCitationsDetailed(stored, `${withoutCitations(stored)} New claim ${B}. See [src:not a marker].`);
  assert.equal(r.text, `Prices rose 5% in 2024 ${A}. The end. New claim. See.`); assert.equal(r.typedRemoved, 2);
  const { service, base, get } = await setup();
  const page = (await call(service, 'GET', `${base}?edit=1`)).body;
  const form = /<form method="post" action="[^"]*\/edit" id="article-edit"[\s\S]*?<\/form>/.exec(page)![0] + [...page.matchAll(/<input [^>]*form="article-edit"[^>]*>/g)].map((m) => m[0]).join('');
  const fields: [string, string][] = [];
  for (const m of form.matchAll(/<input ([^>]*)>|<textarea ([^>]*)>\n?([\s\S]*?)<\/textarea>/g)) { const attrs = m[1] ?? m[2]!; const name = /name="([^"]*)"/.exec(attrs)?.[1]; if (!name) continue; fields.push([name, name === '_csrf' ? csrf : m[1] !== undefined ? unescape(/value="([^"]*)"/.exec(attrs)?.[1] ?? '') : unescape(m[3]!)]); }
  const before = (await get()).version!;
  const first = fields.findIndex(([k]) => k === 'sectionBody');
  const typed = fields.map(([k, x], i) => [k, i === first ? `${x} ${B}` : x] as [string, string]);
  assert.equal(message(await call(service, 'POST', `${base}/edit`, typed)).text, 'Source links cannot be typed in, so what you typed was removed. Nothing else changed, so nothing was saved.');
  assert.equal((await get()).version!.id, before.id);
});

test('d: "Put the earlier wording back" restores one sentence with its sources, as a new version', async () => {
  const A = '[src:aaa]';
  const earlier = `Intro here. Prices rose 5% in 2024 ${A}. The end is near.`;
  assert.equal(putBackSentence(earlier, 'Intro here. Prices rose 9% in 2024. The end is near.', 1), earlier);
  assert.equal(putBackSentence(earlier, 'Intro here. The end is near.', 1), earlier);
  const { service, base, get } = await setup();
  const v1 = (await get()).version!;
  const cited = /^[^.]*\./.exec(v1.body.sections[0]!.body)![0];
  const page = (await call(service, 'GET', `${base}?edit=1`)).body;
  assert.match(page, /If you change a sentence that has a source, its source can be removed \(you can put the earlier wording back afterwards\), and the article is checked again when you save\./);
  await f2edit(service, base, v1.id, v1.body, v1.body.sections[0]!.body.replace(cited, withoutCitations(cited).replace('30 days', '40 days')));
  const v2 = (await get()).version!; assert.doesNotMatch(v2.body.sections[0]!.body, /\[src:/);
  const read = visible((await call(service, 'GET', base)).body);
  assert.match(read, /<section class="ap-putback" id="put-back"/); assert.match(read, /href="#put-back">Put the earlier wording back</);
  const form = formFor(read, 'put-back', 'Put the earlier wording back')!;
  const r = await call(service, 'POST', `${base}/put-back`, press(form));
  assert.match(message(r).text, /^The earlier wording and its source are back\./);
  const v3 = (await get()).version!; assert.equal(v3.number, v2.number + 1); assert.equal(v3.body.sections[0]!.body, v1.body.sections[0]!.body);
  assert.equal(message(await call(service, 'POST', `${base}/put-back`, press(form))).ok, false, 'an old page cannot do it twice');
});
async function f2edit(service: PortalSeoBlogService, base: string, versionId: string, b: ReturnType<typeof fx.body>, firstBody: string) {
  // As the in-place editor sends it: markers hidden in every text field.
  return call(service, 'POST', `${base}/edit`, [['_csrf', csrf], ['versionId', versionId], ['citationsHidden', '1'], ['title', b.title], ['slug', b.slug], ['seoTitle', b.seoTitle], ['metaDescription', b.metaDescription], ['excerpt', b.excerpt], ['intro', withoutCitations(b.intro)], ['conclusion', withoutCitations(b.conclusion)], ['imageUrl', b.image.url ?? ''], ['imageAlt', b.image.alt],
    ...b.sections.flatMap((s, i) => [['sectionId', s.id], ['sectionHeading', s.heading], ['sectionBody', withoutCitations(i === 0 ? firstBody : s.body)]] as [string, string][])]);
}

test('e: source links follow the published page (http allowed, apostrophes kept); pictures and the call to action stay https only', () => {
  const d = fx.pageData('ready'); const b = d.version!.body;
  const body = { ...b, cta: { label: 'Book now', url: 'http://www.example.com/book' }, citations: b.citations.map((c, i) => (i === 0 ? { ...c, url: "http://www.example.com/o'brien-report" } : i === 1 ? { ...c, url: 'javascript:alert(1)' } : c)) };
  const html = visible(editorPage(fx.shell(), { ...d, version: { ...d.version!, body }, open: ['sources'] }));
  assert.match(html, /<li id="source-1"><a href="http:\/\/www\.example\.com\/o&#39;brien-report" rel="noopener">UK House Price Index<\/a>/);
  assert.match(html, /<li id="source-2">Stamp Duty Land Tax: residential property rates \(accessed/);
  assert.match(html, /<p>Book now<\/p>/); assert.doesNotMatch(html, /href="(javascript|data):/);
});

test('f, g: the pause switch has its anchor; states with nothing to press say so deliberately', async () => {
  const { service, f } = await setup();
  assert.match((await call(service, 'GET', `/portal/seo-blog/b/${f.brand.id}/publishing`)).body, /<form method="post" action="[^"]*settings\/toggle" id="pause">/);
  const cur = fx.pageData('ready').version!;
  const approval = { versionId: cur.id, contentSha: cur.contentSha, approvedAt: '', approvedBy: 'owner' };
  const due = { publishAtUtc: '2026-11-16T11:59:00.000Z', localDate: '2026-11-16', localTime: '11:59', timezone: 'Europe/London', destinationId: fx.destination.id, setAt: '', setBy: '' };
  for (const [name, article, sentence] of [
    ['due', fx.article({ approval, schedule: due }), /^Its time has come: it goes onto your website within the next few minutes\./],
    ['rewriting', fx.article({ editorialState: 'writing' }), /^A rewrite is running\./],
  ] as const) {
    const html = visible(editorPage(fx.shell(), { ...fx.pageData('ready'), article }));
    assert.match(bar(html), sentence, name);
    assert.equal((html.match(/data-primary/g) ?? []).length, 0, `${name}: deliberately no main button`);
    assert.match(html, /<span class="ap-quietnote" data-no-action>Nothing for you to do now\.<\/span>/, name);
  }
});

test('h: a changed sentence that kept its source is pointed out with a link to that source; reordered twins lose theirs', async () => {
  const A = '[src:5452de1e-e616-492b-8fa5-eb393534457d]';
  const kept = restoreCitationsDetailed(`Average rents in Leeds rose by 5% during 2024 ${A}. The end is near.`, 'Average rents in York rose by 5% during 2024. The end is near.');
  assert.deepEqual(kept.keptOnEdited, [['5452de1e-e616-492b-8fa5-eb393534457d']]);
  const twins = restoreCitationsDetailed(`Rents in Leeds are £900 a month. That is 5% more than last year ${A}. Prices in Leeds are £200,000. That is 5% more than last year. Plan for both.`,
    'Prices in Leeds are £200,000. That is 5% more than last year. Rents in Leeds are £900 a month. That is 5% more than last year. Plan for both.');
  assert.doesNotMatch(twins.text, /\[src:/); assert.equal(twins.droppedSentences, 1);
  const { service, base, get } = await setup();
  const v1 = (await get()).version!;
  const cited = /^[^.]*\./.exec(v1.body.sections[0]!.body)![0];
  const r = await f2edit(service, base, v1.id, v1.body, v1.body.sections[0]!.body.replace(cited, withoutCitations(cited).replace('Deposit protection is a legal requirement', 'Deposit protection is a strict legal requirement')));
  const m = message(r);
  assert.match(m.text, /1 sentence you changed still has its source\. Check it still says what the source says\./);
  const id = /\[src:([^\]]+)\]/.exec(cited)![1]!;
  const page = visible((await call(service, 'GET', `${base}?checksource=${id}`)).body);
  assert.match(page, /<p class="ap-quiet-line" role="status">Check the sentence you changed still says what its source says: <a href="https:/);
  assert.equal(new URL(r.headers.location!, 'https://x').searchParams.get('checksource'), id);
  void get;
});
