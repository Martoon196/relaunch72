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
 * After binding by id, one deterministic check (`phraseFits`): at least half of the chosen phrase's meaning words must
 * appear in the brief's question or title, else that choice is dropped and the brief stays unbound (never re-bound to
 * another phrase). Secondary phrases pass the same check one by one. A brief left unbound carries no secondary phrase,
 * so it shows no number at all.
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
  /** As returned by the planner: anything at all (a bad value is stripped, never trusted). */
  readonly primaryId: unknown;
  readonly secondaryIds: unknown;
  /** The brief's own words. When given, every chosen phrase must fit them (`phraseFits`). */
  readonly text?: { readonly question: string; readonly title: string };
}

export interface Binding {
  readonly primary: ShortlistRow | null;
  readonly secondary: readonly ShortlistRow[];
}

/** Why a returned id was not used (internal: logged and counted, never shown to a client). */
export type DropReason =
  | 'not_text' | 'unknown_id' | 'not_a_target' | 'target_taken' | 'does_not_fit' | 'fits_another_better' | 'tied'
  | 'not_a_list' | 'is_a_target' | 'duplicate' | 'over_limit' | 'not_measured' | 'brief_unbound';
export interface DroppedId {
  readonly key: string;
  readonly field: 'primary' | 'secondary';
  /** The id when it is one the server sent; null for anything else (a planner's own text is never logged). */
  readonly id: string | null;
  readonly reason: DropReason;
}

// ─── The fit check ────────────────────────────────────────────────────────────

/** Words that carry no subject: function words, question words and filler (as the duplicate check treats them). */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'its', 'my', 'of', 'on', 'or',
  'our', 'should', 'so', 'than', 'that', 'the', 'their', 'this', 'to', 'uk', 'up', 'vs', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with',
  'you', 'your', 'guide', 'complete', 'ultimate', 'best', 'need', 'know', 'things', 'about', 'into', 'more', 'most', 'me', 'we', 'us', 'if',
  'was', 'were', 'has', 'have', 'had', 'there', 'these', 'those', 'them', 'they', 'any', 'all', 'get', 'much', 'many', 'near',
]);
/** Negations are never filler: "no deposit mortgage" is not about a deposit. In a phrase they must be in the brief. */
const NEGATIONS = new Set(['no', 'not', 'without', 'non']);
/** A single letter after one of these words is a meaning word that must be in the brief: band D, class Q, EPC rating C. */
const LETTER_QUALIFIERS = new Set(['band', 'class', 'grade', 'type', 'zone', 'level', 'tier', 'stage', 'rating', 'category', 'part', 'schedule']);
/** Prepositions after which a capitalised name in a question is read as a place (see `phraseFits`). */
const PLACE_PREPOSITIONS = new Set(['in', 'near', 'around', 'across', 'from', 'at', 'outside', 'within', 'throughout']);
/**
 * A few UK property word families a suffix rule must not be stretched to: each form maps to one word. Deliberately
 * small and explicit, so the stemmer itself can stay cautious.
 */
const WORD_FAMILIES: Readonly<Record<string, string>> = Object.fromEntries([
  ...['licence', 'licences', 'license', 'licenses', 'licensing', 'licensed', 'licencing', 'licenced'].map((w) => [w, 'licence']),
  ...['evict', 'evicts', 'evicted', 'evicting', 'eviction', 'evictions'].map((w) => [w, 'evict']),
]);
/** Words a suffix rule would wrongly shorten into another word. */
const KEEP_AS_IS = new Set(['news', 'business', 'bus', 'gas', 'yes', 'lens', 'series', 'species', 'thing', 'things', 'ceiling', 'building', 'buildings']);

/**
 * A cautious stem for an English word: plurals (fees/fee, properties/property, taxes/tax, houses/house, classes/class)
 * and the -ing and -ed forms (renting/rented/rent, returning/return). It prefers to leave two forms apart rather than
 * merge two different words: no final "e" is removed (rate/rat, site/sit stay apart) and no doubled letter is undone
 * (planning/plan, sitting/sit stay apart). A small explicit table joins licence/licensing/license and evict/eviction.
 * Words in other scripts, and words with digits, are compared exactly.
 */
