import test from 'node:test';
import assert from 'node:assert/strict';
import { MockKeywordProvider } from '../src/keyword/mock.js';

test('MockKeywordProvider returns one metric per keyword, labelled mock', async () => {
  const p = new MockKeywordProvider();
  const out = await p.metrics(['emergency electrician buxton', 'eicr certificate cost']);
  assert.equal(out.length, 2);
  for (const m of out) {
    assert.equal(m.source, 'mock');
    assert.ok(typeof m.volume === 'number' && m.volume >= 10, 'volume is a positive number');
    assert.ok(m.difficulty !== null && m.difficulty >= 0 && m.difficulty < 100);
    assert.ok(m.cpc !== null && m.cpc >= 0);
  }
});

test('MockKeywordProvider is deterministic (stable across calls)', async () => {
  const a = await new MockKeywordProvider().metrics(['landlord safety certificate']);
  const b = await new MockKeywordProvider().metrics(['landlord safety certificate']);
  assert.deepEqual(a, b);
});

test('MockKeywordProvider distinguishes different keywords', async () => {
  const [x, y] = await new MockKeywordProvider().metrics(['rewire cost', 'fuse board replacement']);
  assert.notEqual(x!.volume, y!.volume, 'different keywords should not collide on volume');
});
