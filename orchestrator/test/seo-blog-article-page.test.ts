import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleSeoBlog } from '../src/portal/seo-blog-router.js';
import { portalCsrfToken } from '../src/portal/session.js';
import type { PortalSeoBlogService } from '../src/portal/seo-blog-service.js';
import type { PortalSessionIdentity } from '../src/portal/auth-service.js';
import { articlesPage, editorPage, plainCheck } from '../src/portal/seo-blog-article-view.js';
import { restoreCitations, withoutCitations } from '../src/seo-blog/citation-edit.js';
import { OWNER } from './seo-blog-fixtures.js';
import { websiteFixture } from './seo-blog-website-fixtures.js';
import * as fx from './seo-blog-article-page-fixtures.js';

const SECRET = 's'.repeat(48);
const identity = (userId: string): PortalSessionIdentity => ({ sessionToken: `token-${userId}`, userId, workspaceId: '33333333-3333-4333-8333-333333333333', userEmail: 'owner@example.test' });

async function call(service: PortalSeoBlogService, who: PortalSessionIdentity, method: string, path: string, form?: [string, string][]) {
  const body = form ? new URLSearchParams(form).toString() : '';
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, { method, url: path, headers: { host: 'portal.example', ...(form ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body)), origin: 'https://portal.example' } : {}) } });
  (req as PassThrough).end(body);
  let status = 0; let headers: Record<string, string> = {}; let out = '';
  const res = { writeHead(s: number, h: Record<string, string>) { status = s; headers = h; return res; }, end(chunk?: string) { if (chunk) out += chunk; } } as unknown as ServerResponse;
  await handleSeoBlog(req, res, new URL(path, 'https://portal.example'), { service, identity: who, requestId: `r-${randomUUID()}`, sessionSecret: SECRET, vaultReady: true });
  return { status, headers, body: out };
}
const message = (r: { headers: Record<string, string> }) => { const u = new URL(r.headers.location!, 'https://x'); const m = u.searchParams.get('n') ?? u.searchParams.get('e'); return { ok: u.searchParams.has('n'), text: m ? Buffer.from(m, 'base64url').toString() : '' }; };
const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** What a browser submits for the article editor: its fields, with textarea newlines sent as CRLF. */
function editorForm(html: string): [string, string][] {
  const fields: [string, string][] = [];
  const form = /<form method="post" action="[^"]*\/edit" id="article-edit"[\s\S]*?<\/form>/.exec(html)![0];
  const outside = [...html.matchAll(/<input [^>]*form="article-edit"[^>]*>/g)].map((m) => m[0]).join('');
  for (const m of (form + outside).matchAll(/<input ([^>]*)>|<textarea ([^>]*)>\n?([\s\S]*?)<\/textarea>/g)) {
    const attrs = m[1] ?? m[2]!;
    const name = /name="([^"]*)"/.exec(attrs)?.[1];
    if (!name) continue;
    fields.push([name, m[1] !== undefined ? unescape(/value="([^"]*)"/.exec(attrs)?.[1] ?? '') : unescape(m[3]!).replace(/\n/g, '\r\n')]);
  }
  return fields;
}

/** The visible page without its stylesheet and without any editable text. */
const reading = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<textarea[\s\S]*?<\/textarea>/g, '');

