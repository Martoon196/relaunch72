/**
 * Deterministic campaign assembly: tracked destination links and creative hand-off
 * parameters for an acquisition proposal. No network, model or delivery effect.
 * UTM values carry the stable campaign and concept identities so later outcomes
 * can be attributed; they do not prove that anything was delivered or clicked.
 */
import type { AcquisitionChannel, AcquisitionProposal, CampaignBrief } from './campaign-creator.js';

export const UTM_MEDIUM: Readonly<Record<AcquisitionChannel, string>> = Object.freeze({
  instagram: 'social', facebook: 'social', linkedin: 'social', email: 'email', search: 'cpc', website: 'referral',
});

const slug = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40) || 'campaign';

export interface TrackedLink { readonly concept: number; readonly channel: AcquisitionChannel; readonly url: string; readonly utmContent: string }

export function campaignUtm(brief: Pick<CampaignBrief, 'name'>, campaignId: string): string {
  return `${slug(brief.name)}-${campaignId.replace(/-/gu, '').slice(0, 8)}`;
}

/** One link per concept and channel, preserving any existing query on the approved destination. */
export function trackedLinks(brief: CampaignBrief, campaignId: string, proposal: AcquisitionProposal): TrackedLink[] {
  const campaign = campaignUtm(brief, campaignId);
  return proposal.concepts.flatMap((concept, index) => concept.channels.map((channel) => {
    const url = new URL(brief.cta.url);
    url.searchParams.set('utm_source', channel);
    url.searchParams.set('utm_medium', UTM_MEDIUM[channel]);
    url.searchParams.set('utm_campaign', campaign);
    url.searchParams.set('utm_content', `concept-${index + 1}`);
    return Object.freeze({ concept: index, channel, url: url.toString(), utmContent: `concept-${index + 1}` });
  }));
}

/** Query string that pre-fills the Creative Studio request form for one concept (owner still reviews and submits). */
export function creativePrefill(brief: CampaignBrief, concept: AcquisitionProposal['concepts'][number]): string {
  const params = new URLSearchParams({ purpose: brief.objective === 'awareness' ? 'organic_social' : 'advert', source_kind: 'brief',
    brief: `${concept.headline}. ${concept.primaryText}`.slice(0, 1200), audience: brief.audience, destination: brief.cta.url, concepts: '1' });
  return params.toString();
}
