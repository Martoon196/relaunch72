/**
 * Our SEO score (src/seo-blog/seo-score.ts): every check passes, partly passes and fails on purpose-built input; the
 * weights add up to 100; phrase matching is fair; missing data is left out rather than guessed; it is fast and safe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeKeys, MUST_FIX_CAP, readingEase, REPETITION_CAP, sentences, SEO_GATE_BAR, SEO_WEIGHTS, seoNextSteps, seoScore, stem, STUFFING_CAP, syllables, SOME_REPETITION_CAP, seoGate, words, type SeoCheck, type SeoScore } from '../src/seo-blog/seo-score.js';
import { readFileSync } from 'node:fs';
import * as R from './seo-score-review-fixtures.js';
import * as R2 from './seo-score-review2-fixtures.js';
import * as R3 from './seo-score-review3-fixtures.js';
import * as G4 from './seo-score-review4-good.js';
import * as RB4 from './seo-score-review4-rubbish.js';
import { seoBlogCapabilitiesLine } from '../src/portal/seo-blog-capabilities.js';
import type { ArticleBody } from '../src/seo-blog/types.js';
import * as fx from './seo-blog-article-page-fixtures.js';
import * as sp from './seo-panel-fixtures.js';

delete process.env.CONTENT_AREA_PREVIEW;

const SITE = { siteHosts: ['https://www.martinhowardproperty.example'], checkIssues: [] as { code: string }[] };
const check = (s: SeoScore, id: string): SeoCheck => { const c = s.checks.find((x) => x.id === id); assert.ok(c, `check ${id} present`); return c!; };
const result = (s: SeoScore, id: string) => check(s, id).result;
const q = (targetQuery: string, relatedQuestions: string[] = []) => ({ targetQuery, relatedQuestions });
/** A minimal body; every test overrides what it looks at. */
function mini(o: Partial<ArticleBody> = {}): ArticleBody {
  return { title: 'T', seoTitle: '', metaDescription: '', excerpt: '', slug: '', intro: '', sections: [], conclusion: '', cta: null, faqs: [], citations: [],
    image: { kind: 'none', url: null, alt: '', provenance: '', width: null, height: null }, author: null, ...o } as ArticleBody;
}
const para = (n: number, word = 'house') => Array.from({ length: n }, () => word).join(' ');
/** Ordinary, varied sentences of 11 to 15 words, for checks that need real prose. */
const BANK = [
  'Start with the end value, because every other number in the deal depends on it.',
  'Check recent sold prices in the same street, not the asking prices you see online.',
  'A careful buyer adds the buying costs, the works and the holding costs together.',
  'However, a thin margin leaves very little room for the surprises that older houses bring.',
  'Lenders usually send their own valuer, who looks at similar homes sold nearby this year.',
  'For example, three similar terraces selling for about the same price give a useful guide.',
  'Write each figure down, so you can explain your offer calmly to the agent later.',
  'Most people underestimate how long the works will take and what the delays will cost.',
  'Then compare the profit you need with what is left once every cost is counted.',
  'A survey matched to the age of the building often finds problems you cannot see.',
  'Because rates change, test the numbers with a higher interest rate before you commit.',
  'Good deals usually look dull on paper, while risky ones tend to look exciting at first.',
  'Keep a simple spreadsheet for every property you view, even the ones you reject.',
  'Agents respect buyers who explain their offer with clear figures and a sensible timetable.',
  'Finally, walk away when the sums do not work, however much you like the house.',
  'Planning rules can change what you are allowed to build, so check them early.',
  'Insurance, council tax and utility bills keep running when the house sits empty.',
  'Selling costs come off the end value too, including legal fees and the agent.',
  'In fact, many investors lose money on small jobs that nobody bothered to price.',
  'Quotes from two or three builders show you whether the works budget is realistic.',
];
/** n sentences of real prose, cycling through the bank; `offset` starts elsewhere in it. */
const prose = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => BANK[(i + offset) % BANK.length]).join(' ');

test('the weights add up to 100, and every check in a full report carries its documented weight', () => {
  assert.equal(Object.values(SEO_WEIGHTS).reduce((a, b) => a + b, 0), 100);
  const s = seoScore(sp.brief(), fx.body({ image: sp.strongBody().image }), SITE);
  assert.equal(s.checks.reduce((n, c) => n + c.weight, 0), 100, 'all 28 checks present when phrase, questions, a picture and check results exist');
  assert.equal(s.checks.length, Object.keys(SEO_WEIGHTS).length);
  assert.deepEqual(s.parts.map((p) => [p.label, p.weight]), [['Search', 56], ['Easy to read', 29], ['Answers the searcher', 15]]);
  assert.ok(Number.isInteger(s.score) && s.score >= 0 && s.score <= 100);
  // Failures first, then partly, then passes.
  const rank = { fail: 0, partly: 1, pass: 2 } as const;
  for (let i = 1; i < s.checks.length; i++) assert.ok(rank[s.checks[i - 1]!.result] <= rank[s.checks[i]!.result]);
  for (const c of s.checks) { assert.equal(c.result === 'pass', c.todo === null); assert.equal(c.points, c.result === 'pass' ? c.weight : c.result === 'partly' ? c.weight / 2 : 0); }
});

test('the impossible check is gone and one edit is not paid twice in full', () => {
  const s = seoScore(sp.brief(), fx.body(), SITE);
  assert.ok(!s.checks.some((c) => c.id === 'pictures.inline'), 'pictures inside the article are not scored');
  assert.ok(!s.checks.some((c) => /inside the text/.test(c.found)));
  // The title pair and the opening pair: the second of each is worth half its earlier weight.
  assert.equal(SEO_WEIGHTS.phraseTitleStart, 1);
  assert.equal(SEO_WEIGHTS.openingToThePoint, 2);
  // A perfect article can reach 100.
  const best = seoScore(sp.measured(), sp.strongBody(), SITE);
  assert.ok(best.available === 100 && best.checks.every((c) => c.result === 'pass' || c.weight - c.points <= 4));
});

test('phrase matching: case, punctuation, word order, plurals and possessives; words inside words are not stretched', () => {
  const t = (title: string, phrase: string) => result(seoScore(q(phrase), mini({ seoTitle: title }), SITE), 'phrase.title');
  assert.equal(t('BUY-TO-LET Mortgages: a plain guide for landlords', 'buy to let mortgages'), 'pass', 'case and hyphens');
  assert.equal(t('Buy-to-let mortgages: a plain guide', 'buy to let mortgage'), 'pass', 'the plural is the phrase');
  assert.equal(t('Bridging loans explained for investors', 'bridging loan'), 'pass', 'the plural is the phrase');
  assert.equal(t('Mortgages for buy to let, explained', 'buy to let mortgages'), 'partly', 'all words close together, different order');
  assert.equal(t('A landlord’s guide to deposits', "landlord's guide"), 'pass', 'curly and straight apostrophes are the same');
  assert.equal(t('Landlords guide to tenancy deposits', "landlord's guide"), 'pass', 'the possessive matches the plain and plural forms');
  assert.equal(t('Write a better letter to the council', 'let'), 'fail', 'not inside a longer word');
  assert.equal(t('Property: the deal, appraised.', 'property deal'), 'partly', 'punctuation separates but words stay close');
  assert.equal(t('Property values rise as interest rates fall and a deal is hard to find', 'property deal'), 'fail', 'too far apart');
  // Start of the title and the address, for plurals and apostrophes.
  const s = seoScore(q('bridging loan'), mini({ seoTitle: 'Bridging loans explained for investors', slug: 'bridging-loans-explained' }), SITE);
  assert.equal(result(s, 'phrase.title_start'), 'pass');
  assert.equal(result(s, 'phrase.address'), 'pass');
  assert.equal(result(seoScore(q("landlord's guide"), mini({ slug: 'landlords-guide' }), SITE), 'phrase.address'), 'pass', 'the address is compared without apostrophes');
});

test('the search phrase checks: title, start of title, description, address, opening, sub-heading and sensible use', () => {
  const P = 'maximum offer';
  const good = mini({ seoTitle: 'Maximum offer: how to work it out for a property', metaDescription: 'Work out your maximum offer on a property with this simple method, step by step, before you speak to the agent.', slug: 'maximum-offer',
    intro: `Your maximum offer is the most you should pay for a property. ${prose(4)}`, sections: [{ id: 's1', heading: 'Working out your maximum offer', body: prose(20, 4) }],
    conclusion: `Write your maximum offer down before you speak to the agent. ${prose(2, 8)}` });
  const s = seoScore(q(P), good, SITE);
  for (const id of ['phrase.title', 'phrase.title_start', 'phrase.description', 'phrase.address', 'phrase.opening', 'phrase.heading', 'phrase.use']) assert.equal(result(s, id), 'pass', id);
  const late = seoScore(q(P), mini({ seoTitle: 'A long guide to property, written plainly: your maximum offer' }), SITE);
  assert.equal(result(late, 'phrase.title_start'), 'partly');
  const none = seoScore(q(P), mini({ seoTitle: 'Property', intro: 'Hello there.', slug: 'property', metaDescription: 'Nothing.' }), SITE);
  for (const id of ['phrase.title', 'phrase.title_start', 'phrase.description', 'phrase.address', 'phrase.opening', 'phrase.heading', 'phrase.use']) assert.equal(result(none, id), 'fail', id);
  const mixed = seoScore(q(P), mini({ slug: 'offer-maximum', intro: 'The offer you make, at its very maximum, matters most.', metaDescription: 'Your offer, at its maximum, should be written down before you speak to anyone.', sections: [{ id: 'a', heading: 'Offer: the maximum', body: 'x' }] }), SITE);
  for (const id of ['phrase.opening', 'phrase.description', 'phrase.use']) assert.equal(result(mixed, id), 'partly', id);
  // The address and a sub-heading may hold the main words in another order (a close form): that passes.
  for (const id of ['phrase.address', 'phrase.heading']) assert.equal(result(mixed, id), 'pass', id);
  // Sensible use: once is partly; all in one part is partly; stuffing fails.
  assert.equal(result(seoScore(q(P), mini({ intro: `Your maximum offer comes from the sums below. ${prose(20)}` }), SITE), 'phrase.use'), 'partly');
  const onePlace = check(seoScore(q(P), mini({ intro: `Your maximum offer comes first in this short guide. Set the maximum offer early in the process. ${prose(20)}` }), SITE), 'phrase.use');
  assert.equal(onePlace.result, 'partly'); assert.match(onePlace.found, /All the uses are in one part/);
  const stuffed = check(seoScore(q(P), mini({ intro: 'maximum offer is a maximum offer and a maximum offer. '.repeat(10) }), SITE), 'phrase.use');
  assert.equal(stuffed.result, 'fail'); assert.match(stuffed.found, /stuffed/);
  // Density counts uses, not the phrase's words: a nine-word phrase used twice in 600 words is fine.
  const long = 'how to work out the maximum offer on a house';
  const nine = seoScore(q(long), mini({ intro: `This explains how to work out the maximum offer on a house today. ${prose(22)}`, conclusion: `Now you know how to work out the maximum offer on a house in practice. ${prose(22, 3)}` }), SITE);
  assert.equal(result(nine, 'phrase.use'), 'pass', check(nine, 'phrase.use').found);
});

test('counterweights on the phrase: alone as a sentence or heading does not count, more than two headings is forced, split across a heading is not a use', () => {
  const P = 'maximum offer';
  const aloneIn = (introSentences: number) => seoScore(q(P), mini({ intro: `Maximum offer. ${prose(introSentences)}`, sections: [{ id: 'a', heading: 'Maximum offer', body: `Maximum offer. ${prose(5)}` }, { id: 'b', heading: 'More', body: `Maximum offer. ${prose(5)}` }] }), SITE);
  const alone = aloneIn(8);
  assert.equal(result(alone, 'phrase.opening'), 'partly', 'the phrase on its own is not a sentence');
  assert.equal(result(alone, 'phrase.heading'), 'partly', 'a heading that is only the phrase');
  assert.equal(result(alone, 'phrase.use'), 'fail');
  assert.match(check(alone, 'phrase.use').found, /only appears on its own/);
  // Four uses are never too many, however short the page (the fourth review, A3): in about 200 words they are still
  // only "on its own", never "stuffed".
  assert.match(check(aloneIn(3), 'phrase.use').found, /only appears on its own/);
  assert.notEqual(aloneIn(3).cap?.kind, 'stuffing');
  const many = seoScore(q(P), mini({ sections: ['Your maximum offer explained', 'Setting a maximum offer', 'When the maximum offer is too low'].map((heading, i) => ({ id: `${i}`, heading, body: prose(5, i) })) }), SITE);
  assert.equal(result(many, 'phrase.heading'), 'partly'); assert.match(check(many, 'phrase.heading').found, /More than two/);
  // "maximum" ends a heading and "offer" starts the text below: not a use.
  const split = seoScore(q(P), mini({ sections: [{ id: 'a', heading: 'Know your maximum', body: `Offer amounts follow from the sums. ${prose(5)}` }] }), SITE);
  assert.equal(result(split, 'phrase.use'), 'fail');
});

