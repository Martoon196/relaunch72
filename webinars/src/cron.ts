/**
 * Every-minute housekeeping. Each step is bounded so one run stays well inside Worker limits;
 * anything left over is picked up next minute.
 */
import type { Env } from './env.js';
import type { Services } from './services.js';
import { resolveConfig, type BrandRow } from './lib/config.js';
import {
  emitLeft,
  endSession,
  finalizeSession,
  getWebinar,
  promoteRecording,
  roomControl,
  type AttendanceRow,
  type SessionRow,
  type WebinarRow,
} from './lib/domain.js';
import { emitEvent } from './lib/events.js';
import { nowIso } from './lib/util.js';

const FORGOTTEN_LIVE_GRACE_MS = 3 * 3600_000;
const FINALIZE_DELAY_MS = 2 * 60_000;
const STALE_ON_DEMAND_MS = 10 * 60_000;

export async function runScheduled(env: Env, services: Services, nowMs = services.now()): Promise<Record<string, number>> {
  const now = nowIso(nowMs);
  const db = env.DB;
  const stats: Record<string, number> = {};
  const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);

  // 1. Evergreen slots: scheduled → live → ended.
  const starting = await db.prepare("SELECT * FROM sessions WHERE kind = 'evergreen' AND status = 'scheduled' AND starts_at <= ? AND ends_at > ? LIMIT 50").bind(now, now).all<SessionRow>();
  for (const s of starting.results ?? []) {
    const w = await getWebinar(db, s.webinar_id);
    if (!w) continue;
    await db.prepare("UPDATE sessions SET status = 'live', started_at = starts_at WHERE id = ?").bind(s.id).run();
    await roomControl(env, s.id, { action: 'status', status: 'live' });
    await emitEvent(env, { brandId: w.brand_id, mode: w.mode, type: 'session.started', webinarId: w.id, sessionId: s.id, now: nowMs });
    bump('evergreen_started');
  }
  const ending = await db.prepare("SELECT * FROM sessions WHERE kind = 'evergreen' AND status != 'ended' AND ends_at <= ? LIMIT 50").bind(now).all<SessionRow>();
  for (const s of ending.results ?? []) {
    const w = await getWebinar(db, s.webinar_id);
    if (!w) continue;
    await db.prepare("UPDATE sessions SET status = 'ended', ended_at = ends_at WHERE id = ?").bind(s.id).run();
    await roomControl(env, s.id, { action: 'status', status: 'ended' });
    await emitEvent(env, { brandId: w.brand_id, mode: w.mode, type: 'session.ended', webinarId: w.id, sessionId: s.id, now: nowMs });
    bump('evergreen_ended');
  }

  // 2. Live sessions the host forgot to end.
  const forgotten = await db.prepare("SELECT * FROM sessions WHERE kind = 'live' AND status = 'live' AND ends_at <= ? LIMIT 10")
    .bind(nowIso(nowMs - FORGOTTEN_LIVE_GRACE_MS)).all<SessionRow>();
  for (const s of forgotten.results ?? []) {
    const w = await getWebinar(db, s.webinar_id);
    if (w) await endSession(env, services, s, w, nowMs);
    bump('live_auto_ended');
  }

  // 3. Finalise ended sessions: attendee.left (final watch time) + attendee.no_show.
  const toFinalize = await db.prepare(
    "SELECT * FROM sessions WHERE kind IN ('live','evergreen') AND status = 'ended' AND finalized_at IS NULL AND COALESCE(ended_at, ends_at) <= ? ORDER BY ended_at LIMIT 5",
  ).bind(nowIso(nowMs - FINALIZE_DELAY_MS)).all<SessionRow>();
  for (const s of toFinalize.results ?? []) {
    const w = await getWebinar(db, s.webinar_id);
    if (w && (await finalizeSession(env, s, w, nowMs))) bump('finalized');
  }

  // 4. Recording promotion fallback (in case the Stream webhook was missed or the recording was still processing).
  const unpromoted = await db.prepare(
    `SELECT s.id FROM sessions s JOIN webinars w ON w.id = s.webinar_id
      WHERE s.kind = 'live' AND s.status = 'ended' AND w.stream_live_input_id IS NOT NULL AND s.ended_at >= ?
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id AND e.type = 'recording.ready')
      LIMIT 3`,
  ).bind(nowIso(nowMs - 24 * 3600_000)).all<{ id: string }>();
  for (const s of unpromoted.results ?? []) {
    await promoteRecording(env, services, s.id, nowMs).catch((err) => console.error('promote fallback', err));
    bump('recording_checked');
  }

  // 5. On-demand / replay viewers who went away without a leave beacon.
  const stale = await db.prepare(
    `SELECT a.* FROM attendance a JOIN sessions s ON s.id = a.session_id
      WHERE a.left_emitted = 0 AND a.last_seen_at < ? AND s.kind = 'on_demand' LIMIT 50`,
  ).bind(nowIso(nowMs - STALE_ON_DEMAND_MS)).all<AttendanceRow>();
  const webinarCache = new Map<string, WebinarRow | null>();
  for (const a of stale.results ?? []) {
    const s = await db.prepare('SELECT webinar_id FROM sessions WHERE id = ?').bind(a.session_id).first<{ webinar_id: string }>();
    if (!s) continue;
    if (!webinarCache.has(s.webinar_id)) webinarCache.set(s.webinar_id, await getWebinar(db, s.webinar_id));
    const w = webinarCache.get(s.webinar_id);
    if (!w) continue;
    await db.prepare('UPDATE attendance SET left_emitted = 1, left_at = COALESCE(left_at, last_seen_at) WHERE id = ?').bind(a.id).run();
    await emitLeft(env, w, a, w.duration_s, nowMs);
    bump('on_demand_left');
  }

  // 6. Webhook sweeper: deliveries whose queue message never got sent or was lost.
  //    Receivers should de-duplicate on the GHQ-Delivery header.
  const lost = await db.prepare(
    `SELECT id FROM webhook_deliveries
      WHERE (status = 'pending' AND created_at < ?) OR (status = 'failed' AND next_attempt_at < ?)
      LIMIT 100`,
  ).bind(nowIso(nowMs - 2 * 60_000), nowIso(nowMs - 30 * 60_000)).all<{ id: string }>();
  if (lost.results?.length) {
    await env.WEBHOOKS.sendBatch(lost.results.map((r) => ({ body: { deliveryId: r.id } })));
    // Push next_attempt_at forward so the same rows aren't swept again next minute.
    for (const r of lost.results) await db.prepare("UPDATE webhook_deliveries SET status = 'failed', next_attempt_at = ? WHERE id = ?").bind(nowIso(nowMs + 5 * 60_000), r.id).run();
    stats.webhooks_requeued = lost.results.length;
  }

  // 7. Retention (daily at 03:00 UTC).
  const d = new Date(nowMs);
  if (d.getUTCHours() === 3 && d.getUTCMinutes() === 0) Object.assign(stats, await runRetention(env, nowMs));

  return stats;
}

