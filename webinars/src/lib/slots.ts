/**
 * Evergreen slot rules → concrete UTC start times.
 *
 *   fixed         { days: [2,4], times: ["19:00"] }            Tue + Thu 7pm in the rule's timezone
 *                 { dates: ["2026-11-10T19:00"] }               one-off local date-times
 *   interval      { every_minutes: 60, from: "09:00", to: "21:00", days?: [1,2,3,4,5] }
 *   just_in_time  { every_minutes: 15 }                         next boundary, i.e. always within 15 min
 *
 * Days use JS numbering: 0 = Sunday … 6 = Saturday.
 */

export type SlotRuleKind = 'fixed' | 'interval' | 'just_in_time';

export interface SlotRule {
  kind: SlotRuleKind;
  rule: {
    days?: number[];
    times?: string[];
    dates?: string[];
    every_minutes?: number;
    from?: string;
    to?: string;
  };
  timezone: string;
}

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0-6
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(ms: number, tz: string): ZonedParts & { second: number } {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday ?? 'Sun'] ?? 0,
  };
}

/** Offset (ms) of tz from UTC at the given instant. */
function tzOffset(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Local wall-clock time in tz → UTC ms. Non-existent DST times roll forward. */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ms = guess - tzOffset(guess, tz);
  const off2 = tzOffset(ms, tz);
  if (guess - off2 !== ms) ms = guess - off2;
  return ms;
}

function parseHm(s: string | undefined, fallback: [number, number]): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? '');
  if (!m) return fallback;
  return [Math.min(23, Number(m[1])), Math.min(59, Number(m[2]))];
}

/** Iterate local calendar days in tz starting at the day containing fromMs. */
function* localDays(fromMs: number, tz: string, days: number) {
  const start = zonedParts(fromMs, tz);
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    yield { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() };
  }
}

function slotsForRule(r: SlotRule, fromMs: number, untilMs: number): number[] {
  const out: number[] = [];
  const dated: number[] = [];
  const tz = r.timezone || 'UTC';
  const horizonDays = Math.ceil((untilMs - fromMs) / 86_400_000) + 2;

  if (r.kind === 'just_in_time') {
    const every = Math.max(5, Math.min(60, r.rule.every_minutes ?? 15)) * 60_000;
    let t = Math.ceil(fromMs / every) * every;
    // "next slot within N min": offer the next two boundaries.
    for (let i = 0; i < 2 && t <= untilMs; i++, t += every) out.push(t);
    return out;
  }

  if (r.kind === 'fixed') {
    // One-off dates aren't limited by the recurring horizon (up to a year ahead).
    for (const d of r.rule.dates ?? []) {
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(d);
      if (!m) continue;
      const t = zonedToUtc(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, tz);
      if (t >= fromMs && t <= fromMs + 366 * 86_400_000) dated.push(t);
    }
    if (r.rule.times?.length) {
      const days = r.rule.days?.length ? new Set(r.rule.days) : null;
      for (const day of localDays(fromMs, tz, horizonDays)) {
        if (days && !days.has(day.weekday)) continue;
        for (const t of r.rule.times) {
          const [h, mi] = parseHm(t, [19, 0]);
          out.push(zonedToUtc(day.year, day.month, day.day, h, mi, tz));
        }
      }
    }
  }

  if (r.kind === 'interval') {
    const every = Math.max(5, r.rule.every_minutes ?? 60);
    const [fh, fm] = parseHm(r.rule.from, [0, 0]);
    const [th, tm] = parseHm(r.rule.to, [23, 59]);
    const days = r.rule.days?.length ? new Set(r.rule.days) : null;
    for (const day of localDays(fromMs, tz, horizonDays)) {
      if (days && !days.has(day.weekday)) continue;
      for (let mins = fh * 60 + fm; mins <= th * 60 + tm; mins += every) {
        out.push(zonedToUtc(day.year, day.month, day.day, Math.floor(mins / 60), mins % 60, tz));
      }
    }
  }

  return [...out.filter((t) => t >= fromMs && t <= untilMs), ...dated];
}

/** Next `count` slot start times (ISO, UTC) across all active rules. */
export function upcomingSlots(rules: SlotRule[], fromMs: number, count = 6, horizonDays = 14): string[] {
  const until = fromMs + horizonDays * 86_400_000;
  const all = new Set<number>();
  for (const r of rules) for (const t of slotsForRule(r, fromMs, until)) all.add(t);
  return [...all].sort((a, b) => a - b).slice(0, count).map((t) => new Date(t).toISOString());
}

/** True if `iso` is a slot one of the rules would generate (allows registering for the slot in progress). */
export function isRuleSlot(rules: SlotRule[], iso: string, nowMs: number, graceMs = 0): boolean {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t < nowMs - graceMs) return false;
  const near = upcomingSlots(rules, t - 60_000, 50, 1);
  return near.includes(new Date(t).toISOString());
}
