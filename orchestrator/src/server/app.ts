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
import path from 'node:path';
import crypto from 'node:crypto';
import { classifyStripeKey, type StripeConfig } from './config.js';
import { fileWebhookReceiptStore, type OrderStore, type Order, type WebhookReceiptStore } from './orders.js';
import { createCheckoutSession, createSubscriptionCheckout, verifyEvent, orderFromEvent, CheckoutError, type StripeLike } from './stripe.js';
import { subscriptionFromEvent, planResolver, type SubscriptionStore } from './subscriptions.js';
import { runS0 } from '../intake/s0.js';
import type { Intake } from '../types.js';
import { handleAdmin } from './admin/router.js';
import { handlePortal, type PortalDeps } from '../portal/router.js';
import { entitlementForOrder, type BuildEntitlement } from './entitlements.js';
import { oneOffCheckoutBlockers, subscriptionCheckoutBlockers } from './readiness.js';
import { canonicalIntake } from '../intake/canonical.js';

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
  kickPipeline: (intake: Intake, order: Order, entitlement: BuildEntitlement) => string;
  now: () => string;
  /** Optional Brevo marketing sync; absent = marketing not wired (routes still 200). */
  marketing?: MarketingHooks;
  /** Optional client portal; absent = /portal 404s (payments still work). */
  portal?: PortalDeps;
  /** Fired (fire-and-forget) when an intake is accepted — provisions the portal login. */
  onIntakeAccepted?: (intake: Intake, email: string | null) => void;
  /** Optional recurring-subscription store; absent = subscription events are ignored. */
  subscriptions?: SubscriptionStore;
  /**
   * Processed Stripe-event ids. Production defaults to a file-backed journal
   * under dataDir; tests can inject the in-memory implementation.
   */
  webhookReceipts?: WebhookReceiptStore;
  /** Extra boot-time reasons a build cannot safely start (for example no AI key). */
  buildBlockers?: string[];
  /** Truthful execution mode exposed by health for accepted builds. */
  buildMode?: 'mock' | 'live';
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
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-relaunch72-sandbox-token');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const contentLength = Number(req.headers['content-length'] ?? 0);

    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      req.resume();
      reject(error);
    };
    const onData = (raw: Buffer | string): void => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.length;
      if (size > maxBytes) { fail(new BodyTooLargeError(`request body exceeds ${maxBytes} bytes`)); return; }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onError = (error: Error): void => fail(error);
    const onAborted = (): void => fail(new Error('request body aborted'));

    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      fail(new BodyTooLargeError(`request body exceeds ${maxBytes} bytes`));
      return;
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function sandboxAccessRequired(cfg: StripeConfig): boolean {
  return Boolean(cfg.production) && classifyStripeKey(cfg.secretKey) === 'test';
}

