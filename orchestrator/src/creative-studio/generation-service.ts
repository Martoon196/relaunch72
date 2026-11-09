/**
 * Owner-facing typed-brief generation: save a brief, review the cost and allowances, then explicitly request
 * one paid image. The HTTP request only records the intent as a durable job; the worker performs the call.
 */
import { createHash, randomUUID } from 'node:crypto';
import { prepareImageGenerationRequest, type SeoImageSize } from '../seo-blog/image-generation.js';
import type { SeoImageOperatorPolicy } from '../seo-blog/media-types.js';
import { SeoBlogError, type Brand, type Job } from '../seo-blog/types.js';
import { canonicalCompanyContentJson } from '../company-content-pg/validation.js';
import {
  CREATIVE_BRIEF_RECIPE, CREATIVE_IMAGE_MODEL, CREATIVE_IMAGE_QUALITY, CREATIVE_IMAGE_SCHEMA, creativeImageCommand, creativeImageIntentSha, validateBrief,
  type CreativeBrief, type CreativeImageIntent,
} from './generation.js';
import type { GenerationState, GenerationStore, IntentResult } from './generation-store.js';
import type { CreativeBrandPort } from './service.js';

export interface GenerationSettingsPort {
  configure(actorId: string, brandId: string, rowVersion: number, value: { enabled: boolean; perMonth: number }): Promise<void>;
}
export interface GenerationEstimate {
  readonly paidGenerations: 1;
  readonly model: string; readonly quality: string; readonly size: SeoImageSize; readonly references: number;
  /** Operator-set reservation held against the shared monthly limit per attempt; the provider bills tokens. */
  readonly reservedMicrousd: number | null;
  readonly exactCost: string;
  readonly brandAllowance: Readonly<{ limit: number; used: number; remaining: number }>;
  readonly studioAllowance: Readonly<{ enabled: boolean; limit: number; counted: number; unresolved: number; remaining: number }>;
  readonly sharedLimitOpen: boolean;
  readonly blockers: readonly string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

export class CreativeGeneration {
  constructor(private readonly deps: {
    readonly store: GenerationStore;
    readonly brands: CreativeBrandPort;
    readonly policy: () => Promise<SeoImageOperatorPolicy>;
    readonly settings?: GenerationSettingsPort;
    readonly providerConfigured: boolean;
    readonly newId?: () => string;
  }) {}
  private async brand(actorId: string, brandId: string): Promise<Brand> {
    if (!UUID.test(brandId) || !(await this.deps.brands.canManage(actorId, brandId))) throw new SeoBlogError(403, 'You do not manage this brand.');
    const brand = await this.deps.brands.getBrand(brandId);
    if (!brand) throw new SeoBlogError(404, 'Brand not found.');
    return brand;
  }

  async view(actorId: string, brandId: string, briefId?: string) {
    const brand = await this.brand(actorId, brandId);
    const [state, policy] = await Promise.all([this.deps.store.state(brandId, briefId), this.deps.policy().catch(() => null)]);
    return { brand, state, policy, providerConfigured: this.deps.providerConfigured };
  }

  /** Honest estimate: no price is invented. The operator's per-attempt reservation is shown as the amount held, not the charge. */
  estimate(brand: Brand, state: GenerationState, policy: SeoImageOperatorPolicy | null, brief: CreativeBrief): GenerationEstimate {
    const studio = brand.settings.studioImages, enabled = studio?.enabled === true, studioLimit = enabled ? studio!.perMonth : 0;
    const brandLimit = brand.settings.budgets.imagesPerMonth, used = state.usage.brandImagesThisMonth;
    const sharedOpen = Boolean(policy && policy.enabled && policy.maxConcurrency > 0 && policy.perAttemptMicrousd > 0 && policy.monthlyMicrousd > 0);
    const blockers = [
      ...(!this.deps.providerConfigured ? ['The image provider is not configured on this server.'] : []),
      ...(!sharedOpen ? ['Paid image generation is not enabled by the platform operator.'] : []),
      ...(!enabled ? ['Studio image generation is switched off for this brand.'] : studioLimit - state.usage.studioImagesCounted <= 0 ? ['The studio image allowance for this month is used up or zero.'] : []),
      ...(brandLimit - used <= 0 ? ['The brand image allowance (shared with blog images) is used up or zero.'] : []),
    ];
    return Object.freeze({ paidGenerations: 1 as const, model: CREATIVE_IMAGE_MODEL, quality: CREATIVE_IMAGE_QUALITY, size: brief.size, references: brief.references.length,
      reservedMicrousd: policy && sharedOpen ? policy.perAttemptMicrousd : null,
      exactCost: 'The provider bills by tokens and returns usage after the call; the exact charge is not known in advance. If usage is not returned, the cost is recorded as unknown, never as zero. Reference images add input cost.',
      brandAllowance: { limit: brandLimit, used, remaining: Math.max(0, brandLimit - used) },
      studioAllowance: { enabled, limit: studioLimit, counted: state.usage.studioImagesCounted, unresolved: state.usage.studioUnresolved, remaining: Math.max(0, studioLimit - state.usage.studioImagesCounted) },
      sharedLimitOpen: sharedOpen, blockers });
  }

