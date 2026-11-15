/**
 * Affiliate-product intake for the EXISTING PostgreSQL-backed Creative Studio.
 *
 * This deliberately produces a normal 'brief' source. Its destination is chosen
 * separately from the brand's confirmed conversion pages, so no browser-supplied
 * merchant link is trusted or issued. The confirmed creative-kit disclosure is
 * burned into every render and approval becomes stale if that kit changes.
 *
 * This is NOT affiliate link issuance, merchant eligibility certification,
 * sales attribution, or permission to publish. It starts no provider job.
 */
import { SeoBlogError } from '../seo-blog/types.js';
import type { CreativeBrandContext } from './brand-context.js';

export type AffiliateNetwork = 'amazon_associates' | 'other';
export interface AffiliateBriefInput {
  readonly productName: string;
  readonly merchantName: string;
  readonly network: string;
  readonly productReviewed: string;
  readonly channelEligible: string;
  readonly rightsConfirmed: string;
}

/** Reject URL/markup/control characters, claims pasted into product-name fields, and oversized values. */
function name(value: string, label: string, max: number): string {
  const clean = value.trim().replace(/\s+/gu, ' ');
  if (!clean || [...clean].length > max || /[<>\u0000-\u001f\u007f]/u.test(value)
      || /(?:https?:\/\/|www\.)/iu.test(clean)) {
    throw new SeoBlogError(400, `Enter a valid ${label} (up to ${max} characters, without links or markup).`);
  }
  return clean;
}

/**
 * Fail closed on a missing creative-kit disclosure. A short '#ad' is never
 * substituted for the specific Amazon Associate statement.
 */
export function affiliateDisclosureProblem(disclosure: string | null, network: AffiliateNetwork): string | null {
  if (!disclosure || !/(?:^|\s)#ad\b/iu.test(disclosure)) {
    return 'Set a prominent #ad disclosure in this brand\'s creative kit before making affiliate media.';
  }
  if (network === 'amazon_associates' && !/as an amazon associate i earn from qualifying purchases/iu.test(disclosure)) {
    return 'Amazon promotions also need the Amazon Associate earnings statement in the brand\'s creative kit.';
  }
  return null;
}

/**
 * Server-side intake. The three confirmations are attestations by the owner,
 * not proof that a product, site, image or affiliate account was verified.
 * No price, rating, endorsement, product benefit or sale is invented.
 */
export function affiliateProductBrief(
  context: Pick<CreativeBrandContext, 'confirmed' | 'disclosure'>,
  input: AffiliateBriefInput,
): string {
  if (!context.confirmed) throw new SeoBlogError(409, 'Confirm the current brand profile before making affiliate media.');
  if (input.network !== 'amazon_associates' && input.network !== 'other') throw new SeoBlogError(400, 'Choose a supported affiliate programme.');
  const network: AffiliateNetwork = input.network;
  const problem = affiliateDisclosureProblem(context.disclosure, network);
  if (problem) throw new SeoBlogError(409, problem);
  if (input.productReviewed !== 'on' || input.channelEligible !== 'on' || input.rightsConfirmed !== 'on') {
    throw new SeoBlogError(409, 'Confirm the product details, affiliate destination eligibility, and rights to every supplied asset first.');
  }
  const product = name(input.productName, 'product name', 100);
  const merchant = name(input.merchantName, 'merchant name', 80);
  // Deliberately non-assertive copy. Owners can edit, but the studio's existing
  // brand-facts, restricted-phrase and exact-version approval controls remain.
  const brief = `Explore ${product} from ${merchant}. Check current product details and terms on the linked page.`;
  if ([...brief].length > 1200) throw new SeoBlogError(400, 'Product details are too long.');
  return brief;
}
