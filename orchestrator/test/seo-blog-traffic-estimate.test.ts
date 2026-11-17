import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLICK_SHARE_V1, ESTIMATE_DISCLOSURE, NO_NUMBER_NOTICE, estimateForPhrase, rollupEstimate, roundDown, roundUp, roundingStep,
  type RollupRow,
} from '../src/seo-blog/traffic-estimate.js';

test('the house curve is versioned and matches the addendum, positions 1, 2, 3 and 10 marked verified', () => {
  assert.equal(CLICK_SHARE_V1.version, 'click-share-v1');
  assert.deepEqual(CLICK_SHARE_V1.perMilleByPosition, { 1: 285, 2: 150, 3: 110, 4: 80, 5: 70, 6: 50, 7: 40, 8: 30, 9: 30, 10: 25 });
  assert.deepEqual([...CLICK_SHARE_V1.verifiedPositions], [1, 2, 3, 10]);
  assert.ok(Object.isFrozen(CLICK_SHARE_V1) && Object.isFrozen(CLICK_SHARE_V1.perMilleByPosition));
});

test('range and rounding table (position 3 to position 1; 5 below 100, 10 below 1,000, 100 above)', () => {
  const table: [number, string, number, number, string][] = [
    [400, 'range', 40, 120, 'Could bring about 40 to 120 visits a month if it reaches the top three. Estimate.'],
    [1300, 'range', 140, 380, 'Could bring about 140 to 380 visits a month if it reaches the top three. Estimate.'],
    [100, 'range', 10, 30, 'Could bring about 10 to 30 visits a month if it reaches the top three. Estimate.'],
    [200, 'range', 20, 60, 'Could bring about 20 to 60 visits a month if it reaches the top three. Estimate.'],
    [909, 'range', 95, 260, 'Could bring about 95 to 260 visits a month if it reaches the top three. Estimate.'],
    [910, 'range', 100, 260, 'Could bring about 100 to 260 visits a month if it reaches the top three. Estimate.'],
    [1000, 'range', 110, 290, 'Could bring about 110 to 290 visits a month if it reaches the top three. Estimate.'],
    [2000, 'range', 220, 570, 'Could bring about 220 to 570 visits a month if it reaches the top three. Estimate.'],
    [5000, 'range', 550, 1500, 'Could bring about 550 to 1,500 visits a month if it reaches the top three. Estimate.'],
    [10000, 'range', 1100, 2900, 'Could bring about 1,100 to 2,900 visits a month if it reaches the top three. Estimate.'],
    [35, 'range', 0, 10, 'Could bring up to about 10 visits a month if it reaches the top three. Estimate.'],
    [17, 'fewer_than_10', 0, 5, 'Could bring fewer than 10 visits a month if it reaches the top three. Estimate.'],
    [10, 'fewer_than_10', 0, 5, 'Could bring fewer than 10 visits a month if it reaches the top three. Estimate.'],
    [0, 'fewer_than_10', 0, 0, 'Could bring fewer than 10 visits a month if it reaches the top three. Estimate.'],
  ];
  for (const [searches, kind, low, high, sentence] of table) {
    const e = estimateForPhrase({ basis: 'measured', searches });
    assert.equal(e.kind, kind, String(searches));
    assert.ok(e.kind !== 'none');
    assert.equal(e.low, low, `low ${searches}`); assert.equal(e.high, high, `high ${searches}`);
    assert.equal(e.sentence, sentence);
  }
  assert.equal(roundingStep(99.99), 5); assert.equal(roundingStep(100), 10); assert.equal(roundingStep(999), 10); assert.equal(roundingStep(1000), 100);
  assert.equal(roundDown(1234), 1200); assert.equal(roundUp(1234), 1300); assert.equal(roundUp(570), 570);
});

test('integer arithmetic: no float drift at exact multiples, across every searches value up to 20,000', () => {
  for (let s = 0; s <= 20_000; s++) {
    const e = estimateForPhrase({ basis: 'measured', searches: s });
    assert.ok(e.kind !== 'none');
    const lowExact = (s * 110) / 1000; const highExact = (s * 285) / 1000;
    assert.ok(e.low <= lowExact + 1e-9 && e.high >= highExact - 1e-9, `${s}`);
    assert.equal(e.low % roundingStep(lowExact), 0); assert.equal(e.high % roundingStep(highExact), 0);
    assert.ok(e.high - highExact < roundingStep(highExact), `high overshoots a whole step at ${s}`);
  }
});

