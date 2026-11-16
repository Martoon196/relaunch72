/**
 * The second independent review of release 2: late reports after a founder restart (S-3), the account trip-wire with
 * one business and with several (S-6), which Postmark bounce types count and where (S-7), and the sentences that had
 * to become true (small numbers, the account's own wording, slowed while not live, the ramp, a refused test replay).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT, RESTART_MIN_SENDS, accountDecision, decide, judge, recovered, sampleVerdict, tripFromNumbers, tripNumbers } from '../src/email-protection/rules.js';
import { founderTripped, ownerAlertEmail, ownerBanner, ownerTripped } from '../src/email-protection/messages.js';
import { OwnerSendingService, SENDING_MESSAGES } from '../src/email-protection/owner.js';
import { counts, MemoryProtectionStore, OWNER, PP_WS } from './email-protection-fixtures.js';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const DAY = 86_400_000;
const LIFTED = new Date(NOW - DAY).toISOString();

test('S-3: after a founder restart, late complaints (3 -> lift -> 1 send -> 3 late) and late hard bounces (5) cannot pause on their own', () => {
  // The first-ever pause, before any restart: today's rule, at any volume.
  assert.equal(judge(counts({ complaints30: 3, sends30: 1 })).level, 'paused');
  assert.equal(judge(counts({ hardLast50: 5, last50Sends: 1, hard7: 5, sends7: 1 })).level, 'paused');
  // Restarted (counted from the first live send after it): 1 send, then 3 late complaints. Slowed (it already is), never paused.
  const late = counts({ state: 'slowed', dailyCap: 25, hourlyCap: 7, since: LIFTED, countedSince: LIFTED, sendsSinceRestart: 1, sends30: 1, complaints30: 3 });
  assert.deepEqual([judge(late).level, judge(late).trip!.line], ['slowed', 'complaints']);
  assert.equal(decide(late, NOW), null, 'nothing to store: it stays slowed');
  // 5 late hard bounces after 1 send.
  const hard = counts({ state: 'slowed', dailyCap: 25, hourlyCap: 7, since: LIFTED, countedSince: LIFTED, sendsSinceRestart: 1, last50Sends: 1, hardLast50: 5, hard7: 5, sends7: 1 });
  assert.equal(judge(hard).level, 'ok', 'under 100 sends the rate lines do not apply either');
  assert.equal(decide(hard, NOW), null);
  // Once 20 live emails went out since the restart, the lines apply again.
  assert.equal(judge({ ...late, sendsSinceRestart: RESTART_MIN_SENDS - 1 }).level, 'slowed');
  assert.equal(judge({ ...late, sendsSinceRestart: RESTART_MIN_SENDS }).level, 'paused');
  assert.equal(judge({ ...hard, sendsSinceRestart: RESTART_MIN_SENDS, last50Sends: 20 }).level, 'paused');
  // The 4% rate line still needs 100 sends in the window, restart or not.
  assert.equal(judge(counts({ countedSince: LIFTED, sendsSinceRestart: 100, sends7: 100, hard7: 4 })).level, 'paused');
});

test('S-3: the small-number sentence is true ("while your last email was going out")', () => {
  assert.equal(ownerTripped({ line: 'hard_last50', level: 'paused', count: 5, total: 1, limit: 5 }),
    '5 emails came straight back as undeliverable while your last email was going out. Our limit is 5.');
  assert.equal(ownerTripped({ line: 'hard_last50', level: 'paused', count: 5, total: 12, limit: 5 }),
    '5 emails came straight back as undeliverable while your last 12 were going out. Our limit is 5.');
  assert.equal(founderTripped({ line: 'hard_last50', level: 'paused', count: 5, total: 1, limit: 5 }), '5 emails came straight back while their last email was going out. Our line is 5.');
});

test('S-3: the evaluator pauses again (not off) when fewer than 50 live sends followed the restart, and switches off from 50', async () => {
  const store = new MemoryProtectionStore(counts({ sends30: 400, complaints30: 3 }), () => NOW);
  const { EmailProtectionService } = await import('../src/email-protection/service.js');
  const service = new EmailProtectionService({ store, now: () => NOW });
  await service.evaluate(PP_WS);
  assert.equal(store.counts.state, 'paused', 'the first pause');
  store.counts = { ...store.counts, state: 'slowed', since: new Date(NOW).toISOString(), countedSince: new Date(NOW).toISOString(), sendsSinceRestart: 30, complaints30: 3 };
  await service.evaluate(PP_WS);
  assert.deepEqual([store.counts.state, store.events.at(-1)!.kind], ['paused', 'paused'], '30 sends since the restart: paused again, not off');
  store.counts = { ...store.counts, state: 'slowed', sendsSinceRestart: 50 };
  await service.evaluate(PP_WS);
  assert.deepEqual([store.counts.state, store.events.at(-1)!.kind], ['off', 'switched_off']);
});

test('S-6: with one business sending live the account lines never pause it; the hold still guards everyone, in words true for one business', () => {
  const only = counts({ workspaceId: 'a0000000-0000-4000-8000-000000000001', sends7: 1000, hard7: 40, sends30: 1000, complaints30: 6 });
  const one = accountDecision({ state: 'ok', sends7: 1000, bounces7: 40, sends30: 1000, complaints30: 6 }, [only]);
  assert.deepEqual(one.pause, [], 'its own ladder covers it');
  // A second business that is not sending live (testing) does not make two.
  assert.deepEqual(accountDecision({ state: 'ok', sends7: 1000, bounces7: 40, sends30: 1000, complaints30: 0 }, [only, counts({ workspaceId: 'b0000000-0000-4000-8000-000000000002', mode: 'test' })]).pause, []);
  const hold = accountDecision({ state: 'ok', sends7: 1000, bounces7: 50, sends30: 1000, complaints30: 0 }, [only]).hold!;
  assert.equal(hold.line, 'account_bounce');
  const said = ownerTripped(hold);
  assert.equal(said, 'Across our shared email account (every business that sends through it), 50 of 1,000 emails bounced in the last 7 days (5%). Our limit is 5%.');
  assert.doesNotMatch(said, /0 of your 0|your rate was the highest/u);
  assert.equal(founderTripped(hold), 'The whole account: 50 of 1,000 emails bounced in the last 7 days (5%). Our account line is 5%.');
});

test('S-6: two businesses paused in one pass: only the first is told its rate was the highest; the last one left is never paused', () => {
  const a = counts({ workspaceId: 'a0000000-0000-4000-8000-000000000001', sends7: 500, hard7: 40 });
  const b = counts({ workspaceId: 'b0000000-0000-4000-8000-000000000002', sends7: 500, hard7: 30 });
  const c = counts({ workspaceId: 'c0000000-0000-4000-8000-000000000003', sends7: 500, hard7: 20 });
  const verdict = accountDecision({ state: 'ok', sends7: 1500, bounces7: 90, sends30: 0, complaints30: 0 }, [a, b, c]);
  assert.deepEqual(verdict.pause.map(p => [p.workspaceId, p.trip.rank]), [[a.workspaceId, 1], [b.workspaceId, 2]], 'c is the last one left');
  assert.match(ownerTripped(verdict.pause[0]!.trip), /your rate was the highest, so we paused yours first\.$/u);
  const second = ownerTripped(verdict.pause[1]!.trip);
  assert.doesNotMatch(second, /your rate was the highest/u);
  assert.match(second, /after we paused the business with the highest rate it was still over, so we paused yours, the next highest, too\.$/u);
  // The rank survives the protection log (the banner and the alert are written later from it).
  assert.equal(tripFromNumbers(tripNumbers(verdict.pause[1]!.trip, b), 'paused')!.rank, 2);
  assert.match(founderTripped(verdict.pause[1]!.trip), /the next highest after the business paused before it/u);
});

test('S-6: an account-caused pause never says a second pause switches email off', () => {
  const trip = { line: 'account_bounce' as const, level: 'paused' as const, count: 90, total: 1500, limit: 3, days: 7, own: { count: 40, total: 500 }, rank: 1 };
  const banner = ownerBanner({ state: 'paused', trip, dailyCap: 0, sampleState: 'passed', sampleTrip: null, ownerPaused: false, accountHeld: false, mode: 'live', waitingApproval: false })!;
  assert.doesNotMatch(banner.text, /second pause/u);
  assert.match(banner.text, /This pause came from our shared account's limit, so it does not count toward switching your email off\./u);
  const email = ownerAlertEmail({ kind: 'paused', businessName: 'B', trip, pageUrl: 'u' })!;
  assert.doesNotMatch(email.text, /second pause/u);
  const own = ownerBanner({ state: 'paused', trip: { line: 'complaints', level: 'paused', count: 3, total: 400, limit: 3, days: 30 }, dailyCap: 0, sampleState: 'passed', sampleTrip: null,
    ownerPaused: false, accountHeld: false, mode: 'live', waitingApproval: false })!;
  assert.match(own.text, /Only we can restart it\. A second pause within 90 days can switch your email off\./u);
});

test('S-6: an account complaint candidate needs at least 3 complaints of its own and at least 100 live sends', () => {
  const run = (complaints: number, sends: number) => accountDecision({ state: 'ok', sends7: 0, bounces7: 0, sends30: 4000, complaints30: 3 },
    [counts({ workspaceId: 'a0000000-0000-4000-8000-000000000001', sends30: 4000 - sends, complaints30: 3 - complaints }), counts({ workspaceId: 'b0000000-0000-4000-8000-000000000002', sends30: sends, complaints30: complaints })]).pause;
  assert.deepEqual(run(2, 99).map(p => p.workspaceId), [], '2 complaints of its own: not a candidate (and nor is the other)');
  assert.deepEqual(run(3, 99), [], '99 sends: not a candidate');
  assert.deepEqual(run(3, 100).map(p => p.trip.own), [{ count: 3, total: 100 }]);
  assert.equal(ACCOUNT.candidateMinComplaints, 3);
});

test('S-7: blocked (Blocked, SpamNotification) counts toward SLOWED only: never a pause, the sample or the account lines', () => {
  // 2 bounces + 2 blocked of 100 = 4%: slowed (bounces and blocked), not paused (bounces only, 2%).
  const c = counts({ sends7: 100, hard7: 1, soft7: 1, blocked7: 2 });
  const judged = judge(c);
  assert.deepEqual([judged.level, judged.trip!.count, judged.trip!.blocked], ['slowed', 4, 2]);
  assert.match(ownerTripped(judged.trip), /4 of your 100 emails bounced or were blocked as spam by the receiving email service \(4%\)\. Our limit is 2%\./u);
  assert.equal(judge(counts({ sends7: 100, blocked7: 50 })).level, 'slowed', 'even 50% blocked never pauses');
  assert.equal(judge(counts({ sends7: 100, blocked7: 1, hard7: 0 })).level, 'ok', '1% is under the line');
  // Recovery needs blocked under 1% too (no flapping in and out).
  const slowed = counts({ state: 'slowed', since: new Date(NOW - 8 * DAY).toISOString(), sends7: 200, blocked7: 3 });
  assert.equal(recovered(slowed, NOW), false);
  assert.equal(recovered({ ...slowed, blocked7: 1 }, NOW), true);
  // The sample is judged on its bounces and complaints only (0156 counts sampleBounces from hard and soft).
  assert.equal(sampleVerdict(counts({ sampleState: 'sending', sampleSends: 10, sampleBounces: 1, blocked7: 9 }), NOW).verdict, null);
  // The account lines read bounces7 (hard + soft): a business with only blocked is never a candidate.
  assert.deepEqual(accountDecision({ state: 'ok', sends7: 1000, bounces7: 30, sends30: 0, complaints30: 0 },
    [counts({ workspaceId: 'a0000000-0000-4000-8000-000000000001', sends7: 500, blocked7: 100, hard7: 0 }), counts({ workspaceId: 'b0000000-0000-4000-8000-000000000002', sends7: 500, hard7: 30 })]).pause
    .map(p => p.workspaceId), ['b0000000-0000-4000-8000-000000000002']);
});

test('true sentences: slowed while not live says nothing goes; the ramp steps up only after busy, clean days; not connected says what happens', () => {
  const base = { trip: null, dailyCap: 25, sampleState: 'passed' as const, sampleTrip: null, ownerPaused: false, accountHeld: false, waitingApproval: false };
  const live = ownerBanner({ ...base, state: 'slowed', mode: 'live' })!;
  assert.match(live.text, /They still go, at up to 25 emails a day; the rest wait their turn\./u);
  for (const mode of ['off', 'test'] as const) {
    const text = ownerBanner({ ...base, state: 'slowed', mode })!.text;
    assert.doesNotMatch(text, /They still go/u, mode);
    assert.match(text, /No marketing emails go until you are live; then they go at up to 25 emails a day\./u, mode);
  }
  const approved = ownerAlertEmail({ kind: 'go_live_approved', businessName: 'B', trip: null, pageUrl: 'u' })!.text;
  assert.match(approved, /New senders start at 50 marketing emails a day\. The limit steps up only after busy, clean days \(enough emails sent, bounces under 2% and no spam reports\), to 2,000 a day after four weeks at the soonest\./u);
  const gone = ownerBanner({ ...base, state: 'ok', mode: 'live', notConnected: true })!;
  assert.deepEqual([gone.tone, gone.title], ['alert', 'Email is not connected right now']);
  assert.equal(gone.text, 'Email is not connected right now, so nothing is being sent. Reconnect it to carry on. People you have started are waiting and will go when it is connected again.');
  const lifted = ownerAlertEmail({ kind: 'lifted', businessName: 'B', trip: null, pageUrl: 'u' })!.text;
  assert.match(lifted, /Another pause within 90 days can switch email off: once at least 50 more emails have gone, and always on a third pause\./u);
});

test('"Send a test to me" replayed: "already sent" only when the first attempt was accepted; a refused or unanswered one says so', async () => {
  const { MemoryProtectionStore: Store } = await import('./email-protection-fixtures.js');
  const store = new Store(counts(), () => NOW);
  const connection = { status: 'verified', fromAddress: 'hello@mail.pp-send-proof.co.uk', fromName: 'PP', replyTo: null, stream: 'broadcast', mode: 'test',
    protection: { state: 'ok', reason: null, since: null, dailyCap: 50, hourlyCap: 13, warmupStartedAt: null }, webhookId: 1 } as never;
  const service = new OwnerSendingService({ protection: store, connections: { sealed: async () => ({ serverToken: 'x' }) } as never,
    vault: { open: () => 'srv-token' } as never, fetcher: (async () => { throw new Error('never sent'); }) as never } as never);
  const identity = { sessionToken: OWNER, userId: PP_WS, workspaceId: PP_WS } as never;
  store.reserveAnswer = 'replayed_refused';
  assert.deepEqual(await service.sendTest(identity, connection, 'cmd'), { ok: false, message: SENDING_MESSAGES.testReplayedRefused });
  assert.equal(SENDING_MESSAGES.testReplayedRefused, 'That test did not go the first time. Refresh this page and send the test again.');
  store.reserveAnswer = 'replayed_unknown';
  assert.deepEqual(await service.sendTest(identity, connection, 'cmd'), { ok: false, message: SENDING_MESSAGES.testUnknown });
  store.reserveAnswer = 'replayed';
  assert.deepEqual(await service.sendTest(identity, connection, 'cmd'), { ok: true, message: SENDING_MESSAGES.testReplayed });
});

test('a second own pause that stayed paused says what is now true, to the owner and the founder', async () => {
  const { founderLine } = await import('../src/email-protection/messages.js');
  const { founderToday } = await import('../src/email-protection/service.js');
  const { bannerFor } = await import('../src/email-protection/owner.js');
  const trip = { line: 'complaints' as const, level: 'paused' as const, count: 3, total: 400, limit: 3, days: 30 };
  const input = { state: 'paused' as const, trip, dailyCap: 0, sampleState: 'passed' as const, sampleTrip: null, ownerPaused: false, accountHeld: false, mode: 'live' as const, waitingApproval: false };
  const first = ownerBanner(input)!.text, second = ownerBanner({ ...input, secondPause: true })!.text;
  assert.match(first, /Only we can restart it\. A second pause within 90 days can switch your email off\.$/u);
  assert.match(second, /Only we can restart it\. One more pause within 90 days switches your email off\.$/u);
  assert.doesNotMatch(second, /a second pause/iu);
  assert.match(ownerAlertEmail({ kind: 'paused', businessName: 'B', trip, pageUrl: 'u', secondPause: true })!.text, /One more pause within 90 days switches your email off\.$/u);
  assert.match(ownerAlertEmail({ kind: 'paused', businessName: 'B', trip, pageUrl: 'u' })!.text, /A second pause within 90 days can switch your email off\.$/u);
  // The page reads it from the logged step (0156 records previousPauseAt when it stayed paused).
  const sending = { lastStep: { kind: 'paused', at: 'x', line: 'complaints', count: 3, total: 400, limit: 3, days: 30, previousPauseAt: '2026-11-01T00:00:00Z', sendsSinceRestart: 12 },
    goLiveApprovedAt: 'x', ownerPausedAt: null, sampleState: 'passed', lastOwnerAlert: null, ownerEmailCount: 0, accountHeld: false, goLiveRequestedAt: null, approvedCurrent: true, testCurrent: true } as never;
  const connection = { mode: 'live', status: 'verified', protection: { state: 'paused', reason: null, since: null, dailyCap: 0, hourlyCap: 0, warmupStartedAt: null } } as never;
  assert.match(bannerFor(connection, sending)!.text, /One more pause within 90 days switches your email off\.$/u);
  // The founder: the line says why it was not switched off and what the next one does.
  const line = founderLine({ kind: 'paused', businessName: 'Second Ltd', trip, secondPause: { sendsSinceRestart: 12 } })!;
  assert.match(line.sentence, / This is their second pause in 90 days \(12 emails sent since you last restarted them\), so they were paused again rather than switched off\. A third pause switches them off\.$/u);
  assert.doesNotMatch(founderLine({ kind: 'paused', businessName: 'Second Ltd', trip })!.sentence, /second pause/u);
  const today = founderToday({ account: { state: 'ok', reason: null, since: null, rowVersion: 1, numbers: null }, businesses: [{ workspaceId: PP_WS, businessName: 'Second Ltd', status: 'verified',
    mode: 'live', state: 'paused', reason: null, since: null, rowVersion: 2, goLiveRequestedAt: null, goLiveApprovedAt: 'x', sampleState: 'passed', counts: null,
    lastStep: { kind: 'paused', at: 'x', line: 'complaints', count: 3, total: 400, limit: 3, days: 30, previousPauseAt: 'y', sendsSinceRestart: 1 } }] }, 'u');
  assert.match(today.sentences[0]!, /\(1 email sent since you last restarted them\)/u);
});
