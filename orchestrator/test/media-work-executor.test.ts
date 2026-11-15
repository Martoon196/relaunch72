import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { submitApprovedMediaJob } from '../src/creative-studio/media-work-executor.js';
import { MediaProviderError, mediaRequestDigests, type ClipJobRequest } from '../src/creative-studio/media-providers.js';

const id=(n:string)=>'11111111-1111-4111-8111-'+n;
const workspace=id('111111111111'),job=id('222222222222'),command=id('333333333333'),token=id('444444444444');
const request:ClipJobRequest={
  workspaceId:workspace,commandId:command,rights:{rights:'owned',evidenceRef:'owned-video-asset-112'},
  sourceUrl:'https://www.youtube.com/watch?v=test',projectName:'Edited user-owned footage',durationSeconds:120,
};
function rig(mode:'ok'|'timeout'|'disabled'|'receipt-failed'='ok',changeRequest=false){
  const events:string[]=[];
  const digests=mediaRequestDigests(request);
  const claim={id:job,commandId:command,claimToken:token,kind:'vizard_clip' as const,
    payloadSha:changeRequest?'a'.repeat(64):digests.payloadSha256,rightsSha:digests.rightsSha256,
    reservedMicrousd:500000,approvedBy:id('555555555555'),
    approvedAt:'2026-11-15T10:00:00Z',validUntil:'2099-01-01T00:00:00Z'};
  let claimed=false;
  const ledger={
    async claim(){if(claimed)throw new Error('Job already claimed');claimed=true;events.push('claim');return claim;},
    async submitted(){events.push('submitted');if(mode==='receipt-failed')throw new Error('db offline');return {id:job,state:'submitted'};},
    async failed(){events.push('failed');return {id:job,state:'failed'};},
    async unknown(){events.push('unknown');return {id:job,state:'outcome_unknown'};},
  };
  const vizard={async submit(){
    events.push('provider');
    if(mode==='timeout')throw new MediaProviderError('timeout','Timeout after potential payment');
    if(mode==='disabled')throw new MediaProviderError('disabled','Provider switched off');
    return '1234567';
  }};
  const shotstack={async submit(){events.push('WRONG_PROVIDER');return '123';}};
  return{events,ports:{ledger,vizard,shotstack}};
}
test('claim, verify SHA256 and submit exactly once with SQL receipt',async()=>{
  const {events,ports}=rig();
  assert.deepEqual(await submitApprovedMediaJob(workspace,job,{kind:'vizard_clip',request},ports),
    {state:'submitted',jobId:job,providerJobId:'1234567'});
  assert.deepEqual(events,['claim','provider','submitted']);
  await assert.rejects(submitApprovedMediaJob(workspace,job,{kind:'vizard_clip',request},ports),/already claimed/);
  assert.deepEqual(events,['claim','provider','submitted']);
});
test('no paid provider call when exact owner-reviewed payload differs',async()=>{
  const {events,ports}=rig('ok',true);
  const result=await submitApprovedMediaJob(workspace,job,{kind:'vizard_clip',request},ports);
  assert.equal(result.state,'failed');
  assert.deepEqual(events,['claim','failed']);
});
test('unknown provider result holds credits and cannot automatically replay',async()=>{
  const {events,ports}=rig('timeout');
  assert.equal((await submitApprovedMediaJob(workspace,job,{kind:'vizard_clip',request},ports)).state,'outcome_unknown');
  assert.deepEqual(events,['claim','provider','unknown']);
  await assert.rejects(submitApprovedMediaJob(workspace,job,{kind:'vizard_clip',request},ports),/already claimed/);
  assert.equal(events.filter(x=>x==='provider').length,1);
});
test('a local provider-disable is a definite no-spend failure',async()=>{
  const {events,ports}=rig('disabled');
  assert.equal((await submitApprovedMediaJob(workspace,job,{kind:'vizard_clip',request},ports)).state,'failed');
  assert.deepEqual(events,['claim','provider','failed']);
});
test('accepted provider response with lost database receipt is NOT resubmitted',async()=>{
  const {events,ports}=rig('receipt-failed');
  assert.equal((await submitApprovedMediaJob(workspace,job,{kind:'vizard_clip',request},ports)).state,'outcome_unknown');
  assert.deepEqual(events,['claim','provider','submitted','unknown']);
});
test('worker refuses wrong tenant and request digest before calling any provider',async()=>{
  const {events,ports}=rig();
  const wrong={...request,workspaceId:id('999999999999')};
  assert.equal((await submitApprovedMediaJob(workspace,job,{kind:'vizard_clip',request:wrong},ports)).state,'failed');
  assert.deepEqual(events,['claim','failed']);
});
