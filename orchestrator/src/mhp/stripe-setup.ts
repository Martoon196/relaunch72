import Stripe from 'stripe';
import { MHP_BRAND, MHP_PAID_CATALOG, MHP_ORIGIN, MHP_STRIPE_EVENTS, mhpPriceEnvironmentName, type MhpSku } from './catalog.js';

export interface MhpStripeSetupResult {
  accountId: string; live: boolean; webhookId: string; portalConfigurationId: string;
  links: { sku: MhpSku; priceId: string; paymentLinkId: string; url: string; active: boolean; availability: 'standard' | 'gated' }[];
  environment: Record<string, string>;
}
/** Explicit operator command; never called on web process startup. No secrets are returned. */
export async function setupMhpStripe(stripe: Stripe, expectedAccount: string, live: boolean,
  activate = false): Promise<MhpStripeSetupResult> {
  const account = await stripe.accounts.retrieve(null);
  if (account.id !== expectedAccount) throw new Error('MHP Stripe account mismatch');
  const links: MhpStripeSetupResult['links'] = [];
  const environment: Record<string, string> = { MHP_STRIPE_ACCOUNT_ID: account.id };
  const existingLinks = await stripe.paymentLinks.list({ limit: 100 }).autoPagingToArray({ limit: 1000 });
  if (existingLinks.length === 1000) throw new Error('Payment Link discovery bound reached');
  // A superseded or retired MHP link must never remain a purchase route.
  for (const link of existingLinks) {
    if (link.metadata.brand === MHP_BRAND && link.active
      && (link.metadata.terms_version !== '3' || !MHP_PAID_CATALOG.some(p => p.sku === link.metadata.sku && p.availability === 'standard'))) {
      await stripe.paymentLinks.update(link.id, { active: false });
      link.active = false;
    }
  }
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
    const prices = await stripe.prices.list({ lookup_keys: [`mhp:v3:${product.sku}`], limit: 2 });
    if (prices.data.length > 1 || prices.has_more) throw new Error('Ambiguous MHP price');
    const price = prices.data[0] ?? await stripe.prices.create({ product: remote.id, currency: 'gbp', unit_amount: product.pricePence,
      lookup_key: `mhp:v3:${product.sku}`, ...(product.interval ? { recurring: { interval: product.interval, interval_count: 1 } } : {}),
      metadata: { brand: MHP_BRAND, sku: product.sku } }, { idempotencyKey: `mhp-price-v3:${product.sku}` });
    if (price.livemode !== live || price.unit_amount !== product.pricePence || price.currency !== 'gbp' || price.product !== remote.id
      || (price.recurring?.interval ?? null) !== product.interval || (price.recurring && price.recurring.interval_count !== 1)) throw new Error('MHP price terms mismatch');
    environment[mhpPriceEnvironmentName(product.sku)] = price.id;
    const matches = existingLinks.filter(link => link.metadata.brand === MHP_BRAND && link.metadata.sku === product.sku && link.metadata.terms_version === '3');
    if (matches.length > 1) throw new Error('Ambiguous MHP Payment Link');
    let link = matches[0];
    if (!link) {
      link = await stripe.paymentLinks.create({ line_items: [{ price: price.id, quantity: 1 }],
        after_completion: { type: 'redirect', redirect: { url: 'https://martinhowardproperty.co.uk/thanks/' } },
        billing_address_collection: 'required', name_collection: { individual: { enabled: true, optional: false } },
        allow_promotion_codes: false, metadata: { brand: MHP_BRAND, sku: product.sku, terms_version: '3' },
        ...(product.interval
          ? { subscription_data: { metadata: { brand: MHP_BRAND, sku: product.sku },
              ...(product.instalments ? { description: `${product.instalments} monthly payments of GBP ${(product.pricePence / 100).toFixed(2)}; payments stop automatically.` } : {}) } }
          : { customer_creation: 'always' as const, invoice_creation: { enabled: true } }) },
      { idempotencyKey: `mhp-payment-link-v3:${product.sku}` });
      // Stripe's create endpoint has no `active` parameter. Disable immediately,
      // before returning or publishing the secret-unpredictable URL.
      link = await stripe.paymentLinks.update(link.id, { active: false });
    }
    if (product.availability === 'gated' && link.active) link = await stripe.paymentLinks.update(link.id, { active: false });
    const lineItems = await stripe.paymentLinks.listLineItems(link.id, { limit: 2 });
    if (link.livemode !== live || lineItems.has_more || lineItems.data.length !== 1 || lineItems.data[0]?.price?.id !== price.id
      || lineItems.data[0]?.quantity !== 1 || link.allow_promotion_codes || link.billing_address_collection !== 'required'
      || link.after_completion.type !== 'redirect' || link.after_completion.redirect?.url !== 'https://martinhowardproperty.co.uk/thanks/') throw new Error('MHP Payment Link terms mismatch');
    links.push({ sku: product.sku, priceId: price.id, paymentLinkId: link.id, url: link.url, active: link.active, availability: product.availability });
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
  if (activate) {
    if (!matchingEndpoints[0] || endpoint.status !== 'enabled') throw new Error('Connect and rehearse the existing webhook before activating links');
    for (const link of links) {
      if (link.availability === 'standard' && !link.active) {
        const updated = await stripe.paymentLinks.update(link.paymentLinkId, { active: true });
        link.active = updated.active;
      }
    }
  }
  environment.MHP_STRIPE_PORTAL_CONFIGURATION_ID = portal.id;
  return { accountId: account.id, live, webhookId: endpoint.id, portalConfigurationId: portal.id, links, environment };
}
