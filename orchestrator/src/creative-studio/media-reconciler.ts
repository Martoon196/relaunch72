/**
 * Read-only provider reconciliation plus bounded private capture. It never
 * performs a paid submit, publishes a post, or invents USD charges from
 * platform credits. Captured outputs await technical and human review.
 */
import type { ClipResult, RenderResult } from './media-providers.js';
import type { PendingProviderResult, CapturedMedia } from './media-video-output-pg-store.js';
import { SeoBlogError } from '../seo-blog/types.js';

export interface MediaReconcilePorts {
  readonly pending:(workspaceId:string,jobId:string)=>Promise<PendingProviderResult>;
  readonly inspectVizard:(providerId:string)=>Promise<ClipResult>;
  readonly inspectShotstack:(providerId:string)=>Promise<RenderResult>;
  readonly download:(url:string)=>Promise<CapturedMedia>;
  readonly capture:(input:{workspaceId:string;jobId:string;claimToken:string;providerId:string;
    slot:number;providerAssetId:string;media:CapturedMedia})=>Promise<{
      id:string;sha256:string;replayed:boolean;state:'captured_unverified';
    }>;
}
export type ReconciliationResult=Readonly<{
  state:'processing'|'provider_failed'|'captured_unverified';
  jobId:string;assets:number;providerCredits:number|null;
}>;
export async function reconcileMediaJob(workspaceId:string,jobId:string,ports:MediaReconcilePorts):Promise<ReconciliationResult>{
  const j=await ports.pending(workspaceId,jobId);
  if(j.jobId!==jobId||!j.claimToken||!j.providerId)
    throw new SeoBlogError(409,'Mismatched provider receipt');
  if(j.kind==='shotstack_render'){
    const current=await ports.inspectShotstack(j.providerId);
    if(current.status==='failed')return{state:'provider_failed',jobId,assets:0,providerCredits:current.billedCredits};
    if(current.status!=='complete')return{state:'processing',jobId,assets:0,providerCredits:null};
    if(!current.temporaryDownloadUrl)throw new SeoBlogError(409,'Provider completed without an accessible output; operator review required');
    const media=await ports.download(current.temporaryDownloadUrl);
    await ports.capture({workspaceId,jobId,claimToken:j.claimToken,providerId:j.providerId,
      slot:0,providerAssetId:j.providerId,media});
    return{state:'captured_unverified',jobId,assets:1,providerCredits:current.billedCredits};
  }
  if(j.kind!=='vizard_clip')throw new SeoBlogError(409,'Unknown paid media job kind');
  const current=await ports.inspectVizard(j.providerId);
  if(current.status!=='complete')return{state:'processing',jobId,assets:0,providerCredits:null};
  if(!current.clips.length||current.clips.length>30)throw new SeoBlogError(409,'Provider did not return a bounded clip list');
  for(const [slot,clip] of current.clips.entries()){
    if(!clip.providerClipId||clip.providerClipId.length>160||!Number.isFinite(clip.durationMs)||clip.durationMs<=0)
      throw new SeoBlogError(409,'Provider returned incomplete clip metadata');
    const media=await ports.download(clip.temporaryDownloadUrl);
    await ports.capture({workspaceId,jobId,claimToken:j.claimToken,providerId:j.providerId,
      slot,providerAssetId:clip.providerClipId,media});
  }
  return{state:'captured_unverified',jobId,assets:current.clips.length,providerCredits:null};
}
