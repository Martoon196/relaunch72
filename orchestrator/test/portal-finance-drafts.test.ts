import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createPlanningClient, decimal, FIELDS, parsePlanning, packet, validateIllustration, type Planning } from '../src/integrations/mh196/planning-client.js';
import { FinanceDraftsService, type FinanceSnapshot, type SavedFinance, type SignedReview } from '../src/portal/finance-drafts-service.js';
import { renderFinanceForm, renderFinanceSaved, FINANCE_CLIENT_SOURCE } from '../src/portal/finance-drafts-view.js';
import { requestDatabaseContext } from '../src/db/rls.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/mh196-public-numeric.json', import.meta.url), 'utf8')) as { models: { model: string; request: { planning: Planning }; assumptions_as_of: string; response: unknown }[] };
for (const item of fixture.models) test(`pinned public response: ${item.model}`, () => {
  const planning = parsePlanning(item.request.planning);
  const result = validateIllustration(item.response, planning, item.assumptions_as_of);
  assert.ok(result.results.total_finance_cost); assert.ok(result.schedule.length);
  assert.equal(JSON.stringify(result).includes('introducer_id'), false);
});
test('decimal equality is exact, preserving negative fractions and rejecting rounding', () => {
  assert.equal(decimal('000.50000'), '0.5'); assert.equal(decimal('-0.25', 8, true), '-0.25');
  assert.throws(() => decimal('1.001', 2)); assert.throws(() => decimal('1e3'));
  const p = structuredClone(fixture.models[0]!.request.planning); p.inputs.current_value = '50000000.01'; assert.throws(() => parsePlanning(p));
});
test('input contract rejects unknown contact fields, missing values, boolean coercion and incoherent schedule', () => {
  for (const change of [ (p: Planning) => { p.inputs.email = 'client@example.test'; }, (p: Planning) => { delete p.inputs.current_value; }, (p: Planning) => { p.inputs.costs_confirmed = 'false'; }, (p: Planning) => { p.inputs.works_schedule = [{ month: 1, amount: '1' }]; } ]) { const p = structuredClone(fixture.models[0]!.request.planning); change(p); assert.throws(() => parsePlanning(p)); }
});
test('returned input changes and unsupported result fields are rejected', () => {
  const item = fixture.models[0]!;
  const answer = structuredClone(item.response) as { planning: { inputs: Record<string, unknown>; results: Record<string, unknown> } };
  answer.planning.inputs.current_value = '123'; assert.throws(() => validateIllustration(answer, item.request.planning, item.assumptions_as_of));
  const extra = structuredClone(item.response) as typeof answer; extra.planning.results.contact_email = 'private'; assert.throws(() => validateIllustration(extra, item.request.planning, item.assumptions_as_of));
});
test('public calculator has fixed origin, numeric-only body, no secrets and refuses redirects/oversized replies', async () => {
  const item = fixture.models[0]!; let called = false;
  const client = createPlanningClient((async (url, options) => { called = true; assert.equal(url, 'https://mh196-finance.onrender.com/api/planning/v1/illustrate'); assert.equal(options?.redirect, 'error'); assert.equal(options?.credentials, 'omit'); const body = JSON.parse(String(options?.body)); assert.deepEqual(Object.keys(body).sort(), ['package_id', 'package_version', 'planning', 'schema_version']); assert.equal('authorization' in (options?.headers ?? {}), false); return new Response(JSON.stringify(item.response)); }) as typeof fetch);
  await client.calculate(item.request.planning, item.assumptions_as_of); assert.equal(called, true);
  const huge = createPlanningClient((async () => new Response('x'.repeat(160001))) as typeof fetch);
  await assert.rejects(huge.calculate(item.request.planning, item.assumptions_as_of));
});