function sandboxAccessGranted(req: IncomingMessage, cfg: StripeConfig): boolean {
  if (!sandboxAccessRequired(cfg)) return true;
  const raw = req.headers['x-relaunch72-sandbox-token'];
  const presented = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  if (!presented || !cfg.sandboxAccessToken) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(cfg.sandboxAccessToken).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createApp(deps: AppDeps) {
  const webhookReceipts = deps.webhookReceipts
    ?? fileWebhookReceiptStore(path.join(deps.cfg.dataDir, 'stripe-webhook-receipts.jsonl'));
  const stripeKeyMode = classifyStripeKey(deps.cfg.secretKey);

  const checkoutBlockers = (): string[] => oneOffCheckoutBlockers(deps.cfg, deps.buildBlockers ?? []);
  const recurringBlockers = (): string[] => subscriptionCheckoutBlockers(deps.cfg);

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

    // The client portal — same-origin, browser-navigated HTML, its own tenant
    // auth gate. Only mounted when portal deps are provided.
    if (url.pathname === '/portal' || url.pathname.startsWith('/portal/')) {
      if (!deps.portal) { send(res, 404, { error: 'portal not enabled' }); return; }
      try { await handlePortal(req, res, deps.portal); }
      catch (e) { if (!res.headersSent) send(res, 500, { error: (e as Error).message }); }
      return;
    }

    applyCors(req, res, deps.cfg.allowedOrigins);
    try {
      // CORS preflight: the browser asks before the real POST from the site.
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (route === 'GET /health') {
        // Liveness remains 200, while readiness is explicit and cannot be
        // confused with "a Stripe key exists".
        const blockers = checkoutBlockers();
        const subscriptionBlockers = recurringBlockers();
        return send(res, 200, {
          ok: true,
          mode: stripeKeyMode,
          configured: blockers.length === 0,
          accepting_checkout: blockers.length === 0,
          blockers,
          accepting_subscriptions: subscriptionBlockers.length === 0,
          subscription_blockers: subscriptionBlockers,
          accepting_public_leads: deps.cfg.publicLeadCaptureEnabled === true && Boolean(deps.marketing?.onLead),
          build_mode: deps.buildMode ?? 'live',
        });
      }

      // Stripe-backed routes degrade to 503 until a key is configured, rather than
      // crashing the process — so the service deploys green and you add secrets after.
      if (route === 'POST /api/checkout') {
        const blockers = checkoutBlockers();
        if (blockers.length) return send(res, 503, { error: 'checkout is not ready', blockers });
        if (!sandboxAccessGranted(req, deps.cfg)) return send(res, 401, { error: 'private sandbox access code required' });
        const body = JSON.parse((await readBody(req)).toString() || '{}') as { tier?: unknown; bump?: unknown };
        const { url: checkoutUrl } = await createCheckoutSession(deps.stripe, deps.cfg, {
          tier: typeof body.tier === 'string' ? body.tier : '',
          bump: body.bump === true,
        });
        return send(res, 200, { url: checkoutUrl });
      }

      // Recurring platform subscription checkout (mode:'subscription').
      if (route === 'POST /api/subscription') {
        const blockers = recurringBlockers();
        if (blockers.length) return send(res, 503, { error: 'subscription checkout is not ready', blockers });
        if (!sandboxAccessGranted(req, deps.cfg)) return send(res, 401, { error: 'private sandbox access code required' });
        const body = JSON.parse((await readBody(req)).toString() || '{}') as { plan?: string; email?: string };
        const { url: checkoutUrl } = await createSubscriptionCheckout(deps.stripe, deps.cfg, { plan: body.plan ?? '', email: body.email?.trim() || undefined });
        return send(res, 200, { url: checkoutUrl });
      }

      if (route === 'POST /api/stripe/webhook') {
        if (!deps.cfg.secretKey) return send(res, 503, { error: 'payments not configured yet' });
        const raw = await readBody(req, 256 * 1024);
        let event;
        try {
          event = verifyEvent(deps.stripe, deps.cfg, raw, String(req.headers['stripe-signature'] ?? ''));
        } catch {
          return send(res, 400, { error: 'invalid signature' });
        }
        const eventId = typeof event.id === 'string' ? event.id.trim() : '';
        if (!eventId) return send(res, 400, { error: 'invalid Stripe event' });
        if (webhookReceipts.has(eventId)) return send(res, 200, { received: true, replayed: true });

        // A valid signature only proves Stripe sent the event; it does not prove
        // this app created or can fulfil the underlying purchase. Until durable
        // server-created checkout intents exist, live/unknown events are
        // journalled for reconciliation without minting an entitlement,
        // mutating subscriptions, or contacting the supplied email address.
        if (stripeKeyMode === 'live' || stripeKeyMode === 'unknown') {
          webhookReceipts.record({ event_id: eventId, type: `quarantined:${event.type}`, processed_at: deps.now() });
          return send(res, 200, {
            received: true,
            quarantined: true,
            reason: 'live event processing is locked pending durable checkout provenance',
          });
        }

        const order = orderFromEvent(event, deps.now());
        if (order) {
          const existing = deps.orders.find(order.session_id);
          if (!existing) {
            deps.orders.record(order);
          } else {
            // A distinct Stripe event for the same Session may enrich missing
            // receipt facts, but can never move building/fulfilled work back to
            // paid_awaiting_intake or replace its immutable paid product scope.
            deps.orders.update(order.session_id, {
              email: existing.email ?? order.email,
              amount_total: existing.amount_total ?? order.amount_total,
              currency: existing.currency ?? order.currency,
              updated_at: deps.now(),
            });
          }
        }
        // Recurring-subscription lifecycle (created/updated/deleted, invoice paid/failed).
        if (deps.subscriptions) {
          const sub = subscriptionFromEvent(event, deps.now(), planResolver(deps.cfg.planIds));
          if (sub) deps.subscriptions.record(sub);
        }

        // Only acknowledge the event after every state write succeeds. The
        // receipt prevents a Stripe retry from applying the same test event
        // twice; live events take the quarantine branch above.
        webhookReceipts.record({ event_id: eventId, type: event.type, processed_at: deps.now() });
        // Test-mode customer emails are arbitrary sandbox input. They are never
        // forwarded to production onboarding/list automation.
        return send(res, 200, { received: true });
      }

      if (route === 'POST /api/subscribe') {
        if (deps.cfg.publicLeadCaptureEnabled !== true || !deps.marketing?.onLead) {
          return send(res, 503, { ok: false, synced: false, error: 'public lead capture is disabled' });
        }
        const body = JSON.parse((await readBody(req)).toString() || '{}') as { email?: string; firstName?: string };
        const email = (body.email ?? '').trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: 'a valid email is required' });
        try {
          await deps.marketing.onLead(email, body.firstName?.trim() || undefined);
          return send(res, 200, { ok: true, synced: true });
        } catch (e) {
          console.warn(`marketing onLead failed: ${(e as Error).message}`);
          return send(res, 502, { ok: false, synced: false, error: 'lead delivery failed' });
        }
      }

      if (route === 'POST /api/intake') {
        const blockers = checkoutBlockers();
        if (blockers.length) return send(res, 503, { accepted: false, error: 'build intake is not ready', blockers });
        if (!sandboxAccessGranted(req, deps.cfg)) return send(res, 401, { accepted: false, error: 'private sandbox access code required' });
        const submission = JSON.parse((await readBody(req, 1024 * 1024)).toString() || '{}') as Record<string, unknown>;
        const sessionId = typeof submission._stripe_session === 'string' ? submission._stripe_session.trim() : '';
        const intake = canonicalIntake(submission);
        if (intake.consent !== true) {
          return send(res, 200, {
            accepted: false,
            issues: [{ field: 'consent', label: 'Confirmation', reason: 'required before the intake can be accepted' }],
          });
        }
        const s0 = runS0(intake);
        if (!s0.accepted) return send(res, 200, { accepted: false, issues: s0.issues });
        if (!sessionId) return send(res, 402, { accepted: false, error: 'a paid checkout session is required' });

        const order = deps.orders.find(sessionId);
        if (!order) return send(res, 402, { accepted: false, error: 'paid checkout session not found' });
        if (order.status === 'building') {
          // Stripe's session is the idempotency key: a browser retry receives the
          // original result and can never start or provision a second build.
          return send(res, 200, { accepted: true, building: true, run: order.run_dir ?? null, duplicate: true });
        }
        if (order.status !== 'paid_awaiting_intake') {
          return send(res, 409, { accepted: false, error: 'checkout session is not available for intake' });
        }

        // Consume the paid entitlement before starting any side effect. All work
        // below is synchronous, so another request in this process observes the
        // claimed state rather than starting a duplicate pipeline.
        const claimed = deps.orders.update(sessionId, { status: 'building', updated_at: deps.now() });
        if (!claimed) return send(res, 409, { accepted: false, error: 'checkout session could not be claimed' });
        const entitlement = entitlementForOrder(claimed);
        if (!entitlement) {
          deps.orders.update(sessionId, { status: 'paid_awaiting_intake', updated_at: deps.now() });
          return send(res, 409, { accepted: false, error: 'checkout product entitlement is invalid' });
        }

        let runRef: string;
        try {
          runRef = deps.kickPipeline(intake, claimed, entitlement);
        } catch (e) {
          // A synchronous launch failure has not produced a usable run. Restore
          // the entitlement so the customer can safely submit again.
          deps.orders.update(sessionId, { status: 'paid_awaiting_intake', updated_at: deps.now() });
          throw e;
        }
        deps.orders.update(sessionId, { run_dir: runRef, updated_at: deps.now() });
        // Provision the client's portal login in the background (never fails the intake).
        if (deps.onIntakeAccepted && entitlement.portalAccess) {
          // Identity comes from Stripe's verified checkout event, never from a
          // caller-controlled intake field. A missing receipt email defers portal
          // provisioning instead of risking an account for the wrong person.
          try { deps.onIntakeAccepted(intake, claimed.email); } catch (e) { console.warn(`onIntakeAccepted failed: ${(e as Error).message}`); }
        }
        return send(res, 200, { accepted: true, building: true, run: runRef });
      }

      return send(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof BodyTooLargeError) return send(res, 413, { error: e.message });
      if (e instanceof CheckoutError || e instanceof SyntaxError) return send(res, 400, { error: e.message });
      return send(res, 500, { error: (e as Error).message });
    }
  };
}
