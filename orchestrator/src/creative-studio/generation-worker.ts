/**
 * Worker coordinator for one claimed studio image job. Safety order, as for article images:
 *   1. load any reference images (before any reservation),
 *   2. admission is acknowledged only after COMMIT (reservation + start projection + single usage debit),
 *   3. exactly one provider call, only after a fresh admission,
 *   4. the receipt (and any bytes) is persisted, retried once with the same envelope, never with a new call,
 *   5. the stored pixels are decoded and recorded as a private generated image with the job marked done atomically.
 * An existing started attempt (unknown outcome) is held for reconciliation and never re-sent.
 */
import { randomUUID } from 'node:crypto';
import type { DbTransaction } from '../db/transaction.js';
import type { ImageGenerationCommand, ImageGenerationOptions, ImageGenerationReceipt, ImageReference } from '../seo-blog/image-generation.js';
import type { SeoImageAttemptReceiptInput, SeoImageReceiptResult, SeoMediaPrivateBytes } from '../seo-blog/media-types.js';
import type { SeoBlogStore } from '../seo-blog/store.js';
import { SeoBlogError, type Job } from '../seo-blog/types.js';
import { decodeCreativeImageJob, holdMessage, type CreativeImageIntent } from './generation.js';
import type { GenerationStore } from './generation-store.js';
import { verifyCreativeImage } from './image-input.js';

export interface CreativeImageWorkerDeps {
  readonly store: Pick<SeoBlogStore, 'getJob' | 'updateJob'>;
  readonly generation: Pick<GenerationStore, 'commitReserve' | 'recordGeneration'>;
  readonly media: { commitImageAttemptReceipt(input: SeoImageAttemptReceiptInput): Promise<SeoImageReceiptResult>; loadPrivateAsset(workspaceId: string, assetId: string, sha256: string): Promise<SeoMediaPrivateBytes> };
  readonly providerConfigured: boolean;
  generate(command: ImageGenerationCommand, options: ImageGenerationOptions, signal?: AbortSignal): Promise<ImageGenerationReceipt>;
  readonly now: () => string;
  readonly nonce?: () => string;
  /** Completes the job row inside the record transaction (PostgreSQL); tests may pass a store-based completion. */
  completeInTransaction?(t: DbTransaction | null, job: Job, patch: Partial<Job>): Promise<Job>;
}

/** Pre-admission holds that cannot have charged anything may wait and retry; everything else stops. */
const TRANSIENT = new Set(['global_concurrency']);
const sameClaim = (current: Job, claim: Job) => current.state === 'running' && current.leaseOwner === claim.leaseOwner && current.attempts === claim.attempts;

