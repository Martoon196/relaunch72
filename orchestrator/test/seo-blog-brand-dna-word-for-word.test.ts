/**
 * Brand DNA website door, rules version 2 (round 3): page structure recorded by the reader, claims as whole sentences,
 * prices tied by structure, never by "the first amount". Every reviewer reproduction from rounds 1 and 2 is a case here,
 * on text stored with structure markers and on old one-line text. The writing side is unchanged: a snapshot taken from a
 * checkout of 1a9e5160 is compared byte for byte. No network, model or database is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  brandDnaCard, brandPageText, BRAND_DNA_RULES_VERSION, priceLineSources, cleanProvenance, holdConflictedPrices, leftOutLines, missingFactShowable, repairProfileFacts, settleConflict,
  strictProfileProblems, type ProfileFacts,
} from '../src/seo-blog/brand-dna.js';
import { audienceUnit, claimSentence, keyOf, linkAllowed, linkLabel, neverSayKept, priceCandidates, structureOf, withoutMarkers } from '../src/seo-blog/brand-dna-rules.js';
import { parseHtmlPage, brandPageHtmlLines, brandPageLines } from '../src/seo-blog/html.js';
import { extractProfile, profileForPrompt, proposeCluster, rewriteSection, writeArticle, writeArticleCampaignPromotions, writeArticlePromotions } from '../src/seo-blog/generation.js';
import { methodEvidenceContext } from '../src/seo-blog/method-evidence.js';
import { supportingPassage } from '../src/seo-blog/research.js';
import { brandDnaPage } from '../src/portal/brand-dna-view.js';
import type { LlmClient } from '../src/llm/client.js';
import type { BrandProfile, KnowledgeDocument, ProfileOffer } from '../src/seo-blog/types.js';

const D = (id: string, text: string, page?: string) => ({ id, text, ...(page ? { page } : {}) });
type Card = ProfileFacts & { summary: string; positioning: string; voice: { tone: string[]; do: string[]; dont: string[]; examples: string[] }; exclusions: string[]; conversionPages: { url: string; label: string }[] };
const card = (over: Record<string, unknown> = {}): Card => ({ summary: 'A business summary line.', audiences: [], positioning: '', offers: [], conversionPages: [], voice: { tone: [], do: [], dont: [], examples: [] },
  approvedClaims: [], exclusions: [], conflicts: [], missingFacts: [], sources: [], ...over }) as Card;
const offer = (name: string, price: string | null, sourceDocumentId = 'd1', extra: Partial<ProfileOffer> = {}): ProfileOffer => ({ name, description: '', price, url: null, sourceDocumentId, ...extra });
const claim = (value: string, documentId: string, quote = value) => ({ field: 'claim' as const, value, documentId, quote });
const aud = (value: string, documentId: string, quote = value) => ({ field: 'audience' as const, value, documentId, quote });
const wrap = (html: string) => `<html><head><title>x</title></head><body><header><nav>Home Fees About Contact</nav></header><main>${html}</main><footer>(c)</footer></body></html>`;
/** As the website read stores a page now (structured lines) and as it stored it before (one line). */
const tagged = (html: string) => brandPageText(brandPageHtmlLines(wrap(html)));
const oneLine = (html: string, url = 'https://x.example/') => parseHtmlPage(wrap(html), url).text.replace(/\s+/g, ' ').trim().slice(0, 8000);
const BOTH = [['tagged', tagged], ['one-line', oneLine]] as const;
/** The whole website door after the model's last answer: check, repair, re-check, provenance, price questions. */
function door(value: ProfileFacts, docs: { id: string; text: string; page?: string }[], ctx = {}) {
  const problems = strictProfileProblems(value, docs, ctx);
  const rep = repairProfileFacts(value, docs, ctx);
  assert.ok(rep, 'repairable');
  assert.deepEqual(strictProfileProblems(rep.value, docs, ctx), [], 'a repaired card passes every rule');
  const { offerNames: _n, ...kept } = rep.value;
  return { problems, rep, final: holdConflictedPrices(cleanProvenance(kept, docs, true), docs) };
}
const ctx = { website: 'https://x.example' };

// ─── B. The page reader records structure ────────────────────────────────────

test('page reader: headings, list items, table rows and customer words are marked; struck text is gone; label and button stay inline', () => {
  const lines = brandPageLines(`<h2>Fees</h2><p>We do not offer <label>guaranteed rent</label> or legal cover.</p><p><s>Rent is guaranteed.</s> Rent is paid when your tenant pays.</p><ul><li>No call-out charge</li></ul>
<table><tr><th>Job</th><th>Price</th></tr><tr><td>Boiler service</td><td>£85</td></tr></table><blockquote><p>Brilliant.</p><cite>— J. Patel</cite></blockquote><div class="review"><p>Great service.</p></div>
<h2>What our landlords say</h2><p>They found me a tenant in four days.</p><p>Mrs K, Tankerton</p><h2>Contact</h2><p>Call us today.</p>`).split('\n');
  assert.deepEqual(lines, ['## Fees', 'We do not offer guaranteed rent or legal cover.', 'Rent is paid when your tenant pays.', '• No call-out charge', '| Job | Price', '| Boiler service | £85',
    '❝ Brilliant.', '❝ — J. Patel', '❝ Great service.', '## What our landlords say', '❝ They found me a tenant in four days.', '❝ Mrs K, Tankerton', '## Contact', 'Call us today.']);
  // The marker never reaches a person or a comparison, and every other reader of the page is unchanged.
  assert.equal(withoutMarkers('# Fees\n• No call-out charge\n| Boiler service | £85'), 'Fees\nNo call-out charge\nBoiler service | £85');
  assert.equal(keyOf('• No call-out charge'), keyOf('No call-out charge'));
  const page = parseHtmlPage(wrap('<h1>Prices</h1><p><s>Old</s> New text here for the page.</p><ul><li>One</li></ul>'), 'https://x.example/');
  assert.equal(page.text, 'Prices\n Old New text here for the page.\n One', '`text` is exactly what 1a9e5160 produced');
  assert.deepEqual(page.headings, [{ level: 1, text: 'Prices' }]);
  assert.equal(supportingPassage(page.text, 'new text'), 'Prices Old New text here for the page.');
});

// ─── C. Claims ───────────────────────────────────────────────────────────────

test('claims: round-1 B1/B2 reproductions stay refused', () => {
  const rows: [string, string, string][] = [
    ['We are not FCA regulated and do not give mortgage advice.', 'FCA regulated', 'FCA regulated'],
    ['We are not the cheapest agent in Kent, and we never will be.', 'the cheapest agent in Kent', 'The cheapest agent in Kent'],
    ['Quay is an unregulated introducer of bridging finance.', 'regulated introducer of bridging finance', 'Regulated introducer of bridging finance'],
    ['"They are the best letting agent in Kent and saved me thousands" - Sarah, landlord.', 'the best letting agent in Kent', 'The best letting agent in Kent'],
    ['"They are the best letting agent in Kent and saved me thousands" - Sarah, landlord.', '"They are the best letting agent in Kent and saved me thousands"', 'They are the best letting agent in Kent and saved me thousands'],
    ['Our aim is to become the largest independent agent in Kent by 2030.', 'the largest independent agent in Kent', 'The largest independent agent in Kent'],
    ['We are unable to offer guaranteed rent or legal advice.', 'offer guaranteed rent', 'We offer guaranteed rent'],
    ['Rent is guaranteed for the first 18 months only, subject to referencing.', 'Rent is guaranteed for the first 18 months only', 'Rent is guaranteed'],
    ['Results are never guaranteed. Rent is paid monthly to every landlord.', 'guaranteed. Rent is paid monthly', 'Guaranteed rent is paid monthly'],
    ['Landlords pay a 10% management fee. Tenants pay no fees.', 'Landlords pay a 10% management fee. Tenants pay no fees.', 'Landlords pay no fees'],
    ['We manage 300 properties and are trusted by 50 landlords across Kent.', 'We manage 300 properties and are trusted by 50 landlords', 'Trusted by 300 landlords'],
    ['Fees apply to every tenancy and there is no guaranteed rent.', 'Fees apply to every tenancy and there is no guaranteed rent', 'No fees on every tenancy and guaranteed rent'],
    ['We may be able to recover unpaid rent on your behalf.', 'We may be able to recover unpaid rent', 'We recover unpaid rent'],
    ['We will be FCA authorised once our application is approved.', 'We will be FCA authorised', 'We are FCA authorised'],
    ['Clients could save up to £500 a year on their mortgage.', 'Clients could save up to £500 a year', 'Clients save £500 a year'],
    ['Unlike Foxtons, who charge 20% plus VAT, our fee is fair.', 'Foxtons, who charge 20% plus VAT', 'We charge 20% plus VAT'],
    ['Our tenants rarely pay late and we hardly ever lose a deposit dispute.', 'we hardly ever lose a deposit dispute', 'We lose a deposit dispute'],
    ['Trusted by landlords across Kent.', 'Trusted by landlords across Kent', 'Νοτ trusted by landlords'],
    ['Trusted by 300 landlords across Kent.', 'Trusted by 300 landlords', 'Trusted by ٣٠٠٠ landlords'],
    ['Our rates: top agent fees explained', 'Our rates: top agent fees explained', 'Top rated agent'],
    ['Is your landlord insurance fully covered by us? Sadly it is something we stopped doing.', 'Is your landlord insurance fully covered by us?', 'Is your landlord insurance fully covered by us?'],
    ['We never promise guaranteed rent.', 'We never promise guaranteed rent', 'We promise guaranteed rent'],
    ['Over 10² landlords trust us.', 'Over 10² landlords trust us', 'Over 102 landlords trust us.'],
    ['We charge 1.5% of the sale price.', 'We charge 1.5% of the sale price.', 'We charge 1-5% of the sale price.'],
    ['We charge 1.5% of the sale price.', 'We charge 1.5% of the sale price.', 'We charge 1, 5% of the sale price.'],
  ];
  for (const [text, quote, c] of rows) {
    const r = door(card({ approvedClaims: [c], sources: [claim(c, 'd1', quote)] }), [D('d1', text, 'https://x.example/')], ctx);
    assert.deepEqual(r.final.approvedClaims, [], c);
  }
  // A whole sentence (four words or more, ending . or !) or a whole clean list item is a claim.
  for (const [text, c] of [['Quay Lettings is a family-run agent. We are not FCA regulated.', 'We are not FCA regulated.'], ['We help landlords in Kent. Trusted by 300 landlords!', 'trusted by 300 LANDLORDS!'],
    ['Oak Mortgages Ltd. is regulated by the FCA. We search 90 lenders.', 'Oak Mortgages Ltd. is regulated by the FCA.'], ['Smith Bros. Lettings is a family firm.', 'Smith Bros. Lettings is a family firm.'],
    ['Full Manage­ment is our most popular service.', 'Full Management is our most popular service.'], ['• No call-out charge\n• All work guaranteed for 12 months', 'All work guaranteed for 12 months']] as const)
    assert.ok(claimSentence(c, { text }), c);
  for (const [text, c] of [['No call-out charge All work guaranteed for 12 months Free quotes', 'All work guaranteed for 12 months'], ['Trusted by landlords.', 'Trusted by landlords.'],
    ['# We are a family firm.', 'We are a family firm.'], ['| We are a family firm. | Yes', 'We are a family firm.'], ['❝ We are a family firm.', 'We are a family firm.'],
    ['If only we could say… rent is guaranteed for life.', 'rent is guaranteed for life.'], [`${'x '.repeat(10_001)}We are a family firm.`, 'We are a family firm.']] as const)
    assert.equal(claimSentence(c, { text }), null, c.slice(0, 40));
});

