/**
 * Brand DNA never dead-ends: the repair that takes off exactly the unverifiable lines of a website-door card.
 * Pure rules plus one offline extraction through a scripted model. No network, model or database is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { leftOutLines, nothingVerifiable, repairProfileFacts, strictProfileProblems, type ProfileFacts } from '../src/seo-blog/brand-dna.js';
import { extractProfile, GenerationRejectedError } from '../src/seo-blog/generation.js';
import type { LlmClient } from '../src/llm/client.js';
import type { KnowledgeDocument } from '../src/seo-blog/types.js';

const PRICING = 'The Quay Compliance Plan costs £49 per month. It covers gas safety reminders for every home you let. Our Mentoring programme runs for 12 weeks.';
const HOME = 'Quay Lettings helps private landlords in Kent stay compliant. We help landlords in Kent. Trusted by 300 landlords.';
const DOCS = [{ id: 'pricing', text: PRICING }, { id: 'home', text: HOME }];

const plan = { name: 'Quay Compliance Plan', description: 'Monthly compliance support.', price: '£49 per month', url: null, sourceDocumentId: 'pricing' };
const mentoring = { name: 'Mentoring programme', description: 'Runs for 12 weeks.', price: null, url: null, sourceDocumentId: 'pricing' };

/** A card where every line can be found word for word. */
function verified(): ProfileFacts & { summary: string; positioning: string; voice: { tone: string[]; do: string[]; dont: string[]; examples: string[] } } {
  return {
    summary: 'Quay Lettings helps private landlords in Kent stay compliant.', positioning: 'Plain-English compliance help.',
    voice: { tone: ['plain'], do: ['Explain rules simply'], dont: ['Jargon'], examples: ['We help landlords in Kent.'] },
    offers: [plan, mentoring], audiences: ['Private landlords in Kent'], approvedClaims: ['We help landlords in Kent', 'Trusted by 300 landlords'],
    conflicts: [], missingFacts: ['A named author'],
    sources: [
      { field: 'audience', value: 'Private landlords in Kent', documentId: 'home', quote: 'helps private landlords in Kent' },
      { field: 'claim', value: 'We help landlords in Kent', documentId: 'home', quote: 'We help landlords in Kent' },
      { field: 'claim', value: 'Trusted by 300 landlords', documentId: 'home', quote: 'Trusted by 300 landlords' },
    ],
  };
}

/** Every repair must leave a value the strict check accepts. */
function repaired<T extends ProfileFacts>(value: T) {
  const result = repairProfileFacts(value, DOCS);
  assert.deepEqual(strictProfileProblems(result.value, DOCS), [], 'the repaired card passes every word-for-word rule');
  return result;
}

test('a card that is already verified is returned unchanged with nothing left out', () => {
  const card = verified();
  assert.deepEqual(strictProfileProblems(card, DOCS), []);
  const result = repaired(card);
  assert.deepEqual(result.value, card); assert.deepEqual(result.leftOut, []);
});

test('a price not word for word in its source is emptied; the offer and everything else stay', () => {
  const card = { ...verified(), offers: [{ ...plan, price: '£39 per month' }, mentoring] };
  assert.equal(strictProfileProblems(card, DOCS).length, 1);
  const result = repaired(card);
  assert.deepEqual(result.value.offers, [{ ...plan, price: null }, mentoring]);
  assert.deepEqual(result.leftOut, [{ what: 'price', text: 'Quay Compliance Plan' }]);
  assert.deepEqual({ ...result.value, offers: card.offers }, card, 'nothing verified is removed');
});

test('an offer with no valid source, or whose name states a figure its source does not, is dropped', () => {
  const card = { ...verified(), offers: [plan, { ...mentoring, sourceDocumentId: 'made-up' }, { ...mentoring, name: 'Mentoring programme (500 places)' }, { ...mentoring, sourceDocumentId: null }] };
  const result = repaired(card);
  assert.deepEqual(result.value.offers, [plan]);
  assert.deepEqual(result.leftOut, [{ what: 'offer', text: 'Mentoring programme' }, { what: 'offer', text: 'Mentoring programme (500 places)' }], 'the same left-out line is recorded once');
});

