import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool, QueryResult } from 'pg';
import { PgMhpAuthService, MHP_AUTH_ORIGIN, MHP_AUTH_HOST, type MhpAuthService } from '../src/mhp/auth-service.js';
import { createMhpAuthMount, type MhpAuthMountDeps } from '../src/mhp/auth-router.js';
import { createMhpTransactionalMailer } from '../src/mhp/transactional-mail.js';
import { hashPassword } from '../src/portal/accounts.js';
import { portalCsrfToken } from '../src/portal/session.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const SECRET = 'isolated-mhp-auth-test-secret-at-least-32-characters';
const TOKEN = Buffer.alloc(32, 15).toString('base64url');
const CONTEXT = { now: NOW, sourceHash: Buffer.alloc(32, 22) };
const ROW = { session_id: 'a1111111-1111-4111-8111-111111111111', user_id: 'a2222222-2222-4222-8222-222222222222',
  selected_workspace_id: 'a3333333-3333-4333-8333-333333333333', user_email: 'member@example.invalid', expires_at: new Date(NOW + 86_400_000).toISOString() };
const SESSION = { sessionToken: TOKEN, userId: ROW.user_id, workspaceId: ROW.selected_workspace_id, userEmail: ROW.user_email, expiresAt: ROW.expires_at };
type Call = { sql: string; values: readonly unknown[] };
const result = (rows: Record<string, unknown>[]): QueryResult => ({ rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] });
function pool(handler: (call: Call) => QueryResult | Promise<QueryResult>): Pick<Pool, 'query'> {
  return { query: (async (sql: string, values: readonly unknown[] = []) => handler({ sql, values })) as Pool['query'] };
}
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

test('MHP auth resolves only audience-specific SQL and never sends the opaque token to storage', async () => {
  const calls: Call[] = [];
  const service = new PgMhpAuthService({ readPool: pool(call => { calls.push(call); return result([ROW]); }), commandPool: pool(() => result([])) });
  assert.equal((await service.resolve(TOKEN, NOW))?.userId, ROW.user_id);
  assert.match(calls[0]!.sql, /resolve_mhp_session/);
  assert.deepEqual(calls[0]!.values, [digest(TOKEN)]);
  assert.equal(await service.resolve('copied.signed.legacy.cookie', NOW), null);
  assert.equal(calls.length, 1);
});

test('MHP link issuance normalizes email and returns a fixed-host URL only after SQL eligibility', async () => {
  const calls: Call[] = [];
  let eligible = false;
  const service = new PgMhpAuthService({ readPool: pool(() => result([])), commandPool: pool(call => { calls.push(call); return result([{ issued: eligible }]); }) });
  assert.equal(await service.requestLink('unknown@example.invalid', 'magic', CONTEXT), null);
  eligible = true;
  const link = await service.requestLink(' MEMBER@EXAMPLE.INVALID ', 'reset', CONTEXT);
  assert.equal(link?.email, ROW.user_email);
  const url = new URL(link!.url);
  assert.equal(url.origin, MHP_AUTH_ORIGIN);
  assert.equal(url.searchParams.get('purpose'), 'reset');
  const call = calls[1]!;
  assert.equal(call.values[0], ROW.user_email);
  assert.deepEqual(call.values[2], digest(url.searchParams.get('token')!));
  assert.equal(call.values.some(value => value === url.searchParams.get('token')), false);
});

test('MHP password login binds session to rechecked credential, performs dummy work for unknown account, and refuses bad source', async () => {
  const password = 'valid-test-password-123'; const stored = await hashPassword(password); const calls: Call[] = [];
  const service = new PgMhpAuthService({ readPool: pool(() => result([])), commandPool: pool(call => {
    calls.push(call);
    return call.sql.includes('mhp_login_credential') ? result([{ user_id: ROW.user_id, user_email: ROW.user_email, password_hash: stored }]) : result([ROW]);
  }) });
  assert.equal(await service.login(ROW.user_email, 'wrong-password', CONTEXT), null);
  assert.equal(calls.length, 1);
  const session = await service.login(ROW.user_email, password, CONTEXT);
  assert.equal(session?.userId, ROW.user_id);
  assert.deepEqual(calls[2]!.values[2], digest(session!.sessionToken));
  assert.equal(calls[2]!.values[1], stored);
  await assert.rejects(service.login(ROW.user_email, password, { now: NOW }), /source evidence/);
});

