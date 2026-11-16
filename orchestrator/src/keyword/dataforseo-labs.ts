/**
 * Keyword research client for keyword-first planning (foundation only: nothing
 * in the engine, planner, router or any screen calls this yet).
 *
 * Supplier: DataForSEO Labs (Google) for measured phrases, plus a FREE read of
 * an already-paid Google results task in its "advanced" form for the questions
 * people ask and related searches. Shapes verified against docs.dataforseo.com
 * on 16 Nov 2026 (see test/fixtures/dataforseo-labs/*.json, each of which names
 * the page it came from). Labs data is country-level only.
 *
 * Conventions (same as `seo-blog/research.ts`):
 *  - Basic auth; credentials never logged, never echoed into a diagnostic.
 *  - 30 s timeout. The transport never sleeps or retries itself: a retryable
 *    supplier code is reported on the diagnostic and the caller decides.
 *  - Every call returns its rows, the supplier-reported cost and a diagnostic
 *    built with the shared `researchDiagnostic` categories. Supplier errors are
 *    returned, not thrown, so the cost of a failed paid call is never lost.
 *  - A timeout or network failure is "unknown": the charge may have happened,
 *    so the call must not be repeated automatically.
 */

import type { KeywordCandidate, KeywordCandidateSource, KeywordIntent } from './types.js';
import { researchDiagnostic, type ResearchDiagnostic } from '../seo-blog/programme.js';

export const LABS_BASE = 'https://api.dataforseo.com/v3/dataforseo_labs/google';
export const SERP_BASE = 'https://api.dataforseo.com/v3/serp/google/organic';

/** The endpoints this client calls. Internal names: never shown to an owner. */
export type LabsEndpoint =
  | 'keyword_ideas' | 'keyword_suggestions' | 'related_keywords' | 'keywords_for_site'
  | 'ranked_keywords' | 'competitors_domain' | 'keyword_overview' | 'bulk_keyword_difficulty'
  | 'search_intent' | 'serp_advanced_read';

/** Documented request limits (docs.dataforseo.com, verified 16 Nov 2026). */
export const LABS_LIMITS = Object.freeze({
  ideasSeeds: 200,          // keyword_ideas: keywords max 200
  overviewKeywords: 700,    // keyword_overview: keywords max 700
  difficultyKeywords: 1000, // bulk_keyword_difficulty: keywords max 1000
  intentKeywords: 1000,     // search_intent: keywords max 1000
  maxRows: 1000,            // limit max 1000 on ideas/suggestions/related/site/ranked/competitors
  keywordChars: 80,         // keyword_overview: max 80 characters per keyword
  keywordWords: 10,         // keyword_overview: max 10 words per keyword
  relatedDepthMax: 4,
  competitorsMax: 1000,
});

/** Google location codes for the locales the product serves (mirrors research.ts). Labs is country-level only. */
export const LABS_LOCATION_FOR_LOCALE: Readonly<Record<string, number>> = Object.freeze({
  'en-GB': 2826, 'en-US': 2840, 'en-IE': 2372, 'en-AU': 2036, 'en-CA': 2124,
});

export interface LabsMarket {
  readonly locationCode: number;
  readonly languageCode: string;
}

export function marketForLocale(locale: string): LabsMarket {
  return { locationCode: LABS_LOCATION_FOR_LOCALE[locale] ?? 2826, languageCode: (locale.slice(0, 2) || 'en').toLowerCase() };
}

export type LabsCallStatus = 'ok' | 'no_data' | 'pending' | 'failed';

export interface LabsCallResult<Row> {
  readonly endpoint: LabsEndpoint;
  readonly status: LabsCallStatus;
  readonly rows: readonly Row[];
  /** Rows the supplier sent that could not be read (missing phrase, wrong types). */
  readonly skippedRows: number;
  /** Total rows the supplier says exist for this request (for "find more"), when it says. */
  readonly totalCount: number | null;
  /** Supplier-reported cost in USD; evidence, separate from the application's allowance. Null when not reported. */
  readonly providerReportedCost: number | null;
  readonly taskId: string | null;
  /** Null on ok / no_data / pending. Built from the shared research categories. */
  readonly diagnostic: ResearchDiagnostic | null;
}

export interface CompetitorDomain {
  readonly domain: string;
  readonly averagePosition: number | null;
  readonly sharedKeywords: number | null;
}