test('claims and audiences: round-2 page layouts (units.mts), tagged and one-line', () => {
  const t = (html: string, claims: string[], audiences: string[] = [], keep: { tagged?: string[]; oneLine?: string[] } = {}) => {
    for (const [mode, read] of BOTH) {
      const docs = [D('d1', read(html), 'https://x.example/')];
      const r = door(card({ approvedClaims: claims, audiences, sources: [...claims.map((c) => claim(c, 'd1')), ...audiences.map((a) => aud(a, 'd1', a.length >= 12 ? a : `${a} ${a} ${a}`))] }), docs, ctx);
      const expected = (mode === 'tagged' ? keep.tagged : keep.oneLine) ?? [];
      assert.deepEqual(r.final.approvedClaims, expected, `${mode}: ${claims.join(' | ')}`);
      assert.deepEqual(r.final.audiences, [], `${mode}: ${audiences.join(' | ')}`);
    }
  };
  t(`<h2>What our landlords say</h2><div class="review"><p>Simply the best letting agent in Kent.</p><p class="name">Sarah T, landlord</p></div><div class="review"><p>They got me £200 more rent than any other agent.</p><p class="name">Mark, Whitstable</p></div>`,
    ['Simply the best letting agent in Kent.', 'They got me £200 more rent than any other agent.']);
  t(`<blockquote><p>My rent has been paid on time every month for six years.</p><cite>— J. Patel</cite></blockquote>`, ['My rent has been paid on time every month for six years.']);
  t(`<div class="reviews"><span>★★★★★</span><p>Excellent service, sold my house in a week</p><span>John D.</span><span>Verified review</span></div>`, ['Excellent service, sold my house in a week']);
  t(`<p><em>Best decision we ever made.</em> — Sarah</p>`, ['Best decision we ever made.']);
  t(`<h3>What we will never tell you</h3><ul><li>Your rent is guaranteed</li><li>We are the cheapest agent in town</li></ul><p>We do not:</p><ul><li>Offer guaranteed rent</li><li>Give tax advice</li></ul>`, ['Your rent is guaranteed', 'We are the cheapest agent in town', 'Offer guaranteed rent', 'Give tax advice']);
  t(`<h2>Five myths about letting</h2><ol><li>Letting agents are all the same.</li><li>You can evict a tenant in two weeks.</li></ol>`, ['Letting agents are all the same.', 'You can evict a tenant in two weeks.'], [],
    { oneLine: ['You can evict a tenant in two weeks.'] }); // listed residual on old one-line text: the myths heading is no longer a separate line
  t(`<table><tr><th>Feature</th><th>Tenant Find</th></tr><tr><td>Rent guarantee insurance</td><td>No</td></tr><tr><td>✗ Guaranteed rent</td></tr><tr><td>❌ FCA regulated</td></tr></table>`, ['Rent guarantee insurance', 'Guaranteed rent', 'FCA regulated']);
  t(`<h3>Do you guarantee the rent</h3><p>No.</p><h3>Guaranteed rent</h3><p>Sorry, this is something we have stopped offering.</p>`, ['Do you guarantee the rent', 'Guaranteed rent']);
  t(`<p>We are not, unlike Smith Bros. Lettings, tied to one insurer.</p><p>We do not cover Gt. Yarmouth and Lowestoft are covered by our Norwich office.</p>`, ['Lettings, tied to one insurer.', 'Yarmouth and Lowestoft are covered by our Norwich office.']);
  t(`<p>If only we could say… rent is guaranteed for life.</p>`, ['rent is guaranteed for life.']);
  t(`<p><s>Rent is guaranteed.</s> Rent is paid when your tenant pays.</p>`, ['Rent is guaranteed.']);
  // Old one-line text still holds struck words (the reader only drops them from now on): a four-word struck sentence is a listed residual.
  t(`<p><s>Your rent is always guaranteed.</s> Rent is paid when your tenant pays.</p>`, ['Your rent is always guaranteed.'], [], { oneLine: ['Your rent is always guaranteed.'] });
  t(`<p>We do not offer <label>guaranteed rent</label> or legal cover.</p><p>We are not <button>FCA regulated</button></p>`, ['guaranteed rent', 'FCA regulated', 'or legal cover.']);
  t(`<h3>Who we do not work with</h3><ul><li>Student landlords</li><li>HMO owners</li></ul><p>We are unable to help landlords outside Kent.</p><p>We stopped serving holiday let owners in 2022.</p>`, [], ['Student landlords', 'HMO owners', 'landlords outside Kent', 'holiday let owners']);
  // Known residual: a whole sentence whose meaning a neighbouring sentence reverses is still a sentence.
  const residual = door(card({ approvedClaims: ['Every landlord gets guaranteed rent.'], sources: [claim('Every landlord gets guaranteed rent.', 'd1')] }), [D('d1', tagged('<p>It would be a lie to say this. Every landlord gets guaranteed rent. Nobody can promise that.</p>'))]);
  assert.deepEqual(residual.final.approvedClaims, ['Every landlord gets guaranteed rent.'], 'listed residual: the owner reads it with its sentence');
});

test('claims, audiences and offer names on one page of aspirations, recommendations and testimonials (blast.mts)', () => {
  const html = `<h1>Harbour Lettings</h1><p>Our aim is to become the largest independent agent in Kent by 2030.</p><p>We hope to be FCA regulated by 2027.</p><p>Some landlords think rent is guaranteed by their agent.</p><p>For rent protection we recommend HomeLet Rent Guarantee insurance, which you buy direct from HomeLet.</p>
<div class="t"><p>“Harbour were brilliant from start to finish. They found us a tenant in four days and the rent has never been late. Easily the best letting agent in Kent.”</p><p>Mrs K, Tankerton</p></div>
<div class="t"><p>“Great service. Highly recommended. Five stars.” — Tom</p></div>`;
  for (const [mode, read] of BOTH) {
    const docs = [D('d1', read(html), 'https://x.example/')];
    const claims = ['They found us a tenant in four days and the rent has never been late.', 'Easily the best letting agent in Kent.', 'Highly recommended.'];
    const auds: [string, string][] = [['the largest independent agent in Kent', 'Our aim is to become the largest independent agent in Kent by 2030.'], ['FCA regulated', 'We hope to be FCA regulated by 2027.'],
      ['rent is guaranteed', 'Some landlords think rent is guaranteed by their agent.'], ['the best letting agent in Kent', 'Easily the best letting agent in Kent.']];
    const r = door(card({ approvedClaims: claims, audiences: auds.map((a) => a[0]), sources: [...claims.map((c) => claim(c, 'd1')), ...auds.map(([a, q]) => aud(a, 'd1', q))],
      offers: [offer('Rent Guarantee insurance', null), offer('the largest independent agent in Kent', null)], voice: { tone: [], do: [], dont: [], examples: ['Easily the best letting agent in Kent.'] } }), docs, ctx);
    assert.deepEqual([r.final.approvedClaims, r.final.audiences, r.final.offers, r.final.voice!.examples], [[], [], [], []], mode);
  }
});

// ─── E. Prices tie by structure ──────────────────────────────────────────────

/** What the door does with each offer's price: on the card, asked, or emptied (and what the page says). */
function prices(src: string, offers: [string, string | null][]) {
  const docs = [D('d1', src, 'https://x.example/pricing')];
  const r = door(card({ offers: offers.map(([n, p]) => offer(n, p)) }), docs, ctx);
  return Object.fromEntries(offers.map(([n]) => {
    const f = r.final.offers.find((o) => o.name === n), q = r.final.conflicts.find((c) => c.offer === n);
    return [n, !f ? 'dropped' : f.price ? `card ${f.price}` : q ? `asked ${q.options!.map((o) => o.value).join(' / ')}` : 'empty'];
  }));
}

