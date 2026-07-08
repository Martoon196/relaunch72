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

const RUN_ID = /^[A-Za-z0-9._-]+$/;

function sendHtml(res: ServerResponse, code: number, body: string, cookie?: string): void {
  const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(body)) };
  if (cookie) headers['set-cookie'] = cookie;
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
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const out: Record<string, string> = {};
      new URLSearchParams(Buffer.concat(chunks).toString('utf8')).forEach((v, k) => { out[k] = v; });
      resolve(out);
    });
    req.on('error', () => resolve({}));
  });
}

/** Handle a request under /admin. Returns nothing — always writes a response. */
export async function handleAdmin(req: IncomingMessage, res: ServerResponse, cfg: StripeConfig, runsDir: string = RUNS_DIR): Promise<void> {
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
    const form = await readForm(req);
    if (passwordOk(form.password ?? '', cfg.adminPassword)) {
      redirect(res, '/admin', sessionCookie(signSession(cfg.sessionSecret, now), secure));
    } else {
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