test('MHP reset hashes the password, sends only proof hashes, rejects token replay response and malformed session expiry', async () => {
  const calls: Call[] = []; let issued = true;
  const service = new PgMhpAuthService({ readPool: pool(() => result([])), commandPool: pool(call => { calls.push(call); return result(issued ? [ROW] : []); }) });
  assert.equal(await service.consumeLink(TOKEN, 'reset', 'short', CONTEXT), null);
  assert.equal(calls.length, 0);
  const session = await service.consumeLink(TOKEN, 'reset', 'new-long-test-password', CONTEXT);
  assert.equal(session?.userId, ROW.user_id);
  assert.match(String(calls[0]!.values[2]), /^scrypt\$v1\$/);
  assert.equal(calls[0]!.values.includes('new-long-test-password'), false);
  assert.deepEqual(calls[0]!.values[0], digest(TOKEN));
  issued = false;
  assert.equal(await service.consumeLink(TOKEN, 'magic', undefined, CONTEXT), null);
  const bad = new PgMhpAuthService({ readPool: pool(() => result([])), commandPool: pool(() => result([{ ...ROW, expires_at: new Date(NOW + 20 * 86_400_000).toISOString() }])) });
  await assert.rejects(bad.consumeLink(TOKEN, 'magic', undefined, CONTEXT), /expiry/);
});

function request(method: string, url: string, data = '', headers: Record<string, string> = {}): IncomingMessage {
  return Object.assign(Readable.from(data ? [Buffer.from(data)] : []), { method, url,
    headers: { host: MHP_AUTH_HOST, origin: MHP_AUTH_ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...headers } }) as IncomingMessage;
}
function response(): ServerResponse & { body: string; headers: Record<string, string | string[]> } {
  const out = { statusCode: 200, body: '', headers: {} as Record<string, string | string[]>, headersSent: false,
    setHeader(key: string, value: string | string[]) { this.headers[key.toLowerCase()] = value; return this; },
    writeHead(code: number, values: Record<string, string> = {}) { this.statusCode = code; this.headersSent = true; Object.assign(this.headers, values); return this; },
    end(value = '') { this.body = value; return this; },
  };
  return out as unknown as ServerResponse & { body: string; headers: Record<string, string | string[]> };
}
function harness(overrides: Partial<MhpAuthMountDeps> = {}) {
  const calls: string[] = [];
  const auth: MhpAuthService = {
    resolve: async () => SESSION, login: async () => { calls.push('login'); return SESSION; },
    requestLink: async () => { calls.push('request'); return { email: ROW.user_email, url: `${MHP_AUTH_ORIGIN}/portal/auth/verify?purpose=magic&token=${TOKEN}` }; },
    consumeLink: async () => { calls.push('consume'); return SESSION; }, revoke: async () => { calls.push('revoke'); },
  };
  const deps: MhpAuthMountDeps = { auth, sessionSecret: SECRET, abuseHashSecret: SECRET, mail: { configured: true, sendAuthLink: async () => { calls.push('mail'); } },
    requestContext: () => ({ requestId: 'mhp-test', requestHash: Buffer.alloc(32, 24), sourceHash: CONTEXT.sourceHash }), now: () => NOW,
    abuse: { admit: async () => ({ allowed: true, retryAfterSeconds: 0, leaseHash: randomBytes(32) }), complete: async () => {}, assertReady: async () => {}, close: async () => {} }, ...overrides };
  const mount = createMhpAuthMount(deps);
  return { calls, deps, async run(method: string, path: string, form = '', headers: Record<string, string> = {}) {
    const res = response(); const handled = await mount.handle(request(method, path, form, headers), res, new URL(path, MHP_AUTH_ORIGIN)); return { res, handled };
  } };
}
function csrf(body: string): string { return body.match(/name="_auth_csrf" value="([^"]+)"/)?.[1] ?? ''; }
function cookieHeader(res: ReturnType<typeof response>): string { const values = res.headers['set-cookie']; return (Array.isArray(values) ? values : values ? [values] : []).map(value => value.split(';')[0]).join('; '); }

