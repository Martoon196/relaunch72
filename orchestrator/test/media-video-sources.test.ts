import test from 'node:test';
import assert from 'node:assert/strict';
import {examineVideoUpload,PgCreativeVideoSources} from '../src/creative-studio/media-video-source-pg-store.js';
const sample=()=>{const b=Buffer.alloc(1024);b.writeUInt32BE(24,0);b.write('ftyp',4,'ascii');return b;};
test('source intake checks rights, consent and file signature without claiming playback',()=>{
  const b=sample();assert.equal(examineVideoUpload(b,'owned.mp4','owned',null,true).mime,'video/mp4');
  for(const bad of [
    ()=>examineVideoUpload(b,'owned.mp4','owned',null,false),
    ()=>examineVideoUpload(b,'owned.mp4','licensed',null,true),
    ()=>examineVideoUpload(b,'owned.webm','owned',null,true),
    ()=>examineVideoUpload(Buffer.alloc(1024),'owned.mp4','owned',null,true),
    ()=>examineVideoUpload(b,'../owned.mp4','owned',null,true),
  ])assert.throws(bad);
});
test('worker principal cannot use source owner store',async()=>{
  const dummy={connect:async()=>{throw Error('unexpected DB access');}} as never;
  const s=new PgCreativeVideoSources(dummy,{kind:'worker',requestId:'test'} as never);
  await assert.rejects(s.list('11111111-1111-4111-8111-111111111111'),/Signed-in/iu);
});

test('source page is signed-in CSRF form and promises no external effects',async()=>{
  const {creativeVideoSourcesPage}=await import('../src/portal/creative-media-video-sources-view.js');
  const shell={csrf:'test-csrf',brands:[],applicationName:'Relaunch72',creativeAvailable:true,
    brand:{id:'11111111-1111-4111-8111-111111111111',name:'Example Brand'},tab:'creative'} as never;
  const html=creativeVideoSourcesPage(shell,[],'22222222-2222-4222-8222-222222222222');
  assert.match(html,/multipart\/form-data/);
  assert.match(html,/rightsConfirmed/);
  assert.match(html,/not proof of playability/);
  assert.doesNotMatch(html,/shotstack|vizard/);
});
