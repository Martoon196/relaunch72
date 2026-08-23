import test from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession } from '../src/server/admin/session.js';
import { signTenant, verifyTenant } from '../src/portal/session.js';

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

test('session payloads carry explicit version and audience claims', () => {
  const decode = (token: string): Record<string, unknown> => JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  assert.deepEqual(decode(signSession('secret', 1)), { v: 1, aud: 'admin', exp: 1 + 12 * 60 * 60 * 1000 });
  assert.deepEqual(decode(signTenant('secret', 'tenant-1', 1)), { v: 1, aud: 'portal', tid: 'tenant-1', exp: 1 + 14 * 24 * 60 * 60 * 1000 });
});
