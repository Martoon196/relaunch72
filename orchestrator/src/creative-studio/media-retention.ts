import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {withTransaction} from '../db/transaction.js';
import type {PgSeoBlogPrincipal} from '../seo-blog/pg-store.js';
import {SeoBlogError} from '../seo-blog/types.js';
import {checkedEditId} from './media-edit-plan.js';
import {PrivateMediaFiles,type PrivateMediaObject} from './media-private-files.js';
export class PgMediaErasureOwner{
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly principal:PgSeoBlogPrincipal,private readonly env:NodeJS.ProcessEnv=process.env){}
 async erase(workspaceId:string,kind:'source'|'local_output'|'provider_output',id:string){
  if(this.env.CREATIVE_MEDIA!=='enabled'||this.env.RL72_MEDIA_RETENTION_ENABLED!=='true')throw new SeoBlogError(503,'Media erasure disabled');
  const p=this.principal;if(p.kind!=='user')throw new SeoBlogError(403,'Owner required');checkedEditId(workspaceId);checkedEditId(id);
  const hash=createHash('sha256').update(p.sessionToken).digest();
  await withTransaction(this.pool,{actorKind:'user',workspaceId,userId:p.userId,requestId:p.requestId,portalSessionTokenHash:hash},t=>t.query('SELECT app_private.creative_media_erase_owner($1,$2,$3,$4)',[workspaceId,hash,kind,id]));
 }
}
export class PgMediaRetentionWorker{
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly requestId:string,private readonly files:PrivateMediaFiles|null){}
 async sweep(workspaceId:string){checkedEditId(workspaceId);const context={actorKind:'worker' as const,workspaceId,requestId:this.requestId};
  const due=await withTransaction(this.pool,context,async t=>(await t.query<{v:Array<{kind:string;id:string;object:PrivateMediaObject}>}>('SELECT app_private.creative_media_retention($1) AS v',[workspaceId])).rows[0]!.v);
  for(const item of due){if(!this.files)throw new SeoBlogError(503,'Private disk required to finish pending erasure');await this.files.discardUncommitted(item.object);await this.files.clearParts(workspaceId,item.id);await withTransaction(this.pool,context,t=>t.query('SELECT app_private.creative_media_retention($1,$2,$3)',[workspaceId,item.kind,item.id]));}
 }
}
