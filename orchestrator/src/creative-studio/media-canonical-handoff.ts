/** Same canonical CompanyContentService. Private video evidence is never a public URL. */
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {CompanyContentService,type CompanyContentTransactionRunner,type CreateCompanyContentVersionCommand} from '../company-content-pg/index.js';
import {withTransaction} from '../db/transaction.js';
import type {PgSeoBlogPrincipal} from '../seo-blog/pg-store.js';
import {SeoBlogError} from '../seo-blog/types.js';
import {checkedEditId} from './media-edit-plan.js';
export interface LocalVideoManifest {
 schema:'relaunch72.private-video/v1';workspaceId:string;outputId:string;sha256:string;
 sourceSha256:string;planSha256:string;byteLength:number;durationMs:number;width:number;height:number;
 audioPresent:boolean;storageKey:string;reviewRevision:number;reviewedAt:string;reviewedBy:string;brandSha256:string;
}
export interface LocalVideoHandoffInput {workspaceId:string;outputId:string;outputSha256:string;reviewRevision:number;commandId:string;title:string;caption:string;platform:'instagram'|'linkedin'}
const sha=(x:string)=>createHash('sha256').update(x).digest('hex');
export function localVideoDraftCommand(input:LocalVideoHandoffInput,manifest:LocalVideoManifest,now=new Date()):CreateCompanyContentVersionCommand{
 for(const id of [input.workspaceId,input.outputId,input.commandId])checkedEditId(id);
 if(input.workspaceId!==manifest.workspaceId||input.outputId!==manifest.outputId||input.outputSha256!==manifest.sha256||input.reviewRevision!==manifest.reviewRevision
  ||!['instagram','linkedin'].includes(input.platform)
  ||typeof input.title!=='string'||!input.title.trim()||input.title.length>160||/[<>\x00-\x1f]/u.test(input.title)
  ||typeof input.caption!=='string'||!input.caption.trim()||input.caption.length>2000||/[<>\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(input.caption))throw new SeoBlogError(400,'Exact reviewed video, caption and intended platform required');
 const reviewed=Date.parse(manifest.reviewedAt),age=now.getTime()-reviewed;
 if(!Number.isFinite(age)||age<0||age>14*60*1000)throw new SeoBlogError(409,'Record a fresh private review before requesting canonical video approval');
 const content=JSON.stringify({schema:'relaunch72.video-draft/v1',platform:input.platform,title:input.title.trim(),publicationCopy:input.caption,video:manifest,distribution:'pending_canonical_review'});
 return {commandKey:'media-video:'+input.commandId,origin:'generated',kind:'video',title:input.title.trim(),contentMimeType:'video/mp4',content,
  source:{system:'relaunch72.private-video',itemId:manifest.outputId+':'+input.commandId,version:manifest.sha256+':review:'+manifest.reviewRevision},
  blob:{storageKey:'rl72-native-video/'+manifest.workspaceId+'/'+manifest.outputId+'/'+manifest.sha256+'.mp4',sha256:manifest.sha256},brand:{snapshotRef:'workspace:'+manifest.workspaceId,sha256:manifest.brandSha256},
  attestation:{catalogSha256:sha(JSON.stringify(manifest)),checkedAt:new Date(reviewed).toISOString(),expiresAt:new Date(reviewed+15*60*1000).toISOString()},
  metadata:{privateOnly:true,outputId:manifest.outputId,reviewRevision:manifest.reviewRevision,requiresVideoPublicationAdapter:true}};
}
export class PgLocalVideoCanonicalHandoff {
 constructor(private readonly adapterPool:Pick<Pool,'connect'>,private readonly commandPool:Pick<Pool,'connect'>,private readonly principal:PgSeoBlogPrincipal,private readonly env:NodeJS.ProcessEnv=process.env){}
 async request(input:LocalVideoHandoffInput){
  input=Object.freeze({...input});
  if(this.env.CREATIVE_MEDIA!=='enabled'||this.env.RL72_MEDIA_CANONICAL_HANDOFF_ENABLED!=='true')throw new SeoBlogError(503,'Canonical video handoff disabled');
  const p=this.principal;if(p.kind!=='user')throw new SeoBlogError(403,'Signed-in owner required');
  checkedEditId(input.workspaceId);checkedEditId(input.outputId);checkedEditId(input.commandId);
  const session=createHash('sha256').update(p.sessionToken).digest();
  const context={actorKind:'user' as const,userId:p.userId,workspaceId:input.workspaceId,requestId:p.requestId,portalSessionTokenHash:session};
  let manifest:LocalVideoManifest|undefined;
  const runner=(pool:Pick<Pool,'connect'>):CompanyContentTransactionRunner=>({run:(ctx,operation,options)=>withTransaction(pool,ctx,async t=>{
   const fresh=(await t.query<{v:LocalVideoManifest}>('SELECT app_private.creative_media_local_manifest($1,$2,$3,$4,$5) AS v',[input.workspaceId,session,input.outputId,input.reviewRevision,input.outputSha256])).rows[0]?.v;
   if(!fresh)throw new SeoBlogError(409,'Current exact private video unavailable');
   if(manifest&&JSON.stringify(fresh)!==JSON.stringify(manifest))throw new SeoBlogError(409,'Video or brand review changed during canonical handoff');
   manifest=fresh;return operation(t);
  },{readOnly:false,isolation:options.serializable?'serializable':'read committed'})});
  const adapter=runner(this.adapterPool),commands=runner(this.commandPool);
  await adapter.run(context,async()=>{}, {readOnly:true,serializable:false});
  const draft=await new CompanyContentService({transactionRunner:adapter}).createVersion(context,localVideoDraftCommand(input,manifest!));
  const approval=await new CompanyContentService({transactionRunner:commands}).requestApproval(context,{commandKey:'media-video-review:'+input.commandId,contentItemId:draft.contentItemId,contentVersionId:draft.contentVersionId,reviewNote:'Review this exact private video, caption and platform. Publication requires the canonical video adapter and canonical scheduling.'});
  const videoCommand=localVideoDraftCommand(input,manifest!);
  const postDraft=await new CompanyContentService({transactionRunner:adapter}).createVersion(context,{
   ...videoCommand,commandKey:'media-caption:'+input.commandId,kind:'social_post',contentMimeType:'text/plain',content:input.caption,
   source:{system:'relaunch72.private-video-post',itemId:draft.contentVersionId,version:draft.contentSha256},
   blob:{storageKey:'rl72-native-caption/'+input.workspaceId+'/'+input.commandId+'.txt',sha256:sha(input.caption)},
   metadata:{nativeVideoVersionId:draft.contentVersionId,network:input.platform,outputId:input.outputId},
  });
  const postApproval=await new CompanyContentService({transactionRunner:commands}).requestApproval(context,{commandKey:'media-caption-review:'+input.commandId,contentItemId:postDraft.contentItemId,contentVersionId:postDraft.contentVersionId,reviewNote:'Canonical accompanying caption for the exact native video.'});
  return {draft,approval,postDraft,postApproval,state:'pending_canonical_review' as const,providerEffects:false as const};
 }
}
