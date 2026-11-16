import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type { PgSeoBlogPrincipal } from '../seo-blog/pg-store.js';
import { SeoBlogError } from '../seo-blog/types.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA=/^[a-f0-9]{64}$/u;
export type VideoSourceRights='owned'|'licensed';
export interface VideoSourceRow {
  id:string;fileName:string;sha256:string;byteLength:number;mime:'video/mp4'|'video/webm';
  storageKind?:'pg_blob'|'private_object';
  rights:VideoSourceRights;evidenceSha256:string|null;state:'awaiting_probe';createdAt:string;
}
/** Only a container signature check. A decoder, rights audit and duration probe remain mandatory. */
export function examineVideoUpload(bytes:Buffer,fileName:string,rights:VideoSourceRights,evidenceSha256:string|null,confirmed:boolean){
  if(!Buffer.isBuffer(bytes)||bytes.length<1024||bytes.length>20_000_000)
    throw new SeoBlogError(400,'Video source must be between 1 KB and 20 MB');
  if(typeof fileName!=='string'||!fileName.trim()||fileName.length>160||/[<>/\\\u0000-\u001f\u007f]/u.test(fileName))
    throw new SeoBlogError(400,'Invalid video filename');
  if(!['owned','licensed'].includes(rights)||confirmed!==true)
    throw new SeoBlogError(400,'Owner rights and explicit confirmation required');
  if((rights==='licensed'&&!evidenceSha256)||(evidenceSha256&&!SHA.test(evidenceSha256)))
    throw new SeoBlogError(400,'Licensed source requires a valid evidence SHA256');
  const mp4=/\.mp4$/iu.test(fileName)&&bytes.toString('ascii',4,8)==='ftyp'
    &&bytes.readUInt32BE(0)>=16&&bytes.readUInt32BE(0)<=bytes.length;
  const webm=/\.webm$/iu.test(fileName)&&bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
  if(!mp4&&!webm)throw new SeoBlogError(400,'MP4 or WebM container signature and extension must match');
  return {fileName:fileName.trim(),mime:(mp4?'video/mp4':'video/webm') as 'video/mp4'|'video/webm',
    sha256:createHash('sha256').update(bytes).digest('hex')};
}
export class PgCreativeVideoSources {
  private readonly sessionHash:Buffer|null;
  constructor(private readonly pool:Pick<Pool,'connect'>,private readonly principal:PgSeoBlogPrincipal){
    this.sessionHash=principal.kind==='user'?createHash('sha256').update(principal.sessionToken).digest():null;
  }
  private async command<T>(workspaceId:string,action:'list'|'upload',commandId:string|null,meta:object,bytes:Buffer|null):Promise<T>{
    const p=this.principal;
    if(p.kind!=='user'||!this.sessionHash)throw new SeoBlogError(403,'Signed-in video source owner required');
    try{return await withTransaction(this.pool,{actorKind:'user',workspaceId,userId:p.userId,requestId:p.requestId,
      portalSessionTokenHash:this.sessionHash},async(t)=>{
      const r=await t.query<{v:T}>('SELECT app_private.creative_media_video_source_command($1,$2,$3,$4,$5,$6) AS v',
        [workspaceId,this.sessionHash,action,commandId,JSON.stringify(meta),bytes]);
      return r.rows[0]!.v;
    });}catch(e){
      const code=(e as {code?:string}).code;
      if(code==='42501')throw new SeoBlogError(403,'Video owner or selected workspace was not verified');
      if(code==='40001'||code==='23505')throw new SeoBlogError(409,'Upload command replay changed the source');
      if(code==='22023'||code==='23514'||code==='22P02')throw new SeoBlogError(400,'Source file or rights evidence rejected');
      throw e;
    }
  }
  list(workspaceId:string):Promise<VideoSourceRow[]>{return this.command(workspaceId,'list',null,{},null);}
  /** Server-only owner-scoped private read; never return this from a public API or provider. */
  async load(workspaceId:string,sourceId:string):Promise<{mime:'video/mp4'|'video/webm';bytes:Buffer;sha256:string}>{
    const p=this.principal;
    if(!UUID.test(sourceId))throw new SeoBlogError(400,'Invalid video source ID');
    if(p.kind!=='user'||!this.sessionHash)throw new SeoBlogError(403,'Signed-in source owner required');
    try{
      return await withTransaction(this.pool,{actorKind:'user',workspaceId,userId:p.userId,
        requestId:p.requestId,portalSessionTokenHash:this.sessionHash},async(t)=>{
        const row=(await t.query<{mime:'video/mp4'|'video/webm';bytes:Buffer;sha256:string}>(
          'SELECT * FROM app_private.creative_media_video_source_bytes($1,$2,$3)',
          [workspaceId,this.sessionHash,sourceId])).rows[0];
        if(!row)throw new SeoBlogError(404,'Private video source not found');
        const bytes=Buffer.from(row.bytes);
        if(bytes.length>20_000_000||!['video/mp4','video/webm'].includes(row.mime)||
          createHash('sha256').update(bytes).digest('hex')!==row.sha256)
          throw new SeoBlogError(404,'Source bytes are unavailable');
        return{mime:row.mime,bytes,sha256:row.sha256};
      });
    }catch(error){
      if((error as {code?:string}).code==='42501')
        throw new SeoBlogError(403,'Source owner session or workspace not verified');
      throw error;
    }
  }
  upload(input:{workspaceId:string;commandId:string;bytes:Buffer;fileName:string;rights:VideoSourceRights;
    evidenceSha256:string|null;rightsConfirmed:boolean}):Promise<{id:string;sha256:string;replayed:boolean;state:'awaiting_probe'}>{
    if(!UUID.test(input.commandId))throw new SeoBlogError(400,'Invalid upload command');
    const meta=examineVideoUpload(input.bytes,input.fileName,input.rights,input.evidenceSha256,input.rightsConfirmed);
    return this.command(input.workspaceId,'upload',input.commandId,{...meta,
      rights:input.rights,evidenceSha256:input.evidenceSha256,rightsConfirmed:true},input.bytes);
  }
}