test('every article state shows at most one main button, the article reads as published, and no raw markers or Markdown show', () => {
  const decisive = new Set(['ready', 'ready_picture', 'must_fix', 'scheduled', 'published', 'held', 'failed', 'approved', 'no_website', 'paused']);
  for (const state of fx.PAGE_STATES) {
    for (const mode of state === 'writing' || state === 'paused' ? ['read'] as const : ['read', 'edit'] as const) {
      const html = editorPage(fx.shell(), { ...fx.pageData(state), mode });
      const body = reading(html);
      const primaries = body.match(/data-primary/g)?.length ?? 0;
      assert.ok(primaries <= 1, `${state}/${mode}: ${primaries} main buttons`);
      if (decisive.has(state) || mode === 'edit') assert.equal(primaries, 1, `${state}/${mode}: one main button`);
      // Every other button or button-styled link is a quiet one.
      for (const m of body.matchAll(/<(button|summary|a)\b([^>]*)>/g)) {
        const attrs = m[2]!;
        if (attrs.includes('data-primary')) continue;
        if (m[1] === 'button') assert.match(attrs, /class="[^"]*(secondary|ap-textbutton|ap-menu-button)/, `${state}/${mode}: ${m[0]}`);
        if (/class="[^"]*\bbutton\b/.test(attrs)) assert.match(attrs, /secondary/, `${state}/${mode}: ${m[0]}`);
      }
      assert.doesNotMatch(body, /\[src:/, `${state}/${mode}: no citation markers`);
      if (mode === 'read') assert.doesNotMatch(body, /\*\*/, `${state}: no raw Markdown`);
      assert.doesNotMatch(body, /adapter|attribution is configured|explicit target|version binding|verified public|exact post|durable/i, `${state}/${mode}: no internal words`);
    }
  }
  const ready = reading(editorPage(fx.shell(), fx.pageData('ready')));
  assert.match(ready, /<strong>The end value tells you what the deal is worth\.<\/strong>/);
  assert.match(ready, /<li><strong>Stamp Duty Land Tax<\/strong>, using the current rates for additional homes<sup><a href="#source-2">\[2\]<\/a><\/sup><\/li>/);
  assert.match(ready, /<li id="source-1"><a href="https:\/\/www\.gov\.uk\/government/);
  assert.match(ready, /No picture yet/); assert.match(ready, /Approve and publish/); assert.match(ready, /Publish later/);
  assert.doesNotMatch(ready.slice(0, ready.indexOf('class="ap-folds"')), /Version \d/, 'no version number in the main flow');
  assert.match(ready, /Version 3 \(this one\)/, 'version numbers only under Earlier versions');
  assert.match(reading(editorPage(fx.shell(), fx.pageData('must_fix'))), /1 thing to fix before this can go out[\s\S]*href="#fix"[^>]*>Show me</);
  assert.match(reading(editorPage(fx.shell(), fx.pageData('scheduled'))), /Going out on Wednesday 18 November at 9:00[\s\S]*Publish now[\s\S]*Change the time/);
  assert.match(reading(editorPage(fx.shell(), fx.pageData('published'))), /Live on your website since Mon 9 Nov[\s\S]*>View it</);
  assert.match(reading(editorPage(fx.shell(), fx.pageData('paused'))), /Paused: something stopped it before it finished[\s\S]*>Try again</);
});

test('plain English for every check message the checks can produce', () => {
  const codes = [...readFileSync(new URL('../src/seo-blog/checks.ts', import.meta.url), 'utf8').matchAll(/'((?:structure|meta|image|profile|markup|links|facts|claims|originality|duplication|voice)\.[a-z_]+)'/g)].map((m) => m[1]!);
  assert.ok(codes.length >= 30);
  for (const code of new Set(codes)) {
    const original = `Original message “x” 99 characters for ${code}`;
    const plain = plainCheck({ code, message: original, location: 'Section “Costs”' });
    assert.notEqual(plain, original, `${code} has a plain sentence`);
    assert.doesNotMatch(plain, /attribution|configured|slug|SEO|meta description|featured image|alt text/i, code);
  }
});

test('the articles list groups what needs the owner first and says honestly why writing is paused', () => {
  const html = reading(articlesPage(fx.shell(), fx.listData()));
  const text = html.replace(/<[^>]+>/g, '');
  const order = ['Ready for you (3)', 'Coming up (2)', 'Being written (4)', 'Live (1)'].map((t) => text.indexOf(t));
  assert.ok(order.every((i) => i > 0) && order.every((i, n) => n === 0 || i > order[n - 1]!), 'groups in order');
  assert.match(html, /Needs one fix/); assert.match(html, /Going out Wed 18 Nov, 9:00/); assert.match(html, /Live since Mon 9 Nov/);
  assert.match(html, /HMO licensing: the basics for new landlords<\/span><span class="al-line al-line-wrap">Paused: waiting for more writing allowance this month/);
  assert.match(html, /action="\/portal\/seo-blog\/b\/[^"]+\/jobs\/eeeeeeee-1111-4222-8333-444455556666\/retry"[\s\S]*?name="back" value="articles"/, 'a stopped write task can be tried again from the list');
  assert.doesNotMatch(html, /\/jobs\/dddddddd-1111-4222-8333-444455556666\/retry/, 'no retry while the allowance is the cause');
  assert.doesNotMatch(html, /Unscheduled|Must fix|Suggestions|>Writing</);
});

