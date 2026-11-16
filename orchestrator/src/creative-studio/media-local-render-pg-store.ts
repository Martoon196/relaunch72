/**
 * Native media queue boundary: exact owner-saved timeline -> trusted worker
 * -> independently probed private MP4. SQL and flags are BOTH required.
 *
 * This never calls Vizard/Shotstack, changes a subscription, or publishes.
 * The captured local output is an UNAPPROVED private render candidate.
 * Claude owns enabling/mounting the UI routes and numbered schema rollout.
 */
import type {PrivateMediaObject} from './media-private-files.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction.js';
import { SeoBlogError } from '../seo-blog/types.js';
import type { PgSeoBlogPrincipal } from '../seo-blog/pg-store.js';
import { checkVideoEditPlan, videoEditDigest, checkedEditId, type VideoEditPlan } from './media-edit-plan.js';
import { VIDEO_PROBE_VERSION, type VideoProbe } from './media-source-probe.js';
import { renderLocalVideo, LOCAL_RENDER_MAX_BYTES, LOCAL_RENDER_FFMPEG_VERSION,
  type LocalRenderOutput } from './media-local-render.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const SHA=/^[a-f0-9]{64}$/u;
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const requireMedia=(env:NodeJS.ProcessEnv,worker=false):void=>{
 if(env.CREATIVE_MEDIA!=='enabled'||env.RL72_MEDIA_LOCAL_RENDER_ENABLED!=='true'
    ||(worker&&env.RL72_MEDIA_WORKER_ENABLED!=='true'))
  throw new SeoBlogError(503,'Native local rendering disabled by operator');
};
export type LocalRenderJobState='queued'|'claimed'|'completed'|'failed';
export interface LocalRenderJobRow {
 readonly id:string;readonly projectId:string;readonly revision:number;
 readonly sourceId:string;readonly sourceSha256:string;readonly planSha256:string;
 readonly state:LocalRenderJobState;readonly outputId:string|null;
 readonly createdAt:string;readonly updatedAt:string;
}
export interface LocalRenderOutputRow {
 readonly id:string;readonly jobId:string;readonly sha256:string;
 readonly sourceSha256:string;readonly planSha256:string;
 readonly durationMs:number;readonly width:number;readonly height:number;
 readonly audioPresent:boolean;readonly byteLength:number;readonly createdAt:string;
}
export class PgLocalRenderOwner {
 private readonly sessionHash:Buffer|null;
 constructor(private readonly pool:Pick<Pool,'connect'>,
   private readonly principal:PgSeoBlogPrincipal,
   private readonly env:NodeJS.ProcessEnv=process.env){
  this.sessionHash=principal.kind==='user'
    ?createHash('sha256').update(principal.sessionToken).digest():null;
 }
 private async command<T>(workspaceId:string,action:'enqueue'|'list'|'outputs',body:object):Promise<T>{
  requireMedia(this.env);
  const p=this.principal;
  if(p.kind!=='user'||!this.sessionHash)
   throw new SeoBlogError(403,'Exact media owner session required');
  try{
   return await withTransaction(this.pool,{actorKind:'user',workspaceId,userId:p.userId,
     requestId:p.requestId,portalSessionTokenHash:this.sessionHash},async t=>
     (await t.query<{value:T}>('SELECT app_private.creative_media_local_render_owner($1,$2,$3,$4) AS value',
       [workspaceId,this.sessionHash,action,JSON.stringify(body)])).rows[0]!.value);
  }catch(e){
   const code=(e as {code?:string}).code;
   if(code==='54000')throw new SeoBlogError(429,'Media render queue or storage capacity reached');
   if(code==='42501')throw new SeoBlogError(403,'Owner workspace or source rights could not be confirmed');
   if(code==='40001'||code==='23505')throw new SeoBlogError(409,'Local render command or timeline changed');
   if(code==='55000')throw new SeoBlogError(409,'Exact latest timeline and independently measured source required');
   if(code==='22023'||code==='22P02'||code==='23514')
    throw new SeoBlogError(400,'Invalid source, rights or saved timeline revision');
   throw e;
  }
 }
 enqueue(input:{workspaceId:string;projectId:string;revision:number;
  sourceSha256:string;planSha256:string;commandId?:string;jobId?:string;
  rightsConfirmed:boolean}):Promise<{id:string;state:'queued'|LocalRenderJobState;replayed:boolean}> {
  const workspaceId=checkedEditId(input.workspaceId);
  const projectId=checkedEditId(input.projectId);
  const commandId=checkedEditId(input.commandId??randomUUID());
  const jobId=checkedEditId(input.jobId??randomUUID());
  if(!Number.isInteger(input.revision)||input.revision<1||input.revision>100
   ||!SHA.test(input.sourceSha256)||!SHA.test(input.planSha256)
   ||input.rightsConfirmed!==true)
   throw new SeoBlogError(400,'Owner must confirm exact source rights and saved timeline digests');
  return this.command(workspaceId,'enqueue',{
    jobId,commandId,projectId,revision:input.revision,
    sourceSha256:input.sourceSha256,planSha256:input.planSha256,rightsConfirmed:true,
  });
 }
 list(workspaceId:string):Promise<LocalRenderJobRow[]> {
  return this.command(checkedEditId(workspaceId),'list',{});
 }
 outputs(workspaceId:string):Promise<LocalRenderOutputRow[]> {
  return this.command(checkedEditId(workspaceId),'outputs',{});
 }
 async load(workspaceId:string,id:string):Promise<{
    mime:'video/mp4';bytes:Buffer;sha256:string
  }> {
  requireMedia(this.env);
  const p=this.principal;
  if(p.kind!=='user'||!this.sessionHash)throw new SeoBlogError(403,'Signed-in owner required');
  const ws=checkedEditId(workspaceId),output=checkedEditId(id);
  const value=await withTransaction(this.pool,{actorKind:'user',workspaceId:ws,
    userId:p.userId,requestId:p.requestId,portalSessionTokenHash:this.sessionHash},async t=>
    (await t.query<{mime:'video/mp4';raw_bytes:Buffer;sha256:string}>(
       'SELECT * FROM app_private.creative_media_local_render_bytes($1,$2,$3)',
       [ws,this.sessionHash,output])).rows[0]);
  if(!value||value.mime!=='video/mp4'||!Buffer.isBuffer(value.raw_bytes)
    ||value.raw_bytes.length>LOCAL_RENDER_MAX_BYTES
    ||sha(value.raw_bytes)!==value.sha256)
   throw new SeoBlogError(404,'Private rendered output is unavailable');
  return {mime:'video/mp4',bytes:Buffer.from(value.raw_bytes),sha256:value.sha256};
 }
}
export interface LocalRenderClaim {
 readonly claimToken:string;
 readonly plan:VideoEditPlan;readonly planSha256:string;
 readonly sourceSha256:string;readonly bytes:Buffer|null;readonly object?:PrivateMediaObject;readonly probe:VideoProbe;
}
interface PgLocalClaim {
 readonly claim_token:string;readonly plan:VideoEditPlan;readonly plan_sha256:string;
 readonly source_sha256:string;readonly raw_bytes:Buffer|null;
 readonly storage_kind:'pg_blob'|'private_object';readonly object_key:string|null;readonly source_id:string;readonly source_byte_length:number|string;readonly source_mime:'video/mp4'|'video/webm';
 readonly duration_ms:string|number;readonly width:number;readonly height:number;
 readonly frame_rate:string|number;readonly video_codec:string;
 readonly audio_present:boolean;readonly checker_version:string;
}
export class PgLocalRenderWorker {
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly requestId:string,
   private readonly env:NodeJS.ProcessEnv=process.env){}
 private async tx<T>(workspaceId:string,run:(t:import('../db/transaction.js').DbTransaction)=>Promise<T>):Promise<T>{
  requireMedia(this.env,true);
  if(!UUID.test(workspaceId))throw new SeoBlogError(400,'Invalid local render workspace');
  return withTransaction(this.pool,{actorKind:'worker',workspaceId,requestId:this.requestId},run);
 }
 async claim(workspaceId:string,jobId:string):Promise<LocalRenderClaim>{
  if(!UUID.test(jobId))throw new SeoBlogError(400,'Invalid local render request');
  const row=await this.tx(workspaceId,async t=>
    (await t.query<PgLocalClaim>(
      'SELECT * FROM app_private.creative_media_local_render_claim($1,$2)',
      [workspaceId,jobId])).rows[0]);
  if(!row||!UUID.test(row.claim_token)||!SHA.test(row.source_sha256)
    ||!SHA.test(row.plan_sha256)||(row.storage_kind!=='private_object'&&!Buffer.isBuffer(row.raw_bytes)))
   throw new SeoBlogError(409,'Local render job claim is unavailable');
  const plan=checkVideoEditPlan(row.plan);
  if(videoEditDigest(plan)!==row.plan_sha256
    ||(row.storage_kind!=='private_object'&&(!row.raw_bytes||sha(row.raw_bytes)!==row.source_sha256||row.raw_bytes.length>LOCAL_RENDER_MAX_BYTES)))
   throw new SeoBlogError(409,'Leased timeline or source SHA no longer matches');
  const probe:VideoProbe={status:'verified_technical',checkerVersion:row.checker_version,
    durationMs:Number(row.duration_ms),width:Number(row.width),height:Number(row.height),
    frameRate:Number(row.frame_rate),videoCodec:row.video_codec,
    audioPresent:row.audio_present};
  if(probe.checkerVersion!==VIDEO_PROBE_VERSION
    ||!Number.isSafeInteger(probe.durationMs)||!Number.isFinite(probe.frameRate))
   throw new SeoBlogError(409,'Trusted technical probe is incomplete');
  return {claimToken:row.claim_token,plan,planSha256:row.plan_sha256,
    sourceSha256:row.source_sha256,bytes:row.raw_bytes?Buffer.from(row.raw_bytes):null,probe,
    ...(row.storage_kind==='private_object'?{object:{workspaceId,sourceId:row.source_id,sha256:row.source_sha256,byteLength:Number(row.source_byte_length),mime:row.source_mime,objectKey:row.object_key!}}:{})};
 }
 async heartbeat(workspaceId:string,jobId:string,claimToken:string):Promise<boolean>{
  checkedEditId(jobId);checkedEditId(claimToken);
  return this.tx(workspaceId,async t=>(await t.query<{v:boolean}>('SELECT app_private.creative_media_render_heartbeat($1,$2,$3) AS v',[workspaceId,jobId,claimToken])).rows[0]!.v);
 }
 async complete(workspaceId:string,jobId:string,claimToken:string,
   output:LocalRenderOutput):Promise<{id:string;sha256:string;state:'completed';replayed:boolean}>{
  if(!UUID.test(jobId)||!UUID.test(claimToken)
    ||output.renderVersion!==LOCAL_RENDER_FFMPEG_VERSION
    ||output.mime!=='video/mp4'||!SHA.test(output.sha256)
    ||!SHA.test(output.planSha256)||!SHA.test(output.sourceSha256)
    ||!Buffer.isBuffer(output.bytes)||sha(output.bytes)!==output.sha256)
   throw new SeoBlogError(400,'Validated native output required');
  return this.tx(workspaceId,async t=>(await t.query<{value:{
    id:string;sha256:string;state:'completed';replayed:boolean
   }}>('SELECT app_private.creative_media_local_render_settle($1,$2,$3,$4,$5,$6) AS value',
    [workspaceId,jobId,claimToken,'complete',JSON.stringify({
      sha256:output.sha256,mime:output.mime,sourceSha256:output.sourceSha256,
      planSha256:output.planSha256,renderVersion:output.renderVersion,
      durationMs:output.durationMs,width:output.width,height:output.height,
      audioPresent:output.audioPresent,
    }),output.bytes])).rows[0]!.value);
 }
 fail(workspaceId:string,jobId:string,claimToken:string,
   reason:'render_failed'|'renderer_unavailable'|'source_changed'|'output_invalid'|'tool_limit')
   :Promise<{id:string;state:'failed'}>{
  if(!UUID.test(jobId)||!UUID.test(claimToken))
   throw new SeoBlogError(400,'Exact scoped claim required');
  return this.tx(workspaceId,async t=>(await t.query<{value:{id:string;state:'failed'}}> (
    'SELECT app_private.creative_media_local_render_settle($1,$2,$3,$4,$5,$6) AS value',
    [workspaceId,jobId,claimToken,'fail',JSON.stringify({reason}),null])).rows[0]!.value);
 }
}
/**
 * One fenced attempt used by diagnostic CLI or the supervised offline loop.
 * Loss of the output settlement acknowledgement leaves the claim on hold;
 * a later expired-lease retry is bounded and fenced; no paid call is started.
 */
