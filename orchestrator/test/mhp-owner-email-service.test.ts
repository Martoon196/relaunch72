import assert from 'node:assert/strict';
import test from 'node:test';
import type { CompanyContentService, CompanyContentTransactionRunner } from '../src/company-content-pg/index.js';
import type { DatabaseRequestContext } from '../src/db/rls.js';
import { MhpCommerceError } from '../src/mhp/commerce-service.js';
import { MhpOwnerEmailService, PgMhpOwnerEmailRepository, mhpOwnerEmailTestConfig, type MhpOwnerEmailRepository } from '../src/mhp/owner-email-service.js';
import { mhpMarketingConfig } from '../src/mhp/marketing-mail.js';
import { ids,identity,tokenHash,now,copy,digest,exact,local,review,snapshot } from './helpers/mhp-owner-email-fixture.js';

const configEnv={MHP_MARKETING_MODE:'live',MHP_POSTMARK_SERVER_TOKEN:'synthetic-token',MHP_MARKETING_FROM:'owner@example.invalid',MHP_MARKETING_TEST_TO:'owner@example.invalid'};
function fixture(){
  const state={allowed:true,saved:false,approved:false,sourceReceipt:false,failAfterSave:false,failAfterRefresh:false,failBeforeSave:false,
    testReserved:false,testAccepted:false,providerFail:false,testFinishFail:false,calls:[] as string[],sent:[] as unknown[],review:{...review},local:{...local}};
  const context=(value:DatabaseRequestContext)=>{assert.equal(value.userId,identity.userId);assert.equal(value.workspaceId,identity.workspaceId);assert.deepEqual(value.portalSessionTokenHash,tokenHash);};
  const repository:MhpOwnerEmailRepository={snapshot:async()=>snapshot.database,
    local:async(_identity,version)=>version?state.local:state.saved?state.local:null,
    queue:async(_identity,input)=>{state.calls.push('queue');return{...input,contentItemId:ids.item,contentVersionId:input.versionId,changed:3,remaining:0,inFlight:0,replayed:false};},
    testBegin:async(given,_command,version,destination)=>{assert.equal(given.sessionToken,identity.sessionToken);assert.equal(version,ids.version);assert.equal(destination.length,32);
      state.calls.push('testBegin');if(state.testReserved)return{send:false,status:state.testAccepted?'accepted':'unknown'};
      state.testReserved=true;return{send:true,status:'unknown',testId:ids.request,exact};},
    testFinish:async(_identity,_command,accepted)=>{state.calls.push('testFinish');if(state.testFinishFail)throw Error('simulated connection failure');state.testAccepted=accepted;}};
  const adapter:Pick<CompanyContentService,'createEmailDraftVersion'|'refreshSourceAttestation'>={
    createEmailDraftVersion:async(ctx,command)=>{context(ctx);state.calls.push('save');if(state.failBeforeSave)throw Error('storage unavailable');
      assert.equal(command.source.system,'mhp.owner-email');state.saved=true;if(state.failAfterSave)throw Error('completed receipt hidden from locked read');
      return{disposition:'applied',contentItemId:ids.item,contentVersionId:ids.version,versionNumber:1,contentSha256:digest,sourceAttestationId:ids.proof,sourceAttestationExpiresAt:new Date(now+900_000).toISOString()};},
    refreshSourceAttestation:async(ctx,command)=>{context(ctx);state.calls.push('refresh');state.sourceReceipt=true;if(state.failAfterRefresh)throw Error('completed receipt conflict');
      return{disposition:'applied',contentItemId:ids.item,contentVersionId:ids.version,sourceAttestationId:ids.proof,sourceAttestationExpiresAt:command.attestation.expiresAt,providerEffects:false};}};
  const adapterTransactions={run:async(ctx:DatabaseRequestContext,operation:any)=>{context(ctx);return operation({query:async()=>({rows:state.sourceReceipt?[{status:'succeeded',result:{contentItemId:ids.item,contentVersionId:ids.version}}]:[]})});}} as CompanyContentTransactionRunner;
  const service=new MhpOwnerEmailService({marketingWorkspace:{snapshot:async given=>{if(!state.allowed)throw new MhpCommerceError(403,'Owner required');return{userId:given.userId,selectedWorkspaceId:given.workspaceId,personalWorkspaceId:ids.prospect,marketingWorkspaceId:identity.workspaceId,marketingSelected:given.workspaceId===identity.workspaceId};}},
    repository,reader:{listCatalog:async ctx=>{context(ctx);return snapshot.catalog;},getExactReview:async ctx=>{context(ctx);return state.review;}},adapter,adapterTransactions,
    approvals:{requestApproval:async(ctx,command)=>{context(ctx);state.calls.push('request');return{disposition:'applied',approvalRequestId:ids.request,contentItemId:ids.item,contentVersionId:ids.version,requestNumber:1,contentSha256:digest};},
      decideApproval:async(ctx,command)=>{context(ctx);state.calls.push('approve');state.approved=true;state.review={...state.review,approvalStatus:'approved',approvalDecisionId:ids.approval};return{disposition:'applied',approvalRequestId:ids.request,approvalDecisionId:ids.approval,contentItemId:ids.item,contentVersionId:ids.version,decision:'approved',contentSha256:digest};}},
    campaign:'webinar-proof',status:snapshot.status,testRecipient:'owner@example.invalid',testSender:{sendRendered:async send=>{state.calls.push('provider');state.sent.push(send);if(state.providerFail)throw Error('timeout');return'synthetic-provider-reference';}}});
  return{state,service,repository};
}
const input={commandId:ids.command,...copy,contentItemId:'',previousVersionId:''};

