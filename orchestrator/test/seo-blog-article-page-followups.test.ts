/**
 * Follow-up round: the reviewer's last should-fixes (F1–F6) as regression tests.
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
import { putBackSentence, restoreCitationsDetailed, sentencesToPutBack, withoutCitations } from '../src/seo-blog/citation-edit.js';
import { OWNER } from './seo-blog-fixtures.js';
import { websiteFixture } from './seo-blog-website-fixtures.js';

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
const later = (html: string) => /<details class="ap-later"><summary class="ap-textbutton">Publish later<\/summary><div class="ap-panel"><form method="post" action="([^"]*)">([\s\S]*?)<\/form>/.exec(html);
async function publishLater(s: Awaited<ReturnType<typeof setup>>, date: string, time: string) {
  const m = later(visible((await call(s.service, 'GET', s.base)).body))!;
  const fields = press(m[2]!).filter(([k]) => !['localDate', 'localTime'].includes(k));
  return message(await call(s.service, 'POST', unescape(m[1]!), [...fields, ['localDate', date], ['localTime', time]]));
}

test('F1: a deliberate "Publish now" always moves a later time; only a repeat of a "Publish now" is treated as a repeat', async () => {
  const s = await setup();
  assert.equal((await publishLater(s, '2026-11-02', '12:00')).text, 'Approved. It goes out on Monday 2 November at 12:00.');
  s.f.h.clock.set('2026-11-02T10:02:00.000Z');
  const now = formFor(visible((await call(s.service, 'GET', s.base)).body), 'approve-publish', 'Publish now')!;
  assert.equal(message(await call(s.service, 'POST', `${s.base}/approve-publish`, press(now))).text, 'It goes onto your website in about 2 minutes.');
  assert.equal((await s.get()).article.schedule?.localTime, '10:04');
  // A true repeat of that same "Publish now" changes nothing and says the same.
  assert.equal(message(await call(s.service, 'POST', `${s.base}/approve-publish`, press(now))).text, 'It goes onto your website in about 2 minutes.');
  assert.equal((await s.get()).article.schedule?.localTime, '10:04');
  // "Change the time" to 11:00, then "Publish now".
  const t = await setup();
  await publishLater(t, '2026-11-09', '09:00');
  const change = /<details class="ap-later"><summary class="button ap-primary" data-primary>Change the time<\/summary><div class="ap-panel"><form method="post" action="([^"]*)">([\s\S]*?)<\/form>/.exec(visible((await call(t.service, 'GET', t.base)).body))!;
  await call(t.service, 'POST', unescape(change[1]!), [...press(change[2]!).filter(([k]) => !['localDate', 'localTime'].includes(k)), ['localDate', '2026-11-02'], ['localTime', '11:00']]);
  assert.equal((await t.get()).article.schedule?.localTime, '11:00');
  const now2 = formFor(visible((await call(t.service, 'GET', t.base)).body), 'approve-publish', 'Publish now')!;
  assert.equal(message(await call(t.service, 'POST', `${t.base}/approve-publish`, press(now2))).text, 'It goes onto your website in about 2 minutes.');
  assert.equal((await t.get()).article.schedule?.localTime, '10:02');
});

test('F2: a repeated press never confirms something that is no longer true (paused, other website)', async () => {
  const s = await setup();
  const form = mainForm((await call(s.service, 'GET', s.base)).body);
  assert.equal(message(await call(s.service, 'POST', `${s.base}/approve-publish`, press(form))).text, 'Approved. It goes out on Tuesday 3 November at 9:00.');
  const b = await s.f.h.engine.getBrand(OWNER, s.f.brand.id);
  await s.f.h.engine.updateSettings(OWNER, s.f.brand.id, b.rowVersion, { pauseAll: true });
  assert.equal(message(await call(s.service, 'POST', `${s.base}/approve-publish`, press(form))).text, 'Publishing is paused for this business. Switch it back on first.');
  // A repeat with the website left out is not a repeat (it must name the website it was shown).
  const t = await setup();
  const second = await t.f.h.engine.connectDestination(OWNER, t.f.brand.id, { type: 'github_static', label: 'Second site', credential: 'gh-token-fixture', config: { repository: 'acme/site', branch: 'main', publicBaseUrl: 'https://harbour.example', blogPath: 'blog', sitemapPath: 'sitemap.xml' } });
  const f2 = mainForm((await call(t.service, 'GET', t.base)).body);
  await call(t.service, 'POST', `${t.base}/approve-publish`, press(f2));
  const a = (await t.get()).article;
  await t.f.h.engine.schedule(OWNER, t.f.brand.id, t.f.articleId, a.rowVersion, { localDate: a.schedule!.localDate, localTime: a.schedule!.localTime, destinationId: second.id });
  const r = message(await call(t.service, 'POST', `${t.base}/approve-publish`, press(f2).filter(([k]) => k !== 'destinationId')));
  assert.equal(r.ok, false); assert.equal((await t.get()).article.schedule?.destinationId, second.id);
});

test('F3: plain approval says what will really happen (owner hold with a time; a time that has just passed)', async () => {
  const s = await setup();
  let a = (await s.get()).article;
  await s.f.h.engine.schedule(OWNER, s.f.brand.id, s.f.articleId, a.rowVersion, { localDate: '2026-11-05', localTime: '09:00', destinationId: s.f.destination.id });
  a = (await s.get()).article; await s.f.h.engine.hold(OWNER, s.f.brand.id, s.f.articleId, a.rowVersion, true);
  const page = visible((await call(s.service, 'GET', s.base)).body);
  assert.doesNotMatch(page, /It will not go out until it has a time/);
  const item = formFor(page, 'approve', 'Approve')!;
  assert.match(page, />Approve<\/button><span class="ap-note"> It goes out on Thu 5 Nov at 9:00 only once you allow it to go out\.<\/span>/);
  assert.equal(message(await call(s.service, 'POST', `${s.base}/approve`, press(item))).text, 'Approved. It is on hold, so it goes out on Thursday 5 November at 9:00 only once you choose “Allow it to go out”.');
  // A time that passed a minute ago (not yet held): it goes out at the next worker pass, and the answer says so.
  const t = await setup();
  a = (await t.get()).article;
  await t.f.h.engine.schedule(OWNER, t.f.brand.id, t.f.articleId, a.rowVersion, { localDate: '2026-11-02', localTime: '10:30', destinationId: t.f.destination.id });
  t.f.h.clock.set('2026-11-02T10:31:00.000Z');
  const r = await call(t.service, 'POST', `${t.base}/approve`, [['_csrf', csrf], ['versionId', (await t.get()).version!.id]]);
  assert.equal(message(r).text, 'Approved. Its time has just passed, so it goes onto your website within the next few minutes.');
  await t.f.h.engine.tick('w');
  assert.equal((await t.get()).status, 'Published');
});

async function editFirstCited(s: Awaited<ReturnType<typeof setup>>, change: (plain: string) => string, part?: number) {
  const v = (await s.get()).version!;
  const i = part ?? v.body.sections.findIndex((x) => /\[src:/.test(x.body));
  const b = v.body;
  return call(s.service, 'POST', `${s.base}/edit`, [['_csrf', csrf], ['versionId', v.id], ['citationsHidden', '1'], ['title', b.title], ['slug', b.slug], ['seoTitle', b.seoTitle], ['metaDescription', b.metaDescription], ['excerpt', b.excerpt], ['intro', withoutCitations(b.intro)], ['conclusion', withoutCitations(b.conclusion)], ['imageUrl', b.image.url ?? ''], ['imageAlt', b.image.alt],
    ...b.sections.flatMap((x, k) => [['sectionId', x.id], ['sectionHeading', x.heading], ['sectionBody', k === i ? change(withoutCitations(x.body)) : withoutCitations(x.body)]] as [string, string][])]);
}

test('F4: "below" only when the page offers to put the wording back', async () => {
  const s = await setup();
  const offered = message(await editFirstCited(s, (p) => p.replace('30 days', '40 days')));
  assert.match(offered.text, /You can put the earlier wording back below\./);
  assert.match(visible((await call(s.service, 'GET', s.base)).body), /id="put-back"/);
  // The cited sentence changed and so did both its neighbours: nothing can be put back, so no "below".
  const t = await setup();
  const r = message(await editFirstCited(t, (p) => p.split(/(?<=\.)\s+/).map((x, k) => (k < 3 ? `${x.replace(/\.$/, '')} (changed ${k} and 4${k}%).` : x)).join(' ')));
  assert.match(r.text, /source links? (was|were) removed/); assert.doesNotMatch(r.text, /below/);
  assert.match(r.text, /To get a source back, change that sentence back exactly as it was the next time you edit\./);
  assert.doesNotMatch(visible((await call(t.service, 'GET', t.base)).body), /id="put-back"/);
});

test('F5: a deleted list item or paragraph comes back on its own line with exactly its stored markers', () => {
  const A = '[src:5452de1e-e616-492b-8fa5-eb393534457d]';
  const cases: [string, string][] = [
    [`Costs:\n\n- Stamp duty at 5% ${A}\n- Legal fees\n\nEnd.`, 'Costs:\n\n- Legal fees\n\nEnd.'],
    [`Costs:\n\n- Legal fees\n- Stamp duty at 5% ${A}\n\nEnd.`, 'Costs:\n\n- Legal fees\n\nEnd.'],
    [`Intro.\n\nPrices rose 5% in 2024 ${A}.\n\nEnd.`, 'Intro.\n\nEnd.'],
    [`1. First step\n2. Pay 5% stamp duty ${A}\n3. Last step`, '1. First step\n3. Last step'],
    [`Prices rose 5% ${A}. Two. End.`, 'Two. End.'],
  ];
  for (const [earlier, current] of cases) {
    const [offer] = sentencesToPutBack(earlier, current);
    assert.ok(offer, earlier);
    assert.equal(putBackSentence(earlier, current, offer!.index), earlier, JSON.stringify(earlier));
  }
});

test('F6: put-back is bound to the current version’s parent; a version from two saves ago is refused', async () => {
  const s = await setup();
  await editFirstCited(s, (p) => p.replace('30 days', '40 days'));
  const v2 = (await s.get()).version!;
  const form = formFor(visible((await call(s.service, 'GET', s.base)).body), 'put-back', 'Put the earlier wording back')!;
  assert.equal(field(form, 'fromVersionId'), v2.parentVersionId);
  // One more unrelated save, then the old form re-aimed at the new current version.
  const b = v2.body;
  await call(s.service, 'POST', `${s.base}/edit`, [['_csrf', csrf], ['versionId', v2.id], ['citationsHidden', '1'], ['title', b.title], ['slug', b.slug], ['seoTitle', b.seoTitle], ['metaDescription', b.metaDescription], ['excerpt', b.excerpt], ['intro', withoutCitations(b.intro)], ['conclusion', `${withoutCitations(b.conclusion)} One more closing line.`], ['imageUrl', b.image.url ?? ''], ['imageAlt', b.image.alt],
    ...b.sections.flatMap((x) => [['sectionId', x.id], ['sectionHeading', x.heading], ['sectionBody', withoutCitations(x.body)]] as [string, string][])]);
  const v3 = (await s.get()).version!;
  assert.notEqual(v3.id, v2.id);
  const crafted = press(form).map(([k, x]) => [k, k === 'versionId' ? v3.id : x] as [string, string]);
  const r = message(await call(s.service, 'POST', `${s.base}/put-back`, crafted));
  assert.equal(r.ok, false); assert.match(r.text, /The article changed/);
  assert.equal((await s.get()).version!.id, v3.id);
});

// ─── Follow-up round 2: numbered lists, "change it back", and two plain-approval wordings ───

test('R1: renumbering a numbered list keeps the sources of items whose words did not change', () => {
  const A = '[src:5452de1e-e616-492b-8fa5-eb393534457d]', B = '[src:0f9a2b3c-4d5e-4f60-8a1b-2c3d4e5f6a7b]';
  const list = `Steps:\n\n1. Find three similar homes that let recently ${A}\n2. Allow 3 months for the works to finish ${B}\n3. Use the middle figure`;
  const plain = withoutCitations(list);
  const count = (t: string) => (t.match(/\[src:/g) ?? []).length;
  const inserted = restoreCitationsDetailed(list, plain.replace('1. Find', '1. Read the plan\n2. Find').replace('2. Allow', '3. Allow').replace('3. Use', '4. Use'));
  assert.equal(inserted.text, `Steps:\n\n1. Read the plan\n2. Find three similar homes that let recently ${A}\n3. Allow 3 months for the works to finish ${B}\n4. Use the middle figure`);
  const deleted = restoreCitationsDetailed(list, 'Steps:\n\n1. Allow 3 months for the works to finish\n2. Use the middle figure');
  assert.equal(deleted.text, `Steps:\n\n1. Allow 3 months for the works to finish ${B}\n2. Use the middle figure`); assert.equal(deleted.droppedSentences, 1);
  // Only item 2 edited: its own number 2 -> 3 is not a figure, but "3 months" -> "2 months" is, so its source goes.
  const figure = restoreCitationsDetailed(list, plain.replace('2. Allow 3 months', '3. Allow 2 months'));
  assert.equal(count(figure.text), 1); assert.doesNotMatch(figure.text, /0f9a2b3c/); assert.equal(figure.droppedSentences, 1);
  // A deleted numbered item whose list was renumbered since is not offered for put-back (it could not come back exactly).
  assert.deepEqual(sentencesToPutBack(`1. Keep 8% for the works ${A}\n2. Check rents\n3. Pay stamp duty`, '1. Check rents\n2. Pay stamp duty'), []);
  // An identical twin item: which one was deleted cannot be known, so nothing is offered.
  assert.deepEqual(sentencesToPutBack(`- Check rents ${A}\n- Keep 8% back\n- Check rents`, '- Keep 8% back\n- Check rents'), []);
});

test('R1: changing a sentence back exactly as it was restores its source (and the save message says only true things)', async () => {
  const s = await setup();
  const v1 = (await s.get()).version!;
  const i = v1.body.sections.findIndex((x) => /\[src:/.test(x.body));
  // Change the cited sentence and both its neighbours: nothing can be put back, so the advice is "change it back".
  const firstSentences = (p: string) => p.split(/(?<=\.)\s+/).map((x, k) => (k < 3 ? `${x.replace(/\.$/, '')} (changed ${k} and 4${k}%).` : x)).join(' ');
  const r = message(await editFirstCited(s, firstSentences));
  assert.match(r.text, /To get a source back, change that sentence back exactly as it was the next time you edit\./);
  const v2 = (await s.get()).version!; assert.doesNotMatch(v2.body.sections[i]!.body, /\[src:/);
  // Doing exactly that: the earlier text saved again brings the sources back.
  const back = message(await editFirstCited(s, () => withoutCitations(v1.body.sections[i]!.body), i));
  assert.match(back.text, /sentences? you changed back (has its source|have their sources) again/);
  assert.equal((await s.get()).version!.body.sections[i]!.body, v1.body.sections[i]!.body);
});

test('W1: a time on a website that is not connected right now: checked again at its time (content API answers, so it goes out)', async () => {
  const s = await setup();
  let a = (await s.get()).article;
  await s.f.h.engine.schedule(OWNER, s.f.brand.id, s.f.articleId, a.rowVersion, { localDate: '2026-11-03', localTime: '09:00', destinationId: s.f.destination.id });
  await s.f.h.store.saveDestination({ ...(await s.f.h.store.getDestination(s.f.brand.id, s.f.destination.id))!, status: 'failed' });
  const r = message(await call(s.service, 'POST', `${s.base}/approve`, [['_csrf', csrf], ['versionId', (await s.get()).version!.id]]));
  assert.equal(r.text, 'Approved. It is planned for Website, which is not connected right now. At its time the connection is checked again: if the website answers, it goes out; if not, it is held and you choose a new time.');
  s.f.h.clock.set('2026-11-03T09:01:00.000Z'); await s.f.h.engine.tick('w');
  assert.equal((await s.get()).status, 'Published');
  void a;
});

test('W2: on hold with a time that has just passed: "Allow it to go out" alone publishes it at the next pass, and the answer says so', async () => {
  const s = await setup();
  let a = (await s.get()).article;
  await s.f.h.engine.schedule(OWNER, s.f.brand.id, s.f.articleId, a.rowVersion, { localDate: '2026-11-02', localTime: '10:30', destinationId: s.f.destination.id });
  a = (await s.get()).article; await s.f.h.engine.hold(OWNER, s.f.brand.id, s.f.articleId, a.rowVersion, true);
  s.f.h.clock.set('2026-11-02T10:45:00.000Z');
  const page = visible((await call(s.service, 'GET', s.base)).body);
  assert.match(page, />Approve<\/button><span class="ap-note"> It stays on hold; once you allow it to go out, it goes out within minutes\.<\/span>/);
  const r = message(await call(s.service, 'POST', `${s.base}/approve`, [['_csrf', csrf], ['versionId', (await s.get()).version!.id]]));
  assert.equal(r.text, 'Approved. It is on hold. Its time has just passed, so if you choose “Allow it to go out” now, it goes onto your website within the next few minutes.');
  await s.f.h.engine.tick('w'); assert.equal((await s.get()).status, 'Held');
  a = (await s.get()).article; await s.f.h.engine.hold(OWNER, s.f.brand.id, s.f.articleId, a.rowVersion, false);
  await s.f.h.engine.tick('w'); assert.equal((await s.get()).status, 'Published');
  // More than two hours past: allow it, then choose a new time.
  const t = await setup();
  a = (await t.get()).article;
  await t.f.h.engine.schedule(OWNER, t.f.brand.id, t.f.articleId, a.rowVersion, { localDate: '2026-11-02', localTime: '10:30', destinationId: t.f.destination.id });
  a = (await t.get()).article; await t.f.h.engine.hold(OWNER, t.f.brand.id, t.f.articleId, a.rowVersion, true);
  t.f.h.clock.set('2026-11-02T13:00:00.000Z');
  assert.equal(message(await call(t.service, 'POST', `${t.base}/approve`, [['_csrf', csrf], ['versionId', (await t.get()).version!.id]])).text, 'Approved. It is on hold and its time passed too long ago: allow it to go out, then choose a new time.');
});
