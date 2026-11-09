/** Founder-authorised catalogue (v3 plus the 4 November 2026 go-live). Gated offers have no purchase journey. */
export const MHP_BRAND = 'martin_howard_property';
export const MHP_ORGANIZATION_ID = 'ba41b1a4-9752-4dbf-8312-d04a0f03d0b8';
export const MHP_ORIGIN = 'https://app.martinhowardproperty.co.uk';
export const MHP_SITE = 'https://martinhowardproperty.co.uk';
export const MHP_TERMS_URL = `${MHP_SITE}/terms/`;
export const MHP_PRIVATE_TERMS_URL = `${MHP_SITE}/mentoring/private-terms/`;
export const MHP_REFUND_DAYS = 30;
export const MHP_READ_ONLY_DAYS = 7;
export interface MhpGrants { crm: boolean; enquirySite: boolean; emailWorkflow: boolean; leadrelay: boolean }
const none: MhpGrants = { crm: false, enquirySite: false, emailWorkflow: false, leadrelay: false };
const desk: MhpGrants = { ...none, crm: true, enquirySite: true };
const advanced: MhpGrants = { ...desk, emailWorkflow: true, leadrelay: true };
/**
 * Availability:
 * - standard: list price. The course is sold through the public course checkout.
 * - window: webinar price. A checkout can be created only before the window ends.
 * - private: never linked publicly. The owner sends a single-use link from /hq/applications.
 * - gated: no purchase journey; receipts are rejected. manual: /hq grant or invoice only.
 */
export type MhpAvailability = 'standard' | 'window' | 'private' | 'gated' | 'manual';
export const MHP_CATALOG = [
  { sku: 'mhp_deal_desk', name: 'The Deal Desk', type: 'kit', pricePence: 4700, refundDays: 14, interval: null, instalments: null, availability: 'standard', grants: desk },
  { sku: 'mhp_course', name: 'Property Done Properly', type: 'course', pricePence: 149700, refundDays: 30, interval: null, instalments: null, availability: 'standard', grants: desk },
  { sku: 'mhp_course_3x', name: 'Property Done Properly, 3 monthly payments', type: 'course', pricePence: 52500, refundDays: 30, interval: 'month', instalments: 3, availability: 'standard', grants: desk },
  { sku: 'mhp_course_web', name: 'Property Done Properly, webinar price', type: 'course', pricePence: 99700, refundDays: 30, interval: null, instalments: null, availability: 'window', grants: desk },
  { sku: 'mhp_course_web_3x', name: 'Property Done Properly, webinar price, 3 monthly payments', type: 'course', pricePence: 34900, refundDays: 30, interval: 'month', instalments: 3, availability: 'window', grants: desk },
  { sku: 'mhp_room_monthly', name: 'Members’ Room, monthly', type: 'membership', pricePence: 6700, refundDays: 30, interval: 'month', instalments: null, availability: 'standard', grants: desk },
  { sku: 'mhp_room_annual', name: 'Members’ Room, annual', type: 'membership', pricePence: 67000, refundDays: 30, interval: 'year', instalments: null, availability: 'standard', grants: desk },
  { sku: 'mhp_room_founders', name: 'Members’ Room, eligible founder rate', type: 'membership', pricePence: 4700, refundDays: 30, interval: 'month', instalments: null, availability: 'gated', grants: desk },
  { sku: 'mhp_mentoring', name: 'One Lane Mentoring', type: 'cohort', pricePence: 399700, refundDays: 30, interval: null, instalments: null, availability: 'private', grants: advanced },
  { sku: 'mhp_mentoring_6x', name: 'One Lane Mentoring, 6 monthly payments', type: 'cohort', pricePence: 69900, refundDays: 30, interval: 'month', instalments: 6, availability: 'private', grants: advanced },
  { sku: 'mhp_mentoring_early', name: 'One Lane Mentoring, founding price', type: 'cohort', pricePence: 299700, refundDays: 30, interval: null, instalments: null, availability: 'private', grants: advanced },
  { sku: 'mhp_mentoring_early_6x', name: 'One Lane Mentoring, founding price, 6 monthly payments', type: 'cohort', pricePence: 52500, refundDays: 30, interval: 'month', instalments: 6, availability: 'private', grants: advanced },
  // Private refunds follow its written terms (full refund up to the first session), so there is no self-serve refund window.
  { sku: 'mhp_private', name: 'One Lane Private', type: 'cohort', pricePence: 2500000, refundDays: 0, interval: null, instalments: null, availability: 'private', grants: advanced },
  { sku: 'mhp_private_12x', name: 'One Lane Private, 12 monthly payments', type: 'cohort', pricePence: 225000, refundDays: 0, interval: 'month', instalments: 12, availability: 'private', grants: advanced },
  { sku: 'mhp_partnership', name: 'Property Partnership', type: 'partnership', pricePence: 750000, refundDays: 30, interval: null, instalments: null, availability: 'manual', grants: advanced },
] as const;
export type MhpSku = typeof MHP_CATALOG[number]['sku'];
export type MhpProduct = typeof MHP_CATALOG[number];
export const MHP_STANDARD_CATALOG = MHP_CATALOG.filter(p => p.availability === 'standard');
export const MHP_PAID_CATALOG = MHP_CATALOG.filter(p => p.availability !== 'manual');
/** Products a signed receipt may record. Gated and manual products never have a purchase journey. */
export function mhpSellable(product: MhpProduct): boolean {
  return product.availability === 'standard' || product.availability === 'window' || product.availability === 'private';
}
export const MHP_SELLABLE_CATALOG = MHP_CATALOG.filter(mhpSellable);
export function mhpProduct(sku: string): MhpProduct | undefined { return MHP_CATALOG.find(p => p.sku === sku); }
export function mhpPriceEnvironmentName(sku: MhpSku): string { return `MHP_STRIPE_PRICE_${sku.slice(4).toUpperCase()}`; }
export const MHP_STRIPE_EVENTS = ['checkout.session.completed', 'invoice.paid', 'invoice.payment_failed',
  'customer.subscription.updated', 'customer.subscription.deleted', 'charge.refunded'] as const;

