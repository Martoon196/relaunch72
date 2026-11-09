/** Durable image-job orchestration. Boundaries own SQL authority; this module owns effect ordering. */
import { createHash, randomUUID } from 'node:crypto';
import { prepareImageGenerationRequest, type ImageGenerationCommand, type ImageGenerationReceipt, type PreparedImageGenerationRequest } from './image-generation.js';
import { JpegPreparationError, JPEG_VARIANT_PROFILES, prepareJpegVariants, type JpegVariantProfile } from './jpeg-preparation.js';

export const IMAGE_JOB_SCHEMA = 'relaunch72.seo-image-intent/v1' as const;
export const IMAGE_SOURCE_SNAPSHOT_VERSION = 'seo-image-source-v1' as const;
export type ImageJobHoldCode = 'not_ready' | 'invalid_job' | 'wire_mismatch' | 'admission_unknown' | 'outcome_unknown'
  | 'provider_unconfigured' | 'provider_rejected' | 'receipt_unconfirmed' | 'source_changed' | 'paused'
  | 'sponsor_revoked' | 'policy_changed' | 'policy_disabled' | 'budget_exceeded' | 'concurrency_exhausted'
  | 'candidate_integrity' | 'candidate_read_unavailable' | 'preparation_failed' | 'wrong_dimensions'
  | 'preparation_storage_unavailable' | 'apply_unavailable';
const HOLD_CODES = new Set<ImageJobHoldCode>(['not_ready','invalid_job','wire_mismatch','admission_unknown','outcome_unknown',
  'provider_unconfigured','provider_rejected','receipt_unconfirmed','source_changed','paused','sponsor_revoked','policy_changed',
  'policy_disabled','budget_exceeded','concurrency_exhausted','candidate_integrity','candidate_read_unavailable',
  'preparation_failed','wrong_dimensions','preparation_storage_unavailable','apply_unavailable']);
export interface ImageJobClaim {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly intentId: string;
  readonly intentSha256: string;
  readonly requestSha256: string;
  readonly sourceSha256: string;
  readonly profileSha256: string;
  readonly visualSha256: string;
  readonly sourceSnapshotVersion: typeof IMAGE_SOURCE_SNAPSHOT_VERSION;
  readonly articleId: string;
  readonly articleVersionId: string;
  readonly articleContentSha256: string;
  readonly sponsorUserId: string;
  readonly expectedPolicyVersion: number;
  readonly expectedPolicySha256: string;
  readonly leaseOwner: string;
  readonly leaseAttempt: number;
  /** Private immutable snapshot, intentionally omitted from ordinary metadata JSON. */
  readonly sourceSnapshot: Readonly<Record<string, unknown>>;
}
export interface ImageAttemptRef {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly intentId: string;
  readonly attemptId: string;
  readonly nonce: string;
  readonly reservedRequestSha256: string;
}
export interface CommittedImageReceipt {
  readonly commitAcknowledged: true;
  readonly attemptId: string;
  readonly nonce: string;
  readonly reservedRequestSha256: string;
  readonly receivedRequestSha256: string;
  readonly outcome: ImageGenerationReceipt['outcome'];
  readonly candidate: Readonly<{ assetId: string; sha256: string }> | null;
  readonly applyEligible: boolean;
  readonly holdCode?: ImageJobHoldCode;
}
export type CommittedImageAdmission =
  | Readonly<{ kind: 'admitted'; commitAcknowledged: true; attemptId: string; nonce: string }>
  | Readonly<{ kind: 'existing_started'; attemptId: string; nonce: string }>
  | Readonly<{ kind: 'existing_receipt'; attemptId: string; nonce: string; receipt: CommittedImageReceipt }>
  | Readonly<{ kind: 'held'; reason: ImageJobHoldCode }>;
