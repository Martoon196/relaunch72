import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { passwordOk, signSession, verifySession, parseCookies, SESSION_COOKIE } from '../src/server/admin/session.js';
import { listRuns, getRunDetail, readDeliverable, listOrders } from '../src/server/admin/store.js';
import { handleAdmin } from '../src/server/admin/router.js';
import type { StripeConfig } from '../src/server/config.js';

function cfg(over: Partial<StripeConfig> = {}): StripeConfig {
  return {
    secretKey: 'sk_test_x', webhookSecret: 'wh', priceIds: {}, planIds: {}, publicBaseUrl: 'https://relaunch72.test', port: 0,
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

function req(method: string, url: string, opts: { cookie?: string; body?: string } = {}): IncomingMessage {
  const r = Readable.from([Buffer.from(opts.body ?? '')]) as unknown as IncomingMessage;
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body) headers['content-type'] = 'application/x-www-form-urlencoded';
  return Object.assign(r, { method, url, headers });
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
});
test('login: wrong password 401, right password sets a session cookie', async () => {
  const bad = res(); await handleAdmin(req('POST', '/admin/login', { body: 'password=nope' }), bad, cfg(), makeRuns());
  assert.equal(bad.statusCode, 401);
  const ok = res(); await handleAdmin(req('POST', '/admin/login', { body: 'password=hunter2' }), ok, cfg(), makeRuns());
  assert.equal(ok.statusCode, 302); assert.equal(ok.headers.location, '/admin');
  assert.match(String(ok.headers['set-cookie']), new RegExp(SESSION_COOKIE + '='));
});
test('authed dashboard lists runs; run detail renders; sign-off writes signoff.json', async () => {
  const dir = makeRuns();
  const c = cfg();
  const cookie = `${SESSION_COOKIE}=${signSession(c.sessionSecret, Date.now())}`;
  const dash = res(); await handleAdmin(req('GET', '/admin', { cookie }), dash, c, dir);
  assert.equal(dash.statusCode, 200); assert.match(dash.body, /Acme Joinery/); assert.match(dash.body, /Beta Ltd/);
  const det = res(); await handleAdmin(req('GET', '/admin/run/runB', { cookie }), det, c, dir);
  assert.equal(det.statusCode, 200); assert.match(det.body, /Sign-off/);
  const so = res(); await handleAdmin(req('POST', '/admin/run/runB/signoff', { cookie, body: 'decision=approved' }), so, c, dir);
  assert.equal(so.statusCode, 302);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'runB', 'signoff.json'), 'utf8'));
  assert.equal(written.decision, 'approved');
});
