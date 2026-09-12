import { createHmac, timingSafeEqual } from 'node:crypto';

export const CONTENT_APPROVAL_REQUEST_ROUTE = '/portal/content/approval-requests' as const;
export const CONTENT_APPROVAL_DECISION_ROUTE = '/portal/content/approval-decisions' as const;
export const GENERATED_SOURCE_REFRESH_ROUTE = '/portal/content/generated-source-refresh' as const;
export const CONTENT_SOCIAL_REVISION_ROUTE = '/portal/content/social-revisions' as const;

export type ContentControlNoticeCode =
  | 'draft_created'
  | 'revision_created'
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'changes_requested'
  | 'replayed'
  | 'source_refreshed'
  | 'source_unavailable'
  | 'forbidden'
  | 'conflict'
  | 'missing'
  | 'invalid'
  | 'review_unavailable'
  | 'unavailable';

export interface ContentControlNoticeView {
  readonly kind: 'success' | 'info' | 'error';
  readonly title: string;
  readonly message: string;
}

const NOTICE_CODES = new Set<ContentControlNoticeCode>([
  'draft_created', 'revision_created', 'requested', 'approved', 'rejected', 'changes_requested', 'replayed', 'source_refreshed',
  'forbidden', 'conflict', 'missing', 'invalid', 'review_unavailable', 'unavailable', 'source_unavailable',
]);
const NOTICE_CONTEXT = 'relaunch72:content-control-notice:v1\0';
const EXACT_REVIEW_APPROVAL_CONTEXT = 'relaunch72:content-control-exact-review-approval:v1\0';
const EXACT_REVIEW_APPROVAL_TTL_MS = 15 * 60 * 1_000;
const EXACT_REVIEW_REVISION_CONTEXT = 'relaunch72:content-control-exact-review-revision:v1\0';
const EXACT_REVIEW_REVISION_TTL_MS = 15 * 60 * 1_000;

export interface ExactReviewRevisionTokenInput {
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly contentSha256: string;
}

function exactReviewRevisionPayload(input: ExactReviewRevisionTokenInput, expiresAt: number): string {
  return [
    input.contentItemId.toLowerCase(),
    input.contentVersionId.toLowerCase(),
    input.contentSha256.toLowerCase(),
    String(expiresAt),
  ].join('.');
}

function exactReviewRevisionMac(secret: string, sessionToken: string, payload: string): string {
  return createHmac('sha256', secret)
    .update(EXACT_REVIEW_REVISION_CONTEXT)
    .update(sessionToken)
    .update('\0')
    .update(payload)
    .digest('base64url');
}

export function exactReviewRevisionToken(
  secret: string,
  sessionToken: string,
  input: ExactReviewRevisionTokenInput,
  now: number,
): string {
  if (!secret || !sessionToken || !Number.isFinite(now)) return '';
  const expiresAt = Math.floor(now + EXACT_REVIEW_REVISION_TTL_MS);
  const payload = exactReviewRevisionPayload(input, expiresAt);
  return `${payload}.${exactReviewRevisionMac(secret, sessionToken, payload)}`;
}

