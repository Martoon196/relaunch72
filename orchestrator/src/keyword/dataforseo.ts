/**
 * DataForSEO adapter — the live keyword provider (see decisions D-055).
 *
 * DataForSEO is the SEO-data backbone the category rents (8B keywords, 577M
 * SERPs); pay-as-you-go, Basic-auth. This is a thin, honest wrapper over the
 * Google Ads "search volume" endpoint. NOT exercised in tests/mock runs — it
 * activates only when DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD are set (the founder-
 * gated live step). Endpoint/shape per DataForSEO docs as of Jan 2026; verify
 * before the live run.
 */

import type { KeywordMetric, KeywordProvider } from './types.js';

const ENDPOINT = 'https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live';

export class DataForSeoProvider implements KeywordProvider {
  readonly mode = 'live' as const;

  constructor(
    private readonly login = process.env.DATAFORSEO_LOGIN ?? '',
    private readonly password = process.env.DATAFORSEO_PASSWORD ?? '',
    /** Google location code (2840 = United States). Override per customer market. */
    private readonly locationCode = Number(process.env.DATAFORSEO_LOCATION_CODE ?? 2840),
    private readonly languageCode = process.env.DATAFORSEO_LANGUAGE_CODE ?? 'en',
  ) {
    if (!this.login || !this.password) {
      throw new Error(
        'No DataForSEO credentials: set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD in <repo root>/.env — or run --mock for a no-cost dry run.',
      );
    }
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.login}:${this.password}`).toString('base64')}`;
  }

  async metrics(keywords: string[]): Promise<KeywordMetric[]> {
    const body = [{ keywords, location_code: this.locationCode, language_code: this.languageCode }];
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Authorization': this.authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`DataForSEO request failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw new Error(`DataForSEO HTTP ${res.status}`);
    const json = (await res.json().catch(() => ({}))) as {
      tasks?: Array<{ result?: Array<{ keyword?: string; search_volume?: number; competition_index?: number; cpc?: number }> }>;
    };
    const rows = json.tasks?.[0]?.result ?? [];
    const byKeyword = new Map(rows.map((r) => [String(r.keyword ?? '').toLowerCase(), r]));
    return keywords.map((keyword) => {
      const r = byKeyword.get(keyword.toLowerCase());
      return {
        keyword,
        volume: typeof r?.search_volume === 'number' ? r.search_volume : null,
        difficulty: typeof r?.competition_index === 'number' ? r.competition_index : null,
        cpc: typeof r?.cpc === 'number' ? r.cpc : null,
        source: 'dataforseo' as const,
      };
    });
  }
}
