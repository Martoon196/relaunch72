/**
 * Keyword-first planning (release 5 of the SEO quality plan), behind SEO_BLOG_KEYWORD_POOL.
 *
 * "The model only chooses among measured candidates." The server picks the candidates from the business's stored
 * keyword list (one cluster first: a pillar and up to six supporting phrases a brief may target, as the planning
 * method's one-plus-six contract needs, plus further measured phrases offered only as secondary phrases), runs the
 * existing research on the target candidates, and shows every candidate to the planner with a short id. The planner
 * still writes each target as a real question (the planning method requires it) and returns, for each brief, the id
 * of the candidate it targets (or none) and the ids of its secondary phrases.
 *
 * The server then binds by id only: an id that is not one it sent is stripped, a target id that is not a target
 * candidate is stripped, two briefs never take the same target (the first in plan order keeps it), and nothing is
 * ever bound by text similarity. A brief with no chosen id is not measured. Every number recorded here comes from the
 * stored list; the model never supplies one.
 *
 * Pure: no I/O, no clock.
 */

import { topicTokens } from './dedupe.js';
import { difficultyBand, intentLabel, setSimilarity } from './keyword-pool.js';
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

/** What a brief records about its search target (jsonb on the brief). */
export interface BriefSeo {
  /** 2: bound by the candidate id the planner returned (never by similarity). */
  readonly schema: 2;
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
  /** Up to six other measured phrases the article can use naturally, each chosen by id. */
  readonly secondary: readonly { readonly phrase: string; readonly searches: number | null; readonly candidateId: string }[];
  /** Up to eight questions people really search that contain the target phrase. No numbers: they are never chosen by id. */
  readonly questions: readonly { readonly text: string; readonly searches: null; readonly source: 'searched' }[];
  readonly cluster: { readonly id: string; readonly role: 'pillar' | 'supporting' } | null;
  /** One true sentence about why this phrase was chosen (built from the same facts, never by the model). */
  readonly why: string | null;
}

export const SHORTLIST_SIZE = 7;
/** Further measured phrases offered only as secondary phrases. */
export const SECONDARY_CANDIDATES = 13;
export const SECONDARY_PER_BRIEF = 6;
/** A phrase this close to one an article already targets would compete with it (plan: "cannibalising, 0.6 or more"). */
export const NEAR_DUPLICATE = 0.6;
const QUESTION_START = /^(how|what|why|when|where|which|who|can|do|does|is|are|should|will)\b/;

const toShort = (r: StoredKeywordRow): ShortlistRow => ({ id: r.id, phrase: r.phrase, basis: r.basis, searches: r.searches, measuredMonth: r.measuredMonth, measuredAt: r.measuredAt,
  parent: r.parent, parentSearches: r.parentSearches, difficulty: r.rankingDifficulty, intent: r.intent, clusterId: r.clusterId, role: r.role, why: r.why });

/** Whether a phrase is one an article already targets, or a near duplicate of one. */
export function nearUsed(phrase: string, used: readonly string[]): boolean {
  const t = topicTokens(phrase);
  return used.some((u) => u === phrase || setSimilarity(t, topicTokens(u)) >= NEAR_DUPLICATE);
}

/** Rows usable for planning now: not expired, not a question (questions are answered inside articles), not observed only, not already targeted or near it. */
function usable(pool: InventoryKeywordPool, used: readonly string[], now: string): StoredKeywordRow[] {
  return pool.rows.filter((r) => freshness(r.measuredAt, now) !== 'expired' && !QUESTION_START.test(r.phrase) && r.basis !== 'observed' && !nearUsed(r.phrase, used));
}

export interface PlanningCandidates {
  /** Phrases a brief may target (the shortlist; research runs on these). */
  readonly primary: readonly ShortlistRow[];
  /** Further measured phrases offered only as secondary phrases. */
  readonly secondary: readonly ShortlistRow[];
}

/**
 * The candidates: the best cluster first (its pillar, then its supporting phrases by opportunity), topped up from the
 * next best rows, up to seven targets; then up to thirteen more measured phrases as secondary-only candidates.
 * Deterministic for the same list. Empty when the list has nothing to offer.
 */
export function planningCandidates(pool: InventoryKeywordPool | null | undefined, usedPhrases: readonly string[], now: string): PlanningCandidates {
  if (!pool) return { primary: [], secondary: [] };
  const rows = usable(pool, usedPhrases, now).sort((a, b) => b.opportunity - a.opportunity || (a.key < b.key ? -1 : 1));
  if (!rows.length) return { primary: [], secondary: [] };
  const pillar = rows.find((r) => r.role === 'pillar') ?? rows[0]!;
  const same = rows.filter((r) => r !== pillar && r.clusterId === pillar.clusterId);
  const rest = rows.filter((r) => r !== pillar && r.clusterId !== pillar.clusterId);
  const primary = [pillar, ...same, ...rest].slice(0, SHORTLIST_SIZE);
  const taken = new Set(primary.map((r) => r.id));
  const secondary = rows.filter((r) => !taken.has(r.id) && r.basis === 'measured' && r.searches !== null).slice(0, SECONDARY_CANDIDATES);
  return { primary: primary.map(toShort), secondary: secondary.map(toShort) };
}

/** The target candidates only (what research runs on and what the Keywords page calls "next up"). */
export function planningShortlist(pool: InventoryKeywordPool | null | undefined, usedPhrases: readonly string[], now: string): ShortlistRow[] {
  return [...planningCandidates(pool, usedPhrases, now).primary];
}

