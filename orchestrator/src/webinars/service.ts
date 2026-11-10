/**
 * Native webinar service over PostgreSQL (r72_content_command) + Cloudflare Stream.
 *
 * Managers act inside their portal session's workspace: every transaction re-locks
 * the session and RLS limits rows to that workspace for owners/admins only, so a
 * webinar id from the browser can never select another brand's data. Attendees act
 * through SECURITY DEFINER functions keyed by the event's public key plus a
 * verified HMAC access token.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CrmCommandService } from '../crm-pg/index.js';
import { requestDatabaseContext, workerDatabaseContext, type DatabaseRequestContext } from '../db/rls.js';
import { withTransaction } from '../db/transaction.js';
import type { PortalSessionIdentity } from '../portal/auth-service.js';
import { issueAccessToken, type AccessClaim } from './access.js';
import { playbackHosts, publicOriginFor, type WebinarConfig } from './config.js';
import { computeRoomState, isValidTimezone, zonedToUtc, type RoomState } from './schedule.js';
import { StreamError, type CloudflareStreamClient, type LiveInputCredentials } from './stream.js';
import { readSettings, toEvent, type WebinarBrand, type WebinarEvent, type WebinarKind, type WebinarSettings } from './types.js';

export class WebinarError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface WorkspaceProfile {
  readonly workspaceId: string;
  readonly name: string;
  readonly slug: string;
  readonly timezone: string;
  readonly canManage: boolean;
  readonly brand: WebinarBrand;
}

export interface WebinarCounts {
  readonly registered: number;
  readonly cancelled: number;
  readonly pendingQuestions: number;
}

export interface WebinarSummary {
  readonly event: WebinarEvent;
  readonly counts: WebinarCounts;
}

export interface WebinarEditInput {
  readonly kind: WebinarKind;
  readonly title: string;
  readonly summary: string;
  readonly presenterName: string;
  readonly presenterTitle: string;
  readonly timezone: string;
  /** datetime-local in `timezone`, or '' for on-demand. */
  readonly startsLocal: string;
  readonly durationMinutes: number;
  readonly capacity: number | null;
  readonly settings: WebinarSettings;
}

export interface RegistrationRow {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly status: 'registered' | 'cancelled';
  readonly marketingConsent: boolean;
  readonly answers: Record<string, string>;
  readonly attribution: Record<string, string>;
  readonly createdAt: string;
  readonly crmContactId: string | null;
  readonly accessedRoom: boolean;
  readonly playerStarted: boolean;
  readonly watchedSeconds: number;
  readonly ctaClicked: boolean;
  readonly questions: number;
}

export interface QuestionRow {
  readonly id: string;
  readonly body: string;
  readonly status: 'pending' | 'approved' | 'answered' | 'dismissed';
  readonly answer: string | null;
  readonly askedBy: string;
  readonly createdAt: string;
}

export interface MessageStatusRow {
  readonly purpose: string;
  readonly state: string;
  readonly count: number;
  readonly lastDetail: string | null;
}

export interface WebinarResults {
  readonly registered: number;
  readonly accessedRoom: number;
  readonly playerStarted: number;
  /** Registrants with at least this many observed seconds, by threshold. */
  readonly watchedAtLeast: readonly { readonly minutes: number; readonly people: number }[];
  readonly totalObservedMinutes: number;
  readonly ctaClickers: number;
  readonly questions: number;
  readonly crmLinked: number;
  readonly byMode: readonly { readonly mode: string; readonly people: number }[];
  readonly bySource: readonly { readonly source: string; readonly registered: number; readonly playerStarted: number }[];
}

export interface PublicEvent {
  readonly event: WebinarEvent;
  readonly brand: WebinarBrand;
  readonly registered: number;
}

export interface Playback {
  readonly room: RoomState;
  readonly hlsUrl: string | null;
  readonly expiresAt: string | null;
  readonly cta: { readonly label: string; readonly url: string; readonly body: string; readonly visible: boolean; readonly atSeconds: number | null } | null;
  readonly serverNow: string;
}

export interface WebinarServiceDependencies {
  readonly pool: Pool;
  readonly config: WebinarConfig;
  readonly stream: CloudflareStreamClient | null;
  /** CRM command boundary (r72_crm_command). Absent: CRM import shows as unavailable. */
  readonly crm?: { readonly commands: CrmCommandService; readonly pool: Pool } | undefined;
  readonly now?: () => number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const EVENT_COLUMNS = `workspace_id, id, public_key, kind, status, title, summary, presenter_name, presenter_title, timezone,
  starts_at, duration_minutes, capacity, settings, schedule_version, video_uid, video_state, video_duration_seconds,
  live_input_uid, live_state, live_checked_at, session_state, session_started_at, session_ended_at,
  recording_uid, recording_state, recording_duration_seconds, cta_revealed_at, row_version`;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'webinar';
}

export class PgWebinarService {
  private readonly now: () => number;
  /** Signed playback tokens by uid; reused while they have ample life left, so a poll is not an RSA signature. */
  private readonly signed = new Map<string, { token: string; expiresAt: string; expMs: number }>();

  constructor(private readonly deps: WebinarServiceDependencies) {
    this.now = deps.now ?? Date.now;
  }

  get config(): WebinarConfig {
    return this.deps.config;
  }

  get providerConfigured(): boolean {
    return this.deps.stream !== null;
  }

  get crmAvailable(): boolean {
    return this.deps.crm !== undefined;
  }

  /** The single clock every room state, countdown and job time is computed from. */
  clock(): number {
    return this.now();
  }

  // ── manager plumbing ─────────────────────────────────────────────────────

  private context(identity: PortalSessionIdentity, requestId: string): DatabaseRequestContext {
    return requestDatabaseContext({ workspaceId: identity.workspaceId, userId: identity.userId, requestId, portalSessionTokenHash: sha256(identity.sessionToken) });
  }

  private async managed<T>(identity: PortalSessionIdentity, requestId: string, op: (tx: PoolClient, profile: WorkspaceProfile) => Promise<T>): Promise<T> {
    return this.managedIn(this.context(identity, requestId), op);
  }

  private async managedIn<T>(context: DatabaseRequestContext, op: (tx: PoolClient, profile: WorkspaceProfile) => Promise<T>): Promise<T> {
    return withTransaction(this.deps.pool, context, async (tx) => {
      const profile = await readProfile(tx);
      if (!profile) throw new WebinarError(403, 'This workspace is not available to you.');
      if (!profile.canManage) throw new WebinarError(403, 'Only a workspace owner or admin can manage webinars.');
      return op(tx, profile);
    });
  }

