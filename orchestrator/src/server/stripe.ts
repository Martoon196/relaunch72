/**
 * Stripe integration logic — structurally decoupled from the SDK via StripeLike,
 * so every path here tests with a fake client and no key. The real `stripe`
 * import lives only in index.ts.
 */

import type { StripeConfig } from './config.js';
import { TIER_PRICE_ENV } from './config.js';
import type { Order } from './orders.js';

/** The slice of the Stripe SDK we touch. The real client is structurally assignable. */
export interface StripeLike {
  checkout: { sessions: { create(params: Record<string, unknown>): Promise<{ id: string; url: string | null }> } };
  webhooks: { constructEvent(payload: string | Buffer, sig: string, secret: string): StripeEvent };
}

export interface StripeEvent {
  type: string;
  data?: { object?: Record<string, unknown> };
}

export interface CheckoutRequest { tier: string; bump?: boolean }

export class CheckoutError extends Error {}

/** Core order-bump collapses to its own price key; every other tier maps 1:1. */
export function priceKeyFor(req: CheckoutRequest): string {
  return req.tier === 'core' && req.bump ? 'core_bump' : req.tier;
}

export async function createCheckoutSession(
  stripe: StripeLike,
  cfg: StripeConfig,
  req: CheckoutRequest,
): Promise<{ url: string }> {
  if (!req.tier || !(priceKeyFor(req) in cfg.priceIds)) {
    throw new CheckoutError(`unknown tier "${req.tier}"`);
  }
  const key = priceKeyFor(req);
  const price = cfg.priceIds[key];
  if (!price) throw new CheckoutError(`no Stripe price configured for "${key}" — set ${TIER_PRICE_ENV[key]} in env`);

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price, quantity: 1 }],
    success_url: `${cfg.publicBaseUrl}/intake/?tier=${encodeURIComponent(req.tier)}&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${cfg.publicBaseUrl}/checkout.html?tier=${encodeURIComponent(req.tier)}`,
    metadata: { tier: req.tier, bump: req.bump ? '1' : '0' },
  });
  if (!session.url) throw new CheckoutError('Stripe returned a session with no URL');
  return { url: session.url };
}

/** Verify the webhook signature and return the parsed event (throws on a bad sig). */
export function verifyEvent(stripe: StripeLike, cfg: StripeConfig, rawBody: string | Buffer, sig: string): StripeEvent {
  return stripe.webhooks.constructEvent(rawBody, sig, cfg.webhookSecret);
}

/** Map a completed-checkout event to an Order; null for every other event type. */
export function orderFromEvent(event: StripeEvent, at: string): Order | null {
  if (event.type !== 'checkout.session.completed') return null;
  const s = (event.data?.object ?? {}) as Record<string, unknown>;
  const meta = (s.metadata ?? {}) as Record<string, string>;
  const cust = (s.customer_details ?? {}) as Record<string, unknown>;
  return {
    session_id: String(s.id ?? ''),
    tier: meta.tier ?? 'core',
    bump: meta.bump === '1',
    email: (typeof cust.email === 'string' ? cust.email : (s.customer_email as string)) ?? null,
    amount_total: typeof s.amount_total === 'number' ? s.amount_total : null,
    currency: typeof s.currency === 'string' ? s.currency : null,
    status: 'paid_awaiting_intake',
    paid_at: at,
  };
}
