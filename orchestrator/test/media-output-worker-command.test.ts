import test from 'node:test';
import assert from 'node:assert/strict';
import {workerCommandGate} from '../src/workers/creative-media/worker-gate.js';
test('native worker rejects removed provider actions',()=>{
 for(const action of ['submit','reconcile','probe-output'])assert.throws(()=>workerCommandGate({RL72_MEDIA_WORKER_ENABLED:'true'},action),/Usage/);
 assert.doesNotThrow(()=>workerCommandGate({RL72_MEDIA_WORKER_ENABLED:'true'},'probe'));
});
