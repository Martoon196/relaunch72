/** SQL-derived exact SEO media provenance, never a caller-selected remote URL. */
export interface SeoCampaignMediaProvenance {
  readonly system: 'relaunch72.seo-blog';
  readonly workspaceId: string;
  readonly articleId: string;
  readonly articleVersionId: string;
  readonly variantId: string;
  readonly variantRevisionId: string;
  readonly variantSha256: string;
  readonly mediaUseId: string;
  readonly assetId: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{64}$/u;
const KEYS = ['system', 'workspaceId', 'articleId', 'articleVersionId', 'variantId', 'variantRevisionId', 'variantSha256', 'mediaUseId', 'assetId'];
export function parseSeoCampaignMedia(value: unknown, workspaceId: string, storageKey: string, blobSha256: string): SeoCampaignMediaProvenance {
  const fail = (): never => { throw new Error('Invalid SEO campaign media provenance.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== KEYS.length || KEYS.some(key => !(key in source)) || source.system !== 'relaunch72.seo-blog'
    || source.workspaceId !== workspaceId || !SHA.test(blobSha256) || typeof source.variantSha256 !== 'string' || !SHA.test(source.variantSha256)) return fail();
  for (const key of ['workspaceId', 'articleId', 'articleVersionId', 'variantId', 'variantRevisionId', 'mediaUseId', 'assetId']) if (typeof source[key] !== 'string' || !UUID.test(source[key])) return fail();
  if (storageKey !== `seo-blog-media/${source.assetId}/${blobSha256}`) return fail();
  return Object.freeze({ system: 'relaunch72.seo-blog', workspaceId, articleId: source.articleId as string,
    articleVersionId: source.articleVersionId as string, variantId: source.variantId as string, variantRevisionId: source.variantRevisionId as string,
    variantSha256: source.variantSha256, mediaUseId: source.mediaUseId as string, assetId: source.assetId as string });
}
