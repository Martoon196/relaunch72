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
