/**
 * Composition of the SEO blog engine for the portal and the worker. Mounted
 * only when SEO_BLOG_ENABLED=true and the r72_content_command identity is
 * ready; otherwise the routes answer "not available" and nothing else changes.
 */

import { createCreativeWorkerJobs } from './creative-studio-worker.js';
import { creativeRenderRunner } from './creative-studio-composition.js';
import type { Pool } from 'pg';
import { MethodController } from '../seo-blog/method-packs.js';
import { PgMethodStore } from '../seo-blog/method-store.js';
import { PgCampaignCreatorStore } from '../seo-blog/campaign-creator-store.js';
import { AnthropicClient, type LlmClient } from '../llm/client.js';
import { DataForSeoProvider } from '../keyword/dataforseo.js';
import type { KeywordProvider } from '../keyword/types.js';
import { SeoBlogEngine } from '../seo-blog/engine.js';
import { PgSeoBlogStore } from '../seo-blog/pg-store.js';
import { defaultPublishers } from '../seo-blog/publishers/registry.js';
import { configuredSearchProvider, type SearchProvider } from '../seo-blog/research.js';
import { GuardedFetchTransport } from '../seo-blog/safe-fetch.js';
import { SeoBlogCredentialVault } from '../seo-blog/vault.js';
import type { PortalSessionIdentity } from './auth-service.js';
import { createCentralPromotionApproval } from './central-content-promotion-pg.js';
import { createPgSeoBlogSocialRegistry, resolveSeoBlogBrandForProfile, seoBlogSocialReservedProfileIds } from './seo-blog-social-pg.js';
import type { PromotionNetwork } from '../seo-blog/types.js';
import { createSeoBlogMediaRuntime } from './seo-blog-media-service.js';
import { createCreativeStudio, engineSavedImages, type SavedImageWithPreview } from './creative-studio-composition.js';
import type { CreativeStudioService } from '../creative-studio/service.js';
import { PgEnquiryCapture } from '../creative-studio/enquiry-capture.js';
import { CrmCommandService } from '../crm-pg/commands.js';
import { createPgCrmTransactionRunner } from '../crm-pg/repository.js';

export interface PortalSeoBlogService {
  /** Engine bound to this signed-in principal; every call is re-authorised in PostgreSQL. */
  engineFor(identity: PortalSessionIdentity, requestId: string): SeoBlogEngine;
  readonly generation: 'live' | 'unavailable';
  readonly research: 'live' | 'unconfigured';
  /** Whether per-brand social registration/delivery is composed (Zernio command boundary + content pools). */
  readonly social: 'live' | 'unavailable';
  /** Creative Studio: mounted only when CREATIVE_STUDIO_ENABLED=true (after migration 0143). Drafts only; no provider calls. */
  readonly creativeEnabled?: boolean;
  creativeFor?(identity: PortalSessionIdentity, requestId: string, engine: SeoBlogEngine): CreativeStudioService | null;
  /** Receipted outputs of the existing article-image pipeline that the studio may reuse. */
  creativeSavedImages?(identity: PortalSessionIdentity, requestId: string, engine: SeoBlogEngine, brandId: string): Promise<SavedImageWithPreview[]>;
  /** Public brand enquiry capture into the existing CRM (studio enabled and a CRM command pool composed). */
  readonly creativeEnquiries?: PgEnquiryCapture;
  /**
   * Completes a brand's provider OAuth callback when the profile id belongs to
   * a registered brand rather than Property Predator. Returns null when no
   * brand owns that profile so the caller keeps its existing behaviour.
   */
  socialCallback(identity: PortalSessionIdentity, requestId: string, input: { intentId: string; network: PromotionNetwork; providerProfileId: string; providerAccountId: string; username: string; canonicalCallback: string }): Promise<'recorded' | 'replayed' | null>;
}

export interface PortalSeoBlogSocialPools {
  readonly zernioPool: Pool;
}

export interface SeoBlogRuntime {
  readonly llm: LlmClient | null;
  readonly search: SearchProvider;
  readonly keywords: KeywordProvider | null;
  readonly vault: SeoBlogCredentialVault | null;
}

export function seoBlogRuntime(env: NodeJS.ProcessEnv = process.env): SeoBlogRuntime {
  let llm: LlmClient | null = null;
  // Background generation is a real configured API call or it is unavailable — never a consumer chat product.
  const scopedApiKey = env.SEO_BLOG_ANTHROPIC_API_KEY?.trim();
  if ((scopedApiKey || env.ANTHROPIC_API_KEY?.trim()) && env.SEO_BLOG_GENERATION !== 'off') {
    try { llm = scopedApiKey ? new AnthropicClient(scopedApiKey) : new AnthropicClient(); } catch { llm = null; }
  }
  let keywords: KeywordProvider | null = null;
  if (env.SEO_BLOG_KEYWORD_METRICS === 'dataforseo' && env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD) {
    keywords = new DataForSeoProvider(env.DATAFORSEO_LOGIN, env.DATAFORSEO_PASSWORD, Number(env.DATAFORSEO_LOCATION_CODE ?? 2826), 'en');
  }
  return { llm, search: configuredSearchProvider(env), keywords, vault: SeoBlogCredentialVault.fromEnv(env) };
}

