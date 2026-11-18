/**
 * Release 8, third fix round: one test per item of the second independent review (P1-P3, S1, S3-S6, N5) and its five
 * mutation survivors. Each failed before its fix and passes after. Namespace imports, so a function that did not exist
 * before fails its own test only. Fakes only: no live calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/portal/seo-blog-seo-panel.js';
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
