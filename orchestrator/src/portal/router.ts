/**
 * The client portal — routes + the tenant auth gate. Everything under /portal
 * requires a valid tenant session except the login routes. Dependency-injected
 * (store + login + dashboard + runTick) so it tests without a socket.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCookies } from '../server/admin/session.js';
import { PORTAL_COOKIE, signTenant, verifyTenant, portalCookie, clearPortalCookie } from './session.js';
import { loginPage, dashboardPage } from './views.js';
import type { DashboardData } from './data.js';

export interface PortalDeps {
  sessionSecret: string;
  secure: boolean;
  /** Email + password → tenant id, or null if the credentials don't match. */
  login(email: string, password: string): Promise<string | null>;
  /** Assemble the dashboard for a tenant (CRM + brand + artifacts), or null. */
  dashboard(tenantId: string): Promise<DashboardData | null>;
  /** Run this period's marketing for a tenant (mock); returns how many tasks ran. */
  runTick(tenantId: string): Promise<number>;
  now?: () => number;
}

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

/** Handle a request under /portal. Always writes a response. */
export async function handlePortal(req: IncomingMessage, res: ServerResponse, deps: PortalDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/portal';
  const method = req.method ?? 'GET';
  const now = deps.now ? deps.now() : Date.now();
  const tenantId = verifyTenant(deps.sessionSecret, parseCookies(req.headers.cookie)[PORTAL_COOKIE], now);

  // ── login / logout (no auth) ──
  if (p === '/portal/login' && method === 'GET') {
    if (tenantId) return redirect(res, '/portal');
    return sendHtml(res, 200, loginPage());
  }
  if (p === '/portal/login' && method === 'POST') {
    const form = await readForm(req);
    const tid = await deps.login((form.email ?? '').trim().toLowerCase(), form.password ?? '');
    if (!tid) return sendHtml(res, 401, loginPage('Wrong email or password.'));
    return redirect(res, '/portal', portalCookie(signTenant(deps.sessionSecret, tid, now), deps.secure));
  }
  if (p === '/portal/logout' && method === 'POST') {
    return redirect(res, '/portal/login', clearPortalCookie(deps.secure));
  }

  // ── everything below requires a tenant session ──
  if (!tenantId) return redirect(res, '/portal/login');

  if (p === '/portal' && method === 'GET') {
    const data = await deps.dashboard(tenantId);
    if (!data) return redirect(res, '/portal/login', clearPortalCookie(deps.secure)); // stale session
    return sendHtml(res, 200, dashboardPage(data));
  }

  if (p === '/portal/run' && method === 'POST') {
    await deps.runTick(tenantId);
    return redirect(res, '/portal');
  }

  return sendHtml(res, 404, '<h1>Not found</h1><p><a href="/portal">← dashboard</a></p>');
}
