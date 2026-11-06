/**
 * Admin API (secret keys). Mounted at /v1/admin/*. Called by the Growth HQ backend.
 * Every mutation is written to audit_log.
 */
import { Hono } from 'hono';
import { bad, forbidden, HttpError, notFound, readJson, secret, type AppEnv, type Ctx } from '../app.js';
import { generateApiKey, mintHostToken, SCOPES, type ApiKeyRow } from '../lib/auth.js';
import { publicConfig, resolveConfig, type BrandRow } from '../lib/config.js';
import { encryptSecret, sha256Hex } from '../lib/crypto.js';
import {
  endSession,
  getSession,
  getWebinar,
  hostedUrl,
  nextSlots,
  promoteRecording,
  roomControl,
  startSession,
  type CtaRow,
  type PollRow,
  type SessionRow,
  type WebinarRow,
} from '../lib/domain.js';
import { EVENT_TYPES } from '../lib/events.js';
import { isValidTimezone } from '../lib/slots.js';
import { clampInt, isPlainObject, newId, normaliseEmail, nowIso, parseJson, randomString, slugify, toCsv } from '../lib/util.js';
import { attemptDelivery } from '../lib/webhooks.js';

export const adminRoutes = new Hono<AppEnv>();

// ---------- scope + tenancy helpers ----------

function requestedBrand(c: Ctx, body?: Record<string, unknown>): string | null {
  return (body?.brand_id as string | undefined) ?? c.req.query('brand_id') ?? c.req.header('ghq-brand') ?? null;
}

/** The brand this call acts on. Brand keys are pinned to their brand; account keys must say which. */
function brandScope(c: Ctx, body?: Record<string, unknown>): string {
  const { brandId } = c.var.sk;
  const asked = requestedBrand(c, body);
  if (brandId) {
    if (asked && asked !== brandId) throw forbidden('Key is not valid for that brand');
    return brandId;
  }
  if (!asked) throw bad('brand_id is required with an account-level key');
  return asked;
}

function assertBrand(c: Ctx, brandId: string) {
  const own = c.var.sk.brandId;
  if (own && own !== brandId) throw notFound();
}

async function audit(c: Ctx, action: string, target: string | null, brandId: string | null) {
  await c.env.DB.prepare('INSERT INTO audit_log (id, actor, brand_id, action, target, ts) VALUES (?,?,?,?,?,?)')
    .bind(newId('aud'), `key:${c.var.sk.key.id}`, brandId, action, target, nowIso(c.var.services.now())).run();
}

async function webinarFor(c: Ctx, id: string): Promise<WebinarRow> {
  const w = await getWebinar(c.env.DB, id);
  if (!w || w.mode !== c.var.sk.mode) throw notFound('Webinar not found');
  assertBrand(c, w.brand_id);
  return w;
}

async function sessionFor(c: Ctx, id: string): Promise<{ session: SessionRow; webinar: WebinarRow }> {
  const session = await getSession(c.env.DB, id);
  if (!session) throw notFound('Session not found');
  return { session, webinar: await webinarFor(c, session.webinar_id) };
}

async function brandRow(c: Ctx, id: string): Promise<BrandRow> {
  assertBrand(c, id);
  const b = await c.env.DB.prepare('SELECT * FROM brands WHERE id = ?').bind(id).first<BrandRow>();
  if (!b) throw notFound('Brand not found');
  return b;
}

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
const arr = (v: unknown) => (Array.isArray(v) ? v : undefined);
const obj = (v: unknown) => (isPlainObject(v) ? v : undefined);
const isIso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const iso = (v: string) => new Date(v).toISOString();

function wantsCsv(c: Ctx) {
  return c.req.query('format') === 'csv';
}

// =====================================================================
// Brands
// =====================================================================

const brandOut = (b: BrandRow) => ({
  id: b.id, slug: b.slug, name: b.name, ghq_account_id: b.ghq_account_id, created_at: b.created_at,
  theme: parseJson(b.theme_json, {}), settings: parseJson(b.settings_json, {}),
  resolved: publicConfig(resolveConfig(b)),
});

adminRoutes.get('/brands', secret('brands:read'), async (c) => {
  const own = c.var.sk.brandId;
  const rows = own
    ? await c.env.DB.prepare('SELECT * FROM brands WHERE id = ?').bind(own).all<BrandRow>()
    : await c.env.DB.prepare('SELECT * FROM brands ORDER BY name').all<BrandRow>();
  return c.json({ data: (rows.results ?? []).map(brandOut) });
});

