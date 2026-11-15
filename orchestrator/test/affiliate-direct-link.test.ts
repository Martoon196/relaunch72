import test from 'node:test';
import assert from 'node:assert/strict';
import {affiliateDirectLinkPreview,directLinkAnchor} from '../src/creative-studio/affiliate-direct-link.js';
const input={network:'amazon_associates' as const,product_url:'https://www.amazon.co.uk/dp/B09XYZ1234',
 proposed_affiliate_url:'https://www.amazon.co.uk/dp/B09XYZ1234?tag=shopowner-21',
 owner_product_reviewed:true,owner_channel_eligible:true,disclosure_version:'kit-7'};
test('Amazon candidates remain direct owner review links, never redirected or modified',()=>{
 const link=affiliateDirectLinkPreview(input);
 assert.equal(link.status,'manual_review');assert.equal(link.transport,'direct_only');
 const anchor=directLinkAnchor(link,'See item');
 assert.ok(anchor?.includes('href="https://www.amazon.co.uk/dp/B09XYZ1234?tag=shopowner-21"'));
 assert.match(anchor!,/rel="sponsored noopener noreferrer"/);
 assert.doesNotMatch(anchor!,/\/go\/|\/redirect\/|utm_/i);
});
test('rejects cloaked, substituted, untagged and mismatched Amazon links',()=>{
 for(const value of [
  'https://amzn.to/abcde', 'https://tracker.other.test/go?url=https://amazon.co.uk/dp/B09XYZ1234',
  'https://www.amazon.co.uk/dp/B09XYZ9999?tag=shopowner-21',
  'https://www.amazon.co.uk/dp/B09XYZ1234',
  'https://www.amazon.co.uk/dp/B09XYZ1234?tag=shopowner-21&user_id=abc',
  'https://www.amazon.co.uk/dp/B09XYZ1234?tag=shopowner-21&tag=another-21',
 ]){
  const review=affiliateDirectLinkPreview({...input,proposed_affiliate_url:value});
  assert.equal(review.status,'blocked',value);assert.equal(directLinkAnchor(review,'Link'),null);
 }
});
test('no network-specific approval invented for other affiliates',()=>{
 assert.equal(affiliateDirectLinkPreview({...input,network:'other'}).status,'blocked');
 assert.equal(affiliateDirectLinkPreview({...input,owner_channel_eligible:false}).status,'blocked');
});
