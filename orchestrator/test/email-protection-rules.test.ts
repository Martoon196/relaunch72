/**
 * Sender protection's numbers, each at its exact threshold and one below: the ladder (slowed, paused, the second pause
 * is the database's), recovery and hysteresis, caps and the warm-up ramp, the sample, the account trip-wire, and the
 * percentages people read (rounded down, never up).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT, LADDER, RAMP, SAMPLE, accountDecision, caps, decide, judge, nextWarmupStep, percent, recovered, sampleVerdict, tripFromNumbers, tripNumbers,
  type ProtectionCounts } from '../src/email-protection/rules.js';
import { counts } from './email-protection-fixtures.js';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const DAY = 86_400_000;
test('the headline lines are the owner\'s and Postmark\'s lines are well above them', () => {
  assert.deepEqual([LADDER.slowedBouncePercent, LADDER.pausedBouncePercent, LADDER.slowedComplaints, LADDER.pausedComplaints, LADDER.secondPauseDays], [2, 4, 2, 3, 90]);
  assert.deepEqual([LADDER.minSendsForRate, LADDER.bounceWindowDays, LADDER.complaintWindowDays, LADDER.pausedHardInLast50, LADDER.last50], [100, 7, 30, 5, 50]);
  assert.deepEqual(RAMP.map(step => [step.daily, step.days]), [[50, 3], [100, 4], [250, 7], [500, 7], [1000, 7], [2000, null]]);
  assert.equal(RAMP.slice(0, -1).reduce((n, step) => n + step.days!, 0), 28, 'four weeks to 2,000 a day');
  assert.deepEqual([SAMPLE.size, SAMPLE.waitHours, SAMPLE.holdAtBounces, SAMPLE.holdAtComplaints], [50, 2, 2, 1]);
  assert.deepEqual([ACCOUNT.minSends, ACCOUNT.watchBouncePercent, ACCOUNT.holdBouncePercent, ACCOUNT.watchComplaintsPerTenThousand, ACCOUNT.holdComplaintsPerTenThousand], [1000, 3, 5, 5, 8]);
  assert.ok(ACCOUNT.holdBouncePercent < 10 && ACCOUNT.holdComplaintsPerTenThousand < 10, 'below Postmark\'s 10% and 1 in 1,000');
});

test('bounce rate: slowed at exactly 2% and paused at exactly 4% of at least 100 sends in 7 days; one below never trips', () => {
  assert.equal(judge(counts({ sends7: 100, hard7: 1, soft7: 0 })).level, 'ok');
  assert.equal(judge(counts({ sends7: 100, hard7: 1, soft7: 1 })).level, 'slowed', 'soft bounces count, as at Postmark');
  assert.equal(judge(counts({ sends7: 150, hard7: 2, soft7: 0 })).level, 'ok', '1.33%');
  assert.equal(judge(counts({ sends7: 150, hard7: 3 })).level, 'slowed', '2% exactly');
  assert.equal(judge(counts({ sends7: 100, hard7: 3, soft7: 0 })).level, 'slowed', '3%');
  assert.equal(judge(counts({ sends7: 100, hard7: 2, soft7: 2 })).level, 'paused', '4% exactly');
  assert.equal(judge(counts({ sends7: 1000, hard7: 39 })).level, 'slowed', '3.9%');
  assert.equal(judge(counts({ sends7: 1000, hard7: 40 })).level, 'paused');
  assert.equal(judge(counts({ sends7: 99, hard7: 4, soft7: 0 })).level, 'ok', 'under 100 sends the rate is not meaningful (4 hard in 99)');
  const trip = judge(counts({ sends7: 120, hard7: 6 })).trip!;
  assert.deepEqual([trip.line, trip.level, trip.count, trip.total, trip.limit, trip.days], ['bounce_rate', 'paused', 6, 120, 4, 7]);
});

test('small volumes: 5 hard bounces while the last 50 went out pause at any volume; 4 do not', () => {
  assert.equal(judge(counts({ sends7: 20, hard7: 4, last50Sends: 20, hardLast50: 4 })).level, 'ok');
  const paused = judge(counts({ sends7: 20, hard7: 5, last50Sends: 20, hardLast50: 5 }));
  assert.deepEqual([paused.level, paused.trip!.line, paused.trip!.count, paused.trip!.total, paused.trip!.limit], ['paused', 'hard_last50', 5, 20, 5]);
});

test('complaints over 30 days: slowed at exactly 2, paused at exactly 3; 1 does nothing', () => {
  assert.equal(judge(counts({ complaints30: 1, sends30: 10 })).level, 'ok');
  assert.equal(judge(counts({ complaints30: 2, sends30: 10 })).level, 'slowed');
  assert.equal(judge(counts({ complaints30: 3, sends30: 10_000 })).level, 'paused', 'a fixed count, whatever the volume (never looser than 3)');
  assert.equal(judge(counts({ complaints30: 3 })).trip!.line, 'complaints');
});

test('decide: ok -> slowed -> paused upwards only; paused and off are never left by the system', () => {
  const slow = decide(counts({ sends7: 100, hard7: 2 }), NOW)!;
  assert.deepEqual([slow.from, slow.to, slow.kind, slow.daily, slow.hourly], ['ok', 'slowed', 'slowed', 25, 7], 'the cap is halved');
  const up = decide(counts({ state: 'slowed', since: new Date(NOW - DAY).toISOString(), dailyCap: 25, hourlyCap: 7, sends7: 100, hard7: 4 }), NOW)!;
  assert.deepEqual([up.from, up.to, up.kind, up.daily, up.hourly], ['slowed', 'paused', 'paused', 0, 0]);
  const direct = decide(counts({ sends7: 100, hard7: 5 }), NOW)!;
  assert.deepEqual([direct.from, direct.to], ['ok', 'paused'], 'straight to paused');
  for (const state of ['paused', 'off'] as const) {
    assert.equal(decide(counts({ state, dailyCap: 0, hourlyCap: 0, sends7: 0 }), NOW + 400 * DAY), null, `${state} stays ${state}: only the founder lifts it`);
    assert.deepEqual(decide(counts({ state, dailyCap: 50, hourlyCap: 13 }), NOW)!.to, state);
  }
  assert.equal(decide(counts({ dailyCap: 50, hourlyCap: 13 }), NOW), null, 'nothing to store');
});

test('recovery from slowed: only after 7 days, then under 1% (or no bounce at all under 100 sends) and fewer than 2 complaints; hysteresis', () => {
  const slowed = (over: Partial<ProtectionCounts>) => counts({ state: 'slowed', dailyCap: 25, hourlyCap: 7, ...over });
  const sixDays = new Date(NOW - 6 * DAY - 23 * 3_600_000).toISOString(), sevenDays = new Date(NOW - 7 * DAY).toISOString();
  assert.equal(recovered(slowed({ since: sixDays, sends7: 200 }), NOW), false, 'under 7 days');
  assert.equal(recovered(slowed({ since: sevenDays, sends7: 200, hard7: 1 }), NOW), true, '0.5%');
  assert.equal(recovered(slowed({ since: sevenDays, sends7: 200, hard7: 2 }), NOW), false, '1% exactly is not under 1%');
  assert.equal(recovered(slowed({ since: sevenDays, sends7: 50, hard7: 1 }), NOW), false, 'under 100 sends: no bounce at all');
  assert.equal(recovered(slowed({ since: sevenDays, sends7: 50 }), NOW), true);
  assert.equal(recovered(slowed({ since: sevenDays, sends7: 200, complaints30: 2 }), NOW), false);
  // Hysteresis: 1.5% is under the 2% that slows, but not under the 1% that recovers: no flapping.
  assert.equal(judge(slowed({ since: sevenDays, sends7: 200, hard7: 3 })).level, 'ok');
  assert.equal(decide(slowed({ since: sevenDays, sends7: 200, hard7: 3 }), NOW), null, 'stays slowed');
  const back = decide(slowed({ since: sevenDays, sends7: 200, hard7: 1 }), NOW)!;
  assert.deepEqual([back.to, back.kind, back.daily, back.hourly], ['ok', 'recovered', 50, 13]);
});

test('caps: the warm-up ramp, halved when slowed, the hourly cap a quarter rounded up, none when paused or off', () => {
  assert.deepEqual(RAMP.map((_, step) => caps(step, 'ok')), [{ daily: 50, hourly: 13 }, { daily: 100, hourly: 25 }, { daily: 250, hourly: 63 }, { daily: 500, hourly: 125 },
    { daily: 1000, hourly: 250 }, { daily: 2000, hourly: 500 }]);
  assert.deepEqual(caps(0, 'slowed'), { daily: 25, hourly: 7 });
  assert.deepEqual(caps(5, 'slowed'), { daily: 1000, hourly: 250 });
  assert.deepEqual(caps(3, 'paused'), { daily: 0, hourly: 0 });
  assert.deepEqual(caps(3, 'off'), { daily: 0, hourly: 0 });
  assert.deepEqual(caps(99, 'ok'), { daily: 2000, hourly: 500 });
});

test('warm-up: a step is earned only after its full period with an email, no complaint and bounces under 2%; otherwise its period restarts', () => {
  const at = (days: number) => new Date(NOW - days * DAY).toISOString();
  const base = { state: 'ok' as const, goLiveApprovedAt: at(30), warmupStep: 0, stepComplaints: 0 };
  assert.equal(nextWarmupStep({ ...base, warmupStepAt: at(2.99), stepSends: 140, stepBounces: 0 }, NOW).changed, false, 'before 3 days');
  assert.deepEqual(nextWarmupStep({ ...base, warmupStepAt: at(3), stepSends: 150, stepBounces: 2 }, NOW), { step: 1, stepAt: new Date(NOW).toISOString(), changed: true }, '1.33%');
  const dirty = nextWarmupStep({ ...base, warmupStepAt: at(3), stepSends: 150, stepBounces: 3 }, NOW);
  assert.deepEqual([dirty.step, dirty.changed, dirty.stepAt], [0, true, new Date(NOW).toISOString()], '2% exactly: not earned, the period starts again');
  assert.equal(nextWarmupStep({ ...base, warmupStepAt: at(3), stepSends: 150, stepBounces: 0, stepComplaints: 1 }, NOW).step, 0, 'any complaint');
  assert.equal(nextWarmupStep({ ...base, warmupStepAt: at(3), stepSends: 0, stepBounces: 0 }, NOW).changed, false, 'nothing sent: nothing earned, nothing restarted');
  assert.equal(nextWarmupStep({ ...base, state: 'slowed', warmupStepAt: at(9), stepSends: 150, stepBounces: 0 }, NOW).changed, false, 'never while slowed');
  assert.equal(nextWarmupStep({ ...base, goLiveApprovedAt: null, warmupStepAt: at(9), stepSends: 150, stepBounces: 0 }, NOW).changed, false, 'never before go-live');
  assert.equal(nextWarmupStep({ ...base, warmupStep: 5, warmupStepAt: at(99), stepSends: 1, stepBounces: 0 }, NOW).changed, false, 'the top step stays');
  for (const [step, days] of [[1, 4], [2, 7], [3, 7], [4, 7]] as const) {
    assert.equal(nextWarmupStep({ ...base, warmupStep: step, warmupStepAt: at(days - 0.01), stepSends: 10, stepBounces: 0 }, NOW).changed, false);
    assert.equal(nextWarmupStep({ ...base, warmupStep: step, warmupStepAt: at(days), stepSends: 10, stepBounces: 0 }, NOW).step, step + 1);
  }
  const earned = decide(counts({ warmupStepAt: at(3), stepSends: 150 }), NOW)!;
  assert.deepEqual([earned.kind, earned.step, earned.daily, earned.hourly], ['warmup_step', 1, 100, 25]);
});

test('the sample: 2 bounces or any complaint among the first 50 holds the rest at once; otherwise it passes 2 hours after the 50th', () => {
  const full = new Date(NOW - 2 * 3_600_000).toISOString(), early = new Date(NOW - 2 * 3_600_000 + 1).toISOString();
  assert.equal(sampleVerdict({ sampleState: 'sending', sampleFullAt: null, sampleSends: 30, sampleBounces: 1, sampleComplaints: 0 }, NOW).verdict, null);
  const held = sampleVerdict({ sampleState: 'sending', sampleFullAt: null, sampleSends: 30, sampleBounces: 2, sampleComplaints: 0 }, NOW);
  assert.deepEqual([held.verdict, held.trip!.line, held.trip!.count, held.trip!.total], ['held', 'sample', 2, 30], 'held without waiting');
  assert.equal(sampleVerdict({ sampleState: 'waiting', sampleFullAt: early, sampleSends: 50, sampleBounces: 0, sampleComplaints: 1 }, NOW).verdict, 'held');
  assert.equal(sampleVerdict({ sampleState: 'waiting', sampleFullAt: early, sampleSends: 50, sampleBounces: 1, sampleComplaints: 0 }, NOW).verdict, null, 'one millisecond short of 2 hours');
  assert.equal(sampleVerdict({ sampleState: 'waiting', sampleFullAt: full, sampleSends: 50, sampleBounces: 1, sampleComplaints: 0 }, NOW).verdict, 'passed');
  assert.equal(sampleVerdict({ sampleState: 'passed', sampleFullAt: full, sampleSends: 50, sampleBounces: 9, sampleComplaints: 0 }, NOW).verdict, null);
  const decision = decide(counts({ sampleState: 'waiting', sampleFullAt: full, sampleSends: 50 }), NOW)!;
  assert.deepEqual([decision.kind, decision.sample, decision.to], ['sample_passed', 'passed', 'ok']);
  const heldDecision = decide(counts({ sampleState: 'sending', sampleSends: 12, sampleBounces: 2 }), NOW)!;
  assert.deepEqual([heldDecision.kind, heldDecision.sample, heldDecision.to], ['sample_held', 'held', 'ok'], 'a held sample is not a pause');
});

test('the account trip-wire: worst offender first at 3% (or 1 in 2,000 complaints), everyone held at 5% (or 1 in 1,250); never under 1,000 emails', () => {
  const a = counts({ workspaceId: 'a0000000-0000-4000-8000-000000000001', sends7: 600, hard7: 20 });
  const b = counts({ workspaceId: 'b0000000-0000-4000-8000-000000000002', sends7: 400, hard7: 10 });
  const quiet = counts({ workspaceId: 'c0000000-0000-4000-8000-000000000003', sends7: 0 });
  // 30 of 1,000 = 3%: the worst (20 bounces) is paused; the rest (10 of 400 = 2.5%) is under the line.
  const watch = accountDecision({ state: 'ok', sends7: 1000, bounces7: 30, sends30: 1000, complaints30: 0 }, [a, b, quiet]);
  assert.equal(watch.hold, null);
  assert.deepEqual(watch.pause.map(p => [p.workspaceId, p.trip.line, p.trip.count, p.trip.total, p.trip.own!.count]), [[a.workspaceId, 'account_bounce', 30, 1000, 20]]);
  assert.deepEqual(accountDecision({ state: 'ok', sends7: 1000, bounces7: 29, sends30: 1000, complaints30: 0 }, [counts({ ...a, hard7: 19 }), b]).pause, [], '2.9%');
  assert.deepEqual(accountDecision({ state: 'ok', sends7: 999, bounces7: 300, sends30: 999, complaints30: 0 }, [counts({ ...a, sends7: 599, hard7: 290 }), b]).pause, [], 'under 1,000 emails');
  // Paused businesses no longer count towards the watch line, so it stops; the hold looks at the whole account.
  assert.deepEqual(accountDecision({ state: 'ok', sends7: 1000, bounces7: 30, sends30: 1000, complaints30: 0 }, [counts({ ...a, state: 'paused' }), b]).pause, []);
  const hold = accountDecision({ state: 'ok', sends7: 1000, bounces7: 50, sends30: 1000, complaints30: 0 }, [a, b]);
  assert.deepEqual([hold.hold!.line, hold.hold!.count, hold.hold!.limit], ['account_bounce', 50, 5]);
  assert.equal(accountDecision({ state: 'ok', sends7: 1000, bounces7: 49, sends30: 1000, complaints30: 0 }, [a, b]).hold, null, '4.9%');
  assert.equal(accountDecision({ state: 'held', sends7: 1000, bounces7: 90, sends30: 1000, complaints30: 0 }, [a, b]).hold, null, 'already held');
  // Complaints: 1 in 2,000 pauses the business with most; 1 in 1,250 holds everyone.
  const c1 = counts({ workspaceId: a.workspaceId, sends30: 1500, complaints30: 0 }), c2 = counts({ workspaceId: b.workspaceId, sends30: 500, complaints30: 1 });
  assert.deepEqual(accountDecision({ state: 'ok', sends7: 0, bounces7: 0, sends30: 2000, complaints30: 1 }, [c1, c2]).pause.map(p => [p.workspaceId, p.trip.line]), [[b.workspaceId, 'account_complaint']]);
  assert.deepEqual(accountDecision({ state: 'ok', sends7: 0, bounces7: 0, sends30: 2001, complaints30: 1 }, [counts({ ...c1, sends30: 1501 }), c2]).pause, [], 'just under 1 in 2,000');
  assert.equal(accountDecision({ state: 'ok', sends7: 0, bounces7: 0, sends30: 2500, complaints30: 2 }, []).hold!.line, 'account_complaint');
  assert.equal(accountDecision({ state: 'ok', sends7: 0, bounces7: 0, sends30: 2501, complaints30: 2 }, []).hold, null);
});

test('percent rounds down to one decimal: it never shows more than the truth', () => {
  assert.deepEqual([percent(6, 120), percent(7, 150), percent(1, 3), percent(2, 3), percent(39, 1000), percent(0, 5), percent(5, 0), percent(3, 7)],
    ['5%', '4.6%', '33.3%', '66.6%', '3.9%', '0%', '0%', '42.8%']);
});

test('logged numbers carry the trip and no address, and read back as the same trip', () => {
  const c = counts({ sends7: 120, hard7: 4, soft7: 2 });
  const trip = judge(c).trip!;
  const numbers = tripNumbers(trip, c);
  assert.ok(!JSON.stringify(numbers).includes('@'));
  assert.deepEqual(tripFromNumbers(numbers, 'paused'), trip);
  assert.equal(tripFromNumbers({ line: 'nonsense' }, 'paused'), null);
  assert.equal(tripFromNumbers(null, 'paused'), null);
});
