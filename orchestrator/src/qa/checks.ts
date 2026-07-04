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
import { customerMustWords, customerNeverWords, GLOBAL_BANNED_PHRASES, phraseRegex, scanBannedPhrases } from './banned.js';

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

export function qaS3(output: unknown, intake: Intake): QAIssue[] {
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

const OUTCOME_PROMISE_PATTERNS = [
  /guarantee[ds]?\s+(?:\w+\s+){0,2}(results?|revenue|income|profits?|growth|sales|leads|customers|bookings|rankings?)/i,
  /\b(?:double|triple|quadruple|[0-9]+x)\s+your\b/i,
  /\byou(?:'ll| will)\s+(?:make|earn|get|gain|add)\b[^.]{0,40}[£$€]\s?\d/i,
  /\bresults?\s+(?:are\s+)?guaranteed\b/i,
];

export function qaS4(output: unknown, intake: Intake): QAIssue[] {
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

  for (const rr of out.risk_reversal_options) {
    for (const re of OUTCOME_PROMISE_PATTERNS) {
      if (re.test(rr)) {
        issues.push({
          check: 's4.risk_reversal_promises_outcome',
          message: `risk reversal "${rr.slice(0, 70)}…" promises a business outcome — risk reversals may only promise what the owner controls (redo, refund, extra work), never results`,
        });
        break;
      }
    }
  }

  issues.push(...scanBannedPhrases(output, intake, { includeCustomerWords: false, stripQuotedText: true }));
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

function tokensOf(s: string): Set<string> {
  return new Set(
    normalizeText(s)
      .toLowerCase()
      .split(/[^a-z0-9£]+/)
      .filter((t) => t.length > 3),
  );
}

export function qaS5(output: unknown, intake: Intake): QAIssue[] {
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
  for (const phase of out.phases) {
    for (const action of phase.actions) {
      const ct = tokensOf(action.channel);
      const clash = out.do_not_do.find((d) => [...tokensOf(d)].some((t) => ct.has(t)));
      if (clash) {
        issues.push({
          check: 's5.action_on_forbidden_channel',
          message: `action "${action.action.slice(0, 50)}…" uses channel "${action.channel}" which collides with the plan's own do_not_do entry "${clash.slice(0, 50)}…"`,
        });
      }
    }
  }

  // Channel priorities come from C7 (+ what F4 shows already works).
  const c7 = Array.isArray(intake.C7) ? (intake.C7 as string[]) : [];
  const provenText = tokensOf([intake.F4, intake.F1].map((v) => (Array.isArray(v) ? v.join(' ') : String(v ?? ''))).join(' '));
  for (const ch of out.channel_priorities) {
    const fromC7 = c7.length > 0 && c7.some((entry) => {
      const et = tokensOf(entry);
      const ct = tokensOf(ch);
      return [...ct].every((t) => et.has(t)) || [...et].every((t) => ct.has(t));
    });
    const fromProven = [...tokensOf(ch)].some((t) => provenText.has(t));
    if (!fromC7 && !fromProven) {
      issues.push({
        check: 's5.channel_priority_unsourced',
        message: `channel priority "${ch}" doesn't correspond to where the customers hang out (C7) or what has already worked (F4/F1) — priorities must come from those`,
      });
    }
  }

  issues.push(...scanBannedPhrases(output, intake, { includeCustomerWords: false, stripQuotedText: true }));
  return issues;
}
