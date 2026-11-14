/**
 * Sender protection: every number and every decision, as pure functions (no IO, no clock of their own).
 *
 * Every business sends through ONE shared Postmark account. Postmark's own lines (Terms of Service 5(b)): bounces under
 * 10% of all emails sent (soft bounces count) and spam complaints under 1 in 1,000 (0.1%). Ours sit well below:
 *
 *   SLOWED  bounces 2% or more over the last 7 days (once at least 100 emails were sent in those 7 days), or 2 spam
 *           complaints in the last 30 days. The daily and hourly caps are halved.
 *   PAUSED  bounces 4% or more over the last 7 days (at least 100 sent), or 5 hard bounces while the last 50 emails were
 *           going out (any volume), or 3 spam complaints in the last 30 days. Marketing email stops for that business
 *           only; nobody is marked stopped and no attempt is spent.
 *   OFF     a second pause (of the business's own numbers) within 90 days. Only the founder can lift a pause or
 *           switch a business back on; nothing here ever moves a business down from paused or off.
 *   Recovery from SLOWED only, by itself: at least 7 days slowed, then 7 days with bounces under 1% (none at all when
 *           fewer than 100 emails were sent in those 7 days) and fewer than 2 spam complaints in 30 days. Entering at
 *           2% and leaving under 1% after a full week is the hysteresis: a business does not flap.
 *   Bounces are hard plus soft, the way Postmark counts them. Every window starts no earlier than the moment the
 *   founder last lifted or reinstated the business, so bounces that were already acted on never trip it twice.
 *
 *   WARM-UP  a business's first go-live starts at 50 marketing emails a day: 50 for 3 days, 100 for 4 days, 250, 500
 *           and 1,000 for 7 days each, then 2,000 (day 29 at the earliest). A step is earned only when its whole period
 *           had at least one email, no spam complaint and bounces under 2%; otherwise that step's period starts again.
 *           The hourly cap is a quarter of the daily cap, rounded up. No step is earned while slowed.
 *   SAMPLE   a first go-live (and every lift, reinstatement or release) sends its first 50 marketing emails, then waits
 *           2 hours after the 50th; 2 or more bounces or any spam complaint among them holds the rest (at once, without
 *           waiting); otherwise the rest goes by itself.
 *   ACCOUNT  across every business with a connection: with at least 1,000 emails in the window, bounces of 3% over 7
 *           days or complaints of 0.05% (1 in 2,000) over 30 days among the businesses still sending pause the worst
 *           offender first (most bounces, or most complaints), then the next, until the rest is back under the line;
 *           bounces of 5% or complaints of 0.08% (1 in 1,250) across the whole account hold every business's marketing
 *           until the founder lifts it. The founder is told either way.
 * All comparisons are done in whole numbers, so an exact threshold always trips and one below never does.
 */

export type ProtectionState = 'ok' | 'slowed' | 'paused' | 'off';
export type SampleState = 'none' | 'sending' | 'waiting' | 'passed' | 'held';

export const LADDER = Object.freeze({
  bounceWindowDays: 7,
  minSendsForRate: 100,
  slowedBouncePercent: 2,
  pausedBouncePercent: 4,
  last50: 50,
  pausedHardInLast50: 5,
  complaintWindowDays: 30,
  slowedComplaints: 2,
  pausedComplaints: 3,
  recoverBouncePercent: 1,
  recoverMinDays: 7,
  secondPauseDays: 90,
});

/** Postmark's own published lines, for the sentences only. */
export const POSTMARK_LINES = Object.freeze({ bouncePercent: 10, complaintsPerThousand: 1 });

export const RAMP: readonly { readonly daily: number; readonly days: number | null }[] = Object.freeze([
  Object.freeze({ daily: 50, days: 3 }), Object.freeze({ daily: 100, days: 4 }), Object.freeze({ daily: 250, days: 7 }),
  Object.freeze({ daily: 500, days: 7 }), Object.freeze({ daily: 1_000, days: 7 }), Object.freeze({ daily: 2_000, days: null }),
]);
export const RAMP_STEP_BOUNCE_PERCENT = 2;

