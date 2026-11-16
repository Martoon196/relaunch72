/**
 * Keyword-data rail — real search volume for Soro's fan-out queries.
 *
 * `KeywordProvider` is the swappable seam (same mock/live pattern as the LLM
 * client and the socials publisher): a MockKeywordProvider (deterministic,
 * source-labelled 'mock', zero cost) and a DataForSeoProvider (live, key-guarded).
 * A later provider (SerpApi, Keywords Everywhere, …) is a new adapter, not a
 * rewrite. See decisions D-055.
 *
 * INTEGRITY: every metric carries its `source`. Mock volumes are labelled 'mock'
 * and must never be shown to a paying customer as real, nor woven into
 * customer-facing article prose. Keyword data is a planning/prioritisation
 * artifact; the no-invention rule still governs what reaches copy.
 */

export interface KeywordMetric {
  keyword: string;
  /** Monthly search volume (null if the provider has no data for it). */
  volume: number | null;
  /**
   * 0–100 competition/difficulty, if the provider supplies it.
   * NOTE: the live Google Ads adapter fills this with advertiser competition
   * (`competition_index`), which is NOT how hard it is to rank organically. Left
   * as-is so existing behaviour does not change; the correct measure is
   * `KeywordCandidate.rankingDifficulty` below.
   */
  difficulty: number | null;
  /** Cost-per-click in USD, if supplied. */
  cpc: number | null;
  /** Provenance — 'mock' data is never real and never customer-facing. */
  source: 'mock' | 'dataforseo';
}

export interface KeywordProvider {
  readonly mode: 'mock' | 'live';
  /** Volumes/metrics for a batch of keywords (order-independent; matched by keyword). */
  metrics(keywords: string[]): Promise<KeywordMetric[]>;
}

// ─── Keyword-first planning (foundation; not yet wired into the engine) ─────

/** What the searcher wants, as the keyword research supplier labels it. */
export type KeywordIntent = 'informational' | 'navigational' | 'commercial' | 'transactional';

/** Where a candidate phrase was found. Internal only: never shown to a business owner. */
export type KeywordCandidateSource =
  | 'site_keywords'      // phrases relevant to the business's own site
  | 'own_ranked'         // phrases the business's own site already ranks for
  | 'competitor_ranked'  // phrases a competitor site ranks for
  | 'ideas'              // ideas from several seeds
  | 'suggestions'        // longer phrases containing one seed
  | 'related'            // "related searches" for one seed
  | 'overview'           // an exact phrase measured on request (owner-typed or re-measured)
  | 'serp_question'      // a question people also ask, seen on a results page (no number)
  | 'serp_related'       // a related search seen on a results page (no number)
  | 'owner';             // typed by the owner, not yet measured

/**
 * One candidate phrase with the numbers the supplier measured for it. Every
 * number here was reported by the supplier; nothing is estimated or invented.
 * A null means "not measured", never zero.
 */
export interface KeywordCandidate {
  /** The phrase as the supplier returned it (untrusted text: normalise before display). */
  readonly phrase: string;
  /** Average monthly searches for this exact phrase, or null when not measured. */
  readonly searches: number | null;
  /** Latest month in the supplier's monthly series, as 'YYYY-MM'; null when unknown. */
  readonly measuredMonth: string | null;
  /** When the supplier last updated the volume figures (ISO 8601), when it says. */
  readonly dataUpdatedAt: string | null;
  /**
   * How hard it is to reach the first ten organic results, 0–100 (the supplier's
   * keyword difficulty, logarithmic). This is the ranking measure. Null when unrated.
   */
  readonly rankingDifficulty: number | null;
  /** Google Ads advertiser competition, 0–1. Kept for completeness; never used as difficulty. */
  readonly adCompetition: number | null;
  /** Cost per click in USD, when supplied. */
  readonly cpc: number | null;
  readonly intent: KeywordIntent | null;
  readonly secondaryIntents: readonly KeywordIntent[];
  readonly source: KeywordCandidateSource;
  /** The seed or wider phrase this candidate was found from, when there is one. */
  readonly parent: string | null;
  /** For ranked rows: the organic position and the address that ranks. */
  readonly ranking?: { readonly position: number; readonly url: string | null } | null;
  /** For competitor rows: the competitor domain it came from. */
  readonly competitorDomain?: string | null;
  readonly locationCode: number;
  readonly languageCode: string;
}
