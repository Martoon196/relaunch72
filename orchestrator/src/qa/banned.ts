import type { Intake, QAIssue } from '../types.js';
import { normalizeText } from '../util/text.js';

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
  return customerBannedWords(intake);
}

export function customerMustWords(intake: Intake): string[] {
  const h3 = intake.H3;
  if (!h3 || typeof h3 !== 'object' || Array.isArray(h3)) return [];
  const must = (h3 as Record<string, unknown>).must_use;
  if (typeof must !== 'string') return [];
  return must
    .split(/[,;\n]+/)
    .map((w) => normalizeText(w).replace(/^["']+|["']+$/g, '').trim().toLowerCase())
    .filter((w) => w.length > 1);
}

function customerBannedWords(intake: Intake): string[] {
  const h3 = intake.H3;
  if (!h3 || typeof h3 !== 'object' || Array.isArray(h3)) return [];
  const never = (h3 as Record<string, unknown>).never_use;
  if (typeof never !== 'string') return [];
  return never
    .split(/[,;\n]+/)
    .map((w) =>
      normalizeText(w)
        .replace(/\(.*?\)/g, '') // "(except when quoting)" style annotations
        .replace(/^["']+|["']+$/g, '')
        .trim()
        .toLowerCase(),
    )
    .filter((w) => w.length > 1);
}

function* walkStrings(value: unknown, path: string): Generator<[string, string]> {
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
    ...(opts.includeCustomerWords === false ? [] : customerBannedWords(intake)),
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
