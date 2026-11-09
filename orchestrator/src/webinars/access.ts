/**
 * Attendee access links. A token is <registration uuid>.<version>.<HMAC>, so the
 * database never stores a bearer credential; bumping the registration's version
 * revokes every earlier link. The token is bound to the event's public key, so a
 * link for one webinar (or brand) can never open another.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface AccessClaim {
  readonly registrationId: string;
  readonly version: number;
}

function mac(secret: string, publicKey: string, registrationId: string, version: number): Buffer {
  return createHmac('sha256', secret).update('webinar-access.v1\0').update(publicKey).update('\0')
    .update(registrationId).update('\0').update(String(version)).digest();
}

export function issueAccessToken(secret: string, publicKey: string, claim: AccessClaim): string {
  return `${claim.registrationId}.${claim.version}.${mac(secret, publicKey, claim.registrationId, claim.version).toString('base64url')}`;
}

export function readAccessToken(secret: string, publicKey: string, token: string | null | undefined): AccessClaim | null {
  if (!token || token.length > 120) return null;
  const m = /^([0-9a-f-]{36})\.(\d{1,6})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m || !UUID.test(m[1]!)) return null;
  const version = Number(m[2]);
  if (!Number.isInteger(version) || version < 1) return null;
  const expected = mac(secret, publicKey, m[1]!, version);
  const supplied = Buffer.from(m[3]!, 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  return { registrationId: m[1]!, version };
}

/** Cookie scoped to one webinar's path; HttpOnly so page scripts never see the token. */
export function accessCookieName(publicKey: string): string {
  return `wb_${createHmac('sha256', 'webinar-cookie-name').update(publicKey).digest('hex').slice(0, 16)}`;
}

export function accessCookie(publicKey: string, token: string, secure: boolean, maxAgeSeconds = 60 * 60 * 24 * 120): string {
  return `${accessCookieName(publicKey)}=${token}; Path=/w/${publicKey}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}
