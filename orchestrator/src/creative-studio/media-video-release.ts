/** Native video bridge for the EXISTING Zernio calendar worker. No post scheduler. */
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {withTransaction} from '../db/transaction.js';
import type {PgSeoBlogPrincipal} from '../seo-blog/pg-store.js';
import {SeoBlogError} from '../seo-blog/types.js';
import {checkedEditId} from './media-edit-plan.js';
import type {ZernioCalendarMediaResolver} from '../public-social-outbound/zernio-calendar-live.js';
import type {ZernioPostingClient} from '../public-social-outbound/zernio-posting-client.js';
export class PgNativeVideoReleaseOwner {
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly principal:PgSeoBlogPrincipal,private readonly env:NodeJS.ProcessEnv=process.env){}
 async decide(input:{workspaceId:string;jobId:string;contentVersionId:string;commandId:string;action:'withdraw';consent:boolean}){
  if(this.env.CREATIVE_MEDIA!=='enabled'||this.env.RL72_MEDIA_VIDEO_RELEASE_ENABLED!=='true')throw new SeoBlogError(503,'Native video release disabled');
  const p=this.principal;if(p.kind!=='user')throw new SeoBlogError(403,'Signed-in distribution owner required');
  for(const id of [input.workspaceId,input.jobId,input.contentVersionId,input.commandId])checkedEditId(id);
  if(input.consent!==true||input.action!=='withdraw')throw new SeoBlogError(400,'Explicit exact-job release decision required');
  const hash=createHash('sha256').update(p.sessionToken).digest(),payload=JSON.stringify(input);
  return withTransaction(this.pool,{actorKind:'user',workspaceId:input.workspaceId,userId:p.userId,requestId:p.requestId,portalSessionTokenHash:hash},async t=>(await t.query<{v:{state:string}}>('SELECT app_private.creative_media_video_release_owner($1,$2,$3) AS v',[input.workspaceId,hash,payload])).rows[0]!.v);
 }
}
export class PgNativeVideoReleaseWorker {
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly requestId:string){}
 async load(workspace:string,jobId:string,storageKey:string,expectedSha:string){
  checkedEditId(workspace);checkedEditId(jobId);
  if(!/^rl72-native-video\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-f0-9]{64}\.mp4$/u.test(storageKey)||!/^[a-f0-9]{64}$/u.test(expectedSha))throw new SeoBlogError(400,'Native video storage reference required');
  const row=await withTransaction(this.pool,{actorKind:'worker',workspaceId:workspace,requestId:this.requestId},async t=>(await t.query<{sha256:string;raw_bytes:Buffer}>('SELECT * FROM app_private.creative_media_video_release_by_key($1,$2,$3,$4)',[workspace,jobId,storageKey,expectedSha])).rows[0]);
  if(!row||row.sha256!==expectedSha||!Buffer.isBuffer(row.raw_bytes)||row.raw_bytes.length<1024||row.raw_bytes.length>=20000000||createHash('sha256').update(row.raw_bytes).digest('hex')!==expectedSha)throw new SeoBlogError(409,'Exact authorized MP4 unavailable');
  return Buffer.from(row.raw_bytes);
 }
}
export function createNativeVideoMediaResolver(input:{store:Pick<PgNativeVideoReleaseWorker,'load'>;posting:Pick<ZernioPostingClient,'prepareMediaUpload'>;fetch:typeof globalThis.fetch;legacy:ZernioCalendarMediaResolver;env?:NodeJS.ProcessEnv}):ZernioCalendarMediaResolver{
 return {async resolve(request){
  const env=input.env??process.env,urls:string[]=[];
  for(const item of request.media){
   if(!item.storageKey.startsWith('rl72-native-video/')){const inherited=await input.legacy.resolve({...request,media:[item]});if(inherited.length!==1)throw new SeoBlogError(409,'Inherited media resolver mismatch');urls.push(inherited[0]!);continue;}
   if(env.CREATIVE_MEDIA!=='enabled'||env.RL72_MEDIA_VIDEO_RELEASE_ENABLED!=='true'||item.mimeType!=='video/mp4')throw new SeoBlogError(503,'Native video provider upload disabled');
   const bytes=await input.store.load(request.workspaceId,request.jobId,item.storageKey,item.blobSha256);
   const upload=await input.posting.prepareMediaUpload({requestId:request.jobId,filename:item.blobSha256+'.mp4',contentType:'video/mp4',size:bytes.length});
   const target=new URL(upload.uploadUrl),publicUrl=new URL(upload.publicUrl);
   if(target.protocol!=='https:'||target.username||target.password||target.port||!target.hostname.endsWith('.r2.cloudflarestorage.com')||publicUrl.protocol!=='https:'||publicUrl.hostname!=='media.zernio.com'||publicUrl.username||publicUrl.password||publicUrl.port)throw new SeoBlogError(409,'Unexpected canonical media upload destination');
   // Recheck owner withdrawal and exact job lease after obtaining the temporary upload URL.
   await input.store.load(request.workspaceId,request.jobId,item.storageKey,item.blobSha256);
   const response=await input.fetch(upload.uploadUrl,{method:'PUT',headers:{'content-type':'video/mp4'},body:new Uint8Array(bytes),redirect:'error',signal:AbortSignal.timeout(30000)});
   await response.body?.cancel();if(!response.ok)throw new SeoBlogError(502,'Canonical video upload not confirmed');
   await input.store.load(request.workspaceId,request.jobId,item.storageKey,item.blobSha256);
   urls.push(upload.publicUrl);
  }
  return Object.freeze(urls);
 }};
}
