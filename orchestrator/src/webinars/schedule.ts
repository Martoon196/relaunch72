/**
 * Server-side time rules. Start times are persisted in UTC; the brand timezone is
 * used only to interpret what the owner typed and to label times. Refreshing or
 * switching device cannot change a countdown because every state is computed from
 * the stored start time and the server clock.
 */

import type { WebinarEvent } from './types.js';

const fmtCache = new Map<string, Intl.DateTimeFormat>();

export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length < 1 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parts(ms: number, tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return { y: out.year!, mo: out.month!, d: out.day!, h: (out.hour ?? 0) % 24, mi: out.minute!, s: out.second! };
}

function offsetMs(ms: number, tz: string): number {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * Wall-clock time in a timezone → UTC. A time inside a spring-forward gap rolls
 * forward to the first valid instant; an ambiguous autumn time takes the first
 * (summer-time) occurrence.
 */
export function zonedToUtc(local: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m || !isValidTimezone(tz)) return null;
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offsetMs(guess - 12 * 3600_000, tz);
  const second = guess - offsetMs(guess + 12 * 3600_000, tz);
  // Prefer the candidate that formats back to the requested wall time.
  for (const candidate of [first, second]) {
    const p = parts(candidate, tz);
    if (p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi) return new Date(candidate);
  }
  // Non-existent local time (DST gap): the later offset maps it past the gap.
  return new Date(Math.max(first, second));
}

