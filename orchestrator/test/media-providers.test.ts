import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  VizardVideoProvider, ShotstackVideoProvider, MediaProviderError,
  validateMediaAdmission, assertShotstackEdit, type VerifiedMediaAdmission,
  type ClipJobRequest, type RenderJobRequest,
} from '../src/creative-studio/media-providers.js';

const uid=(suffix:string)=>'11111111-1111-4111-8111-'+suffix;
const workspace=uid('111111111111'),actor=uid('222222222222'),receipt=uid('333333333333');
const command=uid('444444444444'),renderId=uid('555555555555');
const permit=(kind:'vizard_clip'|'shotstack_render'):VerifiedMediaAdmission=>({
  receiptId:receipt,workspaceId:workspace,commandId:command,
  kind,approvedBy:actor,approvedAt:'2026-11-15T10:00:00.000Z',
  reservedCostMicrousd:1000000,validUntil:'2099-11-15T10:00:00.000Z',
  state:'reserved',
});
const rights={rights:'owned' as const,evidenceRef:'owner-upload-provenance-17'};
const youtube:ClipJobRequest={
  workspaceId:workspace,commandId:command,rights,sourceUrl:'https://www.youtube.com/watch?v=AB12CD34',
  projectName:'Family prep video',durationSeconds:120,
};
const edit={timeline:{tracks:[{clips:[{asset:{type:'title',text:'Hi'},start:0,length:4}]}]},output:{format:'mp4'}};
const renderReq:RenderJobRequest={
  workspaceId:workspace,commandId:command,edit,
  reviewedEditSha256:createHash('sha256').update(JSON.stringify(edit)).digest('hex'),
};

test('no paid call with disabled video provider',async()=>{
  let calls=0;
  const http=async()=>{calls++;return new Response('{}');};
  const v=new VizardVideoProvider('unused',false,http as typeof fetch);
  const s=new ShotstackVideoProvider('unused',false,'stage',http as typeof fetch);
  await assert.rejects(v.submit(youtube,permit('vizard_clip')), (e:unknown)=>e instanceof MediaProviderError&&e.code==='disabled');
  await assert.rejects(s.submit(renderReq,permit('shotstack_render')), (e:unknown)=>e instanceof MediaProviderError&&e.code==='disabled');
  assert.equal(calls,0);
});

test('admission is bound to workspace, command, kind, reviewer and amount',()=>{
  assert.doesNotThrow(()=>validateMediaAdmission(permit('vizard_clip'),workspace,command,'vizard_clip',new Date('2026-11-15T11:00:00Z')));
  for(const bad of [
    {...permit('vizard_clip'),workspaceId:uid('999999999999')},
    {...permit('vizard_clip'),reservedCostMicrousd:0},
    {...permit('vizard_clip'),state:'expired' as const},
    {...permit('vizard_clip'),approvedBy:''},
  ]){
    assert.throws(()=>validateMediaAdmission(bad as VerifiedMediaAdmission,workspace,command,'vizard_clip'),/reservation/);
  }
  assert.throws(()=>validateMediaAdmission(permit('shotstack_render'),workspace,command,'vizard_clip'),/reservation/);
});

test('Vizard submits exact provider payload with server-side secret and creates no job for unsupported source',async()=>{
  const requests:Array<{url:string;init?:RequestInit}>=[];
  const http=async(url:string|URL|Request,init?:RequestInit)=>{
    requests.push({url:String(url),init});
    return new Response(JSON.stringify({code:2000,projectId:17861706}),{status:200});
  };
  const v=new VizardVideoProvider('private-credential',true,http as typeof fetch);
  await assert.rejects(v.submit({...youtube,sourceUrl:'https://evil.example/video.mp4'},permit('vizard_clip')),/approved RL72 storage/);
  assert.equal(requests.length,0);
  const id=await v.submit(youtube,permit('vizard_clip'));
  assert.equal(id,'17861706');
  assert.equal(requests.length,1);
  assert.equal((requests[0]!.init!.headers as Record<string,string>).VIZARDAI_API_KEY,'private-credential');
  const body=JSON.parse(String(requests[0]!.init!.body)) as Record<string,unknown>;
  assert.equal(body.videoType,2);
  assert.equal(body.videoUrl,youtube.sourceUrl);
  assert.ok(!JSON.stringify(body).includes('private-credential'));
});

test('Vizard processing and 7-day signed clip URLs are explicit',async()=>{
  let count=0;
  const http=async()=>{
    count++;
    return new Response(JSON.stringify(count===1?{code:1000}:{code:2000,videos:[
      {videoId:7,videoUrl:'https://cdn-video.vizard.ai/output/short.mp4',title:'Example',
        transcript:'Actual recorded speech',videoMsDuration:23000},
    ]}));
  };
  const v=new VizardVideoProvider('k',true,http as typeof fetch);
  assert.equal((await v.inspect('17861706')).status,'processing');
  const ready=await v.inspect('17861706');
  assert.equal(ready.status,'complete');
  assert.equal(ready.clips[0]?.expiresWithinDays,7);
  assert.equal(ready.clips[0]?.transcript,'Actual recorded speech');
});

test('Shotstack accepts exact approved edit, records receipt and reports credits only on completion',async()=>{
  const requests:Array<{url:string;init?:RequestInit}>=[];
  const http=async(url:string|URL|Request,init?:RequestInit)=>{
    requests.push({url:String(url),init});
    return new Response(JSON.stringify(requests.length===1
      ?{success:true,response:{id:renderId}}
      :{success:true,response:{id:renderId,status:'done',url:'https://cdn.shotstack.io/file.mp4',credits:1.75}}));
  };
  const s=new ShotstackVideoProvider('secret',true,'stage',http as typeof fetch);
  assert.equal(await s.submit(renderReq,permit('shotstack_render')),renderId);
  const result=await s.inspect(renderId);
  assert.equal(result.status,'complete');
  assert.equal(result.billedCredits,1.75);
  assert.match(requests[0]!.url,/edit\/stage\/render$/);
  assert.match(requests[1]!.url,/render\/[0-9a-f-]+\?data=false$/);
});

test('changed timeline is invalidated and cannot spend render credits',async()=>{
  let count=0;
  const http=async()=>{count++;return new Response('{}');};
  const s=new ShotstackVideoProvider('key',true,'stage',http as typeof fetch);
  assert.throws(()=>assertShotstackEdit({...renderReq,edit:{...edit,output:{format:'gif'}}}),/differs from/);
  await assert.rejects(s.submit({...renderReq,edit:{...edit,output:{format:'gif'}}},permit('shotstack_render')),/differs from/);
  assert.equal(count,0);
});

test('provider status never exposes request credentials in error string',async()=>{
  const http=async()=>new Response(JSON.stringify({code:4001,errMsg:'private-credential'}));
  const v=new VizardVideoProvider('private-credential',true,http as typeof fetch);
  await assert.rejects(v.submit(youtube,permit('vizard_clip')), (e:unknown)=>{
    assert.ok(e instanceof Error);
    assert.ok(!e.message.includes('private-credential'));
    return true;
  });
});
