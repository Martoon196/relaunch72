import assert from 'node:assert/strict';
import test from 'node:test';
import { BASE, client, createWorld, csrf, makeRun, page, seq, visibleText, bookPerson, repositoryFor, type World } from './helpers/mhp-sequence-safety-fixture.js';
import { identity, ids } from './helpers/mhp-owner-email-fixture.js';
import { BOOK_READERS_DATABASE_STEP, readStoredFollowupAudience, storedFollowupAudience, followupAudienceCanStart } from '../src/followup-sequences/audience.js';
import { startDigest } from '../src/mhp/followup-sequence-service.js';
import { dispatchMhpSequenceEmails, type MhpSequenceDispatch } from '../src/mhp/followup-sequence-dispatch.js';

// Release B: the Before You Buy book readers audience, over the real service and router with the synthetic world.
const BOOK = page(seq.book, seq.bookVersion);
function bookWorld(db160 = true): World {
  const world = createWorld(); world.db160 = db160;
  world.sequences.get(seq.bookVersion)!.audience = 'book_readers';
  return world;
}
const forBook = (world: World, n: number, state: 'active' | 'paused' | 'stopped' | 'completed') => {
  const p = bookPerson(n); world.runs.push(makeRun(world, 90 + n, state, { id: `5afe2000-0000-4000-8000-0000000009${String(n).padStart(2, '0')}`, contentItemId: seq.book, contentVersionId: seq.bookVersion, email: p.email, firstName: p.firstName }));
};

test('book readers is an explicit, saved audience; it is never inferred', () => {
  const stored = storedFollowupAudience('book_readers', 'webinar-2026-11-03');
  assert.deepEqual(stored, { schema: 'mhp.followup-sequence-audience/v1', kind: 'book_readers', campaign: null });
  const read = readStoredFollowupAudience({ mhpSequence: { audience: stored } })!;
  assert.equal(read.origin, 'chosen'); assert.equal(followupAudienceCanStart(read, 'webinar-2026-11-03'), true);
  assert.equal(followupAudienceCanStart({ kind: 'book_readers', campaign: null, origin: 'legacy_none' }, 'webinar-2026-11-03'), false);
  // A book audience carrying a campaign is not the saved shape: it reads as "none yet".
  assert.equal(readStoredFollowupAudience({ mhpSequence: { audience: { ...stored, campaign: 'webinar-2026-11-03' } } })!.kind, 'none_yet');
});

test('the editor offers "Book readers" as a third plain choice, preselected only when it was chosen', async () => {
  const c = client(bookWorld());
  const html = (await c.request('GET', BOOK)).body;
  assert.match(html, /name="audience" value="book_readers" checked> Book readers: people who asked for the Before You Buy first chapter and ticked the email box/u);
  const fresh = (await c.request('GET', `${BASE}?new=1`)).body;
  assert.match(fresh, /value="book_readers" >|value="book_readers"  >|value="book_readers" > Book readers/u); assert.match(fresh, /value="none_yet" checked/u);
  // The legacy sequence (no saved audience) is never shown as book readers.
  assert.match((await c.request('GET', page(seq.other, seq.otherVersion))).body, /value="none_yet" checked/u);
});

test('on a database still at 0159: the book choice is visible, start and the switch say "ready after one database step"', async () => {
  const world = bookWorld(false), c = client(world);
  const text = visibleText((await c.request('GET', BOOK)).body);
  assert.match(text, /Who it is for: People who asked for the Before You Buy first chapter and agreed to emails\./u);
  assert.match(text, new RegExp(BOOK_READERS_DATABASE_STEP.replace(/[.]/gu, '\\.'), 'u')); assert.doesNotMatch(text, /Start this sequence…/u);
  const confirm = await c.request('GET', `${BOOK}&confirm=start`);
  assert.equal(confirm.status, 200); assert.match(visibleText(confirm.body), /This sequence cannot be started.*This will be ready after one database step/su);
  assert.doesNotMatch(confirm.body, /action="\/hq\/marketing\/sequences\/start"/u);
  const sw = await c.request('GET', `${BOOK}&confirm=book-entry`);
  assert.match(visibleText(sw.body), /This will be ready after one database step/u); assert.doesNotMatch(sw.body, /book-entry-on/u);
  // Forged POSTs change nothing.
  const forged = new URLSearchParams({ csrf: csrf(), commandId: ids.command, itemId: seq.book, versionId: seq.bookVersion, confirm: 'yes' });
  const on = await c.post(`${BASE}/book-entry-on`, forged); assert.equal(on.status, 409); assert.match(on.body, /ready after one database step/u);
  await assert.rejects(c.service.start(identity, ids.request, { commandId: ids.command, itemId: seq.book, versionId: seq.bookVersion, count: 1,
    digest: startDigest(seq.book, seq.bookVersion, [bookPerson(1).prospectId]), people: '', confirmed: true }), { status: 409 });
  assert.deepEqual(world.calls.filter(call => ['enrol', 'startV2', 'book:on'].includes(call)), []);
  // Webinar sequences keep the safety release's path on 0159.
  assert.equal((await c.service.startPlan(identity, ids.request, seq.item, seq.version)).explicit, undefined);
});

