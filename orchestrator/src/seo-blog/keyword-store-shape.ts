/**
 * PROPOSAL ONLY: how the keyword pool, its measurements, freshness, the owner's
 * choices and the supplier cost ledger would sit in jsonb on records that exist
 * today, so the release that wires keyword-first planning needs no migration.
 * Types and a pure reducer; no database code, no clock, no I/O.
 *
 * Where each part lives (plan section 2, "Storage"):
 *  - `inventory.keywordPool` (WebsiteInventory jsonb, record limit 4 MB):
 *      the measured rows (capped at 300), the market, and the cost ledger.
 *      `saveInventory` is a blind upsert today, so the wiring release needs a
 *      locked read-modify-write and must carry `keywordPool` over in the daily
 *      inventory refresh.
 *  - `settings.programme.keywordChoices` (Brand settings jsonb): dismissed and
 *      chosen phrases and owner-typed seeds. Must stay OUTSIDE the programme
 *      input hash, or every dismissal would invalidate a running plan.
 *  - Per-phrase states other than "dismissed" are derived, never stored.
 *
 * Size: 500 rows serialise to about 300 KB (see the size test; the one-sentence
 * reason is a quarter of it), about 7% of the 4 MB record limit; the planned
 * 300-row cap keeps the pool near 180 KB plus a ledger of at most ~40 KB.
 */

import type { KeywordIntent, KeywordCandidateSource } from '../keyword/types.js';
import type { PoolRow, SearchBasis } from './keyword-pool.js';

export const KEYWORD_POOL_SCHEMA = 1 as const;
export const KEYWORD_POOL_ROW_CAP = 300;
export const LEDGER_ENTRY_CAP = 200;
export const CHOICE_CAP = 1000;

/** How old a measurement may be before it is refreshed (plan section 2, "Freshness"). */
export const FRESHNESS = Object.freeze({
  /** Searches and difficulty are fresh for 30 days … */
  measurementFreshDays: 30,
  /** … shown with their month for up to 90, and re-measured before any use after that. */
  measurementShowDays: 90,
  /** The site's own rankings. */
  ownRankingFreshDays: 14,
  /** Analysis of the top results for a phrase. */
  serpFreshDays: 30,
});

export type Freshness = 'fresh' | 'shown_with_month' | 'expired';

const DAY = 86_400_000;
export function freshness(measuredAt: string, now: string, kind: 'measurement' | 'own_ranking' | 'serp' = 'measurement'): Freshness {
  const age = Date.parse(now) - Date.parse(measuredAt);
  if (!Number.isFinite(age)) return 'expired';
  const fresh = kind === 'own_ranking' ? FRESHNESS.ownRankingFreshDays : kind === 'serp' ? FRESHNESS.serpFreshDays : FRESHNESS.measurementFreshDays;
  if (age <= fresh * DAY) return 'fresh';
  if (kind === 'measurement' && age <= FRESHNESS.measurementShowDays * DAY) return 'shown_with_month';
  return 'expired';
}

/** One stored row: the pool row's facts plus when they were measured. Display labels are rebuilt from these facts, not stored; the reason is stored because it depends on the Brand DNA at build time. */
export interface StoredKeywordRow {
  readonly id: string;
  readonly key: string;
  readonly phrase: string;
  readonly basis: SearchBasis;
  readonly searches: number | null;
  readonly measuredMonth: string | null;
  readonly parent: string | null;
  readonly parentSearches: number | null;
  readonly rankingDifficulty: number | null;
  readonly intent: KeywordIntent | null;
  readonly sources: readonly KeywordCandidateSource[];
  readonly clusterId: string;
  readonly role: 'pillar' | 'supporting';
  readonly ownPosition: number | null;
  readonly covered?: { readonly url: string | null; readonly how: string; readonly position?: number } | null;
  readonly opportunity: number;
  readonly why: string;
  /** When the supplier answered for this row (ISO). Drives freshness. */
  readonly measuredAt: string;
  readonly ownRankingAt?: string | null;
}

