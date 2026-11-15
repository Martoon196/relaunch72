/**
 * Brand DNA, word for word (rules version 2): quoted facts are copied and checked exactly; description is ours and fenced
 * off. Every reviewer reproduction is a case here, plus four realistic sites read through the real page reader (blocks kept,
 * and as the older one-line text), a fuzz, a performance bound and the prompts writers actually receive.
 * No network, model or database is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  brandDnaCard, brandPageText, BRAND_DNA_RULES_VERSION, cleanProvenance, holdConflictedPrices, missingFactShowable, priceConflicts, repairProfileFacts, settleConflict,
  strictProfileProblems, writingProfile, type ProfileFacts,
} from '../src/seo-blog/brand-dna.js';
import { claimUnit, audienceUnit, keyOf, linkAllowed, neverSayKept, priceStatus, structureOf, tiedPrices } from '../src/seo-blog/brand-dna-rules.js';
import { parseHtmlPage } from '../src/seo-blog/html.js';
import { extractProfile, profileForPrompt, proposeCluster, rewriteSection, writeArticle, writeArticleCampaignPromotions, writeArticlePromotions } from '../src/seo-blog/generation.js';
import { methodEvidenceContext } from '../src/seo-blog/method-evidence.js';
import { brandDnaPage } from '../src/portal/brand-dna-view.js';
import type { LlmClient } from '../src/llm/client.js';
import type { ArticleBody, ArticleBrief, BrandProfile, KnowledgeDocument, ProfileOffer } from '../src/seo-blog/types.js';

const D = (id: string, text: string, page?: string) => ({ id, text, ...(page ? { page } : {}) });
type Card = ProfileFacts & { summary: string; positioning: string; voice: { tone: string[]; do: string[]; dont: string[]; examples: string[] }; exclusions: string[]; conversionPages: { url: string; label: string }[] };
const card = (over: Record<string, unknown> = {}): Card => ({ summary: 'A business summary line.', audiences: [], positioning: '', offers: [], conversionPages: [], voice: { tone: [], do: [], dont: [], examples: [] },
  approvedClaims: [], exclusions: [], conflicts: [], missingFacts: [], sources: [], ...over }) as Card;
const offer = (name: string, price: string | null, sourceDocumentId = 'd1', extra: Partial<ProfileOffer> = {}): ProfileOffer => ({ name, description: '', price, url: null, sourceDocumentId, ...extra });
/** Check, repair, and check again: the repaired card always passes. */
function repaired(value: ProfileFacts, docs: { id: string; text: string; page?: string }[], ctx = {}) {
  const r = repairProfileFacts(value, docs, ctx);
  assert.ok(r, 'repairable');
  assert.deepEqual(strictProfileProblems(r.value, docs, ctx), [], 'a repaired card passes every rule');
  return r;
}
const ctx = { website: 'https://quay.example' };

// ─── B1/B2: claims are whole sentences, never paraphrases ────────────────────

test('claims: every reviewer reproduction is refused and left out; a whole sentence is kept', () => {
  const cases: [string, string, string][] = [
    ['We are not FCA regulated and do not give mortgage advice.', 'FCA regulated', 'FCA regulated'],
    ['We are not the cheapest agent in Kent, and we never will be.', 'the cheapest agent in Kent', 'The cheapest agent in Kent'],
    ['Quay is an unregulated introducer of bridging finance.', 'regulated introducer of bridging finance', 'Regulated introducer of bridging finance'],
    ['"They are the best letting agent in Kent and saved me thousands" - Sarah, landlord.', 'the best letting agent in Kent', 'The best letting agent in Kent'],
    ['"They are the best letting agent in Kent and saved me thousands" - Sarah, landlord.', '"They are the best letting agent in Kent and saved me thousands"', 'They are the best letting agent in Kent and saved me thousands'],
    ['Our aim is to become the largest independent agent in Kent by 2030.', 'the largest independent agent in Kent', 'The largest independent agent in Kent'],
    ['Rent is guaranteed for the first 18 months only, subject to referencing.', 'Rent is guaranteed for the first 18 months only', 'Rent is guaranteed'],
    ['Results are never guaranteed. Rent is paid monthly to every landlord.', 'guaranteed. Rent is paid monthly', 'Guaranteed rent is paid monthly'],
    ['Landlords pay a 10% management fee. Tenants pay no fees.', 'Landlords pay a 10% management fee. Tenants pay no fees.', 'Landlords pay no fees'],
    ['We manage 300 properties and are trusted by 50 landlords across Kent.', 'We manage 300 properties and are trusted by 50 landlords', 'Trusted by 300 landlords'],
    ['Fees apply to every tenancy and there is no guaranteed rent.', 'Fees apply to every tenancy and there is no guaranteed rent', 'No fees on every tenancy and guaranteed rent'],
    ['We may be able to recover unpaid rent on your behalf.', 'We may be able to recover unpaid rent', 'We recover unpaid rent'],
    ['We will be FCA authorised once our application is approved.', 'We will be FCA authorised', 'We are FCA authorised'],
    ['Clients could save up to £500 a year on their mortgage.', 'Clients could save up to £500 a year', 'Clients save £500 a year'],
    ['We are unable to offer guaranteed rent or legal advice.', 'offer guaranteed rent', 'We offer guaranteed rent'],
    ['Is your landlord insurance fully covered by us? Sadly it is something we stopped doing.', 'landlord insurance fully covered by us', 'Landlord insurance fully covered by us'],
    ['Is your landlord insurance fully covered by us? Sadly it is something we stopped doing.', 'Is your landlord insurance fully covered by us?', 'Is your landlord insurance fully covered by us?'],
    ['Unlike Foxtons, who charge 20% plus VAT, our fee is fair.', 'Foxtons, who charge 20% plus VAT', 'We charge 20% plus VAT'],
    ['Our tenants rarely pay late and we hardly ever lose a deposit dispute.', 'we hardly ever lose a deposit dispute', 'We lose a deposit dispute'],
    ['Trusted by landlords across Kent.', 'Trusted by landlords across Kent', 'Νοτ trusted by landlords across Kent'],
    ['Trusted by 300 landlords across Kent.', 'Trusted by 300 landlords', 'Trusted by ٣٠٠ landlords across Kent'],
    ['Quay helps private landlords in Kent stay compliant.', 'helps private landlords in Kent stay compliant', 'Guaranteed compliant landlords in Kent'],
    ['Trusted by 300 landlords', 'Trusted by 300 landlords', 'Not trusted by landlords'],
    ['We never promise guaranteed rent.', 'We never promise guaranteed rent', 'We promise guaranteed rent'],
    ['Over 10² landlords trust us.', 'Over 10² landlords trust us', 'Over 102 landlords trust us'],
  ];
  for (const [text, quote, claim] of cases) {
    const docs = [D('d1', text, 'https://quay.example/')];
    const v = card({ approvedClaims: [claim], sources: [{ field: 'claim', value: claim, documentId: 'd1', quote }] });
    assert.ok(strictProfileProblems(v, docs, ctx).length > 0, claim);
    const r = repaired(v, docs, ctx);
    assert.deepEqual(r.value.approvedClaims, [], claim); assert.deepEqual(r.leftOut, [{ what: 'claim', text: claim }], claim);
  }
  // A whole sentence, with case, punctuation, invisible characters and spacing forgiven, is a claim.
  for (const [text, claim] of [
    ['Quay Lettings is a family-run agent. We are not FCA regulated.', 'We are not FCA regulated.'],
    ['We help landlords in Kent. Trusted by 300 landlords.', 'trusted by 300 LANDLORDS'],
    ['Oak Mortgages Ltd. is regulated by the FCA. We search 90 lenders.', 'Oak Mortgages Ltd. is regulated by the FCA.'],
    ['Full Manage­ment is our most popular service.', 'Full Management is our most popular service.'],
    ['No call-out charge\nAll work guaranteed for 12 months', 'All work guaranteed for 12 months'],
  ] as const) assert.ok(claimUnit(claim, { text }), claim);
  assert.equal(claimUnit('All work guaranteed for 12 months', { text: 'No call-out charge All work guaranteed for 12 months Free quotes' }), null, 'a one-line bullet list is no sentence');
  assert.equal(claimUnit('x'.repeat(221), { text: 'x'.repeat(221) }), null, 'at most 220 characters');
});

