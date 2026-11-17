/**
 * Our on-page SEO score for one article version: a pure, deterministic function of the brief (its search phrase, what
 * the searcher wants and the related questions), the article body, the site's own web address(es) and the existing
 * quality checks' results. No model calls, no network, no clock.
 *
 * It runs the same KIND of checks the well-known WordPress SEO plugins run (search phrase placement, lengths, links,
 * pictures, readability), plus checks they cannot run because they have no research ("Answers the searcher"). It is
 * OUR score: it is never presented as another product's number, which can differ a little.
 *
 * A GATE, NOT A TARGET. The score is a bar to pass, not a number to push as high as it will go. Use seoGate() on a
 * score made in strict `targetMode`: an automatic step may keep a rewrite only when it passes, and then it stops.
 * The gate is NECESSARY, NOT SUFFICIENT: a separate meaning check is required before any automatic rewrite is
 * accepted, because fluent empty filler passes this score (the tests keep two such articles as the known limit).
 * Above the bar the last points come from small placement details, and chasing them makes writing worse. Good
 * natural writing scores in the mid-90s without being bent; the caps below keep the rubbish they can see (repeats,
 * stuffing, text that is not sentences) at 70 or below.
 *
 * WHAT IT CANNOT DO. It matches words; it cannot judge meaning. It cannot tell whether the article is true, useful,
 * on topic or better than another; it cannot tell a real answer from words that look like one. Nothing here pretends
 * to. An automatic step that rewrites articles needs its own guard that the text still says the same true things.
 *
 * Weights (points out of 100; "partly" earns half the points of the check):
 *
 * | Part                 | Group             | Check                                                        | Points |
 * |----------------------|-------------------|--------------------------------------------------------------|--------|
 * | Search               | The search phrase | In the Google title (a business name at the end is fine)     |      5 |
 * | Search               | The search phrase | Near the start of the Google title                           |      1 |
 * | Search               | The search phrase | In the short description in Google                           |      4 |
 * | Search               | The search phrase | In the page address (its main words, any order)              |      3 |
 * | Search               | The search phrase | In the opening paragraph                                     |      4 |
 * | Search               | The search phrase | In one or two sub-headings (close forms count)               |      3 |
 * | Search               | The search phrase | Used a sensible number of times, spread out                  |      3 |
 * | Search               | The page          | Google title length (30 to 65 characters)                    |      3 |
 * | Search               | The page          | Short description (70 to 160 characters, a sentence)         |      3 |
 * | Search               | The page          | Page address length (up to 60 characters)                    |      2 |
 * | Search               | The page          | Article length (a band for what the searcher wants)          |      4 |
 * | Search               | The page          | Sub-headings                                                 |      2 |
 * | Search               | The page          | Questions and answers                                        |      2 |
 * | Search               | Links             | A link to another page on your own site                      |      5 |
 * | Search               | Links             | At least one cited outside source                            |      5 |
 * | Search               | Pictures          | A main picture with a picture description                    |      5 |
 * | Search               | Pictures          | The picture description mentions the topic                   |      2 |
 * | Easy to read         | Easy to read      | Sentence length (not too long, not choppy)                   |      5 |
 * | Easy to read         | Easy to read      | Short paragraphs (none over 150 words)                       |      4 |
 * | Easy to read         | Easy to read      | Sub-headings often enough (no stretch over 300 words)        |      4 |
 * | Easy to read         | Easy to read      | Reading ease (Flesch reading ease 60 or more)                |      6 |
 * | Easy to read         | Easy to read      | Varied sentence starts                                       |      2 |
 * | Easy to read         | Easy to read      | Linking words (in about 15% to 60% of sentences)             |      4 |
 * | Easy to read         | Easy to read      | Varied wording (no repeats or near repeats, whole article)   |      4 |
 * | Answers the searcher | Answers           | The related questions on record are answered                 |      7 |
 * | Answers the searcher | Answers           | The opening gets to the point (phrase in first 60 words)     |      2 |
 * | Answers the searcher | Answers           | A clear next step (the button at the end)                    |      3 |
 * | Answers the searcher | Answers           | Every figure has a source (from the quality checks)          |      3 |
 * |                      |                   | Total                                                        |    100 |
 *
 * Nothing is paid twice: "Near the start of the Google title" and "The opening gets to the point" each repeat part of
 * another check, so they carry half their earlier weight; whether the short description is a sentence is judged only
 * by its length check; with no picture the picture description check is not run (the picture's 5 points are lost
 * once, not 7); a link to an own page that is not live is not taken off the links check because its must-fix issue
 * already caps the score.
 *
 * Checks that cannot be run are left out and the score is the share of the remaining points, scaled to 100 (the
 * read-only report):
 * - no search phrase on record (older articles, or an empty phrase): the nine phrase checks (27 points);
 * - no related questions on record: that check (7 points);
 * - the quality checks have not run for this exact version: the figures check (3 points).
 * In strict `targetMode` (for a gate), nothing is left out: a missing phrase, missing questions and checks that have
 * not run all fail, and checks that have not run also cap the score at 59.
 *
 * Caps on the whole score (the lowest applies):
 * - an open must-fix issue from the quality checks, or one found on an earlier version when they have not run on this
 *   one: at most 59;
 * - heavy repetition (over 25% of sentences and list items repeat an earlier one word for word or with a word or two
 *   changed, or over 25% of the article's five-word runs came earlier, or a very small vocabulary): at most 40;
 * - text that is not built of sentences (under 28% of its words are the small joining words such as "the", "of",
 *   "is"; ordinary prose is 40% to 55%): at most 40;
 * - a stuffed search phrase (its uses, in every close form and every place, take over 4% of the words; good
 *   articles measure 0% to 2.1%): at most 60;
 * - some repetition (over 10% by either measure above): at most 70.
 * Length alone never caps: padding is caught as repetition, and a long guide that stays useful is fine.
 *
 * Left out on purpose: passive voice (English adjectival participles such as "is based" or "are interested" cannot be
 * told apart from true passives without a grammar parser; a word-list guess would be wrong too often to score), and
 * "covers the brief's key points" (that needs meaning, not word matching, so it cannot be checked deterministically).
 *
 * Phrase matching: case-insensitive; punctuation and hyphens separate words; curly and straight apostrophes are the
 * same; plural and possessive forms count as the phrase ("bridging loans" and "landlord's" match "bridging loan" and
 * "landlord"; "buses" matches "bus" but "glasses" is not "glass"); whole words only ("let" is not found in "letter").
 * The title, description and opening want the phrase as searched; elsewhere close forms count as uses too: -ing and
 * -ed forms and the main words in another order ("appraising property deals"). The phrase counts towards "enough"
 * only inside a real sentence, but every occurrence anywhere counts towards "too often".
 */

import type { ArticleBody, ArticleBrief, CheckIssue } from './types.js';

export type SeoCheckResult = 'pass' | 'partly' | 'fail';
export type SeoPart = 'search' | 'read' | 'answers';
export type SeoCheckGroup = 'phrase' | 'page' | 'links' | 'pictures' | 'read' | 'answers';
/** Where the fix for a check lives on the article page (the view turns these into links). */
export type SeoFix = 'google-title' | 'description' | 'address' | 'opening' | 'headings' | 'text' | 'rewrite' | 'picture' | 'picture-description' | 'links' | 'fix';

export interface SeoCheck {
  readonly id: string;
  readonly part: SeoPart;
  readonly group: SeoCheckGroup;
  /** A plain-English name, as the owner would say it. */
  readonly name: string;
  readonly result: SeoCheckResult;
  /** What we found, in one or two plain sentences. */
  readonly found: string;
  /** What to do when it is not a pass (null on a pass). */
  readonly todo: string | null;
  readonly weight: number;
  readonly points: number;
  readonly fix: SeoFix | null;
  /** Points of another check that is only scored once this one is fixed (the picture description, once there is a picture). */
  readonly unlocks?: number;
  /** How many separate things keep this check from passing, when more than one: one change will not pass it. */
  readonly reasons?: number;
}

export interface SeoScoreContext {
  /** The site's own addresses (any form: https://www.example.com, example.com/blog). Links to them are internal. */
  readonly siteHosts?: readonly (string | null | undefined)[];
  /** This article's own address, when known; a link to it is not a link to "another page". */
  readonly selfUrl?: string | null;
  /** The existing quality checks' issues for THIS version; null or absent when they have not run for it. */
  readonly checkIssues?: readonly (Pick<CheckIssue, 'code'> & Partial<Pick<CheckIssue, 'severity' | 'message'>>)[] | null;
  /**
   * Strict target mode, for when the score is used as a gate by an automatic step (off for the read-only report).
   * Nothing is left out and scaled: no search phrase, no questions on record and checks that have not run for this
   * version all count as fails, and checks that have not run also hold the score at MUST_FIX_CAP.
   */
  readonly targetMode?: boolean;
  /** The same as `targetMode` (its earlier name). */
  readonly asTarget?: boolean;
  /**
   * The quality checks' issues from an EARLIER version, when they have not run on this one. Must-fix issues there hold
   * the score down until the checks run again, so the report never shows a high score beside an open must-fix.
   */
  readonly staleCheckIssues?: readonly (Pick<CheckIssue, 'code'> & Partial<Pick<CheckIssue, 'severity' | 'message'>>)[] | null;
}

export interface SeoPartTotal { readonly part: SeoPart; readonly label: string; readonly points: number; readonly weight: number }
/** Why the score is held down: an open must-fix, checks that ran on an earlier version (or not at all, as a target),
 * heavy repetition, text that is not sentences, or a stuffed phrase. */
export type SeoCapKind = 'must-fix' | 'stale-checks' | 'not-checked' | 'repetition' | 'not-sentences' | 'stuffing';
export interface SeoCap { readonly kind: SeoCapKind; readonly limit: number; readonly reason: string }

export interface SeoScore {
  /** 0 to 100, a whole number, after any cap. */
  readonly score: number;
  /** The score before any cap. */
  readonly uncapped: number;
  /** The cap that applies to this article (the score cannot rise above its limit until the cause is fixed), or null. */
  readonly cap: SeoCap | null;
  /** The search phrase scored against, or null when none is on record. */
  readonly phrase: string | null;
  /** Failures first, then partly, then passes. */
  readonly checks: readonly SeoCheck[];
  readonly parts: readonly SeoPartTotal[];
  readonly words: number;
  /** Flesch reading ease (rounded), or null with too little text. */
  readonly readingEase: number | null;
  /** Names of checks left out because they could not be run for this article. */
  readonly leftOut: readonly string[];
  /** Points earned and points available among the checks that ran (score = earned / available, scaled to 100). */
  readonly earned: number;
  readonly available: number;
  /** Share of different words in a moving window (0 to 1); low means the same few words again and again. */
  readonly vocabulary: number;
  /** What the repetition, sentence and stuffing measures found (percentages of the article), for tests and tuning. */
  readonly measures: { readonly repeatedSentences: number; readonly repeatedWording: number; readonly joiningWords: number; readonly phraseShare: number };
}

export const SEO_WEIGHTS = {
  phraseTitle: 5, phraseTitleStart: 1, phraseDescription: 4, phraseAddress: 3, phraseOpening: 4, phraseHeading: 3, phraseUse: 3,
  titleLength: 3, descriptionLength: 3, addressLength: 2, articleLength: 4, subHeadings: 2, questions: 2,
  internalLink: 5, outsideSource: 5,
  mainPicture: 5, pictureDescriptionPhrase: 2,
  sentenceLength: 5, paragraphLength: 4, headingSpacing: 4, readingEase: 6, sentenceStarts: 2, linkingWords: 4, variety: 4,
  relatedQuestions: 7, openingToThePoint: 2, nextStep: 3, figureSources: 3,
} as const;

export const SEO_PART_LABELS: Record<SeoPart, string> = { search: 'Search', read: 'Easy to read', answers: 'Answers the searcher' };
export const SEO_GROUP_LABELS: Record<SeoCheckGroup, string> = { phrase: 'The search phrase', page: 'The page', links: 'Links', pictures: 'Pictures', read: 'Easy to read', answers: 'Answers the searcher' };
const PART_OF: Record<SeoCheckGroup, SeoPart> = { phrase: 'search', page: 'search', links: 'search', pictures: 'search', read: 'read', answers: 'answers' };

