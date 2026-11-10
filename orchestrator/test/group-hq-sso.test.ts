/**
 * Group HQ → portal sign-in handoff: token format, verification, single use, and the
 * portal route on both brand hosts with a stub identity service. No database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  GROUP_HQ_HANDOFF_ROUTE, GROUP_HQ_HANDOFF_VERSION, GroupHqHandoff, loadGroupHqSsoConfig, signGroupHqHandoff, verifyGroupHqHandoff,
  type GroupHqHandoffClaims,
} from '../src/portal/group-hq-sso.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { createMhpMount } from '../src/mhp/mount.js';
import { MHP_MARKETING_WORKSPACE_ID } from '../src/mhp/marketing-workspace-service.js';
import { MARTIN_HOWARD_PROPERTY_PROFILE, PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import type { PortalDelegatedLogin } from '../src/portal/auth-service.js';

const SECRET = 'group-hq-shared-secret-synthetic-0123456789abcdef';
const NOW = Date.parse('2026-11-10T09:00:00Z');
const FOUNDER = 'founder@example.test';
const USER = '12400000-0000-4000-8000-00000000aa01';
const PP_WS = '12400000-0000-4000-8000-00000000aa02';
const PP_HOST = 'hq.propertypredator.com';
const MHP_HOST = 'app.martinhowardproperty.co.uk';
const env = { R72_GROUP_HQ_SSO_SECRET: SECRET, R72_GROUP_HQ_SSO_USERS: JSON.stringify({ [FOUNDER.toUpperCase()]: USER }), R72_GROUP_HQ_CRM_PP_WORKSPACE_ID: PP_WS };

function claims(over: Partial<GroupHqHandoffClaims> = {}): GroupHqHandoffClaims {
  const iat = Math.floor(NOW / 1000);
  return { v: GROUP_HQ_HANDOFF_VERSION, email: FOUNDER, brand: 'pp', host: PP_HOST, path: '/portal/webinars', iat, exp: iat + 90, nonce: 'n'.repeat(24), ...over };
}

test('configuration is off by default, strict when present, and lower-cases the allowlist', () => {
  assert.equal(loadGroupHqSsoConfig({}), undefined);
  assert.throws(() => loadGroupHqSsoConfig({ R72_GROUP_HQ_SSO_SECRET: 'short', R72_GROUP_HQ_SSO_USERS: '{}' }), /32–256/);
  assert.throws(() => loadGroupHqSsoConfig({ R72_GROUP_HQ_SSO_SECRET: SECRET, R72_GROUP_HQ_SSO_USERS: '[]' }), /JSON object/);
  assert.throws(() => loadGroupHqSsoConfig({ R72_GROUP_HQ_SSO_SECRET: SECRET, R72_GROUP_HQ_SSO_USERS: '{}' }), /1–20/);
  assert.throws(() => loadGroupHqSsoConfig({ R72_GROUP_HQ_SSO_SECRET: SECRET, R72_GROUP_HQ_SSO_USERS: JSON.stringify({ 'not-an-email': USER }) }), /invalid entry/);
  assert.throws(() => loadGroupHqSsoConfig({ R72_GROUP_HQ_SSO_SECRET: SECRET, R72_GROUP_HQ_SSO_USERS: JSON.stringify({ [FOUNDER]: 'not-a-uuid' }) }), /invalid entry/);
  const config = loadGroupHqSsoConfig(env)!;
  assert.equal(config.users.get(FOUNDER), USER);
  assert.equal(config.ppWorkspaceId, PP_WS);
  assert.equal(loadGroupHqSsoConfig({ ...env, R72_GROUP_HQ_CRM_PP_WORKSPACE_ID: '' })!.ppWorkspaceId, null);
});

test('tokens verify only with the secret, for the exact host, a portal path and within two minutes', () => {
  const token = signGroupHqHandoff(SECRET, claims());
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  const ok = verifyGroupHqHandoff(SECRET, token, { host: PP_HOST, nowMs: NOW });
  assert.deepEqual(ok, claims());
  assert.equal(verifyGroupHqHandoff(SECRET, token, { host: 'HQ.PropertyPredator.com', nowMs: NOW })?.email, FOUNDER, 'host comparison is case-insensitive');
  assert.equal(verifyGroupHqHandoff('x'.repeat(SECRET.length), token, { host: PP_HOST, nowMs: NOW }), null, 'wrong secret');
  const [body, mac] = token.split('.') as [string, string];
  assert.equal(verifyGroupHqHandoff(SECRET, `${body}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`, { host: PP_HOST, nowMs: NOW }), null, 'tampered signature');
  assert.equal(verifyGroupHqHandoff(SECRET, token, { host: MHP_HOST, nowMs: NOW }), null, 'bound to one host');
  assert.equal(verifyGroupHqHandoff(SECRET, token, { host: PP_HOST, nowMs: NOW + 91_000 }), null, 'expired');
  assert.equal(verifyGroupHqHandoff(SECRET, token, { host: PP_HOST, nowMs: NOW - 120_000 }), null, 'issued in the future');
  assert.equal(verifyGroupHqHandoff(SECRET, null, { host: PP_HOST, nowMs: NOW }), null);
  assert.equal(verifyGroupHqHandoff(SECRET, 'a.b', { host: PP_HOST, nowMs: NOW }), null);
  for (const bad of [
    claims({ exp: claims().iat + 121 }),
    claims({ path: 'https://evil.example/portal' }),
    claims({ path: '//evil.example/portal' }),
    claims({ path: '/portal//webinars' }),
    claims({ path: '/admin' }),
    claims({ email: 'not an email' }),
    claims({ brand: 'other' as 'pp' }),
    claims({ nonce: 'short' }),
    claims({ v: 'ghq-handoff-0' as typeof GROUP_HQ_HANDOFF_VERSION }),
  ]) {
    assert.equal(verifyGroupHqHandoff(SECRET, signGroupHqHandoff(SECRET, bad), { host: PP_HOST, nowMs: NOW }), null, JSON.stringify(bad));
  }
  const withQuery = claims({ path: '/portal/webinars/abc/host?tab=people' });
  assert.equal(verifyGroupHqHandoff(SECRET, signGroupHqHandoff(SECRET, withQuery), { host: PP_HOST, nowMs: NOW })?.path, withQuery.path);
});

test('the Group HQ Python signer produces byte-identical tokens (shared test vector)', () => {
  // Pinned in group-hq unit_checks/relaunch72_sso.py as well; both sides sign these exact claims.
  const vector = 'eyJ2IjoiZ2hxLWhhbmRvZmYtMSIsImVtYWlsIjoiZm91bmRlckBleGFtcGxlLnRlc3QiLCJicmFuZCI6Im1ocCIsImhvc3QiOiJhcHAubWFydGluaG93YXJkcHJvcGVydHkuY28udWsiLCJwYXRoIjoiL3BvcnRhbC93ZWJpbmFycyIsImlhdCI6MTc5NDMwMTIwMCwiZXhwIjoxNzk0MzAxMjkwLCJub25jZSI6Im5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubiJ9.cSgbazHxniiCnWLaQEm5KLOo2QtFlP5ApIgCMmTHO-k';
  const mhp = claims({ brand: 'mhp', host: MHP_HOST, path: '/portal/webinars', iat: 1794301200, exp: 1794301290 });
  assert.equal(signGroupHqHandoff(SECRET, mhp), vector);
  assert.deepEqual(verifyGroupHqHandoff(SECRET, vector, { host: MHP_HOST, nowMs: 1794301200_000 }), mhp);
});

test('the per-process verifier consumes each nonce once and maps brands to server-owned workspaces', () => {
  const handoff = new GroupHqHandoff(loadGroupHqSsoConfig(env)!, () => NOW);
  const token = signGroupHqHandoff(SECRET, claims());
  assert.equal(handoff.consume(token, PP_HOST)?.email, FOUNDER);
  assert.equal(handoff.consume(token, PP_HOST), null, 'second presentation is refused');
  assert.equal(handoff.consume(signGroupHqHandoff(SECRET, claims({ nonce: 'm'.repeat(24) })), PP_HOST)?.nonce, 'm'.repeat(24));
  assert.equal(handoff.userFor('Founder@Example.test'), USER);
  assert.equal(handoff.userFor('stranger@example.test'), null);
  assert.equal(handoff.workspaceFor('pp'), PP_WS);
  assert.equal(handoff.workspaceFor('mhp'), MHP_MARKETING_WORKSPACE_ID);
});

test('verified grant derives one opaque database token across instances and equivalent signature encodings', () => {
  const first = new GroupHqHandoff(loadGroupHqSsoConfig(env)!, () => NOW);
  const second = new GroupHqHandoff(loadGroupHqSsoConfig(env)!, () => NOW);
  const token = signGroupHqHandoff(SECRET, claims());
  const verified = first.consume(token, PP_HOST)!;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alias = token.slice(0, -1) + alphabet[alphabet.indexOf(token.at(-1)!) + 1];
  const reverified = second.consume(alias, PP_HOST)!;
  assert.ok(reverified, 'non-canonical base64 padding bits decode to the same verified MAC');
  assert.match(first.sessionTokenFor(verified), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.sessionTokenFor(verified), second.sessionTokenFor(reverified), 'shared database uniqueness covers both presentations');
  assert.notEqual(first.sessionTokenFor(verified), first.sessionTokenFor(claims({ nonce: 'fresh-nonce-for-next-grant' })));
});

interface Captured { status: number; body: string; headers: Record<string, string | string[]> }

function fakeRequest(method: string, url: string, host: string, headers: Record<string, string> = {}): IncomingMessage {
  return Object.assign(Readable.from([Buffer.alloc(0)]), { method, url, headers: { host, 'user-agent': 'synthetic', ...headers }, socket: { remoteAddress: '203.0.113.9' } }) as unknown as IncomingMessage;
}

function fakeResponse(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: '', headers: {} };
  const res = {
    headersSent: false,
    writeHead(status: number, headers: Record<string, string | string[]> = {}) { captured.status = status; Object.assign(captured.headers, headers); (this as { headersSent: boolean }).headersSent = true; },
    setHeader(key: string, value: string) { captured.headers[key.toLowerCase()] = value; },
    end(body = '') { captured.body = String(body); },
  } as unknown as ServerResponse;
  return { res, captured };
}

function portalDeps(host: 'pp' | 'mhp', handoff: GroupHqHandoff | undefined, delegated: (input: PortalDelegatedLogin) => Promise<{ userId: string; workspaceId: string } | null>): PostgresPortalDeps {
  const calls: PortalDelegatedLogin[] = [];
  const deps: PostgresPortalDeps = {
    kind: 'postgres', secure: true, sessionSecret: 'synthetic-session-secret-at-least-32-characters-long', now: () => NOW,
    productProfile: host === 'pp' ? PROPERTY_PREDATOR_GROWTH_PROFILE : MARTIN_HOWARD_PROPERTY_PROFILE,
    portalBaseUrl: `https://${host === 'pp' ? PP_HOST : MHP_HOST}`,
    ...(host === 'mhp' ? { sessionCookieName: '__Host-mhp_session' as const } : {}),
    groupHqSso: handoff,
    auth: {
      resolve: async () => null, login: async () => null, revoke: async () => {},
      loginDelegated: async (input) => {
        calls.push(input);
        const r = await delegated(input);
        return r ? { sessionToken: Buffer.alloc(32, 9).toString('base64url'), userId: r.userId, workspaceId: r.workspaceId, userEmail: FOUNDER, expiresAt: new Date(NOW + 12 * 3_600_000).toISOString() } : null;
      },
    },
    abuseHashSecret: 'synthetic-abuse-hash-secret-at-least-32-chars!!',
    requestContext: () => ({ requestId: '12400000-0000-4000-8000-00000000aa99', requestHash: Buffer.alloc(32, 1), sourceHash: Buffer.alloc(32, 2), clientAddress: '203.0.113.9' }),
    abuse: { admit: async () => ({ allowed: true, leaseHash: Buffer.alloc(32, 1), retryAfterSeconds: 0 }), complete: async () => {}, assertReady: async () => {}, close: async () => {} },
    crm: {} as PostgresPortalDeps['crm'], financeDrafts: {} as PostgresPortalDeps['financeDrafts'],
  };
  return Object.assign(deps, { calls });
}

test('the Property Predator host turns a valid handoff into its own session cookie and refuses everything else neutrally', async () => {
  const handoff = new GroupHqHandoff(loadGroupHqSsoConfig(env)!, () => NOW);
  const deps = portalDeps('pp', handoff, async (input) => input.userId === USER && input.workspaceId === PP_WS ? input : null) as PostgresPortalDeps & { calls: PortalDelegatedLogin[] };
  const run = async (method: string, query: string, host = PP_HOST) => {
    const { res, captured } = fakeResponse();
    await handlePortal(fakeRequest(method, `${GROUP_HQ_HANDOFF_ROUTE}${query}`, host), res, deps);
    return captured;
  };
  const token = signGroupHqHandoff(SECRET, claims({ path: '/portal/webinars/abc/host' }));
  const ok = await run('GET', `?t=${encodeURIComponent(token)}`);
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.location, '/portal/webinars/abc/host');
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.equal(ok.headers['referrer-policy'], 'no-referrer');
  const cookies = ([] as string[]).concat(ok.headers['set-cookie'] ?? []);
  assert.equal(cookies.length, 1);
  assert.match(cookies[0]!, /^r72_portal=[A-Za-z0-9_-]{43}; /);
  assert.match(cookies[0]!, /HttpOnly/);
  assert.match(cookies[0]!, /Max-Age=43200/);
  assert.deepEqual(deps.calls, [{ userId: USER, workspaceId: PP_WS, handoffSessionToken: handoff.sessionTokenFor(claims({ path: '/portal/webinars/abc/host' })) }]);

  const replay = await run('GET', `?t=${encodeURIComponent(token)}`);
  assert.equal(replay.status, 401, 'a token is single use');
  assert.match(replay.body, /could not complete that sign-in from Group HQ/);
  assert.doesNotMatch(replay.body, new RegExp(FOUNDER), 'the login page never echoes the asserted email');
  assert.equal(deps.calls.length, 1);

  const mhpOnPp = await run('GET', `?t=${encodeURIComponent(signGroupHqHandoff(SECRET, claims({ brand: 'mhp', nonce: 'b'.repeat(24) })))}`);
  assert.equal(mhpOnPp.status, 401, 'an MHP token cannot sign in to the PP host');
  assert.equal(deps.calls.length, 1);

  const stranger = await run('GET', `?t=${encodeURIComponent(signGroupHqHandoff(SECRET, claims({ email: 'stranger@example.test', nonce: 'c'.repeat(24) })))}`);
  assert.equal(stranger.status, 401, 'a valid token for an email outside the allowlist is refused');
  assert.equal(deps.calls.length, 1);

  const refusedByDb = portalDeps('pp', new GroupHqHandoff(loadGroupHqSsoConfig(env)!, () => NOW), async () => null);
  const { res, captured } = fakeResponse();
  await handlePortal(fakeRequest('GET', `${GROUP_HQ_HANDOFF_ROUTE}?t=${encodeURIComponent(signGroupHqHandoff(SECRET, claims({ nonce: 'd'.repeat(24) })))}`, PP_HOST), res, refusedByDb);
  assert.equal(captured.status, 401, 'the database refusing ownership is the same neutral answer');

  assert.equal((await run('POST', `?t=${encodeURIComponent(token)}`)).status, 405);
  assert.equal((await run('GET', '')).status, 400);
  assert.equal((await run('GET', `?t=${encodeURIComponent(token)}&next=/portal`)).status, 400, 'only t is accepted');
  assert.equal((await run('GET', `?t=${encodeURIComponent(signGroupHqHandoff(SECRET, claims({ nonce: 'e'.repeat(24) })))}`, 'evil.example')).status, 401, 'another Host header fails verification');

  const off = portalDeps('pp', undefined, async () => null);
  const offRes = fakeResponse();
  await handlePortal(fakeRequest('GET', `${GROUP_HQ_HANDOFF_ROUTE}?t=x.y`, PP_HOST), offRes.res, off);
  assert.equal(offRes.captured.status, 404);
  assert.match(offRes.captured.body, /not available on this deployment/);
});

test('the MHP host accepts only MHP tokens, sets its host-only cookie and now serves the webinar pages', async () => {
  const handoff = new GroupHqHandoff(loadGroupHqSsoConfig(env)!, () => NOW);
  const portal = portalDeps('mhp', handoff, async (input) => input.workspaceId === MHP_MARKETING_WORKSPACE_ID ? input : null) as PostgresPortalDeps & { calls: PortalDelegatedLogin[] };
  const mount = createMhpMount({
    portal, authMount: { handle: async () => false }, readiness: async () => [],
    hq: { isOwner: async () => true, snapshot: async () => ({ people: [], products: [], grants: [] }), grant: async () => '12400000-0000-4000-8000-00000000aa03' },
    commerce: { billingEnabled: false, snapshot: async () => { throw new Error('excluded'); }, refund: async () => {}, billingPortal: async () => '', webhook: async () => {} },
  } as unknown as Parameters<typeof createMhpMount>[0]);
  const run = async (method: string, url: string, host = MHP_HOST) => {
    const { res, captured } = fakeResponse();
    await mount.handle(fakeRequest(method, url, host), res);
    return captured;
  };
  const token = signGroupHqHandoff(SECRET, claims({ brand: 'mhp', host: MHP_HOST, path: '/portal/webinars' }));
  const ok = await run('GET', `${GROUP_HQ_HANDOFF_ROUTE}?t=${encodeURIComponent(token)}`);
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.location, '/portal/webinars');
  const cookie = ([] as string[]).concat(ok.headers['set-cookie'] ?? []).join('\n');
  assert.match(cookie, /^__Host-mhp_session=[A-Za-z0-9_-]{43}; /);
  assert.match(cookie, /Secure/);
  assert.deepEqual(portal.calls, [{ userId: USER, workspaceId: MHP_MARKETING_WORKSPACE_ID, handoffSessionToken: handoff.sessionTokenFor(claims({ brand: 'mhp', host: MHP_HOST, path: '/portal/webinars' })) }]);

  const ppOnMhp = await run('GET', `${GROUP_HQ_HANDOFF_ROUTE}?t=${encodeURIComponent(signGroupHqHandoff(SECRET, claims({ host: MHP_HOST, nonce: 'f'.repeat(24) })))}`);
  assert.equal(ppOnMhp.status, 401, 'a PP token cannot sign in to the MHP host');
  assert.equal(portal.calls.length, 1);

  const webinars = await run('GET', '/portal/webinars');
  assert.notEqual(webinars.status, 404, 'the MHP host routes /portal/webinars into the portal instead of dropping it');
  assert.equal((await run('GET', '/portal/webinars', 'other.example')).status, 421, 'the host check still comes first');
});
