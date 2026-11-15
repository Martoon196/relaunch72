/**
 * Safe provider output capture. This is not a publishing or cost-settlement path.
 * Only the exact provider job retained by the trusted PG worker may write bytes.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction.js';
import { SeoBlogError } from '../seo-blog/types.js';
import type { MediaWorkKind } from './media-providers.js';

export const DEFAULT_MEDIA_DOWNLOAD_HOSTS=['cdn.shotstack.io','cdn-video.vizard.ai'] as const;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const MAX_BYTES=20_000_000;
export type CapturedMedia=Readonly<{mime:'video/mp4'|'video/webm';bytes:Buffer;sha256:string}>;
export async function downloadProviderVideo(urlText:string,allowedHosts:readonly string[]=DEFAULT_MEDIA_DOWNLOAD_HOSTS,
  http:typeof fetch=fetch):Promise<CapturedMedia>{
  let url:URL;
  try{url=new URL(urlText);}catch{throw new SeoBlogError(400,'Invalid external video URL');}
  if(url.protocol!=='https:'||url.port||url.username||url.password
    ||urlText.length>3000||!allowedHosts.includes(url.hostname.toLowerCase()))
    throw new SeoBlogError(403,'External output host was not on the reviewed provider allowlist');
  const response=await http(url.href,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(30000)});
  if(!response.ok||response.redirected||response.status!==200)
    throw new SeoBlogError(502,'Provider media is unavailable or redirected');
  const type=(response.headers.get('content-type')||'').split(';')[0]!.trim().toLowerCase();
  if(type!=='video/mp4'&&type!=='video/webm')
    throw new SeoBlogError(415,'Provider response was not an approved video type');
  const declared=response.headers.get('content-length');
  if(declared && (!/^\d+$/u.test(declared)||Number(declared)>MAX_BYTES))
    throw new SeoBlogError(413,'External output exceeds the current private-storage limit');
  const reader=response.body?.getReader();
  if(!reader)throw new SeoBlogError(502,'Empty provider media response');
  const chunks:Buffer[]=[];let size=0;
  try {
    while(true){
      const next=await reader.read();
      if(next.done)break;
      const buf=Buffer.from(next.value);
      size+=buf.length;
      if(size>MAX_BYTES)throw new SeoBlogError(413,'External output exceeds private-storage limit');
      chunks.push(buf);
    }
  }finally{reader.releaseLock();}
  const bytes=Buffer.concat(chunks);
  const mp4=bytes.length>=1024&&bytes.toString('ascii',4,8)==='ftyp';
  const webm=bytes.length>=1024&&bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
  if((type==='video/mp4'&&!mp4)||(type==='video/webm'&&!webm))
    throw new SeoBlogError(422,'Provider output failed container signature verification');
  return Object.freeze({mime:type as CapturedMedia['mime'],bytes,
    sha256:createHash('sha256').update(bytes).digest('hex')});
}
export interface PendingProviderResult {
 readonly jobId:string;readonly claimToken:string;readonly providerId:string;
 readonly kind:MediaWorkKind;readonly reservedMicrousd:number;
}
export class PgMediaVideoOutputWorker {
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly requestId:string){}
 private command<T>(workspaceId:string,sql:string,args:unknown[]):Promise<T>{
   return withTransaction(this.pool,{actorKind:'worker',workspaceId,requestId:this.requestId},
     async t=>(await t.query<{result:T}>(sql,[workspaceId,...args])).rows[0]!.result);
 }
 pending(workspaceId:string,jobId:string):Promise<PendingProviderResult>{
   if(!UUID.test(workspaceId)||!UUID.test(jobId))throw new SeoBlogError(400,'Invalid media job');
   return this.command(workspaceId,'SELECT app_private.creative_media_video_output_pending($1,$2) AS result',[jobId]);
 }
 capture(input:{workspaceId:string;jobId:string;claimToken:string;providerId:string;slot:number;
   providerAssetId:string;media:CapturedMedia}):Promise<{id:string;sha256:string;replayed:boolean;state:'captured_unverified'}>{
   if(![input.workspaceId,input.jobId,input.claimToken].every(id=>UUID.test(id))
     ||!Number.isInteger(input.slot)||input.slot<0||input.slot>30
     ||!Number.isInteger(input.media.bytes.length)||input.media.bytes.length<1024
     ||input.media.bytes.length>MAX_BYTES
     ||createHash('sha256').update(input.media.bytes).digest('hex')!==input.media.sha256)
     throw new SeoBlogError(400,'Exact private output receipt required');
   return this.command(input.workspaceId,
     'SELECT app_private.creative_media_video_output_capture($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result',
     [input.jobId,input.claimToken,input.providerId,input.slot,input.providerAssetId,
       input.media.mime,input.media.sha256,input.media.bytes]);
 }
}
