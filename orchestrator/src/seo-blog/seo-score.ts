/**
 * Our on-page SEO score for one article version: a pure, deterministic function of the brief (its search phrase and
 * related questions), the article body, the site's own web address(es) and the existing quality checks' results.
 * No model calls, no network, no clock.
 *
 * It runs the same KIND of checks the well-known WordPress SEO plugins run (search phrase placement, lengths, links,
 * pictures, readability), plus checks they cannot run because they have no research ("Answers the searcher"). It is
 * OUR score: it is never presented as another product's number, which can differ a little.
 *
 * It is built to be safe as an automatic target (a loop that rewrites until the score rises): every check that a
 * nonsense article could satisfy has a counterweight, so text written to please the score rather than the reader
 * scores low. Each counterweight is named next to its check below.
 *
 * Weights (points out of 100; "partly" earns half the points of the check):
 *
 * | Part                 | Group             | Check                                                   | Points |
 * |----------------------|-------------------|---------------------------------------------------------|--------|
 * | Search               | The search phrase | In the Google title                                     |      5 |
 * | Search               | The search phrase | Near the start of the Google title                      |      1 |
 * | Search               | The search phrase | In the short description in Google                      |      4 |
 * | Search               | The search phrase | In the page address                                     |      3 |
 * | Search               | The search phrase | In the opening paragraph                                |      4 |
 * | Search               | The search phrase | In one or two sub-headings                              |      3 |
 * | Search               | The search phrase | Used a sensible number of times, spread out             |      3 |
 * | Search               | The page          | Google title length (30 to 65 characters)               |      3 |
 * | Search               | The page          | Short description (70 to 160 characters, a sentence)    |      3 |
 * | Search               | The page          | Page address length (up to 60 characters)               |      2 |
 * | Search               | The page          | Article length (best from 1,200 to 2,500 words)         |      4 |
 * | Search               | The page          | Sub-headings                                            |      2 |
 * | Search               | The page          | Questions and answers                                   |      2 |
 * | Search               | Links             | A link to another page on your own site                 |      5 |
 * | Search               | Links             | At least one cited outside source                       |      5 |
 * | Search               | Pictures          | A main picture with a picture description               |      5 |
 * | Search               | Pictures          | The picture description mentions the search phrase      |      2 |
 * | Easy to read         | Easy to read      | Sentence length (not too long, not choppy)              |      5 |
 * | Easy to read         | Easy to read      | Short paragraphs (none over 150 words)                  |      4 |
 * | Easy to read         | Easy to read      | Sub-headings often enough (no stretch over 300 words)   |      4 |
 * | Easy to read         | Easy to read      | Reading ease (Flesch reading ease 60 or more)           |      6 |
 * | Easy to read         | Easy to read      | Varied sentence starts                                  |      2 |
 * | Easy to read         | Easy to read      | Linking words (in about 30% to 60% of sentences)        |      4 |
 * | Easy to read         | Easy to read      | Varied wording (no repeated sentences, a rich vocabulary)|     4 |
 * | Answers the searcher | Answers           | The related questions on record are answered            |      7 |
 * | Answers the searcher | Answers           | The opening gets to the point (phrase in first 60 words)|      2 |
 * | Answers the searcher | Answers           | A clear next step (the button at the end)               |      3 |
 * | Answers the searcher | Answers           | Every figure has a source (from the quality checks)     |      3 |
 * |                      |                   | Total                                                   |    100 |
 *
 * "Near the start of the Google title" and "The opening gets to the point" each repeat part of another check (the
 * title, the opening paragraph), so they carry half their earlier weight: one edit is not paid twice in full.
 * Pictures inside the article are not scored: articles cannot hold them yet, so the check could never pass.
 *
 * Checks that cannot be run are left out and the score is the share of the remaining points, scaled to 100:
 * - no search phrase on record (older articles, or an empty phrase): the nine phrase checks (27 points);
 * - no related questions on record: that check (7 points);
 * - the quality checks have not run for this exact version: the figures check (3 points).
 * As an automatic target (`asTarget`), nothing is left out: no search phrase, or checks that have not run, fail.
 *
 * Caps on the whole score (the lowest applies):
 * - while any must-fix issue from the quality checks is open: at most 59;
 * - when the wording repeats itself heavily (many repeated sentences, or a very small vocabulary): at most 40.
 *
 * Left out on purpose: passive voice (English adjectival participles such as "is based" or "are interested" cannot be
 * told apart from true passives without a grammar parser; a word-list guess would be wrong too often to score), and
 * "covers the brief's key points" (that needs meaning, not word matching, so it cannot be checked deterministically).
 *
 * Phrase matching: case-insensitive; punctuation and hyphens separate words; curly and straight apostrophes are the
 * same; plural and possessive forms count as the phrase ("bridging loans" and "landlord's" match "bridging loan" and
 * "landlord"); whole words only ("let" is not found in "letter"). The phrase counts only inside a real sentence or a
 * heading with other words: the phrase on its own does not count. All its meaningful words close together, in any
 * order, is "partly", so a natural title is not marked down for word order.
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
}

export interface SeoScoreContext {
  /** The site's own addresses (any form: https://www.example.com, example.com/blog). Links to them are internal. */
  readonly siteHosts?: readonly (string | null | undefined)[];
  /** This article's own address, when known; a link to it is not a link to "another page". */
  readonly selfUrl?: string | null;
  /** The existing quality checks' issues for THIS version; null or absent when they have not run for it. */
  readonly checkIssues?: readonly (Pick<CheckIssue, 'code'> & Partial<Pick<CheckIssue, 'severity' | 'message'>>)[] | null;
  /** Scoring for an automatic improve loop: fail closed. A missing phrase or checks that have not run count as fails. */
  readonly asTarget?: boolean;
}

