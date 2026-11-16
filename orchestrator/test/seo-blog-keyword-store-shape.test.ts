import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolRow } from '../src/seo-blog/keyword-pool.js';
import {
  KEYWORD_POOL_ROW_CAP, LEDGER_ENTRY_CAP, emptyKeywordStore, freshness, reduceKeywordStore,
  type KeywordStore, type KeywordStoreEvent, type StoredKeywordRow,
} from '../src/seo-blog/keyword-store-shape.js';

function row(i: number, extra: Partial<PoolRow> = {}): PoolRow {
  return {
    id: `kw-${i.toString(36)}`, key: `landlord question number ${i}`, phrase: `how do landlords handle question number ${i}`,
    basis: 'measured', searches: 1300 + i, measuredMonth: '2026-10', parent: 'landlord questions', parentSearches: null, parentMeasuredMonth: null,
    rankingDifficulty: 27, band: 'easier', intent: 'informational', sources: ['ideas', 'suggestions'], variants: [`how do landlords handle question number ${i}`],
    ownPosition: i % 7 === 0 ? 14 : null, clusterId: `kc-${(i % 40).toString(36)}`, role: i % 40 === 0 ? 'pillar' : 'supporting',
    opportunity: 0.6123, why: 'We chose this because it is searched about 1,300 times a month, it is easier to rank for and it ties in with your Fully managed lettings.',
    labels: { searches: 'About 1,300 searches a month, measured October 2026', difficulty: 'Easier', want: 'Learn', basis: 'Measured' },
    ...extra,
  };
}

test('freshness windows: 30 days fresh, shown with month to 90, then expired; own rankings 14 days', () => {
  const at = '2026-10-01T00:00:00.000Z';
  assert.equal(freshness(at, '2026-10-31T00:00:00.000Z'), 'fresh');
  assert.equal(freshness(at, '2026-11-01T00:00:00.000Z'), 'shown_with_month');
  assert.equal(freshness(at, '2026-12-30T00:00:00.000Z'), 'shown_with_month');
  assert.equal(freshness(at, '2026-12-31T00:00:00.000Z'), 'expired');
  assert.equal(freshness(at, '2026-10-15T00:00:00.000Z', 'own_ranking'), 'fresh');
  assert.equal(freshness(at, '2026-10-16T00:00:00.000Z', 'own_ranking'), 'expired');
  assert.equal(freshness('nonsense', '2026-10-16T00:00:00.000Z'), 'expired');
});