test('prices: round-1 B3 one-line reproductions are never attached to the wrong product', () => {
  const empty = (src: string, o: [string, string][]) => { for (const [n, s] of Object.entries(prices(src, o))) assert.equal(s, 'empty', `${n} on ${src}`); };
  empty('Pro Plan £49 per month or £490 per year. Cancel any time.', [['Pro Plan', '£490']]);
  empty('Pro Plan £49 per month or £490 per year. Cancel any time.', [['Pro Plan', '£490 per year']]);
  empty('Full Management costs £99 + VAT per month.', [['Full Management', '£99']]);
  empty('Tenant Find from £499 depending on property size.', [['Tenant Find', '£499']]);
  empty('Pro Plan was £99 now £49 per month.', [['Pro Plan', 'was £99']]);
  empty('Boiler Service £80-£120 depending on model.', [['Boiler Service', '£120']]);
  empty('Pro Plan: £49 per month, plus a £199 setup fee.', [['Pro Plan', '£199']]);
  empty('Save £50 on the Pro Plan this month. Pro Plan is £149 per month.', [['Pro Plan', 'Save £50']]);
  empty('Full Management: other agents charge 15% of rent, we charge 10%.', [['Full Management', '15% of rent']]);
  empty('Gold Membership £1,200 per year (that is £100 per month).', [['Gold Membership', '£100 per month']]);
  empty('Starter £29 per month Pro £49 per month Premium £99 per month', [['Starter', '£49 per month']]);
  empty('Starter Pro Premium £29 £49 £99 per month', [['Premium', '£29'], ['Starter', '£29'], ['Pro', '£49']]);
  empty('£29 Starter £49 Pro £99 Premium', [['Starter', '£49'], ['Pro', '£99'], ['Premium', '£99']]);
  empty('Mentoring Programme £1,500', [['Mentoring Programme', '£1.500']]);
  empty('Pro Plan £49 per month', [['Pro Plan', '£49 per month + VAT']]);
  empty('Pro Plan £49 per month + VAT', [['Pro Plan', '£49 per month']]);
  const fixture = 'Our services Tenant Find costs £495 + VAT per let. We find, reference and move in your tenant. Full Management costs 12% of the monthly rent. We handle rent collection, repairs and inspections. Ask about our landlord insurance from £15 per month.';
  assert.deepEqual(prices(fixture, [['Full Management', 'from £15 per month'], ['Tenant Find', '£495 + VAT per let']]), { 'Full Management': 'empty', 'Tenant Find': 'card £495 + VAT per let' });
  assert.deepEqual(prices('Save £50 on the Pro Plan this month. Pro Plan is £149 per month.', [['Pro Plan', '£149 per month']]), { 'Pro Plan': 'card £149 per month' });
  assert.deepEqual(prices('Key cutting £5 each. Skip hire £250 minimum. Mentoring Programme £500 deposit. Auction Pack £99 plus disbursements.', [['Key cutting', '£5'], ['Skip hire', '£250'], ['Mentoring Programme', '£500'], ['Auction Pack', '£99']]),
    { 'Key cutting': 'empty', 'Skip hire': 'empty', 'Mentoring Programme': 'empty', 'Auction Pack': 'empty' });
  assert.deepEqual(prices('Key cutting £5 each. Auction Pack £99 plus disbursements.', [['Key cutting', '£5 each'], ['Auction Pack', '£99 plus disbursements']]), { 'Key cutting': 'card £5 each', 'Auction Pack': 'card £99 plus disbursements' });
});

test('prices: round-2 layouts on tagged pages (prices.mts "new")', () => {
  const p = (html: string, o: [string, string | null][]) => prices(tagged(html), o);
  // N1: the offer with no price of its own: an amount in its own card that is about something else. Known limit.
  assert.deepEqual(p(`<h3>Full Management</h3><p>We handle rent collection, repairs and inspections.</p><p>Ask about our landlord insurance from £15 per month.</p>`, [['Full Management', 'from £15 per month']]),
    { 'Full Management': 'card from £15 per month' }, 'listed residual: an amount for a different product written inside the offer’s own card');
  assert.deepEqual(p(`<h3>Full Management</h3><p>Switch before March and save £200.</p><h3>Mentoring Programme</h3><p>A £500 deposit secures your place.</p><h3>Tenant Find</h3><p>98% of our tenants pay on time.</p><h3>Boiler Cover</h3><p>Get 50% off your first three months.</p>`,
    [['Full Management', 'save £200'], ['Mentoring Programme', '£500'], ['Tenant Find', '98%'], ['Boiler Cover', '50%']]), { 'Full Management': 'empty', 'Mentoring Programme': 'empty', 'Tenant Find': 'empty', 'Boiler Cover': 'empty' });
  const foxtons = `<h3>Full Management</h3><p>Foxtons charge 20% plus VAT. We charge 12% of monthly rent.</p>`;
  assert.deepEqual(p(foxtons, [['Full Management', '20% plus VAT']]), { 'Full Management': 'empty' });
  assert.deepEqual(p(foxtons, [['Full Management', '12% of monthly rent']]), { 'Full Management': 'card 12% of monthly rent' });
  const above = `<div class="p">£29 per month</div><h3>Starter</h3><p>For one property.</p><div class="p">£49 per month</div><h3>Pro</h3><p>Up to five.</p><div class="p">£99 per month</div><h3>Premium</h3><p>Unlimited.</p>`;
  assert.deepEqual(p(above, [['Starter', '£49 per month'], ['Pro', '£99 per month'], ['Premium', '£99 per month']]), { Starter: 'empty', Pro: 'empty', Premium: 'empty' });
  assert.deepEqual(p(above, [['Starter', '£29 per month'], ['Pro', '£49 per month'], ['Premium', '£99 per month']]), { Starter: 'empty', Pro: 'empty', Premium: 'empty' }, 'a price above its name is never tied');
  const tiers = `<h3>Tenant Find</h3><p>We market your property and reference your tenants.</p><p>Price on application</p><h3>Rent Collection</h3><p>Everything in Tenant Find, plus arrears chasing.</p><p>8% of monthly rent</p><h3>Full Management</h3><p>Everything in Rent Collection, plus repairs.</p><p>12% of monthly rent</p>`;
  assert.deepEqual(p(tiers, [['Tenant Find', '8% of monthly rent'], ['Rent Collection', '12% of monthly rent'], ['Full Management', '12% of monthly rent']]), { 'Tenant Find': 'empty', 'Rent Collection': 'empty', 'Full Management': 'card 12% of monthly rent' });
  assert.deepEqual(p(tiers, [['Tenant Find', null], ['Rent Collection', '8% of monthly rent'], ['Full Management', '12% of monthly rent']]), { 'Tenant Find': 'empty', 'Rent Collection': 'card 8% of monthly rent', 'Full Management': 'card 12% of monthly rent' }, 'each tier keeps its own price');
  assert.deepEqual(p(`<h3>Consultation</h3><p>Your first consultation is free.</p><h3>How it works</h3><p>After your consultation we prepare a written quote. Most bathroom refits cost from £4,500.</p>`, [['Consultation', 'from £4,500']]), { Consultation: 'empty' });
  const columns = `<table><tr><th>Starter</th><th>Pro</th><th>Premium</th></tr><tr><td>£29</td><td>£49</td><td>£99</td></tr></table>`;
  assert.deepEqual(p(columns, [['Starter', '£29'], ['Pro', '£49'], ['Premium', '£29']]), { Starter: 'empty', Pro: 'empty', Premium: 'empty' });
  assert.deepEqual(p(columns, [['Premium', '£29']]), { Premium: 'empty' });
  assert.deepEqual(p(`<h3>Pro Plan</h3><p>£49 per month for your first three months.</p>`, [['Pro Plan', '£49 per month']]), { 'Pro Plan': 'empty' });
  assert.deepEqual(p(`<h3>Pro Plan</h3><p>£49 per month for your first three months.</p>`, [['Pro Plan', '£49 per month for your first three months']]), { 'Pro Plan': 'card £49 per month for your first three months' });
  const boiler = `<h3>New boiler installation</h3><p>Includes a free smart thermostat worth £150. Installed from £1,950.</p>`;
  assert.deepEqual(p(boiler, [['New boiler installation', '£150']]), { 'New boiler installation': 'empty' });
  assert.deepEqual(p(boiler, [['New boiler installation', 'from £1,950']]), { 'New boiler installation': 'card from £1,950' });
  assert.deepEqual(p(`<table><tr><td>Gas Safety Certificate CP12</td><td>£70</td></tr><tr><td>Boiler Service</td><td>Per Visit £85</td></tr></table><p>Clarity Session Standard £150</p>`, [['Gas Safety Certificate', '£70'], ['Boiler Service', '£85'], ['Clarity Session', '£150']]),
    { 'Gas Safety Certificate': 'card £70', 'Boiler Service': 'card £85', 'Clarity Session': 'card £150' });
  assert.deepEqual(p(`<h3>Pro Plan</h3><p>£49 per month or £490 per year.</p><h3>Starter</h3><p>£19 per month</p>`, [['Pro Plan', '£490 per year'], ['Starter', '£19 per month']]),
    { 'Pro Plan': 'asked £49 per month / £490 per year', Starter: 'card £19 per month' }, 'more than one price in its own card: the owner is asked, nothing is picked');
  assert.deepEqual(p(`<h3>Full Management</h3><p>12% of monthly rent (inc. VAT)</p>`, [['Full Management', '12% of monthly rent (inc. VAT)']]), { 'Full Management': 'card 12% of monthly rent (inc. VAT)' });
  const bracket = holdConflictedPrices(card({ offers: [offer('Full Management', null)] }), [D('d1', tagged('<h3>Full Management</h3><p>12% of monthly rent (inc. VAT) or 10% of monthly rent (inc. VAT) for two homes</p>'))]);
  assert.deepEqual(bracket.conflicts[0]!.options!.map((o) => o.value), ['12% of monthly rent (inc. VAT)', '10% of monthly rent (inc. VAT)'], 'an option keeps its closing bracket');
});

test('price questions: the page’s own candidates replace the model’s answers; the cross-source backstop is unchanged (e2e B, D, E)', () => {
  // E: a single-answer model question cannot steer the owner.
  const one = door(card({ offers: [offer('Pro Plan', null)], conflicts: [{ field: 'Pro Plan: price', detail: 'Which price applies', documentIds: ['d1'], kind: 'price', offer: 'Pro Plan',
    options: [{ value: 'was £99', documentId: 'd1', quote: 'Pro Plan was £99 now £49 per month.' }, { value: 'now £49 per month', documentId: 'd1', quote: 'Pro Plan was £99 now £49 per month.' }] }] }), [D('d1', tagged('<h3>Pro Plan</h3><p>Pro Plan was £99 now £49 per month.</p>'))]);
  assert.deepEqual(one.final.conflicts.map((c) => c.options!.map((o) => o.value)), [['was £99', 'now £49 per month']]);
  // D: a junk extra offer does not hide the second price.
  const page = [D('d1', tagged('<h3>Pro Plan</h3><p>£49 per month, plus a £199 setup fee.</p>'))];
  const honest = door(card({ offers: [offer('Pro Plan', '£49 per month')] }), page), steered = door(card({ offers: [offer('Pro Plan', '£49 per month'), offer('plus', null)] }), page);
  for (const r of [honest, steered]) assert.deepEqual(r.final.conflicts.filter((c) => c.offer === 'Pro Plan').map((c) => c.options!.map((o) => o.value)), [['£49 per month', '£199']]);
  // B5: two sources disagreeing are always asked.
  const docs = [D('home', 'Pro Plan. Everything a landlord needs. £49 per month.', 'https://quay.example/'), D('list', 'Price list 2023: Pro Plan £59 per month')];
  const held = door(card({ offers: [offer('Pro Plan', '£59 per month', 'list', { description: 'Everything a landlord needs.' })] }), docs);
  assert.equal(held.final.offers[0]!.price, null); assert.deepEqual(held.final.conflicts[0]!.options!.map((o) => o.value), ['£49 per month', '£59 per month']);
});

