import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Pool, QueryResult } from 'pg';
import {
  hashPassword,
  PortalScryptCapacityError,
  PortalScryptLimiter,
  type PortalScryptWorkLimiter,
} from '../src/portal/accounts.js';
import { PgPortalAuthService } from '../src/portal/auth-pg-service.js';
import type {
  PortalAuthRequestContext,
  PortalExternalIdentityAssertion,
} from '../src/portal/auth-service.js';
import { portalAbuseHash } from '../src/portal/request-context.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const USER_EMAIL = 'owner@example.test';
const NOW = Date.parse('2026-08-24T10:00:00.000Z');
const RAW_SOURCE = '203.0.113.42';
const SOURCE_SECRET = 'portal-auth-source-test-secret-at-least-32-characters';
const SOURCE_HASH = portalAbuseHash(SOURCE_SECRET, 'source', RAW_SOURCE);
const ENUMERABLE_SOURCE_DIGEST = createHash('sha256').update(RAW_SOURCE).digest();

function authContext(
  over: Partial<PortalAuthRequestContext> = {},
): PortalAuthRequestContext {
  return { now: NOW, sourceHash: Buffer.from(SOURCE_HASH), ...over };
}

function externalAssertion(
  over: Partial<PortalExternalIdentityAssertion> = {},
): PortalExternalIdentityAssertion {
  return {
    issuer: 'https://propertypredator.com',
    subject: '44444444-4444-4444-8444-444444444444',
    email: 'martin.howard1984@gmail.com',
    emailVerified: true,
    issuedAt: new Date(NOW - 10_000).toISOString(),
    expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
    affiliate: {
      member: true,
      affiliateId: '55555555-5555-4555-8555-555555555555',
      code: 'founder_01',
      codeStatus: 'active',
    },
    attribution: {
      referrerAffiliateId: null,
      attachedAt: null,
    },
    ...over,
  };
}

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
      return result([{ session_id: SESSION_ID, user_id: USER_ID, user_email: USER_EMAIL, selected_workspace_id: WORKSPACE_ID }]);
    }),
    commandPool: pool(() => result([])),
  });
  const resolved = await service.resolve(token, NOW);
  assert.equal(resolved?.userId, USER_ID);
  assert.equal(resolved?.workspaceId, WORKSPACE_ID);
  assert.equal(resolved?.userEmail, USER_EMAIL);
  assert.equal(resolved?.sessionToken, token);
  assert.match(calls[0]!.sql, /resolve_portal_session/);
  assert.equal(Array.from(calls[0]!.values ?? []).some((value) => value === token), false);
  assert.deepEqual(calls[0]!.values, [createHash('sha256').update(token).digest()]);
  assert.equal(await service.resolve('signed.legacy.cookie', NOW), null);
  assert.equal(calls.length, 1, 'legacy-shaped tokens never reach PostgreSQL');
});