export interface SeoPartTotal { readonly part: SeoPart; readonly label: string; readonly points: number; readonly weight: number }
export interface SeoCap { readonly limit: number; readonly reason: string }

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

/** Below this many words an article is thin; from STRONG_WORDS to LONG_WORDS it is strong; above VERY_LONG_WORDS, too long. */
export const THIN_WORDS = 600;
export const STRONG_WORDS = 1200;
export const LONG_WORDS = 2500;
export const VERY_LONG_WORDS = 5000;
/** The score is held at or below these while the condition lasts. */
export const MUST_FIX_CAP = 59;
export const REPETITION_CAP = 40;
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
/** Phrase uses per 100 words above which it reads as forced, and above which as stuffed. */
const DENSITY_HIGH = 1.5;
const DENSITY_STUFFED = 3;
/** A part (sub-heading and its text) needs at least this many words. */
const PART_MIN_WORDS = 40;
/** At most this many sub-headings per 1,000 words (one every 80 words or so). */
const HEADINGS_PER_1000 = 12;
/** An answer in the questions and answers needs at least this many words. */
const ANSWER_MIN_WORDS = 12;
const MAX_FAQS = 10;
/** One starting word above this share of sentences is repetitive (partly), above START_FAIL it fails. */
const START_SHARE = 15;
const START_FAIL = 25;
/** Window for the vocabulary measure (moving-average share of different words). */
const VOCAB_WINDOW = 50;
/** Vocabulary measure: from VOCAB_PASS the wording is varied; below VOCAB_FAIL it fails; below VOCAB_CAP the score is capped. Ordinary prose measures about 0.75 to 0.85. */
const VOCAB_PASS = 0.65;
const VOCAB_FAIL = 0.55;
const VOCAB_CAP = 0.5;

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

/**
 * A light English stem so plural and possessive forms match: "loans" and "loan", "landlord's" and "landlords" and
 * "landlord", "properties" and "property", "boxes" and "box". Deliberately small: it never joins different words.
 */
export function stem(word: string): string {
  let w = word.replace(/'s$/, '').replace(/'/g, '');
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(?:ss|[xz]|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  return w;
}
const stems = (ws: readonly string[]) => ws.map(stem);

interface Phrase { readonly raw: readonly string[]; readonly s: readonly string[]; readonly need: readonly string[] }
function phraseOf(text: string): Phrase {
  const raw = words(text);
  const kept = raw.filter((w) => !STOP.has(w));
  return { raw, s: stems(raw), need: [...new Set((kept.length ? kept : raw).map(stem))] };
}
const meaningStems = (ws: readonly string[]) => [...new Set(ws.filter((w) => !STOP.has(w)).map(stem))];

/** Every start index of the exact phrase (whole stemmed words, in order), not overlapping. */
function exactAt(tokens: readonly string[], phrase: readonly string[]): number[] {
  const at: number[] = [];
  if (!phrase.length) return at;
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < phrase.length; j++) if (tokens[i + j] !== phrase[j]) { ok = false; break; }
    if (ok) { at.push(i); i += phrase.length - 1; }
  }
  return at;
}

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