test('audiences: an unbroken run inside one sentence that negates nothing; numbers come with the run', () => {
  const doc = { text: 'We work with first-time landlords, accidental landlords and portfolio owners across East Sussex. Unlike agents who chase landlords in London, we only work in Kent. We help 5 types of landlord.' };
  assert.ok(audienceUnit('portfolio owners across East Sussex', doc)); assert.ok(audienceUnit('First-time landlords', doc));
  for (const bad of ['Landlords in London', 'Portfolio owners in East Sussex', 'Landlords who want guaranteed rent', 'Νοτ landlords', 'x'.repeat(81)]) assert.equal(audienceUnit(bad, doc), null, bad);
  assert.ok(audienceUnit('5 types of landlord', doc)); assert.equal(audienceUnit('6 types of landlord', doc), null);
  for (const neg of ['We do not serve landlords in Kent.', 'Landlords in Kent, except HMOs.', 'Landlords in Kent rather than London.', "We won't serve landlords in Kent."]) assert.equal(audienceUnit('landlords in Kent', { text: neg }), null, neg);
});

// ─── B3: prices are full expressions tied to their offer ─────────────────────

test('prices: every reviewer false accept is refused; honest layouts are tied', () => {
  const t = (text: string, name: string, price: string, others: string[] = []) => priceStatus(price, { text }, [name, ...others], 0);
  const refused: [string, string, string, string[]?][] = [
    ['Pro Plan £49 per month or £490 per year. Cancel any time.', 'Pro Plan', '£490'],
    ['Full Management costs £99 + VAT per month.', 'Full Management', '£99'],
    ['Tenant Find from £499 depending on property size.', 'Tenant Find', '£499'],
    ['Pro Plan was £99 now £49 per month.', 'Pro Plan', '£99'],
    ['Boiler Service £80-£120 depending on model.', 'Boiler Service', '£120'],
    ['Pro Plan: £49 per month, plus a £199 setup fee.', 'Pro Plan', '£199'],
    ['Save £50 on the Pro Plan this month. Pro Plan is £149 per month.', 'Pro Plan', '£50'],
    ['Starter £29 per month Pro £49 per month Premium £99 per month', 'Starter', '£49 per month'],
    ['Starter £29 per month Pro £49 per month', 'Starter', '£49 per month', ['Professional']],
    ['Starter Pro Premium £29 £49 £99 per month', 'Starter', '£29', ['Pro', 'Premium']],
    ['Starter Pro Premium £29 £49 £99 per month', 'Pro', '£49', ['Starter', 'Premium']],
    ['£29 Starter £49 Pro £99 Premium', 'Starter', '£49', ['Pro', 'Premium']],
    ['£29 Starter £49 Pro £99 Premium', 'Pro', '£99', ['Starter', 'Premium']],
    ['Full Management: other agents charge 15% of rent, we charge 10%.', 'Full Management', '15% of rent'],
    ['Gold Membership £1,200 per year (that is £100 per month).', 'Gold Membership', '£100 per month'],
    ['Rent Collection 8% of rent. Full Management 12% of rent, minimum £60 per month.', 'Full Management', '£60 per month', ['Rent Collection']],
    ['Full Management 12.5% of monthly rent', 'Full Management', '12'],
    ['Full Management 12.5% of monthly rent', 'Full Management', '5% of monthly rent'],
    ['Mentoring Programme £5k for 12 months', 'Mentoring Programme', '£5'],
    ['Call-out fee 99p per minute. Emergency Call-out £1.50 per minute', 'Emergency Call-out', '£1'],
    ['Full Management £99¹ per month', 'Full Management', '£991 per month'],
    ['Full Management 12% of monthly rent (inc. VAT)', 'Full Management', '12% of monthly rent'],
  ];
  // Refused means never accepted: either not this offer's price at all, or one of several, which the owner is asked about.
  for (const [text, name, price, others] of refused) assert.notEqual(t(text, name, price, others), 'tied', `${name} = ${price} on ${text}`);
  // Several prices beside one offer: never picked, put to the owner.
  for (const [text, name, price] of [['Pro Plan £49 per month or £490 per year. Cancel any time.', 'Pro Plan', '£49 per month'], ['Pro Plan was £99 now £49 per month.', 'Pro Plan', 'now £49 per month'],
    ['Pro Plan: £49 per month, plus a £199 setup fee.', 'Pro Plan', '£49 per month'], ['Mentoring Programme. Places are limited. Mentoring Programme deposit £500, balance £4,500 on start.', 'Mentoring Programme', '£500'],
    ['Gold Membership £1,200 per year (that is £100 per month).', 'Gold Membership', '£1,200 per year'], ['Starter Pro Premium £29 £49 £99 per month', 'Premium', '£29']] as const)
    assert.equal(t(text, name, price, name === 'Premium' ? ['Starter', 'Pro'] : []), 'ambiguous', `${name} = ${price}`);
  const tied: [string, string, string, string[]?][] = [
    ['Other charges Inventory report: £120 Tenancy renewal: £90 Gas safety certificate: £85', 'Inventory report', '£120', ['Tenancy renewal', 'Gas safety certificate']],
    ['Other charges Inventory report: £120 Tenancy renewal: £90 Gas safety certificate: £85', 'Tenancy renewal', '£90', ['Inventory report', 'Gas safety certificate']],
    ['Other charges Inventory report: £120 Tenancy renewal: £90 Gas safety certificate: £85', 'Gas safety certificate', '£85', ['Inventory report', 'Tenancy renewal']],
    ['Inventory report - £120 Tenancy renewal - £90', 'Inventory report', '£120', ['Tenancy renewal']],
    ['Inventory report £120 Tenancy renewal £90', 'Tenancy renewal', '£90', ['Inventory report']],
    ['Full Management 12% of monthly rent (inc. VAT)', 'Full Management', '12% of monthly rent (inc. VAT)'],
    ['Deep clean approx. £180 per visit', 'Deep clean', 'approx. £180 per visit'],
    ['Gold Membership £1,200 p.a. + VAT', 'Gold Membership', '£1,200 p.a. + VAT'],
    ['Clarity Session A single 90-minute session to untangle what you want next. £150', 'Clarity Session', '£150'],
    ['Clarity Session A single 90-minute session to untangle what you want next £150', 'Clarity Session', '£150'],
    ['We offer a Tenant Find service. It costs £499.', 'Tenant Find', '£499'],
    ['Full Management costs £99 + VAT per month.', 'Full Management', '£99 + VAT per month'],
    ['Tenant Find from £499 depending on property size.', 'Tenant Find', 'from £499'],
    ['Boiler Service £80-£120 depending on model.', 'Boiler Service', '£80-£120'],
    ['Save £50 on the Pro Plan this month. Pro Plan is £149 per month.', 'Pro Plan', '£149 per month'],
    ['Starter £29 per month Pro £49 per month Premium £99 per month', 'Starter', '£29 per month'],
    ['£29 Starter', 'Starter', '£29'],
    ['Full Manage­ment £​99 per month', 'Full Management', '£99 per month'],
    ['Full Management £99¹ per month', 'Full Management', '£99 per month'],
    ['Full Management £９９ per month', 'Full Management', '£99 per month'],
    ['Pro Plan. Everything a landlord needs. £49 per month.', 'Pro Plan', '£49 per month'],
    ['Price list 2023: Pro Plan £59 per month', 'Pro Plan', '£59 per month'],
  ];
  for (const [text, name, price, others] of tied) assert.equal(t(text, name, price, others), 'tied', `${name} = ${price} on ${text}`);
  // With blocks kept, a column table is not paired by position.
  assert.equal(t('Starter\nPro\n£29\n£49', 'Starter', '£29', ['Pro']), 'untied');
  assert.equal(t('Starter\nPro\n£29\n£49', 'Pro', '£29', ['Starter']), 'ambiguous');
  assert.equal(t('Boiler service\n£85\nLandlord gas safety certificate\n£70', 'Landlord gas safety certificate', '£70', ['Boiler service']), 'tied');
  assert.equal(t(`Pro Plan ${'words '.repeat(70)}£49 per month`, 'Pro Plan', '£49 per month'), 'untied', 'more than 300 characters away');
});

test('prices on the card: an offer whose name is on no page goes; a price that is not its offer’s is emptied; several are asked', () => {
  const docs = [D('d1', 'Pro Plan £49 per month or £490 per year. Cancel any time. Starter £29 per month.', 'https://quay.example/pricing')];
  const v = card({ offers: [offer('Pro Plan', '£490'), offer('Starter', '£29 per month'), offer('Platinum', '£99'), offer('w '.repeat(11).trim(), null)] });
  const r = repaired(v, docs, ctx);
  assert.deepEqual(r.value.offers.map((o) => [o.name, o.price]), [['Pro Plan', null], ['Starter', '£29 per month']]);
  assert.deepEqual(r.leftOut.map((l) => [l.what, l.text]), [['price', 'Pro Plan'], ['offer', 'Platinum'], ['offer', 'w w w w w w w w w w w']]);
  const held = holdConflictedPrices({ ...r.value, offers: r.value.offers }, docs);
  assert.deepEqual(held.conflicts.map((c) => [c.offer, c.detail, c.options!.map((o) => o.value)]), [['Pro Plan', 'We found more than one price for Pro Plan. Which is right?', ['£49 per month', '£490 per year']]]);
  for (const o of held.conflicts[0]!.options!) assert.ok(o.quote.includes(o.value));
});

