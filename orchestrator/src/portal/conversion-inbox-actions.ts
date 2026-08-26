import { createHmac, timingSafeEqual } from 'node:crypto';

export const CONVERSION_INBOX_CREATE_DRAFT_ROUTE = '/portal/inbox/drafts' as const;
export const CONVERSION_INBOX_TEST_QUEUE_PURPOSES = Object.freeze([
  'marketing',
  'property_predator_follow_up',
  'appointment_follow_up',
] as const);
export type ConversionInboxTestQueuePurpose = typeof CONVERSION_INBOX_TEST_QUEUE_PURPOSES[number];
const TEST_QUEUE_PURPOSE_SET = new Set<string>(CONVERSION_INBOX_TEST_QUEUE_PURPOSES);

export function isConversionInboxTestQueuePurpose(
  value: unknown,
): value is ConversionInboxTestQueuePurpose {
  return typeof value === 'string' && TEST_QUEUE_PURPOSE_SET.has(value);
}

export function conversionInboxReviseDraftRoute(messageId: string): string {
  return `/portal/inbox/messages/${encodeURIComponent(messageId)}/versions`;
}

export function conversionInboxRequestApprovalRoute(messageId: string): string {
  return `/portal/inbox/messages/${encodeURIComponent(messageId)}/approval-requests`;
}

export function conversionInboxDecisionRoute(approvalRequestId: string): string {
  return `/portal/inbox/approval-requests/${encodeURIComponent(approvalRequestId)}/decisions`;
}

export function conversionInboxTestQueueRoute(messageId: string): string {
  return `/portal/inbox/messages/${encodeURIComponent(messageId)}/test-queue`;
}

export type ConversionInboxNoticeCode =
  | 'draft_created'
  | 'draft_saved'
  | 'approval_requested'
  | 'approved'
  | 'rejected'
  | 'changes_requested'
  | 'test_queued'
  | 'replayed'
  | 'consent_blocked'
  | 'forbidden'
  | 'conflict'
  | 'missing'
  | 'invalid'
  | 'unavailable';

export interface ConversionInboxNoticeView {
  readonly kind: 'success' | 'info' | 'error';
  readonly title: string;
  readonly message: string;
}

const NOTICE_CODES = new Set<ConversionInboxNoticeCode>([
  'draft_created', 'draft_saved', 'approval_requested', 'approved', 'rejected',
  'changes_requested', 'test_queued', 'replayed', 'consent_blocked', 'forbidden',
  'conflict', 'missing', 'invalid', 'unavailable',
]);
const NOTICE_CONTEXT = 'relaunch72:conversion-inbox-notice:v1\0';

function noticeMac(secret: string, sessionToken: string, code: ConversionInboxNoticeCode): string {
  return createHmac('sha256', secret)
    .update(NOTICE_CONTEXT)
    .update(sessionToken)
    .update('\0')
    .update(code)
    .digest('base64url');
}

export function conversionInboxNoticeToken(
  secret: string,
  sessionToken: string,
  code: ConversionInboxNoticeCode,
): string {
  if (!secret || !sessionToken || !NOTICE_CODES.has(code)) return '';
  return `${code}.${noticeMac(secret, sessionToken, code)}`;
}

function noticeFor(code: ConversionInboxNoticeCode): ConversionInboxNoticeView {
  if (code === 'draft_created') return {
    kind: 'success', title: 'TEST draft created',
    message: 'Immutable version 1 is saved inside Growth HQ. Nothing was queued or sent.',
  };
  if (code === 'draft_saved') return {
    kind: 'success', title: 'New immutable draft saved',
    message: 'The previous version remains in the audit history. Review still targets only the currently displayed version.',
  };
  if (code === 'approval_requested') return {
    kind: 'success', title: 'Exact draft submitted',
    message: 'The immutable message version is waiting for human review. No provider operation exists yet.',
  };
  if (code === 'approved') return {
    kind: 'success', title: 'Exact draft approved',
    message: 'The decision covers the current body hash. Consent is still checked again before a TEST operation can queue.',
  };
  if (code === 'rejected') return {
    kind: 'info', title: 'Draft rejected',
    message: 'The immutable decision and note were recorded. The draft can be revised without losing its history.',
  };
  if (code === 'changes_requested') return {
    kind: 'info', title: 'Changes requested',
    message: 'The draft returned to revision state with the reviewer note preserved.',
  };
  if (code === 'test_queued') return {
    kind: 'success', title: 'TEST operation queued',
    message: 'A non-routable simulator operation was created. No real person, account or provider was contacted.',
  };
  if (code === 'replayed') return {
    kind: 'info', title: 'Safe replay confirmed',
    message: 'This exact protected command had already completed, so no duplicate version, decision or operation was created.',
  };
  if (code === 'consent_blocked') return {
    kind: 'error', title: 'Current consent blocked the queue',
    message: 'No provider operation was created. Review the channel permission and suppression evidence before trying again.',
  };
  if (code === 'forbidden') return {
    kind: 'error', title: 'Inbox access required',
    message: 'Your current workspace role cannot perform that message action. Nothing changed.',
  };
  if (code === 'conflict') return {
    kind: 'error', title: 'Draft conflict protected',
    message: 'The message state changed after this page loaded. Refresh before making another decision.',
  };
  if (code === 'missing') return {
    kind: 'error', title: 'Message target unavailable',
    message: 'The exact workspace-scoped conversation, message or review request could not be found.',
  };
  if (code === 'invalid') return {
    kind: 'error', title: 'Inbox action rejected',
    message: 'The protected form was incomplete or invalid. Refresh before trying again.',
  };
  return {
    kind: 'error', title: 'Conversion Inbox unavailable',
    message: 'The change could not complete safely. No provider call was made and no message left Growth HQ.',
  };
}

export function conversionInboxNoticeFromQuery(
  query: URLSearchParams,
  secret: string,
  sessionToken: string,
): ConversionInboxNoticeView | undefined {
  const supplied = query.get('notice') ?? '';
  const separator = supplied.indexOf('.');
  if (separator <= 0 || supplied.indexOf('.', separator + 1) !== -1) return undefined;
  const code = supplied.slice(0, separator) as ConversionInboxNoticeCode;
  const mac = supplied.slice(separator + 1);
  if (!NOTICE_CODES.has(code) || !mac || mac.length > 128) return undefined;
  const expected = noticeMac(secret, sessionToken, code);
  const actualBytes = Buffer.from(mac);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return undefined;
  return noticeFor(code);
}