export function createPortalSeoBlogService(contentCommandPool: Pool, env: NodeJS.ProcessEnv = process.env, contentAdapterPool?: Pool, socialPools?: PortalSeoBlogSocialPools,
  crmCommandPool?: Pool): PortalSeoBlogService {
  const runtime = seoBlogRuntime(env);
  const transport = new GuardedFetchTransport();
  const publishers = defaultPublishers();
  const promotionsReady = env.R72_CONTENT_ENABLED === 'true' && Boolean(contentAdapterPool);
  const socialReady = promotionsReady && Boolean(socialPools);
  const zernioApiKey = env.ZERNIO_API_KEY?.trim() || null;
  const reservedProfileIds = seoBlogSocialReservedProfileIds(env);
  const socialFor = (identity: PortalSessionIdentity, requestId: string) => socialReady && contentAdapterPool && socialPools
    ? createPgSeoBlogSocialRegistry({ zernioPool: socialPools.zernioPool, contentCommandPool, contentAdapterPool, identity, requestId, zernioApiKey, reservedProfileIds })
    : undefined;
  const service: PortalSeoBlogService = {
    generation: runtime.llm ? 'live' : 'unavailable',
    research: runtime.search.mode === 'live' ? 'live' : 'unconfigured',
    social: socialReady ? 'live' : 'unavailable',
    creativeEnabled: env.CREATIVE_STUDIO_ENABLED === 'true',
    ...(env.CREATIVE_STUDIO_ENABLED === 'true' && crmCommandPool
      ? { creativeEnquiries: new PgEnquiryCapture({ contentPool: contentCommandPool, crm: new CrmCommandService({ transactionRunner: createPgCrmTransactionRunner(crmCommandPool) }) }) } : {}),
    creativeFor(identity, requestId, engine) {
      if (env.CREATIVE_STUDIO_ENABLED !== 'true') return null;
      const creators = env.SEO_BLOG_METHOD_PACKS === 'true' && env.SEO_BLOG_CAMPAIGN_CREATORS === 'true'
        ? new PgCampaignCreatorStore(contentCommandPool, { kind: 'user', userId: identity.userId, requestId, sessionToken: identity.sessionToken, selectedWorkspaceId: identity.workspaceId }) : undefined;
      return createCreativeStudio({ contentCommandPool, identity, requestId, engine, env, ...(creators ? { creators } : {}) });
    },
    async creativeSavedImages(identity, _requestId, engine, brandId) {
      return env.CREATIVE_STUDIO_ENABLED === 'true' ? engineSavedImages(engine).list(identity.userId, brandId).catch(() => []) : [];
    },
    engineFor(identity, requestId) {
      const social = socialFor(identity, requestId);
      const media = createSeoBlogMediaRuntime({ contentPool: contentCommandPool, adapterPool: promotionsReady ? contentAdapterPool : undefined, env, identity,
        principal: { kind: 'user', userId: identity.userId, requestId, sessionToken: identity.sessionToken, selectedWorkspaceId: identity.workspaceId },
        ...(social?.prepareCampaignTarget ? { prepareCampaignTarget: (brandId, bindingId) => social.prepareCampaignTarget!(brandId, bindingId) } : {}) });
      return new SeoBlogEngine({ ...media,
        ...(env.SEO_BLOG_METHOD_PACKS==='true'&&env.SEO_BLOG_CAMPAIGN_CREATORS==='true'?{creatorStore:new PgCampaignCreatorStore(contentCommandPool,{kind:'user',userId:identity.userId,requestId,sessionToken:identity.sessionToken,selectedWorkspaceId:identity.workspaceId})}:{}),
        ...(env.SEO_BLOG_METHOD_PACKS==='true'?{methods:new MethodController(new PgMethodStore(contentCommandPool,{kind:'user',userId:identity.userId,requestId,sessionToken:identity.sessionToken,selectedWorkspaceId:identity.workspaceId}),true)}:{}), llm: runtime.llm, search: runtime.search, keywords: runtime.keywords, transport, publishers, vault: runtime.vault,
        ...(promotionsReady && contentAdapterPool ? { promotions: createCentralPromotionApproval({ adapterPool: contentAdapterPool, commandPool: contentCommandPool, identity, requestId }) } : {}),
        ...(social ? { social } : {}) });
    },
    async socialCallback(identity, requestId, input) {
      if (!socialReady || !socialPools || reservedProfileIds.includes(input.providerProfileId)) return null;
      const brand = await resolveSeoBlogBrandForProfile(socialPools.zernioPool, { actorKind: 'user', userId: identity.userId, requestId }, input.providerProfileId);
      if (!brand) return null;
      return service.engineFor(identity, requestId).completeSocialConnect({ userId: identity.userId }, brand.workspaceId, input);
    },
  };
  return service;
}

export function createWorkerSeoBlogEngine(contentCommandPool: Pool, requestId: string, env: NodeJS.ProcessEnv = process.env): SeoBlogEngine {
  const runtime = seoBlogRuntime(env);
  const creativeJobs = createCreativeWorkerJobs({ contentPool: contentCommandPool, requestId, env, ...creativeRenderRunner(contentCommandPool, requestId, env) });
  return new SeoBlogEngine({
    ...createSeoBlogMediaRuntime({ contentPool: contentCommandPool, principal: { kind: 'worker', requestId }, env }),
    ...(env.SEO_BLOG_METHOD_PACKS==='true'?{methods:new MethodController(new PgMethodStore(contentCommandPool,{kind:'worker',requestId}),true)}:{}),
    llm: runtime.llm, search: runtime.search, keywords: runtime.keywords, transport: new GuardedFetchTransport(),
    publishers: defaultPublishers(), vault: runtime.vault, batchLimit: Number(env.SEO_BLOG_WORKER_BATCH ?? 5),
    ...(creativeJobs ? { creativeJobs } : {}),
  });
}