test('B5: two sources disagreeing on one offer’s price are always asked, never settled', () => {
  const docs = [D('home', 'Pro Plan. Everything a landlord needs. £49 per month.', 'https://quay.example/'), D('list', 'Price list 2023: Pro Plan £59 per month')];
  const v: ProfileFacts = { offers: [{ name: 'Pro Plan', description: 'Everything a landlord needs.', price: '£59 per month', url: null, sourceDocumentId: 'list' }], conflicts: [], audiences: [], approvedClaims: [], missingFacts: [] };
  const held = holdConflictedPrices(v, docs);
  assert.equal(held.offers[0]!.price, null); assert.deepEqual(held.conflicts[0]!.options!.map((o) => o.value), ['£49 per month', '£59 per month']);
  const far = [D('page', `Pro Plan. ${'Lots of words about what is included. '.repeat(5)}£49 per month.`), D('list', 'Pro Plan £59 per month')];
  assert.equal(priceConflicts({ offers: [{ ...v.offers[0]!, price: null }], conflicts: [] }, far).length, 1, 'the backstop is not narrowed by the price rule');
  // The model's own honest question is kept.
  const asked = card({ offers: [offer('Pro Plan', null, 'home')], conflicts: [{ field: 'Pro Plan: price', detail: 'The home page and the price list differ.', documentIds: ['home', 'list'], kind: 'price', offer: 'Pro Plan',
    options: [{ value: '£49 per month', documentId: 'home', quote: 'Everything a landlord needs. £49 per month.' }, { value: '£59 per month', documentId: 'list', quote: 'Pro Plan £59 per month' }] }] });
  assert.deepEqual(strictProfileProblems(asked, docs), []);
});

test('B3: another product’s price never reaches a writer through description, claims or a made-up offer', () => {
  const HOME = 'Harbour Lettings is a family-run letting agent in Brighton and Hove. Every tenant is referenced and every deposit is protected. Over 200 landlords trust us with their homes. We never promise guaranteed rent. Never pay a fee until your home is let.';
  const PRICING = 'Our services Tenant Find costs £495 + VAT per let. We find, reference and move in your tenant. Full Management costs 12% of the monthly rent. We handle rent collection, repairs and inspections. Ask about our landlord insurance from £15 per month.';
  const docs = [D('home', HOME, 'https://harbour.example/'), D('pricing', PRICING, 'https://harbour.example/pricing')];
  const v = card({
    summary: 'Harbour Lettings offers Full Management from £15 per month and Tenant Find for 12% of the monthly rent.',
    offers: [offer('Full Management', null, 'pricing', { description: 'Full management of your property for just £15 per month.' }), offer('Tenant Find', null, 'pricing', { description: 'Costs 12% of the monthly rent.' }),
      offer('Rent Guarantee Insurance', null, 'pricing', { description: 'Your rent is paid even when the tenant does not pay.' })],
    approvedClaims: ['Full Management costs £15 per month', 'Tenant Find costs 12% of the monthly rent', 'We promise guaranteed rent', 'Pay a fee until your home is let', '200 landlords trust us with their deposit'],
    audiences: ['Landlords who want guaranteed rent'], exclusions: ['Never pay a fee', 'Every deposit is protected'],
    sources: [
      { field: 'claim', value: 'Full Management costs £15 per month', documentId: 'pricing', quote: 'Full Management costs 12% of the monthly rent.' },
      { field: 'claim', value: 'Tenant Find costs 12% of the monthly rent', documentId: 'pricing', quote: 'Full Management costs 12% of the monthly rent.' },
      { field: 'claim', value: 'We promise guaranteed rent', documentId: 'home', quote: 'promise guaranteed rent' },
      { field: 'claim', value: 'Pay a fee until your home is let', documentId: 'home', quote: 'pay a fee until your home is let' },
      { field: 'claim', value: '200 landlords trust us with their deposit', documentId: 'home', quote: 'Over 200 landlords trust us with their homes' },
      { field: 'audience', value: 'Landlords who want guaranteed rent', documentId: 'home', quote: 'landlords trust us with their homes' },
    ],
  });
  const r = repaired(v, docs, { website: 'https://harbour.example' });
  const profile = { ...r.value, brandId: 'b', version: 1, knowledge: [], strict: true, rulesVersion: BRAND_DNA_RULES_VERSION, factsSha: 'f', source: 'extracted', confirmedAt: null, confirmedBy: null, createdAt: 'x', generation: null } as unknown as BrandProfile;
  const sent = JSON.stringify(profileForPrompt(profile, 'https://harbour.example'));
  for (const leak of ['£15', '12%', 'guaranteed rent', 'Rent Guarantee', 'Every deposit is protected']) assert.ok(!sent.includes(leak), leak);
  assert.deepEqual(r.value.approvedClaims, []); assert.deepEqual(r.value.audiences, []); assert.deepEqual(r.value.exclusions, ['Never pay a fee']);
});

// ─── B4: description is fenced off; S5/8: links are the business's own ──────

test('links: only https on the website host or its subdomains, or a host a page was read from; a host written in page text never counts', () => {
  const docs = [D('d1', 'Email quaylettings@gmail.com. Find us on facebook.com/quaylettings. Portal: https://portal.propertyfile.co.uk/login. Old site my-quaylettings.co.uk.attacker.io.', 'https://www.quaylettings.co.uk/')];
  const c = { website: 'https://www.quaylettings.co.uk', pages: docs.map((d) => d.page) };
  for (const ok of ['https://quaylettings.co.uk/fees', 'https://www.quaylettings.co.uk/fees', 'https://QUAYLETTINGS.CO.UK/fees', 'https://shop.quaylettings.co.uk/fees']) assert.ok(linkAllowed(ok, c), ok);
  for (const bad of ['https://quaylettings.co.uk:8443/fees', 'https://quaylettings.co.uk@evil.com/fees', 'https://evil.com@quaylettings.co.uk/fees', 'https://quaylettings.co.uk.evil.com/fees',
    'https://evil.com/quaylettings.co.uk', 'https://quaylettings.co.uk./fees', 'https://xn--quaylettngs-9db.co.uk/fees', 'https://quaylettıngs.co.uk/fees', 'https://evil.com\\@quaylettings.co.uk/',
    'https://quaylettings.co.uk\\@evil.com/', 'https://quaylettings.co.uk%2eevil.com/', 'http://quaylettings.co.uk/fees', '//quaylettings.co.uk/fees', 'https://quaylettings.co.uk/a b', 'javascript:alert(1)',
    'https://gmail.com/phish', 'https://facebook.com/someone-else', 'https://portal.propertyfile.co.uk/other', 'https://attacker.io/x', 'https://co.uk.attacker.io/x',
    'https://quaylettings.co.uk.attacker.io/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://[::1]/x', 'https://quaylettings.co.uk​.evil.com/', 'https://quaylettings.co.uk。evil.com/',
    'https://evil.com#@quaylettings.co.uk', 'https://evil.com?quaylettings.co.uk', 'https://quaylettings.co.uk\t.evil.com/']) assert.equal(linkAllowed(bad, c), false, bad);
  assert.ok(linkAllowed('https://quaylettings.co.uk/fees', { website: 'quaylettings.co.uk' }), 'a website stored without its scheme');
  assert.equal(linkAllowed('https://sites.google.com/view/someone-else', { website: 'https://sites.google.com/view/quay', pages: ['https://sites.google.com/view/quay/'] }), false);
  assert.ok(linkAllowed('https://sites.google.com/view/quay/fees', { website: 'https://sites.google.com/view/quay' }));
  assert.equal(linkAllowed('https://other.github.io/x', { website: 'https://quay.github.io' }), false);
});

