import test from 'node:test';
import assert from 'node:assert/strict';
import {workerCommandGate} from '../src/workers/creative-media/worker-gate.js';

test('private output probe action is opt-in but does not require paid provider permission',()=>{
 assert.throws(()=>workerCommandGate({},'probe-output'),/disabled/);
 assert.doesNotThrow(()=>workerCommandGate({RL72_MEDIA_WORKER_ENABLED:'true'},'probe-output'));
 assert.throws(()=>workerCommandGate({RL72_MEDIA_WORKER_ENABLED:'true'},'submit'),/not permitted/);
 assert.throws(()=>workerCommandGate({RL72_MEDIA_WORKER_ENABLED:'true'},'reconcile'),/not permitted/);
});
