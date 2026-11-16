import test from 'node:test';
import vm from 'node:vm';
import {MEDIA_STREAMING_SHA256} from '../src/portal/media-streaming-sha256.js';
import assert from 'node:assert/strict';
import {mkdtemp,rm,symlink,unlink,chmod,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {PrivateMediaFiles,LARGE_MEDIA_PART_BYTES} from '../src/creative-studio/media-private-files.js';
import {affiliateClickToken,validAffiliateClickToken,type AffiliatePublicPage} from '../src/creative-studio/media-affiliate-pages.js';
import {affiliateProductPage,AFFILIATE_CLICK_SCRIPT} from '../src/portal/creative-media-affiliate-page-view.js';
import {createNativeVideoMediaResolver} from '../src/creative-studio/media-video-release.js';
import {mediaSignupSourceHash,completeAffiliateStudioSetup,PgAffiliateStudioSignup} from '../src/creative-studio/media-standalone-signup.js';
const ws='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
test('real private filesystem stores and streams a >20 MB object, detects changed parts and isolates workspace keys',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rl72-private-large-'));
 try{
  const files=new PrivateMediaFiles(root),bytes=Buffer.alloc(24*1024*1024,0x61);bytes.writeUInt32BE(24,0);bytes.write('ftyp',4,'ascii');
  const object={workspaceId:ws,sourceId:id,byteLength:bytes.length,sha256:sha(bytes),mime:'video/mp4' as const,objectKey:ws+'/'+id+'/'+sha(bytes)+'.mp4'};
  const count=Math.ceil(bytes.length/LARGE_MEDIA_PART_BYTES);
  for(let index=0;index<count;index++)await files.putPart(ws,id,index,bytes.length,bytes.subarray(index*LARGE_MEDIA_PART_BYTES,(index+1)*LARGE_MEDIA_PART_BYTES));
  assert.equal((await files.putPart(ws,id,0,bytes.length,bytes.subarray(0,LARGE_MEDIA_PART_BYTES))).replayed,true);
  await assert.rejects(files.putPart(ws,id,0,bytes.length,Buffer.alloc(LARGE_MEDIA_PART_BYTES)),/changed bytes/);
  const stored=await files.assemble(object,id);assert.equal(stored.byteLength,bytes.length);
  const stream=await files.readRange(object,1000,1999),parts:Buffer[]=[];for await(const part of stream)parts.push(Buffer.from(part));assert.deepEqual(Buffer.concat(parts),bytes.subarray(1000,2000));
  await assert.rejects(files.verify({...object,workspaceId:randomUUID()}),/Exact private/);
  await chmod(stored.path,0o600);await writeFile(stored.path,Buffer.alloc(bytes.length));await assert.rejects(files.verify(object),/checksum changed/);
  await unlink(stored.path);const other=join(root,'other.mp4');await writeFile(other,bytes);await symlink(other,stored.path);await assert.rejects(files.verify(object));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('observed click token binds product revision and expires without identifying the visitor',()=>{
 const key=Buffer.alloc(32,9),now=Date.now(),token=affiliateClickToken(ws,2,key,now,id);
 assert.equal(validAffiliateClickToken(token,key,now),true);assert.equal(validAffiliateClickToken(token,key,now+601000),false);
 assert.equal(validAffiliateClickToken(token.replace('.2.','.3.'),key,now),false);assert.equal(validAffiliateClickToken(token,Buffer.alloc(32,8),now),false);
 assert.doesNotMatch(token,/@|user|email|ip/);
});
test('public product template escapes owner text, preserves the direct Amazon tag and makes no sale/price claim',()=>{
 const page={publicationId:ws,productRevision:1,productName:'Radio <script>alert(1)</script>',merchantName:'Amazon UK',productUrl:'https://www.amazon.co.uk/dp/B000000001',affiliateUrl:'https://www.amazon.co.uk/dp/B000000001?tag=owner-21',network:'amazon_associates',disclosureVersion:'v1',registeredSite:'https://studio.example/',origin:'https://studio.example',signingKeySha256:'a'.repeat(64)} as AffiliatePublicPage;
 const html=affiliateProductPage(page,'token');assert.doesNotMatch(html,/<script>alert/);assert.match(html,/href="https:\/\/www.amazon.co.uk\/dp\/B000000001\?tag=owner-21"/);
 assert.match(html,/As an Amazon Associate/);assert.match(html,/Check the merchant/);assert.doesNotMatch(AFFILIATE_CLICK_SCRIPT,/preventDefault|location\s*=|document.cookie/);
});
test('video resolver rechecks release before and after upload and reuses the existing canonical media client',async()=>{
 const bytes=Buffer.alloc(1024);let checks=0,uploads=0,put=0;
 const resolver=createNativeVideoMediaResolver({store:{load:async()=>{checks++;return bytes;}},posting:{prepareMediaUpload:async()=>{uploads++;return{uploadUrl:'https://bucket.r2.cloudflarestorage.com/video',publicUrl:'https://media.zernio.com/temp/video.mp4',expiresIn:600};}},fetch:(async()=>{put++;return new Response('',{status:200});}) as typeof fetch,legacy:{resolve:async()=>[]},env:{CREATIVE_MEDIA:'enabled',RL72_MEDIA_VIDEO_RELEASE_ENABLED:'true'}});
 const result=await resolver.resolve({workspaceId:ws,jobId:id,media:[{storageKey:'rl72-native-video/'+ws+'/'+id+'/'+sha(bytes)+'.mp4',blobSha256:sha(bytes),mimeType:'video/mp4'}]});
 assert.deepEqual(result,['https://media.zernio.com/temp/video.mp4']);assert.equal(checks,3);assert.equal(uploads,1);assert.equal(put,1);
 const blocked=createNativeVideoMediaResolver({store:{load:async()=>{throw Error('withdrawn');}},posting:{prepareMediaUpload:async()=>{throw Error('Must not upload');}},fetch,legacy:{resolve:async()=>[]},env:{CREATIVE_MEDIA:'enabled',RL72_MEDIA_VIDEO_RELEASE_ENABLED:'true'}});
 await assert.rejects(blocked.resolve({workspaceId:ws,jobId:id,media:[{storageKey:'rl72-native-video/'+ws+'/'+id+'/'+sha(bytes)+'.mp4',blobSha256:sha(bytes),mimeType:'video/mp4'}]}),/withdrawn/);
});
test('standalone setup delegates to canonical auth; signup is disabled before any identity or delivery write',async()=>{
 const hash=mediaSignupSourceHash('server-observed-source',Buffer.alloc(32,1));assert.equal(hash.length,32);assert.notDeepEqual(hash,mediaSignupSourceHash('server-observed-source',Buffer.alloc(32,2)));
 const never={query:async()=>{throw Error('Unexpected DB call');}} as never,setup={prepare:()=>{throw Error('Unexpected credential generation');}};
 await assert.rejects(new PgAffiliateStudioSignup(never,setup,{}).begin({commandId:id,email:'me@example.com',name:'Owner',workspaceName:'My studio',termsVersion:'v1',acceptedTerms:true},hash),/disabled/);
 let received='';const auth={completeSetup:async(token:string)=>{received=token;return null;}};
 assert.equal(await completeAffiliateStudioSetup(auth,'one-use-token','password',{now:Date.now()}),null);assert.equal(received,'one-use-token');
});

test('incremental browser checksum matches native SHA256 across padding and chunk boundaries',()=>{
 const make=new vm.Script(MEDIA_STREAMING_SHA256+';()=>new RL72Sha256()').runInNewContext() as ()=>{update:(bytes:Uint8Array)=>unknown;hex:()=>string};
 for(const length of [0,1,55,56,63,64,65,1024,1048577,24*1024*1024]){
  const input=Buffer.alloc(length);for(let i=0;i<length;i++)input[i]=i%251;
  const hash=make();for(let offset=0;offset<input.length;offset+=7919)hash.update(input.subarray(offset,offset+7919));assert.equal(hash.hex(),sha(input));
 }
});