export function verifyExactReviewRevisionToken(
  secret: string,
  sessionToken: string,
  supplied: string | undefined,
  input: ExactReviewRevisionTokenInput,
  now: number,
): boolean {
  if (!secret || !sessionToken || !supplied || supplied.length > 768 || !Number.isFinite(now)) return false;
  const parts = supplied.split('.');
  if (parts.length !== 5) return false;
  const [contentItemId, contentVersionId, contentSha256, rawExpiry, actualMac] = parts;
  const expiresAt = Number(rawExpiry);
  if (!contentItemId || !contentVersionId || !contentSha256 || !actualMac
      || !Number.isSafeInteger(expiresAt) || expiresAt < now
      || expiresAt > now + EXACT_REVIEW_REVISION_TTL_MS) return false;
  const expectedPayload = exactReviewRevisionPayload(input, expiresAt);
  const suppliedPayload = [contentItemId, contentVersionId, contentSha256, rawExpiry].join('.');
  if (suppliedPayload !== expectedPayload) return false;
  const expectedMac = exactReviewRevisionMac(secret, sessionToken, expectedPayload);
  const actualBytes = Buffer.from(actualMac);
  const expectedBytes = Buffer.from(expectedMac);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export interface ExactReviewApprovalTokenInput {
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly approvalRequestId: string;
  readonly contentSha256: string;
}

function exactReviewApprovalPayload(
  input: ExactReviewApprovalTokenInput,
  expiresAt: number,
): string {
  return [
    input.contentItemId.toLowerCase(),
    input.contentVersionId.toLowerCase(),
    input.approvalRequestId.toLowerCase(),
    input.contentSha256.toLowerCase(),
    String(expiresAt),
  ].join('.');
}

function exactReviewApprovalMac(
  secret: string,
  sessionToken: string,
  payload: string,
): string {
  return createHmac('sha256', secret)
    .update(EXACT_REVIEW_APPROVAL_CONTEXT)
    .update(sessionToken)
    .update('\0')
    .update(payload)
    .digest('base64url');
}

/**
 * Short-lived capability emitted only beside the complete immutable review.
 * It is bound to this portal session, exact version, request and content hash;
 * the summary page cannot mint or reuse it.
 */
export function exactReviewApprovalToken(
  secret: string,
  sessionToken: string,
  input: ExactReviewApprovalTokenInput,
  now: number,
): string {
  if (!secret || !sessionToken || !Number.isFinite(now)) return '';
  const expiresAt = Math.floor(now + EXACT_REVIEW_APPROVAL_TTL_MS);
  const payload = exactReviewApprovalPayload(input, expiresAt);
  return `${payload}.${exactReviewApprovalMac(secret, sessionToken, payload)}`;
}

export function verifyExactReviewApprovalToken(
  secret: string,
  sessionToken: string,
  supplied: string | undefined,
  input: ExactReviewApprovalTokenInput,
  now: number,
): boolean {
  if (!secret || !sessionToken || !supplied || supplied.length > 768 || !Number.isFinite(now)) return false;
  const parts = supplied.split('.');
  if (parts.length !== 6) return false;
  const [contentItemId, contentVersionId, approvalRequestId, contentSha256, rawExpiry, actualMac] = parts;
  const expiresAt = Number(rawExpiry);
  if (!contentItemId || !contentVersionId || !approvalRequestId || !contentSha256
      || !actualMac || !Number.isSafeInteger(expiresAt)
      || expiresAt < now || expiresAt > now + EXACT_REVIEW_APPROVAL_TTL_MS) return false;
  const expectedPayload = exactReviewApprovalPayload(input, expiresAt);
  const suppliedPayload = [contentItemId, contentVersionId, approvalRequestId, contentSha256, rawExpiry].join('.');
  if (suppliedPayload !== expectedPayload) return false;
  const expectedMac = exactReviewApprovalMac(secret, sessionToken, expectedPayload);
  const actualBytes = Buffer.from(actualMac);
  const expectedBytes = Buffer.from(expectedMac);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function noticeMac(secret: string, sessionToken: string, code: ContentControlNoticeCode): string {
  return createHmac('sha256', secret)
    .update(NOTICE_CONTEXT)
    .update(sessionToken)
    .update('\0')
    .update(code)
    .digest('base64url');
}

export function contentControlNoticeToken(
  secret: string,
  sessionToken: string,
  code: ContentControlNoticeCode,
): string {
  if (!secret || !sessionToken || !NOTICE_CODES.has(code)) return '';
  return `${code}.${noticeMac(secret, sessionToken, code)}`;
}

function noticeFor(code: ContentControlNoticeCode): ContentControlNoticeView {
  if (code === 'source_unavailable') return {
    kind: 'error',
    title: 'Scheduling check could not finish',
    message: 'Your post, picture and approval are saved. We could not verify the saved source. Nothing was scheduled or published; you do not need to recreate or reapprove your post.',
  };
  if (code === 'draft_created') return {
    kind: 'success',
    title: 'Test email created',
    message: 'Your test email is ready to review. Nothing was sent.',
  };
  if (code === 'revision_created') return {
    kind: 'success',
    title: 'Changes saved',
    message: 'Your updated post is saved and needs a new approval. The previous copy is kept in your history.',
  };
  if (code === 'requested') return {
    kind: 'success',
    title: 'Sent for approval',
    message: 'Your content is waiting for a reviewer. Nothing has been scheduled or published.',
  };
  if (code === 'approved') return {
    kind: 'success',
    title: 'Content approved',
    message: 'Your approval is saved. Check that this content is ready in your library before scheduling. Nothing has been published.',
  };
  if (code === 'rejected') return {
    kind: 'info',
    title: 'Content not approved',
    message: 'Your decision and note are saved. Nothing has been published.',
  };
  if (code === 'changes_requested') return {
    kind: 'info',
    title: 'Changes requested',
    message: 'Your feedback is saved for the content team. The updated content will need another review.',
  };
  if (code === 'replayed') return {
    kind: 'info',
    title: 'Already saved',
    message: 'This action was already completed. We have not created a duplicate.',
  };
  if (code === 'source_refreshed') return {
    kind: 'success',
    title: 'Source check complete',
    message: 'The approved content has passed its source check. Your wording is unchanged and nothing has been posted.',
  };
  if (code === 'forbidden') return {
    kind: 'error',
    title: 'You do not have permission',
    message: 'Ask a workspace owner or admin to help with this action. Nothing changed.',
  };
  if (code === 'conflict') return {
    kind: 'error',
    title: 'This content has changed',
    message: 'Someone updated this content or its approval. Reload the page and review the latest copy.',
  };
  if (code === 'missing') return {
    kind: 'error',
    title: 'Content not found',
    message: 'We could not find this content or review. Return to your content and open it again.',
  };
  if (code === 'invalid') return {
    kind: 'error',
    title: 'Please try again',
    message: 'This form could not be accepted. Reload the page and try again.',
  };
  if (code === 'review_unavailable') return {
    kind: 'error',
    title: 'Preview unavailable',
    message: 'We cannot show a verified preview right now. Open the post again shortly. It cannot be approved or published until the preview is available.',
  };
  return {
    kind: 'error',
    title: 'Could not save your review',
    message: 'Please reload the page and try again. Nothing was scheduled or published.',
  };
}

export function contentControlNoticeFromQuery(
  query: URLSearchParams,
  secret: string,
  sessionToken: string,
): ContentControlNoticeView | undefined {
  const supplied = query.get('notice') ?? '';
  const separator = supplied.indexOf('.');
  if (separator <= 0 || supplied.indexOf('.', separator + 1) !== -1) return undefined;
  const code = supplied.slice(0, separator) as ContentControlNoticeCode;
  const mac = supplied.slice(separator + 1);
  if (!NOTICE_CODES.has(code) || !mac || mac.length > 128) return undefined;
  const expected = noticeMac(secret, sessionToken, code);
  const actualBytes = Buffer.from(mac);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return undefined;
  return noticeFor(code);
}