adminRoutes.post('/brands', secret('brands:write'), async (c) => {
  if (c.var.sk.brandId) throw forbidden('Creating brands needs an account-level key');
  const body = await readJson(c);
  const name = str(body.name, 120);
  if (!name) throw bad('name required');
  const slug = slugify(str(body.slug, 80) ?? name);
  if (await c.env.DB.prepare('SELECT 1 AS x FROM brands WHERE slug = ?').bind(slug).first()) throw new HttpError(409, 'conflict', 'Slug already used');
  const id = newId('brd');
  await c.env.DB.prepare('INSERT INTO brands (id, slug, name, theme_json, settings_json, ghq_account_id, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind(id, slug, name, JSON.stringify(obj(body.theme) ?? {}), JSON.stringify(obj(body.settings) ?? {}), str(body.ghq_account_id) ?? null, nowIso(c.var.services.now())).run();
  await audit(c, 'brand.create', id, id);
  return c.json({ data: brandOut((await brandRow(c, id))) }, 201);
});

adminRoutes.get('/brands/:id', secret('brands:read'), async (c) => c.json({ data: brandOut(await brandRow(c, c.req.param('id'))) }));

adminRoutes.patch('/brands/:id', secret('brands:write'), async (c) => {
  const b = await brandRow(c, c.req.param('id'));
  const body = await readJson(c);
  // theme/settings are replaced wholesale when sent; send the full object you want stored.
  await c.env.DB.prepare('UPDATE brands SET name = ?, theme_json = ?, settings_json = ?, ghq_account_id = ? WHERE id = ?').bind(
    str(body.name, 120) ?? b.name,
    body.theme !== undefined ? JSON.stringify(obj(body.theme) ?? {}) : b.theme_json,
    body.settings !== undefined ? JSON.stringify(obj(body.settings) ?? {}) : b.settings_json,
    body.ghq_account_id !== undefined ? str(body.ghq_account_id) ?? null : b.ghq_account_id,
    b.id,
  ).run();
  await audit(c, 'brand.update', b.id, b.id);
  return c.json({ data: brandOut(await brandRow(c, b.id)) });
});

adminRoutes.delete('/brands/:id', secret('brands:write'), async (c) => {
  if (c.var.sk.brandId) throw forbidden('Deleting brands needs an account-level key');
  const b = await brandRow(c, c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM brands WHERE id = ?').bind(b.id).run();
  await audit(c, 'brand.delete', b.id, null);
  return c.json({ data: { deleted: true } });
});

// =====================================================================
// Webinars
// =====================================================================

const WEBINAR_TYPES = ['live', 'on_demand', 'evergreen'] as const;
const WEBINAR_STATUSES = ['draft', 'published', 'archived'] as const;

async function webinarOut(c: Ctx, w: WebinarRow) {
  const brand = (await c.env.DB.prepare('SELECT * FROM brands WHERE id = ?').bind(w.brand_id).first<BrandRow>())!;
  const cfg = resolveConfig(brand, w.overrides_json);
  const pk = await c.env.DB.prepare("SELECT display FROM api_keys WHERE brand_id = ? AND type = 'pk' AND mode = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1")
    .bind(w.brand_id, w.mode).first<{ display: string }>();
  const key = pk?.display ?? 'pk_REPLACE_ME';
  return {
    ...w,
    presenters: parseJson(w.presenters_json, []),
    agenda: parseJson(w.agenda_json, []),
    handouts: parseJson(w.handouts_json, []),
    overrides: parseJson(w.overrides_json, {}),
    presenters_json: undefined, agenda_json: undefined, handouts_json: undefined, overrides_json: undefined,
    embed: {
      snippet: `<script src="${c.env.CDN_ORIGIN}/v1/embed.js" data-key="${key}" defer></script>\n<ghq-webinar webinar="${w.slug}" view="register"></ghq-webinar>`,
      iframe: `<iframe src="${c.env.PUBLIC_ORIGIN}/frame/${key}/${w.slug}/register" style="width:100%;border:0" title="${w.title.replace(/"/g, '&quot;')}"></iframe>`,
      hosted_url: hostedUrl(c.env, cfg, w.slug),
    },
  };
}

function webinarFields(body: Record<string, unknown>, partial: boolean) {
  const f: Record<string, unknown> = {};
  if (body.type !== undefined || !partial) {
    if (!WEBINAR_TYPES.includes(body.type as never)) throw bad(`type must be one of ${WEBINAR_TYPES.join(', ')}`);
    f.type = body.type;
  }
  if (body.title !== undefined || !partial) {
    const t = str(body.title, 200);
    if (!t) throw bad('title required');
    f.title = t;
  }
  if (body.slug !== undefined) f.slug = slugify(String(body.slug));
  if (body.description !== undefined) f.description = str(body.description, 10_000) ?? '';
  if (body.status !== undefined) {
    if (!WEBINAR_STATUSES.includes(body.status as never)) throw bad('invalid status');
    f.status = body.status;
  }
  if (body.presenters !== undefined) f.presenters_json = JSON.stringify(arr(body.presenters) ?? []);
  if (body.agenda !== undefined) f.agenda_json = JSON.stringify(arr(body.agenda) ?? []);
  if (body.handouts !== undefined) f.handouts_json = JSON.stringify(arr(body.handouts) ?? []);
  if (body.overrides !== undefined) f.overrides_json = JSON.stringify(obj(body.overrides) ?? {});
  if (body.duration_s !== undefined) f.duration_s = body.duration_s === null ? null : clampInt(body.duration_s, 60, 12 * 3600, 3600);
  if (body.video_uid !== undefined) f.video_uid = str(body.video_uid, 64) ?? null;
  return f;
}

adminRoutes.get('/webinars', secret('webinars:read'), async (c) => {
  const brandId = brandScope(c);
  const status = c.req.query('status');
  const rows = await c.env.DB.prepare(`SELECT * FROM webinars WHERE brand_id = ? AND mode = ? ${status ? 'AND status = ?' : ''} ORDER BY created_at DESC`)
    .bind(...[brandId, c.var.sk.mode, ...(status ? [status] : [])]).all<WebinarRow>();
  return c.json({ data: await Promise.all((rows.results ?? []).map((w) => webinarOut(c, w))) });
});

adminRoutes.post('/webinars', secret('webinars:write'), async (c) => {
  const body = await readJson(c);
  const brandId = brandScope(c, body);
  await brandRow(c, brandId);
  const f = webinarFields(body, false);
  const slug = (f.slug as string | undefined) || slugify(f.title as string);
  if (await c.env.DB.prepare('SELECT 1 AS x FROM webinars WHERE brand_id = ? AND mode = ? AND slug = ?').bind(brandId, c.var.sk.mode, slug).first()) {
    throw new HttpError(409, 'conflict', 'A webinar with this slug already exists for the brand');
  }
  const id = newId('web');
  const now = nowIso(c.var.services.now());
  await c.env.DB.prepare(
    `INSERT INTO webinars (id, brand_id, mode, type, slug, title, description, presenters_json, agenda_json, handouts_json, video_uid, duration_s, status, overrides_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, brandId, c.var.sk.mode, f.type, slug, f.title, f.description ?? '', f.presenters_json ?? '[]', f.agenda_json ?? '[]', f.handouts_json ?? '[]',
    f.video_uid ?? null, f.duration_s ?? null, f.status ?? 'draft', f.overrides_json ?? '{}', now, now).run();
  await audit(c, 'webinar.create', id, brandId);
  return c.json({ data: await webinarOut(c, (await getWebinar(c.env.DB, id))!) }, 201);
});

adminRoutes.get('/webinars/:id', secret('webinars:read'), async (c) => {
  const w = await webinarFor(c, c.req.param('id'));
  return c.json({ data: await webinarOut(c, w) });
});

adminRoutes.patch('/webinars/:id', secret('webinars:write'), async (c) => {
  const w = await webinarFor(c, c.req.param('id'));
  const f = webinarFields(await readJson(c), true);
  delete f.type; // type is fixed once created
  if (f.status === 'published') {
    if (w.type !== 'live' && !(f.video_uid ?? w.video_uid)) throw bad('Add a video before publishing an on-demand or evergreen webinar');
  }
  const cols = Object.keys(f);
  if (cols.length) {
    await c.env.DB.prepare(`UPDATE webinars SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .bind(...cols.map((k) => f[k]), nowIso(c.var.services.now()), w.id).run();
    await audit(c, 'webinar.update', w.id, w.brand_id);
  }
  return c.json({ data: await webinarOut(c, (await getWebinar(c.env.DB, w.id))!) });
});

adminRoutes.delete('/webinars/:id', secret('webinars:write'), async (c) => {
  const w = await webinarFor(c, c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM webinars WHERE id = ?').bind(w.id).run();
  await audit(c, 'webinar.delete', w.id, w.brand_id);
  return c.json({ data: { deleted: true } });
});

/** Copy a webinar (content, CTAs, polls, slot rules — not sessions or people) to the same or another brand. */
adminRoutes.post('/webinars/:id/duplicate', secret('webinars:write'), async (c) => {
  const w = await webinarFor(c, c.req.param('id'));
  const body = await readJson(c);
  const target = str(body.brand_id) ?? w.brand_id;
  assertBrand(c, target);
  await brandRow(c, target);
  let slug = slugify(str(body.slug) ?? w.slug);
  while (await c.env.DB.prepare('SELECT 1 AS x FROM webinars WHERE brand_id = ? AND mode = ? AND slug = ?').bind(target, w.mode, slug).first()) slug = `${slug}-copy`;
  const id = newId('web');
  const now = nowIso(c.var.services.now());
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO webinars (id, brand_id, mode, type, slug, title, description, presenters_json, agenda_json, handouts_json, video_uid, duration_s, status, overrides_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?)`,
    ).bind(id, target, w.mode, w.type, slug, str(body.title, 200) ?? w.title, w.description, w.presenters_json, w.agenda_json, w.handouts_json, w.video_uid, w.duration_s,
      target === w.brand_id ? w.overrides_json : '{}', now, now),
  ];
  const ctas = await c.env.DB.prepare('SELECT * FROM ctas WHERE webinar_id = ?').bind(w.id).all<CtaRow>();
  for (const x of ctas.results ?? []) {
    stmts.push(c.env.DB.prepare('INSERT INTO ctas (id, webinar_id, label, url, style, body, image_url, show_at_s, hide_at_s, push_mode, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind(newId('cta'), id, x.label, x.url, x.style, x.body, x.image_url, x.show_at_s, x.hide_at_s, x.push_mode, now));
  }
  const polls = await c.env.DB.prepare('SELECT * FROM polls WHERE webinar_id = ?').bind(w.id).all<PollRow>();
  for (const p of polls.results ?? []) {
    stmts.push(c.env.DB.prepare('INSERT INTO polls (id, webinar_id, question, options_json, show_at_s, crm_field, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(newId('pol'), id, p.question, p.options_json, p.show_at_s, p.crm_field, now));
  }
  const rules = await c.env.DB.prepare('SELECT * FROM slot_rules WHERE webinar_id = ?').bind(w.id).all<{ kind: string; rule_json: string; timezone: string; active: number }>();
  for (const r of rules.results ?? []) {
    stmts.push(c.env.DB.prepare('INSERT INTO slot_rules (id, webinar_id, kind, rule_json, timezone, active, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(newId('slr'), id, r.kind, r.rule_json, r.timezone, r.active, now));
  }
  await c.env.DB.batch(stmts);
  await audit(c, 'webinar.duplicate', `${w.id}->${id}`, target);
  return c.json({ data: await webinarOut(c, (await getWebinar(c.env.DB, id))!) }, 201);
});

async function streamOrigins(c: Ctx, w: WebinarRow): Promise<string[]> {
  const brand = (await c.env.DB.prepare('SELECT * FROM brands WHERE id = ?').bind(w.brand_id).first<BrandRow>())!;
  const cfg = resolveConfig(brand);
  const hosts = new Set<string>();
  for (const o of [...cfg.settings.domains.allowed_origins, c.env.PUBLIC_ORIGIN]) {
    try { hosts.add(new URL(o.replace('*.', 'wildcard.')).hostname.replace(/^wildcard\./, '*.')); } catch { /* skip */ }
  }
  if (cfg.settings.domains.hosted_hostname) hosts.add(cfg.settings.domains.hosted_hostname);
  return [...hosts];
}

adminRoutes.post('/webinars/:id/live-input', secret('webinars:write'), async (c) => {
  const w = await webinarFor(c, c.req.param('id'));
  if (w.type !== 'live') throw bad('Live inputs are only for live webinars');
  const li = await c.var.services.stream.createLiveInput({ name: `${w.slug} (${w.id})`, webinar_id: w.id, brand_id: w.brand_id }, await streamOrigins(c, w));
  await c.env.DB.prepare('UPDATE webinars SET stream_live_input_id = ?, updated_at = ? WHERE id = ?').bind(li.uid, nowIso(c.var.services.now()), w.id).run();
  await audit(c, 'webinar.live_input', w.id, w.brand_id);
  return c.json({
    data: {
      live_input_id: li.uid,
      rtmps: { url: li.rtmps.url, stream_key: li.rtmps.streamKey },
      srt: { url: li.srt.url, stream_id: li.srt.streamId, passphrase: li.srt.passphrase },
      whip_url: li.webRTC.url,
      notes: 'Paste RTMPS URL + key into OBS, StreamYard or Restream. Use the WHIP URL for browser go-live. Keep the stream key secret.',
    },
  }, 201);
});

adminRoutes.post('/webinars/:id/video', secret('webinars:write'), async (c) => {
  const w = await webinarFor(c, c.req.param('id'));
  const body = await readJson(c);
  const max = clampInt(body.max_duration_s, 60, 6 * 3600, 4 * 3600);
  const up = await c.var.services.stream.createDirectUpload({ name: `${w.slug} (${w.id})`, webinar_id: w.id, brand_id: w.brand_id }, await streamOrigins(c, w), max);
  await c.env.DB.prepare('UPDATE webinars SET video_uid = ?, updated_at = ? WHERE id = ?').bind(up.uid, nowIso(c.var.services.now()), w.id).run();
  await audit(c, 'webinar.video_upload', w.id, w.brand_id);
  return c.json({ data: { upload_url: up.uploadURL, video_uid: up.uid } }, 201);
});

/** Refresh duration/readiness from Stream after an upload completes. */
adminRoutes.post('/webinars/:id/video/sync', secret('webinars:write'), async (c) => {
  const w = await webinarFor(c, c.req.param('id'));
  if (!w.video_uid) throw bad('No video on this webinar');
  const v = await c.var.services.stream.videoDetails(w.video_uid);
  if (!v) throw notFound('Video not found in Stream');
  await c.env.DB.prepare('UPDATE webinars SET duration_s = ?, updated_at = ? WHERE id = ?').bind(Math.round(v.duration) || w.duration_s, nowIso(c.var.services.now()), w.id).run();
  return c.json({ data: { ready: v.readyToStream, duration_s: Math.round(v.duration) } });
});

/** Upload a handout to R2: PUT raw bytes. */
adminRoutes.put('/webinars/:id/handouts/:name', secret('webinars:write'), async (c) => {
  const w = await webinarFor(c, c.req.param('id'));
  if (!c.env.FILES) throw new HttpError(501, 'not_configured', 'R2 bucket not bound');
  const name = c.req.param('name').replace(/[^\w.\- ]/g, '_').slice(0, 120);
  const label = c.req.query('label') ?? name;
  await c.env.FILES.put(`${w.brand_id}/${w.id}/${name}`, c.req.raw.body, { httpMetadata: { contentType: c.req.header('content-type') ?? 'application/octet-stream' } });
  const list = parseJson<{ name: string; label?: string }[]>(w.handouts_json, []).filter((h) => h.name !== name);
  list.push({ name, label });
  await c.env.DB.prepare('UPDATE webinars SET handouts_json = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(list), nowIso(c.var.services.now()), w.id).run();
  await audit(c, 'webinar.handout', `${w.id}/${name}`, w.brand_id);
  return c.json({ data: { handouts: list } }, 201);
});

adminRoutes.get('/webinars/:id/slots', secret('webinars:read'), async (c) => {
  const w = await webinarFor(c, c.req.param('id'));
  return c.json({ data: await nextSlots(c.env.DB, w.id, c.var.services.now(), clampInt(c.req.query('count'), 1, 50, 10)) });
});

// =====================================================================
// Sessions
// =====================================================================

adminRoutes.get('/sessions', secret('webinars:read'), async (c) => {
  const w = await webinarFor(c, c.req.query('webinar_id') ?? '');
  const rows = await c.env.DB.prepare('SELECT * FROM sessions WHERE webinar_id = ? ORDER BY starts_at DESC LIMIT 200').bind(w.id).all<SessionRow>();
  return c.json({ data: rows.results ?? [] });
});

adminRoutes.post('/sessions', secret('webinars:write'), async (c) => {
  const body = await readJson(c);
  const w = await webinarFor(c, String(body.webinar_id ?? ''));
  if (w.type !== 'live') throw bad('Sessions are created for live webinars; evergreen sessions come from slot rules');
  if (!isIso(body.starts_at)) throw bad('starts_at (ISO) required');
  const starts = iso(body.starts_at);
  const ends = isIso(body.ends_at) ? iso(body.ends_at) : new Date(Date.parse(starts) + (w.duration_s ?? 3600) * 1000).toISOString();
  if (Date.parse(ends) <= Date.parse(starts)) throw bad('ends_at must be after starts_at');
  const id = newId('ses');
  await c.env.DB.prepare("INSERT INTO sessions (id, webinar_id, starts_at, ends_at, kind, status, created_at) VALUES (?,?,?,?,'live','scheduled',?)")
    .bind(id, w.id, starts, ends, nowIso(c.var.services.now())).run();
  await audit(c, 'session.create', id, w.brand_id);
  return c.json({ data: await getSession(c.env.DB, id) }, 201);
});

adminRoutes.get('/sessions/:id', secret('webinars:read'), async (c) => {
  const { session } = await sessionFor(c, c.req.param('id'));
  const counts = await c.env.DB.prepare(
    'SELECT (SELECT COUNT(*) FROM registrants WHERE session_id = ?) AS registrants, (SELECT COUNT(*) FROM attendance WHERE session_id = ?) AS attendees',
  ).bind(session.id, session.id).first();
  return c.json({ data: { ...session, ...counts } });
});

adminRoutes.patch('/sessions/:id', secret('webinars:write'), async (c) => {
  const { session, webinar } = await sessionFor(c, c.req.param('id'));
  const body = await readJson(c);
  const starts = isIso(body.starts_at) ? iso(body.starts_at) : session.starts_at;
  const ends = isIso(body.ends_at) ? iso(body.ends_at) : session.ends_at;
  await c.env.DB.prepare('UPDATE sessions SET starts_at = ?, ends_at = ? WHERE id = ?').bind(starts, ends, session.id).run();
  await audit(c, 'session.update', session.id, webinar.brand_id);
  return c.json({ data: await getSession(c.env.DB, session.id) });
});

adminRoutes.delete('/sessions/:id', secret('webinars:write'), async (c) => {
  const { session, webinar } = await sessionFor(c, c.req.param('id'));
  if (session.status === 'live') throw bad('End the session before deleting it');
  await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(session.id).run();
  await audit(c, 'session.delete', session.id, webinar.brand_id);
  return c.json({ data: { deleted: true } });
});

/** Open the room. `{ "test": true }` = private host preview (attendees still see the waiting room). */
adminRoutes.post('/sessions/:id/start', secret('webinars:write'), async (c) => {
  const { session, webinar } = await sessionFor(c, c.req.param('id'));
  if (session.kind !== 'live') throw bad('Only live sessions are started manually');
  if (session.status === 'ended') throw bad('Session already ended');
  if (!webinar.stream_live_input_id) throw bad('Create a live input first (POST /webinars/:id/live-input)');
  const body = await readJson<{ test?: boolean }>(c);
  await startSession(c.env, session, webinar, { test: body.test === true }, c.var.services.now());
  await audit(c, body.test ? 'session.preview' : 'session.start', session.id, webinar.brand_id);
  return c.json({ data: await getSession(c.env.DB, session.id) });
});

adminRoutes.post('/sessions/:id/end', secret('webinars:write'), async (c) => {
  const { session, webinar } = await sessionFor(c, c.req.param('id'));
  await endSession(c.env, c.var.services, session, webinar, c.var.services.now());
  await audit(c, 'session.end', session.id, webinar.brand_id);
  return c.json({ data: await getSession(c.env.DB, session.id) });
});

/** Host preview playback (works in test mode before attendees can see anything). */
adminRoutes.post('/sessions/:id/preview-playback', secret('webinars:write'), async (c) => {
  const { webinar } = await sessionFor(c, c.req.param('id'));
  const uid = webinar.type === 'live' ? webinar.stream_live_input_id : webinar.video_uid;
  if (!uid) throw bad('No video source yet');
  return c.json({ data: await c.var.services.stream.playback(uid, { live: webinar.type === 'live', nowMs: c.var.services.now() }) });
});

adminRoutes.post('/sessions/:id/push-cta', secret('moderation'), async (c) => {
  const { session, webinar } = await sessionFor(c, c.req.param('id'));
  const body = await readJson<{ cta_id?: string | null }>(c);
  if (!body.cta_id) {
    await roomControl(c.env, session.id, { action: 'hide_cta' });
  } else {
    const cta = await c.env.DB.prepare('SELECT * FROM ctas WHERE id = ? AND webinar_id = ?').bind(body.cta_id, webinar.id).first<CtaRow>();
    if (!cta) throw notFound('CTA not found');
    await roomControl(c.env, session.id, { action: 'push_cta', cta: { id: cta.id, label: cta.label, url: cta.url, style: cta.style, body: cta.body, image_url: cta.image_url } });
  }
  await audit(c, 'session.push_cta', `${session.id}:${body.cta_id ?? 'hide'}`, webinar.brand_id);
  return c.json({ data: { ok: true } });
});

adminRoutes.post('/sessions/:id/push-poll', secret('moderation'), async (c) => {
  const { session, webinar } = await sessionFor(c, c.req.param('id'));
  const body = await readJson<{ poll_id?: string | null; show_results?: boolean }>(c);
  if (!body.poll_id) {
    await roomControl(c.env, session.id, { action: 'close_poll' });
  } else {
    const p = await c.env.DB.prepare('SELECT * FROM polls WHERE id = ? AND webinar_id = ?').bind(body.poll_id, webinar.id).first<PollRow>();
    if (!p) throw notFound('Poll not found');
    await roomControl(c.env, session.id, { action: 'push_poll', poll: { id: p.id, question: p.question, options: parseJson(p.options_json, []), show_results: body.show_results === true } });
  }
  await audit(c, 'session.push_poll', `${session.id}:${body.poll_id ?? 'close'}`, webinar.brand_id);
  return c.json({ data: { ok: true } });
});

adminRoutes.post('/sessions/:id/announce', secret('moderation'), async (c) => {
  const { session, webinar } = await sessionFor(c, c.req.param('id'));
  const body = await readJson<{ body?: string }>(c);
  if (!body.body) throw bad('body required');
  await roomControl(c.env, session.id, { action: 'announce', body: body.body });
  await audit(c, 'session.announce', session.id, webinar.brand_id);
  return c.json({ data: { ok: true } });
});

/** Console link for a host or moderator (moderators can't push CTAs/polls or change settings). */
adminRoutes.post('/sessions/:id/host-token', secret('moderation'), async (c) => {
  const { session, webinar } = await sessionFor(c, c.req.param('id'));
  const body = await readJson<{ role?: string; name?: string; ttl_hours?: number }>(c);
  const role = body.role === 'moderator' ? 'moderator' : 'host';
  const hid = newId('hst');
  const token = await mintHostToken(c.env.TOKEN_SECRET, {
    sid: session.id, wid: webinar.id, bid: webinar.brand_id, mode: webinar.mode, role, name: str(body.name, 80) ?? (role === 'host' ? 'Host' : 'Moderator'), hid,
  }, clampInt(body.ttl_hours, 1, 72, 12) * 3600, c.var.services.now());
  const pk = await c.env.DB.prepare("SELECT display FROM api_keys WHERE brand_id = ? AND type = 'pk' AND mode = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1")
    .bind(webinar.brand_id, webinar.mode).first<{ display: string }>();
  if (!pk) throw bad('Create a publishable key for this brand first');
  await audit(c, `session.host_token.${role}`, session.id, webinar.brand_id);
  const consoleUrl = new URL(`/frame/console`, c.env.PUBLIC_ORIGIN);
  consoleUrl.hash = new URLSearchParams({ key: pk.display, session: session.id, token }).toString();
  return c.json({ data: { role, token, console_url: consoleUrl.toString() } }, 201);
});

adminRoutes.get('/sessions/:id/messages', secret('moderation'), async (c) => {
  const { session } = await sessionFor(c, c.req.param('id'));
  const kind = c.req.query('kind');
  const rows = await c.env.DB.prepare(`SELECT * FROM messages WHERE session_id = ? ${kind ? 'AND kind = ?' : ''} ORDER BY created_at`)
    .bind(...[session.id, ...(kind ? [kind] : [])]).all();
  if (wantsCsv(c)) return c.body(toCsv(rows.results ?? []), 200, { 'content-type': 'text/csv' });
  return c.json({ data: rows.results ?? [] });
});

// =====================================================================
// Slot rules, CTAs, polls (child resources of a webinar)
// =====================================================================

adminRoutes.get('/slot-rules', secret('webinars:read'), async (c) => {
  const w = await webinarFor(c, c.req.query('webinar_id') ?? '');
  const rows = await c.env.DB.prepare('SELECT * FROM slot_rules WHERE webinar_id = ?').bind(w.id).all();
  return c.json({ data: (rows.results ?? []).map((r) => ({ ...r, rule: parseJson(r.rule_json as string, {}) })) });
});

function slotRuleFields(body: Record<string, unknown>) {
  const kind = body.kind as string;
  if (!['fixed', 'interval', 'just_in_time'].includes(kind)) throw bad('kind must be fixed, interval or just_in_time');
  const rule = obj(body.rule) ?? {};
  const tz = str(body.timezone, 64) ?? 'Europe/London';
  if (!isValidTimezone(tz)) throw bad('Unknown timezone');
  if (kind === 'fixed' && !arr(rule.times)?.length && !arr(rule.dates)?.length) throw bad('fixed rules need times (with optional days) or dates');
  if (kind === 'interval' && !Number(rule.every_minutes)) throw bad('interval rules need every_minutes');
  return { kind, rule_json: JSON.stringify(rule), timezone: tz, active: body.active === false ? 0 : 1 };
}

adminRoutes.post('/slot-rules', secret('webinars:write'), async (c) => {
  const body = await readJson(c);
  const w = await webinarFor(c, String(body.webinar_id ?? ''));
  if (w.type !== 'evergreen') throw bad('Slot rules are for evergreen webinars');
  const f = slotRuleFields(body);
  const id = newId('slr');
  await c.env.DB.prepare('INSERT INTO slot_rules (id, webinar_id, kind, rule_json, timezone, active, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind(id, w.id, f.kind, f.rule_json, f.timezone, f.active, nowIso(c.var.services.now())).run();
  await audit(c, 'slot_rule.create', id, w.brand_id);
  return c.json({ data: { id, ...f, rule: parseJson(f.rule_json, {}), next: await nextSlots(c.env.DB, w.id, c.var.services.now(), 5) } }, 201);
});

async function childFor(c: Ctx, table: 'slot_rules' | 'ctas' | 'polls', id: string) {
  const row = await c.env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<{ id: string; webinar_id: string }>();
  if (!row) throw notFound();
  const webinar = await webinarFor(c, row.webinar_id);
  return { row, webinar };
}

adminRoutes.patch('/slot-rules/:id', secret('webinars:write'), async (c) => {
  const { row, webinar } = await childFor(c, 'slot_rules', c.req.param('id'));
  const cur = row as unknown as { kind: string; rule_json: string; timezone: string; active: number };
  const body = await readJson(c);
  const f = slotRuleFields({ kind: body.kind ?? cur.kind, rule: body.rule ?? parseJson(cur.rule_json, {}), timezone: body.timezone ?? cur.timezone, active: body.active ?? cur.active === 1 });
  await c.env.DB.prepare('UPDATE slot_rules SET kind = ?, rule_json = ?, timezone = ?, active = ? WHERE id = ?').bind(f.kind, f.rule_json, f.timezone, f.active, row.id).run();
  await audit(c, 'slot_rule.update', row.id, webinar.brand_id);
  return c.json({ data: { id: row.id, ...f, rule: parseJson(f.rule_json, {}) } });
});

adminRoutes.delete('/slot-rules/:id', secret('webinars:write'), async (c) => {
  const { row, webinar } = await childFor(c, 'slot_rules', c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM slot_rules WHERE id = ?').bind(row.id).run();
  await audit(c, 'slot_rule.delete', row.id, webinar.brand_id);
  return c.json({ data: { deleted: true } });
});

function ctaFields(body: Record<string, unknown>, cur?: CtaRow) {
  const label = str(body.label, 120) ?? cur?.label;
  const url = str(body.url, 2000) ?? cur?.url;
  if (!label) throw bad('label required');
  if (!url || !/^https?:\/\//.test(url)) throw bad('url must be http(s)');
  const style = (body.style ?? cur?.style ?? 'button') as string;
  if (!['button', 'card'].includes(style)) throw bad('style must be button or card');
  const push = (body.push_mode ?? cur?.push_mode ?? (body.show_at_s !== undefined ? 'timed' : 'manual')) as string;
  if (!['timed', 'manual'].includes(push)) throw bad('push_mode must be timed or manual');
  const num = (v: unknown, d: number | null | undefined) => (v === undefined ? d ?? null : v === null ? null : clampInt(v, 0, 24 * 3600, 0));
  return {
    label, url, style, push_mode: push,
    body: body.body !== undefined ? str(body.body, 1000) ?? null : cur?.body ?? null,
    image_url: body.image_url !== undefined ? str(body.image_url, 2000) ?? null : cur?.image_url ?? null,
    show_at_s: num(body.show_at_s, cur?.show_at_s),
    hide_at_s: num(body.hide_at_s, cur?.hide_at_s),
  };
}

adminRoutes.get('/ctas', secret('webinars:read'), async (c) => {
  const w = await webinarFor(c, c.req.query('webinar_id') ?? '');
  return c.json({ data: (await c.env.DB.prepare('SELECT * FROM ctas WHERE webinar_id = ? ORDER BY show_at_s').bind(w.id).all()).results ?? [] });
});

adminRoutes.post('/ctas', secret('webinars:write'), async (c) => {
  const body = await readJson(c);
  const w = await webinarFor(c, String(body.webinar_id ?? ''));
  const f = ctaFields(body);
  const id = newId('cta');
  await c.env.DB.prepare('INSERT INTO ctas (id, webinar_id, label, url, style, body, image_url, show_at_s, hide_at_s, push_mode, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, w.id, f.label, f.url, f.style, f.body, f.image_url, f.show_at_s, f.hide_at_s, f.push_mode, nowIso(c.var.services.now())).run();
  await audit(c, 'cta.create', id, w.brand_id);
  return c.json({ data: { id, webinar_id: w.id, ...f } }, 201);
});

adminRoutes.patch('/ctas/:id', secret('webinars:write'), async (c) => {
  const { row, webinar } = await childFor(c, 'ctas', c.req.param('id'));
  const f = ctaFields(await readJson(c), row as unknown as CtaRow);
  await c.env.DB.prepare('UPDATE ctas SET label = ?, url = ?, style = ?, body = ?, image_url = ?, show_at_s = ?, hide_at_s = ?, push_mode = ? WHERE id = ?')
    .bind(f.label, f.url, f.style, f.body, f.image_url, f.show_at_s, f.hide_at_s, f.push_mode, row.id).run();
  await audit(c, 'cta.update', row.id, webinar.brand_id);
  return c.json({ data: { id: row.id, webinar_id: webinar.id, ...f } });
});

adminRoutes.delete('/ctas/:id', secret('webinars:write'), async (c) => {
  const { row, webinar } = await childFor(c, 'ctas', c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM ctas WHERE id = ?').bind(row.id).run();
  await audit(c, 'cta.delete', row.id, webinar.brand_id);
  return c.json({ data: { deleted: true } });
});

function pollFields(body: Record<string, unknown>, cur?: PollRow) {
  const question = str(body.question, 300) ?? cur?.question;
  if (!question) throw bad('question required');
  const options = (arr(body.options) ?? parseJson<string[]>(cur?.options_json ?? '[]', [])).map((o) => String(o).trim().slice(0, 120)).filter(Boolean);
  if (options.length < 2 || options.length > 10) throw bad('2–10 options required');
  return {
    question,
    options_json: JSON.stringify(options),
    show_at_s: body.show_at_s === undefined ? cur?.show_at_s ?? null : body.show_at_s === null ? null : clampInt(body.show_at_s, 0, 24 * 3600, 0),
    crm_field: body.crm_field !== undefined ? str(body.crm_field, 120) ?? null : cur?.crm_field ?? null,
  };
}

adminRoutes.get('/polls', secret('webinars:read'), async (c) => {
  const w = await webinarFor(c, c.req.query('webinar_id') ?? '');
  const rows = await c.env.DB.prepare('SELECT * FROM polls WHERE webinar_id = ? ORDER BY show_at_s').bind(w.id).all<PollRow>();
  return c.json({ data: (rows.results ?? []).map((p) => ({ ...p, options: parseJson(p.options_json, []) })) });
});

adminRoutes.post('/polls', secret('webinars:write'), async (c) => {
  const body = await readJson(c);
  const w = await webinarFor(c, String(body.webinar_id ?? ''));
  const f = pollFields(body);
  const id = newId('pol');
  await c.env.DB.prepare('INSERT INTO polls (id, webinar_id, question, options_json, show_at_s, crm_field, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind(id, w.id, f.question, f.options_json, f.show_at_s, f.crm_field, nowIso(c.var.services.now())).run();
  await audit(c, 'poll.create', id, w.brand_id);
  return c.json({ data: { id, webinar_id: w.id, ...f, options: parseJson(f.options_json, []) } }, 201);
});

adminRoutes.patch('/polls/:id', secret('webinars:write'), async (c) => {
  const { row, webinar } = await childFor(c, 'polls', c.req.param('id'));
  const f = pollFields(await readJson(c), row as unknown as PollRow);
  await c.env.DB.prepare('UPDATE polls SET question = ?, options_json = ?, show_at_s = ?, crm_field = ? WHERE id = ?').bind(f.question, f.options_json, f.show_at_s, f.crm_field, row.id).run();
  await audit(c, 'poll.update', row.id, webinar.brand_id);
  return c.json({ data: { id: row.id, ...f, options: parseJson(f.options_json, []) } });
});

adminRoutes.delete('/polls/:id', secret('webinars:write'), async (c) => {
  const { row, webinar } = await childFor(c, 'polls', c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM polls WHERE id = ?').bind(row.id).run();
  await audit(c, 'poll.delete', row.id, webinar.brand_id);
  return c.json({ data: { deleted: true } });
});

adminRoutes.get('/polls/:id/results', secret('analytics:read'), async (c) => {
  const { row } = await childFor(c, 'polls', c.req.param('id'));
  const p = row as unknown as PollRow;
  const votes = await c.env.DB.prepare('SELECT option, COUNT(*) AS n FROM poll_votes WHERE poll_id = ? GROUP BY option').bind(p.id).all<{ option: string; n: number }>();
  const counts = Object.fromEntries(parseJson<string[]>(p.options_json, []).map((o) => [o, 0]));
  for (const v of votes.results ?? []) counts[v.option] = v.n;
  return c.json({ data: { poll_id: p.id, question: p.question, results: counts, total: Object.values(counts).reduce((a, b) => a + b, 0) } });
});

// =====================================================================
// Messages (moderation)
// =====================================================================

adminRoutes.patch('/messages/:id', secret('moderation'), async (c) => {
  const m = await c.env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(c.req.param('id')).first<Record<string, unknown> & { id: string; session_id: string; status: string; done_at: string | null }>();
  if (!m) throw notFound('Message not found (messages reach D1 a couple of seconds after they are sent)');
  const { webinar } = await sessionFor(c, m.session_id);
  const body = await readJson<{ status?: string; done?: boolean; answer?: string }>(c);
  if (body.status && !['visible', 'hidden', 'pinned'].includes(body.status)) throw bad('status must be visible, hidden or pinned');
  const status = body.status ?? m.status;
  const done = body.done === undefined ? m.done_at : body.done ? nowIso(c.var.services.now()) : null;
  await c.env.DB.prepare('UPDATE messages SET status = ?, done_at = ? WHERE id = ?').bind(status, done, m.id).run();
  const updated = { ...m, status, done_at: done };
  await roomControl(c.env, m.session_id, { action: 'message_update', message: updated });
  if (body.answer) await roomControl(c.env, m.session_id, { action: 'answer', message_id: m.id, body: body.answer, actor: { role: 'host', name: 'Host' } });
  await audit(c, 'message.update', m.id, webinar.brand_id);
  return c.json({ data: updated });
});

// =====================================================================
// Registrants, attendance, analytics, events
// =====================================================================

const REGISTRANT_COLS = 'r.id, r.webinar_id, r.session_id, r.email, r.name, r.phone, r.answers_json, r.consent_json, r.utm_json, r.source_url, r.access_expires_at, r.banned, r.ghq_contact_id, r.created_at, r.updated_at';

adminRoutes.get('/registrants', secret('registrants:read'), async (c) => {
  const brandId = brandScope(c);
  const where = ['r.brand_id = ?', 'r.mode = ?'];
  const args: unknown[] = [brandId, c.var.sk.mode];
  for (const [q, col] of [['webinar_id', 'r.webinar_id'], ['session_id', 'r.session_id']] as const) {
    const v = c.req.query(q);
    if (v) { where.push(`${col} = ?`); args.push(v); }
  }
  const email = c.req.query('email');
  if (email) { where.push('r.email = ?'); args.push(normaliseEmail(email)); }
  const limit = clampInt(c.req.query('limit'), 1, 5000, wantsCsv(c) ? 5000 : 200);
  const offset = clampInt(c.req.query('offset'), 0, 1e9, 0);
  const rows = await c.env.DB.prepare(
    `SELECT ${REGISTRANT_COLS}, a.joined_at, a.watch_s, a.max_position_s FROM registrants r
       LEFT JOIN attendance a ON a.registrant_id = r.id AND a.session_id = r.session_id
      WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(...args, limit, offset).all<Record<string, unknown>>();
  const data = (rows.results ?? []).map((r) => {
    const utm = parseJson<Record<string, string>>(r.utm_json as string, {});
    return { ...r, answers: parseJson(r.answers_json as string, {}), consent: parseJson(r.consent_json as string, {}), utm, attended: !!r.joined_at, answers_json: undefined, consent_json: undefined, utm_json: undefined };
  });
  if (wantsCsv(c)) {
    const flat = data.map((r) => ({ ...r, utm_source: r.utm.source, utm_medium: r.utm.medium, utm_campaign: r.utm.campaign, consent_version: (r.consent as { version?: string }).version, consent_ts: (r.consent as { ts?: string }).ts }));
    return c.body(toCsv(flat, ['id', 'email', 'name', 'phone', 'webinar_id', 'session_id', 'created_at', 'attended', 'joined_at', 'watch_s', 'utm_source', 'utm_medium', 'utm_campaign', 'source_url', 'consent_version', 'consent_ts', 'answers']), 200, {
      'content-type': 'text/csv', 'content-disposition': 'attachment; filename="registrants.csv"',
    });
  }
  return c.json({ data });
});

adminRoutes.get('/registrants/:id', secret('registrants:read'), async (c) => {
  const r = await c.env.DB.prepare(`SELECT ${REGISTRANT_COLS}, r.brand_id, r.mode FROM registrants r WHERE r.id = ?`).bind(c.req.param('id')).first<Record<string, unknown>>();
  if (!r || r.mode !== c.var.sk.mode) throw notFound();
  assertBrand(c, r.brand_id as string);
  const attendance = await c.env.DB.prepare('SELECT * FROM attendance WHERE registrant_id = ?').bind(r.id).all();
  const events = await c.env.DB.prepare('SELECT id, type, session_id, ts FROM events WHERE registrant_id = ? ORDER BY ts').bind(r.id).all();
  return c.json({ data: { ...r, attendance: attendance.results ?? [], events: events.results ?? [] } });
});

adminRoutes.patch('/registrants/:id', secret('registrants:write'), async (c) => {
  const r = await c.env.DB.prepare('SELECT id, brand_id, mode, session_id FROM registrants WHERE id = ?').bind(c.req.param('id')).first<{ id: string; brand_id: string; mode: string; session_id: string | null }>();
  if (!r || r.mode !== c.var.sk.mode) throw notFound();
  assertBrand(c, r.brand_id);
  const body = await readJson(c);
  const sets: string[] = [];
  const args: unknown[] = [];
  if (body.ghq_contact_id !== undefined) { sets.push('ghq_contact_id = ?'); args.push(str(body.ghq_contact_id) ?? null); }
  if (body.access_expires_at !== undefined) { sets.push('access_expires_at = ?'); args.push(isIso(body.access_expires_at) ? iso(body.access_expires_at) : null); }
  if (body.banned !== undefined) { sets.push('banned = ?'); args.push(body.banned ? 1 : 0); }
  if (sets.length) {
    await c.env.DB.prepare(`UPDATE registrants SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...args, nowIso(c.var.services.now()), r.id).run();
    if (body.banned && r.session_id) await roomControl(c.env, r.session_id, { action: 'ban', registrant_id: r.id });
    await audit(c, 'registrant.update', r.id, r.brand_id);
  }
  return c.json({ data: { ok: true } });
});

adminRoutes.get('/attendance', secret('registrants:read'), async (c) => {
  const w = await webinarFor(c, c.req.query('webinar_id') ?? '');
  const sid = c.req.query('session_id');
  const rows = await c.env.DB.prepare(
    `SELECT a.*, r.email, r.name, s.kind AS session_kind, s.starts_at FROM attendance a
       JOIN registrants r ON r.id = a.registrant_id JOIN sessions s ON s.id = a.session_id
      WHERE s.webinar_id = ? ${sid ? 'AND a.session_id = ?' : ''} ORDER BY a.joined_at`,
  ).bind(...[w.id, ...(sid ? [sid] : [])]).all<Record<string, unknown>>();
  const dur = w.duration_s ?? 0;
  const data = (rows.results ?? []).map((a) => ({ ...a, percent_watched: dur ? Math.min(100, Math.round(((a.watch_s as number) / dur) * 100)) : null }));
  if (wantsCsv(c)) return c.body(toCsv(data), 200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="attendance.csv"' });
  return c.json({ data });
});

adminRoutes.get('/analytics', secret('analytics:read'), async (c) => {
  const w = await webinarFor(c, c.req.query('webinar_id') ?? '');
  const db = c.env.DB;
  const regs = await db.prepare('SELECT COUNT(*) AS n FROM registrants WHERE webinar_id = ?').bind(w.id).first<{ n: number }>();
  const att = await db.prepare(
    'SELECT COUNT(DISTINCT a.registrant_id) AS attendees, AVG(a.watch_s) AS avg_watch_s FROM attendance a JOIN sessions s ON s.id = a.session_id WHERE s.webinar_id = ?',
  ).bind(w.id).first<{ attendees: number; avg_watch_s: number | null }>();
  const live = await db.prepare(
    "SELECT COUNT(DISTINCT a.registrant_id) AS n FROM attendance a JOIN sessions s ON s.id = a.session_id WHERE s.webinar_id = ? AND s.kind != 'on_demand'",
  ).bind(w.id).first<{ n: number }>();
  const clicks = await db.prepare(
    "SELECT json_extract(data_json, '$.data.cta_id') AS cta_id, json_extract(data_json, '$.data.label') AS label, COUNT(*) AS clicks, COUNT(DISTINCT registrant_id) AS unique_clickers FROM events WHERE webinar_id = ? AND type = 'cta.clicked' GROUP BY cta_id",
  ).bind(w.id).all<{ cta_id: string; label: string; clicks: number; unique_clickers: number }>();
  const questions = await db.prepare("SELECT COUNT(*) AS n FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.webinar_id = ? AND m.kind = 'question'").bind(w.id).first<{ n: number }>();

  // Retention: share of attendees whose furthest playhead reached each minute.
  const positions = await db.prepare('SELECT a.max_position_s AS p, a.watch_s AS w FROM attendance a JOIN sessions s ON s.id = a.session_id WHERE s.webinar_id = ?').bind(w.id).all<{ p: number; w: number }>();
  const pos = (positions.results ?? []).map((r) => Math.max(r.p, w.type === 'live' ? r.w : 0));
  const minutes = Math.ceil((w.duration_s ?? Math.max(60, ...pos)) / 60);
  const retention = pos.length
    ? Array.from({ length: Math.min(minutes, 600) }, (_, m) => ({ minute: m, pct: Math.round((pos.filter((p) => p >= m * 60).length / pos.length) * 100) }))
    : [];

  const utm = await db.prepare(
    `SELECT COALESCE(json_extract(r.utm_json, '$.source'), '(direct)') AS source, COUNT(*) AS registrations,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM attendance a WHERE a.registrant_id = r.id) THEN 1 ELSE 0 END) AS attendees,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM events e WHERE e.registrant_id = r.id AND e.type = 'cta.clicked') THEN 1 ELSE 0 END) AS cta_clickers
       FROM registrants r WHERE r.webinar_id = ? GROUP BY source ORDER BY registrations DESC`,
  ).bind(w.id).all();

  const polls = await db.prepare('SELECT p.id, p.question, v.option, COUNT(v.option) AS n FROM polls p LEFT JOIN poll_votes v ON v.poll_id = p.id WHERE p.webinar_id = ? GROUP BY p.id, v.option').bind(w.id).all<{ id: string; question: string; option: string | null; n: number }>();
  const pollMap = new Map<string, { id: string; question: string; results: Record<string, number> }>();
  for (const r of polls.results ?? []) {
    const p = pollMap.get(r.id) ?? { id: r.id, question: r.question, results: {} };
    if (r.option) p.results[r.option] = r.n;
    pollMap.set(r.id, p);
  }

  const registrations = regs?.n ?? 0;
  const attendees = att?.attendees ?? 0;
  return c.json({
    data: {
      webinar_id: w.id,
      registrations,
      attendees,
      live_attendees: live?.n ?? 0,
      show_rate_pct: registrations ? Math.round(((live?.n ?? 0) / registrations) * 100) : 0,
      avg_watch_s: Math.round(att?.avg_watch_s ?? 0),
      questions: questions?.n ?? 0,
      ctas: (clicks.results ?? []).map((x) => ({ ...x, ctr_pct: attendees ? Math.round((x.unique_clickers / attendees) * 100) : 0 })),
      polls: [...pollMap.values()],
      retention,
      by_utm_source: utm.results ?? [],
    },
  });
});

adminRoutes.get('/events', secret('analytics:read'), async (c) => {
  const brandId = brandScope(c);
  const type = c.req.query('type');
  const since = c.req.query('since');
  const rows = await c.env.DB.prepare(
    `SELECT id, type, registrant_id, session_id, webinar_id, ts, data_json FROM events WHERE brand_id = ? AND mode = ? ${type ? 'AND type = ?' : ''} ${since ? 'AND ts > ?' : ''} ORDER BY ts LIMIT ?`,
  ).bind(...[brandId, c.var.sk.mode, ...(type ? [type] : []), ...(since ? [since] : []), clampInt(c.req.query('limit'), 1, 1000, 200)]).all<Record<string, unknown>>();
  return c.json({ data: (rows.results ?? []).map((e) => ({ ...e, payload: parseJson(e.data_json as string, {}), data_json: undefined })) });
});

adminRoutes.get('/audit-log', secret('brands:read'), async (c) => {
  const brandId = c.var.sk.brandId ?? requestedBrand(c);
  const rows = brandId
    ? await c.env.DB.prepare('SELECT * FROM audit_log WHERE brand_id = ? ORDER BY ts DESC LIMIT 500').bind(brandId).all()
    : await c.env.DB.prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT 500').all();
  return c.json({ data: rows.results ?? [] });
});

// =====================================================================
// GDPR erasure
// =====================================================================

adminRoutes.delete('/contacts/:email', secret('gdpr'), async (c) => {
  const email = normaliseEmail(decodeURIComponent(c.req.param('email')));
  const own = c.var.sk.brandId;
  const regs = await c.env.DB.prepare(`SELECT id, session_id, brand_id FROM registrants WHERE email = ? ${own ? 'AND brand_id = ?' : ''}`)
    .bind(...[email, ...(own ? [own] : [])]).all<{ id: string; session_id: string | null; brand_id: string }>();
  const list = regs.results ?? [];
  if (list.length) {
    const ids = list.map((r) => r.id);
    const ph = ids.map(() => '?').join(',');
    await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM webhook_deliveries WHERE event_id IN (SELECT id FROM events WHERE registrant_id IN (${ph}))`).bind(...ids),
      c.env.DB.prepare(`DELETE FROM events WHERE registrant_id IN (${ph})`).bind(...ids),
      c.env.DB.prepare(`DELETE FROM messages WHERE registrant_id IN (${ph})`).bind(...ids),
      c.env.DB.prepare(`DELETE FROM poll_votes WHERE registrant_id IN (${ph})`).bind(...ids),
      c.env.DB.prepare(`DELETE FROM attendance WHERE registrant_id IN (${ph})`).bind(...ids),
      c.env.DB.prepare(`DELETE FROM registrants WHERE id IN (${ph})`).bind(...ids),
    ]);
    // Purge the live caches of every room they were in (registered session and replay sessions).
    const sessions = new Set(list.map((r) => r.session_id).filter(Boolean) as string[]);
    for (const sid of sessions) await roomControl(c.env, sid, { action: 'erase', registrant_ids: ids });
  }
  await audit(c, 'gdpr.erase', await sha256Hex(email), own);
  return c.json({ data: { erased_registrations: list.length } });
});

