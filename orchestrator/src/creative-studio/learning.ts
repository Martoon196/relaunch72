/**
 * Milestone 5: learning from real outcomes. Pure and deterministic: it turns one exact outcome read
 * (Milestone 4, existing CRM/journey/commerce records) into dated, evidence-linked findings, compares
 * concepts and artwork with stated uncertainty, and suggests next tests. It never computes revenue,
 * ROAS, CAC or a "winner", never suggests a budget, and never starts anything.
 */
import { createHash } from 'node:crypto';
import type { AcquisitionProposal } from '../seo-blog/campaign-creator.js';
import { parseCreativeUtmContent, type OutcomeBucket, type OutcomeRead } from './distribution.js';

export const LEARNING_RULES = 'r72-creative-learning-v1' as const;
/** Below this many tagged leads in an arm, rates are shown but no comparison is drawn. */
export const MIN_ARM_LEADS = 20;
/** Mirrors the SQL journal's limit per recorded finding set. */
export const MAX_FINDINGS = 40;

export type FindingStrength = 'insufficient_data' | 'no_clear_difference' | 'observed_difference' | 'not_applicable';
export interface FindingEvidence {
  readonly source: 'crm_outcomes';
  readonly utmCampaign: string;
  readonly utmContent: string;
  readonly leads: number; readonly qualified: number; readonly booked: number; readonly sold: number; readonly customers: number;
  readonly readAt: string;
}
export interface Finding {
  readonly id: string;
  readonly kind: 'observation' | 'comparison' | 'gap';
  readonly statement: string;
  readonly strength: FindingStrength;
  /** Comparisons only: which rate was compared. */
  readonly metric?: 'qualified' | 'booked' | 'sold';
  readonly period: Readonly<{ from: string | null; to: string | null }>;
  readonly observedAt: string;
  readonly evidence: readonly FindingEvidence[];
}
export interface NextTest {
  readonly id: string;
  readonly title: string;
  readonly change: string;
  readonly keepTheSame: string;
  readonly measure: string;
  readonly reviewAfterDays: number;
  readonly why: string;
  readonly basedOn: readonly string[];
  readonly budget: string;
}
export interface LearningSnapshot {
  readonly rules: typeof LEARNING_RULES;
  readonly utmCampaign: string;
  readonly readAt: string;
  readonly findings: readonly Finding[];
  readonly nextTests: readonly NextTest[];
  readonly notCompared: readonly string[];
}

const NO_BUDGET = 'No budget is suggested. Any spend, audience, channel or schedule is your decision and nothing here authorises it.';
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);
const id = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