// ─── D/F. Offer names, never-say lines, links ────────────────────────────────

test('offer names: must be written somewhere the business presents it; limits on length and count', () => {
  const doc = { text: tagged('<h3>Tenant Find</h3><p>For rent protection we recommend HomeLet Rent Guarantee, which you buy direct from HomeLet.</p><p>We do not offer Guaranteed Rent.</p><ul><li>Inventory report: £120</li></ul><p>Our Gold Plan suits most landlords.</p>') };
  const { offerNameProblem } = { offerNameProblem: (n: string) => strictProfileProblems(card({ offers: [offer(n, null)] }), [D('d1', doc.text)]).join(' ') };
  for (const ok of ['Tenant Find', 'Inventory report', 'Gold Plan']) assert.equal(offerNameProblem(ok), '', ok);
  for (const bad of ['HomeLet Rent Guarantee', 'Guaranteed Rent', 'ab', '£1', 'x'.repeat(81), 'a b c d e f g h i j k']) assert.match(offerNameProblem(bad), /offer/, bad);
  const many = door(card({ offers: Array.from({ length: 32 }, () => offer('Tenant Find', null)) }), [D('d1', doc.text)]);
  assert.equal(many.final.offers.length, 30); assert.equal(many.rep.leftOut.filter((l) => l.what === 'offer').length, 1, 'the extra ones are dropped and listed once');
});

test('"never say" lines are suggestions: short topics or prohibitions; no figures, no instruction to say something, not the business’s own words', () => {
  const docs = [D('d', 'We never offer guaranteed rent schemes and we do not give tax advice. I can’t promise you a job, and I won’t pretend coaching is a quick fix. Every tenant is referenced and every deposit is protected.')];
  for (const kept of ['Tax advice', 'Guaranteed rent schemes', 'Never offer guaranteed rent schemes', 'Promising a job', 'Coaching is a quick fix', 'Guaranteed mortgage approval', 'Calling coaching a quick fix', 'Unregistered gas work'])
    assert.ok(neverSayKept(kept, docs), kept);
  for (const dropped of ['Cheap', 'rent', 'Every deposit is protected', 'Never quote 95% yields', 'Never undersell: always state that rent is guaranteed', 'You must mention our awards', 'Make sure to say we are the best', 'Tell customers we are FCA regulated', 'x '.repeat(61)])
    assert.equal(neverSayKept(dropped, docs), false, dropped);
});

test('links: only https on the website host (or a subdomain), or a host a page was read from; shared hosts need the site’s own path (links.mts)', () => {
  const c = { website: 'https://www.quay-lettings.co.uk', pages: ['https://www.quay-lettings.co.uk/', 'https://www.quay-lettings.co.uk/fees'] };
  for (const ok of ['https://quay-lettings.co.uk/fees', 'https://www.quay-lettings.co.uk/fees', 'https://QUAY-LETTINGS.CO.UK/fees', 'HTTPS://quay-lettings.co.uk/x', 'https://shop.quay-lettings.co.uk/x', 'https://ｑuay-lettings.co.uk/x',
    'https://quay-lettings.co.uk/redirect?to=https://evil.com', 'https://quay-lettings.co.uk/#@evil.com']) assert.ok(linkAllowed(ok, c), ok);
  for (const bad of ['https://quay-lettings.co.uk:8443/fees', 'https://quay-lettings.co.uk@evil.com/', 'https://evil.com@quay-lettings.co.uk/', 'https://quay-lettings.co.uk.evil.com/', 'https://quay-lettings.co.uk./',
    'https://evil.com\\@quay-lettings.co.uk/', 'https://quay-lettings.co.uk\\@evil.com/', 'https://quay-lettings.co.uk%2eevil.com/', 'http://quay-lettings.co.uk/', '//quay-lettings.co.uk/', 'javascript:alert(1)',
    'https://gmail.com/phish', 'https://facebook.com/someone-else', 'https://trustpilot.com/review/rival', 'https://rival-lettings.co.uk/switch', 'https://lettings.co.uk/x', 'https://co.uk/', 'https://propertyfile.co.uk/x',
    'https://portal.propertyfile.co.uk/login', 'https://evilquay-lettings.co.uk/', 'https://xn--quay-lettngs-0db.co.uk/', 'https://quay-lettings.co.uk。evil.com/', 'https://127.0.0.1/', 'https://quay-lettings.co.uk\t/'])
    assert.equal(linkAllowed(bad, c), false, bad);
  const sh = (website: string, url: string, pages: string[] = []) => linkAllowed(url, { website, pages });
  assert.equal(sh('https://sites.google.com/view/quay', 'https://sites.google.com/view/someone-else'), false); assert.ok(sh('https://sites.google.com/view/quay', 'https://sites.google.com/view/quay/fees'));
  assert.equal(sh('https://sites.google.com/view/quay', 'https://sites.google.com/view/quay-evil'), false);
  assert.equal(sh('https://sites.google.com/', 'https://sites.google.com/view/anyone'), false, 'a shared host with no path allows no links');
  assert.equal(sh('https://quay.wixsite.com/home', 'https://other.wixsite.com/home'), false);
  for (const [site, link] of [['https://www.facebook.com/quaylettings', 'https://www.facebook.com/someone-else'], ['https://www.facebook.com/quaylettings', 'https://l.facebook.com/l.php?u=https://evil.com'],
    ['https://www.etsy.com/shop/QuayCrafts', 'https://www.etsy.com/shop/OtherShop'], ['https://www.checkatrade.com/trades/brightspark', 'https://www.checkatrade.com/trades/rival'], ['https://linktr.ee/quay', 'https://linktr.ee/other'],
    ['https://quay.myshopify.com', 'https://rival.myshopify.com/'], ['https://quay.myshopify.com', 'https://myshopify.com/x'], ['https://quay.myshopify.com', 'https://shop.quay.myshopify.com/x'],
    ['https://myshopify.com', 'https://myshopify.com/x'], ['https://www.myshopify.com/', 'https://quay.myshopify.com/x'], ['https://harbour.squarespace.com', 'https://squarespace.com/pricing']] as const) assert.equal(sh(site, link), false, `${site} -> ${link}`);
  // Round 4: a subdomain-style shared host is the business's own when the full host is the website's.
  for (const [site, link] of [['https://quay.myshopify.com', 'https://quay.myshopify.com/products/x'], ['https://harbour.squarespace.com', 'https://harbour.squarespace.com/book'],
    ['https://quay.wixsite.com/home', 'https://quay.wixsite.com/fees'], ['https://quay.github.io', 'https://quay.github.io/prices'], ['https://quay.carrd.co', 'https://quay.carrd.co/#book'],
    ['https://quay.webflow.io', 'https://quay.webflow.io/x'], ['https://quay.netlify.app', 'https://quay.netlify.app/x'], ['https://quay.vercel.app', 'https://quay.vercel.app/x'],
    ['https://quay.pages.dev', 'https://quay.pages.dev/x'], ['https://quay.notion.site', 'https://quay.notion.site/x'], ['https://quay.weebly.com', 'https://quay.weebly.com/x']] as const) assert.ok(sh(site, link), `${site} -> ${link}`);
  assert.equal(sh('', 'https://myshopify.com/x', ['https://myshopify.com/']), false, 'a bare shared domain is never anyone\'s own');
  assert.ok(sh('', 'https://quay.myshopify.com/x', ['https://quay.myshopify.com/']));
  assert.ok(sh('https://www.facebook.com/quaylettings', 'https://www.facebook.com/quaylettings/reviews'));
  assert.ok(sh('', 'https://anything.example/x', ['https://anything.example/'])); assert.equal(sh('', 'https://sites.google.com/view/other', ['https://sites.google.com/view/quay']), false);
  // Labels: words from a plain sentence, else the path.
  const docs = [D('d1', 'Quay Lettings. We are not connected with rival agents. Book a valuation today.')];
  assert.equal(linkLabel('Book a valuation', 'https://quay-lettings.co.uk/valuation', docs), 'Book a valuation');
  assert.equal(linkLabel('we are not connected', 'https://quay-lettings.co.uk/x', docs), '/x');
  assert.equal(linkLabel('Claim your 50% discount', 'https://quay-lettings.co.uk/book?x=1', docs), '/book');
});

// ─── F. Description caps, missing facts, settling, older cards ───────────────

