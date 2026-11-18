/**
 * Release 8 of the SEO quality plan: the writer gets the search requirements.
 *
 * When a brief carries a measured target phrase (`brief.seo`, keyword-first planning) and the engine is configured for
 * keyword-first work, the article writer is given a bounded `search_requirements` object inside its <brief> data block,
 * built here from data the platform already holds: the phrase and secondary phrases the planner chose by id, real
 * searched questions, the H2/H3 headings and word counts of the top-result pages research already read, the business's
 * length preference and the brief's own links to existing pages. Nothing here calls a supplier or a model.
 *
 * Two kinds of input, two levels of trust:
 * - The PRIMARY phrase comes from the measured candidate list the planner chose by id. It is cleaned for invisible and
 *   control characters, markup and length, and dropped only when it names a brand exclusion.
 * - Secondary phrases, questions and above all page headings come from the open web. They are also refused when they
 *   carry a web address or an instruction-like sentence, and a heading becomes a "topic" only when at least two
 *   different sites (never the business's own) carry it and it is not page furniture, a price, a phone number, a rating
 *   or a claim about a named business. The prompt says the block is data, never instructions.
 *
 * After writing, `chooseSearchFields` keeps the writer's own Google title and short description when they pass fixed
 * checks, and only otherwise uses the first option that does.
 *
 * Pure: no I/O, no clock. No function here throws on a damaged brief: it returns null.
 */

import { createHash } from 'node:crypto';
import { topicSimilarity } from './dedupe.js';
import { ASSERTIVE, PROMISE, PROOF, figureInText, materialFigures } from './checks.js';
import { GLOBAL_BANNED_PHRASES } from '../qa/banned.js';
import { decodeEntities } from './html.js';
import { phraseWeight } from './seo-score.js';
import type { ArticleBrief, LengthPreference, ResearchSource } from './types.js';

// ─── Caps ────────────────────────────────────────────────────────────────────

export const SEARCH_CAPS = Object.freeze({
  phraseChars: 80,
  questionChars: 120,
  topics: 8,
  topicChars: 80,
  links: 3,
  linkChars: 200,
  /**
   * Research capture. Outlines are kept for the first `outlinePerQuery` readable pages of EACH search, from different
   * sites and never the business's own (research reads at most four pages per search and runs at most eight searches),
   * so every measured phrase whose search returned pages can get topics; two is the least the two-site rule for topics
   * can use. `outlinePages` = 8 searches x 2, so the total cap never cuts a later search short; it only bounds storage.
   * Per page (unchanged): `outlineHeadings` headings of at most `outlineHeadingChars` characters. A page over
   * `outlineMaxHtml` characters keeps no outline (an ordinary article page is well under it; the fetch limit is 1.5 MB).
   * Worst case stored: 16 x 12 x 100 = 19,200 characters per plan (was 12 pages, 14,400).
   */
  outlinePerQuery: 2,
  outlinePages: 16,
  outlineHeadings: 12,
  outlineHeadingChars: 100,
  outlineMaxHtml: 1_000_000,
  /** The whole block as recorded on the version stays under this many bytes. */
  requirementsBytes: 3_000,
});

/** How many of each list the writer gets, by length setting: a short article cannot carry six questions without stuffing. */
export const LENGTH_LIMITS: Record<LengthPreference, { readonly questions: number; readonly variants: number; readonly secondary: number; readonly maxUses: number }> = {
  concise: { questions: 2, variants: 1, secondary: 2, maxUses: 4 },
  standard: { questions: 4, variants: 2, secondary: 3, maxUses: 6 },
  'in-depth': { questions: 6, variants: 3, secondary: 5, maxUses: 8 },
};

/** The word bands the writer's length preference already names (generation.ts LENGTH_HINT). */
export const LENGTH_RANGE: Record<LengthPreference, { readonly min: number; readonly max: number }> = {
  concise: { min: 700, max: 1100 },
  standard: { min: 1100, max: 1800 },
  'in-depth': { min: 1800, max: 2800 },
};

/** Pages with fewer words than this are not counted towards the length band (a blocked or thin read). */
const MIN_COUNTED_WORDS = 150;

// ─── Text hygiene ────────────────────────────────────────────────────────────

/**
 * Remove what a reader cannot see: zero-width characters, soft hyphens, byte-order marks, bidirectional controls,
 * variation selectors, tag characters and every other default-ignorable code point, and lone surrogates. They are
 * removed, not turned into spaces, so "Ig<ZWSP>nore" is read as "Ignore" and "pro<SHY>tection" as "protection".
 * Control characters (line breaks, tabs) become spaces.
 */
export function stripInvisible(s: string): string {
  return s.replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu, '').replace(/[\p{Cc}\u2028\u2029]/gu, ' ');
}

