import { createHmac, timingSafeEqual } from 'node:crypto';

export type ZernioMessagingNoticeCode =
  | 'draft_created' | 'approval_requested' | 'approved' | 'rejected'
  | 'sent' | 'replayed' | 'invalid' | 'forbidden' | 'conflict'
  | 'unavailable' | 'provider_rejected' | 'outcome_unknown'
  | 'effects_disabled' | 'emergency_paused';

export interface ZernioMessagingNotice {
  readonly code: ZernioMessagingNoticeCode;
  readonly kind: 'success' | 'info' | 'error';
  readonly title: string;
  readonly message: string;
}

const CONTEXT = 'property-predator:zernio-messaging-notice:v1\0';
const CODES = new Set<ZernioMessagingNoticeCode>([
  'draft_created', 'approval_requested', 'approved', 'rejected', 'sent', 'replayed',
  'invalid', 'forbidden', 'conflict', 'unavailable', 'provider_rejected', 'outcome_unknown',
  'effects_disabled', 'emergency_paused',
]);

function mac(secret: string, sessionToken: string, code: ZernioMessagingNoticeCode): string {
  return createHmac('sha256', secret).update(CONTEXT).update(sessionToken)
    .update('\0').update(code).digest('base64url');
}

export function zernioMessagingNoticeToken(
  secret: string, sessionToken: string, code: ZernioMessagingNoticeCode,
): string {
  if (!secret || !sessionToken || !CODES.has(code)) return '';
  return `${code}.${mac(secret, sessionToken, code)}`;
}

function notice(code: ZernioMessagingNoticeCode): ZernioMessagingNotice {
  if (code === 'draft_created') return Object.freeze({
    code, kind: 'success', title: 'Reply draft saved',
    message: 'The exact target and reply copy are sealed. Nothing was sent.',
  });
  if (code === 'approval_requested') return Object.freeze({
    code, kind: 'success', title: 'Approval requested',
    message: 'The immutable reply is awaiting an explicit decision. Nothing was sent.',
  });
  if (code === 'approved') return Object.freeze({
    code, kind: 'success', title: 'Reply approved',
    message: 'The exact draft is approved. Sending still requires the separate send button.',
  });
  if (code === 'rejected') return Object.freeze({
    code, kind: 'info', title: 'Reply rejected',
    message: 'The draft is closed and cannot be sent. Create a new draft to change the copy.',
  });
  if (code === 'sent') return Object.freeze({
    code, kind: 'success', title: 'Social reply accepted',
    message: 'The social network accepted one exact approved reply and Growth HQ recorded the receipt.',
  });
  if (code === 'effects_disabled') return Object.freeze({
    code, kind: 'info', title: 'Outbound effects are off',
    message: 'The approved reply remains sealed in Growth HQ. No provider call began.',
  });
  if (code === 'emergency_paused') return Object.freeze({
    code, kind: 'info', title: 'Social replies are paused',
    message: 'The emergency pause blocked the provider boundary before any send began.',
  });
  if (code === 'replayed') return Object.freeze({
    code, kind: 'info', title: 'Exact command already recorded',
    message: 'Growth HQ reused the durable result. No duplicate provider action ran.',
  });
  if (code === 'outcome_unknown') return Object.freeze({
    code, kind: 'error', title: 'Reply outcome needs reconciliation',
    message: 'Growth HQ will not retry because the provider may have received the reply. Check the thread before any new action.',
  });
  if (code === 'forbidden') return Object.freeze({
    code, kind: 'error', title: 'Reply action not permitted',
    message: 'The session, account, target or approval did not match. Nothing was sent.',
  });
  if (code === 'conflict') return Object.freeze({
    code, kind: 'error', title: 'Reply state changed',
    message: 'The draft or approval is no longer in the expected state. Refresh before acting.',
  });
  if (code === 'provider_rejected') return Object.freeze({
    code, kind: 'error', title: 'The social network rejected the reply',
    message: 'The provider refused the one approved attempt. Growth HQ recorded the failure and did not retry.',
  });
  if (code === 'unavailable') return Object.freeze({
    code, kind: 'error', title: 'Reply boundary unavailable',
    message: 'Growth HQ could not prove or complete the protected reply command. Nothing was retried.',
  });
  return Object.freeze({
    code, kind: 'error', title: 'Reply request rejected',
    message: 'The form, target or confirmation failed verification. Nothing was sent.',
  });
}

export function zernioMessagingNoticeFromQuery(
  query: URLSearchParams, secret: string, sessionToken: string,
): ZernioMessagingNotice | undefined {
  const supplied = query.get('notice') ?? '';
  const separator = supplied.indexOf('.');
  if (separator <= 0 || supplied.indexOf('.', separator + 1) !== -1) return undefined;
  const code = supplied.slice(0, separator) as ZernioMessagingNoticeCode;
  const suppliedMac = supplied.slice(separator + 1);
  if (!CODES.has(code) || suppliedMac.length > 128) return undefined;
  const expected = mac(secret, sessionToken, code);
  const actualBytes = Buffer.from(suppliedMac);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length
      || !timingSafeEqual(actualBytes, expectedBytes)) return undefined;
  return notice(code);
}