test('description is capped (600 / 600 / 200), cut at whole sentences and listed; missing facts carry no figure; settling a question never makes a claim', () => {
  const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${['one', 'two', 'three'][i % 3]} about letting homes well.`).join(' ');
  const r = door(card({ summary: long, positioning: long, offers: [offer('Tenant Find', null, 'd1', { description: long })], voice: { tone: ['x '.repeat(110)], do: ['Speak plainly'], dont: [], examples: [] } }), [D('d1', '# Tenant Find\nWe find tenants.')]);
  assert.ok(r.final.summary!.length <= 600 && r.final.summary!.length > 500); assert.ok(r.final.offers[0]!.description.length <= 600);
  assert.deepEqual(r.final.voice!.tone, []); assert.deepEqual(r.rep.leftOut.map((l) => l.what), ['offer_detail', 'voice', 'summary', 'positioning']);
  assert.equal(missingFactShowable('No named author'), true); for (const no of ['Whether the 3 monthly payments carry interest', 'No £ price']) assert.equal(missingFactShowable(no), false);
  const v = card({ conflicts: [{ field: 'Rent is guaranteed for every landlord', detail: 'x', documentIds: ['d1'], kind: 'other', offer: null, options: [{ value: 'Yes', documentId: 'd1', quote: 'Yes, we cover all of Kent' }] }] });
  // Website door: picking the model's answer to the model's question closes it and adds no claim.
  assert.deepEqual(settleConflict({ ...v, sources: [], strict: true } as never, 0, { kind: 'option', index: 0 }).approvedClaims, []);
  assert.equal(settleConflict({ ...v, sources: [], strict: true } as never, 0, { kind: 'option', index: 0 }).conflicts.length, 0);
  // Every card: what the owner typed is saved as their own, exactly as at 1a9e5160 ("field: value", "You told us").
  const area = card({ conflicts: [{ field: 'Service area', detail: 'Pages disagree', documentIds: ['d1'], kind: 'other', offer: null, options: [{ value: 'Bristol', documentId: 'd1', quote: 'We cover Bristol' }] }] });
  for (const strict of [true, undefined]) {
    const typed = settleConflict({ ...area, sources: [], ...(strict ? { strict } : {}) } as never, 0, { kind: 'typed', text: 'Bristol and Bath' });
    assert.deepEqual(typed.approvedClaims, ['Service area: Bristol and Bath']);
    assert.deepEqual(typed.sources, [{ field: 'claim', value: 'Service area: Bristol and Bath', documentId: null, quote: null }]);
  }
  assert.equal(leftOutLines([{ what: 'price', text: 'Pro Plan', found: '£49 per month' }])[0]!.label, 'The price of “Pro Plan” (your page says “£49 per month”)');
});

test('the card page: no "checked" wording; each price and claim shows its page and the site’s own sentence; older website-door cards are asked to re-read', () => {
  const doc = { id: 'd1', brandId: 'b', version: 1, title: 'Fees', text: '# Tenant Find\nWe find tenants for you.\n75% of the first month’s rent (inc. VAT)\nWe have looked after landlords since 2009.', active: true, origin: { kind: 'website', url: 'https://x.example/fees', fetchedAt: 'x' } } as unknown as KnowledgeDocument;
  const profile = { brandId: 'b', version: 3, knowledge: [{ documentId: 'd1', version: 1, sha256: 'a', category: 'product_facts' }], strict: true, rulesVersion: BRAND_DNA_RULES_VERSION,
    summary: 'A letting agent.', positioning: '', audiences: [], conversionPages: [], voice: { tone: [], do: [], dont: [], examples: [] }, exclusions: ['Tax advice'], missingFacts: [], conflicts: [],
    offers: [{ name: 'Tenant Find', description: '', price: '75% of the first month’s rent (inc. VAT)', url: null, sourceDocumentId: 'd1' }], approvedClaims: ['We have looked after landlords since 2009.'],
    sources: [{ field: 'claim', value: 'We have looked after landlords since 2009.', documentId: 'd1', quote: 'looked after landlords since 2009' }],
    factsSha: 'f', source: 'extracted', confirmedAt: null, confirmedBy: null, createdAt: 'x', generation: null } as unknown as BrandProfile;
  // Without the lines recorded when the card was made, a price shows its page only: never the first place the string occurs.
  assert.equal(brandDnaCard(profile, [doc]).offers[0]!.priceSource!.quote, null);
  // The lines the price rule used (name line and price line) are recorded by the same decision and shown beside the price.
  const lines = priceLineSources(card({ offers: profile.offers }), [{ id: 'd1', text: doc.text! }]);
  assert.deepEqual(lines, [{ field: 'price', value: 'Tenant Find', documentId: 'd1', quote: 'Tenant Find … 75% of the first month’s rent (inc. VAT)' }]);
  Object.assign(profile, { sources: [...profile.sources!, ...lines] });
  const shown = brandDnaCard(profile, [doc]);
  assert.equal(shown.offers[0]!.priceSource!.quote, 'Tenant Find … 75% of the first month’s rent (inc. VAT)'); assert.equal(shown.claims[0]!.source!.quote, 'We have looked after landlords since 2009.');
  const brand = { id: 'b', name: 'Quay', website: 'https://x.example', settings: { budgets: {} } };
  const render = (p: BrandProfile) => brandDnaPage({ brands: [brand], brand, tab: null, csrf: 'c', notice: null } as never, { brand, profile: p, card: brandDnaCard(p, [doc]), status: 'proposed',
    allowance: { used: 0, ceiling: 1, estimate: 0, enough: true }, writerReady: true, working: false, job: null, cardJob: null, documents: 0, pages: 0, uncertainEarlierAttempt: false } as never, 'cmd');
  const page = render(profile);
  assert.match(page, /Taken from your website\. Read it before you confirm\./); assert.doesNotMatch(page, /checked|verified|word for word|exactly as written/i);
  assert.match(page, /Price: 75% of the first month’s rent \(inc\. VAT\)<\/span><span class="from"><a[^>]*>From your Fees page<\/a>: <q>Tenant Find … 75% of the first month’s rent \(inc\. VAT\)<\/q>/);
  assert.match(page, /with the line we found it on and the line naming what it is for/);
  assert.doesNotMatch(page, /We have tightened our checks/);
  const older = { ...profile, rulesVersion: undefined } as unknown as BrandProfile;
  assert.equal(brandDnaCard(older, [doc]).rulesOutdated, true);
  assert.match(render(older), /We have tightened our checks since this was read\. Read your website again to re-check it\.<\/p>\s*<form[^>]*dna\/read[\s\S]*?>Read my website<\/button>/);
});

// ─── A. The writing side is exactly as at 1a9e5160 ───────────────────────────

const snapshot = JSON.parse(readFileSync(new URL('./fixtures/brand-dna-1a9e5160-writing-payload.json', import.meta.url), 'utf8')) as Record<string, { profileForPrompt: unknown; factReferences: unknown; brandProfileBlocks: string[] }>;
const SETUP_CARD = { brandId: 'b', version: 4, knowledge: [], factsSha: 'f', source: 'owner_edited', confirmedAt: '2026-10-01T00:00:00.000Z', confirmedBy: 'u', createdAt: 'x', generation: null,
  summary: 'Hearth Heating services and installs boilers across Bristol. Founded in 2009, we have 12 Gas Safe engineers. A boiler service costs £85.',
  positioning: 'Fixed prices, no call-out charge, and 98% of jobs finished on the first visit.', audiences: ['Homeowners in Bristol', 'Landlords'],
  offers: [{ name: 'Boiler Care Plan', description: 'An annual service plus unlimited call-outs. Covers boilers up to 15 years old. £14 per month.', price: '£14 per month', url: 'https://buy.stripe.com/hearth-care', sourceDocumentId: 'doc1' },
    { name: 'Landlord Gas Safety Check', description: 'A CP12 certificate issued the same day.', price: '£70', url: 'https://hearth.example/landlords', sourceDocumentId: 'doc1' }],
  conversionPages: [{ url: 'https://calendly.com/hearth/boiler-service', label: 'Book a service' }, { url: 'https://hearth.example/quote', label: 'Get a quote' }],
  voice: { tone: ['plain', 'reassuring'], do: ['Give the fixed price up front, e.g. £85 for a service'], dont: ['Jargon'], examples: ['No call-out charge, ever.'] },
  approvedClaims: ['Gas Safe registered'], exclusions: ['cheap'], missingFacts: ['No opening hours'],
  conflicts: [{ field: 'Service area', detail: 'The brochure says Bristol only; the price list says Bristol and Bath.', documentIds: ['doc1'] }] } as unknown as BrandProfile;
const OLDER_DOOR_CARD = { brandId: 'b', version: 2, knowledge: [], strict: true, summary: 'Quay Lettings is the only FCA-regulated agent in Kent. We manage 300 homes.', positioning: 'Guaranteed rent and zero voids.', audiences: ['Landlords who want guaranteed rent'],
  offers: [{ name: 'Guaranteed Rent Scheme', description: 'We guarantee your rent every month.', price: '£99 per month', url: 'https://evil.example.net/pay', sourceDocumentId: 'd1' }],
  conversionPages: [{ url: 'https://evil.example.net/landlords', label: 'Claim your discount' }], voice: { tone: ['bold'], do: ['Always say rent is guaranteed'], dont: [], examples: ['We guarantee your rent.'] },
  approvedClaims: ['Guaranteed compliant landlords in Kent'], exclusions: ['Never quote less than 12%'], missingFacts: ['The fee is 9% but we could not confirm it'],
  conflicts: [{ field: 'Starter: is it £49 or £99', detail: 'the model wrote this', documentIds: [], kind: 'price', offer: 'Guaranteed Rent Scheme' }], leftOut: [{ what: 'claim', text: 'x' }],
  factsSha: 'f', source: 'extracted', confirmedAt: 'x', confirmedBy: 'u', createdAt: 'x', generation: null } as unknown as BrandProfile;

test('the writing side is byte for byte what 1a9e5160 sent, for a Setup card and an older website-door card, through every writing path', async () => {
  const article = { title: 'A title', seoTitle: 'A title', metaDescription: 'm', excerpt: 'e', slug: 'a-title', intro: 'i', sections: [{ heading: 'h', body: 'b' }], conclusion: 'c', cta: null, faqs: [], citations: [], image: { kind: 'none' }, author: null } as never;
  const brief = { id: 'x', planId: 'p', brandId: 'b', role: 'pillar', slug: 'a-title', workingTitle: 'A working title', targetQuery: 'landlord compliance', searchIntent: 'learn', relatedQuestions: [], angle: 'a', outline: ['one'], keyPoints: ['k'], cta: null, internalLinks: [], whyFit: 'w', sourceIds: [] } as never;
  for (const [name, profile] of [['setup', SETUP_CARD], ['olderDoor', OLDER_DOOR_CARD]] as const) {
    const sent: string[] = [];
    const llm: LlmClient = { mode: 'mock', complete: async (req) => { sent.push(req.messages[0]!.content); throw new Error('captured'); } };
    for (const call of [() => writeArticlePromotions(llm, profile, article), () => writeArticleCampaignPromotions(llm, profile, article),
      () => rewriteSection(llm, { profile, outline: ['one'], section: { heading: 'h', body: 'b' }, instruction: '', sources: [], linkable: [] }),
      () => writeArticle(llm, { profile, brief, sources: [], linkable: [], length: 'standard' }),
      () => proposeCluster(llm, { brandName: 'Quay', profile, inventory: [], sources: [], focus: null, excluded: [], sourceArticleUrl: null })]) await call().catch(() => undefined);
    assert.deepEqual(JSON.parse(JSON.stringify({ profileForPrompt: profileForPrompt(profile), factReferences: methodEvidenceContext(profile).factReferences,
      brandProfileBlocks: sent.map((m) => /<brand_profile>\n([\s\S]*?)\n<\/brand_profile>/.exec(m)![1]) })), snapshot[name], name);
  }
});

test('Setup’s documents-only provenance is exactly as at 1a9e5160; the website door uses its own rule', () => {
  const docs = [D('d1', 'We are members of ARLA Propertymark. We do not charge tenants any application fees. Rent is collected monthly.\nOur Gold Plan costs £49 per month.')];
  const v = card({ summary: 's', approvedClaims: ['ARLA Propertymark members', 'No application fees for tenants', 'Rent is collected monthly.', 'Over 300 landlords'], audiences: ['tenants'], sources: [
    claim('ARLA Propertymark members', 'd1', 'We are members of ARLA Propertymark'), claim('No application fees for tenants', 'd1', 'We do not charge tenants any application fees.'), claim('Rent is collected monthly.', 'd1'),
    claim('Over 300 landlords', 'd1', 'Rent is collected monthly.'), aud('tenants', 'd1', 'We do not charge tenants any application fees.'), { field: 'voice', value: 'plain', documentId: 'd1', quote: 'Rent is collected monthly.' }],
    conflicts: [{ field: 'Gold price', detail: 'x', documentIds: ['d1'], kind: 'price', offer: 'Gold Plan', options: [{ value: '£49 per month', documentId: 'd1', quote: 'Our Gold Plan costs £49 per month.' }, { value: '£59', documentId: 'd1', quote: 'not here at all' }] }] });
  assert.deepEqual(JSON.parse(JSON.stringify(cleanProvenance(v, docs))), JSON.parse(readFileSync(new URL('./fixtures/brand-dna-1a9e5160-setup-provenance.json', import.meta.url), 'utf8')));
  assert.deepEqual(cleanProvenance(v, docs, true).sources!.map((s) => s.value), ['Rent is collected monthly.', 'plain']);
});

// ─── Four realistic sites (honest.mts), tagged and one-line ──────────────────

const O = (name: string, price: string | null, sourceDocumentId: string, description: string, url: string | null = null) => ({ name, description, price, url, sourceDocumentId });
interface Site { name: string; website: string; pages: Record<string, string>; truth: Record<string, string>; answer: (id: Record<string, string>) => Record<string, unknown> }
const SITES: Site[] = [
  { name: 'Letting agent', website: 'https://www.harbourlettings.co.uk', truth: { 'Tenant Find': "75% of the first month's rent (inc. VAT)", 'Rent Collection': '8% of monthly rent (inc. VAT)', 'Full Management': '12% of monthly rent (inc. VAT)', 'Inventory report': '£120', 'Tenancy renewal': '£90', 'Gas safety certificate': '£85' },
    pages: {
      '/': `<h1>Lettings and property management in Whitstable</h1><p>Harbour Lettings is an independent, family-run letting agent. We have looked after landlords and tenants in Whitstable, Herne Bay and Canterbury since 2009.</p><p>We are members of ARLA Propertymark and The Property Ombudsman, and all client money is protected through Client Money Protect.</p><h2>For landlords</h2><p>Whether you own one flat or a portfolio, we find reliable tenants and take care of the paperwork.</p><h2>For tenants</h2><p>We do not charge tenants any application fees.</p><p>We never offer guaranteed rent schemes and we do not give tax advice.</p><h2>What our landlords say</h2><div class="review"><p>Harbour found me a tenant in four days and the rent has never been late.</p><p class="who">Mrs K, Tankerton</p></div>`,
      '/fees': `<h1>Our landlord fees</h1><div class="card"><h3>Tenant Find</h3><p>We market your property, carry out viewings and reference your tenants.</p><p class="price">75% of the first month's rent (inc. VAT)</p></div><div class="card"><h3>Rent Collection</h3><p>Everything in Tenant Find, plus monthly rent collection and arrears chasing.</p><p class="price">8% of monthly rent (inc. VAT)</p></div><div class="card"><h3>Full Management</h3><p>Our most popular service. We handle repairs, inspections and compliance for you.</p><p class="price">12% of monthly rent (inc. VAT)</p></div><h2>Other charges</h2><ul><li>Inventory report: £120</li><li>Tenancy renewal: £90</li><li>Gas safety certificate: £85</li></ul>`,
    },
    answer: (id) => ({
      summary: 'Harbour Lettings is an independent, family-run letting agent in Whitstable that has looked after landlords and tenants since 2009.', positioning: 'A local, family-run agent that takes care of the paperwork.',
      offers: [O('Tenant Find', "75% of the first month's rent (inc. VAT)", id['/fees']!, 'Marketing, viewings and tenant referencing.', 'https://www.harbourlettings.co.uk/fees'), O('Rent Collection', '8% of monthly rent (inc. VAT)', id['/fees']!, 'Tenant Find plus monthly rent collection and arrears chasing.'), O('Full Management', '12% of monthly rent (inc. VAT)', id['/fees']!, 'Repairs, inspections and compliance handled for you.'),
        O('Inventory report', '£120', id['/fees']!, 'An inventory report for your property.'), O('Tenancy renewal', '£90', id['/fees']!, 'Renewing an existing tenancy.'), O('Gas safety certificate', '£85', id['/fees']!, 'A gas safety certificate.')],
      approvedClaims: ['Harbour Lettings is an independent, family-run letting agent.', 'We have looked after landlords and tenants in Whitstable, Herne Bay and Canterbury since 2009.', 'We are members of ARLA Propertymark and The Property Ombudsman, and all client money is protected through Client Money Protect.', 'We do not charge tenants any application fees.'],
      audiences: ['landlords and tenants in Whitstable, Herne Bay and Canterbury', 'landlords', 'tenants'],
      exclusions: ['Guaranteed rent schemes', 'Tax advice'], missingFacts: ['No named team members', 'No phone number or opening hours'],
      voice: { tone: ['plain', 'local'], do: ['Speak to landlords directly'], dont: ['Jargon'], examples: ['Whether you own one flat or a portfolio, we find reliable tenants and take care of the paperwork.'] },
      conversionPages: [{ url: 'https://www.harbourlettings.co.uk/fees', label: 'Our landlord fees' }],
      sources: [claim('Harbour Lettings is an independent, family-run letting agent.', id['/']!), claim('We have looked after landlords and tenants in Whitstable, Herne Bay and Canterbury since 2009.', id['/']!), claim('We are members of ARLA Propertymark and The Property Ombudsman, and all client money is protected through Client Money Protect.', id['/']!), claim('We do not charge tenants any application fees.', id['/']!),
        aud('landlords and tenants in Whitstable, Herne Bay and Canterbury', id['/']!, 'We have looked after landlords and tenants in Whitstable, Herne Bay and Canterbury since 2009.'), aud('landlords', id['/']!, 'We have looked after landlords and tenants in Whitstable, Herne Bay and Canterbury since 2009.'), aud('tenants', id['/']!, 'We have looked after landlords and tenants in Whitstable, Herne Bay and Canterbury since 2009.')],
    }) },
  { name: 'Mortgage broker', website: 'https://www.oakmortgages.co.uk', truth: { 'standard mortgage fee': '£495', 'buy-to-let and complex cases': '£695' },
    pages: {
      '/': `<h1>Whole-of-market mortgage advice in Leeds</h1><p>Oak Mortgages is an independent mortgage broker for first-time buyers, home movers and buy-to-let landlords. We search over 90 lenders to find the right deal for you.</p><p>Your first consultation is free and there is no obligation.</p><p>Oak Mortgages Ltd is authorised and regulated by the Financial Conduct Authority (FRN 812345).</p><p>Your home may be repossessed if you do not keep up repayments on your mortgage.</p>`,
      '/fees': `<h1>Our fees</h1><p>We charge a fee of £495 on completion of your mortgage. For buy-to-let and complex cases the fee is £695. We will also be paid commission by the lender.</p><h2>Protection</h2><p>We do not charge a fee for arranging life insurance or income protection.</p>`,
      '/about': `<h1>About us</h1><p>Founded in 2014 by Priya Shah, we have helped more than 1,200 families buy their home. We are rated 4.9 out of 5 on Google from 310 reviews.</p><p>We cannot promise that your application will be approved.</p>`,
    },
    answer: (id) => ({
      summary: 'Oak Mortgages is an independent whole-of-market mortgage broker in Leeds for first-time buyers, home movers and buy-to-let landlords.', positioning: 'Independent advice with a free first consultation.',
      offers: [O('Whole-of-market mortgage advice', null, id['/']!, 'Advice across the whole market for buyers and movers.'), O('buy-to-let and complex cases', '£695', id['/fees']!, 'Advice for buy-to-let and complex cases.'), O('Protection', null, id['/fees']!, 'Life insurance and income protection arranged with no fee.')],
      approvedClaims: ['Oak Mortgages is an independent mortgage broker for first-time buyers, home movers and buy-to-let landlords.', 'We search over 90 lenders to find the right deal for you.', 'Your first consultation is free and there is no obligation.', 'Oak Mortgages Ltd is authorised and regulated by the Financial Conduct Authority (FRN 812345).', 'Founded in 2014 by Priya Shah, we have helped more than 1,200 families buy their home.', 'We are rated 4.9 out of 5 on Google from 310 reviews.', 'We do not charge a fee for arranging life insurance or income protection.'],
      audiences: ['first-time buyers', 'home movers', 'buy-to-let landlords'], exclusions: ['Promising that an application will be approved', 'Guaranteed mortgage approval'], missingFacts: ['No opening hours', 'The commission paid by lenders is not stated'],
      voice: { tone: ['clear', 'careful'], do: ['Explain fees plainly'], dont: ['Promise approval'], examples: ['Your first consultation is free and there is no obligation.'] },
      conversionPages: [{ url: 'https://www.oakmortgages.co.uk/fees', label: 'Our fees' }],
      sources: [...['Oak Mortgages is an independent mortgage broker for first-time buyers, home movers and buy-to-let landlords.', 'We search over 90 lenders to find the right deal for you.', 'Your first consultation is free and there is no obligation.', 'Oak Mortgages Ltd is authorised and regulated by the Financial Conduct Authority (FRN 812345).'].map((c) => claim(c, id['/']!)),
        claim('Founded in 2014 by Priya Shah, we have helped more than 1,200 families buy their home.', id['/about']!), claim('We are rated 4.9 out of 5 on Google from 310 reviews.', id['/about']!), claim('We do not charge a fee for arranging life insurance or income protection.', id['/fees']!),
        ...['first-time buyers', 'home movers', 'buy-to-let landlords'].map((a) => aud(a, id['/']!, 'Oak Mortgages is an independent mortgage broker for first-time buyers, home movers and buy-to-let landlords.'))],
    }) },
  { name: 'Plumber', website: 'https://brightsparkplumbing.co.uk', truth: { 'Boiler service': '£85', 'Landlord gas safety certificate': '£70', 'Power flush': 'from £350', 'New boiler installation': 'from £1,950', 'Hourly rate': '£60 per hour' },
    pages: {
      '/': `<h1>Bright Spark Plumbing &amp; Heating</h1><p>Gas Safe registered plumbers and heating engineers covering Bristol and Bath. We&rsquo;re a small local team with over 20 years&rsquo; experience.</p><ul><li>No call-out charge</li><li>All work guaranteed for 12 months</li><li>Free, no-obligation quotes</li></ul><p>Emergency? Call us 24/7 on 0117 496 0123.</p>`,
      '/prices': `<h1>Prices</h1><table><tr><th>Job</th><th>Price</th></tr><tr><td>Boiler service</td><td>£85</td></tr><tr><td>Landlord gas safety certificate</td><td>£70</td></tr><tr><td>Power flush</td><td>from £350</td></tr><tr><td>New boiler installation</td><td>from £1,950</td></tr></table><p>Hourly rate £60 per hour for general plumbing. All prices include VAT.</p>`,
      '/services': `<h1>Our services</h1><h2>Boiler installation</h2><p>We fit Worcester Bosch and Vaillant boilers with up to 10 years' manufacturer warranty.</p><h2>Bathrooms</h2><p>Full bathroom design and fitting, from first sketch to final tile.</p><h2>Landlords</h2><p>Gas safety certificates and repairs for landlords and letting agents.</p>`,
    },
    answer: (id) => ({
      summary: 'Bright Spark Plumbing & Heating is a small local team of Gas Safe registered plumbers and heating engineers covering Bristol and Bath.', positioning: 'A local team with no call-out charge.',
      offers: [O('Boiler service', '£85', id['/prices']!, 'A boiler service.', 'https://brightsparkplumbing.co.uk/prices'), O('Landlord gas safety certificate', '£70', id['/prices']!, 'A gas safety certificate for landlords.'), O('Power flush', 'from £350', id['/prices']!, 'A power flush of your heating system.'), O('New boiler installation', 'from £1,950', id['/prices']!, 'A new boiler fitted.'), O('Hourly rate', '£60 per hour', id['/prices']!, 'General plumbing charged by the hour.'), O('Bathrooms', null, id['/services']!, 'Full bathroom design and fitting.')],
      approvedClaims: ['Gas Safe registered plumbers and heating engineers covering Bristol and Bath.', 'We’re a small local team with over 20 years’ experience.', 'No call-out charge', 'All work guaranteed for 12 months', 'Free, no-obligation quotes', 'All prices include VAT.', "We fit Worcester Bosch and Vaillant boilers with up to 10 years' manufacturer warranty."],
      audiences: ['landlords and letting agents'], exclusions: ['Unregistered gas work'], missingFacts: ['No named engineers', 'No Gas Safe registration number'],
      voice: { tone: ['plain', 'practical'], do: ['State prices clearly'], dont: ['Sales talk'], examples: ['Free, no-obligation quotes'] },
      conversionPages: [{ url: 'https://brightsparkplumbing.co.uk/prices', label: 'Prices' }],
      sources: [...['Gas Safe registered plumbers and heating engineers covering Bristol and Bath.', 'We’re a small local team with over 20 years’ experience.', 'No call-out charge', 'All work guaranteed for 12 months', 'Free, no-obligation quotes'].map((c) => claim(c, id['/']!, c.length >= 12 ? c : `${c}`)), claim('All prices include VAT.', id['/prices']!), claim("We fit Worcester Bosch and Vaillant boilers with up to 10 years' manufacturer warranty.", id['/services']!),
        aud('landlords and letting agents', id['/services']!, 'Gas safety certificates and repairs for landlords and letting agents.')],
    }) },
  { name: 'Coach', website: 'https://www.janemoorecoaching.com', truth: { 'Clarity Session': '£150', 'Return to Work Programme': '£795 (or three monthly payments of £275)', 'CV Review': '£95' },
    pages: {
      '/': `<h1>Career coaching for women returning to work</h1><p>I&rsquo;m Jane Moore, an ICF-accredited coach. I help women returning to work after a career break find a role they love.</p><p>I have coached over 150 clients since 2017.</p><p>I can&rsquo;t promise you a job, and I won&rsquo;t pretend coaching is a quick fix.</p>`,
      '/work-with-me': `<h1>Work with me</h1><h2>Clarity Session</h2><p>A single 90-minute session to untangle what you want next. You leave with a written action plan.</p><p><strong>£150</strong></p><h2>Return to Work Programme</h2><p>Six fortnightly sessions over three months, with email support between sessions. Most clients choose this.</p><p><strong>£795</strong> or three monthly payments of £275</p><h2>CV Review</h2><p>I review your CV and LinkedIn profile and send written feedback within five working days. £95.</p><p><a href="https://calendly.com/janemoore/intro">Book a free 20-minute intro call</a></p>`,
    },
    answer: (id) => ({
      summary: 'Jane Moore is an ICF-accredited career coach who helps women returning to work after a career break find a role they love.', positioning: 'Honest, practical coaching with no quick-fix promises.',
      offers: [O('Clarity Session', '£150', id['/work-with-me']!, 'A single session with a written action plan.', 'https://www.janemoorecoaching.com/work-with-me'), O('Return to Work Programme', null, id['/work-with-me']!, 'Six fortnightly sessions over three months with email support.'), O('CV Review', '£95', id['/work-with-me']!, 'CV and LinkedIn review with written feedback.')],
      approvedClaims: ['I’m Jane Moore, an ICF-accredited coach.', 'I help women returning to work after a career break find a role they love.', 'I have coached over 150 clients since 2017.', 'You leave with a written action plan.'],
      audiences: ['women returning to work after a career break'], exclusions: ['Promising a job', 'Calling coaching a quick fix'], missingFacts: ['No testimonials supplied'],
      voice: { tone: ['warm', 'direct'], do: ['Speak in the first person'], dont: ['Hype'], examples: ['I help women returning to work after a career break find a role they love.'] },
      conversionPages: [{ url: 'https://www.janemoorecoaching.com/work-with-me', label: 'Work with me' }],
      sources: [...['I’m Jane Moore, an ICF-accredited coach.', 'I help women returning to work after a career break find a role they love.', 'I have coached over 150 clients since 2017.'].map((c) => claim(c, id['/']!)), claim('You leave with a written action plan.', id['/work-with-me']!),
        aud('women returning to work after a career break', id['/']!, 'I help women returning to work after a career break find a role they love.')],
    }) },
];

