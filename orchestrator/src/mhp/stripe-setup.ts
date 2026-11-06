import Stripe from 'stripe';
import { MHP_BRAND, MHP_PAID_CATALOG, MHP_ORIGIN, MHP_STRIPE_EVENTS, mhpPriceEnvironmentName, type MhpAvailability, type MhpSku } from './catalog.js';

export interface MhpStripeSetupResult {
  accountId: string; live: boolean; webhookId: string; webhookEnabled: boolean; portalConfigurationId: string;
  prices: { sku: MhpSku; priceId: string; availability: MhpAvailability }[];
  /** Setup never retires a working purchase route. */
  deactivatedLinks: number;
  reusableLinksToReview: string[];
  environment: Record<string, string>;
}
/**
 * Explicit operator command; never called on web process startup. No secrets are returned.
 * Creates or reuses the MHP products, GBP prices, webhook endpoint and billing portal.
 * Purchases no longer use reusable Payment Links: the course uses a server-created
 * checkout and mentoring/Private use single-use applicant links from /hq/applications.
 * Older reusable links remain active until replacement checkout is verified live.
 */
export async function setupMhpStripe(stripe: Stripe, expectedAccount: string, live: boolean): Promise<MhpStripeSetupResult> {
  const account = await stripe.accounts.retrieve(null);
  if (account.id !== expectedAccount) throw new Error('MHP Stripe account mismatch');
  const environment: Record<string, string> = { MHP_STRIPE_ACCOUNT_ID: account.id };
  const existingLinks = await stripe.paymentLinks.list({ limit: 100 }).autoPagingToArray({ limit: 1000 });
  if (existingLinks.length === 1000) throw new Error('Payment Link discovery bound reached');
  const deactivatedLinks = 0;
  const reusableLinksToReview = existingLinks.filter(link => link.metadata.brand === MHP_BRAND
    && link.metadata.mhp_offer_link !== '1' && link.active).map(link => link.id);
  const prices: MhpStripeSetupResult['prices'] = [];
  for (const product of MHP_PAID_CATALOG) {
    const productId = `${product.sku}_v3`;
    let remote: Stripe.Product;
    try {
      const p = await stripe.products.retrieve(productId);
      if (p.deleted) throw new Error('An MHP product was deleted; operator review is required');
      remote = p;
    } catch (error) {
      if (!(error instanceof Stripe.errors.StripeInvalidRequestError) || error.code !== 'resource_missing') throw error;
      remote = await stripe.products.create({ id: productId, name: product.name,
        metadata: { brand: MHP_BRAND, sku: product.sku, refund_days: String(product.refundDays), terms_version: '3' } },
      { idempotencyKey: `mhp-product-v3:${product.sku}` });
    }
    if (remote.livemode !== live || remote.metadata.sku !== product.sku || remote.metadata.brand !== MHP_BRAND) throw new Error('MHP product provenance mismatch');
    // Checkout shows the product name, so keep it on the current public name.
    if (remote.name !== product.name || remote.metadata.refund_days !== String(product.refundDays)) {
      remote = await stripe.products.update(remote.id, { name: product.name, metadata: { refund_days: String(product.refundDays) } });
    }
    const found = await stripe.prices.list({ lookup_keys: [`mhp:v3:${product.sku}`], limit: 2 });
    if (found.data.length > 1 || found.has_more) throw new Error('Ambiguous MHP price');
    const price = found.data[0] ?? await stripe.prices.create({ product: remote.id, currency: 'gbp', unit_amount: product.pricePence,
      lookup_key: `mhp:v3:${product.sku}`, ...(product.interval ? { recurring: { interval: product.interval, interval_count: 1 } } : {}),
      metadata: { brand: MHP_BRAND, sku: product.sku } }, { idempotencyKey: `mhp-price-v3:${product.sku}` });
    if (price.livemode !== live || !price.active || price.unit_amount !== product.pricePence || price.currency !== 'gbp' || price.product !== remote.id
      || (price.recurring?.interval ?? null) !== product.interval || (price.recurring && price.recurring.interval_count !== 1)) throw new Error('MHP price terms mismatch');
    environment[mhpPriceEnvironmentName(product.sku)] = price.id;
    prices.push({ sku: product.sku, priceId: price.id, availability: product.availability });
  }
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  if (endpoints.has_more) throw new Error('Webhook discovery bound reached');
  const endpointUrl = `${MHP_ORIGIN}/api/stripe/webhook`;
  const matchingEndpoints = endpoints.data.filter(endpoint => endpoint.url === endpointUrl);
  if (matchingEndpoints.length > 1) throw new Error('Multiple MHP webhook endpoints found');
  const endpoint = matchingEndpoints[0] ?? await stripe.webhookEndpoints.create({ url: endpointUrl,
    enabled_events: [...MHP_STRIPE_EVENTS], api_version: '2026-06-24.dahlia',
    metadata: { brand: MHP_BRAND }, description: 'MHP member purchases and entitlements' },
  { idempotencyKey: 'mhp-webhook-v1' });
  if (endpoint.livemode !== live || endpoint.api_version !== '2026-06-24.dahlia'
    || MHP_STRIPE_EVENTS.some(event => !endpoint.enabled_events.includes(event))) throw new Error('MHP webhook configuration mismatch');
  const portalConfigs = await stripe.billingPortal.configurations.list({ limit: 100 });
  if (portalConfigs.has_more) throw new Error('Portal configuration discovery bound reached');
  const matchingConfigs = portalConfigs.data.filter(c => c.metadata?.brand === MHP_BRAND);
  if (matchingConfigs.length > 1) throw new Error('Multiple MHP portal configurations found');
  const portal = matchingConfigs[0] ?? await stripe.billingPortal.configurations.create({
    name: 'Martin Howard Property', metadata: { brand: MHP_BRAND }, default_return_url: `${MHP_ORIGIN}/app/account`,
    features: { invoice_history: { enabled: true }, payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' } } },
  { idempotencyKey: 'mhp-portal-v1' });
  if (!portal.features.invoice_history.enabled || !portal.features.subscription_cancel.enabled) throw new Error('MHP portal features incomplete');
  environment.MHP_STRIPE_PORTAL_CONFIGURATION_ID = portal.id;
  return { accountId: account.id, live, webhookId: endpoint.id, webhookEnabled: endpoint.status === 'enabled',
    portalConfigurationId: portal.id, prices, deactivatedLinks, reusableLinksToReview, environment };
}