/** Delete attendance, chat and raw events older than each brand's retention window (default 24 months). */
export async function runRetention(env: Env, nowMs: number): Promise<Record<string, number>> {
  const brands = await env.DB.prepare('SELECT * FROM brands').all<BrandRow>();
  let purged = 0;
  for (const b of brands.results ?? []) {
    const months = resolveConfig(b).settings.defaults.retention_months;
    if (!months || months <= 0) continue;
    const cutoff = new Date(nowMs);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
    const c = cutoff.toISOString();
    const res = await env.DB.batch([
      env.DB.prepare('DELETE FROM attendance WHERE last_seen_at < ? AND registrant_id IN (SELECT id FROM registrants WHERE brand_id = ?)').bind(c, b.id),
      env.DB.prepare('DELETE FROM messages WHERE created_at < ? AND session_id IN (SELECT s.id FROM sessions s JOIN webinars w ON w.id = s.webinar_id WHERE w.brand_id = ?)').bind(c, b.id),
      env.DB.prepare('DELETE FROM webhook_deliveries WHERE event_id IN (SELECT id FROM events WHERE brand_id = ? AND ts < ?)').bind(b.id, c),
      env.DB.prepare('DELETE FROM events WHERE brand_id = ? AND ts < ?').bind(b.id, c),
    ]);
    purged += res.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  }
  // Delivered webhook rows are only an operational log.
  await env.DB.prepare("DELETE FROM webhook_deliveries WHERE status = 'delivered' AND delivered_at < ?").bind(nowIso(nowMs - 30 * 86_400_000)).run();
  return { retention_purged: purged };
}
