/**
 * Our on-page SEO score for one article version: a pure, deterministic function of the brief (its search phrase and
 * related questions), the article body, the site's own web address(es) and the existing quality checks' results.
 * No model calls, no network, no clock.
 *
 * It runs the same KIND of checks the well-known WordPress SEO plugins run (search phrase placement, lengths, links,
 * pictures, readability), plus checks they cannot run because they have no research ("Answers the searcher"). It is
 * OUR score: it is never presented as another product's number, which can differ a little.
 *
 * Weights (points out of 100; "partly" earns half the points of the check):
 *
 * | Part                 | Group             | Check                                                   | Points |
 * |----------------------|-------------------|---------------------------------------------------------|--------|
 * | Search               | The search phrase | In the Google title                                     |      5 |
 * | Search               | The search phrase | Near the start of the Google title                      |      2 |
 * | Search               | The search phrase | In the short description in Google                      |      4 |
 * | Search               | The search phrase | In the page address                                     |      3 |
 * | Search               | The search phrase | In the opening paragraph                                |      4 |
 * | Search               | The search phrase | In at least one sub-heading                             |      3 |
 * | Search               | The search phrase | Used a sensible number of times                         |      3 |
 * | Search               | The page          | Google title length (30 to 65 characters)               |      3 |
 * | Search               | The page          | Short description length (70 to 160 characters)         |      3 |
 * | Search               | The page          | Page address length (up to 60 characters)               |      2 |
 * | Search               | The page          | Article length (thin / fine / strong)                   |      4 |
 * | Search               | The page          | Sub-headings                                            |      2 |
 * | Search               | The page          | Questions and answers                                   |      2 |
 * | Search               | Links             | A link to another page on your own site                 |      5 |
 * | Search               | Links             | At least one cited outside source                       |      5 |
 * | Search               | Pictures          | A main picture with a picture description               |      5 |
 * | Search               | Pictures          | The picture description mentions the search phrase      |      2 |
 * | Search               | Pictures          | At least one picture inside the article                 |      3 |
 * | Easy to read         | Easy to read      | Short sentences (at most 25% over 20 words)             |      5 |
 * | Easy to read         | Easy to read      | Short paragraphs (none over 150 words)                  |      4 |
 * | Easy to read         | Easy to read      | Sub-headings often enough (no stretch over 300 words)   |      4 |
 * | Easy to read         | Easy to read      | Reading ease (Flesch reading ease 60 or more)           |      6 |
 * | Easy to read         | Easy to read      | Varied sentence starts (no 3 in a row the same)         |      2 |
 * | Easy to read         | Easy to read      | Linking words (in at least 30% of sentences)            |      4 |
 * | Answers the searcher | Answers           | The related questions on record are answered            |      5 |
 * | Answers the searcher | Answers           | The opening gets to the point (phrase in first 60 words)|      4 |
 * | Answers the searcher | Answers           | A clear next step (the button at the end)               |      3 |
 * | Answers the searcher | Answers           | Every figure has a source (from the quality checks)     |      3 |
 * |                      |                   | Total                                                   |    100 |
 *
 * Checks that cannot be run are left out and the score is the share of the remaining points, scaled to 100:
 * - no search phrase on record (older articles, or an empty phrase): the nine phrase checks (30 points);
 * - no related questions on record: that check (5 points);
 * - the quality checks have not run for this exact version: the figures check (3 points).
 *
 * Left out on purpose: passive voice (English adjectival participles such as "is based" or "are interested" cannot be
 * told apart from true passives without a grammar parser; a word-list guess would be wrong too often to score), and
 * "covers the brief's key points" (that needs meaning, not word matching, so it cannot be checked deterministically).
 *
 * Phrase matching: case-insensitive; punctuation and hyphens separate words; curly and straight apostrophes are the
 * same and stay part of the word ("landlord's" is not "landlords"); whole words only ("let" is not found in "letter");
 * no stemming ("deal" is not "deals"). The exact phrase passes. All its meaningful words close together, in any order,
 * is "partly", so a natural title is not marked down for word order.
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
  /** The existing quality checks' issues for THIS version; null or absent when they have not run for it. */
  readonly checkIssues?: readonly Pick<CheckIssue, 'code'>[] | null;
}

