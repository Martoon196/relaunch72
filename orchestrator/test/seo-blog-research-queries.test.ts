import test from 'node:test';
import assert from 'node:assert/strict';
import { researchQuerySeeds } from '../src/seo-blog/research.js';

test('search phrases retain whole words and Unicode without quoted prose or incomplete parentheses', () => {
  const result = researchQuerySeeds({ focus: 'UK property appraisal: checking sold comparables, refurbishment assumptions and maximum offers, with clear source and geographic limits.', audiences: ['Investisseurs français (Paris, Lyon) et rénovation énergétique'], positioning: '' });
  assert.ok(result.every((q) => q.length <= 90 && q.split(' ').length <= 8));
  assert.equal(result[0], 'UK property appraisal checking sold comparables refurbishment assumptions');
  assert.match(result[1]!, /français.*rénovation énergétique/u);
  assert.doesNotMatch(result.join(' '), /[():,]/u);
});
test('case-equivalent inputs do not purchase duplicate searches and every editorial query retains its audience context', () => {
  const result = researchQuerySeeds({ focus: 'Rental deposits', audiences: ['rental deposits'], positioning: 'Harbour compliance', categories: ['Guides', 'Checklist'] });
  assert.equal(result.length, 3);
  assert.equal(result.filter((q) => /^rental deposits$/iu.test(q)).length, 1);
  assert.ok(result.slice(1).every((q) => /rental deposits/iu.test(q)));
});
test('existing search ceiling is respected; absent useful brand text does not invent an industry', () => {
  const input = { audiences: ['Property investors', 'Deal sourcers', 'Auction buyers'], positioning: 'Evidence-led appraisals', categories: ['Guides', 'Costs', 'Risks'], focus: 'Refurbishment appraisal' };
  assert.equal(researchQuerySeeds({ ...input, limit: 2 }).length, 2);
  assert.deepEqual(researchQuerySeeds({ audiences: ['() !'], positioning: '' }), []);
  assert.deepEqual(researchQuerySeeds({ audiences: [], positioning: 'Commercial lease advice' }), ['Commercial lease advice']);
});
