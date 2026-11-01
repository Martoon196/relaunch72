/**
 * Per-brand social delivery seam. Each brand registers its own Zernio profile,
 * connects its own accounts through the provider's one-use OAuth handoff and
 * registers each verified account with owner-configured caps (0 = off). The
 * calendar worker discovers these registrations from the database; nothing is
 * ever inherited from Property Predator's environment-bound accounts.
 */
import type { Article, ArticleVersion, Brand, LinkedPromotionRecord, PromotionNetwork, PromotionObservation } from './types.js';

export interface SocialProfile {
  readonly providerConnectionId: string;
  readonly providerProfileId: string;
  readonly registeredAt: string;
}

export interface SocialAccount {
  readonly accountId: string;
  readonly network: 'facebook' | 'instagram' | 'linkedin';
  readonly username: string | null;
  readonly status: 'active' | 'disconnected';
  readonly linkedAt: string;
  readonly webhookReceiptCount: number;
}

export interface SocialBinding {
  readonly id: string;
  readonly network: PromotionNetwork;
  readonly providerConnectionId: string;
  /** Hex SHA-256 of the provider account id; the clear id is readable only by the worker's dispatch function. */
  readonly providerAccountIdSha256: string;
  readonly username: string | null;
  readonly dailyCap: number;
  readonly monthlyCap: number;
  readonly status: 'active' | 'revoked';
  readonly registeredAt: string;
  readonly revokedAt: string | null;
}

export interface SocialOverview {
  readonly profile: SocialProfile | null;
  readonly accounts: readonly SocialAccount[];
  readonly bindings: readonly SocialBinding[];
}

export interface SocialPlanInput {
  readonly brand: Brand;
  readonly article: Article;
  readonly version: ArticleVersion;
  readonly network: PromotionNetwork;
  readonly link: LinkedPromotionRecord;
  readonly binding: SocialBinding;
  /** Durable schedule observation; the attestation refresh and intent id derive from it. */
  readonly observation: PromotionObservation;
  readonly dispatchId: string;
  readonly scheduledFor: string;
}

export interface SocialPlanResult {
  readonly intentId: string;
  readonly jobId: string;
  readonly dailyCap: number;
  readonly monthlyCap: number;
}

export class SocialDeliveryHoldError extends Error {
  constructor(readonly hold: string) { super(hold); this.name = 'SocialDeliveryHoldError'; }
}

export interface SocialRegistry {
  overview(brandId: string): Promise<SocialOverview>;
  registerProfile(brandId: string, displayName: string, providerProfileId: string): Promise<{ providerConnectionId: string; disposition: 'applied' | 'replayed' }>;
  beginConnect(brandId: string, network: PromotionNetwork, intentId: string): Promise<{ authUrl: string }>;
  completeConnect(brandId: string, input: { intentId: string; network: PromotionNetwork; providerProfileId: string; providerAccountId: string; username: string; canonicalCallback: string }): Promise<{ disposition: 'recorded' | 'replayed' }>;
  registerBinding(brandId: string, input: { network: PromotionNetwork; providerAccountId: string; dailyCap: number; monthlyCap: number }): Promise<{ bindingId: string; disposition: 'applied' | 'replayed' | 'caps_changed' }>;
  revokeBinding(brandId: string, bindingId: string): Promise<void>;
  /** Plans and enqueues through the canonical approval/receipt/lease machinery; throws SocialDeliveryHoldError for truthful holds. */
  plan(input: SocialPlanInput): Promise<SocialPlanResult>;
}

export const ACCOUNT_ID = /^[a-f0-9]{24}$/u;
export const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;

export function activeBindingFor(bindings: readonly SocialBinding[], network: PromotionNetwork): SocialBinding | null {
  return bindings.find(b => b.network === network && b.status === 'active') ?? null;
}

/** Owner-facing reason a network cannot be dispatched for this brand, independent of the article. */
export function bindingHold(bindings: readonly SocialBinding[], network: PromotionNetwork): string | null {
  const binding = activeBindingFor(bindings, network);
  if (!binding) return `No ${network} account is registered for this brand.`;
  if (binding.dailyCap < 1 || binding.monthlyCap < 1) return `${network} delivery is switched off (a cap is 0).`;
  return null;
}
