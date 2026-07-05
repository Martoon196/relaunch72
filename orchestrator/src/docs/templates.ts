/**
 * Branded HTML templates — one document per deliverable (LS-15, D-017:
 * HTML→PDF, no external services). Every piece of customer/model text is
 * escaped; templates are layout only and never invent content. The
 * compliance line renders in every document footer (hard rule #5).
 */

import { BRAND } from './brand.js';
import { BUNDLE_NAME, deliverableName } from '../lexicon.js';
import { COMPLIANCE_LINE } from '../stages/s10.js';
import type { Intake } from '../types.js';

/** Escape untrusted text for HTML. */
function h(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escaped text with newlines preserved as paragraph breaks. */
function paragraphs(value: unknown): string {
  return String(value ?? '')
    .split(/\n{2,}|\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${h(p)}</p>`)
    .join('\n');
}

function list(items: unknown[] | undefined, cls = ''): string {
  return `<ul${cls ? ` class="${cls}"` : ''}>${(items ?? []).map((i) => `<li>${h(i)}</li>`).join('')}</ul>`;
}

function chips(items: unknown[] | undefined): string {
  return `<div class="chips">${(items ?? []).map((i) => `<span class="chip">${h(i)}</span>`).join('')}</div>`;
}

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: ${BRAND.textStack}; color: ${BRAND.body}; background: ${BRAND.paper}; font-size: 11.5pt; line-height: 1.55; }
  .page { max-width: 46rem; margin: 0 auto; padding: 0 2rem 3rem; }
  .band { background: ${BRAND.ink}; color: #fff; padding: 2.2rem 2rem 1.8rem; margin-bottom: 2rem; }
  .band .wordmark { font-family: ${BRAND.headlineStack}; font-size: 0.85rem; letter-spacing: 0.18em; text-transform: uppercase; color: ${BRAND.electricBright}; }
  .band .wordmark span { color: #fff; }
  .band h1 { font-family: ${BRAND.headlineStack}; font-size: 1.9rem; line-height: 1.15; margin-top: 0.65rem; letter-spacing: -0.01em; }
  .band .for { margin-top: 0.6rem; color: #b9c0cf; font-size: 0.95rem; }
  .band .for strong { color: #fff; }
  h2 { font-family: ${BRAND.headlineStack}; font-size: 1.15rem; margin: 2rem 0 0.7rem; letter-spacing: 0.01em; }
  h2::before { content: ''; display: inline-block; width: 0.55rem; height: 0.55rem; background: ${BRAND.electric}; margin-right: 0.5rem; }
  h3 { font-size: 0.98rem; margin: 1.1rem 0 0.35rem; }
  p { margin: 0.45rem 0; }
  ul, ol { margin: 0.45rem 0 0.45rem 1.2rem; }
  li { margin: 0.3rem 0; }
  table { width: 100%; border-collapse: collapse; margin: 0.7rem 0; font-size: 0.92em; }
  th { text-align: left; font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.06em; color: ${BRAND.muted}; border-bottom: 2px solid ${BRAND.ink}; padding: 0.35rem 0.5rem; }
  td { border-bottom: 1px solid ${BRAND.rule}; padding: 0.45rem 0.5rem; vertical-align: top; }
  .quote { border-left: 3px solid ${BRAND.electric}; background: ${BRAND.panel}; padding: 0.7rem 1rem; margin: 0.6rem 0; font-style: italic; }
  .quote .who { display: block; font-style: normal; font-size: 0.8em; color: ${BRAND.muted}; margin-top: 0.3rem; }
  .callout { background: ${BRAND.ink}; color: #fff; padding: 1.1rem 1.3rem; margin: 0.9rem 0; }
  .callout .label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.14em; color: ${BRAND.electricBright}; margin-bottom: 0.4rem; }
  .chips { margin: 0.4rem 0; }
  .chip { display: inline-block; border: 1px solid ${BRAND.rule}; background: ${BRAND.panel}; border-radius: 99px; padding: 0.08rem 0.65rem; margin: 0.15rem 0.25rem 0.15rem 0; font-size: 0.82em; }
  .chip.accent { border-color: ${BRAND.electric}; color: ${BRAND.electric}; background: #fff; }
  .grade { display: inline-block; min-width: 2.1rem; text-align: center; font-family: ${BRAND.headlineStack}; background: ${BRAND.ink}; color: #fff; padding: 0.1rem 0.4rem; }
  .bar { background: ${BRAND.panel}; height: 0.5rem; position: relative; margin-top: 0.3rem; }
  .bar i { display: block; height: 100%; background: ${BRAND.electric}; }
  .card { border: 1px solid ${BRAND.rule}; padding: 1rem 1.2rem; margin: 0.7rem 0; page-break-inside: avoid; }
  .card .role { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.14em; color: ${BRAND.electric}; }
  .card .price { font-family: ${BRAND.headlineStack}; font-size: 1.3rem; }
  .muted { color: ${BRAND.muted}; }
  .small { font-size: 0.85em; }
  pre.body-copy { font-family: inherit; white-space: pre-wrap; margin: 0.4rem 0; }
  footer { margin-top: 3rem; border-top: 2px solid ${BRAND.ink}; padding-top: 0.8rem; font-size: 0.75em; color: ${BRAND.muted}; }
  @page { margin: 14mm 0 16mm; }
`;

export interface DocMeta {
  business: string;
  runId: string;
  generatedAt: string;
  mock: boolean;
}

function layout(title: string, meta: DocMeta, bodyHtml: string): string {
  const mockNotice = meta.mock
    ? `<p style="background:#fff3cd;border:1px solid #d4b106;padding:0.6rem 1rem;font-size:0.85em;"><strong>Mock run</strong> — synthetic mechanics-test output, not for customer delivery or quality review.</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)} — ${h(meta.business)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="band">
  <div class="wordmark">${h(BRAND.name)} <span>· ${h(BUNDLE_NAME)}</span></div>
  <h1>${h(title)}</h1>
  <div class="for">Prepared for <strong>${h(meta.business)}</strong></div>
</div>
<div class="page">
${mockNotice}
${bodyHtml}
<footer>
  <p>${h(COMPLIANCE_LINE)}</p>
  <p>${h(BRAND.name)} · ${h(title)} · run ${h(meta.runId)} · generated ${h(meta.generatedAt.slice(0, 10))}</p>
</footer>
</div>
</body>
</html>`;
}

// ─── Per-stage renderers ────────────────────────────────────────────────────

interface S1Doc {
  scores: Array<{ category: string; grade_1to10: number; evidence: string; leak_cost_estimate: string }>;
  top_3_leaks: string[];
  quick_wins: string[];
  narrative_summary: string;
}

function renderS1(out: S1Doc): string {
  const rows = out.scores
    .map(
      (s) => `<tr>
  <td><strong>${h(s.category)}</strong><div class="bar"><i style="width:${Math.max(0, Math.min(10, s.grade_1to10)) * 10}%"></i></div></td>
  <td><span class="grade">${h(s.grade_1to10)}</span></td>
  <td>${h(s.evidence)}</td>
  <td class="small">${h(s.leak_cost_estimate)}</td>
</tr>`,
    )
    .join('\n');
  return `
<h2>Where you stand</h2>
${paragraphs(out.narrative_summary)}
<h2>Scorecard</h2>
<table>
<thead><tr><th style="width:24%">Category</th><th>Grade</th><th>Evidence — your own words</th><th style="width:26%">What the leak costs</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<h2>The three biggest leaks</h2>
<ol>${out.top_3_leaks.map((l) => `<li>${h(l)}</li>`).join('')}</ol>
<h2>Quick wins — this week</h2>
${list(out.quick_wins)}`;
}

interface S2Doc {
  profile_narrative: string;
  demographics: string;
  situation: string;
  trigger_events: string[];
  objections: string[];
  desires_surface: string;
  desires_deep: string;
  verbatims: string[];
  exclusions: string[];
  awareness_stage: string;
  channels: string[];
}

function renderS2(out: S2Doc): string {
  return `
<h2>Your buyer</h2>
${paragraphs(out.profile_narrative)}
<h2>The facts</h2>
<table><tbody>
<tr><td style="width:30%"><strong>Demographics</strong></td><td>${h(out.demographics)}</td></tr>
<tr><td><strong>Situation</strong></td><td>${h(out.situation)}</td></tr>
<tr><td><strong>Surface want</strong></td><td>${h(out.desires_surface)}</td></tr>
<tr><td><strong>What they're really buying</strong></td><td>${h(out.desires_deep)}</td></tr>
<tr><td><strong>Awareness stage</strong></td><td><span class="chip accent">${h(out.awareness_stage)}</span></td></tr>
</tbody></table>
<h2>What sets them off</h2>
${list(out.trigger_events)}
<h2>What holds them back</h2>
${list(out.objections)}
<h2>In their own words</h2>
${out.verbatims.map((v) => `<div class="quote">&ldquo;${h(v)}&rdquo;<span class="who">real customer words, quoted exactly</span></div>`).join('\n')}
<h2>Who this is NOT for</h2>
${list(out.exclusions)}
<h2>Where to reach them</h2>
${chips(out.channels)}`;
}

interface S3Doc {
  positioning_statement: string;
  message_pillars: string[];
  differentiators: string[];
  value_props: string[];
  voice: { sliders: Record<string, number>; tone_rules: string[]; banned_words: string[]; must_words: string[] };
  elevator_pitch: string;
}

const SLIDER_LABELS: Record<string, [string, string]> = {
  formal_casual: ['Formal', 'Casual'],
  playful_straight: ['Playful', 'Straight-talking'],
  bold_understated: ['Bold', 'Understated'],
};

function renderS3(out: S3Doc): string {
  const sliders = Object.entries(out.voice.sliders)
    .map(([key, v]) => {
      const [a, b] = SLIDER_LABELS[key] ?? [key, ''];
      return `<tr><td style="width:26%">${h(a)}</td><td><div class="bar"><i style="width:${Math.max(1, Math.min(5, v)) * 20}%"></i></div></td><td style="width:26%;text-align:right">${h(b)}</td></tr>`;
    })
    .join('');
  return `
<div class="callout"><div class="label">Positioning</div>${paragraphs(out.positioning_statement)}</div>
<h2>Message pillars — say these everywhere</h2>
<ol>${out.message_pillars.map((p) => `<li>${h(p)}</li>`).join('')}</ol>
<h2>Why you, in your own words</h2>
${list(out.differentiators)}
<h2>What the buyer gets</h2>
${list(out.value_props)}
<h2>Voiceprint</h2>
<table><tbody>${sliders}</tbody></table>
<h3>Tone rules</h3>
${list(out.voice.tone_rules)}
<h3>Never say</h3>
${chips(out.voice.banned_words)}
<h3>Always say</h3>
${chips(out.voice.must_words)}
<div class="callout"><div class="label">Elevator pitch</div>${paragraphs(out.elevator_pitch)}</div>`;
}

interface S4Doc {
  current_stack_read: string;
  recommended_stack: Array<{ name: string; price: number; role: string; rationale: string }>;
  lead_offer: string;
  pricing_moves: string[];
  risk_reversal_options: string[];
  category_note: string;
}

function renderS4(out: S4Doc, currency = '£'): string {
  const rungs = out.recommended_stack
    .map(
      (r) => `<div class="card">
  <span class="role">${h(r.role)}</span>
  <h3 style="margin-top:0.15rem">${h(r.name)} <span class="price" style="float:right">${h(currency)}${h(r.price.toLocaleString('en-GB'))}</span></h3>
  <p class="small">${h(r.rationale)}</p>
</div>`,
    )
    .join('\n');
  return `
<h2>Your stack today — an honest read</h2>
${paragraphs(out.current_stack_read)}
<h2>The recommended ladder</h2>
${rungs}
<div class="callout"><div class="label">Lead with</div>${paragraphs(out.lead_offer)}</div>
<h2>Pricing moves</h2>
${list(out.pricing_moves)}
<h2>Risk reversal — promise only what you control</h2>
${list(out.risk_reversal_options)}
<h2>What to call yourself</h2>
${paragraphs(out.category_note)}`;
}

interface S5Doc {
  north_star: string;
  phases: Array<{ days: string; theme: string; actions: Array<{ action: string; hours: number; channel: string; depends_on: string }> }>;
  channel_priorities: string[];
  do_not_do: string[];
  weekly_hours_total: number;
}

function renderS5(out: S5Doc): string {
  const phases = out.phases
    .map(
      (p) => `<h3>${h(p.days)} — ${h(p.theme)}</h3>
<table>
<thead><tr><th>Action</th><th style="width:10%">Hours</th><th style="width:20%">Channel</th><th style="width:22%">Depends on</th></tr></thead>
<tbody>${p.actions
        .map((a) => `<tr><td>${h(a.action)}</td><td>${h(a.hours)}</td><td>${h(a.channel)}</td><td class="small muted">${h(a.depends_on || '—')}</td></tr>`)
        .join('')}</tbody>
</table>`,
    )
    .join('\n');
  return `
<div class="callout"><div class="label">North star — the next 90 days</div>${paragraphs(out.north_star)}</div>
<p><strong>Weekly commitment at its busiest: ${h(out.weekly_hours_total)} hour${out.weekly_hours_total === 1 ? '' : 's'}.</strong> The plan is built to fit inside the time you said you have.</p>
<h2>The phases</h2>
${phases}
<h2>Channel priorities — in order</h2>
<ol>${out.channel_priorities.map((c) => `<li>${h(c)}</li>`).join('')}</ol>
<h2>Do not do</h2>
${list(out.do_not_do)}`;
}

interface S6Doc {
  home: { hero_variants: Array<{ angle: string; headline: string; subhead: string; cta: string }>; sections: Array<{ id: string; head: string; body: string; cta?: string }> };
  about: { head: string; body: string };
  sales_page: { head: string; subhead: string; sections: Array<{ id: string; head: string; body: string; cta?: string }>; final_cta: string };
}

function renderSection(s: { id: string; head: string; body: string; cta?: string }): string {
  return `<div class="card">
  <span class="role">${h(s.id)}</span>
  <h3 style="margin-top:0.15rem">${h(s.head)}</h3>
  ${paragraphs(s.body)}
  ${s.cta ? `<p><span class="chip accent">CTA</span> ${h(s.cta)}</p>` : ''}
</div>`;
}

function renderS6(out: S6Doc): string {
  return `
<h2>Home — two ways to open (pick one, test the other)</h2>
${out.home.hero_variants
    .map(
      (v, i) => `<div class="card">
  <span class="role">Hero ${String.fromCharCode(65 + i)} · ${h(v.angle)}</span>
  <h3 style="margin-top:0.15rem">${h(v.headline)}</h3>
  <p>${h(v.subhead)}</p>
  <p><span class="chip accent">CTA</span> ${h(v.cta)}</p>
</div>`,
    )
    .join('\n')}
<h2>Home — sections</h2>
${out.home.sections.map(renderSection).join('\n')}
<h2>About</h2>
<div class="card"><h3 style="margin-top:0">${h(out.about.head)}</h3>${paragraphs(out.about.body)}</div>
<h2>Sales page</h2>
<div class="callout"><div class="label">Opening</div><p><strong>${h(out.sales_page.head)}</strong></p><p>${h(out.sales_page.subhead)}</p></div>
${out.sales_page.sections.map(renderSection).join('\n')}
<p><span class="chip accent">Final CTA</span> ${h(out.sales_page.final_cta)}</p>`;
}

interface S7Email {
  subject_variants: Array<{ subject: string; hook_category: string }>;
  preview: string;
  body: string;
  cta: string;
}

interface S7Doc {
  welcome_seq: S7Email[];
  promo_seq: S7Email[];
  list_warmup_note: { list_status: string; note: string; reintro_email: S7Email | null };
}

function renderEmail(e: S7Email, label: string): string {
  return `<div class="card">
  <span class="role">${h(label)}</span>
  <table><tbody>${e.subject_variants
    .map((v) => `<tr><td style="width:30%"><span class="chip">${h(v.hook_category.replace(/_/g, ' '))}</span></td><td>${h(v.subject)}</td></tr>`)
    .join('')}</tbody></table>
  <p class="small muted">Preview text: ${h(e.preview)}</p>
  <pre class="body-copy">${h(e.body)}</pre>
  <p><span class="chip accent">CTA</span> ${h(e.cta)}</p>
</div>`;
}

function renderS7(out: S7Doc): string {
  const warmup = out.list_warmup_note;
  return `
<p class="small muted">Merge tokens: <code>{{first_name}}</code> is the reader's first name; <code>{{link}}</code> is the one link each email carries. Your email tool fills both.</p>
<h2>Your list — read before sending</h2>
<p><span class="chip accent">${h(warmup.list_status)}</span> ${h(warmup.note)}</p>
${warmup.reintro_email ? renderEmail(warmup.reintro_email, 'Warm-up · send first') : ''}
<h2>Welcome sequence — one per day, days 1–7</h2>
${out.welcome_seq.map((e, i) => renderEmail(e, `Welcome ${i + 1} of ${out.welcome_seq.length}`)).join('\n')}
<h2>Promo sequence — when you're ready to sell</h2>
${out.promo_seq.map((e, i) => renderEmail(e, `Promo ${i + 1} of ${out.promo_seq.length}`)).join('\n')}`;
}

interface S8Doc {
  platform_a: string;
  platform_b: string;
  posts: Array<{ day: number; platform: string; format: string; hook: string; body: string; cta: string; pillar: string }>;
}

function renderS8(out: S8Doc): string {
  const posts = [...out.posts].sort((a, b) => a.day - b.day);
  return `
<p>Thirty days, ready to post: <strong>${h(out.platform_a)}</strong>${out.platform_b !== out.platform_a ? ` and <strong>${h(out.platform_b)}</strong>` : ''} — the platforms you chose.</p>
${posts
    .map(
      (p) => `<div class="card">
  <span class="role">Day ${h(p.day)} · ${h(p.platform)} · ${h(p.format)}</span>
  <span class="chip" style="float:right">${h(p.pillar)}</span>
  <h3 style="margin-top:0.15rem">${h(p.hook)}</h3>
  <pre class="body-copy">${h(p.body)}</pre>
  <p><span class="chip accent">CTA</span> ${h(p.cta)}</p>
</div>`,
    )
    .join('\n')}`;
}

interface S9Doc {
  snapshot: string;
  market: string;
  offer: string;
  goals_90d: string;
  plan_summary: string;
  numbers_table: Array<{ label: string; value: string; source: string }>;
}

function renderS9(out: S9Doc): string {
  return `
<h2>Snapshot</h2>
${paragraphs(out.snapshot)}
<h2>Market</h2>
${paragraphs(out.market)}
<h2>Offer</h2>
${paragraphs(out.offer)}
<h2>Goals — next 90 days</h2>
${paragraphs(out.goals_90d)}
<h2>The plan in brief</h2>
${paragraphs(out.plan_summary)}
<h2>The numbers</h2>
<table>
<thead><tr><th>Measure</th><th>Value</th><th style="width:18%">Source</th></tr></thead>
<tbody>${out.numbers_table
    .map((r) => `<tr><td>${h(r.label)}</td><td><strong>${h(r.value)}</strong></td><td class="small muted">${h(r.source)}</td></tr>`)
    .join('')}</tbody>
</table>`;
}

// ─── Public API ─────────────────────────────────────────────────────────────

const RENDERERS: Record<string, (out: never) => string> = {
  S1: renderS1,
  S2: renderS2,
  S3: renderS3,
  S4: renderS4,
  S5: renderS5,
  S6: renderS6,
  S7: renderS7,
  S8: renderS8,
  S9: renderS9,
};

export function renderStageDoc(stage: string, output: unknown, meta: DocMeta): string {
  const renderer = RENDERERS[stage];
  if (!renderer) throw new Error(`No document template for stage ${stage}`);
  return layout(deliverableName(stage), meta, renderer(output as never));
}

/** Cover / contents page for the bundle. */
export function renderIndex(meta: DocMeta, intake: Intake, stages: string[]): string {
  const body = `
<h2>What's inside</h2>
<table>
<thead><tr><th style="width:12%">Doc</th><th>Deliverable</th></tr></thead>
<tbody>${stages
    .map((s, i) => `<tr><td>${String(i + 1).padStart(2, '0')}</td><td><a href="${s.toLowerCase()}.html">${h(deliverableName(s))}</a></td></tr>`)
    .join('')}</tbody>
</table>
<h2>How to use this pack</h2>
<ol>
  <li>Read the <strong>${h(deliverableName('S1'))}</strong> first — it explains what the rest fixes.</li>
  <li>The <strong>${h(deliverableName('S2'))}</strong> and <strong>${h(deliverableName('S3'))}</strong> are the foundation: every other document was written from them.</li>
  <li>Deploy the <strong>${h(deliverableName('S6'))}</strong>, <strong>${h(deliverableName('S7'))}</strong> and <strong>${h(deliverableName('S8'))}</strong> as-is — they are written to publish, not to edit.</li>
  <li>Run the <strong>${h(deliverableName('S5'))}</strong> week by week. It fits the hours you told us you have.</li>
</ol>
<p class="small muted">Everything in this pack was built from your intake answers${typeof intake.A1 === 'string' ? ` for ${h(intake.A1)}` : ''} and reviewed by a human strategist before delivery.</p>`;
  return layout(BUNDLE_NAME, meta, body);
}
