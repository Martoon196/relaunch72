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
import { customerMustWords, customerNeverWords, GLOBAL_BANNED_PHRASES, phraseRegex, scanBannedPhrases, walkStrings } from './banned.js';

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
export function haystack(intake: Intake, fieldIds: string[]): string[] {
  return fieldIds
    .map((id) => normalizeText(fieldAsString(intake[id])))
    .filter((s) => s.length > 0);
}

const MIN_QUOTE_CHARS = 12;
const MIN_FULL_VALUE_CHARS = 6; // quoting "14" or "850" as "evidence" is not evidence

/**
 * Strip leading/trailing punctuation and quote marks from a quoted span. A
 * model quoting a customer faithfully routinely adds a closing "." the source
 * didn't have ("…never get round to it." vs F2 "…never get round to it") — the
 * words are exact, only the sentence-final punctuation differs. Stripping the
 * EDGES only keeps the anti-fabrication guarantee intact (internal wording must
 * still match) while not parking an honest near-verbatim quote.
 */
function coreQuote(norm: string): string {
  return norm.replace(/^["'“”‘’.,;:!?()\s—–-]+|["'“”‘’.,;:!?()\s—–-]+$/g, '');
}

/** Does a quoted span (edge-punctuation tolerant) trace to any haystack field? */
function quoteTracesTo(span: string, fieldsLC: string[]): boolean {
  const norm = normalizeText(span).toLowerCase();
  const core = coreQuote(norm);
  if (core.length < MIN_QUOTE_CHARS) return false;
  return fieldsLC.some((f) => f.includes(norm) || f.includes(core));
}

/** First double-quoted span in `text` that is a substring of a consumed field, or null. */
function findVerbatimSpan(text: string, fields: string[]): string | null {
  for (const span of extractQuotedSpans(text)) {
    const norm = normalizeText(span);
    if (!norm) continue;
    const core = coreQuote(norm);
    const fullValueMatch = norm.length >= MIN_FULL_VALUE_CHARS && fields.some((f) => f === norm || f === core);
    const substringMatch = core.length >= MIN_QUOTE_CHARS && fields.some((f) => f.includes(norm) || f.includes(core));
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
// Durations are period lengths, not statistics — hours/minutes/nights join
// days/weeks so "48-hour turnaround" and a "60-night guarantee" (an owner's
// actual wording) don't park a run (≤366 bound still applies).
const PERIOD_AFTER = /^\s*-?\s*(day|week|month|year|yr|wk|mo|hour|hr|minute|min|second|sec|night|fortnight)s?\b/i;
// Physical measurements are not fabricated business stats: "45cm chest",
// "100 amp board", "240 volts". Bounded so a large figure can't hide behind a
// unit. Single-letter units (v/w/a) must be attached (no space) to avoid
// catching "45 a month".
const UNIT_AFTER = /^\s*-?\s*(cm|mm|km|kg|kw|kwh|ml|amps?|volts?|watts?|litres?|lbs?|oz|°?[cf]\b)|^(v|w|a)\b/i;
const UNIT_VALUE_MAX = 10_000;

const SPELLED_INTEGERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, dozen: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
};

/** Matches any spelled-out numeral, so "sign two cohorts" counts as carrying a number. */
const SPELLED_NUMBER_WORD = new RegExp(
  `\\b(?:${Object.keys(SPELLED_INTEGERS).filter((w) => w !== 'a' && w !== 'an').join('|')}|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\\b`,
  'i',
);

/** Spelled-out small integers present in a string ("two lost jobs" → 2). */
function spelledCounts(text: string): number[] {
  const out: number[] = [];
  for (const m of normalizeText(text).toLowerCase().matchAll(/\b([a-z]+)\b/g)) {
    const n = SPELLED_INTEGERS[m[1] as string];
    if (n !== undefined) out.push(n);
  }
  return out;
}

interface InventedNumberOpts {
  /** Bare 19xx/20xx years pass unless money-adjacent. Copy stages set false. */
  allowYear?: boolean;
  /** true ⇒ every percentage must be echoed (or exactly 100); default: ≤100 passes. */
  percentEcho?: boolean;
}

function inventedNumbers(
  text: string,
  b2: number,
  b3: number,
  intakeNumbers: ReadonlySet<number>,
  /**
   * Additional arithmetic bases beyond B2/B3 — qaS1 passes the intake-echoed
   * numbers so "2 people at £300 (F3) = £600" is visible arithmetic, not
   * invention. When a stage supplies bases, visible +/×/÷ over already-allowed
   * numbers in the SAME string is recognised (honest shown working).
   */
  arithmeticBases?: ReadonlySet<number>,
  opts: InventedNumberOpts = {},
): number[] {
  const allowYear = opts.allowYear !== false;
  const numbers = extractNumbers(text);
  const smalls = [
    ...numbers.filter((n) => !n.percent && n.value > 0 && n.value <= SMALL_NUMBER_MAX).map((n) => n.value),
    ...spelledCounts(text), // "two lost customers × £850" — the count is a word
  ];

  // Every derived multiplier must involve a count VISIBLE in the string —
  // implicit×implicit products (12×12=144) would blanket the number line.
  const multipliers = new Set<number>([...IMPLICIT_MULTIPLIERS, ...smalls]);
  for (const a of smalls) {
    for (const b of [...smalls, ...IMPLICIT_MULTIPLIERS]) {
      multipliers.add(a * b); // "2 jobs × 12 months"
      if (b > 0) multipliers.add(a / b); // "7 jobs ÷ 4 agents × £850" — visible division
      if (a > 0) multipliers.add(b / a);
    }
  }
  const bases = [b2, b3, b2 * b3, ...(arithmeticBases ?? [])].filter((b) => b > 0);

  // Qualifying addends for shown sums: other numbers in the string that are
  // themselves allowed (echoed or small). Bundle savings sum ≥3 line items,
  // so check subsets, not just pairs (bounded to keep it linear-ish).
  const addends = numbers
    .filter((o) => !o.percent && (o.value <= SMALL_NUMBER_MAX || intakeNumbers.has(o.value) || (arithmeticBases?.has(o.value) ?? false)))
    .map((o) => o.value);
  const subsetSumHits = (target: number): boolean => {
    const pool = addends.filter((v) => v <= target + 1).slice(0, 12);
    const sums = new Set<number>([0]);
    for (const v of pool) {
      for (const s of [...sums]) {
        const t = s + v;
        if (Math.abs(t - target) <= Math.max(1, 0.01 * target)) return true;
        if (t < target + 1) sums.add(t);
      }
    }
    return false;
  };

  const bad: number[] = [];
  for (const num of numbers) {
    const { value, percent, raw, before, after } = num;
    if (percent) {
      if (opts.percentEcho) {
        if (value !== 100 && !intakeNumbers.has(value)) bad.push(value);
      } else if (value > 100) {
        bad.push(value);
      }
      continue;
    }
    if (value <= SMALL_NUMBER_MAX) continue;
    if (value <= 366 && PERIOD_AFTER.test(after)) continue; // "90 days", "180-day", "60-night"
    if (value <= UNIT_VALUE_MAX && UNIT_AFTER.test(after)) continue; // "45cm", "240v"
    if (allowYear && /^(19|20)\d{2}$/.test(raw) && !/[£$€]\s*$/.test(before)) continue; // year, not money
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
    // Visible addition (arithmetic-base stages only): "£58 + £119 + £24 = £201".
    if (!ok && arithmeticBases && subsetSumHits(value)) ok = true;
    if (!ok) bad.push(value);
  }
  return bad;
}

/** Every number literally present in the consumed intake fields (fact-echo allowance). */
export function intakeNumberSet(fields: string[]): ReadonlySet<number> {
  const set = new Set<number>();
  for (const f of fields) {
    for (const n of extractNumbers(f)) set.add(n.value);
  }
  return set;
}

/**
 * Every number that appears ANYWHERE in the customer's intake. The no-invention
 * FATAL checks use this: their job is to catch figures from nowhere (fabricated
 * "98% success", "500 clients"), NOT to police which field a real price came
 * from. A number the owner genuinely stated is a fact, not a fabrication — even
 * if this stage's prompt didn't hand it that specific field. (Whether a stage
 * over-reached into a field it wasn't given is a soft cross-contract matter for
 * the human gate, never a reason to park a run instantly.)
 */
function allIntakeNumbers(intake: Intake): ReadonlySet<number> {
  const set = new Set<number>();
  for (const v of Object.values(intake)) {
    for (const n of extractNumbers(normalizeText(fieldAsString(v)))) set.add(n.value);
  }
  return set;
}

/** Double-quoted spans removed — quoted customer/owner words are exempt (D-015). */
function stripQuoted(s: string): string {
  return s.replace(/"[^"]*"/g, ' ');
}

/**
 * Normalized string leaves of a prior-stage output — the haystack for
 * cross-stage no-invention checks (S6–S9 trace quotes/numbers back to what
 * earlier stages actually said).
 */
function stageStringLeaves(value: unknown, excludePathPrefixes: string[] = []): string[] {
  const out: string[] = [];
  for (const [path, text] of walkStrings(value, '')) {
    if (excludePathPrefixes.some((p) => path === p || path.startsWith(`${p}[`) || path.startsWith(`${p}.`))) continue;
    const norm = normalizeText(text);
    if (norm) out.push(norm);
  }
  return out;
}

/** Every numeric leaf of a stage output (e.g. S4 prices) — legal echoes downstream. */
function numericLeaves(value: unknown): number[] {
  if (typeof value === 'number') return Number.isFinite(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((v) => numericLeaves(v));
  if (value && typeof value === 'object') return Object.values(value).flatMap((v) => numericLeaves(v));
  return [];
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
    for (const value of inventedNumbers(score.leak_cost_estimate, b2, b3, intakeNumbers, intakeNumbers)) {
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
      for (const value of inventedNumbers(text, b2, b3, intakeNumbers, intakeNumbers)) {
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
      // Strip a trailing plural 's' so "letting agent contractor list" matches
      // the C7 entry "letting agents' contractor lists".
      .map((t) => CHANNEL_ALIASES[t] ?? (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t)),
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

// The prompt promises a verbatim "need only be a phrase long (10+ chars)".
// Provenance is guaranteed by the exact-substring-of-C2 test, so the length
// floor is only a meaningfulness guard — it must match the prompt, not exceed
// it, or punchy exact quotes ("death trap") park honest output.
const MIN_VERBATIM_CHARS = 10;
const MIN_VERBATIM_WORDS = 2;
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

// ─── S3 · Core message & voice guide ────────────────────────────────────────

export const S3_INPUT_FIELDS = ['A2', 'A4', 'E2', 'E3', 'E4', 'H1', 'H2', 'H3', 'C2', 'C3'];

interface S3Output {
  positioning_statement: string;
  message_pillars: string[];
  differentiators: string[];
  value_props: string[];
  voice: {
    sliders: Record<string, number>;
    tone_rules: string[];
    banned_words: string[];
    must_words: string[];
  };
  elevator_pitch: string;
}

const MAX_PITCH_WORDS = 60;

export function qaS3(output: unknown, intake: Intake, prior: Record<string, unknown> = {}): QAIssue[] {
  const issues: QAIssue[] = [];
  const out = output as S3Output;
  const eFields = haystack(intake, ['E2', 'E3']);

  // Every differentiator must trace to E2/E3 content — quote the owner's words.
  for (const d of out.differentiators) {
    if (findVerbatimSpan(d, eFields) === null) {
      issues.push({
        check: 's3.differentiator_untraced',
        message: `differentiator "${d.slice(0, 60)}…" does not quote the owner's own E2/E3 words — every differentiator must include a double-quoted exact snippet from E2 or E3`,
      });
    }
  }

  // banned_words must merge the global list + the customer's H3 never-words.
  const declared = new Set(out.voice.banned_words.map((w) => normalizeText(w).toLowerCase()));
  const required = [...GLOBAL_BANNED_PHRASES.map((p) => p.toLowerCase()), ...customerNeverWords(intake)];
  const missing = required.filter((w) => !declared.has(w));
  if (missing.length > 0) {
    issues.push({
      check: 's3.banned_words_incomplete',
      message: `voice.banned_words must include the global generic-phrase list AND the customer's H3 never-words — missing: ${missing.join(', ')}`,
    });
  }

  // must_words must carry the customer's H3 must-words through.
  const declaredMust = new Set(out.voice.must_words.map((w) => normalizeText(w).toLowerCase()));
  const missingMust = customerMustWords(intake).filter((w) => !declaredMust.has(w));
  if (missingMust.length > 0) {
    issues.push({
      check: 's3.must_words_incomplete',
      message: `voice.must_words must include the customer's H3 must-use words — missing: ${missingMust.join(', ')}`,
    });
  }

  // Sliders are the customer's own H1 settings — echoed, not reinvented.
  const h1 = intake.H1;
  if (h1 && typeof h1 === 'object' && !Array.isArray(h1)) {
    for (const [key, v] of Object.entries(h1 as Record<string, unknown>)) {
      if (typeof v === 'number' && out.voice.sliders[key] !== v) {
        issues.push({
          check: 's3.sliders_mismatch',
          message: `voice.sliders.${key} is ${out.voice.sliders[key]} but the customer set ${v} in H1 — echo their setting exactly`,
        });
      }
    }
  }

  if (wordCount(out.elevator_pitch) > MAX_PITCH_WORDS) {
    issues.push({
      check: 's3.pitch_too_long',
      message: `elevator_pitch is ${wordCount(out.elevator_pitch)} words — the spec caps it at ${MAX_PITCH_WORDS}`,
    });
  }
  // The pitch must not contain any banned word — global, H3, or its own list.
  const pitchNorm = normalizeText(out.elevator_pitch);
  for (const phrase of new Set([...required, ...declared])) {
    if (phraseRegex(phrase).test(pitchNorm)) {
      issues.push({ check: 's3.pitch_contains_banned', message: `elevator_pitch contains banned word/phrase "${phrase}"` });
    }
  }

  // One tone rule must be the voice guardrail: a contrast sentence of the
  // form "Sounds like X, not Y" (the comma before "not" is required so
  // incidental mid-sentence negation does not pass). S6–S8 copy is graded
  // against this rule.
  const hasGuardrail = out.voice.tone_rules.some((r) => {
    const norm = normalizeText(r);
    // normalizeText maps em/en dashes → '-', so accept a dash separator too:
    // "Sounds like a friend telling the truth — not a slide deck".
    return /\bsounds?\s+like\b/i.test(norm) && /[,-]\s*not\b/i.test(norm);
  });
  if (!hasGuardrail) {
    issues.push({
      check: 's3.voice_guardrail_missing',
      message: 'voice.tone_rules must include one voice-guardrail contrast rule of exactly the shape "Sounds like [a specific person or register], not [the failure mode]" — comma before "not" included',
    });
  }

  // The positioning statement must contrast with the real alternative — say
  // what the business is NOT, or use an instead-of construction.
  if (!/\bnot\b|\binstead of\b|\brather than\b|\bunlike\b/i.test(normalizeText(out.positioning_statement))) {
    issues.push({
      check: 's3.positioning_no_contrast',
      message: 'positioning_statement must explicitly contrast with the alternative the buyer would otherwise choose — say what the business is NOT, or use an "instead of X, you get Y" / "rather than" / "unlike" construction',
    });
  }

  // No-invention (FATAL — park, no retry): the message copy is where invented
  // "15 years / 500 clients / 98%" credentials would appear, and it flows into
  // every downstream deliverable. The whitelist is every number the customer
  // actually stated anywhere (a real price the owner charges is a fact, not a
  // fabrication) plus anything S2 surfaced. Echo-only: message copy shows no
  // arithmetic. Quoted spans are stripped first (D-015) — differentiators are
  // REQUIRED to quote E2/E3, which may contain figures.
  const s3Numbers = new Set<number>([...allIntakeNumbers(intake), ...numericLeaves(prior.S2)]);
  const proseSurfaces: Array<[string, string[]]> = [
    ['positioning_statement', [out.positioning_statement]],
    ['message_pillars', out.message_pillars],
    ['differentiators', out.differentiators],
    ['value_props', out.value_props],
    ['elevator_pitch', [out.elevator_pitch]],
  ];
  for (const [surface, texts] of proseSurfaces) {
    for (const text of texts) {
      for (const value of inventedNumbers(stripQuoted(normalizeText(text)), 0, 0, s3Numbers)) {
        issues.push({
          check: 's3.number_invented',
          message: `${surface} contains the figure ${value.toLocaleString('en-GB')}, which appears nowhere in the customer's intake or the buyer profile — a fabricated stat or credential in message copy parks the run`,
          fatal: true,
        });
      }
    }
  }

  // S3 IS the voice — customer never-words bind from here on. The banned_words
  // array itself is exempt (it exists to list them).
  issues.push(
    ...scanBannedPhrases(output, intake, {
      includeCustomerWords: true,
      stripQuotedText: true,
      excludePathPrefixes: ['voice.banned_words'],
    }),
  );
  return issues;
}

// ─── S4 · Offer architecture ────────────────────────────────────────────────

export const S4_INPUT_FIELDS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'B2', 'B6'];

interface S4Output {
  current_stack_read: string;
  recommended_stack: Array<{ name: string; price: number; role: string; rationale: string }>;
  lead_offer: string;
  pricing_moves: string[];
  risk_reversal_options: string[];
  category_note: string;
}

// Outcome-promise detection. Must catch genuine "we'll deliver you business
// results" promises WITHOUT firing on the explicitly-allowed reversals
// (refund a stated fee) or on descriptive prose that merely mentions
// customers/results near the word "guarantee".
const OUTCOME_GAIN_NOUN = 'results?|revenue|income|profits?|growth|sales|leads|customers|bookings|rankings?';
const OUTCOME_PROMISE_PATTERNS = [
  // "we guarantee results/sales" — outcome noun as the direct object of guarantee
  new RegExp(`\\bwe\\s+guarantee[ds]?\\s+(?:to\\s+\\w+\\s+)?(?:${OUTCOME_GAIN_NOUN})\\b`, 'i'),
  // delivery frame: "guarantee you 10 new customers", "guarantee more sales"
  new RegExp(`\\bguarantee[ds]?\\s+(?:you|your|more|extra|additional|new|another|\\d+)\\b[^.]{0,24}(?:${OUTCOME_GAIN_NOUN})\\b`, 'i'),
  /\b(?:double|triple|quadruple|[0-9]+x)\s+your\b/i,
  // "you'll earn £N" — but NOT "you'll get every penny back — all £4,200" (a refund).
  /\byou(?:'ll| will)\s+(?:make|earn|get|gain|add)\b(?![^.]{0,25}\b(?:back|refund(?:ed)?|returned|money)\b)[^.]{0,40}[£$€]\s?\d/i,
  /\bresults?\s+(?:are\s+)?guaranteed\b/i,
];

export function qaS4(output: unknown, intake: Intake, prior: Record<string, unknown> = {}): QAIssue[] {
  const issues: QAIssue[] = [];
  const out = output as S4Output;
  const b2 = intakeNumber(intake, 'B2');
  const dFields = haystack(intake, ['D1', 'D2', 'D3', 'D4', 'D5', 'D6']);

  for (const item of out.recommended_stack) {
    // Sanity bound vs B2/E4: no 10× jumps without an explicit rationale.
    if (b2 > 0 && item.price > 10 * b2 && item.rationale.length < 100) {
      issues.push({
        check: 's4.price_unjustified',
        message: `"${item.name}" at ${item.price} is more than 10× the current average sale (B2 = ${b2}) — either bring it into range or give a substantial explicit rationale for the jump`,
      });
    }
    // Every recommendation cites a D-field — by ID or by quoting it.
    const citesId = /\bD[1-6]\b/.test(item.rationale);
    const citesQuote = findVerbatimSpan(item.rationale, dFields) !== null;
    if (!citesId && !citesQuote) {
      issues.push({
        check: 's4.recommendation_uncited',
        message: `rationale for "${item.name}" must cite the intake's offer answers — reference the field ID (e.g. "(D2)") or quote the owner's exact words from D1–D6`,
      });
    }
  }

  // FATAL: a promised business outcome is a fabricated-outcome claim (Global
  // QA principle 2, no retry) — and this text ships verbatim into S6
  // guarantee copy.
  for (const rr of out.risk_reversal_options) {
    for (const re of OUTCOME_PROMISE_PATTERNS) {
      if (re.test(rr)) {
        issues.push({
          check: 's4.risk_reversal_promises_outcome',
          message: `risk reversal "${rr.slice(0, 70)}…" promises a business outcome — risk reversals may only promise what the owner controls (redo, refund, extra work), never results`,
          fatal: true,
        });
        break;
      }
    }
  }

  // The diagnosis must be evidenced in the owner's own words (mirrors the S1
  // evidence rule): a double-quoted ≥12-char exact substring of D1/D2/D3.
  if (findVerbatimSpan(out.current_stack_read, haystack(intake, ['D1', 'D2', 'D3'])) === null) {
    issues.push({
      check: 's4.current_stack_unquoted',
      message: 'current_stack_read must quote the owner: include at least one double-quoted snippet (≥12 chars, copied character-for-character) from D1, D2 or D3',
    });
  }

  // Every pricing move traces to the offer answers or the B2/B6 economics.
  for (const move of out.pricing_moves) {
    const citesId = /\b(D[1-6]|B[26])\b/.test(move);
    const citesQuote = findVerbatimSpan(move, dFields) !== null;
    if (!citesId && !citesQuote) {
      issues.push({
        check: 's4.pricing_move_uncited',
        message: `pricing move "${move.slice(0, 60)}…" must name its basis — cite a field ID (D1–D6, B2 or B6) or quote the owner's exact words from D1–D6`,
      });
    }
  }

  // The lead offer must be one of the recommended rungs, named exactly, so
  // S5/S6 can reference a real object.
  const leadNorm = normalizeText(out.lead_offer).toLowerCase();
  if (!out.recommended_stack.some((item) => leadNorm.includes(normalizeText(item.name).toLowerCase()))) {
    issues.push({
      check: 's4.lead_offer_not_in_stack',
      message: 'lead_offer must name one of the recommended_stack offers by its exact name',
    });
  }

  // Ladder shape: at least one entry and one core rung (premium optional)…
  const roles = new Set(out.recommended_stack.map((i) => i.role));
  if (!roles.has('entry') || !roles.has('core')) {
    issues.push({
      check: 's4.ladder_roles_missing',
      message: 'recommended_stack must include at least one "entry" rung and one "core" rung',
    });
  }
  // …with prices strictly ascending entry → core → premium.
  const pricesOf = (role: string) => out.recommended_stack.filter((i) => i.role === role).map((i) => i.price);
  const [entryPrices, corePrices, premiumPrices] = [pricesOf('entry'), pricesOf('core'), pricesOf('premium')];
  if (entryPrices.length > 0 && corePrices.length > 0 && Math.max(...entryPrices) >= Math.min(...corePrices)) {
    issues.push({
      check: 's4.ladder_not_ascending',
      message: 'every entry price must be below every core price — the ladder ascends from low-friction first yes to where the money is made',
    });
  }
  if (corePrices.length > 0 && premiumPrices.length > 0 && Math.max(...corePrices) >= Math.min(...premiumPrices)) {
    issues.push({
      check: 's4.ladder_not_ascending',
      message: 'every core price must be below every premium price — premium means more value per customer, priced accordingly',
    });
  }

  // Soft flag for the human gate: possible collision between an offer name
  // and what the owner refuses to do/sell (D6). Known false-positive risk —
  // deliberately non-fatal.
  const d6 = typeof intake.D6 === 'string' ? intake.D6 : '';
  if (d6.trim().length > 0) {
    const STOP = new Set(['service', 'services', 'customer', 'customers', 'business', 'client', 'clients', 'anything', 'refuse', 'never', 'would', 'offer', 'offers']);
    // A word the owner sells UNDER cannot itself be their hard limit: strip
    // tokens that appear in their own offering vocabulary (A2/D1/D2/D3). Trades
    // "Fuse Board Swap" no longer collides with D6 "…board swap and leave live"
    // because 'board'/'swap' are in D1; coach "Deep End Coaching" no longer
    // collides with D6 "performance coaching" because 'coaching' is their whole
    // business (A2/D1). What survives is an offer that names the SPECIFIC thing
    // the owner refuses — the real conflict this flag is for.
    const ownVocab = new Set(
      normalizeText(haystack(intake, ['A2', 'D1', 'D2', 'D3']).join(' ')).toLowerCase().split(/[^a-z0-9]+/),
    );
    const d6Tokens = new Set(
      normalizeText(d6).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 5 && !STOP.has(t) && !ownVocab.has(t)),
    );
    for (const item of out.recommended_stack) {
      const nameTokens = normalizeText(item.name).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 5 && !STOP.has(t));
      const hit = nameTokens.find((t) => d6Tokens.has(t));
      if (hit) {
        issues.push({
          check: 's4.d6_conflict',
          message: `offer "${item.name}" shares the word "${hit}" with D6 (what the owner refuses to do or sell) — review for a collision with their hard limits`,
        });
      }
    }
  }

  // No-invention (FATAL — park, no retry). Allowed figures: any number the
  // customer stated anywhere, the stack's own recommended prices, and anything
  // S2/S3 surfaced — plus visible arithmetic over those (bundle sums, per-head
  // divisions), which the prompt's own pricing-move menu asks the model to
  // show. A figure from nowhere (market data, made-up benchmarks) still parks.
  const s4Allowed = new Set<number>([
    ...allIntakeNumbers(intake),
    ...out.recommended_stack.map((i) => i.price),
    ...numericLeaves(prior.S2),
    ...numericLeaves(prior.S3),
  ]);
  const s4Prose: Array<[string, string[]]> = [
    ['current_stack_read', [out.current_stack_read]],
    ['lead_offer', [out.lead_offer]],
    ['pricing_moves', out.pricing_moves],
    ['risk_reversal_options', out.risk_reversal_options],
    ['category_note', [out.category_note]],
    ['recommended_stack.rationale', out.recommended_stack.map((i) => i.rationale)],
  ];
  for (const [surface, texts] of s4Prose) {
    for (const text of texts) {
      for (const value of inventedNumbers(text, b2, 0, s4Allowed, s4Allowed)) {
        issues.push({
          check: 's4.number_invented',
          message: `${surface} contains the figure ${value.toLocaleString('en-GB')}, which is not an intake fact, a recommended price, or visible arithmetic over those — no market data, competitor prices, conversion rates or benchmarks`,
          fatal: true,
        });
      }
    }
  }

  // S4 offer names, moves and guarantees flow into S6 customer-facing copy —
  // the customer's H3 never-words bind here (S3+ voice-stage rule).
  issues.push(...scanBannedPhrases(output, intake, { includeCustomerWords: true, stripQuotedText: true }));
  return issues;
}

// ─── S5 · 90-day growth plan ────────────────────────────────────────────────

export const S5_INPUT_FIELDS = ['G1', 'G2', 'G3', 'G4', 'B5', 'C7', 'F3', 'F4', 'D5'];

interface S5Output {
  north_star: string;
  phases: Array<{ days: string; theme: string; actions: Array<{ action: string; hours: number; channel: string; depends_on: string }> }>;
  channel_priorities: string[];
  do_not_do: string[];
  weekly_hours_total: number;
}

/** Upper bound of each G2 band — the plan must fit the owner's life (hard fail). */
export const G2_HOURS_CAP: Record<string, number> = { '<2': 2, '2–5': 5, '5–10': 10, '10+': 40 };

export function tokensOf(s: string): Set<string> {
  return new Set(
    normalizeText(s)
      .toLowerCase()
      .split(/[^a-z0-9£]+/)
      .filter((t) => t.length > 3),
  );
}

/** Naive singular stem so "rewire"/"rewires", "order"/"orders" match. */
function stemToken(t: string): string {
  return t.length > 4 && t.endsWith('s') ? t.replace(/s$/, '') : t;
}

/** Do two token sets share a token, tolerating a trailing-plural difference? */
function sharesStemToken(a: Set<string>, b: Set<string>): boolean {
  const bStems = new Set([...b].map(stemToken));
  return [...a].some((t) => bStems.has(stemToken(t)));
}

export function qaS5(output: unknown, intake: Intake, prior: Record<string, unknown> = {}): QAIssue[] {
  const issues: QAIssue[] = [];
  const out = output as S5Output;

  const g2 = typeof intake.G2 === 'string' ? intake.G2 : '';
  const cap = G2_HOURS_CAP[g2];
  if (cap !== undefined && out.weekly_hours_total > cap) {
    issues.push({
      check: 's5.hours_exceed_g2',
      message: `weekly_hours_total is ${out.weekly_hours_total} but the owner said they can give "${g2}" hours/week (G2) — the plan MUST fit inside ${cap} hours; a plan the owner can't run is a failed plan`,
    });
  }

  // North star must restate G1, with a number.
  const g1 = typeof intake.G1 === 'string' ? intake.G1 : '';
  const g1Overlap = [...tokensOf(out.north_star)].filter((t) => tokensOf(g1).has(t)).length;
  if (!/\d/.test(out.north_star) || g1Overlap < 1) {
    issues.push({
      check: 's5.north_star_not_g1',
      message: `north_star must restate the owner's own 90-day goal (G1: "${g1}") and put a number on it`,
    });
  }

  // Self-consistency: no action may run on a channel the plan itself forbids.
  // do_not_do entries are verbose prose that often mention a platform in an
  // ALLOWED context ("paid boosts flopped — organic posts to local groups are
  // proven"), so a bare platform/generic token is not a reliable collision.
  // Flag only when the action channel and a do_not_do entry share a TACTIC
  // token — a specific method (magazine, leaflet, paid, boost), not a platform
  // name or a generic word. This catches "don't do magazine ads" + a magazine
  // action, while never colliding organic "FB groups" with a paid-boost ban.
  const CHANNEL_GENERIC = new Set([
    'facebook', 'instagram', 'twitter', 'tiktok', 'youtube', 'linkedin', 'google', 'group', 'social',
    'post', 'online', 'offline', 'local', 'page', 'profile', 'search', 'video', 'content', 'website',
    'site', 'reel', 'story', 'feed', 'channel', 'platform', 'account', 'listing', 'business', 'email',
  ]);
  for (const phase of out.phases) {
    for (const action of phase.actions) {
      const ct = new Set([...tokensOf(action.channel)].map(stemToken).filter((t) => !CHANNEL_GENERIC.has(t)));
      if (ct.size === 0) continue;
      const clash = out.do_not_do.find((d) => {
        const dTokens = new Set([...tokensOf(d)].map(stemToken));
        return [...ct].some((t) => dTokens.has(t));
      });
      if (clash) {
        issues.push({
          check: 's5.action_on_forbidden_channel',
          message: `action "${action.action.slice(0, 50)}…" uses channel "${action.channel}" which the plan's own do_not_do entry "${clash.slice(0, 50)}…" forbids`,
        });
      }
    }
  }

  // Every phase must visibly serve the north star — the theme repeats the
  // goal's key noun (plural-tolerant: "one rewire" matches goal "rewires").
  const goalTokens = new Set([...tokensOf(out.north_star), ...tokensOf(g1)]);
  for (const phase of out.phases) {
    if (!sharesStemToken(tokensOf(phase.theme), goalTokens)) {
      issues.push({
        check: 's5.phase_theme_off_goal',
        message: `phase theme "${phase.theme.slice(0, 60)}…" doesn't reference the north star — repeat the goal's key noun (the thing being grown) in every theme`,
      });
    }
  }

  // Channel priorities come from C7 (+ what F4/F1 show already works).
  // channelMatchesC7 is alias-aware (FB↔Facebook, GBP↔Google) AND keeps short
  // names (SEO/PR) that tokensOf's length>3 filter would erase.
  const c7 = Array.isArray(intake.C7) ? (intake.C7 as string[]) : [];
  const f1Entries = Array.isArray(intake.F1) ? (intake.F1 as string[]) : [String(intake.F1 ?? '')];
  const provenEntries = [...c7, ...f1Entries];
  const provenText = tokensOf([intake.F4, intake.F1].map((v) => (Array.isArray(v) ? v.join(' ') : String(v ?? ''))).join(' '));
  for (const ch of out.channel_priorities) {
    const fromNamed = channelMatchesC7(ch, provenEntries);
    const fromProven = sharesStemToken(tokensOf(ch), provenText);
    if (!fromNamed && !fromProven) {
      issues.push({
        check: 's5.channel_priority_unsourced',
        message: `channel priority "${ch}" doesn't correspond to where the customers hang out (C7) or what has already worked (F4/F1) — priorities must come from those`,
      });
    }
  }

  // No-invention (FATAL — park, no retry): no benchmarks, reach estimates or
  // conversion rates. A figure passes only if it appears anywhere in the intake
  // or a prior stage (S1–S4), is a small count/period/year, or shows visible
  // arithmetic over those numbers in the same string.
  const s5Numbers = new Set<number>([
    ...allIntakeNumbers(intake),
    ...['S1', 'S2', 'S3', 'S4'].flatMap((s) => numericLeaves(prior[s])),
  ]);
  const s5b2 = intakeNumber(intake, 'B2');
  const s5b3 = intakeNumber(intake, 'B3');
  for (const [path, text] of walkStrings(output, '')) {
    // A phase label like "Days 31–90" is a calendar position, not a
    // projection — numbers inside the 90-day window pass in that field only.
    const isDaysLabel = /^phases\[\d+\]\.days$/.test(path);
    for (const value of inventedNumbers(text, s5b2, s5b3, s5Numbers, s5Numbers)) {
      if (isDaysLabel && value <= 366) continue;
      issues.push({
        check: 's5.number_invented',
        message: `${path} contains the figure ${value.toLocaleString('en-GB')}, which appears nowhere in the intake or the prior stages and shows no arithmetic in the same string — a fabricated projection parks the run`,
        fatal: true,
      });
    }
  }

  issues.push(...scanBannedPhrases(output, intake, { includeCustomerWords: false, stripQuotedText: true }));
  return issues;
}

// ─── S6 · Website copy pack ─────────────────────────────────────────────────

export const S6_INPUT_FIELDS = ['E1', 'E2', 'E3', 'E4', 'A1', 'A5'];

export const S6_HERO_ANGLES = ['problem-first', 'evidence-first', 'emotion-first', 'logic-first'] as const;

const S6_REQUIRED_HOME_IDS = ['benefits', 'proof', 'objections'];
const S6_REQUIRED_SALES_IDS = ['problem', 'offer', 'proof', 'objections', 'guarantee'];

const GENERIC_CTAS = new Set([
  'learn more', 'click here', 'get started', 'find out more', 'read more', 'submit', 'sign up',
  'contact us', 'get in touch', 'buy now', 'shop now', 'book now', 'discover more', 'start now', 'start today',
]);

/**
 * Credential-words (awards, certifications, media mentions, ratings) may
 * appear in copy only when the owner or a prior stage actually said them.
 * Keyword screen, not NLP — runs on quote-stripped text so real reviews
 * aren't punished.
 */
const PROOF_TRIGGERS = /\b(award[- ]?winning|awards?|certified|certifications?|accredit\w*|featured (?:in|on)|as seen (?:in|on)|(?:five|5)[- ]star|#\s?1|no\.\s?1|top[- ]rated|best[- ]rated)\b/gi;

interface S6Section {
  id: string;
  head: string;
  body: string;
  cta?: string;
}

interface S6Output {
  home: {
    hero_variants: Array<{ angle: string; headline: string; subhead: string; cta: string }>;
    sections: S6Section[];
  };
  about: { head: string; body: string };
  sales_page: { head: string; subhead: string; sections: S6Section[]; final_cta: string };
}

export function qaS6(output: unknown, intake: Intake, prior: Record<string, unknown>): QAIssue[] {
  const issues: QAIssue[] = [];
  const out = output as S6Output;
  const intakeHay = haystack(intake, S6_INPUT_FIELDS);
  const s2 = prior.S2 as S2Output | undefined;
  const s4 = prior.S4 as S4Output | undefined;
  const s2Verbatims = (s2?.verbatims ?? []).map((v) => normalizeText(v)).filter(Boolean);
  const quoteHay = [...s2Verbatims, ...intakeHay];
  const quoteHayLC = quoteHay.map((h) => h.toLowerCase());
  const priorStrings = ['S2', 'S3', 'S4'].flatMap((id) => stageStringLeaves(prior[id]));

  // NO-INVENTION (FATAL): any double-quoted passage ≥12 chars in website copy
  // reads as a testimonial or the owner speaking — it must be a substring of
  // the S2 verbatims or the consumed intake fields. Provenance is compared
  // case-insensitively: a sentence-cased real quote ("Best sparky…" vs source
  // "best sparky…") is genuine, so it must not FATALLY park — at worst it just
  // doesn't count toward the exact-quote quota below.
  const s2Placements: string[] = [];
  for (const [path, text] of walkStrings(output, '')) {
    for (const span of extractQuotedSpans(text)) {
      const norm = normalizeText(span);
      if (norm.length < MIN_QUOTE_CHARS) continue; // single-word scare quotes are style, not testimony
      if (!quoteTracesTo(span, quoteHayLC)) {
        issues.push({
          check: 's6.quote_fabricated',
          message: `quoted passage at ${path} ("${norm.slice(0, 60)}…") is not copied from the S2 verbatims or the intake fields this stage consumes — a fabricated quotation parks the run`,
          fatal: true,
        });
      } else if (s2Verbatims.some((v) => v.includes(norm))) {
        s2Placements.push(norm);
      }
    }
  }

  // NO-INVENTION (FATAL): a figure must be a real intake/prior number, a small
  // count, a period ("60-night"), a measurement ("45cm"), or visible arithmetic
  // over allowed numbers. NO bare-year pass (a year in web copy reads as a
  // founding claim). Percentages must be echoed or a bare 100%.
  const allowedNumbers = new Set<number>([
    ...allIntakeNumbers(intake),
    ...numericLeaves(prior.S2),
    ...numericLeaves(prior.S3),
    ...numericLeaves(prior.S4),
  ]);
  for (const [path, text] of walkStrings(output, '')) {
    for (const value of inventedNumbers(normalizeText(text), 0, 0, allowedNumbers, allowedNumbers, { allowYear: false, percentEcho: true })) {
      issues.push({
        check: 's6.number_invented',
        message: `${path} contains the figure ${value.toLocaleString('en-GB')}, which is not a real intake/prior number nor visible arithmetic over them — no invented stats, counts or claims in website copy`,
        fatal: true,
      });
    }
  }

  // NO-INVENTION (FATAL): credential-words only when an input actually said them.
  const proofHay = [...intakeHay, ...priorStrings].map((h) => h.toLowerCase().replace(/[\s-]+/g, ' '));
  for (const [path, text] of walkStrings(output, '')) {
    const subject = stripQuoted(normalizeText(text));
    for (const m of subject.matchAll(PROOF_TRIGGERS)) {
      const token = m[0].toLowerCase().replace(/[\s-]+/g, ' ');
      if (!proofHay.some((h) => h.includes(token))) {
        issues.push({
          check: 's6.proof_word_unsupported',
          message: `${path} claims "${m[0]}" but no consumed intake field or prior stage says it — credential claims must come from the owner, never the copywriter`,
          fatal: true,
        });
      }
    }
  }

  // ≥3 quoted placements of S2 verbatims (distinct floor min(3, |verbatims|)
  // — S2's own QA only guarantees 2 distinct verbatims on thin C2 input).
  const distinctPlacements = new Set(s2Placements);
  const requiredDistinct = Math.min(3, s2Verbatims.length);
  if (s2Placements.length < 3 || distinctPlacements.size < requiredDistinct) {
    issues.push({
      check: 's6.verbatim_quota',
      message: `the pack places ${s2Placements.length} quoted customer verbatim(s) (${distinctPlacements.size} distinct) — copy at least 3 of the S2 verbatims character-for-character inside double quotes across the pages (at least ${requiredDistinct} distinct)`,
    });
  }

  // The two heroes must open from different angles — a real A/B choice.
  const [heroA, heroB] = out.home.hero_variants;
  if (heroA && heroB && heroA.angle === heroB.angle) {
    issues.push({
      check: 's6.hero_angles_same',
      message: `both hero variants use the "${heroA.angle}" angle — they must open from two different angles`,
    });
  }

  const homeIds = new Set(out.home.sections.map((s) => s.id.trim().toLowerCase()));
  for (const id of S6_REQUIRED_HOME_IDS) {
    if (!homeIds.has(id)) {
      issues.push({ check: 's6.home_sections_missing', message: `home.sections must include a "${id}" section` });
    }
  }
  const salesIds = new Set(out.sales_page.sections.map((s) => s.id.trim().toLowerCase()));
  for (const id of S6_REQUIRED_SALES_IDS) {
    if (!salesIds.has(id)) {
      issues.push({ check: 's6.sales_sections_missing', message: `sales_page.sections must include a "${id}" section` });
    }
  }

  // Multiple action points down the page, not one buried button.
  const homeCtaCount = out.home.sections.filter((s) => typeof s.cta === 'string' && normalizeText(s.cta).length > 0).length;
  if (homeCtaCount < 2) {
    issues.push({
      check: 's6.home_cta_coverage',
      message: `only ${homeCtaCount} home section(s) carry a CTA — at least 2 sections need their own action point`,
    });
  }

  const allCtas = [
    ...out.home.hero_variants.map((h) => h.cta),
    ...out.home.sections.filter((s) => s.cta).map((s) => s.cta as string),
    ...out.sales_page.sections.filter((s) => s.cta).map((s) => s.cta as string),
    out.sales_page.final_cta,
  ];

  // A CTA must name the concrete action and payoff.
  for (const cta of allCtas) {
    const c = normalizeText(cta).toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').replace(/\s+/g, ' ');
    if (wordCount(c) < 3 || GENERIC_CTAS.has(c)) {
      issues.push({
        check: 's6.cta_generic',
        message: `CTA "${cta}" is generic — name the concrete action and payoff in at least 3 words`,
      });
    }
  }

  // At least one CTA names a stack offer by name. Tokens come from the offer
  // NAMES only — lead_offer prose would drag in function words ("what",
  // "they") that make the overlap trivially true.
  const offerTokens = tokensOf((s4?.recommended_stack ?? []).map((o) => o.name).join(' '));
  if (offerTokens.size > 0 && !allCtas.some((cta) => [...tokensOf(cta)].some((t) => offerTokens.has(t)))) {
    issues.push({
      check: 's6.cta_offer_unnamed',
      message: 'no CTA in the pack names the S4 lead offer or a stack offer — at least one must, so the page sells a real thing',
    });
  }

  // Website copy may only promise what the owner controls — the guarantee
  // section must not be worded stronger than S4's risk_reversal_options.
  const guaranteeSubjects = [...out.home.sections, ...out.sales_page.sections]
    .filter((s) => s.id.trim().toLowerCase() === 'guarantee')
    .flatMap((s) => [s.head, s.body, s.cta ?? '']);
  for (const subject of [...allCtas, ...guaranteeSubjects]) {
    for (const re of OUTCOME_PROMISE_PATTERNS) {
      if (re.test(subject)) {
        issues.push({
          check: 's6.outcome_promised',
          message: `"${subject.slice(0, 70)}…" promises a business outcome — copy may only promise what the owner controls (redo, refund, extra work), never results, revenue or growth`,
        });
        break;
      }
    }
  }

  // Voice-bearing copy: H3 never-words bind. stripQuotedText is safe only
  // because quote provenance is separately FATAL above.
  issues.push(...scanBannedPhrases(output, intake, { includeCustomerWords: true, stripQuotedText: true }));
  return issues;
}

// ─── S7 · Email pack ────────────────────────────────────────────────────────

export const S7_INPUT_FIELDS = ['F2', 'A1'];

export const S7_HOOK_CATEGORIES = [
  'direct_benefit', 'open_loop', 'deal_announcement', 'deadline', 'personal_voice',
  'results_evidence', 'story_tease', 'how_to', 'direct_command', 'reflective_question',
] as const;

const S7_CTA_VERBS = /^(get|claim|book|start|download|reply|read|watch|join|see|try|call|text|visit|save|send|grab|pick|choose|tell)\b/i;

/** Strong staleness signals force 'cold'; shorter gaps are the model's call. */
const S7_F2_STALE = /\bnever\b|\byears?\b|\blast year\b|\b(?:[6-9]|1[0-9]|2[0-9]|3[0-6])\s*months?\b/i;

interface S7Email {
  subject_variants: Array<{ subject: string; hook_category: string }>;
  preview: string;
  body: string;
  cta: string;
}

interface S7Output {
  welcome_seq: S7Email[];
  promo_seq: S7Email[];
  list_warmup_note: { list_status: string; note: string; reintro_email: S7Email | null };
}

export function qaS7(output: unknown, intake: Intake, prior: Record<string, unknown>): QAIssue[] {
  const issues: QAIssue[] = [];
  const out = output as S7Output;
  const s3 = prior.S3 as S3Output | undefined;

  const emails: Array<[string, S7Email]> = [
    ...out.welcome_seq.map((e, i) => [`welcome_seq[${i}]`, e] as [string, S7Email]),
    ...out.promo_seq.map((e, i) => [`promo_seq[${i}]`, e] as [string, S7Email]),
    ...(out.list_warmup_note.reintro_email ? [['list_warmup_note.reintro_email', out.list_warmup_note.reintro_email] as [string, S7Email]] : []),
  ];

  for (const [where, email] of emails) {
    // Three subject lines must be three genuinely different ways in.
    if (new Set(email.subject_variants.map((v) => v.hook_category)).size !== email.subject_variants.length) {
      issues.push({
        check: 's7.hook_categories_not_distinct',
        message: `${where}: the 3 subject_variants must use 3 DIFFERENT hook categories`,
      });
    }

    // Exactly one {{link}} in the body is the mechanical definition of "one CTA per email".
    const linkCount = email.body.split('{{link}}').length - 1;
    if (linkCount === 0) {
      issues.push({ check: 's7.cta_count', message: `${where}: body has no {{link}} token — every email carries exactly one CTA link` });
    } else if (linkCount >= 2) {
      issues.push({ check: 's7.cta_count', message: `${where}: body has ${linkCount} {{link}} tokens — one CTA per email, exactly` });
    }
    for (const [field, text] of [['preview', email.preview], ['cta', email.cta], ...email.subject_variants.map((v, i) => [`subject_variants[${i}]`, v.subject])] as Array<[string, string]>) {
      if (text.includes('{{link}}')) {
        issues.push({ check: 's7.cta_count', message: `${where}.${field}: {{link}} belongs in the body only` });
      }
    }

    if (!S7_CTA_VERBS.test(email.cta.trim())) {
      issues.push({
        check: 's7.cta_not_verb_first',
        message: `${where}: cta "${email.cta}" must start with an action verb (get, claim, book, start, download, reply, read, watch, join, see, try, call, text, visit, save, send, grab, pick, choose, tell)`,
      });
    }

    if (!email.body.includes('{{first_name}}')) {
      issues.push({ check: 's7.personalization_missing', message: `${where}: body must address the reader with {{first_name}} at least once` });
    }

    const previewNorm = normalizeText(email.preview).toLowerCase();
    for (const v of email.subject_variants) {
      if (previewNorm === normalizeText(v.subject).toLowerCase()) {
        issues.push({ check: 's7.preview_repeats_subject', message: `${where}: preview repeats a subject line — it must complement, not repeat` });
        break;
      }
    }
  }

  // No literal URLs (links live behind {{link}}); no merge tokens the
  // customer's email tool will never fill.
  for (const [path, text] of walkStrings(output, '')) {
    if (/https?:\/\/|\bwww\./i.test(text)) {
      issues.push({ check: 's7.url_or_unknown_token', message: `${path}: literal URL found — links must live behind {{link}}` });
    }
    for (const m of text.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)) {
      const token = (m[1] ?? '').toLowerCase();
      if (token !== 'first_name' && token !== 'link') {
        issues.push({ check: 's7.url_or_unknown_token', message: `${path}: unknown merge token {{${m[1]}}} — only {{first_name}} and {{link}} exist` });
      }
    }
  }

  // Warm-up consistency: a cold list must get the re-introduction email; a
  // warm or absent list must not.
  const { list_status, reintro_email } = out.list_warmup_note;
  if (list_status === 'cold' && !reintro_email) {
    issues.push({ check: 's7.warmup_inconsistent', message: 'list_status is "cold" but reintro_email is null — a cold list needs the warm-up re-introduction email' });
  }
  if (list_status !== 'cold' && reintro_email) {
    issues.push({ check: 's7.warmup_inconsistent', message: `list_status is "${list_status}" but a reintro_email is present — the warm-up email exists only for cold lists` });
  }
  const f2 = normalizeText(fieldAsString(intake.F2));
  // "none" is legitimate when the owner has no list — including when F2 is a
  // sentence SAYING there's no list ("no list, keep meaning to collect emails").
  // Only positive subscriber evidence (a count, "subscribers", "I email…")
  // contradicts a "none".
  const f2NoList = /\bno (?:list|email list|mailing list)\b|\bnever (?:got|get) round\b|\bdon'?t have (?:a|an|any)\b|\bhaven'?t (?:got|started|built)\b/i.test(f2);
  const f2HasSubscribers = /\b\d[\d,]*\s*(?:subscribers?|people|contacts?)\b|\bsubscribers?\b|\bi email\b|\bemail (?:most|them|the list|every|out)\b/i.test(f2);
  if (f2.length === 0) {
    if (list_status !== 'none') {
      issues.push({ check: 's7.warmup_status_vs_f2', message: `F2 is empty but list_status is "${list_status}" — with no list, the status is "none"` });
    }
  } else if (list_status === 'none') {
    if (f2HasSubscribers && !f2NoList) {
      issues.push({ check: 's7.warmup_status_vs_f2', message: 'F2 describes an actual list (subscribers) but list_status is "none" — read F2 again' });
    }
  } else if (S7_F2_STALE.test(f2) && list_status !== 'cold') {
    issues.push({ check: 's7.warmup_status_vs_f2', message: `F2 shows strong staleness signals but list_status is "${list_status}" — a list like that is cold` });
  }

  // S3's banned list may contain voice-specific additions beyond global+H3 —
  // S7 copy must obey the whole list (dedup against the scans below).
  const alreadyCovered = new Set([
    ...GLOBAL_BANNED_PHRASES.map((p) => p.toLowerCase()),
    ...customerNeverWords(intake),
  ]);
  const s3Extra = (s3?.voice.banned_words ?? [])
    .map((w) => normalizeText(w).toLowerCase())
    .filter((w) => w.length > 1 && !alreadyCovered.has(w));
  for (const phrase of s3Extra) {
    const re = phraseRegex(phrase);
    for (const [path, text] of walkStrings(output, '')) {
      if (re.test(stripQuoted(normalizeText(text)))) {
        issues.push({ check: 's7.s3_banned_word', message: `S3 voice.banned_words entry "${phrase}" found at ${path} — the voice guide binds every email` });
      }
    }
  }

  // NO-INVENTION (FATAL): every long quoted span must be copied from what the
  // prior stages or the consumed intake actually said — the inverse of
  // findVerbatimSpan: ALL long spans must match, not at least one.
  // The haystack includes the RAW consumed C2 (customer reviews) as well as
  // S2's curated verbatims subset, so an email honestly quoting a real review
  // S2 happened not to pick isn't parked as fabricated. Case-insensitive: a
  // sentence-cased real quote is genuine.
  const s7Hay = [
    ...['S2', 'S3', 'S4'].flatMap((id) => stageStringLeaves(prior[id])),
    f2,
    normalizeText(fieldAsString(intake.A1)),
    normalizeText(fieldAsString(intake.C2)),
  ].filter(Boolean);
  const s7HayLC = s7Hay.map((h) => h.toLowerCase());
  for (const [path, text] of walkStrings(output, '')) {
    for (const span of extractQuotedSpans(text)) {
      const norm = normalizeText(span);
      if (norm.length < MIN_QUOTE_CHARS) continue;
      if (!quoteTracesTo(span, s7HayLC)) {
        issues.push({
          check: 's7.invented_quote',
          message: `quoted passage at ${path} ("${norm.slice(0, 60)}…") is not copied from S2/S3/S4, F2, A1 or the customer reviews (C2) — a fabricated testimonial or quote parks the run`,
          fatal: true,
        });
      }
    }
  }

  // NO-INVENTION (FATAL): a figure must be a real number the customer stated,
  // a number a prior stage produced (S4 offer prices restated in the promo),
  // or visible arithmetic over those. Percentages are stricter — %-style stats
  // are the classic fabricated proof in email, so EVERY percentage must echo.
  const s7Numbers = new Set<number>([
    ...allIntakeNumbers(intake),
    ...['S2', 'S3', 'S4'].flatMap((id) => numericLeaves(prior[id])),
    ...intakeNumberSet(s7Hay),
  ]);
  for (const [path, text] of walkStrings(output, '')) {
    for (const value of inventedNumbers(text, 0, 0, s7Numbers, s7Numbers, { allowYear: false })) {
      issues.push({
        check: 's7.invented_number',
        message: `${path} contains the figure ${value.toLocaleString('en-GB')}, which is no real intake/prior number nor visible arithmetic — invented stats, counts or discounts park the run`,
        fatal: true,
      });
    }
    for (const n of extractNumbers(normalizeText(text))) {
      if (n.percent && n.value !== 100 && !s7Numbers.has(n.value)) {
        issues.push({
          check: 's7.invented_percentage',
          message: `${path} contains ${n.value}%, which does not appear in any input — every percentage in email copy must be a literal echo`,
          fatal: true,
        });
      }
    }
  }

  // Voice-bearing copy stage: H3 never-words bind; quoted spans exempt (their
  // provenance is separately FATAL above).
  issues.push(...scanBannedPhrases(output, intake, { includeCustomerWords: true, stripQuotedText: true }));
  return issues;
}

// ─── S8 · 30 days of social content ─────────────────────────────────────────

export const S8_INPUT_FIELDS = ['C2', 'F5'];

export const S8_PLATFORMS = [
  'Facebook', 'Instagram', 'LinkedIn', 'TikTok', 'X', 'YouTube Shorts', 'Google Business Profile',
] as const;

export const S8_PILLARS = ['teach', 'proof', 'inside look', 'conversation', 'offer'] as const;

/**
 * Per-platform format pairing (own-IP taxonomy). The schema's flat enum
 * rejects unknown strings structurally; this map enforces the pairing.
 * Keys are normalizeText+lowercase platform names.
 */
export const S8_PLATFORM_FORMATS: Record<string, string[]> = {
  'facebook': ['text post', 'photo post', 'carousel', 'short video', 'story', 'poll'],
  'instagram': ['reel', 'carousel', 'single image', 'story'],
  'linkedin': ['text post', 'document carousel', 'native video', 'poll'],
  'tiktok': ['talking-head video', 'how-to video', 'before-after video', 'day-in-the-life video', 'reply video'],
  'x': ['single post', 'thread', 'image post', 'poll'],
  'youtube shorts': ['talking-head short', 'how-to short', 'before-after short', 'voiceover demo short'],
  'google business profile': ['update post', 'offer post', 'event post', 'photo post'],
};

export const S8_FORMATS = [...new Set(Object.values(S8_PLATFORM_FORMATS).flat())];

interface S8Post {
  day: number;
  platform: string;
  format: string;
  hook: string;
  body: string;
  cta: string;
  pillar: string;
}

interface S8Output {
  platform_a: string;
  platform_b: string;
  posts: S8Post[];
}

/**
 * Platforms compare by direct normalized string equality against F5 values —
 * NOT channelMatchesC7: the alias table rewrites the token "x" to "twitter",
 * and single-letter platforms make token-subset matching unsafe. F5 options
 * are a closed enum, so exact match is correct.
 */
function normPlatform(s: string): string {
  return normalizeText(s).toLowerCase().trim();
}

export function qaS8(output: unknown, intake: Intake, prior: Record<string, unknown>): QAIssue[] {
  const issues: QAIssue[] = [];
  const out = output as S8Output;
  const f5 = (Array.isArray(intake.F5) ? (intake.F5 as string[]) : []).map(normPlatform);
  const f5Set = new Set(f5);
  const outSet = new Set([normPlatform(out.platform_a), normPlatform(out.platform_b)]);

  // Deduped set comparison makes the single-pick case work: F5=["Instagram"]
  // passes only when platform_a === platform_b === "Instagram".
  if (f5Set.size > 0 && (outSet.size !== f5Set.size || ![...outSet].every((p) => f5Set.has(p)))) {
    issues.push({
      check: 's8.platforms_match_f5',
      message: `platform_a/platform_b (${out.platform_a}, ${out.platform_b}) must be exactly the customer's F5 picks (${(intake.F5 as string[]).join(', ')})`,
    });
  }

  for (const post of out.posts) {
    if (!outSet.has(normPlatform(post.platform))) {
      issues.push({
        check: 's8.post_platform_invalid',
        message: `day ${post.day}: platform "${post.platform}" is not one of the pack's two declared platforms`,
      });
    }
  }

  // With two picks, neither platform gets starved.
  if (f5Set.size === 2) {
    for (const p of f5Set) {
      const count = out.posts.filter((post) => normPlatform(post.platform) === p).length;
      if (count < 12) {
        issues.push({
          check: 's8.platform_split_unbalanced',
          message: `only ${count} of 30 posts target "${p}" — each chosen platform gets at least 12`,
        });
      }
    }
  }

  // Days 1..30, each exactly once (catches duplicates, gaps, out-of-range).
  const days = out.posts.map((p) => p.day);
  const expected = Array.from({ length: 30 }, (_, i) => i + 1).join(',');
  if (days.length !== 30 || [...days].sort((a, b) => a - b).join(',') !== expected) {
    issues.push({ check: 's8.days_incomplete', message: 'posts must cover days 1–30, one post per day, no gaps or duplicates' });
  }

  for (const post of out.posts) {
    const allowed = S8_PLATFORM_FORMATS[normPlatform(post.platform)] ?? [];
    if (!allowed.includes(normalizeText(post.format).toLowerCase())) {
      issues.push({
        check: 's8.format_invalid_for_platform',
        message: `day ${post.day}: format "${post.format}" is not native to ${post.platform} (allowed: ${allowed.join(', ')})`,
      });
    }
  }

  // Five lanes, all fed, none dominating; the selling lane is capped.
  const pillarCounts = new Map<string, number>();
  for (const post of out.posts) pillarCounts.set(post.pillar, (pillarCounts.get(post.pillar) ?? 0) + 1);
  for (const pillar of S8_PILLARS) {
    const count = pillarCounts.get(pillar) ?? 0;
    if (count < 4) {
      issues.push({ check: 's8.pillar_distribution', message: `pillar "${pillar}" has ${count} of 30 posts — every lane needs at least 4` });
    }
    if (count > 9) {
      issues.push({ check: 's8.pillar_distribution', message: `pillar "${pillar}" has ${count} of 30 posts — no lane above 9 (30%)` });
    }
  }
  if ((pillarCounts.get('offer') ?? 0) > 6) {
    issues.push({ check: 's8.pillar_distribution', message: `pillar "offer" has ${pillarCounts.get('offer')} of 30 posts — the selling lane caps at 6 (20%)` });
  }

  // ≥4 posts built directly on the customer's C2 words (≥3 distinct spans);
  // every proof post carries them.
  const c2 = normalizeText(fieldAsString(intake.C2));
  const matchedSpans: string[] = [];
  let postsWithSpan = 0;
  for (const post of out.posts) {
    const span = findVerbatimSpan(`${post.hook}\n${post.body}`, [c2]);
    if (span !== null) {
      postsWithSpan++;
      matchedSpans.push(span);
    } else if (post.pillar === 'proof') {
      issues.push({
        check: 's8.c2_verbatim_posts',
        message: `day ${post.day} is a "proof" post but carries no double-quoted exact C2 customer words — proof posts quote the customer, character-for-character`,
      });
    }
  }
  if (postsWithSpan < 4) {
    issues.push({ check: 's8.c2_verbatim_posts', message: `only ${postsWithSpan} posts quote the customer's C2 words — at least 4 posts must be built directly on them` });
  }
  if (new Set(matchedSpans).size < 3) {
    issues.push({ check: 's8.c2_verbatim_posts', message: `the month reuses ${new Set(matchedSpans).size} distinct C2 quote(s) — use at least 3 different customer quotes` });
  }

  // NO-INVENTION (FATAL): quoted spans must come from C2 or a prior stage
  // (S3's banned_words leaves excluded so a banned phrase quoted verbatim
  // cannot launder itself in as "sourced").
  // Case-insensitive: sentence-casing a real C2 line ("Mate," vs source
  // "mate") is genuine, not a fabricated testimonial.
  const s8Hay = [c2, ...stageStringLeaves(prior.S2), ...stageStringLeaves(prior.S3, ['voice.banned_words']), ...stageStringLeaves(prior.S5)].filter(Boolean);
  const s8HayLC = s8Hay.map((h) => h.toLowerCase());
  for (const post of out.posts) {
    for (const [field, text] of [['hook', post.hook], ['body', post.body], ['cta', post.cta]] as Array<[string, string]>) {
      for (const span of extractQuotedSpans(text)) {
        const norm = normalizeText(span);
        if (norm.length < MIN_QUOTE_CHARS) continue;
        if (!quoteTracesTo(span, s8HayLC)) {
          issues.push({
            check: 's8.invented_quote',
            message: `day ${post.day} ${field}: quoted passage ("${norm.slice(0, 50)}…") is not a substring of C2 or a prior-stage document — a fabricated testimonial parks the run`,
            fatal: true,
          });
        }
      }
    }
  }

  // NO-INVENTION (FATAL): no fabricated stats, prices, results or follower
  // counts. Real numbers the customer stated anywhere, prior-stage figures and
  // physical measurements ("45cm chest", "100 amp") pass; a bare invented
  // "£4,500 saved" parks.
  const s8Numbers = new Set<number>([
    ...allIntakeNumbers(intake),
    ...['S2', 'S3', 'S5'].flatMap((id) => numericLeaves(prior[id])),
    ...intakeNumberSet(s8Hay),
  ]);
  for (const post of out.posts) {
    for (const value of inventedNumbers(`${post.hook} ${post.body} ${post.cta}`, 0, 0, s8Numbers, s8Numbers, { allowYear: false })) {
      issues.push({
        check: 's8.invented_numbers',
        message: `day ${post.day} contains the figure ${value.toLocaleString('en-GB')}, which appears nowhere in the intake or prior stages — fabricated stats park the run`,
        fatal: true,
      });
    }
  }

  // Voice-bound copy stage (S3+): H3 never-words apply; quoted C2 material exempt.
  issues.push(...scanBannedPhrases(output, intake, { includeCustomerWords: true, stripQuotedText: true }));
  return issues;
}

// ─── S9 · One-page business plan ────────────────────────────────────────────

export const S9_INPUT_FIELDS = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'G1'];

export const S9_TABLE_SOURCES = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'G1', 'S1', 'S2', 'S3', 'S4', 'S5'] as const;

/** Forward-horizon markers beyond the 90-day plan (spec: no projections past 90 days). */
const S9_HORIZON_SPAN = /\b(?:next|within|over|coming|in)\s+(?:the\s+)?(\d+)\s*(day|week|month|year)s?\b/gi;
const S9_ANNUALISATION = /\b(?:annual(?:ly|ised|ized)?|per\s+(?:year|annum)|year[\s-]?(?:one|1|two|2)\b|year-on-year|12[\s-]months?|six[\s-]months?|6[\s-]months?)\b/i;
const S9_UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
const S9_MAX_HORIZON_DAYS = 92; // "next 90 days" and "next 3 months" pass; "4 months" and "1 year" fail

interface S9Row {
  label: string;
  value: string;
  source: string;
}

interface S9Output {
  snapshot: string;
  market: string;
  offer: string;
  goals_90d: string;
  plan_summary: string;
  numbers_table: S9Row[];
}

export function qaS9(output: unknown, intake: Intake, prior: Record<string, unknown>): QAIssue[] {
  const issues: QAIssue[] = [];
  const out = output as S9Output;

  const resolveSource = (source: string): string => {
    if (/^(B[1-6]|G1)$/.test(source)) return normalizeText(fieldAsString(intake[source]));
    if (/^S[1-5]$/.test(source)) return normalizeText(fieldAsString(prior[source]));
    return '';
  };
  const normLoose = (s: string) => normalizeText(s).toLowerCase();

  // Every number the customer stated anywhere + every number a prior stage
  // produced. This is the fabrication backstop for both the table and the
  // prose: a figure in this union is a real fact, never a fabrication.
  const unionNumbers = new Set<number>([
    ...allIntakeNumbers(intake),
    ...['S1', 'S2', 'S3', 'S4', 'S5'].flatMap((s) => numericLeaves(prior[s])),
    ...['S1', 'S2', 'S3', 'S4', 'S5'].flatMap((s) => [...intakeNumberSet([normalizeText(fieldAsString(prior[s]))])]),
  ]);

  // NO-INVENTION (FATAL): every table figure must appear in its declared
  // source (extractNumbers normalizes commas/currency/k/band-shorthand). A
  // row that honestly carries both target and baseline ("25% (up from 11%)")
  // traces to the union of real numbers rather than the single named source.
  for (const row of out.numbers_table) {
    const sourceText = resolveSource(row.source);
    const rowNums = extractNumbers(row.value);
    if (rowNums.length > 0) {
      const srcNums = new Set(extractNumbers(sourceText).map((n) => n.value));
      for (const n of rowNums) {
        if (!srcNums.has(n.value) && !unionNumbers.has(n.value)) {
          issues.push({
            check: 's9.table_number_untraced',
            message: `numbers_table row "${row.label}": value "${row.value}" contains ${n.value.toLocaleString('en-GB')}, which appears in neither the declared source ${row.source} nor anywhere else in the intake or prior stages — every figure must trace to a real source`,
            fatal: true,
          });
        }
      }
    } else if (!normLoose(sourceText).includes(normLoose(row.value))) {
      // …and a sourced value with no figure must still be an exact echo.
      issues.push({
        check: 's9.table_value_not_echo',
        message: `numbers_table row "${row.label}": value "${row.value}" is not an echo of the declared source ${row.source}`,
        fatal: true,
      });
    }
  }

  // NO-INVENTION (FATAL): prose figures trace to a real intake/stage number or
  // show visible B2/B3 arithmetic; small counts, periods, years pass.
  const b2 = intakeNumber(intake, 'B2');
  const b3 = intakeNumber(intake, 'B3');
  const proseSections: Array<[string, string]> = [
    ['snapshot', out.snapshot],
    ['market', out.market],
    ['offer', out.offer],
    ['goals_90d', out.goals_90d],
    ['plan_summary', out.plan_summary],
  ];
  for (const [section, text] of proseSections) {
    for (const value of inventedNumbers(text, b2, b3, unionNumbers, unionNumbers)) {
      issues.push({
        check: 's9.number_invented',
        message: `${section} contains the figure ${value.toLocaleString('en-GB')}, which traces to no intake field or stage output and shows no arithmetic — remove it or show the derivation`,
        fatal: true,
      });
    }
  }

  // No projections beyond 90 days — spans and annualisation markers.
  for (const [path, text] of walkStrings(output, '')) {
    const subject = stripQuoted(normalizeText(text));
    for (const m of subject.matchAll(S9_HORIZON_SPAN)) {
      const daysSpan = Number(m[1]) * (S9_UNIT_DAYS[(m[2] ?? '').toLowerCase()] ?? 0);
      if (daysSpan > S9_MAX_HORIZON_DAYS) {
        issues.push({
          check: 's9.horizon_exceeded',
          message: `${path}: "${m[0]}" projects beyond the 90-day plan — this page plans 90 days, nothing further`,
        });
      }
    }
    if (S9_ANNUALISATION.test(subject)) {
      issues.push({
        check: 's9.horizon_exceeded',
        message: `${path}: annualisation language found — projections beyond 90 days don't belong on this page`,
      });
    }
  }

  // The table must anchor on the two commercial constants and at least one
  // stage-sourced figure.
  const sources = new Set(out.numbers_table.map((r) => r.source));
  if (!sources.has('B2')) {
    issues.push({ check: 's9.table_missing_anchors', message: 'numbers_table must include a row sourced from B2 (average sale value)' });
  }
  if (!sources.has('B3')) {
    issues.push({ check: 's9.table_missing_anchors', message: 'numbers_table must include a row sourced from B3 (new customers per month)' });
  }
  if (![...sources].some((s) => /^S[1-5]$/.test(s))) {
    issues.push({ check: 's9.table_missing_anchors', message: 'numbers_table must include at least one stage-sourced figure (typically the S5 goal or an S4 price)' });
  }

  // goals_90d restates the owner's own goal, with a number (mirror of S5's
  // rule). A digit OR a spelled-out numeral counts — coach's G1 spells them all
  // ("Sign two … to ten names"), so a faithful goal has no digit.
  const g1 = typeof intake.G1 === 'string' ? intake.G1 : '';
  const overlap = [...tokensOf(out.goals_90d)].filter((t) => tokensOf(g1).has(t)).length;
  if ((!/\d/.test(out.goals_90d) && !SPELLED_NUMBER_WORD.test(out.goals_90d)) || overlap < 1) {
    issues.push({
      check: 's9.goal_not_g1',
      message: `goals_90d must restate the owner's own goal (G1: "${g1}") and carry a number`,
    });
  }

  // One page means one page — cap reconciled with the prompt's per-section
  // word budgets, which sum to ~570.
  const totalWords = proseSections.reduce((n, [, text]) => n + wordCount(text), 0);
  if (totalWords > 575) {
    issues.push({ check: 's9.page_overflow', message: `the five prose sections total ${totalWords} words — the page caps at 575` });
  }

  // Bank-manager register: no exclamation marks in prose.
  for (const [section, text] of proseSections) {
    if (/!/.test(stripQuoted(text))) {
      issues.push({ check: 's9.exclamation_in_prose', message: `${section} contains an exclamation mark — this page reads like it was written for a bank manager` });
    }
  }

  // Global list only: S9's register is deliberately bank-manager, not brand
  // voice — H3 never-words bind the voice copy stages (S6–S8).
  issues.push(...scanBannedPhrases(output, intake, { includeCustomerWords: false, stripQuotedText: true }));
  return issues;
}