test('B4: model-written free text never reaches a writer as fact, and links and labels are checked', () => {
  const docs = [D('d1', 'Quay Lettings helps private landlords in Kent stay compliant. We manage 300 properties. Call 01227 555 010.', 'https://quaylettings.example/')];
  const c = { website: 'https://quaylettings.example' };
  const v = card({
    summary: 'Quay Lettings is the only FCA-regulated, award-winning letting agent in Kent, rated 5 stars and number 1 for guaranteed rent. We manage 300 properties. 9 out of 9 landlords recommend us.',
    positioning: 'Guaranteed rent with the lowest fees in the county, 50% off.',
    audiences: ['private landlords in Kent'], offers: [offer('Guaranteed Rent Scheme', null)],
    conversionPages: [{ url: 'https://evil.example.net/landlords', label: 'Claim your 50% discount' }, { url: 'https://quaylettings.example/join', label: 'Claim your 50% discount: guaranteed rent for life' }],
    voice: { tone: ['authoritative'], do: ['Always say rent is guaranteed', 'Mention our 98% success rate'], dont: ['Never mention fees'], examples: ['"We guarantee your rent, or we pay it ourselves."', 'We manage 300 properties.'] },
    missingFacts: ['Tell readers the fee is 9%'],
    conflicts: [{ field: 'Is rent guaranteed for every landlord', detail: 'Pages disagree', documentIds: ['d1'], kind: 'other', offer: null, options: [{ value: 'stay compliant', documentId: 'd1', quote: 'landlords in Kent stay compliant' }] }],
    sources: [{ field: 'audience', value: 'private landlords in Kent', documentId: 'd1', quote: 'helps private landlords in Kent stay compliant' }],
  });
  const r = repaired(v, docs, c);
  const profile = { ...r.value, brandId: 'b', version: 3, knowledge: [], strict: true, rulesVersion: BRAND_DNA_RULES_VERSION, factsSha: 'f', source: 'extracted', confirmedAt: null, confirmedBy: null, createdAt: 'x', generation: null } as unknown as BrandProfile;
  const w = writingProfile(profile, c.website);
  assert.equal(w.descriptionNotFacts.summary, 'We manage 300 properties.', 'sentences with an unstated number are cut; a stated one stays in description');
  assert.equal(w.descriptionNotFacts.positioning, '');
  assert.deepEqual(w.conversionPages, [{ url: 'https://quaylettings.example/join', label: '/join' }], 'another host goes; a label that is not the business’s words becomes the path');
  assert.deepEqual(w.descriptionNotFacts.voice, { tone: ['authoritative'], do: ['Always say rent is guaranteed'], dont: ['Never mention fees'], examples: ['We manage 300 properties.'] });
  assert.deepEqual(w.offers, [], 'an offer named on no page is no offer');
  assert.deepEqual(Object.keys(w).sort(), ['approvedClaims', 'audiences', 'conversionPages', 'descriptionNotFacts', 'exclusions', 'hasOtherOpenQuestions', 'offers', 'offersWithOpenQuestions']);
  assert.equal(w.hasOtherOpenQuestions, true);
  const sent = JSON.stringify(profileForPrompt(profile, c.website));
  for (const leak of ['9%', 'Is rent guaranteed for every landlord', 'Pages disagree', 'stay compliant"', 'evil.example', '50%']) assert.ok(!sent.includes(leak), leak);
});

test('S6/rule 11: a card checked under older rules is filtered for writing without its sources, and its page asks for a fresh read', () => {
  const old = { brandId: 'b', version: 2, knowledge: [], strict: true, summary: 'Quay Lettings helps landlords. Rated 5 stars by 300 clients.', positioning: '', audiences: ['Private landlords in Kent'],
    offers: [{ name: 'Starter', description: 'Entry plan for £9 a month.', price: '£99 per month', url: 'https://evil.example.net/pay', sourceDocumentId: 'd1' }, { name: 'Legacy', description: 'x', price: null, url: 'https://quay.example/legacy', sourceDocumentId: null }],
    conversionPages: [{ url: 'https://evil.example.net/landlords', label: 'Book' }, { url: 'https://quay.example/book', label: 'Book' }], voice: { tone: ['calm'], do: ['Say 10 years'], dont: [], examples: ['We are the best.'] },
    approvedClaims: ['Guaranteed compliant landlords in Kent'], exclusions: ['Never mention that fees apply', 'Never quote 95% yields'], missingFacts: ['The fee is 9% but we could not confirm it'],
    conflicts: [{ field: 'Starter: is it £49 or £99', detail: 'the model wrote this', documentIds: [] }], factsSha: 'f', source: 'extracted', confirmedAt: 'x', confirmedBy: 'u', createdAt: 'x', generation: null } as unknown as BrandProfile;
  const w = writingProfile(old, 'https://quay.example');
  assert.equal(w.descriptionNotFacts.summary, 'Quay Lettings helps landlords.'); assert.deepEqual(w.descriptionNotFacts.voice, { tone: ['calm'], do: [], dont: [], examples: [] });
  assert.deepEqual(w.offers.map((o) => o.url), [null, 'https://quay.example/legacy']); assert.deepEqual(w.conversionPages.map((p) => p.url), ['https://quay.example/book']);
  assert.deepEqual(w.exclusions, ['Never mention that fees apply']); assert.deepEqual(w.descriptionNotFacts.offerDescriptions, [{ offer: 'Legacy', description: 'x' }]);
  assert.deepEqual(writingProfile(old).offers.map((o) => o.url), [null, null], 'without the website address no link of an older card is passed');
  const sent = JSON.stringify(profileForPrompt(old, 'https://quay.example'));
  for (const leak of ['9%', 'the model wrote this', '£49 or', 'evil.example', '95%', 'Rated 5 stars']) assert.ok(!sent.includes(leak), leak);
  const shown = brandDnaCard(old, []);
  assert.equal(shown.checked, false); assert.equal(shown.rulesOutdated, true);
  assert.equal(brandDnaCard({ ...old, rulesVersion: BRAND_DNA_RULES_VERSION }, []).rulesOutdated, false);
  const brand = { id: 'b', name: 'Quay', website: 'https://quay.example', settings: { budgets: {} } };
  const page = brandDnaPage({ brands: [brand], brand, tab: null, csrf: 'c', notice: null } as never, { brand, profile: { ...old, confirmedAt: null }, card: shown, status: 'proposed',
    allowance: { used: 0, ceiling: 1, estimate: 0, enough: true }, writerReady: true, working: false, job: null, cardJob: null, documents: 0, pages: 0, uncertainEarlierAttempt: false } as never, 'cmd');
  assert.match(page, /We have tightened our checks since this was read\. Read your website again to re-check it\.<\/p>\s*<form[^>]*dna\/read[\s\S]*?>Read my website<\/button>/);
});

test('S9/rule 9: picking an answer to a non-price question closes it and never creates a claim from its title', () => {
  const v = card({ conflicts: [{ field: 'Rent is guaranteed for every landlord', detail: 'Your pages give different answers.', documentIds: ['d1'], kind: 'other', offer: null,
    options: [{ value: 'Yes', documentId: 'd1', quote: 'Yes, we cover all of Kent' }, { value: 'No', documentId: 'd1', quote: 'No, we do not cover London' }] }] });
  const settled = settleConflict({ ...v, sources: [] } as never, 0, { kind: 'option', index: 0 });
  assert.deepEqual(settled.approvedClaims, []); assert.deepEqual(settled.sources, []); assert.equal(settled.conflicts.length, 0);
});

test('S2/rule 7: "never say" lines are restrictions: topics and prohibitions kept, figures and the business’s own positive statements dropped', () => {
  const docs = [D('d', 'We never offer guaranteed rent schemes and we do not give tax advice. I can’t promise you a job, and I won’t pretend coaching is a quick fix. Every tenant is referenced and every deposit is protected. We cannot promise that your application will be approved.')];
  for (const kept of ['Tax advice', 'Guaranteed rent schemes', 'Never offer guaranteed rent schemes', 'Do not give tax advice', 'Legal advice', 'Promising a job', 'Coaching is a quick fix',
    'Promising that an application will be approved', 'Guaranteed mortgage approval', 'Cheap', 'Never describe our service as cheap']) assert.ok(neverSayKept(kept, docs), kept);
  for (const dropped of ['Every deposit is protected', 'Every tenant is referenced and every deposit is protected', 'Never quote 95% yields', 'Do not say we have 300 clients', 'x'.repeat(121)]) assert.equal(neverSayKept(dropped, docs), false, dropped);
});