export interface DifficultyRow { readonly phrase: string; readonly rankingDifficulty: number | null }
export interface IntentRow { readonly phrase: string; readonly intent: KeywordIntent | null; readonly probability: number | null; readonly secondaryIntents: readonly KeywordIntent[] }

export interface SerpObservations {
  /** "People also ask" questions, in page order (no numbers: observed only). */
  readonly questions: readonly string[];
  /** "Related searches" and "people also search" phrases (no numbers). */
  readonly relatedSearches: readonly string[];
  /** Organic results, for later coverage analysis. */
  readonly organic: readonly { readonly position: number; readonly url: string; readonly title: string }[];
}

export interface RowsOptions { readonly limit?: number }

/** The swappable seam: a mock or a different supplier can stand in. */
export interface KeywordResearchProvider {
  readonly mode: 'live' | 'mock';
  keywordIdeas(seeds: readonly string[], market: LabsMarket, options?: RowsOptions): Promise<LabsCallResult<KeywordCandidate>>;
  keywordSuggestions(seed: string, market: LabsMarket, options?: RowsOptions): Promise<LabsCallResult<KeywordCandidate>>;
  relatedKeywords(seed: string, market: LabsMarket, options?: RowsOptions & { readonly depth?: number }): Promise<LabsCallResult<KeywordCandidate>>;
  keywordsForSite(domain: string, market: LabsMarket, options?: RowsOptions): Promise<LabsCallResult<KeywordCandidate>>;
  rankedKeywords(domain: string, market: LabsMarket, options?: RowsOptions & { readonly competitor?: boolean }): Promise<LabsCallResult<KeywordCandidate>>;
  competitorDomains(domain: string, market: LabsMarket, options?: RowsOptions): Promise<LabsCallResult<CompetitorDomain>>;
  keywordOverview(phrases: readonly string[], market: LabsMarket): Promise<LabsCallResult<KeywordCandidate>>;
  bulkKeywordDifficulty(phrases: readonly string[], market: LabsMarket): Promise<LabsCallResult<DifficultyRow>>;
  searchIntent(phrases: readonly string[], market: LabsMarket): Promise<LabsCallResult<IntentRow>>;
  /** FREE read of a Google results task already posted (and paid for) by the research provider. */
  readSerpObservations(taskId: string): Promise<LabsCallResult<SerpObservations>>;
}

// ─── Request hygiene ────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/g;

/** A phrase safe to send: NFKC, no control or invisible characters, single spaces, ≤ 80 chars and ≤ 10 words. */
export function requestPhrase(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.normalize('NFKC').replace(CONTROL, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text || !/\p{L}|\p{N}/u.test(text)) return null;
  if (text.length > LABS_LIMITS.keywordChars || text.split(' ').length > LABS_LIMITS.keywordWords) return null;
  return text;
}

function phraseList(raw: readonly string[], max: number): string[] {
  const out = new Map<string, string>();
  for (const value of raw) {
    const p = requestPhrase(value);
    if (p && !out.has(p)) out.set(p, p);
    if (out.size === max) break;
  }
  return [...out.values()];
}