export interface SeoPartTotal { readonly part: SeoPart; readonly label: string; readonly points: number; readonly weight: number }

export interface SeoScore {
  /** 0 to 100, a whole number. */
  readonly score: number;
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
}

export const SEO_WEIGHTS = {
  phraseTitle: 5, phraseTitleStart: 2, phraseDescription: 4, phraseAddress: 3, phraseOpening: 4, phraseHeading: 3, phraseUse: 3,
  titleLength: 3, descriptionLength: 3, addressLength: 2, articleLength: 4, subHeadings: 2, questions: 2,
  internalLink: 5, outsideSource: 5,
  mainPicture: 5, pictureDescriptionPhrase: 2, inlinePicture: 3,
  sentenceLength: 5, paragraphLength: 4, headingSpacing: 4, readingEase: 6, sentenceStarts: 2, linkingWords: 4,
  relatedQuestions: 5, openingToThePoint: 4, nextStep: 3, figureSources: 3,
} as const;

export const SEO_PART_LABELS: Record<SeoPart, string> = { search: 'Search', read: 'Easy to read', answers: 'Answers the searcher' };
export const SEO_GROUP_LABELS: Record<SeoCheckGroup, string> = { phrase: 'The search phrase', page: 'The page', links: 'Links', pictures: 'Pictures', read: 'Easy to read', answers: 'Answers the searcher' };
const PART_OF: Record<SeoCheckGroup, SeoPart> = { phrase: 'search', page: 'search', links: 'search', pictures: 'search', read: 'read', answers: 'answers' };

/** Below this many words an article is thin; from STRONG_WORDS it is strong; in between, fine. */
export const THIN_WORDS = 600;
export const STRONG_WORDS = 1200;
const LONG_PARAGRAPH_WORDS = 150;
const LONG_SENTENCE_WORDS = 20;
const HEADING_SPACING_WORDS = 300;
const OPENING_WORDS = 60;

// ─── Words ───────────────────────────────────────────────────────────────────

/** Words that carry no meaning on their own; ignored when looking for the phrase's words close together. */
const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'as', 'is', 'are', 'be', 'it', 'its', 'your', 'you', 'my', 'our', 'we', 'i',
  'how', 'what', 'why', 'when', 'where', 'which', 'who', 'do', 'does', 'can', 'should', 'vs', 'versus', 'into', 'about', 'this', 'that', 'much', 'many', 'me', 'if', 'there', 'their', 'they', 'need', 'get']);

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

function meaningful(phrase: readonly string[]): string[] {
  const kept = [...new Set(phrase.filter((w) => !STOP.has(w)))];
  return kept.length ? kept : [...new Set(phrase)];
}

