import test from 'node:test';
import assert from 'node:assert/strict';
import {runOfflineMediaTick} from '../src/creative-studio/media-worker-dispatch.js';
import {normalizeCompanyContentVersionCommand} from '../src/company-content-pg/validation.js';
import {localVideoDraftCommand} from '../src/creative-studio/media-canonical-handoff.js';
import {checkVideoEditPlan,videoEditDigest} from '../src/creative-studio/media-edit-plan.js';
import {creativeMediaSuitePage} from '../src/portal/creative-media-suite-view.js';
const ws='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const env={CREATIVE_MEDIA:'enabled',RL72_MEDIA_WORKER_ENABLED:'true',RL72_MEDIA_LOCAL_RENDER_ENABLED:'true',RL72_MEDIA_DISPATCH_ENABLED:'true'};
test('bounded offline dispatch deduplicates and holds uncertain jobs without retries or provider operations',async()=>{
 const called:string[]=[];
 const receipts=await runOfflineMediaTick(ws,{pending:async()=>[{kind:'render-local',id},{kind:'render-local',id},{kind:'probe',id}],
  render:async()=>{called.push('render');return{state:'reconciliation_required'};},probe:async()=>{called.push('probe');throw Error('held');},probeOutput:async()=>{throw Error('unexpected');}},{env});
 assert.deepEqual(called,['render','probe']);assert.deepEqual(receipts.map(x=>x.state),['reconciliation_required','held']);
 await assert.rejects(runOfflineMediaTick(ws,{} as never,{env:{}}),/disabled/);
 await assert.rejects(runOfflineMediaTick(ws,{pending:async()=>[{kind:'submit',id}]} as never,{env}),/Unknown offline/);
 const signal=AbortSignal.abort();assert.deepEqual(await runOfflineMediaTick(ws,{} as never,{env,signal}),[]);
});
test('volume changes exact timeline digest while legacy plans keep their immutable shape',()=>{
 const legacy={canvas:'portrait',disclosure:'#ad',clips:[{startMs:0,endMs:1000,caption:'50% saving is owner checked',transition:'cut',speed:1}]} as const;
 const original=checkVideoEditPlan(legacy);assert.equal(JSON.stringify(original),JSON.stringify({canvas:legacy.canvas,clips:legacy.clips,disclosure:legacy.disclosure}));
 const muted=checkVideoEditPlan({...legacy,clips:[{...legacy.clips[0],volume:0}]});
 assert.notEqual(videoEditDigest(original),videoEditDigest(muted));
 assert.throws(()=>checkVideoEditPlan({...legacy,clips:[{...legacy.clips[0],volume:100}]}),/volume/);
});
test('canonical handoff binds video digest, review and caption without granting public release',()=>{
 const now=new Date('2026-11-16T01:00:00Z');
 const manifest={schema:'relaunch72.private-video/v1' as const,workspaceId:ws,outputId:id,sha256:'a'.repeat(64),sourceSha256:'b'.repeat(64),planSha256:'c'.repeat(64),byteLength:1024,durationMs:1000,width:720,height:1280,audioPresent:true,storageKey:'private/blob',reviewRevision:1,reviewedAt:now.toISOString(),reviewedBy:id,brandSha256:'d'.repeat(64)};
 const input={workspaceId:ws,outputId:id,outputSha256:manifest.sha256,reviewRevision:1,commandId:ws,title:'My video',caption:'#ad An owner reviewed caption',platform:'instagram' as const};
 const command=localVideoDraftCommand(input,manifest,now);
 assert.doesNotThrow(()=>normalizeCompanyContentVersionCommand(command));
 assert.equal(command.kind,'video');assert.equal(JSON.parse(command.content).distribution,'pending_canonical_review');
 assert.equal(command.blob.sha256,manifest.sha256);
 assert.throws(()=>localVideoDraftCommand({...input,outputSha256:'f'.repeat(64)},manifest,now),/Exact reviewed/);
 assert.throws(()=>localVideoDraftCommand(input,manifest,new Date(now.getTime()+15*60000)),/fresh private review/);
});
test('standalone presentation exposes only actually integrated features and no invented prices or sales',()=>{
 const shell={csrf:'x',applicationName:'RL72',brands:[],creativeAvailable:true,tab:'creative',brand:{id:ws,name:'Brand'}} as never;
 const html=creativeMediaSuitePage(shell,{audience:'affiliate',access:{active:false,tier:null,source:null,monthlyVideoMicrousd:0,maxJobMicrousd:0,validUntil:null},counts:{products:2,sources:1,timelines:1,renders:0,reports:0},available:new Set(['products'])});
 assert.match(html,/RL72 Affiliate Studio/);assert.match(html,/Awaiting integration/);assert.doesNotMatch(html,/href="[^"]*\/billing"/);
});
