/**
 * Paid-ads publishing rail — the swappable seam that loads generated campaigns
 * into a customer's ad account. Same mock/live pattern as the LLM client, the
 * socials publisher and the keyword provider.
 *
 * SAFETY: campaigns are only ever created PAUSED (draft). We never auto-spend a
 * customer's budget — they review and enable in their own ad account. A live
 * push happens only with an explicit --publish flag and real credentials.
 */

export interface AdSet {
  angle: string;
  primary_texts: string[];
  headlines: string[];
  descriptions: string[];
  cta: string;
  creative_brief: string;
  landing_target: string;
}

export interface AdCampaign {
  objective: string;
  platforms: string[];
  audience: { who: string; signals: string[]; exclusions: string[] };
  ad_sets: AdSet[];
  provenance_note: string;
}

export interface DraftRef {
  /** Provider-side id (or a deterministic mock id). */
  id: string;
  platform: string;
  /** Always 'paused_draft' — nothing goes live automatically. */
  status: 'paused_draft' | 'failed';
  adSets: number;
  error?: string;
}

export interface AdsPublisher {
  readonly mode: 'mock' | 'live';
  /** Confirm the customer's ad account is linked for a platform. */
  connectAccount(platform: string): Promise<{ platform: string; connected: boolean }>;
  /** Create the whole campaign as a PAUSED draft on one platform. */
  createDraft(campaign: AdCampaign, platform: string): Promise<DraftRef>;
}
