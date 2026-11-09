/** Fictional deterministic acquisition-proposal fixtures; never a live-model quality claim. */
import { createHash, randomUUID } from 'node:crypto';
import type { LlmRequest } from '../src/llm/client.js';
import { CampaignCreator, type AcquisitionProposal, type CampaignBrief } from '../src/seo-blog/campaign-creator.js';
import { MethodController } from '../src/seo-blog/method-packs.js';
import { MemoryMethodStore } from '../src/seo-blog/method-store.js';
import { MemorySeoBlogStore } from '../src/seo-blog/store.js';
import type { KnowledgeDocument, ResearchSource, TopicPlan } from '../src/seo-blog/types.js';
import { block, fixtureBrand } from './rl72-method-fixtures.js';
import { concreteSidecar, MemoryCreatorFixture, UpgradeFixtureModel, upgradeSnapshot } from './rl72-upgrade-fixtures.js';

export class AcquisitionFixtureModel extends UpgradeFixtureModel {
  acquisitionCalls = 0;
  override async complete(request: LlmRequest) {
    if (request.meta?.stage !== 'SEO_ACQUISITION_CAMPAIGN') return super.complete(request);
    this.acquisitionCalls++; this.requests.push(request);
    const text = request.messages[0]!.content;
    const b = block(text, 'campaign_brief') as CampaignBrief, ctx = block(text, 'method_context');
    const claim = ctx.factReferences.find((f: { id: string }) => /:claim:/.test(f.id))?.id as string;
    const offer = ctx.factReferences.find((f: { id: string }) => /:offer:/.test(f.id))?.id as string;
    const research = b.evidence!.research.length ? 'S1' : null, fact = b.evidence!.facts[0]?.id ?? null;
    const result: AcquisitionProposal & { _method_sidecar?: unknown } = {
      title: b.name, summary: 'A practical acquisition proposal grounded in the supplied research and approved facts, for owner review.',
      objective: { goal: b.goal, primaryMetric: 'Qualified enquiries from the confirmed destination' },
      insights: [
        { type: 'problem', statement: 'Readers are unsure which practical check matters first.', evidence: [research ?? claim], basis: research ? 'observed' : 'inferred' },
        { type: 'objection', statement: 'Some readers worry the next step will commit them before they understand it.', evidence: [fact ?? claim], basis: fact ? 'observed' : 'inferred' },
        { type: 'opportunity', statement: 'A clear, low-pressure next step fits readers who are still comparing options.', evidence: [offer], basis: 'inferred' },
      ],
      channels: b.channels!.map((channel) => ({ channel, role: 'Reach readers with the practical check', rationale: 'This channel suits short, practical explanations for this audience.' })),
      concepts: Array.from({ length: b.count }, (_, i) => ({
        name: ['Start with the check', 'Answer the worry', 'The calm next step'][i]!, angle: ['Practical first step', 'Objection handling', 'Low-pressure invitation'][i]!,
        hook: ['What should you check first?', 'Not sure what happens next?', 'Ready when you are.'][i]!,
        headline: ['Know which check comes first', 'See the next step before you commit', 'A calm next step when it suits you'][i]!,
        primaryText: 'A short practical explanation drawn from the brand facts, ending with the confirmed next step and no invented results.',
        cta: b.cta, channels: [b.channels![0]!], addresses: [i % 3], creativeDirection: 'A clearly illustrative, uncluttered scene showing a calm planning moment.' })),
      measurement: { primaryMetric: 'Qualified enquiries through the confirmed destination', secondaryMetrics: ['Landing page visits from tracked links'], reviewAfterDays: 14,
        learningRule: 'Keep the concept that produces more qualified enquiries once each has had a fair run; otherwise keep testing.', limitations: ['Organic reach and view-through effects are not fully attributable to a tracked link.'] },
      hypotheses: [{ statement: 'The practical-check concept may attract more qualified enquiries than the general invitation.', basis: 'The research suggests readers start with practical questions.' }],
    };
    result._method_sidecar = concreteSidecar(request, result);
    this.mutate?.(result, request);
    return { text: JSON.stringify(result), tokensIn: 120, tokensOut: 180, stopReason: 'end_turn', model: 'deterministic-acquisition-fixture' };
  }
}

