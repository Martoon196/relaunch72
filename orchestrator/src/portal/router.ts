/**
 * The client portal — routes + the tenant auth gate. Everything under /portal
 * requires a valid tenant session except the login routes. Dependency-injected
 * (store + login + dashboard + runTick) so it tests without a socket.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCookies } from '../server/admin/session.js';
import { PORTAL_COOKIE, signTenant, verifyTenant, portalCookie, clearPortalCookie } from './session.js';
import type { InMemoryLoginThrottle } from './session.js';
import { loginPage, dashboardPage, billingPage } from './views.js';
import type { DashboardData } from './data.js';
import type { BillingView } from './billing.js';

export interface PortalDeps {
  sessionSecret: string;
  secure: boolean;
  /** Email + password → tenant id, or null if the credentials don't match. */
  login(email: string, password: string): Promise<string | null>;
  /** Consume a new customer's one-time setup token and set their password. */
  completeSetup?(token: string, password: string, now: number): Promise<string | null>;
  /** Process-local login limiter; replace with a shared implementation at multi-instance scale. */
  loginThrottle?: Pick<InMemoryLoginThrottle, 'check' | 'failure' | 'success'>;
  /** Assemble the dashboard for a tenant (CRM + brand + artifacts), or null. */
  dashboard(tenantId: string): Promise<DashboardData | null>;
  /** Run this period's marketing for a tenant (mock); returns how many tasks ran. */
  runTick(tenantId: string): Promise<number>;
  /** Resolve a tenant's billing status + plan options; absent = billing UI off. */
  billing?(tenantId: string): Promise<BillingView | null>;
  /** Start a subscription checkout for a plan; returns the Stripe URL to redirect to. */
  subscribeUrl?(plan: string, email: string | null): Promise<string>;
  /** Open the Stripe billing portal for an existing customer; returns the URL. */
  manageUrl?(customerId: string): Promise<string>;
  /** When true, "Run this week" requires an active subscription. Default false (£0 demo runs). */
  billingEnforced?: boolean;
  now?: () => number;
}

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

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function setupPage(token: string, error?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="referrer" content="no-referrer"><title>Set up your Relaunch72 account</title>` +
    `<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f4f6f8;color:#1f2836;margin:0;padding:40px 18px}` +
    `.card{max-width:440px;margin:8vh auto;background:#fff;border:1px solid #dfe4ea;border-radius:14px;padding:30px;box-shadow:0 12px 32px #26354a14}` +
    `h1{font-size:25px;margin:0 0 8px}p{color:#5c6a7e;line-height:1.5}.err{color:#a32727}label{display:block;font-weight:650;margin:18px 0 7px}` +
    `input{box-sizing:border-box;width:100%;padding:11px;border:1px solid #bac3ce;border-radius:8px;font-size:16px}` +
    `button{width:100%;margin-top:22px;padding:12px;border:0;border-radius:8px;background:#c9791a;color:#fff;font-size:16px;font-weight:700}</style></head>` +
    `<body><main class="card"><h1>Choose your password</h1><p>Use at least 12 characters. This private setup link works once.</p>` +
    (error ? `<p class="err" role="alert">${esc(error)}</p>` : '') +
    `<form method="post" action="/portal/setup"><input type="hidden" name="token" value="${esc(token)}">` +
    `<label for="password">Password</label><input id="password" name="password" type="password" minlength="12" maxlength="1024" autocomplete="new-password" required>` +
    `<label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" minlength="12" maxlength="1024" autocomplete="new-password" required>` +
    `<button type="submit">Set password and continue</button></form></main></body></html>`;
}