  async saveBrief(actorId: string, brandId: string, commandId: string, raw: Record<string, unknown>, existingBriefId?: string): Promise<{ briefId: string; version: number; replayed: boolean }> {
    await this.brand(actorId, brandId);
    if (!UUID.test(commandId)) throw new SeoBlogError(400, 'Refresh the page and try again.');
    const brief = validateBrief(raw);
    const briefId = existingBriefId ?? (this.deps.newId ?? randomUUID)();
    if (!UUID.test(briefId)) throw new SeoBlogError(400, 'Unknown brief.');
    const inputSha = sha(canonicalCompanyContentJson({ briefId: existingBriefId ?? null, brief }));
    const r = await this.deps.store.saveBrief(brandId, commandId, inputSha, briefId, brief);
    const [id, version] = r.id.split(':');
    return { briefId: id!, version: Number(version), replayed: r.replayed };
  }

  async configure(actorId: string, brandId: string, rowVersion: number, enabled: boolean, perMonth: number): Promise<void> {
    await this.brand(actorId, brandId);
    if (!this.deps.settings) throw new SeoBlogError(503, 'Settings are not available here.');
    if (!Number.isInteger(perMonth) || perMonth < 0 || perMonth > 1000) throw new SeoBlogError(400, 'Studio image allowance must be a whole number from 0 to 1000.');
    await this.deps.settings.configure(actorId, brandId, rowVersion, { enabled, perMonth });
  }

  /**
   * Record the owner's explicit intent for one paid image of this exact brief version. A refresh or double click
   * with the same command returns the same job; once a version has a paid attempt, another needs confirmedNewIntent.
   */
  async request(actorId: string, brandId: string, briefId: string, version: number, commandId: string, confirmedNewIntent: boolean, replacesIntentId: string | null): Promise<IntentResult> {
    await this.brand(actorId, brandId);
    if (!UUID.test(commandId) || !UUID.test(briefId) || (replacesIntentId !== null && !UUID.test(replacesIntentId))) throw new SeoBlogError(400, 'Refresh the page and try again.');
    const source = await this.deps.store.readBriefSource(brandId, briefId, version);
    if (!source) throw new SeoBlogError(409, 'That brief, or one of its reference images, is no longer available. Save a new brief version.');
    const [profile, knowledge, policy] = await Promise.all([this.deps.brands.latestProfile(brandId), this.deps.brands.listKnowledge(brandId), this.deps.policy()]);
    if (!profile) throw new SeoBlogError(409, 'Confirm the brand profile first.');
    const command = creativeImageCommand({ source, profile, knowledge, sponsorUserId: actorId });
    const brief = validateBrief((source.snapshot as Record<string, unknown>).brief as Record<string, unknown>);
    const referenceSha256s = brief.references.map((r) => r.sha256);
    const prepared = prepareImageGenerationRequest(command, { size: brief.size, referenceDigests: referenceSha256s });
    const intentSha256 = creativeImageIntentSha({ commandId, sponsorUserId: actorId, source, requestSha256: prepared.requestSha256, size: brief.size, referenceSha256s,
      policyVersion: policy.version, policySha256: policy.sha256, confirmedNewIntent, replacesIntentId });
    const intent: CreativeImageIntent = { schema: CREATIVE_IMAGE_SCHEMA, sourceSnapshotVersion: CREATIVE_BRIEF_RECIPE, commandId, jobId: commandId, intentId: commandId, intentSha256,
      requestSha256: prepared.requestSha256, sourceSha256: source.sourceSha256, profileSha256: source.profileSha256, visualSha256: source.visualSha256,
      briefId, briefVersion: version, sponsorUserId: actorId, size: brief.size, referenceSha256s, references: brief.references, model: CREATIVE_IMAGE_MODEL, quality: CREATIVE_IMAGE_QUALITY,
      expectedPolicyVersion: policy.version, expectedPolicySha256: policy.sha256, confirmedNewIntent, replacesIntentId, source, privateCommand: command };
    return this.deps.store.initializeIntent(brandId, intent);
  }
}

/** Status projection for polling: no prompt, source documents, bytes or credentials. */
export function generationJobStatus(job: Pick<Job, 'id' | 'state' | 'progress' | 'error' | 'updatedAt'>) {
  return Object.freeze({ id: job.id, state: job.state, detail: (job.error ?? job.progress ?? '').slice(0, 600), updatedAt: job.updatedAt });
}
