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

export interface PlanItem extends CatalogItem {
  interval: 'month' | 'year'; // recurring cadence
}

/**
 * The recurring marketing-platform plans — the £-a-month subscription that turns
 * a one-off pack into an ongoing "we are your marketing platform" relationship.
 * Placeholder pricing the founder edits; these amounts are never shown to a
 * customer as a quote (they exist only to create Stripe recurring prices).
 */
export const PLANS: PlanItem[] = [
  { key: 'platform_starter', lookupKey: 'r72_platform_starter', name: 'Relaunch72 Platform — Starter', description: 'Your AI marketing manager: a fresh content cluster, keyword research and ad drafts every month.', amount: 14900, interval: 'month' },
  { key: 'platform_growth',  lookupKey: 'r72_platform_growth',  name: 'Relaunch72 Platform — Growth',  description: 'Starter plus scheduled social publishing and a live campaign each month.',              amount: 29900, interval: 'month' },
  { key: 'platform_pro',     lookupKey: 'r72_platform_pro',     name: 'Relaunch72 Platform — Pro',     description: 'Growth plus managed ad spend and priority human review.',                                amount: 59900, interval: 'month' },
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
 * Create any missing products/prices for a set of items; reuse the rest. Shared
 * by the one-off catalog and the recurring plans — `recurringFor` returns the
 * `recurring: { interval }` block for a plan, or undefined for a one-off price.
 */
async function provisionItems(
  stripe: StripeCatalogLike,
  items: CatalogItem[],
  currency: string,
  recurringFor: (item: CatalogItem) => { interval: string } | undefined,
  log: (m: string) => void,
): Promise<ProvisionResult> {
  const priceIds: Record<string, string> = {};
  const created: string[] = [];
  const reused: string[] = [];
  for (const item of items) {
    const existing = await stripe.prices.list({ lookup_keys: [item.lookupKey], active: true, limit: 1 });
    if (existing.data[0]) {
      priceIds[item.key] = existing.data[0].id;
      reused.push(item.key);
      log(`reused ${item.key} → ${existing.data[0].id}`);
      continue;
    }
    const product = await stripe.products.create({ name: item.name, description: item.description });
    const recurring = recurringFor(item);
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: item.amount,
      currency,
      lookup_key: item.lookupKey,
      ...(recurring ? { recurring } : {}),
    });
    priceIds[item.key] = price.id;
    created.push(item.key);
    const per = recurring ? `/${recurring.interval}` : '';
    log(`created ${item.key} → ${price.id} ($${(item.amount / 100).toFixed(2)}${per})`);
  }
  return { priceIds, created, reused };
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
  return provisionItems(stripe, CATALOG, currency, () => undefined, log);
}

/**
 * Create any missing recurring plan prices; reuse the rest. Returns the
 * plan-key→priceId map (STRIPE_PLAN_*). Each price is created as a recurring
 * subscription price at the plan's interval.
 */
export async function provisionPlans(
  stripe: StripeCatalogLike,
  currency = 'usd',
  log: (m: string) => void = () => {},
): Promise<ProvisionResult> {
  return provisionItems(stripe, PLANS, currency, (item) => ({ interval: (item as PlanItem).interval }), log);
}

/**
 * Resolve the price IDs the server should run with. If ANY are already supplied
 * (STRIPE_PRICE_* set manually), that's treated as the manual path — returned
 * unchanged, no Stripe calls. Otherwise the catalog is provisioned from the key
 * and the created/reused IDs returned. Lets the founder set only the secret key
 * and have the four prices appear on boot. Provisioning errors propagate.
 */
export async function ensureCatalogPrices(
  stripe: StripeCatalogLike,
  provided: Record<string, string>,
  currency = 'usd',
  log: (m: string) => void = () => {},
): Promise<ProvisionResult & { provisioned: boolean }> {
  if (Object.values(provided).some(Boolean)) {
    return { priceIds: { ...provided }, created: [], reused: [], provisioned: false };
  }
  const r = await provisionCatalog(stripe, currency, log);
  return { ...r, provisioned: true };
}

/** As ensureCatalogPrices, but for the recurring platform plans (STRIPE_PLAN_*). */
export async function ensurePlanPrices(
  stripe: StripeCatalogLike,
  provided: Record<string, string>,
  currency = 'usd',
  log: (m: string) => void = () => {},
): Promise<ProvisionResult & { provisioned: boolean }> {
  if (Object.values(provided).some(Boolean)) {
    return { priceIds: { ...provided }, created: [], reused: [], provisioned: false };
  }
  const r = await provisionPlans(stripe, currency, log);
  return { ...r, provisioned: true };
}
