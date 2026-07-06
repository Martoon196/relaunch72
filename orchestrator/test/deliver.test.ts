import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeliveryEmail, buildEml, attachmentList } from '../src/deliver/deliver.js';

const compliance = 'This document is marketing material prepared by Relaunch72 — no guarantee of revenue, results or outcomes.';
const ctx = { business: 'Frayne Electrical', stages: ['S1', 'S6', 'S9'], complianceLine: compliance, firstName: 'Dan' };

test('delivery email names the business, greets by first name, lists the deliverables', () => {
  const e = buildDeliveryEmail(ctx);
  assert.match(e.subject, /Frayne Electrical/);
  assert.match(e.body, /Hi Dan,/);
  assert.match(e.body, /One-Page Business Plan|Relaunch On A Page/); // S9 lexicon name
  assert.match(e.body, /Marketing Audit|Relaunch Scorecard/); // S1 lexicon name
});

test('delivery email carries the compliance line and makes no outcome promise', () => {
  const e = buildDeliveryEmail(ctx);
  assert.match(e.body, /marketing material/i);
  assert.doesNotMatch(e.body, /guarantee(d)? (you|your|to (get|make|earn))/i);
});

test('email falls back to a neutral greeting with no first name', () => {
  const e = buildDeliveryEmail({ ...ctx, firstName: undefined });
  assert.match(e.body, /^Hi,/);
});

test('buildEml produces valid headers and a {{customer_email}} placeholder when no recipient', () => {
  const eml = buildEml(buildDeliveryEmail(ctx), { date: 'Mon, 06 Jul 2026 12:00:00 +0000' });
  assert.match(eml, /^From: .+/m);
  assert.match(eml, /^To: \{\{customer_email\}\}/m);
  assert.match(eml, /^Subject: Your Relaunch72 pack/m);
  assert.match(eml, /Content-Type: text\/plain/);
});

test('buildEml uses the supplied recipient', () => {
  const eml = buildEml(buildDeliveryEmail(ctx), { to: 'sam@acme.com', date: 'now' });
  assert.match(eml, /^To: sam@acme\.com/m);
});

test('attachmentList covers the index plus every stage PDF', () => {
  assert.deepEqual(attachmentList('/r/docs', ['S1', 'S6']), ['/r/docs/index.pdf', '/r/docs/s1.pdf', '/r/docs/s6.pdf']);
});
