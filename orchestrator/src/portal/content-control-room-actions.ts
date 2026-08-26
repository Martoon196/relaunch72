import { createHmac, timingSafeEqual } from 'node:crypto';

export const CONTENT_APPROVAL_REQUEST_ROUTE = '/portal/content/approval-requests' as const;
export const CONTENT_APPROVAL_DECISION_ROUTE = '/portal/content/approval-decisions' as const;

export type ContentControlNoticeCode =
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'changes_requested'
  | 'replayed'
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
  'requested', 'approved', 'rejected', 'changes_requested', 'replayed',
  'forbidden', 'conflict', 'missing', 'invalid', 'review_unavailable', 'unavailable',
]);
const NOTICE_CONTEXT = 'relaunch72:content-control-notice:v1\0';

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
