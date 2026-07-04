/**
 * Deterministic mock model for mechanics testing ONLY (decisions.md D-008):
 * exercises schema validation, QA checks, retry-with-critique, parking and
 * manifests without an API key. Never a substitute for a real quality review.
 *
 * Failure injection: `failStages` produces an invalid first attempt for those
 * stages (missing key + invented verbatim) so the retry path runs;
 * `alwaysFailStages` keeps failing so the park path runs.
 */

import type { Intake } from '../types.js';
import { normalizeText } from '../util/text.js';
import { customerMustWords, customerNeverWords, GLOBAL_BANNED_PHRASES } from '../qa/banned.js';
import { G2_HOURS_CAP } from '../qa/checks.js';
import type { LlmClient, LlmRequest, LlmResponse } from './client.js';

function fieldText(intake: Intake, id: string): string {
  const v = intake[id];
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.join('\n');
  if (v && typeof v === 'object') return JSON.stringify(v);
  return '';
}

/** An exact (normalized) snippet of a field value, long enough for the evidence check. */
function snippet(intake: Intake, id: string, maxLen = 80): string {
  const norm = normalizeText(fieldText(intake, id));
  return norm.length <= maxLen ? norm : norm.slice(0, maxLen).replace(/\s+\S*$/, '');
}