test('the named start lists only book readers, says who is held back and why, and passes exactly them to the database', async () => {
  const world = bookWorld(), c = client(world); forBook(world, 2, 'stopped');
  const confirm = await c.request('GET', `${BOOK}&confirm=start`); const text = visibleText(confirm.body);
  assert.match(text, /You are about to email 1 person/u);
  assert.match(text, /Who: people who asked for the Before You Buy first chapter and agreed to emails\./u);
  assert.match(confirm.body, /reader\.1@example\.invalid/u);
  for (const email of ['reader.2@', 'reader.3@', 'reader.4@', 'reader.5@', 'reader.6@', 'alice.1@', 'ben.2@']) assert.doesNotMatch(confirm.body.match(/aria-label="People who will receive it">[\s\S]*?<\/ul>/u)![0], new RegExp(email.replace('.', '\\.'), 'u'));
  assert.match(text, /1 person did not agree to emails/u); assert.match(text, /1 person unsubscribed/u); assert.match(text, /1 person’s email address bounced or is blocked/u);
  assert.match(text, /1 person has already bought from you/u); assert.match(text, /1 person is already in this sequence/u);
  assert.match(text, /Reader 2 · reader\.2@example\.invalid · already in this sequence \(stopped\)/u);
  const fields = c.formFields(confirm.body, `${BASE}/start`); fields.set('confirm', 'yes');
  const done = await c.follow(await c.post(`${BASE}/start`, fields));
  assert.match(visibleText(done.body), /Started for 1 person\. Their first email is going now\./u);
  assert.deepEqual(world.commands.filter(x => x.action === 'startV2').map(x => x.runId), [bookPerson(1).prospectId]);
  assert.deepEqual(world.calls.filter(call => call === 'enrol'), [], 'the old one-press enrol is never used');
});

test('someone who becomes ineligible between the page and the press: the database refuses and nobody is started', async () => {
  const world = bookWorld(), c = client(world);
  const fields = c.formFields((await c.request('GET', `${BOOK}&confirm=start`)).body, `${BASE}/start`); fields.set('confirm', 'yes');
  world.book[0]!.reason = 'unsubscribed';
  const reply = await c.post(`${BASE}/start`, fields); assert.equal(reply.status, 409); assert.match(visibleText(reply.body), /The list changed, so nothing was sent/u);
  assert.equal(world.runs.length, 0);
  // A page digest that names someone who is no longer eligible: the app's recount says "changed".
  world.book[0]!.reason = null; world.book[1]!.reason = 'purchased';
  const stale = await c.service.start(identity, ids.request, { commandId: '5afe9000-0000-4000-8000-0000000000f1', itemId: seq.book, versionId: seq.bookVersion, count: 2,
    digest: startDigest(seq.book, seq.bookVersion, [bookPerson(1).prospectId, bookPerson(2).prospectId].sort()), people: '', confirmed: true });
  assert.equal(stale.kind, 'changed'); assert.equal(world.runs.length, 0);
  // And the database's own check (emulated after mhp_sequence_start_v2) refuses a list naming an ineligible person outright.
  await assert.rejects(repositoryFor(world).startV2!(identity, { commandId: '5afe9000-0000-4000-8000-0000000000f2', versionId: seq.bookVersion,
    campaign: 'webinar-2026-11-03', recipients: [bookPerson(1).prospectId, bookPerson(2).prospectId], requestId: ids.request }), { status: 409 });
  assert.equal(world.runs.length, 0);
});