/** UTC → value for <input type="datetime-local"> in the brand timezone. */
export function utcToLocalInput(isoString: string | null, tz: string): string {
  if (!isoString || !isValidTimezone(tz)) return '';
  const p = parts(Date.parse(isoString), tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

export function formatInZone(isoString: string, tz: string, locale = 'en-GB'): string {
  const zone = isValidTimezone(tz) ? tz : 'UTC';
  return new Intl.DateTimeFormat(locale, { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(isoString));
}

// ── Room state machine ───────────────────────────────────────────────────────

export type RoomStateName =
  | 'cancelled'
  | 'unavailable'      // provider not configured or no playable media
  | 'not_started'      // before the room opens
  | 'waiting'          // room open, host not broadcasting yet
  | 'host_connecting'  // host's encoder is connected but the session isn't open (rehearsal)
  | 'live'
  | 'interrupted'      // session open, broadcast dropped
  | 'scheduled_playing'// scheduled presentation of a recording, playhead locked to the clock
  | 'ended'            // finished, no replay (disabled, failed or not recorded)
  | 'processing'       // finished, recording still processing
  | 'replay'
  | 'replay_expired'
  | 'on_demand';

export interface RoomState {
  readonly state: RoomStateName;
  /** Honest label for attendees, e.g. never "Live" for a recording. */
  readonly label: string;
  readonly message: string;
  /** Stream uid to play, when there is something to play. */
  readonly playUid: string | null;
  readonly playMode: 'live' | 'scheduled_recording' | 'replay' | 'on_demand' | null;
  readonly seekable: boolean;
  /** Scheduled recordings: seconds since the scheduled start. */
  readonly offsetSeconds: number | null;
  readonly opensAt: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly replayUntil: string | null;
}

export interface RoomInputs {
  readonly event: WebinarEvent;
  readonly nowMs: number;
  /** False when Cloudflare Stream is not configured on this deployment. */
  readonly providerConfigured: boolean;
}

function addMinutes(isoString: string, minutes: number): string {
  return new Date(Date.parse(isoString) + minutes * 60_000).toISOString();
}

export function computeRoomState({ event: e, nowMs, providerConfigured }: RoomInputs): RoomState {
  const base = { playUid: null, playMode: null, seekable: false, offsetSeconds: null, opensAt: null, startsAt: e.startsAt, endsAt: null, replayUntil: null } as const;
  const opensAt = e.startsAt ? addMinutes(e.startsAt, -e.settings.roomOpensMinutesBefore) : null;
  const plannedEnd = e.startsAt ? addMinutes(e.startsAt, e.durationMinutes) : null;
  const s = (state: RoomStateName, label: string, message: string, extra: Partial<RoomState> = {}): RoomState =>
    Object.freeze({ ...base, opensAt, endsAt: plannedEnd, state, label, message, ...extra });

  if (e.status === 'cancelled') return s('cancelled', 'Cancelled', 'This webinar has been cancelled.');
  if (!providerConfigured) return s('unavailable', 'Unavailable', 'Video is temporarily unavailable. Please try again later.');

  const replayWindow = (endedIso: string | null): string | null =>
    endedIso && e.settings.replay.availableDays !== null ? addMinutes(endedIso, e.settings.replay.availableDays * 1440) : null;

  if (e.kind === 'on_demand') {
    if (e.videoState === 'ready' && e.videoUid) {
      return s('on_demand', 'On-demand recording', 'Watch at your own pace.', { playUid: e.videoUid, playMode: 'on_demand', seekable: true, startsAt: null, endsAt: null, opensAt: null });
    }
    if (e.videoState === 'processing' || e.videoState === 'awaiting_upload') return s('unavailable', 'Preparing', 'This recording is being prepared. Please check back shortly.');
    return s('unavailable', 'Unavailable', 'This recording is not available yet.');
  }

  if (!e.startsAt || !opensAt || !plannedEnd) return s('unavailable', 'Unavailable', 'This webinar has no start time yet.');
  const start = Date.parse(e.startsAt);
  const opens = Date.parse(opensAt);

  if (e.kind === 'scheduled_recording') {
    const lengthSeconds = e.videoDurationSeconds ?? e.durationMinutes * 60;
    const end = start + lengthSeconds * 1000;
    const endIso = new Date(end).toISOString();
    if (e.videoState !== 'ready' || !e.videoUid) return s('unavailable', 'Preparing', 'The recording for this session is not ready yet.');
    if (nowMs < opens) return s('not_started', 'Scheduled presentation of a recording', 'This is a recorded presentation shown at a set time.', { endsAt: endIso });
    if (nowMs < start) return s('waiting', 'Scheduled presentation of a recording', 'The recorded presentation starts shortly.', { endsAt: endIso });
    if (nowMs < end) {
      return s('scheduled_playing', 'Scheduled presentation of a recording', 'You are watching a recording shown at a scheduled time.',
        { playUid: e.videoUid, playMode: 'scheduled_recording', seekable: false, offsetSeconds: Math.floor((nowMs - start) / 1000), endsAt: endIso });
    }
    const until = replayWindow(endIso);
    if (!e.settings.replay.enabled) return s('ended', 'Ended', 'This session has finished.', { endsAt: endIso });
    if (until && nowMs > Date.parse(until)) return s('replay_expired', 'Replay ended', 'The replay is no longer available.', { endsAt: endIso, replayUntil: until });
    return s('replay', 'Replay', 'Watch the replay.', { playUid: e.videoUid, playMode: 'replay', seekable: true, endsAt: endIso, replayUntil: until });
  }

  // Live webinar.
  if (e.sessionState === 'ended') {
    const endedIso = e.sessionEndedAt ?? plannedEnd;
    if (!e.settings.replay.enabled) return s('ended', 'Ended', 'This webinar has finished. Thank you for joining.');
    if (e.recordingState === 'ready' && e.recordingUid) {
      const until = replayWindow(endedIso);
      if (until && nowMs > Date.parse(until)) return s('replay_expired', 'Replay ended', 'The replay is no longer available.', { replayUntil: until });
      return s('replay', 'Replay', 'Watch the replay of the live session.', { playUid: e.recordingUid, playMode: 'replay', seekable: true, replayUntil: until });
    }
    if (e.recordingState === 'failed' || e.recordingState === 'not_recorded') {
      return s('ended', 'Ended', 'This webinar has finished. A replay is not available for this session.');
    }
    return s('processing', 'Replay processing', 'The webinar has finished. The replay is being processed and will appear here.');
  }
  if (e.sessionState === 'live') {
    if (e.liveState === 'connected' && e.liveInputUid) {
      return s('live', 'Live', 'The webinar is live.', { playUid: e.liveInputUid, playMode: 'live', seekable: false });
    }
    return s('interrupted', 'Live · reconnecting', 'The presenter’s connection dropped. Stay on this page; the broadcast resumes automatically.');
  }
  // Scheduled: the host has not opened the session.
  if (nowMs < opens) return s('not_started', 'Live webinar', 'The room opens shortly before the start time.');
  if (nowMs > Date.parse(plannedEnd) + 3 * 3600_000) return s('ended', 'Ended', 'This webinar did not go ahead as scheduled.');
  if (e.liveState === 'connected') return s('host_connecting', 'Live webinar', 'The host is getting ready. The broadcast starts shortly.');
  return s('waiting', 'Live webinar', 'The room is open. The host will start shortly.');
}
