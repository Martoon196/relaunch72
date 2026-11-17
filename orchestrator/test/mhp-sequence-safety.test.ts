import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { BASE, CAMPAIGN, client, createWorld, csrf, makeRun, page, person, prospect, runId, seq, serviceFor, visibleText, type World } from './helpers/mhp-sequence-safety-fixture.js';
import { identity, ids } from './helpers/mhp-owner-email-fixture.js';
import { legacyFollowupAudience, followupAudienceCanStart, FOLLOWUP_NO_AUDIENCE_RESUME, parseFollowupAudienceChoice, readStoredFollowupAudience, storedFollowupAudience, FOLLOWUP_NO_AUDIENCE_LINE } from '../src/followup-sequences/audience.js';
import { readNativeFlowForm } from '../src/followup-sequences/http.js';
import { createFollowupTools } from '../src/operator/followup-tools.js';
import { startDigest } from '../src/mhp/followup-sequence-service.js';
import { handleMhpOwnerEmail } from '../src/mhp/owner-email-router.js';
import { MhpCommerceError } from '../src/mhp/commerce-service.js';

const START = (world: World) => page(seq.item, seq.version, '&confirm=start');
const withPeople = (world: World, states: Record<number, 'active' | 'paused' | 'completed' | 'stopped'>) => {
  for (const [n, state] of Object.entries(states)) world.runs.push(makeRun(world, Number(n), state));
};

test('audience: a choice is explicit, a missing one is "none yet", malformed storage can never be started', () => {
  assert.equal(parseFollowupAudienceChoice(undefined), 'none_yet'); assert.equal(parseFollowupAudienceChoice(''), 'none_yet');
  assert.equal(parseFollowupAudienceChoice('webinar_signups'), 'webinar_signups'); assert.throws(() => parseFollowupAudienceChoice('book_readers'), /Choose who this sequence is for/u);
  assert.equal(readStoredFollowupAudience({}), null);
  assert.deepEqual(readStoredFollowupAudience({ mhpSequence: { audience: storedFollowupAudience('webinar_signups', CAMPAIGN) } }), { kind: 'webinar_signups', campaign: CAMPAIGN, origin: 'chosen' });
  for (const bad of [{ kind: 'webinar_signups' }, { schema: 'mhp.followup-sequence-audience/v1', kind: 'everyone', campaign: null }, { schema: 'mhp.followup-sequence-audience/v1', kind: 'webinar_signups', campaign: null }, 'webinar'])
    assert.deepEqual(readStoredFollowupAudience({ mhpSequence: { audience: bad } }), { kind: 'none_yet', campaign: null, origin: 'unreadable' });
  // No legacy inference: a version without a valid saved choice is "none yet", whatever people or rules it has.
  assert.deepEqual(legacyFollowupAudience(), { kind: 'none_yet', campaign: null, origin: 'legacy_none' });
  assert.equal(followupAudienceCanStart({ kind: 'webinar_signups', campaign: 'webinar-2026-10-01', origin: 'chosen' }, CAMPAIGN), false);
  assert.equal(followupAudienceCanStart({ kind: 'webinar_signups', campaign: CAMPAIGN, origin: 'legacy_none' }, CAMPAIGN), false);
  assert.equal(followupAudienceCanStart({ kind: 'webinar_signups', campaign: CAMPAIGN, origin: 'chosen' }, CAMPAIGN), true);
});

test('a "none yet" sequence shows no Start, only the plain line, and cannot be started even by a forged or server-issued POST', async () => {
  const world = createWorld(), c = client(world);
  const html = (await c.request('GET', page(seq.book, seq.bookVersion))).body;
  assert.match(visibleText(html), new RegExp(FOLLOWUP_NO_AUDIENCE_LINE.replace(/[.]/gu, '\\.'), 'u'));
  assert.doesNotMatch(html, /confirm=start|Start this sequence/u);
  const confirm = await c.request('GET', page(seq.book, seq.bookVersion, '&confirm=start'));
  assert.equal(confirm.status, 200); assert.match(confirm.body, /This sequence cannot be started/u); assert.doesNotMatch(confirm.body, /action="\/hq\/marketing\/sequences\/start"/u);
  // A forged form copying a real token's shape but not its signature.
  const forged = new URLSearchParams({ csrf: csrf(), commandId: ids.command, itemId: seq.book, versionId: seq.bookVersion, count: '16',
    digest: startDigest(seq.book, seq.bookVersion, world.candidates.map(x => x.prospectId)), people: '', issued: String(world.now), sig: 'f'.repeat(64), confirm: 'yes' });
  const refused = await c.post(`${BASE}/start`, forged); assert.equal(refused.status, 400); assert.match(refused.body, /Nothing was sent/u);
  // Straight at the service: refused at the server whatever the browser sent.
  const plan = await c.service.startPlan(identity, ids.request, seq.book, seq.bookVersion);
  assert.equal(plan.ready, false); assert.equal(plan.refusal?.code, 'no_audience'); assert.equal(plan.recipients.length, 0);
  await assert.rejects(c.service.start(identity, ids.request, { commandId: ids.command, itemId: seq.book, versionId: seq.bookVersion, count: 16,
    digest: forged.get('digest')!, people: '', confirmed: true }), { status: 409, message: FOLLOWUP_NO_AUDIENCE_LINE });
  // The old one-press Start and the old service command are both refused.
  assert.equal((await c.post(`${BASE}/enrol`, new URLSearchParams({ csrf: csrf(), commandId: ids.command, itemId: seq.book, versionId: seq.bookVersion, runId: '', ackProofId: '' }))).status, 409);
  await assert.rejects(c.service.command(identity, ids.request, { action: 'enrol', commandId: ids.command, itemId: seq.item, versionId: seq.version, runId: '', ackProofId: '' }), { status: 409 });
  // Automatic entry is refused too.
  await assert.rejects(c.service.entryCommand(identity, ids.request, { action: 'activate', commandId: ids.command, itemId: seq.book, versionId: seq.bookVersion, ruleId: '',
    expiresAt: new Date(world.now + 86_400_000).toISOString(), confirmed: true }, world.now), { status: 409, message: FOLLOWUP_NO_AUDIENCE_LINE });
  assert.deepEqual(world.calls.filter(call => call === 'enrol' || call.startsWith('entry')), []);
});