test('PostgreSQL portal resolution rejects invalid canonical identity data', async () => {
  const token = Buffer.alloc(32, 5).toString('base64url');
  const service = new PgPortalAuthService({
    readPool: pool(() => result([{
      session_id: SESSION_ID,
      user_id: USER_ID,
      user_email: USER_EMAIL,
      selected_workspace_id: 'not-a-workspace-uuid',
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
      return result([{ user_id: USER_ID, user_email: USER_EMAIL, password_hash: storedHash, selected_workspace_id: WORKSPACE_ID }]);
    }
    if (call.sql.includes('create-session')) {
      return result([{
        session_id: SESSION_ID,
        user_id: USER_ID,
        user_email: USER_EMAIL,
        selected_workspace_id: WORKSPACE_ID,
        expires_at: new Date(NOW + 14 * 24 * 60 * 60 * 1000).toISOString(),
      }]);
    }
    throw new Error(`unexpected SQL: ${call.sql}`);
  });
  const service = new PgPortalAuthService({ readPool: pool(() => result([])), commandPool });
  const session = await service.login(
    ' Owner@Example.Test ',
    password,
    authContext({ userAgent: 'R72 test browser' }),
  );
  assert.match(session?.sessionToken ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.equal(session?.userId, USER_ID);
  assert.equal(session?.workspaceId, WORKSPACE_ID);
  assert.equal(session?.userEmail, USER_EMAIL);
  assert.deepEqual(calls[0]!.values, ['owner@example.test']);
  const create = calls.find((call) => call.sql.includes('create-session'))!;
  assert.equal(create.values?.[0], USER_ID);
  assert.equal(create.values?.[1], WORKSPACE_ID);
  assert.equal(create.values?.[2], storedHash);
  assert.ok(Buffer.isBuffer(create.values?.[3]) && (create.values?.[3] as Buffer).length === 32);
  assert.ok(Buffer.isBuffer(create.values?.[4]) && (create.values?.[4] as Buffer).length === 32);
  assert.deepEqual(create.values?.[5], SOURCE_HASH);
  assert.equal(create.values?.includes(RAW_SOURCE), false);
  assert.equal(create.values?.some((value) => Buffer.isBuffer(value)
    && value.equals(ENUMERABLE_SOURCE_DIGEST)), false, 'an enumerable plain IP digest never enters SQL');
  assert.equal(Array.from(create.values ?? []).some((value) => value === session!.sessionToken), false, 'raw session token is never a SQL parameter');
});

test('unknown and wrong-password login never creates a session', async () => {
  const storedHash = await hashPassword('the-right-password');
  for (const credential of [undefined, {
    user_id: USER_ID, user_email: 'nobody@example.test', password_hash: storedHash, selected_workspace_id: WORKSPACE_ID,
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
    assert.equal(await service.login('nobody@example.test', 'wrong-password', authContext()), null);
    assert.equal(calls.some((call) => call.sql.includes('create-session')), false);
  }
});

test('PostgreSQL login rejects legacy password hashes without upgrade or session issuance', async () => {
  const password = 'legacy-password';
  const legacyHash = createHash('sha256').update(password).digest('hex');
  const calls: Call[] = [];
  const service = new PgPortalAuthService({
    readPool: pool(() => result([])),
    commandPool: pool((call) => {
      calls.push(call);
      if (call.sql.includes('login-credential')) {
        return result([{ user_id: USER_ID, user_email: 'legacy@example.test', password_hash: legacyHash, selected_workspace_id: WORKSPACE_ID }]);
      }
      throw new Error(`unexpected SQL: ${call.sql}`);
    }),
  });
  assert.equal(await service.login('legacy@example.test', password, authContext()), null);
  assert.equal(calls.some((call) => call.sql.includes('upgrade-password')), false);
  assert.equal(calls.some((call) => call.sql.includes('create-session')), false);
});

test('account setup atomically consumes a hashed one-use token and returns a canonical session', async () => {
  const setupToken = Buffer.alloc(32, 7).toString('base64url');
  const password = 'a-new-canonical-password';
  const calls: Call[] = [];
  let reservations = 0;
  const service = new PgPortalAuthService({
    readPool: pool(() => result([])),
    commandPool: pool((call) => {
      calls.push(call);
      if (call.sql.includes('reserve-setup')) {
        reservations += 1;
        return reservations === 1
          ? result([{ claim_expires_at: new Date(NOW + 2 * 60 * 1000).toISOString() }])
          : result([]);
      }
      if (call.sql.includes('complete-setup')) {
        return result([{
          session_id: SESSION_ID,
          user_id: USER_ID,
          user_email: USER_EMAIL,
          selected_workspace_id: WORKSPACE_ID,
          expires_at: new Date(NOW + 14 * 24 * 60 * 60 * 1000).toISOString(),
        }]);
      }
      throw new Error(`unexpected SQL: ${call.sql}`);
    }),
  });

  const completed = await service.completeSetup(
    setupToken,
    password,
    authContext({ userAgent: 'R72 setup browser' }),
  );
  assert.equal(completed?.userId, USER_ID);
  assert.equal(completed?.workspaceId, WORKSPACE_ID);
  assert.equal(completed?.userEmail, USER_EMAIL);
  assert.match(completed?.sessionToken ?? '', /^[A-Za-z0-9_-]{43}$/);

  const reserve = calls[0]!;
  const first = calls[1]!;
  assert.match(reserve.sql, /reserve_native_account_setup\(\$1, \$2, \$3\)/);
  assert.match(first.sql, /complete_native_account_setup\(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8\)/);
  assert.deepEqual(reserve.values?.[0], createHash('sha256').update(setupToken).digest());
  assert.ok(Buffer.isBuffer(reserve.values?.[1]) && (reserve.values?.[1] as Buffer).length === 32);
  assert.deepEqual(reserve.values?.[2], SOURCE_HASH);
  assert.deepEqual(first.values?.slice(0, 3), reserve.values);
  assert.match(String(first.values?.[3]), /^scrypt\$v1\$/);
  assert.ok(Buffer.isBuffer(first.values?.[4]) && (first.values?.[4] as Buffer).length === 32);
  assert.ok(Buffer.isBuffer(first.values?.[5]) && (first.values?.[5] as Buffer).length === 32);
  assert.deepEqual(first.values?.[6], SOURCE_HASH);
  assert.deepEqual(first.values?.[7], createHash('sha256').update('R72 setup browser').digest());
  assert.equal(first.values?.includes(RAW_SOURCE), false);
  assert.equal(first.values?.some((value) => Buffer.isBuffer(value)
    && value.equals(ENUMERABLE_SOURCE_DIGEST)), false, 'setup never persists an enumerable plain IP digest');
  assert.equal(Array.from(first.values ?? []).includes(setupToken), false, 'raw setup token is never a SQL parameter');
  assert.equal(Array.from(first.values ?? []).includes(password), false, 'raw password is never a SQL parameter');
  assert.equal(Array.from(first.values ?? []).includes(completed!.sessionToken), false, 'raw session token is never a SQL parameter');
  assert.equal(calls.some((call) => call.sql.includes('release-setup')), false, 'atomic success consumed its own claim');

  assert.equal(await service.completeSetup(setupToken, 'a-second-canonical-password', authContext()), null);
  assert.equal(calls.length, 3, 'a consumed token stops at cheap reservation without another scrypt/completion');
});

test('invalid account setup input never reaches PostgreSQL', async () => {
  let calls = 0;
  const service = new PgPortalAuthService({
    readPool: pool(() => result([])),
    commandPool: pool(() => { calls += 1; return result([]); }),
  });
  assert.equal(await service.completeSetup('not-a-token', 'a-valid-long-password', { now: NOW }), null);
  assert.equal(await service.completeSetup(Buffer.alloc(32, 8).toString('base64url'), 'too-short', { now: NOW }), null);
  assert.equal(calls, 0);
});

test('valid database authentication writes fail closed without 32-byte keyed source evidence', async () => {
  let calls = 0;
  const service = new PgPortalAuthService({
    readPool: pool(() => result([])),
    commandPool: pool(() => { calls += 1; return result([]); }),
  });
  const setupToken = Buffer.alloc(32, 18).toString('base64url');
  await assert.rejects(
    service.completeSetup(setupToken, 'a-valid-canonical-password', { now: NOW }),
    /source evidence is unavailable/,
  );
  await assert.rejects(
    service.completeSetup(setupToken, 'a-valid-canonical-password', {
      now: NOW,
      sourceHash: Buffer.alloc(31),
    }),
    /source evidence is unavailable/,
  );
  await assert.rejects(
    service.loginExternal(externalAssertion(), { now: NOW }, USER_ID),
    /source evidence is unavailable/,
  );
  assert.equal(calls, 0, 'missing or malformed keyed source evidence is rejected before SQL');
});

test('a random valid-shape setup token stops at cheap reservation and never enters scrypt', async () => {
  let scryptRuns = 0;
  const limiter: PortalScryptWorkLimiter = {
    async run<T>(work: () => Promise<T>): Promise<T> {
      scryptRuns += 1;
      return work();
    },
  };
  const calls: Call[] = [];
  const service = new PgPortalAuthService({
    readPool: pool(() => result([])),
    commandPool: pool((call) => { calls.push(call); return result([]); }),
    scryptLimiter: limiter,
  });
  const randomToken = Buffer.alloc(32, 77).toString('base64url');
  assert.equal(await service.completeSetup(randomToken, 'a-valid-canonical-password', authContext()), null);
  assert.equal(scryptRuns, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /reserve_native_account_setup/);
  assert.equal(calls[0]!.values?.some((value) => value === randomToken), false);
  assert.deepEqual(calls[0]!.values?.[2], SOURCE_HASH);
});

test('setup releases its database claim when the process-wide scrypt scheduler is saturated', async () => {
  const limiter = new PortalScryptLimiter(1);
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => { openGate = resolve; });
  const occupied = limiter.run(async () => gate);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const calls: Call[] = [];
  const service = new PgPortalAuthService({
    readPool: pool(() => result([])),
    commandPool: pool((call) => {
      calls.push(call);
      if (call.sql.includes('reserve-setup')) {
        return result([{ claim_expires_at: new Date(NOW + 2 * 60 * 1000).toISOString() }]);
      }
      if (call.sql.includes('release-setup')) return result([{ released: true }]);
      throw new Error(`unexpected SQL: ${call.sql}`);
    }),
    scryptLimiter: limiter,
  });
  await assert.rejects(
    service.completeSetup(Buffer.alloc(32, 78).toString('base64url'), 'a-valid-canonical-password', authContext()),
    PortalScryptCapacityError,
  );
  assert.deepEqual(calls.map((call) => /portal\.auth\.([a-z-]+)/.exec(call.sql)?.[1]), ['reserve-setup', 'release-setup']);
  assert.deepEqual(calls[1]!.values, calls[0]!.values, 'release is bound to the exact token, claim and source hashes');
  openGate();
  await occupied;
});

test('setup releases a valid claim after a zero-row completion race or SQL error', async () => {
  for (const completion of ['zero-row', 'error'] as const) {
    const calls: Call[] = [];
    const service = new PgPortalAuthService({
      readPool: pool(() => result([])),
      commandPool: pool((call) => {
        calls.push(call);
        if (call.sql.includes('reserve-setup')) {
          return result([{ claim_expires_at: new Date(NOW + 2 * 60 * 1000).toISOString() }]);
        }
        if (call.sql.includes('complete-setup')) {
          if (completion === 'error') throw new Error('completion unavailable');
          return result([]);
        }
        if (call.sql.includes('release-setup')) return result([{ released: true }]);
        throw new Error(`unexpected SQL: ${call.sql}`);
      }),
    });
    const operation = service.completeSetup(
      Buffer.alloc(32, completion === 'zero-row' ? 79 : 80).toString('base64url'),
      'a-valid-canonical-password',
      authContext(),
    );
    if (completion === 'error') await assert.rejects(operation, /completion unavailable/);
    else assert.equal(await operation, null);
    assert.deepEqual(
      calls.map((call) => /portal\.auth\.([a-z-]+)/.exec(call.sql)?.[1]),
      ['reserve-setup', 'complete-setup', 'release-setup'],
    );
    assert.deepEqual(calls[2]!.values, calls[0]!.values);
  }
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
        return result([{ user_id: USER_ID, user_email: USER_EMAIL, password_hash: storedHash, selected_workspace_id: WORKSPACE_ID }]);
      }
      if (call.sql.includes('create-session')) throw Object.assign(new Error('revoked'), { code: '42501' });
      if (call.sql.includes('revoke-session')) return result([{ revoked: true }]);
      throw new Error(`unexpected SQL: ${call.sql}`);
    }),
  });
  assert.equal(await service.login('owner@example.test', 'right-password', authContext()), null);
  await service.revoke(token);
  const revoke = calls.find((call) => call.sql.includes('revoke-session'))!;
  assert.deepEqual(revoke.values, [createHash('sha256').update(token).digest()]);
});

