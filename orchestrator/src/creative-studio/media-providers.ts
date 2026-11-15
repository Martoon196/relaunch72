/**
 * Production-facing provider ports for RL72's canonical Creative Studio.
 *
 * This module deliberately does NOT enqueue, schedule or charge anything.
 * Callers MUST first obtain and persist a verified, same-workspace paid-media
 * reservation under the existing PostgreSQL worker/owner-session boundary.
 * The feature is disabled by default and no video provider is called by HTTP.
 *
 * API references (verified 2026-11-15):
 * https://docs.vizard.ai/docs/quickstart
 * https://docs.vizard.ai/docs/retrieve-video-clips
 * https://shotstack.io/docs/api/
 */
import { createHash } from 'node:crypto';

export type MediaWorkKind = 'vizard_clip' | 'shotstack_render';
export interface VerifiedMediaAdmission {
  /** Database-generated unique receipt, never supplied by browser. */
  readonly receiptId: string;
  readonly workspaceId: string;
  readonly commandId: string;
  readonly kind: MediaWorkKind;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly reservedCostMicrousd: number;
  readonly validUntil: string;
  readonly state: 'reserved';
  /** Immutable database-approved exact request and source-rights digests. */
  readonly payloadSha256: string;
  readonly rightsSha256: string;
}
export interface SourceRight {
  /** Signed-in owner has supplied evidence, or an owned private upload was verified. */
  readonly rights: 'owned' | 'licensed';
  readonly evidenceRef: string;
}
export interface ClipJobRequest {
  readonly workspaceId: string;
  readonly commandId: string;
  readonly rights: SourceRight;
  readonly sourceUrl: string;
  readonly projectName: string;
  /** Actual input duration from verified source metadata, not user typing. */
  readonly durationSeconds: number;
  /** Host of RL72's private object-storage proxy, when not YouTube. */
  readonly trustedAssetHostname?: string;
}
export interface RenderJobRequest {
  readonly workspaceId: string;
  readonly commandId: string;
  readonly edit: Readonly<Record<string, unknown>>;
  /** Rights for every supplied edit asset; bound to the immutable owner approval. */
  readonly rights: SourceRight;
  /** SHA256 of the exact approved edit payload, checked against the latest saved version. */
  readonly reviewedEditSha256: string;
}
export interface VideoClip {
  readonly providerClipId: string;
  readonly title: string;
  readonly transcript: string;
  readonly durationMs: number;
  readonly temporaryDownloadUrl: string;
  readonly expiresWithinDays: 7;
}
export interface ClipResult {
  readonly status: 'processing' | 'complete';
  readonly clips: readonly VideoClip[];
}
export interface RenderResult {
  readonly status: 'queued' | 'processing' | 'complete' | 'failed';
  readonly temporaryDownloadUrl: string | null;
  readonly billedCredits: number | null;
}

