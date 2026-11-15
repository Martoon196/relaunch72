import assert from 'node:assert/strict';
import test from 'node:test';
import { affiliateDisclosureProblem, affiliateProductBrief } from '../src/creative-studio/affiliate-product.js';
import { CreativeStudioService } from '../src/creative-studio/service.js';
import type { CreativeBrandContext } from '../src/creative-studio/brand-context.js';

// A media-only test process explicitly enables the opt-in parser hook.
const priorMediaFlag=process.env.CREATIVE_MEDIA;
process.env.CREATIVE_MEDIA='enabled';
test.after(()=>{if(priorMediaFlag===undefined)delete process.env.CREATIVE_MEDIA;
  else process.env.CREATIVE_MEDIA=priorMediaFlag;});
const amazonDisclosure = '#ad As an Amazon Associate I earn from qualifying purchases.';
const context = {
  confirmed: true,
  disclosure: amazonDisclosure,
  audiences: ['Homeowners'],
  destinations: [{ url: 'https://example.org/review', label: 'Product guide' }],
} as unknown as CreativeBrandContext;

const input = {
  productName: 'Acme Cordless Drill', merchantName: 'Acme Store', network: 'amazon_associates',
  productReviewed: 'on', channelEligible: 'on', rightsConfirmed: 'on',
};

test('affiliate draft uses owner-supplied product identity, not invented ratings, prices or sales', () => {
  const brief = affiliateProductBrief(context, input);
  assert.equal(brief, 'Explore Acme Cordless Drill from Acme Store. Check current product details and terms on the linked page.');
  assert.doesNotMatch(brief, /(?:reviews|stars|% off|£|guaranteed|earnings|commission)/iu);
});

test('no missing Amazon statement can be treated as an ordinary #ad', () => {
  assert.match(affiliateDisclosureProblem('#ad Affiliate links', 'amazon_associates')!, /Amazon Associate/iu);
  assert.match(affiliateDisclosureProblem('Affiliate links may earn a fee', 'other')!, /#ad/iu);
  assert.equal(affiliateDisclosureProblem('#ad This post contains affiliate links.', 'other'), null);
  assert.equal(affiliateDisclosureProblem(amazonDisclosure, 'amazon_associates'), null);
});

test('affiliate intake is closed to unconfirmed brands, unrecognised networks or missing owner attestations', () => {
  assert.throws(() => affiliateProductBrief({ confirmed: false, disclosure: amazonDisclosure }, input), /Confirm the current brand profile/iu);
  assert.throws(() => affiliateProductBrief(context, { ...input, network: 'nope' }), /supported affiliate programme/iu);
  assert.throws(() => affiliateProductBrief(context, { ...input, rightsConfirmed: '' }), /rights to every supplied asset/iu);
  assert.throws(() => affiliateProductBrief(context, { ...input, productReviewed: '' }), /Confirm the product details/iu);
  assert.throws(() => affiliateProductBrief(context, { ...input, channelEligible: 'true' }), /Confirm the product details/iu);
});

test('product name rejects embedded links, markup, blank values, oversize, and control characters', () => {
  for (const productName of ['', 'https://example.com', '<strong>Cheap</strong>', 'x'.repeat(101), 'One\nTwo']) {
    assert.throws(() => affiliateProductBrief(context, { ...input, productName }), /valid product name/iu);
  }
  assert.throws(() => affiliateProductBrief(context, { ...input, merchantName: 'www.bad.example' }), /valid merchant name/iu);
});

test('native Creative Studio accepts affiliate intake only for product promotions and an approved destination', () => {
  // parseRequest is pure; production access and persistence are guarded by the
  // existing brand session, workspace transaction, and Creative Studio SQL.
  const service = new CreativeStudioService({} as ConstructorParameters<typeof CreativeStudioService>[0]);
  const raw = {
    purpose: 'product_promotion', source_kind: 'affiliate_product',
    placements: ['vertical'], concepts: '1', destination: 'https://example.org/review',
    affiliate_product_name: input.productName, affiliate_merchant_name: input.merchantName,
    affiliate_network: input.network, affiliate_product_reviewed: input.productReviewed,
    affiliate_channel_eligible: input.channelEligible, affiliate_rights_confirmed: input.rightsConfirmed,
  };
  const request = service.parseRequest(context, raw);
  assert.equal(request.purpose, 'product_promotion');
  assert.equal(request.source.kind, 'brief');
  assert.deepEqual(request.destination, context.destinations[0]);
  assert.deepEqual(request.placements, ['vertical']);
  assert.ok(request.source.kind === 'brief' && request.source.text.includes(input.productName));

  assert.throws(() => service.parseRequest(context, { ...raw, purpose: 'organic_social' }), /Choose Product promotion/iu);
  const other = service.parseRequest({ ...context, disclosure: '#ad Affiliate links.' }, { ...raw, affiliate_network: 'other' });
  assert.equal(other.source.kind, 'brief');
});

test('affiliate product never accepts a forged destination as a confirmed brand page', () => {
  const service = new CreativeStudioService({} as ConstructorParameters<typeof CreativeStudioService>[0]);
  const req = service.parseRequest(context, {
    purpose: 'product_promotion', source_kind: 'affiliate_product', placements: ['square'],
    affiliate_product_name: input.productName, affiliate_merchant_name: input.merchantName,
    affiliate_network: input.network, affiliate_product_reviewed: 'on',
    affiliate_channel_eligible: 'on', affiliate_rights_confirmed: 'on',
    destination: 'https://attacker.example/track',
  });
  assert.equal(req.destination, null);
});
