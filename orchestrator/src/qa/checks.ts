/**
 * Stage QA checks — Pipeline Spec v1.0.
 *   S1: every grade cites ≥1 intake fact verbatim; leak estimates derive from
 *       B2/B3 (no invented numbers); exactly the six categories.
 *   S2: verbatims are EXACT substrings of C2 (fact-echo, the anti-hallucination
 *       test — hard fail); awareness_stage ∈ Schwartz five; exclusions non-empty.
 * Thresholds documented in decisions.md D-001; normalization in D-002.
 */

import type { Intake, QAIssue } from '../types.js';
import { SCHWARTZ_AWARENESS_STAGES } from '../intake/spec.js';
import { extractNumbers, extractQuotedSpans, normalizeText, wordCount } from '../util/text.js';
import { scanBannedPhrases } from './banned.js';

export const S1_CATEGORIES = [
  'visibility',
  'message clarity',
  'conversion path',
  'follow-up',
  'proof',
  'offer strength',
] as const;

function fieldAsString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map((x) => fieldAsString(x)).join('\n');
  if (v && typeof v === 'object') return Object.values(v).map((x) => fieldAsString(x)).join('\n');
  return '';
}

function intakeNumber(intake: Intake, id: string): number {
  const v = intake[id];
  const n = typeof v === 'string' ? Number(v.replace(/[£$,\s]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Normalized values of the fields a stage consumed — the haystack for verbatim checks. */
function haystack(intake: Intake, fieldIds: string[]): string[] {
  return fieldIds
    .map((id) => normalizeText(fieldAsString(intake[id])))
    .filter((s) => s.length > 0);
}

const MIN_QUOTE_CHARS = 12;
const MIN_FULL_VALUE_CHARS = 6; // quoting "14" or "850" as "evidence" is not evidence

/** First double-quoted span in `text` that is an exact substring of a consumed field, or null. */
function findVerbatimSpan(text: string, fields: string[]): string | null {
  for (const span of extractQuotedSpans(text)) {
    const norm = normalizeText(span);
    if (!norm) continue;
    const fullValueMatch = norm.length >= MIN_FULL_VALUE_CHARS && fields.some((f) => f === norm);
    const substringMatch = norm.length >= MIN_QUOTE_CHARS && fields.some((f) => f.includes(norm));
    if (fullValueMatch || substringMatch) return norm;
  }
  return null;
}

/**
 * "No invented numbers" (Pipeline Spec: leak estimates must derive from B2/B3;
 * Global QA principle 1: numbers must trace to intake).
 * A figure passes only if it is (a) a small count, (b) a period length
 * ("90 days", "6 weeks"), (c) a year mention, (d) a number that literally
 * appears in the intake fields this stage consumed, or (e) justified by
 * multipliers visible in the same string — counts and period constants
 * applied to B2, B3 or B2×B3 with 1% rounding tolerance. A number pulled from
 * thin air ("industry benchmarks") has no visible derivation and fails.
 * Residual gaps (spelled-out numbers, %-smuggling ≤100) are accepted and
 * documented in decisions.md D-014 — the human gate remains the backstop.
 */
const SMALL_NUMBER_MAX = 31; // counts and day-multipliers pass on their own
const IMPLICIT_MULTIPLIERS = [1, 12, 52];
const PERIOD_AFTER = /^\s*-?\s*(day|week|month|year|yr|wk|mo)s?\b/i;

function inventedNumbers(text: string, b2: number, b3: number, intakeNumbers: ReadonlySet<number>): number[] {
  const numbers = extractNumbers(text);
  const smalls = numbers.filter((n) => !n.percent && n.value > 0 && n.value <= SMALL_NUMBER_MAX).map((n) => n.value);

  const multipliers = new Set<number>([...IMPLICIT_MULTIPLIERS, ...smalls]);
  for (const a of smalls) {
    for (const b of [...smalls, ...IMPLICIT_MULTIPLIERS]) multipliers.add(a * b); // "2 jobs × 12 months"
  }
  const bases = [b2, b3, b2 * b3].filter((b) => b > 0);

  const bad: number[] = [];
  for (const { value, percent, raw, before, after } of numbers) {
    if (percent) {
      if (value > 100) bad.push(value);
      continue;
    }
    if (value <= SMALL_NUMBER_MAX) continue;
    if (value <= 366 && PERIOD_AFTER.test(after)) continue; // "90 days", "180-day"
    if (/^(19|20)\d{2}$/.test(raw) && !/[£$€]\s*$/.test(before)) continue; // year, not money
    if (intakeNumbers.has(value)) continue; // echoes a fact the customer gave us
    let ok = false;
    for (const base of bases) {
      for (const m of multipliers) {
        if (Math.abs(value - m * base) <= Math.max(1, 0.01 * m * base)) {
          ok = true;
          break;
        }
      }
      if (ok) break;
    }
    if (!ok) bad.push(value);
  }
  return bad;
}

/** Every number literally present in the consumed intake fields (fact-echo allowance). */
function intakeNumberSet(fields: string[]): ReadonlySet<number> {
  const set = new Set<number>();
  for (const f of fields) {
    for (const n of extractNumbers(f)) set.add(n.value);
  }
  return set;
}

export const S1_INPUT_FIELDS = [
  'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7',
  'B1', 'B2', 'B3', 'B4', 'B5', 'B6',
  'E1', 'E2', 'E3', 'E4', 'E5',
  'F1', 'F2', 'F3', 'F4',
];

export const S2_INPUT_FIELDS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'A5', 'A6', 'B2'];

interface S1Score {
  category: string;
  grade_1to10: number;
  evidence: string;
  leak_cost_estimate: string;
}

interface S1Output {
  scores: S1Score[];
  top_3_leaks: string[];
  quick_wins: string[];
  narrative_summary: string;
}

const MIN_DISTINCT_EVIDENCE_SPANS = 3;

export function qaS1(output: unknown, intake: Intake): QAIssue[] {
  const issues: QAIssue[] = [];
  const out = output as S1Output;
  const fields = haystack(intake, S1_INPUT_FIELDS);
  const intakeNumbers = intakeNumberSet(fields);
  const b2 = intakeNumber(intake, 'B2');
  const b3 = intakeNumber(intake, 'B3');

  const seen = new Set(out.scores.map((s) => s.category));
  for (const cat of S1_CATEGORIES) {
    if (!seen.has(cat)) {
      issues.push({ check: 's1.category_missing', message: `missing score for category "${cat}" — all six are required` });
    }
  }

  const matchedSpans = new Set<string>();
  let evidenceFailures = 0;
  for (const score of out.scores) {
    const span = findVerbatimSpan(score.evidence, fields);
    if (span === null) {
      evidenceFailures++;
      issues.push({
        check: 's1.evidence_not_verbatim',
        message: `evidence for "${score.category}" must quote the customer's exact words: include at least one double-quoted snippet (≥${MIN_QUOTE_CHARS} chars, copied character-for-character) from the intake fields you were given`,
      });
    } else {
      matchedSpans.add(span);
    }
    for (const value of inventedNumbers(score.leak_cost_estimate, b2, b3, intakeNumbers)) {
      issues.push({
        check: 's1.leak_number_invented',
        message: `leak estimate for "${score.category}" contains ${value.toLocaleString('en-GB')}, which is not derived from B2 (£${b2}) or B3 (${b3}) via arithmetic shown in the estimate itself — show the working using only those inputs, e.g. "£${(2 * b2).toLocaleString('en-GB')}/mo (= 2 lost customers × £${b2.toLocaleString('en-GB')} average sale)"`,
      });
    }
  }

  // Quoting the same snippet as "evidence" for every category is not an audit.
  if (evidenceFailures === 0 && out.scores.length >= 6 && matchedSpans.size < MIN_DISTINCT_EVIDENCE_SPANS) {
    issues.push({
      check: 's1.evidence_repetitive',
      message: `the six categories cite only ${matchedSpans.size} distinct intake quote(s) — each category must be graded on its own evidence; quote different parts of the intake (at least ${MIN_DISTINCT_EVIDENCE_SPANS} distinct snippets across the scorecard)`,
    });
  }

  // No-invention rule also covers the prose sections: figures there must trace
  // to intake facts or visible B2/B3 arithmetic.
  const proseSections: Array<[string, string[]]> = [
    ['top_3_leaks', out.top_3_leaks],
    ['quick_wins', out.quick_wins],
    ['narrative_summary', [out.narrative_summary]],
  ];
  for (const [section, texts] of proseSections) {
    for (const text of texts) {
      for (const value of inventedNumbers(text, b2, b3, intakeNumbers)) {
        issues.push({
          check: 's1.number_invented',
          message: `${section} contains the figure ${value.toLocaleString('en-GB')}, which does not appear in the intake and is not derived from B2/B3 — remove it or show the derivation`,
        });
      }
    }
  }

  // Global generic-phrase list only; H3 never-words bind copy stages (S3+).
  // Double-quoted spans are the customer's own words — exempt.
  issues.push(...scanBannedPhrases(output, intake, { includeCustomerWords: false, stripQuotedText: true }));
  return issues;
}

interface S2Output {
  profile_narrative: string;
  verbatims: string[];
  exclusions: string[];
  awareness_stage: string;
  channels: string[];
}

const CHANNEL_ALIASES: Record<string, string> = {
  fb: 'facebook',
  ig: 'instagram',
  insta: 'instagram',
  yt: 'youtube',
  gbp: 'google',
  x: 'twitter',
};

function channelTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map((t) => CHANNEL_ALIASES[t] ?? t),
  );
}

