import test from 'node:test';
import assert from 'node:assert/strict';
import {parseResearchQuestions} from '../src/seo-blog/research-questions.js';
test('only observed PAA titles become questions, with stable receipt binding and safe source links',()=>{
  const items=[{type:'organic',title:'An unrelated page'},{type:'people_also_ask',items:[{type:'people_also_ask_element',title:'How do I check\u0000 refurbishment costs?',expanded_element:[{url:'https://www.gov.uk/example'}]},{title:'HOW DO I CHECK refurbishment costs?'},{title:'How do I compare asking and sold prices?',expanded_element:[{url:'https://user:secret@evil.example/'}]}]}];
  const q=parseResearchQuestions(items,'task-12345678');assert.equal(q.length,2);assert.equal(q[0]!.text,'How do I check refurbishment costs?');assert.equal(q[0]!.sourceUrl,'https://www.gov.uk/example');assert.equal(q[1]!.sourceUrl,null);assert.equal(q[0]!.origin,'search');assert.deepEqual(parseResearchQuestions(items,'task-12345678'),q);assert.notEqual(parseResearchQuestions(items,'task-87654321')[0]!.id,q[0]!.id);
});
test('malformed or missing supplier question features do not invent questions or identities',()=>{
  for(const items of [null,{},[{type:'related_searches',items:[{title:'property investing'}]}],[{type:'people_also_ask',items:[{title:123},{title:'x'},{title:'a'.repeat(501)}]}]])assert.deepEqual(parseResearchQuestions(items,'task-12345678'),[]);
  assert.deepEqual(parseResearchQuestions([{type:'people_also_ask',items:[{title:'A real question?'}]}],'../secret'),[]);
});
