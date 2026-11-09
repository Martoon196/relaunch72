/**
 * Milestone 4: distribution and attribution for approved creative, built only on
 * existing integrations. This module is pure: it decides which existing route can
 * accept an approved version, builds tracked links that carry campaign and artwork
 * identities, and turns recorded evidence into a state ladder. It never infers a
 * later state from an earlier one, never estimates outcomes and never starts a
 * delivery, send or spend.
 */
import { campaignUtm, UTM_MEDIUM } from '../seo-blog/acquisition-assembly.js';
import type { AcquisitionChannel, AcquisitionProposal, CampaignBrief } from '../seo-blog/campaign-creator.js';
import type { PlacementId } from './placements.js';
import type { CreativeHandoff, CreativeVersion, HandoffRoute } from './types.js';

/** Creative formats whose exact size equals an existing article media format. Others would be cropped, so they are not offered. */
export const ARTICLE_MEDIA_PROFILE: Readonly<Partial<Record<PlacementId, 'blog' | 'instagram' | 'linkedin'>>> = Object.freeze({
  article: 'blog', portrait: 'instagram', landscape: 'linkedin',
});

export function handoffRoute(version: Pick<CreativeVersion, 'media' | 'placement'>, targetKind: 'article_campaign' | 'creator_campaign'): { route: HandoffRoute; note: string } {
  const media = version.media ?? 'image';
  if (targetKind === 'creator_campaign') return { route: 'tracked_link', note: 'Acquisition campaigns are exported, not delivered: post or brief this artwork with its tracked link yourself. Nothing is published or spent.' };
  if (media === 'image' && ARTICLE_MEDIA_PROFILE[version.placement]) return { route: 'article_media', note: 'Added to this article’s private images. Review the image and description, choose it for a post, approve the post and plan it in the article campaign. The existing posting rules and limits apply.' };
  if (media === 'video') return { route: 'export_only', note: 'Article campaigns accept JPEG images only. Download this video and use it yourself; no connected integration posts video for this brand yet.' };
  return { route: 'export_only', note: 'This format has no matching article image size (blog 1600×900, Instagram 1080×1350, LinkedIn 1200×627). It is recorded for download only, never cropped.' };
}

/** utm_content for one concept and one approved artwork version: `concept-<n>-cs<first 8 hex of the version id>`. */
export function creativeUtmContent(conceptIndex: number, versionId: string): string {
  return `concept-${conceptIndex + 1}-cs${versionId.replace(/-/gu, '').slice(0, 8)}`;
}
/** Parse the identities back out of a stored utm_content. Anything else is reported as an unrecognised value, never guessed. */
export function parseCreativeUtmContent(value: string): { concept: number; creative: string | null } | null {
  const m = /^concept-(\d{1,2})(?:-cs([0-9a-f]{8}))?$/u.exec(value);
  return m ? { concept: Number(m[1]) - 1, creative: m[2] ?? null } : null;
}

export function creativeTrackedLink(brief: CampaignBrief, campaignId: string, proposal: AcquisitionProposal, conceptIndex: number, channel: AcquisitionChannel, versionId: string) {
  const concept = proposal.concepts[conceptIndex];
  if (!concept || !concept.channels.includes(channel)) return null;
  const url = new URL(brief.cta.url), utmCampaign = campaignUtm(brief, campaignId), utmContent = creativeUtmContent(conceptIndex, versionId);
  url.searchParams.set('utm_source', channel);
  url.searchParams.set('utm_medium', UTM_MEDIUM[channel]);
  url.searchParams.set('utm_campaign', utmCampaign);
  url.searchParams.set('utm_content', utmContent);
  return Object.freeze({ url: url.toString(), utmCampaign, utmContent, channel, concept: conceptIndex });
}

// ─── State ladder ───────────────────────────────────────────────────────────

export const DISTRIBUTION_STAGES = ['handed_off', 'queued', 'provider_accepted', 'published', 'delivered', 'lead', 'customer'] as const;
export type DistributionStage = typeof DISTRIBUTION_STAGES[number];
export type StageStatus = 'reached' | 'waiting' | 'not_applicable' | 'unknown' | 'failed' | 'stopped';
export interface StageEvidence { readonly stage: DistributionStage; readonly status: StageStatus; readonly at: string | null; readonly evidence: string; readonly count?: number }
export const STAGE_LABEL: Readonly<Record<DistributionStage, string>> = Object.freeze({
  handed_off: 'Handed off', queued: 'Queued', provider_accepted: 'Provider accepted', published: 'Published', delivered: 'Delivered', lead: 'Lead', customer: 'Customer',
});

