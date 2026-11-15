/** Same owner and workspace security as Creative Studio; these outputs are NOT approved. */
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {withTransaction} from '../db/transaction.js';
import type {PgSeoBlogPrincipal} from '../seo-blog/pg-store.js';
import {SeoBlogError} from '../seo-blog/types.js';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
export interface MediaOutputSummary {
 id:string;jobId:string;sha256:string;mime:'video/mp4'|'video/webm';slot:number;
 state:'captured_unverified';byteLength:number;createdAt:string;
}
export class PgMediaVideoOutputOwner {
 private readonly hash:Buffer|null;
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly p:PgSeoBlogPrincipal){
  this.hash=p.kind==='user'?createHash('sha256').update(p.sessionToken).digest():null;
 }
 private tx<T>(workspaceId:string,run:(t:import('../db/transaction.js').DbTransaction)=>Promise<T>):Promise<T>{
  if(this.p.kind!=='user'||!this.hash)throw new SeoBlogError(403,'Signed-in media owner required');
  return withTransaction(this.pool,{actorKind:'user',workspaceId,userId:this.p.userId,
   requestId:this.p.requestId,portalSessionTokenHash:this.hash},run);
 }
 list(workspaceId:string):Promise<MediaOutputSummary[]>{
  return this.tx(workspaceId,async t=>(await t.query<{value:MediaOutputSummary[]}>(
   'SELECT app_private.creative_media_video_outputs_owner($1,$2) AS value',
   [workspaceId,this.hash])).rows[0]!.value);
 }
 load(workspaceId:string,id:string):Promise<{mime:'video/mp4'|'video/webm';bytes:Buffer;sha256:string}>{
  if(!UUID.test(id))throw new SeoBlogError(400,'Invalid private output identity');
  return this.tx(workspaceId,async t=>{
   const row=(await t.query<{mime:'video/mp4'|'video/webm';bytes:Buffer;sha256:string}>(
    'SELECT * FROM app_private.creative_media_video_output_bytes($1,$2,$3)',
    [workspaceId,this.hash,id])).rows[0];
   if(!row)throw new SeoBlogError(404,'Private output not found');
   const bytes=Buffer.from(row.bytes);
   if(bytes.length<1024||bytes.length>20_000_000||createHash('sha256').update(bytes).digest('hex')!==row.sha256)
    throw new SeoBlogError(404,'Private output failed integrity check');
   return {mime:row.mime,bytes,sha256:row.sha256};
  });
 }
}