test('citation markers stay on their sentences through edits and a no-change save is byte-identical', () => {
  const stored = 'Prices rose 5.5% in 2024 [src:a1]. Rents also grew [src:b2] [src:c3].\n\n- **Yield** matters [src:d4]\n- Costs add up\n\nPlain closing line.';
  const plain = withoutCitations(stored);
  assert.doesNotMatch(plain, /\[src:/);
  assert.equal(restoreCitations(stored, plain.replace(/\n/g, '\r\n')), stored);
  assert.equal(restoreCitations(stored, plain.replace('Plain closing line.', 'A new closing line.')), stored.replace('Plain closing line.', 'A new closing line.'));
  assert.equal(restoreCitations(stored, plain.replace('Rents also grew.', 'Rents also grew quickly.')), stored.replace('Rents also grew [src:b2] [src:c3].', 'Rents also grew quickly [src:b2] [src:c3].'));
  assert.equal(restoreCitations(stored, plain.replace('Prices rose 5.5% in 2024. ', '')), stored.replace('Prices rose 5.5% in 2024 [src:a1]. ', ''), 'a deleted claim takes its source with it');
});

test('in-place edit: a save with no changes keeps the article byte for byte; an edit nearby keeps every citation', async () => {
  const f = await websiteFixture();
  const service: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => f.h.engine, socialCallback: async () => null };
  const who = identity(OWNER.userId); const csrf = portalCsrfToken(SECRET, who.sessionToken);
  const base = `/portal/seo-blog/b/${f.brand.id}/articles/${f.articleId}`;
  const before = (await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId)).version!;
  assert.match(before.body.sections[0]!.body, /\[src:/);
  const page = await call(service, who, 'GET', `${base}?edit=1`);
  assert.equal(page.status, 200); assert.doesNotMatch(reading(page.body), /\[src:/); assert.doesNotMatch(page.body.match(/<textarea[\s\S]*?<\/textarea>/g)!.join(''), /\[src:/);
  const form = editorForm(page.body).map(([k, v]) => [k, k === '_csrf' ? csrf : v] as [string, string]);
  const same = await call(service, who, 'POST', `${base}/edit`, form);
  assert.deepEqual(message(same), { ok: true, text: 'Nothing changed, so nothing was saved.' });
  const after = (await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId)).version!;
  assert.equal(after.id, before.id); assert.deepEqual(after.body, before.body); assert.equal(after.contentSha, before.contentSha);
  // Change the last sentence of the first part; the cited sentence before it keeps its marker exactly.
  const first = form.findIndex(([k]) => k === 'sectionBody');
  const edited = form.map(([k, v], i) => [k, i === first ? v.replace('predictable for everyone involved.', 'predictable for everyone.') : v] as [string, string]);
  const saved = await call(service, who, 'POST', `${base}/edit`, edited);
  assert.equal(message(saved).ok, true, message(saved).text);
  const next = (await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId)).version!;
  assert.equal(next.number, before.number + 1);
  assert.equal(next.body.sections[0]!.body, before.body.sections[0]!.body.replace('predictable for everyone involved.', 'predictable for everyone.'));
  assert.deepEqual(next.body.sections.slice(1), before.body.sections.slice(1));
  assert.equal(next.body.intro, before.body.intro); assert.deepEqual(next.body.faqs, before.body.faqs);
  assert.equal((await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId)).article.approval, null, 'saving still resets approval');
});

test('Approve and publish: one decision, the existing approve and schedule steps with every gate kept', async () => {
  const f = await websiteFixture();
  const service: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => f.h.engine, socialCallback: async () => null };
  const who = identity(OWNER.userId); const csrf = portalCsrfToken(SECRET, who.sessionToken);
  const base = `/portal/seo-blog/b/${f.brand.id}/articles/${f.articleId}`;
  const detail = await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId);
  const v = detail.version!;
  // A stale page (another version) changes nothing.
  const stale = await call(service, who, 'POST', `${base}/approve-publish`, [['_csrf', csrf], ['versionId', randomUUID()], ['when', 'next']]);
  assert.equal(message(stale).ok, false); assert.equal((await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId)).article.approval, null);
  // CSRF is still required.
  const forged = await call(service, who, 'POST', `${base}/approve-publish`, [['_csrf', 'wrong'], ['versionId', v.id], ['when', 'next']]);
  assert.equal(message(forged).ok, false); assert.equal((await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId)).article.approval, null);
  // An owner hold is respected: nothing is approved or scheduled.
  await f.h.engine.hold(OWNER, f.brand.id, f.articleId, detail.article.rowVersion, true);
  const held = await call(service, who, 'POST', `${base}/approve-publish`, [['_csrf', csrf], ['versionId', v.id], ['when', 'next']]);
  assert.match(message(held).text, /not to go out/); let a = (await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId)).article; assert.equal(a.approval, null); assert.equal(a.schedule, null);
  await f.h.engine.hold(OWNER, f.brand.id, f.articleId, a.rowVersion, false);
  // Critical check failures still refuse approval, and nothing is scheduled.
  a = (await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId)).article;
  await f.h.store.updateArticle({ ...a, checks: { ...a.checks!, status: 'critical', issues: [{ code: 'structure.intro_missing', severity: 'critical', message: 'x', fix: 'y', location: null }] } });
  const critical = await call(service, who, 'POST', `${base}/approve-publish`, [['_csrf', csrf], ['versionId', v.id], ['when', 'next']]);
  assert.match(message(critical).text, /critical issues/); a = (await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId)).article; assert.equal(a.approval, null); assert.equal(a.schedule, null);
  await f.h.engine.rerunChecks(OWNER, f.brand.id, f.articleId);
  // The happy path: approved for this exact version and placed on the next publishing day (Tue/Thu at 9:00).
  const done = await call(service, who, 'POST', `${base}/approve-publish`, [['_csrf', csrf], ['versionId', v.id], ['when', 'next']]);
  assert.deepEqual(message(done), { ok: true, text: 'Approved. It goes out on Tuesday 3 November at 9:00.' });
  a = (await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId)).article;
  assert.equal(a.approval?.versionId, v.id); assert.equal(a.schedule?.localDate, '2026-11-03'); assert.equal(a.schedule?.localTime, '09:00'); assert.equal(a.schedule?.destinationId, f.destination.id);
  // Nothing reaches the website before its time; at its time the ordinary dispatcher publishes and verifies it.
  await f.h.engine.tick('w'); assert.equal(f.h.site.posts, 0);
  f.h.clock.set('2026-11-03T09:01:00.000Z'); await f.h.engine.tick('w');
  assert.equal((await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId)).status, 'Published');
  const live = await call(service, who, 'GET', base);
  assert.match(live.body, /Live on your website/); assert.match(live.body, /data-primary[^>]*>View it<|>View it<\/a>/);
});