test('a sentence of an offer description stating a figure its source does not is removed; the rest of it and the offer stay', () => {
  const card = { ...verified(), offers: [{ ...plan, description: 'Monthly compliance support. Saves £2,000 a year.' }, { ...mentoring, description: 'Over 900 graduates.' }] };
  const result = repaired(card);
  assert.equal(result.value.offers[0]!.description, 'Monthly compliance support.'); assert.equal(result.value.offers[0]!.price, '£49 per month');
  assert.equal(result.value.offers[1]!.description, '', 'a description with nothing verifiable left is emptied, never rewritten');
  assert.deepEqual(result.leftOut, [{ what: 'offer_detail', text: 'Quay Compliance Plan' }, { what: 'offer_detail', text: 'Mentoring programme' }]);
});

test('an audience or claim without a word-for-word quote that carries it is dropped; verified ones stay', () => {
  const card = verified();
  const result = repaired({ ...card, audiences: [...card.audiences, 'Property developers'], approvedClaims: [...card.approvedClaims, 'Trusted by 500 landlords'],
    sources: [...card.sources!, { field: 'claim', value: 'Trusted by 500 landlords', documentId: 'home', quote: 'Trusted by 300 landlords' }] });
  assert.deepEqual(result.value.audiences, card.audiences); assert.deepEqual(result.value.approvedClaims, card.approvedClaims);
  assert.deepEqual(result.leftOut, [{ what: 'audience', text: 'Property developers' }, { what: 'claim', text: 'Trusted by 500 landlords' }]);
  assert.deepEqual(result.value.sources, card.sources, 'the source of a dropped claim goes with it');
});

test('a source whose quote is not word for word, or that cites an unknown document, is dropped, and then so is what only it supported', () => {
  const card = verified();
  const sources = [
    { field: 'audience' as const, value: 'Private landlords in Kent', documentId: 'home', quote: 'landlords all over Britain' },
    { field: 'claim' as const, value: 'We help landlords in Kent', documentId: 'nowhere', quote: 'We help landlords in Kent' },
    { field: 'claim' as const, value: 'Trusted by 300 landlords', documentId: 'home', quote: 'Trusted by 300 landlords' },
    { field: 'voice' as const, value: 'plain', documentId: 'home', quote: 'not on any page at all' },
  ];
  const result = repaired({ ...card, sources });
  assert.deepEqual(result.value.audiences, []); assert.deepEqual(result.value.approvedClaims, ['Trusted by 300 landlords']);
  assert.deepEqual(result.value.sources, [sources[2]]);
  assert.deepEqual(result.leftOut, [{ what: 'audience', text: 'Private landlords in Kent' }, { what: 'claim', text: 'We help landlords in Kent' }]);
});

