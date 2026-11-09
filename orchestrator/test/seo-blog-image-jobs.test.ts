import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import jpeg from 'jpeg-js';
import { prepareImageGenerationRequest, type ImageCandidate, type ImageGenerationReceipt } from '../src/seo-blog/image-generation.js';
import { prepareJpegVariants, JpegPreparationError } from '../src/seo-blog/jpeg-preparation.js';
import { runImageJob, IMAGE_JOB_SCHEMA, IMAGE_SOURCE_SNAPSHOT_VERSION, type ImageJobDependencies, type ImageAttemptRef, type CommittedImageReceipt, type CommittedImageAdmission } from '../src/seo-blog/image-jobs.js';
// Stub only committed boundary outcomes; these are ordering tests, not a SQL proof.
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const command={brandId:id(1),actorId:id(2),prompt:'Private approved visual guidance: calm British town, natural daylight.'};
const prepared=prepareImageGenerationRequest(command);
const bytes=jpeg.encode({width:1536,height:1024,data:Buffer.alloc(1536*1024*4,255)},65).data;
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const output=prepareJpegVariants(bytes); // Actual bounded codec output, reused for orchestration cases.
const candidate={sha256:hash(bytes),mimeType:'image/jpeg' as const,byteLength:bytes.length,requestedSize:'1536x1024' as const,validation:'candidate_only' as const};
Object.defineProperty(candidate,'bytes',{enumerable:false,get:()=>Buffer.from(bytes)});
const receipt:ImageGenerationReceipt=Object.freeze({outcome:'candidate_received',code:'candidate_received',requestSha256:prepared.requestSha256,providerRequestIdSha256:'a'.repeat(64),httpStatus:200,candidate:Object.freeze(candidate) as ImageCandidate,usage:null});
function job(){return{id:id(3),brandId:id(1),kind:'write',state:'running',leaseOwner:'worker-a',attempts:1,payload:{stage:'image',image:{
 schema:IMAGE_JOB_SCHEMA,sourceSnapshotVersion:IMAGE_SOURCE_SNAPSHOT_VERSION,intentId:id(4),intentSha256:'a'.repeat(64),requestSha256:prepared.requestSha256,
 sourceSha256:'b'.repeat(64),profileSha256:'c'.repeat(64),visualSha256:'d'.repeat(64),articleId:id(5),articleVersionId:id(6),articleContentSha256:'e'.repeat(64),
 sponsorUserId:id(2),expectedPolicyVersion:1,expectedPolicySha256:'f'.repeat(64),model:'gpt-image-2',quality:'medium',sourceSnapshot:{recipe:IMAGE_SOURCE_SNAPSHOT_VERSION,profileVersion:4,knowledge:[{id:id(21),version:1}]},privateCommand:{...command},
}}};}
function saved(attempt:ImageAttemptRef,extra:Partial<CommittedImageReceipt>={}):CommittedImageReceipt{return{commitAcknowledged:true,attemptId:attempt.attemptId,nonce:attempt.nonce,reservedRequestSha256:prepared.requestSha256,receivedRequestSha256:prepared.requestSha256,outcome:'candidate_received',candidate:{assetId:id(8),sha256:hash(bytes)},applyEligible:true,...extra};}
function harness(){
 const events:string[]=[];let lastAttempt:ImageAttemptRef|null=null;
 const deps:ImageJobDependencies={providerConfigured:true,
  async admitCommitted(_claim,input){events.push('commit-start');return{kind:'admitted',commitAcknowledged:true,attemptId:id(7),nonce:input.nonce};},
  async generate(input){events.push('transport');assert.equal(input.prompt,command.prompt);return receipt;},
  async persistReceiptCommitted(_claim,attempt,envelope){events.push('commit-receipt');lastAttempt=attempt;assert.deepEqual(envelope.receipt.candidate!.bytes,bytes);return saved(attempt);},
  async loadCandidate(_claim,asset,sha){events.push('load');assert.equal(asset,id(8));assert.equal(sha,hash(bytes));return Buffer.from(bytes);},
  prepare(input){events.push('decode');assert.equal(hash(input),hash(bytes));return output;},
  async commitPreparation(_claim,_attempt,stored,value){events.push('commit-preparation');assert.equal(stored.candidate!.assetId,id(8));return{commitAcknowledged:true,candidateAssetId:id(8),sourceSha256:hash(bytes),variants:value.variants.map((v,i)=>({assetId:id(9+i),sha256:v.sha256,profile:v.recipe!.profile}))};},
  async recordPreparationFailure(_c,_a,_r,input){events.push('failure:'+input.code+':'+input.retryable);},
  async applyPreparedCommitted(){events.push('apply');return{applied:true};},
 };return{deps,events,attempt:()=>lastAttempt!};
}
test('committed start then one transport then durable raw receipt before codec and private proposal',async()=>{
 const h=harness(),r=await runImageJob(job(),h.deps);assert.equal(r.state,'prepared');assert.equal(r.transportInvocations,1);assert.equal(r.receiptPersisted,true);assert.deepEqual(r.variantAssetIds,[id(9),id(10),id(11)]);
 assert.deepEqual(h.events,['commit-start','transport','commit-receipt','load','decode','commit-preparation','apply']);assert.equal(JSON.stringify(r).includes(command.prompt),false);assert.equal(Object.hasOwn(r,'publicUrl'),false);
});
test('caller mutations cannot change frozen request or source snapshot after admission begins',async()=>{
 const h=harness(),raw=job(),admit=h.deps.admitCommitted;h.deps.admitCommitted=async(claim,input)=>{raw.payload.image.privateCommand.prompt='Changed';raw.payload.image.sourceSnapshot.profileVersion=5;assert.equal(claim.sourceSnapshot.profileVersion,4);assert.ok(Object.isFrozen(claim.sourceSnapshot));assert.equal(JSON.stringify(claim).includes('knowledge'),false);return admit(claim,input);};
 assert.equal((await runImageJob(raw,h.deps)).state,'prepared');
});
test('unknown reclaimed start never grants another transport call',async()=>{
 const h=harness();h.deps.admitCommitted=async()=>({kind:'existing_started',attemptId:id(7),nonce:id(20)});const r=await runImageJob({...job(),attempts:2,leaseOwner:'reclaimed'},h.deps);assert.equal(r.code,'outcome_unknown');assert.equal(r.transportInvocations,0);assert.deepEqual(h.events,[]);
});
test('ambiguous start, missing commit acknowledgement and wrong nonce cannot invoke provider',async()=>{
 for(const mode of ['throw','no-ack','wrong-nonce']){const h=harness();h.deps.admitCommitted=async()=>{if(mode==='throw')throw Error(command.prompt);return{kind:'admitted',commitAcknowledged:mode!=='no-ack',attemptId:id(7),nonce:id(20)} as unknown as CommittedImageAdmission;};const r=await runImageJob(job(),h.deps);assert.equal(r.code,'admission_unknown');assert.equal(r.transportInvocations,0);assert.deepEqual(h.events,[]);}
});
test('lost receipt acknowledgement replays only the same DB operation and candidate bytes',async()=>{
 const h=harness();let saves=0,retained:CommittedImageReceipt|null=null;h.deps.persistReceiptCommitted=async(_claim,attempt,envelope)=>{h.events.push('save:'+ ++saves);assert.deepEqual(envelope.receipt.candidate!.bytes,bytes);if(!retained){retained=saved(attempt);throw Error('Lost acknowledgement');}assert.equal(retained.nonce,attempt.nonce);return retained;};
 const r=await runImageJob(job(),h.deps);assert.equal(r.state,'prepared');assert.equal(r.transportInvocations,1);assert.equal(saves,2);assert.deepEqual(h.events.slice(0,5),['commit-start','transport','save:1','save:2','load']);
});
test('two receipt-storage failures hold without decode or provider retry',async()=>{
 const h=harness();let writes=0;h.deps.persistReceiptCommitted=async()=>{writes++;throw Error(command.prompt);};const r=await runImageJob(job(),h.deps);assert.equal(r.code,'receipt_unconfirmed');assert.equal(r.transportInvocations,1);assert.equal(writes,2);assert.equal(h.events.includes('decode'),false);assert.equal(JSON.stringify(r).includes(command.prompt),false);
});
test('durable receipt recovers locally even if provider credential was removed',async()=>{
 const h=harness(),prior:ImageAttemptRef={workspaceId:id(1),jobId:id(3),intentId:id(4),attemptId:id(7),nonce:id(20),reservedRequestSha256:prepared.requestSha256};h.deps.admitCommitted=async()=>({kind:'existing_receipt',attemptId:id(7),nonce:id(20),receipt:saved(prior)});
 const r=await runImageJob({...job(),attempts:2},{...h.deps,providerConfigured:false});assert.equal(r.state,'prepared');assert.equal(r.transportInvocations,0);assert.deepEqual(h.events,['load','decode','commit-preparation','apply']);
});
test('local decoder failure retains paid candidate and recovery never generates again',async()=>{
 const h=harness();h.deps.prepare=()=>{h.events.push('decode-failed');throw Error('Transient allocation');};const first=await runImageJob(job(),h.deps);assert.equal(first.state,'retry_local');assert.equal(first.receiptPersisted,true);assert.equal(first.candidateAssetId,id(8));assert.ok(h.events.indexOf('commit-receipt')<h.events.indexOf('decode-failed'));assert.ok(h.events.includes('failure:preparation_failed:true'));
 const a=h.attempt();h.events.length=0;h.deps.admitCommitted=async()=>({kind:'existing_receipt',attemptId:a.attemptId,nonce:a.nonce,receipt:saved(a)});h.deps.prepare=()=>{h.events.push('local-recovery');return output;};const second=await runImageJob({...job(),attempts:2},h.deps);assert.equal(second.state,'prepared');assert.equal(second.transportInvocations,0);assert.ok(h.events.includes('local-recovery'));
});
test('bad JPEG or dimensions records local failure once, without a new model call',async()=>{
 const bad=harness();bad.deps.prepare=()=>{throw new JpegPreparationError('malformed','JPEG did not decode.');};const r=await runImageJob(job(),bad.deps);assert.equal(r.state,'held');assert.ok(bad.events.includes('failure:preparation_failed:false'));
 const dimensions=harness();dimensions.deps.prepare=()=>({...output,original:{...output.original,bytes:output.original.bytes,width:8,height:8}});assert.equal((await runImageJob(job(),dimensions.deps)).code,'wrong_dimensions');assert.equal(dimensions.events.filter(x=>x.startsWith('failure:')).length,1);
 const unavailable=harness();unavailable.deps.prepare=dimensions.deps.prepare;let tries=0;unavailable.deps.recordPreparationFailure=async()=>{tries++;throw Error('Storage unavailable');};assert.equal((await runImageJob(job(),unavailable.deps)).code,'preparation_storage_unavailable');assert.equal(tries,1);
});
test('late cancelled or stale receipt persists but cannot decode or apply',async()=>{
 const h=harness();h.deps.persistReceiptCommitted=async(_c,a)=>{h.events.push('late-receipt');return saved(a,{applyEligible:false,holdCode:'source_changed'});};const r=await runImageJob(job(),h.deps);assert.equal(r.code,'source_changed');assert.equal(r.receiptPersisted,true);assert.equal(r.candidateAssetId,id(8));assert.equal(h.events.includes('decode'),false);assert.equal(h.events.includes('apply'),false);
});
test('application checks current source after preparation and preserves owner edits',async()=>{
 const h=harness();h.deps.applyPreparedCommitted=async()=>{h.events.push('fresh-hold');return{applied:false,holdCode:'source_changed'};};const r=await runImageJob(job(),h.deps);assert.equal(r.code,'source_changed');assert.deepEqual(r.variantAssetIds,[]);assert.ok(h.events.includes('commit-preparation'));assert.ok(h.events.includes('fresh-hold'));
});
test('wire mismatch retains safe evidence without attaching possibly misrouted bytes',async()=>{
 const h=harness();h.deps.generate=async()=>({...receipt,requestSha256:'0'.repeat(64)});h.deps.persistReceiptCommitted=async(_c,a,e)=>{assert.equal(e.wireIntegrity,'mismatch');assert.equal(e.reservedRequestSha256,prepared.requestSha256);assert.equal(e.receipt.requestSha256,'0'.repeat(64));assert.equal(e.receipt.candidate,null);assert.equal(e.observedCandidateSha256,hash(bytes));return saved(a,{receivedRequestSha256:'0'.repeat(64),outcome:'outcome_unknown',candidate:null,applyEligible:false});};const r=await runImageJob(job(),h.deps);assert.equal(r.code,'wire_mismatch');assert.equal(r.transportInvocations,1);assert.equal(r.receiptPersisted,true);assert.equal(h.events.includes('decode'),false);
});
test('transport interruption and known rejection persist once and never retry',async()=>{
 for(const rejected of [false,true]){const h=harness();let writes=0;h.deps.generate=async()=>{if(!rejected)throw Error(command.prompt);return{...receipt,outcome:'rejected',code:'provider_rejected',candidate:null};};h.deps.persistReceiptCommitted=async(_c,a,e)=>{writes++;return saved(a,{outcome:e.receipt.outcome,candidate:null,applyEligible:false});};const r=await runImageJob(job(),h.deps);assert.equal(r.code,rejected?'provider_rejected':'outcome_unknown');assert.equal(r.transportInvocations,1);assert.equal(writes,1);assert.equal(h.events.includes('decode'),false);}
});
test('unknown stage, mutated request and disabled policy hold before provider',async()=>{
 const h=harness(),unknown=job();unknown.payload.stage='other';assert.equal((await runImageJob(unknown,h.deps)).code,'invalid_job');assert.deepEqual(h.events,[]);const changed=job();changed.payload.image.privateCommand.prompt='Different';assert.equal((await runImageJob(changed,h.deps)).code,'wire_mismatch');assert.deepEqual(h.events,[]);h.deps.admitCommitted=async()=>({kind:'held',reason:'policy_disabled'});assert.equal((await runImageJob(job(),h.deps)).code,'policy_disabled');assert.deepEqual(h.events,[]);
});
test('corrupt candidate or wrong committed metadata cannot reach application',async()=>{
 const corrupt=harness();corrupt.deps.loadCandidate=async()=>Buffer.from('wrong bytes');assert.equal((await runImageJob(job(),corrupt.deps)).code,'candidate_integrity');assert.equal(corrupt.events.includes('decode'),false);
 const changed=harness(),commit=changed.deps.commitPreparation;changed.deps.commitPreparation=async(...args)=>({...await commit(...args),candidateAssetId:id(100)});assert.equal((await runImageJob(job(),changed.deps)).code,'candidate_integrity');assert.equal(changed.events.includes('apply'),false);
});
