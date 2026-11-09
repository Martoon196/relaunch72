/**
 * Composition of the Creative Studio for one signed-in principal. Mounted only
 * when CREATIVE_STUDIO_ENABLED=true (default off) and migration 0143 is applied.
 * Reuses the existing brand store, blob storage and the article-image pipeline's
 * receipted outputs; adds no provider credential and no paid-generation path.
 */
import type { Pool } from 'pg';
import { CreativeStudioService, type SavedGeneratedImage, type SavedImagePort } from '../creative-studio/service.js';
import { PgCreativeDistributionReader, PgCreativeLibraryStore } from '../creative-studio/pg-store.js';
import type { CampaignCreatorStore } from '../seo-blog/campaign-creator.js';
import { ChromiumArtworkRenderer } from '../creative-studio/renderer.js';
import { PgSeoBlogStore } from '../seo-blog/pg-store.js';
import type { SeoBlogEngine } from '../seo-blog/engine.js';
import type { PortalSessionIdentity } from './auth-service.js';

let sharedRenderer: ChromiumArtworkRenderer | null = null;
/** One renderer per process; it launches Chromium only while a batch renders. */
export function creativeRenderer(): ChromiumArtworkRenderer {
  sharedRenderer ??= new ChromiumArtworkRenderer();
  return sharedRenderer;
}

export interface SavedImageWithPreview extends SavedGeneratedImage { readonly previewAssetId: string | null; readonly previewSha256: string | null }

/** Saved, receipted outputs of the existing durable article-image pipeline. Listing and loading make no provider call. */
export function engineSavedImages(engine: SeoBlogEngine): { list(actorId: string, brandId: string): Promise<SavedImageWithPreview[]>; load: SavedImagePort['load'] } {
  return {
    async list(actorId, brandId) {
      const rows = await engine.listArticles({ userId: actorId }, brandId);
      return rows.flatMap(({ article }) => (article.imageProposals ?? []).map((p) => {
        const preview = p.variants.find((v) => v.profile === 'blog') ?? p.variants[0] ?? null;
        const title = article.slug.replace(/-/gu, ' ');
        return Object.freeze({ assetId: p.candidateAssetId, sha256: p.candidateSha256, articleId: article.id, articleTitle: title.charAt(0).toUpperCase() + title.slice(1),
          intentId: p.intentId, attemptId: p.attemptId, preparedAt: p.preparedAt, previewAssetId: preview?.assetId ?? null, previewSha256: preview?.sha256 ?? null });
      })).slice(0, 24);
    },
    async load(actorId, brandId, assetId, sha256) {
      return (await engine.privateCampaignImage({ userId: actorId }, brandId, assetId, sha256)).bytes;
    },
  };
}

export function createCreativeStudio(input: { readonly contentCommandPool: Pool; readonly identity: PortalSessionIdentity; readonly requestId: string; readonly engine: SeoBlogEngine;
  readonly creators?: Pick<CampaignCreatorStore, 'get' | 'list'> }): CreativeStudioService {
  const principal = { kind: 'user' as const, userId: input.identity.userId, requestId: input.requestId, sessionToken: input.identity.sessionToken, selectedWorkspaceId: input.identity.workspaceId };
  return new CreativeStudioService({
    library: new PgCreativeLibraryStore(input.contentCommandPool, principal),
    brands: new PgSeoBlogStore(input.contentCommandPool, principal),
    renderer: creativeRenderer(),
    savedImages: engineSavedImages(input.engine),
    // Milestone 4: the existing article media path, existing acquisition proposals and read-only receipts/CRM outcomes.
    articleMedia: { importApproved: (actorId, brandId, articleId, commandId, bytes, profile, origin) => input.engine.importCreativeImage({ userId: actorId }, brandId, articleId, commandId, bytes, profile, origin) },
    ...(input.creators ? { creators: input.creators } : {}),
    distribution: new PgCreativeDistributionReader(input.contentCommandPool, principal),
  });
}
