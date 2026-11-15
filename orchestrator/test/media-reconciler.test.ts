import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileMediaJob} from '../src/creative-studio/media-reconciler.js';
import {workerCommandGate} from '../src/workers/creative-media/worker-gate.js';
const ids={workspace:'11111111-1111-4111-8111-111111111111',
 job:'22222222-2222-4222-8222-222222222222',claim:'33333333-3333-4333-8333-333333333333'};
function rig(kind:'shotstack_render'|'vizard_clip',status:'processing'|'complete'|'failed'){
 const calls:string[]=[];
 const ports={
  pending:async()=>({jobId:ids.job,kind,claimToken:ids.claim,providerId:'provider-123',reservedMicrousd:1000000}),
  inspectVizard:async()=>{calls.push('inspect-vizard');return{status:(status==='complete'?'complete':'processing') as 'complete'|'processing',clips:status==='complete'?
    [{providerClipId:'clip-1',title:'A clip',transcript:'',durationMs:30000,temporaryDownloadUrl:'https://cdn-video.vizard.ai/1.mp4',expiresWithinDays:7 as const}]:[]};},
  inspectShotstack:async()=>{calls.push('inspect-shotstack');return{status,temporaryDownloadUrl:status==='complete'?'https://cdn.shotstack.io/a.mp4':null,billedCredits:status==='complete'?2:null};},
  download:async()=>{calls.push('download');return {mime:'video/mp4' as const,bytes:Buffer.alloc(1024),sha256:'a'.repeat(64)};},
  capture:async()=>{calls.push('capture');return{id:ids.job,sha256:'a'.repeat(64),replayed:false,state:'captured_unverified' as const};},
 };
 return{ports,calls};
}
test('reconciler captures Shotstack exactly once after completed provider receipt',async()=>{
 const {ports,calls}=rig('shotstack_render','complete');
 const result=await reconcileMediaJob(ids.workspace,ids.job,ports);
 assert.deepEqual(result,{state:'captured_unverified',jobId:ids.job,assets:1,providerCredits:2});
 assert.deepEqual(calls,['inspect-shotstack','download','capture']);
});
test('processing and failure never download or invent a charge',async()=>{
 const pending=rig('vizard_clip','processing');
 assert.equal((await reconcileMediaJob(ids.workspace,ids.job,pending.ports)).state,'processing');
 assert.deepEqual(pending.calls,['inspect-vizard']);
 const failed=rig('shotstack_render','failed');
 assert.equal((await reconcileMediaJob(ids.workspace,ids.job,failed.ports)).state,'provider_failed');
 assert.deepEqual(failed.calls,['inspect-shotstack']);
});
test('worker paid functions are default-deny even with valid job input',()=>{
 assert.throws(()=>workerCommandGate({},'submit'),/disabled/u);
 assert.throws(()=>workerCommandGate({RL72_MEDIA_WORKER_ENABLED:'true'},'submit'),/not permitted/u);
 assert.throws(()=>workerCommandGate({RL72_MEDIA_WORKER_ENABLED:'true'},'reconcile'),/not permitted/u);
 assert.doesNotThrow(()=>workerCommandGate({RL72_MEDIA_WORKER_ENABLED:'true'},'probe'));
});
