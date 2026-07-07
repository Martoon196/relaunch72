/**
 * Deep Intake v1.0 field spec — mirrors the canonical Notion doc
 * ("Deep Intake v1.0 — field spec (45 questions)"). Field IDs A1–H4 are the
 * pipeline's input contract; DO NOT rename or renumber here — change the
 * Notion spec first, then mirror it.
 *
 * Placeholders: text marked `placeholderFromSpec: true` is verbatim from the
 * Notion doc. The rest are authored worked examples (decisions.md D-005) for
 * fields where the spec calls for a placeholder without giving exact copy —
 * review at M3 form build (LS-11). S0's placeholder-similarity check rejects
 * answers that merely echo whichever text ships.
 */

export type FieldKind =
  | 'short_text'
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'url_list'
  | 'sliders'
  | 'two_box';

export interface FieldSpec {
  id: string;
  section: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';
  label: string;
  kind: FieldKind;
  /** true / false / conditional on another field's multi-select containing a value. */
  required: boolean | { ifField: string; includes: string };
  minWords?: number;
  options?: string[];
  maxSelections?: number;
  minSelections?: number;
  /** Select/multi-select also accepts free text beyond the presets ("other+text"). */
  allowOther?: boolean;
  placeholder?: string;
  placeholderFromSpec?: boolean;
  /** For kind 'sliders': the slider keys, each an integer 1–5 (1 = left word, 5 = right word). */
  sliderKeys?: string[];
  /** For kind 'two_box': the sub-keys. */
  boxKeys?: string[];
  feeds: string;
}

export const SCHWARTZ_AWARENESS_STAGES = [
  'unaware',
  'problem aware',
  'solution aware',
  'product aware',
  'most aware',
] as const;

