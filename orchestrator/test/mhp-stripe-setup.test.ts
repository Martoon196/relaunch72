import test from 'node:test';
import assert from 'node:assert/strict';
import type Stripe from 'stripe';
import { MHP_BRAND, MHP_PAID_CATALOG, MHP_ORIGIN, MHP_STRIPE_EVENTS } from '../src/mhp/catalog.js';
import { setupMhpStripe } from '../src/mhp/stripe-setup.js';

function fakeStripe(options: { names?: 'old' | 'current' } = {}) {
  const products = MHP_PAID_CATALOG;
  const updates: { id: string; active: boolean }[] = [];
  const renamed: string[] = [];
  // Old reusable v3 links (some active) plus one owner-sent applicant link and another brand's link.
  const links: { id: string; active: boolean; metadata: Record<string, string> }[] = [
    ...products.map((p, i) => ({ id: `plink_${p.sku}`, active: i % 2 === 0, metadata: { brand: MHP_BRAND, sku: p.sku, terms_version: '3' } })),
    { id: 'plink_offer', active: true, metadata: { brand: MHP_BRAND, sku: 'mhp_mentoring', mhp_offer_link: '1' } },
    { id: 'plink_other_brand', active: true, metadata: { brand: 'property_predator', sku: 'core' } },
  ];
  const price = (sku: string) => { const p = products.find(p => p.sku === sku)!; return { id: `price_${sku}`, active: true, product: `${sku}_v3`, currency: 'gbp', unit_amount: p.pricePence, livemode: false, recurring: p.interval ? { interval: p.interval, interval_count: 1 } : null }; };
  const stripe = {
    accounts: { retrieve: async () => ({ id: 'acct_mhp' }) },
    products: {
      retrieve: async (id: string) => { const p = products.find(p => id === `${p.sku}_v3`)!; assert.ok(p); return { id, livemode: false, name: options.names === 'old' ? 'Property Investor Course' : p.name, metadata: { brand: MHP_BRAND, sku: p.sku, refund_days: String(p.refundDays) } }; },
      update: async (id: string, args: { name: string }) => { renamed.push(id); const p = products.find(p => id === `${p.sku}_v3`)!; return { id, livemode: false, name: args.name, metadata: { brand: MHP_BRAND, sku: p.sku, refund_days: String(p.refundDays) } }; },
    },
    prices: { list: async (args: { lookup_keys: string[] }) => ({ data: [price(args.lookup_keys[0]!.split(':').at(-1)!)], has_more: false }) },
    paymentLinks: { list: () => ({ autoPagingToArray: async () => links }),
      update: async (id: string, args: { active: boolean }) => { updates.push({ id, ...args }); const link = links.find(l => l.id === id)!; link.active = args.active; return link; } },
    webhookEndpoints: { list: async () => ({ has_more: false, data: [{ id: 'we_mhp', url: `${MHP_ORIGIN}/api/stripe/webhook`, livemode: false, api_version: '2026-06-24.dahlia', enabled_events: MHP_STRIPE_EVENTS, status: 'enabled' }] }) },
    billingPortal: { configurations: { list: async () => ({ has_more: false, data: [{ id: 'bpc_mhp', metadata: { brand: MHP_BRAND }, features: { invoice_history: { enabled: true }, subscription_cancel: { enabled: true } } }] }) } },
  };
  return { stripe: stripe as unknown as Stripe, updates, renamed, links };
}

test('setup prices every paid product and preserves every working payment link until replacement acceptance', async () => {
  const f = fakeStripe();
  const before = f.links.map(link => ({ ...link }));
  const result = await setupMhpStripe(f.stripe, 'acct_mhp', false);
  assert.equal(result.prices.length, MHP_PAID_CATALOG.length);
  assert.ok(result.environment.MHP_STRIPE_PRICE_PRIVATE_12X);
  assert.ok(result.environment.MHP_STRIPE_PRICE_COURSE_WEB);
  assert.equal('MHP_STRIPE_PRICE_PARTNERSHIP' in result.environment, false);
  assert.deepEqual(f.updates, []);
  assert.equal(f.links.find(l => l.id === 'plink_offer')!.active, true);
  assert.equal(f.links.find(l => l.id === 'plink_other_brand')!.active, true);
  assert.deepEqual(f.links, before);
  assert.deepEqual(result.reusableLinksToReview, before.filter(l => l.metadata.brand === MHP_BRAND && l.metadata.mhp_offer_link !== '1' && l.active).map(l => l.id));
  assert.equal(result.deactivatedLinks, f.updates.length);
  assert.equal(result.webhookEnabled, true);
  assert.equal(f.renamed.length, 0);
});

test('setup renames older products to the current public names', async () => {
  const f = fakeStripe({ names: 'old' });
  await setupMhpStripe(f.stripe, 'acct_mhp', false);
  assert.equal(f.renamed.length, MHP_PAID_CATALOG.length);
});

test('setup refuses a different Stripe account', async () => {
  const f = fakeStripe();
  await assert.rejects(setupMhpStripe(f.stripe, 'acct_property_predator', false), /account mismatch/);
});
