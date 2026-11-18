/**
 * Release 8, third fix round: one test per item of the second independent review (P1-P3, S1, S3-S6, N5) and its five
 * mutation survivors. Each failed before its fix and passes after. Namespace imports, so a function that did not exist
 * before fails its own test only. Fakes only: no live calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/portal/seo-blog-seo-panel.js';
import * as Sc from '../src/seo-blog/seo-score.js';
import * as SR from '../src/seo-blog/search-requirements.js';
import { loadPrompt } from '../src/stages/prompt.js';
import * as Ch from '../src/seo-blog/checks.js';
import * as F from './seo-blog-writer-requirements-fixtures.js';
import type { ArticleBrief, ArticleVersion } from '../src/seo-blog/types.js';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const Panel = P as Any;
const S = Sc as Any;

// ─── Panel fixtures (the reviewer's scripts/panel.ts) ────────────────────────

const PHRASE = 'tenancy deposit protection';
const QUESTION = 'how does tenancy deposit protection work for landlords';
const panelBody: Any = {
  title: 'How deposits work', seoTitle: 'Tenancy deposit protection: a plain guide for landlords', metaDescription: 'Tenancy deposit protection explained for private landlords: what to do and when.', excerpt: 'x', slug: 'tenancy-deposit-protection',
  intro: 'Tenancy deposit protection is the first legal step after a let begins. Landlords protect the deposit with an approved scheme.',
  sections: [{ id: 's1', heading: 'How it works', body: 'Landlords keep records and check the scheme paperwork early so the process stays calm.' }],
  conclusion: 'See the plans.', cta: null, faqs: [], citations: [], image: { kind: 'none', url: null, alt: 'x', provenance: '', width: null, height: null }, author: null,
};
const seoOf = (o: Any = {}, rest: Any = {}) => ({ schema: 2, primary: { phrase: PHRASE, searches: 2400, basis: 'measured', candidateId: 'k', parent: null, ...o }, secondary: [], questions: [], ...rest });
const panelBase: Any = { targetQuery: QUESTION, relatedQuestions: [], searchIntent: 'learn', demand: { kind: 'measured', volume: 2400, retrievedAt: '2026-11-02T10:00:00.000Z' } };
const brand: Any = { id: 'b', website: 'https://harbour.example', name: 'Harbour' };
const dataFor = (brief: Any): Any => ({ article: { id: 'a', checks: null, publishedUrl: null, briefId: 'b' }, articleBrief: brief, destinations: [] });
const visible = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
let vn = 0;
const versionOf = (body: Any = panelBody, generation: Any = null): ArticleVersion => ({ id: `v-${++vn}`, body, generation } as Any);
/** The phrase the aim card names, the phrase the demand card names and the phrase the Google-title check judges. */
function namedPhrases(brief: Any, v: ArticleVersion = versionOf()) {
  const d = dataFor(brief);
  const html = visible(P.seoPanel({ brand }, d, v, true));
  const aim = /The search phrase(.*?)What the searcher wants/.exec(html)?.[1]?.trim() ?? null;
  const demand = /searches a month in Google for(.*?)Measured on/.exec(html)?.[1]?.trim() ?? null;
  const check = P.articleSeoScore(brand, d, v).checks.find((c) => c.id === 'phrase.title')?.found ?? null;
  return { aim, demand, check };
}

// ─── P1 and the foundation's demand-card throw ───────────────────────────────

test('P1: the aim card, the demand card and the score name one phrase: the measured target when the brief has one', () => {
  const r = namedPhrases({ ...panelBase, seo: seoOf() });
  assert.equal(r.aim, PHRASE);
  assert.equal(r.demand, PHRASE);
  assert.match(r.check!, new RegExp(`“${PHRASE}”`));
  assert.equal(Panel.panelPhrase({ ...panelBase, seo: seoOf({ phrase: '  tenancy deposit protection  ' }) }), PHRASE);
  // A brief without a measured target: the question, everywhere.
  const plain = namedPhrases(panelBase);
  assert.equal(plain.aim, QUESTION);
  assert.equal(plain.demand, QUESTION);
});

