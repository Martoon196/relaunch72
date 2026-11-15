/**
 * Immutable, session-scoped video edit project revisions. This extends the
 * Creative Studio owner capability, not a second tenant/media engine.
 */
import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {withTransaction} from '../db/transaction.js';
import {SeoBlogError} from '../seo-blog/types.js';
import type {PgSeoBlogPrincipal} from '../seo-blog/pg-store.js';
import {checkVideoEditPlan,checkedEditId,videoEditDigest,type VideoEditPlan} from './media-edit-plan.js';
export interface VideoEditVersion {
 readonly id:string;readonly revision:number;readonly sourceId:string;
 readonly sourceSha256:string;readonly plan:VideoEditPlan;readonly planSha256:string;
 readonly createdAt:string;
}
export class PgMediaEditStore {
 private readonly hash:Buffer|null;
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly principal:PgSeoBlogPrincipal){
  this.hash=principal.kind==='user'?createHash('sha256').update(principal.sessionToken).digest():null;
 }
 private async command<T>(workspaceId:string,action:'list'|'save'|'get',payload:object):Promise<T>{
  const p=this.principal;
  if(p.kind!=='user'||!this.hash)throw new SeoBlogError(403,'Sign in as the editing workspace owner');
  try{
   return await withTransaction(this.pool,{actorKind:'user',workspaceId,userId:p.userId,
     requestId:p.requestId,portalSessionTokenHash:this.hash},async t=>
      (await t.query<{value:T}>('SELECT app_private.creative_media_edit_command($1,$2,$3,$4) AS value',
       [workspaceId,this.hash,action,JSON.stringify(payload)])).rows[0]!.value);
  }catch(error){
   const code=(error as {code?:string}).code;
   if(code==='42501')throw new SeoBlogError(403,'Active editor owner session is required');
   if(code==='40001'||code==='23505')throw new SeoBlogError(409,'Timeline changed or a command was reused');
   if(code==='22023'||code==='23514'||code==='22P02')throw new SeoBlogError(400,'Invalid timeline or source file');
   throw error;
  }
 }
 list(workspaceId:string):Promise<VideoEditVersion[]> {return this.command(workspaceId,'list',{});}
 get(workspaceId:string,id:string):Promise<VideoEditVersion|null>{
  return this.command(workspaceId,'get',{projectId:checkedEditId(id)});
 }
 save(input:{workspaceId:string;projectId?:string;commandId?:string;expectedRevision:number;
  sourceId:string;sourceSha256:string;plan:VideoEditPlan}):
   Promise<{id:string;revision:number;replayed:boolean}>{
  const projectId=checkedEditId(input.projectId??randomUUID());
  const commandId=checkedEditId(input.commandId??randomUUID());
  const sourceId=checkedEditId(input.sourceId);
  if(!/^[a-f0-9]{64}$/u.test(input.sourceSha256)||!Number.isInteger(input.expectedRevision)||
    input.expectedRevision<0||input.expectedRevision>=100)
   throw new SeoBlogError(400,'Invalid media source SHA or edit revision');
  const plan=checkVideoEditPlan(input.plan),planRaw=JSON.stringify(plan);
  return this.command(input.workspaceId,'save',{projectId,commandId,expectedRevision:input.expectedRevision,
    sourceId,sourceSha256:input.sourceSha256,planRaw,planSha256:videoEditDigest(plan)});
 }
}
