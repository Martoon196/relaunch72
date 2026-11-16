import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import type {Pool} from 'pg';
import {withTransaction} from '../db/transaction.js';
import type {PgSeoBlogPrincipal} from '../seo-blog/pg-store.js';
import {SeoBlogError} from '../seo-blog/types.js';
import {checkedEditId} from './media-edit-plan.js';
import {PrivateMediaFiles,type PrivateMediaObject,type PrivateMediaFile} from './media-private-files.js';
import {decodeFfprobe,VIDEO_PROBE_VERSION,type VideoProbe} from './media-source-probe.js';
export interface ObjectUploadStatus extends PrivateMediaObject {state:'uploading'|'completed'|'cancelled';expiresAt:string;partBytes:number}
export class PgPrivateObjectSources {
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly principal:PgSeoBlogPrincipal,private readonly files:PrivateMediaFiles,private readonly env:NodeJS.ProcessEnv=process.env){}
 private async command<T>(workspace:string,action:string,id:string,input:object={}):Promise<T>{
  if(this.env.CREATIVE_MEDIA!=='enabled'||this.env.RL72_MEDIA_PRIVATE_FILES_ENABLED!=='true')throw new SeoBlogError(503,'Private object sources disabled');
  const p=this.principal;if(p.kind!=='user')throw new SeoBlogError(403,'Signed-in source owner required');
  const ws=checkedEditId(workspace),source=checkedEditId(id),hash=createHash('sha256').update(p.sessionToken).digest(),payload=JSON.stringify(input);
  return withTransaction(this.pool,{actorKind:'user',workspaceId:ws,userId:p.userId,requestId:p.requestId,portalSessionTokenHash:hash},async t=>(await t.query<{v:T}>('SELECT app_private.creative_media_object_upload($1,$2,$3,$4,$5) AS v',[ws,hash,action,source,payload])).rows[0]!.v);
 }
 begin(ws:string,id:string,input:{byteLength:number;sha256:string;fileName:string;mime:'video/mp4'|'video/webm';rights:'owned'|'licensed';evidenceSha256:string|null;rightsConfirmed:boolean}):Promise<ObjectUploadStatus>{return this.command(ws,'begin',id,input);}
 async status(ws:string,id:string):Promise<ObjectUploadStatus&{parts:Array<{index:number;sha256:string}>}>{const value=await this.command<ObjectUploadStatus>(ws,'status',id);return {...value,parts:value.state==='uploading'&&Date.parse(value.expiresAt)>Date.now()?await this.files.parts(ws,id,value.byteLength):[]};}
 async part(ws:string,id:string,index:number,bytes:Buffer){const status=await this.command<ObjectUploadStatus>(ws,'status',id);if(status.state!=='uploading'||Date.parse(status.expiresAt)<=Date.now())throw new SeoBlogError(409,'Object upload closed or expired');return this.files.putPart(ws,id,index,status.byteLength,bytes);}
 async complete(ws:string,id:string){const status=await this.command<ObjectUploadStatus>(ws,'status',id);if(status.state==='completed'){await this.files.verify(status);return status;}if(status.state!=='uploading'||Date.parse(status.expiresAt)<=Date.now())throw new SeoBlogError(409,'Object upload closed or expired');try{await this.files.assemble(status,id);const saved=await this.command<ObjectUploadStatus>(ws,'complete',id);await this.files.clearParts(ws,id);return saved;}catch(error){const current=await this.command<ObjectUploadStatus>(ws,'status',id).catch(()=>null);if(current?.state==='cancelled')await this.files.discardUncommitted(current);throw error;}}
 async cancel(ws:string,id:string){const saved=await this.command<ObjectUploadStatus>(ws,'cancel',id);await this.files.clearParts(ws,id);await this.files.discardUncommitted(saved);return saved;}
 async source(ws:string,id:string):Promise<PrivateMediaObject>{const result=await this.command<PrivateMediaObject|null>(ws,'source',id);if(!result)throw new SeoBlogError(404,'Private object source unavailable');return result;}
 async range(ws:string,id:string,start:number,end:number){return this.files.readRange(await this.source(ws,id),start,end);}
}
/** No network protocols or caller URLs: the input is a hash-checked private file. */
export async function probePrivateMediaFile(file:PrivateMediaFile):Promise<VideoProbe>{
 return new Promise(resolve=>{
  let stdout='',stderr='',done=false;const finish=(result:VideoProbe)=>{if(!done){done=true;resolve(result);}};
  const child=spawn('prlimit',['--as=402653184','--cpu=12','--nofile=64','--','ffprobe','-max_alloc','67108864','-threads','1','-codec_whitelist','h264,aac,pcm_s16le','-v','error','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm','-show_entries','format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate','-of','json','-i',file.path],{shell:false,stdio:['ignore','pipe','pipe'],timeout:15000});
  child.stdout.on('data',(chunk:Buffer)=>{stdout+=chunk.toString();if(stdout.length>100000)child.kill('SIGKILL');});
  child.stderr.on('data',(chunk:Buffer)=>{stderr+=chunk.toString();if(stderr.length>10000)child.kill('SIGKILL');});
  child.on('error',()=>finish({status:'rejected',checkerVersion:VIDEO_PROBE_VERSION,rejectionCode:'tool_unavailable'}));
  child.on('close',code=>{if(code!==0||stdout.length>100000)return finish({status:'rejected',checkerVersion:VIDEO_PROBE_VERSION,rejectionCode:'probe_failed'});try{finish(decodeFfprobe(JSON.parse(stdout)));}catch{finish({status:'rejected',checkerVersion:VIDEO_PROBE_VERSION,rejectionCode:'malformed'});}});
 });
}
export class PgPrivateObjectProbeWorker {
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly requestId:string,private readonly files:PrivateMediaFiles,private readonly env:NodeJS.ProcessEnv=process.env){}
 async run(ws:string,id:string):Promise<{status:string;replayed:boolean}|null>{
  if(this.env.CREATIVE_MEDIA!=='enabled'||this.env.RL72_MEDIA_WORKER_ENABLED!=='true'||this.env.RL72_MEDIA_PRIVATE_FILES_ENABLED!=='true')throw new SeoBlogError(503,'Private object probe disabled');
  checkedEditId(ws);checkedEditId(id);const context={actorKind:'worker' as const,workspaceId:ws,requestId:this.requestId};
  const source=await withTransaction(this.pool,context,async t=>(await t.query<{v:PrivateMediaObject|null}>('SELECT app_private.creative_media_object_source_worker($1,$2) AS v',[ws,id])).rows[0]!.v);
  if(!source)return null;const measured=await probePrivateMediaFile(await this.files.verify(source));
  return withTransaction(this.pool,context,async t=>(await t.query<{v:{status:string;replayed:boolean}}>('SELECT app_private.creative_media_video_probe_record($1,$2,$3,$4) AS v',[ws,id,source.sha256,JSON.stringify(measured)])).rows[0]!.v);
 }
}
/** Manual bounded housekeeping. Completed catalogue sources are never selected. */
export class PgPrivateObjectCleanupWorker {
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly requestId:string,private readonly files:PrivateMediaFiles,private readonly env:NodeJS.ProcessEnv=process.env){}
 async sweep(workspace:string,limit=3){
  if(this.env.CREATIVE_MEDIA!=='enabled'||this.env.RL72_MEDIA_WORKER_ENABLED!=='true'||this.env.RL72_MEDIA_PRIVATE_FILES_ENABLED!=='true')throw new SeoBlogError(503,'Private object cleanup disabled');
  const ws=checkedEditId(workspace);if(!Number.isInteger(limit)||limit<1||limit>10)throw new SeoBlogError(400,'Bounded cleanup required');
  const due=await withTransaction(this.pool,{actorKind:'worker',workspaceId:ws,requestId:this.requestId},async t=>(await t.query<{v:PrivateMediaObject[]}>('SELECT app_private.creative_media_object_cleanup($1,$2) AS v',[ws,limit])).rows[0]!.v);
  const results:Array<{sourceId:string;state:'cleaned'|'held'}>=[];
  for(const source of due){try{await this.files.clearParts(ws,source.sourceId);await this.files.discardUncommitted(source);results.push({sourceId:source.sourceId,state:'cleaned'});}catch{results.push({sourceId:source.sourceId,state:'held'});}}
  return results;
 }
}