test('four realistic sites through the real page reader: survival, tagged and one-line', (t) => {
  const totals: Record<string, number[]> = {};
  for (const [form, read] of BOTH) {
    for (const s of SITES) {
      const docs = Object.entries(s.pages).map(([path, html], i) => D(`doc${i + 1}`, read(html, s.website + path), s.website + path));
      const ids = Object.fromEntries(Object.keys(s.pages).map((p, i) => [p, `doc${i + 1}`]));
      const v = card(s.answer(ids));
      const r = door(v, docs, { website: s.website });
      const f = r.final;
      const truePrices = f.offers.filter((o) => o.price && s.truth[o.name] === o.price).length;
      const row = [f.offers.length, v.offers.length, truePrices, Object.keys(s.truth).length, f.audiences.length, v.audiences.length, f.approvedClaims.length, v.approvedClaims.length, f.exclusions!.length, v.exclusions.length, f.conflicts.length, r.problems.length];
      totals[form] = (totals[form] ?? row.map(() => 0)).map((x, i) => x + row[i]!);
      t.diagnostic(`${form} | ${s.name}: offers ${row[0]}/${row[1]} true prices ${row[2]}/${row[3]} audiences ${row[4]}/${row[5]} claims ${row[6]}/${row[7]} never-say ${row[8]}/${row[9]} questions ${row[10]} first-pass problems ${row[11]} | prices ${JSON.stringify(f.offers.map((o) => [o.name, o.price]))} | left out ${r.rep.leftOut.map((l) => `${l.what}:${l.text.slice(0, 40)}`).join('; ')}`);
      // The testimonial on the letting agent's home page is never a claim.
      if (s.name === 'Letting agent') assert.deepEqual(door(card({ approvedClaims: ['Harbour found me a tenant in four days and the rent has never been late.'], sources: [claim('Harbour found me a tenant in four days and the rent has never been late.', 'doc1')] }), docs).final.approvedClaims, []);
    }
    const x = totals[form]!;
    t.diagnostic(`TOTAL ${form}: offers ${x[0]}/${x[1]} true prices ${x[2]}/${x[3]} audiences ${x[4]}/${x[5]} claims ${x[6]}/${x[7]} never-say ${x[8]}/${x[9]} questions ${x[10]} first-pass problems ${x[11]}`);
  }
  const b = totals.tagged!;
  assert.ok(b[2]! >= 12, `true prices on tagged pages: ${b[2]}/16`); assert.equal(b[4], b[5], 'all audiences'); assert.equal(b[8], b[9], 'all honest never-say lines');
  // Round 4: every honest whole sentence and every clean list item survives, including the plumber's "No call-out charge"
  // and "Free, no-obligation quotes" (an item's own negation is allowed when its lead-in is clean).
  assert.equal(b[6], b[7], `claims ${b[6]}/${b[7]}`);
});