/** Whole plan cost, shown before payment. */
export function mhpPlanTotalPence(product: MhpProduct): number { return product.pricePence * (product.instalments ?? 1); }
export function mhpPounds(pence: number): string {
  return `£${(pence / 100).toLocaleString('en-GB', { minimumFractionDigits: pence % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}
/** Plain price statement used on Stripe Checkout and in HQ. */
export function mhpPriceStatement(product: MhpProduct): string {
  if (!product.instalments) return `${mhpPounds(product.pricePence)} paid once.`;
  return `${product.instalments} monthly payments of ${mhpPounds(product.pricePence)}, ${mhpPounds(mhpPlanTotalPence(product))} in total. `
    + `Payments stop automatically after the ${product.instalments === 3 ? 'third' : product.instalments === 6 ? 'sixth' : 'twelfth'}.`;
}

/** Webinar price window ends 19:30 GMT on Wednesday 11 November 2026 (GMT is UTC in November). */
export const MHP_COURSE_WINDOW_ENDS_AT = '2026-11-11T19:30:00.000Z';
/** Founding mentoring price: applications received by Saturday 7 November 2026, 23:59 GMT. */
export const MHP_FOUNDING_APPLICATIONS_BEFORE = '2026-11-08T00:00:00.000Z';
/**
 * The window end in milliseconds. A sandbox (test-mode) key may move it with
 * MHP_COURSE_WINDOW_ENDS_AT to prove the cut-over; a live key always uses the
 * founder-approved moment, so a stray variable can never extend live pricing.
 */
export function mhpCourseWindowEndsAt(env: NodeJS.ProcessEnv, live: boolean): number {
  const fixed = Date.parse(MHP_COURSE_WINDOW_ENDS_AT);
  const override = env.MHP_COURSE_WINDOW_ENDS_AT?.trim();
  if (!override || live) return fixed;
  const parsed = Date.parse(override);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?Z$/.test(override) || !Number.isFinite(parsed)) {
    throw new Error('MHP_COURSE_WINDOW_ENDS_AT must be an ISO UTC time');
  }
  return parsed;
}
export type MhpCoursePlan = 'full' | '3x';
/** The course SKU the public checkout sells at a moment. Server time decides, never the browser. */
export function mhpCourseSku(plan: MhpCoursePlan, at: number, windowEndsAt: number): MhpSku {
  const window = at < windowEndsAt;
  if (plan === 'full') return window ? 'mhp_course_web' : 'mhp_course';
  return window ? 'mhp_course_web_3x' : 'mhp_course_3x';
}
/** Offers the owner can send from /hq/applications, in the order HQ lists them. */
export const MHP_PRIVATE_OFFERS = ['mhp_mentoring_early', 'mhp_mentoring_early_6x', 'mhp_mentoring', 'mhp_mentoring_6x', 'mhp_private', 'mhp_private_12x'] as const;
export type MhpPrivateOffer = typeof MHP_PRIVATE_OFFERS[number];
export function mhpFoundingOffer(sku: string): boolean { return sku === 'mhp_mentoring_early' || sku === 'mhp_mentoring_early_6x'; }
/** Founding prices only for applications received before the founding deadline. */
export function mhpPrivateOfferAllowed(sku: string, applicationReceivedAt: string): sku is MhpPrivateOffer {
  if (!(MHP_PRIVATE_OFFERS as readonly string[]).includes(sku)) return false;
  if (!mhpFoundingOffer(sku)) return true;
  const received = Date.parse(applicationReceivedAt);
  return Number.isFinite(received) && received < Date.parse(MHP_FOUNDING_APPLICATIONS_BEFORE);
}
