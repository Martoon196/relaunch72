import test from 'node:test';
import assert from 'node:assert/strict';
import {checkedPrivateReview,PgMediaOutputReviewOwner,PgMediaOutputProbeWorker} from '../src/creative-studio/media-output-review.js';

const workspace='11111111-1111-4111-8111-111111111111',
 output='22222222-2222-4222-8222-222222222222',
 command='33333333-3333-4333-8333-333333333333';
const input={workspaceId:workspace,outputId:output,outputSha256:'a'.repeat(64),
 expectedRevision:0,commandId:command,decision:'reviewed_private' as const,
 rightsConfirmed:true,claimsConfirmed:true,disclosureConfirmed:true};
test('exact private review requires all three independent owner attestations',()=>{
 assert.deepEqual(checkedPrivateReview(input),input);
 for(const key of ['rightsConfirmed','claimsConfirmed','disclosureConfirmed'] as const){
  assert.throws(()=>checkedPrivateReview({...input,[key]:false}),/rights, truthful claims and disclosure/);
 }
 assert.throws(()=>checkedPrivateReview({...input,outputSha256:'b'}),/Exact video/);
 assert.throws(()=>checkedPrivateReview({...input,expectedRevision:-1}),/Exact video/);
 assert.throws(()=>checkedPrivateReview({...input,commandId:'spoofed'}),/Exact video/);
 const reject=checkedPrivateReview({...input,decision:'rejected_private',rightsConfirmed:false,
  claimsConfirmed:false,disclosureConfirmed:false});
 assert.equal(reject.decision,'rejected_private');
});
test('media review is disabled by default and refuses worker identity',async()=>{
 const never={connect:async()=>{throw Error('SQL must not be reached');}} as never;
 const workerPrincipal={kind:'worker',requestId:'unit-test'} as never;
 const store=new PgMediaOutputReviewOwner(never,workerPrincipal,{CREATIVE_MEDIA:'enabled'});
 await assert.rejects(store.review(input),/signed-in workspace owner/iu);
 const disabled=new PgMediaOutputReviewOwner(never,workerPrincipal,{});
 await assert.rejects(disabled.review(input),/disabled/iu);
});
test('probing is disabled by default, even with valid output IDs',async()=>{
 const never={connect:async()=>{throw Error('SQL must not be reached');}} as never;
 const flags=[{}, {CREATIVE_MEDIA:'enabled'}, {RL72_MEDIA_WORKER_ENABLED:'true'}];
 for(const env of flags)
  await assert.rejects(new PgMediaOutputProbeWorker(never,'unit-test',env).probe(workspace,output),
    /disabled/iu);
});
