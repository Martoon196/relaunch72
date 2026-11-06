/** Rows, lookups and the session lifecycle shared by the API, the Durable Object and cron. */
import type { Env, Mode } from '../env.js';
import type { Services } from '../services.js';
import { resolveConfig, type BrandRow, type ResolvedConfig } from './config.js';
import { emitEvent } from './events.js';
import { upcomingSlots, type SlotRule } from './slots.js';
import { newId, nowIso, parseJson } from './util.js';

export type WebinarType = 'live' | 'on_demand' | 'evergreen';

export interface WebinarRow {
  id: string;
  brand_id: string;
  mode: Mode;
  type: WebinarType;
  slug: string;
  title: string;
  description: string;
  presenters_json: string;
  agenda_json: string;
  handouts_json: string;
  stream_live_input_id: string | null;
  video_uid: string | null;
  duration_s: number | null;
  status: 'draft' | 'published' | 'archived';
  overrides_json: string;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  webinar_id: string;
  starts_at: string | null;
  ends_at: string | null;
  kind: 'live' | 'evergreen' | 'on_demand';
  status: 'scheduled' | 'live' | 'ended';
  test_mode: number;
  recording_uid: string | null;
  started_at: string | null;
  ended_at: string | null;
  finalized_at: string | null;
  created_at: string;
}

export interface RegistrantRow {
  id: string;
  brand_id: string;
  mode: Mode;
  webinar_id: string;
  session_id: string | null;
  email: string;
  name: string;
  phone: string | null;
  answers_json: string;
  consent_json: string;
  utm_json: string;
  source_url: string | null;
  token_hash: string;
  access_expires_at: string | null;
  banned: number;
  ghq_contact_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CtaRow {
  id: string;
  webinar_id: string;
  label: string;
  url: string;
  style: 'button' | 'card';
  body: string | null;
  image_url: string | null;
  show_at_s: number | null;
  hide_at_s: number | null;
  push_mode: 'timed' | 'manual';
}

export interface PollRow {
  id: string;
  webinar_id: string;
  question: string;
  options_json: string;
  show_at_s: number | null;
  crm_field: string | null;
}

export const publicCta = (c: CtaRow) => ({ id: c.id, label: c.label, url: c.url, style: c.style, body: c.body, image_url: c.image_url, show_at_s: c.show_at_s, hide_at_s: c.hide_at_s, push_mode: c.push_mode });
export const publicPoll = (p: PollRow) => ({ id: p.id, question: p.question, options: parseJson<string[]>(p.options_json, []), show_at_s: p.show_at_s });

export async function getBrand(db: D1Database, id: string) {
  return db.prepare('SELECT * FROM brands WHERE id = ?').bind(id).first<BrandRow>();
}

export async function getWebinar(db: D1Database, id: string) {
  return db.prepare('SELECT * FROM webinars WHERE id = ?').bind(id).first<WebinarRow>();
}

export async function getSession(db: D1Database, id: string) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first<SessionRow>();
}

export async function webinarConfig(db: D1Database, webinar: WebinarRow): Promise<{ brand: BrandRow; cfg: ResolvedConfig }> {
  const brand = await getBrand(db, webinar.brand_id);
  if (!brand) throw new Error('brand missing');
  return { brand, cfg: resolveConfig(brand, webinar.overrides_json) };
}

export async function activeSlotRules(db: D1Database, webinarId: string): Promise<SlotRule[]> {
  const rows = await db.prepare('SELECT kind, rule_json, timezone FROM slot_rules WHERE webinar_id = ? AND active = 1').bind(webinarId).all<{ kind: SlotRule['kind']; rule_json: string; timezone: string }>();
  return (rows.results ?? []).map((r) => ({ kind: r.kind, rule: parseJson(r.rule_json, {}), timezone: r.timezone }));
}

export async function nextSlots(db: D1Database, webinarId: string, nowMs: number, count = 6) {
  return upcomingSlots(await activeSlotRules(db, webinarId), nowMs, count);
}