test('the page checks: lengths in a band, a description that is a sentence, sub-headings with real parts, questions with real answers', () => {
  const s = (o: Partial<ArticleBody>) => seoScore(null, mini(o), SITE);
  assert.equal(result(s({ seoTitle: 'x'.repeat(50) }), 'page.title_length'), 'pass');
  assert.equal(result(s({ seoTitle: 'x'.repeat(80) }), 'page.title_length'), 'partly');
  assert.equal(result(s({ seoTitle: '' }), 'page.title_length'), 'fail');
  assert.equal(result(s({ metaDescription: 'Work out the most you should offer on a property, step by step, before you call the agent.' }), 'page.description_length'), 'pass');
  assert.equal(result(s({ metaDescription: 'x'.repeat(120) }), 'page.description_length'), 'partly', 'not a sentence');
  assert.equal(result(s({ metaDescription: 'Offer. Offer offer. Offer offer offer. Property property. Value value value value value.' }), 'page.description_length'), 'partly', 'repeated words');
  assert.equal(result(s({ metaDescription: 'x'.repeat(40) }), 'page.description_length'), 'partly');
  assert.equal(result(s({}), 'page.description_length'), 'fail');
  assert.equal(result(s({ slug: 'short-one' }), 'page.address_length'), 'pass');
  assert.equal(result(s({ slug: 'x'.repeat(70) }), 'page.address_length'), 'partly');
  assert.equal(result(s({ slug: '' }), 'page.address_length'), 'fail');
  assert.equal(check(s({ intro: para(300) }), 'page.length').found, '300 words: thin.');
  assert.equal(result(s({ intro: para(300) }), 'page.length'), 'fail');
  assert.equal(result(s({ intro: para(700) }), 'page.length'), 'partly');
  assert.equal(result(s({ intro: para(1300) }), 'page.length'), 'pass');
  assert.equal(result(s({ intro: para(3000) }), 'page.length'), 'partly', 'long');
  assert.equal(result(s({ intro: para(6000) }), 'page.length'), 'partly', 'long, never a fail on length alone');
  assert.equal(result(s({ intro: R.variedSentences(400).join(' ') }), 'page.length'), 'partly', 'long, never a fail on length alone');
  // Repeated sentences do not make an article longer.
  const repeated = check(s({ intro: Array.from({ length: 120 }, () => BANK[0]).join(' ') }), 'page.length');
  assert.equal(repeated.result, 'fail'); assert.match(repeated.found, /repeated sentences and not counted/);
  const parts = (n: number, body?: string) => Array.from({ length: n }, (_, i) => ({ id: `${i}`, heading: `Part ${i} of the guide`, body: body ?? prose(6, i * 6) }));
  assert.equal(result(s({ intro: prose(2, 18), sections: parts(3) }), 'page.subheadings'), 'pass');
  assert.equal(result(s({ sections: parts(1) }), 'page.subheadings'), 'partly');
  assert.equal(result(s({ sections: parts(3, 'x') }), 'page.subheadings'), 'fail', 'parts with almost no text');
  assert.equal(result(s({ sections: parts(3).map((p) => ({ ...p, heading: 'Same heading' })) }), 'page.subheadings'), 'partly', 'headings must differ');
  assert.equal(result(s({ sections: Array.from({ length: 6 }, (_, i) => ({ id: `${i}`, heading: `Part ${i}`, body: prose(4, i * 4) })) }), 'page.subheadings'), 'partly', 'too many for the length');
  assert.equal(result(s({}), 'page.subheadings'), 'fail');
  const faqs = (n: number, a = 'The answer depends on the end value of the property and every cost you count.') => Array.from({ length: n }, (_, i) => ({ q: `What about the property question ${i}?`, a }));
  assert.equal(result(s({ faqs: faqs(3) }), 'page.questions'), 'pass');
  assert.equal(result(s({ faqs: faqs(1) }), 'page.questions'), 'partly');
  assert.equal(result(s({ faqs: faqs(3, 'So yes. But go.') }), 'page.questions'), 'fail', 'one-line answers');
  assert.equal(result(s({ faqs: faqs(12) }), 'page.questions'), 'partly', 'too many');
  assert.equal(result(s({}), 'page.questions'), 'fail');
});

test('links: a real page of your own site passes; the home page, the article itself, a broken or one-word link is partly; checked sources pass', () => {
  const s = (o: Partial<ArticleBody>, ctx: Parameters<typeof seoScore>[2] = { siteHosts: SITE.siteHosts }) => seoScore(null, mini({ slug: 'maximum-offer', ...o }), ctx);
  assert.equal(result(s({ intro: 'See [our services](https://martinhowardproperty.example/services).' }), 'links.internal'), 'pass', 'www and no www are the same site');
  assert.equal(result(s({ intro: 'See [our blog page](https://blog.martinhowardproperty.example/x).' }), 'links.internal'), 'pass', 'a sub-domain is your own site');
  assert.equal(result(s({ cta: { label: 'Book', url: 'https://www.martinhowardproperty.example/contact' } }), 'links.internal'), 'partly');
  assert.match(check(s({ intro: 'See [our home page](https://www.martinhowardproperty.example/).' }), 'links.internal').found, /home page/);
  assert.equal(result(s({ intro: 'See [our home page](https://www.martinhowardproperty.example/).' }), 'links.internal'), 'partly');
  assert.equal(result(s({ intro: 'See [this very guide](https://www.martinhowardproperty.example/blog/maximum-offer).' }), 'links.internal'), 'partly', 'the article itself');
  assert.equal(result(s({ intro: 'See [this very guide](https://www.martinhowardproperty.example/p/77).' }, { siteHosts: SITE.siteHosts, selfUrl: 'https://www.martinhowardproperty.example/p/77' }), 'links.internal'), 'partly', 'the article itself by its address');
  assert.equal(result(s({ intro: 'See [services](https://www.martinhowardproperty.example/services).' }), 'links.internal'), 'partly', 'a one-word link');
  const broken = { siteHosts: SITE.siteHosts, checkIssues: [{ code: 'links.broken_internal', severity: 'critical' as const, message: 'The internal link https://www.martinhowardproperty.example/soon is not a published page.' }] };
  // A link the checks found broken is a must-fix that caps the whole score; it is not taken off here a second time.
  const brokenScore = s({ intro: 'See [our coming soon page](https://www.martinhowardproperty.example/soon).' }, broken);
  assert.equal(result(brokenScore, 'links.internal'), 'pass');
  assert.match(check(brokenScore, 'links.internal').found, /not live yet: that is in the list of things to fix/);
  assert.equal(brokenScore.cap?.kind, 'must-fix');
  const brokenWarning = { siteHosts: SITE.siteHosts, checkIssues: [{ ...broken.checkIssues[0]!, severity: 'warning' as const }] };
  assert.equal(result(s({ intro: 'See [our coming soon page](https://www.martinhowardproperty.example/soon).' }, brokenWarning), 'links.internal'), 'partly', 'flagged but not a must-fix: no cap, so it counts here');
  assert.equal(result(s({ intro: 'See [GOV.UK](https://www.gov.uk/x).' }), 'links.internal'), 'fail');
  assert.match(check(s({}, { siteHosts: [] }), 'links.internal').found, /do not know your website address/);
  // Outside sources: checked links pass; unchecked or unverified links are partly; shown citations pass.
  assert.equal(result(s({ intro: 'See [GOV.UK](https://www.gov.uk/x).' }, SITE), 'links.sources'), 'pass');
  assert.equal(result(s({ intro: 'See [GOV.UK](https://www.gov.uk/x).' }), 'links.sources'), 'partly', 'the checks have not run');
  const unverified = { siteHosts: SITE.siteHosts, checkIssues: [{ code: 'links.unverified_external', severity: 'warning' as const, message: 'The external link https://www.gov.uk/x was not part of the research.' }] };
  assert.equal(result(s({ intro: 'See [GOV.UK](https://www.gov.uk/x).' }, unverified), 'links.sources'), 'partly');
  const cite = (pub: boolean) => [{ sourceId: 'a', url: 'https://www.gov.uk', title: 'G', retrievedAt: '2026-01-01', passage: '', public: pub }];
  assert.equal(result(s({ citations: cite(true) as never }), 'links.sources'), 'pass');
  assert.equal(result(s({ citations: cite(false) as never }), 'links.sources'), 'partly');
  assert.equal(result(s({}), 'links.sources'), 'fail');
});

test('pictures: no picture is a clear fail with what to do; a short description or the phrase alone is not a description', () => {
  const none = seoScore(q('maximum offer'), fx.body(), SITE);
  assert.equal(result(none, 'pictures.main'), 'fail');
  assert.equal(check(none, 'pictures.main').fix, 'picture');
  assert.match(check(none, 'pictures.main').todo!, /Add a picture/);
  // No picture costs the picture's points once: its description is not scored until there is a picture.
  assert.ok(!none.checks.some((c) => c.id === 'pictures.phrase'), 'the fixture has a description but no picture: nothing is published');
  assert.ok(none.leftOut.some((x) => /picture description/.test(x)));
  assert.equal(none.available, 100 - 7 - 2, 'no questions on record (7) and no picture to describe (2)');
  assert.equal(check(none, 'pictures.main').unlocks, SEO_WEIGHTS.pictureDescriptionPhrase);
  const img = (alt: string) => ({ kind: 'brand_asset' as const, url: 'https://x.example/a.jpg', alt, provenance: '', width: null, height: null });
  assert.equal(result(seoScore(q('maximum offer'), mini({ image: img('') }), SITE), 'pictures.main'), 'partly');
  assert.equal(result(seoScore(q('maximum offer'), mini({ image: img('A house') }), SITE), 'pictures.main'), 'partly', 'too short');
  const onlyPhrase = seoScore(q('maximum offer'), mini({ image: img('Maximum offers') }), SITE);
  assert.equal(result(onlyPhrase, 'pictures.main'), 'partly'); assert.equal(result(onlyPhrase, 'pictures.phrase'), 'fail');
  assert.equal(result(seoScore(q('maximum offer'), mini({ image: img('Working out a maximum offer at a desk') }), SITE), 'pictures.phrase'), 'pass');
  // The topic, said naturally, is enough: the phrase's last main word or half its main words, in any close form.
  assert.equal(result(seoScore(q('maximum offer'), mini({ image: img('The offer, at its maximum, on paper') }), SITE), 'pictures.phrase'), 'pass');
  assert.equal(result(seoScore(q('how to bleed a radiator'), mini({ image: img('A hand turning a radiator key on a white radiator') }), SITE), 'pictures.phrase'), 'pass');
  assert.equal(result(seoScore(q('repayment or interest only mortgage'), mini({ image: img('A couple at a kitchen table comparing two mortgage illustrations') }), SITE), 'pictures.phrase'), 'pass');
  assert.equal(result(seoScore(q('garden office planning permission'), mini({ image: img('A cedar-clad garden office with a flat roof') }), SITE), 'pictures.phrase'), 'pass');
  assert.equal(result(seoScore(q('garden office planning permission'), mini({ image: img('A cedar-clad office with a flat roof at dusk') }), SITE), 'pictures.phrase'), 'partly', 'one main word of four, not the last');
  assert.equal(result(seoScore(q('maximum offer'), mini({ image: img('A terraced house on a street') }), SITE), 'pictures.phrase'), 'fail');
  assert.equal(result(seoScore(q('maximum offer'), mini({ image: img('A house') }), SITE), 'pictures.phrase'), 'partly', 'describe the picture first');
});

