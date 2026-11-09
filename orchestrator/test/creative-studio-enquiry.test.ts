/** Brand enquiry capture: untrusted UTM handling, form tokens bound to the tags, input checks, embed code and owner page. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { enquiryEmbedSnippet, enquiryInput, enquiryPage, enquiryToken, parseUtm, verifyEnquiryToken } from '../src/creative-studio/enquiry-capture.js';
import { creativeEnquiriesPage } from '../src/portal/creative-generation-view.js';

const S = 's'.repeat(48), ws = randomUUID(), key = 'a'.repeat(24);

test('UTM values are untrusted evidence: only four keys, conservative shape, nothing else kept', () => {
  const u = parseUtm(new URLSearchParams('utm_source=instagram&utm_medium=social&utm_campaign=spring-plan-1234abcd&utm_content=concept-1-csabcdef12&email=a@b.c&utm_term=x&gclid=1'));
  assert.deepEqual(u, { utm_source: 'instagram', utm_medium: 'social', utm_campaign: 'spring-plan-1234abcd', utm_content: 'concept-1-csabcdef12' });
  assert.deepEqual(parseUtm(new URLSearchParams('utm_campaign=<script>&utm_content=Name%20Surname&utm_source=' + 'x'.repeat(61))), {});
});

test('a form token is bound to the brand form, the exact tags and one hour', () => {
  const utm = { utm_campaign: 'spring-plan-1234abcd', utm_content: 'concept-1-csabcdef12' }, now = Date.now();
  const t = enquiryToken(S, ws, key, utm, now);
  assert.ok(verifyEnquiryToken(S, ws, key, utm, t, now + 1000));
  assert.equal(verifyEnquiryToken(S, ws, key, { ...utm, utm_content: 'concept-2-csabcdef12' }, t, now), null, 'tags changed');
  assert.equal(verifyEnquiryToken(S, randomUUID(), key, utm, t, now), null, 'another brand');
  assert.equal(verifyEnquiryToken(S, ws, 'b'.repeat(24), utm, t, now), null, 'another form key');
  assert.equal(verifyEnquiryToken(S, ws, key, utm, t, now + 3_601_000), null, 'expired');
  assert.equal(verifyEnquiryToken('t'.repeat(48), ws, key, utm, t, now), null, 'another secret');
});

test('enquiry input: name, email, message and explicit contact permission; phone optional; control characters removed', () => {
  const ok = enquiryInput(new URLSearchParams({ name: ' Ann\u0007 ', email: 'Ann@Example.test', phone: '', message: 'Boiler check', consent: 'yes' }));
  assert.deepEqual(ok, { name: 'Ann', email: 'ann@example.test', phone: '', message: 'Boiler check' });
  for (const bad of [{ email: 'x@y.test', message: 'm', consent: 'yes' }, { name: 'A', email: 'not-an-email', message: 'm', consent: 'yes' },
    { name: 'A', email: 'a@b.test', message: 'm' }, { name: 'A', email: 'a@b.test', message: 'm', consent: 'yes', phone: 'call me' }, { name: 'A', email: 'a@b.test', consent: 'yes' }])
    assert.throws(() => enquiryInput(new URLSearchParams(bad as Record<string, string>)));
});

test('the form page carries no personal data in its action; the embed forwards only shape-checked tags', () => {
  const html = enquiryPage({ brandName: 'Fictional <Brand>', privacyUrl: 'https://x.example/privacy', action: `/enquire/${ws}/${key}`, token: 't', utm: { utm_campaign: 'c-1234abcd' }, embed: false });
  assert.match(html, /Fictional &lt;Brand&gt;/u); assert.match(html, /name="utm_campaign" value="c-1234abcd"/u); assert.match(html, /method="post"/u);
  const snippet = enquiryEmbedSnippet('https://app.example', ws, key);
  assert.match(snippet, /utm_source.*utm_medium.*utm_campaign.*utm_content/u); assert.match(snippet, /\[a-z0-9_-\]\{1,60\}/u);
  assert.equal(/email|name=|phone/iu.test(snippet), false);
});

test('owner page: stage mapping by id, privacy notice, embed code only when switched on', () => {
  const shell = { brands: [], brand: { id: ws, name: 'B', slug: 'b' } as never, tab: 'creative' as const, csrf: 'c' } as never;
  const stages = [{ id: randomUUID(), name: 'New enquiry', type: 'open' as const, position: 10 }, { id: randomUUID(), name: 'Qualified', type: 'open' as const, position: 30 }, { id: randomUUID(), name: 'Won', type: 'won' as const, position: 40 }];
  const base = { configured: true, enabled: false, publicKey: key, privacyUrl: null, ownerUserId: randomUUID(), pipelineId: randomUUID(), pipelineName: 'Enquiries', newStageId: stages[0]!.id, qualifiedStageId: stages[1]!.id, rowVersion: 1, stages, touches: 0 };
  const off = creativeEnquiriesPage(shell, { settings: base, brandId: ws, origin: 'https://app.example', live: true });
  assert.match(off, /Stage that means “qualified”/u); assert.match(off, new RegExp(`value="${stages[1]!.id}" selected`, 'u'));
  assert.equal(off.includes('Won</option>'), false, 'won/lost stages are not offered as qualified'); assert.equal(off.includes('Embed code'), false);
  const on = creativeEnquiriesPage(shell, { settings: { ...base, enabled: true, privacyUrl: 'https://b.example/privacy' }, brandId: ws, origin: 'https://app.example', live: true });
  assert.match(on, /Embed code/u); assert.ok(on.includes(`https://app.example/enquire/${ws}/${key}`));
});

// ---- audit additions -------------------------------------------------------------------------------------------------
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ENQUIRY_LIMITS, EnquiryError, enquiryTaskDescription, handleEnquiryPublic, PgEnquiryCapture } from '../src/creative-studio/enquiry-capture.js';

/** A fake content pool whose definer functions answer from a script; records every SQL call. */
function fakePool(answers: Record<string, unknown>) {
  const calls: string[] = [];
  const client = { query: async (sql: string) => { calls.push(sql); for (const [k, v] of Object.entries(answers)) if (sql.includes(k)) return { rows: [{ v }] }; return { rows: [] }; }, release() {} };
  return { pool: { connect: async () => client } as never, calls };
}
const target = { brandName: 'Fictional Hearth', privacyUrl: 'https://hearth.example/privacy', ownerUserId: randomUUID(), pipelineId: randomUUID(), stageId: randomUUID(), frameOrigins: ['https://hearth.example', 'https://www.hearth.example'] };

