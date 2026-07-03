import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson } from '../src/llm/json.js';

test('extractJson parses a bare JSON object', () => {
  assert.deepEqual(extractJson('{"a": 1}'), { value: { a: 1 } });
});

test('extractJson parses fenced JSON', () => {
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a": 1}\n```\nDone.'), { value: { a: 1 } });
});

test('extractJson tolerates trailing prose after the object', () => {
  assert.deepEqual(extractJson('{"a": 1}\n\nHope this helps!'), { value: { a: 1 } });
});

test('extractJson tolerates leading prose that itself contains braces', () => {
  const text = 'Note {important}: the result follows.\n{"a": 1, "b": {"c": 2}}';
  assert.deepEqual(extractJson(text), { value: { a: 1, b: { c: 2 } } });
});

test('extractJson handles braces and fences inside string values', () => {
  const payload = { a: 'uses ``` and } and { inside a string' };
  const text = 'prefix\n```json\n' + JSON.stringify(payload) + '\n```';
  assert.deepEqual(extractJson(text), { value: payload });
});

test('extractJson reports an error for non-JSON output', () => {
  const result = extractJson('I cannot produce JSON for this request.');
  assert.ok('error' in result);
});