test('the confirmation names everyone, the timing and who is held back; ticking and pressing starts exactly them', async () => {
  const world = createWorld(), c = client(world);
  world.candidates[3] = { ...world.candidates[3]!, marketingConsent: false }; world.candidates[4] = { ...world.candidates[4]!, unsubscribed: true };
  withPeople(world, { 1: 'completed' });
  const confirm = await c.request('GET', START(world)); assert.equal(confirm.status, 200);
  const text = visibleText(confirm.body);
  assert.match(text, /You are about to email 13 people/u);
  assert.match(text, /people who registered for “Before You Buy live webinar” \(the webinar on Tuesday,? 3 November 2026\) and agreed to emails/u);
  assert.match(text, /First email: “Your replay is ready, \{\{FIRSTNAME\}\}”, sent straight away/u);
  assert.match(text, /2 days after the previous email \(about day 2\)/u);
  for (const n of [2, 3, 6, 16]) assert.match(confirm.body, new RegExp(person(n).email.replace(/[.]/gu, '\\.'), 'u'));
  for (const n of [1, 4, 5]) assert.doesNotMatch(confirm.body, new RegExp(person(n).email.replace(/[.]/gu, '\\.'), 'u'));
  assert.match(text, /1 person did not agree to emails/u); assert.match(text, /1 person unsubscribed/u); assert.match(text, /1 person is already in this sequence/u);
  assert.match(text, /Yes, send to these 13 people/u); assert.match(confirm.body, /<button>Start for 13 people<\/button>/u);
  assert.deepEqual(world.calls.filter(call => call === 'enrol'), []);
  // Not ticked: nothing starts, the same page comes back asking for the tick.
  const fields = c.formFields(confirm.body, `${BASE}/start`);
  const unticked = await c.post(`${BASE}/start`, fields); assert.equal(unticked.status, 400); assert.match(unticked.body, /Tick “Yes, send to these people”/u);
  fields.set('confirm', 'yes');
  const started = await c.post(`${BASE}/start`, fields); assert.equal(started.status, 303); assert.match(started.headers.location!, /#result$/u);
  const landed = visibleText((await c.follow(started)).body);
  assert.match(landed, /Started for 13 people\. Their first email is going now\./u); assert.match(landed, /13 started of 13 confirmed/u);
  assert.doesNotMatch(landed, /runs started|explicit batch/u);
  assert.equal(world.runs.filter(run => run.contentVersionId === seq.version && run.state === 'active').length, 13);
  assert.deepEqual(world.calls.filter(call => call === 'enrol'), ['enrol']);
  // Pressing the same confirmation again (double tap, back button) sends nothing new.
  const again = await c.post(`${BASE}/start`, fields); assert.equal(again.status, 303);
  assert.match(visibleText((await c.follow(again)).body), /had already been started for these 13 people\. Pressing the button again sent nothing new/u);
  assert.deepEqual(world.calls.filter(call => call === 'enrol'), ['enrol']);
});

test('the confirmation is bound to the exact people shown: a change starts nobody and explains the difference', async () => {
  const world = createWorld(), c = client(world);
  const confirm = await c.request('GET', START(world)); const fields = c.formFields(confirm.body, `${BASE}/start`); fields.set('confirm', 'yes');
  world.candidates.push(person(17)); world.candidates[1] = { ...world.candidates[1]!, unsubscribed: true };
  const changed = await c.post(`${BASE}/start`, fields); assert.equal(changed.status, 409);
  const text = visibleText(changed.body);
  assert.match(text, /The list changed, so nothing was sent/u); assert.match(text, /When you looked, this was 16 people\. It is now 16 people\./u);
  assert.match(text, new RegExp(`New since you looked: ${person(17).firstName} \\(${person(17).email.replace(/[.]/gu, '\\.')}\\)`, 'u'));
  assert.match(text, new RegExp(`No longer on the list: ${person(2).firstName} \\(${person(2).email.replace(/[.]/gu, '\\.')}\\)`, 'u'));
  assert.deepEqual(world.calls.filter(call => call === 'enrol'), []);
  // A forged count or digest with a valid-looking shape is refused before anything happens.
  const tampered = c.formFields(changed.body, `${BASE}/start`); tampered.set('confirm', 'yes'); tampered.set('count', '1');
  assert.equal((await c.post(`${BASE}/start`, tampered)).status, 400);
  // The re-shown confirmation is fresh and works.
  const fresh = c.formFields(changed.body, `${BASE}/start`); fresh.set('confirm', 'yes');
  assert.equal((await c.post(`${BASE}/start`, fresh)).status, 303); assert.deepEqual(world.calls.filter(call => call === 'enrol'), ['enrol']);
  assert.equal(world.runs.length, 16);
});

test('someone who signs up in the race window is paused straight away and the owner is told', async () => {
  const world = createWorld(), c = client(world);
  const fields = c.formFields((await c.request('GET', START(world))).body, `${BASE}/start`); fields.set('confirm', 'yes');
  world.beforeEnrol = () => { world.candidates.push(person(18)); };
  const landed = visibleText((await c.follow(await c.post(`${BASE}/start`, fields))).body);
  assert.match(landed, /Started for 16 people\. Their first email is going now\. 1 person not on your list was added to this sequence at the same moment \(a new sign-up, or the automatic sign-up rule\)\. They have been paused straight away/u);
  const extra = world.runs.find(run => run.email === person(18).email)!; assert.equal(extra.state, 'paused');
  assert.equal(world.runs.filter(run => run.state === 'active').length, 16);
});

test('a confirmation older than 30 minutes is shown again with the current list, starting nothing', async () => {
  const world = createWorld(), c = client(world);
  const fields = c.formFields((await c.request('GET', START(world))).body, `${BASE}/start`); fields.set('confirm', 'yes');
  world.now += 31 * 60_000;
  const reply = await c.post(`${BASE}/start`, fields); assert.equal(reply.status, 409); assert.match(reply.body, /more than 30 minutes old/u);
  assert.deepEqual(world.calls.filter(call => call === 'enrol'), []);
});

/** The production shape: a sequence saved before this release, started by the old one-press button with webinar people, all then paused, and new sign-ups since. */
function bookIncident() {
  const world = createWorld(), c = client(world);
  for (let n = 1; n <= 14; n++) world.runs.push(makeRun(world, n, 'paused', { id: runId(n), contentItemId: seq.other, contentVersionId: seq.otherVersion }));
  world.candidates.push(person(17), person(18));
  return { world, c };
}
test('M1: a pre-release sequence with paused webinar people is "none yet": no Start, no Resume, only Stop', async () => {
  const { world, c } = bookIncident();
  const html = (await c.request('GET', page(seq.other, seq.otherVersion))).body, text = visibleText(html);
  assert.match(text, /Who it is for: No one yet\. This sequence has no audience that can be started\. /u); assert.doesNotMatch(text, /started\.\./u);
  assert.match(text, /This sequence has no audience yet\. The 14 people in it are paused and will not be sent anything\. You can stop them, but not restart them here\./u);
  assert.match(text, /Stop everyone \(14\)/u);
  assert.doesNotMatch(html, /confirm=start|confirm=resume-all|Resume this person|Resume everyone|Start this sequence/u);
  // The editor never turns that into a webinar choice.
  assert.match(html, /name="audience" value="none_yet" checked/u); assert.doesNotMatch(html, /value="webinar_signups" checked/u);
  const plan = await c.service.startPlan(identity, ids.request, seq.other, seq.otherVersion);
  assert.equal(plan.audience.origin, 'legacy_none'); assert.equal(plan.refusal?.code, 'no_audience'); assert.equal(plan.recipients.length, 0);
  assert.equal((await c.service.resumePlan(identity, ids.request, seq.other, seq.otherVersion)).ready, false);
  const confirm = await c.request('GET', page(seq.other, seq.otherVersion, '&confirm=resume-all'));
  assert.doesNotMatch(confirm.body, /action="\/hq\/marketing\/sequences\/resume-all"/u); assert.match(visibleText(confirm.body), /nobody in it can be restarted here/u);
  assert.deepEqual(world.calls.filter(call => ['enrol', 'resume'].includes(call)), []);
});
test('M1: every route to start or resume the pre-release sequence is refused at the server, even forged', async () => {
  const { world, c } = bookIncident(), base = { commandId: ids.command, itemId: seq.other, versionId: seq.otherVersion };
  await assert.rejects(c.service.start(identity, ids.request, { ...base, count: 2, digest: startDigest(seq.other, seq.otherVersion, [prospect(17), prospect(18)]), people: '', confirmed: true }), { status: 409 });
  await assert.rejects(c.service.command(identity, ids.request, { ...base, action: 'resume', runId: runId(1), ackProofId: '' }), { status: 409, message: FOLLOWUP_NO_AUDIENCE_RESUME });
  await assert.rejects(c.service.command(identity, ids.request, { ...base, action: 'resume', runId: '', ackProofId: '' }), { status: 409, message: FOLLOWUP_NO_AUDIENCE_RESUME });
  await assert.rejects(c.service.resumeAll(identity, ids.request, { ...base, count: 14, digest: 'a'.repeat(64) }), { status: 409 });
  assert.equal((await c.service.personAction(identity, ids.request, { ...base, action: 'resume', runId: runId(1), ackProofId: '' })).code, 'no_audience');
  await assert.rejects(c.service.entryCommand(identity, ids.request, { action: 'activate', ...base, ruleId: '', expiresAt: new Date(world.now + 86_400_000).toISOString(), confirmed: true }, world.now), { status: 409 });
  // Through the browser routes: old per-person resume form, old everyone resume form, forged start, forged resume-all.
  const resumeOne = await c.post(`${BASE}/resume`, new URLSearchParams({ csrf: csrf(), ...base, runId: runId(1), ackProofId: '' }));
  assert.equal(resumeOne.status, 303);
  assert.match(visibleText((await c.follow(resumeOne)).body), /was not restarted: this sequence has no audience yet/u);
  assert.equal((await c.post(`${BASE}/resume`, new URLSearchParams({ csrf: csrf(), ...base, commandId: '5afe9000-0000-4000-8000-0000000000e1', runId: '', ackProofId: '' }))).status, 409);
  assert.equal((await c.post(`${BASE}/start`, new URLSearchParams({ csrf: csrf(), ...base, count: '2', digest: 'a'.repeat(64), people: '', issued: String(world.now), sig: 'f'.repeat(64), confirm: 'yes' }))).status, 400);
  assert.equal((await c.post(`${BASE}/resume-all`, new URLSearchParams({ csrf: csrf(), ...base, count: '14', digest: 'a'.repeat(64), issued: String(world.now), sig: 'f'.repeat(64), confirm: 'yes' }))).status, 400);
  assert.ok(world.runs.filter(run => run.contentItemId === seq.other).every(run => run.state === 'paused'));
  assert.deepEqual(world.calls.filter(call => ['enrol', 'resume'].includes(call)), []);
});
test('M1: "Stop everyone" has a short, final confirmation and stops only that sequence', async () => {
  const { world, c } = bookIncident(); world.runs.push(makeRun(world, 15, 'active'));
  const confirm = await c.request('GET', page(seq.other, seq.otherVersion, '&confirm=stop-all'));
  assert.match(visibleText(confirm.body), /Stop all 14 people in this sequence\? Stopping is final: nothing more from this sequence will ever be sent to them, and they cannot be restarted\./u);
  const done = await c.post(`${BASE}/stop-all`, c.formFields(confirm.body, `${BASE}/stop-all`)); assert.equal(done.status, 303);
  assert.match(visibleText((await c.follow(done)).body), /Stopped 14 people\. Nothing more from this sequence will ever be sent to them\./u);
  assert.ok(world.runs.filter(run => run.contentItemId === seq.other).every(run => run.state === 'stopped'));
  assert.equal(world.runs.find(run => run.id === runId(15))!.state, 'active');
});
test('M1: a none-yet sequence with people still active says so and offers pause and stop, never restart', async () => {
  const world = createWorld(), c = client(world);
  world.runs.push(makeRun(world, 1, 'active', { contentItemId: seq.other, contentVersionId: seq.otherVersion }), makeRun(world, 2, 'paused', { id: runId(2), contentItemId: seq.other, contentVersionId: seq.otherVersion }));
  const text = visibleText((await c.request('GET', page(seq.other, seq.otherVersion))).body);
  assert.match(text, /1 person in it is still active and will be sent its next emails unless you pause or stop them\./u);
  assert.match(text, /Pause everyone \(1\)/u); assert.match(text, /Stop everyone \(2\)/u); assert.doesNotMatch(text, /Resume/u);
});
test('S1: a start is never larger than the page can check (100), and the old "more afterwards" promise is gone', async () => {
  const world = createWorld(), c = client(world); world.candidates = Array.from({ length: 101 }, (_, i) => person(i + 1));
  const plan = await c.service.startPlan(identity, ids.request, seq.item, seq.version);
  assert.equal(plan.ready, false); assert.equal(plan.refusal?.message, 'This list is longer than this page can safely check (101 people). Nothing was started.');
  const body = visibleText((await c.request('GET', START(world))).body);
  assert.match(body, /This list is longer than this page can safely check \(101 people\)\. Nothing was started\./u); assert.doesNotMatch(body, /afterwards|second confirmation/u);
  world.candidates.pop(); assert.equal((await c.service.startPlan(identity, ids.request, seq.item, seq.version)).count, 100);
});
test('S1: when the start adds people the page cannot see, everyone active in the sequence is paused and the owner is told the truth', async () => {
  const world = createWorld(), c = client(world); world.candidates = Array.from({ length: 100 }, (_, i) => person(i + 1));
  const fields = c.formFields((await c.request('GET', START(world))).body, `${BASE}/start`); fields.set('confirm', 'yes');
  world.beforeEnrol = () => { world.candidates.push(person(150)); };
  const landed = visibleText((await c.follow(await c.post(`${BASE}/start`, fields))).body);
  assert.equal(world.runs.length, 101); assert.ok(world.runs.every(run => run.state === 'paused'), 'nobody can be left active unseen');
  assert.match(landed, /1 person not on your list was added to this sequence at the same moment \(a new sign-up, or the automatic sign-up rule\), and this page could not see exactly who\. To be safe, everyone active in this sequence has been paused \(101\)/u);
  assert.match(landed, /At least 0 active, 100 paused/u);
});
test('S1: counts say "at least" when the page cannot see everyone', async () => {
  const world = createWorld(), c = client(world);
  for (let n = 1; n <= 120; n++) world.runs.push(makeRun(world, n, 'paused', { id: runId(n), email: `p.${n}@example.invalid` }));
  const text = visibleText((await c.request('GET', page(seq.item, seq.version))).body);
  assert.match(text, /At least 0 active, 100 paused, 0 finished, 0 stopped/u); assert.match(text, /\(120 in total\), so these numbers are minimums/u);
  assert.doesNotMatch(text, /Resume everyone/u);
});
test('S2: a result note shows only on its own sequence, only while fresh, and never after a later action', async () => {
  const world = createWorld(), c = client(world); withPeople(world, { 1: 'active', 2: 'active' });
  const fields = c.formFields((await c.request('GET', START(world))).body, `${BASE}/start`); fields.set('confirm', 'yes');
  const started = await c.post(`${BASE}/start`, fields); const location = started.headers.location!, cookie = started.headers['set-cookie']!;
  assert.match(cookie, /^mhp_owner_note=[A-Za-z0-9_-]{12}; Path=\/hq\/marketing; HttpOnly; Secure; SameSite=Strict/u);
  const jar = (value: string) => ({ cookie: `__Host-mhp_session=${identity.sessionToken}; ${value.split(';')[0]}` });
  assert.match(visibleText((await c.request('GET', location, '', jar(cookie))).body), /Started for 14 people/u);
  // The same signed note on another sequence's address is not shown.
  const query = location.slice(location.indexOf('&note='), location.indexOf('#'));
  assert.doesNotMatch(visibleText((await c.request('GET', page(seq.book, seq.bookVersion, query), '', jar(cookie))).body), /Started for/u);
  // After a later action (pause everyone), going back or reloading the start result does not show it.
  const confirm = await c.request('GET', page(seq.item, seq.version, '&confirm=pause-all'));
  const paused = await c.post(`${BASE}/pause-all`, c.formFields(confirm.body, `${BASE}/pause-all`));
  assert.doesNotMatch(visibleText((await c.request('GET', location, '', jar(paused.headers['set-cookie']!))).body), /Started for/u);
  assert.match(visibleText((await c.request('GET', paused.headers.location!, '', jar(paused.headers['set-cookie']!))).body), /Paused 16 people/u);
  // Older than a few minutes: not shown.
  world.now += 6 * 60_000;
  assert.doesNotMatch(visibleText((await c.request('GET', paused.headers.location!, '', jar(paused.headers['set-cookie']!))).body), /Paused 16 people/u);
});
test('S3: people on hold because of a newer version are not offered a resume, not counted, and told why in neutral styling', async () => {
  const world = createWorld(), c = client(world); withPeople(world, { 1: 'paused', 2: 'paused' });
  world.runs[0]!.state = 'held'; world.runs[0]!.reason = 'newer_sequence';
  const html = (await c.request('GET', page(seq.item, seq.version))).body;
  const card = html.match(new RegExp(`<li class="person" id="run-${runId(1)}"[\\s\\S]*?</li>`, 'u'))![0];
  assert.doesNotMatch(card, /Resume this person/u); assert.match(visibleText(card), /They cannot be resumed in this version\./u);
  assert.match(visibleText(html), /Resume everyone \(1\)/u);
  const plan = await c.service.resumePlan(identity, ids.request, seq.item, seq.version); assert.deepEqual(plan.people.map(run => run.id), [runId(2)]);
  const reply = await c.post(`${BASE}/resume`, new URLSearchParams({ csrf: csrf(), commandId: '5afe9000-0000-4000-8000-0000000000e2', itemId: seq.item, versionId: seq.version, runId: runId(1), ackProofId: '' }));
  const after = (await c.follow(reply)).body;
  assert.match(after, /<p class="notice" role="status">Alice was not restarted: they are on hold because you saved a newer version/u);
  assert.deepEqual(world.calls.filter(call => call === 'resume'), []);
});
test('notes: names list has no inner scroll box, not-found goes to the list, plain words, no double full stops, start button after a start', async () => {
  const world = createWorld(), c = client(world);
  const confirm = (await c.request('GET', START(world))).body;
  assert.doesNotMatch(confirm, /max-height:420px|overflow-y:auto/u); assert.doesNotMatch(confirm, /Showing all/u);
  world.candidates = Array.from({ length: 40 }, (_, i) => person(i + 1));
  assert.match(visibleText((await c.request('GET', START(world))).body), /Showing all 40, in the order they will be started\./u);
  const missing = await c.request('GET', page(seq.item, '5afe0000-0000-4000-8000-0000000000ff'));
  assert.equal(missing.status, 404); assert.match(missing.body, /href="\/hq\/marketing\/sequences">Back to follow-up sequences/u); assert.doesNotMatch(missing.body, /Back to the sequence/u);
  for (const path of [page(seq.item, seq.version), page(seq.book, seq.bookVersion), `${BASE}?new=1`, START(world)]) {
    const text = visibleText((await c.request('GET', path)).body);
    assert.doesNotMatch(text, /\.\.(?!\.)|native flow|local library|exact versions/u, path);
  }
  const fields = c.formFields((await c.request('GET', START(world))).body, `${BASE}/start`); fields.set('confirm', 'yes');
  const landed = (await c.follow(await c.post(`${BASE}/start`, fields))).body;
  assert.doesNotMatch(landed, /Start this sequence…/u); assert.match(landed, /class="button secondary"[^>]*>Check for anyone new…/u);
  const unreadable = await c.request('POST', `${BASE}/pause`, 'x=1', { 'content-type': 'text/plain' });
  assert.doesNotMatch(unreadable.body, /native/u); assert.match(unreadable.body, /This form could not be read/u);
});
test('notes: two tabs pressing the same start: the second says the truth', async () => {
  const world = createWorld(), c = client(world);
  const first = c.formFields((await c.request('GET', START(world))).body, `${BASE}/start`); first.set('confirm', 'yes');
  const second = c.formFields((await c.request('GET', START(world))).body, `${BASE}/start`); second.set('confirm', 'yes');
  // Tab one's enrol commits between tab two's recount and tab two's database call.
  const repository = (c.service as unknown as { dependencies: { repository: { command: (...args: any[]) => Promise<any> } } }).dependencies.repository;
  const original = repository.command; let raced = false;
  repository.command = async (...args: any[]) => {
    if (!raced && args[1].action === 'enrol' && args[1].commandId === second.get('commandId')) { raced = true; await original(args[0], { ...args[1], commandId: first.get('commandId') }); }
    return original(...args);
  };
  const landed = visibleText((await c.follow(await c.post(`${BASE}/start`, second))).body);
  assert.match(landed, /These people had already been started from another tab\. Nothing new was sent\./u); assert.doesNotMatch(landed, /Started for 0/u); assert.doesNotMatch(landed, /unsubscribed/u);
  assert.equal(world.runs.length, 16);
});
test('the page refuses to start when it cannot see everyone already in a sequence', async () => {
  const world = createWorld(), c = client(world);
  for (let n = 1; n <= 101; n++) world.runs.push(makeRun(world, n, 'completed', { id: runId(n), contentItemId: seq.other, contentVersionId: seq.otherVersion, email: `old.${n}@example.invalid` }));
  const plan = await c.service.startPlan(identity, ids.request, seq.item, seq.version);
  assert.equal(plan.refusal?.code, 'too_many'); assert.equal(plan.recipients.length, 0);
});

test('pause everyone: a short confirmation, one press, loops past the database batch limit and touches only that sequence', async () => {
  const world = createWorld(), c = client(world); world.batchLimit = 2;
  withPeople(world, { 1: 'active', 2: 'active', 3: 'active', 4: 'active', 5: 'active', 6: 'completed' });
  world.runs.push(makeRun(world, 7, 'active', { id: runId(7), contentItemId: seq.other, contentVersionId: seq.otherVersion }));
  const sequencePage = (await c.request('GET', page(seq.item, seq.version))).body;
  assert.match(visibleText(sequencePage), /5 active, 0 paused, 1 finished, 0 stopped/u); assert.match(sequencePage, /Pause everyone \(5\)/u);
  const confirm = await c.request('GET', page(seq.item, seq.version, '&confirm=pause-all'));
  assert.match(visibleText(confirm.body), /Pause all 5 people in this sequence\? Nothing more is sent until you resume them\./u);
  const done = await c.post(`${BASE}/pause-all`, c.formFields(confirm.body, `${BASE}/pause-all`)); assert.equal(done.status, 303);
  assert.match(visibleText((await c.follow(done)).body), /Paused 5 people\. Nothing more is sent until you resume them\./u);
  assert.equal(world.runs.filter(run => run.contentItemId === seq.item && run.state === 'paused').length, 5);
  assert.equal(world.runs.find(run => run.id === runId(7))!.state, 'active');
  const pauses = world.commands.filter(command => command.action === 'pause');
  assert.equal(pauses.length, 3); assert.equal(new Set(pauses.map(command => command.commandId)).size, 3); assert.ok(pauses.every(command => command.runId === ''));
});

test('resume everyone shows who is resumed and is bound to that list', async () => {
  const world = createWorld(), c = client(world); withPeople(world, { 1: 'paused', 2: 'paused', 3: 'active' });
  const confirm = await c.request('GET', page(seq.item, seq.version, '&confirm=resume-all'));
  const text = visibleText(confirm.body); assert.match(text, /Resume 2 people\?/u); assert.match(confirm.body, new RegExp(person(1).email.replace(/[.]/gu, '\\.'), 'u'));
  const fields = c.formFields(confirm.body, `${BASE}/resume-all`); fields.set('confirm', 'yes');
  world.runs.push(makeRun(world, 4, 'paused'));
  const changed = await c.post(`${BASE}/resume-all`, fields); assert.equal(changed.status, 409); assert.match(visibleText(changed.body), /The list changed, so nobody was resumed/u);
  assert.equal(world.calls.filter(call => call === 'resume').length, 0);
  const fresh = c.formFields(changed.body, `${BASE}/resume-all`); fresh.set('confirm', 'yes');
  assert.match(visibleText((await c.follow(await c.post(`${BASE}/resume-all`, fresh))).body), /Resumed 3 people/u);
});

test('pausing one person lands back on their card with the new badge, the next button and a note on the card', async () => {
  const world = createWorld(), c = client(world); withPeople(world, { 1: 'active', 2: 'active' });
  const html = (await c.request('GET', page(seq.item, seq.version))).body;
  const reply = await c.post(`${BASE}/pause`, c.formFields(html, `${BASE}/pause`, 0));
  assert.equal(reply.status, 303); assert.match(reply.headers.location!, new RegExp(`#run-${runId(1)}$`, 'u'));
  const after = (await c.follow(reply)).body;
  const card = after.match(new RegExp(`<li class="person" id="run-${runId(1)}"[\\s\\S]*?</li>\\s*(?=<li class="person"|</ul>)`, 'u'))![0];
  assert.match(card, /<span class="badge badge-paused">Paused<\/span>/u); assert.match(card, /Resume this person/u); assert.doesNotMatch(card, /Pause this person/u);
  assert.match(visibleText(card), /Paused\. Nothing more is sent to Alice until you resume them\./u);
  // The other card is untouched; the summary updates.
  assert.match(visibleText(after), /1 active, 1 paused, 0 finished, 0 stopped/u);
});

test('every form on the page has its own command id, so a second action from the same page is not refused', async () => {
  const world = createWorld(), c = client(world); withPeople(world, { 1: 'active', 2: 'active', 3: 'paused' });
  const html = (await c.request('GET', page(seq.item, seq.version))).body;
  const commandIds = [...html.matchAll(/<input type="hidden" name="commandId" value="([^"]+)">/gu)].map(m => m[1]);
  assert.ok(commandIds.length >= 8); assert.equal(new Set(commandIds).size, commandIds.length);
  const first = await c.post(`${BASE}/pause`, c.formFields(html, `${BASE}/pause`, 0));
  const second = await c.post(`${BASE}/pause`, c.formFields(html, `${BASE}/pause`, 1));
  assert.equal(first.status, 303); assert.equal(second.status, 303);
  assert.equal(world.runs.filter(run => run.state === 'paused').length, 3);
});

test('a stale action lands on the current state with a plain note, never an error', async () => {
  const world = createWorld(), c = client(world); withPeople(world, { 1: 'active' });
  const stale = (await c.request('GET', page(seq.item, seq.version))).body;
  world.runs[0]!.state = 'paused';
  const reply = await c.post(`${BASE}/pause`, c.formFields(stale, `${BASE}/pause`, 0)); assert.equal(reply.status, 303);
  assert.match(visibleText((await c.follow(reply)).body), /Alice was already paused\. Nothing was changed\./u);
  // Stopped elsewhere, then a stale Resume.
  world.runs[0]!.state = 'stopped';
  const resumeForm = new URLSearchParams({ csrf: csrf(), commandId: '5afe9000-0000-4000-8000-000000000001', itemId: seq.item, versionId: seq.version, runId: runId(1), ackProofId: '' });
  assert.match(visibleText((await c.follow(await c.post(`${BASE}/resume`, resumeForm))).body), /Alice had already changed before your press, so nothing was done\. They are stopped now\./u);
  // The database reporting a change under the action.
  world.runs[0]!.state = 'active'; world.failNext = { status: 409 };
  const raced = await c.post(`${BASE}/pause`, new URLSearchParams({ csrf: csrf(), commandId: '5afe9000-0000-4000-8000-000000000002', itemId: seq.item, versionId: seq.version, runId: runId(1), ackProofId: '' }));
  assert.equal(raced.status, 303); assert.match(visibleText((await c.follow(raced)).body), /Alice had already changed before your press/u);
  // A reused button (back button after a resume) is explained, not silently claimed as done.
  world.runs[0]!.state = 'active';
  const html = (await c.request('GET', page(seq.item, seq.version))).body; const pause = c.formFields(html, `${BASE}/pause`, 0);
  await c.post(`${BASE}/pause`, pause); world.runs[0]!.state = 'active';
  assert.match(visibleText((await c.follow(await c.post(`${BASE}/pause`, pause))).body), /That button had already been used earlier\. Alice is active now/u);
});

test('every error from this area renders in the frame with the header and a way back', async () => {
  const world = createWorld(), c = client(world);
  const framed = (reply: { body: string; headers: Record<string, string> }) => {
    assert.match(reply.headers['content-type']!, /text\/html/u); assert.match(reply.body, /<nav aria-label="Owner navigation">/u); assert.match(reply.body, /Follow-up sequences<\/a>/u);
  };
  world.workspaceSelected = false;
  const workspace = await c.request('GET', page(seq.item, seq.version)); assert.equal(workspace.status, 403); framed(workspace);
  assert.match(workspace.body, /Open your marketing workspace/u); assert.match(workspace.body, /action="\/hq\/marketing\/sequences\/open-workspace"/u);
  assert.match(workspace.body, /Back to the sequence/u);
  const opened = await c.post(`${BASE}/open-workspace`, c.formFields(workspace.body, `${BASE}/open-workspace`));
  assert.equal(opened.status, 303); assert.equal(opened.headers.location, page(seq.item, seq.version)); assert.match(opened.headers['set-cookie']!, /__Host-mhp_session=/u);
  assert.equal(world.selected, 1); assert.equal(world.workspaceSelected, true);
  const offsite = new URLSearchParams({ csrf: csrf(), commandId: ids.command, back: 'https://foreign.invalid/' });
  assert.equal((await c.post(`${BASE}/open-workspace`, offsite)).status, 400);
  world.failNext = { status: 409 }; withPeople(world, { 1: 'active' });
  const html = (await c.request('GET', page(seq.item, seq.version))).body;
  const confirm = await c.request('GET', page(seq.item, seq.version, '&confirm=pause-all'));
  const changed = await c.post(`${BASE}/pause-all`, c.formFields(confirm.body, `${BASE}/pause-all`));
  assert.equal(changed.status, 409); framed(changed); assert.match(changed.body, /changed while you were looking at it, so nothing was done/u); assert.match(changed.body, /Back to the sequence/u);
  world.failNext = { status: 503 };
  const retry = c.formFields(confirm.body, `${BASE}/pause-all`); retry.set('commandId', '5afe9000-0000-4000-8000-000000000003');
  const down = await c.post(`${BASE}/pause-all`, retry);
  assert.equal(down.status, 503); framed(down); assert.match(down.body, /Sequence controls are temporarily unavailable\. Nothing was changed/u);
  for (const bad of [`${BASE}?item=${seq.item}`, `${BASE}?confirm=start`, `${BASE}?foo=1`]) { const reply = await c.request('GET', bad); assert.equal(reply.status, 400); framed(reply); assert.match(reply.body, /Back to follow-up sequences/u); }
  const forged = await c.request('POST', `${BASE}/pause`, `csrf=wrong&commandId=${ids.command}&itemId=${seq.item}&versionId=${seq.version}&runId=${runId(1)}&ackProofId=`);
  assert.equal(forged.status, 403); framed(forged); assert.match(forged.body, /This page was out of date/u); assert.match(forged.body, /Back to the sequence/u);
  assert.ok(html.length > 0);
});

test('owner email errors also render in the frame with a way back', async () => {
  const res = { status: 0, headers: {} as Record<string, string>, body: '' };
  const req = Object.assign(Readable.from([]), { method: 'GET', url: '/hq/marketing/emails', headers: { host: 'app.martinhowardproperty.co.uk', cookie: `__Host-mhp_session=${identity.sessionToken}` } }) as unknown as IncomingMessage;
  const world = createWorld();
  const portal = { kind: 'postgres', secure: true, sessionSecret: 'x'.repeat(40), sessionCookieName: '__Host-mhp_session', now: () => world.now,
    auth: { resolve: async () => identity }, abuseHashSecret: 'y'.repeat(40), requestContext: () => ({ requestId: ids.request, requestHash: Buffer.alloc(32, 1), sourceHash: Buffer.alloc(32, 2) }),
    abuse: { admit: async () => ({ allowed: true, leaseHash: Buffer.alloc(32, 1), retryAfterSeconds: 0 }), complete: async () => {} } };
  await handleMhpOwnerEmail(req, { writeHead(status: number, head: Record<string, string>) { res.status = status; Object.assign(res.headers, head); }, end(text: string) { res.body = text; } } as never,
    new URL('https://app.martinhowardproperty.co.uk/hq/marketing/emails'), { portal: portal as never, emails: { snapshot: async () => { throw new MhpCommerceError(403, 'Open the MHP marketing workspace first.'); } } as never });
  assert.equal(res.status, 403); assert.match(res.headers['content-type']!, /text\/html/u); assert.match(res.body, /<nav aria-label="Owner navigation">/u);
  assert.match(res.body, /Open marketing workspace/u); assert.match(res.body, /Back to the email library/u);
});

test('owner text on the sequence screens says people, emails and sent — never runs, batches, content versions or providers', async () => {
  const world = createWorld(), c = client(world); withPeople(world, { 1: 'active', 2: 'paused', 3: 'completed', 4: 'stopped' });
  world.runs[0]!.inFlight = true; world.runs[1]!.reason = 'outcome_unknown'; world.runs[1]!.unknownProofId = ids.proof;
  const pages = [page(seq.item, seq.version), page(seq.book, seq.bookVersion), START(world), page(seq.item, seq.version, '&confirm=pause-all'), page(seq.item, seq.version, '&confirm=resume-all'), BASE];
  for (const path of pages) {
    const text = visibleText((await c.request('GET', path)).body);
    assert.doesNotMatch(text, /\bruns?\b|explicit batch|content version|\bprovider\b|\benrol/iu, path);
  }
});

test('the owner draft tool: a sequence saved without an audience is "none yet", whatever its entry says', async () => {
  for (const entry of ['manual', 'webinar_signup'] as const) {
    const world = createWorld(), service = serviceFor(world);
    const tools = createFollowupTools({ sessions: { identity: async () => identity }, sequences: service, links: { ppOrigin: null, mhpOrigin: 'https://app.martinhowardproperty.co.uk' } });
    const save = tools.find(tool => tool.name === 'followup_sequence_save_draft')!;
    const result = await save.run({ brand: 'mhp', sequence: { title: `Book chapter (${entry})`, entry,
      steps: [{ saved: { channel: 'email', contentItemId: ids.item, contentVersionId: ids.version, contentSha256: '0'.repeat(64) } }] } }) as { note: string };
    assert.match(result.note, /Draft only/u); assert.deepEqual(world.calls, ['save']);
    const stored = world.savedMetadata.at(-1) as { mhpSequence: { audience: unknown } };
    assert.deepEqual(stored.mhpSequence.audience, { schema: 'mhp.followup-sequence-audience/v1', kind: 'none_yet', campaign: null }, entry);
  }
  // An explicit choice from the editor is kept.
  const world = createWorld(), service = serviceFor(world);
  await service.save(identity, ids.request, { commandId: '5afe9000-0000-4000-8000-00000000000c', contentItemId: '', previousVersionId: '', audience: 'webinar_signups',
    definition: { schema: 'growthhq.followup-sequence/v2', brand: 'mhp', campaign: CAMPAIGN, title: 'Webinar', expiryHours: 24, entry: { mode: 'manual', source: 'manual_owner' },
      stopOn: { reply: false, booked: false, purchased: false }, steps: [{ key: 'first', kind: 'email', contentItemId: ids.item, contentVersionId: ids.version, contentSha256: '0'.repeat(64) }] } }, world.now);
  assert.deepEqual((world.savedMetadata.at(-1) as { mhpSequence: { audience: unknown } }).mhpSequence.audience, { schema: 'mhp.followup-sequence-audience/v1', kind: 'webinar_signups', campaign: CAMPAIGN });
  await assert.rejects(service.save(identity, ids.request, { commandId: '5afe9000-0000-4000-8000-00000000000d', contentItemId: '', previousVersionId: '', audience: 'everyone', definition: {} }, world.now), { status: 400 });
});

test('the editor asks "Who is this for?" with "No one yet" chosen by default, and posts it with the form', async () => {
  const world = createWorld(), c = client(world);
  const html = (await c.request('GET', `${BASE}?new=1`)).body;
  assert.match(html, /<legend>Who is this for\?<\/legend>/u); assert.match(html, /name="audience" value="none_yet" checked/u); assert.doesNotMatch(html, /value="webinar_signups" checked/u);
  const existing = (await c.request('GET', page(seq.item, seq.version))).body; assert.match(existing, /name="audience" value="webinar_signups" checked/u);
});

test('switching on automatic sign-ups says who and until when, and needs the tick', async () => {
  const world = createWorld(), c = client(world); world.sequences.get(seq.version)!.entry = 'webinar_signup';
  const html = (await c.request('GET', page(seq.item, seq.version))).body;
  assert.match(html, /name="confirm" value="entry"/u);
  const confirm = await c.request('GET', page(seq.item, seq.version, '&confirm=entry&until=2026-11-20T18:00'));
  const text = visibleText(confirm.body);
  assert.match(text, /every new person who registers for “Before You Buy live webinar” \(the webinar on Tuesday,? 3 November 2026\) and agrees to emails will be added to this sequence automatically/u);
  assert.match(text, /Nobody who registered before now is added/u); assert.match(text, /Yes, add new sign-ups automatically until/u);
  const fields = c.formFields(confirm.body, `${BASE}/entry-activate`);
  assert.equal((await c.post(`${BASE}/entry-activate`, fields)).status, 400); assert.deepEqual(world.calls.filter(call => call.startsWith('entry')), []);
  fields.set('confirm', 'yes'); const on = await c.post(`${BASE}/entry-activate`, fields); assert.equal(on.status, 303);
  assert.deepEqual(world.calls.filter(call => call.startsWith('entry')), ['entry:activate']);
});

test('a crafted result link cannot show a false note', async () => {
  const world = createWorld(), c = client(world); withPeople(world, { 1: 'active' });
  const note = Buffer.from(JSON.stringify({ c: 'b', a: 'pause', n: 14, m: 0, k: 0, f: 0, r: 0 })).toString('base64url');
  const html = visibleText((await c.request('GET', page(seq.item, seq.version, `&note=${note}&sig=${'0'.repeat(32)}`))).body);
  assert.doesNotMatch(html, /Paused 14 people/u);
});

test('the form reader accepts named optional fields only, once each', async () => {
  const read = (body: string, optional: string[] = []) => readNativeFlowForm(Object.assign(Readable.from([Buffer.from(body)]), { headers: { 'content-type': 'application/x-www-form-urlencoded' } }) as unknown as IncomingMessage, ['a'], false, optional);
  assert.equal((await read('a=1&confirm=yes', ['confirm'])).get('confirm'), 'yes');
  assert.equal((await read('a=1', ['confirm'])).has('confirm'), false);
  await assert.rejects(read('a=1&confirm=yes'), { status: 400 }); await assert.rejects(read('a=1&confirm=yes&confirm=yes', ['confirm']), { status: 400 });
  await assert.rejects(read('a=1&other=1', ['confirm']), { status: 400 });
});