test('P1: no brief shape throws on the article page, and schema-1, observed and damaged briefs name and score the question', () => {
  const shapes: Record<string, Any> = {
    'seo {}': { ...panelBase, seo: {} },
    'primary null': { ...panelBase, seo: { schema: 2, primary: null } },
    'primary a string': { ...panelBase, seo: { schema: 2, primary: 'x' } },
    'seo a string': { ...panelBase, seo: 'x' },
    'seo a number': { ...panelBase, seo: 7 },
    'seo an array': { ...panelBase, seo: [] },
    'schema 1': { ...panelBase, seo: { ...seoOf(), schema: 1 } },
    'basis observed': { ...panelBase, seo: seoOf({ basis: 'observed' }) },
    'basis none': { ...panelBase, seo: seoOf({ basis: 'none', candidateId: null }) },
    'phrase a number': { ...panelBase, seo: seoOf({ phrase: 42 }) },
    'phrase blank': { ...panelBase, seo: seoOf({ phrase: '   ' }) },
    'no candidate id': { ...panelBase, seo: seoOf({ candidateId: null }) },
    'targetQuery a number': { ...panelBase, targetQuery: 5, seo: {} },
  };
  for (const [name, brief] of Object.entries(shapes)) {
    let r: ReturnType<typeof namedPhrases> | undefined;
    assert.doesNotThrow(() => { r = namedPhrases(brief); }, name);
    assert.doesNotThrow(() => P.seoSummaryLine({ brand }, dataFor(brief), versionOf()), name);
    if (name === 'targetQuery a number') { assert.equal(r!.demand, ''); continue; }
    assert.equal(r!.aim, QUESTION, name);
    assert.equal(r!.demand, QUESTION, name);
    assert.match(r!.check!, /how does tenancy deposit protection work/, name);
  }
  // No brief at all.
  assert.doesNotThrow(() => P.seoPanel({ brand }, dataFor(null), versionOf(), true));
  assert.equal(Panel.panelPhrase(null), '');
  assert.equal(Panel.panelPhrase('x' as unknown as ArticleBrief), '');
});

// ─── S6: the panel scores the phrase the writer was given ────────────────────

const block = (o: Any = {}): Any => ({ primary_phrase: PHRASE, natural_variants: [], secondary_phrases: [], questions_to_answer: [], topics_top_results_cover: [],
  length: { min_words: 1100, max_words: 1800, basis: 'length_preference' }, phrase_use_limit: 4, internal_links: [], ...o });
const genWith = (extra: Any): Any => ({ mode: 'simulated', model: 'm', promptVersion: 'p', tokensIn: 0, tokensOut: 0, ...extra });

test('S6: a version written with the search block is named and scored by that block\'s phrase; a recorded fallback by the question the writer was given', () => {
  // The brief's stored target differs from what the version was written with (the block is the record of what was sent).
  const brief = { ...panelBase, seo: seoOf({ phrase: 'landlord tax advice' }) };
  const written = namedPhrases(brief, versionOf(panelBody, genWith({ searchDraft: { schema: 1, requirementsSha: 'x', requirements: block() } })));
  assert.equal(written.aim, PHRASE);
  assert.match(written.check!, new RegExp(`uses “${PHRASE}”`));
  // The measured number belongs to the brief's phrase, so the demand card keeps naming that one.
  assert.equal(written.demand, 'landlord tax advice');
  // The reviewer's case: the phrase names an exclusion, the writer fell back to the original prompt (the question).
  for (const reason of ['phrase_dropped', 'switch_off', 'damaged', 'error']) {
    const fell = namedPhrases(brief, versionOf(panelBody, genWith({ searchFallback: { schema: 1, reason } })));
    assert.equal(fell.aim, QUESTION, reason);
    assert.doesNotMatch(fell.check!, /landlord tax advice/, reason);
    assert.match(fell.check!, /how does tenancy deposit protection work/, reason);
  }
  // No record either way (an owner edit, an older version): the brief's phrase, as in P1.
  assert.equal(namedPhrases(brief, versionOf(panelBody, null)).aim, 'landlord tax advice');
});