test('MHP sign-in page is branded, host-only, no-store and rejects PP setup/SSO', async () => {
  const h = harness(); const { res } = await h.run('GET', '/portal/login');
  assert.match(res.body, /MARTIN HOWARD/); assert.match(res.body, /#142019/); assert.match(res.body, /#e8a33d/);
  assert.equal(res.headers['cache-control'], 'no-store'); assert.equal(res.headers['referrer-policy'], 'no-referrer');
  const cookies = res.headers['set-cookie'] as string[];
  assert.ok(cookies.every(value => value.includes('Secure') && value.includes('HttpOnly') && !value.includes('Domain=')));
  assert.equal((await h.run('GET', '/portal/login', '', { host: 'hq.propertypredator.com' })).res.statusCode, 421);
  assert.equal((await h.run('GET', '/portal/setup')).res.statusCode, 404);
  assert.equal((await h.run('GET', '/portal/auth/property-predator/callback')).res.statusCode, 404);
});

test('MHP rejects cross-origin, missing CSRF, duplicate values, and missing trusted source before authentication', async () => {
  const h = harness(); const first = (await h.run('GET', '/portal/login')).res; const cookies = cookieHeader(first);
  const body = new URLSearchParams({ _auth_csrf: csrf(first.body), email: ROW.user_email, password: 'password' }).toString();
  assert.equal((await h.run('POST', '/portal/login', body, { cookie: cookies, origin: 'https://evil.invalid' })).res.statusCode, 403);
  assert.equal((await h.run('POST', '/portal/login', body)).res.statusCode, 403);
  assert.equal((await h.run('POST', '/portal/login', `${body}&email=other@example.invalid`, { cookie: cookies })).res.statusCode, 400);
  const expired = harness({ now: () => NOW + 16 * 60_000 });
  assert.equal((await expired.run('POST', '/portal/login', body, { cookie: cookies })).res.statusCode, 403);
  const missing = harness({ requestContext: () => null });
  assert.equal((await missing.run('POST', '/portal/login', body, { cookie: cookies })).res.statusCode, 503);
  assert.deepEqual(h.calls, []);
});

test('MHP password login sets only its host cookie and server-owned account redirect', async () => {
  const h = harness(); const first = (await h.run('GET', '/portal/login')).res;
  const body = new URLSearchParams({ _auth_csrf: csrf(first.body), email: ROW.user_email, password: 'password', next: 'https://evil.invalid' }).toString();
  const { res } = await h.run('POST', '/portal/login', body, { cookie: cookieHeader(first) });
  assert.equal(res.statusCode, 303); assert.equal(res.headers.location, '/app/account');
  assert.match((res.headers['set-cookie'] as string[])[0]!, /^__Host-mhp_session=/);
  assert.doesNotMatch((res.headers['set-cookie'] as string[]).join(' '), /r72_portal|Domain=/);
  assert.deepEqual(h.calls, ['login']);
});

test('Magic-link GET strips token without consuming it, explicit CSRF POST consumes, and sealed cookie expires', async () => {
  const h = harness(); const { res: received } = await h.run('GET', `/portal/auth/verify?token=${TOKEN}&purpose=magic`);
  assert.equal(received.statusCode, 303); assert.equal(received.headers.location, '/portal/auth/complete');
  assert.deepEqual(h.calls, []); assert.doesNotMatch(cookieHeader(received), new RegExp(TOKEN));
  const cookie = cookieHeader(received); const complete = (await h.run('GET', '/portal/auth/complete', '', { cookie })).res;
  assert.equal(complete.statusCode, 200); assert.doesNotMatch(complete.body, new RegExp(TOKEN));
  assert.equal((await h.run('POST', '/portal/auth/complete', new URLSearchParams({ _auth_csrf: csrf(complete.body) }).toString(), { cookie })).res.statusCode, 303);
  assert.deepEqual(h.calls, ['consume']);
  const expired = harness({ now: () => NOW + 16 * 60_000 });
  assert.equal((await expired.run('GET', '/portal/auth/complete', '', { cookie })).res.statusCode, 400);
  assert.equal((await h.run('GET', '/portal/auth/complete', '', { cookie: `${cookie}tampered` })).res.statusCode, 400);
});

test('Link requests hide unknown accounts and delivery failure; missing provider never queries eligibility', async () => {
  for (const mode of ['unknown', 'failed', 'success']) {
    const h = harness();
    if (mode === 'unknown') h.deps.auth.requestLink = async () => null;
    if (mode === 'failed') h.deps.mail.sendAuthLink = async () => { throw new Error('provider secret should not escape'); };
    const first = (await h.run('GET', '/portal/auth/magic')).res;
    const body = new URLSearchParams({ _auth_csrf: csrf(first.body), email: ROW.user_email }).toString();
    const { res } = await h.run('POST', '/portal/auth/magic', body, { cookie: cookieHeader(first) });
    assert.equal(res.statusCode, 200); assert.match(res.body, /If this email is linked to an eligible account/); assert.doesNotMatch(res.body, /provider secret/);
  }
  const missing = harness({ mail: { configured: false, sendAuthLink: async () => { throw new Error('must not send'); } } });
  const first = (await missing.run('GET', '/portal/auth/magic')).res;
  const body = new URLSearchParams({ _auth_csrf: csrf(first.body), email: ROW.user_email }).toString();
  assert.equal((await missing.run('POST', '/portal/auth/magic', body, { cookie: cookieHeader(first) })).res.statusCode, 503);
  assert.deepEqual(missing.calls, []);
});

test('MHP auth distributed limiter declines before password/mail work; logout requires session CSRF', async () => {
  const h = harness(); h.deps.abuse.admit = async () => ({ allowed: false, retryAfterSeconds: 120, leaseHash: null });
  assert.equal((await h.run('POST', '/portal/login', '')).res.statusCode, 429); assert.deepEqual(h.calls, []);
  const logout = harness();
  assert.equal((await logout.run('POST', '/portal/logout', '', { cookie: `__Host-mhp_session=${TOKEN}` })).res.statusCode, 403);
  const valid = new URLSearchParams({ _csrf: portalCsrfToken(SECRET, TOKEN) }).toString();
  const response = (await logout.run('POST', '/portal/logout', valid, { cookie: `__Host-mhp_session=${TOKEN}` })).res;
  assert.equal(response.statusCode, 303); assert.deepEqual(logout.calls, ['revoke']);
});

test('An eligible link request does not wait for the provider and expose mailbox eligibility through provider latency', async () => {
  let finish!: () => void;
  const delivery = new Promise<void>(resolve => { finish = resolve; });
  const h = harness({ mail: { configured: true, sendAuthLink: () => delivery } });
  const first = (await h.run('GET', '/portal/auth/magic')).res;
  const body = new URLSearchParams({ _auth_csrf: csrf(first.body), email: ROW.user_email }).toString();
  const { res } = await h.run('POST', '/portal/auth/magic', body, { cookie: cookieHeader(first) });
  assert.equal(res.statusCode, 200); finish(); await delivery;
});

test('Transactional MHP mail uses only scoped Brevo sender credentials and fixed endpoint', async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, options: RequestInit) => { calls.push({ url: String(url), options }); return new Response('{}', { status: 201 }); }) as typeof fetch;
  const unconfigured = createMhpTransactionalMailer({ BREVO_API_KEY: 'legacy-credential-must-not-be-used' }, fetcher);
  assert.equal(unconfigured.configured, false);
  const mailer = createMhpTransactionalMailer({ MHP_BREVO_API_KEY: 'test-provider-token', MHP_BREVO_SENDER_ID: '1' }, fetcher);
  await mailer.sendAuthLink(ROW.user_email, `${MHP_AUTH_ORIGIN}/portal/auth/verify?purpose=magic&token=${TOKEN}`, 'magic');
  assert.equal(calls[0]!.url, 'https://api.brevo.com/v3/smtp/email');
  const body = JSON.parse(String(calls[0]!.options.body)); assert.deepEqual(body.sender, { id: 1 }); assert.equal(body.to[0].email, ROW.user_email);
  assert.equal((calls[0]!.options.headers as Record<string, string>)['api-key'], 'test-provider-token');
  await assert.rejects(mailer.sendAuthLink(ROW.user_email, 'https://evil.invalid/portal/auth/verify', 'magic'), /Invalid/);
});

