/**
 * Client-portal session — like the admin session, but multi-tenant: the signed
 * cookie carries the tenant id, so a logged-in client only ever sees their own
 * data. HMAC-signed with the server's SESSION_SECRET; can't be forged.
 */

import crypto from 'node:crypto';

export const PORTAL_COOKIE = 'r72_portal';
export const PORTAL_LOGIN_CSRF_COOKIE = 'r72_login_csrf';
export const PORTAL_SETUP_COOKIE = 'r72_account_setup';
export const PORTAL_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
export const PORTAL_SETUP_TTL_SECONDS = 10 * 60;
export const PORTAL_SETUP_CLOCK_SKEW_MS = 60 * 1000;
const PORTAL_SESSION_CONTEXT = 'relaunch72/session/portal/v1\u0000';
const PORTAL_CSRF_CONTEXT = 'relaunch72/csrf/portal/v1\u0000';
const PORTAL_LOGIN_CSRF_CONTEXT = 'relaunch72/csrf/portal-login/v1\u0000';
const PORTAL_SETUP_COOKIE_KEY_CONTEXT = 'relaunch72/key/portal-setup-cookie/v1\u0000';
const PORTAL_SETUP_COOKIE_AAD = Buffer.from('relaunch72/session/portal-setup/v2\u0000');
const PORTAL_SETUP_CSRF_CONTEXT = 'relaunch72/csrf/portal-setup/v1\u0000';
const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

interface LoginAttempt {
  failures: number;
  pending: number;
  windowStartedAt: number;
  blockedUntil: number;
}

/**
 * A small process-local guard against password spraying. It deliberately lives
 * behind an interface in PortalDeps so a shared Redis/database limiter can
 * replace it when the portal runs on more than one server instance.
 */
export class InMemoryLoginThrottle {
  private readonly attempts = new Map<string, LoginAttempt>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly blockMs = 15 * 60 * 1000,
    private readonly maxEntries = 10_000,
    private readonly evictUnexpiredAtCapacity = true,
  ) {}

  check(key: string, now: number): { allowed: boolean; retryAfterSeconds: number } {
    const attempt = this.attempts.get(key);
    if (!attempt) return { allowed: true, retryAfterSeconds: 0 };
    if (attempt.blockedUntil > now) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((attempt.blockedUntil - now) / 1000)) };
    }
    if (now - attempt.windowStartedAt >= this.windowMs && attempt.pending === 0) {
      this.attempts.delete(key);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (attempt.failures + attempt.pending >= this.maxFailures) {
      return { allowed: false, retryAfterSeconds: 1 };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Atomically reserve one bounded password-verification slot. */
  reserve(key: string, now: number): { allowed: boolean; retryAfterSeconds: number } {
    const status = this.check(key, now);
    if (!status.allowed) return status;
    let attempt = this.attempts.get(key);
    if (!attempt) {
      if (this.attempts.size >= this.maxEntries) this.evict(now);
      if (this.attempts.size >= this.maxEntries) {
        return { allowed: false, retryAfterSeconds: 1 };
      }
      attempt = { failures: 0, pending: 0, windowStartedAt: now, blockedUntil: 0 };
      this.attempts.set(key, attempt);
    }
    attempt.pending += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Release a reservation when verification could not produce an auth result. */
  release(key: string): void {
    const attempt = this.attempts.get(key);
    if (!attempt) return;
    attempt.pending = Math.max(0, attempt.pending - 1);
    if (attempt.pending === 0 && attempt.failures === 0 && attempt.blockedUntil === 0) {
      this.attempts.delete(key);
    }
  }

  private evict(now: number): void {
    for (const [candidate, value] of this.attempts) {
      if (value.pending === 0 && value.blockedUntil <= now && now - value.windowStartedAt >= this.windowMs) {
        this.attempts.delete(candidate);
      }
    }
    // Never evict an in-flight reservation; if every entry is live, reserve()
    // will keep the existing hard bound by declining to create another key.
    if (this.evictUnexpiredAtCapacity) {
      for (const [candidate, value] of this.attempts) {
        if (this.attempts.size < this.maxEntries) break;
        if (value.pending === 0) this.attempts.delete(candidate);
      }
    }
  }

  failure(key: string, now: number): void {
    let attempt = this.attempts.get(key);
    if (!attempt || (now - attempt.windowStartedAt >= this.windowMs && attempt.pending === 0)) {
      if (!attempt && this.attempts.size >= this.maxEntries) this.evict(now);
      if (!attempt && this.attempts.size >= this.maxEntries) return;
      attempt = { failures: 0, pending: 0, windowStartedAt: now, blockedUntil: 0 };
      this.attempts.set(key, attempt);
    }
    attempt.pending = Math.max(0, attempt.pending - 1);
    attempt.failures += 1;
    if (attempt.failures >= this.maxFailures) attempt.blockedUntil = now + this.blockMs;

  }

  success(key: string): void {
    const attempt = this.attempts.get(key);
    if (!attempt) return;
    attempt.pending = Math.max(0, attempt.pending - 1);
    attempt.failures = 0;
    attempt.blockedUntil = 0;
    if (attempt.pending === 0) this.attempts.delete(key);
  }
}

/**
 * Setup attempts use their own bounded identifier table. Idle fingerprints
 * are evicted at capacity so random invalid tokens cannot fill the table and
 * lock every legitimate setup link; in-flight reservations are never evicted.
 */
export class InMemorySetupThrottle extends InMemoryLoginThrottle {
  constructor(
    maxFailures = 5,
    windowMs = 15 * 60 * 1000,
    blockMs = 15 * 60 * 1000,
    maxEntries = 10_000,
  ) {
    super(maxFailures, windowMs, blockMs, maxEntries, true);
  }
}

/** Constant-time password check (hash both sides to a fixed length first). */
export function passwordOk(provided: string, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Sign `<payload>.<hmac>`; payload carries the tenant id + expiry. */
export function signTenant(secret: string, tenantId: string, now: number, ttlMs = PORTAL_TTL_MS): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, aud: 'portal', tid: tenantId, exp: now + ttlMs })).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(PORTAL_SESSION_CONTEXT).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

