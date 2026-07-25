/**
 * Turn an S8 pack (30 dated social posts) into a concrete posting schedule:
 * day N → startDate + (N-1) days at a fixed local time, with hook+body+cta
 * composed into the text the network receives. Pure + deterministic given its
 * inputs — no clock reads — so a run is reproducible.
 */

import type { PlannedPost } from './types.js';

export interface S8Post {
  day: number;
  platform: string;
  format: string;
  hook: string;
  body: string;
  cta: string;
  pillar: string;
}

export interface S8Output {
  platform_a: string;
  platform_b: string;
  posts: S8Post[];
}

/** hook + body + cta as one post body. */
export function composePost(p: S8Post): string {
  return [p.hook, p.body, p.cta].map((s) => (s ?? '').trim()).filter(Boolean).join('\n\n');
}

export interface ScheduleOpts {
  /** ISO date (YYYY-MM-DD) that day 1 posts on. */
  startDate: string;
  /** 24h "HH:MM" local send time (default 09:00). */
  time?: string;
  /** Only include these S8 platform names (case-insensitive). Empty = all. */
  platforms?: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function buildSchedule(s8: S8Output, opts: ScheduleOpts): PlannedPost[] {
  const [hh, mm] = (opts.time ?? '09:00').split(':').map((n) => Number(n));
  const base = new Date(`${opts.startDate}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) throw new Error(`Invalid --schedule start date: "${opts.startDate}" (expected YYYY-MM-DD)`);
  const filter = (opts.platforms ?? []).map((p) => p.trim().toLowerCase());

  return s8.posts
    .filter((p) => filter.length === 0 || filter.includes(p.platform.trim().toLowerCase()))
    .map((p) => {
      const when = new Date(base.getTime() + (p.day - 1) * DAY_MS);
      when.setUTCHours(hh || 0, mm || 0, 0, 0);
      return {
        day: p.day,
        platform: p.platform,
        format: p.format,
        pillar: p.pillar,
        text: composePost(p),
        scheduleDate: when.toISOString(),
      };
    });
}
