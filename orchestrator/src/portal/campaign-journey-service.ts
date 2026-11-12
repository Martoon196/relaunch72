/**
 * Campaign journey (read only): campaign → asset → enquiry → contact → opportunity, as counts per tracked asset.
 * It composes existing readers only (campaign creator records, Creative Studio hand-offs and the existing
 * outcome counter in app_private.creative_studio_outcome_buckets) and adds no table or migration.
 * Anything the records cannot connect is labelled unknown rather than guessed.
 */
import type { PortalSessionIdentity } from './auth-service.js';
import type { PortalSeoBlogService } from './seo-blog-service.js';
import { SEO_BLOG_BASE } from './seo-blog-view.js';
import { SeoBlogError } from '../seo-blog/types.js';
import type { AcquisitionProposal, CreatorRecord } from '../seo-blog/campaign-creator.js';
import { campaignUtm } from '../seo-blog/acquisition-assembly.js';
import { ATTRIBUTION_LIMITS, parseCreativeUtmContent, type OutcomeBucket } from '../creative-studio/distribution.js';

export const CAMPAIGN_JOURNEY_ROUTE = '/portal/campaign-journey' as const;
const CAMPAIGN_LIMIT = 12;
const SET_LIMIT = 20;

export interface JourneyCounts { readonly leads: number; readonly qualified: number; readonly booked: number; readonly sold: number }
export interface JourneyAssetRow {
  readonly label: string;
  readonly detail: string;
  readonly imageHref: string | null;
  readonly counts: JourneyCounts;
  /** True when the tag on the contact could not be tied to an asset this brand issued. */
  readonly unknown: boolean;
}
export interface JourneyCampaign {
  readonly id: string;
  readonly name: string;
  readonly utmCampaign: string;
  readonly href: string;
  readonly assets: readonly JourneyAssetRow[];
  readonly totals: JourneyCounts;
  /** Null when the outcome reader was unavailable: counts are then unknown, not zero. */
  readonly readAt: string | null;
  readonly qualifiedMapped: boolean | null;
}
export interface CampaignJourneySnapshot {
  readonly available: boolean;
  readonly campaigns: readonly JourneyCampaign[];
  /** Enquiries recorded with a tag that matched a tracked link this brand issued (all campaigns). Null when unreadable. */
  readonly taggedEnquiries: number | null;
  readonly unknownSources: readonly string[];
  readonly limits: readonly string[];
}

const ZERO: JourneyCounts = Object.freeze({ leads: 0, qualified: 0, booked: 0, sold: 0 });
const add = (a: JourneyCounts, b: Pick<OutcomeBucket, 'leads' | 'qualified' | 'booked' | 'sold'>): JourneyCounts =>
  ({ leads: a.leads + b.leads, qualified: a.qualified + b.qualified, booked: a.booked + b.booked, sold: a.sold + b.sold });

/** Sources whose leads cannot be followed back to a campaign today; always shown, never counted as a campaign's result. */
export const UNKNOWN_SOURCES: readonly string[] = Object.freeze([
  'Blog articles and their social posts: these links carry no campaign tag, so a lead from them is “source unknown”. A contact whose landing page was an article only shows they landed there; it is not proof the article brought them.',
  'Leads typed in by hand, imported, or sent through any form other than this brand’s enquiry form.',
  'Enquiries whose campaign tag could not be stored at the time (the lead was kept; its tag was lost).',
  'Earlier campaigns that touched the same person: each contact is counted once, under their latest tagged visit.',
]);

export class CampaignJourneyService {
  constructor(private readonly deps: { readonly seoBlog?: PortalSeoBlogService }) {}