test('Approve and publish refuses before approving when no website is connected', async () => {
  const f = await websiteFixture();
  const service: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => f.h.engine, socialCallback: async () => null };
  const who = identity(OWNER.userId); const csrf = portalCsrfToken(SECRET, who.sessionToken);
  const v = (await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId)).version!;
  const d = (await f.h.store.listDestinations(f.brand.id))[0]!;
  await f.h.store.saveDestination({ ...d, status: 'failed' });
  const r = await call(service, who, 'POST', `/portal/seo-blog/b/${f.brand.id}/articles/${f.articleId}/approve-publish`, [['_csrf', csrf], ['versionId', v.id], ['when', 'now']]);
  assert.match(message(r).text, /website is not connected/);
  const a = (await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId)).article; assert.equal(a.approval, null); assert.equal(a.schedule, null);
});

test('picture by address and "Ask for a rewrite" use the existing steps, keep CSRF and version checks', async () => {
  const f = await websiteFixture();
  const service: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => f.h.engine, socialCallback: async () => null };
  const who = identity(OWNER.userId); const csrf = portalCsrfToken(SECRET, who.sessionToken);
  const base = `/portal/seo-blog/b/${f.brand.id}/articles/${f.articleId}`;
  const v = (await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId)).version!;
  const pic = await call(service, who, 'POST', `${base}/picture`, [['_csrf', csrf], ['versionId', v.id], ['imageUrl', 'https://bay.example/images/house.jpg'], ['imageAlt', 'A row of terraced houses']]);
  assert.equal(message(pic).ok, true, message(pic).text);
  const withPicture = (await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId)).version!;
  assert.equal(withPicture.change, 'image_changed'); assert.equal(withPicture.body.image.url, 'https://bay.example/images/house.jpg');
  assert.deepEqual({ ...withPicture.body, image: v.body.image }, v.body, 'only the picture changed');
  const stale = await call(service, who, 'POST', `${base}/rewrite`, [['_csrf', csrf], ['versionId', v.id], ['sectionId', v.body.sections[1]!.id], ['instruction', 'Simpler']]);
  assert.equal(message(stale).ok, false, 'an old page cannot rewrite');
  const calls = f.h.llm.calls.length;
  const part = await call(service, who, 'POST', `${base}/rewrite`, [['_csrf', csrf], ['versionId', withPicture.id], ['sectionId', withPicture.body.sections[1]!.id], ['instruction', 'Simpler']]);
  assert.match(message(part).text, /Other sections are unchanged/);
  const rewritten = (await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId)).version!;
  assert.equal(rewritten.change, 'section_regenerated'); assert.deepEqual(rewritten.body.sections[0], withPicture.body.sections[0]); assert.ok(f.h.llm.calls.length > calls);
  const whole = await call(service, who, 'POST', `${base}/rewrite`, [['_csrf', csrf], ['versionId', rewritten.id], ['sectionId', 'whole'], ['instruction', '']]);
  assert.match(message(whole).text, /being written again/);
  assert.ok((await f.h.engine.listJobs(OWNER, f.brand.id)).some((j) => j.kind === 'write' && j.payload.fromVersionId === rewritten.id && j.state === 'queued'));
});