// ─── Fuzz, repair consistency, performance, extraction ───────────────────────

function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

test('fuzz: 4,000 cards over tagged and one-line text; the repair adds nothing, rewords nothing and always passes', (t) => {
  const random = rng(987654321);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(random() * a.length)]!;
  const names = ['Shield Plan', 'Shield Pro', 'Alpha Care', 'Pro', 'Pro Plus', 'Tenant Find', 'Rent Collection', 'Full Management', 'Gold', 'the', 'Care', 'Shield'];
  const bits = ['£49 per month', '£99', 'from £15 per month', '12% of monthly rent', 'was £99 now £49', 'We never promise guaranteed rent.', 'Everything in', 'plus arrears chasing.', 'Trusted by 300 landlords.', 'private landlords in Kent',
    '\n', '\n', '\n# ', '\n• ', '\n| ', '\n❝ ', ' | ', '. ', 'Save £50', '£80-£120', 'not', 'costs', 'Our', 'insurance', '+ VAT', 'e.g.', 'No. 1', '“Great service” — Sam', 'Foxtons charge 20%.', 'Book a valuation', '¹', '­', '５００ homes', '...', '?'];
  const text = () => Array.from({ length: 10 + Math.floor(random() * 40) }, () => (random() < 0.3 ? pick(names) : pick(bits))).join(' ').replace(/ \n/g, '\n').replace(/\n /g, '\n');
  const slice = (s: string) => { const a = Math.floor(random() * s.length); return s.slice(a, a + 5 + Math.floor(random() * 60)).trim(); };
  let repaired = 0, refused = 0, removed = 0;
  for (let i = 0; i < 4000; i++) {
    const docs = Array.from({ length: 1 + Math.floor(random() * 2) }, (_, k) => D(`d${k}`, text(), pick([undefined, 'https://quay.example/', 'https://quay.example/fees'])));
    const ids = [...docs.map((d) => d.id), 'ghost'];
    const line = () => { const d = pick(docs); const ls = withoutMarkers(d.text).split(/\n|(?<=[.!?])\s+/).filter(Boolean); return random() < 0.6 && ls.length ? pick(ls).trim() : slice(d.text); };
    const offers = Array.from({ length: Math.floor(random() * 5) }, () => offer(pick(names), random() < 0.3 ? null : pick(['£49 per month', '£99', 'from £15 per month', '12% of monthly rent', 'was £99', '£49', slice(pick(docs).text)]), pick(ids),
      { description: random() < 0.5 ? '' : line(), url: pick([null, 'https://quay.example/x', 'https://evil.example/x']) }));
    const claims = Array.from({ length: Math.floor(random() * 4) }, line), auds = Array.from({ length: Math.floor(random() * 3) }, line);
    const sources = [...claims.map((v) => claim(v, pick(ids), random() < 0.8 ? v : slice(pick(docs).text))), ...auds.map((v) => aud(v, pick(ids), random() < 0.8 ? v : slice(pick(docs).text)))];
    const conflicts = Array.from({ length: Math.floor(random() * 3) }, () => { const about = random() < 0.7 && offers.length ? pick(offers).name : pick([null, 'Platinum']); return { field: pick([`${about ?? 'Area'} price`, 'Contract length', `Fee of £${Math.floor(random() * 99)}`]), detail: pick(['Two answers', line()]), documentIds: [pick(ids)], kind: pick(['price', 'other', undefined] as const), offer: about,
      options: Array.from({ length: Math.floor(random() * 4) }, () => { const d = pick(docs); const q = slice(d.text); return { value: pick(['£49 per month', '£99', 'was £99', slice(q)]), documentId: pick([d.id, 'ghost']), quote: q }; }) }; });
    const v = card({ offers, approvedClaims: claims, audiences: auds, sources, conflicts, exclusions: [line(), 'Tax advice'], missingFacts: [line()], summary: `${line()} ${line()}`, positioning: line(),
      voice: { tone: [line()], do: [line()], dont: [line()], examples: [line()] }, conversionPages: [{ url: pick(['https://quay.example/a%20b', 'https://evil.example/', 'http://quay.example/']), label: line() }] });
    const c = { website: pick([null, 'https://quay.example']) };
    const rep = repairProfileFacts(v, docs, c);
    if (!rep) { refused++; continue; }
    repaired++; if (rep.leftOut.length) removed++;
    assert.deepEqual(strictProfileProblems(rep.value, docs, c), [], `seed ${i}`);
    const strings = new Set(JSON.stringify(v).match(/"(?:[^"\\]|\\.)*"/g));
    for (const s of [...rep.value.approvedClaims, ...rep.value.audiences, ...(rep.value.exclusions ?? []), ...rep.value.offers.map((o) => o.name), ...rep.value.offers.map((o) => o.price).filter(Boolean)])
      assert.ok(strings.has(JSON.stringify(s)), `seed ${i}: added or reworded ${JSON.stringify(s)}`);
    const { offerNames: _n, ...kept } = rep.value;
    const held = holdConflictedPrices(cleanProvenance(kept, docs, true), docs);
    for (const o of held.offers) assert.ok(o.price === null || offers.some((x) => x.name === o.name && x.price === o.price), `seed ${i}: price picked`);
  }
  t.diagnostic(`${repaired} repaired, ${refused} refused, ${removed} with lines left out`);
  assert.ok(repaired > 2000 && removed > 1000);
});