test('easy to read: sentence length both ways, paragraphs, spacing, reading ease without credit for fragments, starts, linking words and variety', () => {
  const s = (o: Partial<ArticleBody>) => seoScore(null, mini(o), SITE);
  assert.equal(result(s({ intro: prose(12) }), 'read.sentences'), 'pass');
  assert.equal(result(s({ intro: `${para(25)}. ${prose(3)}` }), 'read.sentences'), 'pass', '1 sentence in 4 over 20 words is fine');
  assert.equal(result(s({ intro: `${para(25)}. ${prose(2)}` }), 'read.sentences'), 'partly', '1 in 3');
  assert.equal(result(s({ intro: `${para(25)}. ${para(25)}. Short one.` }), 'read.sentences'), 'fail');
  assert.equal(result(s({ intro: 'So go. But big. Then win. So yes. But go. Then run.' }), 'read.sentences'), 'fail', 'fragments');
  assert.equal(result(s({ intro: `${prose(6)} It works. Try it. See why.` }), 'read.sentences'), 'partly', 'some choppy fragments');
  assert.equal(result(s({ intro: `${para(100)}.` }), 'read.paragraphs'), 'pass');
  assert.equal(result(s({ intro: `${para(200)}.` }), 'read.paragraphs'), 'partly');
  assert.equal(result(s({ intro: `${para(200)}.\n\n${para(200)}.\n\n${para(200)}.` }), 'read.paragraphs'), 'fail');
  assert.equal(result(s({}), 'read.paragraphs'), 'fail', 'an empty article earns nothing for reading');
  assert.equal(result(s({}), 'read.spacing'), 'fail');
  assert.equal(result(s({ intro: para(200), sections: [{ id: 'a', heading: 'A', body: para(250) }] }), 'read.spacing'), 'pass');
  assert.equal(result(s({ intro: para(350) }), 'read.spacing'), 'partly');
  assert.equal(result(s({ intro: para(500) }), 'read.spacing'), 'fail');
  assert.equal(check(s({ sections: [{ id: 'a', heading: 'A', body: para(200) }], conclusion: para(150) }), 'read.spacing').result, 'partly', 'the closing paragraph runs on from the last part');
  assert.equal(result(s({ intro: prose(12) }), 'read.ease'), 'pass');
  assert.equal(result(s({ intro: 'Comprehensive institutional diversification necessitates considerable organisational responsibility. '.repeat(8) }), 'read.ease'), 'fail');
  assert.equal(result(s({ intro: 'Hi.' }), 'read.ease'), 'fail', 'too little text');
  const frag = check(s({ intro: 'So go. But big. Then win. So yes. But go. Then run. So fast. But now. Then stop. So good. Big win. Go now. '.repeat(2) }), 'read.ease');
  assert.equal(frag.result, 'fail', 'very easy fragments earn nothing'); assert.match(frag.found, /fragments/);
  assert.equal(result(s({ intro: 'Cats sat on the warm mat. Cats ran across the wide park. Cats sang in the old tree. A fox hid under the shed.' }), 'read.starts'), 'partly', 'three in a row');
  assert.equal(result(s({ intro: 'The cat sat on the warm mat. The dog ran across the wide park. The bird sang in the old tree. A fox hid under the shed.' }), 'read.starts'), 'pass', 'three "the" in a row is natural');
  assert.equal(result(s({ intro: 'The cat sat on the mat. The dog ran in the park. The bird sang in the tree. The fox hid. A cow went. The x went. The y came. The z left. The q sat.' }), 'read.starts'), 'fail', 'two runs of four');
  assert.equal(result(s({ intro: prose(20) }), 'read.starts'), 'pass');
  const startHeavy = (word: string, every: number) => BANK.slice(0, 12).map((x, i) => (i % every === 0 ? `${word} ${x.charAt(0).toLowerCase()}${x.slice(1)}` : x)).join(' ');
  assert.equal(result(s({ intro: startHeavy('Often', 4) }), 'read.starts'), 'partly', 'one word starts over 15% of sentences, never three in a row');
  // Everyday starts are natural at natural rates: "the" may start a quarter of the sentences.
  assert.equal(result(s({ intro: startHeavy('The', 4) }), 'read.starts'), 'pass', '"the" at 25%');
  assert.equal(result(s({ intro: startHeavy('The', 3) }), 'read.starts'), 'partly', '"the" at a third');
  assert.equal(result(s({ intro: '- The one\n- The two\n- The three' }), 'read.starts'), 'fail', 'no prose sentences at all');
  assert.equal(result(s({ intro: prose(20) }), 'read.linking'), 'pass', check(s({ intro: prose(20) }), 'read.linking').found);
  assert.equal(result(s({ intro: 'It rains, so we stay. Because it is cold, we sit inside. For example, tea helps. Cats nap.' }), 'read.linking'), 'partly', 'above 60%');
  assert.equal(result(s({ intro: 'So it rains today. But we stay inside. Then we read books. So we nap later. But cats nap too.' }), 'read.linking'), 'fail', 'every sentence starts with one');
  assert.equal(result(s({ intro: 'Cats nap all day. Dogs bark at night. Birds sing in spring. Fish swim upstream. Cows moo loudly.' }), 'read.linking'), 'fail');
  // About one sentence in six or seven is plenty: 15% passes, 8% to 15% is partly.
  const linkMix = (k: number) => [...Array.from({ length: k }, (_, i) => `Prices rose in town ${i + 1}, so buyers waited for a while.`), ...Array.from({ length: 10 - k }, (_, i) => `Buyers in town ${i + 1} looked at new homes this spring.`)].join(' ');
  assert.equal(result(s({ intro: linkMix(2) }), 'read.linking'), 'pass', '20%');
  assert.equal(result(s({ intro: linkMix(1) }), 'read.linking'), 'partly', '10%');
  assert.equal(result(s({ intro: linkMix(0) }), 'read.linking'), 'fail', 'none');
  assert.equal(result(s({ intro: prose(20) }), 'read.variety'), 'pass');
  assert.equal(result(s({ intro: Array.from({ length: 10 }, () => BANK[0]).join(' ') }), 'read.variety'), 'fail', 'repeated sentences');
});

test('reading ease is the proper Flesch formula with a sensible syllable estimate; sentences split sensibly', () => {
  const known: [string, number][] = [['the', 1], ['cat', 1], ['make', 1], ['makes', 1], ['table', 2], ['jumped', 1], ['wanted', 2], ['boxes', 2], ['people', 2], ['property', 3], ['appraise', 2], ['refurbishment', 4], ['investment', 3],
    ['mortgages', 3], ['prices', 2], ['services', 3], ['changes', 2], ['valuation', 4], ['area', 3], ['media', 3], ['premium', 3], ['period', 3], ['special', 2], ['quality', 3], ['nation', 2], ['financial', 3]];
  for (const [w, n] of known) assert.equal(syllables(w), n, w);
  // 30 words in 10 sentences of one-syllable words: 206.835 - 1.015*3 - 84.6*1 = 119.19.
  const ease = readingEase(Array.from({ length: 10 }, () => 'The cat sat.'));
  assert.ok(Math.abs(ease! - 119.19) < 0.01, String(ease));
  assert.equal(readingEase(['Too short.']), null);
  assert.deepEqual(sentences('Use e.g. this one. It costs £1.5m! Then what? Done'), ['Use e.g. this one.', 'It costs £1.5m!', 'Then what?', 'Done']);
  assert.deepEqual(sentences('He said “stop.” Then he left.'), ['He said “stop.”', 'Then he left.']);
  assert.deepEqual(sentences('The answer is no. Then we stopped.'), ['The answer is no.', 'Then we stopped.']);
  assert.deepEqual(sentences('Bring tools, paint, etc. Then start.'), ['Bring tools, paint, etc.', 'Then start.']);
  assert.deepEqual(sentences('Tools, paint, etc. are extra.'), ['Tools, paint, etc. are extra.']);
  assert.deepEqual(sentences('See No. 5 on the list. Mr. Smith agreed.'), ['See No. 5 on the list.', 'Mr. Smith agreed.']);
  assert.deepEqual(sentences('We live in the U.K. and pay tax. It is fine.'), ['We live in the U.K. and pay tax.', 'It is fine.']);
});

test('answers the searcher: related questions need a real answer, the opening gets to the point, a next step, and figures from the existing checks', () => {
  const answer = 'An appraisal takes about an hour for a first look, and an afternoon for a deal you are serious about.';
  const b = mini({ sections: [{ id: 'a', heading: 'How long does an appraisal take?', body: answer }], faqs: [{ q: 'What contingency should I allow?', a: 'Allow a contingency of at least ten per cent of the works budget, and more for older buildings.' }] });
  const s = (qs: string[], o = b, ctx: Parameters<typeof seoScore>[2] = SITE) => seoScore(q('maximum offer', qs), o, ctx);
  assert.equal(result(s(['How long does a property appraisal take?', 'What contingency should I allow for works?']), 'answers.questions'), 'pass');
  assert.equal(result(s(['How long does an appraisal take?', 'Is stamp duty due on a second home?']), 'answers.questions'), 'partly');
  const missing = check(s(['Is stamp duty due on a second home?']), 'answers.questions');
  assert.equal(missing.result, 'fail'); assert.match(missing.found, /Not yet: “Is stamp duty due on a second home\?”/);
  // A copied heading with a one-line answer is not an answer; plurals count as the question's words.
  const copied = mini({ sections: [{ id: 'a', heading: 'How long does an appraisal take?', body: 'So yes. But go.' }] });
  assert.equal(result(s(['How long does an appraisal take?'], copied), 'answers.questions'), 'fail');
  const plurals = mini({ sections: [{ id: 'a', heading: 'Bridging loan costs', body: 'Bridging loans cost more than mortgages: expect a monthly rate, an arrangement fee and an exit fee on top of the interest.' }] });
  assert.equal(result(seoScore(q('bridging loan', ['How much does a bridging loan cost?']), plurals, SITE), 'answers.questions'), 'pass');
  // A heading that shares a word but whose text does not answer is not enough.
  const basics = mini({ sections: [{ id: 'a', heading: 'Bridging loan basics', body: 'A bridging loan is short-term finance used while you wait for a sale or a longer mortgage to be arranged.' }] });
  assert.equal(result(seoScore(q('bridging loan', ['How much does a bridging loan cost?']), basics, SITE), 'answers.questions'), 'fail');
  assert.ok(!s([]).checks.some((c) => c.id === 'answers.questions'), 'no questions on record: left out');
  assert.ok(s([]).leftOut.some((x) => /questions people ask/.test(x)));
  assert.equal(result(s([], mini({ intro: `Your maximum offer is simple to work out once you know the numbers. ${para(80)}` })), 'answers.opening'), 'pass');
  assert.equal(result(s([], mini({ intro: `${para(70)} maximum offer.` })), 'answers.opening'), 'partly');
  assert.equal(result(s([], mini({ intro: para(70) })), 'answers.opening'), 'fail');
  assert.equal(result(s([], mini({ cta: { label: 'Book a call', url: 'https://www.martinhowardproperty.example/call' } })), 'answers.next_step'), 'pass');
  assert.equal(result(s([], mini({ cta: { label: 'Go', url: 'https://www.martinhowardproperty.example/call' } })), 'answers.next_step'), 'partly', 'a one-word label');
  assert.equal(result(s([], mini({ cta: { label: 'Book a call', url: 'https://example.org/anything' } })), 'answers.next_step'), 'partly', 'not your own site');
  assert.equal(result(s([], mini({ cta: { label: 'Book', url: 'javascript:alert(1)' } })), 'answers.next_step'), 'fail');
  assert.equal(result(s([], mini()), 'answers.next_step'), 'fail');
  assert.equal(result(s([], mini(), { ...SITE, checkIssues: [{ code: 'facts.unsupported_figure' }] }), 'answers.figures'), 'fail');
  assert.equal(result(s([], mini(), { ...SITE, checkIssues: [{ code: 'facts.figure_not_in_source' }, { code: 'voice.cliche' }] }), 'answers.figures'), 'fail');
  assert.equal(result(s([], mini(), { ...SITE, checkIssues: [{ code: 'voice.cliche' }] }), 'answers.figures'), 'pass');
  const notRun = s([], mini(), { siteHosts: SITE.siteHosts, checkIssues: null as never });
  assert.ok(!notRun.checks.some((c) => c.id === 'answers.figures')); assert.ok(notRun.leftOut.some((x) => /figure/.test(x)));
});

test('as an automatic target it fails closed: no phrase and checks that have not run count as fails, not left out', () => {
  const t = seoScore(null, sp.strongBody(), { siteHosts: SITE.siteHosts, asTarget: true });
  assert.equal(t.leftOut.filter((x) => /search phrase|figure/.test(x)).length, 0);
  assert.equal(result(t, 'phrase.missing'), 'fail');
  assert.equal(result(t, 'answers.figures'), 'fail');
  const report = seoScore(null, sp.strongBody(), { siteHosts: SITE.siteHosts });
  assert.ok(t.score < report.score - 20, `${t.score} vs ${report.score}`);
  assert.equal(seoScore(sp.measured(), sp.strongBody(), { ...SITE, asTarget: true }).score, seoScore(sp.measured(), sp.strongBody(), SITE).score, 'nothing changes when everything is on record');
});

test('caps: an open must-fix issue holds the score at 59; heavy repetition holds it at 40', () => {
  const good = seoScore(sp.measured(), sp.strongBody(), SITE);
  assert.ok(good.score > MUST_FIX_CAP);
  const held = seoScore(sp.measured(), sp.strongBody(), { ...SITE, checkIssues: [fx.critical] });
  assert.equal(held.score, MUST_FIX_CAP); assert.ok(held.uncapped > MUST_FIX_CAP);
  assert.equal(held.cap!.kind, 'must-fix');
  assert.match(held.cap!.reason, /^The checks found 1 thing to fix, so the score stays at 59 or below until it is fixed\.$/);
  assert.doesNotMatch(held.cap!.reason, /goes out/, 'true on a live article too');
  // A warning does not cap.
  assert.equal(seoScore(sp.measured(), sp.strongBody(), { ...SITE, checkIssues: fx.warnings }).cap, null);
  const repeated = seoScore(sp.measured(), { ...sp.strongBody(), sections: sp.strongBody().sections.map((x) => ({ ...x, body: Array.from({ length: 12 }, () => BANK[0]).join(' ') })) }, SITE);
  assert.ok(repeated.score <= REPETITION_CAP, String(repeated.score));
});

