import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ADMIN_LOGIN_CSRF_COOKIE,
  adminCsrfToken,
  parseCookies,
  passwordOk,
  SESSION_COOKIE,
  signSession,
  totpCode,
  verifySession,
  verifyTotp,
} from '../src/server/admin/session.js';
import { listRuns, getRunDetail, readDeliverable, listOrders } from '../src/server/admin/store.js';
import { handleAdmin } from '../src/server/admin/router.js';
import { InMemoryLoginThrottle, signTenant } from '../src/portal/session.js';
import type { StripeConfig } from '../src/server/config.js';

// Render injects the service's production proxy settings into its build
// environment. Unit tests that exercise the direct/local request boundary must
// supply their own environment explicitly so a cloud build cannot change the
// scenario under test.
const DIRECT_TEST_RUNTIME_ENV = Object.freeze({
  PORTAL_PROXY_MODE: 'direct',
  PORTAL_ABUSE_HASH_SECRET: 'r72-admin-direct-test-abuse-secret-v1',
}) as NodeJS.ProcessEnv;

function cfg(over: Partial<StripeConfig> = {}): StripeConfig {
  return {
    secretKey: 'sk_test_x', keyMode: 'test', webhookSecret: 'wh', priceIds: {}, planIds: {}, platformSubscriptionsEnabled: false, sandboxAccessToken: '', publicLeadCaptureEnabled: false, publicBaseUrl: 'https://relaunch72.test', host: '127.0.0.1', port: 0,
    liveMode: false, dataDir: os.tmpdir(), ordersFile: path.join(os.tmpdir(), `r72-adm-orders-${Math.round(performance.now())}.jsonl`),
    subscriptionsFile: path.join(os.tmpdir(), `r72-adm-subs-${Math.round(performance.now())}.jsonl`),
    allowedOrigins: [], adminPassword: 'hunter2', sessionSecret: 's3cr3t', ...over,
  };
}

function makeRuns(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r72-runs-'));
  // runA — parked at S3
  const a = path.join(dir, 'runA'); fs.mkdirSync(a);
  fs.writeFileSync(path.join(a, 'manifest.json'), JSON.stringify({
    run_id: 'runA', mode: 'live', through: 'S9', status: 'parked', created_at: '2026-07-07T09:00:00Z',
    stages: [{ stage: 'S3', status: 'parked', flags: ['failed twice'], attempts: [{ qa_issues: [{ check: 's3.differentiator_untraced', message: 'no quote' }] }] }],
    totals: { cost_usd: 0.4 },
  }));
  fs.writeFileSync(path.join(a, 'intake.json'), JSON.stringify({ A1: 'Beta Ltd' }));
  // runB — assembled, has a bundle + a deliverable
  const b = path.join(dir, 'runB'); fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, 'manifest.json'), JSON.stringify({
    run_id: 'runB', mode: 'live', through: 'S9', status: 'assembled', created_at: '2026-07-07T10:00:00Z', finished_at: '2026-07-07T10:20:00Z',
    stages: [{ stage: 'S1', status: 'passed', model: 'm', cost_usd: 0.2, output_file: 's1.json', attempts: [] }], totals: { cost_usd: 0.2 },
  }));
  fs.writeFileSync(path.join(b, 'bundle.json'), JSON.stringify({
    run_id: 'runB', business: 'Acme Joinery', mode: 'live', status: 'awaiting_signoff',
    deliverables: [{ stage: 'S1', name: 'Audit', file: 's1.json' }], qa: { stage_flags: {}, s10_issues: [] },
  }));
  fs.writeFileSync(path.join(b, 's1.json'), JSON.stringify({ positioning_statement: 'We fix bad wiring.', top_3_leaks: ['weak homepage', 'no reviews'] }));
  fs.writeFileSync(path.join(b, 'intake.json'), JSON.stringify({ A1: 'Acme Joinery' }));
  return dir;
}