export const SAMPLE = Object.freeze({ size: 50, waitHours: 2, holdAtBounces: 2, holdAtComplaints: 1 });

export const ACCOUNT = Object.freeze({
  minSends: 1_000,
  /** Worst offenders paused first. */
  watchBouncePercent: 3, watchComplaintsPerTenThousand: 5,
  /** Every business's marketing held. */
  holdBouncePercent: 5, holdComplaintsPerTenThousand: 8,
});

const DAY = 86_400_000;

/** The counters for one business, as app_private.email_protection_counts returns them. */
export interface ProtectionCounts {
  readonly workspaceId: string;
  readonly businessName?: string | null;
  readonly status: string;
  readonly mode: 'off' | 'test' | 'live';
  readonly state: ProtectionState;
  readonly reason: string | null;
  readonly since: string | null;
  readonly dailyCap: number;
  readonly hourlyCap: number;
  readonly warmupStartedAt: string | null;
  readonly goLiveApprovedAt: string | null;
  readonly warmupStep: number;
  readonly warmupStepAt: string | null;
  readonly countedSince: string | null;
  readonly sampleState: SampleState;
  readonly sampleStartedAt: string | null;
  readonly sampleFullAt: string | null;
  readonly ownerPausedAt: string | null;
  readonly ownPauses90: number;
  readonly sends7: number; readonly hard7: number; readonly soft7: number;
  readonly sends30: number; readonly complaints30: number; readonly unsubscribes30: number;
  readonly last50Sends: number; readonly hardLast50: number;
  readonly liveDay: number; readonly liveHour: number;
  readonly sampleSends: number; readonly sampleBounces: number; readonly sampleComplaints: number;
  readonly stepSends: number; readonly stepBounces: number; readonly stepComplaints: number;
}

export type TripLine = 'bounce_rate' | 'hard_last50' | 'complaints' | 'sample' | 'account_bounce' | 'account_complaint' | 'restarted';

/** What tripped, with the figures at that moment. Never an address. */
export interface Trip {
  readonly line: TripLine;
  readonly level: 'slowed' | 'paused' | 'held';
  /** For rates: the count and the total; for counts: the count. */
  readonly count: number;
  readonly total: number;
  /** Our limit at that level: a percent (rates), a number (counts), or per ten thousand (account complaints). */
  readonly limit: number;
  readonly days?: number;
  /** Only for the account trip-wire: the business's own share. */
  readonly own?: { readonly count: number; readonly total: number };
}

export const bounces7 = (c: Pick<ProtectionCounts, 'hard7' | 'soft7'>): number => c.hard7 + c.soft7;
/** n is at least pct percent of d, in whole numbers (no float rounding at the threshold). */
const atLeastPercent = (n: number, d: number, pct: number): boolean => d > 0 && n * 100 >= pct * d;
const belowPercent = (n: number, d: number, pct: number): boolean => n * 100 < pct * d;
const atLeastPerTenThousand = (n: number, d: number, per: number): boolean => d > 0 && n * 10_000 >= per * d;

/** The highest level a business's own numbers reach right now, and the line that put it there (strongest first). */
export function judge(c: ProtectionCounts): { readonly level: 'ok' | 'slowed' | 'paused'; readonly trip: Trip | null } {
  const b = bounces7(c), meaningful = c.sends7 >= LADDER.minSendsForRate;
  if (meaningful && atLeastPercent(b, c.sends7, LADDER.pausedBouncePercent))
    return { level: 'paused', trip: { line: 'bounce_rate', level: 'paused', count: b, total: c.sends7, limit: LADDER.pausedBouncePercent, days: LADDER.bounceWindowDays } };
  if (c.hardLast50 >= LADDER.pausedHardInLast50)
    return { level: 'paused', trip: { line: 'hard_last50', level: 'paused', count: c.hardLast50, total: c.last50Sends, limit: LADDER.pausedHardInLast50 } };
  if (c.complaints30 >= LADDER.pausedComplaints)
    return { level: 'paused', trip: { line: 'complaints', level: 'paused', count: c.complaints30, total: c.sends30, limit: LADDER.pausedComplaints, days: LADDER.complaintWindowDays } };
  if (meaningful && atLeastPercent(b, c.sends7, LADDER.slowedBouncePercent))
    return { level: 'slowed', trip: { line: 'bounce_rate', level: 'slowed', count: b, total: c.sends7, limit: LADDER.slowedBouncePercent, days: LADDER.bounceWindowDays } };
  if (c.complaints30 >= LADDER.slowedComplaints)
    return { level: 'slowed', trip: { line: 'complaints', level: 'slowed', count: c.complaints30, total: c.sends30, limit: LADDER.slowedComplaints, days: LADDER.complaintWindowDays } };
  return { level: 'ok', trip: null };
}