export interface CostLedgerEntry {
  readonly at: string;
  /** Internal endpoint name (founder-only). */
  readonly endpoint: string;
  /** The research attempt this spend belongs to (programme attempt nonce). */
  readonly attemptNonce: string;
  readonly providerReportedCost: number | null;
  readonly rows: number;
  readonly outcome: 'ok' | 'no_data' | 'pending' | 'failed';
  readonly diagnosticCategory: string | null;
}

export interface CostLedger {
  /** Most recent entries first, capped; older entries survive only in the month totals. */
  readonly entries: readonly CostLedgerEntry[];
  /** 'YYYY-MM' → calls and summed supplier-reported cost (USD). Calls with an unreported cost count in `unpriced`. */
  readonly months: Readonly<Record<string, { readonly calls: number; readonly cost: number; readonly unpriced: number }>>;
}

/** `inventory.keywordPool` */
export interface StoredKeywordPool {
  readonly schema: typeof KEYWORD_POOL_SCHEMA;
  readonly locationCode: number;
  readonly languageCode: string;
  readonly builtAt: string | null;
  readonly rows: readonly StoredKeywordRow[];
  readonly state: 'measured' | 'thin' | 'no_data' | 'empty';
  readonly ledger: CostLedger;
}

/** `settings.programme.keywordChoices` */
export interface KeywordChoices {
  readonly schema: typeof KEYWORD_POOL_SCHEMA;
  readonly dismissed: readonly { readonly key: string; readonly phrase: string; readonly at: string; readonly by: string }[];
  readonly chosen: readonly { readonly key: string; readonly phrase: string; readonly at: string; readonly by: string; readonly commandId: string }[];
  readonly ownerSeeds: readonly { readonly phrase: string; readonly at: string; readonly by: string }[];
}

export interface KeywordStore {
  readonly pool: StoredKeywordPool;
  readonly choices: KeywordChoices;
}

export function emptyKeywordStore(locationCode: number, languageCode: string): KeywordStore {
  return {
    pool: { schema: KEYWORD_POOL_SCHEMA, locationCode, languageCode, builtAt: null, rows: [], state: 'empty', ledger: { entries: [], months: {} } },
    choices: { schema: KEYWORD_POOL_SCHEMA, dismissed: [], chosen: [], ownerSeeds: [] },
  };
}

export type KeywordStoreEvent =
  /** A rebuilt pool. Rows not in the new pool but measured within the show window are carried over, so a thin rebuild never erases good data. */
  | { readonly type: 'pool_built'; readonly at: string; readonly rows: readonly PoolRow[]; readonly state: 'measured' | 'thin' | 'no_data' }
  | { readonly type: 'cost_recorded'; readonly entry: CostLedgerEntry }
  | { readonly type: 'dismissed'; readonly key: string; readonly phrase: string; readonly at: string; readonly by: string }
  | { readonly type: 'undismissed'; readonly key: string }
  | { readonly type: 'chosen'; readonly key: string; readonly phrase: string; readonly at: string; readonly by: string; readonly commandId: string }
  | { readonly type: 'owner_seed_added'; readonly phrase: string; readonly at: string; readonly by: string }
  | { readonly type: 'expired_pruned'; readonly now: string };

const byKey = <T extends { key: string }>(a: T, b: T) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function toStored(row: PoolRow, at: string, prior: StoredKeywordRow | undefined): StoredKeywordRow {
  return {
    id: row.id, key: row.key, phrase: row.phrase, basis: row.basis, searches: row.searches, measuredMonth: row.measuredMonth,
    parent: row.parent, parentSearches: row.parentSearches, rankingDifficulty: row.rankingDifficulty, intent: row.intent,
    sources: row.sources, clusterId: row.clusterId, role: row.role, ownPosition: row.ownPosition, opportunity: row.opportunity, why: row.why,
    measuredAt: at,
    ownRankingAt: row.ownPosition !== null ? at : prior?.ownRankingAt ?? null,
  };
}