export async function runQueuedLocalRender(
 workspaceId:string,jobId:string,
 ports:{
   readonly ledger:Pick<PgLocalRenderWorker,'claim'|'complete'|'fail'> & Partial<Pick<PgLocalRenderWorker,'heartbeat'>>;
   readonly objectRenderer?:(object:PrivateMediaObject,probe:VideoProbe,plan:VideoEditPlan)=>Promise<LocalRenderOutput>;
   readonly renderer:(source:{bytes:Buffer;sha256:string;probe:VideoProbe},
       plan:VideoEditPlan)=>Promise<LocalRenderOutput>;
 },
):Promise<{state:'completed'|'failed'|'reconciliation_required';jobId:string;outputId?:string}> {
 const claim=await ports.ledger.claim(workspaceId,jobId);
 let output:LocalRenderOutput;
 let alive=true,busy=false;
 const heartbeat=ports.ledger.heartbeat?setInterval(()=>{if(busy)return;busy=true;ports.ledger.heartbeat!(workspaceId,jobId,claim.claimToken).then(ok=>{if(!ok)alive=false;}).catch(()=>{alive=false;}).finally(()=>{busy=false;});},15000):null;
 try{
  if(claim.object){
   if(!ports.objectRenderer)throw new SeoBlogError(503,'Private object renderer unavailable');
   output=await ports.objectRenderer(claim.object,claim.probe,claim.plan);
  }else{
  if(!claim.bytes)throw new SeoBlogError(409,'Exact leased bytes unavailable');
  output=await ports.renderer({
   bytes:claim.bytes,sha256:claim.sourceSha256,probe:claim.probe,
  },claim.plan);
  }
  if(!alive)throw new SeoBlogError(409,'Render lease heartbeat lost');
  if(output.sourceSha256!==claim.sourceSha256||output.planSha256!==claim.planSha256)
   throw new SeoBlogError(422,'Native output is not tied to exact claimed timeline');
 }catch(error){
  if(heartbeat)clearInterval(heartbeat);
  const code=error instanceof SeoBlogError && error.status===413?'tool_limit':
   error instanceof SeoBlogError && error.status===409?'source_changed':
   error instanceof SeoBlogError && error.status===503?'renderer_unavailable':'render_failed';
  await ports.ledger.fail(workspaceId,jobId,claim.claimToken,code);
  return {state:'failed',jobId};
 }
 if(heartbeat)clearInterval(heartbeat);
 try{
  const saved=await ports.ledger.complete(workspaceId,jobId,claim.claimToken,output);
  return {state:'completed',jobId,outputId:saved.id};
 }catch(error){
  if((error as {code?:string}).code==='54000'){await ports.ledger.fail(workspaceId,jobId,claim.claimToken,'tool_limit');return {state:'failed',jobId};}
  // Cannot tell whether transaction committed. Never retry automatically.
  return {state:'reconciliation_required',jobId};
 }
}
export { renderLocalVideo };
