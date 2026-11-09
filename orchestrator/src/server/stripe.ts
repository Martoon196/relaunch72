/**
 * Stripe integration logic — structurally decoupled from the SDK via StripeLike,
 * so every path here tests with a fake client and no key. The real `stripe`
 * import lives only in index.ts.
 */

import type { StripeConfig } from './config.js';
import { TIER_PRICE_ENV, PLAN_PRICE_ENV } from './config.js';
import type { Order } from './orders.js';
import { isCheckoutTier } from './entitlements.js';

/** The slice of the Stripe SDK we touch. The real client is structurally assignable. */
export interface StripeLike {
  checkout: { sessions: { create(params: Record<string, unknown>): Promise<{ id: string; url: string | null }> } };
  webhooks: { constructEvent(payload: string | Buffer, sig: string, secret: string): StripeEvent };
  /** Present on the real client; used for the "manage billing" customer portal. */
  billingPortal?: { sessions: { create(params: Record<string, unknown>): Promise<{ url: string | null }> } };
}

export interface StripeEvent {
  id?: string;
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
  if (!isCheckoutTier(req.tier) || (req.bump && req.tier !== 'core')) {
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

export interface SubscriptionCheckoutRequest { plan: string; email?: string }

/**
 * A recurring-subscription Checkout Session (mode:'subscription'). Stamps the
 * plan + email onto `subscription_data.metadata` so the later
 * customer.subscription.* webhooks can resolve which account and plan they are.
 */
export async function createSubscriptionCheckout(
  stripe: StripeLike,
  cfg: StripeConfig,
  req: SubscriptionCheckoutRequest,
): Promise<{ url: string }> {
  if (!req.plan || !(req.plan in cfg.planIds)) {
    throw new CheckoutError(`unknown plan "${req.plan}"`);
  }
  const price = cfg.planIds[req.plan];
  if (!price) throw new CheckoutError(`no Stripe price configured for plan "${req.plan}" — set ${PLAN_PRICE_ENV[req.plan]} in env`);
  const email = req.email?.trim();
  const subMeta: Record<string, string> = { plan: req.plan };
  if (email) subMeta.email = email;

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    ...(email ? { customer_email: email } : {}),
    success_url: `${cfg.publicBaseUrl}/portal?plan=${encodeURIComponent(req.plan)}&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${cfg.publicBaseUrl}/pricing.html?plan=${encodeURIComponent(req.plan)}`,
    subscription_data: { metadata: subMeta },
    metadata: { plan: req.plan },
  });
  if (!session.url) throw new CheckoutError('Stripe returned a session with no URL');
  return { url: session.url };
}

/** A Stripe billing-portal session URL, so an existing customer can change or cancel their plan. */
export async function createBillingPortalUrl(stripe: StripeLike, cfg: StripeConfig, customerId: string): Promise<string> {
  if (!stripe.billingPortal) throw new CheckoutError('billing portal not available');
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${cfg.publicBaseUrl}/portal/billing`,
  });
  if (!session.url) throw new CheckoutError('Stripe returned a billing-portal session with no URL');
  return session.url;
}

/** Verify the webhook signature and return the parsed event (throws on a bad sig). */
export function verifyEvent(stripe: StripeLike, cfg: StripeConfig, rawBody: string | Buffer, sig: string): StripeEvent {
  return stripe.webhooks.constructEvent(rawBody, sig, cfg.webhookSecret);
}

/**
 * Map a successfully paid, one-off Checkout Session to an Order. Subscription
 * Checkout emits the same event type, so both mode and payment state are hard
 * requirements before this can become a build entitlement.
 */
export function orderFromEvent(event: StripeEvent, at: string): Order | null {
  if (event.type !== 'checkout.session.completed') return null;
  const s = (event.data?.object ?? {}) as Record<string, unknown>;
  if (s.mode !== 'payment' || s.payment_status !== 'paid') return null;
  if (typeof s.id !== 'string' || !s.id.trim()) return null;
  const meta = (s.metadata ?? {}) as Record<string, string>;
  const tier = typeof meta.tier === 'string' ? meta.tier : '';
  const bump = meta.bump === '1';
  if (!isCheckoutTier(tier) || (bump && tier !== 'core')) return null;
  const cust = (s.customer_details ?? {}) as Record<string, unknown>;
  return {
    session_id: s.id,
    tier,
    bump,
    email: (typeof cust.email === 'string' ? cust.email : (s.customer_email as string)) ?? null,
    amount_total: typeof s.amount_total === 'number' ? s.amount_total : null,
    currency: typeof s.currency === 'string' ? s.currency : null,
    status: 'paid_awaiting_intake',
    paid_at: at,
  };
}