// =====================================================================
// API keys
// =====================================================================

const keyOut = (k: ApiKeyRow) => ({
  id: k.id, brand_id: k.brand_id, type: k.type, mode: k.mode, prefix: k.prefix, name: k.name,
  key: k.type === 'pk' ? k.display : undefined,
  scopes: parseJson(k.scopes, []), allowed_origins: parseJson(k.allowed_origins, []),
  last_used_at: k.last_used_at, revoked_at: k.revoked_at, created_at: k.created_at,
});

function keyScopes(v: unknown): string[] {
  const list = (arr(v) ?? ['*']).map(String);
  for (const s of list) if (s !== '*' && !SCOPES.includes(s as never) && !/^[a-z]+:\*$/.test(s)) throw bad(`Unknown scope ${s}`);
  return list;
}

async function createKey(c: Ctx, opts: { brandId: string | null; type: 'pk' | 'sk'; name: string | null; scopes: string[]; origins: string[] }) {
  const mode = c.var.sk.mode; // test secret keys can only make test keys, and vice versa
  const { raw, prefix } = generateApiKey(opts.type, mode);
  const id = newId('key');
  await c.env.DB.prepare('INSERT INTO api_keys (id, brand_id, type, mode, prefix, hash, display, name, scopes, allowed_origins, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, opts.brandId, opts.type, mode, prefix, await sha256Hex(raw), opts.type === 'pk' ? raw : null, opts.name,
      JSON.stringify(opts.type === 'pk' ? ['public'] : opts.scopes), JSON.stringify(opts.origins), nowIso(c.var.services.now())).run();
  return { id, raw };
}