/** Whether a SLOWED business has earned its way back to ok (see the header). */
export function recovered(c: ProtectionCounts, now: number): boolean {
  const since = c.since ? Date.parse(c.since) : NaN;
  if (!Number.isFinite(since) || now - since < LADDER.recoverMinDays * DAY) return false;
  const b = bounces7(c);
  const clean = c.sends7 >= LADDER.minSendsForRate ? belowPercent(b, c.sends7, LADDER.recoverBouncePercent) : b === 0;
  return clean && c.complaints30 < LADDER.slowedComplaints;
}

/** The daily and hourly caps for a warm-up step and a state. Paused and off have no marketing allowance at all. */
export function caps(step: number, state: ProtectionState): { readonly daily: number; readonly hourly: number } {
  if (state === 'paused' || state === 'off') return { daily: 0, hourly: 0 };
  const base = RAMP[Math.max(0, Math.min(RAMP.length - 1, Math.trunc(step)))]!.daily;
  const daily = state === 'slowed' ? Math.max(1, Math.floor(base / 2)) : base;
  return { daily, hourly: Math.ceil(daily / 4) };
}

/** The next warm-up step (see the header): unchanged, earned (step + 1), or the same step started again. */
export function nextWarmupStep(c: Pick<ProtectionCounts, 'warmupStep' | 'warmupStepAt' | 'stepSends' | 'stepBounces' | 'stepComplaints' | 'state' | 'goLiveApprovedAt'>,
  now: number): { readonly step: number; readonly stepAt: string | null; readonly changed: boolean } {
  const step = Math.max(0, Math.min(RAMP.length - 1, c.warmupStep));
  const unchanged = { step, stepAt: c.warmupStepAt, changed: false };
  if (!c.goLiveApprovedAt || c.state !== 'ok' || step >= RAMP.length - 1) return unchanged;
  const at = c.warmupStepAt ? Date.parse(c.warmupStepAt) : NaN;
  if (!Number.isFinite(at)) return { step, stepAt: new Date(now).toISOString(), changed: true };
  if (now - at < RAMP[step]!.days! * DAY) return unchanged;
  const dirty = c.stepComplaints > 0 || atLeastPercent(c.stepBounces, c.stepSends, RAMP_STEP_BOUNCE_PERCENT);
  if (dirty) return { step, stepAt: new Date(now).toISOString(), changed: true };
  if (c.stepSends < 1) return unchanged;
  return { step: step + 1, stepAt: new Date(now).toISOString(), changed: true };
}

/** The sample's verdict: held (at once, on a breach), passed (2 hours after the 50th email), or still to come. */
export function sampleVerdict(c: Pick<ProtectionCounts, 'sampleState' | 'sampleFullAt' | 'sampleSends' | 'sampleBounces' | 'sampleComplaints'>, now: number):
  { readonly verdict: 'held' | 'passed' | null; readonly trip: Trip | null } {
  if (c.sampleState !== 'sending' && c.sampleState !== 'waiting') return { verdict: null, trip: null };
  const sent = Math.min(c.sampleSends, SAMPLE.size);
  if (c.sampleBounces >= SAMPLE.holdAtBounces || c.sampleComplaints >= SAMPLE.holdAtComplaints) {
    return { verdict: 'held', trip: { line: 'sample', level: 'held', count: c.sampleBounces, total: sent, limit: SAMPLE.holdAtBounces - 1, own: { count: c.sampleComplaints, total: sent } } };
  }
  const full = c.sampleFullAt ? Date.parse(c.sampleFullAt) : NaN;
  if (c.sampleState === 'waiting' && Number.isFinite(full) && now - full >= SAMPLE.waitHours * 3_600_000) return { verdict: 'passed', trip: null };
  return { verdict: null, trip: null };
}