/**
 * A channel corresponds to a C7 entry when one's token set contains the other
 * ("FB groups" ↔ "Facebook groups", "Google" ⊂ "Google search"). Mere overlap
 * on a generic token is not enough — "LinkedIn search" must NOT pass because
 * the customer picked "Google search".
 */
function channelMatchesC7(channel: string, c7: string[]): boolean {
  const ct = channelTokens(channel);
  if (ct.size === 0) return false;
  return c7.some((entry) => {
    const et = channelTokens(entry);
    if (et.size === 0) return false;
    const ctInEt = [...ct].every((t) => et.has(t));
    const etInCt = [...et].every((t) => ct.has(t));
    return ctInEt || etInCt;
  });
}

const MIN_VERBATIM_CHARS = 15;
const MIN_VERBATIM_WORDS = 3;
const MIN_VERBATIMS = 2; // distinct

export function qaS2(output: unknown, intake: Intake): QAIssue[] {
  const issues: QAIssue[] = [];
  const out = output as S2Output;
  const c2 = normalizeText(fieldAsString(intake.C2));

  // Fact-echo hard check: every verbatim must be an EXACT substring of C2,
  // meaningful (not a mid-word sliver), and verbatims must be DISTINCT — the
  // same sliver twice is not two quotes.
  const distinct = new Set<string>();
  for (const v of out.verbatims) {
    // Tolerate the model wrapping the quote in quotation marks — the customer
    // words inside must still match C2 exactly.
    let norm = normalizeText(v);
    const unwrapped = norm.replace(/^"+|"+$/g, '').trim();
    if (unwrapped && c2.includes(unwrapped)) norm = unwrapped;

    if (norm.length < MIN_VERBATIM_CHARS || wordCount(norm) < MIN_VERBATIM_WORDS) {
      issues.push({
        check: 's2.verbatim_too_short',
        message: `verbatim "${v}" is too short to be meaningful — quote a full phrase or sentence (≥${MIN_VERBATIM_WORDS} words) from C2`,
      });
    } else if (!c2.includes(norm)) {
      issues.push({
        check: 's2.verbatim_not_in_c2',
        message: `verbatim "${v}" is NOT an exact substring of C2 — copy the customer's words character-for-character; do not paraphrase, trim mid-word, or add punctuation`,
      });
    } else {
      distinct.add(norm);
    }
  }
  if (distinct.size < MIN_VERBATIMS) {
    issues.push({
      check: 's2.verbatims_too_few',
      message: `verbatims must contain at least ${MIN_VERBATIMS} DISTINCT exact quotes copied from the customer's own words (field C2)`,
    });
  }

  const stage = out.awareness_stage.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!(SCHWARTZ_AWARENESS_STAGES as readonly string[]).includes(stage)) {
    issues.push({
      check: 's2.awareness_stage_invalid',
      message: `awareness_stage "${out.awareness_stage}" is not one of the five Schwartz stages: ${SCHWARTZ_AWARENESS_STAGES.join(' / ')}`,
    });
  }

  const realExclusions = out.exclusions.filter((e) => normalizeText(e).length >= 5);
  if (realExclusions.length === 0) {
    issues.push({ check: 's2.exclusions_empty', message: 'exclusions must be non-empty and substantive — derive them from C6 (the nightmare customer)' });
  }

  const c7 = Array.isArray(intake.C7) ? (intake.C7 as string[]) : [];
  if (c7.length > 0) {
    for (const ch of out.channels) {
      if (!channelMatchesC7(ch, c7)) {
        issues.push({
          check: 's2.channel_not_from_c7',
          message: `channel "${ch}" does not correspond to anything the customer selected in C7 (${c7.join(', ')}) — channels must come from C7`,
        });
      }
    }
  }

  // Verbatims are raw customer words (exempt wholesale); quoted spans elsewhere
  // in the profile are likewise the customer's words, not generated prose.
  issues.push(
    ...scanBannedPhrases(output, intake, {
      includeCustomerWords: false,
      stripQuotedText: true,
      excludePathPrefixes: ['verbatims'],
    }),
  );
  return issues;
}
