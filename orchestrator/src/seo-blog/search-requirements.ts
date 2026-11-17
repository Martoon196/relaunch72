/**
 * Release 8 of the SEO quality plan: the writer gets the search requirements.
 *
 * When a brief carries a measured target phrase (`brief.seo`, keyword-first planning), the article writer is given a
 * bounded `search_requirements` object inside its <brief> data block, built here from data the platform already
 * holds: the phrase and secondary phrases the planner chose by id, real searched questions, the H2/H3 headings and
 * word counts of the top-result pages research already read, the business's length preference and the brief's own
 * links to existing pages. Nothing here calls a supplier or a model.
 *
 * Every phrase, question and heading comes from the open web or from a data supplier, so each is treated as hostile:
 * length-capped, stripped of control characters and markup, and dropped when it carries a web address, an
 * instruction-like sentence or one of the business's own exclusions. The prompt says the block is data, never
 * instructions; this module makes sure the obvious attacks never reach it at all.
 *
 * After writing, `chooseSearchFields` picks the Google title and the short description from the options the writer
 * returned, by fixed checks (first valid option wins; otherwise the writer's own main field is kept).
 *
 * Pure: no I/O, no clock.
 */

import { createHash } from 'node:crypto';
import { topicSimilarity } from './dedupe.js';
import { PROMISE } from './checks.js';
import { GLOBAL_BANNED_PHRASES } from '../qa/banned.js';
import type { ArticleBrief, LengthPreference, ResearchSource } from './types.js';

// ─── Caps ────────────────────────────────────────────────────────────────────

export const SEARCH_CAPS = Object.freeze({
  phraseChars: 80,
  variants: 3,
  secondary: 5,
  questions: 6,
  questionChars: 120,
  topics: 8,
  topicChars: 80,
  links: 3,
  linkChars: 200,
  /** Research capture: pages that keep an outline, headings kept per page, characters per heading. */
  outlinePages: 12,
  outlineHeadings: 12,
  outlineHeadingChars: 100,
});

/** The word bands the writer's length preference already names (generation.ts LENGTH_HINT). */
export const LENGTH_RANGE: Record<LengthPreference, { readonly min: number; readonly max: number }> = {
  concise: { min: 700, max: 1100 },
  standard: { min: 1100, max: 1800 },
  'in-depth': { min: 1800, max: 2800 },
};

/** Pages with fewer words than this are not counted towards the length band (a blocked or thin read). */
const MIN_COUNTED_WORDS = 150;

// ─── Hostile text ────────────────────────────────────────────────────────────

const URL_LIKE = /https?:|\bwww\.|:\/\/|\b[a-z0-9-]+\.(?:[a-z]{2,24})(?:\/|\b)/i;
const INSTRUCTION_LIKE: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\b.{0,60}\b(?:instructions?|prompts?|rules?|above|previous|prior|earlier|system|guidelines?|directions?)\b/i,
  /\b(?:system prompt|developer message|jailbreak|do anything now|as an ai\b)/i,
  /\byou are (?:now )?(?:an? )?(?:ai|assistant|chatbot|language model|writer who)\b/i,
  /\b(?:new|updated|real|hidden|secret) instructions?\b/i,
  /\b(?:assistant|system|user)\s*:/i,
  /\b(?:link to|add (?:a )?links?|include (?:a |this |the )?links?|insert (?:a )?links?|backlinks?)\b/i,
  /\b(?:do not|don't|never) (?:follow|obey|cite|mention)\b/i,
  /\b(?:respond|reply) (?:only )?(?:with|in)\b/i,
  /\b(?:print|output|reveal|repeat|show) (?:your|the) (?:prompt|instructions|system)\b/i,
  /\{\{|\}\}|<\||\|>/,
];
/** Page furniture, not a topic. */
const CHROME = /^(?:related(?: posts| articles)?|share(?: this)?|subscribe|newsletter|comments?|leave a (?:reply|comment)|about (?:the )?author|table of contents|contents|menu|search|follow us|popular(?: posts)?|recent posts|you (?:may|might) also like|sign up|cookies?(?: settings| policy)?|navigation|footer|categories|tags|get in touch|contact us)\b/i;