adminRoutes.get('/api-keys', secret('keys:write'), async (c) => {
  const own = c.var.sk.brandId;
  const brand = own ?? requestedBrand(c);
  const rows = brand
    ? await c.env.DB.prepare('SELECT * FROM api_keys WHERE brand_id = ? AND mode = ? ORDER BY created_at DESC').bind(brand, c.var.sk.mode).all<ApiKeyRow>()
    : await c.env.DB.prepare('SELECT * FROM api_keys WHERE mode = ? ORDER BY created_at DESC').bind(c.var.sk.mode).all<ApiKeyRow>();
  return c.json({ data: (rows.results ?? []).map(keyOut) });
});

adminRoutes.post('/api-keys', secret('keys:write'), async (c) => {
  const body = await readJson(c);
  const type = body.type === 'pk' ? 'pk' : body.type === 'sk' ? 'sk' : null;
  if (!type) throw bad('type must be pk or sk');
  const own = c.var.sk.brandId;
  const brandId = (str(body.brand_id) ?? own) || null;
  if (own && brandId !== own) throw forbidden();
  if (type === 'pk' && !brandId) throw bad('Publishable keys belong to a brand');
  if (!brandId && own) throw forbidden();
  if (brandId) await brandRow(c, brandId);
  const origins = (arr(body.allowed_origins) ?? []).map((o) => String(o).trim()).filter((o) => /^https?:\/\/[^/]+$/.test(o));
  const { id, raw } = await createKey(c, { brandId, type, name: str(body.name, 80) ?? null, scopes: keyScopes(body.scopes), origins });
  await audit(c, `api_key.create.${type}`, id, brandId);
  const row = (await c.env.DB.prepare('SELECT * FROM api_keys WHERE id = ?').bind(id).first<ApiKeyRow>())!;
  return c.json({ data: { ...keyOut(row), key: raw, note: type === 'sk' ? 'Shown once. Store it securely.' : undefined } }, 201);
});

