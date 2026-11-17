/** Unmounted native adapter: same canonical planner tables and Zernio queue. */
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {withTransaction} from '../db/transaction.js';
import type {PgSeoBlogPrincipal} from '../seo-blog/pg-store.js';
import {SeoBlogError} from '../seo-blog/types.js';
import {checkedEditId} from './media-edit-plan.js';
import {PgSocialCampaignCommandRepository} from '../social-campaign-pg/repository.js';
import {socialCampaignRevisionSha256} from '../social-campaign-pg/validation.js';
const derived=(scope:string,ws:string,command:string)=>{const h=createHash('sha256').update(scope+':'+ws+':'+command).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-5'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20,32);};
export interface NativeCalendarPlan {workspaceId:string;commandId:string;postVersionId:string;videoVersionId:string;connectionId:string;network:'instagram'|'linkedin';profileSha256:string;accountSha256:string;scheduledFor:string}
export class PgNativeVideoPlanner {
 constructor(private readonly adapter:Pick<Pool,'connect'>,private readonly planning:Pick<Pool,'connect'>,private readonly zernio:Pick<Pool,'connect'>,private readonly principal:PgSeoBlogPrincipal,private readonly env:NodeJS.ProcessEnv=process.env){}
 async plan(input:NativeCalendarPlan){
  input=Object.freeze({...input});
  if(this.env.CREATIVE_MEDIA!=='enabled'||this.env.RL72_MEDIA_NATIVE_CALENDAR_ENABLED!=='true')throw new SeoBlogError(503,'Native calendar adapter disabled');
  const p=this.principal;if(p.kind!=='user')throw new SeoBlogError(403,'Owner required');
  for(const id of [input.workspaceId,input.commandId,input.postVersionId,input.videoVersionId,input.connectionId])checkedEditId(id);
  if(!['instagram','linkedin'].includes(input.network)||![input.profileSha256,input.accountSha256].every(x=>/^[a-f0-9]{64}$/u.test(x))||!Number.isFinite(Date.parse(input.scheduledFor)))throw new SeoBlogError(400,'Exact approved post/video and registered account required');
  const hash=createHash('sha256').update(p.sessionToken).digest(),ctx={actorKind:'user' as const,workspaceId:input.workspaceId,userId:p.userId,requestId:p.requestId,portalSessionTokenHash:hash};
  await withTransaction(this.adapter,ctx,t=>t.query('SELECT app_private.creative_media_refresh_native_planning($1,$2,$3)',[input.workspaceId,hash,input.postVersionId]));
  const target=await withTransaction(this.zernio,ctx,async t=>(await t.query<{test_target_id:string}>('SELECT test_target_id FROM app_private.bootstrap_zernio_calendar_planner_target($1,$2,$3,$4,$5)',[input.workspaceId,input.connectionId,input.network,Buffer.from(input.profileSha256,'hex'),Buffer.from(input.accountSha256,'hex')])).rows[0]!,{isolation:'serializable'});
  const intent=derived('native-intent',input.workspaceId,input.commandId),campaign=derived('native-campaign',input.workspaceId,input.commandId),revision=derived('native-revision',input.workspaceId,input.commandId);
  const ticket=await withTransaction(this.planning,ctx,async t=>{
   const draft={workspaceId:input.workspaceId,campaignId:campaign,revisionId:revision,revisionNumber:1,previousRevisionId:null,title:'Native affiliate video',objective:'Publish the exact approved caption and native video',timezone:'Europe/London'};
   await new PgSocialCampaignCommandRepository(t).createRevision({...draft,revisionSha256:socialCampaignRevisionSha256(draft)});
   await t.query('SELECT * FROM app_private.creative_media_create_planning_intent($1,$2,$3,$4,$5,$6,$7::smallint,$8::uuid[],$9::uuid[])',[input.workspaceId,intent,campaign,revision,input.postVersionId,input.scheduledFor,3,[target.test_target_id],[input.videoVersionId]]);
   return (await t.query<{content_item_id:string;content_version_id:string;approval_request_id:string;approval_decision_id:string;source_attestation_id:string;target_id:string}>('SELECT * FROM app_private.creative_media_native_plan_ticket($1,$2)',[input.workspaceId,intent])).rows[0]!;
  },{isolation:'serializable'});
  const job=await withTransaction(this.zernio,ctx,async t=>(await t.query<{job_id:string}>('SELECT job_id FROM app_private.enqueue_zernio_calendar_from_connected_account($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',[input.workspaceId,input.connectionId,input.network,Buffer.from(input.profileSha256,'hex'),Buffer.from(input.accountSha256,'hex'),intent,ticket.target_id,ticket.content_item_id,ticket.content_version_id,ticket.approval_request_id,ticket.approval_decision_id,ticket.source_attestation_id,'native-video:'+input.commandId,input.scheduledFor])).rows[0]!,{isolation:'serializable'});
  return {intentId:intent,jobId:job.job_id,providerEffects:false as const};
 }
}
export class PgNativeVideoJitWorker {
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly requestId:string,private readonly env:NodeJS.ProcessEnv=process.env){}
 attest(workspaceId:string){
  if(this.env.CREATIVE_MEDIA!=='enabled'||this.env.RL72_MEDIA_WORKER_ENABLED!=='true'||this.env.RL72_MEDIA_NATIVE_CALENDAR_ENABLED!=='true')throw new SeoBlogError(503,'Native JIT disabled');
  checkedEditId(workspaceId);return withTransaction(this.pool,{actorKind:'worker',workspaceId,requestId:this.requestId},async t=>(await t.query<{n:number}>('SELECT app_private.creative_media_attest_due_native($1) AS n',[workspaceId])).rows[0]!.n);
 }
}
