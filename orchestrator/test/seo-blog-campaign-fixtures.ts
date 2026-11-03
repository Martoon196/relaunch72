import { randomUUID } from 'node:crypto';
import { createArticleCampaign, fallbackCampaignDrafts } from '../src/seo-blog/campaign.js';
import { SeoBlogCampaignService } from '../src/seo-blog/campaign-service.js';
import type { Article, ArticleBody, ArticleVersion } from '../src/seo-blog/types.js';
import { harness, OWNER } from './seo-blog-fixtures.js';

export async function campaignFixture() {
  const h = harness(), { brand } = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name: 'Harbour', website: 'https://harbour.example' });
  const articleId = randomUUID(), id = randomUUID();
  const body: ArticleBody = { title: 'A considered property decision', seoTitle: 'A considered property decision', slug: 'considered-decision',
    excerpt: 'A practical guide to consider before the next decision.', metaDescription: 'Read the practical guide.', intro: 'Take time to consider the source evidence.',
    sections: [{ id: randomUUID(), heading: 'Consider the wider context', body: 'Review the supplied facts before making a decision.' }],
    conclusion: 'Use the guide as a starting point for your questions.', faqs: [], citations: [], image: { kind: 'none', url: null, alt: '', width: null, height: null, provenance: 'None' }, author: null, cta: null };
  let version: ArticleVersion = { id, articleId, brandId: brand.id, number: 1, parentVersionId: null, change: 'generated', changedSectionId: null,
    createdAt: h.clock.now(), createdBy: 'system', body, profileVersion: 1, factsSha: 'a'.repeat(64), knowledge: [], briefId: randomUUID(), planId: randomUUID(), generation: null, contentSha: 'b'.repeat(64) };
  const campaign = createArticleCampaign({ articleVersionId: id, articleContentSha: version.contentSha, canonicalUrl: 'https://harbour.example/blog/considered-decision', drafts: fallbackCampaignDrafts(body), createdAt: h.clock.now(), createdBy: 'system', generation: null });
  version = { ...version, promotionPack: { source: 'relaunch72.seo-blog', brandId: brand.id, articleId, versionId: id, contentSha: version.contentSha, profileVersion: 1, factsSha: version.factsSha,
    canonicalUrl: 'https://harbour.example/blog/considered-decision', generation: null, mode: 'excerpt_fallback', posts: fallbackCampaignDrafts(body).filter(p => p.angle === 'launch') } };
  const article: Article = { id: articleId, brandId: brand.id, briefId: version.briefId, planId: version.planId, slug: body.slug, editorialState: 'draft', currentVersionId: id,
    requiresApproval: true, approval: null, checks: null, schedule: null, hold: null, delivery: 'none', publishedVersionId: null, publishedUrl: null,
    publishedAt: null, lastAttemptAt: null, failure: null, createdAt: h.clock.now(), rowVersion: 1, campaign };
  await h.store.createArticle(article); await h.store.addVersion(version);
  return { h, brand, article, version, service: new SeoBlogCampaignService(h.store, h.clock.now) };
}
