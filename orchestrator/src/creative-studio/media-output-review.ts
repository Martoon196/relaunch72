/**
 * The next PRIVATE step after provider output capture:
 *   captured_unverified -> measured technical probe -> exact owner review.
 *
 * "reviewed_private" confirms an owner's explicit attestations, NOT verified
 * copyright ownership, Amazon compliance, delivery or permission to publish.
 * There is deliberately no social-calendar or provider adapter in this file.
 */
import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {withTransaction} from '../db/transaction.js';
import {SeoBlogError} from '../seo-blog/types.js';
import type {PgSeoBlogPrincipal} from '../seo-blog/pg-store.js';
import {decodeFfprobe,ffprobeFromBytes,VIDEO_PROBE_VERSION,type VideoProbe} from './media-source-probe.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const SHA=/^[a-f0-9]{64}$/u;
export type PrivateReviewDecision='reviewed_private'|'rejected_private'|'withdrawn_private';
export interface PrivateOutputReview {
 readonly outputId:string;readonly revision:number;readonly sha256:string;
 readonly decision:PrivateReviewDecision;readonly reviewedBy:string;
 readonly technicalStatus:'verified_technical'|'rejected'|'awaiting_probe';
 readonly createdAt:string;
}
export interface PrivateReviewInput {
 readonly workspaceId:string;readonly outputId:string;readonly outputSha256:string;
 readonly commandId?:string;readonly expectedRevision:number;
 readonly decision:PrivateReviewDecision;
 /** These are new, specific statements about the exact reviewed output. */
 readonly rightsConfirmed:boolean;readonly claimsConfirmed:boolean;
 readonly disclosureConfirmed:boolean;
}
export function checkedPrivateReview(input:PrivateReviewInput):Readonly<PrivateReviewInput & {commandId:string}> {
 const commandId=input.commandId??randomUUID();
 if(!UUID.test(input.workspaceId)||!UUID.test(input.outputId)||!UUID.test(commandId)
   ||!SHA.test(input.outputSha256)||!Number.isInteger(input.expectedRevision)
   ||input.expectedRevision<0||input.expectedRevision>=100
   ||!['reviewed_private','rejected_private','withdrawn_private'].includes(input.decision)
   ||typeof input.rightsConfirmed!=='boolean'||typeof input.claimsConfirmed!=='boolean'
   ||typeof input.disclosureConfirmed!=='boolean')
   throw new SeoBlogError(400,'Exact video, revision, decision and owner attestations required');
 if(input.decision==='reviewed_private'&&
    !(input.rightsConfirmed&&input.claimsConfirmed&&input.disclosureConfirmed))
   throw new SeoBlogError(409,'Review requires rights, truthful claims and disclosure confirmations');
 return Object.freeze({...input,commandId});
}
export class PgMediaOutputReviewOwner {
 private readonly sessionHash:Buffer|null;
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly principal:PgSeoBlogPrincipal,
   private readonly env:NodeJS.ProcessEnv=process.env){
  this.sessionHash=principal.kind==='user'
   ?createHash('sha256').update(principal.sessionToken).digest():null;
 }
 private async command<T>(workspaceId:string,action:'list'|'review',payload:object):Promise<T> {
  const p=this.principal;
  if(this.env.CREATIVE_MEDIA!=='enabled')
   throw new SeoBlogError(503,'Private media review is disabled');
  if(p.kind!=='user'||!this.sessionHash)
   throw new SeoBlogError(403,'A signed-in workspace owner is required');
  try{
   return await withTransaction(this.pool,{actorKind:'user',workspaceId,userId:p.userId,
    requestId:p.requestId,portalSessionTokenHash:this.sessionHash},async t=>
    (await t.query<{value:T}>('SELECT app_private.creative_media_output_review($1,$2,$3,$4) AS value',
      [workspaceId,this.sessionHash,action,JSON.stringify(payload)])).rows[0]!.value);
  }catch(e){
   const code=(e as {code?:string}).code;
   if(code==='42501')throw new SeoBlogError(403,'Private output or owner session not authorised');
   if(code==='40001'||code==='23505')throw new SeoBlogError(409,'Private output review changed; reload the latest version');
   if(code==='55000')throw new SeoBlogError(409,'The video is not technically verified or the requested review transition is invalid');
   if(code==='22023'||code==='23514'||code==='22P02')
    throw new SeoBlogError(400,'Private output review failed validation');
   throw e;
  }
 }
 list(workspaceId:string):Promise<PrivateOutputReview[]> {
  if(!UUID.test(workspaceId))throw new SeoBlogError(400,'Invalid video workspace');
  return this.command(workspaceId,'list',{});
 }
 review(input:PrivateReviewInput):Promise<{outputId:string;revision:number;
   replayed:boolean;decision:PrivateReviewDecision}> {
  const clean=checkedPrivateReview(input);
  return this.command(clean.workspaceId,'review',{
   outputId:clean.outputId,outputSha256:clean.outputSha256,
   commandId:clean.commandId,expectedRevision:clean.expectedRevision,
   decision:clean.decision,rightsConfirmed:clean.rightsConfirmed,
   claimsConfirmed:clean.claimsConfirmed,disclosureConfirmed:clean.disclosureConfirmed,
  });
 }
}
export interface OutputProbeReceipt {
 readonly status:'verified_technical'|'rejected';readonly replayed:boolean;
}
export class PgMediaOutputProbeWorker {
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly requestId:string,
   private readonly env:NodeJS.ProcessEnv=process.env){}
 private tx<T>(workspaceId:string,run:(t:import('../db/transaction.js').DbTransaction)=>Promise<T>):Promise<T>{
  return withTransaction(this.pool,{actorKind:'worker',workspaceId,requestId:this.requestId},run);
 }
 async probe(workspaceId:string,outputId:string,measure:(bytes:Buffer)=>Promise<VideoProbe>=ffprobeFromBytes)
   :Promise<OutputProbeReceipt> {
  if(this.env.CREATIVE_MEDIA!=='enabled'||this.env.RL72_MEDIA_WORKER_ENABLED!=='true')
   throw new SeoBlogError(503,'Technical media probing is disabled');
  if(!UUID.test(workspaceId)||!UUID.test(outputId))
   throw new SeoBlogError(400,'Invalid private output identity');
  const record=await this.tx(workspaceId,async t=>
    (await t.query<{output_sha256:string;raw_bytes:Buffer}>(
      'SELECT * FROM app_private.creative_media_output_probe_bytes($1,$2)',
      [workspaceId,outputId])).rows[0]);
  if(!record)throw new SeoBlogError(409,'Output not found or already measured; no implicit repeat');
  const bytes=Buffer.from(record.raw_bytes);
  const sha=createHash('sha256').update(bytes).digest('hex');
  if(!SHA.test(record.output_sha256)||sha!==record.output_sha256)
   throw new SeoBlogError(409,'Original provider output bytes changed');
  let measured:VideoProbe;
  try{measured=await measure(bytes);}
  catch{measured={status:'rejected',checkerVersion:VIDEO_PROBE_VERSION,rejectionCode:'probe_failed'};}
  if(measured.status==='verified_technical'){
   const checked=decodeFfprobe({format:{duration:String(Number(measured.durationMs)/1000)},
    streams:[{codec_type:'video',codec_name:measured.videoCodec,width:measured.width,
      height:measured.height,avg_frame_rate:String(measured.frameRate)},
      ...(measured.audioPresent?[{codec_type:'audio'}]:[])]});
   if(checked.status!=='verified_technical'||typeof measured.audioPresent!=='boolean'
     ||measured.checkerVersion!==VIDEO_PROBE_VERSION
     ||checked.durationMs!==measured.durationMs
     ||checked.width!==measured.width||checked.height!==measured.height
     ||checked.frameRate!==measured.frameRate||checked.videoCodec!==measured.videoCodec)
    throw new SeoBlogError(422,'Untrusted or inconsistent technical metadata');
  }else if(measured.status!=='rejected'||measured.checkerVersion!==VIDEO_PROBE_VERSION
    ||!['unsupported','malformed','tool_unavailable','probe_failed'].includes(measured.rejectionCode??''))
    throw new SeoBlogError(422,'Unrecognised technical rejection');
  return this.tx(workspaceId,async t=>(await t.query<{value:OutputProbeReceipt}>(
    'SELECT app_private.creative_media_output_probe_save($1,$2,$3,$4) AS value',
    [workspaceId,outputId,sha,JSON.stringify(measured)])).rows[0]!.value);
 }
}