const tokenRoot = (t: string) => (t.length > 4 && t.endsWith('ies') ? `${t.slice(0, -3)}y` : t.length > 4 && /(?:s|x|z|ch|sh)es$/.test(t) ? t.slice(0, -2) : t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t);
const foldTokens = (s: string) => stripInvisible(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’']/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(tokenRoot);

/**
 * Whether `text` names one of the brand's exclusions: whole words only, simple singular and plural alike, hyphens,
 * spaces and joined spellings alike ("pay-day loans", "Payday loan" and "pay day loans" all match "Payday loans"; the
 * exclusion "tax" does not match "Taxi"). Exclusions of any length are matched.
 */
export function mentionsExclusion(text: string, exclusions: readonly unknown[]): boolean {
  const words = foldTokens(text);
  if (!words.length) return false;
  for (const raw of exclusions) {
    if (typeof raw !== 'string') continue;
    const target = foldTokens(raw).join('');
    if (target.length < 2) continue;
    for (let i = 0; i < words.length; i++) {
      let joined = '';
      for (let j = i; j < words.length && joined.length < target.length; j++) {
        joined += words[j];
        if (joined === target) return true;
      }
    }
  }
  return false;
}

/** Hygiene shared by every untrusted string: NFKC, invisible removed, tags and markup characters out, spaces collapsed. */
function tidy(raw: string): string {
  return stripInvisible(raw.normalize('NFKC'))
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>`*_#{}[\]|\\~^=$]/g, ' ')
    .replace(/^\s*(?:\d{1,2}[.)]|[-–•])\s+/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

const COMMON_TLD = '(?:com|net|org|io|co|uk|ai|app|dev|xyz|info|biz|example|ru|cn|top|site|online|shop|me|us|eu|de|fr|nl|ie|au|ca|gov|edu|ly|to|gg)';
/** A web address in any of its usual or dodged forms. A lowercase domain ending ("acme.co.uk", "booking.com") counts; "Node.js" and "ASP.NET" do not. */
const ADDRESS_LIKE: readonly RegExp[] = [
  /https?:|\bwww\.|:\/\/|@[a-z0-9-]+\./i,
  new RegExp(`\\b[\\p{L}\\p{N}-]+\\.${COMMON_TLD}\\b`, 'u'),
  new RegExp(`\\b[\\p{L}\\p{N}-]+\\s*(?:\\[\\.\\]|\\(\\.\\)|\\[dot\\]|\\(dot\\)|\\s\\.\\s|\\sdot\\s|[。．｡․])\\s*(?:[\\p{L}\\p{N}-]+|${COMMON_TLD})\\b`, 'iu'),
  /\b(?:co|org|gov|ac|ltd)\s+uk\b/i,
  /\bxn--/i,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/,
];
/**
 * Sentences addressed to the writer rather than to a reader. Narrow on purpose: ordinary headings such as "Heating
 * system: what to check", "How to link to your landlord portal", "Do not follow up too soon" or "How to respond in
 * writing" survive; the two-site rule for topics is the main defence against page text.
 */
const INSTRUCTION_LIKE: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass|discard|neglect)\b.{0,40}\b(?:instructions?|prompts?|directions?|guidance|guidelines|everything (?:above|before|you were told)|above|previous|prior)\b/i,
  /\b(?:system prompt|developer message|do anything now)\b/i,
  /\byou are (?:now )?(?:an? )?(?:ai|assistant|chatbot|language model)\b(?! (?:user|adopter))/i,
  /\b(?:hidden|secret|real) instructions?\s*[:-]|\bnew instructions?\s*:/i,
  /^[\s#>*-]*(?:system|assistant|user|human|developer)(?: (?:message|note|prompt))?\s*(?:[:;]|\s-)\s*(?:you|praise|reply|respond|write|ignore|act|pretend|always|never|do|now|new|follow|recommend|tell|say|include|add|mention|answer|from now)\b/i,
  /\[\/?inst\]|<\|/i,
  /\b(?:writers?|authors?|the (?:article|writer|author)|this (?:article|piece)) (?:must|should|need to|have to|are to)\b/i,
  /\bnote (?:for|to) the (?:author|writer)\b|\bpay no attention to\b|\bset aside what you\b/i,
  /\b(?:in the (?:intro|introduction|conclusion|first paragraph)|(?:every|each) section|throughout the article|the whole article|for this piece)\b/i,
  /^(?:always|never) (?:tell|say|write|recommend|praise)\b/i,
  /^(?:add|include|insert|put) (?:a |the |this |one )?(?:back)?links? (?:to|for)\b|^hyperlink\b/i,
  /\[?\b(?:src|profile):\S/i,
  /\b(?:respond|reply|answer) only (?:with|in)\b/i,
  /\b(?:do not|don't|never) (?:follow|obey) (?:the |your |any |these )?(?:rules|instructions|guidelines|prompt|system)\b/i,
  /\b(?:print|output|reveal|repeat|summari[sz]e) (?:your|the) (?:prompt|instructions|system prompt|guidelines)(?:\s*$|\s+(?:to|for) the reader)|\brepeat everything above\b/i,
  /\{\{|\}\}|\$\{/,
  // Directions to the writer about what the article must say or do (not a reader's how-to).
  /^(?:say|state|claim|conclude)\s+(?:that|it|this)\b/i,
  /^(?:tell|remind|point|direct|refer|send)\s+(?:the |your |all )?readers?\b/i,
  /^(?:[Rr]ecommend|[Pp]raise|[Pp]romote|[Ee]ndorse)\s+(?:\p{Lu}|us\b|our\b)/u,
  /^(?:finish|end|close|sign off) with (?:their|our|a link|the (?:phone|link|number))\b/i,
  /\bby name\b|\b(?:before|after|whatever) you write\b|\bthe reader wants\b|\bstop writing\b/i,
];

/**
 * Clean a phrase from the measured candidate list (the primary target): hygiene and length only, plus the brand's
 * exclusions. Never cut mid-way: over `max` characters it is refused.
 */
export function cleanPhrase(raw: unknown, max: number, excluded: readonly unknown[] = []): string | null {
  if (typeof raw !== 'string' || raw.length > 4 * max) return null;
  const text = tidy(decodeVisible(raw));
  if (text.length < 2 || text.length > max || !/\p{L}/u.test(text)) return null;
  if (mentionsExclusion(text, excluded)) return null;
  return text;
}

/**
 * Clean one piece of open-web text (secondary phrases, questions, headings), or drop it (null): the phrase hygiene,
 * then refused when it carries a web address or reads like an instruction to the writer. Checked before and after
 * markup is removed, so a fence or template marker cannot hide one.
 */
/**
 * Entities decoded (twice at most, so a double-encoded one cannot hide) with invisible characters removed before and
 * after, so "Ig&#8203;nore" reads as "Ignore" and "pro&shy;tection" as "protection".
 */
const PUNCTUATION_ENTITIES: Record<string, string> = { period: '.', commat: '@', colon: ':', sol: '/', bsol: '\\', num: '#', lowbar: '_', hyphen: '-', dash: '-', excl: '!', quest: '?', semi: ';', comma: ',', lpar: '(', rpar: ')', lsqb: '[', rsqb: ']', lcub: '{', rcub: '}', dollar: '$', percnt: '%', plus: '+', equals: '=', ast: '*', midast: '*', verbar: '|', vert: '|', grave: '`', Hat: '^', tilde: '~' };
function decodeVisible(raw: string): string {
  let s = stripInvisible(raw.normalize('NFKC'));
  for (let i = 0; i < 2 && /&(?:#x[0-9a-f]+|#\d+|[a-z]+);/i.test(s); i++) {
    s = s.replace(/&(?:shy|zwj|zwnj|lrm|rlm);/gi, '').replace(/&([a-z]+);/gi, (m, name: string) => PUNCTUATION_ENTITIES[name] ?? PUNCTUATION_ENTITIES[name.toLowerCase()] ?? m);
    s = stripInvisible(decodeEntities(s).normalize('NFKC'));
  }
  return s;
}

export function cleanSearchText(raw: unknown, max: number, excluded: readonly unknown[] = []): string | null {
  if (typeof raw !== 'string' || raw.length > 4 * max) return null;
  // Entities decoded and accents folded for the look-up, so "evil&#46;example" or "Ignóre previous instructions" cannot hide.
  const decoded = decodeVisible(raw);
  const folded = decoded.normalize('NFKD').replace(/\p{M}/gu, '');
  const hostile = (s: string) => ADDRESS_LIKE.some((re) => re.test(s)) || INSTRUCTION_LIKE.some((re) => re.test(s));
  // A role marker on any line, before lines are joined (split on the raw text: cleaning turns line breaks into spaces).
  const lines = raw.split(/[\r\n\u2028\u2029\u0085\v\f]+/).map((l) => decodeVisible(l).normalize('NFKD').replace(/\p{M}/gu, '').replace(/\s+/gu, ' ').trim());
  if (lines.some((line) => hostile(line)) || hostile(folded.replace(/\s+/gu, ' '))) return null;
  // A word mixing Latin with Cyrillic or Greek letters is a look-alike spelling.
  if (folded.split(/[^\p{L}]+/u).some((w) => /\p{Script=Latin}/u.test(w) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(w))) return null;
  const text = tidy(decoded);
  if (text.length < 3 || text.length > max || !/\p{L}.*\p{L}/u.test(text)) return null;
  if (hostile(text) || mentionsExclusion(text, excluded)) return null;
  return text;
}

/** Page furniture, not a topic: the whole heading (a heading that only starts with "Menu" or "Search" is kept). */
const FURNITURE = /^(?:related(?: posts| articles| guides| reading)?|further reading|sources|references|share(?: this(?: article| post)?)?|follow us|subscribe|newsletter|sign up|join (?:us|our)|comments?|leave a (?:reply|comment)|about (?:the )?(?:author|us)|who we are|meet the team|our (?:team|story|services|fees|prices|verdict)|contact(?: us)?|get in touch|speak to (?:an? )?(?:expert|adviser|advisor)|book (?:a|your) (?:call|consultation|viewing)|get (?:a|your) (?:free )?(?:quote|valuation)|request a (?:quote|callback)|table of contents|contents|menu|navigation|search|footer|categories|tags|popular(?: posts)?|recent posts|latest (?:news|posts|articles)|you (?:may|might) also like|more from|download|cookies?|cookie (?:policy|settings|preferences)|privacy(?: policy)?|we value your privacy|manage (?:(?:consent|cookie|privacy) )?(?:consent|preferences|settings|cookies)|your privacy|consent|terms(?: and conditions| of use)?|summary|key takeaways|conclusion|final thoughts|in conclusion|introduction|faqs?|frequently asked questions|q ?& ?a|testimonials?|reviews?|what our clients say|why choose us)(?:\s+(?:us|now|today|here|below|for (?:free|updates|more)|to (?:our|the|my) (?:newsletter|blog|updates|mailing list)|on (?:social media|\p{L}+(?: and \p{L}+)?)|this (?:article|post|page|guide)|with (?:friends|a friend)))?\s*[:.!?]*$/iu;
const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/;
const MONEY = /[£$€¥]\s?\d|\b\d[\d,.]*\s?(?:p|pence|pounds?|dollars?|euros?|gbp|usd|eur|k)\b/i;
const PERCENT = /\d\s?%|\bper ?cent\b|\bpercent\b/i;
const RATING = /\b[0-5](?:\.\d)?\s*(?:\/\s*5|stars?|out of (?:5|five))\b|★|☆|\bfive[- ]star\b|\brated\b/i;
/** A claim about a business: praise, blame, ranking or a recommendation. */
const CLAIM = /\b(?:scams?|fraud(?:ulent|sters?)?|rip[- ]?offs?|cowboys?|crooks?|steals?|stole|lies|liars?|cheats?|avoid|beats?|best|cheapest|top|leading|number one|#1|recommend(?:ed|s)?|award|trusted|guarantee[sd]?|unbeatable|official partner)\b/i;
/** A name: an acronym or a camel-case word anywhere ("DPS", "OpenRent"), or a capitalised word after the first. */
const NAMEISH = /(?:^|[\s(])(?:\p{Lu}{2,}\b|\p{Lu}\p{Ll}+\p{Lu}\p{L}*)|\s\p{Lu}\p{Ll}/u;
/** A health claim or a claim that a rule does not apply: never a topic to cover from page headings. */
const RISKY_CLAIM = /\b(?:cures?|cured|heals?|treats? (?:asthma|cancer|anxiety|depression)|exempt from|no longer (?:need|needs|required|applies|apply)|(?:do|does) not need to (?:protect|register|pay|comply)|loophole)\b/i;
/** Two or more capitalised words together that are not the heading's first word: a business or product name. */
const NAME_RUN = /(?:^|\s)\S+\s+(?:\p{Lu}[\p{L}&'-]+\s+)*\p{Lu}[\p{L}&'-]+\s+\p{Lu}[\p{L}&'-]+/u;

/** Why a heading is not a topic the writer should be told about (furniture, contact, price, rating or a claim). */
export function notATopic(h: string): boolean {
  return FURNITURE.test(h) || PHONE.test(h) || MONEY.test(h) || PERCENT.test(h) || RATING.test(h) || PROMISE.test(h) || PROOF.test(h)
    || RISKY_CLAIM.test(h) || (CLAIM.test(h) && (NAME_RUN.test(h) || NAMEISH.test(h) || /\b(?:we|our|us)\b/i.test(h))) || /\b(?:we|our|us)\b/i.test(h) && /\b(?:offer|charge|fees?|prices?|team|clients?|service)\b/i.test(h);
}

/** The registrable part of a host ("www.news.example.co.uk" gives "example.co.uk"), for counting different sites. */
export function registrableHost(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return null; }
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const second = labels.at(-2)!;
  const twoPart = /^(?:co|org|gov|ac|ltd|plc|net|sch|nhs|police|me|com|edu)$/.test(second) && labels.at(-1)!.length === 2;
  return labels.slice(twoPart ? -3 : -2).join('.');
}

// ─── The requirements ────────────────────────────────────────────────────────

export interface SearchRequirements {
  readonly primary_phrase: string;
  readonly natural_variants: readonly string[];
  readonly secondary_phrases: readonly string[];
  readonly questions_to_answer: readonly string[];
  readonly topics_top_results_cover: readonly string[];
  readonly length: { readonly min_words: number; readonly max_words: number; readonly basis: 'top_results' | 'length_preference' };
  /** The most times the phrase or a close variant should appear in the intro, headings, body and FAQs together. */
  readonly phrase_use_limit: number;
  readonly internal_links: readonly string[];
}

const isObject = (x: unknown): x is Record<string, unknown> => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

/**
 * A brief written to the search standard: a schema-2 record (bound by the id the planner returned) with a measured
 * target, a candidate id and a phrase. Never the honest "none", an observed-only phrase or a damaged record. Never throws.
 */
export function hasSearchTarget(brief: unknown): boolean {
  const seo = isObject(brief) ? brief.seo : null;
  if (!isObject(seo) || seo.schema !== 2) return false;
  const p = seo.primary;
  return isObject(p) && (p.basis === 'measured' || p.basis === 'parent_phrase') && typeof p.candidateId === 'string' && p.candidateId.length > 0
    && typeof p.phrase === 'string' && p.phrase.trim().length > 0;
}

/** Whether a brief at least claims a measured target (used to record an honest fallback). Never throws. */
export function claimsSearchTarget(brief: unknown): boolean {
  const seo = isObject(brief) ? brief.seo : null;
  const p = isObject(seo) ? seo.primary : null;
  return isObject(p) && p.basis !== 'none' && Boolean(p.candidateId);
}

/**
 * Research pages read for this phrase (research runs on the measured phrases themselves) that kept an outline. Never
 * the business's own site: its headings are not "what top results cover".
 */
export function topResultPages(sources: readonly ResearchSource[], phrase: string, brandWebsite?: string | null): ResearchSource[] {
  const p = phrase.trim().toLowerCase();
  const own = registrableHost(brandWebsite ?? null);
  return (Array.isArray(sources) ? sources : []).filter((s) => isObject(s) && typeof s.query === 'string' && s.query.trim().toLowerCase() === p && isObject(s.outline)
    && Array.isArray(s.outline.headings) && (!own || registrableHost(String(s.url)) !== own)).slice(0, SEARCH_CAPS.outlinePages);
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
  const counts = pages.map((s) => s.outline?.words ?? 0).filter((n) => typeof n === 'number' && Number.isFinite(n) && n >= MIN_COUNTED_WORDS).sort((a, b) => a - b);
  if (!counts.length) return { min_words: range.min, max_words: range.max, basis: 'length_preference' };
  const mid = counts.length >> 1;
  const median = counts.length % 2 ? counts[mid]! : (counts[mid - 1]! + counts[mid]!) / 2;
  const target = Math.min(range.max, Math.max(range.min, median));
  const min = Math.max(range.min, round50(target * 0.85));
  const max = Math.min(range.max, round50(target * 1.15));
  return min < max ? { min_words: min, max_words: max, basis: 'top_results' } : { min_words: range.min, max_words: range.max, basis: 'length_preference' };
}

/**
 * Headings at least two different sites carry (grouped by meaning), never the business's own site, never page
 * furniture, contact details, prices, ratings or claims about a business. Most-shared first. Nothing from a single page.
 */
export function commonTopics(pages: readonly ResearchSource[], skip: readonly string[], excluded: readonly unknown[], brandWebsite?: string | null): string[] {
  const own = registrableHost(brandWebsite ?? null);
  const groups: { text: string; hosts: Set<string> }[] = [];
  pages.forEach((page, i) => {
    const host = registrableHost(page.url) ?? `page-${i}`;
    if (own && host === own) return;
    for (const raw of (Array.isArray(page.outline?.headings) ? page.outline!.headings : [])) {
      const h = cleanSearchText(raw, SEARCH_CAPS.topicChars, excluded);
      if (!h || notATopic(h) || skip.some((s) => s.toLowerCase() === h.toLowerCase())) continue;
      const g = groups.find((x) => x.text.toLowerCase() === h.toLowerCase() || topicSimilarity(x.text, h) >= 0.7);
      if (g) g.hosts.add(host); else groups.push({ text: h, hosts: new Set([host]) });
    }
  });
  return groups.map((g, order) => ({ g, order })).filter(({ g }) => g.hosts.size >= 2).sort((a, b) => b.g.hosts.size - a.g.hosts.size || a.order - b.order)
    .slice(0, SEARCH_CAPS.topics).map(({ g }) => g.text);
}

/**
 * The most uses of the phrase (or a close variant) the body should carry: about 2% of the shortest length in the band
 * per main word of the phrase, never under 3, never over the length setting's ceiling. Keeps an article that follows
 * the block in full under the score's "a little high" share (2.5%). Main words are counted exactly as the score counts
 * them ("best", "guide", "uk" and years included), so the two never disagree.
 */
export function phraseUseLimit(phrase: string, minWords: number, preference: LengthPreference): number {
  const main = phraseWeight(phrase);
  return Math.max(3, Math.min(LENGTH_LIMITS[preference]?.maxUses ?? 6, Math.floor((0.02 * minWords) / main)));
}

/**
 * The bounded requirements for one brief, or null when it has no usable measured target (the writer then gets the
 * original prompt, unchanged). `pages` are research sources for this phrase; `linkable` the brand's real pages.
 * Never throws: a damaged record gives null.
 */
export function searchRequirements(input: {
  readonly brief: ArticleBrief;
  readonly pages: readonly ResearchSource[];
  readonly length: LengthPreference;
  readonly linkable: readonly { readonly url: string }[];
  readonly exclusions: readonly unknown[];
  readonly brandWebsite?: string | null;
}): SearchRequirements | null {
  try {
    if (!hasSearchTarget(input.brief)) return null;
    const seo = input.brief.seo!;
    const ex = Array.isArray(input.exclusions) ? input.exclusions : [];
    const preference: LengthPreference = LENGTH_LIMITS[input.length] ? input.length : 'standard';
    const limits = LENGTH_LIMITS[preference];
    const primary = cleanPhrase(seo.primary.phrase, SEARCH_CAPS.phraseChars, ex);
    if (!primary) return null;
    const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
    const textOf = (x: unknown, key: string): unknown => (isObject(x) ? x[key] : undefined);
    const phrases = (xs: readonly unknown[]) => xs.map((x) => cleanSearchText(x, SEARCH_CAPS.phraseChars, ex)).filter((x): x is string => Boolean(x));
    const secondaryAll = dedupe(phrases(list(seo.secondary).map((s) => textOf(s, 'phrase'))), [primary]);
    // A secondary phrase that is the target reworded is a variant, not a separate subject.
    const near = (x: string) => topicSimilarity(x, primary) >= 0.6;
    const natural_variants = dedupe([...phrases([seo.primary.parent]), ...secondaryAll.filter(near)], [primary]).slice(0, limits.variants);
    const secondary_phrases = secondaryAll.filter((x) => !near(x) && !natural_variants.includes(x)).slice(0, limits.secondary);
    // A question carrying a phone number is never something a searcher asked: drop it.
    const questions_to_answer = dedupe(list(seo.questions).map((q) => cleanSearchText(textOf(q, 'text'), SEARCH_CAPS.questionChars, ex)).filter((x): x is string => Boolean(x) && !PHONE.test(x!))).slice(0, limits.questions);
    const pages = (Array.isArray(input.pages) ? input.pages : []).slice(0, SEARCH_CAPS.outlinePages);
    const linkable = new Set((Array.isArray(input.linkable) ? input.linkable : []).map((l) => l?.url));
    const internal_links = dedupe(list(input.brief.internalLinks).filter((l): l is string => typeof l === 'string' && /^https:\/\/[^\s<>"]+$/.test(l) && l.length <= SEARCH_CAPS.linkChars && linkable.has(l))).slice(0, SEARCH_CAPS.links);
    const length = lengthBand(pages, preference);
    const skip = [primary, ...list(input.brief.outline).filter((x): x is string => typeof x === 'string')];
    return withinBytes({
      primary_phrase: primary, natural_variants, secondary_phrases, questions_to_answer,
      topics_top_results_cover: commonTopics(pages, skip, ex, input.brandWebsite ?? null),
      length, phrase_use_limit: phraseUseLimit(primary, length.min_words, preference),
      internal_links,
    });
  } catch {
    return null;
  }
}

/**
 * Keep the block under SEARCH_CAPS.requirementsBytes (as JSON, UTF-8), so the exact block the writer is given can be
 * stored whole on the version. English text at every cap is about 2,900 bytes; wide characters can go over, and then
 * the last topics, then questions, secondary phrases, variants and links are left out, in that order, until it fits.
 * The writer is given the trimmed block, so what is stored is always what was sent.
 */
function withinBytes(r: SearchRequirements): SearchRequirements {
  const size = (x: SearchRequirements) => Buffer.byteLength(JSON.stringify(x), 'utf8');
  let out = r;
  const order = ['topics_top_results_cover', 'questions_to_answer', 'secondary_phrases', 'natural_variants', 'internal_links'] as const;
  while (size(out) > SEARCH_CAPS.requirementsBytes) {
    const key = order.find((k) => out[k].length > 0);
    if (!key) break;
    out = { ...out, [key]: out[key].slice(0, -1) };
  }
  return out;
}

export function requirementsSha(r: SearchRequirements): string {
  return createHash('sha256').update(JSON.stringify(r)).digest('hex').slice(0, 16);
}

/** A stored block read back for a later rewrite: only a complete, well-formed record is used. */
export function storedRequirements(x: unknown): SearchRequirements | null {
  if (!isObject(x) || typeof x.primary_phrase !== 'string' || !x.primary_phrase) return null;
  const strings = (k: string) => Array.isArray(x[k]) && (x[k] as unknown[]).every((s) => typeof s === 'string');
  if (!['natural_variants', 'secondary_phrases', 'questions_to_answer', 'topics_top_results_cover', 'internal_links'].every(strings)) return null;
  if (!isObject(x.length) || typeof x.length.min_words !== 'number' || typeof x.length.max_words !== 'number' || typeof x.phrase_use_limit !== 'number') return null;
  return x as unknown as SearchRequirements;
}

// ─── Choosing the Google title and the short description ─────────────────────

export const TITLE_OPTIONS = 3;
export const DESCRIPTION_OPTIONS = 2;
export const TITLE_LIMITS = { min: 10, max: 65 } as const;
export const DESCRIPTION_LIMITS = { min: 70, max: 160 } as const;

export type OptionProblem = 'not_text' | 'too_short' | 'too_long' | 'no_phrase' | 'cut_off' | 'clickbait' | 'new_figure' | 'markup'
  | 'excluded' | 'unverified_proof' | 'address' | 'unknown_name' | 'brand_suffix' | 'unsupported_claim' | 'duplicate';

/** The phrase's words appear together, in order, ignoring case and punctuation. */
export function containsPhrase(text: string, phrase: string): boolean {
  const norm = (s: string) => ` ${s.normalize('NFKC').toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  const p = norm(phrase);
  return p.trim().length > 0 && norm(text).includes(p);
}

const CLICKBAIT = /\b(?:you won'?t believe|shocking|mind[- ]?blowing|jaw[- ]?dropping|unbelievable|insane|this one (?:trick|thing|secret)|what happens next|secrets?|truth (?:they|nobody|no one)|they (?:hide|don'?t want)|nobody tells|hidden truth|hacks?|needs? (?:right )?now|will blow your mind|must[- ]see|gone wrong|don'?t miss|best|cheapest|top-rated|ultimate|number one|#1|leading|always wins?|never lose|scams?|waste of money|rip[- ]?off|pointless)\b/i;
const DANGLING = /(?:\b(?:and|or|the|a|an|of|to|for|with|in|on|your|our|at|by|from|vs|about)|[-–—:,;&/(])$/i;
const NUMBER_WORDS = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen|percent|per cent|half|quarter|double|triple)\b/gi;
const NEGATED_RULE = /\b(?:not|no longer|never|isn'?t|aren'?t|don'?t|doesn'?t|exempt from|no need)\b.{0,25}\b(?:required|need(?:ed)?|must|apply|applies|legal|allowed|protect(?:ed)?)\b/i;
const MARKER = /\[src:[^\]]*\]/g;
/** Everyday words a Title Case title capitalises; never a business name on their own. */
const TITLE_CASE_WORDS = new Set(['A', 'An', 'The', 'And', 'Or', 'But', 'For', 'Of', 'To', 'In', 'On', 'At', 'By', 'With', 'From', 'Into', 'About', 'Vs', 'Your', 'You', 'Our', 'Their', 'Its', 'It',
  'What', 'When', 'Where', 'Why', 'How', 'Who', 'Which', 'Is', 'Are', 'Do', 'Does', 'Can', 'Should', 'Must', 'Need', 'Needs', 'Will', 'Guide', 'Explained', 'Plain', 'Complete', 'Simple', 'Rules', 'Steps', 'Checklist', 'Know']);

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const wordSet = (s: string) => new Set(stripInvisible(s).normalize('NFKC').toLowerCase().replace(/[’']s\b/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean));

export interface OptionContext {
  readonly phrase: string;
  /** The article's own prose (headings, intro, sections, conclusion, FAQs), with its markers. */
  readonly proseText: string;
  readonly exclusions?: readonly unknown[];
  /** The business's own name: allowed as a " | Name" suffix and as a name. */
  readonly brandName?: string | null;
  /** Google titles of the business's other articles (S8). */
  readonly takenTitles?: readonly string[];
}

/** Why a Google title or description fails, or an empty list. The same checks apply to the writer's main field and to each option. */
export function optionProblems(raw: unknown, kind: 'title' | 'description', ctx: OptionContext): OptionProblem[] {
  if (typeof raw !== 'string') return ['not_text'];
  const problems: OptionProblem[] = [];
  const add = (p: OptionProblem) => { if (!problems.includes(p)) problems.push(p); };
  if (/[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cs}\p{Cc}]/u.test(raw)) add('markup');
  const text = raw.replace(/\s+/g, ' ').trim();
  const limits = kind === 'title' ? TITLE_LIMITS : DESCRIPTION_LIMITS;
  const prose = ctx.proseText.replace(MARKER, ' ');
  const proseWords = wordSet(prose);
  const brand = ctx.brandName ? norm(ctx.brandName) : '';
  if (text.length < limits.min) add('too_short');
  if (text.length > limits.max) add('too_long');
  if (!containsPhrase(text, ctx.phrase)) add('no_phrase');
  if (/(?:…|\.\.\.)$/.test(text) || DANGLING.test(text) || (kind === 'description' && !/[.?]$/.test(text))) add('cut_off');
  if (/!/.test(text) || CLICKBAIT.test(text) || PROMISE.test(text) || GLOBAL_BANNED_PHRASES.some((b) => text.toLowerCase().includes(b)) || /\b\p{Lu}{4,}\b/u.test(text.replace(/\b(?:HMRC|HMLR|SDLT|LBTT|EPCS?|HMOS?|GDPR|FAQS?)\b/g, ''))) add('clickbait');
  if (/[<>]|\[|\]\(|[*_`#~]|&(?:#\d+|#x[0-9a-f]+|[a-z]+);|\p{Extended_Pictographic}|^["'“‘«]|["'”’»]$/iu.test(text)) add('markup');
  if (/https?:|\bwww\./i.test(text) || ADDRESS_LIKE.slice(1).some((re) => re.test(text))) add('address');
  // Every figure must be one the article states: material figures by value, and any other number as a whole number.
  const numbers = [...materialFigures(text), ...(text.match(/\b\d+(?:\.\d+)?\b/g) ?? [])];
  if (numbers.some((f) => !figureInText(f, prose))) add('new_figure');
  for (const m of text.matchAll(NUMBER_WORDS)) if (!proseWords.has(m[0].toLowerCase().split(' ')[0]!)) { add('new_figure'); break; }
  if (mentionsExclusion(text, ctx.exclusions ?? [])) add('excluded');
  if (PROOF.test(text)) add('unverified_proof');
  if (NEGATED_RULE.test(text) && !norm(prose).includes(norm(NEGATED_RULE.exec(text)![0]))) add('unsupported_claim');
  const assertive = ASSERTIVE.exec(text)?.[0];
  if (assertive && !proseWords.has(assertive.toLowerCase())) add('unsupported_claim');
  // " | Name" at the end, or " - Name" where every word is capitalised (a name, not a subtitle such as " - what to do"):
  // only the business's own name.
  const piped = /\s[|·•]\s*([^|·•]{1,60})$/.exec(text)?.[1];
  const dashed = /\s[-–—]{1,2}\s+([^|·•–—]{1,60})$/.exec(text)?.[1];
  const named = (x: string) => x.trim().split(/\s+/).every((w) => /^[\p{Lu}\p{N}&]/u.test(w));
  if ((piped && norm(piped) !== brand) || (dashed && named(dashed) && norm(dashed) !== brand)) add('brand_suffix');
  // A capitalised word that is not the start of the text or of a clause must be one the article, the phrase or the brand
  // uses: no competitor or company names.
  const brandWords = new Set([...wordSet(ctx.brandName ?? ''), ...wordSet(ctx.phrase)]);
  const tokens = text.split(/\s+/);
  tokens.forEach((t, i) => {
    const start = i === 0 || /[:.?|–—-]$/.test(tokens[i - 1]!);
    const w = t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/[’']s$/u, '');
    // A joined spelling is a name as a whole ("OpenRent", "Acme-Lettings") only when the whole is unknown; each part of
    // "plain-English" is looked up on its own.
    const known = (x: string) => proseWords.has(x.toLowerCase()) || brandWords.has(x.toLowerCase()) || TITLE_CASE_WORDS.has(x) || !/\p{Lu}/u.test(x);
    if (!start && w && !known(w) && !w.split(/[-–]/).every(known)) add('unknown_name');
  });
  if (kind === 'title' && (ctx.takenTitles ?? []).some((t) => typeof t === 'string' && norm(t) === norm(text))) add('duplicate');
  return problems;
}

export interface FieldChoice {
  /** 'model': the writer's own main field (kept when it passes, or when nothing passes); 'option': an option replaced a failing main field. */
  readonly chosen: 'option' | 'model';
  readonly index: number | null;
  readonly reason: string;
  /** What the writer's main field failed (empty when it passed). */
  readonly main: readonly OptionProblem[];
  /** Per option offered, in order: what failed (empty when it passed). Not checked when the main field passed. */
  readonly checked: readonly (readonly OptionProblem[])[];
}

/** Internal record on the version's generation record (outside the body and its hash). */
export interface SearchDraftRecord {
  readonly schema: 1;
  readonly requirementsSha: string;
  /** The exact block the writer was given (bounded, see SEARCH_CAPS.requirementsBytes). */
  readonly requirements: SearchRequirements;
  /** Article writing only; absent on a section rewrite. */
  readonly title?: FieldChoice;
  readonly description?: FieldChoice;
}

/** Why a measured brief was written with the original writer (internal). */
export type SearchFallbackReason = 'switch_off' | 'damaged' | 'phrase_dropped' | 'error';

function choose(options: unknown, max: number, kind: 'title' | 'description', ctx: OptionContext, main: string): { value: string; choice: FieldChoice } {
  const mainProblems = optionProblems(main, kind, ctx);
  if (!mainProblems.length) return { value: main, choice: { chosen: 'model', index: null, reason: 'the main field passed every check and was kept', main: [], checked: [] } };
  // Any list shape, any entry: only the first `max` entries are looked at, and only strings can pass.
  const offered = Array.isArray(options) ? options.slice(0, max) : [];
  const checked = offered.map((o) => optionProblems(o, kind, ctx));
  const index = checked.findIndex((p) => p.length === 0);
  if (index >= 0) return { value: (offered[index] as string).replace(/\s+/g, ' ').trim(), choice: { chosen: 'option', index, reason: `the main field failed a check; option ${index + 1} is the first that passed every check`, main: mainProblems, checked } };
  return { value: main, choice: { chosen: 'model', index: null, reason: offered.length ? 'the main field failed a check and no option passed every check; the main field was kept' : 'the main field failed a check and no usable options were returned; the main field was kept', main: mainProblems, checked } };
}

/** Pick the Google title and short description deterministically. Never alters the article's prose. */
export function chooseSearchFields(input: {
  readonly seoTitle: string; readonly metaDescription: string;
  readonly titleOptions?: unknown; readonly descriptionOptions?: unknown;
  readonly proseText: string; readonly requirements: SearchRequirements;
  readonly exclusions?: readonly unknown[]; readonly brandName?: string | null; readonly takenTitles?: readonly string[];
}): { seoTitle: string; metaDescription: string; record: SearchDraftRecord } {
  const ctx: OptionContext = { phrase: input.requirements.primary_phrase, proseText: input.proseText, exclusions: input.exclusions ?? [], brandName: input.brandName ?? null, takenTitles: input.takenTitles ?? [] };
  const t = choose(input.titleOptions, TITLE_OPTIONS, 'title', ctx, input.seoTitle);
  const d = choose(input.descriptionOptions, DESCRIPTION_OPTIONS, 'description', { ...ctx, takenTitles: [] }, input.metaDescription);
  return { seoTitle: t.value, metaDescription: d.value, record: { schema: 1, requirementsSha: requirementsSha(input.requirements), requirements: input.requirements, title: t.choice, description: d.choice } };
}
