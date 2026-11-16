/**
 * A realistic, full-length article for the article page and the articles list: ten parts with lists, bold and
 * citations, five questions, two accompanying posts, six sources and three versions. Pure data: no engine.
 */
import type { Article, ArticleBody, ArticleBrief, ArticleVersion, Brand, CheckIssue, Destination, Job, Publication } from '../src/seo-blog/types.js';
import { DEFAULT_BRAND_SETTINGS } from '../src/seo-blog/types.js';
import { sha256 } from '../src/seo-blog/engine.js';
import type { Shell } from '../src/portal/seo-blog-view.js';
import type { ArticleListRow, ArticlePageData } from '../src/portal/seo-blog-article-view.js';

export const NOW = '2026-11-16T12:00:00.000Z';
export const BRAND_ID = '0b8f5a3e-7a71-4c55-9a43-8a1f3c1d2e10';
export const ARTICLE_ID = '5c0e7a1b-2d3f-4e5a-8b6c-7d8e9f0a1b2c';
const SOURCE = ['5452de1e-e616-492b-8fa5-eb393534457d', '0f9a2b3c-4d5e-4f60-8a1b-2c3d4e5f6a7b', '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', '3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f', '4d5e6f7a-8b9c-4d0e-9f2a-3b4c5d6e7f80'];
const s = (i: number) => `[src:${SOURCE[i]}]`;

export const brand: Brand = {
  id: BRAND_ID, slug: 'martin-howard-property', name: 'Martin Howard Property', website: 'https://www.martinhowardproperty.example', locale: 'en-GB', timezone: 'Europe/London',
  settings: { ...DEFAULT_BRAND_SETTINGS, budgets: { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 20 } }, rowVersion: 4, createdAt: '2026-09-01T09:00:00.000Z',
} as unknown as Brand;

const sections: [string, string][] = [
  ['Start with the end value, not the asking price', `The asking price tells you what the seller hopes for. **The end value tells you what the deal is worth.** Comparable sales in the same street over the last twelve months are the most reliable guide ${s(0)}.\n\nPull at least three sales of similar homes, then adjust for condition, size and parking.`],
  ['Work out every cost of buying', `Buying costs are easy to underestimate. Before you offer, list each one:\n\n- **Stamp Duty Land Tax**, using the current rates for additional homes ${s(1)}\n- Legal fees and searches\n- A survey that matches the age of the building\n- Lender arrangement and valuation fees\n\nAdd them up before you think about the work.`],
  ['Price the refurbishment properly', `A refurbishment budget is only as good as the quotes behind it. Ask two builders to price the same written schedule of works, and keep a **contingency of at least 10%** for what you cannot see ${s(2)}.\n\nKitchens, bathrooms and rewiring are where budgets most often slip.`],
  ['Include the costs of holding the property', `While the work happens you still pay for the property. Count the months of mortgage interest, council tax, insurance and utilities until it is sold or let.\n\nA three-month delay can turn a good margin into a thin one.`],
  ['Know the rent the market will pay', `If you plan to let the property, check achieved rents rather than advertised ones. Local letting agents and recent listings that have let quickly give the clearest picture ${s(3)}.\n\n1. Find three similar homes that let in the last six months\n2. Note how long each took to let\n3. Use the middle figure, not the highest`],
  ['Check what a lender will value it at', `Your plan depends on the lender agreeing with your end value. A lender's valuer will look at the same comparable sales, so **use their method, not your hopes**.\n\nIf the numbers only work at the top of the range, the deal is too tight.`],
  ['Decide the profit you need', `Set your minimum profit before you look at the figures, so the figures cannot talk you round. Many investors aim for a margin of around 20% of the end value on a refurbish-and-sell project ${s(4)}.\n\nWrite the number down and stick to it.`],
  ['Turn it into a maximum offer', `Now work backwards. Take the end value, subtract every cost and the profit you need. What is left is your **maximum offer**.\n\n- End value\n- minus buying costs\n- minus refurbishment and contingency\n- minus holding costs\n- minus your profit\n\nOffer below it, so you have room to negotiate.`],
  ['Test the deal against a bad day', `Run the same sums again with the end value 5% lower and the works 15% dearer. If the deal still makes a profit, it is robust ${s(5)}.\n\nIf it falls apart, walk away or lower your offer.`],
  ['Keep a record of every appraisal', `Keep each appraisal, even for the deals you do not buy. Over a year you build a picture of your area that makes every next offer faster and more confident.\n\nA simple spreadsheet with the address, the figures and your decision is enough.`],
];

