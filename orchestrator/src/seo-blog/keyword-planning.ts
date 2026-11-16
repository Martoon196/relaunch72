/**
 * Keyword-first planning (release 5 of the SEO quality plan), behind SEO_BLOG_KEYWORD_POOL.
 *
 * The server picks a shortlist from the business's measured keyword list (one cluster first: a pillar and up to six
 * supporting phrases, as the planning method's one-plus-six contract needs), runs the existing research on those
 * phrases, and tells the planner about them as guidance. The planner still writes each target as a real question
 * (the planning method requires it); the server then binds every brief to the shortlisted phrase its question
 * answers, and records on the brief the measured primary phrase, secondary phrases and real searched questions.
 * The model never supplies a number: every number here comes from the stored list.
 *
 * Pure: no I/O, no clock.
 */

import { topicTokens } from './dedupe.js';
import { setSimilarity } from './keyword-pool.js';
import type { StoredKeywordRow } from './keyword-store-shape.js';
import type { InventoryKeywordPool } from './keyword-fill.js';
import { freshness } from './keyword-store-shape.js';

/** One phrase the planner is offered (numbers from the stored list only). */
export interface ShortlistRow {
  readonly id: string;
  readonly phrase: string;
  readonly basis: StoredKeywordRow['basis'];
  readonly searches: number | null;
  readonly measuredMonth: string | null;
  readonly measuredAt: string;
  readonly parent: string | null;
  readonly parentSearches: number | null;
  readonly difficulty: number | null;
  readonly intent: StoredKeywordRow['intent'];
  readonly clusterId: string;
  readonly role: 'pillar' | 'supporting';
  readonly why: string;
}

/** What a brief records about its search target (jsonb on the brief; release 5). */
export interface BriefSeo {
  readonly schema: 1;
  readonly primary: {
    readonly phrase: string;
    readonly searches: number | null;
    readonly difficulty: number | null;
    readonly intent: StoredKeywordRow['intent'];
    readonly basis: 'measured' | 'parent_phrase' | 'observed' | 'none';
    readonly parent: string | null;
    readonly parentSearches: number | null;
    readonly measuredMonth: string | null;
    readonly measuredAt: string | null;
    readonly locationCode: number;
    readonly candidateId: string | null;
  };
  /** Up to six other measured phrases the article can use naturally. */
  readonly secondary: readonly { readonly phrase: string; readonly searches: number | null; readonly candidateId: string }[];
  /** Up to eight questions people really search (from the measured list), never invented. */
  readonly questions: readonly { readonly text: string; readonly searches: number | null; readonly source: 'searched' }[];
  readonly cluster: { readonly id: string; readonly role: 'pillar' | 'supporting' } | null;
  /** One true sentence about why this phrase was chosen (built from the same facts, never by the model). */
  readonly why: string | null;
}

export const SHORTLIST_SIZE = 7;
/** A brief's question must share at least this much with a shortlisted phrase to be bound to it. */
export const BIND_SIMILARITY = 0.34;
const SECONDARY_SIMILARITY = 0.25;
const QUESTION_START = /^(how|what|why|when|where|which|who|can|do|does|is|are|should|will|should)\b/;

const toShort = (r: StoredKeywordRow): ShortlistRow => ({ id: r.id, phrase: r.phrase, basis: r.basis, searches: r.searches, measuredMonth: r.measuredMonth, measuredAt: r.measuredAt,
  parent: r.parent, parentSearches: r.parentSearches, difficulty: r.rankingDifficulty, intent: r.intent, clusterId: r.clusterId, role: r.role, why: r.why });

/** Rows usable for planning now: not expired, not a question (questions are answered inside articles), not already a brief's phrase. */
function usable(pool: InventoryKeywordPool, used: ReadonlySet<string>, now: string): StoredKeywordRow[] {
  return pool.rows.filter((r) => freshness(r.measuredAt, now) !== 'expired' && !QUESTION_START.test(r.phrase) && !used.has(r.phrase) && r.basis !== 'observed');
}

/**
 * The shortlist: the best cluster first (its pillar, then its supporting phrases by opportunity), topped up from the
 * next best rows, up to seven. Deterministic for the same list. Empty when the list has nothing measured to offer.
 */
export function planningShortlist(pool: InventoryKeywordPool | null | undefined, usedPhrases: readonly string[], now: string): ShortlistRow[] {
  if (!pool) return [];
  const rows = usable(pool, new Set(usedPhrases), now).sort((a, b) => b.opportunity - a.opportunity || (a.key < b.key ? -1 : 1));
  if (!rows.length) return [];
  const pillar = rows.find((r) => r.role === 'pillar') ?? rows[0]!;
  const same = rows.filter((r) => r !== pillar && r.clusterId === pillar.clusterId);
  const rest = rows.filter((r) => r !== pillar && r.clusterId !== pillar.clusterId);
  return [pillar, ...same, ...rest].slice(0, SHORTLIST_SIZE).map(toShort);
}

