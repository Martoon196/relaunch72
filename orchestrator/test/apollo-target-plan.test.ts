import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCoverageTarget } from '../src/integrations/apollo/target-plan.js';

const brandId='11111111-1111-4111-8111-111111111111';
const document={id:'brain',brandId,version:2,active:true,status:'extracted' as const,sha256:'b'.repeat(64)};
const profile={brandId,version:3,factsSha:'a'.repeat(64),confirmedAt:'2026-11-06T12:00:00Z',confirmedBy:'owner',
  conflicts:[],knowledge:[{documentId:'brain',version:2,sha256:document.sha256,category:'brand_guidelines' as const}],audiences:['Corporate property buyers']};
const brief={schemaVersion:1,brandId,profileVersion:3,factsSha:profile.factsSha,audience:profile.audiences[0],
  objective:'Test decision-maker coverage for confirmed corporate buyers',filters:{titles:['Director'],locations:['United Kingdom']}};

test('Target plan binds a confirmed brand profile, audience and current knowledge; hashes canonical fields',()=>{
  const a=validateCoverageTarget(brief,brandId,profile,[document]);
  const b=validateCoverageTarget({filters:{locations:['United Kingdom'],titles:['Director']},objective:brief.objective,
    audience:brief.audience,factsSha:brief.factsSha,profileVersion:3,brandId,schemaVersion:1},brandId,profile,[document]);
  assert.equal(a.sha256,b.sha256);assert.match(a.knowledgeSha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(a.plan.filters,brief.filters);
  assert.notEqual(validateCoverageTarget({...brief,filters:{...brief.filters,titles:['Owner']}},brandId,profile,[document]).sha256,a.sha256);
});

test('Unconfirmed, conflicting, foreign-brand, changed-profile and unapproved-audience targets hold',()=>{
  assert.throws(()=>validateCoverageTarget(brief,brandId,null,[document]),/target_profile_unconfirmed/);
  assert.throws(()=>validateCoverageTarget(brief,brandId,{...profile,confirmedAt:null},[document]),/target_profile_unconfirmed/);
  assert.throws(()=>validateCoverageTarget(brief,brandId,{...profile,conflicts:[{field:'offer',detail:'Unresolved',documentIds:[]}]},[document]),/target_profile_unconfirmed/);
  assert.throws(()=>validateCoverageTarget(brief,'other-brand',profile,[document]),/target_profile_unconfirmed/);
  assert.throws(()=>validateCoverageTarget(brief,brandId,{...profile,version:4},[document]),/target_profile_stale/);
  assert.throws(()=>validateCoverageTarget({...brief,audience:'Private consumers'},brandId,profile,[document]),/target_audience_unconfirmed/);
});

test('Replaced, deactivated, pending and added knowledge cannot silently reuse a target brief',()=>{
  for(const docs of [[{...document,version:3}],[document,{...document,version:3,active:false}],
    [{...document,status:'pending' as const}],[document,{...document,id:'new-facts'}],[]]){
    assert.throws(()=>validateCoverageTarget(brief,brandId,profile,docs),/target_knowledge_stale/);
  }
  assert.doesNotThrow(()=>validateCoverageTarget(brief,brandId,profile,[{...document,version:1,active:false},document]));
});

test('Brain output cannot introduce tool controls, company domains, empty filters or silently truncated targets',()=>{
  for(const filters of [{...brief.filters,outboundEnabled:true},{...brief.filters,domains:['foreign.example']},
    {titles:['Director']},{locations:['United Kingdom']},{...brief.filters,titles:Array(21).fill('Director')},
    {...brief.filters,titles:[' Director ']},{...brief.filters,titles:['Director','Director']},
    {...brief.filters,locations:['United\nKingdom']}]){
    assert.throws(()=>validateCoverageTarget({...brief,filters},brandId,profile,[document]),/target_/);
  }
  assert.throws(()=>validateCoverageTarget({...brief,apiKey:'never-an-allowed-field'},brandId,profile,[document]),/target_unexpected_field/);
});