  private async loadEvent(tx: PoolClient, id: string, lock = false): Promise<WebinarEvent & { rowVersion: number }> {
    if (!UUID.test(id)) throw new WebinarError(404, 'Webinar not found.');
    const r = await tx.query(`/* webinars.event */ SELECT ${EVENT_COLUMNS} FROM app.webinar_events
      WHERE workspace_id = app_private.current_workspace_id() AND id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (r.rowCount !== 1) throw new WebinarError(404, 'Webinar not found.');
    return { ...toEvent(r.rows[0]), rowVersion: Number(r.rows[0].row_version) };
  }

  async profile(identity: PortalSessionIdentity, requestId: string): Promise<WorkspaceProfile | null> {
    return withTransaction(this.deps.pool, this.context(identity, requestId), (tx) => readProfile(tx));
  }

  async list(identity: PortalSessionIdentity, requestId: string): Promise<{ profile: WorkspaceProfile; webinars: WebinarSummary[] }> {
    return this.managed(identity, requestId, async (tx, profile) => {
      const r = await tx.query(`/* webinars.list */ SELECT ${EVENT_COLUMNS},
          (SELECT count(*) FROM app.webinar_registrations g WHERE g.workspace_id = e.workspace_id AND g.event_id = e.id AND g.status = 'registered') AS registered,
          (SELECT count(*) FROM app.webinar_registrations g WHERE g.workspace_id = e.workspace_id AND g.event_id = e.id AND g.status = 'cancelled') AS cancelled,
          (SELECT count(*) FROM app.webinar_questions q WHERE q.workspace_id = e.workspace_id AND q.event_id = e.id AND q.status = 'pending') AS pending_questions
        FROM app.webinar_events e WHERE e.workspace_id = app_private.current_workspace_id() AND e.status <> 'archived'
        ORDER BY CASE WHEN e.session_state = 'live' THEN 0
                      WHEN e.starts_at IS NOT NULL AND e.starts_at + make_interval(mins => e.duration_minutes) >= $1::timestamptz THEN 1
                      WHEN e.starts_at IS NULL THEN 2 ELSE 3 END,
          CASE WHEN e.starts_at + make_interval(mins => e.duration_minutes) >= $1::timestamptz THEN e.starts_at END ASC,
          e.starts_at DESC NULLS LAST, e.created_at DESC LIMIT 200`, [new Date(this.now()).toISOString()]);
      return { profile, webinars: r.rows.map((row) => ({ event: toEvent(row), counts: { registered: Number(row.registered), cancelled: Number(row.cancelled), pendingQuestions: Number(row.pending_questions) } })) };
    });
  }

  async get(identity: PortalSessionIdentity, requestId: string, id: string): Promise<{ profile: WorkspaceProfile; event: WebinarEvent; rowVersion: number; counts: WebinarCounts }> {
    return this.managed(identity, requestId, async (tx, profile) => {
      const event = await this.loadEvent(tx, id);
      const c = await tx.query(`/* webinars.counts */ SELECT
          count(*) FILTER (WHERE status = 'registered') AS registered, count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
          (SELECT count(*) FROM app.webinar_questions q WHERE q.workspace_id = app_private.current_workspace_id() AND q.event_id = $1 AND q.status = 'pending') AS pending
        FROM app.webinar_registrations WHERE workspace_id = app_private.current_workspace_id() AND event_id = $1`, [id]);
      return { profile, event, rowVersion: event.rowVersion,
        counts: { registered: Number(c.rows[0].registered), cancelled: Number(c.rows[0].cancelled), pendingQuestions: Number(c.rows[0].pending) } };
    });
  }

  private validate(input: WebinarEditInput, forPublish: boolean): { startsAt: string | null } {
    if (!['live', 'on_demand', 'scheduled_recording'].includes(input.kind)) throw new WebinarError(400, 'Choose a webinar type.');
    if (input.title.trim().length < 2 || input.title.length > 160) throw new WebinarError(400, 'The title must be 2–160 characters.');
    if (!isValidTimezone(input.timezone)) throw new WebinarError(400, 'Choose a valid timezone.');
    if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 5 || input.durationMinutes > 480) throw new WebinarError(400, 'Duration must be between 5 and 480 minutes.');
    if (input.capacity !== null && (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 100_000)) throw new WebinarError(400, 'Capacity must be blank or between 1 and 100,000.');
    let startsAt: string | null = null;
    if (input.kind !== 'on_demand') {
      if (input.startsLocal) {
        const d = zonedToUtc(input.startsLocal, input.timezone);
        if (!d) throw new WebinarError(400, 'Enter a valid start date and time.');
        startsAt = d.toISOString();
      } else if (forPublish) {
        throw new WebinarError(400, 'A scheduled webinar needs a start date and time.');
      }
    }
    return { startsAt };
  }

  async create(identity: PortalSessionIdentity, requestId: string, input: WebinarEditInput): Promise<string> {
    const { startsAt } = this.validate(input, false);
    return this.managed(identity, requestId, async (tx) => {
      const base = slugify(input.title);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const key = `${base}-${randomBytes(3).toString('hex')}`;
        const r = await tx.query(`/* webinars.create */ INSERT INTO app.webinar_events
          (workspace_id, public_key, kind, title, summary, presenter_name, presenter_title, timezone, starts_at, duration_minutes, capacity, settings, created_by_user_id,
           video_state)
          VALUES (app_private.current_workspace_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, app_private.current_user_id(), 'none')
          ON CONFLICT (public_key) DO NOTHING RETURNING id`,
          [key, input.kind, input.title.trim(), input.summary, input.presenterName, input.presenterTitle, input.timezone, startsAt,
            input.durationMinutes, input.capacity, JSON.stringify(input.settings)]);
        if (r.rowCount === 1) return String(r.rows[0].id);
      }
      throw new WebinarError(503, 'Could not allocate a public link. Please try again.');
    });
  }

  /**
   * Updates details. A changed start time bumps schedule_version: queued reminders
   * for the old time are cancelled in the same transaction and every registrant
   * gets reminders for the new time plus one reschedule notice.
   */
  async update(identity: PortalSessionIdentity, requestId: string, id: string, rowVersion: number, input: WebinarEditInput): Promise<{ rescheduled: boolean }> {
    return this.managed(identity, requestId, async (tx) => {
      const current = await this.loadEvent(tx, id, true);
      if (current.rowVersion !== rowVersion) throw new WebinarError(409, 'Someone else changed this webinar. Reload and try again.');
      if (current.status === 'cancelled' || current.status === 'archived') throw new WebinarError(409, 'A cancelled webinar cannot be edited.');
      if (input.kind !== current.kind && current.status !== 'draft') throw new WebinarError(409, 'The webinar type cannot change after publishing.');
      const { startsAt } = this.validate(input, current.status === 'published');
      const rescheduled = current.status === 'published' && current.startsAt !== startsAt && startsAt !== null;
      if (rescheduled && current.sessionState !== 'scheduled') throw new WebinarError(409, 'The session has already started; it cannot be rescheduled.');
      await tx.query(`/* webinars.update */ UPDATE app.webinar_events SET kind = $2, title = $3, summary = $4, presenter_name = $5, presenter_title = $6,
          timezone = $7, starts_at = $8, duration_minutes = $9, capacity = $10, settings = $11,
          schedule_version = schedule_version + CASE WHEN $12 THEN 1 ELSE 0 END, row_version = row_version + 1, updated_at = clock_timestamp()
        WHERE workspace_id = app_private.current_workspace_id() AND id = $1`,
        [id, input.kind, input.title.trim(), input.summary, input.presenterName, input.presenterTitle, input.timezone, startsAt,
          input.durationMinutes, input.capacity, JSON.stringify(input.settings), rescheduled]);
      if (rescheduled) {
        const now = new Date(this.now()).toISOString();
        await tx.query(`/* webinars.cancel-stale-reminders */ UPDATE app.webinar_jobs SET state = 'cancelled', detail = 'Superseded by a reschedule', updated_at = clock_timestamp()
          WHERE workspace_id = app_private.current_workspace_id() AND event_id = $1 AND kind = 'message' AND purpose = 'reminder' AND state = 'queued'`, [id]);
        await tx.query(`/* webinars.requeue */ SELECT app_private.webinar_requeue_event_messages($1, $2)`, [id, now]);
        await tx.query(`/* webinars.reschedule-notices */ INSERT INTO app.webinar_jobs (workspace_id, event_id, registration_id, kind, purpose, dedupe_key, schedule_version, run_after, expires_at)
          SELECT r.workspace_id, r.event_id, r.id, 'message', 'reschedule', 'msg:' || r.id::text || ':reschedule:v' || e.schedule_version::text, e.schedule_version, $2::timestamptz, e.starts_at
          FROM app.webinar_registrations r JOIN app.webinar_events e ON e.workspace_id = r.workspace_id AND e.id = r.event_id
          WHERE r.workspace_id = app_private.current_workspace_id() AND r.event_id = $1 AND r.status = 'registered'
          ON CONFLICT (workspace_id, dedupe_key) DO NOTHING`, [id, now]);
      }
      return { rescheduled };
    });
  }

  async setStatus(identity: PortalSessionIdentity, requestId: string, id: string, action: 'publish' | 'unpublish' | 'cancel' | 'archive'): Promise<void> {
    await this.managed(identity, requestId, async (tx) => {
      const e = await this.loadEvent(tx, id, true);
      const now = new Date(this.now()).toISOString();
      if (action === 'publish') {
        if (e.status !== 'draft') throw new WebinarError(409, 'Only a draft can be published.');
        if (e.kind !== 'on_demand' && !e.startsAt) throw new WebinarError(400, 'Add a start date and time before publishing.');
        if (e.kind !== 'live' && e.videoState !== 'ready' && e.videoState !== 'processing' && e.videoState !== 'awaiting_upload') {
          throw new WebinarError(400, 'Upload the recording before publishing this webinar.');
        }
        await tx.query(`UPDATE app.webinar_events SET status = 'published', row_version = row_version + 1, updated_at = clock_timestamp()
          WHERE workspace_id = app_private.current_workspace_id() AND id = $1`, [id]);
        await tx.query(`SELECT app_private.webinar_requeue_event_messages($1, $2)`, [id, now]);
      } else if (action === 'unpublish') {
        if (e.status !== 'published') throw new WebinarError(409, 'Only a published webinar can be returned to draft.');
        const regs = await tx.query(`SELECT 1 FROM app.webinar_registrations WHERE workspace_id = app_private.current_workspace_id() AND event_id = $1 LIMIT 1`, [id]);
        if (regs.rowCount) throw new WebinarError(409, 'People have registered. Cancel the webinar instead so they are told.');
        await tx.query(`UPDATE app.webinar_events SET status = 'draft', row_version = row_version + 1, updated_at = clock_timestamp()
          WHERE workspace_id = app_private.current_workspace_id() AND id = $1`, [id]);
      } else if (action === 'cancel') {
        if (e.status !== 'published' && e.status !== 'draft') throw new WebinarError(409, 'This webinar cannot be cancelled.');
        await tx.query(`UPDATE app.webinar_events SET status = 'cancelled', row_version = row_version + 1, updated_at = clock_timestamp()
          WHERE workspace_id = app_private.current_workspace_id() AND id = $1`, [id]);
        await tx.query(`UPDATE app.webinar_jobs SET state = 'cancelled', detail = 'Webinar cancelled', updated_at = clock_timestamp()
          WHERE workspace_id = app_private.current_workspace_id() AND event_id = $1 AND kind = 'message' AND state = 'queued'`, [id]);
        if (e.status === 'published') {
          await tx.query(`INSERT INTO app.webinar_jobs (workspace_id, event_id, registration_id, kind, purpose, dedupe_key, schedule_version, run_after, expires_at)
            SELECT r.workspace_id, r.event_id, r.id, 'message', 'cancellation', 'msg:' || r.id::text || ':cancellation', $3, $2::timestamptz, $2::timestamptz + interval '3 days'
            FROM app.webinar_registrations r WHERE r.workspace_id = app_private.current_workspace_id() AND r.event_id = $1 AND r.status = 'registered'
            ON CONFLICT (workspace_id, dedupe_key) DO NOTHING`, [id, now, e.scheduleVersion]);
        }
      } else {
        if (e.status === 'published' && e.sessionState === 'live') throw new WebinarError(409, 'End the live session first.');
        await tx.query(`UPDATE app.webinar_events SET status = 'archived', row_version = row_version + 1, updated_at = clock_timestamp()
          WHERE workspace_id = app_private.current_workspace_id() AND id = $1`, [id]);
        await tx.query(`UPDATE app.webinar_jobs SET state = 'cancelled', detail = 'Webinar archived', updated_at = clock_timestamp()
          WHERE workspace_id = app_private.current_workspace_id() AND event_id = $1 AND state = 'queued'`, [id]);
      }
    });
  }

  // ── video: uploads ───────────────────────────────────────────────────────

  private requireStream(): CloudflareStreamClient {
    if (!this.deps.stream) throw new WebinarError(503, 'Cloudflare Stream is not configured on this deployment.');
    return this.deps.stream;
  }

  /** Starts a resumable direct upload; the browser sends the bytes to Cloudflare. */
  async beginUpload(identity: PortalSessionIdentity, requestId: string, id: string, bytes: number, fileName: string): Promise<{ uploadUrl: string }> {
    const stream = this.requireStream();
    const { event } = await this.get(identity, requestId, id);
    if (event.kind === 'live') throw new WebinarError(400, 'A live webinar records its own replay; upload is for on-demand and scheduled recordings.');
    if (event.status === 'cancelled' || event.status === 'archived') throw new WebinarError(409, 'This webinar is closed.');
    if (event.status === 'published' && event.videoState === 'ready') throw new WebinarError(409, 'This published webinar already has a ready video. Return it to draft to replace it.');
    let upload: { uploadUrl: string; uid: string };
    try {
      upload = await stream.createTusUpload(bytes, { name: `${event.title} (${event.id})`.slice(0, 120), maxDurationSeconds: this.deps.config.limits.maxUploadMinutes * 60, webinarId: event.id });
    } catch (error) {
      throw new WebinarError(error instanceof StreamError && error.status === 400 ? 400 : 502, error instanceof Error ? error.message : 'Upload could not start.');
    }
    await this.managed(identity, requestId, async (tx) => {
      await tx.query(`/* webinars.bind-upload */ UPDATE app.webinar_events SET video_uid = $2, video_state = 'awaiting_upload', video_duration_seconds = NULL,
          video_detail = NULL, row_version = row_version + 1, updated_at = clock_timestamp()
        WHERE workspace_id = app_private.current_workspace_id() AND id = $1`, [id, upload.uid]);
      await tx.query(`/* webinars.reconcile-upload-job */ INSERT INTO app.webinar_jobs (workspace_id, event_id, kind, dedupe_key, run_after, expires_at)
        VALUES (app_private.current_workspace_id(), $1, 'reconcile_video', 'reconcile-video:' || $2, $3::timestamptz + interval '2 minutes', $3::timestamptz + interval '2 days')
        ON CONFLICT (workspace_id, dedupe_key) DO NOTHING`, [id, upload.uid, new Date(this.now()).toISOString()]);
    });
    return { uploadUrl: upload.uploadUrl };
  }

  /** Called by the browser after its last chunk; polls Cloudflare once rather than trusting the browser. */
  async uploadFinished(identity: PortalSessionIdentity, requestId: string, id: string): Promise<WebinarEvent> {
    const stream = this.requireStream();
    const { event } = await this.get(identity, requestId, id);
    if (!event.videoUid) throw new WebinarError(409, 'No upload is in progress.');
    const v = await stream.getVideo(event.videoUid).catch(() => null);
    if (v) {
      await this.managed(identity, requestId, (tx) => applyVideoState(tx, id, v.readyToStream ? 'ready' : v.state === 'error' ? 'failed' : 'processing', v.duration, v.errorReason));
      if (v.readyToStream || v.state !== 'error') await stream.protectVideo(v.uid, this.playbackOrigins(event.workspaceId)).catch(() => undefined);
    }
    return (await this.get(identity, requestId, id)).event;
  }

  playbackOrigins(workspaceId: string): string[] {
    return playbackHosts(this.deps.config, workspaceId);
  }

  // ── video: live input ─────────────────────────────────────────────────────

  /**
   * Requests a recording live input. The provider call runs as a durable job: a
   * crash mid-call leaves 'unknown', which is reconciled by searching for the
   * job id in live input metadata — never by creating a second input.
   */
  async provisionLiveInput(identity: PortalSessionIdentity, requestId: string, id: string): Promise<void> {
    const stream = this.requireStream();
    const job = await this.managed(identity, requestId, async (tx) => {
      const e = await this.loadEvent(tx, id, true);
      if (e.kind !== 'live') throw new WebinarError(400, 'Only live webinars need a live input.');
      if (e.liveInputUid) throw new WebinarError(409, 'This webinar already has a live input.');
      const used = await tx.query(`SELECT count(*) AS n FROM app.webinar_events WHERE workspace_id = app_private.current_workspace_id()
        AND live_input_uid IS NOT NULL AND status IN ('draft', 'published')`);
      if (Number(used.rows[0].n) >= this.deps.config.limits.maxLiveInputsPerWorkspace) {
        throw new WebinarError(409, `This brand already has ${used.rows[0].n} live input(s), the limit set by WEBINAR_MAX_LIVE_INPUTS_PER_WORKSPACE. Archive a finished live webinar first.`);
      }
      const existing = await tx.query(`SELECT id, state FROM app.webinar_jobs WHERE workspace_id = app_private.current_workspace_id()
        AND dedupe_key = $1`, [`live-input:${id}`]);
      if (existing.rowCount) {
        const state = String(existing.rows[0].state);
        if (state === 'unknown') throw new WebinarError(409, 'A previous request may have created a live input. Use "Check provider" to reconcile it before trying again.');
        if (state !== 'failed') throw new WebinarError(409, 'A live input request is already in progress.');
        await tx.query(`UPDATE app.webinar_jobs SET state = 'queued', attempts = 0, detail = NULL, lease_token = NULL, lease_until = NULL, updated_at = clock_timestamp()
          WHERE workspace_id = app_private.current_workspace_id() AND id = $1`, [existing.rows[0].id]);
        await tx.query(`UPDATE app.webinar_events SET live_state = 'provisioning', updated_at = clock_timestamp() WHERE workspace_id = app_private.current_workspace_id() AND id = $1`, [id]);
        return String(existing.rows[0].id);
      }
      const r = await tx.query(`INSERT INTO app.webinar_jobs (workspace_id, event_id, kind, dedupe_key, run_after)
        VALUES (app_private.current_workspace_id(), $1, 'provision_live_input', $2, $3) RETURNING id`, [id, `live-input:${id}`, new Date(this.now()).toISOString()]);
      await tx.query(`UPDATE app.webinar_events SET live_state = 'provisioning', updated_at = clock_timestamp() WHERE workspace_id = app_private.current_workspace_id() AND id = $1`, [id]);
      return String(r.rows[0].id);
    });
    // Run it now so the host sees the result; the worker picks it up if this request dies.
    await runProvisionJob(this.deps.pool, stream, this.deps.config, identity.workspaceId, job, this.now);
  }

  /** Re-checks an 'unknown' provisioning job against the provider. */
  async reconcileLiveInput(identity: PortalSessionIdentity, requestId: string, id: string): Promise<string> {
    const stream = this.requireStream();
    const job = await this.managed(identity, requestId, async (tx) => {
      const r = await tx.query(`SELECT id, state FROM app.webinar_jobs WHERE workspace_id = app_private.current_workspace_id() AND dedupe_key = $1`, [`live-input:${id}`]);
      return r.rowCount ? { id: String(r.rows[0].id), state: String(r.rows[0].state) } : null;
    });
    if (!job || job.state !== 'unknown') return 'Nothing to reconcile.';
    const found = await stream.findLiveInputByJob(job.id);
    await withTransaction(this.deps.pool, workerDatabaseContext({ workspaceId: identity.workspaceId, requestId }), async (tx) => {
      if (found) {
        await bindLiveInput(tx, id, found);
        await settleJob(tx, job.id, 'done', 'Reconciled: found the live input created by the interrupted request.', { liveInputUid: found });
      } else {
        await settleJob(tx, job.id, 'failed', 'Reconciled: Cloudflare has no live input for that request. You can request one again.', {});
        await tx.query(`UPDATE app.webinar_events SET live_state = 'not_provisioned', updated_at = clock_timestamp() WHERE workspace_id = app_private.current_workspace_id() AND id = $1`, [id]);
      }
    });
    return found ? 'Found and connected the existing live input.' : 'No live input was created. You can request one again.';
  }

  /** State of the live-input provisioning job, so the UI can offer reconciliation for 'unknown'. */
  async provisionState(identity: PortalSessionIdentity, requestId: string, id: string): Promise<string | null> {
    return this.managed(identity, requestId, async (tx) => {
      const r = await tx.query(`SELECT state FROM app.webinar_jobs WHERE workspace_id = app_private.current_workspace_id() AND dedupe_key = $1`, [`live-input:${id}`]);
      return r.rowCount ? String(r.rows[0].state) : null;
    });
  }

  /** Ingest credentials, fetched from Cloudflare on demand and never stored or logged. */
  async liveCredentials(identity: PortalSessionIdentity, requestId: string, id: string): Promise<LiveInputCredentials> {
    const stream = this.requireStream();
    const { event } = await this.get(identity, requestId, id);
    if (!event.liveInputUid) throw new WebinarError(409, 'Request a live input first.');
    return (await stream.getLiveInput(event.liveInputUid)).credentials;
  }

  /**
   * Ingest details for the browser-studio relay (server-side only; never sent to
   * the browser). Requires owner/admin rights through get().
   */
  async studioIngest(identity: PortalSessionIdentity, requestId: string, id: string): Promise<{ workspaceId: string; eventId: string; ingestUrl: string; streamKey: string }> {
    const { event } = await this.get(identity, requestId, id);
    if (event.kind !== 'live') throw new WebinarError(409, 'The studio is for live webinars.');
    if (event.status === 'cancelled' || event.status === 'archived') throw new WebinarError(409, `This webinar is ${event.status}.`);
    if (event.sessionState === 'ended') throw new WebinarError(409, 'This session has ended.');
    const c = await this.liveCredentials(identity, requestId, id);
    if (!c.rtmpsUrl || !c.rtmpsStreamKey) throw new WebinarError(409, 'Cloudflare returned no RTMPS ingest for this live input.');
    return { workspaceId: event.workspaceId, eventId: event.id, ingestUrl: c.rtmpsUrl, streamKey: c.rtmpsStreamKey };
  }

  /** Reads the provider's connection state now and stores it. */
  async refreshLive(identity: PortalSessionIdentity, requestId: string, id: string): Promise<WebinarEvent> {
    const stream = this.requireStream();
    const { event } = await this.get(identity, requestId, id);
    if (event.liveInputUid) {
      const status = await stream.getLiveInput(event.liveInputUid).then((r) => r.connection, () => 'unknown' as const);
      await this.managed(identity, requestId, (tx) => tx.query(`UPDATE app.webinar_events SET live_state = $2, live_checked_at = $3
        WHERE workspace_id = app_private.current_workspace_id() AND id = $1`, [id, status, new Date(this.now()).toISOString()]));
    }
    return (await this.get(identity, requestId, id)).event;
  }

  /** Opening the session is a host decision; a connected encoder alone is only a rehearsal. */
  async startSession(identity: PortalSessionIdentity, requestId: string, id: string): Promise<void> {
    await this.managed(identity, requestId, async (tx) => {
      const e = await this.loadEvent(tx, id, true);
      if (e.kind !== 'live' || e.status !== 'published') throw new WebinarError(409, 'Publish this live webinar before going live.');
      if (!e.liveInputUid) throw new WebinarError(409, 'Request a live input and connect your encoder first.');
      if (e.sessionState !== 'scheduled') throw new WebinarError(409, 'This session has already been started.');
      await tx.query(`UPDATE app.webinar_events SET session_state = 'live', session_started_at = $2, row_version = row_version + 1, updated_at = clock_timestamp()
        WHERE workspace_id = app_private.current_workspace_id() AND id = $1`, [id, new Date(this.now()).toISOString()]);
    });
  }

  async endSession(identity: PortalSessionIdentity, requestId: string, id: string): Promise<void> {
    await this.managed(identity, requestId, async (tx) => {
      const e = await this.loadEvent(tx, id, true);
      if (e.sessionState !== 'live') throw new WebinarError(409, 'The session is not live.');
      const now = new Date(this.now()).toISOString();
      await tx.query(`UPDATE app.webinar_events SET session_state = 'ended', session_ended_at = $2,
          recording_state = CASE WHEN recording_state = 'ready' THEN recording_state ELSE 'processing' END,
          row_version = row_version + 1, updated_at = clock_timestamp()
        WHERE workspace_id = app_private.current_workspace_id() AND id = $1`, [id, now]);
      // The worker polls Cloudflare until the recording is ready (webhook-independent).
      await tx.query(`INSERT INTO app.webinar_jobs (workspace_id, event_id, kind, dedupe_key, run_after, expires_at)
        VALUES (app_private.current_workspace_id(), $1::uuid, 'reconcile_recording', 'reconcile-recording:' || $1::text, $2::timestamptz + interval '1 minute', $2::timestamptz + interval '2 days')
        ON CONFLICT (workspace_id, dedupe_key) DO NOTHING`, [id, now]);
    });
  }

  async setCta(identity: PortalSessionIdentity, requestId: string, id: string, reveal: boolean): Promise<void> {
    await this.managed(identity, requestId, async (tx) => {
      const e = await this.loadEvent(tx, id, true);
      if (!e.settings.cta) throw new WebinarError(400, 'Add a call to action in the webinar details first.');
      await tx.query(`UPDATE app.webinar_events SET cta_revealed_at = $2, row_version = row_version + 1, updated_at = clock_timestamp()
        WHERE workspace_id = app_private.current_workspace_id() AND id = $1`, [id, reveal ? new Date(this.now()).toISOString() : null]);
    });
  }

  /** Host-only preview of the broadcast, available before attendees can see it. */
  async hostPreview(identity: PortalSessionIdentity, requestId: string, id: string): Promise<{ hlsUrl: string; expiresAt: string } | null> {
    const stream = this.deps.stream;
    if (!stream) return null;
    const { event } = await this.get(identity, requestId, id);
    const uid = event.kind === 'live' ? (event.sessionState === 'ended' ? event.recordingUid : event.liveInputUid) : event.videoUid;
    if (!uid) return null;
    const signed = stream.signPlayback(uid, this.now(), 1800);
    return { hlsUrl: stream.hlsUrl(signed.token), expiresAt: signed.expiresAt };
  }

  // ── people, questions, messages, results ─────────────────────────────────

  async registrants(identity: PortalSessionIdentity, requestId: string, id: string, limit = 2000): Promise<RegistrationRow[]> {
    return this.managed(identity, requestId, async (tx) => {
      await this.loadEvent(tx, id);
      const r = await tx.query(`/* webinars.registrants */ SELECT g.id, g.email, g.name, g.status, g.marketing_consent, g.answers, g.attribution, g.created_at, g.crm_contact_id,
          EXISTS (SELECT 1 FROM app.webinar_signals s WHERE s.workspace_id = g.workspace_id AND s.registration_id = g.id AND s.kind = 'room_accessed') AS accessed,
          EXISTS (SELECT 1 FROM app.webinar_signals s WHERE s.workspace_id = g.workspace_id AND s.registration_id = g.id AND s.kind = 'player_started') AS started,
          coalesce((SELECT sum(s.to_seconds - s.from_seconds) FROM app.webinar_signals s WHERE s.workspace_id = g.workspace_id AND s.registration_id = g.id AND s.kind = 'watch_interval'), 0) AS watched,
          EXISTS (SELECT 1 FROM app.webinar_signals s WHERE s.workspace_id = g.workspace_id AND s.registration_id = g.id AND s.kind = 'cta_clicked') AS clicked,
          (SELECT count(*) FROM app.webinar_questions q WHERE q.workspace_id = g.workspace_id AND q.registration_id = g.id) AS questions
        FROM app.webinar_registrations g WHERE g.workspace_id = app_private.current_workspace_id() AND g.event_id = $1
        ORDER BY g.created_at DESC LIMIT $2`, [id, Math.min(Math.max(limit, 1), 5000)]);
      return r.rows.map((row) => Object.freeze({
        id: String(row.id), email: String(row.email), name: String(row.name), status: row.status, marketingConsent: row.marketing_consent === true,
        answers: (row.answers ?? {}) as Record<string, string>, attribution: (row.attribution ?? {}) as Record<string, string>,
        createdAt: new Date(row.created_at).toISOString(), crmContactId: row.crm_contact_id ?? null,
        accessedRoom: row.accessed === true, playerStarted: row.started === true, watchedSeconds: Math.round(Number(row.watched)),
        ctaClicked: row.clicked === true, questions: Number(row.questions),
      }));
    });
  }

  async questions(identity: PortalSessionIdentity, requestId: string, id: string): Promise<QuestionRow[]> {
    return this.managed(identity, requestId, async (tx) => {
      await this.loadEvent(tx, id);
      const r = await tx.query(`/* webinars.questions */ SELECT q.id, q.body, q.status, q.answer, q.created_at, g.name
        FROM app.webinar_questions q JOIN app.webinar_registrations g ON g.workspace_id = q.workspace_id AND g.id = q.registration_id
        WHERE q.workspace_id = app_private.current_workspace_id() AND q.event_id = $1
        ORDER BY (q.status = 'pending') DESC, q.created_at DESC LIMIT 500`, [id]);
      return r.rows.map((row) => Object.freeze({ id: String(row.id), body: String(row.body), status: row.status, answer: row.answer ?? null,
        askedBy: String(row.name), createdAt: new Date(row.created_at).toISOString() }));
    });
  }

  async moderate(identity: PortalSessionIdentity, requestId: string, id: string, questionId: string, action: 'approve' | 'answer' | 'dismiss', answer: string): Promise<void> {
    if (!UUID.test(questionId)) throw new WebinarError(404, 'Question not found.');
    if (action === 'answer' && (answer.trim().length < 1 || answer.length > 2000)) throw new WebinarError(400, 'Write an answer of up to 2,000 characters.');
    await this.managed(identity, requestId, async (tx) => {
      const r = await tx.query(`/* webinars.moderate */ UPDATE app.webinar_questions SET status = $3,
          answer = CASE WHEN $3 = 'answered' THEN $4 ELSE answer END, moderated_by_user_id = app_private.current_user_id(), moderated_at = clock_timestamp()
        WHERE workspace_id = app_private.current_workspace_id() AND event_id = $1 AND id = $2`,
        [id, questionId, action === 'approve' ? 'approved' : action === 'answer' ? 'answered' : 'dismissed', answer.trim() || null]);
      if (r.rowCount !== 1) throw new WebinarError(404, 'Question not found.');
    });
  }

  async messageStatus(identity: PortalSessionIdentity, requestId: string, id: string): Promise<MessageStatusRow[]> {
    return this.managed(identity, requestId, async (tx) => {
      await this.loadEvent(tx, id);
      const r = await tx.query(`/* webinars.message-status */ SELECT purpose, state, count(*) AS n,
          (array_agg(detail ORDER BY updated_at DESC) FILTER (WHERE detail IS NOT NULL))[1] AS last_detail
        FROM app.webinar_jobs WHERE workspace_id = app_private.current_workspace_id() AND event_id = $1 AND kind = 'message'
        GROUP BY purpose, state ORDER BY purpose, state`, [id]);
      return r.rows.map((row) => Object.freeze({ purpose: String(row.purpose), state: String(row.state), count: Number(row.n), lastDetail: row.last_detail ?? null }));
    });
  }

  async results(identity: PortalSessionIdentity, requestId: string, id: string): Promise<WebinarResults> {
    return this.managed(identity, requestId, async (tx) => {
      await this.loadEvent(tx, id);
      const ws = 'app_private.current_workspace_id()';
      const head = await tx.query(`/* webinars.results */ SELECT
          (SELECT count(*) FROM app.webinar_registrations WHERE workspace_id = ${ws} AND event_id = $1 AND status = 'registered') AS registered,
          (SELECT count(DISTINCT registration_id) FROM app.webinar_signals WHERE workspace_id = ${ws} AND event_id = $1 AND kind = 'room_accessed') AS accessed,
          (SELECT count(DISTINCT registration_id) FROM app.webinar_signals WHERE workspace_id = ${ws} AND event_id = $1 AND kind = 'player_started') AS started,
          (SELECT coalesce(sum(to_seconds - from_seconds), 0) FROM app.webinar_signals WHERE workspace_id = ${ws} AND event_id = $1 AND kind = 'watch_interval') AS observed,
          (SELECT count(DISTINCT registration_id) FROM app.webinar_signals WHERE workspace_id = ${ws} AND event_id = $1 AND kind = 'cta_clicked') AS clickers,
          (SELECT count(*) FROM app.webinar_questions WHERE workspace_id = ${ws} AND event_id = $1) AS questions,
          (SELECT count(*) FROM app.webinar_registrations WHERE workspace_id = ${ws} AND event_id = $1 AND crm_contact_id IS NOT NULL) AS crm`, [id]);
      const watched = await tx.query(`SELECT t.minutes, count(*) FILTER (WHERE w.seconds >= t.minutes * 60) AS people
        FROM (VALUES (1), (10), (30), (60)) AS t(minutes)
        CROSS JOIN (SELECT registration_id, sum(to_seconds - from_seconds) AS seconds FROM app.webinar_signals
          WHERE workspace_id = ${ws} AND event_id = $1 AND kind = 'watch_interval' GROUP BY registration_id) w
        GROUP BY t.minutes ORDER BY t.minutes`, [id]);
      const modes = await tx.query(`SELECT mode, count(DISTINCT registration_id) AS people FROM app.webinar_signals
        WHERE workspace_id = ${ws} AND event_id = $1 AND kind = 'player_started' GROUP BY mode ORDER BY mode`, [id]);
      const sources = await tx.query(`SELECT coalesce(nullif(g.attribution ->> 'utm_source', ''), nullif(g.attribution ->> 'referrerHost', ''), 'direct') AS source,
          count(*) AS registered,
          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM app.webinar_signals s WHERE s.workspace_id = g.workspace_id AND s.registration_id = g.id AND s.kind = 'player_started')) AS started
        FROM app.webinar_registrations g WHERE g.workspace_id = ${ws} AND g.event_id = $1 GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, [id]);
      const h = head.rows[0];
      return Object.freeze({
        registered: Number(h.registered), accessedRoom: Number(h.accessed), playerStarted: Number(h.started),
        totalObservedMinutes: Math.round(Number(h.observed) / 60), ctaClickers: Number(h.clickers), questions: Number(h.questions), crmLinked: Number(h.crm),
        watchedAtLeast: (watched.rows.length ? watched.rows : [1, 10, 30, 60].map((m) => ({ minutes: m, people: 0 }))).map((r) => ({ minutes: Number(r.minutes), people: Number(r.people) })),
        byMode: modes.rows.map((r) => ({ mode: String(r.mode), people: Number(r.people) })),
        bySource: sources.rows.map((r) => ({ source: String(r.source).slice(0, 80), registered: Number(r.registered), playerStarted: Number(r.started) })),
      });
    });
  }

  /**
   * Sends up to `batch` unlinked registrants to the existing CRM through its
   * established command boundary. Idempotent per registration: the CRM command
   * key is fixed, so a retry replays rather than duplicating. Registration alone does
   * not grant marketing permission; only the form's explicit opt-in is passed as consent.
   */
  async sendToCrm(identity: PortalSessionIdentity, requestId: string, id: string, batch = 25): Promise<{ linked: number; replayed: number; failed: number; remaining: number }> {
    return this.handoff(this.context(identity, requestId), identity.userId, id, batch);
  }

  /**
   * Worker path for webinars with automatic handoff on: new registrants of each
   * published webinar are sent to the CRM acting as the webinar's creator, under
   * that user's own RLS context. A creator who is no longer an owner simply fails
   * the authority check, and the registrants wait for a manual send.
   */
  async autoHandoff(workspaceId: string, requestId: string, batch = 25): Promise<{ events: number; linked: number; failed: number }> {
    if (!this.deps.crm || !UUID.test(workspaceId)) return { events: 0, linked: 0, failed: 0 };
    const due = await withTransaction(this.deps.pool, workerDatabaseContext({ workspaceId, requestId }), async (tx) => (await tx.query(
      `/* webinars.auto-handoff-due */ SELECT e.id, e.created_by_user_id AS creator, e.settings FROM app.webinar_events e
        WHERE e.workspace_id = app_private.current_workspace_id() AND e.status = 'published' AND e.created_by_user_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM app.webinar_registrations g WHERE g.workspace_id = e.workspace_id AND g.event_id = e.id
            AND g.status = 'registered' AND g.crm_contact_id IS NULL)
        ORDER BY e.starts_at LIMIT 10`)).rows as { id: string; creator: string; settings: unknown }[]);
    let events = 0, linked = 0, failed = 0;
    for (const row of due) {
      if (!readSettings(row.settings).crmAutoHandoff || !UUID.test(row.creator)) continue;
      events += 1;
      try {
        const r = await this.handoff(requestDatabaseContext({ workspaceId, userId: row.creator, requestId }), row.creator, row.id, batch);
        linked += r.linked + r.replayed;
        failed += r.failed;
      } catch {
        failed += 1;
      }
    }
    return { events, linked, failed };
  }

  private async handoff(context: DatabaseRequestContext, actorUserId: string, id: string, batch: number): Promise<{ linked: number; replayed: number; failed: number; remaining: number }> {
    const crm = this.deps.crm;
    if (!crm) throw new WebinarError(503, 'The CRM command identity is not configured on this deployment.');
    const event = await this.managedIn(context, (tx) => this.loadEvent(tx, id));
    const pending = await this.managedIn(context, async (tx) => (await tx.query(`SELECT id, email, name, marketing_consent FROM app.webinar_registrations
      WHERE workspace_id = app_private.current_workspace_id() AND event_id = $1 AND status = 'registered' AND crm_contact_id IS NULL
      ORDER BY created_at LIMIT $2`, [id, batch])).rows as { id: string; email: string; name: string; marketing_consent: boolean }[]);
    const stage = await withTransaction(crm.pool, context, async (tx) => {
      const r = await tx.query(`/* webinars.crm-new-stage */ SELECT p.id AS "pipelineId", s.id AS "stageId"
        FROM app.pipelines p JOIN app.pipeline_stages s ON s.workspace_id = p.workspace_id AND s.pipeline_id = p.id
        WHERE p.workspace_id = app_private.current_workspace_id() AND p.status = 'active' AND p.is_default
          AND s.stage_type = 'open' AND NOT s.is_terminal ORDER BY s.position LIMIT 1`);
      return r.rowCount === 1 ? r.rows[0] as { pipelineId: string; stageId: string } : null;
    });
    if (!stage) throw new WebinarError(409, 'This workspace has no active default CRM pipeline to receive webinar registrants.');
    let linked = 0, replayed = 0, failed = 0;
    for (const reg of pending) {
      try {
        const result = await crm.commands.createLead(context, {
          commandKey: `webinar.${event.id}.${reg.id}`,
          displayName: reg.name.slice(0, 200) || reg.email,
          ownerUserId: actorUserId,
          source: `webinar:${event.publicKey}:${reg.id}`,
          // The registration form's explicit opt-in is the only evidence that travels; without it, consent stays unknown.
          contactPoints: [{ kind: 'email', value: reg.email, isPrimary: true, consentStatus: reg.marketing_consent === true ? 'opted_in' : 'unknown' }],
          pipelineId: stage.pipelineId, stageId: stage.stageId,
          opportunityName: `${event.settings.crmOpportunityPrefix}: ${event.title} · ${reg.name}`.slice(0, 200),
          valueMinor: 0, currency: 'GBP',
        });
        await this.managedIn(context, (tx) => tx.query(`UPDATE app.webinar_registrations SET crm_contact_id = $2, crm_opportunity_id = $3, crm_linked_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE workspace_id = app_private.current_workspace_id() AND id = $1`, [reg.id, result.contactId, result.opportunityId]));
        if (result.disposition === 'applied') linked += 1; else replayed += 1;
      } catch {
        failed += 1;
      }
    }
    const remaining = await this.managedIn(context, async (tx) => Number((await tx.query(`SELECT count(*) AS n FROM app.webinar_registrations
      WHERE workspace_id = app_private.current_workspace_id() AND event_id = $1 AND status = 'registered' AND crm_contact_id IS NULL`, [id])).rows[0].n));
    return { linked, replayed, failed, remaining };
  }

  // ── attendees (public) ───────────────────────────────────────────────────

  async publicEvent(publicKey: string): Promise<PublicEvent | null> {
    if (!/^[a-z0-9][a-z0-9-]{2,70}[a-z0-9]$/.test(publicKey)) return null;
    const r = await this.deps.pool.query(`/* webinars.public-event */ SELECT app_private.webinar_public_event($1) AS e`, [publicKey]);
    const raw = r.rows[0]?.e as Record<string, unknown> | null;
    if (!raw) return null;
    const b = (raw.brand ?? {}) as Record<string, unknown>;
    return Object.freeze({
      event: toEvent(raw),
      brand: Object.freeze({ workspaceName: String(b.workspaceName ?? ''), productName: (b.productName as string | null) ?? null,
        primaryColor: (b.primaryColor as string | null) ?? null, accentColor: (b.accentColor as string | null) ?? null, supportEmail: (b.supportEmail as string | null) ?? null }),
      registered: Number(raw.registered ?? 0),
    });
  }

  async register(publicKey: string, input: {
    email: string; name: string; answers: Record<string, string>; marketing: boolean; consent: Record<string, unknown>; attribution: Record<string, string>;
  }): Promise<{ outcome: 'created' | 'existing' | 'full' | 'closed' | 'unavailable'; token: string | null; registrationId: string | null }> {
    const secret = this.deps.config.accessSecret;
    if (!secret) throw new WebinarError(503, 'Registration is temporarily unavailable.');
    const email = input.email.trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 320) throw new WebinarError(400, 'Enter a valid email address.');
    const name = input.name.trim().replace(/[\u0000-\u001f\u007f]/g, '');
    if (name.length < 1 || name.length > 120) throw new WebinarError(400, 'Enter your name.');
    const r = await this.deps.pool.query(`/* webinars.register */ SELECT app_private.webinar_register($1, $2, $3, $4, $5, $6, $7, $8) AS r`,
      [publicKey, email, name, JSON.stringify(input.answers), input.marketing, JSON.stringify(input.consent), JSON.stringify(input.attribution), new Date(this.now()).toISOString()]);
    const out = r.rows[0].r as Record<string, unknown>;
    const outcome = out.outcome as 'created' | 'existing' | 'full' | 'closed' | 'unavailable';
    // Only a brand-new registration gets instant access in this browser. Typing a
    // registered address never hands over that person's access: they get an email link.
    const token = outcome === 'created' ? issueAccessToken(secret, publicKey, { registrationId: String(out.registrationId), version: Number(out.tokenVersion) }) : null;
    return { outcome, token, registrationId: outcome === 'created' || outcome === 'existing' ? String(out.registrationId) : null };
  }

  async requestAccessLink(publicKey: string, email: string): Promise<void> {
    await this.deps.pool.query(`/* webinars.access-link */ SELECT app_private.webinar_request_access_link($1, $2, $3)`,
      [publicKey, email.trim().toLowerCase().slice(0, 320), new Date(this.now()).toISOString()]);
  }

  async attendee(publicKey: string, claim: AccessClaim): Promise<{ registrationId: string; name: string; email: string; event: PublicEvent } | null> {
    const r = await this.deps.pool.query(`/* webinars.attendee */ SELECT app_private.webinar_attendee($1, $2, $3) AS a`, [publicKey, claim.registrationId, claim.version]);
    const a = r.rows[0]?.a as Record<string, unknown> | null;
    if (!a) return null;
    const evRaw = a.event as Record<string, unknown>;
    const b = (evRaw.brand ?? {}) as Record<string, unknown>;
    return {
      registrationId: String(a.registrationId), name: String(a.name), email: String(a.email),
      event: { event: toEvent(evRaw), registered: Number(evRaw.registered ?? 0),
        brand: { workspaceName: String(b.workspaceName ?? ''), productName: (b.productName as string | null) ?? null, primaryColor: (b.primaryColor as string | null) ?? null,
          accentColor: (b.accentColor as string | null) ?? null, supportEmail: (b.supportEmail as string | null) ?? null } },
    };
  }

  /** Room state plus a short-lived signed URL when there is something to play. */
  playback(event: WebinarEvent): Playback {
    const nowMs = this.now();
    const room = computeRoomState({ event, nowMs, providerConfigured: this.deps.stream !== null });
    let hlsUrl: string | null = null, expiresAt: string | null = null;
    if (room.playUid && this.deps.stream) {
      const signed = this.signedPlayback(this.deps.stream, room.playUid, nowMs);
      hlsUrl = this.deps.stream.hlsUrl(signed.token);
      expiresAt = signed.expiresAt;
    }
    const c = event.settings.cta;
    // A manual CTA is withheld entirely until the host reveals it, so attendees cannot read it early.
    const released = c !== null && (c.mode === 'manual' ? event.ctaRevealedAt !== null : c.atSeconds !== null);
    const cta = c && released ? { label: c.label, url: c.url, body: c.body, atSeconds: c.mode === 'timed' ? c.atSeconds : null, visible: true } : null;
    return Object.freeze({ room, hlsUrl, expiresAt, cta, serverNow: new Date(nowMs).toISOString() });
  }

  /** One-hour tokens, re-signed only once fewer than 20 minutes remain (the room swaps sources at 10). */
  private signedPlayback(stream: CloudflareStreamClient, uid: string, nowMs: number): { token: string; expiresAt: string } {
    const cached = this.signed.get(uid);
    if (cached && cached.expMs - nowMs > 20 * 60_000) return cached;
    if (this.signed.size > 2000) this.signed.clear();
    const fresh = stream.signPlayback(uid, nowMs, 3600);
    const entry = { ...fresh, expMs: Date.parse(fresh.expiresAt) };
    this.signed.set(uid, entry);
    return entry;
  }

  async signal(publicKey: string, claim: AccessClaim, kind: string, mode: string, from: number | null, to: number | null): Promise<boolean> {
    const r = await this.deps.pool.query(`/* webinars.signal */ SELECT app_private.webinar_record_signal($1, $2, $3, $4, $5, $6, $7, $8) AS ok`,
      [publicKey, claim.registrationId, claim.version, kind, mode, from, to, new Date(this.now()).toISOString()]);
    return r.rows[0]?.ok === true;
  }

  async ask(publicKey: string, claim: AccessClaim, body: string): Promise<string> {
    const r = await this.deps.pool.query(`/* webinars.ask */ SELECT app_private.webinar_submit_question($1, $2, $3, $4, $5) AS r`,
      [publicKey, claim.registrationId, claim.version, body, new Date(this.now()).toISOString()]);
    return String((r.rows[0].r as Record<string, unknown>).outcome);
  }

  async publicQuestions(publicKey: string, claim: AccessClaim): Promise<{ id: string; body: string; status: string; answer: string | null; mine: boolean }[]> {
    const r = await this.deps.pool.query(`/* webinars.public-questions */ SELECT q FROM app_private.webinar_public_questions($1, $2, $3) AS q`,
      [publicKey, claim.registrationId, claim.version]);
    return r.rows.map((row) => {
      const q = row.q as Record<string, unknown>;
      return { id: String(q.id), body: String(q.body), status: String(q.status), answer: (q.answer as string | null) ?? null, mine: q.mine === true };
    });
  }

  roomUrl(event: WebinarEvent, claim: AccessClaim): string | null {
    const secret = this.deps.config.accessSecret;
    const origin = publicOriginFor(this.deps.config, event.workspaceId);
    if (!secret || !origin) return null;
    return `${origin}/w/${event.publicKey}/room?t=${encodeURIComponent(issueAccessToken(secret, event.publicKey, claim))}`;
  }

  // ── provider webhook ─────────────────────────────────────────────────────

  async streamNotification(receipt: Buffer, video: { uid: string; liveInput: string | null; state: string; readyToStream: boolean; duration: number | null; errorReason: string | null }): Promise<string> {
    const r = await this.deps.pool.query(`/* webinars.stream-webhook */ SELECT app_private.webinar_stream_notification($1, $2, $3, $4, $5, $6, $7, $8) AS r`,
      [receipt, video.uid, video.liveInput, video.state, video.readyToStream, video.duration, video.errorReason, new Date(this.now()).toISOString()]);
    const out = r.rows[0].r as Record<string, unknown>;
    if (out.outcome === 'applied' && out.binding === 'video' && this.deps.stream && typeof out.workspaceId === 'string') {
      await this.deps.stream.protectVideo(video.uid, this.playbackOrigins(out.workspaceId)).catch(() => undefined);
    }
    return String(out.outcome);
  }
}

