import test from 'node:test';
import assert from 'node:assert/strict';
import { researchQuerySeeds, researchQueries, ResearchUnavailableError } from '../src/seo-blog/research.js';
import { FakeWeb } from './seo-blog-fixtures.js';

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

test('source NUL padding becomes word spacing before JSONB evidence persistence',async()=>{
  const web=new FakeWeb();web.set('https://evidence.example/guide','<html><title>Useful\u0000guide</title><main><p>Refurbishment budgets need written assumptions and comparable evidence. Keep\u0000separate labour and material estimates and test each assumption carefully.</p></main></html>');
  const result=await researchQueries({queries:['refurbishment budgets'],search:{id:'fixture',mode:'live',search:async()=>[{url:'https://evidence.example/guide',title:'Guide',snippet:''}]},transport:web,locale:'en-GB',brandWebsite:null,now:()=>new Date().toISOString()});
  assert.equal(result.sources.length,1);assert.equal(result.sources[0]!.title,'Useful guide');assert.doesNotMatch(JSON.stringify(result),/\\u0000/);assert.match(result.sources[0]!.passage,/Keep separate/);
});
test('queued search yield does not repeatedly read earlier pages before all receipts exist',async()=>{
  const web=new FakeWeb();let searches=0;
  await assert.rejects(researchQueries({queries:['first subject','second subject'],search:{id:'fixture',mode:'live',search:async()=>{searches++;if(searches===2)throw new ResearchUnavailableError('Task pending');return [{url:'https://evidence.example/guide',title:'Guide',snippet:''}];}},transport:web,locale:'en-GB',brandWebsite:null,now:()=>new Date().toISOString()}),ResearchUnavailableError);
  assert.equal(searches,2);assert.equal(web.requests.length,0,'no earlier page is re-read while the next search task is still queued');
});