/** Session row for an evergreen slot, created on first registration. */
export async function getOrCreateSlotSession(db: D1Database, webinar: WebinarRow, startsAtIso: string, nowMs: number): Promise<SessionRow> {
  const startsAt = new Date(startsAtIso).toISOString();
  const endsAt = new Date(Date.parse(startsAt) + (webinar.duration_s ?? 3600) * 1000).toISOString();
  await db.prepare('INSERT INTO sessions (id, webinar_id, starts_at, ends_at, kind, status, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT (webinar_id, kind, starts_at) DO NOTHING')
    .bind(newId('ses'), webinar.id, startsAt, endsAt, 'evergreen', 'scheduled', nowIso(nowMs)).run();
  const row = await db.prepare("SELECT * FROM sessions WHERE webinar_id = ? AND kind = 'evergreen' AND starts_at = ?").bind(webinar.id, startsAt).first<SessionRow>();
  if (!row) throw new Error('slot session missing');
  return row;
}

/** The single perpetual session used for on-demand viewing and post-event replays. */
export async function getOrCreateOnDemandSession(db: D1Database, webinarId: string, nowMs: number): Promise<SessionRow> {
  // starts_at is a fixed sentinel so the UNIQUE constraint makes this idempotent.
  await db.prepare("INSERT INTO sessions (id, webinar_id, starts_at, kind, status, created_at) VALUES (?,?,'1970-01-01T00:00:00.000Z','on_demand','live',?) ON CONFLICT (webinar_id, kind, starts_at) DO NOTHING")
    .bind(newId('ses'), webinarId, nowIso(nowMs)).run();
  const row = await db.prepare("SELECT * FROM sessions WHERE webinar_id = ? AND kind = 'on_demand'").bind(webinarId).first<SessionRow>();
  if (!row) throw new Error('on-demand session missing');
  return row;
}

// ---------- room state ----------

export type RoomStateName = 'scheduled' | 'waiting' | 'live' | 'replay' | 'on_demand' | 'ended' | 'expired' | 'processing';

export interface RoomState {
  state: RoomStateName;
  /** Human label. Evergreen is always "scheduled replay", never "live" (FCA financial-promotion rules). */
  label: string;
  opens_at: string | null;
  starts_at: string | null;
  ends_at: string | null;
  video_uid: string | null;
  live: boolean;
  /** Evergreen: playhead = now − slot start; the player must not allow seeking. */
  offset_s: number | null;
  seekable: boolean;
  /** Which session attendance should be recorded against (the replay session after a live event). */
  attendance_session_id: string | null;
  access_expires_at: string | null;
}

export function replayExpiry(registrant: Pick<RegistrantRow, 'access_expires_at'>, endedAt: string | null, cfg: ResolvedConfig): string | null {
  if (registrant.access_expires_at) return registrant.access_expires_at;
  const days = cfg.settings.defaults.replay_expiry_days;
  if (!days || !endedAt) return null;
  return new Date(Date.parse(endedAt) + days * 86_400_000).toISOString();
}

