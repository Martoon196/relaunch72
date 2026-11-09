/** Engine-facing image capabilities. SQL owns admission; these are never approval flags. */
import { createHash } from 'node:crypto';
import type { Job } from './types.js';

export const IMAGE_PROPOSAL_SCHEMA = 'relaunch72.seo-campaign-media/v1' as const;
export interface ArticleImageVariant {
  readonly assetId: string;
  readonly sha256: string;
  readonly profile: 'blog' | 'instagram' | 'linkedin';
  readonly width: number;
  readonly height: number;
}
export interface ArticleImageProposal {
  readonly schema: typeof IMAGE_PROPOSAL_SCHEMA;
  readonly intentId: string;
  readonly attemptId: string;
  readonly articleVersionId: string;
  readonly articleContentSha256: string;
  readonly sourceSha256: string;
  readonly candidateAssetId: string;
  readonly candidateSha256: string;
  readonly variants: readonly ArticleImageVariant[];
  readonly preparedAt: string;
}
/** Owner-selected local crop of durable bytes; never a new paid generation attempt. */
export interface ArticleLocalImageProposal {
  readonly commandId: string;
  readonly articleVersionId: string;
  readonly candidateAssetId: string;
  readonly candidateSha256: string;
  readonly focal: { readonly x: number; readonly y: number };
  readonly variants: readonly ArticleImageVariant[];
  readonly preparedAt: string;
}
export interface ArticleImageRequest {
  readonly brandId: string;
  readonly articleId: string;
  readonly expectedVersionId: string;
  readonly commandId: string;
  readonly origin: 'owner' | 'programme';
  /** Actual server-resolved requester or current confirmed programme sponsor, never a posted owner ID. */
  readonly sponsorUserId: string;
  /** Explicit distinct paid intent; never clears an earlier uncertain start or its reservation. */
  readonly confirmedNewIntent: boolean;
  readonly replacesIntentId?: string | null;
}
export type ArticleImageRequestResult =
  | { readonly kind: 'job'; readonly job: Job }
  | { readonly kind: 'held'; readonly code: string; readonly detail: string; readonly replacesIntentId?: string };
export interface ArticleImageService {
  readonly configured: boolean;
  request(input: ArticleImageRequest): Promise<ArticleImageRequestResult>;
  /** Owns committed start/receipt/application and returns its persisted truthful outcome directly. */
  run(job: Job): Promise<Job>;
  /** Database/bytes-only recovery; implementation requires a durable candidate receipt. */
  retryPreparation(input: { readonly brandId: string; readonly jobId: string; readonly actorId: string }): Promise<Job>;
}
export function isImageJob(job: Pick<Job, 'kind' | 'payload'>): boolean {
  return job.kind === 'write' && job.payload.stage === 'image';
}
export function isArticleWriteJob(job: Pick<Job, 'kind' | 'payload'>): boolean {
  return job.kind === 'write' && job.payload.stage === undefined;
}
/** Once per immutable first draft, including recovery after article bookkeeping loss. */
export function automaticImageCommandId(articleId: string, versionId: string): string {
  const sha = createHash('sha256').update(`relaunch72.seo-image-default/v1:${articleId}:${versionId}`).digest('hex');
  return `${sha.slice(0, 8)}-${sha.slice(8, 12)}-5${sha.slice(13, 16)}-8${sha.slice(17, 20)}-${sha.slice(20, 32)}`;
}

/** Native job DTO only. Raw prompt/source/receipt bytes stay in the private durable job. */
export function imageJobDto(job: Job): Job {
  if (!isImageJob(job)) return job;
  const image = job.payload.image && typeof job.payload.image === 'object' && !Array.isArray(job.payload.image) ? job.payload.image as Record<string, unknown> : {};
  const result = image.result && typeof image.result === 'object' && !Array.isArray(image.result) ? image.result as Record<string, unknown> : {};
  const start = image.start && typeof image.start === 'object' && !Array.isArray(image.start) ? image.start as Record<string, unknown> : {};
  return { ...job, payload: { stage: 'image', image: {
    articleId: typeof image.articleId === 'string' ? image.articleId : null,
    articleVersionId: typeof image.articleVersionId === 'string' ? image.articleVersionId : null,
    intentId: typeof image.intentId === 'string' ? image.intentId : null,
    paidAttemptStarted: typeof start.nonce === 'string',
    result: { state: typeof result.state === 'string' ? result.state : null, code: typeof result.code === 'string' ? result.code : null,
      receiptPersisted: result.receiptPersisted === true, candidateAssetId: typeof result.candidateAssetId === 'string' ? result.candidateAssetId : null },
  } } };
}
