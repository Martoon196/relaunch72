/**
 * Application-owned, replaceable research: a web-search provider seam plus
 * guarded page retrieval that records URL, title, retrieval time and a bounded
 * supporting passage for each source.
 *
 * Live provider: DataForSEO Google organic SERP (the supplier the keyword rail
 * already rents — no new plan). When no provider is configured the engine
 * reports research as unavailable; it never fabricates sources.
 */

import { randomUUID } from 'node:crypto';
import { parseHtmlPage } from './html.js';
import { topicTokens } from './dedupe.js';
import { sameSite } from './inventory.js';
import type { FetchTransport } from './safe-fetch.js';
import type { ResearchSource } from './types.js';
import { SeoBlogError } from './types.js';
import type { KeywordMetric, KeywordProvider } from '../keyword/types.js';

export interface SearchHit {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
}

export interface SearchProvider {
  readonly id: string;
  readonly mode: 'live' | 'unconfigured';
  search(query: string, options: { readonly locale: string; readonly limit: number }): Promise<SearchHit[]>;
}

export class ResearchUnavailableError extends SeoBlogError {
  constructor(message = 'No research provider is connected. Connect one before planning content.') {
    super(409, message, 'research_unavailable');
  }
}

export class UnconfiguredSearchProvider implements SearchProvider {
  readonly id = 'none';
  readonly mode = 'unconfigured' as const;
  async search(): Promise<SearchHit[]> {
    throw new ResearchUnavailableError();
  }
}

/** UK location by default; overridable per deployment. */
const LOCATION_FOR_LOCALE: Record<string, number> = { 'en-GB': 2826, 'en-US': 2840, 'en-IE': 2372, 'en-AU': 2036, 'en-CA': 2124 };

