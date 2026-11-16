/**
 * Our SEO score (src/seo-blog/seo-score.ts): every check passes, partly passes and fails on purpose-built input; the
 * weights add up to 100; phrase matching is fair; missing data is left out rather than guessed; it is fast and safe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MUST_FIX_CAP, readingEase, REPETITION_CAP, sentences, SEO_WEIGHTS, seoNextSteps, seoScore, syllables, type SeoCheck, type SeoScore } from '../src/seo-blog/seo-score.js';
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
  const s = seoScore(sp.brief(), fx.body(), SITE);
  assert.equal(s.checks.reduce((n, c) => n + c.weight, 0), 100, 'all 28 checks present when phrase, questions and check results exist');
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
  for (const id of ['phrase.address', 'phrase.opening', 'phrase.description', 'phrase.heading', 'phrase.use']) assert.equal(result(mixed, id), 'partly', id);
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
  const alone = seoScore(q(P), mini({ intro: `Maximum offer. ${prose(3)}`, sections: [{ id: 'a', heading: 'Maximum offer', body: `Maximum offer. ${prose(5)}` }, { id: 'b', heading: 'More', body: `Maximum offer. ${prose(5)}` }] }), SITE);
  assert.equal(result(alone, 'phrase.opening'), 'partly', 'the phrase on its own is not a sentence');
  assert.equal(result(alone, 'phrase.heading'), 'partly', 'a heading that is only the phrase');
  assert.equal(result(alone, 'phrase.use'), 'fail');
  assert.match(check(alone, 'phrase.use').found, /only appears on its own/);
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
  assert.equal(result(s({ intro: para(6000) }), 'page.length'), 'fail', 'too long');
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
  assert.equal(result(s({ intro: 'See [our coming soon page](https://www.martinhowardproperty.example/soon).' }, broken), 'links.internal'), 'partly', 'a link the checks found broken');
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
  assert.equal(result(none, 'pictures.phrase'), 'fail', 'the fixture has a description but no picture: nothing is published');
  const img = (alt: string) => ({ kind: 'brand_asset' as const, url: 'https://x.example/a.jpg', alt, provenance: '', width: null, height: null });
  assert.equal(result(seoScore(q('maximum offer'), mini({ image: img('') }), SITE), 'pictures.main'), 'partly');
  assert.equal(result(seoScore(q('maximum offer'), mini({ image: img('A house') }), SITE), 'pictures.main'), 'partly', 'too short');
  const onlyPhrase = seoScore(q('maximum offer'), mini({ image: img('Maximum offers') }), SITE);
  assert.equal(result(onlyPhrase, 'pictures.main'), 'partly'); assert.equal(result(onlyPhrase, 'pictures.phrase'), 'fail');
  assert.equal(result(seoScore(q('maximum offer'), mini({ image: img('Working out a maximum offer at a desk') }), SITE), 'pictures.phrase'), 'pass');
  assert.equal(result(seoScore(q('maximum offer'), mini({ image: img('The offer, at its maximum, on paper') }), SITE), 'pictures.phrase'), 'partly');
  assert.equal(result(seoScore(q('maximum offer'), mini({ image: img('A terraced house on a street') }), SITE), 'pictures.phrase'), 'fail');
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
  assert.equal(result(s({ intro: 'The cat sat on the warm mat. The dog ran across the wide park. The bird sang in the old tree. A fox hid under the shed.' }), 'read.starts'), 'partly');
  assert.equal(result(s({ intro: 'The cat sat on the mat. The dog ran in the park. The bird sang in the tree. A fox hid. The x went. The y came. The z left.' }), 'read.starts'), 'fail');
  assert.equal(result(s({ intro: prose(20) }), 'read.starts'), 'pass');
  const theHeavy = BANK.slice(0, 12).map((x, i) => (i % 4 === 0 ? `The ${x.charAt(0).toLowerCase()}${x.slice(1)}` : x)).join(' ');
  assert.equal(result(s({ intro: theHeavy }), 'read.starts'), 'partly', 'one word starts over 15% of sentences, never three in a row');
  assert.equal(result(s({ intro: '- The one\n- The two\n- The three' }), 'read.starts'), 'fail', 'no prose sentences at all');
  assert.equal(result(s({ intro: prose(20) }), 'read.linking'), 'pass', check(s({ intro: prose(20) }), 'read.linking').found);
  assert.equal(result(s({ intro: 'It rains, so we stay. Because it is cold, we sit inside. For example, tea helps. Cats nap.' }), 'read.linking'), 'partly', 'above 60%');
  assert.equal(result(s({ intro: 'So it rains today. But we stay inside. Then we read books. So we nap later. But cats nap too.' }), 'read.linking'), 'fail', 'every sentence starts with one');
  assert.equal(result(s({ intro: 'Cats nap all day. Dogs bark at night. Birds sing in spring. Fish swim upstream. Cows moo loudly.' }), 'read.linking'), 'fail');
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
  assert.match(held.cap!.reason, /fixing before it goes out/);
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
  assert.equal(n.to, Math.round(((s.earned + gains.reduce((a, b) => a + b, 0)) * 100) / s.available));
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
