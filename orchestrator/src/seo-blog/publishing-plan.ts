/**
 * Where and when "Approve and publish" puts an article: one set of rules, used by the article page to show the
 * website and the time before the owner presses, and by the engine to check the press against what was shown.
 */

import { autoPlace, localToUtc, utcToLocal } from './schedule.js';
import { SeoBlogError, type Article, type Brand, type Destination } from './types.js';

type Site = Pick<Destination, 'id' | 'label' | 'status'>;

/**
 * The website an article goes to. A website the owner chose must be one of this business's connected websites:
 * it is refused, never swapped for another. Without a choice: the website of the time already set (past or future), then the
 * website in the approved editorial guidance, then the only (or first) connected website.
 */
export function publishingSite<T extends Site>(article: Pick<Article, 'schedule'>, brand: Pick<Brand, 'settings'>, destinations: readonly T[], now: string, requested?: string | null): T | null {
  const connected = destinations.filter((d) => d.status === 'connected');
  if (requested) {
    const chosen = connected.find((d) => d.id === requested);
    if (!chosen) throw new SeoBlogError(409, 'That website is not connected any more, so nothing was approved or scheduled. Check the connection in Brand setup, or choose another website.', 'destination');
    return chosen;
  }
  void now;
  return connected.find((d) => d.id === article.schedule?.destinationId)
    ?? connected.find((d) => d.id === brand.settings.programme?.structure?.destinationId)
    ?? connected[0] ?? null;
}

export interface PlannedSlot { readonly localDate: string; readonly localTime: string; readonly publishAtUtc: string; readonly kept: boolean }

/** The time "Approve and publish" uses: a future time already set on the same website, else the next free publishing day. */
export function nextPublishingSlot(article: Pick<Article, 'id' | 'schedule'>, brand: Pick<Brand, 'settings' | 'timezone'>, others: readonly Pick<Article, 'id' | 'schedule'>[], siteId: string, now: string): PlannedSlot | null {
  const s = article.schedule;
  if (s && Date.parse(s.publishAtUtc) > Date.parse(now) && s.destinationId === siteId) return { localDate: s.localDate, localTime: s.localTime, publishAtUtc: s.publishAtUtc, kept: true };
  const placed = autoPlace({ items: [{ id: article.id, role: 'supporting' }], occupiedLocalDates: others.filter((a) => a.id !== article.id && a.schedule).map((a) => a.schedule!.localDate),
    cadence: brand.settings.cadence, timeZone: brand.timezone, now, horizonDays: 366 }).placed[0];
  return placed ? { localDate: placed.localDate, localTime: placed.localTime, publishAtUtc: placed.utc, kept: false } : null;
}

/** A time a minute or two from now that really is in the future in the business's time zone (clock changes included). */
export function soonSlot(now: string, timezone: string): PlannedSlot {
  const start = Math.ceil((Date.parse(now) + 120_000) / 60_000) * 60_000;
  for (let minutes = 0; minutes < 180; minutes++) {
    const local = utcToLocal(new Date(start + minutes * 60_000).toISOString(), timezone);
    const back = localToUtc(local.date, local.time, timezone);
    if (Date.parse(back.utc) > Date.parse(now) + 60_000) return { localDate: local.date, localTime: back.localTime, publishAtUtc: back.utc, kept: false };
  }
  throw new SeoBlogError(409, 'We could not find a safe time in the next few hours. Choose a time with “Publish later”.');
}

/** A date and time the owner typed, checked exactly as scheduling will check it, before anything is written. */
export function ownSlot(localDate: string, localTime: string, timezone: string, now: string): PlannedSlot {
  if (!localDate || !localTime) throw new SeoBlogError(400, 'Choose a day and a time.');
  const conversion = localToUtc(localDate, localTime, timezone);
  if (Date.parse(conversion.utc) <= Date.parse(now) + 60_000) throw new SeoBlogError(400, 'Choose a time in the future. Missed times are never published late.');
  return { localDate, localTime: conversion.localTime, publishAtUtc: conversion.utc, kept: false };
}
