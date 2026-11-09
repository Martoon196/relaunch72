/**
 * Deterministic evidence pack for an acquisition campaign proposal. Built on the
 * server from the brand's own saved records only: dated research already
 * gathered for its topic plans, confirmed audience/FAQ guidance, and articles
 * the owner chose. No search, fetch or model call happens here. The pack is
 * stored with the campaign brief so every later edit and approval is checked
 * against exactly the evidence the proposal was written from.
 */
import { currentKnowledge } from './method-evidence.js';
import type { Article, ArticleVersion, BrandProfile, KnowledgeDocument, ResearchSource, TopicPlan } from './types.js';

export const ACQUISITION_EVIDENCE_LIMITS = Object.freeze({ research: 6, passage: 400, facts: 4, factText: 400, articles: 3, articleText: 300 });

export interface AcquisitionFact { readonly id: string; readonly kind: 'knowledge' | 'article'; readonly title: string; readonly text: string; readonly url: string | null }
export interface AcquisitionEvidence {
  readonly research: readonly ResearchSource[];
  readonly facts: readonly AcquisitionFact[];
  /** Plain statements of what is missing; shown to the owner and the model. */
  readonly gaps: readonly string[];
}

const trim = (value: string, max: number) => {
  const text = value.replace(/\s+/gu, ' ').trim();
  return [...text].length <= max ? text : `${[...text].slice(0, max - 1).join('').replace(/\s+\S*$/u, '')}…`;
};

export function buildAcquisitionEvidence(input: {
  readonly profile: BrandProfile;
  readonly knowledge: readonly KnowledgeDocument[];
  readonly plans: readonly TopicPlan[];
  readonly articles: readonly { article: Article; version: ArticleVersion }[];
}): AcquisitionEvidence {
  const { profile } = input;
  const seen = new Set<string>();
  const plans = [...input.plans].filter((p) => p.brandId === profile.brandId && p.status !== 'rejected')
    .sort((a, b) => (a.status === 'accepted' ? 0 : 1) - (b.status === 'accepted' ? 0 : 1) || b.createdAt.localeCompare(a.createdAt));
  const research: ResearchSource[] = [];
  for (const plan of plans) for (const source of plan.sources) {
    if (research.length >= ACQUISITION_EVIDENCE_LIMITS.research || seen.has(source.url) || !source.passage?.trim()) continue;
    seen.add(source.url);
    research.push({ ...source, title: trim(source.title, 200), passage: trim(source.passage, ACQUISITION_EVIDENCE_LIMITS.passage) });
  }
  // Only guidance bound to the confirmed profile; audience notes and FAQs describe problems and objections.
  const bound = currentKnowledge(input.knowledge).filter((d) => d.brandId === profile.brandId && d.text && ['audience_notes', 'faqs'].includes(d.category)
    && profile.knowledge.some((k) => k.documentId === d.id && k.version === d.version && k.sha256 === d.sha256));
  const facts: AcquisitionFact[] = bound.slice(0, ACQUISITION_EVIDENCE_LIMITS.facts).map((d) => ({
    id: `knowledge:${d.id}:${d.version}`, kind: 'knowledge', title: trim(d.title, 120), text: trim(d.text!, ACQUISITION_EVIDENCE_LIMITS.factText), url: null }));
  for (const { article, version } of input.articles.slice(0, ACQUISITION_EVIDENCE_LIMITS.articles)) {
    if (article.brandId !== profile.brandId || version.articleId !== article.id) continue;
    facts.push({ id: `article:${article.id}`, kind: 'article', title: trim(version.body.title, 160),
      text: trim(`${version.body.title}. ${version.body.excerpt}`, ACQUISITION_EVIDENCE_LIMITS.articleText), url: article.publishedUrl });
  }
  const gaps: string[] = [];
  if (!research.length) gaps.push('No saved research exists for this brand yet, so audience problems can only be inferred from your own guidance. Run topic research to add dated evidence.');
  if (!bound.length) gaps.push('No confirmed audience notes or FAQs are on file, so objections cannot be evidenced from customer language.');
  if (!profile.approvedClaims.length) gaps.push('The profile has no approved claims, so proof points are limited to offer descriptions.');
  return Object.freeze({ research: Object.freeze(research), facts: Object.freeze(facts), gaps: Object.freeze(gaps) });
}

/** Evidence references the model may cite: profile facts, these owner facts and these research sources. */
export function acquisitionReferenceKinds(profile: BrandProfile, evidence: AcquisitionEvidence): Map<string, 'profile' | 'knowledge' | 'article' | 'research'> {
  const refs = new Map<string, 'profile' | 'knowledge' | 'article' | 'research'>();
  profile.approvedClaims.forEach((_c, i) => refs.set(`profile:${profile.version}:claim:${i}`, 'profile'));
  profile.offers.forEach((_o, i) => refs.set(`profile:${profile.version}:offer:${i}`, 'profile'));
  for (const f of evidence.facts) refs.set(f.id, f.kind);
  evidence.research.forEach((s, i) => { refs.set(s.id, 'research'); refs.set(`S${i + 1}`, 'research'); });
  return refs;
}