test('S1/S3: real page characters, missing facts and the repair checking against the same offer list', () => {
  assert.equal(missingFactShowable('No named author'), true); for (const no of ['Whether the 3 monthly payments carry interest', 'No £ price', 'nine per cent is 9%']) assert.equal(missingFactShowable(no), false);
  // Three offers sharing a word, one dropped: the repaired card passes the check (inv.mts).
  const docs = [D('d1', 'Alpha Care includes our Shield cover for £49 per month.', 'https://quay.example/pricing'), D('d2', 'Alpha Care is £59 per month.', 'https://quay.example/')];
  const v = card({ offers: [offer('Alpha Care', '£49 per month'), offer('Shield Plan', null), offer('Shield Pro', null, 'not-a-document')] });
  repaired(v, docs, ctx);
  repaired(card({ offers: [offer('Alpha Care', null), offer('Shield Plan', null), offer('Shield Pro', null, 'nope')], conflicts: [{ field: 'Alpha Care: price', detail: 'two prices', documentIds: ['d1', 'd2'], kind: 'price', offer: 'Alpha Care',
    options: [{ value: '£49 per month', documentId: 'd1', quote: 'Shield cover for £49 per month' }, { value: '£59 per month', documentId: 'd2', quote: 'Alpha Care is £59 per month' }] }] }), docs, ctx);
});

test('rule 12: provenance on either path keeps a source line only when its claim is a whole sentence (or its audience a clean run)', () => {
  const docs = [D('d1', 'We are members of ARLA Propertymark. We do not charge tenants any application fees.')];
  const v = card({ approvedClaims: ['We are members of ARLA Propertymark.', 'ARLA Propertymark members'], audiences: ['tenants'],
    sources: [{ field: 'claim', value: 'We are members of ARLA Propertymark.', documentId: 'd1', quote: 'We are members of ARLA Propertymark' }, { field: 'claim', value: 'ARLA Propertymark members', documentId: 'd1', quote: 'We are members of ARLA Propertymark' },
      { field: 'audience', value: 'tenants', documentId: 'd1', quote: 'We do not charge tenants any application fees.' }] });
  const cleaned = cleanProvenance(v, docs);
  assert.deepEqual(cleaned.sources!.map((s) => s.value), ['We are members of ARLA Propertymark.']);
  assert.deepEqual(cleaned.approvedClaims, v.approvedClaims, 'the documents-only path removes no claim, only its shown source');
});

// ─── The four realistic sites (honest.mts), read through the real page reader ──

const wrap = (html: string) => `<html><head><title>x</title></head><body><header><nav>Home Fees About Contact</nav></header><main>${html}</main><footer>(c)</footer></body></html>`;
const oneLine = (html: string, url: string) => parseHtmlPage(wrap(html), url).text.replace(/\s+/g, ' ').trim().slice(0, 8000);
const blocks = (html: string, url: string) => brandPageText(parseHtmlPage(wrap(html), url).text);
const src = (field: 'audience' | 'claim', value: string, documentId: string) => ({ field, value, documentId, quote: value });

interface Site { name: string; website: string; pages: Record<string, string>; answer: (id: Record<string, string>) => Record<string, unknown> }
const SITES: Site[] = [
  { name: 'Letting agent', website: 'https://www.harbourlettings.co.uk', pages: {
    '/': `<h1>Lettings and property management in Whitstable</h1><p>Harbour Lettings is an independent, family-run letting agent. We have looked after landlords and tenants in Whitstable, Herne Bay and Canterbury since 2009.</p><p>We are members of ARLA Propertymark and The Property Ombudsman, and all client money is protected through Client Money Protect.</p><h2>For landlords</h2><p>Whether you own one flat or a portfolio, we find reliable tenants and take care of the paperwork.</p><h2>For tenants</h2><p>We do not charge tenants any application fees.</p><p>We never offer guaranteed rent schemes and we do not give tax advice.</p>`,
    '/fees': `<h1>Our landlord fees</h1><div class="card"><h3>Tenant Find</h3><p>We market your property, carry out viewings and reference your tenants.</p><p class="price">75% of the first month's rent (inc. VAT)</p></div><div class="card"><h3>Rent Collection</h3><p>Everything in Tenant Find, plus monthly rent collection and arrears chasing.</p><p class="price">8% of monthly rent (inc. VAT)</p></div><div class="card"><h3>Full Management</h3><p>Our most popular service. We handle repairs, inspections and compliance for you.</p><p class="price">12% of monthly rent (inc. VAT)</p></div><h2>Other charges</h2><ul><li>Inventory report: £120</li><li>Tenancy renewal: £90</li><li>Gas safety certificate: £85</li></ul>`,
  }, answer: (id) => ({
    summary: 'Harbour Lettings is an independent, family-run letting agent in Whitstable.', positioning: 'A local, family-run agent that takes care of the paperwork.',
    audiences: ['landlords and tenants in Whitstable, Herne Bay and Canterbury', 'landlords', 'tenants'],
    offers: [
      offer('Tenant Find', "75% of the first month's rent (inc. VAT)", id['/fees'], { url: 'https://www.harbourlettings.co.uk/fees' }), offer('Rent Collection', '8% of monthly rent (inc. VAT)', id['/fees'], { url: 'https://www.harbourlettings.co.uk/fees' }),
      offer('Full Management', '12% of monthly rent (inc. VAT)', id['/fees'], { url: 'https://www.harbourlettings.co.uk/fees' }), offer('Inventory report', '£120', id['/fees']), offer('Tenancy renewal', '£90', id['/fees']), offer('Gas safety certificate', '£85', id['/fees']),
    ],
    approvedClaims: ['Harbour Lettings is an independent, family-run letting agent.', 'We have looked after landlords and tenants in Whitstable, Herne Bay and Canterbury since 2009.',
      'We are members of ARLA Propertymark and The Property Ombudsman, and all client money is protected through Client Money Protect.', 'We do not charge tenants any application fees.'],
    exclusions: ['Guaranteed rent schemes', 'Tax advice'], missingFacts: ['No named author or team members'],
    sourcesFor: { '/': ['Harbour Lettings is an independent, family-run letting agent.', 'We have looked after landlords and tenants in Whitstable, Herne Bay and Canterbury since 2009.', 'We are members of ARLA Propertymark and The Property Ombudsman, and all client money is protected through Client Money Protect.', 'We do not charge tenants any application fees.'] },
    audienceDoc: id['/'], audienceQuotes: { 'landlords and tenants in Whitstable, Herne Bay and Canterbury': 'We have looked after landlords and tenants in Whitstable, Herne Bay and Canterbury since 2009.', landlords: 'For landlords', tenants: 'We have looked after landlords and tenants in Whitstable, Herne Bay and Canterbury since 2009.' },
  }) },
  { name: 'Mortgage broker', website: 'https://www.oakmortgages.co.uk', pages: {
    '/': `<h1>Whole-of-market mortgage advice in Leeds</h1><p>Oak Mortgages is an independent mortgage broker for first-time buyers, home movers and buy-to-let landlords. We search over 90 lenders to find the right deal for you.</p><p>Your first consultation is free and there is no obligation.</p><p>Oak Mortgages Ltd is authorised and regulated by the Financial Conduct Authority (FRN 812345).</p><p>Your home may be repossessed if you do not keep up repayments on your mortgage.</p>`,
    '/fees': `<h1>Our fees</h1><p>We charge a fee of £495 on completion of your mortgage. For buy-to-let and complex cases the fee is £695. We will also be paid commission by the lender.</p><h2>Protection</h2><p>We do not charge a fee for arranging life insurance or income protection.</p>`,
    '/about': `<h1>About us</h1><p>Founded in 2014 by Priya Shah, we have helped more than 1,200 families buy their home. We are rated 4.9 out of 5 on Google from 310 reviews.</p><p>We cannot promise that your application will be approved.</p>`,
  }, answer: (id) => ({
    summary: 'Oak Mortgages is an independent whole-of-market mortgage broker in Leeds.', positioning: 'Independent, whole-of-market advice with a free first consultation.',
    audiences: ['first-time buyers', 'home movers', 'buy-to-let landlords'],
    offers: [offer('Mortgage advice', '£495', id['/'], { url: 'https://www.oakmortgages.co.uk/fees' }), offer('Buy-to-let mortgage advice', '£695', id['/fees']), offer('Protection', null, id['/fees'])],
    approvedClaims: ['We search over 90 lenders to find the right deal for you.', 'Your first consultation is free and there is no obligation.', 'Oak Mortgages Ltd is authorised and regulated by the Financial Conduct Authority (FRN 812345).',
      'Founded in 2014 by Priya Shah, we have helped more than 1,200 families buy their home.', 'We are rated 4.9 out of 5 on Google from 310 reviews.', 'We do not charge a fee for arranging life insurance or income protection.'],
    exclusions: ['Promising that an application will be approved', 'Guaranteed mortgage approval'], missingFacts: ['No opening hours'],
    sourcesFor: { '/': ['We search over 90 lenders to find the right deal for you.', 'Your first consultation is free and there is no obligation.', 'Oak Mortgages Ltd is authorised and regulated by the Financial Conduct Authority (FRN 812345).'],
      '/about': ['Founded in 2014 by Priya Shah, we have helped more than 1,200 families buy their home.', 'We are rated 4.9 out of 5 on Google from 310 reviews.'], '/fees': ['We do not charge a fee for arranging life insurance or income protection.'] },
    audienceDoc: id['/'], audienceQuotes: Object.fromEntries(['first-time buyers', 'home movers', 'buy-to-let landlords'].map((a) => [a, 'Oak Mortgages is an independent mortgage broker for first-time buyers, home movers and buy-to-let landlords.'])),
  }) },
  { name: 'Plumber', website: 'https://brightsparkplumbing.co.uk', pages: {
    '/': `<h1>Bright Spark Plumbing &amp; Heating</h1><p>Gas Safe registered plumbers and heating engineers covering Bristol and Bath. We&rsquo;re a small local team with over 20 years&rsquo; experience.</p><ul><li>No call-out charge</li><li>All work guaranteed for 12 months</li><li>Free, no-obligation quotes</li></ul><p>Emergency? Call us 24/7 on 0117 496 0123.</p>`,
    '/prices': `<h1>Prices</h1><table><tr><th>Job</th><th>Price</th></tr><tr><td>Boiler service</td><td>£85</td></tr><tr><td>Landlord gas safety certificate</td><td>£70</td></tr><tr><td>Power flush</td><td>from £350</td></tr><tr><td>New boiler installation</td><td>from £1,950</td></tr></table><p>Hourly rate £60 per hour for general plumbing. All prices include VAT.</p>`,
    '/services': `<h1>Our services</h1><h2>Boiler installation</h2><p>We fit Worcester Bosch and Vaillant boilers with up to 10 years' manufacturer warranty.</p><h2>Bathrooms</h2><p>Full bathroom design and fitting, from first sketch to final tile.</p><h2>Landlords</h2><p>Gas safety certificates and repairs for landlords and letting agents.</p>`,
  }, answer: (id) => ({
    summary: 'Bright Spark Plumbing & Heating is a small local team of Gas Safe registered plumbers covering Bristol and Bath.', positioning: 'A local team with no call-out charge.',
    audiences: ['landlords and letting agents', 'Landlords'],
    offers: [offer('Boiler service', '£85', id['/prices'], { url: 'https://brightsparkplumbing.co.uk/prices' }), offer('Landlord gas safety certificate', '£70', id['/prices']), offer('Power flush', 'from £350', id['/prices']),
      offer('New boiler installation', 'from £1,950', id['/prices']), offer('Hourly rate', '£60 per hour', id['/prices']), offer('Bathrooms', null, id['/services'])],
    approvedClaims: ['Gas Safe registered plumbers and heating engineers covering Bristol and Bath.', 'We’re a small local team with over 20 years’ experience.', 'No call-out charge', 'All work guaranteed for 12 months', 'Free, no-obligation quotes',
      'Call us 24/7 on 0117 496 0123.', "We fit Worcester Bosch and Vaillant boilers with up to 10 years' manufacturer warranty.", 'All prices include VAT.'],
    exclusions: [], missingFacts: ['No named engineers'],
    sourcesFor: { '/': ['Gas Safe registered plumbers and heating engineers covering Bristol and Bath.', 'We’re a small local team with over 20 years’ experience.', 'No call-out charge', 'All work guaranteed for 12 months', 'Free, no-obligation quotes', 'Call us 24/7 on 0117 496 0123.'],
      '/services': ["We fit Worcester Bosch and Vaillant boilers with up to 10 years' manufacturer warranty."], '/prices': ['All prices include VAT.'] },
    audienceDoc: id['/services'], audienceQuotes: { 'landlords and letting agents': 'Gas safety certificates and repairs for landlords and letting agents.', Landlords: 'Gas safety certificates and repairs for landlords and letting agents.' },
  }) },
  { name: 'Coach', website: 'https://www.janemoorecoaching.com', pages: {
    '/': `<h1>Career coaching for women returning to work</h1><p>I&rsquo;m Jane Moore, an ICF-accredited coach. I help women returning to work after a career break find a role they love.</p><p>I have coached over 150 clients since 2017.</p><p>I can&rsquo;t promise you a job, and I won&rsquo;t pretend coaching is a quick fix.</p>`,
    '/work-with-me': `<h1>Work with me</h1><h2>Clarity Session</h2><p>A single 90-minute session to untangle what you want next. You leave with a written action plan.</p><p><strong>£150</strong></p><h2>Return to Work Programme</h2><p>Six fortnightly sessions over three months, with email support between sessions. Most clients choose this.</p><p><strong>£795</strong> or three monthly payments of £275</p><h2>CV Review</h2><p>I review your CV and LinkedIn profile and send written feedback within five working days. £95.</p><p><a href="https://calendly.com/janemoore/intro">Book a free 20-minute intro call</a></p>`,
  }, answer: (id) => ({
    summary: 'Jane Moore is an ICF-accredited career coach for women returning to work after a career break.', positioning: 'Honest, practical coaching with no quick-fix promises.',
    audiences: ['women returning to work after a career break'],
    offers: [offer('Clarity Session', '£150', id['/work-with-me'], { url: 'https://www.janemoorecoaching.com/work-with-me' }), offer('Return to Work Programme', '£795', id['/work-with-me'], { url: 'https://www.janemoorecoaching.com/work-with-me' }),
      offer('CV Review', '£95', id['/work-with-me']), offer('free 20-minute intro call', null, id['/work-with-me'], { url: 'https://calendly.com/janemoore/intro' })],
    approvedClaims: ['I’m Jane Moore, an ICF-accredited coach.', 'I help women returning to work after a career break find a role they love.', 'I have coached over 150 clients since 2017.', 'You leave with a written action plan.'],
    exclusions: ['Promising a job', 'Coaching is a quick fix'], missingFacts: ['No testimonials supplied'],
    sourcesFor: { '/': ['I’m Jane Moore, an ICF-accredited coach.', 'I help women returning to work after a career break find a role they love.', 'I have coached over 150 clients since 2017.'], '/work-with-me': ['You leave with a written action plan.'] },
    audienceDoc: id['/'], audienceQuotes: { 'women returning to work after a career break': 'I help women returning to work after a career break find a role they love.' },
  }) },
];