function loginKeys(req: IncomingMessage, email: string): string[] {
  const forwarded = req.headers['x-forwarded-for'];
  const firstForwarded = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  const remote = firstForwarded || req.socket?.remoteAddress || 'unknown';
  return [`account:${email || 'unknown'}`, `source:${remote}`];
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

/** Handle a request under /portal. Always writes a response. */
export async function handlePortal(req: IncomingMessage, res: ServerResponse, deps: PortalDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/portal';
  const method = req.method ?? 'GET';
  const now = deps.now ? deps.now() : Date.now();
  const tenantId = verifyTenant(deps.sessionSecret, parseCookies(req.headers.cookie)[PORTAL_COOKIE], now);

  // ── one-time account setup / login / logout (no auth) ──
  if (p === '/portal/setup' && method === 'GET') {
    const token = url.searchParams.get('token') ?? '';
    const error = token ? undefined : 'This setup link is incomplete. Contact support.';
    return sendHtml(res, token ? 200 : 400, setupPage(token, error), undefined, {
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
  }
  if (p === '/portal/setup' && method === 'POST') {
    if (!deps.completeSetup) return sendHtml(res, 404, setupPage('', 'Account setup is not enabled.'));
    const form = await readForm(req);
    const token = form.token ?? '';
    const password = form.password ?? '';
    if (password.length < 12 || password.length > 1_024) {
      return sendHtml(res, 400, setupPage(token, 'Use a password between 12 and 1,024 characters.'), undefined, { 'cache-control': 'no-store' });
    }
    if (password !== (form.confirm ?? '')) {
      return sendHtml(res, 400, setupPage(token, 'Those passwords do not match.'), undefined, { 'cache-control': 'no-store' });
    }
    const tid = await deps.completeSetup(token, password, now);
    if (!tid) {
      return sendHtml(res, 400, setupPage('', 'This setup link has expired or has already been used. Contact support.'), undefined, { 'cache-control': 'no-store' });
    }
    return redirect(res, '/portal', portalCookie(signTenant(deps.sessionSecret, tid, now), deps.secure));
  }
  if (p === '/portal/login' && method === 'GET') {
    if (tenantId) return redirect(res, '/portal');
    return sendHtml(res, 200, loginPage());
  }
  if (p === '/portal/login' && method === 'POST') {
    const form = await readForm(req);
    const email = (form.email ?? '').trim().toLowerCase();
    const keys = loginKeys(req, email);
    const throttle = keys.map((key) => deps.loginThrottle?.check(key, now)).find((result) => result && !result.allowed);
    if (throttle && !throttle.allowed) {
      return sendHtml(res, 429, loginPage('Too many login attempts. Try again later.'), undefined, {
        'retry-after': String(throttle.retryAfterSeconds),
      });
    }
    const tid = await deps.login(email, form.password ?? '');
    if (!tid) {
      for (const key of keys) deps.loginThrottle?.failure(key, now);
      return sendHtml(res, 401, loginPage('Wrong email or password.'));
    }
    for (const key of keys) deps.loginThrottle?.success(key);
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
    const billing = deps.billing ? await deps.billing(tenantId) : null;
    return sendHtml(res, 200, dashboardPage(data, billing ?? undefined));
  }

  if (p === '/portal/billing' && method === 'GET') {
    if (!deps.billing) return sendHtml(res, 404, '<h1>Billing not enabled</h1><p><a href="/portal">← dashboard</a></p>');
    const data = await deps.dashboard(tenantId);
    const billing = await deps.billing(tenantId);
    if (!billing) return redirect(res, '/portal');
    const notice = url.searchParams.get('need') ? 'A subscription is needed to run your marketing.'
      : url.searchParams.get('active') ? 'Use Manage billing for an existing subscription; Relaunch72 will not create a second one.'
      : url.searchParams.get('error') ? 'Something went wrong starting checkout — try again.' : undefined;
    return sendHtml(res, 200, billingPage(data?.tenant.name ?? 'Your business', billing, {
      canManage: !!deps.manageUrl,
      canSubscribe: !!deps.subscribeUrl,
      notice,
    }));
  }

  if (p === '/portal/subscribe' && method === 'POST') {
    if (!deps.subscribeUrl || !deps.billing) return redirect(res, '/portal/billing');
    const form = await readForm(req);
    const plan = (form.plan ?? '').trim();
    const billing = await deps.billing(tenantId);
    if (billing?.active) return redirect(res, '/portal/billing?active=1');
    try {
      const to = await deps.subscribeUrl(plan, billing?.email ?? null);
      return redirect(res, to);
    } catch {
      return redirect(res, '/portal/billing?error=1');
    }
  }

  if (p === '/portal/manage' && method === 'POST') {
    if (!deps.manageUrl || !deps.billing) return redirect(res, '/portal/billing');
    const billing = await deps.billing(tenantId);
    if (!billing?.customerId) return redirect(res, '/portal/billing');
    try {
      const to = await deps.manageUrl(billing.customerId);
      return redirect(res, to);
    } catch {
      return redirect(res, '/portal/billing?error=1');
    }
  }

  if (p === '/portal/run' && method === 'POST') {
    // Soft gate: only block when billing is enforced AND the tenant isn't active.
    if (deps.billingEnforced && deps.billing) {
      const billing = await deps.billing(tenantId);
      if (!billing?.active) return redirect(res, '/portal/billing?need=1');
    }
    await deps.runTick(tenantId);
    return redirect(res, '/portal');
  }

  return sendHtml(res, 404, '<h1>Not found</h1><p><a href="/portal">← dashboard</a></p>');
}
