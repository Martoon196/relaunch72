/**
 * Worker-side Creative Studio jobs: typed-brief image generation (and, from the durable-render work, local renders).
 * Composed only when CREATIVE_STUDIO_ENABLED=true. The provider credential is the existing SEO_BLOG_IMAGE_API_KEY used
 * by article images; no new credential, provider or scheduler is introduced.
 */
import type { Pool } from 'pg';
import { PgSeoBlogMediaStore } from '../seo-blog/media-store.js';
import { PgSeoBlogStore } from '../seo-blog/pg-store.js';
import { generateImageCandidate } from '../seo-blog/image-generation.js';
import type { Job } from '../seo-blog/types.js';
import { isCreativeImageJob, isCreativeStudioJob } from '../creative-studio/generation.js';
import { PgCreativeGenerationStore } from '../creative-studio/generation-store.js';
import { completeJobInTransaction, runCreativeImageJob } from '../creative-studio/generation-worker.js';

export interface CreativeWorkerJobs { handles(job: Job): boolean; run(job: Job): Promise<Job> }

export function imageProviderKey(env: NodeJS.ProcessEnv): { key: string; configured: boolean } {
  const key = env.SEO_BLOG_IMAGE_API_KEY?.trim() ?? '';
  return { key, configured: /^[\x21-\x7e]{32,512}$/u.test(key) };
}

export function createCreativeWorkerJobs(input: { contentPool: Pick<Pool, 'connect'>; requestId: string; env: NodeJS.ProcessEnv; now?: () => string;
  /** Durable local render runner (creative_render jobs), supplied by the render composition. */
  render?: (job: Job) => Promise<Job> }): CreativeWorkerJobs | undefined {
  if (input.env.CREATIVE_STUDIO_ENABLED?.trim() !== 'true') return undefined;
  const principal = { kind: 'worker' as const, requestId: input.requestId };
  const media = new PgSeoBlogMediaStore(input.contentPool, principal, { publicOrigin: 'https://app.relaunch72.com' });
  const store = new PgSeoBlogStore(input.contentPool, principal, media);
  const generation = new PgCreativeGenerationStore(input.contentPool, principal);
  const { key, configured } = imageProviderKey(input.env);
  const now = input.now ?? (() => new Date().toISOString());
  return {
    handles: (job) => isCreativeStudioJob(job) && (isCreativeImageJob(job) || Boolean(input.render)),
    async run(job) {
      if (isCreativeImageJob(job)) return runCreativeImageJob(job, { store, generation, media, providerConfigured: configured, now, completeInTransaction: completeJobInTransaction,
        generate: (command, options, signal) => generateImageCandidate(command, { apiKey: key, ...(signal ? { signal } : {}) }, options) });
      return input.render!(job);
    },
  };
}