test('questions: unverifiable answers are dropped; one left with fewer than two answers, or malformed, is dropped and its price stays empty', () => {
  const docs = [...DOCS, { id: 'list', text: 'Price list. Quay Compliance Plan costs £59 per month for agents.' }];
  const good = { value: '£49 per month', documentId: 'pricing', quote: 'Compliance Plan costs £49 per month' };
  const other = { value: '£59 per month', documentId: 'list', quote: 'Compliance Plan costs £59 per month' };
  const invented = { value: '£69 per month', documentId: 'list', quote: 'Compliance Plan costs £69 per month' };
  const priceQuestion = { field: 'Plan price', detail: 'Two prices', documentIds: ['pricing', 'list', 'ghost'], kind: 'price' as const, offer: 'Quay Compliance Plan' };
  const card = { ...verified(), offers: [{ ...plan, price: '£49 per month' }, mentoring], conflicts: [
    { ...priceQuestion, options: [good, other, invented] },
    { field: 'Mentoring length', detail: 'Different lengths', documentIds: ['pricing'], kind: 'other' as const, offer: 'Nonexistent offer', options: [] },
    { field: 'Loose question', detail: 'No kind given', documentIds: ['pricing'] },
  ] };
  const kept = repairProfileFacts(card, docs);
  assert.deepEqual(strictProfileProblems(kept.value, docs), []);
  assert.deepEqual(kept.value.conflicts, [
    { ...priceQuestion, documentIds: ['pricing', 'list'], options: [good, other] },
    { field: 'Mentoring length', detail: 'Different lengths', documentIds: ['pricing'], kind: 'other', offer: null, options: [] },
  ], 'two verified answers keep the question; an offer name not on the card is emptied; unknown document ids are dropped');
  assert.deepEqual(kept.leftOut, [{ what: 'question', text: 'Loose question' }]);

  const thin = repairProfileFacts({ ...card, conflicts: [{ ...priceQuestion, options: [good, invented] }] }, docs);
  assert.deepEqual(strictProfileProblems(thin.value, docs), []);
  assert.deepEqual(thin.value.conflicts, []); assert.equal(thin.value.offers[0]!.price, null, 'the price it held stays empty, never picked');
  assert.deepEqual(thin.leftOut, [{ what: 'question', text: 'Plan price' }, { what: 'price', text: 'Quay Compliance Plan' }]);

  const orphan = repairProfileFacts({ ...card, offers: [mentoring], conflicts: [{ ...priceQuestion, options: [good, other] }] }, docs);
  assert.deepEqual(strictProfileProblems(orphan.value, docs), []);
  assert.deepEqual(orphan.value.conflicts, [], 'a price question about an offer not on the card is dropped');
});

test('free text: a sentence or voice line stating a figure in no document is removed; nothing is reworded', () => {
  const card = verified();
  const result = repaired({ ...card, summary: 'Quay Lettings helps private landlords in Kent stay compliant. Trusted by 500 landlords with a 98% pass rate.',
    positioning: 'Over 20 years of experience.', voice: { tone: ['plain', '10x calmer'], do: ['Explain rules simply', 'Mention our 4.9 rating'], dont: ['Jargon'], examples: ['Trusted by 300 landlords.', 'Rated 4.8 by 1,000 clients.'] } });
  assert.equal(result.value.summary, card.summary); assert.equal(result.value.positioning, '', 'positioning may be empty');
  assert.deepEqual(result.value.voice, { tone: ['plain', '10x calmer'], do: ['Explain rules simply'], dont: ['Jargon'], examples: ['Trusted by 300 landlords.'] });
  assert.deepEqual(result.leftOut.map((l) => l.text), ['Mention our 4.9 rating', 'Rated 4.8 by 1,000 clients.', 'Trusted by 500 landlords with a 98% pass rate.', 'Over 20 years of experience.']);
  assert.ok(result.leftOut.every((l) => l.what === 'wording'));
});

test('nothing verifiable: no offer, audience or claim survives', () => {
  const result = repaired({ ...verified(), offers: [{ ...plan, sourceDocumentId: 'x' }], audiences: ['Everyone'], approvedClaims: ['The best'], sources: [] });
  assert.equal(nothingVerifiable(result.value), true); assert.equal(nothingVerifiable(verified()), false);
});

test('left-out lines read plainly, are clipped, and say where each can be added', () => {
  const lines = leftOutLines([{ what: 'price', text: 'Mentoring programme' }, { what: 'claim', text: 'Over 500 investors helped' }, { what: 'audience', text: 'x'.repeat(400) }, { what: 'bogus' as 'price', text: 'ignored' }]);
  assert.deepEqual(lines.slice(0, 2), [{ label: 'The price of “Mentoring programme”', fix: 'documents' }, { label: 'The claim “Over 500 investors helped”', fix: 'card' }]);
  assert.equal(lines[2]!.label, `Who it is for: “${'x'.repeat(120)}…”`); assert.equal(lines.length, 3);
});

