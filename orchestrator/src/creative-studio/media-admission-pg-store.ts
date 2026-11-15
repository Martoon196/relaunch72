/**
 * Server-only owner/worker boundary for video budget admission (migration 0158).
 *
 * Database policy starts disabled/zero. A worker must obtain a unique SQL lease
 * from an actual owner-approved reservation before using any paid provider API.
 * Unknown provider outcomes hold credits and never trigger an automatic retry.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type { PgSeoBlogPrincipal } from '../seo-blog/pg-store.js';
import { SeoBlogError } from '../seo-blog/types.js';
import type { VerifiedMediaAdmission, MediaWorkKind } from './media-providers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA = /^[a-f0-9]{64}$/u;
export interface ReservedMediaJob {
  readonly id:string;
  readonly replayed:boolean;
  readonly state:'reserved'|'claimed'|'submitted'|'completed'|'failed'|'outcome_unknown';
}
export interface MediaJobSummary {
  readonly id:string;
  readonly kind:MediaWorkKind;
  readonly state:ReservedMediaJob['state'];
  readonly reservedMicrousd:number;
  readonly actualMicrousd:number|null;
  readonly createdAt:string;
}
export interface ClaimedMediaJob {
  readonly id:string;
  readonly claimToken:string;
  readonly kind:MediaWorkKind;
  readonly payloadSha:string;
  readonly rightsSha:string;
  readonly reservedMicrousd:number;
  readonly approvedBy:string;
  readonly approvedAt:string;
  readonly validUntil:string;
}
/** Constructed from PostgreSQL output only after a valid worker lease claim. */
export function providerAdmission(job:ClaimedMediaJob,workspaceId:string,commandId:string):VerifiedMediaAdmission {
  if(!UUID.test(job.id)||!UUID.test(job.approvedBy)||!UUID.test(job.claimToken)
    ||!UUID.test(workspaceId)||!UUID.test(commandId)
    ||!Number.isSafeInteger(job.reservedMicrousd)||job.reservedMicrousd<=0)
    throw new SeoBlogError(403,'Invalid video job lease');
  return Object.freeze({
    receiptId:job.id,workspaceId,commandId,kind:job.kind,approvedBy:job.approvedBy,
    approvedAt:job.approvedAt,reservedCostMicrousd:job.reservedMicrousd,
    validUntil:job.validUntil,state:'reserved' as const,
  });
}
export class PgVideoAdmissionOwner {
  private readonly sessionHash:Buffer|null;
  constructor(private readonly pool:Pick<Pool,'connect'>,private readonly principal:PgSeoBlogPrincipal){
    this.sessionHash=principal.kind==='user'?
      createHash('sha256').update(principal.sessionToken).digest():null;
  }
  private async command<T>(workspaceId:string,action:'reserve'|'list',body:Record<string,unknown>):Promise<T>{
    const p=this.principal;
    if(p.kind!=='user'||!this.sessionHash)throw new SeoBlogError(403,'Signed-in owner required');
    try{
      return await withTransaction(this.pool,{
        actorKind:'user',workspaceId,userId:p.userId,requestId:p.requestId,
        portalSessionTokenHash:this.sessionHash,
      },async(db)=>{
        const r=await db.query<{value:T}>(
          'SELECT app_private.creative_media_video_owner($1,$2,$3,$4) AS value',
          [workspaceId,this.sessionHash,action,JSON.stringify(body)]);
        return r.rows[0]!.value;
      });
    }catch(e){
      const code=(e as {code?:string}).code;
      if(code==='42501')throw new SeoBlogError(403,'Owner/brand session permission missing');
      if(code==='40001'||code==='23505')throw new SeoBlogError(409,'Paid-video request replay changed input');
      if(code==='55000')throw new SeoBlogError(409,'Paid video is disabled or over the workspace budget');
      if(code==='22023'||code==='22P02'||code==='23514')throw new SeoBlogError(400,'Invalid video reservation details');
      throw e;
    }
  }
  list(workspaceId:string):Promise<MediaJobSummary[]> {return this.command(workspaceId,'list',{});}
  reserve(input:{
    workspaceId:string;commandId?:string;jobId?:string;kind:MediaWorkKind;
    payloadSha:string;rightsSha:string;estimatedMicrousd:number;consent:boolean;
  }):Promise<ReservedMediaJob>{
    const commandId=input.commandId??randomUUID(),jobId=input.jobId??randomUUID();
    if(!UUID.test(commandId)||!UUID.test(jobId)||
      !['vizard_clip','shotstack_render'].includes(input.kind)||
      !SHA.test(input.payloadSha)||!SHA.test(input.rightsSha)||
      !Number.isSafeInteger(input.estimatedMicrousd)||input.estimatedMicrousd<=0||
      input.estimatedMicrousd>1_000_000_000_000||input.consent!==true)
      throw new SeoBlogError(400,'Reviewed media, rights, explicit consent and valid cost are required');
    return this.command(input.workspaceId,'reserve',{
      commandId,jobId,kind:input.kind,payloadSha:input.payloadSha,
      rightsSha:input.rightsSha,estimatedMicrousd:String(input.estimatedMicrousd),consent:true,
    });
  }
}
export class PgVideoAdmissionWorker {
  constructor(private readonly pool:Pick<Pool,'connect'>,private readonly requestId:string) {}
  private async command<T>(workspaceId:string,action:string,jobId:string,claimToken:string|null,
    providerId:string|null,costMicrousd:number|null):Promise<T>{
    if(!UUID.test(workspaceId)||!UUID.test(jobId)||(claimToken!==null&&!UUID.test(claimToken)))
      throw new SeoBlogError(400,'Invalid media job or claim identifier');
    return withTransaction(this.pool,{actorKind:'worker',workspaceId,requestId:this.requestId},
      async(db)=>{
        const r=await db.query<{value:T}>(
          'SELECT app_private.creative_media_video_worker($1,$2,$3,$4,$5,$6) AS value',
          [workspaceId,action,jobId,claimToken,providerId,costMicrousd]);
        return r.rows[0]!.value;
      });
  }
  claim(workspaceId:string,jobId:string):Promise<ClaimedMediaJob>{
    return this.command(workspaceId,'claim',jobId,null,null,null);
  }
  submitted(workspaceId:string,jobId:string,claimToken:string,providerId:string){
    return this.command<{id:string;state:string}>(workspaceId,'submitted',jobId,claimToken,providerId,null);
  }
  completed(workspaceId:string,jobId:string,claimToken:string,costMicrousd:number,providerId:string|null=null){
    if(!Number.isSafeInteger(costMicrousd)||costMicrousd<0)throw new SeoBlogError(400,'Invalid actual media charge');
    return this.command<{id:string;state:string}>(workspaceId,'completed',jobId,claimToken,providerId,costMicrousd);
  }
  failed(workspaceId:string,jobId:string,claimToken:string){
    return this.command<{id:string;state:string}>(workspaceId,'failed',jobId,claimToken,null,null);
  }
  unknown(workspaceId:string,jobId:string,claimToken:string){
    return this.command<{id:string;state:string}>(workspaceId,'outcome_unknown',jobId,claimToken,null,null);
  }
}