export class MediaProviderError extends Error {
  constructor(readonly code: 'disabled'|'admission'|'source'|'request'|'provider'|'timeout', message: string) {
    super(message);
    this.name = 'MediaProviderError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha = (input: string): string => createHash('sha256').update(input).digest('hex');
const strictUrl = (v:string): URL => {
  let url: URL;
  try { url=new URL(v); } catch { throw new MediaProviderError('source','Invalid media URL'); }
  if (url.protocol!=='https:'||url.username||url.password||!url.hostname||url.port||v.length>3000)
    throw new MediaProviderError('source','Media URL must be secure HTTPS without credentials');
  return url;
};
const json = async (response:Response):Promise<Record<string,unknown>>=>{
  if (!response.ok) throw new MediaProviderError('provider', 'Video service responded with HTTP '+response.status);
  const output:unknown=await response.json().catch(()=>null);
  if(!output||typeof output!=='object'||Array.isArray(output))
    throw new MediaProviderError('provider','Video service returned an invalid response');
  return output as Record<string,unknown>;
};
const str=(v:unknown):string=>typeof v==='string'?v:'';
const numeric=(v:unknown):number|null=>typeof v==='number'&&Number.isFinite(v)?v:null;

export function mediaRequestDigests(request: ClipJobRequest | RenderJobRequest): {payloadSha256:string;rightsSha256:string} {
  if (!request.rights || !['owned','licensed'].includes(request.rights.rights)
    || typeof request.rights.evidenceRef !== 'string' || !request.rights.evidenceRef.trim())
    throw new MediaProviderError('source','Verified media source rights are required');
  return {payloadSha256:sha(JSON.stringify(request)), rightsSha256:sha(JSON.stringify(request.rights))};
}

export function assertExactMediaJob(request:ClipJobRequest|RenderJobRequest, admission:VerifiedMediaAdmission):void {
  const actual=mediaRequestDigests(request);
  if(actual.payloadSha256!==admission.payloadSha256 || actual.rightsSha256!==admission.rightsSha256)
    throw new MediaProviderError('admission','Media payload or source-rights evidence changed since owner approval');
}

export function validateMediaAdmission(
  record: VerifiedMediaAdmission,
  workspaceId: string,
  commandId: string,
  kind: MediaWorkKind,
  now = new Date(),
): void {
  if (record.state!=='reserved' || record.kind!==kind ||
    record.workspaceId!==workspaceId || record.commandId!==commandId ||
    !UUID.test(record.receiptId) || !UUID.test(record.approvedBy) ||
    !Number.isSafeInteger(record.reservedCostMicrousd)||record.reservedCostMicrousd<=0 ||
    !/^[a-f0-9]{64}$/u.test(record.payloadSha256) ||
    !/^[a-f0-9]{64}$/u.test(record.rightsSha256) ||
    !Number.isFinite(Date.parse(record.approvedAt)) ||
    !(Date.parse(record.approvedAt)<=now.getTime()) ||
    !(Date.parse(record.validUntil)>now.getTime())) {
    throw new MediaProviderError('admission', 'A current, same-workspace reviewed paid-media reservation is required');
  }
}
export function assertClipSource(req:ClipJobRequest):void { clipSource(req); }
function clipSource(req:ClipJobRequest):{videoType:1|2;ext?:string} {
  if(!['owned','licensed'].includes(req.rights.rights) ||
    !req.rights.evidenceRef.trim() || req.rights.evidenceRef.length>1000)
    throw new MediaProviderError('source','Owned or licensed source evidence is required');
  if(!Number.isFinite(req.durationSeconds)||req.durationSeconds<60||req.durationSeconds>36000)
    throw new MediaProviderError('source','A verified source duration of 1–600 minutes is required');
  const url=strictUrl(req.sourceUrl);
  const host=url.hostname.toLowerCase();
  if(['youtube.com','www.youtube.com','m.youtube.com','youtu.be'].includes(host)){
    if(host==='youtu.be' && !url.pathname.slice(1))throw new MediaProviderError('source','Invalid YouTube URL');
    if(host!=='youtu.be' && !(url.pathname==='/watch'&&url.searchParams.has('v')) && !url.pathname.startsWith('/shorts/') && !url.pathname.startsWith('/live/'))
      throw new MediaProviderError('source','A recognisable YouTube video URL is required');
    return {videoType:2};
  }
  const trusted=req.trustedAssetHostname?.trim().toLowerCase()??'';
  if(!trusted || host!==trusted)throw new MediaProviderError('source','Direct video must be an approved RL72 storage URL');
  const extension=url.pathname.match(/\.(mp4|mov|m4v|webm)$/iu)?.[1]?.toLowerCase();
  if(!extension)throw new MediaProviderError('source','Unsupported source file extension');
  return {videoType:1,ext:extension};
}
export function assertShotstackEdit(req:RenderJobRequest):void {
  if(!req.edit ||typeof req.edit!=='object'||Array.isArray(req.edit)||
     !('timeline' in req.edit)||!('output' in req.edit))
    throw new MediaProviderError('request','Shotstack Edit JSON requires timeline and output');
  const serialised=JSON.stringify(req.edit);
  if(serialised.length>200000)throw new MediaProviderError('request','Edit payload exceeds safe limit');
  if (!/^[a-f0-9]{64}$/iu.test(req.reviewedEditSha256) || sha(serialised)!==req.reviewedEditSha256)
    throw new MediaProviderError('request','Edited timeline differs from the reviewed version');
}
export class VizardVideoProvider {
  readonly configured: boolean;
  private readonly api='https://elb-api.vizard.ai/hvizard-server-front/open-api/v1/project';
  constructor(
    private readonly key:string,
    private readonly allowed:boolean,
    private readonly http:typeof fetch=fetch,
  ) {this.configured=allowed&&Boolean(key);}
  async submit(req:ClipJobRequest,reservation:VerifiedMediaAdmission):Promise<string>{
    if(!this.configured)throw new MediaProviderError('disabled','Vizard video processing is disabled');
    validateMediaAdmission(reservation,req.workspaceId,req.commandId,'vizard_clip');
    assertExactMediaJob(req,reservation);
    const source=clipSource(req);
    if(!req.projectName.trim()||req.projectName.length>120)throw new MediaProviderError('request','Project name required');
    const payload={lang:'en',preferLength:[0],videoUrl:req.sourceUrl,videoType:source.videoType,
      ...(source.ext?{ext:source.ext}:{}),projectName:req.projectName.trim()};
    let response:Response;
    try{response=await this.http(this.api+'/create',{
      method:'POST',headers:{'Content-Type':'application/json',VIZARDAI_API_KEY:this.key},
      body:JSON.stringify(payload),signal:AbortSignal.timeout(20000),
    });}catch{throw new MediaProviderError('timeout','Video clipping request timed out; reconcile job status before retrying');}
    const data=await json(response);
    const projectId=data.projectId;
    if(data.code!==2000 || !(typeof projectId==='number'||typeof projectId==='string') || !/^\d{1,20}$/.test(String(projectId)))
      throw new MediaProviderError('provider','Video clipping job not accepted (code '+String(data.code??'unknown')+')');
    return String(projectId);
  }
  async inspect(providerId:string):Promise<ClipResult>{
    if(!this.configured)throw new MediaProviderError('disabled','Vizard video processing is disabled');
    if(!/^\d{1,20}$/.test(providerId))throw new MediaProviderError('request','Invalid Vizard project id');
    let response:Response;
    try{response=await this.http(this.api+'/query/'+providerId,{
      headers:{VIZARDAI_API_KEY:this.key},signal:AbortSignal.timeout(20000),
    });}catch{throw new MediaProviderError('timeout','Unable to retrieve clip job; try status later');}
    const data=await json(response);
    if(data.code===1000)return{status:'processing',clips:[]};
    if(data.code!==2000)throw new MediaProviderError('provider','Vizard job failed (code '+String(data.code??'unknown')+')');
    const raw=Array.isArray(data.videos)?data.videos:[];
    const clips=raw.filter((x):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x))
      .filter(x=>Boolean(str(x.videoUrl)))
      .map((x):VideoClip=>({
        providerClipId:String(x.videoId??''),title:str(x.title)||'Video clip',
        transcript:str(x.transcript),durationMs:numeric(x.videoMsDuration)??0,
        temporaryDownloadUrl:strictUrl(str(x.videoUrl)).href,expiresWithinDays:7,
      }));
    return{status:'complete',clips};
  }
}
export class ShotstackVideoProvider {
  readonly configured:boolean;
  private readonly api:string;
  constructor(
    private readonly key:string,
    private readonly allowed:boolean,
    environment:'stage'|'v1'='stage',
    private readonly http:typeof fetch=fetch,
  ){
    this.api='https://api.shotstack.io/edit/'+environment+'/render';
    this.configured=allowed&&Boolean(key);
  }
  async submit(req:RenderJobRequest,reservation:VerifiedMediaAdmission):Promise<string>{
    if(!this.configured)throw new MediaProviderError('disabled','Shotstack video rendering is disabled');
    validateMediaAdmission(reservation,req.workspaceId,req.commandId,'shotstack_render');
    assertExactMediaJob(req,reservation);
    assertShotstackEdit(req);
    let response:Response;
    try{response=await this.http(this.api,{
      method:'POST',headers:{'Content-Type':'application/json','x-api-key':this.key},
      body:JSON.stringify(req.edit),signal:AbortSignal.timeout(20000),
    });}catch{throw new MediaProviderError('timeout','Render request outcome unknown; reconcile before retrying');}
    const data=await json(response),result=data.response as Record<string,unknown>|undefined;
    if(data.success!==true||!result||typeof result.id!=='string'||!UUID.test(result.id))
      throw new MediaProviderError('provider','Shotstack did not return a render id');
    return result.id;
  }
  async inspect(renderId:string):Promise<RenderResult>{
    if(!this.configured)throw new MediaProviderError('disabled','Shotstack video rendering is disabled');
    if(!UUID.test(renderId))throw new MediaProviderError('request','Invalid render id');
    let response:Response;
    try{response=await this.http(this.api+'/'+renderId+'?data=false',{
      headers:{'x-api-key':this.key},signal:AbortSignal.timeout(20000),
    });}catch{throw new MediaProviderError('timeout','Unable to check render; try status later');}
    const data=await json(response),result=data.response as Record<string,unknown>|undefined;
    if(data.success!==true||!result)throw new MediaProviderError('provider','Shotstack status unavailable');
    const status=str(result.status);
    if(status==='failed')return{status:'failed',temporaryDownloadUrl:null,billedCredits:numeric(result.credits)};
    if(status==='done')return{status:'complete',
      temporaryDownloadUrl:result.url?strictUrl(str(result.url)).href:null,
      billedCredits:numeric(result.credits)};
    return{status:status==='queued'?'queued':'processing',temporaryDownloadUrl:null,billedCredits:null};
  }
}