// ── shared transactional helpers (also used by the worker) ─────────────────

export async function readProfile(tx: PoolClient): Promise<WorkspaceProfile | null> {
  const r = await tx.query(`/* webinars.profile */ SELECT app_private.webinar_workspace_profile() AS p`);
  const p = r.rows[0]?.p as Record<string, unknown> | null;
  if (!p) return null;
  return Object.freeze({
    workspaceId: String(p.workspaceId), name: String(p.name), slug: String(p.slug), timezone: String(p.timezone), canManage: p.canManage === true,
    brand: Object.freeze({ workspaceName: String(p.name), productName: (p.productName as string | null) ?? null, primaryColor: (p.primaryColor as string | null) ?? null,
      accentColor: (p.accentColor as string | null) ?? null, supportEmail: (p.supportEmail as string | null) ?? null }),
  });
}

export async function applyVideoState(tx: PoolClient, eventId: string, state: 'processing' | 'ready' | 'failed', duration: number | null, detail: string | null): Promise<void> {
  await tx.query(`/* webinars.video-state */ UPDATE app.webinar_events SET video_state = $2,
      video_duration_seconds = CASE WHEN $2 = 'ready' AND $3::numeric IS NOT NULL THEN $3::numeric ELSE video_duration_seconds END,
      video_detail = CASE WHEN $2 = 'failed' THEN left(coalesce($4, 'Cloudflare could not process this video'), 300) ELSE NULL END,
      row_version = row_version + 1, updated_at = clock_timestamp()
    WHERE workspace_id = app_private.current_workspace_id() AND id = $1 AND video_state <> $2`, [eventId, state, duration, detail]);
}

