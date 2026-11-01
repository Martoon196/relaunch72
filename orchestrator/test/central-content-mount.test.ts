import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { CENTRAL_CONTENT_COOKIE, CENTRAL_CONTENT_LOGIN_CSRF_COOKIE, CENTRAL_CONTENT_ORIGIN, centralContentOrigin, createCentralContentMount } from '../src/portal/central-content-mount.js';
import type { PostgresPortalDeps } from '../src/portal/router.js';
import { portalLoginCsrfToken } from '../src/portal/session.js';

const identity = { sessionToken: 'native-central-session', userId: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222', userEmail: 'owner@example.com' };
function fixture(manages = true) {
  let delegated = 0; let logins = 0;
  const revoked: string[] = [];
  const portal = {
    kind: 'postgres', sessionSecret: 'central-content-test-secret-at-least-32-characters', secure: true,
    auth: { resolve: async (token: string) => token === identity.sessionToken ? identity : null,
      login: async () => { logins++; return identity; }, revoke: async (token: string) => { revoked.push(token); } },
    seoBlog: { forSession: () => { delegated++; throw new Error('test delegation'); } },
    companyContent: {}, requestContext: () => ({ requestId: 'test-request', requestHash: Buffer.alloc(32) }),
  } as unknown as PostgresPortalDeps;
  const mount = createCentralContentMount({ origin: CENTRAL_CONTENT_ORIGIN, portal, authorize: async () => manages });
  return { mount, portal, revoked, counts: () => ({ delegated, logins }) };
}
async function call(f: ReturnType<typeof fixture>, method: string, url: string, headers: Record<string, string> = {}, body?: string) {
  const req = Object.assign(new EventEmitter(), { method, url, headers: { host: 'app.relaunch72.com', ...headers }, socket: {} });
  setImmediate(() => { if (body) req.emit('data', Buffer.from(body)); req.emit('end'); });
  const res = { code: 0, headers: {} as Record<string, string>, body: '',
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; },
    writeHead(code: number, values: Record<string, string | string[]> = {}) { this.code = code; for (const [k,v] of Object.entries(values)) this.headers[k.toLowerCase()] = Array.isArray(v) ? v.join('\n') : v; return this; },
    end(body = '') { this.body = body; } };
  await f.mount.handle(req as never, res as never); return res;
}
test('central origin is explicit and disabled configuration is inert', () => {
  assert.equal(centralContentOrigin({}), null);
  assert.equal(centralContentOrigin({ R72_CONTENT_ENABLED: 'false', R72_CONTENT_ORIGIN: 'https://attacker.example' }), null);
  assert.throws(() => centralContentOrigin({ R72_CONTENT_ENABLED: 'true', R72_CONTENT_ORIGIN: 'https://attacker.example' }));
  assert.equal(centralContentOrigin({ R72_CONTENT_ENABLED: 'true', R72_CONTENT_ORIGIN: CENTRAL_CONTENT_ORIGIN }), CENTRAL_CONTENT_ORIGIN);
});
test('central host ignores forwarded authority and terminates unknown payment/PP/MHP paths', async () => {
  const f = fixture();
  for (const host of ['app.relaunch72.com:443', 'app.relaunch72.com.attacker.example', 'growth-hq.propertypredator.com']) {
    assert.equal((await call(f, 'GET', '/portal', { host, 'x-forwarded-host': 'app.relaunch72.com', forwarded: 'host=app.relaunch72.com' })).code, 421);
  }
  for (const path of ['/checkout', '/api/create-checkout-session', '/portal/crm', '/portal/sso/property-predator', '/mhp']) assert.equal((await call(f, 'GET', path)).code, 404);
  assert.equal((await call(f, 'GET', '/')).headers.location, '/portal/seo-blog');
  assert.deepEqual(f.counts(), { delegated: 0, logins: 0 });
});
test('central login has host-only secure cookies and separate CSRF; cross-site requests do not authenticate', async () => {
  const f = fixture();
  const page = await call(f, 'GET', '/portal/login');
  assert.equal(page.code, 200);
  const cookie = page.headers['set-cookie']!;
  assert.match(cookie, /__Host-r72_content_login_csrf=/); assert.match(cookie, /Secure/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /Path=\//); assert.doesNotMatch(cookie, /Domain=/i);
  assert.match(page.body, /Relaunch72/i); assert.doesNotMatch(page.body, /sso\/property-predator/);
  const token = /__Host-r72_content_login_csrf=([^;]+)/.exec(cookie)![1]!;
  const body = new URLSearchParams({ email: identity.userEmail, password: 'a-test-password', _login_csrf: token }).toString();
  assert.equal((await call(f, 'POST', '/portal/login', { origin: 'https://propertypredator.com', cookie: `${CENTRAL_CONTENT_LOGIN_CSRF_COOKIE}=${token}` }, body)).code, 403);
  assert.equal(f.counts().logins, 0);
  const ppToken = portalLoginCsrfToken(f.portal.sessionSecret);
  assert.equal((await call(f, 'POST', '/portal/login', { origin: CENTRAL_CONTENT_ORIGIN, cookie: `r72_login_csrf=${ppToken}` }, new URLSearchParams({ email: identity.userEmail, password: 'a-test-password', _login_csrf: ppToken }).toString())).code, 403);
  const login = await call(f, 'POST', '/portal/login', { origin: CENTRAL_CONTENT_ORIGIN, cookie: `${CENTRAL_CONTENT_LOGIN_CSRF_COOKIE}=${token}` }, body);
  assert.equal(login.code, 302); assert.equal(login.headers.location, '/portal');
  for (const part of ['__Host-r72_content=native-central-session;', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(login.headers['set-cookie']!.includes(part));
  assert.doesNotMatch(login.headers['set-cookie']!, /Domain=/i);
});
test('non-managing session cannot reach early SEO delegation or establish a central login', async () => {
  const f = fixture(false);
  const denied = await call(f, 'GET', '/portal/seo-blog', { cookie: `${CENTRAL_CONTENT_COOKIE}=${identity.sessionToken}` });
  assert.equal(denied.code, 403); assert.equal(f.counts().delegated, 0);
  const page = await call(f, 'GET', '/portal/login');
  const token = /__Host-r72_content_login_csrf=([^;]+)/.exec(page.headers['set-cookie']!)![1]!;
  const login = await call(f, 'POST', '/portal/login', { origin: CENTRAL_CONTENT_ORIGIN, cookie: `${CENTRAL_CONTENT_LOGIN_CSRF_COOKIE}=${token}` }, new URLSearchParams({ email: identity.userEmail, password: 'a-test-password', _login_csrf: token }).toString());
  assert.equal(login.code, 401); assert.deepEqual(f.revoked, [identity.sessionToken]);
});
