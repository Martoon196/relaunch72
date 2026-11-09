/**
 * Milestone 5: learning from real outcomes. Deterministic findings with stated uncertainty, no ROAS/CAC/winner,
 * no budget suggestions, owner-recorded dated journal, general-pattern guard, owner-chosen copy into brand guidance,
 * and the proposal page routes. Outcome rows here are synthetic fixtures (the SQL read is proved separately).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildLearning, findingsText, generalPatternIssues, MemoryLearningStore, MIN_ARM_LEADS, wilson } from '../src/creative-studio/learning.js';
import { creativeUtmContent, type OutcomeBucket, type OutcomeRead } from '../src/creative-studio/distribution.js';
import { CreativeStudioService } from '../src/creative-studio/service.js';
import { MemoryCreativeLibraryStore } from '../src/creative-studio/store.js';
import type { ArtworkRenderer } from '../src/creative-studio/renderer.js';
import { campaignUtm } from '../src/seo-blog/acquisition-assembly.js';
import type { AcquisitionProposal } from '../src/seo-blog/campaign-creator.js';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { UnconfiguredSearchProvider } from '../src/seo-blog/research.js';
import { handleSeoBlog } from '../src/portal/seo-blog-router.js';
import type { PortalSeoBlogService } from '../src/portal/seo-blog-service.js';
import { portalCsrfToken } from '../src/portal/session.js';
import { FakeWeb } from './seo-blog-fixtures.js';
import { acquisitionBrief, acquisitionFixture } from './acquisition-campaign-fixtures.js';

const V1 = '1a2b3c4d-0000-4000-8000-000000000001', V2 = '5e6f7a8b-0000-4000-8000-000000000002';
const bucket = (content: string, leads: number, qualified: number, booked = 0, sold = 0): OutcomeBucket =>
  ({ utmContent: content, leads, qualified, booked, sold, customers: sold, subscriptionsCancelled: 0, firstAt: '2026-11-01T09:00:00.000Z', lastAt: '2026-11-08T09:00:00.000Z' });
const read = (buckets: OutcomeBucket[]): OutcomeRead => ({ utmCampaign: 'spring-plan-1a2b3c4d', readAt: '2026-11-09T10:00:00.000Z', buckets });
const proposal = { concepts: [{ name: 'Practical' }, { name: 'General' }], measurement: { reviewAfterDays: 21 } } as unknown as AcquisitionProposal;
const forbidden = /\b(ROAS|CAC|cost per acquisition|return on ad spend|winner|revenue)\b/iu;

test('wilson intervals are standard and bounded', () => {
  const w = wilson(10, 20);
  assert.equal(w.rate, 0.5); assert.ok(Math.abs(w.low - 0.2993) < 0.001 && Math.abs(w.high - 0.7007) < 0.001);
  assert.deepEqual(wilson(0, 0), { rate: 0, low: 0, high: 0 });
  assert.ok(wilson(0, 30).low === 0 && wilson(30, 30).high === 1);
});

test('findings: dated and evidence-linked; comparisons only with enough data; differences are never called winners', () => {
  const empty = buildLearning(read([]), proposal);
  assert.equal(empty.findings.length, 1); assert.equal(empty.findings[0]!.kind, 'gap');
  assert.match(empty.findings[0]!.statement, /2026-11-09.*does not store campaign tags/u);
  assert.equal(empty.nextTests[0]!.title, 'Confirm that leads keep their campaign tags');

  const small = buildLearning(read([bucket(creativeUtmContent(0, V1), 12, 6), bucket(creativeUtmContent(1, V2), 25, 5), bucket('concept-1', 3, 0), bucket('spring', 2, 0)]), proposal);
  const obs = small.findings.filter((f) => f.kind === 'observation');
  assert.equal(obs.length, 3, 'one observation per recognised arm');
  assert.match(obs[0]!.statement, /^Concept 1 \(Practical\) · artwork 1a2b3c4d: 12 tagged leads, 6 qualified/u);
  assert.deepEqual(obs[0]!.evidence[0], { source: 'crm_outcomes', utmCampaign: 'spring-plan-1a2b3c4d', utmContent: creativeUtmContent(0, V1), leads: 12, qualified: 6, booked: 0, sold: 0, customers: 0, readAt: '2026-11-09T10:00:00.000Z' });
  assert.ok(small.findings.some((f) => f.kind === 'gap' && /“spring”/u.test(f.statement)), 'unrecognised tags are reported, not guessed');
  const cmp = small.findings.filter((f) => f.kind === 'comparison');
  assert.deepEqual(cmp.map((f) => [f.metric, f.strength]), [['qualified', 'insufficient_data'], ['booked', 'insufficient_data'], ['sold', 'insufficient_data']]);
  assert.match(cmp[0]!.statement, new RegExp(`at least two concepts need ${MIN_ARM_LEADS} or more tagged leads each`, 'u'));
  assert.ok(small.nextTests.some((t) => t.title === 'Keep the current concepts running unchanged'));
  assert.ok(small.nextTests.some((t) => t.title === 'Use the artwork-tagged links'));

  const big = buildLearning(read([bucket(creativeUtmContent(0, V1), 60, 30, 9), bucket(creativeUtmContent(1, V2), 80, 12, 8)]), proposal);
  const q = big.findings.find((f) => f.metric === 'qualified')!;
  assert.equal(q.strength, 'observed_difference');
  assert.match(q.statement, /Concept 1 \(Practical\) · artwork 1a2b3c4d 50% \(95% range .*not proof/u);
  assert.equal(big.findings.find((f) => f.metric === 'booked')!.strength, 'no_clear_difference');
  const iterate = big.nextTests.find((t) => t.basedOn.includes(q.id))!;
  assert.match(iterate.change, /Keep concept 1 as the control.*only its headline/u);
  assert.equal(iterate.reviewAfterDays, 21);
  for (const s of [big, small, empty]) {
    for (const t of s.nextTests) { assert.match(t.budget, /No budget is suggested.*authorises/u); assert.doesNotMatch(`${t.title} ${t.change} ${t.why}`, /£|\$|€|\bbudget of\b/iu); }
    assert.ok(s.nextTests.length <= 3);
    for (const f of s.findings) assert.doesNotMatch(f.statement, forbidden);
    assert.ok(s.notCompared.some((n) => /No revenue, return on ad spend, cost per acquisition or overall winner/u.test(n)));
    assert.ok(s.notCompared.some((n) => /Lead volumes are not compared/u.test(n)));
  }
  const similar = buildLearning(read([bucket(creativeUtmContent(0, V1), 40, 10), bucket(creativeUtmContent(1, V2), 44, 12)]), proposal);
  assert.equal(similar.findings.find((f) => f.metric === 'qualified')!.strength, 'no_clear_difference');
  assert.ok(similar.nextTests.some((t) => t.title === 'Try a more distinct angle'));
  assert.match(findingsText(big, '2026-11-09T11:00:00.000Z', 'Spring plan'), /^Campaign findings: Spring plan \(recorded 2026-11-09; outcomes read 2026-11-09; rules r72-creative-learning-v1\)\n- .*\[evidence: utm_campaign=spring-plan-1a2b3c4d utm_content=concept-1-cs1a2b3c4d\]/u);
});

test('general patterns refuse figures, links, colours, prices, tracking tags and brand-specific names', () => {
  const brand = ['Fictional Hearth Maintenance', 'hearth.example', 'Annual boiler service'];
  assert.deepEqual(generalPatternIssues('Practical first-step questions drew more qualified enquiries than general invitations.', brand), []);
  for (const [text, re] of [['Practical questions lifted enquiries by 20 percent overall.', /numbers/u], ['See https://hearth.example for practical first steps.', /links/u], ['Use the warm teal #0f766e for calm first-step adverts.', /colours/u],
    ['Mention the £89 price early in practical adverts.', /numbers|prices/u], ['Annual boiler service readers prefer practical first steps.', /Annual boiler service/u], ['Short.', /20 to 300/u]] as const) {
    assert.match(generalPatternIssues(text, brand).join(' '), re, text);
  }
});

const renderer = { version: 'unused', available: () => false, renderBatch: async () => { throw new Error('unused'); } } as unknown as ArtworkRenderer;
const SECRET = 's'.repeat(48);
async function call(service: PortalSeoBlogService, who: { sessionToken: string; userId: string; workspaceId: string; userEmail: string }, method: string, path: string, form?: Record<string, string>) {
  const body = form ? new URLSearchParams(form).toString() : '';
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, { method, url: path, headers: { host: 'portal.example', ...(form ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body)), origin: 'https://portal.example' } : {}) } });
  (req as PassThrough).end(body);
  let status = 0, headers: Record<string, string> = {}, out = '';
  const res = { writeHead(s: number, h: Record<string, string>) { status = s; headers = h; return res; }, end(chunk?: string | Buffer) { if (chunk) out += chunk.toString(); } } as unknown as ServerResponse;
  await handleSeoBlog(req, res, new URL(path, 'https://portal.example'), { service, identity: who, requestId: `r-${randomUUID()}`, sessionSecret: SECRET, vaultReady: true });
  return { status, headers, body: out };
}

test('proposal page: findings, journal, patterns and owner-chosen guidance copy through the real router', async () => {
  const f = await acquisitionFixture();
  const engine = new SeoBlogEngine({ store: f.blogs, methods: f.controller, creatorStore: f.store, llm: f.model, search: new UnconfiguredSearchProvider(), transport: new FakeWeb(), publishers: new Map(), now: () => '2026-11-09T10:00:00.000Z', batchLimit: 20 } as never);
  const record = await f.creator.create(f.actor, f.brand.id, randomUUID(), acquisitionBrief(f.profile));
  const utm = campaignUtm(record.brief, record.id), versionId = randomUUID();
  let buckets: OutcomeBucket[] = [bucket(creativeUtmContent(0, versionId), 5, 2, 1)];
  const outcomes = async (_b: string, u: string): Promise<OutcomeRead> => ({ utmCampaign: u, readAt: '2026-11-09T10:00:00.000Z', buckets });
  const learning = new MemoryLearningStore(async () => buckets);
  const saved: { title: string; text: string }[] = [];
  const studio = new CreativeStudioService({ library: new MemoryCreativeLibraryStore(), brands: f.blogs, renderer, creators: f.store, distribution: { delivery: async () => [], outcomes }, learning,
    guidance: { saveAudienceNote: async (_a, _b, title, text) => { saved.push({ title, text }); return { documentId: randomUUID() }; } }, now: () => '2026-11-09T10:00:00.000Z' });
  const service: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => engine, socialCallback: async () => null, creativeEnabled: true, creativeFor: () => studio, creativeSavedImages: async () => [] };
  const who = { sessionToken: `token-${f.actor}`, userId: f.actor, workspaceId: f.brand.id, userEmail: 'owner@example.test' }, csrf = portalCsrfToken(SECRET, who.sessionToken);
  const page = `/portal/seo-blog/b/${f.brand.id}/campaigns/${record.id}`;
  let html = (await call(service, who, 'GET', page)).body;
  for (const text of ['What we learned', '5 tagged leads, 2 qualified, 1 booked', 'Add one variant to compare against', 'Suggested next tests', 'No budget is suggested', 'No findings recorded yet', `utm_campaign=${utm}`]) assert.ok(html.includes(text), text);
  assert.ok(html.indexOf('id="learning"') > html.lastIndexOf('</form>', html.indexOf('Approve this campaign draft')), 'the learning forms are not nested inside the edit form');
  const post = (action: string, form: Record<string, string>) => call(service, who, 'POST', `${page}/${action}`, { _csrf: csrf, commandId: randomUUID(), ...form });
  assert.equal((await post('findings', {})).status, 303);
  const [rec] = await learning.listFindings(f.brand.id, record.id);
  assert.equal(rec!.recordedAt, '2026-11-09T10:00:00.000Z');
  assert.equal(rec!.read.buckets[0]!.leads, 5);
  // Outcomes changed after the read: the journal refuses stale evidence.
  buckets = [bucket(creativeUtmContent(0, versionId), 6, 2, 1)];
  await assert.rejects(learning.recordFinding(f.brand.id, randomUUID(), 'x', rec!), /Outcomes changed/u);
  const refused = await post('pattern', { findingId: rec!.id, statement: `${f.brand.name} readers preferred practical first steps.` });
  assert.match(Buffer.from(new URL(refused.headers.location!, 'https://x').searchParams.get('e') ?? '', 'base64url').toString('utf8'), /brand names/u);
  assert.equal((await post('pattern', { findingId: rec!.id, statement: 'Practical first-step questions drew more qualified enquiries than general invitations.' })).status, 303);
  const [pattern] = await learning.patterns(f.brand.id, 'mine');
  assert.equal(pattern!.state, 'shared');
  html = (await call(service, who, 'GET', page)).body;
  assert.ok(html.includes('Recorded 2026-11-09') && html.includes('Patterns shared from this brand') && html.includes('Withdraw'));
  const noAck = await post('guidance', { findingId: rec!.id });
  assert.ok(new URL(noAck.headers.location!, 'https://x').searchParams.has('e'), 'copying into brand guidance needs explicit acknowledgement');
  assert.equal(saved.length, 0);
  await post('guidance', { findingId: rec!.id, acknowledge: '1' });
  assert.equal(saved.length, 1);
  assert.match(saved[0]!.title, /^Campaign findings · .* · 2026-11-09$/u);
  assert.match(saved[0]!.text, /recorded 2026-11-09.*\n- Concept 1.*\[evidence: utm_campaign=/su);
  assert.equal((await post('pattern-withdraw', { patternId: pattern!.patternId })).status, 303);
  assert.equal((await learning.patterns(f.brand.id, 'mine'))[0]!.state, 'withdrawn');
});
