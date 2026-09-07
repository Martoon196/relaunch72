import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCampaignMediaVariants } from '../src/portal/campaign-media-variants.js';

function variant(platform: string, width: number, height: number, urlKey = platform): string {
  return JSON.stringify({
    platform,
    mediaType: 'image',
    url: `https://media.zernio.com/temp/${urlKey}.webp`,
    width,
    height,
    contentSha256: 'a'.repeat(64),
    treatment: 'browser_cover_crop',
  });
}

test('accepts one shared landscape and one shared tall image across five channel records', () => {
  const platforms = ['linkedin', 'facebook', 'instagram', 'x', 'tiktok'];
  const parsed = parseCampaignMediaVariants([
    variant('linkedin', 1200, 630, 'landscape'),
    variant('facebook', 1200, 630, 'landscape'),
    variant('instagram', 1080, 1920, 'tall'),
    variant('x', 1200, 630, 'landscape'),
    variant('tiktok', 1080, 1920, 'tall'),
  ], platforms);
  assert.equal(parsed.length, 5);
  assert.equal(new Set(parsed.map((item) => item.url)).size, 2);
});

test('rejects missing, duplicated, wrong-shaped and non-Zernio variants', () => {
  assert.throws(() => parseCampaignMediaVariants([
    variant('linkedin', 1200, 630),
  ], ['linkedin', 'facebook']));
  assert.throws(() => parseCampaignMediaVariants([
    variant('linkedin', 1200, 630), variant('linkedin', 1200, 630),
  ], ['linkedin', 'facebook']));
  assert.throws(() => parseCampaignMediaVariants([
    variant('tiktok', 1080, 1350),
  ], ['tiktok']));
  assert.throws(() => parseCampaignMediaVariants([
    variant('linkedin', 1200, 630).replace('media.zernio.com', 'attacker.invalid'),
  ], ['linkedin']));
});

test('empty media remains valid and does not invent a platform asset', () => {
  assert.deepEqual(parseCampaignMediaVariants([], ['linkedin', 'tiktok']), []);
});
