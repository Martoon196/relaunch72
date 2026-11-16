/**
 * "What this could bring": a conditional, clearly labelled estimate of monthly
 * visits for a measured keyword. Pure arithmetic on numbers already paid for;
 * no I/O. Not wired into any page yet.
 *
 * Rule (owner decision, addendum "the traffic estimate on Keywords and Home"):
 *   visits = measured monthly searches × share of searchers who click the
 *   result at a position. The per-phrase range is "position 3 to position 1".
 *
 * Honesty guards, enforced here so no caller can forget them:
 *  - Only a measured search number for that exact phrase produces a number.
 *    A wider (parent) phrase's number, an observed-only phrase and an unknown
 *    phrase produce no estimate.
 *  - Every sentence that carries a number contains "Estimate" and the
 *    "if it reaches / they all reach the top three" condition.
 *  - All arithmetic is in integers (per-mille shares), so rounding never drifts.
 */

/** A click-share curve. Shares are per mille (28.5% = 285) so arithmetic stays exact. */
export interface ClickShareCurve {
  readonly version: string;
  readonly perMilleByPosition: Readonly<Record<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10, number>>;
  /** Positions taken from a published study; the rest are house assumptions. */
  readonly verifiedPositions: readonly number[];
}

/**
 * Version 1 of the house curve. Positions 1, 2, 3 and 10 are from the Sistrix
 * study of 80M+ keywords as reported by secondary coverage; 4–9 are
 * interpolated house assumptions. The study predates AI answers on results
 * pages, which reduce clicks, so the estimate may run high.
 */
export const CLICK_SHARE_V1: ClickShareCurve = Object.freeze({
  version: 'click-share-v1',
  perMilleByPosition: Object.freeze({ 1: 285, 2: 150, 3: 110, 4: 80, 5: 70, 6: 50, 7: 40, 8: 30, 9: 30, 10: 25 }),
  verifiedPositions: Object.freeze([1, 2, 3, 10]),
});

/** The range shown is "position 3 to position 1". */
export const ESTIMATE_LOW_POSITION = 3;
export const ESTIMATE_HIGH_POSITION = 1;
/** Below this high end the row reads "fewer than 10 visits a month". */
export const FEWER_THAN = 10;

/** Rounding step by size: 5 below 100, 10 below 1,000, 100 from 1,000 up. */
export function roundingStep(value: number): number {
  return value < 100 ? 5 : value < 1000 ? 10 : 100;
}

/** floor(searches × perMille / 1000) to the step, in exact integer arithmetic. */
function scaledDown(searches: number, perMille: number): number {
  const scaled = searches * perMille; // value × 1000
  const step = roundingStep(scaled / 1000);
  return Math.floor(scaled / (1000 * step)) * step;
}
function scaledUp(searches: number, perMille: number): number {
  const scaled = searches * perMille;
  const step = roundingStep(scaled / 1000);
  return Math.ceil(scaled / (1000 * step)) * step;
}
export function roundDown(value: number): number {
  const step = roundingStep(value);
  return Math.floor(value / step) * step;
}
export function roundUp(value: number): number {
  const step = roundingStep(value);
  return Math.ceil(value / step) * step;
}