/**
 * Clean one piece of untrusted text, or drop it (null). Normalises, removes control and invisible characters and
 * markup, collapses spaces, and refuses text over `max` characters (never cut mid-way), text with a web address,
 * text that reads like an instruction to the writer, and text naming one of `excluded`.
 */
export function cleanSearchText(raw: unknown, max: number, excluded: readonly string[] = []): string | null {
  if (typeof raw !== 'string' || raw.length > 4 * max) return null;
  const visible = raw.normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u2028\u2029]/gu, ' ');
  // Instructions and addresses are looked for before markup is removed too, so a fence or template marker cannot hide one.
  if (URL_LIKE.test(visible) || INSTRUCTION_LIKE.some((re) => re.test(visible))) return null;
  const text = visible
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>`*_#{}[\]|\\~^=$]/g, ' ')
    .replace(/^\s*(?:\d{1,2}[.)]|[-–•])\s+/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (text.length < 3 || text.length > max || !/\p{L}.*\p{L}/u.test(text)) return null;
  if (URL_LIKE.test(text) || INSTRUCTION_LIKE.some((re) => re.test(text))) return null;
  const lower = text.toLowerCase();
  if (excluded.some((x) => { const e = x.trim().toLowerCase(); return e.length >= 3 && e.length <= 60 && lower.includes(e); })) return null;
  return text;
}

// ─── The requirements ────────────────────────────────────────────────────────

export interface SearchRequirements {
  readonly primary_phrase: string;
  readonly natural_variants: readonly string[];
  readonly secondary_phrases: readonly string[];
  readonly questions_to_answer: readonly string[];
  readonly topics_top_results_cover: readonly string[];
  readonly length: { readonly min_words: number; readonly max_words: number; readonly basis: 'top_results' | 'length_preference' };
  readonly internal_links: readonly string[];
}

/** A brief written to the search standard: one with a measured target chosen by id (never the honest "none"). */
export function hasSearchTarget(brief: ArticleBrief): boolean {
  const p = brief.seo?.primary;
  return Boolean(p && p.basis !== 'none' && p.candidateId && typeof p.phrase === 'string' && p.phrase.trim());
}

/** Research pages read for this phrase (research runs on the measured phrases themselves) that kept an outline. */
export function topResultPages(sources: readonly ResearchSource[], phrase: string): ResearchSource[] {
  const p = phrase.trim().toLowerCase();
  return sources.filter((s) => s.query.trim().toLowerCase() === p && s.outline).slice(0, SEARCH_CAPS.outlinePages);
}

function dedupe(items: readonly string[], against: readonly string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set(against.map((x) => x.toLowerCase()));
  for (const x of items) { const k = x.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}

const round50 = (n: number) => Math.round(n / 50) * 50;

/** The length band: the top results' median word count, held inside the business's own length preference. */
export function lengthBand(pages: readonly ResearchSource[], preference: LengthPreference): SearchRequirements['length'] {
  const range = LENGTH_RANGE[preference] ?? LENGTH_RANGE.standard;
  const counts = pages.map((s) => s.outline?.words ?? 0).filter((n) => Number.isFinite(n) && n >= MIN_COUNTED_WORDS).sort((a, b) => a - b);
  if (!counts.length) return { min_words: range.min, max_words: range.max, basis: 'length_preference' };
  const mid = counts.length >> 1;
  const median = counts.length % 2 ? counts[mid]! : (counts[mid - 1]! + counts[mid]!) / 2;
  const target = Math.min(range.max, Math.max(range.min, median));
  const min = Math.max(range.min, round50(target * 0.85));
  const max = Math.min(range.max, round50(target * 1.15));
  return min < max ? { min_words: min, max_words: max, basis: 'top_results' } : { min_words: range.min, max_words: range.max, basis: 'length_preference' };
}

/** Headings the top results share first (by how many pages carry a like heading), then others in page order. */
export function commonTopics(pages: readonly ResearchSource[], skip: readonly string[], excluded: readonly string[]): string[] {
  const groups: { text: string; pages: Set<number> }[] = [];
  pages.forEach((page, i) => {
    for (const raw of page.outline?.headings ?? []) {
      const h = cleanSearchText(raw, SEARCH_CAPS.topicChars, excluded);
      if (!h || CHROME.test(h) || skip.some((s) => s.toLowerCase() === h.toLowerCase())) continue;
      const g = groups.find((x) => x.text.toLowerCase() === h.toLowerCase() || topicSimilarity(x.text, h) >= 0.7);
      if (g) g.pages.add(i); else groups.push({ text: h, pages: new Set([i]) });
    }
  });
  return groups.map((g, order) => ({ g, order })).sort((a, b) => b.g.pages.size - a.g.pages.size || a.order - b.order)
    .slice(0, SEARCH_CAPS.topics).map(({ g }) => g.text);
}

/**
 * The bounded requirements for one brief, or null when it has no usable measured target (the writer then gets the
 * original prompt, unchanged). `pages` are research sources for this phrase; `linkable` the brand's real pages.
 */
export function searchRequirements(input: {
  readonly brief: ArticleBrief;
  readonly pages: readonly ResearchSource[];
  readonly length: LengthPreference;
  readonly linkable: readonly { readonly url: string }[];
  readonly exclusions: readonly string[];
}): SearchRequirements | null {
  if (!hasSearchTarget(input.brief)) return null;
  const seo = input.brief.seo!;
  const ex = input.exclusions;
  const primary = cleanSearchText(seo.primary.phrase, SEARCH_CAPS.phraseChars, ex);
  if (!primary) return null;
  const phrases = (xs: readonly unknown[]) => xs.map((x) => cleanSearchText(x, SEARCH_CAPS.phraseChars, ex)).filter((x): x is string => Boolean(x));
  const secondaryAll = dedupe(phrases(seo.secondary.map((s) => s.phrase)), [primary]);
  // A secondary phrase that is the target reworded is a variant, not a separate subject.
  const near = (x: string) => topicSimilarity(x, primary) >= 0.6;
  const natural_variants = dedupe([...phrases([seo.primary.parent]), ...secondaryAll.filter(near)], [primary]).slice(0, SEARCH_CAPS.variants);
  const secondary_phrases = secondaryAll.filter((x) => !natural_variants.includes(x)).slice(0, SEARCH_CAPS.secondary);
  const questions_to_answer = dedupe(seo.questions.map((q) => cleanSearchText(q.text, SEARCH_CAPS.questionChars, ex)).filter((x): x is string => Boolean(x))).slice(0, SEARCH_CAPS.questions);
  const pages = input.pages.slice(0, SEARCH_CAPS.outlinePages);
  const linkable = new Set(input.linkable.map((l) => l.url));
  const internal_links = dedupe(input.brief.internalLinks.filter((l) => /^https:\/\/[^\s<>"]+$/.test(l) && l.length <= SEARCH_CAPS.linkChars && linkable.has(l))).slice(0, SEARCH_CAPS.links);
  return {
    primary_phrase: primary, natural_variants, secondary_phrases, questions_to_answer,
    topics_top_results_cover: commonTopics(pages, [primary, ...input.brief.outline], ex),
    length: lengthBand(pages, input.length),
    internal_links,
  };
}

export function requirementsSha(r: SearchRequirements): string {
  return createHash('sha256').update(JSON.stringify(r)).digest('hex').slice(0, 16);
}

// ─── Choosing the Google title and the short description ─────────────────────

export const TITLE_OPTIONS = 3;
export const DESCRIPTION_OPTIONS = 2;
export const TITLE_LIMITS = { min: 10, max: 65 } as const;
export const DESCRIPTION_LIMITS = { min: 70, max: 160 } as const;

export type OptionProblem = 'not_text' | 'too_short' | 'too_long' | 'no_phrase' | 'cut_off' | 'clickbait' | 'new_figure' | 'markup';

/** The phrase's words appear together, in order, ignoring case and punctuation. */
export function containsPhrase(text: string, phrase: string): boolean {
  const norm = (s: string) => ` ${s.normalize('NFKC').toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  const p = norm(phrase);
  return p.trim().length > 0 && norm(text).includes(p);
}

