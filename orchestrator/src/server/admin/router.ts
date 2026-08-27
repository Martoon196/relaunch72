/**
 * The /admin control room — routes, the auth gate, and the sign-off action.
 * Everything under /admin requires a valid session cookie except the login
 * routes. Reuses the pipeline's own signoff logic to write signoff.json.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadPortalAbuseRuntimeConfig, type StripeConfig } from '../config.js';
import { RUNS_DIR } from '../../paths.js';
import { createPortalRequestContextResolver } from '../../portal/request-context.js';
import {
  ADMIN_LOGIN_CSRF_COOKIE,
  adminCsrfToken,
  adminLoginCsrfCookie,
  adminLoginCsrfToken,
  clearCookie,
  parseCookies,
  passwordOk,
  sessionCookie,
  SESSION_COOKIE,
  signSession,
  verifyAdminCsrf,
  verifyAdminLoginCsrf,
  verifySession,
  verifyTotp,
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

function loginSource(
  req: IncomingMessage,
  cfg: StripeConfig,
  env: NodeJS.ProcessEnv,
): string | null {
  try {
    const runtime = loadPortalAbuseRuntimeConfig(Boolean(cfg.production), env);
    const context = createPortalRequestContextResolver({
      hashSecret: runtime.hashSecret,
      proxyMode: runtime.proxyMode,
      directClientAddress: (request) => request.socket?.remoteAddress,
    })(req);
    return context?.clientAddress ?? null;
  } catch {
    // Production must never fall back to the proxy peer or an appendable
    // forwarding header when its authoritative Render evidence is unavailable.
    return null;
  }
}

function sendLogin(
  res: ServerResponse,
  code: number,
  cfg: StripeConfig,
  secure: boolean,
  error?: string,
  existingCsrf?: string,
  extra: Record<string, string> = {},
): void {
  const csrf = existingCsrf || adminLoginCsrfToken(cfg.sessionSecret);
  sendHtml(
    res,
    code,
    loginPage(error, csrf, Boolean(cfg.adminTotpSecret)),
    adminLoginCsrfCookie(csrf, secure),
    extra,
  );
}

/** Handle a request under /admin. Returns nothing — always writes a response. */
export async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: StripeConfig,
  runsDir: string = RUNS_DIR,
  loginThrottle: Pick<InMemoryLoginThrottle, 'reserve' | 'failure' | 'success'> = DEFAULT_ADMIN_LOGIN_THROTTLE,
  runtimeEnv: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!cfg.adminPassword) { sendHtml(res, 404, '<h1>Admin is disabled</h1><p>Set ADMIN_PASSWORD to enable the control room.</p>'); return; }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/admin';
  const method = req.method ?? 'GET';
  const secure = req.headers['x-forwarded-proto'] === 'https' || cfg.publicBaseUrl.startsWith('https');
  const now = Date.now();
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies[SESSION_COOKIE];
  const adminSessionEpoch = cfg.adminSessionEpoch ?? 0;
  const authed = verifySession(cfg.sessionSecret, sessionToken, now, adminSessionEpoch);

  // ── login / logout (no auth required) ──
  if (p === '/admin/login' && method === 'GET') {
    if (authed) { redirect(res, '/admin'); return; }
    sendLogin(res, 200, cfg, secure);
    return;
  }
  if (p === '/admin/login' && method === 'POST') {
    const form = await readForm(req);
    const loginCsrf = cookies[ADMIN_LOGIN_CSRF_COOKIE];
    if (!verifyAdminLoginCsrf(cfg.sessionSecret, loginCsrf, form._csrf)) {
      sendLogin(res, 403, cfg, secure, 'Refresh the sign-in page and try again.');
      return;
    }
    const source = loginSource(req, cfg, runtimeEnv);
    if (!source) {
      sendLogin(res, 503, cfg, secure, 'Secure sign-in is temporarily unavailable. Try again shortly.', loginCsrf, {
        'retry-after': '30',
      });
      return;
    }
    const throttleKey = `source:${source}`;
    const throttle = loginThrottle.reserve(throttleKey, now);
    if (!throttle.allowed) {
      sendLogin(res, 429, cfg, secure, 'Too many login attempts. Try again later.', loginCsrf, {
        'retry-after': String(throttle.retryAfterSeconds),
      });
      return;
    }
    const passwordAccepted = passwordOk(form.password ?? '', cfg.adminPassword);
    const totpAccepted = cfg.adminTotpSecret
      ? verifyTotp(cfg.adminTotpSecret, form.totp, now)
      : true;
    if (passwordAccepted && totpAccepted) {
      loginThrottle.success(throttleKey);
      redirect(res, '/admin', sessionCookie(
        signSession(cfg.sessionSecret, now, undefined, adminSessionEpoch),
        secure,
      ));
    } else {
      loginThrottle.failure(throttleKey, now);
      sendLogin(
        res,
        401,
        cfg,
        secure,
        cfg.adminTotpSecret ? 'Wrong password or authenticator code.' : 'Wrong password.',
        loginCsrf,
      );
    }
    return;
  }

  // ── everything below requires a session ──
  if (!authed) { redirect(res, '/admin/login'); return; }
  const csrf = adminCsrfToken(cfg.sessionSecret, sessionToken!);

  if (p === '/admin/logout' && method === 'POST') {
    const form = await readForm(req);
    if (!verifyAdminCsrf(cfg.sessionSecret, sessionToken, form._csrf)) {
      sendHtml(res, 403, '<h1>Refresh needed</h1><p>Your session remains active.</p>');
      return;
    }
    redirect(res, '/admin/login', clearCookie(secure));
    return;
  }

  if (p === '/admin' && method === 'GET') {
    sendHtml(res, 200, dashboardPage(listRuns(runsDir), listOrders(cfg.ordersFile), csrf));
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
    sendHtml(res, 200, runDetailPage(detail, view, csrf));
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
    if (!verifyAdminCsrf(cfg.sessionSecret, sessionToken, form._csrf)) {
      sendHtml(res, 403, '<h1>Refresh needed</h1><p>No sign-off decision was recorded.</p>');
      return;
    }
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
      // Validation errors are fixed, trusted copy. Filesystem/runtime failures
      // may contain paths or credentials and must never cross the HTTP boundary.
      const expectedFailure = e instanceof SignoffError;
      const msg = expectedFailure
        ? e.message
        : 'Sign-off could not be completed. No decision was recorded; try again shortly.';
      const safeMessage = msg.replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[character] as string));
      sendHtml(res, expectedFailure ? 400 : 503, detail
        ? runDetailPage(detail, { stage: 'Sign-off', html: `<p class="err">${safeMessage}</p>` }, csrf)
        : `<h1>${safeMessage}</h1>`);
    }
    return;
  }

  sendHtml(res, 404, '<h1>Not found</h1><p><a href="/admin">← control room</a></p>');
}
