/**
 * Filling a business's keyword list (release 4 of the SEO quality plan): which supplier calls to make, how a call is
 * served from the cache, and how the stored list is rebuilt. Pure: no I/O, no clock. The engine runs the calls one at
 * a time through `store.keywordBoundary`, which reserves one research attempt before each call starts, saves its
 * receipt and supplier-reported cost after, and never repeats a call whose outcome is unknown.
 *
 * Behind SEO_BLOG_KEYWORD_POOL=true (off by default). Storage is jsonb on records that exist today (no migration):
 * the list, its cost ledger and the call cache on `inventory.keywordPool`; owner choices on
 * `settings.programme.keywordChoices` (read here, written by later releases).
 */

import { createHash } from 'node:crypto';
import type { KeywordCandidate } from '../keyword/types.js';
import { requestDomain, type KeywordResearchProvider, type LabsCallResult, type LabsMarket } from '../keyword/dataforseo-labs.js';
import { buildKeywordPool, businessSeeds, phraseKey, type KeywordPool, type PoolBusiness } from './keyword-pool.js';
import { emptyKeywordStore, freshness, KEYWORD_POOL_SCHEMA, reduceKeywordStore, type KeywordChoices, type StoredKeywordPool, type StoredKeywordRow } from './keyword-store-shape.js';
import type { Job, WebsiteInventory } from './types.js';

export const KEYWORD_POOL_FLAG = 'SEO_BLOG_KEYWORD_POOL';
export function keywordPoolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[KEYWORD_POOL_FLAG]?.trim() === 'true';
}

/** At most this many supplier calls in one fill (each is one research attempt). */
export const KEYWORD_FILL_CALLS = 6;
/** Rows asked for per call. */
export const FILL_LIMITS = Object.freeze({ site: 200, ranked: 200, ideas: 300, suggestions: 100, ideaSeeds: 20, suggestionSeeds: 3 });
/** Raw rows kept per cached call (bounded so the inventory record stays well under its size limit). */
export const CACHED_ROWS_CAP = 300;

export type FillCallKind = 'site' | 'ranked' | 'ideas' | 'suggestions';
export interface FillCall {
  readonly kind: FillCallKind;
  /** Stable cache key: the call and its exact arguments and market. */
  readonly sha: string;
  readonly endpoint: string;
  readonly args: readonly string[];
  /** Own rankings go stale sooner than measurements. */
  readonly freshness: 'measurement' | 'own_ranking';
}

/** A saved answer for one call: its rows (capped) and the facts needed to reuse it. */
export interface CachedCall {
  readonly sha: string;
  readonly endpoint: string;
  readonly at: string;
  readonly status: 'ok' | 'no_data';
  readonly rows: readonly KeywordCandidate[];
}

/** One attempt in a fill job's payload: reserved before the call, completed by its receipt. */
export interface FillAttempt {
  readonly sha: string;
  readonly endpoint: string;
  readonly nonce: string;
  readonly startedAt: string;
  readonly receivedAt?: string;
  readonly status?: 'ok' | 'no_data' | 'failed';
  readonly providerReportedCost?: number | null;
  readonly rows?: number;
  readonly diagnosticCategory?: string | null;
}

/** `inventory.keywordPool`: the stored list (as the foundation proposed) plus the call cache. */
export interface InventoryKeywordPool extends StoredKeywordPool {
  readonly calls?: readonly CachedCall[];
}

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The calls for one fill, in order. Deterministic for the same business, inventory and market. */
export function fillCalls(business: PoolBusiness, market: LabsMarket): FillCall[] {
  const calls: FillCall[] = [];
  const domain = business.website ? requestDomain(business.website) : null;
  const add = (kind: FillCallKind, endpoint: string, args: string[], fresh: FillCall['freshness'] = 'measurement') =>
    calls.push({ kind, endpoint, args, freshness: fresh, sha: sha({ endpoint, args, market: [market.locationCode, market.languageCode] }) });
  if (domain) {
    add('site', 'keywords_for_site', [domain]);
    add('ranked', 'ranked_keywords', [domain], 'own_ranking');
  }
  const seeds = businessSeeds(business).map((s) => s.phrase);
  if (seeds.length) add('ideas', 'keyword_ideas', seeds.slice(0, FILL_LIMITS.ideaSeeds));
  for (const seed of seeds.slice(0, FILL_LIMITS.suggestionSeeds)) add('suggestions', 'keyword_suggestions', [seed]);
  return calls.slice(0, KEYWORD_FILL_CALLS);
}