export class DataForSeoSerpProvider implements SearchProvider {
  readonly id = 'dataforseo-serp';
  readonly mode = 'live' as const;
  constructor(
    private readonly login: string,
    private readonly password: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!login || !password) throw new ResearchUnavailableError('Research credentials are not configured.');
  }

  async search(query: string, options: { readonly locale: string; readonly limit: number }): Promise<SearchHit[]> {
    const body = [{
      keyword: query.slice(0, 200),
      location_code: LOCATION_FOR_LOCALE[options.locale] ?? 2826,
      language_code: options.locale.slice(0, 2) || 'en',
      depth: Math.min(Math.max(options.limit, 1), 20),
    }];
    let res: Response;
    try {
      res = await this.fetchImpl('https://api.dataforseo.com/v3/serp/google/organic/live/regular', {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${this.login}:${this.password}`).toString('base64')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ResearchUnavailableError('The research provider could not be reached. Research is paused; try again later.');
    }
    if (!res.ok) throw new ResearchUnavailableError(`The research provider answered HTTP ${res.status}. Research is paused.`);
    const json = (await res.json().catch(() => ({}))) as {
      status_code?: number;
      tasks?: { status_code?: number; result?: { items?: { type?: string; url?: string; title?: string; description?: string }[] }[] }[];
    };
    const task = json.tasks?.[0];
    if (!task || (task.status_code !== undefined && task.status_code >= 40000)) {
      throw new ResearchUnavailableError('The research provider did not return results. Research is paused.');
    }
    const items = task.result?.[0]?.items ?? [];
    return items
      .filter((i) => i.type === 'organic' && typeof i.url === 'string' && typeof i.title === 'string')
      .slice(0, options.limit)
      .map((i) => ({ url: i.url!, title: i.title!.slice(0, 300), snippet: String(i.description ?? '').slice(0, 500) }));
  }
}

export function configuredSearchProvider(env: NodeJS.ProcessEnv = process.env): SearchProvider {
  const login = env.SEO_BLOG_DATAFORSEO_LOGIN ?? env.DATAFORSEO_LOGIN ?? '';
  const password = env.SEO_BLOG_DATAFORSEO_PASSWORD ?? env.DATAFORSEO_PASSWORD ?? '';
  if (env.SEO_BLOG_RESEARCH_PROVIDER === 'none' || !login || !password) return new UnconfiguredSearchProvider();
  return new DataForSeoSerpProvider(login, password);
}

const PRIMARY_HOSTS = [
  /(^|\.)gov\.uk$/, /(^|\.)gov\.scot$/, /(^|\.)gov\.wales$/, /(^|\.)legislation\.gov\.uk$/, /(^|\.)nidirect\.gov\.uk$/,
  /(^|\.)ons\.gov\.uk$/, /(^|\.)bankofengland\.co\.uk$/, /(^|\.)fca\.org\.uk$/, /(^|\.)nhs\.uk$/, /(^|\.)parliament\.uk$/,
  /(^|\.)ac\.uk$/, /(^|\.)gov$/, /(^|\.)europa\.eu$/, /(^|\.)police\.uk$/,
];

export function isPrimarySource(url: string, brandWebsite: string | null): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (brandWebsite && sameSite(url, brandWebsite)) return true;
    return PRIMARY_HOSTS.some((re) => re.test(host));
  } catch {
    return false;
  }
}

/** Choose the passage of `text` that best supports `query` (bounded, ≤ 600 chars). */
export function supportingPassage(text: string, query: string, max = 600): string {
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z0-9£“"])/).filter((s) => s.length > 30);
  if (sentences.length === 0) return text.slice(0, max).trim();
  const wanted = topicTokens(query);
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < sentences.length; i++) {
    const window = `${sentences[i]} ${sentences[i + 1] ?? ''}`;
    const tokens = topicTokens(window);
    let score = 0;
    for (const t of wanted) if (tokens.has(t)) score++;
    if (/\d/.test(window)) score += 0.5; // factual sentences tend to carry figures
    if (score > bestScore) { bestScore = score; best = i; }
  }
  let passage = sentences[best]!;
  for (let j = best + 1; j < sentences.length && passage.length + sentences[j]!.length < max; j++) passage += ` ${sentences[j]}`;
  return passage.slice(0, max).trim();
}

export interface ResearchBundle {
  readonly sources: ResearchSource[];
  readonly searchCalls: number;
  readonly notes: string[];
  readonly keywordMetrics: KeywordMetric[];
}

export async function researchQueries(input: {
  readonly queries: readonly string[];
  readonly search: SearchProvider;
  readonly transport: FetchTransport;
  readonly locale: string;
  readonly brandWebsite: string | null;
  readonly now: () => string;
  readonly perQuery?: number;
  readonly maxSources?: number;
  readonly keywordProvider?: KeywordProvider | null;
  readonly excludeHosts?: readonly string[];
}): Promise<ResearchBundle> {
  if (input.search.mode !== 'live') throw new ResearchUnavailableError();
  const perQuery = input.perQuery ?? 4;
  const maxSources = input.maxSources ?? 18;
  const sources: ResearchSource[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  let searchCalls = 0;
  for (const query of input.queries.slice(0, 8)) {
    let hits: SearchHit[];
    try {
      hits = await input.search.search(query, { locale: input.locale, limit: perQuery + 2 });
      searchCalls++;
    } catch (error) {
      if (error instanceof ResearchUnavailableError) throw error;
      notes.push(`Search for “${query}” failed.`);
      continue;
    }
    let kept = 0;
    // Prefer primary sources first within each query.
    const ordered = [...hits].sort((a, b) => Number(isPrimarySource(b.url, input.brandWebsite)) - Number(isPrimarySource(a.url, input.brandWebsite)));
    for (const hit of ordered) {
      if (kept >= perQuery || sources.length >= maxSources) break;
      let key: string;
      try { key = new URL(hit.url).toString(); } catch { continue; }
      if (seen.has(key)) continue;
      if ((input.excludeHosts ?? []).some((h) => sameSite(key, `https://${h}`))) continue;
      seen.add(key);
      try {
        const page = await input.transport.fetch(key, { maxBytes: 1_500_000 });
        if (page.status !== 200 || !/html|text\/plain/i.test(page.contentType)) { notes.push(`${key} could not be read (HTTP ${page.status}).`); continue; }
        const parsed = /html/i.test(page.contentType) ? parseHtmlPage(page.body.toString('utf8'), page.finalUrl) : null;
        const text = parsed ? parsed.text : page.body.toString('utf8');
        const passage = supportingPassage(text, query);
        if (passage.length < 60) { notes.push(`${key} had no usable text.`); continue; }
        sources.push({
          id: randomUUID(),
          url: key,
          title: (parsed?.title ?? hit.title).slice(0, 300),
          retrievedAt: input.now(),
          passage,
          provider: input.search.id,
          primary: isPrimarySource(key, input.brandWebsite),
          query,
        });
        kept++;
      } catch (error) {
        notes.push(`${key} could not be fetched (${(error as Error).message}).`);
      }
    }
  }
  let keywordMetrics: KeywordMetric[] = [];
  if (input.keywordProvider && input.keywordProvider.mode === 'live') {
    try {
      // Only genuine provider rows are kept; mock metrics never become demand evidence.
      keywordMetrics = (await input.keywordProvider.metrics([...input.queries].slice(0, 20))).filter((m) => m.source !== 'mock');
    } catch {
      notes.push('Keyword metrics were unavailable; demand is assessed qualitatively.');
    }
  }
  return { sources, searchCalls, notes, keywordMetrics };
}