export function computeRoomState(
  webinar: WebinarRow,
  session: SessionRow,
  registrant: Pick<RegistrantRow, 'access_expires_at'>,
  cfg: ResolvedConfig,
  replaySessionId: string | null,
  nowMs: number,
): RoomState {
  const opensMin = cfg.settings.defaults.room_opens_min_before;
  const startMs = session.starts_at ? Date.parse(session.starts_at) : null;
  const opensAt = startMs !== null ? new Date(startMs - opensMin * 60_000).toISOString() : null;
  const base = {
    opens_at: opensAt,
    starts_at: session.starts_at,
    ends_at: session.ends_at,
    video_uid: null as string | null,
    live: false,
    offset_s: null as number | null,
    seekable: false,
    attendance_session_id: null as string | null,
    access_expires_at: null as string | null,
  };
  const before = (): RoomState => {
    const waiting = startMs !== null && nowMs >= startMs - opensMin * 60_000;
    return { ...base, state: waiting ? 'waiting' : 'scheduled', label: webinar.type === 'evergreen' ? 'Scheduled replay' : 'Live webinar' };
  };
  const replay = (endedAt: string | null): RoomState => {
    const uid = session.recording_uid ?? webinar.video_uid;
    const expires = replayExpiry(registrant, endedAt, cfg);
    if (expires && nowMs > Date.parse(expires)) return { ...base, state: 'expired', label: 'Replay', access_expires_at: expires };
    if (!uid) return { ...base, state: 'ended', label: 'Ended' };
    return { ...base, state: 'replay', label: 'Replay', video_uid: uid, seekable: true, attendance_session_id: replaySessionId, access_expires_at: expires };
  };

  if (webinar.type === 'on_demand') {
    const expires = replayExpiry(registrant, null, cfg);
    if (expires && nowMs > Date.parse(expires)) return { ...base, state: 'expired', label: 'On demand', access_expires_at: expires };
    if (!webinar.video_uid) return { ...base, state: 'processing', label: 'On demand' };
    return { ...base, state: 'on_demand', label: 'On demand', video_uid: webinar.video_uid, seekable: true, attendance_session_id: session.id, access_expires_at: expires };
  }

  if (webinar.type === 'live') {
    if (session.status === 'ended') return replay(session.ended_at ?? session.ends_at);
    if (session.status === 'live' && !session.test_mode) {
      return { ...base, state: 'live', label: 'Live', video_uid: webinar.stream_live_input_id, live: true, attendance_session_id: session.id };
    }
    return before();
  }

  // evergreen
  if (startMs === null) return before();
  const endMs = startMs + (webinar.duration_s ?? 3600) * 1000;
  if (nowMs < startMs) return before();
  if (nowMs < endMs) {
    return {
      ...base,
      state: 'live',
      label: 'Scheduled replay',
      video_uid: webinar.video_uid,
      offset_s: Math.floor((nowMs - startMs) / 1000),
      attendance_session_id: session.id,
    };
  }
  return replay(new Date(endMs).toISOString());
}

// ---------- lifecycle ----------

export async function roomControl(env: Pick<Env, 'SESSION_ROOM'>, sessionId: string, body: Record<string, unknown>): Promise<void> {
  try {
    const stub = env.SESSION_ROOM.get(env.SESSION_ROOM.idFromName(sessionId));
    await stub.fetch('https://room/control', { method: 'POST', body: JSON.stringify(body) });
  } catch (err) {
    console.error('room control failed', sessionId, err);
  }
}

export async function startSession(env: Env, session: SessionRow, webinar: WebinarRow, opts: { test: boolean }, nowMs: number) {
  const ts = nowIso(nowMs);
  await env.DB.prepare("UPDATE sessions SET status = 'live', test_mode = ?, started_at = COALESCE(started_at, ?) WHERE id = ?")
    .bind(opts.test ? 1 : 0, ts, session.id).run();
  await roomControl(env, session.id, { action: 'status', status: opts.test ? 'preview' : 'live' });
  if (!opts.test) {
    const already = await env.DB.prepare("SELECT 1 AS x FROM events WHERE session_id = ? AND type = 'session.started'").bind(session.id).first();
    if (!already) await emitEvent(env, { brandId: webinar.brand_id, mode: webinar.mode, type: 'session.started', webinarId: webinar.id, sessionId: session.id, now: nowMs });
  }
}

export async function endSession(env: Env, services: Services, session: SessionRow, webinar: WebinarRow, nowMs: number) {
  const ts = nowIso(nowMs);
  await env.DB.prepare("UPDATE sessions SET status = 'ended', ended_at = COALESCE(ended_at, ?), test_mode = 0 WHERE id = ?").bind(ts, session.id).run();
  await roomControl(env, session.id, { action: 'status', status: 'ended' });
  if (session.status !== 'ended') {
    await emitEvent(env, { brandId: webinar.brand_id, mode: webinar.mode, type: 'session.ended', webinarId: webinar.id, sessionId: session.id, now: nowMs });
  }
  if (session.kind === 'live' && webinar.stream_live_input_id) {
    await promoteRecording(env, services, session.id, nowMs).catch((err) => console.error('promote recording', err));
  }
}