test('reducer: dismissed never comes back, choices are idempotent, thin rebuilds carry good rows over, ledger totals add up', () => {
  let s: KeywordStore = emptyKeywordStore(2826, 'en');
  const events: KeywordStoreEvent[] = [
    { type: 'pool_built', at: '2026-10-01T00:00:00.000Z', rows: [row(1), row(2), row(3)], state: 'measured' },
    { type: 'dismissed', key: row(2).key, phrase: row(2).phrase, at: '2026-10-02T00:00:00.000Z', by: 'owner-1' },
    { type: 'dismissed', key: row(2).key, phrase: row(2).phrase, at: '2026-10-03T00:00:00.000Z', by: 'owner-1' },
    { type: 'chosen', key: row(1).key, phrase: row(1).phrase, at: '2026-10-02T00:00:00.000Z', by: 'owner-1', commandId: 'cmd-1' },
    { type: 'chosen', key: row(1).key, phrase: row(1).phrase, at: '2026-10-02T00:00:01.000Z', by: 'owner-1', commandId: 'cmd-1' },
    { type: 'chosen', key: row(2).key, phrase: row(2).phrase, at: '2026-10-02T00:00:02.000Z', by: 'owner-1', commandId: 'cmd-2' },
    { type: 'pool_built', at: '2026-10-20T00:00:00.000Z', rows: [row(2), row(4)], state: 'thin' },
    { type: 'cost_recorded', entry: { at: '2026-10-20T00:00:00.000Z', endpoint: 'keyword_ideas', attemptNonce: 'n1', providerReportedCost: 0.048, rows: 300, outcome: 'ok', diagnosticCategory: null } },
    { type: 'cost_recorded', entry: { at: '2026-10-21T00:00:00.000Z', endpoint: 'ranked_keywords', attemptNonce: 'n2', providerReportedCost: null, rows: 0, outcome: 'failed', diagnosticCategory: 'unknown' } },
    { type: 'owner_seed_added', phrase: 'hmo licence', at: '2026-10-21T00:00:00.000Z', by: 'owner-1' },
    { type: 'owner_seed_added', phrase: 'hmo licence', at: '2026-10-22T00:00:00.000Z', by: 'owner-1' },
  ];
  for (const e of events) s = reduceKeywordStore(s, e);
  const keys = s.pool.rows.map((r) => r.key);
  assert.ok(!keys.includes(row(2).key), 'a dismissed phrase never re-enters the pool');
  assert.deepEqual(keys.sort(), [row(1).key, row(3).key, row(4).key].sort(), 'rows missing from a thin rebuild are carried over while still shown');
  assert.equal(s.pool.rows.find((r) => r.key === row(4).key)!.measuredAt, '2026-10-20T00:00:00.000Z');
  assert.equal(s.pool.rows.find((r) => r.key === row(1).key)!.measuredAt, '2026-10-01T00:00:00.000Z');
  assert.equal(s.choices.dismissed.length, 1); assert.deepEqual(s.choices.chosen.map((c) => c.commandId), ['cmd-1']);
  assert.equal(s.choices.ownerSeeds.length, 1);
  assert.deepEqual(s.pool.ledger.months['2026-10'], { calls: 2, cost: 0.048, unpriced: 1 });
  assert.equal(s.pool.ledger.entries[0]!.attemptNonce, 'n2');
  const pruned = reduceKeywordStore(s, { type: 'expired_pruned', now: '2027-01-05T00:00:00.000Z' });
  assert.deepEqual(pruned.pool.rows.map((r) => r.key), [row(4).key]);
  // Same events, same order, same store.
  let again: KeywordStore = emptyKeywordStore(2826, 'en');
  for (const e of events) again = reduceKeywordStore(again, e);
  assert.deepEqual(again, s);
});

test('caps: 300 rows and 200 ledger entries', () => {
  let s = reduceKeywordStore(emptyKeywordStore(2826, 'en'), { type: 'pool_built', at: '2026-10-01T00:00:00.000Z', rows: Array.from({ length: 500 }, (_, i) => row(i)), state: 'measured' });
  assert.equal(s.pool.rows.length, KEYWORD_POOL_ROW_CAP);
  for (let i = 0; i < 250; i++) s = reduceKeywordStore(s, { type: 'cost_recorded', entry: { at: '2026-11-01T00:00:00.000Z', endpoint: 'keyword_overview', attemptNonce: `n${i}`, providerReportedCost: 0.0121, rows: 1, outcome: 'ok', diagnosticCategory: null } });
  assert.equal(s.pool.ledger.entries.length, LEDGER_ENTRY_CAP);
  assert.deepEqual(s.pool.ledger.months['2026-11'], { calls: 250, cost: 3.025, unpriced: 0 });
});

test('size estimate: 500 realistic rows fit comfortably in the inventory record (4 MB limit)', () => {
  const rows: StoredKeywordRow[] = Array.from({ length: 500 }, (_, i) => ({
    id: row(i).id, key: row(i).key, phrase: row(i).phrase, basis: 'measured', searches: 1300 + i, measuredMonth: '2026-10', parent: 'landlord questions',
    parentSearches: null, rankingDifficulty: 27, intent: 'informational', sources: ['ideas', 'suggestions'], clusterId: row(i).clusterId, role: 'supporting',
    ownPosition: null, covered: null, opportunity: 0.6123, why: row(i).why, measuredAt: '2026-10-01T00:00:00.000Z', ownRankingAt: null,
  }));
  const bytes = Buffer.byteLength(JSON.stringify({ schema: 1, locationCode: 2826, languageCode: 'en', builtAt: '2026-10-01T00:00:00.000Z', rows, state: 'measured', ledger: { entries: [], months: {} } }));
  console.log(`# keyword pool: 500 stored rows serialise to ${bytes} bytes`);
  assert.ok(bytes < 400_000, `${bytes}`);
  assert.ok(bytes < 4 * 1024 * 1024 * 0.1);
});