export function body(overrides: Partial<ArticleBody> = {}): ArticleBody {
  return {
    title: 'How to Appraise a UK Property Deal and Set Your Maximum Offer', seoTitle: 'How to appraise a UK property deal | Martin Howard Property',
    metaDescription: 'A step-by-step way to appraise a UK property deal: end value, buying and refurbishment costs, holding costs and the maximum you should offer.',
    excerpt: 'Work backwards from the end value to an offer you can defend, with every cost counted.', slug: 'appraise-uk-property-deal-maximum-offer',
    intro: `Most property deals are won or lost before you make an offer. If you know how to appraise a deal, you can say **yes** quickly to the good ones and walk away calmly from the rest ${s(0)}.\n\nThis guide takes you through the numbers in the order that matters.`,
    sections: sections.map(([heading, text], i) => ({ id: `0000000${i}-aaaa-4bbb-8ccc-00000000000${i}`, heading, body: text })),
    conclusion: 'Appraising a deal is a habit, not a talent. Do the same sums the same way every time and your maximum offer becomes a number you can trust.',
    cta: { label: 'Book a free deal review', url: 'https://www.martinhowardproperty.example/contact' },
    faqs: [
      { q: 'How long should a property appraisal take?', a: 'Once you have a routine, about an hour for a first look and an afternoon for a deal you are serious about.' },
      { q: 'What contingency should I allow?', a: `Allow at least 10% of the refurbishment budget, and more for older buildings ${s(2)}.` },
      { q: 'Should I trust the estate agent’s valuation?', a: 'Use it as one view. Check it against recent sold prices, not asking prices.' },
      { q: 'What if the numbers only just work?', a: 'Lower your offer or walk away. A thin margin leaves no room for surprises.' },
      { q: 'Do I need a survey for every deal?', a: 'For any deal you are going to buy, yes. Match the survey to the age and condition of the building.' },
    ],
    citations: SOURCE.map((id, i) => ({ sourceId: id, url: ['https://www.gov.uk/government/statistical-data-sets/uk-house-price-index-data-downloads', 'https://www.gov.uk/stamp-duty-land-tax/residential-property-rates', 'https://www.rics.org/news-insights/refurbishment-cost-guide', 'https://www.ons.gov.uk/economy/inflationandpriceindices/bulletins/privaterentandhousepricesuk', 'https://www.propertyinvestorstoday.example/margins-survey', 'https://www.bankofengland.co.uk/monetary-policy-summary'][i]!,
      title: ['UK House Price Index', 'Stamp Duty Land Tax: residential property rates', 'Refurbishment cost guide', 'Private rent and house prices, UK', 'Investor margins survey 2026', 'Monetary Policy Summary'][i]!,
      retrievedAt: '2026-11-01T10:00:00.000Z', passage: ['Average prices of similar homes sold in the same street over twelve months give the most reliable guide to value.', 'Higher rates apply to purchases of additional residential properties.', 'A contingency of at least 10% is advised for refurbishment projects.', 'Achieved rents rose across most regions in the year to October 2026.', 'Respondents targeted a margin of around 20% of end value.', 'Values 5% lower and works 15% dearer are common stress tests.'][i]!, public: i !== 4 })),
    image: { kind: 'none', url: null, alt: 'A terraced house with scaffolding during a refurbishment', provenance: 'No image selected yet.', width: null, height: null },
    author: null, ...overrides,
  } as ArticleBody;
}

