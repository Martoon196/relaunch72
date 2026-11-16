/** Fresh owner assertions about the same stored merchant link. No redirect or publication. */
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {withTransaction} from '../db/transaction.js';
import type {PgSeoBlogPrincipal} from '../seo-blog/pg-store.js';
import {SeoBlogError} from '../seo-blog/types.js';
import {checkedEditId} from './media-edit-plan.js';
import {PgCreativeMediaProductStore} from './media-product-pg-store.js';
import {affiliateDirectLinkPreview} from './affiliate-direct-link.js';
export interface LinkEvidenceInput {workspaceId:string;commandId:string;productId:string;productRevision:number;evidenceSha256:string;registeredSite:string;programmeConfirmed:boolean;siteConfirmed:boolean;tagOwnershipConfirmed:boolean}
export interface LinkEvidence {commandId:string;productId:string;productRevision:number;linkSha256:string;evidenceSha256:string;registeredSite:string;disclosureVersion:string;expiresAt:string;current:boolean;status:'owner_asserted_private'}
export class PgMediaLinkEvidenceOwner {
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly principal:PgSeoBlogPrincipal,private readonly env:NodeJS.ProcessEnv=process.env){}
 private command<T>(workspace:string,action:'list'|'save',input:object):Promise<T>{
  if(this.env.CREATIVE_MEDIA!=='enabled'||this.env.RL72_MEDIA_LINK_EVIDENCE_ENABLED!=='true')return Promise.reject(new SeoBlogError(503,'Merchant evidence disabled'));
  const p=this.principal;if(p.kind!=='user')return Promise.reject(new SeoBlogError(403,'Signed-in merchant link owner required'));
  const hash=createHash('sha256').update(p.sessionToken).digest();
  return withTransaction(this.pool,{actorKind:'user',workspaceId:checkedEditId(workspace),userId:p.userId,requestId:p.requestId,portalSessionTokenHash:hash},async t=>(await t.query<{v:T}>('SELECT app_private.creative_media_link_evidence($1,$2,$3,$4) AS v',[workspace,hash,action,JSON.stringify(input)])).rows[0]!.v);
 }
 list(workspace:string):Promise<LinkEvidence[]>{return this.command(workspace,'list',{});}
 async save(input:LinkEvidenceInput):Promise<{commandId:string;replayed:boolean;status:'owner_asserted_private'}>{
  input=Object.freeze({...input});checkedEditId(input.commandId);checkedEditId(input.productId);
  if(!/^[a-f0-9]{64}$/u.test(input.evidenceSha256)||!input.programmeConfirmed||!input.siteConfirmed||!input.tagOwnershipConfirmed)throw new SeoBlogError(400,'Programme, registered-site and tag-ownership evidence required');
  let site:URL;try{site=new URL(input.registeredSite);}catch{throw new SeoBlogError(400,'Registered HTTPS site required');}
  if(site.protocol!=='https:'||site.username||site.password||site.port||site.hash||input.registeredSite.length>2048)throw new SeoBlogError(400,'Secure registered-site URL required');
  const product=await new PgCreativeMediaProductStore(this.pool,this.principal).get(input.workspaceId,input.productId);
  if(!product||product.revision!==input.productRevision)throw new SeoBlogError(409,'Current product revision required');
  const preview=affiliateDirectLinkPreview(product);if(preview.status==='blocked'||!product.proposed_affiliate_url)throw new SeoBlogError(409,preview.reason);
  return this.command(input.workspaceId,'save',{...input,registeredSite:site.href,linkSha256:createHash('sha256').update(product.proposed_affiliate_url).digest('hex'),disclosureVersion:product.disclosure_version});
 }
}