/** The docs require a bare domain: no scheme, no `www.`. Returns null for anything that is not a plausible host. */
export function requestDomain(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let host = raw.trim().toLowerCase();
  try { if (/^https?:\/\//.test(host)) host = new URL(host).hostname; } catch { return null; }
  host = host.replace(/\/.*$/, '').replace(/^www\./, '').replace(/\.$/, '');
  return /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ? host : null;
}

function clampLimit(value: number | undefined, fallback: number): number {
  const n = Number.isFinite(value) ? Math.trunc(value as number) : fallback;
  return Math.min(Math.max(n, 1), LABS_LIMITS.maxRows);
}

// ─── Response reading (pure; exported for fixture tests) ────────────────────

const INTENTS: ReadonlySet<string> = new Set(['informational', 'navigational', 'commercial', 'transactional']);
const intentOf = (v: unknown): KeywordIntent | null => (typeof v === 'string' && INTENTS.has(v) ? (v as KeywordIntent) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = (v: unknown): number | null => { const n = num(v); return n !== null && n >= 0 ? Math.round(n) : null; };
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function difficultyOf(v: unknown): number | null {
  const n = num(v);
  return n !== null && n >= 0 && n <= 100 ? Math.round(n) : null;
}

/** "2024-08-11 13:24:34 +00:00" → ISO 8601, or null. */
export function supplierTime(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\s*([+-]\d{2}):?(\d{2}))?/.exec(v.trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? `${m[7]}:${m[8]}` : 'Z'}`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Latest year/month in `monthly_searches`, as 'YYYY-MM'. */
export function latestMonth(monthly: unknown): string | null {
  let best: number | null = null;
  for (const entry of arr(monthly)) {
    const e = obj(entry);
    const y = count(e?.year); const mo = count(e?.month);
    if (y === null || mo === null || mo < 1 || mo > 12 || y < 2000 || y > 2100) continue;
    const key = y * 100 + mo;
    if (best === null || key > best) best = key;
  }
  return best === null ? null : `${Math.floor(best / 100)}-${String(best % 100).padStart(2, '0')}`;
}

/**
 * One Labs keyword record. The same nested shape (`keyword_info`,
 * `keyword_properties.keyword_difficulty`, `search_intent_info.main_intent`)
 * is used by ideas, suggestions, site keywords and overview items, and inside
 * `keyword_data` of related and ranked items.
 */
export function readKeywordRecord(
  raw: unknown,
  ctx: { readonly source: KeywordCandidateSource; readonly parent: string | null; readonly market: LabsMarket; readonly competitorDomain?: string | null },
  ranking?: { readonly position: number; readonly url: string | null } | null,
): KeywordCandidate | null {
  const r = obj(raw);
  const phrase = typeof r?.keyword === 'string' ? r.keyword : null;
  if (!r || !phrase || !phrase.trim()) return null;
  const info = obj(r.keyword_info);
  const props = obj(r.keyword_properties);
  const intent = obj(r.search_intent_info);
  const searches = count(info?.search_volume);
  return {
    phrase,
    searches,
    measuredMonth: searches === null ? null : latestMonth(info?.monthly_searches) ?? supplierTime(info?.last_updated_time)?.slice(0, 7) ?? null,
    dataUpdatedAt: supplierTime(info?.last_updated_time),
    rankingDifficulty: difficultyOf(props?.keyword_difficulty),
    adCompetition: (() => { const c = num(info?.competition); return c !== null && c >= 0 && c <= 1 ? c : null; })(),
    cpc: (() => { const c = num(info?.cpc); return c !== null && c >= 0 ? c : null; })(),
    intent: intentOf(intent?.main_intent),
    secondaryIntents: arr(intent?.foreign_intent).map(intentOf).filter((i): i is KeywordIntent => i !== null),
    source: ctx.source,
    parent: ctx.parent,
    ...(ranking !== undefined ? { ranking } : {}),
    ...(ctx.competitorDomain !== undefined ? { competitorDomain: ctx.competitorDomain } : {}),
    locationCode: count(r.location_code) ?? ctx.market.locationCode,
    languageCode: typeof r.language_code === 'string' ? r.language_code : ctx.market.languageCode,
  };
}

/** Reads `ranked_keywords` items: `keyword_data` plus `ranked_serp_element.serp_item` (organic position). */
export function readRankedItem(raw: unknown, ctx: { readonly source: KeywordCandidateSource; readonly market: LabsMarket; readonly competitorDomain?: string | null }): KeywordCandidate | null {
  const item = obj(raw);
  const element = obj(item?.ranked_serp_element);
  const serp = obj(element?.serp_item);
  const position = count(serp?.rank_group);
  const ranking = position !== null && position > 0 ? { position, url: typeof serp?.url === 'string' ? serp.url : null } : null;
  const row = readKeywordRecord(item?.keyword_data, { ...ctx, parent: null }, ranking);
  if (!row) return null;
  // The ranked element carries its own copy of difficulty; use it only when the keyword record has none.
  return row.rankingDifficulty === null ? { ...row, rankingDifficulty: difficultyOf(element?.keyword_difficulty) } : row;
}

export function readSerpObservations(result: unknown): SerpObservations {
  const items = arr(obj(result)?.items);
  const questions: string[] = []; const related: string[] = []; const organic: { position: number; url: string; title: string }[] = [];
  for (const raw of items) {
    const it = obj(raw);
    if (!it) continue;
    if (it.type === 'people_also_ask') {
      for (const q of arr(it.items)) { const t = obj(q)?.title; if (typeof t === 'string' && t.trim()) questions.push(t); }
    } else if (it.type === 'related_searches' || it.type === 'people_also_search') {
      for (const s of arr(it.items)) if (typeof s === 'string' && s.trim()) related.push(s);
    } else if (it.type === 'organic') {
      const position = count(it.rank_group);
      if (position && typeof it.url === 'string' && typeof it.title === 'string') organic.push({ position, url: it.url, title: it.title });
    }
  }
  return { questions, relatedSearches: related, organic };
}

// ─── Live client ────────────────────────────────────────────────────────────

interface Envelope {
  status_code?: unknown;
  cost?: unknown;
  tasks?: unknown;
}

const safeCost = (raw: unknown): number | null => (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1_000_000 ? raw : null);

/** Supplier code for "no results matching the request". An answer, not a failure. */
const NO_RESULTS = 40102;

export class DataForSeoLabsProvider implements KeywordResearchProvider {
  readonly mode = 'live' as const;
  readonly #authorization: string;

  constructor(
    login: string,
    password: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {
    if (!login || !password) throw new Error('Keyword research credentials are not configured.');
    // Held privately; never part of an error, diagnostic or log line.
    this.#authorization = `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
  }

  async keywordIdeas(seeds: readonly string[], market: LabsMarket, options: RowsOptions = {}): Promise<LabsCallResult<KeywordCandidate>> {
    const keywords = phraseList(seeds, LABS_LIMITS.ideasSeeds);
    if (!keywords.length) return emptyRequest('keyword_ideas');
    const body = { keywords, location_code: market.locationCode, language_code: market.languageCode, limit: clampLimit(options.limit, 300) };
    return this.rows('keyword_ideas', body, (r) => arr(r.items).map((i) => readKeywordRecord(i, { source: 'ideas', parent: null, market })));
  }

  async keywordSuggestions(seed: string, market: LabsMarket, options: RowsOptions = {}): Promise<LabsCallResult<KeywordCandidate>> {
    const keyword = requestPhrase(seed);
    if (!keyword) return emptyRequest('keyword_suggestions');
    // location_code is optional for this endpoint and its absence means "all locations": always send it.
    // include_seed_keyword: the seed's own numbers come back in seed_keyword_data, so the wider-phrase
    // rung of the ladder has a measured parent without a second call.
    const body = { keyword, location_code: market.locationCode, language_code: market.languageCode, include_seed_keyword: true, limit: clampLimit(options.limit, 100) };
    return this.rows('keyword_suggestions', body, (r) => [
      ...(obj(r.seed_keyword_data) ? [readKeywordRecord(r.seed_keyword_data, { source: 'suggestions', parent: null, market })] : []),
      ...arr(r.items).map((i) => readKeywordRecord(i, { source: 'suggestions', parent: keyword, market })),
    ]);
  }

  async relatedKeywords(seed: string, market: LabsMarket, options: RowsOptions & { readonly depth?: number } = {}): Promise<LabsCallResult<KeywordCandidate>> {
    const keyword = requestPhrase(seed);
    if (!keyword) return emptyRequest('related_keywords');
    const depth = Math.min(Math.max(Math.trunc(options.depth ?? 1), 0), LABS_LIMITS.relatedDepthMax);
    const body = { keyword, location_code: market.locationCode, language_code: market.languageCode, depth, limit: clampLimit(options.limit, 100) };
    return this.rows('related_keywords', body, (r) => arr(r.items).map((i) => readKeywordRecord(obj(i)?.keyword_data, { source: 'related', parent: keyword, market })));
  }

  async keywordsForSite(domain: string, market: LabsMarket, options: RowsOptions = {}): Promise<LabsCallResult<KeywordCandidate>> {
    const target = requestDomain(domain);
    if (!target) return emptyRequest('keywords_for_site');
    const body = { target, location_code: market.locationCode, language_code: market.languageCode, limit: clampLimit(options.limit, 200) };
    return this.rows('keywords_for_site', body, (r) => arr(r.items).map((i) => readKeywordRecord(i, { source: 'site_keywords', parent: null, market })));
  }

  async rankedKeywords(domain: string, market: LabsMarket, options: RowsOptions & { readonly competitor?: boolean } = {}): Promise<LabsCallResult<KeywordCandidate>> {
    const target = requestDomain(domain);
    if (!target) return emptyRequest('ranked_keywords');
    const body = {
      target, location_code: market.locationCode, language_code: market.languageCode,
      item_types: ['organic'], limit: clampLimit(options.limit, 200),
      order_by: ['keyword_data.keyword_info.search_volume,desc'],
    };
    const source: KeywordCandidateSource = options.competitor ? 'competitor_ranked' : 'own_ranked';
    return this.rows('ranked_keywords', body, (r) => arr(r.items).map((i) => readRankedItem(i, { source, market, ...(options.competitor ? { competitorDomain: target } : {}) })));
  }

  async competitorDomains(domain: string, market: LabsMarket, options: RowsOptions = {}): Promise<LabsCallResult<CompetitorDomain>> {
    const target = requestDomain(domain);
    if (!target) return emptyRequest('competitors_domain');
    const body = { target, location_code: market.locationCode, language_code: market.languageCode, exclude_top_domains: true, limit: clampLimit(options.limit, 10) };
    return this.rows('competitors_domain', body, (r) => arr(r.items).map((raw) => {
      const i = obj(raw);
      const d = typeof i?.domain === 'string' ? requestDomain(i.domain) : null;
      if (!d || d === target) return null;
      return { domain: d, averagePosition: num(i?.avg_position), sharedKeywords: count(i?.intersections) };
    }));
  }

  async keywordOverview(phrases: readonly string[], market: LabsMarket): Promise<LabsCallResult<KeywordCandidate>> {
    const keywords = phraseList(phrases, LABS_LIMITS.overviewKeywords);
    if (!keywords.length) return emptyRequest('keyword_overview');
    const body = { keywords, location_code: market.locationCode, language_code: market.languageCode };
    return this.rows('keyword_overview', body, (r) => arr(r.items).map((i) => readKeywordRecord(i, { source: 'overview', parent: null, market })));
  }

  async bulkKeywordDifficulty(phrases: readonly string[], market: LabsMarket): Promise<LabsCallResult<DifficultyRow>> {
    const keywords = phraseList(phrases, LABS_LIMITS.difficultyKeywords);
    if (!keywords.length) return emptyRequest('bulk_keyword_difficulty');
    const body = { keywords, location_code: market.locationCode, language_code: market.languageCode };
    return this.rows('bulk_keyword_difficulty', body, (r) => arr(r.items).map((raw) => {
      const i = obj(raw);
      return typeof i?.keyword === 'string' && i.keyword.trim() ? { phrase: i.keyword, rankingDifficulty: difficultyOf(i.keyword_difficulty) } : null;
    }));
  }

  /** Search intent takes keywords only (no location or language in the documented request). */
  async searchIntent(phrases: readonly string[], _market: LabsMarket): Promise<LabsCallResult<IntentRow>> {
    const keywords = phraseList(phrases, LABS_LIMITS.intentKeywords);
    if (!keywords.length) return emptyRequest('search_intent');
    return this.rows('search_intent', { keywords }, (r) => arr(r.items).map((raw) => {
      const i = obj(raw);
      if (typeof i?.keyword !== 'string' || !i.keyword.trim()) return null;
      const main = obj(i.keyword_intent);
      return {
        phrase: i.keyword, intent: intentOf(main?.label), probability: num(main?.probability),
        secondaryIntents: arr(i.secondary_keyword_intents).map((s) => intentOf(obj(s)?.label)).filter((s): s is KeywordIntent => s !== null),
      };
    }));
  }

  async readSerpObservations(taskId: string): Promise<LabsCallResult<SerpObservations>> {
    if (researchDiagnostic(null, null, taskId).taskId !== taskId) {
      return failed('serp_advanced_read', researchDiagnostic(null), 0, null);
    }
    const res = await this.send(`${SERP_BASE}/task_get/advanced/${taskId}`, undefined);
    if ('failure' in res) return { ...res.failure, endpoint: 'serp_advanced_read', providerReportedCost: 0 };
    // Reading a posted task is free (docs: "charged only for posting a task"); the GET merely echoes
    // the original task's cost, so every result of this method reports 0 to avoid double counting.
    const { task } = res;
    const id = typeof task.id === 'string' ? task.id : null;
    if (id !== taskId) return failed('serp_advanced_read', researchDiagnostic(null, res.httpStatus, task.id), 0, null);
    if (task.status_code === 40601 || task.status_code === 40602) return { endpoint: 'serp_advanced_read', status: 'pending', rows: [], skippedRows: 0, totalCount: null, providerReportedCost: 0, taskId, diagnostic: null };
    if (task.status_code !== 20000 || !obj(arr(task.result)[0])) return failed('serp_advanced_read', researchDiagnostic(num(task.status_code), res.httpStatus, taskId), 0, taskId);
    const observations = readSerpObservations(arr(task.result)[0]);
    const empty = !observations.questions.length && !observations.relatedSearches.length && !observations.organic.length;
    return { endpoint: 'serp_advanced_read', status: empty ? 'no_data' : 'ok', rows: empty ? [] : [observations], skippedRows: 0, totalCount: null, providerReportedCost: 0, taskId, diagnostic: null };
  }

  private async rows<Row>(endpoint: Exclude<LabsEndpoint, 'serp_advanced_read'>, body: Record<string, unknown>, read: (result: Record<string, unknown>) => (Row | null)[]): Promise<LabsCallResult<Row>> {
    const res = await this.send(`${LABS_BASE}/${endpoint}/live`, [body]);
    if ('failure' in res) return { ...res.failure, endpoint } as LabsCallResult<Row>;
    const { task, cost, httpStatus } = res;
    const taskId = researchDiagnostic(null, null, task.id).taskId;
    if (task.status_code === NO_RESULTS) return { endpoint, status: 'no_data', rows: [], skippedRows: 0, totalCount: 0, providerReportedCost: cost, taskId, diagnostic: null };
    if (task.status_code !== 20000) return failed(endpoint, researchDiagnostic(num(task.status_code), httpStatus, task.id), cost, taskId);
    const result = obj(arr(task.result)[0]);
    if (!result) {
      return { endpoint, status: 'no_data', rows: [], skippedRows: 0, totalCount: 0, providerReportedCost: cost, taskId, diagnostic: null };
    }
    const read_ = read(result);
    const rows = read_.filter((r): r is Row => r !== null);
    return { endpoint, status: rows.length ? 'ok' : 'no_data', rows, skippedRows: read_.length - rows.length, totalCount: count(result.total_count), providerReportedCost: cost, taskId, diagnostic: null };
  }

  private async send(url: string, body: unknown): Promise<
    | { failure: Omit<LabsCallResult<never>, 'endpoint'> }
    | { task: { id?: unknown; status_code?: unknown; result?: unknown }; cost: number | null; httpStatus: number }
  > {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: this.#authorization, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Timeout or network failure: the supplier may have charged; never retried automatically.
      return { failure: failedBody(researchDiagnostic(null), null, null) };
    }
    if (!res.ok) return { failure: failedBody(researchDiagnostic(null, res.status), null, null) };
    const json = (await res.json().catch(() => ({}))) as Envelope;
    const task = obj(arr(json.tasks)[0]) as { id?: unknown; status_code?: unknown; cost?: unknown; result?: unknown } | null;
    const cost = safeCost(task?.cost ?? json.cost);
    if (json.status_code !== 20000 || !task) {
      return { failure: failedBody(researchDiagnostic(num(json.status_code), res.status, task?.id), cost, researchDiagnostic(null, null, task?.id).taskId) };
    }
    return { task, cost, httpStatus: res.status };
  }
}