test('the hourly cap is decided by the database admission, and a refused admission never reaches the CRM', async () => {
  const { pool } = fakePool({ creative_studio_capture_target: target, creative_studio_capture_admit: { admitted: false, reason: 'rate_limited' } });
  let leads = 0; const capture = new PgEnquiryCapture({ contentPool: pool, crm: { createLead: async () => { leads++; return { disposition: 'applied', contactId: randomUUID(), opportunityId: randomUUID(), taskId: null, createdContact: true }; } } });
  await assert.rejects(capture.capture(ws, key, 'nonce', { name: 'A', email: 'a@example.test', phone: '', message: 'Hi there' }, {}, 'r'), (e: EnquiryError) => e.status === 429);
  assert.equal(leads, 0); assert.equal(ENQUIRY_LIMITS.perHour, 50);
});

test('only the email is a CRM contact point; the phone number and the permission evidence live in the task text; a lost touch does not fail the visitor', async () => {
  const { pool } = fakePool({ creative_studio_capture_target: target, creative_studio_capture_admit: { admitted: true, replayed: false } });
  let command: Record<string, unknown> | null = null;
  const capture = new PgEnquiryCapture({ contentPool: pool, crm: { createLead: async (_c, cmd) => { command = cmd as unknown as Record<string, unknown>; return { disposition: 'applied', contactId: randomUUID(), opportunityId: randomUUID(), taskId: null, createdContact: true }; } } });
  const out = await capture.capture(ws, key, 'nonce', { name: 'Ann', email: 'ann@example.test', phone: '07700 900123', message: 'Boiler check please' }, { utm_campaign: 'c-1234abcd' }, 'r');
  assert.deepEqual((command!.contactPoints as unknown[]).map((p) => (p as { kind: string }).kind), ['email']);
  const task = (command!.task as { description: string }).description;
  assert.match(task, /07700 900123/u); assert.match(task, /Permission to reply .*hearth.example\/privacy/u); assert.match(task, /not marketing consent/u);
  assert.equal(out.touch.recorded, false); assert.equal(out.touch.reason, 'touch_unrecorded', 'the fake pool has no record_touch answer: the lead still stands');
  assert.equal(enquiryTaskDescription({ name: 'x', email: 'x@y.test', phone: '', message: 'm'.repeat(5000) }, 'https://p.example').length, 4000);
});

