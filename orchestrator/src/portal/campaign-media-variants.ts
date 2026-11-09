export const CAMPAIGN_PACK_PLATFORMS = Object.freeze([
  'linkedin', 'facebook', 'instagram', 'x', 'tiktok',
] as const);

export type CampaignPackPlatform = typeof CAMPAIGN_PACK_PLATFORMS[number];

export interface CampaignMediaVariant {
  readonly platform: CampaignPackPlatform;
  readonly mediaType: 'image' | 'video';
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly contentSha256: string;
  readonly treatment: 'browser_cover_crop' | 'original_video';
}

const SHA256 = /^[0-9a-f]{64}$/u;
const DIMENSIONS: Readonly<Record<CampaignPackPlatform, readonly [number, number]>> = Object.freeze({
  linkedin: [1200, 630],
  facebook: [1200, 630],
  instagram: [1080, 1920],
  x: [1200, 630],
  tiktok: [1080, 1920],
});

function parseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      && url.hostname.toLowerCase() === 'media.zernio.com' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Rebuild browser media evidence field-by-field; reject partial or surplus channel sets. */
export function parseCampaignMediaVariants(
  values: readonly string[],
  platforms: readonly string[],
): readonly CampaignMediaVariant[] {
  if (values.length === 0) return Object.freeze([]);
  if (values.length > CAMPAIGN_PACK_PLATFORMS.length) throw new Error('invalid media variants');
  const selected = new Set(platforms);
  const result: CampaignMediaVariant[] = [];
  for (const value of values) {
    if (value.length > 3_000) throw new Error('invalid media variant');
    let source: unknown;
    try { source = JSON.parse(value); } catch { throw new Error('invalid media variant'); }
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error('invalid media variant');
    }
    const row = source as Record<string, unknown>;
    if (Object.keys(row).sort().join(',')
        !== 'contentSha256,height,mediaType,platform,treatment,url,width') {
      throw new Error('invalid media variant');
    }
    if (typeof row.platform !== 'string'
        || !CAMPAIGN_PACK_PLATFORMS.includes(row.platform as CampaignPackPlatform)
        || !selected.has(row.platform)
        || (row.mediaType !== 'image' && row.mediaType !== 'video')
        || typeof row.width !== 'number' || !Number.isSafeInteger(row.width)
        || typeof row.height !== 'number' || !Number.isSafeInteger(row.height)
        || typeof row.contentSha256 !== 'string' || !SHA256.test(row.contentSha256)
        || (row.treatment !== 'browser_cover_crop' && row.treatment !== 'original_video')) {
      throw new Error('invalid media variant');
    }
    const url = parseUrl(row.url);
    if (!url) throw new Error('invalid media variant');
    const [expectedWidth, expectedHeight] = DIMENSIONS[row.platform as CampaignPackPlatform];
    if (row.mediaType === 'image'
        && (row.width !== expectedWidth || row.height !== expectedHeight
          || row.treatment !== 'browser_cover_crop')) {
      throw new Error('invalid media variant');
    }
    if (row.mediaType === 'video'
        && (row.width < 1 || row.width > 8_192 || row.height < 1 || row.height > 8_192
          || row.treatment !== 'original_video')) {
      throw new Error('invalid media variant');
    }
    result.push(Object.freeze({
      platform: row.platform as CampaignPackPlatform,
      mediaType: row.mediaType,
      url,
      width: row.width,
      height: row.height,
      contentSha256: row.contentSha256,
      treatment: row.treatment,
    }));
  }
  if (new Set(result.map((item) => item.platform)).size !== result.length
      || result.length !== selected.size) throw new Error('invalid media variant set');
  return Object.freeze(result.sort((left, right) => left.platform.localeCompare(right.platform)));
}