export function simpleStem(word: string): string {
  if (!/^[a-z]+$/.test(word)) return word;
  const family = WORD_FAMILIES[word];
  if (family) return family;
  if (KEEP_AS_IS.has(word)) return word === 'buildings' ? 'building' : word === 'things' ? 'thing' : word;
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(?:x|z|ch|sh|ss)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  const plural = WORD_FAMILIES[w];
  if (plural) return plural;
  if (w.length > 4 && w.endsWith('ied')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 6 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith('ed') && !w.endsWith('eed')) w = w.slice(0, -2);
  return w;
}

function fold(word: string): string {
  return word.normalize('NFKD').replace(/[̀-ͯ]/g, '').normalize('NFC');
}
function tokens(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}\p{M}]+/u).map(fold).filter((w) => w.length > 0);
}
const hasDigit = (w: string) => /\p{N}/u.test(w);

/**
 * The meaning words of a text, and which of them a brief must contain. Any script, lower-cased, Latin accents removed,
 * stemmed (`simpleStem`); stop words dropped. Kept and required: a word with a digit (section 21, form 6a), a
 * negation (no, not, without, non), and a single letter that follows a qualifier (band d, class q, rating c) or sits
 * next to a number. Any other single Latin letter is dropped.
 */
export function meaningTerms(text: string): { readonly words: Set<string>; readonly required: Set<string> } {
  const raw = tokens(text);
  const words = new Set<string>();
  const required = new Set<string>();
  raw.forEach((w, i) => {
    const prev = raw[i - 1], next = raw[i + 1];
    if (hasDigit(w)) { words.add(w); required.add(w); return; }
    if (/^[a-z]$/.test(w)) {
      if (prev && LETTER_QUALIFIERS.has(prev)) { const t = `${prev} ${w}`; words.add(t); required.add(t); return; }
      if ((prev && hasDigit(prev)) || (next && hasDigit(next))) { words.add(w); required.add(w); }
      return;
    }
    if (NEGATIONS.has(w)) { words.add(w); required.add(w); return; }
    if (STOP_WORDS.has(w)) return;
    words.add(simpleStem(w));
  });
  return { words, required };
}

/** The meaning words of a text (see `meaningTerms`). */
export function meaningWords(text: string): Set<string> {
  return meaningTerms(text).words;
}

/**
 * Places a question names: a capitalised name (one word or several in a row, not at the start of a sentence, not an
 * all-capitals abbreviation, not "I") right after "in", "near", "around", "across", "from", "at", "outside", "within"
 * or "throughout". Each place is its set of meaning words. Titles are not read: they capitalise every word.
 */