test('the gaming case from the review: a nonsense article of two-word sentences now scores low, padded or not; a genuinely good article still scores high', () => {
  const nonsense = seoScore(sp.brief(), sp.nonsenseBody(), SITE);
  assert.ok(nonsense.score <= 40, `nonsense scored ${nonsense.score}`);
  assert.ok(nonsense.uncapped <= 50, `nonsense scored ${nonsense.uncapped} before any cap`);
  const padded = seoScore(sp.brief(), sp.nonsenseBody(undefined, undefined, 300), SITE);
  assert.ok(padded.words > 25_000);
  assert.ok(padded.score <= 40, `padded nonsense scored ${padded.score}`);
  const asTarget = seoScore(sp.brief(), sp.nonsenseBody(), { siteHosts: SITE.siteHosts, asTarget: true });
  assert.ok(asTarget.score <= 40, String(asTarget.score));
  for (const id of ['read.sentences', 'read.ease', 'read.linking', 'read.variety', 'phrase.use', 'page.subheadings', 'page.questions', 'answers.questions']) assert.equal(result(nonsense, id), 'fail', id);
  for (const id of ['links.internal', 'answers.next_step', 'pictures.main', 'phrase.opening', 'phrase.heading']) assert.notEqual(result(nonsense, id), 'pass', id);
  const good = seoScore(sp.measured(), sp.strongBody(), SITE);
  assert.ok(good.score >= 85, `the good article scored ${good.score}`);
  assert.ok(!good.checks.some((c) => c.result === 'fail'), good.checks.filter((c) => c.result === 'fail').map((c) => c.id).join(', '));
  assert.ok(good.score - nonsense.score >= 45);
});

test('the next steps: the three checks worth most, and the score they would reach together, never above a cap', () => {
  const s = seoScore(sp.brief(), fx.body(), SITE);
  const n = seoNextSteps(s);
  assert.equal(n.checks.length, 3);
  assert.equal(n.from, s.score);
  assert.ok(n.to > n.from);
  const gains = n.checks.map((c) => c.weight - c.points);
  const others = s.checks.filter((c) => c.result !== 'pass' && c.fix !== null && !n.checks.includes(c)).map((c) => c.weight - c.points);
  assert.ok(Math.min(...gains) >= Math.max(0, ...others), 'the largest gains come first');
  // Rounded down, and a check that comes back once the fix is made (the picture description) counts as not passing.
  const unlocked = n.checks.reduce((t, c) => t + (c.unlocks ?? 0), 0);
  assert.equal(n.to, Math.floor(((s.earned + gains.reduce((a, b) => a + b, 0)) * 100) / (s.available + unlocked)));
  // Only checks the owner can act on: a filter leaves the others out of the headline.
  const noAddress = seoNextSteps(seoScore(sp.brief(), { ...sp.strongBody(), slug: 'maximum-offer-guide' }, SITE), 3, (c) => c.fix !== 'address');
  assert.ok(!noAddress.checks.some((c) => c.fix === 'address'));
  const held = seoScore(sp.measured(), sp.strongBody(), { ...SITE, checkIssues: [fx.critical] });
  assert.ok(seoNextSteps(held).to <= MUST_FIX_CAP);
  assert.deepEqual(seoNextSteps(seoScore(sp.measured(), sp.strongBody(), SITE), 0).checks, []);
});

test('a missing brief or an empty phrase scores the rest without crashing, and says what was left out', () => {
  for (const brief of [null, undefined, q(''), q('   '), q('!!! ???')]) {
    const s = seoScore(brief as never, fx.body(), SITE);
    assert.equal(s.phrase, null);
    assert.ok(!s.checks.some((c) => c.id.startsWith('phrase.') || c.id === 'pictures.phrase' || c.id === 'answers.opening'));
    assert.equal(s.checks.reduce((n, c) => n + c.weight, 0), 100 - 27 - 7, 'phrase checks (27) and questions (7) are left out');
    assert.ok(s.leftOut.some((x) => /search phrase/.test(x)));
    assert.ok(s.score >= 0 && s.score <= 100);
  }
});

test('an empty article and hostile or malformed input do not crash and stay within 0 to 100', () => {
  const empty = seoScore(q('maximum offer'), mini(), {});
  assert.ok(empty.score >= 0 && empty.score < 20, String(empty.score));
  assert.equal(empty.words, 0);
  const hostile = '<script>alert(1)</script>"\'&<img src=x onerror=alert(1)>';
  const s = seoScore({ targetQuery: hostile, relatedQuestions: [hostile, 5 as never, null as never] }, mini({ seoTitle: hostile, metaDescription: hostile, slug: hostile, intro: `${hostile} [x](javascript:alert(1)) [src:../../etc]`,
    sections: [{ id: hostile, heading: hostile, body: hostile }, null as never], faqs: [{ q: hostile, a: hostile }, {} as never], cta: { label: hostile, url: hostile }, citations: [null as never], image: null as never }), { siteHosts: [hostile, null, '', 'not a url at all'], checkIssues: [null as never] });
  assert.ok(s.score >= 0 && s.score <= 100);
  assert.equal(seoScore(q('x'), {} as never).checks.length > 0, true);
});

test('a 10,000 word article is scored in under 50 ms', () => {
  const sentence = 'Because the end value matters most, you should check recent sales in the same street before you make any offer. ';
  const body = mini({ seoTitle: 'Maximum offer', intro: sentence.repeat(3), sections: Array.from({ length: 50 }, (_, i) => ({ id: `${i}`, heading: `Part ${i} and the maximum offer`, body: `${sentence.repeat(5)}\n\n${sentence.repeat(5)}\n\n- One item\n- Two items` })), faqs: Array.from({ length: 10 }, (_, i) => ({ q: `Question ${i}?`, a: sentence })) });
  const s0 = seoScore(q('maximum offer', ['How do I set a maximum offer?']), body, SITE);
  assert.ok(s0.words >= 10_000, String(s0.words));
  let best = Infinity;
  for (let i = 0; i < 5; i++) { const t = performance.now(); seoScore(q('maximum offer', ['How do I set a maximum offer?']), body, SITE); best = Math.min(best, performance.now() - t); }
  assert.ok(best < 50, `${best.toFixed(1)} ms`);
});

test('the realistic article and the strong one: honest numbers', () => {
  const plain = seoScore(sp.brief(), fx.body(), SITE);
  const strong = seoScore(sp.measured(), sp.strongBody(), SITE);
  assert.ok(strong.score >= 85, String(strong.score));
  assert.ok(plain.score < strong.score);
  assert.ok(!strong.checks.some((c) => c.result === 'fail'));
});

test('no user-facing wording uses an em or en dash, or names a supplier, a method or a model', () => {
  for (const s of [seoScore(sp.brief(), fx.body(), SITE), seoScore(null, mini(), {}), seoScore(sp.measured(), sp.strongBody(), SITE)]) {
    for (const c of s.checks) for (const text of [c.name, c.found, c.todo ?? '']) {
      assert.doesNotMatch(text, /[–—]/, text);
      assert.doesNotMatch(text, /dataforseo|anthropic|claude|openai|gpt|\bmodel\b|method pack|production-core|blog-writing/i, text);
    }
  }
});

test('the start-up capability line is structured, has only on/off states, and no values', () => {
  const line = JSON.parse(seoBlogCapabilitiesLine('worker', { search: 'live', keywords: 'live', methods: true }));
  assert.deepEqual(line, { event: 'seo-blog.capabilities', process: 'worker', research: 'live', searchNumbers: 'on', writingMethods: 'on' });
  assert.deepEqual(JSON.parse(seoBlogCapabilitiesLine('portal', { search: 'unconfigured', keywords: 'mock', methods: false })), { event: 'seo-blog.capabilities', process: 'portal', research: 'unconfigured', searchNumbers: 'off', writingMethods: 'off' });
  assert.equal(JSON.parse(seoBlogCapabilitiesLine('portal', { search: 'live', keywords: 'off', methods: false })).searchNumbers, 'off');
});

// ─── The independent review: good natural writing scores in the mid-90s, rubbish 70 or below ──────────────────────

const GOOD = [['the how-to (bleed a radiator)', R.A], ['the comparison (repayment or interest only)', R.B], ['the long guide (garden office)', R.C]] as const;
const scoreGood = (x: R.GoodArticle, body = x.body, extra: Parameters<typeof seoScore>[2] = {}) => seoScore(x.brief, body, { siteHosts: [x.site], selfUrl: `${x.site}/blog/${x.body.slug}`, checkIssues: [], ...extra });

test('the review\'s three good natural articles score 93 or more with a picture and 88 or more without, with no check failing', () => {
  for (const [name, x] of GOOD) {
    const s = scoreGood(x);
    assert.ok(s.score >= 93, `${name} scored ${s.score}`);
    assert.equal(s.cap, null, name);
    assert.deepEqual(s.checks.filter((c) => c.result === 'fail').map((c) => c.id), [], name);
    // What is left is a true placement detail, never a push to make the writing worse.
    for (const c of s.checks.filter((k) => k.result !== 'pass')) assert.ok(['answers.opening', 'phrase.description'].includes(c.id), `${name}: ${c.id} ${c.found}`);
    const bare = scoreGood(x, R.withoutPicture(x.body));
    assert.ok(bare.score >= 88, `${name} without a picture scored ${bare.score}`);
    assert.deepEqual(bare.checks.filter((c) => c.result === 'fail').map((c) => c.id), ['pictures.main'], name);
    // As a gate, with the checks run, each clears the recommended bar.
    assert.ok(scoreGood(x, x.body, { targetMode: true }).score >= SEO_GATE_BAR.withPicture, name);
    assert.ok(scoreGood(x, R.withoutPicture(x.body), { targetMode: true }).score >= SEO_GATE_BAR.withoutPicture, name);
  }
});

test('every rubbish article from the review scores 70 or below, whatever the checks found', () => {
  const brief = sp.brief();
  const C = R.REVIEW_CONTEXT;
  const rubbish: [string, ArticleBody, Parameters<typeof seoScore>[2]?][] = [
    ['word salad, every limit met', R.wordSalad()],
    ['word salad, checks not run', R.wordSalad(), { ...C, checkIssues: null }],
    ['word salad, outside link flagged', R.wordSalad(), { ...C, checkIssues: [{ code: 'links.unverified_external', severity: 'warning', message: 'The external link https://example.org/x was not part of the research.' }] }],
    ['word salad, as a target with checks not run', R.wordSalad(), { ...C, checkIssues: null, targetMode: true }],
    ...[6, 8, 9, 10].map((n) => [`word salad, ${n}-word sentences`, R.wordSalad({ n, perPart: Math.ceil(121 / n) })] as [string, ArticleBody]),
    ['word salad, a heading every 84 words', R.wordSalad({ parts: 14, perPart: 7, n: 12 })],
    ['word salad, 26 parts', R.wordSalad({ parts: 26, perPart: 4, n: 11 })],
    ['word salad, 12-word answers', R.wordSalad({ faqA: (q, pick) => `${q.replace(/\?$/, '').split(' ').slice(-3).join(' ')} ${Array.from({ length: 9 }, () => pick(['cat', 'dog', 'sun', 'moon', 'tree'])).join(' ')}.` })],
    ['one empty paragraph repeated in 12 parts, a word swapped', R.spunArticle(12)],
    ['one empty paragraph repeated in 30 parts', R.spunArticle(30)],
    ...Object.entries(R.STUFFING).map(([k, f]) => [`stuffing: ${k}`, f()] as [string, ArticleBody]),
    ['padded with one checklist, 8 parts', R.padded(2, 8)],
    ['padded to 29,897 words with one checklist', R.padded(2, 120)],
    ['padded to 4,971 words with one checklist', R.padded(2, 17)],
    ['the two-word nonsense fixture', sp.nonsenseBody()],
  ];
  for (const [name, body, ctx] of rubbish) {
    const s = seoScore(brief, body, ctx ?? C);
    assert.ok(s.score <= 70, `${name} scored ${s.score} (uncapped ${s.uncapped})`);
  }
  assert.equal(seoScore(brief, R.padded(2, 120), C).words, 29_897);
  // The named cases, by the cap that holds each.
  assert.equal(seoScore(brief, R.wordSalad(), C).cap?.kind, 'not-sentences');
  assert.equal(seoScore(brief, R.spunArticle(12), C).cap?.kind, 'repetition');
  // 36 six-word sentences built on one pattern are held lower still, as rotating templates (40), and are stuffed too.
  const exact38 = seoScore(brief, R.STUFFING.exact38(), C);
  assert.ok(exact38.score <= REPETITION_CAP && ['stuffing', 'repetition'].includes(exact38.cap!.kind), `${exact38.score} ${exact38.cap?.kind}`);
  assert.match(check(exact38, 'phrase.use').found, /reads as stuffed/);
  assert.equal(seoScore(brief, R.STUFFING.variants36(), C).cap?.kind, 'stuffing');
  assert.ok(seoScore(brief, R.STUFFING.bullets60(), C).score <= STUFFING_CAP);
  assert.equal(seoScore(brief, R.padded(2, 120), C).score, REPETITION_CAP);
});

