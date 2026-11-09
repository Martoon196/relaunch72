/**
 * Starter concepts drafted deterministically from approved brand facts only.
 * No model call, no spend, and nothing invented: every headline, body line and
 * price comes verbatim (trimmed) from the confirmed profile, the selected
 * article or the owner's own brief. Owners then edit freely; figures that are
 * not in approved facts are flagged and need explicit confirmation at approval.
 */
import type { CreativeBrandContext } from './brand-context.js';
import type { ArtworkIssue, BackgroundComponent, ConceptComponents, CreativeRequest } from './types.js';

export const COPY_LIMITS = Object.freeze({ hook: 48, headline: 90, body: 180, cta: 28, disclosure: 220, cardHeadline: 110, cardBody: 140 });

export interface ArticleSourceText {
  readonly title: string;
  readonly excerpt: string;
  readonly headings: readonly string[];
  readonly bodyText: string;
}

const tidy = (value: string) => value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
/** Trim at a sentence, then a word boundary; never mid-word, never adds content. */
export function clip(value: string, limit: number): string {
  const text = tidy(value);
  if ([...text].length <= limit) return text;
  const chars = [...text].slice(0, limit).join('');
  const sentence = chars.lastIndexOf('. ');
  if (sentence > limit * 0.5) return chars.slice(0, sentence + 1);
  const space = chars.lastIndexOf(' ');
  return `${(space > limit * 0.4 ? chars.slice(0, space) : chars).replace(/[,;:\s-]+$/u, '')}…`;
}
function firstSentence(value: string): string {
  const text = tidy(value);
  const match = /^(.{12,}?[.!?])(\s|$)/u.exec(text);
  return match ? match[1]! : text;
}

/** Tokens containing digits (prices, percentages, counts, years), normalised for comparison. */
export function figures(text: string): string[] {
  return [...text.matchAll(/[£$€]?\d[\d,.]*(?:\s?(?:%|k|m|bn|x|\/\d+))?/giu)].map((m) => m[0].toLowerCase().replace(/[,\s]/gu, '').replace(/\.$/u, ''));
}

export function factsCorpus(context: CreativeBrandContext, article: ArticleSourceText | null): string {
  return [context.positioning, context.summary, ...context.approvedClaims,
    ...context.offers.flatMap((o) => [o.name, o.description, o.price ?? '']),
    ...context.destinations.map((d) => d.label), context.disclosure ?? '',
    ...(article ? [article.title, article.excerpt, ...article.headings, article.bodyText] : [])].join('\n');
}

/** Copy checks shared by drafting, owner edits and approval. */
export function copyIssues(concept: Pick<ConceptComponents, 'hook' | 'headline' | 'body' | 'cta' | 'cards'>, context: CreativeBrandContext, corpus: string): ArtworkIssue[] {
  const issues: ArtworkIssue[] = [];
  const all = [concept.hook, concept.headline, concept.body, concept.cta, ...concept.cards.flatMap((c) => [c.headline, c.body])].join('\n');
  const known = new Set(figures(corpus));
  const unsupported = [...new Set(figures(all))].filter((f) => !known.has(f));
  if (unsupported.length) issues.push({ code: 'unsupported_figure', blocking: false, detail: `These figures are not in the brand's approved facts: ${unsupported.join(', ')}. Confirm they are accurate before approval, or remove them.` });
  const lower = all.toLowerCase();
  for (const phrase of context.restricted) {
    const p = tidy(phrase).toLowerCase();
    if (p.length >= 3 && lower.includes(p)) issues.push({ code: 'restricted_phrase', blocking: true, detail: `The copy uses a restricted phrase for this brand: "${clip(phrase, 60)}".` });
  }
  return issues;
}

interface Angle { readonly key: string; readonly label: string; readonly build: () => Omit<ConceptComponents, 'background' | 'illustrativeTag' | 'cards' | 'angle'> | null }