export interface ImageReceiptEnvelope {
  readonly reservedRequestSha256: string;
  readonly wireIntegrity: 'matched' | 'mismatch';
  readonly receipt: ImageGenerationReceipt;
  /** On mismatch retain this safe evidence, without attaching possibly misrouted bytes. */
  readonly observedCandidateSha256: string | null;
}
export interface CommittedImagePreparation {
  readonly commitAcknowledged: true;
  readonly candidateAssetId: string;
  readonly sourceSha256: string;
  readonly variants: readonly Readonly<{ assetId: string; sha256: string; profile: JpegVariantProfile }>[];
}
export interface ImageJobDependencies {
  readonly providerConfigured: boolean;
  readonly signal?: AbortSignal;
  /** Owns the transaction and returns admitted ONLY after a successful COMMIT acknowledgement. */
  admitCommitted(claim: ImageJobClaim, request: Readonly<{ nonce: string; requestSha256: string; providerConfigured: boolean; model: 'gpt-image-2'; quality: 'medium' }>): Promise<CommittedImageAdmission>;
  generate(command: ImageGenerationCommand, signal?: AbortSignal): Promise<ImageGenerationReceipt>;
  /** SAME-client attempt receipt + raw candidate + accounting transaction; no decode here. */
  persistReceiptCommitted(claim: ImageJobClaim, attempt: ImageAttemptRef, envelope: ImageReceiptEnvelope): Promise<CommittedImageReceipt>;
  loadCandidate(claim: ImageJobClaim, assetId: string, expectedSha256: string): Promise<Uint8Array>;
  prepare?: typeof prepareJpegVariants;
  commitPreparation(claim: ImageJobClaim, attempt: ImageAttemptRef, receipt: CommittedImageReceipt, value: ReturnType<typeof prepareJpegVariants>): Promise<CommittedImagePreparation>;
  recordPreparationFailure(claim: ImageJobClaim, attempt: ImageAttemptRef, receipt: CommittedImageReceipt, failure: Readonly<{ code: ImageJobHoldCode; retryable: boolean }>): Promise<void>;
  /** Fresh claim/source/sponsor/pause checks; attaches PRIVATE proposals only. No approval/public release. */
  applyPreparedCommitted(claim: ImageJobClaim, attempt: ImageAttemptRef, value: CommittedImagePreparation): Promise<Readonly<{ applied: boolean; holdCode?: ImageJobHoldCode }>>;
}
export interface ImageJobResult {
  readonly state: 'prepared' | 'held' | 'retry_local';
  readonly code: 'prepared' | ImageJobHoldCode;
  readonly transportInvocations: 0 | 1;
  readonly receiptPersisted: boolean;
  readonly candidateAssetId: string | null;
  readonly variantAssetIds: readonly string[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA = /^[0-9a-f]{64}$/u;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const safeHold = (v: unknown, fallback: ImageJobHoldCode = 'not_ready') => typeof v === 'string' && HOLD_CODES.has(v as ImageJobHoldCode) ? v as ImageJobHoldCode : fallback;
function freezeJson(value: unknown, depth = 0): unknown {
  if (depth > 20) throw new Error('Invalid image snapshot.');
  if (Array.isArray(value)) return Object.freeze(value.map((item) => freezeJson(item, depth + 1)));
  if (record(value)) return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeJson(item, depth + 1)])));
  return value;
}
function decode(raw: unknown): { claim: ImageJobClaim; prepared: PreparedImageGenerationRequest } {
  if (!record(raw) || raw.kind !== 'write' || raw.state !== 'running' || !record(raw.payload) || raw.payload.stage !== 'image' || !record(raw.payload.image)) throw new Error('Invalid image task.');
  const image = raw.payload.image;
  if (image.schema !== IMAGE_JOB_SCHEMA || image.sourceSnapshotVersion !== IMAGE_SOURCE_SNAPSHOT_VERSION || image.model !== 'gpt-image-2' || image.quality !== 'medium'
      || !record(image.privateCommand) || !record(image.sourceSnapshot) || typeof raw.leaseOwner !== 'string' || raw.leaseOwner.length < 1 || raw.leaseOwner.length > 200
      || !Number.isSafeInteger(raw.attempts) || Number(raw.attempts) < 1 || !Number.isSafeInteger(image.expectedPolicyVersion) || Number(image.expectedPolicyVersion) < 1) throw new Error('Invalid image task.');
  for (const value of [raw.id, raw.brandId, image.intentId, image.articleId, image.articleVersionId, image.sponsorUserId]) if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid identity.');
  for (const value of [image.intentSha256, image.requestSha256, image.sourceSha256, image.profileSha256, image.visualSha256, image.articleContentSha256, image.expectedPolicySha256]) if (typeof value !== 'string' || !SHA.test(value)) throw new Error('Invalid digest.');
  const privateCommand = image.privateCommand;
  if (privateCommand.brandId !== raw.brandId || privateCommand.actorId !== image.sponsorUserId || typeof privateCommand.prompt !== 'string') throw new Error('Invalid image command.');
  const prepared = prepareImageGenerationRequest({ brandId: String(raw.brandId), actorId: String(image.sponsorUserId), prompt: privateCommand.prompt });
  const serialized = JSON.stringify(image.sourceSnapshot);
  if (Buffer.byteLength(serialized) > 1_000_000) throw new Error('Image source snapshot is too large.');
  const snapshot = freezeJson(JSON.parse(serialized)) as Readonly<Record<string, unknown>>;
  const metadata = {
    workspaceId: String(raw.brandId), jobId: String(raw.id), intentId: String(image.intentId), intentSha256: String(image.intentSha256), requestSha256: String(image.requestSha256),
    sourceSha256: String(image.sourceSha256), profileSha256: String(image.profileSha256), visualSha256: String(image.visualSha256), sourceSnapshotVersion: IMAGE_SOURCE_SNAPSHOT_VERSION,
    articleId: String(image.articleId), articleVersionId: String(image.articleVersionId), articleContentSha256: String(image.articleContentSha256), sponsorUserId: String(image.sponsorUserId),
    expectedPolicyVersion: Number(image.expectedPolicyVersion), expectedPolicySha256: String(image.expectedPolicySha256), leaseOwner: raw.leaseOwner, leaseAttempt: Number(raw.attempts),
  };
  Object.defineProperty(metadata, 'sourceSnapshot', { enumerable: false, get: () => snapshot });
  return { claim: Object.freeze(metadata) as ImageJobClaim, prepared };
}
function receiptValid(stored: CommittedImageReceipt, attempt: ImageAttemptRef): boolean {
  return stored.commitAcknowledged === true && stored.attemptId === attempt.attemptId && stored.nonce === attempt.nonce
    && stored.reservedRequestSha256 === attempt.reservedRequestSha256 && SHA.test(stored.receivedRequestSha256)
    && ['not_started','candidate_received','rejected','outcome_unknown'].includes(stored.outcome)
    && (stored.candidate === null || (UUID.test(stored.candidate.assetId) && SHA.test(stored.candidate.sha256)));
}

