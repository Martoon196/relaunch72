/**
 * Immutable product entitlements derived from the verified Stripe Order.
 * Browser query parameters and intake fields never choose the build scope.
 */

import type { Order } from './orders.js';

export type ProductKey = 'autopsy' | 'core' | 'core_bump' | 'pro';

export interface BuildEntitlement {
  product: ProductKey;
  /** Last automated S-stage this purchase may run. */
  through: 'S1' | 'S9';
  /** Whether this purchase includes creation of the ongoing client portal. */
  portalAccess: boolean;
  /** Human/manual fulfilment that must not be presented as automated. */
  manualFulfilment: readonly string[];
}

const ENTITLEMENTS: Record<ProductKey, BuildEntitlement> = {
  autopsy: {
    product: 'autopsy',
    through: 'S1',
    portalAccess: false,
    manualFulfilment: ['human review and sign-off of the marketing audit'],
  },
  core: {
    product: 'core',
    through: 'S9',
    portalAccess: true,
    manualFulfilment: ['human sign-off', 'one revision round'],
  },
  core_bump: {
    product: 'core_bump',
    through: 'S9',
    portalAccess: true,
    manualFulfilment: [
      'human sign-off',
      'one revision round',
      '60 additional days of social content',
      '12 additional emails',
    ],
  },
  pro: {
    product: 'pro',
    through: 'S9',
    portalAccess: true,
    manualFulfilment: [
      'human sign-off',
      'one revision round',
      '90-minute strategy session',
      'hand-written hero assets',
      'implementation roadmap',
      '30 days of support',
    ],
  },
};

export const CHECKOUT_TIERS = ['autopsy', 'core', 'pro'] as const;

export function isCheckoutTier(value: string): value is (typeof CHECKOUT_TIERS)[number] {
  return (CHECKOUT_TIERS as readonly string[]).includes(value);
}

/** Return null for legacy/tampered orders whose product metadata is not valid. */
export function entitlementForOrder(order: Pick<Order, 'tier' | 'bump'>): BuildEntitlement | null {
  if (!isCheckoutTier(order.tier)) return null;
  if (order.bump && order.tier !== 'core') return null;
  const key: ProductKey = order.tier === 'core' && order.bump ? 'core_bump' : order.tier;
  return ENTITLEMENTS[key];
}
