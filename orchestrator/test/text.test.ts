import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractNumbers,
  extractQuotedSpans,
  isPlaceholderEcho,
  normalizeText,
  similarityRatio,
  wordCount,
} from '../src/util/text.js';

test('wordCount counts words across whitespace', () => {
  assert.equal(wordCount('one two  three\nfour'), 4);
  assert.equal(wordCount('   '), 0);
});

test('normalizeText maps curly quotes and collapses whitespace, preserves case', () => {
  assert.equal(normalizeText('“Hello”  ‘there’\n\nWorld'), '"Hello" \'there\' World');
  assert.equal(normalizeText('A–B — C'), 'A-B - C');
});

test('extractQuotedSpans finds straight and curly double quotes, ignores single', () => {
  const spans = extractQuotedSpans('They said "turned up on time" and “no drama at all” but don\'t match this');
  assert.deepEqual(spans, ['turned up on time', 'no drama at all']);
});

test('isPlaceholderEcho catches exact and near-copies', () => {
  const placeholder = "I fit high-end kitchens for families in Kent who've been burned by cowboy builders";
  assert.equal(isPlaceholderEcho(placeholder, placeholder), true);
  assert.equal(isPlaceholderEcho("I fit high-end kitchens for families in Kent who've been burned by cowboy builders!!", placeholder), true);
  assert.equal(
    isPlaceholderEcho('I fit high-end kitchens for families in Essex who have been burned by cowboy builders', placeholder),
    true,
  );
});

test('isPlaceholderEcho does NOT fire on a genuine answer in the same trade', () => {
  const placeholder = "I fit high-end kitchens for families in Kent who've been burned by cowboy builders";
  const genuine = 'I rewire and certify older houses for landlords across the Peak District who need paperwork done right';
  assert.equal(isPlaceholderEcho(genuine, placeholder), false);
});

test('extractNumbers handles currency commas and percents', () => {
  const nums = extractNumbers('£2,400/mo (= 2 lost jobs × £1,200 average, about 15% of revenue)');
  assert.deepEqual(
    nums.map((n) => [n.value, n.percent]),
    [
      [2400, false],
      [2, false],
      [1200, false],
      [15, true],
    ],
  );
});

test('extractNumbers expands k/m shorthand and NBSP-split thousands', () => {
  const k = extractNumbers('£12k of losses');
  assert.deepEqual(k.map((n) => n.value), [12000]);
  const m = extractNumbers('a £1.5m business');
  assert.deepEqual(m.map((n) => n.value), [1500000]);
  const nbsp = extractNumbers('£12 345 total');
  assert.deepEqual(nbsp.map((n) => n.value), [12345]);
  // "/mo" must not be read as an m-suffix
  const mo = extractNumbers('14 new customers/mo');
  assert.deepEqual(mo.map((n) => n.value), [14]);
});

test('similarityRatio is high for near-identical strings', () => {
  assert.ok(similarityRatio('hello world', 'hello world!') > 0.9);
  assert.ok(similarityRatio('hello world', 'completely different text') < 0.5);
});
