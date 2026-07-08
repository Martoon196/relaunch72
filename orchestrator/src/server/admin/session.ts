/**
 * Admin session — a signed, expiring cookie and a constant-time password check.
 * No user table yet (that arrives with the customer/affiliate DB in Phase B/C);
 * one admin password gates the whole control room. HMAC-signed so the cookie
 * can't be forged without SESSION_SECRET.
 */

import crypto from 'node:crypto';

export const SESSION_COOKIE = 'r72_admin';
export const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

/** Constant-time password comparison (hash both to a fixed length first). */
export function passwordOk(provided: string, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Sign a session token `<payload>.<hmac>`; payload carries the expiry. */
export function signSession(secret: string, now: number, ttlMs = SESSION_TTL_MS): string {
  const payload = Buffer.from(JSON.stringify({ exp: now + ttlMs })).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

/** True iff the token's signature verifies and it hasn't expired. */
export function verifySession(secret: string, token: string | undefined, now: number): boolean {
  if (!token || !secret) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expected);
  if (macBuf.length !== expBuf.length || !crypto.timingSafeEqual(macBuf, expBuf)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
    return typeof parsed.exp === 'number' && parsed.exp > now;
  } catch {
    return false;
  }
}

/** Parse a Cookie header into a name→value map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Set-Cookie value for the session (HttpOnly, SameSite=Lax; Secure in prod). */
export function sessionCookie(token: string, secure: boolean, maxAgeSec = SESSION_TTL_MS / 1000): string {
  const bits = [`${SESSION_COOKIE}=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAgeSec}`];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/** Set-Cookie value that clears the session. */
export function clearCookie(secure: boolean): string {
  const bits = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}