/** One automatic step for one business, ready for app_private.email_protection_apply. null: nothing to store. */
export interface ProtectionDecision {
  readonly from: ProtectionState; readonly to: ProtectionState;
  readonly kind: 'slowed' | 'paused' | 'recovered' | 'sample_held' | 'sample_passed' | 'warmup_step' | null;
  readonly trip: Trip | null;
  readonly daily: number; readonly hourly: number;
  readonly step: number | null; readonly stepAt: string | null;
  readonly sample: 'held' | 'passed' | null;
}

/** The automatic decision for one business (the evaluator's whole judgement). Paused and off are never left here. */
export function decide(c: ProtectionCounts, now: number): ProtectionDecision | null {
  const from = c.state;
  if (from === 'off' || from === 'paused') {
    const zero = caps(0, from);
    return c.dailyCap !== zero.daily || c.hourlyCap !== zero.hourly ? { from, to: from, kind: null, trip: null, ...zero, step: null, stepAt: null, sample: null } : null;
  }
  const judged = judge(c);
  let to: ProtectionState = from, kind: ProtectionDecision['kind'] = null, trip: Trip | null = null;
  if (judged.level === 'paused') { to = 'paused'; kind = 'paused'; trip = judged.trip; }
  else if (from === 'ok' && judged.level === 'slowed') { to = 'slowed'; kind = 'slowed'; trip = judged.trip; }
  else if (from === 'slowed' && judged.level === 'ok' && recovered(c, now)) { to = 'ok'; kind = 'recovered'; }
  // The sample is judged only while the business stays sending.
  let sample: 'held' | 'passed' | null = null;
  if (to === 'ok' || to === 'slowed') {
    const verdict = sampleVerdict(c, now);
    if (verdict.verdict) { sample = verdict.verdict; if (!kind) { kind = verdict.verdict === 'held' ? 'sample_held' : 'sample_passed'; trip = verdict.trip; } }
  }
  const warm = to === 'ok' && from === 'ok' ? nextWarmupStep(c, now) : { step: c.warmupStep, stepAt: c.warmupStepAt, changed: false };
  if (warm.changed && !kind && warm.step !== c.warmupStep) kind = 'warmup_step';
  const capped = caps(warm.step, to);
  if (!kind && !warm.changed && !sample && capped.daily === c.dailyCap && capped.hourly === c.hourlyCap) return null;
  return { from, to, kind, trip, daily: capped.daily, hourly: capped.hourly, step: warm.changed ? warm.step : null, stepAt: warm.changed ? warm.stepAt : null, sample };
}

export interface AccountCounts { readonly state: 'ok' | 'held'; readonly sends7: number; readonly bounces7: number; readonly sends30: number; readonly complaints30: number }