test('S1 varied wording: near repeats (a word or two changed) and list items count, over the whole article', () => {
  const s = (o: Partial<ArticleBody>) => seoScore(null, mini(o), SITE);
  const near = BANK.slice(0, 10).map((x) => x.replace(/\b(the|a)\b/, 'one')).join(' ');
  const swapped = s({ intro: prose(10), sections: [{ id: 'a', heading: 'Again', body: near }] });
  assert.equal(result(swapped, 'read.variety'), 'fail', check(swapped, 'read.variety').found);
  assert.match(check(swapped, 'read.variety').found, /repeat an earlier one word for word or nearly/);
  const items = s({ intro: prose(12), sections: [{ id: 'a', heading: 'List', body: Array.from({ length: 6 }, () => '- Check the roof, the gutters and the chimney stacks first').join('\n') }] });
  assert.notEqual(result(items, 'read.variety'), 'pass', 'repeated list items count');
  assert.ok(items.measures.repeatedSentences > 0);
  // Wording repeated far apart is caught too, not only within 50 words.
  const far = s({ intro: prose(20), sections: [{ id: 'a', heading: 'Later', body: prose(20) }] });
  assert.ok(far.measures.repeatedWording > 40, String(far.measures.repeatedWording));
  assert.equal(far.cap?.kind, 'repetition');
  // Natural writing is untouched.
  for (const [, x] of GOOD) { const g = scoreGood(x); assert.equal(result(g, 'read.variety'), 'pass'); assert.ok(g.measures.repeatedWording <= 3); }
  // Some repetition holds the score at 70; heavy repetition at 40.
  assert.ok(seoScore(sp.brief(), R.STUFFING.onePerPart(), R.REVIEW_CONTEXT).score <= SOME_REPETITION_CAP);
});

test('R1 length alone never caps: a long, varied guide is not held down, and nothing tells the owner it is "more than one article"', () => {
  const long = seoScore(sp.brief(), R.longVariedBody(300), R.REVIEW_CONTEXT);
  assert.ok(long.words > 5000, String(long.words));
  assert.equal(long.cap, null);
  assert.equal(long.score, long.uncapped);
  assert.equal(result(long, 'page.length'), 'partly', 'the 4-point length check stays: long, never more points');
  // The review's pillar guide: real prose, 5,475 words.
  const chapters = [R.C, R2.Q, R2.L, R.B, R.A, R2.G].flatMap((x, k) => x.body.sections.map((s, i) => ({ id: `c${k}-${i}`, heading: s.heading.replace(/^\d+\. /, ''), body: s.body })));
  const pillar = seoScore(R.C.brief, { ...R.C.body, sections: chapters }, { siteHosts: [R.C.site], checkIssues: [], targetMode: true });
  assert.equal(pillar.words, 5475);
  assert.equal(pillar.cap, null);
  assert.ok(pillar.score >= 94, String(pillar.score));
  for (const c of pillar.checks) assert.doesNotMatch(`${c.found} ${c.todo ?? ''}`, /more than one article/);
  // Padding is still held, by repetition.
  assert.equal(seoScore(sp.brief(), R.padded(2, 120), R.REVIEW_CONTEXT).cap?.kind, 'repetition');
});

test('S3 the phrase is counted everywhere and in every close form, and stuffing caps the score', () => {
  const brief = sp.brief();
  for (const k of ['bullets60', 'exact38', 'variants36', 'phraseBullets', 'sixWordRepeats', 'ingVariants'] as const) {
    const s = seoScore(brief, R.STUFFING[k](), R.REVIEW_CONTEXT);
    assert.equal(result(s, 'phrase.use'), 'fail', k);
    assert.match(check(s, 'phrase.use').found, /too many: it reads as stuffed/, k);
    assert.ok(s.score <= STUFFING_CAP, `${k}: ${s.score}`);
  }
  // Short bullets and short sentences count: 60 bullets read as 60 uses, not 2.
  assert.match(check(seoScore(brief, R.STUFFING.bullets60(), R.REVIEW_CONTEXT), 'phrase.use').found, /comes up 6\d times/);
  // Close forms: -ing and -ed forms, plurals and the main words in another order.
  assert.deepEqual([closeKeys('appraising'), closeKeys('appraised'), closeKeys('appraise')].map((k) => k.includes('apprais')), [true, true, true]);
  assert.ok(closeKeys('bleeding').includes('bleed') && closeKeys('stopped').includes('stop') && closeKeys('added').includes('add'));
  assert.ok(!closeKeys('letter').includes('let'));
});

test('S4 good writing is not marked down or pushed to get worse', () => {
  // a. Linking words in about one sentence in four pass (the three articles and the strong fixture measure 26% to 30%).
  for (const [name, x] of GOOD) assert.equal(result(scoreGood(x), 'read.linking'), 'pass', name);
  assert.equal(result(seoScore(sp.measured(), sp.strongBody(), SITE), 'read.linking'), 'pass');
  // b. The picture description passes when it describes the picture and mentions the topic; the exact phrase is not needed.
  for (const [name, x] of GOOD) assert.equal(result(scoreGood(x), 'pictures.phrase'), 'pass', name);
  // c. One exact use and natural variations after it pass.
  for (const [name, x] of GOOD) assert.equal(result(scoreGood(x), 'phrase.use'), 'pass', `${name}: ${check(scoreGood(x), 'phrase.use').found}`);
  // d. An answer under its own heading counts, matched on meaning words with plurals and close forms; the minimum
  //    answer length stays.
  const fixtureQ = seoScore({ targetQuery: 'appraise a property deal', relatedQuestions: ['How long should a property appraisal take?'] }, sp.strongBody(), SITE);
  assert.equal(result(fixtureQ, 'answers.questions'), 'pass', 'answered in the questions and answers without repeating its words');
  const habit = { ...R.A.body, sections: R.A.body.sections.map((x) => (x.id === 'a5' ? { ...x, heading: 'Make it a yearly habit' } : x.id === 'a2' ? { ...x, heading: 'Heating on or off?' } : x)) };
  assert.equal(result(scoreGood(R.A, habit), 'answers.questions'), 'pass', 'answers under natural headings');
  const short = mini({ sections: [{ id: 'a', heading: 'How long should a property appraisal take?', body: 'About an hour, usually.' }] });
  assert.equal(result(seoScore(q('appraise a property deal', ['How long should a property appraisal take?']), short, SITE), 'answers.questions'), 'fail', 'a short answer is not an answer');
  // e. Headings that ask the questions on record do not count against "too many headings use the phrase".
  const head = scoreGood({ ...R.C, brief: { ...R.C.brief, targetQuery: 'garden office' } });
  assert.equal(result(head, 'phrase.heading'), 'pass', check(head, 'phrase.heading').found);
  assert.equal(result(head, 'answers.questions'), 'pass');
  const exactHeads = mini({ sections: ['Your maximum offer explained', 'How do I set a maximum offer?', 'When is a maximum offer too low?', 'Is my maximum offer fair?'].map((heading, i) => ({ id: `${i}`, heading, body: prose(5, i) })) });
  assert.equal(result(seoScore(q('maximum offer', ['How do I set a maximum offer?', 'When is a maximum offer too low?', 'Is my maximum offer fair?']), exactHeads, SITE), 'phrase.heading'), 'pass');
  assert.equal(result(seoScore(q('maximum offer'), exactHeads, SITE), 'phrase.heading'), 'partly', 'without those questions on record, four is forced');
  // f. A business name after a separator is not a repeat.
  for (const title of ['Appraise a property deal | Martin Howard Property', 'Appraise a property deal - Martin Howard Property', 'Appraise a property deal – Martin Howard Property']) {
    const t = seoScore(sp.brief(), { ...sp.strongBody(), seoTitle: title }, SITE);
    assert.equal(result(t, 'phrase.title'), 'pass', title);
    assert.doesNotMatch(check(t, 'phrase.title').found, /repeats words/);
  }
  assert.equal(result(seoScore(q('bridging loan'), mini({ seoTitle: 'Bridging loans: what a bridging loan costs' }), SITE), 'phrase.title'), 'partly', 'a real repeat is still a repeat');
  // g. A complete 900-word how-to is not told to add words; the band suits what the searcher wants, and padding never earns more.
  const how = check(scoreGood(R.A), 'page.length');
  assert.equal(how.result, 'pass'); assert.match(how.found, /^933 words: a good length for a guide or how-to\.$/);
  const lengthFor = (intent: 'learn' | 'compare' | 'buy', n: number) => result(seoScore({ targetQuery: 'maximum offer', searchIntent: intent }, mini({ intro: R.variedSentences(Math.round(n / 16)).join(' ') }), SITE), 'page.length');
  assert.equal(lengthFor('learn', 850), 'pass');
  assert.equal(lengthFor('buy', 600), 'pass');
  assert.equal(lengthFor('compare', 700), 'partly');
  assert.equal(lengthFor('buy', 1800), 'partly', 'above the band earns nothing more');
  // h. "The" at a natural rate is not penalised (the how-to's 17%).
  assert.equal(result(scoreGood(R.A), 'read.starts'), 'pass');
  // i. An address that holds the phrase's main words passes.
  for (const slug of ['bleed-radiator', 'bleed-a-radiator', 'radiator-bleed']) assert.equal(result(seoScore(q('how to bleed a radiator'), mini({ slug }), SITE), 'phrase.address'), 'pass', slug);
  assert.equal(result(seoScore(q('how to bleed a radiator'), mini({ slug: 'radiator-guide' }), SITE), 'phrase.address'), 'partly');
});

test('S6 strict target mode fails closed: no phrase, no questions and checks not run are fails, and checks not run cap the score', () => {
  const report = seoScore(sp.measured(), sp.strongBody(), SITE);
  const noQs = seoScore({ ...sp.measured(), relatedQuestions: [] }, sp.strongBody(), { ...SITE, targetMode: true });
  assert.equal(result(noQs, 'answers.questions'), 'fail');
  assert.equal(noQs.leftOut.length, 0);
  assert.ok(noQs.score <= report.score - 7, `${noQs.score} vs ${report.score}`);
  const notRun = seoScore(sp.measured(), sp.strongBody(), { siteHosts: SITE.siteHosts, checkIssues: null, targetMode: true });
  assert.equal(result(notRun, 'answers.figures'), 'fail');
  assert.equal(notRun.cap?.kind, 'not-checked'); assert.equal(notRun.score, MUST_FIX_CAP);
  const noBrief = seoScore(null, sp.strongBody(), { ...SITE, targetMode: true });
  assert.equal(result(noBrief, 'phrase.missing'), 'fail'); assert.equal(result(noBrief, 'answers.questions'), 'fail');
  assert.equal(noBrief.available, 100, 'nothing is left out');
  // The read-only report still leaves out and scales.
  const ro = seoScore({ ...sp.measured(), relatedQuestions: [] }, sp.strongBody(), { siteHosts: SITE.siteHosts, checkIssues: null });
  assert.equal(ro.cap, null); assert.equal(ro.leftOut.length, 2);
  // `asTarget` is the same switch.
  assert.equal(seoScore(null, sp.strongBody(), { ...SITE, asTarget: true }).score, noBrief.score);
});

test('correctness: small matching misses, accents and possessives in the address, and the reviewer\'s 146 hard words', () => {
  const t = (title: string, phrase: string) => result(seoScore(q(phrase), mini({ seoTitle: `${title} for you today` }), SITE), 'phrase.title');
  assert.equal(t('Glasses repair near you', 'glass repair'), 'fail', '"glasses" is not more than one "glass"');
  assert.equal(t('Buses hire in Leeds', 'bus hire'), 'pass', '"buses" is the plural of "bus"');
  assert.equal(stem('glasses'), 'glasses'); assert.equal(stem('buses'), 'bus'); assert.equal(stem('houses'), 'house'); assert.equal(stem('businesses'), 'business'); assert.equal(stem('news'), 'news');
  const addr = (phrase: string, slug: string) => result(seoScore(q(phrase), mini({ slug }), SITE), 'phrase.address');
  assert.equal(addr('café insurance', 'cafe-insurance'), 'pass', 'accents');
  assert.equal(addr('cafe insurance', 'café-insurance'), 'pass');
  assert.equal(addr('landlord insurance', 'landlord-s-insurance'), 'pass', 'a possessive written into the address');
  assert.equal(addr("landlord's insurance", 'landlords-insurance'), 'pass');
  // The reviewer's list: 31 of 146 were wrong before this change; none now.
  const lists: Record<'reviewed' | 'unseen', Record<string, number>> = JSON.parse(readFileSync(new URL('./seo-score-syllables.json', import.meta.url), 'utf8'));
  const wrong = (list: Record<string, number>) => Object.entries(list).filter(([w, n]) => syllables(w) !== n).map(([w, n]) => `${w}:${syllables(w)}/${n}`);
  assert.equal(Object.keys(lists.reviewed).length, 146);
  assert.deepEqual(wrong(lists.reviewed), []);
  // The second review's 314 words, unseen when the first rules were written: 46 were wrong; the rule families (a silent
  // e before -ment, -ful, -ty and -ly; -thing and -one compounds; -ying; -gue and -que) leave four that English spells
  // irregularly.
  assert.equal(Object.keys(lists.unseen).length, 314);
  assert.deepEqual(wrong(lists.unseen), ['familiar:4/3', 'valuable:4/3', 'comfortable:4/3', 'jewellery:4/3']);
  // Reading ease on the reference sentences.
  const rep = (x: string, k = 3) => Array.from({ length: k }, () => x);
  assert.equal(Math.round(readingEase(rep('The cat sat on the mat.', 6))!), 116);
  assert.equal(readingEase(rep('This sentence, taken as a reading passage unto itself, is being used to prove a point.'))!.toFixed(1), '69.0');
  assert.equal(readingEase(['Four score and seven years ago our fathers brought forth on this continent, a new nation, conceived in Liberty, and dedicated to the proposition that all men are created equal.'])!.toFixed(1), '41.0');
});

