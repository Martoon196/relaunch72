/**
 * The Stripe backend as a dependency-injected request handler, so routes test
 * without a socket, a key, or the pipeline. Routes:
 *   GET  /health               — liveness + test/live mode
 *   POST /api/checkout         — { tier, bump? } → { url } (Stripe Checkout Session)
 *   POST /api/stripe/webhook   — verify signature, record the paid order
 *   POST /api/intake           — S0-gate a submitted intake; on accept, kick the build
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StripeConfig } from './config.js';
import type { OrderStore } from './orders.js';
import { createCheckoutSession, verifyEvent, orderFromEvent, CheckoutError, type StripeLike } from './stripe.js';
import { runS0 } from '../intake/s0.js';
import type { Intake } from '../types.js';

export interface AppDeps {
  stripe: StripeLike;
  cfg: StripeConfig;
  orders: OrderStore;
  /** Persist the accepted intake and start the pipeline; returns a run reference. */
  kickPipeline: (intake: Intake, sessionId: string | null) => string;
  now: () => string;
}

function send(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
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
    try {
      if (route === 'GET /health') {
        return send(res, 200, { ok: true, mode: deps.cfg.liveMode ? 'live' : 'test' });
      }

      if (route === 'POST /api/checkout') {
        const body = JSON.parse((await readBody(req)).toString() || '{}') as { tier?: string; bump?: boolean };
        const { url: checkoutUrl } = await createCheckoutSession(deps.stripe, deps.cfg, { tier: body.tier ?? '', bump: !!body.bump });
        return send(res, 200, { url: checkoutUrl });
      }

      if (route === 'POST /api/stripe/webhook') {
        const raw = await readBody(req);
        let event;
        try {
          event = verifyEvent(deps.stripe, deps.cfg, raw, String(req.headers['stripe-signature'] ?? ''));
        } catch {
          return send(res, 400, { error: 'invalid signature' });
        }
        const order = orderFromEvent(event, deps.now());
        if (order) deps.orders.record(order);
        return send(res, 200, { received: true });
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
