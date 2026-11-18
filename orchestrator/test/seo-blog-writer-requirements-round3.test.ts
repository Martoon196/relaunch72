/**
 * Release 8, third fix round: one test per item of the second independent review (P1-P3, S1, S3-S6, N5) and its five
 * mutation survivors. Each failed before its fix and passes after. Namespace imports, so a function that did not exist
 * before fails its own test only. Fakes only: no live calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/portal/seo-blog-seo-panel.js';
import * as S from '../src/seo-blog/seo-score.js';
import { loadPrompt } from '../src/stages/prompt.js';
import type { ArticleBrief, ArticleVersion } from '../src/seo-blog/types.js';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const Panel = P as Any;

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