test('verified Property Predator identity creates the same opaque HQ session without changing canonical email', async () => {
  const calls: Call[] = [];
  const service = new PgPortalAuthService({
    readPool: pool(() => result([])),
    commandPool: pool((call) => {
      calls.push(call);
      return result([{
        session_id: SESSION_ID,
        user_id: USER_ID,
        // The founder's canonical HQ contact email intentionally differs from
        // the verified main-site Google identity used for the one-time link.
        user_email: 'office@propertypredator.com',
        selected_workspace_id: WORKSPACE_ID,
        expires_at: new Date(NOW + 24 * 60 * 60 * 1000).toISOString(),
      }]);
    }),
  });
  const assertion = externalAssertion();
  const authenticated = await service.loginExternal(
    assertion,
    authContext({ userAgent: 'Growth HQ test browser' }),
    USER_ID,
  );
  assert.equal(authenticated?.userEmail, 'office@propertypredator.com');
  assert.equal(authenticated?.userId, USER_ID);
  assert.equal(authenticated?.workspaceId, WORKSPACE_ID);
  assert.match(authenticated?.sessionToken ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /create_portal_external_identity_session/);
  assert.deepEqual(calls[0]!.values?.slice(0, 11), [
    assertion.issuer,
    assertion.subject,
    assertion.email,
    true,
    USER_ID,
    true,
    assertion.affiliate.affiliateId,
    assertion.affiliate.code,
    assertion.affiliate.codeStatus,
    null,
    null,
  ]);
  assert.ok(Buffer.isBuffer(calls[0]!.values?.[11]) && (calls[0]!.values?.[11] as Buffer).length === 32);
  assert.ok(Buffer.isBuffer(calls[0]!.values?.[12]) && (calls[0]!.values?.[12] as Buffer).length === 32);
  assert.deepEqual(calls[0]!.values?.[13], SOURCE_HASH);
  assert.deepEqual(calls[0]!.values?.[14], createHash('sha256').update('Growth HQ test browser').digest());
  assert.equal(calls[0]!.values?.includes(RAW_SOURCE), false);
  assert.equal(calls[0]!.values?.some((value) => Buffer.isBuffer(value)
    && value.equals(ENUMERABLE_SOURCE_DIGEST)), false, 'external auth never persists an enumerable plain IP digest');
  assert.equal(calls[0]!.values?.includes(authenticated!.sessionToken), false, 'raw opaque session never enters SQL');
});

