/**
 * Trusted worker video probe using ffprobe stdin only. No paths, remote URLs,
 * provider secrets or shell interpolation. A successful probe confirms the
 * technical file, NOT rights, accuracy of product claims or social eligibility.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction.js';
import { SeoBlogError } from '../seo-blog/types.js';

export const VIDEO_PROBE_VERSION='rl72-ffprobe-v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const SHA=/^[a-f0-9]{64}$/u;
export interface VideoProbe {
  readonly status:'verified_technical'|'rejected'; readonly checkerVersion:string;
  readonly durationMs?:number;readonly width?:number;readonly height?:number;
  readonly frameRate?:number; readonly videoCodec?:string;readonly audioPresent?:boolean;
  readonly rejectionCode?:'unsupported'|'malformed'|'tool_unavailable'|'probe_failed';
}
export function decodeFfprobe(input:unknown):VideoProbe {
  const fail=(rejectionCode:NonNullable<VideoProbe['rejectionCode']>):VideoProbe=>
    ({status:'rejected',checkerVersion:VIDEO_PROBE_VERSION,rejectionCode});
  if(!input ||typeof input!=='object'||Array.isArray(input))return fail('malformed');
  const o=input as {format?:{duration?:string|number};streams?:unknown[]};
  if(!Array.isArray(o.streams)||o.streams.length>16)return fail('malformed');
  const videos=o.streams.filter(s=>s&&typeof s==='object'&&(s as {codec_type?:string}).codec_type==='video');
  if(videos.length!==1)return fail('unsupported');
  const v=videos[0] as Record<string,unknown>;
  const d=Number(o.format?.duration);
  const width=Number(v.width),height=Number(v.height),codec=String(v.codec_name??'');
  const rate=String(v.avg_frame_rate??'').split('/');
  const fps=rate.length===2?Number(rate[0])/Number(rate[1]):Number(rate[0]);
  if(!Number.isFinite(d)||d<1||d>36000||
    !Number.isInteger(width)||width<16||width>7680||
    !Number.isInteger(height)||height<16||height>4320||
    !Number.isFinite(fps)||fps<1||fps>240||
    !['h264','hevc','vp8','vp9','av1'].includes(codec))return fail('unsupported');
  const ms=Math.round(d*1000);
  return {status:'verified_technical',checkerVersion:VIDEO_PROBE_VERSION,durationMs:ms,
    width,height,frameRate:Math.round(fps*1000)/1000,videoCodec:codec,
    audioPresent:o.streams.some(s=>s&&typeof s==='object'&&(s as {codec_type?:string}).codec_type==='audio')};
}
export async function ffprobeFromBytes(bytes:Buffer,executable='ffprobe'):Promise<VideoProbe> {
  if(bytes.length<1024||bytes.length>20_000_000)throw new SeoBlogError(400,'Source size exceeds private blob limit');
  return new Promise(resolve=>{
    const args=['-v','error','-protocol_whitelist','pipe','-format_whitelist','mov,matroska,webm','-show_entries',
      'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate','-of','json','-i','pipe:0'];
    let out='',err='',done=false;
    const child=spawn(executable,args,{shell:false,stdio:['pipe','pipe','pipe'],timeout:15_000});
    const finish=(probe:VideoProbe)=>{
      if(done)return;done=true;resolve(probe);
    };
    child.stdout.on('data',(part:Buffer)=>{out+=part.toString('utf8');if(out.length>100_000)child.kill('SIGKILL');});
    child.stderr.on('data',(part:Buffer)=>{err+=part.toString('utf8');if(err.length>10_000)child.kill('SIGKILL');});
    child.on('error',()=>finish({status:'rejected',checkerVersion:VIDEO_PROBE_VERSION,rejectionCode:'tool_unavailable'}));
    child.on('close',code=>{
      if(code!==0||out.length>100_000)return finish({status:'rejected',checkerVersion:VIDEO_PROBE_VERSION,rejectionCode:'probe_failed'});
      try{finish(decodeFfprobe(JSON.parse(out)));}catch{finish({status:'rejected',checkerVersion:VIDEO_PROBE_VERSION,rejectionCode:'malformed'});}
    });
    child.stdin.on('error',()=>{});
    child.stdin.end(bytes);
  });
}
export class PgVideoSourceProbeWorker {
  constructor(private readonly pool:Pick<Pool,'connect'>,private readonly requestId:string){}
  private tx<T>(workspaceId:string,callback:(db:import('../db/transaction.js').DbTransaction)=>Promise<T>){
    return withTransaction(this.pool,{actorKind:'worker',workspaceId,requestId:this.requestId},callback);
  }
  async run(workspaceId:string,sourceId:string,probe:(bytes:Buffer)=>Promise<VideoProbe>=ffprobeFromBytes):
    Promise<{status:VideoProbe['status'];replayed:boolean}> {
    if(!UUID.test(workspaceId)||!UUID.test(sourceId))throw new SeoBlogError(400,'Invalid source identity');
    const row=await this.tx(workspaceId,async db=>(await db.query<{
      mime:string;source_sha256:string;raw_bytes:Buffer
    }>('SELECT * FROM app_private.creative_media_video_probe_source($1,$2)',[workspaceId,sourceId])).rows[0]);
    if(!row)throw new SeoBlogError(409,'Source unavailable or already probed; never auto-repeat');
    const bytes=Buffer.from(row.raw_bytes);
    const actual=createHash('sha256').update(bytes).digest('hex');
    if(actual!==row.source_sha256||!SHA.test(actual))throw new SeoBlogError(409,'Source has changed since upload');
    let check:VideoProbe;
    try{check=await probe(bytes);}
    catch{check={status:'rejected',checkerVersion:VIDEO_PROBE_VERSION,rejectionCode:'probe_failed'};}
    if(check.status==='verified_technical') {
      const clean=decodeFfprobe({format:{duration:String((check.durationMs??0)/1000)},
        streams:[{codec_type:'video',codec_name:check.videoCodec,width:check.width,height:check.height,avg_frame_rate:String(check.frameRate)},
          ...(check.audioPresent?[{codec_type:'audio'}]:[])]});
      if(clean.status!=='verified_technical')throw new SeoBlogError(422,'Probe returned invalid technical metadata');
    }
    const result=await this.tx(workspaceId,async db=>(await db.query<{v:{status:VideoProbe['status'];replayed:boolean}}>(
      'SELECT app_private.creative_media_video_probe_record($1,$2,$3,$4) AS v',
      [workspaceId,sourceId,actual,JSON.stringify(check)])).rows[0]!.v);
    return result;
  }
}