/** Run one call against the research provider. */
export function runFillCall(provider: KeywordResearchProvider, call: FillCall, market: LabsMarket): Promise<LabsCallResult<KeywordCandidate>> {
  switch (call.kind) {
    case 'site': return provider.keywordsForSite(call.args[0]!, market, { limit: FILL_LIMITS.site });
    case 'ranked': return provider.rankedKeywords(call.args[0]!, market, { limit: FILL_LIMITS.ranked });
    case 'ideas': return provider.keywordIdeas(call.args, market, { limit: FILL_LIMITS.ideas });
    case 'suggestions': return provider.keywordSuggestions(call.args[0]!, market, { limit: FILL_LIMITS.suggestions });
  }
}

/** A cached answer still fresh enough to serve instead of a new call (a page view or a repeat never spends). */
export function cachedFor(pool: InventoryKeywordPool | null | undefined, call: FillCall, now: string): CachedCall | null {
  const hit = pool?.calls?.find((c) => c.sha === call.sha);
  return hit && freshness(hit.at, now, call.freshness) === 'fresh' ? hit : null;
}

// ─── One shape check for every reader (planning, the fill and the Keywords page) ─────────────────────────────

/**
 * What is stored on `inventory.keywordPool`:
 * - 'absent': no list yet;
 * - 'ok': a readable list of this schema (rows that are not readable are left out, never guessed at);
 * - 'damaged': this schema but not readable as a list (a fill may rebuild it, keeping a readable cost ledger);
 * - 'newer': written by a newer release; read as no list, and never overwritten by this one.
 * Never throws.
 */
export type KeywordPoolRead =
  | { readonly status: 'absent' | 'damaged' | 'newer'; readonly pool: null; readonly ledger: StoredKeywordPool['ledger'] | null }
  | { readonly status: 'ok'; readonly pool: InventoryKeywordPool; readonly ledger: StoredKeywordPool['ledger'] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown) => v === null || isNum(v);
const strOrNull = (v: unknown) => v === null || isStr(v);
const BASES = new Set(['measured', 'parent_phrase', 'observed', 'none']);

function readableRow(r: unknown): r is StoredKeywordRow {
  if (!isObj(r)) return false;
  return isStr(r.id) && r.id.length > 0 && isStr(r.key) && isStr(r.phrase) && r.phrase.trim().length > 0 && isStr(r.basis) && BASES.has(r.basis)
    && numOrNull(r.searches) && (r.searches === null || (r.searches as number) >= 0) && strOrNull(r.measuredMonth) && strOrNull(r.parent) && numOrNull(r.parentSearches)
    && numOrNull(r.rankingDifficulty) && strOrNull(r.intent) && isStr(r.clusterId) && (r.role === 'pillar' || r.role === 'supporting')
    && numOrNull(r.ownPosition) && isNum(r.opportunity) && isStr(r.why) && isStr(r.measuredAt) && Number.isFinite(Date.parse(r.measuredAt))
    && (r.sources === undefined || Array.isArray(r.sources));
}

function readableLedger(v: unknown): StoredKeywordPool['ledger'] | null {
  if (!isObj(v) || !Array.isArray(v.entries) || !isObj(v.months)) return null;
  if (!v.entries.every((x) => isObj(x) && isStr(x.at) && isStr(x.endpoint))) return null;
  if (!Object.values(v.months).every((m) => isObj(m) && isNum(m.calls) && isNum(m.cost) && isNum(m.unpriced))) return null;
  return v as unknown as StoredKeywordPool['ledger'];
}

function readableCall(c: unknown): c is CachedCall {
  return isObj(c) && isStr(c.sha) && isStr(c.endpoint) && isStr(c.at) && (c.status === 'ok' || c.status === 'no_data') && Array.isArray(c.rows);
}

export function readKeywordPool(value: unknown): KeywordPoolRead {
  if (value === undefined || value === null) return { status: 'absent', pool: null, ledger: null };
  if (!isObj(value)) return { status: 'damaged', pool: null, ledger: null };
  if (isNum(value.schema) && value.schema > KEYWORD_POOL_SCHEMA) return { status: 'newer', pool: null, ledger: null };
  const ledger = readableLedger(value.ledger);
  if (value.schema !== KEYWORD_POOL_SCHEMA || !Array.isArray(value.rows) || !isNum(value.locationCode) || !isStr(value.languageCode) || !strOrNull(value.builtAt)
    || !['measured', 'thin', 'no_data', 'empty'].includes(value.state as string) || !ledger) return { status: 'damaged', pool: null, ledger };
  const pool: InventoryKeywordPool = {
    schema: KEYWORD_POOL_SCHEMA, locationCode: value.locationCode, languageCode: value.languageCode, builtAt: value.builtAt as string | null,
    rows: value.rows.filter(readableRow), state: value.state as StoredKeywordPool['state'], ledger,
    ...(value.calls === undefined ? {} : { calls: Array.isArray(value.calls) ? value.calls.filter(readableCall) : [] }),
  };
  return { status: 'ok', pool, ledger };
}

