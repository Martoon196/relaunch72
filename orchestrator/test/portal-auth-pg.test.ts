import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Pool, QueryResult } from 'pg';
import { hashPassword } from '../src/portal/accounts.js';
import { PgPortalAuthService } from '../src/portal/auth-pg-service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const TENANT_ID = 'legacy-northstar';
const USER_EMAIL = 'owner@example.test';
const NOW = Date.parse('2026-08-24T10:00:00.000Z');

interface Call { sql: string; values?: readonly unknown[] }

function result<T extends Record<string, unknown>>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

function pool(handler: (call: Call) => QueryResult): Pick<Pool, 'query'> {
  return {
    query: (async (sql: string, values?: readonly unknown[]) => handler({ sql, values })) as Pool['query'],
  };
}

test('PostgreSQL portal resolution accepts only a 32-byte opaque token and sends only its hash', async () => {
  const calls: Call[] = [];
  const token = Buffer.alloc(32, 4).toString('base64url');
  const service = new PgPortalAuthService({
    readPool: pool((call) => {
      calls.push(call);
      return result([{ session_id: SESSION_ID, user_id: USER_ID, user_email: USER_EMAIL, selected_workspace_id: WORKSPACE_ID, legacy_tenant_key: TENANT_ID }]);
    }),
    commandPool: pool(() => result([])),
  });
  const resolved = await service.resolve(token, NOW);
  assert.equal(resolved?.legacyTenantId, TENANT_ID);
  assert.equal(resolved?.userEmail, USER_EMAIL);
  assert.equal(resolved?.sessionToken, token);
  assert.match(calls[0]!.sql, /resolve_portal_session/);
  assert.equal(Array.from(calls[0]!.values ?? []).some((value) => value === token), false);
  assert.deepEqual(calls[0]!.values, [createHash('sha256').update(token).digest()]);
  assert.equal(await service.resolve('signed.legacy.cookie', NOW), null);
  assert.equal(calls.length, 1, 'legacy-shaped tokens never reach PostgreSQL');
});

test('PostgreSQL portal resolution rejects padded legacy tenant bridges', async () => {
  const token = Buffer.alloc(32, 5).toString('base64url');
  const service = new PgPortalAuthService({
    readPool: pool(() => result([{
      session_id: SESSION_ID,
      user_id: USER_ID,
      user_email: USER_EMAIL,
      selected_workspace_id: WORKSPACE_ID,
      legacy_tenant_key: ` ${TENANT_ID}`,
    }])),
    commandPool: pool(() => result([])),
  });
  await assert.rejects(() => service.resolve(token, NOW), /invalid identity data/);
});

