/**
 * The client portal — routes + the tenant auth gate. Everything under /portal
 * requires a valid tenant session except the login routes. Dependency-injected
 * (store + login + dashboard + runTick) so it tests without a socket.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCookies } from '../server/admin/session.js';
import { PORTAL_COOKIE, signTenant, verifyTenant, portalCookie, clearPortalCookie } from './session.js';
import { loginPage, dashboardPage, billingPage } from './views.js';
import type { DashboardData } from './data.js';
import type { BillingView } from './billing.js';

export interface PortalDeps {
  sessionSecret: string;
  secure: boolean;
  /** Email + password → tenant id, or null if the credentials don't match. */
  login(email: string, password: string): Promise<string | null>;
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
    const billing = deps.billing ? await deps.billing(tenantId) : null;
    return sendHtml(res, 200, dashboardPage(data, billing ?? undefined));
  }

  if (p === '/portal/billing' && method === 'GET') {
    if (!deps.billing) return sendHtml(res, 404, '<h1>Billing not enabled</h1><p><a href="/portal">← dashboard</a></p>');
    const data = await deps.dashboard(tenantId);
    const billing = await deps.billing(tenantId);
    if (!billing) return redirect(res, '/portal');
    const notice = url.searchParams.get('need') ? 'A subscription is needed to run your marketing.'
      : url.searchParams.get('error') ? 'Something went wrong starting checkout — try again.' : undefined;
    return sendHtml(res, 200, billingPage(data?.tenant.name ?? 'Your business', billing, { canManage: !!deps.manageUrl, notice }));
  }

  if (p === '/portal/subscribe' && method === 'POST') {
    if (!deps.subscribeUrl || !deps.billing) return redirect(res, '/portal/billing');
    const form = await readForm(req);
    const plan = (form.plan ?? '').trim();
    const billing = await deps.billing(tenantId);
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