export async function bindLiveInput(tx: PoolClient, eventId: string, uid: string): Promise<void> {
  await tx.query(`/* webinars.bind-live-input */ UPDATE app.webinar_events SET live_input_uid = $2, live_state = 'idle', row_version = row_version + 1, updated_at = clock_timestamp()
    WHERE workspace_id = app_private.current_workspace_id() AND id = $1 AND live_input_uid IS NULL`, [eventId, uid]);
}

export async function settleJob(tx: PoolClient, jobId: string, state: 'done' | 'failed' | 'unknown' | 'queued' | 'blocked' | 'expired' | 'cancelled', detail: string | null, result: Record<string, unknown>, runAfter?: string): Promise<void> {
  await tx.query(`/* webinars.settle-job */ UPDATE app.webinar_jobs SET state = $2, detail = $3, result = result || $4::jsonb,
      run_after = coalesce($5::timestamptz, run_after), lease_token = NULL, lease_until = NULL, updated_at = clock_timestamp()
    WHERE workspace_id = app_private.current_workspace_id() AND id = $1`, [jobId, state, detail?.slice(0, 500) ?? null, JSON.stringify(result), runAfter ?? null]);
}

/**
 * Claims and runs one provisioning job: queued → calling → done/failed/unknown.
 * Exported so the request path and the worker share exactly the same semantics.
 */
