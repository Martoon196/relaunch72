/** Exact-version owner review for offline local renders. Always private; unmounted. */
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {withTransaction} from '../db/transaction.js';
import {SeoBlogError} from '../seo-blog/types.js';
import type {PgSeoBlogPrincipal} from '../seo-blog/pg-store.js';
import {checkedPrivateReview,type PrivateOutputReview,type PrivateReviewInput,type PrivateReviewDecision} from './media-output-review.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
export class PgLocalOutputReviewOwner {
 private readonly sessionHash:Buffer|null;
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly principal:PgSeoBlogPrincipal,
   private readonly env:NodeJS.ProcessEnv=process.env){
  this.sessionHash=principal.kind==='user'
   ?createHash('sha256').update(principal.sessionToken).digest():null;
 }
 private async command<T>(workspaceId:string,action:'list'|'review',payload:object):Promise<T> {
  const p=this.principal;
  if(this.env.CREATIVE_MEDIA!=='enabled'||this.env.RL72_MEDIA_LOCAL_RENDER_ENABLED!=='true')
   throw new SeoBlogError(503,'Private media review is disabled');
  if(p.kind!=='user'||!this.sessionHash)
   throw new SeoBlogError(403,'A signed-in workspace owner is required');
  try{
   return await withTransaction(this.pool,{actorKind:'user',workspaceId,userId:p.userId,
    requestId:p.requestId,portalSessionTokenHash:this.sessionHash},async t=>
    (await t.query<{value:T}>('SELECT app_private.creative_media_local_output_review($1,$2,$3,$4) AS value',
      [workspaceId,this.sessionHash,action,JSON.stringify(payload)])).rows[0]!.value);
  }catch(e){
   const code=(e as {code?:string}).code;
   if(code==='42501')throw new SeoBlogError(403,'Private output or owner session not authorised');
   if(code==='40001'||code==='23505')throw new SeoBlogError(409,'Private output review changed; reload the latest version');
   if(code==='55000')throw new SeoBlogError(409,'The video is not technically verified or the requested review transition is invalid');
   if(code==='22023'||code==='23514'||code==='22P02')
    throw new SeoBlogError(400,'Private output review failed validation');
   throw e;
  }
 }
 list(workspaceId:string):Promise<PrivateOutputReview[]> {
  if(!UUID.test(workspaceId))throw new SeoBlogError(400,'Invalid video workspace');
  return this.command(workspaceId,'list',{});
 }
 review(input:PrivateReviewInput):Promise<{outputId:string;revision:number;
   replayed:boolean;decision:PrivateReviewDecision}> {
  const clean=checkedPrivateReview(input);
  return this.command(clean.workspaceId,'review',{
   outputId:clean.outputId,outputSha256:clean.outputSha256,
   commandId:clean.commandId,expectedRevision:clean.expectedRevision,
   decision:clean.decision,rightsConfirmed:clean.rightsConfirmed,
   claimsConfirmed:clean.claimsConfirmed,disclosureConfirmed:clean.disclosureConfirmed,
  });
 }
}