test('Transactional MHP Postmark disables tracking and redacts failures', async () => {
  const calls: RequestInit[] = [];
  const fetcher = (async (_url: unknown, options: RequestInit) => { calls.push(options); return new Response('sensitive provider error', { status: 400 }); }) as typeof fetch;
  const mailer = createMhpTransactionalMailer({ MHP_POSTMARK_SERVER_TOKEN: 'test-postmark-token', MHP_POSTMARK_FROM: 'verified@example.invalid' }, fetcher);
  await assert.rejects(mailer.sendAuthLink(ROW.user_email, `${MHP_AUTH_ORIGIN}/portal/auth/verify?purpose=reset&token=${TOKEN}`, 'reset'), error => error instanceof Error && error.message === 'MHP transactional delivery unavailable');
  const body = JSON.parse(String(calls[0]!.body)); assert.equal(body.TrackLinks, 'None'); assert.equal(body.TrackOpens, false);
});

test('Detached MHP mail has a hard in-flight cap and releases capacity after delivery', async () => {
  const releases: Array<(response: Response) => void> = [];
  const fetcher = (() => new Promise<Response>(resolve => releases.push(resolve))) as typeof fetch;
  const mailer = createMhpTransactionalMailer({ MHP_BREVO_API_KEY: 'test-provider-token' }, fetcher);
  const url = `${MHP_AUTH_ORIGIN}/portal/auth/verify?purpose=magic&token=${TOKEN}`;
  const pending = Array.from({ length: 8 }, () => mailer.sendAuthLink(ROW.user_email, url, 'magic'));
  await assert.rejects(mailer.sendAuthLink(ROW.user_email, url, 'magic'), /unavailable/);
  assert.equal(releases.length, 8, 'ninth call was not queued or dispatched');
  releases.forEach(resolve => resolve(new Response('{}', { status: 201 })));
  await Promise.all(pending);
  const after = mailer.sendAuthLink(ROW.user_email, url, 'magic');
  assert.equal(releases.length, 9); releases[8]!(new Response('{}', { status: 201 })); await after;
});