test('S6: a damaged generation record never throws and is read as no record', () => {
  const brief = { ...panelBase, seo: seoOf() };
  for (const generation of ['x', 5, [], { searchDraft: 'x' }, { searchDraft: { requirements: null } }, { searchDraft: { requirements: { primary_phrase: 3 } } }, { searchDraft: { requirements: block({ questions_to_answer: 'x' }) } }, { searchFallback: 'x' }]) {
    let r: ReturnType<typeof namedPhrases> | undefined;
    assert.doesNotThrow(() => { r = namedPhrases(brief, versionOf(panelBody, generation)); }, JSON.stringify(generation));
    assert.equal(r!.aim, PHRASE, JSON.stringify(generation));
  }
});

// ─── P2: the block's questions are on record for the final score ─────────────

test('P2: an article that uses the block\'s questions word for word as FAQ questions is not refused for the phrase in most sub-headings', () => {
  // The reviewer's b4c case: standard length, four sections, every question asked verbatim within the use limit.
  const phrase = 'boiler service';
  const questions = ['how long does X last', 'what is X', 'who pays for X', 'when did X start'].map((q) => q.replace('X', phrase));
  const r = block({ primary_phrase: phrase, questions_to_answer: questions, phrase_use_limit: 6 });
  const filler = 'People often keep clear records because careful paperwork helps everyone understand what happened during the work and when each step took place.';
  const para = (n: number) => Array.from({ length: n }, () => filler).join(' ');
  const body: Any = { ...panelBody, seoTitle: `${phrase}: a plain guide`, metaDescription: `The ${phrase} explained in plain words: what to do, when to do it and how to stay organised.`,
    intro: `This guide explains ${phrase} in plain words. ${para(3)}`,
    sections: ['How boiler service works', 'Common mistakes', 'What to do next', 'Where to get help'].map((heading, i) => ({ id: `s${i}`, heading, body: para(12) })),
    faqs: questions.map((q) => ({ q: `${q[0]!.toUpperCase()}${q.slice(1)}?`, a: para(2) })), conclusion: para(2) };
  const brief = { ...panelBase, targetQuery: `how does ${phrase} work in practice`, relatedQuestions: ['What should an owner check first?'], seo: seoOf({ phrase }) };
  const d = dataFor(brief);
  const v = versionOf(body, genWith({ searchDraft: { schema: 1, requirementsSha: 'x', requirements: r } }));
  const s = P.articleSeoScore(brand, d, v);
  const gate = S.seoGate(s);
  assert.deepEqual(gate.reasons.filter((x: string) => /search phrase/i.test(x)), [], JSON.stringify(s.measures));
  // The block's questions are shown as on record, after the brief's own, without repeats.
  assert.deepEqual(Panel.questionsOnRecord(brief, v), ['What should an owner check first?', ...questions]);
  assert.deepEqual(Panel.questionsOnRecord({ ...brief, relatedQuestions: ['Who pays for boiler service?'] }, v), ['Who pays for boiler service?', ...questions.filter((q) => q !== 'who pays for boiler service')]);
  // Without the block on the version the brief's own questions only, exactly as before.
  assert.deepEqual(Panel.questionsOnRecord(brief, versionOf(body, null)), ['What should an owner check first?']);
  assert.match(visible(P.seoPanel({ brand }, d, v, true)), /when did boiler service start/);
});

test('P2: prompt v2 asks for the phrase inside a full sentence in a second part of the article, besides the intro', () => {
  const v2 = loadPrompt('seo-blog-article-v2.md').body;
  assert.match(v2, /besides the intro, in a full sentence in one other part \(a section or the conclusion\)/);
});