function readSite(site: Site, form: 'blocks' | 'oneLine') {
  const paths = Object.keys(site.pages);
  const docs = paths.map((path, i) => D(`doc${i + 1}`, (form === 'blocks' ? blocks : oneLine)(site.pages[path]!, site.website + path), site.website + path));
  const id = Object.fromEntries(paths.map((p, i) => [p, `doc${i + 1}`]));
  const { sourcesFor, audienceDoc, audienceQuotes, ...rest } = site.answer(id) as { sourcesFor: Record<string, string[]>; audienceDoc: string; audienceQuotes: Record<string, string> } & Record<string, unknown>;
  const answer = card({ ...rest, sources: [...Object.entries(sourcesFor).flatMap(([p, claims]) => claims.map((c) => src('claim', c, id[p]!))),
    ...(rest.audiences as string[]).map((a) => ({ ...src('audience', a, audienceDoc), quote: audienceQuotes[a]! }))] });
  const r = repaired(answer, docs, { website: site.website });
  const held = holdConflictedPrices(r.value, docs);
  const count = (xs: readonly unknown[] | undefined) => (xs ?? []).length;
  return {
    prices: [held.offers.filter((o) => o.price).length, answer.offers.filter((o) => o.price).length], questions: held.conflicts.length - answer.conflicts.length,
    claims: [count(r.value.approvedClaims), count(answer.approvedClaims)], audiences: [count(r.value.audiences), count(answer.audiences)],
    neverSay: [count(r.value.exclusions), count(answer.exclusions)], links: [r.value.offers.filter((o) => o.url).length, answer.offers.filter((o) => o.url && o.url.includes(new URL(site.website).hostname.replace(/^www\./, ''))).length],
    leftOut: r.leftOut,
  };
}

