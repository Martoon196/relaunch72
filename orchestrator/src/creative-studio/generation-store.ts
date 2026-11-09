/**
 * Persistence for typed-brief image generation (0144 section 5). Owner calls carry a genuine portal session;
 * worker calls carry no session and are accepted only for the claimed job. Reservation reuses the existing
 * app_private.seo_image_reserve admission, the same start projection and the same single usage debit as article images.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction, InactivePortalSessionError, type DbTransaction } from '../db/transaction.js';
import type { DatabaseRequestContext } from '../db/rls.js';
import type { PgSeoBlogPrincipal } from '../seo-blog/pg-store.js';
import type { SeoImageAttemptDecision } from '../seo-blog/media-types.js';
import { SeoBlogError, type Job } from '../seo-blog/types.js';
import { CREATIVE_BRIEF_RECIPE, CREATIVE_IMAGE_SCHEMA, type CreativeBrief, type CreativeBriefSource, type CreativeImageIntent } from './generation.js';

export interface BriefVersion { readonly id: string; readonly version: number; readonly data: CreativeBrief; readonly createdBy: string; readonly createdAt: string }
export interface GenerationRecord {
  readonly id: string; readonly briefId: string; readonly briefVersion: number; readonly jobId: string; readonly intentId: string; readonly attemptId: string;
  readonly assetId: string; readonly sha256: string; readonly width: number; readonly height: number; readonly data: Readonly<Record<string, unknown>>; readonly createdAt: string;
}
export interface GenerationJobView {
  readonly id: string; readonly state: Job['state']; readonly briefId: string; readonly briefVersion: number; readonly intentId: string;
  readonly progress: string; readonly error: string | null; readonly paidAttemptStarted: boolean; readonly createdAt: string; readonly updatedAt: string;
}
export interface GenerationAttemptView { readonly jobId: string; readonly intentId: string; readonly outcome: string; readonly reservedMicrousd: number; readonly usage: Readonly<Record<string, number | null>> | null; readonly createdAt: string }
export interface GenerationState {
  readonly briefs: readonly BriefVersion[];
  readonly generations: readonly GenerationRecord[];
  readonly jobs: readonly GenerationJobView[];
  readonly attempts: readonly GenerationAttemptView[];
  readonly usage: Readonly<{ brandImagesThisMonth: number; brandUnresolvedEarlier: number; studioImagesCounted: number; studioUnresolved: number; period: string }>;
}
export interface CreativeReserveInput {
  readonly workspaceId: string; readonly jobId: string; readonly intentId: string; readonly nonce: string; readonly leaseOwner: string; readonly leaseAttempt: number;
  readonly expectedPolicyVersion: number; readonly expectedPolicySha256: string; readonly requestSha256: string; readonly intentSha256: string;
  readonly providerConfigured: boolean; readonly sourceSha256: string; readonly profileSha256: string; readonly visualSha256: string;
  readonly briefId: string; readonly briefVersion: number; readonly sponsorUserId: string;
}
export interface RecordGenerationInput {
  readonly workspaceId: string; readonly attemptId: string; readonly nonce: string; readonly leaseOwner: string; readonly leaseAttempt: number;
  readonly candidateSha256: string; readonly width: number; readonly height: number;
}
export type IntentResult = Job | Readonly<{ kind: 'held'; reason: string; replacesIntentId?: string }>;

export interface GenerationStore {
  saveBrief(brandId: string, commandId: string, inputSha: string, briefId: string, brief: CreativeBrief): Promise<{ replayed: boolean; id: string }>;
  readBriefSource(brandId: string, briefId: string, version: number): Promise<CreativeBriefSource | null>;
  state(brandId: string, briefId?: string, generationId?: string): Promise<GenerationState>;
  initializeIntent(brandId: string, intent: CreativeImageIntent): Promise<IntentResult>;
  commitReserve(input: CreativeReserveInput): Promise<SeoImageAttemptDecision>;
  /** Records the private generated image and lets `complete` mark the job done in the same transaction. */
  recordGeneration<T>(input: RecordGenerationInput, complete: (t: DbTransaction | null, job: Job, generationId: string) => Promise<T>): Promise<Readonly<{ recorded: true; value: T }> | Readonly<{ recorded: false; hold: string }>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const id = (v: string) => { if (!UUID.test(v)) throw new SeoBlogError(400, 'Invalid identity.'); };