const CLICKBAIT = /\b(?:you won'?t believe|shocking|mind[- ]?blowing|jaw[- ]?dropping|unbelievable|insane|this one (?:trick|thing|secret)|what happens next|the secret(?:s)? (?:to|of)|will blow your mind|must[- ]see|gone wrong|don'?t miss)\b/i;
const DANGLING = /(?:\b(?:and|or|the|a|an|of|to|for|with|in|on|your|our|at|by|from|vs)|[-–—:,;&/(])$/i;

function figures(text: string): string[] { return text.match(/\d+(?:[.,]\d+)*/g) ?? []; }

/** Why an option fails, or an empty list. `proseText` is the article's own prose: a figure must already be there. */
export function optionProblems(raw: unknown, kind: 'title' | 'description', phrase: string, proseText: string): OptionProblem[] {
  if (typeof raw !== 'string') return ['not_text'];
  const text = raw.replace(/\s+/g, ' ').trim();
  const limits = kind === 'title' ? TITLE_LIMITS : DESCRIPTION_LIMITS;
  const problems: OptionProblem[] = [];
  if (text.length < limits.min) problems.push('too_short');
  if (text.length > limits.max) problems.push('too_long');
  if (!containsPhrase(text, phrase)) problems.push('no_phrase');
  if (/(?:…|\.\.\.)$/.test(text) || DANGLING.test(text) || (kind === 'description' && !/[.?]$/.test(text))) problems.push('cut_off');
  if (/!/.test(text) || CLICKBAIT.test(text) || PROMISE.test(text) || GLOBAL_BANNED_PHRASES.some((b) => text.toLowerCase().includes(b)) || /\b[A-Z]{5,}\b/.test(text)) problems.push('clickbait');
  if (figures(text).some((f) => !proseText.includes(f))) problems.push('new_figure');
  if (/<|>|\[|\]\(|https?:|www\.|\[src:/i.test(text)) problems.push('markup');
  return problems;
}

export interface FieldChoice {
  /** 'option': the first option that passed; 'model': none passed, the writer's main field is kept. */
  readonly chosen: 'option' | 'model';
  readonly index: number | null;
  readonly reason: string;
  /** Per option offered, in order: what failed (empty when it passed). */
  readonly checked: readonly (readonly OptionProblem[])[];
}

/** Internal record of the choice, on the version's generation record (outside the body and its hash). */
export interface SearchDraftRecord {
  readonly schema: 1;
  readonly requirementsSha: string;
  readonly title: FieldChoice;
  readonly description: FieldChoice;
}

function choose(options: unknown, max: number, kind: 'title' | 'description', phrase: string, prose: string, fallback: string): { value: string; choice: FieldChoice } {
  const offered = Array.isArray(options) ? options.slice(0, max) : [];
  const checked = offered.map((o) => optionProblems(o, kind, phrase, prose));
  const index = checked.findIndex((p) => p.length === 0);
  if (index >= 0) return { value: (offered[index] as string).replace(/\s+/g, ' ').trim(), choice: { chosen: 'option', index, reason: `option ${index + 1} is the first that passed every check`, checked } };
  return { value: fallback, choice: { chosen: 'model', index: null, reason: offered.length ? 'no option passed every check; the main field was kept' : 'no options were returned; the main field was kept', checked } };
}

/** Pick the Google title and short description deterministically. Never alters the article's prose. */
export function chooseSearchFields(input: {
  readonly seoTitle: string; readonly metaDescription: string;
  readonly titleOptions?: unknown; readonly descriptionOptions?: unknown;
  readonly proseText: string; readonly requirements: SearchRequirements;
}): { seoTitle: string; metaDescription: string; record: SearchDraftRecord } {
  const phrase = input.requirements.primary_phrase;
  const t = choose(input.titleOptions, TITLE_OPTIONS, 'title', phrase, input.proseText, input.seoTitle);
  const d = choose(input.descriptionOptions, DESCRIPTION_OPTIONS, 'description', phrase, input.proseText, input.metaDescription);
  return { seoTitle: t.value, metaDescription: d.value, record: { schema: 1, requirementsSha: requirementsSha(input.requirements), title: t.choice, description: d.choice } };
}
