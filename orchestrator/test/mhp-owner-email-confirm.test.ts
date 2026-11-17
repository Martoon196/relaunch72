import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { emailWorld as world, EMAIL_BASE as BASE } from './helpers/mhp-owner-email-confirm-fixture.js';
import { ids, identity, token } from './helpers/mhp-owner-email-fixture.js';
import { portalCsrfToken } from '../src/portal/session.js';
import { visibleText } from './helpers/mhp-sequence-safety-fixture.js';
import { MhpCommerceError } from '../src/mhp/commerce-service.js';
const SECRET = 'synthetic-owner-email-confirm-secret-at-least-32';
const prospect = (n: number) => `0e3a1000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const person = (n: number) => ({ prospectId: prospect(n), email: `guest.${n}@example.invalid`, firstName: `Guest ${n}`, label: 'Before You Buy live webinar', registeredAt: null, marketingConsent: true, unsubscribed: false, signupConsentGiven: true });
const DUE = '2026-11-01T09:30', EXPIRES = '2026-11-02T09:30';
const confirmPath = (kind: string, times = true) => `${BASE}?item=${ids.item}&version=${ids.version}&confirm=${kind}${times ? `&dueAt=${DUE}&expiresAt=${EXPIRES}` : ''}`;

test('owner email: the page no longer schedules in one press; it opens a confirmation naming everyone', async () => {
  const f = world();
  const html = (await f.request('GET', `${BASE}?item=${ids.item}&version=${ids.version}`)).body;
  assert.doesNotMatch(html, /action="\/hq\/marketing\/emails\/schedule"/u); assert.match(html, /<form method="get" action="\/hq\/marketing\/emails">.*name="confirm" value="schedule"/su);
  const confirm = await f.request('GET', confirmPath('schedule')); const text = visibleText(confirm.body);
  assert.equal(confirm.status, 200); assert.match(text, /You are about to email 6 people/u);
  assert.match(text, /Who: people who registered for “Before You Buy live webinar” and agreed to emails\./u);
  assert.match(text, /Email: “Hi \{\{FIRSTNAME\}\}”, sent Sun 1 Nov, 09:30 \(UK time\) ?\./u);
  for (let n = 1; n <= 6; n++) assert.match(confirm.body, new RegExp(`guest\\.${n}@example\\.invalid`, 'u'));
  assert.doesNotMatch(confirm.body, /guest\.7@|guest\.8@/u); assert.match(text, /1 person did not agree to emails/u); assert.match(text, /1 person unsubscribed/u);
  assert.match(text, /Yes, send to these 6 people/u); assert.match(confirm.body, /<button>Schedule for 6 people<\/button>/u);
  assert.deepEqual(f.w.calls, []);
});
test('owner email: ticking and pressing schedules exactly the people shown; then the result is on the page', async () => {
  const f = world(); const fields = f.formFields((await f.request('GET', confirmPath('schedule'))).body, `${BASE}/schedule`);
  const unticked = await f.request('POST', `${BASE}/schedule`, fields.toString()); assert.equal(unticked.status, 400); assert.deepEqual(f.w.calls, []);
  fields.set('confirm', 'yes'); const done = await f.request('POST', `${BASE}/schedule`, fields.toString());
  assert.equal(done.status, 303); assert.match(done.headers.location!, /#result$/u); assert.match(done.headers['set-cookie']!, /^mhp_owner_note=/u);
  assert.deepEqual(f.w.calls, ['schedule']); assert.equal(f.w.rows.size, 6);
  assert.match(visibleText((await f.request('GET', done.headers.location!)).body), /Scheduled for 6 people\. It goes 1 Nov 2026, 09:30 \(UK time\)\./u);
});
test('owner email: a changed list, a forged or tampered confirmation, or an old one schedules nobody', async () => {
  const f = world(); const fields = f.formFields((await f.request('GET', confirmPath('schedule'))).body, `${BASE}/schedule`); fields.set('confirm', 'yes');
  for (const [key, value] of [['count', '5'], ['digest', 'a'.repeat(64)], ['sig', 'f'.repeat(64)], ['dueAt', '2026-11-01T10:30'], ['versionId', '12600000-0000-4000-8000-000000000099']] as const) {
    const forged = new URLSearchParams(fields); forged.set(key, value); assert.equal((await f.request('POST', `${BASE}/schedule`, forged.toString())).status, 400, key);
  }
  f.w.candidates.push(person(9));
  const changed = await f.request('POST', `${BASE}/schedule`, fields.toString());
  assert.equal(changed.status, 409); assert.match(visibleText(changed.body), /The list changed, so nothing was scheduled.*When you looked, this was 6 people\. It is now 7 people\./su);
  assert.deepEqual(f.w.calls, []);
  f.w.now += 31 * 60_000; const fresh = f.formFields(changed.body, `${BASE}/schedule`); fresh.set('confirm', 'yes'); f.w.now += 31 * 60_000;
  const old = await f.request('POST', `${BASE}/schedule`, fresh.toString()); assert.equal(old.status, 409); assert.match(old.body, /more than 30 minutes old/u);
  assert.deepEqual(f.w.calls, []);
  // The public service queue refuses scheduling and replacing outright.
  await assert.rejects(f.service.queue(identity, ids.request, { action: 'schedule', commandId: ids.command, versionId: ids.version, dueAt: '2026-11-01T09:30:00.000Z', expiresAt: '2026-11-02T09:30:00.000Z' }), { status: 409 });
  await assert.rejects(f.service.queue(identity, ids.request, { action: 'replace', commandId: ids.command, versionId: ids.version, dueAt: '2026-11-01T09:30:00.000Z', expiresAt: '2026-11-02T09:30:00.000Z' }), { status: 409 });
});
test('owner email: never more than the page can check, and never a guess about who is left', async () => {
  const f = world(); f.w.candidates = Array.from({ length: 101 }, (_, i) => person(i + 1));
  assert.match(visibleText((await f.request('GET', confirmPath('schedule'))).body), /This list is longer than this page can safely check \(101 people\)\. Nothing was scheduled\./u);
  const g = world(); g.w.rows.set(prospect(1), 'pending');
  const refused = visibleText((await g.request('GET', confirmPath('schedule'))).body);
  assert.match(refused, /One person already has this email scheduled, sent or cancelled\. This page cannot yet tell exactly who is left/u); assert.doesNotMatch(refused, /Yes, send/u);
});
test('owner email: a person who signs up in the moment of the press is reported, not hidden', async () => {
  const f = world(); const fields = f.formFields((await f.request('GET', confirmPath('schedule'))).body, `${BASE}/schedule`); fields.set('confirm', 'yes');
  f.w.beforeQueue = () => f.w.candidates.push(person(20));
  const landed = visibleText((await f.request('GET', (await f.request('POST', `${BASE}/schedule`, fields.toString())).headers.location!)).body);
  assert.match(landed, /Scheduled for 6 people\..* 1 person not on your list was also scheduled, because they signed up at the same moment\./su);
});
test('owner email: replace confirms who is affected and needs the tick; cancel has a short confirmation', async () => {
  const f = world(); for (let n = 1; n <= 3; n++) f.w.rows.set(prospect(n), 'pending');
  const html = (await f.request('GET', `${BASE}?item=${ids.item}&version=${ids.version}`)).body;
  assert.doesNotMatch(html, /action="\/hq\/marketing\/emails\/(?:replace|cancel)"/u); assert.match(html, /confirm=cancel">Cancel unsent emails…/u);
  const replace = await f.request('GET', confirmPath('replace'));
  assert.match(visibleText(replace.body), /Change 3 unsent emails to this version and time\? Up to 3 people who already have this email scheduled and not yet sent will get “Hi \{\{FIRSTNAME\}\}” at Sun 1 Nov, 09:30 \(UK time\) instead\. Nobody new is added/u);
  const fields = f.formFields(replace.body, `${BASE}/replace`);
  assert.equal((await f.request('POST', `${BASE}/replace`, fields.toString())).status, 409); assert.deepEqual(f.w.calls, []);
  fields.set('confirm', 'yes'); const done = await f.request('POST', `${BASE}/replace`, fields.toString()); assert.equal(done.status, 303);
  assert.match(visibleText((await f.request('GET', done.headers.location!)).body), /Changed 3 unsent emails to this version and time\./u);
  const cancel = await f.request('GET', confirmPath('cancel', false)); assert.match(visibleText(cancel.body), /Cancel 3 unsent emails\? They will not be sent\./u);
  const cancelled = await f.request('POST', `${BASE}/cancel`, f.formFields(cancel.body, `${BASE}/cancel`).toString()); assert.equal(cancelled.status, 303);
  assert.ok([...f.w.rows.values()].every(v => v === 'cancelled')); assert.deepEqual(f.w.calls, ['replace', 'cancel']);
  // A forged cancel without the signed confirmation does nothing.
  const forged = new URLSearchParams({ csrf: portalCsrfToken(SECRET, token), commandId: ids.command, itemId: ids.item, versionId: ids.version });
  assert.equal((await f.request('POST', `${BASE}/cancel`, forged.toString())).status, 400);
});
test('owner email: each form has its own command id, and a note shows only on its own email', async () => {
  const f = world(); f.w.rows.set(prospect(1), 'pending');
  const html = (await f.request('GET', `${BASE}?item=${ids.item}&version=${ids.version}`)).body;
  const ids_ = [...html.matchAll(/name="commandId" value="([^"]+)"/gu)].map(m => m[1]); assert.ok(ids_.length >= 2); assert.equal(new Set(ids_).size, ids_.length);
  const cancel = await f.request('GET', confirmPath('cancel', false));
  const done = await f.request('POST', `${BASE}/cancel`, f.formFields(cancel.body, `${BASE}/cancel`).toString());
  const location = done.headers.location!, query = location.slice(location.indexOf('&note='), location.indexOf('#'));
  assert.doesNotMatch(visibleText((await f.request('GET', `${BASE}?item=${ids.item}&version=12600000-0000-4000-8000-000000000099${query}`)).body), /Cancelled/u);
  void MhpCommerceError;
});