/** One posting plan as recorded by the existing SQL receipts and connected-calendar job. */
export interface DeliveryRecord {
  readonly queueIntentId: string;
  readonly cancelled: boolean;
  readonly materialized: boolean;
  readonly scheduledFor: string | null;
  readonly jobState: string | null;
  readonly providerPostRecorded: boolean;
  readonly events: readonly Readonly<{ kind: 'accepted' | 'published' | 'failed' | 'outcome_unknown'; at: string; code: string }>[];
}
/** Outcomes counted from existing CRM, journey and commerce records for one exact utm_content value. */
export interface OutcomeBucket {
  readonly utmContent: string;
  readonly leads: number; readonly qualified: number; readonly booked: number; readonly sold: number; readonly customers: number;
  readonly subscriptionsCancelled: number; readonly firstAt: string | null; readonly lastAt: string | null;
}
export interface OutcomeRead { readonly utmCampaign: string; readonly readAt: string; readonly buckets: readonly OutcomeBucket[] }

const NO_MESSAGE_DELIVERY = 'Delivery receipts exist for messages (email, SMS, WhatsApp). Social networks and websites report publication only, so this state does not apply.';

/** Ladder for one social post planned with this artwork in an article campaign. */
export function postLadder(handoff: CreativeHandoff, plan: DeliveryRecord | null, planSaved: boolean): StageEvidence[] {
  const out: StageEvidence[] = [{ stage: 'handed_off', status: 'reached', at: handoff.createdAt, evidence: 'Exact approved bytes entered the article’s private images.' }];
  if (!plan) {
    out.push({ stage: 'queued', status: 'waiting', at: null, evidence: planSaved ? 'A posting plan is saved but its receipt was not readable.' : 'No posting plan uses this image yet.' });
  } else if (plan.cancelled && !plan.materialized) {
    out.push({ stage: 'queued', status: 'stopped', at: null, evidence: 'The posting plan was cancelled before it entered the calendar.' });
  } else if (!plan.materialized) {
    out.push({ stage: 'queued', status: 'waiting', at: null, evidence: 'Posting plan saved. It waits until the blog version is confirmed live and current controls allow it.' });
  } else {
    out.push({ stage: 'queued', status: 'reached', at: plan.scheduledFor, evidence: `Entered the connected social calendar${plan.jobState ? ` (job state: ${plan.jobState})` : ''}.` });
  }
  const accepted = plan?.events.find((e) => e.kind === 'accepted' || e.kind === 'published');
  const published = plan?.events.find((e) => e.kind === 'published');
  const failed = plan?.events.find((e) => e.kind === 'failed') ?? (plan && (plan.jobState === 'failed' || plan.jobState === 'needs_attention') ? { at: null, code: plan.jobState } : undefined);
  const unknown = plan?.events.find((e) => e.kind === 'outcome_unknown');
  const after = (stage: 'provider_accepted' | 'published', hit: { at: string } | undefined, label: string) => {
    if (hit) return { stage, status: 'reached' as const, at: hit.at, evidence: `${label} recorded by the provider receipt.` };
    if (failed) return { stage, status: 'failed' as const, at: failed.at ?? null, evidence: `The provider attempt failed (${failed.code}). Nothing is retried from here.` };
    if (unknown) return { stage, status: 'unknown' as const, at: unknown.at, evidence: 'The provider outcome is unknown and is held for reconciliation by the existing calendar worker.' };
    if (plan?.cancelled) return { stage, status: 'stopped' as const, at: null, evidence: 'The posting plan was cancelled.' };
    return { stage, status: 'waiting' as const, at: null, evidence: 'No provider receipt yet.' };
  };
  out.push(after('provider_accepted', accepted, 'Acceptance'));
  out.push(plan?.jobState === 'succeeded' && !published
    ? { stage: 'published', status: 'reached', at: null, evidence: 'The calendar job settled as succeeded.' }
    : after('published', published, 'Publication'));
  out.push({ stage: 'delivered', status: 'not_applicable', at: null, evidence: NO_MESSAGE_DELIVERY });
  const noUtm = 'Article posts link to the exact reviewed blog URL without campaign parameters, so leads cannot be attributed to this artwork. Use an acquisition campaign’s tracked link to measure leads.';
  out.push({ stage: 'lead', status: 'unknown', at: null, evidence: noUtm });
  out.push({ stage: 'customer', status: 'unknown', at: null, evidence: noUtm });
  return out;
}

