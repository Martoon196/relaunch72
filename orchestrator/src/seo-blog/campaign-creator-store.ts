import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type { PgSeoBlogPrincipal } from './pg-store.js';
import type { CampaignContent, CampaignCreatorStore, CreatorBegin, CreatorRecord } from './campaign-creator.js';
import { SeoBlogError } from './types.js';

export class PgCampaignCreatorStore implements CampaignCreatorStore {
  private readonly sessionHash:Buffer|null;
  constructor(private readonly pool:Pick<Pool,'connect'>,private readonly principal:PgSeoBlogPrincipal){this.sessionHash=principal.kind==='user'?createHash('sha256').update(principal.sessionToken).digest():null;}
  private async call(brandId:string,id:string|null,action:string,input:unknown={}):Promise<any>{
    const p=this.principal;if(p.kind!=='user')throw new SeoBlogError(403,'Campaign authoring requires a signed-in owner.');
    try{return await withTransaction(this.pool,{actorKind:'user',workspaceId:brandId,userId:p.userId,requestId:p.requestId},async t=>{
      const guard=await t.query<{ok:boolean}>('SELECT app_private.lock_active_portal_session($1,$2,$3) AS ok',[this.sessionHash,p.userId,p.selectedWorkspaceId]);
      if(guard.rows[0]?.ok!==true)throw new SeoBlogError(401,'Sign in again to continue.');
      return (await t.query<{value:unknown}>('SELECT app_private.seo_creator_command($1,$2,$3,$4,$5) AS value',[brandId,this.sessionHash,id,action,JSON.stringify(input)])).rows[0]!.value;
    });}catch(e){
      const code=(e as {code?:string}).code;
      if(code==='40001')throw new SeoBlogError(409,'This campaign changed. Refresh and review its current version.');
      if(code==='42501')throw new SeoBlogError(403,'The current owner session or brand permission could not be confirmed.');
      if(code==='22023'||code==='23514')throw new SeoBlogError(400,'Check the campaign fields and approved action, then try again.');
      if(code==='55000')throw new SeoBlogError(409,(e as Error).message.slice(0,300));
      throw e;
    }
  }
  begin(input:CreatorBegin):Promise<{record:CreatorRecord;created:boolean}>{return this.call(input.brandId,input.id,'begin',input);}
  get(brandId:string,id:string):Promise<CreatorRecord|null>{return this.call(brandId,id,'get');}
  list(brandId:string):Promise<CreatorRecord[]>{return this.call(brandId,null,'list');}
  complete(brandId:string,id:string,receiptId:string,content:CampaignContent|null,detail:string):Promise<CreatorRecord>{return this.call(brandId,id,'complete',{receiptId,contentText:content?JSON.stringify(content):null,detail});}
  edit(brandId:string,id:string,expectedRowVersion:number,expectedSha:string,content:CampaignContent):Promise<CreatorRecord>{return this.call(brandId,id,'edit',{expectedRowVersion,expectedSha,contentText:JSON.stringify(content)});}
  approve(brandId:string,id:string,expectedRowVersion:number,expectedSha:string):Promise<CreatorRecord>{return this.call(brandId,id,'approve',{expectedRowVersion,expectedSha});}
  recover(brandId:string,id:string):Promise<CreatorRecord>{return this.call(brandId,id,'recover');}
}
