import test from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession } from '../src/server/admin/session.js';
import {
  portalCsrfToken,
  portalLoginCsrfCookie,
  portalLoginCsrfToken,
  signTenant,
  verifyPortalCsrf,
  verifyPortalLoginCsrf,
  verifyTenant,
} from '../src/portal/session.js';

test('admin and portal session tokens are cryptographically domain-separated', () => {
  const secret = 'one-shared-secret-is-still-safe-with-domain-separation';
  const now = 1_000_000;
  const admin = signSession(secret, now);
  const portal = signTenant(secret, 'tenant-1', now);

  assert.equal(verifySession(secret, admin, now + 1), true);
  assert.equal(verifyTenant(secret, portal, now + 1), 'tenant-1');
  assert.equal(verifySession(secret, portal, now + 1), false, 'a customer token can never become an admin token');
  assert.equal(verifyTenant(secret, admin, now + 1), null, 'an admin token is not a tenant identity');
});

test('pre-authentication login CSRF uses a signed double-submit token and strict cookie', () => {
  const secret = 'login-csrf-domain-secret';
  const token = portalLoginCsrfToken(secret);
  assert.match(token, /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(verifyPortalLoginCsrf(secret, token, token), true);
  assert.equal(verifyPortalLoginCsrf('wrong-secret', token, token), false);
  assert.equal(verifyPortalLoginCsrf(secret, token, `${token}x`), false);
  assert.equal(verifyPortalLoginCsrf(secret, undefined, token), false);
  const cookie = portalLoginCsrfCookie(token, true);
  assert.match(cookie, /HttpOnly; SameSite=Strict; Path=\/portal\/login; Max-Age=600; Secure$/);
});

test('session payloads carry explicit version and audience claims', () => {
  const decode = (token: string): Record<string, unknown> => JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  assert.deepEqual(decode(signSession('secret', 1)), {
    v: 2,
    aud: 'admin',
    epoch: 0,
    exp: 1 + 12 * 60 * 60 * 1000,
  });
  assert.deepEqual(decode(signTenant('secret', 'tenant-1', 1)), { v: 1, aud: 'portal', tid: 'tenant-1', exp: 1 + 14 * 24 * 60 * 60 * 1000 });
});

test('portal CSRF tokens are session-bound and verified in constant-length form', () => {
  const secret = 'session-domain-secret';
  const firstSession = signTenant(secret, 'tenant-1', 1_000);
  const secondSession = signTenant(secret, 'tenant-2', 1_000);
  const token = portalCsrfToken(secret, firstSession);

  assert.ok(token.length >= 40);
  assert.equal(verifyPortalCsrf(secret, firstSession, token), true);
  assert.equal(verifyPortalCsrf(secret, secondSession, token), false);
  assert.equal(verifyPortalCsrf('wrong-secret', firstSession, token), false);
  assert.equal(verifyPortalCsrf(secret, firstSession, undefined), false);
  assert.equal(verifyPortalCsrf(secret, firstSession, `${token}x`), false);
});