/** The account trip-wire's decision: whether to hold every business, and which businesses to pause, worst first. */
export function accountDecision(account: AccountCounts, businesses: readonly ProtectionCounts[]): {
  readonly hold: Trip | null; readonly pause: readonly { readonly workspaceId: string; readonly trip: Trip }[] } {
  let hold: Trip | null = null;
  if (account.state === 'ok') {
    if (account.sends7 >= ACCOUNT.minSends && atLeastPercent(account.bounces7, account.sends7, ACCOUNT.holdBouncePercent))
      hold = { line: 'account_bounce', level: 'held', count: account.bounces7, total: account.sends7, limit: ACCOUNT.holdBouncePercent, days: 7 };
    else if (account.sends30 >= ACCOUNT.minSends && atLeastPerTenThousand(account.complaints30, account.sends30, ACCOUNT.holdComplaintsPerTenThousand))
      hold = { line: 'account_complaint', level: 'held', count: account.complaints30, total: account.sends30, limit: ACCOUNT.holdComplaintsPerTenThousand, days: 30 };
  }
  const sending = businesses.filter(b => b.state === 'ok' || b.state === 'slowed');
  const pause: { workspaceId: string; trip: Trip }[] = [];
  for (let guard = 0; guard < businesses.length && sending.length; guard++) {
    const s7 = sending.reduce((n, b) => n + b.sends7, 0), b7 = sending.reduce((n, b) => n + bounces7(b), 0);
    const s30 = sending.reduce((n, b) => n + b.sends30, 0), c30 = sending.reduce((n, b) => n + b.complaints30, 0);
    const bounceLine = s7 >= ACCOUNT.minSends && atLeastPercent(b7, s7, ACCOUNT.watchBouncePercent);
    const complaintLine = !bounceLine && s30 >= ACCOUNT.minSends && atLeastPerTenThousand(c30, s30, ACCOUNT.watchComplaintsPerTenThousand);
    if (!bounceLine && !complaintLine) break;
    const worst = [...sending].sort((x, y) => bounceLine
      ? bounces7(y) - bounces7(x) || bounces7(y) * x.sends7 - bounces7(x) * y.sends7 || x.workspaceId.localeCompare(y.workspaceId)
      : y.complaints30 - x.complaints30 || x.workspaceId.localeCompare(y.workspaceId))[0]!;
    pause.push({ workspaceId: worst.workspaceId, trip: bounceLine
      ? { line: 'account_bounce', level: 'paused', count: b7, total: s7, limit: ACCOUNT.watchBouncePercent, days: 7, own: { count: bounces7(worst), total: worst.sends7 } }
      : { line: 'account_complaint', level: 'paused', count: c30, total: s30, limit: ACCOUNT.watchComplaintsPerTenThousand, days: 30, own: { count: worst.complaints30, total: worst.sends30 } } });
    sending.splice(sending.indexOf(worst), 1);
  }
  return { hold, pause };
}

/** A percentage, rounded DOWN to one decimal place, so it never shows a number above the truth ("4.7%", "5%"). */
export function percent(count: number, total: number): string {
  if (total <= 0) return '0%';
  const tenths = Math.floor((count * 1000) / total);
  return tenths % 10 === 0 ? `${tenths / 10}%` : `${Math.floor(tenths / 10)}.${tenths % 10}%`;
}

/** The figures written to the protection log (no address, ever). */
export function tripNumbers(trip: Trip | null, c: ProtectionCounts): Record<string, number | string> {
  const out: Record<string, number | string> = { sends7: c.sends7, hard7: c.hard7, soft7: c.soft7, complaints30: c.complaints30, sends30: c.sends30,
    hardLast50: c.hardLast50, last50Sends: c.last50Sends, dailyCap: c.dailyCap, hourlyCap: c.hourlyCap };
  if (trip) {
    out.line = trip.line; out.count = trip.count; out.total = trip.total; out.limit = trip.limit;
    if (trip.days) out.days = trip.days;
    if (trip.own) { out.ownCount = trip.own.count; out.ownTotal = trip.own.total; }
  }
  return out;
}

/** Reads a trip back from logged numbers (for sentences written later: alerts, the founder's page). */
export function tripFromNumbers(numbers: Readonly<Record<string, unknown>> | null | undefined, level: Trip['level']): Trip | null {
  if (!numbers || typeof numbers.line !== 'string') return null;
  const n = (key: string) => typeof numbers[key] === 'number' && Number.isSafeInteger(numbers[key]) ? numbers[key] as number : 0;
  const line = numbers.line as TripLine;
  if (!['bounce_rate', 'hard_last50', 'complaints', 'sample', 'account_bounce', 'account_complaint'].includes(line)) return null;
  return { line, level, count: n('count'), total: n('total'), limit: n('limit'), ...(n('days') ? { days: n('days') } : {}),
    ...(typeof numbers.ownCount === 'number' ? { own: { count: n('ownCount'), total: n('ownTotal') } } : {}) };
}