export async function runProvisionJob(pool: Pool, stream: CloudflareStreamClient, config: WebinarConfig, workspaceId: string, jobId: string, now: () => number): Promise<void> {
  const requestId = `webinar-provision-${randomUUID()}`;
  const ctx = workerDatabaseContext({ workspaceId, requestId });
  const claimed = await withTransaction(pool, ctx, async (tx) => {
    const r = await tx.query(`/* webinars.claim-provision */ UPDATE app.webinar_jobs SET state = 'calling', attempts = attempts + 1, lease_token = gen_random_uuid(),
        lease_until = $2::timestamptz + interval '2 minutes', updated_at = clock_timestamp()
      WHERE workspace_id = app_private.current_workspace_id() AND id = $1 AND kind = 'provision_live_input' AND state IN ('queued', 'leased')
      RETURNING event_id`, [jobId, new Date(now()).toISOString()]);
    return r.rowCount === 1 ? String(r.rows[0].event_id) : null;
  });
  if (!claimed) return;
  try {
    const li = await stream.createLiveInput({ webinarJob: jobId, webinarEvent: claimed, workspace: workspaceId, name: `webinar ${claimed}` }, playbackHosts(config, workspaceId), config.limits.recordingRetentionDays);
    await withTransaction(pool, ctx, async (tx) => {
      await bindLiveInput(tx, claimed, li.uid);
      await settleJob(tx, jobId, 'done', null, { liveInputUid: li.uid });
    });
  } catch (error) {
    const definite = error instanceof StreamError && error.status !== null && !error.retryable;
    await withTransaction(pool, ctx, async (tx) => {
      await settleJob(tx, jobId, definite ? 'failed' : 'unknown', error instanceof Error ? error.message : 'Live input request failed', {});
      await tx.query(`UPDATE app.webinar_events SET live_state = $2, updated_at = clock_timestamp() WHERE workspace_id = app_private.current_workspace_id() AND id = $1 AND live_input_uid IS NULL`,
        [claimed, definite ? 'not_provisioned' : 'unknown']);
    });
  }
}

export { readSettings };