export class PgCreativeGenerationStore implements GenerationStore {
  private readonly sessionHash: Buffer | null;
  constructor(private readonly pool: Pick<Pool, 'connect'>, private readonly principal: PgSeoBlogPrincipal) {
    this.sessionHash = principal.kind === 'user' ? createHash('sha256').update(principal.sessionToken).digest() : null;
  }
  private context(workspaceId: string): DatabaseRequestContext {
    const p = this.principal;
    return p.kind === 'user' ? { actorKind: 'user', workspaceId, userId: p.userId, requestId: p.requestId } : { actorKind: 'worker', workspaceId, requestId: p.requestId };
  }
  private async tx<T>(workspaceId: string, run: (t: DbTransaction) => Promise<T>): Promise<T> {
    id(workspaceId);
    try {
      return await withTransaction(this.pool, this.context(workspaceId), async (t) => {
        if (this.principal.kind === 'user') {
          const guard = await t.query<{ ok: boolean }>('SELECT app_private.lock_active_portal_session($1,$2,$3) AS ok', [this.sessionHash, this.principal.userId, this.principal.selectedWorkspaceId]);
          if (guard.rows[0]?.ok !== true) throw new InactivePortalSessionError();
        }
        return run(t);
      });
    } catch (e) {
      if (e instanceof SeoBlogError || e instanceof InactivePortalSessionError) throw e;
      const code = (e as { code?: string }).code;
      if (code === '42501') throw new SeoBlogError(403, 'The current owner session or brand permission could not be confirmed.');
      if (code === '22023') throw new SeoBlogError(400, (e as Error).message.slice(0, 300));
      if (code === '23514' || code === '22P02') throw new SeoBlogError(400, 'Check the brief details and try again.');
      if (code === '40001' || code === '23505') throw new SeoBlogError(409, 'This request was already used for something else, or changed. Refresh and try again.');
      if (code === '55000') throw new SeoBlogError(409, (e as Error).message.slice(0, 300));
      throw e;
    }
  }
  private async one<T>(t: DbTransaction, sql: string, values: readonly unknown[]): Promise<T> {
    return (await t.query<{ result: T }>(sql, [...values])).rows[0]!.result;
  }
  private worker() { if (this.principal.kind !== 'worker') throw new SeoBlogError(403, 'Image generation steps run only on the content worker.'); }