/** Live recording → on-demand replay. Safe to call repeatedly (cron + Stream webhook + end). */
export async function promoteRecording(env: Env, services: Services, sessionId: string, nowMs: number, known?: { uid: string; duration: number; readyToStream: boolean }) {
  const session = await getSession(env.DB, sessionId);
  if (!session) return;
  const webinar = await getWebinar(env.DB, session.webinar_id);
  if (!webinar?.stream_live_input_id) return;
  const rec = known ?? (await services.stream.latestRecording(webinar.stream_live_input_id));
  // Still processing: leave it; the Stream webhook or the cron fallback will come back.
  if (!rec?.readyToStream) return;
  await env.DB.prepare('UPDATE sessions SET recording_uid = ? WHERE id = ?').bind(rec.uid, session.id).run();
  // The latest live recording becomes the webinar's replay (and can be reused as an evergreen source).
  await env.DB.prepare('UPDATE webinars SET video_uid = ?, duration_s = COALESCE(duration_s, ?), updated_at = ? WHERE id = ?')
    .bind(rec.uid, Math.round(rec.duration) || null, nowIso(nowMs), webinar.id).run();
  const already = await env.DB.prepare("SELECT 1 AS x FROM events WHERE session_id = ? AND type = 'recording.ready'").bind(session.id).first();
  if (!already) {
    await emitEvent(env, {
      brandId: webinar.brand_id, mode: webinar.mode, type: 'recording.ready', webinarId: webinar.id, sessionId: session.id,
      data: { video_uid: rec.uid, duration_s: Math.round(rec.duration) }, now: nowMs,
    });
  }
}

export function percentWatched(watchS: number, durationS: number | null): number {
  if (!durationS || durationS <= 0) return 0;
  return Math.min(100, Math.round((watchS / durationS) * 100));
}

const FINALIZE_BATCH = 50;

/**
 * After a live/evergreen session ends: one attendee.left per attendee (final watch time) and
 * attendee.no_show for registrants who never joined. Batched; returns true when done.
 */
export async function finalizeSession(env: Env, session: SessionRow, webinar: WebinarRow, nowMs: number): Promise<boolean> {
  if (session.finalized_at) return true;
  const duration = webinar.duration_s ?? (session.starts_at && session.ends_at ? (Date.parse(session.ends_at) - Date.parse(session.starts_at)) / 1000 : null);
  let budget = FINALIZE_BATCH;

  const open = await env.DB.prepare('SELECT * FROM attendance WHERE session_id = ? AND left_emitted = 0 LIMIT ?').bind(session.id, budget).all<AttendanceRow>();
  for (const a of open.results ?? []) {
    budget--;
    await env.DB.prepare('UPDATE attendance SET left_emitted = 1, left_at = COALESCE(left_at, last_seen_at) WHERE id = ?').bind(a.id).run();
    await emitLeft(env, webinar, a, duration, nowMs);
  }
  if (budget <= 0) return false;

  const noShows = await env.DB.prepare(
    `SELECT r.id FROM registrants r
      WHERE r.session_id = ? AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.registrant_id = r.id AND a.session_id = r.session_id)
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.registrant_id = r.id AND e.session_id = r.session_id AND e.type = 'attendee.no_show')
      LIMIT ?`,
  ).bind(session.id, budget).all<{ id: string }>();
  for (const r of noShows.results ?? []) {
    budget--;
    await emitEvent(env, { brandId: webinar.brand_id, mode: webinar.mode, type: 'attendee.no_show', registrantId: r.id, sessionId: session.id, webinarId: webinar.id, now: nowMs });
  }
  if (budget <= 0) return false;

  await env.DB.prepare('UPDATE sessions SET finalized_at = ? WHERE id = ?').bind(nowIso(nowMs), session.id).run();
  return true;
}

export interface AttendanceRow {
  id: string;
  registrant_id: string;
  session_id: string;
  joined_at: string;
  left_at: string | null;
  last_seen_at: string;
  watch_s: number;
  max_position_s: number;
  position_s: number;
  device: string | null;
  country: string | null;
  left_emitted: number;
}