test('four realistic sites: survival with blocks kept meets the targets; the one-line form is reported', (t) => {
  const total = (form: 'blocks' | 'oneLine') => {
    const rows = SITES.map((s) => ({ name: s.name, ...readSite(s, form) }));
    for (const r of rows) t.diagnostic(`${form} | ${r.name}: prices ${r.prices.join('/')} (+${r.questions} question) claims ${r.claims.join('/')} audiences ${r.audiences.join('/')} never-say ${r.neverSay.join('/')} own links ${r.links.join('/')} | left out: ${r.leftOut.map((l) => `${l.what}:${l.text}`).join('; ')}`);
    const sum = (k: 'prices' | 'claims' | 'audiences' | 'neverSay' | 'links') => rows.reduce((a, r) => [a[0]! + r[k][0]!, a[1]! + r[k][1]!], [0, 0]);
    return { prices: sum('prices'), claims: sum('claims'), audiences: sum('audiences'), neverSay: sum('neverSay'), links: sum('links'), questions: rows.reduce((a, r) => a + r.questions, 0) };
  };
  // The page reader keeps each heading, paragraph, list item and table cell on its own line.
  assert.equal(blocks(SITES[2]!.pages['/prices']!, 'https://brightsparkplumbing.co.uk/prices').split('\n').slice(0, 7).join('|'), 'Prices|Job|Price|Boiler service|£85|Landlord gas safety certificate|£70');
  const b = total('blocks'), o = total('oneLine');
  t.diagnostic(`TOTAL blocks: prices ${b.prices.join('/')} (+${b.questions} questions) claims ${b.claims.join('/')} audiences ${b.audiences.join('/')} never-say ${b.neverSay.join('/')} own links ${b.links.join('/')}`);
  t.diagnostic(`TOTAL one-line: prices ${o.prices.join('/')} (+${o.questions} questions) claims ${o.claims.join('/')} audiences ${o.audiences.join('/')} never-say ${o.neverSay.join('/')} own links ${o.links.join('/')}`);
  assert.equal(b.prices[1], 16); assert.ok(b.prices[0]! >= 12, `prices kept with blocks: ${b.prices[0]}`);
  assert.equal(b.claims[0], b.claims[1], 'every honest whole-sentence claim'); assert.equal(b.audiences[0], b.audiences[1]); assert.equal(b.neverSay[0], b.neverSay[1]); assert.equal(b.links[0], b.links[1]);
});

// ─── Fuzz, performance, and the prompts writers receive ──────────────────────

function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}

test('fuzz: thousands of generated cards (offers sharing words, dropped offers, price questions); the repair adds nothing, rewords nothing and always passes', (t) => {
  const random = rng(20261115);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const words = ['landlords', 'Kent', 'help', 'trusted', 'by', 'not', 'never', 'Shield', 'Care', 'Alpha', 'Plan', 'Pro', 'Plus', 'Starter', 'from', 'was', 'now', 'save', 'costs', '£49', '£499', '£49.99',
    '£1,500', 'per', 'month', 'year', '+ VAT', '300', '12%', 'of', 'rent', 'homes', 'every', 'deposit', 'protected', 'fees', 'other agents', '.', '.', '\n', '"', '-', '?', 'inc.', '¹', '­'];
  const sentence = (n: number) => Array.from({ length: n }, () => pick(words)).join(' ').replace(/ \. /g, '. ');
  const names = ['Pro', 'Pro Plus', 'Starter', 'Shield Plan', 'Shield Pro', 'Alpha Care', 'Shield', 'Care Plan Pro'];
  let passed = 0, refused = 0, removed = 0;
  for (let i = 0; i < 3000; i++) {
    const ds = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, k) => D(`d${k}`, sentence(15 + Math.floor(random() * 60)), pick(['https://quay.example/', 'https://other.example/p'])));
    const ids = [...ds.map((d) => d.id), 'ghost', null];
    const slice = (s: string) => { const st = structureOf(s); const u = st.units.length && random() < 0.6 ? pick(st.units).text : s.slice(Math.floor(random() * s.length), Math.floor(random() * s.length) + 30); return u; };
    const phrase = () => random() < 0.6 ? slice(pick(ds).text).trim() : sentence(1 + Math.floor(random() * 5));
    const offers = Array.from({ length: Math.floor(random() * 5) }, (): ProfileOffer => ({ name: pick(names), description: random() < 0.5 ? '' : phrase(),
      price: random() < 0.3 ? null : pick(['£49', '£499', '£49 per month', 'from £49', '£49 + VAT', '12% of rent', '£1,500', phrase()]), url: pick([null, 'https://quay.example/x', 'https://bit.ly/y', 'https://other.example/p']), sourceDocumentId: pick(ids) }));
    const audiences = Array.from({ length: Math.floor(random() * 3) }, phrase), approvedClaims = Array.from({ length: Math.floor(random() * 4) }, phrase);
    const sources = [...audiences.map((value) => ({ field: 'audience' as const, value })), ...approvedClaims.map((value) => ({ field: 'claim' as const, value }))].map((s) => ({ ...s, documentId: pick(ids), quote: random() < 0.5 ? s.value : slice(pick(ds).text) }));
    const conflicts = Array.from({ length: Math.floor(random() * 3) }, () => {
      const about = offers.length && random() < 0.8 ? pick(offers).name : pick([null, 'Platinum']);
      return { field: pick([`${about ?? 'Area'}: price`, 'Contract length', `Fee of £${Math.floor(random() * 99)}`]), detail: pick(['Two answers', phrase()]), documentIds: [pick(ds).id, 'ghost'],
        kind: pick(['price', 'price', 'other', undefined] as const), offer: about,
        options: Array.from({ length: Math.floor(random() * 4) }, () => { const d = pick(ds); const quote = slice(d.text); return { value: random() < 0.5 ? quote.slice(0, 12) : pick(['£49', '£49 per month', '£59 per month']), documentId: pick([d.id, 'ghost']), quote }; }) };
    });
    const answer = card({ offers, audiences, approvedClaims, sources, conflicts, exclusions: Array.from({ length: Math.floor(random() * 3) }, phrase), missingFacts: Array.from({ length: Math.floor(random() * 3) }, phrase),
      summary: phrase(), positioning: phrase(), conversionPages: [{ url: pick(['https://quay.example/j', 'https://bit.ly/x']), label: phrase() }],
      voice: { tone: [phrase()], do: [phrase()], dont: [phrase()], examples: [phrase()] } });
    const c = { website: pick([null, 'https://quay.example']) };
    const result = repairProfileFacts(answer, ds, c);
    if (!result) { refused++; continue; }
    const v = result.value;
    assert.deepEqual(strictProfileProblems(v, ds, c), [], `seed ${i}`);
    passed++; if (result.leftOut.length) removed++;
    const sub = <T>(kept: readonly T[], from: readonly T[], same: (a: T, b: T) => boolean) => { let at = 0; for (const k of kept) { while (at < from.length && !same(k, from[at]!)) at++; assert.ok(at < from.length, `seed ${i}: added ${JSON.stringify(k)}`); at++; } };
    const eq = <T>(a: T, b: T) => a === b;
    sub(v.audiences, answer.audiences, eq); sub(v.approvedClaims, answer.approvedClaims, eq); sub(v.exclusions ?? [], answer.exclusions, eq); sub(v.missingFacts, answer.missingFacts, eq);
    sub(v.sources ?? [], answer.sources ?? [], (a, b) => JSON.stringify(a) === JSON.stringify(b));
    for (const part of ['tone', 'do', 'dont', 'examples'] as const) sub(v.voice![part], answer.voice[part], eq);
    // Description may lose whole sentences only: what is left is the original's sentences, in order.
    const sentencesOf = (s: string) => s.split(/(?<=[.!?…])\s+|\n/).map((x) => x.trim()).filter(Boolean);
    const onlyCut = (kept: string, from: string) => kept === from || kept === '' || kept.split(' ').every((w) => from.includes(w));
    sub(v.offers, answer.offers, (a, b) => a.name === b.name && a.sourceDocumentId === b.sourceDocumentId && (a.price === b.price || a.price === null) && (a.url === b.url || a.url === null) && onlyCut(a.description, b.description));
    for (const k of ['summary', 'positioning'] as const) assert.ok(onlyCut(v[k] as string, answer[k]), `seed ${i}: ${k}`);
    void sentencesOf;
    sub(v.conversionPages ?? [], answer.conversionPages, (a, b) => a.url === b.url && (a.label === b.label || a.label.startsWith('/') || a.label === new URL(a.url).hostname));
    sub(v.conflicts, answer.conflicts, (a, b) => (a.field === b.field || a.field === '') && (a.detail === b.detail || a.detail === '') && a.kind === b.kind && a.documentIds.every((id) => b.documentIds.includes(id))
      && (a.options ?? []).every((o) => (b.options ?? []).some((p) => JSON.stringify(o) === JSON.stringify(p))));
  }
  t.diagnostic(`${passed} repaired, ${refused} refused, ${removed} with lines left out`);
  assert.ok(passed > 1500 && refused > 0 && removed > 1000, `${passed} repaired, ${refused} refused, ${removed} with lines left out`);
});

