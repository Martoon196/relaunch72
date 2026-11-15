import test from 'node:test';
import assert from 'node:assert/strict';
import { providerAdmission, PgVideoAdmissionOwner } from '../src/creative-studio/media-admission-pg-store.js';
import { MediaProviderError, validateMediaAdmission } from '../src/creative-studio/media-providers.js';

const uuid=(part:string)=>'11111111-1111-4111-8111-'+part;
const ws=uuid('111111111111'), cmd=uuid('222222222222'),jobId=uuid('333333333333'), reviewer=uuid('444444444444');

test('database worker claim converts into scoped short-lived provider admission',()=>{
  const claim={id:jobId,claimToken:uuid('555555555555'),kind:'vizard_clip' as const,
    payloadSha:'a'.repeat(64),rightsSha:'b'.repeat(64),reservedMicrousd:500000,
    approvedBy:reviewer,approvedAt:'2026-11-15T10:00:00.000Z',validUntil:'2099-01-01T00:00:00.000Z'};
  const admission=providerAdmission(claim,ws,cmd);
  assert.equal(admission.workspaceId,ws);
  assert.equal(admission.reservedCostMicrousd,500000);
  assert.equal(admission.approvedBy,reviewer);
  assert.doesNotThrow(()=>validateMediaAdmission(admission,ws,cmd,'vizard_clip',new Date('2026-11-15T12:00:00Z')));
  assert.throws(()=>validateMediaAdmission(admission,ws,cmd,'shotstack_render'),MediaProviderError);
});

test('owner video reservation cannot be forged or charged without reviewed rights and consent',()=>{
  const dummy={connect:async()=>{throw Error('should not connect');}};
  const owner=new PgVideoAdmissionOwner(dummy as never,{kind:'worker',requestId:'test'} as never);
  assert.throws(()=>owner.reserve({workspaceId:ws,commandId:cmd,jobId,kind:'vizard_clip',
    payloadSha:'a'.repeat(64),rightsSha:'b'.repeat(64),estimatedMicrousd:500000,consent:false}),/consent/iu);
  assert.throws(()=>owner.reserve({workspaceId:ws,commandId:cmd,jobId,kind:'vizard_clip',
    payloadSha:'bad',rightsSha:'b'.repeat(64),estimatedMicrousd:500000,consent:true}),/reviewed/iu);
});