// ─── S5: the use limit counts the phrase's words as the score does ───────────

test('S5: phrase_use_limit counts "best", "uk" and years as the score does, so an article at the limit is never "a little high"', () => {
  const phrase = 'best combi boiler uk 2026';
  // Five main words for the score: about 2% of 1,100 words is 22 word-uses, so four uses (it was six from two words).
  assert.equal(SR.phraseUseLimit(phrase, 1100, 'standard'), 4);
  for (const p of [phrase, 'boiler service cost uk', 'best landlord insurance for student lets', 'conveyancing', PHRASE]) {
    for (const length of ['concise', 'standard', 'in-depth'] as const) {
      const min = SR.LENGTH_RANGE[length].min;
      const limit = SR.phraseUseLimit(p, min, length);
      // The share the score computes at exactly `limit` uses (it counts a share only above four uses).
      const share = limit > 4 ? Math.round((limit * S.phraseWeight(p) * 1000) / min) / 10 : 0;
      assert.ok(share <= S.PHRASE_HIGH, `${p} ${length}: ${limit} uses is ${share}%`);
    }
  }
  // The reviewer's case end to end: reworded questions, every use spent in the body, at the band's minimum length.
  const r = SR.searchRequirements({ brief: { outline: [], internalLinks: [], seo: seoOf({ phrase }) } as Any, pages: [], length: 'standard', linkable: [], exclusions: [] })!;
  const filler = 'People often keep clear records because careful paperwork helps everyone understand what happened and when each step took place.';
  const para = (n: number) => Array.from({ length: n }, () => filler).join(' ');
  let uses = 0;
  const use = () => (uses++ < r.phrase_use_limit ? ` Many owners ask about the ${phrase} at this point in the process.` : '');
  const body: Any = { ...panelBody, seoTitle: `${phrase}: a plain guide`, metaDescription: `The ${phrase} explained in plain words: what to look for, what to ask and how to choose well.`,
    intro: `This guide explains the ${phrase} in plain words for owners.${(uses++, '')} ${para(3)}`,
    sections: ['What it covers', 'Common mistakes', 'What to do next', 'Where to get help'].map((heading, i) => ({ id: `s${i}`, heading, body: `${para(12)}${use()}${i === 0 ? use() : ''}` })),
    faqs: ['What else is worth checking?', 'Who should be told?', 'When does it end?', 'What does it cost?'].map((q) => ({ q, a: para(2) })), conclusion: para(2) };
  const brief = { ...panelBase, targetQuery: `which ${phrase} should I buy`, seo: seoOf({ phrase }) };
  const s = P.articleSeoScore(brand, dataFor(brief), versionOf(body, genWith({ searchDraft: { schema: 1, requirementsSha: 'x', requirements: r } })));
  assert.ok(s.measures.phraseShare <= S.PHRASE_HIGH, `share ${s.measures.phraseShare}%`);
  assert.deepEqual(S.seoGate(s).reasons.filter((x: string) => /more often/i.test(x)), []);
});

// ─── P3: honest Google titles and descriptions are not refused ───────────────

const OPT_PROSE = 'You must protect the deposit within 30 days of getting it [src:S1]. The Compliance Plan costs £49 per month. Deposits are capped at 5 weeks of rent [src:S2]. Rules changed in 2019. Around 10,000 landlords were fined, and the average award was £1,200. There are four schemes to compare. Landlords in England and Wales use one of them. An AST is the usual tenancy, and many homeowners let rooms. Some flat roofs use EPDM.';
const optCtx = { phrase: PHRASE, proseText: OPT_PROSE, exclusions: ['Tax advice'], brandName: 'Harbour Lettings', takenTitles: ['Tenancy deposit protection: our earlier guide'] };

