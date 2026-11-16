/** Resumable private pilot upload. Canonical 20 MB storage ceiling, no remote URL. */
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {withTransaction} from '../db/transaction.js';
import type {PgSeoBlogPrincipal} from '../seo-blog/pg-store.js';
import {SeoBlogError} from '../seo-blog/types.js';
import {checkedEditId} from './media-edit-plan.js';
export interface MediaUploadStatus {uploadId:string;state:'uploading'|'completed'|'cancelled';byteLength:number;sha256:string;sourceId:string|null;expiresAt:string;partBytes:number;parts:number[]}
export class PgResumableMediaUploads {
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly principal:PgSeoBlogPrincipal,private readonly env:NodeJS.ProcessEnv=process.env){}
 private async command<T>(workspace:string,id:string,action:string,input:object={},bytes:Buffer|null=null):Promise<T>{
  if(this.env.CREATIVE_MEDIA!=='enabled'||this.env.RL72_MEDIA_RESUMABLE_UPLOADS_ENABLED!=='true')throw new SeoBlogError(503,'Resumable video upload disabled');
  const p=this.principal;
  if(p.kind!=='user')throw new SeoBlogError(403,'Signed-in source owner required');
  const ws=checkedEditId(workspace),upload=checkedEditId(id),hash=createHash('sha256').update(p.sessionToken).digest();
  try{return await withTransaction(this.pool,{actorKind:'user',workspaceId:ws,userId:p.userId,requestId:p.requestId,portalSessionTokenHash:hash},async t=>(await t.query<{v:T}>('SELECT app_private.creative_media_upload($1,$2,$3,$4,$5,$6) AS v',[ws,hash,action,upload,JSON.stringify(input),bytes])).rows[0]!.v);}
  catch(e){const code=(e as {code?:string}).code;
   if(code==='42501')throw new SeoBlogError(403,'Private upload owner or workspace rejected');
   if(code==='40001'||code==='23505'||code==='55000')throw new SeoBlogError(409,'Upload changed, expired, incomplete or over staging limit');
   if(code==='22023'||code==='22P02'||code==='23514')throw new SeoBlogError(400,'Upload bytes or metadata rejected');throw e;}
 }
 begin(workspace:string,id:string,input:{byteLength:number;sha256:string;metadata:{fileName:string;mime:'video/mp4'|'video/webm';rights:'owned'|'licensed';evidenceSha256:string|null;rightsConfirmed:boolean}}):Promise<MediaUploadStatus>{return this.command(workspace,id,'begin',input);}
 status(workspace:string,id:string):Promise<MediaUploadStatus>{return this.command(workspace,id,'status');}
 cancel(workspace:string,id:string):Promise<MediaUploadStatus>{return this.command(workspace,id,'cancel');}
 part(workspace:string,id:string,index:number,bytes:Buffer):Promise<MediaUploadStatus>{
  if(!Number.isInteger(index)||index<0||index>19||!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>1000000)throw new SeoBlogError(400,'Bounded upload part required');
  const snapshot=Buffer.from(bytes);return this.command(workspace,id,'part',{part:index,sha256:createHash('sha256').update(snapshot).digest('hex')},snapshot);
 }
 complete(workspace:string,id:string):Promise<{id:string;sha256:string;state:'awaiting_probe';replayed:boolean}>{return this.command(workspace,id,'complete');}
}