export async function emitLeft(env: Env, webinar: WebinarRow, a: AttendanceRow, durationS: number | null, nowMs: number) {
  // A returning replay viewer gets a second attendee.left so analytics stay complete, but it is
  // flagged `repeat` and carries no CRM action: lead score and the engaged tag are applied once.
  const prior = await env.DB.prepare("SELECT 1 AS x FROM events WHERE registrant_id = ? AND session_id = ? AND type = 'attendee.left'").bind(a.registrant_id, a.session_id).first();
  await emitEvent(env, {
    brandId: webinar.brand_id, mode: webinar.mode, type: 'attendee.left', registrantId: a.registrant_id, sessionId: a.session_id, webinarId: webinar.id,
    data: {
      joined_at: a.joined_at,
      left_at: a.left_at ?? a.last_seen_at,
      watch_s: a.watch_s,
      max_position_s: a.max_position_s,
      percent_watched: percentWatched(a.watch_s, durationS),
      device: a.device,
      country: a.country,
      repeat: !!prior,
    },
    now: nowMs,
  });
}

// ---------- links, calendar ----------

export function hostedBase(env: Pick<Env, 'PUBLIC_ORIGIN'>, cfg: ResolvedConfig): string {
  return cfg.settings.domains.hosted_hostname ? `https://${cfg.settings.domains.hosted_hostname}` : env.PUBLIC_ORIGIN;
}

export function hostedUrl(env: Pick<Env, 'PUBLIC_ORIGIN'>, cfg: ResolvedConfig, webinarSlug: string, view = 'register'): string {
  const base = hostedBase(env, cfg);
  const path = cfg.settings.domains.hosted_hostname ? `/${webinarSlug}` : `/w/${cfg.brand.slug}/${webinarSlug}`;
  return `${base}${path}${view === 'register' ? '' : `?view=${view}`}`;
}

/** Magic links land back on the site where the person registered, with a hosted-page fallback. */
export function magicLinks(env: Pick<Env, 'PUBLIC_ORIGIN'>, cfg: ResolvedConfig, webinarSlug: string, sourceUrl: string | null, sourceAllowed: boolean, token: string) {
  const hosted = new URL(hostedUrl(env, cfg, webinarSlug, 'room'));
  hosted.searchParams.set('ghq_token', token);
  let primary = hosted.toString();
  if (sourceUrl && sourceAllowed) {
    try {
      const u = new URL(sourceUrl);
      u.hash = '';
      u.searchParams.set('ghq_token', token);
      u.searchParams.set('ghq_view', 'room');
      primary = u.toString();
    } catch {
      /* keep hosted */
    }
  }
  return { magic_link: primary, hosted_link: hosted.toString() };
}

function icsDate(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (m) => `\\${m}`);
}

export function calendarFor(opts: { uid: string; title: string; description: string; startsAt: string; endsAt: string; url: string; organizer: string }) {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Growth HQ//Webinars//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${opts.uid}`,
    `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${icsDate(opts.startsAt)}`,
    `DTEND:${icsDate(opts.endsAt)}`,
    `SUMMARY:${icsEscape(opts.title)}`,
    `DESCRIPTION:${icsEscape(`${opts.description}\n\nJoin: ${opts.url}`)}`,
    `URL:${opts.url}`,
    `LOCATION:${icsEscape(opts.url)}`,
    `ORGANIZER;CN=${icsEscape(opts.organizer)}:MAILTO:noreply@growthhq.app`,
    'BEGIN:VALARM',
    'TRIGGER:-PT10M',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEscape(opts.title)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const g = new URL('https://calendar.google.com/calendar/render');
  g.searchParams.set('action', 'TEMPLATE');
  g.searchParams.set('text', opts.title);
  g.searchParams.set('dates', `${icsDate(opts.startsAt)}/${icsDate(opts.endsAt)}`);
  g.searchParams.set('details', `${opts.description}\n\nJoin: ${opts.url}`);
  g.searchParams.set('location', opts.url);
  const o = new URL('https://outlook.live.com/calendar/0/deeplink/compose');
  o.searchParams.set('path', '/calendar/action/compose');
  o.searchParams.set('rru', 'addevent');
  o.searchParams.set('subject', opts.title);
  o.searchParams.set('startdt', opts.startsAt);
  o.searchParams.set('enddt', opts.endsAt);
  o.searchParams.set('body', `${opts.description}\n\nJoin: ${opts.url}`);
  o.searchParams.set('location', opts.url);
  return { ics, google_url: g.toString(), outlook_url: o.toString() };
}
