import type { Intake, QAIssue } from '../types.js';
import { normalizeText, wordCount } from '../util/text.js';

/**
 * Banned-phrase list v1 — verbatim from Pipeline Spec v1.0 (Global QA
 * principle 3; grows from beta). Per-customer additions come from H3.never_use.
 *
 * Scope (decisions.md D-003/D-015): the GLOBAL list applies from S1 onward;
 * H3 never-words bind the customer's VOICE (S3+ copy stages) — analysis docs
 * opt out via `includeCustomerWords: false`. Text inside double quotes is the
 * customer's own words (verbatim-quoting is REQUIRED by other QA rules), so
 * callers can exempt it via `stripQuotedText` / `excludePathPrefixes` rather
 * than park a run for faithfully quoting a customer who said "seamless".
 */
export const GLOBAL_BANNED_PHRASES = [
  "in today's fast-paced world",
  'unlock your potential',
  'take your business to the next level',
  'we pride ourselves',
  'look no further',
  'game-changer',
  'seamless',
  'elevate',
] as const;

export function customerNeverWords(intake: Intake): string[] {
  return parseWordList(h3Field(intake, 'never_use'), { skipNegatedQuotes: false });
}

export function customerMustWords(intake: Intake): string[] {
  // In a MUST list, "never 'X'" is an instruction about X, not a word to require.
  return parseWordList(h3Field(intake, 'must_use'), { skipNegatedQuotes: true });
}

function h3Field(intake: Intake, key: string): string {
  const h3 = intake.H3;
  if (!h3 || typeof h3 !== 'object' || Array.isArray(h3)) return '';
  const v = (h3 as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : '';
}

const MAX_WORDLIST_ENTRY_WORDS = 4; // longer segments are instructions, not vocabulary

/**
 * H3 fields are free text, not clean CSV: customers quote phrases, add
 * dash-commentary and full-sentence instructions ("and call it a fuse board
 * not a consumer unit when talking to homeowners"). Quoted phrases are exact
 * entries; unquoted comma-segments count only when they look like vocabulary
 * (≤4 words, not an instruction). Dropped commentary still reaches the model
 * verbatim via the raw H3 in the stage input — this parser only decides what
 * QA mechanically ENFORCES; the human gate reads the raw field regardless.
 */
function parseWordList(raw: string, opts: { skipNegatedQuotes: boolean }): string[] {
  if (!raw) return [];
  const entries: string[] = [];
  let remainder = '';
  let last = 0;
  for (const m of raw.matchAll(/(['"])((?:(?!\1).)+?)\1/g)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    // Quote marks must sit at token boundaries on both sides — otherwise it's
    // an apostrophe inside a word ("we're", "isn't"), left for segment logic.
    const boundaryBefore = start === 0 || /[\s,,;.:(—–-]/.test(raw[start - 1] ?? '');
    const boundaryAfter = end === raw.length || /[\s,;.:!?)—–-]/.test(raw[end] ?? '');
    if (!boundaryBefore || !boundaryAfter) continue;
    const negated = /\b(?:never|not|no)\s*$/i.test(raw.slice(Math.max(0, start - 12), start));
    if (!negated || !opts.skipNegatedQuotes) entries.push(m[2] ?? '');
    remainder += `${raw.slice(last, start)} `;
    last = end;
  }
  remainder += raw.slice(last);

  for (const seg of remainder.replace(/\(.*?\)/g, '').split(/[,;.\n]+/)) {
    const s = normalizeText(seg)
      .replace(/^["']+|["']+$/g, '')
      .replace(/^[\s—–-]*(?:and|or|also|plus)\s+/i, '')
      .trim();
    if (!s) continue;
    if (/^(?:never|don'?t|avoid|no)\b/i.test(s)) continue; // instruction, not a word
    if (wordCount(s) > MAX_WORDLIST_ENTRY_WORDS) continue; // commentary, not a word
    entries.push(s);
  }
  return [...new Set(entries.map((w) => normalizeText(w).trim().toLowerCase()).filter((w) => w.length > 1))];
}

/** Yield every string leaf of an output object as [path, value]. */
export function* walkStrings(value: unknown, path: string): Generator<[string, string]> {
  if (typeof value === 'string') {
    yield [path, value];
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* walkStrings(value[i], `${path}[${i}]`);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* walkStrings(v, path ? `${path}.${k}` : k);
  }
}

/**
 * Word-ish matcher tolerant of the typography models actually emit: hyphen vs
 * space vs dash between tokens ("game changer"), curly quotes (normalized
 * upstream), suffixes ("game-changers", "elevated"). Leading boundary only —
 * "seamless" must not fire inside "seamstress", but suffixes still match.
 */
export function phraseRegex(phrase: string): RegExp {
  const tokens = phrase
    .toLowerCase()
    .split(/[\s-]+/)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b${tokens.join('[\\s\\-]+')}`, 'i');
}

export interface BannedScanOpts {
  /** Include the customer's H3 never-words (default true; S1/S2 pass false). */
  includeCustomerWords?: boolean;
  /** Remove double-quoted spans before matching — quoted customer words are exempt. */
  stripQuotedText?: boolean;
  /** Skip output paths entirely (e.g. S2's `verbatims`, which are raw customer words). */
  excludePathPrefixes?: string[];
}

export function scanBannedPhrases(output: unknown, intake: Intake, opts: BannedScanOpts = {}): QAIssue[] {
  const issues: QAIssue[] = [];
  const banned = [
    ...GLOBAL_BANNED_PHRASES,
    ...(opts.includeCustomerWords === false ? [] : customerNeverWords(intake)),
  ];
  const regexes = banned.map((p) => [p, phraseRegex(p)] as const);
  const excluded = opts.excludePathPrefixes ?? [];

  for (const [path, text] of walkStrings(output, '')) {
    if (excluded.some((prefix) => path === prefix || path.startsWith(`${prefix}[`) || path.startsWith(`${prefix}.`))) {
      continue;
    }
    let subject = normalizeText(text);
    if (opts.stripQuotedText) subject = subject.replace(/"[^"]*"/g, ' ');
    for (const [phrase, re] of regexes) {
      if (re.test(subject)) {
        issues.push({
          check: 'banned_phrase',
          message: `banned phrase "${phrase}" found at ${path} — rewrite without it (customer quotes inside double quotes are exempt)`,
        });
      }
    }
  }
  return issues;
}
