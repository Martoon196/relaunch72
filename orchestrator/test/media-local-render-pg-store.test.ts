import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PgLocalRenderOwner,PgLocalRenderWorker,runQueuedLocalRender} from '../src/creative-studio/media-local-render-pg-store.js';
import {workerCommandGate} from '../src/workers/creative-media/worker-gate.js';
import {VIDEO_PROBE_VERSION} from '../src/creative-studio/media-source-probe.js';
import {videoEditDigest,type VideoEditPlan} from '../src/creative-studio/media-edit-plan.js';
import {LOCAL_RENDER_FFMPEG_VERSION,type LocalRenderOutput} from '../src/creative-studio/media-local-render.js';

const ws='11111111-1111-4111-8111-111111111111',
 job='22222222-2222-4222-8222-222222222222',
 project='33333333-3333-4333-8333-333333333333',
 claim='44444444-4444-4444-8444-444444444444',
 user='55555555-5555-4555-8555-555555555555';
const plan:VideoEditPlan={canvas:'square',disclosure:'',
 clips:[{startMs:0,endMs:2000,caption:'Test only',transition:'cut',speed:1}]};
const bytes=Buffer.alloc(1024);
const sourceSha=createHash('sha256').update(bytes).digest('hex');
const source={bytes,sha256:sourceSha,probe:{status:'verified_technical' as const,
  checkerVersion:VIDEO_PROBE_VERSION,durationMs:3000,width:320,height:180,
  frameRate:30,videoCodec:'h264',audioPresent:false}};
const result:LocalRenderOutput={
 bytes,sha256:sourceSha,mime:'video/mp4',width:720,height:720,
 durationMs:2000,audioPresent:true,
 renderVersion:LOCAL_RENDER_FFMPEG_VERSION,
 planSha256:videoEditDigest(plan),sourceSha256:sourceSha,
};
const env={CREATIVE_MEDIA:'enabled',RL72_MEDIA_LOCAL_RENDER_ENABLED:'true',
 RL72_MEDIA_WORKER_ENABLED:'true'};
test('manual native render cannot run with just media enablement or paid API flags',()=>{
 for(const e of [{},{RL72_MEDIA_WORKER_ENABLED:'true'},
   {CREATIVE_MEDIA:'enabled',RL72_MEDIA_WORKER_ENABLED:'true'}])
  assert.throws(()=>workerCommandGate(e,'render-local'),/disabled/);
 assert.doesNotThrow(()=>workerCommandGate(env,'render-local'));
 assert.throws(()=>workerCommandGate(env,'submit'),/not permitted/);
});
test('owner queue requires exact rights, source and timeline revision, worker cannot impersonate owner',async()=>{
 const never={connect:async()=>{throw Error('Unexpected SQL');}} as never;
 const blocked=new PgLocalRenderOwner(never,{kind:'user',
  userId:user,sessionToken:'session',selectedWorkspaceId:ws,requestId:'t'} as never,{});
 await assert.rejects(blocked.enqueue({workspaceId:ws,projectId:project,revision:1,
  sourceSha256:sourceSha,planSha256:result.planSha256,rightsConfirmed:true}),/disabled/);
 const worker=new PgLocalRenderOwner(never,{kind:'worker',requestId:'t'} as never,env);
 await assert.rejects(worker.list(ws),/owner session/);
 assert.throws(()=>worker.enqueue({workspaceId:ws,projectId:project,revision:1,
  sourceSha256:sourceSha,planSha256:result.planSha256,rightsConfirmed:false}),/confirm exact source rights/);
});
test('one-shot offline renderer settles exactly once with the claimed request',async()=>{
 const calls:string[]=[];
 const output=await runQueuedLocalRender(ws,job,{
  ledger:{
   claim:async()=>{calls.push('claim');return{claimToken:claim,sourceSha256:sourceSha,
     planSha256:result.planSha256,plan,bytes,probe:source.probe};},
   complete:async()=>{calls.push('complete');return {id:user,sha256:result.sha256,
    replayed:false,state:'completed' as const};},
   fail:async()=>{calls.push('fail');return{id:job,state:'failed' as const};},
  },
  renderer:async()=>{calls.push('render');return result;},
 });
 assert.deepEqual(output,{state:'completed',jobId:job,outputId:user});
 assert.deepEqual(calls,['claim','render','complete']);
});
test('mismatched plan SHA fails before persisting or claiming public approval',async()=>{
 const calls:string[]=[];
 const output=await runQueuedLocalRender(ws,job,{
  ledger:{
   claim:async()=>({claimToken:claim,sourceSha256:sourceSha,planSha256:'b'.repeat(64),
    plan,bytes,probe:source.probe}),
   complete:async()=>{calls.push('complete');throw Error('Forbidden');},
   fail:async()=>{calls.push('fail');return{id:job,state:'failed' as const};},
  },
  renderer:async()=>result,
 });
 assert.deepEqual(output,{state:'failed',jobId:job});
 assert.deepEqual(calls,['fail']);
});
test('ambiguous local output settlement never invokes a second render',async()=>{
 let renders=0,claims=0;
 const output=await runQueuedLocalRender(ws,job,{
  ledger:{
   claim:async()=>{claims++;return{claimToken:claim,sourceSha256:sourceSha,
    planSha256:result.planSha256,plan,bytes,probe:source.probe};},
   complete:async()=>{throw Error('database response lost after commit');},
   fail:async()=>{throw Error('Do not refund after possible saved output');},
  },
  renderer:async()=>{renders++;return result;},
 });
 assert.deepEqual(output,{state:'reconciliation_required',jobId:job});
 assert.equal(renders,1);assert.equal(claims,1);
});
test('worker query is disabled before requesting a database connection',async()=>{
 const never={connect:async()=>{throw Error('Unexpected SQL');}} as never;
 const worker=new PgLocalRenderWorker(never,'id',{RL72_MEDIA_WORKER_ENABLED:'true'});
 await assert.rejects(worker.claim(ws,job),/disabled/);
});
