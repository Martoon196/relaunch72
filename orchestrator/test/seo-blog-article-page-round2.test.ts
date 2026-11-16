/**
 * Review round 2 of the article page: every reproduction from the independent review, ported.
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
import { articlesPage, editorPage, situation } from '../src/portal/seo-blog-article-view.js';
import { restoreCitations, restoreCitationsDetailed, withoutCitations } from '../src/seo-blog/citation-edit.js';
import { SeoBlogEngine, sha256 } from '../src/seo-blog/engine.js';
import { promotionCommand } from '../src/seo-blog/promotions.js';
import { articleStatusLabel } from '../src/seo-blog/policy.js';
import { SeoBlogError, type Article } from '../src/seo-blog/types.js';
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

// ─── B1: a refused "Approve and publish" changes nothing ────────────────────

test('B1: a refused press leaves approval and schedule exactly as they were (past time, empty date, stale row)', async () => {
  const { f, service, base, get } = await setup();
  const v = (await get()).version!;
  let a = (await get()).article;
  await f.h.engine.schedule(OWNER, f.brand.id, f.articleId, a.rowVersion, { localDate: '2026-11-05', localTime: '09:00', destinationId: f.destination.id });
  const before = (await get()).article;
  for (const form of [[['when', 'at'], ['localDate', '2026-11-02'], ['localTime', '09:00']], [['when', 'at'], ['localDate', ''], ['localTime', '']], [['when', 'next'], ['rowVersion', String(before.rowVersion - 1)]]] as [string, string][][]) {
    const r = await call(service, 'POST', `${base}/approve-publish`, [['_csrf', csrf], ['versionId', v.id], ['destinationId', f.destination.id], ...form]);
    assert.equal(message(r).ok, false, JSON.stringify(form));
    a = (await get()).article;
    assert.equal(a.approval, null, `${JSON.stringify(form)}: not approved`); assert.deepEqual(a.schedule, before.schedule, `${JSON.stringify(form)}: schedule untouched`);
  }
  // At the earlier planned time nothing is published: it was never approved.
  f.h.clock.set('2026-11-05T09:01:00.000Z'); await f.h.engine.tick('w');
  assert.equal(f.h.site.posts, 0);
});

test('B1: if scheduling still fails after approving, the approval is taken back', async () => {
  const { f, get } = await setup();
  const v = (await get()).version!;
  const engine = f.h.engine as SeoBlogEngine & { schedule: SeoBlogEngine['schedule'] };
  engine.schedule = async () => { throw new SeoBlogError(409, 'Simulated scheduling refusal.'); };
  await assert.rejects(engine.approveAndSchedule(OWNER, f.brand.id, f.articleId, { versionId: v.id, when: 'next' }), /Simulated/);
  assert.equal((await get()).article.approval, null);
});

test('B1: "now" during the repeated hour when the clocks go back is a real future time', async () => {
  const { f, get } = await setup();
  f.h.clock.set('2027-10-31T01:30:00.000Z');
  const v = (await get()).version!;
  await f.h.engine.rerunChecks(OWNER, f.brand.id, f.articleId);
  const r = await f.h.engine.approveAndSchedule(OWNER, f.brand.id, f.articleId, { versionId: v.id, when: 'now' });
  assert.ok(Date.parse(r.publishAtUtc) > Date.parse('2027-10-31T01:31:00.000Z'));
  assert.equal((await get()).article.schedule?.publishAtUtc, r.publishAtUtc);
});

// ─── B2: two websites ────────────────────────────────────────────────────────

test('B2: a chosen website that is not connected is refused, never swapped; the page and the press name the same website', async () => {
  const { f, service, base, get } = await setup();
  const second = await f.h.engine.connectDestination(OWNER, f.brand.id, { type: 'github_static', label: 'Second site', credential: 'gh-token-fixture', config: { repository: 'acme/site', branch: 'main', publicBaseUrl: 'https://harbour.example', blogPath: 'blog', sitemapPath: 'sitemap.xml' } });
  const v = (await get()).version!;
  await f.h.store.saveDestination({ ...(await f.h.store.getDestination(f.brand.id, second.id))!, status: 'failed' });
  const refused = await call(service, 'POST', `${base}/approve-publish`, [['_csrf', csrf], ['versionId', v.id], ['when', 'at'], ['localDate', '2026-11-06'], ['localTime', '09:00'], ['destinationId', second.id]]);
  assert.match(message(refused).text, /not connected any more/);
  assert.equal((await get()).article.approval, null); assert.equal((await get()).article.schedule, null);
  // Reconnected, with a missed time on the second website: the page names it and the press uses it.
  await f.h.store.saveDestination({ ...(await f.h.store.getDestination(f.brand.id, second.id))!, status: 'connected' });
  let a = (await get()).article;
  await f.h.engine.schedule(OWNER, f.brand.id, f.articleId, a.rowVersion, { localDate: '2026-11-03', localTime: '09:00', destinationId: second.id });
  f.h.clock.set('2026-11-03T12:30:00.000Z'); await f.h.engine.tick('w');
  const page = (await call(service, 'GET', base)).body;
  assert.match(bar(page), /on Second site/); assert.match(page, /It goes on <strong>Second site<\/strong>/);
  assert.equal(field(mainForm(page), 'destinationId'), second.id);
  const press = await call(service, 'POST', `${base}/approve-publish`, [['_csrf', csrf], ...[...mainForm(page).matchAll(/name="([^"]+)" value="([^"]*)"/g)].filter((m) => m[1] !== '_csrf').map((m) => [m[1]!, unescape(m[2]!)] as [string, string])]);
  assert.match(message(press).text, /on Second site on Thursday 5 November at 9:00/);
  a = (await get()).article; assert.equal(a.schedule?.destinationId, second.id);
});

// ─── B3: citations ──────────────────────────────────────────────────────────

test('B3: a citation never moves onto another claim', () => {
  const A = '[src:5452de1e-e616-492b-8fa5-eb393534457d]';
  const cases: [string, string, string, string][] = [
    ['deleted cited sentence; similar neighbour', `Stamp duty is 5% on second homes ${A}. Stamp duty is 0% on first homes. Done.`, 'Stamp duty is 5% on second homes. ', ''],
    ['bold cited sentence edited inside', `**Stamp duty is 5% on second homes ${A}.** Legal fees are extra. Budget for both.`, 'second', 'additional'],
    ['short sentence, meaning inverted', `Rates rose ${A}. The end is near.`, 'Rates rose', 'Rates fell'],
    ['figure changed', `Prices rose 5% in 2024 in Leeds and York ${A}. The end is near.`, '5%', '9%'],
  ];
  const results = cases.map(([, stored, from, to]) => restoreCitations(stored, withoutCitations(stored).replace(from, to)));
  assert.equal(results[0], 'Stamp duty is 0% on first homes. Done.');
  assert.equal(results[1], `**Stamp duty is 5% on additional homes ${A}.** Legal fees are extra. Budget for both.`, 'kept on its own (bold) sentence, never on the next');
  assert.equal(results[2], 'Rates fell. The end is near.');
  assert.equal(results[3], 'Prices rose 9% in 2024 in Leeds and York. The end is near.');
  // A leading marker and a marker alone on its line stay put when something else in the field changes.
  assert.equal(restoreCitations(`${A} Prices rose 5% in 2024. The end is near.`, ` Prices rose 5% in 2024. The end is nigh.`), `${A} Prices rose 5% in 2024. The end is nigh.`);
  assert.equal(restoreCitations(`Prices rose 5% in 2024.\n${A}\nThe end is near.`, 'Prices rose 5% in 2024.\n\nThe end is nigh.'), `Prices rose 5% in 2024.\n${A}\nThe end is nigh.`);
  // CR in what an older editor stored: a no-change save is still byte-identical.
  assert.equal(restoreCitations(`Prices rose ${A}.\r\nNext.`, 'Prices rose.\nNext.'), `Prices rose ${A}.\r\nNext.`);
  assert.deepEqual(restoreCitationsDetailed(`Rates rose ${A}. Rents rose ${A}. End.`, 'Rates fell. Rents fell. End.'), { text: 'Rates fell. Rents fell. End.', droppedMarkers: 2, droppedSentences: 2 });
});

test('B3: fuzz — deleted, one-word, 40% and 70% edits never leave a citation on a different claim', () => {
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32; const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const T = [
    () => `Average ${pick(['rents', 'prices', 'yields'])} in ${pick(['Leeds', 'York', 'Hull', 'Bath'])} ${pick(['rose', 'fell'])} ${1 + Math.floor(rnd() * 9)}% in ${pick(['2023', '2024', '2025'])}.`,
    () => `Stamp duty is ${1 + Math.floor(rnd() * 9)}% on ${pick(['second', 'first'])} homes${pick([' in England', ' in Wales', ''])}.`,
    () => `A ${pick(['survey', 'valuation', 'search'])} costs about £${300 + Math.floor(rnd() * 900)} for ${pick(['older', 'newer'])} homes.`,
    () => `Check achieved rents rather than advertised ones before you ${pick(['offer', 'buy', 'bid'])}.`,
    () => `Write the number down and stick to it.`,
  ];
  const VOC = ['quickly', 'often', 'builders', 'agents', 'months', 'budget', 'street', 'cheaper', 'carefully'];
  const reword = (text: string, share: number) => { const w = text.replace(/\.$/, '').split(' '); const idx = new Set<number>(); while (idx.size < Math.max(1, Math.round(w.length * share))) idx.add(Math.floor(rnd() * w.length)); return `${w.map((x, i) => (idx.has(i) ? pick(VOC) : x)).join(' ')}.`; };
  let wrong = 0, runs = 0;
  for (let r = 0; r < 3000; r++) {
    const n = 3 + Math.floor(rnd() * 5);
    const before = Array.from({ length: n }, (_, id) => ({ id, text: pick(T)(), cite: rnd() < 0.5 }));
    const stored = before.map((s) => (s.cite ? s.text.replace(/\.$/, ` [src:m${s.id}].`) : s.text)).join(' ');
    const k = Math.floor(rnd() * n); const op = pick(['delete', 'slight', 'medium', 'heavy'] as const);
    const after = before.map((s) => ({ ...s }));
    if (op === 'delete') after.splice(k, 1); else after[k] = { ...after[k]!, text: reword(after[k]!.text, op === 'slight' ? 0.12 : op === 'medium' ? 0.4 : 0.7) };
    const edited = after.map((s) => s.text).join(' ');
    const out = restoreCitations(stored, edited); runs++;
    assert.equal(withoutCitations(out), edited);
    let pos = 0;
    for (const s of after) {
      const span = out.indexOf(s.text.replace(/\.$/, ''), pos); const end = out.indexOf('.', span + s.text.length - 1);
      for (const m of out.slice(span, end + 1).matchAll(/\[src:m(\d+)\]/g)) if (Number(m[1]) !== s.id && before[Number(m[1])]!.text !== s.text) wrong++;
      pos = end + 1;
    }
  }
  assert.equal(wrong, 0, `${wrong} of ${runs} runs ended on a different claim`);
});

test('B3: an article last saved by the old editor (CR line breaks) is "Nothing changed"; dropped sources are said in plain words', async () => {
  const { f, service, base, get } = await setup();
  const v1 = (await get()).version!; const b = v1.body;
  const legacy: [string, string][] = [['_csrf', csrf], ['versionId', v1.id], ['title', b.title], ['slug', b.slug], ['seoTitle', b.seoTitle], ['metaDescription', b.metaDescription], ['excerpt', b.excerpt], ['intro', `${b.intro}\r\n\r\nA second opening paragraph.`], ['conclusion', b.conclusion], ['imageUrl', ''], ['imageAlt', b.image.alt],
    ...b.sections.flatMap((s) => [['sectionId', s.id], ['sectionHeading', s.heading], ['sectionBody', s.body]] as [string, string][])];
  await call(service, 'POST', `${base}/edit`, legacy);
  const v2 = (await get()).version!; assert.match(v2.body.intro, /\r\n/);
  const page = (await call(service, 'GET', `${base}?edit=1`)).body;
  const form = /<form method="post" action="[^"]*\/edit" id="article-edit"[\s\S]*?<\/form>/.exec(page)![0] + [...page.matchAll(/<input [^>]*form="article-edit"[^>]*>/g)].map((m) => m[0]).join('');
  const fields: [string, string][] = [];
  for (const m of form.matchAll(/<input ([^>]*)>|<textarea ([^>]*)>\n?([\s\S]*?)<\/textarea>/g)) {
    const attrs = m[1] ?? m[2]!; const name = /name="([^"]*)"/.exec(attrs)?.[1]; if (!name) continue;
    fields.push([name, name === '_csrf' ? csrf : m[1] !== undefined ? unescape(/value="([^"]*)"/.exec(attrs)?.[1] ?? '') : unescape(m[3]!).replace(/\r?\n/g, '\r\n')]);
  }
  assert.equal(message(await call(service, 'POST', `${base}/edit`, fields)).text, 'Nothing changed, so nothing was saved.');
  assert.equal((await get()).version!.id, v2.id);
  // Rewrite the cited sentence of the first part beyond recognition: its source goes, and the notice says so.
  const first = fields.findIndex(([k]) => k === 'sectionBody');
  const cited = /^[^.]*\./.exec(fields[first]![1])![0];
  const changed = fields.map(([k, x], i) => [k, i === first ? x.replace(cited, 'You should look after the money properly.') : x] as [string, string]);
  const saved = await call(service, 'POST', `${base}/edit`, changed);
  assert.match(message(saved).text, /You changed 1 sentence that had a source, so its source link was removed\. We re-checked the article\./);
  assert.doesNotMatch((await get()).version!.body.sections[0]!.body, /\[src:/);
});

// ─── B4: the time is shown, and the press is bound to it ────────────────────

test('B4: the bar shows the time and website; the press is bound to it; a changed calendar is refused without approving', async () => {
  const { f, service, base, get } = await setup();
  const page = (await call(service, 'GET', base)).body;
  assert.match(bar(page), /Approve and publish: it goes out on Tuesday 3 November at 9:00\./);
  const form = mainForm(page);
  assert.equal(field(form, 'when'), 'planned'); assert.equal(field(form, 'localDate'), '2026-11-03'); assert.equal(field(form, 'localTime'), '09:00'); assert.equal(field(form, 'destinationId'), f.destination.id);
  const press = [...form.matchAll(/name="([^"]+)" value="([^"]*)"/g)].filter((m) => m[1] !== '_csrf').map((m) => [m[1]!, unescape(m[2]!)] as [string, string]);
  // Another article takes Tuesday in the meantime (as from another tab).
  const other = { ...(await get()).article, id: randomUUID(), briefId: randomUUID(), slug: 'another-article', schedule: { publishAtUtc: '2026-11-03T09:00:00.000Z', localDate: '2026-11-03', localTime: '09:00', timezone: 'Europe/London', destinationId: f.destination.id, setAt: f.h.clock.now(), setBy: OWNER.userId } } as Article;
  await f.h.store.createArticle(other);
  const refused = await call(service, 'POST', `${base}/approve-publish`, [['_csrf', csrf], ...press]);
  assert.match(message(refused).text, /^The calendar changed\. Here is the new time: Thursday 5 November at 9:00\. Nothing was approved yet/);
  assert.equal((await get()).article.approval, null); assert.equal((await get()).article.schedule, null);
  const fresh = mainForm((await call(service, 'GET', base)).body);
  const ok = await call(service, 'POST', `${base}/approve-publish`, [['_csrf', csrf], ...[...fresh.matchAll(/name="([^"]+)" value="([^"]*)"/g)].filter((m) => m[1] !== '_csrf').map((m) => [m[1]!, unescape(m[2]!)] as [string, string])]);
  assert.equal(message(ok).text, 'Approved. It goes out on Thursday 5 November at 9:00.');
  // Close to the time: "in about N minutes".
  const soon = editorPage(fx.shell(), { ...fx.pageData('ready'), plan: { site: { id: fx.destination.id, label: fx.destination.label }, websites: 1, slot: { localDate: '2026-11-16', localTime: '12:06', publishAtUtc: '2026-11-16T12:06:00.000Z', kept: false }, paused: false, now: fx.NOW, rowVersion: 7 } });
  assert.match(bar(soon), /it goes out in about 6 minutes\./);
});

// ─── B5, B6, S2, S4, S5 ─────────────────────────────────────────────────────

test('B5: the picture can be removed; it makes a new version and says so', async () => {
  const { service, base, get } = await setup();
  const v = (await get()).version!;
  await call(service, 'POST', `${base}/picture`, [['_csrf', csrf], ['versionId', v.id], ['imageUrl', 'https://bay.example/images/house.jpg'], ['imageAlt', 'A row of terraced houses']]);
  const withPicture = (await get()).version!;
  const page = visible((await call(service, 'GET', base)).body);
  assert.match(page, /Remove the picture/); assert.match(page, /This makes a new version, so you’ll approve it again\./);
  const r = await call(service, 'POST', `${base}/picture-remove`, [['_csrf', csrf], ['versionId', withPicture.id]]);
  assert.match(message(r).text, /Picture removed\. This made a new version/);
  const after = (await get()).version!; assert.equal(after.body.image.kind, 'none'); assert.equal(after.body.image.url, null); assert.equal(after.number, withPicture.number + 1);
  assert.equal(message(await call(service, 'POST', `${base}/picture-remove`, [['_csrf', csrf], ['versionId', withPicture.id]])).ok, false, 'an old page cannot remove it again');
});

test('B6, S2, S4, S5: re-approval button, paused business, approve without a date, the rewrite panel and the list cost', () => {
  const d = fx.pageData('ready'); const v = d.version!;
  const legacy = { articleVersionId: v.id, network: 'linkedin' as const, packSha: sha256(v.promotionPack), contentItemId: randomUUID(), contentVersionId: randomUUID(), approvalDecisionId: randomUUID(), rowVersion: 1 };
  const html = visible(editorPage(fx.shell(), { ...d, article: { ...d.article, linkedPromotions: [legacy] } }));
  const card = /<article class="ap-post" aria-label="LinkedIn post">[\s\S]*?<\/article>/.exec(html)![0];
  assert.match(card, /Approve this post again/); assert.match(html, /Approve all 2 posts/);
  const pausedShell = { ...fx.shell(), brand: { ...fx.brand, settings: { ...fx.brand.settings, pauseAll: true } } };
  const paused = visible(editorPage(pausedShell, d));
  assert.match(bar(paused), /^Publishing is paused for this business\. Switch it back on first\./); assert.match(paused, /data-primary href="[^"]*publishing#pause">Switch publishing back on</);
  assert.doesNotMatch(paused, /it will wait until you switch it back on/);
  assert.match(html, /\/approve" class="ap-inline">[\s\S]*?>Approve without a date<\/button><span class="ap-note"> It will not go out until it has a time\.<\/span>/);
  assert.match(html, /<option value="00000000-aaaa-4bbb-8ccc-000000000000" selected>/, 'the first part is chosen by default');
  assert.match(html, /<p class="ap-warn"><strong>The whole article<\/strong> rewrites everything/);
  const list = visible(articlesPage(fx.shell(), fx.listData()));
  assert.match(list, />Try again<\/button><span class="ap-note al-cost">Uses some of your writing allowance\.<\/span>/);
});

test('S2: a paused business refuses "Approve and publish" before anything is written', async () => {
  const { f, get } = await setup();
  const b = await f.h.engine.getBrand(OWNER, f.brand.id);
  await f.h.engine.updateSettings(OWNER, f.brand.id, b.rowVersion, { pauseAll: true });
  await assert.rejects(f.h.engine.approveAndSchedule(OWNER, f.brand.id, f.articleId, { versionId: (await get()).version!.id, when: 'now' }), /Publishing is paused for this business\. Switch it back on first\./);
  assert.equal((await get()).article.approval, null); assert.equal((await get()).article.schedule, null);
});

// ─── S3: the list and the page say the same thing ───────────────────────────

test('S3: for every state, the list line and the article bar come from the same facts', () => {
  const base = fx.pageData('ready'); const cur = base.version!;
  const approval = { versionId: cur.id, contentSha: cur.contentSha, approvedAt: '2026-11-15T10:00:00.000Z', approvedBy: 'owner' };
  const past = { publishAtUtc: '2026-11-10T09:00:00.000Z', localDate: '2026-11-10', localTime: '09:00', timezone: 'Europe/London', destinationId: fx.destination.id, setAt: '2026-11-05T10:00:00.000Z', setBy: 'owner' };
  const future = { ...past, publishAtUtc: '2026-11-18T09:00:00.000Z', localDate: '2026-11-18' };
  const critical = { ...fx.article().checks!, status: 'critical' as const, issues: [fx.critical] };
  const states: [string, Partial<Article>, boolean?][] = [
    ['draft', {}], ['approved', { approval }], ['approved + future', { approval, schedule: future }], ['not approved + future', { schedule: future }],
    ['approved + due', { approval, schedule: past }], ['owner hold', { approval, schedule: future, hold: { reason: 'owner', detail: '', at: '' } }],
    ['failed', { approval, delivery: 'failed', failure: 'x' }], ['unknown', { approval, delivery: 'unknown' }], ['publishing', { approval, delivery: 'publishing' }],
    ['published then edited', { delivery: 'published', publishedVersionId: 'older', publishedUrl: 'https://x.example/blog/a', publishedAt: '2026-11-09T09:02:00.000Z' }],
    ['rewrite failed', { editorialState: 'failed', failure: 'boom', approval }], ['rewrite running + scheduled', { editorialState: 'writing', approval, schedule: future }],
    ['rewrite running, unapproved', { editorialState: 'writing' }], ['critical + approved + future', { approval, schedule: future, checks: critical }],
    ...(['missing_approval', 'checks_failed', 'paused', 'destination', 'budget', 'outcome_unknown', 'stale_version', 'missed_window'] as const).map((reason) => [`held ${reason}`, { approval, schedule: past, hold: { reason, detail: 'detail', at: '' } }] as [string, Partial<Article>]),
    ['auto on, unapproved', {}, true],
  ];
  for (const [name, over, auto] of states) {
    const sh = auto ? { ...fx.shell(), brand: { ...fx.brand, settings: { ...fx.brand.settings, autoPublish: true } } } : fx.shell();
    const a = fx.article(over);
    const sit = situation(a, sh.brand!, fx.NOW, 1);
    const list = articlesPage(sh, { articles: [{ article: a, title: 'T', status: articleStatusLabel(a, sh.brand!.settings) }], jobs: [], briefs: [], now: fx.NOW, websites: 1 });
    assert.equal(unescape(/<span class="al-line[^"]*">([^<]*)/.exec(list)![1]!), sit.line, `${name}: list line`);
    const page = editorPage(sh, { ...base, article: a, now: fx.NOW });
    assert.ok(unescape(bar(page)).startsWith(sit.bar.split('. ')[0]!.replace(/\.$/, '')), `${name}: page bar "${bar(page)}" vs "${sit.bar}"`);
    if (!a.approval && !auto) assert.doesNotMatch(sit.line, /^Approved/, `${name}: never "Approved" when it is not`);
  }
  assert.equal(situation(fx.article({ editorialState: 'writing', approval, schedule: future }), fx.brand, fx.NOW, 1).bar, 'A rewrite is running. The approved version still goes out on Wednesday 18 November at 9:00 unless you take it off the calendar.');
  assert.equal(situation(fx.article({}), { ...fx.brand, settings: { ...fx.brand.settings, autoPublish: true } }, fx.NOW, 1).line, 'Ready, no time yet');
});

// ─── promotion-approve-all ──────────────────────────────────────────────────

async function withPromotions(fail?: (network: string, n: number) => Error | null) {
  const f = await websiteFixture();
  const calls: string[] = []; let n = 0;
  const promotions = { async approve({ brand, version, network, observation, recordDraft }: Parameters<NonNullable<ConstructorParameters<typeof SeoBlogEngine>[0]['promotions']>['approve']>[0]) {
    const command = promotionCommand(brand, version, network, observation);
    const ids: [string, string] = observation.contentItemId ? [observation.contentItemId, observation.contentVersionId!] : [randomUUID(), randomUUID()];
    if (!observation.contentItemId) await recordDraft(ids[0], ids[1]);
    const err = fail?.(network, ++n); if (err) throw err;
    calls.push(`${network}:${command.metadata!.articleVersionId}`);
    return { articleVersionId: version.id, network, packSha: sha256(version.promotionPack), contentItemId: ids[0], contentVersionId: ids[1], approvalRequestId: randomUUID(), approvalDecisionId: randomUUID(), rowVersion: 1 };
  } };
  const engine = new SeoBlogEngine({ store: f.h.store, llm: f.h.llm, search: f.h.search, transport: f.h.web, publishers: new Map(), vault: f.h.vault, now: f.h.clock.now, promotions } as ConstructorParameters<typeof SeoBlogEngine>[0]);
  const service: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => engine, socialCallback: async () => null };
  return { f, engine, service, calls, base: `/portal/seo-blog/b/${f.brand.id}/articles/${f.articleId}`, get: () => engine.getArticle(OWNER, f.brand.id, f.articleId) };
}

test('promotion-approve-all approves each post through the unchanged single-post step; refusals are reported; a second press is a no-op', async () => {
  const p = await withPromotions();
  const v = (await p.get()).version!; const pack = sha256(v.promotionPack);
  assert.equal(message(await call(p.service, 'POST', `${p.base}/promotion-approve-all`, [['_csrf', csrf], ['versionId', randomUUID()], ['packSha', pack]])).ok, false);
  assert.equal(p.calls.length, 0);
  const ok = await call(p.service, 'POST', `${p.base}/promotion-approve-all`, [['_csrf', csrf], ['versionId', v.id], ['packSha', pack]]);
  assert.equal(message(ok).text, 'Posts approved. They go out after the article is live on your website.');
  assert.deepEqual(p.calls.sort(), v.promotionPack!.posts.map((x) => `${x.network}:${v.id}`).sort());
  await call(p.service, 'POST', `${p.base}/promotion-approve-all`, [['_csrf', csrf], ['versionId', v.id], ['packSha', pack]]);
  assert.equal(p.calls.length, 2, 'second press approves nothing again');
  const q = await withPromotions((_network, n) => (n === 2 ? new SeoBlogError(409, 'The approval service refused this post.') : null));
  const qv = (await q.get()).version!;
  const partial = message(await call(q.service, 'POST', `${q.base}/promotion-approve-all`, [['_csrf', csrf], ['versionId', qv.id], ['packSha', sha256(qv.promotionPack)]]));
  assert.equal(partial.ok, false); assert.match(partial.text, /^(Instagram|LinkedIn) approved\. The (LinkedIn|Instagram) post was not approved: The approval service refused this post\./);
  const c = await withPromotions((_network, n) => (n === 2 ? new Error('connection reset') : null));
  const cv = (await c.get()).version!;
  const crash = message(await call(c.service, 'POST', `${c.base}/promotion-approve-all`, [['_csrf', csrf], ['versionId', cv.id], ['packSha', sha256(cv.promotionPack)]]));
  assert.match(crash.text, /approved\. We could not confirm the (LinkedIn|Instagram) post’s approval\. Refresh the page before trying again\./);
});

test('retry "back=": only the articles list or one article; anything else returns to Activity', async () => {
  const { f, service } = await setup();
  const job = (await f.h.store.listJobs(f.brand.id)).find((j) => j.kind === 'write')!;
  const go = async (back: string) => { await f.h.store.updateJob({ ...(await f.h.store.getJob(f.brand.id, job.id))!, state: 'failed', error: 'x' }); return message(await call(service, 'POST', `/portal/seo-blog/b/${f.brand.id}/jobs/${job.id}/retry`, [['_csrf', csrf], ['back', back]])).path; };
  assert.equal(await go('articles'), `/portal/seo-blog/b/${f.brand.id}/articles`);
  assert.equal(await go(`articles/${f.articleId}`), `/portal/seo-blog/b/${f.brand.id}/articles/${f.articleId}`);
  for (const bad of ['//evil.example', 'https://evil.example', `articles/${f.articleId}/approve-publish`, '../../../limits', `articles/${f.articleId}?x=1`, `ARTICLES/${f.articleId.toUpperCase()}`]) assert.equal(await go(bad), `/portal/seo-blog/b/${f.brand.id}/activity`, bad);
});

test('links and pictures are https only; anything else is shown as text', () => {
  const d = fx.pageData('ready'); const b = d.version!.body;
  const body = { ...b, cta: { label: 'Book now', url: 'javascript:alert(1)' }, citations: b.citations.map((c, i) => (i === 0 ? { ...c, url: 'javascript:alert(2)' } : c)), image: { ...b.image, kind: 'brand_asset' as const, url: 'data:image/png;base64,AAAA' } };
  const html = visible(editorPage(fx.shell(), { ...d, version: { ...d.version!, body } }));
  assert.doesNotMatch(html, /(href|src)="(javascript|data):/);
  assert.match(html, /<p>Book now<\/p>/); assert.match(html, /<li id="source-1">UK House Price Index \(accessed/);
});