/** Return the tenant id iff the token verifies and hasn't expired, else null. */
export function verifyTenant(secret: string, token: string | undefined, now: number): string | null {
  if (!token || !secret) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(PORTAL_SESSION_CONTEXT).update(payload).digest('base64url');
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expected);
  if (macBuf.length !== expBuf.length || !crypto.timingSafeEqual(macBuf, expBuf)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const keys = Object.keys(parsed).sort().join(',');
    if (keys === 'aud,exp,tid,v'
      && parsed.v === 1
      && parsed.aud === 'portal'
      && typeof parsed.exp === 'number'
      && Number.isFinite(parsed.exp)
      && parsed.exp > now
      && typeof parsed.tid === 'string'
      && parsed.tid.length > 0
      && parsed.tid.length <= 256) return parsed.tid;
    return null;
  } catch {
    return null;
  }
}

/** Bind a synchronizer token to one signed portal session without exposing it in the cookie. */
export function portalCsrfToken(secret: string, sessionToken: string): string {
  if (!secret || !sessionToken) return '';
  return crypto.createHmac('sha256', secret)
    .update(PORTAL_CSRF_CONTEXT)
    .update(sessionToken)
    .digest('base64url');
}

export function verifyPortalCsrf(secret: string, sessionToken: string, supplied: string | undefined): boolean {
  if (!supplied) return false;
  const expected = portalCsrfToken(secret, sessionToken);
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
}

/** Signed double-submit token for the pre-authentication login form. */
export function portalLoginCsrfToken(secret: string): string {
  if (!secret) return '';
  const nonce = crypto.randomBytes(32).toString('base64url');
  const mac = crypto.createHmac('sha256', secret)
    .update(PORTAL_LOGIN_CSRF_CONTEXT)
    .update(nonce)
    .digest('base64url');
  return `${nonce}.${mac}`;
}

export function verifyPortalLoginCsrf(
  secret: string,
  cookieToken: string | undefined,
  supplied: string | undefined,
): boolean {
  if (!secret || !cookieToken || !supplied || cookieToken.length !== supplied.length) return false;
  const cookieBuffer = Buffer.from(cookieToken);
  const suppliedBuffer = Buffer.from(supplied);
  if (!crypto.timingSafeEqual(cookieBuffer, suppliedBuffer)) return false;
  const [nonce, mac, extra] = cookieToken.split('.');
  if (extra !== undefined || !nonce || !mac
      || !BASE64URL_32_PATTERN.test(nonce) || !BASE64URL_32_PATTERN.test(mac)) return false;
  const expected = crypto.createHmac('sha256', secret)
    .update(PORTAL_LOGIN_CSRF_CONTEXT)
    .update(nonce)
    .digest('base64url');
  const actualMac = Buffer.from(mac);
  const expectedMac = Buffer.from(expected);
  return actualMac.length === expectedMac.length && crypto.timingSafeEqual(actualMac, expectedMac);
}

/** A native setup capability is exactly 256 random bits encoded base64url. */
export function isPortalSetupToken(value: string): boolean {
  return BASE64URL_32_PATTERN.test(value);
}

