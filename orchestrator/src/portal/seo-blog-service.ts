/**
 * Composition of the SEO blog engine for the portal and the worker. Mounted
 * only when SEO_BLOG_ENABLED=true and the r72_content_command identity is
 * ready; otherwise the routes answer "not available" and nothing else changes.
 */

import type { Pool } from 'pg';
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

export interface PortalSeoBlogService {
  /** Engine bound to this signed-in principal; every call is re-authorised in PostgreSQL. */
  engineFor(identity: PortalSessionIdentity, requestId: string): SeoBlogEngine;
  readonly generation: 'live' | 'unavailable';
  readonly research: 'live' | 'unconfigured';
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

export function createPortalSeoBlogService(contentCommandPool: Pool, env: NodeJS.ProcessEnv = process.env, contentAdapterPool?: Pool): PortalSeoBlogService {
  const runtime = seoBlogRuntime(env);
  const transport = new GuardedFetchTransport();
  const publishers = defaultPublishers();
  return {
    generation: runtime.llm ? 'live' : 'unavailable',
    research: runtime.search.mode === 'live' ? 'live' : 'unconfigured',
    engineFor(identity, requestId) {
      const store = new PgSeoBlogStore(contentCommandPool, {
        kind: 'user', userId: identity.userId, requestId, sessionToken: identity.sessionToken, selectedWorkspaceId: identity.workspaceId,
      });
      return new SeoBlogEngine({ store, llm: runtime.llm, search: runtime.search, keywords: runtime.keywords, transport, publishers, vault: runtime.vault,
        ...(env.R72_CONTENT_ENABLED === 'true' && contentAdapterPool ? { promotions: createCentralPromotionApproval({ adapterPool: contentAdapterPool, commandPool: contentCommandPool, identity, requestId }) } : {}) });
    },
  };
}

export function createWorkerSeoBlogEngine(contentCommandPool: Pool, requestId: string, env: NodeJS.ProcessEnv = process.env): SeoBlogEngine {
  const runtime = seoBlogRuntime(env);
  return new SeoBlogEngine({
    store: new PgSeoBlogStore(contentCommandPool, { kind: 'worker', requestId }),
    llm: runtime.llm, search: runtime.search, keywords: runtime.keywords, transport: new GuardedFetchTransport(),
    publishers: defaultPublishers(), vault: runtime.vault, batchLimit: Number(env.SEO_BLOG_WORKER_BATCH ?? 5),
  });
}