async function keyFor(c: Ctx, id: string): Promise<ApiKeyRow> {
  const k = await c.env.DB.prepare('SELECT * FROM api_keys WHERE id = ?').bind(id).first<ApiKeyRow>();
  if (!k || k.mode !== c.var.sk.mode) throw notFound();
  if (c.var.sk.brandId && k.brand_id !== c.var.sk.brandId) throw notFound();
  return k;
}

adminRoutes.patch('/api-keys/:id', secret('keys:write'), async (c) => {
  const k = await keyFor(c, c.req.param('id'));
  const body = await readJson(c);
  const origins = body.allowed_origins !== undefined ? (arr(body.allowed_origins) ?? []).map(String).filter((o) => /^https?:\/\/[^/]+$/.test(o)) : parseJson<string[]>(k.allowed_origins, []);
  const scopes = body.scopes !== undefined && k.type === 'sk' ? keyScopes(body.scopes) : parseJson<string[]>(k.scopes, []);
  await c.env.DB.prepare('UPDATE api_keys SET name = ?, allowed_origins = ?, scopes = ? WHERE id = ?')
    .bind(str(body.name, 80) ?? k.name, JSON.stringify(origins), JSON.stringify(scopes), k.id).run();
  await audit(c, 'api_key.update', k.id, k.brand_id);
  return c.json({ data: keyOut((await keyFor(c, k.id))) });
});