export function version(n: number, b = body(), change: ArticleVersion['change'] = n === 1 ? 'generated' : 'edited'): ArticleVersion {
  const id = `9000000${n}-bbbb-4ccc-8ddd-00000000000${n}`;
  const contentSha = sha256(b);
  return { id, articleId: ARTICLE_ID, brandId: BRAND_ID, number: n, parentVersionId: null, change, changedSectionId: null, createdAt: `2026-11-1${n}T09:1${n}:00.000Z`, createdBy: 'owner', body: b,
    profileVersion: 1, factsSha: 'f'.repeat(64), knowledge: [], briefId: 'b1', planId: 'p1', generation: { mode: 'live' } as never, contentSha,
    promotionPack: { source: 'relaunch72.seo-blog', brandId: BRAND_ID, articleId: ARTICLE_ID, versionId: id, contentSha, profileVersion: 1, factsSha: 'f'.repeat(64), canonicalUrl: 'https://www.martinhowardproperty.example/blog/appraise-uk-property-deal-maximum-offer', generation: null, mode: 'model',
      posts: [
        { network: 'linkedin', title: 'Appraising a deal', copy: 'Most property deals are won or lost before you make an offer.\n\nWe have written a plain guide to appraising a UK deal: start from the end value, count every cost, and work back to the most you should pay.', artworkInstructions: 'A clean photo of a terraced street with a calculator and notes.' },
        { network: 'instagram', title: 'Your maximum offer', copy: 'Your maximum offer is a number you work out, not a feeling. End value minus every cost minus your profit. Full guide on our blog.', artworkInstructions: 'A bold card with the words “Work backwards”.' },
      ] } } as ArticleVersion;
}

export const versions = [version(1), version(2), version(3)];
const current = versions[2]!;

export function article(overrides: Partial<Article> = {}): Article {
  return { id: ARTICLE_ID, brandId: BRAND_ID, briefId: 'b1', planId: 'p1', slug: current.body.slug, editorialState: 'draft', currentVersionId: current.id, requiresApproval: false, approval: null,
    checks: { versionId: current.id, contentSha: current.contentSha, factsSha: 'f'.repeat(64), ranAt: '2026-11-13T09:00:00.000Z', status: 'warnings', issues: warnings },
    schedule: null, hold: null, delivery: 'none', publishedVersionId: null, publishedUrl: null, lastAttemptAt: null, publishedAt: null, failure: null, createdAt: '2026-11-11T09:00:00.000Z', rowVersion: 7, ...overrides } as Article;
}

export const warnings: CheckIssue[] = [
  { code: 'image.none', severity: 'warning', message: 'No featured image is selected.', fix: 'Choose a brand asset, upload an image or generate an illustrative one.', location: null },
  { code: 'meta.author_missing', severity: 'warning', message: 'No author attribution is configured; the brand name will be used.', fix: 'Set a real author in Brand setup if one applies.', location: null },
  { code: 'meta.description_length', severity: 'warning', message: 'The meta description is 168 characters.', fix: 'Aim for 70–160 characters.', location: null },
];
export const critical: CheckIssue = { code: 'facts.unsupported_figure', severity: 'critical', message: 'The figure “20%” has no supporting source.', fix: 'Cite a source passage that states it, use a figure from the brand facts, or remove it.', location: 'Section “Decide the profit you need”' };

export const destination: Omit<Destination, 'sealedCredential'> = { id: '7e7e7e7e-1111-4222-8333-444455556666', brandId: BRAND_ID, type: 'content_api', label: 'martinhowardproperty.example', config: { blogPath: 'blog' }, publicBaseUrl: 'https://www.martinhowardproperty.example', status: 'connected', statusDetail: 'Connected.', checkedAt: '2026-11-10T09:00:00.000Z', createdAt: '2026-09-01T09:00:00.000Z' };

export function shell(): Shell { return { brands: [brand], brand, tab: 'articles', csrf: 'csrf-fixture', notice: null, error: null }; }

