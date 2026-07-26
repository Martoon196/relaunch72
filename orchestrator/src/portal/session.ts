/**
 * Client-portal session — like the admin session, but multi-tenant: the signed
 * cookie carries the tenant id, so a logged-in client only ever sees their own
 * data. HMAC-signed with the server's SESSION_SECRET; can't be forged.
 */

import crypto from 'node:crypto';

export const PORTAL_COOKIE = 'r72_portal';
export const PORTAL_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

/** Constant-time password check (hash both sides to a fixed length first). */
export function passwordOk(provided: string, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Sign `<payload>.<hmac>`; payload carries the tenant id + expiry. */
export function signTenant(secret: string, tenantId: string, now: number, ttlMs = PORTAL_TTL_MS): string {
  const payload = Buffer.from(JSON.stringify({ tid: tenantId, exp: now + ttlMs })).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

/** Return the tenant id iff the token verifies and hasn't expired, else null. */
export function verifyTenant(secret: string, token: string | undefined, now: number): string | null {
  if (!token || !secret) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expected);
  if (macBuf.length !== expBuf.length || !crypto.timingSafeEqual(macBuf, expBuf)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { tid?: string; exp?: number };
    if (typeof parsed.exp === 'number' && parsed.exp > now && typeof parsed.tid === 'string') return parsed.tid;
    return null;
  } catch {
    return null;
  }
}

export function portalCookie(token: string, secure: boolean, maxAgeSec = PORTAL_TTL_MS / 1000): string {
  const bits = [`${PORTAL_COOKIE}=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAgeSec}`];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearPortalCookie(secure: boolean): string {
  const bits = [`${PORTAL_COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}
