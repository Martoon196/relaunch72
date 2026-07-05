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
    positioning_statement: `For the buyer described in the profile, ${fieldText(intake, 'A1')} is the one that does what it says (E3): "${snippet(intake, 'E3', 50)}" — not the usual alternative buyers settle for.`,
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
        'Sounds like the owner explaining the work across the counter, not a corporate brochure.',
      ],
      banned_words: [...GLOBAL_BANNED_PHRASES, ...customerNeverWords(intake)],
      must_words: customerMustWords(intake),
    },
    elevator_pitch: `${fieldText(intake, 'A1')} sorts the real problem, shows the proof, and makes the next step obvious.`,
  };
}

const MOCK_ENTRY_NAME = 'Entry: the front-door job';
const MOCK_CORE_NAME = 'Core: the main engagement';

function mockS4(intake: Intake): unknown {
  const b2 = Math.max(num(intake, 'B2'), 2);
  return {
    current_stack_read: `What they sell today (D1): "${snippet(intake, 'D1', 60)}" — while the profit actually sits with (D2): "${snippet(intake, 'D2', 40)}". The stack below leans into that.`,
    recommended_stack: [
      {
        name: MOCK_ENTRY_NAME,
        price: Math.max(Math.round(b2 * 0.4), 1),
        role: 'entry',
        rationale: `Opens the relationship on what already gets bought first (D2): "${snippet(intake, 'D2', 40)}".`,
      },
      {
        name: MOCK_CORE_NAME,
        price: b2,
        role: 'core',
        rationale: `Their stated line-up (D1): "${snippet(intake, 'D1', 40)}" priced at today's average sale.`,
      },
    ],
    lead_offer: `Lead with "${MOCK_ENTRY_NAME}" — it matches how buyers arrive and what they already ask for (D2): "${snippet(intake, 'D2', 30)}".`,
    pricing_moves: [
      `Name the core offer properly and anchor it against the premium option (D1): "${snippet(intake, 'D1', 30)}".`,
      'Take a small deposit at booking with the balance due on completion, in line with the average sale (B2).',
    ],
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

// ─── S6–S9: copy stages. Mock copy quotes ONLY provable inputs (S2 verbatims,
// consumed intake fields, C2) — the cross-stage no-invention checks are
// exercised for real, not bypassed.

/** The same S2 verbatims the mock pipeline produced — S6 quotes them. */
function mockS2Verbatims(intake: Intake): string[] {
  const s2 = mockS2(intake, false) as { verbatims: string[] };
  return s2.verbatims;
}

function mockS6(intake: Intake): unknown {
  const v = mockS2Verbatims(intake);
  const q = (i: number) => `"${v[i % v.length]}"`;
  const offer = MOCK_ENTRY_NAME;
  const a1 = fieldText(intake, 'A1');
  return {
    home: {
      hero_variants: [
        {
          angle: 'problem-first',
          headline: 'Stop patching the same problem and get it handled properly',
          subhead: 'The work agreed in writing, priced before it starts, and explained in plain terms from the first call.',
          cta: 'Ask for a fixed written quote',
        },
        {
          angle: 'evidence-first',
          headline: 'The work speaks for itself, in real customer words',
          subhead: `Straight from a customer: ${q(0)} — that is the standard every job is held to.`,
          cta: 'See what customers actually say',
        },
      ],
      sections: [
        {
          id: 'benefits',
          head: 'What you get',
          body: `The work done properly, explained without jargon, and priced in writing before anything starts. One customer put it like this: ${q(0)} — nothing polished, just how it went.`,
          cta: 'Ask for a plain-terms quote today',
        },
        {
          id: 'proof',
          head: 'What customers say',
          body: `${q(0)} ${q(1)} Real customers, quoted word for word — nothing paraphrased, nothing invented.`,
        },
        {
          id: 'objections',
          head: 'Wondering if it is worth it',
          body: 'Fair question. The price is agreed up front, the scope goes in writing, and if something is not right it gets put right. No surprises, no pressure, and no decision needed today.',
          cta: 'Get your questions answered first',
        },
        {
          id: 'next-steps',
          head: 'How it works',
          body: 'Three steps: get in touch, agree the scope and the price in writing, then the work is scheduled for a time that suits. Nothing starts until you have said yes to both.',
        },
      ],
    },
    about: {
      head: 'Who you are dealing with',
      body:
        `${a1} is a working business serving ${fieldText(intake, 'A5')}. In the owner's words: "${snippet(intake, 'E3', 60)}". ` +
        'The promise is straightforward: do the work properly, explain it in plain terms, and stand behind it afterwards. ' +
        'No scripts and no runaround — the person you speak to is the person responsible for the work being right. ' +
        'If anything is unclear, ask; questions get straight answers before any money changes hands.',
    },
    sales_page: {
      head: 'A straightforward way to get this sorted',
      subhead: 'What it costs, what you get, and what happens if it is not right.',
      sections: [
        {
          id: 'problem',
          head: 'The situation',
          body: 'Things have drifted: the last attempt did not stick, the problem keeps coming back, and every month it waits costs time and patience. It does not need another quick patch — it needs doing properly once.',
        },
        {
          id: 'offer',
          head: 'What is on the table',
          body: `The way in is the ${offer} — the lowest-friction way to see how this business works. The core engagement carries the main work, priced plainly and agreed before anything begins.`,
        },
        {
          id: 'proof',
          head: 'In their words',
          body: `${q(1)} That is a real customer, quoted exactly. The proof of the work lives in what people say once it is finished, not in slogans.`,
        },
        {
          id: 'objections',
          head: 'Been let down before',
          body: 'Then the answer is simple: scope in writing, price agreed first, and a record of what was done. Ask anything you like before you commit to a single thing.',
        },
        {
          id: 'guarantee',
          head: 'If it is not right',
          body: 'If the work is not right, we come back and put it right at no extra charge until it is. That is the promise, in writing, on every single job.',
        },
      ],
      final_cta: `Claim your ${offer} slot this week`,
    },
  };
}

const MOCK_HOOK_CATEGORIES = [
  'direct_benefit', 'open_loop', 'deal_announcement', 'deadline', 'personal_voice',
  'results_evidence', 'story_tease', 'how_to', 'direct_command', 'reflective_question',
];

/** Mirrors qaS7's F2 staleness heuristic so mock and check agree. */
const MOCK_F2_STALE = /\bnever\b|\byears?\b|\blast year\b|\b(?:[6-9]|1[0-9]|2[0-9]|3[0-6])\s*months?\b/i;

function mockS7(intake: Intake): unknown {
  const a1 = fieldText(intake, 'A1');
  const v0 = mockS2Verbatims(intake)[0] ?? '';

  const email = (topic: string, i: number, withQuote = false) => ({
    subject_variants: [
      `A straight answer on ${topic}`,
      `The short version of ${topic}`,
      `Worth two minutes: ${topic}`,
    ].map((subject, k) => ({ subject, hook_category: MOCK_HOOK_CATEGORIES[(i + k * 3) % 10] })),
    preview: 'One useful thing you can read in under a minute — no fluff.',
    body:
      `Hi {{first_name}},\n\nA quick note about ${topic}. The short version: the work gets agreed in writing, ` +
      'the price is set before anything starts, and questions get straight answers. That is how it runs here, and it is why people come back.' +
      (withQuote && v0 ? ` One customer put it like this: "${v0}".` : '') +
      `\n\nWhen you are ready, the next step takes two minutes:\n\n{{link}}\n\nSpeak soon,\nThe team at ${a1}`,
    cta: 'Read the two-minute version',
  });

  const f2 = normalizeText(fieldText(intake, 'F2'));
  const listStatus = f2.length === 0 ? 'none' : MOCK_F2_STALE.test(f2) ? 'cold' : 'warm';
  const f2Quote = f2.slice(0, 80).replace(/\s+\S*$/, '');

  return {
    welcome_seq: [
      'how this works', 'the problem underneath the problem', 'what makes this different',
      'what customers actually say', 'one useful thing you can do today', 'the questions everyone asks',
      'an invitation when you are ready',
    ].map((topic, i) => email(topic, i, i === 3)),
    promo_seq: [
      'the case for sorting it now', 'what waiting actually costs', 'proof from people like you',
      'the questions holding you back', 'the last note in this series',
    ].map((topic, i) => email(topic, i + 7, i === 2)),
    list_warmup_note: {
      list_status: listStatus,
      note: `Read from F2: "${f2Quote}" — status set from the customer's own description; the warm-up email is included only when the list is cold.`,
      reintro_email: listStatus === 'cold' ? email('a fresh start for this list', 2) : null,
    },
  };
}

// Keep in sync with S8_PLATFORM_FORMATS in qa/checks.ts (first native format per platform).
const MOCK_PLATFORM_FORMAT: Record<string, string> = {
  'facebook': 'text post',
  'instagram': 'reel',
  'linkedin': 'text post',
  'tiktok': 'talking-head video',
  'x': 'single post',
  'youtube shorts': 'talking-head short',
  'google business profile': 'update post',
};

function mockS8(intake: Intake): unknown {
  const f5 = Array.isArray(intake.F5) && intake.F5.length > 0 ? (intake.F5 as string[]) : ['Facebook'];
  const platformA = f5[0] as string;
  const platformB = f5[1] ?? platformA;
  const c2 = normalizeText(fieldText(intake, 'C2'));

  // Three distinct C2 slices, word-trimmed — the "proof" lane quotes these.
  const sliceAt = (start: number) => c2.slice(start, Math.min(start + 60, c2.length)).trim().replace(/\s+\S*$/, '');
  const slices = [0, Math.floor(c2.length / 3), Math.floor((2 * c2.length) / 3)]
    .map(sliceAt)
    .filter((s) => s.length >= 12);
  while (slices.length > 0 && slices.length < 3) slices.push(slices[0] as string);

  const pillarSeq = ['teach', 'proof', 'inside look', 'conversation', 'offer'];
  let proofIdx = 0;
  const posts = Array.from({ length: 30 }, (_, i) => {
    const day = i + 1;
    const platform = day % 2 === 1 ? platformA : platformB;
    const pillar = pillarSeq[i % pillarSeq.length];
    const isProof = pillar === 'proof' && slices.length > 0;
    const quote = (isProof ? slices[proofIdx++ % slices.length] : '') ?? '';
    return {
      day,
      platform,
      format: MOCK_PLATFORM_FORMAT[normalizeText(platform).toLowerCase()] ?? 'text post',
      hook: `Day ${day}: one thing worth knowing before you buy`,
      body: isProof
        ? `A customer put it like this: "${quote}" — real words, quoted exactly as written, with nothing added.`
        : `A short, useful note for ${platform}: what good work looks like in practice, how it is priced, and what to check before you say yes to anyone.`,
      cta: 'Send a message to book your slot',
      pillar,
    };
  });

  return { platform_a: platformA, platform_b: platformB, posts };
}

function mockS9(intake: Intake): unknown {
  const b2 = Math.max(num(intake, 'B2'), 2);
  const b3 = num(intake, 'B3');
  const a1 = fieldText(intake, 'A1');
  return {
    snapshot:
      `${a1} sells what the intake describes, at an average sale of £${b2.toLocaleString('en-GB')} (B2), ` +
      `winning ${b3} new customers in a typical month (B3). The relaunch points that engine at the one goal the owner named, using the channels that already produce work.`,
    market:
      'The buyers are the people described in the profile: they arrive with a specific problem, compare a small number of alternatives, ' +
      'and choose on trust and clarity rather than price alone. The plan speaks to them in the words they already use, in the places they already look.',
    offer:
      `The ladder starts with an entry step and carries the main work in the core engagement at £${b2.toLocaleString('en-GB')}. ` +
      'Each option promises only what the owner controls: redo the work, or refund what was paid.',
    goals_90d: `In the owner's words (G1): "${snippet(intake, 'G1', 60)}" — the next 90 days are measured against that goal and nothing longer.`,
    plan_summary:
      'The first weeks fix the leaks the audit found; the rest doubles down on the channels that have already produced work. ' +
      'The busiest week fits inside the hours the owner said they have, and every action names its channel and its purpose.',
    numbers_table: [
      { label: 'Average sale value', value: `£${b2.toLocaleString('en-GB')}`, source: 'B2' },
      { label: 'New customers per month', value: String(b3), source: 'B3' },
      { label: 'Recommended core price', value: `£${b2.toLocaleString('en-GB')}`, source: 'S4' },
      { label: 'Baseline in the plan', value: String(b3), source: 'S5' },
    ],
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
    else if (stage === 'S6') payload = mockS6(this.intake);
    else if (stage === 'S7') payload = mockS7(this.intake);
    else if (stage === 'S8') payload = mockS8(this.intake);
    else if (stage === 'S9') payload = mockS9(this.intake);
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