/**
 * The length band for each kind of search: below `thin` is thin, from `low` to `high` passes, above `high` is long
 * (partly, never more points). A "how it works" answer or a how-to can be complete well under 1,200 words.
 */
export const LENGTH_BANDS: Readonly<Record<string, { readonly thin: number; readonly low: number; readonly high: number; readonly what: string }>> = {
  learn: { thin: 400, low: 600, high: 2500, what: 'a guide or how-to' },
  compare: { thin: 600, low: 900, high: 2500, what: 'a comparison' },
  buy: { thin: 250, low: 400, high: 1500, what: 'a page for someone ready to buy or hire' },
  default: { thin: 600, low: 900, high: 2500, what: 'an article' },
};
/** The score is held at or below these while the condition lasts. */
export const MUST_FIX_CAP = 59;
export const REPETITION_CAP = 40;
export const STUFFING_CAP = 60;
export const SOME_REPETITION_CAP = 70;
/**
 * The recommended pass bar when the score is used as a gate (an automatic step may keep a rewrite only when it
 * reaches the bar, then stops). With no picture the picture's points cannot be earned, so the bar is lower.
 */
export const SEO_GATE_BAR = { withPicture: 90, withoutPicture: 85 } as const;
const LONG_PARAGRAPH_WORDS = 150;
const LONG_SENTENCE_WORDS = 20;
const HEADING_SPACING_WORDS = 300;
const OPENING_WORDS = 60;
/** A "real sentence" for the phrase: at least this many words. */
const REAL_SENTENCE_WORDS = 6;
/** Average sentence length below this reads as choppy; below CHOPPY_FAIL, as fragments. */
const SENTENCE_FLOOR = 10;
const CHOPPY_FAIL = 6;
/** A sentence under this many words is a fragment. */
const FRAGMENT_WORDS = 4;
/** In an article that is mostly list items, below this many words of prose (and full-sentence items) the reading checks cannot pass. */
const MIN_PROSE_WORDS = 150;
/** A sentence of at least this many words can be a near repeat of an earlier one (one or two words changed). */
const NEAR_REPEAT_WORDS = 8;
/** Runs of this many words are compared across the whole article for repeated wording. */
const REPEAT_RUN = 5;
/**
 * Repeated runs of words, as a share of the article: up to RUNS_PASS is natural (good articles measure 0% to 3%);
 * above RUNS_FAIL fails; above RUNS_SOME the score is capped at SOME_REPETITION_CAP, above RUNS_CAP at REPETITION_CAP.
 * Repeated sentences and list items, as a share of them, use the same SOME and CAP limits.
 */
const RUNS_SOME = 10;
const RUNS_PASS = 6;
const RUNS_FAIL = 15;
const RUNS_CAP = 25;
/**
 * The phrase's share of the article's words (every use in any close form, times its main words): above PHRASE_HIGH it
 * reads as forced; above PHRASE_STUFFED it is stuffed, the check fails and the score is capped at STUFFING_CAP.
 */
const PHRASE_HIGH = 2.5;
const PHRASE_STUFFED = 4;
/** A part (sub-heading and its text) needs at least this many words. */
const PART_MIN_WORDS = 40;
/** At most this many sub-headings per 1,000 words (one every 80 words or so). */
const HEADINGS_PER_1000 = 12;
/** An answer needs at least this many words. */
const ANSWER_MIN_WORDS = 12;
const MAX_FAQS = 10;
/** Words that, after "how", frame a question rather than say what it is about. */
const QUESTION_FRAME = new Set(['often', 'long', 'much', 'many', 'soon']);
/** One starting word above this share of sentences is repetitive (partly), above START_FAIL it fails; everyday starts have a higher allowance. */
const START_SHARE = 15;
const START_FAIL = 25;
const START_SHARE_COMMON = 25;
const START_FAIL_COMMON = 35;
const COMMON_STARTS = new Set(['the', 'a', 'an', 'it', 'this', 'you', 'your', 'if', 'i', 'we', 'in', 'there', 'that', 'they', 'when', 'for', 'on']);
/** Linking words in at least LINKING_FLOOR% of sentences pass (up to 60%); under LINKING_FAIL% fails. Good short
 * pages and glossaries measure 15% to 20%; linking words are a help to reading, never a guard against rubbish. */
const LINKING_FLOOR = 15;
const LINKING_FAIL = 8;
/** Window for the vocabulary measure (moving-average share of different words). */
const VOCAB_WINDOW = 50;
/** Vocabulary measure: from VOCAB_PASS the wording is varied; below VOCAB_FAIL it fails; below VOCAB_CAP the score is capped. Ordinary prose measures about 0.75 to 0.85. */
const VOCAB_PASS = 0.65;
const VOCAB_FAIL = 0.55;
const VOCAB_CAP = 0.5;
/** Ordinary sentences are about 40% to 55% small joining words; under this percentage the text is capped. */
const SENTENCE_WORDS_CAP = 28;

// ─── Words ───────────────────────────────────────────────────────────────────

/** Words that carry no meaning on their own; ignored when looking for the phrase's words close together. */
const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'as', 'is', 'are', 'be', 'it', 'its', 'your', 'you', 'my', 'our', 'we', 'i',
  'how', 'what', 'why', 'when', 'where', 'which', 'who', 'do', 'does', 'can', 'should', 'vs', 'versus', 'into', 'about', 'this', 'that', 'much', 'many', 'me', 'if', 'there', 'their', 'they', 'need', 'get',
  'will', 'would', 'was', 'were', 'has', 'have', 'had', 'not', 'no', 'yes', 'so', 'but', 'than', 'then', 'all', 'any', 'some', 'more', 'most', 'just', 'very', 'too', 'also', 'one', 'i\'m', 'it\'s', 'don\'t']);

/** Markdown and citation markers out; link labels kept, their addresses dropped. */
function readable(markdown: string): string {
  return markdown
    .replace(/[ \t]*\[src:[A-Za-z0-9-]{1,64}\]/g, ' ')
    .replace(/\[([^\]\n]{0,200})\]\((?:[^\s)]{0,500})\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\*\*|__|[*_`]/g, '');
}

/** Lower-case words: letters and numbers, with an apostrophe allowed inside a word (curly or straight, the same). */
export function words(text: string): string[] {
  const out: string[] = [];
  const s = (/[^\x00-\x7f]/.test(text) ? text.normalize('NFKC') : text).toLowerCase().replace(/[‘’ʼ`´]/g, "'");
  for (const m of s.matchAll(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu)) out.push(m[0]);
  return out;
}

/** Plurals ending in -es whose singular ends in -us or a single -s ("buses" and "bus", "gases" and "gas"). */
const US_PLURALS = new Set(['buses', 'bonuses', 'viruses', 'statuses', 'campuses', 'censuses', 'focuses', 'corpuses', 'prospectuses', 'surpluses', 'syllabuses', 'gases', 'lenses', 'atlases', 'canvases', 'aliases', 'biases', 'irises', 'walruses', 'circuses', 'cactuses', 'octopuses', 'geniuses', 'choruses', 'minibuses']);
/** Words that look like a plural of another word but are a different word ("glasses" are not more than one "glass"). */
const NOT_PLURALS = new Set(['glasses', 'news', 'species', 'series', 'means', 'physics', 'economics', 'politics', 'maths', 'mathematics', 'thanks', 'whereas', 'always', 'perhaps', 'afterwards', 'towards', 'besides', 'sometimes', 'overseas', 'premises', 'savings', 'earnings', 'outskirts', 'lettings', 'proceeds']);

/**
 * A light English stem so plural and possessive forms match: "loans" and "loan", "landlord's" and "landlords" and
 * "landlord", "properties" and "property", "boxes" and "box", "buses" and "bus". Deliberately small: it never joins
 * different words, so "glasses" stays apart from "glass" and "news" from "new".
 */
export function stem(word: string): string {
  let w = word.replace(/'s$/, '').replace(/'/g, '');
  if (NOT_PLURALS.has(w)) return w;
  if (US_PLURALS.has(w)) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(?:ss|[xz]|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  return w;
}
/**
 * Close forms of one word, for counting how often the phrase is used: its stem, and the stem without an -ing or -ed
 * ending or a silent final e ("appraise", "appraising" and "appraised" share "apprais"; "bleeding" and "bleed" share
 * "bleed"; "stopped" and "stop" share "stop"). Two words are close forms when they share a key.
 */
const closeMemo = new Map<string, readonly string[]>();
export function closeKeys(word: string): readonly string[] {
  const hit = closeMemo.get(word);
  if (hit) return hit;
  if (closeMemo.size > 50_000) closeMemo.clear();
  const keys = closeKeysOf(word);
  closeMemo.set(word, keys);
  return keys;
}
function closeKeysOf(word: string): readonly string[] {
  const s = stem(word);
  const keys = new Set<string>([s]);
  const add = (k: string) => { if (k.length >= 3) keys.add(k); };
  let base = s;
  if (s.length > 5 && s.endsWith('ing')) base = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ied')) base = `${s.slice(0, -3)}y`;
  else if (s.length > 4 && s.endsWith('ed') && !s.endsWith('eed')) base = s.slice(0, -2);
  if (base !== s) { add(base); if (/([b-df-hj-np-tv-z])\1$/.test(base) && !/(?:ll|ss|zz|ff)$/.test(base)) add(base.slice(0, -1)); }
  for (const k of [...keys]) if (k.length > 3 && k.endsWith('e')) add(k.slice(0, -1));
  return [...keys];
}
const closeEq = (a: readonly string[], b: readonly string[]) => a.some((k) => b.includes(k));
const stems = (ws: readonly string[]) => ws.map(stem);

interface Phrase { readonly raw: readonly string[]; readonly s: readonly string[]; readonly need: readonly string[] }
function phraseOf(text: string): Phrase {
  const raw = words(text);
  const kept = raw.filter((w) => !STOP.has(w));
  return { raw, s: stems(raw), need: [...new Set((kept.length ? kept : raw).map(stem))] };
}
const meaningStems = (ws: readonly string[]) => [...new Set(ws.filter((w) => !STOP.has(w)).map(stem))];

/**
 * Every start index of the exact phrase (whole stemmed words, in order), not overlapping. With `gap`, up to that many
 * small joining words may sit between two of its words: "boiler service in Leeds" is the phrase "boiler service Leeds".
 */
function exactAt(tokens: readonly string[], phrase: readonly string[], gap = 0): number[] {
  const at: number[] = [];
  if (!phrase.length) return at;
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    let k = i, ok = true;
    for (let j = 0; j < phrase.length; j++) {
      if (j > 0) for (let g = 0; g < gap && k < tokens.length && tokens[k] !== phrase[j] && GAP_WORDS.has(tokens[k]!); g++) k++;
      if (tokens[k] !== phrase[j]) { ok = false; break; }
      k++;
    }
    if (ok) { at.push(i); i = k - 1; }
  }
  return at;
}
/** Small joining words allowed between the phrase's own words when it is matched as searched (not "the" or "a"). */
const PHRASE_GAP = 2;
const GAP_WORDS = new Set(['in', 'at', 'near', 'for', 'of', 'on', 'around', 'across', 'by', 'from', 'to', 'and', 'or', 'with', 'within']);

/** Start indexes of windows holding all the phrase's meaningful words close together, in any order (not overlapping). */
function looseAt(tokens: readonly string[], p: Phrase): number[] {
  if (!p.need.length) return [];
  const size = p.s.length + 5;
  const wanted = new Set(p.need);
  const at: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!wanted.has(tokens[i]!)) continue;
    const seen = new Set<string>();
    const end = Math.min(tokens.length, i + size);
    for (let k = i; k < end && seen.size < wanted.size; k++) if (wanted.has(tokens[k]!)) seen.add(tokens[k]!);
    if (seen.size === wanted.size) { at.push(i); i += size - 1; }
  }
  return at;
}

