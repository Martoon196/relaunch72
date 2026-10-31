/**
 * Diary time handling. Schedules are entered and displayed as local wall-clock
 * time in the brand's IANA timezone and stored as an exact UTC instant beside
 * that local intent, so a daylight-saving change never moves a post silently.
 */

import type { BrandCadence, IsoInstant } from './types.js';
import { SeoBlogError } from './types.js';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || timeZone.length < 1 || timeZone.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function parts(epochMs: number, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(epochMs))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { y: out.year!, mo: out.month!, d: out.day!, h: out.hour!, mi: out.minute!, s: out.second! };
}

/** Offset of `timeZone` from UTC at the instant `epochMs`, in milliseconds. */
export function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const p = parts(epochMs, timeZone);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

export function validLocalDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

export function validLocalTime(value: string): boolean {
  return TIME.test(value);
}

export interface LocalToUtcResult {
  readonly utc: IsoInstant;
  /** The wall-clock time actually used (differs only inside a spring-forward gap). */
  readonly localTime: string;
  readonly adjusted: 'none' | 'gap_shifted_forward' | 'ambiguous_first_occurrence';
}

/**
 * Convert a local wall-clock date/time to UTC. Inside a spring-forward gap the
 * time moves forward by the gap; inside an autumn repeat the first occurrence
 * (the earlier, summer-time instant) is used. Both are reported, never hidden.
 */
export function localToUtc(localDate: string, localTime: string, timeZone: string): LocalToUtcResult {
  if (!validLocalDate(localDate)) throw new SeoBlogError(400, 'Choose a real calendar date.');
  if (!validLocalTime(localTime)) throw new SeoBlogError(400, 'Choose a time as HH:MM.');
  if (!isValidTimeZone(timeZone)) throw new SeoBlogError(400, 'The brand timezone is not recognised.');
  const [y, mo, d] = localDate.split('-').map(Number) as [number, number, number];
  const [h, mi] = localTime.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  // Candidate offsets: those in force a day either side cover every real transition.
  const offsets = [...new Set([zoneOffsetMs(wall - 86_400_000, timeZone), zoneOffsetMs(wall, timeZone), zoneOffsetMs(wall + 86_400_000, timeZone)])];
  const matches = offsets
    .map((offset) => wall - offset)
    .filter((instant) => {
      const p = parts(instant, timeZone);
      return p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi;
    })
    .sort((a, b) => a - b);
  if (matches.length >= 1) {
    const unique = [...new Set(matches)];
    return {
      utc: new Date(unique[0]!).toISOString(),
      localTime,
      adjusted: unique.length > 1 ? 'ambiguous_first_occurrence' : 'none',
    };
  }
  // Non-existent local time: use the pre-transition offset, which lands after the gap.
  const before = zoneOffsetMs(wall - 86_400_000, timeZone);
  const instant = wall - before;
  const actual = utcToLocal(new Date(instant).toISOString(), timeZone);
  return { utc: new Date(instant).toISOString(), localTime: actual.time, adjusted: 'gap_shifted_forward' };
}

export function utcToLocal(utc: IsoInstant, timeZone: string): { date: string; time: string; weekday: number } {
  const ms = Date.parse(utc);
  if (!Number.isFinite(ms)) throw new SeoBlogError(400, 'Invalid instant.');
  const p = parts(ms, timeZone);
  const date = `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  const time = `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
  const weekday = ((new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay() + 6) % 7) + 1;
  return { date, time, weekday };
}

export function addDays(localDate: string, days: number): string {
  const [y, mo, d] = localDate.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, mo - 1, d + days));
  return t.toISOString().slice(0, 10);
}

function isoWeekKey(localDate: string): string {
  const [y, mo, d] = localDate.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, mo - 1, d));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${week}`;
}

export function validateCadence(cadence: BrandCadence): void {
  if (!Array.isArray(cadence.weekdays) || cadence.weekdays.length < 1 || cadence.weekdays.length > 7
      || cadence.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)
      || new Set(cadence.weekdays).size !== cadence.weekdays.length) {
    throw new SeoBlogError(400, 'Choose at least one publishing weekday.');
  }
  if (!validLocalTime(cadence.localTime)) throw new SeoBlogError(400, 'Choose a publishing time as HH:MM.');
  if (!Number.isInteger(cadence.perWeek) || cadence.perWeek < 1 || cadence.perWeek > 14) {
    throw new SeoBlogError(400, 'Posts per week must be between 1 and 14.');
  }
}

export interface PlacementItem {
  readonly id: string;
  readonly role: 'pillar' | 'supporting';
  /** Items that must be placed strictly earlier (e.g. the pillar). */
  readonly after?: readonly string[];
}

export interface Placement {
  readonly id: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly utc: IsoInstant;
}

/**
 * Balanced automatic placement: walks forward from tomorrow (brand-local),
 * using only cadence weekdays, at most one post per day and `perWeek` per ISO
 * week, never on a day already occupied, and always after declared
 * dependencies. Items that do not fit inside the horizon stay unscheduled.
 */
export function autoPlace(input: {
  readonly items: readonly PlacementItem[];
  readonly occupiedLocalDates: readonly string[];
  readonly cadence: BrandCadence;
  readonly timeZone: string;
  readonly now: IsoInstant;
  readonly horizonDays: number;
}): { placed: Placement[]; unplaced: string[] } {
  validateCadence(input.cadence);
  const ordered = [...input.items].sort((a, b) => (a.role === b.role ? 0 : a.role === 'pillar' ? -1 : 1));
  const occupied = new Set(input.occupiedLocalDates);
  const perWeek = new Map<string, number>();
  for (const date of occupied) perWeek.set(isoWeekKey(date), (perWeek.get(isoWeekKey(date)) ?? 0) + 1);
  const today = utcToLocal(input.now, input.timeZone).date;
  const placedAt = new Map<string, string>();
  const placed: Placement[] = [];
  const unplaced: string[] = [];
  let cursor = addDays(today, 1);
  const last = addDays(today, Math.max(1, Math.min(input.horizonDays, 366)));
  for (const item of ordered) {
    const deps = (item.after ?? []).map((id) => placedAt.get(id)).filter((d): d is string => Boolean(d));
    let candidate = cursor;
    for (const dep of deps) if (dep >= candidate) candidate = addDays(dep, 1);
    let found: string | null = null;
    while (candidate <= last) {
      const local = utcToLocal(localToUtc(candidate, '12:00', input.timeZone).utc, input.timeZone);
      const week = isoWeekKey(candidate);
      if (input.cadence.weekdays.includes(local.weekday) && !occupied.has(candidate)
          && (perWeek.get(week) ?? 0) < input.cadence.perWeek) {
        found = candidate;
        break;
      }
      candidate = addDays(candidate, 1);
    }
    if (!found || (item.after ?? []).some((id) => !placedAt.has(id) && input.items.some((i) => i.id === id))) {
      unplaced.push(item.id);
      continue;
    }
    const conversion = localToUtc(found, input.cadence.localTime, input.timeZone);
    occupied.add(found);
    perWeek.set(isoWeekKey(found), (perWeek.get(isoWeekKey(found)) ?? 0) + 1);
    placedAt.set(item.id, found);
    placed.push({ id: item.id, localDate: found, localTime: conversion.localTime, utc: conversion.utc });
    cursor = found;
  }
  return { placed, unplaced };
}