function req(
  method: string,
  url: string,
  opts: {
    cookie?: string;
    body?: string;
    forwardedFor?: string;
    cfConnectingIp?: string;
    remoteAddress?: string;
  } = {},
): IncomingMessage {
  const r = Readable.from([Buffer.from(opts.body ?? '')]) as unknown as IncomingMessage;
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body) headers['content-type'] = 'application/x-www-form-urlencoded';
  if (opts.forwardedFor) headers['x-forwarded-for'] = opts.forwardedFor;
  if (opts.cfConnectingIp) headers['cf-connecting-ip'] = opts.cfConnectingIp;
  return Object.assign(r, {
    method,
    url,
    headers,
    socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
  });
}
function res(): ServerResponse & { statusCode: number; headers: Record<string, string>; body: string } {
  const r = { statusCode: 0, headers: {} as Record<string, string>, body: '', headersSent: false } as {
    statusCode: number; headers: Record<string, string>; body: string; headersSent: boolean;
    writeHead: (c: number, h?: Record<string, string>) => unknown; end: (b?: string) => unknown;
  };
  r.writeHead = (c, h) => { r.statusCode = c; if (h) Object.assign(r.headers, h); r.headersSent = true; return r; };
  r.end = (b) => { r.body = b ?? ''; return r; };
  return r as unknown as ServerResponse & { statusCode: number; headers: Record<string, string>; body: string };
}

async function adminLoginForm(
  c: StripeConfig,
  runsDir: string,
): Promise<{ csrf: string; cookie: string }> {
  const response = res();
  await handleAdmin(req('GET', '/admin/login'), response, c, runsDir);
  const csrf = response.body.match(/name="_csrf" value="([^"]+)"/)?.[1];
  const cookie = String(response.headers['set-cookie']).split(';', 1)[0];
  if (!csrf || !cookie) throw new Error('Admin login form did not issue its CSRF pair');
  assert.match(cookie, new RegExp(`^${ADMIN_LOGIN_CSRF_COOKIE}=`));
  return { csrf, cookie };
}

// ─── session ─────────────────────────────────────────────────────────────────
test('passwordOk is exact + constant-time-safe', () => {
  assert.equal(passwordOk('hunter2', 'hunter2'), true);
  assert.equal(passwordOk('hunter3', 'hunter2'), false);
  assert.equal(passwordOk('', 'hunter2'), false);
  assert.equal(passwordOk('x', ''), false);
});
test('signSession/verifySession: valid, tampered, expired', () => {
  const now = 1_000_000;
  const tok = signSession('secret', now);
  assert.equal(verifySession('secret', tok, now + 1000), true);
  assert.equal(verifySession('secret', tok + 'x', now + 1000), false); // tampered
  assert.equal(verifySession('wrong', tok, now + 1000), false);        // wrong secret
  assert.equal(verifySession('secret', tok, now + 1000 * 60 * 60 * 13), false); // expired (>12h)
});
test('parseCookies splits a header', () => {
  assert.deepEqual(parseCookies('a=1; r72_admin=tok'), { a: '1', r72_admin: 'tok' });
});

// ─── store ───────────────────────────────────────────────────────────────────
test('store reads runs, detail, deliverables, orders', () => {
  const dir = makeRuns();
  const runs = listRuns(dir);
  assert.equal(runs.length, 2);
  assert.equal(runs[0]!.id, 'runB'); // newest first
  const parked = runs.find((r) => r.id === 'runA')!;
  assert.equal(parked.status, 'parked');
  assert.equal(parked.parkedStage, 'S3');
  const detail = getRunDetail(dir, 'runB')!;
  assert.equal(detail.summary.business, 'Acme Joinery');
  assert.equal(detail.summary.hasBundle, true);
  const s1 = readDeliverable(dir, 'runB', 'S1') as { positioning_statement: string };
  assert.equal(s1.positioning_statement, 'We fix bad wiring.');
  assert.equal(readDeliverable(dir, 'runB', '../secret'), null); // traversal guard

  const of = path.join(os.tmpdir(), `r72-orders-${Math.round(performance.now())}.jsonl`);
  fs.writeFileSync(of, JSON.stringify({ session_id: 'cs_1', tier: 'core', status: 'paid_awaiting_intake' }) + '\n');
  assert.equal(listOrders(of)[0]!.tier, 'core');
});