/**
 * Start indexes of uses of the phrase in any close form: at least `want` of its main words (all of them by default),
 * in any order and any close form ("appraising property deals" for "appraise a property deal"), within `size` words.
 * Uses do not overlap: the next one starts after the last word of the one before.
 */
function closeAt(tokens: readonly (readonly string[])[], need: readonly (readonly string[])[], size: number, want = need.length): number[] {
  if (!need.length) return [];
  const at: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!need.some((k) => closeEq(k, tokens[i]!))) continue;
    const found = new Set<number>();
    let last = i;
    const end = Math.min(tokens.length, i + size);
    for (let j = i; j < end && found.size < want; j++) need.forEach((k, ni) => { if (!found.has(ni) && closeEq(k, tokens[j]!)) { found.add(ni); last = j; } });
    if (found.size >= want) { at.push(i); i = last; }
  }
  return at;
}

type Match = 'exact' | 'loose' | 'none';
/** Match on stemmed tokens. `alone` is true when the text is nothing but the phrase. */
function matchTokens(t: readonly string[], p: Phrase): { kind: Match; at: number; length: number; alone: boolean } {
  const exact = exactAt(t, p.s, PHRASE_GAP);
  const alone = exact.length > 0 && t.length === p.s.length;
  if (exact.length) return { kind: 'exact', at: exact[0]!, length: t.length, alone };
  const loose = looseAt(t, p);
  if (loose.length) return { kind: 'loose', at: loose[0]!, length: t.length, alone: false };
  return { kind: 'none', at: -1, length: t.length, alone: false };
}
const match = (text: string, p: Phrase) => matchTokens(stems(words(text)), p);
const better = (a: Match, b: Match): Match => (a === 'exact' || b === 'exact' ? 'exact' : a === 'loose' || b === 'loose' ? 'loose' : 'none');

const isListLine = (line: string) => /^[-*]\s+/.test(line) || /^\d{1,3}[.)]\s+/.test(line);

/** Paragraphs as the renderer builds them: runs of non-list lines between blank lines (body headings end a run). */
function paragraphs(markdown: string): string[] {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => { if (run.length) out.push(run.join(' ')); run = []; };
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line || isListLine(line) || /^#{1,6}\s+/.test(line)) { flush(); continue; }
    run.push(line);
  }
  flush();
  return out;
}

/** Each list item's text (lists are read as one sentence per item). */
function listItems(markdown: string): string[] {
  return markdown.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(isListLine).map((l) => l.replace(/^(?:[-*]|\d{1,3}[.)])\s+/, ''));
}

