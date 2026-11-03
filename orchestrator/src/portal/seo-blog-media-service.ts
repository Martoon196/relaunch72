/** Scoped 010 composition; operator policy and brand opt-in remain SQL admission gates. */
import type { Pool } from 'pg';
import { PgSeoBlogMediaStore } from '../seo-blog/media-store.js';
import { PgSeoBlogStore, type PgSeoBlogPrincipal } from '../seo-blog/pg-store.js';
import { createPgArticleImageService } from '../seo-blog/image-service-pg.js';
import { generateImageCandidate } from '../seo-blog/image-generation.js';
import { ArticleMediaReviewService, ownerMediaCommands } from '../seo-blog/media-review.js';
import { createCentralImageQualityApproval } from './seo-blog-image-review-pg.js';
import { createCentralCampaignApproval } from './seo-blog-campaign-approval-pg.js';
import { parseCompanyContentSocialImage } from '../company-content-pg/social-image.js';
import type { EngineDeps } from '../seo-blog/engine.js';
import type { PortalSessionIdentity } from './auth-service.js';
import { SeoBlogCampaignQueueService, type CampaignRecoveryCursor } from '../seo-blog/campaign-queue.js';

const workerRecoveryCursors = new WeakMap<object, CampaignRecoveryCursor>();

export function createSeoBlogMediaRuntime(input: {
  contentPool: Pick<Pool, 'connect'>; adapterPool?: Pick<Pool, 'connect'>;
  principal: PgSeoBlogPrincipal; identity?: PortalSessionIdentity; env: NodeJS.ProcessEnv;
  now?: () => string;
  prepareCampaignTarget?: (brandId: string, bindingId: string) => Promise<void>;
}): Pick<EngineDeps, 'store' | 'images' | 'mediaReview' | 'campaignReview' | 'campaignQueue'> {
  const now = input.now ?? (() => new Date().toISOString());
  const media = new PgSeoBlogMediaStore(input.contentPool, input.principal, { publicOrigin: 'https://app.relaunch72.com' });
  const store = new PgSeoBlogStore(input.contentPool, input.principal, media);
  // A scoped key is never copied from a global image/client credential.
  const key = input.env.SEO_BLOG_IMAGE_API_KEY?.trim() ?? '';
  const configured = /^[\x21-\x7e]{32,512}$/u.test(key);
  const images = createPgArticleImageService({ media, store, principal: input.principal, now, providerConfigured: configured,
    generate: (command, signal) => generateImageCandidate(command, { apiKey: key, signal }) });
  let cursor: CampaignRecoveryCursor | undefined;
  if (input.principal.kind === 'worker') {
    cursor = workerRecoveryCursors.get(input.contentPool);
    if (!cursor) { cursor = { brand: null, queues: new Map() }; workerRecoveryCursors.set(input.contentPool, cursor); }
  }
  const campaignQueue = new SeoBlogCampaignQueueService(store, media, now, cursor, input.prepareCampaignTarget);
  if (input.principal.kind !== 'user' || !input.identity || !input.adapterPool) return { store, images, campaignQueue };
  const approvalContext = { adapterPool: input.adapterPool, commandPool: input.contentPool, identity: input.identity, requestId: input.principal.requestId };
  const ownerMedia = ownerMediaCommands(media);
  return { store, images, campaignQueue, mediaReview: new ArticleMediaReviewService(store, ownerMedia, createCentralImageQualityApproval(approvalContext), now),
    campaignReview: { approval: createCentralCampaignApproval(approvalContext), authorizeImage: (brandId, command) => ownerMedia.recordOwnerSocialImageAuthorization(brandId, command), async loadImage(brandId, selected) {
      const privateImage = await ownerMedia.loadPrivateAsset(brandId, selected.assetId, selected.assetSha256);
      if (privateImage.asset.recipe?.profile !== selected.profile || !privateImage.asset.width || !privateImage.asset.height) throw new Error('The reviewed channel crop is unavailable.');
      return parseCompanyContentSocialImage({ mimeType: 'image/jpeg', base64: privateImage.bytes.toString('base64'), sha256: selected.assetSha256,
        width: privateImage.asset.width, height: privateImage.asset.height, alt: selected.alt });
    } } };
}
