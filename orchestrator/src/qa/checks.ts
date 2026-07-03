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
import { extractNumbers, extractQuotedSpans, normalizeText } from '../util/text.js';
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

/** Does `text` contain ≥1 double-quoted span that is an exact substring of a consumed field? */
function citesVerbatim(text: string, fields: string[]): boolean {
  for (const span of extractQuotedSpans(text)) {
    const norm = normalizeText(span);
    if (!norm) continue;
    const fullValueMatch = fields.some((f) => f === norm); // short values (numbers, selects) must match whole
    const substringMatch = norm.length >= MIN_QUOTE_CHARS && fields.some((f) => f.includes(norm));
    if (fullValueMatch || substringMatch) return true;
  }
  return false;
}

/**
 * "No invented numbers" (Pipeline Spec: leak estimates must derive from B2/B3).
 * The prompt requires the arithmetic to be SHOWN — so a figure only passes if
 * it is justified by multipliers visible in the same string: small counts
 * ("2 lost jobs", "30 days") and period constants (12 months / 52 weeks),
 * applied to B2, B3 or B2×B3. 1% tolerance covers presentational rounding.
 * A number pulled from thin air ("industry benchmarks") has no visible
 * derivation and fails.
 */
const SMALL_NUMBER_MAX = 31; // counts and day-multipliers pass on their own
const IMPLICIT_MULTIPLIERS = [1, 12, 52];

function leakEstimateIssues(estimate: string, b2: number, b3: number): number[] {
  const numbers = extractNumbers(estimate);
  const smalls = numbers.filter((n) => !n.percent && n.value > 0 && n.value <= SMALL_NUMBER_MAX).map((n) => n.value);

  const multipliers = new Set<number>([...IMPLICIT_MULTIPLIERS, ...smalls]);
  for (const a of smalls) {
    for (const b of [...smalls, ...IMPLICIT_MULTIPLIERS]) multipliers.add(a * b); // "2 jobs × 12 months"
  }
  const bases = [b2, b3, b2 * b3].filter((b) => b > 0);

  const bad: number[] = [];
  for (const { value, percent } of numbers) {
    if (percent) {
      if (value > 100) bad.push(value);
      continue;
    }
    if (value <= SMALL_NUMBER_MAX) continue;
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

export function qaS1(output: unknown, intake: Intake): QAIssue[] {
  const issues: QAIssue[] = [];
  const out = output as S1Output;
  const fields = haystack(intake, S1_INPUT_FIELDS);
  const b2 = intakeNumber(intake, 'B2');
  const b3 = intakeNumber(intake, 'B3');

  const seen = new Set(out.scores.map((s) => s.category));
  for (const cat of S1_CATEGORIES) {
    if (!seen.has(cat)) {
      issues.push({ check: 's1.category_missing', message: `missing score for category "${cat}" — all six are required` });
    }
  }

  for (const score of out.scores) {
    if (!citesVerbatim(score.evidence, fields)) {
      issues.push({
        check: 's1.evidence_not_verbatim',
        message: `evidence for "${score.category}" must quote the customer's exact words: include at least one double-quoted snippet (≥${MIN_QUOTE_CHARS} chars, copied character-for-character) from the intake fields you were given`,
      });
    }
    for (const value of leakEstimateIssues(score.leak_cost_estimate, b2, b3)) {
      issues.push({
        check: 's1.leak_number_invented',
        message: `leak estimate for "${score.category}" contains ${value.toLocaleString('en-GB')}, which is not derived from B2 (£${b2}) or B3 (${b3}) via arithmetic shown in the estimate itself — show the working using only those inputs, e.g. "£${(2 * b2).toLocaleString('en-GB')}/mo (= 2 lost customers × £${b2.toLocaleString('en-GB')} average sale)"`,
      });
    }
  }

  // Global generic-phrase list only; H3 never-words bind copy stages (S3+).
  issues.push(...scanBannedPhrases(output, intake, { includeCustomerWords: false }));
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

function channelMatchesC7(channel: string, c7: string[]): boolean {
  const ct = channelTokens(channel);
  return c7.some((entry) => {
    const et = channelTokens(entry);
    for (const t of ct) if (et.has(t)) return true;
    return false;
  });
}

const MIN_VERBATIM_CHARS = 10;
const MIN_VERBATIMS = 2;

export function qaS2(output: unknown, intake: Intake): QAIssue[] {
  const issues: QAIssue[] = [];
  const out = output as S2Output;
  const c2 = normalizeText(fieldAsString(intake.C2));

  // Fact-echo hard check: every verbatim must be an EXACT substring of C2.
  if (out.verbatims.length < MIN_VERBATIMS) {
    issues.push({
      check: 's2.verbatims_too_few',
      message: `verbatims must contain at least ${MIN_VERBATIMS} exact quotes copied from the customer's own words (field C2)`,
    });
  }
  for (const v of out.verbatims) {
    const norm = normalizeText(v);
    if (norm.length < MIN_VERBATIM_CHARS) {
      issues.push({
        check: 's2.verbatim_too_short',
        message: `verbatim "${v}" is too short to be meaningful — quote a full phrase or sentence from C2`,
      });
    } else if (!c2.includes(norm)) {
      issues.push({
        check: 's2.verbatim_not_in_c2',
        message: `verbatim "${v}" is NOT an exact substring of C2 — copy the customer's words character-for-character; do not paraphrase, trim mid-word, or add punctuation`,
      });
    }
  }

  const stage = out.awareness_stage.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!(SCHWARTZ_AWARENESS_STAGES as readonly string[]).includes(stage)) {
    issues.push({
      check: 's2.awareness_stage_invalid',
      message: `awareness_stage "${out.awareness_stage}" is not one of the five Schwartz stages: ${SCHWARTZ_AWARENESS_STAGES.join(' / ')}`,
    });
  }

  if (out.exclusions.length === 0) {
    issues.push({ check: 's2.exclusions_empty', message: 'exclusions must be non-empty — derive them from C6 (the nightmare customer)' });
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

  issues.push(...scanBannedPhrases(output, intake, { includeCustomerWords: false }));
  return issues;
}
