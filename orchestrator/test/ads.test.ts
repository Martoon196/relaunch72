import test from 'node:test';
import assert from 'node:assert/strict';
import { qaAdCampaign, AD_HEADLINE_MAX } from '../src/qa/checks.js';
import { MockClient } from '../src/llm/mock.js';
import { MockAdsPublisher } from '../src/ads/mock.js';
import { extractJson } from '../src/llm/json.js';
import { validIntake } from './helpers.js';
import type { AdCampaign } from '../src/ads/types.js';

const intake = validIntake();

async function mockStage(stage: string): Promise<Record<string, unknown>> {
  const client = new MockClient(intake);
  const resp = await client.complete({ model: 'mock', maxTokens: 1, system: '', messages: [], meta: { stage, attempt: 1 } });
  const parsed = extractJson(resp.text);
  assert.ok('value' in parsed, `mock ${stage} must emit parseable JSON`);
  return JSON.parse(JSON.stringify((parsed as { value: unknown }).value)) as Record<string, unknown>;
}

async function priorS2S3S4(): Promise<Record<string, unknown>> {
  return { S2: await mockStage('S2'), S3: await mockStage('S3'), S4: await mockStage('S4') };
}

test('qaAdCampaign passes a grounded, in-limit mock campaign', async () => {
  const campaign = await mockStage('AD');
  assert.deepEqual(qaAdCampaign(campaign, intake, await priorS2S3S4()), []);
});

test('mock campaign has 2–4 grounded ad sets and headlines within the limit', async () => {
  const c = (await mockStage('AD')) as unknown as AdCampaign;
  assert.ok(c.ad_sets.length >= 2 && c.ad_sets.length <= 4);
  for (const set of c.ad_sets) {
    for (const h of set.headlines) assert.ok(h.length <= AD_HEADLINE_MAX, `headline "${h}" within ${AD_HEADLINE_MAX}`);
  }
});

test('ad.number_invented (FATAL) fires on a fabricated stat in ad copy', async () => {
  const c = (await mockStage('AD')) as unknown as AdCampaign;
  c.ad_sets[0]!.primary_texts[0] = 'Join 4,213 happy customers and save 62% today.';
  const issues = qaAdCampaign(c, intake, await priorS2S3S4());
  assert.ok(issues.some((i) => i.check === 'ad.number_invented' && i.fatal));
});

test('ad.outcome_promised fires on a guaranteed-results headline', async () => {
  const c = (await mockStage('AD')) as unknown as AdCampaign;
  c.ad_sets[0]!.headlines[0] = 'Double your revenue';
  const issues = qaAdCampaign(c, intake, await priorS2S3S4());
  assert.ok(issues.some((i) => i.check === 'ad.outcome_promised'));
});

test('ad.headline_too_long fires past the 30-char cap', async () => {
  const c = (await mockStage('AD')) as unknown as AdCampaign;
  c.ad_sets[0]!.headlines[0] = 'This headline is definitely far too long for any ad platform';
  const issues = qaAdCampaign(c, intake, await priorS2S3S4());
  assert.ok(issues.some((i) => i.check === 'ad.headline_too_long'));
});

test('ad.quote_fabricated (FATAL) fires on a made-up testimonial', async () => {
  const c = (await mockStage('AD')) as unknown as AdCampaign;
  c.ad_sets[0]!.primary_texts[0] = 'A customer said: "these are the best electricians in the whole country".';
  const issues = qaAdCampaign(c, intake, await priorS2S3S4());
  assert.ok(issues.some((i) => i.check === 'ad.quote_fabricated' && i.fatal));
});

test('MockAdsPublisher creates paused drafts only, and records them', async () => {
  const pub = new MockAdsPublisher();
  const campaign = (await mockStage('AD')) as unknown as AdCampaign;
  const ref = await pub.createDraft(campaign, 'meta');
  assert.equal(ref.status, 'paused_draft');
  assert.equal(ref.platform, 'meta');
  assert.equal(ref.adSets, campaign.ad_sets.length);
  assert.equal(pub.drafts.length, 1);
});