test('P3: figures the article states (grouped with commas, or spelled as words), abbreviations it uses and the phrase\'s own words pass', () => {
  for (const [label, title, ctx] of [
    ['grouped figure', 'Tenancy deposit protection: why 10,000 landlords were fined', optCtx],
    ['grouped money', 'Tenancy deposit protection: the £1,200 average award', optCtx],
    ['digit for a spelled number', 'Tenancy deposit protection: 4 schemes compared', optCtx],
    ['word for a digit', 'Tenancy deposit protection: five weeks of rent at most', optCtx],
    ['pronoun "one"', 'Tenancy deposit protection: how to choose one', { ...optCtx, proseText: 'Landlords compare the schemes.' }],
    ['abbreviation the article uses', 'Tenancy deposit protection and EPDM flat roofs', optCtx],
    ['plural of an abbreviation the article uses', 'Tenancy deposit protection for ASTs explained', optCtx],
    ['FAQs', 'Tenancy deposit protection FAQs for landlords', optCtx],
    ['Title Case word the article uses in the plural', 'Tenancy deposit protection: a Homeowner’s guide', optCtx],
    ['phrase with "best"', 'Best landlord insurance: best practice when you compare', { ...optCtx, phrase: 'best landlord insurance', proseText: 'Best landlord insurance depends on cover. Compare what is included.' }],
    ['phrase with "scams"', 'Rental scams: how to spot them early', { ...optCtx, phrase: 'rental scams', proseText: 'Rental scams are common. Spot them early.' }],
    ['phrase with an abbreviation', 'UPVC windows cost: a homeowner guide', { ...optCtx, phrase: 'upvc windows cost', proseText: 'Windows cost more when large. A homeowner guide.' }],
    ['phrase with a domain', 'Booking.com fees for hosts explained', { ...optCtx, phrase: 'booking.com fees for hosts', proseText: 'Fees for hosts vary.' }],
    ['a place the article names', 'Tenancy deposit protection in Leeds: what landlords do', { ...optCtx, proseText: `${OPT_PROSE} Most of our landlords are in Leeds.` }],
  ] as const) assert.deepEqual(SR.optionProblems(title, 'title', ctx as Any), [], label);
  assert.deepEqual(SR.optionProblems('Tenancy deposit protection explained: 10,000 landlords fined and awards of £1,200 on average.', 'description', optCtx), []);
  // The writer's own passing title with a local place is kept, never replaced by a generic option.
  const kept = SR.chooseSearchFields({ seoTitle: 'Tenancy deposit protection in Leeds: what landlords do', metaDescription: 'Tenancy deposit protection explained for landlords in Leeds: the four schemes and the 30 day deadline.', titleOptions: ['Tenancy deposit protection: a plain guide'], descriptionOptions: [],
    proseText: `${OPT_PROSE} Most of our landlords are in Leeds.`, requirements: block(), brandName: 'Harbour Lettings' });
  assert.equal(kept.seoTitle, 'Tenancy deposit protection in Leeds: what landlords do');
  assert.equal(kept.record.title!.chosen, 'model');
});

test('P3: what should still be refused is refused (figures the article does not state, shouting, clickbait outside the phrase, names, addresses)', () => {
  for (const [title, want, ctx] of [
    ['Tenancy deposit protection: the 1 rule that matters', 'new_figure', optCtx],
    ['Tenancy deposit protection: 9 things to check', 'new_figure', optCtx],
    ['Tenancy deposit protection: 20 landlord questions', 'new_figure', optCtx],
    ['Tenancy deposit protection for £4 a month', 'new_figure', optCtx],
    ['Tenancy deposit protection: 12,000 landlords fined', 'new_figure', optCtx],
    ['Tenancy deposit protection: ninety percent get it wrong', 'new_figure', optCtx],
    ['Tenancy deposit protection: six schemes compared', 'new_figure', optCtx],
    ['Tenancy deposit protection: the one rule that matters', 'new_figure', { ...optCtx, proseText: 'Landlords compare the schemes.' }],
    ['Tenancy deposit protection: best practice for landlords', 'clickbait', optCtx],
    ['Best landlord insurance: the cheapest cover', 'clickbait', { ...optCtx, phrase: 'best landlord insurance', proseText: 'Best landlord insurance depends on cover.' }],
    ['Tenancy deposit protection: HUGE changes for landlords', 'clickbait', optCtx],
    ['Tenancy deposit protection and UPVC window damage', 'clickbait', optCtx],
    ['Tenancy deposit protection: why OpenRent beats agents', 'unknown_name', optCtx],
    ['Tenancy deposit protection in Scotland explained', 'unknown_name', optCtx],
    ['Tenancy deposit protection by acme-lettings.co.uk', 'address', optCtx],
    ['Booking.com fees for hosts at acme.co.uk', 'address', { ...optCtx, phrase: 'booking.com fees for hosts', proseText: 'Fees for hosts vary.' }],
  ] as const) assert.ok(SR.optionProblems(title, 'title', ctx as Any).includes(want as Any), `${title}: ${JSON.stringify(SR.optionProblems(title, 'title', ctx as Any))}`);
});