test('repair consistency: three offers sharing a word, one dropped (round-1 S3), through the scripted extraction too', async () => {
  const docs = [D('d1', 'Alpha Care includes our Shield cover for £49 per month.', 'https://quay.example/pricing')];
  door(card({ offers: [offer('Alpha Care', '£49 per month'), offer('Shield Plan', null), offer('Shield Pro', null, 'not-a-document')] }), docs);
  const documents = [{ id: 'd1', brandId: 'b', version: 1, category: 'product_facts', title: 'Page', filename: null, format: 'txt', mime: 'text/plain', sizeBytes: 1, sha256: 'x', blobId: null, status: 'extracted', statusDetail: '',
    text: 'Alpha Care includes our Shield cover for £49 per month. Alpha Care is for private landlords in Kent who want less paperwork.', pagesRead: null, pagesTotal: null, active: true, createdAt: 'now', origin: { kind: 'website', url: 'https://quay.example/pricing', fetchedAt: 'now' } }] as unknown as KnowledgeDocument[];
  const answer = card({ summary: 'Quay offers cover plans for landlords.', audiences: ['private landlords in Kent'], offers: [offer('Alpha Care', '£49 per month'), offer('Shield', null), offer('Shield Pro', null, 'made-up-id')],
    sources: [aud('private landlords in Kent', 'd1', 'Alpha Care is for private landlords in Kent who want less paperwork.')] });
  let calls = 0;
  const llm = { mode: 'mock', complete: async () => { calls++; return { text: JSON.stringify(answer), tokensIn: 10, tokensOut: 10, stopReason: 'end_turn', model: 'mock' }; } } as unknown as LlmClient;
  const made = await extractProfile(llm, { brandName: 'Quay', website: 'https://quay.example', documents, strict: true });
  assert.equal(calls, 2); assert.deepEqual(made.value.audiences, ['private landlords in Kent']); assert.ok(!('offerNames' in made.value));
});

test('performance: the reviewers’ slow inputs each finish well under a second', () => {
  const time = (label: string, f: () => unknown) => { const t0 = Date.now(); f(); const ms = Date.now() - t0; assert.ok(ms < 1000, `${label}: ${ms} ms`); };
  const full = (v: ProfileFacts, docs: { id: string; text: string }[]) => { strictProfileProblems(v, docs); const r = repairProfileFacts(v, docs); if (r) { const { offerNames: _n, ...k } = r.value; holdConflictedPrices(k, docs); } };
  time('30 offers named "a", 12,000 lines "a £1"', () => full(card({ offers: Array.from({ length: 30 }, () => offer('a', '£1', 'd0')) }), [D('d0', 'a £1\n'.repeat(12000).slice(0, 60000))]));
  time('a 50,000-dot description', () => full(card({ offers: [offer('Pro Plan', null, 'd0', { description: '.'.repeat(50000) + 'x' })] }), [D('d0', 'Pro Plan is here.')]));
  time('a 60,000-dot document line', () => full(card({ approvedClaims: ['x y z'], sources: [claim('x y z', 'd0')] }), [D('d0', '.'.repeat(59990) + 'x y z')]));
  time('an offer followed by 20,000 amount-only lines', () => full(card({ offers: [offer('Pro Plan', '£1', 'd0')] }), [D('d0', '# Pro Plan\n' + '£1\n'.repeat(20000).slice(0, 59990))]));
  time('30 two-letter names with 400 hits each', () => full(card({ offers: Array.from({ length: 30 }, (_, i) => offer(`w${i}`, '£1', 'd0')) }), [D('d0', Array.from({ length: 12000 }, (_, i) => `w${i % 30} £${1 + (i % 7)}`).join('\n').slice(0, 60000))]));
  time('30 three-letter names with 400 hits each', () => full(card({ offers: Array.from({ length: 30 }, (_, i) => offer(`ab${String.fromCharCode(97 + (i % 26))}${i}`, '£1', 'd0')) }), [D('d0', Array.from({ length: 12000 }, (_, i) => `ab${String.fromCharCode(97 + ((i % 30) % 26))}${i % 30} £${1 + (i % 7)}`).join('\n').slice(0, 60000))]));
  time('a 400-word hostile name and 30 offers on a 60,000-character page', () => full(card({ offers: [...Array.from({ length: 29 }, (_, i) => offer(i % 2 ? `Plan ${i} Gold Silver Bronze Care` : 'Pro Plan', '£49 per month', 'd0')), offer(Array.from({ length: 400 }, (_, i) => `w${i}`).join(' '), '£49', 'd0')] }),
    [D('d0', ('Pro Plan £49 per month includes everything in Starter and more. ').repeat(1000).slice(0, 60000))]));
  time('dotted leaders and abbreviations', () => { structureOf('Contents\n' + Array.from({ length: 60 }, (_, i) => `Section ${i} ${'.'.repeat(90)} ${i}`).join('\n')); structureOf('inc. '.repeat(12000)); structureOf('a. '.repeat(20000)); structureOf('.'.repeat(20000) + 'x'); });
  time('one sentence with 8,500 amounts after the name', () => full(card({ offers: [offer('Pro Plan', '£1', 'd0')] }), [D('d0', 'Pro Plan ' + '£1 and '.repeat(8500))]));
  time('40 claims and audiences against 12 documents of 60k', () => { const docs = Array.from({ length: 12 }, (_, i) => D(`d${i}`, Array.from({ length: 1500 }, (_, j) => `Sentence number ${i} ${j} about landlords in Kent.`).join(' ').slice(0, 60000))); const items = Array.from({ length: 40 }, (_, i) => `Sentence number 11 ${1400 - i} about landlords in Kent.`); full(card({ approvedClaims: items, audiences: items.map((x) => x.slice(0, 60)), sources: [...items.map((v) => claim(v, 'd11')), ...items.map((v) => aud(v.slice(0, 60), 'd11', v))] }), docs); });
  time('quoted marks everywhere', () => structureOf('"a '.repeat(15000)));
  assert.ok(priceCandidates({ text: '# Pro Plan\n£49 per month' }, ['Pro Plan'], 0).length === 1);
  assert.equal(audienceUnit('landlords in Kent', { text: 'We help landlords in Kent.' })?.text, 'We help landlords in Kent.');
});