test('password login creates one opaque session bound to the compare-and-swap credential', async () => {
  const password = 'correct horse battery staple';
  const storedHash = await hashPassword(password);
  const calls: Call[] = [];
  const commandPool = pool((call) => {
    calls.push(call);
    if (call.sql.includes('login-credential')) {
      return result([{ user_id: USER_ID, user_email: USER_EMAIL, password_hash: storedHash, selected_workspace_id: WORKSPACE_ID, legacy_tenant_key: TENANT_ID }]);
    }
    if (call.sql.includes('create-session')) {
      return result([{
        session_id: SESSION_ID,
        user_id: USER_ID,
        user_email: USER_EMAIL,
        selected_workspace_id: WORKSPACE_ID,
        legacy_tenant_key: TENANT_ID,
        expires_at: new Date(NOW + 14 * 24 * 60 * 60 * 1000).toISOString(),
      }]);
    }
    throw new Error(`unexpected SQL: ${call.sql}`);
  });
  const service = new PgPortalAuthService({ readPool: pool(() => result([])), commandPool });
  const session = await service.login(' Owner@Example.Test ', password, {
    now: NOW, ipAddress: '127.0.0.1', userAgent: 'R72 test browser',
  });
  assert.match(session?.sessionToken ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.equal(session?.legacyTenantId, TENANT_ID);
  assert.equal(session?.userEmail, USER_EMAIL);
  assert.deepEqual(calls[0]!.values, ['owner@example.test']);
  const create = calls.find((call) => call.sql.includes('create-session'))!;
  assert.equal(create.values?.[0], USER_ID);
  assert.equal(create.values?.[1], WORKSPACE_ID);
  assert.equal(create.values?.[2], storedHash);
  assert.ok(Buffer.isBuffer(create.values?.[3]) && (create.values?.[3] as Buffer).length === 32);
  assert.ok(Buffer.isBuffer(create.values?.[4]) && (create.values?.[4] as Buffer).length === 32);
  assert.equal(Array.from(create.values ?? []).some((value) => value === session!.sessionToken), false, 'raw session token is never a SQL parameter');
});

test('unknown and wrong-password login never creates a session', async () => {
  const storedHash = await hashPassword('the-right-password');
  for (const credential of [undefined, {
    user_id: USER_ID, user_email: 'nobody@example.test', password_hash: storedHash, selected_workspace_id: WORKSPACE_ID, legacy_tenant_key: TENANT_ID,
  }]) {
    const calls: Call[] = [];
    const service = new PgPortalAuthService({
      readPool: pool(() => result([])),
      commandPool: pool((call) => {
        calls.push(call);
        if (call.sql.includes('login-credential')) return result(credential ? [credential] : []);
        throw new Error('session creation must not run');
      }),
    });
    assert.equal(await service.login('nobody@example.test', 'wrong-password', { now: NOW }), null);
    assert.equal(calls.some((call) => call.sql.includes('create-session')), false);
  }
});

test('legacy password upgrade must win its compare-and-swap before session issuance', async () => {
  const password = 'legacy-password';
  const legacyHash = createHash('sha256').update(password).digest('hex');
  const calls: Call[] = [];
  const service = new PgPortalAuthService({
    readPool: pool(() => result([])),
    commandPool: pool((call) => {
      calls.push(call);
      if (call.sql.includes('login-credential')) {
        return result([{ user_id: USER_ID, user_email: 'legacy@example.test', password_hash: legacyHash, selected_workspace_id: WORKSPACE_ID, legacy_tenant_key: TENANT_ID }]);
      }
      if (call.sql.includes('upgrade-password')) return result([{ upgraded: true }]);
      if (call.sql.includes('create-session')) {
        return result([{
          session_id: SESSION_ID, user_id: USER_ID, selected_workspace_id: WORKSPACE_ID,
          user_email: 'legacy@example.test', legacy_tenant_key: TENANT_ID,
          expires_at: new Date(NOW + 60_000).toISOString(),
        }]);
      }
      throw new Error(`unexpected SQL: ${call.sql}`);
    }),
  });
  assert.ok(await service.login('legacy@example.test', password, { now: NOW }));
  const upgrade = calls.find((call) => call.sql.includes('upgrade-password'))!;
  const replacement = upgrade.values?.[2];
  assert.equal(upgrade.values?.[1], legacyHash);
  assert.match(String(replacement), /^scrypt\$v1\$/);
  assert.equal(calls.find((call) => call.sql.includes('create-session'))!.values?.[2], replacement);
});

test('a password or membership race fails as invalid login and revocation hashes the cookie', async () => {
  const token = Buffer.alloc(32, 9).toString('base64url');
  const storedHash = await hashPassword('right-password');
  const calls: Call[] = [];
  const service = new PgPortalAuthService({
    readPool: pool(() => result([])),
    commandPool: pool((call) => {
      calls.push(call);
      if (call.sql.includes('login-credential')) {
        return result([{ user_id: USER_ID, user_email: USER_EMAIL, password_hash: storedHash, selected_workspace_id: WORKSPACE_ID, legacy_tenant_key: TENANT_ID }]);
      }
      if (call.sql.includes('create-session')) throw Object.assign(new Error('revoked'), { code: '42501' });
      if (call.sql.includes('revoke-session')) return result([{ revoked: true }]);
      throw new Error(`unexpected SQL: ${call.sql}`);
    }),
  });
  assert.equal(await service.login('owner@example.test', 'right-password', { now: NOW }), null);
  await service.revoke(token);
  const revoke = calls.find((call) => call.sql.includes('revoke-session'))!;
  assert.deepEqual(revoke.values, [createHash('sha256').update(token).digest()]);
});
