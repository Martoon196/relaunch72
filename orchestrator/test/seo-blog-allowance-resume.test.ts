/**
 * "The first article is waiting for my allowances, but I thought I made them unlimited": a write stopped by the
 * monthly writing allowance is judged against the current numbers, offered as "Write it now" once there is enough,
 * and put back in the queue by itself when the allowance is raised or a new month starts (bounded, oldest first,
 * never twice, never for a paused business or unconfirmed details).
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
import { writingStatus } from '../src/portal/seo-blog-article-view.js';
import { restoreCitationsDetailed } from '../src/seo-blog/citation-edit.js';
import { allowanceBlockedWrite, ALLOWANCE_RESUME_LIMIT } from '../src/seo-blog/engine.js';
import type { Brand, Job } from '../src/seo-blog/types.js';
import { OWNER } from './seo-blog-fixtures.js';
import { websiteFixture } from './seo-blog-website-fixtures.js';
import * as fx from './seo-blog-article-page-fixtures.js';

// The tests decide the content-area switch themselves (see test/content-area-shell.test.ts).
delete process.env.CONTENT_AREA_PREVIEW;

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
const message = (r: { headers: Record<string, string> }) => { const u = new URL(r.headers.location!, 'https://x'); const m = u.searchParams.get('n') ?? u.searchParams.get('e'); return { ok: u.searchParams.has('n'), text: m ? Buffer.from(m, 'base64url').toString() : '' }; };
const visible = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, '');
const bar = (html: string) => (/<p class="ap-state">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** A business whose first article stopped because the writing allowance ran out (100,000 a month, 90,000 already used). */
async function stoppedForAllowance() {
  const f = await websiteFixture('content_api', undefined, async (h, brandId) => {
    const b = await h.engine.getBrand(OWNER, brandId);
    await h.engine.updateSettings(OWNER, brandId, b.rowVersion, { budgets: { ...b.settings.budgets, modelTokensPerMonth: 100_000 } });
    const used = await h.engine.usage(OWNER, brandId);
    await h.store.recordUsage({ brandId, kind: 'model_tokens', amount: Math.max(0, 90_000 - used.model_tokens), at: h.clock.now(), reference: 'fixture-month-so-far' });
  });
  const service: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => f.h.engine, socialCallback: async () => null };
  const base = `/portal/seo-blog/b/${f.brand.id}/articles/${f.articleId}`;
  const job = async () => (await f.h.store.listJobs(f.brand.id)).find((j) => j.kind === 'write' && !j.payload.fromVersionId && j.payload.stage === undefined)!;
  return { f, service, base, job };
}
const unlimitedWriting = async (f: Awaited<ReturnType<typeof websiteFixture>>) => {
  const b = (await f.h.store.getBrand(f.brand.id))!;
  // As the founder's limits page records it: writing "Unlimited".
  await f.h.store.updateBrand({ ...b, settings: { ...b.settings, operatorLimits: { modelTokens: null, searchCalls: 200, images: 0, studioImages: 0, configuredBy: OWNER.userId, configuredAt: f.h.clock.now() } } });
};
function settingsForm(b: Brand, modelTokens: number): [string, string][] {
  const s = b.settings;
  return [['_csrf', csrf], ['rowVersion', String(b.rowVersion)], ...s.cadence.weekdays.map((d) => ['weekday', String(d)] as [string, string]), ['localTime', s.cadence.localTime], ['perWeek', String(s.cadence.perWeek)],
    ['horizon', String(s.planningHorizonDays)], ['backlog', String(s.backlogCeiling)], ['length', s.lengthPreference], ['modelTokens', String(modelTokens)], ['searchCalls', String(s.budgets.searchCallsPerMonth)], ['images', String(s.budgets.imagesPerMonth)], ['authorName', '']];
}

test('the owner’s story: blocked for allowance, allowance made unlimited: the page offers "Write it now", and pressing it writes the article', async () => {
  const { f, service, base, job } = await stoppedForAllowance();
  const j = await job();
  assert.equal(j.state, 'blocked'); assert.ok(allowanceBlockedWrite(j), j.error ?? '');
  let page = visible((await call(service, 'GET', base)).body);
  assert.equal(bar(page), 'Paused: waiting for more writing allowance this month.');
  assert.match(page, /data-primary href="[^"]*publishing#writing-budget">Check the allowance</);
  await unlimitedWriting(f);
  page = visible((await call(service, 'GET', base)).body);
  assert.match(bar(page), /^It stopped because the writing allowance ran out\. There is enough now\./);
  const form = /<form method="post" action="([^"]*\/jobs\/[^"]*\/retry)" class="ap-inline">([\s\S]*?)<button[^>]*data-primary>Write it now<\/button>/.exec(page);
  assert.ok(form, 'one main button, "Write it now", using the existing retry route');
  const back = /name="back" value="([^"]*)"/.exec(form![2]!)![1]!;
  const r = await call(service, 'POST', form![1]!.replace(/&amp;/g, '&'), [['_csrf', csrf], ['back', back]]);
  assert.equal(message(r).ok, true);
  assert.equal((await job()).state, 'queued');
  // The Articles list says the same thing (the article is queued now, so it says it is waiting to be written).
  assert.doesNotMatch(visible((await call(service, 'GET', `/portal/seo-blog/b/${f.brand.id}/articles`)).body), /waiting for more writing allowance/);
  await f.h.engine.tick('w');
  assert.ok((await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId)).version, 'the article is written');
});