/** Issue a replacement and revoke the old key (immediately, or after `grace_minutes`). */
adminRoutes.post('/api-keys/:id/rotate', secret('keys:write'), async (c) => {
  const k = await keyFor(c, c.req.param('id'));
  if (k.revoked_at && Date.parse(k.revoked_at) <= c.var.services.now()) throw bad('Key already revoked');
  const body = await readJson(c);
  const { id, raw } = await createKey(c, { brandId: k.brand_id, type: k.type, name: k.name, scopes: parseJson(k.scopes, ['*']), origins: parseJson(k.allowed_origins, []) });
  const grace = clampInt(body.grace_minutes, 0, 7 * 24 * 60, 0);
  // Old key keeps working for `grace_minutes` so deployed sites can switch over.
  await c.env.DB.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').bind(nowIso(c.var.services.now() + grace * 60_000), k.id).run();
  await audit(c, 'api_key.rotate', `${k.id}->${id}`, k.brand_id);
  const row = (await c.env.DB.prepare('SELECT * FROM api_keys WHERE id = ?').bind(id).first<ApiKeyRow>())!;
  return c.json({ data: { ...keyOut(row), key: raw, replaced: k.id, old_key_expires_at: nowIso(c.var.services.now() + grace * 60_000) } }, 201);
});

