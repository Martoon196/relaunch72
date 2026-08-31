import { createHmac, timingSafeEqual } from 'node:crypto';

export type ZernioSocialNoticeCode =
  | 'connected' | 'replayed' | 'invalid' | 'forbidden' | 'unavailable'
  | 'billing_required' | 'rate_limited' | 'provider_rejected';

export interface ZernioSocialNotice {
  readonly kind: 'success' | 'info' | 'error';
  readonly title: string;
  readonly message: string;
}

const CONTEXT = 'property-predator:zernio-social-notice:v1\0';
const CODES = new Set<ZernioSocialNoticeCode>([
  'connected', 'replayed', 'invalid', 'forbidden', 'unavailable',
  'billing_required', 'rate_limited', 'provider_rejected',
]);

function mac(secret: string, sessionToken: string, code: ZernioSocialNoticeCode): string {
  return createHmac('sha256', secret).update(CONTEXT).update(sessionToken)
    .update('\0').update(code).digest('base64url');
}

export function zernioSocialNoticeToken(
  secret: string, sessionToken: string, code: ZernioSocialNoticeCode,
): string {
  if (!secret || !sessionToken || !CODES.has(code)) return '';
  return `${code}.${mac(secret, sessionToken, code)}`;
}

function notice(code: ZernioSocialNoticeCode): ZernioSocialNotice {
  if (code === 'connected') return Object.freeze({
    kind: 'success', title: 'Social account connected',
    message: 'Growth HQ recorded the selected Zernio account. Nothing was scheduled or published.',
  });
  if (code === 'replayed') return Object.freeze({
    kind: 'info', title: 'Connection already recorded',
    message: 'This exact callback was already accepted. No duplicate account or provider action was created.',
  });
  if (code === 'billing_required') return Object.freeze({
    kind: 'error', title: 'Zernio billing boundary reached',
    message: 'Zernio did not open the connection flow because its current account allowance requires billing attention.',
  });
  if (code === 'rate_limited') return Object.freeze({
    kind: 'error', title: 'Zernio is temporarily busy',
    message: 'The provider rate-limited connection preparation. No OAuth window was opened.',
  });
  if (code === 'forbidden') return Object.freeze({
    kind: 'error', title: 'Connection not permitted',
    message: 'This session or workspace role cannot connect the requested account. Nothing changed.',
  });
  if (code === 'unavailable') return Object.freeze({
    kind: 'error', title: 'Connection boundary unavailable',
    message: 'Growth HQ could not prove its dedicated Zernio command boundary. Nothing was connected.',
  });
  if (code === 'provider_rejected') return Object.freeze({
    kind: 'error', title: 'Zernio rejected the connection',
    message: 'The provider response did not match the reviewed connection contract. No OAuth window was opened.',
  });
  return Object.freeze({
    kind: 'error', title: 'Connection request rejected',
    message: 'The request, callback or confirmation failed verification. Nothing was connected or published.',
  });
}

export function zernioSocialNoticeFromQuery(
  query: URLSearchParams, secret: string, sessionToken: string,
): ZernioSocialNotice | undefined {
  const supplied = query.get('notice') ?? '';
  const separator = supplied.indexOf('.');
  if (separator <= 0 || supplied.indexOf('.', separator + 1) !== -1) return undefined;
  const code = supplied.slice(0, separator) as ZernioSocialNoticeCode;
  const suppliedMac = supplied.slice(separator + 1);
  if (!CODES.has(code) || suppliedMac.length > 128) return undefined;
  const expected = mac(secret, sessionToken, code);
  const actualBytes = Buffer.from(suppliedMac);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length
      || !timingSafeEqual(actualBytes, expectedBytes)) return undefined;
  return notice(code);
}
