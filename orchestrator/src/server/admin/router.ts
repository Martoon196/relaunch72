/**
 * The /admin control room — routes, the auth gate, and the sign-off action.
 * Everything under /admin requires a valid session cookie except the login
 * routes. Reuses the pipeline's own signoff logic to write signoff.json.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { StripeConfig } from '../config.js';
import { RUNS_DIR } from '../../paths.js';
import {
  passwordOk, signSession, verifySession, parseCookies, sessionCookie, clearCookie, SESSION_COOKIE,
} from './session.js';
import { listRuns, getRunDetail, readDeliverable, listOrders } from './store.js';
import { loginPage, dashboardPage, runDetailPage, renderDeliverable } from './views.js';
import { approve, sendBack, SignoffError, bundleStatusFor, type BundleLike } from '../../signoff/signoff.js';
import { InMemoryLoginThrottle } from '../../portal/session.js';

const RUN_ID = /^[A-Za-z0-9._-]+$/;
const DEFAULT_ADMIN_LOGIN_THROTTLE = new InMemoryLoginThrottle();

function sendHtml(res: ServerResponse, code: number, body: string, cookie?: string, extra: Record<string, string> = {}): void {
  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  };
  if (cookie) headers['set-cookie'] = cookie;
  Object.assign(headers, extra);
  res.writeHead(code, headers);
  res.end(body);
}
function redirect(res: ServerResponse, to: string, cookie?: string): void {
  const headers: Record<string, string> = { location: to };
  if (cookie) headers['set-cookie'] = cookie;
  res.writeHead(302, headers);
  res.end();
}
function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: Record<string, string>): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) { chunks.length = 0; finish({}); return; }
      if (!settled) chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      const out: Record<string, string> = {};
      new URLSearchParams(Buffer.concat(chunks).toString('utf8')).forEach((v, k) => { out[k] = v; });
      finish(out);
    });
    req.on('error', () => finish({}));
  });
}

function loginSource(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || 'unknown';
}

/** Handle a request under /admin. Returns nothing — always writes a response. */
export async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: StripeConfig,
  runsDir: string = RUNS_DIR,
  loginThrottle: Pick<InMemoryLoginThrottle, 'reserve' | 'failure' | 'success'> = DEFAULT_ADMIN_LOGIN_THROTTLE,
): Promise<void> {
  if (!cfg.adminPassword) { sendHtml(res, 404, '<h1>Admin is disabled</h1><p>Set ADMIN_PASSWORD to enable the control room.</p>'); return; }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/admin';
  const method = req.method ?? 'GET';
  const secure = req.headers['x-forwarded-proto'] === 'https' || cfg.publicBaseUrl.startsWith('https');
  const now = Date.now();
  const authed = verifySession(cfg.sessionSecret, parseCookies(req.headers.cookie)[SESSION_COOKIE], now);

  // ── login / logout (no auth required) ──
  if (p === '/admin/login' && method === 'GET') { sendHtml(res, 200, loginPage()); return; }
  if (p === '/admin/login' && method === 'POST') {
    const throttleKey = `source:${loginSource(req)}`;
    const throttle = loginThrottle.reserve(throttleKey, now);
    if (!throttle.allowed) {
      sendHtml(res, 429, loginPage('Too many login attempts. Try again later.'), undefined, {
        'retry-after': String(throttle.retryAfterSeconds),
      });
      return;
    }
    const form = await readForm(req);
    if (passwordOk(form.password ?? '', cfg.adminPassword)) {
      loginThrottle.success(throttleKey);
      redirect(res, '/admin', sessionCookie(signSession(cfg.sessionSecret, now), secure));
    } else {
      loginThrottle.failure(throttleKey, now);
      sendHtml(res, 401, loginPage('Wrong password.'));
    }
    return;
  }
  if (p === '/admin/logout' && method === 'POST') { redirect(res, '/admin/login', clearCookie(secure)); return; }

  // ── everything below requires a session ──
  if (!authed) { redirect(res, '/admin/login'); return; }

  if (p === '/admin' && method === 'GET') {
    sendHtml(res, 200, dashboardPage(listRuns(runsDir), listOrders(cfg.ordersFile)));
    return;
  }

  const runMatch = p.match(/^\/admin\/run\/([^/]+)$/);
  if (runMatch && method === 'GET') {
    const id = decodeURIComponent(runMatch[1]!);
    if (!RUN_ID.test(id)) { sendHtml(res, 400, '<h1>Bad run id</h1>'); return; }
    const detail = getRunDetail(runsDir, id);
    if (!detail) { sendHtml(res, 404, '<h1>Run not found</h1><p><a href="/admin">← back</a></p>'); return; }
    const stage = url.searchParams.get('view');
    const view = stage && RUN_ID.test(stage) ? { stage, html: renderDeliverable(readDeliverable(runsDir, id, stage)) } : null;
    sendHtml(res, 200, runDetailPage(detail, view));
    return;
  }

  const signoffMatch = p.match(/^\/admin\/run\/([^/]+)\/signoff$/);
  if (signoffMatch && method === 'POST') {
    const id = decodeURIComponent(signoffMatch[1]!);
    if (!RUN_ID.test(id)) { sendHtml(res, 400, '<h1>Bad run id</h1>'); return; }
    const dir = path.join(runsDir, id);
    const bundlePath = path.join(dir, 'bundle.json');
    if (!fs.existsSync(bundlePath)) { sendHtml(res, 400, '<h1>No pack to sign off</h1><p>This run hasn’t assembled yet. <a href="/admin/run/' + encodeURIComponent(id) + '">← back</a></p>'); return; }
    const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8')) as BundleLike;
    const form = await readForm(req);
    try {
      const at = new Date().toISOString();
      const decision = form.decision === 'sent_back'
        ? sendBack(bundle, { by: 'Martin Howard', at, stages: [], notes: (form.notes ?? '').trim() })
        : approve(bundle, { by: 'Martin Howard', at });
      fs.writeFileSync(path.join(dir, 'signoff.json'), JSON.stringify(decision, null, 2), 'utf8');
      // reflect the decision on the bundle so delivery + the dashboard agree
      bundle.status = bundleStatusFor(decision.decision);
      fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), 'utf8');
      redirect(res, '/admin/run/' + encodeURIComponent(id));
    } catch (e) {
      const detail = getRunDetail(runsDir, id);
      const msg = e instanceof SignoffError ? e.message : (e as Error).message;
      sendHtml(res, 400, detail ? runDetailPage(detail, { stage: 'Sign-off', html: `<p class="err">${msg}</p>` }) : `<h1>${msg}</h1>`);
    }
    return;
  }

  sendHtml(res, 404, '<h1>Not found</h1><p><a href="/admin">← control room</a></p>');
}