const approval = { versionId: current.id, contentSha: current.contentSha, approvedAt: '2026-11-15T10:00:00.000Z', approvedBy: 'owner' };
const schedule = { publishAtUtc: '2026-11-18T09:00:00.000Z', localDate: '2026-11-18', localTime: '09:00', timezone: 'Europe/London', destinationId: destination.id, setAt: '2026-11-15T10:00:00.000Z', setBy: 'owner' };
const published: Publication = { id: 'aaaaaaaa-1111-4222-8333-444455556666', brandId: BRAND_ID, articleId: ARTICLE_ID, versionId: current.id, contentSha: current.contentSha, destinationId: destination.id, idempotencyKey: 'k', scheduledFor: '2026-11-09T09:00:00.000Z',
  policy: { autoPublish: false, requiresApproval: false, approvedVersionId: current.id, rule: 'approved', decidedAt: '2026-11-09T09:00:00.000Z' }, state: 'published', attempts: 1, firstAttemptAt: '2026-11-09T09:00:00.000Z', publicUrl: 'https://www.martinhowardproperty.example/blog/appraise-uk-property-deal-maximum-offer', detail: 'Published and checked on the live page.', verifiedAt: '2026-11-09T09:02:00.000Z' } as unknown as Publication;

export type PageState = 'ready' | 'ready_picture' | 'must_fix' | 'scheduled' | 'published' | 'writing' | 'paused' | 'held' | 'failed' | 'approved' | 'no_website';
export const PAGE_STATES: readonly PageState[] = ['ready', 'ready_picture', 'must_fix', 'scheduled', 'published', 'writing', 'paused', 'held', 'failed', 'approved', 'no_website'];

const writeJob = (state: Job['state'], error: string | null): Job => ({ id: 'cccccccc-1111-4222-8333-444455556666', brandId: BRAND_ID, kind: 'write', idempotencyKey: 'write:b1', payload: { briefId: 'b1' }, state, attempts: 1, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null,
  runAfter: '2026-11-15T10:00:00.000Z', progress: state === 'blocked' ? 'Paused until the issue is fixed.' : 'Working', error, createdAt: '2026-11-14T10:00:00.000Z', updatedAt: '2026-11-15T10:00:00.000Z', rowVersion: 2 });

export function pageData(state: PageState): ArticlePageData {
  const base = { versions, publications: [] as Publication[], destinations: [destination], social: null, status: 'Needs approval', now: NOW };
  const pictured = version(3, body({ image: { kind: 'brand_asset', url: 'https://www.martinhowardproperty.example/images/terrace.jpg', alt: 'A terraced house with scaffolding during a refurbishment', provenance: '', width: 1536, height: 1024 } }));
  switch (state) {
    case 'ready': return { ...base, article: article(), version: current };
    case 'ready_picture': return { ...base, article: article({ currentVersionId: pictured.id }), version: pictured, versions: [versions[0]!, versions[1]!, pictured] };
    case 'must_fix': return { ...base, article: article({ checks: { ...article().checks!, status: 'critical', issues: [critical, ...warnings] } }), version: current };
    case 'scheduled': return { ...base, status: 'Scheduled', article: article({ approval, schedule }), version: current };
    case 'approved': return { ...base, status: 'Approved', article: article({ approval }), version: current };
    case 'published': return { ...base, status: 'Published', publications: [published], article: article({ approval, delivery: 'published', publishedVersionId: current.id, publishedUrl: published.publicUrl, publishedAt: '2026-11-09T09:02:00.000Z' }), version: current };
    case 'held': return { ...base, status: 'Held', article: article({ hold: { reason: 'owner', detail: 'Held by the owner.', at: '2026-11-15T10:00:00.000Z' } }), version: current };
    case 'failed': return { ...base, status: 'Failed', article: article({ approval, delivery: 'failed', failure: 'The website did not answer in time.' }), version: current };
    case 'no_website': return { ...base, destinations: [], article: article(), version: current };
    case 'writing': return { ...base, status: 'Writing', article: article({ editorialState: 'writing', currentVersionId: null, checks: null, slug: 'refurbishment-budget-accuracy' }), workingTitle: 'How accurate is your refurbishment budget?', version: null, versions: [], jobs: [writeJob('running', null)] };
    case 'paused': return { ...base, status: 'Writing', article: article({ editorialState: 'writing', currentVersionId: null, checks: null, slug: 'refurbishment-budget-accuracy' }), workingTitle: 'How accurate is your refurbishment budget?', version: null, versions: [], jobs: [writeJob('failed', 'An unexpected error stopped this task. It will retry automatically.')] };
  }
}

