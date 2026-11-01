import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { CENTRAL_CONTENT_COOKIE, CENTRAL_CONTENT_LOGIN_CSRF_COOKIE, CENTRAL_CONTENT_ORIGIN, centralContentOrigin, createCentralContentMount } from '../src/portal/central-content-mount.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { MARTIN_HOWARD_PROPERTY_PROFILE, PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
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
  portal.auth.completeSetup = async () => identity;
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
  assert.equal(page.headers['referrer-policy'], 'same-origin');
  assert.match(page.body, /<meta name="referrer" content="same-origin">/);
  assert.match(page.body, /action-feedback\.js" defer/);
  const cookie = page.headers['set-cookie']!;
  assert.match(cookie, /__Host-r72_content_login_csrf=/); assert.match(cookie, /Secure/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /Path=\//); assert.doesNotMatch(cookie, /Domain=/i);
  assert.match(page.body, /Relaunch72/i); assert.doesNotMatch(page.body, /sso\/property-predator/);
  const token = /__Host-r72_content_login_csrf=([^;]+)/.exec(cookie)![1]!;
  const body = new URLSearchParams({ email: identity.userEmail, password: 'a-test-password', _login_csrf: token }).toString();
  assert.equal((await call(f, 'POST', '/portal/login', { origin: 'https://propertypredator.com', cookie: `${CENTRAL_CONTENT_LOGIN_CSRF_COOKIE}=${token}` }, body)).code, 403);
  assert.equal((await call(f, 'POST', '/portal/login', { origin: 'null', cookie: `${CENTRAL_CONTENT_LOGIN_CSRF_COOKIE}=${token}` }, body)).code, 403);
  assert.equal((await call(f, 'POST', '/portal/login', { cookie: `${CENTRAL_CONTENT_LOGIN_CSRF_COOKIE}=${token}` }, body)).code, 403);
  assert.equal((await call(f, 'POST', '/portal/login', { origin: CENTRAL_CONTENT_ORIGIN, 'sec-fetch-site': 'cross-site', cookie: `${CENTRAL_CONTENT_LOGIN_CSRF_COOKIE}=${token}` }, body)).code, 403);
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

function formPolicy(response: Awaited<ReturnType<typeof call>>, policy: 'same-origin' | 'no-referrer') {
  assert.equal(response.headers['referrer-policy'], policy);
  assert.ok(response.body.includes(`<meta name="referrer" content="${policy}">`));
  assert.equal(response.body.includes('id="central-action-feedback"'), policy === 'same-origin');
}
const setupToken = Buffer.alloc(32, 47).toString('base64url');
async function setupForm(f: ReturnType<typeof fixture>) {
  const redirect = await call(f, 'GET', `/portal/setup?token=${setupToken}`);
  assert.equal(redirect.code, 303); assert.equal(redirect.headers['referrer-policy'], 'no-referrer');
  const cookie = redirect.headers['set-cookie']!.split(';', 1)[0]!;
  const page = await call(f, 'GET', '/portal/setup', { cookie });
  assert.equal(page.code, 200);
  const csrf = /name="_setup_csrf" value="([^"]+)"/.exec(page.body)![1]!;
  return { page, cookie, csrf };
}
test('central login retry keeps matching same-origin header and meta', async () => {
  const f = fixture(); f.portal.auth.login = async () => null;
  const page = await call(f, 'GET', '/portal/login');
  const token = /__Host-r72_content_login_csrf=([^;]+)/.exec(page.headers['set-cookie']!)![1]!;
  const retry = await call(f, 'POST', '/portal/login', { origin: CENTRAL_CONTENT_ORIGIN, cookie: `${CENTRAL_CONTENT_LOGIN_CSRF_COOKIE}=${token}` },
    new URLSearchParams({ _login_csrf: token, email: identity.userEmail, password: 'fixture-password' }).toString());
  assert.equal(retry.code, 401); formPolicy(retry, 'same-origin');
});
test('central clean setup and validation/service retry forms retain same-origin; token redirect stays private', async () => {
  const f = fixture(); const { page, cookie, csrf } = await setupForm(f); formPolicy(page, 'same-origin');
  const post = (password: string, confirm = password) => call(f, 'POST', '/portal/setup', { origin: CENTRAL_CONTENT_ORIGIN, cookie },
    new URLSearchParams({ _setup_csrf: csrf, password, confirm }).toString());
  const short = await post('short'); assert.equal(short.code, 400); formPolicy(short, 'same-origin');
  const mismatch = await post('fixture-password-one', 'fixture-password-two'); assert.equal(mismatch.code, 400); formPolicy(mismatch, 'same-origin');
  f.portal.auth.completeSetup = async () => { throw new Error('synthetic unavailable'); };
  const unavailable = await post('fixture-password-one'); assert.equal(unavailable.code, 503); formPolicy(unavailable, 'same-origin');
  assert.equal((await call(f, 'POST', '/portal/setup', { origin: 'null', cookie })).code, 403);
  assert.equal((await call(f, 'POST', '/portal/setup', { origin: 'https://attacker.example', cookie })).code, 403);
});
test('default PP and MHP native login/setup retain no-referrer in header and HTML', async () => {
  for (const profile of [PROPERTY_PREDATOR_GROWTH_PROFILE, MARTIN_HOWARD_PROPERTY_PROFILE]) {
    const f = fixture();
    f.mount.handle = (req, res) => handlePortal(req, res, { ...f.portal, productProfile: profile });
    formPolicy(await call(f, 'GET', '/portal/login'), 'no-referrer');
    formPolicy((await setupForm(f)).page, 'no-referrer');
  }
});
