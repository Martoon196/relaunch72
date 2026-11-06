import { Hono } from 'hono';
import { bad, clientIp, forbidden, HttpError, notFound, publishable, rateLimit, readJson, type AppEnv, type Ctx } from '../app.js';
import {
  allowedOriginsFor,
  isOriginAllowed,
  mintSessionToken,
  newMagicToken,
  readHostToken,
  readSessionToken,
  type HostClaims,
  type SessionClaims,
} from '../lib/auth.js';
import { publicConfig, resolveConfig, type ResolvedConfig } from '../lib/config.js';
import { sha256Hex } from '../lib/crypto.js';
import {
  calendarFor,
  computeRoomState,
  getOrCreateOnDemandSession,
  getOrCreateSlotSession,
  getSession,
  getWebinar,
  endSession,
  hostedUrl,
  magicLinks,
  nextSlots,
  activeSlotRules,
  publicCta,
  publicPoll,
  type CtaRow,
  type PollRow,
  type RegistrantRow,
  type RoomState,
  type SessionRow,
  type WebinarRow,
} from '../lib/domain.js';
import { emitEvent } from '../lib/events.js';
import { isRuleSlot } from '../lib/slots.js';
import { clampInt, isEmail, isPlainObject, newId, normaliseEmail, nowIso, parseJson } from '../lib/util.js';

export const publicRoutes = new Hono<AppEnv>();

const ipBrand = (c: Ctx) => `${clientIp(c)}:${c.req.header('x-ghq-key') ?? c.req.query('key') ?? ''}`;

// ---------- helpers ----------

async function webinarBySlug(c: Ctx, slug: string): Promise<WebinarRow> {
  const { brand, mode } = c.var.pk;
  const w = await c.env.DB.prepare("SELECT * FROM webinars WHERE brand_id = ? AND mode = ? AND slug = ? AND status = 'published'")
    .bind(brand.id, mode, slug).first<WebinarRow>();
  if (!w) throw notFound('Webinar not found');
  return w;
}

async function upcomingSessions(c: Ctx, webinarId: string) {
  const now = nowIso(c.var.services.now());
  const rows = await c.env.DB.prepare(
    "SELECT id, starts_at, ends_at, status FROM sessions WHERE webinar_id = ? AND kind = 'live' AND status != 'ended' AND (ends_at IS NULL OR ends_at > ?) ORDER BY starts_at ASC LIMIT 20",
  ).bind(webinarId, now).all<Pick<SessionRow, 'id' | 'starts_at' | 'ends_at' | 'status'>>();
  return rows.results ?? [];
}

function webinarSummary(w: WebinarRow, cfg?: ResolvedConfig, env?: { PUBLIC_ORIGIN: string }) {
  return {
    hosted_url: cfg && env ? hostedUrl(env, cfg, w.slug) : undefined,
    id: w.id,
    slug: w.slug,
    type: w.type,
    label: w.type === 'evergreen' ? 'Scheduled replay' : w.type === 'live' ? 'Live' : 'On demand',
    title: w.title,
    description: w.description,
    presenters: parseJson(w.presenters_json, []),
    duration_s: w.duration_s,
  };
}

async function webinarDetail(c: Ctx, w: WebinarRow, cfg: ResolvedConfig) {
  const now = c.var.services.now();
  return {
    ...webinarSummary(w, cfg, c.env),
    agenda: parseJson(w.agenda_json, []),
    sessions: w.type === 'live' ? await upcomingSessions(c, w.id) : [],
    slots: w.type === 'evergreen' ? await nextSlots(c.env.DB, w.id, now, 8) : [],
    config: publicConfig(cfg),
    server_now: nowIso(now),
  };
}

// ---------- brand + listing ----------

publicRoutes.use('/v1/brand', rateLimit('RL_PUBLIC', ipBrand), publishable());
publicRoutes.get('/v1/brand', (c) => {
  const { brand } = c.var.pk;
  return c.json({ config: publicConfig(resolveConfig(brand)), turnstile_site_key: c.env.TURNSTILE_SITE_KEY ?? null });
});

