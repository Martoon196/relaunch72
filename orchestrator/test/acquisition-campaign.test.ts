/** Milestone 2: evidence-led acquisition campaign proposals on the reviewed creator boundary. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildAcquisitionEvidence } from '../src/seo-blog/acquisition-evidence.js';
import { campaignUtm, creativePrefill, trackedLinks } from '../src/seo-blog/acquisition-assembly.js';
import { campaignProblems, type AcquisitionProposal } from '../src/seo-blog/campaign-creator.js';
import { campaignCreatorReviewPage, creatorContentFromForm, creatorTextExport } from '../src/portal/campaign-creator-view.js';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { UnconfiguredSearchProvider } from '../src/seo-blog/research.js';
import { handleSeoBlog } from '../src/portal/seo-blog-router.js';
import type { PortalSeoBlogService } from '../src/portal/seo-blog-service.js';
import { portalCsrfToken } from '../src/portal/session.js';
import { FakeWeb } from './seo-blog-fixtures.js';
import { acquisitionBrief, acquisitionFixture, audienceNote, plan, researchSource } from './acquisition-campaign-fixtures.js';

test('evidence pack: saved research first from accepted plans, deduplicated and bounded; only confirmed audience guidance; honest gaps', async () => {
  const f = await acquisitionFixture();
  const unbound = audienceNote(f.brand.id, 'An unconfirmed note that must never be used.');
  await f.blogs.saveKnowledge(unbound);
  const ev = buildAcquisitionEvidence({ profile: f.profile, knowledge: await f.blogs.listKnowledge(f.brand.id), plans: await f.blogs.listPlans(f.brand.id), articles: [] });
  assert.deepEqual(ev.research.map((s) => s.id), ['src-1', 'src-2', 'src-3'], 'accepted plan first, duplicate URL once, rejected plan excluded');
  assert.ok(ev.research.every((s) => [...s.passage].length <= 400));
  assert.deepEqual(ev.facts.map((x) => x.id), [`knowledge:${f.note!.id}:1`], 'only guidance bound to the confirmed profile');
  assert.deepEqual(ev.gaps, []);
  const bare = await acquisitionFixture({ research: false, note: false });
  const empty = buildAcquisitionEvidence({ profile: bare.profile, knowledge: [], plans: [plan(bare.brand.id, 'rejected', [researchSource(1)])], articles: [] });
  assert.equal(empty.research.length, 0);
  assert.ok(empty.gaps.some((g) => /No saved research/.test(g)) && empty.gaps.some((g) => /audience notes/.test(g)));
});

test('create: one reserved model run produces an evidence-cited proposal; client-supplied evidence is replaced; repeats do not pay again', async () => {
  const f = await acquisitionFixture(), id = randomUUID();
  const forged = { research: [researchSource(7, 'https://forged.example')], facts: [], gaps: [] };
  const r = await f.creator.create(f.actor, f.brand.id, id, { ...acquisitionBrief(f.profile), evidence: forged });
  assert.equal(r.state, 'draft'); assert.equal(f.model.acquisitionCalls, 1);
  assert.ok(!JSON.stringify(r.brief.evidence).includes('forged.example'), 'evidence is server-built only');
  assert.equal(r.brief.evidence!.research[0]!.id, 'src-1');
  const p = r.version!.content as AcquisitionProposal;
  assert.equal(p.concepts.length, 3); assert.equal(p.insights[0]!.basis, 'observed'); assert.deepEqual(p.insights[0]!.evidence, ['S1']);
  const receipt = await f.methods.receipt(f.brand.id, r.version!.methodReceiptId!);
  assert.equal(receipt!.stage, 'acquisition'); assert.ok(receipt!.pins.some((p) => p.packId === 'conversion-copy'));
  assert.equal((await f.creator.create(f.actor, f.brand.id, id, acquisitionBrief(f.profile))).id, id);
  assert.equal(f.model.acquisitionCalls, 1, 'a repeated command never calls the model again');
  await assert.rejects(f.creator.create(f.actor, f.brand.id, id, acquisitionBrief(f.profile, { count: 2 })), /different inputs/);
});

test('create: requires the reviewed Hook & Close pack, selected channels and approved destination', async () => {
  const off = await acquisitionFixture({ pins: ['production-core', 'email-writing'] });
  await assert.rejects(off.creator.create(off.actor, off.brand.id, randomUUID(), acquisitionBrief(off.profile)), /Hook & Close/);
  assert.equal(off.model.acquisitionCalls, 0);
  const f = await acquisitionFixture();
  await assert.rejects(f.creator.create(f.actor, f.brand.id, randomUUID(), acquisitionBrief(f.profile, { channels: [] })), /channel/);
  await assert.rejects(f.creator.create(f.actor, f.brand.id, randomUUID(), acquisitionBrief(f.profile, { cta: { label: 'Elsewhere', url: 'https://elsewhere.example' } })), /confirmed action/);
  await assert.rejects(f.creator.create(f.actor, f.brand.id, randomUUID(), acquisitionBrief(f.profile, { articleIds: [randomUUID()] })), /supporting articles/);
  assert.equal(f.model.acquisitionCalls, 0);
});

test('guards: cited evidence, observed vs inferred, channels, destination, commercial commitments and invented performance are all refused', async () => {
  const f = await acquisitionFixture();
  const r = await f.creator.create(f.actor, f.brand.id, randomUUID(), acquisitionBrief(f.profile));
  const brief = r.brief, good = r.version!.content as AcquisitionProposal;
  assert.deepEqual(campaignProblems(brief, good, f.profile), []);
  const variant = (mutate: (p: AcquisitionProposal) => void) => { const p = structuredClone(good); mutate(p); return campaignProblems(brief, p, f.profile).join(' '); };
  assert.match(variant((p) => { p.insights[0]!.evidence = ['S99']; }), /supplied evidence IDs/);
  assert.match(variant((p) => { p.insights[2]!.basis = 'observed'; }), /marked observed/);
  assert.match(variant((p) => { p.channels.push({ channel: 'search', role: 'Paid search', rationale: 'Search captures existing demand for this.' }); }), /channels the owner selected/);
  assert.match(variant((p) => { p.concepts[0]!.cta = { label: 'Buy now', url: brief.cta.url }; }), /confirmed destination/);
  assert.match(variant((p) => { p.concepts[1]!.headline = p.concepts[0]!.headline; }), /distinct concepts/);
  assert.match(variant((p) => { p.concepts[0]!.primaryText = 'Every visit comes with a money-back guarantee if you are not happy.'; }), /commercial commitments/);
  assert.match(variant((p) => { p.concepts[0]!.primaryText = 'Book this week for 20% off your first visit, a limited discount.'; }), /commercial|figures/);
  assert.match(variant((p) => { p.hypotheses[0]!.statement = 'We expect a 3.5% click-through rate and a ROAS of four.'; }), /must not invent numbers/);
  assert.match(variant((p) => { p.hypotheses[0]!.statement = 'This campaign generated strong interest last month among readers.'; }), /cannot report results/);
  assert.match(variant((p) => { p.summary = 'Competitors increased their spending on social budgets this quarter, so we should too.'; }), /competitor spend/);
  // A commitment that is genuinely in the approved facts is allowed.
  const withRefund = { ...f.profile, approvedClaims: [...f.profile.approvedClaims, 'Deposits are refunded in full if we cannot attend.'] };
  assert.doesNotMatch(campaignProblems(brief, (() => { const p = structuredClone(good); p.concepts[0]!.primaryText = 'Deposits are refunded in full if we cannot attend, so you can book calmly.'; return p; })(), withRefund).join(' '), /commercial commitments/);
});

test('a model that invents a guarantee is held for review, not shown as a usable draft, and never silently retried beyond policy', async () => {
  const f = await acquisitionFixture();
  f.model.mutate = (asset) => { if (asset.concepts) asset.concepts[0].primaryText = 'Results are guaranteed or your money back, every time you book with us.'; };
  const r = await f.creator.create(f.actor, f.brand.id, randomUUID(), acquisitionBrief(f.profile));
  assert.notEqual(r.state, 'draft'); assert.equal(r.version, null);
  assert.ok(f.model.acquisitionCalls >= 1 && f.model.acquisitionCalls <= 2, `bounded attempts (${f.model.acquisitionCalls})`);
});

test('edit, approve and export: owner edits are re-validated; exports keep predictions apart from (absent) actual results', async () => {
  const f = await acquisitionFixture();
  let r = await f.creator.create(f.actor, f.brand.id, randomUUID(), acquisitionBrief(f.profile, { count: 2 }));
  const fields = new URLSearchParams({ title: 'Spring enquiries', summary: (r.version!.content as AcquisitionProposal).summary });
  const p = r.version!.content as AcquisitionProposal;
  p.insights.forEach((i, n) => fields.set(`insight.${n}.statement`, i.statement));
  p.concepts.forEach((c, n) => { for (const k of ['hook', 'headline', 'primaryText', 'creativeDirection'] as const) fields.set(`concept.${n}.${k}`, c[k]); });
  fields.set('concept.0.headline', 'Know your first check before you call');
  const edited = creatorContentFromForm(r, fields) as AcquisitionProposal;
  assert.equal(edited.concepts[0]!.headline, 'Know your first check before you call');
  assert.deepEqual(edited.insights.map((i) => i.evidence), p.insights.map((i) => i.evidence), 'evidence citations cannot be edited from the browser');
  r = await f.creator.edit(f.actor, f.brand.id, r.id, r.rowVersion, r.version!.contentSha, edited);
  const bad = structuredClone(edited); bad.concepts[1]!.primaryText = 'Try it with a free trial and our lowest price promise for new customers.';
  await assert.rejects(f.creator.edit(f.actor, f.brand.id, r.id, r.rowVersion, r.version!.contentSha, bad), /commercial commitments/);
  await assert.rejects(f.creator.export(f.actor, f.brand.id, r.id), /approve/);
  r = await f.creator.approve(f.actor, f.brand.id, r.id, r.rowVersion, r.version!.contentSha, true);
  const json = JSON.parse(await f.creator.export(f.actor, f.brand.id, r.id));
  assert.equal(json.actualResults, null); assert.match(json.predictions, /not results/); assert.match(json.status, /nothing launched/);
  const text = creatorTextExport(r);
  assert.match(text, /PREDICTIONS \(hypotheses, not results\)/); assert.match(text, /ACTUAL RESULTS\nNone recorded\./);
  assert.match(text, /utm_campaign=spring-enquiries-/);
});

test('assembly: tracked links carry stable campaign and concept identities and preserve the approved destination', async () => {
  const f = await acquisitionFixture();
  const r = await f.creator.create(f.actor, f.brand.id, randomUUID(), acquisitionBrief(f.profile, { cta: f.profile.conversionPages[0]! }));
  const p = r.version!.content as AcquisitionProposal;
  const links = trackedLinks(r.brief, r.id, p);
  assert.equal(links.length, p.concepts.reduce((n, c) => n + c.channels.length, 0));
  for (const l of links) {
    const u = new URL(l.url); const dest = new URL(r.brief.cta.url);
    assert.equal(u.origin + u.pathname, dest.origin + dest.pathname);
    assert.equal(u.searchParams.get('utm_campaign'), campaignUtm(r.brief, r.id));
    assert.equal(u.searchParams.get('utm_content'), `concept-${l.concept + 1}`);
    assert.equal(u.searchParams.get('utm_medium'), 'social');
  }
  const pre = new URLSearchParams(creativePrefill(r.brief, p.concepts[0]!));
  assert.equal(pre.get('source_kind'), 'brief'); assert.equal(pre.get('destination'), r.brief.cta.url); assert.ok(pre.get('brief')!.startsWith(p.concepts[0]!.headline));
});

test('routes and review page: proposal form appears with the pack; review separates evidence, predictions and actual results; artwork hand-off pre-fills', async () => {
  const f = await acquisitionFixture();
  const engine = new SeoBlogEngine({ store: f.blogs, methods: f.controller, creatorStore: f.store, llm: f.model, search: new UnconfiguredSearchProvider(), transport: new FakeWeb(), publishers: new Map(), vault: null });
  const service: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => engine, socialCallback: async () => null, creativeEnabled: true, creativeFor: () => null };
  const who = { sessionToken: `token-${f.actor}`, userId: f.actor, workspaceId: f.brand.id, userEmail: 'o@example.test' };
  const csrf = portalCsrfToken('s'.repeat(48), who.sessionToken), base = `/portal/seo-blog/b/${f.brand.id}/campaigns`;
  const call = async (method: string, path: string, form?: Record<string, string | string[]>) => {
    const body = form ? new URLSearchParams(Object.entries(form).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]))).toString() : '';
    const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
    Object.assign(req, { method, url: path, headers: { host: 'p.example', ...(form ? { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://p.example' } : {}) } }); (req as PassThrough).end(body);
    let status = 0, headers: Record<string, string> = {}, out = '';
    const res = { writeHead(s: number, h: Record<string, string>) { status = s; headers = h; return res; }, end(c?: string) { if (c) out += c; } } as unknown as ServerResponse;
    await handleSeoBlog(req, res, new URL(path, 'https://p.example'), { service, identity: who, requestId: 'r', sessionSecret: 's'.repeat(48), vaultReady: true });
    return { status, headers, body: out };
  };
  const list = await call('GET', base);
  assert.equal(list.status, 200); assert.match(list.body, /Hook &amp; Close · Acquisition campaign/); assert.match(list.body, /does not publish, schedule, contact anyone or start any advertising spend/);
  const created = await call('POST', `${base}/create`, { _csrf: csrf, commandId: randomUUID(), kind: 'acquisition', purpose: 'acquisition', name: 'Spring enquiries', goal: 'Help readers take a calm first step.', objective: 'leads',
    audience: f.profile.audiences[0]!, offerName: '', ctaIndex: '0', channels: ['instagram', 'linkedin'], count: '2', permissionContext: 'Campaign proposal only.', customerMoment: '', consentProcess: '', incentiveTerms: 'None' });
  assert.equal(created.status, 303);
  const review = await call('GET', new URL(created.headers.location!, 'https://p.example').pathname);
  assert.equal(review.status, 200);
  for (const s of ['Audience insights', 'Observed in evidence', 'Fictional practical-check report 1', 'Hypotheses — not results', 'No results recorded.', 'utm_campaign=spring-enquiries-', 'Create artwork for this concept'])
    assert.ok(review.body.includes(s), s);
  const record = (await f.store.list(f.brand.id))[0]!;
  assert.ok(campaignCreatorReviewPage({ brands: [], brand: f.brand, tab: 'campaigns', csrf, creativeAvailable: false }, record, f.profile).indexOf('Create artwork') === -1, 'no artwork link when the studio is off');
});

test('the owner\u2019s own goal may contain a number; predictions still may not, and the command hash ignores derived evidence', async () => {
  const f = await acquisitionFixture();
  const id = randomUUID();
  const r = await f.creator.create(f.actor, f.brand.id, id, acquisitionBrief(f.profile, { goal: 'Fill 10 spring boiler-service slots with calm first enquiries.' }));
  assert.equal(r.state, 'draft', 'a numeric owner goal echoed into objective.goal is not an invented prediction');
  const p = r.version!.content as AcquisitionProposal;
  assert.match(campaignProblems(r.brief, { ...p, hypotheses: [{ statement: 'We should see about 40 enquiries.', basis: 'A guess that the research does not support.' }] }, f.profile).join(' '), /must not invent numbers/);
  assert.match(campaignProblems(r.brief, { ...p, objective: { ...p.objective, goal: 'We generated 10 slots last spring.' } }, f.profile).join(' '), /cannot report results/);
  // New research saved after the first call must not turn an identical resubmission into a conflict.
  await f.blogs.savePlan(plan(f.brand.id, 'accepted', [researchSource(4)], '2026-11-05T00:00:00.000Z'));
  const again = await f.creator.create(f.actor, f.brand.id, id, acquisitionBrief(f.profile, { goal: 'Fill 10 spring boiler-service slots with calm first enquiries.' }));
  assert.equal(again.id, id); assert.equal(f.model.acquisitionCalls, 1);
  // Superseded plans no longer contribute evidence.
  await f.blogs.savePlan(plan(f.brand.id, 'superseded', [researchSource(8)], '2026-11-06T00:00:00.000Z'));
  const ev = buildAcquisitionEvidence({ profile: f.profile, knowledge: await f.blogs.listKnowledge(f.brand.id), plans: await f.blogs.listPlans(f.brand.id), articles: [] });
  assert.ok(!ev.research.some((x) => x.id === 'src-8'));
});