const O = '22222222-2222-4222-8222-222222222222', W = '11111111-1111-4111-8111-111111111111', U = '33333333-3333-4333-8333-333333333333', C = '44444444-4444-4444-8444-444444444444';
function harness() {
  const item = structuredClone(fixture.models.find(item => item.model === 'bridging_refurb')!);
  item.request.planning.inputs.borrower_broker_fee = '0';
  let active = true, now = Date.parse('2026-10-26T16:00:00Z'), calls = 0, hook = () => {};
  const snapshot: FinanceSnapshot = { source: { workspaceId: W, workspaceName: 'Test workspace', opportunityId: O, opportunityName: 'Test opportunity', contactId: C, contactName: 'Private client', opportunityVersion: 3, latestVersion: 0, canWrite: true }, versions: [] };
  const reviews: SignedReview[] = [];
  const service = new FinanceDraftsService({ secret: 'server-only-finance-review-test-secret-12345', now: () => now,
    async context() { return active ? requestDatabaseContext({ userId: U, workspaceId: W, requestId: 'finance-test' }) : null; },
    repository: { async snapshot() { return structuredClone(snapshot); }, async save(_context, review) { reviews.push(review); return { id: O, version: 1, opportunityVersion: 3, packet: review.packet, illustration: review.illustration, calculatedAt: review.calculatedAt, savedAt: review.calculatedAt }; } },
    client: { async catalog() { return { products: [] }; }, async calculate(planning, date) { calls++; hook(); return validateIllustration(item.response, planning, date); } },
  });
  const identity = { sessionToken: 'opaque-session', requestId: 'finance-test' };
  return { service, item, identity, snapshot, reviews, calls: () => calls, deactivate: () => { active = false; }, expire: () => { now += 31 * 60 * 1000; }, hook: (value: () => void) => { hook = value; } };
}
test('calculate then explicit save retains exact review; reopening never calculates', async () => {
  const h = harness(), review = await h.service.calculate(h.identity, O, h.item.request.planning, h.item.assumptions_as_of, 3, 0);
  await h.service.save(h.identity, O, review.reviewToken); await h.service.snapshot(h.identity, O);
  assert.equal(h.calls(), 1); assert.equal(h.reviews.length, 1); assert.deepEqual(h.reviews[0]!.packet, review.packet);
});
test('review cannot be saved by another session/opportunity, altered or after expiry', async () => {
  const h = harness(), review = await h.service.calculate(h.identity, O, h.item.request.planning, h.item.assumptions_as_of, 3, 0);
  await assert.rejects(h.service.save({ ...h.identity, sessionToken: 'other' }, O, review.reviewToken));
  await assert.rejects(h.service.save(h.identity, U, review.reviewToken));
  await assert.rejects(h.service.save(h.identity, O, review.reviewToken.replace(/^./, 'a')));
  h.expire(); await assert.rejects(h.service.save(h.identity, O, review.reviewToken)); assert.equal(h.reviews.length, 0);
});
test('viewer and preexisting stale source make zero calculator calls', async () => {
  const h = harness(); h.snapshot.source.canWrite = false;
  await assert.rejects(h.service.calculate(h.identity, O, h.item.request.planning, h.item.assumptions_as_of, 3, 0)); assert.equal(h.calls(), 0);
  h.snapshot.source.canWrite = true;
  await assert.rejects(h.service.calculate(h.identity, O, h.item.request.planning, h.item.assumptions_as_of, 2, 0)); assert.equal(h.calls(), 0);
});
test('session revocation and source change during calculation discard the result', async () => {
  for (const mode of ['session', 'source']) { const h = harness(); h.hook(() => { if (mode === 'session') h.deactivate(); else h.snapshot.source.opportunityVersion++; }); await assert.rejects(h.service.calculate(h.identity, O, h.item.request.planning, h.item.assumptions_as_of, 3, 0)); assert.equal(h.calls(), 1); assert.equal(h.reviews.length, 0); }
});
test('form leaves money unknown, retains entered zero, and client packet contains only numerical proposals', () => {
  const h = harness(), p = parsePlanning(h.item.request.planning);
  const catalog = { products: [{ id: p.preset_id, name: 'Bridging', as_of: h.item.assumptions_as_of, inputs: p.inputs }] };
  const body = renderFinanceForm(h.snapshot, catalog, p.preset_id, 'csrf');
  assert.match(body, /href="\/portal\/crm\/opportunities">Pipeline<\/a>/);
  assert.doesNotMatch(body, /href="\/portal\/crm\/pipeline"/);
  assert.match(body, /Spread evenly across the works period/); assert.match(body, /type="hidden" name="input_works_schedule" value="\[\]"/); assert.doesNotMatch(body, /<textarea[^>]*name="input_works_schedule"/);
  for (const key of Object.keys(FIELDS).filter(key => FIELDS[key]!.kind === 'amount' && key !== 'borrower_broker_fee')) assert.match(body, new RegExp(`name="input_${key}"[^>]*value=""`));
  assert.match(body, /not been used as a property price/);
  const submitted = renderFinanceForm(h.snapshot, catalog, p.preset_id, 'csrf', { input_works_cost: '0' }, 'Check costs'); assert.match(submitted, /name="input_works_cost"[^>]*value="0"/);
  const value = packet(p, h.item.assumptions_as_of); assert.deepEqual(Object.keys(value), ['v', 'package_version', 'model_version', 'assumptions_as_of', 'planning']);
  const saved: SavedFinance = { id: O, version: 1, opportunityVersion: 3, packet: value, illustration: validateIllustration(h.item.response, p, h.item.assumptions_as_of), calculatedAt: '2026-10-26T16:00:00Z', savedAt: '2026-10-26T16:01:00Z' };
  const html = renderFinanceSaved({ ...h.snapshot, versions: [saved] }); assert.match(html, /Copy client review link/); assert.match(html, /has not run another calculation/); assert.doesNotMatch(html, /finance\.html#import=/);
  assert.match(html, /Monthly calculation/); assert.match(html, /Calculation assumptions/); assert.doesNotMatch(html, /<pre/);
  saved.packet.planning.inputs.works_schedule = [{ month: 1, amount: '5000' }];
  const staged = renderFinanceSaved({ ...h.snapshot, versions: [saved] }); assert.match(staged, /Reviewed works schedule/); assert.match(staged, /<td>1<\/td><td>£5,000.00<\/td>/);
  assert.match(FINANCE_CLIENT_SOURCE, /addEventListener\('click'/); assert.match(FINANCE_CLIENT_SOURCE, /beforeunload/);
});
test('copy action encodes the exact numeric packet only after an explicit click; dirty form navigation is guarded', async () => {
  const p = packet(parsePlanning(fixture.models[0]!.request.planning), fixture.models[0]!.assumptions_as_of);
  const handlers: Record<string, () => unknown> = {}, formEvents: Record<string, (event?: unknown) => void> = {};
  let beforeUnload: ((event: { preventDefault(): void; returnValue?: string }) => void) | undefined, copied = '';
  const target = { dataset: { packet: JSON.stringify(p) }, value: '', hidden: true }, status = { textContent: '' };
  vm.runInNewContext(FINANCE_CLIENT_SOURCE, { TextEncoder, btoa: (text: string) => Buffer.from(text, 'binary').toString('base64'), navigator: { clipboard: { async writeText(text: string) { copied = text; } } },
    addEventListener: (_kind: string, callback: typeof beforeUnload) => { beforeUnload = callback; },
    document: { querySelector: () => ({ addEventListener: (event: string, callback: (event?: unknown) => void) => { formEvents[event] = callback; } }), querySelectorAll: () => [{ dataset: { financeCopy: 'link', status: 'status' }, addEventListener: (event: string, callback: () => unknown) => { handlers[event] = callback; } }], getElementById: (id: string) => id === 'link' ? target : status },
  });
  assert.equal(copied, ''); assert.equal(target.hidden, true);
  await handlers.click!(); assert.equal(target.hidden, false);
  const url = new URL(copied); assert.equal(url.origin, 'https://propertypredator.com'); assert.equal(url.pathname, '/finance.html'); assert.equal(url.search, '');
  assert.deepEqual(JSON.parse(Buffer.from(url.hash.slice('#import='.length), 'base64url').toString('utf8')), p);
  let prevented = false; beforeUnload!({ preventDefault() { prevented = true; } }); assert.equal(prevented, false);
  formEvents.input!(); beforeUnload!({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  prevented = false; formEvents.submit!(); beforeUnload!({ preventDefault() { prevented = true; } }); assert.equal(prevented, false);
});