/** Never the end of a sentence. */
const NEVER_END = /\b(?:e\.g|i\.e|mr|mrs|ms|dr|st|vs|cf)\.$/i;
/** The end of a sentence only when a capital letter follows ("etc. Then", "the U.K. Then"). */
const END_IF_CAPITAL = /(?:\b(?:etc|approx|inc|ltd|co)|\b(?:[a-z]\.){1,}[a-z])\.$/i;
/** "No. 5" is a number; "The answer is no. Then" is a sentence end. */
const NUMBER_ABBREVIATION = /\bno\.$/i;
/** Sentences of a paragraph: split after . ! ? (and runs of them) followed by a space, except after abbreviations. */
export function sentences(paragraph: string): string[] {
  const out: string[] = [];
  let start = 0;
  const text = paragraph.replace(/\s+/g, ' ').trim();
  for (const m of text.matchAll(/[.!?]+["”’)\]]*(?=\s|$)/g)) {
    const end = m.index! + m[0].length;
    const before = text.slice(start, m.index! + 1);
    const after = text.slice(end).trimStart();
    if (m[0][0] === '.' && m[0].length === 1) {
      if (NEVER_END.test(before)) continue;
      if (END_IF_CAPITAL.test(before) && after && !/^["“‘'(]?\p{Lu}/u.test(after)) continue;
      if (NUMBER_ABBREVIATION.test(before) && /^\d/.test(after)) continue;
    }
    const piece = text.slice(start, end).trim();
    if (piece) out.push(piece);
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out.filter((s) => /[\p{L}\p{N}]/u.test(s));
}

/** Compound words said as their two halves ("something" is "some" and "thing", "therefore" is "there" and "fore"). */
/**
 * Compound words said as their two halves ("something" is "some" and "thing", "homeowner" is "home" and "owner").
 * "every" is said in two syllables inside a compound ("everyone").
 */
const COMPOUND = /^(some|any|every|there|where|here|no|home|house|life|time|safe|fire|care|base)(one|ones|thing|things|times|time|where|body|fore|how|way|ways|owner|owners|work|made|wise|place|line|less|ever|guard|ment)$/;
/** Suffixes after which a final silent e stays silent inside the word ("statement", "careful", "safety", "lovely"). */
const SILENT_E_SUFFIX = /(?<=[aeiouy][^aeiouy])e(?=(?:ment|ments|ful|fully|fulness|ty|ly|ness|less|wise)$)/;

/**
 * A sensible English syllable estimate: vowel groups, less a silent e, plus vowel pairs said apart; at least one.
 * Rules, not a dictionary, in families:
 * - endings: "tables" and "metres" keep their last syllable; "makes" and "jumped" lose a silent -es or -ed; a silent e
 *   stays silent before -ment, -ful, -ty, -ly, -ness, -less and -wise ("statement", "useful", "safety");
 *   -gue and -que are silent ("league", "unique");
 * - vowel pairs said apart: "media", "client", "quiet", "being", "video", "ratio", "fuel", "poem", "ruin", "society",
 *   "trying", "going"; not "special", "nation", "patient", "million", "brilliant", "marriage";
 * - compounds count as their halves ("something", "everyone", "homeowner"); "business" drops its silent i.
 * The tests check it against two lists of hard words, one of them unseen while the rules were written.
 */
const syllableMemo = new Map<string, number>();
export function syllables(word: string): number {
  const hit = syllableMemo.get(word);
  if (hit !== undefined) return hit;
  if (syllableMemo.size > 50_000) syllableMemo.clear();
  const n = syllablesOf(word);
  syllableMemo.set(word, n);
  return n;
}
function syllablesOf(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  const compound = COMPOUND.exec(w);
  if (compound) return (compound[1] === 'every' ? 2 : syllables(compound[1]!)) + syllables(compound[2]!);
  if (w.startsWith('business')) return 2 + (w === 'businesses' ? 1 : 0);
  let core = /^e[lv]e/.test(w) ? w : w.replace(SILENT_E_SUFFIX, '');
  if (/[^aeiouy]les?$/.test(core) || /[tbgc]res?$/.test(core)) { /* "table(s)", "metre(s)": the final -le or -re is its own syllable */ }
  // "tongue", "league", "unique": a final -gue or -que is silent ("argue" is not).
  else if (/(?<!r)[gq]ues?$/.test(core) && core.length > 4) core = core.replace(/ues?$/, '');
  // "makes", "jumped" lose a silent -es / -ed; "boxes", "prices", "mortgages", "wanted" keep it.
  else if (/(?:[^aeiouy]es|[^aeiouytd]ed)$/.test(core) && !/(?:[sxz]|ch|sh|[cg])es$/.test(core)) core = core.slice(0, -2);
  else if (/[^aeiouy]e$/.test(core) && core.length > 2) core = core.slice(0, -1); // "make"
  const groups = core.match(/[aeiouy]+/g)?.length ?? 0;
  // Vowel pairs said as two syllables: "media", "valuation", "premium", "period", "area", "giant", "client", "quiet",
  // "being", "video", "ratio", "fuel", "valuer", "poem", "create", "react", "ruin", "society"; not "special",
  // "quality", "nation", "patient", "million", "brilliant", "parliament", "marriage".
  const apart = (core.match(/(?<![cgst]|ll|rl)ia(?!ge?$)|^gia|(?<![gq])ua|iu|(?<![cgstx]|ll|n)io|io$|^creat(?!ur)|^rea(?=ct)|(?<!t|[^s]c|^fr)ie(?=[nt])|ie(?=ty$)|eing|(?<!g)eo(?!p)|(?<![gq])ue(?=[lrn])|(?<![gq])ui(?=[nd])(?!ld)|oe(?=[mt])|(?<=[aeiou])y(?=[aeiou])(?!e[ds]?$)/g) ?? [])
    .filter((m) => !(m === 'y' && /^eye/.test(core))).length;
  // "going", "doing", "trying", "carrying": the -ing is its own syllable after a vowel sound ("being" and "paying" are
  // counted above).
  const vowelIng = /[aiou]ing$|[^aeiou]ying$/.test(w) ? 1 : 0;
  // A final "ea" after an earlier vowel is said apart ("area", "ideas"); alone it is one ("sea", "flea").
  const eaEnd = /[aeiouy][^aeiouy]+eas?$/.test(core) ? 1 : 0;
  return Math.max(1, groups + apart + vowelIng + eaEnd);
}

/** Flesch reading ease, computed on words with letters (numbers are left out). */
export function readingEase(sentenceList: readonly (string | readonly string[])[]): number | null {
  let wordsN = 0, syll = 0, sents = 0;
  for (const s of sentenceList) {
    const ws = (typeof s === 'string' ? words(s) : s).filter((w) => /\p{L}/u.test(w));
    if (!ws.length) continue;
    sents++; wordsN += ws.length;
    for (const w of ws) syll += syllables(w);
  }
  if (wordsN < 30 || !sents) return null;
  return 206.835 - 1.015 * (wordsN / sents) - 84.6 * (syll / wordsN);
}
function easeWords(score: number): string {
  if (score >= 90) return 'very easy to read';
  if (score >= 80) return 'easy to read';
  if (score >= 70) return 'fairly easy to read';
  if (score >= 60) return 'plain English';
  if (score >= 50) return 'fairly hard to read';
  if (score >= 30) return 'hard to read';
  return 'very hard to read';
}

/** Words and phrases that link one idea to the next (the readability tools' "transition words"). */
const LINKING_SINGLE = new Set(['because', 'so', 'therefore', 'however', 'but', 'although', 'though', 'also', 'then', 'first', 'firstly', 'second', 'secondly', 'third', 'finally', 'next',
  'meanwhile', 'instead', 'otherwise', 'besides', 'moreover', 'furthermore', 'similarly', 'likewise', 'still', 'yet', 'thus', 'hence', 'consequently', 'overall', 'indeed', 'unless',
  'whereas', 'while', 'since', 'until', 'once', 'lastly', 'afterwards', 'later', 'additionally', 'especially', 'specifically', 'namely', 'whether', 'nevertheless', 'nonetheless']);
const LINKING_PHRASES = ['for example', 'for instance', 'in fact', 'as a result', 'in other words', 'on the other hand', 'in addition', 'after that', 'above all', 'in short',
  'in particular', 'such as', 'even so', 'of course', 'at the same time', 'to sum up', 'in summary', 'as well as', 'rather than', 'so that', 'in the end', 'that is why', 'as long as', 'even if', 'in case']
  .map((p) => p.split(' '));
/** The linking words a sentence uses, and whether it starts with one. */
function linkingIn(ws: readonly string[]): { used: string[]; initial: boolean } {
  const used = ws.filter((w) => LINKING_SINGLE.has(w));
  let initial = ws.length > 0 && LINKING_SINGLE.has(ws[0]!);
  for (const p of LINKING_PHRASES) {
    const at = exactAt(ws, p);
    if (at.length) { used.push(p.join(' ')); if (at[0] === 0) initial = true; }
  }
  return { used, initial };
}

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = String(value).trim();
  if (!v) return null;
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`).hostname.toLowerCase().replace(/^www\./, '') || null; } catch { return null; }
}
function pathOf(value: string): string {
  try { return new URL(value).pathname.replace(/\/+$/, '').toLowerCase(); } catch { return ''; }
}

interface Link { readonly label: string; readonly url: string }
function links(markdown: string): Link[] {
  return [...markdown.matchAll(/\[([^\]\n]{1,200})\]\((https:\/\/[^\s)]{1,500})\)/g)].map((m) => ({ label: m[1]!, url: m[2]! }));
}

/** Moving-average share of different words over windows of VOCAB_WINDOW words (the whole text when shorter). */
function vocabulary(ws: readonly string[]): number {
  if (!ws.length) return 0;
  if (ws.length <= VOCAB_WINDOW) return new Set(ws).size / ws.length;
  const counts = new Map<string, number>();
  let distinct = 0, total = 0, windows = 0;
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    const c = counts.get(w) ?? 0; counts.set(w, c + 1); if (c === 0) distinct++;
    if (i >= VOCAB_WINDOW) { const o = ws[i - VOCAB_WINDOW]!; const k = counts.get(o)! - 1; counts.set(o, k); if (k === 0) distinct--; }
    if (i >= VOCAB_WINDOW - 1) { total += distinct / VOCAB_WINDOW; windows++; }
  }
  return total / windows;
}

interface Repetition {
  /** Sentences and list items of FRAGMENT_WORDS words or more (the ones that can repeat). */
  readonly counted: number;
  /** Of those, the ones that repeat an earlier one word for word, or nearly (one or two words changed). */
  readonly repeats: number;
  readonly exactRepeats: number;
  /** Words in repeated sentences and items. */
  readonly repeatWords: number;
  /** Share (0 to 1) of the whole text's runs of REPEAT_RUN words that already came earlier in the article. */
  readonly repeatedRuns: number;
}
/**
 * Repetition over the whole article, list items included: a sentence repeats when it matches an earlier one word for
 * word, or when most of its runs of three words already came earlier (an earlier sentence with one or two words
 * swapped); and the share of all runs of REPEAT_RUN words that came earlier in the article.
 */
function repetition(sentenceTokens: readonly (readonly string[])[]): Repetition {
  const seen = new Set<string>();
  const tri = new Set<string>();
  const runs = new Set<string>();
  let counted = 0, repeats = 0, exactRepeats = 0, repeatWords = 0, runTotal = 0, runRepeated = 0;
  for (const t of sentenceTokens) {
    for (let i = 0; i + REPEAT_RUN <= t.length; i++) {
      const k = t.slice(i, i + REPEAT_RUN).join(' ');
      runTotal++;
      if (runs.has(k)) runRepeated++; else runs.add(k);
    }
    const grams: string[] = [];
    for (let i = 0; i + 3 <= t.length; i++) grams.push(t.slice(i, i + 3).join(' '));
    if (t.length >= FRAGMENT_WORDS) {
      counted++;
      const key = t.join(' ');
      const exact = seen.has(key);
      const near = !exact && t.length >= NEAR_REPEAT_WORDS && grams.filter((g) => tri.has(g)).length * 3 >= grams.length * 2;
      if (exact || near) { repeats++; repeatWords += t.length; if (exact) exactRepeats++; }
      seen.add(key);
    }
    for (const g of grams) tri.add(g);
  }
  return { counted, repeats, exactRepeats, repeatWords, repeatedRuns: runTotal ? runRepeated / runTotal : 0 };
}

/**
 * The small words that hold English sentences together (articles, pronouns, prepositions, helping verbs, joining
 * words). Ordinary prose is about 40% to 55% these words; a list of nouns dressed as sentences is far below. This
 * measures whether the text is built of sentences, not whether what it says is true or useful.
 */
const FUNCTION_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'nor', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'into', 'onto', 'over', 'under', 'about', 'after',
  'before', 'up', 'down', 'out', 'off', 'through', 'between', 'against', 'during', 'without', 'within', 'around', 'than', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did',
  'have', 'has', 'had', 'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'it', 'its', 'this', 'that', 'these', 'those', 'there', 'here', 'he', 'she', 'they', 'we', 'you',
  'i', 'me', 'him', 'her', 'them', 'us', 'my', 'your', 'our', 'their', 'his', 'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'if', 'then', 'so', 'not', 'no', 'all', 'any',
  'some', 'each', 'every', 'more', 'most', 'much', 'many', 'very', 'just', 'also', 'only', 'too', 'own', 'such', 'other', 'both', 'either', 'neither', 'while', 'because', 'although', 'though',
  'until', 'since', 'unless', 'whether', 'yet', 'still', 'even', 'ever', 'again', 'once', 'one', "it's", "don't", "you're", "there's", "that's", "i'm", "isn't", "aren't", "can't", "won't",
  "doesn't", "didn't", "you'll", "we're", "they're", "let's", 'get', 'got', 'go', 'goes', 'make', 'makes', 'take', 'takes', 'way', 'like', 'well', 'now', 'never', 'always', 'often', 'usually']);
function functionShare(sentenceTokens: readonly (readonly string[])[]): number {
  let all = 0, small = 0;
  for (const t of sentenceTokens) for (const w of t) { if (!/\p{L}/u.test(w)) continue; all++; if (FUNCTION_WORDS.has(w)) small++; }
  return all ? small / all : 1;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
const quote = (s: string) => `“${s.length > 90 ? `${s.slice(0, 87).trimEnd()}...` : s}”`;
const pct = (n: number) => `${Math.round(n)}%`;

// ─── The score ───────────────────────────────────────────────────────────────

type Issue = NonNullable<SeoScoreContext['checkIssues']>[number];
const issueList = (x: unknown): Issue[] | null => (Array.isArray(x) ? x.filter((i): i is Issue => Boolean(i && typeof i === 'object')) : null);
const isCritical = (x: Issue) => x.severity === 'critical';

/** Accents off and apostrophes out, for comparing a page address ("café" and "cafe" are the same there). */
const plainLetters = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/['’]/g, '');
/** A Google title without a business name after a separator ("… | Martin Howard Property", "… – Harper Heating"). */
function titleWithoutName(title: string): string {
  const m = /^(.*\S)\s+(?:[|·•]|[-–—]{1,2})\s+([^|·•–—]{1,60})$/.exec(title.trim());
  return m && words(m[2]!).length <= 6 ? m[1]! : title;
}

export function seoScore(brief: Pick<ArticleBrief, 'targetQuery'> & Partial<Pick<ArticleBrief, 'relatedQuestions' | 'searchIntent'>> | null | undefined, body: ArticleBody, context: SeoScoreContext = {}): SeoScore {
  const rawPhrase = typeof brief?.targetQuery === 'string' ? brief.targetQuery.replace(/\s+/g, ' ').trim() : '';
  const p = phraseOf(rawPhrase);
  const hasPhrase = p.raw.length > 0;
  const target = context.targetMode === true || context.asTarget === true;
  const checks: SeoCheck[] = [];
  const leftOut: string[] = [];
  const add = (id: string, group: SeoCheckGroup, name: string, weight: number, result: SeoCheckResult, found: string, todo: string, fix: SeoFix | null, unlocks = 0, reasons = 1) =>
    checks.push({ id, part: PART_OF[group], group, name, weight, result, found, todo: result === 'pass' ? null : todo, points: result === 'pass' ? weight : result === 'partly' ? weight / 2 : 0, fix: result === 'pass' ? null : fix,
      ...(unlocks && result !== 'pass' ? { unlocks } : {}), ...(reasons > 1 && result !== 'pass' ? { reasons } : {}) });
  const count = (...xs: boolean[]) => xs.filter(Boolean).length;

  const str = (x: unknown) => (typeof x === 'string' ? x : x == null ? '' : String(x));
  const seoTitle = str(body?.seoTitle);
  const description = str(body?.metaDescription);
  const slug = str(body?.slug);
  const sections = (Array.isArray(body?.sections) ? body.sections : []).filter((s) => s && typeof s === 'object');
  const faqs = (Array.isArray(body?.faqs) ? body.faqs : []).filter((f) => f && typeof f === 'object');
  const intro = str(body?.intro);
  const conclusion = str(body?.conclusion);
  const headings = [...sections.map((s) => str(s.heading)), ...faqs.map((f) => str(f.q))];
  const bodies = [intro, ...sections.map((s) => str(s.body)), ...faqs.map((f) => str(f.a)), conclusion];
  const allWords = words(readable([intro, ...sections.flatMap((s) => [str(s.heading), str(s.body)]), ...faqs.flatMap((f) => [str(f.q), str(f.a)]), conclusion].join('\n')));
  const wordCount = allWords.length;
  const P = rawPhrase;
  const introWords = words(readable(intro));
  const related = (Array.isArray(brief?.relatedQuestions) ? brief!.relatedQuestions! : []).filter((q) => typeof q === 'string' && meaningStems(words(q)).length > 0);
  // "How often", "how long", "how much" and "how many" frame a question; the words after them are what it asks about.
  const questionWords = (q: string) => { const ws = words(q); return meaningStems(ws.filter((w, i) => !(QUESTION_FRAME.has(w) && ws[i - 1] === 'how'))); };
  const relatedNeeds = related.map((q) => questionWords(q).map(closeKeys));
  /** Close forms of a text's words, for matching meaning words. */
  const keysOf = (ws: readonly string[]) => ws.map(closeKeys);
  const covers = (need: readonly (readonly string[])[], have: readonly (readonly string[])[]) => need.filter((n) => have.some((h) => closeEq(n, h))).length;
  /** A heading that asks one of the questions on record (most of its meaning words). */
  const asksQuestion = (heading: string) => {
    const h = keysOf(words(heading));
    return relatedNeeds.some((need) => need.length > 0 && covers(need, h) * 4 >= need.length * 3);
  };

  // Sentences, block by block (the opening, each part, each answer, the closing paragraph), so a phrase split across a
  // heading and the text below it, or across two parts, never counts as a use. List items count as sentences.
  const sentenceWords = new Map<string, string[]>();
  const wordsOf = (x: string) => { let w = sentenceWords.get(x); if (!w) { w = words(x); sentenceWords.set(x, w); } return w; };
  const blockSentences = bodies.map((t) => {
    const prose = paragraphs(readable(t)).flatMap(sentences);
    const items = listItems(readable(t)).flatMap(sentences);
    return { prose, items };
  });
  const proseSentences = blockSentences.flatMap((b) => b.prose);
  const itemSentences = blockSentences.flatMap((b) => b.items);
  const allSentences = [...proseSentences, ...itemSentences];
  const tokens = allSentences.map(wordsOf);
  const proseTokens = tokens.slice(0, proseSentences.length);
  const n = allSentences.length;
  const np = proseSentences.length;

  // Repetition over the whole article, in reading order, list items included.
  const readingOrder = blockSentences.flatMap((b) => [...b.prose, ...b.items]).map(wordsOf);
  const rep = repetition(readingOrder);
  const dupShare = rep.counted ? (rep.repeats * 100) / rep.counted : 0;
  const repeatedRuns = rep.repeatedRuns * 100;
  const vocab = vocabulary(allWords);
  const smallWords = functionShare(readingOrder) * 100;

  // ── Search: the search phrase ──
  let stuffedShare = 0, phraseShare = 0;
  if (hasPhrase) {
    const titleTokens = words(seoTitle);
    const t = matchTokens(stems(titleTokens), p);
    // A business name after a separator is not a repeat ("Appraise a property deal | Martin Howard Property").
    // A repeat is a word used three times or a run of two words used twice: "change a tap washer and stop a dripping
    // tap" says "tap" twice naturally.
    const titleMeaning = words(titleWithoutName(seoTitle)).filter((w) => !STOP.has(w)).map(stem);
    const tCounts = new Map<string, number>();
    for (const w of titleMeaning) tCounts.set(w, (tCounts.get(w) ?? 0) + 1);
    const tPairs = titleMeaning.slice(1).map((w, i) => `${titleMeaning[i]} ${w}`);
    const titleRepeats = [...tCounts.values()].some((c) => c >= 3) || tPairs.length !== new Set(tPairs).size;
    const titleBare = titleTokens.length < p.s.length + 2;
    const titleResult: SeoCheckResult = t.kind === 'exact' && !titleRepeats && !titleBare ? 'pass' : t.kind !== 'none' ? 'partly' : 'fail';
    add('phrase.title', 'phrase', 'The search phrase is in the Google title', SEO_WEIGHTS.phraseTitle, titleResult,
      t.kind === 'exact' ? (titleRepeats ? `The Google title uses ${quote(P)}, but it repeats words.` : titleBare ? `The Google title is little more than ${quote(P)}.` : `The Google title uses ${quote(P)}.`)
        : t.kind === 'loose' ? `The Google title has the words of ${quote(P)}, in a different order.` : seoTitle.trim() ? `The Google title does not use ${quote(P)}.` : 'The Google title is empty.',
      t.kind === 'exact' ? `Write the Google title as a short, natural line that uses ${quote(P)} once and says what the reader gets.` : t.kind === 'loose' ? `If it still reads naturally, use the phrase ${quote(P)} as it is.` : `Put ${quote(P)} in the Google title, as naturally as you can.`, 'google-title',
      0, t.kind === 'exact' ? count(titleRepeats, titleBare) : 1);
    const firstHalf = t.at >= 0 && t.at <= Math.floor(t.length / 2);
    add('phrase.title_start', 'phrase', 'The search phrase is near the start of the Google title', SEO_WEIGHTS.phraseTitleStart,
      titleResult === 'pass' && firstHalf ? 'pass' : t.kind !== 'none' ? 'partly' : 'fail',
      t.kind === 'none' ? 'The phrase is not in the Google title yet.' : firstHalf ? (t.kind === 'exact' ? 'The phrase comes early in the Google title.' : 'Its words come early in the Google title, in a different order.') : 'The phrase comes late in the Google title.',
      'Move the search phrase towards the start of the Google title. People and Google read the first words most.', 'google-title');
    // Whether the description is a sentence is judged once, by its length check below.
    const d = match(description, p);
    add('phrase.description', 'phrase', 'The search phrase is in the short description in Google', SEO_WEIGHTS.phraseDescription,
      d.kind === 'exact' ? 'pass' : d.kind !== 'none' ? 'partly' : 'fail',
      d.kind === 'exact' ? `The short description uses ${quote(P)}.` : d.kind === 'loose' ? 'The short description has the words of the phrase, in a different order.' : description.trim() ? 'The short description does not use the phrase.' : 'The short description is empty.',
      `Use ${quote(P)} once in the short description. Google often shows those words in bold.`, 'description');
    // The address: accents and apostrophes off, plural and possessive forms accepted ("landlord-s" is "landlord's");
    // its main words in any order pass, because an address is short on purpose.
    const slugWords = stems(plainLetters(slug).split(/[^a-z0-9]+/).filter(Boolean).filter((w, i, all) => !(w === 's' && i > 0 && all[i - 1] !== 's')));
    const flat = (w: string) => stem(plainLetters(w));
    const pFlat = { s: p.raw.map(flat), need: [...new Set(p.need.map(flat))] };
    const slugExact = exactAt(slugWords, pFlat.s, PHRASE_GAP).length > 0;
    const slugMain = !slugExact && pFlat.need.every((w) => slugWords.includes(w));
    const slugSome = !slugExact && !slugMain && pFlat.need.some((w) => slugWords.includes(w));
    add('phrase.address', 'phrase', 'The search phrase is in the page address', SEO_WEIGHTS.phraseAddress,
      slugExact || slugMain ? 'pass' : slugSome ? 'partly' : 'fail',
      slugExact ? 'The page address uses the phrase.' : slugMain ? 'The page address has the main words of the phrase.' : slugSome ? 'The page address has some of the main words of the phrase.' : 'The page address does not use the phrase.',
      'Use the main words of the phrase in the page address, joined by hyphens. Only change it before the article is live.', 'address');
    // The opening: the phrase must sit inside a real sentence, not stand alone.
    const introBlock = blockSentences[0]!;
    let openReal: Match = 'none', openAny: Match = 'none';
    for (const s of [...introBlock.prose, ...introBlock.items]) {
      const ws = wordsOf(s);
      const m = matchTokens(stems(ws), p).kind;
      openAny = better(openAny, m);
      if (ws.length >= Math.max(REAL_SENTENCE_WORDS, p.s.length + 3)) openReal = better(openReal, m);
    }
    const openResult: SeoCheckResult = openReal === 'exact' ? 'pass' : openReal === 'loose' || openAny !== 'none' ? 'partly' : 'fail';
    add('phrase.opening', 'phrase', 'The search phrase is in the opening paragraph', SEO_WEIGHTS.phraseOpening, openResult,
      openReal === 'exact' ? 'The opening paragraph uses the phrase in a sentence.' : openReal === 'loose' ? 'The opening paragraph has the words of the phrase, in a different order.' : openAny !== 'none' ? 'The opening paragraph has the phrase only on its own, not inside a sentence.' : 'The opening paragraph does not use the phrase.',
      'Use the phrase inside one of the first two or three sentences, so readers and Google know at once what the article answers.', 'opening');
    // Sub-headings: one or two, each with more than the phrase alone. A heading that asks one of the questions on
    // record is not counted against the limit, so this check and the questions check never pull in opposite directions.
    // The phrase in a close form (plural, -ing, its main words in another order) counts in a heading too.
    const h = headings.map((x) => {
      const ws = words(x);
      const m = match(x, p);
      const close = m.kind === 'exact' || closeAt(keysOf(ws), p.need.map(closeKeys), p.s.length + 5).length > 0;
      return { m, real: close && !m.alone && ws.length > p.s.length, asks: asksQuestion(x) };
    });
    const hReal = h.filter((x) => x.real).length;
    const hAlone = h.filter((x) => x.m.alone).length;
    // The limit counts the exact phrase only: close forms read naturally however often they come.
    const hLimited = h.filter((x) => x.m.kind === 'exact' && !x.asks).length;
    const hResult: SeoCheckResult = hReal >= 1 && hLimited <= 2 && hAlone === 0 ? 'pass' : hReal + hAlone > 0 || h.some((x) => x.m.kind === 'loose') ? 'partly' : 'fail';
    add('phrase.heading', 'phrase', 'The search phrase is in one or two sub-headings', SEO_WEIGHTS.phraseHeading, hResult,
      hLimited > 2 ? `${plural(hLimited, 'sub-heading uses', 'sub-headings use')} the phrase. More than two reads as forced.`
        : hAlone ? 'A sub-heading is the phrase on its own, with nothing else.' : hReal ? `${plural(hReal, 'sub-heading uses', 'sub-headings use')} the phrase or a close form of it.` : h.some((x) => x.m.kind === 'loose') ? 'A sub-heading has the words of the phrase, but too far apart.' : headings.length ? 'No sub-heading uses the phrase.' : 'The article has no sub-headings.',
      hLimited > 2 ? 'Keep the phrase in one or two sub-headings and word the others in your own way.' : hAlone ? 'Give that sub-heading a few more words that say what the part covers.' : 'Use the phrase, or something very close to it, in one sub-heading that says what the part covers.', 'headings');
    // Use: every occurrence counts towards "too often", the phrase or a close form of it (plural, possessive, -ing or
    // -ed, its main words in another order), in sentences, short sentences, list items and sub-headings alike. Only
    // uses inside real sentences count towards "enough": one exact use and one more of any close form, in two places.
    const needKeys = p.need.map(closeKeys);
    const realLength = Math.max(REAL_SENTENCE_WORDS, p.s.length + 3);
    // A natural variation of a phrase of three or more main words may leave one out ("an interest only mortgage" for
    // "repayment or interest only mortgage"); it counts towards "enough", never towards "too often".
    const variantWant = needKeys.length >= 3 ? needKeys.length - 1 : needKeys.length;
    let all = 0, realExact = 0, realClose = 0, fragmentOnly = 0;
    const usedIn = new Set<number>();
    blockSentences.forEach((b, i) => {
      for (const s of [...b.prose, ...b.items]) {
        const ws = wordsOf(s);
        const keys = keysOf(ws);
        const close = closeAt(keys, needKeys, p.s.length + 5).length;
        all += close;
        if (ws.length >= realLength) {
          const variants = Math.max(close, closeAt(keys, needKeys, p.s.length + 5, variantWant).length);
          realExact += exactAt(stems(ws), p.s, PHRASE_GAP).length; realClose += variants; if (variants) usedIn.add(i);
        } else fragmentOnly += close;
      }
    });
    for (const x of headings) all += closeAt(keysOf(words(x)), needKeys, p.s.length + 5).length;
    // Three uses are never too many, however short the text.
    const share = wordCount && all > 3 ? (all * p.need.length * 100) / wordCount : 0;
    stuffedShare = share > PHRASE_STUFFED ? share : 0;
    phraseShare = share;
    const spread = usedIn.size >= 2;
    const useResult: SeoCheckResult = share > PHRASE_STUFFED ? 'fail' : realExact >= 1 && realClose >= 2 && spread && share <= PHRASE_HIGH ? 'pass' : realClose >= 1 ? 'partly' : 'fail';
    add('phrase.use', 'phrase', 'The search phrase is used a sensible number of times', SEO_WEIGHTS.phraseUse, useResult,
      realClose === 0 ? (share > PHRASE_STUFFED ? `The phrase comes up ${plural(all, 'time', 'times')} in ${plural(wordCount, 'word', 'words')}, mostly on its own. That is too many: it reads as stuffed.` : fragmentOnly ? 'The phrase only appears on its own, never inside a sentence.' : 'The article does not use the phrase at all.')
        : `The phrase, or a close form of it, comes up ${plural(Math.max(all, realClose), 'time', 'times')} in ${plural(wordCount, 'word', 'words')}${realExact ? '' : ', but never exactly as it is searched'}.${share > PHRASE_STUFFED ? ' That is too many: it reads as stuffed.' : share > PHRASE_HIGH ? ' That is a little high.' : realClose >= 2 && !spread ? ' All the uses are in one part.' : ''}`,
      share > PHRASE_HIGH ? 'Use the phrase a lot less. Say it naturally once or twice, and use other words for the same idea.' : realExact === 0 ? `Use the exact phrase ${quote(P)} once inside a sentence, and its natural variations elsewhere.` : realClose <= 1 ? 'Use the phrase, or a natural variation of it, once more in another part of the article.' : 'Spread the phrase out: use it, or a natural variation of it, in another part of the article too.', 'text');
  } else if (target) {
    add('phrase.missing', 'phrase', 'The search phrase is on record', 27, 'fail', 'There is no search phrase on record for this article, so it cannot be scored against one.', 'Plan the article from a search phrase first.', 'rewrite');
  } else leftOut.push('the search phrase checks (no search phrase is on record)');

  // ── Search: the page ──
  const tl = seoTitle.trim().length;
  add('page.title_length', 'page', 'Google title length', SEO_WEIGHTS.titleLength, tl >= 30 && tl <= 65 ? 'pass' : tl === 0 ? 'fail' : 'partly',
    tl === 0 ? 'The Google title is empty.' : `The Google title is ${plural(tl, 'character', 'characters')}.${tl > 65 ? ' Google may cut it short.' : tl < 30 ? ' That is short; there is room to say more.' : ''}`,
    tl === 0 ? 'Write a Google title of 30 to 65 characters.' : tl > 65 ? 'Shorten it to 65 characters or fewer.' : 'Lengthen it towards 50 or 60 characters.', 'google-title');
  const dl = description.trim().length;
  const descTokens = words(description).filter((w) => !STOP.has(w)).map(stem);
  const descCounts = new Map<string, number>();
  for (const w of descTokens) descCounts.set(w, (descCounts.get(w) ?? 0) + 1);
  const descRepeats = [...descCounts.values()].some((c) => c > 2) || (hasPhrase && exactAt(stems(words(description)), p.s).length > 1);
  const descIsSentence = sentences(description).some((x) => words(x).length >= REAL_SENTENCE_WORDS) && words(description).length >= 8;
  const descLenOk = dl >= 70 && dl <= 160;
  add('page.description_length', 'page', 'Short description length', SEO_WEIGHTS.descriptionLength, descLenOk && descIsSentence && !descRepeats ? 'pass' : dl === 0 ? 'fail' : 'partly',
    dl === 0 ? 'The short description in Google is empty.' : `The short description is ${plural(dl, 'character', 'characters')}.${dl > 160 ? ' Google may cut it short.' : dl < 70 ? ' That is short.' : ''}${descRepeats ? ' It repeats the same words.' : !descIsSentence ? ' It does not read as a sentence.' : ''}`,
    'Aim for 70 to 160 characters: one or two sentences that make people want to click.', 'description', 0, count(!descLenOk, !descIsSentence, descRepeats));
  const sl = slug.length;
  add('page.address_length', 'page', 'Page address length', SEO_WEIGHTS.addressLength, sl > 0 && sl <= 60 ? 'pass' : sl > 0 && sl <= 80 ? 'partly' : 'fail',
    sl === 0 ? 'The page address ending is empty.' : `The page address ending is ${plural(sl, 'character', 'characters')}.`,
    sl === 0 ? 'Give the article a page address ending of a few words joined by hyphens.' : 'Keep the page address ending short: a few key words joined by hyphens. Only change it before the article is live.', 'address');
  // Length, in a band that suits what the searcher wants. Repeated sentences are not counted, and nothing above the
  // band earns more: length is never a reason to pad.
  const band = LENGTH_BANDS[brief?.searchIntent ?? ''] ?? LENGTH_BANDS.default!;
  const effective = Math.max(0, wordCount - rep.repeatWords);
  const grade = effective > band.high ? 'long' : effective >= band.low ? 'strong' : effective >= band.thin ? 'fine' : 'thin';
  add('page.length', 'page', 'Article length', SEO_WEIGHTS.articleLength, grade === 'strong' ? 'pass' : grade === 'fine' || grade === 'long' ? 'partly' : 'fail',
    `${plural(wordCount, 'word', 'words')}: ${grade === 'strong' ? `a good length for ${band.what}` : grade}.${rep.repeatWords ? ` ${plural(rep.repeatWords, 'word is', 'words are')} in repeated sentences and not counted.` : ''}`,
    grade === 'thin' ? `Under ${band.thin.toLocaleString('en-GB')} words is thin for ${band.what}. Ask for a rewrite with more detail and examples.`
      : grade === 'fine' ? `${band.what[0]!.toUpperCase()}${band.what.slice(1)} of ${band.low.toLocaleString('en-GB')} words or more that stay useful tend to do better. Add an example or a worked case only if it helps the reader.`
        : `It is over ${band.high.toLocaleString('en-GB')} words. If any part does not help the reader, cut it; a long guide that stays useful is fine.`, 'rewrite');
  const named = sections.filter((s) => str(s.heading).trim());
  const distinctHeadings = new Set(named.map((s) => stems(words(str(s.heading))).join(' '))).size;
  const thinParts = named.filter((s) => words(readable(str(s.body))).length < PART_MIN_WORDS).length;
  const perThousand = effective ? (named.length * 1000) / effective : named.length ? Infinity : 0;
  const subResult: SeoCheckResult = named.length === 0 ? 'fail'
    : thinParts * 2 > named.length || perThousand > HEADINGS_PER_1000 * 2 ? 'fail'
      : named.length >= 3 && thinParts === 0 && distinctHeadings === named.length && perThousand <= HEADINGS_PER_1000 ? 'pass' : 'partly';
  add('page.subheadings', 'page', 'Sub-headings', SEO_WEIGHTS.subHeadings, subResult,
    named.length === 0 ? 'The article has no sub-headings.'
      : `The article has ${plural(named.length, 'sub-heading', 'sub-headings')}.${thinParts ? ` ${plural(thinParts, 'part has', 'parts have')} fewer than ${PART_MIN_WORDS} words under ${thinParts === 1 ? 'its' : 'their'} sub-heading.` : ''}${distinctHeadings < named.length ? ' Some sub-headings are the same.' : ''}${perThousand > HEADINGS_PER_1000 ? ' That is a lot of sub-headings for the length of the article.' : ''}`,
    named.length >= 3 ? 'Give each part a different sub-heading and enough text to be worth its own heading. Join very short parts together.' : 'Break the article into at least three parts, each with a clear sub-heading and a few paragraphs.', named.length ? 'headings' : 'rewrite',
    0, (named.length > 0 && named.length < 3 ? 1 : 0) + thinParts + count(distinctHeadings < named.length, perThousand > HEADINGS_PER_1000));
  const goodFaqs = faqs.filter((f) => {
    const qw = words(str(f.q)), aw = words(readable(str(f.a)));
    if (!qw.length || aw.length < ANSWER_MIN_WORDS) return false;
    const need = meaningStems(qw);
    const have = new Set(stems(aw));
    return need.some((w) => have.has(w)) || aw.length >= 20;
  }).length;
  const asked = faqs.filter((f) => str(f.q).trim() && str(f.a).trim()).length;
  add('page.questions', 'page', 'Questions and answers', SEO_WEIGHTS.questions, goodFaqs >= 3 && asked <= MAX_FAQS ? 'pass' : goodFaqs >= 1 ? 'partly' : 'fail',
    asked ? `The article answers ${plural(asked, 'question', 'questions')} in its questions and answers${goodFaqs < asked ? `; ${plural(goodFaqs, 'answer is', 'answers are')} full enough to help` : ''}.${asked > MAX_FAQS ? ` More than ${MAX_FAQS} is a lot to read.` : ''}` : 'The article has no questions and answers.',
    asked > MAX_FAQS ? `Keep the ${MAX_FAQS} questions people ask most and answer each one properly.` : asked ? 'Answer each question in two or three sentences that use its own words, and add a few more of the questions people ask.' : 'Ask for a rewrite that adds three to five questions people ask about this.', 'rewrite');

  // ── Search: links ──
  const own = new Set((context.siteHosts ?? []).map(hostOf).filter((x): x is string => Boolean(x)));
  const isOwn = (host: string | null) => host !== null && (own.has(host) || [...own].some((o) => host.endsWith(`.${o}`)));
  const issues = issueList(context.checkIssues);
  const flagged = (code: string, url: string) => Boolean(issues?.some((x) => x.code === code && typeof x.message === 'string' && x.message.includes(url)));
  const selfPath = context.selfUrl ? pathOf(context.selfUrl) : '';
  const textLinks = bodies.flatMap(links);
  const ownLinks = textLinks.filter((l) => isOwn(hostOf(l.url)));
  // A link to a page that is not live is a must-fix issue and already holds the whole score down (the cap below), so
  // it is not taken off here a second time.
  const notLive = (l: Link) => flagged('links.broken_internal', l.url);
  const weak = (l: Link): string | null => {
    const path = pathOf(l.url);
    if (!path) return 'the home page';
    if ((selfPath && path === selfPath) || (slug && path.endsWith(`/${slug.toLowerCase()}`))) return 'this article itself';
    if (notLive(l) && !issues?.some((x) => x.code === 'links.broken_internal' && isCritical(x))) return 'a page that is not live';
    if (words(l.label).length < 2) return 'a one-word link';
    return null;
  };
  const goodOwn = ownLinks.filter((l) => !weak(l)).length;
  const goodOwnNotLive = ownLinks.filter((l) => !weak(l) && notLive(l)).length;
  const weakReasons = [...new Set(ownLinks.map(weak).filter((x): x is string => Boolean(x)))];
  const external = textLinks.filter((l) => !isOwn(hostOf(l.url)));
  const cta = body?.cta && typeof body.cta === 'object' ? body.cta : null;
  const ctaOwn = Boolean(cta && isOwn(hostOf(str(cta.url))));
  add('links.internal', 'links', 'A link to another page on your own site', SEO_WEIGHTS.internalLink, goodOwn ? 'pass' : ownLinks.length || ctaOwn ? 'partly' : 'fail',
    goodOwn ? `The text links to your own site ${plural(goodOwn, 'time', 'times')}.${goodOwnNotLive ? ` ${goodOwnNotLive === 1 ? 'One of those pages is' : 'Some of those pages are'} not live yet: that is in the list of things to fix.` : ''}` : ownLinks.length ? `The text links to your own site, but only to ${weakReasons.join(' or ')}.` : ctaOwn ? 'Only the button at the end links to your site.' : own.size ? 'The text does not link to any other page on your site.' : 'We do not know your website address yet, so we cannot tell which links are yours.',
    'Link a few words in the text to a related page on your site that is live, such as a service page or another article.', 'links');
  const citations = Array.isArray(body?.citations) ? body.citations : [];
  const publicSources = citations.filter((c) => c?.public).length;
  const checkedExternal = issues ? external.filter((l) => !flagged('links.unverified_external', l.url)).length : 0;
  add('links.sources', 'links', 'At least one cited outside source', SEO_WEIGHTS.outsideSource, publicSources || checkedExternal ? 'pass' : citations.length || external.length ? 'partly' : 'fail',
    publicSources ? `The article shows ${plural(publicSources, 'source', 'sources')} to readers.` : checkedExternal ? `The text links to ${plural(checkedExternal, 'outside source', 'outside sources')} from the research.`
      : external.length ? (issues ? 'The text links to outside websites, but none of them was part of the research.' : 'The text links to outside websites. They are counted once the checks have run on this version.')
        : citations.length ? 'Sources were used for research, but none is shown to readers.' : 'The article cites no outside source.',
    'Back up the key facts with a trusted source, such as an official or industry website.', citations.length || external.length ? null : 'rewrite');

  // ── Search: pictures ──
  // No picture costs the picture's points once: the description check is not run until there is a picture to describe.
  const image = body?.image && typeof body.image === 'object' ? body.image : { url: null, alt: '' };
  const alt = str(image.alt).trim();
  const altWords = words(alt);
  const altOnlyPhrase = hasPhrase && altWords.length > 0 && stems(altWords).join(' ') === p.s.join(' ');
  const altOk = altWords.length >= 4 && !altOnlyPhrase;
  add('pictures.main', 'pictures', 'A main picture with a picture description', SEO_WEIGHTS.mainPicture, image.url ? (altOk ? 'pass' : 'partly') : 'fail',
    image.url ? (altOk ? 'The article has a main picture with a description.' : altOnlyPhrase ? 'The picture description is only the search phrase, not a description of the picture.' : alt ? 'The article has a main picture, but its description is too short.' : 'The article has a main picture, but no description of it.') : 'The article has no main picture yet.',
    image.url ? 'Describe what the picture shows in a few words, for people who cannot see it.' : 'Add a picture: upload a photo, use one from your website or ask us to make one.', image.url ? 'picture-description' : 'picture',
    hasPhrase && !image.url ? SEO_WEIGHTS.pictureDescriptionPhrase : 0);
  if (hasPhrase && image.url) {
    // The topic, said naturally: the phrase's last main word (usually what it is about: "radiator", "mortgage") or at
    // least half its main words, in any close form. The exact phrase is never required, so stuffing it earns nothing.
    const have = keysOf(altWords);
    const needKeys = p.need.map(closeKeys);
    const got = covers(needKeys, have);
    const head = needKeys.length ? covers([needKeys[needKeys.length - 1]!], have) > 0 : false;
    const aResult: SeoCheckResult = altOnlyPhrase ? 'fail' : !altOk ? 'partly' : head || got * 2 >= needKeys.length ? 'pass' : got > 0 ? 'partly' : 'fail';
    add('pictures.phrase', 'pictures', 'The picture description mentions the topic', SEO_WEIGHTS.pictureDescriptionPhrase, aResult,
      altOnlyPhrase ? 'The picture description is the phrase on its own, not a description that mentions it.' : !altOk ? 'The picture description needs to describe the picture first.' : aResult === 'pass' ? 'The picture description mentions what the article is about.' : got ? 'The picture description mentions only part of what the article is about.' : 'The picture description does not mention what the article is about.',
      !altOk ? 'Describe what the picture shows in a few words; mention the topic only where it is true to the picture.' : 'If it is true to the picture, mention the topic in its description. The exact search phrase is not needed.', 'picture-description');
  } else if (hasPhrase) leftOut.push('the picture description (there is no picture yet)');

  // ── Easy to read ──
  // Sentence length, reading ease and linking words are judged on the prose. Short numbered and bulleted steps ("Undo
  // the screw. Keep it safe.") are short on purpose, so they are left out of those shares; list items written as full
  // sentences (a glossary's definitions) count as prose. An article that is mostly list items is told so plainly, and
  // with too little prose to judge these checks cannot pass.
  const STEP_WORDS = 10;
  const readTokens = [...proseTokens, ...tokens.slice(np).filter((t) => t.length >= STEP_WORDS)];
  const nr = readTokens.length;
  const proseWordsN = proseTokens.reduce((s, t) => s + t.length, 0);
  const readWordsN = readTokens.reduce((s, t) => s + t.length, 0);
  const itemWordsN = tokens.slice(np).reduce((s, t) => s + t.length, 0);
  const mostlyList = itemWordsN > proseWordsN;
  const thinProse = mostlyList && readWordsN < MIN_PROSE_WORDS;
  const listNote = thinProse && n ? ` Most of the article is list items, with too little prose to judge this fully.` : mostlyList ? ' Most of the article is list items; this is judged on the prose and the full-sentence items.' : '';
  const notOverPartly = (r: SeoCheckResult): SeoCheckResult => (thinProse && r === 'pass' ? 'partly' : r);
  const avgLen = nr ? readWordsN / nr : 0;
  const fragments = readTokens.filter((t) => t.length < FRAGMENT_WORDS).length;
  const fragShare = nr ? (fragments * 100) / nr : 0;
  // Long sentences are counted against every sentence, list items included: a short step is never too long.
  const longS = tokens.filter((t) => t.length > LONG_SENTENCE_WORDS).length;
  const longShare = n ? (longS * 100) / n : 0;
  const choppy = avgLen < SENTENCE_FLOOR || fragShare > 15;
  const sentResult: SeoCheckResult = !nr ? 'fail'
    : longShare > 35 || avgLen < CHOPPY_FAIL || fragShare > 35 ? 'fail'
      : notOverPartly(longShare <= 25 && !choppy ? 'pass' : 'partly');
  add('read.sentences', 'read', 'Sentence length', SEO_WEIGHTS.sentenceLength, sentResult,
    !nr ? (n ? 'The article is all short list items, with no sentences of prose to judge.' : 'The article has no sentences yet.') : `${pct(longShare)} of sentences are longer than ${LONG_SENTENCE_WORDS} words (${longS} of ${n}). Sentences average ${plural(Math.round(avgLen), 'word', 'words')}.${choppy ? ' Many are very short, which reads as choppy.' : ''}${listNote}`,
    choppy && longShare <= 25 ? `Join very short sentences into full ones. Aim for about ${SENTENCE_FLOOR} to 20 words in most sentences.` : 'Split the longest sentences in two. Aim for no more than one sentence in four over 20 words.', 'text',
    0, count(longShare > 25, choppy, thinProse));
  const proseParas = bodies.flatMap((t) => paragraphs(readable(t)));
  const longP = proseParas.filter((x) => words(x).length > LONG_PARAGRAPH_WORDS).length;
  add('read.paragraphs', 'read', 'Short paragraphs', SEO_WEIGHTS.paragraphLength, !n ? 'fail' : longP === 0 ? 'pass' : longP <= 2 ? 'partly' : 'fail',
    !n ? 'The article has no paragraphs yet.' : longP === 0 ? `No paragraph is longer than ${LONG_PARAGRAPH_WORDS} words.` : `${plural(longP, 'paragraph is', 'paragraphs are')} longer than ${LONG_PARAGRAPH_WORDS} words.`,
    'Split long paragraphs into shorter ones. People read on phones.', 'text');
  // Stretches of text between headings, as the page shows them: the opening, each part, each answer; the closing
  // paragraph runs on from whatever comes last.
  const stretches = [intro, ...sections.map((s) => str(s.body)), ...faqs.map((f) => str(f.a))].map((t) => words(readable(t)).length);
  stretches[stretches.length - 1] = (stretches[stretches.length - 1] ?? 0) + words(readable(conclusion)).length;
  const longest = Math.max(0, ...stretches);
  const tooLong = stretches.filter((x) => x > HEADING_SPACING_WORDS).length;
  add('read.spacing', 'read', 'Sub-headings often enough', SEO_WEIGHTS.headingSpacing, !n ? 'fail' : tooLong === 0 ? 'pass' : longest <= 400 ? 'partly' : 'fail',
    !n ? 'The article has no text yet.' : tooLong === 0 ? `No stretch of text runs over ${HEADING_SPACING_WORDS} words without a sub-heading.` : `${plural(tooLong, 'stretch runs', 'stretches run')} over ${HEADING_SPACING_WORDS} words without a sub-heading (the longest is ${plural(longest, 'word', 'words')}).`,
    'Add a sub-heading inside the longest parts, so readers can scan.', 'headings');
  // Reading ease earns nothing extra for fragments: a pass also needs sentences of a sensible length.
  const ease = readingEase(readTokens);
  const easeResult: SeoCheckResult = ease === null ? 'fail' : notOverPartly(ease >= 60 ? (avgLen >= SENTENCE_FLOOR - 2 ? 'pass' : avgLen >= CHOPPY_FAIL ? 'partly' : 'fail') : ease >= 50 ? 'partly' : 'fail');
  add('read.ease', 'read', 'Reading ease', SEO_WEIGHTS.readingEase, easeResult,
    ease === null ? 'There is too little prose to judge how easy it is to read.' : `Reading ease ${Math.round(ease)} out of 100: ${easeWords(ease)}.${ease >= 60 && avgLen < CHOPPY_FAIL ? ' It only looks easy because the sentences are fragments.' : ease >= 60 && avgLen < SENTENCE_FLOOR - 2 ? ' Much of that comes from very short sentences, so the text is not quite as easy as the number says.' : ' Most readers find 60 or more comfortable.'}${listNote}`,
    ease !== null && ease >= 60 ? 'Write in full sentences with everyday words. Very short fragments are not easier to follow.' : 'Use shorter sentences and everyday words. Swap long words for short ones where you can.', 'text');
  // Varied starts: no long run of sentences starting with the same word, and no one word starting too many. Everyday
  // starts ("the", "a", "you", "it") are common in good writing, so they have a higher allowance.
  const firsts = proseTokens.map((t) => t[0] ?? '');
  const runLimit = (w: string) => (COMMON_STARTS.has(w) ? 4 : 3);
  let runs = 0;
  for (let i = 0, len = 1; i < firsts.length; i++) {
    len = i > 0 && firsts[i] && firsts[i] === firsts[i - 1] ? len + 1 : 1;
    if (firsts[i] && len === runLimit(firsts[i]!)) runs++;
  }
  const startCounts = new Map<string, number>();
  for (const w of firsts) if (w) startCounts.set(w, (startCounts.get(w) ?? 0) + 1);
  const shareOf = (w: string) => (np >= 10 ? ((startCounts.get(w) ?? 0) * 100) / np : 0);
  const over = (w: string, common: number, other: number) => shareOf(w) > (COMMON_STARTS.has(w) ? common : other);
  const overStart = [...startCounts.keys()].filter((w) => over(w, START_SHARE_COMMON, START_SHARE)).sort((x, y) => shareOf(y) - shareOf(x))[0];
  const failStart = [...startCounts.keys()].some((w) => over(w, START_FAIL_COMMON, START_FAIL));
  const startResult: SeoCheckResult = !np ? 'fail' : runs >= 2 || failStart ? 'fail' : runs === 1 || overStart ? 'partly' : 'pass';
  add('read.starts', 'read', 'Varied sentence starts', SEO_WEIGHTS.sentenceStarts, startResult,
    !np ? 'The article has no sentences yet.' : runs ? `${plural(runs, 'place has', 'places have')} a long run of sentences in a row starting with the same word.` : overStart ? `${pct(shareOf(overStart))} of sentences start with ${quote(overStart)}.` : 'Sentences start in varied ways.',
    runs ? 'Start one of those sentences differently.' : 'Start more sentences in other ways, so the text does not sound repetitive.', 'text');
  // Linking words: a pass band, with variety, and not just bolted to the start of every sentence.
  const linkInfo = readTokens.map(linkingIn);
  const linked = linkInfo.filter((x) => x.used.length > 0).length;
  const initialLinked = linkInfo.filter((x) => x.initial).length;
  const kinds = new Set(linkInfo.flatMap((x) => x.used)).size;
  const linkShare = nr ? (linked * 100) / nr : 0;
  const initialShare = nr ? (initialLinked * 100) / nr : 0;
  const enoughKinds = kinds >= Math.min(3, linked);
  const linkResult: SeoCheckResult = !nr ? 'fail'
    : linkShare < LINKING_FAIL || linkShare > 80 || initialShare > 60 ? 'fail'
      : notOverPartly(linkShare >= LINKING_FLOOR && linkShare <= 60 && initialShare <= 35 && enoughKinds ? 'pass' : 'partly');
  add('read.linking', 'read', 'Linking words', SEO_WEIGHTS.linkingWords, linkResult,
    nr ? `${pct(linkShare)} of sentences use a linking word such as “because”, “so” or “for example”.${initialShare > 35 ? ` ${pct(initialShare)} of sentences start with one.` : ''}${!enoughKinds ? ' The same few are used again and again.' : ''}${listNote}` : 'The article has no sentences of prose yet.',
    linkShare > 60 || initialShare > 35 ? 'Use fewer linking words, and put them inside sentences rather than at the start of each one.' : 'Join ideas with words like “because”, “so”, “however” and “for example”, where they fit. About one sentence in six is plenty.', 'text',
    0, count(linkShare < LINKING_FLOOR || linkShare > 60, initialShare > 35, !enoughKinds, thinProse));
  // Varied wording, over the whole article and its lists: repeated or nearly repeated sentences, repeated runs of
  // words, and the vocabulary.
  const varietyResult: SeoCheckResult = !n ? 'fail'
    : dupShare > 15 || repeatedRuns > RUNS_FAIL || vocab < VOCAB_FAIL ? 'fail'
      : dupShare <= 3 && repeatedRuns <= RUNS_PASS && vocab >= VOCAB_PASS ? 'pass' : 'partly';
  add('read.variety', 'read', 'Varied wording', SEO_WEIGHTS.variety, varietyResult,
    !n ? 'The article has no text yet.'
      : `${rep.repeats ? `${plural(rep.repeats, 'sentence or list item repeats', 'sentences and list items repeat')} an earlier one word for word or nearly.` : 'No sentence is repeated.'}${repeatedRuns > RUNS_PASS ? ` ${pct(repeatedRuns)} of the text repeats wording used earlier in the article.` : ''}${vocab < VOCAB_PASS ? ' The same few words come up again and again.' : ''}${varietyResult === 'pass' ? ' The wording is varied.' : ''}`,
    'Remove repeated sentences and say things in your own words. Readers and Google both notice repetition.', 'text',
    0, Math.max(0, rep.repeats - Math.floor((rep.counted * 3) / 100)) + count(repeatedRuns > RUNS_PASS, vocab < VOCAB_PASS));

  // ── Answers the searcher ──
  if (related.length) {
    // A question is answered by a part or a question in the questions and answers that has a real answer (at least
    // ANSWER_MIN_WORDS words, with at least one full sentence) and either asks it in its heading, shares part of it in the heading and the rest in the
    // text, or answers it in one paragraph or list that holds all of its meaning words (in any close form).
    const places = [...sections.map((s) => ({ h: str(s.heading), a: str(s.body) })), ...faqs.map((f) => ({ h: str(f.q), a: str(f.a) }))].map((x) => {
      const text = readable(x.a);
      const aw = words(text);
      const chunks = [...paragraphs(text), listItems(text).join(' ')].filter(Boolean).map((c) => keysOf(words(c)));
      const full = [...paragraphs(text).flatMap(sentences), ...listItems(text)].some((x) => words(x).length >= REAL_SENTENCE_WORDS);
      return { head: keysOf(words(x.h)), asks: /\?\s*$/.test(x.h), lead: keysOf(aw.slice(0, 200)), chunks, real: full && aw.length >= ANSWER_MIN_WORDS };
    });
    const answered = related.filter((_, qi) => {
      const need = relatedNeeds[qi]!;
      return places.some((pl) => {
        if (!pl.real) return false;
        const inHead = covers(need, pl.head);
        if (inHead * 4 >= need.length * 3 && inHead >= Math.min(need.length, 2)) return true;
        // A heading that is itself a question and shares all but one of three or more meaning words asks the same thing
        // ("How long does an appraisal take?" for "How long does a property appraisal take?").
        if (pl.asks && need.length >= 3 && inHead >= need.length - 1) return true;
        const covered = need.filter((w) => pl.head.some((h) => closeEq(w, h)) || pl.lead.some((h) => closeEq(w, h))).length;
        if (inHead * 2 >= need.length && covered * 4 >= need.length * 3 && covered >= Math.min(need.length, 2)) return true;
        return need.length >= 2 && pl.chunks.some((c) => covers(need, c) === need.length);
      });
    });
    const missing = related.filter((q) => !answered.includes(q));
    add('answers.questions', 'answers', 'The questions people ask are answered', SEO_WEIGHTS.relatedQuestions,
      missing.length === 0 ? 'pass' : answered.length * 2 >= related.length ? 'partly' : 'fail',
      missing.length === 0 ? `All ${plural(related.length, 'question', 'questions')} we found people asking have a part or a question with a real answer.` : `${answered.length} of ${related.length} questions we found people asking have a part or a question with a real answer. Not yet: ${missing.slice(0, 3).map(quote).join(', ')}${missing.length > 3 ? ' and more' : ''}.`,
      'Answer the missing questions in the questions and answers, or in a part of the article, in a few full sentences each.', 'rewrite');
  } else if (target) {
    add('answers.questions', 'answers', 'The questions people ask are answered', SEO_WEIGHTS.relatedQuestions, 'fail',
      'No questions people ask are on record for this article, so we cannot tell whether it answers them.', 'Plan the article with the questions people ask first.', 'rewrite');
  } else leftOut.push('the questions people ask (none are on record for this article)');
  if (hasPhrase) {
    let early: Match = 'none';
    let seen = 0;
    for (const s of [...blockSentences[0]!.prose, ...blockSentences[0]!.items]) {
      const ws = wordsOf(s);
      if (seen >= OPENING_WORDS) break;
      if (ws.length >= Math.max(REAL_SENTENCE_WORDS, p.s.length + 3)) early = better(early, matchTokens(stems(ws.slice(0, OPENING_WORDS - seen)), p).kind);
      seen += ws.length;
    }
    const anywhere = matchTokens(stems(introWords), p).kind;
    add('answers.opening', 'answers', 'The opening gets straight to the point', SEO_WEIGHTS.openingToThePoint,
      early === 'exact' ? 'pass' : early === 'loose' || anywhere !== 'none' ? 'partly' : 'fail',
      early === 'exact' ? `The phrase comes in a sentence within the first ${OPENING_WORDS} words, so readers see at once that this is what they searched for.` : early === 'loose' ? `The words of the phrase come in the first ${OPENING_WORDS} words, in a different order.` : anywhere !== 'none' ? `The opening comes to the phrase late, or only on its own.` : 'The opening does not mention what was searched for.',
      `Answer the search phrase in the first two sentences, within ${OPENING_WORDS} words.`, 'opening');
  }
  const ctaLabel = cta ? str(cta.label).trim() : '';
  const ctaHttps = Boolean(cta && /^https:\/\//.test(str(cta.url)));
  const ctaLabelOk = words(ctaLabel).length >= 2;
  const ctaOnOwn = own.size === 0 || ctaOwn;
  add('answers.next_step', 'answers', 'A clear next step', SEO_WEIGHTS.nextStep, ctaHttps && ctaLabel ? (ctaLabelOk && ctaOnOwn ? 'pass' : 'partly') : 'fail',
    ctaHttps && ctaLabel ? `The article ends with a next step: ${quote(ctaLabel)}.${!ctaLabelOk ? ' The button label is a single word, which does not say what happens.' : !ctaOnOwn ? ' It goes to another website, not yours.' : ''}` : 'The article does not end with a clear next step for the reader.',
    ctaHttps && ctaLabel ? 'Label the button with what the reader gets, in a few words, and point it at a page on your own site.' : 'Ask for a rewrite that ends with one clear next step, such as booking a call.', 'rewrite');
  if (issues) {
    const unsourced = issues.filter((x) => x.code === 'facts.unsupported_figure' || x.code === 'facts.figure_not_in_source').length;
    add('answers.figures', 'answers', 'Every figure has a source', SEO_WEIGHTS.figureSources, unsourced ? 'fail' : 'pass',
      unsourced ? `${plural(unsourced, 'figure does', 'figures do')} not match a source.` : 'Every figure in the article matches a source.',
      'Fix the figures listed at the top of the page.', 'fix');
  } else if (target) {
    add('answers.figures', 'answers', 'Every figure has a source', SEO_WEIGHTS.figureSources, 'fail', 'The checks have not run on this version yet, so the figures are not confirmed.', 'Run the checks on this version.', 'fix');
  } else leftOut.push('every figure has a source (the checks have not run on this version yet)');

  // ── The whole score, and its caps ──
  const order: Record<SeoCheckResult, number> = { fail: 0, partly: 1, pass: 2 };
  const parts = (['search', 'read', 'answers'] as const).map((part) => {
    const list = checks.filter((c) => c.part === part);
    return { part, label: SEO_PART_LABELS[part], points: list.reduce((s, c) => s + c.points, 0), weight: list.reduce((s, c) => s + c.weight, 0) };
  }).filter((x) => x.weight > 0);
  const earned = checks.reduce((s, c) => s + c.points, 0);
  const available = checks.reduce((s, c) => s + c.weight, 0);
  const uncapped = available ? Math.round((earned * 100) / available) : 0;
  const caps: SeoCap[] = [];
  const mustFix = issues?.filter(isCritical).length ?? 0;
  const things = (k: number) => plural(k, 'thing', 'things');
  if (mustFix) caps.push({ kind: 'must-fix', limit: MUST_FIX_CAP, reason: `The checks found ${things(mustFix)} to fix, so the score stays at ${MUST_FIX_CAP} or below until ${mustFix === 1 ? 'it is' : 'they are'} fixed.` });
  const stale = issues ? 0 : issueList(context.staleCheckIssues)?.filter(isCritical).length ?? 0;
  if (stale) caps.push({ kind: 'stale-checks', limit: MUST_FIX_CAP, reason: `The checks last ran on an earlier version and found ${things(stale)} to fix. They have not run on this version, so the score stays at ${MUST_FIX_CAP} or below until they run again.` });
  else if (target && !issues) caps.push({ kind: 'not-checked', limit: MUST_FIX_CAP, reason: `The checks have not run on this version, so the score stays at ${MUST_FIX_CAP} or below until they run.` });
  if (n && (dupShare > RUNS_CAP || repeatedRuns > RUNS_CAP || vocab < VOCAB_CAP)) caps.push({ kind: 'repetition', limit: REPETITION_CAP, reason: `The wording repeats itself a lot, so the score stays at ${REPETITION_CAP} or below until it reads naturally.` });
  else if (n && (dupShare > RUNS_SOME || repeatedRuns > RUNS_SOME)) caps.push({ kind: 'repetition', limit: SOME_REPETITION_CAP, reason: `Parts of the wording repeat earlier sentences, so the score stays at ${SOME_REPETITION_CAP} or below until each part says something new.` });
  if (wordCount >= 100 && smallWords < SENTENCE_WORDS_CAP) caps.push({ kind: 'not-sentences', limit: REPETITION_CAP, reason: `The text does not read as ordinary sentences: it has very few of the small words (“the”, “of”, “is”, “to”) that join words into sentences. The score stays at ${REPETITION_CAP} or below until it does.` });
  if (stuffedShare) caps.push({ kind: 'stuffing', limit: STUFFING_CAP, reason: `The search phrase comes up far too often, so the score stays at ${STUFFING_CAP} or below until it is used naturally.` });
  const cap = caps.sort((x, y) => x.limit - y.limit)[0] ?? null;
  const score = cap ? Math.min(uncapped, cap.limit) : uncapped;
  return { score, uncapped, cap, vocabulary: Math.round(vocab * 100) / 100, phrase: hasPhrase ? rawPhrase : null, checks: [...checks].sort((x, y) => order[x.result] - order[y.result]), parts, words: wordCount,
    readingEase: ease === null ? null : Math.round(ease), leftOut, earned, available,
    measures: { repeatedSentences: Math.round(dupShare * 10) / 10, repeatedWording: Math.round(repeatedRuns * 10) / 10, joiningWords: Math.round(smallWords * 10) / 10, phraseShare: Math.round(phraseShare * 10) / 10 } };
}

/**
 * The few changes that would raise the score most, with the score they would reach together: points still open on
 * each check, largest first, among checks the owner can act on now (`canFix` says which, for example not the page
 * address once the article is live). The reached score respects any cap and counts a check that comes back once the
 * fix is made (the picture description, once there is a picture) as not yet passing, so it never overstates.
 */
export function seoNextSteps(s: SeoScore, count = 3, canFix: (c: SeoCheck) => boolean = () => true): { from: number; to: number; checks: readonly SeoCheck[] } {
  // A check with more than one thing open is not passed by one change, so its gain is not promised.
  const open = s.checks.filter((c) => c.result !== 'pass' && c.fix !== null && canFix(c))
    .map((c, i) => ({ c, gain: (c.reasons ?? 1) > 1 ? 0 : c.weight - c.points, i }))
    .filter((x) => x.gain > 0)
    .sort((x, y) => y.gain - x.gain || x.i - y.i)
    .slice(0, Math.max(0, count));
  const gained = open.reduce((t, x) => t + x.gain, 0);
  const unlocked = open.reduce((t, x) => t + (x.c.unlocks ?? 0), 0);
  const available = s.available + unlocked;
  const raw = available ? Math.floor(((s.earned + gained) * 100) / available) : 0;
  const to = s.cap ? Math.min(raw, s.cap.limit) : raw;
  return { from: s.score, to: Math.max(s.score, to), checks: open.map((x) => x.c) };
}

/**
 * The gate an automatic step uses: NECESSARY, NOT SUFFICIENT. A pass means only that the article clears the bar on
 * the things words can show (placement, length, structure, repetition, stuffing) with nothing left out and the
 * quality checks run on this version. It does not mean the article is true, useful or says what it should: fluent
 * empty filler can pass. A separate meaning check is required before any automatic rewrite is accepted.
 */
export interface SeoGateResult {
  readonly pass: boolean;
  /** The bar that applied: SEO_GATE_BAR.withPicture, or withoutPicture when the article has no picture. */
  readonly bar: number;
  /** Why it did not pass, in plain words (empty on a pass). */
  readonly reasons: readonly string[];
  /** Always false: passing this gate is never enough on its own. */
  readonly sufficient: false;
}
/** Judge a score (best made in strict `targetMode`) against the recommended bar. See SeoGateResult. */
export function seoGate(s: SeoScore): SeoGateResult {
  const noPicture = s.checks.some((c) => c.id === 'pictures.main' && c.result === 'fail');
  const bar = noPicture ? SEO_GATE_BAR.withoutPicture : SEO_GATE_BAR.withPicture;
  const reasons: string[] = [];
  if (s.score < bar) reasons.push(`The score is ${s.score}, below the bar of ${bar}.`);
  if (s.cap) reasons.push(s.cap.reason);
  // The picture description is not run without a picture; that is not missing information (the lower bar covers it).
  const missing = s.leftOut.filter((x) => !x.startsWith('the picture description'));
  if (missing.length) reasons.push(`Some checks could not run: ${missing.join('; ')}. Score it in target mode.`);
  if (!s.checks.some((c) => c.id === 'answers.figures') || s.cap?.kind === 'not-checked' || s.cap?.kind === 'stale-checks') {
    if (!reasons.some((r) => /checks/.test(r))) reasons.push('The quality checks have not run on this version.');
  }
  return { pass: reasons.length === 0, bar, reasons, sufficient: false };
}
