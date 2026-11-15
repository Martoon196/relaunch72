import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedProduct, type AffiliateMediaProductInput, type AffiliateMediaProductRecord } from '../src/creative-studio/media-product-pg-store.js';
import { creativeMediaProductsPage } from '../src/portal/creative-media-products-view.js';
import type { Shell } from '../src/portal/seo-blog-view.js';

const product:AffiliateMediaProductInput={
  network:'amazon_associates',merchantName:'Amazon UK',productName:'Battery lantern',
  productUrl:'https://www.amazon.co.uk/dp/EXAMPLE001',
  affiliateUrl:'https://amzn.to/fakelink',
  sourceRights:'none',productReviewed:false,channelEligible:false,mediaRightsConfirmed:false,
  evidenceSha256:null,disclosureVersion:'draft',
};
test('proposed affiliate product requires secure links and licensed media evidence',()=>{
  assert.equal(checkedProduct(product).merchantName,'Amazon UK');
  assert.throws(()=>checkedProduct({...product,productUrl:'http://example.com/p'}),/secure/u);
  assert.throws(()=>checkedProduct({...product,affiliateUrl:'https://example.com:9443/product'}),/secure/u);
  assert.throws(()=>checkedProduct({...product,productName:'<script>alert(1)</script>'}),/valid product/u);
  assert.throws(()=>checkedProduct({...product,sourceRights:'licensed',mediaRightsConfirmed:true}),/evidence/iu);
  assert.throws(()=>checkedProduct({...product,sourceRights:'none',mediaRightsConfirmed:true}),/cannot confirm/iu);
});
test('catalogue page is an owner-reviewed draft form with CSRF, immutable revisions, and safe escaped content',()=>{
  const shell={csrf:'test-csrf',brand:{id:'ba18a1be-381e-4c13-8d0a-55f7ff007701',name:'Test Shop',slug:'test-shop'},
    brands:[],tab:'creative',notice:null,error:null} as unknown as Shell;
  const record:AffiliateMediaProductRecord={
    workspace_id:shell.brand!.id,product_id:'c1cb9781-e8da-42a6-8910-1d88d19bd687',revision:3,
    network:'amazon_associates',merchant_name:'Merchant',product_name:'<img src=x onerror=alert(1)>',
    product_url:'https://www.amazon.co.uk/p',proposed_affiliate_url:'https://amzn.to/some',
    source_rights:'none',evidence_sha256:null,owner_product_reviewed:true,
    owner_channel_eligible:false,owner_media_rights_confirmed:false,disclosure_version:'draft',
    created_by:'owner',created_at:'2026-11-15T16:00:00.000Z',
  };
  const html=creativeMediaProductsPage(shell,[record],'new-command',()=> 'edit-command');
  assert.match(html,/Affiliate products/u);
  assert.match(html,/test-csrf/u);
  assert.match(html,/Save new immutable revision/u);
  assert.match(html,/expectedRevision" value="3"/u);
  assert.match(html,/Owner proposal/u);
  assert.doesNotMatch(html,/<img src=x onerror=/u);
  assert.match(html,/&lt;img src=x onerror=alert/u);
  assert.doesNotMatch(html,/href="https:\/\/amzn\.to/u,'unreviewed merchant affiliate links never become public clickables');
});
