import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CAMPAIGN_ANGLES, CAMPAIGN_NETWORKS, campaignParentHold, createArticleCampaign, fallbackCampaignDrafts } from '../src/seo-blog/campaign.js';
import { writeArticleCampaignPromotions,CampaignGenerationRejectedError } from '../src/seo-blog/generation.js';
import {MethodController} from '../src/seo-blog/method-packs.js';
import {MemoryMethodStore} from '../src/seo-blog/method-store.js';
import {fixtureBrand} from './rl72-method-fixtures.js';
import {UpgradeFixtureModel,upgradeSnapshot} from './rl72-upgrade-fixtures.js';
import type { LlmClient } from '../src/llm/client.js';
import type { ArticleBody, BrandProfile } from '../src/seo-blog/types.js';

const BRAND = randomUUID(), VERSION = randomUUID(), SHA = 'a'.repeat(64), AT = '2026-11-03T12:00:00.000Z';
const profile: BrandProfile = { brandId: BRAND, version: 1, knowledge: [], summary: 'Harbour helps people consider property evidence.', audiences: ['Investors'], positioning: 'Clear information', offers: [], conversionPages: [], voice: { tone: ['Plain'], do: [], dont: [], examples: [] }, approvedClaims: [], exclusions: [], conflicts: [], missingFacts: [], factsSha: SHA, source: 'owner_edited', confirmedAt: AT, confirmedBy: randomUUID(), createdAt: AT, generation: null };
const body: ArticleBody = { title: 'Consider the evidence before deciding', seoTitle: 'Consider the evidence', metaDescription: 'A calm approach to checking a practical property decision.', excerpt: 'Start with the evidence and make the next question clear.', slug: 'evidence', intro: 'A good question helps you check the right evidence.', sections: [{ id: randomUUID(), heading: 'Check the source', body: 'Look for the original information and check its date.' }], conclusion: 'Keep a record of what you have checked.', cta: null, faqs: [{ q: 'What should I check first?', a: 'Start with the source and its date.' }], citations: [], image: { kind: 'none', url: null, alt: 'An editorial illustration', provenance: 'Not selected', width: null, height: null }, author: null };
function model(posts: unknown) {
  let calls = 0;
  const llm: LlmClient = { mode: 'mock', async complete(request) { calls++; assert.equal(request.maxTokens, 2400); assert.equal(request.meta!.stage, 'SEO_BLOG_SOCIAL'); assert.match(request.messages[0]!.content, /six_angle_campaign/);
    return { text: JSON.stringify({ posts }), tokensIn: 1000, tokensOut: 900, stopReason: 'end_turn', model: 'fixture-model' }; } };
  return { llm, calls: () => calls };
}
const drafts = CAMPAIGN_NETWORKS.flatMap(network => CAMPAIGN_ANGLES.map(angle => ({ network, angle, title: body.title, copy: `${network} ${angle}: Check the original source and its date before deciding on your next question.`, artworkInstructions: 'Calm editorial illustration; not documentary evidence.' })));

test('six-angle campaign stays within the existing single stage/model output ceiling and binds six exact identities', async () => {
  const m = model(drafts), generated = await writeArticleCampaignPromotions(m.llm, profile, body);
  assert.equal(m.calls(), 1); assert.equal(generated.value.posts.length, 6);
  const campaign = createArticleCampaign({ articleVersionId: VERSION, articleContentSha: SHA, canonicalUrl: 'https://harbour.example/blog/evidence', drafts: generated.value.posts, createdAt: AT, createdBy: 'system', generation: generated.record });
  assert.equal(campaign.mode, 'model'); assert.equal(new Set(campaign.variants.map(v => `${v.network}:${v.angle}`)).size, 6);
});

test('partial or duplicate model output is rejected after one call, never automatically corrected with another paid call', async () => {
  for (const output of [drafts.slice(0, 5), drafts.map(d => ({ ...d, copy: 'The identical repeated copy is not three distinct campaign perspectives.' }))]) {
    const m = model(output);
    await assert.rejects(writeArticleCampaignPromotions(m.llm, profile, body), /after one attempt/);
    assert.equal(m.calls(), 1);
  }
});

test('a known private-method copy rejection preserves its receipt and usage for the existing labelled fallback',async()=>{
 const f=fixtureBrand(),store=new MemoryMethodStore(),m=new UpgradeFixtureModel();
 store.snapshots.set(f.brand.id,upgradeSnapshot(f.brand.id,['production-core','social-repurposing']));
 m.mutate=v=>{delete v._method_sidecar.qualityFindings[0].detail;};
 const llm=await new MethodController(store,true).prepare(m,{...f,stage:'social',stages:['social'],assetRef:'promotion:'+VERSION,sources:['S1','fixture-source'],baselineTokens:6000,evidence:{research:f.sources}});
 await assert.rejects(writeArticleCampaignPromotions(llm,f.profile,body),e=>{assert.ok(e instanceof CampaignGenerationRejectedError);assert.equal(e.record.methodReceiptId,[...store.receipts.values()][0]!.id);assert.equal(e.record.tokensIn+e.record.tokensOut,250);return true;});
 assert.equal(m.requests.length,1);assert.equal([...store.receipts.values()][0]!.outcome,'rejected');
});

test('unconnected article still gets clearly labelled six article-text proposals; null URL grants no review/queue authority', () => {
  const fallback = fallbackCampaignDrafts(body);
  const campaign = createArticleCampaign({ articleVersionId: VERSION, articleContentSha: SHA, canonicalUrl: null, drafts: fallback, createdAt: AT, createdBy: 'system', generation: null });
  assert.equal(campaign.mode, 'excerpt_fallback'); assert.equal(campaign.variants.length, 6);
  assert.ok(campaign.variants.every(v => v.revisions[0]!.canonicalUrl === null));
  assert.match(campaignParentHold({ currentVersionId: VERSION, delivery: 'none', publishedVersionId: null, publishedUrl: null }, { id: VERSION, contentSha: SHA }, campaign, campaign.variants[0]!, false)!, /URL is not bound/);
  assert.throws(() => createArticleCampaign({ articleVersionId: VERSION, articleContentSha: SHA, canonicalUrl: null, drafts: fallback.slice(0, 5), createdAt: AT, createdBy: 'system', generation: null }), /six channel/);
});
