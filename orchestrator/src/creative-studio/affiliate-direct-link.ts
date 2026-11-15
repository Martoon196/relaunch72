/**
 * Merchant-direct link review for the EXISTING private affiliate product.
 * No first-party redirect, opaque tracking hop, affiliate tag substitution,
 * invented merchant approval or customer-level sub-tag attribution.
 *
 * https://affiliate-program.amazon.co.uk/help/operating/policies
 * UK Amazon requires Special Links visibly point to the Amazon Site.
 */
import type { AffiliateMediaProductRecord } from './media-product-pg-store.js';
export type DirectLinkReview=Readonly<{
  status:'manual_review'|'blocked';
  href:string|null;
  merchant:string;
  reason:string;
  /** The url stays exactly supplied by owner; no redirect or tracking mutation. */
  transport:'direct_only';
}>;
const ASIN=/^\/dp\/([A-Z0-9]{10})(?:\/|$)|^\/gp\/product\/([A-Z0-9]{10})(?:\/|$)/iu;
function secure(raw:string|null):URL|null {
  if(!raw||raw.length>2048||/[\s<>]/u.test(raw))return null;
  try {
    const u=new URL(raw);
    return u.protocol==='https:'&&!u.username&&!u.password&&!u.port
      &&!u.hash&&u.hostname.includes('.')?u:null;
  }catch{return null;}
}
export function affiliateDirectLinkPreview(p:Pick<AffiliateMediaProductRecord,
  'network'|'product_url'|'proposed_affiliate_url'|'owner_product_reviewed'|
  'owner_channel_eligible'|'disclosure_version'>):DirectLinkReview{
  const block=(reason:string):DirectLinkReview=>({status:'blocked',href:null,merchant:'',reason,transport:'direct_only'});
  const product=secure(p.product_url),link=secure(p.proposed_affiliate_url);
  if(!product||!link)return block('A secure merchant product URL and separately supplied affiliate URL are required.');
  if(!p.owner_product_reviewed||!p.owner_channel_eligible||!p.disclosure_version)
    return block('Owner product review, eligible registered site and disclosure evidence are required.');
  if(p.network==='amazon_associates'){
    const domain=(h:string)=>h==='amazon.co.uk'||h==='www.amazon.co.uk';
    if(!domain(link.hostname)||!domain(product.hostname))
      return block('Amazon UK Special Links must visibly point directly to amazon.co.uk.');
    const original=ASIN.exec(product.pathname),linked=ASIN.exec(link.pathname);
    if(!original||!linked||(original[1]??original[2])?.toUpperCase()!==(linked[1]??linked[2])?.toUpperCase())
      return block('Amazon product identity must match the same product detail page.');
    const tag=link.searchParams.getAll('tag');
    if(tag.length!==1||!(/^[a-z0-9][a-z0-9-]{0,90}-\d{2}$/iu.test(tag[0]!)))
      return block('A genuine owner-assigned Amazon Associates tag is required.');
    for(const param of ['url','redirect','redirecturl','destination','target','subtag','user_id']){
      if(link.searchParams.has(param))
        return block('Redirect or user-specific affiliate parameters need programme review.');
    }
    return {status:'manual_review',href:link.href,merchant:'Amazon UK',
      reason:'Direct owner-provided Special Link candidate. Review current registered-site rules, tag ownership and disclosures before publishing.',
      transport:'direct_only'};
  }
  return block('Other networks require an explicit network-specific direct-link policy before issuance.');
}
/** HTML anchor for a verified owner-reviewed candidate, never an RL72 redirect. */
export function directLinkAnchor(review:DirectLinkReview,label:string):string|null{
  if(review.status!=='manual_review'||!review.href)return null;
  const esc=(s:string)=>s.replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  return '<a href="'+esc(review.href)+'" rel="sponsored noopener noreferrer" target="_blank" referrerpolicy="strict-origin-when-cross-origin">'+esc(label)+'</a>';
}
