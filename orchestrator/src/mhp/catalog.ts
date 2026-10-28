/** Founder-authorised v3 catalogue. Gated offers have no enabled purchase journey. */
export const MHP_BRAND = 'martin_howard_property';
export const MHP_ORGANIZATION_ID = 'ba41b1a4-9752-4dbf-8312-d04a0f03d0b8';
export const MHP_ORIGIN = 'https://app.martinhowardproperty.co.uk';
export const MHP_REFUND_DAYS = 30;
export const MHP_READ_ONLY_DAYS = 7;
export interface MhpGrants { crm: boolean; enquirySite: boolean; emailWorkflow: boolean; leadrelay: boolean }
const none: MhpGrants = { crm: false, enquirySite: false, emailWorkflow: false, leadrelay: false };
const desk: MhpGrants = { ...none, crm: true, enquirySite: true };
const advanced: MhpGrants = { ...desk, emailWorkflow: true, leadrelay: true };
export const MHP_CATALOG = [
  { sku: 'mhp_deal_desk', name: 'The Deal Desk', type: 'kit', pricePence: 4700, refundDays: 14, interval: null, instalments: null, availability: 'gated', grants: none },
  { sku: 'mhp_course', name: 'Property Investor Course', type: 'course', pricePence: 149700, refundDays: 30, interval: null, instalments: null, availability: 'standard', grants: desk },
  { sku: 'mhp_course_3x', name: 'Property Investor Course — 3 monthly payments', type: 'course', pricePence: 52500, refundDays: 30, interval: 'month', instalments: 3, availability: 'standard', grants: desk },
  { sku: 'mhp_course_web', name: 'Property Investor Course — eligible webinar or referral offer', type: 'course', pricePence: 99700, refundDays: 30, interval: null, instalments: null, availability: 'gated', grants: desk },
  { sku: 'mhp_course_web_3x', name: 'Property Investor Course — eligible webinar offer, 3 monthly payments', type: 'course', pricePence: 34900, refundDays: 30, interval: 'month', instalments: 3, availability: 'gated', grants: desk },
  { sku: 'mhp_room_monthly', name: 'Members’ Room — monthly', type: 'membership', pricePence: 6700, refundDays: 30, interval: 'month', instalments: null, availability: 'standard', grants: desk },
  { sku: 'mhp_room_annual', name: 'Members’ Room — annual', type: 'membership', pricePence: 67000, refundDays: 30, interval: 'year', instalments: null, availability: 'standard', grants: desk },
  { sku: 'mhp_room_founders', name: 'Members’ Room — eligible founder rate', type: 'membership', pricePence: 4700, refundDays: 30, interval: 'month', instalments: null, availability: 'gated', grants: desk },
  { sku: 'mhp_mentoring', name: 'Property Mentoring', type: 'cohort', pricePence: 399700, refundDays: 30, interval: null, instalments: null, availability: 'standard', grants: advanced },
  { sku: 'mhp_mentoring_6x', name: 'Property Mentoring — 6 monthly payments', type: 'cohort', pricePence: 69900, refundDays: 30, interval: 'month', instalments: 6, availability: 'standard', grants: advanced },
  { sku: 'mhp_mentoring_early', name: 'Property Mentoring — eligible early application offer', type: 'cohort', pricePence: 299700, refundDays: 30, interval: null, instalments: null, availability: 'gated', grants: advanced },
  { sku: 'mhp_mentoring_early_6x', name: 'Property Mentoring — eligible early offer, 6 monthly payments', type: 'cohort', pricePence: 52500, refundDays: 30, interval: 'month', instalments: 6, availability: 'gated', grants: advanced },
  { sku: 'mhp_partnership', name: 'Property Partnership', type: 'partnership', pricePence: 750000, refundDays: 30, interval: null, instalments: null, availability: 'manual', grants: advanced },
] as const;
export type MhpSku = typeof MHP_CATALOG[number]['sku'];
export type MhpProduct = typeof MHP_CATALOG[number];
export const MHP_STANDARD_CATALOG = MHP_CATALOG.filter(p => p.availability === 'standard');
export const MHP_PAID_CATALOG = MHP_CATALOG.filter(p => p.availability !== 'manual');
export function mhpProduct(sku: string): MhpProduct | undefined { return MHP_CATALOG.find(p => p.sku === sku); }
export function mhpPriceEnvironmentName(sku: MhpSku): string { return `MHP_STRIPE_PRICE_${sku.slice(4).toUpperCase()}`; }
export const MHP_STRIPE_EVENTS = ['checkout.session.completed', 'invoice.paid', 'invoice.payment_failed',
  'customer.subscription.updated', 'customer.subscription.deleted', 'charge.refunded'] as const;