export function researchSource(n: number, url = `https://evidence.example/report-${n}`): ResearchSource {
  return { id: `src-${n}`, url, title: `Fictional practical-check report ${n}`, retrievedAt: '2026-11-01T09:00:00.000Z', publishedAt: '2026-10-01T00:00:00.000Z', observedPeriod: null, confidence: 'medium',
    passage: `Fictional survey passage ${n}: readers said they first want to know which practical check matters before they contact anyone. `.repeat(n === 1 ? 6 : 1), provider: 'fixture', primary: false, query: 'practical checks' };
}
export function plan(brandId: string, status: TopicPlan['status'], sources: ResearchSource[], createdAt = '2026-11-02T00:00:00.000Z'): TopicPlan {
  return { id: randomUUID(), brandId, status, topic: 'Practical checks', moneyPage: null, briefIds: [], sources, inputs: { focus: null, excluded: [], sourceArticleUrl: null },
    profileVersion: 1, inventoryAt: null, generation: { mode: 'simulated', model: 'fixture', promptVersion: 'fixture', tokensIn: 0, tokensOut: 0 }, createdAt, acceptedAt: status === 'accepted' ? createdAt : null };
}
export function audienceNote(brandId: string, text: string): KnowledgeDocument {
  return { id: randomUUID(), brandId, version: 1, category: 'audience_notes', title: 'What enquirers ask', filename: null, format: null, mime: 'text/plain', sizeBytes: text.length,
    sha256: createHash('sha256').update(text).digest('hex'), blobId: null, status: 'extracted', statusDetail: 'Fixture', text, pagesRead: null, pagesTotal: null, active: true, createdAt: '2026-11-01T00:00:00.000Z' };
}

/** A brand with the reviewed packs pinned, optionally with bound audience guidance and saved research. */
export async function acquisitionFixture(options: { research?: boolean; note?: boolean; pins?: string[] } = {}) {
  const f = fixtureBrand('home'), blogs = new MemorySeoBlogStore(), actor = f.profile.confirmedBy!;
  const created = await blogs.createBrand({ commandId: randomUUID(), actorId: actor, name: f.brand.name, slug: 'fixture-' + randomUUID(), website: f.brand.website, now: f.profile.createdAt });
  const brand = await blogs.updateBrand({ ...created.brand, settings: f.brand.settings });
  const note = options.note === false ? null : audienceNote(brand.id, 'Enquirers often ask whether the first conversation commits them to anything.');
  if (note) await blogs.saveKnowledge(note);
  const profile = { ...f.profile, brandId: brand.id, knowledge: note ? [{ documentId: note.id, version: note.version, sha256: note.sha256, category: note.category }] : [] };
  await blogs.saveProfile(profile);
  if (options.research !== false) {
    await blogs.savePlan(plan(brand.id, 'accepted', [researchSource(1), researchSource(2)]));
    await blogs.savePlan(plan(brand.id, 'proposed', [researchSource(1), researchSource(3)], '2026-11-03T00:00:00.000Z'));
    await blogs.savePlan(plan(brand.id, 'rejected', [researchSource(9)]));
  }
  const methods = new MemoryMethodStore(); methods.snapshots.set(brand.id, upgradeSnapshot(brand.id, options.pins));
  const controller = new MethodController(methods, true), model = new AcquisitionFixtureModel(), store = new MemoryCreatorFixture(methods);
  const creator = new CampaignCreator(store, blogs, controller, model);
  return { ...f, brand, profile, blogs, actor, methods, controller, model, store, creator, note };
}

export function acquisitionBrief(profile: { audiences: readonly string[]; conversionPages: readonly { label: string; url: string }[] }, extra: Partial<CampaignBrief> = {}): CampaignBrief {
  return { kind: 'acquisition', purpose: 'acquisition', name: 'Spring enquiries', goal: 'Help readers take a calm first step towards an enquiry.', audience: profile.audiences[0]!, count: 3,
    cta: profile.conversionPages[0]!, offerName: null, permissionContext: 'Campaign proposal only; the owner decides channels, audiences, budgets and activation separately.',
    customerMoment: '', consentProcess: '', incentiveTerms: 'None', objective: 'leads', channels: ['instagram', 'linkedin'], articleIds: [], ...extra };
}