test('no estimate without a measured number for that exact phrase, in all three unmeasured cases', () => {
  const parent = estimateForPhrase({ basis: 'parent_phrase', searches: 5400 });
  assert.deepEqual(parent, { kind: 'none', curve: 'click-share-v1', reason: 'wider_phrase_only', sentence: null, notice: null });
  const observed = estimateForPhrase({ basis: 'observed', searches: 900 });
  assert.equal(observed.kind, 'none'); assert.equal(observed.sentence, null); assert.ok(observed.kind === 'none' && observed.notice === NO_NUMBER_NOTICE);
  assert.equal(estimateForPhrase({ basis: 'none', searches: 50 }).sentence, null);
  for (const searches of [null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(estimateForPhrase({ basis: 'measured', searches: searches as number | null }).kind, 'none');
  }
});

test('roll-up: one primary phrase per article, counted states only, unmeasured reported but not added', () => {
  const rows: RollupRow[] = [
    { articleKey: 'a1', state: 'chosen', primary: { basis: 'measured', searches: 400 } },
    { articleKey: 'a2', state: 'live', primary: { basis: 'measured', searches: 1300 } },
    { articleKey: 'a2', state: 'live', primary: { basis: 'measured', searches: 1300 } }, // same article twice: counted once
    { articleKey: 'a3', state: 'being_written', primary: { basis: 'parent_phrase', searches: 9000 } },
    { articleKey: 'a4', state: 'ready', primary: { basis: 'observed', searches: null } },
    { articleKey: 's1', state: 'suggested', primary: { basis: 'measured', searches: 99_000 } },
    { articleKey: 'd1', state: 'dismissed', primary: { basis: 'measured', searches: 99_000 } },
    { articleKey: 'c1', state: 'already_covered', primary: { basis: 'measured', searches: 99_000 } },
  ];
  const r = rollupEstimate(rows);
  assert.equal(r.counted, 2); assert.equal(r.uncounted, 2); assert.equal(r.low, 180); assert.equal(r.high, 500);
  assert.equal(r.sentence, 'The 2 keywords you have chosen could bring about 180 to 500 visits a month if they all reach the top three. Estimate. 2 more have no search number yet and are not counted.');
  assert.deepEqual(rollupEstimate([...rows].reverse()), r, 'order of rows does not matter');
  const auto = rollupEstimate(rows.slice(0, 2), 'autopilot');
  assert.equal(auto.sentence, 'The 2 keywords autopilot will write next could bring about 180 to 500 visits a month if they all reach the top three. Estimate.');
  const one = rollupEstimate([rows[0]!, rows[4]!]);
  assert.equal(one.sentence, 'The 1 keyword you have chosen could bring about 40 to 120 visits a month if it reaches the top three. Estimate. 1 more has no search number yet and is not counted.');
  assert.equal(rollupEstimate([rows[5]!, rows[6]!]).sentence, null, 'nothing chosen: no line at all');
  assert.equal(rollupEstimate([rows[3]!, rows[4]!]).sentence, 'None of the 2 keywords you have chosen has a search number yet, so there is no estimate.');
  const big = rollupEstimate(Array.from({ length: 9 }, (_, i) => ({ articleKey: `k${i}`, state: 'chosen' as const, primary: { basis: 'measured' as const, searches: 1300 } })));
  assert.equal(big.low, 1200); assert.equal(big.high, 3500); // 9 × 140 = 1,260 → 1,200; 9 × 380 = 3,420 → 3,500
});

test('wording guards: every sentence with a number says "Estimate" and the top-three condition, and names no supplier', () => {
  const sentences: string[] = [];
  for (let s = 0; s < 3000; s += 7) {
    const e = estimateForPhrase({ basis: 'measured', searches: s });
    if (e.sentence) sentences.push(e.sentence);
    const r = rollupEstimate([{ articleKey: 'x', state: 'chosen', primary: { basis: 'measured', searches: s } }, { articleKey: 'y', state: 'ready', primary: { basis: 'measured', searches: s * 3 } }]);
    if (r.sentence) sentences.push(r.sentence);
  }
  assert.ok(sentences.length > 800);
  for (const s of sentences) {
    if (/\d/.test(s)) {
      assert.match(s, /\bEstimate\./);
      assert.match(s, /if (it reaches|they all reach) the top three/);
    }
    assert.doesNotMatch(s, /dataforseo|supplier|provider|\bapi\b|model|google/i);
  }
  assert.doesNotMatch(ESTIMATE_DISCLOSURE, /dataforseo|supplier|provider|\bapi\b|model/i);
  assert.match(ESTIMATE_DISCLOSURE, /estimate, not a promise/);
});
