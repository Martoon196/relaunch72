/**
 * The Stripe backend as a dependency-injected request handler, so routes test
 * without a socket, a key, or the pipeline. Routes:
 *   GET  /health               — liveness + test/live mode
 *   POST /api/checkout         — { tier, bump? } → { url } (Stripe Checkout Session)
 *   POST /api/stripe/webhook   — verify signature, record the paid order, sync customer
 *   POST /api/intake           — S0-gate a submitted intake; on accept, kick the build
 *   POST /api/subscribe        — capture a lead (scorecard) into the Brevo nurture list
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StripeConfig } from './config.js';
import type { OrderStore, Order } from './orders.js';
import { createCheckoutSession, verifyEvent, orderFromEvent, CheckoutError, type StripeLike } from './stripe.js';
import { runS0 } from '../intake/s0.js';
import type { Intake } from '../types.js';
import { handleAdmin } from './admin/router.js';

/** Optional marketing sync (Brevo). Both are no-ops when Brevo isn't configured. */
export interface MarketingHooks {
  /** A new lead (e.g. scorecard signup) — add to the nurture list. */
  onLead?(email: string, firstName?: string): Promise<void>;
  /** A new paying customer — add to the onboarding list. */
  onCustomer?(order: Order): Promise<void>;
}

export interface AppDeps {
  stripe: StripeLike;
  cfg: StripeConfig;
  orders: OrderStore;
  /** Persist the accepted intake and start the pipeline; returns a run reference. */
  kickPipeline: (intake: Intake, sessionId: string | null) => string;
  now: () => string;
  /** Optional Brevo marketing sync; absent = marketing not wired (routes still 200). */
  marketing?: MarketingHooks;
}

function send(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

/**
 * Echo the request Origin back only if it's on the allowlist — the browser
 * blocks the site's cross-origin fetch to this API without it. Headers are set
 * via setHeader so they survive the later writeHead in send().
 */
function applyCors(req: IncomingMessage, res: ServerResponse, allowed: string[]): void {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(deps: AppDeps) {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;

    // The admin control room is same-origin, browser-navigated HTML — handled
    // before the CORS/API layer, with its own auth gate.
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      try { await handleAdmin(req, res, deps.cfg); }
      catch (e) { if (!res.headersSent) send(res, 500, { error: (e as Error).message }); }
      return;
    }

    applyCors(req, res, deps.cfg.allowedOrigins);
    try {
      // CORS preflight: the browser asks before the real POST from the site.
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (route === 'GET /health') {
        // Always 200 so the host's health check passes even before secrets are set.
        return send(res, 200, { ok: true, mode: deps.cfg.liveMode ? 'live' : 'test', configured: !!deps.cfg.secretKey });
      }

      // Stripe-backed routes degrade to 503 until a key is configured, rather than
      // crashing the process — so the service deploys green and you add secrets after.
      if (route === 'POST /api/checkout') {
        if (!deps.cfg.secretKey) return send(res, 503, { error: 'payments not configured yet' });
        const body = JSON.parse((await readBody(req)).toString() || '{}') as { tier?: string; bump?: boolean };
        const { url: checkoutUrl } = await createCheckoutSession(deps.stripe, deps.cfg, { tier: body.tier ?? '', bump: !!body.bump });
        return send(res, 200, { url: checkoutUrl });
      }

      if (route === 'POST /api/stripe/webhook') {
        if (!deps.cfg.secretKey) return send(res, 503, { error: 'payments not configured yet' });
        const raw = await readBody(req);
        let event;
        try {
          event = verifyEvent(deps.stripe, deps.cfg, raw, String(req.headers['stripe-signature'] ?? ''));
        } catch {
          return send(res, 400, { error: 'invalid signature' });
        }
        const order = orderFromEvent(event, deps.now());
        if (order) {
          deps.orders.record(order);
          // Onboarding sync — fire-and-forget so a marketing hiccup never fails the
          // webhook (Stripe would retry an error and the order's already recorded).
          if (order.email && deps.marketing?.onCustomer) {
            void deps.marketing.onCustomer(order).catch((e) => console.warn(`marketing onCustomer failed: ${(e as Error).message}`));
          }
        }
        return send(res, 200, { received: true });
      }

      if (route === 'POST /api/subscribe') {
        const body = JSON.parse((await readBody(req)).toString() || '{}') as { email?: string; firstName?: string };
        const email = (body.email ?? '').trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: 'a valid email is required' });
        let synced = false;
        if (deps.marketing?.onLead) {
          try { await deps.marketing.onLead(email, body.firstName?.trim() || undefined); synced = true; }
          catch (e) { console.warn(`marketing onLead failed: ${(e as Error).message}`); }
        }
        return send(res, 200, { ok: true, synced });
      }

      if (route === 'POST /api/intake') {
        const intake = JSON.parse((await readBody(req)).toString() || '{}') as Intake & { _stripe_session?: string };
        const s0 = runS0(intake);
        if (!s0.accepted) return send(res, 200, { accepted: false, issues: s0.issues });
        const sessionId = typeof intake._stripe_session === 'string' ? intake._stripe_session : null;
        const runRef = deps.kickPipeline(intake, sessionId);
        if (sessionId) deps.orders.update(sessionId, { status: 'building', run_dir: runRef, updated_at: deps.now() });
        return send(res, 200, { accepted: true, building: true, run: runRef });
      }

      return send(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof CheckoutError) return send(res, 400, { error: e.message });
      return send(res, 500, { error: (e as Error).message });
    }
  };
}
