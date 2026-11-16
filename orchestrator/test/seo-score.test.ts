/**
 * Our SEO score (src/seo-blog/seo-score.ts): every check passes, partly passes and fails on purpose-built input; the
 * weights add up to 100; phrase matching is fair; missing data is left out rather than guessed; it is fast and safe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readingEase, sentences, SEO_WEIGHTS, seoScore, syllables, type SeoCheck, type SeoScore } from '../src/seo-blog/seo-score.js';
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

test('the weights add up to 100, and every check in a full report carries its documented weight', () => {
  assert.equal(Object.values(SEO_WEIGHTS).reduce((a, b) => a + b, 0), 100);
  const s = seoScore(sp.brief(), fx.body(), SITE);
  assert.equal(s.checks.reduce((n, c) => n + c.weight, 0), 100, 'all 28 checks present when phrase, questions and check results exist');
  assert.equal(s.checks.length, Object.keys(SEO_WEIGHTS).length);
  assert.deepEqual(s.parts.map((p) => [p.label, p.weight]), [['Search', 60], ['Easy to read', 25], ['Answers the searcher', 15]]);
  assert.ok(Number.isInteger(s.score) && s.score >= 0 && s.score <= 100);
  // Failures first, then partly, then passes.
  const rank = { fail: 0, partly: 1, pass: 2 } as const;
  for (let i = 1; i < s.checks.length; i++) assert.ok(rank[s.checks[i - 1]!.result] <= rank[s.checks[i]!.result]);
  for (const c of s.checks) { assert.equal(c.result === 'pass', c.todo === null); assert.equal(c.points, c.result === 'pass' ? c.weight : c.result === 'partly' ? c.weight / 2 : 0); }
});

test('phrase matching: case, punctuation and word order; plurals, apostrophes and words inside words are not stretched', () => {
  const t = (title: string, phrase: string) => result(seoScore(q(phrase), mini({ seoTitle: title }), SITE), 'phrase.title');
  assert.equal(t('BUY-TO-LET Mortgages: a guide', 'buy to let mortgages'), 'pass', 'case and hyphens');
  assert.equal(t('Mortgages for buy to let, explained', 'buy to let mortgages'), 'partly', 'all words close together, different order');
  assert.equal(t('Buy to let mortgage guide', 'buy to let mortgages'), 'fail', 'singular is not the plural');
  assert.equal(t('A landlord’s guide to deposits', "landlord's guide"), 'pass', 'curly and straight apostrophes are the same');
  assert.equal(t('Landlords guide to deposits', "landlord's guide"), 'fail', 'landlords is not landlord’s');
  assert.equal(t('Write a better letter', 'let'), 'fail', 'not inside a longer word');
  assert.equal(t('Property: the deal, appraised.', 'property deal'), 'partly', 'punctuation separates but words stay close');
  assert.equal(t('Property values rise as interest rates fall and a deal is hard to find', 'property deal'), 'fail', 'too far apart');
});

test('the search phrase checks: title, start of title, description, address, opening, sub-heading and sensible use', () => {
  const P = 'maximum offer';
  const good = mini({ seoTitle: 'Maximum offer: how to work it out for a property', metaDescription: 'Work out your maximum offer on a property with this simple method, step by step, before you speak to the agent.', slug: 'maximum-offer',
    intro: 'Your maximum offer is the most you should pay. '.repeat(1) + para(60), sections: [{ id: 's1', heading: 'Your maximum offer', body: para(300) }], conclusion: 'Know your maximum offer.' });
  const s = seoScore(q(P), good, SITE);
  for (const id of ['phrase.title', 'phrase.title_start', 'phrase.description', 'phrase.address', 'phrase.opening', 'phrase.heading', 'phrase.use']) assert.equal(result(s, id), 'pass', id);
  const late = seoScore(q(P), mini({ seoTitle: 'A long guide to property, written plainly: your maximum offer' }), SITE);
  assert.equal(result(late, 'phrase.title_start'), 'partly');
  const none = seoScore(q(P), mini({ seoTitle: 'Property', intro: 'Hello there.', slug: 'property', metaDescription: 'Nothing.' }), SITE);
  for (const id of ['phrase.title', 'phrase.title_start', 'phrase.description', 'phrase.address', 'phrase.opening', 'phrase.heading', 'phrase.use']) assert.equal(result(none, id), 'fail', id);
  const mixed = seoScore(q(P), mini({ slug: 'offer-maximum', intro: 'The offer you make, at its maximum, matters.', metaDescription: 'Your offer, at its maximum.', sections: [{ id: 'a', heading: 'Offer: the maximum', body: 'x' }] }), SITE);
  for (const id of ['phrase.address', 'phrase.opening', 'phrase.description', 'phrase.heading', 'phrase.use']) assert.equal(result(mixed, id), 'partly', id);
  // Sensible use: once is partly; stuffing fails.
  assert.equal(result(seoScore(q(P), mini({ intro: `maximum offer ${para(200)}` }), SITE), 'phrase.use'), 'partly');
  assert.equal(result(seoScore(q(P), mini({ intro: 'maximum offer is a maximum offer and a maximum offer. '.repeat(10) }), SITE), 'phrase.use'), 'fail');
  assert.match(check(seoScore(q(P), mini({ intro: 'maximum offer is a maximum offer and a maximum offer. '.repeat(10) }), SITE), 'phrase.use').found, /stuffed/);
});

test('the page checks: lengths graded thin, fine and strong; sub-headings; questions and answers', () => {
  const s = (o: Partial<ArticleBody>) => seoScore(null, mini(o), SITE);
  assert.equal(result(s({ seoTitle: 'x'.repeat(50) }), 'page.title_length'), 'pass');
  assert.equal(result(s({ seoTitle: 'x'.repeat(80) }), 'page.title_length'), 'partly');
  assert.equal(result(s({ seoTitle: '' }), 'page.title_length'), 'fail');
  assert.equal(result(s({ metaDescription: 'x'.repeat(120) }), 'page.description_length'), 'pass');
  assert.equal(result(s({ metaDescription: 'x'.repeat(40) }), 'page.description_length'), 'partly');
  assert.equal(result(s({}), 'page.description_length'), 'fail');
  assert.equal(result(s({ slug: 'short-one' }), 'page.address_length'), 'pass');
  assert.equal(result(s({ slug: 'x'.repeat(70) }), 'page.address_length'), 'partly');
  assert.equal(result(s({ slug: '' }), 'page.address_length'), 'fail');
  assert.equal(check(s({ intro: para(300) }), 'page.length').found, '300 words: thin.');
  assert.equal(result(s({ intro: para(300) }), 'page.length'), 'fail');
  assert.equal(result(s({ intro: para(700) }), 'page.length'), 'partly');
  assert.equal(result(s({ intro: para(1300) }), 'page.length'), 'pass');
  const parts = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `${i}`, heading: `Part ${i}`, body: 'x' }));
  assert.equal(result(s({ sections: parts(3) }), 'page.subheadings'), 'pass');
  assert.equal(result(s({ sections: parts(1) }), 'page.subheadings'), 'partly');
  assert.equal(result(s({}), 'page.subheadings'), 'fail');
  const faqs = (n: number) => Array.from({ length: n }, (_, i) => ({ q: `Question ${i}?`, a: 'Answer.' }));
  assert.equal(result(s({ faqs: faqs(3) }), 'page.questions'), 'pass');
  assert.equal(result(s({ faqs: faqs(1) }), 'page.questions'), 'partly');
  assert.equal(result(s({}), 'page.questions'), 'fail');
});

test('links: own site in the text passes, only the end button is partly; shown sources pass, research-only sources are partly', () => {
  const s = (o: Partial<ArticleBody>, hosts = SITE.siteHosts) => seoScore(null, mini(o), { siteHosts: hosts });
  assert.equal(result(s({ intro: 'See [our services](https://martinhowardproperty.example/services).' }), 'links.internal'), 'pass', 'www and no www are the same site');
  assert.equal(result(s({ cta: { label: 'Book', url: 'https://www.martinhowardproperty.example/contact' } }), 'links.internal'), 'partly');
  assert.equal(result(s({ intro: 'See [GOV.UK](https://www.gov.uk/x).' }), 'links.internal'), 'fail');
  assert.match(check(s({}, []), 'links.internal').found, /do not know your website address/);
  assert.equal(result(s({ intro: 'See [GOV.UK](https://www.gov.uk/x).' }), 'links.sources'), 'pass');
  const cite = (pub: boolean) => [{ sourceId: 'a', url: 'https://www.gov.uk', title: 'G', retrievedAt: '2026-01-01', passage: '', public: pub }];
  assert.equal(result(s({ citations: cite(true) as never }), 'links.sources'), 'pass');
  assert.equal(result(s({ citations: cite(false) as never }), 'links.sources'), 'partly');
  assert.equal(result(s({}), 'links.sources'), 'fail');
});

test('pictures: no picture is a clear fail with what to do; a picture without a description is partly; inside the text is honestly not possible yet', () => {
  const none = seoScore(q('maximum offer'), fx.body(), SITE);
  assert.equal(result(none, 'pictures.main'), 'fail');
  assert.equal(check(none, 'pictures.main').fix, 'picture');
  assert.match(check(none, 'pictures.main').todo!, /Add a picture/);
  assert.equal(result(none, 'pictures.phrase'), 'fail', 'the fixture has a description but no picture: nothing is published');
  const img = (alt: string) => ({ kind: 'brand_asset' as const, url: 'https://x.example/a.jpg', alt, provenance: '', width: null, height: null });
  assert.equal(result(seoScore(q('maximum offer'), mini({ image: img('') }), SITE), 'pictures.main'), 'partly');
  assert.equal(result(seoScore(q('maximum offer'), mini({ image: img('Working out a maximum offer at a desk') }), SITE), 'pictures.phrase'), 'pass');
  assert.equal(result(seoScore(q('maximum offer'), mini({ image: img('The offer, at its maximum, on paper') }), SITE), 'pictures.phrase'), 'partly');
  assert.equal(result(seoScore(q('maximum offer'), mini({ image: img('A terraced house') }), SITE), 'pictures.phrase'), 'fail');
  const inline = check(none, 'pictures.inline');
  assert.equal(inline.result, 'fail'); assert.equal(inline.fix, null); assert.match(inline.found, /cannot hold pictures inside the text yet/);
});

test('easy to read: sentence length, paragraph length, sub-heading spacing, reading ease, sentence starts and linking words', () => {
  const s = (o: Partial<ArticleBody>) => seoScore(null, mini(o), SITE);
  const short = 'The cat sat. The dog ran. A bird sang. ';
  assert.equal(result(s({ intro: short.repeat(5) }), 'read.sentences'), 'pass');
  assert.equal(result(s({ intro: `${para(25)}. ${short}` }), 'read.sentences'), 'pass', '1 sentence in 4 over 20 words is fine');
  assert.equal(result(s({ intro: `${para(25)}. The cat sat. The dog ran.` }), 'read.sentences'), 'partly', '1 in 3');
  assert.equal(result(s({ intro: `${para(25)}. ${para(25)}. Short one.` }), 'read.sentences'), 'fail');
  assert.equal(result(s({ intro: `${para(100)}.` }), 'read.paragraphs'), 'pass');
  assert.equal(result(s({ intro: `${para(200)}.` }), 'read.paragraphs'), 'partly');
  assert.equal(result(s({ intro: `${para(200)}.\n\n${para(200)}.\n\n${para(200)}.` }), 'read.paragraphs'), 'fail');
  assert.equal(result(s({ intro: para(200), sections: [{ id: 'a', heading: 'A', body: para(250) }] }), 'read.spacing'), 'pass');
  assert.equal(result(s({ intro: para(350) }), 'read.spacing'), 'partly');
  assert.equal(result(s({ intro: para(500) }), 'read.spacing'), 'fail');
  assert.equal(check(s({ sections: [{ id: 'a', heading: 'A', body: para(200) }], conclusion: para(150) }), 'read.spacing').result, 'partly', 'the closing paragraph runs on from the last part');
  assert.equal(result(s({ intro: short.repeat(10) }), 'read.ease'), 'pass');
  assert.equal(result(s({ intro: 'Comprehensive institutional diversification necessitates considerable organisational responsibility. '.repeat(8) }), 'read.ease'), 'fail');
  assert.equal(result(s({ intro: 'Hi.' }), 'read.ease'), 'fail', 'too little text');
  assert.equal(result(s({ intro: 'The cat sat. The dog ran. The bird sang. A fox hid.' }), 'read.starts'), 'partly');
  assert.equal(result(s({ intro: 'The cat sat. The dog ran. The bird sang. A fox hid. The x. The y. The z.' }), 'read.starts'), 'fail');
  assert.equal(result(s({ intro: short.replace(/The dog/, 'One dog') }), 'read.starts'), 'pass');
  assert.equal(result(s({ intro: '- The one\n- The two\n- The three' }), 'read.starts'), 'pass', 'list items may start alike');
  assert.equal(result(s({ intro: 'It rains, so we stay. Because it is cold, we sit. For example, tea. Cats nap.' }), 'read.linking'), 'pass');
  assert.equal(result(s({ intro: 'It rains, so we stay. Cats nap. Dogs bark. Birds sing.' }), 'read.linking'), 'partly');
  assert.equal(result(s({ intro: 'Cats nap. Dogs bark. Birds sing. Fish swim. Cows moo.' }), 'read.linking'), 'fail');
  assert.equal(result(s({ intro: 'So be it.' }), 'read.linking'), 'pass', 'a linking word at the start counts');
});

test('reading ease is the proper Flesch formula with a sensible syllable estimate; sentences split sensibly', () => {
  const known: [string, number][] = [['the', 1], ['cat', 1], ['make', 1], ['makes', 1], ['table', 2], ['jumped', 1], ['wanted', 2], ['boxes', 2], ['people', 2], ['property', 3], ['appraise', 2], ['refurbishment', 4], ['investment', 3]];
  for (const [w, n] of known) assert.equal(syllables(w), n, w);
  // 30 words in 10 sentences of one-syllable words: 206.835 - 1.015*3 - 84.6*1 = 119.19.
  const ease = readingEase(Array.from({ length: 10 }, () => 'The cat sat.'));
  assert.ok(Math.abs(ease! - 119.19) < 0.01, String(ease));
  assert.equal(readingEase(['Too short.']), null);
  assert.deepEqual(sentences('Use e.g. this one. It costs £1.5m! Then what? Done'), ['Use e.g. this one.', 'It costs £1.5m!', 'Then what?', 'Done']);
  assert.deepEqual(sentences('He said “stop.” Then he left.'), ['He said “stop.”', 'Then he left.']);
});

test('answers the searcher: related questions, the opening gets to the point, a next step, and figures from the existing checks', () => {
  const b = mini({ sections: [{ id: 'a', heading: 'How long does an appraisal take?', body: 'x' }], faqs: [{ q: 'What contingency should I allow?', a: 'Ten per cent.' }] });
  const s = (qs: string[], o = b, ctx = SITE) => seoScore(q('maximum offer', qs), o, ctx);
  assert.equal(result(s(['How long does a property appraisal take?', 'What contingency should I allow for works?']), 'answers.questions'), 'pass');
  assert.equal(result(s(['How long does an appraisal take?', 'Is stamp duty due on a second home?']), 'answers.questions'), 'partly');
  const missing = check(s(['Is stamp duty due on a second home?']), 'answers.questions');
  assert.equal(missing.result, 'fail'); assert.match(missing.found, /Not yet: “Is stamp duty due on a second home\?”/);
  assert.ok(!s([]).checks.some((c) => c.id === 'answers.questions'), 'no questions on record: left out');
  assert.ok(s([]).leftOut.some((x) => /questions people ask/.test(x)));
  assert.equal(result(s([], mini({ intro: `Your maximum offer is simple. ${para(80)}` })), 'answers.opening'), 'pass');
  assert.equal(result(s([], mini({ intro: `${para(70)} maximum offer.` })), 'answers.opening'), 'partly');
  assert.equal(result(s([], mini({ intro: para(70) })), 'answers.opening'), 'fail');
  assert.equal(result(s([], mini({ cta: { label: 'Book a call', url: 'https://www.martinhowardproperty.example/call' } })), 'answers.next_step'), 'pass');
  assert.equal(result(s([], mini({ cta: { label: 'Book', url: 'javascript:alert(1)' } })), 'answers.next_step'), 'fail');
  assert.equal(result(s([], mini()), 'answers.next_step'), 'fail');
  assert.equal(result(s([], mini(), { ...SITE, checkIssues: [{ code: 'facts.unsupported_figure' }] }), 'answers.figures'), 'fail');
  assert.equal(result(s([], mini(), { ...SITE, checkIssues: [{ code: 'facts.figure_not_in_source' }, { code: 'voice.cliche' }] }), 'answers.figures'), 'fail');
  assert.equal(result(s([], mini(), { ...SITE, checkIssues: [{ code: 'voice.cliche' }] }), 'answers.figures'), 'pass');
  const notRun = s([], mini(), { siteHosts: SITE.siteHosts, checkIssues: null as never });
  assert.ok(!notRun.checks.some((c) => c.id === 'answers.figures')); assert.ok(notRun.leftOut.some((x) => /figure/.test(x)));
});

test('a missing brief or an empty phrase scores the rest without crashing, and says what was left out', () => {
  for (const brief of [null, undefined, q(''), q('   '), q('!!! ???')]) {
    const s = seoScore(brief as never, fx.body(), SITE);
    assert.equal(s.phrase, null);
    assert.ok(!s.checks.some((c) => c.id.startsWith('phrase.') || c.id === 'pictures.phrase' || c.id === 'answers.opening'));
    assert.equal(s.checks.reduce((n, c) => n + c.weight, 0), 100 - 30 - 5, 'phrase checks (30) and questions (5) are left out');
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
  assert.ok(!strong.checks.some((c) => c.result === 'fail' && c.id !== 'pictures.inline'));
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