// ─── S1: a failing Google field with no passing option waits for the owner ───

test('S1: a Google title kept although it names an exclusion, an address, unproven proof or clickbait sets "needs approval" with a plain reason', async () => {
  const s = await F.setup();
  s.h.llm.articleOverride = (base: Any) => ({ ...base, seo_title: 'Tenancy deposit protection: award-winning help at acme-lettings.co.uk', title_options: ['Tenancy deposit protection explained!'] });
  const { article, version } = await F.write(s, s.pillar.id);
  assert.equal(version!.body.seoTitle, 'Tenancy deposit protection: award-winning help at acme-lettings.co.uk', 'kept: no option passed');
  assert.equal(article!.requiresApproval, true);
  const issue = article!.checks!.issues.find((i) => i.code === 'meta.seo_title_needs_check')!;
  assert.match(issue.message, /^The Google title contains a web address and claims proof such as awards, reviews or ratings that the article does not show, and no better wording was available, so this article waits for your approval\.$/);
  assert.equal(issue.severity, 'warning');
  assert.doesNotMatch(issue.message + issue.fix, /model|claude|anthropic|dataforseo|supplier|method|prompt|option/i);
  const activity = await s.h.store.listActivity(s.brandId, 500);
  assert.ok(activity.some((a: Any) => a.kind === 'article.needs_approval' && a.message === issue.message));
});

test('S1: a title replaced by a passing option, or failing only a lesser check, publishes as before (no approval flag)', async () => {
  const s = await F.setup();
  s.h.llm.articleOverride = (base: Any) => ({ ...base, seo_title: 'Tenancy deposit protection: award-winning help', title_options: ['Tenancy deposit protection: a plain guide for landlords'] });
  const replaced = await F.write(s, s.pillar.id);
  assert.equal(replaced.version!.body.seoTitle, 'Tenancy deposit protection: a plain guide for landlords');
  assert.equal(replaced.article!.requiresApproval, false);
  assert.ok(!replaced.article!.checks!.issues.some((i) => /needs_check/.test(i.code)));
  // Unknown name only (no serious failure): kept, recorded, no flag.
  const other = s.briefs.find((b) => b.id !== s.pillar.id && SR.hasSearchTarget(b))!;
  s.h.llm.articleOverride = (base: Any) => ({ ...base, seo_title: `${other.seo!.primary.phrase}: notes from Zedland`, title_options: [] });
  const lesser = await F.write(s, other.id);
  assert.ok(lesser.version!.generation!.searchDraft!.title!.main.includes('unknown_name'));
  assert.equal(lesser.article!.requiresApproval, false);
  // The helper reads only a record that kept a failing field.
  assert.deepEqual(Ch.searchFieldsHeld(null), []);
  assert.deepEqual(Ch.searchFieldsHeld({ searchDraft: { title: { chosen: 'option', main: ['excluded'] } } } as Any), []);
  assert.equal(Ch.searchFieldsHeld({ searchDraft: { description: { chosen: 'model', main: ['excluded', 'too_long'] } } } as Any)[0]!.message,
    'The short description names a subject your business has asked us to avoid, and no better wording was available, so this article waits for your approval.');
});