function failedBody(diagnostic: ResearchDiagnostic, cost: number | null, taskId: string | null): Omit<LabsCallResult<never>, 'endpoint'> {
  return { status: 'failed', rows: [], skippedRows: 0, totalCount: null, providerReportedCost: cost, taskId, diagnostic };
}
function failed<Row>(endpoint: LabsEndpoint, diagnostic: ResearchDiagnostic, cost: number | null, taskId: string | null): LabsCallResult<Row> {
  return { endpoint, ...failedBody(diagnostic, cost, taskId) };
}
/** Nothing worth sending: no request is made and nothing is spent. */
function emptyRequest<Row>(endpoint: LabsEndpoint): LabsCallResult<Row> {
  return { endpoint, status: 'no_data', rows: [], skippedRows: 0, totalCount: 0, providerReportedCost: 0, taskId: null, diagnostic: null };
}

/**
 * Same credential resolution as research (`SEO_BLOG_DATAFORSEO_*` first, then
 * the un-prefixed names), so a deployment with either set gets both. Returns
 * null when not configured. Not called by production code yet.
 */
export function configuredKeywordResearchProvider(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): DataForSeoLabsProvider | null {
  const login = env.SEO_BLOG_DATAFORSEO_LOGIN || env.DATAFORSEO_LOGIN || '';
  const password = env.SEO_BLOG_DATAFORSEO_PASSWORD || env.DATAFORSEO_PASSWORD || '';
  if (env.SEO_BLOG_RESEARCH_PROVIDER === 'none' || !login || !password) return null;
  return new DataForSeoLabsProvider(login, password, fetchImpl);
}
