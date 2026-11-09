/**
 * Admin session — a signed, expiring cookie and a constant-time password check.
 * No user table yet (that arrives with the customer/affiliate DB in Phase B/C);
 * one admin password gates the whole control room. HMAC-signed so the cookie
 * can't be forged without SESSION_SECRET.
 */

import crypto from 'node:crypto';

export const SESSION_COOKIE = 'r72_admin';
export const ADMIN_LOGIN_CSRF_COOKIE = 'r72_admin_login_csrf';
export const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
const ADMIN_SESSION_CONTEXT = 'relaunch72/session/admin/v1\u0000';
const ADMIN_SESSION_CSRF_CONTEXT = 'relaunch72/csrf/admin-session/v1\u0000';
const ADMIN_LOGIN_CSRF_CONTEXT = 'relaunch72/csrf/admin-login/v1\u0000';
const BASE32_PATTERN = /^[A-Z2-7]{32,128}$/;
const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Constant-time password comparison (hash both to a fixed length first). */
export function passwordOk(provided: string, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Sign a session token `<payload>.<hmac>`. The operator-controlled epoch makes
 * every existing cookie immediately invalid when ADMIN_SESSION_EPOCH changes.
 */
export function signSession(
  secret: string,
  now: number,
  ttlMs = SESSION_TTL_MS,
  epoch = 0,
): string {
  const payload = Buffer.from(JSON.stringify({ v: 2, aud: 'admin', epoch, exp: now + ttlMs })).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(ADMIN_SESSION_CONTEXT).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

/** True iff the token's signature verifies and it hasn't expired. */
export function verifySession(
  secret: string,
  token: string | undefined,
  now: number,
  expectedEpoch = 0,
): boolean {
  if (!token || !secret) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(ADMIN_SESSION_CONTEXT).update(payload).digest('base64url');
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expected);
  if (macBuf.length !== expBuf.length || !crypto.timingSafeEqual(macBuf, expBuf)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const keys = Object.keys(parsed).sort().join(',');
    return keys === 'aud,epoch,exp,v'
      && parsed.v === 2
      && parsed.aud === 'admin'
      && typeof parsed.epoch === 'number'
      && Number.isSafeInteger(parsed.epoch)
      && parsed.epoch >= 0
      && parsed.epoch === expectedEpoch
      && typeof parsed.exp === 'number'
      && Number.isSafeInteger(parsed.exp)
      && parsed.exp > now;
  } catch {
    return false;
  }
}

/** Parse a Cookie header into a name→value map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
      catch { /* malformed cookies are ignored, never promoted to authority */ }
    }
  }
  return out;
}

/** Set-Cookie value for the session, scoped to the control room only. */
export function sessionCookie(token: string, secure: boolean, maxAgeSec = SESSION_TTL_MS / 1000): string {
  const bits = [`${SESSION_COOKIE}=${token}`, 'HttpOnly', 'SameSite=Strict', 'Path=/admin', `Max-Age=${maxAgeSec}`];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/** Set-Cookie value that clears the session. */
export function clearCookie(secure: boolean): string {
  const bits = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/admin', 'Max-Age=0'];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

function safeEqualText(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

/** Session-bound synchronizer token required by every authenticated admin POST. */
export function adminCsrfToken(secret: string, sessionToken: string): string {
  if (!secret || !sessionToken) return '';
  return crypto.createHmac('sha256', secret)
    .update(ADMIN_SESSION_CSRF_CONTEXT)
    .update(sessionToken)
    .digest('base64url');
}

export function verifyAdminCsrf(
  secret: string,
  sessionToken: string | undefined,
  supplied: string | undefined,
): boolean {
  if (!sessionToken) return false;
  return safeEqualText(supplied, adminCsrfToken(secret, sessionToken));
}

/** Signed double-submit token for the pre-authentication admin login form. */
export function adminLoginCsrfToken(secret: string): string {
  if (!secret) return '';
  const nonce = crypto.randomBytes(32).toString('base64url');
  const mac = crypto.createHmac('sha256', secret)
    .update(ADMIN_LOGIN_CSRF_CONTEXT)
    .update(nonce)
    .digest('base64url');
  return `${nonce}.${mac}`;
}

export function verifyAdminLoginCsrf(
  secret: string,
  cookieToken: string | undefined,
  supplied: string | undefined,
): boolean {
  if (!secret || !cookieToken || !safeEqualText(supplied, cookieToken)) return false;
  const [nonce, mac, extra] = cookieToken.split('.');
  if (extra !== undefined || !nonce || !mac
      || !BASE64URL_32_PATTERN.test(nonce) || !BASE64URL_32_PATTERN.test(mac)) return false;
  const expected = crypto.createHmac('sha256', secret)
    .update(ADMIN_LOGIN_CSRF_CONTEXT)
    .update(nonce)
    .digest('base64url');
  return safeEqualText(mac, expected);
}

export function adminLoginCsrfCookie(token: string, secure: boolean): string {
  const bits = [
    `${ADMIN_LOGIN_CSRF_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/admin/login',
    'Max-Age=600',
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/** Canonicalise an RFC 4648 base32 TOTP secret without accepting lookalikes. */
export function canonicalTotpSecret(value: string | undefined): string | null {
  if (!value) return null;
  const canonical = value.replace(/\s+/g, '').toUpperCase();
  return BASE32_PATTERN.test(canonical) ? canonical : null;
}

function decodeBase32(secret: string): Buffer {
  let bits = '';
  for (const character of secret) {
    const value = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(character);
    if (value < 0) throw new Error('Invalid base32 TOTP secret');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

/** RFC 6238 (SHA-1, six digits, 30-second step), compatible with common apps. */
export function totpCode(secret: string, now: number, stepOffset = 0): string {
  const canonical = canonicalTotpSecret(secret);
  if (!canonical || !Number.isFinite(now)) return '';
  const counter = Math.floor(now / 30_000) + stepOffset;
  if (!Number.isSafeInteger(counter) || counter < 0) return '';
  const movingFactor = Buffer.alloc(8);
  movingFactor.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', decodeBase32(canonical)).update(movingFactor).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24)
    | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8)
    | (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

/** Accept the current RFC 6238 step and one neighbouring step for clock drift. */
export function verifyTotp(secret: string | undefined, supplied: string | undefined, now: number): boolean {
  const canonical = canonicalTotpSecret(secret);
  if (!canonical || !supplied || !/^\d{6}$/.test(supplied)) return false;
  let match = false;
  for (const offset of [-1, 0, 1]) {
    // Do all three constant-time comparisons so the matching window is not observable.
    match = safeEqualText(supplied, totpCode(canonical, now, offset)) || match;
  }
  return match;
}