/** en-GB grouping without depending on the runtime's locale data. */
export function formatCount(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Where a phrase's search number came from (the thin-data ladder). */
export type SearchBasis = 'measured' | 'parent_phrase' | 'observed' | 'none';

export interface PhraseDemand {
  readonly basis: SearchBasis;
  /** For 'measured', this phrase's own monthly searches. Ignored for every other basis. */
  readonly searches: number | null;
}

export type PhraseEstimate =
  | { readonly kind: 'range'; readonly curve: string; readonly low: number; readonly high: number; readonly sentence: string }
  | { readonly kind: 'fewer_than_10'; readonly curve: string; readonly low: number; readonly high: number; readonly sentence: string }
  | { readonly kind: 'none'; readonly curve: string; readonly reason: 'not_measured' | 'wider_phrase_only' | 'observed_only'; readonly sentence: null; readonly notice: string | null };

export const ESTIMATE_WORD = 'Estimate';
export const TOP_THREE_ONE = 'if it reaches the top three';
export const TOP_THREE_MANY = 'if they all reach the top three';
export const NO_NUMBER_NOTICE = 'No search number yet, so no estimate';

function measuredSearches(demand: PhraseDemand): number | null {
  if (demand.basis !== 'measured') return null;
  const s = demand.searches;
  return typeof s === 'number' && Number.isSafeInteger(s) && s >= 0 ? s : null;
}

function rangePhrase(low: number, high: number): string {
  return low > 0 ? `about ${formatCount(low)} to ${formatCount(high)}` : `up to about ${formatCount(high)}`;
}

export function estimateForPhrase(demand: PhraseDemand, curve: ClickShareCurve = CLICK_SHARE_V1): PhraseEstimate {
  const searches = measuredSearches(demand);
  if (searches === null) {
    const reason = demand.basis === 'parent_phrase' ? 'wider_phrase_only' : demand.basis === 'observed' ? 'observed_only' : 'not_measured';
    return { kind: 'none', curve: curve.version, reason, sentence: null, notice: reason === 'observed_only' ? NO_NUMBER_NOTICE : null };
  }
  const low = scaledDown(searches, curve.perMilleByPosition[ESTIMATE_LOW_POSITION]);
  const high = scaledUp(searches, curve.perMilleByPosition[ESTIMATE_HIGH_POSITION]);
  if (high < FEWER_THAN) {
    return { kind: 'fewer_than_10', curve: curve.version, low, high, sentence: `Could bring fewer than 10 visits a month ${TOP_THREE_ONE}. ${ESTIMATE_WORD}.` };
  }
  return { kind: 'range', curve: curve.version, low, high, sentence: `Could bring ${rangePhrase(low, high)} visits a month ${TOP_THREE_ONE}. ${ESTIMATE_WORD}.` };
}

/** "How we work this out" (one tap). Arithmetic only; names no supplier. */
export const ESTIMATE_DISCLOSURE =
  'We take how many times a month people search this phrase and the share of searchers who usually click the first, second or third result (between about 1 in 9 and 2 in 7). It is an estimate, not a promise. Many articles take months to reach the top three and some never do. The harder the keyword, the less likely.';

// ─── Per-business roll-up ───────────────────────────────────────────────────

/** Keyword states as the Keywords page derives them (plan section 2). */
export type KeywordState = 'suggested' | 'chosen' | 'being_written' | 'ready' | 'live' | 'already_covered' | 'dismissed';
export const COUNTED_STATES: ReadonlySet<KeywordState> = new Set(['chosen', 'being_written', 'ready', 'live']);

export interface RollupRow {
  /** One article (or queued selection) this phrase is the primary phrase of. Rows sharing a key count once. */
  readonly articleKey: string;
  readonly state: KeywordState;
  /** Only the primary phrase of an article is passed; secondary phrases are close variants and would double count. */
  readonly primary: PhraseDemand;
}

export interface Rollup {
  readonly curve: string;
  /** Articles whose primary phrase is measured and counted. */
  readonly counted: number;
  /** Articles in a counted state whose primary phrase has no measured number. */
  readonly uncounted: number;
  readonly low: number;
  readonly high: number;
  /** Null when nothing is in a counted state. */
  readonly sentence: string | null;
}

/**
 * Sum of the row lows to sum of the row highs (the numbers shown on each row),
 * then rounded once more on the same steps (low down, high up) so the total
 * reads like the rows. One primary phrase per article; suggested, dismissed and
 * covered phrases are not counted; unmeasured phrases are reported, not added.
 */
export function rollupEstimate(rows: readonly RollupRow[], who: 'chosen' | 'autopilot' = 'chosen', curve: ClickShareCurve = CLICK_SHARE_V1): Rollup {
  const byArticle = new Map<string, RollupRow>();
  for (const row of [...rows].sort((a, b) => (a.articleKey < b.articleKey ? -1 : a.articleKey > b.articleKey ? 1 : 0))) {
    if (!COUNTED_STATES.has(row.state)) continue;
    // A repeated article key keeps its first measured primary; otherwise its first row.
    const prior = byArticle.get(row.articleKey);
    if (!prior || (measuredSearches(prior.primary) === null && measuredSearches(row.primary) !== null)) byArticle.set(row.articleKey, row);
  }
  let low = 0; let high = 0; let counted = 0; let uncounted = 0;
  for (const row of byArticle.values()) {
    const e = estimateForPhrase(row.primary, curve);
    if (e.kind === 'none') { uncounted++; continue; }
    counted++; low += e.low; high += e.high;
  }
  low = counted ? roundDown(low) : 0;
  high = counted ? roundUp(high) : 0;
  return { curve: curve.version, counted, uncounted, low, high, sentence: rollupSentence(counted, uncounted, low, high, who) };
}

function rollupSentence(counted: number, uncounted: number, low: number, high: number, who: 'chosen' | 'autopilot'): string | null {
  if (counted === 0 && uncounted === 0) return null;
  const noun = (n: number) => `${formatCount(n)} keyword${n === 1 ? '' : 's'}`;
  const subject = who === 'autopilot'
    ? `The ${noun(counted)} autopilot will write next`
    : `The ${noun(counted)} you have chosen`;
  const rest = uncounted === 0 ? '' : uncounted === 1
    ? ' 1 more has no search number yet and is not counted.'
    : ` ${formatCount(uncounted)} more have no search number yet and are not counted.`;
  if (counted === 0) {
    const all = who === 'autopilot' ? 'autopilot will write next' : 'you have chosen';
    return uncounted === 1
      ? `The keyword ${all} has no search number yet, so there is no estimate.`
      : `None of the ${formatCount(uncounted)} keywords ${all} has a search number yet, so there is no estimate.`;
  }
  const condition = counted === 1 ? TOP_THREE_ONE : TOP_THREE_MANY;
  const amount = high < FEWER_THAN ? 'fewer than 10' : rangePhrase(low, high);
  return `${subject} could bring ${amount} visits a month ${condition}. ${ESTIMATE_WORD}.${rest}`;
}
