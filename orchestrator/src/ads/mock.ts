/**
 * Deterministic in-memory ads publisher — no network, no spend, no keys. Records
 * every draft so tests and dry runs can assert what WOULD be created. Everything
 * it "creates" is a paused draft.
 */

import type { AdCampaign, AdsPublisher, DraftRef } from './types.js';

export class MockAdsPublisher implements AdsPublisher {
  readonly mode = 'mock' as const;
  readonly drafts: DraftRef[] = [];

  async connectAccount(platform: string): Promise<{ platform: string; connected: boolean }> {
    return { platform, connected: true };
  }

  async createDraft(campaign: AdCampaign, platform: string): Promise<DraftRef> {
    const ref: DraftRef = {
      id: `mock-ad-${platform.toLowerCase().replace(/\s+/g, '-')}`,
      platform,
      status: 'paused_draft',
      adSets: campaign.ad_sets.length,
    };
    this.drafts.push(ref);
    return ref;
  }
}