/** Guidance for the planner, appended to its focus. Names no supplier or mechanism; numbers are the stored ones. */
export function planningGuidance(shortlist: readonly ShortlistRow[]): string | null {
  if (!shortlist.length) return null;
  const line = (r: ShortlistRow, i: number) => `${i + 1}. ${r.phrase}${r.basis === 'measured' && r.searches !== null ? ` (about ${r.searches.toLocaleString('en-GB')} searches a month)` : ''}`;
  return [
    'Measured search phrases for this business, best first. Build the plan around them: make the first the pillar where it fits,',
    'and give each article a target question in the reader\'s own words that one of these phrases clearly answers. Use each phrase once at most.',
    ...shortlist.map(line),
  ].join('\n');
}

const tokens = (text: string) => topicTokens(text);

/**
 * Bind each brief to the shortlisted phrase its question and title answer best, one phrase per brief, greedily by
 * similarity (ties by shortlist order). Briefs below the bar are not bound (their primary basis is "none").
 */
export function bindBriefs(briefs: readonly { readonly key: string; readonly targetQuery: string; readonly workingTitle: string }[], shortlist: readonly ShortlistRow[]): Map<string, ShortlistRow> {
  const pairs: { key: string; row: ShortlistRow; score: number; order: number }[] = [];
  for (const b of briefs) {
    const bt = tokens(`${b.targetQuery} ${b.workingTitle}`);
    shortlist.forEach((row, order) => {
      const score = setSimilarity(bt, tokens(row.phrase));
      if (score >= BIND_SIMILARITY) pairs.push({ key: b.key, row, score, order });
    });
  }
  pairs.sort((a, b) => b.score - a.score || a.order - b.order || (a.key < b.key ? -1 : 1));
  const bound = new Map<string, ShortlistRow>();
  const taken = new Set<string>();
  for (const p of pairs) {
    if (bound.has(p.key) || taken.has(p.row.id)) continue;
    bound.set(p.key, p.row); taken.add(p.row.id);
  }
  return bound;
}

/** The brief's search record: its bound phrase (or the honest "none"), secondary phrases and real questions from the list. */
export function briefSeo(input: { readonly targetQuery: string; readonly workingTitle: string; readonly bound: ShortlistRow | null; readonly pool: InventoryKeywordPool; readonly now: string }): BriefSeo {
  const primary = input.bound;
  const anchor = tokens(primary ? primary.phrase : `${input.targetQuery} ${input.workingTitle}`);
  const live = input.pool.rows.filter((r) => freshness(r.measuredAt, input.now) !== 'expired' && (!primary || r.id !== primary.id));
  const scored = live.map((r) => ({ r, s: setSimilarity(anchor, tokens(r.phrase)) })).filter((x) => x.s >= SECONDARY_SIMILARITY)
    .sort((a, b) => b.s - a.s || (b.r.searches ?? -1) - (a.r.searches ?? -1) || (a.r.key < b.r.key ? -1 : 1));
  const secondary = scored.filter((x) => !QUESTION_START.test(x.r.phrase) && x.r.basis === 'measured').slice(0, 6).map((x) => ({ phrase: x.r.phrase, searches: x.r.searches, candidateId: x.r.id }));
  const questions = scored.filter((x) => QUESTION_START.test(x.r.phrase)).slice(0, 8).map((x) => ({ text: x.r.phrase, searches: x.r.basis === 'measured' ? x.r.searches : null, source: 'searched' as const }));
  return {
    schema: 1,
    primary: primary
      ? { phrase: primary.phrase, searches: primary.basis === 'measured' ? primary.searches : null, difficulty: primary.difficulty, intent: primary.intent, basis: primary.basis,
        parent: primary.parent, parentSearches: primary.basis === 'parent_phrase' ? primary.parentSearches : null, measuredMonth: primary.measuredMonth, measuredAt: primary.measuredAt,
        locationCode: input.pool.locationCode, candidateId: primary.id }
      : { phrase: input.targetQuery, searches: null, difficulty: null, intent: null, basis: 'none', parent: null, parentSearches: null, measuredMonth: null, measuredAt: null, locationCode: input.pool.locationCode, candidateId: null },
    secondary, questions,
    cluster: primary ? { id: primary.clusterId, role: primary.role } : null,
    why: primary ? primary.why : null,
  };
}