function portalSetupCookieKey(secret: string): Buffer {
  return crypto.createHmac('sha256', secret)
    .update(PORTAL_SETUP_COOKIE_KEY_CONTEXT)
    .digest();
}

function canonicalBase64url(value: string, expectedLength?: number): Buffer | null {
  if (!value || !BASE64URL_PATTERN.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value
      || (expectedLength !== undefined && decoded.length !== expectedLength)) return null;
  return decoded;
}

/** Decrypt and enforce the authenticated ten-minute setup-cookie expiry. */
export function verifyPortalSetupCookie(
  secret: string,
  cookieValue: string | undefined,
  now = Date.now(),
): string | null {
  if (!secret || !cookieValue || !Number.isFinite(now)) return null;
  const [nonceText, ciphertextText, tagText, extra] = cookieValue.split('.');
  if (extra !== undefined || !nonceText || !ciphertextText || !tagText) return null;
  const nonce = canonicalBase64url(nonceText, 12);
  const ciphertext = canonicalBase64url(ciphertextText);
  const tag = canonicalBase64url(tagText, 16);
  if (!nonce || !ciphertext || !tag || ciphertext.length > 512) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', portalSetupCookieKey(secret), nonce);
    decipher.setAAD(PORTAL_SETUP_COOKIE_AAD);
    decipher.setAuthTag(tag);
    const cleartext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(cleartext) as Record<string, unknown>;
    if (Object.keys(parsed).sort().join(',') !== 'aud,exp,iat,token,v'
        || parsed.v !== 1
        || parsed.aud !== 'portal-setup'
        || typeof parsed.iat !== 'number'
        || !Number.isSafeInteger(parsed.iat)
        || typeof parsed.exp !== 'number'
        || !Number.isSafeInteger(parsed.exp)
        || parsed.exp - parsed.iat !== PORTAL_SETUP_TTL_SECONDS * 1000
        || parsed.iat > now + PORTAL_SETUP_CLOCK_SKEW_MS
        || parsed.exp <= now
        || typeof parsed.token !== 'string'
        || !isPortalSetupToken(parsed.token)) return null;
    return parsed.token;
  } catch {
    return null;
  }
}

/** Synchronizer token bound to the authenticated encrypted setup-cookie value. */
export function portalSetupCsrfToken(secret: string, cookieValue: string, now = Date.now()): string {
  if (!verifyPortalSetupCookie(secret, cookieValue, now)) return '';
  return crypto.createHmac('sha256', secret)
    .update(PORTAL_SETUP_CSRF_CONTEXT)
    .update(cookieValue)
    .digest('base64url');
}

export function verifyPortalSetupCsrf(
  secret: string,
  cookieValue: string | undefined,
  supplied: string | undefined,
  now = Date.now(),
): boolean {
  if (!cookieValue || !supplied || !BASE64URL_32_PATTERN.test(supplied)) return false;
  const expected = portalSetupCsrfToken(secret, cookieValue, now);
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return expectedBuffer.length > 0
    && suppliedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
}

export function portalSetupCookie(
  secret: string,
  setupToken: string,
  secure: boolean,
  now = Date.now(),
): string {
  if (!secret || !isPortalSetupToken(setupToken) || !Number.isSafeInteger(now)) {
    throw new Error('Portal setup cookie requires a valid setup token and clock');
  }
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', portalSetupCookieKey(secret), nonce);
  cipher.setAAD(PORTAL_SETUP_COOKIE_AAD);
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    aud: 'portal-setup',
    token: setupToken,
    iat: now,
    exp: now + PORTAL_SETUP_TTL_SECONDS * 1000,
  }));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const value = [nonce, ciphertext, cipher.getAuthTag()]
    .map((part) => part.toString('base64url'))
    .join('.');
  const bits = [
    `${PORTAL_SETUP_COOKIE}=${value}`,
    'HttpOnly',
    // Email clients are a cross-site top-level navigation. Lax permits the
    // clean 303 GET while still withholding this cookie on cross-site POSTs.
    'SameSite=Lax',
    'Path=/portal/setup',
    `Max-Age=${PORTAL_SETUP_TTL_SECONDS}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearPortalSetupCookie(secure: boolean): string {
  const bits = [
    `${PORTAL_SETUP_COOKIE}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/portal/setup',
    'Max-Age=0',
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function portalLoginCsrfCookie(token: string, secure: boolean): string {
  const bits = [
    `${PORTAL_LOGIN_CSRF_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/portal/login',
    'Max-Age=600',
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
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