/**
 * Pure reducer. Same events in the same order always give the same store.
 * Guarantees: a dismissed key never re-enters `pool.rows`; choices are idempotent
 * by key (and by command id for "chosen"); every list is capped.
 */
export function reduceKeywordStore(store: KeywordStore, event: KeywordStoreEvent): KeywordStore {
  switch (event.type) {
    case 'pool_built': {
      const dismissed = new Set(store.choices.dismissed.map((d) => d.key));
      const prior = new Map(store.pool.rows.map((r) => [r.key, r]));
      const fresh = event.rows.filter((r) => !dismissed.has(r.key)).map((r) => toStored(r, event.at, prior.get(r.key)));
      const freshKeys = new Set(fresh.map((r) => r.key));
      const carried = store.pool.rows.filter((r) => !freshKeys.has(r.key) && !dismissed.has(r.key) && freshness(r.measuredAt, event.at) !== 'expired');
      const rows = [...fresh, ...carried.sort((a, b) => b.opportunity - a.opportunity || byKey(a, b))].slice(0, KEYWORD_POOL_ROW_CAP);
      return { ...store, pool: { ...store.pool, builtAt: event.at, rows, state: rows.length ? event.state : 'no_data' } };
    }
    case 'cost_recorded': {
      const month = event.entry.at.slice(0, 7);
      const m = store.pool.ledger.months[month] ?? { calls: 0, cost: 0, unpriced: 0 };
      const cost = event.entry.providerReportedCost;
      const months = {
        ...store.pool.ledger.months,
        [month]: { calls: m.calls + 1, cost: Math.round((m.cost + (cost ?? 0)) * 1e6) / 1e6, unpriced: m.unpriced + (cost === null ? 1 : 0) },
      };
      const entries = [event.entry, ...store.pool.ledger.entries].slice(0, LEDGER_ENTRY_CAP);
      return { ...store, pool: { ...store.pool, ledger: { entries, months } } };
    }
    case 'dismissed': {
      if (store.choices.dismissed.some((d) => d.key === event.key)) return store;
      const dismissed = [...store.choices.dismissed, { key: event.key, phrase: event.phrase, at: event.at, by: event.by }].slice(-CHOICE_CAP);
      return {
        pool: { ...store.pool, rows: store.pool.rows.filter((r) => r.key !== event.key) },
        choices: { ...store.choices, dismissed, chosen: store.choices.chosen.filter((c) => c.key !== event.key) },
      };
    }
    case 'undismissed':
      return { ...store, choices: { ...store.choices, dismissed: store.choices.dismissed.filter((d) => d.key !== event.key) } };
    case 'chosen': {
      if (store.choices.dismissed.some((d) => d.key === event.key)) return store;
      if (store.choices.chosen.some((c) => c.key === event.key || c.commandId === event.commandId)) return store;
      const chosen = [...store.choices.chosen, { key: event.key, phrase: event.phrase, at: event.at, by: event.by, commandId: event.commandId }].slice(-CHOICE_CAP);
      return { ...store, choices: { ...store.choices, chosen } };
    }
    case 'owner_seed_added': {
      if (store.choices.ownerSeeds.some((s) => s.phrase === event.phrase)) return store;
      const ownerSeeds = [...store.choices.ownerSeeds, { phrase: event.phrase, at: event.at, by: event.by }].slice(-100);
      return { ...store, choices: { ...store.choices, ownerSeeds } };
    }
    case 'expired_pruned': {
      const rows = store.pool.rows.filter((r) => freshness(r.measuredAt, event.now) !== 'expired');
      return rows.length === store.pool.rows.length ? store : { ...store, pool: { ...store.pool, rows } };
    }
  }
}
