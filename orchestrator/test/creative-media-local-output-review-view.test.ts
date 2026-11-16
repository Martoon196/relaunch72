import test from 'node:test';
import assert from 'node:assert/strict';
import {creativeMediaLocalOutputReviewPage} from '../src/portal/creative-media-local-output-review-view.js';

const shell={csrf:'test-token',applicationName:'RL72',brands:[],tab:'creative',creativeAvailable:true,
 brand:{id:'11111111-1111-4111-8111-111111111111',name:'Example'}} as never;
const output={id:'22222222-2222-4222-8222-222222222222',
 jobId:'33333333-3333-4333-8333-333333333333',sha256:'a'.repeat(64),
 sourceSha256:'b'.repeat(64),planSha256:'c'.repeat(64),durationMs:3000,width:720,height:1280,audioPresent:true,
 byteLength:1024,createdAt:'2026-11-15T20:00:00Z'};
test('private review never offers approval before a measured technical probe',()=>{
 const html=creativeMediaLocalOutputReviewPage(shell,[output],[],()=> '44444444-4444-4444-8444-444444444444');
 assert.match(html,/name="_csrf"/);
 assert.match(html,/Awaiting technical measurement/);
 assert.doesNotMatch(html,/Record private review/);
 assert.doesNotMatch(html,/publish now|schedule now/i);
});
test('reviewed output can be withdrawn but not automatically published',()=>{
 const rec={outputId:output.id,sha256:output.sha256,revision:3,
  decision:'reviewed_private' as const,reviewedBy:'55555555-5555-4555-8555-555555555555',
  createdAt:'2026-11-15T20:00:00Z',technicalStatus:'verified_technical' as const,
  durationMs:30000,width:1280,height:720};
 const html=creativeMediaLocalOutputReviewPage(shell,[output],[rec],()=> '44444444-4444-4444-8444-444444444444');
 assert.match(html,/Withdraw private review/);
 assert.doesNotMatch(html,/Record private review/);
 assert.match(html,/Private review is NOT a publish button/);
});

test('local output form uses local identity, exact digest, version and fresh owner attestations',()=>{
 const rec={outputId:output.id,sha256:output.sha256,revision:0,decision:null,reviewedBy:null,
  createdAt:null,technicalStatus:'verified_technical' as const,durationMs:3000,width:720,height:1280};
 const html=creativeMediaLocalOutputReviewPage(shell,[output],[rec],()=> '44444444-4444-4444-8444-444444444444');
 assert.match(html,/local-outputs\/review/);
 assert.match(html,/local-outputs\/22222222-2222-4222-8222-222222222222\/stream/);
 for(const field of ['outputSha256','expectedRevision','rightsConfirmed','claimsConfirmed','disclosureConfirmed'])
  assert.ok(html.includes('name="'+field+'"'));
 assert.match(html,/Record private review/);
 const mismatch=creativeMediaLocalOutputReviewPage(shell,[output],[{...rec,sha256:'f'.repeat(64)}],()=> 'x');
 assert.doesNotMatch(mismatch,/Record private review/);
});
