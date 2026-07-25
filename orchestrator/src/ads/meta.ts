/**
 * Meta Marketing API adapter — the live ads publisher (see decisions D-055).
 *
 * Creates the campaign as a PAUSED draft on the customer's ad account. NOT
 * exercised in tests/mock runs — it activates only when META_ACCESS_TOKEN and
 * META_AD_ACCOUNT_ID are set (the founder-gated live step). Meta's flow is
 * multi-step: campaign → ad set → ad creative → ad; this adapter creates the
 * paused CAMPAIGN (status=PAUSED) and returns its id. Building the ad
 * sets/creatives/ads under it is the next step (needs a Page id, pixel, budget
 * + our own app review). Endpoints/fields per Meta Marketing API as of Jan 2026;
 * verify before the live run. Nothing here ever un-pauses or spends.
 */

import type { AdCampaign, AdsPublisher, DraftRef } from './types.js';

const GRAPH = 'https://graph.facebook.com/v20.0';

// Our objective vocabulary → Meta ODAX objective enums. Verify against current docs.
const OBJECTIVE_MAP: Record<string, string> = {
  leads: 'OUTCOME_LEADS',
  traffic: 'OUTCOME_TRAFFIC',
  sales: 'OUTCOME_SALES',
  awareness: 'OUTCOME_AWARENESS',
  calls: 'OUTCOME_LEADS',
};

export class MetaAdsPublisher implements AdsPublisher {
  readonly mode = 'live' as const;

  constructor(
    private readonly accessToken = process.env.META_ACCESS_TOKEN ?? '',
    private readonly adAccountId = process.env.META_AD_ACCOUNT_ID ?? '',
  ) {
    if (!this.accessToken || !this.adAccountId) {
      throw new Error(
        'No Meta credentials: set META_ACCESS_TOKEN and META_AD_ACCOUNT_ID in <repo root>/.env — or run --mock for a no-cost dry run. (Live push only creates PAUSED drafts.)',
      );
    }
  }

  async connectAccount(platform: string): Promise<{ platform: string; connected: boolean }> {
    try {
      const res = await fetch(`${GRAPH}/${this.adAccountId}?fields=account_status&access_token=${encodeURIComponent(this.accessToken)}`);
      return { platform, connected: res.ok };
    } catch {
      return { platform, connected: false };
    }
  }

  async createDraft(campaign: AdCampaign, platform: string): Promise<DraftRef> {
    if (platform !== 'meta') {
      return { id: '', platform, status: 'failed', adSets: 0, error: `MetaAdsPublisher only handles "meta", not "${platform}"` };
    }
    const params = new URLSearchParams({
      name: `Relaunch72 — ${campaign.objective} (${campaign.ad_sets.length} angles)`,
      objective: OBJECTIVE_MAP[campaign.objective] ?? 'OUTCOME_LEADS',
      status: 'PAUSED', // never live automatically
      special_ad_categories: '[]',
      access_token: this.accessToken,
    });
    let res: Response;
    try {
      res = await fetch(`${GRAPH}/${this.adAccountId}/campaigns`, { method: 'POST', body: params });
    } catch (err) {
      return { id: '', platform, status: 'failed', adSets: 0, error: `network: ${(err as Error).message}` };
    }
    const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!res.ok || !json.id) {
      return { id: '', platform, status: 'failed', adSets: 0, error: `HTTP ${res.status}: ${json.error?.message ?? 'unknown'}` };
    }
    // Ad sets / creatives / ads under this paused campaign are the next step.
    return { id: json.id, platform, status: 'paused_draft', adSets: campaign.ad_sets.length };
  }
}
