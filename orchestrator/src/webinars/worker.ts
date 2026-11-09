/**
 * In-process webinar worker (same pattern as the MHP dispatchers): every tick it
 * discovers workspaces with due work, then per workspace — under a worker RLS
 * context — reaps leases, expires stale jobs, sends due messages, reconciles
 * uploads/recordings with Cloudflare and refreshes live connection state.
 *
 * Exactly-once intent: a message job moves queued → leased → calling → done. A
 * crash or timeout while 'calling' becomes 'unknown' and is never resent
 * automatically, so a provider retry can never produce a duplicate email.
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { workerDatabaseContext } from '../db/rls.js';
import { withTransaction } from '../db/transaction.js';
import { issueAccessToken } from './access.js';
import { playbackHosts, publicOriginFor, type WebinarConfig } from './config.js';
import { composeMessage, deliveryDecision, type MessagePurpose, type WebinarMailer } from './messages.js';
import { applyVideoState, readProfile, runProvisionJob, settleJob } from './service.js';
import type { CloudflareStreamClient } from './stream.js';
import { toEvent, type WebinarEvent } from './types.js';

export interface WebinarWorkerDependencies {
  readonly pool: Pool;
  readonly config: WebinarConfig;
  readonly stream: CloudflareStreamClient | null;
  readonly mailer: WebinarMailer;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

interface JobRow {
  id: string;
  event_id: string;
  registration_id: string | null;
  kind: string;
  purpose: string | null;
  dedupe_key: string;
  schedule_version: number | null;
  attempts: number;
  expires_at: Date | null;
}

const MAX_ATTEMPTS = 5;

export class WebinarWorker {
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: WebinarWorkerDependencies) {
    this.now = deps.now ?? Date.now;
  }

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    const loop = () => { void this.tick().catch((e) => this.deps.log?.(`webinar worker tick failed: ${e instanceof Error ? e.message : 'error'}`)); };
    this.timer = setInterval(loop, intervalMs);
    this.timer.unref?.();
    loop();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Returns a small summary for tests and logs. */
  async tick(): Promise<Record<string, number>> {
    if (this.running) return { skipped: 1 };
    this.running = true;
    const stats: Record<string, number> = {};
    try {
      const ids = await this.deps.pool.query(`/* webinars.active-workspaces */ SELECT ws FROM app_private.webinar_active_workspaces($1) AS ws`, [new Date(this.now()).toISOString()]);
      for (const row of ids.rows) {
        const s = await this.workspace(String(row.ws));
        for (const [k, v] of Object.entries(s)) stats[k] = (stats[k] ?? 0) + v;
      }
    } finally {
      this.running = false;
    }
    return stats;
  }

  private ctx(workspaceId: string) {
    return workerDatabaseContext({ workspaceId, requestId: `webinar-worker-${randomUUID()}` });
  }

  async workspace(workspaceId: string): Promise<Record<string, number>> {
    const stats: Record<string, number> = {};
    const bump = (k: string) => { stats[k] = (stats[k] ?? 0) + 1; };
    const nowIso = new Date(this.now()).toISOString();
    const canSend = this.deps.config.emailMode !== 'off' && this.deps.config.senders.has(workspaceId.toLowerCase()) && this.deps.config.accessSecret !== null;
    const jobs = await withTransaction(this.deps.pool, this.ctx(workspaceId), async (tx) => {
      // Interrupted provider calls are uncertain: never retried blindly.
      const reaped = await tx.query(`UPDATE app.webinar_jobs SET state = CASE WHEN state = 'calling' THEN 'unknown' ELSE 'queued' END,
          detail = CASE WHEN state = 'calling' THEN 'Interrupted while calling the provider; not retried automatically.' ELSE detail END,
          lease_token = NULL, lease_until = NULL, updated_at = clock_timestamp()
        WHERE workspace_id = app_private.current_workspace_id() AND state IN ('leased', 'calling') AND lease_until <= $1`, [nowIso]);
      if (reaped.rowCount) stats.reaped = reaped.rowCount;
      const expired = await tx.query(`UPDATE app.webinar_jobs SET state = 'expired', detail = coalesce(detail, 'Not sent before it stopped being useful.'), updated_at = clock_timestamp()
        WHERE workspace_id = app_private.current_workspace_id() AND state = 'queued' AND expires_at IS NOT NULL AND expires_at <= $1`, [nowIso]);
      if (expired.rowCount) stats.expired = expired.rowCount;
      const claim = await tx.query(`/* webinars.claim-jobs */ UPDATE app.webinar_jobs j SET state = 'leased', lease_token = gen_random_uuid(),
          lease_until = $1::timestamptz + interval '2 minutes', updated_at = clock_timestamp()
        WHERE j.workspace_id = app_private.current_workspace_id() AND j.id IN (
          SELECT id FROM app.webinar_jobs WHERE workspace_id = app_private.current_workspace_id() AND state = 'queued' AND run_after <= $1
            AND (kind <> 'message' OR $2) ORDER BY run_after LIMIT 25 FOR UPDATE SKIP LOCKED)
        RETURNING j.id, j.event_id, j.registration_id, j.kind, j.purpose, j.dedupe_key, j.schedule_version, j.attempts, j.expires_at`, [nowIso, canSend]);
      return claim.rows as JobRow[];
    });
    for (const job of jobs) {
      try {
        bump(await this.run(workspaceId, job));
      } catch (error) {
        bump('error');
        this.deps.log?.(`webinar job ${job.kind} failed: ${error instanceof Error ? error.message : 'error'}`);
        // Once a provider call started, an exception is an uncertain outcome.
        // Leave calling rows for the existing reaper to mark unknown; never undo
        // a settled result or turn an interrupted send into another attempt.
        await withTransaction(this.deps.pool, this.ctx(workspaceId), (tx) => tx.query(`/* webinars.retry-unstarted-job */
          UPDATE app.webinar_jobs SET state = 'queued', detail = 'Temporary error before dispatch; will retry.',
            run_after = $2, lease_token = NULL, lease_until = NULL, updated_at = clock_timestamp()
          WHERE workspace_id = app_private.current_workspace_id() AND id = $1 AND state = 'leased'`,
          [job.id, new Date(this.now() + 60_000).toISOString()])).catch(() => undefined);
      }
    }
    if (this.deps.stream) Object.assign(stats, await this.refreshLive(workspaceId));
    return stats;
  }

  private async run(workspaceId: string, job: JobRow): Promise<string> {
    switch (job.kind) {
      case 'message': return this.message(workspaceId, job);
      case 'provision_live_input':
        if (!this.deps.stream) return this.hold(workspaceId, job, 'Cloudflare Stream is not configured.');
        await runProvisionJob(this.deps.pool, this.deps.stream, this.deps.config, workspaceId, job.id, this.now);
        return 'provisioned';
      case 'reconcile_video': return this.reconcileVideo(workspaceId, job);
      case 'reconcile_recording': return this.reconcileRecording(workspaceId, job);
      default:
        await withTransaction(this.deps.pool, this.ctx(workspaceId), (tx) => settleJob(tx, job.id, 'cancelled', 'Unknown job kind', {}));
        return 'cancelled';
    }
  }

  private async hold(workspaceId: string, job: JobRow, detail: string): Promise<string> {
    await withTransaction(this.deps.pool, this.ctx(workspaceId), (tx) => settleJob(tx, job.id, 'queued', detail, {}, new Date(this.now() + 5 * 60_000).toISOString()));
    return 'held';
  }

  private async loadEvent(tx: PoolClient, id: string): Promise<WebinarEvent | null> {
    const r = await tx.query(`SELECT * FROM app.webinar_events WHERE workspace_id = app_private.current_workspace_id() AND id = $1`, [id]);
    return r.rowCount === 1 ? toEvent(r.rows[0]) : null;
  }

  private async message(workspaceId: string, job: JobRow): Promise<string> {
    const config = this.deps.config;
    // Load everything and move to 'calling' in one transaction, so the send below is
    // the only thing that can be interrupted — and that interruption is 'unknown'.
    const prepared = await withTransaction(this.deps.pool, this.ctx(workspaceId), async (tx) => {
      const event = await this.loadEvent(tx, job.event_id);
      const reg = await tx.query(`SELECT id, email, name, status, token_version FROM app.webinar_registrations
        WHERE workspace_id = app_private.current_workspace_id() AND id = $1`, [job.registration_id]);
      const profile = await readProfile(tx);
      const r = reg.rows[0];
      const purpose = job.purpose as MessagePurpose;
      if (!event || !r || !profile) { await settleJob(tx, job.id, 'cancelled', 'Webinar or registration no longer exists.', {}); return null; }
      if (r.status !== 'registered') { await settleJob(tx, job.id, 'cancelled', 'Registration cancelled.', {}); return null; }
      if (purpose !== 'cancellation' && event.status !== 'published') { await settleJob(tx, job.id, 'cancelled', `Webinar is ${event.status}.`, {}); return null; }
      if (purpose === 'reminder' && job.schedule_version !== event.scheduleVersion) {
        await settleJob(tx, job.id, 'cancelled', 'Superseded by a reschedule.', {}); return null;
      }
      const decision = deliveryDecision(config, workspaceId, String(r.email));
      if (decision.kind === 'hold') { await settleJob(tx, job.id, 'queued', decision.reason, {}, new Date(this.now() + 5 * 60_000).toISOString()); return null; }
      if (decision.kind === 'block') { await settleJob(tx, job.id, 'blocked', decision.reason, {}); return null; }
      const origin = publicOriginFor(config, workspaceId);
      if (!origin || !config.accessSecret) { await settleJob(tx, job.id, 'queued', 'WEBINAR_PUBLIC_ORIGIN or WEBINAR_ACCESS_SECRET is not set.', {}, new Date(this.now() + 5 * 60_000).toISOString()); return null; }
      const token = issueAccessToken(config.accessSecret, event.publicKey, { registrationId: String(r.id), version: Number(r.token_version) });
      const roomUrl = `${origin}/w/${event.publicKey}/room?t=${encodeURIComponent(token)}`;
      const offset = purpose === 'reminder' ? Number(/:reminder:(\d+):/.exec(job.dedupe_key)?.[1] ?? 60) : null;
      const message = composeMessage(purpose, {
        event, brand: profile.brand, recipientName: String(r.name), roomUrl,
        calendarUrl: event.startsAt ? `${origin}/w/${event.publicKey}/calendar.ics?t=${encodeURIComponent(token)}` : null, reminderOffsetMinutes: offset,
      });
      const marked = await tx.query(`UPDATE app.webinar_jobs SET state = 'calling', attempts = attempts + 1, lease_until = $2::timestamptz + interval '2 minutes', updated_at = clock_timestamp()
        WHERE workspace_id = app_private.current_workspace_id() AND id = $1 AND state = 'leased'`, [job.id, new Date(this.now()).toISOString()]);
      if (marked.rowCount !== 1) return null;
      return { sender: decision.sender, to: String(r.email), message };
    });
    if (!prepared) return 'skipped';
    const result = await this.deps.mailer.send(prepared.sender, prepared.to, prepared.message, { webinarJob: job.id, purpose: String(job.purpose) });
    await withTransaction(this.deps.pool, this.ctx(workspaceId), async (tx) => {
      if (result.outcome === 'sent') await settleJob(tx, job.id, 'done', null, { providerMessageId: result.messageId ?? null, sentAt: new Date(this.now()).toISOString() });
      else if (result.outcome === 'unknown') await settleJob(tx, job.id, 'unknown', result.detail ?? 'Provider outcome unknown; not resent.', {});
      else if (result.outcome === 'rejected' || job.attempts + 1 >= MAX_ATTEMPTS) await settleJob(tx, job.id, 'failed', result.detail ?? 'Rejected by the email provider.', {});
      else await settleJob(tx, job.id, 'queued', result.detail ?? 'Temporary email failure; will retry.', {}, new Date(this.now() + 5 * 60_000 * (job.attempts + 1)).toISOString());
    });
    return result.outcome === 'sent' ? 'sent' : `mail_${result.outcome}`;
  }

  private async reconcileVideo(workspaceId: string, job: JobRow): Promise<string> {
    if (!this.deps.stream) return this.hold(workspaceId, job, 'Cloudflare Stream is not configured.');
    const uid = job.dedupe_key.replace(/^reconcile-video:/, '');
    const v = await this.deps.stream.getVideo(uid);
    return withTransaction(this.deps.pool, this.ctx(workspaceId), async (tx) => {
      const event = await this.loadEvent(tx, job.event_id);
      if (!event || event.videoUid !== uid) { await settleJob(tx, job.id, 'cancelled', 'Video was replaced.', {}); return 'cancelled'; }
      if (v?.readyToStream) {
        await applyVideoState(tx, job.event_id, 'ready', v.duration, null);
        await settleJob(tx, job.id, 'done', null, { duration: v.duration });
        await this.deps.stream!.protectVideo(uid, playbackHosts(this.deps.config, workspaceId)).catch(() => undefined);
        return 'video_ready';
      }
      if (v?.state === 'error') {
        await applyVideoState(tx, job.event_id, 'failed', null, v.errorReason);
        await settleJob(tx, job.id, 'done', v.errorReason ?? 'Cloudflare could not process the video.', {});
        return 'video_failed';
      }
      if (v && v.state !== 'pendingupload') await applyVideoState(tx, job.event_id, 'processing', null, null);
      await settleJob(tx, job.id, 'queued', v ? `Cloudflare state: ${v.state}` : 'Upload not visible at Cloudflare yet.', {}, new Date(this.now() + 60_000).toISOString());
      return 'video_pending';
    });
  }

  /**
   * After the host ends the session: find the live input's recording that started
   * after the session opened, and make it the replay once Cloudflare says it is
   * ready. Nothing is claimed until then; after two days without one the
   * recording is reported as not recorded instead of pretending.
   */
  private async reconcileRecording(workspaceId: string, job: JobRow): Promise<string> {
    if (!this.deps.stream) return this.hold(workspaceId, job, 'Cloudflare Stream is not configured.');
    const event = await withTransaction(this.deps.pool, this.ctx(workspaceId), (tx) => this.loadEvent(tx, job.event_id));
    if (!event?.liveInputUid || event.sessionState !== 'ended') {
      await withTransaction(this.deps.pool, this.ctx(workspaceId), (tx) => settleJob(tx, job.id, 'cancelled', 'No ended live session to reconcile.', {}));
      return 'cancelled';
    }
    const recordings = await this.deps.stream.recordingsFor(event.liveInputUid);
    const sessionStart = event.sessionStartedAt ? Date.parse(event.sessionStartedAt) - 30 * 60_000 : 0;
    const candidates = recordings.filter((r) => r.liveInput === event.liveInputUid && (!r.created || Date.parse(r.created) >= sessionStart));
    // The longest ready recording is the session; short ones are reconnect fragments.
    const ready = candidates.filter((r) => r.readyToStream).sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))[0];
    return withTransaction(this.deps.pool, this.ctx(workspaceId), async (tx) => {
      if (ready) {
        await tx.query(`UPDATE app.webinar_events SET recording_uid = $2, recording_state = 'ready', recording_duration_seconds = $3,
            row_version = row_version + 1, updated_at = clock_timestamp()
          WHERE workspace_id = app_private.current_workspace_id() AND id = $1
            AND (recording_state <> 'ready' OR coalesce(recording_duration_seconds, 0) < coalesce($3::numeric, 0))`, [event.id, ready.uid, ready.duration]);
        if (event.settings.replay.enabled && event.status === 'published') {
          await tx.query(`INSERT INTO app.webinar_jobs (workspace_id, event_id, registration_id, kind, purpose, dedupe_key, schedule_version, run_after, expires_at)
            SELECT r.workspace_id, r.event_id, r.id, 'message', 'replay_available', 'msg:' || r.id::text || ':replay_available', $2, $3::timestamptz, $3::timestamptz + interval '7 days'
            FROM app.webinar_registrations r WHERE r.workspace_id = app_private.current_workspace_id() AND r.event_id = $1 AND r.status = 'registered'
            ON CONFLICT (workspace_id, dedupe_key) DO NOTHING`, [event.id, event.scheduleVersion, new Date(this.now()).toISOString()]);
        }
        // A reconnect fragment can become ready before the longer recording,
        // including when no webhook is configured. Keep bounded reconciliation
        // alive until its existing deadline rather than stopping at that fragment.
        const finished = job.expires_at !== null && job.expires_at.getTime() <= this.now() + 60_000;
        await settleJob(tx, job.id, finished ? 'done' : 'queued', finished ? null : 'Replay ready; checking for a longer recording.',
          { recordingUid: ready.uid, duration: ready.duration }, finished ? undefined : new Date(this.now() + 60_000).toISOString());
        return 'recording_ready';
      }
      if (candidates.length > 0 && candidates.every((r) => r.state === 'error')) {
        await tx.query(`UPDATE app.webinar_events SET recording_state = 'failed', updated_at = clock_timestamp() WHERE workspace_id = app_private.current_workspace_id() AND id = $1`, [event.id]);
        await settleJob(tx, job.id, 'done', 'Cloudflare reported the recording as failed.', {});
        return 'recording_failed';
      }
      if (job.expires_at && Date.parse(job.expires_at.toISOString()) <= this.now() + 60_000) {
        await tx.query(`UPDATE app.webinar_events SET recording_state = 'not_recorded', updated_at = clock_timestamp()
          WHERE workspace_id = app_private.current_workspace_id() AND id = $1 AND recording_state <> 'ready'`, [event.id]);
        await settleJob(tx, job.id, 'done', 'No recording appeared within two days.', {});
        return 'recording_missing';
      }
      await settleJob(tx, job.id, 'queued', candidates.length ? 'Recording still processing at Cloudflare.' : 'No recording at Cloudflare yet.', {},
        new Date(this.now() + 60_000).toISOString());
      return 'recording_pending';
    });
  }

  /** Live connection state for events in their live window, at most every 15 seconds each. */
  private async refreshLive(workspaceId: string): Promise<Record<string, number>> {
    const nowIso = new Date(this.now()).toISOString();
    const events = await withTransaction(this.deps.pool, this.ctx(workspaceId), async (tx) => (await tx.query(`SELECT id, live_input_uid FROM app.webinar_events
      WHERE workspace_id = app_private.current_workspace_id() AND status = 'published' AND live_input_uid IS NOT NULL
        AND (session_state = 'live' OR (session_state = 'scheduled' AND starts_at BETWEEN $1::timestamptz - interval '6 hours' AND $1::timestamptz + interval '2 hours'))
        AND (live_checked_at IS NULL OR live_checked_at < $1::timestamptz - interval '15 seconds')
      LIMIT 10`, [nowIso])).rows as { id: string; live_input_uid: string }[]);
    let refreshed = 0;
    for (const e of events) {
      const connection = await this.deps.stream!.getLiveInput(e.live_input_uid).then((r) => r.connection, () => 'unknown' as const);
      await withTransaction(this.deps.pool, this.ctx(workspaceId), (tx) => tx.query(`UPDATE app.webinar_events SET live_state = $2, live_checked_at = $3
        WHERE workspace_id = app_private.current_workspace_id() AND id = $1`, [e.id, connection, nowIso]));
      refreshed += 1;
    }
    return refreshed ? { live_refreshed: refreshed } : {};
  }
}