test('the gate: the score is documented as a bar to pass, with a recommended bar with and without a picture', () => {
  assert.ok(SEO_GATE_BAR.withPicture > SEO_GATE_BAR.withoutPicture && SEO_GATE_BAR.withoutPicture > 70);
  const src = readFileSync(new URL('../src/seo-blog/seo-score.ts', import.meta.url), 'utf8');
  assert.match(src, /A GATE, NOT A TARGET/);
  assert.match(src, /it cannot judge meaning/);
  // The weights table in the header matches SEO_WEIGHTS, row for row, and totals 100.
  const rows = [...src.slice(0, src.indexOf('import type')).matchAll(/^ \* \| [^|]+\| [^|]+\| ([^|]+?)\s*\|\s+(\d+) \|$/gm)].map((m) => Number(m[2]));
  const total = rows.pop();
  assert.equal(total, 100);
  assert.deepEqual(rows, Object.values(SEO_WEIGHTS));
  // Cap reasons are plain: no dashes, no internals.
  for (const s of [seoScore(sp.brief(), R.wordSalad(), R.REVIEW_CONTEXT), seoScore(sp.brief(), R.STUFFING.exact38(), R.REVIEW_CONTEXT), seoScore(sp.brief(), R.padded(2, 8), R.REVIEW_CONTEXT), seoScore(sp.brief(), R2.strongPlusPhrase(16), R.REVIEW_CONTEXT)]) {
    assert.ok(s.cap); assert.doesNotMatch(s.cap!.reason, /[–—]|model|supplier|function word|n-gram|shingle/i, s.cap!.reason);
  }
});

// ─── The second review ───────────────────────────────────────────────────────

const SHAPES = [['the listicle', R2.L], ['recipe-style steps', R2.R], ['the glossary', R2.G], ['the article quoting a regulation', R2.Q], ['the short buy page', R2.Y]] as const;
const strictFor = (x: R.GoodArticle) => ({ siteHosts: [x.site], selfUrl: `${x.site}/blog/${x.body.slug}`, checkIssues: [], targetMode: true });

test('the five new good shapes score 90 or more with a picture and 85 or more without; the three originals stay at 98 or more', () => {
  for (const [name, x] of SHAPES) {
    const s = seoScore(x.brief, x.body, strictFor(x));
    assert.ok(s.score >= 90, `${name} scored ${s.score}: ${s.checks.filter((c) => c.result !== 'pass').map((c) => c.id).join(', ')}`);
    assert.equal(s.cap, null, name);
    assert.ok(seoScore(x.brief, R.withoutPicture(x.body), strictFor(x)).score >= 85, `${name} without a picture`);
  }
  for (const [name, x] of GOOD) assert.ok(scoreGood(x).score >= 98, name);
  // What each shape was marked down for in the review now passes.
  const steps = seoScore(R2.R.brief, R2.R.body, strictFor(R2.R));
  assert.doesNotMatch(check(steps, 'read.ease').found, /fragments/, 'a numbered how-to is not called fragments');
  assert.equal(result(steps, 'phrase.title'), 'pass', '"How to change a tap washer and stop a dripping tap" does not repeat words');
  assert.equal(result(steps, 'page.length'), 'pass', 'a complete 667-word how-to');
  const buy = seoScore(R2.Y.brief, R2.Y.body, strictFor(R2.Y));
  for (const id of ['phrase.description', 'phrase.opening', 'phrase.use', 'answers.opening']) assert.equal(result(buy, id), 'pass', `"Boiler service in Leeds" is the phrase: ${id}`);
  assert.equal(result(buy, 'read.linking'), 'pass', 'the buy page: list items are left out, and about one sentence in six is plenty');
  // The glossary's definitions are full sentences, so they count as prose; definitions rarely need linking words, and
  // at 13% the glossary stays "partly" there. That is the honest reading, and it still scores well over the bar.
  assert.equal(result(seoScore(R2.G.brief, R2.G.body, strictFor(R2.G)), 'read.linking'), 'partly');
});

test('list items are left out of the sentence, reading-ease and linking shares, but an article made mostly of short bullets cannot pass them', () => {
  const steps = Array.from({ length: 12 }, (_, i) => `${i + 1}. Turn the valve. Keep it safe.`).join('\n');
  const withSteps = seoScore(null, mini({ intro: prose(14), sections: [{ id: 'a', heading: 'Steps', body: steps }] }), SITE);
  for (const id of ['read.sentences', 'read.ease', 'read.linking']) assert.equal(result(withSteps, id), 'pass', id);
  const bullets = seoScore(null, mini({ intro: BANK[0], sections: [{ id: 'a', heading: 'Steps', body: Array.from({ length: 40 }, (_, i) => `- Check item ${i + 1} now`).join('\n') }] }), SITE);
  for (const id of ['read.sentences', 'read.ease', 'read.linking']) assert.notEqual(result(bullets, id), 'pass', id);
  assert.match(check(bullets, 'read.sentences').found, /Most of the article is list items/);
});

test('G2 phrase stuffing: 4% and above is held at 70 or below; good writing measures well under it', () => {
  for (const k of [12, 14, 16, 18, 20, 22, 24]) {
    const s = seoScore(R2.REVIEW2_BRIEF, R2.strongPlusPhrase(k), R2.REVIEW2_CONTEXT);
    assert.ok(s.measures.phraseShare >= 4, `${k}: ${s.measures.phraseShare}`);
    assert.ok(s.score <= 70, `${k} phrase sentences scored ${s.score}`);
    assert.equal(result(s, 'phrase.use'), 'fail');
  }
  // F2 of the third review: 13 added uses in 997 words (3.9% then; 4.0% now that very short items are left out of the
  // whole) is stuffed now, not "a little high".
  const high = seoScore(R2.REVIEW2_BRIEF, R2.strongPlusPhrase(10), R2.REVIEW2_CONTEXT);
  assert.equal(high.measures.phraseShare, 4);
  assert.equal(result(high, 'phrase.use'), 'fail', 'the phrase is stuffed');
  assert.equal(high.cap?.kind, 'stuffing');
  for (const [name, x] of [...GOOD, ...SHAPES]) {
    const s = seoScore(x.brief, x.body, strictFor(x));
    assert.ok(s.measures.phraseShare <= 2.5, `${name}: ${s.measures.phraseShare}`);
    assert.notEqual(result(s, 'phrase.use'), 'fail', name);
  }
});

test('every rubbish article of the second review scores 70 or below', () => {
  for (const [name, f] of R2.ROUND2_RUBBISH) {
    const s = seoScore(R2.REVIEW2_BRIEF, f(), R2.REVIEW2_CONTEXT);
    assert.ok(s.score <= 70, `${name} scored ${s.score}`);
    const bare = seoScore(R2.REVIEW2_BRIEF, R.withoutPicture(f()), R2.REVIEW2_CONTEXT);
    assert.ok(bare.score <= 70, `${name} without a picture scored ${bare.score}`);
  }
});

test('G1 the known limit: fluent empty filler and small-word salad score high, so the gate is necessary, not sufficient', () => {
  // These two say nothing at all, yet read as English sentences. A score that counts words cannot see that, and no
  // threshold here pretends to: the separate meaning check an automatic step needs exists for exactly these.
  for (const [name, f] of R2.KNOWN_LIMIT) {
    const s = seoScore(R2.REVIEW2_BRIEF, f(), R2.REVIEW2_CONTEXT);
    assert.ok(s.score >= 95, `${name} scored ${s.score}: the known limit, kept visible`);
    const g = seoGate(s);
    assert.equal(g.pass, true, `${name} passes the word-counting gate`);
    assert.equal(g.sufficient, false, 'and a pass is never enough on its own');
  }
  const src = readFileSync(new URL('../src/seo-blog/seo-score.ts', import.meta.url), 'utf8');
  assert.match(src, /NECESSARY, NOT SUFFICIENT/);
  assert.match(src, /A separate meaning check is required before any automatic rewrite is accepted/);
});

test('seoGate: pass, bar and plain reasons; strict mode, checks run, no cap', () => {
  const good = seoGate(scoreGood(R.A, R.A.body, { targetMode: true }));
  assert.deepEqual(good, { pass: true, bar: SEO_GATE_BAR.withPicture, reasons: [], sufficient: false });
  const bare = seoGate(scoreGood(R.A, R.withoutPicture(R.A.body), { targetMode: true }));
  assert.equal(bare.bar, SEO_GATE_BAR.withoutPicture); assert.equal(bare.pass, true);
  const notRun = seoGate(scoreGood(R.A, R.A.body, { targetMode: true, checkIssues: null }));
  assert.equal(notRun.pass, false); assert.ok(notRun.reasons.some((r) => /checks have not run/.test(r)), notRun.reasons.join(' | '));
  const report = seoGate(scoreGood(R.A, R.A.body, { checkIssues: null }));
  assert.equal(report.pass, false, 'a score with checks left out never passes the gate');
  const stuffedGate = seoGate(seoScore(R2.REVIEW2_BRIEF, R2.strongPlusPhrase(16), R2.REVIEW2_CONTEXT));
  assert.equal(stuffedGate.pass, false); assert.ok(stuffedGate.reasons.some((r) => /far too often/.test(r)));
  for (const r of [...notRun.reasons, ...stuffedGate.reasons]) assert.doesNotMatch(r, /[–—]/);
});

test('the phrase as searched allows small joining words between its words, and a title repeats only on a word used three times or a repeated pair', () => {
  const t = (title: string, phrase: string) => check(seoScore(q(phrase), mini({ seoTitle: title }), SITE), 'phrase.title');
  assert.equal(t('Boiler service in Leeds from a Gas Safe engineer', 'boiler service Leeds').result, 'pass');
  assert.equal(t('How to change a tap washer and stop a dripping tap', 'how to change a tap washer').result, 'pass');
  assert.match(t('Tap washers: a tap guide for every tap in the house', 'tap washer').found, /repeats words/);
  assert.match(t('Bridging loans: what a bridging loan costs in 2026', 'bridging loan').found, /repeats words/);
  assert.equal(result(seoScore(q('boiler service Leeds'), mini({ slug: 'boiler-service-in-leeds' }), SITE), 'phrase.address'), 'pass');
  // A word of meaning between them is not the phrase as searched.
  assert.equal(t('Boiler repair and service across Leeds and the area', 'boiler service Leeds').result, 'partly');
});

test('R2 a check with two things open is not promised in the headline gain', () => {
  const s = seoScore(sp.brief(), sp.strongBody(), SITE);
  const sub = check(s, 'page.subheadings');
  // Two thin parts (very short list items do not count towards a part's length) and too many sub-headings.
  assert.equal(sub.reasons, 3, sub.found);
  assert.match(sub.found, /fewer than 40 words/); assert.match(sub.found, /a lot of sub-headings for the length/);
  assert.ok(!seoNextSteps(s).checks.includes(sub), 'one change will not pass it, so it is not one of the three');
});


// ─── The third review: short list items (F1) and a phrase share just under the old stuffing line (F2) ──────────────

test('F1/F2 regression: every good article scores exactly what it scored before, with and without a picture, as a report and as a gate', () => {
  // Pinned on d4e5527, before these changes. Any change here must be explained, line by line.
  const pinned: [string, R.GoodArticle, number, number, number][] = [
    ['how-to', R.A, 99, 99, 94], ['comparison', R.B, 100, 100, 95], ['long guide', R.C, 98, 98, 93],
    ['listicle', R2.L, 96, 96, 91], ['recipe-style steps', R2.R, 94, 94, 88], ['glossary', R2.G, 94, 94, 90],
    ['quotes a regulation', R2.Q, 94, 94, 90], ['buy page', R2.Y, 98, 98, 92],
  ];
  for (const [name, x, report, strict, bare] of pinned) {
    const s = seoScore(x.brief, x.body, { ...strictFor(x), targetMode: false });
    const t = seoScore(x.brief, x.body, strictFor(x));
    const n = seoScore(x.brief, R.withoutPicture(x.body), strictFor(x));
    assert.deepEqual([s.score, t.score, n.score], [report, strict, bare], name);
    assert.equal(t.cap, null, name);
    assert.equal(seoGate(t).pass, true, name); assert.equal(seoGate(n).pass, true, `${name} without a picture`);
    assert.ok(t.measures.shortItems <= 6 && t.measures.stepItems <= 30, `${name}: ${JSON.stringify(t.measures)}`);
    assert.ok(t.measures.phraseShare <= 2.1, `${name}: phrase ${t.measures.phraseShare}%`);
  }
  // The recipe is the most list-heavy good fixture: under 3% in very short items and about a quarter in steps.
  assert.deepEqual([seoScore(R2.R.brief, R2.R.body, strictFor(R2.R)).measures.shortItems, seoScore(R2.R.brief, R2.R.body, strictFor(R2.R)).measures.stepItems], [2.8, 26.4]);
  const chapters = [R.C, R2.Q, R2.L, R.B, R.A, R2.G].flatMap((x, k) => x.body.sections.map((s, i) => ({ id: `c${k}-${i}`, heading: s.heading.replace(/^\d+\. /, ''), body: s.body })));
  assert.equal(seoScore(R.C.brief, { ...R.C.body, sections: chapters }, { siteHosts: [R.C.site], checkIssues: [], targetMode: true }).score, 96, 'the pillar');
  assert.equal(seoScore(sp.brief(), sp.strongBody(), SITE).score, 97, 'the strong fixture');
  assert.equal(seoScore(sp.brief(), sp.strongBody(), { ...SITE, targetMode: true }).score, 97, 'the strong fixture as a gate');
  assert.equal(seoScore(sp.brief(), fx.body(), SITE).score, 72, 'the realistic fixture');
  assert.equal(seoScore(sp.brief(), R.longVariedBody(300), R.REVIEW_CONTEXT).score, 93, 'a long varied guide');
});

