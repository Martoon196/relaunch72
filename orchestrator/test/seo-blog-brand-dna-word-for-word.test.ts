/**
 * Brand DNA, word for word: the claim rule, the price-beside-its-offer rule, the model's own notes and links, and the
 * one allowlist of what reaches a writing prompt. Pure rules, a seeded fuzz and captured prompts from a scripted model.
 * No network, model or database is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exclusionSupported, holdConflictedPrices, leftOutLines, missingFactShowable, offerUrlAllowed, PRICE_AFTER_NAME, priceBesideOffer, priceConflicts, repairProfileFacts,
  stem, strictProfileProblems, unsupportedBy, writingProfile, type ProfileFacts,
} from '../src/seo-blog/brand-dna.js';
import { profileForPrompt, proposeCluster, rewriteSection, writeArticle, writeArticleCampaignPromotions, writeArticlePromotions } from '../src/seo-blog/generation.js';
import { methodEvidenceContext } from '../src/seo-blog/method-evidence.js';
import type { LlmClient } from '../src/llm/client.js';
import type { ArticleBody, ArticleBrief, BrandProfile, ProfileOffer } from '../src/seo-blog/types.js';

// ─── 1. Claims and audiences ─────────────────────────────────────────────────

test('claims: the reviewer’s examples are refused; a claim must say what its quote says', () => {
  assert.match(unsupportedBy('Guaranteed compliant landlords in Kent', 'helps private landlords in Kent stay compliant')!, /same key words in the same order/);
  assert.match(unsupportedBy('Not trusted by landlords', 'Trusted by 300 landlords')!, /"not", "no", "never"/);
  assert.match(unsupportedBy('Trusted by landlords', 'We are not trusted by landlords')!, /"not"/, 'a verbatim run inside a negated quote is not support');
  assert.match(unsupportedBy('We never charge fees', 'We charge fees monthly')!, /"not"/);
  assert.match(unsupportedBy('Fees without hidden extras', 'Fees with hidden extras')!, /"not"/);
  // A strengthening word added or dropped.
  assert.match(unsupportedBy('Always on time for landlords', 'On time for landlords in Kent')!, /"guaranteed", "only"/);
  assert.match(unsupportedBy('Help for landlords in Kent', 'Help for all landlords in Kent today')!, /"guaranteed", "only"/, 'dropping "all" is refused for a claim');
  assert.match(unsupportedBy('The best help for landlords', 'Friendly help for landlords')!, /"guaranteed", "only"/);
  assert.match(unsupportedBy('#1 letting agent in Brighton', 'A letting agent in Brighton and Hove')!, /"guaranteed", "only"/);
  assert.match(unsupportedBy('Number one letting agent in Brighton', 'A letting agent in Brighton and Hove')!, /"guaranteed", "only"/);
  assert.match(unsupportedBy('Guaranteed rent for landlords', 'Rent for landlords paid monthly')!, /"guaranteed", "only"/);
  // Order, inflections and loose stems.
  assert.match(unsupportedBy('Landlords help Kent', 'We help landlords in Kent')!, /same order/);
  assert.match(unsupportedBy('Compliance for landlords', 'Compliant landlords across Kent')!, /key words/, '"compliance" is not an inflection of "compliant"');
  assert.match(unsupportedBy('Trusted by 500 landlords', 'Trusted by 300 landlords')!, /states "500"/);
  assert.match(unsupportedBy('Trusted by landlords', 'by')!, /too short/);
  // Supported: the same words (any case, punctuation, spacing), or every content word in order with plain inflections.
  for (const [value, quote] of [
    ['We help landlords in Kent', 'We help landlords in Kent'],
    ['we help LANDLORDS, in Kent!', 'Quay Lettings: we help landlords in Kent.'],
    ['Trusted by 300 landlords', 'Trusted by 300 landlords across Kent'],
    ['Helped landlords let their homes', 'We help landlords letting homes across Kent'],
    ['Landlords stay compliant', 'helps private landlords in Kent stay compliant'],
    ['No fees until your home is let', 'Never pay a fee until your home is let.'],
    ['Over 200 landlords trust us', 'Over 200 landlords trust us with their homes'],
    ['Every deposit is protected', 'Every tenant is referenced and every deposit is protected'],
  ] as const) assert.equal(unsupportedBy(value, quote), null, value);
  assert.deepEqual(['landlords', 'landlord’s', 'helped', 'helping', 'letting', 'lettings', 'managed', 'manages', 'properties', 'boxes'].map((w) => stem(w.replace('’', "'"))),
    ['landlord', 'landlord', 'help', 'help', 'let', 'let', 'manag', 'manag', 'property', 'box']);
});

test('audiences: the same rule without the strengthening check; negations and numbers still count', () => {
  assert.equal(unsupportedBy('All landlords in Kent', 'We help landlords in Kent', 'audience'), null, 'who it is for is a description, not a promise');
  assert.equal(unsupportedBy('Portfolio owners in East Sussex', 'We work with first-time landlords, accidental landlords and portfolio owners across East Sussex', 'audience'), null);
  assert.match(unsupportedBy('All landlords in Kent', 'We help landlords in Kent')!, /"guaranteed", "only"/, 'the same line as a claim is refused');
  assert.match(unsupportedBy('Landlords not in Kent', 'We help landlords in Kent', 'audience')!, /"not"/);
  assert.match(unsupportedBy('Landlords with 5 homes', 'Landlords with several homes in Kent', 'audience')!, /states "5"/);
  assert.match(unsupportedBy('First-time buyers in Leeds', 'We help property investors find deals', 'audience')!, /key words/);
});

// ─── 2. A price sits beside its own offer ────────────────────────────────────

test('prices: the reviewer’s example (another product’s price on the same page) is refused; a price beside its own name is kept', () => {
  const page = 'The Pro plan costs £49 per month. The Agency plan costs £99 per month.';
  assert.equal(priceBesideOffer(page, 'Pro plan', '£99 per month', ['Agency plan']), false);
  assert.equal(priceBesideOffer(page, 'Pro plan', '£99 per month', []), false, 'the other product need not be on the card: its sentence is not the Pro plan’s');
  assert.equal(priceBesideOffer(page, 'Pro plan', '£49 per month', ['Agency plan']), true);
  assert.equal(priceBesideOffer(page, 'Agency plan', '£99 per month', ['Pro plan']), true);
  // A collapsed pricing table (website text keeps no line breaks): each price goes to the nearest name before it.
  const table = 'Pricing Starter £29 per month Pro £49 per month Pro Plus £499 per month Cancel any time.';
  const names = ['Starter', 'Pro', 'Pro Plus'];
  assert.equal(priceBesideOffer(table, 'Pro', '£49 per month', ['Starter', 'Pro Plus']), true);
  assert.equal(priceBesideOffer(table, 'Pro', '£499 per month', ['Starter', 'Pro Plus']), false, '"Pro" inside "Pro Plus" is Pro Plus');
  assert.equal(priceBesideOffer(table, 'Starter', '£49 per month', ['Pro', 'Pro Plus']), false, 'nearer Pro than Starter');
  assert.equal(priceBesideOffer(table, 'Pro Plus', '£499 per month', names.slice(0, 2)), true);
  // The window: a price far past the name in one run-on block is refused; just before the name is allowed.
  const far = `Quay Compliance Plan ${'covers gas safety reminders and deposit checks for each home you let '.repeat(6)}£49 per month`;
  assert.ok(far.indexOf('£49') - 'Quay Compliance Plan'.length > PRICE_AFTER_NAME && far.length > 400, 'past the window, in a block too long to count as one item');
  assert.equal(priceBesideOffer(`${far} and more besides, for every landlord who wants it and many others`, 'Quay Compliance Plan', '£49 per month', ['Mentoring programme']), false);
  assert.equal(priceBesideOffer('From £49 per month: the Quay Compliance Plan', 'Quay Compliance Plan', '£49 per month', []), true);
  // A distinctive part of the name counts; a generic word alone does not.
  assert.equal(priceBesideOffer('Our Compliance Plan costs £49 per month.', 'Quay Compliance Plan', '£49 per month', []), true);
  assert.equal(priceBesideOffer('The plan costs £49 per month.', 'Quay Compliance Plan', '£49 per month', []), false);
  assert.equal(priceBesideOffer('Gold costs £499 per month.', 'Gold Membership', '£499 per month', []), true);
  // A line break ends a block; a sentence end ends a block.
  assert.equal(priceBesideOffer('Quay Compliance Plan\n£49 per month', 'Quay Compliance Plan', '£49 per month', []), false);
  assert.equal(priceBesideOffer('Quay Compliance Plan. £49 per month.', 'Quay Compliance Plan', '£49 per month', []), false);
  // Named once, price in the same short block, no other offer in it: accepted beyond the window.
  const once = `The Quay Compliance Plan ${'covers reminders, checks and calls for you '.repeat(5)}for £49 per month.`;
  assert.ok(once.length < 400 && once.indexOf('£49') - once.indexOf('Plan') > PRICE_AFTER_NAME);
  assert.equal(priceBesideOffer(once, 'Quay Compliance Plan', '£49 per month', []), true);
  assert.equal(priceBesideOffer(`${once} Quay Compliance Plan members love it.`, 'Quay Compliance Plan', '£49 per month', []), false, 'named twice: the window applies');
  // Whole numbers still.
  assert.equal(priceBesideOffer('Gold costs £499 per month.', 'Gold Membership', '£49', []), false);
});

const docsTwo = [{ id: 'pricing', text: 'The Pro plan costs £49 per month. The Agency plan costs £99 per month.' }];
const proOffer = (price: string | null): ProfileOffer => ({ name: 'Pro plan', description: 'For growing agents.', price, url: null, sourceDocumentId: 'pricing' });
const bare = (over: Partial<ProfileFacts> = {}): ProfileFacts & { summary: string; positioning: string; voice: { tone: string[]; do: string[]; dont: string[]; examples: string[] } } => ({
  summary: 'Plans for letting agents.', positioning: '', voice: { tone: [], do: [], dont: [], examples: [] }, offers: [], audiences: [], approvedClaims: [], conflicts: [], missingFacts: [], exclusions: [], sources: [], ...over,
}) as never;

test('prices on the card: one not beside its offer is a problem, and the repair empties it exactly as an invented price', () => {
  const card = bare({ offers: [proOffer('£99 per month')] });
  assert.match(strictProfileProblems(card, docsTwo).join('\n'), /the price "£99 per month" is in document pricing but not beside this offer's name/);
  const fixed = repairProfileFacts(card, docsTwo)!;
  assert.equal(fixed.value.offers[0]!.price, null); assert.deepEqual(fixed.leftOut, [{ what: 'price', text: 'Pro plan' }]);
  assert.deepEqual(strictProfileProblems(fixed.value, docsTwo), []);
  assert.deepEqual(strictProfileProblems(bare({ offers: [proOffer('£49 per month')] }), docsTwo), []);
});

test('price questions: an answer not beside its offer is dropped; the backstop only counts prices beside the name', () => {
  const docs = [{ id: 'a', text: 'The Pro plan costs £49 per month. The Agency plan costs £99 per month.' }, { id: 'b', text: 'Price list: Pro plan £59 per month.' }];
  const question = { field: 'Pro plan price', detail: 'Two prices', documentIds: ['a', 'b'], kind: 'price' as const, offer: 'Pro plan' };
  const options = [{ value: '£49 per month', documentId: 'a', quote: 'Pro plan costs £49 per month' }, { value: '£59 per month', documentId: 'b', quote: 'Pro plan £59 per month' },
    { value: '£99 per month', documentId: 'a', quote: 'Agency plan costs £99 per month' }];
  const card = bare({ offers: [{ ...proOffer(null), sourceDocumentId: 'a' }], conflicts: [{ ...question, options }] });
  assert.match(strictProfileProblems(card, docs).join('\n'), /the price option "£99 per month" is not written beside "Pro plan"/);
  const fixed = repairProfileFacts(card, docs)!;
  assert.deepEqual(fixed.value.conflicts[0]!.options!.map((o) => o.value), ['£49 per month', '£59 per month']);
  assert.deepEqual(strictProfileProblems(fixed.value, docs), []);

  const found = priceConflicts({ offers: [proOffer('£49 per month')], conflicts: [] }, docs);
  assert.equal(found.length, 1); assert.deepEqual(found[0]!.options!.map((o) => o.value), ['£49 per month', '£59 per month'], 'the Agency plan’s £99 is never offered as the Pro plan’s price');
  assert.equal(priceConflicts({ offers: [proOffer('£49 per month')], conflicts: [] }, [docs[0]!, { id: 'c', text: 'Our partner’s suite costs £59 per month. Ask about the Pro plan.' }]).length, 0, 'a price beside no mention of the offer is not a disagreement');
  assert.equal(holdConflictedPrices(bare({ offers: [proOffer('£49 per month')] }), docs).offers[0]!.price, null);
});

// ─── 3. The model's own notes, its "never say" lines and its links ───────────

test('missing facts, "never say" lines, offer links and question labels: only what can be shown truthfully stays', () => {
  const docs = [{ id: 'home', page: 'https://quay.example/', text: 'Quay Lettings helps landlords in Kent. We never promise guaranteed rent. Book a call at calendly.com.' }];
  assert.equal(missingFactShowable('No named author'), true);
  for (const line of ['Price for a 3-bed HMO', 'No £ price for Gold', 'Whether the 12-month term applies']) assert.equal(missingFactShowable(line), false, line);
  assert.equal(exclusionSupported('Never promise guaranteed rent', docs), true);
  assert.equal(exclusionSupported('Guaranteed rent', docs), false, 'the page’s "never" is not in it, so it would say the opposite');
  assert.equal(exclusionSupported('Tax advice', docs), false);
  for (const [url, ok] of [['https://quay.example/join', true], ['https://www.quay.example/join', true], ['https://calendly.com/quay', true], ['http://quay.example/join', false],
    ['https://bit.ly/quay', false], ['javascript:alert(1)', false], ['https://quay.example.evil.test/', false], [null, true]] as const) assert.equal(offerUrlAllowed(url, docs), ok, String(url));
  assert.equal(offerUrlAllowed('https://quay.co.uk/join', [{ id: 'x', text: 'Words only.' }], { website: 'https://www.quay.co.uk' }), true, 'the business’s own website address counts');

  const offer = { name: 'Quay Compliance Plan', description: '', price: null, url: 'https://bit.ly/quay', sourceDocumentId: 'home' };
  const card = bare({
    offers: [offer], missingFacts: ['No named author', 'Price for a 3-bed HMO'], exclusions: ['Never promise guaranteed rent', 'Tax advice'],
    conflicts: [{ field: 'Contract: 12 months or 6', detail: 'Two lengths', documentIds: ['home'], kind: 'other', offer: null, options: [] },
      { field: 'Service area', detail: 'Kent or 40 miles round', documentIds: ['home'], kind: 'other', offer: null, options: [] }],
  });
  const problems = strictProfileProblems(card, docs).join('\n');
  for (const why of [/url must be an https address/, /exclusion "Tax advice" is not stated/, /missingFacts line "Price for a 3-bed HMO" states a number/, /title of conflict "Contract: 12 months or 6" states "12"/, /detail of conflict "Service area" states "40"/]) assert.match(problems, why);
  const fixed = repairProfileFacts(card, docs)!;
  assert.deepEqual(strictProfileProblems(fixed.value, docs), []);
  assert.equal(fixed.value.offers[0]!.url, null); assert.deepEqual(fixed.value.exclusions, ['Never promise guaranteed rent']); assert.deepEqual(fixed.value.missingFacts, ['No named author']);
  assert.deepEqual(fixed.value.conflicts, [{ field: 'Service area', detail: '', documentIds: ['home'], kind: 'other', offer: null, options: [] }], 'a label is emptied, never reworded; a question titled with an unfound figure goes');
  assert.deepEqual(fixed.leftOut, [{ what: 'link', text: 'https://bit.ly/quay' }, { what: 'question', text: '' }, { what: 'exclusion', text: 'Tax advice' }]);
  assert.deepEqual(leftOutLines(fixed.leftOut).map((l) => l.label), ['The link “https://bit.ly/quay”', 'One of the questions we found', 'The “never say” line “Tax advice”'], 'the unfound "12" is never shown');
});

// ─── A plausible small-business site ─────────────────────────────────────────

const HOME = 'Harbour Lettings is a family-run letting agent in Brighton and Hove. We help private landlords let and manage their homes without the stress. We work with first-time landlords, accidental landlords and portfolio owners across East Sussex. Every tenant is referenced and every deposit is protected. Over 200 landlords trust us with their homes. We never promise guaranteed rent. Never pay a fee until your home is let.';
const PRICING = 'Our services Tenant Find costs £495 + VAT per let. We find, reference and move in your tenant. Full Management costs 12% of the monthly rent. We handle rent collection, repairs and inspections. Ask about our landlord insurance from £15 per month.';
const SITE_DOCS = [{ id: 'home', page: 'https://harbour.example/', text: HOME }, { id: 'pricing', page: 'https://harbour.example/pricing', text: PRICING }];

function harbourCard() {
  return bare({
    summary: 'Harbour Lettings is a family-run letting agent in Brighton and Hove.', positioning: 'Letting and management without the stress.',
    voice: { tone: ['friendly', 'plain'], do: ['Speak to landlords directly'], dont: ['Jargon'], examples: ['We help private landlords let and manage their homes without the stress.'] },
    offers: [
      { name: 'Tenant Find', description: 'We find, reference and move in your tenant.', price: '£495 + VAT per let', url: 'https://harbour.example/pricing', sourceDocumentId: 'pricing' },
      { name: 'Full Management', description: 'Rent collection, repairs and inspections.', price: '£15 per month', url: 'https://bit.ly/harbour-full', sourceDocumentId: 'pricing' },
    ],
    audiences: ['Private landlords', 'First-time landlords', 'Portfolio owners in East Sussex'],
    approvedClaims: ['Every deposit is protected', 'Over 200 landlords trust us', 'We protect every deposit', 'No fees until your home is let'],
    exclusions: ['Never promise guaranteed rent', 'Tax advice'], missingFacts: ['No named author', 'Price for a 3-bed HMO'],
    sources: [
      { field: 'audience', value: 'Private landlords', documentId: 'home', quote: 'We help private landlords let and manage their homes' },
      { field: 'audience', value: 'First-time landlords', documentId: 'home', quote: 'We work with first-time landlords, accidental landlords and portfolio owners across East Sussex' },
      { field: 'audience', value: 'Portfolio owners in East Sussex', documentId: 'home', quote: 'portfolio owners across East Sussex' },
      { field: 'claim', value: 'Every deposit is protected', documentId: 'home', quote: 'Every tenant is referenced and every deposit is protected' },
      { field: 'claim', value: 'Over 200 landlords trust us', documentId: 'home', quote: 'Over 200 landlords trust us with their homes' },
      { field: 'claim', value: 'We protect every deposit', documentId: 'home', quote: 'every deposit is protected' },
      { field: 'claim', value: 'No fees until your home is let', documentId: 'home', quote: 'Never pay a fee until your home is let.' },
    ],
  });
}

test('a plausible small-business site still gives a useful card: two offers, three audiences, three of four claims', () => {
  const card = harbourCard();
  const fixed = repairProfileFacts(card, SITE_DOCS)!;
  assert.deepEqual(strictProfileProblems(fixed.value, SITE_DOCS), []);
  const v = fixed.value;
  assert.deepEqual(v.offers.map((o) => [o.name, o.price, o.url]), [['Tenant Find', '£495 + VAT per let', 'https://harbour.example/pricing'], ['Full Management', null, null]],
    'the insurance price two sentences away is not Full Management’s; the short link is not the business’s own');
  assert.deepEqual(v.audiences, card.audiences, 'all three audiences survive');
  assert.deepEqual(v.approvedClaims, ['Every deposit is protected', 'Over 200 landlords trust us', 'No fees until your home is let'], 'a reworded claim with its words out of order is left out');
  assert.deepEqual(v.exclusions, ['Never promise guaranteed rent']); assert.deepEqual(v.missingFacts, ['No named author']);
  assert.equal(v.summary, card.summary); assert.deepEqual(v.voice, card.voice);
  assert.deepEqual(fixed.leftOut, [{ what: 'price', text: 'Full Management' }, { what: 'link', text: 'https://bit.ly/harbour-full' }, { what: 'claim', text: 'We protect every deposit' }, { what: 'exclusion', text: 'Tax advice' }]);
  // Its real price, as the page writes it, is accepted.
  const priced = { ...card, offers: [card.offers[0]!, { ...card.offers[1]!, price: '12% of the monthly rent', url: null }] };
  assert.equal(repairProfileFacts(priced, SITE_DOCS)!.value.offers[1]!.price, '12% of the monthly rent');
});

// ─── 4. Fuzz: the repair never adds, and always leaves a card the strict check accepts ───

function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('fuzz: thousands of generated cards; strictProfileProblems(repair(x)) is always [] and nothing is ever added', (t) => {
  const random = rng(20261115);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const words = ['landlords', 'Kent', 'help', 'trusted', 'by', 'not', 'never', 'always', 'guaranteed', 'only', 'best', 'all', 'the', 'plan', 'Pro', 'Plus', 'Starter', 'Gold', 'Membership',
    'costs', '£49', '£499', '£49.99', '£1,500', 'per', 'month', '300', '12%', 'homes', 'compliant', 'stay', 'private', 'deposit', 'protected', 'every', 'fees', 'without', 'no', '.', '\n', 'over', '#1'];
  const sentence = (n: number) => Array.from({ length: n }, () => pick(words)).join(' ').replace(/ \. /g, '. ').replace(/ \n /g, '\n');
  const docs = () => Array.from({ length: 1 + Math.floor(random() * 3) }, (_, i) => ({ id: `d${i}`, page: pick([null, 'https://quay.example/', 'https://other.example/p']), text: sentence(20 + Math.floor(random() * 60)) }));
  const slice = (text: string) => { const a = Math.floor(random() * text.length), b = Math.min(text.length, a + 5 + Math.floor(random() * 50)); return text.slice(a, b); };
  const phrase = (ds: { text: string }[]) => random() < 0.6 ? slice(pick(ds).text).trim() : sentence(1 + Math.floor(random() * 5));
  const names = ['Pro', 'Pro Plus', 'Starter', 'Gold Membership', 'Quay Compliance Plan', 'Mentoring programme (500 places)'];
  let repaired = 0, refused = 0, removed = 0;
  for (let i = 0; i < 3000; i++) {
    const ds = docs(), ids = [...ds.map((d) => d.id), 'ghost', null];
    const offers = Array.from({ length: Math.floor(random() * 4) }, (): ProfileOffer => ({
      name: pick(names), description: random() < 0.5 ? '' : phrase(ds), price: random() < 0.3 ? null : pick(['£49', '£499', '£49 per month', '£1,500', '£4', '12%', phrase(ds)]),
      url: pick([null, 'https://quay.example/x', 'https://bit.ly/y', 'http://quay.example/z', 'https://other.example/p']), sourceDocumentId: pick(ids),
    }));
    const audiences = Array.from({ length: Math.floor(random() * 4) }, () => phrase(ds)), approvedClaims = Array.from({ length: Math.floor(random() * 4) }, () => phrase(ds));
    const sources = [...audiences.map((value) => ({ field: 'audience' as const, value })), ...approvedClaims.map((value) => ({ field: 'claim' as const, value }))]
      .map((s) => ({ ...s, documentId: pick(ids), quote: random() < 0.7 ? slice(pick(ds).text) : s.value }));
    const conflicts = Array.from({ length: Math.floor(random() * 3) }, () => {
      const offer = random() < 0.7 && offers.length ? pick(offers).name : pick([null, 'Platinum']);
      return { field: pick([`${offer ?? 'Area'} price`, 'Contract length', `Fee of £${Math.floor(random() * 99)}`, phrase(ds)]), detail: pick(['Two answers', phrase(ds), 'Says 30 days']),
        documentIds: [pick(ds).id, 'ghost'], kind: pick(['price', 'other', undefined] as const), offer,
        options: Array.from({ length: Math.floor(random() * 4) }, () => { const d = pick(ds); const quote = slice(d.text); return { value: random() < 0.6 ? slice(quote) : pick(['£49', '£59 per month']), documentId: pick([d.id, 'ghost']), quote }; }) };
    });
    const card = bare({ offers, audiences, approvedClaims, sources, conflicts: conflicts as never, exclusions: Array.from({ length: Math.floor(random() * 3) }, () => phrase(ds)),
      missingFacts: Array.from({ length: Math.floor(random() * 3) }, () => phrase(ds)), summary: phrase(ds), positioning: phrase(ds),
      voice: { tone: [phrase(ds)], do: [phrase(ds)], dont: [phrase(ds)], examples: [phrase(ds)] } });
    const context = { website: pick([null, 'https://quay.example']) };
    const result = repairProfileFacts(card, ds, context);
    if (!result) { refused++; continue; }
    repaired++;
    const v = result.value;
    assert.deepEqual(strictProfileProblems(v, ds, context), [], `seed ${i}`);
    // Nothing added: every kept line was in the answer, in order; a kept field is the same or emptied.
    const sub = <T>(kept: readonly T[], from: readonly T[], same: (a: T, b: T) => boolean) => { let at = 0; for (const k of kept) { while (at < from.length && !same(k, from[at]!)) at++; assert.ok(at < from.length, `seed ${i}: added ${JSON.stringify(k)}`); at++; } };
    sub(v.audiences, card.audiences, (a, b) => a === b); sub(v.approvedClaims, card.approvedClaims, (a, b) => a === b);
    sub(v.exclusions ?? [], card.exclusions ?? [], (a, b) => a === b); sub(v.missingFacts, card.missingFacts, (a, b) => a === b);
    sub(v.sources ?? [], card.sources ?? [], (a, b) => JSON.stringify(a) === JSON.stringify(b));
    for (const part of ['tone', 'do', 'dont', 'examples'] as const) sub(v.voice![part], card.voice[part], (a, b) => a === b);
    sub(v.offers, card.offers, (a, b) => a.name === b.name && a.sourceDocumentId === b.sourceDocumentId && (a.price === b.price || a.price === null) && (a.url === b.url || a.url === null)
      && (a.description === b.description || b.description.includes(a.description)));
    sub(v.conflicts, card.conflicts, (a, b) => (a.field === b.field || a.field === '') && (a.detail === b.detail || a.detail === '') && a.kind === b.kind && a.documentIds.every((id) => b.documentIds.includes(id))
      && (a.options ?? []).every((o) => (b.options ?? []).some((p) => JSON.stringify(o) === JSON.stringify(p))));
    for (const text of ['summary', 'positioning'] as const) assert.ok(v[text] === card[text] || v[text] === '', `seed ${i}: ${text}`);
    if (result.leftOut.length) removed++;
  }
  t.diagnostic(`${repaired} repaired, ${refused} refused, ${removed} with lines left out`);
  assert.ok(repaired > 1500 && refused > 0 && removed > 1000, `a fuzz that exercises both outcomes: ${repaired} repaired, ${refused} refused, ${removed} with lines left out`);
});

// ─── 5. Nothing unverified reaches a writing prompt ──────────────────────────

const PLANTED = ['PLANTED-MISSING', '£777', 'PLANTED-TITLE', 'PLANTED-DETAIL', 'PLANTED-QUOTE', 'PLANTED-LEFTOUT', 'PLANTED-URL', 'PLANTED-OPTION', 'PLANTED-PRICE-SOURCE'];
function plantedProfile(): BrandProfile {
  return {
    brandId: 'b', version: 7, knowledge: [], summary: 'Quay Lettings helps private landlords in Kent stay compliant.', audiences: ['Private landlords in Kent'], positioning: 'Plain-English compliance help.',
    offers: [{ name: 'Quay Compliance Plan', description: 'Monthly support.', price: '£49 per month', url: 'javascript:PLANTED-URL', sourceDocumentId: 'pricing', priceSourceDocumentId: 'PLANTED-PRICE-SOURCE' },
      { name: 'Mentoring programme', description: 'Weekly calls.', price: null, url: 'https://quay.example/mentoring', sourceDocumentId: 'pricing' }],
    conversionPages: [{ url: 'https://quay.example/join', label: 'Join' }], voice: { tone: ['plain'], do: ['Explain rules simply'], dont: ['Jargon'], examples: ['We help landlords in Kent.'] },
    approvedClaims: ['We help landlords in Kent'], exclusions: ['Tax advice'],
    conflicts: [{ field: 'Mentoring programme PLANTED-TITLE £777', detail: 'PLANTED-DETAIL', documentIds: ['pricing'], kind: 'other', offer: 'Mentoring programme', options: [{ value: 'PLANTED-OPTION', documentId: 'pricing', quote: 'PLANTED-QUOTE words here' }] }],
    missingFacts: ['PLANTED-MISSING price £777'], sources: [{ field: 'claim', value: 'We help landlords in Kent', documentId: 'home', quote: 'PLANTED-QUOTE' }],
    leftOut: [{ what: 'claim', text: 'PLANTED-LEFTOUT' }], strict: true, factsSha: 'f', source: 'extracted', confirmedAt: '2026-11-15T00:00:00.000Z', confirmedBy: 'u', createdAt: 'x', generation: null,
  } as BrandProfile;
}

test('the writing allowlist: exactly these fields, and nothing planted in an unverified field reaches any serialisation', () => {
  const profile = plantedProfile();
  const shown = writingProfile(profile);
  assert.deepEqual(Object.keys(shown).sort(), ['approvedClaims', 'audiences', 'conversionPages', 'exclusions', 'offers', 'offersWithOpenQuestions', 'positioning', 'summary', 'voice']);
  assert.deepEqual(Object.keys(shown.offers[0]!).sort(), ['description', 'name', 'price', 'sourceDocumentId', 'url']);
  assert.deepEqual(shown.offers.map((o) => o.url), [null, 'https://quay.example/mentoring']);
  assert.deepEqual(shown.offersWithOpenQuestions, ['Mentoring programme'], 'an open question reaches the writer only as the verified offer name it is about');
  for (const text of [JSON.stringify(profileForPrompt(profile)), JSON.stringify(methodEvidenceContext(profile))]) for (const p of PLANTED) assert.ok(!text.includes(p), p);
});

test('every writing call’s actual prompt carries none of the unverified fields', async () => {
  const profile = plantedProfile();
  const sent: string[] = [];
  const llm: LlmClient = { mode: 'mock', complete: async (req) => { sent.push(JSON.stringify(req)); throw new Error('captured'); } };
  const article = { title: 'A title', seoTitle: 'A title', metaDescription: 'm', excerpt: 'e', slug: 'a-title', intro: 'i', sections: [{ heading: 'h', body: 'b' }], conclusion: 'c', cta: null, faqs: [], citations: [], image: { kind: 'none' }, author: null } as unknown as ArticleBody;
  const brief = { id: 'x', planId: 'p', brandId: 'b', role: 'pillar', slug: 'a-title', workingTitle: 'A working title', targetQuery: 'landlord compliance', searchIntent: 'learn', relatedQuestions: [], angle: 'a',
    outline: ['one'], keyPoints: ['k'], cta: null, internalLinks: [], whyFit: 'w', sourceIds: [] } as unknown as ArticleBrief;
  const calls = [
    () => writeArticlePromotions(llm, profile, article), () => writeArticleCampaignPromotions(llm, profile, article),
    () => rewriteSection(llm, { profile, outline: ['one'], section: { heading: 'h', body: 'b' }, instruction: '', sources: [], linkable: [] }),
    () => writeArticle(llm, { profile, brief, sources: [], linkable: [], length: 'standard' }),
    () => proposeCluster(llm, { brandName: 'Quay', profile, inventory: [], sources: [], focus: null, excluded: [], sourceArticleUrl: null }),
  ];
  for (const call of calls) await assert.rejects(call());
  assert.equal(sent.length, calls.length);
  for (const [i, request] of sent.entries()) {
    assert.ok(request.includes('Quay Compliance Plan') && request.includes('We help landlords in Kent'), `call ${i} carries the verified facts`);
    for (const p of PLANTED) assert.ok(!request.includes(p), `call ${i} must not carry ${p}`);
  }
});
