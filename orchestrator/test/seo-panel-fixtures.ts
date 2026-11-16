/** Briefs for the SEO report tests and screenshots: measured, not measured, none, and a strong article. */
import type { ArticleBody, ArticleBrief } from '../src/seo-blog/types.js';
import * as fx from './seo-blog-article-page-fixtures.js';

export function brief(overrides: Partial<ArticleBrief> = {}): ArticleBrief {
  return {
    id: 'b1', planId: 'p1', brandId: fx.BRAND_ID, role: 'pillar', slug: 'appraise-uk-property-deal-maximum-offer', workingTitle: 'How to appraise a UK property deal',
    targetQuery: 'appraise a property deal', searchIntent: 'learn',
    relatedQuestions: ['How long should a property appraisal take?', 'What contingency should I allow for a refurbishment?', 'How do I work out my maximum offer?', 'How do lenders value a property?'],
    angle: 'A plain step-by-step method', outline: [], keyPoints: [], cta: null, internalLinks: [],
    whyFit: 'Investors who come to Martin Howard Property ask how to judge a deal before they offer. This article answers that and leads to a free deal review.',
    demand: { kind: 'qualitative', rationale: 'No measured search data was available; chosen from the brand’s audiences, offers, content gaps and research.' },
    sourceIds: [], duplicate: { verdict: 'distinct', score: 0, against: null, againstKind: null, advice: '' }, status: 'generated', suggestedAtUtc: null, articleId: fx.ARTICLE_ID,
    ...overrides,
  } as ArticleBrief;
}

export const measured = (volume = 1300) => brief({ demand: { kind: 'measured', volume, competition: 42, provider: 'dataforseo', retrievedAt: '2026-11-03T10:00:00.000Z' } });

/** A version of the fixture article written to score well against "appraise a property deal". */
export function strongBody(): ArticleBody {
  const b = fx.body();
  const link = '[book a deal review](https://www.martinhowardproperty.example/deal-review)';
  return {
    ...b,
    seoTitle: 'Appraise a property deal: how to set your maximum offer',
    metaDescription: 'Learn how to appraise a property deal step by step, so you know the end value, every cost and the most you should offer.',
    slug: 'appraise-a-property-deal',
    intro: `If you want to appraise a property deal well, start with the end value and work back. **So** you can say yes quickly to the good ones and walk away from the rest [src:5452de1e-e616-492b-8fa5-eb393534457d].\n\nThis guide takes you through the numbers in the order that matters.`,
    sections: [
      { ...b.sections[0]!, heading: 'How to appraise a property deal, step by step' },
      ...b.sections.slice(1, 9),
      { ...b.sections[9]!, body: `${b.sections[9]!.body}\n\nIf you want a second opinion, ${link}. Because a fresh pair of eyes often spots the cost you missed, it is worth it.` },
      { id: 'extra-1', heading: 'How do lenders value a property?', body: 'A lender’s valuer looks at recent sales of similar homes nearby. So use the same sales when you appraise a property deal, and you will rarely be surprised.\n\nFor example, if three similar homes sold for about the same price, that price is your guide. However, adjust it for condition and parking.' },
      { id: 'extra-2', heading: 'How do I work out my maximum offer?', body: 'Take the end value and subtract every cost and the profit you need. What is left is your maximum offer. Then offer a little below it, so you have room to negotiate.\n\nBecause the numbers are written down, you can explain your offer to the agent. As a result, sellers take it more seriously.' },
    ],
    image: { kind: 'brand_asset', url: 'https://www.martinhowardproperty.example/images/terrace.jpg', alt: 'An investor about to appraise a property deal on a terraced street', provenance: '', width: 1536, height: 1024 },
  } as ArticleBody;
}
