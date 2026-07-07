/**
 * The Relaunch72 product catalog + a one-shot provisioner. Given a Stripe key,
 * `provisionCatalog` creates the four products and prices via the API — no
 * dashboard clicking. Idempotent: each price carries a stable lookup_key, so
 * re-running reuses what already exists instead of duplicating it.
 */

export interface CatalogItem {
  key: string;        // internal tier/bump key (matches checkout + STRIPE_PRICE_* env)
  lookupKey: string;  // stable Stripe price lookup_key for idempotency
  name: string;
  description: string;
  amount: number;     // cents (USD)
}

export const CATALOG: CatalogItem[] = [
  { key: 'autopsy',   lookupKey: 'r72_autopsy',   name: 'Relaunch72 — Marketing Autopsy',          description: 'The marketing audit & scorecard. Credits against Core within 14 days.', amount: 9700 },
  { key: 'core',      lookupKey: 'r72_core',      name: 'Relaunch72 — Core',                       description: 'All nine deliverables in 72 hours, human signed-off, one revision included.', amount: 99700 },
  { key: 'core_bump', lookupKey: 'r72_core_bump', name: 'Relaunch72 — Core + 90-Day Content Engine', description: 'Core plus 60 more days of social and 12 more emails.', amount: 114400 },
  { key: 'pro',       lookupKey: 'r72_pro',       name: 'Relaunch72 — Pro',                         description: 'Core plus a strategy session, hand-written hero assets, roadmap and 30 days of support.', amount: 249700 },
];

/** The slice of the Stripe SDK the provisioner needs (real client satisfies it). */
export interface StripeCatalogLike {
  products: { create(p: Record<string, unknown>): Promise<{ id: string }> };
  prices: {
    create(p: Record<string, unknown>): Promise<{ id: string }>;
    list(p: Record<string, unknown>): Promise<{ data: Array<{ id: string; lookup_key?: string | null }> }>;
  };
}

export interface ProvisionResult {
  priceIds: Record<string, string>;        // key -> price id
  created: string[];                        // keys newly created this run
  reused: string[];                         // keys already present, reused
}

/**
 * Create any missing products/prices; reuse the rest. Returns the key→priceId
 * map the server needs (STRIPE_PRICE_*). Currency USD.
 */
export async function provisionCatalog(
  stripe: StripeCatalogLike,
  currency = 'usd',
  log: (m: string) => void = () => {},
): Promise<ProvisionResult> {
  const priceIds: Record<string, string> = {};
  const created: string[] = [];
  const reused: string[] = [];
  for (const item of CATALOG) {
    const existing = await stripe.prices.list({ lookup_keys: [item.lookupKey], active: true, limit: 1 });
    if (existing.data[0]) {
      priceIds[item.key] = existing.data[0].id;
      reused.push(item.key);
      log(`reused ${item.key} → ${existing.data[0].id}`);
      continue;
    }
    const product = await stripe.products.create({ name: item.name, description: item.description });
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: item.amount,
      currency,
      lookup_key: item.lookupKey,
    });
    priceIds[item.key] = price.id;
    created.push(item.key);
    log(`created ${item.key} → ${price.id} ($${(item.amount / 100).toFixed(2)})`);
  }
  return { priceIds, created, reused };
}
