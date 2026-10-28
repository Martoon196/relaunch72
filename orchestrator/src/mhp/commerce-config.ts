import { MHP_CATALOG, mhpPriceEnvironmentName, type MhpSku } from './catalog.js';

export interface MhpCommerceConfig {
  secretKey: string; accountId: string; webhookSecret: string; live: boolean;
  prices: Readonly<Partial<Record<MhpSku, string>>>; portalConfigurationId: string;
}
/** No fallback to the Property Predator Stripe account or global STRIPE_* keys. */
export function mhpCommerceConfig(env: NodeJS.ProcessEnv): MhpCommerceConfig | null {
  if (env.MHP_BILLING_ENABLED !== 'true') return null;
  const secretKey = env.MHP_STRIPE_SECRET_KEY?.trim() ?? '';
  const accountId = env.MHP_STRIPE_ACCOUNT_ID?.trim() ?? '';
  const webhookSecret = env.MHP_STRIPE_WEBHOOK_SECRET?.trim() ?? '';
  const portalConfigurationId = env.MHP_STRIPE_PORTAL_CONFIGURATION_ID?.trim() ?? '';
  if (!/^rk_(test|live)_[A-Za-z0-9]+$/.test(secretKey) || !/^acct_[A-Za-z0-9]+$/.test(accountId)
    || !/^whsec_[A-Za-z0-9]+$/.test(webhookSecret) || !/^bpc_[A-Za-z0-9]+$/.test(portalConfigurationId)) {
    throw new Error('MHP billing configuration is incomplete');
  }
  const prices: Partial<Record<MhpSku, string>> = {};
  for (const product of MHP_CATALOG) {
    const price = env[mhpPriceEnvironmentName(product.sku)]?.trim() ?? '';
    if (product.availability === 'manual') {
      if (price) throw new Error('Manual MHP products must not have a Stripe price');
      continue;
    }
    if (!price && product.availability === 'gated') continue;
    if (!/^price_[A-Za-z0-9]+$/.test(price)) throw new Error('MHP price configuration is incomplete');
    prices[product.sku] = price;
  }
  if (new Set(Object.values(prices)).size !== Object.keys(prices).length) throw new Error('MHP prices must be distinct');
  return { secretKey, accountId, webhookSecret, portalConfigurationId, live: secretKey.startsWith('rk_live_'), prices };
}
