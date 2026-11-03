/** Initial six-copy receipt boundary. It never performs provider work. */
import type { Article, ArticleBody, ArticleVersion, Brand, BrandProfile, GenerationRecord, Job, KnowledgeDocument, UsageRecord } from './types.js';
import type { CampaignDraft } from './campaign.js';
import type { ProgrammeAuthority } from './programme.js';
import { programmeKnowledgeRefs, programmeSha } from './programme.js';
import { SeoBlogError } from './types.js';
import type { WebsiteVersionGuard } from './website-target.js';
export const INITIAL_CAMPAIGN_TOKEN_ESTIMATE=6000;

export interface CampaignCopyReceipt {
  readonly nonce: string;
  readonly at: string;
  readonly record: GenerationRecord;
  readonly result: { readonly kind: 'accepted'; readonly drafts: readonly CampaignDraft[] } | { readonly kind: 'rejected' };
}
export interface CampaignGeneration {
  readonly nonce: string;
  readonly estimatedTokens: typeof INITIAL_CAMPAIGN_TOKEN_ESTIMATE;
  readonly plannedVersionId: string;
  readonly plannedVersionNumber: number;
  readonly body: ArticleBody;
  readonly articleGeneration: GenerationRecord | null;
  readonly profileSha: string;
  readonly knowledgeSha: string;
  readonly authority: ProgrammeAuthority;
  readonly claim: { readonly jobId: string; readonly leaseOwner: string | null; readonly attempts: number } | null;
  readonly capturedAt: string;
  readonly startedAt: string | null;
  readonly receipt: CampaignCopyReceipt | null;
  readonly appliedAt: string | null;
}
export interface CampaignCopySnapshot {
  readonly brand: Brand;
  readonly article: Article;
  readonly profile: BrandProfile | null;
  readonly knowledge: readonly KnowledgeDocument[];
  readonly job: Job | null;
  readonly requesterAllowed: boolean;
  readonly modelTokensUsed: number;
  readonly modelTokensReserved: number;
}
export interface CampaignCopyDecision {
  readonly article: Article;
  readonly usage?: UsageRecord;
  readonly version?: ArticleVersion;
  readonly websiteGuard?: WebsiteVersionGuard;
}
export interface CampaignCopyBoundaryInput {
  readonly brandId: string;
  readonly articleId: string;
  readonly authority: ProgrammeAuthority;
  readonly claim: CampaignGeneration['claim'];
  readonly now: string;
  readonly decide: (snapshot: CampaignCopySnapshot) => CampaignCopyDecision;
}
export function pendingCampaignTokens(markers:readonly Pick<CampaignGeneration,'estimatedTokens'|'startedAt'|'receipt'>[]):number {
  return markers.reduce((total,m)=>{
    if(!m.startedAt||m.receipt)return total;
    // This initial-stage recipe has always used the same unchanged 6k estimate.
    // Unknown earlier-month starts remain reserved until a real receipt resolves them.
    if(m.estimatedTokens!==INITIAL_CAMPAIGN_TOKEN_ESTIMATE)throw new SeoBlogError(409,'A pending copy reservation needs owner review.');
    return total+m.estimatedTokens;
  },0);
}
export function campaignCopyIssue(s: CampaignCopySnapshot, marker: CampaignGeneration, now: string): string | null {
  if (!s.requesterAllowed) return 'The article authorising owner no longer manages this brand.';
  if (s.brand.settings.pauseAll) return 'The programme is paused.';
  if (marker.authority.origin === 'daily' && (!s.brand.settings.ongoingProduction || (s.brand.settings.programme?.authorisedBy ?? s.profile?.confirmedBy) !== marker.authority.sponsorUserId)) return 'Automatic drafting authority changed.';
  if (!s.profile?.confirmedAt || programmeSha(s.profile) !== marker.profileSha || programmeSha(programmeKnowledgeRefs(s.knowledge)) !== marker.knowledgeSha) return 'The article source changed. The saved copy receipt is retained; review a new article intent.';
  if (s.article.currentVersionId !== null && s.article.currentVersionId !== marker.plannedVersionId) return 'A newer article version already exists.';
  if (marker.claim && (!s.job || s.job.kind !== 'write' || s.job.payload.stage !== undefined || s.job.state !== 'running' || s.job.leaseOwner !== marker.claim.leaseOwner || s.job.attempts !== marker.claim.attempts || !s.job.leaseExpiresAt || s.job.leaseExpiresAt <= now)) return 'The original article worker lease is no longer current.';
  return null;
}
export function assertCampaignCopyScope(input: CampaignCopyBoundaryInput, s: CampaignCopySnapshot): void {
  const marker = s.article.campaignGeneration;
  const authority = marker?.authority ?? input.authority;
  if (authority.origin !== input.authority.origin || authority.sponsorUserId !== input.authority.sponsorUserId) throw new SeoBlogError(403, 'Article copy authority does not match.');
  if (s.job && (s.job.brandId !== input.brandId || s.job.payload.briefId !== s.article.briefId || (authority.origin === 'manual' ? s.job.payload.requestedBy !== authority.sponsorUserId : s.job.payload.requestedBy !== 'system'))) throw new SeoBlogError(403, 'Article copy requester does not match.');
}