/** Draft up to `request.conceptCount` distinct concepts. Returns fewer when the facts support fewer distinct angles. */
export function draftConcepts(input: {
  readonly context: CreativeBrandContext;
  readonly request: CreativeRequest;
  readonly article: ArticleSourceText | null;
  readonly background: BackgroundComponent;
}): { concepts: ConceptComponents[]; note: string | null } {
  const { context, request, article } = input;
  const source = request.source;
  const offer = source.kind === 'offer' ? context.offers.find((o) => o.name === source.name) ?? null : null;
  const audience = request.audience ? clip(request.audience, 40) : null;
  const ctaLabel = request.destination ? clip(request.destination.label, COPY_LIMITS.cta) : source.kind === 'article' ? 'Read the guide' : 'Find out more';
  const pricedHeadline = (name: string) => offer?.price && request.purpose !== 'organic_social' ? `${name} — ${offer.price}` : name;
  const claims = context.approvedClaims.map(tidy).filter(Boolean);
  const angles: Angle[] = [];
  if (source.kind === 'offer' && offer) {
    angles.push({ key: 'offer', label: 'Offer-led', build: () => ({ hook: audience ? `For ${audience}` : clip(context.brandName, COPY_LIMITS.hook), headline: clip(pricedHeadline(offer.name), COPY_LIMITS.headline), body: clip(offer.description, COPY_LIMITS.body), cta: ctaLabel }) });
    if (claims[0]) angles.push({ key: 'proof', label: 'Approved-claim led', build: () => ({ hook: clip(offer.name, COPY_LIMITS.hook), headline: clip(claims[0]!, COPY_LIMITS.headline), body: clip(offer.description, COPY_LIMITS.body), cta: ctaLabel }) });
    if (context.positioning) angles.push({ key: 'positioning', label: 'Positioning-led', build: () => ({ hook: clip(offer.name, COPY_LIMITS.hook), headline: clip(firstSentence(context.positioning), COPY_LIMITS.headline), body: clip(claims[1] ?? offer.description, COPY_LIMITS.body), cta: ctaLabel }) });
  } else if (source.kind === 'article' && article) {
    angles.push({ key: 'article', label: 'Article-led', build: () => ({ hook: 'New guide', headline: clip(article.title, COPY_LIMITS.headline), body: clip(article.excerpt, COPY_LIMITS.body), cta: ctaLabel }) });
    if (article.headings[0]) angles.push({ key: 'takeaway', label: 'Takeaway-led', build: () => ({ hook: clip(article.title, COPY_LIMITS.hook), headline: clip(article.headings[0]!, COPY_LIMITS.headline), body: clip(article.excerpt, COPY_LIMITS.body), cta: ctaLabel }) });
    if (claims[0]) angles.push({ key: 'proof', label: 'Approved-claim led', build: () => ({ hook: clip(context.brandName, COPY_LIMITS.hook), headline: clip(claims[0]!, COPY_LIMITS.headline), body: clip(article.title, COPY_LIMITS.body), cta: ctaLabel }) });
  } else if (source.kind === 'brief') {
    const text = tidy(source.text), lead = firstSentence(text), rest = tidy(text.slice(lead.length));
    angles.push({ key: 'brief', label: 'Brief-led', build: () => ({ hook: audience ? `For ${audience}` : clip(context.brandName, COPY_LIMITS.hook), headline: clip(lead, COPY_LIMITS.headline), body: clip(rest || context.positioning, COPY_LIMITS.body), cta: ctaLabel }) });
    if (claims[0]) angles.push({ key: 'proof', label: 'Approved-claim led', build: () => ({ hook: clip(lead, COPY_LIMITS.hook), headline: clip(claims[0]!, COPY_LIMITS.headline), body: clip(rest || context.positioning, COPY_LIMITS.body), cta: ctaLabel }) });
    if (context.positioning) angles.push({ key: 'positioning', label: 'Positioning-led', build: () => ({ hook: clip(lead, COPY_LIMITS.hook), headline: clip(firstSentence(context.positioning), COPY_LIMITS.headline), body: clip(rest || claims[1] || context.summary, COPY_LIMITS.body), cta: ctaLabel }) });
  }
  const concepts: ConceptComponents[] = [];
  const seen = new Set<string>();
  for (const angle of angles) {
    if (concepts.length >= request.conceptCount) break;
    const built = angle.build();
    if (!built || !built.headline || seen.has(built.headline.toLowerCase())) continue;
    seen.add(built.headline.toLowerCase());
    const cards = request.purpose === 'carousel' ? carouselCards(built, request.cardCount, { claims, article, offer: offer ? { description: offer.description } : null, ctaLabel }) : [];
    concepts.push(Object.freeze({ angle: angle.label, ...built, background: input.background,
      illustrativeTag: input.background.kind === 'image' && input.background.origin === 'generated_article_image', cards: Object.freeze(cards) }));
  }
  const note = concepts.length < request.conceptCount
    ? `Only ${concepts.length} distinct concept${concepts.length === 1 ? '' : 's'} can be drafted from the approved facts for this source. Add approved claims or positioning to unlock more angles; nothing was invented to fill the gap.`
    : null;
  return { concepts, note };
}

function carouselCards(lead: { headline: string; body: string }, count: number, facts: { claims: string[]; article: ArticleSourceText | null; offer: { description: string } | null; ctaLabel: string }): Readonly<{ headline: string; body: string }>[] {
  const middle = [...(facts.article?.headings ?? []), ...facts.claims, ...(facts.offer ? facts.offer.description.split(/(?<=[.!?])\s+/u) : [])]
    .map(tidy).filter((t) => t && t.toLowerCase() !== lead.headline.toLowerCase());
  const cards: { headline: string; body: string }[] = [{ headline: clip(lead.headline, COPY_LIMITS.cardHeadline), body: clip(lead.body, COPY_LIMITS.cardBody) }];
  for (const text of middle) { if (cards.length >= count - 1) break; cards.push({ headline: clip(text, COPY_LIMITS.cardHeadline), body: '' }); }
  cards.push({ headline: clip(facts.ctaLabel, COPY_LIMITS.cardHeadline), body: '' });
  return cards.slice(0, Math.max(2, count)).map((c) => Object.freeze(c));
}