/** One committed start may invoke transport once; every recovery path uses stored receipts/bytes. */
export async function runImageJob(raw: unknown, deps: ImageJobDependencies): Promise<ImageJobResult> {
  let calls: 0 | 1 = 0, receiptPersisted = false;
  let candidateAssetId: string | null = null;
  const result = (state: ImageJobResult['state'], code: ImageJobResult['code'], ids: readonly string[] = []): ImageJobResult =>
    Object.freeze({ state, code, transportInvocations: calls, receiptPersisted, candidateAssetId, variantAssetIds: Object.freeze([...ids]) });
  let claim: ImageJobClaim, prepared: PreparedImageGenerationRequest;
  try { ({ claim, prepared } = decode(raw)); } catch { return result('held', 'invalid_job'); }
  if (claim.requestSha256 !== prepared.requestSha256) return result('held', 'wire_mismatch');
  const proposedNonce = randomUUID(); let admission: CommittedImageAdmission;
  try { admission = await deps.admitCommitted(claim, { nonce: proposedNonce, requestSha256: prepared.requestSha256,
    providerConfigured: deps.providerConfigured && !deps.signal?.aborted, model: 'gpt-image-2', quality: 'medium' }); }
  catch { return result('held', 'admission_unknown'); }
  if (admission.kind === 'held') return result('held', safeHold(admission.reason));
  if (!UUID.test(admission.attemptId) || !UUID.test(admission.nonce)) return result('held', 'admission_unknown');
  const attempt: ImageAttemptRef = Object.freeze({ workspaceId: claim.workspaceId, jobId: claim.jobId, intentId: claim.intentId,
    attemptId: admission.attemptId, nonce: admission.nonce, reservedRequestSha256: prepared.requestSha256 });
  if (admission.kind === 'existing_started') return result('held', 'outcome_unknown');
  let stored: CommittedImageReceipt;
  if (admission.kind === 'existing_receipt') stored = admission.receipt;
  else {
    if (admission.kind !== 'admitted' || admission.commitAcknowledged !== true || admission.nonce !== proposedNonce) return result('held', 'admission_unknown');
    let received: ImageGenerationReceipt;
    if (!deps.providerConfigured || deps.signal?.aborted) received = Object.freeze({ outcome: 'not_started', code: 'aborted', requestSha256: prepared.requestSha256, providerRequestIdSha256: null, httpStatus: null, candidate: null, usage: null });
    else {
      calls = 1;
      try { received = await deps.generate(prepared.command, deps.signal); }
      catch { received = Object.freeze({ outcome: 'outcome_unknown', code: 'transport_interrupted', requestSha256: prepared.requestSha256, providerRequestIdSha256: null, httpStatus: null, candidate: null, usage: null }); }
    }
    const matched = received.requestSha256 === prepared.requestSha256;
    const observedCandidateSha256 = received.candidate?.sha256 ?? null;
    const envelope: ImageReceiptEnvelope = Object.freeze({ reservedRequestSha256: prepared.requestSha256, wireIntegrity: matched ? 'matched' : 'mismatch', observedCandidateSha256,
      receipt: matched ? received : Object.freeze({ ...received, outcome: 'outcome_unknown', code: 'invalid_response', candidate: null }) });
    try { stored = await deps.persistReceiptCommitted(claim, attempt, envelope); }
    catch {
      // Reuse the same bytes/receipt after a lost acknowledgement. Never repeat transport.
      try { stored = await deps.persistReceiptCommitted(claim, attempt, envelope); }
      catch { return result('held', 'receipt_unconfirmed'); }
    }
    if (!matched) { receiptPersisted = receiptValid(stored, attempt); return result('held', 'wire_mismatch'); }
  }
  if (!receiptValid(stored, attempt)) return result('held', 'receipt_unconfirmed');
  receiptPersisted = true; candidateAssetId = stored.candidate?.assetId ?? null;
  if (stored.receivedRequestSha256 !== prepared.requestSha256) return result('held', 'wire_mismatch');
  if (stored.outcome !== 'candidate_received' || !stored.candidate) return result('held', stored.outcome === 'rejected' ? 'provider_rejected' : 'outcome_unknown');
  if (!stored.applyEligible) return result('held', safeHold(stored.holdCode, 'source_changed'));
  let source: Uint8Array;
  try { source = await deps.loadCandidate(claim, stored.candidate.assetId, stored.candidate.sha256); }
  catch { return result('retry_local', 'candidate_read_unavailable'); }
  if (!(source instanceof Uint8Array) || !source.byteLength || source.byteLength > 8 * 1024 * 1024
      || createHash('sha256').update(source).digest('hex') !== stored.candidate.sha256) return result('held', 'candidate_integrity');
  let value: ReturnType<typeof prepareJpegVariants>;
  try {
    value = (deps.prepare ?? prepareJpegVariants)(source);
  } catch (error) {
    const retryable = !(error instanceof JpegPreparationError);
    try { await deps.recordPreparationFailure(claim, attempt, stored, { code: 'preparation_failed', retryable }); }
    catch { return result('retry_local', 'preparation_storage_unavailable'); }
    return result(retryable ? 'retry_local' : 'held', 'preparation_failed');
  }
  if (value.original.sha256 !== stored.candidate.sha256 || value.original.width !== 1536 || value.original.height !== 1024) {
    try { await deps.recordPreparationFailure(claim, attempt, stored, { code: 'wrong_dimensions', retryable: false }); }
    catch { return result('retry_local', 'preparation_storage_unavailable'); }
    return result('held', 'wrong_dimensions');
  }
  const profiles = value.variants.map((variant) => variant.recipe?.profile);
  if (value.variants.length !== 3 || new Set(profiles).size !== 3 || profiles.some((profile) => !profile || !Object.hasOwn(JPEG_VARIANT_PROFILES, profile))) return result('held', 'candidate_integrity');
  let committed: CommittedImagePreparation;
  try { committed = await deps.commitPreparation(claim, attempt, stored, value); }
  catch { return result('retry_local', 'preparation_storage_unavailable'); }
  if (committed.commitAcknowledged !== true || committed.candidateAssetId !== stored.candidate.assetId || committed.sourceSha256 !== stored.candidate.sha256
      || committed.variants.length !== 3 || new Set(committed.variants.map((variant) => variant.profile)).size !== 3
      || committed.variants.some((variant) => !UUID.test(variant.assetId) || !SHA.test(variant.sha256)
        || !value.variants.some((preparedVariant) => preparedVariant.recipe?.profile === variant.profile && preparedVariant.sha256 === variant.sha256))) return result('held', 'candidate_integrity');
  try {
    const applied = await deps.applyPreparedCommitted(claim, attempt, committed);
    return applied.applied ? result('prepared', 'prepared', committed.variants.map((variant) => variant.assetId)) : result('held', safeHold(applied.holdCode, 'source_changed'));
  } catch { return result('retry_local', 'apply_unavailable'); }
}