/** Every start index of the exact phrase (whole words, in order), not overlapping. */
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
function looseAt(tokens: readonly string[], phrase: readonly string[]): number[] {
  const need = meaningful(phrase);
  if (!need.length) return [];
  const size = phrase.length + 5;
  const wanted = new Set(need);
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
function matchTokens(t: readonly string[], phrase: readonly string[]): { kind: Match; at: number; length: number } {
  const exact = exactAt(t, phrase);
  if (exact.length) return { kind: 'exact', at: exact[0]!, length: t.length };
  const loose = looseAt(t, phrase);
  if (loose.length) return { kind: 'loose', at: loose[0]!, length: t.length };
  return { kind: 'none', at: -1, length: t.length };
}
const match = (text: string, phrase: readonly string[]) => matchTokens(words(text), phrase);

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

const ABBREVIATIONS = /\b(?:e\.g|i\.e|etc|mr|mrs|ms|dr|st|vs|approx|no|inc|ltd|co)\.$/i;
/** Sentences of a paragraph: split after . ! ? (and runs of them) followed by a space, except after common abbreviations. */
export function sentences(paragraph: string): string[] {
  const out: string[] = [];
  let start = 0;
  const text = paragraph.replace(/\s+/g, ' ').trim();
  for (const m of text.matchAll(/[.!?]+["”’)\]]*(?=\s|$)/g)) {
    const end = m.index! + m[0].length;
    const piece = text.slice(start, end).trim();
    if (ABBREVIATIONS.test(text.slice(start, m.index! + 1))) continue;
    if (piece) out.push(piece);
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out.filter((s) => /[\p{L}\p{N}]/u.test(s));
}

/** A sensible English syllable estimate: vowel groups, less a silent final e, at least one. */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  let core = w;
  if (/[^aeiouy]le$/.test(core)) { /* "table": the final -le is its own syllable */ }
  else if (/(?:[^aeiouy]es|[^aeiouytd]ed)$/.test(core) && !/(?:[sxz]|ch|sh|ce|ge)es$/.test(core)) core = core.slice(0, -2); // "makes", "jumped"
  else if (/[^aeiouy]e$/.test(core)) core = core.slice(0, -1); // "make"
  const groups = core.match(/[aeiouy]+/g)?.length ?? 0;
  return Math.max(1, groups);
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
function hasLinkingWord(ws: readonly string[]): boolean {
  if (ws.some((w) => LINKING_SINGLE.has(w))) return true;
  return LINKING_PHRASES.some((p) => exactAt(ws, p).length > 0);
}

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = String(value).trim();
  if (!v) return null;
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`).hostname.toLowerCase().replace(/^www\./, '') || null; } catch { return null; }
}

function links(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]\n]{1,200}\]\((https:\/\/[^\s)]{1,500})\)/g)].map((m) => m[1]!);
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
const quote = (s: string) => `“${s.length > 90 ? `${s.slice(0, 87).trimEnd()}...` : s}”`;
const pct = (n: number) => `${Math.round(n)}%`;

// ─── The score ───────────────────────────────────────────────────────────────

export function seoScore(brief: Pick<ArticleBrief, 'targetQuery'> & Partial<Pick<ArticleBrief, 'relatedQuestions'>> | null | undefined, body: ArticleBody, context: SeoScoreContext = {}): SeoScore {
  const rawPhrase = typeof brief?.targetQuery === 'string' ? brief.targetQuery.replace(/\s+/g, ' ').trim() : '';
  const phrase = words(rawPhrase);
  const hasPhrase = phrase.length > 0;
  const checks: SeoCheck[] = [];
  const leftOut: string[] = [];
  const add = (id: string, group: SeoCheckGroup, name: string, weight: number, result: SeoCheckResult, found: string, todo: string, fix: SeoFix | null) =>
    checks.push({ id, part: PART_OF[group], group, name, weight, result, found, todo: result === 'pass' ? null : todo, points: result === 'pass' ? weight : result === 'partly' ? weight / 2 : 0, fix: result === 'pass' ? null : fix });

  const str = (x: unknown) => (typeof x === 'string' ? x : x == null ? '' : String(x));
  const seoTitle = str(body?.seoTitle);
  const description = str(body?.metaDescription);
  const slug = str(body?.slug);
  const sections = Array.isArray(body?.sections) ? body.sections : [];
  const faqs = Array.isArray(body?.faqs) ? body.faqs : [];
  const intro = str(body?.intro);
  const conclusion = str(body?.conclusion);
  const headings = [...sections.map((s) => str(s?.heading)), ...faqs.map((f) => str(f?.q))];
  const bodies = [intro, ...sections.map((s) => str(s?.body)), ...faqs.map((f) => str(f?.a)), conclusion];
  const allWords = words(readable([intro, ...sections.flatMap((s) => [str(s?.heading), str(s?.body)]), ...faqs.flatMap((f) => [str(f?.q), str(f?.a)]), conclusion].join('\n')));
  const wordCount = allWords.length;
  const P = rawPhrase;
  const introWords = words(readable(intro));

  // ── Search: the search phrase ──
  if (hasPhrase) {
    const t = match(seoTitle, phrase);
    add('phrase.title', 'phrase', 'The search phrase is in the Google title', SEO_WEIGHTS.phraseTitle,
      t.kind === 'exact' ? 'pass' : t.kind === 'loose' ? 'partly' : 'fail',
      t.kind === 'exact' ? `The Google title uses ${quote(P)}.` : t.kind === 'loose' ? `The Google title has the words of ${quote(P)}, in a different order.` : seoTitle.trim() ? `The Google title does not use ${quote(P)}.` : 'The Google title is empty.',
      t.kind === 'loose' ? `If it still reads naturally, use the phrase ${quote(P)} as it is.` : `Put ${quote(P)} in the Google title, as naturally as you can.`, 'google-title');
    const firstHalf = t.at >= 0 && t.at <= Math.floor(t.length / 2);
    add('phrase.title_start', 'phrase', 'The search phrase is near the start of the Google title', SEO_WEIGHTS.phraseTitleStart,
      t.kind === 'exact' && firstHalf ? 'pass' : t.kind !== 'none' ? 'partly' : 'fail',
      t.kind === 'none' ? 'The phrase is not in the Google title yet.' : firstHalf ? (t.kind === 'exact' ? 'The phrase comes early in the Google title.' : 'Its words come early in the Google title, in a different order.') : 'The phrase comes late in the Google title.',
      'Move the search phrase towards the start of the Google title. People and Google read the first words most.', 'google-title');
    const d = match(description, phrase);
    add('phrase.description', 'phrase', 'The search phrase is in the short description in Google', SEO_WEIGHTS.phraseDescription,
      d.kind === 'exact' ? 'pass' : d.kind === 'loose' ? 'partly' : 'fail',
      d.kind === 'exact' ? `The short description uses ${quote(P)}.` : d.kind === 'loose' ? 'The short description has the words of the phrase, in a different order.' : description.trim() ? 'The short description does not use the phrase.' : 'The short description is empty.',
      `Use ${quote(P)} once in the short description. Google often shows those words in bold.`, 'description');
    const slugWords = slug.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
    const slugExact = exactAt(slugWords, phrase).length > 0;
    const slugLoose = !slugExact && meaningful(phrase).every((w) => slugWords.includes(w));
    add('phrase.address', 'phrase', 'The search phrase is in the page address', SEO_WEIGHTS.phraseAddress,
      slugExact ? 'pass' : slugLoose ? 'partly' : 'fail',
      slugExact ? 'The page address uses the phrase.' : slugLoose ? 'The page address has the main words of the phrase, in a different order.' : 'The page address does not use the phrase.',
      'Use the main words of the phrase in the page address, joined by hyphens. Only change it before the article is live.', 'address');
    const o = matchTokens(introWords, phrase);
    add('phrase.opening', 'phrase', 'The search phrase is in the opening paragraph', SEO_WEIGHTS.phraseOpening,
      o.kind === 'exact' ? 'pass' : o.kind === 'loose' ? 'partly' : 'fail',
      o.kind === 'exact' ? 'The opening paragraph uses the phrase.' : o.kind === 'loose' ? 'The opening paragraph has the words of the phrase, in a different order.' : 'The opening paragraph does not use the phrase.',
      'Use the phrase in the first two or three sentences, so readers and Google know at once what the article answers.', 'opening');
    const h = headings.map((x) => match(x, phrase).kind);
    const hExact = h.filter((k) => k === 'exact').length;
    add('phrase.heading', 'phrase', 'The search phrase is in at least one sub-heading', SEO_WEIGHTS.phraseHeading,
      hExact ? 'pass' : h.includes('loose') ? 'partly' : 'fail',
      hExact ? `${plural(hExact, 'sub-heading uses', 'sub-headings use')} the phrase.` : h.includes('loose') ? 'A sub-heading has the words of the phrase, in a different order.' : headings.length ? 'No sub-heading uses the phrase.' : 'The article has no sub-headings.',
      'Use the phrase, or something very close to it, in one sub-heading.', 'headings');
    const uses = exactAt(allWords, phrase).length;
    const loose = uses ? 0 : looseAt(allWords, phrase).length;
    const density = wordCount ? (uses * phrase.length * 100) / wordCount : 0;
    const dens = `${(Math.round(density * 10) / 10).toLocaleString('en-GB')}%`;
    const useResult: SeoCheckResult = uses >= 2 && density <= 2.5 ? 'pass' : uses === 0 && loose === 0 ? 'fail' : density > 4 ? 'fail' : 'partly';
    add('phrase.use', 'phrase', 'The search phrase is used a sensible number of times', SEO_WEIGHTS.phraseUse, useResult,
      uses === 0 ? (loose ? `The exact phrase is not used. Its words appear close together ${plural(loose, 'time', 'times')}.` : 'The article does not use the phrase at all.')
        : `The phrase is used ${plural(uses, 'time', 'times')} in ${plural(wordCount, 'word', 'words')} (${dens} of the words).${density > 4 ? ' That is too many: it reads as stuffed.' : density > 2.5 ? ' That is a little high.' : ''}`,
      uses <= 1 ? 'Use the exact phrase two or three times where it fits naturally.' : 'Use the phrase a little less. Say it naturally, and use other words for the same idea.', 'text');
  } else leftOut.push('the search phrase checks (no search phrase is on record)');

  // ── Search: the page ──
  const tl = seoTitle.trim().length;
  add('page.title_length', 'page', 'Google title length', SEO_WEIGHTS.titleLength, tl >= 30 && tl <= 65 ? 'pass' : tl === 0 ? 'fail' : 'partly',
    tl === 0 ? 'The Google title is empty.' : `The Google title is ${plural(tl, 'character', 'characters')}.${tl > 65 ? ' Google may cut it short.' : tl < 30 ? ' That is short; there is room to say more.' : ''}`,
    tl === 0 ? 'Write a Google title of 30 to 65 characters.' : tl > 65 ? 'Shorten it to 65 characters or fewer.' : 'Lengthen it towards 50 or 60 characters.', 'google-title');
  const dl = description.trim().length;
  add('page.description_length', 'page', 'Short description length', SEO_WEIGHTS.descriptionLength, dl >= 70 && dl <= 160 ? 'pass' : dl === 0 ? 'fail' : 'partly',
    dl === 0 ? 'The short description in Google is empty.' : `The short description is ${plural(dl, 'character', 'characters')}.${dl > 160 ? ' Google may cut it short.' : dl < 70 ? ' That is short.' : ''}`,
    'Aim for 70 to 160 characters: one or two sentences that make people want to click.', 'description');
  const sl = slug.length;
  add('page.address_length', 'page', 'Page address length', SEO_WEIGHTS.addressLength, sl > 0 && sl <= 60 ? 'pass' : sl > 0 && sl <= 80 ? 'partly' : 'fail',
    sl === 0 ? 'The page address ending is empty.' : `The page address ending is ${plural(sl, 'character', 'characters')}.`,
    sl === 0 ? 'Give the article a page address ending of a few words joined by hyphens.' : 'Keep the page address ending short: a few key words joined by hyphens. Only change it before the article is live.', 'address');
  const grade = wordCount >= STRONG_WORDS ? 'strong' : wordCount >= THIN_WORDS ? 'fine' : 'thin';
  add('page.length', 'page', 'Article length', SEO_WEIGHTS.articleLength, grade === 'strong' ? 'pass' : grade === 'fine' ? 'partly' : 'fail',
    `${plural(wordCount, 'word', 'words')}: ${grade}.`,
    grade === 'thin' ? `Under ${THIN_WORDS.toLocaleString('en-GB')} words is thin for Google. Ask for a rewrite with more detail and examples.` : `Articles of ${STRONG_WORDS.toLocaleString('en-GB')} words or more that stay useful tend to do better. Add an example or a worked case if it helps the reader.`, 'rewrite');
  const named = sections.filter((s) => str(s?.heading).trim()).length;
  add('page.subheadings', 'page', 'Sub-headings', SEO_WEIGHTS.subHeadings, named >= 3 ? 'pass' : named >= 1 ? 'partly' : 'fail',
    named ? `The article has ${plural(named, 'sub-heading', 'sub-headings')}.` : 'The article has no sub-headings.',
    'Break the article into at least three parts, each with a clear sub-heading.', named ? 'headings' : 'rewrite');
  const qa = faqs.filter((f) => str(f?.q).trim() && str(f?.a).trim()).length;
  add('page.questions', 'page', 'Questions and answers', SEO_WEIGHTS.questions, qa >= 3 ? 'pass' : qa >= 1 ? 'partly' : 'fail',
    qa ? `The article answers ${plural(qa, 'question', 'questions')} in its questions and answers.` : 'The article has no questions and answers.',
    qa ? 'Add a few more of the questions people ask about this.' : 'Ask for a rewrite that adds three to five questions people ask about this.', 'rewrite');

  // ── Search: links ──
  const own = new Set((context.siteHosts ?? []).map(hostOf).filter((x): x is string => Boolean(x)));
  const textLinks = bodies.flatMap(links);
  const internal = textLinks.filter((u) => { const host = hostOf(u); return host !== null && own.has(host); }).length;
  const external = textLinks.length - internal;
  const cta = body?.cta && typeof body.cta === 'object' ? body.cta : null;
  const ctaOwn = Boolean(cta && own.has(hostOf(str(cta.url)) ?? ''));
  add('links.internal', 'links', 'A link to another page on your own site', SEO_WEIGHTS.internalLink, internal ? 'pass' : ctaOwn ? 'partly' : 'fail',
    internal ? `The text links to your own site ${plural(internal, 'time', 'times')}.` : ctaOwn ? 'Only the button at the end links to your site.' : own.size ? 'The text does not link to any other page on your site.' : 'We do not know your website address yet, so we cannot tell which links are yours.',
    'Link a few words in the text to a related page on your site, such as a service page or another article.', 'links');
  const citations = Array.isArray(body?.citations) ? body.citations : [];
  const publicSources = citations.filter((c) => c?.public).length;
  add('links.sources', 'links', 'At least one cited outside source', SEO_WEIGHTS.outsideSource, publicSources || external ? 'pass' : citations.length ? 'partly' : 'fail',
    publicSources ? `The article shows ${plural(publicSources, 'source', 'sources')} to readers.` : external ? `The text links to ${plural(external, 'outside website', 'outside websites')}.` : citations.length ? 'Sources were used for research, but none is shown to readers.' : 'The article cites no outside source.',
    'Back up the key facts with a trusted source, such as an official or industry website.', citations.length ? null : 'rewrite');

  // ── Search: pictures ──
  const image = body?.image && typeof body.image === 'object' ? body.image : { url: null, alt: '' };
  const alt = str(image.alt).trim();
  add('pictures.main', 'pictures', 'A main picture with a picture description', SEO_WEIGHTS.mainPicture, image.url ? (alt.length >= 5 ? 'pass' : 'partly') : 'fail',
    image.url ? (alt.length >= 5 ? 'The article has a main picture with a description.' : 'The article has a main picture, but no description of it.') : 'The article has no main picture yet.',
    image.url ? 'Describe what the picture shows in a few words, for people who cannot see it.' : 'Add a picture: upload a photo, use one from your website or ask us to make one.', image.url ? 'picture-description' : 'picture');
  if (hasPhrase) {
    const a = image.url ? match(alt, phrase).kind : 'none';
    add('pictures.phrase', 'pictures', 'The picture description mentions the search phrase', SEO_WEIGHTS.pictureDescriptionPhrase, a === 'exact' ? 'pass' : a === 'loose' ? 'partly' : 'fail',
      !image.url ? 'There is no picture yet, so there is no description.' : a === 'exact' ? 'The picture description uses the phrase.' : a === 'loose' ? 'The picture description has the words of the phrase, in a different order.' : 'The picture description does not use the phrase.',
      image.url ? 'If it is true to the picture, use the phrase in its description.' : 'Add a picture first, then describe it using the phrase if it fits.', image.url ? 'picture-description' : 'picture');
  }
  add('pictures.inline', 'pictures', 'At least one picture inside the article', SEO_WEIGHTS.inlinePicture, 'fail',
    'There are no pictures inside the text. Articles cannot hold pictures inside the text yet.',
    'Nothing for you to do here yet: pictures inside the text are not possible today. The main picture is the one that counts for now.', null);

  // ── Easy to read ──
  const proseParas = bodies.flatMap((t) => paragraphs(readable(t)));
  const proseSentences = proseParas.flatMap(sentences);
  const itemSentences = bodies.flatMap((t) => listItems(readable(t))).flatMap(sentences);
  const allSentences = [...proseSentences, ...itemSentences];
  const tokens = allSentences.map((x) => words(x));
  const n = allSentences.length;
  const longS = tokens.filter((t) => t.length > LONG_SENTENCE_WORDS).length;
  const longShare = n ? (longS * 100) / n : 0;
  add('read.sentences', 'read', 'Short sentences', SEO_WEIGHTS.sentenceLength, !n ? 'fail' : longShare <= 25 ? 'pass' : longShare <= 35 ? 'partly' : 'fail',
    n ? `${pct(longShare)} of sentences are longer than ${LONG_SENTENCE_WORDS} words (${longS} of ${n}).` : 'The article has no sentences yet.',
    'Split the longest sentences in two. Aim for no more than one sentence in four over 20 words.', 'text');
  const longP = proseParas.filter((p) => words(p).length > LONG_PARAGRAPH_WORDS).length;
  add('read.paragraphs', 'read', 'Short paragraphs', SEO_WEIGHTS.paragraphLength, longP === 0 ? 'pass' : longP <= 2 ? 'partly' : 'fail',
    longP === 0 ? `No paragraph is longer than ${LONG_PARAGRAPH_WORDS} words.` : `${plural(longP, 'paragraph is', 'paragraphs are')} longer than ${LONG_PARAGRAPH_WORDS} words.`,
    'Split long paragraphs into shorter ones. People read on phones.', 'text');
  // Stretches of text between headings, as the page shows them: the opening, each part, each answer; the closing
  // paragraph runs on from whatever comes last.
  const stretches = [intro, ...sections.map((s) => str(s?.body)), ...faqs.map((f) => str(f?.a))].map((t) => words(readable(t)).length);
  stretches[stretches.length - 1] = (stretches[stretches.length - 1] ?? 0) + words(readable(conclusion)).length;
  const longest = Math.max(0, ...stretches);
  const tooLong = stretches.filter((x) => x > HEADING_SPACING_WORDS).length;
  add('read.spacing', 'read', 'Sub-headings often enough', SEO_WEIGHTS.headingSpacing, tooLong === 0 ? 'pass' : longest <= 400 ? 'partly' : 'fail',
    tooLong === 0 ? `No stretch of text runs over ${HEADING_SPACING_WORDS} words without a sub-heading.` : `${plural(tooLong, 'stretch runs', 'stretches run')} over ${HEADING_SPACING_WORDS} words without a sub-heading (the longest is ${plural(longest, 'word', 'words')}).`,
    'Add a sub-heading inside the longest parts, so readers can scan.', 'headings');
  const ease = readingEase(tokens);
  add('read.ease', 'read', 'Reading ease', SEO_WEIGHTS.readingEase, ease === null ? 'fail' : ease >= 60 ? 'pass' : ease >= 50 ? 'partly' : 'fail',
    ease === null ? 'There is too little text to judge how easy it is to read.' : `Reading ease ${Math.round(ease)} out of 100: ${easeWords(ease)}. Most readers find 60 or more comfortable.`,
    'Use shorter sentences and everyday words. Swap long words for short ones where you can.', 'text');
  let runs = 0;
  const firsts = tokens.slice(0, proseSentences.length).map((t) => t[0] ?? '');
  for (let i = 2; i < firsts.length; i++) {
    const w = firsts[i]!;
    if (w && w === firsts[i - 1] && w === firsts[i - 2] && (i < 3 || firsts[i - 3] !== w)) runs++;
  }
  add('read.starts', 'read', 'Varied sentence starts', SEO_WEIGHTS.sentenceStarts, runs === 0 ? 'pass' : runs === 1 ? 'partly' : 'fail',
    runs === 0 ? 'No three sentences in a row start with the same word.' : `${plural(runs, 'place has', 'places have')} three or more sentences in a row starting with the same word.`,
    'Start one of those sentences differently.', 'text');
  const linked = tokens.filter(hasLinkingWord).length;
  const linkShare = n ? (linked * 100) / n : 0;
  add('read.linking', 'read', 'Linking words', SEO_WEIGHTS.linkingWords, !n ? 'fail' : linkShare >= 30 ? 'pass' : linkShare >= 20 ? 'partly' : 'fail',
    n ? `${pct(linkShare)} of sentences use a linking word such as “because”, “so” or “for example”.` : 'The article has no sentences yet.',
    'Join ideas with words like “because”, “so”, “however” and “for example”. Aim for about one sentence in three.', 'text');

  // ── Answers the searcher ──
  const related = (Array.isArray(brief?.relatedQuestions) ? brief!.relatedQuestions! : []).filter((q) => typeof q === 'string' && meaningful(words(q)).length > 0);
  if (related.length) {
    const places = headings.map((x) => new Set(words(x)));
    const answered = related.filter((q) => {
      const need = meaningful(words(q));
      return places.some((set) => need.filter((w) => set.has(w)).length / need.length >= 0.6);
    });
    const missing = related.filter((q) => !answered.includes(q));
    add('answers.questions', 'answers', 'The questions people ask are answered', SEO_WEIGHTS.relatedQuestions,
      missing.length === 0 ? 'pass' : answered.length * 2 >= related.length ? 'partly' : 'fail',
      missing.length === 0 ? `All ${plural(related.length, 'question', 'questions')} we found people asking have a sub-heading or an answer.` : `${answered.length} of ${related.length} questions we found people asking have a sub-heading or an answer. Not yet: ${missing.slice(0, 3).map(quote).join(', ')}${missing.length > 3 ? ' and more' : ''}.`,
      'Add the missing questions to the questions and answers, or give them a sub-heading.', 'rewrite');
  } else leftOut.push('the questions people ask (none are on record for this article)');
  if (hasPhrase) {
    const first = introWords.slice(0, OPENING_WORDS);
    const early = matchTokens(first, phrase).kind;
    const anywhere = matchTokens(introWords, phrase).kind;
    add('answers.opening', 'answers', 'The opening gets straight to the point', SEO_WEIGHTS.openingToThePoint,
      early === 'exact' ? 'pass' : early === 'loose' || anywhere !== 'none' ? 'partly' : 'fail',
      early === 'exact' ? `The phrase comes in the first ${OPENING_WORDS} words, so readers see at once that this is what they searched for.` : early === 'loose' ? `The words of the phrase come in the first ${OPENING_WORDS} words, in a different order.` : anywhere !== 'none' ? `The opening comes to the phrase only after the first ${OPENING_WORDS} words.` : 'The opening does not mention what was searched for.',
      `Answer the search phrase in the first two sentences, within ${OPENING_WORDS} words.`, 'opening');
  }
  const ctaOk = Boolean(cta && str(cta.label).trim() && /^https:\/\//.test(str(cta.url)));
  add('answers.next_step', 'answers', 'A clear next step', SEO_WEIGHTS.nextStep, ctaOk ? 'pass' : 'fail',
    ctaOk ? `The article ends with a clear next step: ${quote(str(cta!.label).trim())}.` : 'The article does not end with a clear next step for the reader.',
    'Ask for a rewrite that ends with one clear next step, such as booking a call.', 'rewrite');
  if (context.checkIssues) {
    const unsourced = context.checkIssues.filter((x) => x?.code === 'facts.unsupported_figure' || x?.code === 'facts.figure_not_in_source').length;
    add('answers.figures', 'answers', 'Every figure has a source', SEO_WEIGHTS.figureSources, unsourced ? 'fail' : 'pass',
      unsourced ? `${plural(unsourced, 'figure does', 'figures do')} not match a source.` : 'Every figure in the article matches a source.',
      'Fix the figures listed at the top of the page before it goes out.', 'fix');
  } else leftOut.push('every figure has a source (the checks have not run on this version yet)');

  const order: Record<SeoCheckResult, number> = { fail: 0, partly: 1, pass: 2 };
  const parts = (['search', 'read', 'answers'] as const).map((p) => {
    const list = checks.filter((c) => c.part === p);
    return { part: p, label: SEO_PART_LABELS[p], points: list.reduce((s, c) => s + c.points, 0), weight: list.reduce((s, c) => s + c.weight, 0) };
  }).filter((x) => x.weight > 0);
  const earned = checks.reduce((s, c) => s + c.points, 0);
  const available = checks.reduce((s, c) => s + c.weight, 0);
  const score = available ? Math.round((earned * 100) / available) : 0;
  return { score, phrase: hasPhrase ? rawPhrase : null, checks: [...checks].sort((x, y) => order[x.result] - order[y.result]), parts, words: wordCount,
    readingEase: ease === null ? null : Math.round(ease), leftOut };
}