publicRoutes.use('/v1/webinars', rateLimit('RL_PUBLIC', ipBrand), publishable());
publicRoutes.get('/v1/webinars', async (c) => {
  const { brand, mode } = c.var.pk;
  const view = c.req.query('view') ?? 'upcoming';
  const now = c.var.services.now();
  const rows = await c.env.DB.prepare("SELECT * FROM webinars WHERE brand_id = ? AND mode = ? AND status = 'published' ORDER BY created_at DESC LIMIT 100")
    .bind(brand.id, mode).all<WebinarRow>();
  const out = [];
  for (const w of rows.results ?? []) {
    const cfg = resolveConfig(brand, w.overrides_json);
    if (view === 'on_demand') {
      if (w.type !== 'on_demand') continue;
      out.push({ ...webinarSummary(w, cfg, c.env), next_start: null });
      continue;
    }
    if (w.type === 'on_demand') continue;
    const next = w.type === 'live' ? (await upcomingSessions(c, w.id))[0]?.starts_at ?? null : (await nextSlots(c.env.DB, w.id, now, 1))[0] ?? null;
    if (!next) continue;
    out.push({ ...webinarSummary(w, cfg, c.env), next_start: next });
  }
  if (view !== 'on_demand') out.sort((a, b) => String(a.next_start).localeCompare(String(b.next_start)));
  return c.json({ data: out, config: publicConfig(resolveConfig(brand)) });
});

publicRoutes.use('/v1/webinars/:slug', rateLimit('RL_PUBLIC', ipBrand), publishable());
publicRoutes.get('/v1/webinars/:slug', async (c) => {
  const w = await webinarBySlug(c, c.req.param('slug'));
  const cfg = resolveConfig(c.var.pk.brand, w.overrides_json);
  return c.json({ data: await webinarDetail(c, w, cfg), turnstile_site_key: c.env.TURNSTILE_SITE_KEY ?? null });
});

// ---------- registration ----------

interface RegistrationBody {
  email?: string;
  name?: string;
  phone?: string;
  answers?: Record<string, unknown>;
  consent?: boolean;
  session_id?: string;
  slot?: string;
  turnstile_token?: string;
  source_url?: string;
  utm?: Record<string, string>;
}

const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'];