test('save uses actual owner/hash and generic immutable content with zero queue or provider effects; replay survives timestamp change',async()=>{
  const f=fixture();const first=await f.service.save(identity,ids.request,input,now);assert.equal(first.replayed,false);
  assert.equal((await f.service.save(identity,ids.request,input,now+60_000)).replayed,true);assert.deepEqual(f.state.calls,['save']);
  await assert.rejects(f.service.save(identity,ids.request,{...input,subject:'Changed'},now),{status:409});
});
test('a committed save race recovers only the exact stored revision; absent result still fails',async()=>{
  const f=fixture();f.state.failAfterSave=true;assert.equal((await f.service.save(identity,ids.request,input,now)).replayed,true);
  const failed=fixture();failed.state.failBeforeSave=true;await assert.rejects(failed.service.save(identity,ids.request,input,now),{status:503});
});
test('one Publish action composes exact real-user refresh/request/decision and never queues; retry is idempotent',async()=>{
  const f=fixture();f.state.failAfterRefresh=true;await f.service.publish(identity,ids.request,ids.item,ids.version,ids.command,now);
  await f.service.publish(identity,ids.request,ids.item,ids.version,ids.command,now+60_000);
  assert.deepEqual(f.state.calls,['refresh','request','approve']);assert.equal(f.state.approved,true);
});
test('partial publication resumes its saved refresh receipt without creating a new time-dependent observation',async()=>{
  const f=fixture();f.state.sourceReceipt=true;await f.service.publish(identity,ids.request,ids.item,ids.version,ids.command,now+60_000);
  assert.deepEqual(f.state.calls,['request','approve']);
});
test('personal, revoked and stale or brand-changed versions fail before content or queue mutations',async()=>{
  const f=fixture();await assert.rejects(f.service.save({...identity,workspaceId:ids.prospect},ids.request,input),{status:403});
  f.state.allowed=false;await assert.rejects(f.service.queue(identity,ids.request,{action:'cancel',commandId:ids.command,versionId:ids.version,dueAt:'',expiresAt:''}),{status:403});
  f.state.allowed=true;f.state.review={...review,isLatest:false};await assert.rejects(f.service.publish(identity,ids.request,ids.item,ids.version,ids.command),{status:409});
  f.state.review={...review};f.state.local={...local,valid:false,exact:null};await assert.rejects(f.service.publish(identity,ids.request,ids.item,ids.version,ids.command),{status:409});assert.deepEqual(f.state.calls,[]);
});
test('owner test is forced to configured inbox and a repeated reservation cannot send again',async()=>{
  const f=fixture();assert.equal(await f.service.test(identity,ids.request,ids.version,ids.command),'accepted');
  assert.equal(await f.service.test(identity,ids.request,ids.version,ids.command),'accepted');assert.equal(f.state.sent.length,1);
  const send=f.state.sent[0] as {email:string;ownerTest:boolean;rendered:{subject:string}};assert.equal(send.email,'owner@example.invalid');assert.equal(send.ownerTest,true);assert.match(send.rendered.subject,/^\[TEST\]/);
});
test('crash or provider timeout leaves test unknown and the same command never retries delivery',async()=>{
  for(const kind of ['providerFail','testFinishFail'] as const){const f=fixture();f.state[kind]=true;
    assert.equal(await f.service.test(identity,ids.request,ids.version,ids.command),'unknown');assert.equal(await f.service.test(identity,ids.request,ids.version,ids.command),'unknown');assert.equal(f.state.sent.length,1);}
  const reserved=fixture();reserved.state.testReserved=true;assert.equal(await reserved.service.test(identity,ids.request,ids.version,ids.command),'unknown');assert.equal(reserved.state.sent.length,0);
});
test('owner test configuration requires one unique valid target even in live mode and exposes no addresses or secrets',()=>{
  const marketing=mhpMarketingConfig(configEnv)!;
  for(const target of ['', 'owner@example.invalid,other@example.invalid','owner@example.invalid,broken']){
    assert.equal(mhpOwnerEmailTestConfig({...configEnv,MHP_MARKETING_TEST_TO:target},marketing).status.testEnabled,false);}
  const one=mhpOwnerEmailTestConfig({...configEnv,MHP_MARKETING_TEST_TO:'OWNER@example.invalid, owner@example.invalid'},marketing);
  assert.equal(one.recipient,'owner@example.invalid');assert.equal(one.status.testRecipientCount,1);assert.equal(one.status.testEnabled,true);
  assert.equal(mhpOwnerEmailTestConfig(configEnv,null).status.testEnabled,false);assert.doesNotMatch(JSON.stringify(one.status),/@|synthetic-token/);
});
test('repository passes only native token hash and server audience into capabilities, rejects personal before querying',async()=>{
  const calls:{sql:string,args:any[]}[]=[];const pool={query:async(sql:string,args:any[])=>{calls.push({sql,args});return{rows:[{value:snapshot.database}]};}};
  const repo=new PgMhpOwnerEmailRepository(pool as any,pool as any);await repo.snapshot(identity,'webinar-proof');assert.deepEqual(calls[0]!.args,[tokenHash,'webinar-proof']);
  await assert.rejects(repo.snapshot({...identity,workspaceId:ids.prospect},'webinar-proof'),{status:403});assert.equal(calls.length,1);
});
