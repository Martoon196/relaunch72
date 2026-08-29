/**
 * Session-bound notice tokens for the Live Channels emergency-pause command.
 * Notices are HMAC-signed so a crafted link can never make the page claim a
 * command outcome that this session did not produce.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { LiveChannelsNoticeCode, LiveChannelsNoticeView } from './live-channels-presenter.js';

const NOTICE_CONTEXT = 'property-predator:live-channels-notice:v1\0';

const NOTICE_CODES = new Set<LiveChannelsNoticeCode>([
  'pause_engaged', 'pause_already', 'invalid', 'forbidden', 'unavailable',
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