  saveBrief(brandId: string, commandId: string, inputSha: string, briefId: string, brief: CreativeBrief) {
    id(commandId); id(briefId);
    return this.tx(brandId, (t) => this.one<{ replayed: boolean; id: string }>(t, 'SELECT app_private.creative_studio_save_brief($1,$2,$3) AS result',
      [brandId, this.sessionHash, JSON.stringify({ commandId, inputSha, brief: { id: briefId, ...brief } })]));
  }
  readBriefSource(brandId: string, briefId: string, version: number) {
    id(briefId); if (!Number.isInteger(version) || version < 1) throw new SeoBlogError(400, 'Invalid brief version.');
    return this.tx(brandId, (t) => this.one<CreativeBriefSource | null>(t, 'SELECT app_private.creative_studio_read_brief_source($1,$2,$3,$4) AS result', [brandId, this.sessionHash, briefId, version]));
  }
  async state(brandId: string, briefId?: string, generationId?: string): Promise<GenerationState> {
    const raw = await this.tx(brandId, (t) => this.one<GenerationState>(t, 'SELECT app_private.creative_studio_generation_state($1,$2,$3) AS result', [brandId, this.sessionHash, JSON.stringify({ ...(briefId ? { briefId } : {}), ...(generationId ? { generationId } : {}) })]));
    const iso = (v: string) => new Date(v).toISOString();
    return { ...raw, briefs: raw.briefs.map((b) => ({ ...b, createdAt: iso(b.createdAt) })), generations: raw.generations.map((g) => ({ ...g, createdAt: iso(g.createdAt) })),
      jobs: raw.jobs.map((j) => ({ ...j, createdAt: iso(j.createdAt), updatedAt: iso(j.updatedAt) })), attempts: raw.attempts.map((a) => ({ ...a, reservedMicrousd: Number(a.reservedMicrousd), createdAt: iso(a.createdAt) })),
      usage: { brandImagesThisMonth: Number(raw.usage.brandImagesThisMonth), brandUnresolvedEarlier: Number(raw.usage.brandUnresolvedEarlier ?? 0), studioImagesCounted: Number(raw.usage.studioImagesCounted),
        studioUnresolved: Number(raw.usage.studioUnresolved), period: String(raw.usage.period) } };
  }

  /** Owner-only: initialise the durable job after the SQL intent check. The same command id replays the same job. */
  async initializeIntent(brandId: string, intent: CreativeImageIntent): Promise<IntentResult> {
    if (this.principal.kind !== 'user' || intent.sponsorUserId !== this.principal.userId) throw new SeoBlogError(403, 'Only the requesting owner can start a studio image.');
    for (const v of [intent.commandId, intent.jobId, intent.intentId, intent.briefId]) id(v);
    if (intent.jobId !== intent.intentId || intent.commandId !== intent.intentId) throw new SeoBlogError(400, 'Invalid studio image intent.');
    const payload = JSON.parse(JSON.stringify(intent)) as CreativeImageIntent;
    return this.tx(brandId, async (t) => {
      await t.query('SELECT workspace_id FROM app.seo_blog_brands WHERE workspace_id=$1 FOR UPDATE', [brandId]);
      const existing = (await t.query<{ data: Omit<Job, 'rowVersion'>; row_version: string; matches: boolean }>(
        `SELECT data,row_version,(data#>'{payload,image}') @> $3::jsonb AS matches FROM app.seo_blog_jobs WHERE workspace_id=$1 AND (id=$2 OR idempotency_key='creative-image:'||$2::text)`,
        [brandId, payload.jobId, JSON.stringify(payload)])).rows[0];
      if (existing) {
        if (existing.matches !== true) throw new SeoBlogError(409, 'This image request was already used with different inputs.');
        return { ...existing.data, rowVersion: Number(existing.row_version) };
      }
      const ready = await this.one<{ kind: 'ready' | 'held' | 'existing_job'; reason?: string; job?: Job; replacesIntentId?: string }>(t,
        'SELECT app_private.creative_studio_check_image_intent($1,$2,$3) AS result', [brandId, this.sessionHash, JSON.stringify(payload)]);
      if (ready.kind === 'existing_job') return ready.job!;
      if (ready.kind === 'held') return { kind: 'held', reason: ready.reason!, ...(ready.replacesIntentId ? { replacesIntentId: ready.replacesIntentId } : {}) };
      const now = (await t.query<{ now: string }>('SELECT clock_timestamp()::text AS now')).rows[0]!.now;
      const data: Omit<Job, 'rowVersion'> = { id: payload.jobId, brandId, kind: 'write', idempotencyKey: `creative-image:${payload.intentId}`,
        payload: { stage: 'image', requestedBy: payload.sponsorUserId, image: { ...payload, sourceSnapshot: payload.source.snapshot, schema: CREATIVE_IMAGE_SCHEMA,
          sourceSnapshotVersion: CREATIVE_BRIEF_RECIPE, automatic: false } },
        state: 'queued', attempts: 0, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, runAfter: now,
        progress: 'Studio image request queued; the paid request has not started.', error: null, createdAt: now, updatedAt: now };
      const row = (await t.query<{ data: Omit<Job, 'rowVersion'>; row_version: string }>(
        `INSERT INTO app.seo_blog_jobs(workspace_id,id,kind,idempotency_key,state,run_after,data) VALUES($1,$2,'write',$3,'queued',$4,$5) RETURNING data,row_version`,
        [brandId, payload.jobId, data.idempotencyKey, now, JSON.stringify(data)])).rows[0]!;
      return { ...row.data, rowVersion: Number(row.row_version) };
    });
  }

