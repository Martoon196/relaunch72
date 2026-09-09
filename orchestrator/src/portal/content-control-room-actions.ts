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
  'forbidden', 'conflict', 'missing', 'invalid', 'review_unavailable', 'unavailable',
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
  if (code === 'draft_created') return {
    kind: 'success',
    title: 'Owned-seed proof draft created',
    message: 'The exact internal subject and body are immutable and ready for human review. Nothing was sent.',
  };
  if (code === 'revision_created') return {
    kind: 'success',
    title: 'New version saved',
    message: 'Your correction is a new immutable version. Previous approval evidence remains attached only to the older copy.',
  };
  if (code === 'requested') return {
    kind: 'success',
    title: 'Exact version submitted',
    message: 'The immutable content version is waiting for human review. Nothing was scheduled or published.',
  };
  if (code === 'approved') return {
    kind: 'success',
    title: 'Exact version approved',
    message: 'The decision covers this exact content hash. Publishing still requires fresh source proof and a separate outbound operation.',
  };
  if (code === 'rejected') return {
    kind: 'info',
    title: 'Version rejected',
    message: 'The immutable review decision and note were recorded. No provider or publishing action ran.',
  };
  if (code === 'changes_requested') return {
    kind: 'info',
    title: 'Changes requested',
    message: 'The exact version is back with the content team and the review note is preserved in the audit history.',
  };
  if (code === 'replayed') return {
    kind: 'info',
    title: 'Safe replay confirmed',
    message: 'This exact protected command had already completed, so no duplicate request or decision was created.',
  };
  if (code === 'source_refreshed') return {
    kind: 'success',
    title: 'Exact source proof refreshed',
    message: 'The saved approved version is eligible again. No new draft was generated and nothing was posted.',
  };
  if (code === 'forbidden') return {
    kind: 'error',
    title: 'Approval access required',
    message: 'Your current workspace role cannot perform that review action. Nothing changed.',
  };
  if (code === 'conflict') return {
    kind: 'error',
    title: 'Version conflict protected',
    message: 'The content or review state changed before this action completed. Refresh before reviewing again.',
  };
  if (code === 'missing') return {
    kind: 'error',
    title: 'Review target unavailable',
    message: 'The exact workspace-scoped content or approval request was not found. Nothing changed.',
  };
  if (code === 'invalid') return {
    kind: 'error',
    title: 'Review action rejected',
    message: 'The protected form was incomplete or invalid. Refresh and try the action again.',
  };
  if (code === 'review_unavailable') return {
    kind: 'error',
    title: 'Approval locked safely',
    message: 'The exact hash-bound text or artwork is not available to inspect, so approval and outbound eligibility remain locked.',
  };
  return {
    kind: 'error',
    title: 'Content approval unavailable',
    message: 'The command could not complete safely. No provider, schedule or publishing action ran.',
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