/** The readable list on an inventory record, or null (absent, damaged or newer). */
export function readablePool(inventory: { readonly keywordPool?: unknown } | null | undefined): InventoryKeywordPool | null {
  return readKeywordPool(inventory?.keywordPool).pool;
}

/** Whether a list was measured for this market (a number measured for one country is never used for another). */
export function poolInMarket(pool: Pick<StoredKeywordPool, 'locationCode' | 'languageCode'> | null | undefined, market: LabsMarket | null): boolean {
  return !!pool && !!market && pool.locationCode === market.locationCode && pool.languageCode === market.languageCode;
}

/** The stored pool for a business in its market, or an empty one (an unreadable list is rebuilt; the caller refuses a newer-shaped one). */
export function storedPool(inventory: WebsiteInventory | null | undefined, market: LabsMarket): InventoryKeywordPool {
  const read = readKeywordPool(inventory?.keywordPool);
  return read.status === 'ok' && poolInMarket(read.pool, market) ? read.pool : emptyKeywordStore(market.locationCode, market.languageCode).pool;
}

export function emptyChoices(): KeywordChoices { return emptyKeywordStore(0, '').choices; }

/** Save one answer in the cache, replacing an older answer to the same call, and drop stale ones. */
export function withCachedCall(pool: InventoryKeywordPool, call: FillCall, answer: LabsCallResult<KeywordCandidate>, at: string): InventoryKeywordPool {
  const kept = (pool.calls ?? []).filter((c) => c.sha !== call.sha && freshness(c.at, at, 'measurement') === 'fresh');
  if (answer.status !== 'ok' && answer.status !== 'no_data') return { ...pool, calls: kept };
  return { ...pool, calls: [...kept, { sha: call.sha, endpoint: call.endpoint, at, status: answer.status, rows: answer.rows.slice(0, CACHED_ROWS_CAP) }] };
}

/** Record one call's cost on the pool's ledger (never for a cached answer). */
export function withCost(pool: InventoryKeywordPool, attempt: FillAttempt, answer: LabsCallResult<KeywordCandidate>, at: string): InventoryKeywordPool {
  const store = reduceKeywordStore({ pool, choices: emptyChoices() }, { type: 'cost_recorded', entry: {
    at, endpoint: attempt.endpoint, attemptNonce: attempt.nonce, providerReportedCost: answer.providerReportedCost, rows: answer.rows.length,
    outcome: answer.status, diagnosticCategory: answer.diagnostic?.category ?? null,
  } });
  return { ...store.pool, calls: pool.calls ?? [] };
}

/** Rebuild the list from every answer, keep good rows a thin rebuild would lose, never bring back a dismissed phrase. */
export function rebuiltPool(pool: InventoryKeywordPool, candidates: readonly KeywordCandidate[], business: PoolBusiness, choices: KeywordChoices, at: string): { pool: InventoryKeywordPool; built: KeywordPool } {
  const built = buildKeywordPool(candidates, business, { limit: 300 });
  let store = reduceKeywordStore({ pool, choices }, { type: 'expired_pruned', now: at });
  store = reduceKeywordStore(store, { type: 'pool_built', at, rows: built.rows, state: built.state });
  return { pool: { ...store.pool, calls: pool.calls ?? [] }, built };
}

/** The fill job's attempts. */
export function fillAttempts(job: Job): FillAttempt[] {
  const fill = job.payload.keywordFill as { attempts?: FillAttempt[] } | undefined;
  return Array.isArray(fill?.attempts) ? fill!.attempts : [];
}
export const isKeywordFillJob = (job: Job): boolean => job.kind === 'inventory' && typeof job.payload.keywordFill === 'object' && job.payload.keywordFill !== null;

/** Dismissed keys from the owner's choices. */
export function dismissedPhrases(choices: KeywordChoices | null | undefined): string[] {
  return (choices?.dismissed ?? []).map((d) => d.phrase);
}
export { phraseKey };

/** Neutral owner messages for a fill (no supplier, endpoint or mechanism). */
export const FILL_MESSAGE = {
  notAvailable: 'Keyword lists are not switched on yet.',
  needsWebsite: 'Add your website first, so we can find the searches that matter to your business.',
  needsBrandDna: 'Confirm your Brand DNA first, so we know what your business offers.',
  unknown: 'An earlier keyword search did not save its result, so it is paused rather than paid for twice. Please ask us to check it.',
  allFailed: 'We could not fetch your keyword list just now. Nothing more will be tried automatically; please try again later.',
  done: 'Your keyword list is up to date.',
  newer: 'Your keyword list was saved by a newer version of this service, so it was left as it is. Nothing was spent.',
} as const;