/** The articles list with all four groups, including a stalled article and a not-yet-started topic. */
export function listData(): { articles: ArticleListRow[]; jobs: Job[]; briefs: ArticleBrief[]; now: string } {
  const row = (id: string, a: Partial<Article>, title: string, status: string, excerpt?: string, image?: ArticleBody['image']): ArticleListRow => ({ article: article({ id, briefId: `brief-${id}`, ...a }), title, status, ...(excerpt ? { excerpt } : {}), ...(image ? { image } : {}) });
  const img = (url: string) => ({ kind: 'brand_asset' as const, url, alt: 'Article picture', provenance: '', width: null, height: null });
  const blocked: Job = { ...writeJob('blocked', 'Writing allowance: monthly ceiling reached. Used 2,000,000; ceiling 2,000,000.'), id: 'dddddddd-1111-4222-8333-444455556666', payload: { briefId: 'brief-w2' } };
  const failed: Job = { ...writeJob('failed', 'An unexpected error stopped this task. It will retry automatically.'), id: 'eeeeeeee-1111-4222-8333-444455556666', payload: { briefId: 'brief-w3' } };
  const brief = (id: string, workingTitle: string, status = 'generating') => ({ id, workingTitle, status, articleId: null } as unknown as ArticleBrief);
  return { now: NOW, briefs: [brief('brief-w1', 'How accurate is your refurbishment budget?'), brief('brief-w2', 'HMO licensing: the basics for new landlords'), brief('brief-w3', 'Stamp duty on second homes, explained'), brief('brief-w4', 'Planning permission for loft conversions')], jobs: [blocked, failed, { ...writeJob('running', null), payload: { briefId: 'brief-w1' } }], articles: [
    row('r1', {}, 'How to Appraise a UK Property Deal and Set Your Maximum Offer', 'Needs approval', 'Work backwards from the end value to an offer you can defend.'),
    row('r2', { checks: { ...article().checks!, status: 'critical', issues: [critical] } }, 'Bridging loans explained for first-time investors', 'Needs approval', 'What a bridging loan costs and when it makes sense.'),
    row('r3', { approval: { ...approval } }, 'Five questions to ask before you buy at auction', 'Approved', 'Auctions move fast. These five questions slow you down in the right places.', img('https://www.martinhowardproperty.example/images/auction.jpg')),
    row('c1', { approval, schedule }, 'What a lender’s valuer looks for', 'Scheduled', 'Understand the valuation before the valuer arrives.', img('https://www.martinhowardproperty.example/images/valuer.jpg')),
    row('c2', { approval, schedule: { ...schedule, localDate: '2026-11-20', publishAtUtc: '2026-11-20T09:00:00.000Z' } }, 'Rental yield: gross, net and what really matters', 'Scheduled', 'Three ways to measure yield and which one to trust.'),
    row('w1', { currentVersionId: null, editorialState: 'writing', slug: 'refurbishment-budget-accuracy', checks: null }, 'refurbishment budget accuracy', 'Writing'),
    row('w2', { currentVersionId: null, editorialState: 'writing', slug: 'hmo-licensing-basics', checks: null }, 'hmo licensing basics', 'Writing'),
    row('w3', { currentVersionId: null, editorialState: 'writing', slug: 'stamp-duty-on-second-homes', checks: null }, 'stamp duty on second homes', 'Writing'),
    row('l1', { approval, delivery: 'published', publishedVersionId: current.id, publishedAt: '2026-11-09T09:02:00.000Z', publishedUrl: published.publicUrl }, 'Buy-to-let mortgages in 2026: a plain guide', 'Published', 'How lenders assess a buy-to-let and what has changed this year.', img('https://www.martinhowardproperty.example/images/mortgage.jpg')),
  ] };
}
