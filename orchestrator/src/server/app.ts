/**
 * The Stripe backend as a dependency-injected request handler, so routes test
 * without a socket, a key, or the pipeline. Routes:
 *   GET  /health               — liveness + test/live mode
 *   GET  /ready                — fail-closed production traffic readiness
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
import {
  PROPERTY_PREDATOR_EXTERNAL_EVENT_PATH,
  type PropertyPredatorExternalEventBridgeMount,
} from '../integrations/external-events/router.js';
import {
  PROPERTY_PREDATOR_MAILGUN_WEBHOOK_PATH,
  type PropertyPredatorMailgunWebhookMount,
} from '../integrations/mailgun-webhook/router.js';
import {
  PROPERTY_PREDATOR_MAILGUN_INBOUND_PATH,
  type PropertyPredatorMailgunInboundMount,
} from '../integrations/mailgun-inbound/router.js';
import {
  PROPERTY_PREDATOR_SIMULATED_META_DM_INBOUND_PATH,
  PROPERTY_PREDATOR_SIMULATED_WHATSAPP_INBOUND_PATH,
  type PropertyPredatorSimulatedMetaDmInboundMount,
  type PropertyPredatorSimulatedWhatsAppInboundMount,
} from '../integrations/simulated-inbound/router.js';
import {
  isPropertyPredatorProviderIngressPath,
  type PropertyPredatorProviderIngressMount,
} from '../integrations/provider-ingress/index.js';
import {
  PROPERTY_PREDATOR_ZERNIO_ACCOUNT_WEBHOOK_PATH,
  type PropertyPredatorZernioAccountWebhookMount,
} from '../integrations/zernio-account-webhook/router.js';
import {
  PROPERTY_PREDATOR_ZERNIO_INBOUND_PATH,
  type PropertyPredatorZernioInboundMount,
} from '../integrations/zernio-inbound/index.js';
import {
  isPropertyPredatorApprovedSocialMediaPath,
  type PropertyPredatorApprovedSocialMediaGateway,
} from '../public-social-outbound/approved-social-media-gateway.js';

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
  /** Per-process no-queue shield in front of the distributed portal guard. */
  portalMaxConcurrentRequests?: number;
  /** Safe operator-facing reasons the optional portal could not be mounted. */
  portalBlockers?: string[];
  /**
   * Fired (fire-and-forget) after a paid intake is claimed. The verified order,
   * especially its Stripe Session id, is the provisioning authority and
   * idempotency key; caller-controlled intake fields are never account authority.
   */
  onIntakeAccepted?: (intake: Intake, order: Order) => void | Promise<void>;
  /** Optional recurring-subscription store; absent = subscription events are ignored. */
  subscriptions?: SubscriptionStore;
  /**
   * Processed Stripe-event ids. Production defaults to a file-backed journal
   * under dataDir; tests can inject the in-memory implementation.
   */
  webhookReceipts?: WebhookReceiptStore;
  /** Extra boot-time reasons a build cannot safely start (for example no AI key). */
  buildBlockers?: string[];
  /** Process-level production release blockers, already reduced to safe labels. */
  serviceReadinessBlockers?: readonly string[];
  /** Optional cached live dependency probe used only by /ready, never /health. */
  runtimeReadinessProbe?: () => Promise<readonly string[]>;
  /** Exact public Host accepted for every route other than liveness/readiness. */
  canonicalHost?: string;
  /** Truthful execution mode exposed by health for accepted builds. */
  buildMode?: 'mock' | 'live';
  /** Optional, disabled-by-default Property Predator receipt-only source bridge. */
  propertyPredatorExternalEvents?: PropertyPredatorExternalEventBridgeMount;
  /** Optional, disabled-by-default signed Mailgun delivery-evidence ingress. */
  propertyPredatorMailgunWebhook?: PropertyPredatorMailgunWebhookMount;
  /** Optional, disabled-by-default owned-office Mailgun reply ingress. */
  propertyPredatorMailgunInbound?: PropertyPredatorMailgunInboundMount;
  /** Optional, disabled-by-default signed non-routable WhatsApp TEST ingress. */
  propertyPredatorSimulatedWhatsAppInbound?: PropertyPredatorSimulatedWhatsAppInboundMount;
  /** Optional, disabled-by-default signed non-routable Facebook/Instagram DM TEST ingress. */
  propertyPredatorSimulatedMetaDmInbound?: PropertyPredatorSimulatedMetaDmInboundMount;
  /** Optional, inbound-only Meta/Whereby provider callbacks; never an outbound client. */
  propertyPredatorProviderIngress?: PropertyPredatorProviderIngressMount;
  /** Optional signed Zernio account lifecycle receipts; no outbound provider operation. */
  propertyPredatorZernioAccountWebhook?: PropertyPredatorZernioAccountWebhookMount;
  /** Optional signed Zernio Instagram DM/comment receipts; no outbound provider operation. */
  propertyPredatorZernioInbound?: PropertyPredatorZernioInboundMount;
  /** Public signed exact-byte gateway; it never exposes the source adapter bearer. */
  propertyPredatorApprovedSocialMediaGateway?: PropertyPredatorApprovedSocialMediaGateway;
  /** Optional request-handler seam; production defaults to the bundled admin router. */
  adminHandler?: (req: IncomingMessage, res: ServerResponse, cfg: StripeConfig) => void | Promise<void>;
}

