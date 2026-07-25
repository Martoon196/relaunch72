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
  /** 0–100 competition/difficulty, if the provider supplies it. */
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