export const INTAKE_FIELDS: FieldSpec[] = [
  // ── Section A — The business (7) ────────────────────────────────────────
  {
    id: 'A1', section: 'A', label: 'Business name', kind: 'short_text', required: true,
    feeds: 'all docs (merge field)',
  },
  {
    id: 'A2', section: 'A', label: "What do you do, in one sentence, as you'd say it in the pub?",
    kind: 'text', required: true, minWords: 8,
    placeholder: "I fit high-end kitchens for families in Kent who've been burned by cowboy builders",
    placeholderFromSpec: true,
    feeds: 'core message, voice',
  },
  {
    id: 'A3', section: 'A', label: 'Website + social links', kind: 'url_list', required: false,
    feeds: 'audit stage',
  },
  {
    id: 'A4', section: 'A', label: 'Years trading', kind: 'select', required: true,
    options: ['<1', '1–3', '3–6', '6–10', '10+'],
    feeds: 'relaunch narrative calibration',
  },
  {
    id: 'A5', section: 'A', label: 'Location + service area', kind: 'text', required: true,
    feeds: 'strategy (local vs national channels)',
  },
  {
    id: 'A6', section: 'A', label: 'Business model', kind: 'select', required: true,
    options: ['local service or trades', 'coach or consultant', 'e-commerce', 'agency or freelance', 'B2B service', 'other'],
    allowOther: true,
    feeds: 'every stage (template routing)',
  },
  {
    id: 'A7', section: 'A', label: 'Team size', kind: 'select', required: false,
    options: ['just me', '2–5', '6–15', '16+'],
    feeds: 'growth plan capacity sizing',
  },

  // ── Section B — The numbers (6) ─────────────────────────────────────────
  {
    id: 'B1', section: 'B', label: 'Current monthly revenue', kind: 'select', required: true,
    options: ['<$1k', '$1–3k', '$3–10k', '$10–30k', '$30k+'],
    feeds: 'audit, plan ambition level',
  },
  {
    id: 'B2', section: 'B', label: 'Average sale or customer value', kind: 'number', required: true,
    feeds: 'offer architecture, ad economics',
  },
  {
    id: 'B3', section: 'B', label: 'New customers per month, roughly', kind: 'number', required: true,
    feeds: 'audit baseline, 90-day targets',
  },
  {
    id: 'B4', section: 'B', label: 'Where does most revenue actually come from today?',
    kind: 'text', required: true, minWords: 10,
    placeholder: 'honestly, 80% is repeat customers and word of mouth',
    placeholderFromSpec: true,
    feeds: 'audit (reality vs aspiration gap)',
  },
  {
    id: 'B5', section: 'B', label: 'Current monthly marketing spend', kind: 'select', required: false,
    options: ['$0', '<$200', '$200–1k', '$1k+'],
    feeds: 'plan channel mix',
  },
  {
    id: 'B6', section: 'B', label: 'Rough gross margin', kind: 'select', required: false,
    options: ['<30%', '30–60%', '60%+', 'not sure'],
    feeds: 'plan realism, ad viability',
  },

  // ── Section C — Your customers (8) — the gold section ───────────────────
  {
    id: 'C1', section: 'C', label: 'Describe your best customer as an actual person',
    kind: 'textarea', required: true, minWords: 40,
    placeholder:
      "Sarah, late 40s, runs her own physio clinic two villages over. Time-poor, does the books on Sunday nights, hates being sold to. She found us when the boiler died mid-January — rang three firms, we were the only ones who answered. Now she recommends us to every patient who mentions a cold house.",
    feeds: 'ICP (primary seed)',
  },
  {
    id: 'C2', section: 'C',
    label: 'Paste 2–3 real things customers have said — reviews, texts, emails, word for word',
    kind: 'textarea', required: true, minWords: 30,
    feeds: 'voice, hooks, proof vault, social — the anti-generic fuel',
  },
  {
    id: 'C3', section: 'C', label: 'What problem are they really hiring you to solve?',
    kind: 'textarea', required: true, minWords: 15,
    placeholder:
      "It's not the leaky tap — it's that they don't want to think about the house going wrong again. They're buying the not-having-to-worry.",
    feeds: 'core message',
  },
  {
    id: 'C4', section: 'C', label: 'What happens right before they come looking for you?',
    kind: 'textarea', required: true, minWords: 10,
    placeholder: 'Usually something breaks, or a mate at the school gates mentions they finally got theirs sorted.',
    feeds: 'hooks, awareness-stage mapping, ad angles',
  },
  {
    id: 'C5', section: 'C', label: 'What nearly stops them buying? Top 1–3 objections',
    kind: 'textarea', required: true, minWords: 10,
    placeholder: "Price shock vs the cheap quotes, fear of mess and delays, and \"can I trust these people in my house?\"",
    feeds: 'sales page objections, email sequence, FAQ',
  },
  {
    id: 'C6', section: 'C', label: 'Who is NOT a fit — your nightmare customer?',
    kind: 'textarea', required: true,
    feeds: 'ICP exclusions, qualifying copy',
  },
  {
    id: 'C7', section: 'C', label: 'Where do they hang out?', kind: 'multi_select', required: false,
    options: ['FB groups', 'Instagram', 'LinkedIn', 'TikTok', 'YouTube', 'Google search', 'local/offline', 'trade press'],
    allowOther: true,
    feeds: 'strategy channel priorities',
  },
  {
    id: 'C8', section: 'C', label: 'What do they usually try before you?', kind: 'text', required: true,
    feeds: 'mechanism positioning (failed alternatives)',
  },

  // ── Section D — Offer & pricing (6) ─────────────────────────────────────
  {
    id: 'D1', section: 'D', label: 'What do you sell, at what prices?', kind: 'textarea', required: true,
    placeholder: 'Service — price — who it\'s for, one per line',
    placeholderFromSpec: true,
    feeds: 'offer architecture (primary input)',
  },
  {
    id: 'D2', section: 'D', label: 'Most profitable vs easiest to sell', kind: 'text', required: true,
    feeds: 'offer architecture (what to lead with)',
  },
  {
    id: 'D3', section: 'D', label: 'What would you love to sell more of, and why?', kind: 'text', required: true,
    feeds: 'offer architecture, 90-day plan goal alignment',
  },
  {
    id: 'D4', section: 'D', label: 'Any guarantee or warranty you offer (or could)?', kind: 'text', required: false,
    feeds: 'risk-reversal design',
  },
  {
    id: 'D5', section: 'D', label: 'Could you handle 2× the customers next month?', kind: 'select', required: true,
    options: ['easily', 'a stretch', 'no'],
    feeds: 'growth plan pacing',
  },
  {
    id: 'D6', section: 'D', label: 'Anything you refuse to do or sell?', kind: 'text', required: false,
    feeds: 'offer boundaries, voice',
  },

  // ── Section E — Competitors & position (5) ──────────────────────────────
  {
    id: 'E1', section: 'E', label: 'Name 2–3 direct competitors (+ links if known)', kind: 'text', required: true,
    feeds: 'audit, positioning',
  },
  {
    id: 'E2', section: 'E', label: 'Who do you lose to, and honestly, why?',
    kind: 'textarea', required: true, minWords: 10,
    feeds: 'positioning gap analysis',
  },
  {
    id: 'E3', section: 'E', label: 'What do you genuinely do better or differently?',
    kind: 'textarea', required: true, minWords: 15,
    feeds: 'core message differentiators',
  },
  {
    id: 'E4', section: 'E', label: 'Your price position vs them', kind: 'select', required: true,
    options: ['cheaper', 'similar', 'premium'],
    feeds: 'positioning, offer anchoring',
  },
  {
    id: 'E5', section: 'E', label: "Any marketing you admire? — theirs or anyone's, links welcome", kind: 'text', required: false,
    feeds: 'voice + creative taste calibration',
  },

  // ── Section F — Marketing history (5) ───────────────────────────────────
  {
    id: 'F1', section: 'F', label: 'What marketing exists today?', kind: 'multi_select', required: true,
    options: ['website', 'Google Business Profile', 'Facebook-Instagram', 'email list', 'paid ads', 'SEO', 'referral scheme', 'none'],
    minSelections: 1,
    feeds: 'audit inventory',
  },
  {
    id: 'F2', section: 'F', label: 'Email list size + when you last emailed it', kind: 'text',
    required: { ifField: 'F1', includes: 'email list' },
    feeds: 'email pack calibration (warm-up vs active list)',
  },
  {
    id: 'F3', section: 'F', label: 'What have you tried that flopped?', kind: 'textarea', required: true,
    feeds: "audit, plan (don't re-prescribe failures), mechanism copy",
  },
  {
    id: 'F4', section: 'F', label: 'What has actually brought in customers?',
    kind: 'textarea', required: true, minWords: 10,
    feeds: 'plan (double down on proven), audit',
  },
  {
    id: 'F5', section: 'F', label: 'Which 2 platforms should your 30 days of content target?',
    kind: 'multi_select', required: true,
    options: ['Facebook', 'Instagram', 'LinkedIn', 'TikTok', 'X', 'YouTube Shorts', 'Google Business Profile'],
    minSelections: 1, maxSelections: 2,
    feeds: 'social stage (platform-native output)',
  },

  // ── Section G — Goals & constraints (4) ─────────────────────────────────
  {
    id: 'G1', section: 'G', label: 'Your #1 goal for the next 90 days, specific',
    kind: 'text', required: true, minWords: 8,
    placeholder: 'add 15 recurring service contracts',
    placeholderFromSpec: true,
    feeds: '90-day plan north star',
  },
  {
    id: 'G2', section: 'G', label: 'Hours per week you can genuinely give marketing', kind: 'select', required: true,
    options: ['<2', '2–5', '5–10', '10+'],
    feeds: 'plan sizing (a 10-hour plan for a 2-hour owner fails)',
  },
  {
    id: 'G3', section: 'G', label: 'Monthly budget you could commit if the plan justified it',
    kind: 'select', required: false,
    options: ['$0', '<$200', '$200–500', '$500–1.5k', '$1.5k+'],
    feeds: 'plan channel mix',
  },
  {
    id: 'G4', section: 'G', label: 'Anything big coming up? — season, launch, move, hire',
    kind: 'text', required: false,
    feeds: 'plan sequencing',
  },

  // ── Section H — Voice & brand (4) ───────────────────────────────────────
  {
    id: 'H1', section: 'H', label: 'Voice sliders', kind: 'sliders', required: true,
    sliderKeys: ['formal_casual', 'playful_straight', 'bold_understated'],
    feeds: 'voice guide, all copy stages',
  },
  {
    id: 'H2', section: 'H', label: 'Brands or people whose vibe you rate — any industry',
    kind: 'text', required: true,
    feeds: 'voice calibration',
  },
  {
    id: 'H3', section: 'H', label: "Words you'd never use / must use", kind: 'two_box', required: false,
    boxKeys: ['never_use', 'must_use'],
    feeds: 'personalised banned-phrase list in QA layer',
  },
  {
    id: 'H4', section: 'H', label: 'Anything else we should know?', kind: 'textarea', required: false,
    feeds: 'human QA context',
  },
];

export const FIELD_BY_ID: ReadonlyMap<string, FieldSpec> = new Map(
  INTAKE_FIELDS.map((f) => [f.id, f]),
);

if (INTAKE_FIELDS.length !== 45) {
  throw new Error(`Deep Intake spec drift: expected 45 fields, found ${INTAKE_FIELDS.length}`);
}
