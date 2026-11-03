/** Persist truthful coordinator outcomes without passing image jobs through generic article completion. */
import { runImageJob, type ImageJobDependencies, type ImageJobResult } from './image-jobs.js';
import type { SeoBlogStore } from './store.js';
import type { Job } from './types.js';
import { isImageJob } from './image-campaign.js';

export function imageResultMessage(result: ImageJobResult): string {
  switch (result.code) {
    case 'prepared': return 'Image crops are ready for private review. Nothing has been approved or released.';
    case 'provider_unconfigured': return 'Image generation is not configured. No provider call was made.';
    case 'policy_disabled': return 'Image generation is switched off by the operator. Existing image allowances are unchanged.';
    case 'policy_changed': return 'Image policy changed. Review a new intent before generation.';
    case 'budget_exceeded': return 'The current image-attempt allowance or operator reservation is unavailable. Review image settings.';
    case 'concurrency_exhausted': return 'The image service is busy. No new call was started for this attempt.';
    case 'source_changed': return 'The article or guidance changed. The saved result is retained privately; it cannot replace the current campaign.';
    case 'paused': return 'The programme is paused. No image will be applied while it is paused.';
    case 'sponsor_revoked': return 'The person who authorised this intent is no longer eligible. A current owner must review a new intent.';
    case 'outcome_unknown': return 'The image request has an uncertain outcome. It will not be repeated automatically.';
    case 'admission_unknown': return 'Image admission could not be confirmed. No new image request will be sent automatically.';
    case 'receipt_unconfirmed': return 'The result could not be confirmed as saved. Recovery will check retained evidence without another image call.';
    case 'provider_rejected': return 'The image provider did not return an accepted candidate. Review the intent before requesting a new generation.';
    case 'wire_mismatch': return 'The received image does not match this intent. It has not been applied.';
    case 'wrong_dimensions': return 'The saved candidate has unsupported dimensions. No replacement generation has been requested.';
    case 'candidate_integrity': return 'The saved candidate failed its integrity check. It has not been used.';
    case 'invalid_job': return 'This image task is not supported by the current worker. It has not been treated as article writing.';
    case 'not_ready': return 'Image preparation needs attention in campaign settings.';
    default: return 'The saved image needs local preparation or storage recovery. Retrying preparation will not generate another image.';
  }
}
function sameClaim(current: Job, claim: Job): boolean {
  return current.state === 'running' && current.leaseOwner === claim.leaseOwner && current.attempts === claim.attempts;
}

export async function runStoredImageJob(claim: Job, input: {
  readonly store: Pick<SeoBlogStore, 'getJob' | 'updateJob'>;
  readonly dependencies: ImageJobDependencies;
  readonly now: () => string;
  /** Safe DB-receipted candidate pointer, never raw provider bytes/prompt. */
  candidate?(): Readonly<{ assetId: string; sha256: string }> | null;
}): Promise<Job> {
  const current = await input.store.getJob(claim.brandId, claim.id);
  if (!current || !sameClaim(current, claim) || !isImageJob(current)) return current ?? claim;
  let result = await runImageJob(claim, input.dependencies);
  const latest = await input.store.getJob(claim.brandId, claim.id);
  if (!latest || !sameClaim(latest, claim)) return latest ?? claim; // atomic apply/cancel/reclaim already owns its outcome
  // A true application must commit the proposal AND job outcome. A returned
  // boolean without that durable outcome is not proof of completed preparation.
  if (result.state === 'prepared') result = { ...result, state: 'held', code: 'apply_unavailable' };
  const localRetry = result.state === 'retry_local' && latest.attempts < latest.maxAttempts;
  const progress = imageResultMessage(result);
  const image = latest.payload.image;
  const safeImage = image && typeof image === 'object' && !Array.isArray(image) ? image as Record<string, unknown> : {};
  const candidate = input.candidate?.();
  return input.store.updateJob({ ...latest,
    state: localRetry ? 'queued' : 'blocked',
    leaseOwner: null, leaseExpiresAt: null,
    runAfter: localRetry ? new Date(Date.parse(input.now()) + 60_000).toISOString() : latest.runAfter,
    payload: { ...latest.payload, image: { ...safeImage, ...(candidate ? { candidate } : {}), result } },
    progress, error: progress, updatedAt: input.now(),
  });
}

/** Safe native status projection: no private prompt, source documents, credentials or image bytes. */
export function imageJobStatus(job: Job): Readonly<Record<string, unknown>> {
  const image = job.payload.image && typeof job.payload.image === 'object' && !Array.isArray(job.payload.image) ? job.payload.image as Record<string, unknown> : {};
  const result = image.result && typeof image.result === 'object' && !Array.isArray(image.result) ? image.result as Record<string, unknown> : null;
  return Object.freeze({ id: job.id, state: job.state, progress: job.progress, error: job.error, updatedAt: job.updatedAt,
    articleId: typeof image.articleId === 'string' ? image.articleId : null,
    articleVersionId: typeof image.articleVersionId === 'string' ? image.articleVersionId : null,
    receiptPersisted: result?.receiptPersisted === true, preparationReady: result?.state === 'prepared' });
}
