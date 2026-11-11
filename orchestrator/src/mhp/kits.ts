/**
 * Module kits: one module's field guide, calculator and lessons, sold on their own (MHP-KITS-001).
 * Mirrors martinhowardproperty.co.uk/assets/kits.json, which only displays prices. This file decides
 * what is charged: the server clock picks a launch price while it lasts, never the browser.
 * Module 4 (raising investor finance) is a One Lane Mentoring resource and is never sold on its own.
 */
export interface MhpKit {
  readonly kit: string; readonly module: number; readonly moduleSlug: string; readonly name: string;
  readonly pricePence: number; readonly introPricePence: number | null; readonly introEndsAt: string | null;
}
export const MHP_KITS: readonly MhpKit[] = Object.freeze([
  { kit: "property-from-the-beginning", module: 0, moduleSlug: "property-from-the-beginning", name: "First Purchase Kit", pricePence: 4700, introPricePence: null, introEndsAt: null },
  { kit: "one-lane-pick-your-door", module: 1, moduleSlug: "one-lane-pick-your-door", name: "Pick Your Door Kit", pricePence: 4700, introPricePence: null, introEndsAt: null },
  { kit: "bridging-finance-done-properly", module: 2, moduleSlug: "bridging-finance-done-properly", name: "Bridging Kit", pricePence: 9700, introPricePence: null, introEndsAt: null },
  { kit: "assisted-sales-and-creative-structures", module: 3, moduleSlug: "assisted-sales-and-creative-structures", name: "Creative Structures Kit", pricePence: 9700, introPricePence: null, introEndsAt: null },
  { kit: "brrr", module: 5, moduleSlug: "brrr", name: "BRRR Kit", pricePence: 9700, introPricePence: null, introEndsAt: null },
  { kit: "title-splitting", module: 6, moduleSlug: "title-splitting", name: "Title Splitting Kit", pricePence: 9700, introPricePence: null, introEndsAt: null },
  { kit: "commercial-conversions", module: 7, moduleSlug: "commercial-conversions", name: "Commercial Conversion Kit", pricePence: 9700, introPricePence: null, introEndsAt: null },
  { kit: "running-it-as-a-business", module: 8, moduleSlug: "running-it-as-a-business", name: "Property Business Kit", pricePence: 9700, introPricePence: null, introEndsAt: null },
  { kit: "doing-it-properly", module: 9, moduleSlug: "doing-it-properly", name: "Compliance Kit", pricePence: 9700, introPricePence: null, introEndsAt: null },
  { kit: "land-and-planning-gain", module: 10, moduleSlug: "land-and-planning-gain", name: "Planning Gain Kit", pricePence: 9700, introPricePence: null, introEndsAt: null },
  { kit: "deal-sourcing-and-packaging-done-compliantly", module: 11, moduleSlug: "deal-sourcing-and-packaging-done-compliantly", name: "Deal Sourcing Kit", pricePence: 9700, introPricePence: null, introEndsAt: null },
  { kit: "hmos-wales-first", module: 12, moduleSlug: "hmos-wales-first", name: "HMO Kit", pricePence: 9700, introPricePence: null, introEndsAt: null },
  { kit: "serviced-accommodation-and-rent-to-rent-honestly", module: 13, moduleSlug: "serviced-accommodation-and-rent-to-rent-honestly", name: "Serviced Accommodation Kit", pricePence: 9700, introPricePence: null, introEndsAt: null },
  { kit: "auctions-and-legal-packs", module: 14, moduleSlug: "auctions-and-legal-packs", name: "Auction Kit", pricePence: 9700, introPricePence: null, introEndsAt: null },
  { kit: "off-market-lead-generation", module: 15, moduleSlug: "off-market-lead-generation", name: "Off-Market Leads Kit", pricePence: 9700, introPricePence: null, introEndsAt: null },
  { kit: "land-finding-and-site-assembly", module: 16, moduleSlug: "land-finding-and-site-assembly", name: "Site Assembly Kit", pricePence: 9700, introPricePence: null, introEndsAt: null },
  { kit: "wales-lettings-law-for-investors", module: 17, moduleSlug: "wales-lettings-law-for-investors", name: "Welsh Lettings Law Kit", pricePence: 9700, introPricePence: null, introEndsAt: null },
  { kit: "building-regulations-and-sign-off-wales-and-england", module: 18, moduleSlug: "building-regulations-and-sign-off-wales-and-england", name: "Building Regs Kit", pricePence: 9700, introPricePence: null, introEndsAt: null },
  { kit: "energy-sap-and-epcs", module: 19, moduleSlug: "energy-sap-and-epcs", name: "EPC Kit", pricePence: 9700, introPricePence: null, introEndsAt: null },
  { kit: "testing-to-pass-air-tightness-ventilation-sound", module: 20, moduleSlug: "testing-to-pass-air-tightness-ventilation-sound", name: "Testing to Pass Kit", pricePence: 9700, introPricePence: null, introEndsAt: null },
  { kit: "ground-and-environment-what-the-searches-tell-you", module: 21, moduleSlug: "ground-and-environment-what-the-searches-tell-you", name: "Searches Kit", pricePence: 9700, introPricePence: null, introEndsAt: null },
  { kit: "money-the-game-the-mechanics-and-your-head", module: 22, moduleSlug: "money-the-game-the-mechanics-and-your-head", name: "Money Kit", pricePence: 9700, introPricePence: null, introEndsAt: null },
  { kit: "insurance-cover-that-pays-for-every-door", module: 23, moduleSlug: "insurance-cover-that-pays-for-every-door", name: "Insurance Kit", pricePence: 9700, introPricePence: null, introEndsAt: null },
  { kit: "tenure-leaseholds-freeholds-and-the-odd-ones", module: 24, moduleSlug: "tenure-leaseholds-freeholds-and-the-odd-ones", name: "Leasehold Kit", pricePence: 9700, introPricePence: null, introEndsAt: null },
  { kit: "land-gap", module: 25, moduleSlug: "unregistered-and-ownerless-land", name: "Land Gap Kit", pricePence: 9700, introPricePence: 2700, introEndsAt: "2026-11-15T23:59:00Z" },
]);
/** The Land Gap Kit also opens the replay of the webinar it was launched in. */
export const MHP_KIT_REPLAYS: Readonly<Record<string, string>> = Object.freeze({ 'land-gap': 'the-land-nobody-seems-to-own-04f856' });
export const MHP_KIT_SLUG = /^[a-z0-9-]{1,80}$/;
export function mhpKit(slug: string): MhpKit | undefined { return MHP_KITS.find(k => k.kit === slug); }
/** The two-digit module number the training centre uses. */
export function mhpKitModule(kit: MhpKit): string { return String(kit.module).padStart(2, '0'); }
/** The price at this moment: a launch price until its exact end, then the standard price. No extensions. */
export function mhpKitPrice(kit: MhpKit, at: number): { pricePence: number; intro: boolean; endsAt: number | null } {
  const end = kit.introEndsAt ? Date.parse(kit.introEndsAt) : NaN;
  if (kit.introPricePence !== null && Number.isFinite(end) && at < end) return { pricePence: kit.introPricePence, intro: true, endsAt: end };
  return { pricePence: kit.pricePence, intro: false, endsAt: null };
}
/** Two more kits for the price of one: the higher standard price of the two, once. Launch prices do not apply. */
export function mhpKitPairPrice(a: MhpKit, b: MhpKit): number { return Math.max(a.pricePence, b.pricePence); }
export const MHP_SELLER_FOOTER = 'Martin Howard Property is a trading name of MH196 Ltd, company number 15060897, registered in England and Wales, '
  + '5 Clothier Meadow, Castle Cary, Somerset BA7 7HA. Education, not legal, tax or financial advice.';