adminRoutes.delete('/api-keys/:id', secret('keys:write'), async (c) => {
  const k = await keyFor(c, c.req.param('id'));
  if (k.id === c.var.sk.key.id) throw bad('A key cannot revoke itself; use another key or rotate');
  await c.env.DB.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(nowIso(c.var.services.now()), k.id).run();
  await audit(c, 'api_key.revoke', k.id, k.brand_id);
  return c.json({ data: { revoked: true } });
});

// =====================================================================
// Webhook endpoints + deliveries
// =====================================================================

function eventList(v: unknown): string[] {
  const list = (arr(v) ?? ['*']).map(String);
  for (const e of list) if (e !== '*' && !EVENT_TYPES.includes(e as never)) throw bad(`Unknown event ${e}`);
  return list;
}

adminRoutes.get('/webhook-endpoints', secret('webhooks:write'), async (c) => {
  const brandId = brandScope(c);
  const rows = await c.env.DB.prepare('SELECT id, brand_id, mode, url, events, active, created_at FROM webhook_endpoints WHERE brand_id = ? AND mode = ?').bind(brandId, c.var.sk.mode).all<Record<string, unknown>>();
  return c.json({ data: (rows.results ?? []).map((r) => ({ ...r, events: parseJson(r.events as string, []) })) });
});

