/** Native media entitlement reader. No email-based subscription guessing and
 * no Stripe provisioning here; grants must arrive from verified billing or
 * trusted operator seed. Missing grants fail closed.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type { PgSeoBlogPrincipal } from '../seo-blog/pg-store.js';
import { SeoBlogError } from '../seo-blog/types.js';

export type MediaTier='agency_client'|'affiliate_creator'|'affiliate_business';
export interface MediaAccess {
 readonly active:boolean; readonly tier:MediaTier|null;
 readonly source:'operator_trial'|'billing_verified'|null;
 readonly monthlyVideoMicrousd:number; readonly maxJobMicrousd:number;
 readonly validUntil:string|null;
}
export const MEDIA_TIERS:Readonly<Record<MediaTier,{
  audience:string;description:string;checkoutReady:false}>>=Object.freeze({
 agency_client:{audience:'Relaunch72 client',description:'Brand-aware agency production in the same Creative Studio',checkoutReady:false},
 affiliate_creator:{audience:'Affiliate creator',description:'Private affiliate products and owned-media campaigns',checkoutReady:false},
 affiliate_business:{audience:'Affiliate business',description:'Multiple brand workspaces with central approval',checkoutReady:false},
});
export function canUsePaidVideo(access:MediaAccess,costMicrousd:number,now=new Date()):boolean{
 return access.active===true&&access.tier!==null&&access.source!==null
  &&Number.isSafeInteger(costMicrousd)&&costMicrousd>0
  &&costMicrousd<=access.maxJobMicrousd&&costMicrousd<=access.monthlyVideoMicrousd
  &&Number.isFinite(Date.parse(access.validUntil??''))
  &&Date.parse(access.validUntil!)>now.getTime();
}
export class PgMediaAccessOwner {
 private readonly hash:Buffer|null;
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly principal:PgSeoBlogPrincipal){
  this.hash=principal.kind==='user'?createHash('sha256').update(principal.sessionToken).digest():null;
 }
 async current(workspaceId:string):Promise<MediaAccess>{
  const p=this.principal;
  if(p.kind!=='user'||!this.hash)throw new SeoBlogError(403,'Signed-in media owner required');
  try{return await withTransaction(this.pool,{actorKind:'user',workspaceId,
    userId:p.userId,requestId:p.requestId,portalSessionTokenHash:this.hash},async t=>
     (await t.query<{v:MediaAccess}>('SELECT app_private.creative_media_access_owner($1,$2) AS v',
       [workspaceId,this.hash])).rows[0]!.v);}
  catch(e){
   if((e as {code?:string}).code==='42501')
    throw new SeoBlogError(403,'Only a signed-in workspace owner may view media access');
   throw e;
  }
 }
}