export async function runCreativeImageJob(claim: Job, deps: CreativeImageWorkerDeps): Promise<Job> {
  const current = await deps.store.getJob(claim.brandId, claim.id);
  if (!current || !sameClaim(current, claim)) return current ?? claim;
  let transportCalls = 0;
  const finish = async (code: string, extra: Record<string, unknown> = {}, retry = false): Promise<Job> => {
    const latest = await deps.store.getJob(claim.brandId, claim.id);
    if (!latest || !sameClaim(latest, claim)) return latest ?? claim;
    const again = retry && latest.attempts < latest.maxAttempts && transportCalls === 0;
    const image = latest.payload.image as Record<string, unknown>;
    const message = holdMessage(code);
    return deps.store.updateJob({ ...latest, state: again ? 'queued' : 'blocked', leaseOwner: null, leaseExpiresAt: null,
      runAfter: again ? new Date(Date.parse(deps.now()) + 5 * 60_000).toISOString() : latest.runAfter,
      payload: { ...latest.payload, image: { ...image, result: { state: 'held', code, transportCalls, ...extra } } },
      progress: message, error: again ? null : message, updatedAt: deps.now() });
  };

  let intent: CreativeImageIntent;
  try { intent = decodeCreativeImageJob(current); } catch { return finish('claim_or_intent_changed'); }
  const ws = claim.brandId;

  // 1. Reference images first: an unavailable reference means no reservation and no charge.
  const references: ImageReference[] = [];
  try {
    for (const r of intent.references) {
      const loaded = await deps.media.loadPrivateAsset(ws, r.assetId, r.sha256);
      references.push({ sha256: r.sha256, mimeType: 'image/jpeg', bytes: Buffer.from(loaded.bytes) });
    }
  } catch { return finish('source_changed'); }

  // 2. Admission, acknowledged only after COMMIT.
  let decision: Awaited<ReturnType<CreativeImageWorkerDeps['generation']['commitReserve']>>;
  try {
    decision = await deps.generation.commitReserve({ workspaceId: ws, jobId: claim.id, intentId: intent.intentId, nonce: (deps.nonce ?? randomUUID)(),
      leaseOwner: claim.leaseOwner!, leaseAttempt: claim.attempts, expectedPolicyVersion: intent.expectedPolicyVersion, expectedPolicySha256: intent.expectedPolicySha256,
      requestSha256: intent.requestSha256, intentSha256: intent.intentSha256, providerConfigured: deps.providerConfigured,
      sourceSha256: intent.sourceSha256, profileSha256: intent.profileSha256, visualSha256: intent.visualSha256,
      briefId: intent.briefId, briefVersion: intent.briefVersion, sponsorUserId: intent.sponsorUserId });
  } catch {
    // Unknown commit: a retry re-enters admission, which reports an existing attempt instead of starting another.
    return finish('claim_or_intent_changed', { admission: 'unconfirmed' }, true);
  }
  if (decision.kind === 'held') return finish(decision.reason, {}, TRANSIENT.has(decision.reason));
  if (decision.kind === 'existing_started') return finish('outcome_unknown', { attemptId: decision.attemptId });

  let candidate: { id: string; sha256: string } | null = null;
  const attemptId = decision.attemptId, nonce = decision.nonce;
  if (decision.kind === 'existing_receipt') {
    const outcome = String(decision.receipt.outcome);
    if (outcome !== 'candidate_received' || !decision.candidate) return finish(outcome === 'rejected' ? 'provider_rejected' : 'outcome_unknown', { attemptId });
    candidate = { id: decision.candidate.id, sha256: decision.candidate.sha256 };
  } else {
    // 3. Exactly one provider call for this admission.
    transportCalls = 1;
    const receipt = await deps.generate(intent.privateCommand, { size: intent.size, references, classifyRefusal: true });
    const envelope: SeoImageAttemptReceiptInput = { workspaceId: ws, attemptId, nonce, requestSha256: intent.requestSha256, leaseOwner: claim.leaseOwner!, leaseAttempt: claim.attempts,
      receipt: { outcome: receipt.outcome, code: receipt.code, requestSha256: receipt.requestSha256, providerRequestIdSha256: receipt.providerRequestIdSha256, httpStatus: receipt.httpStatus, usage: receipt.usage },
      observedCandidateSha256: receipt.candidate?.sha256 ?? null,
      ...(receipt.candidate ? { candidate: { bytes: receipt.candidate.bytes, provenance: { kind: 'generated' as const, brandSha256: intent.profileSha256,
        sourceName: `Creative Studio brief ${intent.briefId.slice(0, 8)} version ${intent.briefVersion}`, generation: { intentId: intent.intentId, nonce, requestSha256: intent.requestSha256 } } } } : {}) };
    // 4. Persist the receipt; one retry with the same envelope, never another provider call.
    let saved: SeoImageReceiptResult;
    try { saved = await deps.media.commitImageAttemptReceipt(envelope); }
    catch { try { saved = await deps.media.commitImageAttemptReceipt(envelope); } catch { return finish('receipt_unpersisted', { attemptId }); } }
    if (receipt.outcome !== 'candidate_received' || !saved.candidate) {
      const code = receipt.refusal === 'moderation_blocked' ? 'moderation_blocked' : receipt.outcome === 'rejected' ? 'provider_rejected' : 'outcome_unknown';
      return finish(code, { attemptId, receipt: { outcome: receipt.outcome, code: receipt.code, httpStatus: receipt.httpStatus } });
    }
    candidate = { id: saved.candidate.id, sha256: saved.candidate.sha256 };
  }

  // 5. Decode the stored pixels, then record and complete atomically. Nothing is approved.
  let width: number, height: number;
  try {
    const stored = await deps.media.loadPrivateAsset(ws, candidate.id, candidate.sha256);
    const verified = verifyCreativeImage(Buffer.from(stored.bytes));
    width = verified.width; height = verified.height;
  } catch { return finish('candidate_unverified', { attemptId }); }
  const [w, h] = intent.size.split('x').map(Number);
  const sizeMatches = width === w && height === h;
  const recorded = await deps.generation.recordGeneration({ workspaceId: ws, attemptId, nonce, leaseOwner: claim.leaseOwner!, leaseAttempt: claim.attempts,
    candidateSha256: candidate.sha256, width, height }, async (t, job, generationId) => {
    const image = job.payload.image as Record<string, unknown>;
    const progress = sizeMatches ? 'New image generated and saved privately. Review it and create artwork from it.' : `New image saved privately at ${width}×${height} (requested ${intent.size}). Review it before use.`;
    const patch: Partial<Job> = { state: 'done', leaseOwner: null, leaseExpiresAt: null, progress, error: null, updatedAt: deps.now(),
      payload: { ...job.payload, image: { ...image, result: { state: 'generated', generationId, attemptId, transportCalls, sizeMatches, width, height } } } };
    if (deps.completeInTransaction) return deps.completeInTransaction(t, job, patch);
    return deps.store.updateJob({ ...job, ...patch });
  });
  if (!recorded.recorded) return finish(recorded.hold, { attemptId });
  return recorded.value;
}

/** PostgreSQL completion inside the record transaction, with the same optimistic row-version check as the store. */
export async function completeJobInTransaction(t: DbTransaction | null, job: Job, patch: Partial<Job>): Promise<Job> {
  if (!t) throw new SeoBlogError(503, 'Job completion requires its record transaction.');
  const next = { ...job, ...patch }, { rowVersion, ...data } = next;
  const row = (await t.query<{ data: Omit<Job, 'rowVersion'>; row_version: string }>(`UPDATE app.seo_blog_jobs SET data=$3,state=$4,run_after=$5,lease_expires_at=$6,
    row_version=row_version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND row_version=$7 RETURNING data,row_version`,
    [job.brandId, job.id, JSON.stringify(data), next.state, next.runAfter, next.leaseExpiresAt, rowVersion])).rows[0];
  if (!row) throw new SeoBlogError(409, 'The image task changed while its result was being saved.');
  return { ...row.data, rowVersion: Number(row.row_version) };
}