test('F1 short list items: the review\'s bullet articles (92 to 98 before) are held at 70 or below and refused by the gate', () => {
  for (const [name, f] of R3.BULLET_ATTACKS) for (const body of [f(), R.withoutPicture(f())]) {
    const s = seoScore(R2.REVIEW2_BRIEF, body, R2.REVIEW2_CONTEXT);
    assert.ok(s.score <= SOME_REPETITION_CAP, `${name} scored ${s.score} (uncapped ${s.uncapped})`);
    assert.equal(seoGate(s).pass, false, name);
  }
  const by = (k: number) => seoScore(R2.REVIEW2_BRIEF, R3.BULLET_ATTACKS[k]![1](), R2.REVIEW2_CONTEXT);
  // A pasted list is a repeat however short its items, and however many times it is pasted.
  for (const k of [1, 2, 3]) { assert.equal(by(k).cap?.kind, 'repetition'); assert.equal(by(k).score, REPETITION_CAP); }
  assert.equal(by(3).words, 27_857);
  // Different keyword bullets are not repeats, but they are very short items (over 12% of the words); filler bullets
  // of six to eight words are step-sized items over 60% of the words.
  for (const k of [0, 4, 6]) assert.ok(by(k).measures.shortItems > 12, String(by(k).measures.shortItems));
  assert.ok(by(5).measures.stepItems > 60, String(by(5).measures.stepItems));
  const x3 = by(4);
  assert.equal(x3.cap?.kind, 'short-items');
  assert.match(x3.cap!.reason, /^Much of the article is short list items rather than sentences, so the score stays at 70 or below until more of it is written out in full sentences\.$/);
  // The advice under that state makes sense: nothing about splitting long sentences or using fewer linking words.
  for (const id of ['read.sentences', 'read.ease', 'read.linking']) {
    const c = check(x3, id);
    assert.notEqual(c.result, 'pass', id);
    assert.match(c.found, /Much of the article is short list items, so this is judged on only part of it\./, id);
    assert.equal(c.todo, 'Write more of the article as full sentences that explain things, and keep lists for steps and short items.', id);
  }
});

test('F1 honest lists are not marked down, and do not pass by diluting the repetition measures', () => {
  const base = seoScore(R2.REVIEW2_BRIEF, sp.strongBody(), R2.REVIEW2_CONTEXT);
  for (const [name, f] of R3.HONEST_LISTS) {
    const s = seoScore(R2.REVIEW2_BRIEF, f(), R2.REVIEW2_CONTEXT);
    assert.equal(s.cap, null, name);
    assert.ok(s.score >= base.score, `${name}: ${s.score} against ${base.score} without the list`);
    assert.equal(seoGate(s).pass, true, name);
  }
  // Lists of very short items (the tools, the pros and cons) leave both repetition measures exactly as they were.
  for (const k of [0, 2]) {
    const s = seoScore(R2.REVIEW2_BRIEF, R3.HONEST_LISTS[k]![1](), R2.REVIEW2_CONTEXT);
    assert.deepEqual([s.measures.repeatedSentences, s.measures.repeatedWording], [base.measures.repeatedSentences, base.measures.repeatedWording], R3.HONEST_LISTS[k]![0]);
  }
  // The same lists added to an article that repeats itself do not lift it: it stays held and refused.
  const platitudes = R2.make(R2.GEN.platitude);
  const held = seoScore(R2.REVIEW2_BRIEF, platitudes, R2.REVIEW2_CONTEXT);
  assert.equal(held.cap?.kind, 'repetition');
  for (const [name, f] of R3.HONEST_LISTS) {
    const added = f().sections.map((x, i) => x.body.slice(sp.strongBody().sections[i]!.body.length));
    const body = { ...platitudes, sections: platitudes.sections.map((x, i) => ({ ...x, body: `${x.body}${added[i % added.length] ?? ''}` })) } as ArticleBody;
    const s = seoScore(R2.REVIEW2_BRIEF, body, R2.REVIEW2_CONTEXT);
    assert.ok(s.score <= held.score && !seoGate(s).pass, `${name}: ${s.score}`);
  }
  // A very short item said twice is ordinary; said a third time it is a repeat.
  const twice = seoScore(null, mini({ intro: prose(20), sections: [{ id: 'a', heading: 'Pros and cons', body: '- Cost\n- Speed\n\nAnd then:\n\n- Cost\n- Risk' }] }), SITE);
  assert.equal(twice.measures.repeatedSentences, 0);
  const thrice = seoScore(null, mini({ intro: prose(20), sections: [{ id: 'a', heading: 'Pros and cons', body: '- Cost\n- Speed\n\nAnd then:\n\n- Cost\n- Risk\n\nAgain:\n\n- Cost' }] }), SITE);
  assert.ok(thrice.measures.repeatedSentences > 0);
});

test('F2 the phrase: over 2.5% the gate refuses, over 3.5% with six uses or more it is stuffed and capped; close forms count', () => {
  const seen = { natural: 0, high: 0, stuffed: 0 };
  for (let k = 0; k <= 24; k++) {
    const s = seoScore(R2.REVIEW2_BRIEF, R2.strongPlusPhrase(k), R2.REVIEW2_CONTEXT);
    const share = s.measures.phraseShare, g = seoGate(s), use = result(s, 'phrase.use');
    const phraseReason = g.reasons.some((r) => /comes up more often than reads naturally|far too often/.test(r));
    if (share > 3.5) { seen.stuffed++; assert.equal(use, 'fail', `${k}`); assert.equal(s.cap?.kind, 'stuffing', `${k}`); assert.ok(s.score <= STUFFING_CAP); assert.ok(phraseReason); }
    else if (share > 2.5) { seen.high++; assert.equal(use, 'partly', `${k}`); assert.equal(s.cap, null); assert.equal(g.pass, false, `${k} at ${share}%`); assert.ok(g.reasons.includes('The search phrase comes up more often than reads naturally. Use it fewer times; reworded forms of the phrase count as uses too.')); }
    else { seen.natural++; assert.ok(!phraseReason, `${k} at ${share}%: ${g.reasons.join(' | ')}`); }
  }
  assert.ok(seen.natural && seen.high && seen.stuffed, JSON.stringify(seen));
  // The third review's case (13 added uses in 997 words) is still stuffed and held at 60.
  const f2 = seoScore(R2.REVIEW2_BRIEF, R2.strongPlusPhrase(10), R2.REVIEW2_CONTEXT);
  assert.deepEqual([f2.words, f2.cap?.kind, f2.score, seoGate(f2).pass], [997, 'stuffing', STUFFING_CAP, false]);
  assert.match(check(f2, 'phrase.use').found, /in 997 words\. That is too many: it reads as stuffed\./);
  // Close forms count the same as the phrase as searched: plural, -ing and -ed, its main words in another order.
  const variants = ['Careful buyers appraise property deals before they offer.', 'Property deals appraised on paper rarely surprise anyone later.', 'Appraising a property deal takes an evening with the figures.', 'A deal on a property is easier to appraise once the works are priced.'];
  const close = (k: number) => seoScore(R2.REVIEW2_BRIEF, R3.eachPart((i) => (i < k ? variants[i % 4]! : '')), R2.REVIEW2_CONTEXT);
  assert.equal(seoGate(close(4)).pass, true, 'four natural variations in 900 words are fine');
  assert.equal(seoGate(close(6)).pass, false); assert.equal(close(6).cap, null);
  assert.equal(close(10).cap?.kind, 'stuffing');
  for (const [name, x] of [...GOOD, ...SHAPES]) assert.ok(!seoGate(seoScore(x.brief, x.body, strictFor(x))).reasons.some((r) => /search phrase/.test(r)), name);
});

test('dodges around the fix: list items, table cells, sub-headings, answers, link text, look-alike letters, zero-width characters, the picture description', () => {
  for (const [name, f, expected] of R3.DODGES) {
    const s = seoScore(R2.REVIEW2_BRIEF, f(), R2.REVIEW2_CONTEXT);
    const g = seoGate(s);
    if (expected === 'not caught') {
      // The known limit, kept visible: a phrase split over two different bullets is not read as one use by readers or
      // search engines, and the volume is bounded by the short-items caps.
      assert.equal(s.cap, null, name); assert.equal(g.pass, true, name);
      continue;
    }
    assert.equal(g.pass, false, name);
    if (expected === 'gate') continue;
    if (expected === 'stuffing') { assert.equal(s.cap?.kind, 'stuffing', name); assert.ok(s.measures.phraseShare > 3.5, `${name}: ${s.measures.phraseShare}`); }
    else assert.equal(s.cap?.kind, expected, `${name}: ${s.cap?.kind} ${JSON.stringify(s.measures)}`);
  }
  for (const k of [6, 7]) assert.ok(seoScore(R2.REVIEW2_BRIEF, R3.DODGES[k]![1](), R2.REVIEW2_CONTEXT).measures.phraseShare > 3.5, R3.DODGES[k]![0]);
  const alt = seoScore(R2.REVIEW2_BRIEF, R3.DODGES.find((d) => /picture description/.test(d[0]))![1](), R2.REVIEW2_CONTEXT);
  assert.equal(result(alt, 'pictures.phrase'), 'fail');
  assert.deepEqual(seoGate(alt).reasons, ['The picture description uses the search phrase more than once.']);
  // Long list items count as sentences for every reading check, starts included.
  const we = seoScore(null, mini({ intro: prose(12), sections: [{ id: 'a', heading: 'What we do', body: Array.from({ length: 12 }, (_, i) => `- We ${BANK[i]!.charAt(0).toLowerCase()}${BANK[i]!.slice(1)}`).join('\n') }] }), SITE);
  assert.equal(result(we, 'read.starts'), 'fail', check(we, 'read.starts').found);
});

test('words: invisible characters and accents are dropped, look-alike letters inside English read as Latin, Russian, Ukrainian and Greek are kept', () => {
  assert.deepEqual(words('app​raise a prop­erty⁠ deal﻿'), ['appraise', 'a', 'property', 'deal']);
  assert.deepEqual(words('app͏raise a prop️erty deㅤal a̲nd'), ['appraise', 'a', 'property', 'deal', 'and']);
  assert.deepEqual(words(R3.lookAlike('appraise a property deal')), ['appraise', 'a', 'property', 'deal']);
  assert.deepEqual(words('appraıse a prօperty deɑl, a prόperty'), ['appraise', 'a', 'property', 'deal', 'a', 'property']);
  assert.deepEqual(words('buy a ԁеаӏ now'), ['buy', 'a', 'deal', 'now'], 'a whole word of look-alikes between English words');
  // N1: real words of other languages are not rewritten into English small words ("не" is not "he", "то" not "to").
  assert.deepEqual(words('Это не то, что вы думаете, по правде'), ['это', 'не', 'то', 'что', 'вы', 'думаете', 'по', 'правде']);
  assert.deepEqual(words('Дім і сад'), ['дім', 'і', 'сад']);
  assert.deepEqual(words('Το σπίτι και ο κήπος'), ['το', 'σπιτι', 'και', 'ο', 'κηπος']);
  assert.deepEqual(words('Café naïve'), ['cafe', 'naive']);
});

// ─── The fourth review: a fixed corpus, judged in both directions ───────────────────────────────────────────────

const ctx4 = (x: G4.Art) => ({ siteHosts: [x.site], selfUrl: `${x.site}/blog/${x.body.slug}`, checkIssues: [], targetMode: true });
const BASELINE4: Record<string, Record<string, string>> = JSON.parse(readFileSync(new URL('./seo-score-review4-baseline.json', import.meta.url), 'utf8'));

test('corpus, good side: the sixteen good articles pass the gate with and without a picture and score no lower than at d4e5527', () => {
  for (const [x, withPic, without] of G4.GOOD16) {
    const s = seoScore(x.brief, x.body, ctx4(x)), n = seoScore(x.brief, R.withoutPicture(x.body), ctx4(x));
    assert.ok(s.score >= withPic && n.score >= without, `${x.name}: ${s.score}/${n.score}, was ${withPic}/${without}`);
    assert.equal(seoGate(s).pass, true, x.name); assert.equal(seoGate(n).pass, true, `${x.name} without a picture`);
  }
});