type Match = 'exact' | 'loose' | 'none';
/** Match on stemmed tokens. `alone` is true when the text is nothing but the phrase. */
function matchTokens(t: readonly string[], p: Phrase): { kind: Match; at: number; length: number; alone: boolean } {
  const exact = exactAt(t, p.s);
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

/** A sensible English syllable estimate: vowel groups, less a silent final e, plus vowel pairs said apart; at least one. */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  let core = w;
  if (/[^aeiouy]le$/.test(core)) { /* "table": the final -le is its own syllable */ }
  // "makes", "jumped" lose a silent -es / -ed; "boxes", "prices", "mortgages", "wanted" keep it.
  else if (/(?:[^aeiouy]es|[^aeiouytd]ed)$/.test(core) && !/(?:[sxz]|ch|sh|[cg])es$/.test(core)) core = core.slice(0, -2);
  else if (/[^aeiouy]e$/.test(core)) core = core.slice(0, -1); // "make"
  const groups = core.match(/[aeiouy]+/g)?.length ?? 0;
  // Vowel pairs said as two syllables: "media", "valuation", "premium", "period", "area" (not "special", "quality", "nation").
  const apart = core.match(/(?<![cgst])ia|(?<![gq])ua|iu|(?<![cgstx])io|ea$/g)?.length ?? 0;
  return Math.max(1, groups + apart);
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

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
const quote = (s: string) => `“${s.length > 90 ? `${s.slice(0, 87).trimEnd()}...` : s}”`;
const pct = (n: number) => `${Math.round(n)}%`;

// ─── The score ───────────────────────────────────────────────────────────────

export function seoScore(brief: Pick<ArticleBrief, 'targetQuery'> & Partial<Pick<ArticleBrief, 'relatedQuestions'>> | null | undefined, body: ArticleBody, context: SeoScoreContext = {}): SeoScore {
  const rawPhrase = typeof brief?.targetQuery === 'string' ? brief.targetQuery.replace(/\s+/g, ' ').trim() : '';
  const p = phraseOf(rawPhrase);
  const hasPhrase = p.raw.length > 0;
  const target = context.asTarget === true;
  const checks: SeoCheck[] = [];
  const leftOut: string[] = [];
  const add = (id: string, group: SeoCheckGroup, name: string, weight: number, result: SeoCheckResult, found: string, todo: string, fix: SeoFix | null) =>
    checks.push({ id, part: PART_OF[group], group, name, weight, result, found, todo: result === 'pass' ? null : todo, points: result === 'pass' ? weight : result === 'partly' ? weight / 2 : 0, fix: result === 'pass' ? null : fix });

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

  // Sentences, block by block (the opening, each part, each answer, the closing paragraph), so a phrase split across a
  // heading and the text below it, or across two parts, never counts as a use.
  const blockSentences = bodies.map((t) => {
    const prose = paragraphs(readable(t)).flatMap(sentences);
    const items = listItems(readable(t)).flatMap(sentences);
    return { prose, items };
  });
  const proseSentences = blockSentences.flatMap((b) => b.prose);
  const itemSentences = blockSentences.flatMap((b) => b.items);
  const allSentences = [...proseSentences, ...itemSentences];
  const tokens = allSentences.map((x) => words(x));
  const proseTokens = tokens.slice(0, proseSentences.length);
  const n = allSentences.length;
  const np = proseSentences.length;

  // Repetition: sentences of four words or more that repeat an earlier one word for word.
  const seenSentence = new Set<string>();
  let dupSentences = 0, dupWords = 0, longEnough = 0;
  for (const t of proseTokens) {
    if (t.length < FRAGMENT_WORDS) continue;
    longEnough++;
    const key = t.join(' ');
    if (seenSentence.has(key)) { dupSentences++; dupWords += t.length; } else seenSentence.add(key);
  }
  const dupShare = longEnough ? (dupSentences * 100) / longEnough : 0;
  const vocab = vocabulary(allWords);

  // ── Search: the search phrase ──
  if (hasPhrase) {
    const titleTokens = words(seoTitle);
    const t = matchTokens(stems(titleTokens), p);
    const titleMeaning = titleTokens.filter((w) => !STOP.has(w)).map(stem);
    const titleRepeats = titleMeaning.length !== new Set(titleMeaning).size;
    const titleBare = titleTokens.length < p.s.length + 2;
    const titleResult: SeoCheckResult = t.kind === 'exact' && !titleRepeats && !titleBare ? 'pass' : t.kind !== 'none' ? 'partly' : 'fail';
    add('phrase.title', 'phrase', 'The search phrase is in the Google title', SEO_WEIGHTS.phraseTitle, titleResult,
      t.kind === 'exact' ? (titleRepeats ? `The Google title uses ${quote(P)}, but it repeats words.` : titleBare ? `The Google title is little more than ${quote(P)}.` : `The Google title uses ${quote(P)}.`)
        : t.kind === 'loose' ? `The Google title has the words of ${quote(P)}, in a different order.` : seoTitle.trim() ? `The Google title does not use ${quote(P)}.` : 'The Google title is empty.',
      t.kind === 'exact' ? `Write the Google title as a short, natural line that uses ${quote(P)} once and says what the reader gets.` : t.kind === 'loose' ? `If it still reads naturally, use the phrase ${quote(P)} as it is.` : `Put ${quote(P)} in the Google title, as naturally as you can.`, 'google-title');
    const firstHalf = t.at >= 0 && t.at <= Math.floor(t.length / 2);
    add('phrase.title_start', 'phrase', 'The search phrase is near the start of the Google title', SEO_WEIGHTS.phraseTitleStart,
      titleResult === 'pass' && firstHalf ? 'pass' : t.kind !== 'none' ? 'partly' : 'fail',
      t.kind === 'none' ? 'The phrase is not in the Google title yet.' : firstHalf ? (t.kind === 'exact' ? 'The phrase comes early in the Google title.' : 'Its words come early in the Google title, in a different order.') : 'The phrase comes late in the Google title.',
      'Move the search phrase towards the start of the Google title. People and Google read the first words most.', 'google-title');
    const d = match(description, p);
    const descSentence = sentences(description).some((x) => words(x).length >= REAL_SENTENCE_WORDS) && words(description).length >= 8;
    add('phrase.description', 'phrase', 'The search phrase is in the short description in Google', SEO_WEIGHTS.phraseDescription,
      d.kind === 'exact' && descSentence ? 'pass' : d.kind !== 'none' ? 'partly' : 'fail',
      d.kind === 'exact' ? (descSentence ? `The short description uses ${quote(P)}.` : 'The short description uses the phrase, but it is not a sentence.') : d.kind === 'loose' ? 'The short description has the words of the phrase, in a different order.' : description.trim() ? 'The short description does not use the phrase.' : 'The short description is empty.',
      `Use ${quote(P)} once in a short description written as a sentence. Google often shows those words in bold.`, 'description');
    // The address is compared without apostrophes, with plural and possessive forms accepted.
    const slugWords = stems(slug.toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean));
    const pFlat: Phrase = { raw: p.raw, s: p.raw.map((w) => stem(w.replace(/'/g, ''))), need: p.need.map((w) => stem(w.replace(/'/g, ''))) };
    const slugExact = exactAt(slugWords, pFlat.s).length > 0;
    const slugLoose = !slugExact && pFlat.need.every((w) => slugWords.includes(w));
    add('phrase.address', 'phrase', 'The search phrase is in the page address', SEO_WEIGHTS.phraseAddress,
      slugExact ? 'pass' : slugLoose ? 'partly' : 'fail',
      slugExact ? 'The page address uses the phrase.' : slugLoose ? 'The page address has the main words of the phrase, in a different order.' : 'The page address does not use the phrase.',
      'Use the main words of the phrase in the page address, joined by hyphens. Only change it before the article is live.', 'address');
    // The opening: the phrase must sit inside a real sentence, not stand alone.
    const introBlock = blockSentences[0]!;
    let openReal: Match = 'none', openAny: Match = 'none';
    for (const s of [...introBlock.prose, ...introBlock.items]) {
      const ws = words(s);
      const m = matchTokens(stems(ws), p).kind;
      openAny = better(openAny, m);
      if (ws.length >= Math.max(REAL_SENTENCE_WORDS, p.s.length + 3)) openReal = better(openReal, m);
    }
    const openResult: SeoCheckResult = openReal === 'exact' ? 'pass' : openReal === 'loose' || openAny !== 'none' ? 'partly' : 'fail';
    add('phrase.opening', 'phrase', 'The search phrase is in the opening paragraph', SEO_WEIGHTS.phraseOpening, openResult,
      openReal === 'exact' ? 'The opening paragraph uses the phrase in a sentence.' : openReal === 'loose' ? 'The opening paragraph has the words of the phrase, in a different order.' : openAny !== 'none' ? 'The opening paragraph has the phrase only on its own, not inside a sentence.' : 'The opening paragraph does not use the phrase.',
      'Use the phrase inside one of the first two or three sentences, so readers and Google know at once what the article answers.', 'opening');
    // Sub-headings: one or two, each with more than the phrase alone.
    const h = headings.map((x) => match(x, p));
    const hReal = h.filter((m) => m.kind === 'exact' && !m.alone).length;
    const hAlone = h.filter((m) => m.alone).length;
    const hResult: SeoCheckResult = hReal >= 1 && hReal + hAlone <= 2 ? 'pass' : hReal + hAlone > 0 || h.some((m) => m.kind === 'loose') ? 'partly' : 'fail';
    add('phrase.heading', 'phrase', 'The search phrase is in one or two sub-headings', SEO_WEIGHTS.phraseHeading, hResult,
      hReal + hAlone > 2 ? `${plural(hReal + hAlone, 'sub-heading uses', 'sub-headings use')} the phrase. More than two reads as forced.`
        : hReal ? `${plural(hReal, 'sub-heading uses', 'sub-headings use')} the phrase.` : hAlone ? 'A sub-heading is the phrase on its own, with nothing else.' : h.some((m) => m.kind === 'loose') ? 'A sub-heading has the words of the phrase, in a different order.' : headings.length ? 'No sub-heading uses the phrase.' : 'The article has no sub-headings.',
      hReal + hAlone > 2 ? 'Keep the phrase in one or two sub-headings and word the others in your own way.' : 'Use the phrase, or something very close to it, in one sub-heading that says what the part covers.', 'headings');
    // Use: only inside real sentences, spread over at least two places, and not too often.
    let uses = 0, fragmentUses = 0, loose = 0;
    const usedIn = new Set<number>();
    blockSentences.forEach((b, i) => {
      for (const s of [...b.prose, ...b.items]) {
        const ws = stems(words(s));
        const at = exactAt(ws, p.s).length;
        if (!at) { if (looseAt(ws, p).length) loose++; continue; }
        if (ws.length >= Math.max(REAL_SENTENCE_WORDS, p.s.length + 3)) { uses += at; usedIn.add(i); } else fragmentUses += at;
      }
    });
    const density = wordCount ? (uses * 100) / wordCount : 0;
    const dens = `${(Math.round(density * 10) / 10).toLocaleString('en-GB')}%`;
    const spread = usedIn.size >= 2;
    const useResult: SeoCheckResult = uses >= 2 && density <= DENSITY_HIGH && spread ? 'pass' : density > DENSITY_STUFFED ? 'fail' : uses === 0 && loose === 0 ? 'fail' : 'partly';
    add('phrase.use', 'phrase', 'The search phrase is used a sensible number of times', SEO_WEIGHTS.phraseUse, useResult,
      uses === 0 ? (fragmentUses ? 'The phrase only appears on its own, never inside a sentence.' : loose ? `The exact phrase is not used. Its words appear close together ${plural(loose, 'time', 'times')}.` : 'The article does not use the phrase at all.')
        : `The phrase is used ${plural(uses, 'time', 'times')} in ${plural(wordCount, 'word', 'words')} (${dens}).${density > DENSITY_STUFFED ? ' That is too many: it reads as stuffed.' : density > DENSITY_HIGH ? ' That is a little high.' : uses >= 2 && !spread ? ' All the uses are in one part.' : ''}`,
      uses <= 1 ? 'Use the exact phrase two or three times, inside sentences, in different parts of the article.' : density > DENSITY_HIGH ? 'Use the phrase a little less. Say it naturally, and use other words for the same idea.' : 'Spread the phrase out: use it in another part of the article too.', 'text');
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
    'Aim for 70 to 160 characters: one or two sentences that make people want to click.', 'description');
  const sl = slug.length;
  add('page.address_length', 'page', 'Page address length', SEO_WEIGHTS.addressLength, sl > 0 && sl <= 60 ? 'pass' : sl > 0 && sl <= 80 ? 'partly' : 'fail',
    sl === 0 ? 'The page address ending is empty.' : `The page address ending is ${plural(sl, 'character', 'characters')}.`,
    sl === 0 ? 'Give the article a page address ending of a few words joined by hyphens.' : 'Keep the page address ending short: a few key words joined by hyphens. Only change it before the article is live.', 'address');
  // Length counts each sentence once: repeating text does not make an article longer.
  const effective = Math.max(0, wordCount - dupWords);
  const grade = effective > VERY_LONG_WORDS ? 'too long' : effective > LONG_WORDS ? 'long' : effective >= STRONG_WORDS ? 'strong' : effective >= THIN_WORDS ? 'fine' : 'thin';
  add('page.length', 'page', 'Article length', SEO_WEIGHTS.articleLength, grade === 'strong' ? 'pass' : grade === 'fine' || grade === 'long' ? 'partly' : 'fail',
    `${plural(wordCount, 'word', 'words')}: ${grade}.${dupWords ? ` ${plural(dupWords, 'word is', 'words are')} in repeated sentences and not counted.` : ''}`,
    grade === 'thin' ? `Under ${THIN_WORDS.toLocaleString('en-GB')} words is thin for Google. Ask for a rewrite with more detail and examples.`
      : grade === 'fine' ? `Articles of ${STRONG_WORDS.toLocaleString('en-GB')} words or more that stay useful tend to do better. Add an example or a worked case if it helps the reader.`
        : `Over ${LONG_WORDS.toLocaleString('en-GB')} words, readers tend to stop. Cut what does not help the reader, or split it into two articles.`, 'rewrite');
  const named = sections.filter((s) => str(s.heading).trim());
  const distinctHeadings = new Set(named.map((s) => stems(words(str(s.heading))).join(' '))).size;
  const thinParts = named.filter((s) => words(readable(str(s.body))).length < PART_MIN_WORDS).length;
  const perThousand = effective ? (named.length * 1000) / effective : named.length ? Infinity : 0;
  const subResult: SeoCheckResult = named.length === 0 ? 'fail'
    : thinParts * 2 > named.length || perThousand > HEADINGS_PER_1000 * 2 ? 'fail'
      : named.length >= 3 && thinParts === 0 && distinctHeadings === named.length && perThousand <= HEADINGS_PER_1000 ? 'pass' : 'partly';
  add('page.subheadings', 'page', 'Sub-headings', SEO_WEIGHTS.subHeadings, subResult,
    named.length === 0 ? 'The article has no sub-headings.'
      : `The article has ${plural(named.length, 'sub-heading', 'sub-headings')}.${thinParts ? ` ${plural(thinParts, 'part has', 'parts have')} fewer than ${PART_MIN_WORDS} words under ${thinParts === 1 ? 'its' : 'their'} sub-heading.` : ''}${distinctHeadings < named.length ? ' Some sub-headings are the same.' : ''}${perThousand > HEADINGS_PER_1000 && !thinParts ? ' That is a lot for the length of the article.' : ''}`,
    named.length >= 3 ? 'Give each part a different sub-heading and enough text to be worth its own heading. Join very short parts together.' : 'Break the article into at least three parts, each with a clear sub-heading and a few paragraphs.', named.length ? 'headings' : 'rewrite');
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
  const issues = Array.isArray(context.checkIssues) ? context.checkIssues.filter((x): x is NonNullable<typeof x> => Boolean(x && typeof x === 'object')) : null;
  const flagged = (code: string, url: string) => Boolean(issues?.some((x) => x.code === code && typeof x.message === 'string' && x.message.includes(url)));
  const selfPath = context.selfUrl ? pathOf(context.selfUrl) : '';
  const textLinks = bodies.flatMap(links);
  const ownLinks = textLinks.filter((l) => isOwn(hostOf(l.url)));
  const weak = (l: Link): string | null => {
    const path = pathOf(l.url);
    if (!path) return 'the home page';
    if ((selfPath && path === selfPath) || (slug && path.endsWith(`/${slug.toLowerCase()}`))) return 'this article itself';
    if (flagged('links.broken_internal', l.url)) return 'a page that is not live';
    if (words(l.label).length < 2) return 'a one-word link';
    return null;
  };
  const goodOwn = ownLinks.filter((l) => !weak(l)).length;
  const weakReasons = [...new Set(ownLinks.map(weak).filter((x): x is string => Boolean(x)))];
  const external = textLinks.filter((l) => !isOwn(hostOf(l.url)));
  const cta = body?.cta && typeof body.cta === 'object' ? body.cta : null;
  const ctaOwn = Boolean(cta && isOwn(hostOf(str(cta.url))));
  add('links.internal', 'links', 'A link to another page on your own site', SEO_WEIGHTS.internalLink, goodOwn ? 'pass' : ownLinks.length || ctaOwn ? 'partly' : 'fail',
    goodOwn ? `The text links to your own site ${plural(goodOwn, 'time', 'times')}.` : ownLinks.length ? `The text links to your own site, but only to ${weakReasons.join(' or ')}.` : ctaOwn ? 'Only the button at the end links to your site.' : own.size ? 'The text does not link to any other page on your site.' : 'We do not know your website address yet, so we cannot tell which links are yours.',
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
  const image = body?.image && typeof body.image === 'object' ? body.image : { url: null, alt: '' };
  const alt = str(image.alt).trim();
  const altWords = words(alt);
  const altOnlyPhrase = hasPhrase && altWords.length > 0 && stems(altWords).join(' ') === p.s.join(' ');
  const altOk = altWords.length >= 4 && !altOnlyPhrase;
  add('pictures.main', 'pictures', 'A main picture with a picture description', SEO_WEIGHTS.mainPicture, image.url ? (altOk ? 'pass' : 'partly') : 'fail',
    image.url ? (altOk ? 'The article has a main picture with a description.' : altOnlyPhrase ? 'The picture description is only the search phrase, not a description of the picture.' : alt ? 'The article has a main picture, but its description is too short.' : 'The article has a main picture, but no description of it.') : 'The article has no main picture yet.',
    image.url ? 'Describe what the picture shows in a few words, for people who cannot see it.' : 'Add a picture: upload a photo, use one from your website or ask us to make one.', image.url ? 'picture-description' : 'picture');
  if (hasPhrase) {
    const a = image.url ? match(alt, p).kind : 'none';
    const aResult: SeoCheckResult = altOnlyPhrase ? 'fail' : a === 'exact' && altOk ? 'pass' : a !== 'none' ? 'partly' : 'fail';
    add('pictures.phrase', 'pictures', 'The picture description mentions the search phrase', SEO_WEIGHTS.pictureDescriptionPhrase, aResult,
      !image.url ? 'There is no picture yet, so there is no description.' : altOnlyPhrase ? 'The picture description is the phrase on its own.' : a === 'exact' ? (altOk ? 'The picture description uses the phrase.' : 'The picture description uses the phrase, but is too short to describe the picture.') : a === 'loose' ? 'The picture description has the words of the phrase, in a different order.' : 'The picture description does not use the phrase.',
      image.url ? 'If it is true to the picture, use the phrase in a description of what the picture shows.' : 'Add a picture first, then describe it using the phrase if it fits.', image.url ? 'picture-description' : 'picture');
  }

  // ── Easy to read ──
  const proseWordsN = proseTokens.reduce((s, t) => s + t.length, 0);
  const avgLen = np ? proseWordsN / np : 0;
  const fragments = proseTokens.filter((t) => t.length < FRAGMENT_WORDS).length;
  const fragShare = np ? (fragments * 100) / np : 0;
  const longS = tokens.filter((t) => t.length > LONG_SENTENCE_WORDS).length;
  const longShare = n ? (longS * 100) / n : 0;
  const choppy = avgLen < SENTENCE_FLOOR || fragShare > 15;
  const sentResult: SeoCheckResult = !n ? 'fail'
    : longShare > 35 || avgLen < CHOPPY_FAIL || fragShare > 35 ? 'fail'
      : longShare <= 25 && !choppy ? 'pass' : 'partly';
  add('read.sentences', 'read', 'Sentence length', SEO_WEIGHTS.sentenceLength, sentResult,
    !n ? 'The article has no sentences yet.' : `${pct(longShare)} of sentences are longer than ${LONG_SENTENCE_WORDS} words (${longS} of ${n}). Sentences average ${plural(Math.round(avgLen), 'word', 'words')}.${choppy ? ' Many are very short, which reads as choppy.' : ''}`,
    choppy && longShare <= 25 ? `Join very short sentences into full ones. Aim for about ${SENTENCE_FLOOR} to 20 words in most sentences.` : 'Split the longest sentences in two. Aim for no more than one sentence in four over 20 words.', 'text');
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
  const ease = readingEase(tokens);
  const easeResult: SeoCheckResult = ease === null ? 'fail' : ease >= 60 ? (avgLen >= SENTENCE_FLOOR - 2 ? 'pass' : avgLen >= CHOPPY_FAIL ? 'partly' : 'fail') : ease >= 50 ? 'partly' : 'fail';
  add('read.ease', 'read', 'Reading ease', SEO_WEIGHTS.readingEase, easeResult,
    ease === null ? 'There is too little text to judge how easy it is to read.' : `Reading ease ${Math.round(ease)} out of 100: ${easeWords(ease)}.${ease >= 60 && easeResult !== 'pass' ? ' It only looks easy because the sentences are fragments.' : ' Most readers find 60 or more comfortable.'}`,
    ease !== null && ease >= 60 ? 'Write in full sentences with everyday words. Very short fragments are not easier to follow.' : 'Use shorter sentences and everyday words. Swap long words for short ones where you can.', 'text');
  // Varied starts: no three in a row the same, and no one word starting more than about 15% of sentences.
  let runs = 0;
  const firsts = proseTokens.map((t) => t[0] ?? '');
  for (let i = 2; i < firsts.length; i++) {
    const w = firsts[i]!;
    if (w && w === firsts[i - 1] && w === firsts[i - 2] && (i < 3 || firsts[i - 3] !== w)) runs++;
  }
  const startCounts = new Map<string, number>();
  for (const w of firsts) if (w) startCounts.set(w, (startCounts.get(w) ?? 0) + 1);
  const [topStart, topCount] = [...startCounts.entries()].sort((x, y) => y[1] - x[1])[0] ?? ['', 0];
  const topShare = np >= 10 ? (topCount * 100) / np : 0;
  const startResult: SeoCheckResult = !np ? 'fail' : runs >= 2 || topShare > START_FAIL ? 'fail' : runs === 1 || topShare > START_SHARE ? 'partly' : 'pass';
  add('read.starts', 'read', 'Varied sentence starts', SEO_WEIGHTS.sentenceStarts, startResult,
    !np ? 'The article has no sentences yet.' : runs ? `${plural(runs, 'place has', 'places have')} three or more sentences in a row starting with the same word.` : topShare > START_SHARE ? `${pct(topShare)} of sentences start with ${quote(topStart)}.` : 'Sentences start in varied ways.',
    runs ? 'Start one of those sentences differently.' : 'Start more sentences in other ways, so the text does not sound repetitive.', 'text');
  // Linking words: a pass band, with variety, and not just bolted to the start of every sentence.
  const linkInfo = tokens.map(linkingIn);
  const linked = linkInfo.filter((x) => x.used.length > 0).length;
  const initialLinked = linkInfo.slice(0, np).filter((x) => x.initial).length;
  const kinds = new Set(linkInfo.flatMap((x) => x.used)).size;
  const linkShare = n ? (linked * 100) / n : 0;
  const initialShare = np ? (initialLinked * 100) / np : 0;
  const enoughKinds = kinds >= Math.min(3, linked);
  const linkResult: SeoCheckResult = !n ? 'fail'
    : linkShare < 20 || linkShare > 80 || initialShare > 60 ? 'fail'
      : linkShare >= 30 && linkShare <= 60 && initialShare <= 35 && enoughKinds ? 'pass' : 'partly';
  add('read.linking', 'read', 'Linking words', SEO_WEIGHTS.linkingWords, linkResult,
    n ? `${pct(linkShare)} of sentences use a linking word such as “because”, “so” or “for example”.${initialShare > 35 ? ` ${pct(initialShare)} of sentences start with one.` : ''}${!enoughKinds ? ' The same few are used again and again.' : ''}` : 'The article has no sentences yet.',
    linkShare > 60 || initialShare > 35 ? 'Use fewer linking words, and put them inside sentences rather than at the start of each one.' : 'Join ideas with words like “because”, “so”, “however” and “for example”. Aim for about one sentence in three.', 'text');
  const varietyResult: SeoCheckResult = !n ? 'fail' : dupShare > 15 || vocab < VOCAB_FAIL ? 'fail' : dupShare <= 3 && vocab >= VOCAB_PASS ? 'pass' : 'partly';
  add('read.variety', 'read', 'Varied wording', SEO_WEIGHTS.variety, varietyResult,
    !n ? 'The article has no text yet.' : dupSentences ? `${plural(dupSentences, 'sentence repeats', 'sentences repeat')} an earlier one word for word.${vocab < VOCAB_PASS ? ' The same few words come up again and again.' : ''}` : vocab < VOCAB_PASS ? 'The same few words come up again and again.' : 'No sentence is repeated, and the wording is varied.',
    'Remove repeated sentences and say things in your own words. Readers and Google both notice repetition.', 'text');

  // ── Answers the searcher ──
  const related = (Array.isArray(brief?.relatedQuestions) ? brief!.relatedQuestions! : []).filter((q) => typeof q === 'string' && meaningStems(words(q)).length > 0);
  if (related.length) {
    // A question is answered by a sub-heading (or a question in the questions and answers) that shares most of its
    // meaning words, with a real answer under it that covers the rest; or by an answer that opens with all of them.
    const places = [...sections.map((s) => ({ h: str(s.heading), a: str(s.body) })), ...faqs.map((f) => ({ h: str(f.q), a: str(f.a) }))].map((x) => {
      const aw = words(readable(x.a));
      return { head: new Set(stems(words(x.h))), lead: new Set(stems(aw.slice(0, 200))), open: new Set(stems(aw.slice(0, 60))), size: aw.length };
    });
    const answered = related.filter((q) => {
      const need = meaningStems(words(q));
      return places.some((pl) => {
        // A real answer: long enough, and it uses at least one of the question's own meaning words.
        if (pl.size < ANSWER_MIN_WORDS || !need.some((w) => pl.lead.has(w))) return false;
        const inHead = need.filter((w) => pl.head.has(w)).length;
        const covered = need.filter((w) => pl.head.has(w) || pl.lead.has(w)).length;
        if (inHead * 2 >= need.length && covered * 4 >= need.length * 3 && covered >= Math.min(need.length, 2)) return true;
        return need.length >= 2 && need.every((w) => pl.open.has(w));
      });
    });
    const missing = related.filter((q) => !answered.includes(q));
    add('answers.questions', 'answers', 'The questions people ask are answered', SEO_WEIGHTS.relatedQuestions,
      missing.length === 0 ? 'pass' : answered.length * 2 >= related.length ? 'partly' : 'fail',
      missing.length === 0 ? `All ${plural(related.length, 'question', 'questions')} we found people asking have a sub-heading or a question with a real answer.` : `${answered.length} of ${related.length} questions we found people asking have a sub-heading or a question with a real answer. Not yet: ${missing.slice(0, 3).map(quote).join(', ')}${missing.length > 3 ? ' and more' : ''}.`,
      'Add the missing questions to the questions and answers, or give them a sub-heading, and answer each one properly.', 'rewrite');
  } else leftOut.push('the questions people ask (none are on record for this article)');
  if (hasPhrase) {
    let early: Match = 'none';
    let seen = 0;
    for (const s of [...blockSentences[0]!.prose, ...blockSentences[0]!.items]) {
      const ws = words(s);
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
      'Fix the figures listed at the top of the page before it goes out.', 'fix');
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
  const mustFix = issues?.filter((x) => x.severity === 'critical').length ?? 0;
  if (mustFix) caps.push({ limit: MUST_FIX_CAP, reason: `${plural(mustFix, 'thing needs', 'things need')} fixing before it goes out, so the score stays at ${MUST_FIX_CAP} or below until ${mustFix === 1 ? 'it is' : 'they are'} fixed.` });
  if (n && (dupShare > 25 || vocab < VOCAB_CAP)) caps.push({ limit: REPETITION_CAP, reason: `The wording repeats itself a lot, so the score stays at ${REPETITION_CAP} or below until it reads naturally.` });
  const cap = caps.sort((x, y) => x.limit - y.limit)[0] ?? null;
  const score = cap ? Math.min(uncapped, cap.limit) : uncapped;
  return { score, uncapped, cap, vocabulary: Math.round(vocab * 100) / 100, phrase: hasPhrase ? rawPhrase : null, checks: [...checks].sort((x, y) => order[x.result] - order[y.result]), parts, words: wordCount,
    readingEase: ease === null ? null : Math.round(ease), leftOut, earned, available };
}

/**
 * The few changes that would raise the score most, with the score they would reach together: points still open on
 * each check, largest first, among checks the owner can act on. The reached score respects any cap, so it is never
 * higher than the page could really show.
 */
export function seoNextSteps(s: SeoScore, count = 3): { from: number; to: number; checks: readonly SeoCheck[] } {
  const open = s.checks.filter((c) => c.result !== 'pass' && c.fix !== null)
    .map((c, i) => ({ c, gain: c.weight - c.points, i }))
    .sort((x, y) => y.gain - x.gain || x.i - y.i)
    .slice(0, Math.max(0, count));
  const gained = open.reduce((t, x) => t + x.gain, 0);
  const raw = s.available ? Math.round(((s.earned + gained) * 100) / s.available) : 0;
  const to = s.cap ? Math.min(raw, s.cap.limit) : raw;
  return { from: s.score, to: Math.max(s.score, to), checks: open.map((x) => x.c) };
}
