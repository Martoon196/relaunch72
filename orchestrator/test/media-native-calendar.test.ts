import test from 'node:test';
import assert from 'node:assert/strict';
import {PgNativeVideoPlanner,PgNativeVideoJitWorker} from '../src/creative-studio/media-native-calendar.js';
const denied={connect:async()=>{throw Error('Unexpected database access');}} as never;
const flags={CREATIVE_MEDIA:'enabled',RL72_MEDIA_NATIVE_CALENDAR_ENABLED:'true',RL72_MEDIA_WORKER_ENABLED:'true'};
test('native calendar cannot run when dark, or turn worker identity into an owner planning command',async()=>{
 await assert.rejects(new PgNativeVideoPlanner(denied,denied,denied,{kind:'worker',requestId:'test'},{}).plan({} as never),/disabled/);
 await assert.rejects(new PgNativeVideoPlanner(denied,denied,denied,{kind:'worker',requestId:'test'},flags).plan({} as never),/Owner required/);
 assert.throws(()=>new PgNativeVideoJitWorker(denied,'test',{}).attest('11111111-1111-4111-8111-111111111111'),/disabled/);
});