  async snapshot(identity: PortalSessionIdentity, requestId: string): Promise<CampaignJourneySnapshot> {
    const empty = { available: false, campaigns: [], taggedEnquiries: null, unknownSources: UNKNOWN_SOURCES, limits: ATTRIBUTION_LIMITS };
    if (!this.deps.seoBlog) return empty;
    const engine = this.deps.seoBlog.engineFor(identity, requestId);
    const studio = this.deps.seoBlog.creativeFor?.(identity, requestId, engine) ?? null;
    const userId = identity.userId, brandId = identity.workspaceId;
    if (!studio || !engine.campaignCreatorsReady) return empty;
    let records: CreatorRecord[];
    try { records = await engine.creators().list(userId, brandId); }
    catch (error) { if (error instanceof SeoBlogError && [403, 404, 409].includes(error.status)) return empty; throw error; }
    const acquisitions = records.filter((r) => r.brief.kind === 'acquisition' && r.version && 'concepts' in r.version.content)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, CAMPAIGN_LIMIT);

    // Tracked-link hand-offs of approved artwork, by exact utm_content.
    const handoffs = new Map<string, { label: string; imageHref: string | null }>();
    const overview = await studio.overview(userId, brandId);
    for (const summary of [...overview.sets].sort((a, b) => b.set.createdAt.localeCompare(a.set.createdAt)).slice(0, SET_LIMIT)) {
      const { record } = await studio.getSet(userId, brandId, summary.set.id);
      for (const h of record.handoffs) {
        if (h.route !== 'tracked_link' || !h.trackedLink) continue;
        const v = record.versions.find((x) => x.id === h.versionId);
        handoffs.set(`${h.trackedLink.utmCampaign}\0${h.trackedLink.utmContent}`, {
          label: `${v?.concept.headline || 'Artwork'} · ${h.trackedLink.channel}`,
          imageHref: v && v.render.mime === 'image/jpeg' ? `${SEO_BLOG_BASE}/b/${brandId}/creative/art/${v.id}/${v.render.sha256}.jpg` : null,
        });
      }
    }

    const campaigns: JourneyCampaign[] = [];
    for (const r of acquisitions) {
      const proposal = r.version!.content as AcquisitionProposal;
      const outcome = await studio.campaignOutcomes(userId, brandId, r.id).catch(() => null);
      const utmCampaign = outcome?.utmCampaign ?? campaignUtm(r.brief, r.id);
      const buckets = outcome?.read?.buckets ?? [];
      const assets: JourneyAssetRow[] = [];
      const seen = new Set<string>();
      for (const [key, h] of handoffs) {
        const [campaign, content] = key.split('\0');
        if (campaign !== utmCampaign || !content) continue;
        seen.add(content);
        const bucket = buckets.find((b) => b.utmContent === content);
        const parsed = parseCreativeUtmContent(content);
        const concept = parsed ? proposal.concepts[parsed.concept] : undefined;
        assets.push({ label: h.label, detail: concept ? `Concept ${parsed!.concept + 1}: ${concept.name}` : 'Tracked link', imageHref: h.imageHref, counts: bucket ? add(ZERO, bucket) : ZERO, unknown: false });
      }
      for (const bucket of buckets) {
        if (seen.has(bucket.utmContent)) continue;
        const parsed = bucket.utmContent ? parseCreativeUtmContent(bucket.utmContent) : null;
        const concept = parsed ? proposal.concepts[parsed.concept] : undefined;
        assets.push(concept
          ? { label: `Concept ${parsed!.concept + 1}: ${concept.name}`, detail: 'The artwork behind this tag was not identified.', imageHref: null, counts: add(ZERO, bucket), unknown: true }
          : { label: 'Unknown asset', detail: 'The campaign tag matched, but the asset tag was missing or not recognised.', imageHref: null, counts: add(ZERO, bucket), unknown: true });
      }
      campaigns.push({
        id: r.id, name: r.brief.name, utmCampaign, href: `${SEO_BLOG_BASE}/b/${brandId}/campaigns/${r.id}`, assets,
        totals: buckets.reduce(add, ZERO), readAt: outcome?.read?.readAt ?? null, qualifiedMapped: outcome?.read ? outcome.read.qualifiedMapped === true : null,
      });
    }
    const taggedEnquiries = await studio.enquiries(userId, brandId).then((s) => s.touches).catch(() => null);
    return { available: true, campaigns, taggedEnquiries, unknownSources: UNKNOWN_SOURCES, limits: ATTRIBUTION_LIMITS };
  }
}