async function publicRequest(capture: PgEnquiryCapture, method: string, path: string, body?: string) {
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, { method, url: path, headers: body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {} });
  (req as PassThrough).end(body ?? '');
  let status = 0, headers: Record<string, string> = {}, out = '';
  const res = { writeHead(s: number, h: Record<string, string>) { status = s; headers = h; return res; }, end(c?: string) { out += c ?? ''; } } as unknown as ServerResponse;
  await handleEnquiryPublic(req, res, capture, S, 'req-1');
  return { status, headers, body: out };
}

test('framing: the hosted form cannot be framed; the embed form may be framed only by the brand’s own origins; the same token is kept on a correction', async () => {
  const { pool } = fakePool({ creative_studio_capture_target: target });
  const capture = new PgEnquiryCapture({ contentPool: pool, crm: { createLead: async () => { throw new Error('unused'); } } });
  const hosted = await publicRequest(capture, 'GET', `/enquire/${ws}/${key}`);
  assert.equal(hosted.status, 200); assert.match(hosted.headers['content-security-policy']!, /frame-ancestors 'none'/u);
  const embed = await publicRequest(capture, 'GET', `/enquire/${ws}/${key}?embed=1&utm_campaign=c-1234abcd`);
  assert.match(embed.headers['content-security-policy']!, /frame-ancestors https:\/\/hosted\.invalid|frame-ancestors https:\/\/hearth\.example https:\/\/www\.hearth\.example/u);
  const noOrigins = new PgEnquiryCapture({ contentPool: fakePool({ creative_studio_capture_target: { ...target, frameOrigins: [] } }).pool, crm: { createLead: async () => { throw new Error('unused'); } } });
  assert.equal((await publicRequest(noOrigins, 'GET', `/enquire/${ws}/${key}?embed=1`)).status, 404, 'no allowed origin: no embed form');
  assert.equal((await publicRequest(noOrigins, 'GET', `/enquire/${ws}/${key}`)).status, 200, 'the hosted form still works');
  const token = /name="token" value="([^"]+)"/u.exec(hosted.body)![1]!;
  const corrected = await publicRequest(capture, 'POST', `/enquire/${ws}/${key}`, new URLSearchParams({ token, name: 'A', email: 'not-an-email', message: 'm', consent: 'yes' }).toString());
  assert.equal(corrected.status, 400); assert.ok(corrected.body.includes(`name="token" value="${token}"`), 'a still-valid token is re-used, so the corrected resend replays the same submission');
  assert.equal((await publicRequest(capture, 'GET', `/enquire/${ws}/${'z'.repeat(24)}`)).status, 404);
});

test('token: future stamps and malformed shapes are refused; enquiry errors are typed 400s', () => {
  const t = enquiryToken(S, ws, key, {}, Date.now());
  assert.equal(verifyEnquiryToken(S, ws, key, {}, t, Date.now() - 5_000), null, 'a token from the future');
  assert.equal(verifyEnquiryToken(S, ws, key, {}, 'garbage', Date.now()), null);
  for (const [bad, re] of [[{ email: 'x@y.test', message: 'm', consent: 'yes' }, /name/u], [{ name: 'A', email: 'nope', message: 'm', consent: 'yes' }, /email/u],
    [{ name: 'A', email: 'a@b.test', message: 'm' }, /confirm/u], [{ name: 'A', email: 'a@b.test', message: 'm', consent: 'yes', phone: 'call me' }, /phone/u]] as const)
    assert.throws(() => enquiryInput(new URLSearchParams(bad as Record<string, string>)), (e: unknown) => e instanceof EnquiryError && e.status === 400 && re.test(e.message));
});
