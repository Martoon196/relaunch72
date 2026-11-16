import test from 'node:test';
import assert from 'node:assert/strict';
import {runMediaService} from '../src/workers/creative-media/service.js';
import {workerCommandGate} from '../src/workers/creative-media/worker-gate.js';
import {checkVideoEditPlan} from '../src/creative-studio/media-edit-plan.js';
test('supervised loop cleans before work, handles a failed workspace and drains on shutdown',async()=>{
 const controller=new AbortController(),actions:string[]=[];
 await runMediaService({workspaces:async()=>['one','two'],cleanup:async ws=>{actions.push('clean:'+ws);},tick:async ws=>{actions.push('tick:'+ws);if(ws==='one')throw Error('transient');controller.abort();},clickRetention:async()=>{actions.push('click-retention');},onError:()=>actions.push('held')},{signal:controller.signal,pollMs:1000});
 assert.deepEqual(actions,['clean:one','tick:one','held','clean:two','tick:two','click-retention']);
});
test('service stays dark and cannot be enabled by paid-provider flags',()=>{
 assert.throws(()=>workerCommandGate({RL72_MEDIA_WORKER_ENABLED:'true',RL72_MEDIA_PROVIDER_SUBMISSIONS_ALLOWED:'true'},'serve'),/disabled/);
});
test('affiliate timeline cannot omit or remove on-screen ad disclosure',()=>{
 const plan={canvas:'landscape',clips:[{startMs:0,endMs:1000,caption:'',transition:'cut',speed:1}],disclosure:''};
 for(const disclosure of ['', 'optional', '#advertisement', 'foo#ad'])assert.throws(()=>checkVideoEditPlan({...plan,disclosure}),/disclosure/);
 assert.equal(checkVideoEditPlan({...plan,disclosure:'#ad Affiliate promotion'}).disclosure,'#ad Affiliate promotion');
});