test('saving a higher allowance alone puts the waiting article back in the queue, and the confirmation says so', async () => {
  const { f, service, job } = await stoppedForAllowance();
  const b = await f.h.engine.getBrand(OWNER, f.brand.id);
  // Not enough yet: nothing moves, the page keeps telling the truth.
  let r = await call(service, 'POST', `/portal/seo-blog/b/${f.brand.id}/settings`, settingsForm(b, 110_000));
  assert.equal(message(r).text, 'Settings saved.'); assert.equal((await job()).state, 'blocked');
  const list = visible((await call(service, 'GET', `/portal/seo-blog/b/${f.brand.id}/articles`)).body);
  assert.match(list, /Paused: waiting for more writing allowance this month/);
  // Enough now: queued without anyone pressing anything.
  r = await call(service, 'POST', `/portal/seo-blog/b/${f.brand.id}/settings`, settingsForm(await f.h.engine.getBrand(OWNER, f.brand.id), 2_000_000));
  assert.equal(message(r).text, 'Settings saved. 1 article that was waiting for the writing allowance is being written now.');
  const j = await job(); assert.equal(j.state, 'queued'); assert.match(j.progress, /Queued again automatically: the writing allowance was raised/);
  const events = await f.h.engine.activity(OWNER, f.brand.id);
  assert.equal(events.filter((e) => e.kind === 'job.resumed_allowance').length, 1);
});

test('bound and order: oldest first, only while each fits, at most ten per pass', async () => {
  const { f, job } = await stoppedForAllowance();
  const first = await job();
  const now = f.h.clock.now();
  const extra: Job[] = [];
  for (let i = 0; i < 14; i++) {
    const created = new Date(Date.parse(now) + (i + 1) * 60_000).toISOString();
    const { job: j } = await f.h.store.enqueueJob({ ...first, id: randomUUID(), idempotencyKey: `extra:${i}`, payload: { briefId: randomUUID() }, state: 'blocked', createdAt: created, updatedAt: created, rowVersion: 1 });
    extra.push(j);
  }
  // Room for exactly three articles this month (90,000 used + 3 × 32,000).
  const b = await f.h.engine.getBrand(OWNER, f.brand.id);
  await f.h.engine.updateSettings(OWNER, f.brand.id, b.rowVersion, { budgets: { ...b.settings.budgets, modelTokensPerMonth: 90_000 + 3 * 32_000 + 500 } });
  assert.equal(await f.h.engine.resumeAllowanceBlockedWrites(OWNER, f.brand.id), 3);
  const queued = (await f.h.store.listJobs(f.brand.id)).filter((j) => j.state === 'queued' && j.kind === 'write').map((j) => j.id);
  assert.deepEqual(queued.sort(), [first.id, extra[0]!.id, extra[1]!.id].sort(), 'the three oldest');
  // A second pass sees those three as already committed: nothing more fits, nothing is requeued twice.
  assert.equal(await f.h.engine.resumeAllowanceBlockedWrites(OWNER, f.brand.id), 0);
  // Unlimited: still no more than ten per pass.
  await unlimitedWriting(f);
  assert.equal(await f.h.engine.resumeAllowanceBlockedWrites(OWNER, f.brand.id), ALLOWANCE_RESUME_LIMIT);
  assert.equal((await f.h.store.listJobs(f.brand.id)).filter(allowanceBlockedWrite).length, 15 - 3 - ALLOWANCE_RESUME_LIMIT);
});

test('never twice: two saves at once, or a save and a worker pass, requeue a job once', async () => {
  const { f, job } = await stoppedForAllowance();
  await unlimitedWriting(f);
  const counts = await Promise.all([f.h.engine.resumeAllowanceBlockedWrites(OWNER, f.brand.id), f.h.engine.resumeAllowanceBlockedWrites(OWNER, f.brand.id)]);
  assert.equal(counts[0]! + counts[1]!, 1);
  const j = await job(); assert.equal(j.state, 'queued');
  const rv = j.rowVersion;
  assert.equal(await f.h.engine.resumeAllowanceBlockedWrites(OWNER, f.brand.id), 0, 'a queued job is not touched again');
  assert.equal((await job()).rowVersion, rv);
  assert.equal((await f.h.engine.activity(OWNER, f.brand.id)).filter((e) => e.kind === 'job.resumed_allowance').length, 1);
});