  /** Worker-only. Admission is acknowledged only after COMMIT, so a provider call can never precede its reservation. */
  async commitReserve(input: CreativeReserveInput): Promise<SeoImageAttemptDecision> {
    this.worker();
    for (const v of [input.workspaceId, input.jobId, input.intentId, input.nonce, input.briefId, input.sponsorUserId]) id(v);
    const snapshot = { ...input, sourceSnapshotVersion: CREATIVE_BRIEF_RECIPE };
    return this.tx(input.workspaceId, async (t) => {
      await t.query('SELECT workspace_id FROM app.seo_blog_brands WHERE workspace_id=$1 FOR UPDATE', [input.workspaceId]);
      await t.query('SELECT id FROM app.seo_blog_jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [input.workspaceId, input.jobId]);
      const decision = await this.one<SeoImageAttemptDecision>(t, 'SELECT app_private.seo_image_reserve($1,$2) AS result', [input.workspaceId, JSON.stringify(snapshot)]);
      if (decision.kind === 'admitted') {
        // Identical to the article path: the start projection and exactly one usage debit, checked by the deferred admission guard.
        await t.query(`UPDATE app.seo_blog_jobs SET data=jsonb_set(data,'{payload,image,start}',jsonb_build_object('nonce',$3::text,'attemptId',$4::text,'at',clock_timestamp(),
          'leaseOwner',$5::text,'leaseAttempt',$6::integer)),row_version=row_version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
          [input.workspaceId, input.jobId, decision.nonce, decision.attemptId, input.leaseOwner, input.leaseAttempt]);
        await t.query(`INSERT INTO app.seo_blog_usage(workspace_id,kind,amount,at,reference) VALUES($1,'images',1,clock_timestamp(),$2)`, [input.workspaceId, `seo-image-start:${decision.attemptId}`]);
      }
      return decision;
    });
  }

  async recordGeneration<T>(input: RecordGenerationInput, complete: (t: DbTransaction | null, job: Job, generationId: string) => Promise<T>) {
    this.worker(); id(input.attemptId); id(input.nonce);
    return this.tx(input.workspaceId, async (t) => {
      await t.query('SELECT workspace_id FROM app.seo_blog_brands WHERE workspace_id=$1 FOR UPDATE', [input.workspaceId]);
      const row = (await t.query<{ data: Omit<Job, 'rowVersion'>; row_version: string }>(`SELECT data,row_version FROM app.seo_blog_jobs
        WHERE workspace_id=$1 AND id=app_private.seo_image_attempt_job($1,$2) FOR UPDATE`, [input.workspaceId, input.attemptId])).rows[0];
      if (!row) return { recorded: false as const, hold: 'claim_changed' };
      const result = await this.one<{ recorded: boolean; hold?: string; id?: string }>(t, 'SELECT app_private.creative_studio_record_generation($1,$2) AS result', [input.workspaceId, JSON.stringify(input)]);
      if (!result.recorded) return { recorded: false as const, hold: result.hold ?? 'candidate_unverified' };
      return { recorded: true as const, value: await complete(t, { ...row.data, rowVersion: Number(row.row_version) }, result.id!) };
    });
  }
}