test('switching on automatic sending: plain page, tick required, then a card with counts and a way to switch off', async () => {
  const world = bookWorld(), c = client(world);
  const html = (await c.request('GET', BOOK)).body;
  assert.match(html, /Send this to each new book sign-up automatically…/u);
  const confirm = await c.request('GET', `${BOOK}&confirm=book-entry`); const text = visibleText(confirm.body);
  assert.match(text, /Send this to each new book sign-up automatically\?/u);
  assert.match(text, /From the moment you confirm, everyone who asks for the Before You Buy first chapter and ticks the email box will be added to this sequence and sent “Your replay is ready, \{\{FIRSTNAME\}\}” within a few minutes of signing up , then 1 more email on schedule\./u);
  assert.match(text, /People who signed up before now are not added by this\./u);
  assert.match(text, /Nobody who has ever been in this sequence is added again, and nobody who unsubscribed, whose email bounced, or who has bought from you\./u);
  const fields = c.formFields(confirm.body, `${BASE}/book-entry-on`);
  assert.equal((await c.post(`${BASE}/book-entry-on`, fields)).status, 400, 'no tick, no switch'); assert.equal(world.switches.length, 0);
  fields.set('confirm', 'yes');
  const on = await c.follow(await c.post(`${BASE}/book-entry-on`, fields));
  assert.match(visibleText(on.body), /Switched on\. From now on, each new book sign-up who agrees to emails gets this sequence/u);
  assert.match(visibleText(on.body), /On since .*\(UK time\)\. 0 people added automatically · 0 not added/u);
  const off = await c.follow(await c.post(`${BASE}/book-entry-off`, c.formFields(on.body, `${BASE}/book-entry-off`)));
  assert.match(visibleText(off.body), /Switched off\. New book sign-ups are no longer added\./u); assert.equal(world.switches[0]!.state, 'off');
  // A webinar sequence cannot be switched on for book sign-ups; a book sequence cannot use the webinar rule.
  const webinarOn = new URLSearchParams({ csrf: csrf(), commandId: ids.command, itemId: seq.item, versionId: seq.version, confirm: 'yes' });
  assert.equal((await c.post(`${BASE}/book-entry-on`, webinarOn)).status, 409);
  await assert.rejects(c.service.entryCommand(identity, ids.request, { action: 'activate', commandId: ids.command, itemId: seq.book, versionId: seq.bookVersion, ruleId: '',
    expiresAt: new Date(world.now + 86_400_000).toISOString(), confirmed: true }, world.now), { status: 409 });
});

test('the legacy sequence with paused people shows the owner the way to book readers, without losing the emails', async () => {
  const world = bookWorld(); for (let n = 1; n <= 3; n++) world.runs.push(makeRun(world, n, 'paused', { id: `5afe2000-0000-4000-8000-0000000008${n}0`, contentItemId: seq.other, contentVersionId: seq.otherVersion }));
  const text = visibleText((await client(world).request('GET', page(seq.other, seq.otherVersion))).body);
  assert.match(text, /To send this to book readers: in “Edit your sequence” below, choose “Book readers” under “Who is this for\?”, press Save draft, then Publish this version, then switch on “Send this to each new book sign-up automatically”\. Your emails stay exactly as they are\./u);
});

test('book readers who bought are shown as stopped because they bought; resume everyone uses the explicit run ids', async () => {
  const world = bookWorld(), c = client(world); forBook(world, 1, 'stopped'); forBook(world, 2, 'paused');
  world.runs.find(r => r.email === bookPerson(1).email)!.reason = 'purchased';
  const text = visibleText((await c.request('GET', BOOK)).body);
  assert.match(text, /Stopped because they bought from you\. Nothing more from this sequence is sent to them\./u);
  const confirm = await c.request('GET', `${BOOK}&confirm=resume-all`);
  const fields = c.formFields(confirm.body, `${BASE}/resume-all`); fields.set('confirm', 'yes');
  assert.match(visibleText((await c.follow(await c.post(`${BASE}/resume-all`, fields))).body), /Resumed 1 person/u);
  assert.deepEqual(world.calls.filter(call => call === 'resumeV2' || call === 'resume'), ['resumeV2']);
});

test('webinar sequences on 0160 also start through the explicit list', async () => {
  const world = createWorld(); world.db160 = true; const c = client(world);
  const fields = c.formFields((await c.request('GET', page(seq.item, seq.version, '&confirm=start'))).body, `${BASE}/start`); fields.set('confirm', 'yes');
  await c.post(`${BASE}/start`, fields);
  assert.deepEqual(world.calls.filter(call => ['enrol', 'startV2'].includes(call)), ['startV2']); assert.equal(world.runs.length, 16);
});

test('the worker runs the book sweep before claiming, tolerates 0159 and never lets a sweep failure starve the claims', async () => {
  for (const sweep of [async () => ({ stoppedPurchased: 1, processed: 2, enrolled: 1, skipped: 1, heldSwitches: 0 }), async () => null, async () => { throw new Error('down'); }]) {
    const order: string[] = [];
    const queue = { bookSweep: async (limit: number) => { order.push(`sweep:${limit}`); return sweep(); }, claim: async () => { order.push('claim'); return []; },
      prepare: async () => null, settle: async () => {}, unknown: async () => {} } as unknown as MhpSequenceDispatch;
    const sender = { sendRendered: async () => 'x', recipientsAvailable: async () => true } as never;
    await dispatchMhpSequenceEmails({ queue, sender, unsubscribeSecret: 's'.repeat(32), testRecipients: null });
    assert.deepEqual(order, ['sweep:100', 'claim']);
  }
});
