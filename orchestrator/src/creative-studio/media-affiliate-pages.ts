import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import type {Pool} from 'pg';
import {withTransaction} from '../db/transaction.js';
import type {PgSeoBlogPrincipal} from '../seo-blog/pg-store.js';
import {SeoBlogError} from '../seo-blog/types.js';
import {checkedEditId} from './media-edit-plan.js';
import {PgCreativeMediaProductStore} from './media-product-pg-store.js';
import {PgMediaLinkEvidenceOwner} from './media-link-evidence.js';
import {affiliateDirectLinkPreview} from './affiliate-direct-link.js';
export interface AffiliatePublicPage {publicationId:string;productRevision:number;productName:string;merchantName:string;productUrl:string;affiliateUrl:string;network:'amazon_associates';disclosureVersion:string;registeredSite:string;origin:string;signingKeySha256:string}
export function affiliateClickToken(publicationId:string,revision:number,key:Buffer,now=Date.now(),nonce:string=randomUUID()):string{
 checkedEditId(publicationId);checkedEditId(nonce);if(!Number.isInteger(revision)||revision<1||revision>1000||!Buffer.isBuffer(key)||key.length!==32)throw new SeoBlogError(503,'Affiliate click signing unavailable');
 const body=publicationId+'.'+nonce+'.'+(Math.floor(now/1000)+600)+'.'+revision;
 return body+'.'+createHmac('sha256',key).update(body).digest('hex');
}
export function validAffiliateClickToken(token:string,key:Buffer,now=Date.now()):boolean{
 if(typeof token!=='string'||token.length>300||!/^[a-f0-9-]{36}\.[a-f0-9-]{36}\.[0-9]{10}\.[0-9]{1,4}\.[a-f0-9]{64}$/u.test(token)||key.length!==32)return false;
 const parts=token.split('.'),expiry=Number(parts[2]);if(expiry<now/1000||expiry>now/1000+600)return false;
 const supplied=Buffer.from(parts[4]!,'hex'),expected=createHmac('sha256',key).update(parts.slice(0,4).join('.')).digest();return supplied.length===expected.length&&timingSafeEqual(supplied,expected);
}
export class PgAffiliatePublicationOwner {
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly principal:PgSeoBlogPrincipal,private readonly env:NodeJS.ProcessEnv=process.env){}
 private async command<T>(workspace:string,action:string,input:object):Promise<T>{
  if(this.env.CREATIVE_MEDIA!=='enabled'||this.env.RL72_MEDIA_AFFILIATE_PAGES_ENABLED!=='true')throw new SeoBlogError(503,'Affiliate product pages disabled');
  const p=this.principal;if(p.kind!=='user')throw new SeoBlogError(403,'Signed-in product page owner required');
  const ws=checkedEditId(workspace),hash=createHash('sha256').update(p.sessionToken).digest(),body=JSON.stringify(input);
  return withTransaction(this.pool,{actorKind:'user',workspaceId:ws,userId:p.userId,requestId:p.requestId,portalSessionTokenHash:hash},async t=>(await t.query<{v:T}>('SELECT app_private.creative_media_affiliate_publication_owner($1,$2,$3,$4) AS v',[ws,hash,action,body])).rows[0]!.v);
 }
 list(workspace:string):Promise<Array<{publicationId:string;productId:string;productRevision:number;withdrawn:boolean;observedClicks:number;orders:null;commission:null}>>{return this.command(workspace,'list',{});}
 async publish(input:{workspaceId:string;productId:string;productRevision:number;evidenceCommandId:string;publicationId:string;commandId:string;consent:boolean}){
  input=Object.freeze({...input});for(const id of [input.productId,input.evidenceCommandId,input.publicationId,input.commandId])checkedEditId(id);
  if(input.consent!==true)throw new SeoBlogError(400,'Explicit product-page publication consent required');
  const product=await new PgCreativeMediaProductStore(this.pool,this.principal).get(input.workspaceId,input.productId);
  const evidence=(await new PgMediaLinkEvidenceOwner(this.pool,this.principal,{...this.env,RL72_MEDIA_LINK_EVIDENCE_ENABLED:'true'}).list(input.workspaceId)).find(x=>x.commandId===input.evidenceCommandId&&x.current);
  if(!product||product.revision!==input.productRevision||!evidence)throw new SeoBlogError(409,'Current exact product and evidence required');
  const link=affiliateDirectLinkPreview(product);if(link.status==='blocked')throw new SeoBlogError(409,link.reason);
  return this.command<{publicationId:string;url:string;state:'owner_authorized'}>(input.workspaceId,'publish',{...input,exactLink:product.proposed_affiliate_url,registeredSite:evidence.registeredSite});
 }
 withdraw(workspaceId:string,publicationId:string,commandId:string){checkedEditId(publicationId);checkedEditId(commandId);return this.command(workspaceId,'withdraw',{publicationId,commandId,consent:true});}
}
export class PgAffiliatePublicPages {
 constructor(private readonly pool:Pick<Pool,'query'>,private readonly key:Buffer,private readonly env:NodeJS.ProcessEnv=process.env,private readonly clickPool?:Pick<Pool,'query'>){}
 private gate(){if(this.env.CREATIVE_MEDIA!=='enabled'||this.env.RL72_MEDIA_AFFILIATE_PAGES_ENABLED!=='true'||!Buffer.isBuffer(this.key)||this.key.length!==32)throw new SeoBlogError(503,'Affiliate public pages unavailable');}
 async page(id:string,observation?:{sourceHash:Buffer}):Promise<{page:AffiliatePublicPage;clickToken:string}|null>{
  this.gate();checkedEditId(id);const page=(await this.pool.query<{v:AffiliatePublicPage|null}>('SELECT app_private.creative_media_affiliate_page($1) AS v',[id])).rows[0]?.v;
  if(!page)return null;
  if(page.signingKeySha256!==createHash('sha256').update(this.key).digest('hex'))throw new SeoBlogError(503,'Affiliate click signing policy mismatch');
  const preview=affiliateDirectLinkPreview({network:page.network,product_url:page.productUrl,proposed_affiliate_url:page.affiliateUrl,owner_product_reviewed:true,owner_channel_eligible:true,disclosure_version:page.disclosureVersion});
  if(preview.status==='blocked')return null;// A server-derived, deployment-keyed source digest only. Never a browser field.
  // Stable daily nonce bounds one source/page/day; repeat page loads cannot
  // mint new countable clicks. Still unverified observations, never purchases.
  if(!observation||observation.sourceHash.length!==32)return {page,clickToken:''};
  const raw=createHmac('sha256',this.key).update('click-source/v2:'+id+':'+Math.floor(Date.now()/86400000)+':').update(observation.sourceHash).digest();raw[6]=(raw[6]!&15)|64;raw[8]=(raw[8]!&63)|128;
  const hex=raw.subarray(0,16).toString('hex'),nonce=hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
  return {page,clickToken:affiliateClickToken(page.publicationId,page.productRevision,this.key,Date.now(),nonce)};
 }
 async click(token:string):Promise<boolean>{this.gate();if(!this.clickPool||!validAffiliateClickToken(token,this.key))return false;return (await this.clickPool.query<{accepted:boolean}>('SELECT app_private.creative_media_affiliate_click($1) AS accepted',[token])).rows[0]?.accepted===true;}
}