test('a paused business and unconfirmed business details are never requeued', async () => {
  const p = await stoppedForAllowance();
  await unlimitedWriting(p.f);
  const b = (await p.f.h.store.getBrand(p.f.brand.id))!;
  await p.f.h.store.updateBrand({ ...b, settings: { ...b.settings, pauseAll: true } });
  assert.equal(await p.f.h.engine.resumeAllowanceBlockedWrites(OWNER, p.f.brand.id), 0);
  assert.equal((await p.job()).state, 'blocked');
  const u = await stoppedForAllowance();
  await unlimitedWriting(u.f);
  const profile = (await u.f.h.store.latestProfile(u.f.brand.id))!;
  await u.f.h.store.saveProfile({ ...profile, version: profile.version + 1, confirmedAt: null });
  assert.equal(await u.f.h.engine.resumeAllowanceBlockedWrites(OWNER, u.f.brand.id), 0);
  assert.equal((await u.job()).state, 'blocked');

});

test('a new month: the worker’s own pass puts the waiting article back without anyone pressing anything', async () => {
  const { f, job } = await stoppedForAllowance();
  const wake = (await f.h.store.listJobs(f.brand.id)).find((j) => j.payload.allowanceWake === true);
  assert.ok(wake, 'a wake-up task is waiting for the new month'); assert.equal(wake!.runAfter, '2026-12-01T00:00:00.000Z');
  await f.h.engine.tick('w'); assert.equal((await job()).state, 'blocked', 'nothing before the new month');
  f.h.clock.set('2026-12-01T00:05:00.000Z');
  await f.h.engine.tick('w');
  const j = await job();
  assert.ok(['queued', 'running', 'done'].includes(j.state), j.state);
  assert.match((await f.h.engine.activity(OWNER, f.brand.id)).map((e) => e.message).join('\n'), /queued again automatically: a new month started/);
});

test('other causes that have since been cleared offer "Write it now"; an unknown result and an out-of-date plan never do', () => {
  const b = fx.brand as Brand;
  const blocked = (error: string): Job => ({ id: 'cccccccc-1111-4222-8333-444455556666', brandId: b.id, kind: 'write', idempotencyKey: 'k', payload: { briefId: 'b1' }, state: 'blocked', attempts: 1, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null,
    runAfter: '2026-11-15T10:00:00.000Z', progress: 'Paused until the issue is fixed.', error, createdAt: '2026-11-14T10:00:00.000Z', updatedAt: '2026-11-15T10:00:00.000Z', rowVersion: 2 });
  const facts = { usage: { model_tokens: 0, search_calls: 0, images: 0 }, profile: 'confirmed' as const, generation: 'live' as const };
  const cases: [string, RegExp][] = [
    ['Confirm the current brand profile before writing.', /^It stopped because your business details needed confirming\. They are confirmed now\./],
    ['Draft production is paused by the owner.', /^It stopped because writing was paused\. Writing is switched back on now\./],
    ['Article generation is not configured. Connect a model API key before generating.', /^It stopped because the writing service was not connected\. It is connected now\./],
    ['Writing allowance: monthly ceiling reached.', /^It stopped because the writing allowance ran out\. There is enough now\./],
  ];
  for (const [error, sentence] of cases) {
    const w = writingStatus(b, null, 'b1', [blocked(error)], facts);
    assert.match(w.sentence, sentence, error); assert.equal(w.retryJobId, 'cccccccc-1111-4222-8333-444455556666'); assert.equal(w.retryLabel, 'Write it now');
    const still = writingStatus(b, null, 'b1', [blocked(error)], { usage: { model_tokens: 2_000_000, search_calls: 0, images: 0 }, profile: 'unconfirmed', generation: 'unavailable' });
    const pausedBrand = { ...b, settings: { ...b.settings, pauseAll: true } } as Brand;
    const stillPaused = writingStatus(pausedBrand, null, 'b1', [blocked(error)], { usage: { model_tokens: 2_000_000, search_calls: 0, images: 0 }, profile: 'unconfirmed', generation: 'unavailable' });
    assert.match(/paused/.test(error) ? stillPaused.sentence : still.sentence, /^Paused:/, `${error}: still blocked`);
  }
  for (const error of ['The social copy request has an uncertain outcome.', 'The planned article has no current programme authority. Review a new plan.']) {
    const w = writingStatus(b, null, 'b1', [blocked(error)], facts);
    assert.equal(w.retryJobId, null, error); assert.match(w.sentence, /^Paused:/);
  }
  // Without facts nothing is assumed: the waiting sentence and its link stay.
  assert.match(writingStatus(b, null, 'b1', [blocked('Writing allowance: monthly ceiling reached.')]).sentence, /^Paused: waiting for more writing allowance/);
});

test('S1: a source comes back with a changed-back sentence only if the article still lists it and shows it to readers', () => {
  const A = '[src:5452de1e-e616-492b-8fa5-eb393534457d]';
  const previous = `Intro here. Prices rose 5% in 2024 ${A}. The end.`;
  const stored = 'Intro here. Prices rose 9% in 2024. The end.';
  const edited = 'Intro here. Prices rose 5% in 2024. The end.';
  assert.equal(restoreCitationsDetailed(stored, edited, previous, () => true).text, previous);
  const r = restoreCitationsDetailed(stored, edited, previous, () => false);
  assert.equal(r.text, edited); assert.equal(r.restoredFromEarlier, 0); assert.equal(r.notRestored, 1);
});
