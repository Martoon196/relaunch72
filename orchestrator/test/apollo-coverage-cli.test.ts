import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd=fileURLToPath(new URL('../../',import.meta.url));
const args=['--import','tsx','scripts/apollo_coverage_test.ts','--input','no-live-input.csv','--brand','11111111-1111-4111-8111-111111111111','--target-plan','no-live-plan.json','--output','no-live-output.json'];
const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,APOLLO_ENABLED:'false'};
test('Actual root coverage CLI starts in CommonJS package and holds before file, database or vendor access when disabled',()=>{
  const r=spawnSync(process.execPath,args,{cwd,env,encoding:'utf8',timeout:15000});
  assert.equal(r.error,undefined);assert.equal(r.status,1);
  assert.match(r.stderr,/Apollo is disabled/);
  assert.doesNotMatch(r.stderr,/top-level await|Transform failed|ENOENT/);
});
test('Coverage CLI rejects a paid-credit cap before runtime access',()=>{
  const r=spawnSync(process.execPath,[...args,'--max-credits','1'],{cwd,env,encoding:'utf8',timeout:15000});
  assert.equal(r.error,undefined);assert.equal(r.status,1);assert.match(r.stderr,/max-credits 0/);
  assert.doesNotMatch(r.stderr,/Apollo is disabled|ENOENT/);
});
