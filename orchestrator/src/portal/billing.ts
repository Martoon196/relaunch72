/**
 * The portal's billing view — resolves a logged-in tenant to "what plan are they
 * on, is it active, and what can they subscribe to?" by joining the account (for
 * the tenant's email) to the subscription store (keyed by email). Pure/DI so it
 * tests without Stripe; the £0 demo tenant simply resolves to status 'none'.
 */

import { isActive, type SubscriptionStatus, type SubscriptionStore } from '../server/subscriptions.js';
import { PLANS, type PlanItem } from '../server/catalog.js';

export interface BillingPlanOption {
  key: string;
  name: string;
  description: string;
  priceLabel: string;   // e.g. "$149/mo" — placeholder pricing the founder edits
}

export interface BillingView {
  status: SubscriptionStatus | 'none';
  active: boolean;
  planKey: string | null;
  planName: string | null;
  currentPeriodEnd: string | null;  // ISO, if known
  customerId: string | null;        // for the Stripe "manage billing" portal
  email: string | null;
  options: BillingPlanOption[];      // plans available to subscribe to
}

function priceLabel(p: PlanItem): string {
  return `$${(p.amount / 100).toFixed(0)}/${p.interval === 'month' ? 'mo' : 'yr'}`;
}

/** The purchasable plans, formatted for the billing screen. */
export function planOptions(): BillingPlanOption[] {
  return PLANS.map((p) => ({ key: p.key, name: p.name, description: p.description, priceLabel: priceLabel(p) }));
}

/** Human plan name for a resolved plan key (falls back to the key itself). */
export function planNameFor(planKey: string | null): string | null {
  if (!planKey) return null;
  return PLANS.find((p) => p.key === planKey)?.name ?? planKey;
}

/**
 * Build the portal billing resolver. `emailForTenant` maps a tenant id to its
 * login email (from the account store); the subscription store is queried by
 * that email. Returns status 'none' for a tenant with no subscription.
 */
export function makeBilling(
  subscriptions: SubscriptionStore,
  emailForTenant: (tenantId: string) => Promise<string | null>,
): (tenantId: string) => Promise<BillingView> {
  return async function billing(tenantId: string): Promise<BillingView> {
    const email = await emailForTenant(tenantId);
    const sub = email ? subscriptions.findByEmail(email) : null;
    return {
      status: sub?.status ?? 'none',
      active: isActive(sub),
      planKey: sub?.plan ?? null,
      planName: planNameFor(sub?.plan ?? null),
      currentPeriodEnd: sub?.current_period_end ?? null,
      customerId: sub?.customer_id ?? null,
      email,
      options: planOptions(),
    };
  };
}