// ─── router ──────────────────────────────────────────────────────────────────
test('admin disabled without a password', async () => {
  const r = res(); await handleAdmin(req('GET', '/admin'), r, cfg({ adminPassword: '' }), makeRuns());
  assert.equal(r.statusCode, 404);
});
test('unauthed /admin redirects to login; login page renders', async () => {
  const r = res(); await handleAdmin(req('GET', '/admin'), r, cfg(), makeRuns());
  assert.equal(r.statusCode, 302); assert.equal(r.headers.location, '/admin/login');
  const l = res(); await handleAdmin(req('GET', '/admin/login'), l, cfg(), makeRuns());
  assert.equal(l.statusCode, 200); assert.match(l.body, /Admin/);
  assert.equal(l.headers['cache-control'], 'no-store');
  assert.match(l.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/);
});
test('admin session epoch revokes every older cookie immediately', () => {
  const now = 1_000_000;
  const token = signSession('secret', now, 60_000, 7);
  assert.equal(verifySession('secret', token, now + 1, 7), true);
  assert.equal(verifySession('secret', token, now + 1, 8), false);
});
test('RFC 6238 TOTP uses the standard SHA-1 vector and a bounded drift window', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // ASCII 12345678901234567890
  assert.equal(totpCode(secret, 59_000), '287082');
  assert.equal(verifyTotp(secret, '287082', 59_000), true);
  assert.equal(verifyTotp(secret, '287082', 89_000), true);
  assert.equal(verifyTotp(secret, '287082', 119_000), false);
  assert.equal(verifyTotp(secret, 'not-six', 59_000), false);
});
test('a valid portal session copied into the admin cookie is rejected', async () => {
  const c = cfg();
  const customerToken = signTenant(c.sessionSecret, 'tenant-customer', Date.now());
  const r = res();
  await handleAdmin(req('GET', '/admin', { cookie: `${SESSION_COOKIE}=${customerToken}` }), r, c, makeRuns());
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.location, '/admin/login');
});
test('login: wrong password 401, right password sets a session cookie', async () => {
  const c = cfg();
  const dir = makeRuns();
  const form = await adminLoginForm(c, dir);
  const bad = res(); await handleAdmin(req('POST', '/admin/login', {
    cookie: form.cookie,
    body: `_csrf=${encodeURIComponent(form.csrf)}&password=nope`,
  }), bad, c, dir, undefined, DIRECT_TEST_RUNTIME_ENV);
  assert.equal(bad.statusCode, 401);
  const ok = res(); await handleAdmin(req('POST', '/admin/login', {
    cookie: form.cookie,
    body: `_csrf=${encodeURIComponent(form.csrf)}&password=hunter2`,
  }), ok, c, dir, undefined, DIRECT_TEST_RUNTIME_ENV);
  assert.equal(ok.statusCode, 302); assert.equal(ok.headers.location, '/admin');
  assert.match(String(ok.headers['set-cookie']), new RegExp(SESSION_COOKIE + '='));
  assert.match(String(ok.headers['set-cookie']), /SameSite=Strict/);
  assert.match(String(ok.headers['set-cookie']), /Path=\/admin/);
});
test('admin login requires its signed pre-authentication CSRF cookie', async () => {
  const c = cfg();
  const response = res();
  await handleAdmin(req('POST', '/admin/login', { body: 'password=hunter2&_csrf=forged' }), response, c, makeRuns());
  assert.equal(response.statusCode, 403);
  assert.doesNotMatch(String(response.headers['set-cookie']), new RegExp(`^${SESSION_COOKIE}=`));
});
test('configured admin TOTP is required and wrong factors share one generic error', async () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const c = cfg({ adminTotpSecret: secret });
  const dir = makeRuns();
  const form = await adminLoginForm(c, dir);
  const missing = res();
  await handleAdmin(req('POST', '/admin/login', {
    cookie: form.cookie,
    body: `_csrf=${encodeURIComponent(form.csrf)}&password=hunter2`,
  }), missing, c, dir, undefined, DIRECT_TEST_RUNTIME_ENV);
  assert.equal(missing.statusCode, 401);
  assert.match(missing.body, /Wrong password or authenticator code/);
  const accepted = res();
  await handleAdmin(req('POST', '/admin/login', {
    cookie: form.cookie,
    body: `_csrf=${encodeURIComponent(form.csrf)}&password=hunter2&totp=${totpCode(secret, Date.now())}`,
  }), accepted, c, dir, undefined, DIRECT_TEST_RUNTIME_ENV);
  assert.equal(accepted.statusCode, 302);
});
test('admin login throttles repeated failures by source', async () => {
  const throttle = new InMemoryLoginThrottle(2, 60_000, 60_000);
  const c = cfg();
  const dir = makeRuns();
  const form = await adminLoginForm(c, dir);
  for (let i = 0; i < 2; i++) {
    const bad = res();
    await handleAdmin(req('POST', '/admin/login', {
      body: `_csrf=${encodeURIComponent(form.csrf)}&password=nope`,
      cookie: form.cookie,
      remoteAddress: '203.0.113.9',
      forwardedFor: `198.51.100.${i + 1}`,
    }), bad, c, dir, throttle, DIRECT_TEST_RUNTIME_ENV);
    assert.equal(bad.statusCode, 401);
  }
  const blocked = res();
  await handleAdmin(req('POST', '/admin/login', {
    body: `_csrf=${encodeURIComponent(form.csrf)}&password=hunter2`,
    cookie: form.cookie,
    remoteAddress: '203.0.113.9',
    forwardedFor: '192.0.2.200',
  }), blocked, c, dir, throttle, DIRECT_TEST_RUNTIME_ENV);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['retry-after'], '60');
});
test('Render admin throttling separates authoritative client addresses', async () => {
  const throttle = new InMemoryLoginThrottle(1, 60_000, 60_000);
  const c = cfg({ production: true });
  const dir = makeRuns();
  const form = await adminLoginForm(c, dir);
  const renderEnv = {
    PORTAL_PROXY_MODE: 'render',
    PORTAL_ABUSE_HASH_SECRET: 'admin-render-abuse-secret-at-least-32-characters',
  } as NodeJS.ProcessEnv;
  const failed = res();
  await handleAdmin(req('POST', '/admin/login', {
    cookie: form.cookie,
    body: `_csrf=${encodeURIComponent(form.csrf)}&password=nope`,
    cfConnectingIp: '203.0.113.10',
    forwardedFor: '192.0.2.1',
  }), failed, c, dir, throttle, renderEnv);
  assert.equal(failed.statusCode, 401);
  const otherClient = res();
  await handleAdmin(req('POST', '/admin/login', {
    cookie: form.cookie,
    body: `_csrf=${encodeURIComponent(form.csrf)}&password=hunter2`,
    cfConnectingIp: '203.0.113.11',
    forwardedFor: '192.0.2.1',
  }), otherClient, c, dir, throttle, renderEnv);
  assert.equal(otherClient.statusCode, 302);
});
test('Render admin throttling ignores spoofed X-Forwarded-For', async () => {
  const throttle = new InMemoryLoginThrottle(1, 60_000, 60_000);
  const c = cfg({ production: true });
  const dir = makeRuns();
  const form = await adminLoginForm(c, dir);
  const renderEnv = {
    PORTAL_PROXY_MODE: 'render',
    PORTAL_ABUSE_HASH_SECRET: 'admin-render-abuse-secret-at-least-32-characters',
  } as NodeJS.ProcessEnv;
  const failed = res();
  await handleAdmin(req('POST', '/admin/login', {
    cookie: form.cookie,
    body: `_csrf=${encodeURIComponent(form.csrf)}&password=nope`,
    cfConnectingIp: '203.0.113.20',
    forwardedFor: '192.0.2.10',
  }), failed, c, dir, throttle, renderEnv);
  assert.equal(failed.statusCode, 401);
  const spoofed = res();
  await handleAdmin(req('POST', '/admin/login', {
    cookie: form.cookie,
    body: `_csrf=${encodeURIComponent(form.csrf)}&password=hunter2`,
    cfConnectingIp: '203.0.113.20',
    forwardedFor: '198.51.100.250',
  }), spoofed, c, dir, throttle, renderEnv);
  assert.equal(spoofed.statusCode, 429);
});
test('Render admin login fails closed without its authoritative client header', async () => {
  const throttle = new InMemoryLoginThrottle(5, 60_000, 60_000);
  const c = cfg({ production: true });
  const dir = makeRuns();
  const form = await adminLoginForm(c, dir);
  const response = res();
  await handleAdmin(req('POST', '/admin/login', {
    cookie: form.cookie,
    body: `_csrf=${encodeURIComponent(form.csrf)}&password=hunter2`,
    forwardedFor: '203.0.113.30',
  }), response, c, dir, throttle, {
    PORTAL_PROXY_MODE: 'render',
    PORTAL_ABUSE_HASH_SECRET: 'admin-render-abuse-secret-at-least-32-characters',
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], '30');
  assert.doesNotMatch(String(response.headers['set-cookie']), new RegExp(`^${SESSION_COOKIE}=`));
});
test('authed dashboard lists runs; run detail renders; sign-off writes signoff.json', async () => {
  const dir = makeRuns();
  const c = cfg();
  const sessionToken = signSession(c.sessionSecret, Date.now());
  const cookie = `${SESSION_COOKIE}=${sessionToken}`;
  const csrf = adminCsrfToken(c.sessionSecret, sessionToken);
  const dash = res(); await handleAdmin(req('GET', '/admin', { cookie }), dash, c, dir);
  assert.equal(dash.statusCode, 200); assert.match(dash.body, /Acme Joinery/); assert.match(dash.body, /Beta Ltd/);
  assert.match(dash.body, new RegExp(encodeURIComponent(csrf).replace(/%/g, '%')));
  const det = res(); await handleAdmin(req('GET', '/admin/run/runB', { cookie }), det, c, dir);
  assert.equal(det.statusCode, 200); assert.match(det.body, /Sign-off/);
  const so = res(); await handleAdmin(req('POST', '/admin/run/runB/signoff', {
    cookie,
    body: `_csrf=${encodeURIComponent(csrf)}&decision=approved`,
  }), so, c, dir);
  assert.equal(so.statusCode, 302);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'runB', 'signoff.json'), 'utf8'));
  assert.equal(written.decision, 'approved');
});
test('logout and sign-off reject missing session-bound CSRF without mutation', async () => {
  const dir = makeRuns();
  const c = cfg();
  const cookie = `${SESSION_COOKIE}=${signSession(c.sessionSecret, Date.now())}`;
  const signoff = res();
  await handleAdmin(req('POST', '/admin/run/runB/signoff', { cookie, body: 'decision=approved' }), signoff, c, dir);
  assert.equal(signoff.statusCode, 403);
  assert.equal(fs.existsSync(path.join(dir, 'runB', 'signoff.json')), false);
  const logout = res();
  await handleAdmin(req('POST', '/admin/logout', { cookie, body: '' }), logout, c, dir);
  assert.equal(logout.statusCode, 403);
  assert.equal(logout.headers['set-cookie'], undefined);
});
test('unexpected sign-off failures never expose filesystem error details', async () => {
  const dir = makeRuns();
  fs.mkdirSync(path.join(dir, 'runB', 'signoff.json'));
  const c = cfg();
  const sessionToken = signSession(c.sessionSecret, Date.now());
  const csrf = adminCsrfToken(c.sessionSecret, sessionToken);
  const response = res();
  await handleAdmin(req('POST', '/admin/run/runB/signoff', {
    cookie: `${SESSION_COOKIE}=${sessionToken}`,
    body: `_csrf=${encodeURIComponent(csrf)}&decision=approved`,
  }), response, c, dir);
  assert.equal(response.statusCode, 503);
  assert.match(response.body, /Sign-off could not be completed/);
  assert.doesNotMatch(response.body, /EISDIR|signoff\.json|filesystem|\\Users\\/i);
});