publicRoutes.use('/v1/webinars/:slug/registrations', rateLimit('RL_REGISTER', (c) => clientIp(c)), publishable());
publicRoutes.post('/v1/webinars/:slug/registrations', async (c) => {
  const { brand, mode, key, origin } = c.var.pk;
  const { services } = c.var;
  const now = services.now();
  const w = await webinarBySlug(c, c.req.param('slug'));
  const cfg = resolveConfig(brand, w.overrides_json);
  const body = await readJson<RegistrationBody>(c);

  if (!(await services.turnstile.verify(body.turnstile_token, clientIp(c)))) throw new HttpError(400, 'turnstile_failed', 'Please complete the verification');

  // --- validate fields against the brand's form schema ---
  const email = typeof body.email === 'string' ? normaliseEmail(body.email) : '';
  if (!isEmail(email)) throw bad('A valid email is required', 'invalid_email');
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim().slice(0, 40) : '';
  const answersIn = isPlainObject(body.answers) ? body.answers : {};
  const answers: Record<string, string | boolean> = {};
  for (const f of cfg.settings.registration.fields) {
    if (f.name === 'email') continue;
    const v = f.name === 'name' ? name : f.name === 'phone' ? phone : answersIn[f.name];
    const present = typeof v === 'boolean' ? v : typeof v === 'string' && v.trim() !== '';
    if (f.required && !present) throw bad(`${f.label} is required`, 'missing_field');
    if (f.name === 'name' || f.name === 'phone' || v === undefined) continue;
    if (f.type === 'select' && f.options && typeof v === 'string' && v && !f.options.includes(v)) throw bad(`${f.label}: invalid option`, 'invalid_field');
    answers[f.name] = typeof v === 'boolean' ? v : String(v).slice(0, 1000);
  }
  if (body.consent !== true) throw bad('Consent is required', 'consent_required');

  // --- pick the session ---
  let session: SessionRow;
  if (w.type === 'live') {
    const upcoming = await upcomingSessions(c, w.id);
    const chosen = body.session_id ? upcoming.find((s) => s.id === body.session_id) : upcoming[0];
    if (!chosen) throw bad('No upcoming session for this webinar', 'no_session');
    session = (await getSession(c.env.DB, chosen.id))!;
  } else if (w.type === 'evergreen') {
    const rules = await activeSlotRules(c.env.DB, w.id);
    if (!body.slot || !isRuleSlot(rules, body.slot, now, 60_000)) throw bad('Please choose an available time', 'invalid_slot');
    session = await getOrCreateSlotSession(c.env.DB, w, body.slot, now);
  } else {
    session = await getOrCreateOnDemandSession(c.env.DB, w.id, now);
  }

  const sourceUrl = typeof body.source_url === 'string' ? body.source_url.slice(0, 2000) : c.req.header('referer') ?? null;
  const allowed = allowedOriginsFor(key, brand, c.env.PUBLIC_ORIGIN);
  const sourceAllowed = !!sourceUrl && isOriginAllowed(safeOrigin(sourceUrl), allowed);
  const utm: Record<string, string> = {};
  if (isPlainObject(body.utm)) for (const k of UTM_KEYS) if (typeof body.utm[k] === 'string') utm[k] = String(body.utm[k]).slice(0, 200);
  const consent = {
    accepted: true,
    text: cfg.settings.registration.consent_text,
    version: cfg.settings.registration.consent_version,
    ts: nowIso(now),
    source_url: sourceUrl,
    origin,
    ip: clientIp(c),
  };
  const accessExpires = w.type === 'on_demand' && cfg.settings.defaults.replay_expiry_days
    ? nowIso(now + cfg.settings.defaults.replay_expiry_days * 86_400_000)
    : null;

  const token = newMagicToken();
  const tokenHash = await sha256Hex(token);
  const existing = await c.env.DB.prepare('SELECT id FROM registrants WHERE webinar_id = ? AND email = ?').bind(w.id, email).first<{ id: string }>();
  let registrantId: string;
  if (existing) {
    registrantId = existing.id;
    await c.env.DB.prepare(
      `UPDATE registrants SET session_id = ?, name = COALESCE(NULLIF(?, ''), name), phone = COALESCE(NULLIF(?, ''), phone), answers_json = ?, consent_json = ?,
              utm_json = ?, source_url = ?, token_hash = ?, access_expires_at = COALESCE(access_expires_at, ?), updated_at = ? WHERE id = ?`,
    ).bind(session.id, name, phone, JSON.stringify(answers), JSON.stringify(consent), JSON.stringify(utm), sourceUrl, tokenHash, accessExpires, nowIso(now), registrantId).run();
  } else {
    registrantId = newId('reg');
    await c.env.DB.prepare(
      `INSERT INTO registrants (id, brand_id, mode, webinar_id, session_id, email, name, phone, answers_json, consent_json, utm_json, source_url, token_hash, access_expires_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(registrantId, brand.id, mode, w.id, session.id, email, name, phone || null, JSON.stringify(answers), JSON.stringify(consent), JSON.stringify(utm), sourceUrl, tokenHash, accessExpires, nowIso(now), nowIso(now)).run();
  }

  const links = magicLinks(c.env, cfg, w.slug, sourceUrl, sourceAllowed, token);
  const icsUrl = `${c.env.API_ORIGIN}/v1/calendar/${token}.ics`;
  const startsAt = session.kind === 'on_demand' ? null : session.starts_at;
  const endsAt = session.ends_at ?? (startsAt ? new Date(Date.parse(startsAt) + (w.duration_s ?? 3600) * 1000).toISOString() : null);
  const calendar = startsAt && endsAt
    ? calendarFor({ uid: `${registrantId}@webinars.growthhq.app`, title: w.title, description: w.description, startsAt, endsAt, url: links.magic_link, organizer: brand.name })
    : null;

  await emitEvent(c.env, {
    brandId: brand.id,
    mode,
    type: existing ? 'registrant.updated' : 'registrant.created',
    registrantId,
    sessionId: session.id,
    webinarId: w.id,
    registrantExtra: {
      ...links,
      ics_url: calendar ? icsUrl : null,
      google_calendar_url: calendar?.google_url ?? null,
      outlook_calendar_url: calendar?.outlook_url ?? null,
      consent,
      timezone: cfg.settings.defaults.timezone,
    },
    data: { reminders_min: cfg.settings.messaging.reminders_min, replay_expires_at: accessExpires },
    now,
  });

  // Fresh registrations can join straight away from this browser; re-registrations must use the emailed link
  // (so typing someone else's email never hands over their access).
  const instant = !existing;
  return c.json({
    data: {
      registrant_id: registrantId,
      already_registered: !!existing,
      session: { id: session.id, starts_at: startsAt, ends_at: endsAt, kind: session.kind },
      token: instant ? token : null,
      calendar: calendar ? { ics_url: icsUrl, google_url: calendar.google_url, outlook_url: calendar.outlook_url } : null,
      thank_you_redirect_url: cfg.settings.registration.thank_you_redirect_url ?? null,
    },
  }, existing ? 200 : 201);
});

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// ---------- join / playback ----------

interface RoomBundle {
  webinar: WebinarRow;
  session: SessionRow;
  registrant: RegistrantRow;
  cfg: ResolvedConfig;
  state: RoomState;
}

async function loadRoom(c: Ctx, registrant: RegistrantRow, sessionId?: string): Promise<RoomBundle> {
  const now = c.var.services.now();
  const webinar = await getWebinar(c.env.DB, registrant.webinar_id);
  if (!webinar || webinar.status !== 'published') throw notFound('Webinar not available');
  const cfg = resolveConfig(c.var.pk.brand, webinar.overrides_json);
  let session = sessionId ? await getSession(c.env.DB, sessionId) : registrant.session_id ? await getSession(c.env.DB, registrant.session_id) : null;
  if (!session || session.webinar_id !== webinar.id) session = await getOrCreateOnDemandSession(c.env.DB, webinar.id, now);
  // Replays after a live/evergreen event are tracked on the webinar's on-demand session.
  let replaySessionId: string | null = null;
  if (session.kind !== 'on_demand' && (session.status === 'ended' || (session.kind === 'evergreen' && session.ends_at && Date.parse(session.ends_at) <= now))) {
    replaySessionId = (await getOrCreateOnDemandSession(c.env.DB, webinar.id, now)).id;
  }
  const state = computeRoomState(webinar, session, registrant, cfg, replaySessionId, now);
  return { webinar, session, registrant, cfg, state };
}

async function playbackFor(c: Ctx, room: RoomBundle) {
  const { state } = room;
  if (!state.video_uid || !['live', 'replay', 'on_demand'].includes(state.state)) return null;
  const p = await c.var.services.stream.playback(state.video_uid, { live: state.live, nowMs: c.var.services.now() });
  return { ...p, offset_s: state.offset_s, seekable: state.seekable, low_latency: state.live };
}

/** First watch → attendance row + attendee.joined. */
async function recordJoin(c: Ctx, room: RoomBundle, device: string) {
  const sid = room.state.attendance_session_id;
  if (!sid) return;
  const now = nowIso(c.var.services.now());
  const country = (c.req.raw as { cf?: { country?: string } }).cf?.country ?? c.req.header('cf-ipcountry') ?? null;
  const res = await c.env.DB.prepare(
    `INSERT INTO attendance (id, registrant_id, session_id, joined_at, last_seen_at, device, country) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT (registrant_id, session_id) DO UPDATE SET left_at = NULL, left_emitted = 0, last_seen_at = excluded.last_seen_at`,
  ).bind(newId('att'), room.registrant.id, sid, now, now, device.slice(0, 80), country).run();
  const firstJoin = await c.env.DB.prepare("SELECT 1 AS x FROM events WHERE registrant_id = ? AND session_id = ? AND type = 'attendee.joined'")
    .bind(room.registrant.id, sid).first();
  if (!firstJoin && res.success) {
    await emitEvent(c.env, {
      brandId: room.webinar.brand_id, mode: room.webinar.mode, type: 'attendee.joined', registrantId: room.registrant.id, sessionId: sid, webinarId: room.webinar.id,
      data: { state: room.state.state, device, country }, now: c.var.services.now(),
    });
  }
}

async function roomPayload(c: Ctx, room: RoomBundle, claims: { dev: string }, sessionToken: string) {
  const { webinar, cfg, state, session } = room;
  const ctas = await c.env.DB.prepare('SELECT * FROM ctas WHERE webinar_id = ? ORDER BY show_at_s').bind(webinar.id).all<CtaRow>();
  const polls = await c.env.DB.prepare('SELECT * FROM polls WHERE webinar_id = ? ORDER BY show_at_s').bind(webinar.id).all<PollRow>();
  const playback = await playbackFor(c, room);
  if (playback) await recordJoin(c, room, claims.dev);
  const wsSession = state.attendance_session_id ?? session.id;
  const wsUrl = new URL(`/v1/sessions/${wsSession}/live`, c.env.API_ORIGIN.replace(/^http/, 'ws'));
  wsUrl.searchParams.set('key', c.var.pk.key.display ?? '');
  wsUrl.searchParams.set('token', sessionToken);
  return {
    session_token: sessionToken,
    registrant: { id: room.registrant.id, name: room.registrant.name, email: room.registrant.email },
    webinar: { ...webinarSummary(webinar), agenda: parseJson(webinar.agenda_json, []), handouts: handoutLinks(c, webinar, sessionToken) },
    session: { id: session.id, kind: session.kind, starts_at: session.starts_at, ends_at: session.ends_at, status: session.status },
    room: state,
    playback,
    ws_url: wsUrl.toString(),
    ctas: (ctas.results ?? []).map(publicCta),
    polls: (polls.results ?? []).map(publicPoll),
    config: publicConfig(cfg),
    server_now: nowIso(c.var.services.now()),
  };
}

function handoutLinks(c: Ctx, w: WebinarRow, st: string) {
  return parseJson<{ name: string; label?: string }[]>(w.handouts_json, []).map((h) => ({
    label: h.label ?? h.name,
    url: `${c.env.API_ORIGIN}/v1/handouts/${w.id}/${encodeURIComponent(h.name)}?st=${encodeURIComponent(st)}`,
  }));
}

publicRoutes.use('/v1/join', rateLimit('RL_PUBLIC', ipBrand), publishable());
publicRoutes.post('/v1/join', async (c) => {
  const { brand, mode } = c.var.pk;
  const body = await readJson<{ token?: string; device_id?: string }>(c);
  if (!body.token || typeof body.token !== 'string') throw bad('token required');
  const registrant = await c.env.DB.prepare('SELECT * FROM registrants WHERE token_hash = ?').bind(await sha256Hex(body.token)).first<RegistrantRow>();
  if (!registrant || registrant.brand_id !== brand.id || registrant.mode !== mode) throw new HttpError(401, 'invalid_link', 'This link is not valid. Please register again.');
  if (registrant.banned) throw forbidden('Access to this webinar has been removed');
  const room = await loadRoom(c, registrant);
  if (room.state.state === 'expired') throw new HttpError(410, 'expired', 'Access to this replay has expired');
  const device = (body.device_id ?? 'unknown').slice(0, 80);
  const claims = {
    rid: registrant.id,
    sid: room.state.attendance_session_id ?? room.session.id,
    wid: room.webinar.id,
    bid: brand.id,
    mode,
    dev: device,
  };
  const st = await mintSessionToken(c.env.TOKEN_SECRET, claims, c.var.services.now());
  return c.json({ data: await roomPayload(c, room, claims, st) });
});

async function sessionAuth(c: Ctx, bodyToken?: string): Promise<SessionClaims> {
  const auth = c.req.header('authorization') ?? '';
  const raw = auth.startsWith('Bearer ') ? auth.slice(7) : bodyToken ?? '';
  const claims = raw ? await readSessionToken(c.env.TOKEN_SECRET, raw, c.var.services.now()) : null;
  if (!claims || claims.bid !== c.var.pk.brand.id || claims.mode !== c.var.pk.mode) throw new HttpError(401, 'session_expired', 'Please rejoin from your link');
  return claims;
}

async function registrantFor(c: Ctx, claims: SessionClaims): Promise<RegistrantRow> {
  const r = await c.env.DB.prepare('SELECT * FROM registrants WHERE id = ?').bind(claims.rid).first<RegistrantRow>();
  if (!r) throw new HttpError(401, 'session_expired', 'Please rejoin from your link');
  if (r.banned) throw forbidden('Access to this webinar has been removed');
  return r;
}

/** Re-check the room (e.g. host just went live) and mint a fresh 1h playback URL. */
publicRoutes.use('/v1/playback', rateLimit('RL_PUBLIC', ipBrand), publishable());
publicRoutes.post('/v1/playback', async (c) => {
  const claims = await sessionAuth(c);
  const registrant = await registrantFor(c, claims);
  const room = await loadRoom(c, registrant);
  if (room.state.state === 'expired') throw new HttpError(410, 'expired', 'Access to this replay has expired');
  const st = c.req.header('authorization')!.slice(7);
  const playback = await playbackFor(c, room);
  if (playback) await recordJoin(c, room, claims.dev);
  return c.json({ data: { room: room.state, playback, server_now: nowIso(c.var.services.now()), session_token: st } });
});

// ---------- heartbeats, leaves, CTA clicks ----------

interface EventBody {
  key?: string;
  session_token?: string;
  type?: 'heartbeat' | 'leave' | 'cta_click';
  position_s?: number;
  playing?: boolean;
  cta_id?: string;
}

const HEARTBEAT_S = 30;

publicRoutes.use('/v1/events', rateLimit('RL_PUBLIC', ipBrand), publishable({ allowBodyKey: true }));
publicRoutes.post('/v1/events', async (c) => {
  const body = await readJson<EventBody>(c);
  const claims = await sessionAuth(c, body.session_token);
  const nowMs = c.var.services.now();
  const now = nowIso(nowMs);
  const position = clampInt(body.position_s, 0, 24 * 3600, 0);

  if (body.type === 'heartbeat' || body.type === 'leave') {
    const a = await c.env.DB.prepare('SELECT id, last_seen_at FROM attendance WHERE registrant_id = ? AND session_id = ?').bind(claims.rid, claims.sid).first<{ id: string; last_seen_at: string }>();
    if (!a) return c.json({ data: { ok: false, reason: 'not_joined' } });
    // Credit at most the real time since the last beat (plus slack), and only while playing.
    const elapsed = Math.max(0, Math.floor((nowMs - Date.parse(a.last_seen_at)) / 1000));
    const credit = body.playing === false ? 0 : Math.min(elapsed, HEARTBEAT_S + 15);
    await c.env.DB.prepare(
      `UPDATE attendance SET watch_s = watch_s + ?, last_seen_at = ?, position_s = ?, max_position_s = MAX(max_position_s, ?), left_at = ? WHERE id = ?`,
    ).bind(credit, now, position, position, body.type === 'leave' ? now : null, a.id).run();
    return c.json({ data: { ok: true } });
  }

  if (body.type === 'cta_click') {
    const cta = body.cta_id ? await c.env.DB.prepare('SELECT * FROM ctas WHERE id = ? AND webinar_id = ?').bind(body.cta_id, claims.wid).first<CtaRow>() : null;
    if (!cta) throw notFound('CTA not found');
    await emitEvent(c.env, {
      brandId: claims.bid, mode: claims.mode, type: 'cta.clicked', registrantId: claims.rid, sessionId: claims.sid, webinarId: claims.wid,
      data: { cta_id: cta.id, label: cta.label, url: cta.url, position_s: position }, now: nowMs,
    });
    return c.json({ data: { ok: true } });
  }

  throw bad('Unknown event type');
});

// ---------- live room WebSocket ----------

publicRoutes.get('/v1/sessions/:id/live', publishable(), async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'upgrade_required', 'WebSocket required');
  const sid = c.req.param('id');
  const raw = c.req.query('token') ?? '';
  const now = c.var.services.now();
  const { brand, mode } = c.var.pk;

  let ctx: Record<string, unknown>;
  const sessionClaims = await readSessionToken(c.env.TOKEN_SECRET, raw, now);
  if (sessionClaims) {
    if (sessionClaims.sid !== sid || sessionClaims.bid !== brand.id || sessionClaims.mode !== mode) throw forbidden();
    const r = await registrantFor(c, sessionClaims);
    ctx = { role: 'attendee', rid: r.id, name: r.name || r.email.split('@')[0], dev: sessionClaims.dev };
  } else {
    const host = await readHostToken(c.env.TOKEN_SECRET, raw, now);
    if (!host || host.sid !== sid || host.bid !== brand.id || host.mode !== mode) throw new HttpError(401, 'unauthorized', 'Invalid room token');
    ctx = { role: host.role, hid: host.hid, name: host.name };
  }

  const session = await getSession(c.env.DB, sid);
  if (!session) throw notFound();
  const webinar = (await getWebinar(c.env.DB, session.webinar_id))!;
  const cfg = resolveConfig(brand, webinar.overrides_json);
  const meta = {
    sid,
    wid: webinar.id,
    bid: brand.id,
    mode,
    kind: session.kind,
    status: session.status === 'live' && session.test_mode ? 'preview' : session.status,
    chat_enabled: cfg.settings.defaults.chat_enabled && session.kind !== 'on_demand',
    qa_moderation: cfg.settings.defaults.qa_moderation,
    one_device: cfg.settings.defaults.one_device_per_registrant,
  };
  const stub = c.env.SESSION_ROOM.get(c.env.SESSION_ROOM.idFromName(sid));
  const headers = new Headers({ upgrade: 'websocket', 'x-room-ctx': JSON.stringify({ ...ctx, meta }) });
  return stub.fetch('https://room/ws', { headers });
});

// ---------- host console (host / moderator tokens) ----------

async function hostAuth(c: Ctx): Promise<HostClaims> {
  const auth = c.req.header('authorization') ?? '';
  const claims = auth.startsWith('Bearer ') ? await readHostToken(c.env.TOKEN_SECRET, auth.slice(7), c.var.services.now()) : null;
  if (!claims || claims.bid !== c.var.pk.brand.id || claims.mode !== c.var.pk.mode) throw new HttpError(401, 'unauthorized', 'Console link expired');
  return claims;
}

publicRoutes.use('/v1/host/*', rateLimit('RL_PUBLIC', ipBrand), publishable());
publicRoutes.post('/v1/host/console', async (c) => {
  const claims = await hostAuth(c);
  const session = await getSession(c.env.DB, claims.sid);
  const webinar = session ? await getWebinar(c.env.DB, session.webinar_id) : null;
  if (!session || !webinar) throw notFound();
  const ctas = await c.env.DB.prepare('SELECT * FROM ctas WHERE webinar_id = ? ORDER BY show_at_s').bind(webinar.id).all<CtaRow>();
  const polls = await c.env.DB.prepare('SELECT * FROM polls WHERE webinar_id = ? ORDER BY show_at_s').bind(webinar.id).all<PollRow>();
  const uid = webinar.type === 'live' ? webinar.stream_live_input_id : webinar.video_uid;
  const playback = uid ? await c.var.services.stream.playback(uid, { live: webinar.type === 'live', nowMs: c.var.services.now() }) : null;
  const ws = new URL(`/v1/sessions/${session.id}/live`, c.env.API_ORIGIN.replace(/^http/, 'ws'));
  ws.searchParams.set('key', c.var.pk.key.display ?? '');
  ws.searchParams.set('token', c.req.header('authorization')!.slice(7));
  return c.json({
    data: {
      role: claims.role,
      name: claims.name,
      webinar: webinarSummary(webinar),
      session: { id: session.id, kind: session.kind, status: session.status, test_mode: !!session.test_mode, starts_at: session.starts_at, ends_at: session.ends_at },
      ctas: (ctas.results ?? []).map(publicCta),
      polls: (polls.results ?? []).map(publicPoll),
      playback,
      ws_url: ws.toString(),
    },
  });
});

publicRoutes.post('/v1/host/end', async (c) => {
  const claims = await hostAuth(c);
  if (claims.role !== 'host') throw forbidden('Only the host can end the session');
  const session = await getSession(c.env.DB, claims.sid);
  const webinar = session ? await getWebinar(c.env.DB, session.webinar_id) : null;
  if (!session || !webinar || session.kind !== 'live') throw notFound();
  await endSession(c.env, c.var.services, session, webinar, c.var.services.now());
  await c.env.DB.prepare('INSERT INTO audit_log (id, actor, brand_id, action, target, ts) VALUES (?,?,?,?,?,?)')
    .bind(newId('aud'), `host:${claims.hid}:${claims.name}`, webinar.brand_id, 'session.end', session.id, nowIso(c.var.services.now())).run();
  return c.json({ data: { ok: true } });
});

// ---------- handouts (R2) and calendar ----------

publicRoutes.get('/v1/handouts/:webinarId/:name', async (c) => {
  const claims = await readSessionToken(c.env.TOKEN_SECRET, c.req.query('st') ?? '', c.var.services.now());
  const wid = c.req.param('webinarId');
  if (!claims || claims.wid !== wid) throw new HttpError(401, 'unauthorized', 'Link expired — open the room again');
  const w = await getWebinar(c.env.DB, wid);
  const name = c.req.param('name');
  if (!w || !parseJson<{ name: string }[]>(w.handouts_json, []).some((h) => h.name === name) || !c.env.FILES) throw notFound();
  const obj = await c.env.FILES.get(`${w.brand_id}/${w.id}/${name}`);
  if (!obj) throw notFound();
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'content-disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
      'cache-control': 'private, max-age=300',
    },
  });
});

publicRoutes.get('/v1/calendar/:file', async (c) => {
  const token = c.req.param('file').replace(/\.ics$/, '');
  const r = await c.env.DB.prepare('SELECT * FROM registrants WHERE token_hash = ?').bind(await sha256Hex(token)).first<RegistrantRow>();
  if (!r?.session_id) throw notFound();
  const [w, s] = await Promise.all([getWebinar(c.env.DB, r.webinar_id), getSession(c.env.DB, r.session_id)]);
  if (!w || !s?.starts_at || s.kind === 'on_demand') throw notFound();
  const brand = (await c.env.DB.prepare('SELECT * FROM brands WHERE id = ?').bind(w.brand_id).first<import('../lib/config.js').BrandRow>())!;
  const cfg = resolveConfig(brand, w.overrides_json);
  const sourceAllowed = !!r.source_url && cfg.settings.domains.allowed_origins.some((o) => safeOrigin(r.source_url!) === o);
  const links = magicLinks(c.env, cfg, w.slug, r.source_url, sourceAllowed, token);
  const endsAt = s.ends_at ?? new Date(Date.parse(s.starts_at) + (w.duration_s ?? 3600) * 1000).toISOString();
  const cal = calendarFor({ uid: `${r.id}@webinars.growthhq.app`, title: w.title, description: w.description, startsAt: s.starts_at, endsAt, url: links.magic_link, organizer: brand.name });
  return c.body(cal.ics, 200, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': `attachment; filename="${w.slug}.ics"` });
});
