import type { Intake, QAIssue } from '../types.js';

/**
 * Banned-phrase list v1 — verbatim from Pipeline Spec v1.0 (Global QA
 * principle 3; grows from beta). Per-customer additions come from H3.never_use.
 * Applied per-stage from S1 onward (decisions.md D-003).
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

function customerBannedWords(intake: Intake): string[] {
  const h3 = intake.H3;
  if (!h3 || typeof h3 !== 'object' || Array.isArray(h3)) return [];
  const never = (h3 as Record<string, unknown>).never_use;
  if (typeof never !== 'string') return [];
  return never
    .split(/[,;\n]+/)
    .map((w) => w.trim().toLowerCase())
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

function phraseRegex(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Word boundaries so "seamless" doesn't fire inside "seamstress", but
  // "game-changer" still matches "game-changers".
  return new RegExp(`\\b${escaped}`, 'i');
}

/**
 * Scan every string in a stage output for banned phrases. The global generic-
 * phrase list always applies. H3 never-words apply only where the caller opts
 * in — they bind the customer's VOICE (S3+ copy stages), not analysis documents
 * like the S1 audit / S2 ICP, which may legitimately mention e.g. "cheap"
 * competitors (decisions.md D-003).
 */
export function scanBannedPhrases(
  output: unknown,
  intake: Intake,
  opts: { includeCustomerWords?: boolean } = {},
): QAIssue[] {
  const issues: QAIssue[] = [];
  const banned = [
    ...GLOBAL_BANNED_PHRASES,
    ...(opts.includeCustomerWords === false ? [] : customerBannedWords(intake)),
  ];
  const regexes = banned.map((p) => [p, phraseRegex(p)] as const);

  for (const [path, text] of walkStrings(output, '')) {
    for (const [phrase, re] of regexes) {
      if (re.test(text)) {
        issues.push({
          check: 'banned_phrase',
          message: `banned phrase "${phrase}" found at ${path} — rewrite without it`,
        });
      }
    }
  }
  return issues;
}