function placesIn(question: string): Set<string>[] {
  const parts = question.split(/\s+/).filter(Boolean);
  const places: Set<string>[] = [];
  for (let i = 1; i < parts.length; i++) {
    const before = parts[i - 1]!;
    if (/[.?!:;]$/.test(before) || !PLACE_PREPOSITIONS.has(before.toLowerCase().replace(/[^\p{L}]/gu, ''))) continue;
    const place = new Set<string>();
    for (let j = i; j < parts.length; j++) {
      const word = parts[j]!;
      if (!/^\p{Lu}\p{Ll}/u.test(word)) break;
      for (const w of meaningWords(word.replace(/['’]s\b/u, ''))) place.add(w);
      if (/[.?!:;,]$/.test(word)) break;
    }
    if (place.size) places.push(place);
  }
  return places;
}

/** How a phrase fits a brief: whether it passes the hard checks, and its share and count of matched meaning words. */
export interface FitScore { readonly fits: boolean; readonly share: number; readonly matched: number; readonly size: number }

/**
 * The fit of one phrase to one brief (its question and title). It fits when all of these hold:
 * - at least half of the phrase's meaning words are in the brief (the half rule);
 * - every required word is in the brief: each word with a digit, each negation, each qualified or numbered letter;
 * - the question does not name a different place: no place named in the question (see `placesIn`) shares a word with
 *   the phrase without being wholly in it (New York against "york"), and none names a place outside the phrase while
 *   one of the phrase's own words is missing (Bradford against "plumber leeds").
 * A phrase with no meaning word (stop words only) never fits. Lower-case place names inside a phrase cannot be told
 * from ordinary words, so "letting agents reading" against "read a letting agent's contract" is left to the
 * comparison with the other candidates in `bindByIds`.
 */
export function fitScore(phrase: string, text: { readonly question: string; readonly title: string }): FitScore {
  const p = meaningTerms(phrase);
  const size = p.words.size;
  if (size === 0) return { fits: false, share: 0, matched: 0, size };
  const brief = new Set([...meaningWords(text.question), ...meaningWords(text.title)]);
  let matched = 0;
  for (const w of p.words) if (brief.has(w)) matched++;
  const share = matched / size;
  const fail = { fits: false, share, matched, size };
  if (matched * 2 < size) return fail;
  for (const w of p.required) if (!brief.has(w)) return fail;
  const missing = matched < size;
  for (const place of placesIn(text.question)) {
    const shared = [...place].filter((w) => p.words.has(w)).length;
    if (shared > 0 && shared < place.size) return fail;
    if (shared === 0 && missing) return fail;
  }
  return { fits: true, share, matched, size };
}

/** The fit check on its own (see `fitScore`). */
export function phraseFits(phrase: string, text: { readonly question: string; readonly title: string }): boolean {
  return fitScore(phrase, text).fits;
}

/** Whether `other` fits the brief better than `mine`: a higher share, or the same share over more words (a longer phrase). */
function beats(other: FitScore, mine: FitScore): boolean {
  return other.fits && (other.share > mine.share || (other.share === mine.share && other.matched > mine.matched));
}
const ties = (other: FitScore, mine: FitScore) => other.fits && other.share === mine.share && other.matched === mine.matched;

/**
 * Whether `row` is the phrase for this brief among the target candidates: it fits (`fitScore`), no other target
 * candidate fits better, and none fits exactly as well (a tie is left unbound: there is no way to tell them apart).
 * `except` are candidates not compared against (for a secondary phrase: the brief's own target).
 */
export function bestFit(row: ShortlistRow, text: { readonly question: string; readonly title: string }, targets: readonly ShortlistRow[], except: ReadonlySet<string> = new Set()): 'fits' | 'does_not_fit' | 'fits_another_better' | 'tied' {
  const mine = fitScore(row.phrase, text);
  if (!mine.fits) return 'does_not_fit';
  let tied = false;
  for (const other of targets) {
    if (other.id === row.id || except.has(other.id) || other.phrase === row.phrase) continue;
    const o = fitScore(other.phrase, text);
    if (beats(o, mine)) return 'fits_another_better';
    // The same share over the same number of words: the brief cannot tell the two apart, so neither is bound.
    if (ties(o, mine)) tied = true;
  }
  return tied ? 'tied' : 'fits';
}

/**
 * Bind each brief by the ids the planner returned, in plan order. Strips any id that was not sent (or is not text), a
 * target id that is not a target candidate, a target another brief already took, a secondary id equal to any brief's
 * target, and duplicates; at most six secondary phrases. Then, when the brief's words are given, a chosen phrase must
 * be the best fit among the target candidates (`bestFit`), else it is dropped: a target dropped this way is not taken,
 * so a later brief that chose it may keep it, and nothing is ever re-bound to another phrase. A secondary phrase must
 * pass the same rule, compared with every target candidate except the brief's own target. A brief with no target
 * keeps no secondary phrase.
 * Counts: `stripped` ids removed by the id rules, `unfit` choices removed by the fit rule, `withdrawn` secondary
 * phrases that were fine but belonged to a brief left without a target. `dropped` lists each.
 * Never throws, whatever the planner returned.
 */
export function bindByIds(briefs: readonly ChosenIds[], c: PlanningCandidates): { bound: Map<string, Binding>; stripped: number; unfit: number; withdrawn: number; dropped: DroppedId[] } {
  const ids = candidateIds(c);
  const bound = new Map<string, Binding>();
  const dropped: DroppedId[] = [];
  const known = (id: unknown): string | null => (typeof id === 'string' && ids.has(id) ? id : null);
  const drop = (key: string, field: DroppedId['field'], id: unknown, reason: DropReason) => { dropped.push({ key, field, id: known(id), reason }); };
  const targets = new Set<string>();
  const targetRows = [...ids.values()].filter((v) => v.target).map((v) => v.row);
  const primaryOf = new Map<string, ShortlistRow | null>();
  for (const b of briefs) {
    primaryOf.set(b.key, null);
    if (b.primaryId === null || b.primaryId === undefined) continue;
    if (typeof b.primaryId !== 'string') { drop(b.key, 'primary', b.primaryId, 'not_text'); continue; }
    const id = b.primaryId;
    const hit = ids.get(id);
    if (!hit) { drop(b.key, 'primary', id, 'unknown_id'); continue; }
    if (!hit.target) { drop(b.key, 'primary', id, 'not_a_target'); continue; }
    if (targets.has(id)) { drop(b.key, 'primary', id, 'target_taken'); continue; }
    if (b.text) { const fit = bestFit(hit.row, b.text, targetRows); if (fit !== 'fits') { drop(b.key, 'primary', id, fit); continue; } }
    targets.add(id);
    primaryOf.set(b.key, hit.row);
  }
  for (const b of briefs) {
    const seen = new Set<string>();
    const secondary: ShortlistRow[] = [];
    const primary = primaryOf.get(b.key) ?? null;
    if (b.secondaryIds !== null && b.secondaryIds !== undefined && !Array.isArray(b.secondaryIds)) drop(b.key, 'secondary', null, 'not_a_list');
    for (const id of Array.isArray(b.secondaryIds) ? b.secondaryIds as unknown[] : []) {
      if (typeof id !== 'string') { drop(b.key, 'secondary', id, 'not_text'); continue; }
      const hit = ids.get(id);
      if (!hit) { drop(b.key, 'secondary', id, 'unknown_id'); continue; }
      if (targets.has(id)) { drop(b.key, 'secondary', id, 'is_a_target'); continue; }
      if (seen.has(id)) { drop(b.key, 'secondary', id, 'duplicate'); continue; }
      if (hit.row.basis !== 'measured') { drop(b.key, 'secondary', id, 'not_measured'); continue; }
      if (!primary) { drop(b.key, 'secondary', id, 'brief_unbound'); continue; }
      if (secondary.length >= SECONDARY_PER_BRIEF) { drop(b.key, 'secondary', id, 'over_limit'); continue; }
      if (b.text) { const fit = bestFit(hit.row, b.text, targetRows, new Set([primary.id])); if (fit !== 'fits') { drop(b.key, 'secondary', id, fit); continue; } }
      seen.add(id); secondary.push(hit.row);
    }
    bound.set(b.key, { primary, secondary });
  }
  const unfit = dropped.filter((d) => FIT_REASONS.has(d.reason)).length;
  const withdrawn = dropped.filter((d) => d.reason === 'brief_unbound').length;
  return { bound, stripped: dropped.length - unfit - withdrawn, unfit, withdrawn, dropped };
}
const FIT_REASONS: ReadonlySet<DropReason> = new Set(['does_not_fit', 'fits_another_better', 'tied']);

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
      // Most-searched first, so the length setting's cap keeps the questions people ask most (key order among equals).
      .sort((a, b) => (b.searches ?? -1) - (a.searches ?? -1) || (a.key < b.key ? -1 : 1)).slice(0, 8).map((r) => ({ text: r.phrase, searches: null, source: 'searched' as const }))
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