/** Short ids the planner sees: K1… for target candidates, then the secondary-only ones. Deterministic. */
export function candidateIds(c: PlanningCandidates): Map<string, { readonly row: ShortlistRow; readonly target: boolean }> {
  const ids = new Map<string, { row: ShortlistRow; target: boolean }>();
  c.primary.forEach((row, i) => ids.set(`K${i + 1}`, { row, target: true }));
  c.secondary.forEach((row, i) => ids.set(`K${c.primary.length + i + 1}`, { row, target: false }));
  return ids;
}

/**
 * The candidate block for the planner. Plain facts from the stored list; the planner uses them to choose and never
 * writes a number into the plan. Names no supplier or mechanism.
 */
export function candidatesForPrompt(c: PlanningCandidates): { id: string; phrase: string; can_be_target: boolean; searches_a_month: number | null; wider_phrase: string | null; wider_phrase_searches_a_month: number | null; how_hard: string; searcher_wants: string | null; measured_month: string | null }[] {
  return [...candidateIds(c)].map(([id, { row, target }]) => ({
    id, phrase: row.phrase, can_be_target: target,
    searches_a_month: row.basis === 'measured' ? row.searches : null,
    wider_phrase: row.basis === 'parent_phrase' ? row.parent : null,
    wider_phrase_searches_a_month: row.basis === 'parent_phrase' ? row.parentSearches : null,
    how_hard: difficultyBand(row.difficulty).label, searcher_wants: intentLabel(row.intent)?.label ?? null, measured_month: row.measuredMonth,
  }));
}

/** What the planner returned for one brief. */
export interface ChosenIds {
  readonly key: string;
  readonly primaryId: string | null | undefined;
  readonly secondaryIds: readonly string[] | null | undefined;
}

export interface Binding {
  readonly primary: ShortlistRow | null;
  readonly secondary: readonly ShortlistRow[];
}

/**
 * Bind each brief by the ids the planner returned, in plan order. Strips any id that was not sent, a target id that
 * is not a target candidate, a target another brief already took, a secondary id equal to any brief's target, and
 * duplicates; at most six secondary phrases. Never looks at the brief's words. `stripped` counts what was removed.
 */
export function bindByIds(briefs: readonly ChosenIds[], c: PlanningCandidates): { bound: Map<string, Binding>; stripped: number } {
  const ids = candidateIds(c);
  const bound = new Map<string, Binding>();
  let stripped = 0;
  const targets = new Set<string>();
  const primaryOf = new Map<string, ShortlistRow | null>();
  for (const b of briefs) {
    const id = typeof b.primaryId === 'string' ? b.primaryId : null;
    const hit = id ? ids.get(id) : undefined;
    if (id && (!hit || !hit.target || targets.has(id))) { stripped++; primaryOf.set(b.key, null); continue; }
    if (hit) targets.add(id!);
    primaryOf.set(b.key, hit ? hit.row : null);
  }
  for (const b of briefs) {
    const seen = new Set<string>();
    const secondary: ShortlistRow[] = [];
    for (const id of Array.isArray(b.secondaryIds) ? b.secondaryIds : []) {
      const hit = typeof id === 'string' ? ids.get(id) : undefined;
      if (!hit || targets.has(id) || seen.has(id) || secondary.length >= SECONDARY_PER_BRIEF || hit.row.basis !== 'measured') { stripped++; continue; }
      seen.add(id); secondary.push(hit.row);
    }
    bound.set(b.key, { primary: primaryOf.get(b.key) ?? null, secondary });
  }
  return { bound, stripped };
}

/** Every token of the target phrase appears in the question (a strict word rule, not a similarity score). */
function asksAbout(question: string, phrase: string): boolean {
  const q = topicTokens(question);
  const p = topicTokens(phrase);
  return p.size > 0 && [...p].every((t) => q.has(t));
}

/**
 * The brief's search record: its target chosen by id (or the honest "none", with no number), its secondary phrases
 * chosen by id, and searched questions that contain the target phrase (text only, no numbers).
 */
export function briefSeo(input: { readonly targetQuery: string; readonly binding: Binding; readonly pool: InventoryKeywordPool; readonly now: string }): BriefSeo {
  const primary = input.binding.primary;
  const questions = primary
    ? input.pool.rows.filter((r) => freshness(r.measuredAt, input.now) !== 'expired' && QUESTION_START.test(r.phrase) && asksAbout(r.phrase, primary.phrase))
      .sort((a, b) => (a.key < b.key ? -1 : 1)).slice(0, 8).map((r) => ({ text: r.phrase, searches: null, source: 'searched' as const }))
    : [];
  return {
    schema: 2,
    primary: primary
      ? { phrase: primary.phrase, searches: primary.basis === 'measured' ? primary.searches : null, difficulty: primary.difficulty, intent: primary.intent, basis: primary.basis,
        parent: primary.parent, parentSearches: primary.basis === 'parent_phrase' ? primary.parentSearches : null, measuredMonth: primary.measuredMonth, measuredAt: primary.measuredAt,
        locationCode: input.pool.locationCode, candidateId: primary.id }
      : { phrase: input.targetQuery, searches: null, difficulty: null, intent: null, basis: 'none', parent: null, parentSearches: null, measuredMonth: null, measuredAt: null, locationCode: input.pool.locationCode, candidateId: null },
    secondary: input.binding.secondary.map((r) => ({ phrase: r.phrase, searches: r.searches, candidateId: r.id })),
    questions,
    cluster: primary ? { id: primary.clusterId, role: primary.role } : null,
    why: primary ? primary.why : null,
  };
}
