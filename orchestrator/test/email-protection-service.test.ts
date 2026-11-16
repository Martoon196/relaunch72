/**
 * Sender protection running: the evaluator (after each counted event and on a timer), replays counted once, the
 * account trip-wire, the alert emails and the founder's Today lines, and every sentence people read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EmailProtectionService, founderToday } from '../src/email-protection/service.js';
import { founderAlertEmail, founderLine, ownerAlertEmail, ownerBanner, ownerTripped, STILL_GOES } from '../src/email-protection/messages.js';
import { judge } from '../src/email-protection/rules.js';
import { counts, MemoryProtectionStore, PP_WS } from './email-protection-fixtures.js';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');

test('the evaluator pauses at the line and not one below; replays are counted once; a second own pause within 90 days is off', async () => {
  const store = new MemoryProtectionStore(counts({ sends7: 20, hard7: 4, last50Sends: 20, hardLast50: 4 }), () => NOW);
  const service = new EmailProtectionService({ store, now: () => NOW });
  assert.equal(await service.count({ workspaceId: PP_WS, kind: 'hard_bounce', key: 'bounce:1', at: NOW }), 'recorded');
  await service.settled();
  assert.equal(store.counts.state, 'ok', 'four is one below the line');
  assert.equal(await service.count({ workspaceId: PP_WS, kind: 'hard_bounce', key: 'bounce:1', at: NOW }), 'exists', 'a replay');
  assert.equal(store.applied.length, 0, 'a replay starts no evaluation and nothing changed');
  store.counts = { ...store.counts, hard7: 5, hardLast50: 5 };
  await service.count({ workspaceId: PP_WS, kind: 'hard_bounce', key: 'bounce:2', at: NOW });
  await service.settled();
  assert.equal(store.counts.state, 'paused');
  const paused = store.events.at(-1)!;
  assert.deepEqual([paused.kind, paused.numbers.line, paused.numbers.count, paused.numbers.cause], ['paused', 'hard_last50', 5, 'own']);
  assert.deepEqual(store.alerts.map(a => [a.audience, a.kind]), [['owner', 'paused'], ['founder', 'paused']]);
  // Nothing the evaluator does moves it down: paused stays paused.
  store.counts = { ...store.counts, hard7: 0, hardLast50: 0 };
  await service.evaluate(PP_WS);
  assert.equal(store.counts.state, 'paused');
  // The founder lifts (slowed); a second own pause within 90 days becomes off.
  store.counts = { ...store.counts, state: 'slowed', hard7: 5, hardLast50: 5 };
  await service.evaluate(PP_WS);
  assert.equal(store.counts.state, 'off');
  assert.equal(store.events.at(-1)!.kind, 'switched_off');
});

test('compare-and-set: another instance that moved first makes this one look again, once', async () => {
  const store = new MemoryProtectionStore(counts({ sends7: 100, hard7: 2 }), () => NOW);
  const service = new EmailProtectionService({ store, now: () => NOW });
  const real = store.numbers.bind(store);
  let first = true;
  store.numbers = async () => { const n = await real(); if (first) { first = false; store.counts = { ...store.counts, state: 'slowed', since: new Date(NOW).toISOString(), dailyCap: 25, hourlyCap: 7 }; } return n; };
  assert.equal(await service.evaluate(PP_WS), null, 'the second look finds the step already taken');
  assert.deepEqual(store.applied.map(a => a.result), ['stale']);
});

test('the account trip-wire pauses the worst offender first (not counted as an own pause) and holds everyone at real risk', async () => {
  const other = counts({ workspaceId: 'a0000000-0000-4000-8000-000000000009', sends7: 400, hard7: 7 });
  const store = new MemoryProtectionStore(counts({ sends7: 600, hard7: 23 }), () => NOW);
  store.others = [other];
  store.account = { state: 'ok', sends7: 1000, bounces7: 30, sends30: 1000, complaints30: 0 };
  const service = new EmailProtectionService({ store, now: () => NOW });
  await service.evaluateAll();
  assert.equal(store.counts.state, 'paused', 'PP has 23 of the 30 bounces');
  assert.equal(store.others[0]!.state, 'ok', 'the rest is under 3% once PP is out');
  const pause = store.events.find(e => e.kind === 'paused')!;
  assert.deepEqual([pause.numbers.cause, pause.numbers.line, pause.numbers.ownCount], ['account', 'account_bounce', 23]);
  store.account = { state: 'ok', sends7: 1000, bounces7: 50, sends30: 1000, complaints30: 0 };
  await service.evaluateAll();
  assert.equal(store.account.state, 'held');
  assert.ok(store.alerts.some(a => a.audience === 'founder' && a.kind === 'account_held' && a.workspaceId === null));
});

test('at 0155 nothing is evaluated, counted or shown, and nothing throws', async () => {
  const store = new MemoryProtectionStore(counts(), () => NOW);
  store.absent = true;
  const service = new EmailProtectionService({ store });
  assert.equal(await service.count({ workspaceId: PP_WS, kind: 'hard_bounce', key: 'bounce:9', at: NOW }), null);
  assert.equal(await service.evaluate(PP_WS), null);
  await service.evaluateAll();
  assert.deepEqual(await service.founderToday(), { available: false, needsYou: false, lines: [], sentences: [], summary: 'Email sending needs nothing from you.' });
  assert.equal(await service.flushAlerts(), 0);
});

test('alert emails: the owner\'s and the founder\'s, through the platform sender, each once; no sender means they wait', async () => {
  const store = new MemoryProtectionStore(counts({ sends7: 120, hard7: 6 }), () => NOW);
  const sent: { to: string; subject: string; text: string; html: string }[] = [];
  const quiet = new EmailProtectionService({ store, now: () => NOW });
  await quiet.evaluate(PP_WS);
  assert.equal(await quiet.flushAlerts(), 0, 'no mailer: nothing is claimed');
  assert.equal(store.done.length, 0);
  const service = new EmailProtectionService({ store, now: () => NOW, founderEmail: 'Founder@pp-send-proof.co.uk', portalOrigin: 'https://hq.propertypredator.com' });
  service.setMailer({ send: async message => { sent.push(message); } });
  assert.equal(await service.flushAlerts(), 2);
  const owner = sent.find(m => m.to === 'owner@pp-send-proof.co.uk')!, founder = sent.find(m => m.to === 'founder@pp-send-proof.co.uk')!;
  assert.equal(owner.subject, 'Property Predator Ltd\'s marketing emails are paused');
  assert.ok(owner.text.startsWith('In the last 7 days, 6 of your 120 emails bounced (5%). Our limit is 4%.\n\n'));
  assert.match(owner.text, new RegExp(STILL_GOES.replace(/[.]/gu, '\\.')));
  assert.match(owner.text, /Only we can restart it\. A second pause within 90 days can switch your email off\./u);
  assert.match(owner.text, /See your email page: https:\/\/hq\.propertypredator\.com\/portal\/email$/u);
  assert.equal(founder.subject, 'Emails paused for Property Predator Ltd');
  assert.equal(founder.text, 'Emails paused for Property Predator Ltd. 6 of their last 120 emails bounced (5%, last 7 days). Our line is 4%, Postmark\'s is 10%. Sign-in and booking emails still go. Nobody else is affected.\n\nReview and decide: https://hq.propertypredator.com/portal/email/founder');
  assert.match(founder.html, /<a href="https:\/\/hq\.propertypredator\.com\/portal\/email\/founder"/u);
  assert.equal(await service.flushAlerts(), 0, 'each once');
  // A failed send is tried again later; with no founder address it is not sent (and given up by the database after 5 tries).
  store.counts = { ...store.counts, state: 'ok' };
  const failing = new EmailProtectionService({ store, now: () => NOW, founderEmail: null });
  failing.setMailer({ send: async () => { throw new Error('down'); } });
  store.events.length = 0;
  await failing.evaluate(PP_WS);
  await failing.flushAlerts();
  assert.deepEqual(store.done.slice(-2).map(d => d.sent), [false, false]);
});

test('the founder\'s Today: nothing when all is well; one line with one button for each thing that needs them', () => {
  assert.deepEqual(founderToday(null, 'u'), { available: false, needsYou: false, lines: [], sentences: [], summary: 'Email sending needs nothing from you.' });
  const base = { workspaceId: PP_WS, businessName: 'Property Predator Ltd', status: 'verified', mode: 'live' as const, reason: null, since: null, rowVersion: 4,
    goLiveRequestedAt: null, goLiveApprovedAt: '2026-11-01T00:00:00Z', sampleState: 'passed' as const, counts: null, lastStep: null };
  const quiet = founderToday({ account: { state: 'ok', reason: null, since: null, rowVersion: 1, numbers: null }, businesses: [{ ...base, state: 'slowed' }] }, 'u');
  assert.equal(quiet.needsYou, false, 'slowed recovers by itself: nothing for the founder');
  const today = founderToday({ account: { state: 'held', reason: 'x', since: null, rowVersion: 1, numbers: { line: 'account_bounce', count: 60, total: 1000, limit: 5 } },
    businesses: [{ ...base, state: 'paused', lastStep: { kind: 'paused', at: 'x', line: 'complaints', count: 3, total: 400, limit: 3, days: 30 } },
      { ...base, workspaceId: 'b0000000-0000-4000-8000-000000000002', businessName: 'Second Ltd', state: 'ok', goLiveRequestedAt: '2026-11-19T00:00:00Z', goLiveApprovedAt: null, domain: 'second.co.uk' },
      // S-1: a business approved before for another domain asks again for its new one: it reaches the founder, naming it.
      { ...base, workspaceId: 'b0000000-0000-4000-8000-000000000003', businessName: 'Third Ltd', state: 'ok', goLiveRequestedAt: '2026-11-19T00:00:00Z', goLiveApprovedAt: '2026-11-01T00:00:00Z', domain: 'new-third.co.uk' }] }, 'https://x/f');
  assert.deepEqual(today.lines.map(l => [l.tone, l.kind, l.button, l.url]), [['red', 'account_held', 'See what happened', 'https://x/f'], ['red', 'paused', 'Review and decide', 'https://x/f'],
    ['amber', 'go_live_requested', 'Approve', 'https://x/f'], ['amber', 'go_live_requested', 'Approve', 'https://x/f']]);
  assert.deepEqual(today.sentences, [
    'The whole account is getting close to Postmark\'s limit. The whole account: 60 of 1,000 emails bounced in the last 7 days (6%). Our account line is 5%. Marketing emails are on hold for every business.',
    'Emails paused for Property Predator Ltd. 3 people marked their emails as spam in the last 30 days. Our line is 3, Postmark\'s is 1 in 1,000 emails. Sign-in and booking emails still go. Nobody else is affected.',
    'Second Ltd is ready to go live, sending from second.co.uk.', 'Third Ltd is ready to go live, sending from new-third.co.uk.']);
  assert.equal(today.summary.startsWith('4 email sending items need you.'), true);
  // The founder's alert email names the domain too.
  assert.equal(founderAlertEmail({ kind: 'go_live_requested', businessName: 'Third Ltd', trip: null, pageUrl: 'u', domain: 'new-third.co.uk' })!.subject, 'Third Ltd is ready to go live (new-third.co.uk)');
});

test('every sentence a business owner reads, for each state, is plain and exact', () => {
  const trip = judge(counts({ sends7: 120, hard7: 6 })).trip!;
  assert.equal(ownerTripped(trip), 'In the last 7 days, 6 of your 120 emails bounced (5%). Our limit is 4%.');
  assert.equal(ownerTripped(judge(counts({ sends7: 150, hard7: 3 })).trip), 'In the last 7 days, 3 of your 150 emails bounced (2%). Our limit is 2%.');
  assert.equal(ownerTripped(judge(counts({ complaints30: 2 })).trip), '2 people marked your emails as spam in the last 30 days. Our limit is 2.');
  assert.equal(ownerTripped(judge(counts({ hardLast50: 5, last50Sends: 50 })).trip), '5 emails came straight back as undeliverable while your last 50 were going out. Our limit is 5.');
  const banner = (over: Partial<Parameters<typeof ownerBanner>[0]>) => ownerBanner({ state: 'ok', trip: null, dailyCap: 50, sampleState: 'passed', sampleTrip: null, ownerPaused: false,
    accountHeld: false, mode: 'live', waitingApproval: false, ...over });
  assert.equal(banner({}), null, 'nothing to say');
  assert.deepEqual(banner({ state: 'paused', trip, emailed: true }), { tone: 'alert', title: 'Your marketing emails are paused',
    text: `In the last 7 days, 6 of your 120 emails bounced (5%). Our limit is 4%. ${STILL_GOES} No other business is affected. Your marketing emails are waiting and will go when we restart them. To restart: remove the addresses that bounced or complained, check where your newest addresses came from, then reply to our email. Only we can restart it. A second pause within 90 days can switch your email off.` });
  // "Reply to our email" only when an email really went (or is on its way); otherwise what is true.
  assert.match(banner({ state: 'paused', trip, emailed: false })!.text, /then tell us \(we can see this too\)\./u);
  assert.doesNotMatch(banner({ state: 'paused', trip, emailed: false })!.text, /reply to our email|we will email/iu);
  assert.equal(banner({ state: 'slowed', trip: judge(counts({ sends7: 150, hard7: 3 })).trip, dailyCap: 25 })!.text,
    'In the last 7 days, 3 of your 150 emails bounced (2%). Our limit is 2%. They still go, at up to 25 emails a day; the rest wait their turn. This lifts by itself after 7 clean days: bounces under 1% (none, if you sent fewer than 100 emails that week) and fewer than 2 spam reports in 30 days. Remove addresses that bounced and only email people who asked to hear from you.');
  assert.match(banner({ state: 'slowed', trip: null, reasonText: 'Restarted after a pause.' })!.text, /^Restarted after a pause\. They still go/u, 'the stored reason when no slowed step is the latest');
  assert.match(banner({ state: 'off', trip, emailed: true })!.text, /It was paused twice within 90 days, so we switched it off to protect everyone who sends through our shared account\. Sign-in links, receipts and booking and webinar confirmations still go\. Your marketing emails are waiting and go only if we switch it back on: reply to our email to ask for a review\.$/u);
  const sampleTrip = { line: 'sample' as const, level: 'held' as const, count: 2, total: 50, limit: 1, own: { count: 0, total: 50 } };
  assert.equal(banner({ sampleState: 'held', sampleTrip, emailed: true })!.text, `We sent the first 50 emails and checked them: 2 bounced and 0 people marked one as spam. Our limit is 1 bounce and no spam reports. The rest of this list is waiting and will go when it is cleaned and we let it go. Remove old, bought or guessed addresses, then reply to our email. ${STILL_GOES}`);
  // Slowed and held at once: the held list is the stronger news.
  assert.equal(banner({ state: 'slowed', sampleState: 'held', sampleTrip })!.title, 'We have held the rest of your list');
  assert.equal(banner({ accountHeld: true })!.text, `Marketing emails are on hold for every business that sends through our shared email account while we look into it. ${STILL_GOES} Yours are waiting and will go when the hold is lifted. You don't need to do anything.`);
  assert.equal(banner({ ownerPaused: true })!.text, 'Nothing marketing goes until you press Resume; everything is waiting. Send a test to me still works.');
  assert.equal(banner({ mode: 'test', waitingApproval: true, willEmail: true })!.text, 'Waiting for approval from the platform owner, which is usually quick. We will email you when it is done; nothing else is needed from you.');
  assert.equal(banner({ mode: 'test', waitingApproval: true, willEmail: false })!.text, 'Waiting for approval from the platform owner, which is usually quick. Check back on your email page for the answer; nothing else is needed from you.');
  assert.equal(banner({ notConnected: true, sampleState: 'held' })!.text, 'Email is not connected right now, so nothing is being sent. Reconnect it to carry on. People you have started are waiting and will go when it is connected again.');
  assert.equal(banner({ needsApproval: true })!.title, 'Your new sending address needs approval');
  assert.equal(banner({ needsTest: true })!.title, 'Send a test first');
  assert.equal(banner({ switchedOffHere: true })!.title, 'Sending is switched off on our side');
  assert.match(banner({ sampleState: 'sending' })!.text, /^Your first 50 marketing emails go first, then we wait 2 hours to check how many bounced or were marked as spam\./u);
  // The strongest wins: off over paused over the account hold over a held sample over slowed.
  assert.equal(banner({ state: 'off', accountHeld: true, sampleState: 'held', ownerPaused: true })!.title, 'Your email sending is switched off');
  assert.equal(banner({ state: 'slowed', accountHeld: true })!.title, 'Marketing emails are on hold for everyone');
  // The account trip-wire tells a business its OWN numbers only.
  const account = { line: 'account_bounce' as const, level: 'paused' as const, count: 407, total: 13000, limit: 3, days: 7, own: { count: 117, total: 3000 } };
  assert.equal(ownerTripped(account), 'In the last 7 days, 117 of your 3,000 emails bounced (3.9%). Together with other businesses this took our shared email account over its 3% limit, and your rate was the highest, so we paused yours first.');
  assert.doesNotMatch(ownerTripped(account), /407|13,000/u);
  // The emails.
  assert.equal(ownerAlertEmail({ kind: 'slowed', businessName: 'PP', trip, dailyCap: 25, pageUrl: 'u' })!.subject, 'We have slowed PP\'s marketing emails');
  assert.equal(ownerAlertEmail({ kind: 'go_live_approved', businessName: 'PP', trip: null, pageUrl: 'u' })!.subject, 'PP is live');
  assert.equal(ownerAlertEmail({ kind: 'nonsense', businessName: 'PP', trip: null, pageUrl: 'u' }), null);
  assert.equal(founderAlertEmail({ kind: 'go_live_requested', businessName: 'PP', trip: null, pageUrl: 'u' })!.subject, 'PP is ready to go live');
  assert.equal(founderLine({ kind: 'sample_held', businessName: 'PP', trip: sampleTrip })!.tone, 'red', 'only the founder can release it');
  assert.equal(founderLine({ kind: 'sample_held', businessName: 'PP', trip: sampleTrip })!.sentence, 'PP sent its first 50 emails to a list and the rest is held. Their first 50 emails: 2 bounced, 0 spam reports.');
  for (const text of [banner({ state: 'paused', trip })!.text, ownerAlertEmail({ kind: 'paused', businessName: 'PP', trip, pageUrl: 'u' })!.text]) {
    assert.doesNotMatch(text, /Postmark API|ErrorCode|_|token|EMAIL_/u, 'no setting names or provider text');
  }
});