test('corpus, good side: every variant the review called undeserved passes the gate and scores no lower than at d4e5527; deserved ones keep their outcome', () => {
  for (const v of G4.VARIANTS) {
    const s = seoScore(v.art.brief, v.art.body, ctx4(v.art));
    if (!v.deserved) {
      assert.equal(seoGate(s).pass, true, `${v.art.name}: ${s.score} ${seoGate(s).reasons.join(' | ')}`);
      assert.ok(s.score >= v.base.score, `${v.art.name}: ${s.score}, was ${v.base.score}`);
    } else assert.equal(seoGate(s).pass, v.base.pass, v.art.name);
  }
  const by = (prefix: string) => { const v = G4.VARIANTS.find((x) => x.art.name.startsWith(prefix))!; return seoScore(v.art.brief, v.art.body, ctx4(v.art)); };
  assert.equal(by('3b').score, 92, 'answers opening "Yes." and "No."');
  assert.deepEqual([by('1b').score, by('1c').score], [93, 93], 'the thorough checklists');
  assert.deepEqual([by('1e').score, by('7a').score], [96, 95], 'their two points back');
  assert.equal(by('1d').cap, null, 'a job every room shares is not a pasted list');
});

test('corpus, good side: honest writing is measured check by check exactly as at d4e5527, apart from the named fixes', () => {
  // Every difference from d4e5527 on the corpus, and why. Nothing else may change.
  const expected: Record<string, Record<string, string>> = {
    '10a local page ~400 words, 4-word phrase, four usual placements': { 'phrase.use': 'pass' }, // A3: four uses are never too many
    '9a local page ~400 words, 3-word phrase, four usual placements': { 'phrase.use': 'pass' }, // B1: the on-record question is not a use
    '11a boiler service page + the sentence the report asks for': { 'phrase.use': 'pass' }, // B1
    '11b boiler service page, each question answered in a full sentence': { 'phrase.use': 'pass' }, // B1
    '1d room-by-room checklist repeating the four shared jobs in each room': { 'read.variety': 'pass' }, // C6
    '12a comparison with a pros and cons list for each floor': { 'page.subheadings': 'partly' }, // a part made only of two-word items is thin
  };
  const all: [string, G4.Art['brief'] | null, ArticleBody, Parameters<typeof seoScore>[2]][] = [
    ...G4.GOOD16.map(([x]) => [x.name, x.brief, x.body, ctx4(x)] as [string, G4.Art['brief'], ArticleBody, Parameters<typeof seoScore>[2]]),
    ...G4.VARIANTS.map((v) => [v.art.name, v.art.brief, v.art.body, ctx4(v.art)] as [string, G4.Art['brief'], ArticleBody, Parameters<typeof seoScore>[2]]),
    ...([['how-to', R.A], ['comparison', R.B], ['long guide', R.C], ['listicle', R2.L], ['recipe-style steps', R2.R], ['glossary', R2.G], ['quotes a regulation', R2.Q], ['buy page', R2.Y]] as const).map(([n, x]) => [`fixture ${n}`, x.brief, x.body, ctx4({ ...x, name: n })] as [string, G4.Art['brief'], ArticleBody, Parameters<typeof seoScore>[2]]),
    ['fixture strong', sp.brief(), sp.strongBody(), { ...SITE, targetMode: true }],
  ];
  assert.equal(all.length, Object.keys(BASELINE4).length);
  for (const [name, brief, body, ctx] of all) {
    const now = Object.fromEntries(seoScore(brief, body, ctx).checks.map((c) => [c.id, c.result]));
    assert.deepEqual(now, { ...BASELINE4[name], ...expected[name] }, name);
  }
});

test('corpus, rubbish side: every article the review found passing the gate is refused now, with and without a picture', () => {
  for (const [name, f] of RB4.RUBBISH4) for (const body of [f(), R.withoutPicture(f())]) {
    const s = seoScore(R2.REVIEW2_BRIEF, body, R2.REVIEW2_CONTEXT);
    assert.equal(seoGate(s).pass, false, `${name}: ${s.score} ${JSON.stringify(s.measures)}`);
  }
  // No row of the review's table is left as a known limit; the fluent filler of the second review still is (G1).
  assert.deepEqual(RB4.KNOWN_LIMIT4, []);
  // The earlier rounds' rubbish stays refused too.
  for (const [name, f] of [...R2.ROUND2_RUBBISH, ...R3.BULLET_ATTACKS]) assert.equal(seoGate(seoScore(R2.REVIEW2_BRIEF, f(), R2.REVIEW2_CONTEXT)).pass, false, name);
});

test('A2 different short bullets never raise a score: adding them after every part of any corpus article never lifts it or passes the gate', () => {
  const corpus: [string, G4.Art['brief'], ArticleBody, Parameters<typeof seoScore>[2]][] = [
    ...G4.GOOD16.map(([x]) => [x.name, x.brief, x.body, ctx4(x)] as [string, G4.Art['brief'], ArticleBody, Parameters<typeof seoScore>[2]]),
    ...G4.VARIANTS.map((v) => [v.art.name, v.art.brief, v.art.body, ctx4(v.art)] as [string, G4.Art['brief'], ArticleBody, Parameters<typeof seoScore>[2]]),
    ...[...GOOD, ...SHAPES].map(([n, x]) => [n, x.brief, x.body, strictFor(x)] as [string, G4.Art['brief'], ArticleBody, Parameters<typeof seoScore>[2]]),
    ['strong', R2.REVIEW2_BRIEF, sp.strongBody(), R2.REVIEW2_CONTEXT],
    ...RB4.RUBBISH4.map(([n, f]) => [n, R2.REVIEW2_BRIEF, f(), R2.REVIEW2_CONTEXT] as [string, G4.Art['brief'], ArticleBody, Parameters<typeof seoScore>[2]]),
  ];
  for (const [name, brief, body, ctx] of corpus) {
    const before = seoScore(brief, body, ctx), passed = seoGate(before).pass;
    for (const [per, size] of [[2, 1], [12, 2], [25, 3]] as const) {
      let k = 0;
      const item = () => { k++; return Array.from({ length: size }, (_, j) => `zq${k}${'abc'[j]}`).join(' '); };
      const padded = { ...body, sections: body.sections.map((x) => ({ ...x, body: `${x.body}\n\n${Array.from({ length: per }, () => `- ${item()}`).join('\n')}` })) } as ArticleBody;
      const s = seoScore(brief, padded, ctx);
      assert.ok(s.score <= before.score, `${name}, ${per} ${size}-word bullets per part: ${before.score} to ${s.score}`);
      if (!passed) assert.equal(seoGate(s).pass, false, `${name}, ${per} ${size}-word bullets per part`);
    }
  }
});

test('A3 B1 the phrase: four uses are never too many, the on-record questions are not held against the article, one-word phrases are tighter', () => {
  const W = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ');
  const filler = (n: number, seed: number) => { const out: string[] = []; for (let k = seed, left = n; left > 0; k++) { const m = Math.min(12, left); out.push(`${Array.from({ length: m }, (_, i) => (i % 3 === 0 ? ['the', 'so', 'because', 'it', 'and', 'we'][(k + i) % 6] : `${W[(k * 7 + i * 13) % W.length]}${k}${i}`)).join(' ')}.`); left -= m; } return out.join(' '); };
  const page = (phrase: string, uses: number, total: number) => {
    const use = (i: number) => `the ${W[i]}x${i} so ${W[i + 1]}y${i} ${phrase} because ${W[i + 2]}z${i} of it.`;
    const per = words(use(0)).length;
    const rest = total - uses * (per + 2);
    return mini({ seoTitle: 'A plain title of about the right length here', intro: filler(Math.floor(rest / 2), 0), conclusion: filler(rest - Math.floor(rest / 2), 50), sections: Array.from({ length: uses }, (_, i) => ({ id: `s${i}`, heading: `Part number${i}`, body: use(i) })) });
  };
  const at = (phrase: string, uses: number, total: number) => seoScore({ targetQuery: phrase, searchIntent: 'learn', relatedQuestions: [] }, page(phrase, uses, total), { ...SITE, targetMode: true });
  const refusedForPhrase = (s: SeoScore) => seoGate(s).reasons.some((r) => /search phrase/.test(r));
  // Four uses of a four-word phrase in 300 words: never too many, never refused.
  assert.equal(refusedForPhrase(at('zebra crossing sign repair', 4, 300)), false);
  assert.equal(at('zebra crossing sign repair', 4, 300).measures.phraseShare, 0);
  // Five uses there is high (refused), but under six uses it is never "stuffed" or capped at 60.
  const five = at('zebra crossing sign repair', 5, 300);
  assert.equal(refusedForPhrase(five), true); assert.notEqual(five.cap?.kind, 'stuffing'); assert.doesNotMatch(check(five, 'phrase.use').found, /stuffed/);
  assert.equal(at('zebra crossing sign repair', 6, 300).cap?.kind, 'stuffing');
  // A one-word phrase: ten uses in 600 words pass, fifteen are stuffed (fifteen passed before).
  assert.equal(refusedForPhrase(at('zebra', 10, 600)), false);
  assert.equal(refusedForPhrase(at('zebra', 11, 600)), true);
  assert.equal(at('zebra', 15, 600).cap?.kind, 'stuffing');
  // A sub-heading or question that asks a question on record is not counted against the article.
  const asked = mini({ intro: `The zebra crossing sign repair is quick. ${prose(20)}`, sections: Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, heading: `How long does a zebra crossing sign repair take in town ${i}?`, body: prose(6, i) })) });
  const qs = Array.from({ length: 6 }, (_, i) => `How long does a zebra crossing sign repair take in town ${i}?`);
  assert.ok(seoScore({ targetQuery: 'zebra crossing sign repair', relatedQuestions: qs }, asked, SITE).measures.phraseShare < seoScore({ targetQuery: 'zebra crossing sign repair', relatedQuestions: [] }, asked, SITE).measures.phraseShare);
  // C3: a noun made from the verb counts as a use, and the refusal no longer invites rewording.
  assert.ok(closeKeys('appraisal').includes('apprais') && closeKeys('valuation').includes('valu') && closeKeys('approval').includes('approv'));
  for (const s of [five, at('zebra', 11, 600)]) for (const r of seoGate(s).reasons) assert.doesNotMatch(r, /other words for the same idea/);
});

test('B2 B3 B4 C7: sub-headings inside the text, other bullet markers, run-on keyword lines, and one rounding for the list measures', () => {
  // N4: a long part split by its own "### " sub-headings is not a stretch without a sub-heading.
  const split = mini({ intro: prose(10), sections: [{ id: 'a', heading: 'A long part', body: `${prose(10)}\n\n### The first half\n\n${prose(10, 3)}\n\n### The second half\n\n${prose(10, 7)}` }] });
  assert.equal(result(seoScore(null, split, SITE), 'read.spacing'), 'pass');
  const unsplit = mini({ intro: prose(10), sections: [{ id: 'a', heading: 'A long part', body: `${prose(10)}\n\n${prose(10, 3)}\n\n${prose(10, 7)}` }] });
  assert.notEqual(result(seoScore(null, unsplit, SITE), 'read.spacing'), 'pass');
  // The article quoting a regulation keeps its long sentences (6% of its words) without a cap.
  const q = seoScore(R2.Q.brief, R2.Q.body, strictFor(R2.Q));
  assert.equal(q.measures.runOn, 6); assert.equal(q.cap, null);
  const runOn = seoScore(R2.REVIEW2_BRIEF, RB4.RUBBISH4.find(([n]) => /run-on/.test(n))![1](), R2.REVIEW2_CONTEXT);
  assert.equal(runOn.cap?.kind, 'run-on'); assert.ok(runOn.measures.runOn > 20);
  assert.match(runOn.cap!.reason, /^Some of the text runs on without a full stop for a very long way, so the score stays at 70 or below until it is written in sentences of a readable length\.$/);
  // C7: the cap follows the reported (rounded) measures exactly, everywhere in the corpus.
  const every = [...G4.GOOD16.map(([x]) => seoScore(x.brief, x.body, ctx4(x))), ...G4.VARIANTS.map((v) => seoScore(v.art.brief, v.art.body, ctx4(v.art))), ...RB4.RUBBISH4.map(([, f]) => seoScore(R2.REVIEW2_BRIEF, f(), R2.REVIEW2_CONTEXT)), ...R3.BULLET_ATTACKS.map(([, f]) => seoScore(R2.REVIEW2_BRIEF, f(), R2.REVIEW2_CONTEXT))];
  for (const s of every) {
    const heavy = s.words >= 100 && (s.measures.shortItems > 12 || s.measures.stepItems > 60);
    assert.equal(heavy, s.cap?.kind === 'short-items' || (heavy && s.cap !== null && s.cap.limit <= SOME_REPETITION_CAP), JSON.stringify(s.measures));
  }
});

test('C5 N2: a long run of spaces is quick, and odd search intents or a missing context do not throw', () => {
  const t = performance.now();
  const s = seoScore(sp.brief(), { ...sp.strongBody(), intro: `${' '.repeat(80_000)}word ${' \t'.repeat(20_000)}[src:a1] end.` }, SITE);
  assert.ok(performance.now() - t < 1000, `${(performance.now() - t).toFixed(0)} ms`);
  assert.ok(s.score >= 0 && s.score <= 100);
  for (const intent of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) assert.ok(Number.isInteger(seoScore({ ...sp.brief(), searchIntent: intent as never }, sp.strongBody(), SITE).score), intent);
  assert.ok(Number.isInteger(seoScore(sp.brief(), sp.strongBody(), null).score));
});
