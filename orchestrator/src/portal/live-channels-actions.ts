/**
 * Session-bound notice tokens for the Live Channels emergency-pause command.
 * Notices are HMAC-signed so a crafted link can never make the page claim a
 * command outcome that this session did not produce.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { LiveChannelsNoticeCode, LiveChannelsNoticeView } from './live-channels-presenter.js';

const NOTICE_CONTEXT = 'property-predator:live-channels-notice:v1\0';

const NOTICE_CODES = new Set<LiveChannelsNoticeCode>([
  'pause_engaged', 'pause_already', 'profile_bound', 'profile_revoked',
  'publication_staged', 'staging_blocked', 'owned_social_invalid',
  'owned_social_forbidden', 'owned_social_unavailable',
  'sms_sender_bound', 'sms_sender_revoked', 'sms_test_staged',
  'sms_staging_blocked', 'sms_invalid', 'sms_forbidden', 'sms_unavailable',
  'invalid', 'forbidden', 'unavailable',
]);

function noticeMac(secret: string, sessionToken: string, code: LiveChannelsNoticeCode): string {
  return createHmac('sha256', secret)
    .update(NOTICE_CONTEXT)
    .update(sessionToken)
    .update('\0')
    .update(code)
    .digest('base64url');
}

export function liveChannelsNoticeToken(
  secret: string,
  sessionToken: string,
  code: LiveChannelsNoticeCode,
): string {
  if (!secret || !sessionToken || !NOTICE_CODES.has(code)) return '';
  return `${code}.${noticeMac(secret, sessionToken, code)}`;
}

function noticeFor(code: LiveChannelsNoticeCode): LiveChannelsNoticeView {
  if (code === 'pause_engaged') return {
    kind: 'success',
    title: 'Emergency pause engaged',
    message: 'The pause took effect and this rail can no longer begin a provider call. Release is a separate decision outside this portal.',
  };
  if (code === 'pause_already') return {
    kind: 'info',
    title: 'Pause already engaged',
    message: 'This rail was already holding an engaged emergency pause, so nothing changed.',
  };
  if (code === 'profile_bound') return {
    kind: 'success',
    title: 'Owned profile bound',
    message: 'The owned account evidence was sealed and recorded. The Profile Key was encrypted immediately and is not stored, shown or recoverable here.',
  };
  if (code === 'profile_revoked') return {
    kind: 'info',
    title: 'Owned profile revoked',
    message: 'The binding is permanently revoked and can never publish again. Rotating to a successor means binding a new owned profile.',
  };
  if (code === 'publication_staged') return {
    kind: 'success',
    title: 'Publication staged',
    message: 'One approved post is queued behind the owned-profile command boundary. No worker lease was claimed and Ayrshare was not called.',
  };
  if (code === 'staging_blocked') return {
    kind: 'error',
    title: 'Publication not staged',
    message: 'The database did not prove every readiness dimension for this exact owned profile and approved post, so nothing was queued.',
  };
  if (code === 'sms_sender_bound') return {
    kind: 'success',
    title: 'Owned SMS sender bound',
    message: 'The Twilio account, messaging service and owned number are recorded as digests. No credential was stored and Twilio was not contacted.',
  };
  if (code === 'sms_sender_revoked') return {
    kind: 'info',
    title: 'Owned SMS sender revoked',
    message: 'The binding is permanently revoked and its connection disabled, so this rail can never dispatch through it again.',
  };
  if (code === 'sms_test_staged') return {
    kind: 'success',
    title: 'Owned test SMS staged',
    message: 'One owned-recipient message is queued behind the command boundary. No worker lease was claimed and Twilio was not called.',
  };
  if (code === 'sms_staging_blocked') return {
    kind: 'error',
    title: 'Owned test SMS not staged',
    message: 'The database did not prove every readiness dimension for this exact owned recipient and approved message, so nothing was queued.',
  };
  if (code === 'sms_forbidden') return {
    kind: 'error',
    title: 'SMS command not permitted',
    message: 'Your current workspace role cannot bind, revoke or stage for this rail. No sender evidence was stored and nothing was queued.',
  };
  if (code === 'sms_unavailable') return {
    kind: 'error',
    title: 'SMS command not connected',
    message: 'The Twilio SMS founder command boundary is not composed for this workspace, so nothing was recorded or queued.',
  };
  if (code === 'sms_invalid') return {
    kind: 'error',
    title: 'SMS command rejected',
    message: 'The request was missing its confirmation or failed verification. No sender evidence was stored and nothing was queued.',
  };
  if (code === 'owned_social_forbidden') return {
    kind: 'error',
    title: 'Owned X command not permitted',
    message: 'Your current workspace role cannot bind, revoke or stage for this owned account. No profile, publication or channel state was changed.',
  };
  if (code === 'owned_social_unavailable') return {
    kind: 'error',
    title: 'Owned X command not connected',
    message: 'The owned-social founder command boundary is not composed for this workspace, so nothing was recorded or queued.',
  };
  if (code === 'owned_social_invalid') return {
    kind: 'error',
    title: 'Owned X command rejected',
    message: 'The request was missing its confirmation or failed verification. No profile evidence was stored and nothing was queued.',
  };
  if (code === 'forbidden') return {
    kind: 'error',
    title: 'Pause command not permitted',
    message: 'Your current workspace role cannot engage the emergency pause. No switch or channel state was changed.',
  };
  if (code === 'unavailable') return {
    kind: 'error',
    title: 'Pause command not connected',
    message: 'The pause command seam is not composed for this workspace, so the pause remains controlled by environment switches. Nothing was changed.',
  };
  return {
    kind: 'error',
    title: 'Pause command rejected',
    message: 'The request was missing its confirmation or failed verification. No switch or channel state was changed.',
  };
}

export function liveChannelsNoticeFromQuery(
  query: URLSearchParams,
  secret: string,
  sessionToken: string,
): LiveChannelsNoticeView | undefined {
  const supplied = query.get('notice') ?? '';
  const separator = supplied.indexOf('.');
  if (separator <= 0 || supplied.indexOf('.', separator + 1) !== -1) return undefined;
  const code = supplied.slice(0, separator) as LiveChannelsNoticeCode;
  const mac = supplied.slice(separator + 1);
  if (!NOTICE_CODES.has(code) || !mac || mac.length > 128) return undefined;
  const expected = noticeMac(secret, sessionToken, code);
  const actualBytes = Buffer.from(mac);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return undefined;
  return noticeFor(code);
}
