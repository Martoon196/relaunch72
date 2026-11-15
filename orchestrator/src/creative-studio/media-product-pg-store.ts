/**
 * Canonical PostgreSQL owner-scoped affiliate product catalogue.
 * Every DB operation uses signed-in workspace, session hash, transaction-local
 * RLS and the SQL SECURITY DEFINER function from migration 0156.
 * These are owner proposals, NOT merchant approval or recorded commissions.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type { PgSeoBlogPrincipal } from '../seo-blog/pg-store.js';
import { SeoBlogError } from '../seo-blog/types.js';

export type AffiliateNetwork = 'amazon_associates' | 'other';
export type AffiliateSourceRights = 'original' | 'owned' | 'licensed' | 'none';
export interface AffiliateMediaProductInput {
  readonly network: AffiliateNetwork;
  readonly merchantName: string;
  readonly productName: string;
  readonly productUrl: string;
  readonly affiliateUrl?: string | null;
  readonly sourceRights: AffiliateSourceRights;
  readonly evidenceSha256?: string | null;
  readonly productReviewed: boolean;
  readonly channelEligible: boolean;
  readonly mediaRightsConfirmed: boolean;
  readonly disclosureVersion: string;
}
export interface AffiliateMediaProductRecord {
  readonly workspace_id: string;
  readonly product_id: string;
  readonly revision: number;
  readonly network: AffiliateNetwork;
  readonly merchant_name: string;
  readonly product_name: string;
  readonly product_url: string;
  readonly proposed_affiliate_url: string | null;
  readonly source_rights: AffiliateSourceRights;
  readonly evidence_sha256: string | null;
  readonly owner_product_reviewed: boolean;
  readonly owner_channel_eligible: boolean;
  readonly owner_media_rights_confirmed: boolean;
  readonly disclosure_version: string;
  readonly created_by: string;
  readonly created_at: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA = /^[a-f0-9]{64}$/u;
function checkedUrl(value: string,label:string):string {
  let u:URL;
  try{u=new URL(value);}catch{throw new SeoBlogError(400,'Enter a valid '+label+' URL');}
  if(u.protocol!=='https:'||u.username||u.password||u.port||value.length>2048||/[<>\s]/u.test(value)||
    !u.hostname.includes('.'))throw new SeoBlogError(400,'Enter a secure '+label+' URL');
  return u.href;
}
function checkedText(s:string,label:string,max:number):string {
  if(typeof s!=='string'||!s.trim()||s.length>max||/[\u0000-\u001f\u007f<>]/u.test(s))
    throw new SeoBlogError(400,'Enter a valid '+label);
  return s.trim();
}
export function checkedProduct(input:AffiliateMediaProductInput):AffiliateMediaProductInput {
  if(!['amazon_associates','other'].includes(input.network)||
    !['original','owned','licensed','none'].includes(input.sourceRights)||
    typeof input.productReviewed!=='boolean'||typeof input.channelEligible!=='boolean'||
    typeof input.mediaRightsConfirmed!=='boolean')
    throw new SeoBlogError(400,'Select a valid network, source-rights status and attestations');
  if(input.sourceRights==='none'&&input.mediaRightsConfirmed)
    throw new SeoBlogError(400,'You cannot confirm rights when no rights are recorded');
  if(input.sourceRights==='licensed'&&!input.evidenceSha256)
    throw new SeoBlogError(400,'Licensed source footage requires an evidence digest');
  if(input.evidenceSha256&&!SHA.test(input.evidenceSha256))
    throw new SeoBlogError(400,'Source evidence must be a SHA256 digest');
  return Object.freeze({
    ...input,merchantName:checkedText(input.merchantName,'merchant',140),
    productName:checkedText(input.productName,'product',200),
    productUrl:checkedUrl(input.productUrl,'product'),
    affiliateUrl:input.affiliateUrl?checkedUrl(input.affiliateUrl,'proposed affiliate'):null,
    disclosureVersion:checkedText(input.disclosureVersion,'disclosure version',60),
    evidenceSha256:input.evidenceSha256??null,
  });
}
export class PgCreativeMediaProductStore {
  private readonly sessionHash:Buffer|null;
  constructor(private readonly pool:Pick<Pool,'connect'>,private readonly principal:PgSeoBlogPrincipal){
    this.sessionHash=principal.kind==='user'?
      createHash('sha256').update(principal.sessionToken).digest():null;
  }
  private async command<T>(workspaceId:string,action:'list'|'get'|'save',input:Record<string,unknown>):Promise<T>{
    const p=this.principal;
    if(p.kind!=='user'||!this.sessionHash)
      throw new SeoBlogError(403,'Affiliate catalogue requires a signed-in owner');
    try{
      return await withTransaction(this.pool,{
        actorKind:'user',workspaceId,userId:p.userId,requestId:p.requestId,
        portalSessionTokenHash:this.sessionHash,
      },async(t)=>{
        const r=await t.query<{value:T}>(
          'SELECT app_private.creative_media_product_command($1,$2,$3,$4) AS value',
          [workspaceId,this.sessionHash,action,JSON.stringify(input)]);
        return r.rows[0]!.value;
      });
    }catch(e){
      if(e instanceof SeoBlogError)throw e;
      const code=(e as {code?:string}).code;
      if(code==='42501')throw new SeoBlogError(403,'The active owner session or workspace permission could not be confirmed');
      if(code==='40001'||code==='23505')throw new SeoBlogError(409,'This product changed or a command was reused with different input');
      if(code==='22023'||code==='23514'||code==='22P02')throw new SeoBlogError(400,'Check the product details and try again');
      throw e;
    }
  }
  list(workspaceId:string):Promise<AffiliateMediaProductRecord[]>{
    return this.command(workspaceId,'list',{});
  }
  get(workspaceId:string,productId:string):Promise<AffiliateMediaProductRecord|null>{
    if(!UUID.test(productId))throw new SeoBlogError(400,'Invalid product ID');
    return this.command(workspaceId,'get',{productId});
  }
  save(args:{
    readonly workspaceId:string;
    readonly productId?:string;
    readonly commandId?:string;
    readonly expectedRevision:number;
    readonly product:AffiliateMediaProductInput;
  }):Promise<{replayed:boolean;productId:string;revision:number}> {
    const productId=args.productId??randomUUID(), commandId=args.commandId??randomUUID();
    if(!UUID.test(productId)||!UUID.test(commandId))throw new SeoBlogError(400,'Invalid product or command identifier');
    if(!Number.isSafeInteger(args.expectedRevision)||args.expectedRevision<0||args.expectedRevision>999)
      throw new SeoBlogError(400,'Invalid expected product revision');
    const product=checkedProduct(args.product);
    const payload={productId,expectedRevision:args.expectedRevision,product};
    const inputSha=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return this.command(args.workspaceId,'save',{...payload,commandId,inputSha});
  }
}