/** Wilson score interval (95%) for k successes in n trials. */
export function wilson(k: number, n: number): { rate: number; low: number; high: number } {
  if (n <= 0) return { rate: 0, low: 0, high: 0 };
  const z = 1.959964, p = k / n, d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d, half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export function armLabel(utmContent: string, proposal?: AcquisitionProposal | null): string {
  const parsed = parseCreativeUtmContent(utmContent);
  if (!parsed) return utmContent ? `Unrecognised tag “${utmContent}”` : 'No concept tag';
  const name = proposal?.concepts[parsed.concept]?.name;
  return `Concept ${parsed.concept + 1}${name ? ` (${name})` : ''}${parsed.creative ? ` · artwork ${parsed.creative}` : ' · no artwork tag'}`;
}

const evidenceOf = (read: OutcomeRead, b: OutcomeBucket): FindingEvidence => Object.freeze({ source: 'crm_outcomes', utmCampaign: read.utmCampaign, utmContent: b.utmContent,
  leads: b.leads, qualified: b.qualified, booked: b.booked, sold: b.sold, customers: b.customers, readAt: read.readAt });

export function buildLearning(read: OutcomeRead, proposal: AcquisitionProposal | null): LearningSnapshot {
  const arms = read.buckets.filter((b) => parseCreativeUtmContent(b.utmContent) && b.leads > 0);
  const stray = read.buckets.filter((b) => !parseCreativeUtmContent(b.utmContent) && b.leads > 0);
  const from = read.buckets.map((b) => b.firstAt).filter(Boolean).sort()[0] ?? null, to = read.buckets.map((b) => b.lastAt).filter(Boolean).sort().at(-1) ?? null;
  const period = Object.freeze({ from, to });
  const findings: Finding[] = [];
  if (!arms.length && !stray.length) {
    findings.push({ id: id('none', read.utmCampaign), kind: 'gap', strength: 'not_applicable', period, observedAt: read.readAt, evidence: [],
      statement: `No CRM contact carried utm_campaign=${read.utmCampaign} when read on ${day(read.readAt)}. This can mean the links were not used yet, or that leads came through a form that does not store campaign tags.` });
  }
  for (const b of arms) {
    findings.push({ id: id('obs', read.utmCampaign, b), kind: 'observation', strength: 'not_applicable', period: { from: b.firstAt, to: b.lastAt }, observedAt: read.readAt, evidence: [evidenceOf(read, b)],
      statement: `${armLabel(b.utmContent, proposal)}: ${b.leads} tagged lead${b.leads === 1 ? '' : 's'}, ${b.qualified} qualified, ${b.booked} booked, ${b.sold} with a recorded sale, between ${day(b.firstAt) ?? '—'} and ${day(b.lastAt) ?? '—'}.` });
  }
  for (const b of stray) {
    findings.push({ id: id('stray', read.utmCampaign, b), kind: 'gap', strength: 'not_applicable', period: { from: b.firstAt, to: b.lastAt }, observedAt: read.readAt, evidence: [evidenceOf(read, b)],
      statement: `${b.leads} contact${b.leads === 1 ? '' : 's'} carried this campaign tag without a recognised concept/artwork tag (${b.utmContent ? `“${b.utmContent}”` : 'none'}), so they cannot be compared.` });
  }
  const notCompared: string[] = [
    'Lead volumes are not compared between concepts: impressions, reach and spend per link are not recorded, so more leads may only mean a link was used more.',
    'No revenue, return on ad spend, cost per acquisition or overall winner is calculated.',
  ];
  // Comparisons use only arms with enough tagged leads; smaller arms are named as excluded rather than blocking everything.
  const small = arms.filter((b) => b.leads < MIN_ARM_LEADS);
  if (arms.length >= 2) {
    for (const [metric, label] of [['qualified', 'qualified rate'], ['booked', 'booking rate'], ['sold', 'sale rate']] as const) {
      const rated = arms.map((b) => ({ b, w: wilson(b[metric], b.leads) })).sort((x, y) => y.w.rate - x.w.rate);
      const compared = rated.filter((r) => r.b.leads >= MIN_ARM_LEADS);
      const describe = (r: typeof rated[number]) => `${armLabel(r.b.utmContent, proposal)} ${pct(r.w.rate)} (95% range ${pct(r.w.low)}–${pct(r.w.high)}, ${r.b[metric]}/${r.b.leads})`;
      const excluded = small.length ? ` Not compared (fewer than ${MIN_ARM_LEADS} tagged leads): ${small.map((b) => armLabel(b.utmContent, proposal)).join(', ')}.` : '';
      const Label = `${label[0]!.toUpperCase()}${label.slice(1)}`;
      let strength: FindingStrength, statement: string;
      if (compared.length < 2) {
        strength = 'insufficient_data';
        statement = `${Label} not compared yet: at least two concepts need ${MIN_ARM_LEADS} or more tagged leads each. Observed so far: ${rated.map(describe).join('; ')}.`;
      } else {
        const top = compared[0]!, bottom = compared.at(-1)!, others = compared.slice(1, -1);
        if (top.w.low > bottom.w.high) {
          strength = 'observed_difference';
          statement = `Observed difference in ${label} between the highest and lowest observed rates: ${describe(top)} versus ${describe(bottom)}.${others.length ? ` Also observed: ${others.map(describe).join('; ')}.` : ''} The two ranges do not overlap, but this is an observation from tagged contacts, not proof that the creative caused it.${excluded}`;
        } else {
          strength = 'no_clear_difference';
          statement = `No clear difference in ${label} can be read yet: ${compared.map(describe).join('; ')}. The ranges overlap, which does not show the rates are the same.${excluded}`;
        }
      }
      findings.push({ id: id('cmp', read.utmCampaign, metric, rated.map((r) => [r.b.utmContent, r.b[metric], r.b.leads])), kind: 'comparison', metric, strength, period, observedAt: read.readAt,
        evidence: rated.map((r) => evidenceOf(read, r.b)), statement });
    }
    notCompared.push(`Comparisons are deliberately cautious: a difference is reported only when two 95% ranges do not overlap, and only between concepts with at least ${MIN_ARM_LEADS} tagged leads each.`);
  }
  // The journal accepts at most 40 findings; observations beyond that are summarised rather than dropped silently.
  if (findings.length > MAX_FINDINGS) {
    const kept = findings.slice(0, MAX_FINDINGS - 1), dropped = findings.length - kept.length;
    findings.splice(0, findings.length, ...kept, { id: id('truncated', read.utmCampaign, dropped), kind: 'gap', strength: 'not_applicable', period, observedAt: read.readAt, evidence: [],
      statement: `${dropped} further finding${dropped === 1 ? '' : 's'} were not listed because this campaign carries more than ${MAX_FINDINGS} distinct tags.` });
  }
  return Object.freeze({ rules: LEARNING_RULES, utmCampaign: read.utmCampaign, readAt: read.readAt, findings: Object.freeze(findings), nextTests: Object.freeze(nextTests(findings, proposal)), notCompared });
}

/** At most three suggestions, each a single change with a control, a measure and a review date. Nothing is scheduled or funded. */
export function nextTests(findings: readonly Finding[], proposal: AcquisitionProposal | null): NextTest[] {
  const review = proposal?.measurement.reviewAfterDays ?? 14, out: NextTest[] = [];
  const none = findings.find((f) => f.kind === 'gap' && !f.evidence.length);
  const qualified = findings.find((f) => f.kind === 'comparison' && f.metric === 'qualified');
  const insufficient = findings.filter((f) => f.strength === 'insufficient_data');
  const stray = findings.filter((f) => f.kind === 'gap' && f.evidence.length);
  if (none) out.push({ id: id('t-capture', none.id), title: 'Confirm that leads keep their campaign tags', basedOn: [none.id], reviewAfterDays: review, budget: NO_BUDGET,
    change: 'Use the tracked links exactly as issued and check that the lead form you send people to stores utm_campaign and utm_content on the CRM contact.',
    keepTheSame: 'Concepts, artwork and destination.', measure: 'Tagged contacts appearing under this campaign.',
    why: 'Without tagged contacts there is nothing to learn from. Storing tags on a live form is a change to a shared workflow, so it needs your and the release owner’s decision.' });
  if (stray.length) out.push({ id: id('t-tags', stray.map((s) => s.id)), title: 'Use the artwork-tagged links', basedOn: stray.map((s) => s.id), reviewAfterDays: review, budget: NO_BUDGET,
    change: 'Replace untagged or concept-only links with the link issued for each approved artwork.', keepTheSame: 'Everything else.', measure: 'Share of contacts with a recognised concept and artwork tag.',
    why: 'Contacts without a recognised tag cannot be compared between concepts or artwork.' });
  if (qualified?.strength === 'observed_difference') {
    const lead = qualified.evidence[0]!, parsed = parseCreativeUtmContent(lead.utmContent)!;
    out.push({ id: id('t-iterate', qualified.id), title: `Test one change against ${armLabel(lead.utmContent, proposal)}`, basedOn: [qualified.id], reviewAfterDays: review, budget: NO_BUDGET,
      change: `Keep concept ${parsed.concept + 1} as the control and add one variant that changes only its headline.`, keepTheSame: 'Image, offer, destination, audience and channel.',
      measure: 'Qualified rate per tagged artwork, compared only once each has at least 20 tagged leads.',
      why: 'The observed difference may be real or may be chance; a single-change test against the same control is the smallest way to learn which element matters.' });
  } else if (qualified?.strength === 'no_clear_difference') {
    out.push({ id: id('t-distinct', qualified.id), title: 'Try a more distinct angle', basedOn: [qualified.id], reviewAfterDays: review, budget: NO_BUDGET,
      change: 'Write one new concept with a clearly different angle and keep the best-documented current concept running as the control.', keepTheSame: 'Offer, destination, audience and channel.',
      measure: 'Qualified rate per tagged artwork, compared once each has at least 20 tagged leads.', why: 'The ranges overlap, so no difference can be read yet. A clearly different angle is more likely to show one than a small wording change, and the current concept stays as the control.' });
  }
  const observed = findings.filter((f) => f.kind === 'observation');
  if (observed.length === 1) out.push({ id: id('t-second', observed[0]!.id), title: 'Add one variant to compare against', basedOn: [observed[0]!.id], reviewAfterDays: review, budget: NO_BUDGET,
    change: 'Hand off a second approved artwork (or concept) for the same channel, so each carries its own tracked link.', keepTheSame: 'The current artwork as the control, plus offer, destination and audience.',
    measure: `Qualified rate per tagged artwork, compared once each has at least ${MIN_ARM_LEADS} tagged leads.`,
    why: 'With a single tagged artwork there is nothing to compare, so no learning about the creative is possible yet.' });
  if (insufficient.length && out.length < 3) out.push({ id: id('t-wait', insufficient.map((f) => f.id)), title: 'Keep the current concepts running unchanged', basedOn: insufficient.map((f) => f.id), reviewAfterDays: review, budget: NO_BUDGET,
    change: 'No change. Continue using the issued tracked links.', keepTheSame: 'Everything.', measure: `Tagged leads per concept until each has at least ${MIN_ARM_LEADS}.`,
    why: 'Changing concepts now would reset the comparison before there is enough data to read it.' });
  return out.slice(0, 3);
}

/** Plain-text record for an owner who chooses to copy findings into brand guidance. Dated and evidence-linked. */
export function findingsText(snapshot: LearningSnapshot, recordedAt: string, campaignName: string): string {
  return [`Campaign findings: ${campaignName} (recorded ${day(recordedAt)}; outcomes read ${day(snapshot.readAt)}; rules ${snapshot.rules})`,
    ...snapshot.findings.map((f) => `- ${f.statement} [evidence: ${f.evidence.map((e) => `utm_campaign=${e.utmCampaign} utm_content=${e.utmContent || '(none)'}`).join('; ') || 'none'}]`),
    'Limits: counts come from CRM contacts carrying exact campaign tags; they are observations, not proof of cause.'].join('\n');
}

// ─── Cross-brand general patterns ──────────────────────────────────────────

/** A pattern may travel to the same owner's other brands only if it carries nothing brand-specific. */
export function generalPatternIssues(text: string, brandTerms: readonly string[]): string[] {
  const t = text.trim(), issues: string[] = [];
  if (t.length < 20 || t.length > 300) issues.push('Write the pattern in 20 to 300 characters.');
  if (/\d/u.test(t)) issues.push('Remove numbers: figures, prices and rates belong to the brand they came from.');
  if (/https?:|www\.|[a-z0-9-]+\.(?:com|co|uk|org|net|io|example)\b|@/iu.test(t)) issues.push('Remove links, domains and email addresses.');
  if (/#[0-9a-f]{3}\b|#[0-9a-f]{6}\b|\b(?:rgb|hsl)a?\(/iu.test(t)) issues.push('Remove colours: visual identity is not shared between brands.');
  if (/[£$€%]|\butm_/iu.test(t)) issues.push('Remove prices, percentages and tracking tags.');
  for (const term of brandTerms.map((x) => x.trim()).filter((x) => x.length >= 3)) {
    if (t.toLowerCase().includes(term.toLowerCase())) issues.push(`Remove “${term}”: brand names, offers and wording specific to a brand are not shared.`);
  }
  return [...new Set(issues)];
}

// ─── Persistence boundary (append-only; SQL recomputes evidence on record) ──

export interface RecordedFinding {
  readonly id: string;
  readonly campaignId: string;
  readonly utmCampaign: string;
  readonly read: OutcomeRead;
  readonly snapshot: LearningSnapshot;
  readonly recordedBy: string;
  readonly recordedAt: string;
}
export interface PatternDecision {
  readonly id: string; readonly patternId: string; readonly findingId: string; readonly statement: string;
  readonly state: 'shared' | 'withdrawn'; readonly decidedBy: string; readonly decidedAt: string;
}
export interface PatternRow { readonly patternId: string; readonly findingId: string; readonly statement: string; readonly state: 'shared' | 'withdrawn'; readonly decidedAt: string; readonly own: boolean }
export interface LearningStore {
  recordFinding(brandId: string, commandId: string, inputSha: string, finding: RecordedFinding): Promise<{ replayed: boolean; id: string }>;
  listFindings(brandId: string, campaignId?: string): Promise<RecordedFinding[]>;
  decidePattern(brandId: string, commandId: string, inputSha: string, decision: PatternDecision): Promise<{ replayed: boolean; id: string }>;
  /** `mine`: this brand's patterns incl. withdrawn; `other`: currently shared patterns of the same person's other managed brands. */
  patterns(brandId: string, scope: 'mine' | 'other'): Promise<PatternRow[]>;
}

/** In-memory mirror of the SQL rules for tests: evidence recomputed from a supplied outcome source, append-only, own-brand checks. */
export class MemoryLearningStore implements LearningStore {
  private readonly findings: (RecordedFinding & { brandId: string })[] = [];
  private readonly decisions: (PatternDecision & { brandId: string })[] = [];
  private readonly commands = new Map<string, { inputSha: string; id: string }>();
  constructor(private readonly outcomes: (brandId: string, utmCampaign: string) => Promise<readonly OutcomeBucket[]>,
    private readonly managedBy: (brandId: string) => readonly string[] = () => []) {}
  private replay(brandId: string, commandId: string, inputSha: string) {
    const c = this.commands.get(`${brandId}:${commandId}`);
    if (c && c.inputSha !== inputSha) throw new Error('This request was already used for something else.');
    return c ? { replayed: true, id: c.id } : null;
  }
  async recordFinding(brandId: string, commandId: string, inputSha: string, finding: RecordedFinding) {
    const r = this.replay(brandId, commandId, inputSha); if (r) return r;
    const key = (b: Pick<OutcomeBucket, 'utmContent' | 'leads' | 'qualified' | 'booked' | 'sold' | 'customers'>) => JSON.stringify([b.utmContent, b.leads, b.qualified, b.booked, b.sold, b.customers]);
    const actual = (await this.outcomes(brandId, finding.utmCampaign)).map(key).sort();
    if (JSON.stringify(actual) !== JSON.stringify(finding.read.buckets.map(key).sort())) throw new Error('Outcomes changed since these findings were prepared.');
    for (const f of finding.snapshot.findings) for (const e of f.evidence) if (!actual.includes(key(e)) || e.utmCampaign !== finding.utmCampaign) throw new Error('A finding cites outcomes that were not observed.');
    this.findings.push({ ...finding, brandId });
    this.commands.set(`${brandId}:${commandId}`, { inputSha, id: finding.id });
    return { replayed: false, id: finding.id };
  }
  async listFindings(brandId: string, campaignId?: string) {
    return this.findings.filter((f) => f.brandId === brandId && (!campaignId || f.campaignId === campaignId)).reverse().map(({ brandId: _b, ...f }) => f);
  }
  async decidePattern(brandId: string, commandId: string, inputSha: string, d: PatternDecision) {
    const r = this.replay(brandId, commandId, inputSha); if (r) return r;
    const latest = this.decisions.filter((x) => x.brandId === brandId && x.patternId === d.patternId).at(-1);
    if (d.state === 'withdrawn' ? latest?.state !== 'shared' : latest || !this.findings.some((f) => f.brandId === brandId && f.id === d.findingId)) throw new Error('Invalid pattern decision.');
    this.decisions.push({ ...d, brandId });
    this.commands.set(`${brandId}:${commandId}`, { inputSha, id: d.id });
    return { replayed: false, id: d.id };
  }
  async patterns(brandId: string, scope: 'mine' | 'other'): Promise<PatternRow[]> {
    const allowed = scope === 'mine' ? [brandId] : this.managedBy(brandId).filter((b) => b !== brandId);
    const latest = new Map<string, PatternDecision & { brandId: string }>();
    for (const d of this.decisions) if (allowed.includes(d.brandId)) latest.set(`${d.brandId}:${d.patternId}`, d);
    return [...latest.values()].filter((d) => scope === 'mine' || d.state === 'shared').reverse()
      .map((d) => ({ patternId: d.patternId, findingId: d.findingId, statement: d.statement, state: d.state, decidedAt: d.decidedAt, own: d.brandId === brandId }));
  }
}
