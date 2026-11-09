/**
 * Composition of the Creative Studio for one signed-in principal. Mounted only
 * when CREATIVE_STUDIO_ENABLED=true (default off) and migration 0144 is applied.
 * Reuses the existing brand store, blob storage and the article-image pipeline's
 * receipted outputs; adds no provider credential and no paid-generation path.
 */
import type { Pool } from 'pg';
import { CreativeStudioService, type SavedGeneratedImage, type SavedImagePort } from '../creative-studio/service.js';
import { PgCreativeDistributionReader, PgCreativeLearningStore, PgCreativeLibraryStore } from '../creative-studio/pg-store.js';
import type { CampaignCreatorStore } from '../seo-blog/campaign-creator.js';
import { ChromiumArtworkRenderer } from '../creative-studio/renderer.js';
import { PgSeoBlogStore } from '../seo-blog/pg-store.js';
import { PgSeoBlogMediaStore } from '../seo-blog/media-store.js';
import { CreativeGeneration } from '../creative-studio/generation-service.js';
import { PgCreativeGenerationStore } from '../creative-studio/generation-store.js';
import { imageProviderKey } from './creative-studio-worker.js';
import type { Job } from '../seo-blog/types.js';
import { runCreativeRenderJob } from '../creative-studio/render-jobs.js';
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
  readonly creators?: Pick<CampaignCreatorStore, 'get' | 'list'>; readonly env?: NodeJS.ProcessEnv }): CreativeStudioService {
  const principal = { kind: 'user' as const, userId: input.identity.userId, requestId: input.requestId, sessionToken: input.identity.sessionToken, selectedWorkspaceId: input.identity.workspaceId };
  const media = new PgSeoBlogMediaStore(input.contentCommandPool, principal, { publicOrigin: 'https://app.relaunch72.com' });
  const brands = new PgSeoBlogStore(input.contentCommandPool, principal, media);
  const generationStore = new PgCreativeGenerationStore(input.contentCommandPool, principal);
  return new CreativeStudioService({
    library: new PgCreativeLibraryStore(input.contentCommandPool, principal),
    brands,
    renderer: creativeRenderer(),
    savedImages: engineSavedImages(input.engine),
    // Milestone 4: the existing article media path, existing acquisition proposals and read-only receipts/CRM outcomes.
    articleMedia: { importApproved: (actorId, brandId, articleId, commandId, bytes, profile, origin) => input.engine.importCreativeImage({ userId: actorId }, brandId, articleId, commandId, bytes, profile, origin) },
    ...(input.creators ? { creators: input.creators } : {}),
    distribution: new PgCreativeDistributionReader(input.contentCommandPool, principal),
    // Milestone 5: append-only learning journal; brand guidance copies go through the existing knowledge upload.
    learning: new PgCreativeLearningStore(input.contentCommandPool, principal),
    guidance: { saveAudienceNote: async (actorId, brandId, title, text) => ({ documentId: (await input.engine.uploadKnowledge({ userId: actorId }, brandId, { category: 'audience_notes', title, pastedText: text })).id }) },
    // Typed-brief generation through the existing article-image admission, provider credential and private storage.
    generation: new CreativeGeneration({ store: generationStore, brands, policy: () => media.readImagePolicy(), providerConfigured: imageProviderKey(input.env ?? {}).configured,
      settings: { async configure(actorId, brandId, rowVersion, value) {
        await input.engine.updateSettings({ userId: actorId }, brandId, rowVersion, { studioImages: { ...value, authorizedBy: actorId, authorizedAt: new Date().toISOString() } });
      } } }),
    renderJobs: brands,
    generatedImages: {
      async find(_actorId, brandId, generationId) { return (await generationStore.state(brandId)).generations.find((g) => g.id === generationId) ?? null; },
      // The brand's private media store (owner session, workspace RLS, digest-checked); independent of article image review.
      async load(_actorId, brandId, assetId, sha256) { return (await media.loadPrivateAsset(brandId, assetId, sha256)).bytes; },
    },
  });
}

/**
 * Durable local render runner for the SEO worker (CREATIVE_STUDIO_ENABLED=true). Each claimed render job gets a service
 * whose library calls carry the job's claim; SQL lets the worker act only for that job's sponsor and command while the
 * lease is held, and only to read and append rendered versions. Rendering is local Chromium: no provider, no charge.
 */
export function creativeRenderRunner(pool: Pool, requestId: string, env: NodeJS.ProcessEnv): { render?: (job: Job) => Promise<Job> } {
  if (env.CREATIVE_STUDIO_ENABLED !== 'true') return {};
  const principal = { kind: 'worker' as const, requestId };
  const media = new PgSeoBlogMediaStore(pool, principal, { publicOrigin: 'https://app.relaunch72.com' });
  const store = new PgSeoBlogStore(pool, principal, media);
  return {
    render: (claim) => runCreativeRenderJob(claim, { store, now: () => new Date().toISOString(),
      service: (payload, job) => {
        const library = new PgCreativeLibraryStore(pool, principal, { id: job.id, leaseOwner: job.leaseOwner!, attempt: job.attempts });
        // Authority comes from SQL (live claim + current membership), never from this process.
        const brands = Object.assign(Object.create(store) as PgSeoBlogStore, {
          canManage: async (actorId: string, brandId: string) => brandId === job.brandId && actorId === payload.sponsorUserId && (await library.renderActor(brandId)) === actorId,
        });
        return new CreativeStudioService({ library, brands, renderer: creativeRenderer() });
      } }),
  };
}