test('external login rejects any issuer, unverified email or incomplete affiliate identity before PostgreSQL', async () => {
  let calls = 0;
  const service = new PgPortalAuthService({
    readPool: pool(() => result([])),
    commandPool: pool(() => { calls += 1; return result([]); }),
  });
  assert.equal(await service.loginExternal(
    externalAssertion({ issuer: 'https://attacker.example' }),
    { now: NOW },
    USER_ID,
  ), null);
  assert.equal(await service.loginExternal(
    { ...externalAssertion(), emailVerified: false } as unknown as PortalExternalIdentityAssertion,
    { now: NOW },
    USER_ID,
  ), null);
  assert.equal(await service.loginExternal(
    externalAssertion({ affiliate: { member: true, affiliateId: null, code: null, codeStatus: null } }),
    { now: NOW },
    USER_ID,
  ), null);
  assert.equal(calls, 0);
});

test('external identity without an existing link or bootstrap membership creates no HQ session', async () => {
  const calls: Call[] = [];
  const service = new PgPortalAuthService({
    readPool: pool(() => result([])),
    commandPool: pool((call) => { calls.push(call); return result([]); }),
  });
  assert.equal(await service.loginExternal(externalAssertion({
    email: 'affiliate@example.test',
    affiliate: { member: false, affiliateId: null, code: null, codeStatus: null },
  }), authContext()), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.values?.[4], null, 'the assertion cannot choose a user or workspace');
});

test('external link/member race fails as an invalid sign-in', async () => {
  const service = new PgPortalAuthService({
    readPool: pool(() => result([])),
    commandPool: pool(() => { throw Object.assign(new Error('already linked'), { code: '42501' }); }),
  });
  assert.equal(await service.loginExternal(externalAssertion(), authContext(), USER_ID), null);
});