function num(intake: Intake, id: string): number {
  const v = intake[id];
  const n = typeof v === 'string' ? Number(v.replace(/[£$,\s]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function mockS1(intake: Intake): unknown {
  const b2 = num(intake, 'B2');
  const b3 = num(intake, 'B3');
  const categories = ['visibility', 'message clarity', 'conversion path', 'follow-up', 'proof', 'offer strength'];
  // Evidence may only quote fields S1 actually consumes (A*, B*, E*, F1–F4).
  const evidenceFields = ['F1', 'A2', 'B4', 'F4', 'E3', 'E2'];
  return {
    scores: categories.map((category, i) => ({
      category,
      grade_1to10: 3 + (i % 4),
      evidence: `The intake states (${evidenceFields[i]}): "${snippet(intake, evidenceFields[i] as string)}" — which shows where ${category} stands today.`,
      leak_cost_estimate: `£${(2 * b2).toLocaleString('en-GB')}/mo (= 2 lost customers × £${b2.toLocaleString('en-GB')} average sale, baseline ${b3} new customers/mo)`,
    })),
    top_3_leaks: [
      `Follow-up gap: "${snippet(intake, 'F3', 60)}" cost real money with nothing captured for retargeting.`,
      `Reliance on one channel: "${snippet(intake, 'B4', 60)}" means growth stalls when referrals dip.`,
      `Losses they can name (E2): "${snippet(intake, 'E2', 60)}" — a positioning gap, not a price problem.`,
    ],
    quick_wins: [
      'Put the three strongest customer quotes on the homepage above the fold this week.',
      'Add a same-day reply autoresponse so no enquiry goes cold.',
      'Claim and complete the Google Business Profile with photos and services.',
    ],
    narrative_summary:
      `This is a solid business with real demand and a marketing engine running on one cylinder. Revenue today comes from "${snippet(intake, 'B4', 60)}", which is proof the work is good — and a warning, because none of it is systematised. The audit shows the biggest leaks are in follow-up and visible proof, both fixable inside a month without new spend.`,
  };
}

function mockS2(intake: Intake, breakVerbatims: boolean): unknown {
  const c2 = normalizeText(fieldText(intake, 'C2'));
  // Two exact substrings of C2 (the fact-echo requirement), from different regions.
  const v1 = c2.slice(0, Math.min(70, c2.length)).replace(/\s+\S*$/, '');
  const mid = Math.floor(c2.length / 2);
  const v2 = c2.slice(mid, Math.min(mid + 70, c2.length)).trim().replace(/\s+\S*$/, '');
  const verbatims = breakVerbatims
    ? ['This quote was never said by anyone and is not in C2 at all.']
    : [v1, v2].filter((v) => v.length >= 10);

  const exclusionsRaw = fieldText(intake, 'C6');
  const channels = Array.isArray(intake.C7) ? (intake.C7 as string[]) : ['Google search'];

  const base = {
    profile_narrative:
      `Meet the buyer behind this business. ${fieldText(intake, 'C1')} They live around ${fieldText(intake, 'A5')} and their moment of need looks like this: ${fieldText(intake, 'C4')} What they are really paying for: ${fieldText(intake, 'C3')}`,
    demographics: `Based in or near ${fieldText(intake, 'A5')}; typical spend around £${num(intake, 'B2').toLocaleString('en-GB')} per purchase.`,
    situation: fieldText(intake, 'C1'),
    trigger_events: [fieldText(intake, 'C4')],
    objections: fieldText(intake, 'C5').split(/[\n;]+/).map((s) => s.trim()).filter(Boolean),
    desires_surface: `A straightforward fix for the immediate problem they described: ${snippet(intake, 'C3', 60)}`,
    desires_deep: 'Confidence that this decision is the one they stop having to think about — reassurance more than the service itself.',
    verbatims,
    exclusions: exclusionsRaw.split(/[\n;]+/).map((s) => s.trim()).filter(Boolean),
    awareness_stage: 'problem aware',
    channels,
  };
  if (breakVerbatims) {
    // Also drop a required key so the schema validator has something to report.
    const { desires_deep: _omitted, ...rest } = base;
    return rest;
  }
  return base;
}

function mockS3(intake: Intake): unknown {
  const h1 = (intake.H1 ?? {}) as Record<string, number>;
  return {
    positioning_statement: `For the buyer described in the profile, ${fieldText(intake, 'A1')} is the one that does what it says (E3): "${snippet(intake, 'E3', 50)}".`,
    message_pillars: [
      `We show, not tell: "${snippet(intake, 'E3', 40)}" backs every claim.`,
      `We know exactly why people leave (E2): "${snippet(intake, 'E2', 40)}" — and answer it head-on.`,
      `The job underneath the job (C3): "${snippet(intake, 'C3', 40)}" is what we actually sell.`,
    ],
    differentiators: [
      `Their own words (E3): "${snippet(intake, 'E3', 50)}" — that is the wedge.`,
      `Where rivals win (E2): "${snippet(intake, 'E2', 50)}" — we flip that weakness into the pitch.`,
    ],
    value_props: [
      `The problem handled by someone who explains it plainly: "${snippet(intake, 'C3', 30)}".`,
      'One point of contact from first call to finished job.',
      'A clear price before work starts, held afterwards.',
    ],
    voice: {
      sliders: {
        formal_casual: h1.formal_casual ?? 3,
        playful_straight: h1.playful_straight ?? 3,
        bold_understated: h1.bold_understated ?? 3,
      },
      tone_rules: [
        'Short sentences. One idea per sentence.',
        'Say the price plainly; never apologise for it.',
        'Write like the C2 reviews sound — concrete, first-person, no adjectives doing the work of evidence.',
      ],
      banned_words: [...GLOBAL_BANNED_PHRASES, ...customerNeverWords(intake)],
      must_words: customerMustWords(intake),
    },
    elevator_pitch: `${fieldText(intake, 'A1')} sorts the real problem, shows the proof, and makes the next step obvious.`,
  };
}

function mockS4(intake: Intake): unknown {
  const b2 = Math.max(num(intake, 'B2'), 1);
  return {
    current_stack_read: `What they sell today (D1): "${snippet(intake, 'D1', 60)}" — while the profit actually sits with (D2): "${snippet(intake, 'D2', 40)}". The stack below leans into that.`,
    recommended_stack: [
      {
        name: 'Entry: the front-door job',
        price: Math.max(Math.round(b2 * 0.4), 1),
        role: 'entry',
        rationale: `Opens the relationship on what already gets bought first (D2): "${snippet(intake, 'D2', 40)}".`,
      },
      {
        name: 'Core: the main engagement',
        price: b2,
        role: 'core',
        rationale: `Their stated line-up (D1): "${snippet(intake, 'D1', 40)}" priced at today's average sale.`,
      },
    ],
    lead_offer: `Lead with the entry offer — it matches how buyers arrive and what they already ask for (D2): "${snippet(intake, 'D2', 30)}".`,
    pricing_moves: [`Name the core offer properly and anchor it against the premium option (D1): "${snippet(intake, 'D1', 30)}".`],
    risk_reversal_options: [
      'If the work is not right, we come back and put it right at no extra charge until it is.',
      'A written scope before any money changes hands; miss the agreed scope and the difference is refunded.',
    ],
    category_note: 'Framed as a specialist fix for the problem underneath, not a line-item commodity to be price-shopped.',
  };
}

function mockS5(intake: Intake): unknown {
  const g2 = typeof intake.G2 === 'string' ? intake.G2 : '';
  const cap = G2_HOURS_CAP[g2] ?? 5;
  const c7 = Array.isArray(intake.C7) ? (intake.C7 as string[]) : ['Google search'];
  const channels = c7.slice(0, 2);
  const goal = snippet(intake, 'G1', 40);
  const b3 = num(intake, 'B3');
  const phase = (days: string, theme: string) => ({
    days,
    theme,
    actions: channels.map((channel) => ({
      action: `One concrete, finishable task on ${channel} that moves the goal this week.`,
      hours: 1,
      channel,
      depends_on: '',
    })),
  });
  return {
    north_star: `Goal as written (G1): "${goal}" — from a baseline of ${b3} new customers a month.`,
    phases: [
      phase('Days 1–30', `Plug the audit's leaks so "${goal}" becomes reachable.`),
      phase('Days 31–90', `Double down on what already works toward "${goal}".`),
    ],
    channel_priorities: channels,
    do_not_do: ['No spending on new advertising experiments until the leaks named in the audit are fixed.'],
    weekly_hours_total: Math.min(cap, 2),
  };
}

export class MockClient implements LlmClient {
  readonly mode = 'mock' as const;

  constructor(
    private readonly intake: Intake,
    private readonly opts: { failStages?: string[]; alwaysFailStages?: string[] } = {},
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const stage = req.meta?.stage ?? 'S?';
    const attempt = req.meta?.attempt ?? 1;
    const shouldFail =
      (this.opts.alwaysFailStages ?? []).includes(stage) ||
      ((this.opts.failStages ?? []).includes(stage) && attempt === 1);

    let payload: unknown;
    if (stage === 'S1') payload = mockS1(this.intake);
    else if (stage === 'S2') payload = mockS2(this.intake, shouldFail);
    else if (stage === 'S3') payload = mockS3(this.intake);
    else if (stage === 'S4') payload = mockS4(this.intake);
    else if (stage === 'S5') payload = mockS5(this.intake);
    else throw new Error(`MockClient: no generator for stage ${stage}`);

    if (shouldFail && stage !== 'S1' && stage !== 'S2') {
      // Generic failure injection for later stages: drop the first key.
      const broken = { ...(payload as Record<string, unknown>) };
      delete broken[Object.keys(broken)[0] as string];
      payload = broken;
    }

    if (stage === 'S1' && shouldFail) {
      const broken = JSON.parse(JSON.stringify(payload)) as { scores: Array<Record<string, unknown>> };
      // Invented number + no verbatim quote → both S1 QA checks fire.
      broken.scores[0] = {
        ...broken.scores[0],
        evidence: 'The business clearly has visibility problems in its market.',
        leak_cost_estimate: '£123,456/mo based on industry benchmarks',
      };
      payload = broken;
    }

    const text = '```json\n' + JSON.stringify(payload, null, 2) + '\n```';
    return {
      text,
      tokensIn: Math.round(req.system.length / 4 + req.messages.reduce((n, m) => n + m.content.length, 0) / 4),
      tokensOut: Math.round(text.length / 4),
      stopReason: 'end_turn',
      model: 'mock',
    };
  }
}