adminRoutes.post('/webhook-endpoints', secret('webhooks:write'), async (c) => {
  const body = await readJson(c);
  const brandId = brandScope(c, body);
  await brandRow(c, brandId);
  const url = str(body.url, 2000);
  if (!url || !/^https:\/\//.test(url)) throw bad('url must be https');
  const secretValue = `whsec_${randomString(40)}`;
  const id = newId('whe');
  const events = eventList(body.events);
  await c.env.DB.prepare('INSERT INTO webhook_endpoints (id, brand_id, mode, url, secret_enc, secret_hash, events, active, created_at) VALUES (?,?,?,?,?,?,?,1,?)')
    .bind(id, brandId, c.var.sk.mode, url, await encryptSecret(c.env.DATA_KEY, secretValue), await sha256Hex(secretValue), JSON.stringify(events), nowIso(c.var.services.now())).run();
  await audit(c, 'webhook_endpoint.create', id, brandId);
  return c.json({ data: { id, url, events, mode: c.var.sk.mode, secret: secretValue, note: 'Shown once. Verify GHQ-Signature with it.' } }, 201);
});

async function endpointFor(c: Ctx, id: string) {
  const e = await c.env.DB.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').bind(id).first<{ id: string; brand_id: string; mode: string; url: string; events: string; active: number }>();
  if (!e || e.mode !== c.var.sk.mode) throw notFound();
  assertBrand(c, e.brand_id);
  return e;
}

adminRoutes.patch('/webhook-endpoints/:id', secret('webhooks:write'), async (c) => {
  const e = await endpointFor(c, c.req.param('id'));
  const body = await readJson(c);
  const url = body.url !== undefined ? str(body.url, 2000) : e.url;
  if (!url || !/^https:\/\//.test(url)) throw bad('url must be https');
  const events = body.events !== undefined ? eventList(body.events) : parseJson<string[]>(e.events, ['*']);
  const active = body.active === undefined ? e.active : body.active ? 1 : 0;
  await c.env.DB.prepare('UPDATE webhook_endpoints SET url = ?, events = ?, active = ? WHERE id = ?').bind(url, JSON.stringify(events), active, e.id).run();
  await audit(c, 'webhook_endpoint.update', e.id, e.brand_id);
  return c.json({ data: { id: e.id, url, events, active: !!active } });
});

adminRoutes.post('/webhook-endpoints/:id/rotate-secret', secret('webhooks:write'), async (c) => {
  const e = await endpointFor(c, c.req.param('id'));
  const secretValue = `whsec_${randomString(40)}`;
  await c.env.DB.prepare('UPDATE webhook_endpoints SET secret_enc = ?, secret_hash = ? WHERE id = ?')
    .bind(await encryptSecret(c.env.DATA_KEY, secretValue), await sha256Hex(secretValue), e.id).run();
  await audit(c, 'webhook_endpoint.rotate', e.id, e.brand_id);
  return c.json({ data: { id: e.id, secret: secretValue } });
});

adminRoutes.delete('/webhook-endpoints/:id', secret('webhooks:write'), async (c) => {
  const e = await endpointFor(c, c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM webhook_endpoints WHERE id = ?').bind(e.id).run();
  await audit(c, 'webhook_endpoint.delete', e.id, e.brand_id);
  return c.json({ data: { deleted: true } });
});

adminRoutes.get('/webhook-endpoints/:id/deliveries', secret('webhooks:write'), async (c) => {
  const e = await endpointFor(c, c.req.param('id'));
  const status = c.req.query('status');
  const rows = await c.env.DB.prepare(
    `SELECT d.*, ev.type AS event_type FROM webhook_deliveries d JOIN events ev ON ev.id = d.event_id WHERE d.endpoint_id = ? ${status ? 'AND d.status = ?' : ''} ORDER BY d.created_at DESC LIMIT 200`,
  ).bind(...[e.id, ...(status ? [status] : [])]).all();
  return c.json({ data: rows.results ?? [] });
});

/** Replay a dead (or any) delivery now. */
adminRoutes.post('/webhook-deliveries/:id/retry', secret('webhooks:write'), async (c) => {
  const d = await c.env.DB.prepare('SELECT d.id, d.endpoint_id FROM webhook_deliveries d WHERE d.id = ?').bind(c.req.param('id')).first<{ id: string; endpoint_id: string }>();
  if (!d) throw notFound();
  await endpointFor(c, d.endpoint_id);
  await c.env.DB.prepare("UPDATE webhook_deliveries SET status = 'pending', attempts = 0, created_at = ? WHERE id = ?").bind(nowIso(c.var.services.now()), d.id).run();
  const r = await attemptDelivery(c.env, d.id, fetch, c.var.services.now());
  if (r.outcome === 'retry') await c.env.WEBHOOKS.send({ deliveryId: d.id }, { delaySeconds: r.delaySeconds });
  return c.json({ data: r });
});

// =====================================================================
// Bootstrap: first account-level keys (only while no keys exist)
// =====================================================================

export async function bootstrap(c: Ctx) {
  const tok = c.req.header('x-bootstrap-token');
  if (!c.env.BOOTSTRAP_TOKEN || !tok || tok !== c.env.BOOTSTRAP_TOKEN) throw new HttpError(401, 'unauthorized', 'Bootstrap token required');
  const any = await c.env.DB.prepare('SELECT 1 AS x FROM api_keys LIMIT 1').first();
  if (any) throw new HttpError(409, 'already_bootstrapped', 'Keys already exist; use an existing secret key');
  const out: Record<string, string> = {};
  for (const mode of ['live', 'test'] as const) {
    const { raw, prefix } = generateApiKey('sk', mode);
    await c.env.DB.prepare("INSERT INTO api_keys (id, brand_id, type, mode, prefix, hash, name, scopes, allowed_origins, created_at) VALUES (?, NULL, 'sk', ?, ?, ?, 'account (bootstrap)', '[\"*\"]', '[]', ?)")
      .bind(newId('key'), mode, prefix, await sha256Hex(raw), nowIso(c.var.services.now())).run();
    out[`sk_${mode}`] = raw;
  }
  return c.json({ data: { ...out, note: 'Account-level secret keys. Shown once. Remove BOOTSTRAP_TOKEN afterwards.' } }, 201);
}