/** Ladder for artwork carried by an acquisition campaign's tracked link (posted by the owner outside any connected integration). */
export function trackedLinkLadder(handoff: CreativeHandoff, outcomes: OutcomeRead | null): StageEvidence[] {
  const bucket = outcomes?.buckets.find((b) => b.utmContent === handoff.trackedLink?.utmContent) ?? null;
  const manual = 'This campaign is exported, not delivered by a connected integration, so this state is not recorded here.';
  const out: StageEvidence[] = [
    { stage: 'handed_off', status: 'reached', at: handoff.createdAt, evidence: `Tracked link issued with utm_campaign=${handoff.trackedLink?.utmCampaign} and utm_content=${handoff.trackedLink?.utmContent}.` },
    { stage: 'queued', status: 'not_applicable', at: null, evidence: manual },
    { stage: 'provider_accepted', status: 'not_applicable', at: null, evidence: manual },
    { stage: 'published', status: 'unknown', at: null, evidence: manual },
    handoff.trackedLink?.channel === 'email'
      ? { stage: 'delivered', status: 'unknown', at: null, evidence: 'Email for this campaign is not sent from here, so no delivery receipt is linked to this artwork.' }
      : { stage: 'delivered', status: 'not_applicable', at: null, evidence: NO_MESSAGE_DELIVERY },
  ];
  if (!outcomes) {
    out.push({ stage: 'lead', status: 'unknown', at: null, evidence: 'CRM outcomes could not be read.' }, { stage: 'customer', status: 'unknown', at: null, evidence: 'CRM outcomes could not be read.' });
    return out;
  }
  out.push(bucket && bucket.leads > 0
    ? { stage: 'lead', status: 'reached', at: bucket.firstAt, count: bucket.leads, evidence: `${bucket.leads} CRM contact${bucket.leads === 1 ? '' : 's'} with this exact utm_content (${bucket.qualified} qualified, ${bucket.booked} booked).` }
    : { stage: 'lead', status: 'waiting', at: null, count: 0, evidence: 'No CRM contact carries this exact campaign and artwork tag yet.' });
  const won = bucket ? Math.max(bucket.sold, bucket.customers) : 0;
  out.push(won > 0
    ? { stage: 'customer', status: 'reached', at: null, count: won, evidence: `${bucket!.sold} with a recorded sale or won opportunity; ${bucket!.customers} marked customer in the CRM.` }
    : { stage: 'customer', status: 'waiting', at: null, count: 0, evidence: 'No recorded sale, won opportunity or customer status for these contacts yet.' });
  return out;
}

export function exportLadder(handoff: CreativeHandoff): StageEvidence[] {
  return [
    { stage: 'handed_off', status: 'reached', at: handoff.createdAt, evidence: handoff.routeNote ?? 'Recorded for download only.' },
    ...(['queued', 'provider_accepted', 'published', 'delivered', 'lead', 'customer'] as const).map((stage) => ({ stage, status: 'not_applicable' as const, at: null,
      evidence: 'No connected integration accepts this format, and it carries no campaign tag, so nothing further is recorded.' })),
  ];
}

/** Stated with every outcome read so nobody mistakes counts for causal results. */
export const ATTRIBUTION_LIMITS: readonly string[] = Object.freeze([
  'Only exact utm_campaign/utm_content values stored on CRM contacts are counted. Contacts without campaign tags are not counted here.',
  'Today no live lead form records campaign tags on new contacts; only imported contacts carry them. Until a capture path stores them, live leads will show as zero here even when they exist.',
  'Each contact is counted once, under its latest tagged touch. Earlier touches by other campaigns are not shared out.',
  'Qualified means the contact reached the CRM pipeline stage “qualified” (or won). Booked means an appointment milestone. Sold means a recorded payment, sale milestone or won opportunity.',
  'Subscription starts are not recorded in this database; only subscription cancellations are. No revenue, return on ad spend, cost per acquisition or “winner” is calculated.',
  'Counts are observations, not proof that the artwork caused them.',
]);

// ─── Paid channels: capabilities stated individually ─────────────────────────

export interface PaidChannelCapability {
  readonly platform: 'meta' | 'google' | 'linkedin' | 'tiktok';
  readonly label: string;
  readonly connector: string;
  readonly drafting: string;
  readonly activation: string;
  readonly creativeUpload: string;
  readonly reporting: string;
}
/** Found by inspecting the codebase (`src/ads/*`); nothing here is enabled by this studio. A suggested budget never authorises spend. */
export const PAID_CHANNELS: readonly PaidChannelCapability[] = Object.freeze([
  { platform: 'meta', label: 'Meta (Facebook/Instagram) Ads', connector: 'Existing paused-draft adapter in the run pipeline (src/ads/meta.ts), unproven live, used only by the legacy run with an explicit --publish flag and META_ACCESS_TOKEN/META_AD_ACCOUNT_ID.',
    drafting: 'The adapter creates a paused campaign shell only; ad sets, creatives and ads are not built.', activation: 'Never: the adapter cannot un-pause or spend.', creativeUpload: 'Not supported.', reporting: 'Not supported.' },
  { platform: 'google', label: 'Google Ads', connector: 'None in this codebase.', drafting: 'Not available.', activation: 'Not available.', creativeUpload: 'Not available.', reporting: 'Not available.' },
  { platform: 'linkedin', label: 'LinkedIn Ads', connector: 'None (the LinkedIn connection is for organic posts through the social calendar).', drafting: 'Not available.', activation: 'Not available.', creativeUpload: 'Not available.', reporting: 'Not available.' },
  { platform: 'tiktok', label: 'TikTok Ads', connector: 'None in this codebase.', drafting: 'Not available.', activation: 'Not available.', creativeUpload: 'Not available.', reporting: 'Not available.' },
] as PaidChannelCapability[]);