// ─── Through the extraction ──────────────────────────────────────────────────

const docs = (texts: Record<string, string>): KnowledgeDocument[] => Object.entries(texts).map(([id, text]) => ({
  id, brandId: 'b', version: 1, category: 'product_facts', title: id, filename: null, format: 'txt', mime: 'text/plain', sizeBytes: text.length, sha256: id, blobId: null,
  status: 'extracted', statusDetail: '', text, pagesRead: null, pagesTotal: null, active: true, createdAt: '2026-11-14T00:00:00.000Z',
}));
function scripted(answer: (attempt: number) => unknown): LlmClient & { calls: number } {
  const llm = { mode: 'mock' as const, calls: 0, complete: async () => { llm.calls++; return { text: JSON.stringify(answer(llm.calls)), tokensIn: 10, tokensOut: 10, stopReason: 'end_turn', model: 'scripted' }; } };
  return llm as unknown as LlmClient & { calls: number };
}
const answer = (over: Record<string, unknown> = {}) => ({
  summary: 'Quay Lettings helps private landlords in Kent stay compliant.', audiences: ['Private landlords in Kent'], positioning: '',
  offers: [{ name: 'Quay Compliance Plan', description: 'Monthly support.', price: '£39 per month', url: null, sourceDocumentId: 'pricing' }],
  conversionPages: [{ url: 'http://quay.example/join', label: 'Join' }], voice: { tone: [], do: [], dont: [], examples: [] }, approvedClaims: [], exclusions: [], conflicts: [], missingFacts: [],
  sources: [{ field: 'audience', value: 'Private landlords in Kent', documentId: 'home', quote: 'helps private landlords in Kent' }],
  leftOut: [{ what: 'claim', text: 'planted by the model' }], ...over,
});

test('extraction: a bad price after the correction pass gives a card with that price blank; the model cannot write its own left-out list', async () => {
  const llm = scripted(() => answer());
  const result = await extractProfile(llm, { brandName: 'Quay', website: null, documents: docs({ pricing: PRICING, home: HOME }), strict: true });
  assert.equal(llm.calls, 2, 'the correction pass is still asked for first');
  assert.equal(result.value.offers[0]!.price, null); assert.deepEqual(result.value.audiences, ['Private landlords in Kent']);
  assert.deepEqual(result.value.conversionPages, []);
  assert.deepEqual(result.value.leftOut, [{ what: 'price', text: 'Quay Compliance Plan' }, { what: 'link', text: 'http://quay.example/join' }]);

  // Setup's documents-only path is untouched: no repair, no left-out list, the model's own field never kept.
  const setup = await extractProfile(scripted(() => answer({ offers: [], conversionPages: [] })), { brandName: 'Quay', website: null, documents: docs({ pricing: PRICING, home: HOME }) });
  assert.equal(setup.value.leftOut, undefined);
});

test('extraction: when nothing verifiable survives, or a required summary would be emptied, the card is refused as before', async () => {
  const nothing = scripted(() => answer({ audiences: ['Everyone'], sources: [], offers: [{ name: 'Gold', description: '', price: null, url: null, sourceDocumentId: 'ghost' }] }));
  await assert.rejects(extractProfile(nothing, { brandName: 'Quay', website: null, documents: docs({ pricing: PRICING, home: HOME }), strict: true }),
    (error: unknown) => error instanceof GenerationRejectedError && error.reason === 'content');
  assert.equal(nothing.calls, 2);
  const boast = scripted(() => answer({ summary: 'Trusted by 500 landlords across Kent.' }));
  await assert.rejects(extractProfile(boast, { brandName: 'Quay', website: null, documents: docs({ pricing: PRICING, home: HOME }), strict: true }), GenerationRejectedError);
});