const SAFE_ERROR = {
  bodyTooLarge: { error: 'request body too large' },
  invalidRequest: { error: 'invalid request' },
  internal: { error: 'internal server error' },
} as const;

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

function sendPortalUnavailable(res: ServerResponse): void {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relaunch72 — Workspace unavailable</title><style>body{margin:0;background:#f4f6f8;color:#16202e;font:16px/1.55 system-ui,sans-serif}main{min-height:100vh;display:grid;place-items:center;padding:24px}.card{max-width:560px;background:#fff;border:1px solid #dce2e9;border-radius:18px;padding:32px;box-shadow:0 14px 40px rgba(22,32,46,.08)}.mark{display:inline-grid;place-items:center;width:42px;height:42px;border-radius:12px;background:#16202e;color:#fff;font-weight:850}h1{font-size:1.65rem;line-height:1.2;margin:22px 0 10px}p{color:#596575;margin:0 0 18px}a{color:#9b5e06;font-weight:750}</style></head><body><main><section class="card" aria-labelledby="portal-status-title"><span class="mark" aria-hidden="true">R72</span><h1 id="portal-status-title">Your workspace is temporarily unavailable.</h1><p>The secure portal did not pass its startup checks. No legacy fallback was used and no customer action was processed.</p><a href="/portal">Try the workspace again</a></section></main></body></html>`;
  res.writeHead(503, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'retry-after': '30',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function sendPortalRuntimeStatus(res: ServerResponse, code: 429 | 503): void {
  const body = code === 429
    ? 'Too many portal requests are active. Try again shortly.'
    : 'The secure portal request could not be completed. Try again shortly.';
  res.writeHead(code, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'retry-after': code === 429 ? '1' : '5',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
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
  const portalMaxConcurrentRequests = deps.portalMaxConcurrentRequests ?? 32;
  if (!Number.isSafeInteger(portalMaxConcurrentRequests)
      || portalMaxConcurrentRequests < 1 || portalMaxConcurrentRequests > 1_024) {
    throw new Error('Portal process concurrency bound is invalid');
  }
  let activePortalRequests = 0;

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;

    // Render's health probes must remain available before custom-DNS cutover,
    // but every operational surface is host-bound. Never redirect a mismatched
    // Host: a fixed 421 avoids reflecting attacker-controlled proxy headers.
    if (deps.canonicalHost && route !== 'GET /health' && route !== 'GET /ready') {
      const rawHost = typeof req.headers.host === 'string'
        ? req.headers.host.trim().toLowerCase()
        : '';
      const requestHost = rawHost.replace(/:\d+$/, '');
      if (requestHost !== deps.canonicalHost) {
        return send(res, 421, { error: 'misdirected request' });
      }
    }

    // The custom domain is the front door to Growth HQ. Keep the bare origin
    // useful instead of exposing the API router's JSON 404 to a human visitor.
    // `/portal` owns the authentication redirect, so this remains same-origin
    // and never leaks a setup token or reflects an untrusted Host header.
    if (route === 'GET /') {
      res.writeHead(302, {
        location: '/portal',
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }

    // Zernio fetches approved Instagram/LinkedIn media server-to-server. This
    // public route has no cookie or adapter credential: the short-lived signed
    // path is bound to one immutable source key/hash/MIME tuple.
    if (isPropertyPredatorApprovedSocialMediaPath(url.pathname)) {
      if (!deps.propertyPredatorApprovedSocialMediaGateway) {
        return send(res, 404, { error: 'not found' });
      }
      await deps.propertyPredatorApprovedSocialMediaGateway.handle(req, res, url);
      return;
    }

    // The admin control room is same-origin, browser-navigated HTML — handled
    // before the CORS/API layer, with its own auth gate.
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      try { await (deps.adminHandler ?? handleAdmin)(req, res, deps.cfg); }
      catch { if (!res.headersSent) send(res, 500, SAFE_ERROR.internal); }
      return;
    }

    // The client portal — same-origin, browser-navigated HTML, its own tenant
    // auth gate. Only mounted when portal deps are provided.
    if (url.pathname === '/portal' || url.pathname.startsWith('/portal/')) {
      if (!deps.portal) {
        if (deps.portalBlockers?.length) sendPortalUnavailable(res);
        else send(res, 404, { error: 'portal not enabled' });
        return;
      }
      if (activePortalRequests >= portalMaxConcurrentRequests) {
        sendPortalRuntimeStatus(res, 429);
        return;
      }
      activePortalRequests += 1;
      try { await handlePortal(req, res, deps.portal); }
      catch { if (!res.headersSent) sendPortalRuntimeStatus(res, 503); }
      finally { activePortalRequests -= 1; }
      return;
    }

    applyCors(req, res, deps.cfg.allowedOrigins);
    try {
      // CORS preflight: the browser asks before the real POST from the site.
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (route === 'GET /ready') {
        const blockers = [...(deps.serviceReadinessBlockers ?? [])];
        if (!deps.portal) {
          blockers.push(...(deps.portalBlockers ?? ['client portal is not mounted']));
        }
        const externalEvents = deps.propertyPredatorExternalEvents;
        if (externalEvents?.enabled && !externalEvents.ready) {
          blockers.push(...externalEvents.blockers.map((blocker) => `Property Predator external events: ${blocker}`));
          if (externalEvents.blockers.length === 0) {
            blockers.push('Property Predator external events are enabled but not ready');
          }
        }
        const mailgunWebhook = deps.propertyPredatorMailgunWebhook;
        if (mailgunWebhook?.enabled && !mailgunWebhook.ready) {
          blockers.push(...mailgunWebhook.blockers.map((blocker) => `Mailgun webhook: ${blocker}`));
          if (mailgunWebhook.blockers.length === 0) {
            blockers.push('Mailgun webhook is enabled but not ready');
          }
        }
        const mailgunInbound = deps.propertyPredatorMailgunInbound;
        if (mailgunInbound?.enabled && !mailgunInbound.ready) {
          blockers.push(...mailgunInbound.blockers.map((blocker) => `Mailgun inbound: ${blocker}`));
          if (mailgunInbound.blockers.length === 0) {
            blockers.push('Mailgun inbound is enabled but not ready');
          }
        }
        const simulatedWhatsApp = deps.propertyPredatorSimulatedWhatsAppInbound;
        if (simulatedWhatsApp?.enabled && !simulatedWhatsApp.ready) {
          blockers.push(...simulatedWhatsApp.blockers.map((blocker) =>
            `Simulated WhatsApp inbound: ${blocker}`));
          if (simulatedWhatsApp.blockers.length === 0) {
            blockers.push('Simulated WhatsApp inbound is enabled but not ready');
          }
        }
        const simulatedMetaDm = deps.propertyPredatorSimulatedMetaDmInbound;
        if (simulatedMetaDm?.enabled && !simulatedMetaDm.ready) {
          blockers.push(...simulatedMetaDm.blockers.map((blocker) =>
            `Simulated Meta DM inbound: ${blocker}`));
          if (simulatedMetaDm.blockers.length === 0) {
            blockers.push('Simulated Meta DM inbound is enabled but not ready');
          }
        }
        const providerIngress = deps.propertyPredatorProviderIngress;
        if (providerIngress?.enabled && !providerIngress.ready) {
          blockers.push(...providerIngress.blockers.map((blocker) =>
            `Provider inbound: ${blocker}`));
          if (providerIngress.blockers.length === 0) {
            blockers.push('Provider inbound is enabled but not ready');
          }
        }
        const zernioWebhook = deps.propertyPredatorZernioAccountWebhook;
        if (zernioWebhook?.enabled && !zernioWebhook.ready) {
          blockers.push(...zernioWebhook.blockers.map((blocker) =>
            `Zernio account webhook: ${blocker}`));
          if (zernioWebhook.blockers.length === 0) {
            blockers.push('Zernio account webhook is enabled but not ready');
          }
        }
        const zernioInbound = deps.propertyPredatorZernioInbound;
        if (zernioInbound?.enabled && !zernioInbound.ready) {
          blockers.push(...zernioInbound.blockers.map((blocker) =>
            `Zernio inbound: ${blocker}`));
          if (zernioInbound.blockers.length === 0) {
            blockers.push('Zernio inbound is enabled but not ready');
          }
        }
        if (deps.runtimeReadinessProbe) {
          try {
            blockers.push(...await deps.runtimeReadinessProbe());
          } catch {
            blockers.push('Protected runtime readiness probe failed');
          }
        }
        return send(res, blockers.length === 0 ? 200 : 503, {
          ready: blockers.length === 0,
          blockers,
        });
      }

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
          service_ready: (deps.serviceReadinessBlockers ?? []).length === 0,
          service_readiness_blockers: [...(deps.serviceReadinessBlockers ?? [])],
          portal_ready: Boolean(deps.portal),
          portal_blockers: deps.portal ? [] : [...(deps.portalBlockers ?? ['client portal is not mounted'])],
          ...(deps.propertyPredatorExternalEvents ? {
            property_predator_external_events: {
              enabled: deps.propertyPredatorExternalEvents.enabled,
              ready: deps.propertyPredatorExternalEvents.ready,
              blockers: [...deps.propertyPredatorExternalEvents.blockers],
            },
          } : {}),
          ...(deps.propertyPredatorMailgunWebhook ? {
            property_predator_mailgun_webhook: {
              enabled: deps.propertyPredatorMailgunWebhook.enabled,
              ready: deps.propertyPredatorMailgunWebhook.ready,
              blockers: [...deps.propertyPredatorMailgunWebhook.blockers],
            },
          } : {}),
          ...(deps.propertyPredatorMailgunInbound ? {
            property_predator_mailgun_inbound: {
              enabled: deps.propertyPredatorMailgunInbound.enabled,
              ready: deps.propertyPredatorMailgunInbound.ready,
              blockers: [...deps.propertyPredatorMailgunInbound.blockers],
              recipient_scope: 'owned-office-proof-only',
            },
          } : {}),
          ...(deps.propertyPredatorSimulatedWhatsAppInbound ? {
            property_predator_simulated_whatsapp_inbound: {
              enabled: deps.propertyPredatorSimulatedWhatsAppInbound.enabled,
              ready: deps.propertyPredatorSimulatedWhatsAppInbound.ready,
              blockers: [...deps.propertyPredatorSimulatedWhatsAppInbound.blockers],
            },
          } : {}),
          ...(deps.propertyPredatorSimulatedMetaDmInbound ? {
            property_predator_simulated_meta_dm_inbound: {
              enabled: deps.propertyPredatorSimulatedMetaDmInbound.enabled,
              ready: deps.propertyPredatorSimulatedMetaDmInbound.ready,
              blockers: [...deps.propertyPredatorSimulatedMetaDmInbound.blockers],
            },
          } : {}),
          ...(deps.propertyPredatorProviderIngress ? {
            property_predator_provider_ingress: {
              enabled: deps.propertyPredatorProviderIngress.enabled,
              ready: deps.propertyPredatorProviderIngress.ready,
              blockers: [...deps.propertyPredatorProviderIngress.blockers],
              paths: [...deps.propertyPredatorProviderIngress.paths],
              provider_effects_enabled: false,
            },
          } : {}),
          ...(deps.propertyPredatorZernioAccountWebhook ? {
            property_predator_zernio_account_webhook: {
              enabled: deps.propertyPredatorZernioAccountWebhook.enabled,
              ready: deps.propertyPredatorZernioAccountWebhook.ready,
              blockers: [...deps.propertyPredatorZernioAccountWebhook.blockers],
              provider_effects_enabled: false,
            },
          } : {}),
          ...(deps.propertyPredatorZernioInbound ? {
            property_predator_zernio_inbound: {
              enabled: deps.propertyPredatorZernioInbound.enabled,
              ready: deps.propertyPredatorZernioInbound.ready,
              blockers: [...deps.propertyPredatorZernioInbound.blockers],
              provider_effects_enabled: false,
            },
          } : {}),
          approved_social_media_gateway: {
            ready: Boolean(deps.propertyPredatorApprovedSocialMediaGateway),
            credential_exposure: false,
            exact_bytes: true,
          },
        });
      }

      if (route === `POST ${PROPERTY_PREDATOR_ZERNIO_ACCOUNT_WEBHOOK_PATH}`) {
        const webhook = deps.propertyPredatorZernioAccountWebhook;
        if (!webhook?.enabled) return send(res, 404, { error: 'not_found' });
        if (!webhook.ready || !webhook.handle) {
          return send(res, 503, { error: 'zernio_account_webhook_unavailable' });
        }
        try {
          await webhook.handle(req, res);
        } catch {
          if (!res.headersSent) send(res, 503, { error: 'zernio_account_webhook_unavailable' });
        }
        return;
      }

      if (route === `POST ${PROPERTY_PREDATOR_ZERNIO_INBOUND_PATH}`) {
        const webhook = deps.propertyPredatorZernioInbound;
        if (!webhook?.enabled) return send(res, 404, { error: 'not_found' });
        if (!webhook.ready || !webhook.handle) {
          return send(res, 503, { error: 'zernio_inbound_unavailable' });
        }
        try {
          await webhook.handle(req, res);
        } catch {
          if (!res.headersSent) send(res, 503, { error: 'zernio_inbound_unavailable' });
        }
        return;
      }

      if (isPropertyPredatorProviderIngressPath(url.pathname)) {
        const ingress = deps.propertyPredatorProviderIngress;
        if (!ingress?.enabled) return send(res, 404, { error: 'not_found' });
        if (!ingress.ready || !ingress.handle || !ingress.ownsPath(url.pathname)) {
          return send(res, 503, { error: 'provider_ingress_unavailable' });
        }
        try {
          await ingress.handle(req, res);
        } catch {
          if (!res.headersSent) send(res, 503, { error: 'provider_ingress_unavailable' });
        }
        return;
      }

      if (route === `POST ${PROPERTY_PREDATOR_SIMULATED_WHATSAPP_INBOUND_PATH}`) {
        const webhook = deps.propertyPredatorSimulatedWhatsAppInbound;
        if (!webhook?.enabled) return send(res, 404, { error: 'not_found' });
        if (!webhook.ready || !webhook.handle) {
          return send(res, 503, { error: 'simulated_whatsapp_inbound_unavailable' });
        }
        try {
          await webhook.handle(req, res);
        } catch {
          if (!res.headersSent) {
            send(res, 503, { error: 'simulated_whatsapp_inbound_unavailable' });
          }
        }
        return;
      }

      if (route === `POST ${PROPERTY_PREDATOR_SIMULATED_META_DM_INBOUND_PATH}`) {
        const webhook = deps.propertyPredatorSimulatedMetaDmInbound;
        if (!webhook?.enabled) return send(res, 404, { error: 'not_found' });
        if (!webhook.ready || !webhook.handle) {
          return send(res, 503, { error: 'simulated_meta_dm_inbound_unavailable' });
        }
        try {
          await webhook.handle(req, res);
        } catch {
          if (!res.headersSent) {
            send(res, 503, { error: 'simulated_meta_dm_inbound_unavailable' });
          }
        }
        return;
      }

      if (route === `POST ${PROPERTY_PREDATOR_MAILGUN_WEBHOOK_PATH}`) {
        const webhook = deps.propertyPredatorMailgunWebhook;
        if (!webhook?.enabled) return send(res, 404, { error: 'not_found' });
        if (!webhook.ready || !webhook.handle) {
          return send(res, 503, { error: 'mailgun_webhook_unavailable' });
        }
        try {
          await webhook.handle(req, res);
        } catch {
          if (!res.headersSent) send(res, 503, { error: 'mailgun_webhook_unavailable' });
        }
        return;
      }

      if (route === `POST ${PROPERTY_PREDATOR_MAILGUN_INBOUND_PATH}`) {
        const inbound = deps.propertyPredatorMailgunInbound;
        if (!inbound?.enabled) return send(res, 404, { error: 'not_found' });
        if (!inbound.ready || !inbound.handle) {
          return send(res, 503, { error: 'mailgun_inbound_unavailable' });
        }
        try {
          await inbound.handle(req, res);
        } catch {
          if (!res.headersSent) send(res, 503, { error: 'mailgun_inbound_unavailable' });
        }
        return;
      }

      if (route === `POST ${PROPERTY_PREDATOR_EXTERNAL_EVENT_PATH}`) {
        const bridge = deps.propertyPredatorExternalEvents;
        if (!bridge?.enabled) return send(res, 404, { error: 'not_found' });
        // A mounted handler stays callable while health is degraded so an
        // exact signed retry can repair a receipt-first partial projection.
        // Startup failures have no handler and remain closed.
        if (!bridge.handle) {
          return send(res, 503, { error: 'external_event_bridge_unavailable' });
        }
        try {
          await bridge.handle(req, res);
        } catch {
          if (!res.headersSent) send(res, 503, { error: 'external_event_bridge_unavailable' });
        }
        return;
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
        } catch {
          console.warn('marketing onLead failed');
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
          try {
            void Promise.resolve(deps.onIntakeAccepted(intake, claimed))
              .catch(() => console.warn('onIntakeAccepted failed'));
          } catch {
            console.warn('onIntakeAccepted failed');
          }
        }
        return send(res, 200, { accepted: true, building: true, run: runRef });
      }

      return send(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof BodyTooLargeError) return send(res, 413, SAFE_ERROR.bodyTooLarge);
      if (e instanceof CheckoutError || e instanceof SyntaxError) return send(res, 400, SAFE_ERROR.invalidRequest);
      return send(res, 500, SAFE_ERROR.internal);
    }
  };
}
