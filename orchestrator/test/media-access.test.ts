import test from 'node:test';
import assert from 'node:assert/strict';
import {MEDIA_TIERS,canUsePaidVideo,PgMediaAccessOwner} from '../src/creative-studio/media-access-pg-store.js';
const allowed={active:true,tier:'affiliate_creator' as const,source:'billing_verified' as const,
 maxJobMicrousd:500000,monthlyVideoMicrousd:1000000,validUntil:'2099-01-01T00:00:00Z'};
test('entitlements require live evidence and obey per-job and monthly limits',()=>{
 assert.equal(canUsePaidVideo(allowed,500000),true);
 assert.equal(canUsePaidVideo(allowed,500001),false);
 assert.equal(canUsePaidVideo({...allowed,active:false},1),false);
 assert.equal(canUsePaidVideo({...allowed,validUntil:'2020-01-01T00:00:00Z'},1),false);
 assert.equal(canUsePaidVideo({...allowed,source:null},1),false);
 assert.ok(Object.values(MEDIA_TIERS).every(t=>t.checkoutReady===false));
});
test('worker/anonymous cannot read workspace subscription entitlement',async()=>{
 const store=new PgMediaAccessOwner({connect:async()=>{throw Error('unexpected SQL');}} as never,
 {kind:'worker',requestId:'t'} as never);
 await assert.rejects(store.current('11111111-1111-4111-8111-111111111111'),/Signed-in/iu);
});