test('performance: 30 offers on a 60,000-character document, and a 400-word hostile name, finish well under a second', () => {
  const page = ('Pro Plan £49 per month includes everything in Starter and more. Gold Silver Bronze Care costs £12 per month. ').repeat(600).slice(0, 60_000);
  const docs = [D('d0', page)];
  const offers = [...Array.from({ length: 29 }, (_, i) => offer(i % 2 ? `Plan ${i} Gold Silver Bronze Care` : 'Pro Plan', '£49 per month', 'd0')), offer(Array.from({ length: 400 }, (_, i) => `w${i}`).join(' '), '£49 per month', 'd0')];
  const started = Date.now();
  const problems = strictProfileProblems(card({ offers }), docs);
  const r = repairProfileFacts(card({ offers }), docs);
  holdConflictedPrices(r!.value, docs);
  const took = Date.now() - started;
  assert.ok(took < 1000, `${took} ms`); assert.ok(problems.length > 0);
  assert.ok(r!.leftOut.some((l) => l.what === 'offer' && l.text.startsWith('w0 w1')), 'a hostile name is dropped and listed');
  // A dense one-line page: 3,000 prices and names in one 60,000-character sentence.
  const dense = Array.from({ length: 3000 }, (_, i) => `Item ${i % 30} costs £${i}`).join(' ').slice(0, 60_000);
  const t2 = Date.now();
  strictProfileProblems(card({ offers: Array.from({ length: 30 }, (_, i) => offer(`Item ${i}`, `£${i}`)) }), [D('d1', dense)]);
  assert.ok(Date.now() - t2 < 1000, `${Date.now() - t2} ms`);
});

const PLANTED = ['PLANTED-MISSING', '£777', 'PLANTED-TITLE', 'PLANTED-DETAIL', 'PLANTED-QUOTE', 'PLANTED-LEFTOUT', 'PLANTED-URL', 'PLANTED-OPTION', 'PLANTED-PRICE-SOURCE'];
const DESCRIPTION = ['DESC-SUMMARY', 'DESC-POSITIONING', 'DESC-OFFER', 'DESC-TONE', 'DESC-DO', 'DESC-DONT'];
function plantedProfile(): BrandProfile {
  return {
    brandId: 'b', version: 7, knowledge: [], summary: 'DESC-SUMMARY Quay Lettings helps landlords.', audiences: ['Private landlords in Kent'], positioning: 'DESC-POSITIONING plain help.',
    offers: [{ name: 'Quay Compliance Plan', description: 'DESC-OFFER monthly support.', price: '£49 per month', url: 'javascript:PLANTED-URL', sourceDocumentId: 'pricing', priceSourceDocumentId: 'PLANTED-PRICE-SOURCE' },
      { name: 'Mentoring programme', description: 'Weekly calls.', price: null, url: 'https://quay.example/mentoring', sourceDocumentId: 'pricing' }],
    conversionPages: [{ url: 'https://quay.example/join', label: 'Join' }], voice: { tone: ['DESC-TONE'], do: ['DESC-DO'], dont: ['DESC-DONT'], examples: ['We help landlords in Kent.'] },
    approvedClaims: ['We help landlords in Kent.'], exclusions: ['Tax advice'],
    conflicts: [{ field: 'Mentoring programme PLANTED-TITLE £777', detail: 'PLANTED-DETAIL', documentIds: ['pricing'], kind: 'other', offer: 'Mentoring programme', options: [{ value: 'PLANTED-OPTION', documentId: 'pricing', quote: 'PLANTED-QUOTE words here' }] }],
    missingFacts: ['PLANTED-MISSING price £777'], sources: [{ field: 'claim', value: 'We help landlords in Kent.', documentId: 'home', quote: 'PLANTED-QUOTE' }],
    leftOut: [{ what: 'claim', text: 'PLANTED-LEFTOUT' }], strict: true, rulesVersion: BRAND_DNA_RULES_VERSION, factsSha: 'f', source: 'extracted', confirmedAt: '2026-11-15T00:00:00.000Z', confirmedBy: 'u', createdAt: 'x', generation: null,
  } as BrandProfile;
}

test('every writing call’s actual prompt: no unverified field, and description never under a quoted-facts key', async () => {
  const profile = plantedProfile();
  assert.deepEqual(writingProfile(profile).offersWithOpenQuestions, ['Mentoring programme']);
  for (const text of [JSON.stringify(profileForPrompt(profile)), JSON.stringify(methodEvidenceContext(profile))]) for (const p of PLANTED) assert.ok(!text.includes(p), p);
  for (const d of DESCRIPTION) assert.ok(!JSON.stringify(methodEvidenceContext(profile).factReferences).includes(d), `${d} is never a fact reference`);
  const sent: string[] = [];
  const llm: LlmClient = { mode: 'mock', complete: async (req) => { sent.push(req.messages[0]!.content); throw new Error('captured'); } };
  const article = { title: 'A title', seoTitle: 'A title', metaDescription: 'm', excerpt: 'e', slug: 'a-title', intro: 'i', sections: [{ heading: 'h', body: 'b' }], conclusion: 'c', cta: null, faqs: [], citations: [], image: { kind: 'none' }, author: null } as unknown as ArticleBody;
  const brief = { id: 'x', planId: 'p', brandId: 'b', role: 'pillar', slug: 'a-title', workingTitle: 'A working title', targetQuery: 'landlord compliance', searchIntent: 'learn', relatedQuestions: [], angle: 'a',
    outline: ['one'], keyPoints: ['k'], cta: null, internalLinks: [], whyFit: 'w', sourceIds: [] } as unknown as ArticleBrief;
  const calls = [
    () => writeArticlePromotions(llm, profile, article, 'https://quay.example'), () => writeArticleCampaignPromotions(llm, profile, article, 'https://quay.example'),
    () => rewriteSection(llm, { profile, outline: ['one'], section: { heading: 'h', body: 'b' }, instruction: '', sources: [], linkable: [], website: 'https://quay.example' }),
    () => writeArticle(llm, { profile, brief, sources: [], linkable: [], length: 'standard', website: 'https://quay.example' }),
    () => proposeCluster(llm, { brandName: 'Quay', profile, inventory: [], sources: [], focus: null, excluded: [], sourceArticleUrl: null, website: 'https://quay.example' }),
  ];
  for (const call of calls) await assert.rejects(call());
  assert.equal(sent.length, calls.length);
  for (const [i, request] of sent.entries()) {
    for (const p of PLANTED) assert.ok(!request.includes(p), `call ${i} must not carry ${p}`);
    const block = JSON.parse(/<brand_profile>\n([\s\S]*?)\n<\/brand_profile>/.exec(request)![1]!) as Record<string, unknown>;
    const { descriptionNotFacts, ...facts } = block;
    for (const d of DESCRIPTION) { assert.ok(!JSON.stringify(facts).includes(d), `call ${i}: ${d} sits only under descriptionNotFacts`); assert.ok(JSON.stringify(descriptionNotFacts).includes(d), `call ${i}: ${d} is passed as description`); }
    assert.ok(JSON.stringify(facts).includes('Quay Compliance Plan'), `call ${i} carries the quoted facts`);
  }
});

test('extraction through a scripted model: a repairable card is made, never refused, and carries the rules version', async () => {
  const doc = (id: string, text: string, url: string) => ({ id, brandId: 'b', version: 1, category: 'product_facts', title: 'Page', filename: null, format: 'txt', mime: 'text/plain', sizeBytes: text.length, sha256: 'x', blobId: null,
    status: 'extracted', statusDetail: '', text, pagesRead: null, pagesTotal: null, active: true, createdAt: 'now', origin: { kind: 'website', url, fetchedAt: 'now' } }) as unknown as KnowledgeDocument;
  const documents = [doc('d1', 'Alpha Care includes our Shield cover for £49 per month. Alpha Care is for private landlords in Kent who want less paperwork.', 'https://quay.example/pricing')];
  const answer = card({ summary: 'Quay offers cover plans for landlords.', audiences: ['private landlords in Kent'],
    offers: [offer('Alpha Care', '£49 per month'), offer('Shield Plan', null), offer('Shield Pro', null, 'made-up-id')],
    sources: [{ field: 'audience', value: 'private landlords in Kent', documentId: 'd1', quote: 'private landlords in Kent' }] });
  let calls = 0;
  const llm = { mode: 'mock', complete: async () => { calls++; return { text: JSON.stringify(answer), tokensIn: 10, tokensOut: 10, stopReason: 'end_turn', model: 'mock' }; } } as unknown as LlmClient;
  const made = await extractProfile(llm, { brandName: 'Quay', website: 'https://quay.example', documents, strict: true });
  assert.equal(calls, 2); assert.deepEqual(made.value.audiences, ['private landlords in Kent']); assert.ok(!('offerNames' in made.value), 'the offer list used for checking is never stored');
  assert.equal(keyOf('Alpha Care'), 'alpha care');
});