// ─── S4: questions are filtered like topics, and the most searched come first ─

const HOSTILE_QUESTIONS: [string, number][] = [['is harbour lettings tenancy deposit protection a scam', 40], ['why is openrent the best for tenancy deposit protection', 30], ['does tenancy deposit protection guarantee 12% returns', 20],
  ['what is the tenancy deposit protection helpline 0300 037 1000', 20], ['is tenancy deposit protection no longer required after 2026', 20], ['can you ignore tenancy deposit protection rules', 20]];

test('S4: promise, proof, rating, money, percentage, risky-claim, blame and ranking questions never reach the block; ordinary ones do', () => {
  for (const q of ['does tenancy deposit protection guarantee 12 returns', 'is tenancy deposit protection no longer required after 2026', 'is harbour lettings tenancy deposit protection a scam',
    'is acme deposits a rip-off', 'is tenancy deposit protection fraud common', 'why is openrent the best for tenancy deposit protection', 'is acme really the cheapest deposit scheme',
    'what is the tenancy deposit protection helpline 0300 037 1000', 'is tenancy deposit protection worth £50', 'does tenancy deposit protection cover 100% of the deposit',
    'is tenancy deposit protection rated 5 stars', 'which tenancy deposit protection scheme has testimonials', 'are landlords exempt from tenancy deposit protection'])
    assert.ok(SR.notAQuestion(q, PHRASE), q);
  for (const q of ['how does tenancy deposit protection work', 'what is the best tenancy deposit protection scheme', 'is tenancy deposit protection the best way to protect a deposit',
    'how much does tenancy deposit protection cost', 'who pays for tenancy deposit protection', 'is it the best time to protect a tenancy deposit', 'what happens if a landlord ignores tenancy deposit protection'])
    assert.ok(!SR.notAQuestion(q, PHRASE), q);
});

test('S4 through the engine: the most searched question survives the cap; none of the reviewer\'s hostile rows reaches any length setting', async () => {
  const s = await F.setup({ rows: [...F.DEPOSITS, ...HOSTILE_QUESTIONS] });
  const stored = s.pillar.seo!.questions.map((q) => q.text);
  assert.equal(stored[0], 'how does tenancy deposit protection work', 'most searched first (90 searches)');
  for (const length of ['concise', 'standard', 'in-depth'] as const) {
    const r = SR.searchRequirements({ brief: s.pillar, pages: [], length, linkable: [], exclusions: [] })!;
    assert.equal(r.questions_to_answer[0], 'how does tenancy deposit protection work', length);
    for (const [q] of HOSTILE_QUESTIONS.filter(([q]) => !/ignore/.test(q))) assert.ok(!r.questions_to_answer.some((x) => x.startsWith(q.slice(0, 30))), `${length}: ${q}`);
  }
  // Questions with numbers (a later record) are ordered by them before the cap; unmeasured ones keep their order after.
  const brief = { outline: [], internalLinks: [], seo: seoOf({}, { questions: [{ text: 'who pays for tenancy deposit protection', searches: null }, { text: 'what is tenancy deposit protection', searches: 10 }, { text: 'how does tenancy deposit protection work', searches: 90 }] }) } as Any;
  assert.deepEqual(SR.searchRequirements({ brief, pages: [], length: 'concise', linkable: [], exclusions: [] })!.questions_to_answer, ['how does tenancy deposit protection work', 'what is tenancy deposit protection']);
});

test('S4: both v2 prompts say a question\'s business name or claim is never repeated', () => {
  assert.match(loadPrompt('seo-blog-article-v2.md').body, /questions_to_answer: [^\n]*Never repeat a business name or a claim a question contains\./);
  assert.match(loadPrompt('seo-blog-section-v2.md').body, /never repeating a business name or a claim it contains\./);
});
