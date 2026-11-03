/** Read-only editorial projections. A proposed date never creates a canonical job. */
import { campaignDateProposal, campaignParentHold, currentCampaignRevision } from './campaign.js';
import type { Article, ArticleVersion, Job, Publication, PromotionNetwork } from './types.js';
import type { SeoCampaignQueueResult } from './media-types.js';
export interface CampaignCalendarEntry {
  readonly articleId:string; readonly variantId:string; readonly revisionId:string;
  readonly network:PromotionNetwork; readonly angle:string; readonly title:string;
  readonly at:string|null; readonly dateKind:'owner_pin'|'verified_relative'|'proposed_relative'|'undated';
  readonly state:'proposed'|'approved'|'held'|'omitted'; readonly detail:string;
}
export interface CampaignCalendarSource { readonly article:Article; readonly version:ArticleVersion|null; readonly proposedAt:string|null; readonly publications:readonly Publication[] }
const validInstant=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
export function campaignCalendarEntries(sources:readonly CampaignCalendarSource[],now:string,timezone:string,paused=false):CampaignCalendarEntry[] {
  return sources.flatMap(({article,version,proposedAt,publications})=>{
    const campaign=article.campaign;if(!campaign)return [];
    return campaign.variants.map(variant=>{
      const rev=currentCampaignRevision(variant);
      const current=version&&campaign.articleVersionId===version.id&&campaign.articleContentSha===version.contentSha&&rev.articleVersionId===version.id&&rev.articleContentSha===version.contentSha;
      const published=!!current&&article.delivery==='published'&&article.publishedVersionId===version!.id&&article.publishedUrl===rev.canonicalUrl;
      const exact=publications.filter(p=>p.articleId===article.id&&p.versionId===rev.articleVersionId&&p.contentSha===rev.articleContentSha&&p.publicUrl===rev.canonicalUrl&&p.state==='published');
      const hasUnknownFirst=exact.some(p=>!validInstant(p.firstVerifiedAt));
      const anchor=published&&exact.length&&!hasUnknownFirst?exact.map(p=>p.firstVerifiedAt!).sort()[0]!:null;
      let at:string|null=null,dateKind:CampaignCalendarEntry['dateKind']='undated',dateIssue:string|null=null;
      if(variant.pinnedSchedule&&validInstant(variant.pinnedSchedule.scheduledFor)){
        at=variant.pinnedSchedule.scheduledFor;dateKind='owner_pin';
        if(at<=now)dateIssue='The owner-pinned date has passed; it has not been moved or sent.';
      }else{
        // An already-live legacy/mixed history cannot be rebased to a schedule or latest observation.
        const blogAt=published?anchor:article.schedule?.publishAtUtc??proposedAt;
        const proposal=campaignDateProposal(variant,blogAt,now,timezone);
        if(proposal.state==='proposed'){at=proposal.at;dateKind=published?'verified_relative':'proposed_relative';}
        else dateIssue=published&&!anchor?'The first verified publication time is unavailable. Choose an exact owner-pinned date.':proposal.reason;
      }
      const parentIssue=!version?'The article is still being written.':campaignParentHold(article,version,campaign,variant,false);
      const approved=variant.approval?.revisionId===rev.id&&variant.approval.revisionSha256===rev.sha256;
      const state:CampaignCalendarEntry['state']=variant.omitted?'omitted':paused||!current||parentIssue||dateIssue?'held':approved?'approved':'proposed';
      const detail=variant.omitted?'Omitted by the owner.':paused?'The programme is paused.':parentIssue??dateIssue??(dateKind==='proposed_relative'?'Proposed after the blog date; no connected delivery is scheduled.':approved?'Exact post reviewed; connected delivery is shown separately.':'Draft awaiting exact image and post review.');
      return {articleId:article.id,variantId:variant.id,revisionId:rev.id,network:variant.network,angle:variant.angle,title:rev.title,at,dateKind,state,detail};
    });
  });
}
export interface SocialCalendarJob {
  readonly jobId:string; readonly network:string; readonly content:string; readonly scheduledFor:string;
  readonly state:string; readonly safeCode:string|null;
}
export interface CampaignJobLink { readonly articleId:string; readonly variantId:string }
/** Exact saved receipts only. Similar text never establishes campaign provenance. */
export function campaignJobLinks(articles:readonly Article[],jobs:readonly Job[]=[]):ReadonlyMap<string,CampaignJobLink> {
  const out=new Map<string,CampaignJobLink>();
  for(const article of articles)for(const pointer of article.campaign?.queueInstructions??[]){
    const wake=jobs.find(j=>j.brandId===article.brandId&&j.kind==='publish'&&j.payload.campaignQueue===pointer.instruction.queueIntentId&&j.payload.campaignQueueResult);
    const result=(pointer.result??wake?.payload.campaignQueueResult) as SeoCampaignQueueResult|undefined;
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
    if(result?.kind==='materialized'&&uuid.test(result.jobId)&&uuid.test(result.intentId)&&uuid.test(result.queueIntentId)&&result.queueIntentId===pointer.instruction.queueIntentId&&result.contentVersionId===pointer.instruction.contentVersionId&&article.campaign?.variants.some(v=>v.id===pointer.instruction.variantId))out.set(result.jobId,{articleId:article.id,variantId:pointer.instruction.variantId});
  }
  return out;
}
export function socialCalendarWindow(from:string,to:string):boolean {
  return validInstant(from)&&validInstant(to)&&from<to&&Date.parse(to)-Date.parse(from)<=366*86_400_000;
}
